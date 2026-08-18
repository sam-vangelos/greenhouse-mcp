import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createGreenhouseGateway,
  createGreenhouseGatewayFromEnv,
  createGreenhouseReconcilerGatewayFromEnv,
  GreenhouseError,
} from "../src/greenhouse.js";

function tokenResponse(subject?: number): Response {
  const body = Buffer.from(JSON.stringify({ sub: String(subject ?? "isu") })).toString("base64url");
  return Response.json({ access_token: `header.${body}.signature`, expires_at: "2099-01-01T00:00:00.000Z" });
}

describe("Greenhouse v3 gateway", () => {
  test("sends one owned mutation with the exact body and never retries an ambiguous 5xx", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const gateway = createGreenhouseGateway({
      clientId: "client",
      clientSecret: "secret",
      attributionMode: "service_user",
      fetchImpl: async (input, init = {}) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.includes("auth.greenhouse.io")) return tokenResponse();
        return new Response(null, { status: 503, headers: { "x-request-id": "upstream-1" } });
      },
    });

    await assert.rejects(
      gateway.mutate({ method: "POST", path: "/applications/100/reject", body: { rejection_reason_id: 701 }, actorUserId: 10 }),
      (error: unknown) => error instanceof GreenhouseError
        && error.ambiguous && error.status === 503 && error.requestId === "upstream-1"
    );
    const writes = requests.filter((request) => request.init.method === "POST" && request.url.includes("harvest.greenhouse.io"));
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.url, "https://harvest.greenhouse.io/v3/applications/100/reject");
    assert.deepEqual(JSON.parse(String(writes[0]?.init.body)), { rejection_reason_id: 701 });
  });

  test("treats 408, network failure, and a stalled 2xx body as ambiguous without retry", async () => {
    for (const behavior of ["408", "network", "stalled_2xx"] as const) {
      let writes = 0;
      const gateway = createGreenhouseGateway({
        clientId: "client",
        clientSecret: "secret",
        attributionMode: "service_user",
        mutationTimeoutMs: 20,
        fetchImpl: async (input) => {
          if (String(input).includes("auth.greenhouse.io")) return tokenResponse();
          writes += 1;
          if (behavior === "408") return new Response(null, { status: 408 });
          if (behavior === "network") throw new Error("connection reset");
          return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } }), {
            status: 200,
          });
        },
      });
      await assert.rejects(
        gateway.mutate({ method: "POST", path: "/offers", body: { application_id: 100 }, actorUserId: 10 }),
        (error: unknown) => error instanceof GreenhouseError && error.ambiguous,
        behavior,
      );
      assert.equal(writes, 1, behavior);
    }
  });

  test("refreshes a rejected token once for a supporting read", async () => {
    let tokenMints = 0;
    let reads = 0;
    const authorizations: string[] = [];
    const gateway = createGreenhouseGateway({
      clientId: "client", clientSecret: "secret", attributionMode: "service_user",
      fetchImpl: async (input, init = {}) => {
        if (String(input).includes("auth.greenhouse.io")) {
          tokenMints += 1;
          return Response.json({ access_token: `token-${tokenMints}`, expires_at: "2099-01-01T00:00:00.000Z" });
        }
        reads += 1;
        authorizations.push(new Headers(init.headers).get("authorization") ?? "");
        return reads === 1 ? new Response(null, { status: 401 }) : Response.json([{ id: 1 }]);
      },
    });

    assert.deepEqual(await gateway.list("/users", { ids: "1" }, 10), [{ id: 1 }]);
    assert.equal(tokenMints, 2);
    assert.equal(reads, 2);
    assert.deepEqual(authorizations, ["Bearer token-1", "Bearer token-2"]);
  });

  test("refreshes a rejected token once for a mutation", async () => {
    let tokenMints = 0;
    let writes = 0;
    const gateway = createGreenhouseGateway({
      clientId: "client", clientSecret: "secret", attributionMode: "service_user",
      fetchImpl: async (input) => {
        if (String(input).includes("auth.greenhouse.io")) {
          tokenMints += 1;
          return Response.json({ access_token: `token-${tokenMints}`, expires_at: "2099-01-01T00:00:00.000Z" });
        }
        writes += 1;
        return writes === 1
          ? new Response(null, { status: 401 })
          : Response.json({ id: 100 }, { headers: { "x-request-id": "write-2" } });
      },
    });

    const result = await gateway.mutate({
      method: "PATCH", path: "/applications/100", body: { recruiter_id: 40 }, actorUserId: 10,
    });
    assert.equal(result.status, 200);
    assert.equal(result.requestId, "write-2");
    assert.equal(tokenMints, 2);
    assert.equal(writes, 2);
  });

  test("surfaces a second 401 without another refresh", async () => {
    let tokenMints = 0;
    let reads = 0;
    const gateway = createGreenhouseGateway({
      clientId: "client", clientSecret: "secret", attributionMode: "service_user",
      fetchImpl: async (input) => {
        if (String(input).includes("auth.greenhouse.io")) {
          tokenMints += 1;
          return Response.json({ access_token: `token-${tokenMints}`, expires_at: "2099-01-01T00:00:00.000Z" });
        }
        reads += 1;
        return new Response(null, { status: 401 });
      },
    });

    await assert.rejects(gateway.list("/users", {}, 10), (error: unknown) =>
      error instanceof GreenhouseError && error.status === 401);
    assert.equal(tokenMints, 2);
    assert.equal(reads, 2);
  });

  test("coalesces concurrent token requests in one gateway", async () => {
    let tokenMints = 0;
    const gateway = createGreenhouseGateway({
      clientId: "client", clientSecret: "secret", attributionMode: "service_user",
      fetchImpl: async (input) => {
        if (String(input).includes("auth.greenhouse.io")) {
          tokenMints += 1;
          await new Promise<void>((resolve) => setImmediate(resolve));
          return Response.json({ access_token: "shared-token", expires_at: "2099-01-01T00:00:00.000Z" });
        }
        return Response.json([]);
      },
    });

    await Promise.all(Array.from({ length: 10 }, () => gateway.list("/users", {}, 10)));
    assert.equal(tokenMints, 1);
  });

  test("allows only the catalog's fixed mutation routes", async () => {
    const seen: string[] = [];
    const gateway = createGreenhouseGateway({
      clientId: "client", clientSecret: "secret", attributionMode: "service_user",
      fetchImpl: async (input, init = {}) => {
        const url = String(input);
        if (url.includes("auth.greenhouse.io")) return tokenResponse();
        seen.push(`${init.method} ${new URL(url).pathname}`);
        return Response.json({ id: 999 }, { headers: { "x-request-id": "ok" } });
      },
    });
    const routes = [
      ["PATCH", "/applications/100"],
      ["POST", "/applications/100/move"],
      ["POST", "/applications/100/reject"],
      ["POST", "/applications/100/unreject"],
      ["POST", "/job_owners"],
      ["DELETE", "/job_owners/1"],
      ["POST", "/notes"],
      ["POST", "/job_notes"],
      ["PATCH", "/job_notes/1"],
      ["DELETE", "/job_notes/1"],
      ["PATCH", "/candidates/300"],
      ["POST", "/offers"],
      ["PATCH", "/offers/950"],
    ] as const;
    for (const [method, path] of routes) await gateway.mutate({ method, path, actorUserId: 10, body: { allowed: true } });
    assert.deepEqual(seen, routes.map(([method, path]) => `${method} /v3${path}`));
    await assert.rejects(gateway.mutate({ method: "POST", path: "/applications/100/email", actorUserId: 10 }), /not owned/);
    await assert.rejects(gateway.mutate({ method: "DELETE", path: "/candidates/300", actorUserId: 10 }), /not owned/);
    assert.equal(seen.length, routes.length);
  });

  test("paginates supporting reads only on the Harvest origin", async () => {
    const urls: string[] = [];
    const gateway = createGreenhouseGateway({
      clientId: "client", clientSecret: "secret", attributionMode: "service_user",
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("auth.greenhouse.io")) return tokenResponse();
        urls.push(url);
        if (urls.length === 1) {
          return Response.json([{ id: 1 }], {
            headers: { link: "<https://harvest.greenhouse.io/v3/users?page=2&per_page=1>; rel=next" },
          });
        }
        return Response.json([{ id: 2 }]);
      },
    });
    assert.deepEqual(await gateway.list("/users", { ids: "1,2", fields: "id,name" }, 10), [{ id: 1 }, { id: 2 }]);
    assert.equal(new URL(urls[0]!).searchParams.get("fields"), "id,name");
    assert.equal(urls[1], "https://harvest.greenhouse.io/v3/users?page=2&per_page=1");

    const hostile = createGreenhouseGateway({
      clientId: "client", clientSecret: "secret", attributionMode: "service_user",
      fetchImpl: async (input) => String(input).includes("auth.greenhouse.io") ? tokenResponse() : Response.json([], {
        headers: { link: "<https://attacker.example/v3/users?page=2>; rel=next" },
      }),
    });
    await assert.rejects(hostile.list("/users", {}, 10), /left the Harvest API origin/);
  });

  test("per-human mode reuses the actor-sub token for reads and writes", async () => {
    const tokenBodies: string[] = [];
    const apiAuth: string[] = [];
    const gateway = createGreenhouseGateway({
      clientId: "client", clientSecret: "secret", attributionMode: "per_human",
      fetchImpl: async (input, init = {}) => {
        const url = String(input);
        if (url.includes("auth.greenhouse.io")) {
          tokenBodies.push(String(init.body));
          return tokenResponse(10);
        }
        apiAuth.push(new Headers(init.headers).get("authorization") ?? "");
        return init.method === "GET" ? Response.json([{ id: 100 }]) : Response.json({ id: 100 });
      },
    });
    await gateway.list("/applications", { ids: "100" }, 10);
    await gateway.mutate({ method: "PATCH", path: "/applications/100", body: { recruiter_id: 40 }, actorUserId: 10 });
    assert.deepEqual(tokenBodies, ["grant_type=client_credentials&sub=10"]);
    assert.equal(new Set(apiAuth).size, 1);
    assert.match(apiAuth[0]!, /^Bearer /);
  });

  test("per-human environment mode is closed until the live token probe is attested", () => {
    const base = {
      GREENHOUSE_ACTION_CLIENT_ID: "client",
      GREENHOUSE_ACTION_CLIENT_SECRET: "secret",
      GREENHOUSE_ACTION_ATTRIBUTION_MODE: "per_human",
    } as NodeJS.ProcessEnv;
    assert.throws(() => createGreenhouseGatewayFromEnv(base), /blocked until/);
    assert.doesNotThrow(() => createGreenhouseGatewayFromEnv({
      ...base,
      GREENHOUSE_ACTION_PER_HUMAN_TOKEN_PROBE_PASSED: "true",
    }));
  });

  test("requires a separate OAuth credential for the reconciler", async () => {
    assert.throws(() => createGreenhouseReconcilerGatewayFromEnv({
      GREENHOUSE_ACTION_CLIENT_ID: "http-client",
      GREENHOUSE_ACTION_RECONCILER_CLIENT_SECRET: "reconciler-secret",
    }), /GREENHOUSE_ACTION_RECONCILER_CLIENT_ID is required/);
    assert.throws(() => createGreenhouseReconcilerGatewayFromEnv({
      GREENHOUSE_ACTION_CLIENT_ID: "shared-client",
      GREENHOUSE_ACTION_RECONCILER_CLIENT_ID: "shared-client",
      GREENHOUSE_ACTION_RECONCILER_CLIENT_SECRET: "reconciler-secret",
    }), /different Greenhouse OAuth client ID/);

    let authorization: string | null = null;
    const gateway = createGreenhouseReconcilerGatewayFromEnv({
      GREENHOUSE_ACTION_CLIENT_ID: "http-client",
      GREENHOUSE_ACTION_RECONCILER_CLIENT_ID: "reconciler-client",
      GREENHOUSE_ACTION_RECONCILER_CLIENT_SECRET: "reconciler-secret",
    }, async (_input, init = {}) => {
      authorization = new Headers(init.headers).get("authorization");
      return tokenResponse();
    });
    await gateway.probe();
    assert.equal(
      authorization,
      `Basic ${Buffer.from("reconciler-client:reconciler-secret").toString("base64")}`,
    );
  });
});
