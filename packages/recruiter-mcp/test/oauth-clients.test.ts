import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CLAUDE_CODE_CIMD_URL, resolveOauthClient } from "../src/oauth-clients.js";
import { isClientSurfaceCompatible } from "../src/auth.js";
import { readOauthAuthorizationConfig } from "../src/oauth-config.js";

const STRONG_SESSION_SECRET = "session-secret-value-with-at-least-32-chars";
const OAUTH_SIGNING_SECRET = "oauth-signing-secret-value-with-at-least-32-chars";
const ISSUER = "https://recruiter-mcp.example.com";
const RESOURCE_URL = "https://recruiter-mcp.example.com/mcp";
const HOSTED_CIMD_URL = "https://claude.ai/oauth/hosted-chat-client-metadata";
const STATIC_CLIENT_ID = "org-connector-fallback-client";
const STATIC_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";

function oauthEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
    GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS: "example.com",
    GREENHOUSE_RECRUITER_OAUTH_SIGNING_SECRET: OAUTH_SIGNING_SECRET,
    GREENHOUSE_RECRUITER_OAUTH_ISSUER: ISSUER,
    GREENHOUSE_RECRUITER_OAUTH_RESOURCE_URL: RESOURCE_URL,
    GREENHOUSE_RECRUITER_OAUTH_GOOGLE_CLIENT_ID: "google-client-id-value.apps.googleusercontent.com",
    GREENHOUSE_RECRUITER_OAUTH_GOOGLE_CLIENT_SECRET: "google-client-secret-value",
    GREENHOUSE_RECRUITER_OAUTH_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
    GREENHOUSE_RECRUITER_OAUTH_SUPABASE_KEY: "oauth-grants-key-value",
    GREENHOUSE_RECRUITER_OAUTH_STATIC_CLIENT_ID: STATIC_CLIENT_ID,
    GREENHOUSE_RECRUITER_OAUTH_STATIC_CLIENT_REDIRECT_URIS: STATIC_REDIRECT,
    ...extra,
  } as NodeJS.ProcessEnv;
}

function requireConfig(env: NodeJS.ProcessEnv = oauthEnv()) {
  const result = readOauthAuthorizationConfig(env);
  assert.equal(result.state, "configured");
  if (result.state !== "configured") throw new Error("unreachable");
  return result.config;
}

function trackingFetch(responder?: (url: string) => Response): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (!responder) throw new Error(`unexpected fetch: ${url}`);
    return responder(url);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("OAuth client resolution (slice 5)", () => {
  it("resolves the exact Claude Code CIMD literal to claude_code with port-ignored loopback redirects, no fetch", async () => {
    const { fetchImpl, calls } = trackingFetch();
    for (const redirect of [
      "http://localhost:53682/callback",
      "http://localhost/callback",
      "http://127.0.0.1:41234/callback",
      "http://127.0.0.1/callback",
    ]) {
      const result = await resolveOauthClient(requireConfig(), {
        clientId: CLAUDE_CODE_CIMD_URL,
        redirectUri: redirect,
        fetchImpl,
      });
      assert.equal(result.status, "resolved", `expected resolution for ${redirect}`);
      if (result.status !== "resolved") throw new Error("unreachable");
      assert.equal(result.client, "claude_code");
      assert.equal(result.surface, "claude_desktop");
      assert.ok(isClientSurfaceCompatible(result.client, result.surface));
    }
    assert.equal(calls.length, 0, "the known Claude Code client must resolve without any network fetch");
  });

  it("refuses a non-loopback redirect for the Claude Code client", async () => {
    const { fetchImpl } = trackingFetch();
    for (const redirect of [
      "https://evil.example.com/callback",
      "http://localhost:1234/other-path",
      "http://192.168.0.10/callback",
    ]) {
      const result = await resolveOauthClient(requireConfig(), {
        clientId: CLAUDE_CODE_CIMD_URL,
        redirectUri: redirect,
        fetchImpl,
      });
      assert.equal(result.status, "invalid_redirect", `expected refusal for ${redirect}`);
    }
  });

  it("resolves another claude.ai-origin CIMD to hosted Claude chat with an exact-HTTPS redirect match", async () => {
    const { fetchImpl, calls } = trackingFetch(() => new Response(JSON.stringify({
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await resolveOauthClient(requireConfig(), {
      clientId: HOSTED_CIMD_URL,
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      fetchImpl,
    });
    assert.equal(result.status, "resolved");
    if (result.status !== "resolved") throw new Error("unreachable");
    assert.equal(result.client, "claude_desktop_chat");
    assert.equal(result.surface, "claude_desktop");
    assert.deepEqual(calls, [HOSTED_CIMD_URL]);
  });

  it("refuses a redirect that is not listed in the fetched CIMD document", async () => {
    const { fetchImpl } = trackingFetch(() => new Response(JSON.stringify({
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await resolveOauthClient(requireConfig(), {
      clientId: HOSTED_CIMD_URL,
      redirectUri: "https://claude.ai/api/mcp/other_callback",
      fetchImpl,
    });
    assert.equal(result.status, "invalid_redirect");
  });

  it("rejects untrusted CIMD URLs WITHOUT fetching them (SSRF containment)", async () => {
    const { fetchImpl, calls } = trackingFetch();
    for (const clientId of [
      "https://evil.example.com/client-metadata",
      "https://claude.ai.evil.example.com/metadata",
      "http://claude.ai/oauth/downgraded-to-http",
      "https://internal-service.local/metadata",
      "https://chatgpt.com.evil.example.com/oauth/client.json",
      "https://chatgpt.com@evil.example.com/oauth/client.json",
      "http://chatgpt.com/oauth/client.json",
      "https://chatgpt.com:8443/oauth/client.json",
      "https://chatgpt.com/share/client.json",
      "https://chatgpt.com/oauth/client.json?url=https://evil.example.com",
      "https://chatgpt.com/oauth/client.json#fragment",
      "https://chatgpt.com/oauth/a/b/client.json",
      "https://chatgpt.com/oauth/%2e%2e/client.json",
    ]) {
      const result = await resolveOauthClient(requireConfig(), {
        clientId,
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
        fetchImpl,
      });
      assert.equal(result.status, "invalid_client", `expected invalid_client for ${clientId}`);
    }
    assert.equal(calls.length, 0, "no untrusted metadata URL may ever be fetched");
  });

  it("discovers both ChatGPT metadata URL forms without static registration and preserves ChatGPT attribution", async () => {
    const config = requireConfig(oauthEnv({
      GREENHOUSE_RECRUITER_OAUTH_STATIC_CLIENT_ID: undefined,
      GREENHOUSE_RECRUITER_OAUTH_STATIC_CLIENT_REDIRECT_URIS: undefined,
    }));
    for (const [clientId, redirectUri] of [
      ["https://chatgpt.com/oauth/client.json", STATIC_REDIRECT],
      ["https://chatgpt.com/oauth/callback-123/client.json", "https://chatgpt.com/connector/oauth/callback-123"],
    ]) {
      const { fetchImpl, calls } = trackingFetch(() => Response.json({
        client_id: clientId,
        redirect_uris: [redirectUri],
        // OpenAI's plural field permits none even though the legacy preference is JWT.
        token_endpoint_auth_method: "private_key_jwt",
        token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      }));
      assert.deepEqual(await resolveOauthClient(config, { clientId: clientId!, redirectUri: redirectUri!, fetchImpl }), {
        status: "resolved", client: "chatgpt_codex_host", surface: "chatgpt_desktop", clientId,
      });
      assert.deepEqual(calls, [clientId]);
      assert.equal((await resolveOauthClient(config, {
        clientId: clientId!, redirectUri: `${redirectUri}/wrong`, fetchImpl,
      })).status, "invalid_redirect");
    }
  });

  it("refuses ChatGPT documents with a mismatched identity or unsupported token authentication", async () => {
    const clientId = "https://chatgpt.com/oauth/client.json";
    for (const fields of [
      { client_id: "https://chatgpt.com/oauth/another/client.json", token_endpoint_auth_methods_supported: ["none"] },
      { token_endpoint_auth_methods_supported: ["none"] },
      { client_id: clientId, token_endpoint_auth_methods_supported: ["private_key_jwt"] },
      { client_id: clientId, token_endpoint_auth_methods_supported: "none" },
      { client_id: clientId, token_endpoint_auth_method: "private_key_jwt" },
    ]) {
      const { fetchImpl, calls } = trackingFetch(() => Response.json({ redirect_uris: [STATIC_REDIRECT], ...fields }));
      assert.equal((await resolveOauthClient(requireConfig(), { clientId, redirectUri: STATIC_REDIRECT, fetchImpl })).status, "invalid_client");
      assert.deepEqual(calls, [clientId]);
    }
    const { fetchImpl } = trackingFetch(() => Response.json({
      client_id: clientId, redirect_uris: [STATIC_REDIRECT], token_endpoint_auth_method: "none",
    }));
    assert.equal((await resolveOauthClient(requireConfig(), { clientId, redirectUri: STATIC_REDIRECT, fetchImpl })).status, "resolved");
  });

  it("resolves the env static client to chatgpt_codex_host on chatgpt_desktop — never action-plane 'codex'", async () => {
    const { fetchImpl, calls } = trackingFetch();
    const result = await resolveOauthClient(requireConfig(), {
      clientId: STATIC_CLIENT_ID,
      redirectUri: STATIC_REDIRECT,
      fetchImpl,
    });
    assert.equal(result.status, "resolved");
    if (result.status !== "resolved") throw new Error("unreachable");
    // Recruiter vocabulary, not action-plane vocabulary: "codex" would fail
    // isClientSurfaceCompatible and poison every downstream session check.
    assert.equal(result.client, "chatgpt_codex_host");
    assert.notEqual(result.client as string, "codex");
    assert.equal(result.surface, "chatgpt_desktop");
    assert.ok(isClientSurfaceCompatible(result.client, result.surface));
    assert.equal(calls.length, 0);
  });

  it("requires an exact redirect match for the static client", async () => {
    const { fetchImpl } = trackingFetch();
    const result = await resolveOauthClient(requireConfig(), {
      clientId: STATIC_CLIENT_ID,
      redirectUri: "https://chatgpt.com/some_other_redirect",
      fetchImpl,
    });
    assert.equal(result.status, "invalid_redirect");
  });

  it("answers invalid_client for an unknown plain client id, and when no static client is set at all", async () => {
    const { fetchImpl, calls } = trackingFetch();
    const withStatic = await resolveOauthClient(requireConfig(), {
      clientId: "some-random-client",
      redirectUri: STATIC_REDIRECT,
      fetchImpl,
    });
    assert.equal(withStatic.status, "invalid_client");

    const noStaticConfig = requireConfig(oauthEnv({
      GREENHOUSE_RECRUITER_OAUTH_STATIC_CLIENT_ID: undefined,
      GREENHOUSE_RECRUITER_OAUTH_STATIC_CLIENT_REDIRECT_URIS: undefined,
    }));
    const withoutStatic = await resolveOauthClient(noStaticConfig, {
      clientId: STATIC_CLIENT_ID,
      redirectUri: STATIC_REDIRECT,
      fetchImpl,
    });
    assert.equal(withoutStatic.status, "invalid_client");
    assert.equal(calls.length, 0);
  });

  it("treats an unfetchable or malformed CIMD document as invalid_client", async () => {
    const notFound = trackingFetch(() => new Response("nope", { status: 404 }));
    const missing = await resolveOauthClient(requireConfig(), {
      clientId: HOSTED_CIMD_URL,
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      fetchImpl: notFound.fetchImpl,
    });
    assert.equal(missing.status, "invalid_client");

    const garbage = trackingFetch(() => new Response("{not json", { status: 200 }));
    const malformed = await resolveOauthClient(requireConfig(), {
      clientId: HOSTED_CIMD_URL,
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      fetchImpl: garbage.fetchImpl,
    });
    assert.equal(malformed.status, "invalid_client");

    const wrongShape = trackingFetch(() => new Response(JSON.stringify({ redirect_uris: "not-an-array" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const badShape = await resolveOauthClient(requireConfig(), {
      clientId: HOSTED_CIMD_URL,
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      fetchImpl: wrongShape.fetchImpl,
    });
    assert.equal(badShape.status, "invalid_client");
  });

  it("fetches the CIMD document with redirect:'error' and refuses a redirect to an internal host, no second fetch (R1-D SSRF containment)", async () => {
    const inits: Array<RequestInit | undefined> = [];
    let calls = 0;
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls += 1;
      inits.push(init);
      // A real fetch with redirect:"error" throws on a 3xx rather than following it off-origin.
      // Modeling a 302 -> internal host as that throw proves the resolver refuses, never chases it.
      throw new TypeError("Fetch redirect mode is set to 'error' and a redirect was received.");
    }) as typeof fetch;

    const result = await resolveOauthClient(requireConfig(), {
      clientId: HOSTED_CIMD_URL,
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      fetchImpl,
    });
    assert.equal(result.status, "invalid_client", "a CIMD document that redirects must be refused");
    assert.equal(calls, 1, "the resolver must not follow the redirect with a second fetch");
    assert.equal(inits[0]?.redirect, "error", "the CIMD fetch must set redirect:'error' so a redirect cannot walk off the trusted origin");
  });

  it("refuses a non-HTTPS redirect for hosted CIMD clients even if the document lists it", async () => {
    const { fetchImpl } = trackingFetch(() => new Response(JSON.stringify({
      redirect_uris: ["http://claude.ai/insecure_callback"],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await resolveOauthClient(requireConfig(), {
      clientId: HOSTED_CIMD_URL,
      redirectUri: "http://claude.ai/insecure_callback",
      fetchImpl,
    });
    assert.equal(result.status, "invalid_redirect");
  });
});
