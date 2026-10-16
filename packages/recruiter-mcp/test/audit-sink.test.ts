import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAuditSinkFromEnv,
  createJsonlAuditSink,
  listAuditReadPaths,
  partitionAuditPathByMonth,
  preflightRetainedAuditSinkFromEnv,
  type RecruiterAuditEvent,
} from "../src/audit.js";
import { isAuditSinkDurable } from "../src/readiness.js";

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

    // The hosted sink month-partitions the write path; readers resolve the partitions from the base.
    const paths = await listAuditReadPaths(auditPath);
    assert.equal(paths.length, 1);
    assert.match(paths[0]!, /audit-\d{4}-\d{2}\.jsonl$/);
    const [line] = (await readFile(paths[0]!, "utf8")).trim().split("\n");
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

    // Preflight probes the current month's partition (the real write target), leaving it empty.
    const partitioned = partitionAuditPathByMonth(auditPath, new Date());
    assert.equal((await readFile(partitioned, "utf8")), "");
    await sink.emit(auditEvent({ correlationId: "after-preflight" }));
    const [line] = (await readFile(partitioned, "utf8")).trim().split("\n");
    assert.equal((JSON.parse(line!) as RecruiterAuditEvent).correlationId, "after-preflight");
    assert.equal((await stat(partitioned)).mode & 0o777, 0o600);
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

  it("partitionAuditPathByMonth inserts the UTC year-month before the .jsonl suffix", () => {
    assert.equal(
      partitionAuditPathByMonth("/app/audit/audit.jsonl", new Date("2026-08-15T12:00:00.000Z")),
      "/app/audit/audit-2026-08.jsonl"
    );
    // UTC, single-digit month zero-padded, and only the trailing .jsonl is replaced.
    assert.equal(
      partitionAuditPathByMonth("/app/audit/my.audit.jsonl", new Date("2026-01-01T00:00:00.000Z")),
      "/app/audit/my.audit-2026-01.jsonl"
    );
  });

  it("month-partitions the retained audit write path so the append target stays bounded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-audit-partition-"));
    const base = join(dir, "audit.jsonl");
    const sink = createJsonlAuditSink(base, {
      partitionByMonth: true,
      now: () => new Date("2026-08-15T12:00:00.000Z"),
    });

    await sink.emit(auditEvent({ correlationId: "aug-call" }));

    const partitioned = join(dir, "audit-2026-08.jsonl");
    const line = (await readFile(partitioned, "utf8")).trim();
    assert.equal((JSON.parse(line) as RecruiterAuditEvent).correlationId, "aug-call");
    // The unpartitioned base path is never written, so no single file grows without bound.
    await assert.rejects(() => readFile(base, "utf8"));
    assert.equal((await stat(partitioned)).mode & 0o777, 0o600);
  });

  it("keeps a partitioned path under the declared durable mount so readiness still passes", () => {
    const partitioned = partitionAuditPathByMonth("/app/audit/audit.jsonl", new Date("2026-08-15T12:00:00.000Z"));
    assert.equal(
      isAuditSinkDurable({
        GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH: partitioned,
        GREENHOUSE_RECRUITER_AUDIT_DURABLE_MOUNT_PATH: "/app/audit",
      } as NodeJS.ProcessEnv),
      true
    );
    // Escaping the mount still fails, so the partition scheme cannot smuggle the sink off the volume.
    assert.equal(
      isAuditSinkDurable({
        GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH: "/elsewhere/audit-2026-08.jsonl",
        GREENHOUSE_RECRUITER_AUDIT_DURABLE_MOUNT_PATH: "/app/audit",
      } as NodeJS.ProcessEnv),
      false
    );
  });

  it("listAuditReadPaths returns the legacy base then monthly partitions in chronological order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-audit-list-"));
    const base = join(dir, "audit.jsonl");
    await writeFile(base, "legacy\n", "utf8");
    await writeFile(join(dir, "audit-2026-07.jsonl"), "jul\n", "utf8");
    await writeFile(join(dir, "audit-2026-08.jsonl"), "aug\n", "utf8");
    // An unrelated file in the same directory must not be swept in.
    await writeFile(join(dir, "notes.jsonl"), "nope\n", "utf8");

    const paths = await listAuditReadPaths(base);
    assert.deepEqual(paths, [
      base,
      join(dir, "audit-2026-07.jsonl"),
      join(dir, "audit-2026-08.jsonl"),
    ]);

    // A base whose directory has no matching files yields an empty list (readers fail closed on it).
    assert.deepEqual(await listAuditReadPaths(join(dir, "missing-audit.jsonl")), []);
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
