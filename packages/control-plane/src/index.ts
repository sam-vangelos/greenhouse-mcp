#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { configure, apiGet, type ApiResponse } from "./client.js";
import { listEndpoint } from "./list-helpers.js";
import {
  createToolGateConfig,
  emitTier3ErrorReadAudit,
  emitTier3SuccessReadAudit,
  isToolDisabled,
  shouldRegisterTier3Tool,
  wrapTier3Handler,
} from "./tool-gates.js";
import {
  READ_AUDIT_FAILURE_MESSAGE,
  resultSizeClassFromData,
} from "./read-audit.js";
import { projectNotesArray } from "./projection-notes.js";
import { projectScorecardsArray } from "./projection-scorecards.js";
import { projectApplicationsArray } from "./projection-applications.js";
import { projectCandidatesArray } from "./projection-candidates.js";
import { attachCandidateApplicationsForStageSnapshot } from "./candidate-stage-snapshot.js";
import { isActiveApplicationStatus } from "./projection-shared.js";
import { projectRejectionDetailsArray } from "./projection-rejection-details.js";
import { projectOffersArray } from "./projection-offers.js";
import { buildOfferLetterContext } from "./offer-letter-context.js";
import { GREENHOUSE_RECIPES, RECIPES_NOTE } from "./control-plane.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const clientId = process.env.GREENHOUSE_CLIENT_ID;
const clientSecret = process.env.GREENHOUSE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    "Error: Add your Greenhouse connection details in the MCP client setup before starting Greenhouse Ops Control Plane."
  );
  process.exit(1);
}

configure(clientId, clientSecret);

const RETIRED_CAPABILITIES = {
  candidateWrite: false,
  applicationWrite: false,
  openingWrite: false,
  offerDraftWrite: false,
  noteWrite: false,
  jobNoteWrite: false,
  candidateTagWrite: false,
  customFieldSchemaWrite: false,
  departmentWrite: false,
  officeWrite: false,
  jobPostLocationWrite: false,
  sourceCatalogWrite: false,
  workflowTopologyWrite: false,
  scorecardPackWrite: false,
  configurationSnapshotRead: false,
  repairPreview: false,
  repairPlanWrite: false,
};

const CONTROL_PLANE_STATUS = {
  access: "read_only",
  action_service: "greenhouse-action-mcp",
  adapters: {
    harvest: {
      name: "HarvestAdapter",
      kind: "harvest",
      configured: true,
      enabled: true,
      capabilities: RETIRED_CAPABILITIES,
    },
    admin: {
      name: "AdminAdapter",
      kind: "admin",
      configured: false,
      enabled: false,
      mode: "retired",
      capabilities: RETIRED_CAPABILITIES,
    },
  },
  planes: Object.fromEntries(
    ["record", "offer", "taxonomy", "workflow", "repair"].map((name) => [
      name,
      { enabled: false, writable: false, families: [] },
    ])
  ),
  recipes: GREENHOUSE_RECIPES,
  recipes_note: RECIPES_NOTE,
};

const TOOL_GATE_CONFIG = createToolGateConfig();

if (TOOL_GATE_CONFIG.disabledTools.size > 0) {
  console.error(
    `[greenhouse-mcp] kill-switch: ${TOOL_GATE_CONFIG.disabledTools.size} tool(s) disabled via GREENHOUSE_DISABLE_TOOLS: ${Array.from(
      TOOL_GATE_CONFIG.disabledTools
    ).join(", ")}`
  );
}

if (TOOL_GATE_CONFIG.tier3ReadsAvailable) {
  if (TOOL_GATE_CONFIG.tier3ActorIds.size > 0) {
    console.error(
      `[greenhouse-mcp] Expanded record tools enabled for approved Greenhouse user IDs: ${Array.from(
        TOOL_GATE_CONFIG.tier3ActorIds
      ).join(", ")}`
    );
  } else {
    console.error("[greenhouse-mcp] Expanded record tools enabled.");
  }
} else if (TOOL_GATE_CONFIG.tier3ReadsEnabled) {
  console.error(
    "[greenhouse-mcp] Expanded record tools are unavailable for this setup."
  );
} else {
  console.error(
    "[greenhouse-mcp] Expanded record tools were explicitly turned off for this setup."
  );
}

console.error("[greenhouse-mcp] Server starting with v3 OAuth2");

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "greenhouse-ops-control-plane",
  version: "1.0.0",
});

// Tool-registration wrapper. Honors the GREENHOUSE_DISABLE_TOOLS kill-switch
// at startup so an operator can drop any tool by name without a code deploy.
// All tool registrations in this file go through this helper; the Tier 3 gate
// is layered on top of it at the four affected call sites.
type ServerTool = typeof server.tool;

const registerTool: ServerTool = ((...args: Parameters<ServerTool>) => {
  const toolName = args[0] as string;
  if (isToolDisabled(TOOL_GATE_CONFIG, toolName)) {
    console.error(
      `[greenhouse-mcp] kill-switch: skipping registration of ${toolName} (listed in GREENHOUSE_DISABLE_TOOLS)`
    );
    return undefined as unknown as ReturnType<ServerTool>;
  }
  return (server.tool as (...a: Parameters<ServerTool>) => ReturnType<ServerTool>)(...args);
}) as ServerTool;

// ---------------------------------------------------------------------------
// Helper: format API response as MCP tool result
// ---------------------------------------------------------------------------

function formatResult<T>(response: ApiResponse<T>): {
  content: { type: "text"; text: string }[];
} {
  const result: Record<string, unknown> = { data: response.data };
  if (response.nextCursor) {
    result.next_cursor = response.nextCursor;
    result._pagination_note =
      "Pass next_cursor value as the 'cursor' parameter to fetch the next page.";
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readNumberField(
  source: Record<string, unknown>,
  key: string
): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringField(
  source: Record<string, unknown>,
  key: string
): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

// ---------------------------------------------------------------------------
// Common parameter schemas
// ---------------------------------------------------------------------------

const paginationParams = {
  per_page: z
    .number()
    .min(1)
    .max(500)
    .optional()
    .describe("Results per page (1-500, default 100)"),
  cursor: z
    .string()
    .optional()
    .describe(
      "Pagination cursor from a previous response. When provided, must be the only filter parameter."
    ),
};

const dateFilterParams = {
  created_at: z
    .string()
    .optional()
    .describe(
      "Filter by creation date. Format: operator|ISO8601 (e.g. gte|2024-01-01T00:00:00Z). Operators: gte, lte, gt, lt"
    ),
  updated_at: z
    .string()
    .optional()
    .describe(
      "Filter by update date. Format: operator|ISO8601 (e.g. gte|2024-01-01T00:00:00Z). Operators: gte, lte, gt, lt"
    ),
};

const readReasonSchema = z
  .string()
  .min(12)
  .max(500)
  .optional()
  .describe("Required when detail_profile requests a broadened response shape.");

// Required actor parameter for every Tier 3 read. This is a GATE field, not a Harvest field:
// wrapTier3Handler strips it from the params object before the inner handler
// forwards anything to listEndpoint.
const tier3ActorSchema = z
  .number()
  .int()
  .positive()
  .describe(
    "Greenhouse user ID of the human approving this expanded data request."
  );

function assertDetailProfileReason(
  detailProfile: string | undefined,
  defaultProfile: string,
  reason: string | undefined
): void {
  if ((detailProfile ?? defaultProfile) !== defaultProfile && !reason) {
    throw new Error(
      `detail_profile=${detailProfile} requires a reason of at least 12 characters.`
    );
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

registerTool(
  "get_control_plane_capabilities",
  "Show the Greenhouse recruiting-ops read surface and its pre-designed analysis recipes.",
  {},
  async () => {
    return formatResult({
      data: CONTROL_PLANE_STATUS,
      nextCursor: null,
    });
  }
);

// 1. Applications — Tier 2, projected per doctrine §3 (list_applications
// row). Slice 3 of P2.2: projection active; tool remains ungated and
// audit-silent per doctrine §7 Tier-2-silent canonical rule — see
// docs/greenhouse-mcp-projection-slice-3-spec.md §§5.3–5.5.
registerTool(
  "list_applications",
  "List applications in Greenhouse. Returns operational application fields for pipeline work: id, candidate_id, job_id, stage_id, stage_name, status, and last_activity_at. Status can be active, rejected, hired, or converted.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated application IDs to filter by"),
    candidate_ids: z
      .string()
      .optional()
      .describe("Comma-separated candidate IDs to filter by"),
    job_ids: z
      .string()
      .optional()
      .describe("Comma-separated job IDs to filter by"),
    prospective_job_ids: z
      .string()
      .optional()
      .describe("Comma-separated prospective job IDs to filter by"),
    job_post_ids: z
      .string()
      .optional()
      .describe("Comma-separated job post IDs to filter by"),
    source_ids: z
      .string()
      .optional()
      .describe("Comma-separated source IDs to filter by"),
    referrer_ids: z
      .string()
      .optional()
      .describe("Comma-separated referrer IDs to filter by"),
    stage_ids: z
      .string()
      .optional()
      .describe("Comma-separated interview stage IDs to filter by"),
    stage_name: z
      .string()
      .optional()
      .describe("Filter applications by current stage name (exact match)"),
    status: z
      .enum(["active", "rejected", "hired", "converted"])
      .optional()
      .describe("Filter by application status"),
    prospect: z
      .boolean()
      .optional()
      .describe("Filter by prospect status (true for prospects, false for applicants)"),
    last_activity_at: z
      .string()
      .optional()
      .describe(
        "Filter by last activity date. Format: operator|ISO8601 (e.g. gte|2024-01-01T00:00:00Z). Operators: gte, lte, gt, lt"
      ),
    custom_field_option_id: z
      .number()
      .optional()
      .describe("Filter by custom field option ID"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/applications", rest, cursor);
    const projectedData = projectApplicationsArray(response.data);
    return formatResult({ ...response, data: projectedData });
  }
);

registerTool(
  "get_application",
  "Get a single application by ID. Returns full application details including status, candidate, job, stage, and answers.",
  {
    id: z.number().describe("The application ID"),
  },
  async ({ id }) => {
    const response = await apiGet(`/applications/${id}`);
    return formatResult(response);
  }
);

// 2. Applied Candidate Tags
registerTool(
  "list_applied_candidate_tags",
  "List applied candidate tags in Greenhouse. Shows which tags have been applied to which candidates.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated applied candidate tag IDs to filter by"),
    candidate_ids: z
      .string()
      .optional()
      .describe("Comma-separated candidate IDs to filter by"),
    candidate_tag_ids: z
      .string()
      .optional()
      .describe("Comma-separated candidate tag IDs to filter by"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/applied_candidate_tags", rest, cursor);
    return formatResult(response);
  }
);

// 2. Application Stages
registerTool(
  "list_application_stages",
  "List application stages from Greenhouse. Shows which interview stage each application is in, when they entered/exited, and whether it's their current stage.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated application stage IDs to filter by"),
    application_ids: z
      .string()
      .optional()
      .describe("Comma-separated application IDs to filter by"),
    job_interview_stage_ids: z
      .string()
      .optional()
      .describe("Comma-separated job interview stage IDs to filter by"),
    current: z
      .boolean()
      .optional()
      .describe("Filter to only current (true) or non-current (false) stages"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/application_stages", rest, cursor);
    return formatResult(response);
  }
);

// 3. Attachments — REMOVED per docs/greenhouse-mcp-output-doctrine.md §4
// (Tier 4: resume, cover letter, offer packet, signed URLs). No lib/ consumer.
// Reintroduction requires the full procedure in §9 of the doctrine.

// 4. Candidate Tags
registerTool(
  "list_candidate_tags",
  "List all candidate tags defined in Greenhouse. Tags are labels that can be applied to candidates for categorization.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated candidate tag IDs to filter by"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/candidate_tags", rest, cursor);
    return formatResult(response);
  }
);

// 5. Candidates — Tier 2, projected per doctrine §3 (list_candidates
// row). Slice 4 of P2.2: projection active; tool remains ungated and
// audit-silent per doctrine §7 Tier-2-silent canonical rule — see
// docs/greenhouse-mcp-projection-slice-4-spec.md §§5.3–5.5.
registerTool(
  "list_candidates",
  "List candidates in Greenhouse. By default returns a projected minimal view: per-candidate metadata (id, last_activity_at, tag_names, private) plus stage_snapshot — the candidate's pipeline state, one entry per application with its job_id, current stage_id/stage_name, and status (fetched and joined from the candidate's applications). detail_profile=contact broadens the projection to include candidate name, primary contact fields, LinkedIn URL, location, and attachment metadata; signed attachment URLs remain opt-in via include_attachment_urls and require a reason.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated candidate IDs to filter by"),
    last_activity_at: z
      .string()
      .optional()
      .describe(
        "Filter by last activity date. Format: operator|ISO8601 (e.g. gte|2024-01-01T00:00:00Z). Operators: gte, lte, gt, lt"
      ),
    custom_field_option_id: z
      .number()
      .optional()
      .describe("Filter by custom field option ID"),
    private: z.boolean().optional().describe("Filter by private/confidential status"),
    email: z.string().optional().describe("Filter by email address"),
    tag: z.string().optional().describe("Filter by candidate tag name"),
    detail_profile: z
      .enum(["minimal", "contact"])
      .optional()
      .describe("Projection profile. Default is minimal; contact broadens the candidate contact surface and requires a reason."),
    include_attachment_urls: z
      .boolean()
      .optional()
      .describe("Only valid with detail_profile=contact. When true, includes signed attachment URLs."),
    reason: readReasonSchema,
  },
  async (params) => {
    const {
      cursor,
      detail_profile,
      include_attachment_urls,
      reason,
      ...rest
    } = params;
    assertDetailProfileReason(detail_profile, "minimal", reason);
    if (include_attachment_urls && detail_profile !== "contact") {
      throw new Error(
        "include_attachment_urls is only valid when detail_profile=contact."
      );
    }
    const response = await listEndpoint("/candidates", rest, cursor);
    // Inject each candidate's applications (v3 doesn't embed them) so the projection
    // can derive stage_snapshot pipeline state. Best-effort; never blocks the list.
    const candidatesWithApplications = await attachCandidateApplicationsForStageSnapshot(response.data);
    const projectedData =
      detail_profile === "contact"
        ? projectCandidatesArray(candidatesWithApplications, {
            detailProfile: "contact",
            includeAttachmentUrls: include_attachment_urls === true,
          })
        : projectCandidatesArray(candidatesWithApplications);
    return formatResult({ ...response, data: projectedData });
  }
);

registerTool(
  "get_candidate",
  "Get a single candidate by ID. Returns full candidate profile including name, contact info, tags, and custom fields.",
  {
    id: z.number().describe("The candidate ID"),
  },
  async ({ id }) => {
    const response = await apiGet(`/candidates/${id}`);
    return formatResult(response);
  }
);

// 6. Close Reasons
registerTool(
  "list_close_reasons",
  "List all close reasons in Greenhouse. Close reasons are used when closing a job to indicate why it was closed.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated close reason IDs to filter by"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/close_reasons", rest, cursor);
    return formatResult(response);
  }
);

// 7. Email Templates — Tier 3, gated per doctrine §6
// (GREENHOUSE_ENABLE_TIER3_READS=true + GREENHOUSE_TIER3_ACTOR_IDS non-empty).
// Registration gate: shouldRegisterTier3Tool() — admin access settings must be present.
// Request-time gate: wrapTier3Handler() — every call must claim an allowlisted
// on_behalf_of_user_id, or it is rejected with TIER3_GATE_DENIED_MESSAGE
// before listEndpoint runs.
if (shouldRegisterTier3Tool(TOOL_GATE_CONFIG)) {
  registerTool(
    "list_email_templates",
    "List email templates in Greenhouse. Returns template details including name, subject, body, and email type when expanded access is available.",
    {
      ...paginationParams,
      ...dateFilterParams,
      ids: z.string().optional().describe("Comma-separated email template IDs to filter by"),
      email_type: z
        .string()
        .optional()
        .describe(
          "Filter by email template type (e.g. candidate_rejection, candidate_email, take_home_test_email, scorecard_reminder, etc.)"
        ),
      on_behalf_of_user_id: tier3ActorSchema,
    },
    wrapTier3Handler("list_email_templates", TOOL_GATE_CONFIG, async (params, context) => {
      const { cursor, ...rest } = params;
      const response = await listEndpoint("/email_templates", rest, cursor);
      emitTier3SuccessReadAudit({
        toolName: "list_email_templates",
        actorId: context!.actorId,
        resultSizeClass: resultSizeClassFromData(response.data),
      });
      return formatResult(response);
    })
  );
}

// 8. Job Board Custom Locations
registerTool(
  "list_job_board_custom_locations",
  "List custom locations defined on job boards in Greenhouse.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated location IDs to filter by"),
    greenhouse_job_board_ids: z
      .string()
      .optional()
      .describe("Comma-separated job board IDs to filter by"),
    active: z.boolean().optional().describe("Filter by active status"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/job_board_custom_locations", rest, cursor);
    return formatResult(response);
  }
);

// 8. Job Candidate Attributes
registerTool(
  "list_job_candidate_attributes",
  "List candidate attributes configured on jobs in Greenhouse. These define the evaluation criteria for candidates on a specific job.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated attribute IDs to filter by"),
    job_ids: z.string().optional().describe("Comma-separated job IDs to filter by"),
    candidate_attribute_type_ids: z
      .string()
      .optional()
      .describe("Comma-separated candidate attribute type IDs to filter by"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/job_candidate_attributes", rest, cursor);
    return formatResult(response);
  }
);

// 9. Job Hiring Managers
registerTool(
  "list_job_hiring_managers",
  "List hiring managers assigned to jobs in Greenhouse.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated hiring manager assignment IDs to filter by"),
    job_ids: z.string().optional().describe("Comma-separated job IDs to filter by"),
    user_ids: z.string().optional().describe("Comma-separated user IDs to filter by"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/job_hiring_managers", rest, cursor);
    return formatResult(response);
  }
);

// 10. Job Interview Stages
registerTool(
  "list_job_interview_stages",
  "List interview stages (pipeline stages) configured on jobs in Greenhouse. Shows the interview pipeline structure.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated stage IDs to filter by"),
    job_ids: z.string().optional().describe("Comma-separated job IDs to filter by"),
    active: z.boolean().optional().describe("Filter by active status"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/job_interview_stages", rest, cursor);
    return formatResult(response);
  }
);

// 11. Job Interviews
registerTool(
  "list_job_interviews",
  "List interviews configured on jobs in Greenhouse. Shows interview details including scheduling type, duration, and instructions.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated interview IDs to filter by"),
    job_ids: z.string().optional().describe("Comma-separated job IDs to filter by"),
    job_interview_stage_ids: z
      .string()
      .optional()
      .describe("Comma-separated interview stage IDs to filter by"),
    active: z.boolean().optional().describe("Filter by active status"),
    scheduling_type: z
      .enum(["none", "needs_scheduling", "take_home_test", "offer"])
      .optional()
      .describe("Filter by scheduling type"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/job_interviews", rest, cursor);
    return formatResult(response);
  }
);

// 12. Job Notes
registerTool(
  "list_job_notes",
  "List notes on jobs in Greenhouse. Notes contain comments/observations about jobs made by team members.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated note IDs to filter by"),
    job_ids: z.string().optional().describe("Comma-separated job IDs to filter by"),
    user_ids: z.string().optional().describe("Comma-separated user IDs to filter by (note authors)"),
    visibility: z
      .enum(["admin_only_visible", "privately_visible"])
      .optional()
      .describe("Filter by visibility level"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/job_notes", rest, cursor);
    return formatResult(response);
  }
);

// 13. Job Owners
registerTool(
  "list_job_owners",
  "List owners (recruiters, sourcers, coordinators) assigned to jobs in Greenhouse.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated owner assignment IDs to filter by"),
    job_ids: z.string().optional().describe("Comma-separated job IDs to filter by"),
    user_ids: z.string().optional().describe("Comma-separated user IDs to filter by"),
    type: z
      .enum(["sourcer", "recruiter", "coordinator"])
      .optional()
      .describe("Filter by owner type"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/job_owners", rest, cursor);
    return formatResult(response);
  }
);

// 14. Job Post Locations
registerTool(
  "list_job_post_locations",
  "List locations associated with job posts in Greenhouse.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated location IDs to filter by"),
    job_post_ids: z.string().optional().describe("Comma-separated job post IDs to filter by"),
    office_ids: z.string().optional().describe("Comma-separated office IDs to filter by"),
    custom_location_ids: z
      .string()
      .optional()
      .describe("Comma-separated custom location IDs to filter by"),
    type: z
      .enum(["free_text", "office", "custom_list"])
      .optional()
      .describe("Filter by location type"),
    plain_text_location: z
      .string()
      .optional()
      .describe("Filter by plain text location value"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/job_post_locations", rest, cursor);
    return formatResult(response);
  }
);

// 15. Job Posts
registerTool(
  "list_job_posts",
  "List job posts in Greenhouse. Job posts are the public or internal postings of a job, including title, content, and questions.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated job post IDs to filter by"),
    job_ids: z.string().optional().describe("Comma-separated job IDs to filter by"),
    job_board_ids: z.string().optional().describe("Comma-separated job board IDs to filter by"),
    active: z.boolean().optional().describe("Filter by active status"),
    live: z.boolean().optional().describe("Filter by live status (live post on a live job board)"),
    featured: z.boolean().optional().describe("Filter by featured status"),
    internal: z.boolean().optional().describe("Filter by internal posting status"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/job_posts", rest, cursor);
    return formatResult(response);
  }
);

// 16. Jobs
registerTool(
  "list_jobs",
  "List jobs in Greenhouse. Returns job details including name, status, department, offices, and custom fields.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated job IDs to filter by"),
    status: z
      .enum(["open", "draft", "closed"])
      .optional()
      .describe("Filter by job status"),
    department_id: z.number().optional().describe("Filter by department ID"),
    office_id: z.number().optional().describe("Filter by office ID"),
    requisition_id: z.string().optional().describe("Filter by requisition ID"),
    confidential: z.boolean().optional().describe("Filter by confidential status"),
    custom_field_option_id: z
      .number()
      .optional()
      .describe("Filter by custom field option ID"),
    opened_at: z
      .string()
      .optional()
      .describe(
        "Filter by job open date. Format: operator|ISO8601 (e.g. gte|2024-01-01T00:00:00Z). Operators: gte, lte, gt, lt"
      ),
    closed_at: z
      .string()
      .optional()
      .describe(
        "Filter by job close date. Format: operator|ISO8601 (e.g. gte|2024-01-01T00:00:00Z). Operators: gte, lte, gt, lt"
      ),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/jobs", rest, cursor);
    return formatResult(response);
  }
);

registerTool(
  "get_job",
  "Get a single job by ID. Returns full job details including name, status, department, offices, and custom fields.",
  {
    id: z.number().describe("The job ID"),
  },
  async ({ id }) => {
    const response = await apiGet(`/jobs/${id}`);
    return formatResult(response);
  }
);

// 17. Rejection Details — Tier 3, projected per doctrine §3
// (list_rejection_details row). Slice 5 of P2.2: projection active;
// tool remains ungated and follows the slice-1/2 non-gated Tier-3-
// audited pattern per doctrine §7 canonical rule — see
// docs/greenhouse-mcp-projection-slice-5-spec.md §§5.3–5.5.
registerTool(
  "list_rejection_details",
  "List rejection details for applications in Greenhouse. Returns operational rejection fields for disposition hygiene: application_id, reason_id, rejected_at, and rejected_by.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated rejection detail IDs to filter by"),
    application_ids: z
      .string()
      .optional()
      .describe("Comma-separated application IDs to filter by"),
    rejection_reason_ids: z
      .string()
      .optional()
      .describe("Comma-separated rejection reason IDs to filter by"),
    custom_field_option_id: z
      .number()
      .optional()
      .describe("Filter by custom field option ID"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    try {
      const response = await listEndpoint("/rejection_details", rest, cursor);
      const projectedData = projectRejectionDetailsArray(response.data);
      emitTier3SuccessReadAudit({
        toolName: "list_rejection_details",
        actorId: null,
        resultSizeClass: resultSizeClassFromData(projectedData),
        projectionApplied: true,
      });
      return formatResult({ ...response, data: projectedData });
    } catch (err) {
      if (err instanceof Error && err.message === READ_AUDIT_FAILURE_MESSAGE) {
        throw err;
      }
      emitTier3ErrorReadAudit({
        toolName: "list_rejection_details",
        actorId: null,
        projectionApplied: true,
      });
      throw err;
    }
  }
);

// 18. Rejection Reasons
registerTool(
  "list_rejection_reasons",
  "List all rejection reasons in Greenhouse. These are the predefined reasons available when rejecting candidates.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated rejection reason IDs to filter by"),
    include_defaults: z
      .boolean()
      .optional()
      .describe("Include default rejection reasons"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/rejection_reasons", rest, cursor);
    return formatResult(response);
  }
);

// 19. Scorecards — Tier 3, projected per doctrine §3 (list_scorecards row)
// and audit-logged per doctrine §7. Slice 2 of P2.2: projection active;
// tool remains ungated (no wrapTier3Handler, no on_behalf_of_user_id
// parameter) — see docs/greenhouse-mcp-projection-slice-2-spec.md §§5.3,
// 5.4, 5.5.
registerTool(
  "list_scorecards",
  "List scorecards in Greenhouse. By default returns operational scorecard metadata. detail_profile=answers includes per-question answers and attribute notes when expanded access is available.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated scorecard IDs to filter by"),
    application_ids: z.string().optional().describe("Comma-separated application IDs to filter by"),
    interview_ids: z.string().optional().describe("Comma-separated interview IDs to filter by"),
    detail_profile: z
      .enum(["operational", "answers"])
      .optional()
      .describe("Projection profile. Default is operational; answers includes question and attribute text when expanded access is available."),
    on_behalf_of_user_id: tier3ActorSchema
      .optional()
      .describe("Required when detail_profile=answers."),
    reason: readReasonSchema,
  },
  wrapTier3Handler(
    "list_scorecards",
    TOOL_GATE_CONFIG,
    async (params, context) => {
      const { cursor, detail_profile, reason, ...rest } = params;
      assertDetailProfileReason(detail_profile, "operational", reason);
      const response = await listEndpoint("/scorecards", rest, cursor);
      const projectedData =
        detail_profile === "answers"
          ? projectScorecardsArray(response.data, { detailProfile: "answers" })
          : projectScorecardsArray(response.data);
      emitTier3SuccessReadAudit({
        toolName: "list_scorecards",
        actorId: context!.actorId,
        resultSizeClass: resultSizeClassFromData(projectedData),
        projectionApplied: true,
      });
      return formatResult({ ...response, data: projectedData });
    },
    {
      shouldGate: (params) => params.detail_profile === "answers",
      projectionAppliedOnError: true,
    }
  )
);

// 20. Scheduled Interviews — Tier 3, gated per doctrine §6.
// See list_email_templates above for gate semantics.
if (shouldRegisterTier3Tool(TOOL_GATE_CONFIG)) {
  registerTool(
    "list_scheduled_interviews",
    "List scheduled interviews in Greenhouse. Returns scheduled interview events with date/time, interviewers, organizer, and status when expanded access is available.",
    {
      ...paginationParams,
      ...dateFilterParams,
      ids: z.string().optional().describe("Comma-separated scheduled interview IDs to filter by"),
      application_ids: z.string().optional().describe("Comma-separated application IDs to filter by"),
      job_ids: z.string().optional().describe("Comma-separated job IDs to filter by"),
      starts_at: z.string().optional().describe("Filter by interview start time. Format: operator|ISO8601"),
      ends_at: z.string().optional().describe("Filter by interview end time. Format: operator|ISO8601"),
      status: z.enum(["scheduled", "awaiting_feedback", "complete", "skipped", "collect_feedback", "to_be_scheduled", "to_be_sent", "sent", "received"]).optional().describe("Filter by interview status"),
      on_behalf_of_user_id: tier3ActorSchema,
    },
    wrapTier3Handler("list_scheduled_interviews", TOOL_GATE_CONFIG, async (params, context) => {
      const { cursor, ...rest } = params;
      const response = await listEndpoint("/scheduled_interviews", rest, cursor);
      emitTier3SuccessReadAudit({
        toolName: "list_scheduled_interviews",
        actorId: context!.actorId,
        resultSizeClass: resultSizeClassFromData(response.data),
      });
      return formatResult(response);
    })
  );
}

// 21. Users
registerTool(
  "list_users",
  "List users in Greenhouse. Returns user profiles including name, email, job title, and role.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated user IDs to filter by"),
    email: z.string().optional().describe("Filter by email address"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/users", rest, cursor);
    return formatResult(response);
  }
);

registerTool(
  "get_user",
  "Get a single user by ID.",
  { id: z.number().describe("The user ID") },
  async ({ id }) => {
    const response = await apiGet(`/users/${id}`);
    return formatResult(response);
  }
);

// 22. Departments
registerTool(
  "list_departments",
  "List departments in Greenhouse.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated department IDs to filter by"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/departments", rest, cursor);
    return formatResult(response);
  }
);

// 23. Offices
registerTool(
  "list_offices",
  "List offices in Greenhouse.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated office IDs to filter by"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/offices", rest, cursor);
    return formatResult(response);
  }
);

// 24. Sources
registerTool(
  "list_sources",
  "List candidate sources in Greenhouse.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated source IDs to filter by"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/sources", rest, cursor);
    return formatResult(response);
  }
);

// 25. Offers
registerTool(
  "list_offers",
  "List offers in Greenhouse. By default returns operational offer fields. detail_profile=compensation adds timestamps and the offer's custom_fields (where compensation is recorded on the offer, if anywhere) when expanded access is available; Harvest v3 exposes no structured salary/equity on the offer object.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated offer IDs to filter by"),
    application_ids: z.string().optional().describe("Comma-separated application IDs to filter by"),
    job_ids: z.string().optional().describe("Comma-separated job IDs to filter by"),
    status: z.enum(["created", "accepted", "rejected", "deprecated"]).optional().describe("Filter by offer status"),
    detail_profile: z
      .enum(["operational", "compensation"])
      .optional()
      .describe("Projection profile. Default is operational; compensation adds created/updated timestamps and the offer's custom_fields (structured salary/equity is not a v3 offer field) when expanded access is available."),
    on_behalf_of_user_id: tier3ActorSchema
      .optional()
      .describe("Required when detail_profile=compensation."),
    reason: readReasonSchema,
  },
  wrapTier3Handler(
    "list_offers",
    TOOL_GATE_CONFIG,
    async (params, context) => {
      const { cursor, detail_profile, reason, ...rest } = params;
      assertDetailProfileReason(detail_profile, "operational", reason);
      const response = await listEndpoint("/offers", rest, cursor);
      const projectedData =
        detail_profile === "compensation"
          ? projectOffersArray(response.data, { detailProfile: "compensation" })
          : projectOffersArray(response.data);
      emitTier3SuccessReadAudit({
        toolName: "list_offers",
        actorId: context!.actorId,
        resultSizeClass: resultSizeClassFromData(projectedData),
        projectionApplied: true,
      });
      return formatResult({ ...response, data: projectedData });
    },
    {
      shouldGate: (params) => params.detail_profile === "compensation",
      projectionAppliedOnError: true,
    }
  )
);

if (shouldRegisterTier3Tool(TOOL_GATE_CONFIG)) {
  registerTool(
    "get_offer_letter_context",
    "Build offer-letter drafting context for a single application or offer. Returns candidate contact fields, attachment metadata, application answers, offer custom fields, note bodies, and scorecard text when expanded access is available. Signed attachment URLs are opt-in via include_attachment_urls.",
    {
      application_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Application ID to build context for. Provide either application_id or offer_id."),
      offer_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Offer ID to build context for. Provide either offer_id or application_id."),
      include_notes: z
        .boolean()
        .default(true)
        .describe("When true, include note subjects and bodies for the application."),
      include_scorecards: z
        .boolean()
        .default(true)
        .describe("When true, include raw scorecard questions, answers, and attribute notes."),
      include_attachment_urls: z
        .boolean()
        .default(false)
        .describe("When true, include signed attachment URLs from the candidate profile."),
      notes_limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Maximum number of notes to include when include_notes=true."),
      on_behalf_of_user_id: tier3ActorSchema,
      reason: z
        .string()
        .min(12)
        .max(500)
        .describe("Human-readable reason for this expanded data request."),
    },
    wrapTier3Handler(
      "get_offer_letter_context",
      TOOL_GATE_CONFIG,
      async (params, context) => {
        const {
          application_id,
          offer_id,
          include_notes,
          include_scorecards,
          include_attachment_urls,
          notes_limit,
          reason: _reason,
        } = params;

        if (
          (application_id == null && offer_id == null) ||
          (application_id != null && offer_id != null)
        ) {
          throw new Error("Provide exactly one of application_id or offer_id.");
        }

        let resolvedApplicationId = application_id ?? null;
        let preferredOfferId: number | null = offer_id ?? null;

        if (offer_id != null) {
          const offerLookup = await listEndpoint<unknown[]>(
            "/offers",
            { ids: String(offer_id), per_page: 1 },
            undefined
          );
          if (!Array.isArray(offerLookup.data) || offerLookup.data.length === 0) {
            throw new Error(`Offer ${offer_id} was not found.`);
          }
          const firstOffer = offerLookup.data[0];
          if (!isRecord(firstOffer)) {
            throw new Error(`Offer ${offer_id} returned an unexpected payload shape.`);
          }
          resolvedApplicationId =
            readNumberField(firstOffer, "application_id") ??
            (isRecord(firstOffer.application)
              ? readNumberField(firstOffer.application, "id")
              : null);
          if (!resolvedApplicationId) {
            throw new Error(
              `Offer ${offer_id} did not include an application_id; cannot build offer-letter context.`
            );
          }
        }

        const applicationResponse = await apiGet<Record<string, unknown>>(
          `/applications/${resolvedApplicationId}`
        );
        const applicationRecord = applicationResponse.data;
        const candidateId =
          readNumberField(applicationRecord, "candidate_id") ??
          (isRecord(applicationRecord.candidate)
            ? readNumberField(applicationRecord.candidate, "id")
            : null);
        if (!candidateId) {
          throw new Error(
            `Application ${resolvedApplicationId} did not include a candidate_id; cannot build offer-letter context.`
          );
        }

        const [
          candidateResponse,
          offersResponse,
          notesResponse,
          scorecardsResponse,
        ] = await Promise.all([
          apiGet<Record<string, unknown>>(`/candidates/${candidateId}`),
          listEndpoint<unknown[]>(
            "/offers",
            { application_ids: String(resolvedApplicationId), per_page: 100 },
            undefined
          ),
          include_notes
            ? listEndpoint<unknown[]>(
                "/notes",
                {
                  application_ids: String(resolvedApplicationId),
                  per_page: notes_limit,
                },
                undefined
              )
            : Promise.resolve({ data: [], nextCursor: null }),
          include_scorecards
            ? listEndpoint<unknown[]>(
                "/scorecards",
                {
                  application_ids: String(resolvedApplicationId),
                  per_page: 100,
                },
                undefined
              )
            : Promise.resolve({ data: [], nextCursor: null }),
        ]);

        const contextPayload = buildOfferLetterContext({
          application: applicationRecord,
          candidate: candidateResponse.data,
          offers: offersResponse.data,
          notes: notesResponse.data,
          scorecards: scorecardsResponse.data,
          includeAttachmentUrls: include_attachment_urls,
          preferredOfferId,
        });

        emitTier3SuccessReadAudit({
          toolName: "get_offer_letter_context",
          actorId: context!.actorId,
          resultSizeClass: resultSizeClassFromData(contextPayload),
          projectionApplied: true,
        });

        return formatResult({
          data: contextPayload,
          nextCursor: null,
        });
      },
      { projectionAppliedOnError: true }
    )
  );
}

// 26. Interviews (v3 — distinct from scheduled_interviews)
registerTool(
  "list_interviews",
  "List interviews in Greenhouse. Returns actual interview events with status, times, organizer, application, and job. Status values: to_be_scheduled, scheduled, awaiting_feedback, complete, skipped, collect_feedback, to_be_sent, sent, received.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated interview IDs"),
    job_ids: z.string().optional().describe("Comma-separated job IDs"),
    application_ids: z.string().optional().describe("Comma-separated application IDs"),
    job_interview_ids: z.string().optional().describe("Comma-separated job interview IDs"),
    organizer_ids: z.string().optional().describe("Comma-separated organizer user IDs"),
    starts_at: z.string().optional().describe("Filter by start time. Format: operator|ISO8601"),
    ends_at: z.string().optional().describe("Filter by end time. Format: operator|ISO8601"),
    status: z.enum(["to_be_scheduled", "scheduled", "awaiting_feedback", "complete", "skipped", "collect_feedback", "to_be_sent", "sent", "received"]).optional().describe("Filter by status"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/interviews", rest, cursor);
    return formatResult(response);
  }
);

// 27. Interviewers
registerTool(
  "list_interviewers",
  "List interviewers assigned to interviews in Greenhouse.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated interviewer IDs"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/interviewers", rest, cursor);
    return formatResult(response);
  }
);

// 28. Interview Kits — Tier 3, gated per doctrine §6.
// See list_email_templates above for gate semantics.
if (shouldRegisterTier3Tool(TOOL_GATE_CONFIG)) {
  registerTool(
    "list_interview_kits",
    "List interview kits in Greenhouse. Shows exercises, anonymization settings, and which job/interview stage they belong to when expanded access is available.",
    {
      ...paginationParams,
      ...dateFilterParams,
      ids: z.string().optional().describe("Comma-separated interview kit IDs"),
      job_ids: z.string().optional().describe("Comma-separated job IDs"),
      job_interview_ids: z.string().optional().describe("Comma-separated job interview IDs"),
      on_behalf_of_user_id: tier3ActorSchema,
    },
    wrapTier3Handler("list_interview_kits", TOOL_GATE_CONFIG, async (params, context) => {
      const { cursor, ...rest } = params;
      const response = await listEndpoint("/interview_kits", rest, cursor);
      emitTier3SuccessReadAudit({
        toolName: "list_interview_kits",
        actorId: context!.actorId,
        resultSizeClass: resultSizeClassFromData(response.data),
      });
      return formatResult(response);
    })
  );
}

// 29. Interviewer Tags
registerTool(
  "list_interviewer_tags",
  "List interviewer tags in Greenhouse. Tags categorize interviewers by skill or role.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated interviewer tag IDs"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/interviewer_tags", rest, cursor);
    return formatResult(response);
  }
);

// 30. Default Interviewers
registerTool(
  "list_default_interviewers",
  "List default interviewers configured for interview stages in Greenhouse.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated default interviewer IDs"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/default_interviewers", rest, cursor);
    return formatResult(response);
  }
);

// 31. Openings (requisitions/headcount)
registerTool(
  "list_openings",
  "List openings (requisitions) in Greenhouse. Shows headcount, target start dates, close reasons, and which application filled each opening.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated opening IDs"),
    job_ids: z.string().optional().describe("Comma-separated job IDs"),
    application_ids: z.string().optional().describe("Comma-separated application IDs"),
    close_reason_ids: z.string().optional().describe("Comma-separated close reason IDs"),
    opened_at: z.string().optional().describe("Filter by opened date. Format: operator|ISO8601"),
    closed_at: z.string().optional().describe("Filter by closed date. Format: operator|ISO8601"),
    open: z.boolean().optional().describe("Filter by open/closed status"),
    opening_id: z.string().optional().describe("Filter by opening ID string"),
    custom_field_option_id: z.number().optional().describe("Filter by custom field option ID"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/openings", rest, cursor);
    return formatResult(response);
  }
);

// 32. Notes (candidate/application notes and activity) — Tier 3, projected
// per doctrine §3 (list_notes row) and audit-logged per doctrine §7.
// Slice 1 of P2.2: projection active; tool remains ungated (no
// wrapTier3Handler, no on_behalf_of_user_id parameter) — see
// docs/greenhouse-mcp-projection-slice-1-spec.md §§5.3, 5.4, 5.5.
registerTool(
  "list_notes",
  "List notes in Greenhouse. By default returns operational note metadata. detail_profile=body includes subject and body when expanded access is available. Types: NOTE, ACTIVITY, INTERVIEW, EMAIL, FOLLOW_UP, TAKE_HOME_TEST, LINKEDIN_NOTE, LINKEDIN_INMAIL, AVAILABILITY_REQUEST, TOUCHPOINT, FORM, FEEDBACK.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated note IDs"),
    candidate_ids: z.string().optional().describe("Comma-separated candidate IDs"),
    user_ids: z.string().optional().describe("Comma-separated user IDs (note authors)"),
    application_ids: z.string().optional().describe("Comma-separated application IDs"),
    type: z.string().optional().describe("Filter by note type (NOTE, ACTIVITY, INTERVIEW, EMAIL, etc.)"),
    visibility: z.enum(["admin_only_visible", "privately_visible", "publicly_visible"]).optional().describe("Filter by visibility"),
    detail_profile: z
      .enum(["minimal", "body"])
      .optional()
      .describe("Projection profile. Default is minimal; body includes subject and body text when expanded access is available."),
    on_behalf_of_user_id: tier3ActorSchema
      .optional()
      .describe("Required when detail_profile=body."),
    reason: readReasonSchema,
  },
  wrapTier3Handler(
    "list_notes",
    TOOL_GATE_CONFIG,
    async (params, context) => {
      const { cursor, detail_profile, reason, ...rest } = params;
      assertDetailProfileReason(detail_profile, "minimal", reason);
      const response = await listEndpoint("/notes", rest, cursor);
      const projectedData =
        detail_profile === "body"
          ? projectNotesArray(response.data, { detailProfile: "body" })
          : projectNotesArray(response.data);
      emitTier3SuccessReadAudit({
        toolName: "list_notes",
        actorId: context!.actorId,
        resultSizeClass: resultSizeClassFromData(projectedData),
        projectionApplied: true,
      });
      return formatResult({ ...response, data: projectedData });
    },
    {
      shouldGate: (params) => params.detail_profile === "body",
      projectionAppliedOnError: true,
    }
  )
);

// 33. Referrers
registerTool(
  "list_referrers",
  "List referrers in Greenhouse. Shows who referred candidates and their associated user ID.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated referrer IDs"),
    user_ids: z.string().optional().describe("Comma-separated user IDs"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/referrers", rest, cursor);
    return formatResult(response);
  }
);

// 34. Custom Fields
registerTool(
  "list_custom_fields",
  "List custom field definitions in Greenhouse. Shows field names, types, and which object they apply to (job, candidate, application, offer, etc.).",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated custom field IDs"),
    field_type: z.string().optional().describe("Filter by field type (job, opening, candidate, application, offer, etc.)"),
    active: z.boolean().optional().describe("Filter by active status"),
    name: z.string().optional().describe("Filter by field name"),
    name_key: z.string().optional().describe("Filter by field name key"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/custom_fields", rest, cursor);
    return formatResult(response);
  }
);

// 35. Custom Field Options
registerTool(
  "list_custom_field_options",
  "List custom field option values in Greenhouse. Shows the available choices for single_select and multi_select custom fields.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated custom field option IDs"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/custom_field_options", rest, cursor);
    return formatResult(response);
  }
);

// 36. Custom Field Departments
registerTool(
  "list_custom_field_departments",
  "List custom field to department mappings in Greenhouse.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated mapping IDs"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/custom_field_departments", rest, cursor);
    return formatResult(response);
  }
);

// 37. Custom Field Offices
registerTool(
  "list_custom_field_offices",
  "List custom field to office mappings in Greenhouse.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated mapping IDs"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/custom_field_offices", rest, cursor);
    return formatResult(response);
  }
);

// 38. Candidate Attribute Types
registerTool(
  "list_candidate_attribute_types",
  "List candidate attribute type definitions in Greenhouse.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated attribute type IDs"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/candidate_attribute_types", rest, cursor);
    return formatResult(response);
  }
);

// 39. Candidate Educations
registerTool(
  "list_candidate_educations",
  "List candidate education records in Greenhouse.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated education record IDs"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/candidate_educations", rest, cursor);
    return formatResult(response);
  }
);

// 40. Candidate Employments
registerTool(
  "list_candidate_employments",
  "List candidate employment history records in Greenhouse.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated employment record IDs"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/candidate_employments", rest, cursor);
    return formatResult(response);
  }
);

// 41. Prospect Pools
registerTool(
  "list_prospect_pools",
  "List prospect pools in Greenhouse. Shows pool names, descriptions, associated departments/offices/jobs.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated prospect pool IDs"),
    department_ids: z.string().optional().describe("Comma-separated department IDs"),
    office_ids: z.string().optional().describe("Comma-separated office IDs"),
    job_ids: z.string().optional().describe("Comma-separated job IDs"),
    active: z.boolean().optional().describe("Filter by active status"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/prospect_pools", rest, cursor);
    return formatResult(response);
  }
);

// 42. Prospect Pool Stages
registerTool(
  "list_prospect_pool_stages",
  "List stages within prospect pools in Greenhouse.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated prospect pool stage IDs"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/prospect_pool_stages", rest, cursor);
    return formatResult(response);
  }
);

// 43. Prospect Details
registerTool(
  "list_prospect_details",
  "List prospect detail records in Greenhouse.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated prospect detail IDs"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/prospect_details", rest, cursor);
    return formatResult(response);
  }
);

// 44. Approval Flows
registerTool(
  "list_approval_flows",
  "List approval flows in Greenhouse. Shows job/offer approval workflows, their status (pending/rejected/approved), and whether they are sequential.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated approval flow IDs"),
    job_ids: z.string().optional().describe("Comma-separated job IDs"),
    offer_ids: z.string().optional().describe("Comma-separated offer IDs"),
    approval_type: z.enum(["open_job", "offer_job", "offer_candidate"]).optional().describe("Filter by approval type"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/approval_flows", rest, cursor);
    return formatResult(response);
  }
);

// 45. Approver Groups
registerTool(
  "list_approver_groups",
  "List approver groups in Greenhouse. Shows groups of approvers within approval flows.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated approver group IDs"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/approver_groups", rest, cursor);
    return formatResult(response);
  }
);

// 46. Approvers
registerTool(
  "list_approvers",
  "List individual approvers in Greenhouse.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated approver IDs"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/approvers", rest, cursor);
    return formatResult(response);
  }
);

// 47. User Emails — Tier 3, gated per doctrine §6.
// See list_email_templates above for gate semantics.
if (shouldRegisterTier3Tool(TOOL_GATE_CONFIG)) {
  registerTool(
    "list_user_emails",
    "List user email addresses in Greenhouse when expanded access is available.",
    {
      ...paginationParams,
      ...dateFilterParams,
      ids: z.string().optional().describe("Comma-separated user email IDs"),
      on_behalf_of_user_id: tier3ActorSchema,
    },
    wrapTier3Handler("list_user_emails", TOOL_GATE_CONFIG, async (params, context) => {
      const { cursor, ...rest } = params;
      const response = await listEndpoint("/user_emails", rest, cursor);
      emitTier3SuccessReadAudit({
        toolName: "list_user_emails",
        actorId: context!.actorId,
        resultSizeClass: resultSizeClassFromData(response.data),
      });
      return formatResult(response);
    })
  );
}

// 48. User Roles
registerTool(
  "list_user_roles",
  "List user role definitions in Greenhouse. Role types: deprecated_interviewer, job_admin, site_admin.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated user role IDs"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/user_roles", rest, cursor);
    return formatResult(response);
  }
);

// 49. User Job Permissions
registerTool(
  "list_user_job_permissions",
  "List user job-level permissions in Greenhouse. Shows which users have access to which jobs.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated permission IDs"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/user_job_permissions", rest, cursor);
    return formatResult(response);
  }
);

// 50. Future Job Permissions
registerTool(
  "list_future_job_permissions",
  "List future job permission grants in Greenhouse. Shows advance permission scheduling for users.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated future permission IDs"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/future_job_permissions", rest, cursor);
    return formatResult(response);
  }
);

// 51. Scorecard Questions
registerTool(
  "list_scorecard_questions",
  "List scorecard question templates in Greenhouse.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated scorecard question IDs"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/scorecard_questions", rest, cursor);
    return formatResult(response);
  }
);

// 52. Scorecard Question Answers
registerTool(
  "list_scorecard_question_answers",
  "List scorecard question answer submissions in Greenhouse.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated answer IDs"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/scorecard_question_answers", rest, cursor);
    return formatResult(response);
  }
);

// 53. Scorecard Question Options
registerTool(
  "list_scorecard_question_options",
  "List scorecard question option definitions in Greenhouse.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated option IDs"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/scorecard_question_options", rest, cursor);
    return formatResult(response);
  }
);

// 54. Scorecard Question Answer Options
registerTool(
  "list_scorecard_question_answer_options",
  "List scorecard question answer option definitions in Greenhouse.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated answer option IDs"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/scorecard_question_answer_options", rest, cursor);
    return formatResult(response);
  }
);

// 55. Scorecard Candidate Attributes
registerTool(
  "list_scorecard_candidate_attributes",
  "List scorecard candidate attribute ratings in Greenhouse.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated attribute IDs"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/scorecard_candidate_attributes", rest, cursor);
    return formatResult(response);
  }
);

// 56. Scorecard Question Candidate Attributes
registerTool(
  "list_scorecard_question_candidate_attributes",
  "List scorecard question to candidate attribute mappings in Greenhouse.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated mapping IDs"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/scorecard_question_candidate_attributes", rest, cursor);
    return formatResult(response);
  }
);

// 57. EEOC — REMOVED per docs/greenhouse-mcp-output-doctrine.md §4
// (Tier 4: gender, race, veteran status, disability status). No lib/ consumer.

// 58. Demographic Question Sets — REMOVED per doctrine §4 (Tier 4 survey schema).

// 59. Demographic Questions — REMOVED per doctrine §4 (Tier 4 survey schema).

// 60. Demographic Answer Options — REMOVED per doctrine §4 (Tier 4 survey schema).

// 61. Demographic Answers — REMOVED per doctrine §4 (Tier 4 survey submissions).

// 62. Tracking Links
registerTool(
  "list_tracking_links",
  "List tracking links in Greenhouse. Used for source attribution — connects sources, referrers, job boards, and job posts.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated tracking link IDs"),
    job_ids: z.string().optional().describe("Comma-separated job IDs"),
    source_ids: z.string().optional().describe("Comma-separated source IDs"),
    referrer_ids: z.string().optional().describe("Comma-separated referrer IDs"),
    job_board_ids: z.string().optional().describe("Comma-separated job board IDs"),
    job_post_ids: z.string().optional().describe("Comma-separated job post IDs"),
    token: z.string().optional().describe("Filter by tracking token"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/tracking_links", rest, cursor);
    return formatResult(response);
  }
);

// 63. Focus Candidate Attributes
registerTool(
  "list_focus_candidate_attributes",
  "List focus candidate attributes in Greenhouse.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated focus attribute IDs"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/focus_candidate_attributes", rest, cursor);
    return formatResult(response);
  }
);

// 64. Blocked Spam Sources
registerTool(
  "list_blocked_spam_sources",
  "List blocked spam sources in Greenhouse.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated blocked spam source IDs"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/blocked_spam_sources", rest, cursor);
    return formatResult(response);
  }
);

// 65. Bulk Requests
registerTool(
  "list_bulk_requests",
  "List bulk operation requests in Greenhouse. Shows status, record counts, and completion details for bulk operations.",
  {
    ...paginationParams,
    ...dateFilterParams,
    ids: z.string().optional().describe("Comma-separated bulk request IDs"),
    bulk_action_uuid: z.string().optional().describe("Filter by bulk action UUID"),
    active: z.boolean().optional().describe("Filter by active status"),
  },
  async (params) => {
    const { cursor, ...rest } = params;
    const response = await listEndpoint("/bulk_requests", rest, cursor);
    return formatResult(response);
  }
);

// 66. Pay Input Ranges — REMOVED per docs/greenhouse-mcp-output-doctrine.md §4
// (Tier 4: min/max compensation). No lib/ consumer.

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
