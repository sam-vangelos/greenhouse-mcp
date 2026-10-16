import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createOauthTokenHandler } from "../src/oauth-token.js";
import { readOauthAuthorizationConfig, OAUTH_REFRESH_TOKEN_TTL_SECONDS } from "../src/oauth-config.js";
import {
  hashOauthGrantSecret,
  type OauthGrantRecordInput,
  type OauthGrantStore,
  type OauthRefreshRedeemResult,
} from "../src/oauth-grant-store.js";
import { CLAUDE_CODE_CIMD_URL } from "../src/oauth-clients.js";

// R1-A: the atomic-rotation regression lock. The green 1280-suite hid the race because every
// prior OAuth test used a synchronous, single-call-at-a-time fake. These tests interleave two
// concurrent redemptions at the store seam and prove the two symptoms a non-atomic consume+insert
// pair could not avoid are gone: (1) a winner's successor surviving a concurrent reuse-revoke;
// (2) a transient failure between consume and insert destroying a legitimate family.

const STRONG_SESSION_SECRET = "session-secret-value-with-at-least-32-chars";
const OAUTH_SIGNING_SECRET = "oauth-signing-secret-value-with-at-least-32-chars";
const RESOURCE_URL = "https://recruiter-mcp.example.com/mcp";
const FAMILY = "11111111-2222-4333-8444-555555555555";
const REFRESH_SECRET = "the-outstanding-refresh-token-secret-value-abcdefghij";

function oauthEnv(): NodeJS.ProcessEnv {
  return {
    GREENHOUSE_RECRUITER_MCP_PORT: "0",
    GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
    GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS: "example.com",
    GREENHOUSE_RECRUITER_OAUTH_SIGNING_SECRET: OAUTH_SIGNING_SECRET,
    GREENHOUSE_RECRUITER_OAUTH_ISSUER: "https://recruiter-mcp.example.com",
    GREENHOUSE_RECRUITER_OAUTH_RESOURCE_URL: RESOURCE_URL,
    GREENHOUSE_RECRUITER_OAUTH_GOOGLE_CLIENT_ID: "google-client-id-value.apps.googleusercontent.com",
    GREENHOUSE_RECRUITER_OAUTH_GOOGLE_CLIENT_SECRET: "google-client-secret-value",
    GREENHOUSE_RECRUITER_OAUTH_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
    GREENHOUSE_RECRUITER_OAUTH_SUPABASE_KEY: "oauth-grants-key-value",
    // The refresh leg re-checks enrollment (CLO-272); the outstanding grant's recruiter is enrolled.
    GREENHOUSE_RECRUITER_IDENTITY_JSON: JSON.stringify([{ email: "recruiter@example.com", status: "resolved", greenhouseUserId: 4242 }]),
  } as NodeJS.ProcessEnv;
}

// The refresh leg peeks at the presented row before the rotation; these fakes answer from their
// own rows and never revoke on their own (the atomicity contract under test is the rotation's).
function peekFrom(rows: Map<string, { input: OauthGrantRecordInput; consumedAt?: string; revokedAt?: string }>): OauthGrantStore["peekRefresh"] {
  return async (secret) => {
    const entry = rows.get(hashOauthGrantSecret(secret));
    if (!entry || entry.input.kind !== "refresh") return { status: "not_found" };
    return {
      status: "found",
      email: entry.input.email,
      familyId: entry.input.familyId,
      clientId: entry.input.clientId,
      surface: entry.input.surface,
      client: entry.input.client,
      consumed: entry.consumedAt !== undefined,
      revoked: entry.revokedAt !== undefined,
    };
  };
}
const NO_REVOCATION: Pick<OauthGrantStore, "revokeFamily" | "revokeGrantsForEmail"> = {
  async revokeFamily() { throw new Error("revokeFamily not expected in the atomicity contract"); },
  async revokeGrantsForEmail() { throw new Error("revokeGrantsForEmail not expected in the atomicity contract"); },
};

function requireConfig() {
  const result = readOauthAuthorizationConfig(oauthEnv());
  if (result.state !== "configured") throw new Error("unreachable");
  return result.config;
}

class FakeResponse {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = "";
  headersSent = false;
  setHeader(n: string, v: string) { this.headers[n.toLowerCase()] = String(v); return this; }
  writeHead(s: number, h?: Record<string, string>) { this.statusCode = s; if (h) for (const [k, v] of Object.entries(h)) this.headers[k.toLowerCase()] = String(v); this.headersSent = true; return this; }
  end(c?: unknown) { if (c !== undefined) this.body += String(c); return this; }
  json(): Record<string, unknown> { return JSON.parse(this.body) as Record<string, unknown>; }
}

function refreshRequest(): IncomingMessage {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: REFRESH_SECRET, client_id: CLAUDE_CODE_CIMD_URL }).toString();
  const stream = Readable.from([Buffer.from(body, "utf8")]);
  return Object.assign(stream, { method: "POST", url: "/token", headers: { "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body)) } }) as unknown as IncomingMessage;
}

interface Entry { input: OauthGrantRecordInput; consumedAt?: string; revokedAt?: string; }

function seededRefresh(): Entry {
  return {
    input: {
      kind: "refresh", secret: REFRESH_SECRET, familyId: FAMILY, clientId: CLAUDE_CODE_CIMD_URL,
      email: "recruiter@example.com", surface: "claude_desktop", client: "claude_code",
      resource: RESOURCE_URL, scope: "offline_access",
      expiresAt: new Date(Date.now() + OAUTH_REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString(),
    },
  };
}

// A concurrency-capable store whose redeemRefresh models the migration's per-family advisory lock
// as a promise-chain mutex, with a real `await` inside the critical section. Two overlapping
// redemptions therefore genuinely race at the JS scheduler — but the mutex serializes the
// consume/reuse-revoke/seat decision exactly as pg_advisory_xact_lock does in Postgres.
function lockedStore() {
  const rows = new Map<string, Entry>();
  const revokedFamilies = new Set<string>();
  let familyLock: Promise<void> = Promise.resolve();
  rows.set(hashOauthGrantSecret(REFRESH_SECRET), seededRefresh());

  const withFamilyLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    const prior = familyLock;
    let release!: () => void;
    familyLock = new Promise<void>((r) => { release = r; });
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  };

  const store: OauthGrantStore = {
    ...NO_REVOCATION,
    peekRefresh: peekFrom(rows),
    async insertGrant(input) { rows.set(hashOauthGrantSecret(input.secret), { input }); },
    async consumeGrant() { throw new Error("consumeGrant not used on the refresh leg"); },
    async redeemRefresh(input): Promise<OauthRefreshRedeemResult> {
      return withFamilyLock(async () => {
        const entry = rows.get(hashOauthGrantSecret(input.presentedSecret));
        if (!entry) return { status: "not_redeemable", detail: "not_found" };
        const family = entry.input.familyId;
        // Snapshot the decision the way a non-atomic store reads the row and THEN acts a network
        // hop later. Outside the family lock, two overlapping redemptions would both snapshot the
        // token as consumable here and both seat a successor; the lock is what makes that
        // impossible. (Delete `withFamilyLock` and this test goes red with two survivors — teeth.)
        const wasConsumable = entry.consumedAt === undefined && entry.revokedAt === undefined && !revokedFamilies.has(family);
        const wasConsumedRefresh = entry.input.kind === "refresh" && entry.consumedAt !== undefined;
        await Promise.resolve();
        if (wasConsumable) {
          entry.consumedAt = new Date(input.now).toISOString();
          rows.set(hashOauthGrantSecret(input.successorSecret), {
            input: { ...entry.input, kind: "refresh", secret: input.successorSecret, expiresAt: input.successorExpiresAt },
          });
          return { status: "rotated", grant: { familyId: family, email: entry.input.email, surface: entry.input.surface, client: entry.input.client, resource: entry.input.resource, ...(entry.input.scope !== undefined ? { scope: entry.input.scope } : {}) } };
        }
        if (wasConsumedRefresh && !revokedFamilies.has(family)) {
          revokedFamilies.add(family);
          for (const other of rows.values()) if (other.input.familyId === family && other.revokedAt === undefined) other.revokedAt = new Date(input.now).toISOString();
          return { status: "reuse_revoked" };
        }
        return { status: "not_redeemable", detail: "not_redeemable" };
      });
    },
  };
  return { store, rows, revokedFamilies };
}

async function driveRefresh(handler: ReturnType<typeof createOauthTokenHandler>): Promise<FakeResponse> {
  const res = new FakeResponse();
  await handler.handleToken(refreshRequest(), res as unknown as ServerResponse);
  return res;
}

describe("OAuth refresh rotation atomicity (R1-A)", () => {
  it("two concurrent redemptions of one refresh token leave NO surviving successor and kill the family", async () => {
    const { store, rows, revokedFamilies } = lockedStore();
    const handler = createOauthTokenHandler(requireConfig(), oauthEnv(), { grantStore: store });

    const [a, b] = await Promise.all([driveRefresh(handler), driveRefresh(handler)]);

    // Exactly one redemption wins; the loser is invalid_grant, never a second live token.
    const statuses = [a.statusCode, b.statusCode].sort();
    assert.deepEqual(statuses, [200, 400], `exactly one rotation should win; got ${statuses.join(",")}`);
    const loser = a.statusCode === 400 ? a : b;
    assert.equal(loser.json()["error"], "invalid_grant");

    // The reuse response revoked the family as a durable property.
    assert.ok(revokedFamilies.has(FAMILY), "the reused family must be revoked");

    // The winner's successor cannot outlive the killed family.
    const survivors = [...rows.values()].filter(
      (e) => e.input.familyId === FAMILY && e.input.kind === "refresh" && e.consumedAt === undefined && e.revokedAt === undefined
    );
    assert.equal(survivors.length, 0, `a revoked family must have NO surviving unrevoked successor; found ${survivors.length}`);
  });

  it("a transient rotation failure rolls back — the token stays redeemable and the family is NOT falsely revoked", async () => {
    const rows = new Map<string, Entry>();
    rows.set(hashOauthGrantSecret(REFRESH_SECRET), seededRefresh());
    const revokedFamilies: string[] = [];
    let failNext = true;

    // Atomic contract: a failed rotation mutates NOTHING (the whole transaction rolls back). The
    // presented token is never left consumed-without-a-successor, so the honest client retry is a
    // clean rotation, not a mis-read theft signal that destroys the family.
    const store: OauthGrantStore = {
      ...NO_REVOCATION,
      peekRefresh: peekFrom(rows),
      async insertGrant(input) { rows.set(hashOauthGrantSecret(input.secret), { input }); },
      async consumeGrant() { throw new Error("not used"); },
      async redeemRefresh(input): Promise<OauthRefreshRedeemResult> {
        if (failNext) { failNext = false; throw new Error("OAuth refresh rotation failed with status 503."); }
        const entry = rows.get(hashOauthGrantSecret(input.presentedSecret))!;
        if (entry.consumedAt !== undefined) return { status: "reuse_revoked" };
        entry.consumedAt = new Date(input.now).toISOString();
        rows.set(hashOauthGrantSecret(input.successorSecret), { input: { ...entry.input, secret: input.successorSecret, expiresAt: input.successorExpiresAt } });
        return { status: "rotated", grant: { familyId: entry.input.familyId, email: entry.input.email, surface: entry.input.surface, client: entry.input.client, resource: entry.input.resource, scope: entry.input.scope } };
      },
    };
    const handler = createOauthTokenHandler(requireConfig(), oauthEnv(), { grantStore: store });

    // The transient blip surfaces as a thrown error (the server's 500 path), not a false theft.
    await assert.rejects(() => driveRefresh(handler), /rotation failed with status 503/);
    assert.deepEqual(revokedFamilies, [], "a transient failure must not revoke the family");
    assert.equal(rows.get(hashOauthGrantSecret(REFRESH_SECRET))!.consumedAt, undefined, "the presented token must stay redeemable after a rolled-back attempt");

    // The honest retry rotates cleanly.
    const retry = await driveRefresh(handler);
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json()["token_type"], "Bearer");
  });

  it("migration 0006 rotates under a per-family lock and refuses a successor once the family is revoked (documented DB contract)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(join(here, "..", "supabase", "migrations", "0006_oauth_authorization_grants.sql"), "utf8");
    // Family revocation is a durable property, not a row sweep.
    assert.match(sql, /create table if not exists recruiter_mcp_oauth_revoked_families/);
    // The rotation is serialized per family and refuses to seat a successor into a revoked family.
    assert.match(sql, /create or replace function redeem_oauth_refresh/);
    assert.match(sql, /pg_advisory_xact_lock\(hashtext\(v_family\)\)/);
    assert.match(sql, /recruiter_mcp_oauth_revoked_families where family_id = v_family/);
    // The successor insert lives INSIDE the same locked function, after the revoked-family guard.
    const fn = sql.slice(sql.indexOf("function redeem_oauth_refresh"));
    const lockIdx = fn.indexOf("pg_advisory_xact_lock");
    const insertIdx = fn.indexOf("insert into recruiter_mcp_oauth_grants");
    assert.ok(lockIdx >= 0 && insertIdx > lockIdx, "the successor insert must sit under the family lock");
    // The refresh leg's binding checks live in the locked function (moved off the app), after the
    // burn and before the successor seat — a wrong client or an expired token still spends the token.
    assert.match(fn, /v_row\.grant_kind <> 'refresh'/);
    assert.match(fn, /v_row\.expires_at < p_now/);
    assert.match(fn, /v_row\.client_id <> p_client_id/);
  });

  it("migration 0006 persists the access jti and copies the family's jtis into the revocation list on reuse (R1-B contract)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(join(here, "..", "supabase", "migrations", "0006_oauth_authorization_grants.sql"), "utf8");
    // Each refresh row records the access-token jti minted with it, so the kill switch can reach it.
    assert.match(sql, /access_jti text/);
    // On a refresh-reuse, the family's outstanding jtis are dropped into the session revocation list
    // in the SAME transaction (idempotent, bounded to the reused family, only non-null jtis).
    assert.match(sql, /insert into recruiter_mcp_session_revocation/);
    assert.match(sql, /from recruiter_mcp_oauth_grants\s*\n\s*where family_id = v_family and access_jti is not null/);
    assert.match(sql, /on conflict \(token_id\) do nothing/);
  });
});

describe("migration 0007 — session termination reaches the refresh family (CLO-272, documented DB contract)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, "..", "supabase", "migrations", "0007_oauth_session_termination.sql"), "utf8");

  it("re-declares redeem_oauth_refresh with the revoked-jti guard BETWEEN the family lock and the consume", () => {
    const fn = sql.slice(sql.indexOf("create or replace function redeem_oauth_refresh("));
    const lockIdx = fn.indexOf("pg_advisory_xact_lock(hashtext(v_family))");
    const joinIdx = fn.indexOf("join recruiter_mcp_session_revocation r on r.token_id = g.access_jti");
    const sweepIdx = fn.indexOf("perform revoke_oauth_family_locked(v_family, p_now, 'session_revoked'");
    const consumeIdx = fn.indexOf("update recruiter_mcp_oauth_grants set consumed_at = p_now");
    assert.ok(lockIdx >= 0 && joinIdx > lockIdx, "the revoked-jti join must run under the family lock");
    assert.ok(sweepIdx > joinIdx && sweepIdx < consumeIdx, "a revoked family is swept and refused BEFORE the presented token is consumed");
    assert.match(fn, /return jsonb_build_object\('status', 'family_revoked'\)/);
    // The predicate itself, not just its position: bounded to THIS family, revoked rows only, and
    // actually consulted (a neutered `if false` or an unbounded join would keep the positions intact).
    assert.match(fn, /where g\.family_id = v_family and r\.status = 'revoked'/);
    assert.match(fn, /if v_jti_revoked then/);
    // 0006's own branches survive verbatim.
    assert.match(fn, /v_row\.grant_kind <> 'refresh'/);
    assert.match(fn, /return jsonb_build_object\('status', 'reuse_revoked'\)/);
  });

  it("the operator RPCs take the same per-family advisory lock BEFORE sweeping, in family_id order", () => {
    const byEmail = sql.slice(sql.indexOf("create or replace function revoke_oauth_grants_for_email("), sql.indexOf("create or replace function redeem_oauth_refresh("));
    assert.match(byEmail, /order by family_id/);
    // An email with no live family is reported not_found, never as a successful revocation.
    assert.match(byEmail, /case when v_families = 0 then 'not_found' else 'revoked' end/);
    const lockIdx = byEmail.indexOf("pg_advisory_xact_lock(hashtext(v_family))");
    const sweepIdx = byEmail.indexOf("revoke_oauth_family_locked(v_family");
    assert.ok(lockIdx >= 0 && sweepIdx > lockIdx, "each family is locked before it is swept");
    const oneFamily = sql.slice(sql.indexOf("create or replace function revoke_oauth_family("), sql.indexOf("create or replace function revoke_oauth_grants_for_email("));
    const oneLockIdx = oneFamily.indexOf("pg_advisory_xact_lock(hashtext(p_family_id))");
    const oneSweepIdx = oneFamily.indexOf("revoke_oauth_family_locked(p_family_id");
    assert.ok(oneLockIdx >= 0 && oneSweepIdx > oneLockIdx, "the single-family RPC locks before it sweeps");
  });

  it("the shared sweep revokes rows, records the family as dead, and copies EVERY jti idempotently; the cache reload is requested", () => {
    const locked = sql.slice(sql.indexOf("create or replace function revoke_oauth_family_locked("), sql.indexOf("create or replace function revoke_oauth_family("));
    assert.match(locked, /set revoked_at = coalesce\(revoked_at, p_now\)/);
    assert.match(locked, /insert into recruiter_mcp_oauth_revoked_families/);
    assert.match(locked, /insert into recruiter_mcp_session_revocation \(token_id, status, revoked_at, revoked_by, reason\)/);
    assert.match(locked, /where family_id = p_family and access_jti is not null/);
    assert.match(locked, /on conflict \(token_id\) do nothing/);
    assert.match(sql, /notify pgrst, 'reload schema'/);
    // Rollback is documented with exact signatures, code-first.
    assert.match(sql, /drop function if exists revoke_oauth_grants_for_email\(text, timestamptz, text, text\)/);
  });
});
