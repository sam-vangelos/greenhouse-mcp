# Greenhouse Resolver Framework Execution Packet

## Packet Navigation

- [ADR](./adr.md)
- [Implementation plan](./implementation-plan.md)
- [Target file map](./target-file-map.md)
- [Contracts](./contracts.md)
- [Safety invariants](./safety-invariants.md)
- [Test matrix](./test-matrix.md)
- [Review checklist](./review-checklist.md)
- [Goal-mode prompt](./goal-mode-prompt.md)
- [Job-scope execution packet](../job-scope-resolution/README.md)

## Objective

Refactor the current Greenhouse job-scope implementation into the first resolver in a shared resolver framework, without changing the public recruiter MCP behavior and without implementing new resolver domains in this pass.

The future goal-mode loop should turn the current job-scope-specific layer into a reusable foundation for later domains such as scorecard accountability, interview linkage, source normalization, stage normalization, user-role attribution, and rejection normalization.

## Source Hierarchy

Use this precedence order when documents disagree:

1. This resolver-framework packet.
2. The job-scope packet in `../job-scope-resolution/`.
3. The current code and tests in `packages/recruiter-mcp`.

## Repo Facts

- Package: `packages/recruiter-mcp`
- Current job-scope module: `packages/recruiter-mcp/src/tools/job-scope/`
- Protected core MCP path: `packages/control-plane/src/*`


Claude's job-scope changes may still be uncommitted when this packet is used. Re-check `git status --short --branch --untracked-files=all` before editing.

## Inspect First

Read these before changing code:

- `packages/recruiter-mcp/src/tools/job-scope/analysis-scope.ts`
- `packages/recruiter-mcp/src/tools/job-scope/scope-handle.ts`
- `packages/recruiter-mcp/src/tools/job-scope/resolver.ts`
- `packages/recruiter-mcp/src/tools/job-scope/inventory.ts`
- `packages/recruiter-mcp/src/tools/job-scope/tools.ts`
- `packages/recruiter-mcp/src/runtime.ts`
- `packages/recruiter-mcp/src/audit.ts`
- `packages/recruiter-mcp/src/tools/register.ts`
- `packages/recruiter-mcp/src/tools/question-answer.ts`
- `packages/recruiter-mcp/docs/job-scope-resolution/tool-contract.md`
- `packages/recruiter-mcp/docs/job-scope-resolution/safety-invariants.md`

## Worktree Preconditions

Do not start this framework refactor until the adversarial review blocker is fixed:

- exact `job_ids` analysis must revalidate current permissions before analysis;
- `answer_my_recruiting_question` must not use a numeric exact-ID shortcut that bypasses validation;
- tests must no longer assert read-free exact-ID pass-through.

## Definition Of Done

- Runtime no longer imports types from `src/tools/job-scope/*`.
- Shared resolver contracts exist under `src/resolution/*`.
- Job-specific resolver code lives under `src/resolvers/job-scope/*` or is isolated behind that intended boundary.
- Public MCP tool names and input compatibility remain stable.
- `resolve_job_scope`, `confirm_job_scope`, `get_job_scope`, and `get_recruiting_capabilities` still behave as before.
- Existing analysis tools use a generic analysis context helper rather than importing job-scope internals directly.
- No new source/stage/rejection/user-role/scorecard resolver domain is implemented in this pass.
- Verification passes:

```bash
npm --prefix packages/recruiter-mcp run verify
npm --prefix packages/scoped-core run verify
npm --prefix packages/recruiter-mcp run guard
git diff --check
git diff -- packages/control-plane/src
```
