import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runScorecardAccountability } from "../src/tools/scorecard-accountability.js";
import { runInterviewFeedbackDrag } from "../src/tools/interview-feedback-drag.js";
import { runPipelineQuality } from "../src/tools/pipeline-quality.js";
import { registerRecruiterTools } from "../src/tools/register.js";
import { getRecruitingCapabilities } from "../src/resolvers/job-scope/capabilities.js";
import { analysisRuntime, fakeScopedReader, scopedSuccess, testRuntime } from "./test-helpers.js";

/**
 * Lane D / P3 — "windows mean one thing".
 *
 * D1/D1b: the scorecard recipes must select on the basis they actually analyse (interviewed_at, or
 * submitted_at when no interview date exists), server-side, instead of a created_at floor that has
 * nothing to do with the window they report.
 * D2/D2b: every row read lands in exactly one partition, so the completeness accounting identity
 * total_records_in_scope === records_analyzed + records_excluded holds.
 * D3: pipeline_quality's snapshot is labelled as current state and its weekly inflow is genuinely
 * windowed rather than silently anchored to now over a fixed 12-week horizon.
 * D4: the registered model-facing text states the clock.
 */

const NOW_ISO = "2026-06-23T12:00:00.000Z";
const WINDOW_START_ISO = "2026-05-24T12:00:00.000Z";

/**
 * Read a date-range bound off a read's params. BRACKET KEYS ONLY, deliberately: v3 documents both
 * encodings and honours both, but these reads are specified to send `interviewed_at[gte]`, and a
 * helper that also accepted the `gte|<iso>` pipe form would have passed a recipe that quietly went
 * back to the other one.
 */
function windowBounds(params: Record<string, unknown> | undefined, field: string): { gte?: string; lte?: string } {
  const out: { gte?: string; lte?: string } = {};
  if (!params) return out;
  const gte = params[`${field}[gte]`];
  const lte = params[`${field}[lte]`];
  if (typeof gte === "string") out.gte = gte;
  if (typeof lte === "string") out.lte = lte;
  return out;
}

function scorecardApplications() {
  return [{ id: 10, jobs: [{ id: 100 }] }, { id: 20, jobs: [{ id: 200 }] }];
}

describe("lane D P3 — scorecard recipes window on the basis they analyse", () => {
  it("D1 selects on interviewed_at/submitted_at, not a created_at floor, and keeps a card interviewed in-window but created long before it", async () => {
    // Created 20 days BEFORE window_start, interviewed inside the window. The old created_at floor
    // would have asked Greenhouse to drop exactly this row.
    const owed = {
      id: 1,
      application_id: 10,
      interviewer_id: 5,
      submitter_id: null,
      status: "pending",
      submitted_at: null,
      interviewed_at: "2026-06-10T00:00:00.000Z",
      created_at: "2026-05-04T00:00:00.000Z",
    };
    const seenScorecardParams: Array<Record<string, unknown> | undefined> = [];
    const reader = () =>
      fakeScopedReader((toolName, params) => {
        if (toolName === "list_scorecards") {
          seenScorecardParams.push(params);
          const interviewed = windowBounds(params, "interviewed_at");
          const submitted = windowBounds(params, "submitted_at");
          if (interviewed.gte !== undefined) return scopedSuccess(toolName, [owed]);
          if (submitted.gte !== undefined) return scopedSuccess(toolName, []);
          return scopedSuccess(toolName, []);
        }
        if (toolName === "list_applications") return scopedSuccess(toolName, scorecardApplications());
        throw new Error(`unexpected tool ${toolName}`);
      });

    for (const run of [runScorecardAccountability, runInterviewFeedbackDrag]) {
      seenScorecardParams.length = 0;
      const { runtime } = analysisRuntime(reader());
      const result = await run(runtime, {});
      assert.equal(result.ok, true, `${run.name} must succeed`);
      const data = result.ok ? (result.data as any) : null;

      const interviewedRead = seenScorecardParams.find((p) => windowBounds(p, "interviewed_at").gte !== undefined);
      const submittedRead = seenScorecardParams.find((p) => windowBounds(p, "submitted_at").gte !== undefined);
      assert.ok(interviewedRead, `${run.name}: expected a list_scorecards read filtered on interviewed_at`);
      assert.ok(submittedRead, `${run.name}: expected a list_scorecards read filtered on submitted_at`);
      assert.deepStrictEqual(windowBounds(interviewedRead, "interviewed_at"), { gte: WINDOW_START_ISO, lte: NOW_ISO });
      assert.deepStrictEqual(windowBounds(submittedRead, "submitted_at"), { gte: WINDOW_START_ISO, lte: NOW_ISO });
      for (const params of seenScorecardParams) {
        assert.equal(params?.created_at, undefined, `${run.name}: the created_at floor must be gone`);
      }

      assert.deepStrictEqual(
        data.rankings.map((row: any) => row.person_key),
        ["greenhouse_user:5"],
        `${run.name}: a card interviewed inside the window must be owed even when it was created before it`
      );
    }
  });

  it("D1b reads a submitted-only card through the second filter and dedupes rows seen by both", async () => {
    const interviewedCard = {
      id: 1,
      application_id: 10,
      interviewer_id: 5,
      submitter_id: null,
      status: "pending",
      submitted_at: null,
      interviewed_at: "2026-06-10T00:00:00.000Z",
      created_at: "2026-05-04T00:00:00.000Z",
    };
    const submittedOnlyCard = {
      id: 7,
      application_id: 20,
      interviewer_id: 6,
      submitter_id: 6,
      status: "submitted",
      submitted_at: "2026-06-12T00:00:00.000Z",
      interviewed_at: null,
      created_at: "2026-05-11T00:00:00.000Z",
    };
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_scorecards") {
        if (windowBounds(params, "interviewed_at").gte !== undefined) return scopedSuccess(toolName, [interviewedCard]);
        if (windowBounds(params, "submitted_at").gte !== undefined) {
          // The interviewed card is ALSO returned here, as a DISTINCT OBJECT carrying the same id —
          // which is what a second HTTP response actually is. Dedupe must key on the id, not on
          // object identity (`===` would have let this through as two rows).
          return scopedSuccess(toolName, [{ ...interviewedCard }, submittedOnlyCard]);
        }
        return scopedSuccess(toolName, []);
      }
      if (toolName === "list_applications") return scopedSuccess(toolName, scorecardApplications());
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(reader);
    const result = await runScorecardAccountability(runtime, {});
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.metrics.total_scorecards, 2, "the union must be deduped by scorecard id");
    assert.equal(data.completeness.total_records_in_scope, 2);
    assert.equal(data.summary.data_quality.in_window, 2);
    // The duplicate was one card returned twice, not a third row read: rows_read reports the same
    // population completeness does, never the two-read sum.
    assert.equal(data.summary.rows_read, 2);
  });

  it("D1b/6 keeps the FRESHEST copy of a card returned by both reads, not the first", async () => {
    // Unsubmitted when the interviewed_at read ran; submitted by the time the submitted_at read did.
    const stale = {
      id: 1,
      application_id: 10,
      interviewer_id: 5,
      submitter_id: null,
      status: "pending",
      submitted_at: null,
      interviewed_at: "2026-06-10T00:00:00.000Z",
      created_at: "2026-05-04T00:00:00.000Z",
      updated_at: "2026-06-10T01:00:00.000Z",
    };
    const fresh = {
      ...stale,
      status: "submitted",
      submitted_at: "2026-06-11T00:00:00.000Z",
      updated_at: "2026-06-11T00:00:01.000Z",
    };
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_scorecards") {
        if (windowBounds(params, "interviewed_at").gte !== undefined) return scopedSuccess(toolName, [stale]);
        if (windowBounds(params, "submitted_at").gte !== undefined) return scopedSuccess(toolName, [fresh]);
        return scopedSuccess(toolName, []);
      }
      if (toolName === "list_applications") return scopedSuccess(toolName, scorecardApplications());
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(reader);
    const result = await runScorecardAccountability(runtime, {});
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.metrics.total_scorecards, 1);
    assert.equal(
      data.metrics.unsubmitted_scorecards,
      0,
      "keeping the first copy reported a submitted scorecard as still owed"
    );
  });

  it("D1c/D18 derives application_ids ONCE for a job-scoped window and reads both filters against it", async () => {
    const card = {
      id: 1,
      application_id: 10,
      interviewer_id: 5,
      submitter_id: null,
      status: "pending",
      submitted_at: null,
      interviewed_at: "2026-06-10T00:00:00.000Z",
    };
    for (const run of [runScorecardAccountability, runInterviewFeedbackDrag]) {
      const applicationReads: Array<Record<string, unknown> | undefined> = [];
      const scorecardReads: Array<Record<string, unknown> | undefined> = [];
      const reader = fakeScopedReader((toolName, params) => {
        if (toolName === "list_applications") {
          applicationReads.push(params);
          return scopedSuccess(toolName, [{ id: 10, jobs: [{ id: 9001001 }] }]);
        }
        if (toolName === "list_scorecards") {
          scorecardReads.push(params);
          return scopedSuccess(toolName, windowBounds(params, "interviewed_at").gte !== undefined ? [card] : []);
        }
        throw new Error(`unexpected tool ${toolName}`);
      });
      const { runtime } = analysisRuntime(reader);
      const result = await run(runtime, { job_ids: "9001001" });
      assert.equal(result.ok, true, run.name);

      // Exactly ONE job -> application_ids bridge read, not one per window filter.
      const bridgeReads = applicationReads.filter((params) => params?.job_ids !== undefined);
      assert.equal(bridgeReads.length, 1, `${run.name}: the bridge must run once for both filters`);

      // D18: the bridge's own read carries no window range; each bridged scorecard read carries the
      // application_ids AND the exact bracket pair for its own basis.
      assert.deepStrictEqual(windowBounds(bridgeReads[0], "interviewed_at"), {}, run.name);
      assert.deepStrictEqual(windowBounds(bridgeReads[0], "submitted_at"), {}, run.name);
      assert.equal(scorecardReads.length, 2, run.name);
      assert.deepStrictEqual(windowBounds(scorecardReads[0], "interviewed_at"), { gte: WINDOW_START_ISO, lte: NOW_ISO }, run.name);
      assert.deepStrictEqual(windowBounds(scorecardReads[1], "submitted_at"), { gte: WINDOW_START_ISO, lte: NOW_ISO }, run.name);
      for (const params of scorecardReads) {
        assert.equal(params?.application_ids, "10", `${run.name}: every bridged scorecard read is bounded by application_ids`);
        assert.equal(params?.job_ids, undefined, `${run.name}: /v3/scorecards 422s on job_ids`);
      }
    }
  });

  it("D18 sends no range param on the UNSCOPED path's first read either", async () => {
    // The unscoped path issues the two window reads directly — there is no bridge read to confuse
    // with them, and neither read may carry a created_at floor.
    const seen: Array<Record<string, unknown> | undefined> = [];
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_scorecards") {
        seen.push(params);
        return scopedSuccess(toolName, []);
      }
      if (toolName === "list_applications") return scopedSuccess(toolName, scorecardApplications());
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(reader);
    const result = await runInterviewFeedbackDrag(runtime, {});
    assert.equal(result.ok, true);
    assert.equal(seen.length, 2);
    assert.deepStrictEqual(windowBounds(seen[0], "interviewed_at"), { gte: WINDOW_START_ISO, lte: NOW_ISO });
    assert.deepStrictEqual(windowBounds(seen[1], "submitted_at"), { gte: WINDOW_START_ISO, lte: NOW_ISO });
    for (const params of seen) {
      assert.equal(params?.created_at, undefined);
      assert.equal(params?.application_ids, undefined, "an unnarrowed read is not bridged");
    }
  });

  it("D9b returns the rows a first read got when the SECOND read is truncated, instead of failing", async () => {
    const card = {
      id: 1,
      application_id: 10,
      interviewer_id: 5,
      submitter_id: null,
      status: "pending",
      submitted_at: null,
      interviewed_at: "2026-06-10T00:00:00.000Z",
    };
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_scorecards") {
        if (windowBounds(params, "interviewed_at").gte !== undefined) return scopedSuccess(toolName, [card]);
        throw new Error("SCOPED_GREENHOUSE_TOOL_TIMEOUT:deadline");
      }
      if (toolName === "list_applications") return scopedSuccess(toolName, scorecardApplications());
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(reader);
    const result = await runScorecardAccountability(runtime, {});
    assert.equal(result.ok, true, "a completed first read must not be thrown away by the second read's timeout");
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.metrics.total_scorecards, 1);
    assert.equal(data.summary.read_complete, false);
    assert.equal(data.summary.read_status, "incomplete_timeout");
    assert.equal(data.completeness.status, "incomplete");
    assert.ok(
      data.summary.read_warnings.some((warning: string) => /submitted_at filter/.test(warning)),
      "the truncated second read must be disclosed, not silently dropped"
    );
  });

  it("D2 partitions a no-basis scorecard out of the accountability ranking and keeps the accounting identity", async () => {
    const inWindow = {
      id: 1,
      application_id: 10,
      interviewer_id: 5,
      submitter_id: null,
      status: "pending",
      submitted_at: null,
      interviewed_at: "2026-06-10T00:00:00.000Z",
      created_at: "2026-05-04T00:00:00.000Z",
    };
    const noBasis = {
      id: 2,
      application_id: 20,
      interviewer_id: 9,
      submitter_id: null,
      status: "pending",
      submitted_at: null,
      interviewed_at: null,
      created_at: "2026-05-18T00:00:00.000Z",
    };
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_scorecards") {
        if (windowBounds(params, "interviewed_at").gte !== undefined) return scopedSuccess(toolName, [inWindow, noBasis]);
        return scopedSuccess(toolName, []);
      }
      if (toolName === "list_applications") return scopedSuccess(toolName, scorecardApplications());
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(reader);
    const result = await runScorecardAccountability(runtime, {});
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;

    assert.equal(data.summary.data_quality.missing_basis, 1);
    assert.equal(data.summary.data_quality.in_window, 1);
    assert.equal(data.summary.data_quality.outside_window, 0);
    assert.ok(
      !data.rankings.some((row: any) => row.person_key === "greenhouse_user:9"),
      "a scorecard with neither an interview nor a submission date carries no owed-age and must not be ranked"
    );
    assert.deepStrictEqual(
      data.completeness.exclusion_reasons.find((entry: any) => entry.reason === "missing_window_basis"),
      { reason: "missing_window_basis", count: 1 }
    );
    assert.equal(
      data.completeness.total_records_in_scope,
      data.completeness.records_analyzed + data.completeness.records_excluded,
      "total_records_in_scope must equal records_analyzed + records_excluded"
    );
    // "partial", exactly: rows were excluded (the no-basis card), the inventory is complete, and
    // nothing was truncated. "not incomplete" would have passed on a truncated read too.
    assert.equal(data.completeness.status, "partial");
    assert.equal(data.completeness.inventory_complete, true);
    assert.match(
      JSON.stringify(data.summary.data_quality),
      /neither an interview date nor a submission date/,
      "the summary must disclose that basis-less scorecards are not selectable by the API"
    );
  });

  it("D2b counts a no-basis card and a submitted-before-interview card separately in feedback drag, and repairs its accounting identity", async () => {
    const inWindow = {
      id: 1,
      application_id: 10,
      interviewer_id: 5,
      submitter_id: null,
      status: "pending",
      submitted_at: null,
      interviewed_at: "2026-06-10T00:00:00.000Z",
      created_at: "2026-05-04T00:00:00.000Z",
    };
    const noBasis = {
      id: 2,
      application_id: 20,
      interviewer_id: 9,
      submitter_id: null,
      status: "pending",
      submitted_at: null,
      interviewed_at: null,
      created_at: "2026-05-18T00:00:00.000Z",
    };
    const submittedBeforeInterview = {
      id: 3,
      application_id: 20,
      interviewer_id: 8,
      submitter_id: 8,
      status: "submitted",
      submitted_at: "2026-06-10T00:00:00.000Z",
      interviewed_at: "2026-06-15T00:00:00.000Z",
      created_at: "2026-05-25T00:00:00.000Z",
    };
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_scorecards") {
        if (windowBounds(params, "interviewed_at").gte !== undefined) {
          return scopedSuccess(toolName, [inWindow, noBasis, submittedBeforeInterview]);
        }
        return scopedSuccess(toolName, []);
      }
      if (toolName === "list_applications") return scopedSuccess(toolName, scorecardApplications());
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(reader);
    const result = await runInterviewFeedbackDrag(runtime, { due_days: 2 });
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;

    assert.equal(data.summary.data_quality.missing_basis, 1);
    assert.equal(data.summary.data_quality.submitted_before_interview, 1);
    // ONE partition per row: the submitted-before-interview card used to be counted in `in_window`
    // as well, so 3 rows carried 4 memberships.
    assert.equal(data.summary.data_quality.in_window, 1);
    assert.equal(data.summary.data_quality.outside_window, 0);
    assert.equal(
      data.summary.data_quality.in_window +
        data.summary.data_quality.outside_window +
        data.summary.data_quality.missing_basis +
        data.summary.data_quality.submitted_before_interview,
      data.completeness.total_records_in_scope,
      "the window partitions must be disjoint and cover every row read"
    );
    assert.deepStrictEqual(
      data.completeness.exclusion_reasons.find((entry: any) => entry.reason === "missing_window_basis"),
      { reason: "missing_window_basis", count: 1 }
    );
    assert.deepStrictEqual(
      data.completeness.exclusion_reasons.find((entry: any) => entry.reason === "submitted_before_interview"),
      { reason: "submitted_before_interview", count: 1 }
    );
    assert.equal(
      data.completeness.total_records_in_scope,
      data.completeness.records_analyzed + data.completeness.records_excluded,
      "feedback drag's long-standing accounting mismatch must be gone"
    );
    assert.equal(data.completeness.status, "partial");
    assert.equal(data.completeness.inventory_complete, true);
    assert.equal(data.completeness.message, undefined);
  });
});

describe("lane D P3 — pipeline_quality labels the snapshot and windows the inflow", () => {
  function pipelineReader(rows: Array<Record<string, unknown>>) {
    return fakeScopedReader((toolName) => {
      if (toolName === "list_applications") return scopedSuccess(toolName, rows);
      throw new Error(`unexpected tool ${toolName}`);
    });
  }

  function application(id: number, createdAt: string, status = "active", extra: Record<string, unknown> = {}) {
    return {
      id,
      candidate_id: id + 500,
      job_id: 100,
      stage_id: 7,
      stage_name: "Onsite",
      status,
      created_at: createdAt,
      current_stage_at: createdAt,
      last_activity_at: createdAt,
      ...extra,
    };
  }

  it("D3 labels snapshot_as_of as now and drops freshness_window_start", async () => {
    const { runtime } = analysisRuntime(pipelineReader([application(1, "2026-06-19T00:00:00.000Z")]));
    const result = await runPipelineQuality(runtime, {
      window_start: "2026-06-01T00:00:00.000Z",
      window_end: "2026-06-10T00:00:00.000Z",
    });
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal("freshness_window_start" in data.summary, false, "freshness_window_start had one reader — its own emission");
    assert.equal(
      data.summary.snapshot_as_of,
      NOW_ISO,
      "/v3/applications returns CURRENT rows, so a historical window_end cannot rewind status; the label must say now"
    );
  });

  it("D3 emits inflow_window derived from the buckets the view actually produced", async () => {
    const { runtime } = analysisRuntime(
      pipelineReader([
        // The window's OWN first week must be able to produce the first bucket ...
        application(4, "2026-01-06T00:00:00.000Z"),
        application(1, "2026-01-13T00:00:00.000Z"),
        application(2, "2026-01-20T00:00:00.000Z"),
        application(3, "2026-01-27T00:00:00.000Z"),
        // ... and a genuinely earlier row must still be counted out of it.
        application(5, "2025-12-30T00:00:00.000Z"),
      ])
    );
    const result = await runPipelineQuality(runtime, {
      window_start: "2026-01-05T00:00:00.000Z",
      window_end: "2026-02-02T00:00:00.000Z",
    });
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    const inflow = data.summary.inflow_window;
    assert.ok(inflow, "summary.inflow_window must be emitted");
    assert.equal(inflow.start, "2026-01-05T00:00:00.000Z");
    assert.equal(inflow.end, "2026-02-02T00:00:00.000Z");
    assert.equal(inflow.weeks_covered, 4);
    assert.equal(inflow.first_bucket_week, "2026-01-05");
    assert.equal(inflow.last_bucket_week, "2026-01-26");
    assert.equal(inflow.excluded_before_window, 1);
    assert.equal(inflow.excluded_after_window, 0);
    assert.equal(inflow.missing_timestamp, 0);
    // excluded_before_window belongs to the inflow window, NOT to completeness: those rows are still
    // analysed in the snapshot cohort.
    assert.equal(
      data.completeness.exclusion_reasons.some((entry: any) => entry.reason === "excluded_before_window"),
      false
    );
  });

  it("D3 covers a historical explicit window instead of returning an empty weekly series", async () => {
    const { runtime } = analysisRuntime(
      pipelineReader([
        application(1, "2026-01-13T00:00:00.000Z"),
        application(2, "2026-01-20T00:00:00.000Z"),
        application(3, "2026-01-27T00:00:00.000Z"),
      ])
    );
    const result = await runPipelineQuality(runtime, {
      window_start: "2026-01-05T00:00:00.000Z",
      window_end: "2026-02-02T00:00:00.000Z",
    });
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.deepStrictEqual(
      data.temporal.weekly_inflow.map((bucket: any) => bucket.week),
      ["2026-01-12", "2026-01-19", "2026-01-26"],
      "a six-months-ago window must bucket over that span, not over the 12 weeks before now"
    );
    assert.ok(data.temporal.week_over_week, "both comparison weeks sit fully inside this window");
    assert.equal(data.temporal.week_over_week.current_week, "2026-01-26");
    assert.equal(data.temporal.week_over_week.prior_week, "2026-01-19");
  });

  it("D3 nulls week-over-week with a reason rather than substituting 0 for a week outside the window", async () => {
    const { runtime } = analysisRuntime(
      pipelineReader([
        application(1, "2026-06-02T00:00:00.000Z"),
        application(2, "2026-06-09T00:00:00.000Z"),
        application(3, "2026-06-16T00:00:00.000Z"),
        application(4, "2026-06-19T00:00:00.000Z"),
      ])
    );
    const result = await runPipelineQuality(runtime, {
      window_start: "2026-06-18T12:00:00.000Z",
      window_end: NOW_ISO,
    });
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.temporal.week_over_week, null, "a comparison week that is not fully inside the window is not a 0");
    assert.equal(data.temporal.velocity, null);
    assert.match(String(data.temporal.comparison_unavailable_reason ?? ""), /window/i);
    // Three applications predate the Thursday window_start; the 06-19 one does NOT. It sits inside
    // the window, in the same calendar week as window_start, and is inflow — not an exclusion.
    assert.equal(data.summary.inflow_window.excluded_before_window, 3);
    assert.deepStrictEqual(
      data.temporal.weekly_inflow.map((bucket: any) => ({ week: bucket.week, count: bucket.count, partial: bucket.partial })),
      [{ week: "2026-06-15", count: 1, partial: true }],
      "the window's own first week is a PARTIAL week of inflow, not a deleted one"
    );
  });

  it("D3b bounds a midweek window on each record's own timestamp, not on its week's Monday", async () => {
    // Wednesday start, Thursday end — the ordinary shape of a caller-stated window, and the shape
    // that made bucket-first classification wrong at BOTH edges.
    const { runtime } = analysisRuntime(
      pipelineReader([
        application(1, "2026-06-02T00:00:00.000Z"), // before window_start, same week as it
        application(2, "2026-06-04T00:00:00.000Z"), // INSIDE, same week as window_start
        application(3, "2026-06-09T00:00:00.000Z"), // INSIDE, anchor week
        application(4, "2026-06-12T00:00:00.000Z"), // after window_end, same week as it
      ])
    );
    const result = await runPipelineQuality(runtime, {
      window_start: "2026-06-03T00:00:00.000Z",
      window_end: "2026-06-11T00:00:00.000Z",
    });
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    const inflow = data.summary.inflow_window;
    assert.equal(inflow.excluded_before_window, 1, "only application 1 predates window_start");
    assert.equal(
      inflow.excluded_after_window,
      1,
      "a row created after window_end INSIDE the anchor week was displayed as inflow and counted nowhere"
    );
    assert.deepStrictEqual(
      data.temporal.weekly_inflow.map((bucket: any) => ({ week: bucket.week, count: bucket.count, partial: bucket.partial })),
      [
        { week: "2026-06-01", count: 1, partial: true },
        { week: "2026-06-08", count: 1, partial: true },
      ]
    );
    assert.equal(inflow.first_bucket_week, "2026-06-01");
    assert.equal(inflow.last_bucket_week, "2026-06-08");
    // The fact layer's weekly metrics see exactly the in-window applications.
    assert.equal(data.fact_metric_layer.metric_results.weekly_application_volume.value, 2);
    assert.deepStrictEqual(
      data.fact_metric_layer.metric_results.weekly_application_volume.groups.map((group: any) => group.week),
      ["2026-06-01", "2026-06-08"]
    );
  });

  it("D3b reports no in_progress_week for a historical window, and one for a live window", async () => {
    const rows = [application(1, "2026-06-09T00:00:00.000Z"), application(2, "2026-06-22T12:00:00.000Z")];
    const historical = await runPipelineQuality(analysisRuntime(pipelineReader(rows)).runtime, {
      window_start: "2026-06-03T00:00:00.000Z",
      window_end: "2026-06-11T00:00:00.000Z",
    });
    assert.equal(historical.ok, true);
    assert.equal(
      (historical.ok ? (historical.data as any) : null).temporal.in_progress_week,
      null,
      "a window that ended twelve days ago has no still-accumulating week"
    );

    const live = await runPipelineQuality(analysisRuntime(pipelineReader(rows)).runtime, {
      window_start: "2026-06-01T00:00:00.000Z",
      window_end: NOW_ISO,
    });
    assert.equal(live.ok, true);
    const liveWeek = (live.ok ? (live.data as any) : null).temporal.in_progress_week;
    assert.ok(liveWeek, "the live week IS still accumulating and stays reported");
    assert.equal(liveWeek.week, "2026-06-22");
  });

  it("D3b keeps the weekly metrics on the inflow cohort and source quality on the whole snapshot", async () => {
    const { runtime } = analysisRuntime(
      pipelineReader([
        application(1, "2026-01-13T00:00:00.000Z", "active", { source_id: 11 }),
        application(2, "2026-01-20T00:00:00.000Z", "hired", { source_id: 11 }),
        application(3, "2025-11-04T00:00:00.000Z", "active", { source_id: 22 }),
        application(4, "2025-11-11T00:00:00.000Z", "rejected", { source_id: 22 }),
      ])
    );
    const result = await runPipelineQuality(runtime, {
      window_start: "2026-01-05T00:00:00.000Z",
      window_end: "2026-02-02T00:00:00.000Z",
    });
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    const results = data.fact_metric_layer.metric_results;
    assert.equal(results.weekly_application_volume.value, 2, "the weekly metric sees only the windowed inflow");
    assert.equal(results.weekly_qualified_pipeline_movement.value, 2);
    assert.equal(data.summary.inflow_window.excluded_before_window, 2);
    // source_quality_by_outcome is NOT weekly: it is a property of the whole read, and handing it the
    // inflow cohort emptied it silently while four sourced applications sat in hand.
    assert.deepStrictEqual(
      results.source_quality_by_outcome.groups,
      [
        { source_id: 11, applications: 2, positive_outcomes: 1, quality_rate: 0.5 },
        { source_id: 22, applications: 2, positive_outcomes: 0, quality_rate: 0 },
      ]
    );
    assert.deepStrictEqual(results.source_quality_by_outcome.omissions, []);
  });

  it("D3b computes staleness as of NOW, which is what snapshot_as_of says", async () => {
    // Last activity 06-05, window_end 06-10, now 06-23. As of window_end the row is 5 days idle and
    // not stale; as of now it is 18 days idle and stale. The label says now, so the number must be now's.
    const { runtime } = analysisRuntime(
      pipelineReader([
        {
          id: 1,
          candidate_id: 501,
          job_id: 100,
          stage_id: 7,
          stage_name: "Onsite",
          status: "active",
          created_at: "2026-06-01T00:00:00.000Z",
          current_stage_at: "2026-06-01T00:00:00.000Z",
          last_activity_at: "2026-06-05T00:00:00.000Z",
        },
      ])
    );
    const result = await runPipelineQuality(runtime, {
      window_start: "2026-06-01T00:00:00.000Z",
      window_end: "2026-06-10T00:00:00.000Z",
    });
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.summary.snapshot_as_of, NOW_ISO);
    assert.equal(
      data.metrics.stale_active_applications,
      1,
      "staleness computed as of a historical window_end contradicts the snapshot_as_of label above it"
    );
  });
});

describe("lane D P3 — the registered text states the clock", () => {
  function registeredDescriptions() {
    const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime } = testRuntime(reader);
    const descriptions = new Map<string, string>();
    const schemas = new Map<string, Record<string, any>>();
    registerRecruiterTools(
      {
        tool(name: string, description: string, paramsSchema: Record<string, any>) {
          descriptions.set(name, description);
          schemas.set(name, paramsSchema);
        },
      } as any,
      runtime
    );
    return { descriptions, schemas };
  }

  it("D4 states the pipeline clock on the registered tool and the capability recipe", () => {
    const { descriptions, schemas } = registeredDescriptions();
    const registered = descriptions.get("analyze_pipeline_quality") ?? "";
    assert.match(registered, /snapshot of current state/i);
    assert.match(registered, /weekly inflow is bucketed by application created date over the window/i);

    const recipe = getRecruitingCapabilities().recipes.find((entry) => entry.id === "pipeline_quality");
    assert.ok(recipe);
    assert.match(recipe.description, /snapshot of current state/i);
    assert.match(recipe.description, /weekly inflow is bucketed by application created date over the window/i);

    const windowStart = schemas.get("analyze_pipeline_quality")?.window_start?.description ?? "";
    assert.doesNotMatch(windowStart, /freshness lookback/i, "window_start no longer means a 'freshness lookback'");
  });

  it("D4 states the scorecard clock on both registered scorecard tools and their capability recipes", () => {
    const { descriptions } = registeredDescriptions();
    for (const name of ["analyze_scorecard_accountability", "analyze_interview_feedback_drag"]) {
      const registered = descriptions.get(name) ?? "";
      assert.match(registered, /windowed on the interview date/i, `${name} must state its clock`);
      assert.match(registered, /submission date when no interview date is recorded/i, `${name} must state its fallback`);
    }
    for (const id of ["scorecard_accountability", "interview_feedback_drag"]) {
      const recipe = getRecruitingCapabilities().recipes.find((entry) => entry.id === id);
      assert.ok(recipe, `${id} recipe missing`);
      assert.match(recipe.description, /windowed on the interview date/i);
      assert.match(recipe.description, /submission date when no interview date is recorded/i);
    }
  });
});
