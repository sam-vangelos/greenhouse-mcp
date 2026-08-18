import type {
  ApplicationLifecycleFact,
  ApplicationStageTransitionFact,
  ApprovalFlowFact,
  FactBuildResult,
  FactCompletenessStatus,
  InterviewEventFact,
  JobPostExposureFact,
  NoteActivityFact,
  OfferFact,
  OpeningHeadcountFact,
  ProspectStateFact,
  ScorecardFact,
  ScorecardQuestionAnswerFact,
} from "./facts.js";
import type { RecruiterProjectionProfileName } from "./types.js";

export type MetricFactName =
  | "application_lifecycle_fact"
  | "application_stage_transition_fact"
  | "interview_event_fact"
  | "scorecard_fact"
  | "source_referrer_attribution_fact"
  | "job_post_exposure_fact"
  | "approval_flow_fact"
  | "prospect_state_fact"
  // Tier-3.1: previously-orphaned builders wired into the metric layer.
  | "note_activity_fact"
  | "opening_headcount_fact"
  | "offer_fact"
  | "scorecard_question_answer_fact";

export type MetricCompletenessStatus = FactCompletenessStatus | "failed_missing_fact" | "incomplete_truncated";

export interface MetricResult {
  metricId: string;
  completeness: MetricCompletenessStatus;
  value: number | null;
  numerator?: number;
  denominator?: number;
  unit?: "ratio" | "count" | "hours" | "days";
  groups?: Array<Record<string, string | number | null>>;
  evidenceRefs: string[];
  exclusions: string[];
  omissions: string[];
}

export interface MetricComputeContext {
  facts: Partial<Record<MetricFactName, FactBuildResult<unknown>>>;
  nowMs?: number;
  overdueDays?: number;
  slaHours?: number;
}

export type MetricComputeFn = (context: MetricComputeContext) => MetricResult;

export interface MetricDefinition {
  id: string;
  displayName: string;
  requiredFacts: MetricFactName[];
  requiredFields: string[];
  requiredRoleProfile: RecruiterProjectionProfileName;
  defaultTimeWindow?: string;
  scopeBehavior: "job" | "job_set" | "permitted_scope" | "org_reference";
  exclusions: string[];
  completenessRules: string[];
  compute: MetricComputeFn;
}

export const METRIC_REGISTRY: MetricDefinition[] = [
  {
    id: "scorecard_submission_rate",
    displayName: "Scorecard submission rate",
    requiredFacts: ["scorecard_fact"],
    requiredFields: ["scorecard_id", "status", "submitted_at"],
    requiredRoleProfile: "recruiter_default",
    defaultTimeWindow: "last_30_days",
    scopeBehavior: "job_set",
    exclusions: ["scorecards without a stable scorecard id"],
    completenessRules: ["scorecard_fact must be complete"],
    compute: (context) => ratioMetric("scorecard_submission_rate", scorecards(context), isScorecardSubmitted),
  },
  {
    id: "scorecard_overdue_rate",
    displayName: "Scorecard overdue rate",
    requiredFacts: ["scorecard_fact"],
    requiredFields: ["scorecard_id", "interviewed_at", "submitted_at"],
    requiredRoleProfile: "recruiter_default",
    defaultTimeWindow: "last_30_days",
    scopeBehavior: "job_set",
    exclusions: ["scorecards without interviewed_at are excluded from overdue denominator"],
    completenessRules: ["scorecard_fact must be complete"],
    compute: computeScorecardOverdueRate,
  },
  {
    id: "interview_feedback_sla_breach_rate",
    displayName: "Interview feedback SLA breach rate",
    requiredFacts: ["scorecard_fact"],
    requiredFields: ["interviewed_at", "submitted_at"],
    requiredRoleProfile: "recruiter_default",
    defaultTimeWindow: "last_30_days",
    scopeBehavior: "job_set",
    exclusions: ["scorecards missing either interviewed_at or submitted_at are excluded"],
    completenessRules: ["scorecard_fact must be complete"],
    compute: computeFeedbackSlaBreachRate,
  },
  {
    id: "availability_to_scheduled_interview_hours",
    displayName: "Time from availability received to scheduled interview",
    requiredFacts: ["interview_event_fact"],
    requiredFields: ["availability_received_at", "scheduled_at"],
    requiredRoleProfile: "recruiter_default",
    defaultTimeWindow: "last_30_days",
    scopeBehavior: "job_set",
    exclusions: ["interviews missing availability_received_at or scheduled_at are excluded"],
    completenessRules: ["interview_event_fact must be complete"],
    compute: (context) => averageDurationMetric("availability_to_scheduled_interview_hours", interviews(context), "availability_received_at", "scheduled_at"),
  },
  {
    id: "scheduled_interview_to_feedback_hours",
    displayName: "Time from interview to feedback completion",
    requiredFacts: ["scorecard_fact"],
    requiredFields: ["interviewed_at", "submitted_at"],
    requiredRoleProfile: "recruiter_default",
    defaultTimeWindow: "last_30_days",
    scopeBehavior: "job_set",
    exclusions: ["scorecards missing interviewed_at or submitted_at are excluded"],
    completenessRules: ["scorecard_fact must be complete"],
    compute: (context) => averageDurationMetric("scheduled_interview_to_feedback_hours", scorecards(context), "interviewed_at", "submitted_at"),
  },
  {
    id: "stage_conversion_rate",
    displayName: "Stage conversion rate",
    requiredFacts: ["application_stage_transition_fact"],
    requiredFields: ["application_stage_id", "exited_at"],
    requiredRoleProfile: "recruiter_default",
    defaultTimeWindow: "last_30_days",
    scopeBehavior: "job_set",
    exclusions: ["true stage-to-stage conversion is not yet implemented; it requires full stage history (current=false) joined on job_interview_stages.sort_order"],
    completenessRules: ["reported as failed_missing_fact until full-history conversion is implemented; current-stage rows cannot express A->B conversion"],
    // The prior predicate (exited_at presence over current-stage facts) was a structural 0 marked
    // complete: current stages never carry exited_at. Real conversion needs distinct applications at
    // stage A vs B by sort_order over full history, which the current evidence surface does not fetch.
    compute: () => notImplementedMetric(
      "stage_conversion_rate",
      "Stage-to-stage conversion is not yet implemented: it requires full application_stages history (current=false) joined on job_interview_stages.sort_order; only current-stage rows are available.",
    ),
  },
  {
    id: "stage_dwell_days",
    displayName: "Stage dwell",
    requiredFacts: ["application_stage_transition_fact"],
    requiredFields: ["days_in_stage"],
    requiredRoleProfile: "recruiter_default",
    defaultTimeWindow: "last_30_days",
    scopeBehavior: "job_set",
    exclusions: ["stage rows missing days_in_stage are excluded"],
    completenessRules: ["application_stage_transition_fact must be complete"],
    compute: (context) => averageNumberMetric("stage_dwell_days", stageTransitions(context), "days_in_stage", "days"),
  },
  {
    id: "weekly_application_volume",
    displayName: "Weekly application volume",
    requiredFacts: ["application_lifecycle_fact"],
    requiredFields: ["created_at"],
    requiredRoleProfile: "recruiter_default",
    defaultTimeWindow: "last_12_weeks",
    scopeBehavior: "job_set",
    exclusions: ["applications missing created_at are excluded from weekly grouping"],
    completenessRules: ["application_lifecycle_fact must be complete"],
    compute: (context) => weeklyCountMetric("weekly_application_volume", applications(context), "created_at"),
  },
  {
    id: "weekly_qualified_pipeline_movement",
    displayName: "Weekly not-rejected pipeline movement",
    requiredFacts: ["application_lifecycle_fact"],
    requiredFields: ["created_at", "status"],
    requiredRoleProfile: "recruiter_default",
    defaultTimeWindow: "last_12_weeks",
    scopeBehavior: "job_set",
    // "qualified" here means only "not yet rejected" — there is no qualification bar. The metric id
    // keeps the legacy name for contract stability; the operator-facing label says not-rejected (#36).
    exclusions: ["rejected applications are excluded; \"qualified\" means not-yet-rejected, not a qualification bar (#36)"],
    completenessRules: ["application_lifecycle_fact must be complete"],
    compute: (context) => weeklyCountMetric(
      "weekly_qualified_pipeline_movement",
      applications(context).map((result) => ({
        ...result,
        facts: result.facts.filter((fact) => normalized(fact.status) !== "rejected"),
      })),
      "created_at"
    ),
  },
  {
    id: "source_quality_by_outcome",
    displayName: "Source quality by outcome",
    requiredFacts: ["application_lifecycle_fact"],
    requiredFields: ["source_id", "status"],
    requiredRoleProfile: "recruiter_default",
    defaultTimeWindow: "last_90_days",
    scopeBehavior: "job_set",
    exclusions: ["applications missing source_id are excluded from source grouping"],
    completenessRules: ["application_lifecycle_fact must be complete"],
    compute: computeSourceQualityByOutcome,
  },
  {
    id: "job_post_exposure_by_post",
    displayName: "Job-post tracking-link count by post (exposure proxy)",
    requiredFacts: ["job_post_exposure_fact"],
    requiredFields: ["tracking_link_id", "related_post_id"],
    requiredRoleProfile: "recruiter_default",
    defaultTimeWindow: "last_90_days",
    scopeBehavior: "job_set",
    exclusions: [
      "tracking links missing related_post_id are grouped as unknown",
      "counts tracking links (share URLs) per post, a structural PROXY for exposure — NOT applicants-per-post",
    ],
    completenessRules: ["job_post_exposure_fact must be complete"],
    compute: computeJobPostExposureByPost,
  },
  {
    id: "approval_latency",
    displayName: "Approval bottleneck (pending age)",
    requiredFacts: ["approval_flow_fact"],
    requiredFields: ["created_at", "approval_status"],
    requiredRoleProfile: "recruiting_manager",
    defaultTimeWindow: "last_90_days",
    scopeBehavior: "job_set",
    exclusions: [
      "measures how long UNRESOLVED flows have been pending (now - created_at); v3 approval_flows carries no flow-level resolution timestamp, so resolved-latency is not computed rather than proxied from updated_at",
    ],
    completenessRules: ["approval_flow_fact must be available and complete"],
    compute: computeApprovalPendingAge,
  },
  {
    id: "prospect_pool_movement",
    displayName: "Prospect pool distribution",
    requiredFacts: ["prospect_state_fact"],
    requiredFields: ["pool_id", "pool_stage_id"],
    requiredRoleProfile: "recruiting_manager",
    defaultTimeWindow: "last_90_days",
    scopeBehavior: "job_set",
    exclusions: [
      "point-in-time distribution across pools/stages; MOVEMENT over time needs the pipeline-state snapshot logbook (weekly diffs), not a live read",
    ],
    completenessRules: ["prospect_state_fact must be available and complete"],
    compute: computeProspectPoolDistribution,
  },
  // Tier-3.1: metrics over the previously-orphaned facts, so every built fact has a consumer.
  {
    id: "note_activity_volume",
    displayName: "Note activity volume",
    requiredFacts: ["note_activity_fact"],
    requiredFields: ["type", "created_at"],
    requiredRoleProfile: "recruiter_default",
    defaultTimeWindow: "last_30_days",
    scopeBehavior: "permitted_scope",
    exclusions: ["counts note/activity rows by type; body-content classification (scheduling_request/feedback_chase) is a planner-domain follow-up"],
    completenessRules: ["note_activity_fact must be complete"],
    compute: computeNoteActivityVolume,
  },
  {
    id: "opening_fill_status",
    displayName: "Opening fill status",
    requiredFacts: ["opening_headcount_fact"],
    requiredFields: ["status", "open"],
    requiredRoleProfile: "recruiter_default",
    defaultTimeWindow: "current",
    scopeBehavior: "job_set",
    exclusions: ["an opening with open=false or a closed_at timestamp counts as closed; openings missing both count as open"],
    completenessRules: ["opening_headcount_fact must be complete"],
    compute: computeOpeningFillStatus,
  },
  {
    id: "offer_resolution",
    displayName: "Offer resolution mix",
    requiredFacts: ["offer_fact"],
    requiredFields: ["status"],
    requiredRoleProfile: "recruiter_default",
    defaultTimeWindow: "last_90_days",
    scopeBehavior: "job_set",
    exclusions: ["groups offers by their v3 status verbatim; no acceptance-rate is derived unless resolved statuses are present"],
    completenessRules: ["offer_fact must be complete"],
    compute: computeOfferResolutionMix,
  },
  {
    id: "rubric_answer_coverage",
    displayName: "Rubric answer coverage",
    requiredFacts: ["scorecard_question_answer_fact"],
    requiredFields: ["scorecard_id"],
    requiredRoleProfile: "recruiter_default",
    defaultTimeWindow: "last_90_days",
    scopeBehavior: "job_set",
    exclusions: ["counts structured rubric answers per scorecard; question-level quality judgment stays with the model over the raw rows"],
    completenessRules: ["scorecard_question_answer_fact must be complete"],
    compute: computeRubricAnswerCoverage,
  },
];

export const METRIC_REGISTRY_BY_ID: ReadonlyMap<string, MetricDefinition> = new Map(
  METRIC_REGISTRY.map((metric) => [metric.id, metric])
);

export function computeMetric(
  metricId: string,
  context: MetricComputeContext
): MetricResult {
  const metric = METRIC_REGISTRY_BY_ID.get(metricId);
  if (!metric) {
    return {
      metricId,
      completeness: "failed_missing_fact",
      value: null,
      evidenceRefs: [],
      exclusions: [],
      omissions: [`Unknown metric definition: ${metricId}`],
    };
  }
  return metric.compute(context);
}

function scorecards(context: MetricComputeContext): Array<FactBuildResult<ScorecardFact>> {
  return factResults(context, "scorecard_fact");
}

function interviews(context: MetricComputeContext): Array<FactBuildResult<InterviewEventFact>> {
  return factResults(context, "interview_event_fact");
}

function stageTransitions(context: MetricComputeContext): Array<FactBuildResult<ApplicationStageTransitionFact>> {
  return factResults(context, "application_stage_transition_fact");
}

function applications(context: MetricComputeContext): Array<FactBuildResult<ApplicationLifecycleFact>> {
  return factResults(context, "application_lifecycle_fact");
}

function jobPostExposures(context: MetricComputeContext): Array<FactBuildResult<JobPostExposureFact>> {
  return factResults(context, "job_post_exposure_fact");
}

function approvalFlows(context: MetricComputeContext): Array<FactBuildResult<ApprovalFlowFact>> {
  return factResults(context, "approval_flow_fact");
}

function prospectStates(context: MetricComputeContext): Array<FactBuildResult<ProspectStateFact>> {
  return factResults(context, "prospect_state_fact");
}

function noteActivities(context: MetricComputeContext): Array<FactBuildResult<NoteActivityFact>> {
  return factResults(context, "note_activity_fact");
}

function openingHeadcounts(context: MetricComputeContext): Array<FactBuildResult<OpeningHeadcountFact>> {
  return factResults(context, "opening_headcount_fact");
}

function offerFacts(context: MetricComputeContext): Array<FactBuildResult<OfferFact>> {
  return factResults(context, "offer_fact");
}

function rubricAnswers(context: MetricComputeContext): Array<FactBuildResult<ScorecardQuestionAnswerFact>> {
  return factResults(context, "scorecard_question_answer_fact");
}

function computeApprovalPendingAge(context: MetricComputeContext): MetricResult {
  const readiness = metricReadiness("approval_latency", approvalFlows(context));
  if (readiness) return readiness;
  const nowMs = context.nowMs ?? Date.now();
  const pendingAges: Array<{ approval_flow_id: number; job_id: number | null; approval_status: string | null; pending_days: number }> = [];
  let unresolvedWithoutTimestamp = 0;
  for (const fact of approvalFlows(context).flatMap((result) => result.facts)) {
    const status = fact.approval_status ?? null;
    if (status === "approved" || status === "rejected" || status === "complete") continue;
    const createdMs = fact.created_at ? Date.parse(fact.created_at) : Number.NaN;
    if (!Number.isFinite(createdMs)) {
      unresolvedWithoutTimestamp += 1;
      continue;
    }
    pendingAges.push({
      approval_flow_id: fact.approval_flow_id,
      job_id: fact.job_id ?? null,
      approval_status: status,
      pending_days: Math.max(0, Math.round((nowMs - createdMs) / (24 * 60 * 60 * 1000))),
    });
  }
  pendingAges.sort((a, b) => b.pending_days - a.pending_days);
  const sorted = pendingAges.map((entry) => entry.pending_days).sort((a, b) => a - b);
  const median = sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)];
  return {
    metricId: "approval_latency",
    completeness: "complete",
    value: median,
    unit: "days",
    groups: pendingAges,
    evidenceRefs: evidenceRefsForFactResults(approvalFlows(context)),
    exclusions: metricExclusions("approval_latency"),
    omissions: unresolvedWithoutTimestamp > 0
      ? [`${unresolvedWithoutTimestamp} unresolved flow(s) carried no created_at and were excluded from pending-age.`]
      : [],
  };
}

function computeProspectPoolDistribution(context: MetricComputeContext): MetricResult {
  const readiness = metricReadiness("prospect_pool_movement", prospectStates(context));
  if (readiness) return readiness;
  const groups = new Map<string, number>();
  let total = 0;
  for (const fact of prospectStates(context).flatMap((result) => result.facts)) {
    total += 1;
    const key = `${fact.pool_id ?? "unknown"}:${fact.pool_stage_id ?? "unknown"}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return {
    metricId: "prospect_pool_movement",
    completeness: "complete",
    value: total,
    unit: "count",
    groups: [...groups.entries()].map(([key, prospect_count]) => {
      const [pool_id, pool_stage_id] = key.split(":");
      return { pool_id, pool_stage_id, prospect_count };
    }),
    evidenceRefs: evidenceRefsForFactResults(prospectStates(context)),
    exclusions: metricExclusions("prospect_pool_movement"),
    omissions: [],
  };
}

function computeNoteActivityVolume(context: MetricComputeContext): MetricResult {
  const readiness = metricReadiness("note_activity_volume", noteActivities(context));
  if (readiness) return readiness;
  const groups = new Map<string, number>();
  let total = 0;
  for (const fact of noteActivities(context).flatMap((result) => result.facts)) {
    total += 1;
    const key = fact.type ?? "unknown";
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return {
    metricId: "note_activity_volume",
    completeness: "complete",
    value: total,
    unit: "count",
    groups: [...groups.entries()].map(([note_type, note_count]) => ({ note_type, note_count })),
    evidenceRefs: evidenceRefsForFactResults(noteActivities(context)),
    exclusions: metricExclusions("note_activity_volume"),
    omissions: [],
  };
}

function computeOpeningFillStatus(context: MetricComputeContext): MetricResult {
  const readiness = metricReadiness("opening_fill_status", openingHeadcounts(context));
  if (readiness) return readiness;
  let open = 0;
  let closed = 0;
  const byJob = new Map<string, { open: number; closed: number }>();
  for (const fact of openingHeadcounts(context).flatMap((result) => result.facts)) {
    const bucket = byJob.get(String(fact.job_id)) ?? { open: 0, closed: 0 };
    if (fact.open === false || fact.closed_at) {
      closed += 1;
      bucket.closed += 1;
    } else {
      open += 1;
      bucket.open += 1;
    }
    byJob.set(String(fact.job_id), bucket);
  }
  return {
    metricId: "opening_fill_status",
    completeness: "complete",
    value: open,
    numerator: open,
    denominator: open + closed,
    unit: "count",
    groups: [...byJob.entries()].map(([job_id, counts]) => ({ job_id, open_openings: counts.open, closed_openings: counts.closed })),
    evidenceRefs: evidenceRefsForFactResults(openingHeadcounts(context)),
    exclusions: metricExclusions("opening_fill_status"),
    omissions: [],
  };
}

function computeOfferResolutionMix(context: MetricComputeContext): MetricResult {
  const readiness = metricReadiness("offer_resolution", offerFacts(context));
  if (readiness) return readiness;
  const byStatus = new Map<string, number>();
  let total = 0;
  let accepted = 0;
  let rejected = 0;
  for (const fact of offerFacts(context).flatMap((result) => result.facts)) {
    total += 1;
    const key = fact.status ?? "unknown";
    byStatus.set(key, (byStatus.get(key) ?? 0) + 1);
    // Status vocab is tenant-defined (observed live capitalization: Accepted/Rejected/Created/Deprecated),
    // so classify case-insensitively; anything else is unresolved and excluded from the rate.
    const normalized = key.toLowerCase();
    if (normalized.includes("accept")) accepted += 1;
    else if (normalized.includes("reject") || normalized.includes("declin")) rejected += 1;
  }
  const resolved = accepted + rejected;
  // Live-pilot fix (2026-07-02): "offer acceptance rate" now DERIVES the rate from resolved
  // statuses (accepted / (accepted + rejected)) instead of leaving the arithmetic to the reader;
  // the status mix stays in groups. Falls back to a count when nothing resolved (never a
  // fabricated 0% from unresolved-only offers).
  return {
    metricId: "offer_resolution",
    completeness: "complete",
    value: resolved > 0 ? Number((accepted / resolved).toFixed(4)) : total,
    ...(resolved > 0 ? { numerator: accepted, denominator: resolved } : {}),
    unit: resolved > 0 ? "ratio" : "count",
    groups: [...byStatus.entries()].map(([offer_status, offer_count]) => ({ offer_status, offer_count })),
    evidenceRefs: evidenceRefsForFactResults(offerFacts(context)),
    exclusions: metricExclusions("offer_resolution"),
    omissions: resolved > 0
      ? [`acceptance rate = accepted / (accepted + rejected) over resolved offers only; ${total - resolved} unresolved offer(s) excluded from the rate (statuses in groups).`]
      : ["no resolved (accepted/rejected) offers in scope, so no acceptance rate is derived; value is the offer count."],
  };
}

function computeRubricAnswerCoverage(context: MetricComputeContext): MetricResult {
  const readiness = metricReadiness("rubric_answer_coverage", rubricAnswers(context));
  if (readiness) return readiness;
  const byScorecard = new Map<string, number>();
  let total = 0;
  for (const fact of rubricAnswers(context).flatMap((result) => result.facts)) {
    total += 1;
    const key = String(fact.scorecard_id ?? "unknown");
    byScorecard.set(key, (byScorecard.get(key) ?? 0) + 1);
  }
  return {
    metricId: "rubric_answer_coverage",
    completeness: "complete",
    value: total,
    unit: "count",
    groups: [...byScorecard.entries()].map(([scorecard_id, answer_count]) => ({ scorecard_id, answer_count })),
    evidenceRefs: evidenceRefsForFactResults(rubricAnswers(context)),
    exclusions: metricExclusions("rubric_answer_coverage"),
    omissions: [],
  };
}

function factResults<T>(
  context: MetricComputeContext,
  factName: MetricFactName
): Array<FactBuildResult<T>> {
  const result = context.facts[factName] as FactBuildResult<T> | undefined;
  return result ? [result] : [];
}

function ratioMetric<T>(
  metricId: string,
  factResultsInput: Array<FactBuildResult<T>>,
  predicate: (fact: T) => boolean
): MetricResult {
  const readiness = metricReadiness(metricId, factResultsInput);
  if (readiness) return readiness;
  const facts = factResultsInput.flatMap((result) => result.facts);
  const denominator = facts.length;
  const numerator = facts.filter(predicate).length;
  return {
    metricId,
    completeness: "complete",
    value: denominator > 0 ? numerator / denominator : null,
    numerator,
    denominator,
    unit: "ratio",
    evidenceRefs: evidenceRefsForFactResults(factResultsInput),
    exclusions: metricExclusions(metricId),
    omissions: denominator > 0 ? [] : ["No facts available for denominator."],
  };
}

function averageDurationMetric<T>(
  metricId: string,
  factResultsInput: Array<FactBuildResult<T>>,
  startField: string,
  endField: string
): MetricResult {
  const readiness = metricReadiness(metricId, factResultsInput);
  if (readiness) return readiness;
  const durations = factResultsInput
    .flatMap((result) => result.facts)
    .map((fact) => durationHours(factValue(fact, startField), factValue(fact, endField)))
    .filter((value): value is number => typeof value === "number");
  return averageMetric(metricId, durations, "hours", evidenceRefsForFactResults(factResultsInput));
}

function averageNumberMetric<T>(
  metricId: string,
  factResultsInput: Array<FactBuildResult<T>>,
  field: string,
  unit: "days"
): MetricResult {
  const readiness = metricReadiness(metricId, factResultsInput);
  if (readiness) return readiness;
  const values = factResultsInput
    .flatMap((result) => result.facts)
    .map((fact) => factValue(fact, field))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return averageMetric(metricId, values, unit, evidenceRefsForFactResults(factResultsInput));
}

function averageMetric(metricId: string, values: number[], unit: "hours" | "days", evidenceRefs: string[]): MetricResult {
  const denominator = values.length;
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    metricId,
    completeness: "complete",
    value: denominator > 0 ? total / denominator : null,
    numerator: total,
    denominator,
    unit,
    evidenceRefs,
    exclusions: metricExclusions(metricId),
    omissions: denominator > 0 ? [] : ["No facts with the required fields were available."],
  };
}

function weeklyCountMetric<T>(
  metricId: string,
  factResultsInput: Array<FactBuildResult<T>>,
  dateField: string
): MetricResult {
  const readiness = metricReadiness(metricId, factResultsInput);
  if (readiness) return readiness;
  const groups = new Map<string, number>();
  for (const fact of factResultsInput.flatMap((result) => result.facts)) {
    const week = weekKey(factValue(fact, dateField));
    if (!week) continue;
    groups.set(week, (groups.get(week) ?? 0) + 1);
  }
  const grouped = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([week, count]) => ({ week, count }));
  return {
    metricId,
    completeness: "complete",
    value: grouped.reduce((sum, group) => sum + Number(group.count), 0),
    unit: "count",
    groups: grouped,
    evidenceRefs: evidenceRefsForFactResults(factResultsInput),
    exclusions: metricExclusions(metricId),
    omissions: grouped.length > 0 ? [] : ["No facts with the required date field were available."],
  };
}

function factValue(fact: unknown, field: string): unknown {
  return fact !== null && typeof fact === "object" && !Array.isArray(fact)
    ? (fact as Record<string, unknown>)[field]
    : undefined;
}

function computeScorecardOverdueRate(context: MetricComputeContext): MetricResult {
  const readiness = metricReadiness("scorecard_overdue_rate", scorecards(context));
  if (readiness) return readiness;
  const nowMs = context.nowMs ?? Date.now();
  const overdueMs = (context.overdueDays ?? 2) * 24 * 60 * 60 * 1000;
  const eligible = scorecards(context)
    .flatMap((result) => result.facts)
    .filter((fact) => typeof fact.interviewed_at === "string");
  const overdue = eligible.filter((fact) =>
    !isScorecardSubmitted(fact)
    && typeof fact.interviewed_at === "string"
    && nowMs - Date.parse(fact.interviewed_at) > overdueMs
  );
  return {
    metricId: "scorecard_overdue_rate",
    completeness: "complete",
    value: eligible.length > 0 ? overdue.length / eligible.length : null,
    numerator: overdue.length,
    denominator: eligible.length,
    unit: "ratio",
    evidenceRefs: evidenceRefsForFactResults(scorecards(context)),
    exclusions: metricExclusions("scorecard_overdue_rate"),
    omissions: eligible.length > 0 ? [] : ["No scorecards with interviewed_at were available."],
  };
}

function computeFeedbackSlaBreachRate(context: MetricComputeContext): MetricResult {
  const readiness = metricReadiness("interview_feedback_sla_breach_rate", scorecards(context));
  if (readiness) return readiness;
  const slaHours = context.slaHours ?? 48;
  const durations = scorecards(context)
    .flatMap((result) => result.facts)
    .map((fact) => durationHours(fact.interviewed_at, fact.submitted_at))
    .filter((value): value is number => typeof value === "number");
  const breaches = durations.filter((duration) => duration > slaHours);
  return {
    metricId: "interview_feedback_sla_breach_rate",
    completeness: "complete",
    value: durations.length > 0 ? breaches.length / durations.length : null,
    numerator: breaches.length,
    denominator: durations.length,
    unit: "ratio",
    evidenceRefs: evidenceRefsForFactResults(scorecards(context)),
    exclusions: metricExclusions("interview_feedback_sla_breach_rate"),
    omissions: durations.length > 0 ? [] : ["No scorecards with interviewed_at and submitted_at were available."],
  };
}

function computeSourceQualityByOutcome(context: MetricComputeContext): MetricResult {
  const readiness = metricReadiness("source_quality_by_outcome", applications(context));
  if (readiness) return readiness;
  const groups = new Map<number, { source_id: number; applications: number; positive_outcomes: number }>();
  for (const fact of applications(context).flatMap((result) => result.facts)) {
    if (typeof fact.source_id !== "number") continue;
    const group = groups.get(fact.source_id) ?? { source_id: fact.source_id, applications: 0, positive_outcomes: 0 };
    group.applications += 1;
    // Positive outcome = a realized hire only. "active"/"in_process" are in-flight (no outcome
    // yet), "offer" normalizes to "unknown" upstream, and "converted" is a prospect->candidate
    // conversion, not a win; counting any of them overstates quality (ledger #31).
    if (normalized(fact.status) === "hired") group.positive_outcomes += 1;
    groups.set(fact.source_id, group);
  }
  const grouped = [...groups.values()].map((group) => ({
    ...group,
    quality_rate: group.applications > 0 ? group.positive_outcomes / group.applications : null,
  }));
  return {
    metricId: "source_quality_by_outcome",
    completeness: "complete",
    value: grouped.length,
    unit: "count",
    groups: grouped,
    evidenceRefs: evidenceRefsForFactResults(applications(context)),
    exclusions: metricExclusions("source_quality_by_outcome"),
    omissions: grouped.length > 0 ? [] : ["No application facts with source_id were available."],
  };
}

function computeJobPostExposureByPost(context: MetricComputeContext): MetricResult {
  const readiness = metricReadiness("job_post_exposure_by_post", jobPostExposures(context));
  if (readiness) return readiness;
  const groups = new Map<string, number>();
  for (const fact of jobPostExposures(context).flatMap((result) => result.facts)) {
    const key = String(fact.related_post_id ?? fact.job_post_id ?? "unknown");
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return {
    metricId: "job_post_exposure_by_post",
    completeness: "complete",
    value: [...groups.values()].reduce((sum, value) => sum + value, 0),
    unit: "count",
    // tracking_link_count, NOT applicant count: this groups tracking-link (share-URL) rows per post.
    // The field is named explicitly so a future planner wiring cannot present it as applicants-per-post.
    groups: [...groups.entries()].map(([post_id, tracking_link_count]) => ({ post_id, tracking_link_count })),
    evidenceRefs: evidenceRefsForFactResults(jobPostExposures(context)),
    exclusions: metricExclusions("job_post_exposure_by_post"),
    // Label the approximation (don't fabricate): this is a structural exposure proxy. The direct
    // "which post generates the most PIPELINE" answer is latent in application_lifecycle_fact.job_post_id
    // (group applications by job_post_id) and belongs to the job-post planner domain (Slice PLANNER).
    omissions: [
      "is_proxy: tracking-link count per post is a structural exposure proxy, not applicants-per-post; group application_lifecycle_fact by job_post_id for the pipeline answer (Slice PLANNER).",
    ],
  };
}

function metricReadiness<T>(
  metricId: string,
  factResultsInput: Array<FactBuildResult<T>>
): MetricResult | null {
  if (factResultsInput.length === 0) {
    return missingMetric(metricId);
  }
  const incomplete = factResultsInput.find((result) => result.completeness !== "complete");
  if (!incomplete) return null;
  return {
    metricId,
    completeness: incomplete.completeness,
    value: null,
    evidenceRefs: evidenceRefsForFactResults(factResultsInput),
    exclusions: metricExclusions(metricId),
    omissions: incomplete.omissions,
  };
}

function missingMetric(
  metricId: string,
  context?: MetricComputeContext,
  factName?: MetricFactName
): MetricResult {
  void context;
  return {
    metricId,
    completeness: "failed_missing_fact",
    value: null,
    evidenceRefs: [],
    exclusions: metricExclusions(metricId),
    omissions: [factName ? `Required fact is unavailable: ${factName}` : "Required fact is unavailable."],
  };
}

const EVIDENCE_REF_FIELDS: Array<[field: string, type: string]> = [
  ["scorecard_id", "scorecard"],
  ["interview_id", "interview"],
  ["application_stage_id", "application_stage"],
  ["tracking_link_id", "tracking_link"],
  ["note_id", "note"],
  ["opening_id", "opening"],
  ["offer_id", "offer"],
  ["application_id", "application"],
  ["job_id", "job"],
  ["job_post_id", "job_post"],
  ["related_post_id", "related_post"],
  ["candidate_id", "candidate"],
  ["source_id", "source"],
  ["referrer_id", "referrer"],
];

function evidenceRefsForFactResults<T>(
  factResultsInput: Array<FactBuildResult<T>>,
  // Rank 36: matches DEFAULT_LIMITS.maxEvidenceIds — the old 50 silently capped a metric's backing refs.
  maxRefs = 200
): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const fact of factResultsInput.flatMap((result) => result.facts)) {
    for (const [field, type] of EVIDENCE_REF_FIELDS) {
      const value = factValue(fact, field);
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) continue;
      const ref = `${type}:${value}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      refs.push(ref);
      if (refs.length >= maxRefs) return refs;
    }
  }
  return refs;
}

function metricExclusions(metricId: string): string[] {
  return METRIC_REGISTRY_BY_ID.get(metricId)?.exclusions ?? [];
}

function durationHours(start: unknown, end: unknown): number | null {
  if (typeof start !== "string" || typeof end !== "string") return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return (endMs - startMs) / (60 * 60 * 1000);
}

// The Monday (UTC) of the ISO week containing `value`, as YYYY-MM-DD. Exported so the temporal-view
// helper buckets weeks identically to weekly_application_volume (the buckets must align).
export function weekKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  const day = date.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + mondayOffset);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString().slice(0, 10);
}

function normalized(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

// A scorecard counts as submitted when it carries a submitted_at timestamp OR its status is
// in the submitted set. The v3 contract enum is ["draft","complete"] (complete == submitted,
// submitted_at set); "submitted"/"completed" are tolerated for forward/legacy compatibility.
// Mirrors the recipe predicate in tools/scorecard-accountability.ts so the metric and the
// recipe headline agree on the same rows.
function isScorecardSubmitted(fact: ScorecardFact): boolean {
  if (typeof fact.submitted_at === "string" && fact.submitted_at.length > 0) return true;
  return ["submitted", "complete", "completed"].includes(normalized(fact.status));
}

// A metric that is registered but deliberately not yet computable. Reports failed_missing_fact
// (never a confident 0) so callers degrade honestly instead of surfacing a structural zero.
function notImplementedMetric(metricId: string, reason: string): MetricResult {
  return {
    metricId,
    completeness: "failed_missing_fact",
    value: null,
    evidenceRefs: [],
    exclusions: metricExclusions(metricId),
    omissions: [reason],
  };
}
