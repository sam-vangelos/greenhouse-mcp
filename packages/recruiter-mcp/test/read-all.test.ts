import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  _setReadAllSleep,
  readAllScopedRows,
  readAllSleep,
} from "../src/read-all.js";
import { fakeScopedReader, scopedDenial, scopedSuccess, testRuntime } from "./test-helpers.js";

const originalReadAllSleep = readAllSleep;

describe("readAllScopedRows", () => {
  afterEach(() => {
    _setReadAllSleep(originalReadAllSleep);
  });

  it("uses per_page=500 for the first page and cursor-only follow-ups", async () => {
    const scopedReader = fakeScopedReader((toolName, params) => {
      if (params?.cursor === "cursor-1") {
        return scopedSuccess(toolName, [{ id: 2 }]);
      }
      return scopedSuccess(toolName, [{ id: 1 }], "cursor-1");
    });
    const { runtime } = testRuntime(scopedReader);

    const result = await readAllScopedRows(
      runtime,
      "analysis_tool",
      "list_applications",
      { status: "active", per_page: 50 }
    );

    assert.equal(result.kind, "rows");
    if (result.kind !== "rows") return;
    assert.deepStrictEqual(result.rows, [{ id: 1 }, { id: 2 }]);
    assert.equal(result.status, "complete");
    assert.equal(result.complete, true);
    assert.equal(result.perPage, 500);
    assert.deepStrictEqual(scopedReader.calls.map((call) => call.params), [
      { status: "active", per_page: 500 },
      { cursor: "cursor-1" },
    ]);
  });

  it("marks a cursor read incomplete when the deadline elapses after a page", async () => {
    const startedAt = Date.parse("2026-06-23T12:00:00.000Z");
    let now = startedAt;
    const scopedReader = fakeScopedReader((toolName) => {
      now = startedAt + 1_001;
      return scopedSuccess(toolName, [{ id: 1 }], "cursor-1");
    });
    const { runtime } = testRuntime(scopedReader, {
      now: () => now,
      limits: {
        maxPerPage: 100,
        defaultPerPage: 100,
        maxLookbackDays: 180,
        maxRankings: 25,
        maxEvidenceIds: 200,
        maxToolDurationMs: 1_000,
      },
    });

    const result = await readAllScopedRows(
      runtime,
      "analysis_tool",
      "list_applications",
      {},
      { startedAt, timeoutMs: 1_000, now: () => now }
    );

    assert.equal(result.kind, "rows");
    if (result.kind !== "rows") return;
    assert.equal(result.status, "incomplete_timeout");
    assert.equal(result.complete, false);
    assert.equal(result.nextCursor, "cursor-1");
    assert.equal(result.pagesRead, 1);
  });

  it("stops before the next cursor when the rate-limit reset exceeds the deadline", async () => {
    const now = Date.parse("2026-06-23T12:00:00.000Z");
    const scopedReader = fakeScopedReader((toolName) =>
      scopedSuccess(toolName, [{ id: 1 }], "cursor-1", {
        meta: {
          retry: {
            attempts: 1,
            rateLimitRetries: 0,
            sleptMs: 0,
            retryAfterSeconds: [],
          },
          rateLimit: {
            remaining: 0,
            resetAt: now + 5_000,
            observedAt: now,
          },
        },
      })
    );
    const { runtime } = testRuntime(scopedReader, { now: () => now });

    const result = await readAllScopedRows(
      runtime,
      "analysis_tool",
      "list_applications",
      {},
      { startedAt: now, timeoutMs: 1_000, now: () => now }
    );

    assert.equal(result.kind, "rows");
    if (result.kind !== "rows") return;
    assert.equal(result.status, "incomplete_rate_limited");
    assert.equal(result.complete, false);
    assert.equal(result.nextCursor, "cursor-1");
    assert.equal(scopedReader.calls.length, 1);
  });

  it("waits within the deadline and follows the cursor after a rate-limit reset", async () => {
    const startedAt = Date.parse("2026-06-23T12:00:00.000Z");
    let now = startedAt;
    _setReadAllSleep(async (ms) => {
      now += ms;
    });
    const scopedReader = fakeScopedReader((toolName, params) => {
      if (params?.cursor === "cursor-1") {
        return scopedSuccess(toolName, [{ id: 2 }]);
      }
      return scopedSuccess(toolName, [{ id: 1 }], "cursor-1", {
        meta: {
          retry: {
            attempts: 1,
            rateLimitRetries: 0,
            sleptMs: 0,
            retryAfterSeconds: [],
          },
          rateLimit: {
            remaining: 0,
            resetAt: startedAt + 50,
            observedAt: startedAt,
          },
        },
      });
    });
    const { runtime } = testRuntime(scopedReader, { now: () => now });

    const result = await readAllScopedRows(
      runtime,
      "analysis_tool",
      "list_applications",
      {},
      { startedAt, timeoutMs: 1_000, now: () => now }
    );

    assert.equal(result.kind, "rows");
    if (result.kind !== "rows") return;
    assert.equal(result.status, "complete");
    assert.equal(result.rateLimitSleepMs, 50);
    assert.deepStrictEqual(scopedReader.calls.map((call) => call.params), [
      { per_page: 500 },
      { cursor: "cursor-1" },
    ]);
  });

  it("returns scoped denials without converting them into partial rows", async () => {
    const scopedReader = fakeScopedReader((toolName) =>
      scopedDenial(toolName, "PERMISSION_LOOKUP_FAILED")
    );
    const { runtime } = testRuntime(scopedReader);

    const result = await readAllScopedRows(
      runtime,
      "analysis_tool",
      "list_applications",
      {}
    );

    assert.equal(result.kind, "denial");
    if (result.kind !== "denial") return;
    assert.equal(result.result.ok, false);
    if (!result.result.ok) {
      assert.equal(result.result.denial.code, "PERMISSION_LOOKUP_FAILED");
    }
  });

  it("marks missing parent associations as incomplete_scope_resolution instead of a clean zero", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, [], null, {
      rowCounts: {
        raw: 2,
        returned: 0,
        permissionExcluded: 0,
        unresolved: 2,
        status: "incomplete_scope_resolution",
      },
      meta: {
        retry: { attempts: 1, rateLimitRetries: 0, sleptMs: 0, retryAfterSeconds: [] },
        cacheHits: 1,
      },
    }));
    const { runtime } = testRuntime(scopedReader);

    const result = await readAllScopedRows(runtime, "analysis_tool", "list_approvers", {});

    assert.equal(result.kind, "rows");
    if (result.kind !== "rows") return;
    assert.equal(result.status, "incomplete_scope_resolution");
    assert.equal(result.complete, false);
    assert.equal(result.rawRowsRead, 2);
    assert.equal(result.unresolvedRows, 2);
    assert.equal(result.cacheHits, 1);
    assert.match(result.warnings.join(" "), /could not be resolved/);
  });

  it("keeps completed pages but marks a later permission-parent read failure incomplete", async () => {
    let call = 0;
    const scopedReader = fakeScopedReader((toolName) => {
      call += 1;
      return call === 1
        ? scopedSuccess(toolName, [{ id: 1 }], "cursor-1")
        : scopedDenial(toolName, "PERMISSION_JOIN_FAILED");
    });
    const { runtime } = testRuntime(scopedReader);

    const result = await readAllScopedRows(runtime, "analysis_tool", "list_approvers", {});

    assert.equal(result.kind, "rows");
    if (result.kind !== "rows") return;
    assert.deepEqual(result.rows, [{ id: 1 }]);
    assert.equal(result.status, "incomplete_scope_resolution");
    assert.equal(result.complete, false);
    assert.equal(result.pagesRead, 1);
  });

  it("hard-denies when the required permission-parent read fails on the first page", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedDenial(toolName, "PERMISSION_JOIN_FAILED"));
    const { runtime } = testRuntime(scopedReader);

    const result = await readAllScopedRows(runtime, "analysis_tool", "list_approvers", {});

    assert.equal(result.kind, "denial");
    if (result.kind !== "denial" || result.result.ok) return;
    assert.equal(result.result.denial.code, "PERMISSION_JOIN_FAILED");
  });

  it("maps a rate-limit error thrown after the first page to incomplete_rate_limited, preserving fetched rows (regression: retry-exhaustion)", async () => {
    let call = 0;
    const scopedReader = fakeScopedReader((toolName) => {
      call += 1;
      if (call === 1) return scopedSuccess(toolName, [{ id: 1 }], "cursor-1");
      const err = new Error("Rate limited. Retry after 1 seconds.");
      err.name = "RateLimitError"; // stable identity contract from the raw client
      throw err;
    });
    const { runtime } = testRuntime(scopedReader);

    const result = await readAllScopedRows(runtime, "analysis_tool", "list_applications", {});

    assert.equal(result.kind, "rows");
    if (result.kind !== "rows") return;
    assert.equal(result.status, "incomplete_rate_limited");
    assert.equal(result.complete, false);
    assert.deepStrictEqual(result.rows, [{ id: 1 }]);
    assert.equal(result.pagesRead, 1);
  });

  it("denies with RATE_LIMITED when the rate-limit error is thrown on the first page (regression)", async () => {
    const scopedReader = fakeScopedReader(() => {
      const err = new Error("Rate limited. Retry after 1 seconds.");
      err.name = "RateLimitError";
      throw err;
    });
    const { runtime } = testRuntime(scopedReader);

    const result = await readAllScopedRows(runtime, "analysis_tool", "list_applications", {});

    assert.equal(result.kind, "denial");
    if (result.kind !== "denial") return;
    assert.equal(result.result.ok, false);
    if (!result.result.ok) {
      assert.equal(result.result.denial.code, "RATE_LIMITED");
    }
  });

  it("stops with incomplete_page_cap when the upstream returns a repeated cursor (regression: cursor-cycle guard)", async () => {
    const scopedReader = fakeScopedReader((toolName) => scopedSuccess(toolName, [{ id: 1 }], "same-cursor"));
    const { runtime } = testRuntime(scopedReader);

    const result = await readAllScopedRows(runtime, "analysis_tool", "list_applications", {});

    assert.equal(result.kind, "rows");
    if (result.kind !== "rows") return;
    assert.equal(result.status, "incomplete_page_cap");
    assert.equal(result.complete, false);
    assert.equal(result.pagesRead, 2, "the cursor-cycle guard must stop after the repeat, not run to the page ceiling");
  });
});
