// Production-shape Greenhouse Harvest rows.
//
// These are the NESTED forms the live Harvest v3 API actually returns —
// `jobs: [{ id }]`, `current_stage: { id, name, entered_at }`,
// `interviewer: { id }`, `submitted_by: { id }` — as opposed to the flat
// `{ job_id, stage_id, interviewer_id, ... }` shapes that earlier fixtures
// used and that production never returns.
//
// They are the single source of truth for the "production-shape" regression
// locks. Any analysis/projection test that needs to prove it reads the real
// Harvest shape (rather than a flattened convenience shape) builds its rows
// from these helpers, so a reader that only understands the flat shape fails.

export function nestedJobApplication(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 101,
    candidate_id: 55,
    jobs: [{ id: 100, name: "Job A" }],
    current_stage: { id: 7, name: "Phone Screen", entered_at: "2026-06-13T12:00:00.000Z" },
    status: "active",
    last_activity_at: "2026-06-20T12:00:00.000Z",
    ...overrides,
  };
}

// A scorecard with NO flat interviewer_id/submitter_id. The caller supplies the
// person via the nested `interviewer: { id }` and/or `submitted_by: { id }`
// overrides, mirroring the live shape that scorecard person-attribution must read.
export function nestedScorecard(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 501,
    application_id: 10,
    status: "pending",
    submitted_at: null,
    interviewed_at: "2026-06-10T00:00:00.000Z",
    ...overrides,
  };
}

// An application carrying a current stage object but NO stage-entry timestamp in
// any form (no flat current_stage_at, no nested current_stage.entered_at). This
// is the realistic v3 shape for the dwell-clock fields that are ~0% populated;
// it must be reported as freshness-degraded rather than silently dropped while
// the result still certifies completeness.status === "complete".
export function stageRowWithoutEntryTimestamp(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 101,
    candidate_id: 55,
    jobs: [{ id: 100 }],
    current_stage: { id: 7, name: "Phone Screen" },
    status: "active",
    last_activity_at: "2026-06-20T12:00:00.000Z",
    ...overrides,
  };
}

// A v3 /v3/application_stages row — THE funnel keystone. The endpoint returns
// `id`, `application_id`, `job_interview_stage_id` (→ job_interview_stages.id,
// the real id-join), `entered_at`/`exited_at` (both nullable), `days_in_stage`
// (int), and `current` (bool). It carries NO `job_id`: scope rides the
// application-backed join (application_id → application.job_id ∈ permitted).
// `stage_name`/`stage_rank` are NOT in the v3 response and must never be
// projected onto the recruiter surface.
export function v3ApplicationStage(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 4001,
    application_id: 100,
    job_interview_stage_id: 7,
    entered_at: "2026-06-10T00:00:00.000Z",
    exited_at: "2026-06-14T00:00:00.000Z",
    days_in_stage: 4,
    current: false,
    created_at: "2026-06-10T00:00:00.000Z",
    updated_at: "2026-06-14T00:00:00.000Z",
    ...overrides,
  };
}

// A v3 /v3/offers row. On v3 `job_id` is FLAT (job-scoped bound), the date fields
// are `starts_on`/`sent_on` (NOT v1 `starts_at`/`start_date`), status is
// Created|Accepted|Rejected|Deprecated, and compensation lives inside custom_fields
// — it must NOT surface on the recruiter default projection profile.
export function v3Offer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 9001,
    application_id: 100,
    candidate_id: 501,
    job_id: 1,
    opening_id: 7,
    status: "Accepted",
    starts_on: "2026-07-01",
    sent_on: "2026-06-01T00:00:00.000Z",
    resolved_at: "2026-06-05T00:00:00.000Z",
    version: 2,
    custom_fields: { base_salary: { value: 200000 } },
    created_at: "2026-05-20T00:00:00.000Z",
    updated_at: "2026-06-05T00:00:00.000Z",
    ...overrides,
  };
}
