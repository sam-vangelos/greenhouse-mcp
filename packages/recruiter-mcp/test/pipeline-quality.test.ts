import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS } from "../src/limits.js";
import { runPipelineQuality } from "../src/tools/pipeline-quality.js";
import { analysisRuntime, fakeScopedReader, operatorInventory, scopedDenial, scopedSuccess } from "./test-helpers.js";
import { stageRowWithoutEntryTimestamp } from "./fixtures-production-shapes.js";
import { createFixtureInventoryProvider, type JobScopeFixture } from "../src/resolvers/job-scope/inventory.js";

describe("pipeline quality analysis", () => {
  it("does not certify completeness 'complete' when active rows lack current-stage timing (honesty lock — B3)", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [
          stageRowWithoutEntryTimestamp({ id: 1, jobs: [{ id: 100 }] }),
          stageRowWithoutEntryTimestamp({ id: 2, jobs: [{ id: 100 }] }),
        ]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(scopedReader);
    const result = await runPipelineQuality(runtime, {});
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.notEqual(data.completeness.status, "complete", "pipeline analysis on active rows with no current-stage timing must not report 'complete'");
    assert.equal(data.completeness.data_freshness_ok, false);
    // #38 behavioral lock: degraded data quality is reported via completeness above and must
    // NOT zero the finding count (the old confidence flip dumped the whole count into "low"/0
    // here). findings_ranked stays the real ranked count even on the degraded-freshness path.
    assert.ok(data.stage_rankings.length + data.job_breakdown.length > 0);
    assert.equal(data.attribution_summary.findings_ranked, data.stage_rankings.length + data.job_breakdown.length);
  });

  it("warns that migration-shaped data may not be recruiting activity (L4 provenance — revert lock)", async () => {
    // The live shape: a large cohort, every application zero-disposition (all 'active'), all created in
    // one tiny recent window — the signature of a data load, not recruiting. The recipe must WARN and
    // degrade completeness, never present these counts as findings.
    const migratedRows = Array.from({ length: 60 }, (_, i) => ({
      id: i + 1,
      candidate_id: 5000 + i,
      jobs: [{ id: 100 }],
      status: "active",
      // All created within a ~20-minute window — a recent bulk load.
      created_at: new Date(Date.parse("2026-06-23T09:00:00.000Z") + i * 20 * 1000).toISOString(),
      current_stage: { id: 7, name: "Application Review" },
      last_activity_at: "2026-06-23T09:05:00.000Z",
    }));
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, migratedRows, null, { rowCounts: { raw: 60, returned: 60 } });
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(scopedReader);
    const result = await runPipelineQuality(runtime, {});
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    const provenance = data.completeness.provenance;
    assert.ok(provenance, "completeness must carry a provenance assessment");
    assert.equal(provenance.migration_suspected, true, "60 zero-disposition, tightly-clustered applications must read as migration-shaped");
    assert.match(provenance.warning, /data migration/);
    const codes = provenance.signals.map((s: any) => s.code).sort();
    assert.deepEqual(codes, ["all_default_status", "recent_creation_cluster"]);
    // Suspected migration must stop the analysis claiming 'complete'.
    assert.notEqual(data.completeness.status, "complete");
  });

  it("does not raise a provenance warning on normal spread, dispositioned data", async () => {
    const healthyRows = Array.from({ length: 60 }, (_, i) => ({
      id: i + 1,
      candidate_id: 5000 + i,
      jobs: [{ id: 100 }],
      // ~30% terminal, spread one per day — real recruiting activity.
      status: i % 3 === 0 ? "rejected" : "active",
      created_at: new Date(Date.parse("2026-06-23T09:00:00.000Z") - (i + 1) * 24 * 60 * 60 * 1000).toISOString(),
      current_stage: { id: 7, name: "Application Review", entered_at: "2026-06-20T09:00:00.000Z" },
      last_activity_at: "2026-06-22T09:00:00.000Z",
    }));
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, healthyRows, null, { rowCounts: { raw: 60, returned: 60 } });
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(scopedReader);
    const result = await runPipelineQuality(runtime, {});
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.completeness.provenance.migration_suspected, false);
    assert.equal(data.completeness.provenance.warning, null);
  });

  it("flags applications that predate the requisition open — proves job-open anchors thread through (L4)", async () => {
    // A req that opened 2026-06-19, carrying 20 applications all created a month earlier. A candidate
    // cannot apply before the req exists; this is backfilled/migrated history. The signal only fires if
    // the recipe actually receives the job-open anchor threaded from the resolved scope inventory.
    const fixture: JobScopeFixture = {
      personas: [
        { id: "p", greenhouse_user_id: 1, permission_scope_kind: "jobs", accessible_job_ids: [100], can_view_confidential: false },
      ],
      jobs: [
        { greenhouse_job_id: 100, requisition_id: "R-100", title: "Engineer", status: "open", department: null, office: null, location: null, opened_at: "2026-06-19T00:00:00.000Z", closed_at: null },
      ],
    };
    const predatingRows = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      candidate_id: 7000 + i,
      jobs: [{ id: 100 }],
      status: "active",
      // Spread across mid-May (so neither the cluster nor all-default signal fires), all before open.
      created_at: new Date(Date.parse("2026-05-15T00:00:00.000Z") + i * 6 * 60 * 60 * 1000).toISOString(),
      current_stage: { id: 7, name: "Application Review", entered_at: "2026-05-16T00:00:00.000Z" },
      last_activity_at: "2026-05-20T00:00:00.000Z",
    }));
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, predatingRows, null, { rowCounts: { raw: 20, returned: 20 } });
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(scopedReader, { jobInventory: createFixtureInventoryProvider(fixture, "p") });
    const result = await runPipelineQuality(runtime, { job_ids: "100" });
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    const predate = data.completeness.provenance.signals.find((s: any) => s.code === "records_predate_requisition");
    assert.ok(predate, "predate signal must fire — proving job-open anchors reached the detector");
    assert.equal(predate.records_flagged, 20);
    assert.equal(data.completeness.provenance.migration_suspected, true);
  });

  it("emits a temporal WoW diff over two distinct weekly cohorts from application created_at (L3 honest)", async () => {
    // runtime.now() is 2026-06-23 (current week Mon 2026-06-22); last complete week 2026-06-15, prior
    // 2026-06-08. Feed 3 apps in the prior week and 5 in the last complete week.
    const rows = [
      ...[9, 10, 11].map((d, i) => ({ id: i + 1, candidate_id: 6000 + i, jobs: [{ id: 100 }], status: "active", created_at: `2026-06-${d}T10:00:00.000Z`, current_stage: { id: 7, name: "Phone Screen", entered_at: "2026-06-09T10:00:00.000Z" }, last_activity_at: "2026-06-12T10:00:00.000Z" })),
      ...[16, 16, 17, 18, 19].map((d, i) => ({ id: i + 10, candidate_id: 6100 + i, jobs: [{ id: 100 }], status: "active", created_at: `2026-06-${d}T10:00:00.000Z`, current_stage: { id: 7, name: "Phone Screen", entered_at: "2026-06-16T10:00:00.000Z" }, last_activity_at: "2026-06-19T10:00:00.000Z" })),
    ];
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") return scopedSuccess(toolName, rows, null, { rowCounts: { raw: rows.length, returned: rows.length } });
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(scopedReader);
    const result = await runPipelineQuality(runtime, {});
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.ok(data.temporal, "pipeline quality must carry a temporal view");
    const wow = data.temporal.week_over_week;
    assert.ok(wow, "a two-window WoW diff must be present");
    assert.notEqual(wow.current_week, wow.prior_week, "WoW must compare two distinct weekly cohorts");
    assert.equal(wow.current_count, 5);
    assert.equal(wow.prior_count, 3);
    assert.equal(wow.delta, 2);
    // Stage-flow over time stays honestly unavailable (L3), never fabricated as zero.
    assert.equal(data.temporal.stage_flow_over_time.available, false);
  });

  it("denies a no-scope analysis for a broad-access operator without running an org-wide read", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      throw new Error(`operator no-scope analysis must not read org-wide (called ${toolName})`);
    });
    const { runtime } = analysisRuntime(scopedReader, { jobInventory: operatorInventory() });
    const result = await runPipelineQuality(runtime, {});
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "INVALID_REQUEST");
    assert.equal(scopedReader.calls.length, 0, "no scoped read runs for an unscoped operator analysis");
  });

  it("computes scoped status mix, stale active rate, stage concentration, job breakdown, and evidence ids", async () => {
    const scopedReader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_applications") {
        assert.equal(params?.per_page, 500);
        assert.equal(params?.stale_days, undefined);
        assert.equal(params?.window_start, undefined);
        assert.equal(params?.evidence_pack, undefined);
        assert.equal(params?.evidence_pack_limit, undefined);
        return scopedSuccess(toolName, [
          { id: 1, candidate_id: 1001, jobs: [{ id: 10 }], current_stage: { id: 7, name: "Phone Screen", entered_at: "2026-06-01T12:00:00.000Z" }, status: "active", last_activity_at: "2026-06-10T12:00:00.000Z" },
          { id: 2, candidate_id: 1002, jobs: [{ id: "10" }], current_stage: { id: "7", name: "Phone Screen" }, status: "in_process", current_stage_at: "2026-05-30T12:00:00.000Z", last_activity_at: "2026-06-01T12:00:00.000Z" },
          { id: 3, candidate_id: 1003, jobs: [{ id: 10 }], current_stage: { id: 8, name: "Onsite", entered_at: "2026-06-05T12:00:00.000Z" }, status: "rejected", last_activity_at: "2026-06-05T12:00:00.000Z" },
          { id: 4, candidate_id: 1004, jobs: [{ id: 20 }], current_stage: { id: 9, name: "Offer", entered_at: "2026-06-20T12:00:00.000Z" }, status: "hired", last_activity_at: "2026-06-22T12:00:00.000Z" },
          { id: 5, candidate_id: 1005, jobs: [{ id: 20 }], current_stage: { id: 8, name: "Onsite", entered_at: "2026-06-02T12:00:00.000Z" }, status: "active", last_activity_at: null },
          { id: 6, candidate_id: 1006, job_id: 20, stage_id: null, stage_name: null, status: "converted", current_stage_at: null, last_activity_at: "2026-06-15T12:00:00.000Z" },
        ], null, { rowCounts: { raw: 9, returned: 6 } });
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime, auditSink } = analysisRuntime(scopedReader);

    const result = await runPipelineQuality(runtime, { stale_days: 14, evidence_pack: true, evidence_pack_limit: 4 });

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.summary.rows_read, 9);
    assert.equal(data.summary.rows_considered, 6);
    assert.equal(data.summary.scoped_job_count, 2);
    // Rank 46: the limitation note must POINT at analyze_source_quality (which already answers the
    // source/agency part) instead of dead-ending on "requires additional tools".
    assert.ok(
      data.summary.field_limitations.some((note: string) => /analyze_source_quality/.test(note)),
      "pipeline-quality limitations must point at analyze_source_quality for source/agency yield"
    );
    assert.equal(data.metrics.applications_considered, 6);
    assert.equal(data.metrics.active_applications, 3);
    assert.equal(data.metrics.terminal_applications, 3);
    assert.equal(data.metrics.hired_applications, 1);
    assert.equal(data.metrics.rejected_applications, 1);
    assert.equal(data.metrics.converted_applications, 1);
    assert.equal(data.metrics.active_rate, 0.5);
    assert.equal(data.metrics.terminal_rate, 0.5);
    assert.equal(data.metrics.stale_active_applications, 2);
    assert.equal(data.metrics.stale_active_rate, 0.6667);
    assert.equal(data.metrics.top_stage_active_concentration, 0.6667);
    assert.deepStrictEqual(data.fact_metric_layer.required_facts, ["application_lifecycle_fact"]);
    assert.deepStrictEqual(data.fact_metric_layer.required_metrics, [
      "weekly_application_volume",
      "weekly_qualified_pipeline_movement",
      "source_quality_by_outcome",
    ]);
    assert.equal(data.fact_metric_layer.metric_results.weekly_application_volume.unit, "count");
    assert.ok(data.fact_metric_layer.completeness.evidence_refs.includes("application:1"));
    assert.deepStrictEqual(
      data.status_mix.map((row: any) => [row.status, row.count]),
      [["active", 2], ["converted", 1], ["hired", 1], ["in_process", 1], ["rejected", 1]]
    );
    assert.equal(data.stage_rankings[0].label, "Phone Screen");
    assert.equal(data.stage_rankings[0].severity_score, 25);
    assert.deepStrictEqual(data.stage_rankings[0].affected_jobs, [10]);
    assert.ok(data.stage_rankings[0].evidence_ids.includes("application:2"));
    assert.ok(data.stage_rankings[0].evidence_ids.includes("candidate:1002"));
    assert.deepStrictEqual(data.evidence_pack.ids, ["job:10", "application:1", "candidate:1001", "application:2"]);
    assert.equal(data.evidence_pack.by_type.job.returned_ids, 1);
    assert.equal(data.evidence_pack.by_type.application.returned_ids, 2);
    assert.equal(data.evidence_pack.by_type.candidate.returned_ids, 1);
    assert.equal(data.job_breakdown[0].key, "job:10");
    assert.equal(data.job_breakdown[0].stale_active_applications, 1);
    assert.equal(data.data_quality.missing_stage, 1);
    assert.equal(data.data_quality.missing_last_activity_at, 1);
    assert.equal(data.data, undefined);
    assert.equal(data.completeness.status, "complete");
    assert.equal(data.completeness.total_records_in_scope, 6);
    assert.equal(data.completeness.records_analyzed, 6);
    // #38: the graded confidence_summary (here it flipped high↔low on one data-quality
    // boolean already carried by completeness.data_freshness_ok) is gone; attribution_summary
    // reports the ranked-finding count and unresolved records, no fake grade.
    assert.equal(data.confidence_summary, undefined);
    assert.equal(data.attribution_summary.findings_ranked, 6);
    assert.equal(data.attribution_summary.unresolved, 2);
    assert.ok(
      !("high" in data.attribution_summary) &&
        !("medium" in data.attribution_summary) &&
        !("low" in data.attribution_summary)
    );
    assert.deepStrictEqual(data.unresolved_evidence, []);
    assert.equal(auditSink.events.length, 1);
    assert.equal(auditSink.events[0]!.tool, "analyze_pipeline_quality");
    assert.equal(auditSink.events[0]!.rowsRead, 9);
    assert.equal(auditSink.events[0]!.rowsReturned, 6);
    assert.equal(auditSink.events[0]!.permissionScopeKind, "jobs");
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

    const result = await runPipelineQuality(runtime, { actAsUser: 111, greenhouse_user_id: 222 });

    assert.equal(result.ok, true);
    assert.equal(auditSink.events[0]!.operator, true);
    assert.equal(auditSink.events[0]!.actAsUser, 321);
    assert.equal(auditSink.events[0]!.actorGreenhouseUserId, 900);
    assert.equal(auditSink.events[0]!.effectiveGreenhouseUserId, 321);
  });

  it("defaults unsafe stale_days values instead of propagating non-finite analysis knobs", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime } = analysisRuntime(scopedReader);

    const result = await runPipelineQuality(runtime, { stale_days: Number.POSITIVE_INFINITY });

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.summary.stale_days, 14);
  });

  it("drops unsafe stage and status labels from analysis output", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, [
      { id: 1, candidate_id: 1001, job_id: 10, stage_id: null, stage_name: "Secret\u0007Stage", status: "Confidential Sensitive", current_stage_at: "2026-06-01T12:00:00.000Z", last_activity_at: "2026-06-10T12:00:00.000Z" },
    ]));
    const { runtime } = analysisRuntime(scopedReader);

    const result = await runPipelineQuality(runtime, {});

    assert.equal(result.ok, true);
    const serialized = JSON.stringify(result.ok ? result.data : {});
    const data = result.ok ? result.data as any : null;
    assert.deepStrictEqual(data.status_mix, [{ status: "unknown", count: 1, rate: 1 }]);
    assert.equal(data.stage_rankings[0].key, "stage_name:unknown");
    assert.equal(data.stage_rankings[0].label, null);
    assert.doesNotMatch(serialized, /Secret|Sensitive|Rejected/);
  });

  it("drops unsafe row ids from scoped job counts, grouping keys, and evidence ids", async () => {
    const unsafeId = Number.MAX_SAFE_INTEGER + 1;
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, [
      { id: unsafeId, candidate_id: unsafeId, job_id: unsafeId, stage_id: unsafeId, stage_name: "Phone Screen", status: "active", current_stage_at: "2026-06-01T12:00:00.000Z", last_activity_at: "2026-06-10T12:00:00.000Z" },
    ]));
    const { runtime } = analysisRuntime(scopedReader);

    const result = await runPipelineQuality(runtime, {});

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.summary.scoped_job_count, 0);
    assert.equal(data.stage_rankings[0].key, "stage_name:Phone Screen");
    assert.deepStrictEqual(data.stage_rankings[0].affected_jobs, []);
    assert.deepStrictEqual(data.stage_rankings[0].evidence_ids, []);
    assert.equal(data.job_breakdown[0].key, "job:unknown");
    assert.deepStrictEqual(data.job_breakdown[0].affected_jobs, []);
    assert.deepStrictEqual(data.job_breakdown[0].evidence_ids, []);
    assert.doesNotMatch(JSON.stringify(data), /9007199254740992|9007199254740993/);
  });

  it("returns scoped denials without falling through", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedDenial(toolName, "PERMISSION_LOOKUP_FAILED"));
    const { runtime, auditSink } = analysisRuntime(scopedReader);

    const result = await runPipelineQuality(runtime, {});

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

    const result = await runPipelineQuality(runtime, {});

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
    const result = await runPipelineQuality(runtime, {
      window_start: "2026-01-01T00:00:00.000Z",
      window_end: "2026-06-23T00:00:00.000Z",
    });
    assert.equal(result.ok, true, "an explicit window exceeding the cap must run, not deny");
    assert.ok(scopedReader.calls.length > 0, "the read must actually happen");

    // The FUZZY one-sided window stays capped: an ancient window_start with a defaulted end
    // exceeds the lookback limit and denies before any read.
    const fuzzy = await runPipelineQuality(runtime, { window_start: "2020-01-01T00:00:00.000Z" });
    assert.equal(fuzzy.ok, false);
    assert.equal(fuzzy.ok === false && fuzzy.denial.code, "LIMIT_EXCEEDED");
  });

  it("denies malformed analysis windows before reading applications", async () => {
    const scopedReader = fakeScopedReader(() => scopedSuccess("list_applications", []));
    const { runtime } = analysisRuntime(scopedReader);

    const result = await runPipelineQuality(runtime, { window_end: "not-a-date" });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "LIMIT_EXCEEDED");
    assert.equal(scopedReader.calls.length, 0);
  });

  it("excludes prospect applications entirely from pipeline volume (ledger #32)", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [
          { id: 1, candidate_id: 1001, jobs: [{ id: 10 }], status: "active", applied_at: "2026-06-10T12:00:00.000Z", last_activity_at: "2026-06-20T12:00:00.000Z" },
          { id: 2, candidate_id: 1002, jobs: [{ id: 10 }], status: "active", prospect: true, applied_at: "2026-06-11T12:00:00.000Z", last_activity_at: "2026-06-12T12:00:00.000Z" },
        ], null, { rowCounts: { raw: 2, returned: 2 } });
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(scopedReader);
    const result = await runPipelineQuality(runtime, { window_start: "2026-06-01T00:00:00.000Z", window_end: "2026-06-23T12:00:00.000Z" });
    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.summary.prospects_excluded, 1);
    assert.equal(data.metrics.applications_considered, 1, "the prospect application is excluded from pipeline volume");
  });
});
