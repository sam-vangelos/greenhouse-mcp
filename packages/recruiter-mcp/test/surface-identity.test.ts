import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSessionFromEnv } from "../src/auth.js";
import { issueDirectoryVerifiedEmailSessionToken } from "../src/email-session.js";
import { createIdentityActorResolver, createStaticIdentityDirectory } from "../src/identity.js";
import { validateRemoteAuthorization } from "../src/remote.js";

const STRONG_SESSION_SECRET = "recruiter-session-secret-32-characters-minimum";

describe("desktop surface identity contract", () => {
  it("resolves Claude local and ChatGPT remote sessions for the same verified email to the same Greenhouse actor", async () => {
    const directory = createStaticIdentityDirectory([
      { email: "recruiter@company.com", status: "resolved", greenhouseUserId: 789 },
    ]);
    const issuerConfig = {
      secret: STRONG_SESSION_SECRET,
      allowedDomains: ["company.com"],
      now: () => Date.parse("2026-06-23T12:00:00.000Z"),
    };
    const claude = await issueDirectoryVerifiedEmailSessionToken(
      { ...issuerConfig, tokenId: () => "claude-session" },
      { email: "Recruiter@Company.com", surface: "claude_desktop" },
      directory
    );
    const chatgpt = await issueDirectoryVerifiedEmailSessionToken(
      { ...issuerConfig, tokenId: () => "chatgpt-session" },
      { email: "recruiter@company.com", surface: "chatgpt_desktop" },
      directory
    );

    const claudeSession = await readSessionFromEnv({
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
      GREENHOUSE_RECRUITER_SESSION_TOKEN: claude.token,
    } as NodeJS.ProcessEnv);
    const chatgptSession = await withRevocationLookup(async () => (
      validateRemoteAuthorization(`Bearer ${chatgpt.token}`, {
        GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
        GREENHOUSE_RECRUITER_STATE_BACKEND: "supabase_postgrest",
        GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
        GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY: "revocation-key-value",
      } as NodeJS.ProcessEnv)
    ));
    assert.equal(claudeSession.status, "valid");
    assert.equal(chatgptSession.status, "valid");

    const resolver = createIdentityActorResolver(directory);
    const claudeActor = await resolver.resolveActor(claudeSession.status === "valid" ? claudeSession.session : assert.fail("Claude session invalid"));
    const chatgptActor = await resolver.resolveActor(chatgptSession.status === "valid" ? chatgptSession.session : assert.fail("ChatGPT session invalid"));

    assert.equal(claudeActor, 789);
    assert.equal(chatgptActor, 789);
    assert.equal(claudeActor, chatgptActor);
  });
});

async function withRevocationLookup<T>(fn: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://exampleprojectref000.supabase.co/rest/v1/recruiter_mcp_session_revocation")) {
      return new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return originalFetch(input as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}
