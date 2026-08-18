# Greenhouse Harvest v3 — Recruiting-Analytics Capability Map

*Author: Claude (Opus 4.8), with Sam Vangelos · 2026-06-27*

> **⚠️ Superseded / historical (2026-06-28).** Prior-arc planning doc. The at-scale mirror funnel and `measures.ts` it describes were removed — see [`mirror-cache-decision.md`](./mirror-cache-decision.md) for the operative decision. Treat the build steps below as historical context, not the current plan.

Status: **Checkpoint 3 — the capability map.** Built only after the global rules (`v3-contract-foundation.md`)
and the full GET surface (`v3-endpoint-inventory.md`, ~68 specs read in full) were down and agreed. This is the
outcome-anchored answer to "what can a read-only, per-recruiter-scoped MCP actually measure on v3?" — every metric
tagged by the plane that decides it, the genuine floor isolated by cause, and the short list of facts only a live
call can settle.

## How to read this map — the three planes

Every verdict separates three questions that the prior analyses kept collapsing into one. Keeping them apart is
the whole discipline:

- **Plane 1 — can the API express it?** Settled by the docs, now read in full. A "yes" needs one field locator; a
  "no" needs an exhaustive negative across the surface (impossibility earns the highest bar, because a false
  "impossible" is what makes us *not build something buildable* — the failure mode that cost us three times).
- **Plane 2 — is it populated on the pilot tenant?** No document settles this; only a live call does. These are
  flagged explicitly and routed to the day-one probe, not assumed.
- **Plane 3 — have we wired it?** Our code: the scoped reads to port and the `measures.ts` to write. Cheap and
  ours to control.

A capability is shippable when all three clear. Where one doesn't, the cause is named: *API-cannot-express*
(plane-1 permanent), *tenant-sparse* (plane-2, probe), *queried-wrong* (a bug, the most common false "can't"),
*not-yet-wired* (plane-3, a task), or *compliance-wall* (a policy choice, not a limit).

## The foundation every metric stands on (plane 3 — we wire it)

**Scope.** v3 does no per-recruiter row scoping; every list endpoint requires a **Site Admin** authorizing user
(`0001:55`, `0002:48`). So the model is forced and confirmed: the token impersonates a site admin via `sub`, then
we filter to the recruiter's jobs. The job set is `GET /v3/user_job_permissions?user_ids=<recruiter>` (current
per-job grants) **+** `GET /v3/future_job_permissions` (department/office-scoped grants) — both needed for the full
picture. Two edges to handle: a recruiter who is themselves a site admin won't appear in `user_job_permissions`
(detect via `users.site_admin` and treat as all-non-confidential-jobs), and confidential jobs are gated even from a
site-admin token unless the caller is on the hiring team (`0124:828`). Impersonation is the token `sub`, **not** an
On-Behalf-Of header — the reference connector's `client.ts:341` OBO is a v1 artifact that does not apply.

**The mechanical spine.** Cursor pagination (`per_page` ≤ 500, follow `Link`), the `created_at`/`updated_at`
gte/lte windows on every list, the `fields` selector to trim payloads, and child fan-out batched at the universal
**50-ids-per-call** cap. Because the surface is *scoped to one recruiter's jobs*, volumes are small (tens of jobs,
hundreds-to-low-thousands of applications) — which is what makes child fan-out interactive here even though it
wouldn't be org-wide.

## Architecture — two surfaces, and why "at scale" can't run through the live API

Greenhouse is a database internally, but the Harvest v3 API is deliberately **not** a query interface over it: zero
server-side aggregation, zero joins, only rate-limited row fetches. "Conversion across 40 reqs over a year" is not a
query you can send — it's thousands of rows you must drag across a rate-limited wire and reduce client-side. That is
intentional multi-tenant design (the rate limit is the governor protecting a shared transactional DB), not a missing
feature. So the same metric is cheap at one-req scope (≈4 calls, a second) and slow-to-abusive at year×all-reqs
scope (~100+ fan-out calls re-pulled on every load). The line is blast radius, not the metric.

The universal answer when the source is a no-aggregation, rate-limited API is to **own a copy of the data** and
query that. This gives two complementary surfaces, and the scoped MCP routes each question to the right one:

- **Live REST** — "this candidate / this req / right now, freshest possible." Granular reads and active-pipeline
  questions at recruiter scope. Stateless, always fresh.
- **Synced mirror** — "every req, all year, trended / cross-req / cohort." Served from our own store as SQL, near-
  live (refreshed incrementally), with an explicit "as of last sync" freshness stamp.

**The mirror is not greenfield — it already exists in this repo.** `supabase/migrations/003_ytd_analytics.sql`
defines, and `lib/ytd-extract.ts` populates, a Greenhouse→Supabase fact pipeline at the exact grain the at-scale
funnel needs:

| Existing table | Is the mirror of | Carries |
|---|---|---|
| `ytd_application_stage_events` | `/v3/application_stages` | `application_id`, `job_interview_stage_id`, `stage_name`, `stage_rank`, `entered_at`, `exited_at`, `days_in_stage`, `current` |
| `ytd_job_stage_definitions` | `/v3/job_interview_stages` | `job_id`, `stage_name`, `stage_rank` (= `sort_order`), `active` |
| `ytd_application_facts` | denormalized `applications` | per-app: `terminal_outcome` (active/rejected/hired/converted), `current_stage_*`, `max_stage_rank`, `source_*`, `referrer_*`, **`recruiter_ids[]` (GIN-indexed → per-recruiter scope)**, `action_time_quality` (**exact/approximate/unknown**) |
| `ytd_sync_runs` | the sync itself | `run_type` (backfill/incremental), `status`, `completed_at`, `*_upserted` — the freshness contract |

Two things this settles. First, the **dwell-timestamp fork is already solved in the mirror**: `action_time_quality`
encodes exactly the exact-vs-proxy-vs-unknown decision per row, so the at-scale path doesn't wait on the probe the
way the live path does — it already degrades honestly. Second, the **freshness-honesty risk is already scaffolded**:
`ytd_sync_runs.status`/`completed_at` plus `last_synced_at` on the facts are the "as of" stamp, so a stalled sync is
detectable rather than silently serving stale numbers.

The honest gap, stated precisely (and to be verified in `lib/ytd-extract.ts`, not assumed): the facts table is
`CHECK`-constrained to `channel in ('referral','agency')` — the sync currently scans only referral and agency
applications for the YTD dashboards, though `ytd_sync_runs.channel` already allows `'all'`. So serving general
funnel-at-scale for a recruiter's *whole* pipeline is **broaden the scan from two channels to all + relax the
channel framing**, against a pipeline whose schema, stage-event extraction, sync runner, recruiter scoping, dwell-
quality handling, and freshness contract already exist. That is an extension of a running system, not a new build.

In the matrix below, **rate feasibility** therefore reads against the *right* surface: "Direct/Compose" metrics are
interactive on **live REST** at recruiter scope; "at-scale" framings of the same metric (trend, cross-req,
full-year) are served from the **mirror** and are equally feasible there — they just carry the sync's freshness
stamp instead of being to-the-millisecond.

## The capability matrix

Directness: **Direct** (one read or a clean id-join, interactive on live REST) · **Compose** (multi-endpoint
orchestration, interactive at recruiter scope on live REST; the historical/cross-req version runs on the mirror) ·
**Probe-gated** (plane-1 yes, but a named field's population decides the exact live-path form — the mirror already
handles it via `action_time_quality`) · **Floor** (genuine limit — see the floor section).

### Pipeline & funnel

| Operator question | Method (endpoints · fields) | Directness | Plane-2 dependency |
|---|---|---|---|
| How many candidates at each stage right now? | `applications` group by `stage_name`/`stage_id` | Direct *(shipped)* | — (stage_name dense) |
| Is my pipeline bottlenecked in one stage? | `applications` top-stage active concentration | Direct *(shipped)* | — |
| **Stage-to-stage conversion / cohort pass-through** | `application_stages` row existence: count distinct `application_id` with a row at each `job_interview_stage_id`; order by `job_interview_stages.sort_order` (id-join, resolves) | **Compose** | application_stages rows populated (structural; high confidence) |
| Furthest stage reached / moved-backward (occurrence) | `application_stages` row set per app + `sort_order` ordering; later `created_at` at lower sort_order = backward | Compose | `created_at` per row (base attribute, dense) |
| Where does the active mass sit on the ladder? | current stage + `sort_order` depth | Direct | — |
| Gate integrity (deep, no recorded scored loop) | deep band + no `complete` scorecard; sharpened by `job_interviews.require_scorecard` as the expected-scorecard denominator | Compose (proxy) | — |

The funnel — the thing written off as "unsourceable" — is **expressible without any timestamp**: conversion and
pass-through read off *row existence* in `application_stages`, the documented "canonical stage-history fact table"
(`0013:7`). The disjoint-id-space trap the reference team hit applies only to `application.stage_id`;
`application_stages.job_interview_stage_id` → `job_interview_stages.id` is a real id-join that resolves.

### Velocity & timing

| Operator question | Method | Directness | Plane-2 dependency |
|---|---|---|---|
| How long have candidates been in the pipeline? | `now − created_at` (v3's applied anchor) | Direct | — (`created_at` dense) |
| Who's gone stale? | `now − last_activity_at` | Direct *(shipped)* | — |
| **Time-in-stage / per-stage dwell** | `application_stages.days_in_stage` (or `exited_at − entered_at`) | **Probe-gated** | **`entered_at`/`exited_at` population — the headline unknown** |
| **Time-to-fill** | `openings`: `opened_at → closed_at` where `close_reason.name` starts `Hire -` | Direct | `opened_at`/`closed_at` dense |
| Time-to-hire | `created_at → offer.resolved_at` where `offer.status=Accepted` (`current_only`) | Compose | offer rows present |
| Offer cycle time | `offers`: `sent_on → resolved_at` | Direct | — |

Dwell *duration* is the one genuinely probe-gated metric. The v3 spec marks `entered_at` "`null` only for
backfilled or partially recorded history" (`0013:651`) and the reference tenant saw nulls. If the pilot tenant
populates them → exact dwell, direct. If not → two fallbacks, in order: the per-row `created_at` delta as a dwell
proxy (the row is created on stage entry), or a nightly current-stage snapshot that materializes dwell
going-forward (a cron + small store, not a compiler). Either fallback is a plane-3 task, not a wall.

### Quality, interviews & competency

| Operator question | Method | Directness | Plane-2 dependency |
|---|---|---|---|
| Strong-yes rate | `scorecards.candidate_rating` (`strong_yes`…) | Direct | `candidate_rating` populated *(the real v3 field, not the dead v1 `overall_recommendation`)* |
| Scorecard coverage / completion | `scorecards.status` draft/complete vs expected `job_interviews.require_scorecard` | Direct | — |
| Feedback drag | `scorecards`: `interviewed_at → submitted_at` | Direct | — |
| Interviewer load & bus-factor | `scorecards.interviewer_id`; panel via `interviewers` | Direct | — |
| Interview throughput & scheduling lead time | `interviews.status`; `availability_received_at → scheduled_at → starts_at` | Direct | `organizer_id` sparse where calendar-u…integrated (attribute by job, not organizer) |
| Feedback owed | `interviews.status = awaiting_feedback` | Direct | — |
| **Per-competency / skill scoring** | `scorecard_candidate_attributes.candidate_attribute_rating` per `job_candidate_attribute` → name via `job_candidate_attributes`/`candidate_attribute_types` | Compose | attribute layer in use on the tenant's jobs |

### Sourcing, outcomes & geography

| Operator question | Method | Directness | Plane-2 dependency |
|---|---|---|---|
| Source effectiveness (apps→hires by channel) | `application.source_id` → `sources.name` + `type` (strategy) | Direct | — *(names resolve — kills the ids-only limp)* |
| Referral yield | `application.referrer_id` → `referrers.name` | Direct | — |
| Why-lost segmentation | `rejection_details` → `rejection_reasons.type.key` (`WE_REJECTED_THEM` vs `THEY_REJECTED_US` = for-cause vs withdrawal) | Direct | — |
| Offer accept rate | `offers`: Accepted / (Accepted + Rejected), `current_only` | Direct | — |
| Hire counts by req/source/window | offer-join hire anchor | Direct | — |
| **Geographic concentration (reqs / applicants / hires)** | `application.job_post_id` → `job_post_searchable_locations` (`city`, `region_short/long_name`, `country`, `lat`/`long`) | **Compose** | searchable-location population (org posts externally / geocoded); partial — `job_post_id` is null for manual/internal applications |
| Diversity / EEOC pass-through | `eeoc` + `demographic_answers` (row-level, scope-gated) aggregated across the funnel | Compose | self-ID submitted; **compliance-wall on identity-join** |

Geography is a real structured dimension, not a label table: per-post city/state/country/lat-long. The honest
caveat is coverage, not capability — it attributes through `job_post_id`, which is null for manually-created or
internal applications, so geographic rollups cover the post-attributed subset and must say so.

## The live-probe gate (plane 2 — the only honest unknowns)

Five facts no document can settle. One call each on the pilot credential, day one, before the map's verdicts are
final:

1. **`application_stages.entered_at`/`exited_at` population** — decides exact-dwell vs proxy-dwell on the **live**
   path. (The mirror already handles this via `action_time_quality`, so it only gates live-REST dwell, not at-scale.)
   Still the single highest-value probe.
2. **The real `X-RateLimit-Limit`** on this credential's tier — the doc's "75" is an explicit *example*
   (`0000:34`); the header is ground truth. Decides how aggressively child fan-out can run.
3. **`status=active` → response `in_process`** on the wire — doc-confirmed (query enum `0015:637` vs response enum
   `0015:835`), tenant-verify only.
4. **`candidate_rating` population** — the verdict field; confirm it's filled (the inherited "0%" was the wrong v1
   field name).
5. **`job_post_searchable_locations` population** — whether the org posts externally / geocodes, which sets
   geography coverage.

## The honest floor — genuinely not expressible, by cause

Small, specific, and each justified by an exhaustive negative — not by "I didn't find it":

- **The actor on a stage move (who moved whom, before→after)** — *API-cannot-express* in Harvest reads.
  `application_stages` carries the occupancy interval, never the performer. The only source is the separate
  **Audit Log API** (`auditlog:events:list` scope, 30-day retention, Pro tier) — a different product, out of
  this MCP's surface. So "who advanced this candidate" is not answerable from the read connector.
- **"A scored gate was skipped" as a stored fact** — *API-cannot-express*. There is no per-application
  "this gate required a score and didn't get one" flag. It is *inferable* (deep band + `require_scorecard` true +
  no `complete` scorecard) and must be reported as an inference, never asserted.
- **Exact dwell on applications that predate v3 stage-tracking** — *tenant-sparse*, not a limit: if `entered_at`
  is null for backfilled history, pre-cutover dwell is unrecoverable, while go-forward dwell materializes fine.
  This is the one floor item the probe can move.
- **Identity-joined demographic/EEOC analytics** — *compliance-wall*, our choice. `/v3/eeoc` and
  `/v3/demographic_answers` are row-level readable, so aggregate pass-through is fully expressible; we keep the
  demographics-to-identity join closed and enforce a minimum cell size by policy. Not an API gap.

Note what is **not** on this floor, against the inherited corpus: funnel conversion, time-in-stage, the scheduled-
interview endpoint, the scorecard verdict field, source/referrer names, panel attribution, and diversity
pass-through — every one of those was claimed unavailable and every one is expressible.

## The thing you're not seeing

The whole conversation treated the at-scale analytics layer as a future build to weigh against the pilot. It isn't
future — **it is ~80% already running in this repo, and it already solved the two problems I was about to raise as
open risks.** The `ytd_*` fact pipeline mirrors applications *and* stage events at the grain the funnel needs,
carries `recruiter_ids[]` so per-recruiter scope drops straight onto it, encodes the dwell-timestamp fallback as
`action_time_quality` (the "exact vs proxy" fork, decided per row), and stamps freshness through `ytd_sync_runs` so
a stalled sync is loud rather than silent — the exact failure class this project was bitten by before (the sweeps
unapplied-column write, the rotated-key silent "no data"). So the real architectural ceiling was never "can we
afford to build materialization" — it's "we have a materialized analytical mirror serving two channels, and the
scoped recruiter MCP simply isn't pointed at it yet." The latent leverage is large and the net-new work is small;
the risk is the inverse of what I framed two turns ago.

The one genuinely open structural decision left is a *scope-safety* one, not a build one: the existing mirror is
**org-wide** (it was built for the analytics dashboards, which the project's own history flags as bypassing the
scoped projection layer and carrying PII-exposure gaps). Pointing a *per-recruiter-scoped* MCP at an org-wide store
means the recruiter scope (`job_ids` from `user_job_permissions` + `future_job_permissions`) must be re-applied as a
hard predicate on every mirror query — the `recruiter_ids[]` GIN index makes it cheap, but it must be fail-closed,
because a missing predicate here leaks cross-recruiter data the same way a missing RLS hop would. That is the one
place the two surfaces must share exactly one scope resolver.

## What this means for the build

The breadth you asked for is real, most of the live half is interactive at recruiter scope today, and the at-scale
half is mostly already materialized. The shape that falls out:

- **Live REST surface (now/granular):** port `application_stages`, `sources`/`referrers`, `job_interview_stages`,
  and the dimension/geography reads; write `measures.ts` with grain-safe count-distinct/ratio + row-existence
  conversion + the live-path dwell (proxy until the probe says `entered_at` is populated). Interactive, fresh.
- **Mirror surface (at-scale/historical):** route trend/cross-req/full-year questions to the existing `ytd_*`
  tables; verify in `lib/ytd-extract.ts` what the referral/agency scan already captures, then **broaden the scan
  from two channels to all** and relax the `channel` CHECK so a recruiter's whole pipeline lands. Re-apply the
  recruiter `job_ids` predicate, fail-closed, via the same scope resolver the live surface uses.
- **Day-one probe (five items):** `entered_at` population, the real rate-limit header, `in_process` on the wire,
  `candidate_rating` population, searchable-location coverage.
- **Floor (four items), surfaced honestly:** stage-move actor, gate-skip-as-fact, pre-v3 dwell if `entered_at` is
  dead, identity-joined demographics (by policy).

That is a genuinely expansive, dynamic recruiting-analytics surface — funnel, velocity, quality, competency,
sourcing, outcomes, diversity, geography — across both *now* and *at scale*, resting on the actual v3 contract plus
a fact pipeline that already exists, with a floor of four well-understood items instead of the phantom "funnel is
impossible."
