import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createOauthTokenHandler } from "../src/oauth-token.js";
import { validateOauthAccessToken } from "../src/oauth-access-token.js";
import {
  readOauthAuthorizationConfig,
  OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  OAUTH_AUTHORIZATION_CODE_TTL_SECONDS,
  OAUTH_REFRESH_TOKEN_TTL_SECONDS,
} from "../src/oauth-config.js";
import {
  hashOauthGrantSecret,
  type OauthGrantRecordInput,
  type OauthGrantRow,
  type OauthGrantStore,
} from "../src/oauth-grant-store.js";
import { HttpRequestBodyError, readBoundedFormBody } from "../src/http-request.js";
import { startHttpRecruiterMcp } from "../src/http-server.js";
import { CLAUDE_CODE_CIMD_URL } from "../src/oauth-clients.js";
import type { IdentityDirectory } from "../src/identity.js";

const STRONG_SESSION_SECRET = "session-secret-value-with-at-least-32-chars";
const OAUTH_SIGNING_SECRET = "oauth-signing-secret-value-with-at-least-32-chars";
const ISSUER = "https://recruiter-mcp.example.com";
const RESOURCE_URL = "https://recruiter-mcp.example.com/mcp";
const LOOPBACK_REDIRECT = "http://localhost:53682/callback";
// RFC 7636 appendix B test vector: verifier and its S256 challenge.
const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function oauthEnv(): NodeJS.ProcessEnv {
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
    // The refresh leg re-checks enrollment (CLO-272); the seeded grant's recruiter is enrolled here.
    GREENHOUSE_RECRUITER_IDENTITY_JSON: JSON.stringify([{ email: "recruiter@example.com", status: "resolved", greenhouseUserId: 4242 }]),
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

  json(): Record<string, unknown> {
    return JSON.parse(this.body) as Record<string, unknown>;
  }
}

function formRequest(
  params: Record<string, string>,
  contentType = "application/x-www-form-urlencoded"
): IncomingMessage {
  const body = new URLSearchParams(params).toString();
  const stream = Readable.from([Buffer.from(body, "utf8")]);
  return Object.assign(stream, {
    method: "POST",
    url: "/token",
    headers: {
      "content-type": contentType,
      "content-length": String(Buffer.byteLength(body)),
    },
  }) as unknown as IncomingMessage;
}

function rawRequest(body: string, contentType: string): IncomingMessage {
  const stream = Readable.from([Buffer.from(body, "utf8")]);
  return Object.assign(stream, {
    method: "POST",
    url: "/token",
    headers: { "content-type": contentType, "content-length": String(Buffer.byteLength(body)) },
  }) as unknown as IncomingMessage;
}

interface MutableGrantRow {
  input: OauthGrantRecordInput;
  consumedAt?: string;
  revokedAt?: string;
}

interface MemoryGrantStore extends OauthGrantStore {
  rows: Map<string, MutableGrantRow>;
  revokedFamilies: string[];
  /** jtis the reuse-revoke path copied into the session revocation list (the migration's side effect). */
  revokedTokenIds: Set<string>;
  /** Operator-side revocations the store was asked for (revokeFamily / revokeGrantsForEmail), in order. */
  revocationRequests: Array<{ familyId?: string; email?: string; reason?: string }>;
  seed(input: OauthGrantRecordInput): void;
}

// An in-memory fake that models the migration-0006 RPCs faithfully: consumeGrant mirrors
// redeem_oauth_code (single-winner consume, refuse a revoked family) and redeemRefresh mirrors
// redeem_oauth_refresh (one indivisible consume -> verify -> reuse-revoke -> successor-seat, with
// family revocation as a durable property so a successor can never outlive a killed family).
function memoryGrantStore(now: () => number = () => Date.now()): MemoryGrantStore {
  const rows = new Map<string, MutableGrantRow>();
  const revokedFamilies: string[] = [];
  const revokedFamilySet = new Set<string>();
  const revokedTokenIds = new Set<string>();
  const revocationRequests: Array<{ familyId?: string; email?: string; reason?: string }> = [];
  const toRow = (hash: string, entry: MutableGrantRow): OauthGrantRow => ({
    kind: entry.input.kind,
    tokenHash: hash,
    familyId: entry.input.familyId,
    clientId: entry.input.clientId,
    ...(entry.input.redirectUri !== undefined ? { redirectUri: entry.input.redirectUri } : {}),
    ...(entry.input.codeChallenge !== undefined ? { codeChallenge: entry.input.codeChallenge } : {}),
    email: entry.input.email,
    surface: entry.input.surface,
    client: entry.input.client,
    resource: entry.input.resource,
    ...(entry.input.scope !== undefined ? { scope: entry.input.scope } : {}),
    expiresAt: entry.input.expiresAt,
    ...(entry.consumedAt !== undefined ? { consumedAt: entry.consumedAt } : {}),
    ...(entry.revokedAt !== undefined ? { revokedAt: entry.revokedAt } : {}),
  });
  const revokeFamily = (familyId: string, at: number): void => {
    if (!revokedFamilySet.has(familyId)) {
      revokedFamilySet.add(familyId);
      revokedFamilies.push(familyId);
    }
    for (const entry of rows.values()) {
      if (entry.input.familyId === familyId && entry.revokedAt === undefined) {
        entry.revokedAt = new Date(at).toISOString();
      }
    }
  };
  // Models migration 0007's revoke_oauth_family_locked: rows revoked, family dead, every jti the
  // family minted copied into the session revocation list.
  const sweepFamily = (familyId: string, at: number): { grants: number; jtis: number } => {
    let grants = 0;
    let jtis = 0;
    for (const entry of rows.values()) {
      if (entry.input.familyId !== familyId) continue;
      if (entry.revokedAt === undefined) grants += 1;
      if (entry.input.accessJti !== undefined && !revokedTokenIds.has(entry.input.accessJti)) {
        revokedTokenIds.add(entry.input.accessJti);
        jtis += 1;
      }
    }
    revokeFamily(familyId, at);
    return { grants, jtis };
  };
  return {
    rows,
    revokedFamilies,
    revokedTokenIds,
    revocationRequests,
    seed(input) {
      rows.set(hashOauthGrantSecret(input.secret), { input });
    },
    async peekRefresh(secret) {
      const entry = rows.get(hashOauthGrantSecret(secret));
      if (!entry || entry.input.kind !== "refresh") return { status: "not_found" };
      return {
        status: "found",
        email: entry.input.email,
        familyId: entry.input.familyId,
        clientId: entry.input.clientId,
        surface: entry.input.surface,
        client: entry.input.client,
        consumed: entry.consumedAt !== undefined,
        revoked: entry.revokedAt !== undefined,
      };
    },
    async revokeFamily(familyId, options = {}) {
      revocationRequests.push({ familyId, ...(options.reason !== undefined ? { reason: options.reason } : {}) });
      const known = [...rows.values()].some((entry) => entry.input.familyId === familyId);
      if (!known) return { status: "not_found", familiesRevoked: 0, grantsRevoked: 0, jtisRevoked: 0 };
      const swept = sweepFamily(familyId, now());
      return { status: "revoked", familiesRevoked: 1, grantsRevoked: swept.grants, jtisRevoked: swept.jtis };
    },
    async revokeGrantsForEmail(email, options = {}) {
      revocationRequests.push({ email, ...(options.reason !== undefined ? { reason: options.reason } : {}) });
      const families = new Set(
        [...rows.values()].filter((entry) => entry.input.email === email && entry.revokedAt === undefined).map((entry) => entry.input.familyId)
      );
      let grants = 0;
      let jtis = 0;
      for (const familyId of [...families].sort()) {
        const swept = sweepFamily(familyId, now());
        grants += swept.grants;
        jtis += swept.jtis;
      }
      return { status: "revoked", familiesRevoked: families.size, grantsRevoked: grants, jtisRevoked: jtis };
    },
    async insertGrant(input) {
      rows.set(hashOauthGrantSecret(input.secret), { input });
    },
    async consumeGrant(secret) {
      const hash = hashOauthGrantSecret(secret);
      const entry = rows.get(hash);
      if (
        !entry || entry.consumedAt !== undefined || entry.revokedAt !== undefined ||
        revokedFamilySet.has(entry.input.familyId)
      ) {
        return { status: "not_consumable" };
      }
      entry.consumedAt = new Date(now()).toISOString();
      return { status: "consumed", grant: toRow(hash, entry) };
    },
    async redeemRefresh(input) {
      const hash = hashOauthGrantSecret(input.presentedSecret);
      const entry = rows.get(hash);
      if (!entry) return { status: "not_redeemable", detail: "not_found" };
      const family = entry.input.familyId;
      const familyRevoked = revokedFamilySet.has(family);
      // Migration 0007: the session kill switch reaches the family — any jti this lineage minted
      // that sits in the revocation list makes the whole lineage dead before the token is judged.
      if (!familyRevoked) {
        const jtiRevoked = [...rows.values()].some(
          (other) => other.input.familyId === family && other.input.accessJti !== undefined && revokedTokenIds.has(other.input.accessJti)
        );
        if (jtiRevoked) {
          sweepFamily(family, input.now);
          return { status: "family_revoked" };
        }
      }
      if (entry.consumedAt === undefined && entry.revokedAt === undefined && !familyRevoked) {
        entry.consumedAt = new Date(input.now).toISOString();
        if (entry.input.kind !== "refresh") return { status: "not_redeemable", detail: "wrong_kind" };
        if (Date.parse(entry.input.expiresAt) < input.now) return { status: "not_redeemable", detail: "expired" };
        if (entry.input.clientId !== input.clientId) return { status: "not_redeemable", detail: "client_mismatch" };
        rows.set(hashOauthGrantSecret(input.successorSecret), {
          input: {
            kind: "refresh",
            secret: input.successorSecret,
            familyId: family,
            clientId: entry.input.clientId,
            email: entry.input.email,
            surface: entry.input.surface,
            client: entry.input.client,
            resource: entry.input.resource,
            ...(entry.input.scope !== undefined ? { scope: entry.input.scope } : {}),
            accessJti: input.successorJti,
            expiresAt: input.successorExpiresAt,
          },
        });
        return {
          status: "rotated",
          grant: {
            familyId: family,
            email: entry.input.email,
            surface: entry.input.surface,
            client: entry.input.client,
            resource: entry.input.resource,
            ...(entry.input.scope !== undefined ? { scope: entry.input.scope } : {}),
          },
        };
      }
      if (entry.input.kind === "refresh" && entry.consumedAt !== undefined && !familyRevoked) {
        // Models the migration's in-transaction copy of the family's outstanding jtis into the
        // session revocation list, so a stolen access token dies with the family.
        for (const other of rows.values()) {
          if (other.input.familyId === family && other.input.accessJti !== undefined) {
            revokedTokenIds.add(other.input.accessJti);
          }
        }
        revokeFamily(family, input.now);
        return { status: "reuse_revoked" };
      }
      return { status: "not_redeemable", detail: "not_redeemable" };
    },
  };
}

function seededCodeGrant(store: MemoryGrantStore, overrides: Partial<OauthGrantRecordInput> = {}): OauthGrantRecordInput {
  const input: OauthGrantRecordInput = {
    kind: "code",
    secret: "one-time-authorization-code-secret-value",
    familyId: "11111111-2222-4333-8444-555555555555",
    clientId: CLAUDE_CODE_CIMD_URL,
    redirectUri: LOOPBACK_REDIRECT,
    codeChallenge: CODE_CHALLENGE,
    email: "recruiter@example.com",
    surface: "claude_desktop",
    client: "claude_code",
    resource: RESOURCE_URL,
    scope: "offline_access",
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    ...overrides,
  };
  store.seed(input);
  return input;
}

function exchangeParams(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const params: Record<string, string | undefined> = {
    grant_type: "authorization_code",
    code: "one-time-authorization-code-secret-value",
    redirect_uri: LOOPBACK_REDIRECT,
    client_id: CLAUDE_CODE_CIMD_URL,
    code_verifier: CODE_VERIFIER,
    ...overrides,
  };
  return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined)) as Record<string, string>;
}

async function driveToken(
  handler: ReturnType<typeof createOauthTokenHandler>,
  params: Record<string, string>
): Promise<FakeResponse> {
  const res = new FakeResponse();
  await handler.handleToken(formRequest(params), res as unknown as ServerResponse);
  return res;
}

describe("bounded form reader (slice 7)", () => {
  it("parses a form body and enforces the byte cap with 413", async () => {
    const params = await readBoundedFormBody(formRequest({ a: "1", b: "two" }), 1024);
    assert.equal(params.get("a"), "1");
    assert.equal(params.get("b"), "two");

    await assert.rejects(
      () => readBoundedFormBody(rawRequest("x".repeat(200), "application/x-www-form-urlencoded"), 64),
      (error: unknown) => error instanceof HttpRequestBodyError && error.statusCode === 413
    );
  });

  it("refuses non-form content types with 415 (JSON-only parsers are a named client failure mode, and so is the reverse)", async () => {
    await assert.rejects(
      () => readBoundedFormBody(rawRequest("{\"grant_type\":\"authorization_code\"}", "application/json"), 1024),
      (error: unknown) => error instanceof HttpRequestBodyError && error.statusCode === 415
    );
  });
});

describe("OAuth /token (slice 7)", () => {
  it("round-trips a full exchange: code + PKCE verifier -> access token that IS a valid slice-2 session, plus a refresh token", async () => {
    const config = requireConfig();
    const store = memoryGrantStore();
    seededCodeGrant(store);
    const handler = createOauthTokenHandler(config, oauthEnv(), { grantStore: store });

    const res = await driveToken(handler, exchangeParams());
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body["token_type"], "Bearer");
    assert.equal(body["expires_in"], OAUTH_ACCESS_TOKEN_TTL_SECONDS);
    const accessToken = body["access_token"];
    assert.ok(typeof accessToken === "string" && accessToken.split(".").length === 3);
    const refreshToken = body["refresh_token"];
    assert.ok(typeof refreshToken === "string" && refreshToken.length >= 32);

    const session = await validateOauthAccessToken(accessToken as string, config, {});
    assert.equal(session.status, "valid");
    if (session.status !== "valid") throw new Error("unreachable");
    assert.equal(session.session.subject, "email:recruiter@example.com");
    assert.equal(session.session.client, "claude_code");
    assert.equal(session.session.surface, "claude_desktop");

    // The refresh grant landed in the same family as the code.
    const refreshRow = store.rows.get(hashOauthGrantSecret(refreshToken as string));
    assert.ok(refreshRow);
    assert.equal(refreshRow!.input.kind, "refresh");
    assert.equal(refreshRow!.input.familyId, "11111111-2222-4333-8444-555555555555");
  });

  it("replay: a code redeems exactly once", async () => {
    const config = requireConfig();
    const store = memoryGrantStore();
    seededCodeGrant(store);
    const handler = createOauthTokenHandler(config, oauthEnv(), { grantStore: store });

    const first = await driveToken(handler, exchangeParams());
    assert.equal(first.statusCode, 200);
    const second = await driveToken(handler, exchangeParams());
    assert.equal(second.statusCode, 400);
    assert.equal(second.json()["error"], "invalid_grant");
  });

  it("burns the code even on a wrong PKCE verifier — no retry oracle", async () => {
    const config = requireConfig();
    const store = memoryGrantStore();
    seededCodeGrant(store);
    const handler = createOauthTokenHandler(config, oauthEnv(), { grantStore: store });

    const wrong = await driveToken(handler, exchangeParams({ code_verifier: "wrong-verifier-value-of-sufficient-length-aaaaa" }));
    assert.equal(wrong.statusCode, 400);
    assert.equal(wrong.json()["error"], "invalid_grant");

    // The correct verifier can no longer redeem: the first attempt consumed the code.
    const correctAfterWrong = await driveToken(handler, exchangeParams());
    assert.equal(correctAfterWrong.statusCode, 400);
    assert.equal(correctAfterWrong.json()["error"], "invalid_grant");
  });

  it("rejects a mismatched redirect_uri or client_id with invalid_grant", async () => {
    const config = requireConfig();
    const store = memoryGrantStore();
    seededCodeGrant(store);
    const handler = createOauthTokenHandler(config, oauthEnv(), { grantStore: store });

    const wrongRedirect = await driveToken(handler, exchangeParams({ redirect_uri: "http://localhost:9999/other" }));
    assert.equal(wrongRedirect.json()["error"], "invalid_grant");

    const store2 = memoryGrantStore();
    seededCodeGrant(store2);
    const handler2 = createOauthTokenHandler(config, oauthEnv(), { grantStore: store2 });
    const wrongClient = await driveToken(handler2, exchangeParams({ client_id: "some-other-client" }));
    assert.equal(wrongClient.json()["error"], "invalid_grant");
  });

  it("refuses an expired code with invalid_grant", async () => {
    const config = requireConfig();
    const store = memoryGrantStore();
    seededCodeGrant(store, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const handler = createOauthTokenHandler(config, oauthEnv(), { grantStore: store });

    const res = await driveToken(handler, exchangeParams());
    assert.equal(res.statusCode, 400);
    assert.equal(res.json()["error"], "invalid_grant");
  });

  it("enforces RFC 8707 resource when present on the token request", async () => {
    const config = requireConfig();
    const store = memoryGrantStore();
    seededCodeGrant(store);
    const handler = createOauthTokenHandler(config, oauthEnv(), { grantStore: store });

    const wrong = await driveToken(handler, exchangeParams({ resource: "https://other.example.com/mcp" }));
    assert.equal(wrong.statusCode, 400);
    assert.equal(wrong.json()["error"], "invalid_target");

    const store2 = memoryGrantStore();
    seededCodeGrant(store2);
    const handler2 = createOauthTokenHandler(config, oauthEnv(), { grantStore: store2 });
    const matching = await driveToken(handler2, exchangeParams({ resource: RESOURCE_URL }));
    assert.equal(matching.statusCode, 200);
  });

  it("rotates refresh tokens, and a reused (already-rotated) refresh token revokes the whole family FIRST", async () => {
    const config = requireConfig();
    const store = memoryGrantStore();
    seededCodeGrant(store);
    const handler = createOauthTokenHandler(config, oauthEnv(), { grantStore: store });

    const exchange = await driveToken(handler, exchangeParams());
    const refresh1 = exchange.json()["refresh_token"] as string;

    const rotate = await driveToken(handler, {
      grant_type: "refresh_token",
      refresh_token: refresh1,
      client_id: CLAUDE_CODE_CIMD_URL,
    });
    assert.equal(rotate.statusCode, 200, rotate.body);
    const rotated = rotate.json();
    const refresh2 = rotated["refresh_token"] as string;
    assert.ok(typeof refresh2 === "string" && refresh2.length >= 32);
    assert.notEqual(refresh2, refresh1);
    const newAccess = await validateOauthAccessToken(rotated["access_token"] as string, config, {});
    assert.equal(newAccess.status, "valid");

    // Reuse of the OLD refresh token: invalid_grant AND the family dies first.
    const reuse = await driveToken(handler, {
      grant_type: "refresh_token",
      refresh_token: refresh1,
      client_id: CLAUDE_CODE_CIMD_URL,
    });
    assert.equal(reuse.statusCode, 400);
    assert.equal(reuse.json()["error"], "invalid_grant");
    assert.deepEqual(store.revokedFamilies, ["11111111-2222-4333-8444-555555555555"]);

    // The revoked family takes the NEW refresh token down with it.
    const afterRevocation = await driveToken(handler, {
      grant_type: "refresh_token",
      refresh_token: refresh2,
      client_id: CLAUDE_CODE_CIMD_URL,
    });
    assert.equal(afterRevocation.statusCode, 400);
    assert.equal(afterRevocation.json()["error"], "invalid_grant");
  });

  it("answers unknown grant types with unsupported_grant_type and unknown refresh tokens with invalid_grant (no family side effects)", async () => {
    const config = requireConfig();
    const store = memoryGrantStore();
    const handler = createOauthTokenHandler(config, oauthEnv(), { grantStore: store });

    const unsupported = await driveToken(handler, { grant_type: "password", username: "x", password: "y" });
    assert.equal(unsupported.statusCode, 400);
    assert.equal(unsupported.json()["error"], "unsupported_grant_type");

    const unknown = await driveToken(handler, {
      grant_type: "refresh_token",
      refresh_token: "never-issued-refresh-token-value",
      client_id: CLAUDE_CODE_CIMD_URL,
    });
    assert.equal(unknown.statusCode, 400);
    assert.equal(unknown.json()["error"], "invalid_grant");
    assert.deepEqual(store.revokedFamilies, []);
  });

  it("refuses non-form bodies with 415 at the endpoint (the named client failure mode is JSON-only parsing; ours must parse forms)", async () => {
    const config = requireConfig();
    const handler = createOauthTokenHandler(config, oauthEnv(), { grantStore: memoryGrantStore() });
    const res = new FakeResponse();
    await handler.handleToken(rawRequest("{\"grant_type\":\"authorization_code\"}", "application/json"), res as unknown as ServerResponse);
    assert.equal(res.statusCode, 415);
  });

  it("mounts POST /token on the real server when OAuth is on, and keeps it dark otherwise (additivity)", async () => {
    const configured = await startHttpRecruiterMcp(oauthEnv());
    try {
      const address = configured.address();
      assert.ok(address && typeof address === "object");
      const response = await fetch(`http://127.0.0.1:${address.port}/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 415, "the mounted endpoint must reject non-form bodies itself");
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
      const response = await fetch(`http://127.0.0.1:${address.port}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code",
      });
      assert.equal(response.status, 404, "/token must stay dark without OAuth env");
      assert.deepEqual(await response.json(), { error: "not_found" });
    } finally {
      await new Promise<void>((resolve, reject) => dark.close((e) => e ? reject(e) : resolve()));
    }
  });
});

function decodeClaims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("OAuth grant-type + refresh-leg locks (R1-D)", () => {
  it("refuses a code secret presented on the refresh leg — invalid_grant, ZERO issuance (grant-kind confusion, no PKCE bypass)", async () => {
    const config = requireConfig();
    const store = memoryGrantStore();
    const code = seededCodeGrant(store);
    const handler = createOauthTokenHandler(config, oauthEnv(), { grantStore: store });

    const res = await driveToken(handler, { grant_type: "refresh_token", refresh_token: code.secret, client_id: CLAUDE_CODE_CIMD_URL });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json()["error"], "invalid_grant");
    assert.equal(res.json()["access_token"], undefined, "a code redeemed as a refresh must mint NO token");
  });

  it("refuses a refresh secret presented on the code leg — invalid_grant, ZERO issuance (grant-kind confusion)", async () => {
    const config = requireConfig();
    const store = memoryGrantStore();
    store.seed({
      kind: "refresh",
      secret: "a-refresh-token-secret-value-on-the-code-leg-aaaa",
      familyId: "11111111-2222-4333-8444-555555555555",
      clientId: CLAUDE_CODE_CIMD_URL,
      email: "recruiter@example.com",
      surface: "claude_desktop",
      client: "claude_code",
      resource: RESOURCE_URL,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    const handler = createOauthTokenHandler(config, oauthEnv(), { grantStore: store });

    const res = await driveToken(handler, exchangeParams({ code: "a-refresh-token-secret-value-on-the-code-leg-aaaa" }));
    assert.equal(res.statusCode, 400);
    assert.equal(res.json()["error"], "invalid_grant");
    assert.equal(res.json()["access_token"], undefined);
  });

  it("binds the token TTLs to their literal seconds and puts expires_in=3600 on the wire (not a tautology)", async () => {
    assert.equal(OAUTH_ACCESS_TOKEN_TTL_SECONDS, 3600);
    assert.equal(OAUTH_AUTHORIZATION_CODE_TTL_SECONDS, 300);
    assert.equal(OAUTH_REFRESH_TOKEN_TTL_SECONDS, 2_592_000);

    const store = memoryGrantStore();
    seededCodeGrant(store);
    const handler = createOauthTokenHandler(requireConfig(), oauthEnv(), { grantStore: store });
    const res = await driveToken(handler, exchangeParams());
    assert.equal(res.statusCode, 200);
    assert.equal(res.json()["expires_in"], 3600);
  });

  it("rejects a rotation from the wrong client_id with invalid_grant (refresh-leg client binding)", async () => {
    const config = requireConfig();
    const store = memoryGrantStore();
    seededCodeGrant(store);
    const handler = createOauthTokenHandler(config, oauthEnv(), { grantStore: store });
    const refresh1 = (await driveToken(handler, exchangeParams())).json()["refresh_token"] as string;

    const res = await driveToken(handler, { grant_type: "refresh_token", refresh_token: refresh1, client_id: "https://claude.ai/oauth/some-other-client-metadata" });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json()["error"], "invalid_grant");
  });

  it("rejects a rotation of an expired refresh token with invalid_grant (refresh-leg expiry)", async () => {
    const config = requireConfig();
    const store = memoryGrantStore();
    store.seed({
      kind: "refresh",
      secret: "an-expired-refresh-token-secret-value-bbbbbbbbbbbb",
      familyId: "11111111-2222-4333-8444-555555555555",
      clientId: CLAUDE_CODE_CIMD_URL,
      email: "recruiter@example.com",
      surface: "claude_desktop",
      client: "claude_code",
      resource: RESOURCE_URL,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const handler = createOauthTokenHandler(config, oauthEnv(), { grantStore: store });

    const res = await driveToken(handler, { grant_type: "refresh_token", refresh_token: "an-expired-refresh-token-secret-value-bbbbbbbbbbbb", client_id: CLAUDE_CODE_CIMD_URL });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json()["error"], "invalid_grant");
  });
});

describe("OAuth session durability (R1-B)", () => {
  it("persists the minted access-token jti on the refresh row and carries the durable sid=family", async () => {
    const config = requireConfig();
    const store = memoryGrantStore();
    const seeded = seededCodeGrant(store);
    const handler = createOauthTokenHandler(config, oauthEnv(), { grantStore: store, generateJti: () => "access-jti-fixed-value" });

    const res = await driveToken(handler, exchangeParams());
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    const claims = decodeClaims(body["access_token"] as string);
    // The token's jti and its durable sid: sid is the grant family, stable across rotation.
    assert.equal(claims["jti"], "access-jti-fixed-value");
    assert.equal(claims["sid"], seeded.familyId);

    // That same jti is persisted on the successor refresh row, so the kill switch can reach it.
    const refreshRow = store.rows.get(hashOauthGrantSecret(body["refresh_token"] as string));
    assert.ok(refreshRow);
    assert.equal(refreshRow!.input.accessJti, "access-jti-fixed-value");
  });

  it("carries the SAME sid across a rotation but a fresh jti (durable session, rotating token)", async () => {
    const config = requireConfig();
    const store = memoryGrantStore();
    const seeded = seededCodeGrant(store);
    let n = 0;
    const handler = createOauthTokenHandler(config, oauthEnv(), { grantStore: store, generateJti: () => `access-jti-${++n}` });

    const exchange = (await driveToken(handler, exchangeParams())).json();
    const first = decodeClaims(exchange["access_token"] as string);
    const rotate = await driveToken(handler, { grant_type: "refresh_token", refresh_token: exchange["refresh_token"] as string, client_id: CLAUDE_CODE_CIMD_URL });
    const second = decodeClaims(rotate.json()["access_token"] as string);

    assert.equal(first["sid"], seeded.familyId);
    assert.equal(second["sid"], seeded.familyId, "sid is durable across rotation");
    assert.notEqual(first["jti"], second["jti"], "the access-token jti still rotates");
  });

  it("copies the family's outstanding access-token jtis into the revocation list on a refresh-reuse", async () => {
    const config = requireConfig();
    const store = memoryGrantStore();
    seededCodeGrant(store);
    let n = 0;
    const handler = createOauthTokenHandler(config, oauthEnv(), { grantStore: store, generateJti: () => `access-jti-${++n}` });

    const exchange = await driveToken(handler, exchangeParams());
    const refresh1 = exchange.json()["refresh_token"] as string; // minted alongside access-jti-1
    const rotate = await driveToken(handler, { grant_type: "refresh_token", refresh_token: refresh1, client_id: CLAUDE_CODE_CIMD_URL });
    assert.equal(rotate.statusCode, 200); // successor minted alongside access-jti-2

    // Reuse the already-rotated refresh token: the family dies AND both outstanding jtis are killed.
    const reuse = await driveToken(handler, { grant_type: "refresh_token", refresh_token: refresh1, client_id: CLAUDE_CODE_CIMD_URL });
    assert.equal(reuse.statusCode, 400);
    assert.equal(reuse.json()["error"], "invalid_grant");
    assert.ok(store.revokedTokenIds.has("access-jti-1"), "the code-exchange access token jti must be revoked");
    assert.ok(store.revokedTokenIds.has("access-jti-2"), "the rotated access token jti must be revoked");
  });
});

// Sanity: the RFC 7636 appendix B vector actually matches (S256(verifier) === challenge).
void ((): void => {
  const digest = createHash("sha256").update(CODE_VERIFIER, "ascii").digest("base64url");
  assert.equal(digest, CODE_CHALLENGE);
})();

// CLO-272: the refresh leg is where a de-enrolled hosted-Claude session gets ended, and where an
// operator's jti revocation reaches the whole family.
describe("OAuth refresh identity gate and family termination (CLO-272)", () => {
  const unresolvedDirectory: IdentityDirectory = {
    async resolve() {
      return { status: "unresolved", reason: "Recruiter identity mapping is not resolved." };
    },
  };
  const brokenDirectory: IdentityDirectory = {
    async resolve() {
      throw new Error("Identity directory lookup failed with status 503.");
    },
  };

  async function exchangedRefresh(store: MemoryGrantStore): Promise<{ refresh: string; jti: string }> {
    seededCodeGrant(store);
    const handler = createOauthTokenHandler(requireConfig(), oauthEnv(), { grantStore: store });
    const exchange = await driveToken(handler, exchangeParams());
    assert.equal(exchange.statusCode, 200, exchange.body);
    const refresh = exchange.json()["refresh_token"] as string;
    const row = store.rows.get(hashOauthGrantSecret(refresh))!;
    return { refresh, jti: row.input.accessJti! };
  }

  it("a recruiter who is no longer enrolled is refused on refresh, the family is swept, and the presented token is NOT consumed", async () => {
    const store = memoryGrantStore();
    const { refresh, jti } = await exchangedRefresh(store);
    const handler = createOauthTokenHandler(requireConfig(), oauthEnv(), { grantStore: store, identityDirectory: unresolvedDirectory });

    const denied = await driveToken(handler, { grant_type: "refresh_token", refresh_token: refresh, client_id: CLAUDE_CODE_CIMD_URL });
    assert.equal(denied.statusCode, 400, denied.body);
    assert.equal(denied.json()["error"], "invalid_grant");
    assert.deepEqual(store.revocationRequests, [{ familyId: "11111111-2222-4333-8444-555555555555", reason: "identity_unresolved" }]);
    assert.deepEqual(store.revokedFamilies, ["11111111-2222-4333-8444-555555555555"]);
    assert.ok(store.revokedTokenIds.has(jti), "the access-token jti minted with the family lands on the revocation list");
    assert.equal(store.rows.get(hashOauthGrantSecret(refresh))!.consumedAt, undefined, "the gate runs BEFORE the rotation consumes the token");

    // Even a recruiter who is re-enrolled cannot revive the dead family — a fresh sign-in is the only way back.
    const resolvedAgain = createOauthTokenHandler(requireConfig(), oauthEnv(), { grantStore: store });
    const afterwards = await driveToken(resolvedAgain, { grant_type: "refresh_token", refresh_token: refresh, client_id: CLAUDE_CODE_CIMD_URL });
    assert.equal(afterwards.statusCode, 400);
    assert.equal(afterwards.json()["error"], "invalid_grant");
  });

  it("a directory outage is 503 temporarily_unavailable: nothing consumed, nothing revoked, and the same token rotates once the directory is back", async () => {
    const store = memoryGrantStore();
    const { refresh } = await exchangedRefresh(store);
    const outage = createOauthTokenHandler(requireConfig(), oauthEnv(), { grantStore: store, identityDirectory: brokenDirectory });

    const blip = await driveToken(outage, { grant_type: "refresh_token", refresh_token: refresh, client_id: CLAUDE_CODE_CIMD_URL });
    assert.equal(blip.statusCode, 503, blip.body);
    assert.equal(blip.json()["error"], "temporarily_unavailable");
    assert.deepEqual(store.revokedFamilies, []);
    assert.deepEqual(store.revocationRequests, []);
    assert.equal(store.rows.get(hashOauthGrantSecret(refresh))!.consumedAt, undefined);

    const recovered = createOauthTokenHandler(requireConfig(), oauthEnv(), { grantStore: store });
    const rotate = await driveToken(recovered, { grant_type: "refresh_token", refresh_token: refresh, client_id: CLAUDE_CODE_CIMD_URL });
    assert.equal(rotate.statusCode, 200, rotate.body);
  });

  it("a grants-store outage on the peek is 503 temporarily_unavailable — never invalid_grant, which would make the client drop the session", async () => {
    const store = memoryGrantStore();
    const { refresh } = await exchangedRefresh(store);
    const peekBroken: MemoryGrantStore = { ...store, async peekRefresh() { throw new Error("OAuth refresh peek failed with status 503."); } };
    const handler = createOauthTokenHandler(requireConfig(), oauthEnv(), { grantStore: peekBroken });
    const blip = await driveToken(handler, { grant_type: "refresh_token", refresh_token: refresh, client_id: CLAUDE_CODE_CIMD_URL });
    assert.equal(blip.statusCode, 503, blip.body);
    assert.equal(blip.json()["error"], "temporarily_unavailable");
    assert.equal(store.rows.get(hashOauthGrantSecret(refresh))!.consumedAt, undefined);
    assert.deepEqual(store.revocationRequests, []);
  });

  it("an operator's jti revocation (greenhouse-recruiter-revoke-session) reaches the family: the next refresh is refused and every jti the family minted is revoked", async () => {
    const store = memoryGrantStore();
    const { refresh, jti } = await exchangedRefresh(store);
    // The kill switch: the operator revoked the current access token's jti.
    store.revokedTokenIds.add(jti);

    const handler = createOauthTokenHandler(requireConfig(), oauthEnv(), { grantStore: store });
    const denied = await driveToken(handler, { grant_type: "refresh_token", refresh_token: refresh, client_id: CLAUDE_CODE_CIMD_URL });
    assert.equal(denied.statusCode, 400, denied.body);
    assert.equal(denied.json()["error"], "invalid_grant");
    assert.deepEqual(store.revokedFamilies, ["11111111-2222-4333-8444-555555555555"], "the family is dead, not just the one jti");
    assert.equal(store.rows.get(hashOauthGrantSecret(refresh))!.revokedAt !== undefined, true);
  });

  it("an enrolled recruiter's refresh still rotates normally — the gate is transparent to the healthy path", async () => {
    const store = memoryGrantStore();
    const { refresh } = await exchangedRefresh(store);
    const handler = createOauthTokenHandler(requireConfig(), oauthEnv(), { grantStore: store });
    const rotate = await driveToken(handler, { grant_type: "refresh_token", refresh_token: refresh, client_id: CLAUDE_CODE_CIMD_URL });
    assert.equal(rotate.statusCode, 200, rotate.body);
    assert.deepEqual(store.revocationRequests, []);
  });

  it("a refresh token the store does not know skips the gate and is refused as before (no directory call, no revocation)", async () => {
    const store = memoryGrantStore();
    let directoryCalls = 0;
    const counting: IdentityDirectory = { async resolve() { directoryCalls += 1; return { status: "resolved", greenhouseUserId: 4242 }; } };
    const handler = createOauthTokenHandler(requireConfig(), oauthEnv(), { grantStore: store, identityDirectory: counting });
    const denied = await driveToken(handler, { grant_type: "refresh_token", refresh_token: "never-issued-refresh-token-value", client_id: CLAUDE_CODE_CIMD_URL });
    assert.equal(denied.statusCode, 400);
    assert.equal(denied.json()["error"], "invalid_grant");
    assert.equal(directoryCalls, 0);
    assert.deepEqual(store.revocationRequests, []);
  });
});
