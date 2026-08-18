import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { actionDefinition } from "../src/actions/index.js";
import type { ActionRecord, GreenhouseRow, MutationPlan, PreparedAction } from "../src/types.js";
import { assignmentGreenhouse, RouteGreenhouse, TEST_SECRET, TestClock } from "./helpers.js";

const clock = new TestClock();

describe("action-specific variants", () => {
  test("coordinator assignment patches and observes only the selected assignment field", async () => {
    const { greenhouse, state } = assignmentGreenhouse();
    const definition = actionDefinition("application_assignment_change");
    const action = await definition.preparePreview({
      application_id: 100,
      assignment_role: "coordinator",
      proposed_user_id: 40,
    }, context(greenhouse));

    assert.deepEqual(action.approval, {
      application_id: 100,
      job_id: 200,
      assignment_role: "coordinator",
      current_user_id: 30,
      proposed_user_id: 40,
    });
    assert.match(String((action.preview as { effects: string[] }).effects[0]), /sibling/i);
    const plan = await definition.mutation(action.approval, action, context(greenhouse));
    assert.deepEqual(plan, { method: "PATCH", path: "/applications/100", body: { coordinator_id: 40 } });
    await execute(greenhouse, plan);
    state.application.recruiter_id = 99;
    assert.equal(await definition.observe(recordFor(action), context(greenhouse)), "desired_observed");
  });

  test("job-owner removal binds the exact row and preserves another role for the same user", async () => {
    let owners: GreenhouseRow[] = [
      { id: 901, job_id: 200, user_id: 40, type: "sourcer", responsible: false },
      { id: 902, job_id: 200, user_id: 40, type: "recruiter", responsible: false },
    ];
    const greenhouse = authorizedRoutes()
      .onList("/job_owners", () => owners)
      .onMutation("DELETE", "/job_owners/902", () => {
        owners = owners.filter((owner) => owner.id !== 902);
        return { status: 204, requestId: "owner-delete", body: null };
      });
    const definition = actionDefinition("job_owner_change");
    const action = await definition.preparePreview({
      verb: "remove",
      job_id: 200,
      user_id: 40,
      owner_type: "recruiter",
    }, context(greenhouse));

    assert.deepEqual(action.binding, {
      job_id: 200,
      user_id: 40,
      owner_type: "recruiter",
      verb: "remove",
      owner_row_id: 902,
    });
    assert.equal((action.preview as { target: { user_name: string } }).target.user_name, "Proposed User");
    const plan = await definition.mutation(action.approval, action, context(greenhouse));
    assert.deepEqual(plan, { method: "DELETE", path: "/job_owners/902" });
    await execute(greenhouse, plan);
    assert.deepEqual(owners.map(({ id, type }) => ({ id, type })), [{ id: 901, type: "sourcer" }]);
    assert.equal(await definition.observe(recordFor(action), context(greenhouse)), "desired_observed");
  });

  test("stage moves bind same-job IDs and refuse missing or cross-job destinations", async () => {
    const definition = actionDefinition("application_stage_move");
    const success = authorizedRoutes()
      .onList("/application_stages", () => [currentStage()])
      .onList("/job_interview_stages", () => [{ id: 602, job_id: 200, name: "Onsite", active: true, sort_order: 2 }]);
    const action = await definition.preparePreview({ application_id: 100, to_stage_id: 602 }, context(success));

    assert.equal(action.highImpact, true);
    assert.deepEqual(action.binding, {
      application_id: 100,
      from_application_stage_id: 501,
      from_interview_stage_id: 601,
      to_interview_stage_id: 602,
    });
    assert.deepEqual(await definition.mutation(action.approval, action, context(success)), {
      method: "POST",
      path: "/applications/100/move",
      body: { from_stage_id: 501, to_stage_id: 602 },
    });

    for (const [label, rows, message] of [
      ["wrong id", [{ id: 999, job_id: 200, name: "Other", active: true }], /not found uniquely/i],
      ["wrong job", [{ id: 602, job_id: 201, name: "Other job", active: true }], /not active on this application job/i],
    ] as const) {
      const greenhouse = authorizedRoutes()
        .onList("/application_stages", () => [currentStage()])
        .onList("/job_interview_stages", () => rows.map((row) => ({ ...row })));
      await assert.rejects(
        definition.preparePreview({ application_id: 100, to_stage_id: 602 }, context(greenhouse)),
        message,
        label,
      );
    }
  });

  test("rejection carries an optional internal note and never adds an email field", async () => {
    const definition = actionDefinition("application_rejection");
    for (const notes of [undefined, "Internal decision note"] as const) {
      const application = baseApplication();
      let details: GreenhouseRow[] = [];
      let rejectionNotes: GreenhouseRow[] = [];
      const greenhouse = authorizedRoutes(application)
        .onList("/application_stages", () => [currentStage()])
        .onList("/rejection_reasons", () => [{ id: 701, name: "Position closed", type: "rejection" }])
        .onList("/rejection_details", () => details)
        .onList("/notes", () => rejectionNotes)
        .onMutation("POST", "/applications/100/reject", (input) => {
          application.status = "rejected";
          application.stage_id = null;
          const noteId = notes === undefined ? null : 801;
          details = [{
            id: 800,
            application_id: 100,
            rejection_reason_id: 701,
            rejection_note_id: noteId,
            rejected_at: "2026-07-01T12:00:00.000Z",
            rejected_by_id: 10,
          }];
          rejectionNotes = noteId === null ? [] : [{ id: noteId, body: input.body?.notes }];
          return { status: 200, requestId: "reject", body: { id: 100 } };
        });
      const action = await definition.preparePreview({
        application_id: 100,
        rejection_reason_id: 701,
        ...(notes === undefined ? {} : { notes }),
      }, context(greenhouse));
      const plan = await definition.mutation(action.approval, action, context(greenhouse));

      assert.deepEqual(plan, {
        method: "POST",
        path: "/applications/100/reject",
        body: { rejection_reason_id: 701, ...(notes === undefined ? {} : { notes }) },
      });
      assert.equal(Object.hasOwn(plan.body ?? {}, "send_email"), false);
      assert.match((action.approval as { effects: string[] }).effects.join(" "), /without sending a candidate email/i);
      await execute(greenhouse, plan);
      assert.equal(await definition.observe(recordFor(action), context(greenhouse)), "desired_observed");
    }
  });

  test("unreject clears rejection references and observes the restored pre-rejection stage", async () => {
    const application: GreenhouseRow = { ...baseApplication(), status: "rejected", stage_id: null };
    let details: GreenhouseRow[] = [{
      id: 800,
      application_id: 100,
      rejection_reason_id: 701,
      rejection_note_id: 801,
      rejected_at: "2026-07-01T12:00:00.000Z",
      rejected_by_id: 10,
    }];
    let stages: GreenhouseRow[] = [{
      id: 501,
      application_id: 100,
      job_interview_stage_id: 601,
      current: false,
      entered_at: "2026-06-01T12:00:00.000Z",
      exited_at: "2026-07-01T12:00:00.000Z",
    }];
    const greenhouse = authorizedRoutes(application)
      .onList("/rejection_details", () => details)
      .onList("/notes", () => [{ id: 801, body: "Previous rejection note" }])
      .onList("/application_stages", () => stages)
      .onMutation("POST", "/applications/100/unreject", () => {
        application.status = "in_process";
        application.stage_id = 502;
        details = [];
        stages = [{
          id: 502,
          application_id: 100,
          job_interview_stage_id: 601,
          current: true,
          entered_at: "2026-07-02T12:00:00.000Z",
          exited_at: null,
        }];
        return { status: 200, requestId: "unreject", body: { id: 100 } };
      });
    const definition = actionDefinition("application_unreject");
    const action = await definition.preparePreview({ application_id: 100 }, context(greenhouse));

    assert.deepEqual((action.approval as { after: unknown }).after, {
      status: "in_process",
      interview_stage_id: 601,
      rejection_reason_id: null,
      rejection_note_id: null,
    });
    const plan = await definition.mutation(action.approval, action, context(greenhouse));
    assert.deepEqual(plan, { method: "POST", path: "/applications/100/unreject", body: {} });
    await execute(greenhouse, plan);
    assert.equal(await definition.observe(recordFor(action), context(greenhouse)), "desired_observed");
  });

  test("job-note create, update, and delete use exact mutations and observers", async () => {
    const definition = actionDefinition("job_note_change");

    {
      let notes: GreenhouseRow[] = [{
        id: 900, job_id: 200, user_id: 10, body: "Existing", visibility: "privately_visible",
      }];
      const greenhouse = jobNoteRoutes(() => notes)
        .onMutation("POST", "/job_notes", (input) => {
          notes = [...notes, { id: 901, ...input.body }];
          return { status: 201, requestId: "note-create", body: { id: 901 } };
        });
      const action = await definition.preparePreview({
        verb: "create", job_id: 200, body: "New note", visibility: "admin_only_visible",
      }, context(greenhouse));
      const plan = await definition.mutation(action.approval, action, context(greenhouse));
      assert.deepEqual(plan, {
        method: "POST",
        path: "/job_notes",
        body: { job_id: 200, user_id: 10, body: "New note", visibility: "admin_only_visible" },
      });
      const response = await execute(greenhouse, plan);
      assert.equal(await definition.observe(recordFor(action, resourceId(response.body)), context(greenhouse)), "desired_observed");
    }

    {
      let notes: GreenhouseRow[] = [{
        id: 902, job_id: 200, user_id: 40, body: "Old", visibility: "privately_visible",
      }];
      const greenhouse = jobNoteRoutes(() => notes)
        .onMutation("PATCH", "/job_notes/902", (input) => {
          notes = [{ ...notes[0], ...input.body }];
          return { status: 200, requestId: "note-update", body: { id: 902 } };
        });
      const action = await definition.preparePreview({
        verb: "update",
        job_id: 200,
        note_id: 902,
        body: "Updated",
        visibility: "admin_only_visible",
      }, context(greenhouse));
      const plan = await definition.mutation(action.approval, action, context(greenhouse));
      assert.deepEqual(plan, {
        method: "PATCH",
        path: "/job_notes/902",
        body: { body: "Updated", visibility: "admin_only_visible" },
      });
      await execute(greenhouse, plan);
      const record = recordFor(action);
      assert.equal(await definition.observe(record, context(greenhouse)), "desired_observed");
      notes = [];
      assert.equal(await definition.observe(record, context(greenhouse)), "conflict");
    }

    {
      let notes: GreenhouseRow[] = [{
        id: 903, job_id: 200, user_id: 40, body: "Delete me", visibility: "privately_visible",
      }];
      const greenhouse = jobNoteRoutes(() => notes)
        .onMutation("DELETE", "/job_notes/903", () => {
          notes = [];
          return { status: 204, requestId: "note-delete", body: null };
        });
      const action = await definition.preparePreview({ verb: "delete", job_id: 200, note_id: 903 }, context(greenhouse));
      const plan = await definition.mutation(action.approval, action, context(greenhouse));
      assert.deepEqual(plan, { method: "DELETE", path: "/job_notes/903" });
      await execute(greenhouse, plan);
      assert.equal(await definition.observe(recordFor(action), context(greenhouse)), "desired_observed");
    }
  });

  test("attribution supports referrer-only, both fields, and no-op without treating referrers as users", async () => {
    const definition = actionDefinition("application_attribution_change");
    const cases = [
      {
        name: "referrer only",
        input: { application_id: 100, referrer_id: 701 },
        before: { referrer_id: 700 },
        after: { referrer_id: 701 },
        body: { referrer_id: 701 },
        changeRequired: true,
      },
      {
        name: "both fields",
        input: { application_id: 100, source_id: 601, referrer_id: 701 },
        before: { source_id: 600, referrer_id: 700 },
        after: { source_id: 601, referrer_id: 701 },
        body: { source_id: 601, referrer_id: 701 },
        changeRequired: true,
      },
      {
        name: "no-op",
        input: { application_id: 100, referrer_id: 700 },
        before: { referrer_id: 700 },
        after: { referrer_id: 700 },
        body: { referrer_id: 700 },
        changeRequired: false,
      },
    ] as const;

    for (const variant of cases) {
      const application = baseApplication();
      const greenhouse = authorizedRoutes(application)
        .onList("/sources", (params) => [
          { id: 600, name: "Current source", type: "prospecting" },
          { id: 601, name: "New source", type: "prospecting" },
        ].filter((row) => String(row.id) === params.ids))
        .onList("/referrers", (params) => [
          { id: 700, name: "Current referrer", user_id: 70 },
          { id: 701, name: "New referrer", user_id: 71 },
        ].filter((row) => String(row.id) === params.ids));
      const action = await definition.preparePreview(variant.input, context(greenhouse));
      const approval = action.approval as { before: unknown; after: unknown };

      assert.deepEqual(approval.before, variant.before, variant.name);
      assert.deepEqual(approval.after, variant.after, variant.name);
      assert.equal(action.changeRequired, variant.changeRequired, variant.name);
      assert.deepEqual(await definition.mutation(action.approval, action, context(greenhouse)), {
        method: "PATCH", path: "/applications/100", body: variant.body,
      }, variant.name);
      assert.equal(
        greenhouse.listCalls.some((call) => call.path === "/users" && call.params.ids !== "10"),
        false,
        `${variant.name}: referrer IDs must not be looked up as users`,
      );
      if (Object.hasOwn(variant.input, "referrer_id")) {
        assert.equal(greenhouse.listCalls.some((call) => call.path === "/referrers"), true, variant.name);
      }

      if (variant.changeRequired) {
        const body = variant.body as { source_id?: number; referrer_id?: number };
        if (body.source_id !== undefined) application.source_id = body.source_id;
        if (body.referrer_id !== undefined) application.referrer_id = body.referrer_id;
        if (body.source_id === undefined) application.source_id = 999;
        assert.equal(await definition.observe(recordFor(action), context(greenhouse)), "desired_observed", variant.name);
      }
    }
  });

  test("candidate collection writes preserve retained values and exclude privacy flags", async () => {
    const candidate: GreenhouseRow = {
      id: 300,
      first_name: "A",
      last_name: "Person",
      preferred_name: null,
      company: null,
      title: "Engineer",
      time_zone: "UTC",
      phone_numbers: [{ value: "555-0100", type: "work" }],
      addresses: [],
      email_addresses: [],
      website_addresses: [],
      social_media_addresses: [],
      tags: ["keep", "remove"],
      linked_user_ids: [],
      custom_fields: {},
      is_private: true,
      can_email: false,
    };
    const greenhouse = authorizedRoutes().onList("/candidates", () => [candidate]);
    const definition = actionDefinition("candidate_record_update");
    const action = await definition.preparePreview({
      context_application_id: 100,
      changes: { tags: { remove: ["remove"], add: ["new"] } },
    }, context(greenhouse));

    assert.deepEqual((action.approval as { before: { tags: string[] }; after: { tags: string[] } }).before.tags, ["keep", "remove"]);
    assert.deepEqual((action.approval as { after: { tags: string[] } }).after.tags, ["keep", "new"]);
    assert.deepEqual(await definition.mutation(action.approval, action, context(greenhouse)), {
      method: "PATCH",
      path: "/candidates/300",
      body: { tags: ["keep", "new"] },
    });
    for (const field of ["is_private", "can_email"] as const) {
      assert.equal(definition.previewSchema.safeParse({
        context_application_id: 100,
        changes: { [field]: true },
      }).success, false, field);
    }
  });

  test("offer-create observer distinguishes the desired offer from conflicting content", async () => {
    let offers: GreenhouseRow[] = [];
    const greenhouse = authorizedRoutes()
      .onList("/offers", () => offers)
      .onList("/custom_fields", () => [])
      .onMutation("POST", "/offers", () => {
        offers = [{
          id: 950,
          version: 1,
          application_id: 100,
          job_id: 200,
          candidate_id: 300,
          status: "Created",
          starts_on: "2026-08-01T00:00:00.000Z",
          custom_fields: {},
        }];
        return { status: 201, requestId: "offer-create", body: { id: 950 } };
      });
    const definition = actionDefinition("offer_create");
    const action = await definition.preparePreview({ application_id: 100, starts_on: "2026-08-01" }, context(greenhouse));
    const plan = await definition.mutation(action.approval, action, context(greenhouse));
    assert.deepEqual(plan, {
      method: "POST", path: "/offers", body: { application_id: 100, starts_on: "2026-08-01" },
    });
    const response = await execute(greenhouse, plan);
    const record = recordFor(action, resourceId(response.body));
    assert.equal(await definition.observe(record, context(greenhouse)), "desired_observed");
    offers[0]!.starts_on = "2026-09-01T00:00:00.000Z";
    assert.equal(await definition.observe(record, context(greenhouse)), "conflict");
  });

  test("offer update requires the current row and treats currency/version changes as high impact", async () => {
    const definition = actionDefinition("offer_update");
    const missing = authorizedRoutes()
      .onList("/offers", () => [])
      .onList("/custom_fields", () => []);
    await assert.rejects(
      definition.preparePreview({ application_id: 100, offer_id: 950, starts_on: "2026-09-01" }, context(missing)),
      /current offer was not found uniquely/i,
    );

    let offers: GreenhouseRow[] = [{
      id: 950,
      version: 2,
      application_id: 100,
      job_id: 200,
      candidate_id: 300,
      status: "Created",
      starts_on: "2026-08-01T00:00:00.000Z",
      custom_fields: { salary: { value: { amount: 100_000, currency_code: "USD" } } },
    }];
    const greenhouse = authorizedRoutes()
      .onList("/offers", () => offers)
      .onList("/custom_fields", () => [{
        id: 1,
        name_key: "salary",
        value_type: "currency",
        trigger_new_version: true,
        active: true,
        field_type: "offer",
      }])
      .onMutation("PATCH", "/offers/950", () => {
        offers = [{
          ...offers[0],
          id: 951,
          version: 3,
          custom_fields: { salary: { value: { amount: 125_000, currency_code: "USD" } } },
        }];
        return { status: 200, requestId: "offer-update", body: { id: 951 } };
      });
    await assert.rejects(
      definition.preparePreview({ application_id: 100, offer_id: 949, starts_on: "2026-09-01" }, context(greenhouse)),
      /no longer the current offer/i,
    );
    const action = await definition.preparePreview({
      application_id: 100,
      offer_id: 950,
      custom_fields: [{ name_key: "salary", value: { amount: 125_000, currency_code: "USD" } }],
    }, context(greenhouse));

    assert.equal((action.approval as { before: { version: number } }).before.version, 2);
    assert.equal(action.highImpact, true);
    const plan = await definition.mutation(action.approval, action, context(greenhouse));
    assert.deepEqual(plan, {
      method: "PATCH",
      path: "/offers/950",
      body: { custom_fields: [{ name_key: "salary", value: { amount: 125_000, currency_code: "USD" } }] },
    });
    await execute(greenhouse, plan);
    const record = recordFor(action);
    assert.equal(await definition.observe(record, context(greenhouse)), "desired_observed");
    offers = [];
    assert.equal(await definition.observe(record, context(greenhouse)), "unavailable");
  });
});

function context(greenhouse: RouteGreenhouse) {
  return { actorUserId: 10, greenhouse, signingSecret: TEST_SECRET, clock };
}

function baseApplication(): GreenhouseRow {
  return {
    id: 100,
    candidate_id: 300,
    job_id: 200,
    recruiter_id: 20,
    coordinator_id: 30,
    stage_id: 501,
    status: "in_process",
    source_id: 600,
    referrer_id: 700,
  };
}

function currentStage(): GreenhouseRow {
  return {
    id: 501,
    application_id: 100,
    job_interview_stage_id: 601,
    current: true,
    entered_at: "2026-06-01T12:00:00.000Z",
    exited_at: null,
  };
}

function authorizedRoutes(application = baseApplication()): RouteGreenhouse {
  const users = new Map<number, GreenhouseRow>([
    [10, { id: 10, name: "Actor", deactivated: false, site_admin: false }],
    [20, { id: 20, name: "Current Recruiter", deactivated: false, site_admin: false }],
    [30, { id: 30, name: "Current Coordinator", deactivated: false, site_admin: false }],
    [40, { id: 40, name: "Proposed User", deactivated: false, site_admin: false }],
  ]);
  return new RouteGreenhouse()
    .onList("/applications", (params) => params.ids === String(application.id) ? [application] : [])
    .onList("/users", (params) => String(params.ids).split(",").flatMap((raw) => {
      const row = users.get(Number(raw));
      return row ? [row] : [];
    }))
    .onList("/jobs", (params) => params.ids === "200" ? [{ id: 200, confidential: false }] : [])
    .onList("/user_job_permissions", (params) => [{
      id: 900,
      user_id: Number(params.user_ids),
      job_id: Number(params.job_ids),
      role_id: 1,
      automated: false,
    }]);
}

function jobNoteRoutes(notes: () => GreenhouseRow[]): RouteGreenhouse {
  return authorizedRoutes().onList("/job_notes", (params) => {
    if (params.ids !== undefined) return notes().filter((note) => String(note.id) === params.ids);
    return notes().filter((note) => String(note.job_id) === params.job_ids);
  });
}

function execute(greenhouse: RouteGreenhouse, plan: MutationPlan) {
  return greenhouse.mutate({ ...plan, actorUserId: 10 });
}

function recordFor(action: PreparedAction, upstreamResourceId: number | null = null): ActionRecord {
  return {
    actionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    actionKind: action.actionKind,
    lockKey: action.lockKey,
    scopeJobId: action.scopeJobId,
    binding: structuredClone(action.binding),
    identityId: "11111111-1111-4111-8111-111111111111",
    actorUserId: 10,
    subjectFingerprint: "A".repeat(43),
    sessionFingerprint: "B".repeat(43),
    client: "test",
    currentFingerprint: action.currentFingerprint,
    desiredFingerprint: action.desiredFingerprint,
    approvalFingerprint: action.approvalFingerprint,
    highImpact: action.highImpact,
    intentExpiresAt: "2026-08-01T00:05:00.000Z",
    notAppliedBefore: "2026-08-01T00:05:00.000Z",
    status: "unknown",
    phase: "mutation_sent",
    ownerToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    leaseExpiresAt: "2026-08-01T00:02:00.000Z",
    observation: null,
    errorCode: null,
    upstreamStatus: null,
    upstreamRequestId: null,
    upstreamResourceId,
    firstOriginalObservationAt: null,
    resolutionSource: null,
    resolvedByFingerprint: null,
    completedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function resourceId(body: unknown): number {
  assert.ok(body !== null && typeof body === "object" && "id" in body && typeof body.id === "number");
  return body.id;
}
