import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAuditSinkFromEnv, createJsonlAuditSink, preflightRetainedAuditSinkFromEnv, type RecruiterAuditEvent } from "../src/audit.js";

describe("production audit sinks", () => {
  it("writes one redacted JSON audit event per line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-audit-"));
    const auditPath = join(dir, "nested", "audit.jsonl");
    const sink = createJsonlAuditSink(auditPath);

    await sink.emit(auditEvent({ correlationId: "call-1" }));
    await sink.emit(auditEvent({ correlationId: "call-2", denialCode: "TOOL_DISABLED" }));

    const lines = (await readFile(auditPath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]!) as RecruiterAuditEvent, auditEvent({ correlationId: "call-1" }));
    assert.deepEqual(JSON.parse(lines[1]!) as RecruiterAuditEvent, auditEvent({ correlationId: "call-2", denialCode: "TOOL_DISABLED" }));
    assert.doesNotMatch(lines.join("\n"), /candidate|note body|scorecard text|prompt/i);
  });

  it("selects the JSONL sink from GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-audit-env-"));
    const auditPath = join(dir, "audit.jsonl");
    const sink = createAuditSinkFromEnv({
      GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH: auditPath,
    } as NodeJS.ProcessEnv);

    await sink.emit(auditEvent({ correlationId: "env-call" }));

    const [line] = (await readFile(auditPath, "utf8")).trim().split("\n");
    assert.equal((JSON.parse(line!) as RecruiterAuditEvent).correlationId, "env-call");
  });

  it("keeps console audit fallback for local callers when retained audit is not required", async () => {
    const originalError = console.error;
    const calls: string[] = [];
    console.error = (message?: unknown) => {
      calls.push(String(message));
    };
    try {
      const sink = createAuditSinkFromEnv({} as NodeJS.ProcessEnv);

      await sink.emit(auditEvent({ correlationId: "console-call" }));
    } finally {
      console.error = originalError;
    }

    assert.equal(calls.length, 1);
    assert.match(calls[0]!, /console-call/);
  });

  it("rejects missing retained audit config when retained audit is required", () => {
    assert.throws(
      () => createAuditSinkFromEnv({} as NodeJS.ProcessEnv, { requireRetained: true }),
      /AUDIT_JSONL_PATH/
    );
  });

  it("preflights retained audit storage without writing synthetic audit rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-audit-preflight-"));
    const auditPath = join(dir, "audit.jsonl");

    const sink = await preflightRetainedAuditSinkFromEnv({
      GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH: auditPath,
    } as NodeJS.ProcessEnv);

    assert.equal((await readFile(auditPath, "utf8")), "");
    await sink.emit(auditEvent({ correlationId: "after-preflight" }));
    const [line] = (await readFile(auditPath, "utf8")).trim().split("\n");
    assert.equal((JSON.parse(line!) as RecruiterAuditEvent).correlationId, "after-preflight");
    assert.equal((await stat(auditPath)).mode & 0o777, 0o600);
  });

  it("creates retained JSONL audit files with owner-only permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-audit-mode-"));
    const auditPath = join(dir, "audit.jsonl");
    const sink = createJsonlAuditSink(auditPath);

    await sink.emit(auditEvent({ correlationId: "mode-call" }));

    assert.equal((await stat(auditPath)).mode & 0o777, 0o600);
  });

  it("repairs retained JSONL audit file permissions on append", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-audit-mode-repair-"));
    const auditPath = join(dir, "audit.jsonl");
    const sink = createJsonlAuditSink(auditPath);

    await sink.emit(auditEvent({ correlationId: "mode-call-1" }));
    await chmod(auditPath, 0o644);
    await sink.emit(auditEvent({ correlationId: "mode-call-2" }));

    assert.equal((await stat(auditPath)).mode & 0o777, 0o600);
  });

  it("rejects an empty JSONL audit path", () => {
    assert.throws(() => createJsonlAuditSink("  "), /must not be empty/);
  });

  it("rejects non-retained-looking audit paths before request handling", () => {
    assert.throws(() => createJsonlAuditSink("audit.jsonl"), /absolute path/);
    assert.throws(() => createJsonlAuditSink("/secure/audit.log"), /must end with \.jsonl/);
  });
});

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
