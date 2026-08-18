import { createHmac, timingSafeEqual } from "node:crypto";
import { issueActionSession, validateActionSession } from "../../action-mcp/dist/index.js";
import type { ActionClient, ActionSession, ActionStore } from "../../action-mcp/dist/index.js";
import type { AuthenticatedSession, RecruiterClient } from "./types.js";

/**
 * The bridge between the two session types — Phase 2c Slice 0b.
 *
 * The recruiter server authenticates an `AuthenticatedSession`; the action service requires an
 * `ActionSession` whose token id matches `/^action:[A-Za-z0-9_-]{8,120}$/` (`action-mcp/src/crypto.ts`).
 * A recruiter token id does not match, which is why action tools could not be registered at all.
 *
 * The shape is ATTENUATION, not fresh issuance. The recruiter's signed session is already a
 * capability; the precedented move is to derive a narrower one from it rather than mint an unrelated
 * peer. Three properties carry that:
 *
 *   1. **The derived id is a pure function of the parent id.** Same recruiter session always yields
 *      the same action session, so an intent minted under it stays verifiable across process
 *      restarts and instances without storing anything.
 *   2. **The parent id is not recoverable from it.** It is an HMAC under the scope signing secret,
 *      so the derived id can appear in a ledger row without leaking the session token's identity.
 *   3. **`TOKEN_ID_PATTERN` is satisfied, never relaxed.** Weakening that pattern to make the types
 *      line up would trade a real control — it is what stops cross-session intent replay
 *      (`action-mcp/src/service.ts` `assertIntentSession`) — for a type convenience.
 *
 * Both fail-closed rules below deny rather than degrade, and both are about binding rather than
 * caution: a session we cannot bind to a stable id or to a named client is one whose writes we could
 * not attribute afterwards, and an unattributable write is the thing the ledger exists to prevent.
 */

/** Domain separation: this HMAC must never collide with a scope-handle or confirmation-token MAC. */
const DERIVATION_DOMAIN = "greenhouse-action-session:v1";

export class ActionSessionBridgeError extends Error {
  constructor(readonly code: "NO_TOKEN_ID" | "NO_CLIENT" | "UNSUPPORTED_CLIENT" | "INVALID_DERIVATION", message: string) {
    super(message);
    this.name = "ActionSessionBridgeError";
  }
}

/**
 * Physical client, carried across so the entitlement stays per-client.
 *
 * `claude_desktop_chat` exists on the action side only because this bridge needed it: the write
 * plane was specified for Codex and Claude Code, so a Desktop recruiter could hold every entitlement
 * in the table and still never reach a write tool. Adding the member was the fix; mapping Desktop
 * onto one of the other two would have silently mis-attributed every write it made.
 */
const CLIENT_MAP: Readonly<Record<RecruiterClient, ActionClient>> = {
  claude_desktop_chat: "claude_desktop_chat",
  claude_code: "claude_code",
  chatgpt_codex_host: "codex",
};

/** `action:` + base64url(HMAC-SHA256), which is 43 chars and inside the 8-120 the pattern allows. */
export function deriveActionTokenId(recruiterTokenId: string, signingSecret: string): string {
  const mac = createHmac("sha256", signingSecret)
    .update(`${DERIVATION_DOMAIN}:${recruiterTokenId}`)
    .digest("base64url");
  return `action:${mac}`;
}

export interface DerivedActionSession {
  session: ActionSession;
  /** The signed form. Round-tripped through the action package's own validator before it is used. */
  token: string;
  /** The recruiter token id this was derived from. Revocation must consult it too — see below. */
  parentTokenId: string;
}

export function deriveActionSession(input: {
  session: AuthenticatedSession;
  /** Recruiter-owned secret. Derives the id, and is domain-separated from anything the action plane signs. */
  signingSecret: string;
  /** Action-plane secret. The derived session is ISSUED and VALIDATED with it, not hand-built. */
  actionSigningSecret?: string;
  nowMs?: number;
  ttlMs?: number;
}): DerivedActionSession {
  const { session, signingSecret } = input;

  // Legacy pre-v2 tokens carry neither field. Denying is not caution — a session with no stable id
  // cannot be revoked and a session with no client cannot be attributed, and the write plane's whole
  // account of who did what rests on both.
  if (!session.tokenId) {
    throw new ActionSessionBridgeError(
      "NO_TOKEN_ID",
      "This session predates signed token ids, so write authority cannot be bound to it or revoked from it. Re-issue the session token."
    );
  }
  if (!session.client) {
    throw new ActionSessionBridgeError(
      "NO_CLIENT",
      "This session carries no signed client identity, so a write could not be attributed to the tool that made it. Re-issue the session token."
    );
  }
  const client = CLIENT_MAP[session.client];
  if (!client) {
    throw new ActionSessionBridgeError(
      "UNSUPPORTED_CLIENT",
      `No action client corresponds to ${session.client}.`
    );
  }

  const issuedAtMs = input.nowMs ?? Date.now();
  // The derived session never outlives the intent it authorizes. The action service re-verifies
  // entitlement, identity and revocation on every preview and every apply, so this window governs
  // nothing on its own — but keeping it short means a derived session captured from a log is inert.
  const ttlMs = input.ttlMs ?? 10 * 60 * 1000;

  // Issued through the action package's OWN minter rather than hand-built, so `TOKEN_ID_PATTERN`
  // actually runs against the derived id. Constructing the object directly type-checks and works —
  // and silently bypasses the one control the spec says not to weaken, which is worse than relaxing
  // it out loud. Then validated back, so the session this bridge hands over is one the action plane
  // has already accepted on its own terms.
  const actionSecret = input.actionSigningSecret ?? signingSecret;
  const issued = issueActionSession(
    {
      subject: session.subject,
      client,
      tokenId: deriveActionTokenId(session.tokenId, signingSecret),
      ttlMs,
      nowMs: issuedAtMs,
    },
    actionSecret
  );
  const validated = validateActionSession(issued.token, actionSecret, issuedAtMs);
  if (!validated.ok) {
    throw new ActionSessionBridgeError("INVALID_DERIVATION", `Derived action session did not validate: ${validated.reason}`);
  }

  return { parentTokenId: session.tokenId, token: issued.token, session: validated.session };
}

/**
 * Revocation must kill the PARENT as well as the derived session — Sam's call, 2026-07-27.
 *
 * The derived id is not the recruiter's id, so revoking the recruiter's token would not by itself
 * stop write authority derived from it: an already-approved intent would keep applying for the rest
 * of its five-minute life. The alternative was a revocation that does not revoke, so this pays a
 * second lookup on every check instead.
 *
 * Cheap in practice — both ids live in the same `recruiter_mcp_session_revocation` table the read
 * plane already uses, and the parent lookup is skipped entirely once the derived id answers true.
 */
export function withParentRevocation(inner: ActionStore, parentTokenId: string): ActionStore {
  return {
    ...inner,
    async isSessionRevoked(tokenId: string): Promise<boolean> {
      if (await inner.isSessionRevoked(tokenId)) return true;
      return inner.isSessionRevoked(parentTokenId);
    },
  };
}

/** Constant-time compare, for tests and for any caller verifying a derived id it was handed. */
export function derivedTokenIdMatches(
  recruiterTokenId: string,
  signingSecret: string,
  candidate: string
): boolean {
  const expected = Buffer.from(deriveActionTokenId(recruiterTokenId, signingSecret));
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
