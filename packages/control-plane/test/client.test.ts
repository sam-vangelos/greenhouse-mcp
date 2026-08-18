import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  configure,
  apiGet,
  apiGetWithCursor,
  _resetClientState,
  _setSleep,
  sleep,
  DEFAULT_RETRY_SECONDS,
  MAX_RETRIES,
} from "../src/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
const originalSleep = sleep;

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = handler as typeof globalThis.fetch;
}

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Greenhouse client — 429 retry", () => {
  beforeEach(() => {
    _resetClientState();
    configure("test-client-id", "test-client-secret");
    // No-op sleep so tests run instantly
    _setSleep(() => Promise.resolve());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setSleep(originalSleep);
    _resetClientState();
  });

  it("retries on 429 and returns data on success", async () => {
    let callCount = 0;
    mockFetch(async (url) => {
      // Auth token request
      if (url.includes("auth.greenhouse.io")) {
        return jsonResponse({
          access_token: "fake-token",
          token_type: "bearer",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        });
      }
      callCount++;
      if (callCount === 1) {
        return new Response("", { status: 429, headers: { "Retry-After": "1" } });
      }
      return jsonResponse({ items: ["a", "b"] });
    });

    const result = await apiGet("/test");
    assert.deepStrictEqual(result.data, { items: ["a", "b"] });
    assert.equal(callCount, 2, "Should have made 2 API calls (1 retry)");
  });

  it("throws after exhausting all retries", async () => {
    mockFetch(async (url) => {
      if (url.includes("auth.greenhouse.io")) {
        return jsonResponse({
          access_token: "fake-token",
          token_type: "bearer",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        });
      }
      return new Response("", { status: 429, headers: { "Retry-After": "1" } });
    });

    await assert.rejects(
      () => apiGet("/test"),
      (err: Error) => {
        assert.ok(err.message.includes("Rate limited"), `Expected rate limit error, got: ${err.message}`);
        return true;
      }
    );
  });

  it("uses DEFAULT_RETRY_SECONDS when Retry-After header is missing", async () => {
    const sleepCalls: number[] = [];
    _setSleep(async (ms) => { sleepCalls.push(ms); });

    let callCount = 0;
    mockFetch(async (url) => {
      if (url.includes("auth.greenhouse.io")) {
        return jsonResponse({
          access_token: "fake-token",
          token_type: "bearer",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        });
      }
      callCount++;
      if (callCount === 1) {
        return new Response("", { status: 429 });
      }
      return jsonResponse({ ok: true });
    });

    await apiGet("/test");
    assert.equal(sleepCalls.length, 1, "Should have slept once");
    assert.equal(
      sleepCalls[0],
      DEFAULT_RETRY_SECONDS * 1000,
      `Should sleep for DEFAULT_RETRY_SECONDS (${DEFAULT_RETRY_SECONDS}s)`
    );
  });

  it("respects Retry-After header value", async () => {
    const sleepCalls: number[] = [];
    _setSleep(async (ms) => { sleepCalls.push(ms); });

    let callCount = 0;
    mockFetch(async (url) => {
      if (url.includes("auth.greenhouse.io")) {
        return jsonResponse({
          access_token: "fake-token",
          token_type: "bearer",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        });
      }
      callCount++;
      if (callCount === 1) {
        return new Response("", { status: 429, headers: { "Retry-After": "5" } });
      }
      return jsonResponse({ ok: true });
    });

    await apiGet("/test");
    assert.equal(sleepCalls[0], 5000, "Should sleep for the Retry-After value (5s)");
  });

  it("returns retry and observed rate-limit metadata from successful GET responses", async () => {
    let callCount = 0;
    mockFetch(async (url) => {
      if (url.includes("auth.greenhouse.io")) {
        return jsonResponse({
          access_token: "fake-token",
          token_type: "bearer",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        });
      }
      callCount++;
      if (callCount === 1) {
        return new Response("", { status: 429, headers: { "Retry-After": "2" } });
      }
      return jsonResponse(
        { ok: true },
        200,
        {
          "X-RateLimit-Limit": "100",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": "2000000000",
        }
      );
    });

    const result = await apiGet("/test");

    assert.equal(result.meta?.retry.attempts, 2);
    assert.equal(result.meta?.retry.rateLimitRetries, 1);
    assert.deepStrictEqual(result.meta?.retry.retryAfterSeconds, [2]);
    assert.equal(result.meta?.retry.sleptMs, 2000);
    assert.equal(result.meta?.rateLimit?.limit, 100);
    assert.equal(result.meta?.rateLimit?.remaining, 0);
    assert.equal(result.meta?.rateLimit?.resetAt, 2_000_000_000_000);
    assert.equal(typeof result.meta?.rateLimit?.observedAt, "number");
  });

  it(`makes at most ${MAX_RETRIES + 1} total attempts`, async () => {
    let apiCallCount = 0;
    mockFetch(async (url) => {
      if (url.includes("auth.greenhouse.io")) {
        return jsonResponse({
          access_token: "fake-token",
          token_type: "bearer",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        });
      }
      apiCallCount++;
      return new Response("", { status: 429, headers: { "Retry-After": "1" } });
    });

    try {
      await apiGet("/test");
    } catch {
      // expected
    }
    assert.equal(
      apiCallCount,
      MAX_RETRIES + 1,
      `Should make exactly ${MAX_RETRIES + 1} attempts`
    );
  });

  it("apiGetWithCursor retries on 429 then succeeds", async () => {
    let callCount = 0;
    mockFetch(async (url) => {
      if (url.includes("auth.greenhouse.io")) {
        return jsonResponse({
          access_token: "fake-token",
          token_type: "bearer",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        });
      }
      callCount++;
      if (callCount === 1) {
        return new Response("", { status: 429, headers: { "Retry-After": "1" } });
      }
      return jsonResponse([{ id: 99 }]);
    });

    const result = await apiGetWithCursor("/applications", "abc123");
    assert.deepStrictEqual(result.data, [{ id: 99 }]);
    assert.equal(callCount, 2, "Should have made 2 API calls (1 retry)");
  });

  it("_resetClientState clears cached auth token", async () => {
    // First request — caches token "token-A"
    let authCallCount = 0;
    mockFetch(async (url) => {
      if (url.includes("auth.greenhouse.io")) {
        authCallCount++;
        return jsonResponse({
          access_token: `token-${authCallCount}`,
          token_type: "bearer",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        });
      }
      return jsonResponse({ ok: true });
    });

    await apiGet("/test");
    assert.equal(authCallCount, 1, "First request should fetch one token");

    // Second request — token is cached, no new auth call
    await apiGet("/test");
    assert.equal(authCallCount, 1, "Second request should reuse cached token");

    // Reset all state (including auth cache)
    _resetClientState();
    configure("test-client-id", "test-client-secret");

    // Third request — must fetch a new token since cache was cleared
    await apiGet("/test");
    assert.equal(authCallCount, 2, "After reset, a new token should be fetched");
  });
});

// ---------------------------------------------------------------------------
// Slice 2 — error sanitization
//
// Policy anchor: docs/greenhouse-mcp-output-doctrine.md §5 "Error Posture".
//
// Non-2xx (non-429) responses must throw the sanitized shape
//   Greenhouse API error: <status> <statusText> (<endpoint>) [correlation_id=<id>]
// with NO response body, NO query string, and NO caller-supplied input in the
// thrown message. The response body goes to stderr only, in the shape
//   [greenhouse-mcp] ERROR <correlation_id> <status> <endpoint> body=<body_text>
// so an operator can cross-reference the two via the correlation ID.
// ---------------------------------------------------------------------------

const THROWN_SHAPE_RE =
  /^Greenhouse API error: \d+ [^()]*\(.+\) \[correlation_id=[^\]]+\]$/;
const CORRELATION_ID_IN_THROW_RE = /\[correlation_id=([^\]]+)\]$/;

function authTokenResponse(): Response {
  return jsonResponse({
    access_token: "fake-token",
    token_type: "bearer",
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  });
}

function spyStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };
  return { lines, restore: () => { console.error = original; } };
}

describe("Greenhouse client — sanitized error posture", () => {
  beforeEach(() => {
    _resetClientState();
    configure("test-client-id", "test-client-secret");
    _setSleep(() => Promise.resolve());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setSleep(originalSleep);
    _resetClientState();
  });

  it("apiGet non-2xx throws sanitized shape without body or query string", async () => {
    const secretBody = "internal-candidate-name=Jane_Doe_Secret";
    mockFetch(async (url) => {
      if (url.includes("auth.greenhouse.io")) return authTokenResponse();
      return new Response(secretBody, { status: 404, statusText: "Not Found" });
    });

    const spy = spyStderr();
    try {
      await assert.rejects(
        () => apiGet("/candidates", { q: "Jane_Doe_Secret" }),
        (err: Error) => {
          assert.match(
            err.message,
            THROWN_SHAPE_RE,
            `Thrown message did not match sanitized shape: ${err.message}`
          );
          assert.ok(
            !err.message.includes(secretBody),
            "Thrown message must not echo response body"
          );
          assert.ok(
            !err.message.includes("Jane_Doe_Secret"),
            "Thrown message must not echo caller-supplied query param"
          );
          assert.ok(
            !err.message.includes("?"),
            "Thrown message must not include a query string"
          );
          assert.ok(
            err.message.includes("404 Not Found"),
            `Thrown message should carry status and statusText: ${err.message}`
          );
          assert.ok(
            err.message.includes("(/v3/candidates)"),
            `Thrown message should carry the path-only endpoint: ${err.message}`
          );
          return true;
        }
      );
    } finally {
      spy.restore();
    }
  });

  it("apiGetWithCursor non-2xx throws sanitized shape without body or cursor value", async () => {
    const secretBody = "paginated-body-candidate-name=Alex_Leak";
    const secretCursor = "secret-cursor-value-abc";
    mockFetch(async (url) => {
      if (url.includes("auth.greenhouse.io")) return authTokenResponse();
      return new Response(secretBody, { status: 500, statusText: "Internal Server Error" });
    });

    const spy = spyStderr();
    try {
      await assert.rejects(
        () => apiGetWithCursor("/applications", secretCursor),
        (err: Error) => {
          assert.match(err.message, THROWN_SHAPE_RE);
          assert.ok(!err.message.includes(secretBody));
          assert.ok(!err.message.includes(secretCursor));
          assert.ok(!err.message.includes("?"));
          assert.ok(err.message.includes("500"));
          assert.ok(err.message.includes("(/v3/applications)"));
          return true;
        }
      );
    } finally {
      spy.restore();
    }
  });

  it("stderr log carries correlation ID, status, endpoint, and body text", async () => {
    const bodyText = "diagnostic-body-payload";
    mockFetch(async (url) => {
      if (url.includes("auth.greenhouse.io")) return authTokenResponse();
      return new Response(bodyText, { status: 404, statusText: "Not Found" });
    });

    const spy = spyStderr();
    let thrown: Error | null = null;
    try {
      try {
        await apiGet("/candidates");
      } catch (e) {
        thrown = e as Error;
      }
    } finally {
      spy.restore();
    }

    assert.ok(thrown, "apiGet should have thrown");
    const errorLine = spy.lines.find((l) => l.startsWith("[greenhouse-mcp] ERROR "));
    assert.ok(errorLine, `Expected a '[greenhouse-mcp] ERROR' stderr line, got: ${JSON.stringify(spy.lines)}`);
    const match = errorLine!.match(
      /^\[greenhouse-mcp\] ERROR (\S+) (\d+) (\S+) body=(.*)$/
    );
    assert.ok(match, `Stderr line did not match shape: ${errorLine}`);
    const [, stderrId, stderrStatus, stderrEndpoint, stderrBody] = match!;
    assert.equal(stderrStatus, "404");
    assert.equal(stderrEndpoint, "/v3/candidates");
    assert.equal(stderrBody, bodyText);

    const throwMatch = thrown!.message.match(CORRELATION_ID_IN_THROW_RE);
    assert.ok(throwMatch, `Thrown message missing correlation ID: ${thrown!.message}`);
    assert.equal(
      throwMatch![1],
      stderrId,
      "Correlation ID in thrown error must match the stderr body-log line"
    );
  });

  it("token non-2xx throws sanitized shape without auth body or credentials", async () => {
    const authBody =
      "invalid_client: client_id=test-client-id client_secret=test-client-secret";
    mockFetch(async (url) => {
      if (url.includes("auth.greenhouse.io")) {
        return new Response(authBody, { status: 401, statusText: "Unauthorized" });
      }
      return jsonResponse({ should_not: "reach-harvest" });
    });

    const spy = spyStderr();
    let thrown: Error | null = null;
    try {
      try {
        await apiGet("/candidates");
      } catch (e) {
        thrown = e as Error;
      }
    } finally {
      spy.restore();
    }

    assert.ok(thrown, "apiGet should throw before calling Harvest when token fetch fails");
    assert.match(
      thrown!.message,
      /^Failed to obtain access token: 401 Unauthorized \[correlation_id=[^\]]+\]$/
    );
    assert.ok(!thrown!.message.includes(authBody));
    assert.ok(!thrown!.message.includes("test-client-id"));
    assert.ok(!thrown!.message.includes("test-client-secret"));

    const tokenLine = spy.lines.find((l) => l.startsWith("[greenhouse-mcp] TOKEN_ERROR "));
    assert.ok(tokenLine, `Expected TOKEN_ERROR stderr line, got: ${JSON.stringify(spy.lines)}`);
    const stderrIdMatch = tokenLine!.match(
      /^\[greenhouse-mcp\] TOKEN_ERROR (\S+) 401 body=(.*)$/
    );
    const throwIdMatch = thrown!.message.match(CORRELATION_ID_IN_THROW_RE);
    assert.ok(stderrIdMatch && throwIdMatch);
    assert.equal(stderrIdMatch![1], throwIdMatch![1]);
    assert.equal(stderrIdMatch![2], authBody);
  });
});

// ---------------------------------------------------------------------------
// 401 auth-revocation recovery (P0 outage regression lock)
// ---------------------------------------------------------------------------
//
// Greenhouse Harvest client_credentials tokens have single-active-token
// semantics: issuing a new token ("already been refreshed or revoked") revokes
// the prior one. A peer service on the same client_id/secret — or a concurrent
// refresh, or a second instance — can silently revoke THIS process's cached
// token. Before the fix, a Harvest 401 threw straight through and getAccessToken
// kept serving the revoked token until its NOMINAL expiry: a permanent read
// outage with no self-heal. These lock the recovery: a 401 must invalidate the
// cache, refetch a fresh token, and retry once; concurrent cold-cache fetches
// must single-flight so we don't self-revoke.
describe("Greenhouse client — 401 auth-revocation recovery", () => {
  beforeEach(() => {
    _resetClientState();
    configure("test-client-id", "test-client-secret");
    _setSleep(() => Promise.resolve());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setSleep(originalSleep);
    _resetClientState();
  });

  it("invalidates the cached token and retries once on a Harvest 401, recovering with a fresh token", async () => {
    let tokensIssued = 0;
    let apiCalls = 0;
    const bearersSeen: string[] = [];
    mockFetch(async (url, init) => {
      if (url.includes("auth.greenhouse.io")) {
        tokensIssued++;
        return jsonResponse({
          access_token: `token-${tokensIssued}`,
          token_type: "bearer",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        });
      }
      apiCalls++;
      bearersSeen.push(new Headers(init?.headers as HeadersInit).get("authorization") ?? "");
      if (apiCalls === 1) {
        return jsonResponse(
          {
            message: "Unauthorized",
            errors: ["Token has already been refreshed or revoked. Please generate a new token."],
          },
          401
        );
      }
      return jsonResponse({ items: ["ok"] });
    });

    const result = await apiGet("/candidates");
    assert.deepStrictEqual(result.data, { items: ["ok"] });
    assert.equal(apiCalls, 2, "should retry the read exactly once after a 401");
    assert.equal(tokensIssued, 2, "should mint a fresh token after the 401 (cache invalidated)");
    assert.match(bearersSeen[0], /token-1/);
    assert.match(
      bearersSeen[1],
      /token-2/,
      "the retry must present the refreshed token, not the revoked one"
    );
  });

  it("apiGetWithCursor also recovers from a 401 with a refreshed token", async () => {
    let tokensIssued = 0;
    let apiCalls = 0;
    mockFetch(async (url) => {
      if (url.includes("auth.greenhouse.io")) {
        tokensIssued++;
        return jsonResponse({
          access_token: `token-${tokensIssued}`,
          token_type: "bearer",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        });
      }
      apiCalls++;
      if (apiCalls === 1) return jsonResponse({ message: "Unauthorized" }, 401);
      return jsonResponse([{ id: 7 }]);
    });

    const result = await apiGetWithCursor("/candidates", "cursor-abc");
    assert.deepStrictEqual(result.data, [{ id: 7 }]);
    assert.equal(apiCalls, 2, "cursor read should retry once after a 401");
    assert.equal(tokensIssued, 2);
  });

  it("gives up after a single auth refresh when the 401 persists (no infinite loop)", async () => {
    let tokensIssued = 0;
    let apiCalls = 0;
    mockFetch(async (url) => {
      if (url.includes("auth.greenhouse.io")) {
        tokensIssued++;
        return jsonResponse({
          access_token: `token-${tokensIssued}`,
          token_type: "bearer",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        });
      }
      apiCalls++;
      return jsonResponse({ message: "Unauthorized" }, 401);
    });

    await assert.rejects(
      () => apiGet("/candidates"),
      (err: Error) => {
        assert.match(err.message, /Greenhouse API error: 401/, `expected surfaced 401, got: ${err.message}`);
        return true;
      }
    );
    assert.equal(apiCalls, 2, "one original + exactly one auth-refresh retry, then surface");
    assert.equal(tokensIssued, 2, "refetched exactly once");
  });

  it("single-flights concurrent cold-cache token fetches (no self-inflicted refresh stampede)", async () => {
    let tokensIssued = 0;
    mockFetch(async (url) => {
      if (url.includes("auth.greenhouse.io")) {
        tokensIssued++;
        await Promise.resolve(); // yield so concurrent callers overlap on the in-flight fetch
        return jsonResponse({
          access_token: `token-${tokensIssued}`,
          token_type: "bearer",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        });
      }
      return jsonResponse({ ok: true });
    });

    await Promise.all([apiGet("/a"), apiGet("/b"), apiGet("/c"), apiGet("/d")]);
    assert.equal(tokensIssued, 1, "four concurrent cold-cache reads should share a single token fetch");
  });
});
