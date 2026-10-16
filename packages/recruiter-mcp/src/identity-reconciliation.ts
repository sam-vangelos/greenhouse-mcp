import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { extractRows, isInactiveUser, parsePositiveId } from "./identity-bootstrap.js";
import { revokeOauthGrants } from "./oauth-grant-store.js";
import {
  PRIVATE_CANDIDATE_ATTESTATION_COLUMNS,
  PRIVATE_CANDIDATES_ATTESTED_AT_COLUMN,
  PRIVATE_CANDIDATES_ATTESTED_BY_COLUMN,
  PRIVATE_CANDIDATES_ATTESTED_COLUMN,
} from "./private-candidate-attestation.js";
import {
  assertCanonicalSupabaseProjectRef,
  normalizeOptionalSupabaseIdentifier,
  normalizeSupabaseApiKey,
} from "./supabase-config.js";

// Identity-directory deprovisioning (Slice G, #23).
//
// The desktop session token deliberately never carries the Greenhouse user id; the scoped reader is
// keyed on the id resolved per-request from recruiter_identity_directory WHERE status='resolved'
// (with the permission cache TTL forced to zero). So the deprovisioning lever for a stateless session
// is the directory row itself: flip a row out of 'resolved' and the very next request fails identity
// resolution and is denied. There is no per-user token registry to revoke against, so "revoke a
// deactivated recruiter's sessions" IS this status flip — not a write to the token-id revocation
// table (which only revokes specific known token ids, e.g. a leaked drill token).
//
// This module reconciles the directory against the latest Greenhouse /v3/users roster:
//   - present + active   -> keep
//   - present + inactive -> revoke   (a positive deactivation signal; safe on any roster)
//   - absent             -> tombstone, BUT ONLY when the roster is asserted complete; otherwise
//                           skip (an absent id under a partial roster read must never be
//                           deprovisioned — that would lock out active recruiters on a pagination gap)
// It only ever DEPROVISIONS (resolved -> deactivated); it never re-activates. Re-adding a returning
// recruiter is a deliberate bootstrap action, not a side effect of reconciliation.

const DEACTIVATED_STATUS = "deactivated";
const DIRECTORY_RESOLVED_STATUS = "resolved";

// Refuse to tombstone more than this fraction of the resolved directory in one run without an
// explicit override. A high absent-fraction under a roster the operator called "complete" almost
// always means a truncated / stale / empty export rather than a real mass offboarding — the exact
// fat-finger that would otherwise lock out the whole active recruiting team.
const DEFAULT_MAX_TOMBSTONE_FRACTION = 0.5;

export interface IdentityDirectoryRow {
  greenhouseUserId: number;
  primaryEmail: string;
  status: string;
  /** ISO; when present, a row newer than the roster is never tombstoned (see rosterAsOf). */
  lastVerifiedAt?: string;
  /**
   * The private-candidate attestation as it stood when the plan was read (CLO-273). Carried so the
   * deprovision PATCH — which REPLACES evidence_detail — can record what it is clearing instead of
   * destroying it. All three are absent against a table migration 0008 has not reached, which is a
   * supported state, not an error.
   */
  privateCandidatesAttested?: boolean;
  privateCandidatesAttestedAt?: string | null;
  privateCandidatesAttestedBy?: string | null;
}

export type ReconciliationAction = "keep" | "revoke" | "tombstone" | "skip";

export interface ReconciliationEntry {
  greenhouseUserId: number;
  primaryEmail: string;
  action: ReconciliationAction;
  reason: string;
  /** The attestation this row carried when the plan was built, for the PATCH's evidence record. */
  priorAttestation?: { attested: boolean; at: string | null; by: string | null };
}

export interface IdentityReconciliationPlan {
  ok: boolean;
  generatedAt: string;
  rosterComplete: boolean;
  rosterUserCount: number;
  resolvedRowCount: number;
  kept: ReconciliationEntry[];
  revoked: ReconciliationEntry[];
  tombstoned: ReconciliationEntry[];
  skipped: ReconciliationEntry[];
  // Set ONLY when the operator asserted a complete roster but a safety floor REFUSED the absent-row
  // tombstone batch (empty roster, or blast radius over the cap). The would-be tombstones are moved
  // to `skipped` — never silently dropped — and the operator sees why instead of a silent mass wipe.
  tombstonesBlockedReason?: string;
  containsTokens: false;
  canApply: boolean;
}

export interface BuildIdentityReconciliationPlanOptions {
  directoryRows: IdentityDirectoryRow[];
  greenhouseUsers: unknown;
  rosterComplete: boolean;
  generatedAt?: string;
  // When the roster was read (ISO). Since first-sign-in enrollment (CLO-271) rows appear without an
  // operator, a row whose last_verified_at is NEWER than the roster cannot be "absent from the
  // roster" — it simply postdates it — and is skipped instead of tombstoned. Without this a stale
  // file export would deprovision everyone who enrolled after it was taken, and enrollment refuses
  // to re-create a row it finds in any status, so the lockout would not self-heal.
  rosterAsOf?: string;
  // Override the blast-radius floor for a genuine large offboarding. Does NOT override the
  // empty-roster floor — an empty roster is never a legitimate "deprovision everyone".
  confirmMassDeprovision?: boolean;
  // Refuse to tombstone if more than this fraction of resolved rows would be tombstoned in one run
  // (default 0.5), unless confirmMassDeprovision is set.
  maxTombstoneFraction?: number;
}

export function buildIdentityReconciliationPlan(
  options: BuildIdentityReconciliationPlanOptions
): IdentityReconciliationPlan {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const roster = indexRosterByGreenhouseId(options.greenhouseUsers);
  const resolvedRows = options.directoryRows.filter((row) => row.status === DIRECTORY_RESOLVED_STATUS);
  const maxTombstoneFraction = options.maxTombstoneFraction ?? DEFAULT_MAX_TOMBSTONE_FRACTION;

  const kept: ReconciliationEntry[] = [];
  const revoked: ReconciliationEntry[] = [];
  const tombstoned: ReconciliationEntry[] = [];
  const skipped: ReconciliationEntry[] = [];
  const absent: ReconciliationEntry[] = [];

  for (const row of resolvedRows) {
    const base = {
      greenhouseUserId: row.greenhouseUserId,
      primaryEmail: row.primaryEmail,
      ...(row.privateCandidatesAttested === undefined
        ? {}
        : {
            priorAttestation: {
              attested: row.privateCandidatesAttested,
              at: row.privateCandidatesAttestedAt ?? null,
              by: row.privateCandidatesAttestedBy ?? null,
            },
          }),
    };
    const rosterEntry = roster.get(row.greenhouseUserId);
    if (rosterEntry) {
      if (rosterEntry.inactive) {
        // A positive deactivation signal — safe to act on regardless of roster completeness.
        revoked.push({ ...base, action: "revoke", reason: "Greenhouse user is deactivated in the roster." });
      } else {
        kept.push({ ...base, action: "keep", reason: "Greenhouse user is present and active in the roster." });
      }
      continue;
    }
    if (
      options.rosterAsOf !== undefined && row.lastVerifiedAt !== undefined &&
      Date.parse(row.lastVerifiedAt) > Date.parse(options.rosterAsOf)
    ) {
      skipped.push({ ...base, action: "skip", reason: `Absent from the roster, but the directory row (${row.lastVerifiedAt}) is newer than the roster (${options.rosterAsOf}); re-run with a fresher roster.` });
      continue;
    }
    absent.push({ ...base, action: "tombstone", reason: "Greenhouse user is absent from the latest complete roster." });
  }

  // Deciding the fate of ABSENT recruiters is the only inference that can over-deprovision, so it is
  // gated by stacked safety floors. Tombstone an absent recruiter ONLY when the roster is asserted
  // complete AND it passes a plausibility floor; otherwise skip (never tombstone) — so a partial,
  // empty, or truncated roster believed-complete can never silently lock out the active team.
  let tombstonesBlockedReason: string | undefined;
  if (options.rosterComplete) {
    if (roster.size === 0) {
      // An active organization always has users; an empty roster is a failed/empty export. Non-overridable.
      tombstonesBlockedReason = "roster is empty (likely a failed or empty export); refusing to tombstone";
    } else if (
      resolvedRows.length > 0 &&
      absent.length / resolvedRows.length > maxTombstoneFraction &&
      !options.confirmMassDeprovision
    ) {
      tombstonesBlockedReason =
        `would tombstone ${absent.length}/${resolvedRows.length} resolved rows ` +
        `(> ${Math.round(maxTombstoneFraction * 100)}%), which suggests a truncated or stale roster; ` +
        "pass confirmMassDeprovision (--confirm-mass-deprovision) to override";
    }
  }

  if (!options.rosterComplete) {
    for (const entry of absent) {
      skipped.push({
        ...entry,
        action: "skip",
        reason: "Absent, but the roster was not asserted complete; not deprovisioning on a possibly-partial read.",
      });
    }
  } else if (tombstonesBlockedReason) {
    for (const entry of absent) {
      skipped.push({ ...entry, action: "skip", reason: `Absent, but tombstone refused: ${tombstonesBlockedReason}.` });
    }
  } else {
    tombstoned.push(...absent);
  }

  return {
    ok: true,
    generatedAt,
    rosterComplete: options.rosterComplete,
    rosterUserCount: roster.size,
    resolvedRowCount: resolvedRows.length,
    kept,
    revoked,
    tombstoned,
    skipped,
    ...(tombstonesBlockedReason ? { tombstonesBlockedReason } : {}),
    containsTokens: false,
    canApply: revoked.length + tombstoned.length > 0,
  };
}

interface RosterEntry {
  inactive: boolean;
}

function indexRosterByGreenhouseId(input: unknown): Map<number, RosterEntry> {
  const index = new Map<number, RosterEntry>();
  for (const raw of extractRows(input)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const id = parsePositiveId(row.id ?? row.user_id ?? row.greenhouse_user_id);
    if (id === undefined) continue;
    const inactive = isInactiveUser(row);
    // If the same id appears more than once, treat the user as inactive if ANY row says so — a
    // deactivation signal should never be masked by a duplicate active-looking row.
    const existing = index.get(id);
    index.set(id, { inactive: inactive || (existing?.inactive ?? false) });
  }
  return index;
}

export interface SupabaseIdentityDirectoryAccessConfig {
  supabaseUrl: string;
  apiKey: string;
  table?: string;
  fetchImpl?: typeof fetch;
}

export interface IdentityReconciliationApplyReport {
  ok: true;
  appliedAt: string;
  table: string;
  revokedCount: number;
  tombstonedCount: number;
  /** Per deprovisioned row: whether its OAuth refresh families were swept (CLO-272). */
  oauthRevocations: Array<{ greenhouseUserId: number; primaryEmail: string } & ReconciliationOauthRevocation>;
  /**
   * Per deprovisioned row: whether the private-candidate attestation columns were actually cleared.
   *
   * `false` means the table has not had migration 0008 applied yet and the PATCH was retried
   * without them. The status flip and the OAuth sweep still happened — that is the deprovisioning —
   * but an operator reading this report must be able to see that one column was not written rather
   * than assume it was.
   */
  entries: Array<{ greenhouseUserId: number; action: ReconciliationAction; attestationCleared: boolean }>;
  containsTokens: false;
}

export async function fetchResolvedDirectoryRows(
  config: SupabaseIdentityDirectoryAccessConfig
): Promise<IdentityDirectoryRow[]> {
  const baseUrl = assertCanonicalSupabaseProjectRef(config.supabaseUrl, "Supabase identity directory");
  const apiKey = normalizeSupabaseApiKey(config.apiKey, "Supabase identity directory");
  const table = normalizeOptionalSupabaseIdentifier(config.table, "recruiter_identity_directory", "Supabase identity directory table");

  const fetchImpl = config.fetchImpl ?? fetch;
  const read = async (select: string): Promise<Response> => {
    const url = new URL(`${baseUrl}/rest/v1/${encodeURIComponent(table)}`);
    url.searchParams.set("select", select);
    url.searchParams.set("status", `eq.${DIRECTORY_RESOLVED_STATUS}`);
    return fetchImpl(url, {
      method: "GET",
      headers: {
        apikey: apiKey,
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
      },
    });
  };

  // The attestation columns are read so the deprovision PATCH can record what it clears. They are
  // asked for OPTIONALLY: this runs against a project migration 0008 may not have reached yet, and
  // a reconciliation that could not run at all because of a column it only needs for provenance
  // would be a far worse failure than one that runs without the provenance.
  const BASE_SELECT = "greenhouse_user_id,primary_email,status,last_verified_at";
  let response = await read(`${BASE_SELECT},${PRIVATE_CANDIDATE_ATTESTATION_COLUMNS.join(",")}`);
  if (!response.ok) {
    const detail = await readResponseDetail(response);
    if (!mentionsMissingAttestationColumn(response.status, detail)) {
      throw new Error(`Identity directory read failed with status ${response.status}. ${detail}`.trim());
    }
    response = await read(BASE_SELECT);
  }
  if (!response.ok) {
    throw new Error(
      `Identity directory read failed with status ${response.status}. ${await readResponseDetail(response)}`.trim()
    );
  }
  const data = (await response.json()) as unknown;
  if (!Array.isArray(data)) {
    throw new Error("Identity directory read returned a non-array response.");
  }
  const rows: IdentityDirectoryRow[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const greenhouseUserId = parsePositiveId(row.greenhouse_user_id);
    const primaryEmail = typeof row.primary_email === "string" ? row.primary_email : undefined;
    const status = typeof row.status === "string" ? row.status : undefined;
    if (greenhouseUserId === undefined || primaryEmail === undefined || status === undefined) continue;
    const lastVerifiedAt = typeof row.last_verified_at === "string" ? row.last_verified_at : undefined;
    const attested = row[PRIVATE_CANDIDATES_ATTESTED_COLUMN];
    rows.push({
      greenhouseUserId,
      primaryEmail,
      status,
      ...(lastVerifiedAt !== undefined ? { lastVerifiedAt } : {}),
      ...(typeof attested === "boolean"
        ? {
            privateCandidatesAttested: attested,
            privateCandidatesAttestedAt:
              typeof row[PRIVATE_CANDIDATES_ATTESTED_AT_COLUMN] === "string"
                ? (row[PRIVATE_CANDIDATES_ATTESTED_AT_COLUMN] as string)
                : null,
            privateCandidatesAttestedBy:
              typeof row[PRIVATE_CANDIDATES_ATTESTED_BY_COLUMN] === "string"
                ? (row[PRIVATE_CANDIDATES_ATTESTED_BY_COLUMN] as string)
                : null,
          }
        : {}),
    });
  }
  return rows;
}

export interface ApplyIdentityReconciliationConfig extends SupabaseIdentityDirectoryAccessConfig {
  appliedAt?: string;
}

export async function applyIdentityReconciliationPlan(
  plan: IdentityReconciliationPlan,
  config: ApplyIdentityReconciliationConfig
): Promise<IdentityReconciliationApplyReport> {
  if (!plan.ok) {
    throw new Error("Identity reconciliation plan is not ok; refusing to apply.");
  }
  const baseUrl = assertCanonicalSupabaseProjectRef(config.supabaseUrl, "Supabase identity directory");
  const apiKey = normalizeSupabaseApiKey(config.apiKey, "Supabase identity directory");
  const table = normalizeOptionalSupabaseIdentifier(config.table, "recruiter_identity_directory", "Supabase identity directory table");
  const appliedAt = config.appliedAt ?? new Date().toISOString();
  const fetchImpl = config.fetchImpl ?? fetch;
  const oauthRevocations: IdentityReconciliationApplyReport["oauthRevocations"] = [];
  const entries: IdentityReconciliationApplyReport["entries"] = [];

  // Apply revokes and tombstones only. Each is a status flip to 'deactivated' — never a grant — so
  // partial application (if a later row fails) is fail-safe: nothing gains access, and a re-run
  // finishes the rest. Never touches 'kept' or 'skip' rows.
  for (const entry of [...plan.revoked, ...plan.tombstoned]) {
    const url = new URL(`${baseUrl}/rest/v1/${encodeURIComponent(table)}`);
    url.searchParams.set("greenhouse_user_id", `eq.${entry.greenhouseUserId}`);
    // PATCH replaces only these columns; greenhouse_user_id / primary_email / google_subject /
    // first_seen_at / slack_user_id / source are untouched. evidence_detail is intentionally
    // REPLACED (not merged): for a deactivated row the deprovisioning cause is the relevant evidence,
    // and a returning recruiter's bootstrap provenance is rewritten by the bootstrap upsert anyway.
    //
    // The three private-candidate attestation columns are cleared here and NOWHERE else on the
    // write side (CLO-273). Deprovisioning is exactly the moment an org-wide private-candidate
    // grant stops being true, and the attestation is a standing statement about a live person's
    // Greenhouse permission — leaving it set would mean a returning row, or a row someone
    // re-bootstrapped, silently carried an attestation nobody made this year. Clearing it is
    // fail-safe in the same direction as the status flip: it can only withhold. The bootstrap
    // upsert deliberately does NOT carry these columns (identity-bootstrap.ts:14-23), so
    // re-bootstrapping a returning recruiter does not resurrect the attestation either — it has to
    // be re-recorded by hand.
    const evidenceDetail: Record<string, unknown> = {
      source: "identity_directory_reconciliation",
      action: entry.action,
      reason: entry.reason,
      // evidence_detail is REPLACED, not merged, so the attestation being cleared would otherwise
      // vanish without a trace. Who attested this person, and when, is exactly the thing an auditor
      // asks about after the row is gone.
      ...(entry.priorAttestation ? { priorAttestation: entry.priorAttestation } : {}),
    };
    // `_by` is nulled, not stamped with the reconciliation's name: migration 0008 documents the
    // column as the operator who made the attestation, and the CLI's `--clear` writes null. Writing
    // "identity_directory_reconciliation:<action>" there made the column read as though a machine
    // had attested the person, which is the opposite of what happened.
    const attestationClearing = {
      [PRIVATE_CANDIDATES_ATTESTED_COLUMN]: false,
      [PRIVATE_CANDIDATES_ATTESTED_AT_COLUMN]: null,
      [PRIVATE_CANDIDATES_ATTESTED_BY_COLUMN]: null,
    };
    const baseBody = {
      status: DEACTIVATED_STATUS,
      last_verified_at: appliedAt,
      evidence_detail: evidenceDetail,
    };
    const patch = async (body: Record<string, unknown>): Promise<Response> =>
      fetchImpl(url, {
        method: "PATCH",
        headers: {
          apikey: apiKey,
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          prefer: "return=minimal",
        },
        body: JSON.stringify(body),
      });

    // The three attestation columns are written OPTIONALLY. Naming them unconditionally meant that
    // against a table migration 0008 had not reached — or inside PostgREST's schema-cache window
    // right after it did — the very FIRST entry 400ed, the whole apply aborted, and neither the
    // status flip nor `revokeOauthGrants` ran for anybody. That is fail-OPEN on the one operation
    // whose entire job is to end access.
    let attestationCleared = true;
    let response = await patch({ ...baseBody, ...attestationClearing });
    if (!response.ok) {
      const detail = await readResponseDetail(response);
      if (!mentionsMissingAttestationColumn(response.status, detail)) {
        throw new Error(
          `Identity reconciliation update failed for greenhouse_user_id ${entry.greenhouseUserId} with status ${response.status}. ${detail}`.trim()
        );
      }
      attestationCleared = false;
      response = await patch(baseBody);
    }
    if (!response.ok) {
      throw new Error(
        `Identity reconciliation update failed for greenhouse_user_id ${entry.greenhouseUserId} with status ${response.status}. ${await readResponseDetail(response)}`.trim()
      );
    }
    entries.push({ greenhouseUserId: entry.greenhouseUserId, action: entry.action, attestationCleared });
    // The directory flip denies every future tool call; the OAuth sweep ends the hosted-Claude
    // session itself (CLO-272): every live refresh family of the email is revoked under its lock
    // and every access-token jti it minted lands on the revocation list. Best effort, and visibly
    // so — a failure here is reported per row and never un-flips the directory. The RPCs live in
    // the same canonical project as the directory, so the identity pair reaches them.
    let oauthRevocation: ReconciliationOauthRevocation;
    try {
      const outcome = await revokeOauthGrants(
        { supabaseUrl: baseUrl, apiKey, fetchImpl },
        { email: entry.primaryEmail, reason: `identity_directory_reconciliation:${entry.action}`, revokedBy: "identity_reconciliation" }
      );
      oauthRevocation = { status: outcome.status === "revoked" ? "revoked" : "skipped", familiesRevoked: outcome.familiesRevoked, jtisRevoked: outcome.jtisRevoked };
    } catch (error) {
      oauthRevocation = { status: "failed", familiesRevoked: 0, jtisRevoked: 0, message: error instanceof Error ? error.message : String(error) };
    }
    oauthRevocations.push({ greenhouseUserId: entry.greenhouseUserId, primaryEmail: entry.primaryEmail, ...oauthRevocation });
  }

  return {
    ok: true,
    appliedAt,
    table,
    revokedCount: plan.revoked.length,
    tombstonedCount: plan.tombstoned.length,
    oauthRevocations,
    entries,
    containsTokens: false,
  };
}

/**
 * The response body, for the error message. A PostgREST 400 says WHICH column it could not find,
 * and a thrown message that dropped it left the operator with a bare status code to diagnose.
 * Never throws: a body that cannot be read yields an empty detail, not a second failure.
 */
async function readResponseDetail(response: Response): Promise<string> {
  try {
    const text = await response.clone().text();
    return text.slice(0, 500);
  } catch (error) {
    return "";
  }
}

/**
 * Is this 400 PostgREST saying one of the attestation columns does not exist?
 *
 * `PGRST204` is "column not found in the schema cache"; `42703` is Postgres's own undefined_column.
 * The column name has to appear too, so an unrelated undefined-column error — a real schema bug —
 * still throws rather than being quietly retried into a partial write.
 */
function mentionsMissingAttestationColumn(status: number, detail: string): boolean {
  if (status !== 400 && status !== 404) return false;
  if (!/PGRST204|PGRST100|42703/.test(detail)) return false;
  return PRIVATE_CANDIDATE_ATTESTATION_COLUMNS.some((column) => detail.includes(column));
}

export interface ReconciliationOauthRevocation {
  status: "revoked" | "skipped" | "failed";
  familiesRevoked: number;
  jtisRevoked: number;
  message?: string;
}

interface ReconciliationCliArgs {
  greenhouseUsersFile?: string;
  fetchRoster: boolean;
  rosterAsOf?: string;
  out?: string;
  apply: boolean;
  rosterComplete: boolean;
  confirmMassDeprovision: boolean;
}

export async function startIdentityReconciliationCli(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv.slice(2)
): Promise<void> {
  try {
    const parsed = parseReconciliationArgs(args);
    const accessConfig: SupabaseIdentityDirectoryAccessConfig = {
      supabaseUrl: requireEnv(env, "GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL"),
      apiKey: requireEnv(env, "GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY"),
      table: env.GREENHOUSE_RECRUITER_IDENTITY_TABLE,
    };

    // --fetch-roster: pull the live /v3/users roster directly (via the sanctioned scoped-reader
    // chokepoint) instead of an operator-supplied file — the "roster is a manual export" gap that
    // kept reconciliation from being schedulable. rosterComplete is derived from pagination
    // completeness, never asserted by hand: an incomplete fetch can only under-deprovision.
    let greenhouseUsers: unknown;
    let rosterComplete = parsed.rosterComplete;
    // The roster's age bounds what "absent" can mean: a live fetch is as-of the moment it started;
    // a file is as-of its modification time unless --roster-as-of says otherwise.
    let rosterAsOf: string;
    if (parsed.fetchRoster) {
      rosterAsOf = parsed.rosterAsOf ?? new Date().toISOString();
      const { readFullGreenhouseUsersRoster } = await import("./scoped-reader.js");
      const roster = await readFullGreenhouseUsersRoster(env);
      greenhouseUsers = roster.users;
      rosterComplete = roster.complete;
    } else {
      const file = parsed.greenhouseUsersFile as string;
      const { stat } = await import("node:fs/promises");
      rosterAsOf = parsed.rosterAsOf ?? (await stat(file)).mtime.toISOString();
      greenhouseUsers = JSON.parse(await readFile(file, "utf8")) as unknown;
    }
    const directoryRows = await fetchResolvedDirectoryRows(accessConfig);
    const plan = buildIdentityReconciliationPlan({
      directoryRows,
      greenhouseUsers,
      rosterComplete,
      rosterAsOf,
      confirmMassDeprovision: parsed.confirmMassDeprovision,
    });

    if (parsed.out) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(resolve(parsed.out), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    }

    if (!parsed.apply) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      return;
    }

    const report = await applyIdentityReconciliationPlan(plan, accessConfig);
    process.stdout.write(`${JSON.stringify({ ...report, plan }, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[greenhouse-recruiter-reconcile-identity] ${message}\n`);
    process.exitCode = 1;
  }
}

function parseReconciliationArgs(args: string[]): ReconciliationCliArgs {
  const values = new Map<string, string>();
  let apply = false;
  let rosterComplete = false;
  let confirmMassDeprovision = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--roster-complete") {
      rosterComplete = true;
      continue;
    }
    if (arg === "--confirm-mass-deprovision") {
      confirmMassDeprovision = true;
      continue;
    }
    if (!arg?.startsWith("--")) continue;
    const next = args[index + 1];
    if (!next || next.startsWith("--")) continue;
    values.set(arg.slice(2), next);
    index += 1;
  }
  const fetchRoster = args.includes("--fetch-roster");
  const greenhouseUsersFile = values.get("greenhouse-users-file");
  if (!fetchRoster && !greenhouseUsersFile) {
    throw new Error(
      "Usage: greenhouse-recruiter-reconcile-identity (--fetch-roster | --greenhouse-users-file greenhouse-users.json) [--roster-as-of ISO] [--out plan.json] [--roster-complete] [--confirm-mass-deprovision] [--apply]. " +
        "A directory row newer than the roster (its file mtime, or --roster-as-of) is never tombstoned — first sign-in enrollment creates rows without an operator. " +
        "--fetch-roster reads the live COMPLETE /v3/users roster itself (roster completeness derived from pagination, never asserted). " +
        "With a file, it must be the COMPLETE /v3/users export; pass --roster-complete to allow deprovisioning recruiters who are absent from it. " +
        "If a complete roster would deprovision more than half the directory, pass --confirm-mass-deprovision to override the blast-radius floor."
    );
  }
  const rosterAsOf = values.get("roster-as-of");
  if (rosterAsOf !== undefined && Number.isNaN(Date.parse(rosterAsOf))) {
    throw new Error("--roster-as-of must be an ISO timestamp.");
  }
  return { greenhouseUsersFile, fetchRoster, rosterAsOf, out: values.get("out"), apply, rosterComplete, confirmMassDeprovision };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startIdentityReconciliationCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[greenhouse-recruiter-reconcile-identity] ${message}\n`);
    process.exit(1);
  });
}
