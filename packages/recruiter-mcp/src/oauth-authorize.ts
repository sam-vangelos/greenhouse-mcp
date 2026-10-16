import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";
import { isClientSurfaceCompatible, isRecruiterClient } from "./auth.js";
import { normalizeWorkEmail } from "./email-session.js";
import { fetchWithTimeout } from "./fetch-timeout.js";
import { createIdentityDirectoryFromEnv, isSafePositiveGreenhouseUserId, type IdentityDirectory } from "./identity.js";
import { resolveOauthClient } from "./oauth-clients.js";
import { OAUTH_AUTHORIZATION_CODE_TTL_SECONDS, type OauthAuthorizationConfig } from "./oauth-config.js";
import { createOauthEnrollmentFromEnv, type OauthEnrollment, type OauthEnrollmentDenialCode, type OauthEnrollmentResult } from "./oauth-enroll.js";
import { createOauthGrantStore, type OauthGrantStore } from "./oauth-grant-store.js";
import { OAUTH_CALLBACK_PATH } from "./oauth-metadata.js";
import { writeJson } from "./remote.js";
import type { RecruiterClient } from "./types.js";

// /authorize + /oauth/callback: the sign-in half of the OAuth layer. The server delegates the
// human authentication to Google (org-internal OIDC) and keeps NOTHING in memory between the
// two legs — the pending request rides through Google's `state` parameter as an HMAC-signed,
// 10-minute, nonce-bound blob, so any instance can serve the callback.
//
// Identity rule, verbatim from the email-session gate: the verified email must sit in an allowed
// work-email domain AND resolve through the recruiter identity directory to exactly one safe
// Greenhouse user, or the flow ends in access_denied with ZERO grant writes. A Google personal
// address is refused at the domain gate before the lookup. Since CLO-271 a first sign-in whose
// email has NO directory row is enrolled from the Greenhouse roster (oauth-enroll.ts, the
// bootstrap CLI's own rules) and then resolved like everyone else; every other non-resolution is
// still a denial, and now one that names the cause and who fixes it.

export const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_ID_TOKEN_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const GOOGLE_OIDC_SCOPES = "openid email profile";
const PENDING_STATE_TTL_SECONDS = 600;
const ID_TOKEN_CLOCK_SKEW_SECONDS = 30;
// RFC 7636 §4.2: 43-128 characters from the unreserved set.
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

export interface OauthHttpRequestLike {
  method?: string | undefined;
  url?: string | undefined;
}

export interface OauthAuthorizeHandlerDeps {
  fetchImpl?: typeof fetch;
  identityDirectory?: IdentityDirectory;
  /** First-sign-in enrollment; defaults to the env-wired one, or none when the directory is not Supabase-backed. */
  enrollIdentity?: OauthEnrollment;
  grantStore?: OauthGrantStore;
  now?: () => number;
  generateSecret?: () => string;
  generateNonce?: () => string;
  generateFamilyId?: () => string;
}

export interface OauthAuthorizeHandlers {
  handleAuthorize(req: OauthHttpRequestLike, res: ServerResponse): Promise<void>;
  handleCallback(req: OauthHttpRequestLike, res: ServerResponse): Promise<void>;
}

interface PendingAuthorizationState {
  clientId: string;
  redirectUri: string;
  clientState?: string;
  codeChallenge: string;
  scope?: string;
  resource: string;
  client: RecruiterClient;
  surface: "claude_desktop" | "chatgpt_desktop";
  nonce: string;
  exp: number;
}

export function createOauthAuthorizeHandlers(
  config: OauthAuthorizationConfig,
  env: NodeJS.ProcessEnv,
  deps: OauthAuthorizeHandlerDeps = {}
): OauthAuthorizeHandlers {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const grantStore = deps.grantStore ?? createOauthGrantStore(config, { fetchImpl, now });
  const generateSecret = deps.generateSecret ?? (() => randomBytes(32).toString("base64url"));
  const generateNonce = deps.generateNonce ?? (() => randomBytes(16).toString("base64url"));
  const generateFamilyId = deps.generateFamilyId ?? (() => randomUUID());
  const resolveIdentityDirectory = () => deps.identityDirectory ?? createIdentityDirectoryFromEnv(env);
  const resolveEnrollment = async (): Promise<OauthEnrollment | undefined> =>
    deps.enrollIdentity ?? await createOauthEnrollmentFromEnv(env, { allowedDomains: config.allowedEmailDomains, fetchImpl });
  // Who a refused recruiter should ask, named per deployment; the default is deliberately generic.
  const contact = env.GREENHOUSE_RECRUITER_SUPPORT_CONTACT?.trim() || "Ask your Greenhouse connector administrator";
  const workDomain = config.allowedEmailDomains[0] ?? "your work";

  return {
    async handleAuthorize(req, res) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        writeJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      const query = readQuery(req);
      const clientId = query.get("client_id");
      const redirectUri = query.get("redirect_uri");
      if (!clientId || !redirectUri) {
        writeJson(res, 400, { error: "invalid_request", error_description: "client_id and redirect_uri are required." });
        return;
      }
      const resolution = await resolveOauthClient(config, { clientId, redirectUri, fetchImpl });
      if (resolution.status === "invalid_client") {
        logOauthDenial("authorize", "invalid_client");
        writeJson(res, 400, { error: "invalid_client", error_description: resolution.reason });
        return;
      }
      if (resolution.status === "invalid_redirect") {
        // An unvalidated redirect is never redirected to — direct 400 only.
        logOauthDenial("authorize", "invalid_redirect");
        writeJson(res, 400, { error: "invalid_request", error_description: resolution.reason });
        return;
      }
      const clientState = query.get("state") ?? undefined;
      if (query.get("response_type") !== "code") {
        redirectWithParams(res, redirectUri, {
          error: "unsupported_response_type",
          error_description: "Only response_type=code is supported.",
          state: clientState,
        });
        return;
      }
      const codeChallenge = query.get("code_challenge");
      const codeChallengeMethod = query.get("code_challenge_method");
      if (!codeChallenge || codeChallengeMethod !== "S256" || !CODE_CHALLENGE_PATTERN.test(codeChallenge)) {
        logOauthDenial("authorize", "pkce_s256_required");
        redirectWithParams(res, redirectUri, {
          error: "invalid_request",
          error_description: "PKCE with code_challenge_method=S256 is required.",
          state: clientState,
        });
        return;
      }
      // RFC 8707, enforced when present: a caller naming a resource must name THIS resource.
      const resource = query.get("resource");
      if (resource !== null && resource !== config.resourceUrl) {
        logOauthDenial("authorize", "resource_mismatch");
        redirectWithParams(res, redirectUri, {
          error: "invalid_target",
          error_description: "The requested resource is not served by this authorization server.",
          state: clientState,
        });
        return;
      }
      const nonce = generateNonce();
      const pending: PendingAuthorizationState = {
        clientId,
        redirectUri,
        ...(clientState !== undefined ? { clientState } : {}),
        codeChallenge,
        ...(query.get("scope") !== null ? { scope: query.get("scope")! } : {}),
        resource: config.resourceUrl,
        client: resolution.client,
        surface: resolution.surface,
        nonce,
        exp: Math.floor(now() / 1000) + PENDING_STATE_TTL_SECONDS,
      };
      const googleUrl = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
      googleUrl.searchParams.set("client_id", config.googleClientId);
      googleUrl.searchParams.set("redirect_uri", `${config.issuer}${OAUTH_CALLBACK_PATH}`);
      googleUrl.searchParams.set("response_type", "code");
      googleUrl.searchParams.set("scope", GOOGLE_OIDC_SCOPES);
      googleUrl.searchParams.set("state", encodePendingAuthorizationState(pending, config.signingSecret));
      googleUrl.searchParams.set("nonce", nonce);
      writeRedirect(res, googleUrl.toString());
    },

    async handleCallback(req, res) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        writeJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      const query = readQuery(req);
      const rawState = query.get("state");
      if (!rawState) {
        writeJson(res, 400, { error: "invalid_request", error_description: "state is required." });
        return;
      }
      const pending = decodePendingAuthorizationState(rawState, config.signingSecret, Math.floor(now() / 1000));
      if (pending === undefined) {
        // Unverifiable state means an unverifiable redirect target: direct 400, no redirect.
        logOauthDenial("callback", "pending_state_invalid");
        writeJson(res, 400, { error: "invalid_request", error_description: "state is invalid or expired." });
        return;
      }
      const redirectError = (error: string, description: string) => {
        redirectWithParams(res, pending.redirectUri, {
          error,
          error_description: description,
          state: pending.clientState,
        });
      };
      const googleError = query.get("error");
      if (googleError !== null) {
        logOauthDenial("callback", "google_denied");
        redirectError("access_denied", "Google sign-in was not completed.");
        return;
      }
      const googleCode = query.get("code");
      if (!googleCode) {
        redirectError("invalid_request", "Google returned no authorization code.");
        return;
      }
      let exchange: Response;
      try {
        exchange = await fetchWithTimeout(fetchImpl, new URL(GOOGLE_TOKEN_ENDPOINT), {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: new URLSearchParams({
            code: googleCode,
            client_id: config.googleClientId,
            client_secret: config.googleClientSecret,
            redirect_uri: `${config.issuer}${OAUTH_CALLBACK_PATH}`,
            grant_type: "authorization_code",
          }).toString(),
        }, config.lookupTimeoutMs, "Google token exchange");
      } catch {
        logOauthDenial("callback", "google_exchange_unreachable");
        redirectError("server_error", "The identity provider could not be reached.");
        return;
      }
      if (!exchange.ok) {
        logOauthDenial("callback", "google_exchange_rejected");
        redirectError("invalid_request", "The Google authorization code could not be exchanged.");
        return;
      }
      let idToken: string | undefined;
      try {
        const payload = await exchange.json() as { id_token?: unknown };
        idToken = typeof payload.id_token === "string" ? payload.id_token : undefined;
      } catch {
        idToken = undefined;
      }
      if (idToken === undefined) {
        logOauthDenial("callback", "google_exchange_malformed");
        redirectError("server_error", "The identity provider response was malformed.");
        return;
      }
      const claims = readGoogleIdTokenClaims(idToken);
      if (claims === undefined) {
        logOauthDenial("callback", "id_token_unreadable");
        redirectError("invalid_request", "The identity token could not be read.");
        return;
      }
      const claimError = validateGoogleIdTokenClaims(claims, config.googleClientId, pending.nonce, Math.floor(now() / 1000));
      if (claimError !== undefined) {
        logOauthDenial("callback", claimError);
        redirectError("invalid_request", "The identity token claims are not acceptable.");
        return;
      }
      if (claims["email_verified"] !== true) {
        logOauthDenial("callback", "email_not_verified");
        redirectError("access_denied", "The Google account email is not verified.");
        return;
      }
      let email: string;
      try {
        email = normalizeWorkEmail(String(claims["email"]), config.allowedEmailDomains);
      } catch {
        logOauthDenial("callback", "email_domain_not_allowed");
        redirectError("access_denied", `Sign in with your @${workDomain} Google account, not a personal or other-organization address.`);
        return;
      }
      // Google Workspace stamps the account's hosted domain in `hd`; when present it must be an
      // allowed domain too, so an allowed alias cannot smuggle in an account from another org.
      const hostedDomain = claims["hd"];
      if (typeof hostedDomain === "string" && hostedDomain.length > 0
        && !config.allowedEmailDomains.includes(hostedDomain.trim().toLowerCase())) {
        logOauthDenial("callback", "hd_not_allowed");
        redirectError("access_denied", "The Google account hosted domain is not allowed.");
        return;
      }
      // The email-session gate: the directory decides who exists. Anything but a single resolved,
      // safe Greenhouse user id ends the flow with ZERO grant writes — except the one case where
      // the directory has never heard of this email, which is now enrolled from the Greenhouse
      // roster and resolved again (CLO-271). Ambiguous / invalid rows stay hard denials.
      const sessionIdentity = { subject: `email:${email}`, email, surface: pending.surface, client: pending.client };
      let resolutionResult = await resolveIdentityDirectory().resolve(sessionIdentity);
      if (resolutionResult.status === "unresolved") {
        const enrollment = await resolveEnrollment();
        const outcome: OauthEnrollmentResult = enrollment === undefined
          ? { status: "denied", code: "enrollment_disabled", reason: "No durable identity directory to enroll into." }
          : await enrollment.enroll(email);
        if (outcome.status === "error") {
          logOauthDenial("callback", "enrollment_error");
          redirectError("server_error", `Enrollment could not be completed. Try again in a minute, or ${contact.toLowerCase()} if it keeps failing.`);
          return;
        }
        if (outcome.status === "denied") {
          logOauthDenial("callback", `enrollment_${outcome.code}`);
          redirectError("access_denied", enrollmentDenialCopy(outcome.code, contact));
          return;
        }
        logOauthEnrollment(outcome.alreadyEnrolled ? "enrolled_concurrently" : "enrolled");
        resolutionResult = await resolveIdentityDirectory().resolve(sessionIdentity);
      }
      if (resolutionResult.status !== "resolved" || !isSafePositiveGreenhouseUserId(resolutionResult.greenhouseUserId)) {
        logOauthDenial("callback", `identity_${resolutionResult.status}`);
        redirectError("access_denied", resolutionResult.status === "ambiguous"
          ? `This Google account matches more than one Greenhouse user. ${contact} to resolve it, then click Connect again.`
          : `This Google account is not enabled for the Greenhouse connector. ${contact} to check it, then click Connect again.`);
        return;
      }
      const secret = generateSecret();
      await grantStore.insertGrant({
        kind: "code",
        secret,
        familyId: generateFamilyId(),
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        email,
        surface: pending.surface,
        client: pending.client,
        resource: pending.resource,
        ...(pending.scope !== undefined ? { scope: pending.scope } : {}),
        expiresAt: new Date(now() + OAUTH_AUTHORIZATION_CODE_TTL_SECONDS * 1000).toISOString(),
      });
      redirectWithParams(res, pending.redirectUri, {
        code: secret,
        state: pending.clientState,
      });
    },
  };
}

// OIDC Core §3.1.3.7: an ID Token received DIRECTLY from the token endpoint over the server's
// own TLS channel may be accepted on channel trust — claims-only, no JWKS, no new deps. This is
// deliberately ONE function so a future jose/JWKS upgrade is a contained swap.
function readGoogleIdTokenClaims(idToken: string): Record<string, unknown> | undefined {
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function validateGoogleIdTokenClaims(
  claims: Record<string, unknown>,
  googleClientId: string,
  expectedNonce: string,
  nowSeconds: number
): string | undefined {
  const iss = claims["iss"];
  if (typeof iss !== "string" || !GOOGLE_ID_TOKEN_ISSUERS.has(iss)) return "id_token_wrong_issuer";
  const aud = claims["aud"];
  const audMatches = typeof aud === "string"
    ? aud === googleClientId
    : Array.isArray(aud) && aud.includes(googleClientId);
  if (!audMatches) return "id_token_wrong_audience";
  const exp = claims["exp"];
  if (typeof exp !== "number" || !Number.isFinite(exp) || nowSeconds > exp + ID_TOKEN_CLOCK_SKEW_SECONDS) {
    return "id_token_expired";
  }
  if (claims["nonce"] !== expectedNonce) return "id_token_nonce_mismatch";
  if (typeof claims["email"] !== "string" || claims["email"].length === 0) return "id_token_missing_email";
  return undefined;
}

function encodePendingAuthorizationState(pending: PendingAuthorizationState, secret: string): string {
  const payload = Buffer.from(JSON.stringify(pending), "utf8").toString("base64url");
  return `${payload}.${signState(payload, secret)}`;
}

function decodePendingAuthorizationState(
  blob: string,
  secret: string,
  nowSeconds: number
): PendingAuthorizationState | undefined {
  const parts = blob.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  const [payloadPart, signaturePart] = parts;
  const expected = Buffer.from(signState(payloadPart!, secret));
  const actual = Buffer.from(signaturePart!);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadPart!, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const candidate = parsed as Partial<PendingAuthorizationState>;
  if (
    typeof candidate.clientId !== "string" || candidate.clientId.length === 0 ||
    typeof candidate.redirectUri !== "string" || candidate.redirectUri.length === 0 ||
    typeof candidate.codeChallenge !== "string" || candidate.codeChallenge.length === 0 ||
    typeof candidate.resource !== "string" || candidate.resource.length === 0 ||
    typeof candidate.nonce !== "string" || candidate.nonce.length === 0 ||
    typeof candidate.exp !== "number" || !Number.isFinite(candidate.exp) ||
    (candidate.clientState !== undefined && typeof candidate.clientState !== "string") ||
    (candidate.scope !== undefined && typeof candidate.scope !== "string") ||
    !isRecruiterClient(candidate.client) ||
    (candidate.surface !== "claude_desktop" && candidate.surface !== "chatgpt_desktop") ||
    !isClientSurfaceCompatible(candidate.client, candidate.surface)
  ) {
    return undefined;
  }
  if (nowSeconds > candidate.exp) return undefined;
  return candidate as PendingAuthorizationState;
}

function signState(payload: string, secret: string): string {
  // Domain-separated from access-token signing so a pending-state blob can never be replayed
  // as any other 2-segment artifact signed with the same key.
  return createHmac("sha256", secret).update(`oauth-pending-state.${payload}`).digest("base64url");
}

function readQuery(req: OauthHttpRequestLike): URLSearchParams {
  try {
    return new URL(req.url ?? "/", "http://localhost").searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function writeRedirect(res: ServerResponse, location: string): void {
  if (res.headersSent) return;
  res.writeHead(302, { location });
  res.end();
}

function redirectWithParams(
  res: ServerResponse,
  redirectUri: string,
  params: Record<string, string | undefined>
): void {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  writeRedirect(res, url.toString());
}

// Structured, PII-free stderr for sign-in denials (the mount-failure logging precedent):
// stage + reason code only — never the email, never a token, never a secret.
function logOauthDenial(stage: "authorize" | "callback", reason: string): void {
  const sanitized = reason.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80);
  console.error(`[greenhouse-recruiter-mcp] oauth_authorization_denied stage=${stage} reason=${sanitized}`);
}

// PII-free like the denial log: the outcome only, never the email.
function logOauthEnrollment(outcome: "enrolled" | "enrolled_concurrently"): void {
  console.error(`[greenhouse-recruiter-mcp] oauth_identity_enrolled outcome=${outcome}`);
}

// What the recruiter reads in Claude's connector dialog. Each branch names the cause and the
// fixer; none carries the email (it rides in a redirect URL through the client and its history).
export function enrollmentDenialCopy(code: OauthEnrollmentDenialCode, contact: string): string {
  switch (code) {
    case "email_missing":
      return `The Google account you signed in with does not match an active Greenhouse user, so it cannot use the Greenhouse connector yet. ${contact} to check your Greenhouse account, then click Connect again.`;
    case "deactivated":
      return `The Greenhouse user for this Google account is deactivated. ${contact} if that is wrong.`;
    case "ambiguous":
      return `This Google account matches more than one Greenhouse user. ${contact} to resolve it, then click Connect again.`;
    case "directory_row_exists":
      return `This Google account is not currently enabled for the Greenhouse connector. ${contact} to re-enable it.`;
    case "email_mismatch":
      return `Your Greenhouse user is registered under a different email. ${contact} to update it, then click Connect again.`;
    case "enrollment_disabled":
    default:
      return `This Google account is not enrolled for the Greenhouse connector. ${contact} to add you, then click Connect again.`;
  }
}
