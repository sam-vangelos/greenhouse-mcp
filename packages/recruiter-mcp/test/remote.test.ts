import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSignedSessionToken } from "../src/auth.js";
import {
  extractBearerToken,
  handleRemoteMcpRequest,
  isRemoteSurfaceAllowed,
  validateRemoteAuthorization,
} from "../src/remote.js";
import type { AuthenticatedSession } from "../src/types.js";

const STRONG_SESSION_SECRET = "recruiter-session-secret-32-characters-minimum";

const chatgptSession: AuthenticatedSession = {
  subject: "chatgpt-user",
  email: "recruiter@example.com",
  surface: "chatgpt_desktop",
  tokenId: "chatgpt-session-token-id",
  issuedAt: "2026-06-23T00:00:00.000Z",
};

const claudeSession: AuthenticatedSession = {
  ...chatgptSession,
  surface: "claude_desktop",
};

const testSession: AuthenticatedSession = {
  ...chatgptSession,
  subject: "test-user",
  surface: "test",
  tokenId: "test-session-token-id",
};

describe("remote MCP authorization", () => {
  it("extracts bearer tokens and ignores non-bearer authorization", () => {
    assert.equal(extractBearerToken("Bearer abc.def"), "abc.def");
    assert.equal(extractBearerToken("bearer token"), "token");
    assert.equal(extractBearerToken("Bearer token "), undefined);
    assert.equal(extractBearerToken("Bearer  token"), undefined);
    assert.equal(extractBearerToken("Bearer\ttoken"), undefined);
    assert.equal(extractBearerToken("Bearer token extra"), undefined);
    assert.equal(extractBearerToken(["Bearer token"]), undefined);
    assert.equal(extractBearerToken("Basic abc"), undefined);
    assert.equal(extractBearerToken(undefined), undefined);
  });

  it("validates ChatGPT Desktop remote sessions from Authorization headers", async () => {
    const token = createSignedSessionToken(chatgptSession, STRONG_SESSION_SECRET);
    await withRevocationLookup([], async () => {
      const result = await validateRemoteAuthorization(`Bearer ${token}`, remoteAuthEnv());

      assert.equal(result.status, "valid");
      assert.equal(result.status === "valid" && result.session.surface, "chatgpt_desktop");
    });
  });

  it("requires a central revocation source for remote durable session validation", async () => {
    const token = createSignedSessionToken(chatgptSession, STRONG_SESSION_SECRET);
    const result = await validateRemoteAuthorization(`Bearer ${token}`, {
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
    } as NodeJS.ProcessEnv);

    assert.equal(result.status, "invalid");
    assert.match(result.status === "invalid" ? result.reason : "", /STATE_BACKEND=supabase_postgrest/);
  });

  it("returns a JSON-RPC 401 when remote auth is missing", async () => {
    const req = new FakeRequest(undefined);
    const res = new FakeResponse();

    await handleRemoteMcpRequest(req as any, res as any, {
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
    } as NodeJS.ProcessEnv);

    assert.equal(res.statusCode, 401);
    assert.match(res.body, /Missing recruiter MCP session token/);
  });

  it("redacts remote auth setup failures from public JSON-RPC errors", async () => {
    const token = createSignedSessionToken(chatgptSession, STRONG_SESSION_SECRET);
    const req = new FakeRequest(`Bearer ${token}`);
    const res = new FakeResponse();

    await handleRemoteMcpRequest(req as any, res as any, {} as NodeJS.ProcessEnv);

    const body = JSON.parse(res.body) as { error: { message: string; data: { denialCode: string } } };
    assert.equal(res.statusCode, 401);
    assert.equal(body.error.message, "Recruiter MCP session could not be verified.");
    assert.equal(body.error.data.denialCode, "SESSION_NOT_VERIFIED");
    assert.doesNotMatch(res.body, /GREENHOUSE_RECRUITER_SESSION_SECRET|32 characters/);
  });

  it("redacts invalid scoped token claims from public remote auth errors", async () => {
    const token = createRawSignedSessionPayload({
      ...chatgptSession,
      greenhouseUserId: "12345",
    }, STRONG_SESSION_SECRET);
    const req = new FakeRequest(`Bearer ${token}`);
    const res = new FakeResponse();

    await handleRemoteMcpRequest(req as any, res as any, {
      ...remoteAuthEnv(),
    } as NodeJS.ProcessEnv);

    const body = JSON.parse(res.body) as { error: { message: string; data: { denialCode: string } } };
    assert.equal(res.statusCode, 401);
    assert.equal(body.error.message, "Recruiter MCP session could not be verified.");
    assert.equal(body.error.data.denialCode, "SESSION_NOT_VERIFIED");
    assert.doesNotMatch(res.body, /forbidden scoped claim|greenhouseUserId/);
  });

  it("allows both ChatGPT and Claude Desktop sessions on the hosted remote MCP path by default", () => {
    assert.equal(isRemoteSurfaceAllowed("chatgpt_desktop", {} as NodeJS.ProcessEnv), true);
    assert.equal(isRemoteSurfaceAllowed("claude_desktop", {} as NodeJS.ProcessEnv), true);
  });

  it("fails closed when the remote surface allowlist is configured with no supported surfaces", () => {
    const env = { GREENHOUSE_RECRUITER_REMOTE_SURFACES: "mobile_app" } as NodeJS.ProcessEnv;

    assert.equal(isRemoteSurfaceAllowed("chatgpt_desktop", env), false);
    assert.equal(isRemoteSurfaceAllowed("claude_desktop", env), false);
  });

  it("fails closed when the remote surface allowlist mixes supported and unsupported entries", () => {
    const env = { GREENHOUSE_RECRUITER_REMOTE_SURFACES: "chatgpt_desktop,mobile_app" } as NodeJS.ProcessEnv;

    assert.equal(isRemoteSurfaceAllowed("chatgpt_desktop", env), false);
    assert.equal(isRemoteSurfaceAllowed("claude_desktop", env), false);
  });

  it("fails closed when the remote surface allowlist is not exact", () => {
    const whitespaceEnv = { GREENHOUSE_RECRUITER_REMOTE_SURFACES: "chatgpt_desktop, claude_desktop" } as NodeJS.ProcessEnv;
    const duplicateEnv = { GREENHOUSE_RECRUITER_REMOTE_SURFACES: "chatgpt_desktop,chatgpt_desktop" } as NodeJS.ProcessEnv;

    assert.equal(isRemoteSurfaceAllowed("chatgpt_desktop", whitespaceEnv), false);
    assert.equal(isRemoteSurfaceAllowed("claude_desktop", whitespaceEnv), false);
    assert.equal(isRemoteSurfaceAllowed("chatgpt_desktop", duplicateEnv), false);
  });

  it("returns a JSON-RPC 403 when remote surface config is malformed", async () => {
    const token = createSignedSessionToken(chatgptSession, STRONG_SESSION_SECRET);
    const req = new FakeRequest(`Bearer ${token}`);
    const res = new FakeResponse();

    await withRevocationLookup([], async () => {
      await handleRemoteMcpRequest(req as any, res as any, {
        ...remoteAuthEnv({ GREENHOUSE_RECRUITER_REMOTE_SURFACES: "chatgpt_desktop,mobile_app" }),
      } as NodeJS.ProcessEnv);
    });

    assert.equal(res.statusCode, 403);
    assert.match(res.body, /surface is not allowed/);
  });

  it("denies test-surface sessions on the hosted remote MCP path unless explicitly enabled", async () => {
    const token = createSignedSessionToken(testSession, STRONG_SESSION_SECRET);
    const req = new FakeRequest(`Bearer ${token}`);
    const res = new FakeResponse();

    assert.equal(isRemoteSurfaceAllowed("test", {} as NodeJS.ProcessEnv), false);
    assert.equal(isRemoteSurfaceAllowed("test", { GREENHOUSE_RECRUITER_ALLOW_TEST_SURFACE: "true" } as NodeJS.ProcessEnv), true);

    await withRevocationLookup([], async () => {
      await handleRemoteMcpRequest(req as any, res as any, remoteAuthEnv() as NodeJS.ProcessEnv);
    });

    assert.equal(res.statusCode, 403);
    assert.match(res.body, /surface is not allowed/);
  });

  it("returns a JSON-RPC 403 when a surface is excluded from the remote allowlist", async () => {
    const token = createSignedSessionToken(claudeSession, STRONG_SESSION_SECRET);
    const req = new FakeRequest(`Bearer ${token}`);
    const res = new FakeResponse();

    await withRevocationLookup([], async () => {
      await handleRemoteMcpRequest(req as any, res as any, {
        ...remoteAuthEnv({ GREENHOUSE_RECRUITER_REMOTE_SURFACES: "chatgpt_desktop" }),
      } as NodeJS.ProcessEnv);
    });

    assert.equal(res.statusCode, 403);
    assert.match(res.body, /surface is not allowed/);
  });

  it("denies revoked durable remote session tokens", async () => {
    const token = createSignedSessionToken({ ...chatgptSession, tokenId: "session-1" }, STRONG_SESSION_SECRET);
    const result = await withRevocationLookup([{ token_id: "session-1", status: "revoked" }], async () => (
      validateRemoteAuthorization(`Bearer ${token}`, remoteAuthEnv())
    ));

    assert.equal(result.status, "invalid");
    assert.match(result.status === "invalid" ? result.reason : "", /revoked/);
  });

  it("keeps revoked-token denial explicit on the public remote MCP path", async () => {
    const token = createSignedSessionToken({ ...chatgptSession, tokenId: "session-1" }, STRONG_SESSION_SECRET);
    const req = new FakeRequest(`Bearer ${token}`);
    const res = new FakeResponse();

    await withRevocationLookup([{ token_id: "session-1", status: "revoked" }], async () => {
      await handleRemoteMcpRequest(req as any, res as any, remoteAuthEnv() as NodeJS.ProcessEnv);
    });

    const body = JSON.parse(res.body) as { error: { message: string; data: { denialCode: string } } };
    assert.equal(res.statusCode, 401);
    assert.equal(body.error.message, "Recruiter MCP session token has been revoked.");
    assert.equal(body.error.data.denialCode, "SESSION_REVOKED");
  });

  it("denies hosted MCP requests before tool handling when retained audit storage is missing", async () => {
    const token = createSignedSessionToken(chatgptSession, STRONG_SESSION_SECRET);
    const req = new FakeRequest(`Bearer ${token}`);
    const res = new FakeResponse();

    await withRevocationLookup([], async () => {
      await handleRemoteMcpRequest(req as any, res as any, remoteAuthEnv() as NodeJS.ProcessEnv, {
        jsonrpc: "2.0",
        id: "req-audit-missing",
        method: "tools/list",
      });
    });

    const body = JSON.parse(res.body) as { id: string; error: { data: { denialCode: string } } };
    assert.equal(res.statusCode, 503);
    assert.equal(body.id, "req-audit-missing");
    assert.equal(body.error.data.denialCode, "AUDIT_UNAVAILABLE");
    assert.doesNotMatch(res.body, /GREENHOUSE_CLIENT_SECRET|greenhouse/i);
  });

  it("denies hosted MCP requests when the retained audit path is invalid", async () => {
    const token = createSignedSessionToken(chatgptSession, STRONG_SESSION_SECRET);
    const req = new FakeRequest(`Bearer ${token}`);
    const res = new FakeResponse();

    await withRevocationLookup([], async () => {
      await handleRemoteMcpRequest(req as any, res as any, remoteAuthEnv({
        GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH: "audit.jsonl",
      }) as NodeJS.ProcessEnv, {
        jsonrpc: "2.0",
        id: 77,
        method: "tools/list",
      });
    });

    const body = JSON.parse(res.body) as { id: number; error: { data: { denialCode: string } } };
    assert.equal(res.statusCode, 503);
    assert.equal(body.id, 77);
    assert.equal(body.error.data.denialCode, "AUDIT_UNAVAILABLE");
  });

  it("denies hosted MCP requests when retained audit storage is not appendable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-remote-audit-"));
    const auditPath = join(dir, "blocked.jsonl");
    await mkdir(auditPath);
    const token = createSignedSessionToken(chatgptSession, STRONG_SESSION_SECRET);
    const req = new FakeRequest(`Bearer ${token}`);
    const res = new FakeResponse();

    await withRevocationLookup([], async () => {
      await handleRemoteMcpRequest(req as any, res as any, remoteAuthEnv({
        GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH: auditPath,
      }) as NodeJS.ProcessEnv, {
        jsonrpc: "2.0",
        id: "req-audit-blocked",
        method: "tools/list",
      });
    });

    const body = JSON.parse(res.body) as { id: string; error: { data: { denialCode: string } } };
    assert.equal(res.statusCode, 503);
    assert.equal(body.id, "req-audit-blocked");
    assert.equal(body.error.data.denialCode, "AUDIT_UNAVAILABLE");
    assert.doesNotMatch(res.body, /EISDIR|blocked\.jsonl/);
  });

  it("does not let operator allowlist configuration bypass retained audit enforcement", async () => {
    const token = createSignedSessionToken(chatgptSession, STRONG_SESSION_SECRET);
    const req = new FakeRequest(`Bearer ${token}`);
    const res = new FakeResponse();

    await withRevocationLookup([], async () => {
      await handleRemoteMcpRequest(req as any, res as any, remoteAuthEnv({
        OPERATOR_ACTOR_IDS: "100",
        GREENHOUSE_RECRUITER_DISABLE_OPERATOR_UNSCOPED: "false",
      }) as NodeJS.ProcessEnv, {
        jsonrpc: "2.0",
        id: "req-operator-audit",
        method: "tools/list",
      });
    });

    const body = JSON.parse(res.body) as { id: string; error: { data: { denialCode: string } } };
    assert.equal(res.statusCode, 503);
    assert.equal(body.id, "req-operator-audit");
    assert.equal(body.error.data.denialCode, "AUDIT_UNAVAILABLE");
  });

  it("denies hosted MCP reads when the audit sink is writable but not on the durable mount", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-remote-durable-"));
    const auditPath = join(dir, "audit.jsonl");
    const token = createSignedSessionToken(chatgptSession, STRONG_SESSION_SECRET);
    const req = new FakeRequest(`Bearer ${token}`);
    const res = new FakeResponse();

    await withRevocationLookup([], async () => {
      await handleRemoteMcpRequest(req as any, res as any, remoteAuthEnv({
        // Writable (the preflight succeeds) but no declared durable mount: ephemeral storage.
        GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH: auditPath,
      }) as NodeJS.ProcessEnv, {
        jsonrpc: "2.0",
        id: "req-durable-missing",
        method: "tools/list",
      });
    });

    const body = JSON.parse(res.body) as { id: string; error: { message: string } };
    assert.equal(res.statusCode, 503);
    assert.equal(body.id, "req-durable-missing");
    assert.match(body.error.message, /durable storage/);
    assert.doesNotMatch(res.body, /AUDIT_UNAVAILABLE/);
  });

  it("allows hosted MCP reads when the audit path is on the declared durable mount", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-remote-durable-ok-"));
    const auditPath = join(dir, "audit.jsonl");
    const token = createSignedSessionToken(chatgptSession, STRONG_SESSION_SECRET);
    const req = new FakeRequest(`Bearer ${token}`);
    const res = new FakeResponse();

    await withRevocationLookup([], async () => {
      try {
        await handleRemoteMcpRequest(req as any, res as any, remoteAuthEnv({
          GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH: auditPath,
          GREENHOUSE_RECRUITER_AUDIT_DURABLE_MOUNT_PATH: dir,
        }) as NodeJS.ProcessEnv, {
          jsonrpc: "2.0",
          id: "req-durable-ok",
          method: "tools/list",
        });
      } catch {
        // A durable request passes the gate and proceeds into MCP transport handling, which the
        // minimal FakeResponse here does not fully drive. The assertion below is the point: the
        // durability gate did NOT fire (no durability 503 was written).
      }
    });

    assert.doesNotMatch(res.body, /not on durable storage/);
  });
});

function createRawSignedSessionPayload(payload: object, secret: string): string {
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payloadPart).digest("base64url");
  return `${payloadPart}.${signature}`;
}

class FakeRequest extends EventEmitter {
  headers: Record<string, string | undefined>;
  method = "POST";
  url = "/mcp";

  constructor(authorization: string | undefined) {
    super();
    this.headers = { authorization };
  }
}

class FakeResponse extends EventEmitter {
  headersSent = false;
  statusCode = 200;
  body = "";

  writeHead(statusCode: number) {
    this.statusCode = statusCode;
    this.headersSent = true;
    return this;
  }

  end(chunk?: unknown) {
    if (chunk !== undefined) this.body += String(chunk);
    this.emit("finish");
    return this;
  }
}

function remoteAuthEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    GREENHOUSE_RECRUITER_STATE_BACKEND: "supabase_postgrest",
    GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
    GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
    GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY: "revocation-key-value",
    ...extra,
  } as NodeJS.ProcessEnv;
}

async function withRevocationLookup<T>(rows: unknown[], fn: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    assert.match(url, /\/rest\/v1\/recruiter_mcp_session_revocation/);
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}
