import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createToolDeadline } from "../src/runtime.js";
import { DEFAULT_LIMITS, HARD_MAX_ANALYSIS_DURATION_MS, HARD_MAX_TOOL_DURATION_MS, createRecruiterToolLimits } from "../src/limits.js";
import { DEFAULT_HTTP_REQUEST_TIMEOUT_MS, readHttpServerTimeoutConfig } from "../src/http-request.js";
import { runtimeWithRemainingPlannerBudget } from "../src/tools/question-answer.js";

// The whole-analysis budget is DECOUPLED from a single read's timeout, so a large req is read
// comprehensively instead of clipped at ~one read's cap. The old design conflated the two on a 30s
// maxToolDurationMs, which truncated multi-thousand-application analyses mid-read and silently returned a
// shifting partial sample. createToolDeadline now drives on maxAnalysisDurationMs; per-read stays on
// maxToolDurationMs (a hung-call guard).
describe("analysis budget is decoupled from the per-read timeout", () => {
  const runtimeWith = (limits: Record<string, unknown>) => ({ now: () => 1_000, limits }) as never;

  it("createToolDeadline uses maxAnalysisDurationMs, not the per-read maxToolDurationMs (revert lock)", () => {
    // Revert createToolDeadline to `runtime.limits.maxToolDurationMs` and this drops to 30_000 -> fails.
    const d = createToolDeadline(runtimeWith({ maxToolDurationMs: 30_000, maxAnalysisDurationMs: 300_000 }), 0);
    assert.ok(d);
    assert.equal(d!.timeoutMs, HARD_MAX_ANALYSIS_DURATION_MS, "the analysis budget is separate from reads but cannot exceed the hard front-door ceiling");
  });

  it("falls back to maxToolDurationMs only when the analysis budget is unset (test/literal limits)", () => {
    const d = createToolDeadline(runtimeWith({ maxToolDurationMs: 1_000 }), 0);
    assert.equal(d!.timeoutMs, 1_000);
  });

  it("a zero analysis budget falls back to a finite read-sized deadline", () => {
    assert.equal(createToolDeadline(runtimeWith({ maxToolDurationMs: 30_000, maxAnalysisDurationMs: 0 }), 0)?.timeoutMs, 30_000);
  });

  it("the shipped analysis ceiling is 120 seconds while individual reads stay at 30 seconds", () => {
    assert.equal(DEFAULT_LIMITS.maxAnalysisDurationMs, 120_000, "analysis budget must finish before client transport ceilings");
    assert.equal(DEFAULT_HTTP_REQUEST_TIMEOUT_MS, 300_000, "HTTP request budget matches so the server does not socket-kill a long read");
    assert.equal(DEFAULT_LIMITS.maxToolDurationMs, 30_000, "the per-read hung-call guard stays modest");
  });

  it("env overrides may lower but cannot raise the hard read or analysis ceilings", () => {
    const lim = createRecruiterToolLimits({ GREENHOUSE_RECRUITER_MAX_ANALYSIS_DURATION_MS: "900000" } as NodeJS.ProcessEnv);
    assert.equal(lim.maxAnalysisDurationMs, HARD_MAX_ANALYSIS_DURATION_MS);
    assert.equal(createRecruiterToolLimits({ GREENHOUSE_RECRUITER_MAX_TOOL_DURATION_MS: "900000" } as NodeJS.ProcessEnv).maxToolDurationMs, HARD_MAX_TOOL_DURATION_MS);
    assert.equal(createRecruiterToolLimits({
      GREENHOUSE_RECRUITER_MAX_TOOL_DURATION_MS: "5000",
      GREENHOUSE_RECRUITER_MAX_ANALYSIS_DURATION_MS: "60000",
    } as NodeJS.ProcessEnv).maxAnalysisDurationMs, 60_000);
    const t = readHttpServerTimeoutConfig({ GREENHOUSE_RECRUITER_HTTP_REQUEST_TIMEOUT_MS: "900000" } as NodeJS.ProcessEnv);
    assert.equal(t.requestTimeoutMs, 900_000);
  });

  it("clamps both child read and analysis budgets to the planner's remaining deadline", () => {
    const runtime = {
      limits: { maxToolDurationMs: 30_000, maxAnalysisDurationMs: 120_000 },
      scopeContextResolved: false,
    } as never;
    const child = runtimeWithRemainingPlannerBudget(runtime, 12_345);
    assert.equal(child.limits.maxToolDurationMs, 12_345);
    assert.equal(child.limits.maxAnalysisDurationMs, 12_345);
    assert.equal(child.scopeContextResolved, true);
  });
});
