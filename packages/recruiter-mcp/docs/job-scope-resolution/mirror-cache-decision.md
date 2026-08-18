# Greenhouse MCP Mirror/Cache Decision

Date: 2026-06-28

## Decision

Do not introduce a Greenhouse mirror or cache in this phase.

The live-first implementation now has the required local foundations: endpoint registry, shared read-all execution, scoped endpoint adapters, role-aware projection metadata, semantic facts, reusable metrics, migrated recipes, dynamic planning, and local product evals. However, the required live-path latency and rate-limit measurements were not run because production/live probes require explicit approval.

Without authorized live measurements, there is no decision-record basis to prove that the live path cannot satisfy the documented requirements.

## Evidence Available

- Local registry guard verifies 72 vendored Harvest v3 GET/read endpoint facts.
- Local read-all tests verify cursor follow-up behavior, timeout/rate-limit incomplete statuses, and no arbitrary `maxPages` completeness.
- Local projection tests verify material default fields and explicit omission/incomplete-projection metadata.
- Local fact and metric tests verify semantic fact construction, metric definitions, evidence references, exclusions, and fail-closed completeness.
- Local recipe/planner tests verify fact/metric-backed recipes, dynamic metric selection, and explicit missing-domain/incomplete answers.
- Local product eval tests verify representative prompts include scope, domains, projection profile, metric definitions, evidence references, omissions, and completeness status.

## Missing Required Live Evidence

The following required Phase 9 inputs remain unavailable because live probes were not authorized:

- Observed `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers.
- Authorized endpoint mix, request counts, page counts, row counts, and per-page behavior on real scoped data.
- Retry count, `Retry-After` handling, scheduler waits, elapsed time, and completeness status for realistic workflows.
- Broad-scope latency arithmetic using measured request windows and observed endpoint chaining.
- Freshness and permission-change behavior under the deployed service.

## Live-Path Requirement Not Proven Unsatisfied

No live-query requirement is currently proven impossible or unacceptable after:

- registry coverage,
- `per_page=500` where supported,
- cursor-only follow-ups,
- deadline-aware rate-limit scheduling,
- scoped adapters,
- projection profiles,
- fact planning,
- metric planning,
- migrated recipes,
- dynamic planner selection.

## Supabase Project Boundary

Do not assume the `recruiting-ops-analytics` project is the Greenhouse MCP state store.

The documented Greenhouse MCP Supabase project is `Greenhouse MCP` (`exampleprojectref000`), and current usage is identity/session revocation only. No mirror/cache storage ownership is accepted or introduced here.

## Future Reconsideration Gate

A future mirror/cache proposal must include all of the following:

- A specific live-query requirement that remains unsatisfied after the live-first implementation.
- Authorized live measurements with observed rate-limit headers and latency arithmetic.
- Endpoint and row-count breakdown by workflow.
- Freshness requirements.
- Backfill and resync plan.
- Failure semantics and fail-closed behavior.
- Data ownership and retention policy.
- Confirmed Supabase/storage project ownership.

Until those inputs exist, the correct state is live-first with explicit incomplete statuses where the local implementation lacks an executable fact path.
