import type { PermissionScope } from "../../scoped-core/src/index.js";
import { DEFAULT_EXTERNAL_LOOKUP_TIMEOUT_MS, fetchWithTimeout, readLookupTimeoutMs } from "./fetch-timeout.js";
import {
  assertCanonicalSupabaseProjectRef,
  normalizeOptionalSupabaseIdentifier,
  normalizeSupabaseApiKey,
} from "./supabase-config.js";

/**
 * The private-candidate attestation (CLO-273).
 *
 * Greenhouse gates a private candidate on a USER-SPECIFIC permission ("Can create and view private
 * candidates") that Harvest v3 does not expose. The read plane can see that an actor is a site
 * admin, or holds an all-jobs role — neither of which is that permission — so an all-access actor
 * used to receive every private candidate in the tenant on the strength of an inference Greenhouse
 * itself does not make. This module supplies the missing input: a per-directory-row attestation an
 * operator records with `greenhouse-recruiter-attest-private-candidates`.
 *
 * Two pieces live here:
 *   - the LOOKUP, one PostgREST read that answers "has an operator attested this user";
 *   - the provider STAMP, which puts the answer on the permission scope so the scoped core can gate
 *     on it without ever learning how the directory is stored.
 *
 * Deliberately independent of `identity.ts`'s resolver. That resolver's PostgREST select is a fixed
 * list, and its undefined-column fallback only understands the row-id column — a new column in that
 * select would be misclassified on a project where the migration has not landed and end in a thrown
 * identity outage (identity.ts:447). A separate read costs one request and cannot take identity
 * resolution down with it.
 */

export const PRIVATE_CANDIDATES_ATTESTED_COLUMN = "private_candidates_attested";
export const PRIVATE_CANDIDATES_ATTESTED_AT_COLUMN = "private_candidates_attested_at";
export const PRIVATE_CANDIDATES_ATTESTED_BY_COLUMN = "private_candidates_attested_by";

/** The three columns migration 0008 adds. Exported so the writer-lock tests name one source. */
export const PRIVATE_CANDIDATE_ATTESTATION_COLUMNS: readonly string[] = [
  PRIVATE_CANDIDATES_ATTESTED_COLUMN,
  PRIVATE_CANDIDATES_ATTESTED_AT_COLUMN,
  PRIVATE_CANDIDATES_ATTESTED_BY_COLUMN,
];

export type PrivateCandidateAttestationLookup = (
  greenhouseUserId: number,
  signal?: AbortSignal
) => Promise<boolean>;

/**
 * Where the attestation is read from. The identity directory's own Supabase pair, its table name
 * and its column overrides — the same configuration the resolver takes, read here so a custom table
 * stays supported without the resolver having to carry the column.
 */
export interface PrivateCandidateAttestationAccess {
  baseUrl: string;
  apiKey: string;
  table: string;
  greenhouseUserIdColumn: string;
  /**
   * The directory's email column. The runtime lookup never filters on it — it resolves by
   * Greenhouse user id — but the CLI's `--email` does, and it used to hard-code `primary_email`
   * while every other identifier honoured its override. On a directory configured with
   * `GREENHOUSE_RECRUITER_IDENTITY_EMAIL_COLUMN` that filter names a column the table does not
   * have. Resolved here so the reader and the writer cannot disagree about the schema.
   */
  emailColumn: string;
  statusColumn: string;
  resolvedStatus: string;
  timeoutMs: number;
}

export function readPrivateCandidateAttestationAccess(
  env: NodeJS.ProcessEnv
): PrivateCandidateAttestationAccess | null {
  const supabaseUrl = env.GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL;
  const apiKey = env.GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY;
  // A directory that is not Supabase-backed (the JSON/static configurations) carries no attestation
  // to read. That is not an error and must not throw here: it resolves to "unattested", which is
  // the fail-closed direction — private candidates stay withheld from an org-wide actor whose
  // permission we cannot establish.
  if (!supabaseUrl || !apiKey) return null;
  return {
    baseUrl: assertCanonicalSupabaseProjectRef(supabaseUrl, "Supabase identity directory"),
    apiKey: normalizeSupabaseApiKey(apiKey, "Supabase identity directory"),
    table: normalizeOptionalSupabaseIdentifier(
      env.GREENHOUSE_RECRUITER_IDENTITY_TABLE,
      "recruiter_identity_directory",
      "Supabase identity directory table"
    ),
    greenhouseUserIdColumn: normalizeOptionalSupabaseIdentifier(
      env.GREENHOUSE_RECRUITER_IDENTITY_GREENHOUSE_USER_ID_COLUMN,
      "greenhouse_user_id",
      "Supabase identity Greenhouse user id column"
    ),
    emailColumn: normalizeOptionalSupabaseIdentifier(
      env.GREENHOUSE_RECRUITER_IDENTITY_EMAIL_COLUMN,
      "primary_email",
      "Supabase identity email column"
    ),
    statusColumn: normalizeOptionalSupabaseIdentifier(
      env.GREENHOUSE_RECRUITER_IDENTITY_STATUS_COLUMN,
      "status",
      "Supabase identity status column"
    ),
    resolvedStatus: env.GREENHOUSE_RECRUITER_IDENTITY_RESOLVED_STATUS?.trim() || "resolved",
    timeoutMs: readLookupTimeoutMs(
      env.GREENHOUSE_RECRUITER_IDENTITY_LOOKUP_TIMEOUT_MS,
      "GREENHOUSE_RECRUITER_IDENTITY_LOOKUP_TIMEOUT_MS",
      DEFAULT_EXTERNAL_LOOKUP_TIMEOUT_MS
    ),
  };
}

/**
 * Build the attestation lookup.
 *
 * Answers `true` ONLY when exactly one resolved directory row comes back and its flag is strictly
 * `true`. Every other outcome — no row, two rows (a duplicate the unique index should prevent but
 * which must never be resolved by picking one), a 400 because the migration has not been applied
 * yet, a 5xx, a timeout, a malformed body, a network error — answers `false` and never throws.
 * That is what lets the migration and the deploy land in either order: before the columns exist the
 * read fails, the answer is "unattested", and the only consequence is that private candidates stay
 * withheld from org-wide actors until the operator attests them.
 *
 * Failures are warned about ONCE per distinct class per lookup instance. The lookup is built once
 * per env fingerprint in `scoped-reader.ts`, so that is once per process — a per-request warning on
 * a dead column would be a log flood, and no warning at all would make a silent withhold
 * undiagnosable. Never logs the URL or the key.
 */
export function createPrivateCandidateAttestationLookup(
  env: NodeJS.ProcessEnv = process.env,
  // Resolved per REQUEST, not captured here: the lookup is built once per env fingerprint and
  // outlives many requests, so binding whatever `globalThis.fetch` happened to be at construction
  // time would freeze one moment's transport for the life of the process.
  fetchImpl?: typeof fetch,
  warn: (message: string) => void = (message) => console.warn(message)
): PrivateCandidateAttestationLookup {
  let access: PrivateCandidateAttestationAccess | null;
  try {
    access = readPrivateCandidateAttestationAccess(env);
  } catch (error) {
    // A misconfigured directory pair is the identity layer's problem to report; here it can only
    // mean "cannot establish the attestation", which is unattested.
    access = null;
  }
  const warnedClasses = new Set<string>();
  const warnOnce = (failureClass: string, detail: string): void => {
    if (warnedClasses.has(failureClass)) return;
    warnedClasses.add(failureClass);
    try {
      warn(`[private-candidate-attestation] ${failureClass}: ${detail} — treating org-wide actors as unattested.`);
    } catch (error) {
      // A logger that throws must not become a read failure. This function's whole contract is
      // "never rejects", and it is called from inside the permission path — a console replaced by a
      // transport that raises on a closed stream would otherwise turn a diagnostic into an outage
      // on every scoped read. The class is already marked, so the throw is not retried either.
    }
  };

  if (access === null) {
    return async () => false;
  }
  const resolved = access;

  return async function isPrivateCandidateAttested(greenhouseUserId, signal): Promise<boolean> {
    if (!Number.isSafeInteger(greenhouseUserId) || greenhouseUserId <= 0) return false;
    const url = new URL(`${resolved.baseUrl}/rest/v1/${encodeURIComponent(resolved.table)}`);
    url.searchParams.set("select", PRIVATE_CANDIDATES_ATTESTED_COLUMN);
    url.searchParams.set(resolved.greenhouseUserIdColumn, `eq.${greenhouseUserId}`);
    url.searchParams.set(resolved.statusColumn, `eq.${resolved.resolvedStatus}`);
    // Two, not one: a second row means the directory holds a duplicate for this user, and picking
    // the first would let a stale row grant access. Read enough to detect it, then refuse.
    url.searchParams.set("limit", "2");

    let response: Response;
    try {
      response = await fetchWithTimeout(
        fetchImpl ?? fetch,
        url,
        {
          method: "GET",
          headers: {
            apikey: resolved.apiKey,
            authorization: `Bearer ${resolved.apiKey}`,
            accept: "application/json",
          },
          ...(signal ? { signal } : {}),
        },
        resolved.timeoutMs,
        "Private-candidate attestation lookup"
      );
    } catch (error) {
      warnOnce("lookup_failed", errorLabel(error));
      return false;
    }
    if (!response.ok) {
      warnOnce(`http_${response.status}`, `the identity directory answered ${response.status}`);
      return false;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      warnOnce("malformed_body", "the identity directory returned a body that is not JSON");
      return false;
    }
    if (!Array.isArray(body)) {
      warnOnce("non_array_body", "the identity directory returned a non-array response");
      return false;
    }
    if (body.length !== 1) {
      if (body.length > 1) {
        warnOnce("duplicate_rows", "more than one resolved row matched this Greenhouse user id");
      } else {
        // Zero rows is a failure class of its own, and it is the QUIET one: the actor reads
        // everything except private candidates, forever, and nothing in the envelope says why. It
        // happens when the id is not in the directory at all, and — the case that actually bites —
        // when the row is there but not `resolved`. Warned once per process like the rest, so the
        // silent withhold is diagnosable without a log flood.
        warnOnce("missing_row", "no resolved directory row matched this Greenhouse user id");
      }
      return false;
    }
    const row = body[0] as Record<string, unknown> | null;
    return isRecord(row) && row[PRIVATE_CANDIDATES_ATTESTED_COLUMN] === true;
  };
}

function errorLabel(error: unknown): string {
  if (error instanceof Error) return error.name;
  return "unknown error";
}

// ---------------------------------------------------------------------------
// The permission-provider stamp
// ---------------------------------------------------------------------------

/** The minimal shape both the base provider and the site-admin chain satisfy. */
export interface PermissionProviderLike {
  getPermittedJobIds(greenhouseUserId: number, signal?: AbortSignal): Promise<unknown>;
}

export interface PrivateCandidateAttestationStampOptions {
  /** The full provider chain whose answer is being stamped (site-admin wrapper over the base). */
  chained: PermissionProviderLike;
  /**
   * The BASE per-job-grant provider. Consulted only for an UNATTESTED all-access actor, to recover
   * the `privateCapableJobIds` the site-admin path discards: Greenhouse grants private visibility
   * per job through the built-in "Private" Job Admin role as well as org-wide, and an actor who
   * holds that role on a req is entitled to its private candidates whether or not anyone has
   * attested them org-wide. Withholding those would deny access the organization already granted.
   */
  base: PermissionProviderLike;
  isAttested: PrivateCandidateAttestationLookup;
}

/**
 * Wrap a permission-provider chain so every `{ kind: "all" }` answer carries the actor's
 * private-candidate attestation.
 *
 * This is the ONE place the flag is stamped. The three all-access constructors in
 * `site-admin-permission.ts` and the base provider's all-jobs marker all funnel through here, so a
 * new all-access path cannot be added without inheriting the gate.
 *
 * Never mutates the answer it was given: the chain's object may be memoized (and in production it
 * is, for `readPermissionTtlMs`), and writing onto it would stamp one actor's attestation onto a
 * shared object. A fresh object is returned every call.
 *
 * `{ kind: "jobs" }` and bare-Set answers are returned untouched and cost no lookup — a job-scoped
 * actor has no org-wide grant to attest, and their private access is already decided per job.
 */
export function createPrivateCandidateAttestationStamp(
  options: PrivateCandidateAttestationStampOptions
): PermissionProviderLike {
  return {
    async getPermittedJobIds(greenhouseUserId: number, signal?: AbortSignal): Promise<unknown> {
      const scope = await options.chained.getPermittedJobIds(greenhouseUserId, signal);
      if (!isAllAccessScope(scope)) return scope;
      // A lookup that REJECTS is unattested, not a read failure. The lookup's own contract is
      // "never throws", but it is injected — a memo wrapper, a test double, a future transport —
      // and letting a rejection out of here turned a Supabase blip into PERMISSION_LOOKUP_FAILED
      // for every org-wide actor, i.e. a total read outage. The operator branch in scoped-core has
      // carried this catch since the first fold; the stamp path did not. The recovery below still
      // runs, so a directory blip does not ALSO cost the actor the reqs Greenhouse granted them.
      let attested = false;
      try {
        attested = (await options.isAttested(greenhouseUserId, signal)) === true;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        attested = false;
      }
      if (attested) {
        return { ...scope, privateCandidatesAttested: true };
      }
      const privateCapableJobIds = await explicitPrivateCapableJobIds(
        options.base,
        scope,
        greenhouseUserId,
        signal
      );
      return {
        ...scope,
        privateCandidatesAttested: false,
        ...(privateCapableJobIds && privateCapableJobIds.size > 0 ? { privateCapableJobIds } : {}),
      };
    },
  };
}

function isAllAccessScope(value: unknown): value is PermissionScope & { kind: "all" } {
  return isRecord(value) && value.kind === "all";
}

/**
 * The jobs this actor holds through a private-capable Greenhouse role, read from their EXPLICIT
 * per-job grants.
 *
 * The chain's own answer is consulted FIRST, and it usually has one. The site-admin wrapper reads
 * `/user_job_permissions` for the confidential-job check and now carries the private-capable subset
 * of those grants forward; the base provider's all-jobs marker path resolves them in the same sweep
 * it was already paginating. Calling base again to recover what the chain just fetched cost a
 * duplicated `/user_job_permissions` pagination (plus a `/user_roles` read) on EVERY unattested
 * all-access answer, on a TTL production forces to zero.
 *
 * Fails soft to `undefined`: if neither the chain nor the base provider can answer, no job is
 * treated as private-capable and the unattested actor sees no private candidates at all, which is
 * the same direction every other failure in this layer takes. It can only under-grant.
 */
async function explicitPrivateCapableJobIds(
  base: PermissionProviderLike,
  chainedScope: PermissionScope & { kind: "all" },
  greenhouseUserId: number,
  signal?: AbortSignal
): Promise<ReadonlySet<number> | undefined> {
  if (chainedScope.privateCapableJobIds !== undefined) {
    return new Set(chainedScope.privateCapableJobIds);
  }
  let granted: unknown;
  try {
    granted = await base.getPermittedJobIds(greenhouseUserId, signal);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    return undefined;
  }
  if (!isRecord(granted)) return undefined;
  // Either shape can carry it now: `jobs` for an ordinary per-job actor, `all` when the base
  // provider's own all-jobs marker fired and it resolved the explicit roles alongside it.
  if (granted.kind !== "jobs" && granted.kind !== "all") return undefined;
  const privateCapable = (granted as Extract<PermissionScope, { kind: "jobs" | "all" }>).privateCapableJobIds;
  return privateCapable === undefined ? undefined : new Set(privateCapable);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
