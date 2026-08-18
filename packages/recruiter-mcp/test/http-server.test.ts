import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSignedSessionToken } from "../src/auth.js";
import { startHttpRecruiterMcp } from "../src/http-server.js";
import { PILOT_TOOL_NAMES } from "../src/tools/register.js";

const STRONG_SESSION_SECRET = "session-secret-value-with-at-least-32-chars";
const STRONG_SCOPE_SIGNING_SECRET = "scope-signing-secret-value-at-least-32-chars";
const READYZ_TOKEN = "readiness-token-value-with-at-least-32-chars";

describe("hosted recruiter MCP HTTP server", () => {
  it("serves liveness without requiring Greenhouse or session credentials", async () => {
    const server = await startHttpRecruiterMcp({ GREENHOUSE_RECRUITER_MCP_PORT: "0" } as NodeJS.ProcessEnv);
    try {
      const response = await fetch(`${baseUrl(server)}/healthz`);
      const body = await response.json() as { ok: boolean; status: string };

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.status, "ok");
    } finally {
      await closeServer(server);
    }
  });

  it("reports the build commit on /healthz and /version so the running sha is visible", async () => {
    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      RENDER_GIT_COMMIT: "abc1234deadbeef",
    } as NodeJS.ProcessEnv);
    try {
      const health = await fetch(`${baseUrl(server)}/healthz`);
      const healthBody = await health.json() as { commit?: string; version?: string };
      assert.equal(health.status, 200);
      assert.equal(healthBody.commit, "abc1234deadbeef");
      assert.equal(healthBody.version, "0.1.0");

      const version = await fetch(`${baseUrl(server)}/version`);
      const versionBody = await version.json() as { name?: string; version?: string; commit?: string };
      assert.equal(version.status, 200);
      assert.equal(versionBody.name, "greenhouse-recruiter-mcp");
      assert.equal(versionBody.commit, "abc1234deadbeef");
    } finally {
      await closeServer(server);
    }
  });

  it("applies explicit incoming request timeout configuration", async () => {
    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_RECRUITER_HTTP_HEADERS_TIMEOUT_MS: "7000",
      GREENHOUSE_RECRUITER_HTTP_REQUEST_TIMEOUT_MS: "11000",
      GREENHOUSE_RECRUITER_HTTP_KEEP_ALIVE_TIMEOUT_MS: "3000",
    } as NodeJS.ProcessEnv);
    try {
      assert.equal(server.headersTimeout, 7000);
      assert.equal(server.requestTimeout, 11000);
      assert.equal(server.keepAliveTimeout, 3000);
    } finally {
      await closeServer(server);
    }
  });

  it("rejects invalid hosted endpoint configuration at startup", async () => {
    await assert.rejects(
      () => startHttpRecruiterMcp({ GREENHOUSE_RECRUITER_MCP_PORT: "3333abc" } as NodeJS.ProcessEnv),
      /GREENHOUSE_RECRUITER_MCP_PORT/
    );
    await assert.rejects(
      () => startHttpRecruiterMcp({ GREENHOUSE_RECRUITER_MCP_PORT: "3333 " } as NodeJS.ProcessEnv),
      /GREENHOUSE_RECRUITER_MCP_PORT/
    );
    await assert.rejects(
      () => startHttpRecruiterMcp({
        GREENHOUSE_RECRUITER_MCP_PORT: "0",
        GREENHOUSE_RECRUITER_MCP_PATH: "mcp",
      } as NodeJS.ProcessEnv),
      /GREENHOUSE_RECRUITER_MCP_PATH/
    );
    await assert.rejects(
      () => startHttpRecruiterMcp({
        GREENHOUSE_RECRUITER_MCP_PORT: "0",
        GREENHOUSE_RECRUITER_MCP_PATH: "/mcp ",
      } as NodeJS.ProcessEnv),
      /GREENHOUSE_RECRUITER_MCP_PATH/
    );
    await assert.rejects(
      () => startHttpRecruiterMcp({
        GREENHOUSE_RECRUITER_MCP_PORT: "0",
        GREENHOUSE_RECRUITER_MCP_PATH: "/mcp",
        GREENHOUSE_RECRUITER_HEALTH_PATH: "/mcp",
      } as NodeJS.ProcessEnv),
      /must be distinct routes/
    );
  });

  it("serves custom hosted endpoint paths only when they are distinct valid routes", async () => {
    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_RECRUITER_MCP_PATH: "/greenhouse/mcp",
      GREENHOUSE_RECRUITER_HEALTH_PATH: "/greenhouse/healthz",
      GREENHOUSE_RECRUITER_READY_PATH: "/greenhouse/readyz",
      GREENHOUSE_RECRUITER_READYZ_TOKEN: READYZ_TOKEN,
    } as NodeJS.ProcessEnv);
    try {
      const health = await fetch(`${baseUrl(server)}/greenhouse/healthz`);
      const oldHealth = await fetch(`${baseUrl(server)}/healthz`);
      const ready = await fetch(`${baseUrl(server)}/greenhouse/readyz`, { headers: readyzHeaders() });

      assert.equal(health.status, 200);
      assert.equal(oldHealth.status, 404);
      assert.equal(ready.status, 503);
    } finally {
      await closeServer(server);
    }
  });

  it("rejects invalid incoming request timeout configuration at startup", async () => {
    await assert.rejects(
      () => startHttpRecruiterMcp({
        GREENHOUSE_RECRUITER_MCP_PORT: "0",
        GREENHOUSE_RECRUITER_HTTP_HEADERS_TIMEOUT_MS: "12000",
        GREENHOUSE_RECRUITER_HTTP_REQUEST_TIMEOUT_MS: "10000",
      } as NodeJS.ProcessEnv),
      /HEADERS_TIMEOUT_MS/
    );
    await assert.rejects(
      () => startHttpRecruiterMcp({
        GREENHOUSE_RECRUITER_MCP_PORT: "0",
        GREENHOUSE_RECRUITER_HTTP_HEADERS_TIMEOUT_MS: "7000 ",
      } as NodeJS.ProcessEnv),
      /HEADERS_TIMEOUT_MS/
    );
  });

  it("returns not-ready readiness when durable-access server config is missing", async () => {
    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_RECRUITER_READYZ_TOKEN: READYZ_TOKEN,
    } as NodeJS.ProcessEnv);
    try {
      const response = await fetch(`${baseUrl(server)}/readyz`, { headers: readyzHeaders() });
      const body = await response.json() as { ok: boolean; status: string; checks: Array<{ name: string; status: string }> };

      assert.equal(response.status, 503);
      assert.equal(body.ok, false);
      assert.equal(body.status, "not_ready");
      assert.ok(body.checks.some((check) => check.name === "session_secret" && check.status === "fail"));
    } finally {
      await closeServer(server);
    }
  });

  it("does not expose detailed readiness when the readiness token is not configured", async () => {
    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
    } as NodeJS.ProcessEnv);
    try {
      const response = await fetch(`${baseUrl(server)}/readyz`);
      const bodyText = await response.text();
      const body = JSON.parse(bodyText) as { ok: boolean; status: string; error: string; checks?: unknown };

      assert.equal(response.status, 503);
      assert.equal(body.ok, false);
      assert.equal(body.status, "not_ready");
      assert.equal(body.error, "readyz_auth_not_configured");
      assert.equal(body.checks, undefined);
      assert.doesNotMatch(bodyText, /GREENHOUSE_RECRUITER_SESSION_SECRET|session-secret-value/);
    } finally {
      await closeServer(server);
    }
  });

  it("requires the separate readiness bearer token for detailed readiness", async () => {
    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_RECRUITER_READYZ_TOKEN: READYZ_TOKEN,
    } as NodeJS.ProcessEnv);
    try {
      const missing = await fetch(`${baseUrl(server)}/readyz`);
      const wrong = await fetch(`${baseUrl(server)}/readyz`, { headers: readyzHeaders("wrong-readiness-token-value-with-at-least-32-chars") });

      assert.equal(missing.status, 401);
      assert.equal((await missing.json() as { error: string }).error, "readyz_unauthorized");
      assert.equal(wrong.status, 401);
      assert.equal((await wrong.json() as { error: string }).error, "readyz_unauthorized");
    } finally {
      await closeServer(server);
    }
  });

  it("treats a readiness token with surrounding whitespace as not configured", async () => {
    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_RECRUITER_READYZ_TOKEN: ` ${READYZ_TOKEN} `,
    } as NodeJS.ProcessEnv);
    try {
      const response = await fetch(`${baseUrl(server)}/readyz`, { headers: readyzHeaders() });
      const body = await response.json() as { ok: boolean; status: string; error: string };

      assert.equal(response.status, 503);
      assert.equal(body.ok, false);
      assert.equal(body.status, "not_ready");
      assert.equal(body.error, "readyz_auth_not_configured");
    } finally {
      await closeServer(server);
    }
  });

  it("returns ready readiness for server-side durable session and identity config", async () => {
    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_CLIENT_ID: "client-id-value",
      GREENHOUSE_CLIENT_SECRET: "client-secret-value",
      GREENHOUSE_RECRUITER_STATE_BACKEND: "supabase_postgrest",
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
      GREENHOUSE_RECRUITER_SCOPE_SIGNING_SECRET: STRONG_SCOPE_SIGNING_SECRET,
      GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
      GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY: "service-role-key-value",
      GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
      GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY: "revocation-key-value",
      GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH: "/secure/greenhouse-recruiter-audit.jsonl",
      GREENHOUSE_RECRUITER_AUDIT_DURABLE_MOUNT_PATH: "/secure",
      GREENHOUSE_RECRUITER_CORS_ORIGIN: "https://chatgpt.com,https://claude.ai",
      GREENHOUSE_RECRUITER_ALLOWED_TOOLS: PILOT_TOOL_NAMES.join(","),
      GREENHOUSE_RECRUITER_READYZ_TOKEN: READYZ_TOKEN,
    } as NodeJS.ProcessEnv);
    try {
      const response = await fetch(`${baseUrl(server)}/readyz`, { headers: readyzHeaders() });
      const bodyText = await response.text();
      const body = JSON.parse(bodyText) as { ok: boolean; status: string };

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.status, "ready");
      assert.doesNotMatch(bodyText, /client-secret-value|session-secret-value|scope-signing-secret-value/);
    } finally {
      await closeServer(server);
    }
  });

  it("returns not-ready readiness when hosted env contains a desktop session token", async () => {
    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_CLIENT_ID: "client-id-value",
      GREENHOUSE_CLIENT_SECRET: "client-secret-value",
      GREENHOUSE_RECRUITER_STATE_BACKEND: "supabase_postgrest",
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
      GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
      GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY: "service-role-key-value",
      GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
      GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY: "revocation-key-value",
      GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH: "/secure/greenhouse-recruiter-audit.jsonl",
      GREENHOUSE_RECRUITER_AUDIT_DURABLE_MOUNT_PATH: "/secure",
      GREENHOUSE_RECRUITER_SESSION_TOKEN: "durable-user-token",
      GREENHOUSE_RECRUITER_READYZ_TOKEN: READYZ_TOKEN,
    } as NodeJS.ProcessEnv);
    try {
      const response = await fetch(`${baseUrl(server)}/readyz`, { headers: readyzHeaders() });
      const bodyText = await response.text();
      const body = JSON.parse(bodyText) as { ok: boolean; status: string; checks: Array<{ name: string; status: string }> };

      assert.equal(response.status, 503);
      assert.equal(body.ok, false);
      assert.equal(body.status, "not_ready");
      assert.ok(body.checks.some((check) => check.name === "hosted_env_hygiene" && check.status === "fail"));
      assert.doesNotMatch(bodyText, /durable-user-token/);
    } finally {
      await closeServer(server);
    }
  });

  it("does not route health endpoints through MCP methods", async () => {
    const server = await startHttpRecruiterMcp({ GREENHOUSE_RECRUITER_MCP_PORT: "0" } as NodeJS.ProcessEnv);
    try {
      const response = await fetch(`${baseUrl(server)}/healthz`, { method: "POST" });
      const body = await response.json() as { error: string };

      assert.equal(response.status, 405);
      assert.equal(body.error, "method_not_allowed");
    } finally {
      await closeServer(server);
    }
  });

  it("answers hosted MCP CORS preflight for an allowed desktop origin without requiring a recruiter token", async () => {
    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_RECRUITER_CORS_ORIGIN: "https://chatgpt.com,https://claude.ai",
    } as NodeJS.ProcessEnv);
    try {
      const response = await fetch(`${baseUrl(server)}/mcp`, {
        method: "OPTIONS",
        headers: {
          origin: "https://claude.ai",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization,content-type",
        },
      });

      assert.equal(response.status, 204);
      assert.equal(response.headers.get("access-control-allow-origin"), "https://claude.ai");
      assert.equal(response.headers.get("vary"), "origin");
      assert.match(response.headers.get("access-control-allow-methods") ?? "", /POST/);
      assert.match(response.headers.get("access-control-allow-headers") ?? "", /authorization/);
      assert.equal(response.headers.get("cache-control"), "no-store");
    } finally {
      await closeServer(server);
    }
  });

  it("fails closed when CORS config contains whitespace-padded origins", async () => {
    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_RECRUITER_CORS_ORIGIN: "https://chatgpt.com, https://claude.ai",
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
    } as NodeJS.ProcessEnv);
    try {
      const response = await fetch(`${baseUrl(server)}/mcp`, {
        method: "OPTIONS",
        headers: {
          origin: "https://chatgpt.com",
          "access-control-request-method": "POST",
        },
      });
      const body = await response.json() as { error: string };

      assert.equal(response.status, 403);
      assert.equal(body.error, "cors_origin_not_allowed");
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    } finally {
      await closeServer(server);
    }
  });

  it("denies hosted browser requests from disallowed CORS origins before auth handling", async () => {
    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_RECRUITER_CORS_ORIGIN: "https://chatgpt.com,https://claude.ai",
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
    } as NodeJS.ProcessEnv);
    try {
      const preflight = await fetch(`${baseUrl(server)}/mcp`, {
        method: "OPTIONS",
        headers: {
          origin: "https://unapproved.example.com",
          "access-control-request-method": "POST",
        },
      });
      const body = await preflight.json() as { error: string };

      assert.equal(preflight.status, 403);
      assert.equal(body.error, "cors_origin_not_allowed");
      assert.equal(preflight.headers.get("access-control-allow-origin"), null);
      assert.equal(preflight.headers.get("vary"), "origin");

      const actual = await fetch(`${baseUrl(server)}/mcp`, {
        method: "POST",
        headers: { origin: "https://unapproved.example.com" },
      });
      assert.equal(actual.status, 403);
    } finally {
      await closeServer(server);
    }
  });

  it("denies duplicate Origin headers instead of choosing one", async () => {
    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_RECRUITER_CORS_ORIGIN: "https://chatgpt.com,https://claude.ai",
    } as NodeJS.ProcessEnv);
    try {
      const response = await rawHttpRequest(server, {
        method: "OPTIONS",
        path: "/mcp",
        headers: {
          origin: ["https://chatgpt.com", "https://unapproved.example.com"],
          "access-control-request-method": "POST",
        },
      });

      assert.equal(response.statusCode, 403);
      assert.match(response.body, /cors_origin_not_allowed/);
      assert.equal(response.headers["access-control-allow-origin"], undefined);
    } finally {
      await closeServer(server);
    }
  });

  it("does not honor wildcard CORS origins at runtime", async () => {
    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_RECRUITER_CORS_ORIGIN: "*",
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
    } as NodeJS.ProcessEnv);
    try {
      const preflight = await fetch(`${baseUrl(server)}/mcp`, {
        method: "OPTIONS",
        headers: {
          origin: "https://unapproved.example.com",
          "access-control-request-method": "POST",
        },
      });
      const body = await preflight.json() as { error: string };

      assert.equal(preflight.status, 403);
      assert.equal(body.error, "cors_origin_not_allowed");
      assert.equal(preflight.headers.get("access-control-allow-origin"), null);
    } finally {
      await closeServer(server);
    }
  });

  it("does not honor non-HTTPS CORS origins at runtime", async () => {
    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_RECRUITER_CORS_ORIGIN: "http://localhost:3333",
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
    } as NodeJS.ProcessEnv);
    try {
      const preflight = await fetch(`${baseUrl(server)}/mcp`, {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:3333",
          "access-control-request-method": "POST",
        },
      });
      const body = await preflight.json() as { error: string };

      assert.equal(preflight.status, 403);
      assert.equal(body.error, "cors_origin_not_allowed");
      assert.equal(preflight.headers.get("access-control-allow-origin"), null);
    } finally {
      await closeServer(server);
    }
  });

  it("fails closed when CORS config mixes valid and invalid origins", async () => {
    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_RECRUITER_CORS_ORIGIN: "https://chatgpt.com,http://localhost:3333,https://bad.example.com/path",
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
    } as NodeJS.ProcessEnv);
    try {
      const allowed = await fetch(`${baseUrl(server)}/mcp`, {
        method: "OPTIONS",
        headers: {
          origin: "https://chatgpt.com",
          "access-control-request-method": "POST",
        },
      });
      const invalid = await fetch(`${baseUrl(server)}/mcp`, {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:3333",
          "access-control-request-method": "POST",
        },
      });

      assert.equal(allowed.status, 403);
      assert.equal(allowed.headers.get("access-control-allow-origin"), null);
      assert.equal(invalid.status, 403);
      assert.equal(invalid.headers.get("access-control-allow-origin"), null);
    } finally {
      await closeServer(server);
    }
  });

  it("denies browser-origin MCP traffic when no CORS allowlist is configured", async () => {
    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
    } as NodeJS.ProcessEnv);
    try {
      const response = await fetch(`${baseUrl(server)}/mcp`, {
        method: "POST",
        headers: { origin: "https://chatgpt.com" },
      });
      const body = await response.json() as { error: string };

      assert.equal(response.status, 403);
      assert.equal(body.error, "cors_origin_not_allowed");
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    } finally {
      await closeServer(server);
    }
  });

  it("still requires bearer authorization for hosted MCP calls after preflight", async () => {
    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
    } as NodeJS.ProcessEnv);
    try {
      const response = await fetch(`${baseUrl(server)}/mcp`, { method: "POST" });
      const body = await response.json() as { jsonrpc: string; error: { code: number; message: string }; id: null };

      assert.equal(response.status, 401);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.equal(body.jsonrpc, "2.0");
      assert.equal(body.error.code, -32001);
      assert.match(body.error.message, /session token/i);
    } finally {
      await closeServer(server);
    }
  });

  it("denies a revoked token before read_my_resume can fetch attachment metadata or bytes", async () => {
    const originalFetch = globalThis.fetch;
    let attachmentMetadataFetches = 0;
    let attachmentDownloads = 0;
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://exampleprojectref000.supabase.co/rest/v1/recruiter_mcp_session_revocation")) {
        return new Response(JSON.stringify([{ token_id: "http-server-test-session", status: "revoked" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("https://harvest.greenhouse.io/v3/attachments")) attachmentMetadataFetches += 1;
      if (url.startsWith("https://files.greenhouse.example/resumes/")) attachmentDownloads += 1;
      return originalFetch(input as Parameters<typeof fetch>[0], init);
    }) as typeof fetch;

    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
      ...remoteRevocationEnv(),
    } as NodeJS.ProcessEnv);
    try {
      const response = await fetch(`${baseUrl(server)}/mcp`, {
        method: "POST",
        headers: mcpHeaders(signedRemoteToken()),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "revoked-resume-call",
          method: "tools/call",
          params: { name: "read_my_resume", arguments: { attachment_id: 42 } },
        }),
      });
      const body = await response.json() as {
        id: null;
        error: { code: number; message: string; data: { denialCode: string } };
      };

      assert.equal(response.status, 401);
      assert.equal(body.id, null);
      assert.equal(body.error.code, -32001);
      assert.equal(body.error.data.denialCode, "SESSION_REVOKED");
      assert.equal(attachmentMetadataFetches, 0);
      assert.equal(attachmentDownloads, 0);
    } finally {
      globalThis.fetch = originalFetch;
      await closeServer(server);
    }
  });

  it("aborts an in-flight Greenhouse read when the HTTP client disconnects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-http-disconnect-"));
    const auditPath = join(dir, "audit.jsonl");
    const originalFetch = globalThis.fetch;
    let markUpstreamStarted!: () => void;
    let releaseUpstream: (() => void) | undefined;
    let upstreamWasAborted = false;
    let cleaningUp = false;
    const upstreamStarted = new Promise<void>((resolve) => { markUpstreamStarted = resolve; });
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/rest/v1/recruiter_mcp_session_revocation")) {
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/rest/v1/recruiter_identity_directory")) {
        return new Response(JSON.stringify([{ greenhouse_user_id: 123, status: "resolved" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://auth.greenhouse.io/token") {
        return new Response(JSON.stringify({
          access_token: "test-access-token",
          token_type: "bearer",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.startsWith("https://harvest.greenhouse.io/")) {
        if (cleaningUp) {
          return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
        }
        markUpstreamStarted();
        return await new Promise<Response>((_resolve, reject) => {
          assert.ok(init?.signal instanceof AbortSignal);
          let settled = false;
          releaseUpstream = () => {
            if (settled) return;
            settled = true;
            reject(new DOMException("test cleanup", "AbortError"));
          };
          init.signal.addEventListener("abort", () => {
            upstreamWasAborted = true;
            releaseUpstream?.();
          }, { once: true });
        });
      }
      throw new Error(`unexpected fetch in disconnect test: ${url}`);
    }) as typeof fetch;

    const env = {
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_CLIENT_ID: "client-id-value",
      GREENHOUSE_CLIENT_SECRET: "client-secret-value",
      GREENHOUSE_RECRUITER_STATE_BACKEND: "supabase_postgrest",
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
      GREENHOUSE_RECRUITER_SCOPE_SIGNING_SECRET: STRONG_SCOPE_SIGNING_SECRET,
      GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
      GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY: "identity-key-value",
      GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
      GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY: "revocation-key-value",
      GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH: auditPath,
      GREENHOUSE_RECRUITER_AUDIT_DURABLE_MOUNT_PATH: dir,
    } as NodeJS.ProcessEnv;
    const server = await startHttpRecruiterMcp(env);
    let writableEndedAtClose: boolean | undefined;
    const responseClosed = new Promise<void>((resolve) => {
      server.once("request", (_request, response) => {
        response.once("close", () => {
          writableEndedAtClose = response.writableEnded;
          resolve();
        });
      });
    });
    let closed = false;
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search_my_jobs", arguments: {} },
      });
      let request!: http.ClientRequest;
      const clientSettled = new Promise<void>((resolve) => {
        request = http.request({
          host: "127.0.0.1",
          port: address.port,
          method: "POST",
          path: "/mcp",
          headers: mcpHeaders(signedRemoteToken()),
        }, (response) => {
          response.resume();
          response.once("end", resolve);
        });
        request.once("error", () => resolve());
        request.once("close", () => resolve());
        request.end(body);
      });

      await upstreamStarted;
      request.destroy();
      await clientSettled;
      await responseClosed;
      assert.equal(writableEndedAtClose, false, "the socket closed before a tool response completed");
      assert.equal(upstreamWasAborted, true, "the hosted request signal must abort on premature response close");
      await closeServer(server);
      closed = true;
    } finally {
      cleaningUp = true;
      releaseUpstream?.();
      if (!closed) await closeServer(server);
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects oversized authenticated MCP POST bodies before transport handling", async () => {
    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
      ...remoteRevocationEnv(),
      GREENHOUSE_RECRUITER_MAX_HTTP_BODY_BYTES: "64",
    } as NodeJS.ProcessEnv);
    try {
      const response = await withRevocationLookup([], () => {
        return fetch(`${baseUrl(server)}/mcp`, {
          method: "POST",
          headers: mcpHeaders(signedRemoteToken()),
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { padding: "x".repeat(200) } }),
        });
      });
      const body = await response.json() as { jsonrpc: string; error: { code: number; message: string }; id: null };

      assert.equal(response.status, 413);
      assert.equal(body.jsonrpc, "2.0");
      assert.equal(body.error.code, -32005);
      assert.match(body.error.message, /Maximum allowed size is 64 bytes/);
    } finally {
      await closeServer(server);
    }
  });

  it("rejects malformed authenticated MCP JSON before transport handling", async () => {
    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
      ...remoteRevocationEnv(),
    } as NodeJS.ProcessEnv);
    try {
      const response = await withRevocationLookup([], () => {
        return fetch(`${baseUrl(server)}/mcp`, {
          method: "POST",
          headers: mcpHeaders(signedRemoteToken()),
          body: "{",
        });
      });
      const body = await response.json() as { jsonrpc: string; error: { code: number; message: string }; id: null };

      assert.equal(response.status, 400);
      assert.equal(body.error.code, -32700);
      assert.match(body.error.message, /Invalid JSON/);
    } finally {
      await closeServer(server);
    }
  });

  it("redacts unexpected hosted request failures while returning a correlation id", async () => {
    const originalError = console.error;
    const logs: string[] = [];
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
      ...remoteRevocationEnv(),
      GREENHOUSE_RECRUITER_MAX_HTTP_BODY_BYTES: "not-a-number",
    } as NodeJS.ProcessEnv);
    logs.length = 0;
    try {
      const response = await withRevocationLookup([], () => {
        return fetch(`${baseUrl(server)}/mcp`, {
          method: "POST",
          headers: mcpHeaders(signedRemoteToken()),
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        });
      });
      const bodyText = await response.text();
      const body = JSON.parse(bodyText) as { error: { code: number; message: string; data: { correlationId: string } } };
      const logText = logs.join("\n");

      assert.equal(response.status, 500);
      assert.equal(body.error.code, -32603);
      assert.equal(body.error.message, "Internal server error");
      assert.match(body.error.data.correlationId, /^[0-9a-f-]{36}$/i);
      assert.match(logText, new RegExp(`correlation_id=${body.error.data.correlationId}`));
      assert.match(logText, /error_name=Error/);
      assert.doesNotMatch(`${bodyText}\n${logText}`, /GREENHOUSE_RECRUITER_MAX_HTTP_BODY_BYTES|positive integer|not-a-number/);
    } finally {
      console.error = originalError;
      await closeServer(server);
    }
  });

  it("rejects authenticated MCP POST bodies with unsupported content types", async () => {
    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
      ...remoteRevocationEnv(),
    } as NodeJS.ProcessEnv);
    try {
      const response = await withRevocationLookup([], () => {
        return fetch(`${baseUrl(server)}/mcp`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${signedRemoteToken()}`,
            accept: "application/json, text/event-stream",
            "content-type": "text/plain",
          },
          body: "hello",
        });
      });
      const body = await response.json() as { jsonrpc: string; error: { code: number; message: string }; id: null };

      assert.equal(response.status, 415);
      assert.equal(body.error.code, -32000);
      assert.match(body.error.message, /Content-Type must be application\/json/);
    } finally {
      await closeServer(server);
    }
  });

  it("returns an emergency shutdown denial for MCP traffic while keeping health visible", async () => {
    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_RECRUITER_MCP_DISABLED: "true",
    } as NodeJS.ProcessEnv);
    try {
      const health = await fetch(`${baseUrl(server)}/healthz`);
      const response = await fetch(`${baseUrl(server)}/mcp`, { method: "POST" });
      const body = await response.json() as { jsonrpc: string; error: { code: number; message: string }; id: null };

      assert.equal(health.status, 200);
      assert.equal(response.status, 503);
      assert.equal(body.jsonrpc, "2.0");
      assert.equal(body.error.code, -32004);
      assert.match(body.error.message, /disabled/);
    } finally {
      await closeServer(server);
    }
  });
});

function baseUrl(server: http.Server): string {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function rawHttpRequest(
  server: http.Server,
  options: { method: string; path: string; headers: Record<string, string | string[]> }
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return await new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: address.port,
      method: options.method,
      path: options.path,
      headers: options.headers as http.OutgoingHttpHeaders,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function signedRemoteToken(): string {
  return createSignedSessionToken({
    subject: "email:recruiter@example.com",
    email: "recruiter@example.com",
    surface: "chatgpt_desktop",
    tokenId: "http-server-test-session",
    issuedAt: "2026-06-23T00:00:00.000Z",
  }, STRONG_SESSION_SECRET);
}

function mcpHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
}

function readyzHeaders(token = READYZ_TOKEN): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/json",
  };
}

function remoteRevocationEnv(): Record<string, string> {
  return {
    GREENHOUSE_RECRUITER_STATE_BACKEND: "supabase_postgrest",
    GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
    GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY: "revocation-key-value",
  };
}

async function withRevocationLookup<T>(rows: unknown[], fn: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://exampleprojectref000.supabase.co/rest/v1/recruiter_mcp_session_revocation")) {
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return originalFetch(input as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}
