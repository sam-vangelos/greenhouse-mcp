import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuthenticatedSession, RecruiterClient, RecruiterSurface } from "./types.js";
import { DEFAULT_EXTERNAL_LOOKUP_TIMEOUT_MS, fetchWithTimeout, readLookupTimeoutMs } from "./fetch-timeout.js";
import { requireHostedRecruiterStateBackend, readRecruiterStateBackend } from "./state-backend.js";
import { assertCanonicalSupabaseProjectRef, normalizeOptionalSupabaseIdentifier, normalizeSupabaseApiKey, normalizeSupabaseIdentifier, normalizeSupabaseRestOrigin } from "./supabase-config.js";

export type SessionValidationResult =
  | { status: "valid"; session: AuthenticatedSession }
  | { status: "invalid"; reason: string };

export interface SessionValidator {
  validate(token: string | undefined): Promise<SessionValidationResult> | SessionValidationResult;
}

export interface HmacSessionValidatorOptions {
  revokedTokenIds?: ReadonlySet<string>;
  revocationProvider?: SessionRevocationProvider;
}

export interface EnvSessionValidatorOptions {
  requireRevocationProvider?: boolean;
}

export interface SessionRevocationProvider {
  isRevoked(session: AuthenticatedSession): Promise<boolean> | boolean;
}

export interface SupabaseSessionRevocationConfig {
  supabaseUrl: string;
  apiKey: string;
  table?: string;
  columns?: Partial<SupabaseSessionRevocationColumns>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface SupabaseSessionRevocationColumns {
  tokenId: string;
  status: string;
  revokedStatus: string;
}

interface SignedSessionPayload {
  subject: string;
  email?: string;
  surface: RecruiterSurface;
  client?: RecruiterClient;
  tokenId?: string;
  issuedAt?: string;
  [key: string]: unknown;
}

const DEFAULT_SUPABASE_REVOCATION_COLUMNS: SupabaseSessionRevocationColumns = {
  tokenId: "token_id",
  status: "status",
  revokedStatus: "revoked",
};

const FORBIDDEN_TOKEN_CLAIMS = new Set([
  "greenhouseUserId",
  "greenhouseUserID",
  "greenhouse_user_id",
  "greenhouseUserIds",
  "greenhouseUserIDs",
  "greenhouse_user_ids",
  "permittedJobIds",
  "permitted_job_ids",
  "jobIds",
  "job_ids",
  "permissions",
  "expiresAt",
  "expires_at",
]);

const NORMALIZED_FORBIDDEN_TOKEN_CLAIMS = new Set(
  Array.from(FORBIDDEN_TOKEN_CLAIMS, normalizeClaimName)
);

const FORBIDDEN_TOKEN_ID_FRAGMENTS = /greenhouseUserId|greenhouse_user_id|permittedJobIds|permitted_job_ids|jobIds|job_ids|permissions|expiresAt|expires_at/i;
const SESSION_TOKEN_ID_PATTERN = /^[A-Za-z0-9:_-]{1,160}$/;

export const MIN_SESSION_SECRET_LENGTH = 32;

export function createSignedSessionToken(
  session: AuthenticatedSession,
  secret: string
): string {
  const payload = base64UrlEncode(JSON.stringify(normalizeSignedSessionPayload(session)));
  const signature = sign(payload, secret);
  return `${payload}.${signature}`;
}

function normalizeSignedSessionPayload(session: AuthenticatedSession): SignedSessionPayload {
  const payload = session as SignedSessionPayload;
  const forbiddenClaim = Object.keys(payload).find((key) => isForbiddenTokenClaim(key));
  if (forbiddenClaim) {
    throw new Error(`Recruiter MCP session token payload contains forbidden scoped claim: ${forbiddenClaim}.`);
  }
  if (!isTrimmedNonEmptyString(payload.subject)) {
    throw new Error("Recruiter MCP session token payload has no subject.");
  }
  if (!isSurface(payload.surface)) {
    throw new Error("Recruiter MCP session token payload has invalid surface.");
  }
  if (payload.client !== undefined && (!isRecruiterClient(payload.client) || !isClientSurfaceCompatible(payload.client, payload.surface))) {
    throw new Error("Recruiter MCP session token payload has invalid client identity for surface.");
  }
  if (payload.email !== undefined && !isTrimmedNonEmptyString(payload.email)) {
    throw new Error("Recruiter MCP session token payload has invalid email.");
  }
  const emailSubjectCheck = validateEmailSubjectBinding(payload);
  if (!emailSubjectCheck.ok) {
    throw new Error(emailSubjectCheck.reason);
  }
  const tokenId = normalizeSessionTokenId(payload.tokenId);
  const issuedAt = normalizeSessionIssuedAt(payload.issuedAt);
  return {
    subject: payload.subject,
    email: payload.email,
    surface: payload.surface,
    client: payload.client,
    tokenId,
    issuedAt,
  };
}

export function createHmacSessionValidator(
  secret: string,
  options: HmacSessionValidatorOptions = {}
): SessionValidator {
  return {
    async validate(token) {
      if (!token) {
        return { status: "invalid", reason: "Missing recruiter MCP session token." };
      }
      const parts = token.split(".");
      if (parts.length !== 2) {
        return { status: "invalid", reason: "Malformed recruiter MCP session token." };
      }
      const [payloadPart, signaturePart] = parts;
      if (!payloadPart || !signaturePart || !signatureMatches(payloadPart, signaturePart, secret)) {
        return { status: "invalid", reason: "Invalid recruiter MCP session token signature." };
      }
      let payload: SignedSessionPayload;
      try {
        payload = JSON.parse(base64UrlDecode(payloadPart)) as SignedSessionPayload;
      } catch {
        return { status: "invalid", reason: "Invalid recruiter MCP session token payload." };
      }
      const forbiddenClaim = Object.keys(payload).find((key) => isForbiddenTokenClaim(key));
      if (forbiddenClaim) {
        return {
          status: "invalid",
          reason: `Recruiter MCP session token contains forbidden scoped claim: ${forbiddenClaim}.`,
        };
      }
      if (!isTrimmedNonEmptyString(payload.subject)) {
        return { status: "invalid", reason: "Recruiter MCP session token has no subject." };
      }
      if (!isSurface(payload.surface)) {
        return { status: "invalid", reason: "Recruiter MCP session token has invalid surface." };
      }
      if (payload.client !== undefined && (!isRecruiterClient(payload.client) || !isClientSurfaceCompatible(payload.client, payload.surface))) {
        return { status: "invalid", reason: "Recruiter MCP session token has invalid client identity for surface." };
      }
      if (payload.email !== undefined && !isTrimmedNonEmptyString(payload.email)) {
        return { status: "invalid", reason: "Recruiter MCP session token has invalid email." };
      }
      const emailSubjectCheck = validateEmailSubjectBinding(payload);
      if (!emailSubjectCheck.ok) {
        return { status: "invalid", reason: emailSubjectCheck.reason };
      }
      const tokenIdCheck = validateSessionTokenId(payload.tokenId);
      if (!tokenIdCheck.ok) {
        return { status: "invalid", reason: tokenIdCheck.reason };
      }
      const issuedAtCheck = validateSessionIssuedAt(payload.issuedAt);
      if (!issuedAtCheck.ok) {
        return { status: "invalid", reason: issuedAtCheck.reason };
      }
      const session: AuthenticatedSession = {
        subject: payload.subject,
        email: payload.email,
        surface: payload.surface,
        client: payload.client,
        tokenId: tokenIdCheck.tokenId,
        issuedAt: issuedAtCheck.issuedAt,
      };
      if (options.revokedTokenIds?.has(tokenIdCheck.tokenId)) {
        return { status: "invalid", reason: "Recruiter MCP session token has been revoked." };
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
          return { status: "invalid", reason: "Recruiter MCP session token has been revoked." };
        }
      }
      return {
        status: "valid",
        session,
      };
    },
  };
}

export function createSessionValidatorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: EnvSessionValidatorOptions = {}
): SessionValidationResult | SessionValidator {
  const secret = env.GREENHOUSE_RECRUITER_SESSION_SECRET;
  if (!secret) {
    return { status: "invalid", reason: "GREENHOUSE_RECRUITER_SESSION_SECRET is required." };
  }
  if (hasLeadingOrTrailingWhitespace(secret)) {
    return {
      status: "invalid",
      reason: "GREENHOUSE_RECRUITER_SESSION_SECRET must not contain leading or trailing whitespace.",
    };
  }
  if (!isStrongSessionSecret(secret)) {
    return {
      status: "invalid",
      reason: `GREENHOUSE_RECRUITER_SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters.`,
    };
  }
  let revocationProvider: SessionRevocationProvider | undefined;
  try {
    if (options.requireRevocationProvider) {
      requireHostedRecruiterStateBackend(env);
    }
    revocationProvider = createSessionRevocationProviderFromEnv(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "invalid", reason: message };
  }
  if (options.requireRevocationProvider && !revocationProvider) {
    return {
      status: "invalid",
      reason: "GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL and GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY are required for remote durable sessions.",
    };
  }
  return createHmacSessionValidator(secret, {
    revokedTokenIds: parseNameList(env.GREENHOUSE_RECRUITER_REVOKED_TOKEN_IDS),
    revocationProvider,
  });
}

export function createSessionRevocationProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env
): SessionRevocationProvider | undefined {
  const backend = readRecruiterStateBackend(env);
  const supabaseUrl = env.GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL;
  const apiKey = env.GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY;
  if (backend === "supabase_postgrest" && (!supabaseUrl || !apiKey)) {
    throw new Error(
      "GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL and GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY are required when GREENHOUSE_RECRUITER_STATE_BACKEND=supabase_postgrest."
    );
  }
  if (!supabaseUrl && !apiKey) return undefined;
  if (!supabaseUrl || !apiKey) {
    throw new Error(
      "GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL and GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY must be set together."
    );
  }
  return createSupabaseSessionRevocationProvider({
    supabaseUrl: assertCanonicalSupabaseProjectRef(supabaseUrl, "Supabase session revocation"),
    apiKey,
    table: env.GREENHOUSE_RECRUITER_REVOCATION_TABLE,
    timeoutMs: readLookupTimeoutMs(
      env.GREENHOUSE_RECRUITER_REVOCATION_LOOKUP_TIMEOUT_MS,
      "GREENHOUSE_RECRUITER_REVOCATION_LOOKUP_TIMEOUT_MS"
    ),
    columns: {
      tokenId: env.GREENHOUSE_RECRUITER_REVOCATION_TOKEN_ID_COLUMN,
      status: env.GREENHOUSE_RECRUITER_REVOCATION_STATUS_COLUMN,
      revokedStatus: env.GREENHOUSE_RECRUITER_REVOCATION_REVOKED_STATUS,
    },
  });
}

export function createSupabaseSessionRevocationProvider(
  config: SupabaseSessionRevocationConfig
): SessionRevocationProvider {
  const columns = normalizeSupabaseSessionRevocationColumns(config.columns);
  const table = normalizeOptionalSupabaseIdentifier(config.table, "recruiter_mcp_session_revocation", "Supabase session revocation table");
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_EXTERNAL_LOOKUP_TIMEOUT_MS;
  const baseUrl = normalizeSupabaseRestOrigin(config.supabaseUrl, "Supabase session revocation");
  const apiKey = normalizeSupabaseApiKey(config.apiKey, "Supabase session revocation");
  return {
    async isRevoked(session) {
      const url = new URL(`${baseUrl}/rest/v1/${encodeURIComponent(table)}`);
      url.searchParams.set("select", `${columns.tokenId},${columns.status}`);
      url.searchParams.set(columns.tokenId, `eq.${session.tokenId}`);
      url.searchParams.set(columns.status, `eq.${columns.revokedStatus}`);
      url.searchParams.set("limit", "1");
      const response = await fetchWithTimeout(fetchImpl, url, {
        method: "GET",
        headers: {
          apikey: apiKey,
          authorization: `Bearer ${apiKey}`,
          accept: "application/json",
        },
      }, timeoutMs, "Session revocation lookup");
      if (!response.ok) {
        throw new Error(`Session revocation lookup failed with status ${response.status}.`);
      }
      const data = await response.json() as unknown;
      if (!Array.isArray(data)) {
        throw new Error("Session revocation lookup returned a non-array response.");
      }
      return data.length > 0;
    },
  };
}

function normalizeSupabaseSessionRevocationColumns(
  columns: Partial<SupabaseSessionRevocationColumns> | undefined
): SupabaseSessionRevocationColumns {
  const normalized: SupabaseSessionRevocationColumns = { ...DEFAULT_SUPABASE_REVOCATION_COLUMNS };
  if (columns) for (const [key, value] of Object.entries(columns) as Array<[keyof SupabaseSessionRevocationColumns, string | undefined]>) {
    if (typeof value === "string" && value.length > 0) {
      normalized[key] = value;
    }
  }
  normalized.tokenId = normalizeSupabaseIdentifier(normalized.tokenId, "Supabase session revocation token id column");
  normalized.status = normalizeSupabaseIdentifier(normalized.status, "Supabase session revocation status column");
  return normalized;
}

export function isStrongSessionSecret(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length >= MIN_SESSION_SECRET_LENGTH;
}

export function hasLeadingOrTrailingWhitespace(value: string | undefined): boolean {
  return typeof value === "string" && value.trim() !== value;
}

export function normalizeSessionTokenId(value: unknown): string {
  const check = validateSessionTokenId(value);
  if (!check.ok) throw new Error(check.reason);
  return check.tokenId;
}

export function normalizeSessionIssuedAt(value: unknown): string {
  const check = validateSessionIssuedAt(value);
  if (!check.ok) throw new Error(check.reason);
  return check.issuedAt;
}

function isTrimmedNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim() === value;
}

const EMAIL_SUBJECT_PREFIX = "email:";

// The canonical form of an `email:` subject, taken from the plane that consumes it rather than
// invented here: `identityLookup` (action-mcp/src/store.ts:226-237) reads the subject back as
// `primary_email` and refuses anything that is not a non-empty, <=254-character, already-trimmed,
// already-lower-case address of this exact shape.
const SUBJECT_EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_SUBJECT_EMAIL_LENGTH = 254;

function isCanonicalSubjectEmail(value: string): boolean {
  return value.length > 0
    && value.length <= MAX_SUBJECT_EMAIL_LENGTH
    && value === value.trim().toLowerCase()
    && SUBJECT_EMAIL_PATTERN.test(value);
}

/**
 * One token, one actor. `subject` and `email` were each validated on their own, which is not the
 * same thing — and it is not the same thing precisely because the two planes read the two claims
 * differently. The read resolver queries the email claim AND the literal subject
 * (identity.ts:294-318). The action plane's store ignores the email claim entirely and reads an
 * `email:` subject back as `primary_email` (action-mcp/src/store.ts:83-95,226-237). So a signed
 * `{subject:"email:a@x", email:"b@x"}` passed both validators and then named B on the read plane
 * and A on the write plane — one token, two actors, the divergence invisible from either side.
 *
 * The standard issuer never produced such a token (`email-session.ts:134-140` derives the subject
 * from the same normalized email it puts in the claim), but "our issuer happens not to" is not a
 * property; this is. Enforced where tokens are validated, and where they are signed, so an
 * unacceptable token is never minted either.
 *
 * An `email:` subject must arrive in the form the action plane can look up. Case-insensitive
 * MATCHING against the email claim was right — the read plane lower-cases the claim before the
 * lookup (identity.ts:310) so `email:a@x` + `A@X` name one directory row — but it was applied to
 * the subject as well, which accepted `email:A@X` and then failed every action with "Action email
 * identity subject is invalid" (store.ts:229-235), because that plane demands the subject already
 * be the canonical address. Rejected here rather than normalized: the subject is an
 * authorization-bearing signed claim and the read plane queries it VERBATIM against
 * `google_subject`, so quietly rewriting it would change which directory rows a session matches.
 * Nothing legitimate is refused — every issuing path builds the subject out of
 * `normalizeWorkEmail`'s already-trimmed, already-lower-cased output (email-session.ts:135,204,277)
 * — and what is refused is a token that could only ever have failed later, further away.
 */
function validateEmailSubjectBinding(
  payload: { subject: string; email?: string }
): { ok: true } | { ok: false; reason: string } {
  if (!payload.subject.startsWith(EMAIL_SUBJECT_PREFIX)) return { ok: true };
  if (!isTrimmedNonEmptyString(payload.email)) {
    return {
      ok: false,
      reason: "Recruiter MCP session token has an email subject but no email claim to bind it to.",
    };
  }
  const subjectEmail = payload.subject.slice(EMAIL_SUBJECT_PREFIX.length);
  if (!isCanonicalSubjectEmail(subjectEmail)) {
    return {
      ok: false,
      reason: "Recruiter MCP session token email subject is not a canonical lower-case email address.",
    };
  }
  if (subjectEmail !== payload.email.toLowerCase()) {
    return {
      ok: false,
      reason: "Recruiter MCP session token email subject does not match its email claim.",
    };
  }
  return { ok: true };
}

/**
 * Does this session prove exactly one actor? The invariant above, asked of a SESSION rather than a
 * token payload, because the write-eligibility path is reachable without token validation:
 * `createRecruiterMcpServer` takes an arbitrary `AuthenticatedSession` (server.ts:61-75), so a
 * hand-assembled `{subject:"email:a@x", email:"b@x"}` never passes through the validator that would
 * have refused it. A session that cannot say who it is cannot be write-eligible.
 *
 * Totality is deliberate: a session assembled in code is only typed, not checked, so a subject that
 * is not a trimmed non-empty string answers false here instead of throwing inside `startsWith`.
 */
export function sessionNamesOneActor(session: AuthenticatedSession): boolean {
  if (!isTrimmedNonEmptyString(session.subject)) return false;
  return validateEmailSubjectBinding(session).ok;
}

function validateSessionTokenId(value: unknown): { ok: true; tokenId: string } | { ok: false; reason: string } {
  if (!isTrimmedNonEmptyString(value)) {
    return { ok: false, reason: "Recruiter MCP session token has no token id." };
  }
  if (value.includes(".")) {
    return { ok: false, reason: "Recruiter MCP session token id must not be a signed token string." };
  }
  if (FORBIDDEN_TOKEN_ID_FRAGMENTS.test(value)) {
    return { ok: false, reason: "Recruiter MCP session token id cannot contain scoped identity, permission, or expiry claim names." };
  }
  if (!SESSION_TOKEN_ID_PATTERN.test(value)) {
    return { ok: false, reason: "Recruiter MCP session token id may contain only letters, numbers, colon, underscore, and hyphen, up to 160 characters." };
  }
  return { ok: true, tokenId: value };
}

function validateSessionIssuedAt(value: unknown): { ok: true; issuedAt: string } | { ok: false; reason: string } {
  if (!isTrimmedNonEmptyString(value)) {
    return { ok: false, reason: "Recruiter MCP session token has no issued-at timestamp." };
  }
  const parsedMs = Date.parse(value);
  if (Number.isNaN(parsedMs) || new Date(parsedMs).toISOString() !== value) {
    return { ok: false, reason: "Recruiter MCP session token has invalid issued-at timestamp." };
  }
  return { ok: true, issuedAt: value };
}

export async function readSessionFromEnv(
  env: NodeJS.ProcessEnv = process.env
): Promise<SessionValidationResult> {
  const validator = createSessionValidatorFromEnv(env);
  if ("status" in validator) {
    return validator;
  }
  return validator.validate(env.GREENHOUSE_RECRUITER_SESSION_TOKEN);
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function signatureMatches(payload: string, signature: string, secret: string): boolean {
  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function parseNameList(raw: string | undefined): Set<string> {
  if (!raw) return new Set<string>();
  return new Set(raw.split(",").map((token) => token.trim()).filter(Boolean));
}

function isForbiddenTokenClaim(key: string): boolean {
  return FORBIDDEN_TOKEN_CLAIMS.has(key) || NORMALIZED_FORBIDDEN_TOKEN_CLAIMS.has(normalizeClaimName(key));
}

function normalizeClaimName(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSurface(value: unknown): value is RecruiterSurface {
  return value === "claude_desktop" || value === "chatgpt_desktop" || value === "test";
}

export function isRecruiterClient(value: unknown): value is RecruiterClient {
  return value === "claude_desktop_chat" || value === "claude_code" || value === "chatgpt_codex_host";
}

export function surfaceForRecruiterClient(client: RecruiterClient): Exclude<RecruiterSurface, "test"> {
  return client === "chatgpt_codex_host" ? "chatgpt_desktop" : "claude_desktop";
}

export function isClientSurfaceCompatible(client: RecruiterClient, surface: RecruiterSurface): boolean {
  return surface !== "test" && surfaceForRecruiterClient(client) === surface;
}

// Both planes name the same physical clients, differently: `chatgpt_codex_host` here is `"codex"` on
// the action plane (action-mcp/src/types.ts:16, branch codex/greenhouse-action-mcp). These names win
// the translation because they are the authorization-bearing ones — a signed token carries a
// RecruiterClient and `isClientSurfaceCompatible` above validates it — so an action-plane name is
// produced here, at the edge, and never flows back inward.
//
// The union is spelled out instead of imported because there is nothing to import from yet: the
// action package is not on this branch at all, its `src/index.ts` barrel is unwritten even there,
// and its `dist/` is gitignored (.gitignore:49). Phase 2 gets a real specifier,
// `../../action-mcp/dist/index.js` (docs/job-scope-resolution/phase-1e-action-package-spec.md,
// section 4.2). Reconcile these two names against `ActionClient` at that point rather than copying
// the vocabulary a third time — a hand-carried union is precisely what drifts unnoticed.
//
// `ActionClient`'s third member, `"test"`, is deliberately absent from the value type. Here `test`
// is a SURFACE, not a client (types.ts:10-11): `isRecruiterClient` (:518-520) rejects it as a client
// value, and `isClientSurfaceCompatible` (:526-528) rejects every client on the `test` surface. No
// session can carry it in either position, so this map can never be asked to translate it.
//
// Named so downstream signatures (the entitlement lookup key) can say which vocabulary they speak
// instead of respelling the union a third time — and spelled ONCE, as an array, so that both
// directions come off the same source: the type is derived from it and so is `isActionClientName`,
// which makes a third member a type change and a runtime change in the same edit. The build's own
// verify caught the alternative in the act. The entitlement cache-key parser had hand-carried this
// union as string literals (action-entitlement.ts `parseLookupCacheKey`), so a new client would have
// compiled clean and thrown at runtime — the exact drift the `Record` gate below exists to prevent,
// reintroduced two files away. That parser now calls the guard instead.
export const ACTION_CLIENT_NAMES = ["codex", "claude_code"] as const;
export type ActionClientName = (typeof ACTION_CLIENT_NAMES)[number];

const ACTION_CLIENT_NAME_SET: ReadonlySet<string> = new Set(ACTION_CLIENT_NAMES);

export function isActionClientName(value: unknown): value is ActionClientName {
  return typeof value === "string" && ACTION_CLIENT_NAME_SET.has(value);
}

// Record<RecruiterClient, ...> is the exhaustiveness gate: a fourth RecruiterClient fails the build
// here until someone decides whether it can write, rather than silently falling through to `null`.
const ACTION_CLIENT_BY_RECRUITER_CLIENT: Record<RecruiterClient, ActionClientName | null> = {
  chatgpt_codex_host: "codex",
  claude_code: "claude_code",
  // The action plane has no word for Claude Desktop chat, which follows from how that surface is
  // reached: it loads a packaged .mcpb rather than this remote server. Nothing downstream could use
  // a name for it even if one existed — the entitlement lookup filters on the client
  // (action-mcp/src/store.ts:110-118, `client: eq.${client}`) and the provisioning CLI grants only
  // codex or claude_code (`parseClients`, action-mcp/src/access-cli.ts:477-485).
  claude_desktop_chat: null,
};

// `null` means write-ineligible, and every caller must handle it — never substitute a default.
export function actionClientForRecruiterSession(
  session: AuthenticatedSession
): ActionClientName | null {
  // A session that cannot prove ONE actor gets no action client, whatever client it claims to be.
  // The binding is enforced at token validation (:169, :111), but this path does not run through
  // either: `createRecruiterMcpServer` accepts an arbitrary `AuthenticatedSession`
  // (server.ts:61-75), so a hand-assembled `{subject:"email:a@x", email:"b@x"}` — the exact token
  // both validators refuse — would otherwise arrive here and be handed to the entitlement lookup as
  // write-capable, with the read plane authorizing B and the action plane authorizing A. Reusing the
  // predicate rather than restating the comparison keeps the copies of this rule from drifting.
  if (!sessionNamesOneActor(session)) return null;
  // A session that cannot prove which client it is gets no action client. types.ts:20-21 calls a
  // missing client a pre-v2 legacy artifact, but that is a comment, not enforcement: the
  // `payload.client !== undefined` guards at :105 and :163 admit any otherwise-valid token whose
  // client is absent, both when signing and when validating. Testing the value rather than trusting
  // the declared type also keeps the lookup total at runtime for a session assembled without going
  // through token validation.
  if (!isRecruiterClient(session.client)) return null;
  // The SAME compatibility rule the two ingress paths enforce (:105, :163), applied again here
  // because this function is reachable without them. `createRecruiterMcpServer` takes an arbitrary
  // `AuthenticatedSession` (server.ts:61-75), so a hand-assembled `{surface:"test",
  // client:"claude_code"}` — a shape no signed token can carry, since both validators reject it —
  // would otherwise arrive here and map to a write-eligible action client. Reusing the predicate
  // rather than restating it keeps the three copies of this rule from drifting apart, and it is
  // total by construction: any surface value that is not the client's own answers false.
  if (!isClientSurfaceCompatible(session.client, session.surface)) return null;
  return ACTION_CLIENT_BY_RECRUITER_CLIENT[session.client];
}
