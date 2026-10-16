import type {
  PermissionLookupResult,
  PermissionProvider,
  RawReadClient,
} from "../../scoped-core/src/index.js";

/**
 * THE one place `siteAdmin: true` is stamped.
 *
 * Every all-access answer this wrapper returns carries it, and no other code path may: the flag is
 * what tells the projection layer that the org-wide scope came from Greenhouse's own
 * `/v3/users.site_admin` flag rather than from an all-jobs job-admin grant, which the BASE provider
 * answers with the same `{ kind: "all" }` shape. Downstream, the staff directory, standing
 * permission grants, teammate work emails and email-template recipients are gated on the flag — so
 * omitting it here withholds (fail-closed), and adding it anywhere else would grant the site-admin
 * view to someone whose site-admin status nobody read.
 *
 * Wraps a base PermissionProvider so that Greenhouse site admins receive
 * all-job access (`{ kind: "all" }`), matching their real Greenhouse authority:
 * a site admin has implicit access to every non-confidential job.
 *
 * This is necessary because site admins are deliberately NOT represented in
 * `/v3/user_job_permissions` (that resource only lists per-job Job-Admin grants),
 * so the base per-job-grant provider resolves a site admin to zero jobs — an
 * empty MCP. The user's site-admin status instead lives on the `site_admin`
 * boolean of the `/v3/users` resource, which this wrapper consults.
 *
 * Fail-closed: the all-access grant is returned ONLY when the user's
 * `site_admin` flag is literally `true`. A lookup failure, a missing user, an
 * id mismatch, or any non-`true` value falls through to the base provider
 * (per-job scoping). A failure NEVER widens access.
 */
export interface SiteAdminAwarePermissionProviderOptions {
  base: PermissionProvider;
  rawReader: RawReadClient;
  /** Injectable site-admin probe; defaults to a live `/v3/users` lookup. For tests. */
  detectSiteAdmin?: (greenhouseUserId: number, signal?: AbortSignal) => Promise<boolean>;
}

/**
 * The legacy confidential jobs a site admin is NOT implicitly entitled to.
 *
 * Greenhouse draws the line explicitly: a site admin has implicit access to every *non-confidential*
 * job, while a confidential job is "restricted to users explicitly granted access on the Hiring
 * Team". So the exclusion set is (confidential jobs) minus (the jobs this admin is explicitly
 * granted) — an admin who IS on the hiring team keeps the job, exactly as Greenhouse would have it.
 *
 * The set is small and frozen: the feature has been sunset, the flag cannot be set on new jobs, and
 * a tenant that never used it gets an empty set and the untouched raw read path.
 */
async function fetchConfidentialJobIds(
  rawReader: RawReadClient,
  signal?: AbortSignal
): Promise<Set<number>> {
  const jobIds = new Set<number>();
  let cursor: string | undefined;
  do {
    signal?.throwIfAborted();
    const page = await rawReader.read<unknown[]>(
      "/jobs",
      cursor ? {} : { confidential: true, per_page: 500, fields: "id,confidential" },
      cursor,
      signal
    );
    for (const row of Array.isArray(page.data) ? page.data : []) {
      if (!isRecord(row)) continue;
      // Trust the row's own flag, not just the filter: a server that ignored `confidential=true`
      // would otherwise turn every job in the tenant into an exclusion and black out the admin.
      if (row.confidential !== true) continue;
      const id = readPositiveId(row.id);
      if (id !== null) jobIds.add(id);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return jobIds;
}

export function createSiteAdminAwarePermissionProvider(
  options: SiteAdminAwarePermissionProviderOptions
): PermissionProvider {
  const detect =
    options.detectSiteAdmin ?? ((id: number, signal?: AbortSignal) => fetchIsSiteAdmin(options.rawReader, id, signal));
  return {
    async getPermittedJobIds(greenhouseUserId: number, signal?: AbortSignal): Promise<PermissionLookupResult> {
      signal?.throwIfAborted();
      let isSiteAdmin = false;
      try {
        isSiteAdmin = await detect(greenhouseUserId, signal);
      } catch {
        if (signal?.aborted) throw signal.reason;
        // Fail closed: a site-admin probe failure must never widen access to all.
        isSiteAdmin = false;
      }
      if (isSiteAdmin) {
        signal?.throwIfAborted();
        let confidentialJobIds: Set<number>;
        try {
          confidentialJobIds = await fetchConfidentialJobIds(options.rawReader, signal);
        } catch {
          if (signal?.aborted) throw signal.reason;
          // Same fail-closed direction as the site-admin probe above: if we cannot establish which
          // jobs Greenhouse restricts, we must not hand out an unrestricted org-wide read. Falling
          // back to the admin's explicit per-job grants withholds rather than widens, and it is not
          // an outage — every job they are actually on still resolves.
          //
          // The ROLE, though, is not in question here and must not fall with the job scope: /users
          // answered, and it said site admin. Discarding the proof on an unrelated /jobs failure
          // demoted a proven admin to the line-recruiter projection — the staff directory, standing
          // permission grants, template recipients and teammate work emails all vanished — for a
          // narrowing that has nothing to do with who they are. Job scope narrows; the role stays.
          return withSiteAdminProof(await options.base.getPermittedJobIds(greenhouseUserId, signal));
        }
        if (confidentialJobIds.size === 0) {
          // No base call: widening to `all` needs nothing from it, and a /user_job_permissions
          // sweep here would be paid by every site admin on every permission refresh. The
          // attestation stamp asks for the actor's private-capable grants only when it needs them
          // (an UNATTESTED actor), which is the one case where that sweep buys something.
          return { kind: "all", siteAdmin: true };
        }
        // An admin explicitly on a confidential job's hiring team keeps it: those grants DO appear
        // in /v3/user_job_permissions, which is what the base provider reads.
        const granted = await options.base.getPermittedJobIds(greenhouseUserId, signal);
        const grantedJobIds: ReadonlySet<number> | null =
          "kind" in granted ? (granted.kind === "jobs" ? granted.jobIds : null) : granted;
        // The private-capable subset of those same grants rides along on the widened scope.
        // Discarding it here is what made an UNATTESTED site admin lose the private candidates
        // Greenhouse's own "Private" Job Admin role already gave them on their own reqs — and it
        // made the attestation stamp re-read /user_job_permissions to recover what this call had
        // just fetched and thrown away.
        //
        // Carried even when it is EMPTY, and that is the point: an absent field means "nobody
        // resolved this", which sends the stamp back to the base provider for a second
        // /user_job_permissions sweep it will answer identically. An empty SET means "resolved, and
        // this actor holds no private-capable role" — an answer, not silence. Every tenant with a
        // legacy confidential job and no Private roles was paying that second sweep on every
        // permission refresh.
        // A BARE SET is the base provider's own shorthand for a job scope with no private-capable
        // grants (`clonePermissionLookupResult` drops the `{kind:"jobs"}` wrapper when the subset is
        // empty), so it is an answer too — and it is the shape a tenant with no Private roles
        // actually produces, which is exactly the case that was paying twice.
        const privateCapableJobIds = !("kind" in granted)
          ? new Set<number>()
          : granted.kind === "jobs"
            ? new Set(granted.privateCapableJobIds ?? [])
            : undefined;
        const carry = privateCapableJobIds ? { privateCapableJobIds } : {};
        // A base provider that itself answered "all" cannot narrow anything; nothing is excluded.
        if (grantedJobIds === null) {
          const inherited =
            "kind" in granted && granted.kind === "all" && granted.privateCapableJobIds
              ? { privateCapableJobIds: new Set(granted.privateCapableJobIds) }
              : {};
          return { kind: "all", siteAdmin: true, ...inherited };
        }
        const excludedJobIds = new Set<number>();
        for (const jobId of confidentialJobIds) {
          if (!grantedJobIds.has(jobId)) excludedJobIds.add(jobId);
        }
        return excludedJobIds.size === 0
          ? { kind: "all", siteAdmin: true, ...carry }
          : { kind: "all", siteAdmin: true, excludedJobIds, ...carry };
      }
      signal?.throwIfAborted();
      return options.base.getPermittedJobIds(greenhouseUserId, signal);
    },
  };
}

/**
 * Stamp the proven role onto whatever shape the base provider answered with.
 *
 * The base provider's job answer is a bare Set, a `{kind:"jobs"}` scope or an org-wide scope; the
 * flag rides on all three. This is still the ONE place the flag is stamped — the proof is the
 * `/v3/users.site_admin` read a few lines above, and this function is only reached inside the branch
 * that read returned `true` for.
 */
function withSiteAdminProof(result: PermissionLookupResult): PermissionLookupResult {
  if (!("kind" in result)) return { kind: "jobs", jobIds: new Set(result), siteAdmin: true };
  return { ...result, siteAdmin: true };
}

/**
 * Resolves whether a Greenhouse user is a site admin via `/v3/users?ids=<id>`.
 * Returns `true` only when the matching row's `site_admin` is literally `true`.
 * The id-match guard means that even if the filter were ignored and the API
 * returned other users, a non-matching row can never grant all-access.
 */
export async function fetchIsSiteAdmin(
  rawReader: RawReadClient,
  greenhouseUserId: number,
  signal?: AbortSignal
): Promise<boolean> {
  const response = await rawReader.read<unknown[]>("/users", { ids: String(greenhouseUserId) }, undefined, signal);
  const rows = Array.isArray(response.data) ? response.data : [];
  for (const row of rows) {
    if (isRecord(row) && readPositiveId(row.id) === greenhouseUserId) {
      // A deactivated user keeps site_admin=true on the row (Greenhouse deactivation only
      // blocks sign-in + new-job assignment; it never strips the role), so gating on the
      // boolean alone grants a departed admin org-wide all-jobs access. Require active status.
      return row.site_admin === true && row.deactivated !== true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPositiveId(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}
