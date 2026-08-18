import { SOURCE_QUALITY_APPLICATION_READ_PARAM_NAMES, assertWindowWithinLimit, hasExplicitAnalysisWindow, isToolEnabled, readNonNegativeFiniteNumber, readPositiveInt, resolveAnalysisWindow, sanitizeReadParams } from "../limits.js";
import { createToolDeadline, deny, emitRequiredToolAudit, enforceUsageBudget, isToolCancelledError, isToolTimeoutError, type RecruiterToolRuntime, type ToolDeadline } from "../runtime.js";
import { newCorrelationId } from "../audit.js";
import { IdentityResolutionError } from "../identity.js";
import { buildEvidencePack, stripEvidencePackParams } from "./evidence-pack.js";
import { readApplicationJobId } from "./application-shapes.js";
import { isActiveAnalysisStatus, normalizeAnalysisStatus } from "./analysis-scalars.js";
import { resolveAnalysisContext } from "../resolution/analysis-context.js";
import { attachAnalysisScope, buildAnalysisCompleteness } from "../resolution/analysis-result.js";
import { detectDataProvenance } from "../resolution/provenance.js";
import { buildTemporalView } from "../resolution/temporal.js";
import { classifyUpstreamError, readAllScopedRows, readStatusMessage } from "../read-all.js";
import { referenceName, resolveReferenceNames } from "./reference-names.js";
import { buildApplicationLifecycleFacts } from "../facts.js";
import { buildAnalysisFactMetricLayer } from "./analysis-fact-metrics.js";
import type { RecruiterToolDefinition, RecruiterToolResult } from "../types.js";

export const SOURCE_QUALITY_TOOL: RecruiterToolDefinition = {
  name: "analyze_source_quality",
  kind: "analysis",
  description:
    "Rank scoped application sources and referrers by outcome quality, stale active drag, affected jobs, and evidence ids, resolving each source/referrer id to its name.",
};

interface ApplicationRow extends Record<string, unknown> {
  id?: unknown;
  candidate_id?: unknown;
  job_id?: unknown;
  source_id?: unknown;
  referrer_id?: unknown;
  status?: unknown;
  applied_at?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  last_activity_at?: unknown;
}

interface ApplicationObservation {
  applicationId: number | null;
  candidateId: number | null;
  jobId: number | null;
  sourceId: number | null;
  referrerId: number | null;
  status: string;
  active: boolean;
  terminal: boolean;
  success: boolean;
  rejected: boolean;
  staleActive: boolean;
  missingLastActivity: boolean;
  applicationTimestamp: string | null;
}

interface AttributionAccumulator {
  key: string;
  id: number;
  applicationCount: number;
  activeCount: number;
  terminalCount: number;
  successCount: number;
  hiredCount: number;
  convertedCount: number;
  rejectedCount: number;
  staleActiveCount: number;
  affectedJobs: Set<number>;
  evidenceIds: Set<string>;
}

export async function runSourceQuality(
  runtime: RecruiterToolRuntime,
  params: Record<string, unknown>
): Promise<RecruiterToolResult> {
  const toolName = SOURCE_QUALITY_TOOL.name;
  const startedAt = runtime.now();
  const deadline = createToolDeadline(runtime, startedAt);
  const correlationId = newCorrelationId(runtime.now);
  const actAsUser = runtime.trustedActAsUser ?? null;

  if (!isToolEnabled(runtime.toolConfig, runtime.session.surface, toolName, "analysis")) {
    const result = deny(toolName, "TOOL_DISABLED", "Source quality analysis is disabled for this runtime.");
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
      { allowedParamNames: SOURCE_QUALITY_APPLICATION_READ_PARAM_NAMES }
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
    // silently inflating application volume/quality (ledger #32).
    const nonProspectRows = applications.rows.filter((row) => (row as { prospect?: unknown }).prospect !== true);
    const prospectsExcluded = applications.rows.length - nonProspectRows.length;
    const observations = buildObservations(nonProspectRows, window.windowStart, window.windowEnd, staleDays);
    const outsideWindowCount = nonProspectRows.length - observations.length;
    const baseSourceRankings = buildAttributionRankings(observations, "source", maxEvidenceIds).slice(0, maxRankings);
    const baseReferrerRankings = buildAttributionRankings(observations, "referrer", maxEvidenceIds).slice(0, maxRankings);
    // #10: resolve source/referrer ids to human-readable names via the scoped reference reads, so
    // the recipe answers with "LinkedIn" rather than "source 44". Best-effort enrichment within the
    // already-authorized session: an unresolved id degrades to a null name, never failing the
    // analysis. Names come from /v3/sources and /v3/referrers, NOT from any nested name on the
    // application row (those are deliberately ignored — see readAttributionId).
    const sourceNames = baseSourceRankings.length > 0
      ? await resolveReferenceNames(runtime, toolName, "list_sources", deadline)
      : new Map<number, string>();
    const referrerNames = baseReferrerRankings.length > 0
      ? await resolveReferenceNames(runtime, toolName, "list_referrers", deadline)
      : new Map<number, string>();
    const sourceRankings = baseSourceRankings.map((ranking) => ({
      ...ranking,
      source_name: referenceName(sourceNames, (ranking as Record<string, unknown>).source_id, "source"),
    }));
    const referrerRankings = baseReferrerRankings.map((ranking) => ({
      ...ranking,
      referrer_name: referenceName(referrerNames, (ranking as Record<string, unknown>).referrer_id, "referrer"),
    }));
    const missingSource = observations.filter((row) => row.sourceId === null).length;
    const missingReferrer = observations.filter((row) => row.referrerId === null).length;
    const missingTimestamp = observations.filter((row) => row.applicationTimestamp === null).length;
    const success = observations.filter((row) => row.success).length;
    const rejected = observations.filter((row) => row.rejected).length;
    const active = observations.filter((row) => row.active).length;
    const staleActive = observations.filter((row) => row.staleActive).length;
    const missingLastActivity = observations.filter((row) => row.missingLastActivity).length;
    const evidencePack = buildEvidencePack(params, [
      { name: "source_rankings", rows: sourceRankings },
      { name: "referrer_rankings", rows: referrerRankings },
    ], runtime.limits.maxEvidenceIds);
    const factMetricLayer = buildAnalysisFactMetricLayer({
      facts: { application_lifecycle_fact: buildApplicationLifecycleFacts(applicationFactRows(observations)) },
      metricIds: ["source_quality_by_outcome", "weekly_application_volume"],
      nowMs: Date.parse(window.windowEnd),
      readStatus: applications.status,
    });

    const summary = {
      question: "source and referrer quality",
      window_start: window.windowStart,
      window_end: window.windowEnd,
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
        "Source/referrer ids come from scoped application rows; their names are resolved separately from the /v3/sources and /v3/referrers reference reads and are null when an id has no matching reference row.",
        "Tracking-link labels, agency labels, and candidate identity are not returned by this analysis.",
        "rows without application timestamps are included in the snapshot and counted in data_quality.missing_application_timestamp.",
      ],
    };
    const metrics = {
      applications_considered: observations.length,
      source_groups: sourceRankings.length,
      referrer_groups: referrerRankings.length,
      successful_applications: success,
      rejected_applications: rejected,
      active_applications: active,
      stale_active_applications: staleActive,
      success_rate: ratio(success, observations.length),
      rejected_rate: ratio(rejected, observations.length),
      stale_active_rate: ratio(staleActive, active),
    };
    const data_quality = {
      missing_source_id: missingSource,
      missing_referrer_id: missingReferrer,
      missing_application_timestamp: missingTimestamp,
      missing_last_activity: missingLastActivity,
      missing_source_id_rate: ratio(missingSource, observations.length),
      missing_referrer_id_rate: ratio(missingReferrer, observations.length),
      missing_application_timestamp_rate: ratio(missingTimestamp, observations.length),
      missing_last_activity_rate: ratio(missingLastActivity, active),
    };
    const nextSteps = [
      "Use source_ids or referrer_ids filters to isolate an outlier and rerun this analysis on the same scoped req set.",
      "Use search_my_applications with the returned evidence ids to inspect affected scoped applications.",
      "Compare with analyze_pipeline_quality and analyze_stage_latency to separate attribution quality from downstream process drag.",
    ];
    // L4 provenance/freshness detector: flag migration-shaped data so source-quality figures read as
    // provisional, never findings (uniform across recipes — see resolution/provenance.ts). all-default-
    // status is evaluated only on a representative full-status read; a status-filtered read (if the
    // caller narrowed by status) would make "zero dispositions" tautological, so gate isTerminal on it.
    const fullStatusRead = applicationParams.status === undefined;
    const provenance = detectDataProvenance(
      observations.map((row) => ({ timestamp: row.applicationTimestamp, isTerminal: fullStatusRead ? row.terminal : undefined, jobId: row.jobId })),
      { nowMs: runtime.now(), jobAnchors: scope.jobAnchors, recordKind: "application" }
    );
    // Temporal-now mode: weekly inflow / WoW diff / status-mix trend / velocity (same machinery as
    // pipeline_quality — see resolution/temporal.ts). NOTE the inflow anchor differs: this recipe
    // resolves applied_at-first (vs pipeline_quality's created_at-first), so the `basis` below states
    // applied_at honestly rather than claiming created_at. Stage-flow over time disclosed unavailable.
    const temporal = buildTemporalView(
      observations.map((row) => ({ timestamp: row.applicationTimestamp, status: row.status })),
      { nowMs: runtime.now(), basis: "application applied_at (inflow anchor; falls back to created_at, updated_at, last_activity_at)" }
    );
    const envelope = attachAnalysisScope({
      data: {
        summary,
        metrics,
        fact_metric_layer: factMetricLayer,
        source_rankings: sourceRankings,
        referrer_rankings: referrerRankings,
        data_quality,
        temporal,
        evidence_ids: [
          ...sourceRankings.flatMap((entry) => entry.evidence_ids),
          ...referrerRankings.flatMap((entry) => entry.evidence_ids),
        ].slice(0, maxEvidenceIds),
        denials: [],
        next_steps: nextSteps,
        ...(evidencePack ? { evidence_pack: evidencePack } : {}),
      },
      completeness: buildAnalysisCompleteness({
        totalRecordsInScope: applications.rows.length,
        recordsAnalyzed: observations.length,
        exclusionReasons: [
          ...(prospectsExcluded > 0 ? [{ reason: "prospect_record", count: prospectsExcluded }] : []),
          ...(outsideWindowCount > 0 ? [{ reason: "outside_analysis_window", count: outsideWindowCount }] : []),
        ],
        inventoryComplete: applications.complete,
        anyPaginationTruncated: !applications.complete,
        provenance,
        message: readStatusMessage(applications.status),
      }),
      attribution_summary: {
        findings_ranked: sourceRankings.length + referrerRankings.length,
        unresolved: missingSource + missingReferrer + missingTimestamp,
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

function buildObservations(
  applications: ApplicationRow[],
  windowStart: string,
  windowEnd: string,
  staleDays: number
): ApplicationObservation[] {
  const start = Date.parse(windowStart);
  const end = Date.parse(windowEnd);
  return applications
    .map((row) => {
      const applicationTimestamp = readFirstDateString(row, ["applied_at", "created_at", "updated_at", "last_activity_at"]);
      const timestampMs = applicationTimestamp === null ? null : Date.parse(applicationTimestamp);
      const status = normalizeStatus(typeof row.status === "string" ? row.status : null);
      const lastActivityDaysAgo = daysAgo(typeof row.last_activity_at === "string" ? row.last_activity_at : null, end);
      const active = isActiveStatus(status);
      return {
        applicationId: readPositiveNumber(row.id),
        candidateId: readPositiveNumber(row.candidate_id),
        jobId: readApplicationJobId(row),
        sourceId: readAttributionId(row, "source"),
        referrerId: readAttributionId(row, "referrer"),
        status,
        active,
        terminal: isTerminalStatus(status),
        success: status === "hired", // converted = prospect->candidate conversion, not a win (ledger #31)
        rejected: status === "rejected",
        staleActive: active && (lastActivityDaysAgo === null || lastActivityDaysAgo >= staleDays),
        missingLastActivity: active && lastActivityDaysAgo === null,
        applicationTimestamp,
        timestampMs,
      };
    })
    .filter((row) => row.timestampMs === null || (row.timestampMs >= start && row.timestampMs <= end))
    .map(({ timestampMs: _timestampMs, ...row }) => row);
}

function buildAttributionRankings(observations: ApplicationObservation[], kind: "source" | "referrer", maxEvidenceIds: number) {
  const groups = new Map<string, AttributionAccumulator>();
  for (const row of observations) {
    const id = kind === "source" ? row.sourceId : row.referrerId;
    if (id === null) continue;
    const key = `${kind}:${id}`;
    const group = groups.get(key) ?? {
      key,
      id,
      applicationCount: 0,
      activeCount: 0,
      terminalCount: 0,
      successCount: 0,
      hiredCount: 0,
      convertedCount: 0,
      rejectedCount: 0,
      staleActiveCount: 0,
      affectedJobs: new Set<number>(),
      evidenceIds: new Set<string>(),
    };
    group.applicationCount += 1;
    if (row.active) group.activeCount += 1;
    if (row.terminal) group.terminalCount += 1;
    if (row.success) group.successCount += 1;
    if (row.status === "hired") group.hiredCount += 1;
    if (row.status === "converted") group.convertedCount += 1;
    if (row.rejected) group.rejectedCount += 1;
    if (row.staleActive) group.staleActiveCount += 1;
    if (row.jobId !== null) {
      group.affectedJobs.add(row.jobId);
      group.evidenceIds.add(`job:${row.jobId}`);
    }
    if (row.applicationId !== null) group.evidenceIds.add(`application:${row.applicationId}`);
    if (row.candidateId !== null) group.evidenceIds.add(`candidate:${row.candidateId}`);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => {
      const successRate = ratio(group.successCount, group.applicationCount);
      const terminalSuccessRate = ratio(group.successCount, group.terminalCount);
      const staleActiveRate = ratio(group.staleActiveCount, group.activeCount);
      const rejectedRate = ratio(group.rejectedCount, group.applicationCount);
      return {
        key: group.key,
        [`${kind}_id`]: group.id,
        quality_score: qualityScore(successRate, terminalSuccessRate, staleActiveRate, group.activeCount),
        risk_score: riskScore(rejectedRate, staleActiveRate, successRate, group.applicationCount),
        application_count: group.applicationCount,
        active_applications: group.activeCount,
        terminal_applications: group.terminalCount,
        successful_applications: group.successCount,
        hired_applications: group.hiredCount,
        converted_applications: group.convertedCount,
        rejected_applications: group.rejectedCount,
        stale_active_applications: group.staleActiveCount,
        success_rate: successRate,
        terminal_success_rate: terminalSuccessRate,
        rejected_rate: rejectedRate,
        stale_active_rate: staleActiveRate,
        affected_jobs: [...group.affectedJobs].sort((a, b) => a - b),
        evidence_ids: [...group.evidenceIds].slice(0, maxEvidenceIds),
      };
    })
    .sort((a, b) => b.risk_score - a.risk_score || a.quality_score - b.quality_score || b.application_count - a.application_count || a.key.localeCompare(b.key));
}

function applicationFactRows(observations: ApplicationObservation[]): Record<string, unknown>[] {
  return observations.map((row) => ({
    id: row.applicationId,
    candidate_id: row.candidateId,
    job_id: row.jobId,
    source_id: row.sourceId,
    referrer_id: row.referrerId,
    status: row.status,
    created_at: row.applicationTimestamp,
  }));
}

function qualityScore(successRate: number, terminalSuccessRate: number, staleActiveRate: number, activeCount: number): number {
  const healthyActiveRate = activeCount === 0 ? 1 : 1 - staleActiveRate;
  return round(100 * (0.45 * successRate + 0.35 * terminalSuccessRate + 0.20 * healthyActiveRate), 1);
}

function riskScore(rejectedRate: number, staleActiveRate: number, successRate: number, applicationCount: number): number {
  const volumeWeight = Math.min(1, applicationCount / 3);
  return round(100 * (0.40 * rejectedRate + 0.35 * staleActiveRate + 0.25 * (1 - successRate)) * volumeWeight, 1);
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
  return deny(toolName, "UPSTREAM_ERROR", classifyUpstreamError(error, "Source quality analysis failed before returning data."));
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
  return emitRequiredToolAudit(runtime, SOURCE_QUALITY_TOOL.name, "analysis", startedAt, correlationId, result, rowsRead, rowsReturned, actAsUser);
}


function readAttributionId(row: Record<string, unknown>, kind: "source" | "referrer"): number | null {
  const flat = readPositiveNumber(row[`${kind}_id`]);
  if (flat !== null) return flat;
  const nested = row[kind];
  if (isRecord(nested)) {
    return readPositiveNumber(nested.id);
  }
  return null;
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

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator, 4);
}

function round(value: number, digits: number): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function readPositiveNumber(value: unknown): number | null {
  return readPositiveInt(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
