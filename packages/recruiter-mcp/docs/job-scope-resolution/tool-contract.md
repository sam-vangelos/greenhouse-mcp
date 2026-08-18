# Job Scope Resolution Tool Contract

## Packet Navigation

- [Packet README](./README.md)
- [ADR](./adr.md)
- [Safety invariants](./safety-invariants.md)
- [Acceptance test matrix](./acceptance-test-matrix.md)

- [V2 architecture execution packet](./v2-architecture-execution-packet.md)
- [V2 acceptance test matrix](./v2-acceptance-test-matrix.md)
- [Golden fixture](../../test/fixtures/job-scope-resolution.fixture.json)
- [Long-form research spec](../../../../../docs/recruiting-ops/IMPLEMENTATION_SPEC_JOB_SCOPE_RESOLUTION.md)


## Contract Priority

If this document conflicts with `docs/recruiting-ops/IMPLEMENTATION_SPEC_JOB_SCOPE_RESOLUTION.md`, this document wins for v1 implementation.

## Naming

Use `scope_handle` for the v1 frozen scope artifact. It is an opaque string to the model and user. It must be signed, user-bound, short-lived, and redeemed server-side before analysis.

## Tool: `resolve_job_scope`

Purpose: resolve natural-language, exact-ID, alias, and filter inputs into a proposed or auto-confirmed job scope.

Read-only. No candidate contact data, resumes, attachments, raw profiles, or private note content.

### Input

```ts
interface ResolveJobScopeInput {
  query?: string;
  greenhouse_job_ids?: number[];
  requisition_ids?: string[];
  filters?: {
    status?: Array<"open" | "closed" | "draft" | "all">;
    departments?: string[];
    offices?: string[];
    locations?: string[];
    recruiter_user_ids?: number[];
    hiring_manager_user_ids?: number[];
    opened_after?: string;
    opened_before?: string;
    include_confidential?: boolean;
    my_jobs_only?: boolean;
  };
  aliases?: string[];
  role_families?: string[];
  match_mode?: "exact" | "prefix" | "fuzzy" | "hybrid";
  default_status?: "open_only" | "open_and_draft" | "all";
  max_candidates?: number;
  allow_auto_confirm?: boolean;
  purpose?:
    | "scorecard_accountability"
    | "interview_feedback_drag"
    | "stage_latency"
    | "pipeline_quality"
    | "source_quality"
    | "general_question"
    | "comparison"
    | "inventory";
}
```

Defaults:

- `default_status`: `open_only`
- `match_mode`: legacy documented default `hybrid`, but v1 currently does not implement distinct match-mode behavior. V2 should remove this public input unless exact/prefix/fuzzy/hybrid semantics are specified and tested.
- `max_candidates`: runtime-capped, default 20
- `allow_auto_confirm`: true
- `filters.my_jobs_only`: true for normal users; operators may request broader scope but still require confirmation when broad

### Output

```ts
interface ResolveJobScopeOutput {
  resolution_id: string;
  resolution_status:
    | "resolved"
    | "needs_confirmation"
    | "ambiguous"
    | "incomplete"
    | "no_match"
    | "forbidden"
    | "error";
  scope: {
    scope_handle: string | null;
    scope_status: "confirmed" | "proposed" | "rejected" | "expired";
    job_ids: number[];
    job_count: number;
    scope_label: string;
    scope_hash: string;
    expires_at: string | null;
  };
  matches: JobScopeMatch[];
  ambiguous_candidates: JobScopeAmbiguousCandidate[];
  confidence: {
    overall: number;
    band: "high" | "medium" | "low" | "none";
    top_margin: number | null;
    score_type: "deterministic_lexical_alias_ranker_v1";
  };
  completeness: {
    inventory_complete: boolean;
    truncated: boolean;
    accessible_jobs_seen: number;
    accessible_jobs_estimated: number | null;
    source: "live_greenhouse" | "cached_index" | "hybrid";
    index_as_of: string | null;
    pagination_error: string | null;
    freshness_seconds: number | null;
    unnormalizable_jobs_dropped: number;
  };
  confirmation: {
    required: boolean;
    reason_codes: ConfirmationReasonCode[];
    confirmation_token: string | null;
    confirmation_prompt: string | null;
  };
  warnings: string[];
}

interface JobScopeMatch {
  greenhouse_job_id: number;
  requisition_id: string | null;
  title: string;
  status: "open" | "closed" | "draft" | string;
  department: string | null;
  office: string | null;
  location: string | null;
  opened_at: string | null;
  closed_at: string | null;
  recruiters: string[];
  hiring_managers: string[];
  confidential: boolean;
  match_score: number;
  match_band: "exact" | "high" | "medium" | "low";
  match_reasons: string[];
  matched_terms: string[];
  unmatched_terms: string[];
}

interface JobScopeAmbiguousCandidate {
  greenhouse_job_id: number;
  requisition_id: string | null;
  title: string;
  status: string;
  location: string | null;
  match_score: number;
  why_ambiguous: string;
}

type ConfirmationReasonCode =
  | "multiple_matches"
  | "broad_scope"
  | "admin_scope"
  | "low_confidence"
  | "medium_confidence"
  | "partial_inventory"
  | "stale_index"
  | "contains_closed_jobs"
  | "contains_confidential_jobs"
  | "alias_expansion"
  | "role_family_expansion"
  | "duplicate_req_id"
  | "unmatched_material_terms";
```

## Tool: `confirm_job_scope`

Purpose: convert a proposed resolution into a confirmed `scope_handle`.

### Input

```ts
interface ConfirmJobScopeInput {
  resolution_id: string;
  confirmation_token: string;
  decision: "confirm_all" | "confirm_selected" | "reject" | "revise";
  selected_job_ids?: number[];
  revised_query?: string;
  acknowledgements?: {
    acknowledge_partial_inventory?: boolean;
    acknowledge_closed_jobs?: boolean;
    acknowledge_confidential_jobs?: boolean;
    acknowledge_broad_admin_scope?: boolean;
    acknowledge_stale_index?: boolean;
  };
}
```

### Output

```ts
interface ConfirmJobScopeOutput {
  scope_handle: string | null;
  scope_status: "confirmed" | "rejected" | "needs_revision";
  job_ids: number[];
  job_count: number;
  scope_label: string;
  scope_hash: string;
  expires_at: string | null;
  permission_revalidated: boolean;
  warnings: string[];
}
```

## Tool: `get_job_scope`

Purpose: inspect a `scope_handle` without running analysis.

Input:

```ts
interface GetJobScopeInput {
  scope_handle: string;
}
```

Output:

```ts
interface GetJobScopeOutput {
  valid: boolean;
  scope_status: "confirmed" | "expired" | "invalid" | "forbidden";
  job_ids: number[];
  job_count: number;
  scope_label: string | null;
  expires_at: string | null;
  permission_revalidated: boolean;
  inaccessible_job_ids: number[];
  warnings: string[];
}
```

## Analysis Tool Integration

Every recruiter analysis tool gets:

```ts
interface ScopedAnalysisInput {
  scope_handle?: string;
  job_ids?: string | number[];
}
```

Rules:

- `scope_handle` is preferred.
- `job_ids` remains for backward compatibility, but must create an exact-ID ephemeral scope internally and revalidate permissions.
- Analysis tools must reject `job_query`, `query`, `role_family`, `aliases`, or other free-text scope inputs.
- If both `scope_handle` and `job_ids` are present, `scope_handle` wins and a warning is included.
- A redeemed scope with zero currently accessible jobs returns a denial, not an empty authoritative analysis.
- Analysis outputs include a scope header: label, job count, scope hash, created/resolved timestamp when available, and any warnings.

## `answer_my_recruiting_question`

`answer_my_recruiting_question` remains a convenience planner, but it must not bypass scope resolution.

When a question references jobs/roles and has no `scope_handle` or exact `job_ids`, it must:

1. call resolver logic internally,
2. return a resolution-required response if confirmation is required,
3. only run recipes after a confirmed or auto-confirmed scope exists.

## `get_recruiting_capabilities`

P1 tool, read-only.

It should expose:

- supported analysis recipes
- required data domains
- supported user modes: recruiter, operator/site-admin
- whether a recipe requires a confirmed scope
- examples
- known limitations and pagination caveats

It must not expose write/admin tools or raw unscoped data paths.

## Scope Handle Requirements

V1 `scope_handle` requirements:

- opaque string
- HMAC/JWT-style signature
- bound to current session subject
- short TTL, default 60 minutes
- contains or references frozen job IDs
- records whether inventory was complete
- redeemed only after signature, subject, expiry, and permission revalidation pass
- not persisted as a DB-backed saved scope in v1
