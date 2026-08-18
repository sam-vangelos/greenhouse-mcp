import type { RecruiterDenialCode } from "../types.js";
import type { ProvenanceJobAnchor } from "./provenance.js";

export type ResolverDomain =
  | "job_scope"
  | "scorecard_accountability"
  | "interview_linkage"
  | "source_normalization"
  | "stage_normalization"
  | "user_role"
  | "rejection_normalization"
  | "time_window";

export type ResolutionStatus =
  | "resolved"
  | "needs_confirmation"
  | "ambiguous"
  | "partial"
  | "unresolved"
  | "incomplete"
  | "forbidden"
  | "error";

export interface Resolver<TInput, TOutput> {
  readonly domain: ResolverDomain;
  readonly version: string;
  resolve(input: TInput, context: ResolutionContext): Promise<ResolutionResult<TOutput>>;
}

export interface ResolutionContext {
  subject: string;
  nowMs: number;
  requestId?: string;
  actorScopeKind?: "jobs" | "operator" | "all" | "unknown";
}

export interface ResolutionResult<TResolved> {
  domain: ResolverDomain;
  status: ResolutionStatus;
  resolved: TResolved[];
  confidence: ConfidenceScore;
  completeness: ResolutionCompleteness;
  unresolved_evidence: UnresolvedEvidence[];
  metadata: ResolutionMetadata;
}

export type ConfidenceLevel = "high" | "medium" | "low" | "none" | "unresolved";

export type ConfidenceMethod =
  | "exact_id"
  | "exact_fk"
  | "confirmed_field"
  | "lookup_join"
  | "alias_table"
  | "lexical_match"
  | "fuzzy_text_match"
  | "rule_based"
  | "inferred_timestamp"
  | "unconfirmed_field"
  | "no_evidence";

export interface ConfidenceScore {
  level: ConfidenceLevel;
  method: ConfidenceMethod;
  reason: string;
  score?: number;
}

export interface ResolutionCompleteness {
  status: "complete" | "partial" | "incomplete" | "unknown";
  inventory_complete: boolean;
  truncated: boolean;
  records_seen: number;
  records_estimated: number | null;
  unnormalizable_records: number;
  source: "live_greenhouse" | "cached_index" | "hybrid";
  freshness_seconds: number | null;
  pagination_error: string | null;
}

export type UnresolvedReason =
  | "missing_fk"
  | "orphaned_entity"
  | "ambiguous_match"
  | "incomplete_inventory"
  | "permission_missing"
  | "unconfirmed_api_field"
  | "stale_data"
  | "process_exception"
  | "null_value"
  | "unknown";

export interface UnresolvedEvidence {
  domain: ResolverDomain;
  entity_type: string;
  entity_id: string | number | null;
  reason: UnresolvedReason;
  description: string;
  resolution_attempts: Array<{
    method: ConfidenceMethod;
    outcome: "success" | "failure" | "partial";
    detail?: string;
  }>;
  surfaced_to_user: boolean;
}

export interface ResolutionMetadata {
  resolver_domain: ResolverDomain;
  resolver_version: string;
  resolved_at: string;
  warnings: string[];
  scope_hash?: string;
  correlation_id?: string;
}

export interface AnalysisContextHeader {
  primary_scope_domain: "job_scope";
  source: "scope_handle" | "exact_ids";
  scope_label: string | null;
  scope_hash: string;
  job_count: number;
  frozen_job_count?: number;
  resolved_at?: string | null;
  expires_at?: string | null;
  inaccessible_job_ids?: number[];
  warnings: string[];
}

export type AnalysisContextResolution =
  | {
      ok: true;
      params: Record<string, unknown>;
      header: AnalysisContextHeader | null;
      warnings: string[];
      // Per-requisition open anchors for the resolved scope, derived from the inventory already loaded
      // during validation (no extra read). Feeds the provenance detector's predate-the-req signal.
      // Absent on the planner path and on unscoped narrow-recruiter analysis (no specific req to anchor).
      jobAnchors?: ProvenanceJobAnchor[];
    }
  | {
      ok: false;
      code: RecruiterDenialCode;
      message: string;
    };
