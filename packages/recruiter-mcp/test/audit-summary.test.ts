import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAuditSummary, formatAuditSummarySlackText, maybeStartAuditSummaryTimer, readAuditSummaryConfig, runAuditSummaryTickOnce } from "../src/audit-summary.js";
import { gcsAuditMonthDir, gcsAuditObjectTimestamp, setGcsStorageFactoryForTests } from "../src/audit-gcs.js";
import { createFakeGcsStorage } from "./fake-gcs-storage.js";

const NOW = Date.parse("2026-07-01T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function jsonl(events: Array<Record<string, unknown>>): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

describe("audit health summary (O5 — service health, not recruiting analytics)", () => {
  it("aggregates calls, denial mix, and per-actor counts within the window", () => {
    const text = jsonl([
      { at: "2026-07-01T10:00:00.000Z", actorGreenhouseUserId: 900, toolName: "search_my_applications" },
      { at: "2026-07-01T10:05:00.000Z", actorGreenhouseUserId: 900, denialCode: "RATE_LIMITED" },
      { at: "2026-07-01T11:00:00.000Z", actorGreenhouseUserId: 901, denialCode: "UPSTREAM_ERROR" },
      { at: "2026-06-01T00:00:00.000Z", actorGreenhouseUserId: 999, denialCode: "UPSTREAM_ERROR" }, // outside window
    ]);
    const summary = buildAuditSummary(text, NOW - DAY, NOW);

    assert.equal(summary.totalEvents, 3, "the month-old event is outside the window");
    assert.equal(summary.successEvents, 1);
    assert.equal(summary.denialEvents, 2);
    assert.deepEqual(summary.denialsByCode, { RATE_LIMITED: 1, UPSTREAM_ERROR: 1 });
    assert.equal(summary.eventsByActor["900"], 2);
    assert.equal(summary.rateLimitedEvents, 1);
    assert.equal(summary.upstreamErrorEvents, 1);
  });

  it("tiles consecutive ticks half-open: a boundary event lands in exactly one window", () => {
    const boundary = NOW; // an event stamped exactly at a tick instant
    const text = jsonl([{ at: new Date(boundary).toISOString(), actorGreenhouseUserId: 900 }]);

    const earlier = buildAuditSummary(text, boundary - DAY, boundary); // [T-i, T)
    const later = buildAuditSummary(text, boundary, boundary + DAY); // [T, T+i)

    assert.equal(earlier.totalEvents, 0, "the window is half-open — an event at exactly toMs belongs to the NEXT tick");
    assert.equal(later.totalEvents, 1);
    assert.equal(earlier.totalEvents + later.totalEvents, 1, "consecutive ticks must never double-count a boundary event");
  });

  it("never throws on torn/garbage lines (a partial trailing write must not kill telemetry)", () => {
    const text = '{"at":"2026-07-01T10:00:00.000Z","actorGreenhouseUserId":900}\n{"at":"2026-07-01T10:0';
    const summary = buildAuditSummary(text, NOW - DAY, NOW);
    assert.equal(summary.totalEvents, 1);
  });

  it("keeps undated legacy rows out of recent windows and counts v2 terminal calls only", () => {
    const text = jsonl([
      { actorGreenhouseUserId: 899, denialCode: null },
      { schemaVersion: 2, auditStage: "start", at: "2026-07-01T10:00:00.000Z", actorGreenhouseUserId: null },
      { schemaVersion: 2, auditStage: "terminal", at: "2026-07-01T10:00:01.000Z", actorGreenhouseUserId: 900, denialCode: null },
    ]);

    const summary = buildAuditSummary(text, NOW - DAY, NOW);

    assert.equal(summary.totalEvents, 1);
    assert.equal(summary.successEvents, 1);
    assert.equal(summary.undatedLegacyEvents, 1);
  });

  it("formats a Slack line with denial mix and warning flags", () => {
    const text = jsonl([{ at: "2026-07-01T10:00:00.000Z", actorGreenhouseUserId: 900, denialCode: "UPSTREAM_ERROR" }]);
    const line = formatAuditSummarySlackText(buildAuditSummary(text, NOW - DAY, NOW));
    assert.match(line, /Greenhouse MCP health/);
    assert.match(line, /UPSTREAM_ERROR: 1/);
    assert.match(line, /upstream errors: 1/);
  });

  it("names the reviewed store in the digest headline (two-store coexistence)", () => {
    const text = jsonl([{ at: "2026-07-01T10:00:00.000Z", actorGreenhouseUserId: 900 }]);
    const summary = buildAuditSummary(text, NOW - DAY, NOW);

    const fileLine = formatAuditSummarySlackText(summary, "jsonl:audit.jsonl");
    assert.match(fileLine, /Greenhouse MCP health \(.+\) — store: jsonl:audit\.jsonl/);

    const gcsLine = formatAuditSummarySlackText(summary, "gcs:audit-bucket/audit");
    assert.match(gcsLine, /— store: gcs:audit-bucket\/audit/);
  });

  it("logs a name-only dormant note when invalid backend config keeps the summary timer off", () => {
    const originalError = console.error;
    const logs: string[] = [];
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      const config = readAuditSummaryConfig({
        GREENHOUSE_RECRUITER_AUDIT_SUMMARY_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/x",
        GREENHOUSE_RECRUITER_AUDIT_BACKEND: "not-a-backend",
        GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH: "/app/audit/audit.jsonl",
      } as NodeJS.ProcessEnv);
      assert.equal(config.jsonlPath, null);
      assert.equal(config.gcs, null);
    } finally {
      console.error = originalError;
    }
    const logText = logs.join("\n");
    assert.match(logText, /audit summary timer dormant/, "silent dormancy is the bug: the skipped timer must announce itself");
    assert.match(logText, /error_name=Error/);
    assert.doesNotMatch(logText, /not-a-backend|jsonl_file, gcs_object/, "name only — never the message or config values");
  });

  it("stays DORMANT without the webhook env (never starts a timer by default)", () => {
    assert.equal(maybeStartAuditSummaryTimer({} as NodeJS.ProcessEnv), null);
    assert.equal(
      maybeStartAuditSummaryTimer({ GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH: "/app/audit/audit.jsonl" } as NodeJS.ProcessEnv),
      null,
      "a JSONL path alone must not activate the timer"
    );
    // Non-HTTPS webhook is rejected by config, so the timer stays off.
    assert.equal(readAuditSummaryConfig({ GREENHOUSE_RECRUITER_AUDIT_SUMMARY_WEBHOOK_URL: "http://x" } as NodeJS.ProcessEnv).webhookUrl, null);
  });

  it("starts (and stops) the timer when webhook + path are both configured", () => {
    const timer = maybeStartAuditSummaryTimer({
      GREENHOUSE_RECRUITER_AUDIT_SUMMARY_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/x",
      GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH: "/app/audit/audit.jsonl",
      GREENHOUSE_RECRUITER_AUDIT_SUMMARY_INTERVAL_MS: "60000",
    } as NodeJS.ProcessEnv);
    assert.notEqual(timer, null);
    if (timer) clearInterval(timer);
  });
});

describe("audit health summary over the GCS object backend", () => {
  afterEach(() => {
    setGcsStorageFactoryForTests(null);
  });

  it("activates on webhook + fully configured gcs backend, ignoring the jsonl path", () => {
    const env = {
      GREENHOUSE_RECRUITER_AUDIT_SUMMARY_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/x",
      GREENHOUSE_RECRUITER_AUDIT_BACKEND: "gcs_object",
      GREENHOUSE_RECRUITER_AUDIT_GCS_BUCKET: "audit-bucket",
      // Present but IGNORED on the gcs arm — the backend has no file paths.
      GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH: "/app/audit/audit.jsonl",
      GREENHOUSE_RECRUITER_AUDIT_SUMMARY_INTERVAL_MS: "60000",
    } as NodeJS.ProcessEnv;
    const config = readAuditSummaryConfig(env);
    assert.deepEqual(config.gcs, { bucket: "audit-bucket", prefix: "audit" });
    assert.equal(config.jsonlPath, null);

    const timer = maybeStartAuditSummaryTimer(env);
    assert.notEqual(timer, null, "webhook + gcs config must activate the timer without a jsonl path");
    if (timer) clearInterval(timer);
  });

  it("stays dormant when the gcs backend is selected but incomplete, or the backend is invalid", () => {
    assert.equal(
      maybeStartAuditSummaryTimer({
        GREENHOUSE_RECRUITER_AUDIT_SUMMARY_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/x",
        GREENHOUSE_RECRUITER_AUDIT_BACKEND: "gcs_object",
      } as NodeJS.ProcessEnv),
      null,
      "a bucketless gcs selection must not start telemetry"
    );
    assert.equal(
      maybeStartAuditSummaryTimer({
        GREENHOUSE_RECRUITER_AUDIT_SUMMARY_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/x",
        GREENHOUSE_RECRUITER_AUDIT_BACKEND: "not-a-backend",
        GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH: "/app/audit/audit.jsonl",
      } as NodeJS.ProcessEnv),
      null,
      "an invalid backend must not fall back to the file arm"
    );
  });

  it("posts a summary built from a windowed gcs read on each tick", async () => {
    const fake = createFakeGcsStorage();
    setGcsStorageFactoryForTests(async () => fake.storage);
    // The tick is driven DIRECTLY (runAuditSummaryTickOnce) with a fixed clock: the real interval
    // timer is unref'd, so a test awaiting a genuine tick deadlocks whenever nothing else keeps the
    // event loop alive (the CI-only cancellation this test shipped with). Window = [now-1500, now),
    // half-open; the fresh event sits mid-window, the stale one in a month the read must never list.
    const tickNowMs = Date.parse("2026-08-19T12:00:00.000Z");
    const freshAt = new Date(tickNowMs - 750);
    fake.seedObject(
      `audit/${gcsAuditMonthDir(freshAt)}/${gcsAuditObjectTimestamp(freshAt)}-fresh-1-terminal.json`,
      JSON.stringify({ at: freshAt.toISOString(), actorGreenhouseUserId: 900, denialCode: null })
    );
    fake.seedObject(
      "audit/2020-01/20200101T000000000Z-stale-1-terminal.json",
      JSON.stringify({ at: "2020-01-01T00:00:00.000Z", actorGreenhouseUserId: 901, denialCode: null })
    );

    const env = {
      GREENHOUSE_RECRUITER_AUDIT_SUMMARY_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/x",
      GREENHOUSE_RECRUITER_AUDIT_BACKEND: "gcs_object",
      GREENHOUSE_RECRUITER_AUDIT_GCS_BUCKET: "audit-bucket",
      GREENHOUSE_RECRUITER_AUDIT_SUMMARY_INTERVAL_MS: "1500",
    } as NodeJS.ProcessEnv;
    const originalFetch = globalThis.fetch;
    const postedBodies: string[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      postedBodies.push(String(init?.body ?? ""));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      // The timer arms on this config (liveness); the tick itself is exercised by direct call.
      const timer = maybeStartAuditSummaryTimer(env);
      assert.notEqual(timer, null);
      if (timer) clearInterval(timer);

      await runAuditSummaryTickOnce(readAuditSummaryConfig(env), tickNowMs);
      assert.equal(postedBodies.length, 1, "one tick posts exactly one digest");
      const body = postedBodies[0]!;
      assert.match(body, /Greenhouse MCP health/);
      assert.match(body, /store: gcs:audit-bucket\/audit/, "the digest names the store it summarized");
      assert.match(body, /calls: 1 \(1 ok \/ 0 denied\)/, "only the in-window event is summarized");
      // The read is month-narrowed: every listing is a month dir, and the stale month is never
      // listed or fetched.
      assert.ok(fake.listPrefixes.length > 0);
      assert.ok(
        fake.listPrefixes.every((prefix) => /^audit\/\d{4}-\d{2}\/$/.test(prefix)),
        `windowed listings must target month dirs, got ${JSON.stringify(fake.listPrefixes)}`
      );
      assert.equal(fake.listPrefixes.includes("audit/2020-01/"), false);
      assert.equal(fake.downloads.some((path) => path.includes("stale-1")), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
