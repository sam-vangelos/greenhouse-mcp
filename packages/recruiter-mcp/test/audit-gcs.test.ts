import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertGcsAuditBucketShape,
  buildGcsAuditConfigFromEnv,
  createGcsObjectAuditSink,
  preflightGcsObjectAuditSinkFromEnv,
  readAuditBackendFromEnv,
  readGcsAuditEvents,
  resetGcsAuditRuntimeStateForTests,
  setGcsStorageFactoryForTests,
  type GcsStorageLike,
} from "../src/audit-gcs.js";
import {
  createAuditSinkFromEnv,
  emitAudit,
  isAuditUnavailableError,
  listAuditReadPaths,
  preflightRetainedAuditSinkFromEnv,
  type RecruiterAuditEvent,
} from "../src/audit.js";
import { createFakeGcsStorage } from "./fake-gcs-storage.js";

const EMIT_AT = new Date("2026-08-18T14:23:59.123Z");

describe("GCS object-per-event audit sink", () => {
  afterEach(() => {
    setGcsStorageFactoryForTests(null);
    resetGcsAuditRuntimeStateForTests();
  });

  it("writes exactly one create-only JSON object per emitted event", async () => {
    const fake = createFakeGcsStorage();
    const sink = createGcsObjectAuditSink({
      bucket: "audit-bucket",
      prefix: "audit",
      storage: fake.storage,
      now: () => EMIT_AT,
    });

    await sink.emit(auditEvent({ correlationId: "corr-1", auditStage: "terminal" }));

    assert.equal(fake.saves.length, 1);
    const save = fake.saves[0]!;
    assert.equal(save.bucket, "audit-bucket");
    // Name contract: <prefix>/<YYYY-MM>/<fixed-width UTC ts>-<correlationId>-<auditStage>.json.
    assert.equal(save.path, "audit/2026-08/20260818T142359123Z-corr-1-terminal.json");
    assert.deepEqual(JSON.parse(save.data) as RecruiterAuditEvent, auditEvent({ correlationId: "corr-1", auditStage: "terminal" }));
    // Create-only, non-resumable: a name collision must 412 loudly instead of overwriting a record.
    assert.deepEqual(save.options.preconditionOpts, { ifGenerationMatch: 0 });
    assert.equal(save.options.resumable, false);
    assert.equal(save.options.contentType, "application/json");
  });

  it("suffixes six random base36 chars when the event has no auditStage", async () => {
    const fake = createFakeGcsStorage();
    const sink = createGcsObjectAuditSink({
      bucket: "audit-bucket",
      prefix: "audit",
      storage: fake.storage,
      now: () => EMIT_AT,
    });

    await sink.emit(auditEvent({ correlationId: "legacy-corr" }));

    assert.equal(fake.saves.length, 1);
    assert.match(
      fake.saves[0]!.path,
      /^audit\/2026-08\/20260818T142359123Z-legacy-corr-[a-z0-9]{6}\.json$/
    );
  });

  it("partitions the month directory per emit so a long-lived sink rolls months on its own", async () => {
    const fake = createFakeGcsStorage();
    let at = new Date("2026-08-31T23:59:59.999Z");
    const sink = createGcsObjectAuditSink({
      bucket: "audit-bucket",
      prefix: "audit",
      storage: fake.storage,
      now: () => at,
    });

    await sink.emit(auditEvent({ correlationId: "aug", auditStage: "terminal" }));
    at = new Date("2026-09-01T00:00:00.000Z");
    await sink.emit(auditEvent({ correlationId: "sep", auditStage: "terminal" }));

    assert.equal(fake.saves[0]!.path, "audit/2026-08/20260831T235959999Z-aug-terminal.json");
    assert.equal(fake.saves[1]!.path, "audit/2026-09/20260901T000000000Z-sep-terminal.json");
  });

  it("normalizes the prefix and keeps hostile correlation ids from injecting name segments", async () => {
    const fake = createFakeGcsStorage();
    const sink = createGcsObjectAuditSink({
      bucket: "audit-bucket",
      prefix: "/logs/audit/",
      storage: fake.storage,
      now: () => EMIT_AT,
    });

    await sink.emit(auditEvent({ correlationId: "a/b\nc", auditStage: "start" }));

    assert.equal(fake.saves[0]!.path, "logs/audit/2026-08/20260818T142359123Z-a-b-c-start.json");
  });

  it("normalizes forgivable bucket spellings and rejects genuinely ambiguous shapes", async () => {
    // Surrounding whitespace and a gs:// scheme are operator spellings of the same bucket —
    // normalize and serve them instead of failing a deploy over punctuation.
    assert.equal(assertGcsAuditBucketShape(" audit-bucket "), "audit-bucket");
    assert.equal(assertGcsAuditBucketShape("gs://audit-bucket"), "audit-bucket");
    assert.equal(assertGcsAuditBucketShape("GS://audit-bucket"), "audit-bucket", "the scheme strip is case-insensitive");
    assert.equal(assertGcsAuditBucketShape(" gs://audit-bucket "), "audit-bucket");

    const fake = createFakeGcsStorage();
    const sink = createGcsObjectAuditSink({ bucket: "gs://audit-bucket", prefix: "audit", storage: fake.storage, now: () => EMIT_AT });
    await sink.emit(auditEvent({ correlationId: "normalized", auditStage: "terminal" }));
    assert.equal(fake.saves[0]!.bucket, "audit-bucket", "the sink serves the NORMALIZED name");

    // A slash stays a hard error — "bucket/path" is genuinely ambiguous with the prefix env — and
    // empty-after-normalize is still missing config.
    assert.throws(() => createGcsObjectAuditSink({ bucket: "", prefix: "audit", storage: fake.storage }), /bucket/i);
    assert.throws(() => createGcsObjectAuditSink({ bucket: "bucket/path", prefix: "audit", storage: fake.storage }), /path segments/);
    assert.throws(() => createGcsObjectAuditSink({ bucket: "gs://bucket/path", prefix: "audit", storage: fake.storage }), /path segments/);
    assert.throws(() => createGcsObjectAuditSink({ bucket: "gs://", prefix: "audit", storage: fake.storage }), /bucket/i);
    assert.throws(() => createGcsObjectAuditSink({ bucket: "   ", prefix: "audit", storage: fake.storage }), /bucket/i);
    assert.throws(() => createGcsObjectAuditSink({ bucket: "audit-bucket", prefix: "  ", storage: fake.storage }), /prefix/i);
    assert.throws(() => createGcsObjectAuditSink({ bucket: "audit-bucket", prefix: "/", storage: fake.storage }), /prefix/i);
  });

  it("propagates write failures raw, and as AuditUnavailableError through emitAudit", async () => {
    const fake = createFakeGcsStorage();
    fake.failSavesMatching(/./);
    const sink = createGcsObjectAuditSink({ bucket: "audit-bucket", prefix: "audit", storage: fake.storage });

    await assert.rejects(() => Promise.resolve(sink.emit(auditEvent({ correlationId: "boom" }))), /fake GCS save failure/);
    await assert.rejects(
      () => emitAudit(sink, auditEvent({ correlationId: "boom" })),
      (error: unknown) => isAuditUnavailableError(error)
    );
    assert.equal(fake.saves.length, 0);
  });

  it("fails loudly on a create-precondition collision instead of overwriting an audit record", async () => {
    const fake = createFakeGcsStorage();
    const sink = createGcsObjectAuditSink({
      bucket: "audit-bucket",
      prefix: "audit",
      storage: fake.storage,
      now: () => EMIT_AT,
    });

    await sink.emit(auditEvent({ correlationId: "dup", auditStage: "terminal" }));
    await assert.rejects(() => Promise.resolve(sink.emit(auditEvent({ correlationId: "dup", auditStage: "terminal" }))), /precondition/);
    assert.equal(fake.saves.length, 1);
  });

  it("loads the storage client lazily, once, and only on the first emit", async () => {
    const fake = createFakeGcsStorage();
    let factoryCalls = 0;
    setGcsStorageFactoryForTests(async () => {
      factoryCalls += 1;
      return fake.storage;
    });

    const first = createGcsObjectAuditSink({ bucket: "audit-bucket", prefix: "audit" });
    const second = createGcsObjectAuditSink({ bucket: "audit-bucket", prefix: "audit" });
    assert.equal(factoryCalls, 0, "constructing sinks must not load the storage client");

    await first.emit(auditEvent({ correlationId: "one" }));
    await second.emit(auditEvent({ correlationId: "two" }));

    assert.equal(factoryCalls, 1, "the process shares one storage client across sinks");
    assert.equal(fake.saves.length, 2);
  });

  it("retries client construction after a failed load instead of wedging on the rejection", async () => {
    const fake = createFakeGcsStorage();
    let factoryCalls = 0;
    setGcsStorageFactoryForTests(async () => {
      factoryCalls += 1;
      if (factoryCalls === 1) throw new Error("client load failed");
      return fake.storage;
    });
    const sink = createGcsObjectAuditSink({ bucket: "audit-bucket", prefix: "audit" });

    await assert.rejects(() => Promise.resolve(sink.emit(auditEvent({ correlationId: "first" }))), /client load failed/);
    await sink.emit(auditEvent({ correlationId: "second" }));

    assert.equal(factoryCalls, 2);
    assert.equal(fake.saves.length, 1);
  });

  it("never calls the injected storage factory when a storage instance is provided", async () => {
    const fake = createFakeGcsStorage();
    let factoryCalls = 0;
    setGcsStorageFactoryForTests(async (): Promise<GcsStorageLike> => {
      factoryCalls += 1;
      return fake.storage;
    });
    const sink = createGcsObjectAuditSink({ bucket: "audit-bucket", prefix: "audit", storage: fake.storage });

    await sink.emit(auditEvent({ correlationId: "direct" }));

    assert.equal(factoryCalls, 0);
    assert.equal(fake.saves.length, 1);
  });
});

describe("audit backend env fork", () => {
  afterEach(() => {
    setGcsStorageFactoryForTests(null);
    resetGcsAuditRuntimeStateForTests();
  });

  it("defaults to the jsonl_file backend when the backend env is unset or empty", () => {
    assert.equal(readAuditBackendFromEnv({} as NodeJS.ProcessEnv), "jsonl_file");
    assert.equal(readAuditBackendFromEnv({ GREENHOUSE_RECRUITER_AUDIT_BACKEND: "" } as NodeJS.ProcessEnv), "jsonl_file");
    assert.equal(readAuditBackendFromEnv({ GREENHOUSE_RECRUITER_AUDIT_BACKEND: "gcs_object" } as NodeJS.ProcessEnv), "gcs_object");
  });

  it("hard-fails an unrecognized or padded backend value naming the allowed values", () => {
    assert.throws(
      () => readAuditBackendFromEnv({ GREENHOUSE_RECRUITER_AUDIT_BACKEND: "s3_object" } as NodeJS.ProcessEnv),
      /jsonl_file, gcs_object/
    );
    assert.throws(
      () => readAuditBackendFromEnv({ GREENHOUSE_RECRUITER_AUDIT_BACKEND: " gcs_object" } as NodeJS.ProcessEnv),
      /jsonl_file, gcs_object/
    );
  });

  it("never silently falls back to the console sink on an invalid backend value", async () => {
    const env = { GREENHOUSE_RECRUITER_AUDIT_BACKEND: "not-a-backend" } as NodeJS.ProcessEnv;
    // Even the local no-requireRetained path must throw: an invalid value falling back to console
    // would be a silent audit-off switch.
    assert.throws(() => createAuditSinkFromEnv(env), /jsonl_file, gcs_object/);
    assert.throws(() => createAuditSinkFromEnv(env, { requireRetained: true }), /jsonl_file, gcs_object/);
    await assert.rejects(
      () => preflightRetainedAuditSinkFromEnv(env),
      (error: unknown) => isAuditUnavailableError(error)
    );
  });

  it("keeps the explicit jsonl_file backend byte-identical to today's file behavior", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-audit-backend-jsonl-"));
    const auditPath = join(dir, "audit.jsonl");
    const sink = createAuditSinkFromEnv({
      GREENHOUSE_RECRUITER_AUDIT_BACKEND: "jsonl_file",
      GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH: auditPath,
    } as NodeJS.ProcessEnv);

    await sink.emit(auditEvent({ correlationId: "explicit-jsonl" }));

    const paths = await listAuditReadPaths(auditPath);
    assert.equal(paths.length, 1);
    assert.match(paths[0]!, /audit-\d{4}-\d{2}\.jsonl$/);
    const [line] = (await readFile(paths[0]!, "utf8")).trim().split("\n");
    assert.equal((JSON.parse(line!) as RecruiterAuditEvent).correlationId, "explicit-jsonl");
    // And with no path it fails retained-required exactly like the unset default does.
    assert.throws(
      () => createAuditSinkFromEnv({ GREENHOUSE_RECRUITER_AUDIT_BACKEND: "jsonl_file" } as NodeJS.ProcessEnv, { requireRetained: true }),
      /AUDIT_JSONL_PATH/
    );
  });

  it("selects the GCS object sink for gcs_object and satisfies retained-audit requirements", async () => {
    const fake = createFakeGcsStorage();
    setGcsStorageFactoryForTests(async () => fake.storage);
    // No JSONL path, no durable mount: the GCS arm has no file paths and must not require them.
    const sink = createAuditSinkFromEnv({
      GREENHOUSE_RECRUITER_AUDIT_BACKEND: "gcs_object",
      GREENHOUSE_RECRUITER_AUDIT_GCS_BUCKET: "audit-bucket",
    } as NodeJS.ProcessEnv, { requireRetained: true });

    await sink.emit(auditEvent({ correlationId: "gcs-env", auditStage: "terminal" }));

    assert.equal(fake.saves.length, 1);
    assert.match(fake.saves[0]!.path, /^audit\/\d{4}-\d{2}\/\d{8}T\d{9}Z-gcs-env-terminal\.json$/);
    assert.equal(fake.saves[0]!.bucket, "audit-bucket");
  });

  it("hard-fails gcs_object selection without a usable bucket, normalizing forgivable spellings", () => {
    assert.throws(
      () => createAuditSinkFromEnv({ GREENHOUSE_RECRUITER_AUDIT_BACKEND: "gcs_object" } as NodeJS.ProcessEnv),
      /GREENHOUSE_RECRUITER_AUDIT_GCS_BUCKET is required/
    );
    // A gs:// spelling of the bucket env is normalized to the bare name, not rejected…
    assert.deepEqual(
      buildGcsAuditConfigFromEnv({
        GREENHOUSE_RECRUITER_AUDIT_BACKEND: "gcs_object",
        GREENHOUSE_RECRUITER_AUDIT_GCS_BUCKET: "gs://audit-bucket",
      } as NodeJS.ProcessEnv),
      { bucket: "audit-bucket", prefix: "audit" }
    );
    // …while a path segment stays a hard failure (ambiguous with the prefix env).
    assert.throws(
      () => createAuditSinkFromEnv({
        GREENHOUSE_RECRUITER_AUDIT_BACKEND: "gcs_object",
        GREENHOUSE_RECRUITER_AUDIT_GCS_BUCKET: "audit-bucket/audit",
      } as NodeJS.ProcessEnv),
      /path segments/
    );
  });

  it("builds the GCS target from env with a normalized prefix defaulting to audit", () => {
    const base = { GREENHOUSE_RECRUITER_AUDIT_BACKEND: "gcs_object", GREENHOUSE_RECRUITER_AUDIT_GCS_BUCKET: "audit-bucket" };
    assert.deepEqual(
      buildGcsAuditConfigFromEnv({ ...base } as NodeJS.ProcessEnv),
      { bucket: "audit-bucket", prefix: "audit" }
    );
    assert.deepEqual(
      buildGcsAuditConfigFromEnv({ ...base, GREENHOUSE_RECRUITER_AUDIT_GCS_PREFIX: "/logs/audit/" } as NodeJS.ProcessEnv),
      { bucket: "audit-bucket", prefix: "logs/audit" }
    );
    // Explicit empty string keeps the default (repo convention: FOO= in an env file means unset)…
    assert.deepEqual(
      buildGcsAuditConfigFromEnv({ ...base, GREENHOUSE_RECRUITER_AUDIT_GCS_PREFIX: "" } as NodeJS.ProcessEnv),
      { bucket: "audit-bucket", prefix: "audit" }
    );
    // …but a whitespace-only or slash-only prefix is a loud misconfiguration.
    assert.throws(
      () => buildGcsAuditConfigFromEnv({ ...base, GREENHOUSE_RECRUITER_AUDIT_GCS_PREFIX: "  " } as NodeJS.ProcessEnv),
      /non-empty object prefix/
    );
    assert.throws(
      () => buildGcsAuditConfigFromEnv({ ...base, GREENHOUSE_RECRUITER_AUDIT_GCS_PREFIX: "/" } as NodeJS.ProcessEnv),
      /non-empty object prefix/
    );
  });
});

describe("GCS audit preflight probe", () => {
  afterEach(() => {
    setGcsStorageFactoryForTests(null);
    resetGcsAuditRuntimeStateForTests();
  });

  const gcsEnv = {
    GREENHOUSE_RECRUITER_AUDIT_BACKEND: "gcs_object",
    GREENHOUSE_RECRUITER_AUDIT_GCS_BUCKET: "audit-bucket",
  } as NodeJS.ProcessEnv;

  it("performs a real create-only probe write under .probe/ and best-effort deletes it", async () => {
    const fake = createFakeGcsStorage();
    setGcsStorageFactoryForTests(async () => fake.storage);

    const sink = await preflightRetainedAuditSinkFromEnv(gcsEnv);

    assert.equal(fake.saves.length, 1);
    const probe = fake.saves[0]!;
    assert.match(probe.path, /^audit\/\.probe\/\d{8}T\d{9}Z-[a-z0-9]{6}\.json$/);
    assert.deepEqual(probe.options.preconditionOpts, { ifGenerationMatch: 0 });
    assert.equal(probe.options.resumable, false);
    assert.deepEqual(fake.deletes, [probe.path]);
    assert.equal(fake.objects.size, 0, "the probe object must not linger");

    // The returned sink is live: an emit writes a real event object.
    await sink.emit(auditEvent({ correlationId: "post-preflight", auditStage: "terminal" }));
    assert.match(fake.saves[1]!.path, /^audit\/\d{4}-\d{2}\//);
  });

  it("fails the preflight as AuditUnavailableError when the probe write fails", async () => {
    const fake = createFakeGcsStorage();
    fake.failSavesMatching(/\.probe\//);
    setGcsStorageFactoryForTests(async () => fake.storage);

    await assert.rejects(
      () => preflightRetainedAuditSinkFromEnv(gcsEnv),
      (error: unknown) => isAuditUnavailableError(error)
    );
  });

  it("treats a failed probe cleanup as non-fatal with a name-only stderr note", async () => {
    const fake = createFakeGcsStorage();
    fake.failDeletesMatching(/\.probe\//);
    setGcsStorageFactoryForTests(async () => fake.storage);
    const originalError = console.error;
    const logs: string[] = [];
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      const sink = await preflightRetainedAuditSinkFromEnv(gcsEnv);
      assert.ok(sink, "writability is what is gated; cleanup failure must not block serving");
    } finally {
      console.error = originalError;
    }
    const logText = logs.join("\n");
    assert.match(logText, /\[greenhouse-recruiter-mcp\] audit gcs probe cleanup failed error_name=/);
    assert.doesNotMatch(logText, /fake GCS delete failure/, "stderr note is name-only, never message content");
  });

  it("memoizes probe success per bucket+prefix for the process lifetime", async () => {
    const fake = createFakeGcsStorage();
    setGcsStorageFactoryForTests(async () => fake.storage);

    await preflightGcsObjectAuditSinkFromEnv(gcsEnv);
    for (let request = 0; request < 25; request += 1) {
      await preflightGcsObjectAuditSinkFromEnv(gcsEnv);
    }
    assert.equal(fake.saves.length, 1, "a success verdict holds for the life of the process — no re-probe per request");

    // A different target has its own verdict.
    await preflightGcsObjectAuditSinkFromEnv({
      ...gcsEnv,
      GREENHOUSE_RECRUITER_AUDIT_GCS_PREFIX: "other",
    } as NodeJS.ProcessEnv);
    assert.equal(fake.saves.length, 2);
  });

  it("clears the process-lifetime probe memo through the test reset seam", async () => {
    const fake = createFakeGcsStorage();
    setGcsStorageFactoryForTests(async () => fake.storage);

    await preflightGcsObjectAuditSinkFromEnv(gcsEnv);
    assert.equal(fake.saves.length, 1);

    resetGcsAuditRuntimeStateForTests();
    // The reset clears the memo and the shared client; the injected factory stays in place.
    await preflightGcsObjectAuditSinkFromEnv(gcsEnv);
    assert.equal(fake.saves.length, 2, "the reset seam clears the memo (the cold-start analogue)");
  });

  it("never memoizes probe failure: every request retries a failing probe", async () => {
    const fake = createFakeGcsStorage();
    fake.failSavesMatching(/\.probe\//);
    setGcsStorageFactoryForTests(async () => fake.storage);

    await assert.rejects(() => preflightGcsObjectAuditSinkFromEnv(gcsEnv));
    await assert.rejects(() => preflightGcsObjectAuditSinkFromEnv(gcsEnv));

    fake.failSavesMatching(null);
    await preflightGcsObjectAuditSinkFromEnv(gcsEnv);
    assert.equal(fake.saves.length, 1, "recovery succeeds immediately once the store is writable");
    assert.equal(fake.deletes.length, 1);
  });
});

describe("GCS audit reader", () => {
  afterEach(() => {
    setGcsStorageFactoryForTests(null);
    resetGcsAuditRuntimeStateForTests();
  });

  it("reads all event objects chronologically and excludes probe artifacts", async () => {
    const fake = createFakeGcsStorage();
    fake.seedObject("audit/2026-07/20260715T120000000Z-b-terminal.json", '{"n":2}');
    fake.seedObject("audit/2026-06/20260601T000000000Z-a-terminal.json", '{"n":1}');
    fake.seedObject("audit/.probe/20260716T000000000Z-zzzzzz.json", "{}");
    fake.seedObject("audit/2026-08/20260801T000000000Z-c-start.json", '{"n":3}');

    const { text, paths } = await readGcsAuditEvents(fake.storage, "audit-bucket", "audit");

    assert.deepEqual(paths, [
      "audit/2026-06/20260601T000000000Z-a-terminal.json",
      "audit/2026-07/20260715T120000000Z-b-terminal.json",
      "audit/2026-08/20260801T000000000Z-c-start.json",
    ]);
    assert.equal(text, '{"n":1}\n{"n":2}\n{"n":3}\n');
    // An unwindowed read is one listing over the whole prefix.
    assert.deepEqual(fake.listPrefixes, ["audit/"]);
  });

  it("narrows a windowed read to intersecting month dirs and never fetches out-of-window objects", async () => {
    const fake = createFakeGcsStorage();
    fake.seedObject("audit/2026-06/20260615T000000000Z-june-early-terminal.json", '{"n":"june-early"}');
    fake.seedObject("audit/2026-06/20260625T000000000Z-june-late-terminal.json", '{"n":"june-late"}');
    fake.seedObject("audit/2026-07/20260710T000000000Z-july-in-terminal.json", '{"n":"july-in"}');
    fake.seedObject("audit/2026-07/20260725T000000000Z-july-out-terminal.json", '{"n":"july-out"}');
    fake.seedObject("audit/2026-08/20260801T000000000Z-august-terminal.json", '{"n":"august"}');

    const { text, paths } = await readGcsAuditEvents(fake.storage, "audit-bucket", "audit", {
      fromMs: Date.parse("2026-06-20T00:00:00.000Z"),
      toMs: Date.parse("2026-07-20T00:00:00.000Z"),
    });

    // Only the months intersecting the window are listed — August is never even listed.
    assert.deepEqual(fake.listPrefixes, ["audit/2026-06/", "audit/2026-07/"]);
    // Listed-but-out-of-window objects are skipped by name timestamp without being fetched.
    assert.deepEqual(fake.downloads, [
      "audit/2026-06/20260625T000000000Z-june-late-terminal.json",
      "audit/2026-07/20260710T000000000Z-july-in-terminal.json",
    ]);
    assert.deepEqual(paths, [
      "audit/2026-06/20260625T000000000Z-june-late-terminal.json",
      "audit/2026-07/20260710T000000000Z-july-in-terminal.json",
    ]);
    assert.equal(text, '{"n":"june-late"}\n{"n":"july-in"}\n');
  });

  it("tiles consecutive windows half-open: a boundary-stamped object is fetched by exactly one", async () => {
    const fake = createFakeGcsStorage();
    const boundary = Date.parse("2026-07-15T00:00:00.000Z");
    fake.seedObject("audit/2026-07/20260715T000000000Z-boundary-terminal.json", '{"n":"boundary"}');

    const earlier = await readGcsAuditEvents(fake.storage, "audit-bucket", "audit", {
      fromMs: boundary - 60_000,
      toMs: boundary,
    });
    const later = await readGcsAuditEvents(fake.storage, "audit-bucket", "audit", {
      fromMs: boundary,
      toMs: boundary + 60_000,
    });

    assert.deepEqual(earlier.paths, [], "an object stamped exactly at toMs belongs to the NEXT window");
    assert.deepEqual(later.paths, ["audit/2026-07/20260715T000000000Z-boundary-terminal.json"]);
  });

  it("includes an unparsable object name in unwindowed reads but excludes it from windowed reads", async () => {
    const fake = createFakeGcsStorage();
    fake.seedObject("audit/2026-07/manual-export.json", '{"n":"manual"}');
    fake.seedObject("audit/2026-07/20260710T000000000Z-july-terminal.json", '{"n":"july"}');

    // Unwindowed (the full review): completeness wins — the unparsable name is read, not dropped.
    const unwindowed = await readGcsAuditEvents(fake.storage, "audit-bucket", "audit");
    assert.deepEqual(unwindowed.paths, [
      "audit/2026-07/20260710T000000000Z-july-terminal.json",
      "audit/2026-07/manual-export.json",
    ]);

    // Windowed (the periodic tick): a name that cannot be placed in any window is excluded —
    // including it would refetch the same junk object on every tick forever.
    const windowed = await readGcsAuditEvents(fake.storage, "audit-bucket", "audit", {
      fromMs: Date.parse("2026-07-01T00:00:00.000Z"),
      toMs: Date.parse("2026-07-31T00:00:00.000Z"),
    });
    assert.deepEqual(windowed.paths, ["audit/2026-07/20260710T000000000Z-july-terminal.json"]);
    assert.equal(windowed.text, '{"n":"july"}\n');
  });

  it("returns an empty read for an empty store so callers can fail closed on it", async () => {
    const fake = createFakeGcsStorage();
    const { text, paths } = await readGcsAuditEvents(fake.storage, "audit-bucket", "audit");
    assert.equal(text, "");
    assert.deepEqual(paths, []);
  });

  it("narrows a from-only window to month dirs from the bound through the injected now", async () => {
    const fake = createFakeGcsStorage();
    fake.seedObject("audit/2026-05/20260515T000000000Z-may-terminal.json", '{"n":"may"}');
    fake.seedObject("audit/2026-06/20260625T000000000Z-june-terminal.json", '{"n":"june"}');
    fake.seedObject("audit/2026-07/20260710T000000000Z-july-terminal.json", '{"n":"july"}');
    fake.seedObject("audit/2026-08/20260801T000000000Z-august-terminal.json", '{"n":"august"}');

    const { paths } = await readGcsAuditEvents(
      fake.storage,
      "audit-bucket",
      "audit",
      { fromMs: Date.parse("2026-06-20T00:00:00.000Z") },
      { now: () => Date.parse("2026-07-15T00:00:00.000Z") }
    );

    // A lower bound alone narrows: absent toMs means "through now", so only the months from the
    // bound through the injected clock are listed — never the whole prefix.
    assert.deepEqual(fake.listPrefixes, ["audit/2026-06/", "audit/2026-07/"]);
    assert.deepEqual(paths, [
      "audit/2026-06/20260625T000000000Z-june-terminal.json",
      "audit/2026-07/20260710T000000000Z-july-terminal.json",
    ]);
  });

  it("keeps full-prefix listing for a to-only window while still applying the bound", async () => {
    const fake = createFakeGcsStorage();
    fake.seedObject("audit/2026-06/20260625T000000000Z-june-terminal.json", '{"n":"june"}');
    fake.seedObject("audit/2026-07/20260710T000000000Z-july-terminal.json", '{"n":"july"}');

    const { paths } = await readGcsAuditEvents(fake.storage, "audit-bucket", "audit", {
      toMs: Date.parse("2026-07-01T00:00:00.000Z"),
    });

    assert.deepEqual(fake.listPrefixes, ["audit/"], "no lower bound: the whole prefix may be listed");
    assert.deepEqual(paths, ["audit/2026-06/20260625T000000000Z-june-terminal.json"]);
  });

  it("downloads with a worker pool capped at 16 in flight while preserving chronological output", async () => {
    const names = Array.from({ length: 40 }, (_, index) =>
      `audit/2026-07/20260701T00${String(index).padStart(2, "0")}00000Z-c${index}-terminal.json`);
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseAll!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const storage: GcsStorageLike = {
      bucket: () => ({
        file() {
          throw new Error("unused in this test");
        },
        getFiles: async () => [
          names.map((name) => ({
            name,
            async save(): Promise<unknown> {
              throw new Error("unused in this test");
            },
            async delete(): Promise<unknown> {
              throw new Error("unused in this test");
            },
            async download(): Promise<[Buffer]> {
              inFlight += 1;
              maxInFlight = Math.max(maxInFlight, inFlight);
              await gate;
              inFlight -= 1;
              return [Buffer.from(JSON.stringify({ n: name }), "utf8")];
            },
          })),
        ],
      }),
    };

    const pending = readGcsAuditEvents(storage, "audit-bucket", "audit");
    try {
      // With every download blocked on the gate, admission must climb to the pool cap and stop.
      for (let attempt = 0; attempt < 500 && inFlight < 16; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      assert.equal(inFlight, 16, "the pool must saturate at 16 concurrent downloads over 40 pending objects");
    } finally {
      releaseAll();
    }
    const { text, paths } = await pending;
    assert.equal(maxInFlight, 16, "no more than 16 downloads may ever be in flight");
    assert.deepEqual(paths, names, "output order stays chronological by name");
    assert.equal(text, `${names.map((name) => JSON.stringify({ n: name })).join("\n")}\n`);
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
