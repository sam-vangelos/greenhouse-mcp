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
      /**
       * Has an operator attested that Greenhouse grants this actor the org-wide "Can create and
       * view private candidates" permission?
       *
       * All-access is INFERRED here — from `/v3/users.site_admin`, or from an all-jobs role marker
       * on `/v3/user_job_permissions`. Neither is that permission, which Greenhouse grants per user
       * and Harvest v3 does not expose at all. Treating "sees every job" as "sees every private
       * candidate" therefore handed out access the organization's own model decides separately, on
       * an input this layer cannot read.
       *
       * Only `=== true` counts. Absent or false means UNATTESTED: the actor keeps every other row
       * they could read, and keeps the private candidates their per-job Greenhouse roles grant
       * (see `privateCapableJobIds` below), but the org-wide private set is withheld. The flag is
       * stamped in exactly one place — `recruiter-mcp/src/private-candidate-attestation.ts`'s
       * provider wrapper — so a new all-access path inherits the gate rather than bypassing it.
       */
      privateCandidatesAttested?: boolean;
      /**
       * The jobs this all-access actor holds through a private-capable Greenhouse role, recovered
       * from their EXPLICIT per-job grants.
       *
       * Only consulted while unattested. Greenhouse grants private-candidate visibility two ways —
       * the org-wide user permission the attestation stands for, and the built-in "Private" Job
       * Admin role on a specific req — and the site-admin path discards the second when it widens
       * an actor to `all`. Without this an unattested all-access actor would lose private access
       * the organization had already granted them on their own reqs, which is a narrowing with no
       * external constraint behind it.
       */
      privateCapableJobIds?: ReadonlySet<number>;
      /**
       * PROOF that this org-wide scope came from a Greenhouse site-admin role, rather than from an
       * all-jobs grant an ordinary job admin can hold.
       *
       * `kind: "all"` answers two different questions with one word. The site-admin wrapper
       * (`recruiter-mcp/src/site-admin-permission.ts`) returns it after reading `/v3/users.site_admin`
       * — a proven role. The base provider returns the SAME shape for a NON-site-admin who holds an
       * all-jobs marker on `/v3/user_job_permissions` (`rowGrantsAllJobAccess` below) — a job-access
       * grant that says nothing about administering the staff directory. Anything downstream that
       * keys a ROLE decision off `kind` therefore hands the second actor the first actor's view.
       *
       * So the role signal is carried explicitly and stamped in exactly one place. Only `=== true`
       * counts; absent means "not established", which is the fail-closed direction — an actor whose
       * site-admin status nobody proved reads every row their jobs give them and none of the rows
       * Greenhouse restricts to site admins.
       */
      siteAdmin?: boolean;
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
      /**
       * The same proof as on the `all` branch, on a scope that is NOT org-wide.
       *
       * A site admin whose role `/v3/users.site_admin` established can still end up job-scoped: the
       * site-admin wrapper narrows to the admin's explicit grants when it cannot read which jobs
       * Greenhouse restricts (`recruiter-mcp/src/site-admin-permission.ts`). The JOB narrowing is a
       * correct fail-closed; the ROLE was never in question, and dropping it demoted a proven admin
       * to the line-recruiter projection because of an unrelated `/jobs` outage. Job scope and role
       * are two answers, so they are carried as two fields.
       */
      siteAdmin?: boolean;
    };

export type PermissionLookupResult = ReadonlySet<number> | PermissionScope;

export type AppliedPermissionScope =
  | { kind: "operator"; permittedJobCount: null; privateCandidatesWithheld?: true }
  | { kind: "all"; permittedJobCount: null; privateCandidatesWithheld?: true; siteAdmin?: true }
  | { kind: "jobs"; permittedJobCount: number; siteAdmin?: true };

/**
 * `privateCandidatesWithheld` is the org-wide branch's disclosure, and it appears ONLY there.
 *
 * An all-access actor (or a direct operator) whose private-candidate permission nobody has attested
 * reads everything except private candidates outside their own private-capable reqs. That is a real
 * narrowing of what the model can see, so the envelope says so rather than letting the model read a
 * short answer as a complete one. It is absent on an attested envelope, which keeps the attested
 * read byte-identical to what it was before the gate existed, and absent on a job scope, which was
 * never org-wide and has always decided private access per req.
 */

export interface ScopedReadRowCounts {
  raw: number | null;
  returned: number;
  /** Rows excluded because they resolved only to jobs outside the actor's scope. */
  permissionExcluded?: number;
  /** Rows whose job association could not be resolved from otherwise successful reads. */
  unresolved?: number;
  /**
   * Of the excluded rows, how many the private-candidate gate withheld. Present only when it is
   * non-zero, and never on a single-row read the gate emptied — see the existence-suppression rule
   * in `scopedRead`, which this count would otherwise walk straight through.
   */
  privacyWithheld?: number;
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
  /**
   * Resolves `privateCapableJobIds` on FIRST NEED, for the direct-operator branch.
   *
   * The operator path returns raw data before the permission provider runs, so recovering the
   * operator's own private-capable reqs means resolving their permission scope — a `/users` probe
   * plus a `/user_job_permissions` sweep plus the `/user_roles` dictionary, on a TTL production
   * forces to zero. Paying that on every operator read, for pages that usually hold no private row
   * at all, would be a real cost for a rarely-used answer. So it is deferred until the gate finds a
   * private row it actually has to decide, and then resolved once for the read.
   */
  resolvePrivateCapableJobIds?: () => Promise<ReadonlySet<number>>;
  /**
   * Seed a FAILED batch fail-closed instead of leaving it to the per-row loaders.
   *
   * Set only on the privacy-only branches (unattested org-wide, unattested direct operator). There a
   * failed batch has exactly one outcome per row — withheld — whether it is reached by the batch
   * seeding "private"/"unreadable parent" or by a per-row read raising the same failure fifty more
   * times. Seeding keeps a hundred-row page at its batch ceiling rather than degrading into the N+1
   * the primers exist to prevent.
   *
   * The scope ENGINES deliberately do not set it: there a per-row PermissionJoinError denies the
   * whole read (`PERMISSION_JOIN_FAILED`), which is long-standing behaviour those paths are tested
   * on, and turning it into a silent per-row withhold would change what a job-scoped recruiter sees
   * when Greenhouse is failing.
   */
  failClosedOnBatchFailure?: boolean;
  /**
   * Every carrier on a row must AGREE, and every one of them must be readable.
   *
   * Set only on the privacy-only branches, for the same reason `failClosedOnBatchFailure` is. There
   * a row nobody can pin to one person on one req is withheld — that is the whole verdict, and it
   * costs the reader one row. Three rules ride on this flag:
   *
   *   1. A direct `candidate_id` is ONE carrier, not a short circuit. A note naming a public
   *      candidate and an `application_id` belonging to a private one was returned on the strength
   *      of the public name printed on it.
   *   2. A carrier whose parent cannot be READ makes the row unresolved even when another carrier
   *      answered. Unknown privacy has never been "not private" on these branches.
   *   3. The jobs the walk passes through must be ONE job. An interviewer whose interview sat on
   *      job 8 and whose scorecard sat on job 7 was admitted by a Private role on job 7 alone, and
   *      the same union let a row on an excluded confidential job ride in on a permitted sibling.
   *
   * The scope ENGINES deliberately do not set it. `resolveRowCandidate` is shared — the privacy
   * gate is a backstop after both engines — so writing these rules in unconditionally would change
   * what a job-scoped recruiter sees when a sibling id dangles, and, through PermissionJoinError
   * and `recruiter-mcp/src/action-visibility.ts:147`, what they are allowed to write. Their
   * long-standing first-carrier-wins resolution and their PERMISSION_JOIN_FAILED denial stand.
   */
  strictCarrierResolution?: boolean;
  applicationTerminal: ScopeTerminal;
  applicationCache: Map<number, Promise<Record<string, unknown> | null>>;
  candidateApplicationsCache: Map<number, Promise<Record<string, unknown>[]>>;
  // Parent-record caches for the interview_id/scorecard_id join hops used by interviewer and
  // scorecard-question-answer scoping. Keyed by record id, deduped per scopedRead like the others.
  interviewCache: Map<number, Promise<Record<string, unknown> | null>>;
  scorecardCache: Map<number, Promise<Record<string, unknown> | null>>;
  // Parent-record caches for the hops the privacy resolver takes that no row filter has a
  // dedicated cache for (today: /scorecard_question_answers, the middle hop of the answer-options
  // chain). Keyed by endpoint path so a new hop needs no new ScopeContext field, and deduped per
  // scopedRead like the named caches above.
  extraParentCaches: Map<string, Map<number, Promise<Record<string, unknown> | null>>>;
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
  /**
   * The per-row filter this registration was built from, carried so the registry can be WALKED
   * rather than transcribed.
   *
   * `CANDIDATE_ROW_TOOLS` and `CANDIDATE_SUBSTANCE_TOOLS` are hand-maintained lists of tool names,
   * and a hand-maintained list of what must be gated is exactly the kind of thing a new
   * registration silently falls out of — the drift that leaks. Exposing the filter lets a test
   * assert the membership from the registry itself, so adding a candidate-bearing tool without
   * classifying it fails the suite instead of shipping.
   */
  rowFilter?: RowFilter;
  /**
   * The Greenhouse endpoint this registration reads, carried for the same drift-guard reason as
   * `rowFilter` — and load-bearing where `rowFilter` is not.
   *
   * A POLICY-DRIVEN registration (`policyListTool`) has no row filter at all: it is built on
   * `globalReferenceListTool` and scoped by the scope-policy registry instead. A guard that walks
   * row-filter names therefore skips every one of them, which is exactly how
   * `list_scorecard_question_answer_options` — three hops from a candidate — sat unclassified while
   * the guard reported no drift. Every registration has an endpoint, so classifying by endpoint
   * covers the whole registry rather than the filtered part of it.
   */
  endpoint?: string;
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
  /**
   * Has an operator attested that Greenhouse grants this actor the org-wide private-candidate
   * permission? Consulted ONLY on the direct-operator path, which returns raw data before the
   * permission provider ever runs and so never sees the flag the provider stamps on a scope.
   *
   * Absent means unattested — the same fail-closed direction every other unknown takes here. It is
   * not a claim that the operator lacks the permission, only that this layer cannot establish it,
   * and Greenhouse's own model is the thing being honoured rather than guessed at.
   */
  privateCandidateAttestation?: (
    greenhouseUserId: number,
    signal?: AbortSignal
  ) => Promise<boolean>;
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
    // An all-jobs role marker is COLLECTED, not returned on. Returning at the first marker threw
    // away every explicit per-job grant that followed it — including the built-in "Private" Job
    // Admin role — so an all-jobs actor whose private-candidate permission nobody has attested lost
    // the private candidates Greenhouse had already granted them on their own reqs. The sweep is
    // already paginating; finishing it costs the same reads and answers both questions.
    let grantsAllJobAccess = false;
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
          grantsAllJobAccess = true;
          continue;
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
    if (grantsAllJobAccess) {
      // Job scope is `all`; the private-capable set rides along so the attestation gate downstream
      // can admit this actor's own private reqs while the org-wide grant stays unattested. An
      // attested actor ignores it — they hold the org-wide permission and see everything.
      return privateCapableJobIds.size > 0
        ? { kind: "all", privateCapableJobIds }
        : { kind: "all" };
    }
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

      const safeParams = sanitizeReadParams(params, registration.endpoint);

      if (isOperator && actAsUserId === undefined) {
        options.onPermissionScopeResolved?.({ kind: "operator" });
        signal?.throwIfAborted();
        const response = await registration.execute(config.rawReader, safeParams, signal);
        // The operator path returns raw data before the permission provider runs, so the flag the
        // provider stamps onto a scope never reaches it. It asks directly instead — and an absent
        // lookup is unattested, not a grant.
        //
        // A lookup that REJECTS is unattested too, not a denial: the directory being unreachable is
        // this layer failing to establish a permission, which is exactly what "unattested" means.
        // Letting it throw turned a Supabase blip into a hard read failure for every operator.
        let operatorAttested = false;
        try {
          operatorAttested = (await config.privateCandidateAttestation?.(actorId, signal)) === true;
        } catch (error) {
          if (signal?.aborted) throw signal.reason;
          operatorAttested = false;
        }
        if (!operatorAttested) {
          return withholdUnattestedPrivateCandidates({
            toolName,
            actorId,
            effectiveActorId: actorId,
            response,
            // scoped STAYS false. Three release-gate predicates read an operator envelope and
            // require it — `leakage-sample.ts:160`, `rollout-gate.ts:775` (scoped_flag_mismatch)
            // and `rollout-gate.ts:3203` — so flipping it to advertise the withholding would fail
            // the gate on every operator probe. The withholding is disclosed on `permissionScope`
            // instead, which is where the rest of this branch already says it.
            scoped: false,
            appliedScope: { kind: "operator", permittedJobCount: null, privateCandidatesWithheld: true },
            context: privacyOnlyContext(
              config,
              applicationTerminal,
              signal,
              // The operator's OWN private-capable reqs, resolved through the permission provider.
              // Hard-coding an empty set here withheld private candidates on reqs Greenhouse's own
              // "Private" Job Admin role already grants them — a narrowing with nothing behind it.
              // Passed as a thunk: an operator page with no private row on it never pays for the
              // permission sweep. Fails soft to empty: a provider that cannot answer never widens.
              () => operatorPrivateCapableJobIds(config, actorId, signal)
            ),
          });
        }
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
      // Has an operator attested that Greenhouse grants this org-wide actor the private-candidate
      // permission? Only `=== true` counts, here and everywhere else.
      const allAccessAttested =
        permissionScope.kind === "all" && permissionScope.privateCandidatesAttested === true;
      // An ATTESTED org-wide scope with nothing excluded stays a raw, unfiltered read — the fast
      // path, and the correct answer for a tenant with no legacy confidential jobs. With
      // exclusions, the same row filtering everyone else gets runs, over a "permitted" set that is
      // everything BUT them.
      if (permissionScope.kind === "all" && allAccessAttested && !(permissionScope.excludedJobIds?.size)) {
        const rowCounts = unscopedRowCounts(response.data);
        return {
          ok: true,
          toolName,
          actorId,
          effectiveActorId,
          scoped: false,
          permissionScope: {
            kind: "all",
            permittedJobCount: null,
            ...(permissionScope.siteAdmin === true ? { siteAdmin: true as const } : {}),
          },
          rowCounts,
          data: response.data,
          nextCursor: response.nextCursor,
          meta: response.meta,
        };
      }

      // UNATTESTED org-wide: a dedicated branch, deliberately NOT the job-scope filter path — and
      // it is taken WITH OR WITHOUT confidential exclusions. The exclusion test used to come first,
      // which meant an unattested admin in a tenant that has even one legacy confidential job fell
      // straight back into the engine and inherited everything this branch exists to avoid.
      //
      // Routing it through the filter would change far more than privacy: that path drops a
      // candidate with no applications as `missingParent`, resolves each row's job through a
      // per-row parent read, and can deny the WHOLE read with PERMISSION_JOIN_FAILED — which
      // `recruiter-mcp/src/action-visibility.ts:147` turns into a write denial. None of that is
      // what "this actor's private-candidate permission is unattested" means. So the raw page is
      // taken as-is, the confidential exclusion is applied to it directly (Greenhouse restricts a
      // legacy confidential job to users explicitly on its hiring team — an external constraint
      // this branch honours exactly as the engine does), and then the private rows are withheld.
      //
      // The cost is the batched candidate loads the gate below performs on the UNCACHED
      // authorization reader: one `/candidates?ids=…&fields=id,private` per 50 rows on an
      // endpoint that does not already carry the flag, plus one batched `/applications` read per
      // 50 private candidates IF the actor holds a private-capable role somewhere (nothing at all
      // when they do not). With exclusions there is one further batched job-resolution pass over
      // the page. The window is bounded: from migration 0008 until the operator runs
      // greenhouse-recruiter-attest-private-candidates for each org-wide user.
      //
      // Measured, on a hundred-row page of a hundred distinct candidates — the ceiling
      // `private-candidate-multihop.test.ts` locks, and the same figure whether or not the actor
      // holds a private-capable role, and whether a parent batch fails, returns `[]` or answers in
      // full (an id nobody named is seeded rather than retried):
      //
      //   list_applications                        3  page + 2 x /candidates
      //   list_scorecard_question_answers          7  page + 2 each x /scorecards, /applications, /candidates
      //   list_interviewers (interview_id only)    7  page + 2 each x /interviews, /applications, /candidates
      //   list_interviewers (+ scorecard_id)       9  two carriers means two endpoints primed at the first hop
      //
      // Nine, not seven, is the honest number for a real `/v3/interviewers` row: it carries BOTH
      // ids, and both have to be walked or the second one is a way past the gate.
      if (permissionScope.kind === "all" && !allAccessAttested) {
        const excludedJobIds = permissionScope.excludedJobIds ?? new Set<number>();
        return withholdUnattestedPrivateCandidates({
          toolName,
          actorId,
          effectiveActorId,
          response,
          scoped: true,
          appliedScope: {
            kind: "all",
            permittedJobCount: null,
            privateCandidatesWithheld: true,
            ...(permissionScope.siteAdmin === true ? { siteAdmin: true as const } : {}),
          },
          context: privacyOnlyContext(
            config,
            applicationTerminal,
            signal,
            permissionScope.privateCapableJobIds ?? new Set<number>(),
            excludedJobIds
          ),
          applyExclusions: excludedJobIds.size > 0,
        });
      }

      const context: ScopeContext = {
        rawReader: config.rawReader,
        authorizationReader: config.authorizationReader ?? config.rawReader,
        signal,
        permittedJobIds: permissionScope.kind === "all"
          ? everyJobExcept(permissionScope.excludedJobIds ?? new Set<number>())
          : permissionScope.jobIds,
        // An ATTESTED org-wide actor holds Greenhouse's private-candidate permission, so on the
        // jobs they can still see, private candidates remain visible exactly as they were. An
        // unattested one falls back to the private-capable reqs their explicit Greenhouse roles
        // grant — never to nothing, which would deny access the organization already gave them.
        privateCapableJobIds: permissionScope.kind === "all"
          ? (allAccessAttested
              ? everyJobExcept(permissionScope.excludedJobIds ?? new Set<number>())
              : permissionScope.privateCapableJobIds ?? new Set<number>())
          : permissionScope.privateCapableJobIds ?? new Set<number>(),
        applicationTerminal,
        applicationCache: new Map(),
        candidateApplicationsCache: new Map(),
        interviewCache: new Map(),
        scorecardCache: new Map(),
        extraParentCaches: new Map(),
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
      const privacyWithheld = filtered.outcomes.privacyWithheld ?? 0;
      const rowCounts: ScopedReadRowCounts = {
        raw: suppressExistence ? 0 : countRows(response.data),
        returned: countReturnedRows(scopedResponse.data),
        permissionExcluded: suppressExistence ? 0 : filtered.outcomes.notPermitted,
        unresolved: filtered.outcomes.missingParent + filtered.outcomes.parentReadFailed,
        status: filtered.outcomes.missingParent > 0 || filtered.outcomes.parentReadFailed > 0 || filtered.outcomes.incomplete
          ? "incomplete_scope_resolution" as const
          : "complete" as const,
        // Only when there is something to report, and never under existence suppression — a count
        // that survived the suppression would restore exactly the oracle it exists to remove.
        ...(suppressExistence || privacyWithheld === 0 ? {} : { privacyWithheld }),
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
          ? {
              kind: "all",
              permittedJobCount: null,
              ...(allAccessAttested ? {} : { privateCandidatesWithheld: true as const }),
              ...(permissionScope.siteAdmin === true ? { siteAdmin: true as const } : {}),
            }
          : {
              kind: "jobs",
              permittedJobCount: permissionScope.jobIds.size,
              // A proven site admin narrowed to explicit job grants stays a proven site admin on the
              // envelope: the projection layer keys the admin view off this flag, never off `kind`.
              ...(permissionScope.siteAdmin === true ? { siteAdmin: true as const } : {}),
            },
        rowCounts,
        data: scopedResponse.data,
        nextCursor: scopedResponse.nextCursor,
        meta: scopedResponse.meta,
      };
    },
  };
}

/**
 * The ScopeContext an UNATTESTED org-wide read needs: everything permitted (job scope is not what
 * is in question), and privacy decided by the private-capable reqs Greenhouse's own per-job roles
 * grant this actor.
 *
 * `authorizationReader` is the same uncached reader the rest of the privacy path uses — the
 * candidate `private` flag decides whether a row is withheld, so it must not age on the data
 * cache's clock. The parent caches are per-read, exactly as they are on the filter path, so a page
 * that mentions one candidate twice pays for it once.
 */
function privacyOnlyContext(
  config: { rawReader: RawReadClient; authorizationReader?: RawReadClient },
  applicationTerminal: ScopeTerminal,
  signal: AbortSignal | undefined,
  privateCapableJobIds: ReadonlySet<number> | (() => Promise<ReadonlySet<number>>),
  // The legacy confidential jobs Greenhouse restricts from this org-wide actor. Empty for the
  // operator path and for a tenant with none, which is the untouched raw case.
  excludedJobIds: ReadonlySet<number> = new Set<number>()
): ScopeContext {
  return {
    rawReader: config.rawReader,
    authorizationReader: config.authorizationReader ?? config.rawReader,
    ...(signal ? { signal } : {}),
    permittedJobIds: everyJobExcept(excludedJobIds),
    // This branch withholds a row it cannot resolve rather than denying the page, so a failed batch
    // has one answer for every id in it and there is nothing a per-row retry could discover.
    failClosedOnBatchFailure: true,
    // Same branch, same reason: a row whose carriers disagree, or one of whose carriers cannot be
    // read, is withheld here rather than resolved by picking whichever carrier answered first.
    strictCarrierResolution: true,
    privateCapableJobIds: typeof privateCapableJobIds === "function" ? new Set<number>() : privateCapableJobIds,
    ...(typeof privateCapableJobIds === "function"
      ? { resolvePrivateCapableJobIds: privateCapableJobIds }
      : {}),
    applicationTerminal,
    applicationCache: new Map(),
    candidateApplicationsCache: new Map(),
    interviewCache: new Map(),
    scorecardCache: new Map(),
    extraParentCaches: new Map(),
    policyParentCache: new Map(),
    candidatePrivacyCache: new Map(),
  };
}

/**
 * Withhold the private candidates an UNATTESTED org-wide actor (or direct operator) may not see,
 * and report what that cost — without ever confirming that a particular person exists.
 *
 * Runs `applyCandidatePrivacyGate` over the RAW page. That gate is the same one both scope engines
 * already funnel through, so this branch inherits its batching, its per-row failure handling (an
 * unreadable parent withholds ITS row rather than denying the page), and its per-job admission
 * rule. What it does not inherit is job-scope filtering, which is not what an unattested
 * attestation means.
 */
async function withholdUnattestedPrivateCandidates(input: {
  toolName: string;
  actorId: number;
  effectiveActorId: number;
  response: ApiResponse;
  /**
   * What the envelope reports for `scoped`. TRUE on the org-wide branch, where rows really were
   * filtered out of an otherwise org-wide read. FALSE on the operator branch, where three release
   * gates (`leakage-sample.ts:160`, `rollout-gate.ts:775`, `rollout-gate.ts:3203`) read an operator
   * envelope and require `scoped === false`; the withholding is disclosed on `permissionScope`
   * there, which is a field those predicates do not constrain.
   */
  scoped: boolean;
  appliedScope: AppliedPermissionScope;
  context: ScopeContext;
  /** Run the confidential-job exclusion before the privacy gate. Only ever true for an org-wide scope. */
  applyExclusions?: boolean;
}): Promise<ScopedReadSuccess> {
  const { toolName, response, context } = input;
  const seeded: FilterResult = input.applyExclusions
    ? await excludeConfidentialJobRows(toolName, response, context)
    : {
        response,
        outcomes: { ...emptyScopeOutcomeCounts(), permitted: countReturnedRows(response.data) },
      };
  const filtered = await applyCandidatePrivacyGate(toolName, seeded, context);
  const privacyWithheld = filtered.outcomes.privacyWithheld ?? 0;
  const unresolved = filtered.outcomes.missingParent + filtered.outcomes.parentReadFailed;
  // The same existence-suppression rule the filter path applies, for the same reason: a single-row
  // read the privacy gate emptied must report exactly what a nonexistent id reports, or the counts
  // become a per-person oracle for the restricted flag. An unresolved or unreadable parent stays
  // loud, exactly as it does on the filter path — that is a reliability signal, not an existence one.
  const suppressExistence = isRecord(response.data) && privacyWithheld > 0 && unresolved === 0;
  return {
    ok: true,
    toolName,
    actorId: input.actorId,
    effectiveActorId: input.effectiveActorId,
    scoped: input.scoped,
    permissionScope: input.appliedScope,
    rowCounts: {
      raw: suppressExistence ? 0 : countRows(response.data),
      returned: countReturnedRows(filtered.response.data),
      permissionExcluded: suppressExistence ? 0 : filtered.outcomes.notPermitted,
      unresolved,
      status: unresolved > 0 || filtered.outcomes.incomplete
        ? "incomplete_scope_resolution" as const
        : "complete" as const,
      ...(suppressExistence || privacyWithheld === 0 ? {} : { privacyWithheld }),
    },
    data: filtered.response.data,
    nextCursor: filtered.response.nextCursor,
    meta: filtered.response.meta,
  };
}

/**
 * Withhold the rows that sit on a job Greenhouse restricts from this org-wide actor.
 *
 * The one narrowing on this branch that cites an EXTERNAL constraint: `/v3/jobs` documents a legacy
 * confidential job as "restricted to users explicitly granted access on the Hiring Team", site
 * admin or not, and `site-admin-permission.ts` has already computed which of them this actor is not
 * on. Skipped entirely when that set is empty, which is the whole tenant in the ordinary case.
 *
 * Three outcomes, and the middle one is what the job-scope engine gets wrong here. A row whose job
 * RESOLVES is kept or excluded on the answer. A row that belongs to NO job — a candidate with no
 * applications, a dictionary row — is KEPT, because "no job" cannot be "a confidential job"; the
 * engine calls that `missingParent` and drops it. A row whose job could not be READ is dropped as
 * `parentReadFailed` and makes the page honestly incomplete — but it never denies the page, which
 * the engine's PermissionJoinError does, and which `action-visibility.ts:147` turns into a write
 * denial.
 */
async function excludeConfidentialJobRows(
  toolName: string,
  response: ApiResponse,
  context: ScopeContext
): Promise<FilterResult> {
  const sourceWasArray = Array.isArray(response.data);
  const rows: Record<string, unknown>[] = sourceWasArray
    ? (response.data as unknown[]).filter(isRecord)
    : isRecord(response.data)
      ? [response.data]
      : [];
  const outcomes = emptyScopeOutcomeCounts();
  if (sourceWasArray) {
    outcomes.missingParent = (response.data as unknown[]).length - rows.length;
  }
  if (rows.length === 0) {
    return { response: { ...response, data: sourceWasArray ? [] : null }, outcomes };
  }

  // The same batched primers the privacy gate uses, so the job hop and the candidate hop share one
  // set of reads rather than each paying for its own.
  await primeCandidateParents(rows, context);

  const kept: Record<string, unknown>[] = [];
  for (const row of rows) {
    let decision: RowScopeDecision;
    try {
      const jobs = await resolveRowJobIds(row, context, JOB_ROW_TOOLS.has(toolName), CANDIDATE_ROW_TOOLS.has(toolName));
      if (jobs.state === "unresolved") decision = parentReadFailed();
      else if (jobs.state === "none") decision = permitted(row);
      else decision = intersects(jobs.jobIds, context.permittedJobIds)
        ? permitted(pruneExcludedEmbeddedApplications(row, context))
        : notPermitted();
    } catch (error) {
      if (context.signal?.aborted) throw context.signal.reason;
      decision = parentReadFailed();
    }
    addDecision(outcomes, decision);
    if (decision.row) kept.push(decision.row);
  }
  return {
    response: { ...response, data: sourceWasArray ? kept : (kept[0] ?? null) },
    outcomes,
  };
}

/**
 * Drop the applications a row EMBEDS that sit on a job Greenhouse restricts from this actor.
 *
 * A candidate row carries its applications inline, and keeping the row because ONE of them is on a
 * permitted job used to return all of them — the confidential job's application, its stage, its
 * ids, riding along inside a row that was admitted on a different job entirely. The job-scope
 * engine has always pruned here (`filterCandidateRow` returns `{ ...row, applications: permitted }`);
 * this is the same rule on the branch that runs no row filter. The row object is only rebuilt when
 * something was actually dropped, so an ordinary read is byte-identical.
 */
function pruneExcludedEmbeddedApplications(
  row: Record<string, unknown>,
  context: ScopeContext
): Record<string, unknown> {
  const embedded = readRecordArray(row.applications);
  if (!embedded || embedded.length === 0) return row;
  const kept = embedded.filter((application) => {
    const jobId = applicationJobId(application, context.applicationTerminal);
    return jobId !== null && context.permittedJobIds.has(jobId);
  });
  return kept.length === embedded.length ? row : { ...row, applications: kept };
}

/** Tools whose rows ARE jobs, so the row's own `id` is the job the exclusion set is checked against. */
const JOB_ROW_TOOLS: ReadonlySet<string> = new Set(["list_jobs", "get_job"]);

type RowJobs =
  | { state: "resolved"; jobIds: ReadonlySet<number> }
  | { state: "none" }
  | { state: "unresolved" };

/**
 * The jobs a row belongs to, resolved through the same routes the row filters use.
 *
 * Ordered so the cheapest, most direct answer wins: the row IS a job; the row names its job
 * (`rowOwnJob`, which honours the applications compatibility shape and fails closed on ambiguity);
 * the row carries a job-ish field a nested shape put there; the row names an application; the row
 * embeds its applications; the row reaches a candidate (directly, or through the parent chain) and
 * that candidate's applications name the jobs.
 */
async function resolveRowJobIds(
  row: Record<string, unknown>,
  context: ScopeContext,
  jobRowTool: boolean,
  candidateRowTool: boolean
): Promise<RowJobs> {
  if (jobRowTool) {
    const id = readPositiveInteger(row.id);
    return id === null ? { state: "unresolved" } : { state: "resolved", jobIds: new Set([id]) };
  }

  const own = rowOwnJob(row, context.applicationTerminal);
  if (own.state === "resolved") return { state: "resolved", jobIds: new Set([own.jobId]) };
  if (own.state === "unresolved") return { state: "unresolved" };

  const declared = extractJobIds(row);
  if (declared.size > 0) return { state: "resolved", jobIds: declared };

  const applicationId = readPositiveInteger(row.application_id);
  if (applicationId !== null) {
    const application = await loadApplication(context, applicationId);
    if (!application) return { state: "unresolved" };
    const jobId = applicationJobId(application, context.applicationTerminal);
    return jobId === null ? { state: "unresolved" } : { state: "resolved", jobIds: new Set([jobId]) };
  }

  if (Array.isArray(row.applications)) {
    const embedded = readRecordArray(row.applications);
    // An EMPTY array is a candidate who is genuinely on no job, and "no job" cannot be a
    // confidential job — the row is kept. A NON-EMPTY array whose jobs cannot be read is the
    // opposite: the row says it belongs to jobs and we cannot say which, which is `unresolved` and
    // withheld, not `none` and waved through.
    if (!embedded) return row.applications.length === 0 ? { state: "none" } : { state: "unresolved" };
    const jobIds = new Set<number>();
    for (const application of embedded) {
      const jobId = applicationJobId(application, context.applicationTerminal);
      if (jobId !== null) jobIds.add(jobId);
    }
    if (jobIds.size > 0) return { state: "resolved", jobIds };
    return embedded.length === 0 ? { state: "none" } : { state: "unresolved" };
  }

  let candidateId: number | null = candidateRowTool ? extractCandidateId(row) : null;
  if (candidateId === null) {
    const candidate = await resolveRowCandidate(row, context);
    if (candidate.state === "unresolved") return { state: "unresolved" };
    // The jobs the walk PASSED THROUGH are this row's own jobs — the interview's job, the
    // application's job. Using them is what separates a row sitting on the confidential job from a
    // row belonging to someone who merely also has an application there. The candidate's whole
    // application set is consulted only when the chain established no job at all, which is exactly
    // the candidate-level shape (a note, an education row) the row filters scope that way too.
    if (candidate.jobIds.size > 0) return { state: "resolved", jobIds: new Set(candidate.jobIds) };
    if (candidate.state === "none") return { state: "none" };
    candidateId = candidate.candidateId;
  }
  const applications = await loadCandidateApplications(context, candidateId);
  const jobIds = new Set<number>();
  for (const application of applications) {
    const jobId = applicationJobId(application, context.applicationTerminal);
    if (jobId !== null) jobIds.add(jobId);
  }
  return jobIds.size === 0 ? { state: "none" } : { state: "resolved", jobIds };
}

/**
 * The private-capable reqs a DIRECT OPERATOR holds through Greenhouse's own per-job roles.
 *
 * The operator path returns raw data before the permission provider runs, so nothing had resolved
 * this actor's grants at all — the branch used to hand the gate an empty set and withhold private
 * candidates on reqs the organization had already granted them. Fails SOFT: a provider that throws,
 * or answers a shape with no private-capable subset, yields an empty set, which withholds rather
 * than widens. An abort still propagates.
 */
async function operatorPrivateCapableJobIds<SessionIdentity>(
  config: ScopedGreenhouseConfig<SessionIdentity>,
  actorId: number,
  signal: AbortSignal | undefined
): Promise<ReadonlySet<number>> {
  try {
    const answer = await config.permissionProvider.getPermittedJobIds(actorId, signal);
    if (!isPermissionScope(answer)) return new Set<number>();
    return answer.privateCapableJobIds ? new Set(answer.privateCapableJobIds) : new Set<number>();
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    return new Set<number>();
  }
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
 * Tools whose rows ARE candidates, so the gate reads the flag off the row instead of joining to it.
 *
 * `/v3/candidates` carries `private` in its default field set and the scoped reader strips any
 * caller `fields` selector, so the flag is always there in production. A row without a usable
 * boolean means the field set changed underneath us and fails CLOSED — the same rule
 * `privateCandidateRowDecision` applies in the row filter.
 *
 * The row filter already gates these on the job-scope path, which makes this pass idempotent
 * there: the rows that survive carry `private: false`, so a second look withholds nothing new. It
 * is load-bearing on the UNATTESTED org-wide branch, which runs no row filter at all, and where a
 * gate that could only reach a candidate through an application would have kept every private
 * candidate on a `list_candidates` page.
 */
export const CANDIDATE_ROW_TOOLS: ReadonlySet<string> = new Set([
  "list_candidates",
  "get_candidate",
]);

/**
 * Tools whose EVERY row is candidate substance, so a row that resolves to NO candidate is a shape
 * violation and is withheld rather than waved through.
 *
 * The membership rule is "could this endpoint ever legitimately return a row belonging to nobody".
 * Notes, attachments, educations and employments cannot: each hangs off a candidate or an
 * application, and a row of one that names neither is malformed, not candidate-free — it used to
 * fail OPEN. The scorecard-answer chain cannot either: a scorecard belongs to an application, and
 * an answer (and an answer option) belongs to a scorecard, so the whole chain is one person's
 * interview record.
 *
 * `list_interviews` and `list_interviewers` are deliberately ABSENT, and that is not an oversight.
 * `/v3/interviews` is job-scoped in the endpoint registry and its rows carry `job_id` when they
 * belong to no application, so a job-level interview — and the panel membership hanging off it —
 * genuinely belongs to no candidate. Failing those closed would withhold rows no one's privacy is
 * at stake in, a narrowing with no external constraint behind it. The leak they DID have is closed
 * a different way: `resolveRowCandidate` walks their parent chain, and an unreadable hop is
 * `unresolved`, which is withheld for every tool regardless of this set.
 */
export const CANDIDATE_SUBSTANCE_TOOLS: ReadonlySet<string> = new Set([
  "list_applications",
  "get_application",
  "list_application_stages",
  "list_scorecards",
  "list_rejection_details",
  "list_prospect_details",
  "list_offers",
  "list_notes",
  "list_attachments",
  "list_candidate_educations",
  "list_candidate_employments",
  // R2b: an applied-tag row names a candidate by id, so an unattested actor must not learn a private
  // candidate exists by seeing their tag row.
  "list_applied_candidate_tags",
  // R2d: `note` on a scorecard-attribute row is an interviewer's free text about one candidate.
  "list_scorecard_candidate_attributes",
  "list_scorecard_question_answers",
  "list_scorecard_question_answer_options",
]);

/**
 * The parent chain the privacy resolver walks to reach the candidate behind a row.
 *
 * The scope engines reach a candidate through the ROW FILTERS, each of which hard-codes its own
 * hop: an interviewer's `interview_id`, a scorecard answer's `scorecard_id`. The unattested
 * org-wide branch and the direct-operator branch run NO row filter — that is the whole point of
 * them, since job scope is not what is in question — so the hops have to live here too, or a row
 * two joins away from its candidate walks past the gate. They did: `list_interviewers`,
 * `list_scorecard_question_answers` and `list_scorecard_question_answer_options` returned
 * private-candidate rows to an unattested actor because the resolver stopped after one hop.
 *
 * Ordered cheapest-first: a row carrying `application_id` is one read from its candidate, and the
 * later hops each land on a record that carries one. Every hop goes through a per-read cache (the
 * same ones the row filters use, so the two engines share the work) and is batch-primed by
 * `primeCandidateParents` before any row is decided.
 */
interface CandidateParentHop {
  idField: string;
  endpoint: string;
}

const CANDIDATE_PARENT_HOPS: readonly CandidateParentHop[] = [
  { idField: "application_id", endpoint: "/applications" },
  { idField: "interview_id", endpoint: "/interviews" },
  { idField: "scorecard_id", endpoint: "/scorecards" },
  { idField: "scorecard_question_answer_id", endpoint: "/scorecard_question_answers" },
];

/**
 * EVERY candidate-bearing carrier the record declares, not just the first one that matched.
 *
 * The real `/v3/interviewers` row carries `interview_id` AND `scorecard_id`. Stopping at the first
 * meant a row whose interview is job-level (`application_id: null`, so that chain honestly ends at
 * "no candidate") was waved through while its scorecard pointed straight at a private candidate's
 * application. Resolving all of them is also what makes a DISAGREEMENT visible, which is withheld
 * rather than resolved by picking one.
 */
function candidateParentHopsFor(
  row: Record<string, unknown>
): Array<{ hop: CandidateParentHop; id: number }> {
  const hops: Array<{ hop: CandidateParentHop; id: number }> = [];
  for (const hop of CANDIDATE_PARENT_HOPS) {
    const id = readPositiveInteger(row[hop.idField]);
    if (id !== null) hops.push({ hop, id });
  }
  return hops;
}

function parentCacheFor(
  context: ScopeContext,
  endpoint: string
): Map<number, Promise<Record<string, unknown> | null>> {
  if (endpoint === "/applications") return context.applicationCache;
  if (endpoint === "/interviews") return context.interviewCache;
  if (endpoint === "/scorecards") return context.scorecardCache;
  let cache = context.extraParentCaches.get(endpoint);
  if (!cache) {
    cache = new Map<number, Promise<Record<string, unknown> | null>>();
    context.extraParentCaches.set(endpoint, cache);
  }
  return cache;
}

async function loadParentRecord(
  context: ScopeContext,
  endpoint: string,
  id: number
): Promise<Record<string, unknown> | null> {
  if (endpoint === "/applications") return loadApplication(context, id);
  return loadRecordById(parentCacheFor(context, endpoint), context.rawReader, endpoint, id, context.signal);
}

/**
 * Three states, and the middle one is the reason this is not a `number | null`.
 *
 * `none` means the row belongs to no candidate — a job-level interview, a dictionary row. `unresolved`
 * means it names a parent that could not be read, which is NOT the same thing: treating it as `none`
 * would let one failed join hand a private candidate's row to an actor who may not see it. `none` is
 * decided by the tool (see CANDIDATE_SUBSTANCE_TOOLS); `unresolved` is always withheld.
 */
type RowCandidate =
  | {
      state: "resolved";
      candidateId: number;
      /**
       * The jobs the walk actually passed through — the interview's job, the application's job.
       *
       * This is the row's OWN job, and it is not the same set as "every job this candidate has an
       * application on". Deciding a multi-hop row's per-job private access on the candidate's whole
       * application set admitted an actor holding Greenhouse's "Private" Job Admin role on ONE req
       * to that candidate's interviewer and scorecard-answer rows on EVERY req they touched; the
       * same union let a row sitting on a legacy confidential job ride in on a permitted one.
       * Empty means the chain established no job at all (a candidate-level note, an education row),
       * which is the one case where the candidate's applications ARE the row's scope.
       */
      jobIds: ReadonlySet<number>;
    }
  | { state: "none"; jobIds: ReadonlySet<number> }
  | { state: "unresolved" };

type RowCandidateWalk =
  | { state: "resolved"; candidateId: number }
  | { state: "none" }
  | { state: "unresolved" };

async function resolveRowCandidate(
  row: Record<string, unknown>,
  context: ScopeContext
): Promise<RowCandidate> {
  const jobIds = new Set<number>();
  const walked = await walkRowCandidate(row, context, jobIds, 0);
  if (walked.state === "unresolved") return { state: "unresolved" };
  // Two carriers that walked to DIFFERENT reqs do not describe a row on both of them; they describe
  // a row whose req is unknown. On the privacy-only branches that is `unresolved` and withheld,
  // because the two callers of this both spend the answer on a per-job question — "does the actor
  // hold Private on this row's job", "is this row on a confidential job" — and a union answers yes
  // to either as soon as ONE walked job qualifies. The engines keep the union: they were already
  // deciding job scope from it, and narrowing it here would withhold rows from job-scoped
  // recruiters for a reason unrelated to privacy.
  if (context.strictCarrierResolution === true && jobIds.size > 1) return { state: "unresolved" };
  if (walked.state === "none") return { state: "none", jobIds };
  return { state: "resolved", candidateId: walked.candidateId, jobIds };
}

/**
 * Walk one record's declared carriers to the candidate behind it, collecting the jobs on the way.
 *
 * Two carriers naming DIFFERENT candidates is `unresolved` and therefore withheld: a row that is
 * about two people cannot be admitted on the privacy of one of them, and picking the first is how
 * the leak got here.
 *
 * A row's own `candidate_id` is one of those carriers, not a verdict that ends the walk. Returning
 * on it meant a note that named a public candidate directly AND an `application_id` belonging to a
 * private one was handed over on the strength of the public name printed on it. It is treated as a
 * carrier only where `strictCarrierResolution` is set, i.e. on the privacy-only branches; the scope
 * engines keep the first-carrier-wins resolution they have always had, and pay no extra read for it
 * (a row that names its candidate still resolves without touching its siblings there).
 *
 * A carrier whose parent cannot be READ is likewise `unresolved` under that flag even when another
 * carrier answered — the row names a record nobody could check, and on a privacy-only branch the
 * cost of that is one withheld row. Without the flag it stays what it has always been: unresolved
 * only when nothing else on the record resolved, so a stale sibling id does not drop a row from a
 * job-scoped recruiter's page.
 *
 * Depth is bounded by the declared hop count, so a cyclic parent shape terminates rather than
 * spinning; the branching is over the four declared carriers, and every parent read goes through
 * the per-read caches the primers filled.
 */
async function walkRowCandidate(
  record: Record<string, unknown>,
  context: ScopeContext,
  jobIds: Set<number>,
  depth: number
): Promise<RowCandidateWalk> {
  const strict = context.strictCarrierResolution === true;
  const own = rowOwnJob(record, context.applicationTerminal);
  if (own.state === "resolved") jobIds.add(own.jobId);

  const direct = extractAssociatedCandidateId(record);
  if (direct !== null && !strict) return { state: "resolved", candidateId: direct };
  // The cycle bound. A record that names its candidate answers even here — refusing to would turn
  // the loop guard into a denial — but no further hop is taken from it.
  if (depth >= CANDIDATE_PARENT_HOPS.length) {
    return direct === null ? { state: "unresolved" } : { state: "resolved", candidateId: direct };
  }

  const hops = candidateParentHopsFor(record);
  if (hops.length === 0) {
    return direct === null ? { state: "none" } : { state: "resolved", candidateId: direct };
  }

  // Seeded with the row's own association, so a sibling carrier that walks to somebody else is a
  // conflict rather than a second opinion nobody compares against.
  let candidateId: number | null = direct;
  let sawUnresolved = false;
  let conflict = false;
  for (const next of hops) {
    const parent = await loadParentRecord(context, next.hop.endpoint, next.id);
    if (!parent) {
      sawUnresolved = true;
      continue;
    }
    const walked = await walkRowCandidate(parent, context, jobIds, depth + 1);
    if (walked.state === "unresolved") {
      sawUnresolved = true;
      continue;
    }
    if (walked.state === "none") continue;
    if (candidateId === null) candidateId = walked.candidateId;
    else if (candidateId !== walked.candidateId) conflict = true;
  }
  if (conflict) return { state: "unresolved" };
  if (strict && sawUnresolved) return { state: "unresolved" };
  if (candidateId !== null) return { state: "resolved", candidateId };
  return sawUnresolved ? { state: "unresolved" } : { state: "none" };
}

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
  const candidateRowTool = CANDIDATE_ROW_TOOLS.has(toolName);
  // Bounded batches, in dependency order: the parent chain the kept rows hang off (so a row that
  // names no candidate directly can still reach one, however many hops away), then the candidates
  // named ON the rows, then the candidates reached only THROUGH those parents. All are no-ops for
  // ids already cached, which is the common case — the row filters and the scope-policy join have
  // usually loaded them already.
  await primeCandidateParents(rows, context);
  await prefetchScopeParents(rows, context);
  await prefetchCandidatesBehindParents(rows, context);
  // The deferred private-capable resolution (operator branch), taken only now: every parent and
  // privacy answer this needs is already cached, so deciding whether the page holds a private row
  // at all costs no round trip — and a page with none never triggers the permission sweep.
  const resolveLater = context.resolvePrivateCapableJobIds;
  if (resolveLater) {
    context.resolvePrivateCapableJobIds = undefined;
    if (await pageHoldsPrivateCandidate(rows, context, candidateRowTool)) {
      context.privateCapableJobIds = await resolveLater();
    }
  }
  // Last, and only when the actor holds a private-capable role somewhere: the applications of the
  // private candidates whose per-job admission is about to be decided one row at a time.
  await primePrivateCandidateApplications(rows, context, candidateRowTool);

  const kept: Record<string, unknown>[] = [];
  let withheld = 0;
  for (const row of rows) {
    // A join failure here withholds THIS row, not the page. Letting a PermissionJoinError out would
    // turn one unreadable application into a denial of every row beside it — an over-withhold, and
    // an unnecessary one: the row it could not resolve is dropped either way. An abort still
    // propagates, because that is the caller giving up rather than a scoping failure.
    let verdict: "keep" | "withhold";
    try {
      if (candidateRowTool) {
        // Private — kept only where Greenhouse itself grants this actor private access, exactly as
        // the join-backed branch below decides it.
        verdict =
          row.private === false || (await actorHoldsPrivateAccessToRow(row, context))
            ? "keep"
            : "withhold";
        if (verdict === "withhold") {
          withheld += 1;
          continue;
        }
        kept.push(row);
        continue;
      }
      const candidate = await resolveRowCandidate(row, context);
      if (candidate.state === "unresolved") {
        // A parent this row's candidate sits behind could not be read, so whether the row is a
        // private candidate's is UNKNOWN — and unknown privacy has never been "not private"
        // anywhere else in this file. Withheld for every tool, not just the candidate-substance
        // ones: the tool list decides what a row with genuinely NO candidate means, never what a
        // failed join means.
        verdict = "withhold";
      } else if (candidate.state === "none") {
        // Not candidate substance at all (a job, an opening, a job-level interview, a dictionary
        // row) — nothing to gate, unless this is a tool whose every row must resolve to a candidate.
        verdict = mustResolveCandidate ? "withhold" : "keep";
      } else if (!(await loadCandidateIsPrivate(context, candidate.candidateId))) {
        verdict = "keep";
      } else {
        // Private — kept only where Greenhouse itself grants this actor private access, and only on
        // the job THIS row sits on. The jobs the resolver walked through are handed down for that:
        // without them a multi-hop row fell back to the candidate's whole application set, so an
        // actor holding the "Private" Job Admin role on one req was admitted to that candidate's
        // interviewer and scorecard-answer rows on every req they touched. The resolved candidate id
        // still rides along for the candidate-level shapes, whose chain establishes no job at all.
        verdict = (await actorHoldsPrivateAccessToRow(
          row,
          context,
          candidate.candidateId,
          candidate.jobIds
        ))
          ? "keep"
          : "withhold";
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
  context: ScopeContext,
  // The candidate the privacy gate resolved for this row, for the multi-hop shapes that carry no
  // candidate id of their own. Optional and consulted only after the row's own association: every
  // pre-existing caller passes nothing and behaves exactly as before.
  resolvedCandidateId?: number,
  // The jobs the privacy resolver WALKED THROUGH to reach that candidate — the interview's job, the
  // application's job. When the walk established any, they are the answer: they are this row's own
  // jobs, and the candidate-application union below would widen a per-req grant into an org-wide
  // one for every multi-hop row. Empty or absent leaves the pre-existing resolution untouched.
  viaJobIds?: ReadonlySet<number>
): Promise<boolean> {
  if (context.privateCapableJobIds.size === 0) return false;
  if (viaJobIds && viaJobIds.size > 0) return intersects(viaJobIds, context.privateCapableJobIds);

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

  const candidateId =
    extractAssociatedCandidateId(row) ?? resolvedCandidateId ?? extractCandidateId(row);
  if (candidateId === null) return false;
  const applications = await loadCandidateApplications(context, candidateId);
  return applications.some((application) => {
    const jobId = applicationJobId(application, context.applicationTerminal);
    return jobId !== null && context.privateCapableJobIds.has(jobId);
  });
}

/**
 * Batch-load the whole parent chain the kept rows hang off, one level at a time.
 *
 * Without this the resolver would fall back to a per-row parent read — one round trip each, per
 * hop — which on a full page is precisely the sequential-join latency the batching elsewhere exists
 * to avoid. Each level issues one read per 50 ids per endpoint and then walks the records it loaded,
 * so a three-hop chain over a hundred rows costs three batched reads rather than three hundred.
 *
 * Best-effort by the same rule as the other primers: a failed batch seeds nothing and the per-row
 * loader does its own read (and raises its own PermissionJoinError, which the gate turns into a
 * withhold for that row). Never swallows an abort.
 */
async function primeCandidateParents(
  rows: readonly Record<string, unknown>[],
  context: ScopeContext
): Promise<void> {
  let frontier: readonly Record<string, unknown>[] = rows;
  for (let depth = 0; depth < CANDIDATE_PARENT_HOPS.length && frontier.length > 0; depth += 1) {
    const wanted = new Map<string, Set<number>>();
    for (const row of frontier) {
      // A record that names its own candidate ends the walk on the scope engines, so its siblings
      // are never read there and must not be primed. Under `strictCarrierResolution` the walk keeps
      // going, and skipping here would leave every one of those siblings to a per-row read inside
      // the decision loop — the N+1 this primer exists to prevent.
      if (context.strictCarrierResolution !== true && extractAssociatedCandidateId(row) !== null) continue;
      // Every declared carrier, matching the walk: priming only the first left the second hop of a
      // dual-carrier row to a per-row read inside the decision loop.
      for (const next of candidateParentHopsFor(row)) {
        if (parentCacheFor(context, next.hop.endpoint).has(next.id)) continue;
        const ids = wanted.get(next.hop.endpoint) ?? new Set<number>();
        ids.add(next.id);
        wanted.set(next.hop.endpoint, ids);
      }
    }
    if (wanted.size === 0) return;

    const loaded: Record<string, unknown>[] = [];
    for (const [endpoint, ids] of wanted) {
      const pages = await mapWithConcurrency(chunks([...ids], PARENT_BATCH_SIZE), async (batch) => {
        try {
          const response = await context.rawReader.read<unknown[]>(
            endpoint,
            { ids: batch.join(","), per_page: 100 },
            undefined,
            context.signal
          );
          return { ids: batch, rows: Array.isArray(response.data) ? response.data.filter(isRecord) : [] };
        } catch (error) {
          if (context.signal?.aborted) throw context.signal.reason;
          return { ids: batch, rows: null };
        }
      });
      const cache = parentCacheFor(context, endpoint);
      for (const page of pages) {
        if (page.rows === null) {
          // Same rule as the privacy batch: on a privacy-only branch a parent nobody could read is
          // an unresolved chain, which the gate withholds — seeding `null` reaches that verdict
          // without fifty more reads of the endpoint that just failed.
          if (!context.failClosedOnBatchFailure) continue;
          for (const id of page.ids) {
            if (cache.has(id)) continue;
            cache.set(id, Promise.resolve(null));
          }
          continue;
        }
        for (const parent of page.rows) {
          const id = readPositiveInteger(parent.id);
          if (id === null || cache.has(id)) continue;
          cache.set(id, Promise.resolve(parent));
          loaded.push(parent);
        }
        // A batch can SUCCEED and still answer for nobody — a 200 carrying `[]`, or a page that
        // names only some of the ids asked for (a deleted parent, one the credential cannot read).
        // Caching only what came back left every absentee to its own per-id retry of the endpoint
        // that just declined to name it: a hundred answer rows whose `/scorecards` batch returned
        // `[]` cost 103 calls. `per_page` is set so a full chunk of 50 always lands in one page, so
        // an absent id is a real absence and not pagination. Same verdict as a failed batch, and
        // only on the privacy-only branches, where an unreadable parent withholds ITS row.
        if (!context.failClosedOnBatchFailure) continue;
        for (const id of page.ids) {
          if (cache.has(id)) continue;
          cache.set(id, Promise.resolve(null));
        }
      }
    }
    frontier = loaded;
  }
}

/**
 * Batch the privacy lookup for candidates reachable only THROUGH the parent chain.
 *
 * Runs after the parents are cached, so it resolves each row's candidate id out of the caches
 * without a round trip and hands the whole set to one batched privacy read. A row whose chain
 * cannot be walked is skipped here and decided (as a withhold) by the gate itself.
 */
async function prefetchCandidatesBehindParents(
  rows: readonly Record<string, unknown>[],
  context: ScopeContext
): Promise<void> {
  const carriers: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (extractAssociatedCandidateId(row) !== null) continue;
    let resolved: RowCandidate;
    try {
      resolved = await resolveRowCandidate(row, context);
    } catch (error) {
      if (context.signal?.aborted) throw context.signal.reason;
      continue;
    }
    if (resolved.state === "resolved") carriers.push({ candidate_id: resolved.candidateId });
  }
  if (carriers.length > 0) await prefetchScopeParents(carriers, context);
}

/**
 * Batch the applications of the PRIVATE candidates whose per-job admission is about to be decided.
 *
 * `actorHoldsPrivateAccessToRow` falls back to "does any of this candidate's applications sit on a
 * private-capable job", which reads `/applications?candidate_ids=<one id>` — one round trip per
 * private row, sequentially, inside the decision loop. That is the same N+1 the parent primers
 * exist to kill, and it fires exactly when the actor DOES hold a per-job private role, i.e. on the
 * path the amendment added.
 *
 * Costs nothing when the actor holds no private-capable role (the fallback is never reached), and
 * nothing for rows that resolve their job directly or through an application they name. A batch
 * that fails, or that paginates past a sane page cap, seeds nothing and leaves the per-row loader
 * to do its own read.
 */
/**
 * Does this page contain a row whose candidate is flagged private?
 *
 * Read entirely out of the caches the primers just filled, so it costs no round trip. Any row whose
 * chain cannot be walked is skipped — it will be withheld by the gate regardless, and it is not a
 * reason to spend a permission sweep.
 */
async function pageHoldsPrivateCandidate(
  rows: readonly Record<string, unknown>[],
  context: ScopeContext,
  candidateRowTool: boolean
): Promise<boolean> {
  for (const row of rows) {
    try {
      if (candidateRowTool) {
        if (row.private !== false) return true;
        continue;
      }
      const candidate = await resolveRowCandidate(row, context);
      if (candidate.state !== "resolved") continue;
      if (await loadCandidateIsPrivate(context, candidate.candidateId)) return true;
    } catch (error) {
      if (context.signal?.aborted) throw context.signal.reason;
      continue;
    }
  }
  return false;
}

async function primePrivateCandidateApplications(
  rows: readonly Record<string, unknown>[],
  context: ScopeContext,
  candidateRowTool: boolean
): Promise<void> {
  if (context.privateCapableJobIds.size === 0) return;

  const wanted = new Set<number>();
  for (const row of rows) {
    // Only rows that will actually reach the candidate-applications fallback: a row whose own job,
    // named application, or embedded applications answer the question never gets there.
    if (rowOwnJob(row, context.applicationTerminal).state !== "absent") continue;
    if (readPositiveInteger(row.application_id) !== null) continue;
    if (readRecordArray(row.applications)) continue;

    let candidateId: number | null = null;
    let isPrivate = false;
    try {
      if (candidateRowTool) {
        candidateId = extractCandidateId(row);
        isPrivate = row.private !== false;
      } else {
        const resolved = await resolveRowCandidate(row, context);
        // A row whose walked chain named a job never reaches the candidate-applications fallback —
        // the per-job check is decided on that job — so it must not pull a batch either.
        if (resolved.state !== "unresolved" && resolved.jobIds.size > 0) continue;
        candidateId = resolved.state === "resolved" ? resolved.candidateId : null;
        isPrivate = candidateId !== null && (await loadCandidateIsPrivate(context, candidateId));
      }
    } catch (error) {
      if (context.signal?.aborted) throw context.signal.reason;
      continue;
    }
    if (!isPrivate || candidateId === null) continue;
    if (context.candidateApplicationsCache.has(candidateId)) continue;
    wanted.add(candidateId);
  }
  if (wanted.size === 0) return;

  for (const batch of chunks([...wanted], PARENT_BATCH_SIZE)) {
    const applications: Record<string, unknown>[] = [];
    let usable = true;
    let cursor: string | null = null;
    let pagesRead = 0;
    try {
      do {
        const response: ApiResponse<unknown[]> = await context.rawReader.read<unknown[]>(
          "/applications",
          cursor ? {} : { candidate_ids: batch.join(","), per_page: 500 },
          cursor ?? undefined,
          context.signal
        );
        if (!Array.isArray(response.data)) {
          usable = false;
          break;
        }
        applications.push(...response.data.filter(isRecord));
        cursor = response.nextCursor;
        pagesRead += 1;
        // 50 candidates x 500 rows a page is already an implausible fan-out; past this the batch is
        // abandoned rather than paginated forever, and each candidate pays its own single read.
        if (pagesRead >= 10 && cursor) {
          usable = false;
          break;
        }
      } while (cursor);
    } catch (error) {
      if (context.signal?.aborted) throw context.signal.reason;
      usable = false;
    }
    if (!usable) {
      // Fail closed rather than let each of the batch's candidates re-read /applications on its
      // own: an empty application list means no private-capable job can be established for them,
      // which is the withhold the per-row read would have reached anyway.
      if (context.failClosedOnBatchFailure) {
        for (const candidateId of batch) {
          if (context.candidateApplicationsCache.has(candidateId)) continue;
          context.candidateApplicationsCache.set(candidateId, Promise.resolve([]));
        }
      }
      continue;
    }

    const byCandidate = new Map<number, Record<string, unknown>[]>();
    for (const candidateId of batch) byCandidate.set(candidateId, []);
    for (const application of applications) {
      const candidateId = extractAssociatedCandidateId(application);
      if (candidateId === null) continue;
      byCandidate.get(candidateId)?.push(application);
      const applicationId = readPositiveInteger(application.id);
      if (applicationId !== null && !context.applicationCache.has(applicationId)) {
        context.applicationCache.set(applicationId, Promise.resolve(application));
      }
    }
    for (const [candidateId, rowsForCandidate] of byCandidate) {
      if (context.candidateApplicationsCache.has(candidateId)) continue;
      context.candidateApplicationsCache.set(candidateId, Promise.resolve(rowsForCandidate));
    }
  }
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
    // A join whose target is one of the privacy chain's hops has just loaded, in bounded batches,
    // exactly the rows the gate would otherwise fetch one at a time to reach each row's candidate.
    // Seed the shared parent cache so the gate reuses this read instead of duplicating it — for
    // /applications, and equally for the /scorecards, /interviews and /scorecard_question_answers
    // hops the multi-hop tools travel through.
    const targetEndpoint = dependency.targetEndpoint.replace(/^\/v3(?=\/)/, "");
    if (CANDIDATE_PARENT_HOPS.some((hop) => hop.endpoint === targetEndpoint)) {
      const parentId = readPositiveInteger(row.id);
      const cache = parentCacheFor(context, targetEndpoint);
      if (parentId !== null && !cache.has(parentId)) {
        cache.set(parentId, Promise.resolve(row));
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
    // R2b. The pool behind a tag name: search_my_candidate_tags gives the dictionary, this gives who
    // carries which tag. Candidate-backed, so the private-candidate gate runs on every row.
    ["list_applied_candidate_tags", listTool("/applied_candidate_tags", filterCandidateBackedRow)],
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
    // R2b. The permission-role dictionary: role names plus the two-value role_type taxonomy that
    // decode the role_id on /user_job_permissions and /future_job_permissions. No PII, no per-user
    // rows — it is the same class of id->name dictionary as /departments.
    ["list_user_roles", globalReferenceListTool("/user_roles")],
    // R2b. Org email copy: the template a rejection or an availability request sends, and the
    // template_id a future write needs. `recipients` is projected back to site admins and operators
    // only (the teammate-email rule); everything else is company copy every recruiter sends.
    ["list_email_templates", globalReferenceListTool("/email_templates")],
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
    // R2b. The finer post-level location (city, region, lat/long) behind the coarse country tags the
    // server instructions apologise for. The row carries job_post_id and NO job_id, so it is bound
    // through the same job_post_id -> /job_posts -> job_id chain as /job_post_locations, never as a
    // direct job-scoped row (which would have resolved every row unresolved and withheld the page).
    ["list_job_post_searchable_locations", policyListTool("/job_post_searchable_locations")],
    // R2d. The candidate-attribute (structured rubric) family. Each is bound to the field its row
    // ACTUALLY carries: job_candidate_attributes and candidate_attribute_types carry job_id;
    // scorecard_candidate_attributes carries scorecard_id; focus_candidate_attributes and
    // scorecard_question_candidate_attributes carry neither and reach a job through the kit/question
    // chain, so they are policy-driven like the rest of the rubric structure.
    ["list_job_candidate_attributes", listTool("/job_candidate_attributes", filterDirectJobScopedRow)],
    ["list_candidate_attribute_types", listTool("/candidate_attribute_types", filterDirectJobScopedRow)],
    ["list_scorecard_candidate_attributes", listTool("/scorecard_candidate_attributes", filterScorecardBackedRow)],
    ["list_focus_candidate_attributes", policyListTool("/focus_candidate_attributes")],
    ["list_scorecard_question_candidate_attributes", policyListTool("/scorecard_question_candidate_attributes")],
    // R2d. "Who else can see this req" — bounded to the reader's OWN reqs by the same direct job
    // filter every job-scoped read uses, so it is never an org-wide view of who has access to what.
    ["list_user_job_permissions", listTool("/user_job_permissions", filterDirectJobScopedRow)],
    // R2d. Staff configuration and operational diagnostics, none of which can carry a candidate row.
    // future_job_permissions and user_emails additionally return rows only to a site admin or
    // operator (evidence-projection.ts operatorOnlyProjector) — Greenhouse restricts its own
    // permission and staff-directory settings to site admins, and this surface does not open a side
    // door around that.
    ["list_future_job_permissions", globalReferenceListTool("/future_job_permissions")],
    ["list_user_emails", globalReferenceListTool("/user_emails")],
    ["list_bulk_requests", globalReferenceListTool("/bulk_requests")],
    // R2e. The single bulk request, fetched by its uuid. Same rows as the list read filtered by
    // bulk_action_uuid, plus the signed result files' URLs — which the projection drops, exactly as
    // it drops a signed attachment URL. Bound because "did the bulk update I ran an hour ago
    // finish, and what failed" is a question with a uuid in hand and no list filter needed.
    ["get_bulk_request", pathParamGetTool("/bulk_requests", "bulk_action_uuid")],
    ["list_blocked_spam_sources", globalReferenceListTool("/blocked_spam_sources")],
    ["list_job_board_custom_locations", globalReferenceListTool("/job_board_custom_locations")],
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

/**
 * Endpoint query filters that COLLIDE with an actor-identity parameter name.
 *
 * The identity guard below drops `email` (and the other actor-naming keys) unconditionally, because
 * on every other endpoint such a param is an attempt to say WHO the read runs as — and the actor is
 * resolved from the session, never from params. On these two endpoints `email` is not that: it is
 * the endpoint's own documented filter over its own rows (`/v3/user_emails` filters the staff
 * directory it returns; `/v3/candidates` filters candidates by their address, which is how
 * "where is jane@example.com in process" is answered). Dropping it there silently returned the whole
 * directory to an admin who asked for one colleague, and silently ignored the filter the
 * `search_my_candidates` description tells the model to use.
 *
 * Exact endpoint+param pairs only, so a new endpoint cannot inherit the exemption, and the actor
 * cannot be re-named through it: nothing here decides WHOSE permissions the read runs under.
 */
const ENDPOINT_QUERY_FILTER_PARAMS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["/user_emails", new Set(["email"])],
  ["/candidates", new Set(["email"])],
]);

function isEndpointQueryFilterParam(endpoint: string | undefined, key: string): boolean {
  return endpoint !== undefined && (ENDPOINT_QUERY_FILTER_PARAMS.get(endpoint)?.has(key) ?? false);
}

function sanitizeReadParams(params: Record<string, unknown>, endpoint?: string): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (isIdentityParamName(key) && !isEndpointQueryFilterParam(endpoint, key)) continue;
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
    rowFilter: filterRow,
    endpoint: path,
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
    rowFilter: filterRow,
    endpoint: path,
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
      return { ids, rows: null };
    }
  });

  for (const page of pages) {
    if (page.rows === null) {
      // A failed batch on a privacy-only branch: seed every id in it as private. That is the same
      // verdict the per-row loader's PermissionJoinError produces one row at a time (unknown
      // privacy has never been "not private" here) — this only stops fifty rows from each paying
      // for the same failure. On the scope engines the flag is unset and the per-row loader still
      // raises, so their whole-read denial is untouched.
      if (!context.failClosedOnBatchFailure) continue;
      for (const id of page.ids) {
        if (context.candidatePrivacyCache.has(id)) continue;
        context.candidatePrivacyCache.set(id, Promise.resolve(true));
      }
      continue;
    }
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
    endpoint: path,
  };
}

/**
 * A single-record read whose id lives in the PATH rather than in an `ids` filter.
 *
 * `/v3/bulk_requests/{bulk_action_uuid}` is the only such endpoint bound today. The id is validated
 * against a strict character class before it is interpolated — a path segment assembled from caller
 * input is exactly where a `..%2f` would reach another resource — and the read carries no query
 * params at all, so nothing else can ride along.
 */
function pathParamGetTool(basePath: string, paramName: string): ToolRegistration {
  const endpoint = `${basePath}/{${paramName}}`;
  return {
    async execute(rawReader, params, signal) {
      const raw = params[paramName];
      const id = typeof raw === "string" ? raw.trim() : "";
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
        throw new Error(`Scoped Greenhouse read requires a valid ${paramName} for ${endpoint}.`);
      }
      const response = await rawReader.read<unknown>(`${basePath}/${id}`, {}, undefined, signal);
      return {
        ...response,
        data: isRecord(response.data) ? response.data : null,
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
    endpoint,
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
    endpoint: path,
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
    // Rebuilt field by field rather than spread, deliberately: this clone is the choke point every
    // provider answer passes through (`normalizePermissionScope`), so a field that is not named
    // here is a field the reader never sees. Anything added to the all-branch must be added here
    // too — a silently dropped `privateCandidatesAttested` would withhold private candidates from
    // an attested admin, and a silently dropped `privateCapableJobIds` would withhold them from an
    // unattested one on their own reqs.
    return {
      kind: "all",
      ...(scope.excludedJobIds ? { excludedJobIds: new Set(scope.excludedJobIds) } : {}),
      // The proven-site-admin signal is a field the reader never sees unless it is named here.
      // Dropping it would silently demote every site admin to the non-admin projection.
      ...(scope.siteAdmin === true ? { siteAdmin: true } : {}),
      ...(scope.privateCandidatesAttested === undefined
        ? {}
        : { privateCandidatesAttested: scope.privateCandidatesAttested }),
      ...(scope.privateCapableJobIds
        ? { privateCapableJobIds: new Set(scope.privateCapableJobIds) }
        : {}),
    };
  }
  // Same field-by-field rule as the all-branch: a proven site-admin role narrowed to explicit job
  // grants is still a proven role, and a clone that dropped it would demote the admin on every
  // permission refresh.
  return {
    kind: "jobs",
    jobIds: new Set(scope.jobIds),
    ...(scope.privateCapableJobIds ? { privateCapableJobIds: new Set(scope.privateCapableJobIds) } : {}),
    ...(scope.siteAdmin === true ? { siteAdmin: true } : {}),
  };
}

// A bare Set is still the accepted shape from a custom provider, but it can carry neither the
// private-capable subset nor the proven site-admin role — so a scope that HAS either is returned as
// the object form. Returning the Set here would silently drop them every time the answer came from
// the cache: private candidates withheld from an actor Greenhouse grants them to, or a proven admin
// demoted to the line-recruiter projection.
function clonePermissionLookupResult(scope: PermissionScope): PermissionLookupResult {
  if (scope.kind === "all") return clonePermissionScope(scope);
  return scope.privateCapableJobIds || scope.siteAdmin === true ? clonePermissionScope(scope) : new Set(scope.jobIds);
}

function isPermissionScope(value: unknown): value is PermissionScope {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === "all") {
    // The optional fields are validated rather than waved through: a provider that answered
    // `privateCandidatesAttested: "true"` (a string out of a JSON config) must not be read as
    // attested, and `=== true` is the only thing the gate accepts anywhere.
    if (value.privateCandidatesAttested !== undefined && typeof value.privateCandidatesAttested !== "boolean") {
      return false;
    }
    // Same rule for the site-admin proof: a provider answering `siteAdmin: "true"` out of a JSON
    // config must not be read as a site admin.
    if (value.siteAdmin !== undefined && typeof value.siteAdmin !== "boolean") {
      return false;
    }
    return value.privateCapableJobIds === undefined || isSetLike(value.privateCapableJobIds);
  }
  if (value.kind !== "jobs" || !isSetLike(value.jobIds)) return false;
  // Same rule as the all-branch: a stringy `siteAdmin` out of a JSON config is not a proven role.
  return value.siteAdmin === undefined || typeof value.siteAdmin === "boolean";
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
