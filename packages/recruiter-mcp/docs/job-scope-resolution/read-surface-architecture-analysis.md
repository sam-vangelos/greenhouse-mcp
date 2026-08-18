# Read-Surface Architecture Analysis — Scoped Recruiter Greenhouse MCP

*Author: Claude (Opus 4.8), with Sam Vangelos · 2026-06-27*

Status: **decision proposed, not yet ratified.** This is the analysis of record for whether and how to
re-architect the read surface so a recruiting team can get *almost any* question about Greenhouse state
answered — granular, aggregate, and join-spanning — dynamically and modularly, with **no write/orchestration
capability** for the broader org (explicitly out of scope by Sam's direction; too high risk for now).

It synthesizes four inputs:

1. A direct map of the **current v2 recruiter surface** (this repo).
2. A subagent map of the **full Greenhouse Harvest v3 endpoint universe** (~170 endpoints: ~135 read / ~54 write).
3. A subagent map of the **reference `ats-ops-control-plane` MCP** (~100 tools: 72 read / 28 write; 11 recipes; verified v3 connector).
4. An independent architecture brief produced by **Perplexity's multi-agent "Computer"** product (`~/Downloads/Greenhouse_LLM_Architecture.md`), and my own prior reevaluation.

---

## TL;DR — the decision

**Adopt a "semantic layer over Harvest" with a compile-then-execute core.** Replace the current ~15 fixed
projected read tools + ~11 hardcoded recipes + recipe-selecting planner with:

- a **declarative entity-relationship registry** (the single source of truth: per-entity endpoint, scope rule,
  PII tier, join edges, named measures, data-quality traps);
- a **typed plan grammar** the LLM emits (it never writes URLs, picks join keys, sets `per_page`, or decides
  "what counts as active");
- a **validator + compiler + executor + aggregator** that is the only thing that touches Harvest, enforces
  scope and PII at compile time, does client-side joins via a REST DataLoader, and produces grain-safe rollups;
- a **minimal MCP surface** (≤8 tools, schema as Resources, recipes as Prompts).

This direction is **independently convergent**: my reevaluation and the Perplexity brief reached the same
architecture from different starting points, and it matches what every production "LLM over structured data"
system has shipped (Snowflake Cortex Analyst 51%→90%+, Databricks Genie 32%→>90%, Cube, dbt MetricFlow, Uber
QueryGPT, GitLab KG Query Engine, Cloudflare Code Mode 2,500→2 tools). The convergence is the strongest single
argument, and it formally **retires** the earlier incremental plan to "port the missing reads as new tools" —
those endpoints become registry rows, not tools.

The decision is **not** a rubber stamp of the Perplexity brief. The brief is right on architecture and wrong on
several Greenhouse v3 facts in exactly the place that matters most — the registry — and that wrongness is the
most important lesson in this document.

---

## 1. The architecture (what we're building)

Five layers, each with one job:

```
MCP Surface (≤8 tools, Resources, Prompts)   ← discovery + invocation
        │ typed JSON plan
Plan Validator (registry = truth)             ← compile-time correctness
        │ validated plan
Compiler (plan → DAG of Harvest fetches)      ← scope + PII injection
        │ execution DAG
Executor (fan-out, batch, dedupe, cache)      ← REST DataLoader
        │ rows
Aggregator (grain-safe rollups, honesty)      ← symmetric aggregates + completeness envelope
```

The same plan grammar serves all three question classes Sam named:

- **Granular** — `get(application 12345) expand:[current_stage, rejection_details]` → one fetch + registry-resolved joins.
- **Aggregate** — `entity:application measure:stage_conversion_rate dims:[department, quarter] filters:[…]` → compiler knows the measure's grain and emits the right fan-out + dedupe.
- **Join-spanning** — `scorecard → application → status where overall_recommendation=strong_yes and status=rejected` → multi-hop plan; executor joins client-side because Harvest does no server-side joins.

The property the current "fixed tools + fixed recipes" surface lacks: one grammar, three shapes, novel
questions included.

### Surface (≤8 tools)

`plan_query` (the workhorse — submit a typed plan), `explain_plan` (dry-run cost estimate before execution),
`search_entities` (fuzzy id finder), `describe_entity` (just-in-time schema), `list_capability`,
`get_user_context`, `submit_followup`, `report_truncation`. Schema (ER graph, relationships, measures,
data-quality traps, capability index) lives in **Resources** (zero per-turn token cost). The current 11 recipes
become **Prompts** (slash commands) that emit pre-filled plans — same recruiter UX, no planner coupling.

---

## 2. What the Perplexity brief sharpened (conceded and adopted)

These are improvements over my prior reevaluation; adopt them:

- **One submitted plan beats composable primitives.** I had proposed `fetch`/`expand`/`aggregate` as separate
  tools the model chains. A single typed plan compiled server-side is better: chaining primitives reintroduces
  multi-turn tool-selection and the model deciding join order/grain per call — the exact degradation we're
  avoiding. Let the model express full intent once; the server owns joins, grain, cost, scope.
- **Named measures with declared grain + symmetric aggregates** (MetricFlow / Looker / Malloy) is a more
  concrete wrong-grain guard than my "grain-aware aggregate." Each measure declares its anchor entity; the
  compiler refuses cross-fan-out forward aggregation. The double-count-across-one-to-many bug ("the query runs,
  the number looks reasonable, it's wrong") is the most dangerous failure in the whole design.
- **`explain_plan` dry-run, schema-as-Resources, recipes-as-Prompts**, the REST DataLoader executor, the
  three-budget caps (api_calls / wall_clock / leaf_rows), and the completeness-envelope shape
  (`rows_dropped_by_scope`, `rows_dropped_by_pii_tier`, `truncation_reason`). Adopt as specified.
- **Empirical backing for the small surface.** LiveMCPBench: retrieval errors ≈ half of all failures at scale;
  tool-count vs function-calling accuracy declines monotonically for every frontier model. One-tool-per-endpoint
  for 135 endpoints is structurally indefensible. This validates the ≤8-tool target.

## 3. Where the brief is wrong for our v3 connector (corrections + the lesson)

The brief is confidently, specifically wrong about Greenhouse in ways that would corrupt the registry. The
registry is the contract the compiler trusts absolutely, so bad facts produce confidently-wrong plans. This is
the most valuable thing the brief surfaced — by being a cautionary example.

- **The `application.status` enum is inverted.** The brief asserts `status ∈ {active, rejected, hired,
  converted}` with "there is no `in_process`," and bakes `status_enum: [active, rejected, hired, converted]`
  into its registry YAML. Our tenant-verified ground truth is the opposite on the *response* leg: you **query**
  with `status=active` (sending `in_process` returns 422), but live v3 **responds** with `status: "in_process"`.
  Evidence in our own code: `src/tools/pipeline-quality.ts` treats `active || in_process` as live
  (`isActiveApplicationStatus`); the S4 recipe knowledge encoded in
  `src/resolvers/job-scope/capabilities.ts` states verbatim "queried with status=active (sending
  status=in_process is a 422 …) and the response is filtered on status===\"in_process\"". The reference
  Harvest map corroborates ("live v3 returns in_process, not active"). Had we built the registry from the
  brief's YAML, the compiler would filter responses on `"active"`, match nothing, and report a confident empty
  answer — the exact footgun the architecture exists to prevent.
- **It is v1-flavored throughout.** It routes through `/v1/...` paths, claims "there is no separate
  `/referrers` resource," and leans on `/v1/candidates/{id}/activity_feed`. Our connector is v3
  (`harvest.greenhouse.io/v3`); the reference map confirms `/v3/referrers` and `/v3/sources` exist, and we
  established earlier that the v1 field reference (`ats-api-field-reference.md`) is wrong for this connector.
  Endpoint paths, field names, and pagination must come from the v3 contract and the reference's working code.
- **Minor:** the PII section says "three fixed tiers" then lists five; and it assumes OAuth 2.1 PKCE per
  session, where we deliberately run a durable email→session→identity model. Note both; inherit neither.

**The lesson:** a research model's API facts are a *hypothesis*. The registry must be sourced from the reference
MCP's verified v3 implementation plus a live tenant probe, with an automated drift-watch. The brief's own
status-enum error is the proof.

## 4. The keystone neither analysis put first: the registry's facts are the foundation

Both analyses treated the live Harvest probe as a later-phase gate. That is backwards. The registry's per-entity
truth — status vocabulary, which fields are actually populated, the real join keys, pagination behavior,
confidential/private handling — *is* the data foundation, and §3 proves it cannot be synthesized. So the first
move is to **seed the registry from `ats-ops-control-plane`'s verified v3 projections and filters** (a working
v3 connector is a far better source than any doc) and **confirm the volatile facts against the live tenant**
before the compiler is trusted to emit a single plan. The probe is not a side quest; it is the data layer.

## 5. The divergence we override: scope is Phase 1, not Phase 3

The brief sequences per-user scope and PII at Phase 3, after building the spine and full registry — reasonable
for a greenfield team that hasn't built scoping. We are not that team. We already have it, and an unscoped spine
with scope bolted on later would discard that work and open the confused-deputy window the brief itself warns
about. For us, the RLS predicate is in the compiler from the first plan. Mapping:

| Architecture layer (brief) | What we already built (v2) | Artifact |
|---|---|---|
| `get_user_context` + scoped job IDs | `resolve_job_scope` + permission resolution | `resolvers/job-scope/*`, `scoped-greenhouse` permission provider |
| Per-entity RLS predicate | the scope filters | `filterDirectJobScopedRow` / `filterApplicationBackedRow` / `globalReferenceListTool` + `extractJobIds` (`scoped-greenhouse/src/index.ts`) |
| PII tiers / projection | the projectors + classifications | `evidence-projection.ts`; `EVIDENCE_DOMAIN_CLASSIFICATIONS` (`evidence.ts`) |
| Completeness envelope | the S2 honesty layer | `analysis-result.ts` completeness/freshness |
| Three-budget caps + fail-closed truncation | limits + the F1 fix | `limits.ts`; `resolvers/job-scope/inventory.ts` timeout branch |
| Compiler / validator | the planner (becomes this) | `question-answer.ts` (`answer_my_recruiting_question`) |
| Trusted queries / Prompts | the 11 recipes | `capabilities.ts` recipes → Prompts |
| Registry data-quality facts | the S4 v3 traps | `capabilities.ts` verification strings (organizer_id ~0%, status asymmetry, current_stage_at ~0%, sort_order join) |

So the v2 hardening was not a detour this supersedes — it built the **envelope and the verified-fact seed** this
architecture stands on. What gets replaced is the *surface* (15 tools + recipe-tools → `plan_query` + Resources +
Prompts) and the formalization of registry/compiler/executor/aggregator.

## 6. Honest cost and risk

The brief's closing line ("write five YAML files and a validator") undersells it. The hard, multi-month work is
the **grain-safe symmetric-aggregate compiler**, the **join-cost planner**, and **fail-closed scope
re-application at every join hop** — and that last one is where a bug is a cross-scope data leak, not a wrong
number. The YAML is the easy part. Realistic risk profile:

- Highest risk: scope-across-joins (Phase with two-engineer review on every RLS predicate; internal-only until
  pen-tested against the confused-deputy class).
- Medium risk: grain-safe aggregation correctness (trap every grain failure with eval cases).
- Brittle / defer hardest: the activity-feed stage-history parser (the only path to time-in-stage / funnel
  rates; v1-flavored, regex-on-free-text, expensive). The honest "unavailable" we already return beats an
  invented funnel number until it clearly earns the build.

This is a multi-month arc, not a sprint. Sam's "be ambitious, avoid incrementalism" sanctions the rebuild; this
section is the counterweight so it is not under-resourced.

## 7. The unified, sequenced plan

- **Phase 0 — Foundation (the keystone).** Seed the registry from the reference's verified v3 reads; run the
  live tenant probe to lock the volatile facts (status vocabulary, populated-ness, join keys, pagination,
  confidential/private). Stand up the drift-watch. *Nothing downstream is trustworthy without this.*
- **Phase 1 — Spine, narrow, scoped from day one.** Registry + plan DSL + validator + compiler + REST
  DataLoader + grain-safe aggregator, on 5 entities (`application`, `job`, `candidate`, `scorecard`, `user`),
  with scope and PII **in the compiler**, reusing the v2 envelope. Gate on a 30-question regression suite that
  beats the current planner on ≥20.
- **Phase 2 — Widen the registry** to full v3 coverage; each domain a PR + measures + tests.
- **Phase 3 — Harden scope-across-joins** as the highest-risk, internal-only-until-pen-tested phase.
- **Phase 4+ — Latency/coverage polish:** trusted-query pinning for the top 20–30 questions; pre-aggregations
  for hot dashboard questions; (deferred) materialized stage history.

## 8. Open questions to pressure-test (feeds the adversarial review)

1. Is a compile-then-execute semantic layer over-engineered for a *recruiting* MCP at this team's scale, vs a
   moderately wider tool surface + a stronger planner? Where is the break-even?
2. Does the ≤8-tool / benchmark evidence transfer to *our* models and *our* domain, or is it cited out of context?
3. Is "scope is already built, reuse it" optimistic? Scope-across-joins is genuinely new; how much of
   `scoped-greenhouse`'s single-entity filtering actually survives into a multi-hop compiler?
4. Is the planner→compiler migration a real reuse or a near-rewrite mislabeled as reuse?
5. Is the status-enum correction itself fully right, or is the asymmetry more nuanced (query vs response, v1 vs v3)?
6. Is the multi-month cost still optimistic? Where does it become a 6-month build?
7. Does this architecture defer the team's actual near-term need (breadth *now*) too far?
8. Is `ats-ops-control-plane` a trustworthy registry source, given it is org-wide and a different product with its own possible bugs?
