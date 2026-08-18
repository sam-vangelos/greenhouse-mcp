import { SCORECARD_ANALYSIS_READ_PARAM_NAMES, assertWindowWithinLimit, hasExplicitAnalysisWindow, isToolEnabled, readPositiveInt, resolveAnalysisWindow, sanitizeReadParams } from "../limits.js";
import { createToolDeadline, deny, emitRequiredToolAudit, enforceUsageBudget, isToolCancelledError, isToolTimeoutError, type RecruiterToolRuntime, type ToolDeadline } from "../runtime.js";
import { newCorrelationId } from "../audit.js";
import { IdentityResolutionError } from "../identity.js";
import { buildEvidencePack, stripEvidencePackParams } from "./evidence-pack.js";
import { loadApplicationJobIdsFromScopedList, readScorecardRowsForJobScope } from "./application-job-lookup.js";
import { readScorecardPersonId } from "./application-shapes.js";
import { resolveAnalysisContext } from "../resolution/analysis-context.js";
import { attachAnalysisScope, buildAnalysisCompleteness } from "../resolution/analysis-result.js";
import { detectDataProvenance } from "../resolution/provenance.js";
import { classifyUpstreamError, readAllScopedRows, readStatusMessage } from "../read-all.js";
import { buildScorecardFacts } from "../facts.js";
import { buildAnalysisFactMetricLayer } from "./analysis-fact-metrics.js";
import type { RecruiterToolDefinition, RecruiterToolResult } from "../types.js";

export const SCORECARD_ACCOUNTABILITY_TOOL: RecruiterToolDefinition = {
  name: "analyze_scorecard_accountability",
  kind: "analysis",
  description:
    "Rank scorecard accountability across the authenticated recruiter's permitted jobs, including unsubmitted rate, severity, affected jobs, and evidence ids.",
};

interface ScorecardRow extends Record<string, unknown> {
  id: number | null;
  application_id: number | null;
  interviewer_id: number | null;
  submitter_id: number | null;
  status: string | null;
  submitted_at: string | null;
  interviewed_at: string | null;
  overall_rating?: string | null;
}

interface RankingAccumulator {
  personKey: string;
  personId: number | null;
  total: number;
  unsubmitted: number;
  affectedJobs: Set<number>;
  evidenceIds: Set<string>;
  ageDaysTotal: number;
}

export async function runScorecardAccountability(
  runtime: RecruiterToolRuntime,
  params: Record<string, unknown>
): Promise<RecruiterToolResult> {
  const toolName = SCORECARD_ACCOUNTABILITY_TOOL.name;
  const startedAt = runtime.now();
  const deadline = createToolDeadline(runtime, startedAt);
  const correlationId = newCorrelationId(runtime.now);
  const actAsUser = runtime.trustedActAsUser ?? null;

  if (!isToolEnabled(runtime.toolConfig, runtime.session.surface, toolName, "analysis")) {
    const result = deny(toolName, "TOOL_DISABLED", "Scorecard accountability analysis is disabled for this runtime.");
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
    // /v3/scorecards has NO job_ids filter and Harvest v3 REJECTS it with 422 (it does not
    // ignore it), so job_ids is never forwarded to the scorecard read below. A narrowed scope
    // is instead bridged job -> application_ids and the scorecards are read by application_ids
    // (readScorecardRowsForJobScope). An undefined job_ids (a recruiter who did not narrow)
    // means "all permitted jobs" and reads the full permitted set, unchanged.
    const requestedJobIds = parseRequestedJobIds(params.job_ids);
    const window = resolveAnalysisWindow(params, runtime.now, 30);
    // An EXPLICIT window runs free of maxLookbackDays (in-memory cap, guards no API cost).
    if (!hasExplicitAnalysisWindow(params)) assertWindowWithinLimit(window.windowStart, window.windowEnd, runtime.limits);
    const maxRankings = Math.min(readPositiveInt(params.max_rankings) ?? runtime.limits.maxRankings, runtime.limits.maxRankings);
    const maxEvidenceIds = runtime.limits.maxEvidenceIds;
    const scorecardParams = sanitizeReadParams(
      {
        ...params,
        per_page: params.per_page,
        created_at: `gte|${window.windowStart}`,
      },
      runtime.limits,
      { allowedParamNames: SCORECARD_ANALYSIS_READ_PARAM_NAMES }
    );
    delete scorecardParams.max_rankings;
    delete scorecardParams.window_start;
    delete scorecardParams.window_end;
    delete scorecardParams.include_evidence;
    stripEvidencePackParams(scorecardParams);
    // Never send job_ids to /v3/scorecards (422s on it); the narrowed read bridges to application_ids.
    delete scorecardParams.job_ids;

    const scorecards = requestedJobIds
      ? await readScorecardRowsForJobScope<ScorecardRow>(runtime, toolName, [...requestedJobIds], scorecardParams, deadline)
      : await readAllScopedRows<ScorecardRow>(runtime, toolName, "list_scorecards", scorecardParams, deadline);
    if (scorecards.kind === "denial") {
      const auditDenied = await emitAnalysisAudit(runtime, startedAt, correlationId, scorecards.result, null, null, actAsUser);
      return auditDenied ?? scorecards.result;
    }

    const windowed = scorecards.rows.filter((row: ScorecardRow) => scorecardInWindow(row, window.windowStart, window.windowEnd));
    const outsideWindowCount = scorecards.rows.length - windowed.length;
    const applicationJobIds = await loadApplicationJobIds(runtime, windowed, deadline);
    if (applicationJobIds.denial) {
      const result = deny(toolName, applicationJobIds.denial.code, applicationJobIds.denial.message);
      const auditDenied = await emitAnalysisAudit(runtime, startedAt, correlationId, result, null, null, actAsUser);
      return auditDenied ?? result;
    }
    const resolvableToAnyJob = filterRowsWithResolvedApplicationJob(windowed, applicationJobIds);
    const unresolvedAssociationCount = windowed.length - resolvableToAnyJob.length;
    // Re-apply the resolved job scope: because /v3/scorecards could not filter by job, a
    // narrowed request would otherwise analyze every permitted job's scorecards.
    const resolvableScorecards = requestedJobIds
      ? resolvableToAnyJob.filter((row) =>
          requestedJobIds.has(applicationJobIds.jobIdsByApplication.get(row.application_id as number) as number))
      : resolvableToAnyJob;
    const outOfScopeCount = resolvableToAnyJob.length - resolvableScorecards.length;
    const rankings = buildRankings(resolvableScorecards, applicationJobIds, window.windowEnd)
      .slice(0, maxRankings)
      .map((entry, index) => ({
        rank: index + 1,
        person_key: entry.personKey,
        person_id: entry.personId,
        severity_score: severityScore(entry),
        unsubmitted_scorecards: entry.unsubmitted,
        total_scorecards: entry.total,
        unsubmitted_rate: ratio(entry.unsubmitted, entry.total),
        average_unsubmitted_age_days: entry.unsubmitted > 0 ? round(entry.ageDaysTotal / entry.unsubmitted, 1) : 0,
        affected_jobs: [...entry.affectedJobs].sort((a, b) => a - b),
        evidence_ids: [...entry.evidenceIds].slice(0, maxEvidenceIds),
      }));
    const evidencePack = buildEvidencePack(params, [{ name: "rankings", rows: rankings }], runtime.limits.maxEvidenceIds);

    const totalScorecards = resolvableScorecards.length;
    const unsubmittedScorecards = resolvableScorecards.filter(isUnsubmittedScorecard).length;
    const factMetricLayer = buildAnalysisFactMetricLayer({
      facts: { scorecard_fact: buildScorecardFacts(resolvableScorecards) },
      metricIds: ["scorecard_submission_rate", "scorecard_overdue_rate"],
      nowMs: Date.parse(window.windowEnd),
      overdueDays: 2,
      readStatus: scorecards.status,
    });
    const summary = {
      question: "scorecard accountability",
      window_start: window.windowStart,
      window_end: window.windowEnd,
      rows_read: scorecards.rawRowsRead,
      pages_read: scorecards.pagesRead,
      per_page: scorecards.perPage,
      read_status: scorecards.status,
      read_complete: scorecards.complete,
      next_cursor: scorecards.nextCursor,
      pagination_truncated: scorecards.paginationTruncated,
      rate_limit_retries: scorecards.rateLimitRetries,
      cache_hits: scorecards.cacheHits,
      rate_limit_sleep_ms: scorecards.rateLimitSleepMs,
      rows_considered: totalScorecards,
      rows_dropped_unresolved_job_association: unresolvedAssociationCount,
      rows_dropped_outside_requested_scope: outOfScopeCount,
      scoped_job_count: countScopedJobs(applicationJobIds, requestedJobIds),
      read_warnings: scorecards.warnings,
    };
    const metrics = {
      unsubmitted_scorecards: unsubmittedScorecards,
      total_scorecards: totalScorecards,
      unsubmitted_scorecard_rate: ratio(unsubmittedScorecards, totalScorecards),
    };
    const denials = applicationJobIds.denials;
    const nextSteps = [
      "Inspect the top evidence ids for the highest-severity people.",
      "Compare this 30-day window against the prior 30 days.",
      "Drill into affected jobs with get_my_application; detailed scorecard evidence remains internal to this analyzer during the pilot.",
    ];
    // L4 provenance/freshness detector over the scoped scorecard cohort (created_at cluster + predate;
    // scorecards carry no application-style disposition, so all-default-status is not evaluated).
    const provenance = detectDataProvenance(
      resolvableScorecards.map((row) => ({
        timestamp: typeof row.created_at === "string" ? row.created_at : null,
        jobId: applicationJobIds.jobIdsByApplication.get(row.application_id as number) ?? null,
      })),
      { nowMs: runtime.now(), jobAnchors: scope.jobAnchors, recordKind: "scorecard" }
    );
    const envelope = attachAnalysisScope({
      data: {
        summary,
        metrics,
        fact_metric_layer: factMetricLayer,
        rankings,
        evidence_ids: rankings.flatMap((entry) => entry.evidence_ids).slice(0, maxEvidenceIds),
        denials,
        next_steps: nextSteps,
        ...(evidencePack ? { evidence_pack: evidencePack } : {}),
      },
      completeness: buildAnalysisCompleteness({
        totalRecordsInScope: scorecards.rows.length,
        recordsAnalyzed: totalScorecards,
        exclusionReasons: [
          ...(outsideWindowCount > 0
            ? [{ reason: "outside_analysis_window", count: outsideWindowCount }]
            : []),
          ...(unresolvedAssociationCount > 0
            ? [{ reason: "unresolved_application_job_association", count: unresolvedAssociationCount }]
            : []),
          ...(outOfScopeCount > 0
            ? [{ reason: "outside_requested_scope", count: outOfScopeCount }]
            : []),
        ],
        inventoryComplete: scorecards.complete,
        anyPaginationTruncated: !scorecards.complete,
        provenance,
        message: readStatusMessage(scorecards.status),
      }),
      attribution_summary: { findings_ranked: rankings.length, unresolved: unresolvedAssociationCount },
      unresolved_evidence: [],
    }, scope.header);
    const result: RecruiterToolResult = {
      ok: true,
      toolName,
      actorId: scorecards.actorId,
      effectiveActorId: scorecards.effectiveActorId,
      scoped: scorecards.scoped ?? true,
      permissionScope: scorecards.permissionScope,
      data: {
        ...envelope.data,
        completeness: envelope.completeness,
        attribution_summary: envelope.attribution_summary,
        unresolved_evidence: envelope.unresolved_evidence,
        ...(envelope.scope ? { scope: envelope.scope } : {}),
      },
      nextCursor: null,
    };
    const auditDenied = await emitAnalysisAudit(runtime, startedAt, correlationId, result, scorecards.rawRowsRead, totalScorecards, actAsUser);
    return auditDenied ?? result;
  } catch (error) {
    const result = errorToDenial(toolName, error);
    const auditDenied = await emitAnalysisAudit(runtime, startedAt, correlationId, result, null, null, actAsUser);
    return auditDenied ?? result;
  }
}

async function loadApplicationJobIds(runtime: RecruiterToolRuntime, scorecards: ScorecardRow[], deadline?: ToolDeadline) {
  const appIds = scorecards.map((row) => row.application_id).filter(isPositiveInteger);
  return loadApplicationJobIdsFromScopedList(runtime, appIds, deadline);
}

function buildRankings(
  scorecards: ScorecardRow[],
  applications: { jobIdsByApplication: Map<number, number | null> },
  windowEnd: string
): RankingAccumulator[] {
  const byPerson = new Map<string, RankingAccumulator>();
  for (const row of scorecards) {
    const personId = readScorecardPersonId(row);
    const personKey = personId === null ? "unknown" : `greenhouse_user:${personId}`;
    const accumulator = byPerson.get(personKey) ?? {
      personKey,
      personId,
      total: 0,
      unsubmitted: 0,
      affectedJobs: new Set<number>(),
      evidenceIds: new Set<string>(),
      ageDaysTotal: 0,
    };
    accumulator.total += 1;
    if (row.application_id !== null) {
      accumulator.evidenceIds.add(`application:${row.application_id}`);
      const jobId = applications.jobIdsByApplication.get(row.application_id);
      if (typeof jobId === "number") accumulator.affectedJobs.add(jobId);
    }
    if (row.id !== null) accumulator.evidenceIds.add(`scorecard:${row.id}`);
    if (isUnsubmittedScorecard(row)) {
      accumulator.unsubmitted += 1;
      accumulator.ageDaysTotal += ageDays(row.interviewed_at ?? row.submitted_at, windowEnd);
    }
    byPerson.set(personKey, accumulator);
  }
  return [...byPerson.values()].sort((a, b) => severityScore(b) - severityScore(a) || b.unsubmitted - a.unsubmitted || a.personKey.localeCompare(b.personKey));
}

function filterRowsWithResolvedApplicationJob(
  scorecards: ScorecardRow[],
  applications: { jobIdsByApplication: Map<number, number | null> }
): ScorecardRow[] {
  return scorecards.filter((row) => {
    if (!isPositiveInteger(row.application_id)) return false;
    return isPositiveInteger(applications.jobIdsByApplication.get(row.application_id));
  });
}

function severityScore(entry: RankingAccumulator): number {
  const rateComponent = ratio(entry.unsubmitted, entry.total) * 100;
  const volumeComponent = entry.unsubmitted * 8;
  const ageComponent = entry.unsubmitted > 0 ? Math.min(60, entry.ageDaysTotal / entry.unsubmitted * 2) : 0;
  return Math.round(rateComponent + volumeComponent + ageComponent);
}

function scorecardInWindow(row: ScorecardRow, startIso: string, endIso: string): boolean {
  const basis = row.interviewed_at ?? row.submitted_at;
  if (!basis) return true;
  const at = Date.parse(basis);
  return Number.isFinite(at) && at >= Date.parse(startIso) && at <= Date.parse(endIso);
}

function isUnsubmittedScorecard(row: ScorecardRow): boolean {
  const status = (row.status ?? "").trim().toLowerCase();
  if (row.submitted_at || ["submitted", "complete", "completed"].includes(status)) {
    return false;
  }
  return true;
}

function countScopedJobs(
  applications: { jobIdsByApplication: Map<number, number | null> },
  requestedJobIds: Set<number> | null
): number {
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

function ageDays(startIso: string | null | undefined, endIso: string): number {
  if (!startIso) return 0;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return (end - start) / (24 * 60 * 60 * 1000);
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
  return deny(toolName, "UPSTREAM_ERROR", classifyUpstreamError(error, "Scorecard accountability analysis failed before returning data."));
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
  return emitRequiredToolAudit(runtime, SCORECARD_ACCOUNTABILITY_TOOL.name, "analysis", startedAt, correlationId, result, rowsRead, rowsReturned, actAsUser);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
