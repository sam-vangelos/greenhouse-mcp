import type { OauthAuthorizationConfig } from "./oauth-config.js";

// Discovery documents for the OAuth sign-in layer (2026-07-28 MCP authorization spec).
// The server is its own authorization server, so the RFC 8414 metadata and the RFC 9728
// protected-resource metadata are both served from here, built ONLY from the validated env
// config — the server never reads Host or X-Forwarded-* headers to derive absolute URLs.
//
// Clients probe the protected-resource document at the path-suffixed location FIRST
// (/.well-known/oauth-protected-resource/mcp for a resource at /mcp), then fall back to the
// root location; both serve the same document.

export const OAUTH_AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";
export const OAUTH_PROTECTED_RESOURCE_METADATA_ROOT_PATH = "/.well-known/oauth-protected-resource";

// Endpoint paths under the issuer. Slices 6 and 7 mount the handlers; the metadata advertises
// them from slice 1 so a probing client sees one stable contract.
export const OAUTH_AUTHORIZE_PATH = "/authorize";
export const OAUTH_TOKEN_PATH = "/token";
export const OAUTH_CALLBACK_PATH = "/oauth/callback";

// offline_access is what makes Claude request a refresh token; nothing finer-grained exists on
// this surface (the tool catalog itself is the authorization model).
const OAUTH_SCOPES_SUPPORTED = ["offline_access"];

export function oauthProtectedResourceMetadataPathForResource(config: OauthAuthorizationConfig): string {
  const resourcePath = new URL(config.resourceUrl).pathname;
  return `${OAUTH_PROTECTED_RESOURCE_METADATA_ROOT_PATH}${resourcePath}`;
}

// The absolute URL a 401 challenge points clients at (slice 3's WWW-Authenticate).
export function oauthResourceMetadataUrl(config: OauthAuthorizationConfig): string {
  return `${config.issuer}${oauthProtectedResourceMetadataPathForResource(config)}`;
}

export function buildOauthAuthorizationServerMetadata(
  config: OauthAuthorizationConfig
): Record<string, unknown> {
  return {
    // Byte-exact issuer: clients compare this string against the discovery URL's base.
    issuer: config.issuer,
    authorization_endpoint: `${config.issuer}${OAUTH_AUTHORIZE_PATH}`,
    token_endpoint: `${config.issuer}${OAUTH_TOKEN_PATH}`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // Hard client gate: without S256 Claude refuses the server outright.
    code_challenge_methods_supported: ["S256"],
    // These two are required TOGETHER or Claude silently falls back to dynamic client
    // registration — which this server deliberately does not offer (no /register endpoint;
    // CIMD clients are identified by their HTTPS metadata URL, plus one env-listed static
    // client as the org-connector fallback).
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    scopes_supported: OAUTH_SCOPES_SUPPORTED,
  };
}

export function buildOauthProtectedResourceMetadata(
  config: OauthAuthorizationConfig
): Record<string, unknown> {
  return {
    // Byte-exact resource identifier: must match the URL the connector admin types.
    resource: config.resourceUrl,
    authorization_servers: [config.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: OAUTH_SCOPES_SUPPORTED,
  };
}

// Route the three discovery locations (AS metadata; PRM suffixed; PRM root) to their document,
// or undefined when the path is not a discovery route. The caller gates on configured state, so
// an absent or invalid OAuth env keeps every one of these paths dark.
export function resolveOauthDiscoveryDocument(
  config: OauthAuthorizationConfig,
  path: string
): Record<string, unknown> | undefined {
  if (path === OAUTH_AUTHORIZATION_SERVER_METADATA_PATH) {
    return buildOauthAuthorizationServerMetadata(config);
  }
  if (
    path === OAUTH_PROTECTED_RESOURCE_METADATA_ROOT_PATH ||
    path === oauthProtectedResourceMetadataPathForResource(config)
  ) {
    return buildOauthProtectedResourceMetadata(config);
  }
  return undefined;
}

export function isOauthDiscoveryPath(config: OauthAuthorizationConfig, path: string): boolean {
  return resolveOauthDiscoveryDocument(config, path) !== undefined;
}
