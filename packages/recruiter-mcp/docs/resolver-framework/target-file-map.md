# Resolver Framework Target File Map

## Current Shape

| Current file or module | Current responsibility | Target action |
|---|---|---|
| `src/tools/job-scope/scope-handle.ts` | HMAC mechanics plus job-scope payloads | Split generic signing into `src/resolution/artifacts.ts`; keep job-scope payload wrappers under `src/resolvers/job-scope/` |
| `src/tools/job-scope/analysis-scope.ts` | Validates analysis `scope_handle` / `job_ids` and rewrites params | Move generic behavior to `src/resolution/analysis-context.ts`; job scope remains the only implemented context provider |
| `src/tools/job-scope/resolver.ts` | Job-specific matching, scoring, confirmation policy | Move to `src/resolvers/job-scope/resolver.ts` |
| `src/tools/job-scope/inventory.ts` | Job inventory provider and fixture inventory | Move to `src/resolvers/job-scope/inventory.ts` |
| `src/tools/job-scope/aliases.ts` | Job alias expansion | Move to `src/resolvers/job-scope/aliases.ts` |
| `src/tools/job-scope/tools.ts` | MCP tool handlers and result formatting | Keep as public wrapper, but make it thin over resolver services |
| `src/runtime.ts` | Runtime configuration; currently imports job-scope types | Replace job-scope imports with `src/resolution/services.ts` types |
| `src/audit.ts` | Tool audit event schema | Keep metadata-only fields; generalize scope fields to resolution metadata if needed |
| analysis tools under `src/tools/*.ts` | Call job-scope `applyAnalysisScope` directly | Import from `src/resolution/analysis-context.ts` instead |

## Target Shape

```text
src/resolution/
  types.ts
  services.ts
  artifacts.ts
  analysis-context.ts
  analysis-result.ts
  registry.ts

src/resolvers/job-scope/
  aliases.ts
  inventory.ts
  resolver.ts
  artifacts.ts
  adapter.ts

src/tools/job-scope/
  tools.ts
```

## Boundary Rules

- `src/resolution/*` must not import from `src/tools/*`.
- `src/resolution/*` may define generic contracts and helpers.
- `src/resolvers/job-scope/*` may import from `src/resolution/*`.
- `src/tools/job-scope/tools.ts` may import from both `src/resolution/*` and `src/resolvers/job-scope/*`.
- Analysis tools should import from `src/resolution/analysis-context.ts`, not from `src/tools/job-scope/*`.
- Core runtime should import from `src/resolution/services.ts`, not from job-scope files.

## Public Tool Compatibility

These tool names remain stable:

- `resolve_job_scope`
- `confirm_job_scope`
- `get_job_scope`
- `get_recruiting_capabilities`
- `analyze_scorecard_accountability`
- `analyze_interview_feedback_drag`
- `analyze_stage_latency`
- `analyze_pipeline_quality`
- `analyze_source_quality`
- `answer_my_recruiting_question`

Do not rename public tools as part of this refactor.
