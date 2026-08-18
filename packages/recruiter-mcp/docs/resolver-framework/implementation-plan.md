# Resolver Framework Implementation Plan

## Phase 0: Baseline Gate

Before refactoring, verify the current job-scope implementation is safe and green.

Required preconditions:

- exact `job_ids` analysis revalidates permissions;
- `answer_my_recruiting_question` exact-ID paths revalidate permissions;
- protected paths have no diff;
- existing recruiter MCP verification passes.

Commands:

```bash
npm --prefix packages/recruiter-mcp run verify
npm --prefix packages/scoped-core run verify
npm --prefix packages/recruiter-mcp run guard
git diff --check
git diff -- packages/control-plane/src
```

## Phase 1: Add Shared Resolution Types

Add `src/resolution/types.ts` with the shared vocabulary from [contracts](./contracts.md):

- `ResolverDomain`
- `Resolver`
- `ResolutionResult`
- `ConfidenceScore`
- `ResolutionCompleteness`
- `UnresolvedEvidence`
- `ResolutionMetadata`
- `ResolutionContext`

This phase should be additive and should not change job-scope behavior.

## Phase 2: Extract Signed Artifact Mechanics

Move generic HMAC artifact mechanics out of job-scope-specific files into `src/resolution/artifacts.ts`.

Generic mechanics include:

- base64url encoding/decoding;
- HMAC signing and verification;
- constant-time signature comparison;
- expiry validation;
- subject binding validation;
- generic signed artifact envelope.

Keep job-scope-specific payload wrappers for `scope_handle` and confirmation tokens in the job-scope resolver area. Public token formats should remain compatible unless tests deliberately lock a safer replacement.

## Phase 3: Move Runtime Wiring Off Job-Scope Types

`src/runtime.ts` must not import from `src/tools/job-scope/*`.

Introduce `src/resolution/services.ts` for generic runtime wiring:

- artifact signer service;
- resolver registry or provider bag;
- optional test providers.

Then update server/runtime construction so job-scope receives these services through generic resolution wiring, not by making runtime depend on job-scope types.

## Phase 4: Extract Generic Analysis Context

Move the analysis-scope redemption concept from `src/tools/job-scope/analysis-scope.ts` into `src/resolution/analysis-context.ts`.

The public behavior remains:

- analysis tools accept `scope_handle`;
- `scope_handle` wins over `job_ids`;
- exact `job_ids` compatibility path revalidates permissions;
- free-text scope inputs are rejected by analysis tools.

Internally, analysis tools should call a generic helper such as `resolveAnalysisContext(...)` and receive:

- sanitized params to pass to existing recipe code;
- an `AnalysisContextHeader`;
- warnings;
- denial details when validation fails.

## Phase 5: Move Job-Specific Resolver Code

Move job-specific matching and inventory code toward `src/resolvers/job-scope/*`.

The job-scope resolver owns:

- alias expansion;
- job inventory normalization;
- natural-language matching;
- requisition ID matching;
- duplicate req handling;
- job-specific confirmation policy;
- job-specific tool output formatting.

The public tool wrapper may remain under `src/tools/job-scope/tools.ts`, but it should become thin: load services, call the resolver, format MCP result, emit audit.

## Phase 6: Add Job-Scope Framework Adapter

Keep the existing rich `ResolveJobScopeOutput` for public tool compatibility.

Add an adapter that maps job-scope output into `ResolutionResult<JobScopeResolved>` for framework use.

The adapter must preserve:

- status;
- confidence;
- completeness;
- warnings;
- unresolved/no-match evidence;
- scope hash and label;
- resolved job IDs.

## Phase 7: Add Minimal Resolver Registry

Add `src/resolution/registry.ts` with a minimal registry exposing only `job_scope`.

The registry is not a public MCP tool. It is internal wiring for future resolvers and tests.

Do not add inactive fake resolvers. Future domains can appear as type literals in `ResolverDomain`, but the registry should only instantiate implemented domains.

## Phase 8: Add Analysis Result Completeness Helpers

Add `src/resolution/analysis-result.ts` with shared helpers for analysis result envelopes.

In this pass, keep existing tool response fields stable. Add or map shared completeness data only where it can be done without breaking current tests or clients.

The first version should support:

- pagination completeness;
- records analyzed;
- records excluded;
- unresolved-evidence count or list;
- scope header attachment.

## Phase 9: Verification And Review

Run the full verification set and perform an adversarial diff review.

The review must confirm:

- no protected path diff;
- runtime dependency direction is fixed;
- public tool behavior is stable;
- exact-ID permission revalidation remains intact;
- no new resolver domains were accidentally implemented;
- tests assert behavior, not mocks.

## Suggested Commit Boundaries

If committing, prefer small commits:

1. Add shared resolver contracts.
2. Extract generic signed artifacts.
3. Move analysis context to resolution framework.
4. Move job-scope internals under resolvers.
5. Add job-scope framework adapter and registry.
6. Add completeness helpers and tests.
