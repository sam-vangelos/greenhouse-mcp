# Job Scope Resolution Safety Invariants

## Packet Navigation

- [Packet README](./README.md)
- [ADR](./adr.md)
- [Tool contract](./tool-contract.md)
- [Acceptance test matrix](./acceptance-test-matrix.md)

- [V2 architecture execution packet](./v2-architecture-execution-packet.md)
- [V2 acceptance test matrix](./v2-acceptance-test-matrix.md)
- [Golden fixture](../../test/fixtures/job-scope-resolution.fixture.json)
- [Long-form research spec](../../../../../docs/recruiting-ops/IMPLEMENTATION_SPEC_JOB_SCOPE_RESOLUTION.md)


These rules are implementation blockers. If a test reveals any violation, do not ship the feature.

## Surface And Authority

- The recruiter MCP remains read-only.
- No write/admin tool becomes reachable through the scoped recruiter surface.
- Do not modify `packages/control-plane/src/*` or the unscoped analytics path.
- Never derive actor identity from a user/model parameter.
- `actAsUser` remains operator-only and server-trusted.

## Resolution Boundary

- Natural-language job text is accepted only by `resolve_job_scope` or by `answer_my_recruiting_question` when it internally uses the resolver.
- Analysis tools must not accept `job_query` or equivalent free-text scope inputs.
- `search_my_jobs` is a browsing/debugging tool, not an authoritative precursor to analysis.
- Model-supplied Greenhouse job IDs are never trusted until server-validated and permission-filtered.

## Completeness

- Resolver owns pagination and completeness.
- A partial/truncated inventory must return `resolution_status: "incomplete"` or equivalent blocked-analysis output.
- V2 may return candidate previews from partial/truncated inventory, but those previews are discovery output only: no analyzable `scope_handle` may be minted from incomplete free-text inventory.
- V2 partial free-text previews must keep `scope.job_ids` empty and must not return an analyzable confirmation token, regardless of match confidence, uniqueness, or actor type.
- Analysis must not run on a scope derived from incomplete inventory unless a future explicit acknowledgement flow is implemented and tested.
- Any answer based on a resolved scope must carry scope provenance.

## Confirmation Policy

- Narrow recruiters may auto-confirm unique high-confidence active-job matches with complete inventory.
- Recruiter ambiguous role-family matches require confirmation.
- Site-admin/operator fuzzy or multi-job scopes require confirmation.
- Site-admin/operator broad or all-org scopes are never silent.
- Closed jobs are excluded by default and require explicit inclusion.
- Confidential jobs are omitted or confirmation-gated according to caller permission.

## Scope Handle

- `scope_handle` is opaque to the model.
- `scope_handle` must be signed or otherwise tamper-evident.
- `scope_handle` must bind to the authenticated session subject.
- `scope_handle` must expire.
- Redeeming a scope must revalidate current permissions.
- A saved or frozen scope never grants access by itself.
- Cross-user scope redemption must fail.

## Projection And Privacy

- Candidate contact info stays excluded.
- General evidence reads exclude attachment URLs and resume contents. The only resume-content exception is `read_my_resume`: it accepts an explicitly selected, freshly permission-scoped `attachment_id`, extracts supported files server-side under bounded limits, and treats the returned text as untrusted evidence. Raw attachment bytes, arbitrary URLs, raw profiles, raw custom fields, and unnecessary private note content stay excluded.
- Resolver index/fixture data should contain job metadata only, not candidate PII.
- Audit logs remain metadata-only. Do not log raw user prompts, secrets, session tokens, Greenhouse credentials, Supabase keys, or desktop config tokens.

## Old MCP Reuse Boundaries

Bring forward:

- capability catalogue
- scoped recipes
- model-facing choreography
- richer read domains after projection/scoping review

Do not bring forward:

- raw 88-tool Greenhouse freedom for recruiters
- write/admin tools
- unscoped reads
- model-authoritative joins over raw endpoints

## Enforcement Map

Before changing any listed behavior, inspect the enforcement site and add or update the regression evidence. These are the places a v2 implementation is most likely to weaken v1 safety accidentally.

| Invariant | Current enforcement site | Regression evidence required |
|---|---|---|
| Partial free-text inventory cannot produce analyzable scope. | `src/resolvers/job-scope/resolver.ts` currently returns incomplete before auto-confirm; `selectBySearch` rejects incomplete inventory; `src/resolution/analysis-context.ts` rejects handles whose payload is not complete. | Fixture/test where partial inventory returns candidate `matches[]` but `scope.job_ids=[]`, `scope_handle=null`, `confirmation_token=null`, and analysis stays blocked. |
| Unique high-confidence partial preview cannot auto-confirm. | `resolver.ts` `mintHandle=true` branch is downstream of the incomplete guard. | Narrow-recruiter fixture with one visible high-confidence match and incomplete inventory remains preview-only. |
| Operator/all access cannot run org-wide silently. | `src/tools/question-answer.ts` `resolvePlannerScope`; `src/resolution/analysis-context.ts` broad-access denial when no explicit scope is present; `scopeContextResolved` is safe only after planner gating. | Operator planner/recipe regression denies analysis without confirmed `job_ids` or `scope_handle`. |
| Tool surface remains exact and read-only. | `src/tools/register.ts` `RECRUITER_TOOL_DEFINITIONS`; `test/server-contract.test.ts` exact catalog assertion; rollout/distribution checks for `no_unexpected_tools`, `no_write_tools`, and read-only annotations. | Tool additions update catalog, exact test, and rollout `allowed_tools`; strict catalog/security checks are not weakened. |
| New read domains stay permission-bounded. | Scoped core can intentionally return unscoped operator data; recruiter-layer resolver/planner gates and per-tool filters must provide the user-facing bound. | Every new read tool declares job-scoped, application-backed, global-reference, or unavailable class and has projection/permission tests for that class. |
| Global-reference domains are not fake job-scoped. | Domains such as users and rejection reasons may have no job key. | Expose only safe projected reference metadata, or keep unavailable; do not claim rows are limited to permitted jobs without a real key/join. |
| Confidential/private data stays projected. | Evidence and analysis projection helpers plus scoped-reader row filters. | Confidential preview and projected-domain tests prove titles/details/text are gated or redacted as intended. |
