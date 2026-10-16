// Test-only helpers shared across the five per-tool
// test/projection-*.test.ts files (P2.2 / S4 post-slice-5
// shared-engine refactor).
//
// The test files each have a §N exclusion-rule describe block that
// asserts a JSON.stringify'd projection contains no forbidden
// top-level keys. The idiom is consistent across slices 1–5:
// wrap each forbidden raw field name as `"${name}":` and fail if
// that prefix appears anywhere in the serialized output. The prefix
// form rather than a bare substring is load-bearing: allowlisted
// fields like `candidate_id` contain the substring "candidate", so a
// bare-substring check would false-positive (lesson carried forward
// from slice 1's early test bug — see the comments in
// test/projection-scorecards.test.ts §7.2 describe block and
// test/projection-applications.test.ts §7.2 describe block).
//
// This helper centralizes that idiom so the five test files do not
// each re-derive it.

import assert from "node:assert/strict";

/**
 * Assert that no `"${key}":` JSON-key prefix appears in a
 * pre-serialized projection output. Fails with a helpful message
 * naming both the forbidden key and the serialized string that
 * leaked it.
 *
 * Expects `serialized` to be the output of `JSON.stringify(projected)`
 * (or the same on a projected array). Expects `forbiddenKeys` to be
 * raw Harvest field names (e.g. `["body", "subject", "to", "cc"]`);
 * the helper wraps each one as the JSON-key prefix form.
 *
 * @param serialized  The output of `JSON.stringify(projected)`.
 * @param forbiddenKeys  The raw Harvest field names that must NOT
 *   appear as a top-level (or nested) JSON key in the projection.
 * @param label  Optional prefix for the assertion failure message
 *   (e.g. `"§7.2 exclusion"`). Defaults to a generic label.
 */
export function assertNoForbiddenJsonKeys(
  serialized: string,
  forbiddenKeys: readonly string[],
  label = "projection exclusion"
): void {
  for (const key of forbiddenKeys) {
    const prefix = `"${key}":`;
    assert.ok(
      !serialized.includes(prefix),
      `${label}: serialized projection leaked forbidden key ${prefix}`
    );
  }
}
