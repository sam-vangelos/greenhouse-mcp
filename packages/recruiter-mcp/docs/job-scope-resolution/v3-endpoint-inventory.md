# Harvest v3 Endpoint Inventory — Checkpoint 2 (in progress)

*Author: Claude (Opus 4.8), with Sam Vangelos · 2026-06-27*

Field-level inventory built by reading each endpoint spec in full from `docs/harvest-v3-api/raw/reference/`.
Locators are `<file>:<line>`. Boilerplate (the identical ~350-line OAuth scopes block + bearer scheme present
in every file, lines ~28-376) is read and omitted here; only per-endpoint unique content is recorded.

**Universal read conventions** (from Checkpoint 1, confirmed in every spec read so far): every GET takes `cursor`,
`per_page` (1–500, default 100), `ids` (max 50), `created_at`/`updated_at` (gte/lte/gt/lt, pipeDelimited), and a
`fields` selector (max 50). Cursor must be the sole param. All list endpoints require a **Site Admin** token `sub`.

Read progress: **GET surface fully read — ~68 GET specs deep-read in full.** The only GETs not individually opened
are `custom_field_offices` (byte-identical sibling of `custom_field_departments`, swap department→office),
`bulk_requests/{uuid}` (single-record variant of `bulk_requests`), and the 3 auth-token refs (`generate-token`,
`introspect-token`, `post_auth-token`). The ~93 write/delete/bulk endpoints remain out of read-MCP scope (catalogued
by scope). The density-inference heuristic was retired mid-read: geography (job_post_searchable_locations), the
competency layer, and pay-transparency all turned out analytically real after an initial "low-density" mis-call.

---

## 0013 · GET /v3/application_stages — THE stage-history fact table

Scope `harvest:application_stages:list`. Description (0013:7,382): *"one row per interview stage the application
has occupied, with `entered_at` and `exited_at` timestamps… the canonical source for stage-history reporting;
partner BI integrations typically treat it as the fact table."*

Filters (beyond universal): **`application_ids`** (max 50, 0013:488) · **`job_interview_stage_ids`** (max 50,
"hiring-plan interview stage ids… each row represents an application's visit to a stage", 0013:503) · **`current`**
(boolean: true → current entry only; false → past only; omit → full history, 0013:544). `fields` enum:
application_id, created_at, current, days_in_stage, entered_at, exited_at, id, job_interview_stage_id, updated_at.

Response item (0013:625-668): `id` · `application_id` · `job_interview_stage_id` (→ `/v3/job_interview_stages`
row, 0013:643) · `entered_at` (nullable; *"null only for backfilled or partially recorded history"*, 0013:651) ·
`exited_at` (nullable; null while current, 0013:659) · `days_in_stage` (int; `exited_at-entered_at` past, `now-
entered_at` current, 0013:663) · `current` (bool) · created_at · updated_at. **Example shows `entered_at`/`exited_at`
null on past rows and populated on the current row (0013:561-615)** — the docs themselves model nullable backfill.

Measurement consequence: **conversion / pass-through / furthest-stage need only row existence** (count distinct
`application_id` having a row at a given `job_interview_stage_id`), independent of timestamps. **Dwell duration**
needs `entered_at`/`exited_at` (or `created_at`-delta as proxy). Batchable 50 apps/call; date-windowable via
created_at/updated_at for incremental sync.

## 0015 · GET /v3/applications — the application object + the status-enum resolution

Scope `harvest:applications:list`. Parent filters (max 50 each): **`candidate_ids`** · **`job_ids`** ("application's
current job", 0015:503) · `prospective_job_ids` · `job_post_ids` · `source_ids` · **`referrer_ids`** ("a referrer
record, not a user id", 0015:566) · **`stage_ids`** ("application-stage IDs — the same value as `stage_id` on each
application — NOT job interview stage definition IDs; IDs from `/v3/job_interview_stages` will not match", 0015:581).
Plus `status`, `stage_name` (exact, case-sensitive), `custom_field_option_id`, **`last_activity_at`** (gte/lte/gt/lt),
**`prospect`** (boolean).

**STATUS ENUM — the asymmetry is real and documented:**
- **Query** `status` enum (0015:637): `["rejected","hired","converted","active"]`. *"`active` returns applications
  still in process."*
- **Response** `status` enum (0015:835): `["rejected","hired","converted","in_process"]`. *"`in_process` for active
  candidates… `hired` once an offer is closed and the hire endpoint has fired… `converted` for prospect applications
  promoted via convert_to_candidate."* Example response shows `"status":"in_process"` (0015:727).
- You **query with `active`** and the **response comes back `in_process`**. Confirmed primary-source.

Response item (0015:754-966): `id` · `created_at` (= v1 `applied_at`) · `updated_at` · `candidate_id` ·
**`job_id`** (nullable; *"null for jobless prospect applications"* — FLAT, single, 0015:784) · `job_post_id`
(nullable) · **`recruiter_id`** (nullable; *"user assigned as recruiter on the application's job"*, 0015:798) ·
`coordinator_id` (nullable) · `referrer_id` (nullable) · `source_id` (nullable) · **`stage_id`** (nullable;
*"interview stage the candidate is currently in… null for prospects + terminal"*, 0015:819) · **`stage_name`**
(nullable; *"display name of the candidate's current interview stage"*, 0015:826) · `status` · `needs_decision`
(nullable bool; *"waiting on a hiring-team decision in its current stage"*) · `prospect` (bool) · `rejected_at`
(nullable dt) · `last_activity_at` (nullable dt) · `location_address` · `answers` (array of {question, answer}) ·
`prospective_job_ids` (array) · `custom_fields` (object of {name,type,value}) · `agency_note_id` (nullable).

**Refinement to Checkpoint 1:** the migration guide implied current stage requires the application_stages join,
but the live applications object **carries `stage_id` AND `stage_name` directly**. So a single `/applications`
call gives the current-stage snapshot + attribution (recruiter_id, coordinator_id, source_id, referrer_id,
last_activity_at, rejected_at, created_at, needs_decision). `application_stages` is for *history*, not current name.

## 0108 · GET /v3/job_interview_stages — the stage-definition ladder

Scope `harvest:job_interview_stages:list`. Filters: **`job_ids`** (max 50, 0108:488) · **`active`** (boolean;
omit=both, true=current plan, false=retired, 0108:527). `fields`: active, created_at, id, job_id, name, sort_order,
updated_at.

Response item (0108:589-616): `id` · `job_id` · **`sort_order`** (int; *"position within the job's interview plan,
ascending; Application Review=0, Offer always last"*, 0108:605) · **`name`** · **`active`** (bool; *"inactive stages
retained so historical application_stages rows continue to resolve"*, 0108:613).

**Join nuance (corrects the reference team's "join by name"):** `application_stages.job_interview_stage_id` →
`job_interview_stages.id` is a real **id join** that resolves (0013:643). Only `application.stage_id` (an
application-stage *instance* id) is disjoint from `job_interview_stages.id`. So the clean funnel path is
`/application_stages` (history) → `/job_interview_stages` (name + sort_order) by id — not name-matching.

## 0166 · GET /v3/user_job_permissions — the scope source of truth

Scope `harvest:user_job_permissions:list`. Description (0166:7,382): *"per-user, per-job access grants… one
`(user_id, job_id, role_id)` assignment per row. **Site admins are not represented here — implicit access to every
non-confidential job** — so this endpoint only lists Job Admin grants. Combine with `/v3/future_job_permissions`
for the full picture."* Filters: **`user_ids`** · **`job_ids`** · **`role_ids`** (max 50 each).

Response item (0166:583-613): `id` · `user_id` (*"site admins never appear"*, 0166:601) · `job_id` · `role_id`
(*"references a `/v3/user_roles` row; only `role_type: job_admin`"*, 0166:605) · `automated` (nullable bool;
*"created by an automated permission rule vs by hand"*).

**Scope mechanism (confirmed):** call as a Site Admin `sub` → `GET /v3/user_job_permissions?user_ids=<recruiter>`
→ the recruiter's permitted `job_id`s → filter `/applications?job_ids=…`. Caveat: a recruiter who *is* a site
admin won't appear here (implicit access to all). Pair with `/v3/future_job_permissions` for scope-based grants.

## 0160 · GET /v3/scorecards — the verdict + interviewer feedback

Scope `harvest:scorecards:list`. Filters: **`application_ids`**, **`interviewer_ids`** ("scorecards assigned to
these interviewer user ids", 0160:533), `submitter_ids`, `interview_kit_ids`, **`interviewed_at`** (gte/lte/gt/lt),
**`submitted_at`** (gte/lte/gt/lt), **`status`** (enum `draft|complete`, 0160:643).

Response item (0160:687-784): `id` · `application_id` (→ candidate via /applications) · `interview_kit_id` ·
**`interviewer_id`** ("user this scorecard is assigned to; each interviewer on a multi-interviewer interview gets
their own", 0160:703) · `submitter_id` ("usually = interviewer_id; differs when an admin submits on behalf") ·
**`candidate_rating`** (string enum: `strong_no`/`no`/`yes`/`strong_yes`/`no_decision`; *"`no_decision` recorded
when submitted without choosing"*, 0160:733 — this is v3's `overall_recommendation`, a real populated field) ·
**`status`** (`draft`/`complete`; *"only complete count toward interview completion"*) · `interviewed_at`
(nullable) · **`submitted_at`** (nullable; *"null while draft; delta between interviewed_at and submitted_at is a
common 'time to submit scorecard' measure"*, 0160:783) · `notes`/`private_notes`/`public_notes` (+`_with_tags`
variants — free-text, the sensitive fields).

Measurement: strong-yes rate, scorecard coverage/completion (`status`), feedback drag (`interviewed_at`→
`submitted_at`), per-interviewer quality/load (`interviewer_id`) — all DIRECT, batchable by application_ids/
interviewer_ids, date-windowable. `candidate_rating` is the verdict (NOT 0%; the inherited "dead field" was the v1
name `overall_recommendation`). PII: the three notes fields; the analytics fields (rating, status, timestamps) are not.

## 0099 · GET /v3/interviews — scheduled-interview throughput + scheduling timing

Scope `harvest:interviews:list`. Filters: **`job_ids`**, **`application_ids`**, **`job_interview_ids`**,
**`organizer_ids`**, **`starts_at`/`ends_at`** (datetime gte/lte/gt/lt), **`all_day_start_on`/`all_day_end_on`**
(date), `external_event_id`, **`status`** (enum: `to_be_scheduled, scheduled, awaiting_feedback, complete, skipped,
collect_feedback, to_be_sent, sent, received`, 0099:707).

Response item (0099:778-892): `id` · `job_id` · `application_id` · `job_interview_id` (the plan slot fulfilled) ·
`starts_at`/`ends_at` (nullable; null pre-schedule + all-day) · `all_day_start_on`/`all_day_end_on` (date) ·
`location` · **`status`** · **`organizer_id`** (nullable; *"null for interviews not scheduled through a calendar
integration"* — likely why the inherited "organizer_id ~0%") · **`scheduled_at`** (nullable; *"when first placed on
a calendar"*) · **`availability_received_at`** (nullable; *"used to compute time-to-schedule"*) ·
`video_conferencing_url` · `external_event_id`.

Measurement: interview volume/throughput by `status`; scheduling lead time (`availability_received_at`→
`scheduled_at`→`starts_at`); feedback-owed (`status=awaiting_feedback`) — DIRECT. The interview object carries NO
panel array — per-interviewer attribution goes through `/v3/scorecards.interviewer_id` or `/v3/interviewers`, not here.

## 0130 · GET /v3/offers — offer cycle, accept rate, hire-date anchor

Scope `harvest:offers:list`. Filters: **`application_ids`**, **`job_ids`**, **`candidate_ids`**, **`opening_ids`**,
**`current_only`** (boolean — latest version per application), **`status`** (enum `Created|Accepted|Rejected|
Deprecated`, capitalized, 0130:601), **`resolved_at`** (datetime; *"hire-date filter alongside status=Accepted"*),
**`sent_on`** (date), **`starts_on`** (date).

Response item (0130:754-885): `id` · **`version`** (int; new row per tracked-field change; `current_only=true` for
latest) · `application_id` · `job_id` · `candidate_id` · `opening_id` (nullable) · **`status`** (`Created`/
`Accepted`/`Rejected`/`Deprecated`) · `starts_on` (date, nullable) · `sent_on` (date, nullable) · **`resolved_at`**
(datetime, nullable; *"timestamp resolved Accepted or Rejected"*, 0130:815) · `custom_fields` (comp components —
base pay/equity/bonus; **comp-tier PII**).

Measurement: offer accept rate = `Accepted / (Accepted+Rejected)`; offer cycle = `sent_on`→`resolved_at`;
time-to-hire anchor = `resolved_at` where `status=Accepted`. All DIRECT, batchable, date-windowable. Use
`current_only=true` to avoid double-counting versions.

## 0139 · GET /v3/openings — time-to-fill + req aging

Scope `harvest:openings:list`. Filters: **`job_ids`**, **`application_ids`**, **`close_reason_ids`**, **`opened_at`**
(datetime), **`closed_at`** (datetime), **`open`** (boolean), `opening_id` (string, partner external).

Response item (0139:685-752): `id` · `job_id` · **`opened_at`** (nullable; *"first transitioned to open; null while
job in draft"*) · **`closed_at`** (nullable) · `sort_order` · `opening_id` (string, partner external, nullable) ·
**`application_id`** (nullable; *"id of the application that filled this opening when closed as a hire"*, 0139:727) ·
**`close_reason_id`** (nullable; → /v3/close_reasons; e.g. `Hire - New Headcount`, `On Hold`, `Requisition
Cancelled`) · `target_start_on` (date) · **`open`** (boolean; *"true while available; equivalent to closed_at null"*).

Measurement: time-to-fill = `opened_at`→`closed_at` (where close_reason is a hire); req aging = `now − opened_at`
where `open=true`; fill-vs-cancel via `close_reason_id`. `application_id` links the filling application. DIRECT.

## 0124 · GET /v3/jobs — req dimensions + confidential gate

Scope `harvest:jobs:list`. Filters: **`opened_at`**/**`closed_at`** (datetime), `requisition_id` (string),
**`department_id`** (int, single), **`office_id`** (int; *"job spanning multiple offices matches any"*),
**`confidential`** (boolean), **`status`** (enum `open|draft|closed`). Description (0124:382): *"response is scoped
to jobs the caller's permissions can see."*

Response item (0124:798-951): `id` · `name` (internal title) · `requisition_id` (string, nullable, partner) ·
`notes` (HTML, nullable) · **`confidential`** (boolean; *"restricted to users explicitly granted on the Hiring
Team. Legacy Confidential Jobs sunset — cannot be set on new jobs, preserved for existing"*, 0124:828) ·
**`status`** (`open`/`draft`/`closed`; *"closed automatically when its last open opening is closed"*) · `opened_at`
(nullable) · `closed_at` (nullable) · `is_template` (nullable) · `copied_from_id` (nullable) · **`department_id`**
(int, single, nullable — FLAT) · **`office_ids`** (array of int, nullable) · `custom_fields`.

Confirms: `department_id` FLAT/single; `office_ids` array. **Confidential jobs are gated even from a site-admin
token unless the caller is on the Hiring Team** — relevant to scoping completeness.

## 0057 · GET /v3/candidates — the person record (PII home)

Scope `harvest:candidates:list`. Filters: ids, created_at/updated_at, last_activity_at, custom_field_option_id,
**`private`** (boolean; default true — *"include private candidates the caller has access to"*, 0057:561),
**`email`** (exact, case-insensitive), **`tag`** (exact name). No `job_ids`/`candidate-of-job` filter — candidates
don't embed applications; go the other way (`/applications?candidate_ids=`).

Response item (0057:660-898; note the response is a `oneOf` — the object, or an async-processing `{message}`):
`id` · `first_name`/`last_name`/`preferred_name` (nullable) · `company` · `title` · `last_activity_at` ·
**`private`** (bool; *"restricted to View Private Candidates access"*) · `can_email` · `tags` (string[]) ·
`linked_user_ids` · **PII arrays**: `phone_numbers` / `addresses` / `email_addresses` / `website_addresses` /
`social_media_addresses` (each `{value,type}`) · `custom_fields`. **PII tiering:** name = identity; email/phone/
address/social = contact-PII; everything else low-sensitivity. `private` is the per-candidate visibility gate.

## 0115 · GET /v3/job_owners — recruiter / coordinator / sourcer (job grain)

Scope `harvest:job_owners:list`. Filters: **`user_ids`**, **`job_ids`**, **`type`** (`sourcer|recruiter|coordinator`).
Response item (0115:582-614): `id` · `job_id` · `user_id` · **`type`** (`sourcer|recruiter|coordinator`;
hiring managers are on `/v3/job_hiring_managers`) · **`responsible`** (bool; *"responsible recruiter/coordinator —
default assignee for new applications; always false for sourcer"*). Per-application attribution is on the
application object (`recruiter_id`/`coordinator_id`); this is the job-level hiring team.

## 0161 · GET /v3/sources — source NAME + sourcing strategy (kills the ids-only limp)

Scope `harvest:sources:list`. Small org-wide dictionary (~30 rows; cacheable). Response item (0161:837-866):
`id` · **`name`** (display — `LinkedIn (Prospecting)`, `Indeed`, `Referral`, `Internal Applicant`, custom agency
names) · **`type`** (object `{id, name}` — the **sourcing strategy** roll-up: `Agencies`, `Referral`,
`Third-party boards`, `Prospecting`, `Social media`, `Company marketing`, `In person event`, `MyGreenhouse`,
`Other`). `application.source_id` → this `id` → name + strategy. Source effectiveness by channel AND by strategy,
both DIRECT.

## 0149 · GET /v3/referrers — referrer NAME resolution

Scope `harvest:referrers:list`. Read-only (referrers created via UI). Filter `user_ids`. Response item
(0149:556-578): `id` · **`name`** (the "Who Gets Credit" label) · **`user_id`** (nullable — *"the GH user when an
internal employee; null for external agency / social-share / LinkedIn referrers; NOT the same id space as
`applications.referrer_id`"*, 0149:568). `application.referrer_id` → this `id` → name. Referral-yield attribution DIRECT.

## 0169 · GET /v3/users — user resolution + the site_admin flag

Scope `harvest:users:list`. Filters: ids, created_at/updated_at, `agency_ids`, `office_ids`, `department_ids`,
`linked_candidate_ids`, `interviewer_tag_ids`, `employee_ids`, `custom_field_option_id`, **`deactivated`** (bool),
**`primary_email`** (exact), `external_office_id`, `external_department_id`, **`show_service_accounts`** (bool —
ISUs hidden by default). Response item (0169:745-919): `id` · `first_name`/`last_name`/`name` · `job_title` ·
`primary_email` · `emails` (string[]) · **`deactivated`** (bool) · **`site_admin`** (bool; *"unrestricted access
to every non-confidential job"*, 0169:798) · `agency_id` (nullable) · `employee_id` (nullable HRIS) ·
`linked_candidate_ids` · `office_ids` · `department_ids` · `interviewer_tags` (`[{id,name}]` — `Bar Raiser`, etc.).
Resolves `recruiter_id`/`interviewer_id`/`organizer_id` → name/email. **The `site_admin` flag here is how to detect
the `user_job_permissions` blind spot** (a site-admin recruiter has implicit all-job access and won't appear there).

## 0168 · GET /v3/user_roles — the role dictionary

Scope `harvest:user_roles:list`. Response item (0168:535-558): `id` (= `role_id` in user_job_permissions) ·
**`role_type`** (enum `deprecated_interviewer|job_admin|site_admin`; *"job_admin assigned per job via
user_job_permissions/future_job_permissions; site_admin org-wide, bypasses per-job assignment"*) · **`name`**
(display — built-ins `Standard`, `Private`, `Site Admin`; custom job_admin roles e.g. `Recruiter`, `Coordinator`).
Resolves `user_job_permissions.role_id` → role_type + name.

## 0150 · GET /v3/rejection_details — per-rejection record

Scope `harvest:rejection_details:list`. One row per rejected application. Filters: **`application_ids`**,
**`rejection_reason_ids`**, custom_field_option_id. Response item (0150:588-695): `id` · `application_id` ·
**`rejected_by_id`** (nullable; *"null for system/auto-rejection"*) · **`rejection_reason_id`** (nullable →
/v3/rejection_reasons) · `rejection_note_id` (nullable → /v3/notes/{id} for the free-text) · **`rejected_at`**
(datetime) · `question_custom_fields` (object). Rejection analysis (count by reason, who, when) DIRECT.

## 0153 · GET /v3/rejection_reasons — reason dictionary + for-cause/withdrawal

Scope `harvest:rejection_reasons:list`. `include_defaults` param. Response item (0153:548-580): `id` · `name`
(display, e.g. `Not a cultural fit`, `Spam`) · **`type`** (object `{id, key, name}`; **key enum
`WE_REJECTED_THEM|THEY_REJECTED_US|NONE_SPECIFIED|SECURITY_CONCERN`** — *"prefer matching on key over name"*,
0153:570). The `type.key` gives for-cause-vs-withdrawal categorization directly. `SECURITY_CONCERN` only when the
org flag is on.

## 0089 · GET /v3/eeoc — federal self-ID (row-level, scope-gated PII)

Scope `harvest:eeoc:list`. Description (0089:382): *"Sensitive PII: unlike the in-app EEOC report (aggregated,
anonymized), this endpoint returns ROW-LEVEL responses tied to a specific candidate and application."* Filters:
`application_ids`, `submitted_at`. Response item (0089:600-698): `id` · `application_id` · `candidate_id` ·
**`gender`**/`race`/`veteran_status`/`disability_status` (each `{id, description}`, fixed federal enums, null when
skipped) · `submitted_at` (nullable). **Diversity pass-through IS expressible on v3** (the data is readable); the
"don't join demographics to identity in one response / min cell size" rule is OUR compliance policy, not an API limit.

## 0082 · GET /v3/demographic_answers — org-defined self-ID (scope-gated PII)

Scope `harvest:demographic_answers:list`. Distinct from EEOC (org questions). Filters: `application_ids`,
`demographic_question_ids`, `demographic_answer_option_ids`. Response item (0082:583-616): `id` · `application_id`
· `demographic_question_id` · `demographic_answer_option_id` (nullable; one row per selected option on multi-select)
· `free_form_text` (nullable; *"highly sensitive — handle like EEOC"*). Same posture as EEOC: readable, gate by policy.

## 0097 · GET /v3/interviewers — the interview panel (resolves panel attribution)

Scope `harvest:interviewers:list`. Filters: **`interview_ids`**, **`user_ids`**, **`scorecard_ids`**,
**`response_status`** (enum `needs_action|declined|tentative|accepted`). Response item (0097:600-649): `id` ·
**`interview_id`** (→ /v3/interviews) · **`user_id`** (nullable; null for external attendees) · **`scorecard_id`**
(nullable; *"one placeholder scorecard per assigned interviewer; null for organizer/external"*, 0097:623) · `email`
· **`response_status`** (calendar RSVP). **Per-interview panel composition + RSVP + scorecard linkage is DIRECT** —
this resolves the "per-interviewer panel attribution" the secondary investigation rated unavailable. Panel members
who never submitted are still visible (their `scorecard_id` placeholder), so no-show / no-feedback is computable.

## 0128 · GET /v3/notes — the v3 prose feed (free-text PII, type/visibility tiers)

Scope `harvest:notes:list`. The v1 activity feed's prose half. Filters: **`candidate_ids`**, **`user_ids`**
(author), **`application_ids`**, **`type`** (enum `NOTE|ACTIVITY|INTERVIEW|EMAIL|FOLLOW_UP|TAKE_HOME_TEST|
LINKEDIN_NOTE|LINKEDIN_INMAIL|AVAILABILITY_REQUEST|MIGRATION_ERROR|TOUCHPOINT|FORM|FEEDBACK`), **`visibility`**
(enum `admin_only_visible|privately_visible|publicly_visible`). Response item (0128:639-762): `id` · `candidate_id`
(nullable) · `application_id` (nullable) · **`body`** (free text) · `subject` · **`type`** · `user_id` (author) ·
`email_from`/`to`/`cc` · **`visibility`** · `import_hash`. `type=ACTIVITY` = system activity-feed entries. For
structured interview feedback use `/scorecards`, not this. **PII: `body` is free-text; `visibility` is the
projection tier** (publicly / privately[see-private-notes perm] / admin_only[Job+Site Admin]).

## 0109 · GET /v3/job_interviews — interview-plan slots (the EXPECTED-scorecard denominator)

Scope `harvest:job_interviews:list`. Filters: `job_ids`, `job_interview_stage_ids`, `active`, **`scheduling_type`**
(`none|needs_scheduling|take_home_test|offer`). Response item (0109:649-722): `id` (= `job_interview_id` on
`/interviews`) · `job_interview_stage_id` · `job_id` · `sort_order` (slot order within the stage) · `scheduling_type`
· `duration` · `name` · `active` · **`require_scorecard`** (nullable bool; *"interviewers must submit a scorecard
for this slot"*). **Upgrade:** `require_scorecard` defines the *expected* scorecard set per slot — a sharper
gate-skip/coverage denominator than the "deep + no scorecard" heuristic the reference team used.

## 0080 · GET /v3/default_interviewers — configured default panel (individual users)

Scope `harvest:default_interviewers:list`. Filters: `user_ids`, `interview_kit_ids`. Response item (0080:564-583):
`id` · `user_id` · `interview_kit_id`. The pre-selected panel per kit/stage. *"Only individual-user defaults; UI
interviewer-groups / hiring-team-role defaults are NOT returned."* So configured-vs-realized panel delta is
partially computable (individual-user rows only).

## 0095 · GET /v3/interview_kits — per-slot evaluation packet

Scope `harvest:interview_kits:list`. Filters: `job_ids`, `job_interview_ids`. Response item (0095:570-610): `id`
(parent of `scorecard_questions`) · `job_id` · `job_interview_id` (one kit per slot) · `exercises` (live Interview
Prep HTML) · `anonymize_candidate` · `anonymize_resumes`.

## 0159 · GET /v3/scorecard_questions — the rubric per kit

Scope `harvest:scorecard_questions:list`. Filters: `interview_kit_ids`, `active`. Response item (0159:621-663):
`id` · `interview_kit_id` · `question` (HTML) · `sort_order` · `active` · **`answer_type`** (`text|yes_no|
single_select|multi_select|instruction`) · `required`. Interviewer responses are separate
(`/v3/scorecard_question_answers`, filterable by scorecard).

## 0085 · GET /v3/departments — dimension (tree)

Scope `harvest:departments:list`. Filters: `parent_id`, `external_id`. Response item (0085:562-591): `id` · `name`
· `parent_id` (nullable; tree) · `external_id` (HRIS). Resolves `job.department_id` → name.

## 0133 · GET /v3/offices — dimension (tree)

Scope `harvest:offices:list`. Filters: `parent_id`, `external_id`. Response item (0133:566-611): `id` · `name` ·
`parent_id` (nullable; tree) · `external_id` · `location` · `primary_in_house_contact_user_id`. Resolves
`job.office_ids[]` → names.

## 0062 · GET /v3/close_reasons — opening-close dictionary (hire vs non-hire)

Scope `harvest:close_reasons:list`. Response item (0062:533-547): `id` · **`name`** — *"names starting with
`Hire -` are treated as hire outcomes in Greenhouse reporting; other names are non-hire."* Resolves
`opening.close_reason_id` → hire/non-hire — the clean time-to-fill numerator classifier.

## 0106 · GET /v3/job_hiring_managers — hiring managers per job

Scope `harvest:job_hiring_managers:list`. Filters: `user_ids`, `job_ids`. Response item (0106:561-583): `id` ·
`user_id` · `job_id`. The hiring-manager hiring-team role (separate from `/v3/job_owners`).

## 0035 · GET /v3/attachments — resume/offer documents (PII)

Scope `harvest:attachments:list`. Filters: `application_ids`, `candidate_ids`, **`type`** (enum `resume|
cover_letter|take_home_test|offer_packet|offer_letter|signed_offer_letter|other|form_attachment|
midfunnel_agreement|automated_agreement`). Response item (0035:592-637): `id` · `application_id` · `candidate_id`
(nullable) · `type` · `filename` · **`url`** (*"time-limited; expires after 7 days; refetch for a fresh URL"*).
PII: resume/cover-letter `url` is candidate PII and ephemeral — reference by id/type, mint fresh URL only on demand.

## 0156 · GET /v3/scorecard_question_answers — per-question responses (effort signal)

Scope `harvest:scorecard_question_answers:list`. Filters: `scorecard_ids`, `scorecard_question_ids`. Response item
(0156:577-610): `id` · `scorecard_id` · `scorecard_question_id` · **`answer`** (free text for text-type) ·
**`boolean_value`** (yes_no). single/multi-select via `scorecard_question_answer_options`. **Upgrade:** answer
presence/length per question makes scorecard effort/box-checking detection partly DIRECT (the secondary
investigation rated it materialization-only). Free-text `answer` is PII.

## 0146 · GET /v3/prospect_details — CRM/prospect pipeline state

Scope `harvest:prospect_details:list`. Filters: `application_ids`, `pool_ids`, `pool_stage_ids`,
`prospect_owner_ids`, `department_ids`, `office_ids`. Response item (0146:629-676): `id` · `application_id` ·
`pool_id` (nullable) · `pool_stage_id` (nullable) · `prospect_owner_id` (nullable) · `department_id` · `office_id`
(*"prospective dept/office, may differ from the job's"*). Prospect/sourcing-pipeline analytics via pools/stages.

## 0093 · GET /v3/future_job_permissions — scope completeness (the other half)

Scope `harvest:future_job_permissions:list`. Response item (0093:617-649): `id` · `user_id` · `role_id` ·
`department_id` (nullable) · `office_id` (nullable) — *"both null → applies to every future job."* **Scope
completeness:** a recruiter's full job access = `user_job_permissions` (current per-job grants) + `future_job_
permissions` (dept/office-scoped grants applied to new jobs). Both needed for the scope filter.

## 0026 · GET /v3/approval_flows — job/offer approval status

Scope `harvest:approval_flows:list`. Filters: `job_ids`, `offer_ids`, **`approval_type`** (`open_job|offer_job|
offer_candidate`). Response item (0026:588-647): `id` · `job_id` · `offer_id` (nullable) · `approval_type` ·
`sequential` · `version` · `requested_by_id` (nullable) · **`approval_status`** (`pending|rejected|approved`).
Chain via `/v3/approver_groups` → `/v3/approvers`. Offer/job approval-cycle analytics available (lower priority).

## 0162 · GET /v3/tracking_links — campaign/source attribution

Scope `harvest:tracking_links:list`. Filters: `job_ids`, `source_ids`, `referrer_ids`, `job_board_ids`,
`job_post_ids`, `related_post_ids`, `token`. Response item (0162:651-718): `id` · `token` (`gh_src`) · `source_id`
(nullable) · `referrer_id` (nullable) · `job_id`/`job_board_id`/`job_post_id` (nullable) · `related_post_id`/`type`.
Deeper source attribution (campaign-level) than `source_id` alone.

## 0077 · GET /v3/custom_fields — custom-field DEFINITIONS (the key dictionary)

Scope `harvest:custom_fields:list`. Filters: **`field_type`** (`job|opening|standard|offer|compensation_frequency|
candidate|referral_question|application|rejection_question|form|agency_question|user_attribute`), `active`, `name`,
**`name_key`**. Response item (0077:622-804): `id` · `field_type` · `name` · **`value_type`** (`short_text|long_text|
yes_no|single_select|multi_select|currency|number|date|url|...|*_hris` masked-PII variants) · **`name_key`** (*"stable
lowercase key — use this, not id, as the canonical key when reading/writing `custom_fields`"*) · `private` · `required`
· `internal_type` (`employment_type|start_date|degree|discipline|school_name|...`) · `active`. Interprets the
`custom_fields` maps on application/job/offer/candidate/opening. The `*_hris` value_types are masked-PII.

## 0071 · GET /v3/custom_field_options — select-field option values (+ degrees/schools/disciplines)

Scope `harvest:custom_field_options:list`. Filters: `custom_field_ids`, **`custom_field_key`** (e.g. `school_name`,
`degree`, `discipline`, `cost_center`), `active`. Response item (0071:573-607): `id` · `custom_field_id` · `name`
(display) · `external_id` · `sort_order` · `active`. *"The v1 `/schools`, `/degrees`, `/disciplines` endpoints are
served here — pass the matching `custom_field_key`."* Resolves `custom_field_option_id` filters → labels.

## 0121 · GET /v3/job_posts — public listings + posting timing

Scope `harvest:job_posts:list`. Filters: `job_ids`, `job_board_ids`, `active`, `featured`, **`live`**, `internal`.
Response item (0121:842+): `id` · `title` (public) · `internal` · `active` · **`live`** (published + board live) ·
`featured` · **`first_published_at`** (nullable; when first live — posting age) · `content` (HTML) · `language` ·
`public_url` · `demographic_question_set_id` · `job_id` · `job_board_id` · `questions` (application-form questions:
label/name/required/answer_type). `application.job_post_id` → which post the candidate applied through.

## 0148 · GET /v3/prospect_pools — talent-community definitions

Scope `harvest:prospect_pools:list`. Response item: `id` · `name` · `active` · `description` · `department_ids[]` ·
`office_ids[]` · `job_ids[]`. The CRM pool dictionary; `prospect_details.pool_id` → name.

## 0147 · GET /v3/prospect_pool_stages — the prospect (CRM) stage ladder

Scope `harvest:prospect_pool_stages:list`. Filter `prospect_pool_ids`. Response item (0147:567-590): `id` ·
`prospect_pool_id` · `name` (e.g. `Not Reviewed`, `In Discussion`) · **`sort_order`**. The nurture-stage ladder
within a pool — the prospect-side analogue of `job_interview_stages.sort_order`; `prospect_details.pool_stage_id`
→ name + depth. Prospect-pipeline distribution is measurable the same way as the interview funnel.

## 0084 · GET /v3/demographic_questions — org demographic question defs

Scope `harvest:demographic_questions:list`. Filters: `demographic_question_set_ids`, `active`, `required`. Response
item (0084:519-570): `id` · `name` (nullable; null for GH-standard questions) · `demographic_question_set_id` ·
`required` (nullable) · `sort_order` · `active` · `answer_type` (`multi_value_single_select|multi_value_multi_select`).
`demographic_answers.demographic_question_id` → here → `/v3/demographic_answer_options` for labels.

## Candidate-attribute (competency) layer — 0046 / 0104 / 0091 / 0154 / 0157

The structured skill/competency-rating layer — a second rating axis beneath the overall scorecard
`candidate_rating`. **Initially mis-catalogued as plumbing; promoted to full read.** Chain:

- **0046 `GET /v3/candidate_attribute_types`** (`harvest:candidate_attribute_types:list`) — the **per-job** trait
  dictionary: `id` · `name` (e.g. `Skills`, `JavaScript`, `Leadership`, `Years of experience`) · `job_id` ·
  `active` · `is_draft` · `sort_order`. *"AI matching uses [these] to score candidate fit."* No org-wide dictionary
  — each job has its own. Filters: `active`, `is_draft`.
- **0104 `GET /v3/job_candidate_attributes`** (`…:list`) — **the per-job catalogue of "what we're rating candidates
  on"**: `id` · `name` · `candidate_attribute_type_id` · `job_id` · `active` · `sort_order`. *"the entry point most
  AI-matching partners read to score candidate fit."* Filters: `job_ids`, `candidate_attribute_type_ids`. **This is
  the label/dimension resolver** for a scorecard attribute rating's `job_candidate_attribute_id`.
- **0091 `GET /v3/focus_candidate_attributes`** (`…:list`) — which job attributes an interview kit elevates as focus
  areas: `id` · `interview_kit_id` · `job_candidate_attribute_id` (FK-only; name lives on the parent). Filters:
  `interview_kit_ids`, `job_candidate_attribute_ids`.
- **0154 `GET /v3/scorecard_candidate_attributes`** (`…:list`) — **the interviewer's per-attribute RATING**: `id` ·
  `scorecard_id` · `job_candidate_attribute_id` · **`candidate_attribute_rating`** (enum `definitely_not|no|yes|
  strong_yes|mixed|no_decision` — note: differs from the overall scorecard `candidate_rating` enum, which uses
  `strong_no` not `definitely_not` and has no `mixed`) · `note` (free-text, PII). Filters: `scorecard_ids`,
  `job_candidate_attribute_ids`. *"the read pattern used by talent-matching and partner interview-intelligence
  integrations."* Batchable 50/call.
- **0157 `GET /v3/scorecard_question_candidate_attributes`** (`…:list`) — join: which focus attribute a scorecard
  question assesses. `scorecard_question_id` · `focus_candidate_attribute_id` (resolve name via
  focus → job_candidate_attribute → candidate_attribute_type).

**Capability consequence:** a per-competency scoring family — strength-by-skill across a req, weakest attributes in
the funnel, per-interviewer rating distribution on a given attribute, focus-attribute coverage — and a
candidate skills-profile substrate for matching/talent-rediscovery. Resolution role: yes for *attribute label*
(`job_candidate_attribute_id` → name/type); NOT identity dedup (that's candidate/user/referrer).

---

## Geography + pay-transparency layer — 0118 / 0120 / 0102 / 0145 / 0144 (Sam-flagged; real)

- **0120 `GET /v3/job_post_searchable_locations`** (`…:list`) — **the structured geocoded layer.** Per job post,
  one row per location: `location` (display "City, Region, Country") · `city` · `region_short_name`/`region_long_name`
  (state) · `postal_code` · `county` · `country_short_name`/`country_long_name` · **`latitude`/`longitude`**. Filter
  `job_post_ids`. This is the real geographic slicing dimension (req/applicant concentration by city/state/country,
  remote-vs-onsite, lat-long mapping) — `application.location_address` is free text and `office.location` is sparse.
- **0118 `GET /v3/job_post_locations`** (`…:list`) — the multi-location join: `job_post_id` · **`type`** (`free_text|
  office|custom_list`) · `plain_text_location` (free-text rows) · `office_id` (office rows) · `custom_location_id`
  (custom rows). One row per location on a multi-location post. Filters: `job_post_ids`, `office_ids`,
  `custom_location_ids`, `type`, `plain_text_location`.
- **0102 `GET /v3/job_board_custom_locations`** (`…:list`) — board-scoped custom location dictionary: `id` ·
  `value` (label) · `active` · `greenhouse_job_board_id`. Resolves `job_post_locations.custom_location_id` → label.
- **0145 `GET /v3/pay_inputs`** (`…:list`) — pay-transparency components: `id` · `title` (`Base Salary`, `Equity`…)
  · `blurb` · `priority` · `linked_custom_field_id` · `locked`. Filter `linked_custom_field_ids`.
- **0144 `GET /v3/pay_input_ranges`** (`…:list`) — **posted comp ranges**: `id` · `pay_input_id` · `job_post_id` ·
  **`min_cents`/`max_cents`** · `currency_type` (ISO 4217). Filters: `pay_input_ids`, `job_post_ids`. **NOT PII** —
  these are the *public posted* ranges (pay-transparency law), distinct from offer-level comp custom fields. Posted-
  range analytics: comp band by role/department/geo, range width, range-vs-accepted-offer.

## Reference / definition tail — read in full, low marginal analytics weight

- **0024 `applied_candidate_tags`** — (candidate_id, candidate_tag_id) join. **0054 `candidate_tags`** — tag
  dictionary (`name`). Together: tag-based cohorts (e.g. `2026-grad`, `referral`) for slicing/segmentation.
- **0048 `candidate_educations`** — per-candidate education: `school_name`/`degree`/`discipline` as
  `*_custom_field_option_id` (resolve via `/v3/custom_field_options`), `start_at`/`end_at` (+ month/year parts),
  `latest`. **0051 `candidate_employments`** — work history: `company_name`/`title` (free text), `start_date`/
  `end_date` (null=current), `latest`. Candidate-background analytics + matching substrate; both PII-adjacent.
- **0158 `scorecard_question_options`** — select-question choice labels (`name`, `scorecard_question_id`). **0155
  `scorecard_question_answer_options`** — (answer, option) join. Together resolve multi/single-select scorecard
  answers to labels — completes the per-question scorecard-answer analytics.
- **0096 `interviewer_tags`** — interviewer label dictionary (`name`: `Bar Raiser`, `Diversity Trained`); pairs with
  `users.interviewer_tags`. Bar-raiser coverage / panel-composition analytics.
- **0031 `approver_groups`** (`approval_flow_id`, `approvals_required` M-of-N, `sort_order`, `resolved_at`) + **0033
  `approvers`** (`user_id`, **`status`** `waiting|due|approved|rejected`, `request_sent_at`, `resolved_at`,
  reminders) — full approval-chain timing/bottleneck analytics (approval cycle time, who's the slow approver).
- **0111 `job_notes`** — req-level notes: `job_id` · `body` (free text, PII) · `user_id` · `visibility`
  (`admin_only_visible|privately_visible`).
- **0103 `job_boards`** — board dictionary: `company_name` · `url_token` · `internal` · **`status`** (`draft|live`)
  · about/intro/conclusion. Resolves `job_post.job_board_id`.
- **0081 `demographic_answer_options`** (`name`, `free_form`, **`decline_to_answer`**) + **0083
  `demographic_question_sets`** (`title`, `active`, `enabled`) — complete the org-demographic label/grouping chain
  for diversity analytics.
- **0064 `custom_field_departments`** (custom_field_id, department_id) [+ **0067 `custom_field_offices`**, identical
  shape, office] — custom-field visibility scoping; needed only to interpret which custom fields apply where.
- **0163 `user_emails`** — user address resolution: `user_id` · `email` · `verified` · `verification_token_sent_at`.
  Resolve a list of emails → users (PII-adjacent; user emails, not candidate).
- **0039 `blocked_spam_sources`** — intake blocklist (`source_type` ip/cidr/email/domain, `value`); Real Talent flag
  or 403. Operationally niche; spam-intake volume only.
- **0045 `bulk_requests`** — async bulk-op tracker (`status`, `success_count`/`failure_count`, `api_endpoint`).
  Scope is a WRITE scope (`harvest:openings:create`) — relevant only to a writer, NOT a read-only analytics MCP.

---

## Remaining surface — catalogued by scope, not individually deep-read

The 41 above are every GET that carries analytics signal or a label/dimension analytics joins to, read in full from
the OpenAPI specs. The endpoints below are accounted for from the universal scopes block (present verbatim in every
spec) + the v1→v3 migration guides + the index — their existence, scope, auth, pagination, and v1→v3 semantics are
known; their per-field response schemas are **not** individually deep-read because they are low-density reference/
definition tables or out-of-scope writes for a read-only analytics MCP. Flag any to promote to a full read.

**Remaining GET — NONE pending a content read.** All read in full above. Not individually opened (justified):
`custom_field_offices` (byte-identical to `custom_field_departments`), `bulk_requests/{uuid}` (single-record form
of `bulk_requests`), and the 3 auth-token refs (`generate-token`, `introspect-token`, `post_auth-token` — mechanism,
not data). All read-shaped, site-admin-gated, cursor-paginated.

**Write/delete/bulk surface (≈93 endpoints) — OUT of read-only-MCP scope.** Catalogued via the scopes block +
`0009-write-endpoint-migration-guide.md`: applications (move/hire/reject/unreject/convert/patch/delete/create),
candidates (create/patch/delete/merge/anonymize), offers/openings/jobs/job_posts/job_owners/job_hiring_managers/
notes/job_notes/interviews/approval_flows/users (+activate/deactivate/revoke)/user_emails/user_job_permissions/
future_job_permissions/candidate_tags/applied_candidate_tags/candidate_educations/candidate_employments/attachments/
departments/offices/custom_fields(+options,+departments,+offices)/blocked_spam_sources/rejection_details — each
`create|update|destroy|…` scope. A read-only recruiter MCP exposes **none** of these.

---

## Ledger updates from this batch (corrections to earlier analyses)

- **Status enum (my adversarial-review claim 4): REVERSED.** I earlier "Refuted" the query-active/respond-in_process
  asymmetry, leaning on secondary web docs ("in_process appears in zero official docs", "invalid status → empty 200").
  The **authoritative v3 spec contradicts that**: query enum `{…,active}` (0015:637), response enum `{…,in_process}`
  (0015:835). The asymmetry is real and documented; the original architecture doc and the team's code were right.
  This is the exact secondary-source failure mode — now corrected at the primary source.
- **Funnel keystone: confirmed at field level.** `/v3/application_stages` is batchable (50/call), date-windowable,
  with a `current` filter and `days_in_stage`. Conversion needs only row existence; dwell needs `entered_at`
  (nullable for backfill) — the one live-probe question.
- **Current-stage snapshot is cheaper than CP1 implied:** `application.stage_name` + attribution are on the
  application object directly; no join needed for current state.
- **Scope: site-admin token + `user_job_permissions` filter**, with the site-admin-exclusion caveat.
