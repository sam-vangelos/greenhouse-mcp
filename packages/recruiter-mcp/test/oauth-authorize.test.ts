import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import {
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  createOauthAuthorizeHandlers,
} from "../src/oauth-authorize.js";
import { CLAUDE_CODE_CIMD_URL } from "../src/oauth-clients.js";
import { readOauthAuthorizationConfig } from "../src/oauth-config.js";
import type { OauthGrantRecordInput, OauthGrantStore } from "../src/oauth-grant-store.js";
import type { IdentityDirectory } from "../src/identity.js";
import { startHttpRecruiterMcp } from "../src/http-server.js";

const STRONG_SESSION_SECRET = "session-secret-value-with-at-least-32-chars";
const OAUTH_SIGNING_SECRET = "oauth-signing-secret-value-with-at-least-32-chars";
const ISSUER = "https://recruiter-mcp.example.com";
const RESOURCE_URL = "https://recruiter-mcp.example.com/mcp";
const LOOPBACK_REDIRECT = "http://localhost:53682/callback";
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

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

function requireConfig() {
  const result = readOauthAuthorizationConfig(oauthEnv());
  assert.equal(result.state, "configured");
  if (result.state !== "configured") throw new Error("unreachable");
  return result.config;
}

class FakeResponse {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = "";
  headersSent = false;

  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = String(value);
    return this;
  }

  writeHead(statusCode: number, headers?: Record<string, string>) {
    this.statusCode = statusCode;
    if (headers) {
      for (const [name, value] of Object.entries(headers)) {
        this.headers[name.toLowerCase()] = String(value);
      }
    }
    this.headersSent = true;
    return this;
  }

  end(chunk?: unknown) {
    if (chunk !== undefined) this.body += String(chunk);
    return this;
  }
}

function asServerResponse(res: FakeResponse): ServerResponse {
  return res as unknown as ServerResponse;
}

function authorizeUrl(params: Record<string, string | undefined>): string {
  const url = new URL("http://localhost/authorize");
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  return `${url.pathname}${url.search}`;
}

function defaultAuthorizeParams(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    response_type: "code",
    client_id: CLAUDE_CODE_CIMD_URL,
    redirect_uri: LOOPBACK_REDIRECT,
    state: "client-opaque-state-value",
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: "S256",
    scope: "offline_access",
    ...overrides,
  };
}

interface GrantStoreFake extends OauthGrantStore {
  inserts: OauthGrantRecordInput[];
}

function grantStoreFake(): GrantStoreFake {
  const inserts: OauthGrantRecordInput[] = [];
  return {
    inserts,
    async insertGrant(input) {
      inserts.push(input);
    },
    async consumeGrant() {
      throw new Error("consumeGrant not expected in slice 6");
    },
    async redeemRefresh() {
      throw new Error("redeemRefresh not expected in slice 6");
    },
    async peekRefresh() {
      throw new Error("peekRefresh not expected in slice 6");
    },
    async revokeFamily() {
      throw new Error("revokeFamily not expected in slice 6");
    },
    async revokeGrantsForEmail() {
      throw new Error("revokeGrantsForEmail not expected in slice 6");
    },
  };
}

function resolvedDirectory(): IdentityDirectory {
  return {
    async resolve() {
      return { status: "resolved", greenhouseUserId: 4242 };
    },
  };
}

function unresolvedDirectory(): IdentityDirectory {
  return {
    async resolve() {
      return { status: "unresolved", reason: "Recruiter identity mapping is not resolved." };
    },
  };
}

function buildGoogleIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "stub-key" }), "utf8").toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  // Deliberately unsigned garbage: the callback verifies CLAIMS ONLY, on the trusted direct
  // TLS channel to Google's token endpoint (OIDC Core section 3.1.3.7 topology).
  return `${header}.${payload}.unsigned-garbage-signature`;
}

function googleExchangeFetch(idTokenClaims: (nonce: string | undefined) => Record<string, unknown>): {
  fetchImpl: typeof fetch;
  exchanges: Array<{ url: string; body: string }>;
} {
  const exchanges: Array<{ url: string; body: string }> = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === GOOGLE_TOKEN_ENDPOINT) {
      const body = typeof init?.body === "string" ? init.body : "";
      exchanges.push({ url, body });
      const nonce = undefined;
      return new Response(JSON.stringify({
        access_token: "google-access-token-value",
        token_type: "Bearer",
        id_token: buildGoogleIdToken(idTokenClaims(nonce)),
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch in oauth-authorize test: ${url}`);
  }) as typeof fetch;
  return { fetchImpl, exchanges };
}

async function driveAuthorize(
  handlers: ReturnType<typeof createOauthAuthorizeHandlers>,
  params: Record<string, string | undefined>
): Promise<FakeResponse> {
  const res = new FakeResponse();
  await handlers.handleAuthorize({ method: "GET", url: authorizeUrl(params) }, asServerResponse(res));
  return res;
}

function locationParams(res: FakeResponse): { url: URL; params: URLSearchParams } {
  const location = res.headers["location"];
  assert.ok(location, "expected a Location header");
  const url = new URL(location!);
  return { url, params: url.searchParams };
}

describe("OAuth /authorize and /oauth/callback (slice 6)", () => {
  it("redirects a valid authorization request to Google with a signed, nonce-bound pending state", async () => {
    const handlers = createOauthAuthorizeHandlers(requireConfig(), oauthEnv(), {
      grantStore: grantStoreFake(),
      identityDirectory: resolvedDirectory(),
    });
    const res = await driveAuthorize(handlers, defaultAuthorizeParams());

    assert.equal(res.statusCode, 302);
    const { url, params } = locationParams(res);
    assert.equal(`${url.origin}${url.pathname}`, GOOGLE_AUTHORIZATION_ENDPOINT);
    assert.equal(params.get("client_id"), "google-client-id-value.apps.googleusercontent.com");
    assert.equal(params.get("redirect_uri"), `${ISSUER}/oauth/callback`);
    assert.equal(params.get("response_type"), "code");
    assert.match(params.get("scope") ?? "", /\bopenid\b/);
    assert.match(params.get("scope") ?? "", /\bemail\b/);
    const state = params.get("state");
    assert.ok(state, "pending state must ride in Google's state parameter");
    assert.equal(state!.split(".").length, 2, "pending state is a signed 2-segment blob");
    assert.ok(params.get("nonce"), "the pending flow must be nonce-bound");
  });

  it("refuses to sign in without PKCE S256 — missing or downgraded challenges are invalid_request", async () => {
    const handlers = createOauthAuthorizeHandlers(requireConfig(), oauthEnv(), {
      grantStore: grantStoreFake(),
      identityDirectory: resolvedDirectory(),
    });

    const missing = await driveAuthorize(handlers, defaultAuthorizeParams({ code_challenge: undefined, code_challenge_method: undefined }));
    assert.equal(missing.statusCode, 302);
    const missingParams = locationParams(missing).params;
    assert.equal(missingParams.get("error"), "invalid_request");
    assert.equal(missingParams.get("state"), "client-opaque-state-value");

    const plain = await driveAuthorize(handlers, defaultAuthorizeParams({ code_challenge_method: "plain" }));
    assert.equal(locationParams(plain).params.get("error"), "invalid_request");
  });

  it("enforces RFC 8707 resource when present, and proceeds when absent", async () => {
    const handlers = createOauthAuthorizeHandlers(requireConfig(), oauthEnv(), {
      grantStore: grantStoreFake(),
      identityDirectory: resolvedDirectory(),
    });

    const wrong = await driveAuthorize(handlers, defaultAuthorizeParams({ resource: "https://other.example.com/mcp" }));
    assert.equal(locationParams(wrong).params.get("error"), "invalid_target");

    const matching = await driveAuthorize(handlers, defaultAuthorizeParams({ resource: RESOURCE_URL }));
    assert.equal(matching.statusCode, 302);
    assert.match(locationParams(matching).url.origin, /accounts\.google\.com/);

    const absent = await driveAuthorize(handlers, defaultAuthorizeParams());
    assert.equal(absent.statusCode, 302);
    assert.match(locationParams(absent).url.origin, /accounts\.google\.com/);
  });

  it("answers an unknown client or unvalidated redirect with a direct 400 — never a redirect", async () => {
    const handlers = createOauthAuthorizeHandlers(requireConfig(), oauthEnv(), {
      grantStore: grantStoreFake(),
      identityDirectory: resolvedDirectory(),
    });

    const badClient = await driveAuthorize(handlers, defaultAuthorizeParams({ client_id: "https://evil.example.com/metadata" }));
    assert.equal(badClient.statusCode, 400);
    assert.equal(badClient.headers["location"], undefined);
    assert.match(badClient.body, /invalid_client/);

    const badRedirect = await driveAuthorize(handlers, defaultAuthorizeParams({ redirect_uri: "https://evil.example.com/callback" }));
    assert.equal(badRedirect.statusCode, 400);
    assert.equal(badRedirect.headers["location"], undefined);
  });

  it("completes the callback: exchanges the Google code, verifies claims, writes ONE code grant, redirects with client state", async () => {
    const config = requireConfig();
    const store = grantStoreFake();
    let issuedNonce: string | undefined;
    const { fetchImpl, exchanges } = googleExchangeFetch(() => ({
      iss: "https://accounts.google.com",
      aud: "google-client-id-value.apps.googleusercontent.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce: issuedNonce,
      email: "Recruiter@Example.com",
      email_verified: true,
      sub: "google-subject-1",
    }));
    const handlers = createOauthAuthorizeHandlers(config, oauthEnv(), {
      grantStore: store,
      identityDirectory: resolvedDirectory(),
      fetchImpl,
    });

    const authorize = await driveAuthorize(handlers, defaultAuthorizeParams());
    const googleParams = locationParams(authorize).params;
    issuedNonce = googleParams.get("nonce") ?? undefined;
    const pendingState = googleParams.get("state")!;

    const res = new FakeResponse();
    await handlers.handleCallback({
      method: "GET",
      url: `/oauth/callback?code=google-authorization-code&state=${encodeURIComponent(pendingState)}`,
    }, asServerResponse(res));

    assert.equal(exchanges.length, 1);
    assert.match(exchanges[0]!.body, /code=google-authorization-code/);
    assert.match(exchanges[0]!.body, /grant_type=authorization_code/);
    assert.match(exchanges[0]!.body, /client_secret=google-client-secret-value/);

    assert.equal(res.statusCode, 302);
    const { url, params } = locationParams(res);
    assert.equal(`${url.protocol}//${url.host}${url.pathname}`, LOOPBACK_REDIRECT);
    assert.equal(params.get("state"), "client-opaque-state-value");
    const code = params.get("code");
    assert.ok(code, "the one-time authorization code must ride back to the client");

    assert.equal(store.inserts.length, 1);
    const grant = store.inserts[0]!;
    assert.equal(grant.kind, "code");
    assert.equal(grant.secret, code);
    assert.equal(grant.email, "recruiter@example.com");
    assert.equal(grant.client, "claude_code");
    assert.equal(grant.surface, "claude_desktop");
    assert.equal(grant.codeChallenge, CODE_CHALLENGE);
    assert.equal(grant.redirectUri, LOOPBACK_REDIRECT);
    assert.equal(grant.resource, RESOURCE_URL);
    assert.equal(grant.clientId, CLAUDE_CODE_CIMD_URL);
  });

  it("denies an unverified email with access_denied and ZERO grant writes", async () => {
    const config = requireConfig();
    const store = grantStoreFake();
    let issuedNonce: string | undefined;
    const { fetchImpl } = googleExchangeFetch(() => ({
      iss: "https://accounts.google.com",
      aud: "google-client-id-value.apps.googleusercontent.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce: issuedNonce,
      email: "recruiter@example.com",
      email_verified: false,
      sub: "google-subject-1",
    }));
    const handlers = createOauthAuthorizeHandlers(config, oauthEnv(), {
      grantStore: store,
      identityDirectory: resolvedDirectory(),
      fetchImpl,
    });

    const authorize = await driveAuthorize(handlers, defaultAuthorizeParams());
    const googleParams = locationParams(authorize).params;
    issuedNonce = googleParams.get("nonce") ?? undefined;
    const pendingState = googleParams.get("state")!;

    const res = new FakeResponse();
    await handlers.handleCallback({
      method: "GET",
      url: `/oauth/callback?code=google-authorization-code&state=${encodeURIComponent(pendingState)}`,
    }, asServerResponse(res));

    assert.equal(res.statusCode, 302);
    const params = locationParams(res).params;
    assert.equal(params.get("error"), "access_denied");
    assert.equal(params.get("code"), null);
    assert.equal(store.inserts.length, 0, "an unverified email must write NO grants");
  });

  it("denies a non-resolved recruiter with access_denied and ZERO grant writes (email-session gate verbatim)", async () => {
    const config = requireConfig();
    const store = grantStoreFake();
    let issuedNonce: string | undefined;
    const { fetchImpl } = googleExchangeFetch(() => ({
      iss: "https://accounts.google.com",
      aud: "google-client-id-value.apps.googleusercontent.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce: issuedNonce,
      email: "stranger@example.com",
      email_verified: true,
      sub: "google-subject-2",
    }));
    const handlers = createOauthAuthorizeHandlers(config, oauthEnv(), {
      grantStore: store,
      identityDirectory: unresolvedDirectory(),
      fetchImpl,
    });

    const authorize = await driveAuthorize(handlers, defaultAuthorizeParams());
    const googleParams = locationParams(authorize).params;
    issuedNonce = googleParams.get("nonce") ?? undefined;
    const pendingState = googleParams.get("state")!;

    const res = new FakeResponse();
    await handlers.handleCallback({
      method: "GET",
      url: `/oauth/callback?code=google-authorization-code&state=${encodeURIComponent(pendingState)}`,
    }, asServerResponse(res));

    assert.equal(res.statusCode, 302);
    const params = locationParams(res).params;
    assert.equal(params.get("error"), "access_denied");
    assert.equal(params.get("state"), "client-opaque-state-value");
    assert.equal(store.inserts.length, 0, "a non-resolved identity must write ZERO grants");
  });

  it("denies a Google email whose domain is not in the allowlist with access_denied and ZERO grant writes (R1-C)", async () => {
    const config = requireConfig();
    const store = grantStoreFake();
    let issuedNonce: string | undefined;
    const { fetchImpl } = googleExchangeFetch(() => ({
      iss: "https://accounts.google.com",
      aud: "google-client-id-value.apps.googleusercontent.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce: issuedNonce,
      email: "recruiter@gmail.com", // domain NOT in the allowlist (example.com)
      email_verified: true,
      sub: "google-subject-1",
    }));
    const handlers = createOauthAuthorizeHandlers(config, oauthEnv(), {
      grantStore: store,
      identityDirectory: resolvedDirectory(),
      fetchImpl,
    });

    const authorize = await driveAuthorize(handlers, defaultAuthorizeParams());
    const googleParams = locationParams(authorize).params;
    issuedNonce = googleParams.get("nonce") ?? undefined;
    const pendingState = googleParams.get("state")!;

    const res = new FakeResponse();
    await handlers.handleCallback({
      method: "GET",
      url: `/oauth/callback?code=google-authorization-code&state=${encodeURIComponent(pendingState)}`,
    }, asServerResponse(res));

    assert.equal(res.statusCode, 302);
    assert.equal(locationParams(res).params.get("error"), "access_denied");
    assert.equal(store.inserts.length, 0, "a disallowed email domain must reach the directory NEVER and write ZERO grants");
  });

  it("denies a Google hosted-domain (hd) outside the allowlist even when the email domain is allowed (R1-C)", async () => {
    const config = requireConfig();
    const store = grantStoreFake();
    let issuedNonce: string | undefined;
    const { fetchImpl } = googleExchangeFetch(() => ({
      iss: "https://accounts.google.com",
      aud: "google-client-id-value.apps.googleusercontent.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce: issuedNonce,
      email: "recruiter@example.com", // allowed domain
      email_verified: true,
      hd: "contractor.example.org", // but the Workspace hosted domain is NOT allowed
      sub: "google-subject-1",
    }));
    const handlers = createOauthAuthorizeHandlers(config, oauthEnv(), {
      grantStore: store,
      identityDirectory: resolvedDirectory(),
      fetchImpl,
    });

    const authorize = await driveAuthorize(handlers, defaultAuthorizeParams());
    const googleParams = locationParams(authorize).params;
    issuedNonce = googleParams.get("nonce") ?? undefined;
    const pendingState = googleParams.get("state")!;

    const res = new FakeResponse();
    await handlers.handleCallback({
      method: "GET",
      url: `/oauth/callback?code=google-authorization-code&state=${encodeURIComponent(pendingState)}`,
    }, asServerResponse(res));

    assert.equal(res.statusCode, 302);
    assert.equal(locationParams(res).params.get("error"), "access_denied");
    assert.equal(store.inserts.length, 0, "a disallowed hosted domain must write ZERO grants");
  });

  it("rejects a nonce-mismatched ID token (flow binding) with no grant writes", async () => {
    const config = requireConfig();
    const store = grantStoreFake();
    const { fetchImpl } = googleExchangeFetch(() => ({
      iss: "https://accounts.google.com",
      aud: "google-client-id-value.apps.googleusercontent.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce: "a-nonce-from-some-other-flow",
      email: "recruiter@example.com",
      email_verified: true,
      sub: "google-subject-1",
    }));
    const handlers = createOauthAuthorizeHandlers(config, oauthEnv(), {
      grantStore: store,
      identityDirectory: resolvedDirectory(),
      fetchImpl,
    });

    const authorize = await driveAuthorize(handlers, defaultAuthorizeParams());
    const pendingState = locationParams(authorize).params.get("state")!;

    const res = new FakeResponse();
    await handlers.handleCallback({
      method: "GET",
      url: `/oauth/callback?code=google-authorization-code&state=${encodeURIComponent(pendingState)}`,
    }, asServerResponse(res));

    assert.equal(res.statusCode, 302);
    assert.equal(locationParams(res).params.get("error"), "invalid_request");
    assert.equal(store.inserts.length, 0);
  });

  it("rejects a wrong-audience ID token with no grant writes", async () => {
    const config = requireConfig();
    const store = grantStoreFake();
    let issuedNonce: string | undefined;
    const { fetchImpl } = googleExchangeFetch(() => ({
      iss: "https://accounts.google.com",
      aud: "a-different-google-client.apps.googleusercontent.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce: issuedNonce,
      email: "recruiter@example.com",
      email_verified: true,
      sub: "google-subject-1",
    }));
    const handlers = createOauthAuthorizeHandlers(config, oauthEnv(), {
      grantStore: store,
      identityDirectory: resolvedDirectory(),
      fetchImpl,
    });

    const authorize = await driveAuthorize(handlers, defaultAuthorizeParams());
    const googleParams = locationParams(authorize).params;
    issuedNonce = googleParams.get("nonce") ?? undefined;
    const pendingState = googleParams.get("state")!;

    const res = new FakeResponse();
    await handlers.handleCallback({
      method: "GET",
      url: `/oauth/callback?code=google-authorization-code&state=${encodeURIComponent(pendingState)}`,
    }, asServerResponse(res));

    assert.equal(res.statusCode, 302);
    assert.equal(locationParams(res).params.get("error"), "invalid_request");
    assert.equal(store.inserts.length, 0);
  });

  it("refuses a tampered or expired pending state with a direct 400 and no writes", async () => {
    const config = requireConfig();
    const store = grantStoreFake();
    const handlers = createOauthAuthorizeHandlers(config, oauthEnv(), {
      grantStore: store,
      identityDirectory: resolvedDirectory(),
    });

    const tampered = new FakeResponse();
    await handlers.handleCallback({
      method: "GET",
      url: "/oauth/callback?code=x&state=dGFtcGVyZWQ.dGFtcGVyZWQ",
    }, asServerResponse(tampered));
    assert.equal(tampered.statusCode, 400);
    assert.equal(tampered.headers["location"], undefined);

    // Expired: mint the state at T, replay it 11 minutes later.
    let nowMs = Date.parse("2026-08-18T12:00:00.000Z");
    const expiring = createOauthAuthorizeHandlers(config, oauthEnv(), {
      grantStore: store,
      identityDirectory: resolvedDirectory(),
      now: () => nowMs,
    });
    const authorize = await driveAuthorize(expiring, defaultAuthorizeParams());
    const pendingState = locationParams(authorize).params.get("state")!;
    nowMs += 11 * 60 * 1000;
    const expired = new FakeResponse();
    await expiring.handleCallback({
      method: "GET",
      url: `/oauth/callback?code=x&state=${encodeURIComponent(pendingState)}`,
    }, asServerResponse(expired));
    assert.equal(expired.statusCode, 400);
    assert.equal(store.inserts.length, 0);
  });

  it("relays a Google-side denial as access_denied without calling the token endpoint", async () => {
    const config = requireConfig();
    const store = grantStoreFake();
    const fetchCalls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      fetchCalls.push(url);
      throw new Error("no fetch expected");
    }) as typeof fetch;
    const handlers = createOauthAuthorizeHandlers(config, oauthEnv(), {
      grantStore: store,
      identityDirectory: resolvedDirectory(),
      fetchImpl,
    });

    const authorize = await driveAuthorize(handlers, defaultAuthorizeParams());
    const pendingState = locationParams(authorize).params.get("state")!;

    const res = new FakeResponse();
    await handlers.handleCallback({
      method: "GET",
      url: `/oauth/callback?error=access_denied&state=${encodeURIComponent(pendingState)}`,
    }, asServerResponse(res));

    assert.equal(res.statusCode, 302);
    assert.equal(locationParams(res).params.get("error"), "access_denied");
    assert.equal(fetchCalls.length, 0);
    assert.equal(store.inserts.length, 0);
  });

  it("mounts /authorize on the real server when OAuth is on, and keeps it dark otherwise (additivity)", async () => {
    const configured = await startHttpRecruiterMcp(oauthEnv());
    try {
      const address = configured.address();
      assert.ok(address && typeof address === "object");
      const base = `http://127.0.0.1:${address.port}`;
      const params = new URLSearchParams({
        response_type: "code",
        client_id: CLAUDE_CODE_CIMD_URL,
        redirect_uri: LOOPBACK_REDIRECT,
        state: "s",
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: "S256",
      });
      const response = await fetch(`${base}/authorize?${params}`, { redirect: "manual" });
      assert.equal(response.status, 302);
      assert.match(response.headers.get("location") ?? "", /accounts\.google\.com/);
    } finally {
      await new Promise<void>((resolve, reject) => configured.close((e) => e ? reject(e) : resolve()));
    }

    const dark = await startHttpRecruiterMcp({
      GREENHOUSE_RECRUITER_MCP_PORT: "0",
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
      GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS: "example.com",
    } as NodeJS.ProcessEnv);
    try {
      const address = dark.address();
      assert.ok(address && typeof address === "object");
      const base = `http://127.0.0.1:${address.port}`;
      for (const path of ["/authorize", "/oauth/callback"]) {
        const response = await fetch(`${base}${path}`);
        assert.equal(response.status, 404, `${path} must stay dark without OAuth env`);
        assert.deepEqual(await response.json(), { error: "not_found" });
      }
    } finally {
      await new Promise<void>((resolve, reject) => dark.close((e) => e ? reject(e) : resolve()));
    }
  });
});

// R1-D: locks for correct-but-untested security checks the mutation pass found unguarded.
async function driveSignInCallback(opts: {
  claims: (nonce: string | undefined) => Record<string, unknown>;
  directory?: IdentityDirectory;
}): Promise<{ res: FakeResponse; store: GrantStoreFake; googleCalls: number }> {
  const config = requireConfig();
  const store = grantStoreFake();
  let issuedNonce: string | undefined;
  const { fetchImpl, exchanges } = googleExchangeFetch(() => opts.claims(issuedNonce));
  const handlers = createOauthAuthorizeHandlers(config, oauthEnv(), {
    grantStore: store,
    identityDirectory: opts.directory ?? resolvedDirectory(),
    fetchImpl,
  });
  const authorize = await driveAuthorize(handlers, defaultAuthorizeParams());
  const googleParams = locationParams(authorize).params;
  issuedNonce = googleParams.get("nonce") ?? undefined;
  const pendingState = googleParams.get("state")!;
  const res = new FakeResponse();
  await handlers.handleCallback({
    method: "GET",
    url: `/oauth/callback?code=google-authorization-code&state=${encodeURIComponent(pendingState)}`,
  }, asServerResponse(res));
  return { res, store, googleCalls: exchanges.length };
}

function validClaims(overrides: Record<string, unknown>, nonce: string | undefined): Record<string, unknown> {
  return {
    iss: "https://accounts.google.com",
    aud: "google-client-id-value.apps.googleusercontent.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
    nonce,
    email: "recruiter@example.com",
    email_verified: true,
    sub: "google-subject-1",
    ...overrides,
  };
}

function resolvedWithId(greenhouseUserId: number): IdentityDirectory {
  return { async resolve() { return { status: "resolved", greenhouseUserId }; } };
}

describe("OAuth security-check locks (R1-D)", () => {
  it("denies an ID token with a wrong or absent issuer, ZERO grant writes (T2)", async () => {
    for (const iss of ["https://accounts.evil.example.com", undefined]) {
      const { res, store } = await driveSignInCallback({ claims: (n) => validClaims({ iss }, n) });
      assert.equal(res.statusCode, 302);
      assert.equal(locationParams(res).params.get("error"), "invalid_request");
      assert.equal(locationParams(res).params.get("code"), null);
      assert.equal(store.inserts.length, 0, `iss=${String(iss)} must write ZERO grants`);
    }
  });

  it("denies a past-exp ID token, ZERO grant writes (T3)", async () => {
    const { res, store } = await driveSignInCallback({
      claims: (n) => validClaims({ exp: Math.floor(Date.now() / 1000) - 3600 }, n),
    });
    assert.equal(res.statusCode, 302);
    assert.equal(locationParams(res).params.get("error"), "invalid_request");
    assert.equal(store.inserts.length, 0);
  });

  it("refuses a pending state whose signature is altered by one character — direct 400, no redirect, no writes (signature gate)", async () => {
    const config = requireConfig();
    const store = grantStoreFake();
    const handlers = createOauthAuthorizeHandlers(config, oauthEnv(), { grantStore: store, identityDirectory: resolvedDirectory() });
    const authorize = await driveAuthorize(handlers, defaultAuthorizeParams());
    const state = locationParams(authorize).params.get("state")!;
    const [payload, signature] = state.split(".");
    const flippedLast = (signature!.slice(-1) === "A" ? "B" : "A");
    const tamperedState = `${payload}.${signature!.slice(0, -1)}${flippedLast}`;

    const res = new FakeResponse();
    await handlers.handleCallback({
      method: "GET",
      url: `/oauth/callback?code=x&state=${encodeURIComponent(tamperedState)}`,
    }, asServerResponse(res));
    assert.equal(res.statusCode, 400, "an altered signature must be a direct 400");
    assert.equal(res.headers["location"], undefined, "a bad signature must never be redirected");
    assert.equal(store.inserts.length, 0);
  });

  it("refuses a well-formed JSON pending state carrying an attacker redirect/challenge but an arbitrary signature (signature gate, not JSON parse)", async () => {
    const config = requireConfig();
    const store = grantStoreFake();
    // No fetch may happen: reaching Google means the signature gate was bypassed.
    const fetchImpl = (async () => { throw new Error("no fetch expected — the forged state must die at the signature gate"); }) as typeof fetch;
    const handlers = createOauthAuthorizeHandlers(config, oauthEnv(), { grantStore: store, identityDirectory: resolvedDirectory(), fetchImpl });

    const forgedPending = {
      clientId: CLAUDE_CODE_CIMD_URL,
      redirectUri: "https://attacker.example.com/steal",
      codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      resource: RESOURCE_URL,
      client: "claude_code",
      surface: "claude_desktop",
      nonce: "attacker-chosen-nonce",
      exp: Math.floor(Date.now() / 1000) + 600,
    };
    const payload = Buffer.from(JSON.stringify(forgedPending), "utf8").toString("base64url");
    const forgedState = `${payload}.this-is-not-a-valid-hmac-signature`;

    const res = new FakeResponse();
    await handlers.handleCallback({
      method: "GET",
      url: `/oauth/callback?code=x&state=${encodeURIComponent(forgedState)}`,
    }, asServerResponse(res));
    assert.equal(res.statusCode, 400, "a forged-but-well-formed state must be rejected at the signature gate");
    assert.equal(res.headers["location"], undefined);
    assert.equal(store.inserts.length, 0);
  });

  it("emits a fresh nonce on each /authorize (nonce is not a fixed constant)", async () => {
    const handlers = createOauthAuthorizeHandlers(requireConfig(), oauthEnv(), { grantStore: grantStoreFake(), identityDirectory: resolvedDirectory() });
    const a = locationParams(await driveAuthorize(handlers, defaultAuthorizeParams())).params.get("nonce");
    const b = locationParams(await driveAuthorize(handlers, defaultAuthorizeParams())).params.get("nonce");
    assert.ok(a && b);
    assert.notEqual(a, b, "two authorize calls must not share a nonce");
  });

  it("denies a resolved identity carrying an unsafe Greenhouse user id, ZERO grant writes (identity gate second half)", async () => {
    for (const badId of [0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      const { res, store } = await driveSignInCallback({
        claims: (n) => validClaims({}, n),
        directory: resolvedWithId(badId),
      });
      assert.equal(res.statusCode, 302);
      assert.equal(locationParams(res).params.get("error"), "access_denied", `id ${badId} must be denied`);
      assert.equal(store.inserts.length, 0, `id ${badId} must write ZERO grants`);
    }
  });

  it("mints a fresh, high-entropy authorization code on each sign-in (codes differ, each >= 32 chars)", async () => {
    const first = await driveSignInCallback({ claims: (n) => validClaims({}, n) });
    const second = await driveSignInCallback({ claims: (n) => validClaims({}, n) });
    assert.equal(first.store.inserts.length, 1);
    assert.equal(second.store.inserts.length, 1);
    const codeA = first.store.inserts[0]!.secret;
    const codeB = second.store.inserts[0]!.secret;
    assert.notEqual(codeA, codeB, "two sign-ins must mint different codes");
    assert.ok(codeA.length >= 32 && codeB.length >= 32, "codes must be at least 32 characters");
  });
});

// CLO-271: a first sign-in whose email the directory has never seen is enrolled from the
// Greenhouse roster; every other non-resolution is a denial that names the cause and the fixer.
describe("first-sign-in enrollment at the callback (CLO-271)", () => {
  function claimsFor(email: string): (nonce: string | undefined) => Record<string, unknown> {
    return (nonce) => ({
      iss: "https://accounts.google.com",
      aud: "google-client-id-value.apps.googleusercontent.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce,
      email,
      email_verified: true,
      sub: "google-subject-9",
    });
  }

  // A directory that answers "unresolved" until an enrollment happens, then "resolved".
  function enrollingWorld(enrollOutcome: import("../src/oauth-enroll.js").OauthEnrollmentResult | Error) {
    let enrolled = false;
    const enrollCalls: string[] = [];
    const directory: IdentityDirectory = {
      async resolve() {
        return enrolled
          ? { status: "resolved", greenhouseUserId: 7100000002 }
          : { status: "unresolved", reason: "Recruiter identity mapping is not resolved." };
      },
    };
    const enrollIdentity = {
      async enroll(email: string) {
        enrollCalls.push(email);
        if (enrollOutcome instanceof Error) throw enrollOutcome;
        if (enrollOutcome.status === "enrolled") enrolled = true;
        return enrollOutcome;
      },
    };
    return { directory, enrollIdentity, enrollCalls };
  }

  async function signIn(world: ReturnType<typeof enrollingWorld>, email: string, store = grantStoreFake()) {
    let issuedNonce: string | undefined;
    const { fetchImpl } = googleExchangeFetch((nonce) => claimsFor(email)(nonce ?? issuedNonce));
    const handlers = createOauthAuthorizeHandlers(requireConfig(), oauthEnv(), {
      grantStore: store,
      identityDirectory: world.directory,
      enrollIdentity: world.enrollIdentity,
      fetchImpl,
    });
    const authorize = await driveAuthorize(handlers, defaultAuthorizeParams());
    const googleParams = locationParams(authorize).params;
    issuedNonce = googleParams.get("nonce") ?? undefined;
    const pendingState = googleParams.get("state")!;
    const res = new FakeResponse();
    await handlers.handleCallback({
      method: "GET",
      url: `/oauth/callback?code=google-authorization-code&state=${encodeURIComponent(pendingState)}`,
    }, asServerResponse(res));
    return { res, store, params: locationParams(res).params };
  }

  it("enrolls an unknown work email from the Greenhouse roster and completes the sign-in with a code grant", async () => {
    const world = enrollingWorld({ status: "enrolled", greenhouseUserId: 7100000002, alreadyEnrolled: false });
    const { res, store, params } = await signIn(world, "newhire@example.com");
    assert.equal(res.statusCode, 302);
    assert.deepEqual(world.enrollCalls, ["newhire@example.com"]);
    assert.ok(params.get("code"), "a code grant is issued after enrollment");
    assert.equal(params.get("error"), null);
    assert.equal(store.inserts.length, 1);
    assert.equal(store.inserts[0]!.email, "newhire@example.com");
  });

  it("a denied enrollment is access_denied with copy that names the cause and the fixer, and ZERO grant writes", async () => {
    const cases: Array<[import("../src/oauth-enroll.js").OauthEnrollmentDenialCode, RegExp]> = [
      ["email_missing", /does not match an active Greenhouse user.*Ask your Greenhouse connector administrator/],
      ["deactivated", /deactivated.*Ask your Greenhouse connector administrator/],
      ["ambiguous", /more than one Greenhouse user/],
      ["directory_row_exists", /not currently enabled.*re-enable/],
      ["email_mismatch", /registered under a different email/],
      ["enrollment_disabled", /not enrolled.*add you/],
    ];
    for (const [code, copy] of cases) {
      const world = enrollingWorld({ status: "denied", code, reason: "test" });
      const { res, store, params } = await signIn(world, "newhire@example.com");
      assert.equal(params.get("error"), "access_denied", code);
      assert.match(params.get("error_description") ?? "", copy, code);
      assert.doesNotMatch(res.headers["location"] ?? "", /newhire(%40|@)example\.com/i, "the email never rides in the redirect URL");
      assert.equal(store.inserts.length, 0, `${code} must write ZERO grants`);
    }
  });

  it("enrollment does not vouch for itself: if the directory still cannot resolve the email afterwards, the sign-in is denied", async () => {
    const world = enrollingWorld({ status: "enrolled", greenhouseUserId: 7100000002, alreadyEnrolled: false });
    // The directory never flips to resolved (a row the resolver cannot see), even though enrollment said "enrolled".
    world.directory.resolve = async () => ({ status: "unresolved", reason: "Recruiter identity mapping is not resolved." });
    const { store, params } = await signIn(world, "newhire@example.com");
    assert.deepEqual(world.enrollCalls, ["newhire@example.com"]);
    assert.equal(params.get("error"), "access_denied", "the directory's verdict wins over the enrollment's claim");
    assert.equal(store.inserts.length, 0);
  });

  it("an enrollment outage is server_error (retry), not a denial, and writes ZERO grants", async () => {
    const world = enrollingWorld({ status: "error", reason: "Greenhouse API error: 503" });
    const { store, params } = await signIn(world, "newhire@example.com");
    assert.equal(params.get("error"), "server_error");
    assert.match(params.get("error_description") ?? "", /Try again in a minute/);
    assert.equal(store.inserts.length, 0);
  });

  it("an ambiguous directory row is a hard denial that never reaches enrollment", async () => {
    const world = enrollingWorld({ status: "enrolled", greenhouseUserId: 1, alreadyEnrolled: false });
    world.directory.resolve = async () => ({ status: "ambiguous", greenhouseUserIds: [1, 2], reason: "two rows" });
    const { store, params } = await signIn(world, "newhire@example.com");
    assert.equal(params.get("error"), "access_denied");
    assert.match(params.get("error_description") ?? "", /more than one Greenhouse user/);
    assert.deepEqual(world.enrollCalls, []);
    assert.equal(store.inserts.length, 0);
  });

  it("the personal-address denial tells the recruiter which account to use", async () => {
    const world = enrollingWorld({ status: "enrolled", greenhouseUserId: 1, alreadyEnrolled: false });
    const { params } = await signIn(world, "someone@gmail.com");
    assert.equal(params.get("error"), "access_denied");
    assert.match(params.get("error_description") ?? "", /Sign in with your @example\.com Google account/);
    assert.deepEqual(world.enrollCalls, [], "the domain gate runs before enrollment");
  });
});
