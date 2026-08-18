import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  projectScorecard,
  projectScorecardsArray,
  type ProjectedScorecard,
} from "../src/projection-scorecards.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALLOWED_KEYS = new Set<keyof ProjectedScorecard>([
  "id",
  "application_id",
  "interviewer_id",
  "submitter_id",
  "status",
  "submitted_at",
  "overall_rating",
  "interviewed_at",
]);

// A realistic Harvest /scorecards record that deliberately includes
// sensitive fields the projection must drop: free-text per-question
// answers, attribute ratings with commentary, nested interviewer /
// candidate / application / submitter objects, and a hypothetical
// future field.
const RAW_SCORECARD_WITH_PII = Object.freeze({
  id: 8801,
  application_id: 55501,
  interviewer_id: 42,
  submitter_id: 43,
  status: "complete",
  submitted_at: "2026-04-20T12:34:56.789Z",
  interviewed_at: "2026-04-18T14:00:00Z",
  // v3 Harvest fields (the API this adapter actually calls): rating is
  // `candidate_rating`; free text is in notes/public_notes/private_notes.
  candidate_rating: "strong_yes",
  notes: "Strong candidate. Detailed multi-paragraph writeup of the interview goes here.",
  public_notes: "Shareable summary of the evaluation.",
  private_notes: "Comp expectations may be a stretch.",
  // v1 alternate rating field (candidate_rating should win on v3):
  overall_recommendation: "yes",
  // Forbidden nested / prose surfaces. Per the Harvest docs, free-text
  // feedback (including "Key Take-Aways" and "Private Notes") lives in
  // questions[]; each entry is { id, question, answer }.
  questions: [
    {
      id: null,
      question: "Key Take-Aways",
      answer: "Jane solved the DP problem with a clean O(n log n) approach.",
    },
    {
      id: 1234567,
      question: "Systems design?",
      answer: "Walked through pubsub fan-out with back-of-envelope capacity numbers.",
    },
  ],
  // attributes[]: { name, type, note, rating } — rating is a STRING enum.
  attributes: [
    { name: "Communication", type: "Skills", rating: "yes", note: "Very clear." },
    { name: "Collaboration", type: "Skills", rating: "strong_yes", note: "Asked clarifying questions." },
  ],
  ratings: { strong_yes: ["Collaboration"], yes: ["Communication"] },
  interview: {
    id: 991,
    name: "Technical screen",
    start_time: "2026-04-18T14:00:00Z",
  },
  interviewer: {
    id: 42,
    name: "Jane Interviewer",
    email: "jane.interviewer@example.com",
  },
  submitted_by: {
    id: 43,
    name: "Sam Submitter",
    email: "alex.submitter@example.com",
  },
  candidate: {
    id: 70015,
    first_name: "Jane",
    last_name: "Doe",
    email: "jane.doe@example.com",
  },
  application: {
    id: 55501,
    candidate_id: 70015,
    job_id: 333,
  },
  created_at: "2026-04-18T15:00:00Z",
  updated_at: "2026-04-20T12:35:00Z",
  // hypothetical future field Greenhouse may add
  new_future_field: "definitely not allowlisted",
});

// ---------------------------------------------------------------------------
// Unit tests for projectScorecard
// ---------------------------------------------------------------------------

describe("projectScorecard — §4 operational allowlist shape", () => {
  it("returns exactly the operational allowlist keys, no more, no less", () => {
    const projected = projectScorecard(RAW_SCORECARD_WITH_PII);
    const keys = Object.keys(projected).sort();
    assert.deepStrictEqual(
      keys,
      [
        "application_id",
        "id",
        "interviewed_at",
        "interviewer_id",
        "overall_rating",
        "status",
        "submitted_at",
        "submitter_id",
      ],
      "projectScorecard output must contain exactly the operational allowlist keys"
    );
    for (const key of Object.keys(projected)) {
      assert.ok(
        ALLOWED_KEYS.has(key as keyof ProjectedScorecard),
        `unexpected key "${key}" in projected output`
      );
    }
  });

  it("preserves id, application_id, interviewer_id, submitter_id, status, submitted_at, overall_rating", () => {
    const projected = projectScorecard(RAW_SCORECARD_WITH_PII);
    assert.equal(projected.id, 8801);
    assert.equal(projected.application_id, 55501);
    assert.equal(projected.interviewer_id, 42);
    assert.equal(projected.submitter_id, 43);
    assert.equal(projected.status, "complete");
    assert.equal(projected.submitted_at, "2026-04-20T12:34:56.789Z");
    assert.equal(projected.overall_rating, "strong_yes");
  });

  it("normalizes absent id fields to null", () => {
    const projected = projectScorecard({ status: "draft" });
    assert.equal(projected.id, null);
    assert.equal(projected.application_id, null);
    assert.equal(projected.interviewer_id, null);
    assert.equal(projected.submitter_id, null);
  });

  it("normalizes absent string fields to null", () => {
    const projected = projectScorecard({ id: 1 });
    assert.equal(projected.status, null);
    assert.equal(projected.submitted_at, null);
    assert.equal(projected.overall_rating, null);
  });

  it("submitted_at is null for draft scorecards (Harvest returns null / absent)", () => {
    const projected = projectScorecard({
      id: 1,
      status: "draft",
      submitted_at: null,
    });
    assert.equal(projected.status, "draft");
    assert.equal(projected.submitted_at, null);
  });

  it("status passes through verbatim for common Harvest values and unknown future strings", () => {
    for (const status of ["complete", "draft", "SOME_FUTURE_STATUS"]) {
      assert.equal(projectScorecard({ id: 1, status }).status, status);
    }
  });

  it("overall_rating passes through verbatim for documented enum values", () => {
    for (const rating of [
      "strong_yes",
      "yes",
      "mixed",
      "no",
      "strong_no",
      "definitely_not",
      "no_decision",
    ]) {
      assert.equal(
        projectScorecard({ id: 1, overall_rating: rating }).overall_rating,
        rating
      );
    }
  });

  it("overall_rating falls back to null when non-string (e.g., numeric)", () => {
    assert.equal(projectScorecard({ id: 1, overall_rating: 5 }).overall_rating, null);
    assert.equal(projectScorecard({ id: 1, overall_rating: null }).overall_rating, null);
  });

  it("rejects non-numeric id-ish fields without throwing", () => {
    const projected = projectScorecard({
      id: "stringified",
      application_id: NaN,
      interviewer_id: Infinity,
      submitter_id: null,
    });
    assert.equal(projected.id, null);
    assert.equal(projected.application_id, null);
    assert.equal(projected.interviewer_id, null);
    assert.equal(projected.submitter_id, null);
  });

  it("rejects non-object input without throwing", () => {
    for (const input of [null, undefined, 0, "scorecard", true, [], [1, 2, 3]]) {
      const projected = projectScorecard(input as unknown);
      assert.deepStrictEqual(Object.keys(projected).sort(), [
        "application_id",
        "id",
        "interviewed_at",
        "interviewer_id",
        "overall_rating",
        "status",
        "submitted_at",
        "submitter_id",
      ]);
      assert.equal(projected.id, null);
      assert.equal(projected.status, null);
      assert.equal(projected.overall_rating, null);
    }
  });

  it("reads the rating tolerant of API version: candidate_rating (v3) > overall_recommendation (v1) > overall_rating", () => {
    // This adapter calls Greenhouse v3, where the rating is `candidate_rating`.
    assert.equal(
      projectScorecard({ id: 1, candidate_rating: "strong_yes" }).overall_rating,
      "strong_yes"
    );
    // v1 fallback.
    assert.equal(
      projectScorecard({ id: 1, overall_recommendation: "yes" }).overall_rating,
      "yes"
    );
    // Legacy fallback.
    assert.equal(
      projectScorecard({ id: 1, overall_rating: "mixed" }).overall_rating,
      "mixed"
    );
    // v3 wins when multiple present.
    assert.equal(
      projectScorecard({
        id: 1,
        candidate_rating: "no",
        overall_recommendation: "yes",
        overall_rating: "strong_yes",
      }).overall_rating,
      "no",
      "candidate_rating (v3) wins"
    );
  });

  it("surfaces v3 free-text feedback fields (notes / public_notes / private_notes) in the answers profile", () => {
    const projected = projectScorecard(
      {
        id: 1,
        notes: "Detailed interview writeup here.",
        public_notes: "Shareable summary.",
        private_notes: "Private aside.",
      },
      { detailProfile: "answers" }
    );
    assert.equal(projected.notes, "Detailed interview writeup here.");
    assert.equal(projected.public_notes, "Shareable summary.");
    assert.equal(projected.private_notes, "Private aside.");
  });

  it("does NOT surface v3 notes fields under the operational profile", () => {
    const projected = projectScorecard({ id: 1, notes: "secret writeup" }) as Record<string, unknown>;
    assert.ok(!("notes" in projected), "notes leaked into operational projection");
  });

  it("resolves interviewer_id / submitter_id from nested objects when flat ids are absent", () => {
    // Harvest's canonical scorecard nests these as interviewer:{id} and
    // submitted_by:{id}; some surfaces also expose flat ids. Prefer flat,
    // fall back to nested.
    const nested = projectScorecard({
      id: 1,
      interviewer: { id: 821, name: "Robert Robertson" },
      submitted_by: { id: 4080, name: "Kate Austen" },
    });
    assert.equal(nested.interviewer_id, 821);
    assert.equal(nested.submitter_id, 4080);
    // Flat ids take precedence when both are present.
    const flat = projectScorecard({
      id: 1,
      interviewer_id: 42,
      interviewer: { id: 821 },
    });
    assert.equal(flat.interviewer_id, 42);
  });

  it("reads interviewed_at (the v3 interview-completion clock for time-to-submit)", () => {
    assert.equal(
      projectScorecard({ id: 1, interviewed_at: "2026-05-01T10:00:00Z" }).interviewed_at,
      "2026-05-01T10:00:00Z"
    );
    assert.equal(projectScorecard({ id: 1 }).interviewed_at, null);
  });
});

// ---------------------------------------------------------------------------
// Unit tests for projectScorecardsArray
// ---------------------------------------------------------------------------

describe("projectScorecardsArray — array handling", () => {
  it("projects each element and preserves order", () => {
    const raw = [
      { id: 1, status: "complete", overall_rating: "yes" },
      { id: 2, status: "draft", submitted_at: null },
      { id: 3 },
    ];
    const projected = projectScorecardsArray(raw);
    assert.equal(projected.length, 3);
    assert.equal(projected[0]!.id, 1);
    assert.equal(projected[0]!.status, "complete");
    assert.equal(projected[0]!.overall_rating, "yes");
    assert.equal(projected[1]!.id, 2);
    assert.equal(projected[1]!.submitted_at, null);
    assert.equal(projected[2]!.id, 3);
    assert.equal(projected[2]!.status, null);
  });

  it("returns [] for non-array inputs without throwing", () => {
    assert.deepStrictEqual(projectScorecardsArray(null), []);
    assert.deepStrictEqual(projectScorecardsArray(undefined), []);
    assert.deepStrictEqual(projectScorecardsArray({ data: [] }), []);
    assert.deepStrictEqual(projectScorecardsArray("not an array"), []);
    assert.deepStrictEqual(projectScorecardsArray(42), []);
  });

  it("returns [] for an empty array", () => {
    assert.deepStrictEqual(projectScorecardsArray([]), []);
  });
});

describe("projectScorecard — answers detail profile", () => {
  it("surfaces free-text feedback via questions[] including the 'Key Take-Aways' writeup", () => {
    const projected = projectScorecard(RAW_SCORECARD_WITH_PII, {
      detailProfile: "answers",
    });
    // Per the Harvest docs, free-form interview feedback lives in
    // questions[] as { id, question, answer } — including the entry named
    // "Key Take-Aways". A free-form scorecard's writeup is reachable here.
    assert.deepStrictEqual(projected.questions, [
      {
        question: "Key Take-Aways",
        answer: "Jane solved the DP problem with a clean O(n log n) approach.",
      },
      {
        question: "Systems design?",
        answer: "Walked through pubsub fan-out with back-of-envelope capacity numbers.",
      },
    ]);
  });

  it("surfaces attributes[] with string ratings and type", () => {
    const projected = projectScorecard(RAW_SCORECARD_WITH_PII, {
      detailProfile: "answers",
    });
    // attributes[] ratings are STRING enums (yes/strong_yes/...), not numbers.
    assert.deepStrictEqual(projected.attributes, [
      { name: "Communication", type: "Skills", rating: "yes", note: "Very clear." },
      { name: "Collaboration", type: "Skills", rating: "strong_yes", note: "Asked clarifying questions." },
    ]);
  });

  it("does NOT surface questions/attributes under the operational (default) profile", () => {
    const projected = projectScorecard(RAW_SCORECARD_WITH_PII) as Record<string, unknown>;
    assert.ok(!("questions" in projected), "questions leaked into operational projection");
    assert.ok(!("attributes" in projected), "attributes leaked into operational projection");
  });
});

// ---------------------------------------------------------------------------
// §7.2 exclusion-rule contract tests
//
// These guard the allowlist against regressions that widen the projected
// surface. Each test drives a deliberately PII-loaded input and asserts
// that the forbidden material never reaches the projected output.
//
// Uses JSON-key prefix assertions (e.g., `"questions":`) rather than bare
// substring to avoid false positives when allowlisted field names contain
// forbidden substrings (e.g., allowlisted `interviewer_id` contains
// `interviewer`, allowlisted `application_id` contains `application`).
// Lesson carried forward from slice 1's early test bug.
// ---------------------------------------------------------------------------

describe("projectScorecard — §7.2 exclusion rule (contract tests)", () => {
  it("drops questions, attributes, ratings, nested interview/interviewer/submitter/candidate/application objects", () => {
    const projected = projectScorecard(RAW_SCORECARD_WITH_PII);
    const forbiddenKeys = [
      "questions",
      "attributes",
      "ratings",
      "interview",
      "interviewer",
      "submitter",
      "candidate",
      "application",
      "created_at",
      "updated_at",
    ];
    for (const key of forbiddenKeys) {
      assert.ok(
        !(key in (projected as Record<string, unknown>)),
        `§7.2 exclusion: forbidden key "${key}" present in projected output`
      );
    }
  });

  it("drops unknown future Harvest fields silently", () => {
    const projected = projectScorecard({
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
    assert.equal(Object.keys(projected).length, 8);
  });

  it("forbidden JSON-key prefixes never appear in the serialized projection (key-level exclusion)", () => {
    const projected = projectScorecard(RAW_SCORECARD_WITH_PII);
    const serialized = JSON.stringify(projected);

    // Key-prefix form: these JSON key prefixes would only appear if the
    // forbidden field were actually projected. Allowlisted `interviewer_id`
    // and `application_id` contain the substrings "interviewer" and
    // "application", so we check for the exact key prefix form to avoid
    // a false positive.
    const forbiddenKeyPrefixes = [
      '"questions":',
      '"attributes":',
      '"ratings":',
      '"interview":',
      '"interviewer":',
      '"submitter":',
      '"candidate":',
      '"application":',
      '"created_at":',
      '"updated_at":',
    ];
    for (const prefix of forbiddenKeyPrefixes) {
      assert.ok(
        !serialized.includes(prefix),
        `§7.2 exclusion: serialized projection leaked forbidden key ${prefix}`
      );
    }
  });

  it("free-text question answers and candidate/interviewer names never appear in the serialized projection", () => {
    const projected = projectScorecard(RAW_SCORECARD_WITH_PII);
    const serialized = JSON.stringify(projected);

    const forbiddenContent = [
      "Jane solved the DP problem",
      "O(n log n)",
      "Would hire immediately",
      "pubsub fan-out",
      "Very clear",
      "Asked clarifying questions",
      "Jane Interviewer",
      "Sam Submitter",
      "Jane Doe",
      "jane.interviewer@example.com",
      "alex.submitter@example.com",
      "jane.doe@example.com",
      "Technical screen",
      "Algorithmic strength",
      "Systems design",
      "Communication",
      "Collaboration",
    ];
    for (const token of forbiddenContent) {
      assert.ok(
        !serialized.includes(token),
        `§7.2 exclusion: serialized projection leaked PII content "${token}"`
      );
    }

    // And confirm the allowlisted metadata IS retained — proves the test
    // is actually checking content rather than trivially passing.
    assert.equal(projected.id, 8801);
    assert.equal(projected.application_id, 55501);
    assert.equal(projected.interviewer_id, 42);
    assert.equal(projected.overall_rating, "strong_yes");
  });

  it("projectScorecardsArray applied to a mixed batch keeps the exclusion invariant per element", () => {
    const projected = projectScorecardsArray([
      RAW_SCORECARD_WITH_PII,
      {
        id: 2,
        status: "draft",
        questions: [{ question: "Other sensitive question", answer: "Other answer" }],
        interviewer: { name: "Other Interviewer", email: "other@example.com" },
      },
      null,
      { id: 3 },
    ]);
    const serialized = JSON.stringify(projected);

    const forbiddenKeyPrefixes = [
      '"questions":',
      '"attributes":',
      '"ratings":',
      '"interview":',
      '"interviewer":',
      '"submitter":',
      '"candidate":',
      '"application":',
    ];
    for (const prefix of forbiddenKeyPrefixes) {
      assert.ok(
        !serialized.includes(prefix),
        `§7.2 exclusion: array projection leaked field key ${prefix}`
      );
    }

    const forbiddenContent = [
      "Other sensitive question",
      "Other answer",
      "Other Interviewer",
      "other@example.com",
      "Jane solved the DP problem",
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
