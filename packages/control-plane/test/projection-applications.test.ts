import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  projectApplication,
  projectApplicationsArray,
  type ProjectedApplication,
} from "../src/projection-applications.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALLOWED_KEYS = new Set<keyof ProjectedApplication>([
  "id",
  "candidate_id",
  "job_id",
  "stage_id",
  "stage_name",
  "status",
  "last_activity_at",
]);

// A realistic Harvest /applications record that deliberately includes
// sensitive fields the projection must drop: the full nested candidate
// object (names, emails, phone, LinkedIn URL, addresses), free-text
// per-application answers, attachment signed URLs, nested source/
// referrer/prospect_detail/rejection_details, and a hypothetical
// future field.
const RAW_APPLICATION_WITH_PII = Object.freeze({
  id: 55501,
  candidate_id: 70015,
  job_id: 333,
  status: "active",
  last_activity_at: "2026-04-20T12:00:00Z",
  current_stage: { id: 8801, name: "Technical screen" },
  // Forbidden nested / prose surfaces:
  candidate: {
    id: 70015,
    first_name: "Jane",
    last_name: "Doe",
    email_addresses: [{ value: "jane.doe@example.com", type: "personal" }],
    phone_numbers: [{ value: "+15551234567", type: "mobile" }],
    social_media_addresses: [
      { value: "https://www.linkedin.com/in/janedoe" },
    ],
    addresses: [{ value: "123 Main St, Springfield" }],
    company: "Current Employer Inc.",
    title: "Senior Engineer",
  },
  job: { id: 333, name: "Senior Engineer (Platform)" },
  jobs: [{ id: 333 }, { id: 444 }],
  answers: [
    {
      question: "Why are you interested in this role?",
      answer: "Strong platform background, referred by Jane Recruiter.",
    },
    {
      question: "Salary expectations?",
      answer: "Within posted band; open to discussion.",
    },
  ],
  attachments: [
    {
      filename: "jane-doe-resume.pdf",
      type: "resume",
      url: "https://s3.amazonaws.com/gh-attachments/signed-url-example",
    },
  ],
  source: { id: 91, public_name: "Internal Referral" },
  referrer: { id: 42, type: "user" },
  prospect_detail: { prospect_pool: { id: 5, name: "Q2 Sourced Pool" } },
  rejection_details: {
    keyed_reasons: { "We think you're great, but...": "Other" },
    custom_fields: { rejection_note: "Strong candidate, different role." },
  },
  applied_at: "2026-04-10T00:00:00Z",
  rejected_at: null,
  converted_at: null,
  keyed_custom_fields: { referral_source: "LinkedIn InMail" },
  updated_at: "2026-04-20T12:00:00Z",
  created_at: "2026-04-10T00:00:00Z",
  // hypothetical future field Greenhouse may add
  new_future_field: "definitely not allowlisted",
});

/**
 * Capture console.error output to verify the Tier-2 silence contract:
 * projecting `list_applications` must emit no `READ_AUDIT` line on
 * stderr. Matches the idiom used across the other test files in this
 * package.
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

// ---------------------------------------------------------------------------
// Unit tests for projectApplication
// ---------------------------------------------------------------------------

describe("projectApplication — §4 7-field allowlist shape", () => {
  it("returns exactly the 7 allowlisted keys, no more, no less", () => {
    const projected = projectApplication(RAW_APPLICATION_WITH_PII);
    const keys = Object.keys(projected).sort();
    assert.deepStrictEqual(
      keys,
      [
        "candidate_id",
        "id",
        "job_id",
        "last_activity_at",
        "stage_id",
        "stage_name",
        "status",
      ],
      "projectApplication output must contain exactly the §4 allowlist keys"
    );
    // #H: current_stage_at is gone — a v3 phantom field that was always null.
    assert.ok(!("current_stage_at" in projected), "phantom current_stage_at must not be present");
    for (const key of Object.keys(projected)) {
      assert.ok(
        ALLOWED_KEYS.has(key as keyof ProjectedApplication),
        `unexpected key "${key}" in projected output`
      );
    }
  });

  it("preserves id, candidate_id, job_id, status, last_activity_at", () => {
    const projected = projectApplication(RAW_APPLICATION_WITH_PII);
    assert.equal(projected.id, 55501);
    assert.equal(projected.candidate_id, 70015);
    assert.equal(projected.job_id, 333);
    assert.equal(projected.status, "active");
    assert.equal(projected.last_activity_at, "2026-04-20T12:00:00Z");
  });

  it("resolves stage_id and stage_name from nested current_stage when flat fields are absent", () => {
    const projected = projectApplication(RAW_APPLICATION_WITH_PII);
    assert.equal(projected.stage_id, 8801);
    assert.equal(projected.stage_name, "Technical screen");
  });

  it("normalizes absent id fields to null", () => {
    const projected = projectApplication({ status: "active" });
    assert.equal(projected.id, null);
    assert.equal(projected.candidate_id, null);
    assert.equal(projected.job_id, null);
    assert.equal(projected.stage_id, null);
  });

  it("normalizes absent string fields to null", () => {
    const projected = projectApplication({ id: 1 });
    assert.equal(projected.stage_name, null);
    assert.equal(projected.status, null);
    assert.equal(projected.last_activity_at, null);
  });

  it("rejects non-numeric id-ish fields without throwing", () => {
    const projected = projectApplication({
      id: "stringified",
      candidate_id: NaN,
      job_id: Infinity,
      stage_id: null,
    });
    assert.equal(projected.id, null);
    assert.equal(projected.candidate_id, null);
    assert.equal(projected.job_id, null);
    assert.equal(projected.stage_id, null);
  });

  it("rejects non-object input without throwing", () => {
    for (const input of [null, undefined, 0, "application", true, [], [1, 2, 3]]) {
      const projected = projectApplication(input as unknown);
      assert.deepStrictEqual(Object.keys(projected).sort(), [
        "candidate_id",
        "id",
        "job_id",
        "last_activity_at",
        "stage_id",
        "stage_name",
        "status",
      ]);
      assert.equal(projected.id, null);
      assert.equal(projected.status, null);
    }
  });

  it("status passes through verbatim for all four documented values and unknown future strings", () => {
    for (const status of ["active", "rejected", "hired", "converted", "SOME_FUTURE_STATUS"]) {
      assert.equal(projectApplication({ id: 1, status }).status, status);
    }
  });
});

// ---------------------------------------------------------------------------
// job_id derivation (flat vs nested; reuses deriveApplicationJobId)
// ---------------------------------------------------------------------------

describe("projectApplication — job_id derivation", () => {
  it("preserves flat job_id when present and numeric", () => {
    const projected = projectApplication({ id: 1, job_id: 42 });
    assert.equal(projected.job_id, 42);
  });

  it("falls back to jobs[0].id when flat job_id is absent", () => {
    const projected = projectApplication({ id: 1, jobs: [{ id: 99 }, { id: 100 }] });
    assert.equal(projected.job_id, 99);
  });

  it("prefers flat job_id over nested jobs when both are present", () => {
    const projected = projectApplication({ id: 1, job_id: 42, jobs: [{ id: 99 }] });
    assert.equal(projected.job_id, 42);
  });

  it("returns null when jobs array is empty or malformed", () => {
    assert.equal(projectApplication({ id: 1, jobs: [] }).job_id, null);
    assert.equal(projectApplication({ id: 1, jobs: [{}] }).job_id, null);
    assert.equal(projectApplication({ id: 1, jobs: "not an array" }).job_id, null);
  });

  it("returns null when neither flat job_id nor nested jobs[0].id is available", () => {
    assert.equal(projectApplication({ id: 1 }).job_id, null);
  });

  it("falls back to null when flat job_id is non-numeric", () => {
    assert.equal(projectApplication({ id: 1, job_id: "42" }).job_id, null);
    assert.equal(projectApplication({ id: 1, job_id: NaN }).job_id, null);
  });
});

// ---------------------------------------------------------------------------
// stage_id / stage_name flat-vs-nested resolution
// ---------------------------------------------------------------------------

describe("projectApplication — stage_id and stage_name flat-vs-nested", () => {
  it("reads flat stage_id and stage_name when present", () => {
    const projected = projectApplication({
      id: 1,
      stage_id: 7,
      stage_name: "Onsite",
    });
    assert.equal(projected.stage_id, 7);
    assert.equal(projected.stage_name, "Onsite");
  });

  it("falls back to current_stage.id and current_stage.name when flat fields are absent", () => {
    const projected = projectApplication({
      id: 1,
      current_stage: { id: 12, name: "Offer" },
    });
    assert.equal(projected.stage_id, 12);
    assert.equal(projected.stage_name, "Offer");
  });

  it("prefers flat fields over nested fields when both are present", () => {
    const projected = projectApplication({
      id: 1,
      stage_id: 7,
      stage_name: "Onsite",
      current_stage: { id: 12, name: "Offer" },
    });
    assert.equal(projected.stage_id, 7);
    assert.equal(projected.stage_name, "Onsite");
  });

  it("returns null for stage_id / stage_name when neither flat nor nested yields a valid value", () => {
    assert.equal(projectApplication({ id: 1 }).stage_id, null);
    assert.equal(projectApplication({ id: 1 }).stage_name, null);
    assert.equal(
      projectApplication({ id: 1, current_stage: null }).stage_id,
      null
    );
    assert.equal(
      projectApplication({ id: 1, current_stage: { id: "not-a-number" } }).stage_id,
      null
    );
    assert.equal(
      projectApplication({ id: 1, current_stage: { name: 42 } }).stage_name,
      null
    );
  });

  it("handles nested current_stage that is an array (defensive) without throwing", () => {
    const projected = projectApplication({
      id: 1,
      current_stage: [{ id: 7, name: "Onsite" }],
    });
    assert.equal(projected.stage_id, null);
    assert.equal(projected.stage_name, null);
  });
});

// ---------------------------------------------------------------------------
// Array handling
// ---------------------------------------------------------------------------

describe("projectApplicationsArray — array handling", () => {
  it("projects each element and preserves order", () => {
    const raw = [
      { id: 1, status: "active", job_id: 10 },
      { id: 2, status: "rejected" },
      { id: 3 },
    ];
    const projected = projectApplicationsArray(raw);
    assert.equal(projected.length, 3);
    assert.equal(projected[0]!.id, 1);
    assert.equal(projected[0]!.status, "active");
    assert.equal(projected[0]!.job_id, 10);
    assert.equal(projected[1]!.id, 2);
    assert.equal(projected[1]!.status, "rejected");
    assert.equal(projected[2]!.id, 3);
  });

  it("returns [] for non-array inputs without throwing", () => {
    assert.deepStrictEqual(projectApplicationsArray(null), []);
    assert.deepStrictEqual(projectApplicationsArray(undefined), []);
    assert.deepStrictEqual(projectApplicationsArray({ data: [] }), []);
    assert.deepStrictEqual(projectApplicationsArray("not an array"), []);
    assert.deepStrictEqual(projectApplicationsArray(42), []);
  });

  it("returns [] for an empty array", () => {
    assert.deepStrictEqual(projectApplicationsArray([]), []);
  });
});

// ---------------------------------------------------------------------------
// §7.2 exclusion-rule contract tests
//
// Uses JSON-key prefix assertions (e.g. `"candidate":`) rather than bare
// substring to avoid false positives when allowlisted field names contain
// forbidden substrings:
//   - allowlisted `candidate_id` contains `candidate`
//   - allowlisted `job_id` contains `job`
//   - allowlisted `stage_id` / `stage_name` contain `stage`
// Lesson carried forward from slice 1.
// ---------------------------------------------------------------------------

describe("projectApplication — §7.2 exclusion rule (contract tests)", () => {
  it("drops candidate, job/jobs, current_stage, answers, source, referrer, attachments, prospect_detail, rejection_details", () => {
    const projected = projectApplication(RAW_APPLICATION_WITH_PII);
    const forbiddenKeys = [
      "candidate",
      "job",
      "jobs",
      "current_stage",
      "answers",
      "source",
      "referrer",
      "attachments",
      "prospect_detail",
      "rejection_details",
      "applied_at",
      "rejected_at",
      "converted_at",
      "keyed_custom_fields",
      "updated_at",
      "created_at",
    ];
    for (const key of forbiddenKeys) {
      assert.ok(
        !(key in (projected as Record<string, unknown>)),
        `§7.2 exclusion: forbidden key "${key}" present in projected output`
      );
    }
  });

  it("drops unknown future Harvest fields silently", () => {
    const projected = projectApplication({
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
    assert.equal(Object.keys(projected).length, 7);
  });

  it("forbidden JSON-key prefixes never appear in the serialized projection (key-level exclusion)", () => {
    const projected = projectApplication(RAW_APPLICATION_WITH_PII);
    const serialized = JSON.stringify(projected);

    // Key-prefix form: these JSON key prefixes would only appear if the
    // forbidden field were actually projected. Allowlisted `candidate_id`
    // / `job_id` / `stage_id` / `stage_name` contain the substrings
    // "candidate" / "job" / "stage", so we check for the exact key
    // prefix form to avoid a false positive.
    const forbiddenKeyPrefixes = [
      '"candidate":',
      '"job":',
      '"jobs":',
      '"current_stage":',
      '"answers":',
      '"source":',
      '"referrer":',
      '"attachments":',
      '"prospect_detail":',
      '"rejection_details":',
      '"applied_at":',
      '"rejected_at":',
      '"converted_at":',
      '"keyed_custom_fields":',
      '"updated_at":',
      '"created_at":',
    ];
    for (const prefix of forbiddenKeyPrefixes) {
      assert.ok(
        !serialized.includes(prefix),
        `§7.2 exclusion: serialized projection leaked forbidden key ${prefix}`
      );
    }
  });

  it("candidate names, emails, phone numbers, LinkedIn URLs, and Q&A prose never appear in the serialized projection", () => {
    const projected = projectApplication(RAW_APPLICATION_WITH_PII);
    const serialized = JSON.stringify(projected);

    const forbiddenContent = [
      // Candidate PII
      "Jane Doe",
      "jane.doe@example.com",
      "+15551234567",
      "linkedin.com",
      "Main St",
      "Springfield",
      "Current Employer",
      "Senior Engineer (Platform)",
      // Q&A prose
      "Strong platform background",
      "Within posted band",
      "Jane Recruiter",
      // Attachment metadata
      "jane-doe-resume.pdf",
      "s3.amazonaws.com",
      "signed-url-example",
      // Source / referrer / prospect detail / rejection content
      "Internal Referral",
      "Q2 Sourced Pool",
      "We think you're great",
      "Strong candidate, different role.",
      "LinkedIn InMail",
    ];
    for (const token of forbiddenContent) {
      assert.ok(
        !serialized.includes(token),
        `§7.2 exclusion: serialized projection leaked PII content "${token}": ${serialized}`
      );
    }

    // Confirm the allowlisted metadata IS retained — proves the test
    // is actually checking content rather than trivially passing.
    assert.equal(projected.id, 55501);
    assert.equal(projected.candidate_id, 70015);
    assert.equal(projected.job_id, 333);
    assert.equal(projected.stage_id, 8801);
    assert.equal(projected.stage_name, "Technical screen");
    assert.equal(projected.status, "active");
  });

  it("projectApplicationsArray applied to a mixed batch keeps the exclusion invariant per element", () => {
    const projected = projectApplicationsArray([
      RAW_APPLICATION_WITH_PII,
      {
        id: 2,
        status: "rejected",
        candidate: { first_name: "Other", last_name: "Candidate", email_addresses: [{ value: "other@example.com" }] },
        answers: [{ question: "Other q", answer: "Other answer with sensitive detail" }],
      },
      null,
      { id: 3 },
    ]);
    const serialized = JSON.stringify(projected);

    const forbiddenKeyPrefixes = [
      '"candidate":',
      '"job":',
      '"jobs":',
      '"current_stage":',
      '"answers":',
      '"source":',
      '"referrer":',
      '"attachments":',
    ];
    for (const prefix of forbiddenKeyPrefixes) {
      assert.ok(
        !serialized.includes(prefix),
        `§7.2 exclusion: array projection leaked field key ${prefix}`
      );
    }

    const forbiddenContent = [
      "Other Candidate",
      "other@example.com",
      "Other answer with sensitive detail",
      "Jane Doe",
      "jane.doe@example.com",
    ];
    for (const token of forbiddenContent) {
      assert.ok(
        !serialized.includes(token),
        `§7.2 exclusion: array projection leaked PII content "${token}"`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// §7.3 Tier-2 silence contract — list_applications emits no READ_AUDIT line
//
// Slices 1 (`list_notes`) and 2 (`list_scorecards`) each emit a
// READ_AUDIT line per call. Slice 3 explicitly does not, per doctrine §7
// canonical rule: Tier 2 reads never audit-log. These tests verify
// that running the projection code path (on a realistic PII-loaded
// record, on an empty array, on an error-triggering input) produces
// zero stderr output that looks like a READ_AUDIT line.
// ---------------------------------------------------------------------------

describe("projectApplicationsArray — Tier-2 silence contract", () => {
  it("projecting a batch of applications emits no READ_AUDIT line on stderr", () => {
    const spy = captureStderr();
    try {
      const projected = projectApplicationsArray([
        RAW_APPLICATION_WITH_PII,
        { id: 2, status: "rejected" },
      ]);
      assert.equal(projected.length, 2);

      const readAuditLines = spy.lines.filter((l) =>
        l.startsWith("[greenhouse-mcp] READ_AUDIT")
      );
      assert.equal(
        readAuditLines.length,
        0,
        `Tier-2 silence contract: expected zero READ_AUDIT lines, got ${readAuditLines.length}: ${JSON.stringify(readAuditLines)}`
      );
    } finally {
      spy.restore();
    }
  });

  it("projecting a single application emits no READ_AUDIT line on stderr", () => {
    const spy = captureStderr();
    try {
      const projected = projectApplication(RAW_APPLICATION_WITH_PII);
      assert.equal(projected.id, 55501);

      const readAuditLines = spy.lines.filter((l) =>
        l.startsWith("[greenhouse-mcp] READ_AUDIT")
      );
      assert.equal(readAuditLines.length, 0, "Tier-2 silence: single-record projection must not emit");
    } finally {
      spy.restore();
    }
  });

  it("projecting a non-array / non-object defensively emits no READ_AUDIT line", () => {
    const spy = captureStderr();
    try {
      projectApplicationsArray(null);
      projectApplicationsArray(undefined);
      projectApplicationsArray({ not: "an array" });
      projectApplication(null);
      projectApplication("scalar");

      const readAuditLines = spy.lines.filter((l) =>
        l.startsWith("[greenhouse-mcp] READ_AUDIT")
      );
      assert.equal(
        readAuditLines.length,
        0,
        "Tier-2 silence: defensive inputs must not trigger any audit emission"
      );
    } finally {
      spy.restore();
    }
  });
});
