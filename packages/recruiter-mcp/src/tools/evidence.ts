import { z } from "zod";
import type { RecruiterToolDefinition } from "../types.js";
import { newCorrelationId } from "../audit.js";
import { deny, emitRequiredToolAudit, runScopedTool, type RecruiterToolRuntime } from "../runtime.js";
import {
  getHarvestEndpointForEvidenceTool,
  getModelExposedParametersForEndpoint,
  getModelParamNamesForEvidenceTool,
  getPathParametersForEvidenceTool,
  type HarvestScopeClass,
  type ParameterSpec,
} from "../harvest-v3-registry.js";
import { projectEvidenceResult } from "./evidence-projection.js";
import { resolvePrivateCustomFieldKeys } from "../private-custom-fields.js";
import { getScopeBridgeSpec, runEvidenceListRead } from "./evidence-read.js";
import {
  EVIDENCE_TOOL_SCOPED_TOOL_NAMES,
  SCOPED_ENDPOINT_ADAPTERS_BY_EVIDENCE_TOOL,
  getEvidenceEndpointAdapter,
} from "./scoped-endpoint-adapters.js";

export const EVIDENCE_TOOL_MAP = EVIDENCE_TOOL_SCOPED_TOOL_NAMES;

const EVIDENCE_TOOL_PARAM_NAMES = new Map<string, ReadonlySet<string>>(
  [...EVIDENCE_TOOL_MAP.keys()].map((toolName) => [toolName, getModelParamNamesForEvidenceTool(toolName)])
);

export function evidenceToolParamsSchema(toolName: string): Record<string, z.ZodTypeAny> {
  if (toolName.startsWith("get_")) {
    const pathParams = getPathParametersForEvidenceTool(toolName);
    if (pathParams.length > 0) {
      // One endpoint selects its row by a path segment rather than a numeric id
      // (/v3/bulk_requests/{bulk_action_uuid}). Advertising `id: number` for it would have asked the
      // model for a value the endpoint has no use for.
      return Object.fromEntries(
        pathParams.map((param) => [
          param.name,
          z.string().min(1).describe(describeParameter(param)),
        ])
      );
    }
    return {
      id: z.number().int().positive().describe("Greenhouse record id."),
    };
  }
  const endpoint = getHarvestEndpointForEvidenceTool(toolName);
  if (!endpoint) return {};
  const schema: Record<string, z.ZodTypeAny> = {};
  for (const parameter of getModelExposedParametersForEndpoint(endpoint.path)) {
    schema[parameter.name] = zodSchemaForParameter(parameter);
  }
  // Deterministic continuation over the complete scoped set (the read is stable-sorted): pair with
  // per_page and follow result_truncated.next_offset to page past the payload-size cap.
  schema.offset = z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Rows to skip; follow result_truncated.next_offset to page onward.");
  // Bridgeable endpoints have NO job_ids filter, so a confirmed requisition scope is otherwise inert on
  // them: application-backed (application_stages/scorecards/rejection_details/notes/attachments) bridge
  // to application_ids (L1); the R2 siblings bridge to their own id filter (scorecard_question_answers ->
  // scorecard_ids, interviewers -> interview_ids, candidates -> ids, candidate_educations/employments ->
  // candidate_ids). Advertise the two scope carriers; runEvidenceListRead auto-bridges them.
  // getScopeBridgeSpec is the SINGLE source of truth for which tools bridge (shared with the dispatch).
  // Other tools are bounded by their endpoint's own native job_ids filter, so they don't take these.
  if (getScopeBridgeSpec(getEvidenceEndpointAdapter(toolName))) {
    schema.scope_handle = z
      .string()
      .optional()
      .describe("Signed handle from resolve_job_scope; wins over job_ids.");
    schema.job_ids = z
      .string()
      .optional()
      .describe("Comma-separated Greenhouse job ids to scope this read to.");
  }
  return schema;
}

export const EVIDENCE_TOOL_DEFINITIONS: RecruiterToolDefinition[] = [
  { name: "search_my_jobs", kind: "evidence", description: "Search jobs visible to the authenticated recruiter." },
  { name: "get_my_job", kind: "evidence", description: "Get one job if it is visible to the authenticated recruiter." },
  { name: "search_my_job_owners", kind: "evidence", description: "Search job-owner assignments for permitted jobs. Domain class: job_scoped; rows must carry a permitted job_id before projection." },
  { name: "search_my_openings", kind: "evidence", description: "Search openings/headcount rows for permitted jobs. Domain class: job_scoped; rows must carry a permitted job_id before projection." },
  { name: "search_my_job_interview_stages", kind: "evidence", description: "Search interview-stage configuration for permitted jobs. Domain class: job_scoped; rows must carry a permitted job_id before projection." },
  { name: "search_my_job_interviews", kind: "evidence", description: "Search job interview-kit rows for permitted jobs. Domain class: job_scoped; rows must carry a permitted job_id before projection." },
  { name: "search_my_interviews", kind: "evidence", description: "Search interview events bounded by permitted job or application association. Domain class: job_scoped; private candidate details are projected out." },
  { name: "search_my_application_stages", kind: "evidence", description: "Search application stage-transition rows for funnel conversion across permitted jobs. Domain class: application_backed; each row is scoped through its application's job_id before projection and carries no candidate identity. Pass scope_handle or job_ids to narrow to a requisition (auto-bridged to that scope's application_ids, since the endpoint has no job_ids filter); without one it spans all your permitted jobs. Returns the complete scoped set in one call." },
  { name: "search_my_applications", kind: "evidence", description: "Search applications across the authenticated recruiter's permitted jobs. Domain class: job_scoped." },
  { name: "get_my_application", kind: "evidence", description: "Get one application if it belongs to a permitted job." },
  { name: "search_my_candidates", kind: "evidence", description: "Search candidates through applications on the recruiter's permitted jobs. Domain class: candidate_backed. Rows carry the candidate's name, email addresses and phone numbers (what a Job Admin sees in Greenhouse); home addresses and raw profiles are withheld. Filter by email to find a specific person. Pass scope_handle or job_ids to narrow to a requisition (auto-bridged to that scope's candidate ids, via its applications); without one it spans candidates across all your permitted jobs. Returns the complete scoped set in one call." },
  { name: "get_my_candidate", kind: "evidence", description: "Get one candidate through applications on the recruiter's permitted jobs. Domain class: candidate_backed. Includes name, email addresses and phone numbers; home addresses and raw profiles are withheld." },
  { name: "search_my_scorecards", kind: "evidence", description: "Search scorecards scoped to applications on the recruiter's permitted jobs. Domain class: application_backed. Pass scope_handle or job_ids to narrow to a requisition (auto-bridged to that scope's application_ids); without one it spans all your permitted jobs. Returns the complete scoped set in one call." },
  { name: "search_my_rejection_details", kind: "evidence", description: "Search projected rejection-detail rows bounded through scoped applications. Domain class: application_backed. Pass scope_handle or job_ids to narrow to a requisition (auto-bridged to that scope's application_ids); without one it spans all your permitted jobs. Returns the complete scoped set in one call." },
  { name: "search_my_rejection_reasons", kind: "evidence", description: "Search projected rejection-reason reference data. Domain class: global_reference; not job-filtered and never treated as fake scoped data." },
  { name: "search_my_users", kind: "evidence", description: "Search projected Greenhouse user reference metadata (id, name, employee id, role flags). Domain class: global_reference; not job-filtered. Colleague email addresses are returned to site admins and operators only — they administer the staff directory; a job-scoped line recruiter gets names and ids." },
  { name: "get_my_user", kind: "evidence", description: "Get one projected Greenhouse user reference row by id. Domain class: global_reference. Colleague email addresses are returned to site admins and operators only; a job-scoped line recruiter gets names and ids." },
  { name: "search_my_sources", kind: "evidence", description: "Search projected application-source reference data (id, name, and source type). Domain class: global_reference; not job-filtered. Resolves source ids returned by analyses into human-readable source names." },
  { name: "search_my_referrers", kind: "evidence", description: "Search projected referrer reference data (id, name, and the linking user_id). Domain class: global_reference; not job-filtered. The user_id is the Greenhouse user who made the referral — an id, not contact data — so employee-referral yield can be attributed. Resolves referrer ids returned by analyses into referrer names." },
  { name: "search_my_notes", kind: "evidence", description: "Search public notes scoped to applications/candidates on permitted jobs. Domain class: application_backed. Pass scope_handle or job_ids to narrow to a requisition (auto-bridged to that scope's application_ids; application-keyed notes only — candidate-level notes with no application_id are not part of a req-scoped read); without one it spans all your permitted jobs. Returns the complete scoped set in one call." },
  { name: "search_my_tracking_links", kind: "evidence", description: "Search tracking links for permitted jobs — which link a click came through. Domain class: job_scoped; rows carry a permitted job_id. The row's `token` IS returned: it is the public attribution slug in the job-board URL a candidate clicks, and it is what an application's source is matched on." },
  { name: "search_my_offers", kind: "evidence", description: "Search projected offer metadata for permitted jobs. Domain class: job_scoped; rows carry a permitted job_id. Compensation custom fields pass through unless the field definition is flagged private in Greenhouse; if the definitions cannot be read at all, every custom field is withheld for that read rather than guessed at." },
  { name: "search_my_departments", kind: "evidence", description: "Search projected department reference data (id, name, parent_id, external_id). Domain class: global_reference; not job-filtered. Resolves department ids returned by analyses into department names and supports department rollups." },
  { name: "search_my_offices", kind: "evidence", description: "Search projected office reference data (id, name, location, parent_id). Domain class: global_reference; not job-filtered. Resolves office ids into office names/locations and supports office rollups." },
  { name: "search_my_close_reasons", kind: "evidence", description: "Search projected opening close-reason reference data (id, name). Domain class: global_reference; not job-filtered. Resolves the close_reason_id on a closed opening into a human-readable reason." },
  { name: "search_my_custom_field_options", kind: "evidence", description: "Search projected custom-field option reference data (id, name, custom_field_id). Domain class: global_reference; not job-filtered. Decodes the custom_field_option_id values that appear on openings, rejection details, users, and candidate history into their labels." },
  { name: "search_my_attachments", kind: "evidence", description: "List metadata for resumes, cover letters, and other files on candidates/applications within the recruiter's permitted jobs. Use this for file inventory and to choose an exact resume attachment_id; signed URLs and file contents are withheld. Then call read_my_resume only when actual resume text is needed. Domain class: application_backed; each row is bounded by its application's job, or — for a candidate-level attachment with no application_id — by the candidate's permitted applications. Filter with type=resume to list resume versions. Pass scope_handle or job_ids to narrow to a requisition (auto-bridged to that scope's application_ids; application-keyed attachments only — candidate-level files with no application_id are not part of a req-scoped read); without one it spans all your permitted jobs. Returns the complete scoped set in one call." },
  { name: "search_my_job_hiring_managers", kind: "evidence", description: "Search hiring-manager assignments for permitted jobs. Domain class: job_scoped; rows carry a permitted job_id and resolve the user_id of each hiring manager for accountability and stakeholder escalation." },
  { name: "search_my_job_notes", kind: "evidence", description: "Search job-level notes for permitted jobs. Domain class: job_scoped; rows carry a permitted job_id. Free-text bodies are gated on per-note visibility — publicly_visible and admin_only_visible bodies reach a Job Admin; privately_visible bodies are withheld." },
  { name: "search_my_job_posts", kind: "evidence", description: "Search job-post/board listings for permitted jobs. Domain class: job_scoped; rows carry a permitted job_id. Surfaces which boards a req is live on plus the public posting title, content, and URL." },
  { name: "search_my_interviewers", kind: "evidence", description: "Search interview-panel membership and invite response status for permitted jobs. Domain class: interview_backed; each row is scoped through its interview to a permitted application or job. Surfaces who is on the panel and each member's interview-invite response (response_status is the calendar RSVP — accepted/declined/tentative/needs_action — NOT scorecard submission; for who has/hasn't submitted a scorecard use search_my_scorecards, status draft/complete). Interviewer email is excluded. Pass scope_handle or job_ids to narrow to a requisition (auto-bridged to that scope's interview ids); without one it spans all your permitted jobs. Returns the complete scoped set in one call." },
  { name: "search_my_scorecard_question_answers", kind: "evidence", description: "Search structured scorecard question answers (question-level rubric responses) for permitted jobs. Domain class: scorecard_backed; each row is scoped through its scorecard to a permitted application. Surfaces what the rubric actually scored. (v3 scorecard privacy gates only the private_notes free text, which lives on the scorecard row, not these structured answers — there is no row-level private-scorecard flag.) Pass scope_handle or job_ids to narrow to a requisition (auto-bridged to that scope's scorecard ids, via its applications); without one it spans all your permitted jobs. Returns the complete scoped set in one call." },
  { name: "search_my_candidate_educations", kind: "evidence", description: "Search candidate education history for candidates on the recruiter's permitted jobs. Domain class: candidate_backed; scoped through the candidate's permitted applications. Degree/discipline/school are custom_field_option_id refs — decode them with search_my_custom_field_options. Pass scope_handle or job_ids to narrow to a requisition (auto-bridged to that scope's candidate ids); without one it spans all your permitted jobs. Returns the complete scoped set in one call." },
  { name: "search_my_candidate_employments", kind: "evidence", description: "Search candidate employment history (company, title, dates) for candidates on the recruiter's permitted jobs. Domain class: candidate_backed; scoped through the candidate's permitted applications. Pass scope_handle or job_ids to narrow to a requisition (auto-bridged to that scope's candidate ids); without one it spans all your permitted jobs. Returns the complete scoped set in one call." },
  { name: "search_my_custom_fields", kind: "evidence", description: "Search custom-field definitions (id, name, name_key, field_type, value_type). Domain class: global_reference; not job-filtered. The schema dictionary naming what each org custom field is — pair with search_my_custom_field_options to decode option_id values on applications, openings, offers, users, and candidate history." },
  { name: "search_my_pay_inputs", kind: "evidence", description: "Search pay-input definitions (id, title, blurb, linked_custom_field_id). Domain class: global_reference; not job-filtered. The labels/structure of the org's pay inputs — definitions only, no compensation amounts." },
  { name: "search_my_approval_flows", kind: "evidence", description: "Search approval flows on permitted jobs (id, job_id, offer_id, approval_status, approval_type, sequential, requested_by_id, version). Domain class: job_scoped; rows are bounded to your permitted jobs. The spine of approval-bottleneck analysis; join approver groups via approval_flow_id." },
  { name: "search_my_approvers", kind: "evidence", description: "Search approver assignments bounded to permitted jobs through approver_group_id -> approval_flow_id -> job_id. Domain class: join_backed." },
  { name: "search_my_approver_groups", kind: "evidence", description: "Search approver groups bounded to permitted jobs through approval_flow_id -> job_id. Domain class: join_backed." },
  { name: "search_my_scorecard_questions", kind: "evidence", description: "Search rubric questions bounded to permitted jobs through interview_kit_id -> job_id. Domain class: join_backed." },
  { name: "search_my_scorecard_question_options", kind: "evidence", description: "Search rubric options bounded to permitted jobs through scorecard_question_id -> interview_kit_id -> job_id. Domain class: join_backed." },
  { name: "search_my_scorecard_question_answer_options", kind: "evidence", description: "Search answer-option links bounded through question answer -> scorecard -> application -> job. Domain class: join_backed." },
  { name: "search_my_interview_kits", kind: "evidence", description: "Search interview kits on permitted jobs (id, job_id, job_interview_id, exercises, anonymize flags). Domain class: job_scoped; rows are bounded to your permitted jobs. Connects rubric structure (scorecard_questions.interview_kit_id) to jobs and interview slots." },
  { name: "search_my_default_interviewers", kind: "evidence", description: "Search default interviewer assignments bounded through interview_kit_id -> job_id. Domain class: join_backed." },
  { name: "search_my_job_post_locations", kind: "evidence", description: "Search job-post locations bounded through job_post_id -> job_id. Domain class: join_backed." },
  { name: "search_my_pay_input_ranges", kind: "evidence", description: "Search advertised pay ranges bounded through job_post_id -> job_id. Domain class: join_backed." },
  { name: "search_my_interviewer_tags", kind: "evidence", description: "Search interviewer tag definitions (id, name). Domain class: global_reference; not job-filtered. Resolves interviewer tag ids to names for panel/staffing analysis." },
  { name: "search_my_candidate_tags", kind: "evidence", description: "Search candidate tag definitions (id, name). Domain class: global_reference; not job-filtered. Resolves candidate tag ids to names (candidates' tag_names come from these)." },
  { name: "search_my_prospect_pools", kind: "evidence", description: "Search prospect pools intersecting permitted jobs; mixed job_ids are redacted to the permitted intersection. Domain class: job_scoped." },
  { name: "search_my_prospect_pool_stages", kind: "evidence", description: "Search prospect-pool stages bounded through prospect_pool_id -> job_ids. Domain class: join_backed." },
  { name: "search_my_prospect_details", kind: "evidence", description: "Search prospect details for permitted applications (id, application_id, pool_id, pool_stage_id, prospect_owner_id, department_id, office_id). Domain class: application_backed; rows are bounded to applications on your permitted jobs. Where prospects sit in pools and who owns them." },
  { name: "search_my_job_boards", kind: "evidence", description: "Search job boards (id, company_name, status, internal, introduction/conclusion copy). Domain class: global_reference; not job-filtered. Which boards the org publishes to, for post-attribution analysis." },
  { name: "search_my_custom_field_departments", kind: "evidence", description: "Search custom-field department scoping rows (custom_field_id -> department_id). Domain class: global_reference; not job-filtered. Which custom fields apply to which departments." },
  { name: "search_my_custom_field_offices", kind: "evidence", description: "Search custom-field office scoping rows (custom_field_id -> office_id). Domain class: global_reference; not job-filtered. Which custom fields apply to which offices." },
  { name: "search_my_job_post_searchable_locations", kind: "evidence", description: "Search the structured locations a job post is searchable in — city, county, region, country, postal code and lat/long. Domain class: join_backed; each row is bounded through job_post_id -> the post's job. The finer location source behind coarse country-level office tags: use it when a location question needs the city a req is actually posted to." },
  { name: "search_my_applied_candidate_tags", kind: "evidence", description: "Search which candidates carry which tags (candidate_id -> candidate_tag_id). Domain class: candidate_backed; scoped through the candidate's permitted applications, and private candidates pass the same gate as every other candidate read. The pool behind a tag name — pair with search_my_candidate_tags to turn tag ids into names." },
  { name: "search_my_user_roles", kind: "evidence", description: "Search the permission-role dictionary (id, name, role_type). Domain class: global_reference; not job-filtered and it names no user. Decodes the role_id on requisition-permission rows. role_type carries only two values — job_admin and site_admin — and is what actually determines access; the role NAME is a cosmetic label an org can rename freely, so read the type, not the name." },
  { name: "search_my_user_job_permissions", kind: "evidence", description: "Search who has access to your requisitions (user_id, job_id, role_id, automated). Domain class: admin_reference, but bounded exactly like a job-scoped read — rows must carry a permitted job_id, so you see permission rows for YOUR reqs and never an org-wide access map. Answers 'who else can see this req'; decode role_id with search_my_user_roles, and read role_type rather than the role name. `automated` marks a grant a rule made rather than a person." },
  { name: "search_my_future_job_permissions", kind: "evidence", description: "Search standing grants that apply to requisitions not yet created, by department and office (user_id, role_id, department_id, office_id). Domain class: admin_reference; the row carries no job_id, so it cannot be bounded to your requisitions — it is returned to site admins and allowlisted operators only, the same line Greenhouse draws around its own permission settings. A job-scoped recruiter gets an empty result." },
  { name: "search_my_job_candidate_attributes", kind: "evidence", description: "Search the candidate attributes configured on a requisition — the named traits its scorecards rate (id, job_id, candidate_attribute_type_id, name, sort_order, active). Domain class: job_scoped; rows must carry a permitted job_id. The rubric dimension behind an attribute rating." },
  { name: "search_my_candidate_attribute_types", kind: "evidence", description: "Search the org's candidate-attribute type definitions (id, job_id, name, sort_order, active, is_draft). Domain class: job_scoped; rows must carry a permitted job_id. Note the endpoint has no job_ids filter of its own, so a scope is applied to the rows after the read rather than upstream." },
  { name: "search_my_scorecard_candidate_attributes", kind: "evidence", description: "Search the per-scorecard attribute ratings an interviewer recorded (scorecard_id, job_candidate_attribute_id, candidate_attribute_rating, note). Domain class: scorecard_backed; each row is scoped through its scorecard to a permitted application, and the free-text `note` is one interviewer's written judgement of one candidate, so private candidates pass the same gate as every other candidate read." },
  { name: "search_my_focus_candidate_attributes", kind: "evidence", description: "Search which candidate attributes an interview kit focuses on (interview_kit_id, job_candidate_attribute_id). Domain class: join_backed; bounded through interview_kit_id -> job_id. Says which traits a given interview is meant to assess." },
  { name: "search_my_scorecard_question_candidate_attributes", kind: "evidence", description: "Search which rubric question maps to which focused attribute (scorecard_question_id, focus_candidate_attribute_id). Domain class: join_backed; bounded through the rubric question and its interview kit to a permitted job. The link between a scorecard question and the trait it scores." },
  { name: "search_my_user_emails", kind: "evidence", description: "Search the staff email directory (user_id, email, verified). Domain class: sensitive_personal; returned to site admins and allowlisted operators only, who administer the directory — a job-scoped recruiter gets an empty result. Use search_my_users for a colleague's name and id." },
  { name: "search_my_bulk_requests", kind: "evidence", description: "Search the org's bulk API requests and their outcomes (bulk_action_uuid, api_endpoint, status, record_count, success_count, failure_count, requested_by_user_id, timestamps). Domain class: admin_reference; not job-filtered and it carries no candidate data. Whether a bulk job ran, when, and how much of it failed. Signed result-file URLs are not exposed." },
  { name: "get_my_bulk_request", kind: "evidence", description: "Get one bulk API request by its bulk_action_uuid, with the same outcome counts search_my_bulk_requests returns. Domain class: admin_reference; not job-filtered and it carries no candidate data. Use it when you already hold the uuid of a bulk update and want its status. The signed result-file URLs are not exposed — download them from Greenhouse." },
  { name: "search_my_blocked_spam_sources", kind: "evidence", description: "Search the org's blocked spam sources (source_type, value, note). Domain class: admin_reference; not job-filtered. The IPs, CIDR blocks, email addresses and domains the org blocks from applying — spammers, not colleagues or candidates. Explains an application that never arrived." },
  { name: "search_my_job_board_custom_locations", kind: "evidence", description: "Search the custom location labels a job board offers (greenhouse_job_board_id, value, active). Domain class: global_reference; the row carries no job_id and is board configuration, not a requisition row. Pair with search_my_job_boards." },
  { name: "search_my_email_templates", kind: "evidence", description: "Search the org's email templates (id, name, subject, body, email_type, from_type, user_id). Domain class: global_reference; not job-filtered. The company copy a rejection, an availability request or a scorecard reminder sends, and the template id such a send needs. Colleague addresses in `recipients` are returned to site admins and operators only." },
];

export type EvidenceDomainClass = HarvestScopeClass | "unsafe_unavailable";

export interface EvidenceDomainClassification {
  domain_class: EvidenceDomainClass;
  bounding_rule: string;
}

export const EVIDENCE_DOMAIN_CLASSIFICATIONS: Record<string, EvidenceDomainClassification> = Object.fromEntries(
  [...SCOPED_ENDPOINT_ADAPTERS_BY_EVIDENCE_TOOL].map(([toolName, adapter]) => [
    toolName,
    {
      domain_class: adapter.scopeClass,
      bounding_rule: adapter.boundingRule,
    },
  ])
);

export interface RunEvidenceToolOptions {
  // Internal diagnostic callers (probe.ts, leakage-sample.ts) want a BOUNDED single-page sample for
  // reachability/shape/leak checks, not the complete scoped set. Without this they would full-scan
  // every permitted job per check (read-all returns the whole set), which for an all-scope actor is a
  // very heavy readiness probe. Model-facing reads never set this — they get the complete set.
  sample?: boolean;
}

export async function runEvidenceTool(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  params: Record<string, unknown>,
  options: RunEvidenceToolOptions = {}
) {
  const adapter = getEvidenceEndpointAdapter(exposedToolName);
  if (!adapter) {
    const startedAt = runtime.now();
    const correlationId = newCorrelationId(runtime.now);
    const denied = deny(exposedToolName, "TOOL_NOT_AVAILABLE", "This tool is not available on the recruiter-scoped MCP surface.");
    const auditDenied = await emitRequiredToolAudit(runtime, exposedToolName, "evidence", startedAt, correlationId, denied, null, null, runtime.trustedActAsUser ?? null);
    return auditDenied ?? denied;
  }
  const allowedParamNames = EVIDENCE_TOOL_PARAM_NAMES.get(exposedToolName);
  // Exclusive bounds arrive marked from the schema boundary (normalizeDateRangeParamInput). The
  // marker never reaches the read; the disclosure it stands for is attached to the answer below.
  const { params: readParams, boundsTreatedInclusive } = takeExclusiveBoundDisclosure(params);
  // get_* single-record reads, and internal SAMPLE reads (probe/leakage diagnostics that want a
  // bounded page), use the single-read path. Model-facing list search_my_* reads return the COMPLETE
  // scoped set through the read-all engine (L2) so the model never hits the 100-row wall, with an
  // honest completeness/truncation envelope, and auto-bridge a confirmed scope (L1).
  const singleRead = exposedToolName.startsWith("get_") || options.sample === true;
  const result = singleRead
    ? await runScopedTool(runtime, exposedToolName, adapter.scopedToolName, readParams, "evidence", allowedParamNames)
    : await runEvidenceListRead(runtime, adapter, readParams, allowedParamNames);
  // Custom-field VALUES restricted by Greenhouse's "View Private" permission are withheld. If the
  // definitions cannot be read we cannot tell which are private, so `undefined` withholds all of
  // them for this projection rather than guessing — the fail-closed direction on a permission gate.
  const privateCustomFieldKeys = await resolvePrivateCustomFieldKeys(runtime).catch(() => undefined);
  const projected = projectEvidenceResult(result, adapter, privateCustomFieldKeys);
  // A role-gated denial's envelope is CANONICAL — one object for every gated call, whatever was
  // asked — so nothing is appended to it here. There is no answer to be one row wider than: the
  // caller received no rows, and the single roleGatedRowsWithheld note is the whole reply.
  if (projected.ok && projected.projection?.roleGatedRowsWithheld) return projected;
  if (boundsTreatedInclusive.length === 0 || !projected.ok || !projected.read) return projected;
  // v3's bracket filters do take gt/lt, but the tool advertises one string and this surface does not
  // re-advertise the object union it deleted. So the bound is widened by one instant and SAID so —
  // an answer that quietly returns a row the caller excluded is the fabrication line, not a rounding.
  return { ...projected, read: { ...projected.read, bounds_treated_inclusive: boundsTreatedInclusive } };
}

/**
 * R2c: the per-parameter text is a POINTER, not a paragraph.
 *
 * Measured on the 66-tool catalog this replaces: 619 parameters cost 109,622 B of JSON Schema, and
 * three sentences accounted for 83,170 B of it — the date-range blurb on 117 params (41,780 B), the
 * pagination convention on 157 (32,490 B), and the scope-carrier convention on 71 (14,980 B). Every
 * recruiter paid for all three on every call, at initialize, before asking anything.
 *
 * Each of those conventions is now stated ONCE, in SERVER_INSTRUCTIONS, ahead of the ~2,048-character
 * boundary several clients truncate at (test/catalog-budget.test.ts asserts both the placement and
 * the total). What stays here is the field-specific part: which id, which enum, which date.
 *
 * The bar for a description below is ~60 characters. That is not terseness for its own sake — a
 * bare parameter is worse than a short one (the model guesses), and a paragraph is worse than a
 * sentence (it displaces the answer).
 */
const PARAM_DESCRIPTIONS: Readonly<Record<string, string>> = {
  // Pagination and result shaping. The full convention is in SERVER_INSTRUCTIONS.
  cursor: "Resume an incomplete read with read.next_cursor.",
  per_page: "Max rows returned; the upstream read is unaffected.",
  ids: "Comma-separated ids of the rows this tool returns.",
  // Filters whose NAME does not say what they mean.
  active: "Only rows currently active.",
  current: "Only the row that is current now (not history).",
  open: "Only open rows.",
  live: "Only posts currently live on a board.",
  internal: "Only internal-only rows.",
  featured: "Only featured posts.",
  default: "Only the default row.",
  verified: "Only verified rows.",
  is_draft: "Only draft rows.",
  deactivated: "Only deactivated users (departed or disabled).",
  confidential: "Only confidential requisitions.",
  current_only: "Only the current version of each offer, not superseded ones.",
  show_service_accounts: "Include service accounts, which are excluded by default.",
  private: "Only private candidates.",
  email: "Exact email address to match.",
  tag: "Exact candidate tag name to match.",
  token: "Exact tracking-link slug to match.",
  primary_email: "Exact work email address to match.",
  value: "Exact value to match.",
  status: "Filter to one status.",
  external_event_id: "Exact calendar event id from the external system.",
  requisition_id: "Exact requisition id as your org writes it (e.g. REQ-1234).",
  external_office_id: "Exact office id in your HRIS, not Greenhouse's.",
  external_department_id: "Exact department id in your HRIS, not Greenhouse's.",
  bulk_action_uuid: "Exact bulk-request uuid.",
  related_post_type: "Kind of record the link points at.",
  source_type: "Kind of blocked source.",
  email_type: "Greenhouse email type; see the enum for the legal values.",
  from_type: "Which sender address the template uses.",
  stage_name: "Exact interview-stage name as configured on the job.",
  scheduling_type: "How the interview is scheduled.",
};

/** A last-resort description derived from the parameter's own name and type, so none is ever bare. */
function derivedParameterDescription(parameter: ParameterSpec): string {
  const subject = parameter.name.replace(/_ids?$/, "").replace(/_/g, " ");
  if (parameter.type === "array" || parameter.name.endsWith("_ids")) {
    return `Comma-separated ${subject} ids to filter by.`;
  }
  if (parameter.name.endsWith("_id")) {
    return `Exact ${subject} id to filter by.`;
  }
  if (parameter.type === "boolean") {
    return `Filter on ${parameter.name.replace(/_/g, " ")}.`;
  }
  return `Filter by ${parameter.name.replace(/_/g, " ")}.`;
}

function describeParameter(parameter: ParameterSpec): string {
  return PARAM_DESCRIPTIONS[parameter.name] ?? derivedParameterDescription(parameter);
}

/**
 * The marker an exclusive bound carries from the schema boundary to the read.
 *
 * `{gt}`/`{lt}` are mapped to the inclusive form — v3's bracket params take both, but the tool
 * advertises one cheap string and re-advertising exclusivity would put the object union back in the
 * catalog. Mapping silently would be the fabrication line: the model asked for "after but not
 * including" and got "at or after". So the normalized value carries this prefix, `runEvidenceTool`
 * strips it before the read, and the result says `bounds_treated_inclusive` for the fields involved.
 *
 * A caller who literally types the marker into a date string loses nothing: the prefix is stripped
 * and the read is identical — the only effect is a disclosure that is true anyway.
 */
export const EXCLUSIVE_BOUND_MARKER = "inclusive-bounds:";

const RANGE_OPERATOR_KEYS = ["gte", "lte", "gt", "lt"] as const;

/**
 * The marker a MALFORMED date object carries to the schema, so the error can name the key.
 *
 * A preprocess step cannot raise a Zod issue of its own, and returning the bad object produced
 * "Expected string, received object" — true, and useless to a model that got one key wrong out of
 * two. So the problem travels as a string the inner schema recognizes and refuses, and the message
 * the caller sees names the key. A caller who literally types this prefix into a date filter is
 * refused too, which is correct: it is not a date.
 */
export const INVALID_DATE_RANGE_MARKER = "invalid-date-range:";

/**
 * Accept the three forms a model actually sends for a date window, emit the one the read layer takes.
 *
 *   "2026-04-01T00:00:00Z"                 -> unchanged (an exact value)
 *   "2026-04-01..2026-06-30"               -> unchanged (already the advertised shorthand)
 *   {gte: "2026-04-01", lte: "2026-06-30"} -> "2026-04-01..2026-06-30"
 *   {gt: "2026-04-01"}                     -> "inclusive-bounds:2026-04-01.." + a disclosure
 *
 * A PARTIALLY malformed object is refused, not repaired. Ignoring the members it could not read left
 * `{gte: 5, lte: "2026-06-30"}` normalising to `"..2026-06-30"` — a half-window the caller never
 * asked for, silently one bound wider than the question, and `{gte: "2026-04-01", foo: 1}` was
 * accepted with the unknown key dropped. Both are the fabrication line: an answer built on a filter
 * the model did not send. `gte` with `gt` (or `lte` with `lt`) is refused for the same reason — the
 * old code picked the inclusive one and discarded the other without a word.
 *
 * A non-object value is returned untouched so the string schema — not this function — produces the
 * error, which keeps the boundary's rejection message the one the model can act on.
 */
export function normalizeDateRangeParamInput(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const operators = new Set<string>(RANGE_OPERATOR_KEYS);
  const unknownKeys = Object.keys(source).filter((key) => !operators.has(key));
  if (unknownKeys.length > 0) {
    return invalidDateRange(
      `unknown key${unknownKeys.length > 1 ? "s" : ""} ${unknownKeys.sort().map((key) => `"${key}"`).join(", ")}`
    );
  }
  const bounds: Partial<Record<(typeof RANGE_OPERATOR_KEYS)[number], string>> = {};
  for (const key of RANGE_OPERATOR_KEYS) {
    if (!(key in source)) continue;
    const bound = source[key];
    if (typeof bound !== "string" || bound.length === 0) {
      return invalidDateRange(`"${key}" must be a non-empty ISO date-time string`);
    }
    bounds[key] = bound;
  }
  if (bounds.gte !== undefined && bounds.gt !== undefined) {
    return invalidDateRange(`"gte" and "gt" are two lower bounds; send one`);
  }
  if (bounds.lte !== undefined && bounds.lt !== undefined) {
    return invalidDateRange(`"lte" and "lt" are two upper bounds; send one`);
  }
  const lower = bounds.gte ?? bounds.gt;
  const upper = bounds.lte ?? bounds.lt;
  if (lower === undefined && upper === undefined) return value;
  const exclusive = (bounds.gte === undefined && bounds.gt !== undefined)
    || (bounds.lte === undefined && bounds.lt !== undefined);
  return `${exclusive ? EXCLUSIVE_BOUND_MARKER : ""}${lower ?? ""}..${upper ?? ""}`;
}

function invalidDateRange(problem: string): string {
  return `${INVALID_DATE_RANGE_MARKER}${problem}. Send an ISO date-time, the range "2026-04-01..2026-06-30", or {gte, lte}.`;
}

/**
 * Strip the exclusive-bound markers before the read and name the fields they were on, so the answer
 * can say which windows were widened by an instant.
 */
export function takeExclusiveBoundDisclosure(
  params: Record<string, unknown>
): { params: Record<string, unknown>; boundsTreatedInclusive: string[] } {
  const boundsTreatedInclusive: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value.startsWith(EXCLUSIVE_BOUND_MARKER)) {
      boundsTreatedInclusive.push(key);
      out[key] = value.slice(EXCLUSIVE_BOUND_MARKER.length);
      continue;
    }
    out[key] = value;
  }
  return { params: out, boundsTreatedInclusive: boundsTreatedInclusive.sort() };
}

function zodSchemaForParameter(parameter: ParameterSpec): z.ZodTypeAny {
  if (parameter.name === "per_page") {
    return z.number().int().positive().optional().describe(describeParameter(parameter));
  }
  // v3's date filters (created_at/updated_at/resolved_at/sent_on/...) accept bracket ranges upstream.
  //
  // The tool boundary ADVERTISES one string: an exact ISO value, or the "START..END" shorthand,
  // either side of which may be empty ("2026-04-01.." is a floor, "..2026-06-30" a ceiling). The
  // advertised form is a string because the object form cost 357 bytes per date parameter across 117
  // of them — 41,780 B, a quarter of the whole catalog — paid by every recruiter at every initialize.
  //
  // It ACCEPTS more than it advertises, and that is the fold (Codex reproduced `-32602 Expected
  // string, received object` through a real McpServer): the truncation notes and the model's own
  // habit both produce `{"gte": ..., "lte": ...}`, which the schema rejected before the handler ever
  // ran — a hard boundary error on the exact shape the tool's own guidance suggested. The preprocess
  // below normalises the object (and a bare ISO value) into the advertised string, so the cheap
  // schema and the forgiving boundary are no longer in conflict.
  if (/(_at|_on)$/.test(parameter.name)) {
    return z
      .preprocess(
        normalizeDateRangeParamInput,
        z
          .string()
          .describe("ISO date-time, or a range 2026-04-01..2026-06-30 (either side may be empty).")
          .superRefine((value, ctx) => {
            // A malformed date object arrives here carrying its own problem statement (see
            // normalizeDateRangeParamInput): raise it as the schema issue so the -32602 the model
            // reads names the key it got wrong, instead of "Expected string, received object".
            if (!value.startsWith(INVALID_DATE_RANGE_MARKER)) return;
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: value.slice(INVALID_DATE_RANGE_MARKER.length),
            });
          })
      )
      .optional();
  }
  if (parameter.type === "boolean") {
    return z.boolean().optional().describe(describeParameter(parameter));
  }
  if (parameter.enumValues && parameter.enumValues.length > 0) {
    // The legal values live in the schema's own enum, where a client renders them. Repeating them in
    // the description would bill for the list twice.
    return z.enum(parameter.enumValues as [string, ...string[]]).optional().describe(describeParameter(parameter));
  }
  if (parameter.type === "integer" || parameter.type === "number") {
    return z.number().int().positive().optional().describe(describeParameter(parameter));
  }
  return z.string().optional().describe(describeParameter(parameter));
}
