import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { createSignedSessionToken } from "../src/auth.js";
import { startHttpRecruiterMcp } from "../src/http-server.js";
import { CLAUDE_CODE_CIMD_URL } from "../src/oauth-clients.js";
import { GOOGLE_TOKEN_ENDPOINT } from "../src/oauth-authorize.js";

// Slice 9: the whole connector story against ONE booted server and ONE URL-dispatching fetch
// stub (Google token endpoint, claude.ai CIMD documents, in-memory grants + revocation +
// identity PostgREST arms; 127.0.0.1 passes through to the real fetch so the test can drive the
// server itself). discovery -> 401 challenge -> authorize -> Google -> callback -> code ->
// token+PKCE -> tools/list parity with a legacy session from the SAME boot -> refresh rotation
// -> reuse family-kill -> jti revocation.

const STRONG_SESSION_SECRET = "session-secret-value-with-at-least-32-chars";
const STRONG_SCOPE_SIGNING_SECRET = "scope-signing-secret-value-at-least-32-chars";
const OAUTH_SIGNING_SECRET = "oauth-signing-secret-value-with-at-least-32-chars";
const ISSUER = "https://recruiter-mcp.example.com";
const RESOURCE_URL = "https://recruiter-mcp.example.com/mcp";
const SUPABASE_ORIGIN = "https://exampleprojectref000.supabase.co";
const LOOPBACK_REDIRECT = "http://localhost:53682/callback";
const HOSTED_CIMD_URL = "https://claude.ai/oauth/hosted-chat-client-metadata";
const HOSTED_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const CHATGPT_CLIENTS = [
  { clientId: "https://chatgpt.com/oauth/client.json", redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect" },
  { clientId: "https://chatgpt.com/oauth/callback-123/client.json", redirectUri: "https://chatgpt.com/connector/oauth/callback-123" },
];
// RFC 7636 appendix B vector.
const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const RECRUITER_EMAIL = "recruiter@example.com";

interface FlowWorld {
  grantRows: Map<string, Record<string, unknown>>;
  revokedFamilies: Set<string>;
  revokedTokenIds: Set<string>;
  currentNonce: string | undefined;
  googleExchanges: number;
  cimdFetches: number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function buildGoogleIdToken(nonce: string | undefined): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "stub-key" }), "utf8").toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: "https://accounts.google.com",
    aud: "google-client-id-value.apps.googleusercontent.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
    nonce,
    email: RECRUITER_EMAIL,
    email_verified: true,
    sub: "google-subject-1",
  }), "utf8").toString("base64url");
  // Claims-only verification on the direct TLS channel: an unsigned-garbage signature with
  // valid claims is the deliberate, correct stub shape.
  return `${header}.${payload}.unsigned-garbage-signature`;
}

// The single URL-dispatching stub. Every upstream the flow touches lives here; anything
// unexpected throws so a surprise dependency cannot hide.
function installFlowFetchStub(world: FlowWorld): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const urlText = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (urlText.startsWith("http://127.0.0.1")) {
      return originalFetch(input, init);
    }
    const url = new URL(urlText);
    const method = init?.method ?? "GET";

    if (urlText.startsWith(`${SUPABASE_ORIGIN}/rest/v1/rpc/redeem_oauth_`)) {
      return grantsRpcArm(world, url.pathname.split("/").pop() ?? "", init);
    }
    if (urlText.startsWith(`${SUPABASE_ORIGIN}/rest/v1/recruiter_mcp_oauth_grants`)) {
      return grantsArm(world, url, method, init);
    }
    if (urlText.startsWith(`${SUPABASE_ORIGIN}/rest/v1/recruiter_mcp_session_revocation`)) {
      const tokenId = url.searchParams.get("token_id")?.replace(/^eq\./, "");
      const revoked = tokenId !== undefined && world.revokedTokenIds.has(tokenId);
      return jsonResponse(revoked ? [{ token_id: tokenId, status: "revoked" }] : []);
    }
    if (urlText.startsWith(`${SUPABASE_ORIGIN}/rest/v1/recruiter_identity_directory`)) {
      // Resolve ONLY the enrolled recruiter — a directory that says yes to any email would mask a
      // bug where the wrong subject reaches the grant store. Any other lookup is unresolved.
      const asksForRecruiter = urlText.includes(encodeURIComponent(RECRUITER_EMAIL)) || urlText.includes(RECRUITER_EMAIL);
      if (!asksForRecruiter) return jsonResponse([]);
      return jsonResponse([{
        greenhouse_user_id: 123,
        id: "11111111-2222-4333-8444-666666666666",
        primary_email: RECRUITER_EMAIL,
        google_subject: `email:${RECRUITER_EMAIL}`,
        status: "resolved",
      }]);
    }
    if (urlText === GOOGLE_TOKEN_ENDPOINT) {
      world.googleExchanges += 1;
      return jsonResponse({
        access_token: "google-access-token-value",
        token_type: "Bearer",
        id_token: buildGoogleIdToken(world.currentNonce),
      });
    }
    if (urlText === HOSTED_CIMD_URL) {
      world.cimdFetches += 1;
      return jsonResponse({ client_name: "Claude", redirect_uris: [HOSTED_CALLBACK] });
    }
    const chatgpt = CHATGPT_CLIENTS.find((client) => client.clientId === urlText);
    if (chatgpt) {
      world.cimdFetches += 1;
      return jsonResponse({
        client_id: chatgpt.clientId, redirect_uris: [chatgpt.redirectUri],
        token_endpoint_auth_method: "private_key_jwt",
        token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      });
    }
    throw new Error(`unexpected fetch in oauth full-flow test: ${method} ${urlText}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function grantsArm(world: FlowWorld, url: URL, method: string, init: RequestInit | undefined): Response {
  if (method === "POST") {
    const row = JSON.parse(String(init?.body)) as Record<string, unknown>;
    world.grantRows.set(String(row["token_hash"]), { consumed_at: null, revoked_at: null, ...row });
    return new Response("", { status: 201 });
  }
  // The refresh leg's pre-rotation peek (CLO-272): PostgREST filter by token_hash, refresh rows only.
  if (method === "GET") {
    const hash = url.searchParams.get("token_hash")?.replace(/^eq\./, "");
    const row = hash === undefined ? undefined : world.grantRows.get(hash);
    if (row === undefined || row["grant_kind"] !== "refresh") return jsonResponse([]);
    return jsonResponse([{
      email: row["email"],
      family_id: row["family_id"],
      client_id: row["client_id"],
      surface: row["surface"],
      client: row["client"],
      consumed_at: row["consumed_at"],
      revoked_at: row["revoked_at"],
    }]);
  }
  throw new Error(`unexpected grants request: ${method} ${url}`);
}

// Models the migration-0006 redemption RPCs against the in-memory grant map: one indivisible
// consume -> verify -> reuse-revoke -> successor-seat, with a durable revoked-families set so a
// successor can never survive behind a killed family.
function grantsRpcArm(world: FlowWorld, fn: string, init: RequestInit | undefined): Response {
  const body = JSON.parse(String(init?.body)) as Record<string, string>;
  if (fn === "redeem_oauth_code") {
    const row = world.grantRows.get(body["p_token_hash"]!);
    if (
      row === undefined || row["consumed_at"] !== null || row["revoked_at"] !== null ||
      world.revokedFamilies.has(String(row["family_id"]))
    ) {
      return jsonResponse({ status: "not_consumable" });
    }
    row["consumed_at"] = body["p_now"];
    return jsonResponse({
      status: "consumed",
      token_hash: body["p_token_hash"],
      grant_kind: row["grant_kind"],
      family_id: row["family_id"],
      client_id: row["client_id"],
      redirect_uri: row["redirect_uri"] ?? null,
      code_challenge: row["code_challenge"] ?? null,
      email: row["email"],
      surface: row["surface"],
      client: row["client"],
      resource: row["resource"],
      scope: row["scope"] ?? null,
      expires_at: row["expires_at"],
    });
  }
  if (fn === "redeem_oauth_refresh") {
    const row = world.grantRows.get(body["p_token_hash"]!);
    if (row === undefined) return jsonResponse({ status: "not_found" });
    const family = String(row["family_id"]);
    const familyRevoked = world.revokedFamilies.has(family);
    if (row["consumed_at"] === null && row["revoked_at"] === null && !familyRevoked) {
      row["consumed_at"] = body["p_now"];
      if (row["grant_kind"] !== "refresh") return jsonResponse({ status: "wrong_kind" });
      if (Date.parse(String(row["expires_at"])) < Date.parse(body["p_now"]!)) return jsonResponse({ status: "expired" });
      if (row["client_id"] !== body["p_client_id"]) return jsonResponse({ status: "client_mismatch" });
      world.grantRows.set(body["p_successor_hash"]!, {
        consumed_at: null,
        revoked_at: null,
        token_hash: body["p_successor_hash"],
        grant_kind: "refresh",
        family_id: family,
        client_id: row["client_id"],
        email: row["email"],
        surface: row["surface"],
        client: row["client"],
        resource: row["resource"],
        scope: row["scope"] ?? null,
        access_jti: body["p_successor_jti"] ?? null,
        expires_at: body["p_successor_expires_at"],
      });
      return jsonResponse({
        status: "rotated",
        family_id: family,
        email: row["email"],
        surface: row["surface"],
        client: row["client"],
        resource: row["resource"],
        scope: row["scope"] ?? null,
      });
    }
    if (row["grant_kind"] === "refresh" && row["consumed_at"] !== null && !familyRevoked) {
      world.revokedFamilies.add(family);
      for (const other of world.grantRows.values()) {
        if (other["family_id"] === family) {
          if (other["revoked_at"] === null) other["revoked_at"] = body["p_now"];
          // The migration copies the family's outstanding jtis into the revocation list in-txn.
          if (typeof other["access_jti"] === "string") world.revokedTokenIds.add(other["access_jti"]);
        }
      }
      return jsonResponse({ status: "reuse_revoked" });
    }
    return jsonResponse({ status: "not_redeemable" });
  }
  throw new Error(`unexpected grants rpc: ${fn}`);
}

function flowEnv(auditDir: string): NodeJS.ProcessEnv {
  return {
    GREENHOUSE_RECRUITER_MCP_PORT: "0",
    GREENHOUSE_CLIENT_ID: "client-id-value",
    GREENHOUSE_CLIENT_SECRET: "client-secret-value",
    GREENHOUSE_RECRUITER_STATE_BACKEND: "supabase_postgrest",
    GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
    GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS: "example.com",
    GREENHOUSE_RECRUITER_SCOPE_SIGNING_SECRET: STRONG_SCOPE_SIGNING_SECRET,
    GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: SUPABASE_ORIGIN,
    GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY: "identity-key-value",
    GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL: SUPABASE_ORIGIN,
    GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY: "revocation-key-value",
    GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH: join(auditDir, "audit.jsonl"),
    GREENHOUSE_RECRUITER_AUDIT_DURABLE_MOUNT_PATH: auditDir,
    GREENHOUSE_RECRUITER_OAUTH_SIGNING_SECRET: OAUTH_SIGNING_SECRET,
    GREENHOUSE_RECRUITER_OAUTH_ISSUER: ISSUER,
    GREENHOUSE_RECRUITER_OAUTH_RESOURCE_URL: RESOURCE_URL,
    GREENHOUSE_RECRUITER_OAUTH_GOOGLE_CLIENT_ID: "google-client-id-value.apps.googleusercontent.com",
    GREENHOUSE_RECRUITER_OAUTH_GOOGLE_CLIENT_SECRET: "google-client-secret-value",
    GREENHOUSE_RECRUITER_OAUTH_SUPABASE_URL: SUPABASE_ORIGIN,
    GREENHOUSE_RECRUITER_OAUTH_SUPABASE_KEY: "oauth-grants-key-value",
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

// The transport may answer application/json or an SSE stream; accept both.
function parseMcpBody(text: string): Record<string, unknown> {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as Record<string, unknown>;
  const dataLines = text.split("\n").filter((line) => line.startsWith("data: "));
  assert.ok(dataLines.length > 0, `expected JSON or SSE data lines, got: ${text.slice(0, 200)}`);
  return JSON.parse(dataLines[dataLines.length - 1]!.slice(6)) as Record<string, unknown>;
}

async function listToolNames(base: string, bearer: string): Promise<string[]> {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "tools-list", method: "tools/list" }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `tools/list must succeed, got ${response.status}: ${text.slice(0, 300)}`);
  const body = parseMcpBody(text);
  const result = body["result"] as { tools?: Array<{ name: string }> } | undefined;
  assert.ok(result && Array.isArray(result.tools) && result.tools.length > 0, "tools/list must return tools");
  return result.tools!.map((tool) => tool.name);
}

function decodeAccessTokenClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  assert.ok(payload);
  return JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("OAuth full flow (slice 9)", () => {
  for (const client of [
    { clientId: CLAUDE_CODE_CIMD_URL, redirectUri: LOOPBACK_REDIRECT, client: "claude_code", surface: "claude_desktop" },
    ...CHATGPT_CLIENTS.map((entry) => ({ ...entry, client: "chatgpt_codex_host", surface: "chatgpt_desktop" })),
  ] as const) {
  it(`drives discovery -> sign-in -> tokens -> catalog -> refresh -> revocation for ${client.clientId}`, async () => {
    const auditDir = await mkdtemp(join(tmpdir(), "greenhouse-oauth-flow-"));
    const world: FlowWorld = {
      grantRows: new Map(),
      revokedFamilies: new Set(),
      revokedTokenIds: new Set(),
      currentNonce: undefined,
      googleExchanges: 0,
      cimdFetches: 0,
    };
    const restoreFetch = installFlowFetchStub(world);
    const server = await startHttpRecruiterMcp(flowEnv(auditDir));
    try {
      const base = baseUrl(server);

      // 1. Discovery: AS metadata + PRM at the suffixed path Claude probes first.
      const asMetadata = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>;
      assert.equal(asMetadata["issuer"], ISSUER);
      assert.deepEqual(asMetadata["code_challenge_methods_supported"], ["S256"]);
      const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json() as Record<string, unknown>;
      assert.equal(prm["resource"], RESOURCE_URL);

      // 2. The bare 401 carries the exact discovery pointer.
      const challenge = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.equal(challenge.status, 401);
      assert.equal(
        challenge.headers.get("www-authenticate"),
        `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`
      );

      // 3. /authorize hands the browser to Google with signed pending state.
      const authorizeParams = new URLSearchParams({
        response_type: "code",
        client_id: client.clientId,
        redirect_uri: client.redirectUri,
        state: "client-opaque-state-value",
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: "S256",
        scope: "offline_access",
        resource: RESOURCE_URL,
      });
      const authorize = await fetch(`${base}/authorize?${authorizeParams}`, { redirect: "manual" });
      assert.equal(authorize.status, 302);
      const googleLocation = new URL(authorize.headers.get("location")!);
      assert.equal(googleLocation.origin, "https://accounts.google.com");
      world.currentNonce = googleLocation.searchParams.get("nonce") ?? undefined;
      const pendingState = googleLocation.searchParams.get("state")!;
      assert.ok(world.currentNonce);

      // 4. Google sends the user back; the callback exchanges, gates identity, mints a code.
      const callback = await fetch(
        `${base}/oauth/callback?code=google-authorization-code&state=${encodeURIComponent(pendingState)}`,
        { redirect: "manual" }
      );
      assert.equal(callback.status, 302);
      const clientLocation = new URL(callback.headers.get("location")!);
      assert.equal(`${clientLocation.protocol}//${clientLocation.host}${clientLocation.pathname}`, client.redirectUri);
      assert.equal(clientLocation.searchParams.get("state"), "client-opaque-state-value");
      const authorizationCode = clientLocation.searchParams.get("code")!;
      assert.ok(authorizationCode);
      assert.equal(world.googleExchanges, 1);

      // 5. /token redeems the code with the PKCE verifier.
      const exchange = await fetch(`${base}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: authorizationCode,
          redirect_uri: client.redirectUri,
          client_id: client.clientId,
          code_verifier: CODE_VERIFIER,
          resource: RESOURCE_URL,
        }).toString(),
      });
      assert.equal(exchange.status, 200);
      const tokens = await exchange.json() as Record<string, unknown>;
      const accessToken = tokens["access_token"] as string;
      const refreshToken1 = tokens["refresh_token"] as string;
      assert.equal(tokens["token_type"], "Bearer");
      assert.equal(accessToken.split(".").length, 3);
      assert.equal(decodeAccessTokenClaims(accessToken)["client"], client.client);
      assert.equal(decodeAccessTokenClaims(accessToken)["surface"], client.surface);
      assert.equal(world.cimdFetches, client.client === "claude_code" ? 0 : 1);

      // 6. The signed-in session sees EXACTLY the catalog a legacy session sees, same boot.
      const oauthToolNames = await listToolNames(base, accessToken);
      const legacyToken = createSignedSessionToken({
        subject: `email:${RECRUITER_EMAIL}`,
        email: RECRUITER_EMAIL,
        surface: client.surface as "claude_desktop" | "chatgpt_desktop",
        client: client.client as "claude_code" | "chatgpt_codex_host",
        tokenId: "legacy-parity-session",
        issuedAt: "2026-06-23T00:00:00.000Z",
      }, STRONG_SESSION_SECRET);
      const legacyToolNames = await listToolNames(base, legacyToken);
      assert.deepEqual(oauthToolNames, legacyToolNames);

      // 7. Refresh rotation, then reuse kills the family.
      const rotate = await fetch(`${base}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken1,
          client_id: client.clientId,
        }).toString(),
      });
      assert.equal(rotate.status, 200);
      const rotated = await rotate.json() as Record<string, unknown>;
      const refreshToken2 = rotated["refresh_token"] as string;
      assert.notEqual(refreshToken2, refreshToken1);
      assert.deepEqual(await listToolNames(base, rotated["access_token"] as string), oauthToolNames);

      const reuse = await fetch(`${base}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken1,
          client_id: client.clientId,
        }).toString(),
      });
      assert.equal(reuse.status, 400);
      assert.equal(((await reuse.json()) as Record<string, unknown>)["error"], "invalid_grant");

      const afterFamilyKill = await fetch(`${base}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken2,
          client_id: client.clientId,
        }).toString(),
      });
      assert.equal(afterFamilyKill.status, 400);
      assert.equal(((await afterFamilyKill.json()) as Record<string, unknown>)["error"], "invalid_grant");

      // 8. The reuse response already reached this OAuth session: the access-token jti minted at
      // the code exchange was copied into the revocation list by the family kill — no operator
      // step, no manual revoke. The stolen access token is dead the moment reuse was detected.
      const jti = decodeAccessTokenClaims(accessToken)["jti"] as string;
      assert.ok(jti);
      assert.ok(world.revokedTokenIds.has(jti), "refresh reuse must auto-revoke the family's access-token jtis");
      const revoked = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: "after-revocation", method: "tools/list" }),
      });
      assert.equal(revoked.status, 401);
      const revokedBody = await revoked.json() as { error: { data: { denialCode: string } } };
      assert.equal(revokedBody.error.data.denialCode, "SESSION_REVOKED");
    } finally {
      restoreFetch();
      await closeServer(server);
      await rm(auditDir, { recursive: true, force: true });
    }
  });
  }

  it("authorizes a hosted-Claude CIMD client through the same stub (document fetched once)", async () => {
    const auditDir = await mkdtemp(join(tmpdir(), "greenhouse-oauth-cimd-"));
    const world: FlowWorld = {
      grantRows: new Map(),
      revokedFamilies: new Set(),
      revokedTokenIds: new Set(),
      currentNonce: undefined,
      googleExchanges: 0,
      cimdFetches: 0,
    };
    const restoreFetch = installFlowFetchStub(world);
    const server = await startHttpRecruiterMcp(flowEnv(auditDir));
    try {
      const base = baseUrl(server);
      const params = new URLSearchParams({
        response_type: "code",
        client_id: HOSTED_CIMD_URL,
        redirect_uri: HOSTED_CALLBACK,
        state: "hosted-state",
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: "S256",
      });
      const authorize = await fetch(`${base}/authorize?${params}`, { redirect: "manual" });
      assert.equal(authorize.status, 302);
      assert.match(authorize.headers.get("location") ?? "", /accounts\.google\.com/);
      assert.equal(world.cimdFetches, 1, "the CIMD document must be fetched exactly once");
    } finally {
      restoreFetch();
      await closeServer(server);
      await rm(auditDir, { recursive: true, force: true });
    }
  });
});
