import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { validateCursorExclusivity, listEndpoint } from "../src/list-helpers.js";
import { configure, _resetClientState, _setSleep, sleep } from "../src/client.js";

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
// validateCursorExclusivity
// ---------------------------------------------------------------------------

describe("validateCursorExclusivity", () => {
  it("throws when cursor is combined with defined parameters", () => {
    assert.throws(
      () => validateCursorExclusivity({ status: "active", per_page: 50 }, "abc123"),
      (err: Error) => {
        assert.ok(err.message.includes("Cannot combine cursor"));
        assert.ok(err.message.includes("status"));
        assert.ok(err.message.includes("per_page"));
        return true;
      }
    );
  });

  it("does not throw when cursor is used with all-undefined params", () => {
    assert.doesNotThrow(() =>
      validateCursorExclusivity(
        { status: undefined, per_page: undefined, created_at: undefined },
        "abc123"
      )
    );
  });

  it("does not throw when cursor is used with empty-string params", () => {
    assert.doesNotThrow(() =>
      validateCursorExclusivity({ status: "", per_page: undefined }, "abc123")
    );
  });

  it("does not throw when no cursor is provided", () => {
    assert.doesNotThrow(() =>
      validateCursorExclusivity({ status: "active", per_page: 50 }, undefined)
    );
  });

  it("lists all extra parameter names in the error message", () => {
    assert.throws(
      () => validateCursorExclusivity({ a: "1", b: "2", c: "3" }, "cursor"),
      (err: Error) => {
        assert.ok(err.message.includes("a, b, c"));
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// listEndpoint
// ---------------------------------------------------------------------------

describe("listEndpoint", () => {
  beforeEach(() => {
    _resetClientState();
    configure("test-id", "test-secret");
    _setSleep(() => Promise.resolve());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setSleep(originalSleep);
    _resetClientState();
  });

  it("delegates to apiGetWithCursor when cursor is provided (no extra params)", async () => {
    let requestedUrl = "";
    mockFetch(async (url) => {
      if (url.includes("auth.greenhouse.io")) {
        return jsonResponse({
          access_token: "fake-token",
          token_type: "bearer",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        });
      }
      requestedUrl = url;
      return jsonResponse([{ id: 1 }]);
    });

    const result = await listEndpoint("/applications", {}, "cursor123");
    assert.ok(requestedUrl.includes("cursor=cursor123"), "Should include cursor in URL");
    assert.ok(!requestedUrl.includes("per_page"), "Should not include other params");
    assert.deepStrictEqual(result.data, [{ id: 1 }]);
  });

  it("delegates to apiGet with params when no cursor is provided", async () => {
    let requestedUrl = "";
    mockFetch(async (url) => {
      if (url.includes("auth.greenhouse.io")) {
        return jsonResponse({
          access_token: "fake-token",
          token_type: "bearer",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        });
      }
      requestedUrl = url;
      return jsonResponse([{ id: 2 }]);
    });

    const result = await listEndpoint(
      "/applications",
      { status: "active", per_page: 50 }
    );
    assert.ok(requestedUrl.includes("status=active"), "Should include status param");
    assert.ok(requestedUrl.includes("per_page=50"), "Should include per_page param");
    assert.ok(!requestedUrl.includes("cursor"), "Should not include cursor");
    assert.deepStrictEqual(result.data, [{ id: 2 }]);
  });

  it("throws when cursor is combined with other params", async () => {
    await assert.rejects(
      () => listEndpoint("/applications", { status: "active" }, "cursor123"),
      (err: Error) => {
        assert.ok(err.message.includes("Cannot combine cursor"));
        assert.ok(err.message.includes("status"));
        return true;
      }
    );
  });
});
