import { HARD_MAX_ANALYSIS_DURATION_MS, HARD_MAX_TOOL_DURATION_MS, isToolEnabled, readPositiveInt } from "../limits.js";
import { createToolDeadline, deny, emitRequiredToolAudit, enforceUsageBudget, isToolCancelledError, type RecruiterToolRuntime, type ToolDeadline } from "../runtime.js";
import { newCorrelationId } from "../audit.js";
import type { RecruiterDenialCode, RecruiterPermissionScope, RecruiterToolDefinition, RecruiterToolResult } from "../types.js";
import { INTERVIEW_FEEDBACK_DRAG_TOOL, runInterviewFeedbackDrag } from "./interview-feedback-drag.js";
import { PIPELINE_QUALITY_TOOL, runPipelineQuality } from "./pipeline-quality.js";
import { SCORECARD_ACCOUNTABILITY_TOOL, runScorecardAccountability } from "./scorecard-accountability.js";
import { SOURCE_QUALITY_TOOL, runSourceQuality } from "./source-quality.js";
import { REJECTION_REASON_DRIFT_TOOL, runRejectionReasonDrift } from "./rejection-reason-drift.js";
import { STAGE_LATENCY_TOOL, runStageLatency } from "./stage-latency.js";
import { resolveAnalysisContext } from "../resolution/analysis-context.js";
import type { AnalysisContextHeader } from "../resolution/types.js";
import { loadJobInventory } from "../resolvers/job-scope/inventory.js";
import { getRecruitingCapabilities } from "../resolvers/job-scope/capabilities.js";
import { resolveJobScope, type ResolveJobScopeInput, type ResolveJobScopeOutput } from "../resolvers/job-scope/resolver.js";
import { resolveScopeSigner } from "../resolvers/job-scope/signer.js";
import { resolveOwnerScope } from "./job-scope/tools.js";
import { METRIC_REGISTRY_BY_ID, computeMetric, type MetricComputeContext, type MetricFactName } from "../metrics.js";
import {
  buildApprovalFlowFacts,
  buildInterviewEventFacts,
  buildJobPostExposureFacts,
  buildOfferFacts,
  buildOpeningHeadcountFacts,
  buildProspectStateFacts,
  type FactBuildResult,
} from "../facts.js";
import { readAllScopedRows } from "../read-all.js";
import type { RecruiterProjectionProfileName } from "../types.js";

export const QUESTION_ANSWER_TOOL: RecruiterToolDefinition = {
  name: "answer_my_recruiting_question",
  kind: "analysis",
  description:
    'THE FRONT DOOR for aggregate analytical questions — metrics, rates, counts, time trends, aggregate comparisons, and time-boxed questions. Ask in plain English ("What\'s our offer acceptance rate last quarter?", "Where are candidates stuck in my reqs?", "How have rejection reasons drifted?"). ONE call resolves the scope (including "my reqs"), reads the complete scoped data, applies the time window server-side (this/last quarter, this year, last N days/weeks/months), and computes the answer with honest disclosures. Prefer this whenever the question wants a NUMBER or aggregate ANALYSIS. For individual resume, scorecard, note, or candidate-history comparisons, use the corresponding scoped evidence/read tools instead. Questions outside the covered domains return the closest available analyses by name instead of a guess.',
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

// The default ceiling is the full recipe panel, so a broad diagnostic runs every recipe
// (an explicit max_recipes still overrides). Keep this equal to the RECIPES count.
const DEFAULT_MAX_RECIPES = 6;
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

  // The planner must not silently broad-run on natural-language job intent. It
  // prefers an explicit scope_handle or job_ids, otherwise resolves job/role
  // intent and returns a confirmation-required response when scope is not yet
  // pinned down.
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
  const scopeHeader = plannerScope.header;
  params = plannerScope.jobIds !== undefined ? withPlannerJobIds(params, plannerScope.jobIds) : stripScopeHandle(params);

  const missingDomain = detectMissingDomain(question);
  if (missingDomain) {
    // T3.2 (audit C-CORE): detectMissingDomain already maps the question to facts + endpoints +
    // metric — the planner in embryo. When the domain's read/fact/metric bindings exist, EXECUTE
    // the plan (read scoped rows -> build facts -> compute the metric) instead of dead-ending at
    // missing_domain. Domains without an executable binding keep the honest denial below.
    let executed: RecruiterToolResult | null;
    try {
      executed = await executePlannedDomain(
        runtime, question, params, missingDomain, scopeHeader, plannerScope.jobIds, plannerDeadline
      );
    } catch (error) {
      if (!isToolCancelledError(error)) throw error;
      const result = deny(toolName, "CANCELLED", "Scoped Greenhouse question planner was cancelled because the client request ended.");
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
          scope_boundary: "No recipe reads ran because the planner identified a recognized but unimplemented fact/domain.",
          plan,
          ...(scopeHeader ? { scope: scopeHeader } : {}),
        },
        answer: {
          mode: "missing_domain",
          domain_recognized: true,
          message: missingDomain.message,
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

  const selected = selectRecipes(question, params);
  if (selected.length === 0) {
    // No recognized domain and no recipe matched: an unrecognized question. Degrade honestly to
    // missing_domain (domain_recognized: false) instead of a confident broad composite.
    const plan = buildUnrecognizedPlan(question, scopeHeader);
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
          domain_recognized: false,
          selected_recipe_count: 0,
          recipes_run_count: 0,
          selected_recipes: [],
          rows_read: null,
          rows_considered: null,
          completeness_status: "missing_domain",
          data_domains: plan.requiredEndpoints,
          projection_profile: plan.requiredProjectionProfile,
          scope_boundary: "No recipe reads ran because no approved recipe matched this question.",
          plan,
          ...(scopeHeader ? { scope: scopeHeader } : {}),
        },
        answer: {
          mode: "missing_domain",
          domain_recognized: false,
          message: "No approved scoped-analysis recipe matches this question. Ask about scorecard accountability, interview feedback drag, stage latency, pipeline quality, or source quality; or request a broad diagnostic explicitly (recipes: \"all\").",
          required_metrics: [],
          missing_facts: [],
          missing_endpoints: [],
          completeness_status: "missing_domain",
        },
        analyses: [],
        denials: [],
        next_steps: [
          "Rephrase toward an approved recipe: scorecard accountability, interview feedback drag, stage latency, pipeline quality, or source quality.",
          "Pass recipes: \"all\" (or ask for a broad diagnostic) to run the full panel.",
        ],
      },
      nextCursor: null,
    };
    const auditDenied = await emitPlannerAudit(runtime, startedAt, correlationId, result, null, null, actAsUser);
    return auditDenied ?? result;
  }
  const plan = buildAnalysisPlan(question, selected, scopeHeader);
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

  if (analyses.length === denials.length) {
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
  const headlineCompleteness = plannerTimedOut || anyChildIncomplete
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
        planner: "keyword-routed recipe planner",
        domain_recognized: true,
        selected_recipe_count: selected.length,
        recipes_run_count: recipesRunCount,
        planner_timed_out: plannerTimedOut,
        selected_recipes: selected.map((recipe) => recipe.id),
        rows_read: sawRowsRead ? rowsRead : null,
        rows_considered: sawRowsReturned ? rowsReturned : null,
        completeness_status: headlineCompleteness,
        data_domains: plan.requiredEndpoints,
        projection_profile: plan.requiredProjectionProfile,
        plan,
        scope_boundary: "All recipe reads run through the recruiter scopedRead surface; no raw Greenhouse client access or model-supplied actor ids are used.",
        ...(scopeHeader ? { scope: scopeHeader } : {}),
      },
      answer: buildAnswer(selected, analyses, denials),
      analyses,
      denials,
      next_steps: [
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
  // The planner resolves and gates scope (resolvePlannerScope) before any recipe
  // runs, so recipes must not re-run the no-scope inventory probe. A broad-access
  // actor never reaches a recipe with an unresolved scope — it is either forced to
  // resolution_required or driven through the explicit job_ids path, which still
  // revalidates permissions.
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
  // No silent broad fallback: an unmatched specific question must degrade to missing_domain,
  // not receive a confident five-recipe composite. Broad diagnostics run only on explicit intent.
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
}

const PLANNED_DOMAIN_BINDINGS: ReadonlyMap<string, PlannedDomainBinding> = new Map([
  ["approval_latency", { scopedToolName: "list_approval_flows", factName: "approval_flow_fact", buildFactsFromRows: (rows) => buildApprovalFlowFacts(rows), factJobIdField: "job_id", factWindowField: "created_at" }],
  ["prospect_pool_movement", { scopedToolName: "list_prospect_details", factName: "prospect_state_fact", buildFactsFromRows: (rows) => buildProspectStateFacts(rows), factJobIdField: null, factWindowField: null }],
  ["availability_to_scheduled_interview_hours", { scopedToolName: "list_interviews", factName: "interview_event_fact", buildFactsFromRows: (rows) => buildInterviewEventFacts(rows), factJobIdField: "job_id", factWindowField: "scheduled_at" }],
  ["job_post_exposure_by_post", { scopedToolName: "list_tracking_links", factName: "job_post_exposure_fact", buildFactsFromRows: (rows) => buildJobPostExposureFacts(rows), factJobIdField: "job_id", factWindowField: null }],
  ["opening_fill_status", { scopedToolName: "list_openings", factName: "opening_headcount_fact", buildFactsFromRows: (rows) => buildOpeningHeadcountFacts(rows), factJobIdField: "job_id", factWindowField: null }],
  ["offer_resolution", { scopedToolName: "list_offers", factName: "offer_fact", buildFactsFromRows: (rows) => buildOfferFacts(rows), factJobIdField: "job_id", factWindowField: "sent_on" }],
]);

// Deterministic NL time windows for the planned-domain path ("this quarter" was silently ignored
// in the live pilot — an all-time number answered a quarter question). Calendar-anchored in UTC;
// explicit window_start/window_end params always win over the parsed phrase.
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
    return { startMs: Date.UTC(year, quarterStartMonth - 3, 1), endMs: Date.UTC(year, quarterStartMonth, 1), label: "last quarter" };
  }
  if (/\bthis month\b/.test(normalized)) {
    return { startMs: Date.UTC(year, month, 1), endMs: nowMs, label: "this month" };
  }
  if (/\blast month\b/.test(normalized)) {
    return { startMs: Date.UTC(year, month - 1, 1), endMs: Date.UTC(year, month, 1), label: "last month" };
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

async function executePlannedDomain(
  runtime: RecruiterToolRuntime,
  question: string,
  params: Record<string, unknown>,
  missingDomain: MissingDomain,
  scopeHeader: AnalysisContextHeader | null,
  resolvedJobIds: string | undefined,
  deadline: ToolDeadline | undefined
): Promise<RecruiterToolResult | null> {
  const metricId = missingDomain.requiredMetrics[0];
  const binding = metricId ? PLANNED_DOMAIN_BINDINGS.get(metricId) : undefined;
  if (!binding || !metricId) return null;

  const read = await readAllScopedRows<Record<string, unknown>>(
    runtime,
    QUESTION_ANSWER_TOOL.name,
    binding.scopedToolName,
    {},
    deadline
  );
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

  // Apply the question's time window ("this quarter") — the live pilot showed an all-time number
  // silently answering a quarter-scoped question. Explicit window params win; a parsed phrase is
  // applied to the domain's event timestamp; either way the applied window (or its absence) is
  // DISCLOSED, and a point-in-time domain says so instead of pretending.
  const explicitStart = typeof params.window_start === "string" ? Date.parse(params.window_start) : Number.NaN;
  const explicitEnd = typeof params.window_end === "string" ? Date.parse(params.window_end) : Number.NaN;
  const parsedWindow = Number.isFinite(explicitStart) && Number.isFinite(explicitEnd)
    ? { startMs: explicitStart, endMs: explicitEnd, label: "explicit window params" }
    : parseQuestionTimeWindow(question, runtime.now());
  let appliedWindow: { startMs: number; endMs: number; label: string } | null = null;
  if (parsedWindow) {
    if (binding.factWindowField) {
      let missingTimestamp = 0;
      const facts = (scopedFactResult.facts as Array<Record<string, unknown>>).filter((fact) => {
        const raw = fact[binding.factWindowField as string];
        const at = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
        if (!Number.isFinite(at)) {
          missingTimestamp += 1;
          return false;
        }
        return at >= parsedWindow.startMs && at <= parsedWindow.endMs;
      });
      scopedFactResult = { ...scopedFactResult, facts } as FactBuildResult<unknown>;
      appliedWindow = parsedWindow;
      omissions.push(
        `Time window applied (${parsedWindow.label}): ${new Date(parsedWindow.startMs).toISOString().slice(0, 10)} to ${new Date(parsedWindow.endMs).toISOString().slice(0, 10)} on ${binding.factWindowField}` +
          (missingTimestamp > 0 ? `; ${missingTimestamp} row(s) without a ${binding.factWindowField} excluded.` : ".")
      );
    } else {
      omissions.push(
        `A time window ("${parsedWindow.label}") was asked, but this metric is point-in-time (current state) — the window does not apply.`
      );
    }
  } else if (binding.factWindowField) {
    omissions.push("No time window applied — the result spans all time. Ask with a window (e.g. \"this quarter\") or pass window_start/window_end to narrow.");
  }

  const metric = computeMetric(metricId, {
    facts: { [binding.factName]: scopedFactResult } as MetricComputeContext["facts"],
    nowMs: runtime.now(),
  });
  const completeness = read.status === "complete" ? metric.completeness : read.status;
  const plan: AnalysisPlan = {
    interpretedQuestion: question,
    requestedScope: requestedScope(scopeHeader),
    requiredMetrics: missingDomain.requiredMetrics,
    requiredFacts: missingDomain.requiredFacts,
    requiredEndpoints: missingDomain.requiredEndpoints,
    requiredProjectionProfile: missingDomain.requiredProjectionProfile,
    needsUserConfirmation: false,
  };
  void params;
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
        metric,
        read: {
          complete: read.complete,
          status: read.status,
          pages_read: read.pagesRead,
          rows_returned: read.rows.length,
        },
        omissions: [...omissions, ...metric.omissions],
      },
      analyses: [{ planned_metric: metricId, metric }],
      denials: [],
      next_steps: [],
    },
    nextCursor: null,
  };
}

// Broad diagnostics are legitimate only when the operator explicitly asks for them — never as a
// silent fallback for a specific question the planner failed to route.
function isBroadDiagnosticIntent(question: string, params: Record<string, unknown>): boolean {
  if (params.broad === true) return true;
  const recipesParam = params.recipes ?? params.recipe;
  if (typeof recipesParam === "string" && recipesParam.trim().toLowerCase() === "all") return true;
  const normalized = ` ${question.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()} `;
  return /\b(overall|health check|full diagnostic|full picture|everything|comprehensive|end to end|across all|across my)\b/.test(normalized);
}

function buildUnrecognizedPlan(question: string, scopeHeader: AnalysisContextHeader | null): AnalysisPlan {
  return {
    interpretedQuestion: question,
    requestedScope: requestedScope(scopeHeader),
    requiredMetrics: [],
    requiredFacts: [],
    requiredEndpoints: [],
    requiredProjectionProfile: "recruiter_default",
    needsUserConfirmation: false,
    stopReason: "missing_domain:unrecognized_question",
    missingFacts: [],
    missingEndpoints: [],
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
  denials: Array<Record<string, unknown>>
): Record<string, unknown> {
  const successful = analyses.filter((entry) => entry.status === "ok");
  return {
    mode: selected.length > 1 ? "composite_analysis" : "single_recipe_analysis",
    domain_recognized: true,
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
  | { ok: false; code: RecruiterDenialCode; message: string };

async function resolvePlannerScope(
  runtime: RecruiterToolRuntime,
  question: string,
  params: Record<string, unknown>,
  deadline: ToolDeadline | undefined
): Promise<PlannerScopeOutcome> {
  const scopeHandle = typeof params.scope_handle === "string" && params.scope_handle.trim().length > 0
    ? params.scope_handle.trim()
    : null;
  if (scopeHandle) {
    const scoped = await resolveAnalysisContext(runtime, explicitScopeParams(params), deadline);
    if (!scoped.ok) return { ok: false, code: scoped.code, message: scoped.message };
    return { ok: true, kind: "scoped", jobIds: readResolvedJobIds(scoped.params), header: scoped.header };
  }
  if (hasExactJobIds(params.job_ids)) {
    // Exact ids are not assumed safe because they are numeric; validate and scope
    // them through the same helper the analysis tools use before any recipe runs.
    const scoped = await resolveAnalysisContext(runtime, explicitScopeParams(params), deadline);
    if (!scoped.ok) return { ok: false, code: scoped.code, message: scoped.message };
    return { ok: true, kind: "scoped", jobIds: readResolvedJobIds(scoped.params), header: scoped.header };
  }

  // No explicit scope. Load the permission-scoped inventory once so we know the
  // actor's scope kind. A narrow recruiter's generic question stays bounded to
  // their own permitted jobs (today's behavior); an operator/all-access actor is
  // never allowed to silently run org-wide — their question goes through the
  // resolver, which forces confirmation. This determination must NOT rely on a
  // phrase heuristic, which would leak on role-less generic admin questions.
  const load = await loadJobInventory(runtime, deadline);
  if (!load.ok) return { ok: false, code: load.code, message: load.message };
  const isAdmin = load.inventory.scopeKind !== "jobs";

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

  if (!isAdmin && !ownerIntent && !hasResolverIntent(params) && !hasOrgBroadIntent(question)) {
    return { ok: true, kind: "scoped", header: null };
  }

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
        warnings: output.warnings,
      },
    };
  }
  return { ok: true, kind: "resolution_required", resolution: output };
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

function hasOrgBroadIntent(question: string): boolean {
  const q = ` ${question.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()} `;
  if (/ (org wide|orgwide|company wide|companywide|organization wide|every recruiter|all recruiters|across the (org|organization|company)) /.test(q)) {
    return true;
  }
  const broad = / (all|every|each|entire) (open |active |current )?(jobs?|reqs?|requisitions?|roles?|positions?|openings?|pipelines?) /;
  if (broad.test(q) && !/ (all|every|each|entire) (of )?(my|our) /.test(q)) {
    return true;
  }
  return false;
}

function hasExactJobIds(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return false;
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
