import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GreenhouseActionService,
  issueActionSession,
  validateActionSession,
  type ActionEntitlement,
  type ActionRecord,
  type ActionStore,
  type ClaimResult,
  type GreenhouseGateway,
  type ResolvedIdentity,
} from "../../action-mcp/dist/index.js";
import {
  ActionSessionBridgeError,
  deriveActionSession,
  deriveActionTokenId,
  derivedTokenIdMatches,
  withParentRevocation,
} from "../src/action-session.js";
import type { AuthenticatedSession } from "../src/types.js";

const SECRET = "bridge-test-scope-signing-secret-at-least-32-bytes";
const IDENTITY_ID = "22222222-2222-4222-8222-222222222222";

function recruiterSession(overrides: Partial<AuthenticatedSession> = {}): AuthenticatedSession {
  return {
    subject: "google-subject-sam",
    surface: "claude_desktop",
    client: "claude_desktop_chat",
    tokenId: "recruiter-token-abc123",
    ...overrides,
  };
}

/**
 * A store that records WHICH token id it was asked about. The action package's own MemoryActionStore
 * answers a flat boolean and ignores the id, so it cannot tell a parent revocation from a derived
 * one — which is precisely the property under test here.
 */
class RevocationTrackingStore implements ActionStore {
  readonly asked: string[] = [];
  readonly revoked = new Set<string>();
  readonly records = new Map<string, ActionRecord>();
  identity: ResolvedIdentity = { identityId: IDENTITY_ID, greenhouseUserId: 77 };
  entitlement: ActionEntitlement | null = {
    identityId: IDENTITY_ID,
    greenhouseUserId: 77,
    client: "claude_desktop_chat",
    canPreview: true,
    canApply: true,
    canApplyHighImpact: true,
  };

  async resolveIdentity(): Promise<ResolvedIdentity> {
    return { ...this.identity };
  }
  async isSessionRevoked(tokenId: string): Promise<boolean> {
    this.asked.push(tokenId);
    return this.revoked.has(tokenId);
  }
  async getEntitlement(_identity: ResolvedIdentity, client: string): Promise<ActionEntitlement | null> {
    return this.entitlement?.client === client ? { ...this.entitlement } : null;
  }
  async getAction(actionId: string): Promise<ActionRecord | null> {
    return this.records.get(actionId) ?? null;
  }
  async claimAction(): Promise<ClaimResult> {
    throw new Error("not reached in these tests");
  }
  async beginMutation(): Promise<boolean> {
    return true;
  }
  async finishAction(): Promise<ActionRecord | null> {
    return null;
  }
  async prepareReconciliation(): Promise<ActionRecord | null> {
    return null;
  }
  async deferUnknown(): Promise<ActionRecord | null> {
    return null;
  }
  async reconcileOriginalObservation(): Promise<ActionRecord | null> {
    return null;
  }
  async resolveUnknown(): Promise<ActionRecord | null> {
    return null;
  }
  async listRecoverableActions(): Promise<ActionRecord[]> {
    return [];
  }
}

function gateway(): GreenhouseGateway {
  return {
    async list() {
      return [];
    },
    async get() {
      return null;
    },
    async mutate() {
      throw new Error("no test here may reach a mutation");
    },
    async probe() {},
  } as unknown as GreenhouseGateway;
}

function service(session: AuthenticatedSession, store: ActionStore) {
  const derived = deriveActionSession({ session, signingSecret: SECRET });
  return new GreenhouseActionService({
    session: derived.session,
    store: withParentRevocation(store, derived.parentTokenId),
    greenhouse: gateway(),
    signingSecret: SECRET,
    visibility: { async probe() { return { state: "visible", redacted: false } as const; } },
    writesEnabled: true,
    production: false,
  });
}

describe("action session bridge", () => {
  it("derives a token id the action package's own pattern accepts", () => {
    const { session } = deriveActionSession({ session: recruiterSession(), signingSecret: SECRET });
    // The exact pattern from action-mcp/src/crypto.ts. Copied deliberately: if it is ever relaxed,
    // this test keeps asserting the STRICT form, so the relaxation cannot be justified by "the
    // bridge needs it" — which is the trade the spec forbids.
    assert.match(session.tokenId, /^action:[A-Za-z0-9_-]{8,120}$/);
    assert.equal(session.audience, "greenhouse_action_mcp");
    assert.equal(session.subject, "google-subject-sam", "the human stays bound across the bridge");
  });

  it("is deterministic, so an intent stays verifiable across restarts and instances", () => {
    const a = deriveActionSession({ session: recruiterSession(), signingSecret: SECRET }).session;
    const b = deriveActionSession({ session: recruiterSession(), signingSecret: SECRET }).session;
    assert.equal(a.tokenId, b.tokenId);
  });

  it("does not leak the parent token id, and changes completely under a different secret", () => {
    const { session } = deriveActionSession({ session: recruiterSession(), signingSecret: SECRET });
    assert.doesNotMatch(session.tokenId, /recruiter-token-abc123/);
    const other = deriveActionTokenId("recruiter-token-abc123", `${SECRET}-different`);
    assert.notEqual(session.tokenId, other);
    assert.ok(derivedTokenIdMatches("recruiter-token-abc123", SECRET, session.tokenId));
    assert.equal(derivedTokenIdMatches("someone-elses-token", SECRET, session.tokenId), false);
  });

  it("gives two different recruiter sessions two different action sessions", () => {
    const mine = deriveActionSession({ session: recruiterSession(), signingSecret: SECRET }).session;
    const theirs = deriveActionSession({
      session: recruiterSession({ tokenId: "recruiter-token-xyz789", subject: "google-subject-other" }),
      signingSecret: SECRET,
    }).session;
    assert.notEqual(mine.tokenId, theirs.tokenId);
    assert.notEqual(mine.subject, theirs.subject);
  });

  it("carries Claude Desktop across as itself rather than mis-attributing it", () => {
    const desktop = deriveActionSession({ session: recruiterSession(), signingSecret: SECRET }).session;
    assert.equal(desktop.client, "claude_desktop_chat");
    const codex = deriveActionSession({
      session: recruiterSession({ client: "chatgpt_codex_host" }),
      signingSecret: SECRET,
    }).session;
    assert.equal(codex.client, "codex");
  });

  it("refuses a session it could not revoke or attribute", () => {
    assert.throws(
      () => deriveActionSession({ session: recruiterSession({ tokenId: undefined }), signingSecret: SECRET }),
      (error: unknown) => error instanceof ActionSessionBridgeError && error.code === "NO_TOKEN_ID"
    );
    assert.throws(
      () => deriveActionSession({ session: recruiterSession({ client: undefined }), signingSecret: SECRET }),
      (error: unknown) => error instanceof ActionSessionBridgeError && error.code === "NO_CLIENT"
    );
  });

  it("issues a session the action package validates on its OWN terms", () => {
    // The real property, and the first version of this test missed it completely. The bridge used to
    // hand-build the ActionSession object, which type-checks and runs — and never invokes
    // TOKEN_ID_PATTERN at all. A derivation emitting `recruiter:<mac>` stayed green. It now goes
    // through issueActionSession (which throws on a bad id) and back through validateActionSession,
    // so the session handed over is one the action plane has already accepted.
    const derived = deriveActionSession({ session: recruiterSession(), signingSecret: SECRET });
    assert.equal(typeof derived.token, "string");
    const revalidated = validateActionSession(derived.token, SECRET, derived.session.issuedAtMs);
    assert.equal(revalidated.ok, true, "the signed derived session must survive the package's own validator");
    assert.equal(revalidated.ok && revalidated.session.tokenId, derived.session.tokenId);
    assert.equal(revalidated.ok && revalidated.session.subject, "google-subject-sam");
  });

  it("refuses to hand over a session whose derived id the action package would reject", () => {
    // Belt to the braces above: prove the issuer is what enforces the shape, by feeding it an id
    // that violates the namespace. This is the control the spec forbids weakening, so it has to be
    // reachable rather than notionally present.
    assert.throws(
      () => issueActionSession({ subject: "s", client: "claude_desktop_chat", tokenId: "recruiter:not-namespaced" }, SECRET),
      /action: namespace/i
    );
  });

  it("accepts the bridged session at the action service without a session-level denial", async () => {
    const store = new RevocationTrackingStore();
    const preview = await service(recruiterSession(), store).preview("candidate_note_create", {
      application_id: 100,
      body: "bridge test",
      visibility: "public",
    }).catch((error: unknown) => error);
    const message = preview instanceof Error ? preview.message : "";
    assert.doesNotMatch(message, /not entitled|SESSION_REVOKED|Action session token/i,
      `the bridged session was rejected by the action service: ${message}`);
  });

  it("DENIES when the parent recruiter session is revoked, not only the derived one", async () => {
    const store = new RevocationTrackingStore();
    const derived = deriveActionSession({ session: recruiterSession(), signingSecret: SECRET });
    // Revoke the RECRUITER token. The derived id is untouched and unknown to whoever revoked it.
    store.revoked.add("recruiter-token-abc123");

    const wrapped = withParentRevocation(store, derived.parentTokenId);
    assert.equal(
      await wrapped.isSessionRevoked(derived.session.tokenId),
      true,
      "revoking the recruiter session must kill write authority derived from it — otherwise an " +
        "already-approved intent keeps applying for the rest of its life"
    );
    assert.ok(
      store.asked.includes("recruiter-token-abc123"),
      "the parent lookup must actually happen; this is the second lookup we chose to pay for"
    );
  });

  it("skips the parent lookup once the derived id already answered revoked", async () => {
    const store = new RevocationTrackingStore();
    const derived = deriveActionSession({ session: recruiterSession(), signingSecret: SECRET });
    store.revoked.add(derived.session.tokenId);

    const wrapped = withParentRevocation(store, derived.parentTokenId);
    assert.equal(await wrapped.isSessionRevoked(derived.session.tokenId), true);
    assert.deepEqual(
      store.asked,
      [derived.session.tokenId],
      "a revoked derived id is already conclusive, so the second lookup is not paid for nothing"
    );
  });

  it("allows a live session, having consulted BOTH ids", async () => {
    const store = new RevocationTrackingStore();
    const derived = deriveActionSession({ session: recruiterSession(), signingSecret: SECRET });
    const wrapped = withParentRevocation(store, derived.parentTokenId);

    assert.equal(await wrapped.isSessionRevoked(derived.session.tokenId), false);
    assert.deepEqual(store.asked, [derived.session.tokenId, "recruiter-token-abc123"]);
  });
});
