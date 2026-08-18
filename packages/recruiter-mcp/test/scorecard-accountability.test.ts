import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS } from "../src/limits.js";
import { createInMemoryRateLimiter } from "../src/rate-limit.js";
import { runScorecardAccountability } from "../src/tools/scorecard-accountability.js";
import { analysisRuntime, fakeScopedReader, operatorInventory, scopedDenial, scopedSuccess, testRuntime } from "./test-helpers.js";
import { nestedScorecard } from "./fixtures-production-shapes.js";

describe("scorecard accountability analysis", () => {
  it("attributes scorecards by nested interviewer/submitter shape, not one 'unknown' bucket (production-shape lock — B1)", async () => {
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
    const result = await runScorecardAccountability(runtime, {});
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    const personKeys = data.rankings.map((row: any) => row.person_key);
    assert.ok(!personKeys.includes("unknown"), "no scorecard may collapse to an 'unknown' interviewer under the production nested shape");
    assert.deepStrictEqual([...personKeys].sort(), ["greenhouse_user:5", "greenhouse_user:6"], "person attribution must read nested interviewer:{id}/submitted_by:{id}");
  });

  it("bridges a narrowed job scope through application_ids and never sends job_ids to /v3/scorecards (F5 — live 422 regression lock)", async () => {
    // Live bug: /v3/scorecards has NO job_ids filter — Harvest v3 REJECTS an unknown
    // job_ids param with 422 (it does not silently ignore it), so forwarding job_ids
    // failed the whole recipe. The read must bridge job -> application_ids (like
    // search_my_scorecards) and read scorecards by application_ids.
    const scopedReader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_applications") {
        // job -> application_ids derive (job_ids filter) AND the reverse attribution
        // lookup (ids filter) both resolve app 10 on the permitted job.
        return scopedSuccess(toolName, [{ id: 10, jobs: [{ id: 9001004 }] }]);
      }
      if (toolName === "list_scorecards") {
        if (params?.job_ids !== undefined) {
          // Reproduce Harvest's rejection of job_ids on /v3/scorecards.
          return scopedDenial(toolName, "TOOL_NOT_AVAILABLE");
        }
        return scopedSuccess(toolName, [
          { id: 1, application_id: 10, interviewer_id: 5, submitter_id: null, status: "to_be_submitted", submitted_at: null, interviewed_at: "2026-06-10T00:00:00.000Z" },
        ]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(scopedReader);

    const result = await runScorecardAccountability(runtime, { job_ids: "9001004" });

    assert.equal(result.ok, true, "a narrowed scorecard analysis must succeed via the application_ids bridge, not fail on a job_ids rejection");
    const scorecardCalls = scopedReader.calls.filter((c) => c.toolName === "list_scorecards");
    assert.ok(scorecardCalls.length > 0, "expected a scorecard read");
    for (const c of scorecardCalls) {
      assert.equal(c.params?.job_ids, undefined, "list_scorecards must never receive job_ids (/v3/scorecards 422s on it)");
    }
    assert.ok(
      scorecardCalls.some((c) => c.params?.application_ids !== undefined),
      "scorecards must be read by application_ids (the L1 bridge), not job_ids"
    );
  });

  it("denies a no-scope analysis for a broad-access operator without running an org-wide read", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      throw new Error(`operator no-scope analysis must not read org-wide (called ${toolName})`);
    });
    const { runtime } = analysisRuntime(scopedReader, { jobInventory: operatorInventory() });
    const result = await runScorecardAccountability(runtime, {});
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "INVALID_REQUEST");
    assert.equal(scopedReader.calls.length, 0, "no scoped read runs for an unscoped operator analysis");
  });

  it("computes unsubmitted rates, severity ranking, affected jobs, and evidence ids from scoped data", async () => {
    const scopedReader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_scorecards") {
        assert.equal(params?.created_at, "gte|2026-05-24T12:00:00.000Z");
        assert.equal(params?.detail_profile, undefined);
        assert.equal(params?.evidence_pack, undefined);
        assert.equal(params?.evidence_pack_limit, undefined);
        return scopedSuccess(toolName, [
          { id: 1, application_id: 10, interviewer_id: 5, submitter_id: 5, status: "submitted", submitted_at: "2026-06-15T00:00:00.000Z", interviewed_at: "2026-06-14T00:00:00.000Z" },
          { id: 2, application_id: 10, interviewer_id: 5, submitter_id: null, status: "pending", submitted_at: null, interviewed_at: "2026-06-10T00:00:00.000Z" },
          { id: 3, application_id: 20, interviewer_id: 6, submitter_id: null, status: "to_be_submitted", submitted_at: null, interviewed_at: "2026-06-01T00:00:00.000Z" },
        ], null, { rowCounts: { raw: 5, returned: 3 } });
      }
      if (toolName === "list_applications") {
        assert.equal(params?.ids, "10,20");
        assert.equal(params?.per_page, 100);
        return scopedSuccess(toolName, [{ id: 10, jobs: [{ id: 100 }] }, { id: 20, jobs: [{ id: 200 }] }]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime, auditSink } = analysisRuntime(scopedReader);

    const result = await runScorecardAccountability(runtime, { evidence_pack: true, evidence_pack_limit: 2 });

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.summary.rows_read, 5);
    assert.equal(data.summary.pages_read, 1);
    assert.equal(data.summary.per_page, 500);
    assert.equal(data.summary.read_status, "complete");
    assert.equal(data.summary.read_complete, true);
    assert.equal(data.summary.page_limit, undefined);
    assert.equal(data.summary.pagination_truncated, false);
    assert.equal(data.metrics.total_scorecards, 3);
    assert.equal(data.metrics.unsubmitted_scorecards, 2);
    assert.equal(data.metrics.unsubmitted_scorecard_rate, 0.6667);
    assert.deepStrictEqual(data.fact_metric_layer.required_facts, ["scorecard_fact"]);
    assert.deepStrictEqual(data.fact_metric_layer.required_metrics, ["scorecard_submission_rate", "scorecard_overdue_rate"]);
    assert.equal(data.fact_metric_layer.metric_results.scorecard_submission_rate.value, 1 / 3);
    assert.equal(data.fact_metric_layer.metric_results.scorecard_overdue_rate.value, 2 / 3);
    assert.ok(data.fact_metric_layer.completeness.evidence_refs.includes("scorecard:3"));
    assert.equal(data.summary.scoped_job_count, 2);
    assert.deepStrictEqual(data.rankings.map((row: any) => row.person_key), ["greenhouse_user:6", "greenhouse_user:5"]);
    assert.deepStrictEqual(data.rankings[0].affected_jobs, [200]);
    assert.ok(data.rankings[0].evidence_ids.includes("scorecard:3"));
    assert.ok(data.rankings[0].evidence_ids.includes("application:20"));
    assert.equal(data.evidence_pack.returned_ids, 2);
    assert.equal(data.evidence_pack.truncated, true);
    assert.deepStrictEqual(data.evidence_pack.ids, ["application:20", "scorecard:3"]);
    assert.equal(data.evidence_pack.by_type.application.returned_ids, 1);
    assert.equal(data.evidence_pack.by_type.scorecard.returned_ids, 1);
    assert.match(data.evidence_pack.content_policy, /does not include candidate names/);
    assert.equal(data.data, undefined);
    assert.equal(data.completeness.status, "complete");
    assert.equal(data.completeness.total_records_in_scope, 3);
    assert.equal(data.completeness.records_analyzed, 3);
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
    assert.equal(auditSink.events[0]!.tool, "analyze_scorecard_accountability");
    assert.equal(auditSink.events[0]!.actorGreenhouseUserId, 100);
    assert.equal(auditSink.events[0]!.effectiveGreenhouseUserId, 100);
    assert.equal(auditSink.events[0]!.permissionScopeKind, "jobs");
    assert.equal(auditSink.events[0]!.permittedJobCount, 2);
    assert.equal(auditSink.events[0]!.rowsRead, 5);
  });

  it("follows scorecard cursor pages instead of truncating at maxPages", async () => {
    const scopedReader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_scorecards") {
        if (params?.cursor === "next-scorecard-page") {
          return scopedSuccess(toolName, [
            { id: 2, application_id: 20, interviewer_id: 6, submitter_id: null, status: "pending", submitted_at: null, interviewed_at: "2026-06-11T00:00:00.000Z" },
          ], null, { rowCounts: { raw: 1, returned: 1 } });
        }
        assert.equal(params?.per_page, 500);
        return scopedSuccess(toolName, [
          { id: 1, application_id: 10, interviewer_id: 5, submitter_id: null, status: "pending", submitted_at: null, interviewed_at: "2026-06-10T00:00:00.000Z" },
        ], "next-scorecard-page", { rowCounts: { raw: 1, returned: 1 } });
      }
      if (toolName === "list_applications") {
        assert.equal(params?.ids, "10,20");
        assert.equal(params?.per_page, 100);
        return scopedSuccess(toolName, [{ id: 10, job_id: 100 }, { id: 20, job_id: 200 }]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(scopedReader, {
      limits: { ...DEFAULT_LIMITS },
    });

    const result = await runScorecardAccountability(runtime, {});

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.summary.rows_read, 2);
    assert.equal(data.summary.pages_read, 2);
    assert.equal(data.summary.read_status, "complete");
    assert.equal(data.summary.read_complete, true);
    assert.equal(data.summary.pagination_truncated, false);
    assert.equal(data.summary.rows_considered, 2);
    assert.deepStrictEqual(scopedReader.calls.map((call) => call.toolName), ["list_scorecards", "list_scorecards", "list_applications"]);
  });

  it("audits operator actAsUser analysis with the preview target", async () => {
    const scopedReader = fakeScopedReader((toolName, params, options) => {
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

    const result = await runScorecardAccountability(runtime, {});

    assert.equal(result.ok, true);
    assert.equal(auditSink.events[0]!.operator, true);
    assert.equal(auditSink.events[0]!.actAsUser, 321);
    assert.equal(auditSink.events[0]!.actorGreenhouseUserId, 900);
    assert.equal(auditSink.events[0]!.effectiveGreenhouseUserId, 321);
    assert.equal(auditSink.events[0]!.permissionScopeKind, "jobs");
    assert.equal(auditSink.events[0]!.permittedJobCount, 1);
  });

  it("drops scorecards whose application job association cannot be resolved during analysis", async () => {
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

    const result = await runScorecardAccountability(runtime, {});

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.summary.rows_read, 3);
    assert.equal(data.summary.rows_considered, 1);
    assert.equal(data.summary.rows_dropped_unresolved_job_association, 2);
    assert.equal(data.metrics.total_scorecards, 1);
    assert.deepStrictEqual(data.rankings.map((row: any) => row.person_key), ["greenhouse_user:5"]);
    assert.deepStrictEqual(data.rankings[0].affected_jobs, [100]);
    assert.deepStrictEqual(data.rankings[0].evidence_ids, ["application:10", "scorecard:1"]);
    assert.equal(auditSink.events[0]!.rowsReturned, 1);
  });

  it("narrows analysis to the requested job subset, excluding scorecards from other permitted jobs (scope re-application — Slice B)", async () => {
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

    const result = await runScorecardAccountability(runtime, { job_ids: "100" });

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.metrics.total_scorecards, 1, "only the requested job's scorecards are analyzed");
    assert.equal(data.summary.scoped_job_count, 1);
    assert.equal(data.summary.rows_dropped_outside_requested_scope, 1, "the other permitted job's scorecard is excluded as out-of-scope");
    assert.deepStrictEqual(data.rankings.map((row: any) => row.person_key), ["greenhouse_user:5"]);
    assert.deepStrictEqual(data.rankings[0].affected_jobs, [100]);
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

    const result = await runScorecardAccountability(runtime, {});

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "PERMISSION_LOOKUP_FAILED");
    assert.deepStrictEqual(scopedReader.calls.map((call) => call.toolName), ["list_scorecards", "list_applications"]);
    assert.equal(auditSink.events[0]!.denialCode, "PERMISSION_LOOKUP_FAILED");
    assert.equal(auditSink.events[0]!.rowsRead, null);
  });

  it("drops scorecards with unsafe application ids before secondary job lookup", async () => {
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

    const result = await runScorecardAccountability(runtime, {});

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.summary.rows_read, 1);
    assert.equal(data.summary.rows_considered, 0);
    assert.equal(data.summary.rows_dropped_unresolved_job_association, 1);
    assert.equal(data.metrics.total_scorecards, 0);
    assert.deepStrictEqual(data.rankings, []);
    assert.deepStrictEqual(scopedReader.calls.map((call) => call.toolName), ["list_scorecards"]);
    assert.doesNotMatch(JSON.stringify(data), /9007199254740992|9007199254740993/);
  });

  it("fails closed without returning analysis data when audit logging is unavailable", async () => {
    const scopedReader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_scorecards") {
        return scopedSuccess(toolName, [
          { id: 1, application_id: 10, interviewer_id: 5, status: "pending", submitted_at: null, interviewed_at: "2026-06-10T00:00:00.000Z" },
        ]);
      }
      if (toolName === "list_applications") {
        assert.equal(params?.ids, "10");
        assert.equal(params?.per_page, 100);
        return scopedSuccess(toolName, [{ id: 10, job_id: 100 }]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(scopedReader, {
      auditSink: {
        emit() {
          throw new Error("audit writer failed for /secret/audit.jsonl password=hunter2");
        },
      },
    });

    const result = await runScorecardAccountability(runtime, {});

    assert.deepStrictEqual(scopedReader.calls.map((call) => call.toolName), []);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "AUDIT_UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(result), /application_id|severity_score|greenhouse_user:5|hunter2|secret\/audit/);
  });

  it("strips model-supplied identity params and never forwards job_ids to the scorecard read", async () => {
    const scopedReader = fakeScopedReader((toolName, params, options) => {
      assert.equal(params?.actAsUser, undefined);
      assert.equal(params?.on_behalf_of_user_id, undefined);
      assert.equal(params?.greenhouse_user_id, undefined);
      assert.equal(params?.greenhouseUserId, undefined);
      assert.equal(params?.email, undefined);
      assert.equal(params?.subject, undefined);
      assert.ok(options?.signal instanceof AbortSignal);
      if (toolName === "list_jobs") {
        return scopedSuccess(toolName, [{ id: 100 }, { id: 200 }]);
      }
      if (toolName === "list_applications") {
        // job -> application_ids derive (job_ids filter) and the app -> job attribution lookup (ids).
        return scopedSuccess(toolName, [{ id: 10, jobs: [{ id: 100 }] }, { id: 20, jobs: [{ id: 200 }] }]);
      }
      if (toolName === "list_scorecards") {
        // /v3/scorecards has no job_ids filter (422s on it): the scope is bridged to application_ids.
        assert.equal(params?.job_ids, undefined, "job_ids must never reach /v3/scorecards");
        assert.ok(params?.application_ids !== undefined, "scorecards are read by the bridged application_ids");
        assert.equal(params?.detail_profile, undefined);
        assert.equal(params?.include_attachment_urls, undefined);
        assert.equal(params?.reason, undefined);
        assert.equal(params?.status, undefined);
        assert.equal(params?.foo, undefined);
        return scopedSuccess(toolName, [], null, { rowCounts: { raw: 0, returned: 0 } });
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = testRuntime(scopedReader);

    const result = await runScorecardAccountability(runtime, {
      job_ids: "100,200",
      actAsUser: 123,
      on_behalf_of_user_id: 456,
      greenhouse_user_id: 789,
      greenhouseUserId: 999,
      email: "other@example.com",
      subject: "email:other@example.com",
      status: "submitted",
    });

    assert.equal(result.ok, true);
    assert.ok(scopedReader.calls.some((call) => call.toolName === "list_scorecards"), "a scorecard read must run");
    assert.ok(
      scopedReader.calls.some((call) => call.toolName === "list_applications" && call.params?.job_ids === "100,200"),
      "the narrowed scope is bridged job -> application_ids via /v3/applications"
    );
  });


  it("times out slow scoped analysis reads before returning data", async () => {
    const scopedReader = fakeScopedReader(() => new Promise(() => {}));
    const { runtime, auditSink } = analysisRuntime(scopedReader, {
      limits: { ...DEFAULT_LIMITS, maxToolDurationMs: 1, maxAnalysisDurationMs: 1 },
    });

    const result = await runScorecardAccountability(runtime, {});

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "TOOL_TIMEOUT");
    assert.equal(scopedReader.calls.length, 1);
    assert.equal(auditSink.events[0]!.denialCode, "TOOL_TIMEOUT");
    assert.equal(auditSink.events[0]!.rowsRead, null);
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

    const result = await runScorecardAccountability(runtime, {});

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "TOOL_TIMEOUT");
    assert.deepStrictEqual(scopedReader.calls.map((call) => call.toolName), ["list_scorecards"]);
    assert.equal(auditSink.events[0]!.denialCode, "TOOL_TIMEOUT");
  });

  it("returns permission denials from the scoped core without falling through", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedDenial(toolName, "PERMISSION_LOOKUP_FAILED"));
    const { runtime, auditSink } = analysisRuntime(scopedReader);

    const result = await runScorecardAccountability(runtime, {});

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "PERMISSION_LOOKUP_FAILED");
    assert.equal(auditSink.events[0]!.denialCode, "PERMISSION_LOOKUP_FAILED");
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
    const result = await runScorecardAccountability(runtime, {
      window_start: "2026-01-01T00:00:00.000Z",
      window_end: "2026-06-23T00:00:00.000Z",
    });
    assert.equal(result.ok, true, "an explicit window exceeding the cap must run, not deny");
    assert.ok(scopedReader.calls.length > 0, "the read must actually happen");

    // The FUZZY one-sided window stays capped: an ancient window_start with a defaulted end
    // exceeds the lookback limit and denies before any read.
    const fuzzy = await runScorecardAccountability(runtime, { window_start: "2020-01-01T00:00:00.000Z" });
    assert.equal(fuzzy.ok, false);
    assert.equal(fuzzy.ok === false && fuzzy.denial.code, "LIMIT_EXCEEDED");
  });

  it("denies malformed analysis windows before reading scorecards", async () => {
    const scopedReader = fakeScopedReader(() => scopedSuccess("list_scorecards", []));
    const { runtime } = analysisRuntime(scopedReader);

    const result = await runScorecardAccountability(runtime, { window_end: "not-a-date" });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "LIMIT_EXCEEDED");
    assert.equal(scopedReader.calls.length, 0);
  });

  it("rate-limits excessive analysis calls before paginated reads", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime, auditSink } = analysisRuntime(scopedReader, {
      rateLimiter: createInMemoryRateLimiter({
        windowMs: 60_000,
        maxCallsPerWindow: 10,
        maxAnalysisCallsPerWindow: 1,
      }),
    });

    const first = await runScorecardAccountability(runtime, {});
    const second = await runScorecardAccountability(runtime, {});

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.denial.code, "RATE_LIMITED");
    assert.equal(scopedReader.calls.length, 1);
    assert.equal(auditSink.events[1]!.denialCode, "RATE_LIMITED");
  });
});
