# Resolver Framework Contracts

These are the target internal contracts for the framework refactor. The implementation may keep richer domain-specific public outputs, but it should provide adapters into these shared shapes.

## Resolver Domain

```ts
export type ResolverDomain =
  | "job_scope"
  | "scorecard_accountability"
  | "interview_linkage"
  | "source_normalization"
  | "stage_normalization"
  | "user_role"
  | "rejection_normalization"
  | "time_window";
```

Only `job_scope` is implemented in this refactor.

## Resolver Interface

```ts
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
```

## Resolution Result

```ts
export type ResolutionStatus =
  | "resolved"
  | "needs_confirmation"
  | "ambiguous"
  | "partial"
  | "unresolved"
  | "incomplete"
  | "forbidden"
  | "error";

export interface ResolutionResult<TResolved> {
  domain: ResolverDomain;
  status: ResolutionStatus;
  resolved: TResolved[];
  confidence: ConfidenceScore;
  completeness: ResolutionCompleteness;
  unresolved_evidence: UnresolvedEvidence[];
  metadata: ResolutionMetadata;
}
```

## Confidence

```ts
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
```

## Completeness

```ts
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
```

## Unresolved Evidence

```ts
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
```

Do not include candidate contact info, resumes, attachments, raw profiles, raw note bodies, secrets, or tokens in unresolved evidence.

## Resolution Metadata

```ts
export interface ResolutionMetadata {
  resolver_domain: ResolverDomain;
  resolver_version: string;
  resolved_at: string;
  warnings: string[];
  scope_hash?: string;
  correlation_id?: string;
}
```

## Analysis Context

```ts
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
    }
  | {
      ok: false;
      code: RecruiterDenialCode;
      message: string;
    };
```

For V1, the context resolver still emits `job_ids` into params for existing analysis recipes after permission validation.

## Analysis Result Envelope

```ts
export interface AnalysisCompleteness {
  status: "complete" | "partial" | "incomplete";
  total_records_in_scope: number | null;
  records_analyzed: number;
  records_excluded: number;
  exclusion_reasons: Array<{ reason: string; count: number }>;
  inventory_complete: boolean;
  any_pagination_truncated: boolean;
  data_freshness_ok: boolean;
  message?: string;
}

export interface AttributionSummary {
  findings_ranked: number;
  unresolved: number;
}

export interface AnalysisResultEnvelope<TData> {
  data: TData;
  completeness: AnalysisCompleteness;
  attribution_summary: AttributionSummary;
  unresolved_evidence: UnresolvedEvidence[];
  scope?: AnalysisContextHeader;
}
```

Existing tool responses can keep current fields while adding or adapting toward this envelope incrementally.
