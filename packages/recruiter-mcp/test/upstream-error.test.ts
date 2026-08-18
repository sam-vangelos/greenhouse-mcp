import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyUpstreamError, httpErrorStatus, isRateLimitError } from "../src/upstream-error.js";
import { runScorecardAccountability } from "../src/tools/scorecard-accountability.js";
import { analysisRuntime, fakeScopedReader } from "./test-helpers.js";

// F3: an opaque "failed before returning data" hid whether the P0 (401) meant
// "regenerate the credential" or the F5 (422) meant "a param bug". classifyUpstreamError
// recovers the status class so the denial names the cause.
describe("classifyUpstreamError — names the upstream cause class", () => {
  const gh = (status: number) => new Error(`Greenhouse API error: ${status} Whatever (endpoint) [correlation_id=x]`);
  const FALLBACK = "Scorecard accountability analysis failed before returning data.";

  it("401/403 → authentication failed (credential may need regeneration)", () => {
    assert.match(classifyUpstreamError(gh(401), FALLBACK), /authentication failed/i);
    assert.match(classifyUpstreamError(gh(403), FALLBACK), /authentication failed/i);
  });
  it("429 → rate limited (back off)", () => {
    assert.match(classifyUpstreamError(gh(429), FALLBACK), /rate limit/i);
  });
  it("422 → request rejected (unsupported parameter)", () => {
    assert.match(classifyUpstreamError(gh(422), FALLBACK), /rejected the request/i);
  });
  it("5xx → transient", () => {
    assert.match(classifyUpstreamError(gh(503), FALLBACK), /transient/i);
  });
  it("unknown / non-Greenhouse error → the caller's fallback (unchanged)", () => {
    assert.equal(classifyUpstreamError(new Error("something else"), FALLBACK), FALLBACK);
    assert.equal(classifyUpstreamError("not an error", FALLBACK), FALLBACK);
  });
  it("httpErrorStatus recovers the status from the sanitized text", () => {
    assert.equal(httpErrorStatus(gh(401)), 401);
    assert.equal(httpErrorStatus(new Error("no status here")), null);
  });
});

describe("isRateLimitError — detects the client's RateLimitError without the 'API error: 429' text", () => {
  it("matches by the client error name (the case that mislabels as opaque on single reads)", () => {
    assert.equal(isRateLimitError(Object.assign(new Error("too many"), { name: "RateLimitError" })), true);
  });
  it("matches by message fallback", () => {
    assert.equal(isRateLimitError(new Error("upstream was rate limited after retries")), true);
  });
  it("does not match an ordinary upstream error or a non-error", () => {
    assert.equal(isRateLimitError(new Error("Greenhouse API error: 500 boom")), false);
    assert.equal(isRateLimitError("nope"), false);
  });
});

describe("recipe denials name the upstream cause (integration)", () => {
  it("a scoped-read 401 surfaces an auth-classified denial, not the opaque message", async () => {
    const reader = fakeScopedReader((toolName) => {
      if (toolName === "list_applications") {
        // Bridge derive throws a Greenhouse 401 (revoked/superseded token).
        throw new Error("Greenhouse API error: 401 Unauthorized (/v3/applications) [correlation_id=x]");
      }
      throw new Error(`unexpected ${toolName}`);
    });
    const { runtime } = analysisRuntime(reader);

    const result = await runScorecardAccountability(runtime, { job_ids: "9001004" });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.denial.code, "UPSTREAM_ERROR");
    assert.match(
      result.ok === false ? result.denial.message : "",
      /authentication failed/i,
      "a 401 must surface as an auth failure, not 'failed before returning data'"
    );
  });
});
