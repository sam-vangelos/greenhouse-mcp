import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSignedSessionToken } from "../src/auth.js";
import { runIdentityResolutionCheck, runIdentityResolutionCheckFromEnv } from "../src/identity-check.js";
import { createStaticIdentityDirectory } from "../src/identity.js";
import type { AuthenticatedSession } from "../src/types.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const UNSAFE_GREENHOUSE_USER_ID = Number.MAX_SAFE_INTEGER + 1;
const SESSION: AuthenticatedSession = {
  subject: "email:recruiter@example.com",
  email: "recruiter@example.com",
  surface: "chatgpt_desktop",
  tokenId: "session-1",
  issuedAt: "2026-06-23T00:00:00.000Z",
};

describe("identity resolution check", () => {
  it("resolves a durable session through the configured identity directory without Greenhouse credentials", async () => {
    const token = createSignedSessionToken(SESSION, SECRET);

    const report = await runIdentityResolutionCheckFromEnv({
      env: {
        GREENHOUSE_RECRUITER_SESSION_SECRET: SECRET,
        GREENHOUSE_RECRUITER_SESSION_TOKEN: token,
        GREENHOUSE_RECRUITER_IDENTITY_JSON: JSON.stringify([
          { email: "recruiter@example.com", status: "resolved", greenhouseUserId: 123 },
        ]),
      } as NodeJS.ProcessEnv,
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });

    assert.deepEqual(report, {
      ok: true,
      status: "resolved",
      checkedAt: "2026-06-23T00:00:00.000Z",
      surface: "chatgpt_desktop",
      subjectPresent: true,
      emailPresent: true,
      greenhouseUserId: 123,
    });
  });

  it("fails closed for missing or invalid durable sessions", async () => {
    const report = await runIdentityResolutionCheckFromEnv({
      env: { GREENHOUSE_RECRUITER_SESSION_SECRET: SECRET } as NodeJS.ProcessEnv,
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });

    assert.equal(report.ok, false);
    assert.equal(report.status, "invalid_session");
    assert.match(report.reason ?? "", /Missing recruiter MCP session token/);
  });

  it("reports unresolved and ambiguous mappings without falling back", async () => {
    const unresolved = await runIdentityResolutionCheck({
      session: SESSION,
      directory: createStaticIdentityDirectory([]),
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });
    const ambiguous = await runIdentityResolutionCheck({
      session: SESSION,
      directory: createStaticIdentityDirectory([
        { email: "recruiter@example.com", status: "resolved", greenhouseUserId: 123 },
        { subject: "email:recruiter@example.com", status: "resolved", greenhouseUserId: 456 },
      ]),
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });

    assert.equal(unresolved.ok, false);
    assert.equal(unresolved.status, "unresolved");
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.status, "ambiguous");
    assert.deepEqual(ambiguous.greenhouseUserIds, [123, 456]);
  });

  it("reports invalid identity mappings explicitly", async () => {
    const invalid = await runIdentityResolutionCheck({
      session: SESSION,
      directory: createStaticIdentityDirectory([
        { email: "recruiter@example.com", status: "resolved", greenhouseUserId: -1 },
      ]),
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });

    assert.equal(invalid.ok, false);
    assert.equal(invalid.status, "invalid_identity");
    assert.match(invalid.reason ?? "", /invalid Greenhouse user id/);
  });

  it("reports unsafe resolved Greenhouse user ids as invalid identity mappings", async () => {
    const invalid = await runIdentityResolutionCheck({
      session: SESSION,
      directory: {
        resolve: () => ({ status: "resolved", greenhouseUserId: UNSAFE_GREENHOUSE_USER_ID }),
      },
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });

    assert.equal(invalid.ok, false);
    assert.equal(invalid.status, "invalid_identity");
    assert.match(invalid.reason ?? "", /invalid Greenhouse user id/);
  });

  it("does not copy sensitive lookup exception text into identity evidence", async () => {
    const direct = await runIdentityResolutionCheck({
      session: SESSION,
      directory: {
        resolve() {
          throw new Error("Authorization: Bearer identity-token GREENHOUSE_CLIENT_SECRET=client-secret-value");
        },
      },
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });

    const token = createSignedSessionToken(SESSION, SECRET);
    const fromEnv = await runIdentityResolutionCheckFromEnv({
      env: {
        GREENHOUSE_RECRUITER_SESSION_SECRET: SECRET,
        GREENHOUSE_RECRUITER_SESSION_TOKEN: token,
        GREENHOUSE_RECRUITER_IDENTITY_JSON: "Authorization: Bearer identity-config-token GREENHOUSE_CLIENT_SECRET=client-secret-value",
      } as NodeJS.ProcessEnv,
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });

    for (const report of [direct, fromEnv]) {
      assert.equal(report.ok, false);
      assert.equal(report.status, "lookup_failed");
      assert.equal(report.reason, "Identity directory lookup failed before a resolved Greenhouse actor could be verified.");
      assert.doesNotMatch(JSON.stringify(report), /Authorization|Bearer|identity-token|identity-config-token|GREENHOUSE_CLIENT_SECRET|client-secret-value/);
    }
  });

  it("accepts a CLI token override without mutating the supplied environment", async () => {
    const token = createSignedSessionToken(SESSION, SECRET);
    const env = {
      GREENHOUSE_RECRUITER_SESSION_SECRET: SECRET,
      GREENHOUSE_RECRUITER_IDENTITY_JSON: JSON.stringify([
        { email: "recruiter@example.com", status: "resolved", greenhouseUserId: 123 },
      ]),
    } as NodeJS.ProcessEnv;

    const report = await runIdentityResolutionCheckFromEnv({ env, token });

    assert.equal(report.ok, true);
    assert.equal(report.greenhouseUserId, 123);
    assert.equal(env.GREENHOUSE_RECRUITER_SESSION_TOKEN, undefined);
  });
});
