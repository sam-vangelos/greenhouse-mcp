import { MIN_SESSION_SECRET_LENGTH } from "./auth.js";
import { readLookupTimeoutMs } from "./fetch-timeout.js";
import {
  assertCanonicalSupabaseProjectRef,
  normalizeOptionalSupabaseIdentifier,
  normalizeSupabaseApiKey,
} from "./supabase-config.js";

// OAuth sign-in layer configuration (CLO-198). The server becomes both the OAuth protected
// resource AND its own authorization server, delegating identity to Google sign-in. The layer is
// additive: with none of the GREENHOUSE_RECRUITER_OAUTH_* family set, every OAuth route stays
// dark and the runtime response to real traffic is unchanged. The one deliberate always-on
// behavior — NOT gated on the family — is the boot-time reservation of the fixed server routes
// (/version, /.well-known/*, /authorize, /token, /oauth/callback): readHttpEndpointConfig refuses
// to boot if GREENHOUSE_RECRUITER_MCP_PATH/HEALTH_PATH/READY_PATH is set to one of them, so an
// env-configured path can never silently shadow a reserved literal (the latent bug that let
// GREENHOUSE_RECRUITER_MCP_PATH=/version strand the /mcp surface). That check only rejects path
// configs no deployment uses; everything a live request touches stays byte-identical. That
// route-and-readiness additivity is a tri-state, not a boolean:
//
//   absent      -> no env var of the family is set; every OAuth route stays dark.
//   configured  -> the required family is present and valid; the OAuth routes mount.
//   invalid     -> the family is partially present or malformed; the routes stay dark AND the
//                  oauth_authorization readiness check fails with the reason, so a half-set
//                  deployment is loudly broken rather than silently legacy-only.
//
// Token lifetimes are deliberate CONSTANTS, not env: an operator has no legitimate reason to
// stretch them, and a fat-fingered value would silently weaken the whole grant model.
export const OAUTH_AUTHORIZATION_CODE_TTL_SECONDS = 300; // 5 minutes, one-time use
export const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 3_600; // 1 hour
export const OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days, rotated on use

export const OAUTH_SIGNING_SECRET_ENV = "GREENHOUSE_RECRUITER_OAUTH_SIGNING_SECRET";
export const OAUTH_ISSUER_ENV = "GREENHOUSE_RECRUITER_OAUTH_ISSUER";
export const OAUTH_RESOURCE_URL_ENV = "GREENHOUSE_RECRUITER_OAUTH_RESOURCE_URL";
export const OAUTH_GOOGLE_CLIENT_ID_ENV = "GREENHOUSE_RECRUITER_OAUTH_GOOGLE_CLIENT_ID";
export const OAUTH_GOOGLE_CLIENT_SECRET_ENV = "GREENHOUSE_RECRUITER_OAUTH_GOOGLE_CLIENT_SECRET";
export const OAUTH_STATIC_CLIENT_ID_ENV = "GREENHOUSE_RECRUITER_OAUTH_STATIC_CLIENT_ID";
export const OAUTH_STATIC_CLIENT_REDIRECT_URIS_ENV = "GREENHOUSE_RECRUITER_OAUTH_STATIC_CLIENT_REDIRECT_URIS";
export const OAUTH_SUPABASE_URL_ENV = "GREENHOUSE_RECRUITER_OAUTH_SUPABASE_URL";
export const OAUTH_SUPABASE_KEY_ENV = "GREENHOUSE_RECRUITER_OAUTH_SUPABASE_KEY";
export const OAUTH_SUPABASE_TABLE_ENV = "GREENHOUSE_RECRUITER_OAUTH_SUPABASE_TABLE";
export const OAUTH_LOOKUP_TIMEOUT_MS_ENV = "GREENHOUSE_RECRUITER_OAUTH_LOOKUP_TIMEOUT_MS";

export const OAUTH_ENV_FAMILY = [
  OAUTH_SIGNING_SECRET_ENV,
  OAUTH_ISSUER_ENV,
  OAUTH_RESOURCE_URL_ENV,
  OAUTH_GOOGLE_CLIENT_ID_ENV,
  OAUTH_GOOGLE_CLIENT_SECRET_ENV,
  OAUTH_STATIC_CLIENT_ID_ENV,
  OAUTH_STATIC_CLIENT_REDIRECT_URIS_ENV,
  OAUTH_SUPABASE_URL_ENV,
  OAUTH_SUPABASE_KEY_ENV,
  OAUTH_SUPABASE_TABLE_ENV,
  OAUTH_LOOKUP_TIMEOUT_MS_ENV,
] as const;

export const DEFAULT_OAUTH_GRANTS_TABLE = "recruiter_mcp_oauth_grants";
export const MIN_OAUTH_SIGNING_SECRET_LENGTH = MIN_SESSION_SECRET_LENGTH;

export interface OauthStaticClientConfig {
  clientId: string;
  redirectUris: string[];
}

export interface OauthAuthorizationConfig {
  /** HMAC key for authorization codes, access tokens, and signed pending-state blobs. */
  signingSecret: string;
  /** HTTPS base of every absolute URL the server hands out; the server reads no Host headers. */
  issuer: string;
  /** Canonical protected-resource identifier (RFC 8707/9728) and access-token audience. */
  resourceUrl: string;
  googleClientId: string;
  googleClientSecret: string;
  /**
   * Work-email domains the sign-in accepts, from GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS. The
   * legacy email-session gate treats an empty list as a hard misconfiguration; the OAuth layer
   * holds the same line, so a Google personal address can never reach the directory lookup.
   */
  allowedEmailDomains: string[];
  /** Pre-registered fallback client (ChatGPT / org-connector Advanced settings). */
  staticClient?: OauthStaticClientConfig;
  grantsSupabaseUrl: string;
  grantsSupabaseKey: string;
  grantsTable: string;
  lookupTimeoutMs: number;
}

export type OauthAuthorizationConfigResult =
  | { state: "absent" }
  | { state: "configured"; config: OauthAuthorizationConfig }
  | { state: "invalid"; reason: string };

export function readOauthAuthorizationConfig(
  env: NodeJS.ProcessEnv = process.env
): OauthAuthorizationConfigResult {
  const familyIsPresent = OAUTH_ENV_FAMILY.some((name) => hasEnvValue(env[name]));
  if (!familyIsPresent) {
    return { state: "absent" };
  }
  try {
    return { state: "configured", config: parseOauthAuthorizationConfig(env) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { state: "invalid", reason };
  }
}

function parseOauthAuthorizationConfig(env: NodeJS.ProcessEnv): OauthAuthorizationConfig {
  const signingSecret = readRequiredSecret(env, OAUTH_SIGNING_SECRET_ENV, MIN_OAUTH_SIGNING_SECRET_LENGTH);
  const sessionSecret = env.GREENHOUSE_RECRUITER_SESSION_SECRET;
  // Key separation: the OAuth signing key must never be the legacy session-token key, so a
  // compromise or operator paste-mistake in one family cannot mint credentials in the other.
  if (sessionSecret !== undefined && signingSecret === sessionSecret) {
    throw new Error(`${OAUTH_SIGNING_SECRET_ENV} must differ from GREENHOUSE_RECRUITER_SESSION_SECRET.`);
  }
  const issuer = readHttpsBaseUrl(env, OAUTH_ISSUER_ENV, { requireNonRootPath: false });
  const resourceUrl = readHttpsBaseUrl(env, OAUTH_RESOURCE_URL_ENV, { requireNonRootPath: true });
  const googleClientId = readRequiredTrimmedValue(env, OAUTH_GOOGLE_CLIENT_ID_ENV);
  const googleClientSecret = readRequiredTrimmedValue(env, OAUTH_GOOGLE_CLIENT_SECRET_ENV);
  // Required ONLY on this path — reached only when a GREENHOUSE_RECRUITER_OAUTH_* var is set — so
  // a deployment with no OAuth family gains no new requirement (the additivity invariant holds).
  // Mirrors the legacy email-session gate's throw-on-empty exactly.
  const allowedEmailDomains = parseAllowedEmailDomains(env.GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS);
  if (allowedEmailDomains.length === 0) {
    throw new Error("GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS is required when the OAuth sign-in layer is set.");
  }
  const staticClient = readStaticClientConfig(env);
  const rawSupabaseUrl = env[OAUTH_SUPABASE_URL_ENV];
  if (!hasEnvValue(rawSupabaseUrl)) {
    throw new Error(`${OAUTH_SUPABASE_URL_ENV} is required for durable OAuth grants.`);
  }
  const grantsSupabaseUrl = assertCanonicalSupabaseProjectRef(rawSupabaseUrl, "Supabase OAuth grants");
  const grantsSupabaseKey = normalizeSupabaseApiKey(env[OAUTH_SUPABASE_KEY_ENV], "Supabase OAuth grants");
  const grantsTable = normalizeOptionalSupabaseIdentifier(
    env[OAUTH_SUPABASE_TABLE_ENV],
    DEFAULT_OAUTH_GRANTS_TABLE,
    "Supabase OAuth grants table"
  );
  const lookupTimeoutMs = readLookupTimeoutMs(env[OAUTH_LOOKUP_TIMEOUT_MS_ENV], OAUTH_LOOKUP_TIMEOUT_MS_ENV);
  return {
    signingSecret,
    issuer,
    resourceUrl,
    googleClientId,
    googleClientSecret,
    allowedEmailDomains,
    ...(staticClient ? { staticClient } : {}),
    grantsSupabaseUrl,
    grantsSupabaseKey,
    grantsTable,
    lookupTimeoutMs,
  };
}

// Same shape as the email-session parser (trim, lower-case, drop empties). Kept local to avoid a
// config <-> email-session module cycle; the two must agree on what a domain list means.
function parseAllowedEmailDomains(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

function readRequiredSecret(env: NodeJS.ProcessEnv, name: string, minLength: number): string {
  const value = env[name];
  if (!hasEnvValue(value)) {
    throw new Error(`${name} is required.`);
  }
  if (value.trim() !== value) {
    throw new Error(`${name} must not contain leading or trailing whitespace.`);
  }
  if (value.length < minLength) {
    throw new Error(`${name} must be at least ${minLength} characters.`);
  }
  return value;
}

function readRequiredTrimmedValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!hasEnvValue(value)) {
    throw new Error(`${name} is required.`);
  }
  if (value.trim() !== value) {
    throw new Error(`${name} must not contain leading or trailing whitespace.`);
  }
  return value;
}

// The issuer and the resource identifier are compared byte-for-byte by clients (RFC 8414 issuer
// comparison; RFC 8707/9728 resource matching), so the CONFIGURED STRING is what every document
// and audience claim carries — validation here refuses shapes whose URL-parse would disagree
// with the raw bytes (trailing slash, query, fragment, userinfo) instead of normalizing them.
function readHttpsBaseUrl(
  env: NodeJS.ProcessEnv,
  name: string,
  options: { requireNonRootPath: boolean }
): string {
  const value = env[name];
  if (!hasEnvValue(value)) {
    throw new Error(`${name} is required.`);
  }
  if (value.trim() !== value) {
    throw new Error(`${name} must not contain leading or trailing whitespace.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an HTTPS URL without credentials, query string, or fragment.`);
  }
  if (value.endsWith("/")) {
    throw new Error(`${name} must not end with a trailing slash.`);
  }
  if (options.requireNonRootPath && url.pathname === "/") {
    throw new Error(`${name} must include the resource path (e.g. https://host/mcp).`);
  }
  return value;
}

function readStaticClientConfig(env: NodeJS.ProcessEnv): OauthStaticClientConfig | undefined {
  const rawClientId = env[OAUTH_STATIC_CLIENT_ID_ENV];
  const rawRedirects = env[OAUTH_STATIC_CLIENT_REDIRECT_URIS_ENV];
  if (!hasEnvValue(rawClientId) && !hasEnvValue(rawRedirects)) {
    return undefined;
  }
  if (!hasEnvValue(rawClientId) || !hasEnvValue(rawRedirects)) {
    throw new Error(
      `${OAUTH_STATIC_CLIENT_ID_ENV} and ${OAUTH_STATIC_CLIENT_REDIRECT_URIS_ENV} must be set together.`
    );
  }
  const clientId = readRequiredTrimmedValue(env, OAUTH_STATIC_CLIENT_ID_ENV);
  const redirectUris: string[] = [];
  const seen = new Set<string>();
  for (const entry of rawRedirects.split(",")) {
    if (entry.length === 0 || entry.trim() !== entry) {
      throw new Error(`${OAUTH_STATIC_CLIENT_REDIRECT_URIS_ENV} must be comma-separated absolute URLs without whitespace or empty entries.`);
    }
    if (!isAllowedRedirectUri(entry)) {
      throw new Error(`${OAUTH_STATIC_CLIENT_REDIRECT_URIS_ENV} entries must be HTTPS URLs or HTTP loopback URLs.`);
    }
    if (seen.has(entry)) {
      throw new Error(`${OAUTH_STATIC_CLIENT_REDIRECT_URIS_ENV} must not contain duplicate entries.`);
    }
    seen.add(entry);
    redirectUris.push(entry);
  }
  return { clientId, redirectUris };
}

// Registered redirect URIs may be HTTPS anywhere, or HTTP only on the loopback interface
// (RFC 8252 native-app loopback redirects, the Claude Code shape).
function isAllowedRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

function hasEnvValue(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
