import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runReconciliation } from "../src/reconcile-cli.js";
import { TEST_SECRET } from "./helpers.js";

describe("action reconciliation CLI", () => {
  test("probes the dedicated reconciler credential even when the ledger is empty", async () => {
    let tokenMints = 0;
    let authorization: string | null = null;
    const result = await runReconciliation([], {
      GREENHOUSE_ACTION_SIGNING_SECRET: TEST_SECRET,
      GREENHOUSE_ACTION_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
      GREENHOUSE_ACTION_SUPABASE_KEY: "service-role-key",
      GREENHOUSE_ACTION_CLIENT_ID: "http-client",
      GREENHOUSE_ACTION_RECONCILER_CLIENT_ID: "reconciler-client",
      GREENHOUSE_ACTION_RECONCILER_CLIENT_SECRET: "reconciler-secret",
    }, async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.hostname === "auth.greenhouse.io") {
        tokenMints += 1;
        authorization = new Headers(init.headers).get("authorization");
        return Response.json({
          access_token: "reconciler-token",
          expires_at: "2099-01-01T00:00:00.000Z",
        });
      }
      if (url.hostname.endsWith(".supabase.co")) return Response.json([]);
      assert.fail(`Unexpected reconciliation request: ${url}`);
    });

    assert.deepEqual(result, { actions: [] });
    assert.equal(tokenMints, 1);
    assert.equal(
      authorization,
      `Basic ${Buffer.from("reconciler-client:reconciler-secret").toString("base64")}`,
    );
  });
});
