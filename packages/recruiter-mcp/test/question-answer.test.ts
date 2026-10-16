import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS } from "../src/limits.js";
import {
  BROAD_DIAGNOSTIC_RECIPES,
  DEFAULT_MAX_RECIPES,
  PLANNER_RECIPE_IDS,
  QUESTION_ANSWER_TOOL,
  runRecruitingQuestionAnswer,
} from "../src/tools/question-answer.js";
import { createFixtureInventoryProvider, type JobScopeFixture } from "../src/resolvers/job-scope/inventory.js";
import { fakeScopedReader, scopedDenial, scopedSuccess, scorecardWindowFilter, testRuntime } from "./test-helpers.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

  // Item 17: the default ceiling is DERIVED from the registry. A hand-written 6 would silently
  // select a seventh registered recipe out of every broad run, and no test would notice.
  it("item 17: the default recipe ceiling equals the registered recipe count", () => {
    assert.equal(DEFAULT_MAX_RECIPES, PLANNER_RECIPE_IDS.length);
  });

  // Item 14: the tool description must describe the contract the code actually implements.
  it("item 14: the tool description states the approximate-composite contract", () => {
    assert.equal(
      /closest available analyses by name/.test(QUESTION_ANSWER_TOOL.description),
      false,
      "the old 'names only' refusal wording no longer describes what the planner does"
    );
    assert.match(QUESTION_ANSWER_TOOL.description, /approximat/i);
  });
});

describe("item 17: an EXPLICIT broad-diagnostic request runs the whole panel", () => {
  it("'give me a full diagnostic' selects every registered recipe", async () => {
    const reader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [
          { id: 100, candidate_id: 1000, job_id: 10, source_id: 1, referrer_id: 2, status: "active", applied_at: "2026-06-10T00:00:00.000Z", last_activity_at: "2026-06-11T00:00:00.000Z", stage_id: 7, stage_name: "Phone Screen", current_stage_at: "2026-06-10T00:00:00.000Z" },
        ]);
      }
      return scopedSuccess(toolName, []);
    });
    const { runtime } = testRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, { question: "Give me a full diagnostic." });

    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.summary.selected_recipe_count, PLANNER_RECIPE_IDS.length);
    assert.deepStrictEqual([...data.summary.selected_recipes].sort(), [...PLANNER_RECIPE_IDS].sort());
    assert.equal(data.answer.domain_recognized, true, "an explicit broad request is not an approximation");
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
        // Answer only the interviewed_at read: these fixtures all carry an interviewed_at.
        if (scorecardWindowFilter(params) === "submitted_at") return scopedSuccess(toolName, []);
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
    // 6 = 3 scorecards + the application_ids bridge derive (3), which now runs ONCE for both
    // window-basis reads instead of once per read. The ids cannot change between two reads inside
    // one tool call, so the second derive was pure re-read cost (9 -> 6 on this fixture).
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
        // Answer only the interviewed_at read: these fixtures all carry an interviewed_at.
        if (scorecardWindowFilter(params) === "submitted_at") return scopedSuccess(toolName, []);
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

  // INVERTED by CLO-275. This locked the planner into a dead end for anything outside the keyword
  // vocabulary — the refusal was the whole answer. The property worth keeping is not the refusal
  // but the LABEL: the broad panel may run, and it must never be dressed up as a confident answer
  // to the specific question that was asked.
  it("CLO-275: an unmatched, non-broad question gets a LABELLED approximation, never a confident composite", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime } = testRuntime(scopedReader);
    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "Which candidates are the best cultural fit?",
    });
    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.equal(data.answer.mode, "approximate_composite", "never composite_analysis: nothing matched this question");
    assert.equal(data.answer.domain_recognized, false);
    assert.equal(data.summary.domain_recognized, false);
    assert.deepStrictEqual(data.summary.selected_recipes, BROAD_DIAGNOSTIC_RECIPES);
    assert.match(data.answer.message, /Treat this as an approximation and rephrase toward one of:/);
    assert.ok(data.analyses.length > 0, "the panel ran rather than dead-ending");
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
    const scopedReader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_jobs") return scopedSuccess(toolName, []);
      if (toolName === "list_offers") {
        return scopedSuccess(toolName, [
          { id: 1, job_id: 10, application_id: 101, status: "Accepted", sent_on: "2026-06-01", resolved_at: "2026-06-05T10:00:00.000Z" },
          { id: 2, job_id: 10, application_id: 102, status: "Rejected", sent_on: "2026-06-02", resolved_at: "2026-06-06T10:00:00.000Z" },
          // Out of "this quarter" (test clock = 2026-06-23): must be window-filtered out.
          { id: 3, job_id: 10, application_id: 103, status: "Accepted", sent_on: "2025-11-01", resolved_at: "2025-11-05T10:00:00.000Z" },
          // Still out: a Created offer has no resolved_at by definition, so the window cannot place
          // it. It is reported as outstanding rather than dropped.
          { id: 4, job_id: 10, application_id: 104, status: "Created", sent_on: "2026-06-05" },
        ]);
      }
      if (toolName === "list_applications") {
        const ids = String(params?.ids ?? "").split(",").filter(Boolean).map(Number);
        return scopedSuccess(toolName, ids.map((id: number) => ({ id, job_id: 10, status: "hired" })));
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
    // Time-window and rate locks: "this quarter" is APPLIED (the 2025 offer is excluded — without the window
    // the ratio would be 2/3), and the rate is DERIVED from resolved statuses, tenant vocab
    // case-insensitive (Accepted/Rejected), unresolved Created excluded from the denominator.
    assert.equal(data.answer.metric.value, 0.5, "acceptance rate = 1 accepted / (1 accepted + 1 rejected), quarter-scoped");
    assert.equal(data.answer.metric.numerator, 1);
    assert.equal(data.answer.metric.denominator, 2);
    assert.equal(data.answer.metric.unit, "ratio");
    const groups = data.answer.metric.groups as Array<{ offer_status: string; offer_count: number }>;
    // H0b: the window now runs on resolved_at (the clock every published hire report uses), so the
    // still-Created offer cannot be placed in it. It is counted as outstanding — the old fixture
    // had it inside the mix only because sent_on placed it there.
    assert.deepStrictEqual(
      [...groups].sort((a, b) => (a.offer_status < b.offer_status ? -1 : 1)),
      [
        { offer_status: "Accepted", offer_count: 1 },
        { offer_status: "Rejected", offer_count: 1 },
        { offer_status: "outstanding_no_resolved_at", offer_count: 1 },
      ]
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

// ---------------------------------------------------------------------------
// P3-router: a question's own time window reaches the recipes.
// "this month" used to be parsed for the planned-domain path only; a recipe question
// carrying the same phrase silently answered over the recipe's default lookback.
// ---------------------------------------------------------------------------

const NOW_MS = Date.parse("2026-06-23T12:00:00.000Z");

function windowReader() {
  return fakeScopedReader((toolName) => {
    if (toolName === "list_jobs") return scopedSuccess(toolName, []);
    if (toolName === "list_applications") {
      return scopedSuccess(toolName, [
        { id: 100, candidate_id: 1000, job_id: 10, source_id: 1, referrer_id: 2, status: "active", applied_at: "2026-06-10T00:00:00.000Z", last_activity_at: "2026-06-11T00:00:00.000Z", stage_id: 7, stage_name: "Phone Screen", current_stage_at: "2026-06-10T00:00:00.000Z" },
      ]);
    }
    if (toolName === "list_application_stages") {
      return scopedSuccess(toolName, [
        { id: 4001, application_id: 100, job_interview_stage_id: 7, entered_at: "2026-06-10T00:00:00.000Z", exited_at: null, days_in_stage: 13, current: true },
      ]);
    }
    if (toolName === "list_sources") return scopedSuccess(toolName, [{ id: 1, name: "LinkedIn", type: { id: 2, name: "Job Board" } }]);
    if (toolName === "list_referrers") return scopedSuccess(toolName, [{ id: 2, name: "Alice Referrer" }]);
    throw new Error(`unexpected scoped tool ${toolName}`);
  });
}

// H0b: every offer row now carries resolved_at, because the planner windows on resolved_at rather
// than sent_on. The dates match the old sent_on values so each test's window arithmetic is
// unchanged; only the field the window reads has moved.
function offerWindowReader() {
  return fakeScopedReader((toolName, params) => {
    if (toolName === "list_jobs") return scopedSuccess(toolName, []);
    if (toolName === "list_offers") {
      return scopedSuccess(toolName, [
        { id: 1, job_id: 10, application_id: 101, status: "Accepted", sent_on: "2026-05-10", resolved_at: "2026-05-10" },
        { id: 2, job_id: 10, application_id: 102, status: "Rejected", sent_on: "2026-06-02", resolved_at: "2026-06-02" },
        { id: 3, job_id: 10, application_id: 103, status: "Accepted", sent_on: "2026-06-10", resolved_at: "2026-06-10" },
      ]);
    }
    if (toolName === "list_applications") return bridgedHiredApplications(params);
    throw new Error(`unexpected scoped tool ${toolName}`);
  });
}

/**
 * The planner's offer path opens its answer with the reconciliation line's two cheap counts, and
 * the second of them costs one bridged /v3/applications read keyed by the accepted set's
 * application_ids. Every offer fixture answers it.
 */
function bridgedHiredApplications(params?: Record<string, unknown>) {
  const ids = String(params?.ids ?? "").split(",").filter(Boolean).map(Number);
  return scopedSuccess("list_applications", ids.map((id: number) => ({ id, job_id: 10, status: "hired" })));
}

describe("recruiting question planner — the question's own time window", () => {
  it("A12: forwards a phrase window to every selected recipe and discloses it", async () => {
    const reader = windowReader();
    const { runtime } = testRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "How many candidates did we source from LinkedIn this month?",
    });

    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.deepStrictEqual(data.summary.selected_recipes, ["source_quality"]);
    assert.deepStrictEqual(data.summary.applied_time_window, {
      label: "this month",
      window_start: "2026-06-01T00:00:00.000Z",
      window_end: "2026-06-23T12:00:00.000Z",
      origin: "question",
    });
    assert.equal(data.analyses[0].params.window_start, "2026-06-01T00:00:00.000Z");
    assert.equal(data.analyses[0].params.window_end, "2026-06-23T12:00:00.000Z");
  });

  it("A12b: a phrase window runs UNCAPPED — a stated intent is not a fuzzy default", async () => {
    const reader = windowReader();
    const { runtime } = testRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What did our source quality look like over the last 400 days?",
    });

    // maxLookbackDays (365) exists only to bound the FUZZY default window (limits.ts:475-480).
    // A window the recruiter stated out loud must not be denied by it.
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.summary.applied_time_window.label, "last 400 days");
    assert.equal(data.summary.applied_time_window.origin, "question");
    assert.equal(data.summary.applied_time_window.window_start, new Date(NOW_MS - 400 * 86_400_000).toISOString());
    assert.equal(data.analyses[0].status, "ok", "an explicitly asked 400-day window must not be denied");
    assert.deepStrictEqual(data.denials, []);
    // Item 16: the disclosure is not the delivery. Assert the RECIPE received the 400-day bounds —
    // a router that discloses a window it never forwards passes the disclosure assertion alone.
    assert.equal(data.analyses[0].params.window_start, new Date(NOW_MS - 400 * 86_400_000).toISOString());
    assert.equal(data.analyses[0].params.window_end, new Date(NOW_MS).toISOString());
  });

  it("A13: ONE explicit bound blocks parsing and is reported one-sided, not completed into an interval", async () => {
    const reader = windowReader();
    const { runtime } = testRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "How is source quality trending last quarter?",
      window_start: "2026-05-01T00:00:00.000Z",
    });

    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.deepStrictEqual(data.summary.applied_time_window, {
      label: null,
      window_start: "2026-05-01T00:00:00.000Z",
      window_end: null,
      origin: "explicit",
    });
    assert.equal(data.analyses[0].params.window_start, "2026-05-01T00:00:00.000Z");
    assert.equal(data.analyses[0].params.window_end, undefined, "the phrase must not fill in the missing bound");
  });

  it("A14: no phrase and no explicit bound means no window params and no claim of one", async () => {
    const reader = windowReader();
    const { runtime } = testRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "Where are the stage latency bottlenecks?",
    });

    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.summary.applied_time_window, null);
    assert.equal(data.analyses[0].params.window_start, undefined);
    assert.equal(data.analyses[0].params.window_end, undefined);
  });

  it("A14b: the planned-domain path discloses the phrase label, not 'explicit window params'", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_jobs") return scopedSuccess(toolName, []);
      if (toolName === "list_offers") {
        return scopedSuccess(toolName, [
          { id: 1, job_id: 10, application_id: 101, status: "Accepted", sent_on: "2026-06-01", resolved_at: "2026-06-01" },
          { id: 2, job_id: 10, application_id: 102, status: "Rejected", sent_on: "2026-06-02", resolved_at: "2026-06-02" },
        ]);
      }
      if (toolName === "list_applications") return bridgedHiredApplications(params);
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = testRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is the offer acceptance rate this month?",
    });

    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.answer.mode, "planned_metric");
    assert.deepStrictEqual(data.summary.applied_time_window, {
      label: "this month",
      window_start: "2026-06-01T00:00:00.000Z",
      window_end: "2026-06-23T12:00:00.000Z",
      origin: "question",
    });
    assert.ok((data.answer.omissions as string[]).some((line) => line.includes("this month")));
    assert.ok(!(data.answer.omissions as string[]).some((line) => line.includes("explicit window params")));
  });

  // Item 20: the mirror of A14b — an explicit two-sided window on the planned-domain path.
  it("A14c: the planned-domain path labels an EXPLICIT window as explicit", async () => {
    const reader = offerWindowReader();
    const { runtime } = testRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is the offer acceptance rate?",
      window_start: "2026-06-01T00:00:00.000Z",
      window_end: "2026-06-30T00:00:00.000Z",
    });

    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.answer.mode, "planned_metric");
    assert.equal(data.summary.applied_time_window.origin, "explicit");
    assert.equal(data.summary.applied_time_window.window_start, "2026-06-01T00:00:00.000Z");
    assert.equal(data.summary.applied_time_window.window_end, "2026-06-30T00:00:00.000Z");
    assert.ok((data.answer.omissions as string[]).some((line) => line.includes("explicit window params")));
  });

  // Items 4 + 6: one-sided explicit bounds. executePlannedDomain required BOTH keys, so
  // window_start alone + "this month" in the sentence silently became June and dropped the May row.
  it("item 6: ONE explicit bound on the planned-domain path is honored, and the phrase is not read on top of it", async () => {
    const reader = offerWindowReader();
    const { runtime } = testRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is the offer acceptance rate this month?",
      window_start: "2026-05-01T00:00:00.000Z",
    });

    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.answer.mode, "planned_metric");
    assert.equal(data.summary.applied_time_window.origin, "explicit", "an explicit bound is a deliberate instruction");
    assert.equal(data.summary.applied_time_window.window_end, null, "no second bound is invented");
    // The MAY offer is inside window_start..(unbounded) and must be counted; under the both-bounds
    // rule the phrase silently reset the window to June and dropped it.
    assert.equal(data.summary.rows_considered, 3, "every offer on or after 2026-05-01 is in scope");
  });

  it("item 6: a NON-STRING explicit bound is not silently replaced by the sentence's window", async () => {
    const reader = offerWindowReader();
    const { runtime } = testRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "How is source quality this month?",
      window_start: 20260501,
    });

    // The bad value belongs to the recipe's own validator, not to a silent overwrite by the parser.
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "LIMIT_EXCEEDED");
    assert.match(result.ok === false ? result.denial.message : "", /valid window_start and window_end/);
  });

  // Item 5: "last month"/"last quarter" ended at the START of the current period while every
  // recipe filters inclusively (<= window_end), so a midnight-on-the-first event — and every
  // date-only stamp, which parses to exactly midnight — landed in the wrong period.
  it("item 5: 'last month' excludes a date-only event stamped on the first of THIS month", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_jobs") return scopedSuccess(toolName, []);
      if (toolName === "list_offers") {
        return scopedSuccess(toolName, [
          { id: 1, job_id: 10, application_id: 101, status: "Accepted", sent_on: "2026-05-15", resolved_at: "2026-05-15" },
          { id: 2, job_id: 10, application_id: 102, status: "Rejected", sent_on: "2026-05-20", resolved_at: "2026-05-20" },
          // June 1 is THIS month; an inclusive <= against a window_end of 2026-06-01T00:00 kept it.
          { id: 3, job_id: 10, application_id: 103, status: "Accepted", sent_on: "2026-06-01", resolved_at: "2026-06-01" },
        ]);
      }
      if (toolName === "list_applications") return bridgedHiredApplications(params);
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = testRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What was the offer acceptance rate last month?",
    });

    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.summary.applied_time_window.label, "last month");
    assert.equal(data.summary.applied_time_window.window_end, "2026-05-31T23:59:59.999Z");
    assert.equal(data.summary.rows_considered, 2, "the June 1 offer belongs to THIS month");
  });

  it("item 5: 'last quarter' ends at the final instant of the prior quarter", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_jobs") return scopedSuccess(toolName, []);
      if (toolName === "list_offers") {
        return scopedSuccess(toolName, [
          { id: 1, job_id: 10, application_id: 101, status: "Accepted", sent_on: "2026-02-15", resolved_at: "2026-02-15" },
          { id: 2, job_id: 10, application_id: 102, status: "Accepted", sent_on: "2026-04-01", resolved_at: "2026-04-01" },
        ]);
      }
      if (toolName === "list_applications") return bridgedHiredApplications(params);
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = testRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What was the offer acceptance rate last quarter?",
    });

    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.summary.applied_time_window.window_end, "2026-03-31T23:59:59.999Z");
    assert.equal(data.summary.rows_considered, 1);
  });
});

// ---------------------------------------------------------------------------
// P6 (CLO-275): an unknown question gets a labeled composite instead of a refusal.
// "No approved recipe matches this question" was a dead end for anything phrased outside
// the keyword vocabulary. The broad panel already exists; running it and LABELLING the
// result an approximation beats handing back nothing.
// ---------------------------------------------------------------------------

const SCOPE_FIXTURE = JSON.parse(
  readFileSync(resolve("test/fixtures/job-scope-resolution.fixture.json"), "utf8")
) as JobScopeFixture;

const UNKNOWN_QUESTION = "how is recruiting going for the Brazil team";

function panelReader() {
  return fakeScopedReader((toolName) => {
    if (toolName === "list_jobs") return scopedSuccess(toolName, []);
    if (toolName === "list_applications") {
      return scopedSuccess(toolName, [
        { id: 100, candidate_id: 1000, job_id: 10, source_id: 1, referrer_id: 2, status: "active", applied_at: "2026-06-10T00:00:00.000Z", last_activity_at: "2026-06-11T00:00:00.000Z", stage_id: 7, stage_name: "Phone Screen", current_stage_at: "2026-06-10T00:00:00.000Z" },
      ]);
    }
    return scopedSuccess(toolName, []);
  });
}

describe("recruiting question planner — unknown questions get a labeled composite (CLO-275)", () => {
  it("A9: a narrow recruiter's unrecognized question runs the broad panel, labeled as an approximation", async () => {
    const reader = panelReader();
    const { runtime } = testRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, { question: UNKNOWN_QUESTION });

    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.answer.mode, "approximate_composite");
    assert.equal(data.answer.domain_recognized, false);
    assert.equal(data.summary.domain_recognized, false);
    assert.ok(data.analyses.length > 0, "the panel actually ran");
    const message: string = data.answer.message;
    // Item 8: the FIRST sentence carries scope and the mismatch together (they used to be two),
    // and the trailer names what to rephrase toward. The order is the contract.
    assert.match(message, /^Answered over .+ — no single analysis matched this question, so the broad panel ran instead \(/);
    assert.match(message, /Treat this as an approximation and rephrase toward one of:/);
    const firstSentenceEnd = message.indexOf(". ");
    assert.ok(
      firstSentenceEnd === -1 || message.slice(0, firstSentenceEnd).includes("broad panel ran instead"),
      `the mismatch clause must live in the first sentence, got ${JSON.stringify(message)}`
    );
  });

  it("A9 (org-wide actor): the admin path reaches the composite too, not resolution_required", async () => {
    const reader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [
          { id: 100, candidate_id: 1000, job_id: 9001001, source_id: 1, referrer_id: 2, status: "active", applied_at: "2026-06-10T00:00:00.000Z", last_activity_at: "2026-06-11T00:00:00.000Z", stage_id: 7, stage_name: "Phone Screen", current_stage_at: "2026-06-10T00:00:00.000Z" },
        ]);
      }
      return scopedSuccess(toolName, []);
    });
    const { runtime } = testRuntime(reader, {
      jobInventory: createFixtureInventoryProvider(SCOPE_FIXTURE, "site_admin"),
    });

    const result = await runRecruitingQuestionAnswer(runtime, { question: UNKNOWN_QUESTION });

    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.summary.scope_resolution_required, undefined);
    assert.equal(data.answer.mode, "approximate_composite");
    assert.equal(data.answer.domain_recognized, false);
    assert.match(data.answer.message, /org-wide/);
  });

  it("A10: the composite names every runnable recipe by iteration, never a hand-typed list", async () => {
    const reader = panelReader();
    const { runtime } = testRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, { question: UNKNOWN_QUESTION });
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    const nextSteps: string[] = data.next_steps;
    for (const id of PLANNER_RECIPE_IDS) {
      assert.ok(nextSteps.some((step) => step.includes(id)), `next_steps must name ${id}`);
      assert.ok(String(data.answer.message).includes(id), `the message must name ${id}`);
    }
  });

  it("A11: a recognized planned domain still routes to planned_metric, never the composite", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_jobs") return scopedSuccess(toolName, []);
      if (toolName === "list_offers") {
        // resolved_at, not just sent_on: without it the offer falls out of the window as
        // outstanding, the accepted set is empty and the reconciliation bridge never runs at all —
        // so this fixture used to exercise a code path that is not the one the test names.
        return scopedSuccess(toolName, [
          { id: 1, job_id: 10, application_id: 101, status: "Accepted", sent_on: "2026-06-01", resolved_at: "2026-06-05T10:00:00.000Z" },
        ]);
      }
      if (toolName === "list_applications") {
        const ids = String(params?.ids ?? "").split(",").filter(Boolean).map(Number);
        return scopedSuccess(toolName, ids.map((id) => ({ id, job_id: 10, status: "hired" })));
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = testRuntime(reader);
    const result = await runRecruitingQuestionAnswer(runtime, { question: "What is the offer acceptance rate this quarter?" });
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.answer.mode, "planned_metric");
    assert.equal(
      reader.calls.filter((call) => call.toolName === "list_applications").length,
      1,
      "the reconciliation bridge actually runs on this fixture"
    );
  });

  it("A11b: a deadline that kills the first recipe still returns the labeled composite, marked incomplete", async () => {
    let now = 0;
    const reader = fakeScopedReader((toolName) => {
      if (toolName === "list_jobs") {
        now = 60;
        return scopedSuccess(toolName, []);
      }
      throw new Error(`no recipe read should run past the deadline (${toolName})`);
    });
    const { runtime } = testRuntime(reader, {
      limits: { ...DEFAULT_LIMITS, maxToolDurationMs: 50, maxAnalysisDurationMs: 50 },
      now: () => now,
    });

    const result = await runRecruitingQuestionAnswer(runtime, { question: UNKNOWN_QUESTION });

    assert.equal(result.ok, true, "an all-denied panel must not collapse back into a bare refusal");
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.answer.mode, "approximate_composite");
    assert.equal(data.summary.completeness_status, "incomplete");
    assert.equal(data.denials[0].denial.code, "TOOL_TIMEOUT");
    assert.equal(data.analyses[0].status, "denied");
    assert.ok(String(data.answer.message).length > 0);
  });

  it("A11c: a mixed success/denial panel reports both and stays incomplete", async () => {
    const reader = fakeScopedReader((toolName) => {
      if (toolName === "list_jobs") return scopedSuccess(toolName, []);
      if (toolName === "list_scorecards") return scopedDenial(toolName, "ACTOR_DENIED");
      if (toolName === "list_applications") {
        return scopedSuccess(toolName, [
          { id: 100, candidate_id: 1000, job_id: 10, source_id: 1, referrer_id: 2, status: "active", applied_at: "2026-06-10T00:00:00.000Z", last_activity_at: "2026-06-11T00:00:00.000Z", stage_id: 7, stage_name: "Phone Screen", current_stage_at: "2026-06-10T00:00:00.000Z" },
        ]);
      }
      return scopedSuccess(toolName, []);
    });
    const { runtime } = testRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, { question: UNKNOWN_QUESTION });

    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.answer.mode, "approximate_composite");
    assert.ok(data.analyses.some((entry: any) => entry.status === "ok"), "the recipes that could run are reported");
    assert.ok(data.analyses.some((entry: any) => entry.status === "denied"), "the recipes that could not are reported too");
    assert.equal(data.summary.completeness_status, "incomplete");
    // Item 8: an invoked-but-DENIED recipe used to vanish from the message, which read as though
    // the panel had run clean. Both halves are named.
    const message = String(data.answer.message);
    const firstSentence = message.slice(0, message.indexOf(". ") + 1);
    assert.match(firstSentence, /pipeline_quality/, "a recipe that ran is named");
    assert.match(firstSentence, /scorecard_accountability/, "a recipe that was invoked and denied is named too");
    assert.match(firstSentence, /could not run/);
  });

  it("item 8: a panel cut short by the deadline says how many analyses were never attempted", async () => {
    let now = 0;
    const reader = fakeScopedReader((toolName) => {
      if (toolName === "list_jobs") {
        now = 60;
        return scopedSuccess(toolName, []);
      }
      throw new Error(`no recipe read should run past the deadline (${toolName})`);
    });
    const { runtime } = testRuntime(reader, {
      limits: { ...DEFAULT_LIMITS, maxToolDurationMs: 50, maxAnalysisDurationMs: 50 },
      now: () => now,
    });

    const result = await runRecruitingQuestionAnswer(runtime, { question: UNKNOWN_QUESTION });
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.match(
      String(data.answer.message),
      new RegExp(`${PLANNER_RECIPE_IDS.length - 1} further analyses were not attempted`),
      "an answer that names only the one recipe it tried overstates the panel"
    );
  });

  // Item 8: the composition contract is not composite-only — every answer that has a message
  // states the same things in the same order.
  it("item 8: a MATCHED-recipe answer carries the same scope-first message", async () => {
    const reader = panelReader();
    const { runtime } = testRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, { question: "Where are the stage latency bottlenecks?" });

    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.answer.mode, "single_recipe_analysis");
    assert.match(String(data.answer.message), /^Answered over .+ — ran stage_latency\./);
  });

  it("item 8: a PLANNED-domain answer carries one too", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_jobs") return scopedSuccess(toolName, []);
      if (toolName === "list_offers") {
        return scopedSuccess(toolName, [{ id: 1, job_id: 10, application_id: 101, status: "Accepted", sent_on: "2026-06-01", resolved_at: "2026-06-01" }]);
      }
      if (toolName === "list_applications") return bridgedHiredApplications(params);
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = testRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, { question: "What is the offer acceptance rate this month?" });

    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.answer.mode, "planned_metric");
    // H0b: the reconciliation sentence now LEADS an offer answer, so the composition contract's own
    // sentence is the second one rather than the first. It is still there, unchanged, and still
    // followed by the window.
    assert.match(String(data.answer.message), /^1 accepted current offers; 1 of their applications is marked hired in Greenhouse\. /);
    assert.match(String(data.answer.message), /Answered over .+ — computed offer_resolution\./);
    assert.match(String(data.answer.message), /Time window: this month/);
  });

  // Item 2: the composite bypassed selectRecipes entirely, so an explicit max_recipes — the one
  // control a caller has over panel cost — was ignored on exactly the path that runs everything.
  it("item 2: an explicit max_recipes bounds the approximate composite too", async () => {
    const reader = panelReader();
    const { runtime } = testRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, { question: UNKNOWN_QUESTION, max_recipes: 2 });

    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.answer.mode, "approximate_composite");
    assert.equal(data.summary.selected_recipe_count, 2);
    assert.equal(data.summary.selected_recipes.length, 2);
  });
});

// ---------------------------------------------------------------------------
// H0b: the planner's offer path.
//
// executePlannedDomain read list_offers with a hard-coded `{}` and filtered
// everything in memory, so every superseded `Deprecated` version landed in its
// total, and windowing on `sent_on` answered a different question from the one
// every published hire report asks. It now reads `current_only=true`
// server-side, keeps the read date-filter-free (the LIVE endpoint 422s every
// date filter the contract advertises), and windows in memory on `resolved_at`.
// That last change makes every still-`Created` offer missing-timestamp, so the
// count of them is surfaced instead of quietly disappearing.
// ---------------------------------------------------------------------------
describe("H3 the planner's offer path", () => {
  function offerPlannerReader() {
    return fakeScopedReader((toolName, params) => {
      if (toolName === "list_jobs") return scopedSuccess(toolName, []);
      if (toolName === "list_offers") {
        assert.equal(params?.current_only, true, "the version chain is collapsed server-side, not in memory");
        for (const key of Object.keys(params ?? {})) {
          assert.ok(!/\[(gte|lte|gt|lt)\]$/.test(key), `the offer read must stay date-filter-free (${key}); the live endpoint 422s them`);
        }
        // What Greenhouse returns for current_only=true: no Deprecated rows at all.
        return scopedSuccess(toolName, [
          { id: 1, job_id: 10, application_id: 101, status: "Accepted", sent_on: "2026-06-01", resolved_at: "2026-06-05T10:00:00.000Z" },
          { id: 2, job_id: 10, application_id: 102, status: "Accepted", sent_on: "2026-06-02", resolved_at: "2026-06-06T10:00:00.000Z" },
          { id: 3, job_id: 10, application_id: 103, status: "Rejected", sent_on: "2026-06-03", resolved_at: "2026-06-07T10:00:00.000Z" },
          // Outstanding: sent, not yet resolved. No resolved_at, so the window cannot place them.
          { id: 4, job_id: 10, application_id: 104, status: "Created", sent_on: "2026-06-10" },
          { id: 5, job_id: 10, application_id: 105, status: "Created", sent_on: "2026-06-11" },
          { id: 6, job_id: 10, application_id: 106, status: "Created", sent_on: "2026-06-12" },
        ]);
      }
      if (toolName === "list_applications") {
        const ids = String(params?.ids ?? "").split(",").filter(Boolean).map(Number);
        // One of the two accepted offers never had the hire endpoint fired.
        return scopedSuccess(toolName, ids.map((id) => ({ id, job_id: 10, status: id === 101 ? "hired" : "in_process" })));
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
  }

  it("reads current_only=true with no date params, drops Deprecated from the total, and surfaces outstanding offers", async () => {
    const reader = offerPlannerReader();
    const { runtime } = testRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is our offer acceptance rate this month?",
    });

    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.answer.mode, "planned_metric");
    assert.deepStrictEqual(data.summary.planned_metrics_run, ["offer_resolution"]);

    const groups = data.answer.metric.groups as Array<Record<string, unknown>>;
    assert.ok(!groups.some((group) => group.offer_status === "Deprecated"), "no superseded version reaches the mix");
    assert.equal(data.answer.metric.numerator, 2, "two accepted offers resolved inside the window");
    assert.equal(data.answer.metric.denominator, 3, "accepted + rejected, resolved only");

    const outstanding = groups.find((group) => group.offer_status === "outstanding_no_resolved_at");
    assert.ok(outstanding, `the Created offers must be counted, got ${JSON.stringify(groups)}`);
    assert.equal(outstanding!.offer_count, 3);
    const omissions = data.answer.omissions as string[];
    assert.ok(omissions.some((line) => line.includes("offers_outstanding: 3")), JSON.stringify(omissions));
    assert.ok(
      omissions.some((line) => /superseded versions were not read/i.test(line)),
      "the chain was not read, so the re-extension denominator is not claimed"
    );
  });

  it("opens the answer with the two cheap reconciliation counts and offers the openings count as a follow-up", async () => {
    const reader = offerPlannerReader();
    const { runtime } = testRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is our offer acceptance rate this month?",
    });

    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    const message = String(data.answer.message);
    assert.match(
      message,
      /^2 accepted current offers; 1 of their applications is marked hired in Greenhouse\./,
      `the reconciliation sentence leads the answer, got: ${message}`
    );
    assert.match(message, /Answered over .+ — computed offer_resolution\./);
    const bridged = reader.calls.filter((call) => call.toolName === "list_applications");
    assert.equal(bridged.length, 1, "the second count costs exactly one bridged applications read");
    assert.deepStrictEqual(String(bridged[0]!.params?.ids ?? "").split(",").sort(), ["101", "102"]);
    assert.ok(
      (data.data?.next_steps ?? data.next_steps ?? []).some((step: string) => /openings closed by a hire/i.test(step)),
      `the third count is offered as a follow-up rather than paid for unasked: ${JSON.stringify(data.next_steps)}`
    );
  });
});

// ---------------------------------------------------------------------------
// H3c: the reconciliation lead is ADDITIVE.
//
// The lead is a second population read for a sentence. It used to be able to
// destroy the whole answer: `if (bridged.kind === "denial") return
// bridged.result` handed back UPSTREAM_ERROR for a metric that had already been
// computed from a read that completed. A denial on an optional read reduces what
// the answer says; it never replaces the answer with a refusal.
// ---------------------------------------------------------------------------
describe("H3c the reconciliation lead never destroys a computed answer", () => {
  function offerRows() {
    return [
      { id: 1, job_id: 10, application_id: 101, status: "Accepted", sent_on: "2026-06-01", resolved_at: "2026-06-05T10:00:00.000Z" },
      { id: 2, job_id: 10, application_id: 102, status: "Accepted", sent_on: "2026-06-02", resolved_at: "2026-06-06T10:00:00.000Z" },
      { id: 3, job_id: 10, application_id: 103, status: "Rejected", sent_on: "2026-06-03", resolved_at: "2026-06-07T10:00:00.000Z" },
    ];
  }

  it("keeps the metric, reduces the lead, and names the failure when the applications bridge 500s", async () => {
    const reader = fakeScopedReader((toolName) => {
      if (toolName === "list_jobs") return scopedSuccess(toolName, []);
      if (toolName === "list_offers") return scopedSuccess(toolName, offerRows());
      if (toolName === "list_applications") {
        throw new Error("Greenhouse API error: 500 Internal Server Error (/applications) [correlation_id=test]");
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = testRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is our offer acceptance rate this month?",
    });

    assert.equal(result.ok, true, "a bridge failure must not turn a computed rate into a denial envelope");
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.answer.mode, "planned_metric");
    assert.equal(data.answer.metric.value, 0.6667, "the rate the offer read paid for is still answered (2 accepted / 3 resolved)");
    const message = String(data.answer.message);
    assert.match(message, /^2 accepted current offers\./, `the lead reduces to the count that was made, got: ${message}`);
    assert.ok(!/marked hired/.test(message), "it does not claim a number it could not read");
    const omissions = data.answer.omissions as string[];
    assert.ok(
      omissions.some((line) => /could not be read \(UPSTREAM_ERROR\)/.test(line)),
      `the failure is named, got ${JSON.stringify(omissions)}`
    );
  });

  it("propagates a CANCELLED bridge as the planner's cancellation, never as a complete answer", async () => {
    // A cancellation reaches this path as a DENIAL, not an exception (read-all.ts maps it), so the
    // rule "an optional bridge denial only reduces the lead" quietly answered a client that had
    // already hung up — with `ok: true` and a complete verdict.
    const reader = fakeScopedReader((toolName) => {
      if (toolName === "list_jobs") return scopedSuccess(toolName, []);
      if (toolName === "list_offers") return scopedSuccess(toolName, offerRows());
      if (toolName === "list_applications") throw new Error("SCOPED_GREENHOUSE_TOOL_CANCELLED");
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = testRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is our offer acceptance rate this month?",
    });

    assert.equal(result.ok, false, "a cancellation is not a reduced answer, it is the end of the run");
    assert.equal(result.ok === false && result.denial.code, "CANCELLED");
  });

  it("keeps the metric when list_applications is disabled outright", async () => {
    const reader = fakeScopedReader((toolName) => {
      if (toolName === "list_jobs") return scopedSuccess(toolName, []);
      if (toolName === "list_offers") return scopedSuccess(toolName, offerRows());
      if (toolName === "list_applications") return scopedDenial(toolName, "TOOL_NOT_AVAILABLE");
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = testRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is our offer acceptance rate this month?",
    });

    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.answer.metric.value, 0.6667);
    assert.ok((data.answer.omissions as string[]).some((line) => /TOOL_NOT_AVAILABLE/.test(line)));
  });

  it("hedges the second count and marks the answer incomplete when the bridge is truncated", async () => {
    // 60 accepted offers, so the bridge runs two 50-id batches. The first completes; the second
    // hits the deadline. The count that comes back is a floor over half the accepted set, and
    // reporting it as an exact figure beside a complete offer count is the bug.
    const offers = Array.from({ length: 60 }, (_, index) => ({
      id: index + 1,
      job_id: 10,
      application_id: 100 + index,
      status: "Accepted",
      sent_on: "2026-06-01",
      resolved_at: "2026-06-05T10:00:00.000Z",
    }));
    let applicationBatches = 0;
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_jobs") return scopedSuccess(toolName, []);
      if (toolName === "list_offers") return scopedSuccess(toolName, offers);
      if (toolName === "list_applications") {
        applicationBatches += 1;
        if (applicationBatches > 1) throw new Error("SCOPED_GREENHOUSE_TOOL_TIMEOUT:deadline");
        const ids = String(params?.ids ?? "").split(",").filter(Boolean).map(Number);
        return scopedSuccess(toolName, ids.map((id) => ({ id, job_id: 10, status: "hired" })));
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = testRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is our offer acceptance rate this month?",
    });

    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(applicationBatches, 2, "the bridge really did run more than one batch");
    const message = String(data.answer.message);
    assert.match(message, /at least 50 of their applications are marked hired/, `the count is hedged as a floor, got: ${message}`);
    assert.match(message, /read was cut short/);
    assert.equal(
      data.summary.completeness_status,
      "incomplete_timeout",
      "an answer whose lead came from a truncated read is not a complete answer"
    );
    assert.ok(
      (data.answer.omissions as string[]).some((line) => /applications bridge behind the second count did not finish/.test(line))
    );
  });

  it("does NOT hedge a multi-batch bridge that finished — the floor comes from the read status", async () => {
    // The companion to the case above, and the one that kills the naive implementation: "more than
    // one batch ran" is not the same fact as "the read stopped short". Both batches complete here,
    // so the number is exact.
    const offers = Array.from({ length: 60 }, (_, index) => ({
      id: index + 1,
      job_id: 10,
      application_id: 100 + index,
      status: "Accepted",
      sent_on: "2026-06-01",
      resolved_at: "2026-06-05T10:00:00.000Z",
    }));
    let applicationBatches = 0;
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_jobs") return scopedSuccess(toolName, []);
      if (toolName === "list_offers") return scopedSuccess(toolName, offers);
      if (toolName === "list_applications") {
        applicationBatches += 1;
        const ids = String(params?.ids ?? "").split(",").filter(Boolean).map(Number);
        return scopedSuccess(toolName, ids.map((id) => ({ id, job_id: 10, status: "hired" })));
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = testRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is our offer acceptance rate this month?",
    });

    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(applicationBatches, 2, "the bridge ran two batches");
    const message = String(data.answer.message);
    assert.match(message, /60 of their applications are marked hired/, `an exact count for a complete read, got: ${message}`);
    assert.ok(!/at least/.test(message), "a floor on a read that finished is a false hedge");
    assert.equal(data.summary.completeness_status, "complete");
  });
});

describe("H3b the planner's offer path contains its own errors", () => {
  it("turns a 422 on the planned-domain read into a denial with an audit record, not a throw", async () => {
    const reader = fakeScopedReader((toolName) => {
      if (toolName === "list_jobs") return scopedSuccess(toolName, []);
      if (toolName === "list_offers") {
        throw new Error("Greenhouse API error: 422 Unprocessable Entity (/offers) [correlation_id=test]");
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime, auditSink } = testRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is our offer acceptance rate this month?",
    });

    assert.equal(result.ok, false, "an upstream failure is a denial the caller can read, never an escaped throw");
    assert.equal(result.ok === false && result.denial.code, "UPSTREAM_ERROR");
    const events = auditSink.events;
    assert.equal(events.length, 1, "the failed planner run is audited exactly like every other outcome");
    assert.equal(events[0]!.tool, "answer_my_recruiting_question");
    // auditOutcome (runtime.ts:815-819) classes UPSTREAM_ERROR as "failed" rather than "denied":
    // the read broke, it was not refused. The point of the assertion is that the run is AUDITED and
    // names its code, not that it is labelled a refusal.
    assert.equal(events[0]!.outcome, "failed");
    assert.equal(events[0]!.denialCode, "UPSTREAM_ERROR");
  });
});

// ---------------------------------------------------------------------------
// H3d: what the planner PUBLISHES as complete is the answer's completeness, not
// the offer read's.
//
// The bridge is a second population the lead sentence needs. When it failed, the
// answer kept the metric (right) and still published `read.complete: true` off
// the offer read alone (wrong): the envelope said the whole answer was complete
// while half its reconciliation had never been read.
// ---------------------------------------------------------------------------
describe("H3d the planner's published completeness covers every read the answer used", () => {
  function offerRows() {
    return [
      { id: 1, job_id: 10, application_id: 101, status: "Accepted", sent_on: "2026-06-01", resolved_at: "2026-06-05T10:00:00.000Z" },
      { id: 2, job_id: 10, application_id: 102, status: "Rejected", sent_on: "2026-06-02", resolved_at: "2026-06-06T10:00:00.000Z" },
    ];
  }

  it("marks the answer incomplete_upstream when the requested bridge failed", async () => {
    const reader = fakeScopedReader((toolName) => {
      if (toolName === "list_jobs") return scopedSuccess(toolName, []);
      if (toolName === "list_offers") return scopedSuccess(toolName, offerRows());
      if (toolName === "list_applications") {
        throw new Error("Greenhouse API error: 500 Internal Server Error (/applications) [correlation_id=test]");
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = testRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is our offer acceptance rate this month?",
    });

    assert.equal(result.ok, true, "the metric that was computed still answers");
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.summary.completeness_status, "incomplete_upstream");
    assert.equal(data.answer.read.complete, false, "the ANSWER is not complete; one of its reads failed");
    assert.equal(data.answer.read.status, "incomplete_upstream");
    assert.equal(data.answer.read.offer_read.complete, true, "the offer read's own verdict is kept, and labelled as its own");
  });

  it("still publishes complete when every read the answer used finished", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_jobs") return scopedSuccess(toolName, []);
      if (toolName === "list_offers") return scopedSuccess(toolName, offerRows());
      if (toolName === "list_applications") {
        const ids = String(params?.ids ?? "").split(",").filter(Boolean).map(Number);
        return scopedSuccess(toolName, ids.map((id) => ({ id, job_id: 10, status: "hired" })));
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = testRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is our offer acceptance rate this month?",
    });

    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.summary.completeness_status, "complete");
    assert.equal(data.answer.read.complete, true);
  });
});

// ---------------------------------------------------------------------------
// H3e: a row is classified BEFORE the window removes it, or the mix contradicts
// itself.
//
// The planned-domain filter drops every fact with no parseable window field, so
// those rows left the metric's `total` while the outstanding count re-entered its
// `groups` — three offers in a group under a metric whose value counted none of
// them, and a generic "0 unresolved excluded" omission printed underneath. An
// unrecognized status with no timestamp went further: it skipped the unknown
// disclosure entirely.
// ---------------------------------------------------------------------------
describe("H3e the offer mix counts what the window could not place", () => {
  function readerFor(rows: Array<Record<string, unknown>>) {
    return fakeScopedReader((toolName, params) => {
      if (toolName === "list_jobs") return scopedSuccess(toolName, []);
      if (toolName === "list_offers") return scopedSuccess(toolName, rows);
      if (toolName === "list_applications") {
        const ids = String(params?.ids ?? "").split(",").filter(Boolean).map(Number);
        return scopedSuccess(toolName, ids.map((id) => ({ id, job_id: 10, status: "hired" })));
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
  }

  const RESOLVED = [
    { id: 1, job_id: 10, application_id: 101, status: "Accepted", sent_on: "2026-06-01", resolved_at: "2026-06-05T10:00:00.000Z" },
    { id: 2, job_id: 10, application_id: 102, status: "Accepted", sent_on: "2026-06-02", resolved_at: "2026-06-06T10:00:00.000Z" },
    { id: 3, job_id: 10, application_id: 103, status: "Rejected", sent_on: "2026-06-03", resolved_at: "2026-06-07T10:00:00.000Z" },
  ];
  const OUTSTANDING = [4, 5, 6].map((id) => ({
    id, job_id: 10, application_id: 100 + id, status: "Created", sent_on: "2026-06-10",
  }));

  it("makes '<n> unresolved' equal the outstanding group, not zero", async () => {
    const { runtime } = testRuntime(readerFor([...RESOLVED, ...OUTSTANDING]));

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is our offer acceptance rate this month?",
    });

    const data = result.ok ? (result.data as any) : null;
    const groups = data.answer.metric.groups as Array<Record<string, unknown>>;
    const outstanding = groups.find((group) => group.offer_status === "outstanding_no_resolved_at");
    assert.equal(outstanding?.offer_count, 3);
    const omissions = data.answer.metric.omissions as string[];
    assert.ok(
      omissions.some((line) => /3 unresolved offer\(s\) excluded from the rate/.test(line)),
      `the arithmetic under the mix must match the group above it, got ${JSON.stringify(omissions)}`
    );
    assert.ok(
      !omissions.some((line) => /0 unresolved offer\(s\)/.test(line)),
      "a guaranteed zero printed under three grouped offers is the contradiction itself"
    );
  });

  it("discloses an unrecognized status the window could not place", async () => {
    const rows = [
      ...RESOLVED,
      { id: 7, job_id: 10, application_id: 107, status: "Verbal yes", sent_on: "2026-06-11" },
    ];
    const { runtime } = testRuntime(readerFor(rows));

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is our offer acceptance rate this month?",
    });

    const data = result.ok ? (result.data as any) : null;
    const omissions = data.answer.metric.omissions as string[];
    assert.ok(
      omissions.some((line) => /outside the published \/v3\/offers enum/.test(line) && /Verbal yes \(1\)/.test(line)),
      `an unrecognized status is named whether or not it carried a date, got ${JSON.stringify(omissions)}`
    );
    const groups = data.answer.metric.groups as Array<Record<string, unknown>>;
    assert.ok(
      groups.some((group) => group.offer_status === "unrecognized_status_no_resolved_at" && group.offer_count === 1),
      `and it is counted in a group of its own, got ${JSON.stringify(groups)}`
    );
    assert.equal(data.answer.metric.denominator, 3, "it is NOT folded into the rate on a guess");
  });
});

// ---------------------------------------------------------------------------
// H3f: one status vocabulary for the whole answer, asserted on the ANSWER.
//
// classifyOfferStatus was unit-tested, so restoring substring logic in the metric
// or in the planner's own lead passed the suite. This asserts the four consumers
// together on one read: the rate's denominator, the ids the reconciliation bridge
// asks for, the outstanding group, and the unknown-status disclosure.
// ---------------------------------------------------------------------------
describe("H3f the planner's four status consumers agree on one read", () => {
  it("keeps 'Not Accepted' and 'Verbal yes' out of the rate, the lead and the outstanding group", async () => {
    const rows = [
      { id: 1, job_id: 10, application_id: 101, status: "Accepted", sent_on: "2026-06-01", resolved_at: "2026-06-05T10:00:00.000Z" },
      { id: 2, job_id: 10, application_id: 102, status: "Rejected", sent_on: "2026-06-02", resolved_at: "2026-06-06T10:00:00.000Z" },
      { id: 3, job_id: 10, application_id: 103, status: "Not Accepted", sent_on: "2026-06-03", resolved_at: "2026-06-07T10:00:00.000Z" },
      { id: 4, job_id: 10, application_id: 104, status: "Verbal yes", sent_on: "2026-06-04", resolved_at: "2026-06-08T10:00:00.000Z" },
      { id: 5, job_id: 10, application_id: 105, status: "Created", sent_on: "2026-06-10" },
    ];
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_jobs") return scopedSuccess(toolName, []);
      if (toolName === "list_offers") return scopedSuccess(toolName, rows);
      if (toolName === "list_applications") {
        const ids = String(params?.ids ?? "").split(",").filter(Boolean).map(Number);
        return scopedSuccess(toolName, ids.map((id) => ({ id, job_id: 10, status: "hired" })));
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = testRuntime(reader);

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What is our offer acceptance rate this month?",
    });

    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    // 1. the rate: one accepted over one accepted + one rejected. "Not Accepted" is not a rejection.
    assert.equal(data.answer.metric.numerator, 1);
    assert.equal(data.answer.metric.denominator, 2);
    // 2. the reconciliation bridge asks only about the offer that really was accepted.
    const bridged = reader.calls.filter((call) => call.toolName === "list_applications");
    assert.equal(bridged.length, 1);
    assert.deepStrictEqual(String(bridged[0]!.params?.ids ?? "").split(",").sort(), ["101"]);
    assert.match(String(data.answer.message), /^1 accepted current offers; 1 of their applications is marked hired/);
    // 3. the outstanding group is the Created offer alone — an unknown status is not "still open".
    const groups = data.answer.metric.groups as Array<Record<string, unknown>>;
    assert.equal(groups.find((group) => group.offer_status === "outstanding_no_resolved_at")?.offer_count, 1);
    // 4. and both unrecognized values are named rather than bucketed.
    const omissions = data.answer.metric.omissions as string[];
    assert.ok(
      omissions.some((line) => /Not Accepted \(1\)/.test(line) && /Verbal yes \(1\)/.test(line)),
      `both unrecognized statuses are named, got ${JSON.stringify(omissions)}`
    );
  });
});
