import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS } from "../src/limits.js";
import { runSourceQuality } from "../src/tools/source-quality.js";
import { analysisRuntime, fakeScopedReader, operatorInventory, scopedDenial, scopedSuccess } from "./test-helpers.js";

describe("source quality analysis", () => {
  it("denies a no-scope analysis for a broad-access operator without running an org-wide read", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      throw new Error(`operator no-scope analysis must not read org-wide (called ${toolName})`);
    });
    const { runtime } = analysisRuntime(scopedReader, { jobInventory: operatorInventory() });
    const result = await runSourceQuality(runtime, {});
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "INVALID_REQUEST");
    assert.equal(scopedReader.calls.length, 0, "no scoped read runs for an unscoped operator analysis");
  });

  it("ranks scoped sources and referrers by quality and risk, resolving ids to reference names", async () => {
    const scopedReader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_applications") {
        assert.equal(params?.per_page, 500);
        assert.equal(params?.source_ids, "1,2");
        assert.equal(params?.referrer_ids, "7,8");
        assert.equal(params?.window_start, undefined);
        assert.equal(params?.window_end, undefined);
        assert.equal(params?.stale_days, undefined);
        assert.equal(params?.evidence_pack, undefined);
        assert.equal(params?.evidence_pack_limit, undefined);
        assert.equal(params?.greenhouse_user_id, undefined);
        assert.equal(params?.detail_profile, undefined);
        assert.equal(params?.include_attachment_urls, undefined);
        assert.equal(params?.reason, undefined);
        assert.equal(params?.foo, undefined);
        return scopedSuccess(toolName, [
          { id: 1, candidate_id: 1001, jobs: [{ id: 10 }], source_id: 1, referrer_id: 7, status: "hired", applied_at: "2026-06-01T12:00:00.000Z", last_activity_at: "2026-06-22T12:00:00.000Z", source: { name: "Do not expose" }, referrer: { name: "Do not expose" } },
          { id: 2, candidate_id: 1002, jobs: [{ id: "10" }], source_id: 1, referrer_id: 7, status: "active", applied_at: "2026-06-05T12:00:00.000Z", last_activity_at: "2026-06-01T12:00:00.000Z" },
          { id: 3, candidate_id: 1003, jobs: [{ id: 20 }], source_id: 2, referrer_id: 8, status: "rejected", applied_at: "2026-06-10T12:00:00.000Z", last_activity_at: "2026-06-10T12:00:00.000Z" },
          { id: 4, candidate_id: 1004, jobs: [{ id: "20" }], source: { id: 2, name: "Nested source name" }, referrer: { id: 8, name: "Nested referrer name" }, status: "converted", applied_at: "2026-06-12T12:00:00.000Z", last_activity_at: "2026-06-20T12:00:00.000Z" },
          { id: 5, candidate_id: 1005, jobs: [{ id: 20 }], status: "active", last_activity_at: null },
          { id: 6, candidate_id: 1006, job_id: 30, source_id: 3, referrer_id: 9, status: "active", applied_at: "2026-01-01T12:00:00.000Z", last_activity_at: "2026-01-02T12:00:00.000Z" },
        ], null, { rowCounts: { raw: 8, returned: 6 } });
      }
      if (toolName === "list_sources") {
        // Real source names live on /v3/sources, keyed by the scalar source_id on the app rows.
        return scopedSuccess(toolName, [
          { id: 1, name: "LinkedIn", type: { id: 2, name: "Job Board" } },
          { id: 2, name: "Indeed" },
        ]);
      }
      if (toolName === "list_referrers") {
        return scopedSuccess(toolName, [
          { id: 7, name: "Alice Referrer", user_id: 88 },
          { id: 8, name: "Bob Referrer" },
        ]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime, auditSink } = analysisRuntime(scopedReader);

    const result = await runSourceQuality(runtime, {
      source_ids: "1,2",
      referrer_ids: "7,8",
      greenhouse_user_id: 999,
      stale_days: 14,
      window_start: "2026-06-01T00:00:00.000Z",
      window_end: "2026-06-23T12:00:00.000Z",
      evidence_pack: true,
      evidence_pack_limit: 4,
    });

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.summary.rows_read, 8);
    assert.equal(data.summary.rows_considered, 5);
    assert.equal(data.summary.scoped_job_count, 2);
    assert.equal(data.metrics.applications_considered, 5);
    assert.equal(data.metrics.source_groups, 2);
    assert.equal(data.metrics.referrer_groups, 2);
    assert.equal(data.metrics.successful_applications, 1); // only the hired app; converted is not a win (#31)
    assert.equal(data.metrics.rejected_applications, 1);
    assert.equal(data.metrics.stale_active_applications, 2);
    assert.equal(data.metrics.success_rate, 0.2);
    assert.deepStrictEqual(data.fact_metric_layer.required_facts, ["application_lifecycle_fact"]);
    assert.deepStrictEqual(data.fact_metric_layer.required_metrics, ["source_quality_by_outcome", "weekly_application_volume"]);
    assert.equal(data.fact_metric_layer.metric_results.source_quality_by_outcome.unit, "count");
    assert.ok(data.fact_metric_layer.completeness.evidence_refs.includes("source:1"));
    assert.equal(data.data_quality.missing_source_id, 1);
    assert.equal(data.data_quality.missing_referrer_id, 1);
    assert.equal(data.data_quality.missing_application_timestamp, 1);
    assert.equal(data.source_rankings[0].source_id, 1);
    assert.equal(data.source_rankings[0].risk_score, 31.7);
    assert.equal(data.source_rankings[0].quality_score, 57.5);
    assert.deepStrictEqual(data.source_rankings[0].affected_jobs, [10]);
    assert.ok(data.source_rankings[0].evidence_ids.includes("application:2"));
    assert.ok(data.source_rankings[0].evidence_ids.includes("candidate:1002"));
    assert.equal(data.source_rankings[1].source_id, 2);
    assert.equal(data.referrer_rankings[0].referrer_id, 7);
    // #10: ids resolve to reference names from /v3/sources and /v3/referrers — never from the
    // "Do not expose"/"Nested source name" values on the application rows.
    assert.equal(data.source_rankings[0].source_name, "LinkedIn");
    assert.equal(data.source_rankings[1].source_name, "Indeed");
    assert.equal(data.referrer_rankings[0].referrer_name, "Alice Referrer");
    assert.deepStrictEqual(data.evidence_pack.ids, ["job:10", "application:1", "candidate:1001", "application:2"]);
    assert.equal(data.data, undefined);
    assert.equal(data.completeness.status, "partial");
    assert.equal(data.completeness.total_records_in_scope, 6);
    assert.equal(data.completeness.records_analyzed, 5);
    assert.equal(data.completeness.records_excluded, 1);
    assert.deepStrictEqual(data.completeness.exclusion_reasons, [{ reason: "outside_analysis_window", count: 1 }]);
    // #38: the graded confidence_summary (always-"high" high/medium/low buckets) is gone;
    // attribution_summary honestly reports the ranked-finding count and unresolved records.
    assert.equal(data.confidence_summary, undefined);
    assert.equal(data.attribution_summary.findings_ranked, 4);
    assert.equal(data.attribution_summary.unresolved, 3);
    assert.ok(
      !("high" in data.attribution_summary) &&
        !("medium" in data.attribution_summary) &&
        !("low" in data.attribution_summary)
    );
    assert.deepStrictEqual(data.unresolved_evidence, []);
    assert.doesNotMatch(JSON.stringify(data), /Do not expose|Nested source name|Nested referrer name/);
    assert.equal(auditSink.events.length, 1);
    assert.equal(auditSink.events[0]!.tool, "analyze_source_quality");
    assert.equal(auditSink.events[0]!.rowsRead, 8);
    assert.equal(auditSink.events[0]!.rowsReturned, 5);
  });

  it("supports operator actAsUser preview without trusting model-supplied identity params", async () => {
    const scopedReader = fakeScopedReader((toolName, params, options) => {
      assert.equal(toolName, "list_applications");
      assert.equal(params?.actAsUser, undefined);
      assert.equal(params?.greenhouse_user_id, undefined);
      assert.equal(options?.actAsUser, 321);
      assert.ok(options?.signal instanceof AbortSignal);
      return scopedSuccess(toolName, [], null, {
        actorId: 900,
        effectiveActorId: 321,
        permissionScope: { kind: "jobs", permittedJobCount: 1 },
      });
    });
    const { runtime, auditSink } = analysisRuntime(scopedReader, { trustedActAsUser: 321 });

    const result = await runSourceQuality(runtime, { actAsUser: 111, greenhouse_user_id: 222 });

    assert.equal(result.ok, true);
    assert.equal(auditSink.events[0]!.operator, true);
    assert.equal(auditSink.events[0]!.actAsUser, 321);
    assert.equal(auditSink.events[0]!.actorGreenhouseUserId, 900);
    assert.equal(auditSink.events[0]!.effectiveGreenhouseUserId, 321);
  });

  it("defaults unsafe stale_days values instead of propagating non-finite analysis knobs", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime } = analysisRuntime(scopedReader);

    const result = await runSourceQuality(runtime, { stale_days: "9".repeat(65) });

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.summary.stale_days, 14);
  });

  it("degrades to an honest 'unavailable' label when the reference read fails, without failing the analysis (#10b)", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [
          { id: 1, candidate_id: 1001, jobs: [{ id: 10 }], source_id: 1, referrer_id: 7, status: "hired", applied_at: "2026-06-10T12:00:00.000Z", last_activity_at: "2026-06-20T12:00:00.000Z" },
        ], null, { rowCounts: { raw: 1, returned: 1 } });
      }
      // A 5xx/network failure on the reference endpoints throws past readAllScopedRows (which
      // only swallows timeout/rate-limit). Name resolution must absorb it, not fail the analysis.
      throw new Error("Greenhouse API error: 503 service unavailable");
    });
    const { runtime } = analysisRuntime(scopedReader);
    const result = await runSourceQuality(runtime, { window_start: "2026-06-01T00:00:00.000Z", window_end: "2026-06-23T12:00:00.000Z" });
    assert.equal(result.ok, true, "a reference-name read failure must not fail an already-successful analysis");
    const data = result.ok ? result.data as any : null;
    assert.equal(data.source_rankings[0].source_id, 1);
    assert.equal(data.source_rankings[0].source_name, "source 1 (name unavailable)");
    assert.equal(data.referrer_rankings[0].referrer_name, "referrer 7 (name unavailable)");
  });

  it("drops zero and unsafe source/referrer ids from row-level attribution groupings", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [
          { id: "1", candidate_id: "1001", job_id: "10", source_id: "0", referrer_id: "9007199254740993", status: "active", applied_at: "2026-06-01T12:00:00.000Z", last_activity_at: "2026-06-20T12:00:00.000Z" },
          { id: "2", candidate_id: "1002", job_id: "10", source_id: "2", referrer_id: "7", status: "hired", applied_at: "2026-06-02T12:00:00.000Z", last_activity_at: "2026-06-22T12:00:00.000Z" },
        ]);
      }
      if (toolName === "list_sources" || toolName === "list_referrers") return scopedSuccess(toolName, []);
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(scopedReader);

    const result = await runSourceQuality(runtime, {});

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.deepStrictEqual(data.source_rankings.map((row: any) => row.source_id), [2]);
    assert.deepStrictEqual(data.referrer_rankings.map((row: any) => row.referrer_id), [7]);
    assert.equal(data.data_quality.missing_source_id, 1);
    assert.equal(data.data_quality.missing_referrer_id, 1);
    assert.deepStrictEqual(data.source_rankings[0].affected_jobs, [10]);
    assert.ok(data.source_rankings[0].evidence_ids.includes("application:2"));
    assert.ok(data.source_rankings[0].evidence_ids.includes("candidate:1002"));
  });

  it("drops unsafe application, candidate, and job ids from source-quality evidence output", async () => {
    const unsafeId = Number.MAX_SAFE_INTEGER + 1;
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, [
      { id: unsafeId, candidate_id: unsafeId, job_id: unsafeId, source_id: 2, referrer_id: 7, status: "active", applied_at: "2026-06-01T12:00:00.000Z", last_activity_at: "2026-06-20T12:00:00.000Z" },
    ]));
    const { runtime } = analysisRuntime(scopedReader);

    const result = await runSourceQuality(runtime, {});

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.summary.scoped_job_count, 0);
    assert.deepStrictEqual(data.source_rankings.map((row: any) => row.source_id), [2]);
    assert.deepStrictEqual(data.referrer_rankings.map((row: any) => row.referrer_id), [7]);
    assert.deepStrictEqual(data.source_rankings[0].affected_jobs, []);
    assert.deepStrictEqual(data.source_rankings[0].evidence_ids, []);
    assert.deepStrictEqual(data.referrer_rankings[0].affected_jobs, []);
    assert.deepStrictEqual(data.referrer_rankings[0].evidence_ids, []);
    assert.doesNotMatch(JSON.stringify(data), /9007199254740992|9007199254740993/);
  });

  it("returns scoped denials without falling through", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedDenial(toolName, "PERMISSION_LOOKUP_FAILED"));
    const { runtime, auditSink } = analysisRuntime(scopedReader);

    const result = await runSourceQuality(runtime, {});

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "PERMISSION_LOOKUP_FAILED");
    assert.equal(auditSink.events[0]!.denialCode, "PERMISSION_LOOKUP_FAILED");
  });

  it("stops paginated application reads when the total analysis deadline is exhausted", async () => {
    const startedAt = Date.parse("2026-06-23T12:00:00.000Z");
    let now = startedAt;
    const scopedReader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_applications" && params?.cursor === undefined) {
        now = startedAt + 10;
        return scopedSuccess(toolName, [], "next-application-page");
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime, auditSink } = analysisRuntime(scopedReader, {
      now: () => now,
      limits: { ...DEFAULT_LIMITS, maxToolDurationMs: 5, maxAnalysisDurationMs: 5 },
    });

    const result = await runSourceQuality(runtime, {});

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.summary.read_status, "incomplete_timeout");
    assert.equal(data.summary.read_complete, false);
    assert.equal(data.summary.pagination_truncated, true);
    assert.equal(data.completeness.status, "incomplete");
    assert.deepStrictEqual(scopedReader.calls.map((call) => call.toolName), ["list_applications"]);
    assert.equal(auditSink.events[0]!.denialCode, null);
    assert.equal(auditSink.events[0]!.rowsRead, 0);
  });

  it("lets an explicit window run past the lookback cap; fuzzy windows stay capped (T2.2)", async () => {
    const scopedReader = fakeScopedReader(() => scopedSuccess("list_applications", []));
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
    const result = await runSourceQuality(runtime, {
      window_start: "2026-01-01T00:00:00.000Z",
      window_end: "2026-06-23T00:00:00.000Z",
    });
    assert.equal(result.ok, true, "an explicit window exceeding the cap must run, not deny");
    assert.ok(scopedReader.calls.length > 0, "the read must actually happen");

    // The FUZZY one-sided window stays capped: an ancient window_start with a defaulted end
    // exceeds the lookback limit and denies before any read.
    const fuzzy = await runSourceQuality(runtime, { window_start: "2020-01-01T00:00:00.000Z" });
    assert.equal(fuzzy.ok, false);
    assert.equal(fuzzy.ok === false && fuzzy.denial.code, "LIMIT_EXCEEDED");
  });

  it("denies malformed analysis windows before reading applications", async () => {
    const scopedReader = fakeScopedReader(() => scopedSuccess("list_applications", []));
    const { runtime } = analysisRuntime(scopedReader);

    const result = await runSourceQuality(runtime, { window_end: "not-a-date" });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "LIMIT_EXCEEDED");
    assert.equal(scopedReader.calls.length, 0);
  });

  it("excludes prospect applications entirely from volume and quality (ledger #32)", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [
          { id: 1, candidate_id: 1001, jobs: [{ id: 10 }], source_id: 1, status: "hired", applied_at: "2026-06-10T12:00:00.000Z", last_activity_at: "2026-06-20T12:00:00.000Z" },
          { id: 2, candidate_id: 1002, jobs: [{ id: 10 }], source_id: 1, status: "active", prospect: true, applied_at: "2026-06-11T12:00:00.000Z", last_activity_at: "2026-06-12T12:00:00.000Z" },
        ], null, { rowCounts: { raw: 2, returned: 2 } });
      }
      if (toolName === "list_sources" || toolName === "list_referrers") return scopedSuccess(toolName, []);
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(scopedReader);
    const result = await runSourceQuality(runtime, { window_start: "2026-06-01T00:00:00.000Z", window_end: "2026-06-23T12:00:00.000Z" });
    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.summary.prospects_excluded, 1);
    assert.equal(data.metrics.applications_considered, 1, "the prospect application is excluded from analysis");
    assert.equal(data.metrics.successful_applications, 1);
  });

  it("discloses active applications missing last_activity rather than silently flagging them stale (parity — #37)", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [
          { id: 1, candidate_id: 1001, jobs: [{ id: 10 }], source_id: 1, status: "active", applied_at: "2026-06-10T12:00:00.000Z", last_activity_at: null },
          { id: 2, candidate_id: 1002, jobs: [{ id: 10 }], source_id: 1, status: "active", applied_at: "2026-06-11T12:00:00.000Z", last_activity_at: "2026-06-20T12:00:00.000Z" },
        ], null, { rowCounts: { raw: 2, returned: 2 } });
      }
      if (toolName === "list_sources" || toolName === "list_referrers") return scopedSuccess(toolName, []);
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(scopedReader);
    const result = await runSourceQuality(runtime, { window_start: "2026-06-01T00:00:00.000Z", window_end: "2026-06-23T12:00:00.000Z", stale_days: 14 });
    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.data_quality.missing_last_activity, 1, "the active app with null last_activity is disclosed");
  });
});
