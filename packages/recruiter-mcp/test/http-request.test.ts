import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import {
  HttpRequestBodyError,
  PUBLIC_READY_PATH,
  isReservedLiteralRoutePath,
  readBoundedJsonBody,
  readHttpEndpointConfig,
} from "../src/http-request.js";

describe("hosted HTTP request parsing", () => {
  it("rejects duplicate Content-Type headers instead of choosing one", async () => {
    await assert.rejects(
      () => readBoundedJsonBody(fakeRequest("{}", {
        "content-type": ["application/json", "text/plain"],
      }), 64),
      (error) => error instanceof HttpRequestBodyError && error.statusCode === 415
    );
  });

  it("rejects non-exact Content-Length headers", async () => {
    await assert.rejects(
      () => readBoundedJsonBody(fakeRequest("{}", {
        "content-type": "application/json",
        "content-length": " 2",
      }), 64),
      /Content-Length must be a non-negative integer/
    );
    await assert.rejects(
      () => readBoundedJsonBody(fakeRequest("{}", {
        "content-type": "application/json",
        "content-length": ["2", "2"],
      }), 64),
      /Content-Length must be a non-negative integer/
    );
  });

  it("accepts exact JSON content headers within the body limit", async () => {
    const body = await readBoundedJsonBody(fakeRequest("{}", {
      "content-type": "application/json; charset=utf-8",
      "content-length": "2",
    }), 64);

    assert.deepEqual(body, {});
  });
});

describe("hosted HTTP endpoint config (Cloud Run runtime contract)", () => {
  it("honors Cloud Run's injected PORT ahead of the recruiter-specific fallback", () => {
    assert.equal(
      readHttpEndpointConfig({ PORT: "8080", GREENHOUSE_RECRUITER_MCP_PORT: "3333" } as NodeJS.ProcessEnv).port,
      8080
    );
  });

  it("falls back to GREENHOUSE_RECRUITER_MCP_PORT when PORT is unset or empty", () => {
    assert.equal(readHttpEndpointConfig({ GREENHOUSE_RECRUITER_MCP_PORT: "3333" } as NodeJS.ProcessEnv).port, 3333);
    assert.equal(
      readHttpEndpointConfig({ PORT: "", GREENHOUSE_RECRUITER_MCP_PORT: "3333" } as NodeJS.ProcessEnv).port,
      3333
    );
  });

  it("defaults to 3333 when neither PORT nor the recruiter fallback is set", () => {
    assert.equal(readHttpEndpointConfig({} as NodeJS.ProcessEnv).port, 3333);
  });

  it("names PORT in the range error when the Cloud Run value is malformed", () => {
    assert.throws(
      () => readHttpEndpointConfig({ PORT: "not-a-port", GREENHOUSE_RECRUITER_MCP_PORT: "3333" } as NodeJS.ProcessEnv),
      /\bPORT must be an integer from 0 to 65535\./
    );
  });

  it("reserves the literal /ready route so no configured path can shadow the Cloud Run readiness probe", () => {
    assert.equal(PUBLIC_READY_PATH, "/ready");
    assert.equal(isReservedLiteralRoutePath("/ready"), true);
    for (const key of [
      "GREENHOUSE_RECRUITER_MCP_PATH",
      "GREENHOUSE_RECRUITER_HEALTH_PATH",
      "GREENHOUSE_RECRUITER_READY_PATH",
    ]) {
      assert.throws(
        () => readHttpEndpointConfig({ [key]: "/ready" } as NodeJS.ProcessEnv),
        /must not shadow the reserved server routes/,
        `${key}=/ready must be rejected`
      );
    }
  });
});

function fakeRequest(body: string, headers: Record<string, string | string[] | undefined>): IncomingMessage {
  const req = Readable.from([body]) as IncomingMessage;
  req.headers = headers as IncomingMessage["headers"];
  return req;
}
