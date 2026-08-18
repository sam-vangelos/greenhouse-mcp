import type {
  RecruiterProjectionMetadata,
  RecruiterProjectionProfileName,
  RecruiterProjectionRequiredFieldOmission,
} from "./types.js";

export type FactCompletenessStatus =
  | "complete"
  | "incomplete_projection"
  | "failed_endpoint";

export interface FactBuildResult<T> {
  facts: T[];
  requiredEndpoints: string[];
  requiredProjectionProfile: RecruiterProjectionProfileName;
  completeness: FactCompletenessStatus;
  omissions: string[];
  projectionOmissions: RecruiterProjectionRequiredFieldOmission[];
}

export interface ApplicationLifecycleFact {
  application_id: number;
  job_id: number;
  candidate_id?: number;
  status?: string;
  stage_id?: number;
  source_id?: number;
  referrer_id?: number;
  credited_to_id?: number;
  coordinator_id?: number;
  recruiter_id?: number;
  job_post_id?: number;
  prospect?: boolean;
  needs_decision?: boolean;
  created_at?: string;
  rejected_at?: string;
  last_activity_at?: string;
}

export interface ApplicationStageTransitionFact {
  application_stage_id: number;
  application_id: number;
  job_interview_stage_id?: number;
  entered_at?: string;
  exited_at?: string;
  days_in_stage?: number;
  current?: boolean;
}

export interface InterviewEventFact {
  interview_id: number;
  application_id: number;
  job_id?: number;
  job_interview_id?: number;
  organizer_id?: number;
  status?: string;
  scheduled_at?: string;
  availability_received_at?: string;
  starts_at?: string;
  ends_at?: string;
  all_day_start_on?: string;
  all_day_end_on?: string;
}

export interface ScorecardFact {
  scorecard_id: number;
  application_id: number;
  candidate_id?: number;
  interviewer_id?: number;
  submitter_id?: number;
  interview_kit_id?: number;
  status?: string;
  submitted_at?: string;
  interviewed_at?: string;
  overall_rating?: string | number | boolean;
  overall_recommendation?: string | number | boolean;
  candidate_rating?: string | number | boolean;
}

export interface NoteActivityFact {
  note_id: number;
  application_id?: number;
  candidate_id?: number;
  user_id?: number;
  author_id?: number;
  type?: string;
  visibility?: string;
  private?: boolean;
  created_at?: string;
}

export interface SourceReferrerAttributionFact {
  application_id: number;
  job_id: number;
  source_id?: number;
  referrer_id?: number;
  credited_to_id?: number;
  created_at?: string;
}

export interface JobPostExposureFact {
  tracking_link_id: number;
  job_id: number;
  job_post_id?: number;
  related_post_id?: number;
  related_post_type?: string;
  source_id?: number;
  referrer_id?: number;
}

export interface OpeningHeadcountFact {
  opening_id: number;
  job_id: number;
  status?: string;
  open?: boolean;
  opened_at?: string;
  closed_at?: string;
  target_start_on?: string;
  sort_order?: number;
  close_reason_id?: number;
}

export interface OfferFact {
  offer_id: number;
  job_id: number;
  application_id?: number;
  candidate_id?: number;
  opening_id?: number;
  status?: string;
  sent_on?: string;
  resolved_at?: string;
  starts_on?: string;
  version?: number;
}

export interface JobOrgDimension {
  job_id: number;
  requisition_id?: string;
  name?: string;
  status?: string;
  confidential?: boolean;
  department_id?: number;
  office_ids?: number[];
  opened_at?: string;
  closed_at?: string;
}

export interface UserOrgDimension {
  user_id: number;
  name?: string;
  first_name?: string;
  last_name?: string;
  job_title?: string;
  deactivated?: boolean;
  department_ids?: number[];
  office_ids?: number[];
}

export function buildApplicationLifecycleFacts(
  rows: unknown,
  projection?: RecruiterProjectionMetadata
): FactBuildResult<ApplicationLifecycleFact> {
  return buildFacts(rows, projection, ["/v3/applications"], (row) => {
    const applicationId = positiveInteger(row.id);
    const jobId = positiveInteger(row.job_id);
    if (applicationId === undefined || jobId === undefined) return null;
    return compactFact({
      application_id: applicationId,
      job_id: jobId,
      candidate_id: positiveInteger(row.candidate_id),
      status: stringField(row.status),
      stage_id: positiveInteger(row.stage_id),
      source_id: positiveInteger(row.source_id),
      referrer_id: positiveInteger(row.referrer_id),
      credited_to_id: positiveInteger(row.credited_to_id),
      coordinator_id: positiveInteger(row.coordinator_id),
      recruiter_id: positiveInteger(row.recruiter_id),
      job_post_id: positiveInteger(row.job_post_id),
      prospect: booleanField(row.prospect),
      needs_decision: booleanField(row.needs_decision),
      created_at: stringField(row.created_at),
      rejected_at: stringField(row.rejected_at),
      last_activity_at: stringField(row.last_activity_at),
    });
  });
}

export function buildApplicationStageTransitionFacts(
  rows: unknown,
  projection?: RecruiterProjectionMetadata
): FactBuildResult<ApplicationStageTransitionFact> {
  return buildFacts(rows, projection, ["/v3/application_stages"], (row) => {
    const id = positiveInteger(row.id);
    const applicationId = positiveInteger(row.application_id);
    if (id === undefined || applicationId === undefined) return null;
    return compactFact({
      application_stage_id: id,
      application_id: applicationId,
      job_interview_stage_id: positiveInteger(row.job_interview_stage_id),
      entered_at: stringField(row.entered_at),
      exited_at: stringField(row.exited_at),
      days_in_stage: finiteNumber(row.days_in_stage),
      current: booleanField(row.current),
    });
  });
}

export function buildInterviewEventFacts(
  rows: unknown,
  projection?: RecruiterProjectionMetadata
): FactBuildResult<InterviewEventFact> {
  return buildFacts(rows, projection, ["/v3/interviews"], (row) => {
    const id = positiveInteger(row.id);
    const applicationId = positiveInteger(row.application_id);
    if (id === undefined || applicationId === undefined) return null;
    return compactFact({
      interview_id: id,
      application_id: applicationId,
      job_id: positiveInteger(row.job_id),
      job_interview_id: positiveInteger(row.job_interview_id),
      organizer_id: positiveInteger(row.organizer_id),
      status: stringField(row.status),
      scheduled_at: stringField(row.scheduled_at),
      availability_received_at: stringField(row.availability_received_at),
      starts_at: stringField(row.starts_at),
      ends_at: stringField(row.ends_at),
      all_day_start_on: stringField(row.all_day_start_on),
      all_day_end_on: stringField(row.all_day_end_on),
    });
  });
}

export function buildScorecardFacts(
  rows: unknown,
  projection?: RecruiterProjectionMetadata
): FactBuildResult<ScorecardFact> {
  return buildFacts(rows, projection, ["/v3/scorecards"], (row) => {
    const id = positiveInteger(row.id);
    const applicationId = positiveInteger(row.application_id);
    if (id === undefined || applicationId === undefined) return null;
    return compactFact({
      scorecard_id: id,
      application_id: applicationId,
      candidate_id: positiveInteger(row.candidate_id),
      interviewer_id: positiveInteger(row.interviewer_id),
      submitter_id: positiveInteger(row.submitter_id),
      interview_kit_id: positiveInteger(row.interview_kit_id),
      status: stringField(row.status),
      submitted_at: stringField(row.submitted_at),
      interviewed_at: stringField(row.interviewed_at),
      overall_rating: scalarField(row.overall_rating),
      overall_recommendation: scalarField(row.overall_recommendation),
      candidate_rating: scalarField(row.candidate_rating),
    });
  });
}

export function buildNoteActivityFacts(
  rows: unknown,
  projection?: RecruiterProjectionMetadata
): FactBuildResult<NoteActivityFact> {
  return buildFacts(rows, projection, ["/v3/notes"], (row) => {
    const id = positiveInteger(row.id);
    if (id === undefined) return null;
    return compactFact({
      note_id: id,
      application_id: positiveInteger(row.application_id),
      candidate_id: positiveInteger(row.candidate_id),
      user_id: positiveInteger(row.user_id),
      author_id: positiveInteger(row.author_id),
      type: stringField(row.type),
      visibility: stringField(row.visibility),
      private: booleanField(row.private),
      created_at: stringField(row.created_at),
    });
  });
}

export function buildSourceReferrerAttributionFacts(
  rows: unknown,
  projection?: RecruiterProjectionMetadata
): FactBuildResult<SourceReferrerAttributionFact> {
  return buildFacts(rows, projection, ["/v3/applications"], (row) => {
    const applicationId = positiveInteger(row.id);
    const jobId = positiveInteger(row.job_id);
    if (applicationId === undefined || jobId === undefined) return null;
    return compactFact({
      application_id: applicationId,
      job_id: jobId,
      source_id: positiveInteger(row.source_id),
      referrer_id: positiveInteger(row.referrer_id),
      credited_to_id: positiveInteger(row.credited_to_id),
      created_at: stringField(row.created_at),
    });
  });
}

export function buildJobPostExposureFacts(
  rows: unknown,
  projection?: RecruiterProjectionMetadata
): FactBuildResult<JobPostExposureFact> {
  return buildFacts(rows, projection, ["/v3/tracking_links"], (row) => {
    const id = positiveInteger(row.id);
    const jobId = positiveInteger(row.job_id);
    if (id === undefined || jobId === undefined) return null;
    return compactFact({
      tracking_link_id: id,
      job_id: jobId,
      job_post_id: positiveInteger(row.job_post_id),
      related_post_id: positiveInteger(row.related_post_id),
      related_post_type: stringField(row.related_post_type),
      source_id: positiveInteger(row.source_id),
      referrer_id: positiveInteger(row.referrer_id),
    });
  });
}

export function buildOpeningHeadcountFacts(
  rows: unknown,
  projection?: RecruiterProjectionMetadata
): FactBuildResult<OpeningHeadcountFact> {
  return buildFacts(rows, projection, ["/v3/openings"], (row) => {
    const id = positiveInteger(row.id);
    const jobId = positiveInteger(row.job_id);
    if (id === undefined || jobId === undefined) return null;
    return compactFact({
      opening_id: id,
      job_id: jobId,
      status: stringField(row.status),
      open: booleanField(row.open),
      opened_at: stringField(row.opened_at),
      closed_at: stringField(row.closed_at),
      target_start_on: stringField(row.target_start_on),
      sort_order: finiteNumber(row.sort_order),
      close_reason_id: positiveInteger(row.close_reason_id),
    });
  });
}

export function buildOfferFacts(
  rows: unknown,
  projection?: RecruiterProjectionMetadata
): FactBuildResult<OfferFact> {
  return buildFacts(rows, projection, ["/v3/offers"], (row) => {
    const id = positiveInteger(row.id);
    const jobId = positiveInteger(row.job_id);
    if (id === undefined || jobId === undefined) return null;
    return compactFact({
      offer_id: id,
      job_id: jobId,
      application_id: positiveInteger(row.application_id),
      candidate_id: positiveInteger(row.candidate_id),
      opening_id: positiveInteger(row.opening_id),
      status: stringField(row.status),
      sent_on: stringField(row.sent_on),
      resolved_at: stringField(row.resolved_at),
      starts_on: stringField(row.starts_on),
      version: finiteNumber(row.version),
    });
  });
}

export interface ApprovalFlowFact {
  approval_flow_id: number;
  job_id?: number;
  offer_id?: number;
  approval_status?: string;
  approval_type?: string;
  sequential?: boolean;
  requested_by_id?: number;
  created_at?: string;
  updated_at?: string;
}

/**
 * Approval-process facts over /v3/approval_flows (Tier-3.1, unblocks the north-star's
 * approval-bottleneck question). Carries created_at + approval_status so pending AGE is
 * computable honestly; flow-level resolution timestamps are not on the v3 contract, so no
 * resolved-latency is fabricated here (that would need approver_groups.resolved_at joins).
 */
export function buildApprovalFlowFacts(
  rows: unknown,
  projection?: RecruiterProjectionMetadata
): FactBuildResult<ApprovalFlowFact> {
  return buildFacts(rows, projection, ["/v3/approval_flows"], (row) => {
    const id = positiveInteger(row.id);
    if (id === undefined) return null;
    return compactFact({
      approval_flow_id: id,
      job_id: positiveInteger(row.job_id),
      offer_id: positiveInteger(row.offer_id),
      approval_status: stringField(row.approval_status),
      approval_type: stringField(row.approval_type),
      sequential: booleanField(row.sequential),
      requested_by_id: positiveInteger(row.requested_by_id),
      created_at: stringField(row.created_at),
      updated_at: stringField(row.updated_at),
    });
  });
}

export interface ProspectStateFact {
  prospect_detail_id: number;
  application_id?: number;
  pool_id?: number;
  pool_stage_id?: number;
  prospect_owner_id?: number;
  department_id?: number;
  office_id?: number;
  created_at?: string;
  updated_at?: string;
}

export function buildProspectStateFacts(
  rows: unknown,
  projection?: RecruiterProjectionMetadata
): FactBuildResult<ProspectStateFact> {
  return buildFacts(rows, projection, ["/v3/prospect_details"], (row) => {
    const id = positiveInteger(row.id);
    if (id === undefined) return null;
    return compactFact({
      prospect_detail_id: id,
      application_id: positiveInteger(row.application_id),
      pool_id: positiveInteger(row.pool_id),
      pool_stage_id: positiveInteger(row.pool_stage_id),
      prospect_owner_id: positiveInteger(row.prospect_owner_id),
      department_id: positiveInteger(row.department_id),
      office_id: positiveInteger(row.office_id),
      created_at: stringField(row.created_at),
      updated_at: stringField(row.updated_at),
    });
  });
}

export interface ScorecardQuestionAnswerFact {
  answer_id: number;
  scorecard_id?: number;
  scorecard_question_id?: number;
  question?: string;
  answer?: string;
}

export function buildScorecardQuestionAnswerFacts(
  rows: unknown,
  projection?: RecruiterProjectionMetadata
): FactBuildResult<ScorecardQuestionAnswerFact> {
  return buildFacts(rows, projection, ["/v3/scorecard_question_answers"], (row) => {
    const id = positiveInteger(row.id);
    if (id === undefined) return null;
    return compactFact({
      answer_id: id,
      scorecard_id: positiveInteger(row.scorecard_id),
      scorecard_question_id: positiveInteger(row.scorecard_question_id),
      question: stringField(row.question),
      answer: stringField(row.answer),
    });
  });
}

export function buildJobOrgDimensions(
  rows: unknown,
  projection?: RecruiterProjectionMetadata
): FactBuildResult<JobOrgDimension> {
  return buildFacts(rows, projection, ["/v3/jobs"], (row) => {
    const id = positiveInteger(row.id);
    if (id === undefined) return null;
    return compactFact({
      job_id: id,
      requisition_id: stringField(row.requisition_id),
      name: stringField(row.name),
      status: stringField(row.status),
      confidential: booleanField(row.confidential),
      department_id: positiveInteger(row.department_id),
      office_ids: positiveIntegerArray(row.office_ids),
      opened_at: stringField(row.opened_at),
      closed_at: stringField(row.closed_at),
    });
  });
}

export function buildUserOrgDimensions(
  rows: unknown,
  projection?: RecruiterProjectionMetadata
): FactBuildResult<UserOrgDimension> {
  return buildFacts(rows, projection, ["/v3/users"], (row) => {
    const id = positiveInteger(row.id);
    if (id === undefined) return null;
    return compactFact({
      user_id: id,
      name: stringField(row.name),
      first_name: stringField(row.first_name),
      last_name: stringField(row.last_name),
      job_title: stringField(row.job_title),
      deactivated: booleanField(row.deactivated),
      department_ids: positiveIntegerArray(row.department_ids),
      office_ids: positiveIntegerArray(row.office_ids),
    });
  });
}

// `projection` carries the omission manifest for facts built from a PROJECTED evidence read, so the
// `incomplete_projection` completeness branch can fire when a metric-required field was projected out.
// The five planner recipes pass no projection because they read RAW scoped rows (all fields present),
// so for them this stays undefined and the branch is intentionally inert — it is exercised by direct
// evidence reads and the facts unit tests, not the recipe path. Do not mistake it for a guarantee
// that recipe facts are projection-checked.
function buildFacts<T>(
  rows: unknown,
  projection: RecruiterProjectionMetadata | undefined,
  requiredEndpoints: string[],
  projector: (row: Record<string, unknown>) => T | null
): FactBuildResult<T> {
  const records = asRecords(rows);
  const facts = records.map(projector).filter((fact): fact is T => fact !== null);
  const droppedRows = records.length - facts.length;
  const projectionOmissions = projection?.requiredFieldOmissions ?? [];
  const omissions = [
    ...projectionOmissions.map((omission) => `${omission.metricOrFact}:${omission.endpointPath}.${omission.field}:${omission.impact}`),
    ...(droppedRows > 0 ? [`${droppedRows} row(s) omitted because required identifiers were missing.`] : []),
  ];
  return {
    facts,
    requiredEndpoints,
    requiredProjectionProfile: projection?.profile ?? "recruiter_default",
    completeness: droppedRows > 0
      ? "failed_endpoint"
      : projectionOmissions.length > 0
        ? "incomplete_projection"
        : "complete",
    omissions,
    projectionOmissions,
  };
}

function asRecords(rows: unknown): Record<string, unknown>[] {
  if (Array.isArray(rows)) return rows.filter(isRecord);
  return isRecord(rows) ? [rows] : [];
}

function compactFact<T extends Record<string, unknown>>(fact: T): T {
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fact)) {
    if (value !== undefined && value !== null) compacted[key] = value;
  }
  return compacted as T;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveIntegerArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter((entry): entry is number => typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0);
  return ids.length > 0 ? ids : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function scalarField(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
