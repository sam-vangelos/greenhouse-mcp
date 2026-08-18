# ADR: Server-Authoritative Job Scope Resolution

## Packet Navigation

- [Packet README](./README.md)
- [Tool contract](./tool-contract.md)
- [Safety invariants](./safety-invariants.md)
- [Acceptance test matrix](./acceptance-test-matrix.md)

- [Golden fixture](../../test/fixtures/job-scope-resolution.fixture.json)
- [Long-form research spec](../../../../../docs/recruiting-ops/IMPLEMENTATION_SPEC_JOB_SCOPE_RESOLUTION.md)


## Status

Accepted for implementation planning. Not yet implemented by this packet.

## Context

The scoped recruiter MCP already enforces authorization scope: which Greenhouse jobs the authenticated actor may read. It does not yet provide a first-class intent scope: which subset of those jobs the user's question is about.

Today, a model can browse with `search_my_jobs`, infer a set of job IDs, and call an analysis tool. That is usable for a small pilot, but it is fragile for natural-language role families and dangerous for broad-visibility users. Site admins can see many jobs, so "my FDE reqs" or "pipeline health" can accidentally become org-wide analysis.

## Decision

Natural-language job references must be resolved through this flow:

```text
user question
  -> model extracts structured intent
  -> resolve_job_scope
  -> confirm_job_scope when required
  -> user-bound scope_handle
  -> analysis
```

The LLM may interpret wording and present confirmation prompts. Server code owns:

- permission filtering
- candidate generation
- deterministic matching and scoring
- ambiguity detection
- inventory completeness
- confirmation policy
- scope freezing
- scope-handle subject binding and expiry
- permission revalidation at analysis time
- metadata-only audit

## User-Type Policy

Narrow-access recruiters can auto-proceed for complete, unique, high-confidence active-job matches.

Site admins/operators require stronger guardrails:

- no silent all-org analysis
- confirmation for fuzzy or multi-job scopes
- hard failure on incomplete inventory unless explicitly acknowledged by a supported flow
- visible scope header in every answer

## Non-Goals

- Do not expose write/admin tools.
- Do not reintroduce the old 88-tool raw Greenhouse surface to recruiters.
- Do not add free-text `job_query` to analysis tools.
- Do not make model-supplied IDs authoritative.
- Do not create persisted/team-shared scopes in v1.
- Do not implement embeddings/vector search in v1.
- Do not modify `packages/control-plane/src/*`.

## Old MCP Good Parts To Reuse

The old `ats-ops-control-plane` Greenhouse MCP had useful product patterns:

- capability catalogue
- recipe registry
- model-facing tool choreography
- richer read graph
- standing-query concept

Bring those forward only behind the scoped recruiter MCP surface:

- recipes must run through scoped reads
- outputs must use safe projections
- tools remain read-only
- analysis must be tied to resolved scope
- no raw candidate contact/profile leakage

## Consequences

This adds friction in broad or ambiguous cases, but that friction is intentional. It turns a vague prompt into an auditable scope artifact before the MCP computes an answer. It also gives Claude a better UX: users can name roles naturally without memorizing req IDs.
