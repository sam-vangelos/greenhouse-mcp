import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";
import {
  DEFAULT_SESSION_TTL_MS,
  issueActionIntent,
  issueActionSession,
  validateActionSession,
  verifyActionIntent,
} from "../src/crypto.js";
import type { PreparedAction } from "../src/types.js";
import { IDENTITY_ID, TEST_SECRET, testSession } from "./helpers.js";

describe("action signing domains", () => {
  test("issues 30-day Codex and Claude Code sessions with exact audience and expiry", () => {
    const now = 1_700_000_000_000;
    assert.equal(DEFAULT_SESSION_TTL_MS, 30 * 24 * 60 * 60 * 1000);
    for (const client of ["codex", "claude_code"] as const) {
      const issued = issueActionSession({ subject: `subject-${client}`, client, nowMs: now }, TEST_SECRET);
      assert.equal(issued.session.client, client);
      assert.equal(issued.session.kind, "greenhouse_action_session");
      assert.equal(issued.session.audience, "greenhouse_action_mcp");
      assert.equal(issued.session.expiresAtMs - issued.session.issuedAtMs, DEFAULT_SESSION_TTL_MS);
      const valid = validateActionSession(issued.token, TEST_SECRET, now + DEFAULT_SESSION_TTL_MS - 1);
      assert.equal(valid.ok, true);
      assert.equal(validateActionSession(issued.token, TEST_SECRET, now + DEFAULT_SESSION_TTL_MS).ok, false);
    }
    assert.throws(
      () => issueActionSession({ subject: "too-long", client: "codex", nowMs: now, ttlMs: DEFAULT_SESSION_TTL_MS + 1 }, TEST_SECRET),
      /30 days/
    );
  });

  test("accepts an unexpired legacy assignment session but rejects wrong-domain signatures", () => {
    const now = 1_700_000_100_000;
    const legacy = testSession({
      kind: "greenhouse_assignment_action_session",
      audience: "greenhouse_assignment_action_mcp",
      expiresAtMs: now + 60_000,
    });
    const body = Buffer.from(JSON.stringify(legacy)).toString("base64url");
    const sessionKey = createHmac("sha256", Buffer.from(TEST_SECRET)).update("greenhouse-action:session").digest();
    const signature = createHmac("sha256", sessionKey).update(body).digest("base64url");
    const valid = validateActionSession(`${body}.${signature}`, TEST_SECRET, now);
    assert.equal(valid.ok, true);
    if (valid.ok) assert.equal(valid.session.kind, "greenhouse_assignment_action_session");

    const wrong = issueActionSession({ subject: legacy.subject, client: legacy.client, nowMs: legacy.issuedAtMs },
      "different-action-signing-secret-at-least-32-bytes");
    assert.equal(validateActionSession(wrong.token, TEST_SECRET, now).ok, false);
  });

  test("signed intents bind action metadata and never contain note text or PII", () => {
    const sensitive = "SENSITIVE note for candidate@example.com salary $250000";
    const prepared: PreparedAction = {
      actionKind: "candidate_note_create",
      lockKey: "application:100",
      fenceTargets: [{ kind: "application", id: 100, requiresUnredacted: false }],
      scopeJobId: 200,
      binding: {
        application_id: 100,
        candidate_id: 300,
        note_type: "NOTE",
        visibility: "private",
        baseline_count: 1,
        baseline_fingerprint: "D".repeat(43),
      },
      currentFingerprint: "A".repeat(43),
      desiredFingerprint: "B".repeat(43),
      approvalFingerprint: "C".repeat(43),
      highImpact: false,
      reconciliationGraceMs: 5 * 60_000,
      changeRequired: true,
      approval: { after: { body: sensitive } },
      preview: { after: { body: sensitive } },
    };
    const issued = issueActionIntent({
      session: testSession(),
      identityId: IDENTITY_ID,
      actorUserId: 10,
      applyTool: "apply_candidate_note_create",
      prepared,
      nowMs: 1_700_000_100_000,
    }, TEST_SECRET);
    const valid = verifyActionIntent(issued.token, TEST_SECRET);
    assert.equal(valid.ok, true);
    if (!valid.ok) return;
    assert.equal(valid.intent.actionKind, "candidate_note_create");
    assert.equal(valid.intent.applyTool, "apply_candidate_note_create");
    assert.deepEqual(valid.intent.binding, prepared.binding);
    const decoded = Buffer.from(issued.token.split(".")[0]!, "base64url").toString("utf8");
    assert.doesNotMatch(decoded, /SENSITIVE|candidate@example\.com|250000/);

    const [tokenBody, signature] = issued.token.split(".");
    assert.ok(tokenBody && signature);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const alternate = alphabet[alphabet.indexOf(signature.at(-1)!) ^ 1]!;
    assert.equal(verifyActionIntent(`${tokenBody}.${signature.slice(0, -1)}${alternate}`, TEST_SECRET).ok, false);
  });

  test("signed intents support the documented 200 custom-field surface", () => {
    const fields = Array.from({ length: 200 }, (_, index) =>
      `custom:f${String(index).padStart(3, "0")}_${"x".repeat(245)}`
    );
    const prepared: PreparedAction = {
      actionKind: "offer_create",
      lockKey: "offer-chain:100",
      scopeJobId: 200,
      fenceTargets: [{ kind: "application", id: 100, requiresUnredacted: false }],
      binding: { application_id: 100, fields: ["starts_on", ...fields], baseline_ids: [], has_currency: false },
      currentFingerprint: "A".repeat(43),
      desiredFingerprint: "B".repeat(43),
      approvalFingerprint: "C".repeat(43),
      highImpact: false,
      reconciliationGraceMs: 10 * 60_000,
      changeRequired: true,
      approval: {},
      preview: {},
    };
    const issued = issueActionIntent({
      session: testSession(), identityId: IDENTITY_ID, actorUserId: 10,
      applyTool: "apply_offer_create", prepared, nowMs: 1_700_000_100_000,
    }, TEST_SECRET);
    assert.ok(issued.token.length > 65_536);
    assert.ok(issued.token.length < 131_072);
    assert.equal(verifyActionIntent(issued.token, TEST_SECRET).ok, true);
  });
});
