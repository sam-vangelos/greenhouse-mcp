import {
  explicitAnalysisWindowError,
  HARD_MAX_ANALYSIS_DURATION_MS,
  HARD_MAX_TOOL_DURATION_MS,
  HIRE_FACTS_ID_BRIDGE_READ_PARAM_NAMES,
  HIRE_FACTS_OFFER_READ_PARAM_NAMES,
  isToolEnabled,
  readPositiveInt,
  sanitizeReadParams,
} from "../limits.js";
import { createToolDeadline, deny, emitRequiredToolAudit, enforceUsageBudget, isToolCancelledError, isToolTimeoutError, type RecruiterToolRuntime, type ToolDeadline } from "../runtime.js";
import { IdentityResolutionError } from "../identity.js";
import { newCorrelationId } from "../audit.js";
import type { RecruiterDenialCode, RecruiterPermissionScope, RecruiterToolDefinition, RecruiterToolResult } from "../types.js";
import { INTERVIEW_FEEDBACK_DRAG_TOOL, runInterviewFeedbackDrag } from "./interview-feedback-drag.js";
import { PIPELINE_QUALITY_TOOL, runPipelineQuality } from "./pipeline-quality.js";
import { SCORECARD_ACCOUNTABILITY_TOOL, runScorecardAccountability } from "./scorecard-accountability.js";
import { SOURCE_QUALITY_TOOL, runSourceQuality } from "./source-quality.js";
import { REJECTION_REASON_DRIFT_TOOL, runRejectionReasonDrift } from "./rejection-reason-drift.js";
import { STAGE_LATENCY_TOOL, runStageLatency } from "./stage-latency.js";
import { buildPermissionScopeHeader, resolveAnalysisContext } from "../resolution/analysis-context.js";
import type { AnalysisContextHeader } from "../resolution/types.js";
import { loadJobInventory, type JobInventory } from "../resolvers/job-scope/inventory.js";
import { getRecruitingCapabilities } from "../resolvers/job-scope/capabilities.js";
import { resolveJobScope, type ConfirmationReasonCode, type ResolveJobScopeInput, type ResolveJobScopeOutput } from "../resolvers/job-scope/resolver.js";
import { resolveScopeSigner } from "../resolvers/job-scope/signer.js";
import { resolveOwnerScope } from "./job-scope/tools.js";
import { METRIC_REGISTRY_BY_ID, computeMetric, type MetricComputeContext, type MetricFactName } from "../metrics.js";
import {
  classifyOfferStatus,
  buildApprovalFlowFacts,
  buildInterviewEventFacts,
  buildJobPostExposureFacts,
  buildOfferFacts,
  buildOpeningHeadcountFacts,
  buildProspectStateFacts,
  type FactBuildResult,
} from "../facts.js";
import { classifyUpstreamError, combineReadStatuses, isCancellationDenial, type ReadAllStatus } from "../read-all.js";
import { readIdChunks, uniquePositiveIds } from "./hire-facts.js";
import { readAllWithDateFallback } from "./read-with-date-fallback.js";
import type { RecruiterProjectionProfileName } from "../types.js";

export const QUESTION_ANSWER_TOOL: RecruiterToolDefinition = {
  name: "answer_my_recruiting_question",
  kind: "analysis",
  description:
    'THE FRONT DOOR for aggregate analytical questions — metrics, rates, counts, time trends, aggregate comparisons, and time-boxed questions. Ask in plain English ("What\'s our offer acceptance rate last quarter?", "Where are candidates stuck in my reqs?", "How have rejection reasons drifted?"). ONE call resolves the scope (including "my reqs"), reads the complete scoped data, applies the time window server-side (this/last quarter, this year, last N days/weeks/months), and computes the answer with honest disclosures. Prefer this whenever the question wants a NUMBER or aggregate ANALYSIS. For individual resume, scorecard, note, or candidate-history comparisons, use the corresponding scoped evidence/read tools instead. A question outside the covered domains still gets an answer: the broad diagnostic panel runs and the result is LABELLED an approximation (mode approximate_composite, domain_recognized false) naming both what ran and the analyses to rephrase toward.',
};

type RecipeId =
  | "scorecard_accountability"
  | "interview_feedback_drag"
  | "stage_latency"
  | "pipeline_quality"
  | "source_quality"
  | "rejection_reason_drift";

interface RecipeDefinition {
  id: RecipeId;
  toolName: string;
  reason: string;
  keywords: RegExp;
  requiredMetrics: string[];
  requiredFacts: MetricFactName[];
  requiredEndpoints: string[];
  requiredProjectionProfile: RecruiterProjectionProfileName;
  run(runtime: RecruiterToolRuntime, params: Record<string, unknown>): Promise<RecruiterToolResult>;
  params(params: Record<string, unknown>): Record<string, unknown>;
}

interface AnalysisPlan {
  interpretedQuestion: string;
  requestedScope: Record<string, unknown>;
  requiredMetrics: string[];
  requiredFacts: MetricFactName[];
  requiredEndpoints: string[];
  requiredProjectionProfile: RecruiterProjectionProfileName;
  needsUserConfirmation: boolean;
  confirmationReason?: string;
  stopReason?: string;
  missingFacts?: MetricFactName[];
  missingEndpoints?: string[];
}

const RECIPES: RecipeDefinition[] = [
  {
    id: "scorecard_accountability",
    toolName: SCORECARD_ACCOUNTABILITY_TOOL.name,
    reason: "Question references scorecards, submission accountability, repeat offenders, or culpability.",
    keywords: /\b(scorecard|scorecards|unsubmitted|submitted|submitter|perpetrator|culpab|offender|accountab|repeat offender)\b/i,
    requiredMetrics: ["scorecard_submission_rate", "scorecard_overdue_rate"],
    requiredFacts: ["scorecard_fact"],
    requiredEndpoints: ["/v3/scorecards", "/v3/applications"],
    requiredProjectionProfile: "recruiter_default",
    run: runScorecardAccountability,
    params: (params) => pickParams(params, ["window_start", "window_end", "job_ids", "max_rankings", "per_page", "evidence_pack", "evidence_pack_limit"]),
  },
  {
    id: "interview_feedback_drag",
    toolName: INTERVIEW_FEEDBACK_DRAG_TOOL.name,
    reason: "Question references interview feedback delay, late feedback, missing scorecards, or overdue interviewer behavior.",
    keywords: /\b(feedback|interview|late|overdue|missing scorecard|delay|delayed|sla)\b/i,
    requiredMetrics: ["interview_feedback_sla_breach_rate", "scheduled_interview_to_feedback_hours", "scorecard_submission_rate"],
    requiredFacts: ["scorecard_fact"],
    requiredEndpoints: ["/v3/scorecards", "/v3/applications"],
    requiredProjectionProfile: "recruiter_default",
    run: runInterviewFeedbackDrag,
    params: (params) => pickParams(params, ["window_start", "window_end", "job_ids", "due_days", "max_rankings", "per_page", "evidence_pack", "evidence_pack_limit"]),
  },
  {
    id: "stage_latency",
    toolName: STAGE_LATENCY_TOOL.name,
    reason: "Question references stage bottlenecks, stuck candidates, aging applications, dwell time, or slow movement.",
    keywords: /\b(stage|stages|stuck|aging|aged|latency|bottleneck|bottlenecks|dwell|slow|slower|slowness|stall|stalls|stalling|stalled|stale)\b/i,
    requiredMetrics: ["stage_dwell_days", "stage_conversion_rate"],
    requiredFacts: ["application_stage_transition_fact"],
    requiredEndpoints: ["/v3/applications", "/v3/application_stages"],
    requiredProjectionProfile: "recruiter_default",
    run: runStageLatency,
    params: (params) => pickParams(params, ["window_start", "window_end", "job_ids", "status", "min_age_days", "max_rankings", "per_page", "include_terminal", "evidence_pack", "evidence_pack_limit"]),
  },
  {
    id: "pipeline_quality",
    toolName: PIPELINE_QUALITY_TOOL.name,
    reason: "Question references overall pipeline health, status mix, conversion, rejection, fallout, or stale active pipeline.",
    keywords: /\b(pipeline|quality|health|conversion|converted|hired|rejected|rejection|fallout|status mix|stale active|terminal|weekly|volume|movement|throughput)\b/i,
    requiredMetrics: ["weekly_application_volume", "weekly_qualified_pipeline_movement", "source_quality_by_outcome"],
    requiredFacts: ["application_lifecycle_fact"],
    requiredEndpoints: ["/v3/applications"],
    requiredProjectionProfile: "recruiter_default",
    run: runPipelineQuality,
    params: (params) => pickParams(params, ["window_start", "window_end", "job_ids", "status", "stale_days", "max_rankings", "per_page", "evidence_pack", "evidence_pack_limit"]),
  },
  {
    id: "source_quality",
    toolName: SOURCE_QUALITY_TOOL.name,
    reason: "Question references source, referrer, referral, agency, channel, or yield quality.",
    keywords: /\b(source|sources|sourcing|referrer|referrers|referral|referrals|agency|agencies|channel|channels|yield|source quality|attribution)\b/i,
    requiredMetrics: ["source_quality_by_outcome", "weekly_application_volume"],
    requiredFacts: ["application_lifecycle_fact"],
    requiredEndpoints: ["/v3/applications"],
    requiredProjectionProfile: "recruiter_default",
    run: runSourceQuality,
    params: (params) => pickParams(params, ["window_start", "window_end", "job_ids", "source_ids", "referrer_ids", "status", "stale_days", "max_rankings", "per_page", "evidence_pack", "evidence_pack_limit"]),
  },
  {
    id: "rejection_reason_drift",
    toolName: REJECTION_REASON_DRIFT_TOOL.name,
    reason: "Question references rejection reasons, reason concentration, or reason drift (which reasons are overused) — not the overall rejection RATE.",
    keywords: /\b(rejection reason|rejection reasons|reject reason|reject reasons|reason for rejection|reasons for rejection|rejection reason drift|overusing)\b/i,
    requiredMetrics: [],
    requiredFacts: [],
    requiredEndpoints: ["/v3/rejection_details", "/v3/rejection_reasons", "/v3/applications"],
    requiredProjectionProfile: "recruiter_default",
    run: runRejectionReasonDrift,
    params: (params) => pickParams(params, ["window_start", "window_end", "job_ids", "max_rankings", "per_page", "evidence_pack", "evidence_pack_limit"]),
  },
];

// The default ceiling is the full recipe panel, so a broad diagnostic runs every recipe (an
// explicit max_recipes still overrides). DERIVED, not typed: the hand-written 6 would have
// silently selected a seventh registered recipe out of every broad run.
export const DEFAULT_MAX_RECIPES = RECIPES.length;

// The recipe ids the planner can actually execute (one analyze_* tool each).
// get_recruiting_capabilities must only mark these as availability: "available";
// other catalog recipes are model-composed from scoped reads, not planner-run.
export const PLANNER_RECIPE_IDS: string[] = RECIPES.map((recipe) => recipe.id);

// A broad-diagnostic / "run everything" request must run the FULL planner panel. Kept
// covering every PLANNER_RECIPE_ID (locked in question-answer.test.ts) so promoting a new
// recipe without adding it here — the drift that silently dropped rejection_reason_drift —
// fails the suite instead of quietly shrinking what "give me everything" returns.
export const BROAD_DIAGNOSTIC_RECIPES: RecipeId[] = [
  "pipeline_quality",
  "stage_latency",
  "scorecard_accountability",
  "interview_feedback_drag",
  "source_quality",
  "rejection_reason_drift",
];
const RECIPE_CATALOG = new Map(getRecruitingCapabilities().recipes.map((recipe) => [recipe.id, recipe]));

export async function runRecruitingQuestionAnswer(
  runtime: RecruiterToolRuntime,
  params: Record<string, unknown>
): Promise<RecruiterToolResult> {
  const toolName = QUESTION_ANSWER_TOOL.name;
  const startedAt = runtime.now();
  const correlationId = newCorrelationId(runtime.now);
  const actAsUser = runtime.trustedActAsUser ?? null;
  const plannerDeadline = createToolDeadline(runtime, startedAt);

  if (!isToolEnabled(runtime.toolConfig, runtime.session.surface, toolName, "analysis")) {
    const result = deny(toolName, "TOOL_DISABLED", "Recruiting question planner is disabled for this runtime.");
    const auditDenied = await emitPlannerAudit(runtime, startedAt, correlationId, result, null, null, actAsUser);
    return auditDenied ?? result;
  }

  const rateDenied = await enforceUsageBudget(runtime, toolName, "analysis", runtime.session.surface, startedAt, correlationId, actAsUser);
  if (rateDenied) return rateDenied;

  const question = normalizeQuestion(params.question);
  if (!question) {
    const result = deny(toolName, "INVALID_REQUEST", "answer_my_recruiting_question requires a non-empty question string.");
    const auditDenied = await emitPlannerAudit(runtime, startedAt, correlationId, result, null, null, actAsUser);
    return auditDenied ?? result;
  }

  // Scope resolution, CLO-274. An explicit scope_handle or job_ids still wins. Otherwise the
  // question is probed against the job index: a req or role it NAMES becomes the scope, and a
  // question that names none is answered across everything the actor's Greenhouse permissions
  // return — org-wide for a broad-visibility actor — with that scope stated on the answer. A
  // confirmation-required response is now reserved for genuine ambiguity (several real reqs, a
  // collision alias, a duplicate requisition id).
  let plannerScope: Awaited<ReturnType<typeof resolvePlannerScope>>;
  try {
    plannerScope = await resolvePlannerScope(runtime, question, params, plannerDeadline);
  } catch (error) {
    if (!isToolCancelledError(error)) throw error;
    const result = deny(toolName, "CANCELLED", "Scoped Greenhouse question planner was cancelled because the client request ended.");
    const auditDenied = await emitPlannerAudit(runtime, startedAt, correlationId, result, null, null, actAsUser);
    return auditDenied ?? result;
  }
  if (!plannerScope.ok) {
    const result = deny(toolName, plannerScope.code, plannerScope.message);
    const auditDenied = await emitPlannerAudit(runtime, startedAt, correlationId, result, null, null, actAsUser);
    return auditDenied ?? result;
  }
  if (plannerScope.kind === "resolution_required") {
    const plan = buildConfirmationPlan(question, plannerScope.resolution);
    const result: RecruiterToolResult = {
      ok: true,
      toolName,
      scoped: true,
      data: {
        summary: {
          question,
          planner: "scope resolution required before analysis",
          scope_resolution_required: true,
          resolution_status: plannerScope.resolution.resolution_status,
          confirmation_required: plannerScope.resolution.confirmation.required,
          completeness_status: "incomplete",
          data_domains: plan.requiredEndpoints,
          projection_profile: plan.requiredProjectionProfile,
          plan,
        },
        answer: {
          mode: "resolution_required",
          message: "This question references jobs/roles that must be confirmed before analysis runs.",
          resolution_status: plannerScope.resolution.resolution_status,
          required_metrics: plan.requiredMetrics,
          required_facts: plan.requiredFacts,
          required_endpoints: plan.requiredEndpoints,
        },
        resolution: plannerScope.resolution,
        analyses: [],
        denials: [],
        next_steps: [
          "Confirm the proposed scope with confirm_job_scope using the returned confirmation_token, then re-ask with the scope_handle.",
          "Or pass exact job_ids to run analysis on a known scope.",
        ],
      },
      nextCursor: null,
    };
    const auditDenied = await emitPlannerAudit(runtime, startedAt, correlationId, result, null, null, actAsUser);
    return auditDenied ?? result;
  }
  if (plannerScope.kind === "empty_scope") {
    // An honest zero, not a refusal and not a silently-substituted population. No recipe runs
    // because there is nothing in scope to read.
    const result: RecruiterToolResult = {
      ok: true,
      toolName,
      scoped: true,
      data: {
        summary: {
          question,
          planner: "keyword-routed recipe planner",
          domain_recognized: false,
          selected_recipe_count: 0,
          recipes_run_count: 0,
          selected_recipes: [],
          rows_read: 0,
          rows_considered: 0,
          completeness_status: "complete",
          applied_time_window: resolveQuestionTimeWindow(question, params, runtime.now()),
          scope_boundary: "The scope this question asked for is empty, so no scoped read ran.",
          ...(plannerScope.header ? { scope: plannerScope.header } : {}),
        },
        answer: {
          mode: "empty_scope",
          domain_recognized: false,
          message: plannerScope.message,
        },
        analyses: [],
        denials: [],
        next_steps: [
          "Ask the same question without the scope word to cover every job your Greenhouse permissions return.",
          "Or name a req, role, or requisition id to analyze a specific requisition.",
        ],
      },
      nextCursor: null,
    };
    const auditDenied = await emitPlannerAudit(runtime, startedAt, correlationId, result, 0, 0, actAsUser);
    return auditDenied ?? result;
  }
  const scopeHeader = plannerScope.header;
  params = plannerScope.jobIds !== undefined ? withPlannerJobIds(params, plannerScope.jobIds) : stripScopeHandle(params);

  // The disclosure is computed here so every answer shape below can state it; the FORWARDING
  // into recipe params happens after the planned-domain branch, which does its own windowing.
  const appliedTimeWindow = resolveQuestionTimeWindow(question, params, runtime.now());

  const missingDomain = detectMissingDomain(question);
  if (missingDomain) {
    // The recipes' own validator, on this path too (limits.ts). The planned-domain path read the
    // bounds through key presence and a bare Date.parse, so a blank bound silently became an
    // all-time answer and a start after an end became a complete zero — a different answer to the
    // same request depending on which path the question routed to.
    const windowError = explicitAnalysisWindowError(params);
    if (windowError) {
      const result = deny(toolName, "INVALID_REQUEST", windowError);
      const auditDenied = await emitPlannerAudit(runtime, startedAt, correlationId, result, null, null, actAsUser);
      return auditDenied ?? result;
    }
    // T3.2 (audit C-CORE): detectMissingDomain already maps the question to facts + endpoints +
    // metric — the planner in embryo. When the domain's read/fact/metric bindings exist, EXECUTE
    // the plan (read scoped rows -> build facts -> compute the metric) instead of dead-ending at
    // missing_domain. Domains without an executable binding keep the honest denial below.
    let executed: RecruiterToolResult | null;
    try {
      executed = await executePlannedDomain(
        runtime, question, appliedTimeWindow, missingDomain, scopeHeader, plannerScope.jobIds, plannerDeadline
      );
    } catch (error) {
      // The planned-domain path used to rethrow everything that was not a cancellation, so an
      // upstream 422 on /v3/offers — the endpoint's own documented live behaviour — escaped the
      // planner as an unaudited exception and reached the transport as an opaque 500. Every recipe
      // already maps its errors to a denial and audits it; this path now does the same, so a read
      // failure is a result the caller can read and a record an operator can review.
      const result = plannerErrorToDenial(toolName, error);
      const auditDenied = await emitPlannerAudit(runtime, startedAt, correlationId, result, null, null, actAsUser);
      return auditDenied ?? result;
    }
    if (executed) {
      const auditDenied = await emitPlannerAudit(runtime, startedAt, correlationId, executed, null, null, actAsUser);
      return auditDenied ?? executed;
    }
    // Recognized domain with no executable binding. Reported BEFORE selection so an over-broad
    // recipe keyword cannot grab it. domain_recognized: true — we know the domain, it is simply
    // not implemented.
    const plan = buildMissingDomainPlan(question, scopeHeader, missingDomain);
    const result: RecruiterToolResult = {
      ok: true,
      toolName,
      actorId: undefined,
      effectiveActorId: undefined,
      scoped: true,
      data: {
        summary: {
          question,
          planner: "keyword-routed recipe planner",
          domain_recognized: true,
          selected_recipe_count: 0,
          recipes_run_count: 0,
          selected_recipes: [],
          rows_read: null,
          rows_considered: null,
          completeness_status: missingDomain.completenessStatus,
          data_domains: plan.requiredEndpoints,
          projection_profile: plan.requiredProjectionProfile,
          applied_time_window: appliedTimeWindow,
          scope_boundary: "No recipe reads ran because the planner identified a recognized but unimplemented fact/domain.",
          plan,
          ...(scopeHeader ? { scope: scopeHeader } : {}),
        },
        answer: {
          mode: "missing_domain",
          domain_recognized: true,
          message: composeAnswerMessage({ scopeHeader, appliedTimeWindow, lead: missingDomain.message }),
          required_metrics: plan.requiredMetrics,
          missing_facts: plan.missingFacts,
          missing_endpoints: plan.missingEndpoints,
          completeness_status: missingDomain.completenessStatus,
        },
        analyses: [],
        denials: [],
        next_steps: [
          "Do not infer this answer from neighboring recipe outputs.",
          "Implement the missing semantic fact source, then rerun the question through the planner.",
        ],
      },
      nextCursor: null,
    };
    const auditDenied = await emitPlannerAudit(runtime, startedAt, correlationId, result, null, null, actAsUser);
    return auditDenied ?? result;
  }

  // P3-router: the question's own time window reaches the recipes. "this month" was parsed for
  // the planned-domain path only, so a RECIPE question carrying the same phrase silently answered
  // over the recipe's default lookback — an all-time-ish number under a month-shaped question. A
  // phrase the recruiter said out loud is a stated intent and runs exactly like an explicit
  // window, uncapped: maxLookbackDays exists only to bound the FUZZY default (limits.ts:475-480),
  // is applied in memory after a full read, and so guards no API cost.
  if (appliedTimeWindow?.origin === "question") {
    params = {
      ...params,
      window_start: appliedTimeWindow.window_start,
      window_end: appliedTimeWindow.window_end,
    };
  }

  const matchedRecipes = selectRecipes(question, params);
  // CLO-275: no recognized domain and no keyword match used to be a dead end — "no approved recipe
  // matches this question", nothing read, nothing learned. The broad panel already exists and is
  // the same permission-bounded set of analyses; running it and LABELLING the result an
  // approximation answers something instead of nothing. The honesty that mattered in the old
  // refusal is kept, and made louder: mode says approximate_composite, domain_recognized stays
  // false, and the message names both what ran and the recipes to rephrase toward.
  const approximateComposite = matchedRecipes.length === 0;
  // The ceiling applies here too. The composite bypassed selectRecipes entirely, so an explicit
  // max_recipes — the one control a caller has over how much the panel reads — was honored for
  // every routed question and silently ignored on the one path that runs everything.
  const selected = approximateComposite ? broadDiagnosticPanel(params) : matchedRecipes;
  const plan = approximateComposite
    ? { ...buildAnalysisPlan(question, selected, scopeHeader), stopReason: "approximate_composite:unrecognized_question" }
    : buildAnalysisPlan(question, selected, scopeHeader);
  const analyses: Array<Record<string, unknown>> = [];
  const denials: Array<Record<string, unknown>> = [];
  let rowsRead = 0;
  let rowsReturned = 0;
  let sawRowsRead = false;
  let sawRowsReturned = false;
  let actorId: number | undefined;
  let effectiveActorId: number | undefined;
  let scoped = true;
  let permissionScope: RecruiterPermissionScope | undefined;
  let plannerTimedOut = false;
  let recipesRunCount = 0;

  for (const recipe of selected) {
    const remainingMs = remainingPlannerTimeoutMs(plannerDeadline);
    if (remainingMs !== undefined && remainingMs <= 0) {
      plannerTimedOut = true;
      denials.push({
        recipe: recipe.id,
        toolName: recipe.toolName,
        denial: {
          code: "TOOL_TIMEOUT",
          message: "Scoped Greenhouse question planner timed out before running all selected analyses.",
        },
      });
      analyses.push({
        recipe: recipe.id,
        toolName: recipe.toolName,
        reason: recipe.reason,
        status: "denied",
        denial: {
          code: "TOOL_TIMEOUT",
          message: "Scoped Greenhouse question planner timed out before running all selected analyses.",
        },
      });
      break;
    }
    const recipeParams = recipe.params(params);
    recipesRunCount += 1;
    const result = await recipe.run(runtimeWithRemainingPlannerBudget(runtime, remainingMs), recipeParams);
    actorId ??= result.actorId;
    effectiveActorId ??= result.effectiveActorId;
    if (result.ok) {
      scoped = scoped && result.scoped;
      permissionScope ??= result.permissionScope;
      const summary = readSummary(result.data);
      const read = readNumber(summary.rows_read);
      const returned = readNumber(summary.rows_considered);
      if (read !== null) {
        rowsRead += read;
        sawRowsRead = true;
      }
      if (returned !== null) {
        rowsReturned += returned;
        sawRowsReturned = true;
      }
      analyses.push({
        recipe: recipe.id,
        toolName: recipe.toolName,
        reason: recipe.reason,
        status: "ok",
        params: summarizeRecipeParams(recipeParams),
        data: result.data,
      });
    } else {
      if (result.denial.code === "AUDIT_UNAVAILABLE") {
        return result;
      }
      if (result.denial.code === "CANCELLED") {
        const cancelled = deny(toolName, "CANCELLED", result.denial.message, result.actorId, result.effectiveActorId);
        const auditDenied = await emitPlannerAudit(runtime, startedAt, correlationId, cancelled, sawRowsRead ? rowsRead : null, sawRowsReturned ? rowsReturned : null, actAsUser);
        return auditDenied ?? cancelled;
      }
      if (result.denial.code === "TOOL_TIMEOUT") {
        plannerTimedOut = true;
      }
      denials.push({
        recipe: recipe.id,
        toolName: recipe.toolName,
        denial: result.denial,
      });
      analyses.push({
        recipe: recipe.id,
        toolName: recipe.toolName,
        reason: recipe.reason,
        status: "denied",
        denial: result.denial,
      });
      if (result.denial.code === "TOOL_TIMEOUT") {
        break;
      }
    }
  }

  // A composite is an approximation by construction, so "every recipe denied" is a RESULT to
  // report (which analyses were unavailable, and why), not a reason to hand back a bare denial
  // for a question the planner chose to approximate. A matched-recipe run still collapses: there
  // the caller asked for that specific analysis and it did not happen.
  if (!approximateComposite && analyses.length === denials.length) {
    const first = denials[0];
    const denial = isRecord(first?.denial) && typeof first.denial.code === "string"
      ? first.denial
      : { code: "UPSTREAM_ERROR", message: "No approved scoped analysis recipe returned data for this question." };
    const result = deny(toolName, denial.code as RecruiterDenialCode, String(denial.message ?? "No approved scoped analysis recipe returned data."), actorId, effectiveActorId);
    const auditDenied = await emitPlannerAudit(runtime, startedAt, correlationId, result, sawRowsRead ? rowsRead : null, sawRowsReturned ? rowsReturned : null, actAsUser);
    return auditDenied ?? result;
  }

  // Roll child completeness up to the headline so a multi-recipe answer whose children ran but
  // TRUNCATED/partial-excluded is not reported as a plain "see_analyses" success. Without this, the
  // incompleteness is only discoverable by drilling into each analyses[i].data.completeness.
  const childCompletenessStatuses = analyses
    .filter((entry) => entry.status === "ok")
    .map((entry) => {
      const data = entry.data;
      if (!isRecord(data) || !isRecord(data.completeness)) return undefined;
      const status = data.completeness.status;
      return typeof status === "string" ? status : undefined;
    });
  const anyChildIncomplete = childCompletenessStatuses.some((status) => status === "incomplete");
  const anyChildPartial = childCompletenessStatuses.some((status) => status === "partial");
  // A denied child is missing evidence, so the headline says incomplete rather than presenting a
  // partial panel as a clean success.
  const headlineCompleteness = plannerTimedOut || anyChildIncomplete || denials.length > 0
    ? "incomplete"
    : anyChildPartial
      ? "partial"
      : "see_analyses";

  const result: RecruiterToolResult = {
    ok: true,
    toolName,
    actorId,
    effectiveActorId,
    scoped,
    permissionScope,
    data: {
      summary: {
        question,
        planner: approximateComposite ? "keyword-routed recipe planner (broad-panel approximation)" : "keyword-routed recipe planner",
        domain_recognized: !approximateComposite,
        selected_recipe_count: selected.length,
        recipes_run_count: recipesRunCount,
        planner_timed_out: plannerTimedOut,
        selected_recipes: selected.map((recipe) => recipe.id),
        rows_read: sawRowsRead ? rowsRead : null,
        rows_considered: sawRowsReturned ? rowsReturned : null,
        completeness_status: headlineCompleteness,
        data_domains: plan.requiredEndpoints,
        projection_profile: plan.requiredProjectionProfile,
        applied_time_window: appliedTimeWindow,
        plan,
        scope_boundary: "All recipe reads run through the recruiter scopedRead surface; no raw Greenhouse client access or model-supplied actor ids are used.",
        ...(scopeHeader ? { scope: scopeHeader } : {}),
      },
      answer: buildAnswer(selected, analyses, denials, {
        mode: approximateComposite
          ? "approximate_composite"
          : selected.length > 1
            ? "composite_analysis"
            : "single_recipe_analysis",
        domainRecognized: !approximateComposite,
        // Every recipe answer carries the message now, not only the composite: the scope it ran
        // over and the recipes that did/did not run are the same disclosures either way.
        message: approximateComposite
          ? composeCompositeMessage(scopeHeader, appliedTimeWindow, selected, analyses, denials)
          : composeAnswerMessage({
              scopeHeader,
              appliedTimeWindow,
              clause: `ran ${panelClause(selected, analyses, denials)}`,
            }),
      }),
      analyses,
      denials,
      next_steps: approximateComposite
        ? [
            // Iterated, never hand-typed: a newly registered recipe is named here the day it lands.
            ...PLANNER_RECIPE_IDS.map((id) => `Ask this directly as the ${id} analysis for a precise answer.`),
            "Or name a req, role, or requisition id to scope the same panel to one requisition.",
          ]
        : [
            "Use the returned recipe outputs to pick one drilldown path, then use a visible get_my_* tool for a specific scoped id when available.",
            "Rerun this planner with job_ids or narrower windows when you want a req-specific answer.",
            "Ask for one of the selected recipes directly when you need maximum detail from a single analysis.",
          ],
    },
    nextCursor: null,
  };
  const auditDenied = await emitPlannerAudit(runtime, startedAt, correlationId, result, sawRowsRead ? rowsRead : null, sawRowsReturned ? rowsReturned : null, actAsUser);
  return auditDenied ?? result;
}

function remainingPlannerTimeoutMs(deadline: ToolDeadline | undefined): number | undefined {
  if (!deadline) return undefined;
  return deadline.timeoutMs - Math.max(0, deadline.now() - deadline.startedAt);
}

export function runtimeWithRemainingPlannerBudget(runtime: RecruiterToolRuntime, remainingMs: number | undefined): RecruiterToolRuntime {
  // The planner resolves and DISCLOSES scope (resolvePlannerScope) before any recipe runs, so
  // recipes must not re-run the no-scope inventory probe. Every recipe therefore arrives either
  // with explicit job_ids the planner validated, or deliberately unscoped for an actor whose own
  // Greenhouse permissions are the boundary — a scope the planner has already named in the header
  // it attaches to the answer.
  const base: RecruiterToolRuntime = { ...runtime, scopeContextResolved: true };
  if (remainingMs === undefined) return base;
  const wholeRemainingMs = Math.max(1, Math.floor(remainingMs));
  const configuredReadMs = Number.isFinite(base.limits.maxToolDurationMs) && base.limits.maxToolDurationMs > 0
    ? base.limits.maxToolDurationMs
    : HARD_MAX_TOOL_DURATION_MS;
  const configuredAnalysisMs = Number.isFinite(base.limits.maxAnalysisDurationMs) && (base.limits.maxAnalysisDurationMs ?? 0) > 0
    ? base.limits.maxAnalysisDurationMs as number
    : HARD_MAX_ANALYSIS_DURATION_MS;
  return {
    ...base,
    limits: {
      ...base.limits,
      maxToolDurationMs: Math.min(configuredReadMs, HARD_MAX_TOOL_DURATION_MS, wholeRemainingMs),
      maxAnalysisDurationMs: Math.min(configuredAnalysisMs, HARD_MAX_ANALYSIS_DURATION_MS, wholeRemainingMs),
    },
  };
}

function selectRecipes(question: string, params: Record<string, unknown>): RecipeDefinition[] {
  const explicit = parseExplicitRecipes(params.recipes ?? params.recipe);
  // Rejection-REASON questions route ONLY to rejection_reason_drift, never also to pipeline_quality's
  // bare "rejection" keyword (which answers overall rate/fallout — a different question). This replaces
  // the former missing_domain guard now that a real executor exists.
  if (explicit.length === 0 && /\b(rejection reasons?|reject reasons?|reasons? for rejection|reason drift)\b/i.test(question)) {
    const drift = RECIPES.find((recipe) => recipe.id === "rejection_reason_drift");
    if (drift) return [drift];
  }
  const requested = explicit.length > 0
    ? explicit
    : RECIPES.filter((recipe) => recipe.keywords.test(question)).map((recipe) => recipe.id);
  // Selection stays strict: only a keyword match or an explicit broad-diagnostic request selects
  // recipes here, so a specific question never picks up a neighbouring recipe by accident. An
  // EMPTY selection is a real answer from this function — the caller (CLO-275) runs the broad panel
  // and labels the result an approximation rather than dead-ending, which is a decision about how
  // to answer, not about which recipe the question matched.
  const recipeIds = requested.length > 0
    ? requested
    : (isBroadDiagnosticIntent(question, params) ? BROAD_DIAGNOSTIC_RECIPES : []);
  // Rank 52: let an explicit max_recipes run free; DEFAULT_MAX_RECIPES is only the default ceiling.
  const maxRecipes = readPositiveInt(params.max_recipes) ?? DEFAULT_MAX_RECIPES;
  const seen = new Set<RecipeId>();
  const selected: RecipeDefinition[] = [];
  for (const id of recipeIds) {
    if (seen.has(id)) continue;
    const recipe = RECIPES.find((entry) => entry.id === id);
    if (!recipe) continue;
    seen.add(id);
    selected.push(recipe);
    if (selected.length >= maxRecipes) break;
  }
  return selected;
}

type MissingDomain = {
  requiredMetrics: string[];
  requiredFacts: MetricFactName[];
  requiredEndpoints: string[];
  requiredProjectionProfile: RecruiterProjectionProfileName;
  completenessStatus: "failed_missing_fact" | "incomplete";
  message: string;
  stopReason: string;
};

function detectMissingDomain(question: string): MissingDomain | null {
  const normalized = ` ${question.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()} `;
  if (/\b(approval|approvals|approver|approval flow|approval flows|approval latency)\b/.test(normalized)) {
    return {
      requiredMetrics: ["approval_latency"],
      requiredFacts: ["approval_flow_fact"],
      requiredEndpoints: ["/v3/approval_flows"],
      requiredProjectionProfile: "recruiting_manager",
      completenessStatus: "failed_missing_fact",
      message: "Approval latency requires approval_flow_fact, which is registered but not implemented yet.",
      stopReason: "missing_fact:approval_flow_fact",
    };
  }
  if (/\b(prospect|prospects|prospect pool|pool movement|talent pool)\b/.test(normalized)) {
    return {
      requiredMetrics: ["prospect_pool_movement"],
      requiredFacts: ["prospect_state_fact"],
      requiredEndpoints: ["/v3/prospect_details", "/v3/prospect_pool_stages", "/v3/prospect_pools"],
      requiredProjectionProfile: "recruiting_manager",
      completenessStatus: "failed_missing_fact",
      message: "Prospect pool movement requires prospect_state_fact, which is registered but not implemented yet.",
      stopReason: "missing_fact:prospect_state_fact",
    };
  }
  if (/\b(scheduling|scheduled|schedule|availability|coordinator)\b/.test(normalized) && /\b(interview|interviews)\b/.test(normalized)) {
    return {
      requiredMetrics: ["availability_to_scheduled_interview_hours"],
      requiredFacts: ["interview_event_fact"],
      requiredEndpoints: ["/v3/interviews"],
      requiredProjectionProfile: "recruiter_default",
      completenessStatus: "incomplete",
      message: "Interview scheduling friction maps to interview_event_fact, but no executable planner recipe reads that fact source yet.",
      stopReason: "missing_execution:interview_event_fact",
    };
  }
  if (/\b(job post|job posts|job posting|job postings|tracking link|tracking links|post exposure|posting exposure|exposure by post)\b/.test(normalized)) {
    return {
      requiredMetrics: ["job_post_exposure_by_post"],
      requiredFacts: ["job_post_exposure_fact"],
      requiredEndpoints: ["/v3/tracking_links"],
      requiredProjectionProfile: "recruiter_default",
      completenessStatus: "incomplete",
      message: "Job-post exposure maps to job_post_exposure_by_post, a registered metric with no executable planner recipe wired to it yet.",
      stopReason: "missing_execution:job_post_exposure_by_post",
    };
  }
  // Openings/headcount, offers, and rejection-REASON breakdown are recognized domains with no metric
  // or fact builder wired into the planner (the fact builders are test-only; there is no offer or
  // opening metric in the MetricFactName union). They are caught HERE, before keyword selection, so a
  // confident WRONG recipe cannot grab them: without these guards "opening aging" matched
  // stage_latency's `aging` keyword and "rejection reasons" matched pipeline_quality's `rejection`,
  // each returning a confident answer to a different question. A clean missing_domain is strictly
  // better than a wrong answer. requiredFacts is empty because the fact type does not exist in the
  // union yet — naming a fabricated MetricFactName would be the very anti-pattern this guards against.
  // The rejection-reason regex requires the word "reason" so it never swallows a legitimate rejection
  // RATE / fallout question, which still routes to pipeline_quality.
  if (/\b(opening|openings|headcount|head count|target start|opening aging|aging openings)\b/.test(normalized)) {
    return {
      requiredMetrics: ["opening_fill_status"],
      requiredFacts: ["opening_headcount_fact"],
      requiredEndpoints: ["/v3/openings"],
      requiredProjectionProfile: "recruiter_default",
      completenessStatus: "incomplete",
      message: "Opening/headcount questions execute via the fact-backed planner (opening_fill_status over opening_headcount_fact) — not stage latency.",
      stopReason: "planned:opening_fill_status",
    };
  }
  if (/\b(offer|offers|offer acceptance|offer accept|offer decline|accepted offer|declined offer|offer letter|offer rate)\b/.test(normalized)) {
    return {
      requiredMetrics: ["offer_resolution"],
      requiredFacts: ["offer_fact"],
      requiredEndpoints: ["/v3/offers"],
      requiredProjectionProfile: "recruiter_default",
      completenessStatus: "incomplete",
      message: "Offer questions execute via the fact-backed planner (offer_resolution over offer_fact).",
      stopReason: "planned:offer_resolution",
    };
  }
  // Rejection-REASON breakdown (reason concentration/drift) is a REAL recipe now
  // (analyze_rejection_reason_drift); selectRecipes routes it explicitly so pipeline_quality's bare
  // "rejection" keyword can't grab it. It is intentionally NOT guarded here.
  return null;
}

// T3.2: the fact-backed domain executor. One binding per recognized off-recipe domain, keyed by
// the domain's single metric id: which scoped list tool to read, which fact builder to run, and
// whether the fact carries job_id (so a resolved narrow scope can be applied in-memory honestly).
interface PlannedDomainBinding {
  scopedToolName: string;
  factName: MetricFactName;
  buildFactsFromRows: (rows: unknown) => FactBuildResult<unknown>;
  factJobIdField: string | null;
  // The fact's event timestamp for NL time windows ("this quarter"); null = point-in-time domain
  // where a window doesn't apply (disclosed rather than silently ignored).
  factWindowField: string | null;
  /**
   * SERVER-SIDE filters for this domain's read. The read used to be a hard-coded `{}` for every
   * domain, so /v3/offers returned every superseded version and the planner's own total counted
   * them. Deliberately NOT a date filter: the LIVE offers endpoint 422s every date range the
   * vendored contract advertises, so the window stays in memory (plannedDomainBounds) and the read
   * goes through readAllWithDateFallback either way.
   */
  readParams?: Record<string, unknown>;
  /** The allowlist `readParams` is sanitized against; sanitizeReadParams drops unknowns silently. */
  readParamNames?: ReadonlySet<string>;
  /**
   * A fact the window dropped for want of `factWindowField` that is OUTSTANDING rather than
   * undated — an offer still `Created` has no `resolved_at` because it has not resolved yet. Facts
   * matching this are counted and handed to the metric instead of vanishing into a
   * missing-timestamp tally the answer never shows.
   */
  outstandingWithoutWindowField?: (fact: Record<string, unknown>) => boolean;
  /**
   * The fact field whose VERBATIM value classifies a row the window could not place.
   *
   * A row with no window timestamp still HAS a class, and dropping it before the metric ever saw
   * it is what made the offer mix contradict itself: the outstanding count came back into `groups`
   * while the metric's `total` had never counted it, so a group of three sat under an omission
   * that said zero were unresolved — and an unrecognized status with no timestamp skipped its own
   * disclosure entirely. Classifying happens BEFORE removal, and the counts travel to the metric.
   */
  undatedClassField?: string;
  /**
   * Open the answer with the hire reconciliation line's two cheap counts. Offers only: the accepted
   * count and the "how many of those applications does Greenhouse actually call hired" count come
   * from the read already in hand plus ONE bridged applications read. The third count (openings
   * closed by a hire) is a whole further population and is offered as a follow-up step instead.
   */
  reconcileHires?: boolean;
}

const PLANNED_DOMAIN_BINDINGS: ReadonlyMap<string, PlannedDomainBinding> = new Map([
  ["approval_latency", { scopedToolName: "list_approval_flows", factName: "approval_flow_fact", buildFactsFromRows: (rows) => buildApprovalFlowFacts(rows), factJobIdField: "job_id", factWindowField: "created_at" }],
  ["prospect_pool_movement", { scopedToolName: "list_prospect_details", factName: "prospect_state_fact", buildFactsFromRows: (rows) => buildProspectStateFacts(rows), factJobIdField: null, factWindowField: null }],
  ["availability_to_scheduled_interview_hours", { scopedToolName: "list_interviews", factName: "interview_event_fact", buildFactsFromRows: (rows) => buildInterviewEventFacts(rows), factJobIdField: "job_id", factWindowField: "scheduled_at" }],
  ["job_post_exposure_by_post", { scopedToolName: "list_tracking_links", factName: "job_post_exposure_fact", buildFactsFromRows: (rows) => buildJobPostExposureFacts(rows), factJobIdField: "job_id", factWindowField: null }],
  ["opening_fill_status", { scopedToolName: "list_openings", factName: "opening_headcount_fact", buildFactsFromRows: (rows) => buildOpeningHeadcountFacts(rows), factJobIdField: "job_id", factWindowField: null }],
  ["offer_resolution", {
    scopedToolName: "list_offers",
    factName: "offer_fact",
    buildFactsFromRows: (rows) => buildOfferFacts(rows),
    factJobIdField: "job_id",
    // `resolved_at`, not `sent_on`: an offer question is asked about when the offer was DECIDED,
    // and resolved_at is the clock standard hire reporting uses.
    // `sent_on` answered "when did we extend it", a different question, silently.
    factWindowField: "resolved_at",
    // `status` is deliberately NOT set: the whole point of this metric is the status MIX, so
    // filtering it server-side would leave the rate with nothing to divide by. `current_only`
    // collapses each application's version chain to its current row, which is what keeps
    // `Deprecated` superseded versions out of the total.
    readParams: { current_only: true },
    readParamNames: HIRE_FACTS_OFFER_READ_PARAM_NAMES,
    outstandingWithoutWindowField: isOutstandingOffer,
    undatedClassField: "status",
    reconcileHires: true,
  }],
]);

// Deterministic NL time windows (so a phrase like "this quarter" is never silently ignored while an
// all-time number answers a quarter question). Calendar-anchored in UTC; explicit
// window_start/window_end params always win over the parsed phrase.
//
// A CLOSED period ends at its final instant, not at the first instant of the next one. Every
// consumer filters inclusively (`at <= endMs`; source-quality.ts:330 and the planned-domain filter
// below), and a date-only stamp ("sent_on": "2026-06-01") parses to exactly midnight — so an
// endMs of "the 1st at 00:00" put every first-of-the-period, date-only event in the WRONG period.
export function parseQuestionTimeWindow(
  question: string,
  nowMs: number
): { startMs: number; endMs: number; label: string } | null {
  const normalized = question.toLowerCase();
  const now = new Date(nowMs);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const quarterStartMonth = Math.floor(month / 3) * 3;
  if (/\bthis quarter\b/.test(normalized)) {
    return { startMs: Date.UTC(year, quarterStartMonth, 1), endMs: nowMs, label: "this quarter" };
  }
  if (/\blast quarter\b/.test(normalized)) {
    return { startMs: Date.UTC(year, quarterStartMonth - 3, 1), endMs: Date.UTC(year, quarterStartMonth, 1) - 1, label: "last quarter" };
  }
  if (/\bthis month\b/.test(normalized)) {
    return { startMs: Date.UTC(year, month, 1), endMs: nowMs, label: "this month" };
  }
  if (/\blast month\b/.test(normalized)) {
    return { startMs: Date.UTC(year, month - 1, 1), endMs: Date.UTC(year, month, 1) - 1, label: "last month" };
  }
  if (/\bthis year\b/.test(normalized)) {
    return { startMs: Date.UTC(year, 0, 1), endMs: nowMs, label: "this year" };
  }
  const lastN = /\b(?:last|past)\s+(\d{1,3})\s+(day|week|month)s?\b/.exec(normalized);
  if (lastN) {
    const count = Number.parseInt(lastN[1] as string, 10);
    const unitMs = lastN[2] === "day" ? 86_400_000 : lastN[2] === "week" ? 7 * 86_400_000 : 30 * 86_400_000;
    return { startMs: nowMs - count * unitMs, endMs: nowMs, label: `last ${count} ${lastN[2]}s` };
  }
  return null;
}

export interface AppliedTimeWindow {
  label: string | null;
  window_start: string | null;
  window_end: string | null;
  origin: "question" | "explicit";
}

/**
 * What time window this answer actually ran over, and where it came from. Either explicit bound is
 * a deliberate instruction, so its PRESENCE blocks parsing entirely — reading the sentence on top
 * of it would silently overwrite half of what the caller asked for. A one-sided explicit window is
 * reported as exactly that; no second bound is invented, because each recipe's own summary already
 * states the interval it resolved.
 *
 * Presence is KEY presence, not string-ness. Testing `typeof === "string"` meant a non-string
 * window_start (a number, a Date) read as absent, so the phrase in the sentence was parsed and
 * WROTE OVER the caller's own param — the bad value never reached the recipe's validator and the
 * answer silently covered a different interval. A present-but-unusable bound is left exactly as
 * the caller passed it (limits.ts readAnalysisWindowDate rejects it, loudly) and disclosed as null,
 * because there is no ISO instant to state.
 */
export function resolveQuestionTimeWindow(
  question: string,
  params: Record<string, unknown>,
  nowMs: number
): AppliedTimeWindow | null {
  const startPresent = params.window_start !== undefined && params.window_start !== null;
  const endPresent = params.window_end !== undefined && params.window_end !== null;
  if (startPresent || endPresent) {
    return {
      label: null,
      window_start: typeof params.window_start === "string" ? params.window_start : null,
      window_end: typeof params.window_end === "string" ? params.window_end : null,
      origin: "explicit",
    };
  }
  const parsed = parseQuestionTimeWindow(question, nowMs);
  if (!parsed) return null;
  return {
    label: parsed.label,
    window_start: new Date(parsed.startMs).toISOString(),
    window_end: new Date(parsed.endMs).toISOString(),
    origin: "question",
  };
}

async function executePlannedDomain(
  runtime: RecruiterToolRuntime,
  question: string,
  appliedTimeWindow: AppliedTimeWindow | null,
  missingDomain: MissingDomain,
  scopeHeader: AnalysisContextHeader | null,
  resolvedJobIds: string | undefined,
  deadline: ToolDeadline | undefined
): Promise<RecruiterToolResult | null> {
  const metricId = missingDomain.requiredMetrics[0];
  const binding = metricId ? PLANNED_DOMAIN_BINDINGS.get(metricId) : undefined;
  if (!binding || !metricId) return null;

  // The domain's own server-side filters, sanitized against the binding's allowlist so an unlisted
  // param is a compile-time-visible mistake rather than a silent drop. Routed through the shared
  // 422 fallback: the read carries no date params today, but the helper is the one place that
  // knows what to do when a live endpoint rejects a filter its contract advertises.
  const readParams = binding.readParams
    ? sanitizeReadParams(binding.readParams, runtime.limits, { allowedParamNames: binding.readParamNames })
    : {};
  const outcome = await readAllWithDateFallback<Record<string, unknown>>(
    runtime,
    QUESTION_ANSWER_TOOL.name,
    binding.scopedToolName,
    readParams,
    [],
    deadline
  );
  const read = outcome.read;
  if (read.kind === "denial") {
    // Surface the real denial (audited by the caller) rather than falling back to missing_domain —
    // "the read failed" and "the domain is unimplemented" are different truths.
    return read.result;
  }

  // Apply a resolved narrow scope in-memory when the fact carries job_id; otherwise disclose that
  // the domain read spans all permitted jobs (never silently pretend it was narrowed).
  const scopeIds = resolvedJobIds
    ? new Set(resolvedJobIds.split(",").map((token) => Number.parseInt(token.trim(), 10)).filter((value) => Number.isFinite(value) && value > 0))
    : null;
  const factResult = binding.buildFactsFromRows(read.rows);
  const omissions: string[] = [];
  let offersOutstanding = 0;
  let scopedFactResult = factResult;
  if (scopeIds && scopeIds.size > 0) {
    if (binding.factJobIdField) {
      const facts = (factResult.facts as Array<Record<string, unknown>>).filter((fact) => {
        const jobId = fact[binding.factJobIdField as string];
        return typeof jobId === "number" && scopeIds.has(jobId);
      });
      scopedFactResult = { ...factResult, facts } as FactBuildResult<unknown>;
    } else {
      omissions.push(
        `Resolved scope was NOT applied to this domain read (${binding.scopedToolName} facts carry no job_id); the metric spans all your permitted jobs.`
      );
    }
  }

  // Apply the question's time window ("this quarter") so an all-time number never
  // silently answers a quarter-scoped question. The window is the SAME AppliedTimeWindow the
  // recipe path discloses, computed once by resolveQuestionTimeWindow from key presence. This path
  // used to recompute it and require BOTH explicit bounds, so `window_start` alone plus "this
  // month" in the sentence silently became June and dropped the May rows the caller asked for.
  // A one-sided bound is honored as one-sided: the missing side is simply unbounded.
  const bounds = plannedDomainBounds(appliedTimeWindow);
  const undatedByClass: Record<string, number> = {};
  if (bounds) {
    if (binding.factWindowField) {
      let missingTimestamp = 0;
      const facts = (scopedFactResult.facts as Array<Record<string, unknown>>).filter((fact) => {
        const raw = fact[binding.factWindowField as string];
        const at = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
        if (!Number.isFinite(at)) {
          missingTimestamp += 1;
          // A row with no window timestamp is not always a data gap: on offers it is usually an
          // offer that has not resolved YET. The binding says which, and the count reaches the
          // metric so it can be surfaced instead of disappearing into missingTimestamp.
          if (binding.outstandingWithoutWindowField?.(fact)) offersOutstanding += 1;
          // Classified HERE, before the row is removed, and by its own verbatim value: the metric
          // is the only place that knows what each class does to a total, a group and a rate, and
          // it cannot classify a row it never receives.
          if (binding.undatedClassField) {
            const value = fact[binding.undatedClassField];
            const key = typeof value === "string" && value.trim().length > 0 ? value : "unknown";
            undatedByClass[key] = (undatedByClass[key] ?? 0) + 1;
          }
          return false;
        }
        return at >= bounds.startMs && at <= bounds.endMs;
      });
      scopedFactResult = { ...scopedFactResult, facts } as FactBuildResult<unknown>;
      omissions.push(
        `Time window applied (${bounds.label}): ${bounds.startLabel} to ${bounds.endLabel} on ${binding.factWindowField}` +
          (missingTimestamp === 0
            ? "."
            : binding.undatedClassField
              ? `; ${missingTimestamp} row(s) carry no ${binding.factWindowField}, so the window cannot place them — they are outside the rate and counted in the mix by their ${binding.undatedClassField}.`
              : `; ${missingTimestamp} row(s) without a ${binding.factWindowField} excluded.`)
      );
    } else {
      omissions.push(
        `A time window ("${bounds.label}") was asked, but this metric is point-in-time (current state) — the window does not apply.`
      );
    }
  } else if (binding.factWindowField) {
    omissions.push("No time window applied — the result spans all time. Ask with a window (e.g. \"this quarter\") or pass window_start/window_end to narrow.");
  }

  const metric = computeMetric(metricId, {
    facts: { [binding.factName]: scopedFactResult } as MetricComputeContext["facts"],
    nowMs: runtime.now(),
    ...(binding.outstandingWithoutWindowField || binding.readParams?.current_only === true
      ? {
          offerRead: {
            rawRowsRead: read.rawRowsRead,
            // The read already asked the API for current versions only, so what came back IS the
            // post-current_only set. Naming both numbers is what lets the answer say whether its
            // denominator counts chains or extensions — and the gap between them belongs to the
            // permission gate, so the gate's own figures travel with them.
            rowsAfterCurrentOnly: read.rows.length,
            privacyWithheld: read.privacyWithheld,
            permissionExcluded: read.permissionExcluded,
            offersOutstanding,
            statusesWithoutWindowField: undatedByClass,
            supersededVersionsRead: false,
          },
        }
      : {}),
  });
  // The two cheap halves of the hire reconciliation line, from the read already in hand plus ONE
  // bridged applications read. They lead the answer because "our offer acceptance rate is X" and
  // "Greenhouse thinks we hired Y people" are the two numbers a People Ops reader will be asked
  // about in the same breath, and in Greenhouse they often disagree.
  let reconciliationLead: string | undefined;
  const nextSteps: string[] = [];
  const answerStatuses: ReadAllStatus[] = [read.status];
  if (binding.reconcileHires) {
    // The SAME classifier the mix and the hire facts use (facts.ts). This lead matched the literal
    // string `Accepted` while the rate under it matched case-insensitively, so on a tenant that
    // writes the status any other way the two numbers in one paragraph counted different offers.
    const accepted = (scopedFactResult.facts as Array<Record<string, unknown>>).filter(
      (fact) => classifyOfferStatus(fact.status) === "accepted"
    );
    // The bridge is contained here, not by the planner's outer catch. An upstream THROW on this
    // optional read escaped executePlannedDomain and became a denial envelope for the whole
    // question — the same destruction as returning the denial, by a different route. A cancellation
    // is the one exception: it means the client is gone and nothing should keep running.
    let bridged: Awaited<ReturnType<typeof readIdChunks>>;
    try {
      bridged = await readIdChunks(
        runtime,
        QUESTION_ANSWER_TOOL.name,
        "list_applications",
        uniquePositiveIds(accepted, "application_id"),
        (batch) => sanitizeReadParams(
          { ids: batch.join(",") },
          runtime.limits,
          { allowedParamNames: HIRE_FACTS_ID_BRIDGE_READ_PARAM_NAMES }
        ),
        deadline
      );
    } catch (error) {
      if (isToolCancelledError(error)) throw error;
      bridged = { kind: "denial", result: plannerErrorToDenial(QUESTION_ANSWER_TOOL.name, error) };
    }
    // A cancellation reaches this path as a DENIAL, not as an exception (read-all.ts maps it), so
    // the rule below — an optional bridge's denial only reduces the lead — quietly answered a
    // client that had already hung up, with ok: true and a complete verdict on it. A cancellation
    // is never a reduced answer; it is the end of the run, and it is returned as such.
    if (bridged.kind === "denial" && isCancellationDenial(bridged.result)) return bridged.result;
    if (bridged.kind === "denial") {
      // The metric is already computed from a read that SUCCEEDED. Returning the bridge's denial
      // here threw that answer away and handed back "we cannot tell you anything" because an
      // OPTIONAL second population — a lead sentence, not the metric — could not be read. The lead
      // reduces to the count that was actually made, and the failure is named.
      reconciliationLead = `${accepted.length} accepted current offers.`;
      // A population this answer ASKED for and did not get. The metric stands, but the envelope
      // must not say the answer is complete: `complete` used to be published from the offer read
      // alone, so a failed bridge left a complete verdict over half a reconciliation.
      answerStatuses.push("incomplete_upstream");
      omissions.push(
        `How many of those applications Greenhouse marks hired could not be read (${bridged.result.ok === false ? bridged.result.denial.code : "UNKNOWN"}), so that half of the reconciliation is not reported. The accepted-offer count and the rate below it stand: they come from a read that completed.`
      );
    } else {
      const markedHired = bridged.rows.filter(
        (row) => typeof row.status === "string" && row.status.trim().toLowerCase() === "hired"
      ).length;
      // A bridge that stopped short (deadline, rate limit) read only SOME of the accepted set's
      // applications, so its count is a floor, not the number. Reporting it as an exact figure
      // beside a complete offer count is how a confident wrong number gets published.
      const bridgeComplete = bridged.read.status === "complete";
      answerStatuses.push(bridged.read.status);
      reconciliationLead = bridgeComplete
        ? `${accepted.length} accepted current offers; ${markedHired} of their applications ` +
          `${markedHired === 1 ? "is" : "are"} marked hired in Greenhouse.`
        : `${accepted.length} accepted current offers; at least ${markedHired} of their applications ` +
          `${markedHired === 1 ? "is" : "are"} marked hired in Greenhouse — the applications read was cut short, so that second number is a floor.`;
      if (!bridgeComplete) {
        omissions.push(
          `The applications bridge behind the second count did not finish (${bridged.read.status}), so it covers only part of the accepted set.`
        );
        omissions.push(...bridged.read.warnings);
      }
      if (bridged.read.privacyWithheld > 0) {
        omissions.push(`${bridged.read.privacyWithheld} of those applications withheld as private candidates you cannot see.`);
      }
    }
    omissions.push(
      "These two counts are dated on different clocks — offers.resolved_at for the first, applications.status (point-in-time) for the second — and Greenhouse sets status=hired only once the hire endpoint has fired, so the second trailing the first is normal rather than an error."
    );
    // Each count carries ITS OWN withheld figure. Summing them would report a number no read made.
    if (read.privacyWithheld > 0) {
      omissions.push(`${read.privacyWithheld} offer row(s) withheld as private candidates you cannot see.`);
    }
    nextSteps.push(
      "Ask for the openings closed by a hire to complete the reconciliation — it is a third population (openings.closed_at plus the close-reason dictionary) and costs two further reads, so it is not run unasked."
    );
  }

  // BOTH reads decide how complete the answer is. Deriving it from the offer read alone reported a
  // complete answer over a lead sentence that had been computed from a truncated bridge.
  const answerStatus = combineReadStatuses(answerStatuses);
  const completeness = answerStatus === "complete" ? metric.completeness : answerStatus;
  const plan: AnalysisPlan = {
    interpretedQuestion: question,
    requestedScope: requestedScope(scopeHeader),
    requiredMetrics: missingDomain.requiredMetrics,
    requiredFacts: missingDomain.requiredFacts,
    requiredEndpoints: missingDomain.requiredEndpoints,
    requiredProjectionProfile: missingDomain.requiredProjectionProfile,
    needsUserConfirmation: false,
  };
  return {
    ok: true,
    toolName: QUESTION_ANSWER_TOOL.name,
    actorId: read.actorId,
    effectiveActorId: read.effectiveActorId,
    scoped: read.scoped ?? true,
    permissionScope: read.permissionScope,
    data: {
      summary: {
        question,
        planner: "fact-backed domain planner",
        domain_recognized: true,
        selected_recipe_count: 0,
        recipes_run_count: 0,
        selected_recipes: [],
        planned_metrics_run: [metricId],
        rows_read: read.rawRowsRead,
        rows_considered: (scopedFactResult.facts as unknown[]).length,
        completeness_status: completeness,
        // Literally the same object the recipe path discloses — one window, computed once, so a
        // phrase keeps its own label ("this month") and an explicit window says "explicit" on
        // both paths. Recomputing it here is what let the two paths disagree.
        applied_time_window: appliedTimeWindow,
        data_domains: missingDomain.requiredEndpoints,
        projection_profile: missingDomain.requiredProjectionProfile,
        scope_boundary: scopeIds && binding.factJobIdField
          ? "Domain read narrowed in-memory to the resolved job scope after the permitted-bounded read."
          : "Domain read spans all your permitted jobs (the scoped reader's permission floor).",
        plan,
        ...(scopeHeader ? { scope: scopeHeader } : {}),
      },
      answer: {
        mode: "planned_metric",
        domain_recognized: true,
        // The same composition contract every other answer shape carries: scope first, then the
        // window. This branch used to carry no message at all, so the one disclosure a recruiter
        // reads first was missing on exactly the path that answers a metric question.
        message: [
          reconciliationLead,
          composeAnswerMessage({ scopeHeader, appliedTimeWindow, clause: `computed ${metricId}` }),
        ].filter((part): part is string => Boolean(part)).join(" "),
        metric,
        read: {
          // The ANSWER's completeness, over every read it used — not the offer read's alone.
          complete: answerStatus === "complete",
          status: answerStatus,
          pages_read: read.pagesRead,
          rows_returned: read.rows.length,
          // The offer read's own verdict, kept and LABELLED as its own so the two can never be
          // read for each other again.
          offer_read: { complete: read.complete, status: read.status },
        },
        omissions: [...omissions, ...metric.omissions],
      },
      analyses: [{ planned_metric: metricId, metric }],
      denials: [],
      next_steps: nextSteps,
    },
    nextCursor: null,
  };
}

// Explicit broad intent ("everything", recipes: "all", broad: true) selects the panel as the
// question's own answer — domain_recognized stays true and nothing is labelled an approximation.
// That is distinct from the CLO-275 fallback, where an unmatched question runs the same panel but
// the answer says so: mode approximate_composite, domain_recognized false.
function isBroadDiagnosticIntent(question: string, params: Record<string, unknown>): boolean {
  if (params.broad === true) return true;
  const recipesParam = params.recipes ?? params.recipe;
  if (typeof recipesParam === "string" && recipesParam.trim().toLowerCase() === "all") return true;
  const normalized = ` ${question.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()} `;
  return /\b(overall|health check|full diagnostic|full picture|everything|comprehensive|end to end|across all|across my)\b/.test(normalized);
}

/**
 * The full diagnostic panel, resolved from the registry so a newly registered recipe joins it, and
 * bounded by the SAME ceiling selectRecipes applies (an explicit max_recipes wins; DEFAULT_MAX_RECIPES
 * is derived from the registry, so the default runs everything).
 */
function broadDiagnosticPanel(params: Record<string, unknown>): RecipeDefinition[] {
  const maxRecipes = readPositiveInt(params.max_recipes) ?? DEFAULT_MAX_RECIPES;
  return BROAD_DIAGNOSTIC_RECIPES
    .map((id) => RECIPES.find((recipe) => recipe.id === id))
    .filter((recipe): recipe is RecipeDefinition => recipe !== undefined)
    .slice(0, maxRecipes);
}

/**
 * One composition contract for every answer that carries a message — planned, matched-recipe and
 * composite alike. First sentence: what scope this ran over, plus (joined into it, never stranded
 * in a second sentence) the shape's own clause — what ran, what could not, what was never tried.
 * Then the time window when there is one, then what to do next. Written once so a recruiter reads
 * the same disclosures in the same order whichever branch answered.
 */
function composeAnswerMessage(input: {
  scopeHeader: AnalysisContextHeader | null;
  appliedTimeWindow: AppliedTimeWindow | null;
  clause?: string;
  lead?: string;
  trailer?: string;
}): string {
  const scope = input.scopeHeader?.scope_label ?? "the reqs your Greenhouse permissions return";
  const sentences: string[] = [`Answered over ${scope}${input.clause ? ` — ${input.clause}` : ""}.`];
  if (input.lead) sentences.push(input.lead);
  const window = input.appliedTimeWindow;
  if (window?.origin === "question" && window.window_start && window.window_end) {
    sentences.push(`Time window: ${window.label} (${window.window_start.slice(0, 10)} to ${window.window_end.slice(0, 10)}).`);
  } else if (window?.origin === "explicit") {
    sentences.push("Time window: the window_start/window_end you passed; each analysis states the interval it resolved.");
  }
  if (input.trailer) sentences.push(input.trailer);
  return sentences.join(" ");
}

/**
 * What the panel actually did, in the recruiter's terms. A recipe that was INVOKED and denied used
 * to vanish from the message (only successes were listed as "ran"), which read as a clean panel;
 * so did the four recipes a deadline meant were never attempted at all. Both are named.
 */
function panelClause(
  selected: RecipeDefinition[],
  analyses: Array<Record<string, unknown>>,
  denials: Array<Record<string, unknown>>
): string {
  const ran = analyses.filter((entry) => entry.status === "ok").map((entry) => String(entry.recipe));
  const blocked = denials.map((entry) => String(entry.recipe));
  const notAttempted = Math.max(0, selected.length - ran.length - blocked.length);
  const parts: string[] = [];
  parts.push(ran.length > 0 ? ran.join(", ") : `none of it could complete: ${blocked.join(", ")}`);
  if (ran.length > 0 && blocked.length > 0) parts.push(`${blocked.join(", ")} could not run`);
  if (notAttempted > 0) parts.push(`${notAttempted} further analyses were not attempted`);
  return parts.join("; ");
}

function composeCompositeMessage(
  scopeHeader: AnalysisContextHeader | null,
  appliedTimeWindow: AppliedTimeWindow | null,
  selected: RecipeDefinition[],
  analyses: Array<Record<string, unknown>>,
  denials: Array<Record<string, unknown>>
): string {
  return composeAnswerMessage({
    scopeHeader,
    appliedTimeWindow,
    clause: `no single analysis matched this question, so the broad panel ran instead (${panelClause(selected, analyses, denials)})`,
    trailer: `Treat this as an approximation and rephrase toward one of: ${PLANNER_RECIPE_IDS.join(", ")}.`,
  });
}

/**
 * The planned-domain filter bounds, derived from the one AppliedTimeWindow the whole planner
 * shares. A one-sided explicit window is one-sided here too: the absent side is unbounded rather
 * than a reason to fall back to reading the sentence.
 */
function plannedDomainBounds(
  window: AppliedTimeWindow | null
): { startMs: number; endMs: number; label: string; startLabel: string; endLabel: string } | null {
  if (!window) return null;
  const start = window.window_start ? Date.parse(window.window_start) : Number.NaN;
  const end = window.window_end ? Date.parse(window.window_end) : Number.NaN;
  if (!Number.isFinite(start) && !Number.isFinite(end)) return null;
  return {
    startMs: Number.isFinite(start) ? start : Number.NEGATIVE_INFINITY,
    endMs: Number.isFinite(end) ? end : Number.POSITIVE_INFINITY,
    label: window.label ?? "explicit window params",
    startLabel: Number.isFinite(start) ? new Date(start).toISOString().slice(0, 10) : "the earliest record",
    endLabel: Number.isFinite(end) ? new Date(end).toISOString().slice(0, 10) : "now",
  };
}

function buildAnalysisPlan(
  question: string,
  selected: RecipeDefinition[],
  scopeHeader: AnalysisContextHeader | null
): AnalysisPlan {
  return {
    interpretedQuestion: question,
    requestedScope: requestedScope(scopeHeader),
    requiredMetrics: uniqueStrings(selected.flatMap((recipe) => recipe.requiredMetrics)),
    requiredFacts: uniqueFacts(selected.flatMap((recipe) => recipe.requiredFacts)),
    requiredEndpoints: uniqueStrings(selected.flatMap((recipe) => recipe.requiredEndpoints)).sort(),
    requiredProjectionProfile: strongestProjectionProfile(selected.map((recipe) => recipe.requiredProjectionProfile)),
    needsUserConfirmation: false,
  };
}

function buildMissingDomainPlan(
  question: string,
  scopeHeader: AnalysisContextHeader | null,
  missingDomain: MissingDomain
): AnalysisPlan {
  return {
    interpretedQuestion: question,
    requestedScope: requestedScope(scopeHeader),
    requiredMetrics: missingDomain.requiredMetrics,
    requiredFacts: missingDomain.requiredFacts,
    requiredEndpoints: missingDomain.requiredEndpoints,
    requiredProjectionProfile: missingDomain.requiredProjectionProfile,
    needsUserConfirmation: false,
    stopReason: missingDomain.stopReason,
    missingFacts: missingDomain.requiredFacts,
    missingEndpoints: missingDomain.requiredEndpoints,
  };
}

function buildConfirmationPlan(question: string, resolution: ResolveJobScopeOutput): AnalysisPlan {
  const selected = selectRecipes(question, {});
  return {
    ...buildAnalysisPlan(question, selected, null),
    requestedScope: {
      source: "job_scope_resolution",
      resolution_status: resolution.resolution_status,
      confirmation_required: resolution.confirmation.required,
      candidate_count: resolution.matches.length,
    },
    needsUserConfirmation: true,
    confirmationReason: resolution.confirmation.confirmation_prompt ?? resolution.confirmation.reason_codes.join(","),
  };
}

function requestedScope(scopeHeader: AnalysisContextHeader | null): Record<string, unknown> {
  if (!scopeHeader) {
    return {
      source: "permission_scope",
      primary_scope_domain: "recruiter_permitted_jobs",
      scope_label: "current authenticated recruiter's permitted jobs",
    };
  }
  return {
    source: scopeHeader.source,
    primary_scope_domain: scopeHeader.primary_scope_domain,
    scope_label: scopeHeader.scope_label,
    scope_hash: scopeHeader.scope_hash,
    job_count: scopeHeader.job_count,
    expires_at: scopeHeader.expires_at,
  };
}

function strongestProjectionProfile(profiles: RecruiterProjectionProfileName[]): RecruiterProjectionProfileName {
  const priority: RecruiterProjectionProfileName[] = [
    "operator_site_admin",
    "admin_diagnostic",
    "recruiting_manager",
    "coordinator_default",
    "recruiter_default",
    "compliance_aggregate",
  ];
  return priority.find((profile) => profiles.includes(profile)) ?? "recruiter_default";
}

function parseExplicitRecipes(raw: unknown): RecipeId[] {
  if (typeof raw !== "string") return [];
  const aliases = new Map<string, RecipeId>([
    ["scorecards", "scorecard_accountability"],
    ["scorecard", "scorecard_accountability"],
    ["scorecard_accountability", "scorecard_accountability"],
    ["feedback", "interview_feedback_drag"],
    ["interview_feedback", "interview_feedback_drag"],
    ["interview_feedback_drag", "interview_feedback_drag"],
    ["stage", "stage_latency"],
    ["stage_latency", "stage_latency"],
    ["pipeline", "pipeline_quality"],
    ["pipeline_quality", "pipeline_quality"],
    ["source", "source_quality"],
    ["sources", "source_quality"],
    ["referrals", "source_quality"],
    ["source_quality", "source_quality"],
    ["rejection", "rejection_reason_drift"],
    ["rejections", "rejection_reason_drift"],
    ["rejection_reason", "rejection_reason_drift"],
    ["rejection_reasons", "rejection_reason_drift"],
    ["reason_drift", "rejection_reason_drift"],
    ["rejection_reason_drift", "rejection_reason_drift"],
  ]);
  return raw
    .split(",")
    .map((token) => token.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_"))
    .map((token) => aliases.get(token))
    .filter((value): value is RecipeId => Boolean(value));
}

function pickParams(params: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (params[key] !== undefined) picked[key] = params[key];
  }
  return picked;
}

function summarizeRecipeParams(params: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (["evidence_pack", "include_evidence_pack"].includes(key)) {
      summary[key] = value === true;
    } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      summary[key] = value;
    }
  }
  return summary;
}

function buildAnswer(
  selected: RecipeDefinition[],
  analyses: Array<Record<string, unknown>>,
  denials: Array<Record<string, unknown>>,
  // Taken as INPUTS: the composite needs its own mode and an honest domain_recognized: false, and
  // hardcoding them here is what made the shape unavailable to any caller but the matched path.
  shape: { mode: string; domainRecognized: boolean; message?: string }
): Record<string, unknown> {
  const successful = analyses.filter((entry) => entry.status === "ok");
  return {
    mode: shape.mode,
    domain_recognized: shape.domainRecognized,
    ...(shape.message !== undefined ? { message: shape.message } : {}),
    successful_recipes: successful.map((entry) => entry.recipe),
    denied_recipes: denials.map((entry) => entry.recipe),
    metric_definitions: metricDefinitionsForRecipes(selected),
    interpretation: selected.map((recipe) => {
      const catalog = RECIPE_CATALOG.get(recipe.id);
      return {
        recipe: recipe.id,
        toolName: recipe.toolName,
        reason: recipe.reason,
        required_metrics: recipe.requiredMetrics,
        required_facts: recipe.requiredFacts,
        required_endpoints: recipe.requiredEndpoints,
        required_projection_profile: recipe.requiredProjectionProfile,
        ...(catalog
          ? {
              required_tools: catalog.required_tools,
              required_scope: catalog.required_scope,
              completeness_requirements: catalog.completeness_requirements,
              safety_notes: catalog.safety_notes,
            }
          : {}),
      };
    }),
    caveat: "This planner composes approved deterministic analyses; it does not perform arbitrary SQL, raw joins, or hidden unscoped reads.",
  };
}

function metricDefinitionsForRecipes(selected: RecipeDefinition[]): Array<Record<string, unknown>> {
  return uniqueStrings(selected.flatMap((recipe) => recipe.requiredMetrics)).flatMap((metricId) => {
    const metric = METRIC_REGISTRY_BY_ID.get(metricId);
    if (!metric) return [];
    return [{
      id: metric.id,
      display_name: metric.displayName,
      required_facts: metric.requiredFacts,
      required_fields: metric.requiredFields,
      required_role_profile: metric.requiredRoleProfile,
      ...(metric.windowField ? { window_field: metric.windowField } : {}),
      scope_behavior: metric.scopeBehavior,
      exclusions: metric.exclusions,
      completeness_rules: metric.completenessRules,
    }];
  });
}

function normalizeQuestion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

function readSummary(data: unknown): Record<string, unknown> {
  if (isRecord(data) && isRecord(data.summary)) return data.summary;
  if (isRecord(data) && isRecord(data.data) && isRecord(data.data.summary)) return data.data.summary;
  return {};
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function uniqueFacts(values: MetricFactName[]): MetricFactName[] {
  return [...new Set(values)];
}

async function emitPlannerAudit(
  runtime: RecruiterToolRuntime,
  startedAt: number,
  correlationId: string,
  result: RecruiterToolResult,
  rowsRead: number | null,
  rowsReturned: number | null,
  actAsUser: number | null
): Promise<RecruiterToolResult | null> {
  return emitRequiredToolAudit(runtime, QUESTION_ANSWER_TOOL.name, "analysis", startedAt, correlationId, result, rowsRead, rowsReturned, actAsUser);
}

type PlannerScopeOutcome =
  | { ok: true; kind: "scoped"; jobIds?: string; header: AnalysisContextHeader | null }
  | { ok: true; kind: "resolution_required"; resolution: ResolveJobScopeOutput }
  // The scope the question asked for is KNOWN and EMPTY — "my reqs" for someone assigned to none,
  // "all open reqs" where none are open. Zero is the answer; running the analysis over a different
  // population (their whole permitted book, or the closed reqs) would answer a different question.
  | { ok: true; kind: "empty_scope"; header: AnalysisContextHeader | null; message: string }
  | { ok: false; code: RecruiterDenialCode; message: string };

/**
 * Every explicit scope carrier this tool accepts, and what "the caller named a scope" means for it.
 *
 * PRESENT-BUT-EMPTY is a named scope of zero, and it is rejected. `job_ids: []` was fixed and its
 * siblings were not: the planner recognized `scope_handle` and `greenhouse_job_ids` only when
 * NON-EMPTY, so `{scope_handle: "   "}` and `{greenhouse_job_ids: []}` skipped scope resolution
 * entirely and were answered across everything the actor's Greenhouse permissions reach. A scope
 * the caller named must never be replaced by a wider one they did not.
 *
 * ABSENT (undefined, or the MCP-schema-rejected null) is not empty — it means "whatever my
 * permissions reach", and it still answers.
 */
const PLANNER_SCOPE_CARRIERS: ReadonlyArray<{ key: string; usable: (value: unknown) => boolean; expected: string }> = [
  {
    key: "scope_handle",
    usable: (value) => typeof value === "string" && value.trim().length > 0,
    expected: "a signed scope_handle from resolve_job_scope/confirm_job_scope",
  },
  {
    key: "greenhouse_job_ids",
    usable: (value) => Array.isArray(value) && numberArray(value).length > 0,
    expected: "at least one positive Greenhouse job id",
  },
  {
    key: "requisition_ids",
    usable: (value) => Array.isArray(value) && stringArray(value).length > 0,
    expected: "at least one non-blank requisition id",
  },
];

function emptyScopeCarrierError(params: Record<string, unknown>): PlannerScopeOutcome | null {
  for (const carrier of PLANNER_SCOPE_CARRIERS) {
    const value = params[carrier.key];
    if (value === undefined || value === null) continue;
    if (carrier.usable(value)) continue;
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: `${carrier.key} was passed but names no scope. Pass ${carrier.expected}, or omit ${carrier.key} to answer across every job your Greenhouse permissions return.`,
    };
  }
  return null;
}

async function resolvePlannerScope(
  runtime: RecruiterToolRuntime,
  question: string,
  params: Record<string, unknown>,
  deadline: ToolDeadline | undefined
): Promise<PlannerScopeOutcome> {
  // Before ANY read, including the job-inventory load the default scope needs.
  const emptyCarrier = emptyScopeCarrierError(params);
  if (emptyCarrier) return emptyCarrier;
  const scopeHandle = typeof params.scope_handle === "string" && params.scope_handle.trim().length > 0
    ? params.scope_handle.trim()
    : null;
  if (scopeHandle) {
    const scoped = await resolveAnalysisContext(runtime, explicitScopeParams(params), deadline);
    if (!scoped.ok) return { ok: false, code: scoped.code, message: scoped.message };
    return { ok: true, kind: "scoped", jobIds: readResolvedJobIds(scoped.params), header: scoped.header };
  }
  // KEY PRESENCE, not "is it a non-empty list". An explicitly EMPTY job_ids ("" or []) is a scope
  // the caller named — zero reqs — and resolveAnalysisContext rejects it (analysis-context.ts,
  // "job_ids must contain at least one Greenhouse job id"). Branching on non-emptiness skipped that
  // check, and on the planned-domain path (offers, openings) nothing downstream repeated it: the
  // answer came back over everything the actor's permissions reach. Same rule as the hire read's
  // scope — `undefined` is permission-wide, `[]` is zero.
  if (params.job_ids !== undefined && params.job_ids !== null) {
    // Exact ids are not assumed safe because they are numeric; validate and scope
    // them through the same helper the analysis tools use before any recipe runs.
    const scoped = await resolveAnalysisContext(runtime, explicitScopeParams(params), deadline);
    if (!scoped.ok) return { ok: false, code: scoped.code, message: scoped.message };
    return { ok: true, kind: "scoped", jobIds: readResolvedJobIds(scoped.params), header: scoped.header };
  }

  // No explicit scope. Load the permission-scoped inventory once: it is what lets the answer NAME
  // the scope it ran over, and its scopeKind ("jobs" vs operator/all) says whether an unscoped read
  // is this actor's own book or the org. Eligibility for the org-wide default is a permission fact,
  // never a phrase heuristic — the phrase only decides whether the population is open reqs.
  const load = await loadJobInventory(runtime, deadline);
  if (!load.ok) return { ok: false, code: load.code, message: load.message };
  const orgWideEligible = load.inventory.scopeKind !== "jobs";

  // Possessive req intent always resolves the actor's recruiter/sourcer assignments, regardless of
  // whether their permission scope is narrow or org-wide. Empty/failing ownership never falls back
  // to the full permitted book.
  const ownerIntent = hasOwnerIntent(question);
  let ownerScopedJobIds: Set<number> | undefined;
  if (ownerIntent) {
    const owner = await resolveOwnerScope(
      runtime,
      QUESTION_ANSWER_TOOL.name,
      { my_jobs_only: true },
      load.inventory,
      deadline
    );
    if (!owner.ok) return { ok: false, code: owner.code, message: owner.message };
    ownerScopedJobIds = owner.ownerScopedJobIds;
  }

  // The probe is PURE — resolveJobScope reads nothing, it ranks the question against the inventory
  // already in hand — so every actor gets it, narrow ones included. Skipping it for a narrow
  // recruiter was the live defect: "why is req SAIS-US-401 slow" was answered across their whole
  // book because the permitted-set shortcut ran before the resolver ever saw the sentence.
  const explicitNarrowing = hasResolverIntent(params);
  const { signer, ephemeral } = resolveScopeSigner(runtime);
  const output = resolveJobScope(buildPlannerResolverInput(question, params, ownerIntent), {
    inventory: load.inventory,
    subject: runtime.session.subject,
    signer,
    nowMs: runtime.now(),
    signerEphemeral: ephemeral,
    ownerScopedJobIds: ownerScopedJobIds ?? null,
  });
  if (output.resolution_status === "resolved" && output.scope.job_ids.length > 0) {
    return resolvedScopeOutcome(output, []);
  }

  // EXPLICIT NARROWING THAT MISSED NEVER WIDENS. The org-wide default answers a question that
  // named nothing; it must not answer one that named something the index could not find. Owner
  // intent ("my reqs") and explicit resolver params are both the caller saying WHICH reqs.
  if (ownerIntent) {
    if (output.scope.job_ids.length > 0) {
      // A closed/stale/confidential flag on the actor's OWN reqs is a disclosure, not a reason to
      // ask which reqs they meant — they said which.
      return resolvedScopeOutcome(
        output,
        probeDisclosures(output, new Set(output.confirmation.reason_codes), false)
      );
    }
    return {
      ok: true,
      kind: "empty_scope",
      header: null,
      message:
        "You are not the recruiter or sourcer on any open req in Greenhouse, so there is nothing to analyze under \"my reqs\". Ask the same question without the possessive to cover every job you can see, or name a req.",
    };
  }
  if (explicitNarrowing) {
    // query / requisition_ids / greenhouse_job_ids / aliases / role_families that resolved to
    // nothing: stay unresolved and hand back the resolver's own message. Widening here would
    // answer a different question than the one the caller pinned.
    return { ok: true, kind: "resolution_required", resolution: output };
  }

  const decision = classifyScopeProbe(output, load.inventory);
  if (!orgWideEligible) {
    // A narrow recruiter's free-text question: a req they NAMED at high confidence becomes the
    // scope; anything weaker keeps today's permitted-set default byte for byte, so their plain
    // questions never gain a confirmation round-trip they did not have before.
    if (decision.kind === "use_scope" && output.confidence.band === "high" && output.scope.job_ids.length > 0) {
      return resolvedScopeOutcome(output, decision.warnings);
    }
    return { ok: true, kind: "scoped", header: buildPermissionScopeHeader(load.inventory) };
  }
  if (decision.kind === "confirm") {
    return { ok: true, kind: "resolution_required", resolution: output };
  }
  if (decision.kind === "use_scope" && output.scope.job_ids.length > 0) {
    return resolvedScopeOutcome(output, decision.warnings);
  }
  return orgWideScopeOutcome(question, load.inventory, decision.warnings);
}

function resolvedScopeOutcome(output: ResolveJobScopeOutput, extraWarnings: string[]): PlannerScopeOutcome {
  return {
    ok: true,
    kind: "scoped",
    jobIds: output.scope.job_ids.join(","),
    header: {
      source: "scope_handle",
      primary_scope_domain: "job_scope",
      scope_label: output.scope.scope_label,
      scope_hash: output.scope.scope_hash,
      job_count: output.scope.job_ids.length,
      expires_at: output.scope.expires_at,
      warnings: [...output.warnings, ...extraWarnings],
    },
  };
}

/**
 * The org-wide default (CLO-274). The question named no requisition, so the answer covers what the
 * actor's Greenhouse permissions already return and says so. One population refinement: a question
 * about OPEN reqs gets the open population rather than every job ever opened — that is scope
 * correctness, not a clamp, and when the index is truncated the population cannot be enumerated, so
 * the answer runs across everything and DISCLOSES that closed reqs are in it.
 */
function orgWideScopeOutcome(question: string, inventory: JobInventory, warnings: string[]): PlannerScopeOutcome {
  const total = inventory.records.length;
  const openIds = inventory.records
    .filter((record) => record.status.trim().toLowerCase() === "open")
    .map((record) => record.greenhouse_job_id);
  const openOnly = wantsOpenReqPopulation(question);

  if (openOnly && inventory.complete && openIds.length === 0) {
    // A complete index with ZERO open jobs used to fall through to the unbounded permitted-set
    // path — so an "all open reqs" question was answered by analyzing the CLOSED ones. Zero open
    // reqs is the honest answer to a question about open reqs.
    return {
      ok: true,
      kind: "empty_scope",
      header: {
        source: "permission_scope",
        primary_scope_domain: "job_scope",
        scope_label: "0 open jobs you can see in Greenhouse",
        job_count: 0,
        warnings,
      },
      message: `You can see ${total} job(s) in Greenhouse and no open req among them, so a question about open reqs has nothing to run over. Ask about all reqs, or name a closed req, to include them.`,
    };
  }

  if (openOnly && inventory.complete && openIds.length > 0) {
    const excluded = total - openIds.length;
    return {
      ok: true,
      kind: "scoped",
      jobIds: openIds.join(","),
      header: {
        source: "permission_scope",
        primary_scope_domain: "job_scope",
        scope_label: `all ${openIds.length} open jobs you can see in Greenhouse`,
        job_count: openIds.length,
        warnings: excluded > 0
          ? [...warnings, `${excluded} non-open req(s) you can see were left out because the question asked about open reqs.`]
          : warnings,
      },
    };
  }

  const disclosures = [...warnings];
  if (openOnly && !inventory.complete) {
    disclosures.push(
      "The question asked about open reqs, but the job index is truncated, so the open population could not be enumerated — this answer spans every job you can see, closed reqs included."
    );
  }
  return { ok: true, kind: "scoped", header: buildPermissionScopeHeader(inventory, disclosures) };
}

/** "all open reqs", "our active roles" — a population statement, not a job reference. */
function wantsOpenReqPopulation(question: string): boolean {
  const normalized = ` ${question.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()} `;
  return / (open|active|current) (reqs?|requisitions?|roles?|jobs?|positions?|openings?|pipelines?) /.test(normalized);
}

export type ScopeProbeDecision =
  | { kind: "use_scope"; warnings: string[] }
  | { kind: "org_wide"; warnings: string[] }
  | { kind: "confirm" };

const NO_REQ_NAMED_WARNING =
  "No specific requisition was named; answered across all jobs you can see. Name a req or role to narrow.";

// A question that DID name something the index could not match is a different disclosure, and
// telling the recruiter "you named nothing" when they named a req that missed is simply false.
const NO_REQ_MATCHED_WARNING =
  "The terms in this question matched no requisition you can see; answered across all jobs you can see. Name a req or its requisition id to narrow.";

// The resolver's own warnings ride the answer (they explain the question's terms), except its two
// internal notices about candidate-preview mechanics, which describe neither the question nor the
// unbounded read this header is disclosing.
const RESOLVER_INTERNAL_WARNING_PREFIXES = ["scope_signing_key_ephemeral", "Excluded ", "Showing the top "];

function carriedResolverWarnings(output: ResolveJobScopeOutput): string[] {
  return output.warnings.filter(
    (warning) => !RESOLVER_INTERNAL_WARNING_PREFIXES.some((prefix) => warning.startsWith(prefix))
  );
}

// The candidate set the resolver SYNTHESIZES for a role-less or broad-phrased question: one entry
// per permitted job, scored 0.3 (band "none"), tagged with the reason it was manufactured
// (resolver.ts selectBySearch). It is the resolver saying "you named nothing", not a match.
const SYNTHESIZED_MATCH_REASONS = new Set(["all_accessible", "broad_phrase"]);

function isSynthesizedAllPermittedSelection(output: ResolveJobScopeOutput): boolean {
  if (output.matches.length === 0) return false;
  if (output.confidence.band === "none") return true;
  return output.matches.every(
    (match) => match.match_reasons.length > 0 && match.match_reasons.every((reason) => SYNTHESIZED_MATCH_REASONS.has(reason))
  );
}

function unnamedScopeWarning(output: ResolveJobScopeOutput): string {
  return isSynthesizedAllPermittedSelection(output) ? NO_REQ_NAMED_WARNING : NO_REQ_MATCHED_WARNING;
}

/**
 * CLO-274, the whole org-wide default policy in one pure, TOTAL function: given the resolver's
 * probe of the question, either use the scope it found, answer across the actor's permission floor,
 * or ask which req they meant. Total over ResolutionStatus on purpose — an unhandled status must
 * never quietly become a refusal, which is how the old planner turned every unnamed question into a
 * dead end. Confirmation is reserved for ambiguity a default genuinely cannot settle: several real
 * reqs matched, a collision alias, or one requisition id mapping to two jobs. Everything else
 * (closed reqs, confidential reqs the actor is already on the hiring team for, a stale or truncated
 * index, weak lexical confidence) is a DISCLOSURE, not a blocker.
 */
export function classifyScopeProbe(output: ResolveJobScopeOutput, inventory: JobInventory): ScopeProbeDecision {
  const codes = new Set<ConfirmationReasonCode>(output.confirmation.reason_codes);
  const band = output.confidence.band;

  switch (output.resolution_status) {
    case "resolved":
      return { kind: "use_scope", warnings: [] };
    case "forbidden":
    case "error":
      // A probe that could not be evaluated is not an answerable scope; keep today's handling
      // rather than reading org-wide off the back of a failure.
      return { kind: "confirm" };
    case "no_match":
      // no_match is only reachable when the question CARRIED terms (an empty or role-less one is
      // synthesized to the permitted set instead), so the disclosure says the terms missed. The
      // resolver's own warnings — which name the terms that missed — used to be dropped here.
      return { kind: "org_wide", warnings: [unnamedScopeWarning(output), ...carriedResolverWarnings(output)] };
    case "incomplete":
      // A truncated index cannot tell "named nothing" from "named something unread", so this
      // branch claims neither.
      return {
        kind: "org_wide",
        warnings: [
          `The job index could not be read completely (${inventory.accessibleSeen} req(s) enumerated), so no named requisition could be confirmed from it. The answer itself does not depend on the index — it runs over what your Greenhouse permissions return.`,
          ...carriedResolverWarnings(output),
        ],
      };
    case "ambiguous":
      return { kind: "confirm" };
    case "needs_confirmation":
      break;
  }

  if (codes.has("duplicate_req_id")) return { kind: "confirm" };

  // A "named" selection is one the question actually pointed at: real matches, at a real lexical
  // band, not the synthesized all-permitted set the resolver offers for a role-less question. The
  // discriminator keys off THAT set's own signal, never off the absence of `broad_scope`:
  // resolver.ts sets broad_scope on the PHRASE alone ("all", "every", "entire"), so
  // "why is the entire Staff Backend req stalled" threw away a real, unique, high-band match and
  // answered org-wide instead — the exact opposite of what the recruiter asked.
  const namedSelection =
    output.matches.length > 0 && (band === "high" || band === "medium") && !isSynthesizedAllPermittedSelection(output);
  if (namedSelection && codes.has("multiple_matches")) return { kind: "confirm" };

  const warnings = probeDisclosures(output, codes, namedSelection);
  if (namedSelection) return { kind: "use_scope", warnings: [...warnings, ...carriedResolverWarnings(output)] };
  return { kind: "org_wide", warnings: [unnamedScopeWarning(output), ...warnings, ...carriedResolverWarnings(output)] };
}

function probeDisclosures(
  output: ResolveJobScopeOutput,
  codes: Set<ConfirmationReasonCode>,
  namedSelection: boolean
): string[] {
  const warnings: string[] = [];
  if (namedSelection && codes.has("broad_scope")) {
    warnings.push(
      `A broad word in this question ("all"/"every"/"entire") was read as analysis wording, not as scope — the answer is scoped to "${output.scope.scope_label}". Drop the req name to run across every job you can see.`
    );
  }
  const closed = output.matches.filter((match) => match.status.trim().toLowerCase() !== "open").length;
  if (codes.has("contains_closed_jobs") && closed > 0) {
    warnings.push(`Scope includes ${closed} closed req(s).`);
  }
  const confidential = output.matches.filter((match) => match.confidential).length;
  if (codes.has("contains_confidential_jobs") && confidential > 0) {
    // Confidential reqs reach `matches` only when they are already in this actor's
    // permission-filtered inventory, so naming the count reveals nothing new.
    warnings.push(`Scope includes ${confidential} confidential req(s) you are on the hiring team for.`);
  }
  if (codes.has("stale_index")) {
    warnings.push("The job index behind this scope is stale; re-resolve if a req opened or closed recently.");
  }
  if (codes.has("medium_confidence")) {
    warnings.push(`Matched "${output.scope.scope_label}" at medium confidence — name the req or its requisition id to be certain.`);
  }
  if (codes.has("unmatched_material_terms")) {
    warnings.push("Some words in the question matched no accessible job and were read as analysis wording, not scope.");
  }
  return warnings;
}

function explicitScopeParams(params: Record<string, unknown>): Record<string, unknown> {
  const scoped: Record<string, unknown> = {};
  if (params.scope_handle !== undefined) scoped.scope_handle = params.scope_handle;
  if (params.job_ids !== undefined) scoped.job_ids = params.job_ids;
  return scoped;
}

function readResolvedJobIds(params: Record<string, unknown>): string | undefined {
  return typeof params.job_ids === "string" && params.job_ids.trim().length > 0 ? params.job_ids : undefined;
}

function buildPlannerResolverInput(
  question: string,
  params: Record<string, unknown>,
  ownerIntent = false
): ResolveJobScopeInput {
  const explicitQuery = typeof params.query === "string" && params.query.trim().length > 0
    ? params.query
    : undefined;
  return {
    // The possessive phrase itself is the scope: all open recruiter/sourcer assignments.
    // Do not feed analytical words such as "broken" or "slow" into the job-title ranker.
    query: explicitQuery ?? (ownerIntent ? undefined : question),
    greenhouse_job_ids: numberArray(params.greenhouse_job_ids),
    requisition_ids: stringArray(params.requisition_ids),
    aliases: stringArray(params.aliases),
    role_families: stringArray(params.role_families),
    purpose: "general_question",
    ...(ownerIntent ? { filters: { my_jobs_only: true } } : {}),
  };
}

// Possessive job-scope intent: "my/our reqs|roles|pipeline…" means the actor's OWNED reqs
// (owner resolution), not everything they are permitted to see. Deliberately job-noun-anchored
// so "my scorecards" / "my interviews" (artifact possessives) don't trigger owner narrowing.
function hasOwnerIntent(question: string): boolean {
  return /\b(my|our)\s+(open\s+|active\s+|current\s+)?(reqs?|requisitions?|roles?|jobs?|positions?|openings?|pipelines?|portfolio)\b/i.test(question);
}

function hasResolverIntent(params: Record<string, unknown>): boolean {
  return (
    (typeof params.query === "string" && params.query.trim().length > 0) ||
    stringArray(params.aliases).length > 0 ||
    stringArray(params.role_families).length > 0 ||
    stringArray(params.requisition_ids).length > 0 ||
    numberArray(params.greenhouse_job_ids).length > 0
  );
}

function withPlannerJobIds(params: Record<string, unknown>, jobIds: string): Record<string, unknown> {
  const next = { ...params };
  delete next.scope_handle;
  next.job_ids = jobIds;
  return next;
}

function stripScopeHandle(params: Record<string, unknown>): Record<string, unknown> {
  const next = { ...params };
  delete next.scope_handle;
  return next;
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const entry of value) {
    if (typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0) out.push(entry);
  }
  return out;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * An offer that has neither resolved nor been superseded — sent, and still out. Classified the same
 * way computeOfferResolutionMix classifies the mix (case-insensitively, because the status vocab is
 * tenant-defined and often capitalized), so the two cannot disagree about what "outstanding"
 * means. `Deprecated` is excluded: a superseded version is not an offer anybody is waiting on.
 */
// The SAME classifier the mix, the hire facts and the reconciliation lead use (facts.ts). This was
// the fourth substring reading of an offer status in one answer; an unrecognized value now reads as
// unknown here too, so nothing is called "still open" on a guess.
function isOutstandingOffer(fact: Record<string, unknown>): boolean {
  return classifyOfferStatus(fact.status) === "outstanding";
}

/**
 * The recipes' errorToDenial, for the planner's own read path. Same classes, same order: an
 * identity failure keeps its code, a cancellation and a timeout keep theirs, a window-validation
 * message is a LIMIT_EXCEEDED the caller can act on, and anything else is an UPSTREAM_ERROR
 * classified rather than echoed raw.
 */
function plannerErrorToDenial(toolName: string, error: unknown): RecruiterToolResult {
  if (error instanceof IdentityResolutionError) {
    return deny(toolName, error.code, error.message);
  }
  if (isToolCancelledError(error)) {
    return deny(toolName, "CANCELLED", "Scoped Greenhouse question planner was cancelled because the client request ended.");
  }
  if (isToolTimeoutError(error)) {
    return deny(toolName, "TOOL_TIMEOUT", "Scoped Greenhouse question planner timed out before returning data.");
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("window exceeds") || message.includes("requires a valid window")) {
    return deny(toolName, "LIMIT_EXCEEDED", message);
  }
  return deny(toolName, "UPSTREAM_ERROR", classifyUpstreamError(error, "The planned analysis failed before returning data."));
}
