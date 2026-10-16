import { SCORECARD_ANALYSIS_READ_PARAM_NAMES, assertWindowWithinLimit, hasExplicitAnalysisWindow, isToolEnabled, readNonNegativeFiniteNumber, readPositiveInt, resolveAnalysisWindow, sanitizeReadParams } from "../limits.js";
import { SCORECARD_WINDOW_CLOCK } from "./analysis-window-copy.js";
import {
  SCORECARD_MISSING_BASIS_DISCLOSURE,
  SCORECARD_WINDOW_BASIS_LABEL,
  partitionScorecardByWindow,
  readScorecardsForWindow,
  scorecardWindowBasis,
} from "./scorecard-window.js";
import { createToolDeadline, deny, emitRequiredToolAudit, enforceUsageBudget, isToolCancelledError, isToolTimeoutError, type RecruiterToolRuntime, type ToolDeadline } from "../runtime.js";
import { newCorrelationId } from "../audit.js";
import { IdentityResolutionError } from "../identity.js";
import { buildEvidencePack, stripEvidencePackParams } from "./evidence-pack.js";
import { loadApplicationJobIdsFromScopedList } from "./application-job-lookup.js";
import { readScorecardPersonId } from "./application-shapes.js";
import { resolveAnalysisContext } from "../resolution/analysis-context.js";
import { attachAnalysisScope, buildAnalysisCompleteness } from "../resolution/analysis-result.js";
import { detectDataProvenance } from "../resolution/provenance.js";
import { classifyUpstreamError, readStatusMessage } from "../read-all.js";
import { buildScorecardFacts } from "../facts.js";
import { buildAnalysisFactMetricLayer } from "./analysis-fact-metrics.js";
import type { RecruiterToolDefinition, RecruiterToolResult } from "../types.js";

export const INTERVIEW_FEEDBACK_DRAG_TOOL: RecruiterToolDefinition = {
  name: "analyze_interview_feedback_drag",
  kind: "analysis",
  description:
    "Rank delayed or missing interview feedback across the authenticated recruiter's permitted jobs using scoped scorecards, submission timing, affected jobs, and evidence ids. " +
    SCORECARD_WINDOW_CLOCK,
};

interface ScorecardRow extends Record<string, unknown> {
  id: number | null;
  application_id: number | null;
  interviewer_id: number | null;
  submitter_id: number | null;
  status: string | null;
  submitted_at: string | null;
  interviewed_at: string | null;
}

interface FeedbackObservation {
  scorecardId: number | null;
  applicationId: number | null;
  personId: number | null;
  submitted: boolean;
  late: boolean;
  unsubmitted: boolean;
  delayDays: number;
}

interface FeedbackAccumulator {
  personKey: string;
  personId: number | null;
  total: number;
  submitted: number;
  lateOrUnsubmitted: number;
  unsubmitted: number;
  delayDays: number[];
  affectedJobs: Set<number>;
  evidenceIds: Set<string>;
}

export async function runInterviewFeedbackDrag(
  runtime: RecruiterToolRuntime,
  params: Record<string, unknown>
): Promise<RecruiterToolResult> {
  const toolName = INTERVIEW_FEEDBACK_DRAG_TOOL.name;
  const startedAt = runtime.now();
  const deadline = createToolDeadline(runtime, startedAt);
  const correlationId = newCorrelationId(runtime.now);
  const actAsUser = runtime.trustedActAsUser ?? null;

  if (!isToolEnabled(runtime.toolConfig, runtime.session.surface, toolName, "analysis")) {
    const result = deny(toolName, "TOOL_DISABLED", "Interview feedback drag analysis is disabled for this runtime.");
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
    // is bridged job -> application_ids and scorecards are read by application_ids
    // (readScorecardsForWindow's one derive hop). An undefined job_ids means "all permitted jobs".
    const requestedJobIds = parseRequestedJobIds(params.job_ids);
    const window = resolveAnalysisWindow(params, runtime.now, 30);
    // A caller-stated window (explicit params, or a time phrase in the question forwarded by the
    // planner) runs free of maxLookbackDays (in-memory cap, guards no API cost).
    if (!hasExplicitAnalysisWindow(params)) assertWindowWithinLimit(window.windowStart, window.windowEnd, runtime.limits);
    const maxRankings = Math.min(readPositiveInt(params.max_rankings) ?? runtime.limits.maxRankings, runtime.limits.maxRankings);
    const maxEvidenceIds = runtime.limits.maxEvidenceIds;
    const dueDays = readNonNegativeFiniteNumber(params.due_days) ?? 2;
    // No created_at floor: the recipe reports an INTERVIEW-date window, so it selects on one
    // (readScorecardsForWindow adds the interviewed_at / submitted_at range bounds per read).
    const scorecardParams = sanitizeReadParams(
      {
        ...params,
        per_page: params.per_page,
      },
      runtime.limits,
      { allowedParamNames: SCORECARD_ANALYSIS_READ_PARAM_NAMES }
    );
    delete scorecardParams.max_rankings;
    delete scorecardParams.window_start;
    delete scorecardParams.window_end;
    delete scorecardParams.due_days;
    stripEvidencePackParams(scorecardParams);
    // Never send job_ids to /v3/scorecards (422s on it); the narrowed read bridges to application_ids.
    delete scorecardParams.job_ids;

    const scorecards = await readScorecardsForWindow<ScorecardRow>(runtime, toolName, requestedJobIds, scorecardParams, window, deadline);
    if (scorecards.kind === "denial") {
      const auditDenied = await emitAnalysisAudit(runtime, startedAt, correlationId, scorecards.result, null, null, actAsUser);
      return auditDenied ?? scorecards.result;
    }

    // ONE partition per row, decided in a fixed precedence: missing_basis, then outside_window, then
    // submitted_before_interview, then in_window. Every count below is therefore disjoint and they sum
    // to the rows read, which is what makes the completeness identity
    // total_records_in_scope === records_analyzed + records_excluded true. Counting the window
    // partition and the submitted-before-interview drop independently gave a row TWO memberships (3
    // rows, 4 memberships on the D2b fixture) and told the reader a card was both analysed in-window
    // and excluded.
    const partitions = partitionFeedbackRows(scorecards.rows, window);
    const windowedEntries = partitions.inWindow;
    const outsideWindowCount = partitions.outsideWindow;
    const missingBasisCount = partitions.missingBasis;
    const submittedBeforeInterview = partitions.submittedBeforeInterview;
    const applicationJobIds = await loadApplicationJobIds(runtime, windowedEntries.map((entry) => entry.row), deadline);
    if (applicationJobIds.denial) {
      const result = deny(toolName, applicationJobIds.denial.code, applicationJobIds.denial.message);
      const auditDenied = await emitAnalysisAudit(runtime, startedAt, correlationId, result, null, null, actAsUser);
      return auditDenied ?? result;
    }
    const resolvableToAnyJob = windowedEntries.filter((entry) =>
      hasResolvedApplicationJob(entry.row, applicationJobIds)
    );
    const unresolvedAssociationCount = windowedEntries.length - resolvableToAnyJob.length;
    // Re-apply the resolved job scope: because /v3/scorecards could not filter by job, a
    // narrowed request would otherwise analyze every permitted job's scorecards.
    const inScopeEntries = requestedJobIds
      ? resolvableToAnyJob.filter((entry) =>
          requestedJobIds.has(applicationJobIds.jobIdsByApplication.get(entry.row.application_id as number) as number))
      : resolvableToAnyJob;
    const outOfScopeCount = resolvableToAnyJob.length - inScopeEntries.length;
    const resolvableScorecards = inScopeEntries.map((entry) => entry.row);
    const observations = buildObservations(inScopeEntries, dueDays);
    const rankings = buildRankings(observations, applicationJobIds, dueDays)
      .slice(0, maxRankings)
      .map((entry, index) => ({
        rank: index + 1,
        person_key: entry.personKey,
        person_id: entry.personId,
        severity_score: severityScore(entry, dueDays),
        total_scorecards: entry.total,
        submitted_scorecards: entry.submitted,
        late_or_unsubmitted_scorecards: entry.lateOrUnsubmitted,
        unsubmitted_scorecards: entry.unsubmitted,
        late_or_unsubmitted_rate: ratio(entry.lateOrUnsubmitted, entry.total),
        average_feedback_delay_days: round(mean(entry.delayDays), 1),
        p90_feedback_delay_days: round(percentile(entry.delayDays, 0.9), 1),
        affected_jobs: [...entry.affectedJobs].sort((a, b) => a - b),
        evidence_ids: [...entry.evidenceIds].slice(0, maxEvidenceIds),
      }));
    const evidencePack = buildEvidencePack(params, [{ name: "rankings", rows: rankings }], runtime.limits.maxEvidenceIds);

    const submitted = observations.filter((row) => row.submitted).length;
    const lateOrUnsubmitted = observations.filter((row) => row.late || row.unsubmitted).length;
    const unsubmitted = observations.filter((row) => row.unsubmitted).length;
    const delays = observations.map((row) => row.delayDays);
    const factMetricLayer = buildAnalysisFactMetricLayer({
      facts: { scorecard_fact: buildScorecardFacts(resolvableScorecards) },
      metricIds: [
        "interview_feedback_sla_breach_rate",
        "scheduled_interview_to_feedback_hours",
        "scorecard_submission_rate",
      ],
      nowMs: Date.parse(window.windowEnd),
      overdueDays: dueDays,
      slaHours: dueDays * 24,
      readStatus: scorecards.status,
    });
    const summary = {
      question: "interview feedback drag",
      window_start: window.windowStart,
      window_end: window.windowEnd,
      feedback_due_days: dueDays,
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
      rows_considered: observations.length,
      rows_dropped_unresolved_job_association: unresolvedAssociationCount,
      rows_dropped_outside_requested_scope: outOfScopeCount,
      scoped_job_count: countScopedJobs(applicationJobIds, requestedJobIds),
      read_warnings: scorecards.warnings,
      data_quality: {
        window_basis: SCORECARD_WINDOW_BASIS_LABEL,
        // Disjoint by construction: in_window counts the rows that are in-window AND carry a
        // measurable feedback delay, so a submitted-before-interview card appears in exactly one of
        // these and the four sum to rows_fetched.
        in_window: windowedEntries.length,
        outside_window: outsideWindowCount,
        missing_basis: missingBasisCount,
        submitted_before_interview: submittedBeforeInterview,
        missing_basis_note: SCORECARD_MISSING_BASIS_DISCLOSURE,
        submitted_before_interview_note:
          "A scorecard whose submitted_at precedes its interviewed_at yields no measurable feedback delay, so it is excluded from the delay statistics rather than counted as instant feedback.",
      },
    };
    const metrics = {
      scorecards_considered: observations.length,
      submitted_scorecards: submitted,
      late_or_unsubmitted_scorecards: lateOrUnsubmitted,
      unsubmitted_scorecards: unsubmitted,
      late_or_unsubmitted_rate: ratio(lateOrUnsubmitted, observations.length),
      average_feedback_delay_days: round(mean(delays), 1),
      p90_feedback_delay_days: round(percentile(delays, 0.9), 1),
      people_ranked: rankings.length,
    };
    const denials = applicationJobIds.denials;
    const nextSteps = [
      "Inspect the top evidence ids for repeat delayed-feedback patterns.",
      "Filter to one affected job to separate req-specific scheduling drag from cross-req interviewer behavior.",
      "Compare with analyze_stage_latency to see whether feedback delay is creating stage bottlenecks.",
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
        recordsAnalyzed: observations.length,
        exclusionReasons: [
          ...(outsideWindowCount > 0
            ? [{ reason: "outside_analysis_window", count: outsideWindowCount }]
            : []),
          ...(missingBasisCount > 0
            ? [{ reason: "missing_window_basis", count: missingBasisCount }]
            : []),
          ...(submittedBeforeInterview > 0
            ? [{ reason: "submitted_before_interview", count: submittedBeforeInterview }]
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
    const auditDenied = await emitAnalysisAudit(runtime, startedAt, correlationId, result, scorecards.rawRowsRead, observations.length, actAsUser);
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

interface WindowedFeedbackRow {
  row: ScorecardRow;
  /** Days from the interview (or submission) basis to submission, or to window_end when unsubmitted. */
  delayDays: number;
}

interface FeedbackRowPartitions {
  inWindow: WindowedFeedbackRow[];
  outsideWindow: number;
  missingBasis: number;
  submittedBeforeInterview: number;
}

/**
 * Assign every row read exactly one partition, in precedence order, and carry the measured delay
 * forward so nothing downstream can drop a row without counting it.
 *
 * A card whose submitted_at PRECEDES its interviewed_at yields no measurable delay (daysBetween is
 * null on a negative span). That is a property of the row itself, not of the job scope, so it is
 * decided here — before the application -> job bridge — and the row never reaches the observations.
 */
function partitionFeedbackRows(
  rows: ScorecardRow[],
  window: { windowStart: string; windowEnd: string }
): FeedbackRowPartitions {
  const partitions: FeedbackRowPartitions = { inWindow: [], outsideWindow: 0, missingBasis: 0, submittedBeforeInterview: 0 };
  for (const row of rows) {
    const partition = partitionScorecardByWindow(row, window.windowStart, window.windowEnd);
    if (partition === "missing_basis") {
      partitions.missingBasis += 1;
      continue;
    }
    if (partition === "outside_window") {
      partitions.outsideWindow += 1;
      continue;
    }
    const basis = scorecardWindowBasis(row)!;
    const delayDays = isSubmittedScorecard(row) && row.submitted_at
      ? daysBetween(basis, row.submitted_at)
      : daysBetween(basis, window.windowEnd);
    if (delayDays === null) {
      partitions.submittedBeforeInterview += 1;
      continue;
    }
    partitions.inWindow.push({ row, delayDays });
  }
  return partitions;
}

/** Rows reaching here are in-window, in-scope, and already carry a measurable delay. */
function buildObservations(entries: WindowedFeedbackRow[], dueDays: number): FeedbackObservation[] {
  return entries.map(({ row, delayDays }) => {
    const submitted = isSubmittedScorecard(row);
    return {
      scorecardId: readPositiveNumber(row.id),
      applicationId: readPositiveNumber(row.application_id),
      personId: readScorecardPersonId(row),
      submitted,
      late: delayDays > dueDays,
      unsubmitted: !submitted,
      delayDays,
    };
  });
}

function buildRankings(
  observations: FeedbackObservation[],
  applications: { jobIdsByApplication: Map<number, number | null> },
  dueDays: number
): FeedbackAccumulator[] {
  const byPerson = new Map<string, FeedbackAccumulator>();
  for (const row of observations) {
    const personKey = row.personId === null ? "unknown" : `greenhouse_user:${row.personId}`;
    const entry = byPerson.get(personKey) ?? {
      personKey,
      personId: row.personId,
      total: 0,
      submitted: 0,
      lateOrUnsubmitted: 0,
      unsubmitted: 0,
      delayDays: [],
      affectedJobs: new Set<number>(),
      evidenceIds: new Set<string>(),
    };
    entry.total += 1;
    if (row.submitted) entry.submitted += 1;
    if (row.late || row.unsubmitted) entry.lateOrUnsubmitted += 1;
    if (row.unsubmitted) entry.unsubmitted += 1;
    entry.delayDays.push(row.delayDays);
    if (row.scorecardId !== null) entry.evidenceIds.add(`scorecard:${row.scorecardId}`);
    if (row.applicationId !== null) {
      entry.evidenceIds.add(`application:${row.applicationId}`);
      const jobId = applications.jobIdsByApplication.get(row.applicationId);
      if (typeof jobId === "number") entry.affectedJobs.add(jobId);
    }
    byPerson.set(personKey, entry);
  }
  return [...byPerson.values()].sort((a, b) => severityScore(b, dueDays) - severityScore(a, dueDays) || b.lateOrUnsubmitted - a.lateOrUnsubmitted || a.personKey.localeCompare(b.personKey));
}

function hasResolvedApplicationJob(
  row: ScorecardRow,
  applications: { jobIdsByApplication: Map<number, number | null> }
): boolean {
  if (!isPositiveInteger(row.application_id)) return false;
  return isPositiveInteger(applications.jobIdsByApplication.get(row.application_id));
}

function severityScore(entry: FeedbackAccumulator, dueDays: number): number {
  const rateComponent = ratio(entry.lateOrUnsubmitted, entry.total) * 100;
  const volumeComponent = entry.lateOrUnsubmitted * 8;
  const delayComponent = Math.max(0, mean(entry.delayDays) - dueDays) * 5;
  return Math.round(rateComponent + volumeComponent + delayComponent);
}

function isSubmittedScorecard(row: ScorecardRow): boolean {
  const status = (row.status ?? "").trim().toLowerCase();
  return Boolean(row.submitted_at) || ["submitted", "complete", "completed"].includes(status);
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

function daysBetween(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
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
  return deny(toolName, "UPSTREAM_ERROR", classifyUpstreamError(error, "Interview feedback drag analysis failed before returning data."));
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
  return emitRequiredToolAudit(runtime, INTERVIEW_FEEDBACK_DRAG_TOOL.name, "analysis", startedAt, correlationId, result, rowsRead, rowsReturned, actAsUser);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator, 4);
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sortedValues = [...values].sort((a, b) => a - b);
  const index = Math.ceil(p * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))]!;
}

function round(value: number, digits: number): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function readPositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
