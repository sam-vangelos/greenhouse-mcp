import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  projectRejectionDetail,
  projectRejectionDetailsArray,
  type ProjectedRejectionDetail,
} from "../src/projection-rejection-details.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALLOWED_KEYS = new Set<keyof ProjectedRejectionDetail>([
  "application_id",
  "reason_id",
  "rejected_at",
  "rejected_by",
]);

/**
 * A realistic Harvest /rejection_details record that deliberately
 * includes the entire Tier-3 PII surface the projection must drop:
 * rejection-notes prose, the full nested rejection-reason label
 * object, a full nested rejecting-user object with name / email /
 * employee_id, an alternate nested `rejected_by_user` shape, a
 * nested `application` inline object, a nested `candidate` inline
 * object, custom fields, and a hypothetical future field.
 *
 * The fixture uses the nested `rejected_by` form to also verify that
 * `rejected_by.id` is extracted while name/email are dropped.
 */
const RAW_REJECTION_WITH_PII = Object.freeze({
  application_id: 111222,
  reason_id: 55,
  rejected_at: "2026-04-20T09:00:00Z",
  // Forbidden rejecting-user detail surface:
  rejected_by: {
    id: 9001,
    name: "Ada Lovelace",
    email: "ada@example.com",
    employee_id: "EMP-9001",
  },
  // Forbidden: nested rejection-reason label
  reason: {
    id: 55,
    name: "Not a culture fit",
    type: "pool",
  },
  // Forbidden: rejection-notes prose
  notes: "Strong technically but the panel flagged repeated friction with the design team; see sync notes from Thu.",
  // Forbidden: alternate nested user shape carrying PII
  rejected_by_user: {
    id: 9001,
    first_name: "Ada",
    last_name: "Lovelace",
    email_addresses: [{ value: "ada@example.com", type: "primary" }],
  },
  // Forbidden: nested application / candidate inline objects
  application: {
    id: 111222,
    candidate_id: 44445,
    status: "rejected",
  },
  candidate: {
    id: 44445,
    first_name: "Jane",
    last_name: "Doe",
  },
  // Forbidden: Harvest metadata + custom fields
  created_at: "2026-04-20T09:00:00Z",
  updated_at: "2026-04-20T09:05:00Z",
  custom_fields: {
    severity: { value: "high", type: "short_text" },
  },
  keyed_custom_fields: {
    severity: { value: "high", type: "short_text" },
  },
  // Forbidden: hypothetical future field the tool may add later
  decision_rationale_doc_url: "https://internal.example.com/rationale/abc",
});

// ---------------------------------------------------------------------------
// 7.1 — projectRejectionDetail: shape and null normalization
// ---------------------------------------------------------------------------

describe("projectRejectionDetail", () => {
  it("returns exactly the 4 allowlisted keys and nothing else", () => {
    const projected = projectRejectionDetail({
      application_id: 111222,
      reason_id: 55,
      rejected_at: "2026-04-20T09:00:00Z",
      rejected_by: 9001,
    });
    assert.deepEqual(Object.keys(projected).sort(), [
      "application_id",
      "reason_id",
      "rejected_at",
      "rejected_by",
    ]);
    for (const key of Object.keys(projected)) {
      assert.ok(
        ALLOWED_KEYS.has(key as keyof ProjectedRejectionDetail),
        `unexpected key leaked into projection: ${key}`,
      );
    }
  });

  it("preserves a full realistic rejection-detail record's allowed fields only", () => {
    const projected = projectRejectionDetail(RAW_REJECTION_WITH_PII);
    assert.deepEqual(projected, {
      application_id: 111222,
      reason_id: 55,
      rejected_at: "2026-04-20T09:00:00Z",
      rejected_by: 9001,
    });
  });

  it("preserves application_id as a number when present", () => {
    const projected = projectRejectionDetail({
      application_id: 111222,
      reason_id: 55,
      rejected_at: "2026-04-20T09:00:00Z",
    });
    assert.equal(projected.application_id, 111222);
  });

  it("normalizes a missing application_id to null", () => {
    const projected = projectRejectionDetail({
      reason_id: 55,
      rejected_at: "2026-04-20T09:00:00Z",
    });
    assert.equal(projected.application_id, null);
  });

  it("normalizes a non-numeric application_id to null", () => {
    const projected = projectRejectionDetail({
      application_id: "111222",
      reason_id: 55,
      rejected_at: "2026-04-20T09:00:00Z",
    });
    assert.equal(projected.application_id, null);
  });

  it("normalizes a non-finite application_id to null", () => {
    const projectedInfinity = projectRejectionDetail({
      application_id: Number.POSITIVE_INFINITY,
      reason_id: 55,
      rejected_at: "2026-04-20T09:00:00Z",
    });
    const projectedNaN = projectRejectionDetail({
      application_id: Number.NaN,
      reason_id: 55,
      rejected_at: "2026-04-20T09:00:00Z",
    });
    assert.equal(projectedInfinity.application_id, null);
    assert.equal(projectedNaN.application_id, null);
  });

  it("preserves reason_id as a number when present", () => {
    const projected = projectRejectionDetail({
      application_id: 111222,
      reason_id: 55,
      rejected_at: "2026-04-20T09:00:00Z",
    });
    assert.equal(projected.reason_id, 55);
  });

  it("normalizes a missing reason_id to null", () => {
    const projected = projectRejectionDetail({
      application_id: 111222,
      rejected_at: "2026-04-20T09:00:00Z",
    });
    assert.equal(projected.reason_id, null);
  });

  it("normalizes a non-numeric reason_id to null", () => {
    const projected = projectRejectionDetail({
      application_id: 111222,
      reason_id: "55",
      rejected_at: "2026-04-20T09:00:00Z",
    });
    assert.equal(projected.reason_id, null);
  });

  it("preserves rejected_at as a string when present", () => {
    const projected = projectRejectionDetail({
      application_id: 111222,
      reason_id: 55,
      rejected_at: "2026-04-20T09:00:00Z",
    });
    assert.equal(projected.rejected_at, "2026-04-20T09:00:00Z");
  });

  it("normalizes a missing rejected_at to null", () => {
    const projected = projectRejectionDetail({
      application_id: 111222,
      reason_id: 55,
    });
    assert.equal(projected.rejected_at, null);
  });

  it("normalizes a non-string rejected_at to null", () => {
    const projectedNumber = projectRejectionDetail({
      application_id: 111222,
      reason_id: 55,
      rejected_at: 1745143200,
    });
    const projectedObject = projectRejectionDetail({
      application_id: 111222,
      reason_id: 55,
      rejected_at: { iso: "2026-04-20T09:00:00Z" },
    });
    assert.equal(projectedNumber.rejected_at, null);
    assert.equal(projectedObject.rejected_at, null);
  });

  it("returns a fully-null shape for non-object input (null)", () => {
    assert.deepEqual(projectRejectionDetail(null), {
      application_id: null,
      reason_id: null,
      rejected_at: null,
      rejected_by: null,
    });
  });

  it("returns a fully-null shape for non-object input (undefined)", () => {
    assert.deepEqual(projectRejectionDetail(undefined), {
      application_id: null,
      reason_id: null,
      rejected_at: null,
      rejected_by: null,
    });
  });

  it("returns a fully-null shape for non-object input (scalar)", () => {
    assert.deepEqual(projectRejectionDetail(42), {
      application_id: null,
      reason_id: null,
      rejected_at: null,
      rejected_by: null,
    });
    assert.deepEqual(projectRejectionDetail("hello"), {
      application_id: null,
      reason_id: null,
      rejected_at: null,
      rejected_by: null,
    });
    assert.deepEqual(projectRejectionDetail(true), {
      application_id: null,
      reason_id: null,
      rejected_at: null,
      rejected_by: null,
    });
  });

  it("returns a fully-null shape for non-object input (array top-level)", () => {
    assert.deepEqual(projectRejectionDetail([{ application_id: 1 }]), {
      application_id: null,
      reason_id: null,
      rejected_at: null,
      rejected_by: null,
    });
  });
});

// ---------------------------------------------------------------------------
// 7.2 — rejected_by derivation contract (slice-5 spec §4.1)
// ---------------------------------------------------------------------------

describe("projectRejectionDetail — rejected_by derivation", () => {
  it("extracts a flat numeric scalar", () => {
    const projected = projectRejectionDetail({
      application_id: 1,
      reason_id: 2,
      rejected_at: "2026-04-20T09:00:00Z",
      rejected_by: 9001,
    });
    assert.equal(projected.rejected_by, 9001);
  });

  it("extracts rejected_by.id from a nested object", () => {
    const projected = projectRejectionDetail({
      application_id: 1,
      reason_id: 2,
      rejected_at: "2026-04-20T09:00:00Z",
      rejected_by: { id: 9001, name: "Ada Lovelace" },
    });
    assert.equal(projected.rejected_by, 9001);
  });

  it("extracts rejected_by_user.id from the alternate nested object when rejected_by is absent", () => {
    const projected = projectRejectionDetail({
      application_id: 1,
      reason_id: 2,
      rejected_at: "2026-04-20T09:00:00Z",
      rejected_by_user: { id: 9001, first_name: "Ada" },
    });
    assert.equal(projected.rejected_by, 9001);
  });

  it("prefers a valid flat scalar over a nested rejected_by object", () => {
    const projected = projectRejectionDetail({
      application_id: 1,
      reason_id: 2,
      rejected_at: "2026-04-20T09:00:00Z",
      rejected_by: 9001,
      rejected_by_user: { id: 8888 },
    });
    assert.equal(projected.rejected_by, 9001);
  });

  it("falls back to nested rejected_by.id when flat is not a finite number", () => {
    // `rejected_by` here is the nested object form — flat is not set.
    const projected = projectRejectionDetail({
      application_id: 1,
      reason_id: 2,
      rejected_at: "2026-04-20T09:00:00Z",
      rejected_by: { id: 9001 },
      rejected_by_user: { id: 8888 },
    });
    assert.equal(projected.rejected_by, 9001);
  });

  it("falls back to rejected_by_user.id when nested rejected_by lacks a numeric id", () => {
    const projected = projectRejectionDetail({
      application_id: 1,
      reason_id: 2,
      rejected_at: "2026-04-20T09:00:00Z",
      rejected_by: { name: "Ada Lovelace" },
      rejected_by_user: { id: 8888 },
    });
    assert.equal(projected.rejected_by, 8888);
  });

  it("returns null when nested rejected_by is a malformed object (no id)", () => {
    const projected = projectRejectionDetail({
      application_id: 1,
      reason_id: 2,
      rejected_at: "2026-04-20T09:00:00Z",
      rejected_by: { name: "Ada Lovelace" },
    });
    assert.equal(projected.rejected_by, null);
  });

  it("returns null when nested rejected_by.id is non-numeric", () => {
    const projected = projectRejectionDetail({
      application_id: 1,
      reason_id: 2,
      rejected_at: "2026-04-20T09:00:00Z",
      rejected_by: { id: "9001" },
    });
    assert.equal(projected.rejected_by, null);
  });

  it("returns null when both rejected_by and rejected_by_user are absent", () => {
    const projected = projectRejectionDetail({
      application_id: 1,
      reason_id: 2,
      rejected_at: "2026-04-20T09:00:00Z",
    });
    assert.equal(projected.rejected_by, null);
  });

  it("returns null when rejected_by is an array (defensive)", () => {
    const projected = projectRejectionDetail({
      application_id: 1,
      reason_id: 2,
      rejected_at: "2026-04-20T09:00:00Z",
      rejected_by: [9001],
    });
    assert.equal(projected.rejected_by, null);
  });

  it("returns null when rejected_by is explicitly null", () => {
    const projected = projectRejectionDetail({
      application_id: 1,
      reason_id: 2,
      rejected_at: "2026-04-20T09:00:00Z",
      rejected_by: null,
    });
    assert.equal(projected.rejected_by, null);
  });

  it("returns null when rejected_by.id is non-finite", () => {
    const projected = projectRejectionDetail({
      application_id: 1,
      reason_id: 2,
      rejected_at: "2026-04-20T09:00:00Z",
      rejected_by: { id: Number.POSITIVE_INFINITY },
    });
    assert.equal(projected.rejected_by, null);
  });

  it("never extracts nested user names or emails", () => {
    const projected = projectRejectionDetail({
      application_id: 1,
      reason_id: 2,
      rejected_at: "2026-04-20T09:00:00Z",
      rejected_by: {
        id: 9001,
        name: "Ada Lovelace",
        email: "ada@example.com",
      },
    });
    assert.equal(projected.rejected_by, 9001);
    const serialized = JSON.stringify(projected);
    assert.ok(!serialized.includes("Ada"));
    assert.ok(!serialized.includes("Lovelace"));
    assert.ok(!serialized.includes("@example.com"));
  });
});

// ---------------------------------------------------------------------------
// 7.3b — Harvest v3 flat-field contract (#H)
//
// The live v3 shape (docs/harvest-v3-api/raw/reference/0150-get_v3-rejection-details.md)
// is flat: {application_id, rejected_at, rejected_by_id, rejection_reason_id}. The
// earlier code read `reason_id` and three rejected_by forms — none of which v3 emits —
// so both analytic fields were structurally null on every real v3 record, inside a
// Tier-3 AUDITED tool that logged success over the gutted payload. The legacy fixtures
// above never exercised the v3 shape, so the suite stayed green over the bug.
// ---------------------------------------------------------------------------

describe("projectRejectionDetail — Harvest v3 flat fields (#H)", () => {
  const RAW_REJECTION_V3 = Object.freeze({
    application_id: 111222,
    rejection_reason_id: 55,
    rejected_at: "2026-04-20T09:00:00Z",
    rejected_by_id: 9001,
  });

  it("reads reason_id from the v3 flat rejection_reason_id", () => {
    assert.equal(projectRejectionDetail(RAW_REJECTION_V3).reason_id, 55);
  });

  it("reads rejected_by from the v3 flat rejected_by_id", () => {
    assert.equal(projectRejectionDetail(RAW_REJECTION_V3).rejected_by, 9001);
  });

  it("projects a complete v3 record with every analytic field populated", () => {
    assert.deepEqual(projectRejectionDetail(RAW_REJECTION_V3), {
      application_id: 111222,
      reason_id: 55,
      rejected_at: "2026-04-20T09:00:00Z",
      rejected_by: 9001,
    });
  });

  it("prefers the v3 flat rejected_by_id over a legacy nested rejected_by", () => {
    const projected = projectRejectionDetail({
      application_id: 1,
      rejection_reason_id: 2,
      rejected_at: "2026-04-20T09:00:00Z",
      rejected_by_id: 9001,
      rejected_by: { id: 8888 },
    });
    assert.equal(projected.rejected_by, 9001);
  });

  it("still reads legacy reason_id when v3 rejection_reason_id is absent (back-compat)", () => {
    const projected = projectRejectionDetail({
      application_id: 1,
      reason_id: 77,
      rejected_at: "2026-04-20T09:00:00Z",
      rejected_by: 42,
    });
    assert.equal(projected.reason_id, 77);
    assert.equal(projected.rejected_by, 42);
  });
});

// ---------------------------------------------------------------------------
// 7.2 continued — projectRejectionDetailsArray: array handling
// ---------------------------------------------------------------------------

describe("projectRejectionDetailsArray", () => {
  it("projects each record and preserves order", () => {
    const result = projectRejectionDetailsArray([
      {
        application_id: 111222,
        reason_id: 55,
        rejected_at: "2026-04-20T09:00:00Z",
        rejected_by: 9001,
      },
      {
        application_id: 111223,
        reason_id: 77,
        rejected_at: "2026-04-20T10:00:00Z",
        rejected_by: { id: 9002, name: "Grace Hopper" },
      },
    ]);
    assert.equal(result.length, 2);
    assert.equal(result[0]!.application_id, 111222);
    assert.equal(result[0]!.rejected_by, 9001);
    assert.equal(result[1]!.application_id, 111223);
    assert.equal(result[1]!.rejected_by, 9002);
  });

  it("returns an empty array for non-array input", () => {
    assert.deepEqual(projectRejectionDetailsArray(null), []);
    assert.deepEqual(projectRejectionDetailsArray(undefined), []);
    assert.deepEqual(projectRejectionDetailsArray("not-an-array"), []);
    assert.deepEqual(projectRejectionDetailsArray({ 0: { application_id: 1 } }), []);
    assert.deepEqual(projectRejectionDetailsArray(42), []);
  });

  it("returns an empty array for an empty array input", () => {
    assert.deepEqual(projectRejectionDetailsArray([]), []);
  });

  it("tolerates mixed valid and malformed records", () => {
    const result = projectRejectionDetailsArray([
      {
        application_id: 111222,
        reason_id: 55,
        rejected_at: "2026-04-20T09:00:00Z",
        rejected_by: 9001,
      },
      null,
      "not-an-object",
      {
        application_id: "not-a-number",
        reason_id: { nested: "bad" },
        rejected_at: 17451,
      },
    ]);
    assert.equal(result.length, 4);
    assert.equal(result[0]!.application_id, 111222);
    // null, string, and malformed entries all fall through to fully-null shapes
    assert.deepEqual(result[1], {
      application_id: null,
      reason_id: null,
      rejected_at: null,
      rejected_by: null,
    });
    assert.deepEqual(result[2], {
      application_id: null,
      reason_id: null,
      rejected_at: null,
      rejected_by: null,
    });
    assert.equal(result[3]!.application_id, null);
    assert.equal(result[3]!.reason_id, null);
    assert.equal(result[3]!.rejected_at, null);
  });
});

// ---------------------------------------------------------------------------
// 7.3 — exclusion-rule contract tests
//
// The allowlist is enforced by construction, but contract-level checks
// guard against future regressions and verify that specific sensitive
// surfaces never appear in the serialized projection. We use JSON-key
// prefix assertions (e.g., `"notes":`) rather than bare substrings to
// avoid false positives from the allowlisted keys themselves — e.g.,
// `application_id` legitimately contains the substring "application".
// ---------------------------------------------------------------------------

describe("projectRejectionDetail — exclusion rules", () => {
  it("never includes forbidden top-level keys in the projected output", () => {
    const projected = projectRejectionDetail(RAW_REJECTION_WITH_PII);
    const keys = Object.keys(projected);
    assert.ok(!keys.includes("notes"));
    assert.ok(!keys.includes("reason"));
    assert.ok(!keys.includes("rejected_by_user"));
    assert.ok(!keys.includes("application"));
    assert.ok(!keys.includes("candidate"));
    assert.ok(!keys.includes("created_at"));
    assert.ok(!keys.includes("updated_at"));
    assert.ok(!keys.includes("custom_fields"));
    assert.ok(!keys.includes("keyed_custom_fields"));
    assert.ok(!keys.includes("decision_rationale_doc_url"));
  });

  it("never includes forbidden JSON keys in the serialized projection", () => {
    const serialized = JSON.stringify(projectRejectionDetail(RAW_REJECTION_WITH_PII));
    // Use JSON-key prefix form to avoid matching allowlisted field substrings.
    assert.ok(!serialized.includes('"notes":'), "`notes` prose leaked");
    assert.ok(!serialized.includes('"reason":'), "nested `reason` label leaked");
    assert.ok(
      !serialized.includes('"rejected_by_user":'),
      "alternate nested `rejected_by_user` object leaked",
    );
    assert.ok(
      !serialized.includes('"application":'),
      "nested `application` inline object leaked",
    );
    assert.ok(
      !serialized.includes('"candidate":'),
      "nested `candidate` inline object leaked",
    );
    assert.ok(!serialized.includes('"created_at":'), "`created_at` metadata leaked");
    assert.ok(!serialized.includes('"updated_at":'), "`updated_at` metadata leaked");
    assert.ok(!serialized.includes('"custom_fields":'), "`custom_fields` leaked");
    assert.ok(
      !serialized.includes('"keyed_custom_fields":'),
      "`keyed_custom_fields` leaked",
    );
    assert.ok(
      !serialized.includes('"decision_rationale_doc_url":'),
      "future field `decision_rationale_doc_url` leaked",
    );
  });

  it("never includes rejection-notes prose content in the serialized projection", () => {
    const serialized = JSON.stringify(projectRejectionDetail(RAW_REJECTION_WITH_PII));
    // Content from the `notes` field in the fixture
    assert.ok(
      !serialized.includes("panel flagged"),
      "rejection-notes prose content leaked into projection",
    );
    assert.ok(
      !serialized.includes("sync notes from Thu"),
      "rejection-notes prose tail leaked into projection",
    );
  });

  it("never includes the nested rejection-reason label in the serialized projection", () => {
    const serialized = JSON.stringify(projectRejectionDetail(RAW_REJECTION_WITH_PII));
    assert.ok(
      !serialized.includes("Not a culture fit"),
      "nested `reason.name` label leaked into projection",
    );
    assert.ok(!serialized.includes('"type":"pool"'), "nested `reason.type` leaked");
  });

  it("never includes rejecting-user name or email in the serialized projection", () => {
    const serialized = JSON.stringify(projectRejectionDetail(RAW_REJECTION_WITH_PII));
    assert.ok(!serialized.includes("Ada"), "rejecting-user name leaked (via rejected_by)");
    assert.ok(
      !serialized.includes("Lovelace"),
      "rejecting-user last name leaked (via rejected_by_user)",
    );
    assert.ok(
      !serialized.includes("ada@example.com"),
      "rejecting-user email leaked into projection",
    );
    assert.ok(
      !serialized.includes("EMP-9001"),
      "rejecting-user employee_id leaked into projection",
    );
  });

  it("never includes nested application/candidate inline detail in the serialized projection", () => {
    const serialized = JSON.stringify(projectRejectionDetail(RAW_REJECTION_WITH_PII));
    // Candidate names from the fixture's nested `candidate` object
    assert.ok(!serialized.includes("Jane"), "nested candidate first_name leaked");
    assert.ok(!serialized.includes("Doe"), "nested candidate last_name leaked");
    // Application status from the fixture's nested `application` object must
    // never surface, either as a JSON key or as a JSON string value. The
    // allowlisted keys `rejected_at` and `rejected_by` both contain the
    // substring "rejected", so we check the value-position form `:"rejected"`
    // rather than a bare substring. The key-prefix check above guarantees
    // the key cannot surface either, so the value form cannot surface
    // through a projection key.
    assert.ok(
      !serialized.includes('"status":'),
      "nested application.status leaked as JSON key",
    );
    assert.ok(
      !serialized.includes(':"rejected"'),
      "nested application.status value leaked as JSON value",
    );
  });

  it("never includes custom fields in the serialized projection", () => {
    const serialized = JSON.stringify(projectRejectionDetail(RAW_REJECTION_WITH_PII));
    assert.ok(!serialized.includes("severity"), "custom-field key leaked");
    assert.ok(!serialized.includes('"short_text"'), "custom-field type leaked");
  });

  it("ignores unknown future fields on the raw record", () => {
    const projected = projectRejectionDetail({
      application_id: 111222,
      reason_id: 55,
      rejected_at: "2026-04-20T09:00:00Z",
      rejected_by: 9001,
      // Unknown future fields
      ai_risk_score: 0.87,
      internal_hiring_manager_channel: "slack://C01234",
      decision_audit_url: "https://internal.example.com/audit/xyz",
    });
    assert.deepEqual(Object.keys(projected).sort(), [
      "application_id",
      "reason_id",
      "rejected_at",
      "rejected_by",
    ]);
    const serialized = JSON.stringify(projected);
    assert.ok(!serialized.includes('"ai_risk_score":'), "unknown future field leaked");
    assert.ok(
      !serialized.includes('"internal_hiring_manager_channel":'),
      "unknown future field leaked",
    );
    assert.ok(
      !serialized.includes('"decision_audit_url":'),
      "unknown future field leaked",
    );
  });
});
