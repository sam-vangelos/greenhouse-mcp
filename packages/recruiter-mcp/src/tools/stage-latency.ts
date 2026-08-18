import { APPLICATION_ANALYSIS_READ_PARAM_NAMES, EVIDENCE_APPLICATION_STAGES_READ_PARAM_NAMES, assertWindowWithinLimit, hasExplicitAnalysisWindow, isToolEnabled, readNonNegativeFiniteNumber, readPositiveInt, resolveAnalysisWindow, sanitizeReadParams } from "../limits.js";
import { createToolDeadline, deny, emitRequiredToolAudit, enforceUsageBudget, isToolCancelledError, isToolTimeoutError, type RecruiterToolRuntime, type ToolDeadline } from "../runtime.js";
import { newCorrelationId } from "../audit.js";
import { IdentityResolutionError } from "../identity.js";
import { buildEvidencePack, stripEvidencePackParams } from "./evidence-pack.js";
import { readApplicationJobId, readApplicationStageId, readApplicationStageName } from "./application-shapes.js";
import { isActiveAnalysisStatus, isTerminalAnalysisStatus, normalizeAnalysisStatus } from "./analysis-scalars.js";
import { resolveAnalysisContext } from "../resolution/analysis-context.js";
import { attachAnalysisScope, buildAnalysisCompleteness } from "../resolution/analysis-result.js";
import { detectDataProvenance } from "../resolution/provenance.js";
import { classifyUpstreamError, combineReadStatuses, denialTruncationStatus, readAllScopedRows, readStatusMessage, type ReadAllRowsResult, type ReadAllStatus } from "../read-all.js";
import { buildApplicationStageTransitionFacts } from "../facts.js";
import { buildAnalysisFactMetricLayer } from "./analysis-fact-metrics.js";
import { mapWithConcurrency } from "./application-job-lookup.js";
import type { RecruiterPermissionScope, RecruiterToolDefinition, RecruiterToolResult } from "../types.js";

const APPLICATION_STAGE_ID_BATCH_SIZE = 50;

export const STAGE_LATENCY_TOOL: RecruiterToolDefinition = {
  name: "analyze_stage_latency",
  kind: "analysis",
  description:
    "Find stage bottlenecks across the authenticated recruiter's permitted jobs using scoped applications, current-stage dwell time, affected jobs, and evidence ids.",
};

interface ApplicationRow extends Record<string, unknown> {
  id: number | null;
  candidate_id: number | null;
  job_id: number | null;
  stage_id: number | null;
  stage_name: string | null;
  status: string | null;
  last_activity_at: string | null;
}

interface ApplicationStageRow extends Record<string, unknown> {
  id: number | null;
  application_id: number | null;
  job_interview_stage_id: number | null;
  entered_at: string | null;
  exited_at: string | null;
  days_in_stage: number | null;
  current: boolean | null;
}

interface ApplicationContext {
  applicationId: number;
  candidateId: number | null;
  jobId: number | null;
  stageId: number | null;
  stageName: string | null;
  status: string | null;
}

interface StageObservation {
  applicationStageId: number | null;
  applicationId: number | null;
  candidateId: number | null;
  jobId: number | null;
  stageId: number | null;
  stageName: string | null;
  status: string | null;
  dwellDays: number;
}

interface StageAccumulator {
  stageKey: string;
  stageId: number | null;
  stageName: string | null;
  dwellDays: number[];
  agingApplications: number;
  affectedJobs: Set<number>;
  evidenceIds: Set<string>;
}

export async function runStageLatency(
  runtime: RecruiterToolRuntime,
  params: Record<string, unknown>
): Promise<RecruiterToolResult> {
  const toolName = STAGE_LATENCY_TOOL.name;
  const startedAt = runtime.now();
  const deadline = createToolDeadline(runtime, startedAt);
  const correlationId = newCorrelationId(runtime.now);
  const actAsUser = runtime.trustedActAsUser ?? null;

  if (!isToolEnabled(runtime.toolConfig, runtime.session.surface, toolName, "analysis")) {
    const result = deny(toolName, "TOOL_DISABLED", "Stage latency analysis is disabled for this runtime.");
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
    const window = resolveAnalysisWindow(params, runtime.now, Math.min(90, runtime.limits.maxLookbackDays));
    // An EXPLICIT window runs free of maxLookbackDays (in-memory cap, guards no API cost).
    if (!hasExplicitAnalysisWindow(params)) assertWindowWithinLimit(window.windowStart, window.windowEnd, runtime.limits);
    // Rank 7: let an explicit max_rankings run free (clamped only to row count by the slice);
    // the default (env-overridable) applies only when the caller did not ask for more.
    const maxRankings = Math.min(readPositiveInt(params.max_rankings) ?? runtime.limits.maxRankings, runtime.limits.maxRankings);
    const maxEvidenceIds = runtime.limits.maxEvidenceIds;
    const minAgeDays = readNonNegativeFiniteNumber(params.min_age_days) ?? 7;
    const includeTerminal = params.include_terminal === true;
    const defaultStatus = includeTerminal ? undefined : "active";
    const applicationParams = sanitizeReadParams(
      {
        ...params,
        status: typeof params.status === "string" ? params.status : defaultStatus,
        per_page: params.per_page,
      },
      runtime.limits,
      { allowedParamNames: APPLICATION_ANALYSIS_READ_PARAM_NAMES }
    );
    delete applicationParams.max_rankings;
    delete applicationParams.min_age_days;
    delete applicationParams.window_start;
    delete applicationParams.window_end;
    delete applicationParams.include_terminal;
    stripEvidencePackParams(applicationParams);

    const applications = await readAllScopedRows<ApplicationRow>(runtime, toolName, "list_applications", applicationParams, deadline);
    if (applications.kind === "denial") {
      const auditDenied = await emitAnalysisAudit(runtime, startedAt, correlationId, applications.result, null, null, actAsUser);
      return auditDenied ?? applications.result;
    }

    const applicationContexts = buildApplicationContextById(applications.rows, includeTerminal);
    const applicationStages = await readCurrentApplicationStages(
      runtime,
      toolName,
      [...applicationContexts.keys()],
      deadline
    );
    if (applicationStages.kind === "denial") {
      const auditDenied = await emitAnalysisAudit(runtime, startedAt, correlationId, applicationStages.result, null, null, actAsUser);
      return auditDenied ?? applicationStages.result;
    }

    const observations = buildObservations(applicationStages.rows, applicationContexts, window.windowEnd);
    const applicationIdsWithStageRows = new Set(
      applicationStages.rows.map((row) => readPositiveInt(row.application_id)).filter(isPositiveInteger)
    );
    const applicationsWithoutStageRows = [...applicationContexts.keys()].filter((applicationId) => !applicationIdsWithStageRows.has(applicationId)).length;
    const stageRowsMissingTiming = applicationStages.rows.filter((row) =>
      applicationContexts.has(readPositiveInt(row.application_id) ?? -1) && readStageDwellDays(row, Date.parse(window.windowEnd)) === null
    ).length;
    const excludedMissingStageTiming = applicationsWithoutStageRows + stageRowsMissingTiming;
    // Reconcile total_records_in_scope === records_analyzed + records_excluded. The full
    // gap between raw rows surfaced and stage observations analyzed is decomposed into
    // named reasons so no records drop silently; any residual is surfaced explicitly.
    const backendScopeFiltered = Math.max(0, applications.rawRowsRead - applications.rows.length);
    const terminalOrInactiveApplications = Math.max(0, applications.rows.length - applicationContexts.size);
    const totalRecordsInScope = applications.rawRowsRead;
    const recordsExcluded = Math.max(0, totalRecordsInScope - observations.length);
    const namedExclusionReasons = [
      ...(backendScopeFiltered > 0 ? [{ reason: "backend_scope_filtered", count: backendScopeFiltered }] : []),
      ...(terminalOrInactiveApplications > 0 ? [{ reason: "terminal_or_inactive_application", count: terminalOrInactiveApplications }] : []),
      ...(applicationsWithoutStageRows > 0 ? [{ reason: "missing_current_application_stage_row", count: applicationsWithoutStageRows }] : []),
      ...(stageRowsMissingTiming > 0 ? [{ reason: "missing_stage_entry_timestamp", count: stageRowsMissingTiming }] : []),
    ];
    const namedExclusionCount = namedExclusionReasons.reduce((sum, entry) => sum + entry.count, 0);
    const exclusionReasons = namedExclusionCount < recordsExcluded
      ? [...namedExclusionReasons, { reason: "other_scope_or_shape_exclusions", count: recordsExcluded - namedExclusionCount }]
      : namedExclusionReasons;
    const rankings = buildStageRankings(observations, minAgeDays)
      .slice(0, maxRankings)
      .map((entry, index) => ({
        rank: index + 1,
        stage_key: entry.stageKey,
        stage_id: entry.stageId,
        stage_name: entry.stageName,
        severity_score: stageSeverity(entry, minAgeDays),
        application_count: entry.dwellDays.length,
        aging_applications: entry.agingApplications,
        average_dwell_days: round(mean(entry.dwellDays), 1),
        p90_dwell_days: round(percentile(entry.dwellDays, 0.9), 1),
        max_dwell_days: round(Math.max(...entry.dwellDays), 1),
        affected_jobs: [...entry.affectedJobs].sort((a, b) => a - b),
        evidence_ids: [...entry.evidenceIds].slice(0, maxEvidenceIds),
      }));
    const jobBreakdown = buildJobBreakdown(observations, minAgeDays, maxEvidenceIds).slice(0, maxRankings);
    const evidencePack = buildEvidencePack(params, [
      { name: "rankings", rows: rankings },
      { name: "job_breakdown", rows: jobBreakdown },
    ], runtime.limits.maxEvidenceIds);
    const dwellDays = observations.map((entry) => entry.dwellDays);
    const agingApplications = observations.filter((entry) => entry.dwellDays >= minAgeDays).length;
    const combinedReadStatus = combineReadStatuses([applications.status, applicationStages.status]);
    const factMetricLayer = buildAnalysisFactMetricLayer({
      facts: { application_stage_transition_fact: buildApplicationStageTransitionFacts(applicationStageFactRows(observations)) },
      metricIds: ["stage_dwell_days"],
      nowMs: Date.parse(window.windowEnd),
      readStatus: combinedReadStatus,
    });
    const summary = {
      question: "stage latency",
      window_start: window.windowStart,
      window_end: window.windowEnd,
      rows_read: applications.rawRowsRead,
      pages_read: applications.pagesRead,
      stage_rows_read: applicationStages.rawRowsRead,
      stage_pages_read: applicationStages.pagesRead,
      per_page: applications.perPage,
      stage_per_page: applicationStages.perPage,
      read_status: combinedReadStatus,
      application_read_status: applications.status,
      stage_read_status: applicationStages.status,
      read_complete: applications.complete && applicationStages.complete,
      application_next_cursor: applications.nextCursor,
      stage_next_cursor: applicationStages.nextCursor,
      pagination_truncated: applications.paginationTruncated || applicationStages.paginationTruncated,
      rate_limit_retries: applications.rateLimitRetries + applicationStages.rateLimitRetries,
      cache_hits: applications.cacheHits + applicationStages.cacheHits,
      rate_limit_sleep_ms: applications.rateLimitSleepMs + applicationStages.rateLimitSleepMs,
      rows_considered: observations.length,
      min_age_days: minAgeDays,
      scoped_job_count: new Set(observations.map((row) => row.jobId).filter(isPositiveInteger)).size,
      read_warnings: [...applications.warnings, ...applicationStages.warnings],
    };
    const metrics = {
      applications_considered: observations.length,
      aging_applications: agingApplications,
      aging_application_rate: ratio(agingApplications, observations.length),
      average_stage_dwell_days: round(mean(dwellDays), 1),
      p90_stage_dwell_days: round(percentile(dwellDays, 0.9), 1),
      max_stage_dwell_days: dwellDays.length > 0 ? round(Math.max(...dwellDays), 1) : 0,
      stages_ranked: rankings.length,
    };
    const nextSteps = [
      "Inspect the highest-severity stage evidence ids with get_my_application.",
      "Filter by one affected job to separate req-specific drag from cross-req process drag.",
      "Compare this output with analyze_scorecard_accountability for feedback-driven bottlenecks.",
    ];
    // L4 provenance/freshness detector over the application read, prospects excluded to match the other
    // recipes (legit pre-open prospect sourcing is the false-positive vector for predate). Flags
    // migration-shaped data so dwell figures read as provisional; stage-timing unavailability is already
    // disclosed via dataFreshnessOk. CRITICAL: this recipe's DEFAULT read is status-filtered to "active"
    // (include_terminal defaults false -> status:"active" at line 112, honored server-side by v3), so the
    // cohort is active-only and its disposition mix is NOT representative. Feeding isTerminal there would
    // make all-default-status tautological — it would fire on any healthy req with >=50 active
    // candidates. So evaluate all-default ONLY when the read was unfiltered (full status mix, i.e.
    // include_terminal=true with no explicit status); the cluster + predate signals are always valid.
    const fullStatusRead = applicationParams.status === undefined;
    const provenance = detectDataProvenance(
      applications.rows
        .filter((row) => (row as { prospect?: unknown }).prospect !== true)
        .map((row) => ({
          timestamp: firstApplicationTimestamp(row),
          isTerminal: fullStatusRead ? isTerminalAnalysisStatus(normalizeAnalysisStatus(row.status)) : undefined,
          jobId: readApplicationJobId(row),
        })),
      { nowMs: runtime.now(), jobAnchors: scope.jobAnchors, recordKind: "application" }
    );
    const envelope = attachAnalysisScope({
      data: {
        summary,
        metrics,
        fact_metric_layer: factMetricLayer,
        rankings,
        job_breakdown: jobBreakdown,
        evidence_ids: [
          ...rankings.flatMap((entry) => entry.evidence_ids),
          ...jobBreakdown.flatMap((entry) => entry.evidence_ids),
        ].slice(0, maxEvidenceIds),
        denials: [],
        next_steps: nextSteps,
        ...(evidencePack ? { evidence_pack: evidencePack } : {}),
      },
      completeness: buildAnalysisCompleteness({
        totalRecordsInScope,
        recordsAnalyzed: observations.length,
        recordsExcluded,
        exclusionReasons,
        inventoryComplete: applications.complete && applicationStages.complete,
        anyPaginationTruncated: !applications.complete || !applicationStages.complete,
        dataFreshnessOk: excludedMissingStageTiming === 0,
        provenance,
        message: readStatusMessage(combinedReadStatus),
      }),
      attribution_summary: {
        findings_ranked: rankings.length,
        unresolved: excludedMissingStageTiming,
      },
      unresolved_evidence: [],
    }, scope.header);
    const result: RecruiterToolResult = {
      ok: true,
      toolName,
      actorId: applications.actorId,
      effectiveActorId: applications.effectiveActorId,
      scoped: applications.scoped ?? true,
      permissionScope: applications.permissionScope,
      data: {
        ...envelope.data,
        completeness: envelope.completeness,
        attribution_summary: envelope.attribution_summary,
        unresolved_evidence: envelope.unresolved_evidence,
        ...(envelope.scope ? { scope: envelope.scope } : {}),
      },
      nextCursor: null,
    };
    const auditDenied = await emitAnalysisAudit(runtime, startedAt, correlationId, result, applications.rawRowsRead + applicationStages.rawRowsRead, observations.length, actAsUser);
    return auditDenied ?? result;
  } catch (error) {
    const result = errorToDenial(toolName, error);
    const auditDenied = await emitAnalysisAudit(runtime, startedAt, correlationId, result, null, null, actAsUser);
    return auditDenied ?? result;
  }
}

async function readCurrentApplicationStages(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  applicationIds: number[],
  deadline?: ToolDeadline
): Promise<ReadAllRowsResult<ApplicationStageRow>> {
  const rows: ApplicationStageRow[] = [];
  let rawRowsRead = 0;
  let rowsReturnedRead = 0;
  let permissionExcluded = 0;
  let unresolvedRows = 0;
  let cacheHits = 0;
  let pagesRead = 0;
  let status: ReadAllStatus = "complete";
  let nextCursor: string | null = null;
  let perPage = 500;
  let rateLimitRetries = 0;
  let rateLimitSleepMs = 0;
  const warnings: string[] = [];
  let actorId: number | undefined;
  let effectiveActorId: number | undefined;
  let scoped: boolean | undefined;
  let permissionScope: RecruiterPermissionScope | undefined;
  let completedBatches = 0;

  const batches = chunks(applicationIds, APPLICATION_STAGE_ID_BATCH_SIZE);
  const reads = await mapWithConcurrency(batches, async (batch) => {
    return readAllScopedRows<ApplicationStageRow>(
      runtime,
      exposedToolName,
      "list_application_stages",
      sanitizeReadParams(
        {
          application_ids: batch.join(","),
          current: true,
        },
        runtime.limits,
        { allowedParamNames: EVIDENCE_APPLICATION_STAGES_READ_PARAM_NAMES }
      ),
      deadline
    );
  });

  // Fold in request order even though independent batches execute concurrently.
  // A first-batch failure is a denial; a later timeout/rate-limit/parent failure
  // retains the contiguous completed prefix and reports an honest partial read.
  for (const result of reads) {
    if (result.kind === "denial") {
      const truncated = denialTruncationStatus(result.result);
      if (truncated && completedBatches > 0) {
        status = combineReadStatuses([status, truncated]);
        warnings.push(`application-stage read stopped after a later batch (${truncated})`);
        break;
      }
      return result;
    }
    rows.push(...result.rows);
    rawRowsRead += result.rawRowsRead;
    rowsReturnedRead += result.rowsReturnedRead ?? result.rows.length;
    permissionExcluded += result.permissionExcluded;
    unresolvedRows += result.unresolvedRows;
    cacheHits += result.cacheHits;
    pagesRead += result.pagesRead;
    status = combineReadStatuses([status, result.status]);
    nextCursor ??= result.nextCursor;
    perPage = result.perPage;
    rateLimitRetries += result.rateLimitRetries;
    rateLimitSleepMs += result.rateLimitSleepMs;
    warnings.push(...result.warnings);
    actorId ??= result.actorId;
    effectiveActorId ??= result.effectiveActorId;
    scoped ??= result.scoped;
    permissionScope ??= result.permissionScope;
    completedBatches += 1;
  }

  const complete = status === "complete";
  return {
    kind: "rows",
    rows,
    rawRowsRead,
    rowsReturnedRead,
    permissionExcluded,
    unresolvedRows,
    pagesRead,
    status,
    complete,
    paginationTruncated: !complete,
    nextCursor,
    perPage,
    rateLimitRetries,
    rateLimitSleepMs,
    cacheHits,
    warnings,
    actorId,
    effectiveActorId,
    scoped,
    permissionScope,
  };
}

function buildApplicationContextById(
  applications: ApplicationRow[],
  includeTerminal: boolean
): Map<number, ApplicationContext> {
  const contexts = new Map<number, ApplicationContext>();
  for (const row of applications) {
    if (!includeTerminal && !isActiveApplicationStatus(row.status)) continue;
    const applicationId = readPositiveInt(row.id);
    if (applicationId === null) continue;
    contexts.set(applicationId, {
      applicationId,
      candidateId: readPositiveInt(row.candidate_id),
      jobId: readApplicationJobId(row),
      stageId: readApplicationStageId(row),
      stageName: readApplicationStageName(row),
      status: normalizeAnalysisStatus(row.status),
    });
  }
  return contexts;
}

function buildObservations(
  applicationStages: ApplicationStageRow[],
  applications: Map<number, ApplicationContext>,
  windowEnd: string
): StageObservation[] {
  const endMs = Date.parse(windowEnd);
  return applicationStages.flatMap((row) => {
    const applicationId = readPositiveInt(row.application_id);
    if (applicationId === null) return [];
    const application = applications.get(applicationId);
    if (!application) return [];
    const enteredAt = typeof row.entered_at === "string" ? row.entered_at : null;
    const stageAt = enteredAt ? Date.parse(enteredAt) : NaN;
    if (!Number.isFinite(stageAt) || !Number.isFinite(endMs)) return [];
    // No lower-bound window filter: a still-current stage entered before the lookback
    // start is the LONGEST dweller (the worst bottleneck), not noise. Dwell is measured
    // to windowEnd; the future-dated guard and readStageDwellDays' endMs<enteredAt
    // null-guard reject invalid rows, which are counted as excluded upstream.
    if (stageAt > endMs) return [];
    const dwellDays = readStageDwellDays(row, endMs);
    if (dwellDays === null) return [];
    return [{
      applicationStageId: readPositiveInt(row.id),
      applicationId: application.applicationId,
      candidateId: application.candidateId,
      jobId: application.jobId,
      stageId: readPositiveInt(row.job_interview_stage_id) ?? application.stageId,
      stageName: application.stageName,
      status: application.status,
      dwellDays,
    }];
  });
}

function buildStageRankings(observations: StageObservation[], minAgeDays: number): StageAccumulator[] {
  const byStage = new Map<string, StageAccumulator>();
  for (const row of observations) {
    const stageKey = row.stageId !== null ? `stage:${row.stageId}` : `stage_name:${row.stageName ?? "unknown"}`;
    const accumulator = byStage.get(stageKey) ?? {
      stageKey,
      stageId: row.stageId,
      stageName: row.stageName,
      dwellDays: [],
      agingApplications: 0,
      affectedJobs: new Set<number>(),
      evidenceIds: new Set<string>(),
    };
    accumulator.dwellDays.push(row.dwellDays);
    if (row.dwellDays >= minAgeDays) accumulator.agingApplications += 1;
    if (row.jobId !== null) {
      accumulator.affectedJobs.add(row.jobId);
      accumulator.evidenceIds.add(`job:${row.jobId}`);
    }
    if (row.applicationStageId !== null) accumulator.evidenceIds.add(`application_stage:${row.applicationStageId}`);
    if (row.applicationId !== null) accumulator.evidenceIds.add(`application:${row.applicationId}`);
    if (row.candidateId !== null) accumulator.evidenceIds.add(`candidate:${row.candidateId}`);
    byStage.set(stageKey, accumulator);
  }
  return [...byStage.values()].sort((a, b) => stageSeverity(b, minAgeDays) - stageSeverity(a, minAgeDays) || b.dwellDays.length - a.dwellDays.length || a.stageKey.localeCompare(b.stageKey));
}

function applicationStageFactRows(observations: StageObservation[]): Record<string, unknown>[] {
  return observations.map((row) => ({
    id: row.applicationStageId,
    application_id: row.applicationId,
    job_interview_stage_id: row.stageId,
    days_in_stage: row.dwellDays,
    current: true,
  }));
}

function buildJobBreakdown(observations: StageObservation[], minAgeDays: number, maxEvidenceIds: number) {
  const byJob = new Map<number, { jobId: number; dwellDays: number[]; agingApplications: number; stages: Set<string>; evidenceIds: Set<string> }>();
  for (const row of observations) {
    if (row.jobId === null) continue;
    const entry = byJob.get(row.jobId) ?? {
      jobId: row.jobId,
      dwellDays: [],
      agingApplications: 0,
      stages: new Set<string>(),
      evidenceIds: new Set<string>(),
    };
    entry.dwellDays.push(row.dwellDays);
    if (row.dwellDays >= minAgeDays) entry.agingApplications += 1;
    entry.stages.add(row.stageName ?? (row.stageId !== null ? `stage:${row.stageId}` : "unknown"));
    entry.evidenceIds.add(`job:${row.jobId}`);
    if (row.applicationStageId !== null) entry.evidenceIds.add(`application_stage:${row.applicationStageId}`);
    if (row.applicationId !== null) entry.evidenceIds.add(`application:${row.applicationId}`);
    byJob.set(row.jobId, entry);
  }
  return [...byJob.values()]
    .map((entry) => ({
      job_id: entry.jobId,
      application_count: entry.dwellDays.length,
      aging_applications: entry.agingApplications,
      average_dwell_days: round(mean(entry.dwellDays), 1),
      max_dwell_days: round(Math.max(...entry.dwellDays), 1),
      stages: [...entry.stages].sort(),
      evidence_ids: [...entry.evidenceIds].slice(0, maxEvidenceIds),
    }))
    .sort((a, b) => b.aging_applications - a.aging_applications || b.average_dwell_days - a.average_dwell_days || a.job_id - b.job_id);
}

function stageSeverity(entry: StageAccumulator, minAgeDays: number): number {
  const average = mean(entry.dwellDays);
  const p90 = percentile(entry.dwellDays, 0.9);
  const agingComponent = entry.agingApplications * 10;
  const spreadComponent = Math.max(0, p90 - minAgeDays);
  return Math.round(average + spreadComponent + agingComponent);
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
  return deny(toolName, "UPSTREAM_ERROR", classifyUpstreamError(error, "Stage latency analysis failed before returning data."));
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
  return emitRequiredToolAudit(runtime, STAGE_LATENCY_TOOL.name, "analysis", startedAt, correlationId, result, rowsRead, rowsReturned, actAsUser);
}

function isActiveApplicationStatus(status: string | null): boolean {
  return isActiveAnalysisStatus(normalizeAnalysisStatus(status));
}

function firstApplicationTimestamp(row: Record<string, unknown>): string | null {
  for (const key of ["created_at", "applied_at", "last_activity_at"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value))) {
      return value;
    }
  }
  return null;
}

function readStageDwellDays(row: Record<string, unknown>, endMs: number): number | null {
  const enteredAt = typeof row.entered_at === "string" ? Date.parse(row.entered_at) : NaN;
  if (!Number.isFinite(enteredAt) || !Number.isFinite(endMs) || endMs < enteredAt) return null;
  const documentedDays = readNonNegativeFiniteNumber(row.days_in_stage);
  if (documentedDays !== null) return documentedDays;
  return (endMs - enteredAt) / (24 * 60 * 60 * 1000);
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

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}
