// Projection for the Greenhouse MCP `list_scorecards` tool (P2.2 / S4 slice 2).
//
// Returns only the 7-field operational allowlist defined in
// docs/greenhouse-mcp-output-doctrine.md §3 (the `list_scorecards` row):
// {id, application_id, interviewer_id, submitter_id, status,
// submitted_at, overall_rating}. No other field — including
// per-question answers, attribute ratings, nested interviewer /
// candidate / submitter / interview / application objects, or any
// future Harvest field — passes through to the MCP tool result.
//
// Policy anchors:
//   - docs/greenhouse-mcp-projection-slice-2-spec.md §§4, 5.2
//   - docs/greenhouse-mcp-output-doctrine.md §3 (list_scorecards row) and §1
//     "needed Tier 2/3 → keep and project"
//   - docs/greenhouse-mcp-projection-post-slice-5-decision-spec.md §4
//     (Path A) — this module migrated to the shared engine in
//     projection-shared.ts. Public API (ProjectedScorecard,
//     projectScorecard, projectScorecardsArray) is unchanged; only
//     the internal helpers moved.
//
// Design notes:
//   - The allowlist is enforced by construction: the projection
//     functions copy exactly the named fields into a freshly-shaped
//     object. Unknown source fields are silently dropped, not forwarded.
//     Widening the allowlist therefore requires a visible type change
//     here plus a doctrine §3 edit.
//   - No computed `has_*` boolean in this slice. `list_scorecards`'s
//     sensitive surface (per-question answers, attribute commentary)
//     lives inside `questions[]` and `attributes[]`, which the
//     allowlist drops entirely. A future `detail_profile: "answers"`
//     slice can decide whether to expose aggregate counts; slice 2
//     does not.

import {
  isProjectableObject,
  normalizeNumberOrNull,
  normalizeStringOrNull,
  projectArray,
} from "./projection-shared.js";

/**
 * Allowlisted shape returned to the model turn for every `list_scorecards`
 * record. Adding a field here requires a corresponding doctrine §3
 * update and a fresh review of the exclusion-rule tests.
 */
export interface ProjectedScorecard {
  id: number | null;
  application_id: number | null;
  interviewer_id: number | null;
  submitter_id: number | null;
  status: string | null;
  submitted_at: string | null;
  // The rating. THIS ADAPTER CALLS THE GREENHOUSE v3 API
  // (harvest.greenhouse.io/v3), where the field is `candidate_rating`. The
  // v1 Harvest API (developers.greenhouse.io) names it
  // `overall_recommendation`. `readScorecardRating` reads v3 first, then v1,
  // then a legacy `overall_rating` — so the projection is correct on either
  // surface. Verified live 2026-06-10 that this adapter is on v3.
  overall_rating: string | null;
  // The interview-completion clock on the scorecard, for time-to-submit.
  interviewed_at: string | null;
}

/**
 * One entry in the v1 Harvest scorecard's `questions[]` array
 * (`{ id, question, answer }`) — the v1 free-text surface, including
 * "Key Take-Aways"/"Private Notes". v3 does NOT use this array (it puts
 * free text in `notes`/`public_notes`/`private_notes`), but the projection
 * reads it too so it stays correct if pointed at a v1 surface.
 */
export interface ProjectedScorecardQuestion {
  question: string | null;
  answer: string | null;
}

/** One entry in the v1 `attributes[]` array (`{ name, type, note, rating }`); `rating` is a string enum. v3 omits this array. */
export interface ProjectedScorecardAttribute {
  name: string | null;
  type: string | null;
  rating: string | null;
  note: string | null;
}

/**
 * Gated full-content profile — the written interview feedback.
 *
 * v3 (this adapter's live API): free text is in `notes` / `public_notes` /
 * `private_notes` (top-level string fields). This is where a free-form
 * "Key takeaways" writeup lives.
 * v1: free text is in `questions[]` (+ skill ratings in `attributes[]`).
 *
 * The projection surfaces BOTH so recipes work on either surface; on v3 the
 * `questions`/`attributes` arrays come back empty and the text is in the
 * notes fields, and vice-versa. A recipe's `feedback_text` should union them.
 * Recipes must score/flag, never echo raw candidate-identifying feedback.
 */
export interface ProjectedScorecardAnswers extends ProjectedScorecard {
  // v3 free-text feedback:
  notes: string | null;
  public_notes: string | null;
  private_notes: string | null;
  // v1 structured feedback (empty on v3):
  questions: ProjectedScorecardQuestion[];
  attributes: ProjectedScorecardAttribute[];
}

export interface ScorecardProjectionOptions {
  detailProfile?: "operational" | "answers";
}

function projectQuestions(raw: unknown): ProjectedScorecardQuestion[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const questions: ProjectedScorecardQuestion[] = [];
  for (const entry of raw) {
    if (!isProjectableObject(entry)) {
      continue;
    }
    questions.push({
      question: normalizeStringOrNull(entry.question),
      answer: normalizeStringOrNull(entry.answer),
    });
  }
  return questions;
}

function projectAttributes(raw: unknown): ProjectedScorecardAttribute[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const attributes: ProjectedScorecardAttribute[] = [];
  for (const entry of raw) {
    if (!isProjectableObject(entry)) {
      continue;
    }
    attributes.push({
      name: normalizeStringOrNull(entry.name),
      type: normalizeStringOrNull(entry.type),
      rating: normalizeStringOrNull(entry.rating),
      note: normalizeStringOrNull(entry.note),
    });
  }
  return attributes;
}

/**
 * Project a single raw Greenhouse scorecard into the 7-field allowlist.
 * Non-object or null inputs return a fully-null shape rather than
 * throwing; this keeps the projection robust against defensive failures
 * at the call site (e.g., a Harvest response that is unexpectedly
 * sparse).
 */
export function projectScorecard(raw: unknown): ProjectedScorecard;
export function projectScorecard(
  raw: unknown,
  options: ScorecardProjectionOptions & { detailProfile: "answers" }
): ProjectedScorecardAnswers;
export function projectScorecard(
  raw: unknown,
  options?: ScorecardProjectionOptions
): ProjectedScorecard | ProjectedScorecardAnswers {
  const detailProfile = options?.detailProfile ?? "operational";
  if (!isProjectableObject(raw)) {
    const base: ProjectedScorecard = {
      id: null,
      application_id: null,
      interviewer_id: null,
      submitter_id: null,
      status: null,
      submitted_at: null,
      overall_rating: null,
      interviewed_at: null,
    };
    if (detailProfile === "answers") {
      return {
        ...base,
        notes: null,
        public_notes: null,
        private_notes: null,
        questions: [],
        attributes: [],
      };
    };
    return base;
  }

  const base: ProjectedScorecard = {
    id: normalizeNumberOrNull(raw.id),
    application_id: normalizeNumberOrNull(raw.application_id),
    interviewer_id: readNestedOrFlatId(raw, "interviewer_id", "interviewer"),
    submitter_id: readNestedOrFlatId(raw, "submitter_id", "submitted_by"),
    status: normalizeStringOrNull(raw.status),
    submitted_at: normalizeStringOrNull(raw.submitted_at),
    overall_rating: readScorecardRating(raw),
    interviewed_at: normalizeStringOrNull(raw.interviewed_at),
  };

  if (detailProfile !== "answers") {
    return base;
  }

  return {
    ...base,
    // v3 free-text feedback (where a free-form "Key takeaways" writeup lives):
    notes: normalizeStringOrNull(raw.notes),
    public_notes: normalizeStringOrNull(raw.public_notes),
    private_notes: normalizeStringOrNull(raw.private_notes),
    // v1 structured feedback (empty on v3):
    questions: projectQuestions(raw.questions),
    attributes: projectAttributes(raw.attributes),
  };
}

/**
 * Read the scorecard's overall rating, tolerant of API version. This adapter
 * is on Greenhouse v3, which names the field `candidate_rating`. The v1
 * Harvest API names it `overall_recommendation`. `overall_rating` is a final
 * legacy fallback. Read v3 first.
 */
function readScorecardRating(raw: Record<string, unknown>): string | null {
  return (
    normalizeStringOrNull(raw.candidate_rating) ??
    normalizeStringOrNull(raw.overall_recommendation) ??
    normalizeStringOrNull(raw.overall_rating)
  );
}

/**
 * Resolve an actor id that Harvest may expose either as a flat numeric id
 * (e.g. `interviewer_id`) or as a nested object with `.id` (e.g.
 * `interviewer: { id }` / `submitted_by: { id }`). Prefer the flat field,
 * fall back to the nested object's id.
 */
function readNestedOrFlatId(
  raw: Record<string, unknown>,
  flatKey: string,
  nestedKey: string
): number | null {
  const flat = normalizeNumberOrNull(raw[flatKey]);
  if (flat !== null) {
    return flat;
  }
  const nested = raw[nestedKey];
  if (isProjectableObject(nested)) {
    return normalizeNumberOrNull(nested.id);
  }
  return null;
}

/**
 * Project an array of raw scorecards into an array of ProjectedScorecard.
 * When the input is not an array (null, undefined, object, scalar),
 * returns an empty array rather than throwing; the call site uses this
 * output to compute the read-audit `result_size_class`, and an empty
 * array maps cleanly to `"empty"`.
 */
export function projectScorecardsArray(raw: unknown): ProjectedScorecard[];
export function projectScorecardsArray(
  raw: unknown,
  options: ScorecardProjectionOptions & { detailProfile: "answers" }
): ProjectedScorecardAnswers[];
export function projectScorecardsArray(
  raw: unknown,
  options?: ScorecardProjectionOptions
): ProjectedScorecard[] | ProjectedScorecardAnswers[] {
  return projectArray(raw, (entry) => projectScorecard(entry, options as any));
}
