import { createHmac, timingSafeEqual } from "node:crypto";
import { issueActionSession, validateActionSession } from "../../action-mcp/dist/index.js";
import type { ActionClient, ActionSession, ActionStore } from "../../action-mcp/dist/index.js";
import type { AuthenticatedSession, RecruiterClient, RecruiterSurface } from "./types.js";

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
 * The fail-closed rule below denies rather than degrades, and it is about binding rather than
 * caution: a session we cannot bind to a stable id is one whose write authority we could not revoke
 * afterwards, and an unrevocable write session is the thing the derivation exists to prevent. The
 * client claim works differently since 2026-08-06 (CLO-103): a legacy token names no
 * client, but its SURFACE is signed, so the bridge infers the client from the surface and says so —
 * `clientAttribution` marks the session as inferred, never as self-named.
 */

/** Domain separation: this HMAC must never collide with a scope-handle or confirmation-token MAC. */
const DERIVATION_DOMAIN = "greenhouse-action-session:v1";

export class ActionSessionBridgeError extends Error {
  constructor(readonly code: "NO_TOKEN_ID" | "UNSUPPORTED_CLIENT" | "INVALID_DERIVATION", message: string) {
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

/**
 * The client a legacy pre-v2 token's signed surface implies — decided 2026-08-06 (CLO-103).
 *
 * Every distributed token predates the client claim (45742d1), and re-issuing them means walking
 * recruiters through a reinstall by hand. The surface sits inside the HMAC, so this fallback reads
 * signed data rather than trusting a runtime assertion — and the read plane already serves legacy
 * tokens under exactly this convention (`session.client ?? "legacy_unknown"` in runtime.ts). `test`
 * is deliberately absent: a test-surface session must not derive write authority. What is genuinely
 * lost is precision, not truth — on claude_desktop, chat and Claude Code share one token, so a
 * Claude Code write attributes to `claude_desktop_chat`; a coarser label, flagged as inferred.
 * Re-issued tokens carry `client` and never reach this map.
 */
const LEGACY_SURFACE_CLIENT: Readonly<Partial<Record<RecruiterSurface, ActionClient>>> = {
  claude_desktop: "claude_desktop_chat",
  chatgpt_desktop: "codex",
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
  /**
   * How the client identity was established: carried as a signed claim, or inferred from the signed
   * surface of a legacy token. Ledger writers must never record an inferred client as self-named.
   */
  clientAttribution: "signed" | "inferred_from_surface";
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

  // A session with no stable id still denies. That is not caution — an id-less session cannot be
  // revoked, and the write plane's account of who may still act rests on revocation working.
  if (!session.tokenId) {
    throw new ActionSessionBridgeError(
      "NO_TOKEN_ID",
      "This session predates signed token ids, so write authority cannot be bound to it or revoked from it. Re-issue the session token."
    );
  }

  // A signed client wins; a legacy token falls back to the client its signed surface implies. Both
  // paths read signed data. UNSUPPORTED_CLIENT remains for the cases neither map resolves — an
  // unknown client value, or a surface (test) that must not carry write authority.
  const client = session.client ? CLIENT_MAP[session.client] : LEGACY_SURFACE_CLIENT[session.surface];
  if (!client) {
    throw new ActionSessionBridgeError(
      "UNSUPPORTED_CLIENT",
      session.client
        ? `No action client corresponds to ${session.client}.`
        : `No action client can be inferred from the ${session.surface} surface.`
    );
  }
  const clientAttribution = session.client ? ("signed" as const) : ("inferred_from_surface" as const);

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

  return { parentTokenId: session.tokenId, token: issued.token, session: validated.session, clientAttribution };
}

/**
 * Revocation must kill the PARENT as well as the derived session — decided 2026-07-27.
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
