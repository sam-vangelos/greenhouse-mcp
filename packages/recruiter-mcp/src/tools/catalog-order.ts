/**
 * The ORDER the registrar emits the read catalog in — not a filter.
 *
 * ALL REGISTERED RECRUITER READ TOOLS ARE EXPOSED. A tool is removed from a running server only by
 * `GREENHOUSE_RECRUITER_DISABLE_TOOLS` (the denylist), which forces whoever removes it to name it and
 * to state a reason. There is no allowlist: `GREENHOUSE_RECRUITER_ALLOWED_TOOLS` was deleted in R2a
 * because it was the mechanism — a hand-maintained env list stating a count and no reason — that hid
 * 22 built, tested readers, and because it FAILED OPEN when unset, so it was never a control either.
 *
 * This list therefore has one job: put the analytical front doors and the tools a recruiter reaches
 * for first at the top of a client's tool picker, and the reference dictionaries last. It must name
 * every entry in `RECRUITER_TOOL_DEFINITIONS` and nothing else; `test/catalog-registrar.test.ts`
 * asserts that property in both directions, so adding a reader without ordering it fails the suite
 * rather than silently hiding it.
 *
 * It lives in its own leaf module so `resolvers/job-scope/capabilities` can tell the model which
 * tools it holds without importing the registrar that imports the job-scope tools.
 */
/**
 * The ANALYTICAL front doors, as distinct from the evidence readers.
 *
 * Two gates read the difference — `isToolEnabled` takes the tool's kind, and the capability
 * document lists browsing (evidence) tools separately — and both sit in modules that must not import
 * the registrar (it imports them). So the split lives here, on the same leaf as the order, and
 * `catalog-registrar.test.ts` asserts it against `RECRUITER_TOOL_DEFINITIONS` name by name, so the
 * two cannot drift.
 */
export const RECRUITER_ANALYSIS_TOOL_NAMES: ReadonlySet<string> = new Set([
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
]);

/** Evidence unless it is one of the analytical front doors — including read_my_resume, which reads a record. */
export function recruiterReadToolKind(name: string): "evidence" | "analysis" {
  return RECRUITER_ANALYSIS_TOOL_NAMES.has(name) ? "analysis" : "evidence";
}

export const RECRUITER_READ_TOOL_ORDER = [
  // Analytical front doors and scope resolution first: the routing ladder in SERVER_INSTRUCTIONS
  // tells the model to prefer these, and a client picker reads top-down.
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
  // The record surfaces a recruiter reaches for by name.
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
  "search_my_applied_candidate_tags",
  // id -> name dictionaries the catalog's own rows emit ids for: search_my_jobs returns
  // department_id/office_ids, search_my_openings returns close_reason_id, and resolve_job_scope
  // accepts free-text department and office NAMES the model otherwise cannot enumerate.
  "search_my_departments",
  "search_my_offices",
  "search_my_close_reasons",
  // Configuration, approval, rubric-structure and pool surfaces. Built and tested in week one, then
  // withheld by the deleted allowlist; ordered last because they answer follow-up questions rather
  // than opening ones, not because they are gated.
  "search_my_job_interviews",
  "search_my_tracking_links",
  "search_my_job_notes",
  "search_my_pay_inputs",
  "search_my_approval_flows",
  "search_my_approvers",
  "search_my_approver_groups",
  "search_my_scorecard_questions",
  "search_my_scorecard_question_options",
  "search_my_scorecard_question_answer_options",
  "search_my_interview_kits",
  "search_my_default_interviewers",
  "search_my_job_post_locations",
  "search_my_job_post_searchable_locations",
  "search_my_pay_input_ranges",
  "search_my_email_templates",
  "search_my_user_roles",
  "search_my_user_job_permissions",
  "search_my_future_job_permissions",
  "search_my_user_emails",
  "search_my_job_candidate_attributes",
  "search_my_candidate_attribute_types",
  "search_my_scorecard_candidate_attributes",
  "search_my_focus_candidate_attributes",
  "search_my_scorecard_question_candidate_attributes",
  "search_my_job_board_custom_locations",
  "search_my_bulk_requests",
  "get_my_bulk_request",
  "search_my_blocked_spam_sources",
  "search_my_interviewer_tags",
  "search_my_candidate_tags",
  "search_my_prospect_pools",
  "search_my_prospect_pool_stages",
  "search_my_prospect_details",
  "search_my_job_boards",
  "search_my_custom_field_departments",
  "search_my_custom_field_offices",
] as const;
