# Scoped-Recruiter Greenhouse MCP — Build Spec & Implementation Roadmap

*Author: Claude (Opus 4.8), with Sam Vangelos · 2026-06-27*

> **⚠️ Superseded / historical (2026-06-28).** Prior-arc planning doc. The at-scale mirror funnel and `measures.ts` it describes were removed — see [`mirror-cache-decision.md`](./mirror-cache-decision.md) for the operative decision. Treat the build steps below as historical context, not the current plan.

> **Current catalog note (2026-07-20).** The model-facing recruiter catalog is now the exact 44-tool allowlist in [`../../README.md`](../../README.md), including `search_my_application_stages` and the narrow `read_my_resume` flow. Counts and “missing read” statements below describe the historical state this superseded plan analyzed; they are not current release claims.

Status: **Checkpoint 4 — the build spec.** Written after the v3 capability map (`v3-capability-map.md`,
the contract) and verified against the code that existed at authoring time: `lib/ytd-extract.ts` + `lib/ytd-normalize.ts`, the three
job-scope resolver files, the then-current live surface, `supabase/migrations/003_ytd_analytics.sql`, and the two
porting docs. Every "build X" below is anchored to a capability-map row **and** a primary-source code or schema
locator. Where the code disagreed with the map, the code wins and the disagreement is called out in §0.

This spec stops at **ready-to-deploy**. Sam deploys (real recruiters, real PII). Nothing here deploys autonomously.

---

## 0. What the code read changed (read this first)

The capability map is right about the shape of the opportunity and about the v3 contract. Reading the code under it
moved seven things — five corrections and two sharpenings. None of them break the thesis; several make the safe path
cheaper and the unsafe path more clearly marked.

1. **The scope derivation is not in the resolver files — it's the live `list_jobs` read.** The map (and the prior
   framing) describe the recruiter's `job_ids` as derived from token `sub` + `user_job_permissions` +
   `future_job_permissions`, merged in the resolver. That merge is **not** in `resolver.ts` / `capabilities.ts` /
   `inventory.ts`. It happens upstream in the scoped core (`runtime.js` / `services.js`), reached via
   `scopedReadWithTimeout(runtime, "list_jobs", …)` and `fromScopedRead("list_jobs", …)`. The resolver layer consumes
   *already-permission-filtered* job records plus a `permissionScope.kind` discriminant (`"jobs" | "operator" | "all"`)
   — `inventory.ts:91-145`. Consequence: the shared scope contract both surfaces reuse is **the live-resolved
   `scope_handle`**, not a SQL re-derivation. This is cleaner and safer than the map implied — see §2.

2. **`job_interview_stages` is already ported.** The map lists it under "reads to port." It isn't missing —
   `search_my_job_interview_stages → list_job_interview_stages` is live (`evidence.ts:11`). The genuinely-missing
   reads narrow to **`application_stages`, `sources`, `referrers`, `departments`, `offices`,
   `job_posts` + `job_post_searchable_locations`, `job_candidate_attributes` + `scorecard_candidate_attributes`** —
   and the funnel keystone was `application_stages`, which was not in the former 19-tool curated surface. It is now exposed as `search_my_application_stages` in the exact 41-tool catalog.

3. **The mirror scope predicate is `job_id`, not `recruiter_ids[]`.** The map says "re-apply the `job_ids`
   predicate… the `recruiter_ids[]` GIN index makes it cheap" — conflating two different predicates.
   `ytd_application_facts` carries **both** `job_id` (indexed via `idx_ytd_facts_year_channel_job`, `003:100`) and
   `recruiter_ids[]` (GIN, `003:104`). `job_id ∈ scope` is the **authorization boundary** (matches the live surface);
   `recruiter_ids && [me]` is **attribution** ("apps I personally recruited"). The security boundary must be `job_id`,
   because scope means "the jobs you're permitted to see," and a recruiter should see every application on their reqs,
   not only the ones where they're the tagged recruiter. The GIN index serves an optional "my personal pipeline"
   filter, never the boundary.

4. **The channel-broaden is a real (bounded) build, not a CHECK relax.** The map calls broadening referral/agency →
   all channels "an extension of a running system, not a new build… broaden the scan + relax the CHECK." Verified
   against the code, the *normalization core is* channel-agnostic and carries over — stage events
   (`ytd-normalize.ts:304-314`), `terminal_outcome` (`:215-219`), `recruiter_ids` (`:529`), `action_time_quality`
   (`:374-392`). But four things are hard edits: the `ytd_application_facts.channel` CHECK *hard-rejects* any new
   value and persists zero rows (`003:23`); `channelsFor()` hard-codes the pair (`ytd-extract.ts:89-92`); the fetch
   model is `source_ids`-scoped, not job-scoped (`:300-319`, and agency *throws* on an empty source registry,
   `:131-133`); and source attribution is channel-branched and silently nulls for a third channel
   (`ytd-normalize.ts:512-523`). The agency conflict/fee subsystem assumes agency semantics and runs only inside
   `if (input.channel === "agency")` (`ytd-extract.ts:596-637`). So the mirror-broaden is the bigger lift and it
   touches the running YTD dashboards — it belongs in a later, migration-gated phase, not the first slice. See §4.

5. **The capability surface currently tells the model the funnel is impossible.** `capabilities.ts:122` asserts
   *"Harvest v3 exposes no stage-transition history"* and `:123` says the only stage join is by **name** because
   `application.stage_id` and `job_interview_stages.id` are disjoint id-spaces. Both are stale pre-v3-read beliefs.
   `/v3/application_stages` *is* the stage-history fact table, and its `job_interview_stage_id → job_interview_stages.id`
   is a real id-join (endpoint inventory `0013:643`). The `stage_latency` recipe does the name-join workaround
   *because it never ported `application_stages`*. Porting the read without rewriting these strings leaves the model
   refusing questions it can now answer — so the string rewrite is part of the same slice (§3), locked by the
   catalog-wide knowledge test (`phase-2-execution-brief.md:78`).

6. **The mirror carries PII the live surface forbids.** `ytd_application_facts` stores `candidate_name` and
   `candidate_email` (`003:24-25`), plus `referrer_name`, `primary_recruiter_name`. The live surface's `excluded`
   contract bans candidate contact and raw profiles (`capabilities.ts:412`). The scoped mirror reader must therefore
   apply the *same* projection the live `evidence-projection` layer applies — scope predicate alone is not enough.
   And there is **no RLS** on the `ytd_*` tables, so the app-layer predicate and projection are the only boundary.

7. **The site-admin-recruiter edge is delegated upstream and behaves differently than the map states.** The resolver
   never reads `users.site_admin`; admin status is `inventory.scopeKind !== "jobs"` (`resolver.ts:201`), set from the
   upstream `permissionScope.kind`. An operator/all admin gets `canViewConfidential = true` (sees confidential), not
   the map's "all-*non*-confidential." Whether a site-admin recruiter who is absent from `user_job_permissions` is
   classified as `operator`/`all` (handled) or `jobs`-with-empty-set (fails closed as a zero-job recruiter) is decided
   upstream and is **unverifiable from these three files** — it needs a read of `runtime.js`/`services.js` or the live
   probe. Flagged as an open item in §6, not assumed.

Net: the live-REST half is closer to done than the map implied (one keystone read missing, plus dimension/geo/competency
reads), the scope-sharing is cheaper and safer (reuse the live handle), and the mirror-broaden is more real than "relax
a CHECK." The funnel the inherited corpus called impossible is one ported read plus three string rewrites away.

---

## 1. The two-surface architecture and the routing model

Two surfaces, one scope contract. The split is by *blast radius*, not by metric — the same conversion number is cheap
at one-req scope on the live API and abusive at year×all-reqs scope, so the question's *shape* picks the surface.

- **Live REST** — "this candidate / this req / right now, freshest possible." Stateless reads against Harvest v3,
  scoped to the recruiter's jobs, reduced client-side. Volumes are small at recruiter scope (tens of jobs,
  hundreds-to-low-thousands of applications), which is what makes child fan-out interactive here.
- **Synced mirror** — "every req, all year, trended / cross-req / cohort." Served from the existing `ytd_*` Supabase
  tables as SQL, with an explicit "as of last sync" freshness stamp.

Why at-scale cannot run live: the adversarial review's claim 6 *survives* on arithmetic. Harvest does zero server-side
aggregation, so per-application analysis is O(applications) rate-limited reads; a multi-thousand-application fan-out is
tens of minutes against a ~90-second interactive budget. The mirror is not an optimization — it is the only way to
answer the year-scale funnel at all. The live surface owns *now*; the mirror owns *all year*.

The routing rule the MCP applies:

| Question class | Surface | Why |
|---|---|---|
| "How many candidates at each stage **right now**?" / active-pipeline / stale | **Live REST** | freshest; small at recruiter scope; already shipped (`pipeline_quality`, `stage_latency`) |
| "Show me **this** candidate / req / scorecard / offer" | **Live REST** | granular single-entity read |
| Conversion / dwell / source-yield **for one req or a handful, this cycle** | **Live REST** | interactive at one-req scope; `application_stages` row existence |
| Conversion / time-in-stage / source-mix **across all my reqs, all year, trended** | **Mirror** | year×all-reqs fan-out is non-interactive live; pre-materialized in `ytd_application_stage_events` + `ytd_application_facts` |
| "How am I trending vs last quarter" / cohort pass-through over months | **Mirror** | needs history the live API won't aggregate |

Both surfaces resolve scope identically (§2) and report completeness honestly — the live surface via
`inventory_complete` (`capabilities.ts:416`), the mirror via the `ytd_sync_runs` freshness stamp (§4). A surface that
cannot prove completeness refuses rather than serving a partial number silently; this is the existing fail-closed
posture extended, not invented.

---

## 2. The shared fail-closed scope contract (both surfaces)

This is the one place the two surfaces must agree exactly, because a missing predicate on the org-wide mirror leaks
cross-recruiter data the way a dropped RLS hop would. The verified architecture is **simpler and safer than
re-deriving scope in SQL**: scope is always resolved *live*, and the mirror consumes the result.

**Scope is resolved live, once, and signed.** The recruiter resolves and confirms scope through the existing flow —
`resolve_job_scope → confirm_job_scope → scope_handle` — which paginates `list_jobs` through the scoped core
(`inventory.ts:91-145`), inheriting the upstream `user_job_permissions` / `future_job_permissions` filtering. The
handle is minted only when a confirmed, complete, non-empty match exists (`analysis_allowed = scope_handle !== null`,
`resolver.ts:853`), and it is signed, session-bound, short-lived (`capabilities.ts:417`). Every fail-closed guarantee
already proven on the live path comes with it:

- API error → `UPSTREAM_ERROR`; timeout → `TOOL_TIMEOUT`; never a partial-but-usable scope (`inventory.ts:125-134`).
- Incomplete/truncated inventory → `complete = false` → no handle (`inventory.ts:146`; `resolver.ts:336,458-462`).
  A requested id not seen under incomplete inventory is treated as forbidden, not "not found, proceed."
- Empty grants / no match → no handle → analysis gated off (`resolver.ts:853`). No default-allow anywhere.
- Confidential jobs stripped for narrow recruiters (`canViewConfidential = scopeKind !== "jobs"`,
  `inventory.ts:136-145`); excluded ids parked for a diagnosable denial, never surfaced or used to broaden.

**The mirror is a data surface, not a scope surface.** A mirror-backed analysis tool accepts the *same confirmed
`scope_handle`* the live analysis tools accept, resolves it to the recruiter's `job_ids`, and runs:

```sql
WHERE scan_year = :year AND job_id = ANY(:scoped_job_ids)   -- idx_ytd_facts_year_channel_job (003:100)
```

It must **not** build a Supabase `JobInventoryProvider` to *resolve* scope off the mirror — `recruiter_ids[]` and
`job_id` in the facts table are sync-time snapshots, not the authoritative live permission state, so resolving scope
off them would freeze a recruiter's authorization at the last sync and could leak (stale grant still present) or
under-show. Scope resolution stays live; the mirror only answers "give me the rows for *these already-authorized*
job_ids." This inherits §2's entire fail-closed chain for free and adds no new authorization surface to pen-test.

**Three hard requirements on the mirror query path**, because there is no RLS backstop (`003` creates plain tables):

1. **Scope predicate, fail-closed, single chokepoint.** Every mirror read goes through one query builder that *requires*
   a resolved `job_ids` array and injects `job_id = ANY(:scope)`. A call without a scope throws; there is no code path
   that reads `ytd_*` without the predicate. (Mirror the live posture: the resolver mints no handle without job_ids.)
2. **PII projection.** Never select `candidate_email`, `candidate_name`, `referrer_name`, `primary_recruiter_name`
   (`003:24-25,35,39`) into a model-visible result. Apply the same allowlist discipline the live
   `evidence-projection` layer applies (`capabilities.ts:412` bans candidate contact / raw profiles). Scope alone is
   not enough — the mirror holds columns the live surface deliberately drops.
3. **Freshness gate.** Read `ytd_sync_runs.completed_at` / `status` for the relevant channel+year and stamp every
   mirror answer "as of <completed_at>"; if the latest run is `failed` or staler than a threshold, degrade to a loud
   "mirror is stale" rather than serving silently — the analogue of `inventory_complete=false`. The project's own scar
   tissue (the rotated-key silent "no data," the sweeps unapplied-column write) is exactly this failure class.

**Implementation note to verify on build:** confirm how `job_ids` flow from a confirmed `scope_handle` into the live
analysis tools today (handle payload vs re-resolve), and reuse that exact path for the mirror tools — do not invent a
second handle-to-ids mechanism. The Supabase connection is already established for identity
(`identity.ts:146-222`, gated by `GREENHOUSE_RECRUITER_STATE_BACKEND=supabase_postgrest`); the mirror reader extends
that backend rather than opening a new one.

**Open edge (see §6):** the site-admin-recruiter classification is upstream and unverified here (`§0.7`). Until it's
read or probed, an admin-scope mirror query inherits the live resolver's admin confirmation guardrail
(`resolver.ts:362-368`, admin + non-exact path forces confirmation) — so an admin cannot silently run an org-wide
mirror aggregate any more than they can a live one.

---

## 3. The live-REST build

### 3a. The porting cadence — the 9-site lockstep

Adding a scoped read is a fixed lockstep across nine sites; skipping one either fails a lock or silently ships a gap
(`phase-2-execution-brief.md:47-63`). It is the *demonstrated* safe cadence on this branch —
`list_offers` (commit `86539b9`), with `list_openings` / `list_rejection_details` / `list_users` as prior worked
templates. The nine sites: the `scoped-greenhouse` `DEFAULT_FILTER_REGISTRY`; `EVIDENCE_TOOL_MAP`;
`EVIDENCE_TOOL_DEFINITIONS`; `EVIDENCE_DOMAIN_CLASSIFICATIONS` (not caught by any test — checklist-mandatory);
`EVIDENCE_PROJECTORS` + a `project<X>Row` with an explicit safe allowlist (missing projector ⇒ raw passthrough leak);
`limits.ts` only if a new filter param is needed; the three hardcoded ordered name-lists in the contract tests; and
the three rollout JSON catalogs. The rollout gate asserts the live remote catalog equals
`RECRUITER_TOOL_DEFINITIONS.map(name)` exactly — drift fails. Discipline: red→green per task, commit per task, never
proceed on red, never weaken a guard to satisfy a list lock.

### 3b. The reads to port (each anchored to a capability-map row + endpoint locator + id-join key)

| Read (new `search_my_*`) | Backs capability-map row | Endpoint + key locators | Domain class / scope key |
|---|---|---|---|
| **`application_stages`** | Pipeline&funnel: stage-to-stage conversion / furthest-stage / pass-through (row existence) | `GET /v3/application_stages`; resp `0013:625-668`; join `job_interview_stage_id → job_interview_stages.id` `0013:643`; `entered_at 0013:651`, `exited_at 0013:659`, `days_in_stage 0013:663`; filters `application_ids 0013:488`, `job_interview_stage_ids 0013:503`, `current 0013:544` | **application-backed** (join via permitted `application_id`); fan-out 50 ids/call |
| **`sources`** | Sourcing: source effectiveness by channel + strategy | `GET /v3/sources`; resp `0161:837-866` (`name`, `type{id,name}` strategy); key `id ← application.source_id` | **global-reference** (no job key; safe metadata only) |
| **`referrers`** | Sourcing: referral yield | `GET /v3/referrers`; resp `0149:556-578`; key `id ← application.referrer_id` (distinct from `referrers.user_id`, `0149:568`) | **global-reference** |
| **`departments`** | Geography/dimension rollups | `GET /v3/departments`; resp `0085:562-591`; key `id ← job.department_id` (FLAT) | **global-reference** (dimension tree) |
| **`offices`** | Geography/dimension rollups | `GET /v3/offices`; resp `0133:566-611`; key `id ← job.office_ids[]` (array) | **global-reference** |
| **`job_posts`** + **`job_post_searchable_locations`** | Geographic concentration (reqs/applicants/hires) | `GET /v3/job_posts` `0121:842+` (`first_published_at` posting age); `GET /v3/job_post_searchable_locations` `0120` (`city`, `region_*`, `country`, `lat`/`long`); keys `application.job_post_id → job_posts.id`, `searchable_locations.job_post_id → job_posts.id` | **job-scoped** via `job_posts.job_id`; geo is partial — `job_post_id` null for manual/internal apps, must say so |
| **`job_candidate_attributes`** + **`scorecard_candidate_attributes`** | Per-competency / skill scoring | `GET /v3/job_candidate_attributes 0104` (label resolver, key `id ← scorecard_candidate_attributes.job_candidate_attribute_id`); `GET /v3/scorecard_candidate_attributes 0154` (`candidate_attribute_rating`, key `scorecard_id → scorecards.id`) | **application-backed** via scorecard→application; rating enum differs from `candidate_rating` (adds `mixed`/`definitely_not`) |

Already live, do not re-port (`evidence.ts:7-27`): `jobs`, `job_owners`, `openings`, `job_interview_stages`,
`job_interviews`, `interviews`, `applications`, `candidates`, `scorecards`, `rejection_details`, `rejection_reasons`,
`users`, `notes`, `tracking_links`, `offers`. The funnel keystone — `application_stages` — is the one structural gap;
the rest are dimension/geo/competency enrichments.

Three reads stay deferred behind the live probe (`phase-2-execution-brief.md:33-34,102`): `job_notes`,
`default_interviewers`, `scorecard_question_answers` — zero documented fields and/or no confirmed job/application key.
Do not build them from docs; that is the exact "invent the shape" failure Phase 1 fixed twice.

### 3c. `measures.ts` — grain-safe aggregation, the function library (not a grammar)

This is the one pro-rebuild lever the adversarial review credits as real (claims 1 and the dismissed-alternative,
lines 74-76, 274-285): the five analysis tools each hand-roll ratio/mean/percentile with bespoke weights, and a single
audited aggregator de-risks the wrong-grain double-count class. The review's verdict — *function-library problem, not
a grammar problem* — is the design. `measures.ts` exposes one correct way to roll up a one-to-many join and refuses
the forward fan-out:

- **`count_distinct(rows, key)`** and **grain-keyed `ratio(numerator, denominator)`** — every existing recipe's
  ratio/mean routed through these so grain is declared, not implicit.
- **Row-existence stage conversion** — `count_distinct(application_id) with a row at job_interview_stage_id S`,
  ordered by `job_interview_stages.sort_order` (`0108:605`). Needs **no timestamps** — conversion and pass-through are
  pure row existence in `application_stages` (capability-map "Pipeline & funnel"). This is what makes the funnel
  shippable before the dwell probe resolves.
- **Live-path dwell proxy** — `days_in_stage` / `exited_at − entered_at` when populated; otherwise the per-row
  `created_at` delta as a proxy, otherwise "unavailable on v3," never reported as zero (the existing honest-degrade,
  `capabilities.ts:122` tail — keep that behavior, fix its premise). The exact-vs-proxy fork is probe-gated on the
  *live* path only; the mirror already encodes it as `action_time_quality` (§4).

`measures.ts` is callable from the recipes and from the model-composition path (§5) — the same audited helpers behind
both, so a novel question composed by the model rolls up grain-safely without re-deriving the math.

### 3d. The capability-surface drift fix (ships with `application_stages`)

When `application_stages` lands, three strings in `capabilities.ts` become false and must be rewritten in the same
slice, or the model keeps refusing the funnel:

- `:122` *"Harvest v3 exposes no stage-transition history"* → it does: `/v3/application_stages`, conversion via row
  existence; dwell duration probe-gated.
- `:123` *"join by stage NAME… id-join returns 0 rows"* → the **real** id-join is
  `application_stages.job_interview_stage_id → job_interview_stages.id` (`0013:643`); the disjoint-id warning applies
  only to `application.stage_id` (`0015:581`), a different field.
- `:152` *"sending status=in_process is a 422"* → reword to the verified claim: the query and response status
  vocabularies are asymmetric — **query `active`, response `in_process`** (primary-source-confirmed, `0015:637` vs
  `0015:835`). Keep the belt-and-suspenders filter (`active || in_process`); drop the unproven "422" mechanism (public
  docs return an empty 200 for an invalid status, not a 422 — adversarial review claim 4). The wire behavior is probe
  item 3, not an asserted fact.

Lock it with the catalog-wide knowledge test (`phase-2-execution-brief.md:78`): assert the funnel/stage recipes'
`verification` strings now match the corrected substrings and *fail* on today's stale ones.

---

## 4. The mirror build

### 4a. Verified coverage — what already works

`lib/ytd-extract.ts` populates, per sync run, four tables (plus an env-gated fifth): `ytd_job_stage_definitions`
(`onConflict job_interview_stage_id`), `ytd_job_owner_snapshots`, `ytd_application_stage_events` (`onConflict id`,
the GH stage id), and `ytd_application_facts` (`onConflict application_id`) — `ytd-extract.ts:849-919`. The funnel
grain the at-scale path needs is already materialized and **channel-agnostic**:

- Stage events carry `entered_at` / `exited_at` / `days_in_stage` / `stage_rank` (rank = per-job order index+1),
  copied from the raw GH stage — `ytd-normalize.ts:304-314,281-289`. The stage-events table has **no channel column**
  (`003:65-76`); it is keyed by `application_id` and rides whichever applications get scanned.
- `terminal_outcome` is a pure function of `app.status` (`active|in_process → active`; `rejected/hired/converted`
  passthrough; else `unknown`) — `ytd-normalize.ts:215-219`, matching the SQL CHECK (`003:54`).
- `recruiter_ids[]` come from job-owner resolution (`:529`), channel-agnostic — the per-recruiter scope key.
- `action_time_quality` encodes exact/approximate/unknown per row (`:374-392`) — the dwell fork the live path must
  probe for is *already decided* in the mirror, so at-scale dwell degrades honestly without waiting on the probe.
- Freshness lives in `ytd_sync_runs`: `running → completed/failed`, watermark in `metadata.covered_through` keyed on
  `updated_at` (`ytd-extract.ts:940-943,342-365`); the prior per-channel composite-key upsert bug is fixed — single
  `application_id` conflict target guarded by pre-upsert `dedupeByKey` (`:912-916`).

What is **not** channel-agnostic, and would mislead if naively broadened: `referrer_*` populate only for
`channel==='referral'`, `agency_source_*` only for `channel==='agency'` (`ytd-normalize.ts:512-523`); the entire
conflict/fee subsystem runs only inside `if (input.channel === 'agency')` (`ytd-extract.ts:596-637`, `.eq('channel','agency')` at `:188`); the referral jobless-app drop assumes only referral produces jobless apps (`:488`).

### 4b. The concrete channel-broaden — a job-scoped "all-pipeline" mode

To serve a recruiter's *whole* pipeline at scale, the mirror must contain all their applications, not just
referral/agency. This is the bigger lift and it touches the running YTD dashboards, so it is a later phase (§8), built
as an **additive job-scoped sync mode** rather than "open the source filter":

1. **Schema:** `ALTER TABLE ytd_application_facts` to relax `channel CHECK` to admit a new provenance value
   (e.g. `'all'`, already legal on `ytd_sync_runs`, `003:9`). A migration — dormant-by-default, env-gated, following
   the project's migration-gated-writeback rule so a half-applied migration can't corrupt the dashboards.
2. **Fetch model:** add a job-scoped scan that fetches a recruiter's applications by `job_id` (the MCP's own scoping)
   rather than by `source_ids`; extend `channelsFor()` / the `YtdChannel` type (`ytd-extract.ts:89-92`).
3. **Attribution:** populate the channel-agnostic columns (stage events, `terminal_outcome`, `recruiter_ids`,
   `source_id`/`source_name` — the facts table already has generic source columns, `003:29-30`); leave
   `referrer_*` / `agency_source_*` / `conflict_*` null for the general channel.
4. **Coexistence with the dashboards (column-preserving upsert):** an application that is *also* referral/agency must
   not have its referrer/agency/conflict columns nulled by the general scan. The general-mode upsert updates only the
   channel-agnostic columns and preserves the channel-specific ones; the agency conflict passes simply don't fire for
   the general channel (no break, a coverage gap to label).

**One genuine product fork for Sam (the only one in this spec):** should the existing referral/agency YTD dashboards
*start counting* these general-pipeline applications, or stay segmented to referral/agency as the migration comment
intends (`003:1-3`)? That decision sets whether the new channel value is orthogonal provenance or folds into the
dashboards' existing channel segmentation, and it is a product call about the dashboards, not a code constraint.

### 4c. The scoped at-scale query path

A new mirror reader module (extending the `supabase_postgrest` backend, `identity.ts:146-222`) exposes one or two
mirror-backed analysis recipes that accept a confirmed `scope_handle` (§2), resolve it to `job_ids`, and answer the
year-scale funnel/velocity/outcome questions from `ytd_application_stage_events` + `ytd_application_facts` with
`WHERE scan_year = :y AND job_id = ANY(:scope)`, projecting non-PII, stamping freshness. The `recruiter_ids[]` GIN
index (`003:104`) backs an *optional* "just my personal pipeline" filter on top — never the scope boundary.

---

## 5. The dynamic-composition surface decision

**Keep the curated exact 41-tool surface; do not collapse to ≤8.** The adversarial review *refutes* the ≤8 forcing
function (claim 2): the degradation curves that bite at low tool counts are built on confusability-ranked near-clone
distractors, not a clean single-domain surface, and Anthropic's own threshold is "30–50 tools loaded at once" on a
*cross-domain* set. The connector ships exactly **41 model-visible tools** today — 29 evidence reads, one explicit
resume reader, four scope/meta tools, and seven analysis/front-door tools — as the ordered `PILOT_TOOL_NAMES`
catalog. It remains a single-domain set inside the cited band.

**No bespoke compile-then-execute DSL/compiler** (claims 1, 3, 6 — settled, and adopted by Sam). The "planner" is a
five-entry recipe selector (`answer_my_recruiting_question` over fixed `RECIPES[]`), not an intent compiler; the
grain-safe symmetric-aggregate compiler, join-cost planner, and per-hop scope re-application the rebuild thesis priced
as multi-month *do not exist in source*, and a deterministic compiler over sparse v3 fields produces
deterministically-shaped garbage for exactly the funnel/dwell questions it was meant to win. The grain-safety value is
real and is delivered as `measures.ts` (§3c), a function library, not a grammar.

**How recipes/capabilities are exposed:**

- The six analysis recipes stay as curated tools, each accepting a signed `scope_handle`. New mirror-backed recipes
  (§4c) join them as additional analysis tools with the same scope contract.
- `get_recruiting_capabilities` stays the static catalogue the model reads to choose a recipe — and its `verification`
  strings are the surface that must be kept *true* (the §3d drift fix is the live example of why).
- **Model composition (Code-Mode posture) for the novel join-spanning question** the recipes don't cover. The review's
  dismissed-but-correct alternative (lines 262-301): expose the existing scoped reads as a small typed API the model
  calls, joins, and aggregates over — behind the *same* scope-and-PII boundary that already exists, with `measures.ts`
  as the one correct rollup. The novel-question value the DSL was supposed to uniquely buy falls out of code over the
  read primitives for free, at none of the cost of a grammar the model must first learn to emit. This is a posture the
  surface already half-implements — `answer_my_recruiting_question`'s catalog is "model-composed from scoped reads, not
  planner-run" — so it is a hardening of the existing path, not a new build, and it is the *last* phase (§8), earned
  only if the curated recipes demonstrably leave value on the table.

The review's bake-off (a 30-question Arm A vs Arm B prototype, lines 304-334) was the decision procedure for *whether*
to fund the compiler. Sam has settled that — no compiler — so the bake-off collapses to its Arm A (widen the surface,
ship `measures.ts`, route at-scale to the mirror) plus the live feasibility probe, which §6 carries forward as the
day-one gate.

---

## 6. The day-one live probe (five items)

Five facts no document settles; one read each on the pilot credential, before the map's verdicts are final. Each is
named with what it unblocks and what the build does in the meantime.

1. **`application_stages` returns rows, and `entered_at`/`exited_at` population.** Two-part, and sharper than the map
   stated. (1a) Does `GET /v3/application_stages?application_ids=…` return rows for the recruiter's applications at all
   — settling the inherited "degenerate / 422" fear (adversarial review claim 6) that `capabilities.ts:122` still
   encodes? (1b) Are `entered_at`/`exited_at` populated? **Unblocks:** exact live dwell. **Meanwhile:** conversion and
   furthest-stage ship now off row existence (no timestamps), dwell labels "approximate/unavailable." **Note:** the
   mirror's `ytd_application_stage_events` is *already populated from this endpoint* for referral/agency apps — strong
   empirical evidence the endpoint is queryable, which de-risks 1a before the probe even runs.
2. **The real `X-RateLimit-Limit`** on this credential's tier — the doc's "75" is an explicit example (`0000:34`); the
   header is ground truth (custom vs partner differ). **Unblocks:** how aggressively live child fan-out can run.
   **Meanwhile:** the existing fail-closed truncation/timeout behavior holds regardless.
3. **`status=active` → response `in_process`** on the wire (`0015:637` vs `0015:835`). **Unblocks:** retiring the
   "422" wording in `capabilities.ts:152`. **Meanwhile:** the belt-and-suspenders `active || in_process` filter is
   already correct either way.
4. **`candidate_rating` population** — the v3 verdict field (`0160:733`), not the dead v1 `overall_recommendation`.
   **Unblocks:** strong-yes-rate as a live metric. **Meanwhile:** scorecard coverage/completion ships independent of it.
5. **`job_post_searchable_locations` population** — whether the org posts externally / geocodes (`0120`).
   **Unblocks:** geographic concentration. **Meanwhile:** the dimension reads (department/office) cover non-geo rollups.

**Plus one open structural item to settle by reading `runtime.js`/`services.js` or by probe (§0.7):** whether a
site-admin recruiter absent from `user_job_permissions` is classified upstream as `operator`/`all` (handled) or
`jobs`-empty (fails closed as zero-job). Until settled, the admin-confirmation guardrail (`resolver.ts:362-368`)
prevents a silent org-wide run, so this gates *completeness for admin-recruiters*, not safety.

---

## 7. The honest floor (four items)

Small, specific, each justified by cause — not "I didn't find it."

- **The actor on a stage move (who moved whom).** *API-cannot-express* in Harvest reads. `application_stages` carries
  the occupancy interval, never the performer; the only source is the separate Audit Log API (`auditlog:events:list`,
  30-day retention, Pro tier), out of this MCP's read surface.
- **"A scored gate was skipped" as a stored fact.** *API-cannot-express.* Inferable (deep band + `require_scorecard`
  true at `0109` + no `complete` scorecard) and must be reported as an inference, never asserted.
- **Exact dwell on applications predating v3 stage-tracking.** *Tenant-sparse*, the one floor item the probe can move:
  if `entered_at` is null for backfilled history, pre-cutover dwell is unrecoverable while go-forward dwell
  materializes fine.
- **Identity-joined demographic/EEOC analytics.** *Compliance-wall, our choice.* `/v3/eeoc` and
  `/v3/demographic_answers` are row-level readable so aggregate pass-through is expressible; we keep the
  demographics-to-identity join closed and enforce a minimum cell size by policy. Not an API gap.

Not on this floor, against the inherited corpus: funnel conversion, time-in-stage, the scheduled-interview endpoint,
the scorecard verdict field, source/referrer names, panel attribution, diversity pass-through — every one was claimed
unavailable and every one is expressible.

---

## 8. Phased sequence to a ready-to-deploy pilot

Each phase is independently revertible, follows red→green per-task-commit, gates on
`verify` + `verify:rollout` + protected-path-diff-empty, and never weakens a guard to satisfy a list lock. Node health
is a prerequisite every phase (`phase-2-execution-brief.md:0` — the homebrew dyld break; use the pinned node
workaround). Human gates are marked **⟂**.

**Phase A — the funnel keystone (live REST).** Port `application_stages` through the full 9-site lockstep; write the
row-existence conversion path in `measures.ts`; rewrite the three stale `capabilities.ts` strings (§3d) and lock them.
*Scope:* one read + measures core + string fixes. *Risk:* low — proven cadence, additive, no migration, no probe
dependency (conversion needs no timestamps). *Unlocks:* the entire funnel the surface currently calls impossible.
**⟂** after the catalog/permission-surface change (the one place this touches the published catalog).

**Phase B — `measures.ts` consolidation + dimension/sourcing reads.** Route the five existing recipes' bespoke
ratio/mean through `measures.ts`; port `sources`, `referrers`, `departments`, `offices` (global-reference, cheap).
*Scope:* aggregation library + four reference reads. *Risk:* low-medium — touches existing recipe math, so lock each
recipe's output against fixtures before/after. *Unlocks:* source/referral yield with names, dimension rollups.

**Phase C — the live probe (human-run) + its dependents.** Sam runs the five-item probe (§6) on the pilot credential.
Then, gated on results: exact live dwell (if `entered_at` populated), geography (`job_posts` +
`job_post_searchable_locations`, if geocoded), competency attributes, and the `capabilities.ts:152` "422" retirement.
*Risk:* low — each dependent is additive and degrades honestly if its probe comes back negative. **⟂** the probe
itself; **⟂** the site-admin-recruiter classification question.

**Phase D — the mirror at-scale path (read-only).** Build the scoped mirror reader (§4c) and one or two mirror-backed
recipes over the *existing* referral/agency `ytd_*` data, with the §2 scope predicate + PII projection + freshness
gate. *Scope:* read path only — no extract change yet. *Risk:* medium — this is the first cross-recruiter-data surface;
the scope chokepoint and PII projection are the review targets. **⟂** before any mirror tool is enabled on a
distributable surface (this is the new leak surface — adversarially review the predicate and projection).

**Phase E — the channel-broaden (migration-gated).** Resolve the §4b product fork with Sam; ship the dormant,
env-gated migration relaxing the facts CHECK; add the job-scoped "all-pipeline" sync mode with column-preserving
upsert; broaden the mirror recipes to the whole pipeline. *Risk:* high — touches the running YTD dashboards and the
extract. **⟂** the migration (Sam applies); **⟂** the dashboard-coexistence decision; do not deploy the broadened
extract autonomously.

**Phase F (earn-it) — model-composition hardening.** Only if the curated recipes demonstrably leave novel
join-spanning value on the table: harden the Code-Mode path (§5) — typed read API, `measures.ts` rollups, same
scope+PII boundary. *Risk:* medium, deferred by design; the review's whole point is this is earned, not assumed.

Phases A–C are the live-REST pilot and need no DB migration; D–E add the at-scale mirror; F is optional. A credible
internal pilot is **A–C plus D over existing mirror data** — the funnel, velocity, quality, sourcing, and
dimension/geo surface across *now* (live) and the referral/agency *all-year* (mirror), with the whole-pipeline
broaden (E) as the fast-follow. **Timeline:** the original "by Monday" target was consumed by the API read — §10 asks
Sam to re-confirm the date before committing to a phase cut.

---

## 9. The thing you're not seeing

The highest-value finding is not in any single section — it is that **the scope-safety architecture got simpler and
the funnel got closer the moment the code contradicted the map.** The map framed "both surfaces share one scope
resolver" as a thing to build and a risk to manage. The code shows the share is nearly free *if you resolve scope live
and feed the mirror the result* — because the entire fail-closed chain (incomplete→deny, empty→deny, confidential
strip, admin confirmation) already exists on the live `list_jobs` path and rides the signed handle. The temptation the
map's wording invites — build a Supabase `JobInventoryProvider` and resolve scope off `recruiter_ids[]`/`job_id` in the
mirror — is the *wrong* move: it would freeze authorization at the last sync and is the exact dropped-RLS-hop leak the
map warns about, dressed as an optimization. The safe design routes authorization through one always-live path and
treats the mirror as dumb data behind it. That inverts where the risk sits: the danger isn't "we haven't built the
shared resolver," it's "someone builds a *second*, staler one for the mirror."

Two adjacent findings in the same vein. First, the capability *surface* is itself a correctness artifact that has
already drifted: `capabilities.ts:122-123,152` tell the model the funnel is impossible and the status query 422s, and
those strings are read by the planner to decide what it can answer. Porting reads without auditing the surface copy
ships a connector that *can* answer the funnel and *refuses to* — a class of bug invisible to every green test that
doesn't assert on the capability strings (which is why §3d's lock matters). Second, the mirror holds PII the live
surface spent real effort excluding (`candidate_email`/`name`); pointing a "scoped" reader at it without re-applying
the projection would leak contact data through the *back* door while the front door stays locked. Both are the same
shape: a safety property enforced on surface 1 silently absent on surface 2. The build's job is to make the two
surfaces share *every* boundary — scope, PII, completeness — not just the happy-path data.

---

## 10. The prioritized first execution slice

**Phase A, and within it: port `application_stages` + write the row-existence conversion in `measures.ts` + rewrite
the three stale `capabilities.ts` strings, as one red→green slice through the 9-site lockstep.**

Why this is the single highest-leverage move:

- It unlocks the **entire funnel** — conversion, pass-through, furthest-stage — which the inherited corpus called
  impossible and the current surface actively refuses (`capabilities.ts:122`). One read closes the biggest capability
  gap in the product.
- It is **unblocked by the probe**: conversion is row existence (`0013:625-668`), needs no `entered_at`, no rate-limit
  answer, no tenant population fact. It ships today and the dwell-duration refinement layers on after Phase C.
- It rides the **proven cadence** — the same 9-site lockstep that added `list_offers` in one autonomous turn — with no
  DB migration, no cross-recruiter surface, and full revertibility.
- It forces the **capability-surface-as-correctness-artifact** discipline (§9) on the first slice, with a catalog-wide
  lock, so the "ships but refuses" bug class is caught at the start rather than discovered in pilot.

Concretely, in order: (1) extend `test/fixtures-production-shapes.ts` with a v3 `application_stages` fixture and write
the three RED locks — the lockstep parity lock, a conversion-from-row-existence lock, and the catalog-wide knowledge
lock asserting the corrected `capabilities.ts` strings; (2) port `application_stages` through all nine sites with an
`application-backed` domain class and an explicit projector allowlist; (3) implement `count_distinct` +
row-existence conversion in `measures.ts`; (4) rewrite `capabilities.ts:122-123,152`; (5) green, `verify` +
`verify:rollout`, protected-path diff empty, commit per task. **⟂** at the catalog/permission-surface change before
proceeding to Phase B.

---

## Anchoring index (capability-map row → build artifact → verified locator)

| Capability-map row | Build artifact | Code/schema/endpoint locator |
|---|---|---|
| Stage-to-stage conversion (row existence) | Phase A: port `application_stages` + `measures.ts` | `0013:625-668`, join `0013:643`; lockstep `phase-2-execution-brief.md:47-63` |
| Time-in-stage / dwell (probe-gated) | live proxy in `measures.ts`; mirror `action_time_quality` | `0013:651/659/663`; `ytd-normalize.ts:374-392`; `003:50` |
| Source effectiveness / referral yield | Phase B: port `sources`, `referrers` | `0161:837-866`, `0149:556-578` |
| Geographic concentration | Phase C: `job_posts` + `searchable_locations` | `0121:842+`, `0120` |
| Per-competency scoring | Phase C: competency attribute reads | `0104`, `0154` |
| Strong-yes rate | live `candidate_rating` (probe 4) | `0160:733` |
| Funnel/velocity at scale, all-year | Phase D/E: scoped mirror reader + broaden | `003:65-76,20-63`; `ytd-extract.ts:89-92,300-319,596-637` |
| Per-recruiter scope (both surfaces) | §2: live handle → `job_id = ANY(scope)` | `inventory.ts:91-145,136-145`; `resolver.ts:853`; `003:100` |
| Completeness/freshness honesty | live `inventory_complete`; mirror `ytd_sync_runs` | `capabilities.ts:416`; `ytd-extract.ts:342-365,940-943` |
| The ≤8-vs-curated surface call | §5: keep exact 41 tools, no DSL | `tools/register.ts` (`PILOT_TOOL_NAMES`); adversarial review claims 1-3,6 |
