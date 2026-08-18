import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS } from "../src/limits.js";
import { runStageLatency } from "../src/tools/stage-latency.js";
import { analysisRuntime, fakeScopedReader, operatorInventory, scopedDenial, scopedSuccess } from "./test-helpers.js";
import { stageRowWithoutEntryTimestamp, v3ApplicationStage } from "./fixtures-production-shapes.js";

describe("stage latency analysis", () => {
  it(
    "does not certify completeness 'complete' when stage-entry timestamps are absent (honesty lock — B3)",
    async () => {
      const scopedReader = fakeScopedReader((toolName) => {
        if (toolName === "list_applications") {
          return scopedSuccess(toolName, [
            stageRowWithoutEntryTimestamp({ id: 1, jobs: [{ id: 100 }] }),
            stageRowWithoutEntryTimestamp({ id: 2, jobs: [{ id: 100 }] }),
          ]);
        }
        if (toolName === "list_application_stages") {
          return scopedSuccess(toolName, []);
        }
        throw new Error(`unexpected tool ${toolName}`);
      });
      const { runtime } = analysisRuntime(scopedReader);
      const result = await runStageLatency(runtime, {});
      assert.equal(result.ok, true);
      const data = result.ok ? (result.data as any) : null;
      assert.notEqual(data.completeness.status, "complete", "stage analysis on rows with no dwell timestamp must not report 'complete'");
    }
  );

  it("keeps the real ranked-finding count when stage timing is missing for some rows (#38 behavioral lock)", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [
          { id: 1, candidate_id: 1001, jobs: [{ id: 100 }], current_stage: { id: 7, name: "Phone Screen" }, status: "active", last_activity_at: "2026-06-20T12:00:00.000Z" },
          { id: 2, candidate_id: 1002, jobs: [{ id: 100 }], current_stage: { id: 7, name: "Phone Screen" }, status: "active", last_activity_at: "2026-06-21T12:00:00.000Z" },
        ], null, { rowCounts: { raw: 2, returned: 2 } });
      }
      if (toolName === "list_application_stages") {
        // Only application 1 has a current stage row; application 2 is missing one, so
        // excludedMissingStageTiming === 1 — a degraded data-quality signal.
        return scopedSuccess(toolName, [
          v3ApplicationStage({ id: 4001, application_id: 1, job_interview_stage_id: 7, entered_at: "2026-06-10T12:00:00.000Z", days_in_stage: 13, current: true }),
        ]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(scopedReader);
    const result = await runStageLatency(runtime, { min_age_days: 7 });
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    // Degraded freshness (one app lacks a current stage row) is reported via completeness and
    // counted as unresolved — it must NOT zero the finding count (the old confidence flip set
    // the whole count to "low"/0 here). findings_ranked stays the real ranked count.
    assert.equal(data.completeness.data_freshness_ok, false);
    assert.equal(data.attribution_summary.unresolved, 1);
    assert.ok(data.rankings.length > 0);
    assert.equal(data.attribution_summary.findings_ranked, data.rankings.length);
  });

  it("does NOT raise all-default-status on a healthy active-only dwell cohort (status-filtered read — L4 false-positive lock)", async () => {
    // The default stage-latency read sends status:"active", so the cohort is active-only and its
    // disposition mix is unrepresentative. 60 active, zero-disposition (in the active slice) applications
    // is a perfectly healthy busy req — it must NOT be flagged as migration-shaped. Timestamps are spread
    // one-per-day so the cluster signal also stays quiet; the assertion isolates all-default.
    const activeRows = Array.from({ length: 60 }, (_, i) => ({
      id: i + 1,
      candidate_id: 2000 + i,
      jobs: [{ id: 100 }],
      status: "active",
      created_at: new Date(Date.parse("2026-06-20T09:00:00.000Z") - (i + 1) * 24 * 60 * 60 * 1000).toISOString(),
      current_stage: { id: 7, name: "Phone Screen", entered_at: "2026-06-15T09:00:00.000Z" },
      last_activity_at: "2026-06-19T09:00:00.000Z",
    }));
    const stageRows = Array.from({ length: 60 }, (_, i) =>
      v3ApplicationStage({ id: 4000 + i, application_id: i + 1, job_interview_stage_id: 7, entered_at: "2026-06-15T09:00:00.000Z", days_in_stage: 8, current: true })
    );
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") return scopedSuccess(toolName, activeRows, null, { rowCounts: { raw: 60, returned: 60 } });
      if (toolName === "list_application_stages") return scopedSuccess(toolName, stageRows);
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(scopedReader);
    const result = await runStageLatency(runtime, {});
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.completeness.provenance.migration_suspected, false, "an active-only (status-filtered) cohort must not trip all-default-status");
    assert.equal(data.completeness.provenance.signals.some((s: any) => s.code === "all_default_status"), false);
  });

  it("still flags a creation cluster on the active dwell cohort (cluster signal stays live for stage-latency — L4)", async () => {
    // Same active-only cohort, but every application created in a ~20-minute burst — a migration shape
    // the cluster signal must still catch even though all-default is (correctly) not evaluated here.
    const burstRows = Array.from({ length: 60 }, (_, i) => ({
      id: i + 1,
      candidate_id: 2000 + i,
      jobs: [{ id: 100 }],
      status: "active",
      created_at: new Date(Date.parse("2026-06-20T09:00:00.000Z") + i * 20 * 1000).toISOString(),
      current_stage: { id: 7, name: "Phone Screen", entered_at: "2026-06-15T09:00:00.000Z" },
      last_activity_at: "2026-06-20T09:05:00.000Z",
    }));
    const stageRows = Array.from({ length: 60 }, (_, i) =>
      v3ApplicationStage({ id: 4000 + i, application_id: i + 1, job_interview_stage_id: 7, entered_at: "2026-06-15T09:00:00.000Z", days_in_stage: 8, current: true })
    );
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") return scopedSuccess(toolName, burstRows, null, { rowCounts: { raw: 60, returned: 60 } });
      if (toolName === "list_application_stages") return scopedSuccess(toolName, stageRows);
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(scopedReader);
    const result = await runStageLatency(runtime, {});
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.completeness.provenance.signals.some((s: any) => s.code === "recent_creation_cluster"), true);
    assert.equal(data.completeness.provenance.migration_suspected, true);
  });

  it("denies a no-scope analysis for a broad-access operator without running an org-wide read", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      throw new Error(`operator no-scope analysis must not read org-wide (called ${toolName})`);
    });
    const { runtime } = analysisRuntime(scopedReader, { jobInventory: operatorInventory() });
    const result = await runStageLatency(runtime, {});
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "INVALID_REQUEST");
    assert.equal(scopedReader.calls.length, 0, "no scoped read runs for an unscoped operator analysis");
  });

  it("ranks scoped stage bottlenecks with dwell metrics, affected jobs, and evidence ids", async () => {
    const scopedReader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_applications") {
        assert.equal(params?.status, "active");
        assert.equal(params?.per_page, 500);
        assert.equal(params?.evidence_pack, undefined);
        assert.equal(params?.evidence_pack_limit, undefined);
        return scopedSuccess(toolName, [
          { id: 1, candidate_id: 1001, jobs: [{ id: 100 }], current_stage: { id: 7, name: "Phone Screen" }, status: "in_process", last_activity_at: "2026-06-20T12:00:00.000Z" },
          { id: 2, candidate_id: 1002, jobs: [{ id: "100" }], current_stage: { id: "7", name: "Phone Screen" }, status: "active", last_activity_at: "2026-06-21T12:00:00.000Z" },
          { id: 3, candidate_id: 1003, jobs: [{ id: 200 }], current_stage: { id: 8, name: "Onsite" }, status: "active", last_activity_at: "2026-06-22T12:00:00.000Z" },
          { id: 4, candidate_id: 1004, job_id: 300, stage_id: 7, stage_name: "Phone Screen", status: "rejected", current_stage_at: "2026-06-01T12:00:00.000Z", last_activity_at: "2026-06-05T12:00:00.000Z" },
        ], null, { rowCounts: { raw: 6, returned: 4 } });
      }
      if (toolName === "list_application_stages") {
        assert.deepStrictEqual(params, { application_ids: "1,2,3", current: true, per_page: 500 });
        return scopedSuccess(toolName, [
          v3ApplicationStage({ id: 4001, application_id: 1, job_interview_stage_id: 7, entered_at: "2026-06-13T12:00:00.000Z", days_in_stage: 10, current: true }),
          v3ApplicationStage({ id: 4002, application_id: 2, job_interview_stage_id: 7, entered_at: "2026-06-03T12:00:00.000Z", days_in_stage: 20, current: true }),
          v3ApplicationStage({ id: 4003, application_id: 3, job_interview_stage_id: 8, entered_at: "2026-06-20T12:00:00.000Z", days_in_stage: 3, current: true }),
        ]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime, auditSink } = analysisRuntime(scopedReader);

    const result = await runStageLatency(runtime, { min_age_days: 7, evidence_pack: true, evidence_pack_limit: 3 });

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.summary.rows_read, 6);
    assert.equal(data.summary.pages_read, 1);
    assert.equal(data.summary.stage_rows_read, 3);
    assert.equal(data.summary.stage_pages_read, 1);
    assert.equal(data.summary.per_page, 500);
    assert.equal(data.summary.stage_per_page, 500);
    assert.equal(data.summary.read_status, "complete");
    assert.equal(data.summary.application_read_status, "complete");
    assert.equal(data.summary.stage_read_status, "complete");
    assert.equal(data.summary.read_complete, true);
    assert.equal(data.summary.page_limit, undefined);
    assert.equal(data.summary.pagination_truncated, false);
    assert.equal(data.summary.rows_considered, 3);
    assert.equal(data.summary.scoped_job_count, 2);
    assert.equal(data.metrics.applications_considered, 3);
    assert.equal(data.metrics.aging_applications, 2);
    assert.equal(data.metrics.aging_application_rate, 0.6667);
    assert.equal(data.metrics.average_stage_dwell_days, 11);
    assert.equal(data.metrics.p90_stage_dwell_days, 20);
    assert.deepStrictEqual(data.fact_metric_layer.required_facts, ["application_stage_transition_fact"]);
    assert.deepStrictEqual(data.fact_metric_layer.required_metrics, ["stage_dwell_days"]);
    assert.equal(data.fact_metric_layer.metric_results.stage_dwell_days.value, 11);
    assert.ok(data.fact_metric_layer.completeness.evidence_refs.includes("application_stage:4001"));
    assert.deepStrictEqual(data.rankings.map((row: any) => row.stage_name), ["Phone Screen", "Onsite"]);
    assert.equal(data.rankings[0].severity_score, 48);
    assert.equal(data.rankings[0].average_dwell_days, 15);
    assert.equal(data.rankings[0].p90_dwell_days, 20);
    assert.deepStrictEqual(data.rankings[0].affected_jobs, [100]);
    assert.ok(data.rankings[0].evidence_ids.includes("application:1"));
    assert.ok(data.rankings[0].evidence_ids.includes("application_stage:4001"));
    assert.ok(data.rankings[0].evidence_ids.includes("candidate:1002"));
    assert.deepStrictEqual(data.evidence_pack.ids, ["job:100", "application_stage:4001", "application:1"]);
    assert.equal(data.evidence_pack.by_type.job.returned_ids, 1);
    assert.equal(data.evidence_pack.by_type.application_stage.returned_ids, 1);
    assert.equal(data.evidence_pack.by_type.application.returned_ids, 1);
    assert.deepStrictEqual(data.job_breakdown[0].job_id, 100);
    assert.equal(data.job_breakdown[0].aging_applications, 2);
    assert.equal(data.data, undefined);
    // 6 raw rows surfaced, 3 analyzed: the gap (2 backend-scope-filtered, 1 terminal) is
    // now reconciled and visible, so status degrades to "partial" instead of silently
    // claiming "complete". The excluded rows are accounted for in completeness, not buried
    // in a confidence grade.
    assert.equal(data.completeness.status, "partial");
    assert.equal(data.completeness.total_records_in_scope, 6);
    assert.equal(data.completeness.records_analyzed, 3);
    assert.equal(data.completeness.records_excluded, 3);
    assert.deepStrictEqual(data.completeness.exclusion_reasons, [
      { reason: "backend_scope_filtered", count: 2 },
      { reason: "terminal_or_inactive_application", count: 1 },
    ]);
    // #38: graded confidence_summary removed; attribution_summary reports finding count +
    // unresolved records, with the data-quality gap surfaced via completeness above.
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
    assert.equal(auditSink.events[0]!.tool, "analyze_stage_latency");
    assert.equal(auditSink.events[0]!.rowsRead, 9);
    assert.equal(auditSink.events[0]!.rowsReturned, 3);
    assert.equal(auditSink.events[0]!.permissionScopeKind, "jobs");
  });

  it("includes a still-current stage entered before the lookback window — the longest dweller is not dropped (regression: stage-lookback)", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [
          { id: 9, candidate_id: 1009, jobs: [{ id: 100 }], current_stage: { id: 7, name: "Phone Screen" }, status: "active", last_activity_at: "2026-06-20T12:00:00.000Z" },
        ], null, { rowCounts: { raw: 1, returned: 1 } });
      }
      if (toolName === "list_application_stages") {
        // Entered 2026-01-01 — well before windowStart (now=2026-06-23 minus 90d). Still current,
        // 200 days in stage: the single worst bottleneck. The old lower-bound filter dropped it silently.
        return scopedSuccess(toolName, [
          v3ApplicationStage({ id: 4009, application_id: 9, job_interview_stage_id: 7, entered_at: "2026-01-01T00:00:00.000Z", days_in_stage: 200, current: true }),
        ]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(scopedReader);
    const result = await runStageLatency(runtime, { min_age_days: 7 });
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.metrics.applications_considered, 1, "the >90d-old still-current stage must be analyzed, not window-filtered");
    assert.equal(data.metrics.max_stage_dwell_days, 200, "max dwell must reflect the long-current stage");
    assert.equal(data.rankings.length, 1);
    assert.equal(data.rankings[0].max_dwell_days, 200);
  });

  it("follows application cursor pages instead of truncating at maxPages", async () => {
    const scopedReader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_applications") {
        if (params?.cursor === "next-application-page") {
          return scopedSuccess(toolName, [
            { id: 2, candidate_id: 1002, job_id: 200, stage_id: 8, stage_name: "Onsite", status: "active", last_activity_at: "2026-06-21T12:00:00.000Z" },
          ], null, { rowCounts: { raw: 1, returned: 1 } });
        }
        assert.equal(params?.per_page, 500);
        return scopedSuccess(toolName, [
          { id: 1, candidate_id: 1001, job_id: 100, stage_id: 7, stage_name: "Phone Screen", status: "active", last_activity_at: "2026-06-20T12:00:00.000Z" },
        ], "next-application-page", { rowCounts: { raw: 1, returned: 1 } });
      }
      if (toolName === "list_application_stages") {
        assert.equal(params?.application_ids, "1,2");
        return scopedSuccess(toolName, [
          v3ApplicationStage({ id: 4001, application_id: 1, job_interview_stage_id: 7, entered_at: "2026-06-10T12:00:00.000Z", days_in_stage: 13, current: true }),
          v3ApplicationStage({ id: 4002, application_id: 2, job_interview_stage_id: 8, entered_at: "2026-06-11T12:00:00.000Z", days_in_stage: 12, current: true }),
        ]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(scopedReader, {
      limits: {
        maxPerPage: 100,
        defaultPerPage: 100,
        maxLookbackDays: 180,
        maxRankings: 25,
        maxEvidenceIds: 200,
        maxToolDurationMs: 30_000,
      },
    });

    const result = await runStageLatency(runtime, { min_age_days: 7 });

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.summary.rows_read, 2);
    assert.equal(data.summary.pages_read, 2);
    assert.equal(data.summary.read_status, "complete");
    assert.equal(data.summary.read_complete, true);
    assert.equal(data.summary.pagination_truncated, false);
    assert.equal(data.summary.rows_considered, 2);
    assert.deepStrictEqual(scopedReader.calls.map((call) => call.toolName), ["list_applications", "list_applications", "list_application_stages"]);
  });

  it("reads large stage cohorts in 50-id batches with at most three batches in flight", async () => {
    const applicationRows = Array.from({ length: 201 }, (_, index) => ({
      id: index + 1,
      candidate_id: 10_000 + index,
      job_id: 100,
      stage_id: 7,
      stage_name: "Phone Screen",
      status: "active",
    }));
    const stageBatches: number[][] = [];
    let activeStageReads = 0;
    let maxActiveStageReads = 0;
    const scopedReader = fakeScopedReader(async (toolName, params) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, applicationRows, null, {
          rowCounts: { raw: applicationRows.length, returned: applicationRows.length },
        });
      }
      if (toolName === "list_application_stages") {
        const ids = String(params?.application_ids).split(",").map(Number);
        stageBatches.push(ids);
        activeStageReads += 1;
        maxActiveStageReads = Math.max(maxActiveStageReads, activeStageReads);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeStageReads -= 1;
        return scopedSuccess(toolName, ids.map((applicationId) =>
          v3ApplicationStage({
            id: 50_000 + applicationId,
            application_id: applicationId,
            job_interview_stage_id: 7,
            entered_at: "2026-06-15T00:00:00.000Z",
            days_in_stage: 8,
            current: true,
          })
        ));
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(scopedReader);

    const result = await runStageLatency(runtime, {});

    assert.equal(result.ok, true);
    assert.deepStrictEqual(stageBatches.map((batch) => batch.length), [50, 50, 50, 50, 1]);
    assert.deepStrictEqual(stageBatches.flat(), applicationRows.map((row) => row.id));
    assert.equal(maxActiveStageReads, 3);
    assert.equal((result.ok ? result.data as any : null).summary.stage_rows_read, 201);
  });

  it("keeps completed stage batches as an honest partial when a later batch times out", async () => {
    const applicationRows = Array.from({ length: 51 }, (_, index) => ({
      id: index + 1,
      candidate_id: 20_000 + index,
      job_id: 100,
      stage_id: 7,
      stage_name: "Phone Screen",
      status: "active",
    }));
    const scopedReader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, applicationRows, null, {
          rowCounts: { raw: applicationRows.length, returned: applicationRows.length },
        });
      }
      if (toolName === "list_application_stages") {
        const ids = String(params?.application_ids).split(",").map(Number);
        if (ids[0] === 51) throw new Error("SCOPED_GREENHOUSE_TOOL_TIMEOUT:test");
        return scopedSuccess(toolName, ids.map((applicationId) =>
          v3ApplicationStage({
            id: 60_000 + applicationId,
            application_id: applicationId,
            job_interview_stage_id: 7,
            entered_at: "2026-06-15T00:00:00.000Z",
            days_in_stage: 8,
            current: true,
          })
        ));
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(scopedReader);

    const result = await runStageLatency(runtime, {});

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.summary.stage_rows_read, 50);
    assert.equal(data.summary.stage_read_status, "incomplete_timeout");
    assert.equal(data.summary.read_status, "incomplete_timeout");
    assert.equal(data.summary.read_complete, false);
    assert.equal(data.summary.pagination_truncated, true);
    assert.equal(data.completeness.status, "incomplete");
    assert.equal(data.metrics.applications_considered, 50);
  });

  it("keeps the completed concurrent prefix when the deadline expires before queued batches start", async () => {
    const startedAt = Date.parse("2026-06-23T12:00:00.000Z");
    let now = startedAt;
    const applicationRows = Array.from({ length: 201 }, (_, index) => ({
      id: index + 1,
      candidate_id: 30_000 + index,
      job_id: 100,
      stage_id: 7,
      stage_name: "Phone Screen",
      status: "active",
    }));
    let startedStageReads = 0;
    let releaseInitialReads!: () => void;
    const initialReadsStarted = new Promise<void>((resolve) => { releaseInitialReads = resolve; });
    const scopedReader = fakeScopedReader(async (toolName, params) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, applicationRows, null, {
          rowCounts: { raw: applicationRows.length, returned: applicationRows.length },
        });
      }
      if (toolName === "list_application_stages") {
        const ids = String(params?.application_ids).split(",").map(Number);
        startedStageReads += 1;
        if (startedStageReads === 3) releaseInitialReads();
        await initialReadsStarted;
        if (ids[0] === 1) now = startedAt + 1_001;
        return scopedSuccess(toolName, ids.map((applicationId) =>
          v3ApplicationStage({
            id: 70_000 + applicationId,
            application_id: applicationId,
            job_interview_stage_id: 7,
            entered_at: "2026-06-15T00:00:00.000Z",
            days_in_stage: 8,
            current: true,
          })
        ));
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(scopedReader, {
      now: () => now,
      limits: { ...DEFAULT_LIMITS, maxToolDurationMs: 1_000, maxAnalysisDurationMs: 1_000 },
    });

    const result = await runStageLatency(runtime, {});

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(startedStageReads, 3, "deadline-expired queued batches must not start upstream reads");
    assert.equal(data.summary.stage_rows_read, 150);
    assert.equal(data.summary.stage_read_status, "incomplete_timeout");
    assert.equal(data.summary.read_complete, false);
    assert.equal(data.completeness.status, "incomplete");
    assert.equal(data.metrics.applications_considered, 150);
  });

  it("defaults unsafe min_age_days values instead of propagating non-finite analysis knobs", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime } = analysisRuntime(scopedReader);

    const result = await runStageLatency(runtime, { min_age_days: "9".repeat(65) });

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.summary.min_age_days, 7);
  });

  it("drops unsafe stage labels from analysis output", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [
          { id: 1, candidate_id: 1001, job_id: 100, stage_id: null, stage_name: "Sensitive\nStage", status: "active", last_activity_at: "2026-06-20T12:00:00.000Z" },
        ]);
      }
      if (toolName === "list_application_stages") {
        return scopedSuccess(toolName, [
          v3ApplicationStage({ id: 4001, application_id: 1, job_interview_stage_id: null, entered_at: "2026-06-13T12:00:00.000Z", days_in_stage: 10, current: true }),
        ]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(scopedReader);

    const result = await runStageLatency(runtime, {});

    assert.equal(result.ok, true);
    const serialized = JSON.stringify(result.ok ? result.data : {});
    const data = result.ok ? result.data as any : null;
    assert.equal(data.rankings[0].stage_key, "stage_name:unknown");
    assert.equal(data.rankings[0].stage_name, null);
    assert.doesNotMatch(serialized, /Sensitive/);
  });

  it("drops unsafe row ids from affected jobs, grouping keys, and evidence ids", async () => {
    const unsafeId = Number.MAX_SAFE_INTEGER + 1;
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [
          { id: 1, candidate_id: unsafeId, job_id: unsafeId, stage_id: unsafeId, stage_name: "Phone Screen", status: "active", last_activity_at: "2026-06-20T12:00:00.000Z" },
        ]);
      }
      if (toolName === "list_application_stages") {
        return scopedSuccess(toolName, [
          v3ApplicationStage({ id: unsafeId, application_id: 1, job_interview_stage_id: unsafeId, entered_at: "2026-06-13T12:00:00.000Z", days_in_stage: 10, current: true }),
        ]);
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(scopedReader);

    const result = await runStageLatency(runtime, {});

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.summary.scoped_job_count, 0);
    assert.equal(data.rankings[0].stage_key, "stage_name:Phone Screen");
    assert.deepStrictEqual(data.rankings[0].affected_jobs, []);
    assert.deepStrictEqual(data.rankings[0].evidence_ids, ["application:1"]);
    assert.deepStrictEqual(data.job_breakdown, []);
    assert.doesNotMatch(JSON.stringify(data), /9007199254740992|9007199254740993/);
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

    const result = await runStageLatency(runtime, {});

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.summary.read_status, "incomplete_timeout");
    assert.equal(data.summary.read_complete, false);
    assert.equal(data.summary.pagination_truncated, true);
    assert.equal(data.completeness.status, "incomplete");
    // The fact-metric sidecar must agree with the canonical field: a truncated read is not "complete".
    assert.equal(data.fact_metric_layer.completeness.status, "incomplete_truncated");
    assert.deepStrictEqual(scopedReader.calls.map((call) => call.toolName), ["list_applications"]);
    assert.equal(auditSink.events[0]!.denialCode, null);
    assert.equal(auditSink.events[0]!.rowsRead, 0);
  });

  it("supports operator actAsUser preview without trusting tool params", async () => {
    const scopedReader = fakeScopedReader((toolName, params, options) => {
      assert.equal(params?.actAsUser, undefined);
      assert.equal(options?.actAsUser, 321);
      assert.ok(options?.signal instanceof AbortSignal);
      return scopedSuccess(toolName, [], null, {
        actorId: 900,
        effectiveActorId: 321,
        permissionScope: { kind: "jobs", permittedJobCount: 1 },
      });
    });
    const { runtime, auditSink } = analysisRuntime(scopedReader, { trustedActAsUser: 321 });

    const result = await runStageLatency(runtime, { actAsUser: 123, on_behalf_of_user_id: 456 });

    assert.equal(result.ok, true);
    assert.equal(auditSink.events[0]!.operator, true);
    assert.equal(auditSink.events[0]!.actAsUser, 321);
    assert.equal(auditSink.events[0]!.actorGreenhouseUserId, 900);
    assert.equal(auditSink.events[0]!.effectiveGreenhouseUserId, 321);
  });

  it("returns scoped denials without falling through", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedDenial(toolName, "PERMISSION_LOOKUP_FAILED"));
    const { runtime, auditSink } = analysisRuntime(scopedReader);

    const result = await runStageLatency(runtime, {});

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "PERMISSION_LOOKUP_FAILED");
    assert.equal(auditSink.events[0]!.denialCode, "PERMISSION_LOOKUP_FAILED");
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
    const result = await runStageLatency(runtime, {
      window_start: "2026-01-01T00:00:00.000Z",
      window_end: "2026-06-23T00:00:00.000Z",
    });
    assert.equal(result.ok, true, "an explicit window exceeding the cap must run, not deny");
    assert.ok(scopedReader.calls.length > 0, "the read must actually happen");

    // The FUZZY one-sided window stays capped: an ancient window_start with a defaulted end
    // exceeds the lookback limit and denies before any read.
    const fuzzy = await runStageLatency(runtime, { window_start: "2020-01-01T00:00:00.000Z" });
    assert.equal(fuzzy.ok, false);
    assert.equal(fuzzy.ok === false && fuzzy.denial.code, "LIMIT_EXCEEDED");
  });

  it("denies malformed analysis windows before reading applications", async () => {
    const scopedReader = fakeScopedReader(() => scopedSuccess("list_applications", []));
    const { runtime } = analysisRuntime(scopedReader);

    const result = await runStageLatency(runtime, { window_end: "not-a-date" });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "LIMIT_EXCEEDED");
    assert.equal(scopedReader.calls.length, 0);
  });
});
