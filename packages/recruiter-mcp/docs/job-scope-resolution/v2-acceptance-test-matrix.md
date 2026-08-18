# Scoped Recruiter Greenhouse MCP V2 Acceptance Test Matrix

This matrix defines the minimum evidence required before claiming the v2 architecture work is complete. Add tests before or alongside implementation. Do not rely on manual inspection alone for safety-critical behavior.

The golden fixture includes `v2_expected_resolutions` for the preview cases that intentionally supersede v1 fail-closed behavior. A v2 implementation should promote or wire those cases into executable resolver tests during Phase 1, while preserving the existing exact-id and requisition-id truncation safety cases.

## Resolver V2

| ID | Scenario | Setup | Expected |
|---|---|---|---|
| R2-01 | Operator free-text under truncated inventory | Operator/site-admin inventory has more jobs than page cap; visible page includes `Senior Cloud Solutions Engineer - US`; query `Senior Cloud Solutions Engineer` | Returns candidate matches from visible inventory; `inventory_complete=false`; no `scope_handle`; analysis not allowed; next step asks for exact id, narrower query, or index refresh |
| R2-02 | Decorated title match | Same job exists; query `Senior Cloud Solutions Engineer STEM US` | Intended job appears as high-confidence candidate; unmatched/decorative terms are explained without causing total failure |
| R2-03 | Exact id under truncated inventory | `greenhouse_job_ids` contains visible accessible id | Resolved and confirmed; scope handle minted; completeness metadata still says inventory was truncated |
| R2-04 | Missing exact id under truncated inventory | `greenhouse_job_ids` contains id not seen in truncated inventory | Fails closed; no scope handle; no analysis |
| R2-05 | Requisition id under truncated inventory | `requisition_ids` contains visible req id while inventory incomplete | Does not auto-confirm; no analyzable handle because duplicate/off-page req cannot be excluded |
| R2-06 | Confidential inaccessible title | Narrow recruiter lacks confidential access; query confidential role title | Does not leak confidential title/details; no scope handle |
| R2-07 | `match_mode` contract | Public schema advertises `match_mode` | Preferred fix is removal from public schema/types unless exact/prefix/fuzzy/hybrid behavior is explicitly implemented and tested |
| R2-08 | Partial preview signed-artifact safety | Free-text partial result returns candidates | No confirmation token, no scope handle, no non-empty `scope.job_ids`, no raw user query stored in signed payloads |
| R2-09 | Narrow recruiter unique partial preview | Narrow recruiter has one visible high-confidence active match; `simulate_inventory_complete=false` | Returns `resolution_status="incomplete"` with non-empty `matches[]`; `scope.job_ids=[]`; `scope_handle=null`; `confirmation_token=null`; never enters auto-confirm |
| R2-10 | Operator confidential partial preview | Operator visible page includes confidential role under truncated inventory | Preview adds confidential warning/reason; confidential detail is projected; no analyzable scope, token, or handle is returned |

## Searchable Job Index

| ID | Scenario | Setup | Expected |
|---|---|---|---|
| JI-01 | Fixture provider parity | Fixture inventory loads through the new search/index abstraction | Existing resolver fixture cases continue to pass |
| JI-02 | Safe metadata indexing | Job rows include title, req id, department, office/location, status, owners | Indexed fields are searchable and projected; no candidate PII included |
| JI-03 | Stale cached index | Cached/hybrid source reports stale freshness | Candidate preview can return; confirmation/analysis carries stale warning or requires confirmation |
| JI-04 | Owner filters | Query/filter attempts recruiter or hiring-manager ownership | Filters are applied if implemented; otherwise fail closed with explicit unsupported-filter message, not silently ignored |

## Scoped Read Expansion

Every new scoped read tool must be classified before implementation:

| Class | Bounding rule | Examples |
|---|---|---|
| Job-scoped | Direct `job_id` or equivalent job key is filtered against permitted jobs before projection | openings, job owners, job interview stages |
| Application-backed | Row is bounded through application/candidate/job joins before projection | rejection details, interviews, scorecard question answers |
| Global reference | No meaningful job key exists; only safe projected reference metadata may be exposed, and never as fake job-scoped data | users, rejection reasons |
| Unsafe/unavailable | Raw data would expose broad/private/write capability; omit or replace with projected recipe metadata | unprojected private notes, raw candidate profiles, write/admin endpoints |

| ID | Scenario | Tool family | Expected |
|---|---|---|---|
| SR-00 | Domain classification | Any proposed new scoped read tool | Test/docs identify job-scoped, application-backed, global-reference, or unsafe/unavailable class and its bounding rule before tool registration |
| SR-01 | Users read | `search_my_users` / `get_my_user` or chosen equivalent | Treated as global-reference safe projection, not fake job-scoped data; identity-like params stripped; only projected safe fields returned |
| SR-02 | Job owners read | job owner scoped tool | Rows limited to permitted jobs; operator broad use requires explicit scope path or documented safe projection |
| SR-03 | Openings read | openings scoped tool | Rows limited by permitted jobs; supports job id filtering |
| SR-04 | Interview stages read | job interview stages scoped tool | Rows limited by permitted jobs; supports stage joins |
| SR-05 | Interviews read | interviews scoped tool | Rows limited by permitted jobs/applications; no unsafe private fields |
| SR-06 | Rejection details/reasons | rejection scoped tools | Details are application-backed; reasons are global-reference safe projection; operational fields only; supports disposition recipes |
| SR-07 | Scorecard question answers | scorecard-answer scoped tool | Projected fields only; expanded text requires explicit safety review/tests |
| SR-08 | Tracking links/source attribution | tracking/source scoped tools | Supports source-quality recipes without exposing unrelated private data |
| SR-09 | Identity-param stripping | Every new scoped read tool | Supplying `actor_id`, `actAsUser`, `email`, `user_id`, or aliases does not affect actor/effective actor |
| SR-10 | Tool catalog lockstep | Any new read/analysis tool | `RECRUITER_TOOL_DEFINITIONS`, `server-contract.test.ts`, read-only annotations, and rollout `allowed_tools` are updated together |

## Recipe Catalog

| ID | Scenario | Expected |
|---|---|
| RC-01 | Capabilities include scoped recipes | `get_recruiting_capabilities` returns rich recipe catalog with ids, summaries, examples, required tools, scope requirements, verification status, completeness requirements, and safety notes |
| RC-02 | Recipes reference only registered tools | Test walks catalog and registered tool list; every `required_tool` exists and is read-only scoped |
| RC-03 | Unsafe old-MCP recipes are reframed | Recipes that need raw/private data are either omitted or documented as unavailable/projected-limited |
| RC-04 | Model-facing choreography | Each recipe includes enough tool order/join guidance for an LLM to execute or for planner to orchestrate deterministically |

## Planner And Analysis

| ID | Scenario | Expected |
|---|---|
| PA-01 | Narrow recruiter generic question | Runs scoped recipes across recruiter's permitted jobs without manual id entry |
| PA-02 | Operator generic question | Does not run org-wide silently; returns scope preview/confirmation requirement |
| PA-03 | Operator confirmed exact scope | Exact ids are validated, then selected recipes run only for confirmed ids |
| PA-04 | Partial scope preview | Planner returns candidate matches and next steps, not empty denial |
| PA-05 | Analysis envelope | Five existing ad-hoc analysis outputs are normalized to a canonical envelope with `data.summary`, `scope`, `completeness`, `attribution_summary`, metrics/rankings, denials, and next steps; planner extraction is updated at the same time |
| PA-06 | Honest partial analysis | If data pages truncate but scoped analysis can return useful partial output, result is marked partial/incomplete with counts and warnings |
| PA-07 | Unknown scope params | Free-text scope params sent directly to analysis are rejected or planner-normalized; they never silently broaden reads |
| PA-08 | Scope handle precedence | When both `scope_handle` and `job_ids` are supplied, handle wins and warning is included |
| PA-09 | Scope gate preservation | Operator runtime reaches recipe path with no confirmed `job_ids`/`scope_handle` | `resolvePlannerScope`/analysis-context still deny broad silent analysis; `scopeContextResolved` is never used to bypass an unconfirmed operator scope |

## Regression And Protected Paths

| ID | Check | Expected |
|---|---|---|
| RG-01 | Protected diff | `git diff -- packages/control-plane/src` is empty |
| RG-02 | Scoped wrapper verify | `npm --prefix packages/scoped-core run verify` passes or skipped reason is documented |
| RG-03 | Recruiter MCP verify | `npm --prefix packages/recruiter-mcp run verify` passes or skipped reason is documented |
| RG-04 | Audit unavailable | Audit outage tests still deny data |
| RG-05 | Existing exact-id scope tests | v1 exact-id, tamper, expiry, cross-user, and permission-revocation tests still pass |
| RG-06 | Dirty worktree hygiene | Existing unrelated dirty bridge/CA or desktop-config changes are not reverted |
| RG-07 | Rollout verify | `npm --prefix packages/recruiter-mcp run guard` passes or skipped reason is documented |
| RG-08 | Catalog safety gates | `no_unexpected_tools`, `no_write_tools`, and read-only annotation checks remain strict; failures are fixed by catalog/evidence updates, not weakened assertions |
| RG-09 | Invariant enforcement map | Each touched safety invariant has a regression test tied to its enforcement site in the v2 packet |

## Live Probe Plan

Do not run these without explicit permission and credentials.

| ID | Probe | Expected |
|---|---|---|
| LP-01 | Operator/site-admin resolves `Senior Cloud Solutions Engineer STEM US` | Candidate preview or confirmed exact-id path works without manual browsing |
| LP-02 | Operator broad question | No silent org-wide analysis; clear scope confirmation path |
| LP-03 | Narrow recruiter natural question | Analysis runs across permitted reqs with no manual ids |
| LP-04 | Known forbidden job | Hidden from actAs scoped preview; visible only to approved operator unscoped sample |
| LP-05 | Recipe parity sample | At least one old-MCP recipe equivalent produces useful scoped output with completeness metadata |
