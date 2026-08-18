import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { actionDefinition } from "../src/actions/index.js";
import { ActionDeniedError } from "../src/errors.js";
import { GreenhouseError } from "../src/greenhouse.js";
import { GreenhouseActionService, reconcileRecoverableActions } from "../src/service.js";
import type { ActionKind, GreenhouseGateway } from "../src/types.js";
import {
  MemoryActionStore,
  TEST_SECRET,
  allowAllVisibility,
  TestClock,
  assignmentGreenhouse,
  testSession,
} from "./helpers.js";

function fixture(options: {
  writesEnabled?: boolean;
  production?: boolean;
  writeCapabilities?: ReadonlySet<ActionKind>;
  visibility?: import("../src/types.js").TargetVisibilityProbe;
} = {}) {
  const clock = new TestClock();
  const store = new MemoryActionStore(clock);
  const { greenhouse, state } = assignmentGreenhouse();
  const service = new GreenhouseActionService({
    session: testSession(),
    store,
    greenhouse,
    signingSecret: TEST_SECRET,
    visibility: options.visibility ?? allowAllVisibility(),
    writesEnabled: options.writesEnabled ?? true,
    production: options.production ?? false,
    writeCapabilities: options.writeCapabilities,
    clock,
  });
  return { clock, store, greenhouse, state, service };
}

async function previewApplyInput(service: GreenhouseActionService): Promise<Record<string, unknown>> {
  const preview = await service.preview("application_assignment_change", {
    application_id: 100,
    assignment_role: "recruiter",
    proposed_user_id: 40,
  });
  assert.equal(preview.status, "ready");
  assert.equal(typeof preview.intent, "string");
  assert.ok(preview.approval && typeof preview.approval === "object" && !Array.isArray(preview.approval));
  return { intent: preview.intent, ...preview.approval as Record<string, unknown> };
}

describe("GreenhouseActionService", () => {
  test("preserves only safe upstream diagnostics when preview reads fail", async () => {
    const clock = new TestClock();
    const store = new MemoryActionStore(clock);
    const greenhouse = {
      async probe() {},
      async list() {
        throw new GreenhouseError("sensitive upstream detail", {
          status: 403,
          requestId: "gh-request-123",
        });
      },
      async mutate() { throw new Error("unexpected mutation"); },
    } as GreenhouseGateway;
    const service = new GreenhouseActionService({
      session: testSession(),
      store,
      greenhouse,
      signingSecret: TEST_SECRET,
    visibility: allowAllVisibility(),
      writesEnabled: true,
      production: false,
      clock,
    });

    await assert.rejects(service.preview("application_assignment_change", {
      application_id: 100,
      assignment_role: "recruiter",
      proposed_user_id: 40,
    }), (error: unknown) => error instanceof ActionDeniedError
      && error.code === "UPSTREAM_UNAVAILABLE"
      && error.message === "Required Greenhouse state is unavailable."
      && error.diagnostic?.upstreamStatus === 403
      && error.diagnostic.upstreamRequestId === "gh-request-123");
  });

  test("preview is sanitized, never writes, and omits intent for a no-op", async () => {
    const { service, greenhouse } = fixture();
    const ready = await service.preview("application_assignment_change", {
      application_id: 100,
      assignment_role: "recruiter",
      proposed_user_id: 40,
    });
    assert.deepEqual(ready.target, { application_id: 100, job_id: 200, assignment_role: "recruiter" });
    assert.deepEqual(ready.before, { user_id: 20, name: "Current Recruiter" });
    assert.deepEqual(ready.after, { user_id: 40, name: "Proposed" });
    assert.equal(typeof ready.intent, "string");
    assert.equal(greenhouse.mutationCalls.length, 0);

    const noChange = await service.preview("application_assignment_change", {
      application_id: 100,
      assignment_role: "recruiter",
      proposed_user_id: 20,
    });
    assert.equal(noChange.change_required, false);
    assert.equal(noChange.intent, null);
    assert.equal(greenhouse.mutationCalls.length, 0);
  });

  test("one selected-field mutation crosses the fence, then replays without another write", async () => {
    const { service, greenhouse, state, store } = fixture();
    const input = await previewApplyInput(service);
    state.application.coordinator_id = 31; // unrelated field drift must not broaden or invalidate this selected-field write
    const first = await service.apply("application_assignment_change", input);
    const replay = await service.apply("application_assignment_change", input);

    assert.equal(first.state, "succeeded");
    assert.equal(replay.state, "succeeded");
    assert.equal(replay.replayed, true);
    assert.equal(state.application.recruiter_id, 40);
    assert.equal(state.application.coordinator_id, 31);
    assert.deepEqual(greenhouse.mutationCalls.map(({ method, path, body, actorUserId }) => ({ method, path, body, actorUserId })), [{
      method: "PATCH",
      path: "/applications/100",
      body: { recruiter_id: 40 },
      actorUserId: 10,
    }]);
    const record = [...store.records.values()][0]!;
    assert.equal(record.phase, "mutation_sent");
    assert.equal(record.status, "succeeded");
    assert.equal(record.observation, "desired_observed");
  });

  test("concurrent apply and a lost mutation fence send at most one write", async () => {
    {
      const { service, greenhouse } = fixture();
      const input = await previewApplyInput(service);
      const results = await Promise.all([
        service.apply("application_assignment_change", input),
        service.apply("application_assignment_change", input),
      ]);
      assert.equal(greenhouse.mutationCalls.length, 1);
      assert.ok(results.some((result) => result.state === "succeeded"));
      assert.ok(results.every((result) => result.state === "succeeded" || result.state === "in_progress"));
    }
    {
      const { service, greenhouse, store } = fixture();
      const input = await previewApplyInput(service);
      store.failBegin = true;
      await assert.rejects(service.apply("application_assignment_change", input), denied("ACTION_OWNERSHIP_LOST"));
      assert.equal(greenhouse.mutationCalls.length, 0);
    }
  });

  test("fresh state, revocation, entitlement, expiry, and approval echo are checked before mutation", async () => {
    {
      const { service, greenhouse, state } = fixture();
      const input = await previewApplyInput(service);
      state.application.recruiter_id = 21;
      state.users.set(21, { id: 21, name: "External change", deactivated: false, site_admin: false });
      const result = await service.apply("application_assignment_change", input);
      assert.equal(result.error_code, "STATE_CHANGED");
      assert.equal(greenhouse.mutationCalls.length, 0);
    }
    {
      const { service, greenhouse, store } = fixture();
      const input = await previewApplyInput(service);
      greenhouse.afterList = () => { store.revoked = true; };
      const result = await service.apply("application_assignment_change", input);
      assert.equal(result.error_code, "SESSION_REVOKED");
      assert.equal(greenhouse.mutationCalls.length, 0);
    }
    {
      const { service, greenhouse, store } = fixture();
      const input = await previewApplyInput(service);
      greenhouse.afterList = () => { if (store.entitlement) store.entitlement.canApply = false; };
      const result = await service.apply("application_assignment_change", input);
      assert.equal(result.error_code, "ACTION_NOT_ENTITLED");
      assert.equal(greenhouse.mutationCalls.length, 0);
    }
    {
      const { service, greenhouse, clock } = fixture();
      const input = await previewApplyInput(service);
      clock.advance(5 * 60_000 + 1);
      await assert.rejects(service.apply("application_assignment_change", input), denied("INTENT_EXPIRED"));
      assert.equal(greenhouse.mutationCalls.length, 0);
    }
    {
      const { service, greenhouse, clock } = fixture();
      const input = await previewApplyInput(service);
      await service.apply("application_assignment_change", input);
      clock.advance(5 * 60_000 + 1);
      await assert.rejects(service.apply("application_assignment_change", input), denied("INTENT_EXPIRED"));
      assert.equal(greenhouse.mutationCalls.length, 1);
    }
    {
      const { service, greenhouse } = fixture();
      const input = await previewApplyInput(service);
      input.proposed_user_id = 41;
      await assert.rejects(service.apply("application_assignment_change", input), denied("APPROVAL_DISPLAY_MISMATCH"));
      assert.equal(greenhouse.mutationCalls.length, 0);
    }
  });

  test("logs only safe diagnostics when apply fresh-preflight fails operationally", async () => {
    const { service, greenhouse } = fixture();
    const input = await previewApplyInput(service);
    greenhouse.onList("/applications", () => {
      throw new GreenhouseError("candidate_email=casey.secret@example.com", {
        status: 403,
        requestId: "gh-apply-preflight-1",
      });
    });
    const diagnostics: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...values: unknown[]) => { diagnostics.push(values.map(String).join(" ")); };
    try {
      const result = await service.apply("application_assignment_change", input);
      assert.equal(result.error_code, "UPSTREAM_UNAVAILABLE");
      assert.equal(greenhouse.mutationCalls.length, 0);
      assert.equal(diagnostics.length, 1);
      const diagnostic = JSON.parse(diagnostics[0]!) as {
        event: string;
        action_kind: string;
        code: string;
        upstream_status: number;
        upstream_request_id: string;
      };
      assert.equal(diagnostic.event, "apply_preflight_failed");
      assert.equal(diagnostic.action_kind, "application_assignment_change");
      assert.equal(diagnostic.code, "UPSTREAM_UNAVAILABLE");
      assert.equal(diagnostic.upstream_status, 403);
      assert.equal(diagnostic.upstream_request_id, "gh-apply-preflight-1");
      assert.equal(diagnostics.join("\n").includes("casey.secret@example.com"), false);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("logs a redacted mutation-build failure without sending a mutation", async () => {
    const { service, greenhouse } = fixture();
    const input = await previewApplyInput(service);
    const definition = actionDefinition("application_assignment_change");
    const originalMutation = definition.mutation;
    const diagnostics: string[] = [];
    const originalConsoleError = console.error;
    definition.mutation = async () => { throw new Error("approval_secret=do-not-log"); };
    console.error = (...values: unknown[]) => { diagnostics.push(values.map(String).join(" ")); };
    try {
      const result = await service.apply("application_assignment_change", input);
      assert.equal(result.error_code, "MUTATION_BUILD_FAILED");
      assert.equal(greenhouse.mutationCalls.length, 0);
      assert.equal(diagnostics.length, 1);
      const diagnostic = JSON.parse(diagnostics[0]!) as {
        event: string;
        action_kind: string;
        error_name: string;
      };
      assert.equal(diagnostic.event, "mutation_build_failed");
      assert.equal(diagnostic.action_kind, "application_assignment_change");
      assert.equal(diagnostic.error_name, "Error");
      assert.equal(diagnostics.join("\n").includes("do-not-log"), false);
    } finally {
      definition.mutation = originalMutation;
      console.error = originalConsoleError;
    }
  });

  test("intents are bound to session, client, tool, identity, active actor, and current job access", async () => {
    {
      const { service, greenhouse, store, clock } = fixture();
      const input = await previewApplyInput(service);
      for (const session of [
        testSession({ subject: "different-subject" }),
        testSession({ tokenId: "action:different-session" }),
        testSession({ client: "codex" }),
      ]) {
        const other = new GreenhouseActionService({
          session, store, greenhouse, signingSecret: TEST_SECRET,
    visibility: allowAllVisibility(),
          writesEnabled: true, production: false, clock,
        });
        await assert.rejects(other.apply("application_assignment_change", input), denied("INTENT_SESSION_MISMATCH"));
      }
      assert.equal(greenhouse.mutationCalls.length, 0);
    }
    {
      const { service, greenhouse } = fixture();
      const input = await previewApplyInput(service);
      await assert.rejects(service.apply("application_rejection", {
        intent: input.intent,
        approval: {
          target: { application_id: 100, job_id: 200 },
          before: { status: "in_process", interview_stage_id: 601 },
          after: { status: "rejected", rejection_reason_id: 701, reason_name: "Position closed" },
          effects: ["No candidate email."],
        },
      }), denied("INTENT_ACTION_MISMATCH"));
      assert.equal(greenhouse.mutationCalls.length, 0);
    }
    {
      const { service, greenhouse, store } = fixture();
      const input = await previewApplyInput(service);
      store.identity = { ...store.identity, greenhouseUserId: 11 };
      await assert.rejects(service.apply("application_assignment_change", input), denied("IDENTITY_DRIFT"));
      assert.equal(greenhouse.mutationCalls.length, 0);
    }
    {
      const { service, greenhouse, state } = fixture();
      const input = await previewApplyInput(service);
      state.users.set(10, { ...state.users.get(10), id: 10, deactivated: true, site_admin: false });
      const result = await service.apply("application_assignment_change", input);
      assert.equal(result.error_code, "ACTOR_INACTIVE");
      assert.equal(greenhouse.mutationCalls.length, 0);
    }
    {
      const { service, greenhouse, state } = fixture();
      const input = await previewApplyInput(service);
      state.permitted = false;
      const result = await service.apply("application_assignment_change", input);
      assert.equal(result.error_code, "JOB_PERMISSION_DENIED");
      assert.equal(greenhouse.mutationCalls.length, 0);
    }
  });

  test("ambiguous writes reconcile desired state and quarantine a confirmed original state", async () => {
    {
      const { service, greenhouse, state, store } = fixture();
      const input = await previewApplyInput(service);
      state.mutationBehavior = "ambiguous_desired";
      const result = await service.apply("application_assignment_change", input);
      assert.equal(result.state, "reconciled");
      assert.equal(result.observation, "desired_observed");
      assert.equal(greenhouse.mutationCalls.length, 1);
      assert.equal([...store.records.values()][0]?.resolutionSource, "automatic");
    }
    {
      const { service, greenhouse, state, clock, store } = fixture();
      const input = await previewApplyInput(service);
      state.mutationBehavior = "ambiguous_original";
      const beforeApply = clock.now();
      const first = await service.apply("application_assignment_change", input);
      assert.equal(first.state, "unknown");
      assert.equal(first.observation, "not_observed");
      assert.equal(clock.now() - beforeApply, 5_000);
      assert.equal((await service.apply("application_assignment_change", input)).state, "unknown");
      const record = [...store.records.values()][0]!;
      assert.equal(Date.parse(record.notAppliedBefore) - Date.parse(record.leaseExpiresAt), 5 * 60_000);
      clock.value = Date.parse(record.notAppliedBefore) - 5_001;
      assert.equal((await reconcileRecoverableActions({
        store, greenhouse, signingSecret: TEST_SECRET, clock,
      }))[0]?.state, "unknown");
      clock.advance(31_001);
      const reconciled = (await reconcileRecoverableActions({
        store, greenhouse, signingSecret: TEST_SECRET, clock,
      }))[0]!;
      assert.equal(reconciled.state, "reconciled");
      assert.equal(reconciled.error_code, "UPSTREAM_RESULT_NOT_APPLIED");
      assert.equal(greenhouse.mutationCalls.length, 1);
    }
  });

  test("a definite upstream rejection is failed and an audit failure is never made retryable", async () => {
    {
      const { service, greenhouse, state } = fixture();
      const input = await previewApplyInput(service);
      state.mutationBehavior = "definite_failure";
      const result = await service.apply("application_assignment_change", input);
      assert.equal(result.state, "failed");
      assert.equal(result.error_code, "UPSTREAM_REJECTED");
      assert.equal(greenhouse.mutationCalls.length, 1);
    }
    {
      const { service, greenhouse, store } = fixture();
      const input = await previewApplyInput(service);
      store.failClaim = true;
      await assert.rejects(service.apply("application_assignment_change", input));
      assert.equal(greenhouse.mutationCalls.length, 0);
    }
    {
      const { service, greenhouse, store } = fixture();
      const input = await previewApplyInput(service);
      store.failFinish = true;
      const result = await service.apply("application_assignment_change", input);
      assert.equal(result.state, "unknown");
      assert.equal(result.error_code, "ACTION_STATE_UNAVAILABLE");
      assert.equal((await service.apply("application_assignment_change", input)).state, "in_progress");
      assert.equal(greenhouse.mutationCalls.length, 1);
    }
    {
      const { service, greenhouse, store, clock } = fixture();
      const input = await previewApplyInput(service);
      store.finishReturnsNull = true;
      const result = await service.apply("application_assignment_change", input);
      assert.equal(result.state, "unknown");
      assert.equal(result.error_code, "ACTION_OWNERSHIP_LOST");
      assert.equal(greenhouse.mutationCalls.length, 1);
      assert.equal((await service.apply("application_assignment_change", input)).state, "in_progress");

      store.finishReturnsNull = false;
      const record = [...store.records.values()][0]!;
      clock.value = Date.parse(record.leaseExpiresAt) + 1;
      const reconciled = (await reconcileRecoverableActions({
        store, greenhouse, signingSecret: TEST_SECRET, clock,
      }))[0]!;
      assert.equal(reconciled.state, "reconciled");
      assert.equal(reconciled.observation, "desired_observed");
      assert.equal((await service.apply("application_assignment_change", input)).state, "reconciled");
      assert.equal(greenhouse.mutationCalls.length, 1);
    }
  });

  test("many same-action callers and an overlapping reconciler cannot add a mutation", async () => {
    const { service, greenhouse, state, store, clock } = fixture();
    const input = await previewApplyInput(service);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mutationEntered = new Promise<void>((resolve) => { entered = resolve; });
    greenhouse.onMutation("PATCH", "/applications/100", async () => {
      entered();
      await gate;
      state.application.recruiter_id = 40;
      return { status: 200, requestId: "request-gated", body: { id: 100 } };
    });

    const owner = service.apply("application_assignment_change", input);
    await mutationEntered;
    const followers = await Promise.all(Array.from({ length: 24 }, () =>
      service.apply("application_assignment_change", input)));
    assert.ok(followers.every((result) => result.state === "in_progress"));
    const overlap = await reconcileRecoverableActions({ store, greenhouse, signingSecret: TEST_SECRET, clock });
    assert.equal(overlap[0]?.state, "in_progress");
    assert.equal(greenhouse.mutationCalls.length, 1);

    release();
    assert.equal((await owner).state, "succeeded");
    const replays = await Promise.all(Array.from({ length: 24 }, () =>
      service.apply("application_assignment_change", input)));
    assert.ok(replays.every((result) => result.state === "succeeded" && result.replayed === true));
    assert.equal(greenhouse.mutationCalls.length, 1);
  });

  test("a delayed 202 readback reaches success without another mutation", async () => {
    const { service, greenhouse, state, clock } = fixture();
    const input = await previewApplyInput(service);
    let postMutationReads = 0;
    let sent = false;
    greenhouse
      .onList("/applications", () => {
        if (sent && ++postMutationReads === 3) state.application.recruiter_id = 40;
        return [state.application];
      })
      .onMutation("PATCH", "/applications/100", () => {
        sent = true;
        return { status: 202, requestId: "request-accepted", body: null };
      });
    const before = clock.now();
    const result = await service.apply("application_assignment_change", input);
    assert.equal(result.state, "succeeded");
    assert.equal(result.upstream_status, 202);
    assert.equal(postMutationReads, 3);
    assert.equal(clock.now() - before, 5_000);
    assert.equal(greenhouse.mutationCalls.length, 1);
  });

  test("kill switches, capability write flags, and production test sessions are denied", async () => {
    {
      const { service, greenhouse } = fixture({ writesEnabled: false });
      const input = await previewApplyInput(service);
      await assert.rejects(service.apply("application_assignment_change", input), denied("WRITES_DISABLED"));
      assert.equal(greenhouse.mutationCalls.length, 0);
    }
    {
      const { service, greenhouse } = fixture({ writeCapabilities: new Set<ActionKind>(["offer_update"]) });
      const input = await previewApplyInput(service);
      await assert.rejects(service.apply("application_assignment_change", input), denied("CAPABILITY_WRITES_DISABLED"));
      assert.equal(greenhouse.mutationCalls.length, 0);
    }
    {
      const { service, greenhouse, store } = fixture();
      const preview = await service.preview("application_stage_move", { application_id: 100, to_stage_id: 602 });
      assert.equal(preview.high_impact, true);
      if (store.entitlement) store.entitlement.canApplyHighImpact = false;
      await assert.rejects(service.apply("application_stage_move", {
        intent: preview.intent,
        approval: preview.approval,
      }), denied("HIGH_IMPACT_NOT_ENTITLED"));
      assert.equal(greenhouse.mutationCalls.length, 0);
    }
    assert.throws(() => fixture({ production: true }), denied("TEST_CLIENT_FORBIDDEN"));
  });

  test("durable records contain only bindings, fingerprints, and operational metadata", async () => {
    const { service, store } = fixture();
    const input = await previewApplyInput(service);
    await service.apply("application_assignment_change", input);
    const serialized = JSON.stringify([...store.records.values()]);
    assert.doesNotMatch(serialized, /Current Recruiter|Proposed|google-subject-1/);
    assert.doesNotMatch(serialized, new RegExp(String(input.intent).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(serialized, /subjectFingerprint/);
    assert.match(serialized, /application_assignment_change/);
  });
});

function denied(code: string) {
  return (error: unknown) => error instanceof ActionDeniedError && error.code === code;
}
