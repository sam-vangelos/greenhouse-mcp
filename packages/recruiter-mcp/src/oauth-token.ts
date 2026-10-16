import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpRequestBodyError, readBoundedFormBody, readHttpBodyLimitBytes } from "./http-request.js";
import { mintOauthAccessToken } from "./oauth-access-token.js";
import {
  OAUTH_REFRESH_TOKEN_TTL_SECONDS,
  type OauthAuthorizationConfig,
} from "./oauth-config.js";
import { createOauthGrantStore, type OauthGrantStore } from "./oauth-grant-store.js";
import { isRecruiterClient, normalizeSessionTokenId } from "./auth.js";
import { createIdentityDirectoryFromEnv, isSafePositiveGreenhouseUserId, type IdentityDirectory } from "./identity.js";
import { writeJson } from "./remote.js";

// /token: the machine half of the OAuth layer (RFC 6749 §3.2 + PKCE §4.6 + RFC 8707).
// Form-urlencoded ONLY (readBoundedFormBody 415s everything else — JSON-only token parsers are
// a named client failure mode, and the inverse discipline applies to us), errors as RFC 6749
// §5.2 JSON, and the cardinal ordering rule: the grant is CONSUMED before any verifier or
// binding check, so a failed attempt burns the code instead of offering a retry oracle.

// RFC 7636 §4.1: 43-128 characters from the unreserved set.
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

export interface OauthTokenHandlerDeps {
  fetchImpl?: typeof fetch;
  grantStore?: OauthGrantStore;
  /** The recruiter identity directory the refresh leg re-checks; defaults to the env-configured one. */
  identityDirectory?: IdentityDirectory;
  now?: () => number;
  generateSecret?: () => string;
  generateJti?: () => string;
}

export interface OauthTokenHandler {
  handleToken(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export function createOauthTokenHandler(
  config: OauthAuthorizationConfig,
  env: NodeJS.ProcessEnv,
  deps: OauthTokenHandlerDeps = {}
): OauthTokenHandler {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const grantStore = deps.grantStore ?? createOauthGrantStore(config, { fetchImpl, now });
  const generateSecret = deps.generateSecret ?? (() => randomBytes(32).toString("base64url"));
  const generateJti = deps.generateJti ?? (() => normalizeSessionTokenId(randomUUID()));
  const resolveIdentityDirectory = () => deps.identityDirectory ?? createIdentityDirectoryFromEnv(env);

  const tokenError = (res: ServerResponse, error: string, description: string): void => {
    logTokenDenial(error);
    writeJson(res, 400, { error, error_description: description });
  };

  // Mint the access token and write the RFC 6749 token response. The stored client/surface
  // strings are positively re-narrowed into session vocabulary; a grant that fails these cannot
  // mint a session and is treated as dead. The successor refresh secret is seated by the caller
  // (the code leg inserts it; the refresh leg's rotation RPC has already seated it atomically).
  const mintAndWrite = (
    res: ServerResponse,
    params: { email: string; client: string; surface: string; scope?: string; refreshSecret: string; jti: string; sid: string }
  ): void => {
    const client = isRecruiterClient(params.client) ? params.client : undefined;
    const surface = params.surface === "claude_desktop" || params.surface === "chatgpt_desktop"
      ? params.surface
      : undefined;
    if (client === undefined || surface === undefined) {
      tokenError(res, "invalid_grant", "The grant is not usable.");
      return;
    }
    // The minted jti is the one already persisted on the refresh row, and sid is the durable grant
    // family, so the kill switch and the rate limiter both bind to a stable identity across rotation.
    const minted = mintOauthAccessToken(config, { email: params.email, client, jti: params.jti, sid: params.sid, now });
    writeJson(res, 200, {
      access_token: minted.token,
      token_type: "Bearer",
      expires_in: minted.expiresInSeconds,
      refresh_token: params.refreshSecret,
      ...(params.scope !== undefined ? { scope: params.scope } : {}),
    });
  };

  return {
    async handleToken(req, res) {
      if (req.method !== "POST") {
        writeJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      let form: URLSearchParams;
      try {
        form = await readBoundedFormBody(req, readHttpBodyLimitBytes(env));
      } catch (error) {
        if (error instanceof HttpRequestBodyError) {
          writeJson(res, error.statusCode, { error: "invalid_request", error_description: error.publicMessage });
          return;
        }
        throw error;
      }
      // RFC 8707, enforced when present, on the token leg too.
      const resource = form.get("resource");
      if (resource !== null && resource !== config.resourceUrl) {
        tokenError(res, "invalid_target", "The requested resource is not served by this authorization server.");
        return;
      }
      const grantType = form.get("grant_type");
      if (grantType === "authorization_code") {
        await handleAuthorizationCodeGrant(form, res);
        return;
      }
      if (grantType === "refresh_token") {
        await handleRefreshTokenGrant(form, res);
        return;
      }
      tokenError(res, "unsupported_grant_type", "Only authorization_code and refresh_token grants are supported.");
    },
  };

  async function handleAuthorizationCodeGrant(form: URLSearchParams, res: ServerResponse): Promise<void> {
    const code = form.get("code");
    const redirectUri = form.get("redirect_uri");
    const clientId = form.get("client_id");
    const codeVerifier = form.get("code_verifier");
    if (!code || !redirectUri || !clientId || !codeVerifier) {
      tokenError(res, "invalid_request", "code, redirect_uri, client_id, and code_verifier are required.");
      return;
    }
    // Consume FIRST: whatever else is wrong with this request, the code is spent. A wrong
    // verifier, client, or redirect must not leave the code alive for another try.
    const consumeResult = await grantStore.consumeGrant(code);
    if (consumeResult.status !== "consumed") {
      tokenError(res, "invalid_grant", "The authorization code is not redeemable.");
      return;
    }
    const grant = consumeResult.grant;
    if (grant.kind !== "code") {
      tokenError(res, "invalid_grant", "The presented token is not an authorization code.");
      return;
    }
    if (Date.parse(grant.expiresAt) < now()) {
      tokenError(res, "invalid_grant", "The authorization code has expired.");
      return;
    }
    if (grant.clientId !== clientId) {
      tokenError(res, "invalid_grant", "The authorization code was issued to a different client.");
      return;
    }
    if (grant.redirectUri !== redirectUri) {
      tokenError(res, "invalid_grant", "The redirect_uri does not match the authorization request.");
      return;
    }
    if (!CODE_VERIFIER_PATTERN.test(codeVerifier) || !pkceS256Matches(codeVerifier, grant.codeChallenge)) {
      tokenError(res, "invalid_grant", "The PKCE code_verifier does not match.");
      return;
    }
    // Positive narrowing before seating the first refresh into the code's (fresh) family.
    const client = isRecruiterClient(grant.client) ? grant.client : undefined;
    const surface = grant.surface === "claude_desktop" || grant.surface === "chatgpt_desktop"
      ? grant.surface
      : undefined;
    if (client === undefined || surface === undefined) {
      tokenError(res, "invalid_grant", "The grant is not usable.");
      return;
    }
    const refreshSecret = generateSecret();
    const jti = generateJti();
    await grantStore.insertGrant({
      kind: "refresh",
      secret: refreshSecret,
      familyId: grant.familyId,
      clientId: grant.clientId,
      email: grant.email,
      surface,
      client,
      resource: grant.resource,
      ...(grant.scope !== undefined ? { scope: grant.scope } : {}),
      accessJti: jti,
      expiresAt: new Date(now() + OAUTH_REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString(),
    });
    mintAndWrite(res, {
      email: grant.email,
      client: grant.client,
      surface: grant.surface,
      ...(grant.scope !== undefined ? { scope: grant.scope } : {}),
      refreshSecret,
      jti,
      sid: grant.familyId,
    });
  }

  async function handleRefreshTokenGrant(form: URLSearchParams, res: ServerResponse): Promise<void> {
    const refreshToken = form.get("refresh_token");
    const clientId = form.get("client_id");
    if (!refreshToken || !clientId) {
      tokenError(res, "invalid_request", "refresh_token and client_id are required.");
      return;
    }
    // The identity gate, BEFORE the token is consumed (CLO-272): a refresh is the one moment a
    // hosted-Claude session re-enters the server without a tool call, so it is where a de-enrolled
    // recruiter is caught. Peek at the row the token names, ask the directory about that email,
    // and on a DEFINITIVE "no longer enrolled" revoke the whole family with the presented token
    // still intact (no successor is ever seated). A directory outage is not a verdict: nothing is
    // consumed, nothing is revoked, and the client retries later — a transient blip must never
    // read as reuse and kill the session.
    let peek;
    try {
      peek = await grantStore.peekRefresh(refreshToken);
    } catch {
      logTokenDenial("refresh_peek_unavailable");
      writeJson(res, 503, { error: "temporarily_unavailable", error_description: "The refresh token could not be checked; retry shortly." });
      return;
    }
    if (peek.status === "found" && !peek.consumed && !peek.revoked) {
      let verdict: "enrolled" | "not_enrolled";
      try {
        const resolution = await resolveIdentityDirectory().resolve({
          subject: `email:${peek.email}`,
          email: peek.email,
          ...(peek.surface === "claude_desktop" || peek.surface === "chatgpt_desktop" ? { surface: peek.surface } : {}),
          ...(isRecruiterClient(peek.client) ? { client: peek.client } : {}),
        } as Parameters<IdentityDirectory["resolve"]>[0]);
        verdict = resolution.status === "resolved" && isSafePositiveGreenhouseUserId(resolution.greenhouseUserId)
          ? "enrolled"
          : "not_enrolled";
      } catch {
        logTokenDenial("refresh_identity_lookup_failed");
        writeJson(res, 503, { error: "temporarily_unavailable", error_description: "The recruiter directory could not be reached; retry shortly." });
        return;
      }
      if (verdict === "not_enrolled") {
        try {
          await grantStore.revokeFamily(peek.familyId, { reason: "identity_unresolved", revokedBy: "oauth_refresh_identity_gate" });
        } catch {
          // Fail closed either way: the token is refused now; the family sweep is retried on the
          // next presentation, and the per-request directory check already denies every tool call.
          logTokenDenial("refresh_family_revoke_failed");
        }
        tokenError(res, "invalid_grant", "The refresh token is not redeemable.");
        return;
      }
    }
    // One atomic rotation: consume the presented token, detect reuse, revoke the family, and seat
    // the successor all inside the store's per-family-locked transaction. The successor secret is
    // minted here but only becomes live if the RPC reports a clean rotation — a reuse or any
    // transient failure never leaves it redeemable.
    const refreshSecret = generateSecret();
    const jti = generateJti();
    const result = await grantStore.redeemRefresh({
      presentedSecret: refreshToken,
      clientId,
      now: now(),
      successorSecret: refreshSecret,
      successorExpiresAt: new Date(now() + OAUTH_REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString(),
      successorJti: jti,
    });
    if (result.status === "reuse_revoked") {
      // A replayed (already-rotated) refresh token is the stolen-token signal; the family was
      // revoked FIRST as a durable property (RFC 6749 §10.4), before the caller learns anything.
      logTokenDenial("refresh_reuse_family_revoked");
      tokenError(res, "invalid_grant", "The refresh token is not redeemable.");
      return;
    }
    if (result.status === "family_revoked") {
      // The session kill switch reached this lineage (an operator revoked one of its jtis); the
      // RPC swept the family under its lock and refused. Same wire answer as a reuse.
      logTokenDenial("refresh_family_revoked");
      tokenError(res, "invalid_grant", "The refresh token is not redeemable.");
      return;
    }
    if (result.status !== "rotated") {
      tokenError(res, "invalid_grant", "The refresh token is not redeemable.");
      return;
    }
    mintAndWrite(res, {
      email: result.grant.email,
      client: result.grant.client,
      surface: result.grant.surface,
      ...(result.grant.scope !== undefined ? { scope: result.grant.scope } : {}),
      refreshSecret,
      jti,
      sid: result.grant.familyId,
    });
  }
}

function pkceS256Matches(codeVerifier: string, codeChallenge: string | undefined): boolean {
  if (codeChallenge === undefined || codeChallenge.length === 0) return false;
  const digest = createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
  const expected = Buffer.from(codeChallenge);
  const actual = Buffer.from(digest);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// Structured, PII-free stderr (the mount-failure precedent): the error code only — never a
// token, a code, or an email.
function logTokenDenial(reason: string): void {
  const sanitized = reason.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80);
  console.error(`[greenhouse-recruiter-mcp] oauth_token_denied reason=${sanitized}`);
}
