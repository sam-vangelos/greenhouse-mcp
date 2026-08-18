# Resolver Framework Test Matrix

## Packet Verification

| Scenario | Expected result |
|---|---|
| Packet links resolve | All local Markdown links in `docs/resolver-framework/` resolve |
| Diff hygiene | `git diff --check` passes |
| Protected paths | `git diff -- packages/control-plane/src` is empty |
| Secret scan | Packet docs contain no secrets, bearer tokens, service-role keys, or desktop session tokens |

## Framework Contract Tests

| Scenario | Expected result |
|---|---|
| Resolver types compile | Shared `src/resolution/types.ts` imports without job-scope dependency |
| Runtime dependency direction | `src/runtime.ts` does not import from `src/tools/job-scope/*` |
| Registry exposes implemented domains | Registry exposes `job_scope` only |
| Unimplemented domains absent | Source/stage/rejection/user-role resolvers are not registered as fake implementations |

## Artifact Tests

| Scenario | Expected result |
|---|---|
| Signed artifact tampering | Modified body or signature is rejected |
| Expired artifact | Verification returns expired/invalid denial |
| Cross-subject redemption | Artifact issued to subject A fails for subject B |
| Short secret | Secret below minimum length fails configuration |
| Job-scope wrappers | Existing `scope_handle` and confirmation token behavior remains stable |

## Analysis Context Tests

| Scenario | Expected result |
|---|---|
| Scope handle redemption | Produces validated `job_ids` params and context header |
| `scope_handle` plus `job_ids` | `scope_handle` wins and warning is returned |
| Exact accessible `job_ids` | Inventory is loaded and IDs pass after permission validation |
| Inaccessible exact `job_ids` | Analysis is denied or fails closed before recipe execution |
| Mixed accessible/inaccessible IDs | No silent broadening; denied or explicitly fail-closed according to implemented policy |
| Empty surviving exact IDs | Denial, not empty authoritative analysis |
| Free-text analysis input | `query`, `job_query`, `aliases`, `role_families`, etc. rejected by analysis tools |
| Incomplete inventory | Site-admin/broad analysis blocks rather than silently running |

## Job-Scope Adapter Tests

| Scenario | Expected result |
|---|---|
| Resolved job scope | Maps to `ResolutionResult` with domain `job_scope` and complete metadata |
| Needs confirmation | Maps to status `needs_confirmation`, preserving warnings and confidence |
| No match | Produces no resolved entities and appropriate unresolved evidence |
| Incomplete inventory | Completeness status is `incomplete`; no confirmed scope is produced |
| Duplicate req ID | Ambiguity survives adapter mapping |
| Closed/confidential warnings | Warnings and confirmation reasons survive adapter mapping |

## Regression Tests

Run and keep green:

```bash
npm --prefix packages/recruiter-mcp run verify
npm --prefix packages/scoped-core run verify
npm --prefix packages/recruiter-mcp run guard
```

Also preserve existing tests for:

- job-scope resolver behavior;
- job-scope tools;
- question-answer resolver integration;
- analysis scope integration;
- server contract and factory tests;
- desktop config examples if public tool lists change.
