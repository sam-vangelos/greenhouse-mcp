import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS } from "../src/limits.js";
import { BROAD_DIAGNOSTIC_RECIPES, PLANNER_RECIPE_IDS, runRecruitingQuestionAnswer } from "../src/tools/question-answer.js";
import { fakeScopedReader, scopedSuccess, testRuntime } from "./test-helpers.js";

// The inventory loader now issues four enrichment reads (offices/departments/job posts/post
// locations — the multi-signal matching joins, 2026-07-02) alongside list_jobs; planner tests
// assert the ANALYSIS reads, so the enrichment reads are filtered out of tool-call expectations.
const INVENTORY_ENRICHMENT_TOOLS = new Set(["list_offices", "list_departments", "list_job_posts", "list_job_post_locations"]);
function analysisToolCalls(reader: { calls: Array<{ toolName: string }> }): string[] {
  return reader.calls.map((call) => call.toolName).filter((name) => !INVENTORY_ENRICHMENT_TOOLS.has(name));
}

function ownedRecruiterScope(toolName: string, jobIds: number[]) {
  if (toolName === "list_jobs") {
    return scopedSuccess(toolName, jobIds.map((id) => ({ id, name: `Job ${id}`, status: "open" })));
  }
  if (toolName === "list_job_owners") {
    return scopedSuccess(toolName, jobIds.map((job_id) => ({ job_id, user_id: 100, type: "recruiter", responsible: false })));
  }
  return null;
}


describe("broad-diagnostic panel covers the full recipe set", () => {
  it("includes every planner recipe so 'run everything' never silently drops one", () => {
    for (const id of PLANNER_RECIPE_IDS) {
      assert.ok(
        BROAD_DIAGNOSTIC_RECIPES.includes(id as (typeof BROAD_DIAGNOSTIC_RECIPES)[number]),
        `${id} is a runnable recipe but is missing from BROAD_DIAGNOSTIC_RECIPES — a broad diagnostic would drop it`
      );
    }
  });
});

describe("recruiting question planner", () => {
  it("routes the unsubmitted-scorecard culpability question to scorecard accountability", async () => {
    const scopedReader = fakeScopedReader((toolName, params) => {
      assert.equal(params?.question, undefined);
      assert.equal(params?.greenhouse_user_id, undefined);
      const ownerScope = ownedRecruiterScope(toolName, [10, 20]);
      if (ownerScope) return ownerScope;
      if (toolName === "list_scorecards") {
        return scopedSuccess(toolName, [
          { id: 501, application_id: 100, interviewer_id: 7, status: "pending", submitted_at: null, interviewed_at: "2026-06-10T00:00:00.000Z" },
          { id: 502, application_id: 101, interviewer_id: 7, status: "submitted", submitted_at: "2026-06-20T00:00:00.000Z", interviewed_at: "2026-06-19T00:00:00.000Z" },
          { id: 503, application_id: 102, interviewer_id: 8, status: "pending", submitted_at: null, interviewed_at: "2026-06-01T00:00:00.000Z" },
        ], null, { rowCounts: { raw: 3, returned: 3 } });
      }
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [
          { id: 100, job_id: 10 },
          { id: 101, job_id: 10 },
          { id: 102, job_id: 20 },
        ]);
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime, auditSink } = testRuntime(scopedReader);

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "Across all my reqs, calculate % of scorecards over the last month that were unsubmitted and stack rank the perpetrators by severity/culpability.",
      greenhouse_user_id: 999,
      window_start: "2026-06-01T00:00:00.000Z",
      window_end: "2026-06-23T12:00:00.000Z",
      evidence_pack: true,
    });

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.deepStrictEqual(data.summary.selected_recipes, ["scorecard_accountability"]);
    assert.equal(data.summary.planner, "keyword-routed recipe planner");
    assert.equal(data.summary.domain_recognized, true);
    assert.deepStrictEqual(data.summary.plan.requiredMetrics, ["scorecard_submission_rate", "scorecard_overdue_rate"]);
    assert.deepStrictEqual(data.summary.plan.requiredFacts, ["scorecard_fact"]);
    assert.deepStrictEqual(data.summary.plan.requiredEndpoints, ["/v3/applications", "/v3/scorecards"]);
    assert.equal(data.summary.plan.requiredProjectionProfile, "recruiter_default");
    assert.equal(data.summary.plan.needsUserConfirmation, false);
    assert.equal(data.summary.rows_read, 6);
    assert.equal(data.summary.rows_considered, 3);
    assert.equal(data.analyses.length, 1);
    assert.equal(data.analyses[0].toolName, "analyze_scorecard_accountability");
    assert.equal(data.analyses[0].data.metrics.unsubmitted_scorecard_rate, 0.6667);
    assert.equal(data.analyses[0].data.fact_metric_layer.metric_results.scorecard_submission_rate.value, 1 / 3);
    assert.equal(data.analyses[0].data.rankings[0].person_id, 8);
    assert.deepStrictEqual(data.answer.interpretation[0].required_metrics, ["scorecard_submission_rate", "scorecard_overdue_rate"]);
    assert.deepStrictEqual(data.answer.interpretation[0].required_tools, [
      "analyze_scorecard_accountability",
      "search_my_scorecards",
      "search_my_applications",
      "get_my_application",
    ]);
    assert.equal(data.answer.interpretation[0].required_scope, "recruiter_permitted_jobs");
    assert.ok(data.answer.interpretation[0].completeness_requirements.length > 0);
    assert.ok(data.answer.interpretation[0].safety_notes.length > 0);
    assert.equal(auditSink.events.at(-1)?.tool, "answer_my_recruiting_question");
    assert.equal(auditSink.events.at(-1)?.rowsRead, 6);
    assert.equal(auditSink.events.some((event) => event.tool === "analyze_scorecard_accountability"), true);
  });

  it("uses the broad diagnostic recipe set only on explicit broad intent (\"across my reqs\")", async () => {
    const scopedReader = fakeScopedReader((toolName, params) => {
      const ownerScope = ownedRecruiterScope(toolName, [10]);
      if (ownerScope) return ownerScope;
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [
          { id: 100, candidate_id: 1000, job_id: 10, stage_id: 7, stage_name: "Phone Screen", status: "active", current_stage_at: "2026-06-01T00:00:00.000Z", last_activity_at: "2026-06-01T00:00:00.000Z", source_id: 1, referrer_id: 2, applied_at: "2026-06-01T00:00:00.000Z" },
          { id: 101, candidate_id: 1001, job_id: 10, stage_id: 8, stage_name: "Onsite", status: "hired", current_stage_at: "2026-06-20T00:00:00.000Z", last_activity_at: "2026-06-22T00:00:00.000Z", source_id: 1, referrer_id: 2, applied_at: "2026-06-02T00:00:00.000Z" },
        ]);
      }
      if (toolName === "list_application_stages") {
        return scopedSuccess(toolName, [
          { id: 4001, application_id: 100, job_interview_stage_id: 7, entered_at: "2026-06-01T00:00:00.000Z", exited_at: null, days_in_stage: 22, current: true },
        ]);
      }
      if (toolName === "list_scorecards") {
        return scopedSuccess(toolName, [
          { id: 501, application_id: 100, interviewer_id: 7, status: "pending", submitted_at: null, interviewed_at: "2026-06-10T00:00:00.000Z" },
        ]);
      }
      if (toolName === "list_sources") {
        return scopedSuccess(toolName, [{ id: 1, name: "LinkedIn", type: { id: 2, name: "Job Board" } }]);
      }
      if (toolName === "list_referrers") {
        return scopedSuccess(toolName, [{ id: 2, name: "Alice Referrer" }]);
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = testRuntime(scopedReader);

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is broken across my reqs right now?",
      max_recipes: 5,
      max_rankings: 5,
    });

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.deepStrictEqual(data.summary.selected_recipes, [
      "pipeline_quality",
      "stage_latency",
      "scorecard_accountability",
      "interview_feedback_drag",
      "source_quality",
    ]);
    assert.ok(data.summary.plan.requiredMetrics.includes("weekly_application_volume"));
    assert.ok(data.summary.plan.requiredMetrics.includes("stage_dwell_days"));
    assert.ok(data.summary.plan.requiredEndpoints.includes("/v3/application_stages"));
    assert.equal(data.answer.mode, "composite_analysis");
    assert.equal(data.summary.domain_recognized, true);
    assert.equal(data.analyses.length, 5);
    assert.equal(data.denials.length, 0);
  });

  it("returns missing_domain with domain_recognized=false for an unmatched, non-broad question — never a guessed broad composite (regression: silent fallback)", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_jobs") {
        return scopedSuccess(toolName, []);
      }
      throw new Error(`planner must not run a recipe read for an unmatched question (${toolName})`);
    });
    const { runtime } = testRuntime(scopedReader);
    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "Which candidates are the best cultural fit?",
    });
    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.answer.mode, "missing_domain");
    assert.equal(data.answer.domain_recognized, false);
    assert.equal(data.summary.domain_recognized, false);
    assert.equal(data.summary.completeness_status, "missing_domain");
    assert.deepStrictEqual(data.summary.selected_recipes, []);
    assert.deepStrictEqual(data.analyses, []);
    assert.deepStrictEqual(analysisToolCalls(scopedReader), ["list_jobs"]);
  });

  it("executes job-post exposure via the fact-backed planner (job_post_exposure_by_post), not a broad composite (T3.2)", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_jobs") return scopedSuccess(toolName, []);
      if (toolName === "list_tracking_links") {
        return scopedSuccess(toolName, [
          { id: 1, job_id: 10, job_post_id: 501, related_post_id: 501 },
          { id: 2, job_id: 10, job_post_id: 501, related_post_id: 501 },
          { id: 3, job_id: 10, job_post_id: 502, related_post_id: 502 },
        ]);
      }
      throw new Error(`planner must not run a recipe read for job-post exposure (${toolName})`);
    });
    const { runtime } = testRuntime(scopedReader);
    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "Which job posts are getting the most exposure?",
    });
    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.answer.mode, "planned_metric");
    assert.deepStrictEqual(data.summary.planned_metrics_run, ["job_post_exposure_by_post"]);
    assert.deepStrictEqual(data.summary.selected_recipes, []);
    // The proxy labeling survives through the planner path (don't fabricate).
    assert.ok((data.answer.metric.omissions as string[]).some((line) => line.includes("is_proxy")));
  });

  it("routes a satisfiable stage question that merely mentions 'approved' to stage_latency, not approval missing-domain (regression: over-match)", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_jobs") return scopedSuccess(toolName, []);
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [
          { id: 100, candidate_id: 1000, job_id: 10, stage_id: 7, stage_name: "Phone Screen", status: "active", current_stage_at: "2026-06-01T00:00:00.000Z", last_activity_at: "2026-06-01T00:00:00.000Z" },
        ]);
      }
      if (toolName === "list_application_stages") {
        return scopedSuccess(toolName, [
          { id: 4001, application_id: 100, job_interview_stage_id: 7, entered_at: "2026-06-01T00:00:00.000Z", exited_at: null, days_in_stage: 22, current: true },
        ]);
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = testRuntime(scopedReader);
    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "Which approved candidates are stuck in a stage?",
    });
    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.deepStrictEqual(data.summary.selected_recipes, ["stage_latency"]);
    assert.equal(data.answer.mode, "single_recipe_analysis");
  });

  it("executes 'opening aging' via the fact-backed planner (opening_fill_status), NEVER stage_latency (T3.2 + over-grab lock)", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      const ownerScope = ownedRecruiterScope(toolName, [10]);
      if (ownerScope) return ownerScope;
      if (toolName === "list_openings") {
        return scopedSuccess(toolName, [
          { id: 1, job_id: 10, status: "open", open: true, opened_at: "2026-06-01T00:00:00.000Z" },
          { id: 2, job_id: 10, status: "closed", open: false, closed_at: "2026-06-10T00:00:00.000Z" },
        ]);
      }
      // The over-grab core of the old lock survives: stage_latency (list_application_stages)
      // must NEVER run for an opening question.
      throw new Error(`opening question must not run a recipe read (${toolName})`);
    });
    const { runtime } = testRuntime(scopedReader);
    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "Which of my openings have the worst opening aging?",
    });
    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.answer.mode, "planned_metric");
    assert.deepStrictEqual(data.summary.planned_metrics_run, ["opening_fill_status"]);
    assert.deepStrictEqual(data.summary.selected_recipes, []);
    assert.equal(data.answer.metric.value, 1, "one open opening");
    assert.equal(data.answer.metric.denominator, 2);
  });

  it("routes 'which rejection reasons am I overusing' to rejection_reason_drift ONLY, not pipeline_quality (real recipe now)", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime } = testRuntime(scopedReader);
    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "Which rejection reasons am I overusing?",
    });
    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    // rejection-REASON concentration is a real recipe now; it must route ONLY to
    // rejection_reason_drift, never also to pipeline_quality's bare "rejection" keyword.
    assert.notEqual(data.answer.mode, "missing_domain");
    assert.deepStrictEqual(data.summary.selected_recipes, ["rejection_reason_drift"]);
    assert.ok(!data.summary.selected_recipes.includes("pipeline_quality"));
  });

  it("executes 'offer acceptance rate' via the fact-backed planner (offer_resolution), not a wrong recipe (T3.2 + over-grab lock)", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_jobs") return scopedSuccess(toolName, []);
      if (toolName === "list_offers") {
        return scopedSuccess(toolName, [
          { id: 1, job_id: 10, application_id: 101, status: "Accepted", sent_on: "2026-06-01" },
          { id: 2, job_id: 10, application_id: 102, status: "Rejected", sent_on: "2026-06-02" },
          // Out of "this quarter" (test clock = 2026-06-23): must be window-filtered out.
          { id: 3, job_id: 10, application_id: 103, status: "Accepted", sent_on: "2025-11-01" },
          // Unresolved (tenant vocab): counted in groups, excluded from the rate.
          { id: 4, job_id: 10, application_id: 104, status: "Created", sent_on: "2026-06-05" },
        ]);
      }
      throw new Error(`offer question must not run a recipe read (${toolName})`);
    });
    const { runtime } = testRuntime(scopedReader);
    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is my offer acceptance rate this quarter?",
    });
    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.answer.mode, "planned_metric");
    assert.deepStrictEqual(data.summary.planned_metrics_run, ["offer_resolution"]);
    // Live-pilot locks: "this quarter" is APPLIED (the 2025 offer is excluded — without the window
    // the ratio would be 2/3), and the rate is DERIVED from resolved statuses, tenant vocab
    // case-insensitive (Accepted/Rejected), unresolved Created excluded from the denominator.
    assert.equal(data.answer.metric.value, 0.5, "acceptance rate = 1 accepted / (1 accepted + 1 rejected), quarter-scoped");
    assert.equal(data.answer.metric.numerator, 1);
    assert.equal(data.answer.metric.denominator, 2);
    assert.equal(data.answer.metric.unit, "ratio");
    const groups = data.answer.metric.groups as Array<{ offer_status: string; offer_count: number }>;
    assert.deepStrictEqual(
      groups.sort((a, b) => a.offer_status.localeCompare(b.offer_status)),
      [{ offer_status: "Accepted", offer_count: 1 }, { offer_status: "Created", offer_count: 1 }, { offer_status: "Rejected", offer_count: 1 }]
    );
    assert.ok((data.answer.omissions as string[]).some((line) => line.includes("this quarter")), "the applied window is disclosed");
  });

  it("still routes a rejection RATE / fallout question to pipeline_quality (the reason-guard must not over-catch)", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime } = testRuntime(scopedReader);
    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is my rejection rate and pipeline fallout this month?",
    });
    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    // "rejection" without "reason" is a legitimate pipeline_quality question; the missing-domain guard
    // must not swallow it.
    assert.ok(data.summary.selected_recipes.includes("pipeline_quality"));
    assert.notEqual(data.answer.mode, "missing_domain");
  });

  it("rolls a child recipe's partial completeness up to the planner headline instead of reporting see_analyses (regression: recovered finding)", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_jobs") {
        return scopedSuccess(toolName, []);
      }
      if (toolName === "list_applications") {
        // 6 raw surfaced, 3 returned (2 active + 1 terminal) -> stage_latency reports completeness "partial".
        return scopedSuccess(toolName, [
          { id: 1, candidate_id: 1001, jobs: [{ id: 100 }], current_stage: { id: 7, name: "Phone Screen" }, status: "active", last_activity_at: "2026-06-20T12:00:00.000Z" },
          { id: 2, candidate_id: 1002, jobs: [{ id: 100 }], current_stage: { id: 7, name: "Phone Screen" }, status: "active", last_activity_at: "2026-06-21T12:00:00.000Z" },
          { id: 4, candidate_id: 1004, job_id: 300, stage_id: 7, stage_name: "Phone Screen", status: "rejected", current_stage_at: "2026-06-01T12:00:00.000Z", last_activity_at: "2026-06-05T12:00:00.000Z" },
        ], null, { rowCounts: { raw: 6, returned: 3 } });
      }
      if (toolName === "list_application_stages") {
        return scopedSuccess(toolName, [
          { id: 4001, application_id: 1, job_interview_stage_id: 7, entered_at: "2026-06-13T12:00:00.000Z", exited_at: null, days_in_stage: 10, current: true },
          { id: 4002, application_id: 2, job_interview_stage_id: 7, entered_at: "2026-06-12T12:00:00.000Z", exited_at: null, days_in_stage: 11, current: true },
        ]);
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = testRuntime(scopedReader);
    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "Where are the stage latency bottlenecks?",
    });
    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.deepStrictEqual(data.summary.selected_recipes, ["stage_latency"]);
    // The child analysis is "partial" (6 raw, 3 analyzed); the planner headline must reflect that
    // rather than reporting a bare "see_analyses" success.
    assert.equal(data.analyses[0].data.completeness.status, "partial");
    assert.equal(data.summary.completeness_status, "partial");
  });

  it("executes approval-bottleneck questions via the fact-backed planner (approval_latency pending-age), never a broad composite (T3.2)", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_jobs") {
        return scopedSuccess(toolName, []);
      }
      if (toolName === "list_approval_flows") {
        return scopedSuccess(toolName, [
          { id: 71, job_id: 10, approval_status: "pending", approval_type: "open_job", created_at: "2026-06-21T00:00:00.000Z" },
          { id: 72, job_id: 11, approval_status: "approved", approval_type: "open_job", created_at: "2026-06-01T00:00:00.000Z" },
        ]);
      }
      throw new Error(`planner should not run recipe read ${toolName}`);
    });
    const { runtime } = testRuntime(scopedReader);

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "Where are approval bottlenecks and how long are approvals taking?",
    });

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.answer.mode, "planned_metric");
    assert.deepStrictEqual(data.summary.planned_metrics_run, ["approval_latency"]);
    assert.deepStrictEqual(data.summary.selected_recipes, []);
    assert.equal(data.answer.metric.completeness, "complete");
    assert.equal(typeof data.answer.metric.value, "number", "pending-age median must be a real number");
    assert.equal((data.answer.metric.groups as unknown[]).length, 1, "resolved flows are excluded from pending-age");
    // Exactly the inventory probe + the planned domain read — still no recipe reads.
    assert.deepStrictEqual(analysisToolCalls(scopedReader), ["list_jobs", "list_approval_flows"]);
  });

  it("maps a novel weekly-volume prompt to application lifecycle metrics", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      const ownerScope = ownedRecruiterScope(toolName, [10]);
      if (ownerScope) return ownerScope;
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [
          { id: 100, candidate_id: 1000, job_id: 10, stage_id: 7, status: "active", created_at: "2026-06-15T00:00:00.000Z", last_activity_at: "2026-06-20T00:00:00.000Z" },
        ]);
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = testRuntime(scopedReader);

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "Show weekly application volume and qualified movement for my reqs.",
    });

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.deepStrictEqual(data.summary.selected_recipes, ["pipeline_quality"]);
    assert.ok(data.summary.plan.requiredMetrics.includes("weekly_application_volume"));
    assert.ok(data.summary.plan.requiredMetrics.includes("weekly_qualified_pipeline_movement"));
    assert.deepStrictEqual(data.summary.plan.requiredFacts, ["application_lifecycle_fact"]);
    assert.equal(data.analyses[0].data.fact_metric_layer.metric_results.weekly_application_volume.value, 1);
  });

  it("stops running planner recipes when the audit sink is unavailable", async () => {
    const scopedReader = fakeScopedReader((toolName) => {
      if (toolName === "list_jobs") {
        return scopedSuccess(toolName, []);
      }
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [
          { id: 100, candidate_id: 1000, job_id: 10, stage_id: 7, stage_name: "Phone Screen", status: "active", current_stage_at: "2026-06-01T00:00:00.000Z", last_activity_at: "2026-06-01T00:00:00.000Z" },
        ]);
      }
      throw new Error(`planner should have stopped before ${toolName}`);
    });
    const { runtime } = testRuntime(scopedReader, {
      auditSink: {
        emit() {
          throw new Error("audit sink unavailable at /secret/audit.jsonl token=shh");
        },
      },
    });

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is broken across my reqs right now?",
      max_recipes: 5,
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "AUDIT_UNAVAILABLE");
    assert.deepStrictEqual(analysisToolCalls(scopedReader), []);
    assert.doesNotMatch(JSON.stringify(result), /application:100|token=shh|secret\/audit/);
  });

  it("enforces one top-level time budget across planner recipes", async () => {
    let now = 0;
    const scopedReader = fakeScopedReader((toolName) => {
      const ownerScope = ownedRecruiterScope(toolName, [10]);
      if (ownerScope) return ownerScope;
      if (toolName === "list_applications") {
        now = 60;
        return scopedSuccess(toolName, [
          { id: 100, candidate_id: 1000, job_id: 10, stage_id: 7, stage_name: "Phone Screen", status: "active", current_stage_at: "2026-06-01T00:00:00.000Z", last_activity_at: "2026-06-01T00:00:00.000Z", source_id: 1, referrer_id: 2, applied_at: "2026-06-01T00:00:00.000Z" },
        ]);
      }
      throw new Error(`planner should have stopped before ${toolName}`);
    });
    const { runtime } = testRuntime(scopedReader, {
      limits: { ...DEFAULT_LIMITS, maxToolDurationMs: 50, maxAnalysisDurationMs: 50 },
      now: () => now,
    });

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is broken across my reqs right now?",
      max_recipes: 5,
    });

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.summary.planner_timed_out, true);
    assert.equal(data.summary.recipes_run_count, 1);
    assert.deepStrictEqual(data.analyses.map((entry: any) => entry.recipe), ["pipeline_quality", "stage_latency"]);
    assert.equal(data.analyses[1].status, "denied");
    assert.equal(data.analyses[1].denial.code, "TOOL_TIMEOUT");
    assert.deepStrictEqual(analysisToolCalls(scopedReader), ["list_jobs", "list_job_owners", "list_jobs", "list_applications"]);
  });

  it("honors explicit approved recipes and trusted operator preview without trusting tool params", async () => {
    const scopedReader = fakeScopedReader((toolName, params, options) => {
      assert.equal(params?.actAsUser, undefined);
      assert.equal(params?.greenhouse_user_id, undefined);
      assert.equal(options?.actAsUser, 321);
      assert.ok(options?.signal instanceof AbortSignal);
      if (toolName === "list_jobs") {
        return scopedSuccess(toolName, [], null, {
          actorId: 900,
          effectiveActorId: 321,
          permissionScope: { kind: "jobs", permittedJobCount: 1 },
        });
      }
      if (toolName === "list_sources" || toolName === "list_referrers") {
        return scopedSuccess(toolName, [
          toolName === "list_sources" ? { id: 1, name: "LinkedIn" } : { id: 2, name: "Alice Referrer" },
        ], null, {
          actorId: 900,
          effectiveActorId: 321,
          permissionScope: { kind: "jobs", permittedJobCount: 1 },
        });
      }
      assert.equal(toolName, "list_applications");
      return scopedSuccess(toolName, [
        { id: 100, candidate_id: 1000, job_id: 10, source_id: 1, referrer_id: 2, status: "rejected", applied_at: "2026-06-01T00:00:00.000Z", last_activity_at: "2026-06-01T00:00:00.000Z" },
      ], null, {
        actorId: 900,
        effectiveActorId: 321,
        permissionScope: { kind: "jobs", permittedJobCount: 1 },
      });
    });
    const { runtime, auditSink } = testRuntime(scopedReader, { trustedActAsUser: 321 });

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "Show me source yield issues.",
      recipes: "source_quality",
      actAsUser: 111,
      greenhouse_user_id: 222,
    });

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.deepStrictEqual(data.summary.selected_recipes, ["source_quality"]);
    assert.equal(auditSink.events.at(-1)?.tool, "answer_my_recruiting_question");
    assert.equal(auditSink.events.at(-1)?.operator, true);
    assert.equal(auditSink.events.at(-1)?.actAsUser, 321);
  });

  it("denies empty questions before reading scoped data", async () => {
    const scopedReader = fakeScopedReader(() => {
      throw new Error("planner should not read scoped data for invalid input");
    });
    const { runtime, auditSink } = testRuntime(scopedReader);

    const result = await runRecruitingQuestionAnswer(runtime, { question: "   " });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "INVALID_REQUEST");
    assert.equal(scopedReader.calls.length, 0);
    assert.equal(auditSink.events[0]?.tool, "answer_my_recruiting_question");
    assert.equal(auditSink.events[0]?.denialCode, "INVALID_REQUEST");
  });
});
