# Job Scope Resolution Acceptance Test Matrix

## Packet Navigation

- [Packet README](./README.md)
- [ADR](./adr.md)
- [Tool contract](./tool-contract.md)
- [Safety invariants](./safety-invariants.md)

- [Golden fixture](../../test/fixtures/job-scope-resolution.fixture.json)
- [Long-form research spec](../../../../../docs/recruiting-ops/IMPLEMENTATION_SPEC_JOB_SCOPE_RESOLUTION.md)


Use `packages/recruiter-mcp/test/fixtures/job-scope-resolution.fixture.json` as the golden fixture for deterministic resolver tests.

## Resolver Scenarios

| Scenario | Actor | Input | Expected |
|---|---|---|---|
| Exact Greenhouse job ID | recruiter | `greenhouse_job_ids: [9001006]` | `resolved`, confirmed scope, one job |
| Exact req ID | recruiter | `requisition_ids: ["SAIS-US-401"]` | `resolved`, confirmed scope, open Senior Cloud Solutions Engineer |
| Closed job default exclusion | recruiter | `query: "Senior Cloud Solutions Engineer"` | open job included, closed job excluded, warning or match reason notes default-open filter |
| Include closed | recruiter | `query: "Senior Cloud Solutions Engineer", status: ["open","closed"]` | needs confirmation because open and closed matches exist |
| Ambiguous role family | recruiter | `query: "Frontier Data"` | `needs_confirmation`, multiple matches |
| Alias expansion | site admin | `query: "FDE India vs US", aliases: ["FDE"]` | `needs_confirmation`, reason includes `alias_expansion` and `admin_scope` |
| Alias collision | site admin | `query: "FD roles"` | `ambiguous` or `needs_confirmation`, does not silently choose Frontier Data or Finance Director |
| Duplicate req ID | recruiter | `requisition_ids: ["DUP-1"]` | `ambiguous`, reason includes `duplicate_req_id` |
| Hallucinated req ID | recruiter | `requisition_ids: ["REQ-DOES-NOT-EXIST"]` | `no_match`, no scope handle |
| Confidential job | recruiter without confidential access | `query: "Stealth Executive"` | no leaked title/details, no scope handle |
| Broad admin scope | site admin | `query: "all open jobs"` | confirmation required or hard block, never auto-confirmed |
| Partial inventory | site admin | simulated pagination failure | `incomplete`; analysis refuses scope |

## Scope Handle Scenarios

| Scenario | Expected |
|---|---|
| Valid handle redeemed by owner | accepted, permissions revalidated |
| Expired handle | rejected with scope expired denial |
| Tampered handle | rejected with invalid scope denial |
| Cross-user handle redemption | rejected |
| Permission removed after scope creation | inaccessible job omitted with warning or analysis denied if no jobs remain |
| Handle from incomplete inventory | analysis denied |

## Analysis Integration Scenarios

| Scenario | Expected |
|---|---|
| `analyze_scorecard_accountability` with `scope_handle` | runs only scoped jobs |
| `analyze_stage_latency` with `scope_handle` | runs only scoped jobs |
| Analysis with exact `job_ids` | internally validates and creates exact-ID ephemeral scope |
| Analysis with both `scope_handle` and `job_ids` | `scope_handle` wins; warning included |
| Analysis with `job_query` | rejected |
| `answer_my_recruiting_question` with role phrase and no scope | resolves first; returns confirmation-required output if needed |
| `answer_my_recruiting_question` as admin with broad phrase | does not silently run org-wide |

## Capability Catalogue Scenarios

| Scenario | Expected |
|---|---|
| `get_recruiting_capabilities` lists recipes | all recipes marked read-only and scope-aware |
| Capability output references resolver | recipes say `resolve_job_scope` is required before analysis when job intent is fuzzy |
| Capability output excludes write tools | no reject/move/patch/create offer/admin tools appear |

## Protected Regression Checks

Run after implementation:

```bash
git diff -- packages/control-plane/src
npm --prefix packages/scoped-core run verify
npm --prefix packages/recruiter-mcp run verify
npm --prefix packages/recruiter-mcp run guard
```
