import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createSessionRevocationProviderFromEnv,
  isRecruiterClient,
  normalizeSessionTokenId,
  parseRevokedTokenIdList,
  sessionNamesOneActor,
  surfaceForRecruiterClient,
  type SessionRevocationProvider,
  type SessionValidationResult,
} from "./auth.js";
import { requireHostedRecruiterStateBackend } from "./state-backend.js";
import { OAUTH_ACCESS_TOKEN_TTL_SECONDS, type OauthAuthorizationConfig } from "./oauth-config.js";
import type { AuthenticatedSession, RecruiterClient } from "./types.js";

// OAuth access tokens for the sign-in layer: 3-segment HS256 JWTs, forked from the legacy
// 2-segment session tokens by dot-count at the single bearer chokepoint (remote.ts). This file
// carries the auth stack's FIRST expiry logic — deliberately confined to the OAuth branch;
// legacy sessions stay immortal-by-design with the revocation table as their only kill switch.
// The revocation table reaches OAuth sessions two ways: the token's `jti` is its tokenId, so the
// per-request lookup and the greenhouse-recruiter-revoke-session CLI target one token directly;
// and because each refresh row persists the jti minted with it (migration 0006), a refresh-reuse
// response drops the family's outstanding jtis into that same table, killing stolen access
// tokens at once. The `sid` claim carries the durable grant family so the rate limiter buckets
// the whole sign-in instead of resetting on every rotation.

export const OAUTH_ACCESS_TOKEN_CLOCK_SKEW_SECONDS = 30;

// Epoch-seconds sanity bound (2100-01-01). A validly-signed token whose iat/exp is finite but
// astronomically large would pass Number.isFinite yet overflow `new Date(seconds * 1000)` into an
// Invalid Date, whose toISOString() throws — turning a fail-closed validator into an uncaught 500.
// Bounding the claims keeps the whole path fail-closed as {status:"invalid"}, never a throw.
const MAX_EPOCH_SECONDS = 4_102_444_800;

function isSaneEpochSeconds(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value < MAX_EPOCH_SECONDS;
}

interface OauthAccessTokenHeader {
  alg: string;
  typ?: string;
}

interface OauthAccessTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  email: string;
  surface: string;
  client: string;
  jti: string;
  /** Durable per-session id (the OAuth grant family); the rate-limit principal across rotation. */
  sid?: string;
  iat: number;
  exp: number;
}

export interface MintOauthAccessTokenInput {
  /** Canonical (trimmed, lower-case) verified email; refused otherwise, never rewritten. */
  email: string;
  client: RecruiterClient;
  jti?: string;
  /** Durable per-session id carried through rotation; keys the rate limiter, not the ephemeral jti. */
  sid?: string;
  now?: () => number;
}

export interface MintedOauthAccessToken {
  token: string;
  jti: string;
  /** Epoch seconds, mirrors the `exp` claim. */
  expiresAtEpochSeconds: number;
  expiresInSeconds: number;
}

export interface ValidateOauthAccessTokenOptions {
  now?: () => number;
  revokedTokenIds?: ReadonlySet<string>;
  revocationProvider?: SessionRevocationProvider;
}

export function mintOauthAccessToken(
  config: OauthAuthorizationConfig,
  input: MintOauthAccessTokenInput
): MintedOauthAccessToken {
  const now = input.now ?? (() => Date.now());
  const issuedAtSeconds = Math.floor(now() / 1000);
  const expiresAtSeconds = issuedAtSeconds + OAUTH_ACCESS_TOKEN_TTL_SECONDS;
  const jti = normalizeSessionTokenId(input.jti ?? randomUUID());
  const surface = surfaceForRecruiterClient(input.client);
  const session: AuthenticatedSession = {
    subject: `email:${input.email}`,
    email: input.email,
    surface,
    client: input.client,
    tokenId: jti,
    issuedAt: new Date(issuedAtSeconds * 1000).toISOString(),
  };
  // One token, one actor — enforced at mint exactly as auth.ts enforces it for legacy tokens,
  // so a non-canonical email is refused here rather than laundered into a subject the identity
  // directory and the action plane would read differently.
  if (!sessionNamesOneActor(session)) {
    throw new Error("OAuth access token email must be a canonical lower-case address.");
  }
  const claims: OauthAccessTokenClaims = {
    iss: config.issuer,
    aud: config.resourceUrl,
    sub: session.subject,
    email: input.email,
    surface,
    client: input.client,
    jti,
    ...(input.sid !== undefined ? { sid: input.sid } : {}),
    iat: issuedAtSeconds,
    exp: expiresAtSeconds,
  };
  const headerPart = base64UrlEncodeJson({ alg: "HS256", typ: "JWT" });
  const payloadPart = base64UrlEncodeJson(claims);
  const signature = sign(`${headerPart}.${payloadPart}`, config.signingSecret);
  return {
    token: `${headerPart}.${payloadPart}.${signature}`,
    jti,
    expiresAtEpochSeconds: expiresAtSeconds,
    expiresInSeconds: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  };
}

export async function validateOauthAccessToken(
  token: string,
  config: OauthAuthorizationConfig,
  options: ValidateOauthAccessTokenOptions = {}
): Promise<SessionValidationResult> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { status: "invalid", reason: "Malformed recruiter MCP OAuth access token." };
  }
  const [headerPart, payloadPart, signaturePart] = parts;
  if (!headerPart || !payloadPart) {
    return { status: "invalid", reason: "Malformed recruiter MCP OAuth access token." };
  }
  let header: OauthAccessTokenHeader;
  try {
    header = JSON.parse(base64UrlDecode(headerPart)) as OauthAccessTokenHeader;
  } catch {
    return { status: "invalid", reason: "Recruiter MCP OAuth access token header is not valid JSON." };
  }
  // Exact-algorithm gate BEFORE any signature math: alg none, downcased variants, and every
  // asymmetric algorithm are refused outright — this validator only ever verifies what this
  // server minted.
  if (header === null || typeof header !== "object" || header.alg !== "HS256" || (header.typ !== undefined && header.typ !== "JWT")) {
    return { status: "invalid", reason: "Recruiter MCP OAuth access token header must declare exactly HS256." };
  }
  if (!signaturePart || !signatureMatches(`${headerPart}.${payloadPart}`, signaturePart, config.signingSecret)) {
    return { status: "invalid", reason: "Invalid recruiter MCP OAuth access token signature." };
  }
  let claims: OauthAccessTokenClaims;
  try {
    claims = JSON.parse(base64UrlDecode(payloadPart)) as OauthAccessTokenClaims;
  } catch {
    return { status: "invalid", reason: "Invalid recruiter MCP OAuth access token payload." };
  }
  if (claims === null || typeof claims !== "object") {
    return { status: "invalid", reason: "Invalid recruiter MCP OAuth access token payload." };
  }
  if (typeof claims.exp !== "number" || !isSaneEpochSeconds(claims.exp) || claims.exp <= 0) {
    return { status: "invalid", reason: "Recruiter MCP OAuth access token has no expiry." };
  }
  const nowSeconds = (options.now ?? (() => Date.now()))() / 1000;
  if (nowSeconds > claims.exp + OAUTH_ACCESS_TOKEN_CLOCK_SKEW_SECONDS) {
    return { status: "invalid", reason: "Recruiter MCP OAuth access token has expired." };
  }
  if (claims.aud !== config.resourceUrl) {
    return { status: "invalid", reason: "Recruiter MCP OAuth access token audience does not match this resource." };
  }
  if (claims.iss !== config.issuer) {
    return { status: "invalid", reason: "Recruiter MCP OAuth access token issuer is not this server." };
  }
  if (typeof claims.iat !== "number" || !isSaneEpochSeconds(claims.iat)) {
    return { status: "invalid", reason: "Recruiter MCP OAuth access token has no issued-at." };
  }
  if (typeof claims.sub !== "string" || claims.sub.trim().length === 0 || claims.sub.trim() !== claims.sub) {
    return { status: "invalid", reason: "Recruiter MCP OAuth access token has no subject." };
  }
  if (typeof claims.email !== "string" || claims.email.trim().length === 0) {
    return { status: "invalid", reason: "Recruiter MCP OAuth access token has no email." };
  }
  if (!isRecruiterClient(claims.client)) {
    return { status: "invalid", reason: "Recruiter MCP OAuth access token has an unknown client identity." };
  }
  if (claims.surface !== surfaceForRecruiterClient(claims.client)) {
    return { status: "invalid", reason: "Recruiter MCP OAuth access token client identity is incompatible with its surface." };
  }
  let tokenId: string;
  try {
    tokenId = normalizeSessionTokenId(claims.jti);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "invalid", reason: message };
  }
  const session: AuthenticatedSession = {
    subject: claims.sub,
    email: claims.email,
    surface: surfaceForRecruiterClient(claims.client),
    client: claims.client,
    tokenId,
    ...(typeof claims.sid === "string" && claims.sid.length > 0 ? { sid: claims.sid } : {}),
    issuedAt: new Date(claims.iat * 1000).toISOString(),
  };
  if (!sessionNamesOneActor(session)) {
    return { status: "invalid", reason: "Recruiter MCP OAuth access token subject does not bind to its email claim." };
  }
  if (options.revokedTokenIds?.has(tokenId)) {
    return { status: "invalid", reason: "Recruiter MCP OAuth session token has been revoked." };
  }
  if (options.revocationProvider) {
    let revoked: boolean;
    try {
      revoked = await options.revocationProvider.isRevoked(session);
    } catch {
      return {
        status: "invalid",
        reason: "Recruiter MCP session token revocation status could not be verified.",
      };
    }
    if (revoked) {
      return { status: "invalid", reason: "Recruiter MCP OAuth session token has been revoked." };
    }
  }
  return { status: "valid", session };
}

// Env wiring for the remote chokepoint, mirroring createSessionValidatorFromEnv's durable-state
// requirements (auth.ts:234-249): hosted OAuth sessions demand the supabase_postgrest backend
// and a live revocation provider, and every wiring failure fails CLOSED as an invalid session.
export function createOauthAccessTokenValidatorFromEnv(
  env: NodeJS.ProcessEnv,
  config: OauthAuthorizationConfig
): SessionValidationResult | { validate(token: string): Promise<SessionValidationResult> } {
  let revocationProvider: SessionRevocationProvider | undefined;
  try {
    requireHostedRecruiterStateBackend(env);
    revocationProvider = createSessionRevocationProviderFromEnv(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "invalid", reason: message };
  }
  if (!revocationProvider) {
    return {
      status: "invalid",
      reason: "GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL and GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY are required for remote durable sessions.",
    };
  }
  const revokedTokenIds = parseRevokedTokenIdList(env.GREENHOUSE_RECRUITER_REVOKED_TOKEN_IDS);
  return {
    validate(token: string): Promise<SessionValidationResult> {
      return validateOauthAccessToken(token, config, { revokedTokenIds, revocationProvider });
    },
  };
}

function sign(signingInput: string, secret: string): string {
  return createHmac("sha256", secret).update(signingInput).digest("base64url");
}

function signatureMatches(signingInput: string, signature: string, secret: string): boolean {
  const expected = Buffer.from(sign(signingInput, secret));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function base64UrlEncodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}
