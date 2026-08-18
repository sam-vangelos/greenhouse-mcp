# Resolver Framework Review Checklist

Use this checklist for adversarial review after the goal-mode implementation.

## Findings First

Report findings first, ordered by severity, with file and line references. Treat protected path edits, permission bypasses, and public behavior regressions as blockers.

## Architecture Boundaries

- `src/resolution/*` does not import from `src/tools/*`.
- `src/runtime.ts` does not import from `src/tools/job-scope/*`.
- Job-specific logic lives under `src/resolvers/job-scope/*` or remains isolated behind the target boundary.
- Public MCP tools remain wrappers, not places for matching algorithms to grow.
- Registry does not expose fake or partially implemented resolver domains.

## Behavior Preservation

- Existing public tool names remain stable.
- Existing analysis tools still work with validated `job_ids` and `scope_handle`.
- `scope_handle` precedence over `job_ids` is preserved.
- Free-text job scope inputs are rejected by analysis tools.
- `answer_my_recruiting_question` still uses resolver logic before job-scoped analysis.
- Exact `job_ids` still revalidate permissions before analysis.

## Safety

- No write/admin tools became reachable.
- No actor identity is accepted from model/client params.
- Scope artifacts remain signed, subject-bound, expiring, and permission-revalidated.
- Incomplete inventory cannot silently run broad/admin analysis.
- Unresolved evidence and completeness metadata do not include sensitive candidate data.

## Tests

- Tests assert behavior, not implementation trivia.
- Tests prove dependency-direction goals where feasible.
- Tests cover exact-ID validation and no read-free shortcut.
- Tests cover artifact tampering, expiry, and subject binding.
- Tests cover job-scope adapter mapping.
- Full package verification was run or a clear reason is recorded.

## Accept / Reject Guidance

Accept as a framework foundation only if:

- behavior is preserved;
- dependency direction is improved;
- exact-ID validation remains fixed;
- future resolver seams are real and test-covered;
- no new domain resolver is half-built.

Reject or request fixes if:

- code movement obscures a permission bug;
- public MCP schemas break without a migration reason;
- runtime still depends on job-scope internals;
- framework types are decorative but unused;
- tests are mostly snapshots or mocks that do not prove safety behavior.
