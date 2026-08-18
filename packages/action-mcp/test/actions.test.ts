import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { actionDefinition } from "../src/actions/index.js";
import { buildCompleteCandidateCustomFields, validateCustomFields } from "../src/custom-fields.js";
import { fingerprintValue, issueActionIntent } from "../src/crypto.js";
import type {
  ActionBinding,
  ActionKind,
  ActionRecord,
  MutationPlan,
  PreparedAction,
} from "../src/types.js";
import { IDENTITY_ID, RouteGreenhouse, TEST_SECRET, TestClock, testSession } from "./helpers.js";

const clock = new TestClock();
const emptyGreenhouse = new RouteGreenhouse();
const context = { actorUserId: 10, greenhouse: emptyGreenhouse, signingSecret: TEST_SECRET, clock };

const WIRE_CASES: ReadonlyArray<{
  kind: ActionKind;
  binding: ActionBinding;
  approval: Record<string, unknown>;
  expected: MutationPlan;
}> = [
  {
    kind: "application_assignment_change",
    binding: { application_id: 100, assignment_role: "recruiter", previous_user_id: 20, proposed_user_id: 40 },
    approval: { application_id: 100, job_id: 200, assignment_role: "recruiter", current_user_id: 20, proposed_user_id: 40 },
    expected: { method: "PATCH", path: "/applications/100", body: { recruiter_id: 40 } },
  },
  {
    kind: "job_owner_change",
    binding: { job_id: 200, user_id: 40, owner_type: "sourcer", verb: "add", owner_row_id: null },
    approval: {
      target: { job_id: 200, user_id: 40, owner_type: "sourcer", verb: "add" },
      before: { present: false, owner_row_id: null }, after: { present: true }, effects: ["Add exact tuple."],
    },
    expected: { method: "POST", path: "/job_owners", body: { job_id: 200, user_id: 40, type: "sourcer" } },
  },
  {
    kind: "application_stage_move",
    binding: {
      application_id: 100,
      from_application_stage_id: 501,
      from_interview_stage_id: 601,
      to_interview_stage_id: 602,
    },
    approval: {
      target: { application_id: 100, job_id: 200 },
      before: { application_stage_id: 501, interview_stage_id: 601 },
      after: { interview_stage_id: 602, stage_name: "Onsite" }, effects: ["May run transition rules."],
    },
    expected: { method: "POST", path: "/applications/100/move", body: { from_stage_id: 501, to_stage_id: 602 } },
  },
  {
    kind: "application_rejection",
    binding: { application_id: 100, rejection_reason_id: 701, previous_interview_stage_id: 601, has_notes: true },
    approval: {
      target: { application_id: 100, job_id: 200 },
      before: { status: "in_process", interview_stage_id: 601 },
      after: { status: "rejected", rejection_reason_id: 701, reason_name: "Position closed", notes: "Internal note" },
      effects: ["No candidate email."],
    },
    expected: {
      method: "POST", path: "/applications/100/reject",
      body: { rejection_reason_id: 701, notes: "Internal note" },
    },
  },
  {
    kind: "application_unreject",
    binding: { application_id: 100, previous_interview_stage_id: 601 },
    approval: {
      target: { application_id: 100, job_id: 200 },
      before: { status: "rejected", rejection_reason_id: 701, rejection_note_id: null },
      after: { status: "in_process", interview_stage_id: 601 }, effects: ["Restore prior stage."],
    },
    expected: { method: "POST", path: "/applications/100/unreject", body: {} },
  },
  {
    kind: "candidate_note_create",
    binding: {
      application_id: 100, candidate_id: 300, note_type: "NOTE", visibility: "private",
      baseline_count: 1, baseline_fingerprint: "A".repeat(43),
    },
    approval: {
      target: { application_id: 100, candidate_id: 300, job_id: 200, author_user_id: 10 },
      before: { identical_note_ids: [901], additional_identical_note_count: 0 },
      after: { body: "Follow up", visibility: "private", note_type: "NOTE" }, effects: ["Creates a new note."],
    },
    expected: {
      method: "POST", path: "/notes",
      body: { candidate_id: 300, application_id: 100, body: "Follow up", visibility: "private", note_type: "NOTE", user_id: 10 },
    },
  },
  {
    kind: "job_note_change",
    binding: {
      job_id: 200, verb: "update", note_id: 902, visibility: "privately_visible",
      baseline_count: 0, baseline_fingerprint: "A".repeat(43),
    },
    approval: {
      target: { job_id: 200, note_id: 902, verb: "update" },
      before: { exists: true, body: "Old", visibility: "privately_visible", author_user_id: 10 },
      after: { exists: true, body: "New", visibility: "privately_visible" }, effects: ["Updates body."],
    },
    expected: { method: "PATCH", path: "/job_notes/902", body: { body: "New" } },
  },
  {
    kind: "application_attribution_change",
    binding: { application_id: 100, source_id: 801, referrer_id: 802, touches_source: true, touches_referrer: false },
    approval: {
      target: { application_id: 100, job_id: 200 }, before: { source_id: 800, referrer_id: 802 },
      after: { source_id: 801, referrer_id: 802 }, changed_fields: ["source_id"], effects: ["Changes attribution."],
    },
    expected: { method: "PATCH", path: "/applications/100", body: { source_id: 801 } },
  },
  {
    kind: "candidate_record_update",
    binding: { candidate_id: 300, context_application_id: 100, fields: ["tags"] },
    approval: {
      target: { context_application_id: 100, candidate_id: 300, job_id: 200 }, changed_fields: ["tags"],
      before: { tags: ["existing"] }, after: { tags: ["existing", "new"] }, effects: ["Complete displayed array."],
    },
    expected: { method: "PATCH", path: "/candidates/300", body: { tags: ["existing", "new"] } },
  },
  {
    kind: "offer_create",
    binding: { application_id: 100, fields: ["starts_on"], baseline_ids: [], has_currency: false },
    approval: {
      target: { application_id: 100, job_id: 200 }, before: { offer_ids: [] },
      after: { starts_on: "2026-08-01", custom_fields: [] }, included_fields: ["starts_on"],
      effects: ["Approval flows attach."],
    },
    expected: { method: "POST", path: "/offers", body: { application_id: 100, starts_on: "2026-08-01" } },
  },
  {
    kind: "offer_update",
    binding: { application_id: 100, offer_id: 950, version: 1, fields: ["starts_on"], has_currency: false },
    approval: {
      target: { application_id: 100, job_id: 200, offer_id: 950 },
      before: { offer_id: 950, version: 1, status: "Created", values: { starts_on: "2026-08-01" } },
      after: { values: { starts_on: "2026-09-01" } }, changed_fields: ["starts_on"], effects: ["May create version."],
    },
    expected: { method: "PATCH", path: "/offers/950", body: { starts_on: "2026-09-01" } },
  },
];

describe("action endpoint contracts", () => {
  test("all 11 capabilities emit only their fixed method, path, and body", async () => {
    assert.equal(WIRE_CASES.length, 11);
    assert.equal(new Set(WIRE_CASES.map(({ kind }) => kind)).size, 11);
    for (const wire of WIRE_CASES) {
      const plan = await actionDefinition(wire.kind).mutation(wire.approval, prepared(wire.kind, wire.binding), context);
      assert.deepEqual(plan, wire.expected, wire.kind);
    }
  });

  test("job-note removal is a permanent exact-row DELETE", async () => {
    const definition = actionDefinition("job_note_change");
    const binding: ActionBinding = {
      job_id: 200, verb: "delete", note_id: 902, visibility: null,
      baseline_count: 0, baseline_fingerprint: "A".repeat(43),
    };
    const approval = {
      target: { job_id: 200, note_id: 902, verb: "delete" },
      before: { exists: true, body: "Old", visibility: "privately_visible", author_user_id: 10 },
      after: { exists: false, body: null, visibility: null }, effects: ["Permanently deletes this exact job note."],
    };
    assert.deepEqual(await definition.mutation(approval, prepared(definition.kind, binding), context), {
      method: "DELETE", path: "/job_notes/902",
    });
  });
});

describe("action-specific reconciliation and normalization", () => {
  test("unreject resolves the prior stage against the LIVE tenant stage shape", async () => {
    // Measured read-only against the real tenant 2026-07-27, 40 rejected applications, 40/40:
    //   - rejection does NOT clear the stage — exactly one row keeps `current: true`
    //   - that row's `id` is exactly the application's `stage_id`
    //   - `entered_at` is populated on THAT row and null on the scaffolding rows for the job's other
    //     stages, which is the precise form of the "entered_at is null" finding (L3)
    //   - the shipped filter therefore resolves, and its sort picks the current row every time
    //
    // The production-readiness audit called this capability dead on exactly that L3 finding. It is
    // not: the one row unreject needs is the one row that carries the timestamp. The old fixture
    // below had the shape INVERTED — entered_at on a non-current row — so it proved the code worked
    // on data this tenant never produces. This fixture is the live shape; revert the filter to
    // require a non-current row and it fails.
    const greenhouse = authorizedRoutes()
      .onList("/applications", () => [{
        id: 100, candidate_id: 300, job_id: 200, recruiter_id: 20, coordinator_id: 30,
        stage_id: 501, status: "rejected", source_id: 600, referrer_id: 700,
      }])
      .onList("/rejection_details", () => [{
        id: 800, application_id: 100, rejection_reason_id: 701, rejection_note_id: null,
        rejected_at: "2026-07-01T12:00:00.400Z", rejected_by_id: 10,
      }])
      .onList("/application_stages", () => [
        // Scaffolding: every other stage on the job exists as a row, with no timestamps at all.
        { id: 502, application_id: 100, job_interview_stage_id: 602, current: false, entered_at: null, exited_at: null },
        { id: 503, application_id: 100, job_interview_stage_id: 603, current: false, entered_at: null, exited_at: null },
        // The current row — id matches the application's stage_id, and it alone is timestamped.
        { id: 501, application_id: 100, job_interview_stage_id: 601, current: true,
          entered_at: "2026-07-01T12:00:00.010Z", exited_at: "2026-07-01T12:00:00.404Z" },
      ]);

    const action = await actionDefinition("application_unreject").preparePreview({ application_id: 100 }, {
      actorUserId: 10, greenhouse, signingSecret: TEST_SECRET, clock,
    });

    assert.deepEqual(
      action.binding,
      { application_id: 100, previous_interview_stage_id: 601 },
      "the restored stage must be the one the application was actually in when it was rejected"
    );
  });

  test("unreject resolves the prior stage when a rejected application has no current stage", async () => {
    const greenhouse = authorizedRoutes()
      .onList("/applications", () => [{
        id: 100, candidate_id: 300, job_id: 200, recruiter_id: 20, coordinator_id: 30,
        stage_id: null, status: "rejected", source_id: 600, referrer_id: 700,
      }])
      .onList("/rejection_details", () => [{
        id: 800, application_id: 100, rejection_reason_id: 701, rejection_note_id: null,
        rejected_at: "2026-07-01T12:00:00.000Z", rejected_by_id: 10,
      }])
      .onList("/application_stages", () => [{
        id: 501, application_id: 100, job_interview_stage_id: 601, current: false,
        entered_at: "2026-06-01T12:00:00.000Z", exited_at: "2026-07-01T12:00:00.000Z",
      }]);

    const action = await actionDefinition("application_unreject").preparePreview({ application_id: 100 }, {
      actorUserId: 10, greenhouse, signingSecret: TEST_SECRET, clock,
    });

    assert.deepEqual(action.binding, { application_id: 100, previous_interview_stage_id: 601 });
    assert.deepEqual((action.approval as { after: unknown }).after, {
      status: "in_process", interview_stage_id: 601,
      rejection_reason_id: null, rejection_note_id: null,
    });
    const original = {
      ...actionRecord("application_unreject", action.binding, action.desiredFingerprint),
      currentFingerprint: action.currentFingerprint,
    };
    assert.equal(await actionDefinition("application_unreject").observe(original, {
      actorUserId: 10, greenhouse, signingSecret: TEST_SECRET, clock,
    }), "not_observed");
  });

  test("reject and unreject treat cross-endpoint propagation lag as unavailable", async () => {
    const rejectedWithoutDetails = new RouteGreenhouse()
      .onList("/applications", () => [{
        id: 100, candidate_id: 300, job_id: 200, recruiter_id: 20, coordinator_id: 30,
        stage_id: null, status: "rejected", source_id: 600, referrer_id: 700,
      }])
      .onList("/rejection_details", () => []);
    const rejectionBinding: ActionBinding = {
      application_id: 100, rejection_reason_id: 701, previous_interview_stage_id: 601, has_notes: false,
    };
    assert.equal(await actionDefinition("application_rejection").observe(
      actionRecord("application_rejection", rejectionBinding, "A".repeat(43)),
      { actorUserId: 10, greenhouse: rejectedWithoutDetails, signingSecret: TEST_SECRET, clock },
    ), "unavailable");

    const inProcessWithDetails = new RouteGreenhouse()
      .onList("/applications", () => [{
        id: 100, candidate_id: 300, job_id: 200, recruiter_id: 20, coordinator_id: 30,
        stage_id: 501, status: "in_process", source_id: 600, referrer_id: 700,
      }])
      .onList("/rejection_details", () => [{
        id: 800, application_id: 100, rejection_reason_id: 701, rejection_note_id: null,
      }]);
    const unrejectBinding: ActionBinding = { application_id: 100, previous_interview_stage_id: 601 };
    assert.equal(await actionDefinition("application_unreject").observe(
      actionRecord("application_unreject", unrejectBinding, "A".repeat(43)),
      { actorUserId: 10, greenhouse: inProcessWithDetails, signingSecret: TEST_SECRET, clock },
    ), "unavailable");

    const rejectedBeforeLinkedNote = new RouteGreenhouse()
      .onList("/applications", () => [{
        id: 100, candidate_id: 300, job_id: 200, recruiter_id: 20, coordinator_id: 30,
        stage_id: null, status: "rejected", source_id: 600, referrer_id: 700,
      }])
      .onList("/rejection_details", () => [{
        id: 800, application_id: 100, rejection_reason_id: 701, rejection_note_id: null,
      }]);
    const rejectionWithNote: ActionBinding = {
      application_id: 100, rejection_reason_id: 701, previous_interview_stage_id: 601, has_notes: true,
    };
    assert.equal(await actionDefinition("application_rejection").observe(
      actionRecord("application_rejection", rejectionWithNote, "A".repeat(43)),
      { actorUserId: 10, greenhouse: rejectedBeforeLinkedNote, signingSecret: TEST_SECRET, clock },
    ), "unavailable");

    const mismatchedStageEndpoints = new RouteGreenhouse()
      .onList("/applications", () => [{
        id: 100, candidate_id: 300, job_id: 200, recruiter_id: 20, coordinator_id: 30,
        stage_id: 501, status: "in_process", source_id: 600, referrer_id: 700,
      }])
      .onList("/application_stages", () => [{
        id: 502, application_id: 100, job_interview_stage_id: 602, current: true,
      }])
      .onList("/rejection_details", () => []);
    const stageBinding: ActionBinding = {
      application_id: 100,
      from_application_stage_id: 501,
      from_interview_stage_id: 601,
      to_interview_stage_id: 602,
    };
    const stageDesired = fingerprintValue("application-stage-move-desired", {
      status: "in_process", interview_stage_id: 602,
    }, TEST_SECRET);
    assert.equal(await actionDefinition("application_stage_move").observe(
      actionRecord("application_stage_move", stageBinding, stageDesired),
      { actorUserId: 10, greenhouse: mismatchedStageEndpoints, signingSecret: TEST_SECRET, clock },
    ), "unavailable");
    assert.equal(await actionDefinition("application_unreject").observe(
      actionRecord("application_unreject", { application_id: 100, previous_interview_stage_id: 602 }, "A".repeat(43)),
      { actorUserId: 10, greenhouse: mismatchedStageEndpoints, signingSecret: TEST_SECRET, clock },
    ), "unavailable");
  });

  test("attribution reconciliation ignores an untouched sibling field", async () => {
    let application = {
      id: 100, candidate_id: 300, job_id: 200, recruiter_id: 20, coordinator_id: 30,
      stage_id: 501, status: "in_process", source_id: 600, referrer_id: 700,
    };
    const greenhouse = authorizedRoutes()
      .onList("/applications", () => [application])
      .onList("/sources", (params) => [{
        id: Number(params.ids), name: params.ids === "601" ? "Referral" : "Original", type: "Custom",
      }]);
    const definition = actionDefinition("application_attribution_change");
    const action = await definition.preparePreview({ application_id: 100, source_id: 601 }, {
      actorUserId: 10, greenhouse, signingSecret: TEST_SECRET, clock,
    });
    assert.deepEqual((action.approval as { before: unknown; after: unknown }).before, { source_id: 600 });
    assert.deepEqual((action.approval as { before: unknown; after: unknown }).after, { source_id: 601 });
    application = { ...application, referrer_id: 701 };
    const fresh = await definition.prepareApply(action.approval, {
      actorUserId: 10, greenhouse, signingSecret: TEST_SECRET, clock,
    });
    assert.equal(fresh.currentFingerprint, action.currentFingerprint);
    assert.equal(fresh.desiredFingerprint, action.desiredFingerprint);
    assert.equal(fresh.approvalFingerprint, action.approvalFingerprint);
    application = { ...application, source_id: 601, referrer_id: 701 };
    const record = {
      ...actionRecord("application_attribution_change", action.binding, action.desiredFingerprint),
      currentFingerprint: action.currentFingerprint,
    };
    assert.equal(await definition.observe(record, {
      actorUserId: 10, greenhouse, signingSecret: TEST_SECRET, clock,
    }), "desired_observed");
  });

  test("job-owner reconciliation scopes to one tuple and refuses candidate-responsible removal", async () => {
    let owners = [{ id: 900, job_id: 200, user_id: 50, type: "recruiter", responsible: false }];
    const greenhouse = authorizedRoutes()
      .onList("/users", (params) => params.ids === "40"
        ? [{ id: 40, name: "Owner", deactivated: false, site_admin: false }]
        : [{ id: 10, name: "Actor", deactivated: false, site_admin: false }])
      .onList("/user_job_permissions", (params) => [{
        id: params.user_ids === "40" ? 2 : 1,
        user_id: Number(params.user_ids), job_id: 200, role_id: 1, automated: false,
      }])
      .onList("/job_owners", () => owners);
    const definition = actionDefinition("job_owner_change");
    const action = await definition.preparePreview({ verb: "add", job_id: 200, user_id: 40, owner_type: "sourcer" }, {
      actorUserId: 10, greenhouse, signingSecret: TEST_SECRET, clock,
    });
    assert.equal((action.preview as { target: { user_name: string } }).target.user_name, "Owner");
    assert.equal(Object.hasOwn((action.approval as { target: object }).target, "user_name"), false);
    owners = [
      ...owners,
      { id: 901, job_id: 200, user_id: 40, type: "sourcer", responsible: false },
      { id: 902, job_id: 200, user_id: 60, type: "coordinator", responsible: false },
    ];
    const record = {
      ...actionRecord("job_owner_change", action.binding, action.desiredFingerprint),
      currentFingerprint: action.currentFingerprint,
    };
    assert.equal(await definition.observe(record, {
      actorUserId: 10, greenhouse, signingSecret: TEST_SECRET, clock,
    }), "desired_observed");

    const responsible = authorizedRoutes().onList("/job_owners", () => [{
      id: 903, job_id: 200, user_id: 40, type: "recruiter", responsible: true,
    }]);
    await assert.rejects(definition.preparePreview({
      verb: "remove", job_id: 200, user_id: 40, owner_type: "recruiter",
    }, { actorUserId: 10, greenhouse: responsible, signingSecret: TEST_SECRET, clock }), /Candidate-responsible/);

    let sourcerOwners = [{ id: 904, job_id: 200, user_id: 40, type: "sourcer" }];
    const sourcer = authorizedRoutes()
      .onList("/users", (params) => params.ids === "40"
        ? [{ id: 40, name: "Former owner", deactivated: true, site_admin: false }]
        : [{ id: 10, name: "Actor", deactivated: false, site_admin: false }])
      .onList("/job_owners", () => sourcerOwners);
    const removal = await definition.preparePreview({
      verb: "remove", job_id: 200, user_id: 40, owner_type: "sourcer",
    }, { actorUserId: 10, greenhouse: sourcer, signingSecret: TEST_SECRET, clock });
    assert.equal(removal.changeRequired, true);
    sourcerOwners = [{ id: 905, job_id: 200, user_id: 40, type: "sourcer" }];
    const replaced = {
      ...actionRecord("job_owner_change", removal.binding, removal.desiredFingerprint),
      currentFingerprint: removal.currentFingerprint,
    };
    assert.equal(await definition.observe(replaced, {
      actorUserId: 10, greenhouse: sourcer, signingSecret: TEST_SECRET, clock,
    }), "conflict");
  });

  test("missing update targets are never classified as the signed original state", async () => {
    const missingJobNote = new RouteGreenhouse().onList("/job_notes", () => []);
    const jobNoteBinding: ActionBinding = {
      job_id: 200, verb: "update", note_id: 902, visibility: "privately_visible",
      baseline_count: 0, baseline_fingerprint: jobNoteBaseline([]),
    };
    assert.equal(await actionDefinition("job_note_change").observe(
      actionRecord("job_note_change", jobNoteBinding, "A".repeat(43)),
      { actorUserId: 10, greenhouse: missingJobNote, signingSecret: TEST_SECRET, clock },
    ), "conflict");

    const missingOffer = new RouteGreenhouse().onList("/offers", () => []);
    const offerBinding: ActionBinding = {
      application_id: 100, offer_id: 950, version: 1, fields: ["starts_on"], has_currency: false,
    };
    assert.equal(await actionDefinition("offer_update").observe(
      actionRecord("offer_update", offerBinding, "A".repeat(43)),
      { actorUserId: 10, greenhouse: missingOffer, signingSecret: TEST_SECRET, clock },
    ), "unavailable");
  });

  test("an identical candidate note is a new success only when its ID is outside the signed baseline", async () => {
    const greenhouse = new RouteGreenhouse();
    const note = { candidate_id: 300, application_id: 100, user_id: 10, type: "NOTE", visibility: "privately_visible", body: "Same" };
    greenhouse.onList("/notes", () => [{ id: 901, ...note }, { id: 902, ...note }]);
    const binding: ActionBinding = {
      application_id: 100, candidate_id: 300, note_type: "NOTE", visibility: "private",
      baseline_count: 1, baseline_fingerprint: candidateNoteBaseline([901]),
    };
    const desired = { candidate_id: 300, application_id: 100, user_id: 10, note_type: "NOTE", visibility: "private", body: "Same" };
    const record = actionRecord("candidate_note_create", binding,
      fingerprintValue("candidate-note-create-desired", desired, TEST_SECRET));
    assert.equal(await actionDefinition("candidate_note_create").observe(record, {
      actorUserId: 10, greenhouse, signingSecret: TEST_SECRET, clock,
    }), "desired_observed");
  });

  test("note-create baselines remain compact beyond 200 existing rows", async () => {
    const candidateNotes = Array.from({ length: 250 }, (_, index) => ({
      id: 1_000 + index,
      candidate_id: 300,
      application_id: 100,
      user_id: 10,
      type: "NOTE",
      visibility: "privately_visible",
      body: "Same",
    }));
    const candidateGreenhouse = authorizedRoutes().onList("/notes", () => candidateNotes);
    const candidate = await actionDefinition("candidate_note_create").preparePreview({
      application_id: 100, body: "Same", visibility: "private", note_type: "NOTE",
    }, { actorUserId: 10, greenhouse: candidateGreenhouse, signingSecret: TEST_SECRET, clock });
    assert.equal((candidate.binding as { baseline_count: number }).baseline_count, 250);
    assert.deepEqual((candidate.approval as {
      before: { identical_note_ids: number[]; additional_identical_note_count: number };
    }).before, {
      identical_note_ids: candidateNotes.slice(0, 200).map(({ id }) => id),
      additional_identical_note_count: 50,
    });
    assert.doesNotThrow(() => issueActionIntent({
      session: testSession(), identityId: IDENTITY_ID, actorUserId: 10,
      applyTool: "apply_candidate_note_create", prepared: candidate, nowMs: clock.now(),
    }, TEST_SECRET));

    const jobNotes = Array.from({ length: 250 }, (_, index) => ({
      id: 2_000 + index,
      job_id: 200,
      user_id: 10,
      body: `Existing ${index}`,
      visibility: "privately_visible",
    }));
    const jobGreenhouse = authorizedRoutes().onList("/job_notes", () => jobNotes);
    const job = await actionDefinition("job_note_change").preparePreview({
      verb: "create", job_id: 200, body: "New", visibility: "privately_visible",
    }, { actorUserId: 10, greenhouse: jobGreenhouse, signingSecret: TEST_SECRET, clock });
    assert.equal((job.binding as { baseline_count: number }).baseline_count, 250);
    assert.doesNotThrow(() => issueActionIntent({
      session: testSession(), identityId: IDENTITY_ID, actorUserId: 10,
      applyTool: "apply_job_note_change", prepared: job, nowMs: clock.now(),
    }, TEST_SECRET));
  });

  test("create reconciliation conflicts when Greenhouse returns a known row with the wrong content", async () => {
    const candidateNote = new RouteGreenhouse().onList("/notes", () => [{
      id: 902, candidate_id: 300, application_id: 100, user_id: 10,
      type: "NOTE", visibility: "privately_visible", body: "Altered",
    }]);
    const candidateBinding: ActionBinding = {
      application_id: 100, candidate_id: 300, note_type: "NOTE", visibility: "private",
      baseline_count: 0, baseline_fingerprint: candidateNoteBaseline([]),
    };
    const candidateRecord = {
      ...actionRecord("candidate_note_create", candidateBinding, "A".repeat(43)),
      upstreamResourceId: 902,
    };
    assert.equal(await actionDefinition("candidate_note_create").observe(candidateRecord, {
      actorUserId: 10, greenhouse: candidateNote, signingSecret: TEST_SECRET, clock,
    }), "conflict");

    const jobNote = new RouteGreenhouse().onList("/job_notes", () => [{
      id: 903, job_id: 200, user_id: 10, body: "Altered", visibility: "privately_visible",
    }]);
    const jobBinding: ActionBinding = {
      job_id: 200, verb: "create", note_id: null, visibility: "privately_visible",
      baseline_count: 0, baseline_fingerprint: jobNoteBaseline([]),
    };
    const jobRecord = {
      ...actionRecord("job_note_change", jobBinding, "A".repeat(43)),
      upstreamResourceId: 903,
    };
    assert.equal(await actionDefinition("job_note_change").observe(jobRecord, {
      actorUserId: 10, greenhouse: jobNote, signingSecret: TEST_SECRET, clock,
    }), "conflict");
  });

  test("create reconciliation conflicts on a new transformed row when the response has no ID", async () => {
    const candidateNote = new RouteGreenhouse().onList("/notes", () => [{
      id: 902, candidate_id: 300, application_id: 100, user_id: 10,
      type: "NOTE", visibility: "privately_visible", body: "Altered",
    }]);
    const candidateBinding: ActionBinding = {
      application_id: 100, candidate_id: 300, note_type: "NOTE", visibility: "private",
      baseline_count: 0, baseline_fingerprint: candidateNoteBaseline([]),
    };
    assert.equal(await actionDefinition("candidate_note_create").observe(
      actionRecord("candidate_note_create", candidateBinding, "A".repeat(43)),
      { actorUserId: 10, greenhouse: candidateNote, signingSecret: TEST_SECRET, clock },
    ), "conflict");

    const jobNote = new RouteGreenhouse().onList("/job_notes", () => [{
      id: 903, job_id: 200, user_id: 10, body: "Altered", visibility: "privately_visible",
    }]);
    const jobBinding: ActionBinding = {
      job_id: 200, verb: "create", note_id: null, visibility: "privately_visible",
      baseline_count: 0, baseline_fingerprint: jobNoteBaseline([]),
    };
    assert.equal(await actionDefinition("job_note_change").observe(
      actionRecord("job_note_change", jobBinding, "A".repeat(43)),
      { actorUserId: 10, greenhouse: jobNote, signingSecret: TEST_SECRET, clock },
    ), "conflict");
  });

  test("offer update reconciliation accepts a new current offer ID/version", async () => {
    const greenhouse = new RouteGreenhouse().onList("/offers", () => [{
      id: 951, version: 2, application_id: 100, job_id: 200, candidate_id: 300,
      status: "Created", starts_on: "2026-09-01T00:00:00Z", custom_fields: {},
    }]);
    const binding: ActionBinding = {
      application_id: 100, offer_id: 950, version: 1, fields: ["starts_on"], has_currency: false,
    };
    const desired = { status: "Created", starts_on: "2026-09-01" };
    const record = actionRecord("offer_update", binding, fingerprintValue("offer-update-desired", desired, TEST_SECRET));
    assert.equal(await actionDefinition("offer_update").observe(record, {
      actorUserId: 10, greenhouse, signingSecret: TEST_SECRET, clock,
    }), "desired_observed");

    const oldValuesOnNewVersion = new RouteGreenhouse().onList("/offers", () => [{
      id: 951, version: 2, application_id: 100, job_id: 200, candidate_id: 300,
      status: "Created", starts_on: "2026-08-01T00:00:00Z", custom_fields: {},
    }]);
    const original = { offer_id: 950, version: 1, status: "Created", starts_on: "2026-08-01" };
    const thirdState = {
      ...record,
      currentFingerprint: fingerprintValue("offer-update-current", original, TEST_SECRET),
    };
    assert.equal(await actionDefinition("offer_update").observe(thirdState, {
      actorUserId: 10, greenhouse: oldValuesOnNewVersion, signingSecret: TEST_SECRET, clock,
    }), "conflict");
  });

  test("candidate updates construct complete arrays/custom fields and use a 30-minute async grace", async () => {
    const greenhouse = authorizedRoutes();
    const candidate = {
      id: 300, first_name: "A", last_name: "Person", preferred_name: null, company: null, title: "Engineer", time_zone: "UTC",
      phone_numbers: [], addresses: [], email_addresses: [], website_addresses: [], social_media_addresses: [],
      tags: ["existing"], linked_user_ids: [],
      custom_fields: { changed_field: { value: "old" }, retained_field: { value: "keep" } },
    };
    greenhouse.onList("/candidates", () => [candidate]);
    greenhouse.onList("/custom_fields", () => [
      { id: 1, name_key: "changed_field", value_type: "short_text", trigger_new_version: false, active: true, field_type: "candidate" },
      { id: 2, name_key: "retained_field", value_type: "short_text", trigger_new_version: false, active: true, field_type: "candidate" },
    ]);
    const definition = actionDefinition("candidate_record_update");
    const preparedAction = await definition.preparePreview({
      context_application_id: 100,
      changes: {
        tags: { add: ["new"] },
        custom_fields: [{ name_key: "changed_field", value: "new" }],
      },
    }, { actorUserId: 10, greenhouse, signingSecret: TEST_SECRET, clock });
    assert.equal(preparedAction.reconciliationGraceMs, 30 * 60_000);
    const approval = preparedAction.approval as {
      after: { tags: string[]; custom_fields: Array<{ name_key: string; value: unknown }> };
    };
    assert.deepEqual(approval.after.tags, ["existing", "new"]);
    assert.deepEqual(approval.after.custom_fields, [
      { name_key: "changed_field", value: "new" },
      { name_key: "retained_field", value: "keep" },
    ]);
    const mutation = await definition.mutation(preparedAction.approval, preparedAction, {
      actorUserId: 10, greenhouse, signingSecret: TEST_SECRET, clock,
    });
    assert.deepEqual(mutation.body, {
      tags: ["existing", "new"],
      custom_fields: approval.after.custom_fields,
    });
    assert.equal(definition.previewSchema.safeParse({ context_application_id: 100, changes: { can_email: true } }).success, false);
  });

  test("candidate contact edits accept Greenhouse's documented plain-string values", async () => {
    let candidate = {
      id: 300, first_name: "A", last_name: "Person", preferred_name: null, company: null, title: "Engineer", time_zone: "UTC",
      phone_numbers: [], addresses: [], email_addresses: [{ value: "person@internal", type: "work" }],
      website_addresses: [{ value: "somewebsite.com", type: "other" }],
      social_media_addresses: [], tags: [], linked_user_ids: [], custom_fields: {},
    };
    const greenhouse = authorizedRoutes().onList("/candidates", () => [candidate]);

    const definition = actionDefinition("candidate_record_update");
    const action = await definition.preparePreview({
      context_application_id: 100,
      changes: {
        email_addresses: { add: [{ value: "person+recruiting@internal", type: "other" }] },
        website_addresses: { add: [{ value: "portfolio.example", type: "portfolio" }] },
      },
    }, { actorUserId: 10, greenhouse, signingSecret: TEST_SECRET, clock });

    assert.deepEqual((action.approval as { after: { website_addresses: unknown[] } }).after.website_addresses, [
      { value: "portfolio.example", type: "portfolio" },
      { value: "somewebsite.com", type: "other" },
    ]);
    assert.deepEqual((action.approval as { after: { email_addresses: unknown[] } }).after.email_addresses, [
      { value: "person+recruiting@internal", type: "other" },
      { value: "person@internal", type: "work" },
    ]);

    candidate = {
      ...candidate,
      email_addresses: [
        { value: "person@internal", type: "work" },
        { value: "person+recruiting@internal", type: "other" },
      ],
      website_addresses: [
        { value: "somewebsite.com", type: "other" },
        { value: "portfolio.example", type: "portfolio" },
      ],
    };
    const record = {
      ...actionRecord("candidate_record_update", action.binding, action.desiredFingerprint),
      currentFingerprint: action.currentFingerprint,
    };
    assert.equal(await definition.observe(record, {
      actorUserId: 10, greenhouse, signingSecret: TEST_SECRET, clock,
    }), "desired_observed");
  });

  test("candidate schemas enforce documented time zones and non-empty custom-field edits", () => {
    const schema = actionDefinition("candidate_record_update").previewSchema;
    const valid = schema.safeParse({ context_application_id: 100, changes: { time_zone: "UTC" } });
    assert.equal(valid.success, true);
    if (valid.success) {
      assert.equal((valid.data as { changes: { time_zone: string } }).changes.time_zone, "utc");
    }
    assert.equal(schema.safeParse({ context_application_id: 100, changes: { time_zone: "Mars/Olympus" } }).success, false);
    assert.equal(schema.safeParse({ context_application_id: 100, changes: { custom_fields: [] } }).success, false);
    const longNameKey = `field_${"x".repeat(249)}`;
    assert.equal(longNameKey.length, 255);
    assert.equal(schema.safeParse({
      context_application_id: 100,
      changes: { custom_fields: [{ name_key: longNameKey, value: "allowed" }] },
    }).success, true);
  });

  test("candidate updates clear optional profile scalars with the documented empty-string write", async () => {
    let candidate: { id: number; preferred_name: string | null; title: string | null } = {
      id: 300, preferred_name: "Stale", title: "Legacy",
    };
    const greenhouse = authorizedRoutes().onList("/candidates", () => [candidate]);
    const definition = actionDefinition("candidate_record_update");
    const action = await definition.preparePreview({
      context_application_id: 100,
      changes: { preferred_name: "", title: "" },
    }, { actorUserId: 10, greenhouse, signingSecret: TEST_SECRET, clock });

    assert.deepEqual((action.approval as { after: unknown }).after, {
      preferred_name: null,
      title: null,
    });
    assert.deepEqual((await definition.mutation(action.approval, action, {
      actorUserId: 10, greenhouse, signingSecret: TEST_SECRET, clock,
    })).body, { preferred_name: "", title: "" });

    candidate = { id: 300, preferred_name: null, title: null };
    const record = {
      ...actionRecord("candidate_record_update", action.binding, action.desiredFingerprint),
      currentFingerprint: action.currentFingerprint,
    };
    assert.equal(await definition.observe(record, {
      actorUserId: 10, greenhouse, signingSecret: TEST_SECRET, clock,
    }), "desired_observed");
  });

  test("candidate select fields normalize read labels to write IDs and back for readback", async () => {
    const greenhouse = authorizedRoutes();
    let candidate = {
      id: 300, first_name: "A", last_name: "Person", preferred_name: null, company: null, title: "Engineer", time_zone: "UTC",
      phone_numbers: [], addresses: [], email_addresses: [], website_addresses: [], social_media_addresses: [],
      tags: [], linked_user_ids: [],
      custom_fields: {
        department: { name: "Department", type: "single_select", value: "Engineering" },
        skills: { name: "Skills", type: "multi_select", value: ["Research", "Writing"] },
        summary: { name: "Summary", type: "short_text", value: "old" },
      },
    };
    greenhouse
      .onList("/candidates", () => [candidate])
      .onList("/custom_fields", () => [
        { id: 1, name_key: "department", value_type: "single_select", trigger_new_version: false, active: true, field_type: "candidate" },
        { id: 2, name_key: "summary", value_type: "short_text", trigger_new_version: false, active: true, field_type: "candidate" },
        { id: 3, name_key: "skills", value_type: "multi_select", trigger_new_version: false, active: true, field_type: "candidate" },
      ])
      .onList("/custom_field_options", () => [
        { id: 11, custom_field_id: 1, name: "Engineering", active: true },
        { id: 21, custom_field_id: 3, name: "Research", active: true },
        { id: 22, custom_field_id: 3, name: "Writing", active: true },
      ]);
    const definition = actionDefinition("candidate_record_update");
    const preparedAction = await definition.preparePreview({
      context_application_id: 100,
      changes: { custom_fields: [
        { name_key: "summary", value: "new" },
        { name_key: "skills", value: [22, 21] },
      ] },
    }, { actorUserId: 10, greenhouse, signingSecret: TEST_SECRET, clock });
    const approval = preparedAction.approval as {
      after: { custom_fields: Array<{ name_key: string; value: unknown }> };
    };
    assert.deepEqual(approval.after.custom_fields, [
      { name_key: "department", value: 11 },
      { name_key: "skills", value: [22, 21] },
      { name_key: "summary", value: "new" },
    ]);
    assert.deepEqual((preparedAction.preview as {
      after: { custom_fields: Array<{ name_key: string; value: unknown }> };
    }).after.custom_fields, [
      { name_key: "department", value: "Engineering" },
      { name_key: "skills", value: ["Research", "Writing"] },
      { name_key: "summary", value: "new" },
    ]);
    assert.deepEqual((await definition.mutation(preparedAction.approval, preparedAction, {
      actorUserId: 10, greenhouse, signingSecret: TEST_SECRET, clock,
    })).body, { custom_fields: approval.after.custom_fields });

    candidate = {
      ...candidate,
      custom_fields: {
        department: { name: "Department", type: "single_select", value: "Engineering" },
        skills: { name: "Skills", type: "multi_select", value: ["Writing", "Research"] },
        summary: { name: "Summary", type: "short_text", value: "new" },
      },
    };
    const record = actionRecord(
      "candidate_record_update",
      preparedAction.binding,
      preparedAction.desiredFingerprint,
    );
    assert.equal(await definition.observe(record, {
      actorUserId: 10, greenhouse, signingSecret: TEST_SECRET, clock,
    }), "desired_observed");
  });

  test("candidate custom fields reject definition mismatches and populated unsupported existing values", async () => {
    const baseCandidate = {
      id: 300, first_name: "A", last_name: "Person", preferred_name: null, company: null, title: "Engineer", time_zone: "UTC",
      phone_numbers: [], addresses: [], email_addresses: [], website_addresses: [], social_media_addresses: [],
      tags: [], linked_user_ids: [], custom_fields: {},
    };
    const wrongType = authorizedRoutes()
      .onList("/candidates", () => [baseCandidate])
      .onList("/custom_fields", () => [{
        id: 1, name_key: "salary", value_type: "currency", trigger_new_version: false, active: true, field_type: "candidate",
      }]);
    await assert.rejects(actionDefinition("candidate_record_update").preparePreview({
      context_application_id: 100,
      changes: { custom_fields: [{ name_key: "salary", value: true }] },
    }, { actorUserId: 10, greenhouse: wrongType, signingSecret: TEST_SECRET, clock }), /does not match currency/);
    await assert.rejects(actionDefinition("candidate_record_update").preparePreview({
      context_application_id: 100,
      changes: { custom_fields: [{
        name_key: "salary",
        value: { amount: 250_000, currency_code: "USD", rationale: "Offer only" },
      }] },
    }, { actorUserId: 10, greenhouse: wrongType, signingSecret: TEST_SECRET, clock }), /does not match currency/);

    const maskedExisting = authorizedRoutes()
      .onList("/candidates", () => [{
        ...baseCandidate,
        custom_fields: {
          restricted_hris_value: { value: "masked" },
          summary: { value: "old" },
        },
      }])
      .onList("/custom_fields", () => [
        { id: 1, name_key: "restricted_hris_value", value_type: "unsupported", trigger_new_version: false, active: true, field_type: "candidate" },
        { id: 2, name_key: "summary", value_type: "short_text", trigger_new_version: false, active: true, field_type: "candidate" },
      ]);
    await assert.rejects(actionDefinition("candidate_record_update").preparePreview({
      context_application_id: 100,
      changes: { custom_fields: [{ name_key: "summary", value: "new" }] },
    }, { actorUserId: 10, greenhouse: maskedExisting, signingSecret: TEST_SECRET, clock }), /cannot be written losslessly/);
  });

  test("offer creation refuses an existing chain and flags currency as high impact", async () => {
    {
      const greenhouse = authorizedRoutes().onList("/offers", () => [{ id: 950, application_id: 100 }]);
      await assert.rejects(actionDefinition("offer_create").preparePreview({ application_id: 100, starts_on: "2026-08-01" }, {
        actorUserId: 10, greenhouse, signingSecret: TEST_SECRET, clock,
      }), /already has an offer chain/);
    }
    {
      const greenhouse = authorizedRoutes()
        .onList("/offers", () => [])
        .onList("/custom_fields", () => [{
          id: 3, name_key: "salary", value_type: "currency", trigger_new_version: true, active: true, field_type: "offer",
        }]);
      const result = await actionDefinition("offer_create").preparePreview({
        application_id: 100,
        custom_fields: [{ name_key: "salary", value: { amount: 250_000, currency_code: "USD" } }],
      }, { actorUserId: 10, greenhouse, signingSecret: TEST_SECRET, clock });
      assert.equal(result.highImpact, true);
      assert.equal(result.reconciliationGraceMs, 10 * 60_000);
    }
    assert.equal(actionDefinition("offer_create").previewSchema.safeParse({
      application_id: 100, starts_on: "2026-02-31",
    }).success, false);
    assert.equal(actionDefinition("offer_update").previewSchema.safeParse({
      application_id: 100, offer_id: 950, custom_fields: [],
    }).success, false);
  });

  test("date-only offer create and update skip custom-field metadata", async () => {
    const failIfCalled = () => { throw new Error("Custom-field metadata must not be read."); };
    const createGreenhouse = authorizedRoutes()
      .onList("/offers", () => [])
      .onList("/custom_fields", failIfCalled)
      .onList("/custom_field_options", failIfCalled);
    const createDefinition = actionDefinition("offer_create");
    const createAction = await createDefinition.preparePreview({
      application_id: 100,
      starts_on: "2026-08-01",
    }, { actorUserId: 10, greenhouse: createGreenhouse, signingSecret: TEST_SECRET, clock });
    await createDefinition.prepareApply(createAction.approval, {
      actorUserId: 10, greenhouse: createGreenhouse, signingSecret: TEST_SECRET, clock,
    });
    assert.equal(createGreenhouse.listCalls.some(({ path }) => path.startsWith("/custom_field")), false);

    const updateGreenhouse = authorizedRoutes()
      .onList("/offers", () => [{
        id: 950, version: 1, application_id: 100, job_id: 200, candidate_id: 300,
        status: "Created", starts_on: "2026-08-01", custom_fields: {},
      }])
      .onList("/custom_fields", failIfCalled)
      .onList("/custom_field_options", failIfCalled);
    const updateDefinition = actionDefinition("offer_update");
    const updateAction = await updateDefinition.preparePreview({
      application_id: 100,
      offer_id: 950,
      starts_on: "2026-09-01",
    }, { actorUserId: 10, greenhouse: updateGreenhouse, signingSecret: TEST_SECRET, clock });
    await updateDefinition.prepareApply(updateAction.approval, {
      actorUserId: 10, greenhouse: updateGreenhouse, signingSecret: TEST_SECRET, clock,
    });
    assert.equal(updateGreenhouse.listCalls.some(({ path }) => path.startsWith("/custom_field")), false);
  });

  test("offer custom fields use one definition read and request options only for selected fields", async () => {
    const definitions = [
      { id: 3, name_key: "department", value_type: "single_select", trigger_new_version: false, active: true, field_type: "offer" },
      { id: 4, name_key: "unrequested", value_type: "single_select", trigger_new_version: false, active: true, field_type: "offer" },
    ];
    const configureMetadata = (greenhouse: RouteGreenhouse) => greenhouse
      .onList("/custom_fields", (params) => {
        assert.equal(Object.hasOwn(params, "name_key"), false);
        return definitions;
      })
      .onList("/custom_field_options", (params) => {
        assert.equal(params.custom_field_ids, "3");
        return [
          { id: 31, custom_field_id: 3, name: "Engineering", active: true },
          { id: 41, custom_field_id: 4, name: "Secret", active: true },
        ];
      });

    const createGreenhouse = configureMetadata(authorizedRoutes().onList("/offers", () => []));
    await actionDefinition("offer_create").preparePreview({
      application_id: 100,
      custom_fields: [{ name_key: "department", value: 31 }],
    }, { actorUserId: 10, greenhouse: createGreenhouse, signingSecret: TEST_SECRET, clock });
    assert.equal(createGreenhouse.listCalls.filter(({ path }) => path === "/custom_fields").length, 1);

    const updateGreenhouse = configureMetadata(authorizedRoutes().onList("/offers", () => [{
      id: 950, version: 1, application_id: 100, job_id: 200, candidate_id: 300,
      status: "Created", starts_on: null,
      custom_fields: { department: { value: "Sales" }, unrequested: { value: "Secret" } },
    }]));
    await actionDefinition("offer_update").preparePreview({
      application_id: 100,
      offer_id: 950,
      custom_fields: [{ name_key: "department", value: 31 }],
    }, { actorUserId: 10, greenhouse: updateGreenhouse, signingSecret: TEST_SECRET, clock });
    assert.equal(updateGreenhouse.listCalls.filter(({ path }) => path === "/custom_fields").length, 1);
  });

  test("offer select previews show labels while approvals and mutations retain option IDs", async () => {
    const definitions = [{
      id: 3, name_key: "department", value_type: "single_select", trigger_new_version: false, active: true, field_type: "offer",
    }];
    const options = [
      { id: 31, custom_field_id: 3, name: "Engineering", active: true },
      { id: 32, custom_field_id: 3, name: "Sales", active: true },
    ];
    {
      const greenhouse = authorizedRoutes()
        .onList("/offers", () => [])
        .onList("/custom_fields", () => definitions)
        .onList("/custom_field_options", () => options);
      const definition = actionDefinition("offer_create");
      const action = await definition.preparePreview({
        application_id: 100,
        custom_fields: [{ name_key: "department", value: 31 }],
      }, { actorUserId: 10, greenhouse, signingSecret: TEST_SECRET, clock });
      assert.deepEqual((action.approval as { after: { custom_fields: unknown[] } }).after.custom_fields,
        [{ name_key: "department", value: 31 }]);
      assert.deepEqual((action.preview as { after: { custom_fields: unknown[] } }).after.custom_fields,
        [{ name_key: "department", value: "Engineering" }]);
      assert.deepEqual((await definition.mutation(action.approval, action, {
        actorUserId: 10, greenhouse, signingSecret: TEST_SECRET, clock,
      })).body?.custom_fields, [{ name_key: "department", value: 31 }]);
    }
    {
      const greenhouse = authorizedRoutes()
        .onList("/offers", () => [{
          id: 950, version: 1, application_id: 100, job_id: 200, candidate_id: 300,
          status: "Created", starts_on: null,
          custom_fields: { department: { name: "Department", type: "single_select", value: "Sales" } },
        }])
        .onList("/custom_fields", () => definitions)
        .onList("/custom_field_options", () => options);
      const definition = actionDefinition("offer_update");
      const action = await definition.preparePreview({
        application_id: 100,
        offer_id: 950,
        custom_fields: [{ name_key: "department", value: 31 }],
      }, { actorUserId: 10, greenhouse, signingSecret: TEST_SECRET, clock });
      assert.deepEqual((action.approval as { after: { values: { custom_fields: unknown[] } } }).after.values.custom_fields,
        [{ name_key: "department", value: 31 }]);
      assert.deepEqual((action.preview as { after: { values: { custom_fields: unknown[] } } }).after.values.custom_fields,
        [{ name_key: "department", value: "Engineering" }]);
      assert.deepEqual((await definition.mutation(action.approval, action, {
        actorUserId: 10, greenhouse, signingSecret: TEST_SECRET, clock,
      })).body?.custom_fields, [{ name_key: "department", value: 31 }]);
    }
  });
});

function prepared(kind: ActionKind, binding: ActionBinding): PreparedAction {
  return {
    actionKind: kind,
    lockKey: kind.startsWith("offer_") ? "offer-chain:100" : kind.startsWith("job_") ? "job:200" : "application:100",
    scopeJobId: 200,
    fenceTargets: [{ kind: "application", id: 100, requiresUnredacted: false }],
    binding,
    currentFingerprint: "A".repeat(43),
    desiredFingerprint: "B".repeat(43),
    approvalFingerprint: "C".repeat(43),
    highImpact: false,
    reconciliationGraceMs: 5 * 60_000,
    changeRequired: true,
    approval: {},
    preview: {},
  };
}

function actionRecord(kind: ActionKind, binding: ActionBinding, desiredFingerprint: string): ActionRecord {
  return {
    actionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    actionKind: kind,
    lockKey: kind.startsWith("offer_") ? "offer-chain:100" : "application:100",
    scopeJobId: 200,
    binding,
    identityId: "11111111-1111-4111-8111-111111111111",
    actorUserId: 10,
    subjectFingerprint: "A".repeat(43),
    sessionFingerprint: "B".repeat(43),
    client: "test",
    currentFingerprint: "C".repeat(43),
    desiredFingerprint,
    approvalFingerprint: "D".repeat(43),
    highImpact: false,
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
    upstreamResourceId: null,
    firstOriginalObservationAt: null,
    resolutionSource: null,
    resolvedByFingerprint: null,
    completedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function authorizedRoutes(): RouteGreenhouse {
  return new RouteGreenhouse()
    .onList("/applications", () => [{
      id: 100, candidate_id: 300, job_id: 200, recruiter_id: 20, coordinator_id: 30,
      stage_id: 501, status: "in_process", source_id: 600, referrer_id: 700,
    }])
    .onList("/users", () => [{ id: 10, name: "Actor", deactivated: false, site_admin: false }])
    .onList("/jobs", () => [{ id: 200, confidential: false }])
    .onList("/user_job_permissions", () => [{ id: 1, user_id: 10, job_id: 200, role_id: 1, automated: false }]);
}

function candidateNoteBaseline(ids: number[]): string {
  return fingerprintValue("candidate-note-create-baseline", ids, TEST_SECRET);
}

function jobNoteBaseline(ids: number[]): string {
  return fingerprintValue("job-note-change-baseline", ids, TEST_SECRET);
}

describe("custom-field archived-definition repair (Phase 2c Slice 6 — the one sanctioned widening)", () => {
  function definitionRows() {
    return [
      { id: 1, name_key: "active_field", value_type: "short_text", trigger_new_version: false, active: true, field_type: "candidate" },
      // The archived definition whose EXISTING value used to make the whole candidate unwritable.
      { id: 2, name_key: "legacy_field", value_type: "short_text", trigger_new_version: false, active: false, field_type: "candidate" },
    ];
  }
  function gh() {
    return {
      async list(path: string) {
        if (path === "/custom_fields") return definitionRows();
        if (path === "/custom_field_options") return [];
        throw new Error(`unexpected list ${path}`);
      },
    } as never;
  }

  test("a candidate carrying an archived-definition value is writable losslessly again", async () => {
    const validated = await validateCustomFields({
      greenhouse: gh(), actorUserId: 10, fieldType: "candidate",
      values: [{ name_key: "active_field", value: "new value" }],
    });
    const complete = buildCompleteCandidateCustomFields({
      row: { id: 300, custom_fields: { legacy_field: { value: "old value" }, active_field: { value: "old" } } },
      definitions: validated.definitions,
      changes: [{ name_key: "active_field", value: "new value" }],
    });
    assert.deepEqual(complete, [
      { name_key: "active_field", value: "new value" },
      { name_key: "legacy_field", value: "old value" },
    ], "the archived value survives the round trip UNCHANGED; before this slice the write refused outright");
  });

  test("a requested write TO an archived definition still refuses — archived is not a write surface", async () => {
    await assert.rejects(
      validateCustomFields({
        greenhouse: gh(), actorUserId: 10, fieldType: "candidate",
        values: [{ name_key: "legacy_field", value: "sneaky" }],
      }),
      /is not active for candidate/
    );
  });
});
