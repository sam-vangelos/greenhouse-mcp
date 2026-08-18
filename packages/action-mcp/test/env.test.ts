import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createActionRuntimeProvider, validateActionReadiness } from "../src/env.js";
import { TEST_SECRET } from "./helpers.js";

const ENV = {
  GREENHOUSE_ACTION_SERVICE_ENABLED: "true",
  GREENHOUSE_ACTION_WRITES_ENABLED: "false",
  GREENHOUSE_ACTION_SIGNING_SECRET: TEST_SECRET,
  GREENHOUSE_ACTION_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
  GREENHOUSE_ACTION_SUPABASE_KEY: "service-role-key",
  GREENHOUSE_ACTION_CLIENT_ID: "client-id",
  GREENHOUSE_ACTION_CLIENT_SECRET: "client-secret",
  GREENHOUSE_ACTION_ATTRIBUTION_MODE: "service_user",
} as NodeJS.ProcessEnv;

describe("action readiness", () => {
  test("probes authorization, action tables and RPCs, and Greenhouse OAuth", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const flags = await validateActionReadiness(ENV, async (input, init = {}) => {
      const url = String(input);
      requests.push({ url, method: init.method ?? "GET" });
      if (url.startsWith("https://auth.greenhouse.io/")) {
        return Response.json({ access_token: "live-token", expires_at: "2099-01-01T00:00:00.000Z" });
      }
      if (url.includes("/rpc/")) return Response.json(null);
      return Response.json([]);
    });

    assert.equal(flags.serviceEnabled, true);
    assert.deepEqual(requests.map(({ url }) => new URL(url).pathname).sort(), [
      "/rest/v1/greenhouse_action",
      "/rest/v1/greenhouse_action_entitlement",
      "/rest/v1/recruiter_mcp_session_revocation",
      "/rest/v1/rpc/prepare_greenhouse_action_reconciliation",
      "/token",
    ]);
    assert.equal(requests.find(({ url }) => url.includes("/rpc/"))?.method, "POST");
    assert.equal(requests.find(({ url }) => url.includes("auth.greenhouse.io"))?.method, "POST");
  });

  test("shares one runtime and OAuth cache for the HTTP process", async () => {
    let tokenMints = 0;
    const runtimeFor = createActionRuntimeProvider(ENV, async (input) => {
      if (String(input).includes("auth.greenhouse.io")) {
        tokenMints += 1;
        return Response.json({ access_token: "live-token", expires_at: "2099-01-01T00:00:00.000Z" });
      }
      return Response.json([]);
    });
    const first = runtimeFor();
    const second = runtimeFor();

    assert.equal(first, second);
    await Promise.all([first.greenhouse.probe(), second.greenhouse.probe()]);
    assert.equal(tokenMints, 1);
  });

  test("does not contact dependencies while the service kill switch is off", async () => {
    let contacted = false;
    const flags = await validateActionReadiness({ ...ENV, GREENHOUSE_ACTION_SERVICE_ENABLED: "false" }, async () => {
      contacted = true;
      throw new Error("unexpected request");
    });
    assert.equal(flags.serviceEnabled, false);
    assert.equal(contacted, false);
  });

  test("fails when either dependency rejects the probe", async () => {
    await assert.rejects(validateActionReadiness(ENV, async (input) => {
      if (String(input).includes("supabase.co")) return new Response(null, { status: 503 });
      return Response.json({ access_token: "live-token", expires_at: "2099-01-01T00:00:00.000Z" });
    }), /HTTP 503/);
  });
});
