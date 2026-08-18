import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { EVIDENCE_TOOL_DEFINITIONS, evidenceToolParamsSchema, runEvidenceTool } from "./evidence.js";
import { INTERVIEW_FEEDBACK_DRAG_TOOL, runInterviewFeedbackDrag } from "./interview-feedback-drag.js";
import { PIPELINE_QUALITY_TOOL, runPipelineQuality } from "./pipeline-quality.js";
import { QUESTION_ANSWER_TOOL, runRecruitingQuestionAnswer } from "./question-answer.js";
import { SCORECARD_ACCOUNTABILITY_TOOL, runScorecardAccountability } from "./scorecard-accountability.js";
import { SOURCE_QUALITY_TOOL, runSourceQuality } from "./source-quality.js";
import { REJECTION_REASON_DRIFT_TOOL, runRejectionReasonDrift } from "./rejection-reason-drift.js";
import { STAGE_LATENCY_TOOL, runStageLatency } from "./stage-latency.js";
import { READ_MY_RESUME_TOOL, runReadMyResume } from "./resume.js";
import {
  CONFIRM_JOB_SCOPE_TOOL,
  GET_JOB_SCOPE_TOOL,
  GET_RECRUITING_CAPABILITIES_TOOL,
  RESOLVE_JOB_SCOPE_TOOL,
  runConfirmJobScope,
  runGetJobScope,
  runGetRecruitingCapabilities,
  runResolveJobScope,
} from "./job-scope/tools.js";
import { isToolEnabled, validateRecruiterToolConfig } from "../limits.js";
import { mcpTextResult, runActionTool, type RecruiterToolRuntime } from "../runtime.js";
import { ACTION_DEFINITIONS } from "../../../action-mcp/dist/index.js";
import type { RecruiterToolDefinition } from "../types.js";

export const RECRUITER_TOOL_DEFINITIONS: RecruiterToolDefinition[] = [
  ...EVIDENCE_TOOL_DEFINITIONS,
  RESOLVE_JOB_SCOPE_TOOL,
  CONFIRM_JOB_SCOPE_TOOL,
  GET_JOB_SCOPE_TOOL,
  GET_RECRUITING_CAPABILITIES_TOOL,
  SCORECARD_ACCOUNTABILITY_TOOL,
  INTERVIEW_FEEDBACK_DRAG_TOOL,
  STAGE_LATENCY_TOOL,
  PIPELINE_QUALITY_TOOL,
  SOURCE_QUALITY_TOOL,
  REJECTION_REASON_DRIFT_TOOL,
  QUESTION_ANSWER_TOOL,
  READ_MY_RESUME_TOOL,
];

/** Canonical curated model-facing catalog. The remaining 22 source readers stay hidden. */
export const PILOT_TOOL_NAMES = [
  "answer_my_recruiting_question",
  "analyze_scorecard_accountability",
  "analyze_interview_feedback_drag",
  "analyze_stage_latency",
  "analyze_pipeline_quality",
  "analyze_source_quality",
  "analyze_rejection_reason_drift",
  "resolve_job_scope",
  "confirm_job_scope",
  "get_job_scope",
  "get_recruiting_capabilities",
  "read_my_resume",
  "search_my_jobs",
  "get_my_job",
  "search_my_applications",
  "get_my_application",
  "search_my_interviews",
  "search_my_offers",
  "search_my_openings",
  "search_my_users",
  "search_my_job_owners",
  "search_my_job_interview_stages",
  "search_my_application_stages",
  "search_my_job_hiring_managers",
  "search_my_job_posts",
  "search_my_candidates",
  "get_my_candidate",
  "search_my_scorecards",
  "search_my_rejection_details",
  "search_my_rejection_reasons",
  "search_my_notes",
  "search_my_attachments",
  "search_my_interviewers",
  "search_my_scorecard_question_answers",
  "search_my_candidate_educations",
  "search_my_candidate_employments",
  "get_my_user",
  "search_my_sources",
  "search_my_referrers",
  "search_my_custom_field_options",
  "search_my_custom_fields",
  // Exposed because catalog tools already emit ids only these dictionaries can decode, and hiding
  // them left the model holding undecodable numbers: search_my_jobs returns department_id/office_ids,
  // search_my_openings returns close_reason_id, and resolve_job_scope accepts free-text department
  // and office NAMES the model otherwise has no way to enumerate. All three are global_reference
  // id->name dictionaries with zero PII, so exposing them widens no permission boundary.
  "search_my_departments",
  "search_my_offices",
  "search_my_close_reasons",
] as const;

const MODEL_TOOL_ORDER = new Map<string, number>(PILOT_TOOL_NAMES.map((name, index) => [name, index]));

/** Match the order emitted by registerRecruiterTools: curated tools first, then source order. */
export function compareRecruiterToolNames(left: string, right: string): number {
  const leftModelIndex = MODEL_TOOL_ORDER.get(left);
  const rightModelIndex = MODEL_TOOL_ORDER.get(right);
  if (leftModelIndex !== undefined && rightModelIndex !== undefined) return leftModelIndex - rightModelIndex;
  if (leftModelIndex !== undefined) return -1;
  if (rightModelIndex !== undefined) return 1;
  return 0;
}

export interface McpToolRegistrar {
  tool(
    name: string,
    description: string,
    paramsSchema: Record<string, z.ZodTypeAny>,
    annotations: ToolAnnotations,
    handler: (params: Record<string, unknown>) => Promise<{ content: { type: "text"; text: string }[] }>
  ): unknown;
}

interface PendingToolRegistration {
  name: string;
  description: string;
  paramsSchema: Record<string, z.ZodTypeAny>;
  annotations: ToolAnnotations;
  handler: (params: Record<string, unknown>) => Promise<{ content: { type: "text"; text: string }[] }>;
  originalIndex: number;
}

const evidencePackSchema = {
  evidence_pack: z.boolean().optional().describe("Include a capped metadata-only evidence pack of scoped record references."),
  evidence_pack_limit: z.number().int().positive().optional().describe("Maximum evidence references returned in evidence_pack, capped by the runtime."),
};

const scopeHandleSchema = {
  scope_handle: z.string().optional().describe("Signed scope_handle from resolve_job_scope/confirm_job_scope. Preferred over job_ids; if both are present, scope_handle wins. Free-text job/role inputs are rejected here — resolve scope first."),
};

const jobScopeFiltersSchema = z
  .object({
    status: z.array(z.enum(["open", "closed", "draft", "all"])).optional().describe("Job statuses to include; defaults to open only. Pass ['all'] to span open/closed/draft (e.g. a role family across statuses)."),
    departments: z.array(z.string()).optional().describe("Restrict to these department names."),
    offices: z.array(z.string()).optional().describe("Restrict to these office names."),
    locations: z.array(z.string()).optional().describe("Restrict to these office/location names (e.g. 'Brazil')."),
    recruiter_user_ids: z.array(z.number().int().positive()).optional().describe("Restrict to requisitions assigned to these Greenhouse users as recruiter or sourcer (via /v3/job_owners). Coordinator rows do not qualify. Always bounded to your permitted jobs — never widens scope."),
    hiring_manager_user_ids: z.array(z.number().int().positive()).optional().describe("Restrict to requisitions these Greenhouse user ids are HIRING MANAGERS on (via /v3/job_hiring_managers). Always bounded to your permitted jobs."),
    opened_after: z.string().optional().describe("Only requisitions opened on/after this ISO date (recency)."),
    opened_before: z.string().optional().describe("Only requisitions opened on/before this ISO date (recency)."),
    include_confidential: z.boolean().optional(),
    my_jobs_only: z.boolean().optional().describe("'My reqs' — open, permitted requisitions where YOU are assigned as recruiter or sourcer in /v3/job_owners. Coordinator and hiring-manager assignments do not qualify; responsible is ignored. Never widens."),
  })
  .optional();

const resolveJobScopeSchema = {
  query: z.string().optional().describe("Natural-language job or role reference to resolve."),
  greenhouse_job_ids: z.array(z.number().int().positive()).optional().describe("Exact Greenhouse job ids to validate and scope."),
  requisition_ids: z.array(z.string()).optional().describe("Requisition ids to resolve; duplicates return ambiguity."),
  filters: jobScopeFiltersSchema,
  aliases: z.array(z.string()).optional().describe("Acronyms/aliases to expand (e.g. FDE)."),
  role_families: z.array(z.string()).optional().describe("Role-family phrases to expand."),
  default_status: z.enum(["open_only", "open_and_draft", "all"]).optional(),
  max_candidates: z.number().int().positive().optional(),
  allow_auto_confirm: z.boolean().optional(),
  purpose: z
    .enum([
      "scorecard_accountability", "interview_feedback_drag", "stage_latency", "pipeline_quality",
      "source_quality", "rejection_reason_drift", "general_question", "comparison", "inventory",
    ])
    .optional(),
};

const confirmJobScopeSchema = {
  resolution_id: z.string().optional().describe("resolution_id from resolve_job_scope (for correlation)."),
  confirmation_token: z.string().describe("confirmation_token returned by resolve_job_scope."),
  decision: z.enum(["confirm_all", "confirm_selected", "reject", "revise"]).describe("Confirmation decision."),
  selected_job_ids: z.array(z.number().int().positive()).optional().describe("Subset of the proposed jobs when decision=confirm_selected; can only narrow."),
  revised_query: z.string().optional(),
  acknowledgements: z
    .object({
      acknowledge_partial_inventory: z.boolean().optional(),
      acknowledge_closed_jobs: z.boolean().optional(),
      acknowledge_confidential_jobs: z.boolean().optional(),
      acknowledge_broad_admin_scope: z.boolean().optional(),
      acknowledge_stale_index: z.boolean().optional(),
    })
    .optional(),
};

const getJobScopeSchema = {
  scope_handle: z.string().describe("scope_handle to inspect."),
};

export const RECRUITER_READ_ONLY_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * Preview reads and signs; it never mutates, so it is genuinely read-only and clients may group it
 * with the reads. That is not a claim that approving its output is harmless — it is a claim about
 * this call.
 */
export const RECRUITER_ACTION_PREVIEW_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * Apply mutates Greenhouse. `destructiveHint` is honest rather than optimistic: a stage move can
 * fire ATS automation including candidate-facing email, and Greenhouse exposes `unreject` as its one
 * true reversal primitive — everything else is compensable only by a fresh forward call, or not at
 * all. `idempotentHint` is true because replay is real: a repeated apply under the same intent
 * returns the recorded result without a second mutation.
 *
 * These are advisory. The MCP spec says clients MUST treat annotations as untrusted, and Cursor
 * ignores them entirely, so nothing here is a control — the controls are the intent signature, the
 * entitlement, and the fresh preflight.
 */
export const RECRUITER_ACTION_APPLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * The action package declares each tool's input as a whole `z.object(...)`; this registrar takes the
 * raw shape. Unwrapping rather than re-declaring is deliberate — a hand-written shape here would be a
 * second copy of eleven schemas with nothing to notice when the two drift, which is the same defect
 * `action-tools.ts` refuses for the tool NAMES.
 */
function actionParamsShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
  const shape = (schema as { shape?: unknown }).shape;
  if (shape && typeof shape === "object") return shape as Record<string, z.ZodTypeAny>;
  throw new Error("Action tool input schema is not an object schema; its parameters cannot be published.");
}

export function registerRecruiterTools(server: McpToolRegistrar, runtime: RecruiterToolRuntime): string[] {
  validateRecruiterToolConfig(runtime.toolConfig, RECRUITER_TOOL_DEFINITIONS.map((tool) => tool.name));
  const pending: PendingToolRegistration[] = [];
  const catalogServer: McpToolRegistrar = {
    tool(name, description, paramsSchema, annotations, handler) {
      pending.push({ name, description, paramsSchema, annotations, handler, originalIndex: pending.length });
    },
  };
  if (isToolEnabled(runtime.toolConfig, runtime.session.surface, RESOLVE_JOB_SCOPE_TOOL.name, "analysis")) {
    catalogServer.tool(
      RESOLVE_JOB_SCOPE_TOOL.name,
      RESOLVE_JOB_SCOPE_TOOL.description,
      resolveJobScopeSchema,
      RECRUITER_READ_ONLY_TOOL_ANNOTATIONS,
      async (params) => mcpTextResult(await runResolveJobScope(runtime, params))
    );
  }
  if (isToolEnabled(runtime.toolConfig, runtime.session.surface, CONFIRM_JOB_SCOPE_TOOL.name, "analysis")) {
    catalogServer.tool(
      CONFIRM_JOB_SCOPE_TOOL.name,
      CONFIRM_JOB_SCOPE_TOOL.description,
      confirmJobScopeSchema,
      RECRUITER_READ_ONLY_TOOL_ANNOTATIONS,
      async (params) => mcpTextResult(await runConfirmJobScope(runtime, params))
    );
  }
  if (isToolEnabled(runtime.toolConfig, runtime.session.surface, GET_JOB_SCOPE_TOOL.name, "analysis")) {
    catalogServer.tool(
      GET_JOB_SCOPE_TOOL.name,
      GET_JOB_SCOPE_TOOL.description,
      getJobScopeSchema,
      RECRUITER_READ_ONLY_TOOL_ANNOTATIONS,
      async (params) => mcpTextResult(await runGetJobScope(runtime, params))
    );
  }
  if (isToolEnabled(runtime.toolConfig, runtime.session.surface, GET_RECRUITING_CAPABILITIES_TOOL.name, "analysis")) {
    catalogServer.tool(
      GET_RECRUITING_CAPABILITIES_TOOL.name,
      GET_RECRUITING_CAPABILITIES_TOOL.description,
      {},
      RECRUITER_READ_ONLY_TOOL_ANNOTATIONS,
      async (params) => mcpTextResult(await runGetRecruitingCapabilities(runtime, params))
    );
  }

  if (isToolEnabled(runtime.toolConfig, runtime.session.surface, SCORECARD_ACCOUNTABILITY_TOOL.name, "analysis")) {
    catalogServer.tool(
      SCORECARD_ACCOUNTABILITY_TOOL.name,
      SCORECARD_ACCOUNTABILITY_TOOL.description,
      {
        window_start: z.string().optional().describe("Inclusive ISO timestamp/date for the analysis window start. Defaults to 30 days before window_end."),
        window_end: z.string().optional().describe("Inclusive ISO timestamp/date for the analysis window end. Defaults to now."),
        job_ids: z.string().optional().describe("Optional comma-separated job ids; still scoped by Greenhouse permissions."),
        max_rankings: z.number().int().positive().optional().describe("Maximum ranked people to return, capped by runtime limits."),
        per_page: z.number().int().positive().optional().describe("Scorecard page size, capped by runtime limits."),
        ...scopeHandleSchema,
        ...evidencePackSchema,
      },
      RECRUITER_READ_ONLY_TOOL_ANNOTATIONS,
      async (params) => mcpTextResult(await runScorecardAccountability(runtime, params))
    );
  }
  if (isToolEnabled(runtime.toolConfig, runtime.session.surface, INTERVIEW_FEEDBACK_DRAG_TOOL.name, "analysis")) {
    catalogServer.tool(
      INTERVIEW_FEEDBACK_DRAG_TOOL.name,
      INTERVIEW_FEEDBACK_DRAG_TOOL.description,
      {
        window_start: z.string().optional().describe("Inclusive ISO timestamp/date for the analysis window start. Defaults to 30 days before window_end."),
        window_end: z.string().optional().describe("Inclusive ISO timestamp/date for the analysis window end. Defaults to now."),
        job_ids: z.string().optional().describe("Optional comma-separated job ids; still scoped by Greenhouse permissions."),
        due_days: z.number().nonnegative().optional().describe("Feedback SLA in days. Defaults to 2."),
        max_rankings: z.number().int().positive().optional().describe("Maximum ranked people to return, capped by runtime limits."),
        per_page: z.number().int().positive().optional().describe("Scorecard page size, capped by runtime limits."),
        ...scopeHandleSchema,
        ...evidencePackSchema,
      },
      RECRUITER_READ_ONLY_TOOL_ANNOTATIONS,
      async (params) => mcpTextResult(await runInterviewFeedbackDrag(runtime, params))
    );
  }
  if (isToolEnabled(runtime.toolConfig, runtime.session.surface, STAGE_LATENCY_TOOL.name, "analysis")) {
    catalogServer.tool(
      STAGE_LATENCY_TOOL.name,
      STAGE_LATENCY_TOOL.description,
      {
        window_start: z.string().optional().describe("Inclusive ISO timestamp/date for current-stage entries to include. Defaults to 90 days before window_end, capped by runtime limits."),
        window_end: z.string().optional().describe("Inclusive ISO timestamp/date for the analysis as-of time. Defaults to now."),
        job_ids: z.string().optional().describe("Optional comma-separated job ids; still scoped by Greenhouse permissions."),
        status: z.string().optional().describe("Optional application status. Defaults to active."),
        min_age_days: z.number().nonnegative().optional().describe("Dwell threshold counted as aging. Defaults to 7 days."),
        max_rankings: z.number().int().positive().optional().describe("Maximum ranked stages/jobs to return, capped by runtime limits."),
        per_page: z.number().int().positive().optional().describe("Application page size, capped by runtime limits."),
        include_terminal: z.boolean().optional().describe("Include rejected/hired/converted applications when true. Defaults to false."),
        ...scopeHandleSchema,
        ...evidencePackSchema,
      },
      RECRUITER_READ_ONLY_TOOL_ANNOTATIONS,
      async (params) => mcpTextResult(await runStageLatency(runtime, params))
    );
  }
  if (isToolEnabled(runtime.toolConfig, runtime.session.surface, PIPELINE_QUALITY_TOOL.name, "analysis")) {
    catalogServer.tool(
      PIPELINE_QUALITY_TOOL.name,
      PIPELINE_QUALITY_TOOL.description,
      {
        window_start: z.string().optional().describe("Inclusive ISO timestamp/date for freshness lookback. Defaults to 90 days before window_end, capped by runtime limits."),
        window_end: z.string().optional().describe("Snapshot as-of timestamp/date. Defaults to now."),
        job_ids: z.string().optional().describe("Optional comma-separated job ids; still scoped by Greenhouse permissions."),
        status: z.string().optional().describe("Optional application status filter."),
        stale_days: z.number().nonnegative().optional().describe("Last-activity age counted as stale for active applications. Defaults to 14 days."),
        max_rankings: z.number().int().positive().optional().describe("Maximum ranked stages/jobs to return, capped by runtime limits."),
        per_page: z.number().int().positive().optional().describe("Application page size, capped by runtime limits."),
        ...scopeHandleSchema,
        ...evidencePackSchema,
      },
      RECRUITER_READ_ONLY_TOOL_ANNOTATIONS,
      async (params) => mcpTextResult(await runPipelineQuality(runtime, params))
    );
  }
  if (isToolEnabled(runtime.toolConfig, runtime.session.surface, SOURCE_QUALITY_TOOL.name, "analysis")) {
    catalogServer.tool(
      SOURCE_QUALITY_TOOL.name,
      SOURCE_QUALITY_TOOL.description,
      {
        window_start: z.string().optional().describe("Inclusive ISO timestamp/date for application attribution timestamps. Defaults to 90 days before window_end, capped by runtime limits."),
        window_end: z.string().optional().describe("Inclusive ISO timestamp/date for application attribution timestamps. Defaults to now."),
        job_ids: z.string().optional().describe("Optional comma-separated job ids; still scoped by Greenhouse permissions."),
        source_ids: z.string().optional().describe("Optional comma-separated Greenhouse source ids."),
        referrer_ids: z.string().optional().describe("Optional comma-separated Greenhouse referrer ids."),
        status: z.string().optional().describe("Optional application status filter."),
        stale_days: z.number().nonnegative().optional().describe("Last-activity age counted as stale for active applications. Defaults to 14 days."),
        max_rankings: z.number().int().positive().optional().describe("Maximum ranked sources/referrers to return, capped by runtime limits."),
        per_page: z.number().int().positive().optional().describe("Application page size, capped by runtime limits."),
        ...scopeHandleSchema,
        ...evidencePackSchema,
      },
      RECRUITER_READ_ONLY_TOOL_ANNOTATIONS,
      async (params) => mcpTextResult(await runSourceQuality(runtime, params))
    );
  }
  if (isToolEnabled(runtime.toolConfig, runtime.session.surface, REJECTION_REASON_DRIFT_TOOL.name, "analysis")) {
    catalogServer.tool(
      REJECTION_REASON_DRIFT_TOOL.name,
      REJECTION_REASON_DRIFT_TOOL.description,
      {
        window_start: z.string().optional().describe("Inclusive ISO timestamp/date for rejection created_at. Defaults to 90 days before window_end, capped by runtime limits."),
        window_end: z.string().optional().describe("Inclusive ISO timestamp/date for rejection created_at. Defaults to now."),
        job_ids: z.string().optional().describe("Optional comma-separated job ids; still scoped by Greenhouse permissions. Bridged to application_ids internally (/v3/rejection_details has no job_ids filter)."),
        max_rankings: z.number().int().positive().optional().describe("Maximum ranked rejection reasons to return, capped by runtime limits."),
        per_page: z.number().int().positive().optional().describe("Rejection-detail page size, capped by runtime limits."),
        ...scopeHandleSchema,
        ...evidencePackSchema,
      },
      RECRUITER_READ_ONLY_TOOL_ANNOTATIONS,
      async (params) => mcpTextResult(await runRejectionReasonDrift(runtime, params))
    );
  }
  if (isToolEnabled(runtime.toolConfig, runtime.session.surface, QUESTION_ANSWER_TOOL.name, "analysis")) {
    catalogServer.tool(
      QUESTION_ANSWER_TOOL.name,
      QUESTION_ANSWER_TOOL.description,
      {
        question: z.string().min(1).describe("Natural-language recruiting question to answer using approved scoped analysis recipes."),
        query: z.string().optional().describe("Optional structured job/role intent extracted from the question; resolved server-side before analysis."),
        aliases: z.array(z.string()).optional().describe("Optional acronyms/aliases (e.g. FDE) to resolve before analysis."),
        role_families: z.array(z.string()).optional().describe("Optional role-family phrases to resolve before analysis."),
        requisition_ids: z.array(z.string()).optional().describe("Optional requisition ids to resolve before analysis."),
        greenhouse_job_ids: z.array(z.number().int().positive()).optional().describe("Optional exact Greenhouse job ids to validate and resolve before analysis."),
        recipes: z.string().optional().describe("Optional comma-separated approved recipe aliases: scorecard_accountability, interview_feedback_drag, stage_latency, pipeline_quality, source_quality."),
        max_recipes: z.number().int().positive().optional().describe("Maximum approved recipes to run, capped by the planner."),
        window_start: z.string().optional().describe("Inclusive ISO timestamp/date for recipe windows."),
        window_end: z.string().optional().describe("Inclusive ISO timestamp/date for recipe windows."),
        job_ids: z.string().optional().describe("Optional comma-separated job ids; still scoped by Greenhouse permissions."),
        source_ids: z.string().optional().describe("Optional comma-separated Greenhouse source ids for source-quality analysis."),
        referrer_ids: z.string().optional().describe("Optional comma-separated Greenhouse referrer ids for source-quality analysis."),
        status: z.string().optional().describe("Optional application status filter where supported by selected recipes."),
        due_days: z.number().nonnegative().optional().describe("Feedback SLA in days for interview-feedback analysis."),
        min_age_days: z.number().nonnegative().optional().describe("Dwell threshold for stage-latency analysis."),
        stale_days: z.number().nonnegative().optional().describe("Last-activity age counted as stale for pipeline/source analyses."),
        max_rankings: z.number().int().positive().optional().describe("Maximum rankings per selected recipe, capped by runtime limits."),
        per_page: z.number().int().positive().optional().describe("Underlying page size for selected recipes, capped by runtime limits."),
        ...scopeHandleSchema,
        ...evidencePackSchema,
      },
      RECRUITER_READ_ONLY_TOOL_ANNOTATIONS,
      async (params) => mcpTextResult(await runRecruitingQuestionAnswer(runtime, params))
    );
  }
  if (isToolEnabled(runtime.toolConfig, runtime.session.surface, READ_MY_RESUME_TOOL.name, "evidence")) {
    catalogServer.tool(
      READ_MY_RESUME_TOOL.name,
      READ_MY_RESUME_TOOL.description,
      {
        attachment_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe(
          "Exact resume attachment id returned by search_my_attachments. Required so the selected file/version is explicit."
        ),
      },
      RECRUITER_READ_ONLY_TOOL_ANNOTATIONS,
      async (params) => mcpTextResult(await runReadMyResume(runtime, params))
    );
  }
  // Buffer raw evidence tools with the analytical handlers, then emit the exact curated catalog
  // order below. Any non-curated source readers remain after the model-facing set in local/all-tool
  // runtimes; production's allowlist excludes them entirely.
  for (const definition of EVIDENCE_TOOL_DEFINITIONS) {
    if (!isToolEnabled(runtime.toolConfig, runtime.session.surface, definition.name, definition.kind)) {
      continue;
    }
    const paramsSchema = definition.paramsSchema ?? evidenceToolParamsSchema(definition.name);
    catalogServer.tool(definition.name, definition.description, paramsSchema, RECRUITER_READ_ONLY_TOOL_ANNOTATIONS, async (params) => {
      return mcpTextResult(await runEvidenceTool(runtime, definition.name, params));
    });
  }

  // The write plane, LAST and only for a session that holds an entitlement. Two properties matter
  // and both come free from where this sits: an unentitled session never reaches this block, so its
  // catalog is byte-identical to before; and every action name is outside MODEL_TOOL_ORDER, so the
  // comparator below leaves the curated 44 exactly where they are and appends these after them.
  //
  // `isToolEnabled` still runs on each one — a grant only admits the name past the allowlist, it does
  // not bypass the denylist, the surface gate, or the kind gate.
  if (runtime.actionPlane) {
    const service = runtime.actionPlane.buildService(runtime);
    for (const definition of ACTION_DEFINITIONS) {
      for (const [tool, title, schema, annotations, run] of [
        [
          definition.previewTool,
          definition.previewDescription,
          definition.catalogPreviewSchema ?? definition.previewSchema,
          RECRUITER_ACTION_PREVIEW_ANNOTATIONS,
          (params: Record<string, unknown>) => service.preview(definition.kind, params),
        ],
        [
          definition.applyTool,
          definition.applyDescription,
          definition.catalogApplySchema ?? definition.applySchema,
          RECRUITER_ACTION_APPLY_ANNOTATIONS,
          (params: Record<string, unknown>) => service.apply(definition.kind, params),
        ],
      ] as const) {
        if (!isToolEnabled(runtime.toolConfig, runtime.session.surface, tool, "analysis")) continue;
        catalogServer.tool(tool, title, actionParamsShape(schema), annotations, async (params) =>
          mcpTextResult(await runActionTool(runtime, tool, () => run(params)))
        );
      }
    }
  }

  pending.sort((left, right) => {
    return compareRecruiterToolNames(left.name, right.name) || left.originalIndex - right.originalIndex;
  });
  for (const registration of pending) {
    server.tool(
      registration.name,
      registration.description,
      registration.paramsSchema,
      registration.annotations,
      registration.handler
    );
  }
  return pending.map((registration) => registration.name);
}
