// Projection for the Greenhouse MCP `list_rejection_details` tool (P2.2 / S4 slice 5).
//
// Returns only the 4-field operational allowlist defined in
// docs/greenhouse-mcp-output-doctrine.md §3 (the
// `list_rejection_details` row):
// {application_id, reason_id, rejected_at, rejected_by}. No other
// field — including the rejection-notes prose, the full nested
// rejection-reason label, the full nested rejecting-user object,
// nested application/candidate inline objects, or any future Harvest
// field — passes through to the MCP tool result.
//
// Policy anchors:
//   - docs/greenhouse-mcp-projection-slice-5-spec.md §§4, 4.1, 5.2
//   - docs/greenhouse-mcp-output-doctrine.md §3 (list_rejection_details
//     row, Tier 3 operational default) and §1 "needed Tier 2/3 → keep
//     and project"
//   - docs/greenhouse-mcp-output-doctrine.md §7 Tier-3-audit
//     canonical rule: list_rejection_details is Tier 3 with audit
//     enabled at every profile. Per slice-5 spec §10 ownership
//     boundary, this projection module owns projection only — no
//     audit-helper imports here. The audit wiring lives at the
//     list_rejection_details handler call site in index.ts,
//     matching the slice-1/2 Tier-3-audited pattern.
//   - docs/greenhouse-mcp-projection-post-slice-5-decision-spec.md §4
//     (Path A) — this module migrated to the shared engine in
//     projection-shared.ts. Public API (ProjectedRejectionDetail,
//     projectRejectionDetail, projectRejectionDetailsArray) is
//     unchanged. The three-form `deriveRejectedBy` helper STAYS
//     local per decision spec §3.1 row 4: forcing slice 5's
//     three-form precedence through the shared two-form
//     `readFlatOrNestedScalar` would ossify a contract against
//     future unknown Harvest shapes.
//
// Design notes:
//   - The allowlist is enforced by construction: the projection
//     functions copy exactly the named fields into a freshly-shaped
//     object. Unknown source fields are silently dropped.
//   - `rejected_by` reads, in precedence order:
//       0. Harvest v3 flat `rejected_by_id: <number>` (the shape v3
//          actually returns; checked first)
//       1. flat scalar (`raw.rejected_by: <number>`)
//       2. nested object (`raw.rejected_by: {id: <number>, …}`)
//       3. alternate nested object (`raw.rejected_by_user: {id:
//          <number>, …}`)
//     The v3 flat id wins; the legacy forms remain as fallbacks for
//     non-v3 shapes. Only the numeric id is ever extracted — names,
//     emails, and any other nested user detail are dropped by the
//     allowlist regardless of which form Greenhouse returns.
//   - `reason_id` reads Harvest v3's flat `rejection_reason_id`, with
//     legacy `reason_id` as a fallback. The earlier code read only
//     `reason_id`, which v3 never emits, so the field was always null
//     on the live v3 path (#H).

import {
  isProjectableObject,
  normalizeNumberOrNull,
  normalizeStringOrNull,
  projectArray,
} from "./projection-shared.js";

/**
 * Allowlisted shape returned to the model turn for every
 * `list_rejection_details` record. Adding a field here requires a
 * corresponding doctrine §3 update and a fresh review of the
 * exclusion-rule tests.
 */
export interface ProjectedRejectionDetail {
  application_id: number | null;
  reason_id: number | null;
  rejected_at: string | null;
  rejected_by: number | null;
}

/**
 * Derive `rejected_by` for the rejecting-actor identifier. Covers
 * the Harvest v3 flat form plus three legacy/alternate forms:
 *   0. Harvest v3 flat: `raw.rejected_by_id: <number>` (checked first)
 *   1. flat scalar: `raw.rejected_by: <number>`
 *   2. nested object: `raw.rejected_by: {id: <number>, …}`
 *   3. alternate nested object: `raw.rejected_by_user: {id: <number>, …}`
 *
 * Rules:
 *   - The v3 flat `rejected_by_id` wins when present and valid.
 *   - Otherwise flat `rejected_by` scalar wins over either nested form.
 *   - Nested `rejected_by.id` is consulted if flat is invalid or
 *     non-numeric.
 *   - Alternate nested `rejected_by_user.id` is consulted only if
 *     neither flat nor nested `rejected_by` yields a valid id.
 *   - Any malformed shape (missing id, non-numeric id, arrays,
 *     non-object nested value, null) falls through to `null`.
 *   - Only the numeric id is ever extracted. Names, emails, and any
 *     other nested user detail are never returned.
 *
 * Defensive against Harvest schema variation: if a future Greenhouse
 * endpoint introduces a fourth shape for this field, the derivation
 * returns `null` rather than leaking unprojected data.
 *
 * Stays local to this module per decision spec §3.1 row 4: this is
 * a three-form precedence that the shared two-form
 * `readFlatOrNestedScalar` is deliberately NOT generalized to cover.
 * Generalizing to N-form would ossify a contract against future
 * unknown Harvest shapes.
 */
function deriveRejectedBy(raw: Record<string, unknown>): number | null {
  // Form 0 (Harvest v3): flat `rejected_by_id` — the shape v3 actually returns
  // (docs/harvest-v3-api/raw/reference/0150-get_v3-rejection-details.md). Checked first.
  const flatV3 = raw.rejected_by_id;
  if (typeof flatV3 === "number" && Number.isFinite(flatV3)) {
    return flatV3;
  }

  // Form 1: flat scalar `rejected_by` (legacy/alternate).
  const flat = raw.rejected_by;
  if (typeof flat === "number" && Number.isFinite(flat)) {
    return flat;
  }

  // Form 2: nested `rejected_by.id`.
  if (isProjectableObject(flat)) {
    const nestedId = flat.id;
    if (typeof nestedId === "number" && Number.isFinite(nestedId)) {
      return nestedId;
    }
  }

  // Form 3: alternate nested `rejected_by_user.id`.
  const altNested = raw.rejected_by_user;
  if (isProjectableObject(altNested)) {
    const altId = altNested.id;
    if (typeof altId === "number" && Number.isFinite(altId)) {
      return altId;
    }
  }

  return null;
}

/**
 * Project a single raw Greenhouse rejection-detail record into the
 * 4-field allowlist. Non-object inputs return a fully-null shape
 * rather than throwing; this keeps the projection robust against
 * defensive failures at the call site (e.g., a Harvest response
 * that is unexpectedly sparse).
 */
export function projectRejectionDetail(raw: unknown): ProjectedRejectionDetail {
  if (!isProjectableObject(raw)) {
    return {
      application_id: null,
      reason_id: null,
      rejected_at: null,
      rejected_by: null,
    };
  }

  return {
    application_id: normalizeNumberOrNull(raw.application_id),
    // Harvest v3 names this `rejection_reason_id` (flat); `reason_id` is a legacy/alternate
    // fallback. The projected output field stays `reason_id` per the doctrine §3 allowlist.
    reason_id: normalizeNumberOrNull(raw.rejection_reason_id ?? raw.reason_id),
    rejected_at: normalizeStringOrNull(raw.rejected_at),
    rejected_by: deriveRejectedBy(raw),
  };
}

/**
 * Project an array of raw rejection-detail records into an array of
 * ProjectedRejectionDetail. When the input is not an array (null,
 * undefined, object, scalar), returns an empty array.
 */
export function projectRejectionDetailsArray(raw: unknown): ProjectedRejectionDetail[] {
  return projectArray(raw, projectRejectionDetail);
}
