import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSignedSessionToken, createSessionRevocationProviderFromEnv } from "../src/auth.js";
import { createIdentityDirectoryFromEnv } from "../src/identity.js";
import { buildRecruiterMcpReadinessReport } from "../src/readiness.js";
import { validateRemoteAuthorization } from "../src/remote.js";
import type { AuthenticatedSession } from "../src/types.js";

const STRONG_SESSION_SECRET = "recruiter-session-secret-32-characters-minimum";

const session: AuthenticatedSession = {
  subject: "google-oauth2|abc",
  email: "recruiter@example.com",
  surface: "chatgpt_desktop",
  tokenId: "session-1",
  issuedAt: "2026-06-23T00:00:00.000Z",
};

describe("recruiter state backend selector", () => {
  it("selects existing Supabase identity and revocation adapters for supabase_postgrest", async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      if (url.includes("/rest/v1/recruiter_identity_directory")) {
        return new Response(JSON.stringify([{
          greenhouse_user_id: 123,
          primary_email: "recruiter@example.com",
          google_subject: "google-oauth2|abc",
          status: "resolved",
        }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/rest/v1/recruiter_mcp_session_revocation")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    try {
      const env = supabaseStateEnv();
      const directory = createIdentityDirectoryFromEnv(env);
      const revocation = createSessionRevocationProviderFromEnv(env);

      assert.deepEqual(await directory.resolve(session), { status: "resolved", greenhouseUserId: 123 });
      assert.equal(await revocation?.isRevoked(session), false);
      assert.equal(calls.some((url) => url.includes("recruiter_identity_directory")), true);
      assert.equal(calls.some((url) => url.includes("recruiter_mcp_session_revocation")), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails hosted readiness and remote setup for unsupported backend values", async () => {
    const readiness = buildRecruiterMcpReadinessReport({
      ...completeHostedEnv(),
      GREENHOUSE_RECRUITER_STATE_BACKEND: "dynamodb",
    } as NodeJS.ProcessEnv);
    const stateCheck = readiness.checks.find((check) => check.name === "state_backend");

    assert.equal(readiness.ok, false);
    assert.equal(stateCheck?.status, "fail");
    assert.match(stateCheck?.summary ?? "", /not implemented/);

    const token = createSignedSessionToken(session, STRONG_SESSION_SECRET);
    const remote = await validateRemoteAuthorization(`Bearer ${token}`, {
      ...supabaseStateEnv(),
      GREENHOUSE_RECRUITER_STATE_BACKEND: "dynamodb",
    } as NodeJS.ProcessEnv);

    assert.equal(remote.status, "invalid");
    assert.match(remote.status === "invalid" ? remote.reason : "", /not implemented/);
  });

  it("keeps static JSON local-only and prevents it from satisfying hosted readiness", async () => {
    const directory = createIdentityDirectoryFromEnv({
      GREENHOUSE_RECRUITER_IDENTITY_JSON: JSON.stringify([
        { email: "recruiter@example.com", status: "resolved", greenhouseUserId: 123 },
      ]),
    } as NodeJS.ProcessEnv);

    assert.deepEqual(await directory.resolve(session), { status: "resolved", greenhouseUserId: 123 });

    const readiness = buildRecruiterMcpReadinessReport({
      ...completeHostedEnv(),
      GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: undefined,
      GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY: undefined,
      GREENHOUSE_RECRUITER_IDENTITY_JSON: JSON.stringify([
        { email: "recruiter@example.com", status: "resolved", greenhouseUserId: 123 },
      ]),
      GREENHOUSE_RECRUITER_ALLOW_STATIC_IDENTITY_FOR_DEV: "true",
    } as NodeJS.ProcessEnv);
    const identityCheck = readiness.checks.find((check) => check.name === "identity_directory");

    assert.equal(readiness.ok, false);
    assert.equal(identityCheck?.status, "fail");
    assert.match(identityCheck?.summary ?? "", /dev\/test-only/);
  });
});

function supabaseStateEnv(): NodeJS.ProcessEnv {
  return {
    GREENHOUSE_RECRUITER_STATE_BACKEND: "supabase_postgrest",
    GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
    GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
    GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY: "identity-key-value",
    GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
    GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY: "revocation-key-value",
  } as NodeJS.ProcessEnv;
}

function completeHostedEnv(): NodeJS.ProcessEnv {
  return {
    ...supabaseStateEnv(),
    GREENHOUSE_CLIENT_ID: "client-id-value",
    GREENHOUSE_CLIENT_SECRET: "client-secret-value",
    GREENHOUSE_RECRUITER_READYZ_TOKEN: "readiness-token-value-with-at-least-32-chars",
    GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH: "/secure/greenhouse-recruiter-audit.jsonl",
    GREENHOUSE_RECRUITER_CORS_ORIGIN: "https://chatgpt.com,https://claude.ai",
    GREENHOUSE_RECRUITER_FORCE_PERMISSION_TTL_ZERO: "true",
    GREENHOUSE_RECRUITER_RATE_LIMIT_DISABLED: "false",
  } as NodeJS.ProcessEnv;
}
