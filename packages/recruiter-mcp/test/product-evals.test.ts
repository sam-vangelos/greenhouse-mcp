import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runRecruitingQuestionAnswer } from "../src/tools/question-answer.js";
import { fakeScopedReader, scopedSuccess, testRuntime } from "./test-helpers.js";

describe("product eval prompts", () => {
  it("answers scorecard submission prompts with scoped facts, metrics, and evidence references", async () => {
    const { runtime } = testRuntime(evalScopedReader());

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What percent of scorecards have been submitted across all of my open reqs?",
      window_start: "2026-06-01T00:00:00.000Z",
      window_end: "2026-06-23T12:00:00.000Z",
    });

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assertAnswerMetadata(data, ["scorecard_submission_rate"], ["/v3/scorecards"], "job_scope");
    assert.deepStrictEqual(data.summary.selected_recipes, ["scorecard_accountability"]);
    const layer = data.analyses[0].data.fact_metric_layer;
    assert.equal(layer.metric_results.scorecard_submission_rate.value, 0.5);
    assert.equal(layer.completeness.status, "complete");
    assert.ok(layer.completeness.evidence_refs.includes("scorecard:1"));
    assert.deepStrictEqual(layer.completeness.omissions, []);
  });

  it("answers source-quality prompts with quality and volume metric definitions", async () => {
    const { runtime } = testRuntime(evalScopedReader());

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "Which sources create quality pipeline, not just application volume?",
    });

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assertAnswerMetadata(data, ["source_quality_by_outcome", "weekly_application_volume"], ["/v3/applications"]);
    assert.ok(data.summary.selected_recipes.includes("source_quality"));
    const sourceAnalysis = data.analyses.find((entry: any) => entry.recipe === "source_quality");
    assert.ok(sourceAnalysis);
    const layer = sourceAnalysis.data.fact_metric_layer;
    assert.equal(layer.metric_results.source_quality_by_outcome.groups.length, 2);
    assert.ok(layer.completeness.evidence_refs.includes("source:1"));
    assert.ok(data.answer.metric_definitions.some((metric: any) => metric.id === "source_quality_by_outcome"));
  });

  it("maps weekly pipeline movement prompts to application lifecycle metrics", async () => {
    const { runtime } = testRuntime(evalScopedReader());

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "How have pipeline velocity, quality, and volume trended week over week for this req?",
    });

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assertAnswerMetadata(data, ["weekly_application_volume", "weekly_qualified_pipeline_movement"], ["/v3/applications"]);
    assert.deepStrictEqual(data.summary.selected_recipes, ["pipeline_quality"]);
    const layer = data.analyses[0].data.fact_metric_layer;
    assert.equal(layer.metric_results.weekly_application_volume.unit, "count");
    assert.equal(layer.metric_results.weekly_qualified_pipeline_movement.unit, "count");
    assert.ok(layer.completeness.evidence_refs.includes("application:100"));
  });

  it("reports interview scheduling friction as an explicit incomplete planner gap", async () => {
    const { runtime } = testRuntime(evalScopedReader());

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "What discrete actions in interview scheduling create the most friction?",
    });

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    // T3.2: the scheduling-friction question now EXECUTES via the fact-backed planner
    // (interview_event_fact -> availability_to_scheduled_interview_hours) instead of dead-ending.
    assert.equal(data.answer.mode, "planned_metric");
    assert.deepStrictEqual(data.summary.planned_metrics_run, ["availability_to_scheduled_interview_hours"]);
    assert.deepStrictEqual(data.summary.plan.requiredFacts, ["interview_event_fact"]);
    assert.deepStrictEqual(data.summary.plan.requiredEndpoints, ["/v3/interviews"]);
    assert.deepStrictEqual(data.summary.selected_recipes, [], "no keyword recipe may grab the scheduling question");
  });

  it("answers stage bottleneck prompts from application_stages facts", async () => {
    const { runtime } = testRuntime(evalScopedReader());

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "Which reqs are slow but still healthy, and which are structurally stalled?",
    });

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    assert.ok(data.summary.plan.requiredMetrics.includes("stage_dwell_days"));
    assert.ok(data.summary.plan.requiredEndpoints.includes("/v3/application_stages"));
    const stageAnalysis = data.analyses.find((entry: any) => entry.recipe === "stage_latency");
    assert.ok(stageAnalysis);
    const layer = stageAnalysis.data.fact_metric_layer;
    assert.equal(layer.metric_results.stage_dwell_days.completeness, "complete");
    assert.ok(layer.completeness.evidence_refs.includes("application_stage:4001"));
  });

  it("returns explicitly incomplete missing-domain answers for approval latency prompts", async () => {
    const { runtime } = testRuntime(evalScopedReader());

    const result = await runRecruitingQuestionAnswer(runtime, {
      question: "Show offer approval latency by approver for permitted jobs.",
    });

    assert.equal(result.ok, true);
    const data = result.ok ? result.data as any : null;
    // T3.2: approval questions now EXECUTE (pending-age over approval_flow_fact). The eval
    // reader serves no approval rows, so the metric fails closed — a missing/empty fact must
    // never produce a confident number, which is the property this eval protects.
    assert.equal(data.answer.mode, "planned_metric");
    assert.deepStrictEqual(data.summary.planned_metrics_run, ["approval_latency"]);
    assert.equal(data.answer.metric.value, null, "an empty approval read must not fabricate a latency");
    assert.deepStrictEqual(data.answer.metric.groups, [], "no flows -> no pending-age rankings");
    assert.deepStrictEqual(data.summary.selected_recipes, []);
  });
});

function assertAnswerMetadata(data: any, expectedMetrics: string[], expectedEndpoints: string[], expectedScope = "recruiter_permitted_jobs") {
  assert.ok(data.summary.plan);
  assert.equal(data.summary.plan.requestedScope.primary_scope_domain, expectedScope);
  assert.equal(data.summary.plan.requiredProjectionProfile, "recruiter_default");
  assert.equal(data.summary.projection_profile, "recruiter_default");
  for (const metric of expectedMetrics) {
    assert.ok(data.summary.plan.requiredMetrics.includes(metric), `missing metric ${metric}`);
  }
  for (const endpoint of expectedEndpoints) {
    assert.ok(data.summary.plan.requiredEndpoints.includes(endpoint), `missing endpoint ${endpoint}`);
  }
  assert.ok(Array.isArray(data.answer.metric_definitions));
  assert.ok(data.answer.metric_definitions.length > 0);
}

function evalScopedReader() {
  return fakeScopedReader((toolName, params) => {
    if (toolName === "list_jobs") {
      return scopedSuccess(toolName, [
        { id: 10, name: "Job 10", status: "open" },
        { id: 20, name: "Job 20", status: "open" },
      ]);
    }
    if (toolName === "list_job_owners") {
      return scopedSuccess(toolName, [
        { job_id: 10, user_id: 100, type: "recruiter", responsible: false },
        { job_id: 20, user_id: 100, type: "sourcer", responsible: false },
      ]);
    }
    if (toolName === "list_scorecards") {
      return scopedSuccess(toolName, [
        { id: 1, application_id: 100, interviewer_id: 7, status: "submitted", submitted_at: "2026-06-03T00:00:00.000Z", interviewed_at: "2026-06-02T00:00:00.000Z" },
        { id: 2, application_id: 101, interviewer_id: 8, status: "pending", submitted_at: null, interviewed_at: "2026-06-01T00:00:00.000Z" },
      ]);
    }
    if (toolName === "list_applications" && typeof params?.ids === "string") {
      return scopedSuccess(toolName, [
        { id: 100, jobs: [{ id: 10 }] },
        { id: 101, jobs: [{ id: 10 }] },
      ]);
    }
    if (toolName === "list_applications") {
      return scopedSuccess(toolName, [
        { id: 100, candidate_id: 1000, job_id: 10, stage_id: 7, stage_name: "Phone Screen", status: "active", created_at: "2026-06-02T00:00:00.000Z", applied_at: "2026-06-02T00:00:00.000Z", last_activity_at: "2026-06-20T00:00:00.000Z", source_id: 1, referrer_id: 2 },
        { id: 101, candidate_id: 1001, job_id: 10, stage_id: 8, stage_name: "Onsite", status: "hired", created_at: "2026-06-10T00:00:00.000Z", applied_at: "2026-06-10T00:00:00.000Z", last_activity_at: "2026-06-21T00:00:00.000Z", source_id: 1, referrer_id: 2 },
        { id: 102, candidate_id: 1002, job_id: 20, stage_id: 9, stage_name: "Rejected", status: "rejected", created_at: "2026-06-16T00:00:00.000Z", applied_at: "2026-06-16T00:00:00.000Z", last_activity_at: "2026-06-17T00:00:00.000Z", source_id: 3, referrer_id: 4 },
      ]);
    }
    if (toolName === "list_application_stages") {
      return scopedSuccess(toolName, [
        { id: 4001, application_id: 100, job_interview_stage_id: 7, entered_at: "2026-06-02T00:00:00.000Z", exited_at: null, days_in_stage: 21, current: true },
        { id: 4002, application_id: 101, job_interview_stage_id: 8, entered_at: "2026-06-10T00:00:00.000Z", exited_at: null, days_in_stage: 13, current: true },
      ]);
    }
    if (toolName === "list_sources") {
      return scopedSuccess(toolName, [
        { id: 1, name: "LinkedIn", type: { id: 2, name: "Job Board" } },
        { id: 3, name: "Employee Referral", type: { id: 5, name: "Referral" } },
      ]);
    }
    if (toolName === "list_referrers") {
      return scopedSuccess(toolName, [
        { id: 2, name: "Alice Referrer" },
        { id: 4, name: "Bob Referrer" },
      ]);
    }
    if (toolName === "list_interviews") {
      return scopedSuccess(toolName, [
        { id: 9001, application_id: 100, job_id: 10, status: "scheduled", availability_received_at: "2026-06-01T00:00:00.000Z", scheduled_at: "2026-06-02T12:00:00.000Z" },
      ]);
    }
    if (toolName === "list_approval_flows") {
      // Deliberately empty: the approval eval asserts an empty read never fabricates a latency.
      return scopedSuccess(toolName, []);
    }
    throw new Error(`unexpected scoped tool ${toolName}`);
  });
}
