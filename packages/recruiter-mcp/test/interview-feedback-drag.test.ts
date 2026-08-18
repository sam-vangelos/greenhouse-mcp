import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS } from "../src/limits.js";
import { runInterviewFeedbackDrag } from "../src/tools/interview-feedback-drag.js";
import { analysisRuntime, fakeScopedReader, operatorInventory, scopedDenial, scopedSuccess, testRuntime } from "./test-helpers.js";
import { nestedScorecard } from "./fixtures-production-shapes.js";

describe("interview feedback drag analysis", () => {
  it("attributes feedback drag by nested interviewer/submitter shape, not one 'unknown' bucket (production-shape lock — B1)", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_scorecards") {
        return scopedSuccess(toolName, [
          nestedScorecard({ id: 1, application_id: 10, interviewer: { id: 5 } }),
          nestedScorecard({ id: 2, application_id: 20, submitted_by: { id: 6 } }),
        ]);
      }
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [{ id: 10, jobs: [{ id: 100 }] }, { id: 20, jobs: [{ id: 200 }] }]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(scopedReader);
    const result = await runInterviewFeedbackDrag(runtime, { due_days: 2 });
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    const personKeys = data.rankings.map((row: any) => row.person_key);
    assert.ok(!personKeys.includes("unknown"), "no scorecard may collapse to an 'unknown' interviewer under the production nested shape");
    assert.deepStrictEqual([...personKeys].sort(), ["greenhouse_user:5", "greenhouse_user:6"], "person attribution must read nested interviewer:{id}/submitted_by:{id}");
  });

  it("denies a no-scope analysis for a broad-access operator without running an org-wide read", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      throw new Error(`operator no-scope analysis must not read org-wide (called ${toolName})`);
    });
    const { runtime } = analysisRuntime(scopedReader, { jobInventory: operatorInventory() });
    const result = await runInterviewFeedbackDrag(runtime, {});
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "INVALID_REQUEST");
    assert.equal(scopedReader.calls.length, 0, "no scoped read runs for an unscoped operator analysis");
  });

  it("ranks delayed and missing feedback with scoped evidence and affected jobs", async () => {
    const scopedReader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_scorecards") {
        assert.equal(params?.created_at, "gte|2026-05-24T12:00:00.000Z");
        assert.equal(params?.detail_profile, undefined);
        assert.equal(params?.evidence_pack, undefined);
        assert.equal(params?.evidence_pack_limit, undefined);
        return scopedSuccess(toolName, [
          { id: 1, application_id: 10, interviewer_id: 5, submitter_id: 5, status: "submitted", submitted_at: "2026-06-15T00:00:00.000Z", interviewed_at: "2026-06-14T00:00:00.000Z" },
          { id: 2, application_id: 10, interviewer_id: 5, submitter_id: 5, status: "submitted", submitted_at: "2026-06-15T00:00:00.000Z", interviewed_at: "2026-06-10T00:00:00.000Z" },
          { id: 3, application_id: 20, interviewer_id: 6, submitter_id: null, status: "pending", submitted_at: null, interviewed_at: "2026-06-19T12:00:00.000Z" },
          { id: 4, application_id: 20, interviewer_id: 6, submitter_id: null, status: "pending", submitted_at: null, interviewed_at: "2026-06-10T12:00:00.000Z" },
        ], null, { rowCounts: { raw: 5, returned: 4 } });
      }
      if (toolName === "list_applications") {
        assert.equal(params?.ids, "10,20");
        assert.equal(params?.per_page, 100);
        return scopedSuccess(toolName, [{ id: 10, jobs: [{ id: 100 }] }, { id: 20, jobs: [{ id: 200 }] }]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime, auditSink } = analysisRuntime(scopedReader);

    const result = await runInterviewFeedbackDrag(runtime, { due_days: 2, evidence_pack: true, evidence_pack_limit: 3 });

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.summary.feedback_due_days, 2);
    assert.equal(data.summary.rows_read, 5);
    assert.equal(data.summary.rows_considered, 4);
    assert.equal(data.summary.scoped_job_count, 2);
    assert.equal(data.metrics.scorecards_considered, 4);
    assert.equal(data.metrics.submitted_scorecards, 2);
    assert.equal(data.metrics.late_or_unsubmitted_scorecards, 3);
    assert.equal(data.metrics.unsubmitted_scorecards, 2);
    assert.equal(data.metrics.late_or_unsubmitted_rate, 0.75);
    assert.deepStrictEqual(data.fact_metric_layer.required_facts, ["scorecard_fact"]);
    assert.deepStrictEqual(data.fact_metric_layer.required_metrics, [
      "interview_feedback_sla_breach_rate",
      "scheduled_interview_to_feedback_hours",
      "scorecard_submission_rate",
    ]);
    assert.equal(data.fact_metric_layer.completeness.status, "complete");
    assert.ok(data.fact_metric_layer.completeness.evidence_refs.includes("scorecard:4"));
    assert.deepStrictEqual(data.rankings.map((row: any) => row.person_key), ["greenhouse_user:6", "greenhouse_user:5"]);
    assert.deepStrictEqual(data.rankings[0].affected_jobs, [200]);
    assert.equal(data.rankings[0].late_or_unsubmitted_scorecards, 2);
    assert.equal(data.rankings[0].unsubmitted_scorecards, 2);
    assert.ok(data.rankings[0].evidence_ids.includes("scorecard:4"));
    assert.ok(data.rankings[0].evidence_ids.includes("application:20"));
    assert.deepStrictEqual(data.evidence_pack.ids, ["scorecard:3", "application:20", "scorecard:4"]);
    assert.equal(data.evidence_pack.by_type.scorecard.returned_ids, 2);
    assert.equal(data.evidence_pack.by_type.application.returned_ids, 1);
    assert.equal(data.data, undefined);
    assert.equal(data.completeness.status, "complete");
    assert.equal(data.completeness.total_records_in_scope, 4);
    assert.equal(data.completeness.records_analyzed, 4);
    assert.equal(data.completeness.records_excluded, 0);
    // #38: graded confidence_summary removed; attribution_summary reports finding count +
    // unresolved records, no fake high/medium/low grade.
    assert.equal(data.confidence_summary, undefined);
    assert.equal(data.attribution_summary.findings_ranked, 2);
    assert.equal(data.attribution_summary.unresolved, 0);
    assert.ok(
      !("high" in data.attribution_summary) &&
        !("medium" in data.attribution_summary) &&
        !("low" in data.attribution_summary)
    );
    assert.deepStrictEqual(data.unresolved_evidence, []);
    assert.equal(auditSink.events.length, 1);
    assert.equal(auditSink.events[0]!.tool, "analyze_interview_feedback_drag");
    assert.equal(auditSink.events[0]!.rowsRead, 5);
    assert.equal(auditSink.events[0]!.rowsReturned, 4);
    assert.equal(auditSink.events[0]!.permissionScopeKind, "jobs");
  });

  it("supports operator actAsUser preview without trusting tool params", async () => {
    const scopedReader = fakeScopedReader((toolName, params, options) => {
      assert.equal(params?.actAsUser, undefined);
      assert.equal(params?.detail_profile, undefined);
      assert.equal(options?.actAsUser, 321);
      assert.ok(options?.signal instanceof AbortSignal);
      if (toolName === "list_scorecards") {
        return scopedSuccess(toolName, [], null, {
          actorId: 900,
          effectiveActorId: 321,
          permissionScope: { kind: "jobs", permittedJobCount: 1 },
        });
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime, auditSink } = analysisRuntime(scopedReader, { trustedActAsUser: 321 });

    const result = await runInterviewFeedbackDrag(runtime, { actAsUser: 123 });

    assert.equal(result.ok, true);
    assert.equal(auditSink.events[0]!.operator, true);
    assert.equal(auditSink.events[0]!.actAsUser, 321);
    assert.equal(auditSink.events[0]!.actorGreenhouseUserId, 900);
    assert.equal(auditSink.events[0]!.effectiveGreenhouseUserId, 321);
  });

  it("defaults unsafe due_days values instead of propagating non-finite analysis knobs", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime } = analysisRuntime(scopedReader);

    const result = await runInterviewFeedbackDrag(runtime, { due_days: "9".repeat(65) });

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.summary.feedback_due_days, 2);
  });

  it("drops feedback observations whose application job association cannot be resolved during analysis", async () => {
    const scopedReader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_scorecards") {
        return scopedSuccess(toolName, [
          { id: 1, application_id: 10, interviewer_id: 5, submitter_id: null, status: "pending", submitted_at: null, interviewed_at: "2026-06-10T00:00:00.000Z" },
          { id: 2, application_id: 20, interviewer_id: 6, submitter_id: null, status: "pending", submitted_at: null, interviewed_at: "2026-06-10T00:00:00.000Z" },
          { id: 3, application_id: null, interviewer_id: 7, submitter_id: null, status: "pending", submitted_at: null, interviewed_at: "2026-06-10T00:00:00.000Z" },
        ], null, { rowCounts: { raw: 3, returned: 3 } });
      }
      if (toolName === "list_applications") {
        assert.equal(params?.ids, "10,20");
        assert.equal(params?.per_page, 100);
        return scopedSuccess(toolName, [{ id: 10, job_id: 100 }]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime, auditSink } = analysisRuntime(scopedReader);

    const result = await runInterviewFeedbackDrag(runtime, {});

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.summary.rows_read, 3);
    assert.equal(data.summary.rows_considered, 1);
    assert.equal(data.summary.rows_dropped_unresolved_job_association, 2);
    assert.equal(data.metrics.scorecards_considered, 1);
    assert.deepStrictEqual(data.rankings.map((row: any) => row.person_key), ["greenhouse_user:5"]);
    assert.deepStrictEqual(data.rankings[0].affected_jobs, [100]);
    assert.deepStrictEqual(data.rankings[0].evidence_ids, ["scorecard:1", "application:10"]);
    assert.equal(auditSink.events[0]!.rowsReturned, 1);
  });

  it("narrows analysis to the requested job subset, excluding feedback from other permitted jobs (scope re-application — Slice B)", async () => {
    const scopedReader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_jobs") {
        return scopedSuccess(toolName, [{ id: 100 }, { id: 200 }]);
      }
      if (toolName === "list_scorecards") {
        return scopedSuccess(toolName, [
          { id: 1, application_id: 10, interviewer_id: 5, submitter_id: null, status: "pending", submitted_at: null, interviewed_at: "2026-06-15T00:00:00.000Z" },
          { id: 2, application_id: 20, interviewer_id: 6, submitter_id: null, status: "pending", submitted_at: null, interviewed_at: "2026-06-15T00:00:00.000Z" },
        ], null, { rowCounts: { raw: 2, returned: 2 } });
      }
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [{ id: 10, job_id: 100 }, { id: 20, job_id: 200 }]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = testRuntime(scopedReader);

    const result = await runInterviewFeedbackDrag(runtime, { job_ids: "100" });

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.metrics.scorecards_considered, 1, "only the requested job's feedback is analyzed");
    assert.equal(data.summary.scoped_job_count, 1);
    assert.equal(data.summary.rows_dropped_outside_requested_scope, 1, "the other permitted job's scorecard is excluded as out-of-scope");
    assert.deepStrictEqual(data.rankings.map((row: any) => row.person_key), ["greenhouse_user:5"]);
    assert.deepStrictEqual(data.rankings[0].affected_jobs, [100]);
  });

  it("bridges a narrowed job scope through application_ids and never sends job_ids to /v3/scorecards (F5 — live 422 regression lock)", async () => {
    const scopedReader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [{ id: 10, job_id: 9001004 }]);
      }
      if (toolName === "list_scorecards") {
        if (params?.job_ids !== undefined) {
          // Reproduce Harvest's 422 rejection of job_ids on /v3/scorecards.
          return scopedDenial(toolName, "TOOL_NOT_AVAILABLE");
        }
        return scopedSuccess(toolName, [
          { id: 1, application_id: 10, interviewer_id: 5, submitter_id: null, status: "pending", submitted_at: null, interviewed_at: "2026-06-10T00:00:00.000Z" },
        ], null, { rowCounts: { raw: 1, returned: 1 } });
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(scopedReader);

    const result = await runInterviewFeedbackDrag(runtime, { job_ids: "9001004" });

    assert.equal(result.ok, true, "a narrowed feedback-drag analysis must succeed via the application_ids bridge");
    const scorecardCalls = scopedReader.calls.filter((c) => c.toolName === "list_scorecards");
    assert.ok(scorecardCalls.length > 0, "expected a scorecard read");
    for (const c of scorecardCalls) {
      assert.equal(c.params?.job_ids, undefined, "list_scorecards must never receive job_ids (/v3/scorecards 422s on it)");
    }
    assert.ok(scorecardCalls.some((c) => c.params?.application_ids !== undefined), "scorecards read by application_ids (the L1 bridge)");
  });

  it("fails closed when secondary application-job lookup is denied", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_scorecards") {
        return scopedSuccess(toolName, [
          { id: 1, application_id: 10, interviewer_id: 5, submitter_id: null, status: "pending", submitted_at: null, interviewed_at: "2026-06-10T00:00:00.000Z" },
        ], null, { rowCounts: { raw: 1, returned: 1 } });
      }
      if (toolName === "list_applications") {
        return scopedDenial(toolName, "PERMISSION_LOOKUP_FAILED");
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime, auditSink } = analysisRuntime(scopedReader);

    const result = await runInterviewFeedbackDrag(runtime, {});

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "PERMISSION_LOOKUP_FAILED");
    assert.deepStrictEqual(scopedReader.calls.map((call) => call.toolName), ["list_scorecards", "list_applications"]);
    assert.equal(auditSink.events[0]!.denialCode, "PERMISSION_LOOKUP_FAILED");
    assert.equal(auditSink.events[0]!.rowsRead, null);
  });

  it("drops feedback observations with unsafe application ids before secondary job lookup", async () => {
    const unsafeId = Number.MAX_SAFE_INTEGER + 1;
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_scorecards") {
        return scopedSuccess(toolName, [
          { id: unsafeId, application_id: unsafeId, interviewer_id: unsafeId, submitter_id: null, status: "pending", submitted_at: null, interviewed_at: "2026-06-10T00:00:00.000Z" },
        ], null, { rowCounts: { raw: 1, returned: 1 } });
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(scopedReader);

    const result = await runInterviewFeedbackDrag(runtime, {});

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.summary.rows_read, 1);
    assert.equal(data.summary.rows_considered, 0);
    assert.equal(data.summary.rows_dropped_unresolved_job_association, 1);
    assert.equal(data.metrics.scorecards_considered, 0);
    assert.deepStrictEqual(data.rankings, []);
    assert.deepStrictEqual(scopedReader.calls.map((call) => call.toolName), ["list_scorecards"]);
    assert.doesNotMatch(JSON.stringify(data), /9007199254740992|9007199254740993/);
  });

  it("returns scoped denials without falling through", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedDenial(toolName, "PERMISSION_LOOKUP_FAILED"));
    const { runtime, auditSink } = analysisRuntime(scopedReader);

    const result = await runInterviewFeedbackDrag(runtime, {});

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "PERMISSION_LOOKUP_FAILED");
    assert.equal(auditSink.events[0]!.denialCode, "PERMISSION_LOOKUP_FAILED");
  });

  it("stops secondary application lookups when the analysis deadline is exhausted", async () => {
    const startedAt = Date.parse("2026-06-23T12:00:00.000Z");
    let now = startedAt;
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_scorecards") {
        now = startedAt + 10;
        return scopedSuccess(toolName, [
          { id: 1, application_id: 10, interviewer_id: 5, status: "pending", submitted_at: null, interviewed_at: "2026-06-10T00:00:00.000Z" },
          { id: 2, application_id: 20, interviewer_id: 6, status: "pending", submitted_at: null, interviewed_at: "2026-06-10T00:00:00.000Z" },
        ]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime, auditSink } = analysisRuntime(scopedReader, {
      now: () => now,
      limits: { ...DEFAULT_LIMITS, maxToolDurationMs: 5, maxAnalysisDurationMs: 5 },
    });

    const result = await runInterviewFeedbackDrag(runtime, {});

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "TOOL_TIMEOUT");
    assert.deepStrictEqual(scopedReader.calls.map((call) => call.toolName), ["list_scorecards"]);
    assert.equal(auditSink.events[0]!.denialCode, "TOOL_TIMEOUT");
  });

  it("lets an explicit window run past the lookback cap; fuzzy windows stay capped (T2.2)", async () => {
    const scopedReader = fakeScopedReader(() => scopedSuccess("list_scorecards", []));
    const { runtime } = analysisRuntime(scopedReader, {
      limits: {
        maxPerPage: 100,
        defaultPerPage: 100,
        maxLookbackDays: 10,
        maxRankings: 25,
        maxEvidenceIds: 200,
        maxToolDurationMs: 30_000,
      },
    });

    // T2.2: an EXPLICIT two-sided window RUNS past maxLookbackDays (the cap is applied
    // in-memory after a full read, so it guards no API cost - 9179880 pattern).
    const result = await runInterviewFeedbackDrag(runtime, {
      window_start: "2026-01-01T00:00:00.000Z",
      window_end: "2026-06-23T00:00:00.000Z",
    });
    assert.equal(result.ok, true, "an explicit window exceeding the cap must run, not deny");
    assert.ok(scopedReader.calls.length > 0, "the read must actually happen");

    // The FUZZY one-sided window stays capped: an ancient window_start with a defaulted end
    // exceeds the lookback limit and denies before any read.
    const fuzzy = await runInterviewFeedbackDrag(runtime, { window_start: "2020-01-01T00:00:00.000Z" });
    assert.equal(fuzzy.ok, false);
    assert.equal(fuzzy.ok === false && fuzzy.denial.code, "LIMIT_EXCEEDED");
  });

  it("denies malformed analysis windows before reading scorecards", async () => {
    const scopedReader = fakeScopedReader(() => scopedSuccess("list_scorecards", []));
    const { runtime } = analysisRuntime(scopedReader);

    const result = await runInterviewFeedbackDrag(runtime, { window_end: "not-a-date" });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "LIMIT_EXCEEDED");
    assert.equal(scopedReader.calls.length, 0);
  });
});
