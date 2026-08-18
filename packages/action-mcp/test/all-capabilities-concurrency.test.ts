import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ActionDeniedError } from "../src/errors.js";
import { GreenhouseError } from "../src/greenhouse.js";
import { GreenhouseActionService, reconcileRecoverableActions } from "../src/service.js";
import { ACTION_KINDS } from "../src/types.js";
import type { ActionKind, GreenhouseRow } from "../src/types.js";
import {
  MemoryActionStore,
  RouteGreenhouse,
  TEST_SECRET,
  TestClock,
  allowAllVisibility,
  probeReturning,
  testSession,
} from "./helpers.js";

interface Scenario {
  kind: ActionKind;
  preview: Record<string, unknown>;
  mutation: {
    method: "POST" | "PATCH" | "DELETE";
    path: string;
    body?: Record<string, unknown>;
  };
}

const SCENARIOS: readonly Scenario[] = [
  {
    kind: "application_assignment_change",
    preview: { application_id: 100, assignment_role: "recruiter", proposed_user_id: 40 },
    mutation: { method: "PATCH", path: "/applications/100", body: { recruiter_id: 40 } },
  },
  {
    kind: "job_owner_change",
    preview: { verb: "add", job_id: 200, user_id: 40, owner_type: "sourcer" },
    mutation: { method: "POST", path: "/job_owners", body: { job_id: 200, user_id: 40, type: "sourcer" } },
  },
  {
    kind: "application_stage_move",
    preview: { application_id: 100, to_stage_id: 602 },
    mutation: { method: "POST", path: "/applications/100/move", body: { from_stage_id: 501, to_stage_id: 602 } },
  },
  {
    kind: "application_rejection",
    preview: { application_id: 100, rejection_reason_id: 701 },
    mutation: { method: "POST", path: "/applications/100/reject", body: { rejection_reason_id: 701 } },
  },
  {
    kind: "application_unreject",
    preview: { application_id: 100 },
    mutation: { method: "POST", path: "/applications/100/unreject", body: {} },
  },
  {
    kind: "candidate_note_create",
    preview: { application_id: 100, body: "Follow up", visibility: "private", note_type: "NOTE" },
    mutation: {
      method: "POST",
      path: "/notes",
      body: {
        candidate_id: 300,
        application_id: 100,
        body: "Follow up",
        visibility: "private",
        note_type: "NOTE",
        user_id: 10,
      },
    },
  },
  {
    kind: "job_note_change",
    preview: { verb: "create", job_id: 200, body: "Hiring note", visibility: "privately_visible" },
    mutation: {
      method: "POST",
      path: "/job_notes",
      body: { job_id: 200, user_id: 10, body: "Hiring note", visibility: "privately_visible" },
    },
  },
  {
    kind: "application_attribution_change",
    preview: { application_id: 100, source_id: 601 },
    mutation: { method: "PATCH", path: "/applications/100", body: { source_id: 601 } },
  },
  {
    kind: "candidate_record_update",
    preview: { context_application_id: 100, changes: { first_name: "After" } },
    mutation: { method: "PATCH", path: "/candidates/300", body: { first_name: "After" } },
  },
  {
    kind: "offer_create",
    preview: { application_id: 100, starts_on: "2026-08-01" },
    mutation: { method: "POST", path: "/offers", body: { application_id: 100, starts_on: "2026-08-01" } },
  },
  {
    kind: "offer_update",
    preview: { application_id: 100, offer_id: 950, starts_on: "2026-09-01" },
    mutation: { method: "PATCH", path: "/offers/950", body: { starts_on: "2026-09-01" } },
  },
];

describe("all action kinds share exactly-once apply behavior", () => {
  test("the table covers every action kind once", () => {
    assert.deepEqual([...SCENARIOS.map(({ kind }) => kind)].sort(), [...ACTION_KINDS].sort());
  });

  for (const scenario of SCENARIOS) {
    test(`${scenario.kind}: concurrent double-click and replay send one exact mutation`, async () => {
      const { service, greenhouse, store } = fixture(scenario.kind);
      const preview = await service.preview(scenario.kind, scenario.preview);
      assert.equal(preview.status, "ready");
      assert.equal(greenhouse.mutationCalls.length, 0);
      assert.equal(store.records.size, 0);
      const input = { intent: preview.intent, approval: preview.approval };

      const [left, right] = await Promise.all([
        applyUntilTerminal(service, scenario.kind, input),
        applyUntilTerminal(service, scenario.kind, input),
      ]);

      assert.deepEqual(terminalResult(left), terminalResult(right));
      assert.equal(left.state, "succeeded");
      assert.equal(left.observation, "desired_observed");
      assert.deepEqual(greenhouse.mutationCalls, [{ ...scenario.mutation, actorUserId: 10 }]);

      const replay = await service.apply(scenario.kind, input);
      assert.deepEqual(terminalResult(replay), terminalResult(left));
      assert.equal(replay.replayed, true);
      assert.equal(greenhouse.mutationCalls.length, 1);
    });
  }

  test("different lock targets can execute while another target is in flight", async () => {
    const clock = new TestClock();
    const store = new FirstMutationGateStore(clock);
    const greenhouse = greenhouseFor("application_assignment_change");
    const service = serviceFor(store, greenhouse, clock);
    const assignment = applyInput(await service.preview("application_assignment_change", {
      application_id: 100, assignment_role: "recruiter", proposed_user_id: 40,
    }));
    const candidate = applyInput(await service.preview("candidate_record_update", {
      context_application_id: 100, changes: { first_name: "After" },
    }));

    const blockedAssignment = service.apply("application_assignment_change", assignment);
    await store.mutationReached;
    const candidateResult = await service.apply("candidate_record_update", candidate);

    assert.equal(candidateResult.state, "succeeded");
    assert.deepEqual(greenhouse.mutationCalls, [{
      method: "PATCH", path: "/candidates/300", body: { first_name: "After" }, actorUserId: 10,
    }]);
    store.release();
    assert.equal((await blockedAssignment).state, "succeeded");
    assert.equal(greenhouse.mutationCalls.length, 2);
  });

  test("different action kinds on one application serialize on the shared lock", async () => {
    const clock = new TestClock();
    const store = new FirstMutationGateStore(clock);
    const greenhouse = greenhouseFor("application_assignment_change");
    const service = serviceFor(store, greenhouse, clock);
    const assignment = applyInput(await service.preview("application_assignment_change", {
      application_id: 100, assignment_role: "recruiter", proposed_user_id: 40,
    }));
    const attribution = applyInput(await service.preview("application_attribution_change", {
      application_id: 100, source_id: 601,
    }));

    const blockedAssignment = service.apply("application_assignment_change", assignment);
    await store.mutationReached;
    await assert.rejects(
      service.apply("application_attribution_change", attribution),
      (error: unknown) => error instanceof ActionDeniedError && error.code === "TARGET_BUSY",
    );
    assert.equal(greenhouse.mutationCalls.length, 0);

    store.release();
    assert.equal((await blockedAssignment).state, "succeeded");
    assert.equal((await service.apply("application_attribution_change", attribution)).state, "succeeded");
    assert.deepEqual(greenhouse.mutationCalls.map(({ method, path, body }) => ({ method, path, body })), [
      { method: "PATCH", path: "/applications/100", body: { recruiter_id: 40 } },
      { method: "PATCH", path: "/applications/100", body: { source_id: 601 } },
    ]);
  });

  test("invalid and unknown targets fail before claim or mutation for every action kind", async () => {
    for (const scenario of SCENARIOS) {
      {
        const { service, greenhouse, store } = fixture(scenario.kind);
        await assert.rejects(service.preview(scenario.kind, {}), (error: unknown) =>
          error instanceof ActionDeniedError && error.code === "INPUT_INVALID", scenario.kind);
        assert.equal(store.records.size, 0, scenario.kind);
        assert.equal(greenhouse.mutationCalls.length, 0, scenario.kind);
      }
      {
        const { service, greenhouse, store } = fixture(scenario.kind);
        const missing = missingTarget(scenario.kind, scenario.preview);
        await assert.rejects(service.preview(scenario.kind, missing), (error: unknown) =>
          error instanceof ActionDeniedError && error.code === "TARGET_NOT_FOUND", scenario.kind);
        assert.equal(store.records.size, 0, scenario.kind);
        assert.equal(greenhouse.mutationCalls.length, 0, scenario.kind);
      }
    }
  });

  test("applicable no-op previews issue no intent, claim, or mutation", async () => {
    const noops: Array<{ kind: ActionKind; preview: Record<string, unknown> }> = [
      { kind: "application_assignment_change", preview: { application_id: 100, assignment_role: "recruiter", proposed_user_id: 20 } },
      { kind: "application_stage_move", preview: { application_id: 100, to_stage_id: 601 } },
      { kind: "application_attribution_change", preview: { application_id: 100, source_id: 600 } },
      { kind: "candidate_record_update", preview: { context_application_id: 100, changes: { first_name: "Before" } } },
      { kind: "offer_update", preview: { application_id: 100, offer_id: 950, starts_on: "2026-08-01" } },
    ];
    for (const scenario of noops) {
      const { service, greenhouse, store } = fixture(scenario.kind);
      const preview = await service.preview(scenario.kind, scenario.preview);
      assert.equal(preview.status, "no_change", scenario.kind);
      assert.equal(preview.intent, null, scenario.kind);
      assert.equal(store.records.size, 0, scenario.kind);
      assert.equal(greenhouse.mutationCalls.length, 0, scenario.kind);
    }
  });

  test("all action kinds remain at-most-once through ambiguous original and desired outcomes", async () => {
    for (const scenario of SCENARIOS) {
      {
        const { service, greenhouse } = fixture(scenario.kind);
        greenhouse.mutate = async (input) => {
          greenhouse.mutationCalls.push(structuredClone(input));
          throw new GreenhouseError("ambiguous original", { status: 503, requestId: "ambiguous-original", ambiguous: true });
        };
        const input = applyInput(await service.preview(scenario.kind, scenario.preview));
        const first = await service.apply(scenario.kind, input);
        assert.equal(first.state, "unknown", scenario.kind);
        assert.equal((await service.apply(scenario.kind, input)).state, "unknown", scenario.kind);
        assert.equal(greenhouse.mutationCalls.length, 1, scenario.kind);
      }
      {
        const { service, greenhouse } = fixture(scenario.kind);
        const successfulMutation = greenhouse.mutate.bind(greenhouse);
        greenhouse.mutate = async (input) => {
          await successfulMutation(input);
          throw new GreenhouseError("ambiguous desired", { requestId: "ambiguous-desired", ambiguous: true });
        };
        const input = applyInput(await service.preview(scenario.kind, scenario.preview));
        const first = await service.apply(scenario.kind, input);
        assert.equal(first.state, "reconciled", scenario.kind);
        assert.equal(first.observation, "desired_observed", scenario.kind);
        assert.equal((await service.apply(scenario.kind, input)).state, "reconciled", scenario.kind);
        assert.equal(greenhouse.mutationCalls.length, 1, scenario.kind);
      }
    }
  });

  test("all action kinds fail closed on pre-send and post-send ownership loss", async () => {
    for (const scenario of SCENARIOS) {
      {
        const { service, greenhouse, store } = fixture(scenario.kind);
        const input = applyInput(await service.preview(scenario.kind, scenario.preview));
        store.failBegin = true;
        await assert.rejects(service.apply(scenario.kind, input), (error: unknown) =>
          error instanceof ActionDeniedError && error.code === "ACTION_OWNERSHIP_LOST", scenario.kind);
        assert.equal(greenhouse.mutationCalls.length, 0, scenario.kind);
      }
      {
        const { service, greenhouse, store } = fixture(scenario.kind);
        const input = applyInput(await service.preview(scenario.kind, scenario.preview));
        store.finishReturnsNull = true;
        const first = await service.apply(scenario.kind, input);
        assert.equal(first.state, "unknown", scenario.kind);
        assert.equal(first.error_code, "ACTION_OWNERSHIP_LOST", scenario.kind);
        assert.equal((await service.apply(scenario.kind, input)).state, "in_progress", scenario.kind);
        assert.equal(greenhouse.mutationCalls.length, 1, scenario.kind);
      }
    }
  });

  for (const { kind, graceMs } of [
    { kind: "candidate_record_update" as const, graceMs: 30 * 60_000 },
    { kind: "offer_create" as const, graceMs: 10 * 60_000 },
  ]) {
    test(`${kind}: repeated unknown calls respect its full grace and never resend`, async () => {
      const { service, greenhouse, store, clock } = fixture(kind);
      const scenario = SCENARIOS.find((candidate) => candidate.kind === kind)!;
      greenhouse.onMutation(scenario.mutation.method, scenario.mutation.path, () => {
        throw new GreenhouseError("ambiguous", { status: 503, requestId: `unknown-${kind}`, ambiguous: true });
      });
      const input = applyInput(await service.preview(kind, scenario.preview));
      const first = await service.apply(kind, input);
      assert.equal(first.state, "unknown");
      assert.equal(greenhouse.mutationCalls.length, 1);
      const record = [...store.records.values()][0]!;
      assert.equal(Date.parse(record.notAppliedBefore) - Date.parse(record.leaseExpiresAt), graceMs);

      const repeats = await Promise.all(Array.from({ length: 12 }, () => service.apply(kind, input)));
      assert.ok(repeats.every((result) => result.state === "unknown"));
      assert.equal(greenhouse.mutationCalls.length, 1);
      const observed = store.records.get(record.actionId)!;
      assert.ok(observed.firstOriginalObservationAt);
      clock.value = Math.max(
        Date.parse(observed.notAppliedBefore),
        Date.parse(observed.firstOriginalObservationAt!) + 30_000,
      ) + 1;
      const reconciled = (await reconcileRecoverableActions({
        store, greenhouse, signingSecret: TEST_SECRET, clock,
      }))[0]!;
      assert.equal(reconciled.state, "reconciled");
      assert.equal(reconciled.error_code, "UPSTREAM_RESULT_NOT_APPLIED");
      assert.equal(greenhouse.mutationCalls.length, 1);
    });
  }

  test("real sensitive previews keep note, PII, and compensation values out of intents and durable state", async () => {
    const cases: Array<{ kind: ActionKind; preview: Record<string, unknown>; sentinels: string[] }> = [
      {
        kind: "candidate_note_create",
        preview: { application_id: 100, body: "candidate-note-secret-7f3b", visibility: "private", note_type: "NOTE" },
        sentinels: ["candidate-note-secret-7f3b"],
      },
      {
        kind: "job_note_change",
        preview: { verb: "create", job_id: 200, body: "job-note-secret-8c4d", visibility: "privately_visible" },
        sentinels: ["job-note-secret-8c4d"],
      },
      {
        kind: "candidate_record_update",
        preview: {
          context_application_id: 100,
          changes: { email_addresses: { add: [{ value: "private-candidate-9e5f@example.invalid", type: "personal" }] } },
        },
        sentinels: ["private-candidate-9e5f@example.invalid"],
      },
      {
        kind: "offer_create",
        preview: {
          application_id: 100,
          custom_fields: [{ name_key: "salary", value: { amount: 987_654_321.12, currency_code: "USD" } }],
        },
        sentinels: ["987654321.12"],
      },
    ];

    for (const scenario of cases) {
      const { service, store } = fixture(scenario.kind);
      const preview = await service.preview(scenario.kind, scenario.preview);
      assert.equal(preview.status, "ready", scenario.kind);
      const decodedIntent = Buffer.from(String(preview.intent).split(".")[0]!, "base64url").toString("utf8");
      const approval = JSON.stringify(preview.approval);
      for (const sentinel of scenario.sentinels) {
        assert.match(approval, new RegExp(sentinel.replaceAll(".", "\\.")), `${scenario.kind} approval`);
        assert.doesNotMatch(decodedIntent, new RegExp(sentinel.replaceAll(".", "\\.")), `${scenario.kind} intent`);
      }
      const result = await service.apply(scenario.kind, applyInput(preview));
      assert.ok(result.state === "succeeded" || result.state === "reconciled", scenario.kind);
      const durable = JSON.stringify([...store.records.values()]);
      const publicResult = JSON.stringify(result);
      for (const sentinel of scenario.sentinels) {
        const pattern = new RegExp(sentinel.replaceAll(".", "\\."));
        assert.doesNotMatch(durable, pattern, `${scenario.kind} durable state`);
        assert.doesNotMatch(publicResult, pattern, `${scenario.kind} result`);
      }
    }
  });
});

async function applyUntilTerminal(
  service: GreenhouseActionService,
  kind: ActionKind,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await service.apply(kind, input);
    if (result.state !== "in_progress") return result;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`${kind} did not reach a terminal state.`);
}

function terminalResult(result: Record<string, unknown>) {
  const { replayed: _replayed, ...terminal } = result;
  return terminal;
}

function applyInput(preview: Record<string, unknown>): Record<string, unknown> {
  assert.equal(preview.status, "ready");
  return { intent: preview.intent, approval: preview.approval };
}

class FirstMutationGateStore extends MemoryActionStore {
  private first = true;
  private openGate!: () => void;
  private markReached!: () => void;
  readonly mutationReached = new Promise<void>((resolve) => { this.markReached = resolve; });
  private readonly gate = new Promise<void>((resolve) => { this.openGate = resolve; });

  override async beginMutation(input: { actionId: string; ownerToken: string }): Promise<boolean> {
    if (this.first) {
      this.first = false;
      this.markReached();
      await this.gate;
    }
    return super.beginMutation(input);
  }

  release(): void { this.openGate(); }
}

function fixture(kind: ActionKind) {
  const clock = new TestClock();
  const store = new MemoryActionStore(clock);
  const greenhouse = greenhouseFor(kind);
  return { service: serviceFor(store, greenhouse, clock), greenhouse, store, clock };
}

function missingTarget(kind: ActionKind, preview: Record<string, unknown>): Record<string, unknown> {
  if (kind === "job_owner_change" || kind === "job_note_change") return { ...preview, job_id: 999 };
  if (kind === "candidate_record_update") return { ...preview, context_application_id: 999 };
  return { ...preview, application_id: 999 };
}

function serviceFor(
  store: MemoryActionStore,
  greenhouse: RouteGreenhouse,
  clock: TestClock,
  visibility: import("../src/types.js").TargetVisibilityProbe = allowAllVisibility()
) {
  return new GreenhouseActionService({
    session: testSession(),
    store,
    greenhouse,
    signingSecret: TEST_SECRET,
    visibility,
    writesEnabled: true,
    production: false,
    clock,
  });
}

function greenhouseFor(kind: ActionKind): RouteGreenhouse {
  const unreject = kind === "application_unreject";
  const application: GreenhouseRow = {
    id: 100,
    candidate_id: 300,
    job_id: 200,
    recruiter_id: 20,
    coordinator_id: 30,
    stage_id: unreject ? null : 501,
    status: unreject ? "rejected" : "in_process",
    source_id: 600,
    referrer_id: 700,
  };
  const users: GreenhouseRow[] = [
    { id: 10, name: "Actor", deactivated: false, site_admin: false },
    { id: 20, name: "Current recruiter", deactivated: false, site_admin: false },
    { id: 30, name: "Current coordinator", deactivated: false, site_admin: false },
    { id: 40, name: "Proposed user", deactivated: false, site_admin: false },
  ];
  let applicationStages: GreenhouseRow[] = [{
    id: 501,
    application_id: 100,
    job_interview_stage_id: 601,
    current: !unreject,
    entered_at: "2026-06-01T00:00:00.000Z",
    exited_at: unreject ? "2026-07-01T00:00:00.000Z" : null,
  }];
  let rejectionDetails: GreenhouseRow[] = unreject ? [{
    id: 801,
    application_id: 100,
    rejection_reason_id: 701,
    rejection_note_id: null,
    rejected_at: "2026-07-01T00:00:00.000Z",
    rejected_by_id: 10,
  }] : [];
  const candidate: GreenhouseRow = {
    id: 300,
    first_name: "Before",
    last_name: "Candidate",
    preferred_name: null,
    company: null,
    title: null,
    time_zone: "america/los_angeles",
    phone_numbers: [],
    addresses: [],
    email_addresses: [],
    website_addresses: [],
    social_media_addresses: [],
    tags: [],
    linked_user_ids: [],
    custom_fields: {},
  };
  let jobOwners: GreenhouseRow[] = [];
  let candidateNotes: GreenhouseRow[] = [];
  let jobNotes: GreenhouseRow[] = kind === "job_note_change" ? [{
    id: 700, job_id: 200, user_id: 10, body: "existing body", visibility: "admin_only_visible",
    created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z",
  }] : [];
  let offers: GreenhouseRow[] = kind === "offer_update" ? [{
    id: 950,
    version: 1,
    application_id: 100,
    job_id: 200,
    candidate_id: 300,
    status: "Created",
    starts_on: "2026-08-01",
    custom_fields: {},
  }] : [];

  const greenhouse = new RouteGreenhouse()
    .onList("/applications", (params) => includesId(params.ids, 100) ? [application] : [])
    .onList("/users", (params) => users.filter((row) => includesId(params.ids, Number(row.id))))
    .onList("/jobs", (params) => includesId(params.ids, 200) ? [{ id: 200, confidential: false }] : [])
    .onList("/user_job_permissions", (params) =>
      includesId(params.job_ids, 200) && [10, 40].some((id) => includesId(params.user_ids, id))
        ? [{ id: 901, user_id: Number(params.user_ids), job_id: 200, role_id: 1, automated: false }]
        : [])
    .onList("/application_stages", (params) => params.current === "true"
      ? applicationStages.filter((row) => row.current === true)
      : applicationStages)
    .onList("/job_interview_stages", (params) => [
      { id: 601, job_id: 200, name: "Phone screen", active: true, sort_order: 1 },
      { id: 602, job_id: 200, name: "Onsite", active: true, sort_order: 2 },
    ].filter((row) => includesId(params.ids, row.id)))
    .onList("/rejection_details", () => rejectionDetails)
    .onList("/rejection_reasons", (params) => includesId(params.ids, 701)
      ? [{ id: 701, name: "Position closed", type: "rejection_reason" }]
      : [])
    .onList("/notes", () => candidateNotes)
    .onList("/job_notes", (params) => params.ids === undefined
      ? jobNotes
      : jobNotes.filter((row) => includesId(params.ids, Number(row.id))))
    .onList("/job_owners", () => jobOwners)
    .onList("/sources", (params) => [
      { id: 600, name: "Original source", type: "Custom" },
      { id: 601, name: "New source", type: "Custom" },
    ].filter((row) => includesId(params.ids, row.id)))
    .onList("/referrers", () => [])
    .onList("/candidates", (params) => includesId(params.ids, 300) ? [candidate] : [])
    .onList("/offers", () => offers)
    .onList("/custom_fields", () => kind.startsWith("offer_") ? [{
      id: 1,
      name_key: "salary",
      value_type: "currency",
      trigger_new_version: true,
      active: true,
      field_type: "offer",
    }] : [])
    .onList("/custom_field_options", () => [])
    .onMutation("PATCH", "/applications/100", (input) => {
      Object.assign(application, input.body);
      return { status: 200, requestId: "request-application", body: { id: 100 } };
    })
    .onMutation("POST", "/job_owners", (input) => {
      jobOwners = [{ id: 902, ...input.body, responsible: false }];
      return { status: 201, requestId: "request-job-owner", body: { id: 902 } };
    })
    .onMutation("POST", "/applications/100/move", (input) => {
      application.stage_id = 502;
      applicationStages = [
        { ...applicationStages[0], current: false, exited_at: "2026-07-02T00:00:00.000Z" },
        {
          id: 502,
          application_id: 100,
          job_interview_stage_id: Number(input.body?.to_stage_id),
          current: true,
          entered_at: "2026-07-02T00:00:00.000Z",
          exited_at: null,
        },
      ];
      return { status: 200, requestId: "request-stage", body: { id: 100 } };
    })
    .onMutation("POST", "/applications/100/reject", (input) => {
      application.status = "rejected";
      application.stage_id = null;
      applicationStages = applicationStages.map((row) => ({ ...row, current: false }));
      rejectionDetails = [{
        id: 801,
        application_id: 100,
        rejection_reason_id: Number(input.body?.rejection_reason_id),
        rejection_note_id: null,
        rejected_at: "2026-07-02T00:00:00.000Z",
        rejected_by_id: 10,
      }];
      return { status: 200, requestId: "request-reject", body: { id: 100 } };
    })
    .onMutation("POST", "/applications/100/unreject", () => {
      application.status = "in_process";
      application.stage_id = 502;
      rejectionDetails = [];
      applicationStages = [
        ...applicationStages.map((row) => ({ ...row, current: false })),
        {
          id: 502,
          application_id: 100,
          job_interview_stage_id: 601,
          current: true,
          entered_at: "2026-07-02T00:00:00.000Z",
          exited_at: null,
        },
      ];
      return { status: 200, requestId: "request-unreject", body: { id: 100 } };
    })
    .onMutation("POST", "/notes", (input) => {
      const visibility = input.body?.visibility === "private" ? "privately_visible"
        : input.body?.visibility === "public" ? "publicly_visible" : "admin_only_visible";
      candidateNotes = [{
        id: 903,
        candidate_id: input.body?.candidate_id,
        application_id: input.body?.application_id,
        user_id: input.body?.user_id,
        type: input.body?.note_type,
        visibility,
        body: input.body?.body,
      }];
      return { status: 201, requestId: "request-candidate-note", body: { id: 903 } };
    })
    .onMutation("POST", "/job_notes", (input) => {
      // APPEND, never replace: a create leaves the pre-existing notes standing, and the create
      // observation's baseline arithmetic depends on that once the fixture seeds a note.
      jobNotes = [...jobNotes, { id: 904, ...input.body }];
      return { status: 201, requestId: "request-job-note", body: { id: 904 } };
    })
    .onMutation("PATCH", "/candidates/300", (input) => {
      Object.assign(candidate, input.body);
      return { status: 200, requestId: "request-candidate", body: { id: 300 } };
    })
    .onMutation("POST", "/offers", (input) => {
      offers = [{
        id: 951,
        version: 1,
        application_id: input.body?.application_id,
        job_id: 200,
        candidate_id: 300,
        status: "Created",
        starts_on: input.body?.starts_on ?? null,
        custom_fields: keyedCustomFields(input.body?.custom_fields),
      }];
      return { status: 201, requestId: "request-offer-create", body: { id: 951 } };
    })
    .onMutation("PATCH", "/offers/950", (input) => {
      Object.assign(offers[0]!, input.body, Object.hasOwn(input.body ?? {}, "custom_fields")
        ? { custom_fields: keyedCustomFields(input.body?.custom_fields) }
        : {});
      return { status: 200, requestId: "request-offer-update", body: { id: 950 } };
    });

  return greenhouse;
}

function includesId(value: string | undefined, id: number): boolean {
  return value?.split(",").includes(String(id)) ?? false;
}

function keyedCustomFields(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) return {};
  return Object.fromEntries(value.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid custom field mutation.");
    const field = entry as { name_key?: unknown; value?: unknown };
    if (typeof field.name_key !== "string") throw new Error("Invalid custom field mutation.");
    return [field.name_key, { value: field.value }];
  }));
}

describe("the visibility fence, across every capability (Phase 2c Slices 3-4)", () => {
  test("preview denies TARGET_NOT_VISIBLE on a hidden target, for every action kind, before any read-back or write", async () => {
    for (const scenario of SCENARIOS) {
      const clock = new TestClock();
      const store = new MemoryActionStore(clock);
      const greenhouse = greenhouseFor(scenario.kind);
      const probe = probeReturning({ state: "hidden" });
      const service = serviceFor(store, greenhouse, clock, probe);
      await assert.rejects(service.preview(scenario.kind, scenario.preview), (error: unknown) =>
        error instanceof ActionDeniedError && error.code === "TARGET_NOT_VISIBLE", scenario.kind);
      assert.ok(probe.asked.length > 0, `${scenario.kind}: the fence must actually have been consulted`);
      assert.equal(store.records.size, 0, scenario.kind);
      assert.equal(greenhouse.mutationCalls.length, 0, scenario.kind);
    }
  });

  test("preview denies TARGET_UNAVAILABLE on an outage — a distinct code, so an outage never reads as a revoked grant", async () => {
    for (const scenario of SCENARIOS) {
      const clock = new TestClock();
      const store = new MemoryActionStore(clock);
      const greenhouse = greenhouseFor(scenario.kind);
      const service = serviceFor(store, greenhouse, clock, probeReturning({ state: "unavailable", reason: "permission lookup outage" }));
      await assert.rejects(service.preview(scenario.kind, scenario.preview), (error: unknown) =>
        error instanceof ActionDeniedError && error.code === "TARGET_UNAVAILABLE", scenario.kind);
      assert.equal(greenhouse.mutationCalls.length, 0, scenario.kind);
    }
  });

  test("a valid signed intent cannot satisfy the fence: visibility lost between preview and apply denies BEFORE the mutation", async () => {
    for (const scenario of SCENARIOS) {
      const clock = new TestClock();
      const store = new MemoryActionStore(clock);
      const greenhouse = greenhouseFor(scenario.kind);
      // Preview under full visibility: a genuine, correctly-signed intent.
      const previewService = serviceFor(store, greenhouse, clock, allowAllVisibility());
      const input = applyInput(await previewService.preview(scenario.kind, scenario.preview));
      // Apply under a probe that now hides the target — the same store, the same clock, the same
      // signing secret, so ONLY visibility changed.
      const applyService = serviceFor(store, greenhouse, clock, probeReturning({ state: "hidden" }));
      // Apply-preflight denials are RECORDED, not thrown: the fence denial becomes a failed ledger
      // row, which is stronger than an exception — the refusal itself is auditable.
      const result = await applyService.apply(scenario.kind, input);
      assert.equal(result.state, "failed", scenario.kind);
      assert.equal(result.error_code, "TARGET_NOT_VISIBLE", scenario.kind);
      assert.equal(greenhouse.mutationCalls.length, 0,
        `${scenario.kind}: the denial must land before the gateway ever sees a write`);
    }
  });

  test("REGRESSION LOCK: preview against a private candidate's application no longer returns their stage and status", async () => {
    // The named defect the fence closes — spec §2. Before this slice, preparation reached
    // assertJobAccess but no candidate-privacy gate, so a write-entitled recruiter could preview
    // against a private candidate and receive their stage and status in the delta. The probe below
    // is exactly what the read plane answers for a private candidate: get_application ran its
    // privacy gate and returned null.
    const clock = new TestClock();
    const store = new MemoryActionStore(clock);
    const greenhouse = greenhouseFor("application_stage_move");
    const service = serviceFor(store, greenhouse, clock, probeReturning({ state: "hidden" }));
    await assert.rejects(
      service.preview("application_stage_move", { application_id: 100, to_stage_id: 602 }),
      (error: unknown) => error instanceof ActionDeniedError && error.code === "TARGET_NOT_VISIBLE"
    );
  });

  test("a target that requires the unredacted view denies when the read plane redacts it", async () => {
    // job_note_change update reads the existing body; a redacted note is one whose body the read
    // plane withheld, and previewing a change to it would disclose exactly that body.
    const clock = new TestClock();
    const store = new MemoryActionStore(clock);
    const greenhouse = greenhouseFor("job_note_change");
    const redactedProbe = probeReturning({ state: "visible", redacted: true });
    const service = serviceFor(store, greenhouse, clock, redactedProbe);
    await assert.rejects(
      service.preview("job_note_change", { verb: "update", job_id: 200, note_id: 700, body: "new body" }),
      (error: unknown) => error instanceof ActionDeniedError && error.code === "TARGET_NOT_VISIBLE"
    );
    // And the same verdict does NOT deny an action whose targets tolerate redaction.
    const tolerant = serviceFor(new MemoryActionStore(clock), greenhouseFor("application_stage_move"), clock, redactedProbe);
    const preview = await tolerant.preview("application_stage_move", { application_id: 100, to_stage_id: 602 });
    assert.equal(preview.status, "ready", "redaction only denies where the target requires the unredacted view");
  });
});
