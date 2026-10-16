/**
 * The one place each analysis recipe's CLOCK is written in words.
 *
 * "window_start" used to mean three different things across the surface — a freshness lookback on
 * pipeline_quality, a created_at floor on the scorecard recipes, an attribution range on
 * source_quality — and the model-facing text said none of it. Every place that describes a recipe's
 * window (the registered tool description, the register.ts parameter descriptions, and the
 * get_recruiting_capabilities recipe entry) reads these constants, so the three copies can no longer
 * drift from each other or from the code.
 *
 * This module imports nothing on purpose: it is read by src/tools/* AND by
 * src/resolvers/job-scope/capabilities.ts, and an import of its own would risk a cycle between them.
 */

/** analyze_pipeline_quality: two different clocks in one result, said out loud. */
export const PIPELINE_QUALITY_CLOCK =
  "Status mix and staleness are a snapshot of current state; weekly inflow is bucketed by application created date over the window.";

/** analyze_scorecard_accountability / analyze_interview_feedback_drag: one clock, with its fallback. */
export const SCORECARD_WINDOW_CLOCK =
  "Windowed on the interview date, or the submission date when no interview date is recorded.";

/** register.ts parameter copy for the scorecard recipes' window bounds. */
export const SCORECARD_WINDOW_START_PARAM =
  "Inclusive ISO timestamp/date for the analysis window start. The window selects scorecards by interview date, or by submission date when no interview date is recorded. Defaults to 30 days before window_end.";
export const SCORECARD_WINDOW_END_PARAM =
  "Inclusive ISO timestamp/date for the analysis window end, on the same interview-date (or submission-date) clock as window_start. Defaults to now.";

/** register.ts parameter copy for pipeline_quality's two clocks. */
export const PIPELINE_WINDOW_START_PARAM =
  "Inclusive ISO timestamp/date for the start of the weekly application-inflow window (bucketed by application created date). Status mix and staleness are not windowed — they are a snapshot of current state. Defaults to 90 days before window_end, capped by runtime limits.";
export const PIPELINE_WINDOW_END_PARAM =
  "Inclusive ISO timestamp/date for the end of the weekly application-inflow window. It does NOT rewind the snapshot: /v3/applications returns current rows, so status mix and staleness are always as of now. Defaults to now.";
