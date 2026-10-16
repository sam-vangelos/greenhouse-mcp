import type {
  EvidenceReadEnvelope,
  RecruiterProjectionMetadata,
  RecruiterProjectionOmissionReason,
  RecruiterProjectionProfileName,
  RecruiterProjectionRequiredFieldOmission,
  RecruiterToolResult,
  RecruiterToolSuccess,
} from "../types.js";
import { readApplicationJobId } from "./application-shapes.js";
import type { EvidenceEndpointAdapter } from "./scoped-endpoint-adapters.js";
import { METRIC_REGISTRY } from "../metrics.js";
import {
  isForbiddenEvidencePayloadKey,
  looksLikeSensitiveEvidenceString,
} from "../evidence-hygiene.js";
import { getHarvestEndpointByPath } from "../harvest-v3-registry.js";

type Projector = (value: unknown) => unknown;
type FieldOmissionPolicy = {
  field: string;
  reason: RecruiterProjectionOmissionReason;
};

// Generous upper bound on a single projected string. Free text — note bodies, application
// answers, custom-field values — passes through intact; this only guards against a pathological
// payload. The prior 512 cap silently gutted any note longer than a paragraph: a present-but-
// truncated field reads to the operator as "answered" while withholding the answer, so the bound
// is now set high enough never to bite a real recruiting artifact.
const MAX_PROJECTED_STRING_LENGTH = 100_000;
// Strip dangerous control characters but PRESERVE tab, newline, and carriage return: Greenhouse
// stores note newlines verbatim, and the prior reject-any-control-char rule dropped every
// multi-line note wholesale.
const DANGEROUS_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const NUMERIC_ID_FIELD_NAMES = new Set([
  "id",
  "application_id",
  "author_id",
  "agency_id",
  "candidate_id",
  "coordinator_id",
  "copied_from_id",
  "credited_to_id",
  "current_stage_id",
  "department_id",
  "employee_id",
  "job_board_id",
  "interviewer_id",
  "interview_kit_id",
  "job_interview_id",
  "job_interview_stage_id",
  "job_id",
  "job_post_id",
  "office_id",
  "organizer_id",
  "rejected_by_id",
  "rejection_note_id",
  "reason_id",
  "recruiter_id",
  "referrer_id",
  "related_post_id",
  "source_id",
  "stage_id",
  "submitter_id",
  "user_id",
]);
const NUMERIC_ID_ARRAY_FIELD_NAMES = new Set([
  "department_ids",
  "linked_candidate_ids",
  "office_ids",
  "prospective_job_ids",
]);

const EVIDENCE_PROJECTORS = new Map<string, Projector>([
  ["search_my_jobs", projectJobData],
  ["get_my_job", projectJobData],
  ["search_my_job_owners", projectJobOwnerData],
  ["search_my_openings", projectOpeningData],
  ["search_my_job_interview_stages", projectJobInterviewStageData],
  ["search_my_job_interviews", projectJobInterviewData],
  ["search_my_interviews", projectInterviewData],
  ["search_my_application_stages", projectApplicationStageData],
  ["search_my_applications", projectApplicationData],
  ["get_my_application", projectApplicationData],
  ["search_my_candidates", projectCandidateData],
  ["get_my_candidate", projectCandidateData],
  ["search_my_scorecards", projectScorecardData],
  ["search_my_rejection_details", projectRejectionDetailData],
  ["search_my_rejection_reasons", projectRejectionReasonData],
  ["search_my_users", projectUserData],
  ["get_my_user", projectUserData],
  ["search_my_sources", projectSourceData],
  ["search_my_referrers", projectReferrerData],
  ["search_my_notes", projectNoteData],
  ["search_my_tracking_links", projectTrackingLinkData],
  ["search_my_offers", projectOfferData],
  ["search_my_departments", projectDepartmentData],
  ["search_my_offices", projectOfficeData],
  ["search_my_close_reasons", projectCloseReasonData],
  ["search_my_custom_field_options", projectCustomFieldOptionData],
  ["search_my_attachments", projectAttachmentData],
  ["search_my_job_hiring_managers", projectJobHiringManagerData],
  ["search_my_job_notes", projectJobNoteData],
  ["search_my_job_posts", projectJobPostData],
  ["search_my_interviewers", projectInterviewerData],
  ["search_my_scorecard_question_answers", projectScorecardQuestionAnswerData],
  ["search_my_candidate_educations", projectCandidateEducationData],
  ["search_my_candidate_employments", projectCandidateEmploymentData],
  ["search_my_custom_fields", projectCustomFieldData],
  ["search_my_pay_inputs", projectPayInputData],
  // Tier-3.4 exposure (audit C-DOMAINS): org-config/reference domains with no PII fields on the
  // v3 contract (approval process, scorecard rubric structure, kits, tags, pools, post locations,
  // comp ranges, boards, custom-field org joins). All pass through the shared denylist projector;
  // a factory keeps the 18 additions readable.
  ["search_my_approval_flows", denylistProjector("/v3/approval_flows")],
  ["search_my_approvers", denylistProjector("/v3/approvers")],
  ["search_my_approver_groups", denylistProjector("/v3/approver_groups")],
  ["search_my_scorecard_questions", denylistProjector("/v3/scorecard_questions")],
  ["search_my_scorecard_question_options", denylistProjector("/v3/scorecard_question_options")],
  ["search_my_scorecard_question_answer_options", denylistProjector("/v3/scorecard_question_answer_options")],
  ["search_my_interview_kits", denylistProjector("/v3/interview_kits")],
  ["search_my_default_interviewers", denylistProjector("/v3/default_interviewers")],
  ["search_my_job_post_locations", denylistProjector("/v3/job_post_locations")],
  ["search_my_pay_input_ranges", denylistProjector("/v3/pay_input_ranges")],
  ["search_my_interviewer_tags", denylistProjector("/v3/interviewer_tags")],
  ["search_my_candidate_tags", denylistProjector("/v3/candidate_tags")],
  ["search_my_prospect_pools", denylistProjector("/v3/prospect_pools")],
  ["search_my_prospect_pool_stages", denylistProjector("/v3/prospect_pool_stages")],
  ["search_my_prospect_details", denylistProjector("/v3/prospect_details")],
  ["search_my_job_boards", denylistProjector("/v3/job_boards")],
  ["search_my_custom_field_departments", denylistProjector("/v3/custom_field_departments")],
  ["search_my_custom_field_offices", denylistProjector("/v3/custom_field_offices")],
  // R2b. Post locations, applied tags and the role dictionary are id/label rows with no contact
  // field on the v3 contract (locked by the PII sweep in test/evidence.test.ts), so the shared
  // denylist projector carries every documented field through. Email templates go through it too;
  // their one sensitive field has an omission policy below.
  ["search_my_job_post_searchable_locations", denylistProjector("/v3/job_post_searchable_locations")],
  ["search_my_applied_candidate_tags", denylistProjector("/v3/applied_candidate_tags")],
  ["search_my_user_roles", denylistProjector("/v3/user_roles")],
  ["search_my_email_templates", denylistProjector("/v3/email_templates")],
  // R2d. Requisition permissions, the candidate-attribute rubric family, and the two org-diagnostic
  // dictionaries: id/label/FK rows with no contact field on the v3 contract (locked by the PII sweep
  // in test/evidence.test.ts). The scorecard-attribute row's free-text `note` passes through — it is
  // interviewer feedback, the same class as scorecard notes, and the private-candidate gate covers
  // the row upstream.
  ["search_my_user_job_permissions", denylistProjector("/v3/user_job_permissions")],
  ["search_my_job_candidate_attributes", denylistProjector("/v3/job_candidate_attributes")],
  ["search_my_candidate_attribute_types", denylistProjector("/v3/candidate_attribute_types")],
  ["search_my_scorecard_candidate_attributes", denylistProjector("/v3/scorecard_candidate_attributes")],
  ["search_my_focus_candidate_attributes", denylistProjector("/v3/focus_candidate_attributes")],
  ["search_my_scorecard_question_candidate_attributes", denylistProjector("/v3/scorecard_question_candidate_attributes")],
  ["search_my_bulk_requests", denylistProjector("/v3/bulk_requests")],
  ["get_my_bulk_request", denylistProjector("/v3/bulk_requests/{bulk_action_uuid}")],
  ["search_my_blocked_spam_sources", denylistProjector("/v3/blocked_spam_sources")],
  ["search_my_job_board_custom_locations", denylistProjector("/v3/job_board_custom_locations")],
  // Staff permission configuration and the staff email directory. Neither row carries a job_id, so
  // there is nothing to bound them to — the gate is the reader's ROLE instead of their requisitions.
  ["search_my_future_job_permissions", operatorOnlyProjector("/v3/future_job_permissions")],
  ["search_my_user_emails", operatorOnlyProjector("/v3/user_emails")],
]);

/**
 * A ROW gate, not a field gate.
 *
 * Greenhouse restricts its own permission settings and staff-directory pages to site admins. These
 * two endpoints are those pages' API, and their rows carry no job_id, so the job-scoping every other
 * read relies on has nothing to bind to — dropping fields would leave a job-scoped recruiter holding
 * a row of ids that still discloses that a colleague holds a grant. So the whole row is withheld for
 * anyone but a site admin or an allowlisted operator, and the tool description says so rather than
 * returning an unexplained empty list.
 *
 * This is the ONE narrowing in R2d, and its citation is the second line of the charter: never
 * silently grant access the org's own Greenhouse permissions deny. It is not a fail-closed on an
 * unknown question — the same read, run by the site admin who administers the directory, returns
 * every row.
 */
function operatorOnlyProjector(endpointPath: string): (value: unknown) => unknown {
  return (value) => {
    if (!isRoleGateAdmitted()) return Array.isArray(value) ? [] : null;
    return projectData(value, (row) => projectRowWithDenylist(row, endpointPath));
  };
}

/**
 * The tools whose GATE is the caller's role rather than their requisitions.
 *
 * Named as a set, not inferred from the projector, because the envelope has to be rewritten too:
 * emptying `data` after `runEvidenceListRead` has already counted the unfiltered rows leaves
 * `rowCounts.raw`, `read.raw_rows_read` and `result_truncated.rows_in_scoped_set` describing rows
 * the caller may not see — so a job-scoped recruiter filtering `user_ids=<colleague>` learns from
 * `raw: 1` vs `raw: 0` whether that colleague holds a staff-email row or a standing grant. The
 * counts ARE the disclosure; blanking only the rows does not close it.
 *
 * The read itself cannot be skipped at this layer and that is deliberate rather than lazy: the
 * caller's permission scope — the thing the gate keys off — is established BY the read (scoped-core
 * resolves the actor's scope inside `scopedRead` and reports it on the envelope), so "gate before the
 * read" would mean a second permission round-trip on every call to every tool. The rows are dropped,
 * every count is recomputed from what the caller actually receives, and the withholding is stated.
 */
const ROLE_GATED_ROW_TOOLS: ReadonlySet<string> = new Set([
  "search_my_future_job_permissions",
  "search_my_user_emails",
]);

const ROLE_GATE_NOTE =
  "This endpoint is Greenhouse's own site-admin surface (the staff directory / permission settings), "
  + "and its rows carry no job to bound them to, so it is returned to site admins and allowlisted "
  + "operators only. No rows were returned and every count in this envelope is zero — for every "
  + "caller outside that role, on every call, whatever the filter.";

function isRoleGateAdmitted(): boolean {
  return activeProjectionProfile === "operator_site_admin";
}

function isRoleGatedRead(toolName: string): boolean {
  return ROLE_GATED_ROW_TOOLS.has(toolName) && !isRoleGateAdmitted();
}

function denylistProjector(endpointPath: string): (value: unknown) => unknown {
  return (value) => projectData(value, (row) => projectRowWithDenylist(row, endpointPath));
}

export const EVIDENCE_PROJECTOR_TOOL_NAMES = [...EVIDENCE_PROJECTORS.keys()].sort();

const DEFAULT_PROJECTION_PROFILE = "recruiter_default";

// The generated endpoint contract is the outer allowlist; the policies below are the second-stage
// privacy denylist applied to documented fields. Each privacy drop cites a real reason — true
// candidate PII, note email metadata, the scorecard private-notes the "see private notes"
// permission gates, the interview video URL, user email addresses. This is the ambition-by-default
// posture: a trusted recruiter sees on the analysis surface what they already see in the Greenhouse
// UI for their permitted jobs. The prior allowlist dropped every operational field by default and
// labeled most of them "role_gated" — a label the code conceded gated nothing — which suppressed
// custom_fields, scorecard/note text, candidate tags, offer comp, interview instructions, and any
// field a future v3 version adds. Unknown future fields now fail closed until the generated registry
// is refreshed. Note free-text bodies are gated SEPARATELY on per-note visibility
// (see projectNoteRow), not dropped wholesale.
const DEFAULT_OMISSION_POLICIES_BY_ENDPOINT = new Map<string, FieldOmissionPolicy[]>([
  ["/v3/applications", [
    // Denormalized candidate embed: the application already carries candidate_id, and candidate
    // data flows through search_my_candidates with its own PII projection. Dropping the embed keeps
    // candidate names/resume from bleeding onto the application surface. (Also dropped globally.)
    { field: "candidate", reason: "privacy" },
    // The nested `jobs:[{id,name}]` production shape is denormalized noise; job_id (derived from it
    // by readApplicationJobId) is the canonical scalar. Drop the embed so it does not co-exist with job_id.
    { field: "jobs", reason: "not_material" },
  ]],
  ["/v3/application_stages", [
    // stage_name / stage_rank are NOT part of the v3 /application_stages contract; surfacing them
    // would present non-emitted fields as authoritative (anti-hallucination). The real stage name
    // resolves from /v3/job_interview_stages. This is a contract-cited drop, not a richness clamp —
    // every documented application_stages field still passes through.
    { field: "stage_name", reason: "not_material" },
    { field: "stage_rank", reason: "not_material" },
  ]],
  ["/v3/candidates", [
    // Candidate name, email addresses and phone numbers PASS on the candidate's own row (design
    // decision 2026-09-02, CLO-269): Greenhouse shows all of them to every Job Admin on the job, and a
    // recruiter who cannot see a name cannot act on "where is Jane Doe in process". They stay in the
    // GLOBAL list (a name must never bleed through a nested embed on another endpoint); the
    // endpoint-scoped pass-through set below re-admits them on /v3/candidates only.
    //
    // Physical/mailing addresses are home-location PII the analysis surface does not need — dropped.
    // Endpoint-scoped (NOT global) so office/job-post location addresses on other endpoints, which are
    // operational not personal, still pass through.
    { field: "addresses", reason: "privacy" },
    // Deliberately NOT dropped: social_media_addresses + website_addresses are professional-discovery
    // URLs (LinkedIn, portfolio) a recruiter legitimately uses and already sees in Greenhouse — passing
    // them is capability, not a leak. The policy split (pass identity/contact + professional URLs,
    // drop home address + raw profile) is locked in test/evidence.test.ts so neither half drifts.
    { field: "raw_profile", reason: "privacy" },
    { field: "message", reason: "privacy" },
  ]],
  ["/v3/attachments", [
    // Expiring signed download capabilities stay server-side. File listings are metadata-only;
    // read_my_resume obtains a fresh URL after a new permission-scoped lookup.
    { field: "url", reason: "privacy" },
  ]],
  // /v3/interviews drops nothing. `video_conferencing_url` is the JOIN LINK for an interview this
  // recruiter coordinates — the same link Greenhouse shows them on the interview record and the same
  // one their calendar invite carries. It was dropped as "privacy" with no permission behind it:
  // there is no Greenhouse gate on the meeting URL of an interview you can already see, and without
  // it "send me the link for tomorrow's onsite" is unanswerable from the tool.
  ["/v3/scorecards", [
    { field: "private_notes", reason: "privacy" },
    { field: "private_notes_with_tags", reason: "privacy" },
  ]],
  ["/v3/notes", [
    { field: "email_attachment_file_names", reason: "privacy" },
    { field: "email_cc", reason: "privacy" },
    { field: "email_from", reason: "privacy" },
    { field: "email_to", reason: "privacy" },
  ]],
  ["/v3/tracking_links", [
    // `token` is RESTORED (R2a) — see EVIDENCE_HYGIENE_EXEMPTIONS below. A tracking-link token is a
    // public attribution slug that appears in the job-board URL a candidate clicks; it is not a
    // credential, and dropping it left the row unable to answer the one question it exists for
    // ("which link did this application come from"). It was only ever dropped because its KEY NAME
    // ends in "token" and trips the credential-hygiene substring rule.
    //
    // `url` stays dropped, and for a reason that survives: /v3/tracking_links documents no `url`
    // response field at all, so a `url` key on a row is an undocumented shape the contract allowlist
    // would reject anyway.
    { field: "url", reason: "not_material" },
  ]],
  ["/v3/job_owners", [
    { field: "email", reason: "privacy" },
    { field: "phone", reason: "privacy" },
  ]],
  // /v3/rejection_reasons drops nothing. `private_note` was withheld from recruiters for
  // "near-zero analytic value" — an editorial judgement, not a permission. It is an admin-authored
  // annotation ON A REFERENCE CATALOG ("use this reason only for agency submissions"), not candidate
  // data, and Greenhouse shows the rejection-reason catalogue to every job admin.
  //
  // The policy was also INERT, which is worth saying because it is why removing it changes no row:
  // the v3 contract documents exactly `created_at, id, name, type, updated_at` on this endpoint, and
  // projectRowWithDenylist allows only documented fields — so `private_note` never reached the
  // denylist. What the removal changes is the reason the model is told. An omission labelled
  // "privacy" claims a permission is withholding the field; the truth is that v3 does not return it,
  // which is what "not_projected" says. If a contract refresh ever documents it, nothing here stands
  // in the way of a job-scoped recruiter reading it.
  ["/v3/email_templates", [
    // `recipients` is free text that can hold colleague addresses (the cc list a
    // template sends to). The 2026-09-02 teammate-email rule puts teammate email behind the same line as the
    // staff directory: site admins and operators see it, a job-scoped line recruiter does not. It is
    // restored for that profile in PROFILE_FIELD_RESTORES, exactly like /v3/users.primary_email.
    //
    // Nothing ELSE on the row is withheld. `body`, `subject` and `html_body` are company copy every
    // recruiter already sends, and `user_id` is an id, not contact data. The legacy control-plane
    // package still gates this endpoint behind its Tier-3 doctrine (its own list_email_templates
    // registration): that gate cited an "expanded access" posture rather than a Greenhouse
    // permission, and it does not govern this scoped recruiter surface, where the recruiter's own
    // permissions are enforced per read. (Naming that package's file by PATH in this comment trips
    // the raw-client import boundary in scripts/verify-guards.mjs, which greps source text for it.)
    { field: "recipients", reason: "privacy" },
  ]],
  ["/v3/bulk_requests", [
    // An integration endpoint the org's own automation posts back to, in the same credential-hygiene
    // class as a token: a callback URL frequently carries its own auth in the query string, and a
    // model reading the recruiter surface has no use for the address a vendor calls. The tool's
    // description promises "whether a bulk job ran, when, and how much of it failed" — the counts,
    // the status, and the timestamps, all of which still pass.
    { field: "callback_url", reason: "privacy" },
    // An arbitrary vendor payload echoed back from that callback: unbounded, unschematized, and
    // outside the contract's own field list in everything but name.
    { field: "callback_response", reason: "not_material" },
  ]],
  ["/v3/bulk_requests/{bulk_action_uuid}", [
    // The single read adds two SIGNED, EXPIRING result-file URLs to the list row. Same class as an
    // attachment's signed download URL and dropped for the same reason: a capability to fetch a file
    // must not be handed to a model as data. `results_urls_expire_at` / `results_urls_expire_in` are
    // kept — they say how long the files remain fetchable in Greenhouse itself.
    { field: "success_results_url", reason: "privacy" },
    { field: "failure_results_url", reason: "privacy" },
    // Same two integration fields the list read drops, for the same reasons.
    { field: "callback_url", reason: "privacy" },
    { field: "callback_response", reason: "not_material" },
  ]],
  // /v3/blocked_spam_sources drops nothing, INCLUDING `value` on an email_address row. The address
  // IS the blocklist entry the recruiter maintains — the spammer they blocked — not a candidate's
  // or a colleague's contact detail, and withholding it leaves the tool unable to answer the one
  // question it exists for ("why did this application never arrive").
  ["/v3/users", [
    // Restored for site admins and operators by PROFILE_FIELD_RESTORES below — they administer the
    // staff directory. A job-scoped line recruiter gets names and ids. (Teammate-email rule, 2026-09-02.)
    { field: "primary_email", reason: "privacy" },
    { field: "emails", reason: "privacy" },
    { field: "email", reason: "privacy" },
    { field: "phone", reason: "privacy" },
  ]],
]);

// Per-endpoint drop set the row projector consults. Derived from the policy map so the manifest
// labels and the actual drops can never drift apart.
const PII_DENYLIST_BY_ENDPOINT: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  [...DEFAULT_OMISSION_POLICIES_BY_ENDPOINT].map(([endpoint, policies]) => [
    endpoint,
    new Set(policies.map((policy) => policy.field)) as ReadonlySet<string>,
  ])
);

// Note body fields are withheld only when the note's visibility requires the "see private notes"
// permission (`privately_visible`). `publicly_visible` and `admin_only_visible` bodies pass — a Job
// Admin sees both in Greenhouse. Listed here so the omission manifest labels them "privacy" when a
// visibility gate (rather than the PII denylist) is what dropped them.
const NOTE_VISIBILITY_GATED_FIELDS = new Set(["body", "body_with_tags", "subject"]);
// A recruiter operating as a Job Admin sees publicly_visible and admin_only_visible notes; only
// privately_visible requires the separate "see private notes" permission. The body gate keeps the
// body for the two visible classes and fails CLOSED on anything else.
const PUBLIC_NOTE_VISIBILITY = "publicly_visible";
const ADMIN_NOTE_VISIBILITY = "admin_only_visible";

// Contact and candidate-profile PII that must never reach the projection, at ANY nesting depth and
// on ANY endpoint — the one narrowing the charter keeps unconditionally. These names are never
// operational on any surface (no endpoint legitimately keeps a raw email, phone, resume, or
// raw_profile), so dropping them globally also defends against a denormalized embed bleeding
// candidate PII onto another row (an application carrying a nested `candidate` blob, a rejection
// reason's `type.email`). first_name/last_name are global too — a candidate's name must never bleed
// through a nested embed — and are re-allowed ONLY on /v3/users (projectUserRow), where a teammate's
// name is operational. The bare `candidate` embed key is dropped everywhere: the row's own candidate
// projection is canonical, the embed is denormalized PII-bearing noise.
export const GLOBAL_PII_FIELD_NAMES: ReadonlySet<string> = new Set([
  "email",
  "emails",
  "email_addresses",
  "primary_email",
  "phone",
  "phone_numbers",
  "candidate_email",
  "candidate_name",
  "candidate_first_name",
  "candidate_last_name",
  "candidate_phone",
  "first_name",
  "last_name",
  "preferred_name",
  // A bare `candidate` object is always a denormalized person embed (the reference is candidate_id);
  // drop it wherever it appears so candidate PII cannot ride along on another endpoint's row.
  "candidate",
  "resume",
  "attachments",
  "raw_profile",
  "message",
  // The "see private notes" permission gates these wherever they appear (scorecards, or a nested
  // application embed), so they drop globally rather than only on /v3/scorecards.
  "private_notes",
  "private_notes_with_tags",
]);
// Resume documents are PII-bearing candidate content. Inline resume/attachment embeds are dropped;
// the documented /v3/attachments surface exposes metadata only and read_my_resume is the explicit,
// permission-scoped content exception.

function isGlobalPiiFieldName(key: string): boolean {
  return GLOBAL_PII_FIELD_NAMES.has(key);
}

// Single source of truth for "this omitted field would block a real metric": the registered
// metrics' requiredFields, keyed by the ENDPOINT each metric reads them from. Prior code cited
// facts that don't exist (candidate_profile_fact, rejection_reason_fact, job_org_dimension) or
// that never read the field (scorecard_fact.notes, note_activity_fact.body), so honest reads were
// falsely flagged incomplete. (endpoint, field) -> metric ids.
const METRIC_IDS_BY_ENDPOINT_FIELD: ReadonlyMap<string, string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const metric of METRIC_REGISTRY) {
    for (const endpointPath of metric.requiredFieldEndpoints) {
      for (const field of metric.requiredFields) {
        const key = `${endpointPath}\u0000${field}`;
        const ids = map.get(key) ?? [];
        ids.push(metric.id);
        map.set(key, ids);
      }
    }
  }
  return map;
})();

/**
 * Which registered metrics an omitted field actually BLOCKS on THIS endpoint.
 *
 * The map used to be keyed by field ALONE and consulted on every endpoint's projection, so a
 * projection that dropped `status` from `/v3/prospect_pools` — an endpoint that carries no offers
 * at all — announced that the HIRE COUNT could not be answered. A false blocker on a read that was
 * fine is how an operator learns to ignore the disclosure block, which costs more than the noise.
 *
 * There is no field-global fallback any more. Every metric declares the endpoint its required
 * fields are read from — its single fact builder's own `requiredEndpoints` (facts.ts) — so the
 * "we don't know, assume everywhere" branch has nothing left to serve and is gone. Endpoint paths
 * are matched VERBATIM: `/offers` is not `/v3/offers`, and every production caller is a canonical
 * registry adapter.
 */
export function metricsBlockedByOmittedField(endpointPath: string, field: string): string[] {
  return METRIC_IDS_BY_ENDPOINT_FIELD.get(`${endpointPath}\u0000${field}`) ?? [];
}

/**
 * Custom-field VALUES restricted by Greenhouse's "View Private" permission.
 *
 * `undefined` means the definition set could not be read, and every custom-field value is withheld
 * — we cannot tell which are private, so none are shown. An empty set means the read succeeded and
 * nothing is private. Scoped synchronously around one projection, exactly like the profile above.
 */
let activePrivateCustomFieldKeys: ReadonlySet<string> | undefined = new Set();
let privateCustomFieldKeysKnown = true;

/** Drop custom-field values the acting human's Greenhouse permissions do not cover, at ANY depth. */
function stripPrivateCustomFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPrivateCustomFields);
  if (!isRecord(value)) return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (key !== "custom_fields") {
      result[key] = stripPrivateCustomFields(entry);
      continue;
    }
    if (!privateCustomFieldKeysKnown) continue;
    if (!isRecord(entry)) {
      result[key] = entry;
      continue;
    }
    const kept: Record<string, unknown> = {};
    for (const [name, fieldValue] of Object.entries(entry as Record<string, unknown>)) {
      if (activePrivateCustomFieldKeys?.has(name)) continue;
      kept[name] = fieldValue;
    }
    result[key] = kept;
  }
  return result;
}

export function projectEvidenceResult(
  result: RecruiterToolResult,
  adapter?: EvidenceEndpointAdapter,
  privateCustomFieldKeys?: ReadonlySet<string>
): RecruiterToolResult {
  if (!result.ok) return result;
  const projector = EVIDENCE_PROJECTORS.get(result.toolName);
  // Select the projection profile from the read's own permission-scope kind (the truthful role
  // signal), scoped synchronously around this projection so concurrent-looking callers can't bleed.
  const previousProfile = activeProjectionProfile;
  const previousKeys = activePrivateCustomFieldKeys;
  const previousKnown = privateCustomFieldKeysKnown;
  activeProjectionProfile = profileForPermissionScope(result.permissionScope);
  activePrivateCustomFieldKeys = privateCustomFieldKeys;
  privateCustomFieldKeysKnown = privateCustomFieldKeys !== undefined;
  try {
    if (isRoleGatedRead(result.toolName)) return roleGateDeniedResult(result, adapter);
    const projected = projector ? projector(result.data) : result.data;
    const data = stripPrivateCustomFields(projected);
    return {
      ...result,
      data,
      ...(adapter ? { projection: buildProjectionMetadata(adapter, result.data, data) } : {}),
    };
  } finally {
    activeProjectionProfile = previousProfile;
    activePrivateCustomFieldKeys = previousKeys;
    privateCustomFieldKeysKnown = previousKnown;
  }
}

/**
 * The denied envelope is ONE object, built from scratch, identical for every gated call.
 *
 * Zeroing the counts was half a fix: everything that was not a count went on describing the read.
 * `pages_read` and `per_page` said how much upstream work the filter caused; `pagination_truncated`
 * and `next_cursor` said whether there was more of it; `cache_hits` and `rate_limit_retries` varied
 * with it; `complete`/`status` could report a truncation that only a matching row could cause; and
 * `projection.omittedFields` was derived from the SOURCE row, so an existing id spelled out
 * `["email","id","user_id","verified"]` while a missing one returned `[]` — the withheld row's own
 * field names, handed to the caller who may not see the row.
 *
 * So nothing here is carried over from the read. The envelope is composed of constants plus the
 * caller's own identity and permission scope (their own, never the target's), which makes the reply
 * to `user_ids=<a colleague who holds a row>`, to `user_ids=<an id nobody holds>` and to a match
 * spanning three pages the same object, field for field. That is the property the gate needs; a
 * shape assembled by subtraction from the real result can only ever approach it.
 *
 * The pagination and cost fields are ABSENT rather than zeroed: there is no honest zero for "pages
 * this caller is not being told about", and an absent field claims nothing. `complete: true` /
 * `status: "complete"` are the truth of what the caller received — a complete answer to a refused
 * question — not a claim about the upstream page.
 *
 * NOT canonicalized, deliberately: the operator's own audit record (`evidence-read.ts`, emitted from
 * the pre-projection result). It keeps the raw counts. It is the operator's log of what the service
 * did on Greenhouse's behalf, never returned to the model, and an audit trail that lied about the
 * rows a read touched would be useless for exactly the review this gate exists to survive.
 */
function roleGateDeniedResult(
  result: RecruiterToolSuccess,
  adapter?: EvidenceEndpointAdapter
): RecruiterToolResult {
  return {
    ok: true,
    toolName: result.toolName,
    ...(result.actorId === undefined ? {} : { actorId: result.actorId }),
    ...(result.effectiveActorId === undefined ? {} : { effectiveActorId: result.effectiveActorId }),
    scoped: result.scoped,
    ...(result.permissionScope ? { permissionScope: result.permissionScope } : {}),
    rowCounts: { raw: 0, returned: 0, permissionExcluded: 0, unresolved: 0, status: "complete" },
    data: [],
    nextCursor: null,
    read: { ...ROLE_GATE_DENIED_READ, warnings: [] },
    ...(adapter
      ? {
          projection: {
            endpointPath: adapter.endpointPath,
            profile: activeProjectionProfile,
            omittedFields: [],
            requiredFieldOmissions: [],
            incompleteProjection: false,
            roleGatedRowsWithheld: { reason: "privacy" as const, note: ROLE_GATE_NOTE },
          },
        }
      : {}),
  };
}

const ROLE_GATE_DENIED_READ: EvidenceReadEnvelope = {
  complete: true,
  status: "complete",
  rows_returned: 0,
  raw_rows_read: 0,
  permission_excluded: 0,
  unresolved_scope_rows: 0,
  warnings: [],
};

function projectJobData(value: unknown): unknown {
  return projectData(value, projectJobRow);
}

function projectApplicationData(value: unknown): unknown {
  return projectData(value, projectApplicationRow);
}

function projectJobOwnerData(value: unknown): unknown {
  return projectData(value, projectJobOwnerRow);
}

function projectOpeningData(value: unknown): unknown {
  return projectData(value, projectOpeningRow);
}

function projectJobInterviewStageData(value: unknown): unknown {
  return projectData(value, projectJobInterviewStageRow);
}

function projectJobInterviewData(value: unknown): unknown {
  return projectData(value, projectJobInterviewRow);
}

function projectInterviewData(value: unknown): unknown {
  return projectData(value, projectInterviewRow);
}

function projectApplicationStageData(value: unknown): unknown {
  return projectData(value, projectApplicationStageRow);
}

function projectCandidateData(value: unknown): unknown {
  return projectData(value, projectCandidateRow);
}

function projectScorecardData(value: unknown): unknown {
  return projectData(value, projectScorecardRow);
}

function projectRejectionDetailData(value: unknown): unknown {
  return projectData(value, projectRejectionDetailRow);
}

function projectRejectionReasonData(value: unknown): unknown {
  return projectData(value, projectRejectionReasonRow);
}

function projectUserData(value: unknown): unknown {
  return projectData(value, projectUserRow);
}

function projectSourceData(value: unknown): unknown {
  return projectData(value, projectSourceRow);
}

function projectReferrerData(value: unknown): unknown {
  return projectData(value, projectReferrerRow);
}

function projectNoteData(value: unknown): unknown {
  return projectData(value, projectNoteRow);
}

function projectTrackingLinkData(value: unknown): unknown {
  return projectData(value, projectTrackingLinkRow);
}

function projectOfferData(value: unknown): unknown {
  return projectData(value, projectOfferRow);
}

function projectData(value: unknown, projector: (row: Record<string, unknown>) => Record<string, unknown>): unknown {
  if (Array.isArray(value)) {
    return value.filter(isRecord).map(projector);
  }
  if (isRecord(value)) {
    return projector(value);
  }
  return value === null ? null : null;
}

// The contract projector: pass documented fields through except the endpoint's PII denylist and any
// key the centralized payload-hygiene boundary forbids. Numeric ids keep their existing validation;
// every other value (scalar, nested object, array) is sanitized recursively but NOT dropped for
// being operational. This is the inverse of the prior pickScalars allowlist.
// T3.3 role-aware projection profiles. The role signal is the read's permission-scope kind
// (operator/all = a site admin or allowlisted operator; jobs = a line recruiter), threaded through
// a sync module-scoped active profile set by projectEvidenceResult around each projection. Profiles
// only ever RESTORE fields the actor's Greenhouse role already shows them (never candidate contact
// PII, which stays dropped for LLM-context hygiene on every profile):
//   - operator_site_admin: colleagues' work emails on /v3/users (the staff directory an admin
//     administers) and the admin-authored /v3/rejection_reasons.private_note (config annotation).
// The remaining named profiles are aliases of recruiter_default until a real, externally-grounded
// difference exists for them — documented as identical rather than decoratively distinct.
const PROFILE_FIELD_RESTORES: ReadonlyMap<RecruiterProjectionProfileName, ReadonlyMap<string, ReadonlySet<string>>> = new Map([
  ["operator_site_admin", new Map([
    ["/v3/users", new Set(["primary_email", "emails", "email"])],
    ["/v3/email_templates", new Set(["recipients"])],
    // The staff directory's whole payload. `email` is in GLOBAL_PII_FIELD_NAMES, so without this
    // entry the row gate admitted the site admin and the field guard then handed them
    // `{user_id, verified}` — a directory read with no addresses in it, while the tool description
    // promised the address. Same line as /v3/users.primary_email: the admin who administers the
    // directory sees it, and nobody else receives the row at all.
    ["/v3/user_emails", new Set(["email"])],
  ])],
]);

let activeProjectionProfile: RecruiterProjectionProfileName = DEFAULT_PROJECTION_PROFILE;

/**
 * The projection profile, decided by a PROVEN role signal — never by the scope's `kind`.
 *
 * `kind: "all"` is not a role. Two different actors reach it: a Greenhouse site admin, whose
 * `/v3/users.site_admin` flag the site-admin provider read (it stamps `siteAdmin: true` on the scope
 * it returns), and an ordinary job admin holding an all-jobs grant on `/v3/user_job_permissions`,
 * whom the base provider widens to the same shape with no role behind it (scoped-core
 * `rowGrantsAllJobAccess`). Keying the admin projection off `kind` handed the second actor the
 * first's view — the staff email directory, standing permission grants, and email-template
 * recipients — which is exactly the side door around Greenhouse's own permissions this surface must
 * never open. (It also fixes the week-one `users.primary_email` restore, which had the same bug with
 * less exposure.)
 *
 * `kind: "operator"` IS proven: it is reached only for an actor id in the operator allowlist
 * (scoped-core checks `operatorActorIds` before any provider runs), so it needs no extra stamp.
 *
 * The flag is read on a JOB scope too, and that is the second half of the same point: a site admin
 * narrowed to explicit grants (the site-admin wrapper's fail-closed when it cannot read which jobs
 * Greenhouse restricts) is still a site admin. Kind answers "which jobs"; the stamp answers "which
 * role"; each gate reads the one it means.
 */
export function profileForPermissionScope(
  scope: { kind?: string; siteAdmin?: boolean } | undefined
): RecruiterProjectionProfileName {
  if (scope?.kind === "operator") return "operator_site_admin";
  if (scope?.siteAdmin === true) return "operator_site_admin";
  return DEFAULT_PROJECTION_PROFILE;
}

function isRestoredForActiveProfile(endpointPath: string, key: string): boolean {
  return PROFILE_FIELD_RESTORES.get(activeProjectionProfile)?.get(endpointPath)?.has(key) ?? false;
}

// Identity and contact fields that pass on the candidate's OWN row for every profile. These names
// are also in GLOBAL_PII_FIELD_NAMES so they still drop at any depth on any other endpoint (a
// nested `candidate` embed, a custom field named first_name); this set re-admits them only where
// the row IS the candidate. Home addresses and raw_profile are not in it on purpose.
// (Only documented /v3/candidates response fields — the contract allowlist runs first, so a bare
// `email`/`phone` key, which v3 never emits on a candidate row, could not pass even if listed.)
export const CANDIDATE_IDENTITY_FIELD_NAMES: ReadonlySet<string> = new Set([
  "first_name",
  "last_name",
  "preferred_name",
  "email_addresses",
  "phone_numbers",
]);

const ENDPOINT_PII_PASSTHROUGH: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["/v3/candidates", CANDIDATE_IDENTITY_FIELD_NAMES],
]);

function isEndpointPassthrough(endpointPath: string, key: string): boolean {
  return ENDPOINT_PII_PASSTHROUGH.get(endpointPath)?.has(key) ?? false;
}

/**
 * The endpoint+field pairs exempt from the credential-hygiene key rule.
 *
 * `isForbiddenEvidencePayloadKey` (evidence-hygiene.ts) drops any key ending in "token" — a
 * substring rule, deliberately blunt, because it guards against a Bearer credential or a session
 * token reaching a model payload from anywhere. Two documented v3 fields are caught by that rule and
 * are not credentials at all; a sweep of the whole generated contract (test/evidence.test.ts) finds
 * exactly these two and fails if a third appears:
 *
 *   /v3/tracking_links.token   the public attribution slug in the job-board URL a candidate clicks;
 *                              the field the endpoint exists to return.
 *   /v3/job_boards.url_token   the public slug in that board's own public URL, and the join between
 *                              a board and the applications that came through it — without it
 *                              `search_my_job_boards`'s promised "post-attribution analysis" cannot
 *                              be done at all.
 *
 * The guard itself is NOT relaxed — it still runs on every other key, at every nesting depth, on
 * every endpoint including these two — because a nested `token` on a tracking-link row would not be
 * a slug. Only these exact top-level pairs are exempt, so a future endpoint whose row carries a real
 * token cannot inherit the exemption by accident.
 */
export const EVIDENCE_HYGIENE_EXEMPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["/v3/tracking_links", new Set(["token"])],
  ["/v3/job_boards", new Set(["url_token"])],
]);

function isHygieneExempt(endpointPath: string, key: string): boolean {
  return EVIDENCE_HYGIENE_EXEMPTIONS.get(endpointPath)?.has(key) ?? false;
}

function projectRowWithDenylist(
  row: Record<string, unknown>,
  endpointPath: string
): Record<string, unknown> {
  const denylist = PII_DENYLIST_BY_ENDPOINT.get(endpointPath);
  const documentedFields = new Set(
    (getHarvestEndpointByPath(endpointPath)?.responseFields ?? []).map((field) => field.name)
  );
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    // The generated Harvest contract is the projection allowlist. Endpoint-specific projectors
    // below may add deliberate derived aliases, but an unknown future top-level field fails closed.
    if (!documentedFields.has(key)) continue;
    const restored = isRestoredForActiveProfile(endpointPath, key) || isEndpointPassthrough(endpointPath, key);
    if (denylist?.has(key) && !restored) continue;
    if (isGlobalPiiFieldName(key) && !restored) continue;
    if (isForbiddenEvidencePayloadKey(key) && !isHygieneExempt(endpointPath, key)) continue;
    const projectedValue = NUMERIC_ID_FIELD_NAMES.has(key)
      ? projectNumericId(value)
      : NUMERIC_ID_ARRAY_FIELD_NAMES.has(key)
        ? projectNumericIdArray(value)
        : sanitizeProjectedValue(value);
    if (projectedValue !== undefined) {
      projected[key] = projectedValue;
    }
  }
  return projected;
}

function projectJobRow(row: Record<string, unknown>): Record<string, unknown> {
  return projectRowWithDenylist(row, "/v3/jobs");
}

function projectApplicationRow(row: Record<string, unknown>): Record<string, unknown> {
  const projected = projectRowWithDenylist(row, "/v3/applications");
  // job_id must survive the nested `jobs:[{id}]` production shape, not only the flat `job_id`
  // field. readApplicationJobId handles flat, nested `job.id`, and the `jobs[]` array.
  const jobId = readApplicationJobId(row);
  if (jobId !== null) projected.job_id = jobId;
  // current_stage is a stage REFERENCE (id + name). Prune it to that ref rather than passing the
  // whole nested object, so a denormalized stage embed cannot bleed an interviewer/entity graph
  // onto the surface — the full stage detail comes from search_my_job_interview_stages.
  const stage = projectStageReference(row.current_stage);
  if (stage) projected.current_stage = stage;
  else delete projected.current_stage;
  // Defensive, not a capability: Harvest v3 application rows carry candidate_id only (no embed
  // in the contract, no adapter expands one), so this branch is inert on live v3 responses. If a
  // future revision or an expand ever embeds `candidate`, the denylist and the global list drop
  // the raw object before this runs and only {id, first_name, last_name} is rebuilt here — never
  // email/phone/raw_profile. Naming the stalest candidates on a req is a candidate_ids ->
  // search_my_candidates join, which the candidate row now serves.
  const candidate = projectCandidateReference(row.candidate);
  if (candidate) projected.candidate = candidate;
  return projected;
}

function projectCandidateReference(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const reference: Record<string, unknown> = {};
  const id = projectNumericId(value.id);
  if (typeof id === "number") reference.id = id;
  for (const key of ["first_name", "last_name"] as const) {
    if (typeof value[key] === "string") {
      const name = sanitizeProjectedString(value[key] as string);
      if (name !== undefined) reference[key] = name;
    }
  }
  return typeof reference.id === "number" ? reference : null;
}

function projectStageReference(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const reference: Record<string, unknown> = {};
  const id = projectNumericId(value.id);
  if (typeof id === "number") reference.id = id;
  if (typeof value.name === "string") {
    const name = sanitizeProjectedString(value.name);
    if (name !== undefined) reference.name = name;
  }
  return Object.keys(reference).length > 0 ? reference : null;
}

function projectJobOwnerRow(row: Record<string, unknown>): Record<string, unknown> {
  return projectRowWithDenylist(row, "/v3/job_owners");
}

function projectOpeningRow(row: Record<string, unknown>): Record<string, unknown> {
  return projectRowWithDenylist(row, "/v3/openings");
}

function projectJobInterviewStageRow(row: Record<string, unknown>): Record<string, unknown> {
  return projectRowWithDenylist(row, "/v3/job_interview_stages");
}

function projectJobInterviewRow(row: Record<string, unknown>): Record<string, unknown> {
  return projectRowWithDenylist(row, "/v3/job_interviews");
}

function projectInterviewRow(row: Record<string, unknown>): Record<string, unknown> {
  return projectRowWithDenylist(row, "/v3/interviews");
}

function projectApplicationStageRow(row: Record<string, unknown>): Record<string, unknown> {
  // Passthrough only copies fields PRESENT in the row, so stage_name/stage_rank (which
  // /v3/application_stages does not return) are never synthesized onto the surface.
  return projectRowWithDenylist(row, "/v3/application_stages");
}

function projectCandidateRow(row: Record<string, unknown>): Record<string, unknown> {
  const projected = projectRowWithDenylist(row, "/v3/candidates");
  const applications = readRecordArray(row.applications);
  if (applications) {
    const projectedApplications = applications.map(projectApplicationRow);
    projected.applications = projectedApplications;
    const applicationIds = projectedApplications
      .map((application) => application.id)
      .filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0);
    if (applicationIds.length > 0) projected.application_ids = applicationIds;
  } else {
    delete projected.applications;
  }
  return projected;
}

function projectScorecardRow(row: Record<string, unknown>): Record<string, unknown> {
  // notes / public_notes / *_with_tags (interviewer feedback) now pass through; only the
  // private_notes the "see private notes" permission gates are withheld (the denylist).
  return projectRowWithDenylist(row, "/v3/scorecards");
}

function projectRejectionDetailRow(row: Record<string, unknown>): Record<string, unknown> {
  return projectRowWithDenylist(row, "/v3/rejection_details");
}

function projectRejectionReasonRow(row: Record<string, unknown>): Record<string, unknown> {
  return projectRowWithDenylist(row, "/v3/rejection_reasons");
}

function projectUserRow(row: Record<string, unknown>): Record<string, unknown> {
  const projected = projectRowWithDenylist(row, "/v3/users");
  // Re-allow the teammate's name fields that the global PII guard drops: a recruiter/user name is
  // operational (you need to know which teammate) — unlike a candidate's. Email stays dropped.
  for (const field of ["first_name", "last_name", "preferred_name"]) {
    const value = sanitizeProjectedValue(row[field]);
    if (value !== undefined) projected[field] = value;
  }
  return projected;
}

function projectSourceRow(row: Record<string, unknown>): Record<string, unknown> {
  // /v3/sources is org reference data (e.g. "LinkedIn", "Employee Referral"); name is the operative
  // label analyses resolve ids into. type is a nested {id, name} object, carried through intact.
  return projectRowWithDenylist(row, "/v3/sources");
}

function projectReferrerRow(row: Record<string, unknown>): Record<string, unknown> {
  // user_id (the Greenhouse user who made the referral) now passes through, so referrals can be
  // attributed to the employee — it is an id, not contact PII.
  return projectRowWithDenylist(row, "/v3/referrers");
}

function projectNoteRow(row: Record<string, unknown>): Record<string, unknown> {
  const projected = projectRowWithDenylist(row, "/v3/notes");
  // Gate the free-text body/subject on per-note visibility. KEEP the body only when the recruiter (a
  // Job Admin) is entitled to it — publicly_visible or admin_only_visible. privately_visible needs
  // the "see private notes" permission, and an absent / unrecognized / mis-cased / whitespace-padded
  // value fails CLOSED: a private body must never slip through on a malformed visibility string.
  const visibility = typeof row.visibility === "string" ? row.visibility.trim().toLowerCase() : "";
  const bodyVisibleToRecruiter = visibility === PUBLIC_NOTE_VISIBILITY || visibility === ADMIN_NOTE_VISIBILITY;
  if (!bodyVisibleToRecruiter) {
    for (const field of NOTE_VISIBILITY_GATED_FIELDS) delete projected[field];
  }
  return projected;
}

function projectTrackingLinkRow(row: Record<string, unknown>): Record<string, unknown> {
  return projectRowWithDenylist(row, "/v3/tracking_links");
}

function projectOfferRow(row: Record<string, unknown>): Record<string, unknown> {
  const projected = projectRowWithDenylist(row, "/v3/offers");
  // v3 names the offer start date `starts_on`; tolerate v1 `starts_at` / legacy `start_date`.
  // Compensation (custom_fields) now passes through with everything else.
  const start = firstNonEmptyString(projected.starts_at, projected.start_date, projected.starts_on);
  if (start !== undefined) projected.start_date = start;
  return projected;
}

// Global-reference dictionaries (departments, offices, close_reasons, custom_field_options) are
// org reference data — id + human-readable name + structural ids (parent_id, custom_field_id),
// no candidate PII. They are the structural twins of /v3/sources and /v3/referrers, and the same
// denylist projector carries every field through; analyses resolve the *_id values these endpoints
// catalogue (department_id, office_id, close_reason_id, custom_field_option_id) into their labels.
function projectDepartmentData(value: unknown): unknown {
  return projectData(value, projectDepartmentRow);
}

function projectOfficeData(value: unknown): unknown {
  return projectData(value, projectOfficeRow);
}

function projectCloseReasonData(value: unknown): unknown {
  return projectData(value, projectCloseReasonRow);
}

function projectCustomFieldOptionData(value: unknown): unknown {
  return projectData(value, projectCustomFieldOptionRow);
}

function projectDepartmentRow(row: Record<string, unknown>): Record<string, unknown> {
  return projectRowWithDenylist(row, "/v3/departments");
}

function projectOfficeRow(row: Record<string, unknown>): Record<string, unknown> {
  return projectRowWithDenylist(row, "/v3/offices");
}

function projectCloseReasonRow(row: Record<string, unknown>): Record<string, unknown> {
  return projectRowWithDenylist(row, "/v3/close_reasons");
}

function projectCustomFieldOptionRow(row: Record<string, unknown>): Record<string, unknown> {
  return projectRowWithDenylist(row, "/v3/custom_field_options");
}

function projectAttachmentData(value: unknown): unknown {
  return projectData(value, projectAttachmentRow);
}

function projectAttachmentRow(row: Record<string, unknown>): Record<string, unknown> {
  // Stable ids, filename, type, and timestamps pass after permission scoping. The expiring signed
  // URL is withheld so only read_my_resume can consume it server-side after a fresh scoped lookup.
  return projectRowWithDenylist(row, "/v3/attachments");
}

// Job-scoped accountability reads (job_hiring_managers, job_notes, job_posts). The reader already
// bounds every row to a permitted job_id; these projectors carry the operational fields through. A
// hiring-manager row and a job-post row are id/label/board metadata with no PII. A job_note carries
// a free-text body, gated on per-note visibility exactly like a candidate note.
function projectJobHiringManagerData(value: unknown): unknown {
  return projectData(value, projectJobHiringManagerRow);
}

function projectJobNoteData(value: unknown): unknown {
  return projectData(value, projectJobNoteRow);
}

function projectJobPostData(value: unknown): unknown {
  return projectData(value, projectJobPostRow);
}

function projectJobHiringManagerRow(row: Record<string, unknown>): Record<string, unknown> {
  return projectRowWithDenylist(row, "/v3/job_hiring_managers");
}

function projectJobPostRow(row: Record<string, unknown>): Record<string, unknown> {
  return projectRowWithDenylist(row, "/v3/job_posts");
}

// Interview-panel and rubric-answer reads. The reader bounds each row through its interview /
// scorecard to a permitted application; these projectors carry the operational fields through.
// An interviewer row's email is a teammate address dropped by the global PII guard; response_status
// (the interview-invite RSVP — accepted/declined/tentative/needs_action, NOT scorecard submission)
// and the rubric answer text are the operative analytics.
function projectInterviewerData(value: unknown): unknown {
  return projectData(value, projectInterviewerRow);
}

function projectScorecardQuestionAnswerData(value: unknown): unknown {
  return projectData(value, projectScorecardQuestionAnswerRow);
}

function projectInterviewerRow(row: Record<string, unknown>): Record<string, unknown> {
  return projectRowWithDenylist(row, "/v3/interviewers");
}

function projectScorecardQuestionAnswerRow(row: Record<string, unknown>): Record<string, unknown> {
  return projectRowWithDenylist(row, "/v3/scorecard_question_answers");
}

// Candidate education / employment history — resume facts a Job Admin already sees, scoped by the
// reader to the candidate's permitted applications. company_name, title, and the
// degree/discipline/school custom_field_option_id refs pass through; the global PII guard still
// drops any candidate name/email a future embed might carry.
function projectCandidateEducationData(value: unknown): unknown {
  return projectData(value, projectCandidateEducationRow);
}

function projectCandidateEmploymentData(value: unknown): unknown {
  return projectData(value, projectCandidateEmploymentRow);
}

function projectCandidateEducationRow(row: Record<string, unknown>): Record<string, unknown> {
  return projectRowWithDenylist(row, "/v3/candidate_educations");
}

function projectCandidateEmploymentRow(row: Record<string, unknown>): Record<string, unknown> {
  return projectRowWithDenylist(row, "/v3/candidate_employments");
}

// custom_fields and pay_inputs are org SCHEMA dictionaries (definitions, not data): what custom
// fields exist and what each pay input is labelled. They make every *_custom_field_option_id and
// pay reference an analysis returns legible. No candidate PII and — for pay_inputs — no amounts (the
// shape is title/blurb/linked_custom_field_id; comp values live on offers/pay_input_ranges).
function projectCustomFieldData(value: unknown): unknown {
  return projectData(value, projectCustomFieldRow);
}

function projectPayInputData(value: unknown): unknown {
  return projectData(value, projectPayInputRow);
}

function projectCustomFieldRow(row: Record<string, unknown>): Record<string, unknown> {
  return projectRowWithDenylist(row, "/v3/custom_fields");
}

function projectPayInputRow(row: Record<string, unknown>): Record<string, unknown> {
  return projectRowWithDenylist(row, "/v3/pay_inputs");
}

function projectJobNoteRow(row: Record<string, unknown>): Record<string, unknown> {
  const projected = projectRowWithDenylist(row, "/v3/job_notes");
  // Mirror projectNoteRow: gate the free-text body on per-note visibility. A Job Admin sees
  // publicly_visible and admin_only_visible bodies; privately_visible — and any absent / unrecognized
  // / mis-cased / whitespace-padded value — fails CLOSED so a private body never slips through.
  const visibility = typeof row.visibility === "string" ? row.visibility.trim().toLowerCase() : "";
  const bodyVisibleToRecruiter = visibility === PUBLIC_NOTE_VISIBILITY || visibility === ADMIN_NOTE_VISIBILITY;
  if (!bodyVisibleToRecruiter) {
    for (const field of NOTE_VISIBILITY_GATED_FIELDS) delete projected[field];
  }
  return projected;
}

// Only a read the caller is ALLOWED to see reaches this: a role-gated denial gets the canonical
// envelope above, whose omission list is empty because the source row's field names are the row's
// existence spelled out.
/**
 * The omission manifest for one projection: what the source row carried, what the projection kept,
 * and which registered metrics the difference blocks.
 *
 * Exported so the blocker wiring can be tested at the level it actually runs — a real adapter, a
 * real row, one field really absent from the projected copy. Asserting `metricsBlockedByOmittedField`
 * alone proved the map and not the manifest, which is how four metrics kept naming fact fields the
 * source row never carries: blockers that could never fire on real data.
 */
export function buildProjectionMetadata(
  adapter: EvidenceEndpointAdapter,
  sourceData: unknown,
  projectedData: unknown
): RecruiterProjectionMetadata {
  // Record EVERY top-level field present in the source but dropped from the projection, not just the
  // hand-curated policy fields. Policy reasons are applied where known; a visibility-gated note body
  // is labeled "privacy"; anything else the denylist/hygiene path dropped is recorded as
  // "not_projected" so the omission manifest cannot under-report.
  const policyReasonByField = new Map(
    (DEFAULT_OMISSION_POLICIES_BY_ENDPOINT.get(adapter.endpointPath) ?? []).map((policy) => [policy.field, policy.reason] as const)
  );
  const projectedKeys = collectTopLevelKeys(projectedData);
  const omittedFields = [...collectTopLevelKeys(sourceData)]
    .filter((field) => !projectedKeys.has(field))
    .sort()
    .map((field) => ({
      endpointPath: adapter.endpointPath,
      field,
      reason:
        policyReasonByField.get(field)
          ?? ((adapter.endpointPath === "/v3/notes" || adapter.endpointPath === "/v3/job_notes") && NOTE_VISIBILITY_GATED_FIELDS.has(field)
            ? ("privacy" as RecruiterProjectionOmissionReason)
            : ("not_projected" as RecruiterProjectionOmissionReason)),
    }));
  // An omission BLOCKS the answer only when a registered metric actually requires that field.
  const requiredFieldOmissions: RecruiterProjectionRequiredFieldOmission[] = [];
  for (const omitted of omittedFields) {
    // Keyed by (endpoint, field), not by field alone: see metricsBlockedByOmittedField.
    for (const metricId of metricsBlockedByOmittedField(adapter.endpointPath, omitted.field)) {
      requiredFieldOmissions.push({
        metricOrFact: metricId,
        endpointPath: adapter.endpointPath,
        field: omitted.field,
        impact: "blocks_answer",
      });
    }
  }
  return {
    endpointPath: adapter.endpointPath,
    profile: activeProjectionProfile,
    omittedFields,
    requiredFieldOmissions,
    incompleteProjection: requiredFieldOmissions.length > 0,
  };
}

function collectTopLevelKeys(value: unknown): Set<string> {
  const keys = new Set<string>();
  const records = Array.isArray(value) ? value : [value];
  for (const entry of records) {
    if (isRecord(entry)) {
      for (const key of Object.keys(entry)) keys.add(key);
    }
  }
  return keys;
}

// Recursively sanitize a projected value WITHOUT dropping it for being operational. Scalars are
// cleaned; nested objects/arrays (custom_fields, answers, type, current_stage) are carried through
// with the same per-key hygiene drop applied at every level.
function sanitizeProjectedValue(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return sanitizeProjectedString(value);
  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeProjectedValue(entry))
      .filter((entry) => entry !== undefined);
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (isGlobalPiiFieldName(key)) continue;
      if (isForbiddenEvidencePayloadKey(key)) continue;
      const sanitized = sanitizeProjectedValue(nested);
      if (sanitized !== undefined) out[key] = sanitized;
    }
    return out;
  }
  return undefined;
}

function sanitizeProjectedString(value: string): string | undefined {
  if (value.length === 0) return undefined;
  if (looksLikeSensitiveEvidenceString(value)) return undefined;
  // Strip dangerous control chars, then trim edge whitespace. Internal newlines (note bodies) are
  // preserved; only leading/trailing whitespace is normalized away — the prior rule DROPPED the
  // whole field for any edge whitespace, which gutted every note ending in a newline.
  const cleaned = value.replace(DANGEROUS_CONTROL_CHARACTERS, "").trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > MAX_PROJECTED_STRING_LENGTH
    ? cleaned.slice(0, MAX_PROJECTED_STRING_LENGTH)
    : cleaned;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function projectNumericIdArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value
    .map((entry) => projectNumericId(entry))
    .filter((entry): entry is number => typeof entry === "number");
  return ids.length > 0 ? ids : undefined;
}

function projectNumericId(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function readRecordArray(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null;
  const records = value.filter(isRecord);
  return records.length > 0 ? records : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
