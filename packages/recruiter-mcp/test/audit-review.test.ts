import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAuditReview, runAuditReviewFromEnv } from "../src/audit-review.js";
import { resolvedJobHash, type RecruiterAuditEvent } from "../src/audit.js";

describe("audit review evidence", () => {
  it("accepts retained legacy rows but does not count them as v2 physical-client attribution", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-audit-review-"));
    const auditPath = join(dir, "audit.jsonl");
    await writeAudit(auditPath, [
      auditEvent({ correlationId: "success-1", surface: "chatgpt_desktop", toolKind: "analysis" }),
      auditEvent({ correlationId: "denial-1", surface: "claude_desktop", toolKind: "evidence", denialCode: "TOOL_DISABLED", rowsRead: null, rowsReturned: null }),
    ]);

    const report = await runAuditReview({
      auditPath,
      reviewer: "ops@example.com",
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });

    assert.equal(report.ok, false);
    assert.equal(report.status, "fail");
    assert.equal(report.totalEvents, 2);
    assert.equal(report.successEventsPresent, true);
    assert.equal(report.denialEventsPresent, true);
    assert.equal(report.undatedLegacyEvents, 2);
    assert.equal(report.surfaceCoveragePresent, true);
    assert.equal(report.v2ClientCoveragePresent, false);
    assert.deepEqual(report.v2Clients, []);
    assert.equal(report.checks.find((check) => check.name === "audit_schema_closed")?.status, "pass");
    assert.equal(report.checks.find((check) => check.name === "audit_v2_client_coverage")?.status, "fail");
    assert.equal(report.toolKindCoveragePresent, true);
    assert.deepEqual(report.surfaces, ["chatgpt_desktop", "claude_desktop"]);
    assert.deepEqual(report.toolKinds, ["analysis", "evidence"]);
    assert.equal(report.noSensitivePayloadsFound, true);
    assert.equal(report.reviewer, "ops@example.com");
    assert.equal(report.auditPath, "audit.jsonl");
    assert.equal(JSON.stringify(report).includes(dir), false);
  });

  it("accepts paired v2 rows, counts calls from terminal rows, and verifies reconstructable scope metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-audit-review-v2-"));
    const auditPath = join(dir, "audit.jsonl");
    const first = v2Pair({ correlationId: "v2-success", surface: "chatgpt_desktop", client: "chatgpt_codex_host", toolKind: "analysis", resolvedJobIds: [7, 11] });
    const second = v2Pair({ correlationId: "v2-denial", surface: "claude_desktop", client: "claude_desktop_chat", toolKind: "evidence", denialCode: "TOOL_DISABLED" });
    const third = v2Pair({ correlationId: "v2-claude-code", surface: "claude_desktop", client: "claude_code", toolKind: "analysis", resolvedJobIds: [13] });
    await writeAudit(auditPath, [...first, ...second, ...third]);

    const report = await runAuditReview({ auditPath });

    assert.equal(report.ok, true);
    assert.equal(report.totalEvents, 3);
    assert.equal(report.v2StartEvents, 3);
    assert.equal(report.v2TerminalEvents, 3);
    assert.equal(report.undatedLegacyEvents, 0);
    assert.equal(report.successEvents, 2);
    assert.equal(report.denialEvents, 1);
    assert.equal(report.v2ClientCoveragePresent, true);
    assert.deepEqual(report.v2Clients, ["chatgpt_codex_host", "claude_code", "claude_desktop_chat"]);
  });

  it("fails when a v2 start and terminal disagree on physical-client attribution", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-audit-review-v2-attribution-"));
    const auditPath = join(dir, "audit.jsonl");
    const mismatched = v2Pair({ correlationId: "mismatched-client", surface: "claude_desktop", client: "claude_code", toolKind: "analysis", resolvedJobIds: [17] });
    mismatched[0] = { ...mismatched[0]!, client: "claude_desktop_chat" };
    await writeAudit(auditPath, [
      ...mismatched,
      ...v2Pair({ correlationId: "coverage-chatgpt", surface: "chatgpt_desktop", client: "chatgpt_codex_host", toolKind: "analysis", resolvedJobIds: [19] }),
      ...v2Pair({ correlationId: "coverage-claude", surface: "claude_desktop", client: "claude_desktop_chat", toolKind: "evidence", denialCode: "DENIED" }),
    ]);

    const report = await runAuditReview({ auditPath });

    assert.equal(report.ok, false);
    assert.equal(report.checks.find((check) => check.name === "audit_v2_pair_attribution")?.status, "fail");
  });

  it("rejects a successful jobs-scoped v2 terminal whose resolved ids cannot be reconstructed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-audit-review-v2-scope-"));
    const auditPath = join(dir, "audit.jsonl");
    await writeAudit(auditPath, [
      ...v2Pair({
        correlationId: "missing-job-scope",
        surface: "chatgpt_desktop",
        client: "chatgpt_codex_host",
        toolKind: "analysis",
        permissionScopeKind: "jobs",
        permittedJobCount: 2,
        resolvedJobIds: null,
      }),
      ...v2Pair({
        correlationId: "coverage-denial",
        surface: "claude_desktop",
        client: "claude_desktop_chat",
        toolKind: "evidence",
        denialCode: "TOOL_DISABLED",
      }),
    ]);

    const report = await runAuditReview({ auditPath });

    assert.equal(report.ok, false);
    assert.deepEqual(
      report.checks.find((check) => check.name === "audit_schema_closed")?.details?.schemaViolations,
      [{ line: 2, reason: "successful jobs-scoped terminal requires resolved job metadata" }]
    );
  });

  it("fails when retained audit events do not include denial evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-audit-review-"));
    const auditPath = join(dir, "audit.jsonl");
    await writeAudit(auditPath, [auditEvent({ correlationId: "success-only" })]);

    const report = await runAuditReview({ auditPath });

    assert.equal(report.ok, false);
    assert.equal(report.denialEventsPresent, false);
    assert.equal(report.checks.find((check) => check.name === "audit_denial_events_present")?.status, "fail");
  });

  it("fails when retained audit events do not cover both desktop surfaces and tool families", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-audit-review-"));
    const auditPath = join(dir, "audit.jsonl");
    await writeAudit(auditPath, [
      auditEvent({ correlationId: "success-1", surface: "chatgpt_desktop", toolKind: "analysis" }),
      auditEvent({ correlationId: "denial-1", surface: "chatgpt_desktop", toolKind: "analysis", denialCode: "TOOL_DISABLED", rowsRead: null, rowsReturned: null }),
    ]);

    const report = await runAuditReview({ auditPath });

    assert.equal(report.ok, false);
    assert.equal(report.surfaceCoveragePresent, false);
    assert.equal(report.toolKindCoveragePresent, false);
    assert.equal(report.checks.find((check) => check.name === "audit_surface_coverage")?.status, "fail");
    assert.equal(report.checks.find((check) => check.name === "audit_tool_kind_coverage")?.status, "fail");
  });

  it("fails when audit lines contain unknown payload keys or email-like values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-audit-review-"));
    const auditPath = join(dir, "audit.jsonl");
    await writeFile(auditPath, [
      JSON.stringify({ ...auditEvent(), candidateEmail: "candidate@example.com" }),
      JSON.stringify({ ...auditEvent({ denialCode: "DENIED" }), correlationId: "user@example.com" }),
    ].join("\n"));

    const report = await runAuditReview({ auditPath });

    assert.equal(report.ok, false);
    assert.equal(report.noSensitivePayloadsFound, false);
    assert.equal(report.checks.find((check) => check.name === "audit_schema_closed")?.status, "fail");
    assert.equal(report.checks.find((check) => check.name === "audit_no_email_like_values")?.status, "fail");
  });

  it("fails when retained audit events contain credential-like values without echoing them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-audit-review-secrets-"));
    const auditPath = join(dir, "audit.jsonl");
    await writeAudit(auditPath, [
      auditEvent({ correlationId: "sk-secretAuditToken12345" }),
      auditEvent({ denialCode: "DENIED", rowsRead: null, rowsReturned: null }),
    ]);

    const report = await runAuditReview({ auditPath });
    const serialized = JSON.stringify(report);

    assert.equal(report.ok, false);
    assert.equal(report.noSensitivePayloadsFound, false);
    assert.equal(report.checks.find((check) => check.name === "audit_no_credential_like_values")?.status, "fail");
    assert.deepEqual(
      report.checks.find((check) => check.name === "audit_no_credential_like_values")?.details,
      { credentialLines: [1] }
    );
    assert.doesNotMatch(serialized, /sk-secretAuditToken12345/);
  });

  it("fails when allowed audit string fields carry free text instead of approved metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-audit-review-"));
    const auditPath = join(dir, "audit.jsonl");
    await writeAudit(auditPath, [
      auditEvent({ tool: "show_me_alice_smith_notes" }),
      auditEvent({ correlationId: "show Alice Smith scorecards" }),
      auditEvent({ denialCode: "permission lookup failed for candidate" }),
    ]);

    const report = await runAuditReview({ auditPath });
    const schemaCheck = report.checks.find((check) => check.name === "audit_schema_closed");

    assert.equal(report.ok, false);
    assert.equal(report.noSensitivePayloadsFound, false);
    assert.equal(schemaCheck?.status, "fail");
    assert.deepEqual(schemaCheck?.details?.schemaViolations, [
      { line: 1, reason: "invalid tool" },
      { line: 2, reason: "invalid correlationId" },
      { line: 3, reason: "invalid denialCode" },
    ]);
  });

  it("fails when retained audit numeric metadata is negative or unsafe", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-audit-review-"));
    const auditPath = join(dir, "audit.jsonl");
    await writeAudit(auditPath, [
      auditEvent({ actorGreenhouseUserId: Number.MAX_SAFE_INTEGER + 1 }),
      auditEvent({ actAsUser: -1, operator: true }),
      auditEvent({ permittedJobCount: -1 }),
      auditEvent({ rowsRead: Number.MAX_SAFE_INTEGER + 1 }),
      auditEvent({ rowsReturned: -1 }),
    ]);

    const report = await runAuditReview({ auditPath });
    const schemaCheck = report.checks.find((check) => check.name === "audit_schema_closed");

    assert.equal(report.ok, false);
    assert.equal(report.totalEvents, 0);
    assert.equal(schemaCheck?.status, "fail");
    assert.deepEqual(schemaCheck?.details?.schemaViolations, [
      { line: 1, reason: "invalid actorGreenhouseUserId" },
      { line: 2, reason: "invalid actAsUser" },
      { line: 3, reason: "invalid permittedJobCount" },
      { line: 4, reason: "invalid rowsRead" },
      { line: 5, reason: "invalid rowsReturned" },
    ]);
  });

  it("accepts fixed, terminal-only read_my_resume metadata without retaining document content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-audit-review-resume-"));
    const auditPath = join(dir, "audit.jsonl");
    const resume = v2Pair({
      correlationId: "resume-success",
      surface: "chatgpt_desktop",
      client: "chatgpt_codex_host",
      tool: "read_my_resume",
      toolKind: "evidence",
      resolvedJobIds: [7],
    });
    resume[1] = {
      ...resume[1]!,
      resumeAttachmentId: 42,
      resumeApplicationId: 101,
      resumeCandidateId: 55,
      resumeContentType: "application/pdf",
      resumeDownloadedBytes: 1_024,
      resumeExtractedBytes: 2_048,
      resumeOutputTruncated: false,
      resumeDownloadMs: 8,
      resumeParseMs: 12,
      resumeErrorClass: null,
    };
    await writeAudit(auditPath, [
      ...resume,
      ...v2Pair({ correlationId: "resume-coverage-desktop", surface: "claude_desktop", client: "claude_desktop_chat", toolKind: "analysis", resolvedJobIds: [11] }),
      ...v2Pair({ correlationId: "resume-coverage-code", surface: "claude_desktop", client: "claude_code", toolKind: "evidence", denialCode: "TOOL_DISABLED" }),
    ]);

    const report = await runAuditReview({ auditPath });

    assert.equal(report.ok, true);
    assert.equal(report.checks.find((check) => check.name === "audit_schema_closed")?.status, "pass");
    assert.equal(JSON.stringify(report).includes("resumeAttachmentId"), false, "review summary must not replay per-call metadata");
  });

  it("accepts metadata-free read_my_resume denials that occur before attachment processing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-audit-review-resume-preflight-"));
    const auditPath = join(dir, "audit.jsonl");
    await writeAudit(auditPath, [
      ...v2Pair({ correlationId: "resume-disabled", tool: "read_my_resume", toolKind: "evidence", denialCode: "TOOL_DISABLED" }),
      ...v2Pair({ correlationId: "resume-rate-limited", tool: "read_my_resume", toolKind: "evidence", denialCode: "RATE_LIMITED" }),
    ]);

    const report = await runAuditReview({ auditPath });

    assert.equal(report.checks.find((check) => check.name === "audit_schema_closed")?.status, "pass");
  });

  it("rejects resume content, URL, filename, start-stage metadata, and malformed error classes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-audit-review-resume-bad-"));
    const auditPath = join(dir, "audit.jsonl");
    const pair = v2Pair({
      correlationId: "resume-invalid",
      tool: "read_my_resume",
      toolKind: "evidence",
      resolvedJobIds: [7],
    });
    await writeFile(auditPath, [
      JSON.stringify({ ...pair[1]!, resumeText: "candidate document" }),
      JSON.stringify({ ...pair[1]!, resumeUrl: "https://files.example/resume" }),
      JSON.stringify({ ...pair[1]!, resumeFilename: "resume.pdf" }),
      JSON.stringify({ ...pair[0]!, resumeAttachmentId: 42 }),
      JSON.stringify({ ...pair[1]!, resumeErrorClass: "parser said candidate name" }),
      JSON.stringify(pair[1]),
    ].join("\n"), "utf8");

    const report = await runAuditReview({ auditPath });

    assert.equal(report.ok, false);
    assert.deepEqual(
      report.checks.find((check) => check.name === "audit_schema_closed")?.details?.schemaViolations,
      [
        { line: 1, reason: "unknown audit key(s): resumeText" },
        { line: 2, reason: "unknown audit key(s): resumeUrl" },
        { line: 3, reason: "unknown audit key(s): resumeFilename" },
        { line: 4, reason: "resume audit metadata is terminal-only for read_my_resume" },
        { line: 5, reason: "invalid resumeErrorClass" },
        { line: 6, reason: "successful resume audit missing resumeAttachmentId" },
      ]
    );
  });

  it("loads the audit review path from env and fails closed when it is missing", async () => {
    const missing = await runAuditReviewFromEnv({});
    assert.equal(missing.ok, false);
    assert.equal(missing.checks[0]?.name, "audit_path");

    const dir = await mkdtemp(join(tmpdir(), "greenhouse-audit-review-env-"));
    const auditPath = join(dir, "audit.jsonl");
    await writeAudit(auditPath, [
      ...v2Pair({ correlationId: "env-chatgpt", surface: "chatgpt_desktop", client: "chatgpt_codex_host", toolKind: "analysis", resolvedJobIds: [7] }),
      ...v2Pair({ correlationId: "env-claude", surface: "claude_desktop", client: "claude_desktop_chat", toolKind: "evidence", denialCode: "DENIED" }),
      ...v2Pair({ correlationId: "env-claude-code", surface: "claude_desktop", client: "claude_code", toolKind: "analysis", resolvedJobIds: [11] }),
    ]);

    const report = await runAuditReviewFromEnv({
      GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH: auditPath,
      GREENHOUSE_RECRUITER_AUDIT_REVIEWER: "ops@example.com",
    } as NodeJS.ProcessEnv);

    assert.equal(report.ok, true);
    assert.equal(report.auditPath, "audit.jsonl");
    assert.equal(report.reviewer, "ops@example.com");
  });

  it("does not echo local paths or filesystem error text when the audit file is unreadable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-audit-review-missing-"));
    const auditPath = join(dir, "missing-audit.jsonl");

    const report = await runAuditReview({ auditPath });
    const serialized = JSON.stringify(report);

    assert.equal(report.ok, false);
    assert.equal(report.auditPath, "missing-audit.jsonl");
    assert.equal(report.checks.find((check) => check.name === "audit_file_readable")?.summary, "Audit JSONL file could not be read.");
    assert.doesNotMatch(serialized, /ENOENT|no such file|greenhouse-audit-review-missing/i);
    assert.equal(serialized.includes(dir), false);
  });

  it("recognizes v2 scope-resolution audit fields instead of rejecting them as unknown keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-audit-review-scope-"));
    const auditPath = join(dir, "audit.jsonl");
    await writeFile(auditPath, [
      JSON.stringify({
        ...auditEvent({ surface: "chatgpt_desktop", toolKind: "analysis" }),
        scopeAction: "resolve",
        scopeResolutionStatus: "needs_confirmation",
        scopeStatus: "proposed",
        scopeJobCount: 3,
        scopeConfirmationRequired: true,
        scopeHash: "a1b2c3d4e5f6a7b8",
      }),
      JSON.stringify({
        ...auditEvent({ surface: "claude_desktop", toolKind: "analysis", correlationId: "scope-get-1" }),
        scopeAction: "get",
        scopeStatus: "confirmed",
        scopeJobCount: 3,
      }),
    ].join("\n"), "utf8");

    const report = await runAuditReview({ auditPath, reviewer: "ops@example.com", now: () => new Date("2026-06-23T00:00:00.000Z") });

    // The real scope-resolution audit lines are accepted, not rejected as "unknown audit key(s)".
    assert.equal(report.totalEvents, 2);
    assert.equal(report.noSensitivePayloadsFound, true);
    assert.equal(report.checks.find((check) => check.name === "audit_schema_closed")?.status, "pass");
  });

  it("rejects a malformed scope field value or an unknown scope_* key (no rubber-stamp)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-audit-review-scope-bad-"));
    const auditPath = join(dir, "audit.jsonl");
    // One malformed value per optional scope field (free text / name / wrong type), plus an unknown
    // scope_* key. Every per-field validator must reject its own line — otherwise a free-text/PII
    // value (e.g. a candidate name, which is not email-shaped so the sensitive-payload scan misses it)
    // could ride into the audit log under a scope_* name.
    await writeFile(auditPath, [
      JSON.stringify({ ...auditEvent({ correlationId: "scope-bad-1" }), scopeAction: "Show Alice Smith pipeline" }),
      JSON.stringify({ ...auditEvent({ correlationId: "scope-bad-2" }), scopeAction: "resolve", scopeResolutionStatus: "Needs Review" }),
      JSON.stringify({ ...auditEvent({ correlationId: "scope-bad-3" }), scopeAction: "resolve", scopeStatus: "Show Alice Smith pipeline" }),
      JSON.stringify({ ...auditEvent({ correlationId: "scope-bad-4" }), scopeAction: "resolve", scopeJobCount: -1 }),
      JSON.stringify({ ...auditEvent({ correlationId: "scope-bad-5" }), scopeAction: "resolve", scopeConfirmationRequired: "yes" }),
      JSON.stringify({ ...auditEvent({ correlationId: "scope-bad-6" }), scopeAction: "resolve", scopeHash: "NOT_A_HASH" }),
      JSON.stringify({ ...auditEvent({ correlationId: "scope-bad-7" }), scopeAction: "resolve", scopeLabel: "Senior Engineer, NYC" }),
    ].join("\n"), "utf8");

    const report = await runAuditReview({ auditPath });
    const schemaCheck = report.checks.find((check) => check.name === "audit_schema_closed");

    assert.equal(report.ok, false);
    assert.equal(schemaCheck?.status, "fail");
    assert.deepEqual(schemaCheck?.details?.schemaViolations, [
      { line: 1, reason: "invalid scopeAction" },
      { line: 2, reason: "invalid scopeResolutionStatus" },
      { line: 3, reason: "invalid scopeStatus" },
      { line: 4, reason: "invalid scopeJobCount" },
      { line: 5, reason: "invalid scopeConfirmationRequired" },
      { line: 6, reason: "invalid scopeHash" },
      { line: 7, reason: "unknown audit key(s): scopeLabel" },
    ]);
  });
});

async function writeAudit(path: string, events: RecruiterAuditEvent[]): Promise<void> {
  await writeFile(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
}

function auditEvent(overrides: Partial<RecruiterAuditEvent> = {}): RecruiterAuditEvent {
  return {
    event: "scoped_greenhouse_tool_call",
    surface: "chatgpt_desktop",
    tool: "analyze_scorecard_accountability",
    toolKind: "analysis",
    actorGreenhouseUserId: 123,
    effectiveGreenhouseUserId: 123,
    operator: false,
    actAsUser: null,
    permissionScopeKind: "jobs",
    permittedJobCount: 2,
    rowsRead: 10,
    rowsReturned: 4,
    denialCode: null,
    durationMs: 12,
    correlationId: "call-1",
    ...overrides,
  };
}

function v2Pair(overrides: Partial<RecruiterAuditEvent>): RecruiterAuditEvent[] {
  const ids = overrides.resolvedJobIds ?? null;
  const common: RecruiterAuditEvent = {
    ...auditEvent(overrides),
    schemaVersion: 2,
    at: "2026-07-15T20:00:00.000Z",
    client: overrides.client ?? "legacy_unknown",
    tokenId: "audit-token-id",
    failurePhase: overrides.denialCode ? "tool" : null,
    cancellationReason: null,
    pagesRead: overrides.denialCode ? null : 1,
    retries: overrides.denialCode ? null : 0,
    cacheHits: null,
    phaseTimingsMs: { total: 12, preflight: 1, authorizationOrScope: 2, tool: 9 },
    resolvedJobIds: ids,
    resolvedJobCount: ids?.length ?? null,
    resolvedJobHash: ids ? resolvedJobHash(ids) : null,
  };
  return [
    {
      ...common,
      auditStage: "start",
      actorGreenhouseUserId: null,
      effectiveGreenhouseUserId: null,
      permissionScopeKind: "unknown",
      permittedJobCount: null,
      rowsRead: null,
      rowsReturned: null,
      denialCode: null,
      durationMs: 0,
      outcome: "started",
      failurePhase: null,
      pagesRead: null,
      retries: null,
      phaseTimingsMs: { total: 0, preflight: 0, authorizationOrScope: 0, tool: 0 },
      resolvedJobIds: null,
      resolvedJobCount: null,
      resolvedJobHash: null,
    },
    { ...common, auditStage: "terminal", outcome: overrides.denialCode ? "denied" : "success" },
  ];
}
