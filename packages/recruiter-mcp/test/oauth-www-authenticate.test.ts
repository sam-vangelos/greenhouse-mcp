import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startHttpRecruiterMcp } from "../src/http-server.js";

const STRONG_SESSION_SECRET = "session-secret-value-with-at-least-32-chars";
const OAUTH_SIGNING_SECRET = "oauth-signing-secret-value-with-at-least-32-chars";
const ISSUER = "https://recruiter-mcp.example.com";
const RESOURCE_URL = "https://recruiter-mcp.example.com/mcp";
const EXPECTED_CHALLENGE = `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`;

function oauthEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    GREENHOUSE_RECRUITER_MCP_PORT: "0",
    GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
    GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS: "example.com",
    GREENHOUSE_RECRUITER_STATE_BACKEND: "supabase_postgrest",
    GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
    GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY: "revocation-key-value",
    GREENHOUSE_RECRUITER_OAUTH_SIGNING_SECRET: OAUTH_SIGNING_SECRET,
    GREENHOUSE_RECRUITER_OAUTH_ISSUER: ISSUER,
    GREENHOUSE_RECRUITER_OAUTH_RESOURCE_URL: RESOURCE_URL,
    GREENHOUSE_RECRUITER_OAUTH_GOOGLE_CLIENT_ID: "google-client-id-value.apps.googleusercontent.com",
    GREENHOUSE_RECRUITER_OAUTH_GOOGLE_CLIENT_SECRET: "google-client-secret-value",
    GREENHOUSE_RECRUITER_OAUTH_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
    GREENHOUSE_RECRUITER_OAUTH_SUPABASE_KEY: "oauth-grants-key-value",
    ...extra,
  } as NodeJS.ProcessEnv;
}

describe("WWW-Authenticate challenge on the /mcp 401 (slice 3)", () => {
  it("points an unauthenticated caller at the protected-resource metadata, exactly", async () => {
    const server = await startHttpRecruiterMcp(oauthEnv());
    try {
      const response = await rawHttpRequest(server, {
        method: "POST",
        path: "/mcp",
        headers: { accept: "application/json, text/event-stream" },
      });
      assert.equal(response.statusCode, 401);
      assert.equal(response.headers["www-authenticate"], EXPECTED_CHALLENGE);
      assert.match(response.body, /-32001/);
    } finally {
      await closeServer(server);
    }
  });

  it("carries the challenge on an invalid 3-segment bearer too", async () => {
    const server = await startHttpRecruiterMcp(oauthEnv());
    try {
      const response = await rawHttpRequest(server, {
        method: "POST",
        path: "/mcp",
        headers: {
          authorization: "Bearer aaa.bbb.ccc",
          accept: "application/json, text/event-stream",
        },
      });
      assert.equal(response.statusCode, 401);
      assert.equal(response.headers["www-authenticate"], EXPECTED_CHALLENGE);
    } finally {
      await closeServer(server);
    }
  });

  it("emits no challenge header on an OAuth-less boot (byte-identical legacy 401)", async () => {
    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
      GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS: "example.com",
    } as NodeJS.ProcessEnv);
    try {
      const response = await rawHttpRequest(server, {
        method: "POST",
        path: "/mcp",
        headers: { accept: "application/json, text/event-stream" },
      });
      assert.equal(response.statusCode, 401);
      assert.equal(response.headers["www-authenticate"], undefined);
    } finally {
      await closeServer(server);
    }
  });

  it("emits no challenge header when the OAuth env family is present but invalid (dark, not half-lit)", async () => {
    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
      GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS: "example.com",
      GREENHOUSE_RECRUITER_OAUTH_ISSUER: ISSUER,
    } as NodeJS.ProcessEnv);
    try {
      const response = await rawHttpRequest(server, {
        method: "POST",
        path: "/mcp",
        headers: { accept: "application/json, text/event-stream" },
      });
      assert.equal(response.statusCode, 401);
      assert.equal(response.headers["www-authenticate"], undefined);
    } finally {
      await closeServer(server);
    }
  });
});

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
