import type { z } from "zod";
import type {
  AppliedPermissionScope,
  ApiResponseMeta,
  ScopedReadOptions,
  ScopedReadRowCounts,
  ScopedReadResult,
} from "../../scoped-core/src/index.js";

export type RecruiterSurface = "claude_desktop" | "chatgpt_desktop" | "test";
export type RecruiterClient = "claude_desktop_chat" | "claude_code" | "chatgpt_codex_host";
export type RecruiterAuditClient = RecruiterClient | "legacy_unknown";
export type RecruiterToolKind = "evidence" | "analysis";
export type RecruiterPermissionScope = AppliedPermissionScope;

export interface AuthenticatedSession {
  subject: string;
  email?: string;
  surface: RecruiterSurface;
  /** Signed physical-client identity. Absent only on pre-v2 legacy tokens. */
  client?: RecruiterClient;
  tokenId?: string;
  issuedAt?: string;
}

export interface ScopedReaderLike<SessionIdentity = AuthenticatedSession> {
  scopedRead(
    sessionIdentity: SessionIdentity,
    toolName: string,
    params?: Record<string, unknown>,
    options?: ScopedReadOptions
  ): Promise<ScopedReadResult>;
}

export type RecruiterDenialCode =
  | "IDENTITY_NOT_RESOLVED"
  | "IDENTITY_AMBIGUOUS"
  | "IDENTITY_INVALID"
  | "TOOL_NOT_AVAILABLE"
  | "TOOL_DISABLED"
  | "ACTOR_DENIED"
  | "PERMISSION_LOOKUP_FAILED"
  | "PERMISSION_JOIN_FAILED"
  | "LIMIT_EXCEEDED"
  | "RATE_LIMITED"
  | "TOOL_TIMEOUT"
  | "CANCELLED"
  | "AUDIT_UNAVAILABLE"
  | "INVALID_REQUEST"
  | "UPSTREAM_ERROR";

export interface RecruiterToolDenial {
  ok: false;
  toolName: string;
  actorId?: number;
  effectiveActorId?: number;
  denial: {
    code: RecruiterDenialCode;
    message: string;
  };
}

export interface RecruiterToolSuccess<T = unknown> {
  ok: true;
  toolName: string;
  actorId?: number;
  effectiveActorId?: number;
  scoped: boolean;
  permissionScope?: RecruiterPermissionScope;
  rowCounts?: ScopedReadRowCounts;
  data: T;
  nextCursor: string | null;
  meta?: ApiResponseMeta;
  projection?: RecruiterProjectionMetadata;
  // Read-all completeness/truncation envelope for evidence SEARCH tools. Present when a list tool
  // returned its COMPLETE scoped set via the read-all engine (server-side cursor following) instead
  // of a single 100-row page. Absent on single-record get_* reads. See `read-all.ts`.
  read?: EvidenceReadEnvelope;
  // Confirmed-scope disclosure for an evidence read narrowed to a requisition scope (scope_handle /
  // validated job_ids). Absent when the read was unscoped (spanned all permitted jobs).
  scope?: EvidenceScopeEnvelope;
  // Honest disclosure that an application-backed read was AUTO-BRIDGED: the confirmed job scope was
  // translated to application_ids (via /v3/applications) and the read constrained to those
  // applications, because the endpoint has no job_ids filter. Absent when no bridge ran.
  bridge?: EvidenceBridgeEnvelope;
}

export interface EvidenceReadEnvelope {
  // True only when every cursor page was fetched (no deadline/rate-limit/page-cap truncation).
  complete: boolean;
  status: "complete" | "incomplete_scope_resolution" | "incomplete_timeout" | "incomplete_rate_limited" | "incomplete_page_cap";
  /** Rows admitted by scope filtering across all upstream reads; bridge hops are included. */
  rows_returned: number;
  raw_rows_read: number;
  permission_excluded: number;
  unresolved_scope_rows: number;
  pages_read: number;
  per_page: number;
  pagination_truncated: boolean;
  // Resumable cursor when the read was truncated; null when complete. The complete read needs no
  // manual pagination — this is an honest escape hatch for the incomplete case, not the normal path.
  next_cursor: string | null;
  rate_limit_retries: number;
  cache_hits: number;
  warnings: string[];
  message?: string;
}

export interface EvidenceScopeEnvelope {
  applied: boolean;
  source?: "scope_handle" | "exact_ids";
  job_count?: number;
  scope_label?: string | null;
  scope_hash?: string;
  warnings?: string[];
  // Set on an unscoped read to disclose the read spanned all permitted jobs + how to narrow.
  note?: string;
}

export interface EvidenceBridgeEnvelope {
  bridged: boolean;
  // The endpoint filter the confirmed scope was bridged onto. application_ids is the original L1 bridge;
  // the others (R2) extend the same auto-bridge to the sibling tools whose endpoints also have no
  // job_ids filter (scorecard_question_answers -> scorecard_ids, interviewers -> interview_ids,
  // candidate_educations/employments -> candidate_ids, candidates -> ids).
  via: "application_ids" | "scorecard_ids" | "interview_ids" | "candidate_ids" | "ids";
  basis: string;
  // Count of the derived target ids (`via`) the read was constrained to, plus the completeness of the
  // id-derivation read(s). Emitted by the R2 scorecard/interview/candidate bridges. The original
  // application_ids bridge keeps its own field names below, so its envelope is byte-for-byte unchanged.
  scoped_id_count?: number;
  derive_read_status?: "complete" | "incomplete_scope_resolution" | "incomplete_timeout" | "incomplete_rate_limited" | "incomplete_page_cap";
  derive_read_complete?: boolean;
  // L1 application_ids-bridge disclosure (present only when via === "application_ids").
  scoped_application_count?: number;
  application_read_status?: "complete" | "incomplete_scope_resolution" | "incomplete_timeout" | "incomplete_rate_limited" | "incomplete_page_cap";
  application_read_complete?: boolean;
}

export type RecruiterToolResult<T = unknown> =
  | RecruiterToolSuccess<T>
  | RecruiterToolDenial;

export type RecruiterProjectionProfileName =
  | "recruiter_default"
  | "coordinator_default"
  | "recruiting_manager"
  | "operator_site_admin"
  | "admin_diagnostic"
  | "compliance_aggregate";

export type RecruiterProjectionOmissionReason =
  | "privacy"
  | "role_gated"
  | "compliance"
  | "not_material"
  | "not_available_in_source"
  | "not_implemented"
  | "not_projected";

export interface RecruiterProjectionOmittedField {
  endpointPath: string;
  field: string;
  reason: RecruiterProjectionOmissionReason;
}

export interface RecruiterProjectionRequiredFieldOmission {
  metricOrFact: string;
  endpointPath: string;
  field: string;
  impact: "blocks_answer" | "degrades_answer";
}

export interface RecruiterProjectionMetadata {
  endpointPath: string;
  profile: RecruiterProjectionProfileName;
  omittedFields: RecruiterProjectionOmittedField[];
  requiredFieldOmissions: RecruiterProjectionRequiredFieldOmission[];
  incompleteProjection: boolean;
}

export interface RecruiterToolDefinition {
  name: string;
  kind: RecruiterToolKind;
  description: string;
  // Optional endpoint-specific model-facing input schema. When absent,
  // registerRecruiterTools falls back to the shared search/get schema. Used to
  // give a tool whose upstream endpoint has a divergent filter contract (e.g.
  // search_my_application_stages) its own advertised filters.
  paramsSchema?: Record<string, z.ZodTypeAny>;
}
