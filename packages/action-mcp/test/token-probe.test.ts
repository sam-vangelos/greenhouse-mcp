import assert from "node:assert/strict";
import { test } from "node:test";
import { probePerHumanTokens } from "../src/token-probe.js";

test("token probe checks concurrent same/different subjects without exposing tokens", async () => {
  let sequence = 0;
  const mintSubjects: string[] = [];
  let validationCalls = 0;
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("auth.greenhouse.io")) {
      const subject = new URLSearchParams(String(init.body)).get("sub")!;
      mintSubjects.push(subject);
      const payload = Buffer.from(JSON.stringify({ sub: subject })).toString("base64url");
      sequence += 1;
      return Response.json({ access_token: `header.${payload}.sig${sequence}` });
    }
    validationCalls += 1;
    return Response.json([{ id: Number(new URL(url).searchParams.get("ids")) }]);
  };
  const result = await probePerHumanTokens({
    GREENHOUSE_ACTION_CLIENT_ID: "client",
    GREENHOUSE_ACTION_CLIENT_SECRET: "secret",
    GREENHOUSE_ACTION_PROBE_PRIMARY_USER_ID: "10",
    GREENHOUSE_ACTION_PROBE_SECONDARY_USER_ID: "11",
  }, fetchImpl);
  assert.equal(result.passed, true);
  assert.deepEqual(mintSubjects, ["10", "10", "10", "11", "10"]);
  assert.equal(validationCalls, 9);
  assert.doesNotMatch(JSON.stringify(result), /header\.|sig1/);
});
