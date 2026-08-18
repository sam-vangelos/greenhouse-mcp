import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { _resetClientState } from "../../control-plane/dist/client.js";
import { createStaticIdentityDirectory } from "../src/identity.js";
import {
  configureGreenhouseFromEnv,
  createRecruiterOperatorActorIds,
  createProductionScopedReader,
  readPermissionTtlMs,
} from "../src/scoped-reader.js";
import { testSession } from "./test-helpers.js";

describe("production scoped reader configuration", () => {
  it("defaults permission lookup TTL to the bounded 60s (T1.2), with explicit zero and force-zero opt-outs", () => {
    // The timid TTL-0 default was the audit's S2 finding: it re-swept /user_job_permissions on
    // every page for freshness that deactivation doesn't actually provide (contract-verified).
    assert.equal(readPermissionTtlMs({} as NodeJS.ProcessEnv), 60_000);
    assert.equal(readPermissionTtlMs({ GREENHOUSE_RECRUITER_PERMISSION_TTL_MS: "0" } as NodeJS.ProcessEnv), 0);
  });

  it("allows an explicit short permission TTL for controlled pilots", () => {
    assert.equal(readPermissionTtlMs({ GREENHOUSE_RECRUITER_PERMISSION_TTL_MS: "120000" } as NodeJS.ProcessEnv), 120000);
  });

  it("rejects malformed permission TTL env values instead of silently changing freshness", () => {
    assert.throws(
      () => readPermissionTtlMs({ GREENHOUSE_RECRUITER_PERMISSION_TTL_MS: "120000 " } as NodeJS.ProcessEnv),
      /GREENHOUSE_RECRUITER_PERMISSION_TTL_MS must be a non-negative safe integer/
    );
    assert.throws(
      () => readPermissionTtlMs({ GREENHOUSE_RECRUITER_PERMISSION_TTL_MS: "9007199254740993" } as NodeJS.ProcessEnv),
      /GREENHOUSE_RECRUITER_PERMISSION_TTL_MS must be a non-negative safe integer/
    );
  });

  it("lets ops force permission TTL back to zero even when a TTL is configured", () => {
    assert.equal(readPermissionTtlMs({
      GREENHOUSE_RECRUITER_PERMISSION_TTL_MS: "120000",
      GREENHOUSE_RECRUITER_FORCE_PERMISSION_TTL_ZERO: "true",
    } as NodeJS.ProcessEnv), 0);
  });

  it("rejects whitespace-only Greenhouse credentials before configuring the raw client", () => {
    assert.throws(
      () => configureGreenhouseFromEnv({
        GREENHOUSE_CLIENT_ID: "client-id",
        GREENHOUSE_CLIENT_SECRET: "   ",
      } as NodeJS.ProcessEnv),
      /GREENHOUSE_CLIENT_ID and GREENHOUSE_CLIENT_SECRET are required/
    );
    assert.throws(
      () => configureGreenhouseFromEnv({
        GREENHOUSE_CLIENT_ID: "   ",
        GREENHOUSE_CLIENT_SECRET: "client-secret",
      } as NodeJS.ProcessEnv),
      /GREENHOUSE_CLIENT_ID and GREENHOUSE_CLIENT_SECRET are required/
    );
  });

  it("rejects Greenhouse credentials with surrounding whitespace before configuring the raw client", () => {
    assert.throws(
      () => configureGreenhouseFromEnv({
        GREENHOUSE_CLIENT_ID: " client-id",
        GREENHOUSE_CLIENT_SECRET: "client-secret",
      } as NodeJS.ProcessEnv),
      /must not contain leading or trailing whitespace/
    );
    assert.throws(
      () => configureGreenhouseFromEnv({
        GREENHOUSE_CLIENT_ID: "client-id",
        GREENHOUSE_CLIENT_SECRET: "client-secret\n",
      } as NodeJS.ProcessEnv),
      /must not contain leading or trailing whitespace/
    );
  });

  it("rejects malformed operator actor allowlists before enabling unscoped passthrough", () => {
    assert.throws(
      () => createRecruiterOperatorActorIds({ OPERATOR_ACTOR_IDS: "900,nope,-3,901abc" } as NodeJS.ProcessEnv),
      /OPERATOR_ACTOR_IDS must contain only comma-separated positive Greenhouse user ids/
    );
  });

  it("honors OPERATOR_ACTOR_IDS through the production reader bridge", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = fakeGreenhouseFetch(calls);
    try {
      _resetClientState();
      configureGreenhouseFromEnv({
        GREENHOUSE_CLIENT_ID: "client-id",
        GREENHOUSE_CLIENT_SECRET: "client-secret",
      } as NodeJS.ProcessEnv);
      const reader = createProductionScopedReader(identityDirectoryForUser(900), {
        OPERATOR_ACTOR_IDS: "900",
      } as NodeJS.ProcessEnv);

      const result = await reader.scopedRead(testSession(), "list_applications", {});

      assert.equal(result.ok, true);
      assert.equal(result.ok && result.scoped, false);
      assert.deepEqual(result.ok && result.permissionScope, { kind: "operator", permittedJobCount: null });
      assert.deepEqual(result.ok && result.data, [
        { id: 1, jobs: [{ id: 111 }], candidate_id: 501 },
        { id: 2, jobs: [{ id: 222 }], candidate_id: 502 },
      ]);
      assert.equal(calls.some((url) => url.includes("/user_job_permissions")), false);
    } finally {
      globalThis.fetch = originalFetch;
      _resetClientState();
    }
  });

  it("shares the permission cache across reader rebuilds within the TTL (T1.2 singleton)", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = fakeGreenhouseFetch(calls);
    try {
      _resetClientState();
      configureGreenhouseFromEnv({
        GREENHOUSE_CLIENT_ID: "client-id",
        GREENHOUSE_CLIENT_SECRET: "client-secret",
      } as NodeJS.ProcessEnv);
      // The hosted server (and therefore the scoped reader) is rebuilt per request; the
      // permission provider must be a module singleton or the TTL cache dies with each request.
      const env = { GREENHOUSE_RECRUITER_PERMISSION_TTL_MS: "60000" } as NodeJS.ProcessEnv;
      const readerA = createProductionScopedReader(identityDirectoryForUser(900), env);
      const readerB = createProductionScopedReader(identityDirectoryForUser(900), env);

      const first = await readerA.scopedRead(testSession(), "list_applications", {});
      const second = await readerB.scopedRead(testSession(), "list_applications", {});

      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      const permissionSweeps = calls.filter((url) => url.includes("/user_job_permissions")).length;
      assert.equal(
        permissionSweeps,
        1,
        "two reads across two reader instances within the TTL must share ONE permission sweep"
      );
      // The scoping itself must be unchanged by the cache: both reads see only the permitted job.
      assert.deepEqual(second.ok && second.data, [{ id: 1, jobs: [{ id: 111 }], candidate_id: 501 }]);
    } finally {
      globalThis.fetch = originalFetch;
      _resetClientState();
    }
  });

  it("memoizes the WHOLE permission chain per actor, and never across actors", async () => {
    // What the wrapper around the provider buys, and what the provider's own internal cache does
    // not: the site-admin `/users` probe is inside the memoized chain too. And it is keyed per
    // actor — a shared key here would serve one recruiter another recruiter's permitted jobs,
    // which is the worst failure this package can have.
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = fakeMultiActorGreenhouseFetch(calls);
    try {
      _resetClientState();
      configureGreenhouseFromEnv({
        GREENHOUSE_CLIENT_ID: "client-id",
        GREENHOUSE_CLIENT_SECRET: "client-secret",
      } as NodeJS.ProcessEnv);
      // A TTL no other case uses, so this gets its own entry in the module-scoped provider
      // registry instead of inheriting one warmed by another test.
      const env = {
        GREENHOUSE_RECRUITER_PERMISSION_TTL_MS: "45000",
        GREENHOUSE_RECRUITER_READ_CACHE_DISABLED: "true",
      } as NodeJS.ProcessEnv;

      const firstActor = createProductionScopedReader(identityDirectoryForUser(901), env);
      const first = await firstActor.scopedRead(testSession(), "list_applications", {});
      const again = await createProductionScopedReader(identityDirectoryForUser(901), env)
        .scopedRead(testSession(), "list_applications", {});

      assert.deepEqual(first.ok && first.data, [{ id: 1, jobs: [{ id: 111 }], candidate_id: 501 }]);
      assert.deepEqual(again.ok && again.data, [{ id: 1, jobs: [{ id: 111 }], candidate_id: 501 }]);
      assert.equal(countCalls(calls, "/users?"), 1, "the site-admin probe must be inside the memo, not run per read");
      assert.equal(countCalls(calls, "/user_job_permissions"), 1);

      const secondActor = createProductionScopedReader(identityDirectoryForUser(902), env);
      const other = await secondActor.scopedRead(testSession(), "list_applications", {});

      assert.deepEqual(
        other.ok && other.data,
        [{ id: 2, jobs: [{ id: 222 }], candidate_id: 502 }],
        "the second actor must get their OWN scope, never the memoized scope of the first"
      );
      assert.equal(countCalls(calls, "/users?"), 2);
      assert.equal(countCalls(calls, "/user_job_permissions"), 2);
    } finally {
      globalThis.fetch = originalFetch;
      _resetClientState();
    }
  });

  it("scopes the same actor when operator unscoped mode is disabled", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = fakeGreenhouseFetch(calls);
    try {
      _resetClientState();
      configureGreenhouseFromEnv({
        GREENHOUSE_CLIENT_ID: "client-id",
        GREENHOUSE_CLIENT_SECRET: "client-secret",
      } as NodeJS.ProcessEnv);
      const reader = createProductionScopedReader(identityDirectoryForUser(900), {
        OPERATOR_ACTOR_IDS: "900",
        GREENHOUSE_RECRUITER_DISABLE_OPERATOR_UNSCOPED: "true",
        // Explicit TTL 0: this test asserts the permission sweep HAPPENS; the default 60s TTL
        // shares the module-singleton provider with the T1.2 test above and would serve it cached.
        GREENHOUSE_RECRUITER_PERMISSION_TTL_MS: "0",
      } as NodeJS.ProcessEnv);

      const result = await reader.scopedRead(testSession(), "list_applications", {});

      assert.equal(result.ok, true);
      assert.equal(result.ok && result.scoped, true);
      assert.deepEqual(result.ok && result.permissionScope, { kind: "jobs", permittedJobCount: 1 });
      assert.deepEqual(result.ok && result.data, [
        { id: 1, jobs: [{ id: 111 }], candidate_id: 501 },
      ]);
      assert.equal(calls.some((url) => url.includes("/user_job_permissions")), true);
    } finally {
      globalThis.fetch = originalFetch;
      _resetClientState();
    }
  });
});

function identityDirectoryForUser(greenhouseUserId: number) {
  return createStaticIdentityDirectory([
    {
      email: "recruiter@example.com",
      status: "resolved",
      greenhouseUserId,
    },
  ]);
}

function fakeGreenhouseFetch(calls: string[]): typeof fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);

    if (url === "https://auth.greenhouse.io/token") {
      return jsonResponse({
        access_token: "test-access-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }

    const parsed = new URL(url);
    if (parsed.pathname === "/v3/user_job_permissions") {
      assert.equal(parsed.searchParams.get("user_ids"), "900");
      return jsonResponse([{ user_id: 900, job_id: 111 }]);
    }
    if (parsed.pathname === "/v3/applications") {
      return jsonResponse([
        { id: 1, jobs: [{ id: 111 }], candidate_id: 501 },
        { id: 2, jobs: [{ id: 222 }], candidate_id: 502 },
      ]);
    }
    if (parsed.pathname === "/v3/candidates") {
      return jsonResponse(candidatePrivacyRows(parsed));
    }

    return new Response("not found", { status: 404 });
  };
}

// Applications carry `candidate_id` in the v3 default field set, and the scoped reader now resolves
// each kept row's "View Private Candidates" state through it. Neither candidate here is private.
function candidatePrivacyRows(parsed: URL): { id: number; private: boolean }[] {
  return (parsed.searchParams.get("ids") ?? "")
    .split(",")
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)
    .map((id) => ({ id, private: false }));
}

function countCalls(calls: string[], fragment: string): number {
  return calls.filter((url) => url.includes(fragment)).length;
}

// Two actors with disjoint grants, plus the `/v3/users` site-admin probe the wrapper makes per
// actor. Neither user is a site admin, so both fall through to their per-job grants.
function fakeMultiActorGreenhouseFetch(calls: string[]): typeof fetch {
  const permittedJobByUser = new Map<string, number>([["901", 111], ["902", 222]]);
  return async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);

    if (url === "https://auth.greenhouse.io/token") {
      return jsonResponse({
        access_token: "test-access-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }

    const parsed = new URL(url);
    if (parsed.pathname === "/v3/users") {
      const id = parsed.searchParams.get("ids") ?? "";
      return jsonResponse([{ id: Number(id), site_admin: false, deactivated: false }]);
    }
    if (parsed.pathname === "/v3/user_job_permissions") {
      const userId = parsed.searchParams.get("user_ids") ?? "";
      const jobId = permittedJobByUser.get(userId);
      return jsonResponse(jobId === undefined ? [] : [{ user_id: Number(userId), job_id: jobId }]);
    }
    if (parsed.pathname === "/v3/applications") {
      return jsonResponse([
        { id: 1, jobs: [{ id: 111 }], candidate_id: 501 },
        { id: 2, jobs: [{ id: 222 }], candidate_id: 502 },
      ]);
    }
    if (parsed.pathname === "/v3/candidates") {
      return jsonResponse(candidatePrivacyRows(parsed));
    }

    return new Response("not found", { status: 404 });
  };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
