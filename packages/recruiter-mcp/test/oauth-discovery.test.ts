import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startHttpRecruiterMcp } from "../src/http-server.js";

const STRONG_SESSION_SECRET = "session-secret-value-with-at-least-32-chars";
const OAUTH_SIGNING_SECRET = "oauth-signing-secret-value-with-at-least-32-chars";
const ISSUER = "https://recruiter-mcp.example.com";
const RESOURCE_URL = "https://recruiter-mcp.example.com/mcp";

const AS_METADATA_PATH = "/.well-known/oauth-authorization-server";
const PRM_ROOT_PATH = "/.well-known/oauth-protected-resource";
const PRM_MCP_PATH = "/.well-known/oauth-protected-resource/mcp";

interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  client_id_metadata_document_supported: boolean;
  scopes_supported: string[];
}

interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported: string[];
}

function oauthEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    GREENHOUSE_RECRUITER_MCP_PORT: "0",
    GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
    GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS: "example.com",
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

describe("OAuth discovery metadata (slice 1)", () => {
  it("serves RFC 8414 authorization-server metadata with the exact client gates Claude requires", async () => {
    const server = await startHttpRecruiterMcp(oauthEnv());
    try {
      const response = await fetch(`${baseUrl(server)}${AS_METADATA_PATH}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/);
      const body = await response.json() as AuthorizationServerMetadata;

      // issuer must be byte-exact against the configured value (RFC 8414 issuer comparison).
      assert.equal(body.issuer, ISSUER);
      assert.equal(body.authorization_endpoint, `${ISSUER}/authorize`);
      assert.equal(body.token_endpoint, `${ISSUER}/token`);
      assert.deepEqual(body.response_types_supported, ["code"]);
      assert.deepEqual(body.grant_types_supported, ["authorization_code", "refresh_token"]);
      // Hard client gate: absent S256 means Claude refuses the server outright.
      assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
      // Both required together or Claude silently falls back to DCR (which we do not serve).
      assert.deepEqual(body.token_endpoint_auth_methods_supported, ["none"]);
      assert.equal(body.client_id_metadata_document_supported, true);
      // Refresh grants require offline_access advertised.
      assert.ok(body.scopes_supported.includes("offline_access"));
      // No DCR: the deprecated registration endpoint must not be advertised.
      assert.equal((body as unknown as Record<string, unknown>)["registration_endpoint"], undefined);
    } finally {
      await closeServer(server);
    }
  });

  it("serves protected-resource metadata at the /mcp-suffixed well-known path and at the root path", async () => {
    const server = await startHttpRecruiterMcp(oauthEnv());
    try {
      for (const path of [PRM_MCP_PATH, PRM_ROOT_PATH]) {
        const response = await fetch(`${baseUrl(server)}${path}`);
        assert.equal(response.status, 200, `expected 200 at ${path}`);
        const body = await response.json() as ProtectedResourceMetadata;
        // resource must byte-match the canonical URL the connector admin types.
        assert.equal(body.resource, RESOURCE_URL);
        assert.deepEqual(body.authorization_servers, [ISSUER]);
        assert.deepEqual(body.bearer_methods_supported, ["header"]);
        assert.ok(body.scopes_supported.includes("offline_access"));
      }
    } finally {
      await closeServer(server);
    }
  });

  it("answers OPTIONS preflight on the discovery routes when OAuth is on", async () => {
    const server = await startHttpRecruiterMcp(oauthEnv());
    try {
      for (const path of [AS_METADATA_PATH, PRM_MCP_PATH, PRM_ROOT_PATH]) {
        const response = await fetch(`${baseUrl(server)}${path}`, { method: "OPTIONS" });
        assert.equal(response.status, 204, `expected 204 preflight at ${path}`);
      }
    } finally {
      await closeServer(server);
    }
  });

  it("rejects non-GET methods on discovery routes instead of routing them onward", async () => {
    const server = await startHttpRecruiterMcp(oauthEnv());
    try {
      const response = await fetch(`${baseUrl(server)}${AS_METADATA_PATH}`, { method: "POST" });
      const body = await response.json() as { error: string };
      assert.equal(response.status, 405);
      assert.equal(body.error, "method_not_allowed");
    } finally {
      await closeServer(server);
    }
  });

  it("keeps every discovery route dark (byte-identical 404) when no GREENHOUSE_RECRUITER_OAUTH_* env is set", async () => {
    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
      GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS: "example.com",
    } as NodeJS.ProcessEnv);
    try {
      for (const path of [AS_METADATA_PATH, PRM_MCP_PATH, PRM_ROOT_PATH]) {
        const get = await fetch(`${baseUrl(server)}${path}`);
        assert.equal(get.status, 404, `expected 404 at ${path} without OAuth env`);
        assert.deepEqual(await get.json(), { error: "not_found" });
        const options = await fetch(`${baseUrl(server)}${path}`, { method: "OPTIONS" });
        assert.equal(options.status, 404, `expected 404 preflight at ${path} without OAuth env`);
      }
    } finally {
      await closeServer(server);
    }
  });

  it("keeps the routes dark when the OAuth env family is present but incomplete (invalid, not half-mounted)", async () => {
    const server = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
      GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS: "example.com",
      GREENHOUSE_RECRUITER_OAUTH_ISSUER: ISSUER,
    } as NodeJS.ProcessEnv);
    try {
      for (const path of [AS_METADATA_PATH, PRM_MCP_PATH, PRM_ROOT_PATH]) {
        const response = await fetch(`${baseUrl(server)}${path}`);
        assert.equal(response.status, 404, `expected dark route at ${path} on invalid OAuth config`);
      }
    } finally {
      await closeServer(server);
    }
  });

  it("keeps the routes dark when the OAuth signing secret reuses the session secret", async () => {
    const server = await startHttpRecruiterMcp(oauthEnv({
      GREENHOUSE_RECRUITER_OAUTH_SIGNING_SECRET: STRONG_SESSION_SECRET,
    }));
    try {
      const response = await fetch(`${baseUrl(server)}${AS_METADATA_PATH}`);
      assert.equal(response.status, 404);
    } finally {
      await closeServer(server);
    }
  });

  it("refuses env route config that shadows the reserved literal routes", async () => {
    // If startup wrongly succeeds (the pre-fix behavior), close the leaked server so the
    // failing assertion surfaces instead of the leaked listener hanging the test process.
    await assert.rejects(
      () => startedServerIsABug({
        GREENHOUSE_RECRUITER_MCP_PORT: "0",
        GREENHOUSE_RECRUITER_MCP_PATH: "/version",
      } as NodeJS.ProcessEnv),
      /GREENHOUSE_RECRUITER_MCP_PATH/
    );
    await assert.rejects(
      () => startedServerIsABug({
        GREENHOUSE_RECRUITER_MCP_PORT: "0",
        GREENHOUSE_RECRUITER_HEALTH_PATH: "/.well-known/oauth-authorization-server",
      } as NodeJS.ProcessEnv),
      /GREENHOUSE_RECRUITER_HEALTH_PATH/
    );
  });

  it("reserves the OAuth endpoint literals /authorize, /token, /oauth/callback even with OAuth dark (always-on reservation)", async () => {
    // This reservation is NOT gated on the OAuth family — the point R1-E makes explicit. A dark
    // deployment (no OAuth env at all) still refuses to boot if a route env shadows one of these,
    // so the fixed literals can never be stranded by an env path. Only path configs no deployment
    // uses are affected; nothing a live request touches changes.
    for (const reserved of ["/authorize", "/token", "/oauth/callback"]) {
      await assert.rejects(
        () => startedServerIsABug({
          GREENHOUSE_RECRUITER_MCP_PORT: "0",
          GREENHOUSE_RECRUITER_MCP_PATH: reserved,
        } as NodeJS.ProcessEnv),
        /GREENHOUSE_RECRUITER_MCP_PATH/,
        `GREENHOUSE_RECRUITER_MCP_PATH=${reserved} must be refused`,
      );
      await assert.rejects(
        () => startedServerIsABug({
          GREENHOUSE_RECRUITER_MCP_PORT: "0",
          GREENHOUSE_RECRUITER_READY_PATH: reserved,
        } as NodeJS.ProcessEnv),
        /GREENHOUSE_RECRUITER_READY_PATH/,
        `GREENHOUSE_RECRUITER_READY_PATH=${reserved} must be refused`,
      );
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

async function startedServerIsABug(env: NodeJS.ProcessEnv): Promise<void> {
  const server = await startHttpRecruiterMcp(env);
  await closeServer(server);
}
