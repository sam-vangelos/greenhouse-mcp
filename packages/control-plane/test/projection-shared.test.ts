import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeNumberOrNull,
  normalizeStringOrNull,
  normalizeBooleanDefaultFalse,
  isActiveApplicationStatus,
  isProjectableObject,
  readFlatOrNestedScalar,
  projectArray,
} from "../src/projection-shared.js";
import { assertNoForbiddenJsonKeys } from "./projection-test-helpers.js";

// ---------------------------------------------------------------------------
// normalizeNumberOrNull
// ---------------------------------------------------------------------------

describe("normalizeNumberOrNull", () => {
  it("preserves finite numbers including zero and negatives", () => {
    assert.equal(normalizeNumberOrNull(0), 0);
    assert.equal(normalizeNumberOrNull(42), 42);
    assert.equal(normalizeNumberOrNull(-7), -7);
    assert.equal(normalizeNumberOrNull(3.14), 3.14);
    assert.equal(normalizeNumberOrNull(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  });

  it("maps non-finite numbers to null", () => {
    assert.equal(normalizeNumberOrNull(Number.NaN), null);
    assert.equal(normalizeNumberOrNull(Number.POSITIVE_INFINITY), null);
    assert.equal(normalizeNumberOrNull(Number.NEGATIVE_INFINITY), null);
  });

  it("maps non-number types to null without throwing", () => {
    assert.equal(normalizeNumberOrNull("42"), null);
    assert.equal(normalizeNumberOrNull(""), null);
    assert.equal(normalizeNumberOrNull(true), null);
    assert.equal(normalizeNumberOrNull(false), null);
    assert.equal(normalizeNumberOrNull(null), null);
    assert.equal(normalizeNumberOrNull(undefined), null);
    assert.equal(normalizeNumberOrNull({}), null);
    assert.equal(normalizeNumberOrNull([]), null);
    assert.equal(normalizeNumberOrNull([42]), null);
  });
});

// ---------------------------------------------------------------------------
// normalizeStringOrNull
// ---------------------------------------------------------------------------

describe("normalizeStringOrNull", () => {
  it("preserves strings verbatim including empty string and whitespace", () => {
    assert.equal(normalizeStringOrNull(""), "");
    assert.equal(normalizeStringOrNull("   "), "   ");
    assert.equal(normalizeStringOrNull("hello"), "hello");
    assert.equal(normalizeStringOrNull("2026-04-20T12:00:00Z"), "2026-04-20T12:00:00Z");
  });

  it("maps non-string types to null without throwing", () => {
    assert.equal(normalizeStringOrNull(42), null);
    assert.equal(normalizeStringOrNull(0), null);
    assert.equal(normalizeStringOrNull(true), null);
    assert.equal(normalizeStringOrNull(false), null);
    assert.equal(normalizeStringOrNull(null), null);
    assert.equal(normalizeStringOrNull(undefined), null);
    assert.equal(normalizeStringOrNull({}), null);
    assert.equal(normalizeStringOrNull([]), null);
    assert.equal(normalizeStringOrNull(["hi"]), null);
  });
});

// ---------------------------------------------------------------------------
// normalizeBooleanDefaultFalse
// ---------------------------------------------------------------------------

describe("normalizeBooleanDefaultFalse", () => {
  it("preserves true/false booleans", () => {
    assert.equal(normalizeBooleanDefaultFalse(true), true);
    assert.equal(normalizeBooleanDefaultFalse(false), false);
  });

  it("defaults every non-boolean input to false (conservative policy)", () => {
    assert.equal(normalizeBooleanDefaultFalse(null), false);
    assert.equal(normalizeBooleanDefaultFalse(undefined), false);
    assert.equal(normalizeBooleanDefaultFalse(0), false);
    assert.equal(normalizeBooleanDefaultFalse(1), false);
    assert.equal(normalizeBooleanDefaultFalse("true"), false);
    assert.equal(normalizeBooleanDefaultFalse("false"), false);
    assert.equal(normalizeBooleanDefaultFalse(""), false);
    assert.equal(normalizeBooleanDefaultFalse({}), false);
    assert.equal(normalizeBooleanDefaultFalse([]), false);
  });
});

// ---------------------------------------------------------------------------
// isProjectableObject
// ---------------------------------------------------------------------------

describe("isActiveApplicationStatus", () => {
  it("treats both 'active' and 'in_process' as active", () => {
    assert.equal(isActiveApplicationStatus("active"), true);
    assert.equal(isActiveApplicationStatus("in_process"), true);
  });

  it("is tolerant of casing and surrounding whitespace", () => {
    assert.equal(isActiveApplicationStatus("In_Process"), true);
    assert.equal(isActiveApplicationStatus("  active  "), true);
    assert.equal(isActiveApplicationStatus("ACTIVE"), true);
  });

  it("treats terminal and unknown statuses as not active", () => {
    assert.equal(isActiveApplicationStatus("rejected"), false);
    assert.equal(isActiveApplicationStatus("hired"), false);
    assert.equal(isActiveApplicationStatus("converted"), false);
    assert.equal(isActiveApplicationStatus("prospect"), false);
  });

  it("treats non-string input as not active", () => {
    assert.equal(isActiveApplicationStatus(null), false);
    assert.equal(isActiveApplicationStatus(undefined), false);
    assert.equal(isActiveApplicationStatus(1), false);
    assert.equal(isActiveApplicationStatus({}), false);
  });
});

describe("isProjectableObject", () => {
  it("accepts plain objects (including empty and deeply nested)", () => {
    assert.equal(isProjectableObject({}), true);
    assert.equal(isProjectableObject({ id: 1 }), true);
    assert.equal(isProjectableObject({ nested: { deep: true } }), true);
    assert.equal(isProjectableObject(Object.create(null)), true);
  });

  it("rejects null, arrays, and primitives", () => {
    assert.equal(isProjectableObject(null), false);
    assert.equal(isProjectableObject(undefined), false);
    assert.equal(isProjectableObject([]), false);
    assert.equal(isProjectableObject([1, 2, 3]), false);
    assert.equal(isProjectableObject(42), false);
    assert.equal(isProjectableObject("object-like"), false);
    assert.equal(isProjectableObject(true), false);
    assert.equal(isProjectableObject(false), false);
  });

  it("narrows the input type for downstream property reads (compile-time contract)", () => {
    const raw: unknown = { id: 7, name: "example" };
    if (isProjectableObject(raw)) {
      // At this point `raw` is Record<string, unknown>; property
      // access compiles without a cast. Runtime equality is the
      // observable contract the call sites rely on.
      assert.equal(raw.id, 7);
      assert.equal(raw.name, "example");
    } else {
      assert.fail("isProjectableObject rejected a plain object");
    }
  });
});

// ---------------------------------------------------------------------------
// readFlatOrNestedScalar
// ---------------------------------------------------------------------------

describe("readFlatOrNestedScalar — two-form flat-vs-nested resolution", () => {
  it("reads a numeric flat field when present and finite", () => {
    const result = readFlatOrNestedScalar(
      { stage_id: 7, current_stage: { id: 99 } },
      "stage_id",
      "current_stage",
      "id",
      "number"
    );
    assert.equal(result, 7);
  });

  it("falls back to the nested numeric field when the flat field is absent", () => {
    const result = readFlatOrNestedScalar(
      { current_stage: { id: 99 } },
      "stage_id",
      "current_stage",
      "id",
      "number"
    );
    assert.equal(result, 99);
  });

  it("prefers flat over nested even when both are present and valid", () => {
    const result = readFlatOrNestedScalar(
      { stage_id: 7, current_stage: { id: 99 } },
      "stage_id",
      "current_stage",
      "id",
      "number"
    );
    assert.equal(result, 7);
  });

  it("falls back to nested when flat is present but non-finite or wrong type", () => {
    assert.equal(
      readFlatOrNestedScalar(
        { stage_id: Number.NaN, current_stage: { id: 99 } },
        "stage_id",
        "current_stage",
        "id",
        "number"
      ),
      99
    );
    assert.equal(
      readFlatOrNestedScalar(
        { stage_id: "7", current_stage: { id: 99 } },
        "stage_id",
        "current_stage",
        "id",
        "number"
      ),
      99
    );
  });

  it("returns null when neither flat nor nested yields a valid numeric value", () => {
    assert.equal(
      readFlatOrNestedScalar(
        {},
        "stage_id",
        "current_stage",
        "id",
        "number"
      ),
      null
    );
    assert.equal(
      readFlatOrNestedScalar(
        { current_stage: null },
        "stage_id",
        "current_stage",
        "id",
        "number"
      ),
      null
    );
    assert.equal(
      readFlatOrNestedScalar(
        { current_stage: { id: "not-a-number" } },
        "stage_id",
        "current_stage",
        "id",
        "number"
      ),
      null
    );
  });

  it("handles string-typed flat and nested fields symmetrically", () => {
    assert.equal(
      readFlatOrNestedScalar(
        { stage_name: "Onsite", current_stage: { name: "Other" } },
        "stage_name",
        "current_stage",
        "name",
        "string"
      ),
      "Onsite"
    );
    assert.equal(
      readFlatOrNestedScalar(
        { current_stage: { name: "Offer" } },
        "stage_name",
        "current_stage",
        "name",
        "string"
      ),
      "Offer"
    );
    assert.equal(
      readFlatOrNestedScalar(
        { stage_name: 42, current_stage: { name: "Offer" } },
        "stage_name",
        "current_stage",
        "name",
        "string"
      ),
      "Offer"
    );
  });

  it("rejects nested container that is an array or a non-object (defensive)", () => {
    assert.equal(
      readFlatOrNestedScalar(
        { current_stage: [{ id: 7 }] },
        "stage_id",
        "current_stage",
        "id",
        "number"
      ),
      null
    );
    assert.equal(
      readFlatOrNestedScalar(
        { current_stage: "stringified" },
        "stage_id",
        "current_stage",
        "id",
        "number"
      ),
      null
    );
    assert.equal(
      readFlatOrNestedScalar(
        { current_stage: 42 },
        "stage_id",
        "current_stage",
        "id",
        "number"
      ),
      null
    );
  });

  it("does not cross primitive-kinds: numeric expected rejects string values at both positions", () => {
    assert.equal(
      readFlatOrNestedScalar(
        { stage_id: "42", current_stage: { id: "99" } },
        "stage_id",
        "current_stage",
        "id",
        "number"
      ),
      null
    );
  });
});

// ---------------------------------------------------------------------------
// projectArray
// ---------------------------------------------------------------------------

describe("projectArray", () => {
  it("maps each element through the projector in order", () => {
    const identity = (x: unknown) => x as number;
    assert.deepStrictEqual(projectArray([1, 2, 3], identity), [1, 2, 3]);

    const double = (x: unknown) => (x as number) * 2;
    assert.deepStrictEqual(projectArray([1, 2, 3], double), [2, 4, 6]);
  });

  it("preserves per-element shape from a projector that emits objects", () => {
    const projectOne = (x: unknown): { id: number | null } => ({
      id: typeof x === "number" ? x : null,
    });
    assert.deepStrictEqual(
      projectArray([1, "nope", 3], projectOne),
      [{ id: 1 }, { id: null }, { id: 3 }]
    );
  });

  it("returns [] for non-array inputs without throwing", () => {
    const projectOne = () => ({ id: 0 });
    assert.deepStrictEqual(projectArray(null, projectOne), []);
    assert.deepStrictEqual(projectArray(undefined, projectOne), []);
    assert.deepStrictEqual(projectArray({}, projectOne), []);
    assert.deepStrictEqual(projectArray({ data: [] }, projectOne), []);
    assert.deepStrictEqual(projectArray("scalar", projectOne), []);
    assert.deepStrictEqual(projectArray(42, projectOne), []);
    assert.deepStrictEqual(projectArray(true, projectOne), []);
  });

  it("returns [] for an empty array without invoking the projector", () => {
    let called = false;
    const projectOne = () => {
      called = true;
      return { id: 0 };
    };
    assert.deepStrictEqual(projectArray([], projectOne), []);
    assert.equal(called, false);
  });

  it("does not filter falsy-projected values; the projector controls emission", () => {
    const projectOne = (x: unknown) => x;
    assert.deepStrictEqual(
      projectArray([0, null, "", false, undefined], projectOne),
      [0, null, "", false, undefined]
    );
  });
});

// ---------------------------------------------------------------------------
// assertNoForbiddenJsonKeys (test-helper contract)
// ---------------------------------------------------------------------------

describe("assertNoForbiddenJsonKeys", () => {
  it("passes silently when the serialized projection contains no forbidden keys", () => {
    const serialized = JSON.stringify({ id: 1, status: "active" });
    assert.doesNotThrow(() => {
      assertNoForbiddenJsonKeys(serialized, ["body", "subject", "user"]);
    });
  });

  it("throws a helpful message when a forbidden top-level key is present", () => {
    const serialized = JSON.stringify({ id: 1, body: "leaked prose" });
    assert.throws(
      () => assertNoForbiddenJsonKeys(serialized, ["body"]),
      /projection exclusion: serialized projection leaked forbidden key "body":/
    );
  });

  it("uses the prefix form to avoid false positives on allowlisted field names", () => {
    // Allowlisted `candidate_id` contains the substring "candidate".
    // A bare-substring check would false-positive; the prefix form
    // `"candidate":` does not.
    const serialized = JSON.stringify({ candidate_id: 42 });
    assert.doesNotThrow(() => {
      assertNoForbiddenJsonKeys(serialized, ["candidate"]);
    });
  });

  it("prefixes the assertion failure with the provided label when given", () => {
    const serialized = JSON.stringify({ id: 1, body: "leaked" });
    assert.throws(
      () => assertNoForbiddenJsonKeys(serialized, ["body"], "§4 exclusion"),
      /§4 exclusion: serialized projection leaked forbidden key "body":/
    );
  });

  it("checks every key in the forbidden list (not just the first)", () => {
    const serialized = JSON.stringify({ id: 1, subject: "leaked subject" });
    assert.throws(
      () => assertNoForbiddenJsonKeys(serialized, ["body", "subject", "user"]),
      /leaked forbidden key "subject":/
    );
  });

  it("detects forbidden keys in nested objects (JSON.stringify walks nesting)", () => {
    const serialized = JSON.stringify({
      id: 1,
      stage_snapshot: { active_application_count: 1, body: "leaked nested" },
    });
    assert.throws(
      () => assertNoForbiddenJsonKeys(serialized, ["body"]),
      /leaked forbidden key "body":/
    );
  });
});
