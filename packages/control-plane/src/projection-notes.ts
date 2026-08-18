// Projection for the Greenhouse MCP `list_notes` tool (P2.2 / S4 slice 1).
//
// Returns only the 8-field minimal allowlist defined in
// docs/greenhouse-mcp-output-doctrine.md §3 (the `list_notes` row):
// {id, type, visibility, user_id, created_at, application_id,
// candidate_id, has_body}. No other field — including body, subject,
// to/cc/bcc/from, nested user objects, or any future Harvest field —
// passes through to the MCP tool result.
//
// Policy anchors:
//   - docs/greenhouse-mcp-projection-slice-1-spec.md §§4, 5.2
//   - docs/greenhouse-mcp-output-doctrine.md §3 (list_notes row) and §1
//     "needed Tier 2/3 → keep and project"
//   - docs/greenhouse-mcp-projection-post-slice-5-decision-spec.md §4
//     (Path A) — this module migrated to the shared engine in
//     projection-shared.ts. Public API (ProjectedNote, projectNote,
//     projectNotesArray) is unchanged; only the internal helpers
//     moved.
//
// Design notes:
//   - The allowlist is enforced by construction: the projection
//     functions copy exactly the named fields into a freshly-shaped
//     object. Unknown source fields are silently dropped, not forwarded.
//     Widening the allowlist therefore requires a visible type change
//     here plus a doctrine §3 edit.
//   - `has_body` is computed from the raw `body` string; the body
//     itself never appears in the output. The computation is
//     deterministic: `true` iff `body` is a non-empty, non-whitespace
//     string (spec §5.4 `has_body` computation rule). This helper
//     stays local to this module per decision spec §3.1 row 3:
//     `has_*` derivation is a one-user-in-five-modules pattern and
//     does not pay for shared abstraction.

import {
  isProjectableObject,
  normalizeNumberOrNull,
  normalizeStringOrNull,
  projectArray,
} from "./projection-shared.js";

/**
 * Allowlisted shape returned to the model turn for every `list_notes`
 * record. Adding a field here requires a corresponding doctrine §3
 * update and a fresh review of the exclusion-rule tests.
 */
export interface ProjectedNote {
  id: number | null;
  type: string | null;
  visibility: string | null;
  user_id: number | null;
  created_at: string | null;
  application_id: number | null;
  candidate_id: number | null;
  has_body: boolean;
}

export interface ProjectedNoteBody extends ProjectedNote {
  subject: string | null;
  body: string | null;
}

export interface NoteProjectionOptions {
  detailProfile?: "minimal" | "body";
}

/**
 * Deterministic `has_body` computation per spec §5.4:
 *   has_body = typeof raw.body === "string" && raw.body.trim().length > 0
 *
 * Any non-string `body` value (null, undefined, object, number) is
 * treated as "no body". A whitespace-only body is also "no body"
 * because it conveys nothing operationally.
 *
 * Stays local to this module: the `has_*` derivation pattern has a
 * single user across the five landed slices (decision spec §3.1
 * row 3).
 */
function computeHasBody(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Project a single raw Greenhouse note into the 8-field allowlist.
 * Non-object or null inputs return a fully-null / false shape rather
 * than throwing; this keeps the projection robust against defensive
 * failures at the call site (e.g., a Harvest response that is
 * unexpectedly sparse).
 */
export function projectNote(raw: unknown): ProjectedNote;
export function projectNote(
  raw: unknown,
  options: NoteProjectionOptions & { detailProfile: "body" }
): ProjectedNoteBody;
export function projectNote(
  raw: unknown,
  options?: NoteProjectionOptions
): ProjectedNote | ProjectedNoteBody {
  const detailProfile = options?.detailProfile ?? "minimal";
  if (!isProjectableObject(raw)) {
    const base: ProjectedNote = {
      id: null,
      type: null,
      visibility: null,
      user_id: null,
      created_at: null,
      application_id: null,
      candidate_id: null,
      has_body: false,
    };
    if (detailProfile === "body") {
      return {
        ...base,
        subject: null,
        body: null,
      };
    };
    return base;
  }

  const base: ProjectedNote = {
    id: normalizeNumberOrNull(raw.id),
    type: normalizeStringOrNull(raw.type),
    visibility: normalizeStringOrNull(raw.visibility),
    user_id: normalizeNumberOrNull(raw.user_id),
    created_at: normalizeStringOrNull(raw.created_at),
    application_id: normalizeNumberOrNull(raw.application_id),
    candidate_id: normalizeNumberOrNull(raw.candidate_id),
    has_body: computeHasBody(raw.body),
  };

  if (detailProfile !== "body") {
    return base;
  }

  return {
    ...base,
    subject: normalizeStringOrNull(raw.subject),
    body: normalizeStringOrNull(raw.body),
  };
}

/**
 * Project an array of raw notes into an array of ProjectedNote. When
 * the input is not an array (null, undefined, object, scalar), returns
 * an empty array rather than throwing; the call site uses this output
 * to compute the read-audit `result_size_class`, and an empty array
 * maps cleanly to `"empty"`.
 */
export function projectNotesArray(raw: unknown): ProjectedNote[];
export function projectNotesArray(
  raw: unknown,
  options: NoteProjectionOptions & { detailProfile: "body" }
): ProjectedNoteBody[];
export function projectNotesArray(
  raw: unknown,
  options?: NoteProjectionOptions
): ProjectedNote[] | ProjectedNoteBody[] {
  return projectArray(raw, (entry) => projectNote(entry, options as any));
}
