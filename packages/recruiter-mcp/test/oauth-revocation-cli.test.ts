import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseOauthRevocationArgs,
  readOauthRevocationAccessFromEnv,
  revokeOauthGrantsFromEnv,
} from "../src/oauth-revocation-cli.js";

const CANONICAL = "https://exampleprojectref000.supabase.co";

interface Captured { url: string; method: string; body: unknown; headers: Record<string, string> }

function recordingFetch(
  respond: (captured: Captured, index: number) => Response
): { fetchImpl: typeof fetch; requests: Captured[] } {
  const requests: Captured[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const captured: Captured = {
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
    };
    requests.push(captured);
    return respond(captured, requests.length - 1);
  }) as typeof fetch;
  return { fetchImpl, requests };
}

describe("greenhouse-recruiter-revoke-oauth (CLO-272)", () => {
  it("parses exactly one target — an email or a family id — plus reason and revoked-by", () => {
    assert.deepEqual(parseOauthRevocationArgs(["--email", "Someone@Example.com", "--reason", "offboarded"]), {
      email: "Someone@Example.com",
      reason: "offboarded",
    });
    assert.deepEqual(parseOauthRevocationArgs(["--family-id", "fam-1", "--revoked-by", "ops@example.com"]), {
      familyId: "fam-1",
      revokedBy: "ops@example.com",
    });
    assert.throws(() => parseOauthRevocationArgs([]), /Usage: greenhouse-recruiter-revoke-oauth/);
    assert.throws(() => parseOauthRevocationArgs(["--email", "a@example.com", "--family-id", "f"]), /Usage/);
  });

  it("reaches the RPCs with the OAuth Supabase pair, or the identity pair for the same canonical project", () => {
    const viaOauth = readOauthRevocationAccessFromEnv({
      GREENHOUSE_RECRUITER_OAUTH_SUPABASE_URL: CANONICAL,
      GREENHOUSE_RECRUITER_OAUTH_SUPABASE_KEY: "oauth-key-value",
      GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: CANONICAL,
      GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY: "identity-key-value",
    } as NodeJS.ProcessEnv);
    assert.equal(viaOauth.apiKey, "oauth-key-value");
    const viaIdentity = readOauthRevocationAccessFromEnv({
      GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: CANONICAL,
      GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY: "identity-key-value",
    } as NodeJS.ProcessEnv);
    assert.equal(viaIdentity.apiKey, "identity-key-value");
    assert.throws(() => readOauthRevocationAccessFromEnv({} as NodeJS.ProcessEnv), /GREENHOUSE_RECRUITER_OAUTH_SUPABASE_URL/);
    // A non-canonical project is refused before any request is made.
    assert.throws(
      () => readOauthRevocationAccessFromEnv({
        GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: "https://otherprojectref00000.supabase.co",
        GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY: "k",
      } as NodeJS.ProcessEnv),
      /canonical/
    );
  });

  it("revokes every family of an email through revoke_oauth_grants_for_email and reports the counts", async () => {
    const { fetchImpl, requests } = recordingFetch(() =>
      new Response(JSON.stringify({ status: "revoked", email: "someone@example.com", families_revoked: 2, grants_revoked: 5, jtis_revoked: 5 }), { status: 200 })
    );
    const report = await revokeOauthGrantsFromEnv(
      { GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: CANONICAL, GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY: "identity-key-value" } as NodeJS.ProcessEnv,
      ["--email", "Someone@Example.com", "--reason", "offboarded", "--revoked-by", "ops@example.com"],
      fetchImpl
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, `${CANONICAL}/rest/v1/rpc/revoke_oauth_grants_for_email`);
    assert.equal(requests[0]!.method, "POST");
    const body = requests[0]!.body as Record<string, unknown>;
    assert.equal(body["p_email"], "someone@example.com");
    assert.equal(body["p_reason"], "offboarded");
    assert.equal(body["p_revoked_by"], "ops@example.com");
    assert.equal(report.status, "revoked");
    assert.equal(report.familiesRevoked, 2);
    assert.equal(report.jtisRevoked, 5);
    assert.equal(report.containsTokens, false);
  });

  it("revokes one family through revoke_oauth_family and surfaces not_found honestly", async () => {
    const { fetchImpl, requests } = recordingFetch(() =>
      new Response(JSON.stringify({ status: "not_found", family_id: "fam-1" }), { status: 200 })
    );
    const report = await revokeOauthGrantsFromEnv(
      { GREENHOUSE_RECRUITER_OAUTH_SUPABASE_URL: CANONICAL, GREENHOUSE_RECRUITER_OAUTH_SUPABASE_KEY: "oauth-key-value" } as NodeJS.ProcessEnv,
      ["--family-id", "fam-1"],
      fetchImpl
    );
    assert.equal(requests[0]!.url, `${CANONICAL}/rest/v1/rpc/revoke_oauth_family`);
    assert.equal((requests[0]!.body as Record<string, unknown>)["p_family_id"], "fam-1");
    assert.equal(report.status, "not_found");
    assert.equal(report.familiesRevoked, 0);
  });

  it("retries once when PostgREST has not loaded the function yet (PGRST202), then succeeds", async () => {
    const { fetchImpl, requests } = recordingFetch((_captured, index) =>
      index === 0
        ? new Response(JSON.stringify({ code: "PGRST202", message: "Could not find the function" }), { status: 404 })
        : new Response(JSON.stringify({ status: "revoked", families_revoked: 1, grants_revoked: 1, jtis_revoked: 1 }), { status: 200 })
    );
    const report = await revokeOauthGrantsFromEnv(
      { GREENHOUSE_RECRUITER_OAUTH_SUPABASE_URL: CANONICAL, GREENHOUSE_RECRUITER_OAUTH_SUPABASE_KEY: "oauth-key-value" } as NodeJS.ProcessEnv,
      ["--family-id", "fam-1"],
      fetchImpl
    );
    assert.equal(requests.length, 2);
    assert.equal(report.status, "revoked");
  });

  it("does not retry a real failure — a 500 surfaces as an error, once", async () => {
    const { fetchImpl, requests } = recordingFetch(() => new Response("boom", { status: 500 }));
    await assert.rejects(
      () => revokeOauthGrantsFromEnv(
        { GREENHOUSE_RECRUITER_OAUTH_SUPABASE_URL: CANONICAL, GREENHOUSE_RECRUITER_OAUTH_SUPABASE_KEY: "oauth-key-value" } as NodeJS.ProcessEnv,
        ["--email", "someone@example.com"],
        fetchImpl
      ),
      /status 500/
    );
    assert.equal(requests.length, 1);
  });
});
