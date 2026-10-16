import {
  createGreenhouseRawReader,
  createHarvestPermissionProvider,
  createOperatorActorIds,
  createScopedGreenhouseReader,
} from "../../scoped-core/src/index.js";
import { apiGet, apiGetWithCursor, configure } from "../../control-plane/dist/client-readonly.js";
import { createIdentityActorResolver, type IdentityDirectory } from "./identity.js";
import {
  createPrivateCandidateAttestationLookup,
  createPrivateCandidateAttestationStamp,
  type PrivateCandidateAttestationLookup,
} from "./private-candidate-attestation.js";
import { createSiteAdminAwarePermissionProvider } from "./site-admin-permission.js";
import { createCachingRawReader, readReadCacheConfig } from "./read-cache.js";
import { createTtlMemo } from "./ttl-memo.js";
import type { AuthenticatedSession } from "./types.js";
import { readBooleanEnvFlag } from "./env.js";
import { SCOPED_TOOL_SCOPE_POLICIES } from "./tools/scoped-endpoint-adapters.js";

export function configureGreenhouseFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  const clientId = env.GREENHOUSE_CLIENT_ID;
  const clientSecret = env.GREENHOUSE_CLIENT_SECRET;
  if (!clientId || clientId.trim().length === 0 || !clientSecret || clientSecret.trim().length === 0) {
    throw new Error("GREENHOUSE_CLIENT_ID and GREENHOUSE_CLIENT_SECRET are required.");
  }
  if (clientId.trim() !== clientId || clientSecret.trim() !== clientSecret) {
    throw new Error("GREENHOUSE_CLIENT_ID and GREENHOUSE_CLIENT_SECRET must not contain leading or trailing whitespace.");
  }
  configure(clientId, clientSecret);
}

// Module-scoped permission-provider registry (the sharedLimiters pattern): the hosted server is
// rebuilt PER REQUEST, so a provider (and its TTL cache) created inside createProductionScopedReader
// would be discarded before it could ever serve a second read. Keyed by the env fingerprint that
// changes provider behavior, so tests with different env still get distinct providers.
type PermissionProviderLike = {
  getPermittedJobIds(userId: number, signal?: AbortSignal): Promise<unknown>;
};
const sharedPermissionProviders = new Map<string, PermissionProviderLike>();

// The attestation lookup keeps the "warn once per failure class" state, so it has to outlive the
// per-request server the same way the permission providers do. Keyed on the directory coordinates
// that change its behaviour; the KEY never carries the service-role key, only whether one is set.
const sharedAttestationLookups = new Map<string, PrivateCandidateAttestationLookup>();

/**
 * Everything about the directory that changes what an attestation lookup ANSWERS, and nothing that
 * is a secret.
 *
 * One function, used by both registries, because the two used to disagree: the lookup registry keyed
 * on the id column, the status column and the resolved-status value; the provider registry keyed on
 * the URL and the table only. A process that rebuilt a reader with a different id/status column
 * therefore got a fresh lookup and the OLD memoized provider — whose cached answer still carried the
 * previous configuration's attestation. Same inputs, same key, in both places.
 *
 * The API key is never part of the key — only whether one is set, which is what decides whether the
 * lookup can run at all.
 */
export function privateCandidateAttestationFingerprint(env: NodeJS.ProcessEnv): string {
  return [
    env.GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL ?? "",
    env.GREENHOUSE_RECRUITER_IDENTITY_TABLE ?? "",
    env.GREENHOUSE_RECRUITER_IDENTITY_GREENHOUSE_USER_ID_COLUMN ?? "",
    env.GREENHOUSE_RECRUITER_IDENTITY_STATUS_COLUMN ?? "",
    env.GREENHOUSE_RECRUITER_IDENTITY_RESOLVED_STATUS ?? "",
    env.GREENHOUSE_RECRUITER_IDENTITY_EMAIL_COLUMN ?? "",
    env.GREENHOUSE_RECRUITER_IDENTITY_LOOKUP_TIMEOUT_MS ?? "",
    env.GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY ? "keyed" : "unkeyed",
  ].join("|");
}

function getPrivateCandidateAttestationLookup(env: NodeJS.ProcessEnv): PrivateCandidateAttestationLookup {
  const key = privateCandidateAttestationFingerprint(env);
  let lookup = sharedAttestationLookups.get(key);
  if (!lookup) {
    lookup = createPrivateCandidateAttestationLookup(env);
    sharedAttestationLookups.set(key, lookup);
  }
  return lookup;
}

// The TTL + single-flight + refcount + evict-on-failure machinery this used to spell out inline
// now lives in ttl-memo.ts, unchanged, so other callers in this package can share one
// implementation instead of maintaining separate caches. What stays here is the
// part that is specific to permissions: the key (Greenhouse user id), the TTL-0 passthrough, and
// the abort message. No clock is injected — permission freshness stays on the real wall clock.
function memoizePermissionScope(provider: PermissionProviderLike, ttlMs: number): PermissionProviderLike {
  if (ttlMs <= 0) return provider;
  // Covers the WHOLE chain (site-admin probe + base grants) per user, unlike the base provider's
  // internal cache which excludes the wrapper's per-call /users probe.
  const memo = createTtlMemo<number, unknown>({
    ttlMs,
    load: (userId, signal) => provider.getPermittedJobIds(userId, signal),
    cancelledMessage: "Scoped Greenhouse permission lookup was cancelled by the caller.",
  });
  return {
    getPermittedJobIds(userId: number, signal?: AbortSignal) {
      return memo(userId, signal);
    },
  };
}

/**
 * The attestation ages on the same clock as the permission scope it decides.
 *
 * The provider path already gets this for free — the stamp runs inside `memoizePermissionScope`.
 * The direct-operator path does not: it reads before the provider chain runs, so without this every
 * operator read would cost its own PostgREST lookup. TTL 0 (which production forces) passes the
 * lookup straight through, exactly as the permission memo does.
 */
function memoizeAttestationLookup(
  lookup: PrivateCandidateAttestationLookup,
  ttlMs: number
): PrivateCandidateAttestationLookup {
  if (ttlMs <= 0) return lookup;
  const memo = createTtlMemo<number, boolean>({
    ttlMs,
    load: (userId, signal) => lookup(userId, signal),
    cancelledMessage: "Private-candidate attestation lookup was cancelled by the caller.",
  });
  return (userId, signal) => memo(userId, signal);
}

export function createProductionScopedReader(
  identityDirectory: IdentityDirectory,
  env: NodeJS.ProcessEnv = process.env
) {
  const rawReader = createGreenhouseRawReader({ apiGet, apiGetWithCursor });
  // Data reads go through the shared short-TTL cache (scale-ceiling fix). Permission and
  // site-admin reads intentionally use the UNCACHED rawReader: they are actor-specific and their
  // freshness is governed separately by the permission TTL + the readiness gate, so the
  // read cache must not silently change how fresh a user's permissions are.
  const cachedRawReader = createCachingRawReader(rawReader, readReadCacheConfig(env));
  const ttlMs = readPermissionTtlMs(env);
  const disableSiteAdmin = readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_DISABLE_SITE_ADMIN_ALL_ACCESS");
  const attestationLookup = memoizeAttestationLookup(getPrivateCandidateAttestationLookup(env), ttlMs);
  const providerKey = [
    `ttl:${ttlMs}`,
    `siteadmin:${disableSiteAdmin ? "off" : "on"}`,
    // The stamp's answer is part of what the memo caches, so a differently-configured directory has
    // to get its own provider or one process's attestation state would serve another's reads. The
    // FULL fingerprint, not the URL and table: a rebuild that changed only the id or status column
    // reused the provider memoized under the previous configuration — and with it the positive
    // attestation that configuration had produced.
    `attest:${privateCandidateAttestationFingerprint(env)}`,
  ].join("|");
  let permissionProvider = sharedPermissionProviders.get(providerKey);
  if (!permissionProvider) {
    const basePermissionProvider = createHarvestPermissionProvider({ rawReader, ttlMs });
    // Greenhouse site admins are not represented in /v3/user_job_permissions, so the
    // per-job-grant base provider resolves them to zero jobs. Grant them all-access
    // (matching their real Greenhouse authority) via the site-admin-aware wrapper,
    // unless explicitly disabled. Fail-closed: a site-admin probe failure never widens access.
    const chained = disableSiteAdmin
      ? basePermissionProvider
      : createSiteAdminAwarePermissionProvider({ base: basePermissionProvider, rawReader });
    // The private-candidate attestation is stamped onto every all-access answer HERE, inside the
    // memo, so the flag ages on the same clock as the scope it belongs to: a CLI attestation is
    // observed within readPermissionTtlMs (60s by default, and immediately in production, which
    // sets GREENHOUSE_RECRUITER_FORCE_PERMISSION_TTL_ZERO). Stamping outside the memo would write
    // one actor's attestation onto the shared cached object.
    const stamped = createPrivateCandidateAttestationStamp({
      chained,
      base: basePermissionProvider,
      isAttested: attestationLookup,
    });
    permissionProvider = memoizePermissionScope(stamped, ttlMs);
    sharedPermissionProviders.set(providerKey, permissionProvider);
  }
  return createScopedGreenhouseReader<AuthenticatedSession>({
    rawReader: cachedRawReader,
    // The candidate `private` flag decides whether a row is withheld, so it belongs with the
    // permission reads above and not with the data reads: the cache would otherwise stack a second,
    // unaccounted staleness layer on top of the permission TTL for one authorization input.
    authorizationReader: rawReader,
    actorResolver: createIdentityActorResolver(identityDirectory),
    // The direct-operator path returns raw data before the permission provider runs, so it cannot
    // read the flag the provider stamps onto a scope. It gets the lookup itself; an operator whose
    // attestation cannot be established is unattested, never assumed.
    privateCandidateAttestation: attestationLookup,
    permissionProvider: permissionProvider as Parameters<typeof createScopedGreenhouseReader>[0]["permissionProvider"],
    scopePolicyRegistry: SCOPED_TOOL_SCOPE_POLICIES,
    operatorActorIds:
      readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_DISABLE_OPERATOR_UNSCOPED")
        ? new Set<number>()
        : createRecruiterOperatorActorIds(env),
  });
}

/**
 * Read the COMPLETE Greenhouse /v3/users roster (id/email/deactivated per row) for identity
 * reconciliation. Lives here because scoped-reader.ts is the sanctioned raw-client chokepoint
 * (the package guard forbids raw read primitives anywhere else). `complete` is true only when
 * cursor pagination finished naturally — the reconciliation plan builder only tombstones
 * absent rows under a complete roster, so an incomplete read can only ever under-deprovision.
 */
export async function readFullGreenhouseUsersRoster(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ users: unknown[]; complete: boolean; pagesRead: number }> {
  configureGreenhouseFromEnv(env);
  const users: unknown[] = [];
  const maxPages = 200;
  let pagesRead = 0;
  let cursor: string | null = null;
  while (pagesRead < maxPages) {
    const response: { data: unknown[]; nextCursor: string | null } = cursor === null
      ? await apiGet<unknown[]>("/users", { per_page: 500 })
      : await apiGetWithCursor<unknown[]>("/users", cursor);
    pagesRead += 1;
    if (Array.isArray(response.data)) users.push(...response.data);
    cursor = response.nextCursor;
    if (cursor === null) return { users, complete: true, pagesRead };
  }
  return { users, complete: false, pagesRead };
}

/**
 * Read the Greenhouse users whose PRIMARY email is the given address, for first-sign-in
 * enrollment (CLO-271). Chokepoint-resident for the same guard reason as the roster reader.
 * `primary_email` is a documented /v3/users filter; a colleague whose Google address is only a
 * SECONDARY Greenhouse email matches nothing here, which is why the enrollment falls back to the
 * full roster before it decides "no such user".
 */
export async function readGreenhouseUsersByPrimaryEmail(
  email: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<unknown[]> {
  configureGreenhouseFromEnv(env);
  const response: { data: unknown[] } = await apiGet<unknown[]>("/users", { primary_email: email, per_page: 50 });
  return Array.isArray(response.data) ? response.data : [];
}

/**
 * Read the COMPLETE /v3/applications set for the weekly pipeline-state snapshot (the logbook's
 * scheduled service-actor sweep). Chokepoint-resident for the same guard reason as the roster
 * reader above. The caller (pipeline-snapshot-cli) refuses to WRITE from an incomplete read.
 */
export async function readFullApplicationsForSnapshot(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ applications: unknown[]; complete: boolean; pagesRead: number }> {
  const collected: unknown[] = [];
  const result = await streamApplicationsForSnapshot(env, (page) => { collected.push(...page); });
  return { applications: collected, complete: result.complete, pagesRead: result.pagesRead };
}

/**
 * Streaming variant: hands each page to `onPage` and NEVER accumulates rows. The in-service
 * sweep folds pages into small per-req-stage counters as they arrive — accumulating the full
 * application set in memory would exhaust a small container's heap.
 * Memory here must stay O(page), not O(org).
 */
export async function streamApplicationsForSnapshot(
  env: NodeJS.ProcessEnv,
  onPage: (page: Array<Record<string, unknown>>) => void,
  extraParams: Record<string, string | number | boolean> = {}
): Promise<{ complete: boolean; pagesRead: number; rowsRead: number }> {
  configureGreenhouseFromEnv(env);
  // 5000-page runaway backstop (2.5M rows). The sweep filters status=active, so real crawls are
  // the live pipeline only — an unfiltered full-org read can exhaust the page budget, and is refused
  // as incomplete rather than written partial.
  const maxPages = 5_000;
  let pagesRead = 0;
  let rowsRead = 0;
  let cursor: string | null = null;
  while (pagesRead < maxPages) {
    const response: { data: unknown[]; nextCursor: string | null } = cursor === null
      ? await apiGet<unknown[]>("/applications", { per_page: 500, ...extraParams })
      : await apiGetWithCursor<unknown[]>("/applications", cursor);
    pagesRead += 1;
    if (Array.isArray(response.data)) {
      const page = response.data.filter(
        (row): row is Record<string, unknown> => row !== null && typeof row === "object" && !Array.isArray(row)
      );
      rowsRead += page.length;
      onPage(page);
    }
    cursor = response.nextCursor;
    if (cursor === null) return { complete: true, pagesRead, rowsRead };
  }
  return { complete: false, pagesRead, rowsRead };
}

export function createRecruiterOperatorActorIds(env: NodeJS.ProcessEnv = process.env): Set<number> {
  const raw = env.OPERATOR_ACTOR_IDS;
  if (raw === undefined || raw.trim().length === 0) {
    return new Set<number>();
  }
  const tokens = raw.split(",").map((token) => token.trim()).filter(Boolean);
  const invalid = tokens.some((token) => !/^[1-9]\d*$/.test(token));
  if (invalid) {
    throw new Error("OPERATOR_ACTOR_IDS must contain only comma-separated positive Greenhouse user ids.");
  }
  return createOperatorActorIds(env);
}

// Default permission-cache TTL (T1.2): 60s. The vendored contract proves Greenhouse deactivation
// does not revoke user_job_permissions, so a short cache gives up no real freshness while killing
// the per-page permission re-sweep (3x amplification on the ONE shared Harvest budget). Opt-outs:
// GREENHOUSE_RECRUITER_FORCE_PERMISSION_TTL_ZERO, or an explicit GREENHOUSE_RECRUITER_PERMISSION_TTL_MS=0.
export const DEFAULT_PERMISSION_TTL_MS = 60_000;

export function readPermissionTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  if (readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_FORCE_PERMISSION_TTL_ZERO")) {
    return 0;
  }
  const raw = env.GREENHOUSE_RECRUITER_PERMISSION_TTL_MS;
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_PERMISSION_TTL_MS;
  }
  const parsed = readNonNegativeInt(raw);
  if (parsed === null) {
    throw new Error("GREENHOUSE_RECRUITER_PERMISSION_TTL_MS must be a non-negative safe integer number of milliseconds.");
  }
  return parsed;
}

function readNonNegativeInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && value.trim() === value && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}
