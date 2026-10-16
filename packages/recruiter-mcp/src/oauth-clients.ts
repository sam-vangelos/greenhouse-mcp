import { fetchWithTimeout } from "./fetch-timeout.js";
import type { OauthAuthorizationConfig } from "./oauth-config.js";
import type { RecruiterClient, RecruiterSurface } from "./types.js";

// Client resolution for the OAuth sign-in layer. No dynamic client registration exists on this
// server: a client is identified by its trusted HTTPS client-metadata-document URL
// (Claude and ChatGPT publish these), or by the single env-listed static client
// an org Owner can paste into a connector's Advanced settings.
//
// The client_id -> RecruiterClient mapping is what feeds signed client identity to the write
// plane's attribution bridge, so the values here are RECRUITER vocabulary: a ChatGPT
// client maps to "chatgpt_codex_host", never the action plane's "codex" — auth.ts's
// isClientSurfaceCompatible would reject "codex" outright, and the edge translation to
// action-plane names happens exactly once, in actionClientForRecruiterSession.

export const CLAUDE_CODE_CIMD_URL = "https://claude.ai/oauth/claude-code-client-metadata";
const CLAUDE_CIMD_ORIGIN = "https://claude.ai";
const CHATGPT_CIMD_ORIGIN = "https://chatgpt.com";

export type OauthClientResolution =
  | {
      status: "resolved";
      client: RecruiterClient;
      surface: Exclude<RecruiterSurface, "test">;
      clientId: string;
    }
  | { status: "invalid_client"; reason: string }
  | { status: "invalid_redirect"; reason: string };

export interface ResolveOauthClientInput {
  clientId: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}

export async function resolveOauthClient(
  config: OauthAuthorizationConfig,
  input: ResolveOauthClientInput
): Promise<OauthClientResolution> {
  const { clientId, redirectUri } = input;
  if (typeof clientId !== "string" || clientId.length === 0) {
    return { status: "invalid_client", reason: "client_id is required." };
  }
  if (typeof redirectUri !== "string" || redirectUri.length === 0) {
    return { status: "invalid_redirect", reason: "redirect_uri is required." };
  }

  // 1. The known Claude Code client, by exact CIMD literal. Its redirects are loopback with
  //    the PORT IGNORED in matching (RFC 8252 native-app loopback; the OS assigns the port),
  //    so no document fetch is needed or performed.
  if (clientId === CLAUDE_CODE_CIMD_URL) {
    if (!isLoopbackCallbackRedirect(redirectUri)) {
      return {
        status: "invalid_redirect",
        reason: "Claude Code redirects must be http://localhost/callback or http://127.0.0.1/callback (any port).",
      };
    }
    return { status: "resolved", client: "claude_code", surface: "claude_desktop", clientId };
  }

  // 2. The env-listed static client (ChatGPT / org-connector fallback), by exact id, with an
  //    exact redirect match against the env-registered list.
  if (config.staticClient !== undefined && clientId === config.staticClient.clientId) {
    if (!config.staticClient.redirectUris.includes(redirectUri)) {
      return {
        status: "invalid_redirect",
        reason: "redirect_uri is not registered for the static OAuth client.",
      };
    }
    return { status: "resolved", client: "chatgpt_codex_host", surface: "chatgpt_desktop", clientId };
  }

  // 3. Hosted Claude and ChatGPT publish callbacks in trusted metadata documents. Refuse
  //    other origins before fetching; ChatGPT uses stable or callback-specific document paths.
  const metadataUrl = parseHostedCimdUrl(clientId);
  if (metadataUrl === undefined) {
    return {
      status: "invalid_client",
      reason: "client_id must be the static client id or a supported Claude or ChatGPT client-metadata URL.",
    };
  }
  const document = await fetchCimdDocument(metadataUrl, config, input.fetchImpl ?? fetch);
  if (document === undefined) {
    return { status: "invalid_client", reason: "Client metadata document could not be read." };
  }
  if (!isHttpsUrl(redirectUri)) {
    return { status: "invalid_redirect", reason: "Hosted client redirects must be HTTPS." };
  }
  if (!document.redirectUris.includes(redirectUri)) {
    return {
      status: "invalid_redirect",
      reason: "redirect_uri is not listed in the client metadata document.",
    };
  }
  return metadataUrl.origin === CHATGPT_CIMD_ORIGIN
    ? { status: "resolved", client: "chatgpt_codex_host", surface: "chatgpt_desktop", clientId }
    : { status: "resolved", client: "claude_desktop_chat", surface: "claude_desktop", clientId };
}

function parseHostedCimdUrl(clientId: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  if (url.username || url.password || url.hash) return undefined;
  if (url.origin === CLAUDE_CIMD_ORIGIN) return url;
  if (url.origin === CHATGPT_CIMD_ORIGIN && url.href === clientId && !url.search
    && /^\/oauth\/(?:[A-Za-z0-9_-]+\/)?client\.json$/.test(url.pathname)) return url;
  return undefined;
}

interface CimdDocument {
  redirectUris: string[];
}

async function fetchCimdDocument(
  url: URL,
  config: OauthAuthorizationConfig,
  fetchImpl: typeof fetch
): Promise<CimdDocument | undefined> {
  let response: Response;
  try {
    response = await fetchWithTimeout(fetchImpl, url, {
      method: "GET",
      headers: { accept: "application/json" },
      // A redirect could walk off the trusted origin; refuse rather than follow.
      redirect: "error",
    }, config.lookupTimeoutMs, "Client metadata document fetch");
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  if (url.origin === CHATGPT_CIMD_ORIGIN) {
    const document = parsed as Record<string, unknown>;
    // OpenAI's plural methods override its legacy private_key_jwt preference. This server
    // advertises only none + PKCE, so refuse documents that cannot use that method.
    const methods = document.token_endpoint_auth_methods_supported
      ?? [document.token_endpoint_auth_method];
    if (document.client_id !== url.href || !Array.isArray(methods)
      || !methods.every((method) => typeof method === "string") || !methods.includes("none")) return undefined;
  }
  const redirectUris = (parsed as { redirect_uris?: unknown }).redirect_uris;
  if (!Array.isArray(redirectUris) || !redirectUris.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  return { redirectUris };
}

// Loopback callback matching with the port deliberately ignored: the client binds an
// OS-assigned port at authorization time, so only scheme, loopback host, and the /callback
// path participate in the comparison.
function isLoopbackCallbackRedirect(redirectUri: string): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") return false;
  return url.pathname === "/callback";
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
