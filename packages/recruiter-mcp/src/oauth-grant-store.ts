import { createHash } from "node:crypto";
import { fetchWithTimeout } from "./fetch-timeout.js";
import type { OauthAuthorizationConfig } from "./oauth-config.js";
import type { RecruiterClient } from "./types.js";

// Durable OAuth grant store over the existing Supabase/PostgREST conventions (the identity
// directory's read shape, the session-revocation write shape). One table holds both one-time
// authorization codes and rotating refresh tokens; see supabase/migrations/0006.
//
// The store deals in RAW secrets at its boundary and hashes internally, so hash-only-at-rest
// holds by construction: no caller can accidentally persist a code or refresh-token string,
// and the sha256 CHECK constraint in the migration backstops the same invariant in Postgres.

export type OauthGrantKind = "code" | "refresh";

export interface OauthGrantRecordInput {
  kind: OauthGrantKind;
  /** The raw one-time secret handed to the client; only its sha256 is stored. */
  secret: string;
  familyId: string;
  clientId: string;
  redirectUri?: string;
  codeChallenge?: string;
  email: string;
  surface: "claude_desktop" | "chatgpt_desktop";
  client: RecruiterClient;
  resource: string;
  scope?: string;
  /** ISO timestamp. */
  expiresAt: string;
  /** The access-token jti minted with this refresh row, so the kill switch can reach it. */
  accessJti?: string;
}

export interface OauthGrantRow {
  kind: OauthGrantKind;
  tokenHash: string;
  familyId: string;
  clientId: string;
  redirectUri?: string;
  codeChallenge?: string;
  email: string;
  surface: string;
  client: string;
  resource: string;
  scope?: string;
  expiresAt: string;
  consumedAt?: string;
  revokedAt?: string;
}

export type OauthGrantConsumeResult =
  | { status: "consumed"; grant: OauthGrantRow }
  | { status: "not_consumable" };

/** The fields a rotated refresh grant hands back so the caller can mint the access-token pair. */
export interface OauthRotatedGrant {
  familyId: string;
  email: string;
  surface: string;
  client: string;
  resource: string;
  scope?: string;
}

export interface OauthRefreshRedeemInput {
  /** The raw refresh token the client presented; only its sha256 crosses the wire. */
  presentedSecret: string;
  clientId: string;
  /** Epoch millis; the store renders the transaction's `now` as an ISO instant. */
  now: number;
  /** The raw successor refresh secret to seat on a successful rotation; hashed at rest. */
  successorSecret: string;
  /** ISO timestamp for the successor's expiry. */
  successorExpiresAt: string;
  /** The access-token jti minted with the successor, persisted so reuse can revoke it. */
  successorJti: string;
}

export type OauthRefreshRedeemResult =
  | { status: "rotated"; grant: OauthRotatedGrant }
  /** A reused (already-rotated) refresh token: the family was revoked as a durable property. */
  | { status: "reuse_revoked" }
  /**
   * The session kill switch reached the family: an access-token jti this lineage minted was revoked
   * (operator CLI, directory de-enrollment), so the RPC swept the whole family and refused — every
   * jti it ever minted is now on the revocation list (migration 0007).
   */
  | { status: "family_revoked" }
  /** Never issued, wrong kind, expired, wrong client, or a family already dead — invalid_grant. */
  | { status: "not_redeemable"; detail: OauthRefreshNotRedeemableDetail };

/** What a refresh row says about itself BEFORE it is consumed — the identity gate reads this. */
export type OauthRefreshPeekResult =
  | { status: "found"; email: string; familyId: string; clientId: string; surface: string; client: string; consumed: boolean; revoked: boolean }
  | { status: "not_found" };

export interface OauthRevocationTarget {
  familyId?: string;
  email?: string;
  reason?: string;
  revokedBy?: string;
}

export interface OauthRevocationOutcome {
  status: "revoked" | "not_found" | "invalid";
  familiesRevoked: number;
  grantsRevoked: number;
  jtisRevoked: number;
}

export type OauthRefreshNotRedeemableDetail =
  | "not_found"
  | "wrong_kind"
  | "expired"
  | "client_mismatch"
  | "not_redeemable";

export interface OauthGrantStore {
  insertGrant(input: OauthGrantRecordInput): Promise<void>;
  /**
   * Atomically mark a one-time authorization code consumed and return it (RPC redeem_oauth_code,
   * single-winner under the family lock). Not consumable — already consumed, revoked, a revoked
   * family, or never issued — is the caller's replay signal (invalid_grant). The verifier checks
   * (PKCE, redirect, client, expiry) stay in the caller, AFTER this burn, so no retry oracle.
   */
  consumeGrant(secret: string): Promise<OauthGrantConsumeResult>;
  /**
   * Atomically rotate a refresh token (RPC redeem_oauth_refresh). Consume, reuse-detection,
   * family revocation, and the successor seat all happen in ONE transaction under a per-family
   * advisory lock, so a concurrent reuse can never leave a live successor behind a killed family,
   * and a transient failure rolls back rather than burning the presented token without a heir.
   */
  redeemRefresh(input: OauthRefreshRedeemInput): Promise<OauthRefreshRedeemResult>;
  /**
   * Read the row a presented refresh token names WITHOUT consuming it, so the identity directory
   * can be consulted before the rotation burns the token. A definitive "this person is no longer
   * enrolled" then revokes the family with the token intact; a directory outage leaves everything
   * untouched and the client retries later (CLO-272).
   */
  peekRefresh(secret: string): Promise<OauthRefreshPeekResult>;
  /** Revoke one refresh family under its advisory lock (RPC revoke_oauth_family). */
  revokeFamily(familyId: string, options?: { reason?: string; revokedBy?: string }): Promise<OauthRevocationOutcome>;
  /** Revoke every live family of an email, each under its lock (RPC revoke_oauth_grants_for_email). */
  revokeGrantsForEmail(email: string, options?: { reason?: string; revokedBy?: string }): Promise<OauthRevocationOutcome>;
}

/**
 * Access to the revocation RPCs without the full OAuth config: the operator CLI and the identity
 * reconciliation run from a shell that holds the identity Supabase pair (same canonical project),
 * not the server's OAuth pair.
 */
export interface OauthRevocationAccess {
  supabaseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_REVOCATION_TIMEOUT_MS = 5_000;
// PostgREST answers a function it has not loaded into its schema cache with PGRST202; the migration
// asks for a reload, but the watcher is asynchronous, so one short retry covers the gap.
const SCHEMA_CACHE_RETRY_DELAY_MS = 750;

export async function revokeOauthGrants(
  access: OauthRevocationAccess,
  target: OauthRevocationTarget
): Promise<OauthRevocationOutcome> {
  const fetchImpl = access.fetchImpl ?? fetch;
  const timeoutMs = access.timeoutMs ?? DEFAULT_REVOCATION_TIMEOUT_MS;
  const origin = access.supabaseUrl.replace(/\/+$/, "");
  const headers = {
    apikey: access.apiKey,
    authorization: `Bearer ${access.apiKey}`,
    accept: "application/json",
    "content-type": "application/json",
  };
  const familyId = target.familyId?.trim();
  const email = target.email?.trim().toLowerCase();
  if ((familyId && email) || (!familyId && !email)) {
    throw new Error("Revoke exactly one of familyId or email.");
  }
  const fn = familyId ? "revoke_oauth_family" : "revoke_oauth_grants_for_email";
  const body = {
    ...(familyId ? { p_family_id: familyId } : { p_email: email }),
    p_now: new Date().toISOString(),
    p_reason: target.reason ?? "operator_revocation",
    p_revoked_by: target.revokedBy ?? null,
  };
  const result = await callRpcWithSchemaRetry(fetchImpl, new URL(`${origin}/rest/v1/rpc/${fn}`), headers, body, timeoutMs, "OAuth grant revocation");
  return toRevocationOutcome(result);
}

async function callRpcWithSchemaRetry(
  fetchImpl: typeof fetch,
  url: URL,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  label: string
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetchWithTimeout(fetchImpl, url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }, timeoutMs, label);
    if (response.ok) return readRpcObject(response, label);
    const text = await response.text().catch(() => "");
    if (attempt === 0 && response.status === 404 && text.includes("PGRST202")) {
      await new Promise((resolve) => setTimeout(resolve, SCHEMA_CACHE_RETRY_DELAY_MS));
      continue;
    }
    throw new Error(`${label} failed with status ${response.status}.`);
  }
  throw new Error(`${label} failed: schema cache did not load the function.`);
}

function toRevocationOutcome(result: Record<string, unknown>): OauthRevocationOutcome {
  const status = result["status"];
  const count = (key: string): number => {
    const value = result[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  return {
    status: status === "revoked" ? "revoked" : status === "not_found" ? "not_found" : "invalid",
    familiesRevoked: count("families_revoked"),
    grantsRevoked: count("grants_revoked"),
    jtisRevoked: count("jtis_revoked"),
  };
}

export interface OauthGrantStoreOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function hashOauthGrantSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function createOauthGrantStore(
  config: OauthAuthorizationConfig,
  options: OauthGrantStoreOptions = {}
): OauthGrantStore {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const baseUrl = `${config.grantsSupabaseUrl}/rest/v1/${encodeURIComponent(config.grantsTable)}`;
  const rpcUrl = (fn: string) => new URL(`${config.grantsSupabaseUrl}/rest/v1/rpc/${fn}`);
  const headers = {
    apikey: config.grantsSupabaseKey,
    authorization: `Bearer ${config.grantsSupabaseKey}`,
    accept: "application/json",
    "content-type": "application/json",
  };

  return {
    async insertGrant(input) {
      const row: Record<string, unknown> = {
        token_hash: hashOauthGrantSecret(input.secret),
        grant_kind: input.kind,
        family_id: input.familyId,
        client_id: input.clientId,
        redirect_uri: input.redirectUri ?? null,
        code_challenge: input.codeChallenge ?? null,
        email: input.email,
        surface: input.surface,
        client: input.client,
        resource: input.resource,
        scope: input.scope ?? null,
        access_jti: input.accessJti ?? null,
        expires_at: input.expiresAt,
      };
      const response = await fetchWithTimeout(fetchImpl, new URL(baseUrl), {
        method: "POST",
        headers: { ...headers, prefer: "return=minimal" },
        body: JSON.stringify(row),
      }, config.lookupTimeoutMs, "OAuth grant insert");
      if (!response.ok) {
        throw new Error(`OAuth grant insert failed with status ${response.status}.`);
      }
    },

    async consumeGrant(secret) {
      const response = await fetchWithTimeout(fetchImpl, rpcUrl("redeem_oauth_code"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          p_token_hash: hashOauthGrantSecret(secret),
          p_now: new Date(now()).toISOString(),
        }),
      }, config.lookupTimeoutMs, "OAuth grant consume");
      if (!response.ok) {
        throw new Error(`OAuth grant consume failed with status ${response.status}.`);
      }
      const result = await readRpcObject(response, "OAuth grant consume");
      if (result["status"] !== "consumed") {
        return { status: "not_consumable" };
      }
      return { status: "consumed", grant: toGrantRow(result) };
    },

    async redeemRefresh(input) {
      const response = await fetchWithTimeout(fetchImpl, rpcUrl("redeem_oauth_refresh"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          p_token_hash: hashOauthGrantSecret(input.presentedSecret),
          p_client_id: input.clientId,
          p_now: new Date(input.now).toISOString(),
          p_successor_hash: hashOauthGrantSecret(input.successorSecret),
          p_successor_expires_at: input.successorExpiresAt,
          p_successor_jti: input.successorJti,
        }),
      }, config.lookupTimeoutMs, "OAuth refresh rotation");
      if (!response.ok) {
        throw new Error(`OAuth refresh rotation failed with status ${response.status}.`);
      }
      const result = await readRpcObject(response, "OAuth refresh rotation");
      const status = result["status"];
      if (status === "rotated") {
        return {
          status: "rotated",
          grant: {
            familyId: asRequiredString(result, "family_id"),
            email: asRequiredString(result, "email"),
            surface: asRequiredString(result, "surface"),
            client: asRequiredString(result, "client"),
            resource: asRequiredString(result, "resource"),
            ...(typeof result["scope"] === "string" ? { scope: result["scope"] } : {}),
          },
        };
      }
      if (status === "reuse_revoked") {
        return { status: "reuse_revoked" };
      }
      if (status === "family_revoked") {
        return { status: "family_revoked" };
      }
      return { status: "not_redeemable", detail: toNotRedeemableDetail(status) };
    },

    async peekRefresh(secret) {
      const url = new URL(baseUrl);
      url.searchParams.set("token_hash", `eq.${hashOauthGrantSecret(secret)}`);
      url.searchParams.set("grant_kind", "eq.refresh");
      url.searchParams.set("select", "email,family_id,client_id,surface,client,consumed_at,revoked_at");
      url.searchParams.set("limit", "1");
      const response = await fetchWithTimeout(fetchImpl, url, {
        method: "GET",
        headers: { apikey: headers.apikey, authorization: headers.authorization, accept: "application/json" },
      }, config.lookupTimeoutMs, "OAuth refresh peek");
      if (!response.ok) {
        throw new Error(`OAuth refresh peek failed with status ${response.status}.`);
      }
      const rows = await response.json() as unknown;
      const row = Array.isArray(rows) ? rows[0] : undefined;
      if (row === undefined || row === null || typeof row !== "object" || Array.isArray(row)) {
        return { status: "not_found" };
      }
      const record = row as Record<string, unknown>;
      return {
        status: "found",
        email: asRequiredString(record, "email"),
        familyId: asRequiredString(record, "family_id"),
        clientId: asRequiredString(record, "client_id"),
        surface: asRequiredString(record, "surface"),
        client: asRequiredString(record, "client"),
        consumed: typeof record["consumed_at"] === "string",
        revoked: typeof record["revoked_at"] === "string",
      };
    },

    async revokeFamily(familyId, options = {}) {
      return revokeOauthGrants(
        { supabaseUrl: config.grantsSupabaseUrl, apiKey: config.grantsSupabaseKey, fetchImpl, timeoutMs: config.lookupTimeoutMs },
        { familyId, ...options }
      );
    },

    async revokeGrantsForEmail(email, options = {}) {
      return revokeOauthGrants(
        { supabaseUrl: config.grantsSupabaseUrl, apiKey: config.grantsSupabaseKey, fetchImpl, timeoutMs: config.lookupTimeoutMs },
        { email, ...options }
      );
    },
  };
}

function toNotRedeemableDetail(status: unknown): OauthRefreshNotRedeemableDetail {
  switch (status) {
    case "not_found":
    case "wrong_kind":
    case "expired":
    case "client_mismatch":
      return status;
    default:
      return "not_redeemable";
  }
}

// A scalar `returns jsonb` function comes back from PostgREST as the object itself; tolerate a
// single-element array wrapper too, so a config quirk cannot turn a valid result into a throw.
async function readRpcObject(response: Response, label: string): Promise<Record<string, unknown>> {
  const data = await response.json() as unknown;
  const value = Array.isArray(data) ? data[0] : data;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned an unexpected response shape.`);
  }
  return value as Record<string, unknown>;
}

function toGrantRow(row: Record<string, unknown>): OauthGrantRow {
  return {
    kind: row["grant_kind"] === "refresh" ? "refresh" : "code",
    tokenHash: asRequiredString(row, "token_hash"),
    familyId: asRequiredString(row, "family_id"),
    clientId: asRequiredString(row, "client_id"),
    ...(typeof row["redirect_uri"] === "string" ? { redirectUri: row["redirect_uri"] } : {}),
    ...(typeof row["code_challenge"] === "string" ? { codeChallenge: row["code_challenge"] } : {}),
    email: asRequiredString(row, "email"),
    surface: asRequiredString(row, "surface"),
    client: asRequiredString(row, "client"),
    resource: asRequiredString(row, "resource"),
    ...(typeof row["scope"] === "string" ? { scope: row["scope"] } : {}),
    expiresAt: asRequiredString(row, "expires_at"),
    ...(typeof row["consumed_at"] === "string" ? { consumedAt: row["consumed_at"] } : {}),
    ...(typeof row["revoked_at"] === "string" ? { revokedAt: row["revoked_at"] } : {}),
  };
}

function asRequiredString(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`OAuth grant row is missing required column ${column}.`);
  }
  return value;
}
