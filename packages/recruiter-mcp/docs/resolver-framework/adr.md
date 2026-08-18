# ADR: Make Job Scope The First Resolver In A Shared Framework

## Status

Accepted for the next goal-mode refactor after the current job-scope blocker fixes land.

## Context

The recruiter MCP now has a job-scope layer that resolves natural-language job references, confirmation tokens, signed `scope_handle`s, and analysis scope redemption. That solves the first structural resolution problem: determining which reqs a user means and may analyze.

The same pattern is needed for later analytics domains:

- scorecards to interviews;
- unsubmitted scorecards to accountable people or process exceptions;
- raw sources to canonical source categories;
- stage names to canonical stage families;
- users to operational roles;
- rejection reasons to normalized categories.

If job scope remains a one-off module, each future resolver will invent its own confidence, completeness, unresolved-evidence, signing, and audit concepts. That would recreate the silent-join and silent-incompleteness risks this project is trying to remove.

## Decision

Refactor job scope into the first concrete resolver in a shared resolver framework.

The framework will define common contracts for:

- resolver domains;
- resolution results;
- confidence scoring;
- completeness metadata;
- unresolved evidence;
- signed artifacts;
- analysis context;
- analysis result envelopes;
- resolver registry wiring.

The public recruiter MCP surface remains stable. The LLM-facing tools remain domain-specific and read-only. The framework is internal server-side architecture, not a new generic tool surface for the model.

## Non-Goals

This refactor does not implement:

- source normalization;
- stage normalization;
- rejection normalization;
- user-role attribution;
- scheduled-interview-backed scorecard accountability;
- persistent saved scopes;
- resolver admin UI;
- deployments, secret changes, or live probes.

## Consequences

Positive:

- Future resolver domains can share confidence, completeness, audit, and unresolved-evidence semantics.
- Runtime stops depending on job-scope-specific modules.
- Analysis tools get a stable context-resolution seam.
- Job-scope behavior remains reviewable as a V1 implementation while becoming extensible.

Costs:

- More files and types exist before all resolver domains are implemented.
- The refactor must preserve behavior carefully; this is not a feature expansion branch.
- Tests must distinguish behavior preservation from architectural movement.

## Public Surface Policy

Do not expose a generic `resolve_anything` tool. Public tools remain intentionally specific:

- `resolve_job_scope`
- `confirm_job_scope`
- `get_job_scope`
- `get_recruiting_capabilities`
- existing `analyze_*` tools
- existing evidence tools

Future resolver domains should be invoked by deterministic analysis recipes, not by model-authored raw joins.
