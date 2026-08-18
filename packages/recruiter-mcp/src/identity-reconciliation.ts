import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { extractRows, isInactiveUser, parsePositiveId } from "./identity-bootstrap.js";
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
}

export type ReconciliationAction = "keep" | "revoke" | "tombstone" | "skip";

export interface ReconciliationEntry {
  greenhouseUserId: number;
  primaryEmail: string;
  action: ReconciliationAction;
  reason: string;
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
    const base = { greenhouseUserId: row.greenhouseUserId, primaryEmail: row.primaryEmail };
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
    absent.push({ ...base, action: "tombstone", reason: "Greenhouse user is absent from the latest complete roster." });
  }

  // Deciding the fate of ABSENT recruiters is the only inference that can over-deprovision, so it is
  // gated by stacked safety floors. Tombstone an absent recruiter ONLY when the roster is asserted
  // complete AND it passes a plausibility floor; otherwise skip (never tombstone) — so a partial,
  // empty, or truncated roster believed-complete can never silently lock out the active team.
  let tombstonesBlockedReason: string | undefined;
  if (options.rosterComplete) {
    if (roster.size === 0) {
      // A live org always has users; an empty roster is a failed/empty export. Non-overridable.
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
  containsTokens: false;
}

export async function fetchResolvedDirectoryRows(
  config: SupabaseIdentityDirectoryAccessConfig
): Promise<IdentityDirectoryRow[]> {
  const baseUrl = assertCanonicalSupabaseProjectRef(config.supabaseUrl, "Supabase identity directory");
  const apiKey = normalizeSupabaseApiKey(config.apiKey, "Supabase identity directory");
  const table = normalizeOptionalSupabaseIdentifier(config.table, "recruiter_identity_directory", "Supabase identity directory table");

  const url = new URL(`${baseUrl}/rest/v1/${encodeURIComponent(table)}`);
  url.searchParams.set("select", "greenhouse_user_id,primary_email,status");
  url.searchParams.set("status", `eq.${DIRECTORY_RESOLVED_STATUS}`);

  const response = await (config.fetchImpl ?? fetch)(url, {
    method: "GET",
    headers: {
      apikey: apiKey,
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Identity directory read failed with status ${response.status}.`);
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
    rows.push({ greenhouseUserId, primaryEmail, status });
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

  // Apply revokes and tombstones only. Each is a status flip to 'deactivated' — never a grant — so
  // partial application (if a later row fails) is fail-safe: nothing gains access, and a re-run
  // finishes the rest. Never touches 'kept' or 'skip' rows.
  for (const entry of [...plan.revoked, ...plan.tombstoned]) {
    const url = new URL(`${baseUrl}/rest/v1/${encodeURIComponent(table)}`);
    url.searchParams.set("greenhouse_user_id", `eq.${entry.greenhouseUserId}`);
    // PATCH replaces only these three columns; greenhouse_user_id / primary_email / google_subject /
    // first_seen_at / slack_user_id / source are untouched. evidence_detail is intentionally
    // REPLACED (not merged): for a deactivated row the deprovisioning cause is the relevant evidence,
    // and a returning recruiter's bootstrap provenance is rewritten by the bootstrap upsert anyway.
    const body = {
      status: DEACTIVATED_STATUS,
      last_verified_at: appliedAt,
      evidence_detail: {
        source: "identity_directory_reconciliation",
        action: entry.action,
        reason: entry.reason,
      },
    };
    const response = await fetchImpl(url, {
      method: "PATCH",
      headers: {
        apikey: apiKey,
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        prefer: "return=minimal",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(
        `Identity reconciliation update failed for greenhouse_user_id ${entry.greenhouseUserId} with status ${response.status}.`
      );
    }
  }

  return {
    ok: true,
    appliedAt,
    table,
    revokedCount: plan.revoked.length,
    tombstonedCount: plan.tombstoned.length,
    containsTokens: false,
  };
}

interface ReconciliationCliArgs {
  greenhouseUsersFile?: string;
  fetchRoster: boolean;
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
    if (parsed.fetchRoster) {
      const { readFullGreenhouseUsersRoster } = await import("./scoped-reader.js");
      const roster = await readFullGreenhouseUsersRoster(env);
      greenhouseUsers = roster.users;
      rosterComplete = roster.complete;
    } else {
      greenhouseUsers = JSON.parse(await readFile(parsed.greenhouseUsersFile as string, "utf8")) as unknown;
    }
    const directoryRows = await fetchResolvedDirectoryRows(accessConfig);
    const plan = buildIdentityReconciliationPlan({
      directoryRows,
      greenhouseUsers,
      rosterComplete,
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
      "Usage: greenhouse-recruiter-reconcile-identity (--fetch-roster | --greenhouse-users-file greenhouse-users.json) [--out plan.json] [--roster-complete] [--confirm-mass-deprovision] [--apply]. " +
        "--fetch-roster reads the live COMPLETE /v3/users roster itself (roster completeness derived from pagination, never asserted). " +
        "With a file, it must be the COMPLETE /v3/users export; pass --roster-complete to allow deprovisioning recruiters who are absent from it. " +
        "If a complete roster would deprovision more than half the directory, pass --confirm-mass-deprovision to override the blast-radius floor."
    );
  }
  return { greenhouseUsersFile, fetchRoster, out: values.get("out"), apply, rosterComplete, confirmMassDeprovision };
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
