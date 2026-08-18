import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAuditSummary, formatAuditSummarySlackText, maybeStartAuditSummaryTimer, readAuditSummaryConfig } from "../src/audit-summary.js";

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
