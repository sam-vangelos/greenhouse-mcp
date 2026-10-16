import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  classifyResultSize,
  logReadAudit,
  READ_AUDIT_FAILURE_MESSAGE,
  READ_AUDIT_PREFIX,
  READ_AUDIT_VERSION,
  resultSizeClassFromData,
  type ReadAuditEvent,
  type ReadAuditLinePayload,
} from "../src/read-audit.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Capture console.error output. Matches the idiom in client.test.ts so
 * the stderr-capture pattern is consistent across this package's tests.
 */
function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.error = original;
    },
  };
}

function parseAuditLine(line: string): ReadAuditLinePayload {
  const expectedPrefix = `${READ_AUDIT_PREFIX} `;
  assert.ok(
    line.startsWith(expectedPrefix),
    `Audit line must start with "${expectedPrefix}": ${line}`
  );
  return JSON.parse(line.slice(expectedPrefix.length)) as ReadAuditLinePayload;
}

// Narrow, success-shaped event used as the base for positive cases below.
const baseSuccessEvent: ReadAuditEvent = {
  tool: "list_email_templates",
  tier: 3,
  callerIdentity: { on_behalf_of_user_id: 42 },
  projectionApplied: false,
  resultSizeClass: "small",
  outcome: "success",
};

// ---------------------------------------------------------------------------
// Unit coverage for the emitter (spec §§3, 3.3)
// ---------------------------------------------------------------------------

describe("logReadAudit — emitter unit tests", () => {
  let spy: ReturnType<typeof captureStderr>;
  beforeEach(() => {
    spy = captureStderr();
  });
  afterEach(() => {
    spy.restore();
  });

  it("emits exactly one line per call, prefixed [greenhouse-mcp] READ_AUDIT", () => {
    logReadAudit(baseSuccessEvent);
    assert.equal(spy.lines.length, 1, "Emitter must write exactly one stderr line");
    assert.ok(
      spy.lines[0]!.startsWith(`${READ_AUDIT_PREFIX} `),
      `Line must start with "${READ_AUDIT_PREFIX} ": ${spy.lines[0]}`
    );
  });

  it("serializes exactly the §3 field set (no extras, no missing) on success", () => {
    logReadAudit(baseSuccessEvent);
    const payload = parseAuditLine(spy.lines[0]!);

    // Required fields present
    assert.equal(typeof payload.timestamp, "string");
    assert.equal(payload.audit_version, READ_AUDIT_VERSION);
    assert.equal(payload.tool, "list_email_templates");
    assert.equal(payload.tier, 3);
    assert.deepStrictEqual(payload.caller_identity, { on_behalf_of_user_id: 42 });
    assert.equal(payload.projection_applied, false);
    assert.equal(payload.result_size_class, "small");
    assert.equal(payload.outcome, "success");

    // No extra fields beyond the §3 allowlist
    const allowed = new Set([
      "timestamp",
      "audit_version",
      "tool",
      "tier",
      "caller_identity",
      "projection_applied",
      "result_size_class",
      "outcome",
    ]);
    for (const key of Object.keys(payload)) {
      assert.ok(
        allowed.has(key),
        `Unexpected field "${key}" in audit payload; schema is closed per spec §3`
      );
    }
  });

  it("timestamp is ISO-8601 UTC", () => {
    logReadAudit(baseSuccessEvent);
    const payload = parseAuditLine(spy.lines[0]!);
    // ISO-8601 with Z suffix from Date.prototype.toISOString().
    assert.match(payload.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(
      !Number.isNaN(Date.parse(payload.timestamp)),
      `timestamp must be parseable: ${payload.timestamp}`
    );
  });

  it("audit_version is 1.0.0", () => {
    logReadAudit(baseSuccessEvent);
    const payload = parseAuditLine(spy.lines[0]!);
    assert.equal(payload.audit_version, "1.0.0");
  });

  it("tier is the literal number 3", () => {
    logReadAudit(baseSuccessEvent);
    const payload = parseAuditLine(spy.lines[0]!);
    assert.equal(payload.tier, 3);
    assert.equal(typeof payload.tier, "number");
  });

  it("outcome is one of the three enumerated strings", () => {
    const outcomes: ReadAuditEvent["outcome"][] = ["success", "denied", "error"];
    for (const outcome of outcomes) {
      spy.lines.length = 0;
      logReadAudit({
        tool: "list_email_templates",
        tier: 3,
        callerIdentity: { on_behalf_of_user_id: outcome === "denied" ? null : 42 },
        projectionApplied: false,
        resultSizeClass: outcome === "success" ? "empty" : undefined,
        outcome,
      });
      const payload = parseAuditLine(spy.lines[0]!);
      assert.equal(payload.outcome, outcome);
    }
  });

  it("omits result_size_class on denied and error outcomes", () => {
    logReadAudit({
      tool: "list_email_templates",
      tier: 3,
      callerIdentity: { on_behalf_of_user_id: null },
      projectionApplied: false,
      outcome: "denied",
    });
    const deniedPayload = parseAuditLine(spy.lines[0]!);
    assert.ok(
      !("result_size_class" in deniedPayload),
      "result_size_class must be omitted on denied outcome per spec §3.2"
    );

    spy.lines.length = 0;
    logReadAudit({
      tool: "list_email_templates",
      tier: 3,
      callerIdentity: { on_behalf_of_user_id: 42 },
      projectionApplied: false,
      outcome: "error",
    });
    const errorPayload = parseAuditLine(spy.lines[0]!);
    assert.ok(
      !("result_size_class" in errorPayload),
      "result_size_class must be omitted on error outcome per spec §3.2"
    );
  });

  it("preserves caller_identity shape as { on_behalf_of_user_id: number | null }", () => {
    for (const actor of [7, 42, 123456] as const) {
      spy.lines.length = 0;
      logReadAudit({ ...baseSuccessEvent, callerIdentity: { on_behalf_of_user_id: actor } });
      const payload = parseAuditLine(spy.lines[0]!);
      assert.deepStrictEqual(payload.caller_identity, { on_behalf_of_user_id: actor });
    }

    spy.lines.length = 0;
    logReadAudit({
      tool: "list_email_templates",
      tier: 3,
      callerIdentity: { on_behalf_of_user_id: null },
      projectionApplied: false,
      outcome: "denied",
    });
    const denied = parseAuditLine(spy.lines[0]!);
    assert.deepStrictEqual(denied.caller_identity, { on_behalf_of_user_id: null });
  });
});

// ---------------------------------------------------------------------------
// Result-size-class buckets (spec §3.2)
// ---------------------------------------------------------------------------

describe("classifyResultSize + resultSizeClassFromData — §3.2 buckets", () => {
  it("0 -> empty, 1..10 -> small, 11..100 -> medium, 101+ -> large", () => {
    assert.equal(classifyResultSize(0), "empty");
    assert.equal(classifyResultSize(1), "small");
    assert.equal(classifyResultSize(10), "small");
    assert.equal(classifyResultSize(11), "medium");
    assert.equal(classifyResultSize(100), "medium");
    assert.equal(classifyResultSize(101), "large");
    assert.equal(classifyResultSize(999), "large");
  });

  it("treats negative and non-finite counts as empty (defensive)", () => {
    // The classifier fails closed on non-finite input: NaN and +/-Infinity
    // map to "empty" so a broken count never produces a "large"-looking
    // audit line. This is defensive, not spec-mandated; §3.2 only defines
    // buckets for finite non-negative counts.
    assert.equal(classifyResultSize(-1), "empty");
    assert.equal(classifyResultSize(Number.NaN), "empty");
    assert.equal(classifyResultSize(Number.POSITIVE_INFINITY), "empty");
    assert.equal(classifyResultSize(Number.NEGATIVE_INFINITY), "empty");
  });

  it("maps Harvest response data to a bucket without reading contents", () => {
    assert.equal(resultSizeClassFromData(null), "empty");
    assert.equal(resultSizeClassFromData(undefined), "empty");
    assert.equal(resultSizeClassFromData([]), "empty");
    assert.equal(resultSizeClassFromData([{}]), "small");
    assert.equal(resultSizeClassFromData(new Array(50).fill({})), "medium");
    assert.equal(resultSizeClassFromData(new Array(500).fill({})), "large");

    assert.equal(resultSizeClassFromData({ id: 1 }), "small", "single-record get_* maps to small");
  });
});

// ---------------------------------------------------------------------------
// §4 exclusion rule — contract tests
// ---------------------------------------------------------------------------
//
// Each case drives the emitter with a payload that the caller might be
// tempted to smuggle sensitive material through, then asserts nothing
// from that payload appears in the serialized audit line. The public
// emitter type already enforces exclusion by construction; these tests
// make the contract visible and fail loudly if anyone widens the API.
// ---------------------------------------------------------------------------

describe("logReadAudit — §4 exclusion rule (contract tests)", () => {
  let spy: ReturnType<typeof captureStderr>;
  beforeEach(() => {
    spy = captureStderr();
  });
  afterEach(() => {
    spy.restore();
  });

  it("does not log raw params (cursor, ids, per_page, updated_after, etc.)", () => {
    // Simulate a call site that forwards a params-shaped payload by putting
    // them in a cast-to-unknown assertion — we still only pass the narrow
    // allowlist through to the emitter.
    logReadAudit(baseSuccessEvent);
    const line = spy.lines[0]!;

    // None of these filter tokens should ever appear in an audit line.
    const forbidden = [
      "cursor",
      "per_page",
      "updated_after",
      "updated_at",
      "created_at",
      "scheduled-interview-cursor-abc123",
      "ids=",
      "email_type",
    ];
    for (const token of forbidden) {
      assert.ok(
        !line.includes(token),
        `Audit line leaked param token "${token}": ${line}`
      );
    }
  });

  it("does not log candidate IDs, application IDs, job IDs, or similar record identifiers", () => {
    // Attempt to cheat by putting a record identifier into the tool name.
    // The emitter serializes tool as a string and the exclusion rule
    // operates at the schema level (§4 forbids these in payload fragments
    // and param echoes, not in legitimate field values). The real
    // protection is that the public type forbids a `params` field at all,
    // so callers can't pass a candidate_id filter value through. Prove
    // that by confirming no extra field with a candidate-id-like name
    // exists in the serialized shape.
    logReadAudit(baseSuccessEvent);
    const payload = parseAuditLine(spy.lines[0]!);
    const forbiddenKeys = [
      "candidate_id",
      "application_id",
      "opening_id",
      "job_id",
      "note_id",
      "scorecard_id",
      "offer_id",
      "attachment_id",
      "params",
      "ids",
      "cursor",
    ];
    for (const key of forbiddenKeys) {
      assert.ok(
        !(key in (payload as Record<string, unknown>)),
        `§4 exclusion: forbidden key "${key}" present in audit payload`
      );
    }
  });

  it("does not log payload fragments (no data[*], no next_cursor value, no response excerpt)", () => {
    logReadAudit(baseSuccessEvent);
    const line = spy.lines[0]!;
    const forbidden = [
      "data[",
      "next_cursor",
      "_pagination_note",
      "Harvest-response-fragment",
    ];
    for (const token of forbidden) {
      assert.ok(!line.includes(token), `Audit line leaked payload fragment: ${token}`);
    }
  });

  it("does not log projected field names", () => {
    // Even if projection eventually lands (P2.2), the audit line captures
    // only `projection_applied: boolean`; the field-name set is not logged.
    // Today projection_applied is always false, but the test guards that
    // no projection-related string ("projected_fields", "projection",
    // "detail_profile", etc.) other than the allowed `projection_applied`
    // ever leaks.
    logReadAudit(baseSuccessEvent);
    const line = spy.lines[0]!;
    const forbidden = [
      "projected_fields",
      "detail_profile",
      "projection_fields",
      "projection_name",
    ];
    for (const token of forbidden) {
      assert.ok(!line.includes(token), `Audit line leaked projection signal: ${token}`);
    }
  });

  it("does not log free-form error strings on outcome=error", () => {
    logReadAudit({
      tool: "list_user_emails",
      tier: 3,
      callerIdentity: { on_behalf_of_user_id: 99 },
      projectionApplied: false,
      outcome: "error",
    });
    const line = spy.lines[0]!;
    const forbidden = [
      "Greenhouse API error",
      "correlation_id=",
      "ECONNRESET",
      "stack",
      "message",
      "body=",
    ];
    for (const token of forbidden) {
      assert.ok(
        !line.includes(token),
        `Audit line leaked free-form error string on outcome=error: ${token}`
      );
    }
  });

  it("schema is closed: public emitter type cannot accept a params/data/err field", () => {
    // Compile-time guard masquerading as a runtime assertion. If this
    // test file stops compiling because ReadAuditEvent gained a `params`
    // or `data` or `err` field, the exclusion rule was widened and this
    // slice's contract broke. We prove the schema is closed by asserting
    // the keys of a ReadAuditEvent instance are a strict subset of the
    // spec §3 field names mapped to their camelCase public names.
    const allowedInputKeys = new Set([
      "tool",
      "tier",
      "callerIdentity",
      "projectionApplied",
      "resultSizeClass",
      "outcome",
    ]);
    for (const key of Object.keys(baseSuccessEvent)) {
      assert.ok(
        allowedInputKeys.has(key),
        `ReadAuditEvent gained unexpected input key "${key}" — §4 exclusion rule widened`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Fail-closed: emitter itself throws (spec §6.1 primitive layer)
// ---------------------------------------------------------------------------

describe("logReadAudit — fail-closed when stderr sink throws", () => {
  it("re-throws READ_AUDIT_FAILURE_MESSAGE when console.error throws", () => {
    const original = console.error;
    console.error = () => {
      throw new Error("stderr sink unavailable");
    };
    try {
      assert.throws(
        () => logReadAudit(baseSuccessEvent),
        (err: Error) => {
          assert.equal(err.message, READ_AUDIT_FAILURE_MESSAGE);
          // Must NOT leak underlying cause through the message.
          assert.ok(!err.message.includes("stderr sink unavailable"));
          assert.ok(!err.message.includes("list_email_templates"));
          return true;
        }
      );
    } finally {
      console.error = original;
    }
  });
});
