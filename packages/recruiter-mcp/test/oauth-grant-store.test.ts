import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createOauthGrantStore, hashOauthGrantSecret } from "../src/oauth-grant-store.js";
import { readOauthAuthorizationConfig } from "../src/oauth-config.js";

const STRONG_SESSION_SECRET = "session-secret-value-with-at-least-32-chars";
const OAUTH_SIGNING_SECRET = "oauth-signing-secret-value-with-at-least-32-chars";
const ISSUER = "https://recruiter-mcp.example.com";
const RESOURCE_URL = "https://recruiter-mcp.example.com/mcp";
const GRANTS_ORIGIN = "https://exampleprojectref000.supabase.co";

function oauthEnv(): NodeJS.ProcessEnv {
  return {
    GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
    GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS: "example.com",
    GREENHOUSE_RECRUITER_OAUTH_SIGNING_SECRET: OAUTH_SIGNING_SECRET,
    GREENHOUSE_RECRUITER_OAUTH_ISSUER: ISSUER,
    GREENHOUSE_RECRUITER_OAUTH_RESOURCE_URL: RESOURCE_URL,
    GREENHOUSE_RECRUITER_OAUTH_GOOGLE_CLIENT_ID: "google-client-id-value.apps.googleusercontent.com",
    GREENHOUSE_RECRUITER_OAUTH_GOOGLE_CLIENT_SECRET: "google-client-secret-value",
    GREENHOUSE_RECRUITER_OAUTH_SUPABASE_URL: GRANTS_ORIGIN,
    GREENHOUSE_RECRUITER_OAUTH_SUPABASE_KEY: "oauth-grants-key-value",
  } as NodeJS.ProcessEnv;
}

function requireConfig() {
  const result = readOauthAuthorizationConfig(oauthEnv());
  assert.equal(result.state, "configured");
  if (result.state !== "configured") throw new Error("unreachable");
  return result.config;
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function recordingFetch(
  responder: (request: CapturedRequest) => Response
): { fetchImpl: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const captured: CapturedRequest = {
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])),
      body: typeof init?.body === "string" ? init.body : "",
    };
    requests.push(captured);
    return responder(captured);
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const SAMPLE_GRANT_INPUT = {
  kind: "code" as const,
  secret: "raw-authorization-code-secret-value-that-must-never-be-stored",
  familyId: "11111111-2222-4333-8444-555555555555",
  clientId: "https://claude.ai/oauth/claude-code-client-metadata",
  redirectUri: "http://localhost:53682/callback",
  codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  email: "recruiter@example.com",
  surface: "claude_desktop" as const,
  client: "claude_code" as const,
  resource: RESOURCE_URL,
  scope: "offline_access",
  expiresAt: "2026-08-18T12:05:00.000Z",
};

describe("OAuth grant store (slice 4)", () => {
  it("stores only the sha256 of a grant secret — the raw secret never leaves the process", async () => {
    const { fetchImpl, requests } = recordingFetch(() => new Response("", { status: 201 }));
    const store = createOauthGrantStore(requireConfig(), { fetchImpl });

    await store.insertGrant(SAMPLE_GRANT_INPUT);

    assert.equal(requests.length, 1);
    const request = requests[0]!;
    assert.equal(request.method, "POST");
    assert.match(request.url, /\/rest\/v1\/recruiter_mcp_oauth_grants/);
    const expectedHash = createHash("sha256").update(SAMPLE_GRANT_INPUT.secret, "utf8").digest("hex");
    assert.equal(hashOauthGrantSecret(SAMPLE_GRANT_INPUT.secret), expectedHash);
    const row = JSON.parse(request.body) as Record<string, unknown>;
    assert.equal(row["token_hash"], expectedHash);
    assert.equal(row["grant_kind"], "code");
    assert.equal(row["family_id"], SAMPLE_GRANT_INPUT.familyId);
    assert.equal(row["client_id"], SAMPLE_GRANT_INPUT.clientId);
    assert.equal(row["code_challenge"], SAMPLE_GRANT_INPUT.codeChallenge);
    assert.equal(row["email"], "recruiter@example.com");
    assert.equal(row["resource"], RESOURCE_URL);
    assert.equal(row["expires_at"], SAMPLE_GRANT_INPUT.expiresAt);
    const everything = `${request.url}\n${request.body}\n${JSON.stringify(request.headers)}`;
    assert.ok(!everything.includes(SAMPLE_GRANT_INPUT.secret), "raw grant secret must never be sent");
  });

  it("consumes a code through the redeem_oauth_code RPC and reports a spent code as not consumable", async () => {
    const config = requireConfig();
    const hash = hashOauthGrantSecret(SAMPLE_GRANT_INPUT.secret);
    let consumed = false;
    const { fetchImpl, requests } = recordingFetch((request) => {
      assert.equal(request.method, "POST");
      assert.match(request.url, /\/rest\/v1\/rpc\/redeem_oauth_code/);
      if (consumed) {
        return new Response(JSON.stringify({ status: "not_consumable" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      consumed = true;
      return new Response(JSON.stringify({
        status: "consumed",
        token_hash: hash,
        grant_kind: "code",
        family_id: SAMPLE_GRANT_INPUT.familyId,
        client_id: SAMPLE_GRANT_INPUT.clientId,
        redirect_uri: SAMPLE_GRANT_INPUT.redirectUri,
        code_challenge: SAMPLE_GRANT_INPUT.codeChallenge,
        email: SAMPLE_GRANT_INPUT.email,
        surface: SAMPLE_GRANT_INPUT.surface,
        client: SAMPLE_GRANT_INPUT.client,
        resource: SAMPLE_GRANT_INPUT.resource,
        scope: SAMPLE_GRANT_INPUT.scope,
        expires_at: SAMPLE_GRANT_INPUT.expiresAt,
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const store = createOauthGrantStore(config, { fetchImpl });

    const first = await store.consumeGrant(SAMPLE_GRANT_INPUT.secret);
    assert.equal(first.status, "consumed");
    if (first.status !== "consumed") throw new Error("unreachable");
    assert.equal(first.grant.tokenHash, hash);
    assert.equal(first.grant.kind, "code");
    assert.equal(first.grant.familyId, SAMPLE_GRANT_INPUT.familyId);
    assert.equal(first.grant.codeChallenge, SAMPLE_GRANT_INPUT.codeChallenge);
    assert.equal(first.grant.email, "recruiter@example.com");

    const second = await store.consumeGrant(SAMPLE_GRANT_INPUT.secret);
    assert.equal(second.status, "not_consumable");

    // The hash rides in the RPC body, never the raw secret.
    const body = JSON.parse(requests[0]!.body) as Record<string, unknown>;
    assert.equal(body["p_token_hash"], hash);
    assert.ok(typeof body["p_now"] === "string" && body["p_now"].length > 0);
    const everything = requests.map((r) => `${r.url}\n${r.body}`).join("\n");
    assert.ok(!everything.includes(SAMPLE_GRANT_INPUT.secret), "raw grant secret must never be sent");
  });

  it("rotates a refresh token through the redeem_oauth_refresh RPC — presented AND successor hashed, never raw", async () => {
    const presented = "the-outstanding-refresh-token-secret-value-abcdefghij";
    const successor = "the-freshly-minted-successor-refresh-secret-value-klmno";
    const presentedHash = hashOauthGrantSecret(presented);
    const successorHash = hashOauthGrantSecret(successor);
    const { fetchImpl, requests } = recordingFetch((request) => {
      assert.equal(request.method, "POST");
      assert.match(request.url, /\/rest\/v1\/rpc\/redeem_oauth_refresh/);
      return new Response(JSON.stringify({
        status: "rotated",
        family_id: SAMPLE_GRANT_INPUT.familyId,
        email: SAMPLE_GRANT_INPUT.email,
        surface: SAMPLE_GRANT_INPUT.surface,
        client: SAMPLE_GRANT_INPUT.client,
        resource: SAMPLE_GRANT_INPUT.resource,
        scope: SAMPLE_GRANT_INPUT.scope,
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const store = createOauthGrantStore(requireConfig(), { fetchImpl });

    const result = await store.redeemRefresh({
      presentedSecret: presented,
      clientId: SAMPLE_GRANT_INPUT.clientId,
      now: Date.parse("2026-08-18T12:00:00.000Z"),
      successorSecret: successor,
      successorExpiresAt: "2026-09-17T12:00:00.000Z",
      successorJti: "successor-access-token-jti-value",
    });
    assert.equal(result.status, "rotated");
    if (result.status !== "rotated") throw new Error("unreachable");
    assert.equal(result.grant.familyId, SAMPLE_GRANT_INPUT.familyId);
    assert.equal(result.grant.email, "recruiter@example.com");
    assert.equal(result.grant.client, SAMPLE_GRANT_INPUT.client);
    assert.equal(result.grant.scope, SAMPLE_GRANT_INPUT.scope);

    const body = JSON.parse(requests[0]!.body) as Record<string, unknown>;
    assert.equal(body["p_token_hash"], presentedHash);
    assert.equal(body["p_successor_hash"], successorHash);
    assert.equal(body["p_client_id"], SAMPLE_GRANT_INPUT.clientId);
    assert.equal(body["p_successor_expires_at"], "2026-09-17T12:00:00.000Z");
    assert.equal(body["p_successor_jti"], "successor-access-token-jti-value");
    const everything = `${requests[0]!.url}\n${requests[0]!.body}`;
    assert.ok(!everything.includes(presented) && !everything.includes(successor), "raw refresh secrets must never be sent");
  });

  it("maps the RPC reuse and failure statuses onto the redeem result contract", async () => {
    const responder = (status: string) => recordingFetch(() =>
      new Response(JSON.stringify({ status }), { status: 200, headers: { "content-type": "application/json" } })
    );
    const redeem = async (status: string) => {
      const { fetchImpl } = responder(status);
      const store = createOauthGrantStore(requireConfig(), { fetchImpl });
      return store.redeemRefresh({
        presentedSecret: "presented-refresh-secret-value-of-sufficient-length",
        clientId: SAMPLE_GRANT_INPUT.clientId,
        now: Date.now(),
        successorSecret: "successor-refresh-secret-value-of-sufficient-length",
        successorExpiresAt: "2026-09-17T12:00:00.000Z",
        successorJti: "successor-access-token-jti-value",
      });
    };

    assert.deepEqual(await redeem("reuse_revoked"), { status: "reuse_revoked" });
    assert.deepEqual(await redeem("expired"), { status: "not_redeemable", detail: "expired" });
    assert.deepEqual(await redeem("wrong_kind"), { status: "not_redeemable", detail: "wrong_kind" });
    assert.deepEqual(await redeem("client_mismatch"), { status: "not_redeemable", detail: "client_mismatch" });
    assert.deepEqual(await redeem("not_found"), { status: "not_redeemable", detail: "not_found" });
    assert.deepEqual(await redeem("not_redeemable"), { status: "not_redeemable", detail: "not_redeemable" });
  });

  it("surfaces PostgREST failures as errors instead of silently treating them as replays", async () => {
    const { fetchImpl } = recordingFetch(() => new Response("boom", { status: 500 }));
    const store = createOauthGrantStore(requireConfig(), { fetchImpl });
    await assert.rejects(() => store.consumeGrant(SAMPLE_GRANT_INPUT.secret), /status 500/);
    await assert.rejects(
      () => store.redeemRefresh({
        presentedSecret: "presented-refresh-secret-value-of-sufficient-length",
        clientId: SAMPLE_GRANT_INPUT.clientId,
        now: Date.now(),
        successorSecret: "successor-refresh-secret-value-of-sufficient-length",
        successorExpiresAt: "2026-09-17T12:00:00.000Z",
        successorJti: "successor-access-token-jti-value",
      }),
      /status 500/
    );
  });
});

describe("OAuth grant store — peek and family revocation (CLO-272)", () => {
  it("peekRefresh reads the row by token hash without consuming it, refresh rows only, and never sends the secret", async () => {
    const { fetchImpl, requests } = recordingFetch(() =>
      new Response(JSON.stringify([{ email: "someone@example.com", family_id: "fam-1", client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata", surface: "claude_desktop", client: "claude_desktop_chat", consumed_at: null, revoked_at: null }]), { status: 200 })
    );
    const store = createOauthGrantStore(requireConfig(), { fetchImpl });
    const peek = await store.peekRefresh("the-raw-refresh-secret-value");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.method, "GET");
    const url = new URL(requests[0]!.url);
    assert.equal(url.searchParams.get("token_hash"), `eq.${hashOauthGrantSecret("the-raw-refresh-secret-value")}`);
    assert.equal(url.searchParams.get("grant_kind"), "eq.refresh");
    assert.doesNotMatch(requests[0]!.url, /the-raw-refresh-secret-value/);
    assert.deepEqual(peek, {
      status: "found",
      email: "someone@example.com",
      familyId: "fam-1",
      clientId: "https://claude.ai/oauth/mcp-oauth-client-metadata",
      surface: "claude_desktop",
      client: "claude_desktop_chat",
      consumed: false,
      revoked: false,
    });
  });

  it("peekRefresh answers not_found for an unknown token and throws on a transport failure (the caller turns that into 503)", async () => {
    const empty = createOauthGrantStore(requireConfig(), { fetchImpl: recordingFetch(() => new Response("[]", { status: 200 })).fetchImpl });
    assert.deepEqual(await empty.peekRefresh("unknown"), { status: "not_found" });
    const broken = createOauthGrantStore(requireConfig(), { fetchImpl: recordingFetch(() => new Response("", { status: 503 })).fetchImpl });
    await assert.rejects(() => broken.peekRefresh("unknown"), /status 503/);
  });

  it("redeemRefresh maps the migration-0007 family_revoked status (kill switch reached the family)", async () => {
    const { fetchImpl } = recordingFetch(() => new Response(JSON.stringify({ status: "family_revoked" }), { status: 200 }));
    const store = createOauthGrantStore(requireConfig(), { fetchImpl });
    const result = await store.redeemRefresh({
      presentedSecret: "presented", clientId: "c", now: Date.now(), successorSecret: "successor", successorExpiresAt: new Date().toISOString(), successorJti: "jti",
    });
    assert.deepEqual(result, { status: "family_revoked" });
  });

  it("an RPC answer the store does not recognise is reported as invalid, never as revoked", async () => {
    const { fetchImpl } = recordingFetch(() => new Response(JSON.stringify({ status: "invalid_email" }), { status: 200 }));
    const store = createOauthGrantStore(requireConfig(), { fetchImpl });
    assert.deepEqual(await store.revokeGrantsForEmail("someone@example.com"), { status: "invalid", familiesRevoked: 0, grantsRevoked: 0, jtisRevoked: 0 });
  });

  it("revokeFamily and revokeGrantsForEmail call their RPCs with reason and revoked_by, and report counts", async () => {
    const { fetchImpl, requests } = recordingFetch((request) =>
      new Response(JSON.stringify(request.url.endsWith("revoke_oauth_family")
        ? { status: "revoked", family_id: "fam-1", families_revoked: 1, grants_revoked: 3, jtis_revoked: 3 }
        : { status: "revoked", email: "someone@example.com", families_revoked: 2, grants_revoked: 4, jtis_revoked: 4 }), { status: 200 })
    );
    const store = createOauthGrantStore(requireConfig(), { fetchImpl });
    const family = await store.revokeFamily("fam-1", { reason: "identity_unresolved", revokedBy: "oauth_refresh_identity_gate" });
    const email = await store.revokeGrantsForEmail("Someone@Example.com", { reason: "offboarded" });
    assert.equal(requests.length, 2);
    assert.match(requests[0]!.url, /\/rest\/v1\/rpc\/revoke_oauth_family$/);
    const familyBody = JSON.parse(requests[0]!.body) as Record<string, unknown>;
    assert.equal(familyBody["p_family_id"], "fam-1");
    assert.equal(familyBody["p_reason"], "identity_unresolved");
    assert.equal(familyBody["p_revoked_by"], "oauth_refresh_identity_gate");
    assert.match(requests[1]!.url, /\/rest\/v1\/rpc\/revoke_oauth_grants_for_email$/);
    const emailBody = JSON.parse(requests[1]!.body) as Record<string, unknown>;
    assert.equal(emailBody["p_email"], "someone@example.com");
    assert.equal(emailBody["p_revoked_by"], null);
    assert.deepEqual(family, { status: "revoked", familiesRevoked: 1, grantsRevoked: 3, jtisRevoked: 3 });
    assert.deepEqual(email, { status: "revoked", familiesRevoked: 2, grantsRevoked: 4, jtisRevoked: 4 });
  });
});
