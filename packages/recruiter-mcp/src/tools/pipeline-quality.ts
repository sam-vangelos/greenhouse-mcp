import { APPLICATION_ANALYSIS_READ_PARAM_NAMES, assertWindowWithinLimit, hasExplicitAnalysisWindow, isToolEnabled, readNonNegativeFiniteNumber, readPositiveInt, resolveAnalysisWindow, sanitizeReadParams } from "../limits.js";
import { createToolDeadline, deny, emitRequiredToolAudit, enforceUsageBudget, isToolCancelledError, isToolTimeoutError, type RecruiterToolRuntime } from "../runtime.js";
import { newCorrelationId } from "../audit.js";
import { IdentityResolutionError } from "../identity.js";
import { buildEvidencePack, stripEvidencePackParams } from "./evidence-pack.js";
import { readApplicationCurrentStageAt, readApplicationJobId, readApplicationStageId, readApplicationStageName } from "./application-shapes.js";
import { isActiveAnalysisStatus, normalizeAnalysisStatus } from "./analysis-scalars.js";
import { resolveAnalysisContext } from "../resolution/analysis-context.js";
import { attachAnalysisScope, buildAnalysisCompleteness } from "../resolution/analysis-result.js";
import { detectDataProvenance } from "../resolution/provenance.js";
import { buildTemporalView } from "../resolution/temporal.js";
import { classifyUpstreamError, readAllScopedRows, readStatusMessage } from "../read-all.js";
import { buildApplicationLifecycleFacts } from "../facts.js";
import { buildAnalysisFactMetricLayer } from "./analysis-fact-metrics.js";
import type { RecruiterToolDefinition, RecruiterToolResult } from "../types.js";

export const PIPELINE_QUALITY_TOOL: RecruiterToolDefinition = {
  name: "analyze_pipeline_quality",
  kind: "analysis",
  description:
    "Analyze scoped pipeline quality using application status mix, stale active applications, stage concentration, job breakdown, data-quality gaps, and evidence ids.",
};

interface ApplicationRow extends Record<string, unknown> {
  id: number | null;
  candidate_id: number | null;
  job_id: number | null;
  stage_id: number | null;
  stage_name: string | null;
  status: string | null;
  created_at?: string | null;
  applied_at?: string | null;
  current_stage_at: string | null;
  last_activity_at: string | null;
}

interface ApplicationObservation {
  applicationId: number | null;
  candidateId: number | null;
  jobId: number | null;
  stageId: number | null;
  stageName: string | null;
  status: string;
  active: boolean;
  terminal: boolean;
  staleActive: boolean;
  missingLastActivity: boolean;
  applicationTimestamp: string | null;
  lastActivityAt: string | null;
  lastActivityDaysAgo: number | null;
  currentStageDays: number | null;
}

interface GroupAccumulator {
  key: string;
  label: string | null;
  applicationCount: number;
  activeCount: number;
  terminalCount: number;
  staleActiveCount: number;
  hiredCount: number;
  rejectedCount: number;
  convertedCount: number;
  affectedJobs: Set<number>;
  evidenceIds: Set<string>;
  stageAges: number[];
}

export async function runPipelineQuality(
  runtime: RecruiterToolRuntime,
  params: Record<string, unknown>
): Promise<RecruiterToolResult> {
  const toolName = PIPELINE_QUALITY_TOOL.name;
  const startedAt = runtime.now();
  const deadline = createToolDeadline(runtime, startedAt);
  const correlationId = newCorrelationId(runtime.now);
  const actAsUser = runtime.trustedActAsUser ?? null;

  if (!isToolEnabled(runtime.toolConfig, runtime.session.surface, toolName, "analysis")) {
    const result = deny(toolName, "TOOL_DISABLED", "Pipeline quality analysis is disabled for this runtime.");
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
    const maxRankings = Math.min(readPositiveInt(params.max_rankings) ?? runtime.limits.maxRankings, runtime.limits.maxRankings);
    const maxEvidenceIds = runtime.limits.maxEvidenceIds;
    const staleDays = readNonNegativeFiniteNumber(params.stale_days) ?? 14;
    const applicationParams = sanitizeReadParams(
      {
        ...params,
        per_page: params.per_page,
      },
      runtime.limits,
      { allowedParamNames: APPLICATION_ANALYSIS_READ_PARAM_NAMES }
    );
    delete applicationParams.window_start;
    delete applicationParams.window_end;
    delete applicationParams.max_rankings;
    delete applicationParams.stale_days;
    stripEvidencePackParams(applicationParams);

    const applications = await readAllScopedRows<ApplicationRow>(runtime, toolName, "list_applications", applicationParams, deadline);
    if (applications.kind === "denial") {
      const auditDenied = await emitAnalysisAudit(runtime, startedAt, correlationId, applications.result, null, null, actAsUser);
      return auditDenied ?? applications.result;
    }

    // Exclude prospects entirely: they are pre-applicants with no measured outcome and were
    // silently inflating pipeline volume/status mix (ledger #32).
    const nonProspectRows = applications.rows.filter((row) => (row as { prospect?: unknown }).prospect !== true);
    const prospectsExcluded = applications.rows.length - nonProspectRows.length;
    const observations = buildObservations(nonProspectRows, window.windowEnd, staleDays);
    const active = observations.filter((row) => row.active).length;
    const terminal = observations.filter((row) => row.terminal).length;
    const staleActive = observations.filter((row) => row.staleActive).length;
    const hired = observations.filter((row) => row.status === "hired").length;
    const rejected = observations.filter((row) => row.status === "rejected").length;
    const converted = observations.filter((row) => row.status === "converted").length;
    const missingJob = observations.filter((row) => row.jobId === null).length;
    const missingStage = observations.filter((row) => row.stageId === null && row.stageName === null).length;
    const missingLastActivity = observations.filter((row) => row.missingLastActivity).length;
    const missingStageTiming = observations.filter((row) => row.active && row.currentStageDays === null).length;
    const stageRankings = buildGroupRankings(observations, "stage", staleDays, maxEvidenceIds).slice(0, maxRankings);
    const jobRankings = buildGroupRankings(observations, "job", staleDays, maxEvidenceIds).slice(0, maxRankings);
    const evidencePack = buildEvidencePack(params, [
      { name: "stage_rankings", rows: stageRankings },
      { name: "job_breakdown", rows: jobRankings },
    ], runtime.limits.maxEvidenceIds);
    const factMetricLayer = buildAnalysisFactMetricLayer({
      facts: { application_lifecycle_fact: buildApplicationLifecycleFacts(applicationFactRows(observations)) },
      metricIds: [
        "weekly_application_volume",
        "weekly_qualified_pipeline_movement",
        "source_quality_by_outcome",
      ],
      nowMs: Date.parse(window.windowEnd),
      readStatus: applications.status,
    });

    const summary = {
      question: "pipeline quality",
      snapshot_as_of: window.windowEnd,
      freshness_window_start: window.windowStart,
      rows_read: applications.rawRowsRead,
      pages_read: applications.pagesRead,
      per_page: applications.perPage,
      read_status: applications.status,
      read_complete: applications.complete,
      next_cursor: applications.nextCursor,
      pagination_truncated: applications.paginationTruncated,
      rate_limit_retries: applications.rateLimitRetries,
      cache_hits: applications.cacheHits,
      rate_limit_sleep_ms: applications.rateLimitSleepMs,
      rows_considered: observations.length,
      prospects_excluded: prospectsExcluded,
      stale_days: staleDays,
      scoped_job_count: new Set(observations.map((row) => row.jobId).filter(isPositiveInteger)).size,
      read_warnings: applications.warnings,
      field_limitations: [
        "v1 uses scoped application status, current stage, last activity, and job/candidate ids.",
        "source, agency, rejection-reason, and offer-quality analysis require additional scoped fields or dedicated tools.",
        // Rank 46: don't dead-end — point at the tools that already close part of this. Source/agency
        // yield via analyze_source_quality; rejection-reason drift via analyze_rejection_reason_drift
        // (shipped). Offer quality remains planner-domain (Slice PLANNER).
        "For source/agency yield, run analyze_source_quality (it resolves source/referrer ids to names and computes quality by outcome). For rejection-reason breakdown, run analyze_rejection_reason_drift. Offer-quality analysis is not yet built.",
      ],
    };
    const metrics = {
      applications_considered: observations.length,
      active_applications: active,
      terminal_applications: terminal,
      hired_applications: hired,
      rejected_applications: rejected,
      converted_applications: converted,
      active_rate: ratio(active, observations.length),
      terminal_rate: ratio(terminal, observations.length),
      hired_rate: ratio(hired, observations.length),
      rejected_rate: ratio(rejected, observations.length),
      stale_active_applications: staleActive,
      stale_active_rate: ratio(staleActive, active),
      top_stage_active_concentration: topStageConcentration(observations),
    };
    const status_mix = statusMix(observations);
    const data_quality = {
      missing_job_id: missingJob,
      missing_stage: missingStage,
      missing_last_activity_at: missingLastActivity,
      missing_stage_timing: missingStageTiming,
      missing_job_id_rate: ratio(missingJob, observations.length),
      missing_stage_rate: ratio(missingStage, observations.length),
      missing_last_activity_at_rate: ratio(missingLastActivity, observations.length),
      missing_stage_timing_rate: ratio(missingStageTiming, observations.length),
    };
    const nextSteps = [
      "Inspect stale active evidence ids with get_my_application.",
      "Run analyze_stage_latency on the same job_ids to identify the stage-level drag behind the pipeline quality signal.",
      "Use analyze_scorecard_accountability where active pipeline drag may be feedback-driven.",
    ];
    // L4 provenance/freshness detector: flag migration-shaped data (tight created_at cluster, records
    // predating the req, all-default-status) so the figures above read as provisional, never findings.
    // all-default-status is only meaningful on a representative full-status read: if the caller passed a
    // status filter (e.g. status=active), the disposition mix is not representative and "zero
    // dispositions" would be tautological — so feed isTerminal only on an unfiltered read.
    const fullStatusRead = applicationParams.status === undefined;
    const provenance = detectDataProvenance(
      observations.map((row) => ({ timestamp: row.applicationTimestamp, isTerminal: fullStatusRead ? row.terminal : undefined, jobId: row.jobId })),
      { nowMs: runtime.now(), jobAnchors: scope.jobAnchors, recordKind: "application" }
    );
    // Temporal-now mode: weekly inflow, a genuine two-window WoW diff, status-mix trend, and velocity
    // from real application created_at. Stage-flow-over-time is disclosed unavailable (L3), never faked.
    const temporal = buildTemporalView(
      observations.map((row) => ({ timestamp: row.applicationTimestamp, status: row.status })),
      { nowMs: runtime.now(), basis: "application created_at (inflow anchor; falls back to applied_at, last_activity_at)" }
    );
    const envelope = attachAnalysisScope({
      data: {
        summary,
        metrics,
        fact_metric_layer: factMetricLayer,
        status_mix,
        stage_rankings: stageRankings,
        job_breakdown: jobRankings,
        data_quality,
        temporal,
        evidence_ids: [
          ...stageRankings.flatMap((entry) => entry.evidence_ids),
          ...jobRankings.flatMap((entry) => entry.evidence_ids),
        ].slice(0, maxEvidenceIds),
        denials: [],
        next_steps: nextSteps,
        ...(evidencePack ? { evidence_pack: evidencePack } : {}),
      },
      completeness: buildAnalysisCompleteness({
        totalRecordsInScope: applications.rows.length,
        recordsAnalyzed: observations.length,
        exclusionReasons: prospectsExcluded > 0 ? [{ reason: "prospect_record", count: prospectsExcluded }] : [],
        inventoryComplete: applications.complete,
        anyPaginationTruncated: !applications.complete,
        // current_stage timing is ~0% populated on Harvest v3; when it is missing the
        // average-current-stage-days metric collapses, so freshness is degraded even
        // though stale-active (driven by last_activity_at) is still computed.
        dataFreshnessOk: missingStageTiming === 0,
        provenance,
        message: readStatusMessage(applications.status),
      }),
      attribution_summary: {
        findings_ranked: stageRankings.length + jobRankings.length,
        unresolved: missingJob + missingStage + missingLastActivity + missingStageTiming,
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
    const auditDenied = await emitAnalysisAudit(runtime, startedAt, correlationId, result, applications.rawRowsRead, observations.length, actAsUser);
    return auditDenied ?? result;
  } catch (error) {
    const result = errorToDenial(toolName, error);
    const auditDenied = await emitAnalysisAudit(runtime, startedAt, correlationId, result, null, null, actAsUser);
    return auditDenied ?? result;
  }
}

function buildObservations(applications: ApplicationRow[], windowEnd: string, staleDays: number): ApplicationObservation[] {
  const asOf = Date.parse(windowEnd);
  return applications.map((row) => {
    const status = normalizeStatus(row.status);
    const lastActivityDaysAgo = daysAgo(row.last_activity_at, asOf);
    const currentStageDays = daysAgo(readApplicationCurrentStageAt(row), asOf);
    const active = isActiveStatus(status);
    const missingLastActivity = lastActivityDaysAgo === null;
    return {
      applicationId: readPositiveNumber(row.id),
      candidateId: readPositiveNumber(row.candidate_id),
      jobId: readApplicationJobId(row),
      stageId: readApplicationStageId(row),
      stageName: readApplicationStageName(row),
      status,
      active,
      terminal: isTerminalStatus(status),
      staleActive: active && (missingLastActivity || lastActivityDaysAgo >= staleDays),
      missingLastActivity,
      applicationTimestamp: readFirstDateString(row, ["created_at", "applied_at", "last_activity_at"]),
      lastActivityAt: typeof row.last_activity_at === "string" ? row.last_activity_at : null,
      lastActivityDaysAgo,
      currentStageDays,
    };
  });
}

function applicationFactRows(observations: ApplicationObservation[]): Record<string, unknown>[] {
  return observations.map((row) => ({
    id: row.applicationId,
    candidate_id: row.candidateId,
    job_id: row.jobId,
    stage_id: row.stageId,
    status: row.status,
    created_at: row.applicationTimestamp,
    last_activity_at: row.lastActivityAt,
  }));
}

function buildGroupRankings(observations: ApplicationObservation[], kind: "stage" | "job", staleDays: number, maxEvidenceIds: number) {
  const groups = new Map<string, GroupAccumulator>();
  for (const row of observations) {
    const key = kind === "stage"
      ? row.stageId !== null ? `stage:${row.stageId}` : `stage_name:${row.stageName ?? "unknown"}`
      : row.jobId !== null ? `job:${row.jobId}` : "job:unknown";
    const label = kind === "stage" ? row.stageName : row.jobId !== null ? String(row.jobId) : null;
    const group = groups.get(key) ?? {
      key,
      label,
      applicationCount: 0,
      activeCount: 0,
      terminalCount: 0,
      staleActiveCount: 0,
      hiredCount: 0,
      rejectedCount: 0,
      convertedCount: 0,
      affectedJobs: new Set<number>(),
      evidenceIds: new Set<string>(),
      stageAges: [],
    };
    group.applicationCount += 1;
    if (row.active) group.activeCount += 1;
    if (row.terminal) group.terminalCount += 1;
    if (row.staleActive) group.staleActiveCount += 1;
    if (row.status === "hired") group.hiredCount += 1;
    if (row.status === "rejected") group.rejectedCount += 1;
    if (row.status === "converted") group.convertedCount += 1;
    if (row.jobId !== null) {
      group.affectedJobs.add(row.jobId);
      group.evidenceIds.add(`job:${row.jobId}`);
    }
    if (row.applicationId !== null) group.evidenceIds.add(`application:${row.applicationId}`);
    if (row.candidateId !== null) group.evidenceIds.add(`candidate:${row.candidateId}`);
    if (row.currentStageDays !== null) group.stageAges.push(row.currentStageDays);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      key: group.key,
      label: group.label,
      severity_score: qualitySeverity(group, staleDays),
      application_count: group.applicationCount,
      active_applications: group.activeCount,
      terminal_applications: group.terminalCount,
      stale_active_applications: group.staleActiveCount,
      stale_active_rate: ratio(group.staleActiveCount, group.activeCount),
      hired_applications: group.hiredCount,
      rejected_applications: group.rejectedCount,
      converted_applications: group.convertedCount,
      average_current_stage_days: round(mean(group.stageAges), 1),
      affected_jobs: [...group.affectedJobs].sort((a, b) => a - b),
      evidence_ids: [...group.evidenceIds].slice(0, maxEvidenceIds),
    }))
    .sort((a, b) => b.severity_score - a.severity_score || b.stale_active_applications - a.stale_active_applications || b.application_count - a.application_count || a.key.localeCompare(b.key));
}

function statusMix(observations: ApplicationObservation[]) {
  const counts = new Map<string, number>();
  for (const row of observations) {
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([status, count]) => ({ status, count, rate: ratio(count, observations.length) }))
    .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));
}

function topStageConcentration(observations: ApplicationObservation[]): number {
  const activeRows = observations.filter((row) => row.active);
  if (activeRows.length === 0) return 0;
  const byStage = new Map<string, number>();
  for (const row of activeRows) {
    const key = row.stageId !== null ? `stage:${row.stageId}` : `stage_name:${row.stageName ?? "unknown"}`;
    byStage.set(key, (byStage.get(key) ?? 0) + 1);
  }
  return ratio(Math.max(...byStage.values()), activeRows.length);
}

function qualitySeverity(group: GroupAccumulator, staleDays: number): number {
  const staleComponent = group.staleActiveCount * 12;
  const volumeComponent = group.activeCount * 2;
  const ageComponent = Math.max(0, mean(group.stageAges) - staleDays);
  return Math.round(staleComponent + volumeComponent + ageComponent);
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
  return deny(toolName, "UPSTREAM_ERROR", classifyUpstreamError(error, "Pipeline quality analysis failed before returning data."));
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
  return emitRequiredToolAudit(runtime, PIPELINE_QUALITY_TOOL.name, "analysis", startedAt, correlationId, result, rowsRead, rowsReturned, actAsUser);
}

function normalizeStatus(status: string | null): string {
  return normalizeAnalysisStatus(status);
}

function isActiveStatus(status: string): boolean {
  return isActiveAnalysisStatus(status);
}

function isTerminalStatus(status: string): boolean {
  return status === "rejected" || status === "hired" || status === "converted";
}

function daysAgo(value: string | null | undefined, asOf: number): number | null {
  if (!value) return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at) || !Number.isFinite(asOf) || at > asOf) return null;
  return (asOf - at) / (24 * 60 * 60 * 1000);
}

function readFirstDateString(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value))) {
      return value;
    }
  }
  return null;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator, 4);
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
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
