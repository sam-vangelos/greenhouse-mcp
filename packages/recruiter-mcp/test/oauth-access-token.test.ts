import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  createOauthAccessTokenValidatorFromEnv,
  mintOauthAccessToken,
  validateOauthAccessToken,
} from "../src/oauth-access-token.js";
import { readOauthAuthorizationConfig, OAUTH_ACCESS_TOKEN_TTL_SECONDS } from "../src/oauth-config.js";
import { validateRemoteAuthorization } from "../src/remote.js";

const STRONG_SESSION_SECRET = "session-secret-value-with-at-least-32-chars";
const OAUTH_SIGNING_SECRET = "oauth-signing-secret-value-with-at-least-32-chars";
const ISSUER = "https://recruiter-mcp.example.com";
const RESOURCE_URL = "https://recruiter-mcp.example.com/mcp";

function oauthEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
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

function requireConfig(env: NodeJS.ProcessEnv) {
  const result = readOauthAuthorizationConfig(env);
  assert.equal(result.state, "configured");
  if (result.state !== "configured") throw new Error("unreachable");
  return result.config;
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

describe("OAuth access tokens (slice 2)", () => {
  it("mints a 3-segment token that the bearer chokepoint accepts as a full recruiter session", async () => {
    const env = oauthEnv();
    const config = requireConfig(env);
    const minted = mintOauthAccessToken(config, {
      email: "recruiter@example.com",
      client: "claude_code",
    });
    assert.equal(minted.token.split(".").length, 3);

    const result = await withRevocationLookup([], () =>
      validateRemoteAuthorization(`Bearer ${minted.token}`, env)
    );
    assert.equal(result.status, "valid");
    if (result.status !== "valid") throw new Error("unreachable");
    assert.equal(result.session.subject, "email:recruiter@example.com");
    assert.equal(result.session.email, "recruiter@example.com");
    assert.equal(result.session.surface, "claude_desktop");
    assert.equal(result.session.client, "claude_code");
    assert.equal(result.session.tokenId, minted.jti);
    assert.ok(result.session.issuedAt);
    assert.equal(new Date(Date.parse(result.session.issuedAt!)).toISOString(), result.session.issuedAt);
  });

  it("still answers exactly 'Malformed recruiter MCP session token.' for 3-segment tokens when OAuth env is absent", async () => {
    const legacyEnv = {
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
      GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS: "example.com",
      GREENHOUSE_RECRUITER_STATE_BACKEND: "supabase_postgrest",
      GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
      GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY: "revocation-key-value",
    } as NodeJS.ProcessEnv;
    // Even a genuinely minted OAuth token must not open a side door on an OAuth-less deployment.
    const config = requireConfig(oauthEnv());
    const minted = mintOauthAccessToken(config, {
      email: "recruiter@example.com",
      client: "claude_code",
    });
    for (const token of [minted.token, "aaa.bbb.ccc"]) {
      const result = await validateRemoteAuthorization(`Bearer ${token}`, legacyEnv);
      assert.equal(result.status, "invalid");
      if (result.status !== "invalid") throw new Error("unreachable");
      assert.equal(result.reason, "Malformed recruiter MCP session token.");
    }
  });

  it("rejects an expired token, honoring a 30-second clock skew", async () => {
    const config = requireConfig(oauthEnv());
    const baseNow = Date.parse("2026-08-18T12:00:00.000Z");
    const minted = mintOauthAccessToken(config, {
      email: "recruiter@example.com",
      client: "claude_code",
      now: () => baseNow,
    });

    const withinSkew = await validateOauthAccessToken(minted.token, config, {
      now: () => baseNow + (OAUTH_ACCESS_TOKEN_TTL_SECONDS + 20) * 1000,
    });
    assert.equal(withinSkew.status, "valid");

    const expired = await validateOauthAccessToken(minted.token, config, {
      now: () => baseNow + (OAUTH_ACCESS_TOKEN_TTL_SECONDS + 40) * 1000,
    });
    assert.equal(expired.status, "invalid");
    if (expired.status !== "invalid") throw new Error("unreachable");
    assert.match(expired.reason, /expired/i);
  });

  it("rejects a tampered payload (signature mismatch)", async () => {
    const config = requireConfig(oauthEnv());
    const minted = mintOauthAccessToken(config, { email: "recruiter@example.com", client: "claude_code" });
    const [header, payload, signature] = minted.token.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<string, unknown>;
    claims["sub"] = "email:someone-else@example.com";
    claims["email"] = "someone-else@example.com";
    const forged = `${header}.${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}.${signature}`;

    const result = await validateOauthAccessToken(forged, config, {});
    assert.equal(result.status, "invalid");
    if (result.status !== "invalid") throw new Error("unreachable");
    assert.match(result.reason, /signature/i);
  });

  it("fails closed (never throws) on an out-of-range iat or exp — R1-F", async () => {
    const config = requireConfig(oauthEnv());
    const minted = mintOauthAccessToken(config, { email: "recruiter@example.com", client: "claude_code" });
    const [header, payload] = minted.token.split(".");
    const base = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<string, unknown>;
    const resign = (claims: Record<string, unknown>): string => {
      const payloadPart = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
      const signature = createHmac("sha256", OAUTH_SIGNING_SECRET).update(`${header}.${payloadPart}`).digest("base64url");
      return `${header}.${payloadPart}.${signature}`;
    };
    // A validly-signed token whose exp/iat is finite but astronomically large must never overflow
    // new Date(seconds * 1000) into an uncaught RangeError (a generic 500); it stays {status:invalid}.
    // exp=1e300 would ALSO read as a never-expiring token under the old finite-only check.
    for (const [label, claims] of [["exp", { ...base, exp: 1e300 }], ["iat", { ...base, iat: 1e300 }]] as const) {
      const result = await validateOauthAccessToken(resign(claims), config, {});
      assert.equal(result.status, "invalid", `out-of-range ${label} must be invalid, not a throw or a never-expiring pass`);
    }
  });

  it("rejects a correctly-signed token whose subject does not bind to its email claim (one-token-one-actor)", async () => {
    const config = requireConfig(oauthEnv());
    const minted = mintOauthAccessToken(config, { email: "recruiter@example.com", client: "claude_code" });
    const [header, payload] = minted.token.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<string, unknown>;
    // Sub names one actor, email names another — both individually well-formed and validly signed.
    claims["sub"] = "email:attacker@example.com";
    claims["email"] = "victim@example.com";
    const payloadPart = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const signature = createHmac("sha256", OAUTH_SIGNING_SECRET).update(`${header}.${payloadPart}`).digest("base64url");

    const result = await validateOauthAccessToken(`${header}.${payloadPart}.${signature}`, config, {});
    assert.equal(result.status, "invalid");
    if (result.status !== "invalid") throw new Error("unreachable");
    assert.match(result.reason, /subject does not bind/i);
  });

  it("boots the env validator fail-closed when the durable state backend is not set", () => {
    const env = oauthEnv({ GREENHOUSE_RECRUITER_STATE_BACKEND: undefined });
    const config = requireConfig(env);
    const validator = createOauthAccessTokenValidatorFromEnv(env, config);
    // A missing backend must yield a fail-closed result, never a live validator.
    assert.ok("status" in validator && validator.status === "invalid", "an unset state backend must fail closed, not silently validate");
  });

  it("rejects alg-none and any non-HS256 header even with a matching signature scheme", async () => {
    const config = requireConfig(oauthEnv());
    const minted = mintOauthAccessToken(config, { email: "recruiter@example.com", client: "claude_code" });
    const [, payload] = minted.token.split(".");
    for (const header of [{ alg: "none", typ: "JWT" }, { alg: "hs256", typ: "JWT" }, { alg: "RS256", typ: "JWT" }]) {
      const headerPart = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
      const signingInput = `${headerPart}.${payload}`;
      const signature = header.alg === "none"
        ? ""
        : createHmac("sha256", OAUTH_SIGNING_SECRET).update(signingInput).digest("base64url");
      const result = await validateOauthAccessToken(`${signingInput}.${signature}`, config, {});
      assert.equal(result.status, "invalid", `alg ${header.alg} must be rejected`);
    }
  });

  it("rejects a token whose audience is not the canonical resource URL", async () => {
    const env = oauthEnv();
    const config = requireConfig(env);
    const otherResourceConfig = requireConfig(oauthEnv({
      GREENHOUSE_RECRUITER_OAUTH_RESOURCE_URL: "https://recruiter-mcp.example.com/other",
    }));
    const minted = mintOauthAccessToken(otherResourceConfig, { email: "recruiter@example.com", client: "claude_code" });
    const result = await validateOauthAccessToken(minted.token, config, {});
    assert.equal(result.status, "invalid");
    if (result.status !== "invalid") throw new Error("unreachable");
    assert.match(result.reason, /audience/i);
  });

  it("rejects a token from a different issuer even when signed with the same secret", async () => {
    const config = requireConfig(oauthEnv());
    const otherIssuerConfig = requireConfig(oauthEnv({
      GREENHOUSE_RECRUITER_OAUTH_ISSUER: "https://other-issuer.example.com",
      GREENHOUSE_RECRUITER_OAUTH_RESOURCE_URL: RESOURCE_URL,
    }));
    const minted = mintOauthAccessToken(otherIssuerConfig, { email: "recruiter@example.com", client: "claude_code" });
    const result = await validateOauthAccessToken(minted.token, config, {});
    assert.equal(result.status, "invalid");
    if (result.status !== "invalid") throw new Error("unreachable");
    assert.match(result.reason, /issuer/i);
  });

  it("kills a session whose jti is revoked in the durable revocation table (same kill switch as legacy)", async () => {
    const env = oauthEnv();
    const config = requireConfig(env);
    const minted = mintOauthAccessToken(config, { email: "recruiter@example.com", client: "claude_code" });

    const result = await withRevocationLookup(
      [{ token_id: minted.jti, status: "revoked" }],
      () => validateRemoteAuthorization(`Bearer ${minted.token}`, env)
    );
    assert.equal(result.status, "invalid");
    if (result.status !== "invalid") throw new Error("unreachable");
    assert.match(result.reason, /has been revoked\./);
  });

  it("honors the static GREENHOUSE_RECRUITER_REVOKED_TOKEN_IDS env list for OAuth jtis", async () => {
    const config = requireConfig(oauthEnv());
    const minted = mintOauthAccessToken(config, { email: "recruiter@example.com", client: "claude_code" });
    const env = oauthEnv({ GREENHOUSE_RECRUITER_REVOKED_TOKEN_IDS: minted.jti });

    const result = await withRevocationLookup([], () =>
      validateRemoteAuthorization(`Bearer ${minted.token}`, env)
    );
    assert.equal(result.status, "invalid");
    if (result.status !== "invalid") throw new Error("unreachable");
    assert.match(result.reason, /has been revoked\./);
  });

  it("fails closed when the revocation lookup cannot be reached", async () => {
    const env = oauthEnv();
    const config = requireConfig(env);
    const minted = mintOauthAccessToken(config, { email: "recruiter@example.com", client: "claude_code" });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    try {
      const result = await validateRemoteAuthorization(`Bearer ${minted.token}`, env);
      assert.equal(result.status, "invalid");
      if (result.status !== "invalid") throw new Error("unreachable");
      assert.match(result.reason, /revocation status could not be verified/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("refuses to mint for a non-canonical email instead of laundering it into a subject", () => {
    const config = requireConfig(oauthEnv());
    assert.throws(() => mintOauthAccessToken(config, { email: "Recruiter@Example.com", client: "claude_code" }));
    assert.throws(() => mintOauthAccessToken(config, { email: " recruiter@example.com", client: "claude_code" }));
  });

  it("keeps legacy 2-segment tokens working unchanged when OAuth is on (no fork regression)", async () => {
    const env = oauthEnv();
    const { createSignedSessionToken } = await import("../src/auth.js");
    const legacyToken = createSignedSessionToken({
      subject: "email:recruiter@example.com",
      email: "recruiter@example.com",
      surface: "chatgpt_desktop",
      tokenId: "legacy-session-under-oauth",
      issuedAt: "2026-06-23T00:00:00.000Z",
    }, STRONG_SESSION_SECRET);

    const result = await withRevocationLookup([], () =>
      validateRemoteAuthorization(`Bearer ${legacyToken}`, env)
    );
    assert.equal(result.status, "valid");
    if (result.status !== "valid") throw new Error("unreachable");
    assert.equal(result.session.tokenId, "legacy-session-under-oauth");
  });
});
