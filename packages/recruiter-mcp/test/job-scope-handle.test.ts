import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createScopeSigner,
  createScopeSignerFromEnv,
  scopeHashOf,
  SCOPE_SIGNING_SECRET_ENV,
} from "../src/resolvers/job-scope/scope-handle.js";

const SECRET = "unit-test-secret-unit-test-secret-0123456789";
const NOW = Date.parse("2026-06-23T12:00:00.000Z");

describe("scope handle signer", () => {
  it("round-trips a scope handle for the issuing subject", () => {
    const signer = createScopeSigner(SECRET);
    const handle = signer.signScopeHandle({
      subject: "email:recruiter@example.com",
      jobIds: [9001004, 9001003],
      complete: true,
      label: "FDE",
      source: "cached_index",
      issuedAtMs: NOW,
    });
    const verified = signer.verifyScopeHandle(handle, { subject: "email:recruiter@example.com", nowMs: NOW + 1000 });
    assert.equal(verified.ok, true);
    if (!verified.ok) return;
    assert.deepStrictEqual(verified.payload.jobs, [9001003, 9001004], "ids normalized + sorted");
    assert.equal(verified.payload.complete, true);
    assert.equal(verified.payload.hash, scopeHashOf([9001003, 9001004]));
  });

  it("rejects an expired handle", () => {
    const signer = createScopeSigner(SECRET);
    const handle = signer.signScopeHandle({
      subject: "s", jobIds: [1], complete: true, label: "x", source: "exact_ids", issuedAtMs: NOW, ttlMs: 1000,
    });
    const verified = signer.verifyScopeHandle(handle, { subject: "s", nowMs: NOW + 2000 });
    assert.equal(verified.ok, false);
    if (!verified.ok) assert.equal(verified.reason, "expired");
  });

  it("rejects a handle redeemed by a different subject", () => {
    const signer = createScopeSigner(SECRET);
    const handle = signer.signScopeHandle({
      subject: "owner", jobIds: [1], complete: true, label: "x", source: "exact_ids", issuedAtMs: NOW,
    });
    const verified = signer.verifyScopeHandle(handle, { subject: "attacker", nowMs: NOW + 1000 });
    assert.equal(verified.ok, false);
    if (!verified.ok) assert.equal(verified.reason, "forbidden");
  });

  it("rejects a tampered handle body", () => {
    const signer = createScopeSigner(SECRET);
    const handle = signer.signScopeHandle({
      subject: "s", jobIds: [1], complete: true, label: "x", source: "exact_ids", issuedAtMs: NOW,
    });
    const [body, sig] = handle.split(".");
    // Flip a character in the payload body without re-signing.
    const tamperedBody = body.slice(0, -1) + (body.endsWith("A") ? "B" : "A");
    const verified = signer.verifyScopeHandle(`${tamperedBody}.${sig}`, { subject: "s", nowMs: NOW + 1000 });
    assert.equal(verified.ok, false);
    if (!verified.ok) assert.equal(verified.reason, "invalid");
  });

  it("rejects a handle signed with a different key", () => {
    const a = createScopeSigner(SECRET);
    const b = createScopeSigner("a-totally-different-secret-key-0123456789xx");
    const handle = a.signScopeHandle({ subject: "s", jobIds: [1], complete: true, label: "x", source: "exact_ids", issuedAtMs: NOW });
    const verified = b.verifyScopeHandle(handle, { subject: "s", nowMs: NOW + 1000 });
    assert.equal(verified.ok, false);
    if (!verified.ok) assert.equal(verified.reason, "invalid");
  });

  it("does not verify a confirmation token as a scope handle (kind binding)", () => {
    const signer = createScopeSigner(SECRET);
    const token = signer.signConfirmationToken({
      subject: "s", resolutionId: "r1", jobIds: [1, 2], label: "x", complete: true, requiresAck: [], source: "cached_index", issuedAtMs: NOW,
    });
    const asHandle = signer.verifyScopeHandle(token, { subject: "s", nowMs: NOW + 1000 });
    assert.equal(asHandle.ok, false);
    const asToken = signer.verifyConfirmationToken(token, { subject: "s", nowMs: NOW + 1000 });
    assert.equal(asToken.ok, true);
  });

  it("requires a sufficiently long signing secret", () => {
    assert.throws(() => createScopeSigner("too-short"), /at least 32/);
  });

  it("uses the env secret when valid and falls back to an ephemeral key otherwise", () => {
    const configured = createScopeSignerFromEnv({ [SCOPE_SIGNING_SECRET_ENV]: SECRET } as NodeJS.ProcessEnv);
    assert.equal(configured.ephemeral, false);
    const ephemeral = createScopeSignerFromEnv({} as NodeJS.ProcessEnv);
    assert.equal(ephemeral.ephemeral, true);
    // An ephemeral signer still produces verifiable handles within the process.
    const handle = ephemeral.signer.signScopeHandle({ subject: "s", jobIds: [1], complete: true, label: "x", source: "exact_ids", issuedAtMs: NOW });
    assert.equal(ephemeral.signer.verifyScopeHandle(handle, { subject: "s", nowMs: NOW + 1000 }).ok, true);
  });

  it("throws when the env secret is set but too short", () => {
    assert.throws(
      () => createScopeSignerFromEnv({ [SCOPE_SIGNING_SECRET_ENV]: "short" } as NodeJS.ProcessEnv),
      /at least 32 characters/
    );
  });

  it("produces a stable scope hash independent of id order", () => {
    assert.equal(scopeHashOf([3, 1, 2]), scopeHashOf([1, 2, 3]));
    assert.notEqual(scopeHashOf([1, 2]), scopeHashOf([1, 2, 3]));
  });
});
