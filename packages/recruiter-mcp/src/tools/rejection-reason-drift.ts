import { REJECTION_REASON_DRIFT_READ_PARAM_NAMES, assertWindowWithinLimit, hasExplicitAnalysisWindow, isToolEnabled, readPositiveInt, resolveAnalysisWindow, sanitizeReadParams } from "../limits.js";
import { createToolDeadline, deny, emitRequiredToolAudit, enforceUsageBudget, isToolCancelledError, isToolTimeoutError, type RecruiterToolRuntime, type ToolDeadline } from "../runtime.js";
import { newCorrelationId } from "../audit.js";
import { IdentityResolutionError } from "../identity.js";
import { buildEvidencePack, stripEvidencePackParams } from "./evidence-pack.js";
import { loadApplicationJobIdsFromScopedList, readApplicationBackedRowsForJobScope } from "./application-job-lookup.js";
import { referenceName, resolveReferenceNames } from "./reference-names.js";
import { resolveAnalysisContext } from "../resolution/analysis-context.js";
import { attachAnalysisScope, buildAnalysisCompleteness } from "../resolution/analysis-result.js";
import { detectDataProvenance } from "../resolution/provenance.js";
import { classifyUpstreamError, readAllScopedRows, readStatusMessage } from "../read-all.js";
import type { RecruiterToolDefinition, RecruiterToolResult } from "../types.js";

export const REJECTION_REASON_DRIFT_TOOL: RecruiterToolDefinition = {
  name: "analyze_rejection_reason_drift",
  kind: "analysis",
  description:
    "Rank structured rejection reasons by concentration across the recruiter's permitted jobs, resolving each rejection_reason_id to its name (or an honest 'unavailable' label for an archived/global id), with per-reason share, affected jobs, and evidence ids.",
};

interface RejectionDetailRow extends Record<string, unknown> {
  id?: unknown;
  application_id?: unknown;
  rejection_reason_id?: unknown;
  created_at?: unknown;
  rejected_at?: unknown;
}

interface ReasonAccumulator {
  reasonId: number;
  count: number;
  affectedJobs: Set<number>;
  evidenceIds: Set<string>;
}

export async function runRejectionReasonDrift(
  runtime: RecruiterToolRuntime,
  params: Record<string, unknown>
): Promise<RecruiterToolResult> {
  const toolName = REJECTION_REASON_DRIFT_TOOL.name;
  const startedAt = runtime.now();
  const deadline = createToolDeadline(runtime, startedAt);
  const correlationId = newCorrelationId(runtime.now);
  const actAsUser = runtime.trustedActAsUser ?? null;

  if (!isToolEnabled(runtime.toolConfig, runtime.session.surface, toolName, "analysis")) {
    const result = deny(toolName, "TOOL_DISABLED", "Rejection reason drift analysis is disabled for this runtime.");
    const auditDenied = await emitAnalysisAudit(runtime, startedAt, correlationId, result, null, null, actAsUser);
    return auditDenied ?? result;
  }

  const rateDenied = await enforceUsageBudget(runtime, toolName, "analysis", runtime.session.surface, startedAt, correlationId, actAsUser);
  if (rateDenied) return rateDenied;

  try {
    const scope = await resolveAnalysisContext(runtime, params, deadline);
    if (!scope.ok) {
      const result = deny(toolName, scope.code, scope.message);
      const auditDenied = await emitAnalysisAudit(runtime, startedAt, correlationId, result, null, null, actAsUser);
      return auditDenied ?? result;
    }
    params = scope.params;
    const requestedJobIds = parseRequestedJobIds(params.job_ids);
    const window = resolveAnalysisWindow(params, runtime.now, Math.min(90, runtime.limits.maxLookbackDays));
    // An EXPLICIT window runs free of maxLookbackDays (in-memory cap, guards no API cost).
    if (!hasExplicitAnalysisWindow(params)) assertWindowWithinLimit(window.windowStart, window.windowEnd, runtime.limits);
    const maxRankings = Math.min(readPositiveInt(params.max_rankings) ?? runtime.limits.maxRankings, runtime.limits.maxRankings);
    const maxEvidenceIds = runtime.limits.maxEvidenceIds;
    const detailParams = sanitizeReadParams(
      {
        ...params,
        per_page: params.per_page,
        created_at: `gte|${window.windowStart}`,
      },
      runtime.limits,
      { allowedParamNames: REJECTION_REASON_DRIFT_READ_PARAM_NAMES }
    );
    delete detailParams.max_rankings;
    delete detailParams.window_start;
    delete detailParams.window_end;
    stripEvidencePackParams(detailParams);
    // /v3/rejection_details has NO job_ids filter and Harvest 422s on it; never forward job_ids. A
    // narrowed scope is bridged job -> application_ids; the unscoped path reads all permitted rows.
    delete detailParams.job_ids;

    const details = requestedJobIds
      ? await readApplicationBackedRowsForJobScope<RejectionDetailRow>(runtime, toolName, "list_rejection_details", [...requestedJobIds], detailParams, deadline)
      : await readAllScopedRows<RejectionDetailRow>(runtime, toolName, "list_rejection_details", detailParams, deadline);
    if (details.kind === "denial") {
      const auditDenied = await emitAnalysisAudit(runtime, startedAt, correlationId, details.result, null, null, actAsUser);
      return auditDenied ?? details.result;
    }

    const windowed = details.rows.filter((row) => rejectionInWindow(row, window.windowStart, window.windowEnd));
    const outsideWindowCount = details.rows.length - windowed.length;
    const applicationJobIds = await loadApplicationJobIds(runtime, windowed, deadline);
    if (applicationJobIds.denial) {
      const result = deny(toolName, applicationJobIds.denial.code, applicationJobIds.denial.message);
      const auditDenied = await emitAnalysisAudit(runtime, startedAt, correlationId, result, null, null, actAsUser);
      return auditDenied ?? result;
    }
    // Re-apply the requested scope: a narrowed request must only count rejections on its own jobs.
    const inScope = requestedJobIds
      ? windowed.filter((row) =>
          requestedJobIds.has(applicationJobIds.jobIdsByApplication.get(readPositiveInt(row.application_id) as number) as number))
      : windowed;
    const outOfScopeCount = windowed.length - inScope.length;

    const reasonNames = inScope.length > 0
      ? await resolveReferenceNames(runtime, toolName, "list_rejection_reasons", deadline)
      : new Map<number, string>();

    const rankings = buildReasonRankings(inScope, applicationJobIds, maxEvidenceIds)
      .slice(0, maxRankings)
      .map((entry) => ({
        reason_id: entry.reasonId,
        reason_name: referenceName(reasonNames, entry.reasonId, "reason"),
        rejection_count: entry.count,
        share: ratio(entry.count, inScope.length),
        affected_jobs: [...entry.affectedJobs].sort((a, b) => a - b),
        evidence_ids: [...entry.evidenceIds].slice(0, maxEvidenceIds),
      }));

    const distinctReasons = new Set(
      inScope.map((row) => readPositiveInt(row.rejection_reason_id)).filter(isPositiveInteger)
    ).size;
    const unknownReasonCount = inScope.filter((row) => readPositiveInt(row.rejection_reason_id) === null).length;
    const evidencePack = buildEvidencePack(params, [{ name: "reason_rankings", rows: rankings }], runtime.limits.maxEvidenceIds);

    const provenance = detectDataProvenance(
      inScope.map((row) => ({
        timestamp: typeof row.created_at === "string" ? row.created_at : null,
        jobId: applicationJobIds.jobIdsByApplication.get(readPositiveInt(row.application_id) as number) ?? null,
      })),
      { nowMs: runtime.now(), jobAnchors: scope.jobAnchors }
    );

    const summary = {
      question: "rejection reason concentration / drift",
      window_start: window.windowStart,
      window_end: window.windowEnd,
      rows_read: details.rawRowsRead,
      pages_read: details.pagesRead,
      per_page: details.perPage,
      read_status: details.status,
      read_complete: details.complete,
      next_cursor: details.nextCursor,
      pagination_truncated: details.paginationTruncated,
      rate_limit_retries: details.rateLimitRetries,
      cache_hits: details.cacheHits,
      rate_limit_sleep_ms: details.rateLimitSleepMs,
      rows_considered: inScope.length,
      rows_dropped_outside_requested_scope: outOfScopeCount,
      unknown_reason_count: unknownReasonCount,
      scoped_job_count: countScopedJobs(applicationJobIds, requestedJobIds),
      read_warnings: details.warnings,
      field_limitations: [
        "Reason names are resolved from the /v3/rejection_reasons reference read; an archived or Greenhouse-global id absent from that list is labeled \"reason <id> (name unavailable)\", never dropped or shown as a bare number.",
        "Rejections without a structured rejection_reason_id are counted in unknown_reason_count and excluded from the ranked reasons.",
        "Reason concentration is a count/share snapshot over the window; per-candidate rejection review is not returned.",
      ],
    };
    const metrics = {
      rejections_considered: inScope.length,
      distinct_reasons: distinctReasons,
      unknown_reason_rejections: unknownReasonCount,
      top_reason_share: rankings.length > 0 ? rankings[0].share : 0,
    };
    const nextSteps = [
      "Use get_my_application with the returned application evidence ids to inspect affected scoped applications.",
      "Compare with analyze_pipeline_quality for overall rejection/fallout RATE versus reason concentration.",
    ];

    const envelope = attachAnalysisScope({
      data: {
        summary,
        metrics,
        reason_rankings: rankings,
        evidence_ids: rankings.flatMap((entry) => entry.evidence_ids).slice(0, maxEvidenceIds),
        denials: applicationJobIds.denials,
        next_steps: nextSteps,
        ...(evidencePack ? { evidence_pack: evidencePack } : {}),
      },
      completeness: buildAnalysisCompleteness({
        totalRecordsInScope: details.rows.length,
        recordsAnalyzed: inScope.length - unknownReasonCount,
        exclusionReasons: [
          ...(outsideWindowCount > 0 ? [{ reason: "outside_analysis_window", count: outsideWindowCount }] : []),
          ...(outOfScopeCount > 0 ? [{ reason: "outside_requested_scope", count: outOfScopeCount }] : []),
          ...(unknownReasonCount > 0 ? [{ reason: "unknown_rejection_reason", count: unknownReasonCount }] : []),
        ],
        inventoryComplete: details.complete,
        anyPaginationTruncated: !details.complete,
        provenance,
        message: readStatusMessage(details.status),
      }),
      attribution_summary: { findings_ranked: rankings.length, unresolved: unknownReasonCount },
      unresolved_evidence: [],
    }, scope.header);

    const result: RecruiterToolResult = {
      ok: true,
      toolName,
      actorId: details.actorId,
      effectiveActorId: details.effectiveActorId,
      scoped: details.scoped ?? true,
      permissionScope: details.permissionScope,
      data: {
        ...envelope.data,
        completeness: envelope.completeness,
        attribution_summary: envelope.attribution_summary,
        unresolved_evidence: envelope.unresolved_evidence,
        ...(envelope.scope ? { scope: envelope.scope } : {}),
      },
      nextCursor: null,
    };
    const auditDenied = await emitAnalysisAudit(runtime, startedAt, correlationId, result, details.rawRowsRead, inScope.length, actAsUser);
    return auditDenied ?? result;
  } catch (error) {
    const result = errorToDenial(toolName, error);
    const auditDenied = await emitAnalysisAudit(runtime, startedAt, correlationId, result, null, null, actAsUser);
    return auditDenied ?? result;
  }
}

async function loadApplicationJobIds(runtime: RecruiterToolRuntime, rows: RejectionDetailRow[], deadline?: ToolDeadline) {
  const appIds = rows.map((row) => readPositiveInt(row.application_id)).filter(isPositiveInteger);
  return loadApplicationJobIdsFromScopedList(runtime, appIds, deadline);
}

function buildReasonRankings(
  rows: RejectionDetailRow[],
  applications: { jobIdsByApplication: Map<number, number | null> },
  maxEvidenceIds: number
): ReasonAccumulator[] {
  const byReason = new Map<number, ReasonAccumulator>();
  for (const row of rows) {
    const reasonId = readPositiveInt(row.rejection_reason_id);
    if (reasonId === null) continue; // counted separately as unknown_reason_count
    const accumulator = byReason.get(reasonId) ?? {
      reasonId,
      count: 0,
      affectedJobs: new Set<number>(),
      evidenceIds: new Set<string>(),
    };
    accumulator.count += 1;
    const appId = readPositiveInt(row.application_id);
    if (appId !== null) {
      if (accumulator.evidenceIds.size < maxEvidenceIds) accumulator.evidenceIds.add(`application:${appId}`);
      const jobId = applications.jobIdsByApplication.get(appId);
      if (typeof jobId === "number") {
        accumulator.affectedJobs.add(jobId);
        accumulator.evidenceIds.add(`job:${jobId}`);
      }
    }
    byReason.set(reasonId, accumulator);
  }
  return [...byReason.values()].sort((a, b) => b.count - a.count || a.reasonId - b.reasonId);
}

function rejectionInWindow(row: RejectionDetailRow, startIso: string, endIso: string): boolean {
  const basis = typeof row.created_at === "string" ? row.created_at : typeof row.rejected_at === "string" ? row.rejected_at : null;
  if (!basis) return true;
  const at = Date.parse(basis);
  return Number.isFinite(at) && at >= Date.parse(startIso) && at <= Date.parse(endIso);
}

function countScopedJobs(applications: { jobIdsByApplication: Map<number, number | null> }, requestedJobIds: Set<number> | null): number {
  if (requestedJobIds) return requestedJobIds.size;
  return new Set([...applications.jobIdsByApplication.values()].filter(isPositiveInteger)).size;
}

function parseRequestedJobIds(value: unknown): Set<number> | null {
  if (value === undefined || value === null) return null;
  const ids = new Set<number>();
  const add = (raw: unknown): void => {
    const parsed =
      typeof raw === "number"
        ? raw
        : typeof raw === "string" && /^\d+$/.test(raw.trim())
          ? Number.parseInt(raw.trim(), 10)
          : NaN;
    if (isPositiveInteger(parsed)) ids.add(parsed);
  };
  if (Array.isArray(value)) value.forEach(add);
  else if (typeof value === "string") value.split(",").forEach(add);
  else return null;
  return ids.size > 0 ? ids : null;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator, 4);
}

function round(value: number, digits: number): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function errorToDenial(toolName: string, error: unknown): RecruiterToolResult {
  if (error instanceof IdentityResolutionError) {
    return deny(toolName, error.code, error.message);
  }
  if (isToolCancelledError(error)) {
    return deny(toolName, "CANCELLED", "Scoped Greenhouse tool was cancelled because the client request ended.");
  }
  if (isToolTimeoutError(error)) {
    return deny(toolName, "TOOL_TIMEOUT", "Scoped Greenhouse tool timed out before returning data.");
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("window exceeds") || message.includes("requires a valid window")) {
    return deny(toolName, "LIMIT_EXCEEDED", message);
  }
  return deny(toolName, "UPSTREAM_ERROR", classifyUpstreamError(error, "Rejection reason drift analysis failed before returning data."));
}

async function emitAnalysisAudit(
  runtime: RecruiterToolRuntime,
  startedAt: number,
  correlationId: string,
  result: RecruiterToolResult,
  rowsRead: number | null,
  rowsReturned: number | null,
  actAsUser: number | null
): Promise<RecruiterToolResult | null> {
  return emitRequiredToolAudit(runtime, REJECTION_REASON_DRIFT_TOOL.name, "analysis", startedAt, correlationId, result, rowsRead, rowsReturned, actAsUser);
}
