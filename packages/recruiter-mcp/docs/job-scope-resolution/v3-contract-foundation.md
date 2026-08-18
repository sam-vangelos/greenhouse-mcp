# Harvest v3 Contract Foundation — Checkpoint 1 (guides read in full)

*Author: Claude (Opus 4.8), with Sam Vangelos · 2026-06-27*

Status: **Checkpoint 1 of the from-scratch doc read.** Source of truth = `docs/harvest-v3-api/` (verbatim
vendored snapshot, retrieved 2026-06-27). This artifact captures the **global rules layer** (all 10 guides,
read in full) plus the **v1→v3 field-alias map** from the migration guides, and tests every inherited
assumption against the primary docs. It deliberately stops short of capability verdicts — those come after the
165 endpoint specs are read (Checkpoint 2) and the live tenant probe (Checkpoint 3). Per the agreed method:
foundation first, confirm it, then build on it.

Locators below point into `docs/harvest-v3-api/raw/guides/` by line.

---

## A. Global conventions (verified, primary-sourced)

**Auth (`0001-authentication.md`).** OAuth 2.0. Custom integrations use the **Client Credentials** flow: POST
`https://auth.greenhouse.io/token`, HTTP Basic `CLIENT_ID:CLIENT_SECRET`, body
`grant_type=client_credentials&sub=<USER_ID>` (0001:60-64). **Impersonation is the token `sub` — a numeric
`user_id` — not a per-request header** (0001:48-54). Omitting `sub` uses the credential's auto-created
Integration Service User. Transition period only: mint a v3 JWT from a v1/v2 key at
`https://harvest.greenhouse.io/auth/token` (Basic `<KEY>:`) (0001:134-136). After v1/v2 removal, **OAuth is the
only method** (0001:144).

**The central scoping fact (`0001:55`, `0002:48`, `0005:239`).** *"All list endpoints require authorization by a
Site Admin."* GET endpoints "are only accessible by site admin users. All other user types will not return
results." Greenhouse v3 does **no per-recruiter row-level scoping on reads.** To read any list, the token `sub`
must be a Site Admin (or the ISU at site-admin level). **Therefore per-recruiter scope must be enforced in our
layer:** impersonate a site admin, then filter to the recruiter's permitted `job_id`s — and the source of truth
for those is `GET /v3/user_job_permissions` (0008:1512, `user_role_id`→`role_id`), itself a site-admin-only read.

**Rate limiting (`0000-api-rate-limiting.md`).** Fixed **30-second** window. Headers on every response:
`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (epoch). **The doc's `X-RateLimit-Limit: 75`
is explicitly labelled an *example* (0000:34), not the contract** — "Rate limits will be applied separately for
custom integrations and partner integrations" (0000:20). The real per-tier limit is knowable only from the live
header. Token requests get a separate 60s window. 429 → obey `Retry-After` (0000:50-56).

**Pagination (`0003-pagination.md`).** Cursor-based. First request carries filters + `per_page`; then follow the
`Link: …; rel="next"` header until absent (only `next`, no prev/last). **Cursor must be the *only* query param**
or you get 422 (0003:62-69). `per_page`: default 100, min 1, **max 500** (0003:73-76). Ordered by `id` DESC.
Each page costs one rate-limit unit.

**Standard list filters (`0002-list-endpoints.md`).** Per resource: `cursor`, `per_page`, `ids`, parent-resource
id arrays, `created_at` / `updated_at` (operators `gte|lte|gt|lt`, pipe syntax `created_at=gte|2024-01-01T…Z`),
`custom_field_option_id`, `status` (when applicable). Parent filters use comma lists: `candidate_ids=12345,12346`.

**Standardizations (`0007`, `0006`).** ISO-8601 UTC datetimes; `_on` = date-only, `_at` = datetime. **Parent IDs
appear in children; child IDs do NOT appear in parents** unless the nested data is unique and has no own endpoint
(0007:16-20). `priority`→`sort_order` everywhere. `created_at`+`updated_at` on every resource except
`demographic_questions` and `demographic_answer_options`. **Children are no longer embedded in parents** —
`GET /candidates` does not return applications; filter `/applications?candidate_ids=` instead (0006:19-20).

---

## B. The v1→v3 alias map (from `0008` read-migration + `0009` write-migration)

This is the Rosetta Stone. It is *why* the inherited (v1-flavoured) analyses were wrong on field names.

**Applications (`0008:74-87`).** `credited_to`→`referrer_id` · `applied_at`→**`created_at`** · `source`→`source_id`
· `location`→`location_address` · `rejection_reason`→`rejection_reason_id` · `rejection_details`→
`question_custom_fields` · **`jobs`→`job_id` (FLAT, single — not `jobs[]`)** · prospective_* → `prospect_details.*`.
And the load-bearing instruction: **`current_stage` is NOT on the application** — "retrieved from the Application
Stages endpoint leveraging the `stage_id` in the application object … From there, call the Job Interview Stages
endpoint to retrieve the name."

**Activity feed (`0008:32-36`).** v1 `/v1/candidates/{id}/activity_feed` → v3 `/v3/notes` (notes & emails, with a
`type` discriminator). The old feed's **stage-change events are not in /notes — they are the structured
`/v3/application_stages` rows** (per the Applications row above). v3 split the feed: prose → `/notes`, transitions
→ `/application_stages`.

**Job Stages (`0008:850-950`).** v1 `/v1/job_stages` → v3 `/v3/job_interview_stages` (+ `/job_interviews`,
`/interview_kits`, `/scorecard_questions`, `/default_interviewers`). `priority`→`sort_order` (the funnel-depth
ladder; "Application Review" = sort_order 0). `interview_kit.questions[]`→`/scorecard_questions` with
`interview_kit_id` parent.

**Scorecards (`0008:1388-1390`).** `candidate_id` removed (get via application) · `submitted_by`→`submitter_id`
(doc typo "submtter_id") · **`overall_recommendation`→`candidate_rating`** (the verdict field is renamed in v3 —
the inherited "overall_recommendation ~0%" was reading a v1 field name).

**Scheduled interviews (`0008:1259-1353`).** v1 `/v1/scheduled_interviews` → **v3 `/v3/interviews`** (+ `/users`,
`/interviewers`). `organizer`→`organizer_id` · `start.date_time`→`starts_at`/`all_day_start_on` ·
`end.date_time`→`ends_at`/`all_day_end_on`. (Corrects the inherited "v3 has no scheduled_interviews endpoint.")

**Offers (`0008:952-1064`).** v1 → `/v3/offers` (+ `/openings`). `sent_at`→`sent_on` · `starts_at`→`starts_on`
(date-only). `current_only` boolean filter for the current offer.

**Openings (`0008:1129-1188`).** `status`→**`open` (enum→boolean)** · `priority`→`sort_order`. (opened_at/closed_at
+ close_reasons for time-to-fill.)

**Hiring team (`0008:633-649`).** v1 hiring_team → `/v3/job_hiring_managers` + **`/v3/job_owners` (recruiters,
coordinators, sourcers)**.

**Jobs (`0008:809-811`).** `departments[]`→**`department_id` (FLAT)** · `offices[]`→`office_ids[]` (array) ·
`openings.status`→`openings.open`.

**Users (`0008:1552`).** `disabled`→`deactivated` · `primary_email_address`→`primary_email`. **User roles**
(`0008:1522`): `type`→`role_type`. **User job permissions** (`0008:1516`): `user_role_id`→`role_id`.

**Candidates (`0008:274-281`).** Deprecated embedded `applications[]`/`application_ids`/`attachments`/`photo_url`.
**Recruiter & coordinator moved to the Application object.** `is_private`→`private`.

**EEOC / demographics (`0008:575-486`).** v1 `/v1/eeoc` → `/v3/eeoc`; demographics → `/v3/demographic_*`. Present
in v3.

**Sources (`0008:1466`)**, **rejection_reasons (`0008:1253`)**, **close_reasons**: "no notable changes."

---

## C. Assumptions falsification ledger (inherited claim → verdict against v3 docs)

| # | Inherited claim | Source | Verdict | What the v3 docs say |
|---|---|---|---|---|
| 1 | Scope predicate is `application.jobs[].id IN scoped` (array) | architecture audit §5 | **REFUTED** | Flat `job_id` (`0008:81`). Predicate is `application.job_id IN scoped`. |
| 2 | "No stage-transition history on v3; `application_stages` degenerate; time-in-stage/funnel unsourceable" (fact #10) | phase-2 brief, reference probes | **REFUTED at contract level** | `/v3/application_stages` IS the stage-history table; migration guide routes `current_stage` through it (`0008:76`, `0008:850`). Whether `entered_at` is populated **on this tenant** is the one open empirical Q → live probe. |
| 3 | "v3 has no scheduled_interviews endpoint" | reference recipe | **REFUTED** | v1 scheduled_interviews → `/v3/interviews`, with `starts_at`/`ends_at`/`organizer_id` (`0008:1278-1286`). |
| 4 | "No activity feed on v3 → transitions gone" | reference probe | **REFUTED** | Feed split: prose→`/v3/notes`; transitions→`/v3/application_stages` (`0008:34`, `0008:76`). |
| 5 | `overall_recommendation` ~0% populated (verdict field dead) | reference, Perplexity | **REFRAMED — wrong field name** | v3 renamed it `candidate_rating` (`0008:1390`). Population must be re-checked on the real field. |
| 6 | Impersonation via On-Behalf-Of header | reference connector `client.ts:341` | **REFUTED for v3** | v3 impersonation is the token `sub` (`0001:48-54`); no per-request OBO header. |
| 7 | Rate limit = 75/30s (~2.5 req/s), fixed | my earlier cost analysis | **PARTIALLY REFUTED** | 75 is the docs' *example* (`0000:34`); real limit only from the live `X-RateLimit-Limit` header, and differs custom vs partner (`0000:20`). |
| 8 | `current_stage_at` ~0% on application = no dwell | phase-2 brief | **MOOT (v1 frame)** | v3 puts stage-entry time as `entered_at` on `application_stages`, not on the application. Re-check `entered_at`, not `current_stage_at`. |
| 9 | status: query `active` / response `in_process`; `in_process`=422 | reference, phase-2 | **OPEN — verify in endpoint spec + live** | Must read `get_v3-applications` spec for the actual status enum (note `applied_at`→`created_at`). Not yet confirmed either way. |
| 10 | Reads can be per-recruiter scoped by Greenhouse | (implicit) | **REFUTED + CENTRAL** | All list/GET reads require a **Site Admin** `sub` (`0001:55`). Per-recruiter scoping is ours to enforce after impersonating a site admin. |

---

## D. What this already settles for the product

The marquee recruiting analytics that were written off — **funnel conversion, pass-through, time-in-stage,
moved-backward** — are addressed by a **structured, first-class, vendor-documented v3 endpoint**
(`/v3/application_stages`), joined to `/v3/job_interview_stages` (sort_order ladder + stage names). This is not
a free-text-parsing workaround and not a proxy; the migration guide *instructs* integrations to use it for the
current stage. The single remaining unknown is empirical, not architectural: **are `entered_at`/`exited_at`
populated on the pilot tenant** (exact dwell) or null (then dwell needs `created_at`-of-row as a proxy or a
nightly snapshot)? Conversion and furthest-stage need only row existence and so do not depend on that answer.

## E. Plan from here (the checkpoints)

- **Checkpoint 2 — endpoint sweep.** Read all 165 reference specs in full; build a field-level inventory
  (path, params/filters, response schema + example, pagination, scopes) to disk, GET/read endpoints first
  (the read-only MCP's actual surface), then writes. Confirm the exact schemas behind §B/§C (e.g.
  `application_stages` fields, `application.status` enum, `offer.status`, `candidate_rating` values,
  `job_owners` roles, demographic gating).
- **Checkpoint 3 — live tenant probe** (needs Render creds): the empirical facts no doc can settle —
  the real `X-RateLimit-Limit`, `application_stages.entered_at` population, `candidate_rating` population,
  the status enum on the wire.
- **Then** the outcome-anchored capability map, every verdict tagged by plane (API-can-express / tenant-populated
  / we-wired) and cause — built on this foundation, not on the inherited corpus.

Nothing downstream is ratified until Checkpoint 2's inventory is reviewed and agreed.
