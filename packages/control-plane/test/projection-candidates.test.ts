import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  projectCandidate,
  projectCandidatesArray,
  type ProjectedCandidate,
} from "../src/projection-candidates.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALLOWED_KEYS = new Set<keyof ProjectedCandidate>([
  "id",
  "last_activity_at",
  "tag_names",
  "stage_snapshot",
  "private",
]);

/**
 * A realistic Harvest /candidates record that deliberately includes
 * the entire Tier-2 PII surface the projection must drop: first/last
 * name, contact info, addresses, social/LinkedIn URLs, full
 * application detail with Q&A answers and attachments (a forbidden-surface
 * decoy — `applications` is never projected and must produce no leaked
 * application/stage data), employment + education history, nested
 * recruiter/coordinator users, custom fields, and a hypothetical future
 * field. `tags` are v3 plain strings (tag names); the tag NAMES are now the
 * intentional `tag_names` payload, but the annotation-style names below double
 * as a leak check for the forbidden surfaces they sit beside.
 */
const RAW_CANDIDATE_WITH_PII = Object.freeze({
  id: 70015,
  last_activity_at: "2026-04-20T12:00:00Z",
  private: false,
  // Forbidden PII surface:
  first_name: "Jane",
  last_name: "Doe",
  company: "Current Employer Inc.",
  title: "Senior Engineer",
  email_addresses: [{ value: "jane.doe@example.com", type: "personal" }],
  phone_numbers: [{ value: "+15551234567", type: "mobile" }],
  addresses: [{ value: "123 Main St, Springfield" }],
  social_media_addresses: [
    { value: "https://www.linkedin.com/in/janedoe" },
  ],
  website_addresses: [{ value: "https://janedoe.example.com" }],
  photo_url: "https://cdn.example.com/photos/janedoe.jpg",
  can_email: true,
  is_private: false,
  application_ids: [55501, 55502],
  applications: [
    {
      id: 55501,
      status: "active",
      last_activity_at: "2026-04-20T12:00:00Z",
      current_stage: { id: 8801, name: "Technical screen" },
      answers: [
        { question: "Why here?", answer: "Strong platform background" },
      ],
    },
    {
      id: 55502,
      status: "active",
      last_activity_at: "2026-04-15T08:00:00Z",
      current_stage: { id: 7700, name: "Phone screen" },
    },
    {
      id: 55503,
      status: "rejected",
      last_activity_at: "2026-03-10T00:00:00Z",
      current_stage: { id: 9900, name: "Offer" },
    },
  ],
  educations: [
    { school_name: "Example University", degree: "BS Computer Science" },
  ],
  employments: [
    { company_name: "Current Employer Inc.", title: "Senior Engineer" },
  ],
  attachments: [
    {
      filename: "jane-doe-resume.pdf",
      type: "resume",
      url: "https://s3.amazonaws.com/gh-attachments/signed-url-example",
    },
  ],
  tags: ["Reference: Senator Foo", "LinkedIn-sourced", "Watch"],
  recruiter: {
    id: 42,
    name: "Jane Recruiter",
    email: "jane.recruiter@example.com",
  },
  coordinator: {
    id: 43,
    name: "Sam Coordinator",
    email: "alex.coordinator@example.com",
  },
  custom_fields: {
    hidden_note: "Sensitive operator annotation",
    salary_expectation: "Within band",
  },
  keyed_custom_fields: {
    hidden_note: { value: "Sensitive operator annotation" },
  },
  created_at: "2026-04-01T00:00:00Z",
  updated_at: "2026-04-20T12:00:00Z",
  // hypothetical future field Greenhouse may add
  new_future_field: "definitely not allowlisted",
});

/**
 * Capture console.error output to verify the Tier-2 silence contract:
 * projecting `list_candidates` via either exported helper must emit
 * no `READ_AUDIT` line on stderr.
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
// Unit tests for projectCandidate
// ---------------------------------------------------------------------------

describe("projectCandidate — §4 5-field allowlist shape", () => {
  it("returns exactly the 5 allowlisted keys, no more, no less", () => {
    const projected = projectCandidate(RAW_CANDIDATE_WITH_PII);
    const keys = Object.keys(projected).sort();
    assert.deepStrictEqual(
      keys,
      ["id", "last_activity_at", "private", "stage_snapshot", "tag_names"],
      "projectCandidate output must contain exactly the §4 allowlist keys"
    );
    for (const key of Object.keys(projected)) {
      assert.ok(
        ALLOWED_KEYS.has(key as keyof ProjectedCandidate),
        `unexpected key "${key}" in projected output`
      );
    }
    // stage_snapshot is the candidate's pipeline state, derived from the injected
    // applications — one entry per application, carrying only id/job/stage/status,
    // never the application's answers or other PII. The raw `applications` array
    // itself never passes through.
    assert.ok(Array.isArray(projected.stage_snapshot));
    assert.equal(projected.stage_snapshot!.length, 3);
    assert.ok(
      !("applications" in (projected as Record<string, unknown>)),
      "raw applications array must not pass through; only the projected stage_snapshot"
    );
  });

  it("preserves id as number; absent/non-numeric id → null", () => {
    assert.equal(projectCandidate({ id: 42 }).id, 42);
    assert.equal(projectCandidate({ id: 9001 }).id, 9001);

    assert.equal(projectCandidate({}).id, null);
    assert.equal(projectCandidate({ id: "not-a-number" }).id, null);
    assert.equal(projectCandidate({ id: NaN }).id, null);
    assert.equal(projectCandidate({ id: Infinity }).id, null);
    assert.equal(projectCandidate({ id: null }).id, null);
  });

  it("preserves last_activity_at as ISO-8601 string; absent/non-string → null", () => {
    assert.equal(
      projectCandidate({ last_activity_at: "2026-04-20T12:00:00Z" }).last_activity_at,
      "2026-04-20T12:00:00Z"
    );
    assert.equal(projectCandidate({}).last_activity_at, null);
    assert.equal(projectCandidate({ last_activity_at: 1700000000 }).last_activity_at, null);
    assert.equal(projectCandidate({ last_activity_at: null }).last_activity_at, null);
    assert.equal(projectCandidate({ last_activity_at: { ts: "2026" } }).last_activity_at, null);
  });

  it("preserves private as boolean; non-boolean values default to false", () => {
    assert.equal(projectCandidate({ private: true }).private, true);
    assert.equal(projectCandidate({ private: false }).private, false);

    // Non-boolean defaults defensively to false (§4 normalization rule).
    assert.equal(projectCandidate({}).private, false);
    assert.equal(projectCandidate({ private: null }).private, false);
    assert.equal(projectCandidate({ private: "true" }).private, false);
    assert.equal(projectCandidate({ private: 1 }).private, false);
    assert.equal(projectCandidate({ private: undefined }).private, false);
  });

  it("rejects non-object input without throwing and returns a fully-null/default shape", () => {
    for (const input of [null, undefined, 0, "candidate", true, [], [1, 2, 3]]) {
      const projected = projectCandidate(input as unknown);
      assert.deepStrictEqual(Object.keys(projected).sort(), [
        "id",
        "last_activity_at",
        "private",
        "stage_snapshot",
        "tag_names",
      ]);
      assert.equal(projected.id, null);
      assert.equal(projected.last_activity_at, null);
      assert.deepStrictEqual(projected.tag_names, []);
      assert.equal(projected.private, false);
      // No raw object → applications could not be supplied → stage_snapshot is the
      // honest "unknown" null (distinct from [] = candidate has no applications).
      assert.equal(projected.stage_snapshot, null);
    }
  });
});

// ---------------------------------------------------------------------------
// tag_names derivation
//
// Harvest v3 `GET /v3/candidates` returns `tags` as plain STRINGS (tag names;
// 0057), not `{id}` objects. The projection carries the tag NAMES through as
// `tag_names: string[]` — names are the only tag data v3 exposes (#H).
// ---------------------------------------------------------------------------

describe("projectCandidate — tag_names derivation (§4.2)", () => {
  it("extracts string tag names from a v3 tags[] string array", () => {
    const projected = projectCandidate({
      id: 1,
      tags: ["Referral", "Watch"],
    });
    assert.deepStrictEqual(projected.tag_names, ["Referral", "Watch"]);
  });

  it("returns [] when tags is absent or not an array", () => {
    assert.deepStrictEqual(projectCandidate({ id: 1 }).tag_names, []);
    assert.deepStrictEqual(projectCandidate({ id: 1, tags: null }).tag_names, []);
    assert.deepStrictEqual(projectCandidate({ id: 1, tags: "not-an-array" }).tag_names, []);
    assert.deepStrictEqual(projectCandidate({ id: 1, tags: { name: "x" } }).tag_names, []);
  });

  it("drops empty and whitespace-only tag names (contract honesty)", () => {
    const projected = projectCandidate({ id: 1, tags: ["", "  ", "Real", { id: 9, name: "" }] });
    assert.deepStrictEqual(projected.tag_names, ["Real"]);
  });

  it("returns [] for an empty tags array", () => {
    assert.deepStrictEqual(projectCandidate({ id: 1, tags: [] }).tag_names, []);
  });

  it("defensively reads .name from a legacy {id, name} object form", () => {
    const projected = projectCandidate({
      id: 1,
      tags: [{ id: 10, name: "X" }, { id: 20, name: "Y" }],
    });
    assert.deepStrictEqual(projected.tag_names, ["X", "Y"]);
  });

  it("skips entries with no usable name (missing/non-string name, scalars, null)", () => {
    const projected = projectCandidate({
      id: 1,
      tags: [
        "Referral",
        { id: 10 }, // legacy object missing a name
        { id: 20, name: 42 }, // non-string name
        null,
        123, // non-string scalar
        "Watch",
      ],
    });
    assert.deepStrictEqual(projected.tag_names, ["Referral", "Watch"]);
  });

  it("carries the tag NAMES through (v3: names are the intended payload)", () => {
    // Under v3 the tag names ARE the payload (inverted from the old ids-only
    // design that dropped names). Assert the names are present in tag_names.
    const projected = projectCandidate({
      id: 1,
      tags: ["Referral hygiene tag"],
    });
    const serialized = JSON.stringify(projected);
    assert.deepStrictEqual(projected.tag_names, ["Referral hygiene tag"]);
    assert.ok(
      serialized.includes("Referral hygiene tag"),
      "v3 tag names are intentionally exposed via tag_names"
    );
  });
});

// ---------------------------------------------------------------------------
// v3 shape regression (#H)
//
// A v3-shaped candidate has `tags` as plain strings and no embedded `applications`
// (the handler injects them separately). When applications are NOT injected, the
// projection surfaces tag_names and a null stage_snapshot (honest "not fetched").
// ---------------------------------------------------------------------------

describe("projectCandidate — v3 shape regression (#H)", () => {
  it("v3 candidate (string tags, no injected applications) → tag_names exposed, stage_snapshot null", () => {
    const projected = projectCandidate({
      id: 90210,
      last_activity_at: "2026-04-20T12:00:00Z",
      tags: ["Referral", "Watch"],
      private: false,
    });
    assert.deepStrictEqual(projected.tag_names, ["Referral", "Watch"]);
    assert.equal(
      projected.stage_snapshot,
      null,
      "with no applications injected, stage_snapshot is the honest null, not a fabricated empty"
    );
    assert.equal(projected.id, 90210);
    assert.equal(projected.last_activity_at, "2026-04-20T12:00:00Z");
    assert.equal(projected.private, false);
  });
});

// ---------------------------------------------------------------------------
// projectCandidatesArray — array handling
// ---------------------------------------------------------------------------

describe("projectCandidatesArray — array handling", () => {
  it("projects each element and preserves order", () => {
    const raw = [
      { id: 1, last_activity_at: "2026-04-20T00:00:00Z", private: true },
      { id: 2 },
      { id: 3, private: false },
    ];
    const projected = projectCandidatesArray(raw);
    assert.equal(projected.length, 3);
    assert.equal(projected[0]!.id, 1);
    assert.equal(projected[0]!.private, true);
    assert.equal(projected[1]!.id, 2);
    assert.equal(projected[2]!.id, 3);
  });

  it("returns [] for non-array inputs without throwing", () => {
    assert.deepStrictEqual(projectCandidatesArray(null), []);
    assert.deepStrictEqual(projectCandidatesArray(undefined), []);
    assert.deepStrictEqual(projectCandidatesArray({ data: [] }), []);
    assert.deepStrictEqual(projectCandidatesArray("not an array"), []);
    assert.deepStrictEqual(projectCandidatesArray(42), []);
  });

  it("returns [] for an empty array", () => {
    assert.deepStrictEqual(projectCandidatesArray([]), []);
  });
});

describe("projectCandidate — contact detail profile", () => {
  it("broadens the candidate projection to contact fields and attachment metadata", () => {
    const projected = projectCandidate(RAW_CANDIDATE_WITH_PII, {
      detailProfile: "contact",
    });

    assert.equal(projected.first_name, "Jane");
    assert.equal(projected.last_name, "Doe");
    assert.equal(projected.full_name, "Jane Doe");
    assert.equal(projected.primary_email, "jane.doe@example.com");
    assert.equal(projected.primary_phone, "+15551234567");
    assert.equal(projected.linkedin_url, "https://www.linkedin.com/in/janedoe");
    assert.equal(projected.location, "123 Main St, Springfield");
    assert.deepStrictEqual(projected.attachments, [
      {
        filename: "jane-doe-resume.pdf",
        type: "resume",
        created_at: null,
        url: null,
      },
    ]);
  });

  it("only includes signed attachment urls when explicitly requested", () => {
    const projected = projectCandidate(RAW_CANDIDATE_WITH_PII, {
      detailProfile: "contact",
      includeAttachmentUrls: true,
    });

    assert.equal(
      projected.attachments[0]?.url,
      "https://s3.amazonaws.com/gh-attachments/signed-url-example"
    );
  });
});

// ---------------------------------------------------------------------------
// §7.3 exclusion-rule contract tests
//
// Uses JSON-key prefix assertions (e.g. `"candidate":`) rather than bare
// substring to avoid false positives when allowlisted field names contain
// forbidden substrings:
//   - allowlisted `tag_names` contains `tag`
//   - allowlisted `last_activity_at` contains `activity`
// Lesson carried forward from slices 1–3.
//
// Note (#H): v3 tag NAMES are now intentionally exposed via `tag_names`, so
// tag-name content is no longer asserted absent. The full raw `tags` array,
// `applications`, and the candidate PII surface remain forbidden.
// ---------------------------------------------------------------------------

describe("projectCandidate — stage_snapshot pipeline state (#H)", () => {
  it("derives one entry per injected application with v3 stage + operational fields", () => {
    const projected = projectCandidate({
      id: 1,
      applications: [
        { id: 100, job_id: 10, stage_id: 7, stage_name: "Phone screen", status: "in_process", created_at: "2026-01-01T00:00:00Z", last_activity_at: "2026-02-01T00:00:00Z", needs_decision: true, rejected_at: null, source_id: 3, referrer_id: 4 },
        { id: 101, job_id: 20, stage_id: 9, stage_name: "Offer", status: "rejected", created_at: "2026-01-05T00:00:00Z", last_activity_at: "2026-02-10T00:00:00Z", needs_decision: false, rejected_at: "2026-02-10T00:00:00Z", source_id: null, referrer_id: null },
      ],
    });
    assert.deepStrictEqual(projected.stage_snapshot, [
      { application_id: 100, job_id: 10, stage_id: 7, stage_name: "Phone screen", status: "in_process", applied_at: "2026-01-01T00:00:00Z", last_activity_at: "2026-02-01T00:00:00Z", needs_decision: true, rejected_at: null, source_id: 3, referrer_id: 4 },
      { application_id: 101, job_id: 20, stage_id: 9, stage_name: "Offer", status: "rejected", applied_at: "2026-01-05T00:00:00Z", last_activity_at: "2026-02-10T00:00:00Z", needs_decision: false, rejected_at: "2026-02-10T00:00:00Z", source_id: null, referrer_id: null },
    ]);
  });

  it("reads stage from nested current_stage and job_id from nested jobs[] (defensive); absent operational fields → null", () => {
    const projected = projectCandidate({
      id: 1,
      applications: [
        { id: 100, jobs: [{ id: 10 }], current_stage: { id: 7, name: "Phone screen" }, status: "in_process" },
      ],
    });
    assert.deepStrictEqual(projected.stage_snapshot, [
      { application_id: 100, job_id: 10, stage_id: 7, stage_name: "Phone screen", status: "in_process", applied_at: null, last_activity_at: null, needs_decision: null, rejected_at: null, source_id: null, referrer_id: null },
    ]);
  });

  it("returns null when applications were not injected (honest unknown, not a fabricated empty)", () => {
    assert.equal(projectCandidate({ id: 1 }).stage_snapshot, null);
    assert.equal(projectCandidate({ id: 1, applications: "not-an-array" }).stage_snapshot, null);
    assert.equal(projectCandidate({ id: 1, applications: null }).stage_snapshot, null);
  });

  it("returns [] when the candidate has zero applications", () => {
    assert.deepStrictEqual(projectCandidate({ id: 1, applications: [] }).stage_snapshot, []);
  });

  it("carries only the allowlisted operational fields into the snapshot — never application answers or PII", () => {
    const projected = projectCandidate({
      id: 1,
      applications: [
        {
          id: 100,
          job_id: 10,
          stage_id: 7,
          stage_name: "Phone screen",
          status: "in_process",
          answers: [{ question: "Q", answer: "SECRET-ANSWER" }],
          custom_fields: { rating: "do-not-leak" },
        },
      ],
    });
    assert.deepStrictEqual(Object.keys(projected.stage_snapshot![0]!).sort(), [
      "application_id",
      "applied_at",
      "job_id",
      "last_activity_at",
      "needs_decision",
      "referrer_id",
      "rejected_at",
      "source_id",
      "stage_id",
      "stage_name",
      "status",
    ]);
    const serialized = JSON.stringify(projected.stage_snapshot);
    assert.ok(!serialized.includes("SECRET-ANSWER"), "application answer leaked into stage_snapshot");
    assert.ok(!serialized.includes("do-not-leak"), "application custom field leaked into stage_snapshot");
  });
});

describe("projectCandidate — §7.3 exclusion rule (contract tests)", () => {
  it("drops first_name, last_name, contact info, nested candidate PII, full applications, nested recruiter/coordinator", () => {
    const projected = projectCandidate(RAW_CANDIDATE_WITH_PII);
    const forbiddenKeys = [
      "first_name",
      "last_name",
      "company",
      "title",
      "email_addresses",
      "phone_numbers",
      "addresses",
      "social_media_addresses",
      "website_addresses",
      "applications",
      "educations",
      "employments",
      "attachments",
      "custom_fields",
      "keyed_custom_fields",
      "tags", // raw tags array; `tag_names` is the allowlisted form
      "recruiter",
      "coordinator",
      "created_at",
      "updated_at",
      "photo_url",
      "can_email",
      "is_private",
      "application_ids",
    ];
    for (const key of forbiddenKeys) {
      assert.ok(
        !(key in (projected as Record<string, unknown>)),
        `§7.3 exclusion: forbidden key "${key}" present in projected output`
      );
    }
  });

  it("drops unknown future Harvest fields silently", () => {
    const projected = projectCandidate({
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
    assert.equal(Object.keys(projected).length, 5);
  });

  it("forbidden JSON-key prefixes never appear in the serialized projection (key-level exclusion)", () => {
    const projected = projectCandidate(RAW_CANDIDATE_WITH_PII);
    const serialized = JSON.stringify(projected);

    // Key-prefix form: these JSON key prefixes would only appear if
    // the forbidden field were actually projected. Allowlisted
    // `tag_names` contains "tag"; allowlisted `last_activity_at`
    // contains "activity". The contract tests use exact key prefix
    // form.
    const forbiddenKeyPrefixes = [
      '"first_name":',
      '"last_name":',
      '"company":',
      '"title":',
      '"email_addresses":',
      '"phone_numbers":',
      '"addresses":',
      '"social_media_addresses":',
      '"website_addresses":',
      '"applications":',
      '"educations":',
      '"employments":',
      '"attachments":',
      '"custom_fields":',
      '"keyed_custom_fields":',
      '"tags":',
      '"recruiter":',
      '"coordinator":',
      '"created_at":',
      '"updated_at":',
      '"photo_url":',
      '"can_email":',
      '"is_private":',
      '"application_ids":',
    ];
    for (const prefix of forbiddenKeyPrefixes) {
      assert.ok(
        !serialized.includes(prefix),
        `§7.3 exclusion: serialized projection leaked forbidden key ${prefix}`
      );
    }
  });

  it("candidate names, emails, phone numbers, LinkedIn URLs, tag names, and custom-field content never appear in the serialized projection", () => {
    const projected = projectCandidate(RAW_CANDIDATE_WITH_PII);
    const serialized = JSON.stringify(projected);

    const forbiddenContent = [
      // Candidate identity / contact
      "Jane",
      "Doe",
      "jane.doe@example.com",
      "+15551234567",
      "linkedin.com",
      "janedoe.example.com",
      "Main St",
      "Springfield",
      "Current Employer",
      "Senior Engineer",
      // Q&A prose
      "Strong platform background",
      // Employment / education / attachment
      "Example University",
      "BS Computer Science",
      "jane-doe-resume.pdf",
      "s3.amazonaws.com",
      "signed-url-example",
      // NOTE (#H): tag names ("Reference: Senator Foo", "LinkedIn-sourced",
      // "Watch") are NOT forbidden — v3 exposes them intentionally via
      // tag_names. Their presence is asserted in the retention block below.
      // Nested recruiter / coordinator identity
      "Jane Recruiter",
      "Sam Coordinator",
      "jane.recruiter@example.com",
      "alex.coordinator@example.com",
      // Custom-field content
      "Sensitive operator annotation",
      "Within band",
      "salary_expectation",
    ];
    for (const token of forbiddenContent) {
      assert.ok(
        !serialized.includes(token),
        `§7.3 exclusion: serialized projection leaked PII content "${token}": ${serialized}`
      );
    }

    // And the allowlisted metadata IS retained — proves the test is
    // actually checking content rather than trivially passing.
    assert.equal(projected.id, 70015);
    assert.equal(projected.last_activity_at, "2026-04-20T12:00:00Z");
    // v3 tag NAMES are the allowlisted payload (#H).
    assert.deepStrictEqual(projected.tag_names, [
      "Reference: Senator Foo",
      "LinkedIn-sourced",
      "Watch",
    ]);
    assert.equal(projected.private, false);
    // stage_snapshot IS derived from the candidate's applications (#H): pipeline
    // state — application_id/job_id/stage_id/stage_name/status — is intentionally
    // exposed, so the stage NAMES from the fixture's applications appear here.
    assert.ok(Array.isArray(projected.stage_snapshot) && projected.stage_snapshot!.length === 3);
    assert.deepStrictEqual(
      projected.stage_snapshot!.map((entry) => [entry.stage_name, entry.status]),
      [
        ["Technical screen", "active"],
        ["Phone screen", "active"],
        ["Offer", "rejected"],
      ]
    );
    // But the application PII the projection must NOT carry stays out of stage_snapshot:
    // the free-text Q&A answer ("Strong platform background", asserted in the content
    // loop above) is never read, and the raw `applications` array key never appears.
    assert.ok(
      !serialized.includes("Strong platform background"),
      "application free-text answers must not leak via stage_snapshot"
    );
    assert.ok(
      !serialized.includes('"answers":'),
      "application answers key must not leak via stage_snapshot"
    );
  });

  it("projectCandidatesArray applied to a mixed batch keeps the exclusion invariant per element", () => {
    const projected = projectCandidatesArray([
      RAW_CANDIDATE_WITH_PII,
      {
        id: 2,
        first_name: "Other",
        last_name: "Candidate",
        email_addresses: [{ value: "other@example.com" }],
        tags: ["Other hygiene tag"],
      },
      null,
      { id: 3 },
    ]);
    const serialized = JSON.stringify(projected);

    const forbiddenKeyPrefixes = [
      '"first_name":',
      '"last_name":',
      '"email_addresses":',
      '"phone_numbers":',
      '"tags":',
      '"applications":',
      '"recruiter":',
      '"coordinator":',
    ];
    for (const prefix of forbiddenKeyPrefixes) {
      assert.ok(
        !serialized.includes(prefix),
        `§7.3 exclusion: array projection leaked field key ${prefix}`
      );
    }

    const forbiddenContent = [
      "Other Candidate",
      "other@example.com",
      "Jane",
      "Doe",
    ];
    for (const token of forbiddenContent) {
      assert.ok(
        !serialized.includes(token),
        `§7.3 exclusion: array projection leaked PII content "${token}"`
      );
    }

    // The v3 tag name IS exposed via tag_names (#H) — its presence proves the
    // per-element tag_names derivation runs across the batch.
    assert.deepStrictEqual(projected[1]!.tag_names, ["Other hygiene tag"]);
    assert.ok(
      serialized.includes("Other hygiene tag"),
      "v3 tag names are intentionally surfaced via tag_names"
    );
  });
});

// ---------------------------------------------------------------------------
// §7.4 Tier-2 silence-contract tests
//
// Scoped strictly to slice-4 owned surfaces:
//   - projectCandidatesArray (batch, the handler's actual path)
//   - projectCandidate (exported singular helper, for future pair-slice reuse)
// These tests do NOT cover get_candidate handler behavior — that remains
// out of scope for slice 4. A future pair slice will own any handler-level
// silence assertion for get_candidate.
// ---------------------------------------------------------------------------

describe("projectCandidatesArray / projectCandidate — §7.4 Tier-2 silence contract", () => {
  it("projecting a batch of candidates via projectCandidatesArray emits no READ_AUDIT line", () => {
    const spy = captureStderr();
    try {
      const projected = projectCandidatesArray([
        RAW_CANDIDATE_WITH_PII,
        { id: 2, private: false },
        { id: 3 },
      ]);
      assert.equal(projected.length, 3);

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

  it("calling projectCandidate on a single raw record in isolation emits no READ_AUDIT line", () => {
    // This proves the helper itself carries no audit-emit path, not
    // that the get_candidate handler is silent. The get_candidate
    // handler is out of scope for slice 4.
    const spy = captureStderr();
    try {
      const projected = projectCandidate(RAW_CANDIDATE_WITH_PII);
      assert.equal(projected.id, 70015);

      const readAuditLines = spy.lines.filter((l) =>
        l.startsWith("[greenhouse-mcp] READ_AUDIT")
      );
      assert.equal(
        readAuditLines.length,
        0,
        "Tier-2 silence: projectCandidate helper must not emit"
      );
    } finally {
      spy.restore();
    }
  });

  it("defensive inputs to either exported function emit no READ_AUDIT line", () => {
    const spy = captureStderr();
    try {
      projectCandidatesArray(null);
      projectCandidatesArray(undefined);
      projectCandidatesArray({ not: "an array" });
      projectCandidatesArray("scalar");

      projectCandidate(null);
      projectCandidate(undefined);
      projectCandidate("scalar");
      projectCandidate([1, 2, 3]);

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
