import type {
  ApplicationLifecycleFact,
  ApplicationStageTransitionFact,
  ApprovalFlowFact,
  FactBuildResult,
  FactCompletenessStatus,
  HireFact,
  InterviewEventFact,
  JobPostExposureFact,
  NoteActivityFact,
  OfferFact,
  OpeningHeadcountFact,
  ProspectStateFact,
  ScorecardFact,
  ScorecardQuestionAnswerFact,
} from "./facts.js";
import { classifyOfferStatus, type OfferStatusClass } from "./facts.js";
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
  | "scorecard_question_answer_fact"
  // H0: the hire, as an accepted offer with a hire date. Distinct from offer_fact on purpose —
  // offer_fact is every offer row's status mix, hire_fact is the hire denominator every People Ops
  // recipe is built on.
  | "hire_fact";

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
  /**
   * What the READ behind an offer metric actually did. A status mix cannot state its own
   * denominator honestly without it: `total` after `current_only=true` is a count of offer CHAINS,
   * the rows before that filter are EXTENSIONS, and an offer still `Created` has no `resolved_at`
   * so a resolved_at window drops it — three facts that live in the reader, not in the facts.
   */
  offerRead?: {
    /** Rows the upstream returned for this read, before any in-memory filtering. */
    rawRowsRead?: number;
    /** Rows left after `current_only=true` collapsed each application's version chain. */
    rowsAfterCurrentOnly?: number;
    /** Of the gap between those two, how many Greenhouse's private-candidate permission withheld. */
    privacyWithheld?: number;
    /** Of that gap, how many the actor's job permissions excluded (privacy included). */
    permissionExcluded?: number;
    /** Offers excluded by the window for having no resolved_at while still being unresolved. */
    offersOutstanding?: number;
    /**
     * Every offer the window could NOT place, counted by its verbatim status.
     *
     * The window runs on `resolved_at`, so a row without one is removed before the metric sees it.
     * Removing it silently made the mix contradict itself: the outstanding count re-entered
     * `groups` while `total` had never counted it, so three grouped offers sat under an omission
     * that said zero were unresolved, and an unrecognized status with no timestamp skipped its own
     * disclosure. These rows are counted in `total` and in `groups`, classified by the SAME
     * classifier as the rest of the mix, and never folded into the rate: a row the window cannot
     * place cannot be claimed as accepted or rejected inside it.
     */
    statusesWithoutWindowField?: Record<string, number>;
    /** Whether the full version chain was read. False means re-extension counts are not claimed. */
    supersededVersionsRead?: boolean;
  };
}

export type MetricComputeFn = (context: MetricComputeContext) => MetricResult;

export interface MetricDefinition {
  id: string;
  displayName: string;
  requiredFacts: MetricFactName[];
  /**
   * The SOURCE-ROW field names this metric cannot be answered without, as the endpoint emits them.
   *
   * Row names, never FACT names. The projection manifest compares the keys the upstream row carried
   * against the keys the projection kept (evidence-projection.ts), so a metric that named its fact
   * field — `scorecard_id`, which buildScorecardFacts derives from the row's `id` — declared a
   * blocker that could never fire on a real row. That is the silent-miss twin of the false blockers
   * `requiredFieldEndpoints` removed, and metrics.test.ts now checks every entry against the
   * vendored Harvest contract's documented response fields for the declared endpoint.
   */
  requiredFields: string[];
  requiredRoleProfile: RecruiterProjectionProfileName;
  /**
   * The FACT field a time window is applied on for this metric, when it has one. Serialized into
   * the capability output so a caller can see which clock a windowed number ran on rather than
   * inferring it — the offer domain has three plausible ones (`sent_on`, `resolved_at`,
   * `created_at`) and they answer different questions.
   */
  windowField?: string;
  /**
   * The endpoint(s) this metric's `requiredFields` are actually read FROM. MANDATORY.
   *
   * Optional was the defect, not the caution. "Undeclared means any endpoint" is exactly the
   * behaviour that made a /v3/prospect_pools projection dropping `status` announce that the hire
   * count, the scorecard submission rate, the opening fill status, the source-quality breakdown
   * and the weekly pipeline movement were all blocked — five metrics, four of which never touch
   * that endpoint. Leaving the field optional kept that fallback alive for sixteen metrics whose
   * endpoint was never in doubt: each one's single fact builder declares its own
   * `requiredEndpoints` to buildFacts (facts.ts), and that IS the endpoint its rows come from.
   *
   * Required here means the compiler asks the question for every metric added from now on, rather
   * than a new metric silently inheriting the noisiest possible answer.
   */
  requiredFieldEndpoints: string[];
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
    // Row names: /v3/scorecards emits `id`, and buildScorecardFacts derives `scorecard_id` from it.
    requiredFields: ["id", "status", "submitted_at"],
    // /v3/scorecards: the endpoint this metric's fact builder reads (facts.ts).
    requiredFieldEndpoints: ["/v3/scorecards"],
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
    requiredFields: ["id", "interviewed_at", "submitted_at"],
    // /v3/scorecards: the endpoint this metric's fact builder reads (facts.ts).
    requiredFieldEndpoints: ["/v3/scorecards"],
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
    // /v3/scorecards: the endpoint this metric's fact builder reads (facts.ts).
    requiredFieldEndpoints: ["/v3/scorecards"],
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
    // /v3/interviews: the endpoint this metric's fact builder reads (facts.ts).
    requiredFieldEndpoints: ["/v3/interviews"],
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
    // /v3/scorecards: the endpoint this metric's fact builder reads (facts.ts).
    requiredFieldEndpoints: ["/v3/scorecards"],
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
    // /v3/application_stages emits `id`; `application_stage_id` is the fact name, not the row's.
    requiredFields: ["id", "exited_at"],
    // /v3/application_stages: the endpoint this metric's fact builder reads (facts.ts).
    requiredFieldEndpoints: ["/v3/application_stages"],
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
    // /v3/application_stages: the endpoint this metric's fact builder reads (facts.ts).
    requiredFieldEndpoints: ["/v3/application_stages"],
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
    // /v3/applications: the endpoint this metric's fact builder reads (facts.ts).
    requiredFieldEndpoints: ["/v3/applications"],
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
    // /v3/applications: the endpoint this metric's fact builder reads (facts.ts).
    requiredFieldEndpoints: ["/v3/applications"],
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
    // /v3/applications: the endpoint this metric's fact builder reads (facts.ts).
    requiredFieldEndpoints: ["/v3/applications"],
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
    // /v3/tracking_links emits `id`; `tracking_link_id` is the fact name, not the row's.
    requiredFields: ["id", "related_post_id"],
    // /v3/tracking_links: the endpoint this metric's fact builder reads (facts.ts).
    requiredFieldEndpoints: ["/v3/tracking_links"],
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
    // /v3/approval_flows: the endpoint this metric's fact builder reads (facts.ts).
    requiredFieldEndpoints: ["/v3/approval_flows"],
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
    // /v3/prospect_details: the endpoint this metric's fact builder reads (facts.ts).
    requiredFieldEndpoints: ["/v3/prospect_details"],
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
    // /v3/notes: the endpoint this metric's fact builder reads (facts.ts).
    requiredFieldEndpoints: ["/v3/notes"],
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
    // /v3/openings documents no `status` at all, and computeOpeningFillStatus never reads one: it
    // decides on `open` and `closed_at`, which are the fields a projection could really drop.
    requiredFields: ["open", "closed_at"],
    // /v3/openings: the endpoint this metric's fact builder reads (facts.ts).
    requiredFieldEndpoints: ["/v3/openings"],
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
    // The offer row's own status. A projection that drops `status` from any OTHER endpoint tells us
    // nothing about this metric.
    requiredFieldEndpoints: ["/v3/offers"],
    requiredRoleProfile: "recruiter_default",
    // The clock this metric's window actually moves on — the same one the planner applies
    // (question-answer.ts, `factWindowField`). Declared here so a caller reading the capability
    // output can see it rather than inferring which of the offer row's three dates was used.
    windowField: "resolved_at",
    defaultTimeWindow: "last_90_days",
    scopeBehavior: "job_set",
    exclusions: ["groups offers by their v3 status verbatim; no acceptance-rate is derived unless resolved statuses are present"],
    completenessRules: ["offer_fact must be complete"],
    compute: computeOfferResolutionMix,
  },
  {
    id: "hire_count",
    displayName: "Hires (accepted offers)",
    requiredFacts: ["hire_fact"],
    // DECISION (fold item 10): hire_count KEEPS "status" in requiredFields.
    //
    // The reviewer's correction is right on the mechanism and wrong on the conclusion. The earlier
    // claim here — "naming it adds no new key to that map, so nothing changes" — was true about
    // the KEY SET and false about the OUTPUT: buildProjectionMetadata (evidence-projection.ts)
    // pushes one requiredFieldOmission PER METRIC ID per omitted field, so a projection that drops
    // `status` now emits a `hire_count` blocks_answer entry beside the five that were already
    // there. metrics.test.ts locks the actual projection output now, not just the key set.
    //
    // Keeping it is still correct, because the alternative is worse in the one direction that
    // matters. `status` is not merely derivable from the fact builder's filter — the filter IS a
    // read of that field (buildHireFacts, classifyOfferStatus(row.status) !== "accepted"). Drop
    // `status` from a projection and every offer row classifies as not-a-hire, so hire_count
    // returns a confident, complete ZERO. Naming the field is what turns that silent zero into an
    // incomplete_projection the answer discloses. The cost of keeping it is one extra disclosure
    // line on projections that were ALREADY marked incompleteProjection for the same field and the
    // same reason; the cost of dropping it is a fabricated hire count, which is the one line this
    // build does not cross.
    //
    // The hire DATE stays absent: a hire missing resolved_at is dated from sent_on and labeled
    // (buildHireFacts), never fail-closed.
    requiredFields: ["status"],
    requiredFieldEndpoints: ["/v3/offers"],
    requiredRoleProfile: "recruiter_default",
    windowField: "resolved_at",
    defaultTimeWindow: "last_90_days",
    scopeBehavior: "job_set",
    exclusions: [
      "a hire is an accepted offer; Harvest v3 carries no hire timestamp on the application row, and applications.status=hired depends on someone calling the hire endpoint",
      "offers whose status is not exactly Accepted are excluded",
      "hires dated from sent_on rather than resolved_at are counted and labeled dated_from: \"sent_on\"",
      "private candidates the actor's Greenhouse permissions withhold are absent from the count; the read reports how many",
    ],
    completenessRules: ["hire_fact must be complete"],
    compute: computeHireCount,
  },
  {
    id: "rubric_answer_coverage",
    displayName: "Rubric answer coverage",
    requiredFacts: ["scorecard_question_answer_fact"],
    requiredFields: ["scorecard_id"],
    // /v3/scorecard_question_answers: the endpoint this metric's fact builder reads (facts.ts).
    requiredFieldEndpoints: ["/v3/scorecard_question_answers"],
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

function hireFacts(context: MetricComputeContext): Array<FactBuildResult<HireFact>> {
  return factResults(context, "hire_fact");
}

/**
 * How many hires, and on which clock each one was dated.
 *
 * The fact builder's own omissions are carried onto the metric because they are the only place the
 * answer learns that N of these hires were dated from `sent_on` rather than `resolved_at`, or that
 * M accepted offers carry no date at all. metricReadiness surfaces a fact result's omissions only
 * when the result is INCOMPLETE, and a labeled approximation is not incompleteness — so without
 * this the label would exist on the row and never reach the reader.
 */
function computeHireCount(context: MetricComputeContext): MetricResult {
  const readiness = metricReadiness("hire_count", hireFacts(context));
  if (readiness) return readiness;
  const results = hireFacts(context);
  const facts = results.flatMap((result) => result.facts);
  const byClock = new Map<string, number>();
  for (const fact of facts) {
    byClock.set(fact.dated_from, (byClock.get(fact.dated_from) ?? 0) + 1);
  }
  return {
    metricId: "hire_count",
    completeness: "complete",
    value: facts.length,
    unit: "count",
    groups: [...byClock.entries()].map(([dated_from, hire_count]) => ({ dated_from, hire_count })),
    evidenceRefs: evidenceRefsForFactResults(results),
    exclusions: metricExclusions("hire_count"),
    omissions: results.flatMap((result) => result.omissions),
  };
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

/**
 * The group an offer the window could not place is counted under, by what its status MEANS.
 *
 * Not by its verbatim value: `outstanding_no_resolved_at` is the group every consumer already
 * reads, and splitting it per tenant status string would break that while saying nothing extra —
 * the verbatim values are named in the omissions instead.
 */
type OfferStatusClassGroup =
  | "outstanding_no_resolved_at"
  | "superseded_no_resolved_at"
  | "unrecognized_status_no_resolved_at"
  | "resolved_status_no_resolved_at";

const UNDATED_GROUP_BY_CLASS: Record<OfferStatusClass, OfferStatusClassGroup> = {
  outstanding: "outstanding_no_resolved_at",
  superseded: "superseded_no_resolved_at",
  unknown: "unrecognized_status_no_resolved_at",
  // An offer that says it was accepted or rejected but carries no resolved_at is a real data gap,
  // not a normal state. It is counted and named apart from the offers that are simply still out.
  accepted: "resolved_status_no_resolved_at",
  rejected: "resolved_status_no_resolved_at",
};

function computeOfferResolutionMix(context: MetricComputeContext): MetricResult {
  const readiness = metricReadiness("offer_resolution", offerFacts(context));
  if (readiness) return readiness;
  const byStatus = new Map<string, number>();
  let total = 0;
  let accepted = 0;
  let rejected = 0;
  const unrecognized = new Map<string, number>();
  for (const fact of offerFacts(context).flatMap((result) => result.facts)) {
    total += 1;
    const key = fact.status ?? "unknown";
    byStatus.set(key, (byStatus.get(key) ?? 0) + 1);
    // ONE classifier for the whole answer (facts.ts). The mix used to read a status
    // case-insensitively while the hire count beside it matched `Accepted` exactly, so the two
    // numbers in the same paragraph could disagree about which offers were accepted.
    const offerClass = classifyOfferStatus(key);
    if (offerClass === "accepted") accepted += 1;
    else if (offerClass === "rejected") rejected += 1;
    else if (offerClass === "unknown") unrecognized.set(key, (unrecognized.get(key) ?? 0) + 1);
  }
  // The offers the window could not place, classified BEFORE it removed them. Each one joins
  // `total` and a group of its own class, and none of them joins the rate: a row with no
  // resolved_at cannot be claimed as accepted or rejected INSIDE a resolved_at window.
  const undated = context.offerRead?.statusesWithoutWindowField;
  const undatedByClass = new Map<OfferStatusClassGroup, number>();
  if (undated) {
    for (const [status, count] of Object.entries(undated)) {
      total += count;
      const offerClass = classifyOfferStatus(status);
      undatedByClass.set(UNDATED_GROUP_BY_CLASS[offerClass], (undatedByClass.get(UNDATED_GROUP_BY_CLASS[offerClass]) ?? 0) + count);
      // An unrecognized status is unrecognized whether or not it carried a date. Skipping the
      // disclosure for the undated ones is how a renamed tenant status moves a rate unremarked.
      if (offerClass === "unknown") unrecognized.set(status, (unrecognized.get(status) ?? 0) + count);
    }
  }
  const resolved = accepted + rejected;
  // The offers that were sent and have not come back. Windowing on `resolved_at` — the clock every
  // published hire report uses — structurally excludes them, because an unresolved offer has no
  // resolved_at to place. Before this they simply vanished, and the "N unresolved excluded"
  // disclosure below was a guaranteed 0 sitting under an answer that had silently dropped them.
  // They are counted, grouped and named instead. The reader's own tally is the fallback for a
  // caller that hands over `offersOutstanding` without the fuller class breakdown.
  const outstanding = undated
    ? undatedByClass.get("outstanding_no_resolved_at") ?? 0
    : context.offerRead?.offersOutstanding ?? 0;
  if (!undated && outstanding > 0) {
    total += outstanding;
    undatedByClass.set("outstanding_no_resolved_at", outstanding);
  }
  const groups: Array<Record<string, string | number | null>> = [
    ...[...byStatus.entries()].map(([offer_status, offer_count]) => ({ offer_status, offer_count })),
    ...[...undatedByClass.entries()]
      .filter(([, offer_count]) => offer_count > 0)
      .map(([offer_status, offer_count]) => ({ offer_status, offer_count })),
  ];
  const readOmissions: string[] = [];
  if (unrecognized.size > 0) {
    // Named, not bucketed. These rows are in the mix's `total` and in `groups` under their own
    // verbatim status, and they are deliberately outside the rate: calling an unrecognized value
    // accepted, rejected or still-open would move a published number on a guess.
    readOmissions.push(
      `${[...unrecognized.values()].reduce((sum, count) => sum + count, 0)} offer(s) carry a status outside the published /v3/offers enum (Created, Accepted, Rejected, Deprecated) and are counted in the mix but excluded from the rate: ${[...unrecognized.entries()].map(([value, count]) => `${value} (${count})`).join(", ")}.`
    );
  }
  if (outstanding > 0) {
    readOmissions.push(
      `offers_outstanding: ${outstanding} offer(s) in scope are still open (no resolved_at yet), so the resolved_at window cannot place them and they are outside the rate. They are counted here rather than dropped.`
    );
  }
  const supersededUndated = undatedByClass.get("superseded_no_resolved_at") ?? 0;
  if (supersededUndated > 0) {
    readOmissions.push(
      `${supersededUndated} superseded offer version(s) carry no resolved_at; they are counted in the mix and are outside the rate, because a superseded version is a previous draft rather than an outcome.`
    );
  }
  const resolvedUndated = undatedByClass.get("resolved_status_no_resolved_at") ?? 0;
  if (resolvedUndated > 0) {
    readOmissions.push(
      `${resolvedUndated} offer(s) say they were accepted or rejected but carry no resolved_at, so no window can place them. They are counted in the mix and left out of the rate rather than dated by guesswork.`
    );
  }
  const rawRowsRead = context.offerRead?.rawRowsRead;
  const rowsAfterCurrentOnly = context.offerRead?.rowsAfterCurrentOnly;
  if (typeof rawRowsRead === "number" && typeof rowsAfterCurrentOnly === "number") {
    // What this sentence used to say — "N rows returned and M survived current_only" — was simply
    // false. `current_only=true` is applied SERVER-SIDE, so every row the read returned had already
    // survived it; nothing was filtered here. The gap between the two numbers is the PERMISSION
    // gate, and it is attributed to the permission gate.
    const withheld = context.offerRead?.privacyWithheld ?? 0;
    const excluded = context.offerRead?.permissionExcluded ?? 0;
    const gap = Math.max(0, rawRowsRead - rowsAfterCurrentOnly);
    const attribution = gap === 0
      ? ""
      : ` ${gap} row(s) the upstream matched are absent from it — ` +
        (withheld > 0 ? `${withheld} withheld as private candidates you cannot see` : "") +
        (withheld > 0 && excluded - withheld > 0 ? ", " : "") +
        (excluded - withheld > 0 ? `${excluded - withheld} outside your job permissions` : "") +
        (withheld === 0 && excluded === 0 ? "the read did not say which permission" : "") +
        ".";
    readOmissions.push(
      `denominator counts offer CHAINS, not offer rows: current_only=true was applied server-side, so the ${rowsAfterCurrentOnly} row(s) in this mix are already one current offer per application.${attribution}`
    );
  }
  if (context.offerRead?.supersededVersionsRead !== true) {
    readOmissions.push(
      "superseded versions were not read, so offer rows per hire (the re-extension denominator) is not reported."
    );
  }
  // "offer acceptance rate" derives the rate from resolved
  // statuses (accepted / (accepted + rejected)) instead of leaving the arithmetic to the reader;
  // the status mix stays in groups. Falls back to a count when nothing resolved (never a
  // fabricated 0% from unresolved-only offers).
  return {
    metricId: "offer_resolution",
    completeness: "complete",
    value: resolved > 0 ? Number((accepted / resolved).toFixed(4)) : total,
    ...(resolved > 0 ? { numerator: accepted, denominator: resolved } : {}),
    unit: resolved > 0 ? "ratio" : "count",
    groups,
    evidenceRefs: evidenceRefsForFactResults(offerFacts(context)),
    exclusions: metricExclusions("offer_resolution"),
    omissions: [
      ...(resolved > 0
        ? [`acceptance rate = accepted / (accepted + rejected) over resolved offers only; ${total - resolved} unresolved offer(s) excluded from the rate (statuses in groups).`]
        : ["no resolved (accepted/rejected) offers in scope, so no acceptance rate is derived; value is the offer count."]),
      ...readOmissions,
    ],
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
