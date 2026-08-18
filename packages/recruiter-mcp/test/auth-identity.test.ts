import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { actionClientForRecruiterSession, createHmacSessionValidator, createSessionRevocationProviderFromEnv, createSessionValidatorFromEnv, createSignedSessionToken, createSupabaseSessionRevocationProvider, isClientSurfaceCompatible } from "../src/auth.js";
import {
  createEmailSessionIssuerConfigFromEnv,
  issueDirectoryVerifiedEmailSessionBatch,
  issueDirectoryVerifiedEmailSessionToken,
  issueVerifiedEmailSessionToken,
  normalizeWorkEmail,
  parseEmailList,
  preflightDirectoryVerifiedEmailRoster,
  writeIssuedEmailSessionBatchFiles,
} from "../src/email-session.js";
import {
  createIdentityActorResolver,
  createIdentityDirectoryFromEnv,
  createStaticIdentityDirectory,
  createSupabaseIdentityDirectory,
  IdentityResolutionError,
} from "../src/identity.js";
import type { AuthenticatedSession, RecruiterClient } from "../src/types.js";

const STRONG_SESSION_SECRET = "recruiter-session-secret-32-characters-minimum";
const UNSAFE_GREENHOUSE_USER_ID = Number.MAX_SAFE_INTEGER + 1;

const baseSession: AuthenticatedSession = {
  subject: "google-oauth2|abc",
  email: "recruiter@example.com",
  surface: "claude_desktop",
  client: "claude_desktop_chat",
  tokenId: "base-session-token-id",
  issuedAt: "2026-06-23T00:00:00.000Z",
};

describe("signed recruiter session tokens", () => {
  it("binds new tokens to a compatible physical client while accepting legacy tokens without one", async () => {
    const validator = createHmacSessionValidator("secret");
    const current = await validator.validate(createSignedSessionToken(baseSession, "secret"));
    const legacy = await validator.validate(createSignedSessionToken({ ...baseSession, client: undefined }, "secret"));
    const mismatched = await validator.validate(createRawSignedSessionPayload({ ...baseSession, client: "chatgpt_codex_host" }, "secret"));
    const unknown = await validator.validate(createRawSignedSessionPayload({ ...baseSession, client: "unknown_client" }, "secret"));

    assert.equal(current.status === "valid" && current.session.client, "claude_desktop_chat");
    assert.equal(legacy.status, "valid");
    assert.equal(legacy.status === "valid" && legacy.session.client, undefined);
    assert.equal(mismatched.status, "invalid");
    assert.match(mismatched.status === "invalid" ? mismatched.reason : "", /client identity/);
    assert.equal(unknown.status, "invalid");
  });

  it("validates a signed token that carries identity but no Greenhouse permission claims", async () => {
    const token = createSignedSessionToken(baseSession, "secret");
    const validator = createHmacSessionValidator("secret");

    const result = await validator.validate(token);

    assert.equal(result.status, "valid");
    assert.equal(result.status === "valid" && result.session.email, "recruiter@example.com");
  });

  it("rejects signed session tokens with wrong-secret, mutated, malformed, or reordered signatures", async () => {
    const token = createSignedSessionToken(baseSession, "secret");
    const [payloadPart, signaturePart] = token.split(".");
    assert.ok(payloadPart);
    assert.ok(signaturePart);
    const validator = createHmacSessionValidator("secret");
    const wrongSecret = createSignedSessionToken(baseSession, "other-secret");
    const flippedSignature = `${payloadPart}.${signaturePart.slice(0, -1)}${signaturePart.endsWith("A") ? "B" : "A"}`;
    const reorderedPayloadPart = Buffer.from(JSON.stringify({
      surface: baseSession.surface,
      issuedAt: baseSession.issuedAt,
      tokenId: baseSession.tokenId,
      email: baseSession.email,
      subject: baseSession.subject,
    }), "utf8").toString("base64url");
    const reorderedWithOriginalSignature = `${reorderedPayloadPart}.${signaturePart}`;

    for (const candidate of [
      wrongSecret,
      flippedSignature,
      payloadPart,
      `${payloadPart}.${signaturePart}.extra`,
      `.${signaturePart}`,
      `${payloadPart}.`,
      reorderedWithOriginalSignature,
    ]) {
      const result = await validator.validate(candidate);

      assert.equal(result.status, "invalid");
    }
  });

  it("rejects tokens that try to carry Greenhouse user or permission claims", async () => {
    const token = createRawSignedSessionPayload({ ...baseSession, greenhouseUserId: 123 }, "secret");
    const validator = createHmacSessionValidator("secret");

    const result = await validator.validate(token);

    assert.equal(result.status, "invalid");
    assert.match(result.status === "invalid" ? result.reason : "", /forbidden scoped claim/);
  });

  it("rejects forbidden scoped token claims across casing and separator variants", async () => {
    const validator = createHmacSessionValidator("secret");
    for (const claim of [
      { GreenhouseUserID: 123 },
      { "greenhouse-user-id": 123 },
      { "permitted-job-ids": [1, 2] },
      { JOB_IDS: "1,2" },
      { "expires-at": "2026-06-23T13:00:00.000Z" },
    ]) {
      const token = createRawSignedSessionPayload({ ...baseSession, ...claim }, "secret");

      const result = await validator.validate(token);

      assert.equal(result.status, "invalid");
      assert.match(result.status === "invalid" ? result.reason : "", /forbidden scoped claim/);
    }
  });

  it("rejects tokens that try to impose routine expiry", async () => {
    const token = createRawSignedSessionPayload({ ...baseSession, expiresAt: "2026-06-23T13:00:00.000Z" }, "secret");
    const validator = createHmacSessionValidator("secret");

    const result = await validator.validate(token);

    assert.equal(result.status, "invalid");
    assert.match(result.status === "invalid" ? result.reason : "", /forbidden scoped claim: expiresAt/);
  });

  it("rejects durable session tokens without revocation metadata", async () => {
    const validator = createHmacSessionValidator("secret");

    const missingTokenId = await validator.validate(createRawSignedSessionPayload({ ...baseSession, tokenId: undefined }, "secret"));
    const missingIssuedAt = await validator.validate(createRawSignedSessionPayload({ ...baseSession, issuedAt: undefined }, "secret"));
    const invalidIssuedAt = await validator.validate(createRawSignedSessionPayload({ ...baseSession, issuedAt: "not-a-date" }, "secret"));
    const nonCanonicalIssuedAt = await validator.validate(createRawSignedSessionPayload({ ...baseSession, issuedAt: "2026-06-23T00:00:00Z" }, "secret"));

    assert.equal(missingTokenId.status, "invalid");
    assert.match(missingTokenId.status === "invalid" ? missingTokenId.reason : "", /token id/);
    assert.equal(missingIssuedAt.status, "invalid");
    assert.match(missingIssuedAt.status === "invalid" ? missingIssuedAt.reason : "", /issued-at/);
    assert.equal(invalidIssuedAt.status, "invalid");
    assert.match(invalidIssuedAt.status === "invalid" ? invalidIssuedAt.reason : "", /invalid issued-at/);
    assert.equal(nonCanonicalIssuedAt.status, "invalid");
    assert.match(nonCanonicalIssuedAt.status === "invalid" ? nonCanonicalIssuedAt.reason : "", /invalid issued-at/);
  });

  it("rejects signed sessions with non-exact identity or revocation metadata", async () => {
    const validator = createHmacSessionValidator("secret");
    const cases: Array<{ session: AuthenticatedSession; reason: RegExp }> = [
      { session: { ...baseSession, subject: ` ${baseSession.subject}` }, reason: /subject/ },
      { session: { ...baseSession, email: `${baseSession.email} ` }, reason: /email/ },
      { session: { ...baseSession, tokenId: ` ${baseSession.tokenId}` }, reason: /token id/ },
      { session: { ...baseSession, issuedAt: `${baseSession.issuedAt} ` }, reason: /issued-at/ },
    ];

    for (const testCase of cases) {
      const result = await validator.validate(createRawSignedSessionPayload(testCase.session, "secret"));

      assert.equal(result.status, "invalid");
      assert.match(result.status === "invalid" ? result.reason : "", testCase.reason);
    }
  });

  it("refuses a token whose email subject and email claim resolve to different actors", async () => {
    // `subject` and `email` were validated independently, and the two planes read them differently:
    // the read resolver queries the email claim and the literal subject (identity.ts:248-273), while
    // the action store ignores the email claim entirely and reads an `email:` subject as
    // primary_email (action-mcp/src/store.ts:83-95,226-237). A signed
    // {subject:"email:a@x", email:"b@x"} would therefore show B's catalog while authorizing A's
    // writes. The standard issuer keeps the two equal (email-session.ts:134-140); nothing made that
    // a contract until now.
    const emailSession: AuthenticatedSession = { ...baseSession, subject: "email:recruiter@example.com" };
    const validator = createHmacSessionValidator("secret");

    const matched = await validator.validate(createSignedSessionToken(emailSession, "secret"));
    assert.equal(matched.status, "valid");

    const divergent = await validator.validate(
      createRawSignedSessionPayload({ ...emailSession, email: "someone.else@example.com" }, "secret")
    );
    assert.equal(divergent.status, "invalid");
    assert.match(divergent.status === "invalid" ? divergent.reason : "", /email subject/);

    const noClaim = await validator.validate(
      createRawSignedSessionPayload({ ...emailSession, email: undefined }, "secret")
    );
    assert.equal(noClaim.status, "invalid");
    assert.match(noClaim.status === "invalid" ? noClaim.reason : "", /email subject/);

    // Casing is not divergence — both planes lower-case before the lookup, so these name one actor.
    const casing = await validator.validate(
      createRawSignedSessionPayload({ ...emailSession, email: "Recruiter@Example.com" }, "secret")
    );
    assert.equal(casing.status, "valid");

    // A non-email subject is unaffected: it carries no email to disagree with.
    const opaqueSubject = await validator.validate(
      createRawSignedSessionPayload({ ...baseSession, email: "someone.else@example.com" }, "secret")
    );
    assert.equal(opaqueSubject.status, "valid");

    // Same invariant on the issuing side, so a token nothing will accept is never minted either.
    assert.throws(
      () => createSignedSessionToken({ ...emailSession, email: "someone.else@example.com" }, "secret"),
      /email subject/
    );
    assert.throws(
      () => createSignedSessionToken({ ...emailSession, email: undefined }, "secret"),
      /email subject/
    );
  });

  it("refuses an email subject that is not the address the action plane will look it up by", async () => {
    // The binding compared case-insensitively on BOTH sides, so `email:A@X` + `A@X` passed here and
    // then failed every action with "Action email identity subject is invalid": identityLookup reads
    // the subject back as primary_email and demands it already be a trimmed, lower-case address
    // (action-mcp/src/store.ts:226-237). A session nothing downstream can use is not a valid session.
    const validator = createHmacSessionValidator("secret");
    const nonCanonicalSubjects = [
      "email:Recruiter@Example.com",
      "email:",
      "email:not-an-email",
      `email:${"a".repeat(250)}@example.com`,
    ];

    for (const subject of nonCanonicalSubjects) {
      const session: AuthenticatedSession = {
        ...baseSession,
        subject,
        // The claim is the subject's own email, so what is refused is the SUBJECT's form — not a
        // mismatch between the two.
        email: subject.slice("email:".length) || "recruiter@example.com",
      };

      const result = await validator.validate(createRawSignedSessionPayload(session, "secret"));
      assert.equal(result.status, "invalid", `${subject} was accepted`);
      assert.match(result.status === "invalid" ? result.reason : "", /email subject/);

      // Refused at the mint too, so no such token is ever handed to a recruiter.
      assert.throws(() => createSignedSessionToken(session, "secret"), /email subject/, subject);
    }

    // Not over-narrowed: the canonical subject the issuer produces is still accepted, and the email
    // claim's case still does not matter, because the read plane lower-cases it before the lookup.
    const canonical = await validator.validate(
      createRawSignedSessionPayload(
        { ...baseSession, subject: "email:recruiter@example.com", email: "Recruiter@Example.com" },
        "secret"
      )
    );
    assert.equal(canonical.status, "valid");
    // And an opaque (non-`email:`) subject is not held to an email's shape at all.
    const opaque = await validator.validate(createSignedSessionToken(baseSession, "secret"));
    assert.equal(opaque.status, "valid");
  });

  it("rejects session token ids that cannot be safely revoked or matched to evidence", async () => {
    const validator = createHmacSessionValidator("secret");
    const cases: Array<{ tokenId: string; reason: RegExp }> = [
      { tokenId: "payload.signature", reason: /signed token string/ },
      { tokenId: "token id with spaces", reason: /may contain only/ },
      { tokenId: "permittedJobIds", reason: /scoped identity, permission, or expiry/ },
      { tokenId: "x".repeat(161), reason: /up to 160/ },
    ];

    for (const testCase of cases) {
      const result = await validator.validate(createRawSignedSessionPayload({ ...baseSession, tokenId: testCase.tokenId }, "secret"));

      assert.equal(result.status, "invalid");
      assert.match(result.status === "invalid" ? result.reason : "", testCase.reason);
    }

    assert.throws(
      () => issueVerifiedEmailSessionToken(
        {
          secret: "secret",
          allowedDomains: ["company.com"],
          tokenId: () => "token id with spaces",
        },
        { email: "recruiter@company.com", surface: "claude_desktop" }
      ),
      /may contain only/
    );
  });

  it("refuses to mint malformed durable session tokens", () => {
    assert.throws(
      () => createSignedSessionToken({ ...baseSession, tokenId: " token-id" }, "secret"),
      /token id/
    );
    assert.throws(
      () => createSignedSessionToken({ ...baseSession, issuedAt: "2026-06-23T00:00:00Z" }, "secret"),
      /issued-at/
    );
    assert.throws(
      () => createSignedSessionToken({ ...baseSession, greenhouseUserId: 123 } as AuthenticatedSession & { greenhouseUserId: number }, "secret"),
      /forbidden scoped claim/
    );
  });

  it("issues durable email-bound sessions after one-time work email onboarding", async () => {
    const issued = issueVerifiedEmailSessionToken(
      {
        secret: "secret",
        allowedDomains: ["company.com"],
        now: () => Date.parse("2026-06-23T12:00:00.000Z"),
        tokenId: () => "session-1",
      },
      { email: " Recruiter@Company.com ", surface: "claude_desktop" }
    );
    const validator = createHmacSessionValidator("secret");

    const result = await validator.validate(issued.token);

    assert.equal(issued.email, "recruiter@company.com");
    assert.equal(issued.session.subject, "email:recruiter@company.com");
    assert.equal(issued.session.client, "claude_desktop_chat");
    assert.equal("expiresAt" in issued.session, false);
    assert.equal(result.status, "valid");
    assert.equal(result.status === "valid" && result.session.tokenId, "session-1");
  });

  it("does not mint distributable durable sessions for the internal test surface", () => {
    assert.throws(
      () => issueVerifiedEmailSessionToken(
        {
          secret: "secret",
          allowedDomains: ["company.com"],
          now: () => Date.parse("2026-06-23T12:00:00.000Z"),
          tokenId: () => "session-test-surface",
        },
        { email: "recruiter@company.com", surface: "test" as never }
      ),
      /supports only claude_desktop and chatgpt_desktop/
    );
  });

  it("issues durable sessions only for emails mapped to exactly one Greenhouse user", async () => {
    const issued = await issueDirectoryVerifiedEmailSessionToken(
      {
        secret: "secret",
        allowedDomains: ["company.com"],
        now: () => Date.parse("2026-06-23T12:00:00.000Z"),
        tokenId: () => "session-identity-1",
      },
      { email: "Recruiter@Company.com", surface: "chatgpt_desktop" },
      createStaticIdentityDirectory([
        { email: "recruiter@company.com", status: "resolved", greenhouseUserId: 789 },
      ])
    );
    const validator = createHmacSessionValidator("secret");

    const result = await validator.validate(issued.token);

    assert.equal(result.status, "valid");
    assert.equal("expiresAt" in issued.session, false);
    assert.equal((issued.session as AuthenticatedSession & { greenhouseUserId?: number }).greenhouseUserId, undefined);
    assert.equal(result.status === "valid" && result.session.subject, "email:recruiter@company.com");
  });

  it("issues batch durable sessions for both desktop surfaces from a verified email list", async () => {
    let tokenCounter = 0;
    const batch = await issueDirectoryVerifiedEmailSessionBatch(
      {
        secret: "secret",
        allowedDomains: ["company.com"],
        now: () => Date.parse("2026-06-23T12:00:00.000Z"),
        tokenId: () => `session-${++tokenCounter}`,
      },
      {
        emails: [" Recruiter.One@Company.com ", "recruiter.two@company.com"],
        surfaces: ["claude_desktop", "chatgpt_desktop"],
      },
      createStaticIdentityDirectory([
        { email: "recruiter.one@company.com", status: "resolved", greenhouseUserId: 789 },
        { email: "recruiter.two@company.com", status: "resolved", greenhouseUserId: 790 },
      ])
    );
    const validator = createHmacSessionValidator("secret");

    assert.equal(batch.ok, true);
    assert.equal(batch.requestedEmailCount, 2);
    assert.deepEqual(batch.requestedSurfaces, ["claude_desktop", "chatgpt_desktop"]);
    assert.equal(batch.denied.length, 0);
    assert.deepEqual(
      batch.issued.map((entry) => `${entry.email}:${entry.session.surface}:${entry.session.tokenId}`),
      [
        "recruiter.one@company.com:claude_desktop:session-1",
        "recruiter.one@company.com:chatgpt_desktop:session-2",
        "recruiter.two@company.com:claude_desktop:session-3",
        "recruiter.two@company.com:chatgpt_desktop:session-4",
      ]
    );

    for (const issued of batch.issued) {
      const result = await validator.validate(issued.token);
      assert.equal(result.status, "valid");
      assert.equal("expiresAt" in issued.session, false);
      assert.equal((issued.session as AuthenticatedSession & { greenhouseUserId?: number }).greenhouseUserId, undefined);
      assert.equal((issued.session as AuthenticatedSession & { permittedJobIds?: number[] }).permittedJobIds, undefined);
    }
  });

  it("issues separate Claude Desktop and Claude Code credentials with distinct client claims", async () => {
    let tokenCounter = 0;
    const batch = await issueDirectoryVerifiedEmailSessionBatch(
      { secret: "secret", allowedDomains: ["company.com"], tokenId: () => `client-${++tokenCounter}` },
      { emails: ["recruiter@company.com"], surfaces: ["claude_desktop"], clients: ["claude_desktop_chat", "claude_code"] },
      createStaticIdentityDirectory([{ email: "recruiter@company.com", status: "resolved", greenhouseUserId: 789 }])
    );

    assert.deepEqual(batch.issued.map((entry) => entry.session.client), ["claude_desktop_chat", "claude_code"]);
    assert.equal(new Set(batch.issued.map((entry) => entry.session.tokenId)).size, 2);
    assert.ok(batch.issued.every((entry) => entry.session.surface === "claude_desktop"));
  });

  it("writes split durable session files and a token-free issuance manifest", async () => {
    let tokenCounter = 0;
    const batch = await issueDirectoryVerifiedEmailSessionBatch(
      {
        secret: "secret",
        allowedDomains: ["company.com"],
        now: () => Date.parse("2026-06-23T12:00:00.000Z"),
        tokenId: () => `session-${++tokenCounter}`,
      },
      {
        emails: ["recruiter.one@company.com"],
        surfaces: ["claude_desktop", "chatgpt_desktop"],
      },
      createStaticIdentityDirectory([
        { email: "recruiter.one@company.com", status: "resolved", greenhouseUserId: 789 },
      ])
    );
    const outputDir = await mkdtemp(join(tmpdir(), "greenhouse-issued-sessions-"));

    const manifest = await writeIssuedEmailSessionBatchFiles(batch, outputDir);
    const manifestPath = join(outputDir, manifest.manifestPath);
    const manifestOnDisk = JSON.parse(await readFile(manifestPath, "utf8")) as typeof manifest;
    const manifestJson = JSON.stringify(manifestOnDisk);

    assert.equal(manifest.fileCount, 2);
    assert.equal(manifest.outputDir, ".");
    assert.equal(manifest.manifestPath, "manifest.json");
    assert.equal(manifest.containsTokens, false);
    assert.equal(manifest.sessionFilesContainTokens, true);
    assert.deepEqual(manifest.files.map((entry) => entry.issuedAt), [
      "2026-06-23T12:00:00.000Z",
      "2026-06-23T12:00:00.000Z",
    ]);
    for (const issued of batch.issued) {
      assert.equal(manifestJson.includes(issued.token), false);
    }
    const claudeFile = manifest.files.find((entry) => entry.surface === "claude_desktop");
    const chatgptFile = manifest.files.find((entry) => entry.surface === "chatgpt_desktop");
    assert.ok(claudeFile);
    assert.ok(chatgptFile);
    assert.equal(claudeFile.path.startsWith("/"), false);
    assert.equal(chatgptFile.path.startsWith("/"), false);
    const claudePath = join(outputDir, claudeFile.path);
    const chatgptPath = join(outputDir, chatgptFile.path);
    const claudeText = await readFile(claudePath, "utf8");
    const chatgptText = await readFile(chatgptPath, "utf8");
    assert.match(claudeText, /"surface": "claude_desktop"/);
    assert.match(claudeText, /"issuedAt": "2026-06-23T12:00:00.000Z"/);
    assert.equal(claudeText.includes(batch.issued.find((entry) => entry.session.surface === "claude_desktop")!.token), true);
    assert.equal(chatgptText.includes(batch.issued.find((entry) => entry.session.surface === "chatgpt_desktop")!.token), true);
    assert.equal(await modeOf(outputDir), 0o700);
    assert.equal(await modeOf(manifestPath), 0o600);
    assert.equal(await modeOf(claudePath), 0o600);
    assert.equal(await modeOf(chatgptPath), 0o600);
  });

  it("refuses to overwrite existing split durable session files", async () => {
    let tokenCounter = 0;
    const batch = await issueDirectoryVerifiedEmailSessionBatch(
      {
        secret: "secret",
        allowedDomains: ["company.com"],
        now: () => Date.parse("2026-06-23T12:00:00.000Z"),
        tokenId: () => `session-${++tokenCounter}`,
      },
      { emails: ["recruiter.one@company.com"], surfaces: ["claude_desktop"] },
      createStaticIdentityDirectory([
        { email: "recruiter.one@company.com", status: "resolved", greenhouseUserId: 789 },
      ])
    );
    const outputDir = await mkdtemp(join(tmpdir(), "greenhouse-issued-sessions-"));
    const manifest = await writeIssuedEmailSessionBatchFiles(batch, outputDir);
    const sessionPath = join(outputDir, manifest.files[0]!.path);
    const originalSessionFile = await readFile(sessionPath, "utf8");

    await assert.rejects(
      () => writeIssuedEmailSessionBatchFiles(batch, outputDir),
      /Refusing to overwrite existing sensitive recruiter artifact/
    );

    assert.equal(await readFile(sessionPath, "utf8"), originalSessionFile);
  });

  it("refuses to write split durable session files for a partial batch", async () => {
    const batch = await issueDirectoryVerifiedEmailSessionBatch(
      { secret: "secret", allowedDomains: ["company.com"] },
      { emails: ["valid@company.com", "missing@company.com"], surfaces: ["claude_desktop"] },
      createStaticIdentityDirectory([{ email: "valid@company.com", status: "resolved", greenhouseUserId: 789 }])
    );
    const outputDir = await mkdtemp(join(tmpdir(), "greenhouse-issued-sessions-"));

    await assert.rejects(
      () => writeIssuedEmailSessionBatchFiles(batch, outputDir),
      /denied rows/
    );
  });

  it("fails a batch report closed for invalid, duplicate, unmapped, and ambiguous emails", async () => {
    const batch = await issueDirectoryVerifiedEmailSessionBatch(
      {
        secret: "secret",
        allowedDomains: ["company.com"],
        tokenId: () => "stable-token-id",
      },
      {
        emails: [
          "valid@company.com",
          "valid@company.com",
          "person@gmail.com",
          "missing@company.com",
          "ambiguous@company.com",
        ],
        surfaces: ["claude_desktop", "claude_desktop"],
      },
      createStaticIdentityDirectory([
        { email: "valid@company.com", status: "resolved", greenhouseUserId: 789 },
        { email: "ambiguous@company.com", status: "resolved", greenhouseUserIds: [789, 790] },
      ])
    );

    assert.equal(batch.ok, false);
    assert.deepEqual(batch.requestedSurfaces, ["claude_desktop"]);
    assert.equal(batch.issued.length, 1);
    assert.deepEqual(batch.denied.map((entry) => entry.email), [
      "valid@company.com",
      "person@gmail.com",
      "missing@company.com",
      "ambiguous@company.com",
    ]);
    assert.match(batch.denied[0]?.reason ?? "", /Duplicate/);
    assert.match(batch.denied[1]?.reason ?? "", /domain/);
    assert.match(batch.denied[2]?.reason ?? "", /not mapped/);
    assert.match(batch.denied[3]?.reason ?? "", /not uniquely mapped/);
  });

  it("preflights a full recruiter roster without requiring a signing secret or minting tokens", async () => {
    const report = await preflightDirectoryVerifiedEmailRoster(
      {
        allowedDomains: ["company.com"],
        rosterSource: "okta_group",
        verifiedBy: "ops-reviewer@example.com",
        now: () => Date.parse("2026-06-23T12:00:00.000Z"),
      },
      {
        emails: [
          " Recruiter.One@Company.com ",
          "recruiter.one@company.com",
          "person@gmail.com",
          "missing@company.com",
          "ambiguous@company.com",
        ],
        surfaces: ["claude_desktop", "chatgpt_desktop"],
      },
      createStaticIdentityDirectory([
        { email: "recruiter.one@company.com", status: "resolved", greenhouseUserId: 789 },
        { email: "ambiguous@company.com", status: "resolved", greenhouseUserIds: [789, 790] },
      ])
    );
    const serialized = JSON.stringify(report);

    assert.equal(report.ok, false);
    assert.equal(report.generatedAt, "2026-06-23T12:00:00.000Z");
    assert.equal(report.rosterSource, "okta_group");
    assert.equal(report.verifiedBy, "ops-reviewer@example.com");
    assert.equal(report.containsTokens, false);
    assert.equal(report.canIssueSessions, false);
    assert.equal(report.requestedEmailCount, 5);
    assert.equal(report.normalizedEmailCount, 3);
    assert.deepEqual(report.requestedSurfaces, ["claude_desktop", "chatgpt_desktop"]);
    assert.deepEqual(report.resolved, [
      {
        email: "recruiter.one@company.com",
        subject: "email:recruiter.one@company.com",
        greenhouseUserId: 789,
        surfaces: ["claude_desktop", "chatgpt_desktop"],
      },
    ]);
    assert.deepEqual(report.denied.map((entry) => entry.email), [
      "recruiter.one@company.com",
      "person@gmail.com",
      "missing@company.com",
      "ambiguous@company.com",
    ]);
    assert.doesNotMatch(serialized, /token|session-secret|expiresAt|permittedJobIds/);
  });

  it("preflights a clean roster as issuable while remaining token-free", async () => {
    const report = await preflightDirectoryVerifiedEmailRoster(
      {
        allowedDomains: ["company.com"],
        rosterSource: "google_workspace_group",
        verifiedBy: "ops-reviewer@example.com",
        now: () => Date.parse("2026-06-23T12:00:00.000Z"),
      },
      {
        emails: ["recruiter.one@company.com", "recruiter.two@company.com"],
        surfaces: ["chatgpt_desktop"],
      },
      createStaticIdentityDirectory([
        { email: "recruiter.one@company.com", status: "resolved", greenhouseUserId: 789 },
        { email: "recruiter.two@company.com", status: "resolved", greenhouseUserId: 790 },
      ])
    );

    assert.equal(report.ok, true);
    assert.equal(report.generatedAt, "2026-06-23T12:00:00.000Z");
    assert.equal(report.rosterSource, "google_workspace_group");
    assert.equal(report.verifiedBy, "ops-reviewer@example.com");
    assert.equal(report.canIssueSessions, true);
    assert.equal(report.containsTokens, false);
    assert.deepEqual(report.resolved.map((entry) => entry.greenhouseUserId), [789, 790]);
    assert.equal(report.denied.length, 0);
  });

  it("requires managed roster provenance before preflight evidence can authorize session issuance", async () => {
    await assert.rejects(
      () => preflightDirectoryVerifiedEmailRoster(
        { allowedDomains: ["company.com"], rosterSource: "self_reported_email", verifiedBy: "ops-reviewer@example.com" },
        { emails: ["recruiter@company.com"], surfaces: ["claude_desktop"] },
        createStaticIdentityDirectory([{ email: "recruiter@company.com", status: "resolved", greenhouseUserId: 789 }])
      ),
      /Roster preflight source must be one of/
    );

    await assert.rejects(
      () => preflightDirectoryVerifiedEmailRoster(
        { allowedDomains: ["company.com"], rosterSource: "admin_managed_roster" },
        { emails: ["recruiter@company.com"], surfaces: ["claude_desktop"] },
        createStaticIdentityDirectory([{ email: "recruiter@company.com", status: "resolved", greenhouseUserId: 789 }])
      ),
      /verified-by is required/
    );
  });

  it("does not issue a durable session for an email missing from the identity directory", async () => {
    await assert.rejects(
      async () => {
        await issueDirectoryVerifiedEmailSessionToken(
          { secret: "secret", allowedDomains: ["company.com"] },
          { email: "missing@company.com", surface: "claude_desktop" },
          createStaticIdentityDirectory([])
        );
      },
      /not mapped/
    );
  });

  it("does not issue a durable session for an ambiguously mapped email", async () => {
    await assert.rejects(
      async () => {
        await issueDirectoryVerifiedEmailSessionToken(
          { secret: "secret", allowedDomains: ["company.com"] },
          { email: "recruiter@company.com", surface: "claude_desktop" },
          createStaticIdentityDirectory([
            { email: "recruiter@company.com", status: "resolved", greenhouseUserIds: [789, 790] },
          ])
        );
      },
      /not uniquely mapped/
    );
  });

  it("does not issue a durable session for an invalid Greenhouse user id mapping", async () => {
    await assert.rejects(
      async () => {
        await issueDirectoryVerifiedEmailSessionToken(
          { secret: "secret", allowedDomains: ["company.com"] },
          { email: "recruiter@company.com", surface: "claude_desktop" },
          createStaticIdentityDirectory([
            { email: "recruiter@company.com", status: "resolved", greenhouseUserId: 0 },
          ])
        );
      },
      /invalid Greenhouse user id/
    );

    const preflight = await preflightDirectoryVerifiedEmailRoster(
      {
        allowedDomains: ["company.com"],
        rosterSource: "admin_managed_roster",
        verifiedBy: "ops-reviewer@example.com",
        now: () => Date.parse("2026-06-23T12:00:00.000Z"),
      },
      { emails: ["recruiter@company.com"], surfaces: ["claude_desktop"] },
      createStaticIdentityDirectory([
        { email: "recruiter@company.com", status: "resolved", greenhouseUserIds: [789, -1] },
      ])
    );

    assert.equal(preflight.ok, false);
    assert.equal(preflight.canIssueSessions, false);
    assert.match(preflight.denied[0]?.reason ?? "", /invalid Greenhouse user id/);
  });

  it("does not issue or preflight durable sessions for unsafe Greenhouse user ids", async () => {
    await assert.rejects(
      async () => {
        await issueDirectoryVerifiedEmailSessionToken(
          { secret: "secret", allowedDomains: ["company.com"] },
          { email: "unsafe@company.com", surface: "claude_desktop" },
          createStaticIdentityDirectory([
            { email: "unsafe@company.com", status: "resolved", greenhouseUserId: UNSAFE_GREENHOUSE_USER_ID },
          ])
        );
      },
      /invalid Greenhouse user id/
    );

    const batch = await issueDirectoryVerifiedEmailSessionBatch(
      { secret: "secret", allowedDomains: ["company.com"] },
      { emails: ["unsafe@company.com"], surfaces: ["chatgpt_desktop"] },
      createStaticIdentityDirectory([
        { email: "unsafe@company.com", status: "resolved", greenhouseUserId: UNSAFE_GREENHOUSE_USER_ID },
      ])
    );

    assert.equal(batch.ok, false);
    assert.equal(batch.issued.length, 0);
    assert.match(batch.denied[0]?.reason ?? "", /invalid Greenhouse user id/);

    const preflight = await preflightDirectoryVerifiedEmailRoster(
      {
        allowedDomains: ["company.com"],
        rosterSource: "admin_managed_roster",
        verifiedBy: "ops-reviewer@example.com",
      },
      { emails: ["unsafe@company.com"], surfaces: ["claude_desktop"] },
      createStaticIdentityDirectory([
        { email: "unsafe@company.com", status: "resolved", greenhouseUserIds: [UNSAFE_GREENHOUSE_USER_ID] },
      ])
    );

    assert.equal(preflight.ok, false);
    assert.equal(preflight.canIssueSessions, false);
    assert.equal(preflight.resolved.length, 0);
    assert.match(preflight.denied[0]?.reason ?? "", /invalid Greenhouse user id/);
  });

  it("revokes durable sessions by token id without changing Greenhouse permissions", async () => {
    const issued = issueVerifiedEmailSessionToken(
      {
        secret: "secret",
        allowedDomains: ["company.com"],
        now: () => Date.parse("2026-06-23T12:00:00.000Z"),
        tokenId: () => "session-1",
      },
      { email: "recruiter@company.com", surface: "claude_desktop" }
    );
    const validator = createHmacSessionValidator("secret", {
      revokedTokenIds: new Set(["session-1"]),
    });

    const result = await validator.validate(issued.token);

    assert.equal(result.status, "invalid");
    assert.match(result.status === "invalid" ? result.reason : "", /revoked/);
  });

  it("loads durable session revocations from env", async () => {
    const issued = issueVerifiedEmailSessionToken(
      {
        secret: STRONG_SESSION_SECRET,
        allowedDomains: ["company.com"],
        tokenId: () => "session-2",
      },
      { email: "recruiter@company.com", surface: "claude_desktop" }
    );
    const validator = createSessionValidatorFromEnv({
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
      GREENHOUSE_RECRUITER_REVOKED_TOKEN_IDS: "session-2",
    } as NodeJS.ProcessEnv);

    assert.equal("status" in validator, false);
    const result = "status" in validator ? validator : await validator.validate(issued.token);

    assert.equal(result.status, "invalid");
    assert.match(result.status === "invalid" ? result.reason : "", /revoked/);
  });

  it("checks a dynamic server-side revocation provider on the next validation", async () => {
    const revoked = new Set<string>();
    const issued = issueVerifiedEmailSessionToken(
      {
        secret: "secret",
        allowedDomains: ["company.com"],
        now: () => Date.parse("2026-06-23T12:00:00.000Z"),
        tokenId: () => "dynamic-session-1",
      },
      { email: "recruiter@company.com", surface: "chatgpt_desktop" }
    );
    const validator = createHmacSessionValidator("secret", {
      revocationProvider: {
        isRevoked: (session) => revoked.has(session.tokenId ?? ""),
      },
    });

    const before = await validator.validate(issued.token);
    revoked.add("dynamic-session-1");
    const after = await validator.validate(issued.token);

    assert.equal(before.status, "valid");
    assert.equal(after.status, "invalid");
    assert.match(after.status === "invalid" ? after.reason : "", /revoked/);
  });

  it("fails closed when dynamic revocation status cannot be verified", async () => {
    const issued = issueVerifiedEmailSessionToken(
      {
        secret: "secret",
        allowedDomains: ["company.com"],
        tokenId: () => "dynamic-session-2",
      },
      { email: "recruiter@company.com", surface: "chatgpt_desktop" }
    );
    const validator = createHmacSessionValidator("secret", {
      revocationProvider: {
        isRevoked: async () => {
          throw new Error("revocation store unavailable");
        },
      },
    });

    const result = await validator.validate(issued.token);

    assert.equal(result.status, "invalid");
    assert.match(result.status === "invalid" ? result.reason : "", /revocation status could not be verified/);
  });

  it("queries the Supabase revocation table by durable token id", async () => {
    const requestedUrls: string[] = [];
    const provider = createSupabaseSessionRevocationProvider({
      supabaseUrl: "https://example.supabase.co/",
      apiKey: "service-role-key",
      fetchImpl: async (url, init) => {
        requestedUrls.push(String(url));
        assert.equal(init?.headers && (init.headers as Record<string, string>).apikey, "service-role-key");
        return new Response(JSON.stringify([{ token_id: "session-3", status: "revoked" }]), { status: 200 });
      },
    });

    const revoked = await provider.isRevoked({ ...baseSession, tokenId: "session-3" });

    assert.equal(revoked, true);
    assert.match(requestedUrls[0] ?? "", /recruiter_mcp_session_revocation/);
    assert.match(requestedUrls[0] ?? "", /token_id=eq\.session-3/);
    assert.match(requestedUrls[0] ?? "", /status=eq\.revoked/);
  });

  it("rejects insecure Supabase revocation URLs before lookup", () => {
    assert.throws(
      () => createSupabaseSessionRevocationProvider({
        supabaseUrl: "http://example.supabase.co",
        apiKey: "service-role-key",
      }),
      /HTTPS origin/
    );
    assert.throws(
      () => createSupabaseSessionRevocationProvider({
        supabaseUrl: " https://example.supabase.co ",
        apiKey: "service-role-key",
      }),
      /leading or trailing whitespace/
    );
  });

  it("rejects blank Supabase revocation API keys before lookup", () => {
    assert.throws(
      () => createSupabaseSessionRevocationProvider({
        supabaseUrl: "https://example.supabase.co",
        apiKey: "   ",
      }),
      /API key is required/
    );
  });

  it("rejects Supabase revocation API keys with surrounding whitespace before lookup", () => {
    assert.throws(
      () => createSupabaseSessionRevocationProvider({
        supabaseUrl: "https://example.supabase.co",
        apiKey: " service-role-key ",
      }),
      /leading or trailing whitespace/
    );
    const validator = createSessionValidatorFromEnv({
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
      GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
      GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY: " service-role-key ",
    } as NodeJS.ProcessEnv);

    assert.equal("status" in validator, true);
    assert.match("status" in validator && validator.status === "invalid" ? validator.reason : "", /leading or trailing whitespace/);
  });

  it("rejects unsafe Supabase revocation column overrides before lookup", () => {
    assert.throws(
      () => createSupabaseSessionRevocationProvider({
        supabaseUrl: "https://example.supabase.co",
        apiKey: "service-role-key",
        columns: { tokenId: "token_id,status" },
      }),
      /token id column/
    );
    assert.throws(
      () => createSupabaseSessionRevocationProvider({
        supabaseUrl: "https://example.supabase.co",
        apiKey: "service-role-key",
        table: " recruiter_mcp_session_revocation ",
      }),
      /leading or trailing whitespace/
    );
    assert.throws(
      () => createSupabaseSessionRevocationProvider({
        supabaseUrl: "https://example.supabase.co",
        apiKey: "service-role-key",
        columns: { status: " status " },
      }),
      /leading or trailing whitespace/
    );
  });

  it("keeps default Supabase revocation columns when env omits custom names", async () => {
    const issued = issueVerifiedEmailSessionToken(
      {
        secret: STRONG_SESSION_SECRET,
        allowedDomains: ["company.com"],
        tokenId: () => "session-default-columns-1",
      },
      { email: "recruiter@company.com", surface: "claude_desktop" }
    );
    const requestedUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      requestedUrls.push(String(url));
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch;
    try {
      const validator = createSessionValidatorFromEnv({
        GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
        GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
        GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY: "service-role-key",
      } as NodeJS.ProcessEnv);

      assert.equal("status" in validator, false);
      const result = "status" in validator ? validator : await validator.validate(issued.token);

      assert.equal(result.status, "valid");
      const requested = new URL(requestedUrls[0] ?? "http://missing.local");
      assert.equal(requested.searchParams.get("select"), "token_id,status");
      assert.equal(requested.searchParams.get("token_id"), "eq.session-default-columns-1");
      assert.equal(requested.searchParams.get("status"), "eq.revoked");
      assert.equal(requested.href.includes("undefined"), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails closed when the Supabase revocation lookup times out", async () => {
    let aborted = false;
    const issued = issueVerifiedEmailSessionToken(
      {
        secret: "secret",
        allowedDomains: ["company.com"],
        tokenId: () => "session-timeout-1",
      },
      { email: "recruiter@company.com", surface: "chatgpt_desktop" }
    );
    const validator = createHmacSessionValidator("secret", {
      revocationProvider: createSupabaseSessionRevocationProvider({
        supabaseUrl: "https://example.supabase.co/",
        apiKey: "service-role-key",
        timeoutMs: 1,
        fetchImpl: ((_url, init) => new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        })) as typeof fetch,
      }),
    });

    const result = await validator.validate(issued.token);

    assert.equal(aborted, true);
    assert.equal(result.status, "invalid");
    assert.match(result.status === "invalid" ? result.reason : "", /revocation status could not be verified/);
  });

  it("fails closed for Supabase revocation non-2xx and non-array responses through the validator", async () => {
    const issued = issueVerifiedEmailSessionToken(
      {
        secret: "secret",
        allowedDomains: ["company.com"],
        tokenId: () => "session-revocation-error-1",
      },
      { email: "recruiter@company.com", surface: "chatgpt_desktop" }
    );
    const cases: Array<{ status: number; body: unknown }> = [
      { status: 500, body: { error: "server error" } },
      { status: 401, body: { error: "unauthorized" } },
      { status: 429, body: { error: "rate limited" } },
      { status: 200, body: { token_id: "session-revocation-error-1", status: "revoked" } },
    ];

    for (const testCase of cases) {
      const validator = createHmacSessionValidator("secret", {
        revocationProvider: createSupabaseSessionRevocationProvider({
          supabaseUrl: "https://example.supabase.co/",
          apiKey: "service-role-key",
          fetchImpl: (async () => new Response(JSON.stringify(testCase.body), { status: testCase.status })) as typeof fetch,
        }),
      });

      const result = await validator.validate(issued.token);

      assert.equal(result.status, "invalid");
      assert.match(result.status === "invalid" ? result.reason : "", /revocation status could not be verified/);
    }
  });

  it("rejects weak env-backed session signing secrets", () => {
    const validator = createSessionValidatorFromEnv({
      GREENHOUSE_RECRUITER_SESSION_SECRET: "short-secret",
    } as NodeJS.ProcessEnv);

    assert.equal("status" in validator, true);
    assert.deepEqual(validator, {
      status: "invalid",
      reason: "GREENHOUSE_RECRUITER_SESSION_SECRET must be at least 32 characters.",
    });
  });

  it("rejects env-backed session signing secrets with surrounding whitespace", () => {
    const validator = createSessionValidatorFromEnv({
      GREENHOUSE_RECRUITER_SESSION_SECRET: ` ${STRONG_SESSION_SECRET} `,
    } as NodeJS.ProcessEnv);

    assert.equal("status" in validator, true);
    assert.deepEqual(validator, {
      status: "invalid",
      reason: "GREENHOUSE_RECRUITER_SESSION_SECRET must not contain leading or trailing whitespace.",
    });
    assert.throws(
      () => createEmailSessionIssuerConfigFromEnv({
        GREENHOUSE_RECRUITER_SESSION_SECRET: ` ${STRONG_SESSION_SECRET} `,
        GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS: "company.com",
      } as NodeJS.ProcessEnv),
      /leading or trailing whitespace/
    );
  });

  it("rejects invalid env-backed revocation lookup timeout config", () => {
    const validator = createSessionValidatorFromEnv({
      GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
      GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
      GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY: "service-role-key",
      GREENHOUSE_RECRUITER_REVOCATION_LOOKUP_TIMEOUT_MS: "0",
    } as NodeJS.ProcessEnv);

    assert.equal("status" in validator && validator.status === "invalid", true);
    if (!("status" in validator) || validator.status !== "invalid") assert.fail("expected invalid validator result");
    assert.match(validator.reason, /REVOCATION_LOOKUP_TIMEOUT_MS/);
  });

  it("normalizes only allowed work email domains for onboarding", () => {
    assert.equal(normalizeWorkEmail(" Recruiter@Company.com ", ["company.com"]), "recruiter@company.com");
    assert.throws(() => normalizeWorkEmail("person@gmail.com", ["company.com"]), /domain/);
  });

  it("parses newline and comma separated recruiter email lists for managed onboarding", () => {
    assert.deepEqual(
      parseEmailList("recruiter.one@company.com, recruiter.two@company.com\n# comment\nrecruiter.three@company.com\n"),
      ["recruiter.one@company.com", "recruiter.two@company.com", "recruiter.three@company.com"]
    );
  });
});

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe("identity actor resolution", () => {
  it("maps an authenticated subject/email to exactly one Greenhouse user id", async () => {
    const resolver = createIdentityActorResolver(
      createStaticIdentityDirectory([
        { subject: baseSession.subject, email: baseSession.email, status: "resolved", greenhouseUserId: 123 },
      ])
    );

    await assert.doesNotReject(async () => {
      assert.equal(await resolver.resolveActor(baseSession), 123);
    });
  });

  it("denies unresolved identities", async () => {
    const resolver = createIdentityActorResolver(createStaticIdentityDirectory([]));

    await assert.rejects(
      async () => { await resolver.resolveActor(baseSession); },
      (error: unknown) => error instanceof IdentityResolutionError && error.code === "IDENTITY_NOT_RESOLVED"
    );
  });

  it("denies ambiguous identities instead of choosing one", async () => {
    const resolver = createIdentityActorResolver(
      createStaticIdentityDirectory([
        { email: baseSession.email, status: "resolved", greenhouseUserIds: [123, 456] },
      ])
    );

    await assert.rejects(
      async () => { await resolver.resolveActor(baseSession); },
      (error: unknown) => error instanceof IdentityResolutionError && error.code === "IDENTITY_AMBIGUOUS"
    );
  });

  it("denies invalid identity-directory rows explicitly", async () => {
    const resolver = createIdentityActorResolver(
      createStaticIdentityDirectory([
        { email: baseSession.email, status: "resolved", greenhouseUserId: 0 },
      ])
    );

    await assert.rejects(
      async () => { await resolver.resolveActor(baseSession); },
      (error: unknown) => error instanceof IdentityResolutionError && error.code === "IDENTITY_INVALID"
    );
  });

  it("denies static identity rows with unsafe Greenhouse user ids", async () => {
    const resolver = createIdentityActorResolver(
      createStaticIdentityDirectory([
        { email: baseSession.email, status: "resolved", greenhouseUserId: UNSAFE_GREENHOUSE_USER_ID },
      ])
    );

    await assert.rejects(
      async () => { await resolver.resolveActor(baseSession); },
      (error: unknown) => error instanceof IdentityResolutionError && error.code === "IDENTITY_INVALID"
    );
  });

  it("resolves verified work email through a Supabase-backed identity directory", async () => {
    const requests: Array<{ url: URL; headers: Headers }> = [];
    const fetchImpl = async (url: URL | RequestInfo, init?: RequestInit) => {
      const parsedUrl = new URL(String(url));
      requests.push({ url: parsedUrl, headers: new Headers(init?.headers) });
      const emailFilter = parsedUrl.searchParams.get("primary_email");
      return {
        ok: true,
        status: 200,
        json: async () => emailFilter === "eq.recruiter@example.com"
          ? [{ greenhouse_user_id: "123", primary_email: "recruiter@example.com", status: "resolved" }]
          : [],
      } as Response;
    };
    const resolver = createIdentityActorResolver(createSupabaseIdentityDirectory({
      supabaseUrl: "https://project.supabase.co/",
      apiKey: "supabase-key",
      fetchImpl: fetchImpl as typeof fetch,
    }));

    assert.equal(await resolver.resolveActor(baseSession), 123);
    assert.equal(requests[0]?.url.pathname, "/rest/v1/recruiter_identity_directory");
    assert.equal(requests[0]?.url.searchParams.get("primary_email"), "eq.recruiter@example.com");
    assert.equal(requests[0]?.url.searchParams.get("status"), "eq.resolved");
    assert.equal(requests[0]?.headers.get("apikey"), "supabase-key");
    assert.equal(requests[0]?.headers.get("authorization"), "Bearer supabase-key");
  });

  it("rejects insecure Supabase identity URLs before lookup", () => {
    assert.throws(
      () => createSupabaseIdentityDirectory({
        supabaseUrl: "http://project.supabase.co",
        apiKey: "supabase-key",
      }),
      /HTTPS origin/
    );
    assert.throws(
      () => createSupabaseIdentityDirectory({
        supabaseUrl: " https://project.supabase.co ",
        apiKey: "supabase-key",
      }),
      /leading or trailing whitespace/
    );
  });

  it("rejects blank Supabase identity API keys before lookup", () => {
    assert.throws(
      () => createSupabaseIdentityDirectory({
        supabaseUrl: "https://project.supabase.co",
        apiKey: "   ",
      }),
      /API key is required/
    );
  });

  it("rejects Supabase identity API keys with surrounding whitespace before lookup", () => {
    assert.throws(
      () => createSupabaseIdentityDirectory({
        supabaseUrl: "https://project.supabase.co",
        apiKey: " supabase-key ",
      }),
      /leading or trailing whitespace/
    );
  });

  it("rejects unsafe Supabase identity column overrides before lookup", () => {
    assert.throws(
      () => createSupabaseIdentityDirectory({
        supabaseUrl: "https://project.supabase.co",
        apiKey: "supabase-key",
        columns: { email: "primary_email,google_subject" },
      }),
      /email column/
    );
    assert.throws(
      () => createSupabaseIdentityDirectory({
        supabaseUrl: "https://project.supabase.co",
        apiKey: "supabase-key",
        table: " recruiter_identity_directory ",
      }),
      /leading or trailing whitespace/
    );
    assert.throws(
      () => createSupabaseIdentityDirectory({
        supabaseUrl: "https://project.supabase.co",
        apiKey: "supabase-key",
        columns: { subject: " google_subject " },
      }),
      /leading or trailing whitespace/
    );
  });

  it("denies ambiguous Supabase identity rows across email and subject lookups", async () => {
    const fetchImpl = async (url: URL | RequestInfo) => {
      const parsedUrl = new URL(String(url));
      const emailFilter = parsedUrl.searchParams.get("primary_email");
      const subjectFilter = parsedUrl.searchParams.get("google_subject");
      return {
        ok: true,
        status: 200,
        json: async () => {
          if (emailFilter === "eq.recruiter@example.com") return [{ greenhouse_user_id: 123 }];
          if (subjectFilter === "eq.google-oauth2|abc") return [{ greenhouse_user_id: 456 }];
          return [];
        },
      } as Response;
    };
    const resolver = createIdentityActorResolver(createSupabaseIdentityDirectory({
      supabaseUrl: "https://project.supabase.co",
      apiKey: "supabase-key",
      fetchImpl: fetchImpl as typeof fetch,
    }));

    await assert.rejects(
      async () => { await resolver.resolveActor(baseSession); },
      (error: unknown) => error instanceof IdentityResolutionError && error.code === "IDENTITY_AMBIGUOUS"
    );
  });

  it("denies invalid Supabase identity rows explicitly", async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => [{ greenhouse_user_id: "0" }],
    }) as Response;
    const resolver = createIdentityActorResolver(createSupabaseIdentityDirectory({
      supabaseUrl: "https://project.supabase.co",
      apiKey: "supabase-key",
      fetchImpl: fetchImpl as typeof fetch,
    }));

    await assert.rejects(
      async () => { await resolver.resolveActor(baseSession); },
      (error: unknown) => error instanceof IdentityResolutionError && error.code === "IDENTITY_INVALID"
    );
  });

  it("denies Supabase identity rows with unsafe string Greenhouse user ids", async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => [{ greenhouse_user_id: "9007199254740993" }],
    }) as Response;
    const resolver = createIdentityActorResolver(createSupabaseIdentityDirectory({
      supabaseUrl: "https://project.supabase.co",
      apiKey: "supabase-key",
      fetchImpl: fetchImpl as typeof fetch,
    }));

    await assert.rejects(
      async () => { await resolver.resolveActor(baseSession); },
      (error: unknown) => error instanceof IdentityResolutionError && error.code === "IDENTITY_INVALID"
    );
  });

  it("times out hung Supabase identity lookups instead of waiting indefinitely", async () => {
    let aborted = false;
    const resolver = createIdentityActorResolver(createSupabaseIdentityDirectory({
      supabaseUrl: "https://project.supabase.co",
      apiKey: "supabase-key",
      timeoutMs: 1,
      fetchImpl: ((_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      })) as typeof fetch,
    }));

    await assert.rejects(
      async () => { await resolver.resolveActor(baseSession); },
      /Identity directory lookup timed out after 1ms/
    );
    assert.equal(aborted, true);
  });

  it("builds the production identity directory from Supabase env as a server-side source", async () => {
    const directory = createIdentityDirectoryFromEnv({
      GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
      GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY: "supabase-key",
    } as NodeJS.ProcessEnv);

    assert.ok(directory);
  });

  it("uses Supabase identity over leftover static JSON when production identity env is configured", async () => {
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify([{ greenhouse_user_id: 321 }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const directory = createIdentityDirectoryFromEnv({
        GREENHOUSE_RECRUITER_IDENTITY_JSON: JSON.stringify([
          { email: "recruiter@example.com", status: "resolved", greenhouseUserId: 999 },
        ]),
        GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
        GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY: "supabase-key",
      } as NodeJS.ProcessEnv);
      const resolver = createIdentityActorResolver(directory);

      const actorId = await resolver.resolveActor(baseSession);

      assert.equal(actorId, 321);
      assert.ok(requests.every((url) => url.startsWith("https://exampleprojectref000.supabase.co/rest/v1/recruiter_identity_directory")));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not let static JSON mask partial Supabase identity configuration", () => {
    assert.throws(
      () => createIdentityDirectoryFromEnv({
        GREENHOUSE_RECRUITER_IDENTITY_JSON: JSON.stringify([
          { email: "recruiter@example.com", status: "resolved", greenhouseUserId: 999 },
        ]),
        GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
      } as NodeJS.ProcessEnv),
      /must be set together/
    );
  });

  it("rejects partial Supabase identity directory env config", () => {
    assert.throws(
      () => createIdentityDirectoryFromEnv({
        GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
      } as NodeJS.ProcessEnv),
      /must be set together/
    );
  });

  it("rejects invalid env-backed identity lookup timeout config", () => {
    assert.throws(
      () => createIdentityDirectoryFromEnv({
        GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
        GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY: "supabase-key",
        GREENHOUSE_RECRUITER_IDENTITY_LOOKUP_TIMEOUT_MS: "never",
      } as NodeJS.ProcessEnv),
      /IDENTITY_LOOKUP_TIMEOUT_MS/
    );
  });

  it("rejects a non-canonical Supabase identity project configured from env (Slice F #3)", () => {
    assert.throws(
      () => createIdentityDirectoryFromEnv({
        GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: "https://otherprojectref00000.supabase.co",
        GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY: "supabase-key",
      } as NodeJS.ProcessEnv),
      /canonical Greenhouse MCP Supabase project/,
    );
  });

  it("rejects a non-canonical Supabase revocation project configured from env (Slice F #3)", () => {
    assert.throws(
      () => createSessionRevocationProviderFromEnv({
        GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL: "https://otherprojectref00000.supabase.co",
        GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY: "revocation-key",
      } as NodeJS.ProcessEnv),
      /canonical Greenhouse MCP Supabase project/,
    );
  });
});

describe("action client vocabulary map", () => {
  it("translates each read-plane client the action plane has a name for", () => {
    assert.equal(
      actionClientForRecruiterSession({ ...baseSession, surface: "chatgpt_desktop", client: "chatgpt_codex_host" }),
      "codex"
    );
    assert.equal(actionClientForRecruiterSession({ ...baseSession, client: "claude_code" }), "claude_code");
  });

  it("returns no action client for Claude Desktop chat, which the action plane cannot entitle", () => {
    // Not an omission: the entitlement lookup filters on the client (action-mcp/src/store.ts:110-118)
    // and provisioning grants only codex or claude_code (access-cli.ts:477-485), so there is no row
    // this client could ever match.
    assert.equal(actionClientForRecruiterSession({ ...baseSession, client: "claude_desktop_chat" }), null);
  });

  it("maps every client a token can carry to a legal action name or null, never to anything else", () => {
    // Declaring the cases as Record<RecruiterClient, true> makes this list exhaustive at COMPILE time,
    // mirroring the Record gate on the map itself: a fourth RecruiterClient breaks the build in both
    // places until someone decides whether it can write, instead of quietly skipping this assertion.
    const everyRecruiterClient: Record<RecruiterClient, true> = {
      claude_desktop_chat: true,
      claude_code: true,
      chatgpt_codex_host: true,
    };
    const legalActionNames = new Set(["codex", "claude_code", null]);
    for (const client of Object.keys(everyRecruiterClient) as RecruiterClient[]) {
      const mapped = actionClientForRecruiterSession({ ...baseSession, client });
      assert.notEqual(mapped, undefined, `${client} has no action-plane mapping`);
      assert.ok(legalActionNames.has(mapped), `${client} mapped to an unrecognized action client: ${mapped}`);
    }
  });

  it("refuses to name an action client for a session that cannot prove which client it is", async () => {
    // types.ts:20-21 calls a missing client a pre-v2 legacy artifact, but nothing enforces that — a
    // token signed with no client still validates today, so the map has to fail closed on its own.
    const legacy = await createHmacSessionValidator("secret").validate(
      createSignedSessionToken({ ...baseSession, client: undefined }, "secret")
    );
    assert.equal(legacy.status, "valid");
    if (legacy.status !== "valid") assert.fail("expected a client-less token to validate");
    assert.equal(legacy.session.client, undefined);
    assert.equal(actionClientForRecruiterSession(legacy.session), null);

    const { client: _omitted, ...withoutClientKey } = baseSession;
    assert.equal(actionClientForRecruiterSession(withoutClientKey), null);
  });

  it("refuses to name an action client for a session that names two actors", () => {
    // The binding is enforced where tokens are validated and signed, and this path is neither:
    // createRecruiterMcpServer takes an arbitrary AuthenticatedSession (server.ts:61-75), so a
    // session assembled in code never meets a validator. Left unchecked, `{subject:"email:a@x",
    // email:"b@x"}` reached the entitlement lookup as write-capable — the read plane authorizing B,
    // the action plane authorizing A.
    const divergent: AuthenticatedSession = {
      ...baseSession,
      client: "claude_code",
      subject: "email:recruiter@example.com",
      email: "someone.else@example.com",
    };

    // No token can carry this shape — which is exactly why the map cannot rely on that.
    assert.throws(() => createSignedSessionToken(divergent, "secret"), /email subject/);
    assert.equal(actionClientForRecruiterSession(divergent), null);

    // Bound: the same session with a claim that agrees is write-eligible, so this refuses
    // divergence rather than `email:` subjects.
    assert.equal(
      actionClientForRecruiterSession({ ...divergent, email: "recruiter@example.com" }),
      "claude_code"
    );

    // Total against a session that is only typed, never checked: no subject at all names no actor.
    for (const subject of ["", " ", undefined as unknown as string]) {
      assert.equal(
        actionClientForRecruiterSession({ ...divergent, subject, email: "recruiter@example.com" }),
        null,
        `subject ${JSON.stringify(subject)} was treated as proof of an actor`
      );
    }
  });

  it("never emits the action plane's `test` client, because `test` is a surface here", () => {
    assert.equal(isClientSurfaceCompatible("claude_code", "test"), false);
    assert.equal(actionClientForRecruiterSession({ ...baseSession, surface: "test", client: undefined }), null);
    // Unvalidated junk that skipped the token path maps to null rather than leaking through.
    assert.equal(
      actionClientForRecruiterSession({ ...baseSession, client: "test" as unknown as RecruiterClient }),
      null
    );
  });
});

function createRawSignedSessionPayload(payload: object, secret: string): string {
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payloadPart).digest("base64url");
  return `${payloadPart}.${signature}`;
}
