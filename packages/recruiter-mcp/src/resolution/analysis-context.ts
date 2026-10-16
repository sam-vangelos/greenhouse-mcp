import { type RecruiterToolRuntime, type ToolDeadline } from "../runtime.js";
import { isIdentityParamName } from "../limits.js";
import { loadJobInventory, type JobInventory, type JobInventoryRecord } from "../resolvers/job-scope/inventory.js";
import { resolveScopeSigner } from "../resolvers/job-scope/signer.js";
import { scopeHashOf } from "../resolvers/job-scope/scope-handle.js";
import type { AnalysisContextHeader, AnalysisContextResolution } from "./types.js";
import type { ProvenanceJobAnchor } from "./provenance.js";

/**
 * Build per-requisition open anchors for a resolved id set from inventory records already loaded for
 * permission validation. The provenance detector uses opened_at as the "req record" anchor to flag
 * records that predate the requisition — no extra Greenhouse read is needed.
 */
function buildJobAnchors(records: JobInventoryRecord[], resolvedIds: number[]): ProvenanceJobAnchor[] {
  const resolved = new Set(resolvedIds);
  const anchors: ProvenanceJobAnchor[] = [];
  for (const record of records) {
    if (resolved.has(record.greenhouse_job_id)) {
      anchors.push({ jobId: record.greenhouse_job_id, openedAt: record.opened_at });
    }
  }
  return anchors;
}

/**
 * Direct analysis tools accept only registered analysis controls plus the two
 * explicit scope carriers below. Natural-language job intent must go through
 * resolve_job_scope first; unknown params fail closed so future model-invented
 * free-text scope fields cannot slip through by omission.
 */
const ACCEPTED_ANALYSIS_PARAM_KEYS = new Set([
  "scope_handle",
  "job_ids",
  "window_start",
  "window_end",
  "max_rankings",
  "per_page",
  "cursor",
  "status",
  "due_days",
  "min_age_days",
  "include_terminal",
  "stale_days",
  "source_ids",
  "referrer_ids",
  "evidence_pack",
  "include_evidence_pack",
  "include_evidence",
  "evidence_pack_limit",
]);

/**
 * Return a params copy with the resolved job_ids applied and scope_handle
 * removed, so downstream scoped reads use the frozen/validated scope. All other
 * params are preserved unchanged.
 */
function withResolvedScope(
  params: Record<string, unknown>,
  scope: { jobIds?: string }
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params };
  delete next.scope_handle;
  if (scope.jobIds !== undefined) {
    next.job_ids = scope.jobIds;
  }
  return next;
}

export function findUnsupportedAnalysisParamKey(params: Record<string, unknown>): string | null {
  for (const key of Object.keys(params)) {
    if (ACCEPTED_ANALYSIS_PARAM_KEYS.has(key)) continue;
    if (isIdentityParamName(key)) continue;
    return key;
  }
  return null;
}

export async function resolveAnalysisContext(
  runtime: RecruiterToolRuntime,
  params: Record<string, unknown>,
  deadline?: ToolDeadline
): Promise<AnalysisContextResolution> {
  const unsupported = findUnsupportedAnalysisParamKey(params);
  if (unsupported) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: `Analysis tools do not accept parameter "${unsupported}". Resolve a scope_handle with resolve_job_scope first for job or role scope inputs.`,
    };
  }

  const scopeHandle = typeof params.scope_handle === "string" && params.scope_handle.trim().length > 0
    ? params.scope_handle.trim()
    : null;
  const hasJobIds = params.job_ids !== undefined && params.job_ids !== null;

  if (scopeHandle) {
    const redeemed = await redeemScopeHandle(runtime, scopeHandle, hasJobIds, deadline);
    return applyResolvedJobIds(params, redeemed);
  }

  if (hasJobIds) {
    const validated = await validateExactJobIds(runtime, params.job_ids, deadline);
    return applyResolvedJobIds(params, validated);
  }

  // No explicit scope. CLO-274: BOTH actor kinds get an answer over exactly what the scoped core
  // already lets them read — a narrow recruiter over their permitted book, a broad-visibility actor
  // org-wide — and the header NAMES which. The former fail-closed for broad-access actors bought no
  // access control (the scoped core is the permission floor either way; a confirmation round-trip
  // cannot make an org-wide read narrower) and cost the operator their answer. What survives is the
  // disclosure: no unscoped analysis returns without saying what it ran over.
  if (runtime.scopeContextResolved) {
    // An upstream planner already resolved, disclosed and gated scope before invoking this
    // recipe, so re-probing the permission-scoped inventory here is redundant.
    return { ok: true, params: { ...params }, header: null, warnings: [] };
  }
  const load = await loadJobInventory(runtime, deadline);
  if (!load.ok) {
    return { ok: false, code: load.code, message: load.message };
  }

  // One success return for both actor kinds; only the header differs. The inventory is already in
  // hand here, so provenance job anchors are built over the whole readable set. The default
  // no-scope call path is the most common real usage and previously carried NO anchors for a
  // recruiter and no answer at all for an operator, so the predate-requisition provenance signal
  // was silently inert where most questions run. Anchors are now built on every unscoped analysis,
  // whichever kind the actor is.
  return {
    ok: true,
    params: { ...params },
    header: buildPermissionScopeHeader(load.inventory),
    warnings: [],
    jobAnchors: buildJobAnchors(
      load.inventory.records,
      load.inventory.records.map((record) => record.greenhouse_job_id)
    ),
  };
}

/**
 * The disclosure header for an UNBOUNDED read: the analysis ran over everything this actor's
 * Greenhouse permissions return, and the label says which set that is and how big it is. A
 * truncated index is disclosed as a floor rather than presented as a total, and no scope_hash is
 * minted — there is no frozen id list to hash. Shared by the direct analyze_* path and the
 * question planner so a recruiter reads the same sentence wherever the answer came from.
 */
export function buildPermissionScopeHeader(
  inventory: JobInventory,
  extraWarnings: string[] = []
): AnalysisContextHeader {
  const count = inventory.records.length;
  const orgWide = inventory.scopeKind !== "jobs";
  const warnings = [...extraWarnings];
  if (!inventory.complete) {
    warnings.push(
      `The job index is truncated (${count} req(s) enumerated), so the count in the scope label is a floor, not a total.`
    );
  }
  return {
    primary_scope_domain: "job_scope",
    source: "permission_scope",
    scope_label: orgWide
      ? inventory.complete
        ? `all ${count} jobs you can see in Greenhouse (org-wide)`
        : `all jobs you can see in Greenhouse (org-wide; at least ${count} enumerated, index truncated)`
      : inventory.complete
        ? `all ${count} reqs you can see in Greenhouse`
        : `all reqs you can see in Greenhouse (at least ${count} enumerated, index truncated)`,
    job_count: count,
    warnings,
  };
}

export type JobScopeContextResolution =
  | { ok: true; jobIds?: string; header: AnalysisContextHeader | null; warnings: string[]; jobAnchors?: ProvenanceJobAnchor[] }
  | { ok: false; code: Extract<AnalysisContextResolution, { ok: false }>["code"]; message: string };

/**
 * Backward-compatible exact-id path. job_ids are never trusted just because they
 * are numeric: they are normalized, then validated against the live
 * permission-scoped inventory before any analysis runs. Any requested id that is
 * not currently accessible — or an inventory too incomplete to confirm it — fails
 * closed rather than silently passing through to the scoped read.
 */
export async function validateExactJobIds(
  runtime: RecruiterToolRuntime,
  jobIdsParam: unknown,
  deadline?: ToolDeadline
): Promise<JobScopeContextResolution> {
  const requested = normalizeJobIdsParam(jobIdsParam);
  if (requested === null) {
    return { ok: false, code: "INVALID_REQUEST", message: "job_ids must be positive Greenhouse job ids." };
  }
  if (requested.length === 0) {
    return { ok: false, code: "INVALID_REQUEST", message: "job_ids must contain at least one Greenhouse job id." };
  }

  const load = await loadJobInventory(runtime, deadline);
  if (!load.ok) {
    return { ok: false, code: load.code, message: load.message };
  }
  const accessibleIds = new Set(load.inventory.records.map((record) => record.greenhouse_job_id));
  const accessible = requested.filter((id) => accessibleIds.has(id));
  const missing = requested.filter((id) => !accessibleIds.has(id));

  if (missing.length > 0) {
    if (!load.inventory.complete) {
      // Truncated inventory: cannot prove the missing ids are inaccessible vs
      // merely unread. Fail closed (matters most for operator/all-scope actors,
      // whose inventory routinely exceeds the pagination cap).
      return {
        ok: false,
        code: "INVALID_REQUEST",
        message: "Job inventory is incomplete, so the requested job_ids could not be fully validated. Narrow the request or resolve a scope first.",
      };
    }
    // Distinguish a confidential job this actor IS assigned to (dropped from the
    // scoped index by confidential projection) from a genuinely unassigned job, so
    // the denial is diagnosable and not confused with "not assigned". This does
    // NOT broaden access — the scope is still denied; it only labels the reason.
    // confidentialExcludedIds only ever holds confidential jobs already in this
    // actor's permission-filtered inventory, so this reveals nothing about jobs
    // the actor was not already assigned to.
    const confidentialExcluded = new Set(load.inventory.confidentialExcludedIds);
    const confidentialMissing = missing.filter((id) => confidentialExcluded.has(id));
    if (confidentialMissing.length > 0 && confidentialMissing.length === missing.length) {
      return {
        ok: false,
        code: "ACTOR_DENIED",
        message: `${confidentialMissing.length} requested job id(s) are confidential and excluded from scoped analysis for this session; this is a confidential-scope exclusion, not a missing assignment. Analysis was denied.`,
      };
    }
    // Complete inventory and still missing => not accessible. Deny rather than
    // silently dropping the id and analyzing a narrower-than-requested scope.
    return {
      ok: false,
      code: "ACTOR_DENIED",
      message: `${missing.length} requested job id(s) are not accessible to this session; analysis was denied.`,
    };
  }
  if (accessible.length === 0) {
    return { ok: false, code: "ACTOR_DENIED", message: "No requested job is currently accessible; analysis was denied." };
  }

  return {
    ok: true,
    jobIds: accessible.join(","),
    header: {
      primary_scope_domain: "job_scope",
      source: "exact_ids",
      scope_label: null,
      scope_hash: scopeHashOf(accessible),
      job_count: accessible.length,
      warnings: [],
    },
    warnings: [],
    jobAnchors: buildJobAnchors(load.inventory.records, accessible),
  };
}

export async function redeemScopeHandle(
  runtime: RecruiterToolRuntime,
  scopeHandle: string,
  hasJobIds: boolean,
  deadline?: ToolDeadline
): Promise<JobScopeContextResolution> {
  const { signer } = resolveScopeSigner(runtime);
  const verification = signer.verifyScopeHandle(scopeHandle, {
    subject: runtime.session.subject,
    nowMs: runtime.now(),
  });
  if (!verification.ok) {
    if (verification.reason === "expired") {
      return { ok: false, code: "INVALID_REQUEST", message: "scope_handle has expired. Resolve a new scope." };
    }
    if (verification.reason === "forbidden") {
      return { ok: false, code: "ACTOR_DENIED", message: "scope_handle was not issued to this session." };
    }
    return { ok: false, code: "INVALID_REQUEST", message: "scope_handle is invalid." };
  }

  const payload = verification.payload;
  if (payload.complete !== true) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "scope_handle was frozen from an incomplete job inventory and cannot be analyzed.",
    };
  }

  const frozen = payload.jobs.filter((id) => Number.isSafeInteger(id) && id > 0);
  if (frozen.length === 0) {
    return { ok: false, code: "INVALID_REQUEST", message: "scope_handle contains no valid job ids." };
  }

  // Permission revalidation at analysis time: re-read the accessible inventory
  // and intersect with the frozen scope. A frozen scope never grants access by
  // itself; access that was revoked after freezing is dropped here.
  const load = await loadJobInventory(runtime, deadline);
  if (!load.ok) {
    return { ok: false, code: load.code, message: load.message };
  }
  const accessibleIds = new Set(load.inventory.records.map((record) => record.greenhouse_job_id));
  const accessibleFrozen = frozen.filter((id) => accessibleIds.has(id));
  const inaccessible = frozen.filter((id) => !accessibleIds.has(id));

  // Truncated live inventory: an absent frozen id cannot be told apart from a genuinely
  // revoked one (it may simply lie past the pagination cap). Narrowing the confirmed scope
  // on that ambiguity would silently analyze less than the recruiter froze and still
  // present it as complete. Fail closed exactly like validateExactJobIds rather than
  // conflate truncation with revocation. (A complete inventory keeps the warn+drop path:
  // there, an absent id is provably revoked.)
  if (inaccessible.length > 0 && !load.inventory.complete) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "Job inventory is incomplete, so the frozen scope could not be fully confirmed (truncation cannot be told from revocation). Narrow the scope or re-resolve before analyzing.",
    };
  }

  if (accessibleFrozen.length === 0) {
    return {
      ok: false,
      code: "ACTOR_DENIED",
      message: "scope_handle has no currently accessible jobs; access may have been revoked.",
    };
  }

  const warnings: string[] = [];
  if (hasJobIds) {
    warnings.push("scope_handle takes precedence; the supplied job_ids were ignored.");
  }
  if (inaccessible.length > 0) {
    warnings.push(`${inaccessible.length} job(s) in this scope are no longer accessible and were dropped.`);
  }

  const sorted = [...accessibleFrozen].sort((a, b) => a - b);
  return {
    ok: true,
    jobIds: sorted.join(","),
    header: {
      primary_scope_domain: "job_scope",
      source: "scope_handle",
      scope_label: payload.label,
      scope_hash: payload.hash,
      job_count: sorted.length,
      frozen_job_count: frozen.length,
      resolved_at: safeIso(payload.iat),
      expires_at: safeIso(payload.exp),
      inaccessible_job_ids: inaccessible,
      warnings,
    },
    warnings,
    jobAnchors: buildJobAnchors(load.inventory.records, sorted),
  };
}

function applyResolvedJobIds(
  params: Record<string, unknown>,
  resolution: JobScopeContextResolution
): AnalysisContextResolution {
  if (!resolution.ok) return resolution;
  return {
    ok: true,
    params: withResolvedScope(params, resolution),
    header: resolution.header,
    warnings: resolution.warnings,
    ...(resolution.jobAnchors ? { jobAnchors: resolution.jobAnchors } : {}),
  };
}

function normalizeJobIdsParam(value: unknown): number[] | null {
  const ids: number[] = [];
  const push = (raw: unknown): boolean => {
    if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) {
      ids.push(raw);
      return true;
    }
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (!/^\d+$/.test(trimmed)) return false;
      const parsed = Number.parseInt(trimmed, 10);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) return false;
      ids.push(parsed);
      return true;
    }
    return false;
  };

  if (typeof value === "string") {
    if (value.trim().length === 0) return [];
    for (const token of value.split(",")) {
      if (token.trim().length === 0) continue;
      if (!push(token)) return null;
    }
  } else if (Array.isArray(value)) {
    for (const entry of value) {
      if (!push(entry)) return null;
    }
  } else {
    return null;
  }
  return [...new Set(ids)].sort((a, b) => a - b);
}

function safeIso(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}
