// Shared projection utilities for the Greenhouse MCP `list_*` tools
// (P2.2 / S4 post-slice-5 shared-engine refactor).
//
// Policy anchors:
//   - docs/greenhouse-mcp-projection-post-slice-5-decision-spec.md
//     §3 (what is actually shared across the five landed modules),
//     §4 (Path A concrete proposal — shape of the shared engine).
//   - docs/greenhouse-mcp-projection-slice-{1,2,3,4,5}-spec.md (the
//     landed per-tool contracts whose helpers this module subsumes).
//
// Design notes:
//   - This module owns ONLY pure projection utilities. It does not
//     import from `tool-gates.ts`, `read-audit.ts`, `client.ts`,
//     `auth.ts`, or `index.ts`. Handler orchestration
//     and audit wiring stay at the `index.ts` handler sites per the
//     post-slice-5 refinement: the five handler blocks are materially
//     different in shape (Tier-3-audited vs Tier-2-silent) and do not
//     share enough structure to justify a handler helper.
//   - Per-tool escape hatches stay in their original modules:
//     `computeHasBody` in projection-notes.ts (row 3 of the decision
//     spec), the three-form `deriveRejectedBy` in
//     projection-rejection-details.ts (row 4 genuinely-per-tool
//     half), `deriveTagIds` and `deriveStageSnapshot` in
//     projection-candidates.ts.
//   - `readFlatOrNestedScalar` is the slice-3 two-form helper. Slices
//     3 and 4 both use it (slice 4 binds `nestedObjectKey` to
//     `"current_stage"`). It is intentionally NOT generalized to a
//     three-form variant; slice 5's `deriveRejectedBy` keeps its
//     own precedence local because a universal three-form helper
//     would ossify a contract against future unknown Harvest shapes
//     (decision spec §3.1 row 4, §7 steelman).
//   - `isProjectableObject` is a type guard rather than a function
//     that returns a null-shape. The null-shape is each tool's
//     public contract (doctrine §3 row shape) and stays per-tool;
//     the shared helper only owns the guard predicate.

/**
 * Normalize a raw id-shaped value into `number | null`.
 *
 * Only finite JS numbers pass through. `NaN`, `Infinity`, strings,
 * booleans, `null`, and `undefined` all map to `null`.
 */
export function normalizeNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

/**
 * Normalize a raw string-shaped value into `string | null`.
 *
 * Only actual strings (including the empty string) pass through;
 * every other input type maps to `null`. Trimming and validation
 * are the caller's responsibility (e.g., `computeHasBody` in
 * projection-notes.ts trims its own input).
 */
export function normalizeStringOrNull(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  return null;
}

/**
 * Normalize a raw boolean-shaped value into `boolean` with a `false`
 * default.
 *
 * Used by projection-candidates.ts for the `private` field, which is
 * conservative by policy: any non-boolean input (null, undefined,
 * string "true", numeric 1) maps to `false` rather than to an
 * accidental `true`. See slice-4 spec §4: "any non-boolean input
 * maps to `false` (the common case: most candidates are not private)".
 */
export function normalizeBooleanDefaultFalse(value: unknown): boolean {
  return value === true;
}

/** Read an application's job id from the v3 flat form or legacy nested jobs form. */
export function deriveApplicationJobId(
  application: Record<string, unknown>
): number | null {
  const directJobId = application.job_id;
  if (typeof directJobId === "number" && Number.isFinite(directJobId)) {
    return directJobId;
  }

  const firstJob = Array.isArray(application.jobs) ? application.jobs[0] : null;
  if (
    firstJob !== null &&
    typeof firstJob === "object" &&
    !Array.isArray(firstJob) &&
    typeof (firstJob as { id?: unknown }).id === "number"
  ) {
    return (firstJob as { id: number }).id;
  }
  return null;
}

/**
 * The raw Greenhouse application `status` strings that mean "this
 * application is live in the pipeline."
 *
 * Greenhouse's documented/query-side vocabulary is `active`, but the
 * Harvest v3 API returns `in_process` on the wire for active
 * applications (see CLAUDE.md known issues). Both must count as active,
 * or any read/guard keyed on `status === "active"` silently treats a
 * fully-live pipeline as empty. Do NOT narrow this back to a single
 * value without verifying the live API response — the test fixtures use
 * `"active"`, so a single-string check passes tests while zeroing real
 * data.
 */
const ACTIVE_APPLICATION_STATUSES = new Set(["active", "in_process"]);

/**
 * True when a raw application `status` value denotes a live/active
 * application. Tolerant of casing and surrounding whitespace; non-string
 * input is not active.
 */
export function isActiveApplicationStatus(status: unknown): boolean {
  if (typeof status !== "string") {
    return false;
  }
  return ACTIVE_APPLICATION_STATUSES.has(status.trim().toLowerCase());
}

/**
 * Type guard for the "is this a plain object we can project from?"
 * predicate that every per-tool `projectOne` function uses as its
 * defensive opener. Rejects `null`, arrays, and primitives; accepts
 * any non-null non-array object.
 *
 * Usage pattern at each call site:
 *   if (!isProjectableObject(raw)) {
 *     return { ...tool-specific fully-null shape... };
 *   }
 *   const source = raw; // narrowed to Record<string, unknown>
 *
 * The null-shape itself stays per-tool because it is the tool's
 * public contract, tied to doctrine §3 row shape. See decision spec
 * §3.1 row 6.
 */
export function isProjectableObject(
  raw: unknown
): raw is Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}

/**
 * Read a property path with a flat-field-first, nested-fallback order.
 *
 * Used for fields that Harvest may return either as a flat scalar on
 * the root record or as part of a nested object (e.g. `stage_id`
 * flat vs `current_stage.id` nested in projection-applications.ts and
 * projection-candidates.ts). Neither path is authoritative; the flat
 * field wins when present and valid, otherwise the nested form is
 * consulted. If neither yields a valid value of the expected
 * primitive kind, returns `null`.
 *
 * This is deliberately a two-form helper. Slice 5's `deriveRejectedBy`
 * has three-form precedence (flat, nested `rejected_by.id`, alternate
 * nested `rejected_by_user.id`) and does NOT route through this
 * helper; extending this helper to N-form would ossify a contract
 * against future unknown Harvest shapes (decision spec §3.1 row 4
 * verdict).
 *
 * The `expected` parameter controls which primitive type is accepted
 * at both the flat and nested positions. The return type is the
 * union of both cases; callers cast to the specific type at the call
 * site, matching the pattern established in slice 3.
 */
export function readFlatOrNestedScalar(
  source: Record<string, unknown>,
  flatKey: string,
  nestedObjectKey: string,
  nestedScalarKey: string,
  expected: "number" | "string"
): number | string | null {
  const flat = source[flatKey];
  if (expected === "number") {
    if (typeof flat === "number" && Number.isFinite(flat)) {
      return flat;
    }
  } else if (typeof flat === "string") {
    return flat;
  }

  const nested = source[nestedObjectKey];
  if (isProjectableObject(nested)) {
    const nestedValue = nested[nestedScalarKey];
    if (expected === "number") {
      if (typeof nestedValue === "number" && Number.isFinite(nestedValue)) {
        return nestedValue;
      }
    } else if (typeof nestedValue === "string") {
      return nestedValue;
    }
  }

  return null;
}

/**
 * Project an array of raw records into an array of projected records.
 *
 * When the input is not an array (null, undefined, object, scalar),
 * returns an empty array rather than throwing. The call sites use
 * this output to compute the read-audit `result_size_class` (for
 * Tier-3-audited tools) or to pass through a cleanly-projected
 * `response.data` (for Tier-2-silent tools); an empty array maps
 * cleanly to `"empty"` in either case.
 *
 * Generic over the projected element type; the per-tool `projectOne`
 * function is passed in and determines the output shape.
 */
export function projectArray<T>(
  raw: unknown,
  projectOne: (raw: unknown) => T
): T[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map(projectOne);
}
