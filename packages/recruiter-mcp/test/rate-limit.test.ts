import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryRateLimiter, createNoopRateLimiter, readRateLimiterConfigFromEnv } from "../src/rate-limit.js";
import { testSession } from "./test-helpers.js";

describe("recruiter MCP rate limiting", () => {
  it("enforces total call budgets per durable session and surface", () => {
    const limiter = createInMemoryRateLimiter({
      windowMs: 60_000,
      maxCallsPerWindow: 1,
      maxAnalysisCallsPerWindow: 1,
    });
    const session = testSession({ tokenId: "session-1", surface: "chatgpt_desktop" });

    const first = limiter.check({ session, toolName: "search_my_jobs", toolKind: "evidence", now: 0 });
    const second = limiter.check({ session, toolName: "search_my_jobs", toolKind: "evidence", now: 1 });
    const third = limiter.check({ session, toolName: "search_my_jobs", toolKind: "evidence", now: 60_001 });

    assert.equal(first.allowed, true);
    assert.equal(first.allowed && first.remaining, 0);
    assert.equal(second.allowed, false);
    assert.equal(second.allowed === false && second.reason, "total");
    assert.equal(third.allowed, true);
  });

  it("counts evidence and analysis calls against the same total session budget", () => {
    const limiter = createInMemoryRateLimiter({
      windowMs: 60_000,
      maxCallsPerWindow: 1,
      maxAnalysisCallsPerWindow: 10,
    });
    const session = testSession({ tokenId: "session-mixed", surface: "chatgpt_desktop" });

    const evidence = limiter.check({ session, toolName: "search_my_jobs", toolKind: "evidence", now: 0 });
    const analysis = limiter.check({ session, toolName: "analyze_scorecard_accountability", toolKind: "analysis", now: 1 });

    assert.equal(evidence.allowed, true);
    assert.equal(analysis.allowed, false);
    assert.equal(analysis.allowed === false && analysis.reason, "total");
  });

  it("enforces a smaller analytical call budget", () => {
    const limiter = createInMemoryRateLimiter({
      windowMs: 60_000,
      maxCallsPerWindow: 10,
      maxAnalysisCallsPerWindow: 1,
    });
    const session = testSession({ tokenId: "session-2" });

    assert.equal(limiter.check({ session, toolName: "search_my_jobs", toolKind: "evidence", now: 0 }).allowed, true);
    assert.equal(limiter.check({ session, toolName: "analyze_scorecard_accountability", toolKind: "analysis", now: 1 }).allowed, true);
    const denied = limiter.check({ session, toolName: "analyze_stage_latency", toolKind: "analysis", now: 2 });

    assert.equal(denied.allowed, false);
    assert.equal(denied.allowed === false && denied.reason, "analysis");
  });

  it("loads env overrides and supports an explicit no-op limiter", () => {
    assert.deepStrictEqual(readRateLimiterConfigFromEnv({
      GREENHOUSE_RECRUITER_RATE_LIMIT_WINDOW_MS: "120000",
      GREENHOUSE_RECRUITER_MAX_CALLS_PER_WINDOW: "50",
      GREENHOUSE_RECRUITER_MAX_ANALYSIS_CALLS_PER_WINDOW: "5",
    } as NodeJS.ProcessEnv), {
      windowMs: 120000,
      maxCallsPerWindow: 50,
      maxAnalysisCallsPerWindow: 5,
    });

    assert.equal(createNoopRateLimiter().check({
      session: testSession(),
      toolName: "search_my_jobs",
      toolKind: "evidence",
      now: 0,
    }).allowed, true);
  });

  it("rejects malformed rate-limit env overrides instead of silently defaulting", () => {
    assert.throws(
      () => readRateLimiterConfigFromEnv({ GREENHOUSE_RECRUITER_RATE_LIMIT_WINDOW_MS: "0" } as NodeJS.ProcessEnv),
      /GREENHOUSE_RECRUITER_RATE_LIMIT_WINDOW_MS must be a positive integer/
    );
    assert.throws(
      () => readRateLimiterConfigFromEnv({ GREENHOUSE_RECRUITER_MAX_CALLS_PER_WINDOW: "many" } as NodeJS.ProcessEnv),
      /GREENHOUSE_RECRUITER_MAX_CALLS_PER_WINDOW must be a positive integer/
    );
    assert.throws(
      () => readRateLimiterConfigFromEnv({ GREENHOUSE_RECRUITER_MAX_ANALYSIS_CALLS_PER_WINDOW: "5 " } as NodeJS.ProcessEnv),
      /GREENHOUSE_RECRUITER_MAX_ANALYSIS_CALLS_PER_WINDOW must be a positive integer/
    );
    assert.throws(
      () => readRateLimiterConfigFromEnv({ GREENHOUSE_RECRUITER_RATE_LIMIT_WINDOW_MS: "9007199254740993" } as NodeJS.ProcessEnv),
      /GREENHOUSE_RECRUITER_RATE_LIMIT_WINDOW_MS must be a positive integer/
    );
  });
});
