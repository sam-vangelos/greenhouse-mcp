import { createHash } from "node:crypto";
import { actionClientForRecruiterSession, isActionClientName, sessionNamesOneActor, type ActionClientName } from "./auth.js";
import { DEFAULT_EXTERNAL_LOOKUP_TIMEOUT_MS, fetchWithTimeout, readLookupTimeoutMs } from "./fetch-timeout.js";
import { resolveActionIdentity, type IdentityDirectory, type ResolvedActionIdentity } from "./identity.js";
import {
  assertCanonicalSupabaseProjectRef,
  normalizeOptionalSupabaseIdentifier,
  normalizeSupabaseApiKey,
  normalizeSupabaseRestOrigin,
} from "./supabase-config.js";
import { createTtlMemo, type TtlMemo } from "./ttl-memo.js";
import type { AuthenticatedSession } from "./types.js";

/**
 * Reads `greenhouse_action_entitlement` to answer ONE question: does this session see the write
 * plane's tools in its catalog?
 *
 * What this deliberately does NOT answer is whether a mutation may proceed. The entitlement row
 * carries `can_apply` and `can_apply_high_impact`; this module never selects them, never returns
 * them, and never caches them. That is the difference between a catalog hint and a kill switch:
 * a cached `writes_enabled` would keep authorizing writes for a full TTL after an entitlement is
 * disabled, so Phase 2's mutation path re-reads control state atomically at apply time through
 * the action plane's own store (action-mcp/src/store.ts `getEntitlement`). The worst this cache
 * can do when a grant is revoked mid-TTL is leave 22 tool names visible until it expires; every
 * one of them then denies at the store.
 */

export type ActionCatalogVisibilityReason =
  | "entitled"
  /** No entitlement store wired into this environment — the write plane simply is not deployed here. */
  | "write_plane_not_deployed"
  /**
   * The session's `email:` subject and email claim name two different actors, so nothing here can
   * say who would be writing. Unreachable through token validation, which refuses such a token;
   * reachable by a session assembled in code, which is why it has its own reason instead of being
   * folded into `client_not_write_capable` and read later as a client problem.
   */
  | "session_actor_not_bound"
  /** The session's client has no action-plane name (Claude Desktop chat, or an unproven client). */
  | "client_not_write_capable"
  /**
   * A custom identity relation/column is configured, so the read plane and the action plane could
   * resolve one opaque subject to different actors. See the Phase 2 seam below.
   */
  | "identity_config_diverges_from_action_plane"
  /** The directory could not produce both ids unambiguously; `detail` carries the denial code. */
  | "identity_not_resolved"
  | "identity_lookup_failed"
  | "no_active_entitlement"
  | "entitlement_expired"
  /** An active row that grants nothing: preview is the floor of the write plane. */
  | "preview_not_granted"
  | "entitlement_lookup_failed";

export interface ActionCatalogVisibility {
  writeToolsVisible: boolean;
  reason: ActionCatalogVisibilityReason;
  /** Diagnostic only — a denial code or an error message. Never an authorization input. */
  detail?: string;
}

export interface ActionEntitlementLookupKey {
  identity: ResolvedActionIdentity;
  client: ActionClientName;
}

export interface ActionEntitlementResolver {
  resolveCatalogVisibility(
    key: ActionEntitlementLookupKey,
    signal?: AbortSignal
  ): Promise<ActionCatalogVisibility>;
}

export interface ActionEntitlementResolverConfig {
  supabaseUrl: string;
  apiKey: string;
  table?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
}

export class ActionEntitlementLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionEntitlementLookupError";
  }
}

// Same 60s default as the permission-scope cache (scoped-reader.ts DEFAULT_PERMISSION_TTL_MS), for
// the same reason and with the same blast radius: this is one shared Supabase project answering a
// question whose staleness costs visible tool names, not access.
export const DEFAULT_ACTION_ENTITLEMENT_CACHE_TTL_MS = 60_000;

const DEFAULT_ACTION_ENTITLEMENT_TABLE = "greenhouse_action_entitlement";

interface CachedVisibility {
  visibility: ActionCatalogVisibility;
  /** The row's `expires_at` in epoch ms, when it set one. Clamps how long the answer is reused. */
  entitlementExpiresAtMs: number | null;
}

export function createActionEntitlementResolver(
  config: ActionEntitlementResolverConfig
): ActionEntitlementResolver {
  const baseUrl = normalizeSupabaseRestOrigin(config.supabaseUrl, "Action entitlement directory");
  const apiKey = normalizeSupabaseApiKey(config.apiKey, "Action entitlement directory");
  const table = normalizeOptionalSupabaseIdentifier(
    config.table,
    DEFAULT_ACTION_ENTITLEMENT_TABLE,
    "Action entitlement table"
  );
  const timeoutMs = config.timeoutMs ?? DEFAULT_EXTERNAL_LOOKUP_TIMEOUT_MS;
  const now = config.now ?? (() => Date.now());
  const ttlMs = config.cacheTtlMs ?? DEFAULT_ACTION_ENTITLEMENT_CACHE_TTL_MS;

  // Keyed on BOTH ids plus the client, because the row is: entitlements are granted per
  // (identity_id, client), and greenhouse_user_id is a second filter on the same row. Two of the
  // three would let a rebound identity or a second client read another key's answer. The
  // remaining key component — the store config — is the resolver INSTANCE itself, which the
  // module registry below fingerprints.
  const memo: TtlMemo<string, CachedVisibility> = createTtlMemo<string, CachedVisibility>({
    ttlMs,
    now,
    cancelledMessage: "Action entitlement lookup was cancelled by the caller.",
    // Never outlive the grant: a row that expires in 5s must not stay cached for the full 60s.
    // createTtlMemo takes the minimum, so this can only shorten the entry.
    deriveExpiryMs: (cached, defaultExpiryMs) =>
      cached.entitlementExpiresAtMs === null ? defaultExpiryMs : cached.entitlementExpiresAtMs,
    load: async (key, signal) => {
      const parsed = parseLookupCacheKey(key);
      return await lookupEntitlement({ baseUrl, table, apiKey, fetchImpl: config.fetchImpl ?? fetch, timeoutMs, now }, parsed, signal);
    },
  });

  return {
    async resolveCatalogVisibility(key, signal) {
      const cached = await memo(lookupCacheKey(key), signal);
      // A copy, not the cached object: every session sharing this key would otherwise hold the
      // same mutable reference, so one caller annotating its result would rewrite the answer the
      // cache gives everyone else for the rest of the TTL.
      return { ...cached.visibility };
    },
  };
}

/**
 * The one call Phase 2 should make. It composes the four denials that are easy to forget
 * separately — a session naming two actors, an ineligible client, an identity that will not resolve
 * to both ids, and an entitlement store that is down — and it never throws: a recruiter's 44 read
 * tools must not depend on the write plane's store being reachable. Write visibility fails CLOSED on
 * every one of those paths, and the failure is reported in `reason`/`detail` rather than swallowed,
 * so a store outage is diagnosable instead of looking like a revoked grant.
 */
export async function resolveActionCatalogVisibility(input: {
  session: AuthenticatedSession;
  directory: IdentityDirectory;
  resolver: ActionEntitlementResolver | null;
  signal?: AbortSignal;
  /** Defaults to process.env; injectable so the identity-divergence fence is testable. */
  env?: NodeJS.ProcessEnv;
}): Promise<ActionCatalogVisibility> {
  if (input.resolver === null) {
    return { writeToolsVisible: false, reason: "write_plane_not_deployed" };
  }
  // Asked before the client map — which enforces the same rule and would return null anyway — so
  // that a session naming two actors is REPORTED as that, rather than as a client this plane has no
  // name for. Both checks stay: this one names the failure, the map's makes it unbypassable by any
  // other caller.
  if (!sessionNamesOneActor(input.session)) {
    return { writeToolsVisible: false, reason: "session_actor_not_bound" };
  }
  // Cheapest exclusion first, and the only one that needs no network: a client with no
  // action-plane name can never match an entitlement row, so neither lookup is worth running.
  const client = actionClientForRecruiterSession(input.session);
  if (client === null) {
    return { writeToolsVisible: false, reason: "client_not_write_capable" };
  }
  // ===========================================================================================
  // PHASE 2 SEAM — THE ACTION PLANE MUST BE HANDED THIS IDENTITY, NOT RE-RESOLVE IT.
  //
  // The identity resolved on the next line is the read plane's answer, and the two planes do not
  // ask the same question. This one queries the email claim AND the subject
  // (identity.ts:294-318); the action plane's store queries the SUBJECT ONLY
  // (action-mcp/src/store.ts:83-95). With the canonical directory those agree, and an `email:`
  // subject is now bound to its email claim (auth.ts `validateEmailSubjectBinding`), so the one
  // remaining way they diverge is an OPAQUE (non-`email:`) subject against a CUSTOM read directory:
  // the store hardcodes both the relation and the column names (`recruiter_identity_directory`,
  // `google_subject`, store.ts:86-91), while this plane honours the
  // GREENHOUSE_RECRUITER_IDENTITY_TABLE and *_COLUMN overrides
  // (identity.ts `createIdentityDirectoryFromEnv`), so one subject can match a different row here
  // than it does there. No amount of validation at this seam closes that: the two planes are
  // re-deriving one actor from different inputs.
  //
  // The fix is compositional and belongs to Phase 2, when the action package becomes importable
  // (docs/job-scope-resolution/phase-1e-action-package-spec.md 4.2): the write path must ACCEPT the
  // `ResolvedActionIdentity` below as an argument and stop calling `store.resolveIdentity` at all.
  // One resolution, one directory config, one actor. Do NOT attempt it from this side by making
  // the read plane imitate the store's lookup — that is the same divergence with an extra copy.
  //
  // Until then, the divergence is fenced off structurally rather than merely documented: the only
  // configuration in which it can occur is a custom identity relation/column, so a deployment that
  // sets one gets NO write tools at all. That turns a hole reachable by a future config change into
  // one that cannot be opened without deleting this check — and it costs today's deployments
  // nothing, because they all use the canonical directory the store hardcodes.
  // ===========================================================================================
  const divergentIdentityConfig = describeDivergentIdentityConfig(input.env ?? process.env);
  if (divergentIdentityConfig !== null) {
    return {
      writeToolsVisible: false,
      reason: "identity_config_diverges_from_action_plane",
      detail: divergentIdentityConfig,
    };
  }
  let identity: ResolvedActionIdentity;
  try {
    const resolved = await resolveActionIdentity(input.directory, input.session);
    if (resolved.status === "denied") {
      return { writeToolsVisible: false, reason: "identity_not_resolved", detail: resolved.code };
    }
    identity = resolved.identity;
  } catch (error) {
    return { writeToolsVisible: false, reason: "identity_lookup_failed", detail: errorDetail(error) };
  }
  try {
    return await input.resolver.resolveCatalogVisibility({ identity, client }, input.signal);
  } catch (error) {
    return { writeToolsVisible: false, reason: "entitlement_lookup_failed", detail: errorDetail(error) };
  }
}

// Module-scoped resolver registry — the sharedPermissionProviders pattern (scoped-reader.ts:34).
// The hosted server is rebuilt PER REQUEST, so a resolver (and its TTL cache) created during
// request assembly would be discarded before it could serve a second lookup. Keyed by everything
// that changes lookup behaviour, including a digest of the API key so a rotated credential gets a
// fresh resolver instead of serving answers the old key fetched.
//
// `fetchImpl` changes lookup behaviour too — it IS the transport — but a function cannot be folded
// into a string key, so it buckets the registry instead. Without this, two callers passing
// different transports against the same env got the same resolver: the second transport was never
// called and its caller was answered out of the first one's backend. Production passes no
// fetchImpl and shares the default bucket, which is what the registry exists for.
const defaultEntitlementResolvers = new Map<string, ActionEntitlementResolver>();
let entitlementResolversByFetch = new WeakMap<typeof fetch, Map<string, ActionEntitlementResolver>>();

function entitlementResolverBucket(fetchImpl?: typeof fetch): Map<string, ActionEntitlementResolver> {
  if (!fetchImpl) return defaultEntitlementResolvers;
  let bucket = entitlementResolversByFetch.get(fetchImpl);
  if (!bucket) {
    bucket = new Map<string, ActionEntitlementResolver>();
    entitlementResolversByFetch.set(fetchImpl, bucket);
  }
  return bucket;
}

export function createActionEntitlementResolverFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch
): ActionEntitlementResolver | null {
  const supabaseUrl = env.GREENHOUSE_ACTION_SUPABASE_URL;
  const apiKey = env.GREENHOUSE_ACTION_SUPABASE_KEY;
  // Neither set is the normal state of every deployment that exists today: no write plane, catalog
  // stays at 44, boot proceeds. Half-set is a misconfiguration and must be loud — a URL with no key
  // would otherwise fail every lookup at request time and read as "nobody is entitled".
  if (!supabaseUrl && !apiKey) return null;
  if (!supabaseUrl || !apiKey) {
    throw new Error(
      "GREENHOUSE_ACTION_SUPABASE_URL and GREENHOUSE_ACTION_SUPABASE_KEY must be set together."
    );
  }
  const origin = assertCanonicalSupabaseProjectRef(supabaseUrl, "Action entitlement directory");
  const table = normalizeOptionalSupabaseIdentifier(
    env.GREENHOUSE_ACTION_ENTITLEMENT_TABLE,
    DEFAULT_ACTION_ENTITLEMENT_TABLE,
    "Action entitlement table"
  );
  const timeoutMs = readLookupTimeoutMs(
    env.GREENHOUSE_ACTION_ENTITLEMENT_LOOKUP_TIMEOUT_MS,
    "GREENHOUSE_ACTION_ENTITLEMENT_LOOKUP_TIMEOUT_MS"
  );
  const cacheTtlMs = readCacheTtlMs(env.GREENHOUSE_ACTION_ENTITLEMENT_CACHE_TTL_MS);
  const registryKey = [
    origin,
    table,
    String(timeoutMs),
    String(cacheTtlMs),
    // Digest, never the key itself: this Map lives for the life of the process and its keys end up
    // in heap dumps and debugger views. The digest still changes on rotation, which is all it is for.
    createHash("sha256").update(normalizeSupabaseApiKey(apiKey, "Action entitlement directory")).digest("base64url").slice(0, 16),
  ].join("|");
  const bucket = entitlementResolverBucket(fetchImpl);
  const existing = bucket.get(registryKey);
  if (existing) return existing;
  // A new key for a backend already in the registry means the credential rotated. Drop the old
  // entry rather than leaving it to live out the process: its closure holds the FULL previous API
  // key, and nothing will ever ask for it again.
  const backendPrefix = `${origin}|${table}|`;
  for (const key of bucket.keys()) {
    if (key.startsWith(backendPrefix)) bucket.delete(key);
  }
  const resolver = createActionEntitlementResolver({
    supabaseUrl: origin,
    apiKey,
    table,
    timeoutMs,
    cacheTtlMs,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  bucket.set(registryKey, resolver);
  return resolver;
}

/**
 * The identity settings the action plane's store cannot honour, because it hardcodes both the
 * relation and the column names it reads (`recruiter_identity_directory`, `google_subject`).
 *
 * Only the SUBJECT-side settings matter. The store looks a subject up in one fixed place; if this
 * plane has been pointed at a different relation, or told the subject lives in a different column,
 * the same opaque subject can name a different actor on each side. The email column is irrelevant
 * (the store never queries by email) and the resolved-status value is a filter, not an identity.
 *
 * Returns a description of what diverges, or null when the configuration is the canonical one every
 * deployment currently uses.
 */
function describeDivergentIdentityConfig(env: NodeJS.ProcessEnv): string | null {
  const divergent: string[] = [];
  if (env.GREENHOUSE_RECRUITER_IDENTITY_TABLE) divergent.push("GREENHOUSE_RECRUITER_IDENTITY_TABLE");
  if (env.GREENHOUSE_RECRUITER_IDENTITY_SUBJECT_COLUMN) {
    divergent.push("GREENHOUSE_RECRUITER_IDENTITY_SUBJECT_COLUMN");
  }
  if (env.GREENHOUSE_RECRUITER_IDENTITY_DIRECTORY_ID_COLUMN) {
    divergent.push("GREENHOUSE_RECRUITER_IDENTITY_DIRECTORY_ID_COLUMN");
  }
  return divergent.length === 0 ? null : divergent.join(",");
}

/** Test-only: drop the module-scoped resolver registry so cases don't inherit each other's caches. */
export function _resetActionEntitlementResolvers(): void {
  defaultEntitlementResolvers.clear();
  entitlementResolversByFetch = new WeakMap<typeof fetch, Map<string, ActionEntitlementResolver>>();
}

interface EntitlementLookupContext {
  baseUrl: string;
  table: string;
  apiKey: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  now: () => number;
}

async function lookupEntitlement(
  context: EntitlementLookupContext,
  key: ActionEntitlementLookupKey,
  signal?: AbortSignal
): Promise<CachedVisibility> {
  // The memo hands its own controller's signal here, and it is both checked AND forwarded. Checked
  // so a lookup whose subscribers have all left never opens a socket at all; forwarded so one that
  // did open closes when the last of them leaves. `fetchWithTimeout` links the two signals rather
  // than replacing this one, so `timeoutMs` remains the upper bound either way.
  signal?.throwIfAborted();
  const url = new URL(`${context.baseUrl}/rest/v1/${encodeURIComponent(context.table)}`);
  // The three id columns are selected back so the filters can be verified against what was asked
  // for. This is not paranoia about PostgREST: a filter accidentally dropped from this URL returns
  // the FIRST ROW OF THE TABLE with HTTP 200, which would hand one recruiter another's grant. The
  // apply flags are deliberately absent from this list — see the module comment.
  url.searchParams.set("select", "identity_id,greenhouse_user_id,client,can_preview,status,expires_at");
  url.searchParams.set("identity_id", `eq.${key.identity.identityId}`);
  url.searchParams.set("greenhouse_user_id", `eq.${key.identity.greenhouseUserId}`);
  url.searchParams.set("client", `eq.${key.client}`);
  url.searchParams.set("status", "eq.active");
  url.searchParams.set("limit", "1");

  const response = await fetchWithTimeout(
    context.fetchImpl,
    url,
    {
      method: "GET",
      redirect: "error",
      ...(signal ? { signal } : {}),
      headers: {
        apikey: context.apiKey,
        authorization: `Bearer ${context.apiKey}`,
        accept: "application/json",
      },
    },
    context.timeoutMs,
    "Action entitlement lookup"
  );
  if (!response.ok) {
    throw new ActionEntitlementLookupError(`Action entitlement lookup failed with status ${response.status}.`);
  }
  const data = await response.json() as unknown;
  if (!Array.isArray(data)) {
    throw new ActionEntitlementLookupError("Action entitlement lookup returned a non-array response.");
  }
  const rows = data.filter((row): row is Record<string, unknown> => row !== null && typeof row === "object" && !Array.isArray(row));
  if (rows.length === 0) {
    return { visibility: { writeToolsVisible: false, reason: "no_active_entitlement" }, entitlementExpiresAtMs: null };
  }
  const row = rows[0]!;
  if (
    row.identity_id !== key.identity.identityId
    || !matchesGreenhouseUserId(row.greenhouse_user_id, key.identity.greenhouseUserId)
    || row.client !== key.client
    // `status` is echoed back for the same reason the three ids are, and it was the one filter of
    // the four whose result went unchecked. A `status=eq.active` that fails to apply returns a
    // suspended or revoked row with HTTP 200, and every later gate here reads `can_preview` — which
    // a disabled row still carries as `true`, because disabling a grant sets the status rather than
    // clearing the flags. So the row an operator had switched off would have restored the write
    // plane's tools to the catalog for a full TTL.
    || row.status !== "active"
  ) {
    throw new ActionEntitlementLookupError("Action entitlement lookup returned a row for a different identity, user, or client, or one that is not active.");
  }
  const expiresAtMs = parseExpiresAtMs(row.expires_at);
  if (expiresAtMs !== null && expiresAtMs <= context.now()) {
    return {
      visibility: { writeToolsVisible: false, reason: "entitlement_expired" },
      // Not clamped to a past instant: that would make every request re-read an expired grant.
      // Re-checking on the normal TTL is the right cadence for a grant that has already lapsed.
      entitlementExpiresAtMs: null,
    };
  }
  if (row.can_preview !== true) {
    return { visibility: { writeToolsVisible: false, reason: "preview_not_granted" }, entitlementExpiresAtMs: expiresAtMs };
  }
  return { visibility: { writeToolsVisible: true, reason: "entitled" }, entitlementExpiresAtMs: expiresAtMs };
}

// greenhouse_user_id is `bigint`; PostgREST may render it as a number or a string depending on the
// client and column size, and the identity directory already tolerates both (parsePositiveGreenhouseUserId).
function matchesGreenhouseUserId(value: unknown, expected: number): boolean {
  if (typeof value === "number") return value === expected;
  if (typeof value === "string") return /^\d+$/.test(value) && Number.parseInt(value, 10) === expected;
  return false;
}

function parseExpiresAtMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new ActionEntitlementLookupError("Action entitlement row has a non-string expiry.");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    // Corruption, not a denial: throwing keeps it out of the cache and surfaces as a lookup
    // failure, where a silent `false` would look identical to "no grant" forever.
    throw new ActionEntitlementLookupError("Action entitlement row has an unparseable expiry.");
  }
  return parsed;
}

// The memo keys on a primitive, so the lookup key is flattened here and rebuilt in `load`. Both
// ids and the client survive the round trip; `|` cannot occur in a uuid, a decimal integer,
// or an ActionClientName, so no pair of distinct keys can collide on this join.
function lookupCacheKey(key: ActionEntitlementLookupKey): string {
  return [key.identity.identityId, String(key.identity.greenhouseUserId), key.client].join("|");
}

function parseLookupCacheKey(key: string): ActionEntitlementLookupKey {
  const [identityId, greenhouseUserId, client] = key.split("|");
  const parsedUserId = Number.parseInt(greenhouseUserId ?? "", 10);
  // lookupCacheKey is the only producer, so this is unreachable by construction — which is why it
  // throws instead of coercing. A NaN user id would otherwise reach PostgREST as
  // `greenhouse_user_id=eq.NaN`, come back empty, and read as "not entitled": an entitled recruiter
  // silently losing the write plane, with nothing anywhere to explain it.
  if (
    identityId === undefined
    || !Number.isSafeInteger(parsedUserId)
    || parsedUserId <= 0
    // The guard, not the literals it is built from. Spelling `"codex"`/`"claude_code"` here meant a
    // third ActionClientName would type-check everywhere, reach this parser, and throw at runtime on
    // a key its own producer had just written.
    || !isActionClientName(client)
  ) {
    throw new ActionEntitlementLookupError("Action entitlement cache key is malformed.");
  }
  return { identity: { identityId, greenhouseUserId: parsedUserId }, client };
}

function readCacheTtlMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_ACTION_ENTITLEMENT_CACHE_TTL_MS;
  if (raw.trim() === raw && /^\d+$/.test(raw)) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error("GREENHOUSE_ACTION_ENTITLEMENT_CACHE_TTL_MS must be a non-negative safe integer number of milliseconds.");
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
