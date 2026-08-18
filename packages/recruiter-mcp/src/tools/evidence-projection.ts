import type {
  RecruiterProjectionMetadata,
  RecruiterProjectionOmissionReason,
  RecruiterProjectionProfileName,
  RecruiterProjectionRequiredFieldOmission,
  RecruiterToolResult,
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
]);

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
    { field: "first_name", reason: "privacy" },
    { field: "last_name", reason: "privacy" },
    { field: "preferred_name", reason: "privacy" },
    { field: "email", reason: "privacy" },
    { field: "email_addresses", reason: "privacy" },
    { field: "phone", reason: "privacy" },
    { field: "phone_numbers", reason: "privacy" },
    // Physical/mailing addresses are contact PII (home location) — dropped for LLM-context hygiene,
    // consistent with email/phone. Endpoint-scoped (NOT global) so office/job-post location addresses
    // on other endpoints, which are operational not personal, still pass through.
    { field: "addresses", reason: "privacy" },
    // Deliberately NOT dropped: social_media_addresses + website_addresses are professional-discovery
    // URLs (LinkedIn, portfolio) a recruiter legitimately uses and already sees in Greenhouse — passing
    // them is capability, not a leak. The policy split (drop contact PII, pass professional URLs) is
    // locked in evidence-projection.test.ts so neither half drifts.
    { field: "raw_profile", reason: "privacy" },
    { field: "message", reason: "privacy" },
  ]],
  ["/v3/attachments", [
    // Expiring signed download capabilities stay server-side. File listings are metadata-only;
    // read_my_resume obtains a fresh URL after a new permission-scoped lookup.
    { field: "url", reason: "privacy" },
  ]],
  ["/v3/interviews", [
    { field: "video_conferencing_url", reason: "privacy" },
  ]],
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
    // `token` is the public attribution slug, but its key name trips the centralized evidence
    // payload-hygiene boundary (no key ending in "token" may reach a projected payload), so it is
    // dropped to satisfy that guard — a real external constraint, not a richness clamp. `url` is not
    // a v3 tracking-link field and can embed the same token in a query string, so it is dropped too.
    { field: "token", reason: "privacy" },
    { field: "url", reason: "privacy" },
  ]],
  ["/v3/job_owners", [
    { field: "email", reason: "privacy" },
    { field: "phone", reason: "privacy" },
  ]],
  ["/v3/rejection_reasons", [
    // Reference-catalog admin annotation — private-labeled content, near-zero analytic value.
    { field: "private_note", reason: "privacy" },
  ]],
  ["/v3/users", [
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
const GLOBAL_PII_FIELD_NAMES = new Set([
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
// metrics' requiredFields. Prior code cited facts that don't exist (candidate_profile_fact,
// rejection_reason_fact, job_org_dimension) or that never read the field (scorecard_fact.notes,
// note_activity_fact.body), so honest reads were falsely flagged incomplete. Field -> metric ids.
const METRIC_IDS_BY_REQUIRED_FIELD: ReadonlyMap<string, string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const metric of METRIC_REGISTRY) {
    for (const field of metric.requiredFields) {
      const ids = map.get(field) ?? [];
      ids.push(metric.id);
      map.set(field, ids);
    }
  }
  return map;
})();

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
  activeProjectionProfile = profileForPermissionScope(result.permissionScope?.kind);
  activePrivateCustomFieldKeys = privateCustomFieldKeys;
  privateCustomFieldKeysKnown = privateCustomFieldKeys !== undefined;
  try {
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
    ["/v3/rejection_reasons", new Set(["private_note"])],
  ])],
]);

let activeProjectionProfile: RecruiterProjectionProfileName = DEFAULT_PROJECTION_PROFILE;

export function profileForPermissionScope(kind: string | undefined): RecruiterProjectionProfileName {
  return kind === "operator" || kind === "all" ? "operator_site_admin" : DEFAULT_PROJECTION_PROFILE;
}

function isRestoredForActiveProfile(endpointPath: string, key: string): boolean {
  return PROFILE_FIELD_RESTORES.get(activeProjectionProfile)?.get(endpointPath)?.has(key) ?? false;
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
    const restored = isRestoredForActiveProfile(endpointPath, key);
    if (denylist?.has(key) && !restored) continue;
    if (isGlobalPiiFieldName(key) && !restored) continue;
    if (isForbiddenEvidencePayloadKey(key)) continue;
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
  return projected;
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

function buildProjectionMetadata(
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
    for (const metricId of METRIC_IDS_BY_REQUIRED_FIELD.get(omitted.field) ?? []) {
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
