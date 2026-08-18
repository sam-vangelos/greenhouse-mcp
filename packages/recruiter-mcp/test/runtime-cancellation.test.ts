import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ScopedReaderLike } from "../src/types.js";
import { runScopedTool } from "../src/runtime.js";
import { DEFAULT_LIMITS } from "../src/limits.js";
import { runInterviewFeedbackDrag } from "../src/tools/interview-feedback-drag.js";
import { runPipelineQuality } from "../src/tools/pipeline-quality.js";
import { runRecruitingQuestionAnswer } from "../src/tools/question-answer.js";
import { runRejectionReasonDrift } from "../src/tools/rejection-reason-drift.js";
import { runScorecardAccountability } from "../src/tools/scorecard-accountability.js";
import { runSourceQuality } from "../src/tools/source-quality.js";
import { runStageLatency } from "../src/tools/stage-latency.js";
import { analysisRuntime, testRuntime } from "./test-helpers.js";

function blockingReader(observed: { aborted: boolean; started?: () => void }): ScopedReaderLike {
  return {
    scopedRead(_session, _toolName, _params, options) {
      const signal = options?.signal;
      assert.ok(signal, "runtime must pass a trusted cancellation signal to every scoped read");
      observed.started?.();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          observed.aborted = true;
          const error = new Error("upstream cancelled");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    },
  };
}

describe("request and deadline cancellation", () => {
  it("client disconnect aborts the active scoped read and audits cancellation", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const observed = { aborted: false, started: markStarted };
    const controller = new AbortController();
    const { runtime, auditSink } = testRuntime(blockingReader(observed));
    runtime.signal = controller.signal;

    const operation = runScopedTool(runtime, "search_my_jobs", "list_jobs", {}, "evidence");
    await started;
    controller.abort();
    const result = await operation;

    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.denial.code, "CANCELLED");
    assert.equal(observed.aborted, true);
    const terminal = auditSink.allEvents.find((event) => event.auditStage === "terminal");
    assert.equal(terminal?.outcome, "cancelled");
    assert.equal(terminal?.cancellationReason, "CANCELLED");
  });

  it("the individual-read deadline aborts upstream work and returns TOOL_TIMEOUT", async () => {
    const observed = { aborted: false };
    const { runtime, auditSink } = testRuntime(blockingReader(observed), {
      limits: { ...DEFAULT_LIMITS, maxToolDurationMs: 20, maxAnalysisDurationMs: 120_000 },
    });

    const result = await runScopedTool(runtime, "search_my_jobs", "list_jobs", {}, "evidence");

    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.denial.code, "TOOL_TIMEOUT");
    assert.equal(observed.aborted, true);
    const terminal = auditSink.allEvents.find((event) => event.auditStage === "terminal");
    assert.equal(terminal?.outcome, "cancelled");
    assert.equal(terminal?.cancellationReason, "TOOL_TIMEOUT");
  });

  it("maps client aborts to CANCELLED in every analyzer and the question front door", async () => {
    const cases = [
      ["analyze_interview_feedback_drag", runInterviewFeedbackDrag, {}],
      ["analyze_pipeline_quality", runPipelineQuality, {}],
      ["analyze_rejection_reason_drift", runRejectionReasonDrift, {}],
      ["analyze_scorecard_accountability", runScorecardAccountability, {}],
      ["analyze_source_quality", runSourceQuality, {}],
      ["analyze_stage_latency", runStageLatency, {}],
      ["answer_my_recruiting_question", runRecruitingQuestionAnswer, { question: "How is pipeline health?" }],
    ] as const;

    for (const [toolName, run, params] of cases) {
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const controller = new AbortController();
      const { runtime, auditSink } = analysisRuntime(blockingReader({ aborted: false, started: markStarted }));
      runtime.signal = controller.signal;

      const operation = run(runtime, params);
      await started;
      controller.abort();
      const result = await operation;

      assert.equal(result.ok, false, `${toolName} must not return analysis data after cancellation`);
      assert.equal(result.ok ? "" : result.denial.code, "CANCELLED", toolName);
      const terminal = auditSink.allEvents.find((event) => event.tool === toolName && event.auditStage === "terminal");
      assert.equal(terminal?.outcome, "cancelled", `${toolName} terminal audit outcome`);
      assert.equal(terminal?.cancellationReason, "CANCELLED", `${toolName} terminal audit reason`);
    }
  });
});
