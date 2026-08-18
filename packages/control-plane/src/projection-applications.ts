// Projection for the Greenhouse MCP `list_applications` tool (P2.2 / S4 slice 3).
//
// Returns only the operational allowlist defined in
// docs/greenhouse-mcp-output-doctrine.md §3 (the `list_applications` row):
// {id, candidate_id, job_id, stage_id, stage_name, status,
// last_activity_at}. `current_stage_at` was dropped (#H): it is a phantom field
// Harvest v3 never emits (absent from docs/harvest-v3-api/raw/reference/0015), so it
// was structurally null on every real record. No other field — including the
// full nested candidate object (names, emails, phone, LinkedIn URLs),
// nested job / current_stage objects, per-application free-text
// answers, attachments, or any future Harvest field — passes through
// to the MCP tool result.
//
// Policy anchors:
//   - docs/greenhouse-mcp-projection-slice-3-spec.md §§4, 5.2
//   - docs/greenhouse-mcp-output-doctrine.md §3 (list_applications row)
//     and §1 "needed Tier 2/3 → keep and project"
//   - docs/greenhouse-mcp-output-doctrine.md §7 Tier-2-silent rule:
//     list_applications is Tier 2 and emits no READ_AUDIT line in any
//     outcome. The projection lives in this module and the call-site
//     wiring; there is no audit emitter involved.
//   - docs/greenhouse-mcp-projection-post-slice-5-decision-spec.md §4
//     (Path A) — this module migrated to the shared engine in
//     projection-shared.ts. Public API (ProjectedApplication,
//     projectApplication, projectApplicationsArray) is unchanged;
//     the previously-local `readFlatOrNestedScalar` helper now
//     imports from the shared module.
//
// Design notes:
//   - The allowlist is enforced by construction: the projection
//     functions copy exactly the named fields into a freshly-shaped
//     object. Unknown source fields are silently dropped, not
//     forwarded.
//   - `job_id` derivation reuses deriveApplicationJobId from the shared
//     projection module, which handles flat `job_id` and legacy nested
//     `jobs[0].id` shapes.
//   - `stage_id` and `stage_name` read the flat fields first, then
//     fall back to nested `current_stage.id` / `current_stage.name`
//     via the shared `readFlatOrNestedScalar` two-form helper.
//   - No computed `has_*` boolean: the sensitive surface (nested
//     `candidate`, `answers[]`) is dropped entirely by the allowlist.

import {
  deriveApplicationJobId,
  isProjectableObject,
  normalizeNumberOrNull,
  normalizeStringOrNull,
  projectArray,
  readFlatOrNestedScalar,
} from "./projection-shared.js";

/**
 * Allowlisted shape returned to the model turn for every
 * `list_applications` record. Adding a field here requires a
 * corresponding doctrine §3 update and a fresh review of the
 * exclusion-rule tests.
 */
export interface ProjectedApplication {
  id: number | null;
  candidate_id: number | null;
  job_id: number | null;
  stage_id: number | null;
  stage_name: string | null;
  status: string | null;
  last_activity_at: string | null;
}

/**
 * Project a single raw Greenhouse application into the 8-field
 * allowlist. Non-object inputs return a fully-null shape rather than
 * throwing; this keeps the projection robust against defensive
 * failures at the call site (e.g., a Harvest response that is
 * unexpectedly sparse).
 */
export function projectApplication(raw: unknown): ProjectedApplication {
  if (!isProjectableObject(raw)) {
    return {
      id: null,
      candidate_id: null,
      job_id: null,
      stage_id: null,
      stage_name: null,
      status: null,
      last_activity_at: null,
    };
  }

  return {
    id: normalizeNumberOrNull(raw.id),
    candidate_id: normalizeNumberOrNull(raw.candidate_id),
    job_id: deriveApplicationJobId(raw),
    stage_id: readFlatOrNestedScalar(
      raw,
      "stage_id",
      "current_stage",
      "id",
      "number"
    ) as number | null,
    stage_name: readFlatOrNestedScalar(
      raw,
      "stage_name",
      "current_stage",
      "name",
      "string"
    ) as string | null,
    status: normalizeStringOrNull(raw.status),
    last_activity_at: normalizeStringOrNull(raw.last_activity_at),
  };
}

/**
 * Project an array of raw applications into an array of
 * ProjectedApplication. When the input is not an array (null,
 * undefined, object, scalar), returns an empty array rather than
 * throwing.
 */
export function projectApplicationsArray(raw: unknown): ProjectedApplication[] {
  return projectArray(raw, projectApplication);
}
