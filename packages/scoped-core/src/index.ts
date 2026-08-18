export interface ApiResponse<T = unknown> {
  data: T;
  nextCursor: string | null;
  meta?: ApiResponseMeta;
}

export type ReadParamValue = string | number | boolean | undefined;
export type ReadParams = Record<string, ReadParamValue>;

export interface ApiRateLimitInfo {
  limit?: number;
  remaining?: number;
  resetAt?: number;
  retryAfterSeconds?: number;
  observedAt: number;
}

export interface ApiRetryInfo {
  attempts: number;
  rateLimitRetries: number;
  sleptMs: number;
  retryAfterSeconds: number[];
}

export interface ApiResponseMeta {
  rateLimit?: ApiRateLimitInfo;
  retry: ApiRetryInfo;
  cacheHits?: number;
}

export interface RawReadClient {
  read<T = unknown>(
    path: string,
    params?: ReadParams,
    cursor?: string,
    signal?: AbortSignal
  ): Promise<ApiResponse<T>>;
}

export interface GreenhouseReadClient {
  apiGet<T = unknown>(
    path: string,
    params?: ReadParams,
    signal?: AbortSignal
  ): Promise<ApiResponse<T>>;
  apiGetWithCursor?<T = unknown>(
    path: string,
    cursor: string,
    signal?: AbortSignal
  ): Promise<ApiResponse<T>>;
}

export interface ActorResolver<SessionIdentity = unknown> {
  resolveActor(sessionIdentity: SessionIdentity, signal?: AbortSignal): Promise<number> | number;
}

export type PermissionScope =
  | {
      kind: "all";
      /**
       * Jobs excluded from an otherwise org-wide scope.
       *
       * Greenhouse gives a site admin implicit access to every NON-confidential job
       * (`/v3/user_job_permissions`: "Site admins are not represented here — they have implicit
       * access to every non-confidential job"). A legacy confidential job is "restricted to users
       * explicitly granted access on the Hiring Team" (`/v3/jobs`), site admin or not. Treating
       * `all` as literally everything therefore handed out access the organization's own model
       * withholds.
       *
       * Absent or empty means unrestricted org-wide, which is the correct answer for a tenant with
       * no legacy confidential jobs — and keeps the raw, unfiltered read path exactly as it was.
       */
      excludedJobIds?: ReadonlySet<number>;
    }
  | {
      kind: "jobs";
      jobIds: ReadonlySet<number>;
      /**
       * The subset of `jobIds` the actor holds through a Greenhouse role that carries private
       * access — the built-in "Private" Job Admin role (`/v3/user_roles`, role_type `job_admin`).
       *
       * Optional and additive. Absent means "no private-capable grant known", which is exactly the
       * behaviour before this existed: every private candidate withheld. It never widens JOB scope
       * — it is always a subset of `jobIds` — it only decides whether the private candidates ON
       * those jobs are visible, which is the distinction Greenhouse itself draws.
       */
      privateCapableJobIds?: ReadonlySet<number>;
    };

export type PermissionLookupResult = ReadonlySet<number> | PermissionScope;

export type AppliedPermissionScope =
  | { kind: "operator"; permittedJobCount: null }
  | { kind: "all"; permittedJobCount: null }
  | { kind: "jobs"; permittedJobCount: number };

export interface ScopedReadRowCounts {
  raw: number | null;
  returned: number;
  /** Rows excluded because they resolved only to jobs outside the actor's scope. */
  permissionExcluded?: number;
  /** Rows whose job association could not be resolved from otherwise successful reads. */
  unresolved?: number;
  /** Honest scope-resolution completeness for this page. */
  status?: "complete" | "incomplete_scope_resolution";
}

export interface PermissionProvider {
  getPermittedJobIds(
    greenhouseUserId: number,
    signal?: AbortSignal
  ): Promise<PermissionLookupResult>;
}

export interface ScopedReadOptions {
  /**
   * Server-side operator preview target. This must be set by trusted surface
   * code, not copied from model/tool params.
   */
  actAsUser?: number;
  /** Backward-compatible alias for actAsUser. */
  actAsUserId?: number;
  /** Trusted request/deadline cancellation; never copied from model params. */
  signal?: AbortSignal;
  /**
   * Trusted audit-only observer for the permission scope actually applied by
   * this reader. The job-id set is never added to ScopedReadResult, so it
   * cannot leak through model-facing serialization.
   */
  onPermissionScopeResolved?: (
    scope: PermissionScope | { kind: "operator" }
  ) => void;
}

export type DenialCode =
  | "ACTOR_DENIED"
  | "TOOL_NOT_AVAILABLE"
  | "PERMISSION_LOOKUP_FAILED"
  | "PERMISSION_JOIN_FAILED";

export interface ScopedReadDenial {
  ok: false;
  toolName: string;
  actorId?: number;
  effectiveActorId?: number;
  denial: {
    code: DenialCode;
    message: string;
  };
}

export interface ScopedReadSuccess<T = unknown> {
  ok: true;
  toolName: string;
  actorId: number;
  effectiveActorId: number;
  scoped: boolean;
  permissionScope: AppliedPermissionScope;
  rowCounts: ScopedReadRowCounts;
  data: T;
  nextCursor: string | null;
  meta?: ApiResponseMeta;
}

export type ScopedReadResult<T = unknown> =
  | ScopedReadSuccess<T>
  | ScopedReadDenial;

interface ScopeContext {
  rawReader: RawReadClient;
  /**
   * The reader for reads whose ANSWER IS AN AUTHORIZATION DECISION rather than data — today, the
   * candidate `private` flag. In production this is the uncached client, because the data cache
   * would otherwise add a second, unaccounted staleness layer on top of the permission TTL to an
   * input that decides whether a row is withheld. `createProductionScopedReader` states that rule
   * for permission and site-admin reads and then routed the privacy lookup through the cache
   * anyway; this field is what makes the rule hold for all three.
   *
   * Not a claim that every privacy answer is uncached. A `/candidates` row carries `private` in its
   * default field set, so a directly-read candidate is gated on the flag inside the snapshot it was
   * read in — which is consistent rather than stale: name, email and flag are all as of the same
   * moment. This reader covers the JOIN cases, where a fresh row would otherwise be gated by a
   * privacy verdict fetched up to a full cache TTL earlier.
   */
  authorizationReader: RawReadClient;
  signal?: AbortSignal;
  permittedJobIds: ReadonlySet<number>;
  // The subset of permittedJobIds the actor holds through Greenhouse's built-in "Private" Job Admin
  // role. A private candidate is visible on those jobs and nowhere else — always a subset, so this
  // can only decide privacy, never widen job scope.
  privateCapableJobIds: ReadonlySet<number>;
  applicationTerminal: ScopeTerminal;
  applicationCache: Map<number, Promise<Record<string, unknown> | null>>;
  candidateApplicationsCache: Map<number, Promise<Record<string, unknown>[]>>;
  // Parent-record caches for the interview_id/scorecard_id join hops used by interviewer and
  // scorecard-question-answer scoping. Keyed by record id, deduped per scopedRead like the others.
  interviewCache: Map<number, Promise<Record<string, unknown> | null>>;
  scorecardCache: Map<number, Promise<Record<string, unknown> | null>>;
  policyParentCache: Map<string, Promise<PolicyParentRead>>;
  // Greenhouse restricts a candidate flagged `private` to holders of the "View Private Candidates"
  // permission. Job permission alone does NOT grant it, and these reads run under an org-wide
  // service credential, so Greenhouse's own gate never fires — this layer is the only enforcer.
  // Keyed by candidate id, deduped per scopedRead like the other parent caches.
  candidatePrivacyCache: Map<number, Promise<boolean>>;
}

export type ScopeRowOutcome =
  | "permitted"
  | "not_permitted"
  | "missing_parent"
  | "parent_read_failed";

export interface ScopeJoinDependency {
  field: string;
  sourceFilter: string;
  targetEndpoint: string;
  targetField: string;
  targetFilter: string;
  /** Executable authorization dependency; non-scope joins never enter this policy graph. */
  purpose: "scope";
}

export interface ScopeTerminal {
  field: string;
  filter: string;
  multiple?: boolean;
  /** Explicit compatibility for an observed singular relationship shape. */
  compatibility?: {
    kind: "single_nested_id";
    field: string;
    idField: string;
  };
}

const DEFAULT_APPLICATION_TERMINAL: ScopeTerminal = {
  field: "job_id",
  filter: "job_ids",
};

// `/v3/applications` documents a hard ceiling of 50 ids per `ids` request; `/v3/candidates` documents
// no ceiling, so it inherits the same conservative chunk rather than assuming a larger one.
const PARENT_BATCH_SIZE = 50;

export type ExecutableScopePolicy =
  | {
      kind: "direct";
      terminal: ScopeTerminal;
      redactToPermittedJobIds?: boolean;
    }
  | {
      kind: "join_backed";
      dependencies: readonly ScopeJoinDependency[];
      terminal: ScopeTerminal;
      /** Preserve endpoint row-level privacy semantics before resolving parent scope. */
      rowVisibility?: "public_only";
    };

interface RowScopeDecision {
  outcome: ScopeRowOutcome;
  row: Record<string, unknown> | null;
  /**
   * This row was withheld by the private-candidate gate rather than by job scope. Counted separately
   * because a point get's row counts must not confirm that a specific PERSON exists — see the
   * existence-suppression comment in `scopedRead`. Job scope needs no such treatment: telling a
   * recruiter a req they cannot see holds rows discloses nothing about anyone.
   *
   * A new privacy withhold that forgets this tag loses the suppression, never the gate — it fails
   * toward over-disclosure of existence, not over-disclosure of data.
   */
  privacy?: true;
}

type RowFilter = (
  row: Record<string, unknown>,
  context: ScopeContext
) => Promise<RowScopeDecision>;

interface ScopeOutcomeCounts {
  permitted: number;
  notPermitted: number;
  missingParent: number;
  parentReadFailed: number;
  /** A later parent page failed after at least one safe page was retained. */
  incomplete?: boolean;
  /** Of `notPermitted`, how many the private-candidate gate withheld. See RowScopeDecision.privacy. */
  privacyWithheld?: number;
}

interface PolicyParentRead {
  rows: Record<string, unknown>[];
  incomplete: boolean;
}

interface FilterResult {
  response: ApiResponse;
  outcomes: ScopeOutcomeCounts;
}

interface ToolRegistration {
  execute(
    rawReader: RawReadClient,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<ApiResponse>;
  filter(response: ApiResponse, context: ScopeContext): Promise<FilterResult>;
  requiresScopePolicy?: boolean;
}

export interface ScopedGreenhouseConfig<SessionIdentity = unknown> {
  actorResolver: ActorResolver<SessionIdentity>;
  permissionProvider: PermissionProvider;
  rawReader: RawReadClient;
  /**
   * Reader for authorization-deciding reads (the candidate `private` flag). Defaults to `rawReader`,
   * which is right for every caller that passes an uncached client. Production passes the UNCACHED
   * reader here while `rawReader` is the cached one — see ScopeContext.authorizationReader.
   */
  authorizationReader?: RawReadClient;
  operatorActorIds?: ReadonlySet<number>;
  filterRegistry?: ReadonlyMap<string, ToolRegistration>;
  scopePolicyRegistry?: ReadonlyMap<string, ExecutableScopePolicy>;
}

export const DEFAULT_OPERATOR_ACTOR_IDS_ENV = "OPERATOR_ACTOR_IDS";

const IDENTITY_PARAM_NAMES = new Set([
  "actor_id",
  "actAsUser",
  "actAsUserId",
  "act_as_user",
  "act_as_user_id",
  "on_behalf_of_user_id",
  "user_id",
  "userId",
  "greenhouse_user_id",
  "greenhouseUserId",
  "greenhouseUserID",
  "email",
  "work_email",
  "workEmail",
  "user_email",
  "userEmail",
  "recruiter_email",
  "recruiterEmail",
  "authenticated_email",
  "authenticatedEmail",
  "subject",
  "session_subject",
  "sessionSubject",
  "sub",
]);

const NORMALIZED_IDENTITY_PARAM_NAMES = new Set([
  "actorid",
  "actasuser",
  "actasuserid",
  "onbehalfofuserid",
  "greenhouseactorid",
  "greenhouseuserid",
  "effectiveactorid",
  "effectivegreenhouseuserid",
]);

export function parseActorIdAllowlist(raw: string | undefined): Set<number> {
  if (!raw) {
    return new Set<number>();
  }

  const ids = new Set<number>();
  for (const token of raw.split(",")) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      ids.add(parsed);
    }
  }
  return ids;
}

export function createOperatorActorIds(
  env: NodeJS.ProcessEnv = process.env
): Set<number> {
  return parseActorIdAllowlist(env[DEFAULT_OPERATOR_ACTOR_IDS_ENV]);
}

export function createGreenhouseRawReader(
  client: GreenhouseReadClient
): RawReadClient {
  return {
    async read<T = unknown>(
      path: string,
      params: ReadParams = {},
      cursor?: string,
      signal?: AbortSignal
    ): Promise<ApiResponse<T>> {
      signal?.throwIfAborted();
      if (cursor) {
        if (!client.apiGetWithCursor) {
          throw new Error(
            "Greenhouse raw reader cannot follow cursors because apiGetWithCursor was not supplied."
          );
        }
        const definedParams = Object.entries(params).filter(
          ([, value]) => value !== undefined && value !== ""
        );
        if (definedParams.length > 0) {
          throw new Error(
            "Cannot combine cursor with other parameters when reading Greenhouse."
          );
        }
        return client.apiGetWithCursor<T>(path, cursor, signal);
      }
      return client.apiGet<T>(path, params, signal);
    },
  };
}

export interface HarvestPermissionProviderOptions {
  rawReader: RawReadClient;
  ttlMs?: number;
  perPage?: number;
  now?: () => number;
}

export function createHarvestPermissionProvider(
  options: HarvestPermissionProviderOptions
): PermissionProvider & { clearCache: () => void } {
  const ttlMs = options.ttlMs ?? 0;
  const perPage = options.perPage ?? 500;
  const now = options.now ?? (() => Date.now());
  const cache = new Map<number, { expiresAt: number; scope: PermissionScope }>();

  async function fetchPermissionScope(
    greenhouseUserId: number,
    signal?: AbortSignal
  ): Promise<PermissionScope> {
    const permitted = new Set<number>();
    // job id -> the role ids the actor holds on it, so private capability can be decided after the
    // role dictionary is read rather than requiring a second sweep of the grants.
    const roleIdsByJob = new Map<number, Set<number>>();
    let cursor: string | null = null;

    do {
      signal?.throwIfAborted();
      const page: ApiResponse<unknown[]> = await options.rawReader.read<unknown[]>(
        "/user_job_permissions",
        cursor
          ? {}
          : {
              user_ids: String(greenhouseUserId),
              per_page: perPage,
            },
        cursor ?? undefined,
        signal
      );
      const rows = Array.isArray(page.data) ? page.data : [];
      for (const row of rows) {
        if (!isRecord(row)) continue;
        const rowUserId = extractUserId(row);
        if (rowUserId !== null && rowUserId !== greenhouseUserId) {
          continue;
        }
        if (rowGrantsAllJobAccess(row)) {
          return { kind: "all" };
        }
        const jobIds = extractJobIds(row);
        const roleId = readPositiveInteger(row.role_id);
        for (const jobId of jobIds) {
          permitted.add(jobId);
          if (roleId === null) continue;
          const roles = roleIdsByJob.get(jobId) ?? new Set<number>();
          roles.add(roleId);
          roleIdsByJob.set(jobId, roles);
        }
      }
      cursor = page.nextCursor;
    } while (cursor);

    const privateCapableJobIds = await resolvePrivateCapableJobIds(roleIdsByJob, signal);
    return privateCapableJobIds.size > 0
      ? { kind: "jobs", jobIds: permitted, privateCapableJobIds }
      : { kind: "jobs", jobIds: permitted };
  }

  /**
   * Decide which of the actor's permitted jobs they hold through a private-capable role.
   *
   * `/v3/user_job_permissions` rows carry `role_id`; `/v3/user_roles` is the org-wide dictionary
   * those ids point into, and it ships a built-in `Private` Job Admin role. A recruiter the org
   * granted "Job Admin: Private" on a job is entitled by Greenhouse to that job's private
   * candidates, and withholding them here denied access the organization had already granted.
   *
   * Only the documented built-in name is honoured. Customers may configure additional `job_admin`
   * roles, and nothing in the API says whether an arbitrary custom role carries private access —
   * inferring that it does would grant access the org's own model may deny, which is the one line
   * this layer never crosses. A custom private-equivalent role therefore needs an explicit
   * classification, not a guess.
   *
   * Fails SOFT: if the dictionary cannot be read, no job is treated as private-capable and every
   * private candidate stays withheld, exactly as before. A role lookup that fails must never widen.
   */
  async function resolvePrivateCapableJobIds(
    roleIdsByJob: ReadonlyMap<number, Set<number>>,
    signal?: AbortSignal
  ): Promise<ReadonlySet<number>> {
    const privateCapable = new Set<number>();
    if (roleIdsByJob.size === 0) return privateCapable;

    let privateRoleIds: ReadonlySet<number>;
    try {
      privateRoleIds = await loadPrivateCapableRoleIds(signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      return privateCapable;
    }
    if (privateRoleIds.size === 0) return privateCapable;

    for (const [jobId, roleIds] of roleIdsByJob) {
      for (const roleId of roleIds) {
        if (privateRoleIds.has(roleId)) {
          privateCapable.add(jobId);
          break;
        }
      }
    }
    return privateCapable;
  }

  // The role dictionary is org-wide and changes about as often as the org's permission model, so it
  // is read once per provider rather than once per actor.
  //
  // The RESOLVED VALUE is cached, never the in-flight promise. Sharing the promise would hand one
  // request's AbortError to every other request waiting on it: the waiter would see an error, find
  // its own signal un-aborted, and fall through to the fail-soft empty set — silently losing
  // private-candidate admission for a request nobody cancelled. Two cold requests racing may each
  // read the dictionary once, which is a bounded and rare cost for a read this size, and the far
  // cheaper mistake of the two.
  let privateCapableRoleIds: ReadonlySet<number> | null = null;

  async function loadPrivateCapableRoleIds(signal?: AbortSignal): Promise<ReadonlySet<number>> {
    if (privateCapableRoleIds) return privateCapableRoleIds;
    const ids = new Set<number>();
    let cursor: string | null = null;
    do {
      signal?.throwIfAborted();
      const page: ApiResponse<unknown[]> = await options.rawReader.read<unknown[]>(
        "/user_roles",
        cursor ? {} : { per_page: perPage },
        cursor ?? undefined,
        signal
      );
      for (const row of Array.isArray(page.data) ? page.data : []) {
        if (!isRecord(row)) continue;
        const id = readPositiveInteger(row.id);
        if (id !== null && isPrivateCapableRole(row)) ids.add(id);
      }
      cursor = page.nextCursor;
    } while (cursor);
    // Only a completed read is cached, so a failure or an abort leaves the next caller free to try
    // again rather than inheriting a permanently empty dictionary.
    privateCapableRoleIds = ids;
    return ids;
  }

  return {
    async getPermittedJobIds(
      greenhouseUserId: number,
      signal?: AbortSignal
    ): Promise<PermissionLookupResult> {
      signal?.throwIfAborted();
      if (ttlMs > 0) {
        const cached = cache.get(greenhouseUserId);
        if (cached && cached.expiresAt > now()) {
          return clonePermissionLookupResult(cached.scope);
        }
      }

      const scope = await fetchPermissionScope(greenhouseUserId, signal);
      if (ttlMs > 0) {
        cache.set(greenhouseUserId, {
          expiresAt: now() + ttlMs,
          scope: clonePermissionScope(scope),
        });
      }
      return clonePermissionLookupResult(scope);
    },
    clearCache(): void {
      cache.clear();
    },
  };
}

export function createScopedGreenhouseReader<SessionIdentity = unknown>(
  config: ScopedGreenhouseConfig<SessionIdentity>
): {
  scopedRead: (
    sessionIdentity: SessionIdentity,
    toolName: string,
    params?: Record<string, unknown>,
    options?: ScopedReadOptions
  ) => Promise<ScopedReadResult>;
} {
  const operatorActorIds = config.operatorActorIds ?? new Set<number>();
  const registry = config.filterRegistry ?? DEFAULT_FILTER_REGISTRY;
  const scopePolicies = config.scopePolicyRegistry ?? new Map<string, ExecutableScopePolicy>();
  const applicationPolicy = scopePolicies.get("list_applications");
  const applicationTerminal = applicationPolicy?.kind === "direct"
    ? applicationPolicy.terminal
    : DEFAULT_APPLICATION_TERMINAL;

  async function resolveActor(
    sessionIdentity: SessionIdentity,
    signal?: AbortSignal
  ): Promise<number> {
    signal?.throwIfAborted();
    const actorId = await config.actorResolver.resolveActor(sessionIdentity, signal);
    signal?.throwIfAborted();
    if (!Number.isInteger(actorId) || actorId <= 0) {
      throw new Error("ActorResolver returned an invalid Greenhouse user id.");
    }
    return actorId;
  }

  return {
    async scopedRead(
      sessionIdentity,
      toolName,
      params: Record<string, unknown> = {},
      options: ScopedReadOptions = {}
    ): Promise<ScopedReadResult> {
      const signal = options.signal;
      const actorId = await resolveActor(sessionIdentity, signal);
      const isOperator = operatorActorIds.has(actorId);
      const actAsUserId = options.actAsUser ?? options.actAsUserId;

      if (actAsUserId !== undefined) {
        if (!isOperator) {
          return deny(toolName, "ACTOR_DENIED", actorId, undefined);
        }
        if (!Number.isInteger(actAsUserId) || actAsUserId <= 0) {
          return deny(toolName, "ACTOR_DENIED", actorId, undefined);
        }
      }

      const registration = registry.get(toolName);
      if (!registration) {
        return deny(toolName, "TOOL_NOT_AVAILABLE", actorId, actAsUserId);
      }
      const scopePolicy = scopePolicies.get(toolName);
      if (registration.requiresScopePolicy && !scopePolicy) {
        return deny(toolName, "TOOL_NOT_AVAILABLE", actorId, actAsUserId);
      }

      const safeParams = sanitizeReadParams(params);

      if (isOperator && actAsUserId === undefined) {
        options.onPermissionScopeResolved?.({ kind: "operator" });
        signal?.throwIfAborted();
        const response = await registration.execute(config.rawReader, safeParams, signal);
        const rowCounts = unscopedRowCounts(response.data);
        return {
          ok: true,
          toolName,
          actorId,
          effectiveActorId: actorId,
          scoped: false,
          permissionScope: { kind: "operator", permittedJobCount: null },
          rowCounts,
          data: response.data,
          nextCursor: response.nextCursor,
          meta: response.meta,
        };
      }

      const effectiveActorId = actAsUserId ?? actorId;
      let permissionScope: PermissionScope;
      try {
        permissionScope = normalizePermissionScope(
          await config.permissionProvider.getPermittedJobIds(effectiveActorId, signal)
        );
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        return deny(
          toolName,
          "PERMISSION_LOOKUP_FAILED",
          actorId,
          effectiveActorId,
          permissionLookupFailureMessage(error)
        );
      }

      options.onPermissionScopeResolved?.(
        permissionScope.kind === "jobs"
          ? { kind: "jobs", jobIds: new Set(permissionScope.jobIds) }
          : { kind: "all" }
      );

      signal?.throwIfAborted();
      const response = await registration.execute(config.rawReader, safeParams, signal);
      // An org-wide scope with nothing excluded stays a raw, unfiltered read — the fast path, and
      // the correct answer for a tenant with no legacy confidential jobs. With exclusions, the same
      // row filtering everyone else gets runs, over a "permitted" set that is everything BUT them.
      if (permissionScope.kind === "all" && !(permissionScope.excludedJobIds?.size)) {
        const rowCounts = unscopedRowCounts(response.data);
        return {
          ok: true,
          toolName,
          actorId,
          effectiveActorId,
          scoped: false,
          permissionScope: { kind: "all", permittedJobCount: null },
          rowCounts,
          data: response.data,
          nextCursor: response.nextCursor,
          meta: response.meta,
        };
      }

      const context: ScopeContext = {
        rawReader: config.rawReader,
        authorizationReader: config.authorizationReader ?? config.rawReader,
        signal,
        permittedJobIds: permissionScope.kind === "all"
          ? everyJobExcept(permissionScope.excludedJobIds ?? new Set<number>())
          : permissionScope.jobIds,
        // A site admin holds Greenhouse's private-candidate access implicitly, so on the jobs they
        // can still see, private candidates remain visible exactly as they were.
        privateCapableJobIds: permissionScope.kind === "all"
          ? everyJobExcept(permissionScope.excludedJobIds ?? new Set<number>())
          : permissionScope.privateCapableJobIds ?? new Set<number>(),
        applicationTerminal,
        applicationCache: new Map(),
        candidateApplicationsCache: new Map(),
        interviewCache: new Map(),
        scorecardCache: new Map(),
        policyParentCache: new Map(),
        candidatePrivacyCache: new Map(),
      };
      let filtered: FilterResult;
      try {
        filtered = scopePolicy
          ? await filterWithScopePolicy(response, context, scopePolicy)
          : await registration.filter(response, context);
        // "View Private Candidates" backstop, applied AFTER the scope fork so a policy-driven tool
        // (which never runs its row filter) is gated too. Idempotent for tools whose row filter
        // already gated — the privacy answer is cached, so a second check withholds nothing new.
        filtered = await applyCandidatePrivacyGate(toolName, filtered, context);
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error instanceof PermissionJoinError) {
          return deny(
            toolName,
            "PERMISSION_JOIN_FAILED",
            actorId,
            effectiveActorId,
            "Scoped Greenhouse read denied: a required permission join could not be completed."
          );
        }
        throw error;
      }
      const scopedResponse = filtered.response;
      // A single-row read the PRIVACY gate emptied reports exactly what a nonexistent id reports.
      // Both return null data, so the counts are all that is left to tell them apart, and telling
      // them apart confirms that a specific person exists and carries the restricted flag — the
      // disclosure the gate exists to prevent (NIST SP 800-188 §3.2.1: moving an estimate from
      // "might be present" to "is present" is disclosure without ever returning the record).
      //
      // Three deliberate boundaries. JOB SCOPE is untouched: a point get withheld because the req
      // isn't the actor's still reports its counts, because "that candidate is not on one of your
      // reqs" is a true and useful answer and it discloses nothing about the person. LIST reads keep
      // their counts in full, where the number is an aggregate and is how the model tells "you have
      // no data" from "data was withheld from you". And an unresolved or unreadable parent stays
      // loud — that is a reliability signal, not an existence one.
      //
      // This runs after the scope fork, so both engines are covered by one check; the per-site
      // `privacy` tag only decides whether suppression applies, never whether the row is withheld.
      const suppressExistence =
        isRecord(response.data) &&
        (filtered.outcomes.privacyWithheld ?? 0) > 0 &&
        filtered.outcomes.missingParent === 0 &&
        filtered.outcomes.parentReadFailed === 0;
      const rowCounts = {
        raw: suppressExistence ? 0 : countRows(response.data),
        returned: countReturnedRows(scopedResponse.data),
        permissionExcluded: suppressExistence ? 0 : filtered.outcomes.notPermitted,
        unresolved: filtered.outcomes.missingParent + filtered.outcomes.parentReadFailed,
        status: filtered.outcomes.missingParent > 0 || filtered.outcomes.parentReadFailed > 0 || filtered.outcomes.incomplete
          ? "incomplete_scope_resolution" as const
          : "complete" as const,
      };
      return {
        ok: true,
        toolName,
        actorId,
        effectiveActorId,
        scoped: true,
        // An org-wide actor stays reported as org-wide even when confidential jobs were withheld:
        // the audit trail should say what the scope WAS, and "all, minus what Greenhouse itself
        // restricts" is still all. There is no finite permitted count to report for it.
        permissionScope: permissionScope.kind === "all"
          ? { kind: "all", permittedJobCount: null }
          : { kind: "jobs", permittedJobCount: permissionScope.jobIds.size },
        rowCounts,
        data: scopedResponse.data,
        nextCursor: scopedResponse.nextCursor,
        meta: scopedResponse.meta,
      };
    },
  };
}

function unscopedRowCounts(data: unknown): ScopedReadRowCounts {
  const returned = countReturnedRows(data);
  return {
    raw: countRows(data),
    returned,
    permissionExcluded: 0,
    unresolved: 0,
    status: "complete",
  };
}

function countRows(data: unknown): number | null {
  if (Array.isArray(data)) return data.length;
  if (isRecord(data)) return 1;
  if (data === null || data === undefined) return 0;
  return null;
}

function countReturnedRows(data: unknown): number {
  if (Array.isArray(data)) return data.length;
  return isRecord(data) ? 1 : 0;
}

class PermissionJoinError extends Error {
  constructor(path: string, options?: unknown) {
    super(`Permission join failed while reading ${path}.`, { cause: options });
    this.name = "PermissionJoinError";
  }
}

function permitted(row: Record<string, unknown>): RowScopeDecision {
  return { outcome: "permitted", row };
}

function notPermitted(): RowScopeDecision {
  return { outcome: "not_permitted", row: null };
}

/** Withheld by the private-candidate gate. Identical denial, separately counted — see RowScopeDecision.privacy. */
function withheldForPrivacy(): RowScopeDecision {
  return { outcome: "not_permitted", row: null, privacy: true };
}

function missingParent(): RowScopeDecision {
  return { outcome: "missing_parent", row: null };
}

function parentReadFailed(): RowScopeDecision {
  return { outcome: "parent_read_failed", row: null };
}

function emptyScopeOutcomeCounts(): ScopeOutcomeCounts {
  return { permitted: 0, notPermitted: 0, missingParent: 0, parentReadFailed: 0 };
}

function addDecision(counts: ScopeOutcomeCounts, decision: RowScopeDecision): void {
  if (decision.outcome === "permitted") counts.permitted += 1;
  else if (decision.outcome === "not_permitted") {
    counts.notPermitted += 1;
    if (decision.privacy) counts.privacyWithheld = (counts.privacyWithheld ?? 0) + 1;
  }
  else if (decision.outcome === "missing_parent") counts.missingParent += 1;
  else counts.parentReadFailed += 1;
}

function countDecision(decision: RowScopeDecision): ScopeOutcomeCounts {
  const counts = emptyScopeOutcomeCounts();
  addDecision(counts, decision);
  return counts;
}

function intersects(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

/**
 * Tools whose EVERY row is candidate substance AND carries a candidate id or an application id on
 * the row itself, so the universal gate can resolve the candidate directly.
 *
 * A row from one of these that resolves to no candidate is DENIED: "no candidate id on a row that
 * must have one" is a shape violation, never a licence to leak. The set is deliberately confined to
 * rows the gate can resolve in one hop —
 * `list_scorecard_question_answers` carries only `scorecard_id` and is gated by its row filter
 * (which hops scorecard → application → the privacy check), never here, because a top-level
 * candidate lookup on it would resolve nothing and over-withhold every row. `list_interviews` /
 * `list_interviewers` are absent for the opposite reason: they legitimately return job-level rows
 * belonging to no candidate, gated per-row on their application branch only.
 */
export const CANDIDATE_SUBSTANCE_TOOLS: ReadonlySet<string> = new Set([
  "list_applications",
  "get_application",
  "list_application_stages",
  "list_scorecards",
  "list_rejection_details",
  "list_prospect_details",
  "list_offers",
]);

/**
 * Enforce "View Private Candidates" on whatever survived scoping, whichever engine did the scoping.
 *
 * This exists because there are TWO scope engines: a tool with an entry in the scope-policy
 * registry takes `filterWithScopePolicy` and never runs its row filter at all (see the fork in
 * `scopedRead`). `list_applications`, `get_application` and `list_application_stages` are all
 * policy-driven in production, so a gate written only into the row filters would silently not run
 * on the three highest-traffic readers of candidate substance. Rather than copy the rule into both
 * engines — which is how the gap arose in the first place — it is applied once, after the fork, to
 * the rows either engine kept.
 *
 * The row filters keep their own gates: those give per-row accounting and deny before a row is ever
 * assembled. This pass is the backstop that makes bypass structurally impossible, and it is free
 * when they have already run, because every privacy answer is cached per scoped read.
 */
async function applyCandidatePrivacyGate(
  toolName: string,
  filtered: FilterResult,
  context: ScopeContext
): Promise<FilterResult> {
  const sourceWasArray = Array.isArray(filtered.response.data);
  const rows: Record<string, unknown>[] = sourceWasArray
    ? (filtered.response.data as unknown[]).filter(isRecord)
    : isRecord(filtered.response.data)
      ? [filtered.response.data]
      : [];
  if (rows.length === 0) return filtered;

  const mustResolveCandidate = CANDIDATE_SUBSTANCE_TOOLS.has(toolName);
  // Two bounded batches, in order: the applications the kept rows hang off (so a row that names no
  // candidate directly can still reach one), then the candidates themselves. Both are no-ops for
  // ids already cached, which is the common case — the row filters and the scope-policy join have
  // usually loaded them already.
  await primeApplicationsForRows(rows, context);
  await prefetchScopeParents(rows, context);
  await prefetchCandidatesBehindApplications(rows, context);

  const kept: Record<string, unknown>[] = [];
  let withheld = 0;
  for (const row of rows) {
    // A join failure here withholds THIS row, not the page. Letting a PermissionJoinError out would
    // turn one unreadable application into a denial of every row beside it — an over-withhold, and
    // an unnecessary one: the row it could not resolve is dropped either way. An abort still
    // propagates, because that is the caller giving up rather than a scoping failure.
    let verdict: "keep" | "withhold";
    try {
      const candidateId = await resolveRowCandidateId(row, context);
      if (candidateId === null) {
        // Not candidate substance at all (a job, an opening, a dictionary row) — nothing to gate,
        // unless this is a tool whose every row must resolve to a candidate.
        verdict = mustResolveCandidate ? "withhold" : "keep";
      } else if (!(await loadCandidateIsPrivate(context, candidateId))) {
        verdict = "keep";
      } else {
        // Private — kept only where Greenhouse itself grants this actor private access.
        verdict = (await actorHoldsPrivateAccessToRow(row, context)) ? "keep" : "withhold";
      }
    } catch (error) {
      if (context.signal?.aborted) throw context.signal.reason;
      // Defence in depth, and deliberately narrower than the row filters. No tool reaches this
      // today — every parent this gate needs has already been loaded by the scope pass that ran
      // before it — but if one ever does, a single unreadable parent should withhold ITS row rather
      // than escape as a PermissionJoinError and deny every row beside it. The row is dropped
      // either way, so this can only ever reduce an over-withhold, never widen access. (The row
      // filters keep their existing whole-read denial on a failed join; that is pre-existing
      // behaviour and not something this change quietly alters.)
      verdict = "withhold";
    }
    if (verdict === "withhold") {
      withheld += 1;
      continue;
    }
    kept.push(row);
  }

  if (withheld === 0) return filtered;

  return {
    response: {
      ...filtered.response,
      data: sourceWasArray ? kept : (kept[0] ?? null),
    },
    outcomes: {
      ...filtered.outcomes,
      permitted: Math.max(0, filtered.outcomes.permitted - withheld),
      notPermitted: filtered.outcomes.notPermitted + withheld,
      privacyWithheld: (filtered.outcomes.privacyWithheld ?? 0) + withheld,
    },
  };
}

/**
 * Does the actor hold Greenhouse's private-candidate access on the job THIS row belongs to?
 *
 * Greenhouse grants private-candidate visibility per job, through the "Private" Job Admin role, so
 * the question is never "may this actor see private candidates" in the abstract — it is always
 * about the job the row sits on. Resolved the same way scope already resolves it: the row's own
 * job, then the job of the application it hangs off, then (for a candidate-shaped row) the jobs of
 * the candidate's applications.
 *
 * Returns false when no job can be established. An unresolvable job is not a private-access grant.
 */
async function actorHoldsPrivateAccessToRow(
  row: Record<string, unknown>,
  context: ScopeContext
): Promise<boolean> {
  if (context.privateCapableJobIds.size === 0) return false;

  // Resolved through rowOwnJob — the SAME terminal resolver scope uses — so a row shape scope
  // honours can never be one this gate misses. `unresolved` denies rather than falling through: a
  // row carrying a job field it cannot resolve is not a row with no job.
  const ownJob = rowOwnJob(row, context.applicationTerminal);
  if (ownJob.state === "resolved") return context.privateCapableJobIds.has(ownJob.jobId);
  if (ownJob.state === "unresolved") return false;

  const applicationId = readPositiveInteger(row.application_id);
  if (applicationId !== null) {
    const application = await loadApplication(context, applicationId);
    if (!application) return false;
    const jobId = applicationJobId(application, context.applicationTerminal);
    return jobId !== null && context.privateCapableJobIds.has(jobId);
  }

  // A candidate-shaped row spans every application the candidate has. It is admitted when any of
  // them sits on a private-capable job — the same "some permitted application" rule that decides
  // the row's job scope in the first place, so the two can never disagree.
  const embedded = readRecordArray(row.applications);
  if (embedded) {
    return embedded.some((application) => {
      const jobId = applicationJobId(application, context.applicationTerminal);
      return jobId !== null && context.privateCapableJobIds.has(jobId);
    });
  }

  const candidateId = extractAssociatedCandidateId(row) ?? extractCandidateId(row);
  if (candidateId === null) return false;
  const applications = await loadCandidateApplications(context, candidateId);
  return applications.some((application) => {
    const jobId = applicationJobId(application, context.applicationTerminal);
    return jobId !== null && context.privateCapableJobIds.has(jobId);
  });
}

function isApplicationsEndpoint(endpoint: string): boolean {
  return endpoint.replace(/^\/v3(?=\/)/, "") === "/applications";
}

/**
 * Load, in 50-id batches, the applications the kept rows hang off but that nothing has cached yet.
 *
 * Without this the gate would fall back to `loadApplication` per row — one round trip each — which
 * on a full page is precisely the sequential-join latency the batching elsewhere exists to avoid.
 * Best-effort by the same rule as the other primers: on failure it seeds nothing and the per-row
 * loader raises its own PermissionJoinError.
 */
async function primeApplicationsForRows(
  rows: readonly Record<string, unknown>[],
  context: ScopeContext
): Promise<void> {
  const applicationIds = new Set<number>();
  for (const row of rows) {
    if (extractAssociatedCandidateId(row) !== null) continue;
    const applicationId = readPositiveInteger(row.application_id);
    if (applicationId !== null && !context.applicationCache.has(applicationId)) {
      applicationIds.add(applicationId);
    }
  }
  if (applicationIds.size === 0) return;

  const pages = await mapWithConcurrency(chunks([...applicationIds], PARENT_BATCH_SIZE), async (ids) => {
    try {
      const response = await context.rawReader.read<unknown[]>(
        "/applications",
        { ids: ids.join(","), per_page: 100 },
        undefined,
        context.signal
      );
      return Array.isArray(response.data) ? response.data.filter(isRecord) : [];
    } catch (error) {
      if (context.signal?.aborted) throw context.signal.reason;
      return null;
    }
  });

  for (const page of pages) {
    if (page === null) continue;
    for (const application of page) {
      const id = readPositiveInteger(application.id);
      if (id === null || context.applicationCache.has(id)) continue;
      context.applicationCache.set(id, Promise.resolve(application));
    }
  }
}

/**
 * Batch the privacy lookup for candidates reachable only THROUGH an application.
 *
 * Runs after the applications are cached, so it reads each row's candidate id out of the cache
 * without a round trip and hands the whole set to one batched privacy read.
 */
async function prefetchCandidatesBehindApplications(
  rows: readonly Record<string, unknown>[],
  context: ScopeContext
): Promise<void> {
  const carriers: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (extractAssociatedCandidateId(row) !== null) continue;
    const applicationId = readPositiveInteger(row.application_id);
    if (applicationId === null) continue;
    const application = await context.applicationCache.get(applicationId);
    if (application) carriers.push(application);
  }
  if (carriers.length > 0) await prefetchScopeParents(carriers, context);
}

/**
 * Reach the candidate behind a kept row: named on the row, or on the application it hangs off.
 *
 * Returns null when the row belongs to no candidate. The application hop reads through the cache
 * the primers above have filled, so it costs no extra round trip on the common path.
 */
async function resolveRowCandidateId(
  row: Record<string, unknown>,
  context: ScopeContext
): Promise<number | null> {
  const direct = extractAssociatedCandidateId(row);
  if (direct !== null) return direct;

  const applicationId = readPositiveInteger(row.application_id);
  if (applicationId === null) return null;
  const application = await loadApplication(context, applicationId);
  return application ? extractAssociatedCandidateId(application) : null;
}

async function filterWithScopePolicy(
  response: ApiResponse,
  context: ScopeContext,
  policy: ExecutableScopePolicy
): Promise<FilterResult> {
  const rows: Record<string, unknown>[] = Array.isArray(response.data)
    ? response.data.filter(isRecord)
    : isRecord(response.data)
      ? [response.data]
      : [];
  const sourceWasArray = Array.isArray(response.data);
  let decisions: RowScopeDecision[];
  let incomplete = false;
  if (policy.kind === "direct") {
    decisions = rows.map((row) => applyDirectScopePolicy(row, context, policy));
  } else {
    const joined = await applyJoinBackedScopePolicy(rows, context, policy);
    decisions = joined.decisions;
    incomplete = joined.incomplete;
  }
  const outcomes = emptyScopeOutcomeCounts();
  outcomes.incomplete = incomplete;
  if (Array.isArray(response.data)) {
    // A malformed primary row cannot be permission-resolved. Count it as unresolved instead of
    // silently dropping it, so raw/returned/excluded/unresolved accounting remains truthful.
    outcomes.missingParent = response.data.length - rows.length;
  }
  const kept: Record<string, unknown>[] = [];
  for (const decision of decisions) {
    addDecision(outcomes, decision);
    if (decision.row) kept.push(decision.row);
  }
  return {
    response: {
      ...response,
      data: sourceWasArray ? kept : (kept[0] ?? null),
    },
    outcomes,
  };
}

function applyDirectScopePolicy(
  row: Record<string, unknown>,
  context: ScopeContext,
  policy: Extract<ExecutableScopePolicy, { kind: "direct" }>
): RowScopeDecision {
  const jobIds = resolveTerminalIds(row, policy.terminal);
  if (!jobIds || jobIds.size === 0) return missingParent();
  const permittedJobIds = [...jobIds].filter((jobId) => context.permittedJobIds.has(jobId));
  if (permittedJobIds.length === 0) return notPermitted();
  if (!policy.redactToPermittedJobIds) return permitted(row);
  return permitted({ ...row, [policy.terminal.field]: permittedJobIds.sort((a, b) => a - b) });
}

async function applyJoinBackedScopePolicy(
  rows: Record<string, unknown>[],
  context: ScopeContext,
  policy: Extract<ExecutableScopePolicy, { kind: "join_backed" }>
): Promise<{ decisions: RowScopeDecision[]; incomplete: boolean }> {
  type State = {
    source: Record<string, unknown>;
    parents: Record<string, unknown>[] | null;
    parentReadFailed: boolean;
    visibilityDenied: boolean;
  };
  const states: State[] = rows.map((source) => {
    const visibilityDenied = policy.rowVisibility === "public_only" && !scorecardVisibilityAllowsScopedRead(source);
    return { source, parents: visibilityDenied ? null : [source], parentReadFailed: false, visibilityDenied };
  });
  let incomplete = false;

  for (const dependency of policy.dependencies) {
    const ids = new Set<number>();
    for (const state of states) {
      if (!state.parents) continue;
      for (const parent of state.parents) {
        for (const id of extractIds(parent[dependency.field])) ids.add(id);
      }
    }
    const loaded = await loadPolicyParents(context, dependency, [...ids]);
    const parentsById = loaded.parentsById;
    incomplete ||= loaded.incomplete;
    for (const state of states) {
      if (!state.parents) continue;
      const next: Record<string, unknown>[] = [];
      let stateReadFailed = false;
      for (const parent of state.parents) {
        for (const id of extractIds(parent[dependency.field])) {
          if (loaded.incompleteIds.has(id)) stateReadFailed = true;
          next.push(...(parentsById.get(id) ?? []));
        }
      }
      state.parentReadFailed ||= stateReadFailed;
      state.parents = next.length > 0 ? dedupeRecords(next) : null;
    }
  }

  const decisions = states.map((state) => {
    if (state.visibilityDenied) return notPermitted();
    if (!state.parents) return state.parentReadFailed ? parentReadFailed() : missingParent();
    const jobIds = new Set<number>();
    for (const parent of state.parents) {
      const terminalIds = resolveTerminalIds(parent, policy.terminal);
      if (!terminalIds) return state.parentReadFailed ? parentReadFailed() : missingParent();
      for (const id of terminalIds) jobIds.add(id);
    }
    if (jobIds.size === 0) return state.parentReadFailed ? parentReadFailed() : missingParent();
    if (intersects(jobIds, context.permittedJobIds)) return permitted(state.source);
    // Once a later parent page failed, absence/non-permission is not conclusive. Keep only rows
    // already proven permitted and classify every other row as unresolved, never as a clean exclusion.
    return state.parentReadFailed ? parentReadFailed() : notPermitted();
  });
  return { decisions, incomplete };
}

async function loadPolicyParents(
  context: ScopeContext,
  dependency: ScopeJoinDependency,
  ids: number[]
): Promise<{
  parentsById: Map<number, Record<string, unknown>[]>;
  incomplete: boolean;
  incompleteIds: ReadonlySet<number>;
}> {
  const uniqueIds = [...new Set(ids)].sort((a, b) => a - b);
  const batches = chunks(uniqueIds, 50);
  let readsByBatch: PolicyParentRead[];
  try {
    readsByBatch = await mapWithConcurrency(batches, async (batch) => {
      const key = `${dependency.targetEndpoint}|${dependency.targetFilter}|${batch.join(",")}`;
      let cached = context.policyParentCache.get(key);
      if (!cached) {
        cached = readAllPolicyParents(context.rawReader, dependency, batch, context.signal);
        context.policyParentCache.set(key, cached);
      }
      return cached;
    });
  } catch (error) {
    if (context.signal?.aborted) throw context.signal.reason;
    throw error instanceof PermissionJoinError
      ? error
      : new PermissionJoinError(dependency.targetEndpoint, error);
  }

  const parentsById = new Map<number, Record<string, unknown>[]>();
  for (const row of readsByBatch.flatMap((read) => read.rows)) {
    // A join whose target IS /applications has just loaded, in bounded batches, exactly the rows
    // the privacy gate would otherwise have to fetch one at a time to reach each row's candidate.
    // Seed the shared application cache so the gate reuses this read instead of duplicating it.
    if (isApplicationsEndpoint(dependency.targetEndpoint)) {
      const applicationId = readPositiveInteger(row.id);
      if (applicationId !== null && !context.applicationCache.has(applicationId)) {
        context.applicationCache.set(applicationId, Promise.resolve(row));
      }
    }
    for (const id of extractIds(row[dependency.targetField])) {
      const existing = parentsById.get(id) ?? [];
      existing.push(row);
      parentsById.set(id, existing);
    }
  }
  const incompleteIds = new Set<number>();
  readsByBatch.forEach((read, index) => {
    if (!read.incomplete) return;
    for (const id of batches[index] ?? []) incompleteIds.add(id);
  });
  return { parentsById, incomplete: incompleteIds.size > 0, incompleteIds };
}

async function readAllPolicyParents(
  rawReader: RawReadClient,
  dependency: ScopeJoinDependency,
  ids: number[],
  signal?: AbortSignal
): Promise<PolicyParentRead> {
  if (ids.length === 0) return { rows: [], incomplete: false };
  const path = dependency.targetEndpoint.replace(/^\/v3(?=\/)/, "");
  const rows: Record<string, unknown>[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let completedPages = 0;
  do {
    signal?.throwIfAborted();
    let page: ApiResponse<unknown[]>;
    try {
      page = await rawReader.read<unknown[]>(
        path,
        cursor ? {} : { [dependency.targetFilter]: ids.join(","), per_page: 500 },
        cursor ?? undefined,
        signal
      );
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (completedPages > 0) return { rows, incomplete: true };
      throw new PermissionJoinError(path, error);
    }
    if (!Array.isArray(page.data)) {
      if (completedPages > 0) return { rows, incomplete: true };
      throw new PermissionJoinError(path, new Error("Parent endpoint returned a non-list response."));
    }
    rows.push(...page.data.filter(isRecord));
    completedPages += 1;
    cursor = page.nextCursor;
    if (cursor) {
      if (seenCursors.has(cursor)) {
        return { rows, incomplete: true };
      }
      seenCursors.add(cursor);
    }
  } while (cursor);
  return { rows, incomplete: false };
}

function extractIds(value: unknown): Set<number> {
  const ids = new Set<number>();
  addId(ids, value);
  return ids;
}

function resolveTerminalIds(
  row: Record<string, unknown>,
  terminal: ScopeTerminal
): Set<number> | null {
  if (terminal.multiple) {
    return extractIds(row[terminal.field]);
  }

  const hasCanonical = Object.prototype.hasOwnProperty.call(row, terminal.field);
  const canonicalId = hasCanonical ? readPositiveInteger(row[terminal.field]) : null;
  if (hasCanonical && canonicalId === null) return null;

  const compatibility = terminal.compatibility;
  if (!compatibility) {
    return canonicalId === null ? null : new Set([canonicalId]);
  }

  const hasCompatibility = Object.prototype.hasOwnProperty.call(row, compatibility.field);
  let compatibilityId: number | null = null;
  if (hasCompatibility) {
    const nested = row[compatibility.field];
    if (!Array.isArray(nested) || nested.length !== 1 || !isRecord(nested[0])) return null;
    compatibilityId = readPositiveInteger(nested[0][compatibility.idField]);
    if (compatibilityId === null) return null;
  }

  if (canonicalId !== null && compatibilityId !== null && canonicalId !== compatibilityId) {
    return null;
  }
  const resolved = canonicalId ?? compatibilityId;
  return resolved === null ? null : new Set([resolved]);
}

function dedupeRecords(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...new Set(rows)];
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function mapWithConcurrency<TIn, TOut>(
  items: readonly TIn[],
  worker: (item: TIn) => Promise<TOut>,
  limit = 3
): Promise<TOut[]> {
  const results = new Array<TOut>(items.length);
  let next = 0;
  const lanes = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index]!);
      }
    }
  );
  await Promise.all(lanes);
  return results;
}

export const DEFAULT_FILTER_REGISTRY: ReadonlyMap<string, ToolRegistration> =
  new Map<string, ToolRegistration>([
    ["list_applications", listTool("/applications", filterApplicationRow)],
    ["get_application", getTool("/applications", filterApplicationRow)],
    ["list_application_stages", listTool("/application_stages", filterApplicationBackedRow)],
    ["list_candidates", listTool("/candidates", filterCandidateRow)],
    ["get_candidate", getTool("/candidates", filterCandidateRow)],
    ["list_candidate_educations", listTool("/candidate_educations", filterCandidateBackedRow)],
    ["list_candidate_employments", listTool("/candidate_employments", filterCandidateBackedRow)],
    ["list_scorecards", listTool("/scorecards", filterApplicationBackedRow)],
    ["list_notes", listTool("/notes", filterNoteOrActivityRow)],
    ["list_attachments", listTool("/attachments", filterAttachmentRow)],
    ["list_jobs", listTool("/jobs", filterJobRow)],
    ["get_job", getTool("/jobs", filterJobRow)],
    ["list_job_owners", listTool("/job_owners", filterDirectJobScopedRow)],
    ["list_openings", listTool("/openings", filterDirectJobScopedRow)],
    ["list_job_interview_stages", listTool("/job_interview_stages", filterDirectJobScopedRow)],
    ["list_job_interviews", listTool("/job_interviews", filterDirectJobScopedRow)],
    ["list_job_hiring_managers", listTool("/job_hiring_managers", filterDirectJobScopedRow)],
    ["list_job_notes", listTool("/job_notes", filterDirectJobScopedRow)],
    ["list_job_posts", listTool("/job_posts", filterDirectJobScopedRow)],
    ["list_interviews", listTool("/interviews", filterApplicationBackedOrDirectJobRow)],
    ["list_interviewers", listTool("/interviewers", filterInterviewerRow)],
    ["list_scorecard_question_answers", listTool("/scorecard_question_answers", filterScorecardBackedRow)],
    ["list_rejection_details", listTool("/rejection_details", filterApplicationBackedRow)],
    ["list_tracking_links", listTool("/tracking_links", filterDirectJobScopedRow)],
    ["list_offers", listTool("/offers", filterOfferRow)],
    ["list_users", globalReferenceListTool("/users")],
    ["get_user", globalReferenceGetTool("/users")],
    ["list_rejection_reasons", globalReferenceListTool("/rejection_reasons")],
    ["list_sources", globalReferenceListTool("/sources")],
    ["list_referrers", globalReferenceListTool("/referrers")],
    ["list_departments", globalReferenceListTool("/departments")],
    ["list_offices", globalReferenceListTool("/offices")],
    ["list_close_reasons", globalReferenceListTool("/close_reasons")],
    ["list_custom_field_options", globalReferenceListTool("/custom_field_options")],
    ["list_custom_fields", globalReferenceListTool("/custom_fields")],
    ["list_pay_inputs", globalReferenceListTool("/pay_inputs")],
    // Tier-3.4 domain exposure (audit C-DOMAINS). Scope filters are contract-grounded per row shape:
    // approval_flows + interview_kits carry job_id (direct job scoping); prospect_details carries
    // application_id (application-backed); the rest are org CONFIG dictionaries (rubric structure,
    // kit staffing, post locations, comp ranges, approval assignments, tags, pools, boards) whose
    // rows join through kit/question/post/flow ids, not job_id — exposed as global reference, never
    // falsely represented as job-filtered (the global_reference class's exact purpose).
    ["list_approval_flows", listTool("/approval_flows", filterDirectJobScopedRow)],
    ["list_interview_kits", listTool("/interview_kits", filterDirectJobScopedRow)],
    ["list_prospect_details", listTool("/prospect_details", filterApplicationBackedRow)],
    ["list_approvers", policyListTool("/approvers")],
    ["list_approver_groups", policyListTool("/approver_groups")],
    ["list_scorecard_questions", policyListTool("/scorecard_questions")],
    ["list_scorecard_question_options", policyListTool("/scorecard_question_options")],
    ["list_scorecard_question_answer_options", policyListTool("/scorecard_question_answer_options")],
    ["list_default_interviewers", policyListTool("/default_interviewers")],
    ["list_job_post_locations", policyListTool("/job_post_locations")],
    ["list_pay_input_ranges", policyListTool("/pay_input_ranges")],
    ["list_interviewer_tags", globalReferenceListTool("/interviewer_tags")],
    ["list_candidate_tags", globalReferenceListTool("/candidate_tags")],
    ["list_prospect_pools", policyListTool("/prospect_pools")],
    ["list_prospect_pool_stages", policyListTool("/prospect_pool_stages")],
    ["list_job_boards", globalReferenceListTool("/job_boards")],
    ["list_custom_field_departments", globalReferenceListTool("/custom_field_departments")],
    ["list_custom_field_offices", globalReferenceListTool("/custom_field_offices")],
  ]);

function deny(
  toolName: string,
  code: DenialCode,
  actorId?: number,
  effectiveActorId?: number,
  messageOverride?: string
): ScopedReadDenial {
  const messages: Record<DenialCode, string> = {
    ACTOR_DENIED:
      "Scoped Greenhouse read denied: actAsUser is available only to allowlisted operators.",
    TOOL_NOT_AVAILABLE:
      "Scoped Greenhouse read denied: this tool is not available on the scoped read surface.",
    PERMISSION_LOOKUP_FAILED:
      "Scoped Greenhouse read denied: permissions could not be resolved for this actor.",
    PERMISSION_JOIN_FAILED:
      "Scoped Greenhouse read denied: a required permission join could not be completed.",
  };
  return {
    ok: false,
    toolName,
    actorId,
    effectiveActorId,
    denial: {
      code,
      message: messageOverride ?? messages[code],
    },
  };
}

// Dependency-free cause hint for a permission-lookup failure (this package is standalone by design).
// A rate-limit/timeout is transient and retryable; everything else is treated as needs-attention.
function permissionLookupFailureMessage(error: unknown): string {
  if (error instanceof Error && (error.name === "RateLimitError" || /rate limit/i.test(error.message))) {
    return "Scoped Greenhouse read denied: permission lookup was rate limited (transient) — retry shortly.";
  }
  return "Scoped Greenhouse read denied: permissions could not be resolved for this actor.";
}

function sanitizeReadParams(params: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (isIdentityParamName(key)) continue;
    // Drop a model/caller-supplied `fields` selector at the reader boundary. Several row filters scope
    // through a structural FK on the row (an attachment's application_id, a note's visibility, an
    // application's job_id); a `fields` projection that omitted that FK would blind the filter and could
    // widen what survives. The recruiter MCP already strips `fields` via its own allowlist, but the
    // scoped reader is the security boundary and must not depend on a caller doing so — so it is dropped
    // here unconditionally. Field projection is a registry/projection-layer concern, never a raw read param.
    if (normalizeParamName(key) === "fields") continue;
    safe[key] = value;
  }
  return safe;
}

function isIdentityParamName(key: string): boolean {
  return (
    IDENTITY_PARAM_NAMES.has(key) ||
    NORMALIZED_IDENTITY_PARAM_NAMES.has(normalizeParamName(key))
  );
}

function normalizeParamName(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function listTool(
  path: string,
  filterRow: RowFilter,
  forcedParams: ReadParams = {}
): ToolRegistration {
  return {
    async execute(rawReader, params, signal) {
      const { cursor, rest } = splitCursor(params);
      return rawReader.read(path, { ...rest, ...forcedParams }, cursor, signal);
    },
    async filter(response, context) {
      const rows = Array.isArray(response.data)
        ? response.data.filter(isRecord)
        : [];
      const filtered = await filterRows(rows, filterRow, context);
      return {
        response: { ...response, data: filtered.rows },
        outcomes: filtered.outcomes,
      };
    },
  };
}

function policyListTool(path: string): ToolRegistration {
  const registration = globalReferenceListTool(path);
  return { ...registration, requiresScopePolicy: true };
}

function getTool(path: string, filterRow: RowFilter): ToolRegistration {
  return {
    async execute(rawReader, params, signal) {
      const id = readPositiveInteger(params.id);
      if (id === null) {
        throw new Error(`Scoped Greenhouse read requires a positive id for ${path}.`);
      }
      const response = await rawReader.read<unknown[]>(path, {
        ids: String(id),
        per_page: 100,
      }, undefined, signal);
      return {
        ...response,
        data: exactRowById(response.data, id),
        nextCursor: null,
      };
    },
    async filter(response, context) {
      if (!isRecord(response.data)) {
        return {
          response: { ...response, data: null },
          outcomes: emptyScopeOutcomeCounts(),
        };
      }
      const filtered = await filterRow(response.data, context);
      return {
        response: { ...response, data: filtered.row },
        outcomes: countDecision(filtered),
      };
    },
  };
}

function exactRowById(data: unknown, id: number): Record<string, unknown> | null {
  const rows = Array.isArray(data) ? data.filter(isRecord) : [];
  return rows.find((row) => readPositiveInteger(row.id) === id) ?? null;
}

async function filterRows(
  rows: Record<string, unknown>[],
  filterRow: RowFilter,
  context: ScopeContext
): Promise<{ rows: Record<string, unknown>[]; outcomes: ScopeOutcomeCounts }> {
  await prefetchScopeParents(rows, context);
  const filtered: Record<string, unknown>[] = [];
  const outcomes = emptyScopeOutcomeCounts();
  for (const row of rows) {
    const decision = await filterRow(row, context);
    addDecision(outcomes, decision);
    if (decision.row) {
      filtered.push(decision.row);
    }
  }
  return { rows: filtered, outcomes };
}

/**
 * Batch-prime the candidate-privacy cache for the candidate ids a page carries ON THE ROW, one read
 * per 50 ids instead of one per row.
 *
 * Scope is deliberately narrow: only candidate ids present directly on the rows (an application's
 * `candidate_id`, an offer's `candidate_id`, a candidate-backed row's `candidate_id`). It does NOT
 * batch-load applications to reach a candidate behind an `application_id` — those applications are
 * already loaded per-row by the row filters (and observed by call-sequence tests), so a second
 * batched application read would be both redundant and a behavioural change. The row that actually
 * needed this — `list_applications`, whose hundred-row page would otherwise cost a hundred
 * sequential privacy reads — carries `candidate_id` on the row, so the narrow batch covers it.
 *
 * No authorization effect: it seeds exactly what `loadCandidateIsPrivate` would fill itself, under
 * the same fail-closed rule, and on failure seeds nothing so the per-row loader does its own read.
 */
async function prefetchScopeParents(
  rows: readonly Record<string, unknown>[],
  context: ScopeContext
): Promise<void> {
  const candidateIds = new Set<number>();
  for (const row of rows) {
    const candidateId = extractAssociatedCandidateId(row);
    if (candidateId !== null && !context.candidatePrivacyCache.has(candidateId)) {
      candidateIds.add(candidateId);
    }
  }
  if (candidateIds.size === 0) return;

  const pages = await mapWithConcurrency(chunks([...candidateIds], PARENT_BATCH_SIZE), async (ids) => {
    try {
      const response = await context.authorizationReader.read<unknown[]>(
        "/candidates",
        // per_page is set explicitly so a full chunk always lands in one page: an id missing from
        // the response is read as "private" by design, and a silently truncated page would turn a
        // pagination default into a mass over-denial.
        { ids: ids.join(","), fields: "id,private", per_page: 100 },
        undefined,
        context.signal
      );
      return {
        ids,
        rows: Array.isArray(response.data) ? response.data.filter(isRecord) : [],
      };
    } catch (error) {
      // Best-effort: leave the cache untouched so the per-row loader does its own read and
      // surfaces the real PermissionJoinError. Never swallow an abort.
      if (context.signal?.aborted) throw context.signal.reason;
      return null;
    }
  });

  for (const page of pages) {
    if (page === null) continue;
    for (const id of page.ids) {
      if (context.candidatePrivacyCache.has(id)) continue;
      const row = page.rows.find((entry) => readPositiveInteger(entry.id) === id);
      // Identical rule to loadCandidateIsPrivate: a candidate we cannot read, or one whose flag is
      // not a boolean, is treated as private.
      const isPrivate = row === undefined || typeof row.private !== "boolean" ? true : row.private;
      context.candidatePrivacyCache.set(id, Promise.resolve(isPrivate));
    }
  }
}

async function filterJobRow(
  row: Record<string, unknown>,
  context: ScopeContext
): Promise<RowScopeDecision> {
  const id = readPositiveInteger(row.id);
  if (id === null) return missingParent();
  return context.permittedJobIds.has(id) ? permitted(row) : notPermitted();
}

async function filterDirectJobScopedRow(
  row: Record<string, unknown>,
  context: ScopeContext
): Promise<RowScopeDecision> {
  const jobId = readPositiveInteger(row.job_id);
  if (jobId === null) return missingParent();
  return context.permittedJobIds.has(jobId) ? permitted(row) : notPermitted();
}

async function filterApplicationRow(
  row: Record<string, unknown>,
  context: ScopeContext
): Promise<RowScopeDecision> {
  const jobId = applicationJobId(row, context.applicationTerminal);
  if (jobId === null) return missingParent();
  if (!context.permittedJobIds.has(jobId)) return notPermitted();
  // Job permission is necessary but not sufficient: an application IS candidate substance — it
  // names the person, their stage, their rejection. Scope first (a row this actor cannot see needs
  // no privacy read), then apply the same "View Private Candidates" gate the candidate row gets.
  const privateDecision = await applicationCandidatePrivateDecision(context, row);
  if (privateDecision) return privateDecision;
  return permitted(row);
}

async function filterApplicationBackedRow(
  row: Record<string, unknown>,
  context: ScopeContext
): Promise<RowScopeDecision> {
  if (!scorecardVisibilityAllowsScopedRead(row)) {
    return notPermitted();
  }

  const applicationId = readPositiveInteger(row.application_id);
  if (applicationId === null) {
    return missingParent();
  }

  const application = await loadApplication(context, applicationId);
  if (!application) return missingParent();
  const scopeDecision = filterRowThroughApplication(row, application, context);
  if (scopeDecision.outcome !== "permitted") return scopeDecision;
  // Stage history, scorecards, rejection details and prospect details are the private candidate's
  // protected substance, reachable without ever touching a candidate row. The application is
  // already loaded for the job hop, so the candidate id costs nothing extra to reach.
  const privateDecision = await applicationCandidatePrivateDecision(context, application);
  if (privateDecision) return privateDecision;
  return scopeDecision;
}

/**
 * The "View Private Candidates" gate for a row scoped through an application.
 *
 * `/v3/applications` carries `candidate_id` in its default field set (the scoped reader strips any
 * caller `fields` selector, so the default set is what arrives). An application without a usable
 * candidate id means the shape changed underneath us, and that fails CLOSED rather than silently
 * ungating — the same rule `privateCandidateRowDecision` applies to a candidate row missing `private`.
 */
async function applicationCandidatePrivateDecision(
  context: ScopeContext,
  application: Record<string, unknown>
): Promise<RowScopeDecision | null> {
  const candidateId = extractAssociatedCandidateId(application);
  if (candidateId === null) return withheldForPrivacy();
  return privateCandidateDecision(context, candidateId, application);
}

// Offers carry job_id, application_id AND candidate_id, and hold the compensation package — the
// most sensitive row a private candidate has, and the standard shape of a confidential exec hire.
// Job scope runs through job_id exactly as the shared direct-job filter does; privacy runs through
// the offer's own candidate_id, so this needs no join. A row without a candidate id fails CLOSED.
async function filterOfferRow(
  row: Record<string, unknown>,
  context: ScopeContext
): Promise<RowScopeDecision> {
  const jobDecision = await filterDirectJobScopedRow(row, context);
  if (jobDecision.outcome !== "permitted") return jobDecision;

  const candidateId = extractAssociatedCandidateId(row);
  if (candidateId === null) return withheldForPrivacy();
  const privateDecision = await privateCandidateDecision(context, candidateId, row);
  if (privateDecision) return privateDecision;
  return jobDecision;
}

async function filterApplicationBackedOrDirectJobRow(
  row: Record<string, unknown>,
  context: ScopeContext
): Promise<RowScopeDecision> {
  if ("application_id" in row) {
    const applicationDecision = await filterApplicationBackedRow(row, context);
    if (applicationDecision.outcome !== "permitted") {
      return applicationDecision;
    }

    if ("job_id" in row) {
      return filterDirectJobScopedRow(row, context);
    }
    return applicationDecision;
  }
  return filterDirectJobScopedRow(row, context);
}

function globalReferenceListTool(path: string): ToolRegistration {
  return {
    async execute(rawReader, params, signal) {
      const { cursor, rest } = splitCursor(params);
      return rawReader.read(path, rest, cursor, signal);
    },
    async filter(response) {
      const rows = Array.isArray(response.data)
        ? response.data.filter(isRecord)
        : [];
      return {
        response: { ...response, data: rows },
        outcomes: {
          permitted: rows.length,
          notPermitted: 0,
          missingParent: 0,
          parentReadFailed: 0,
        },
      };
    },
  };
}

function globalReferenceGetTool(path: string): ToolRegistration {
  return {
    async execute(rawReader, params, signal) {
      const id = readPositiveInteger(params.id);
      if (id === null) {
        throw new Error(`Scoped Greenhouse read requires a positive id for ${path}.`);
      }
      const response = await rawReader.read<unknown[]>(path, {
        ids: String(id),
        per_page: 100,
      }, undefined, signal);
      return {
        ...response,
        data: exactRowById(response.data, id),
        nextCursor: null,
      };
    },
    async filter(response) {
      const data = isRecord(response.data) ? response.data : null;
      return {
        response: { ...response, data },
        outcomes: {
          permitted: data ? 1 : 0,
          notPermitted: 0,
          missingParent: 0,
          parentReadFailed: 0,
        },
      };
    },
  };
}

async function filterNoteOrActivityRow(
  row: Record<string, unknown>,
  context: ScopeContext
): Promise<RowScopeDecision> {
  if (!noteVisibilityAllowsScopedRead(row)) {
    return notPermitted();
  }

  if ("application_id" in row) {
    const applicationId = readPositiveInteger(row.application_id);
    if (applicationId === null) return missingParent();
    const application = await loadApplication(context, applicationId);
    if (!application) return missingParent();
    const privateDecision = await privateCandidateDecision(
      context,
      extractAssociatedCandidateId(row) ?? extractAssociatedCandidateId(application),
      application
    );
    if (privateDecision) return privateDecision;
    return filterRowThroughApplication(row, application, context);
  }

  const candidateId = extractAssociatedCandidateId(row);
  if (candidateId !== null) {
    const privateDecision = await privateCandidateDecision(context, candidateId, row);
    if (privateDecision) return privateDecision;
    const applications = await loadCandidateApplications(context, candidateId);
    if (applications.length === 0) return missingParent();
    return applications.some((application) =>
      applicationIsPermitted(application, context)
    )
      ? permitted(row)
      : notPermitted();
  }

  return missingParent();
}

async function filterAttachmentRow(
  row: Record<string, unknown>,
  context: ScopeContext
): Promise<RowScopeDecision> {
  // Attachments (incl. resumes) are analytical material with no note-style visibility field, so
  // there is no visibility gate. Scope STRICTLY, mirroring filterNoteOrActivityRow minus that gate:
  // a row tied to a specific application is bounded by THAT application's job (no candidate-level
  // fallback, which would leak a non-permitted job's attachment to a recruiter who merely shares the
  // candidate); only a candidate-level attachment with no application_id falls back to the
  // candidate's permitted applications.
  if ("application_id" in row) {
    const applicationId = readPositiveInteger(row.application_id);
    if (applicationId === null) return missingParent();
    const application = await loadApplication(context, applicationId);
    if (!application) return missingParent();
    const privateDecision = await privateCandidateDecision(
      context,
      extractAssociatedCandidateId(row) ?? extractAssociatedCandidateId(application),
      application
    );
    if (privateDecision) return privateDecision;
    return filterRowThroughApplication(row, application, context);
  }

  const candidateId = extractAssociatedCandidateId(row);
  if (candidateId !== null) {
    const privateDecision = await privateCandidateDecision(context, candidateId, row);
    if (privateDecision) return privateDecision;
    const applications = await loadCandidateApplications(context, candidateId);
    if (applications.length === 0) return missingParent();
    return applications.some((application) =>
      applicationIsPermitted(application, context)
    )
      ? permitted(row)
      : notPermitted();
  }

  return missingParent();
}

async function filterCandidateRow(
  row: Record<string, unknown>,
  context: ScopeContext
): Promise<RowScopeDecision> {
  const privateDecision = privateCandidateRowDecision(row);
  if (privateDecision && !(await actorHoldsPrivateAccessToRow(row, context))) {
    return privateDecision;
  }

  const embeddedApplications = readRecordArray(row.applications);
  if (embeddedApplications) {
    const permittedApplications = embeddedApplications.filter((application) =>
      applicationIsPermitted(application, context)
    );
    if (permittedApplications.length === 0) {
      return embeddedApplications.length === 0 ? missingParent() : notPermitted();
    }
    return permitted({ ...row, applications: permittedApplications });
  }

  const candidateId = extractCandidateId(row);
  if (candidateId === null) {
    return missingParent();
  }

  const applications = await loadCandidateApplications(context, candidateId);
  if (applications.length === 0) return missingParent();
  return applications.some((application) =>
    applicationIsPermitted(application, context)
  )
    ? permitted(row)
    : notPermitted();
}

// candidate_educations / candidate_employments carry a flat candidate_id and no application/job of
// their own, so each row is scoped through the candidate's applications: keep it only if the
// candidate has at least one application on a permitted job. Reuses loadCandidateApplications and
// the proven applicationIsPermitted predicate; a missing candidate_id fails CLOSED. No visibility
// gate — these are resume facts (employment/education history) a Job Admin already sees, not the
// EEOC/demographic compliance core (which stays unexposed).
async function filterCandidateBackedRow(
  row: Record<string, unknown>,
  context: ScopeContext
): Promise<RowScopeDecision> {
  const candidateId = extractAssociatedCandidateId(row);
  if (candidateId === null) {
    return missingParent();
  }
  const privateDecision = await privateCandidateDecision(context, candidateId, row);
  if (privateDecision) return privateDecision;

  const applications = await loadCandidateApplications(context, candidateId);
  if (applications.length === 0) return missingParent();
  return applications.some((application) =>
    applicationIsPermitted(application, context)
  )
    ? permitted(row)
    : notPermitted();
}

function applicationIsPermitted(
  application: Record<string, unknown>,
  context: ScopeContext
): boolean {
  const jobId = applicationJobId(application, context.applicationTerminal);
  return jobId !== null && context.permittedJobIds.has(jobId);
}

function filterRowThroughApplication(
  row: Record<string, unknown>,
  application: Record<string, unknown>,
  context: ScopeContext
): RowScopeDecision {
  const jobId = applicationJobId(application, context.applicationTerminal);
  if (jobId === null) return missingParent();
  return context.permittedJobIds.has(jobId) ? permitted(row) : notPermitted();
}

/**
 * The job a row claims as its OWN, resolved through the same terminal resolver the scope engine
 * uses — so a row shape scope honours cannot be one a privacy or scope decision elsewhere misses.
 *
 * This exists because reading `row.job_id` directly is not equivalent. The v3 application row is
 * flat `job_id`, but production has been observed returning a `jobs: [{ id }]` compatibility shape,
 * which is why the applications terminal declares one (`harvest-v3-registry.ts`
 * `scopeTerminalForEndpoint`). `resolveTerminalIds` honours both and fails closed on ambiguity — two
 * nested jobs, or a canonical id that disagrees with the nested one. A hand-rolled field read
 * honours neither, and the privacy gate used to hand-roll it.
 *
 * The three states are the point. `absent` means the row carries no job field at all, so a caller
 * may legitimately go on to resolve through a parent. `unresolved` means it carries one that could
 * not be resolved, which is NOT the same thing: falling through on it would let a malformed job
 * field buy the wider treatment reserved for rows that never had one.
 */
type RowOwnJob =
  | { state: "resolved"; jobId: number }
  | { state: "absent" }
  | { state: "unresolved" };

function rowOwnJob(row: Record<string, unknown>, terminal: ScopeTerminal): RowOwnJob {
  const carriesJobField =
    Object.prototype.hasOwnProperty.call(row, terminal.field) ||
    (terminal.compatibility !== undefined &&
      Object.prototype.hasOwnProperty.call(row, terminal.compatibility.field));
  if (!carriesJobField) return { state: "absent" };
  const ids = resolveTerminalIds(row, terminal);
  if (!ids || ids.size !== 1) return { state: "unresolved" };
  const jobId = ids.values().next().value;
  return jobId === undefined ? { state: "unresolved" } : { state: "resolved", jobId };
}

/** Implemented on rowOwnJob so there is one resolver, not two that must be kept agreeing. */
function applicationJobId(
  application: Record<string, unknown>,
  terminal: ScopeTerminal
): number | null {
  const own = rowOwnJob(application, terminal);
  return own.state === "resolved" ? own.jobId : null;
}

async function loadApplication(
  context: ScopeContext,
  applicationId: number
): Promise<Record<string, unknown> | null> {
  const existing = context.applicationCache.get(applicationId);
  if (existing) {
    return existing;
  }

  const promise = context.rawReader
    .read<unknown[]>("/applications", {
      ids: String(applicationId),
      per_page: 100,
    }, undefined, context.signal)
    .then((response) => exactRowById(response.data, applicationId))
    .catch((error) => {
      if (context.signal?.aborted) throw context.signal.reason;
      throw new PermissionJoinError("/applications", error);
    });
  context.applicationCache.set(applicationId, promise);
  return promise;
}

// Generic single-record join loader for the parent hop a scoped row needs (an interviewer's
// interview, a scorecard-question-answer's scorecard). Deduped per scopedRead via the supplied
// cache, and fails soft to null on a read error so a transient failure drops the row rather than
// widening access.
async function loadRecordById(
  cache: Map<number, Promise<Record<string, unknown> | null>>,
  rawReader: RawReadClient,
  path: string,
  id: number,
  signal?: AbortSignal
): Promise<Record<string, unknown> | null> {
  const existing = cache.get(id);
  if (existing) {
    return existing;
  }

  const promise = rawReader
    .read<unknown[]>(path, { ids: String(id), per_page: 100 }, undefined, signal)
    .then((response) => exactRowById(response.data, id))
    .catch((error) => {
      if (signal?.aborted) throw signal.reason;
      throw new PermissionJoinError(path, error);
    });
  cache.set(id, promise);
  return promise;
}

// Interviewers carry interview_id (panel membership / response status) but no job_id of their own,
// so each row is scoped through its interview, which is itself bounded by a permitted application or
// job. Reuse the proven interview filter as the permission predicate rather than re-deriving it; a
// missing interview_id fails CLOSED.
async function filterInterviewerRow(
  row: Record<string, unknown>,
  context: ScopeContext
): Promise<RowScopeDecision> {
  const interviewId = readPositiveInteger(row.interview_id);
  if (interviewId === null) {
    return missingParent();
  }
  const interview = await loadRecordById(context.interviewCache, context.rawReader, "/interviews", interviewId, context.signal);
  if (!interview) {
    return missingParent();
  }
  const decision = await filterApplicationBackedOrDirectJobRow(interview, context);
  return decision.outcome === "permitted" ? permitted(row) : decision;
}

// Scorecard-question-answer rows carry scorecard_id but no application/job of their own, so each row
// is scoped through its scorecard, which filterApplicationBackedRow bounds to a permitted application
// — that application->permitted-job scope is the real, load-bearing guarantee. (filterApplicationBackedRow
// also carries a defensive scorecard-visibility check, but v3 /v3/scorecards has NO row-level privacy
// field — only the private_notes free text is gated, separately on the scorecard row — so that check
// is inherited insurance against a future shape, not an active gate here.) A missing scorecard_id
// fails CLOSED.
async function filterScorecardBackedRow(
  row: Record<string, unknown>,
  context: ScopeContext
): Promise<RowScopeDecision> {
  const scorecardId = readPositiveInteger(row.scorecard_id);
  if (scorecardId === null) {
    return missingParent();
  }
  const scorecard = await loadRecordById(context.scorecardCache, context.rawReader, "/scorecards", scorecardId, context.signal);
  if (!scorecard) {
    return missingParent();
  }
  const decision = await filterApplicationBackedRow(scorecard, context);
  return decision.outcome === "permitted" ? permitted(row) : decision;
}

async function loadCandidateApplications(
  context: ScopeContext,
  candidateId: number
): Promise<Record<string, unknown>[]> {
  const existing = context.candidateApplicationsCache.get(candidateId);
  if (existing) {
    return existing;
  }

  const promise = context.rawReader
    .read<unknown[]>("/applications", {
      candidate_ids: String(candidateId),
      per_page: 500,
    }, undefined, context.signal)
    .then((response) => (Array.isArray(response.data) ? response.data.filter(isRecord) : []))
    .catch((error) => {
      if (context.signal?.aborted) throw context.signal.reason;
      throw new PermissionJoinError("/applications", error);
    });
  context.candidateApplicationsCache.set(candidateId, promise);
  return promise;
}

/**
 * Resolve whether a candidate is flagged `private` in Greenhouse.
 *
 * `/v3/candidates` returns `private` in its default field set, so the common path (a candidate row
 * we already hold) never reaches this loader. It exists for candidate-BACKED rows — educations,
 * employments, attachments, notes — which carry only a candidate_id, and for the defensive case
 * where a candidate row arrives without the flag. A failed lookup throws PermissionJoinError, which
 * the caller surfaces as parent_read_failed: unknown privacy is never treated as "not private".
 */
async function loadCandidateIsPrivate(
  context: ScopeContext,
  candidateId: number
): Promise<boolean> {
  const existing = context.candidatePrivacyCache.get(candidateId);
  if (existing) {
    return existing;
  }

  const promise = context.authorizationReader
    .read<unknown[]>("/candidates", {
      ids: String(candidateId),
      fields: "id,private",
    }, undefined, context.signal)
    .then((response) => {
      const rows = Array.isArray(response.data) ? response.data.filter(isRecord) : [];
      const row = rows.find((entry) => readPositiveInteger(entry.id) === candidateId);
      // A candidate we cannot read, or one whose flag is not a boolean, is treated as private.
      return row === undefined || typeof row.private !== "boolean" ? true : row.private;
    })
    .catch((error) => {
      if (context.signal?.aborted) throw context.signal.reason;
      throw new PermissionJoinError("/candidates", error);
    });
  context.candidatePrivacyCache.set(candidateId, promise);
  return promise;
}

/**
 * The "View Private Candidates" gate for a row that IS a candidate.
 *
 * The scoped reader sends no `fields=` param, so `/v3/candidates` returns its default field set,
 * which includes `private`. A candidate row therefore always carries the flag in production and
 * needs no extra read. A row without a usable flag means the field set changed underneath us, and
 * that fails CLOSED rather than silently reverting to "not private".
 */
function privateCandidateRowDecision(
  row: Record<string, unknown>
): RowScopeDecision | null {
  return row.private === false ? null : withheldForPrivacy();
}

/**
 * The same gate for a candidate-BACKED row — educations, employments, attachments, notes — which
 * carries only a candidate id. Costs one cached `/candidates` read per distinct candidate per
 * scopedRead. Any state we cannot establish fails CLOSED.
 */
async function privateCandidateDecision(
  context: ScopeContext,
  candidateId: number | null,
  row?: Record<string, unknown>
): Promise<RowScopeDecision | null> {
  if (candidateId === null) {
    return null;
  }
  if (!(await loadCandidateIsPrivate(context, candidateId))) return null;
  // Private, but the actor may hold Greenhouse's "Private" Job Admin role on this row's job, in
  // which case Greenhouse itself grants the access and withholding it here would be this layer
  // denying what the organization allowed.
  if (row && (await actorHoldsPrivateAccessToRow(row, context))) return null;
  return withheldForPrivacy();
}

function splitCursor(params: Record<string, unknown>): {
  cursor: string | undefined;
  rest: ReadParams;
} {
  const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
  const rest: ReadParams = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === "cursor") continue;
    if (
      value === undefined ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      rest[key] = value;
    }
  }
  return { cursor, rest };
}

function normalizePermissionScope(result: PermissionLookupResult): PermissionScope {
  if (isPermissionScope(result)) {
    return clonePermissionScope(result);
  }
  if (isSetLike(result)) {
    return { kind: "jobs", jobIds: new Set(result) };
  }
  throw new Error("PermissionProvider returned an invalid permission scope.");
}

/**
 * A set-like standing for "every job except these".
 *
 * The scope filters only ever ASK this set whether it contains a job id, never enumerate it, which
 * is what makes an unbounded complement representable at all: there is no need to know every job id
 * in the tenant to answer "is this one excluded". `size` reports the exclusion count so nothing that
 * reads it mistakes the complement for empty — an empty-looking permitted set means deny-all
 * elsewhere in this file, and this is its exact opposite.
 */
function everyJobExcept(excludedJobIds: ReadonlySet<number>): ReadonlySet<number> {
  return {
    has: (jobId: number) => !excludedJobIds.has(jobId),
    size: excludedJobIds.size,
    // Iterating an unbounded complement is meaningless, and yielding the EXCLUSIONS — the one set
    // this object has to hand — would silently invert whatever asked. Nothing iterates a permitted
    // set today; if that ever changes, this makes it a loud failure at the call site instead of a
    // scope filter quietly reading backwards.
    [Symbol.iterator]: () => {
      throw new Error(
        "An org-wide permission scope cannot be enumerated; ask whether a job is in scope instead."
      );
    },
  } as unknown as ReadonlySet<number>;
}

function clonePermissionScope(scope: PermissionScope): PermissionScope {
  if (scope.kind === "all") {
    return scope.excludedJobIds
      ? { kind: "all", excludedJobIds: new Set(scope.excludedJobIds) }
      : { kind: "all" };
  }
  return scope.privateCapableJobIds
    ? {
        kind: "jobs",
        jobIds: new Set(scope.jobIds),
        privateCapableJobIds: new Set(scope.privateCapableJobIds),
      }
    : { kind: "jobs", jobIds: new Set(scope.jobIds) };
}

// A bare Set is still the accepted shape from a custom provider, but it cannot carry the
// private-capable subset — so a scope that HAS one is returned as the object form. Returning the
// Set here would silently drop private capability every time the answer came from the cache.
function clonePermissionLookupResult(scope: PermissionScope): PermissionLookupResult {
  if (scope.kind === "all") return clonePermissionScope(scope);
  return scope.privateCapableJobIds ? clonePermissionScope(scope) : new Set(scope.jobIds);
}

function isPermissionScope(value: unknown): value is PermissionScope {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === "all") {
    return true;
  }
  return value.kind === "jobs" && isSetLike(value.jobIds);
}

function isSetLike(value: unknown): value is ReadonlySet<number> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { has?: unknown }).has === "function" &&
    typeof (value as { size?: unknown }).size === "number" &&
    typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function"
  );
}

/**
 * Is this `/v3/user_roles` row the built-in role that carries private-candidate access?
 *
 * Matched on the documented pair: `role_type: "job_admin"` with the built-in name `Private`. The
 * name is compared exactly (case- and whitespace-insensitively) rather than by substring, so a
 * customer's "Private Equity Recruiter" cannot accidentally become a private-access grant.
 */
function isPrivateCapableRole(row: Record<string, unknown>): boolean {
  if (normalizeMarkerText(String(row.role_type ?? "")) !== "job admin") return false;
  return normalizeMarkerText(String(row.name ?? "")) === "private";
}

function rowGrantsAllJobAccess(row: Record<string, unknown>): boolean {
  if (extractJobIds(row).size > 0) {
    return false;
  }
  return hasExplicitAllJobMarker(row);
}

// Greenhouse signals all-jobs access through the permission row's *role*
// metadata (e.g. `role: { name: "All Jobs" }` / "Site Admin"), not a single
// structured boolean, so this scans /user_job_permissions rows for those role
// markers. Structured grant fields (scope/role/type/access/level) are trusted at
// any level; free-text `name`/`description` are trusted ONLY inside a structured
// role/permission container (where Greenhouse actually places the grant), never
// at the bare top level — so an incidental phrase on an otherwise-unscoped row
// cannot grant org-wide access. Replacing this with structured scope-kind keying
// would require a live Harvest contract probe to confirm the real all-access
// signal shape (Phase 3); until then the role-name heuristic is the contract.
function hasExplicitAllJobMarker(value: unknown, depth = 0, inStructuredContext = false): boolean {
  if (!isRecord(value) || depth > 3) {
    return false;
  }

  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = normalizeMarkerText(key);
    if (
      typeof entry === "boolean" &&
      entry &&
      [
        "all access",
        "all jobs",
        "all jobs access",
        "all current and future jobs",
        "can see all jobs",
        "site admin",
        "is site admin",
      ].includes(normalizedKey)
    ) {
      return true;
    }

    if (typeof entry === "string" && textMeansAllJobAccess(entry)) {
      const structuredGrantKey = [
        "scope",
        "job scope",
        "permission scope",
        "access",
        "access level",
        "grant",
        "role",
        "role name",
        "role type",
        "type",
        "level",
      ].includes(normalizedKey);
      const contextualFreeTextKey =
        inStructuredContext && ["name", "description"].includes(normalizedKey);
      if (structuredGrantKey || contextualFreeTextKey) {
        return true;
      }
    }

    if (
      isRecord(entry) &&
      ["role", "permission", "permissions", "grant", "scope", "access"].includes(
        normalizedKey
      ) &&
      hasExplicitAllJobMarker(entry, depth + 1, true)
    ) {
      return true;
    }
  }

  return false;
}

function textMeansAllJobAccess(value: string): boolean {
  const normalized = normalizeMarkerText(value);
  if (normalized.includes("not all")) {
    return false;
  }
  return (
    normalized.includes("all jobs") ||
    normalized.includes("all current and future jobs") ||
    normalized.includes("site admin")
  );
}

function noteVisibilityAllowsScopedRead(row: Record<string, unknown>): boolean {
  return isPublicVisibility(row.visibility);
}

function scorecardVisibilityAllowsScopedRead(row: Record<string, unknown>): boolean {
  if ("visibility" in row) {
    return isPublicVisibility(row.visibility);
  }

  for (const key of [
    "private",
    "confidential",
    "admin_only",
    "adminOnly",
    "private_only",
    "privateScorecard",
    "private_scorecard",
  ]) {
    if (row[key] === true) {
      return false;
    }
  }

  for (const key of ["confidentiality", "privacy", "access", "access_level"]) {
    const value = row[key];
    if (typeof value === "string" && textMeansNonPublicVisibility(value)) {
      return false;
    }
  }

  return true;
}

function isPublicVisibility(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return ["publicly visible", "public visible", "public"].includes(
    normalizeMarkerText(value)
  );
}

function textMeansNonPublicVisibility(value: string): boolean {
  const normalized = normalizeMarkerText(value);
  return (
    normalized.includes("private") ||
    normalized.includes("admin only") ||
    normalized.includes("confidential")
  );
}

function normalizeMarkerText(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractJobIds(row: Record<string, unknown>): Set<number> {
  const ids = new Set<number>();

  addId(ids, row.job_id);
  addId(ids, row.job);
  addId(ids, row.job_ids);

  if (isRecord(row.job)) {
    addId(ids, row.job.id);
  }

  const jobs = readRecordArray(row.jobs);
  if (jobs) {
    for (const job of jobs) {
      addId(ids, job.id);
    }
  }

  if (isRecord(row.application)) {
    addId(ids, row.application.job_id);
    if (isRecord(row.application.job)) {
      addId(ids, row.application.job.id);
    }
  }

  return ids;
}

function extractUserId(row: Record<string, unknown>): number | null {
  const direct = readPositiveInteger(row.user_id);
  if (direct !== null) {
    return direct;
  }
  return isRecord(row.user) ? readPositiveInteger(row.user.id) : null;
}

function extractCandidateId(row: Record<string, unknown>): number | null {
  const direct = readPositiveInteger(row.candidate_id);
  if (direct !== null) {
    return direct;
  }
  if (isRecord(row.candidate)) {
    return readPositiveInteger(row.candidate.id);
  }
  return readPositiveInteger(row.id);
}

function extractAssociatedCandidateId(row: Record<string, unknown>): number | null {
  const direct = readPositiveInteger(row.candidate_id);
  if (direct !== null) {
    return direct;
  }
  return isRecord(row.candidate) ? readPositiveInteger(row.candidate.id) : null;
}

function addId(ids: Set<number>, value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      addId(ids, item);
    }
    return;
  }
  if (typeof value === "string" && value.includes(",")) {
    for (const item of value.split(",")) {
      addId(ids, item);
    }
    return;
  }
  const id = readPositiveInteger(value);
  if (id !== null) {
    ids.add(id);
  }
}

function readPositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return parsed > 0 ? parsed : null;
  }
  return null;
}

function readRecordArray(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const records = value.filter(isRecord);
  return records.length === value.length ? records : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
