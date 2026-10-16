import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSignedSessionToken } from "../src/auth.js";
import { parseIdList, runRecruiterReadinessProbe, runRecruiterReadinessProbeFromEnv } from "../src/probe.js";
import { REQUIRED_LIVE_PROBE_CHECKS } from "../src/rollout-gate.js";
import { fakeScopedReader, scopedDenial, scopedSuccess, testSession } from "./test-helpers.js";

const SECRET = "0123456789abcdef0123456789abcdef";

describe("recruiter readiness probe", () => {
  it("exercises scoped evidence and scorecard analysis without leaking raw rows", async () => {
    const scopedReader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_jobs") {
        if (params?.ids === "10") return scopedSuccess(toolName, [{ id: 10 }]);
        if (params?.ids === "20") return scopedSuccess(toolName, []);
        return scopedSuccess(toolName, [{ id: 10, name: "Job 10", status: "open" }, { id: 11, name: "Job 11", status: "open" }]);
      }
      if (toolName === "list_job_owners") {
        return scopedSuccess(toolName, [{ job_id: 10, user_id: 100, type: "recruiter", responsible: false }]);
      }
      if (toolName === "get_job" && params?.id === 10) {
        return scopedSuccess(toolName, { id: 10 });
      }
      if (toolName === "get_job" && params?.id === 20) {
        return scopedSuccess(toolName, null);
      }
      if (toolName === "list_applications") {
        const row = { id: 100, job_id: 10, candidate_id: 200 };
        if (params?.ids && params.ids !== "100") return scopedSuccess(toolName, []);
        if (params?.job_ids && params.job_ids !== "10") return scopedSuccess(toolName, []);
        if (params?.candidate_ids && params.candidate_ids !== "200") return scopedSuccess(toolName, []);
        return scopedSuccess(toolName, [row]);
      }
      if (toolName === "list_candidates") {
        return scopedSuccess(toolName, [{ id: 200, private: false, last_activity_at: "2026-06-20T00:00:00.000Z" }]);
      }
      if (toolName === "list_scorecards") {
        assert.equal(params?.detail_profile, undefined);
        if (params?.application_ids && params.application_ids !== "100") return scopedSuccess(toolName, []);
        return scopedSuccess(toolName, [
          { id: 500, application_id: 100, interviewer_id: 7, status: "submitted", submitted_at: "2026-06-20T00:00:00.000Z", interviewed_at: "2026-06-19T00:00:00.000Z" },
          { id: 501, application_id: 100, interviewer_id: 8, status: "pending", submitted_at: null, interviewed_at: "2026-06-18T00:00:00.000Z" },
        ]);
      }
      if (toolName === "list_notes") {
        return scopedSuccess(toolName, [{ id: 900, visibility: "Public" }]);
      }
      if (toolName === "list_rejection_details") {
        return scopedSuccess(toolName, []);
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });

    const report = await runRecruiterReadinessProbe({
      session: testSession(),
      scopedReader,
      expectedJobIds: [10],
      forbiddenJobIds: [20],
      now: () => Date.parse("2026-06-23T12:00:00.000Z"),
      env: {},
    });

    assert.equal(report.ok, true);
    assert.equal(report.strict, false);
    assert.equal(report.surface, "test");
    assert.ok(report.auditEventCount >= 7);
    assert.equal(report.checks.find((check) => check.name === "activity_endpoint_shape")?.status, "skip");
    assert.equal(report.checks.some((check) => check.status === "fail"), false);
    assert.equal(report.checks.find((check) => check.name === "candidate_shape_sample")?.status, "pass");
    assert.ok(scopedReader.calls.some((call) => call.toolName === "list_jobs"));
    assert.ok(scopedReader.calls.some((call) => call.toolName === "list_candidates"));
    assert.ok(scopedReader.calls.some((call) => call.toolName === "list_scorecards"));
    assert.equal(report.checks.find((check) => check.name === "interview_feedback_drag_analysis")?.status, "pass");
    assert.equal(report.checks.find((check) => check.name === "source_quality_analysis")?.status, "pass");
    assert.equal(report.checks.find((check) => check.name === "rejection_reason_drift_analysis")?.status, "pass");
    assert.equal(report.checks.find((check) => check.name === "question_planner_analysis")?.status, "pass");
  });

  it("fails when a forbidden job id is visible through the scoped reader", async () => {
    const scopedReader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_jobs" || toolName === "list_job_owners" || toolName === "list_applications" || toolName === "list_candidates" || toolName === "list_scorecards" || toolName === "list_notes" || toolName === "list_rejection_details") {
        return scopedSuccess(toolName, []);
      }
      if (toolName === "get_job" && params?.id === 20) {
        return scopedSuccess(toolName, { id: 20 });
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });

    const report = await runRecruiterReadinessProbe({
      session: testSession(),
      scopedReader,
      forbiddenJobIds: [20],
      now: () => Date.parse("2026-06-23T12:00:00.000Z"),
      env: {},
    });

    assert.equal(report.ok, false);
    assert.equal(
      report.checks.find((check) => check.name === "forbidden_job_exclusion" && check.status === "fail")?.summary,
      "Forbidden exact job read returned data through scoped reads."
    );
  });

  it("fails when an exact forbidden-job read returns an unrelated row", async () => {
    const scopedReader = fakeScopedReader((toolName, params) => {
      if (toolName === "get_job" && params?.id === 20) return scopedSuccess(toolName, { id: 10 });
      if (["list_jobs", "list_job_owners", "list_applications", "list_candidates", "list_scorecards", "list_notes", "list_rejection_details"].includes(toolName)) {
        return scopedSuccess(toolName, []);
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });

    const report = await runRecruiterReadinessProbe({
      session: testSession(),
      scopedReader,
      forbiddenJobIds: [20],
      now: () => Date.parse("2026-06-23T12:00:00.000Z"),
      env: {},
    });

    const check = report.checks.find((entry) => entry.name === "forbidden_job_exclusion");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.equal(check?.details?.jobId, 20);
    assert.equal(check?.details?.returnedId, 10);
  });

  it("does not treat infrastructure denial or ignored forbidden-id filters as exclusion proof", async () => {
    const deniedReader = fakeScopedReader((toolName) => {
      if (toolName === "get_job") return scopedDenial(toolName, "PERMISSION_LOOKUP_FAILED");
      if (["list_jobs", "list_applications", "list_candidates", "list_scorecards", "list_notes", "list_rejection_details"].includes(toolName)) {
        return scopedSuccess(toolName, []);
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const denied = await runRecruiterReadinessProbe({
      session: testSession(),
      scopedReader: deniedReader,
      forbiddenJobIds: [20],
      env: {},
    });
    assert.equal(denied.checks.find((check) => check.name === "forbidden_job_exclusion")?.status, "fail");

    const ignoredFilterReader = fakeScopedReader((toolName, params) => {
      if (toolName === "get_job") return scopedSuccess(toolName, null);
      if (toolName === "list_jobs" && params?.ids === "20") return scopedSuccess(toolName, [{ id: 10 }]);
      if (["list_jobs", "list_applications", "list_candidates", "list_scorecards", "list_notes", "list_rejection_details"].includes(toolName)) {
        return scopedSuccess(toolName, []);
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const ignoredFilter = await runRecruiterReadinessProbe({
      session: testSession(),
      scopedReader: ignoredFilterReader,
      forbiddenJobIds: [20],
      env: {},
    });
    const endpoint = ignoredFilter.checks.find((check) => check.name === "endpoint_contract_forbidden_jobs_ids");
    assert.equal(endpoint?.status, "fail");
    assert.equal(endpoint?.details?.unexpectedRows, 1);
  });

  it("keeps default probes non-strict when live rollout ids and shape samples are missing", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_jobs" || toolName === "list_job_owners" || toolName === "list_applications" || toolName === "list_candidates" || toolName === "list_scorecards" || toolName === "list_notes" || toolName === "list_rejection_details") {
        return scopedSuccess(toolName, []);
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });

    const report = await runRecruiterReadinessProbe({
      session: testSession(),
      scopedReader,
      now: () => Date.parse("2026-06-23T12:00:00.000Z"),
      env: {},
    });

    assert.equal(report.ok, true);
    assert.equal(report.strict, false);
    assert.equal(report.checks.find((check) => check.name === "candidate_shape_sample")?.status, "pass");
    assert.equal(report.checks.find((check) => check.name === "scorecard_shape_sample")?.status, "pass");
    assert.equal(report.checks.some((check) => check.name.startsWith("strict_")), false);
  });

  it("strict mode fails when live rollout validation ids are missing", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_jobs") return scopedSuccess(toolName, [{ id: 10, name: "Job 10", status: "open" }]);
      if (toolName === "list_job_owners") return scopedSuccess(toolName, [{ job_id: 10, user_id: 100, type: "recruiter" }]);
      if (toolName === "list_applications") return scopedSuccess(toolName, [{ id: 100, job_id: 10 }]);
      if (toolName === "list_candidates") return scopedSuccess(toolName, [{ id: 200, private: false }]);
      if (toolName === "list_scorecards") return scopedSuccess(toolName, [
        { id: 500, application_id: 100, interviewer_id: 7, status: "submitted", submitted_at: "2026-06-20T00:00:00.000Z", interviewed_at: "2026-06-19T00:00:00.000Z" },
      ]);
      if (toolName === "get_application") return scopedSuccess(toolName, { id: 100, job_id: 10 });
      if (toolName === "list_notes") return scopedSuccess(toolName, [{ id: 900, visibility: "Public" }]);
      if (toolName === "list_rejection_details") return scopedSuccess(toolName, []);
      throw new Error(`unexpected scoped tool ${toolName}`);
    });

    const report = await runRecruiterReadinessProbe({
      session: testSession(),
      scopedReader,
      strict: true,
      now: () => Date.parse("2026-06-23T12:00:00.000Z"),
      env: {},
    });

    assert.equal(report.ok, false);
    assert.equal(report.strict, true);
    assert.equal(report.checks.find((check) => check.name === "strict_expected_job_ids_required")?.status, "fail");
    assert.equal(report.checks.find((check) => check.name === "strict_forbidden_job_ids_required")?.status, "fail");
  });

  it("strict mode fails when shape validation warnings remain", async () => {
    const scopedReader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_jobs") return scopedSuccess(toolName, [{ id: 10, name: "Job 10", status: "open" }]);
      if (toolName === "list_job_owners") return scopedSuccess(toolName, [{ job_id: 10, user_id: 100, type: "sourcer" }]);
      if (toolName === "get_job" && params?.id === 10) return scopedSuccess(toolName, { id: 10 });
      if (toolName === "get_job" && params?.id === 20) return scopedSuccess(toolName, null);
      if (toolName === "list_candidates") return scopedSuccess(toolName, [{ private: false }]);
      if (toolName === "list_applications" || toolName === "list_scorecards" || toolName === "list_notes" || toolName === "list_rejection_details") {
        return scopedSuccess(toolName, []);
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });

    const report = await runRecruiterReadinessProbe({
      session: testSession(),
      scopedReader,
      strict: true,
      expectedJobIds: [10],
      forbiddenJobIds: [20],
      now: () => Date.parse("2026-06-23T12:00:00.000Z"),
      env: {},
    });

    assert.equal(report.ok, false);
    assert.deepStrictEqual(
      (report.checks.find((check) => check.name === "strict_warnings_clear")?.details as any)?.warningChecks,
      ["candidate_shape_sample"]
    );
  });

  it("does not copy sensitive startup exception text into readiness evidence", async () => {
    const session = testSession({ surface: "claude_desktop" });
    const token = createSignedSessionToken(session, SECRET);
    const report = await runRecruiterReadinessProbeFromEnv({
      GREENHOUSE_RECRUITER_SESSION_SECRET: SECRET,
      GREENHOUSE_RECRUITER_SESSION_TOKEN: token,
      GREENHOUSE_CLIENT_ID: "client-id",
      GREENHOUSE_CLIENT_SECRET: "client-secret-value",
      GREENHOUSE_RECRUITER_IDENTITY_JSON: "Authorization: Bearer live-session-token GREENHOUSE_CLIENT_SECRET=client-secret-value",
    } as NodeJS.ProcessEnv, () => Date.parse("2026-06-23T12:00:00.000Z"));

    assert.equal(report.ok, false);
    assert.equal(report.checks[0]!.name, "probe_startup");
    assert.equal(report.checks[0]!.summary, "Readiness probe startup failed before scoped evidence checks could run.");
    assert.doesNotMatch(JSON.stringify(report), /Authorization|Bearer|live-session-token|GREENHOUSE_CLIENT_SECRET|client-secret-value/);
  });

  it("parses unique positive id lists from probe env values", () => {
    assert.deepStrictEqual(parseIdList("10, 20, nope, 10, 0, -1, 9007199254740993"), [10, 20]);
    assert.deepStrictEqual(parseIdList(undefined), []);
  });

  it("reports forbidden_job_exclusion as skip (not pass) when get_my_job is disabled", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (["list_jobs", "list_applications", "list_candidates", "list_scorecards", "list_notes", "list_rejection_details"].includes(toolName)) {
        return scopedSuccess(toolName, []);
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });

    const report = await runRecruiterReadinessProbe({
      session: testSession(),
      scopedReader,
      forbiddenJobIds: [20],
      now: () => Date.parse("2026-06-23T12:00:00.000Z"),
      env: { GREENHOUSE_RECRUITER_DISABLE_TOOLS: "get_my_job" } as NodeJS.ProcessEnv,
    });

    const forbidden = report.checks.find((check) => check.name === "forbidden_job_exclusion");
    assert.equal(forbidden?.status, "skip");
    assert.equal(forbidden?.details?.denialCode, "TOOL_DISABLED");
  });

  it("expectVisibleData fails the probe when a data-bearing analysis considered zero rows", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_jobs") return scopedSuccess(toolName, [{ id: 10, name: "Job 10", status: "open" }]);
      if (toolName === "list_job_owners") return scopedSuccess(toolName, [{ job_id: 10, user_id: 100, type: "recruiter" }]);
      // Applications/scorecards empty: stage_latency/pipeline/source consider 0 rows even though the
      // tool "completes". Without expectVisibleData this reports a green pass over empty data.
      if (["list_applications", "list_candidates", "list_scorecards", "list_notes", "list_rejection_details"].includes(toolName)) {
        return scopedSuccess(toolName, []);
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });

    const report = await runRecruiterReadinessProbe({
      session: testSession(),
      scopedReader,
      expectVisibleData: true,
      now: () => Date.parse("2026-06-23T12:00:00.000Z"),
      env: {},
    });

    assert.equal(report.ok, false);
    const stage = report.checks.find((check) => check.name === "stage_latency_analysis");
    assert.equal(stage?.status, "fail");
    assert.match(stage?.summary ?? "", /expected visible data/i);
  });

  it("emits every check the rollout gate requires (REQUIRED_LIVE_PROBE_CHECKS drift guard)", async () => {
    // A fully exercised probe (expected + forbidden ids) must emit every name the gate requires, so a
    // probe check rename that orphans a gate-required name is caught here, not silently at deploy.
    const scopedReader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_jobs") {
        if (params?.ids === "10") return scopedSuccess(toolName, [{ id: 10 }]);
        if (params?.ids === "20") return scopedSuccess(toolName, []);
        return scopedSuccess(toolName, [{ id: 10, name: "Job 10", status: "open" }, { id: 11, name: "Job 11", status: "open" }]);
      }
      if (toolName === "list_job_owners") return scopedSuccess(toolName, [{ job_id: 10, user_id: 100, type: "recruiter" }]);
      if (toolName === "get_job" && params?.id === 10) return scopedSuccess(toolName, { id: 10 });
      if (toolName === "get_job" && params?.id === 20) return scopedSuccess(toolName, null);
      if (toolName === "list_applications") {
        const row = { id: 100, job_id: 10, candidate_id: 200 };
        if (params?.ids && params.ids !== "100") return scopedSuccess(toolName, []);
        if (params?.job_ids && params.job_ids !== "10") return scopedSuccess(toolName, []);
        if (params?.candidate_ids && params.candidate_ids !== "200") return scopedSuccess(toolName, []);
        return scopedSuccess(toolName, [row]);
      }
      if (toolName === "list_candidates") return scopedSuccess(toolName, [{ id: 200, private: false, last_activity_at: "2026-06-20T00:00:00.000Z" }]);
      if (toolName === "list_scorecards") {
        if (params?.application_ids && params.application_ids !== "100") return scopedSuccess(toolName, []);
        return scopedSuccess(toolName, [
          { id: 500, application_id: 100, interviewer_id: 7, status: "submitted", submitted_at: "2026-06-20T00:00:00.000Z", interviewed_at: "2026-06-19T00:00:00.000Z" },
        ]);
      }
      if (toolName === "list_notes") return scopedSuccess(toolName, [{ id: 900, visibility: "Public" }]);
      if (toolName === "list_rejection_details") return scopedSuccess(toolName, []);
      throw new Error(`unexpected scoped tool ${toolName}`);
    });

    const report = await runRecruiterReadinessProbe({
      session: testSession(),
      scopedReader,
      expectedJobIds: [10],
      forbiddenJobIds: [20],
      now: () => Date.parse("2026-06-23T12:00:00.000Z"),
      env: {},
    });

    const emitted = new Set(report.checks.map((check) => check.name));
    for (const required of REQUIRED_LIVE_PROBE_CHECKS) {
      assert.ok(emitted.has(required), `probe must emit gate-required check ${required}`);
    }
  });
});
