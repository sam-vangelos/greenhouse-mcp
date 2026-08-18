import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  configure,
  apiGet,
  _resetClientState,
  _setSleep,
  sleep,
  REQUEST_ABORTED_ERROR_NAME,
  UPSTREAM_TIMEOUT_ERROR_NAME,
} from "../src/client.js";

// Live-pilot finding (2026-07-02, Class 2 — infrastructure honesty): NO fetch in the raw client
// carried a timeout/AbortSignal, while the scoped runtime's deadline only checks BETWEEN pages
// (its comment assumed "per-read timeouts" that never existed). One stalled Greenhouse socket
// therefore hung a tool straight through every deadline until the MCP client's 240s transport
// death with zero payload — misread live as a server outage. These tests lock the floor: every
// upstream request aborts at GREENHOUSE_REQUEST_TIMEOUT_MS, is retried once, and surfaces as a
// stably-named error the runtime can classify — honest truncation instead of dead air.

const originalFetch = globalThis.fetch;
const originalSleep = sleep;

function rejectOnAbort(signal: AbortSignal): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    // A real stalled socket keeps the event loop alive. The mock needs a referenced
    // handle too because AbortSignal.timeout() deliberately uses an unref'd timer.
    const watchdog = setTimeout(
      () => reject(new Error("test watchdog expired before the abort signal fired")),
      1_000
    );
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(watchdog);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

function hangingFetch(counter: { calls: number }, succeedOnCall?: number) {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    if (target.includes("auth.greenhouse.io")) {
      return new Response(
        JSON.stringify({
          access_token: "fake-token",
          token_type: "bearer",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    counter.calls += 1;
    if (succeedOnCall !== undefined && counter.calls >= succeedOnCall) {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const signal = init?.signal;
    assert.ok(signal instanceof AbortSignal, "every upstream fetch must carry an AbortSignal");
    return rejectOnAbort(signal);
  }) as typeof globalThis.fetch;
}

describe("per-request upstream timeout (the honesty floor)", () => {
  beforeEach(() => {
    _resetClientState();
    configure("test-client-id", "test-client-secret");
    process.env.GREENHOUSE_REQUEST_TIMEOUT_MS = "40";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setSleep(originalSleep);
    delete process.env.GREENHOUSE_REQUEST_TIMEOUT_MS;
    _resetClientState();
  });

  it("a stalled upstream socket aborts at the timeout, retries ONCE, then throws a stably-named error", async () => {
    const counter = { calls: 0 };
    hangingFetch(counter);
    await assert.rejects(
      () => apiGet("/test"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, UPSTREAM_TIMEOUT_ERROR_NAME, "consumers classify by stable error name, not message text");
        return true;
      }
    );
    assert.equal(counter.calls, 2, "one retry after the first abort — then fail honestly, never hang");
  });

  it("a transient stall recovers: first attempt aborts, the retry succeeds", async () => {
    const counter = { calls: 0 };
    hangingFetch(counter, 2);
    const result = await apiGet<{ ok: boolean }>("/test");
    assert.deepStrictEqual(result.data, { ok: true });
    assert.equal(counter.calls, 2);
  });

  it("a hanging TOKEN mint aborts and fails fast (single-flight clears; no hidden retry loop)", async () => {
    let tokenCalls = 0;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("auth.greenhouse.io")) {
        tokenCalls += 1;
        const signal = init?.signal;
        assert.ok(signal instanceof AbortSignal, "the mint fetch must carry an AbortSignal");
        return rejectOnAbort(signal);
      }
      throw new Error("data fetch should not be reached when the mint hangs");
    }) as typeof globalThis.fetch;

    await assert.rejects(
      () => apiGet("/test"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /test watchdog expired/);
        assert.match(error.message, /Failed to obtain access token/);
        return true;
      }
    );
    assert.equal(tokenCalls, 1, "the mint is single-flight and not retried by the timeout machinery");
  });

  it("caller cancellation aborts an in-flight GET immediately and is never retried", async () => {
    const controller = new AbortController();
    let dataCalls = 0;
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("auth.greenhouse.io")) {
        return new Response(JSON.stringify({
          access_token: "fake-token",
          token_type: "bearer",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      dataCalls += 1;
      requestStarted();
      const signal = init?.signal;
      assert.ok(signal instanceof AbortSignal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as typeof globalThis.fetch;

    const operation = apiGet("/test", undefined, controller.signal);
    await started;
    controller.abort();
    await assert.rejects(operation, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, REQUEST_ABORTED_ERROR_NAME);
      return true;
    });
    assert.equal(dataCalls, 1);
  });

  it("caller cancellation interrupts a retry wait and prevents the next request", async () => {
    const controller = new AbortController();
    let dataCalls = 0;
    let waitStarted!: () => void;
    const waiting = new Promise<void>((resolve) => { waitStarted = resolve; });
    _setSleep(() => {
      waitStarted();
      return new Promise<void>(() => undefined);
    });
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes("auth.greenhouse.io")) {
        return new Response(JSON.stringify({
          access_token: "fake-token",
          token_type: "bearer",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      dataCalls += 1;
      return new Response("", { status: 429, headers: { "Retry-After": "30" } });
    }) as typeof globalThis.fetch;

    const operation = apiGet("/test", undefined, controller.signal);
    await waiting;
    controller.abort();
    await assert.rejects(operation, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, REQUEST_ABORTED_ERROR_NAME);
      return true;
    });
    assert.equal(dataCalls, 1, "no retry starts after the caller disconnects");
  });
});
