import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { HttpRequestBodyError, readBoundedJsonBody } from "../src/http-request.js";

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

function fakeRequest(body: string, headers: Record<string, string | string[] | undefined>): IncomingMessage {
  const req = Readable.from([body]) as IncomingMessage;
  req.headers = headers as IncomingMessage["headers"];
  return req;
}
