# Greenhouse Harvest v3 — Recruiting Analytics Capability Matrix

*Author: Claude (Opus 4.8), with Sam Vangelos · 2026-06-27*

Status: **investigation of record.** This corrects a load-bearing project error. The prior analyses (the
Perplexity brief, the phase-2 execution brief, the reference `ats-ops-control-plane` probes) all carried
an inherited assumption — labelled "Context fact #10" in the reference team's own scripts — that *"no
structured stage-transition history exists in Harvest v3; time-in-stage and conversion are unsourceable."*
That assumption was never tested against the endpoint built for exactly this. It is wrong.

## The correction in one paragraph

Greenhouse v3 ships `GET /v3/application_stages`, described in the official spec verbatim as *"the rows
that make up a candidate's stage history on an application — one row per interview stage the application
has occupied, with `entered_at` and `exited_at` timestamps … the canonical source for stage-history
reporting; partner BI integrations typically treat it as the fact table."* (Verified by raw-bytes `curl`
of `harvestdocs.greenhouse.io/reference/get_v3-application_stages.md`, corroborated by the StackOne v3
connector catalog and by the reference team's own shipped `list_application_stages` tool at
`ats-ops-control-plane/packages/control-plane/src/index.ts:2702`.) The reference team probed this endpoint, saw
`entered_at`/`exited_at` come back null, stamped it "degenerate," and reframed every transition metric onto
a `sort_order` depth proxy. They checked the wrong field. **The timestamps being null does not kill stage
analytics, because the rows still exist** — one row per stage each application has occupied. Conversion,
pass-through, and furthest-stage-reached all read off **row existence**, which needs no timestamps. Only
per-stage *dwell duration* needs `entered_at`/`exited_at`, and even that has a `created_at` proxy and a
go-forward webhook fix.

## How transition data is actually retrievable (full surface)

| Path | Direction | Structure | Actor? | From→To? | Gating |
|---|---|---|---|---|---|
| **`GET /v3/application_stages`** | retroactive | structured log, one row/occupancy, `entered_at`/`exited_at`/`days_in_stage`/`current`; filter `application_ids` (~50/call), `job_interview_stage_ids`, date windows | no | inferable from row set + `sort_order` | any customer, OAuth v3 |
| **Webhooks** (`candidate_stage_change`, `hire_candidate`, `reject_candidate`) | going-forward | structured push, **new** `current_stage` only | no | **no `from_stage`, no transition ts** — reconcile against `/application_stages` | admin perm, HMAC-signed |
| **Audit Log API** (`/events`) | retroactive, **30 days only** | structured events, before/after in `event.meta` via `request_id` | **yes (`performer`)** | **yes (before/after diff)** | **Pro tier**, "Audit log" key perm, **3 req/30s paginated** |
| Candidate `activity_feed` (v1) | retroactive | prose `subject`/`body`, `created_at` | yes (`user`) | only inside prose | dies 2026-08-31 |
| Application object | snapshot | `current_stage` pointer + `applied_at`/`rejected_at`/`last_activity_at`; **no stage-entry ts** | no | none | — |

Recommended architecture for full transition analytics: **`/v3/application_stages` for backfill + webhooks
for go-forward capture**, reconciling each webhook's new `current_stage` against the prior stage row to
derive from→to. Audit Log only when "who moved it" matters within a 30-day forensic window on Pro. Build on
v3/OAuth from the start — v1/v2 Harvest and Audit Log V2 are removed 2026-08-31.

## The capability matrix (adversarially challenged)

Every "proxy / unavailable" verdict below survived an adversarial proxy hunt. Five were *upgraded* to
direct during that pass.

### Direct & interactive (ship now — most already coded)
- Current pipeline distribution by stage (candidates-per-stage snapshot)
- Stage concentration / single-stage bottleneck *(shipped: `analyze_pipeline_quality`)*
- Req aging (open duration per req) — `opened_at`/`closed_at`
- Time-in-pipeline (`now − applied_at/created_at`), rolled to per-stage/per-job median/p90
- Staleness (`now − last_activity_at`) *(shipped)*
- Offer cycle time (`created → resolved`) + accept/decline split
- **Time-to-fill** (`opened → filled`) — *upgraded proxy→direct*: `opening.application_id` encodes the hire
- Feedback drag (overdue scorecards vs SLA) *(shipped)*
- Rejection analysis by reason (for-cause vs withdrawal)
- Offer accept rate + offer-out volume / latency
- **Scorecard completion/coverage** (complete vs draft) — *upgraded proxy→direct*
- **Missing-scorecard / scorecard debt** (`status=awaiting_feedback`) — *upgraded proxy→direct*
- **Source effectiveness / yield** (apps→hires by source) — *upgraded proxy→direct*
- **Hire counts** (by req/source/window) — *upgraded proxy→direct* via offer join

### Available via `/v3/application_stages` row existence (no timestamps needed)
- **Stage-to-stage conversion / pass-through** — count distinct applications with a row at stage A vs B,
  ordered by `job_interview_stages.sort_order` (join by **name** — `application.stage_id` and
  `job_interview_stages.id` are disjoint id-spaces)
- **Furthest stage reached / moved-backward (occurrence)** — the set of stage rows per application + ordering
- Funnel-depth snapshot (where the active mass sits on the ordered ladder)
- Gate-skip / deep-funnel-without-scored-loop integrity flag (proxy; "skipped" is inferred, never a stored fact)

### Available after porting reads (a wiring gap, not an API limit)
- **Source/referrer NAME resolution** — register `list_sources` / `list_referrers`; today only numeric ids
  are projected (kills the "ids-only limp")
- Referrer effectiveness (employee-referral yield) — same dependency

### Requires lightweight materialization (or resolved by the live probe)
- **True per-stage dwell duration + historical cohort conversion** — needs
  `entered_at`/`exited_at`/`days_in_stage` populated. **Single open empirical question:** are these populated
  on the pilot tenant, or null like the reference tenant? If populated → direct. If null → either a
  `created_at`-delta proxy on the stage rows, or a nightly snapshot/webhook materialization. *The live probe
  settles this.*

### The honest floor — genuinely not expressible (small and specific)
- **WHO performed a move / before-after actor diff** — only the Audit Log API carries the performer, 30-day
  window, Pro tier. Not in `application_stages`.
- **Per-interviewer panel attribution** beyond `scorecard.interviewer_id` — the interview object exposes only
  `organizer_id` (~0% populated); no panel array.
- **"A scored gate was skipped"** as a stored fact — inferable (deep + no scorecard), never asserted.
- **Identity-joined EEOC/diversity pass-through** — `/v3/eeoc` and `/v3/demographics/*` exist, so *aggregate*
  representation is expressible; joining demographics to identifiable candidates in one response is a
  **compliance** wall we keep closed by design, not an API limit.

## What this changes for the build

1. `application_stages` becomes a first-class ported read (highest-value new capability; batchable, interactive).
2. `list_sources` / `list_referrers` port resolves source/referrer names — the ids-only limp.
3. `measures.ts` gains stage-conversion (row-existence count), pass-through, and dwell (from `entered_at`,
   else `created_at`-delta proxy) alongside the grain-safe `count_distinct`/`ratio` helpers.
4. The capability surface advertises the matrix above honestly — including the four genuine floor items, so
   the model degrades correctly instead of inventing.
5. The live probe's first call is `GET /v3/application_stages?application_ids=…&current=false` on real data,
   to settle the one open empirical question (timestamp population) and decide exact-dwell vs proxy-dwell.

The headline: a recruiting-analytics tool on v3 can answer the full funnel — conversion, pass-through,
velocity, sourcing, scorecard quality, offer analytics — most of it interactively. The genuine "can't" list
is four narrow, well-understood items, not "funnel and time-in-stage."
