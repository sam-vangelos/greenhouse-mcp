# Greenhouse Job Scope Resolution Execution Packet

## Packet Navigation

- [ADR](./adr.md)
- [Tool contract](./tool-contract.md)
- [Safety invariants](./safety-invariants.md)
- [Acceptance test matrix](./acceptance-test-matrix.md)
- [V2 acceptance test matrix](./v2-acceptance-test-matrix.md)
- [Golden fixture](../../test/fixtures/job-scope-resolution.fixture.json)


## Objective

Build the next recruiter MCP architecture layer without relying on model improvisation:

1. Resolve natural-language job or requisition references server-side.
2. Confirm ambiguous or broad scopes before analysis.
3. Freeze the selected jobs into a user-bound `scope_handle`.
4. Run analysis only against that frozen scope or a validated exact-ID fallback.

This packet is the implementation contract for the existing v1 scope-resolution layer. The v2 architecture packet is the implementation contract for the next product-hardening pass.

## Source Of Truth

If documents disagree, use this precedence order:

1. `v2-acceptance-test-matrix.md` for the v2 architecture goal.
2. This packet's tool contract and safety invariants for existing v1 behavior that v2 does not explicitly supersede.
3. Existing scoped recruiter MCP tests and runtime behavior.
4. Older discussion, screenshots, or exploratory notes.

## Repo Facts

- Package: `packages/recruiter-mcp`
- Scoping core: `packages/scoped-core`

The v1 job-scope anchors live at:

- `packages/recruiter-mcp/src/resolvers/job-scope/resolver.ts`
- `packages/recruiter-mcp/src/resolvers/job-scope/inventory.ts`
- `packages/recruiter-mcp/src/resolvers/job-scope/capabilities.ts`
- `packages/recruiter-mcp/src/tools/job-scope/tools.ts`
- `packages/recruiter-mcp/src/resolution/analysis-context.ts`
- `packages/recruiter-mcp/src/resolution/analysis-result.ts`

## Inspect First

Read these before changing code:

- `packages/recruiter-mcp/src/tools/register.ts`
- `packages/recruiter-mcp/src/tools/evidence.ts`
- `packages/recruiter-mcp/src/tools/question-answer.ts`
- `packages/recruiter-mcp/src/runtime.ts`
- `packages/recruiter-mcp/src/types.ts`
- `packages/scoped-core/src/index.ts`
- `packages/recruiter-mcp/test/fixtures/job-scope-resolution.fixture.json`

## Protected Paths

Do not modify:

- `packages/control-plane/src/*`
- env files containing real secrets
- rollout evidence files containing issued tokens
- unrelated Slack/app/docs/salvage-source work

The recruiter MCP must remain additive. The existing unscoped operator/analytics path must keep working unchanged.

## Packet Files

- `adr.md` - architecture decision and non-goals.
- `tool-contract.md` - v1 tool schemas, response shapes, and compatibility rules.
- `safety-invariants.md` - rules implementation must preserve.
- `acceptance-test-matrix.md` - implementation tests and scenarios.
- `v2-acceptance-test-matrix.md` - v2 test/evidence requirements.
- `../../test/fixtures/job-scope-resolution.fixture.json` - golden resolver fixture, including `v2_expected_resolutions` preview specs to wire during v2 Phase 1.

## V1 Build Sequence

The sequence below describes the already-implemented v1 job-scope layer. Do not recreate it from scratch during v2. Use it as the baseline to preserve while applying the v2 packet's resolver-preview, index, scoped-read, recipe, and envelope changes.

1. Add `resolve_job_scope`, `confirm_job_scope`, and `get_job_scope` as read-only recruiter MCP tools.
2. Add scope-handle creation and redemption. Use user-bound, signed, short-TTL handles for v1; do not introduce persisted scope storage.
3. Add deterministic resolver policy over a complete accessible job inventory or explicit incomplete result.
4. Add `scope_handle` support to analysis tools while keeping `job_ids` as an exact-ID compatibility path.
5. Update `answer_my_recruiting_question` so natural-language job references go through the resolver instead of silently broad-running.
6. Add metadata-only audit fields for resolution and scope redemption.
7. Add tests from the acceptance matrix before broad pilot distribution.

## Definition Of Done

- All packet contract tests pass.
- Existing recruiter MCP verification still passes.
- No write/admin tools are exposed through the recruiter MCP.
- No protected-path diff exists:

```bash
git diff -- packages/control-plane/src
```

- Package verification passes:

```bash
npm --prefix packages/scoped-core run verify
npm --prefix packages/recruiter-mcp run verify
```
