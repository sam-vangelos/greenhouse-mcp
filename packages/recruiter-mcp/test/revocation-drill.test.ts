import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type http from "node:http";
import { createSignedSessionToken } from "../src/auth.js";
import { runSessionRevocationDrill, runSessionRevocationDrillFromEnv } from "../src/revocation-drill.js";
import { startHttpRecruiterMcp } from "../src/http-server.js";

const STRONG_SESSION_SECRET = "session-secret-value-with-at-least-32-chars";

function sessionToken(tokenId: string, client: "claude_desktop_chat" | "claude_code" | "chatgpt_codex_host" = "chatgpt_codex_host"): string {
  const surface = client === "chatgpt_codex_host" ? "chatgpt_desktop" : "claude_desktop";
  return createSignedSessionToken({
    subject: "email:recruiter@example.com",
    email: "recruiter@example.com",
    surface,
    client,
    tokenId,
    issuedAt: "2026-06-23T00:00:00.000Z",
  }, STRONG_SESSION_SECRET);
}

describe("remote session revocation drill", () => {
  it("passes when an active token initializes and a revoked token is denied", async () => {
    const activeToken = sessionToken("active-token-id");
    const revokedToken = sessionToken("revoked-token-id");
    const server = await startHttpRecruiterMcp(serverEnv());
    try {
      const base = baseUrl(server);
      const report = await withRevocationLookup(new Set(["revoked-token-id"]), () => {
        return runSessionRevocationDrill({
          mcpUrl: `${base}/mcp`,
          activeToken,
          revokedToken,
          now: () => new Date("2026-06-23T00:00:00.000Z"),
        });
      });

      assert.equal(report.ok, true);
      assert.equal(report.reportVersion, 2);
      assert.equal(report.status, "pass");
      assert.equal(report.containsTokens, false);
      assert.equal(report.activeSessionTokenId, "active-token-id");
      assert.equal(report.activeSessionClient, "chatgpt_codex_host");
      assert.equal(report.activeSessionIssuedAt, "2026-06-23T00:00:00.000Z");
      assert.equal(report.revokedSessionTokenId, "revoked-token-id");
      assert.equal(report.revokedSessionClient, "chatgpt_codex_host");
      assert.equal(report.revokedSessionIssuedAt, "2026-06-23T00:00:00.000Z");
      assert.deepEqual(report.checks.map((check) => check.status), report.checks.map(() => "pass"));
      assert.equal(JSON.stringify(report).includes(activeToken), false);
      assert.equal(JSON.stringify(report).includes(revokedToken), false);
    } finally {
      await closeServer(server);
    }
  });

  it("preserves exact physical-client attribution for every supported client", async () => {
    for (const client of ["claude_desktop_chat", "claude_code", "chatgpt_codex_host"] as const) {
      let callCount = 0;
      const report = await runSessionRevocationDrill({
        mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
        activeToken: sessionToken(`active-${client}`, client),
        revokedToken: sessionToken(`revoked-${client}`, client),
        fetchImpl: async () => {
          callCount += 1;
          return callCount % 2 === 1
            ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "greenhouse-recruiter-mcp" } } }), { status: 200 })
            : new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { data: { denialCode: "SESSION_REVOKED" } } }), { status: 401 });
        },
      });

      assert.equal(report.ok, true);
      assert.equal(report.activeSessionClient, client);
      assert.equal(report.revokedSessionClient, client);
      assert.equal(report.checks.find((check) => check.name === "matching_client_identity")?.status, "pass");
    }
  });

  it("fails closed when active and revoked tokens belong to different physical clients", async () => {
    let fetchCalls = 0;
    const report = await runSessionRevocationDrill({
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      activeToken: sessionToken("active-claude-desktop", "claude_desktop_chat"),
      revokedToken: sessionToken("revoked-claude-code", "claude_code"),
      fetchImpl: async () => {
        fetchCalls += 1;
        return assert.fail("revocation drill should not fetch for mismatched physical clients") as never;
      },
    });

    assert.equal(fetchCalls, 0);
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((check) => check.name === "matching_client_identity")?.status, "fail");
  });

  it("fails when the revoked token still initializes the remote MCP", async () => {
    const activeToken = sessionToken("active-token-id");
    const revokedToken = sessionToken("revoked-token-id");
    const server = await startHttpRecruiterMcp(serverEnv());
    try {
      const base = baseUrl(server);
      const report = await withRevocationLookup(new Set(), () => {
        return runSessionRevocationDrill({
          mcpUrl: `${base}/mcp`,
          activeToken,
          revokedToken,
          now: () => new Date("2026-06-23T00:00:00.000Z"),
        });
      });

      assert.equal(report.ok, false);
      const revokedCheck = report.checks.find((check) => check.name === "revoked_initialize_denied");
      assert.equal(revokedCheck?.status, "fail");
    } finally {
      await closeServer(server);
    }
  });


  it("fails metadata checks for tokens missing durable issued-at metadata", async () => {
    const payload = Buffer.from(JSON.stringify({
      subject: "email:recruiter@example.com",
      email: "recruiter@example.com",
      surface: "chatgpt_desktop",
      client: "chatgpt_codex_host",
      tokenId: "legacy-token-id",
    }), "utf8").toString("base64url");
    const legacyToken = `${payload}.signature`;
    let fetchCalls = 0;
    const report = await runSessionRevocationDrill({
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      activeToken: legacyToken,
      revokedToken: sessionToken("revoked-token-id"),
      fetchImpl: async () => {
        fetchCalls += 1;
        return assert.fail("revocation drill should not fetch when metadata is incomplete") as never;
      },
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });

    assert.equal(fetchCalls, 0);
    assert.equal(report.ok, false);
    const metadataCheck = report.checks.find((check) => check.name === "active_token_metadata");
    assert.equal(metadataCheck?.status, "fail");
    assert.deepEqual(metadataCheck?.details?.missing, ["issuedAt"]);
  });

  it("fails metadata checks for a legacy token without a physical-client claim", async () => {
    const legacyToken = createRawSignedSessionPayload({
      subject: "email:recruiter@example.com",
      email: "recruiter@example.com",
      surface: "chatgpt_desktop",
      tokenId: "legacy-token-id",
      issuedAt: "2026-06-23T00:00:00.000Z",
    }, STRONG_SESSION_SECRET);
    let fetchCalls = 0;
    const report = await runSessionRevocationDrill({
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      activeToken: legacyToken,
      revokedToken: sessionToken("revoked-token-id"),
      fetchImpl: async () => {
        fetchCalls += 1;
        return assert.fail("revocation drill should not fetch without client attribution") as never;
      },
    });

    assert.equal(fetchCalls, 0);
    assert.deepEqual(report.checks.find((check) => check.name === "active_token_metadata")?.details?.missing, ["client"]);
  });

  it("fails metadata checks for non-exact durable token ids and issued-at timestamps", async () => {
    const activeToken = createRawSignedSessionPayload({
      subject: "email:recruiter@example.com",
      email: "recruiter@example.com",
      surface: "chatgpt_desktop",
      client: "chatgpt_codex_host",
      tokenId: "active-token-id",
      issuedAt: "2026-06-23T00:00:00Z",
    }, STRONG_SESSION_SECRET);
    const revokedToken = createRawSignedSessionPayload({
      subject: "email:recruiter@example.com",
      email: "recruiter@example.com",
      surface: "chatgpt_desktop",
      client: "chatgpt_codex_host",
      tokenId: "revoked token id",
      issuedAt: "2026-06-23T00:00:00.000Z",
    }, STRONG_SESSION_SECRET);
    let fetchCalls = 0;

    const report = await runSessionRevocationDrill({
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      activeToken,
      revokedToken,
      fetchImpl: async () => {
        fetchCalls += 1;
        return assert.fail("revocation drill should not fetch with non-exact token metadata") as never;
      },
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });

    assert.equal(fetchCalls, 0);
    assert.equal(report.ok, false);
    assert.deepEqual(report.checks.find((check) => check.name === "active_token_metadata")?.details?.missing, ["issuedAt"]);
    assert.deepEqual(report.checks.find((check) => check.name === "revoked_token_metadata")?.details?.missing, ["tokenId"]);
  });

  it("loads drill tokens from env and fails closed when either token is missing", async () => {
    let fetchCalls = 0;
    const report = await runSessionRevocationDrillFromEnv({
      GREENHOUSE_RECRUITER_REMOTE_MCP_URL: "https://greenhouse-recruiter.example.com/mcp",
      GREENHOUSE_RECRUITER_ACTIVE_SESSION_TOKEN: sessionToken("active-token-id"),
    } as NodeJS.ProcessEnv, {
      now: () => new Date("2026-06-23T00:00:00.000Z"),
      fetchImpl: async () => {
        fetchCalls += 1;
        return assert.fail("revocation drill should not fetch without both tokens") as never;
      },
    });

    assert.equal(fetchCalls, 0);
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((check) => check.name === "revoked_token_metadata")?.status, "fail");
    assert.equal(report.checks.find((check) => check.name === "revoked_initialize_denied")?.status, "fail");
  });

  it("uses structured denial codes without copying remote JSON-RPC error messages", async () => {
    const activeToken = sessionToken("active-token-id");
    const revokedToken = sessionToken("revoked-token-id");
    const sensitiveMessage = `revoked Authorization: Bearer ${revokedToken} GREENHOUSE_CLIENT_SECRET=client-secret-value`;
    let callCount = 0;

    const report = await runSessionRevocationDrill({
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      activeToken,
      revokedToken,
      fetchImpl: async () => {
        callCount += 1;
        if (callCount === 1) {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { serverInfo: { name: "greenhouse-recruiter-mcp" } },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32001, message: sensitiveMessage, data: { denialCode: "SESSION_REVOKED" } },
        }), { status: 401 });
      },
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });

    const serialized = JSON.stringify(report);
    assert.equal(report.ok, true);
    assert.equal(report.checks.find((check) => check.name === "revoked_initialize_denied")?.status, "pass");
    assert.doesNotMatch(serialized, /Bearer|GREENHOUSE_CLIENT_SECRET|client-secret-value/);
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(activeToken)));
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(revokedToken)));
  });

  it("does not copy non-JSON remote error bodies into failed drill evidence", async () => {
    const activeToken = sessionToken("active-token-id");
    const revokedToken = sessionToken("revoked-token-id");
    let callCount = 0;

    const report = await runSessionRevocationDrill({
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      activeToken,
      revokedToken,
      fetchImpl: async () => {
        callCount += 1;
        if (callCount === 1) {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { serverInfo: { name: "greenhouse-recruiter-mcp" } },
          }), { status: 200 });
        }
        return new Response(`Authorization: Bearer ${revokedToken} GREENHOUSE_CLIENT_SECRET=client-secret-value`, { status: 500 });
      },
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });

    const serialized = JSON.stringify(report);
    const check = report.checks.find((entry) => entry.name === "revoked_initialize_denied");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details, { httpStatus: 500 });
    assert.doesNotMatch(serialized, /Bearer|GREENHOUSE_CLIENT_SECRET|client-secret-value/);
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(activeToken)));
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(revokedToken)));
  });
});

function serverEnv(): NodeJS.ProcessEnv {
  return {
    GREENHOUSE_RECRUITER_MCP_PORT: "0",
    GREENHOUSE_CLIENT_ID: "client-id-value",
    GREENHOUSE_CLIENT_SECRET: "client-secret-value",
    GREENHOUSE_RECRUITER_STATE_BACKEND: "supabase_postgrest",
    GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
    GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
    GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY: "revocation-key-value",
    GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
    GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY: "identity-key-value",
    GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH: "/tmp/greenhouse-recruiter-revocation-drill-audit.jsonl",
    GREENHOUSE_RECRUITER_AUDIT_DURABLE_MOUNT_PATH: "/tmp",
  } as NodeJS.ProcessEnv;
}

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createRawSignedSessionPayload(payload: object, secret: string): string {
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payloadPart).digest("base64url");
  return `${payloadPart}.${signature}`;
}

async function withRevocationLookup<T>(revokedTokenIds: ReadonlySet<string>, fn: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://exampleprojectref000.supabase.co/rest/v1/recruiter_mcp_session_revocation")) {
      const tokenIdFilter = new URL(url).searchParams.get("token_id") ?? "";
      const tokenId = tokenIdFilter.startsWith("eq.") ? tokenIdFilter.slice(3) : "";
      const rows = revokedTokenIds.has(tokenId) ? [{ token_id: tokenId, status: "revoked" }] : [];
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
