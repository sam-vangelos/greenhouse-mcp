import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSignedSessionToken } from "../src/auth.js";
import { parseIdList, runScopeLeakageSample, runScopeLeakageSampleFromEnv } from "../src/leakage-sample.js";
import type { AuditSink } from "../src/audit.js";
import { fakeScopedReader, scopedSuccess, testSession } from "./test-helpers.js";

const SECRET = "0123456789abcdef0123456789abcdef";

describe("scope leakage sampling", () => {
  it("passes when a known forbidden job is visible unscoped but hidden in actAsUser preview", async () => {
    const scopedReader = fakeScopedReader((toolName, params, options) => {
      const preview = options?.actAsUser === 321;
      if (toolName === "list_jobs") {
        return preview
          ? scopedSuccess(toolName, [{ id: 10 }], null, { actorId: 900, effectiveActorId: 321, scoped: true, permissionScope: { kind: "jobs", permittedJobCount: 1 } })
          : scopedSuccess(toolName, [{ id: 10 }, { id: 99 }], null, { actorId: 900, effectiveActorId: 900, scoped: false, permissionScope: { kind: "operator", permittedJobCount: null } });
      }
      if (toolName === "get_job" && params?.id === 10) {
        return scopedSuccess(toolName, { id: 10 }, null, { actorId: 900, effectiveActorId: preview ? 321 : 900, scoped: preview, permissionScope: preview ? { kind: "jobs", permittedJobCount: 1 } : { kind: "operator", permittedJobCount: null } });
      }
      if (toolName === "get_job" && params?.id === 99) {
        return preview
          ? scopedSuccess(toolName, null, null, { actorId: 900, effectiveActorId: 321, scoped: true, permissionScope: { kind: "jobs", permittedJobCount: 1 } })
          : scopedSuccess(toolName, { id: 99 }, null, { actorId: 900, effectiveActorId: 900, scoped: false, permissionScope: { kind: "operator", permittedJobCount: null } });
      }
      throw new Error(`unexpected ${toolName}`);
    });

    const report = await runScopeLeakageSample({
      session: testSession({ subject: "operator", surface: "chatgpt_desktop" }),
      scopedReader,
      actAsUser: 321,
      expectedScopedJobIds: [10],
      forbiddenJobIds: [99],
      strict: true,
      now: () => Date.parse("2026-06-23T00:00:00.000Z"),
    });

    assert.equal(report.ok, true);
    assert.equal(report.auditEventCount, 10);
    assert.equal(report.checks.find((check) => check.name === "operator_unscoped_sample")?.status, "pass");
    assert.equal(report.checks.find((check) => check.name === "act_as_user_scoped_sample")?.status, "pass");
    assert.equal(report.checks.find((check) => check.name === "forbidden_job_leakage")?.status, "pass");
    assert.deepEqual(scopedReader.calls.map((call) => ({
      actAsUser: call.options?.actAsUser,
      hasSignal: call.options?.signal instanceof AbortSignal,
    })), [
      { actAsUser: undefined, hasSignal: true },
      { actAsUser: 321, hasSignal: true },
      { actAsUser: 321, hasSignal: true },
      { actAsUser: undefined, hasSignal: true },
      { actAsUser: 321, hasSignal: true },
    ]);
  });

  it("fails when a known forbidden job appears in the scoped preview", async () => {
    const scopedReader = fakeScopedReader((toolName, params, options) => {
      const preview = options?.actAsUser === 321;
      if (toolName === "list_jobs") {
        return preview
          ? scopedSuccess(toolName, [{ id: 10 }, { id: 99 }], null, { actorId: 900, effectiveActorId: 321, scoped: true, permissionScope: { kind: "jobs", permittedJobCount: 2 } })
          : scopedSuccess(toolName, [{ id: 10 }, { id: 99 }], null, { actorId: 900, effectiveActorId: 900, scoped: false, permissionScope: { kind: "operator", permittedJobCount: null } });
      }
      if (toolName === "get_job" && params?.id === 99) {
        return scopedSuccess(toolName, { id: 99 }, null, { actorId: 900, effectiveActorId: preview ? 321 : 900, scoped: preview, permissionScope: preview ? { kind: "jobs", permittedJobCount: 2 } : { kind: "operator", permittedJobCount: null } });
      }
      throw new Error(`unexpected ${toolName}`);
    });

    const report = await runScopeLeakageSample({
      session: testSession({ subject: "operator" }),
      scopedReader,
      actAsUser: 321,
      forbiddenJobIds: [99],
    });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "forbidden_job_leakage");
    assert.equal(check?.status, "fail");
    assert.equal(check?.details?.scopedVisible, true);
  });

  it("strict mode requires a known forbidden job and a job-scoped preview target", async () => {
    const scopedReader = fakeScopedReader((toolName, _params, options) => {
      const preview = options?.actAsUser === 321;
      return scopedSuccess(toolName, [{ id: 10 }], null, {
        actorId: 900,
        effectiveActorId: preview ? 321 : 900,
        scoped: preview ? false : false,
        permissionScope: preview ? { kind: "all", permittedJobCount: null } : { kind: "operator", permittedJobCount: null },
      });
    });

    const report = await runScopeLeakageSample({
      session: testSession({ subject: "operator" }),
      scopedReader,
      actAsUser: 321,
      strict: true,
    });

    assert.equal(report.ok, false);
    assert.equal(report.checks.find((check) => check.name === "strict_forbidden_job_ids_required")?.status, "fail");
    assert.equal(report.checks.find((check) => check.name === "strict_target_scope_limited")?.status, "fail");
  });

  it("fails closed before Greenhouse setup when env lacks a target actAsUser id", async () => {
    const session = testSession({ subject: "operator", surface: "chatgpt_desktop" });
    const token = createSignedSessionToken(session, SECRET);

    const report = await runScopeLeakageSampleFromEnv({
      GREENHOUSE_RECRUITER_SESSION_SECRET: SECRET,
      GREENHOUSE_RECRUITER_SESSION_TOKEN: token,
    } as NodeJS.ProcessEnv, () => Date.parse("2026-06-23T00:00:00.000Z"));

    assert.equal(report.ok, false);
    assert.equal(report.checks[0]!.name, "act_as_user_required");
  });

  it("does not copy sensitive startup exception text into leakage evidence", async () => {
    const session = testSession({ subject: "operator", surface: "chatgpt_desktop" });
    const token = createSignedSessionToken(session, SECRET);

    const report = await runScopeLeakageSampleFromEnv({
      GREENHOUSE_RECRUITER_SESSION_SECRET: SECRET,
      GREENHOUSE_RECRUITER_SESSION_TOKEN: token,
      GREENHOUSE_RECRUITER_LEAKAGE_ACT_AS_USER_ID: "321",
      GREENHOUSE_CLIENT_ID: "client-id",
      GREENHOUSE_CLIENT_SECRET: "client-secret-value",
      GREENHOUSE_RECRUITER_IDENTITY_JSON: "Authorization: Bearer leakage-token GREENHOUSE_CLIENT_SECRET=client-secret-value",
    } as NodeJS.ProcessEnv, () => Date.parse("2026-06-23T00:00:00.000Z"));

    assert.equal(report.ok, false);
    assert.equal(report.checks[0]!.name, "leakage_sample_startup");
    assert.equal(report.checks[0]!.summary, "Scope leakage sample startup failed before scoped evidence checks could run.");
    assert.doesNotMatch(JSON.stringify(report), /Authorization|Bearer|leakage-token|GREENHOUSE_CLIENT_SECRET|client-secret-value/);
  });

  it("drops unsafe ids from leakage sample id-list env values", () => {
    assert.deepStrictEqual(parseIdList("10, 9007199254740993, 20, 9007199254740992"), [10, 20]);
  });

  it("reports the actual persisted audit-event count for a non-memory sink, not checks.length", async () => {
    let emitted = 0;
    // A production-style sink with no `.events` array — the case where the old code substituted the
    // fabricated checks.length. The honest count is how many audit events were actually emitted.
    const recordingSink: AuditSink = { emit() { emitted += 1; } };
    const scopedReader = fakeScopedReader((toolName, _params, options) => {
      const preview = options?.actAsUser === 321;
      return scopedSuccess(toolName, [{ id: 10 }], null, {
        actorId: 900,
        effectiveActorId: preview ? 321 : 900,
        scoped: preview,
        permissionScope: preview ? { kind: "jobs", permittedJobCount: 1 } : { kind: "operator", permittedJobCount: null },
      });
    });

    const report = await runScopeLeakageSample({
      session: testSession({ subject: "operator", surface: "chatgpt_desktop" }),
      scopedReader,
      actAsUser: 321,
      auditSink: recordingSink,
      now: () => Date.parse("2026-06-23T00:00:00.000Z"),
    });

    // Two evidence reads emit a v2 start + terminal pair each; the three sample checks are not 1:1 with persisted
    // events, so checks.length would have been a lie.
    assert.equal(emitted, 4);
    assert.equal(report.auditEventCount, 4);
    assert.equal(report.auditEventCount, emitted);
    assert.notEqual(report.auditEventCount, report.checks.length);
  });
});
