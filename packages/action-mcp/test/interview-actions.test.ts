import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { actionDefinition } from "../src/actions/index.js";
import { parseActionBinding } from "../src/crypto.js";
import { readActionRuntimeFlags } from "../src/env.js";
import { ActionDeniedError } from "../src/errors.js";
import { GreenhouseError, createGreenhouseGateway } from "../src/greenhouse.js";
import { createGreenhouseActionMcpServer } from "../src/server.js";
import { GreenhouseActionService, reconcileRecoverableActions } from "../src/service.js";
import type { GreenhouseActionService as ServiceType } from "../src/service.js";
import type { ActionKind, GreenhouseRow } from "../src/types.js";
import {
  MemoryActionStore,
  RouteGreenhouse,
  TEST_SECRET,
  TestClock,
  allowAllVisibility,
  testSession,
} from "./helpers.js";

/**
 * CLO-401: interview create/update as preview/apply kinds.
 *
 * The scheduling resident books the calendar first and then records the booking in Greenhouse, so
 * the property that matters most is that a booking is recorded ONCE: the calendar event id is the
 * idempotency key, a replay or reconciliation finds the existing record by it, and nothing ever
 * POSTs a second interview for the same event.
 */

const EVENT_ID = "gcal-evt-7h2k9q";
const ELEVEN_DEFAULT_KINDS: readonly ActionKind[] = [
  "application_assignment_change", "job_owner_change", "application_stage_move", "application_rejection",
  "application_unreject", "candidate_note_create", "job_note_change", "application_attribution_change",
  "candidate_record_update", "offer_create", "offer_update",
];

const CREATE_INPUT = {
  application_id: 100,
  job_interview_id: 7001,
  interviewers: [
    { user_id: 40, response_status: "accepted" },
    { user_id: 41, response_status: "needs_action" },
  ],
  starts_at: "2026-10-08T10:00:00-07:00",
  ends_at: "2026-10-08T10:45:00-07:00",
  external_event_id: EVENT_ID,
  location: "Zoom",
  video_conferencing_url: "https://zoom.us/j/5550001",
} as const;

const EXPECTED_CREATE_BODY = {
  application_id: 100,
  job_interview_id: 7001,
  interviewers: [
    { user_id: 40, response_status: "accepted" },
    { user_id: 41, response_status: "needs_action" },
  ],
  starts_at: "2026-10-08T10:00:00-07:00",
  ends_at: "2026-10-08T10:45:00-07:00",
  external_event_id: EVENT_ID,
  location: "Zoom",
  video_conferencing_url: "https://zoom.us/j/5550001",
};

function includesId(value: string | undefined, id: number): boolean {
  return value?.split(",").includes(String(id)) ?? false;
}

interface World {
  greenhouse: RouteGreenhouse;
  interviews: GreenhouseRow[];
  panel: GreenhouseRow[];
  createBehavior: "success" | "ambiguous_after_landing" | "ambiguous_not_landed";
  patchBehavior: "success" | "ambiguous_after_landing";
  /** Runs after a POST/PATCH lands and before the response: Greenhouse and calendars moving on. */
  afterMutation: (() => void) | null;
}

function world(): World {
  const users: GreenhouseRow[] = [
    { id: 10, name: "Actor", deactivated: false, site_admin: false },
    { id: 40, name: "Hiring Manager", deactivated: false, site_admin: false },
    { id: 41, name: "Panelist", deactivated: false, site_admin: false },
    { id: 42, name: "Departed", deactivated: true, site_admin: false },
    { id: 43, name: "New Panelist", deactivated: false, site_admin: false },
  ];
  const jobInterviews: GreenhouseRow[] = [
    { id: 7001, job_id: 200, name: "Hiring manager interview", active: true, job_interview_stage_id: 601 },
    { id: 7002, job_id: 999, name: "Another job's interview", active: true, job_interview_stage_id: 699 },
    { id: 7003, job_id: 200, name: "Retired slot", active: false, job_interview_stage_id: 601 },
  ];
  const state: World = {
    greenhouse: new RouteGreenhouse(),
    interviews: [],
    panel: [],
    createBehavior: "success",
    patchBehavior: "success",
    afterMutation: null,
  };
  let nextInterviewId = 8101;
  let nextPanelId = 9101;

  const land = (body: Record<string, unknown>): GreenhouseRow => {
    const row: GreenhouseRow = {
      id: nextInterviewId++,
      application_id: body.application_id,
      job_id: 200,
      job_interview_id: body.job_interview_id,
      external_event_id: body.external_event_id,
      // Greenhouse answers in UTC with milliseconds; the action must compare instants, not strings.
      starts_at: new Date(String(body.starts_at)).toISOString(),
      ends_at: new Date(String(body.ends_at)).toISOString(),
      location: body.location ?? null,
      video_conferencing_url: body.video_conferencing_url ?? null,
      status: "scheduled",
      // The integration's service user, not the actor: CLO-400's problem, recorded not chosen.
      organizer_id: 99,
    };
    state.interviews.push(row);
    for (const member of body.interviewers as Array<Record<string, unknown>>) {
      state.panel.push({ id: nextPanelId++, interview_id: row.id, user_id: member.user_id, response_status: member.response_status });
    }
    return row;
  };

  state.greenhouse
    .onList("/applications", (params) => includesId(params.ids, 100) ? [{
      id: 100, candidate_id: 300, job_id: 200, recruiter_id: 20, coordinator_id: 30,
      stage_id: 501, status: "in_process", source_id: 600, referrer_id: 700,
    }] : [])
    .onList("/users", (params) => users.filter((row) => includesId(params.ids, Number(row.id))))
    .onList("/jobs", (params) => includesId(params.ids, 200) ? [{ id: 200, confidential: false, name: "Staff Engineer" }] : [])
    .onList("/user_job_permissions", (params) => params.user_ids === "10" && params.job_ids === "200"
      ? [{ id: 1, user_id: 10, job_id: 200, role_id: 1, automated: false }]
      : [])
    .onList("/candidates", (params) => includesId(params.ids, 300) ? [{ id: 300, first_name: "Casey", last_name: "Example" }] : [])
    .onList("/job_interviews", (params) => jobInterviews.filter((row) =>
      includesId(params.ids, Number(row.id)) && (params.job_ids === undefined || includesId(params.job_ids, Number(row.job_id)))))
    .onList("/interviews", (params) => state.interviews.filter((row) =>
      (params.ids === undefined || includesId(params.ids, Number(row.id)))
      && (params.application_ids === undefined || includesId(params.application_ids, Number(row.application_id)))
      && (params.external_event_id === undefined || row.external_event_id === params.external_event_id)))
    .onList("/interviewers", (params) => state.panel.filter((row) => includesId(params.interview_ids, Number(row.interview_id))))
    .onMutation("POST", "/interviews", (input) => {
      if (state.createBehavior === "ambiguous_not_landed") {
        throw new GreenhouseError("timeout", { requestId: "request-timeout", ambiguous: true });
      }
      const row = land(input.body!);
      state.afterMutation?.();
      if (state.createBehavior === "ambiguous_after_landing") {
        throw new GreenhouseError("timeout", { requestId: "request-timeout", ambiguous: true });
      }
      return { status: 201, requestId: "request-interview-create", body: { ...row, interviewers: [] } };
    })
    .onMutation("PATCH", "/interviews/8001", (input) => {
      const row = state.interviews.find((candidate) => candidate.id === 8001)!;
      const { interviewers, ...scalars } = input.body!;
      for (const [key, value] of Object.entries(scalars)) {
        row[key] = key === "starts_at" || key === "ends_at" ? new Date(String(value)).toISOString() : value;
      }
      if (Array.isArray(interviewers)) {
        state.panel = state.panel.filter((member) => member.interview_id !== 8001);
        for (const member of interviewers as Array<Record<string, unknown>>) {
          state.panel.push({ id: nextPanelId++, interview_id: 8001, user_id: member.user_id, response_status: member.response_status });
        }
      }
      state.afterMutation?.();
      if (state.patchBehavior === "ambiguous_after_landing") {
        throw new GreenhouseError("timeout", { requestId: "request-timeout", ambiguous: true });
      }
      return { status: 200, requestId: "request-interview-update", body: { ...row } };
    });
  return state;
}

function seedInterview(state: World, overrides: Partial<GreenhouseRow> = {}, panel?: GreenhouseRow[]): void {
  const id = (overrides.id as number | undefined) ?? 8001;
  state.interviews.push({
    id,
    application_id: 100,
    job_id: 200,
    job_interview_id: 7001,
    external_event_id: "gcal-evt-existing",
    starts_at: "2026-10-08T17:00:00.000Z",
    ends_at: "2026-10-08T17:45:00.000Z",
    location: "Zoom",
    video_conferencing_url: null,
    status: "scheduled",
    organizer_id: 10,
    ...overrides,
  });
  state.panel.push(...(panel ?? [
    { id: 9001, interview_id: id, user_id: 40, response_status: "accepted" },
    { id: 9002, interview_id: id, user_id: 41, response_status: "tentative" },
  ]));
}

function serviceFor(greenhouse: RouteGreenhouse, options: { writeCapabilities?: ReadonlySet<ActionKind> } = {}) {
  const clock = new TestClock();
  const store = new MemoryActionStore(clock);
  const service = new GreenhouseActionService({
    session: testSession(),
    store,
    greenhouse,
    signingSecret: TEST_SECRET,
    visibility: allowAllVisibility(),
    writesEnabled: true,
    production: false,
    clock,
    ...(options.writeCapabilities ? { writeCapabilities: options.writeCapabilities } : {}),
  });
  return { service, store, clock };
}

function applyInput(preview: Record<string, unknown>): Record<string, unknown> {
  assert.equal(preview.status, "ready");
  return { intent: preview.intent, approval: preview.approval };
}

function denied(code: string) {
  return (error: unknown) => error instanceof ActionDeniedError && error.code === code;
}

function context(greenhouse: RouteGreenhouse) {
  return { actorUserId: 10, attributionMode: "service_user" as const, greenhouse, signingSecret: TEST_SECRET, clock: new TestClock() };
}

describe("interview_create (CLO-401)", () => {
  test("preview then apply records the booking once, with the exact v3 body", async () => {
    const state = world();
    const { service } = serviceFor(state.greenhouse);
    const preview = await service.preview("interview_create", CREATE_INPUT);
    assert.equal(preview.status, "ready");
    const approval = preview.approval as Record<string, unknown>;
    assert.deepEqual(approval.target, { application_id: 100, candidate_id: 300, job_id: 200, job_interview_id: 7001 });
    assert.deepEqual(approval.before, { already_recorded_interview_id: null, existing_interview_count: 0 });
    assert.deepEqual(approval.after, {
      external_event_id: EVENT_ID,
      starts_at: "2026-10-08T10:00:00-07:00",
      ends_at: "2026-10-08T10:45:00-07:00",
      location: "Zoom",
      video_conferencing_url: "https://zoom.us/j/5550001",
      interviewers: [
        { user_id: 40, response_status: "accepted" },
        { user_id: 41, response_status: "needs_action" },
      ],
    });
    // Legibility rides on the preview, never the signed approval.
    assert.equal((preview.target as Record<string, unknown>).job_interview_name, "Hiring manager interview");
    assert.deepEqual((preview.after as { interviewers: unknown }).interviewers, [
      { user_id: 40, name: "Hiring Manager", response_status: "accepted" },
      { user_id: 41, name: "Panelist", response_status: "needs_action" },
    ]);
    assert.deepEqual(preview.subject, { candidate: "Casey Example", job: "Staff Engineer" });

    const result = await service.apply("interview_create", applyInput(preview));
    assert.equal(result.state, "succeeded");
    assert.equal(result.observation, "desired_observed");
    assert.equal(result.result_resource_id, 8101);
    assert.deepEqual(state.greenhouse.mutationCalls, [
      { method: "POST", path: "/interviews", body: EXPECTED_CREATE_BODY, actorUserId: 10 },
    ]);
    // The read-back finds the record by its idempotency key, scoped to the application.
    assert.ok(state.greenhouse.listCalls.some(({ path, params }) =>
      path === "/interviews" && params.external_event_id === EVENT_ID && params.application_ids === "100"));
  });

  test("omits optional location and video link from the body when not supplied", async () => {
    const state = world();
    const { service } = serviceFor(state.greenhouse);
    const { location: _location, video_conferencing_url: _video, ...bare } = CREATE_INPUT;
    const result = await service.apply("interview_create", applyInput(await service.preview("interview_create", bare)));
    assert.equal(result.state, "succeeded");
    const { location: _l, video_conferencing_url: _v, ...expected } = EXPECTED_CREATE_BODY;
    assert.deepEqual(state.greenhouse.mutationCalls[0]!.body, expected);
  });

  test("locks and fences the application, and is not marked destructive", async () => {
    const state = world();
    const definition = actionDefinition("interview_create");
    const prepared = await definition.preparePreview(CREATE_INPUT, context(state.greenhouse));
    assert.equal(prepared.lockKey, "application:100");
    assert.equal(prepared.scopeJobId, 200);
    assert.deepEqual(prepared.fenceTargets, [{ kind: "application", id: 100, requiresUnredacted: false }]);
    assert.deepEqual(prepared.binding, { application_id: 100, job_interview_id: 7001, external_event_id: EVENT_ID, interviewer_user_ids: [40, 41] });
    assert.equal(definition.destructive, false);
    assert.equal(definition.previewTool, "preview_interview_create");
    assert.equal(definition.applyTool, "apply_interview_create");
  });

  test("an external_event_id already recorded on the application is reported, not re-created", async () => {
    const state = world();
    seedInterview(state, { external_event_id: EVENT_ID });
    const { service } = serviceFor(state.greenhouse);
    const preview = await service.preview("interview_create", CREATE_INPUT);
    assert.equal(preview.status, "no_change");
    assert.equal(preview.change_required, false);
    assert.equal(preview.intent, null);
    assert.equal((preview.approval as { before: { already_recorded_interview_id: unknown } }).before.already_recorded_interview_id, 8001);
    assert.equal(state.greenhouse.mutationCalls.length, 0);
  });

  test("apply refuses to create a duplicate when the event was recorded after preview", async () => {
    const state = world();
    const { service, store } = serviceFor(state.greenhouse);
    const input = applyInput(await service.preview("interview_create", CREATE_INPUT));
    // Another session (or the calendar sync) records the same event between preview and apply.
    seedInterview(state, { external_event_id: EVENT_ID });
    const result = await service.apply("interview_create", input);
    assert.equal(result.state, "failed");
    assert.equal(result.error_code, "INTERVIEW_ALREADY_RECORDED");
    assert.equal(state.greenhouse.mutationCalls.length, 0);
    assert.equal([...store.records.values()][0]!.phase, "preflight");
  });

  test("replaying a successful create returns the recorded result and never POSTs again", async () => {
    const state = world();
    const { service } = serviceFor(state.greenhouse);
    const input = applyInput(await service.preview("interview_create", CREATE_INPUT));
    const first = await service.apply("interview_create", input);
    const replay = await service.apply("interview_create", input);
    assert.equal(first.state, "succeeded");
    assert.equal(replay.replayed, true);
    assert.equal(replay.state, "succeeded");
    assert.equal(replay.result_resource_id, first.result_resource_id);
    assert.equal(state.greenhouse.mutationCalls.length, 1);
  });

  test("an ambiguous create that landed reconciles by external_event_id without a second POST", async () => {
    const state = world();
    state.createBehavior = "ambiguous_after_landing";
    const { service } = serviceFor(state.greenhouse);
    const input = applyInput(await service.preview("interview_create", CREATE_INPUT));
    const first = await service.apply("interview_create", input);
    assert.equal(first.state, "reconciled");
    assert.equal(first.observation, "desired_observed");
    assert.equal((await service.apply("interview_create", input)).state, "reconciled");
    assert.equal(state.greenhouse.mutationCalls.length, 1);
  });

  test("a create whose read-back lagged is reconciled later by external_event_id, never resent", async () => {
    const state = world();
    state.createBehavior = "ambiguous_not_landed";
    const { service, store, clock } = serviceFor(state.greenhouse);
    const input = applyInput(await service.preview("interview_create", CREATE_INPUT));
    const first = await service.apply("interview_create", input);
    assert.equal(first.state, "unknown");
    assert.equal(first.error_code, "UPSTREAM_RESULT_NOT_OBSERVED");
    // The POST had in fact landed; Greenhouse's read side catches up afterwards.
    state.interviews.push({
      id: 8150, application_id: 100, job_id: 200, job_interview_id: 7001, external_event_id: EVENT_ID,
      starts_at: "2026-10-08T17:00:00.000Z", ends_at: "2026-10-08T17:45:00.000Z", location: "Zoom",
      video_conferencing_url: "https://zoom.us/j/5550001", status: "scheduled", organizer_id: 99,
    });
    state.panel.push(
      { id: 9150, interview_id: 8150, user_id: 40, response_status: "accepted" },
      { id: 9151, interview_id: 8150, user_id: 41, response_status: "needs_action" },
    );
    const [reconciled] = await reconcileRecoverableActions({ store, greenhouse: state.greenhouse, signingSecret: TEST_SECRET, clock });
    assert.equal(reconciled!.state, "reconciled");
    assert.equal(reconciled!.observation, "desired_observed");
    assert.equal((await service.apply("interview_create", input)).state, "reconciled");
    assert.equal(state.greenhouse.mutationCalls.length, 1);
  });

  test("STATE_CHANGED when the application's interviews change between preview and apply", async () => {
    const state = world();
    const { service } = serviceFor(state.greenhouse);
    const input = applyInput(await service.preview("interview_create", CREATE_INPUT));
    seedInterview(state, { external_event_id: "gcal-evt-someone-else" });
    const result = await service.apply("interview_create", input);
    assert.equal(result.state, "failed");
    assert.equal(result.error_code, "STATE_CHANGED");
    assert.equal(state.greenhouse.mutationCalls.length, 0);
  });

  test("refuses a job_interview_id from another job, a retired slot, or an unknown slot", async () => {
    const state = world();
    const { service } = serviceFor(state.greenhouse);
    await assert.rejects(service.preview("interview_create", { ...CREATE_INPUT, job_interview_id: 7002 }),
      denied("JOB_INTERVIEW_NOT_ON_JOB"));
    await assert.rejects(service.preview("interview_create", { ...CREATE_INPUT, job_interview_id: 7003 }),
      denied("JOB_INTERVIEW_INACTIVE"));
    await assert.rejects(service.preview("interview_create", { ...CREATE_INPUT, job_interview_id: 7999 }),
      denied("TARGET_NOT_FOUND"));
    assert.equal(state.greenhouse.mutationCalls.length, 0);
    // The slot is validated through the read side's own job-interview list (GET /v3/job_interviews).
    assert.ok(state.greenhouse.listCalls.some(({ path, params }) => path === "/job_interviews" && params.ids === "7002"));
  });

  test("refuses inactive or unknown interviewers", async () => {
    const state = world();
    const { service } = serviceFor(state.greenhouse);
    await assert.rejects(service.preview("interview_create", {
      ...CREATE_INPUT, interviewers: [{ user_id: 40, response_status: "accepted" }, { user_id: 42, response_status: "accepted" }],
    }), denied("USER_INACTIVE"));
    await assert.rejects(service.preview("interview_create", {
      ...CREATE_INPUT, interviewers: [{ user_id: 44, response_status: "accepted" }],
    }), denied("TARGET_NOT_FOUND"));
  });

  test("the input schema is strict about times, the event id, and the panel", async () => {
    const state = world();
    const { service } = serviceFor(state.greenhouse);
    const invalid: Array<Record<string, unknown>> = [
      { ...CREATE_INPUT, ends_at: "2026-10-08T09:59:00-07:00" },
      { ...CREATE_INPUT, ends_at: CREATE_INPUT.starts_at },
      { ...CREATE_INPUT, starts_at: "2026-10-08T10:00:00" },
      { ...CREATE_INPUT, starts_at: "2026-10-08" },
      { ...CREATE_INPUT, external_event_id: "" },
      { ...CREATE_INPUT, external_event_id: "has space" },
      { ...CREATE_INPUT, external_event_id: "x".repeat(256) },
      { ...CREATE_INPUT, interviewers: [] },
      { ...CREATE_INPUT, interviewers: [{ email: "hm@example.com", response_status: "accepted" }] },
      { ...CREATE_INPUT, interviewers: [{ user_id: 40, response_status: "maybe" }] },
      { ...CREATE_INPUT, interviewers: [{ user_id: 40, response_status: "accepted" }, { user_id: 40, response_status: "declined" }] },
      { ...CREATE_INPUT, organizer_id: 10 },
      { ...CREATE_INPUT, video_conferencing_url: "not a url" },
    ];
    const { external_event_id: _required, ...withoutEventId } = CREATE_INPUT;
    invalid.push(withoutEventId);
    for (const input of invalid) {
      await assert.rejects(service.preview("interview_create", input), denied("INPUT_INVALID"), JSON.stringify(input));
    }
  });
});

describe("interview_update (CLO-401)", () => {
  test("approval shows the full current and desired panel, and PATCH carries only changed fields", async () => {
    const state = world();
    seedInterview(state);
    const { service } = serviceFor(state.greenhouse);
    const preview = await service.preview("interview_update", {
      interview_id: 8001,
      starts_at: "2026-10-09T10:00:00-07:00",
      ends_at: "2026-10-09T10:45:00-07:00",
      interviewers: [{ user_id: 40, response_status: "accepted" }, { user_id: 43, response_status: "needs_action" }],
    });
    assert.equal(preview.status, "ready");
    const approval = preview.approval as Record<string, Record<string, unknown> | unknown[]>;
    assert.deepEqual(approval.target, { interview_id: 8001, application_id: 100, job_id: 200 });
    assert.deepEqual(approval.changed_fields, ["starts_at", "ends_at", "interviewers"]);
    assert.deepEqual(approval.before, {
      status: "scheduled",
      starts_at: "2026-10-08T17:00:00.000Z",
      ends_at: "2026-10-08T17:45:00.000Z",
      location: "Zoom",
      video_conferencing_url: null,
      external_event_id: "gcal-evt-existing",
      // The signed before-panel is WHO is on it. Live RSVPs are the calendar's and move on their own,
      // so they ride on the preview below rather than in the fingerprinted approval.
      interviewers: [{ user_id: 40 }, { user_id: 41 }],
    });
    assert.deepEqual(approval.after, {
      starts_at: "2026-10-09T10:00:00-07:00",
      ends_at: "2026-10-09T10:45:00-07:00",
      location: "Zoom",
      video_conferencing_url: null,
      external_event_id: "gcal-evt-existing",
      interviewers: [
        { user_id: 40, response_status: "accepted" },
        { user_id: 43, response_status: "needs_action" },
      ],
    });
    assert.ok((approval.effects as string[]).some((effect) => /replaced as a whole/.test(effect)),
      "a panel change must say out loud that the whole panel is replaced");
    assert.deepEqual((preview.before as { interviewers: unknown }).interviewers, [
      { user_id: 40, name: "Hiring Manager", response_status: "accepted" },
      { user_id: 41, name: "Panelist", response_status: "tentative" },
    ]);
    assert.equal((preview.target as Record<string, unknown>).organizer_id, 10);

    const result = await service.apply("interview_update", applyInput(preview));
    assert.equal(result.state, "succeeded");
    assert.equal(result.observation, "desired_observed");
    assert.deepEqual(state.greenhouse.mutationCalls, [{
      method: "PATCH",
      path: "/interviews/8001",
      body: {
        starts_at: "2026-10-09T10:00:00-07:00",
        ends_at: "2026-10-09T10:45:00-07:00",
        interviewers: [{ user_id: 40, response_status: "accepted" }, { user_id: 43, response_status: "needs_action" }],
      },
      actorUserId: 10,
    }]);
    assert.deepEqual(state.panel.map(({ user_id }) => user_id), [40, 43]);
  });

  test("a scalar-only update still shows the full panel both sides and never sends interviewers", async () => {
    const state = world();
    seedInterview(state);
    const { service } = serviceFor(state.greenhouse);
    const preview = await service.preview("interview_update", { interview_id: 8001, location: "Room 4" });
    const approval = preview.approval as { before: { interviewers: unknown }; after: { interviewers: unknown }; changed_fields: unknown };
    assert.deepEqual(approval.changed_fields, ["location"]);
    assert.deepEqual(approval.before.interviewers, approval.after.interviewers);
    assert.equal((approval.before.interviewers as unknown[]).length, 2);
    const result = await service.apply("interview_update", applyInput(preview));
    assert.equal(result.state, "succeeded");
    assert.deepEqual(state.greenhouse.mutationCalls[0]!.body, { location: "Room 4" });
  });

  test("locks and fences the interview's application, resolved through GET /v3/interviews?ids=", async () => {
    const state = world();
    seedInterview(state);
    const definition = actionDefinition("interview_update");
    const prepared = await definition.preparePreview({ interview_id: 8001, location: "Room 4" }, context(state.greenhouse));
    assert.equal(prepared.lockKey, "application:100");
    assert.deepEqual(prepared.fenceTargets, [{ kind: "application", id: 100, requiresUnredacted: false }]);
    assert.deepEqual(prepared.binding, { interview_id: 8001, application_id: 100, fields: ["location"] });
    assert.equal(definition.destructive, true);
    assert.ok(state.greenhouse.listCalls.some(({ path, params }) => path === "/interviews" && params.ids === "8001"));
  });

  test("refuses to update an interview that is not scheduled", async () => {
    for (const status of ["complete", "awaiting_feedback", "to_be_scheduled", "skipped"]) {
      const state = world();
      seedInterview(state, { status });
      const { service } = serviceFor(state.greenhouse);
      await assert.rejects(service.preview("interview_update", { interview_id: 8001, location: "Room 4" }),
        denied("INTERVIEW_NOT_SCHEDULED"), status);
      assert.equal(state.greenhouse.mutationCalls.length, 0);
    }
  });

  test("an identical update is a no-op with no intent", async () => {
    const state = world();
    seedInterview(state);
    const { service } = serviceFor(state.greenhouse);
    const preview = await service.preview("interview_update", {
      interview_id: 8001, starts_at: "2026-10-08T10:00:00-07:00", location: "Zoom",
    });
    assert.equal(preview.status, "no_change");
    assert.equal(preview.intent, null);
  });

  test("refuses a panel replacement that would silently drop an external attendee", async () => {
    const state = world();
    seedInterview(state, {}, [
      { id: 9001, interview_id: 8001, user_id: 40, response_status: "accepted" },
      { id: 9003, interview_id: 8001, user_id: null, response_status: "needs_action" },
    ]);
    const { service } = serviceFor(state.greenhouse);
    await assert.rejects(service.preview("interview_update", {
      interview_id: 8001, interviewers: [{ user_id: 40, response_status: "accepted" }],
    }), denied("PANEL_HAS_EXTERNAL_ATTENDEES"));
  });

  test("refuses an update whose resulting times end before they start", async () => {
    const state = world();
    seedInterview(state);
    const { service } = serviceFor(state.greenhouse);
    await assert.rejects(service.preview("interview_update", { interview_id: 8001, ends_at: "2026-10-08T16:00:00Z" }),
      denied("INTERVIEW_TIME_INVALID"));
  });

  test("requires at least one change and a strict shape", async () => {
    const state = world();
    seedInterview(state);
    const { service } = serviceFor(state.greenhouse);
    for (const input of [
      { interview_id: 8001 },
      { interview_id: 8001, status: "complete" },
      { interview_id: 8001, location: "" },
      { interview_id: 8001, starts_at: "tomorrow" },
      { interview_id: 0, location: "Room 4" },
    ]) {
      await assert.rejects(service.preview("interview_update", input), denied("INPUT_INVALID"), JSON.stringify(input));
    }
    await assert.rejects(service.preview("interview_update", { interview_id: 8999, location: "Room 4" }), denied("TARGET_NOT_FOUND"));
  });

  test("STATE_CHANGED when the interview moves between preview and apply", async () => {
    const state = world();
    seedInterview(state);
    const { service } = serviceFor(state.greenhouse);
    const input = applyInput(await service.preview("interview_update", { interview_id: 8001, location: "Room 4" }));
    state.interviews[0]!.starts_at = "2026-10-08T18:00:00.000Z";
    const result = await service.apply("interview_update", input);
    assert.equal(result.state, "failed");
    assert.equal(result.error_code, "STATE_CHANGED");
    assert.equal(state.greenhouse.mutationCalls.length, 0);
  });
});

describe("interview kinds: transport, binding, and opt-in gating (CLO-401)", () => {
  test("MUTATION_PATHS admits POST /interviews and PATCH /interviews/{id} and nothing near them", async () => {
    const seen: string[] = [];
    const gateway = createGreenhouseGateway({
      clientId: "client", clientSecret: "secret", attributionMode: "service_user",
      fetchImpl: async (input, init = {}) => {
        const url = String(input);
        if (url.includes("auth.greenhouse.io")) {
          return Response.json({ access_token: "token", expires_at: "2099-01-01T00:00:00.000Z" });
        }
        seen.push(`${init.method} ${new URL(url).pathname}`);
        return Response.json({ id: 8101 });
      },
    });
    await gateway.mutate({ method: "POST", path: "/interviews", actorUserId: 10, body: {} });
    await gateway.mutate({ method: "PATCH", path: "/interviews/8001", actorUserId: 10, body: {} });
    assert.deepEqual(seen, ["POST /v3/interviews", "PATCH /v3/interviews/8001"]);
    for (const [method, path] of [
      ["PATCH", "/interviews/0"],
      ["PATCH", "/interviews/abc"],
      ["PATCH", "/interviews/007"],
      ["PATCH", "/interviews"],
      ["POST", "/interviews/8001"],
      ["DELETE", "/interviews/8001"],
      ["PATCH", "/interviews/8001/interviewers"],
    ] as const) {
      await assert.rejects(gateway.mutate({ method, path, actorUserId: 10 }), /not owned/, `${method} ${path}`);
    }
    assert.equal(seen.length, 2);
  });

  test("bindings parse exactly", () => {
    const create = { application_id: 100, job_interview_id: 7001, external_event_id: EVENT_ID, interviewer_user_ids: [40, 41] };
    assert.deepEqual(parseActionBinding("interview_create", create), create);
    const { interviewer_user_ids: _panel, ...withoutPanel } = create;
    assert.equal(parseActionBinding("interview_create", withoutPanel), null);
    assert.equal(parseActionBinding("interview_create", { ...create, interviewer_user_ids: [] }), null);
    assert.equal(parseActionBinding("interview_create", { ...create, interviewer_user_ids: [41, 40] }), null, "one canonical order");
    assert.equal(parseActionBinding("interview_create", { ...create, interviewer_user_ids: [40, 40] }), null);
    assert.equal(parseActionBinding("interview_create", { ...create, interviewer_user_ids: [0] }), null);
    assert.equal(parseActionBinding("interview_create", { ...create, extra: true }), null);
    assert.equal(parseActionBinding("interview_create", { ...create, external_event_id: "has space" }), null);
    assert.equal(parseActionBinding("interview_create", { ...create, external_event_id: "" }), null);
    assert.equal(parseActionBinding("interview_create", { ...create, job_interview_id: 0 }), null);
    const update = { interview_id: 8001, application_id: 100, fields: ["starts_at", "interviewers"] };
    assert.deepEqual(parseActionBinding("interview_update", update), update);
    assert.equal(parseActionBinding("interview_update", { ...update, fields: [] }), null);
    assert.equal(parseActionBinding("interview_update", { ...update, fields: ["status"] }), null);
    assert.equal(parseActionBinding("interview_update", { ...update, fields: ["location", "location"] }), null);
    assert.equal(parseActionBinding("interview_update", { ...update, organizer_id: 10 }), null);
  });

  test("the default capability set leaves both interview kinds off; listing them explicitly turns them on", () => {
    const defaults = readActionRuntimeFlags({});
    assert.deepEqual([...defaults.catalogCapabilities].sort(), [...ELEVEN_DEFAULT_KINDS].sort());
    assert.deepEqual([...defaults.writeCapabilities].sort(), [...ELEVEN_DEFAULT_KINDS].sort());
    const optedIn = readActionRuntimeFlags({ GREENHOUSE_ACTION_CAPABILITIES: [...ELEVEN_DEFAULT_KINDS, "interview_create", "interview_update"].join(",") });
    assert.equal(optedIn.catalogCapabilities.size, 13);
    assert.ok(optedIn.catalogCapabilities.has("interview_create") && optedIn.catalogCapabilities.has("interview_update"));
    assert.ok(optedIn.writeCapabilities.has("interview_create"), "write capabilities default to the explicit catalog");
    const previewOnly = readActionRuntimeFlags({
      GREENHOUSE_ACTION_CAPABILITIES: "interview_create",
      GREENHOUSE_ACTION_WRITE_CAPABILITIES: "",
    });
    assert.deepEqual([...previewOnly.catalogCapabilities], ["interview_create"]);
    assert.equal(previewOnly.writeCapabilities.size, 0);
  });

  test("the MCP server registers no interview tool unless the kind is enabled", async () => {
    const stub = {
      async preview(kind: ActionKind) { return { kind, status: "ready" }; },
      async apply(kind: ActionKind) { return { kind, state: "succeeded" }; },
    } as unknown as ServiceType;
    const list = async (env: NodeJS.ProcessEnv) => {
      const bundle = createGreenhouseActionMcpServer({ session: testSession(), service: stub, env });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test", version: "1" });
      try {
        await bundle.server.connect(serverTransport);
        await client.connect(clientTransport);
        return (await client.listTools()).tools;
      } finally {
        await client.close().catch(() => undefined);
        await bundle.server.close().catch(() => undefined);
      }
    };
    const defaults = await list({});
    assert.equal(defaults.length, 22);
    assert.equal(defaults.some((tool) => tool.name.includes("interview")), false);

    const enabled = await list({ GREENHOUSE_ACTION_CAPABILITIES: [...ELEVEN_DEFAULT_KINDS, "interview_create", "interview_update"].join(",") });
    assert.equal(enabled.length, 26);
    const byName = new Map(enabled.map((tool) => [tool.name, tool]));
    assert.equal(byName.get("apply_interview_create")?.annotations?.destructiveHint, false);
    assert.equal(byName.get("apply_interview_update")?.annotations?.destructiveHint, true);
    assert.equal(byName.get("preview_interview_create")?.annotations?.readOnlyHint, true);
    assert.deepEqual(Object.keys(byName.get("preview_interview_create")?.inputSchema.properties ?? {}).sort(), [
      "application_id", "ends_at", "external_event_id", "interviewers", "job_interview_id", "location", "starts_at",
      "video_conferencing_url",
    ]);
    assert.deepEqual(Object.keys(byName.get("preview_interview_update")?.inputSchema.properties ?? {}).sort(), [
      "ends_at", "external_event_id", "interview_id", "interviewers", "location", "starts_at", "video_conferencing_url",
    ]);
  });

  test("with default write capabilities, an interview apply is refused before any claim or mutation", async () => {
    const state = world();
    const { service, store } = serviceFor(state.greenhouse, { writeCapabilities: readActionRuntimeFlags({}).writeCapabilities });
    const input = applyInput(await service.preview("interview_create", CREATE_INPUT));
    await assert.rejects(service.apply("interview_create", input), denied("CAPABILITY_WRITES_DISABLED"));
    assert.equal(store.records.size, 0);
    assert.equal(state.greenhouse.mutationCalls.length, 0);
  });
});

/** The row and panel a landed CREATE_INPUT produces, for tests that land it by hand. */
function landByHand(state: World, overrides: Partial<GreenhouseRow> = {}, panel?: Array<{ user_id: number | null; response_status: string | null }>): void {
  state.interviews.push({
    id: 8150, application_id: 100, job_id: 200, job_interview_id: 7001, external_event_id: EVENT_ID,
    starts_at: "2026-10-08T17:00:00.000Z", ends_at: "2026-10-08T17:45:00.000Z", location: "Zoom",
    video_conferencing_url: "https://zoom.us/j/5550001", status: "scheduled", organizer_id: 99,
    ...overrides,
  });
  const members = panel ?? [{ user_id: 40, response_status: "accepted" }, { user_id: 41, response_status: "needs_action" }];
  state.panel.push(...members.map((member, index) => ({ id: 9150 + index, interview_id: 8150, ...member })));
}

describe("interview_create read-back and dedupe (CLO-401 review fixes)", () => {
  test("RSVPs moving and Greenhouse adding the organizer after the POST do not turn a landed create into a conflict", async () => {
    const state = world();
    state.afterMutation = () => {
      for (const member of state.panel) if (member.user_id === 41) member.response_status = "accepted";
      // `0097-get_v3-interviewers.md:628`: the calendar organizer typically appears as a panel row
      // with no scorecard; `:637-641` types response_status as nullable.
      state.panel.push({ id: 9199, interview_id: 8101, user_id: 99, response_status: null });
    };
    const { service } = serviceFor(state.greenhouse);
    const result = await service.apply("interview_create", applyInput(await service.preview("interview_create", CREATE_INPUT)));
    assert.equal(result.state, "succeeded");
    assert.equal(result.observation, "desired_observed");
  });

  test("a lagged create still reconciles after the hiring manager accepted", async () => {
    const state = world();
    state.createBehavior = "ambiguous_not_landed";
    const { service, store, clock } = serviceFor(state.greenhouse);
    const input = applyInput(await service.preview("interview_create", CREATE_INPUT));
    assert.equal((await service.apply("interview_create", input)).state, "unknown");
    landByHand(state, {}, [
      { user_id: 40, response_status: "accepted" },
      { user_id: 41, response_status: "accepted" },
      { user_id: 99, response_status: null },
    ]);
    const [reconciled] = await reconcileRecoverableActions({ store, greenhouse: state.greenhouse, signingSecret: TEST_SECRET, clock });
    assert.equal(reconciled!.state, "reconciled");
    assert.equal(reconciled!.observation, "desired_observed");
    assert.equal(state.greenhouse.mutationCalls.length, 1);
  });

  test("a recorded row that disagrees with the signed request is a conflict, never reconciled", async () => {
    const cases: Array<[string, Partial<GreenhouseRow>, Array<{ user_id: number | null; response_status: string | null }> | undefined]> = [
      ["start time", { starts_at: "2026-10-08T18:00:00.000Z" }, undefined],
      ["slot", { job_interview_id: 7003 }, undefined],
      ["location", { location: "Room 4" }, undefined],
      ["panel missing a requested interviewer", {}, [{ user_id: 40, response_status: "accepted" }]],
    ];
    for (const [label, overrides, panel] of cases) {
      const state = world();
      state.createBehavior = "ambiguous_not_landed";
      const { service, store, clock } = serviceFor(state.greenhouse);
      const input = applyInput(await service.preview("interview_create", CREATE_INPUT));
      assert.equal((await service.apply("interview_create", input)).state, "unknown", label);
      landByHand(state, overrides, panel);
      const [reconciled] = await reconcileRecoverableActions({ store, greenhouse: state.greenhouse, signingSecret: TEST_SECRET, clock });
      assert.notEqual(reconciled!.state, "reconciled", label);
      assert.equal(reconciled!.observation, "conflict", label);
      assert.equal(state.greenhouse.mutationCalls.length, 1, label);
    }
  });

  test("two interviews carrying the event id, or a different id than the POST returned, is a conflict", async () => {
    const state = world();
    const { service, store } = serviceFor(state.greenhouse);
    assert.equal((await service.apply("interview_create", applyInput(await service.preview("interview_create", CREATE_INPUT)))).state, "succeeded");
    const record = [...store.records.values()][0]!;
    const definition = actionDefinition("interview_create");
    assert.equal(await definition.observe(record, context(state.greenhouse)), "desired_observed");
    assert.equal(await definition.observe({ ...record, upstreamResourceId: 8999 }, context(state.greenhouse)), "conflict");
    seedInterview(state, { id: 8002, external_event_id: EVENT_ID }, []);
    assert.equal(await definition.observe(record, context(state.greenhouse)), "conflict");
    await assert.rejects(service.preview("interview_create", CREATE_INPUT), denied("UPSTREAM_STATE_INVALID"));
  });

  test("STATE_CHANGED when another interview's event id changes between preview and apply", async () => {
    const state = world();
    seedInterview(state, { external_event_id: "gcal-evt-other" });
    const { service } = serviceFor(state.greenhouse);
    const input = applyInput(await service.preview("interview_create", CREATE_INPUT));
    // Same ids, same count: only the create's baseline fingerprint can see this.
    state.interviews[0]!.external_event_id = "gcal-evt-moved";
    const result = await service.apply("interview_create", input);
    assert.equal(result.state, "failed");
    assert.equal(result.error_code, "STATE_CHANGED");
    assert.equal(state.greenhouse.mutationCalls.length, 0);
  });

  test("records a second interview alongside one already on the application", async () => {
    const state = world();
    seedInterview(state, { external_event_id: "gcal-evt-first-round" });
    const { service } = serviceFor(state.greenhouse);
    const preview = await service.preview("interview_create", CREATE_INPUT);
    assert.deepEqual((preview.approval as Record<string, unknown>).before, { already_recorded_interview_id: null, existing_interview_count: 1 });
    const result = await service.apply("interview_create", applyInput(preview));
    assert.equal(result.state, "succeeded");
    assert.equal(result.observation, "desired_observed");
    assert.equal(result.result_resource_id, 8101);
    assert.deepEqual(state.greenhouse.mutationCalls, [
      { method: "POST", path: "/interviews", body: EXPECTED_CREATE_BODY, actorUserId: 10 },
    ]);
    assert.equal(state.interviews.length, 2);
  });

  test("an already-recorded event says whether the record matches the request", async () => {
    const matching = world();
    landByHand(matching, { id: 8001 }, [
      { user_id: 40, response_status: "accepted" },
      { user_id: 41, response_status: "accepted" },
    ]);
    // landByHand keys the panel to 8150; re-key it to the seeded id.
    for (const member of matching.panel) member.interview_id = 8001;
    const same = await serviceFor(matching.greenhouse).service.preview("interview_create", CREATE_INPUT);
    assert.equal(same.status, "no_change");
    const recorded = same.already_recorded as Record<string, unknown>;
    assert.equal(recorded.interview_id, 8001);
    assert.equal(recorded.status, "scheduled");
    assert.equal(recorded.matches_request, true);
    assert.deepEqual(recorded.differences, []);

    const moved = world();
    landByHand(moved, { id: 8001, starts_at: "2026-10-08T18:00:00.000Z", ends_at: "2026-10-08T18:45:00.000Z" });
    for (const member of moved.panel) member.interview_id = 8001;
    const differs = await serviceFor(moved.greenhouse).service.preview("interview_create", CREATE_INPUT);
    assert.equal(differs.status, "no_change");
    const stale = differs.already_recorded as Record<string, unknown>;
    assert.equal(stale.matches_request, false);
    assert.deepEqual(stale.differences, ["starts_at", "ends_at"]);
    assert.equal(stale.starts_at, "2026-10-08T18:00:00.000Z");
    assert.match(String(stale.next_step), /preview_interview_update/);
    assert.equal(moved.greenhouse.mutationCalls.length, 0);
  });
});

describe("interview_update review fixes (CLO-401)", () => {
  test("an RSVP between preview and apply does not stop a scalar update", async () => {
    const state = world();
    seedInterview(state);
    const { service } = serviceFor(state.greenhouse);
    const input = applyInput(await service.preview("interview_update", { interview_id: 8001, location: "Room 4" }));
    state.panel.find((member) => member.user_id === 41)!.response_status = "accepted";
    const result = await service.apply("interview_update", input);
    assert.equal(result.state, "succeeded");
    assert.deepEqual(state.greenhouse.mutationCalls.map(({ body }) => body), [{ location: "Room 4" }]);
  });

  test("an RSVP after the PATCH lands does not make it a conflict, for a time change or a panel change", async () => {
    const reschedule = world();
    seedInterview(reschedule);
    reschedule.afterMutation = () => { reschedule.panel.find((member) => member.user_id === 41)!.response_status = "declined"; };
    const timed = serviceFor(reschedule.greenhouse).service;
    const moved = await timed.apply("interview_update", applyInput(await timed.preview("interview_update", {
      interview_id: 8001, starts_at: "2026-10-09T10:00:00-07:00", ends_at: "2026-10-09T10:45:00-07:00",
    })));
    assert.equal(moved.state, "succeeded");
    assert.equal(moved.observation, "desired_observed");

    const repanel = world();
    seedInterview(repanel);
    repanel.afterMutation = () => { repanel.panel.find((member) => member.user_id === 43)!.response_status = "accepted"; };
    const panelled = serviceFor(repanel.greenhouse).service;
    const swapped = await panelled.apply("interview_update", applyInput(await panelled.preview("interview_update", {
      interview_id: 8001, interviewers: [{ user_id: 40, response_status: "accepted" }, { user_id: 43, response_status: "needs_action" }],
    })));
    assert.equal(swapped.state, "succeeded");
    assert.equal(swapped.observation, "desired_observed");
  });

  test("a panel row with no RSVP does not block an update that leaves the panel alone", async () => {
    const state = world();
    seedInterview(state, {}, [
      { id: 9001, interview_id: 8001, user_id: 40, response_status: "accepted" },
      { id: 9004, interview_id: 8001, user_id: 99, response_status: null },
    ]);
    const { service } = serviceFor(state.greenhouse);
    const preview = await service.preview("interview_update", { interview_id: 8001, location: "Room 4" });
    assert.equal(preview.status, "ready");
    assert.deepEqual((preview.before as { interviewers: unknown }).interviewers, [
      { user_id: 40, name: "Hiring Manager", response_status: "accepted" },
      { user_id: 99, name: "(name unavailable)", response_status: null },
    ]);
    assert.equal((await service.apply("interview_update", applyInput(preview))).state, "succeeded");
  });

  test("an RSVP-only panel edit is no change: RSVPs are the calendar's, the connector sets who is on the panel", async () => {
    const state = world();
    seedInterview(state);
    const { service } = serviceFor(state.greenhouse);
    const preview = await service.preview("interview_update", {
      interview_id: 8001, interviewers: [{ user_id: 41, response_status: "accepted" }, { user_id: 40, response_status: "declined" }],
    });
    assert.equal(preview.status, "no_change");
    assert.equal(preview.intent, null);
  });

  test("refuses an event id another interview on the application already carries, at preview and at apply", async () => {
    const state = world();
    seedInterview(state);
    seedInterview(state, { id: 8002, external_event_id: "gcal-evt-sibling" }, []);
    const { service } = serviceFor(state.greenhouse);
    await assert.rejects(service.preview("interview_update", { interview_id: 8001, external_event_id: "gcal-evt-sibling" }),
      denied("EXTERNAL_EVENT_ID_IN_USE"));
    const input = applyInput(await service.preview("interview_update", { interview_id: 8001, external_event_id: "gcal-evt-rebooked" }));
    state.interviews.find((row) => row.id === 8002)!.external_event_id = "gcal-evt-rebooked";
    const result = await service.apply("interview_update", input);
    assert.equal(result.state, "failed");
    assert.equal(result.error_code, "EXTERNAL_EVENT_ID_IN_USE");
    assert.equal(state.greenhouse.mutationCalls.length, 0);
  });

  test("changes the calendar event id end to end", async () => {
    const state = world();
    seedInterview(state);
    const { service } = serviceFor(state.greenhouse);
    const preview = await service.preview("interview_update", { interview_id: 8001, external_event_id: "gcal-evt-rebooked" });
    assert.deepEqual((preview.approval as { changed_fields: unknown }).changed_fields, ["external_event_id"]);
    const result = await service.apply("interview_update", applyInput(preview));
    assert.equal(result.state, "succeeded");
    assert.equal(result.observation, "desired_observed");
    assert.deepEqual(state.greenhouse.mutationCalls.map(({ body }) => body), [{ external_event_id: "gcal-evt-rebooked" }]);
    assert.equal(state.interviews[0]!.external_event_id, "gcal-evt-rebooked");
  });

  test("replaying an applied update returns the recorded result and never PATCHes again", async () => {
    const state = world();
    seedInterview(state);
    const { service } = serviceFor(state.greenhouse);
    const input = applyInput(await service.preview("interview_update", { interview_id: 8001, location: "Room 4" }));
    const first = await service.apply("interview_update", input);
    const replay = await service.apply("interview_update", input);
    assert.equal(first.state, "succeeded");
    assert.equal(replay.replayed, true);
    assert.equal(replay.state, "succeeded");
    assert.equal(state.greenhouse.mutationCalls.length, 1);
  });

  test("an ambiguous PATCH that landed reconciles without a second PATCH", async () => {
    const state = world();
    seedInterview(state);
    state.patchBehavior = "ambiguous_after_landing";
    const { service } = serviceFor(state.greenhouse);
    const input = applyInput(await service.preview("interview_update", {
      interview_id: 8001, interviewers: [{ user_id: 40, response_status: "accepted" }, { user_id: 43, response_status: "needs_action" }],
    }));
    const first = await service.apply("interview_update", input);
    assert.equal(first.state, "reconciled");
    assert.equal(first.observation, "desired_observed");
    assert.equal((await service.apply("interview_update", input)).state, "reconciled");
    assert.equal(state.greenhouse.mutationCalls.length, 1);
  });

  test("read-back is a conflict when the interview now belongs to another application", async () => {
    const state = world();
    seedInterview(state);
    const { service, store } = serviceFor(state.greenhouse);
    assert.equal((await service.apply("interview_update", applyInput(await service.preview("interview_update", { interview_id: 8001, location: "Room 4" })))).state, "succeeded");
    const record = [...store.records.values()][0]!;
    const definition = actionDefinition("interview_update");
    assert.equal(await definition.observe(record, context(state.greenhouse)), "desired_observed");
    state.interviews[0]!.application_id = 101;
    assert.equal(await definition.observe(record, context(state.greenhouse)), "conflict");
  });

  test("refuses an inactive interviewer on an update", async () => {
    const state = world();
    seedInterview(state);
    const { service } = serviceFor(state.greenhouse);
    await assert.rejects(service.preview("interview_update", {
      interview_id: 8001, interviewers: [{ user_id: 40, response_status: "accepted" }, { user_id: 42, response_status: "accepted" }],
    }), denied("USER_INACTIVE"));
  });
});
