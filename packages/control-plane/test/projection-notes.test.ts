import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  projectNote,
  projectNotesArray,
  type ProjectedNote,
} from "../src/projection-notes.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALLOWED_KEYS = new Set<keyof ProjectedNote>([
  "id",
  "type",
  "visibility",
  "user_id",
  "created_at",
  "application_id",
  "candidate_id",
  "has_body",
]);

// A realistic Harvest /notes record that deliberately includes sensitive
// fields the projection must drop: body (Tier-3 prose), subject/to/cc/bcc,
// nested user, and a hypothetical future field.
const RAW_NOTE_WITH_PII = Object.freeze({
  id: 9001,
  type: "EMAIL",
  visibility: "admin_only_visible",
  user_id: 42,
  created_at: "2026-04-20T12:34:56.789Z",
  application_id: 55501,
  candidate_id: 70015,
  body: "Hi Jane, thanks for your time on Tuesday — synthetic@example.com please confirm.",
  subject: "Follow-up on Tuesday interview",
  to: ["jane.doe@example.com"],
  cc: ["recruiter@example.com"],
  bcc: ["archive@example.com"],
  from: "sourcer@example.com",
  user: {
    id: 42,
    name: "Jane Recruiter",
    email: "jane.recruiter@example.com",
  },
  // hypothetical future field Greenhouse may add
  new_future_field: "definitely not allowlisted",
});

// ---------------------------------------------------------------------------
// Unit tests for projectNote
// ---------------------------------------------------------------------------

describe("projectNote — §4 8-field allowlist shape", () => {
  it("returns exactly the 8 allowlisted keys, no more, no less", () => {
    const projected = projectNote(RAW_NOTE_WITH_PII);
    const keys = Object.keys(projected).sort();
    assert.deepStrictEqual(
      keys,
      [
        "application_id",
        "candidate_id",
        "created_at",
        "has_body",
        "id",
        "type",
        "user_id",
        "visibility",
      ],
      "projectNote output must contain exactly the §4 allowlist keys"
    );
    for (const key of Object.keys(projected)) {
      assert.ok(
        ALLOWED_KEYS.has(key as keyof ProjectedNote),
        `unexpected key "${key}" in projected output`
      );
    }
  });

  it("preserves id, type, visibility, user_id, created_at, application_id, candidate_id", () => {
    const projected = projectNote(RAW_NOTE_WITH_PII);
    assert.equal(projected.id, 9001);
    assert.equal(projected.type, "EMAIL");
    assert.equal(projected.visibility, "admin_only_visible");
    assert.equal(projected.user_id, 42);
    assert.equal(projected.created_at, "2026-04-20T12:34:56.789Z");
    assert.equal(projected.application_id, 55501);
    assert.equal(projected.candidate_id, 70015);
  });

  it("computes has_body=true when raw.body is a non-empty non-whitespace string", () => {
    assert.equal(projectNote({ id: 1, body: "has content" }).has_body, true);
    assert.equal(
      projectNote({ id: 1, body: " hello " }).has_body,
      true,
      "trimmed non-empty content is still content"
    );
  });

  it("computes has_body=false when raw.body is null, undefined, empty, or whitespace-only", () => {
    assert.equal(projectNote({ id: 1, body: null }).has_body, false);
    assert.equal(projectNote({ id: 1, body: undefined }).has_body, false);
    assert.equal(projectNote({ id: 1, body: "" }).has_body, false);
    assert.equal(projectNote({ id: 1, body: "   " }).has_body, false);
    assert.equal(projectNote({ id: 1, body: "\t\n  " }).has_body, false);
    assert.equal(projectNote({ id: 1 }).has_body, false, "missing body is 'no body'");
  });

  it("computes has_body=false when raw.body is a non-string value (defensive)", () => {
    assert.equal(projectNote({ id: 1, body: 42 }).has_body, false);
    assert.equal(projectNote({ id: 1, body: true }).has_body, false);
    assert.equal(projectNote({ id: 1, body: { text: "hi" } }).has_body, false);
    assert.equal(projectNote({ id: 1, body: ["hi"] }).has_body, false);
  });

  it("normalizes absent id/user_id/application_id/candidate_id to null", () => {
    const projected = projectNote({ type: "NOTE", visibility: "publicly_visible" });
    assert.equal(projected.id, null);
    assert.equal(projected.user_id, null);
    assert.equal(projected.application_id, null);
    assert.equal(projected.candidate_id, null);
  });

  it("normalizes absent type/visibility/created_at to null", () => {
    const projected = projectNote({ id: 1 });
    assert.equal(projected.type, null);
    assert.equal(projected.visibility, null);
    assert.equal(projected.created_at, null);
  });

  it("type passes through verbatim across all 12 documented types and unknown strings", () => {
    const documentedTypes = [
      "NOTE",
      "ACTIVITY",
      "INTERVIEW",
      "EMAIL",
      "FOLLOW_UP",
      "TAKE_HOME_TEST",
      "LINKEDIN_NOTE",
      "LINKEDIN_INMAIL",
      "AVAILABILITY_REQUEST",
      "TOUCHPOINT",
      "FORM",
      "FEEDBACK",
    ];
    for (const type of documentedTypes) {
      assert.equal(projectNote({ id: 1, type }).type, type);
    }
    // Unknown/future type strings pass through — the allowlist is field-level,
    // not value-level.
    assert.equal(
      projectNote({ id: 1, type: "SOME_FUTURE_TYPE" }).type,
      "SOME_FUTURE_TYPE"
    );
  });

  it("visibility passes through verbatim for all three documented values", () => {
    for (const visibility of [
      "admin_only_visible",
      "privately_visible",
      "publicly_visible",
    ]) {
      assert.equal(projectNote({ id: 1, visibility }).visibility, visibility);
    }
  });

  it("rejects non-numeric id-ish fields without throwing", () => {
    const projected = projectNote({
      id: "stringified",
      user_id: NaN,
      application_id: Infinity,
      candidate_id: null,
    });
    assert.equal(projected.id, null);
    assert.equal(projected.user_id, null);
    assert.equal(projected.application_id, null);
    assert.equal(projected.candidate_id, null);
  });

  it("rejects non-object input without throwing", () => {
    for (const input of [null, undefined, 0, "note", true, [], [1, 2, 3]]) {
      const projected = projectNote(input as unknown);
      assert.deepStrictEqual(Object.keys(projected).sort(), [
        "application_id",
        "candidate_id",
        "created_at",
        "has_body",
        "id",
        "type",
        "user_id",
        "visibility",
      ]);
      assert.equal(projected.has_body, false);
      assert.equal(projected.id, null);
    }
  });
});

// ---------------------------------------------------------------------------
// Unit tests for projectNotesArray
// ---------------------------------------------------------------------------

describe("projectNotesArray — array handling", () => {
  it("projects each element and preserves order", () => {
    const raw = [
      { id: 1, body: "a" },
      { id: 2, body: "" },
      { id: 3 },
    ];
    const projected = projectNotesArray(raw);
    assert.equal(projected.length, 3);
    assert.equal(projected[0]!.id, 1);
    assert.equal(projected[0]!.has_body, true);
    assert.equal(projected[1]!.id, 2);
    assert.equal(projected[1]!.has_body, false);
    assert.equal(projected[2]!.id, 3);
    assert.equal(projected[2]!.has_body, false);
  });

  it("returns [] for non-array inputs without throwing", () => {
    assert.deepStrictEqual(projectNotesArray(null), []);
    assert.deepStrictEqual(projectNotesArray(undefined), []);
    assert.deepStrictEqual(projectNotesArray({ data: [] }), []);
    assert.deepStrictEqual(projectNotesArray("not an array"), []);
    assert.deepStrictEqual(projectNotesArray(42), []);
  });

  it("returns [] for an empty array", () => {
    assert.deepStrictEqual(projectNotesArray([]), []);
  });
});

describe("projectNote — body detail profile", () => {
  it("broadens the note projection to include subject and body text", () => {
    const projected = projectNote(RAW_NOTE_WITH_PII, {
      detailProfile: "body",
    });

    assert.equal(projected.subject, "Follow-up on Tuesday interview");
    assert.equal(
      projected.body,
      "Hi Jane, thanks for your time on Tuesday — synthetic@example.com please confirm."
    );
    assert.equal(projected.has_body, true);
  });
});

// ---------------------------------------------------------------------------
// §4 exclusion-rule contract tests
//
// These guard the allowlist against regressions that widen the projected
// surface. Each test drives a deliberately PII-loaded input and asserts
// that the forbidden material never reaches the projected output.
// ---------------------------------------------------------------------------

describe("projectNote — §4 exclusion rule (contract tests)", () => {
  it("drops body, subject, to/cc/bcc/from, and nested user fields", () => {
    const projected = projectNote(RAW_NOTE_WITH_PII);
    const forbiddenKeys = [
      "body",
      "subject",
      "to",
      "cc",
      "bcc",
      "from",
      "user",
    ];
    for (const key of forbiddenKeys) {
      assert.ok(
        !(key in (projected as Record<string, unknown>)),
        `§4 exclusion: forbidden key "${key}" present in projected output`
      );
    }
  });

  it("drops unknown future Harvest fields silently (unknown fields are not forwarded)", () => {
    const projected = projectNote({
      id: 1,
      new_future_field_1: "definitely not allowlisted",
      deeply_nested_new_thing: { more: "data" },
      another_field: [1, 2, 3],
    });
    assert.ok(
      !("new_future_field_1" in (projected as Record<string, unknown>)),
      "unknown field leaked into projection"
    );
    assert.ok(
      !("deeply_nested_new_thing" in (projected as Record<string, unknown>)),
      "unknown nested field leaked into projection"
    );
    assert.ok(
      !("another_field" in (projected as Record<string, unknown>)),
      "unknown array field leaked into projection"
    );
    // And confirm the 8-key shape is intact.
    assert.equal(Object.keys(projected).length, 8);
  });

  it("candidate names, emails, and free-text prose in body/subject never appear in the serialized projection", () => {
    const raw = {
      id: 42,
      type: "EMAIL",
      visibility: "privately_visible",
      user_id: 5,
      created_at: "2026-04-20T00:00:00Z",
      application_id: 99,
      candidate_id: 12345,
      body: "Jane Doe confirmed availability; reach her at jane.doe@example.com or via LinkedIn https://www.linkedin.com/in/janedoe",
      subject: "RE: Jane Doe — availability",
      to: ["jane.doe@example.com"],
      from: "recruiter@example.com",
      user: {
        name: "Jane Recruiter",
        email: "jane.recruiter@example.com",
      },
    };
    const projected = projectNote(raw);
    const serialized = JSON.stringify(projected);

    const forbiddenSubstrings = [
      "Jane Doe",
      "Jane Recruiter",
      "jane.doe@example.com",
      "recruiter@example.com",
      "jane.recruiter@example.com",
      "linkedin.com",
      "RE: Jane",
      "availability",
      "confirmed",
    ];
    for (const substring of forbiddenSubstrings) {
      assert.ok(
        !serialized.includes(substring),
        `§4 exclusion: serialized projection leaked "${substring}": ${serialized}`
      );
    }

    // But it does retain the allowlisted metadata, which proves the test
    // is actually checking content rather than trivially passing.
    assert.equal(projected.id, 42);
    assert.equal(projected.has_body, true);
    assert.equal(projected.candidate_id, 12345);
  });

  it("projectNotesArray applied to a mixed batch keeps the exclusion invariant per element", () => {
    const projected = projectNotesArray([
      RAW_NOTE_WITH_PII,
      { id: 2, body: "Other sensitive content", subject: "Offer details" },
      null,
      { id: 3 },
    ]);
    const serialized = JSON.stringify(projected);

    // Field-level exclusion: these JSON key prefixes would only appear if
    // the forbidden field were actually projected. The allowlisted
    // `has_body` field is OK because we check for the `"body":` key prefix,
    // not the bare substring `body`.
    const forbiddenKeyPrefixes = [
      '"body":',
      '"subject":',
      '"to":',
      '"cc":',
      '"bcc":',
      '"from":',
      '"user":',
    ];
    for (const prefix of forbiddenKeyPrefixes) {
      assert.ok(
        !serialized.includes(prefix),
        `§4 exclusion: array projection leaked field key ${prefix}`
      );
    }

    // Content-level exclusion: free-text PII tokens from body/subject
    // must never appear anywhere in the serialized projection.
    const forbiddenContent = [
      "Other sensitive content",
      "Offer details",
      "jane.recruiter@example.com",
      "archive@example.com",
    ];
    for (const token of forbiddenContent) {
      assert.ok(
        !serialized.includes(token),
        `§4 exclusion: array projection leaked PII content "${token}"`
      );
    }
  });
});
