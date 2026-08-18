import { readPositiveInt } from "../limits.js";
import { readAnalysisLabel } from "./analysis-scalars.js";

export function readApplicationJobId(row: Record<string, unknown>): number | null {
  const direct = readPositiveInt(row.job_id);
  if (direct !== null) return direct;

  const nestedJob = row.job;
  if (isRecord(nestedJob)) {
    const id = readPositiveInt(nestedJob.id);
    if (id !== null) return id;
  }

  if (Array.isArray(row.jobs)) {
    for (const job of row.jobs) {
      if (!isRecord(job)) continue;
      const id = readPositiveInt(job.id);
      if (id !== null) return id;
    }
  }

  const application = row.application;
  return isRecord(application) ? readApplicationJobId(application) : null;
}

// Resolve the application's candidate id. v3 applications carry a top-level candidate_id (a required
// field per 0015-get_v3-applications.md); a nested `candidate: { id }` is honored as a fallback for any
// embed-shaped payload. Feeds the candidate-backed scope bridge (job scope -> applications -> candidates).
export function readApplicationCandidateId(row: Record<string, unknown>): number | null {
  const direct = readPositiveInt(row.candidate_id);
  if (direct !== null) return direct;

  const candidate = row.candidate;
  if (isRecord(candidate)) {
    const id = readPositiveInt(candidate.id);
    if (id !== null) return id;
  }
  return null;
}

// Resolve the scorecard's responsible person id across the flat and nested
// Harvest shapes. Live v3 nests these as `interviewer: { id }` / `submitted_by:
// { id }`; older/flat payloads use `interviewer_id` / `submitter_id`. Interviewer
// takes precedence over submitter, matching the prior `interviewer_id ??
// submitter_id` intent, and ids are coerced/validated via readPositiveInt.
export function readScorecardPersonId(row: Record<string, unknown>): number | null {
  const interviewerFlat = readPositiveInt(row.interviewer_id);
  if (interviewerFlat !== null) return interviewerFlat;
  const interviewer = row.interviewer;
  if (isRecord(interviewer)) {
    const id = readPositiveInt(interviewer.id);
    if (id !== null) return id;
  }
  const submitterFlat = readPositiveInt(row.submitter_id);
  if (submitterFlat !== null) return submitterFlat;
  const submittedBy = row.submitted_by;
  if (isRecord(submittedBy)) {
    const id = readPositiveInt(submittedBy.id);
    if (id !== null) return id;
  }
  return null;
}

export function readApplicationStageId(row: Record<string, unknown>): number | null {
  const direct = readPositiveInt(row.stage_id) ?? readPositiveInt(row.current_stage_id);
  if (direct !== null) return direct;

  const currentStage = row.current_stage;
  if (isRecord(currentStage)) {
    const id = readPositiveInt(currentStage.id);
    if (id !== null) return id;
  }

  const stage = row.stage;
  return isRecord(stage) ? readPositiveInt(stage.id) : null;
}

export function readApplicationStageName(row: Record<string, unknown>): string | null {
  const direct = readAnalysisLabel(row.stage_name) ?? readAnalysisLabel(row.current_stage_name);
  if (direct !== null) return direct;

  const currentStage = row.current_stage;
  if (isRecord(currentStage)) {
    const label = readAnalysisLabel(currentStage.name);
    if (label !== null) return label;
  }

  const stage = row.stage;
  return isRecord(stage) ? readAnalysisLabel(stage.name) : null;
}

export function readApplicationCurrentStageAt(row: Record<string, unknown>): string | null {
  const direct = readFirstDateString(row, ["current_stage_at", "current_stage_entered_at", "stage_entered_at"]);
  if (direct !== null) return direct;

  const currentStage = row.current_stage;
  if (isRecord(currentStage)) {
    const nested = readFirstDateString(currentStage, ["entered_at", "entered_on", "started_at", "current_stage_at"]);
    if (nested !== null) return nested;
  }

  const stage = row.stage;
  return isRecord(stage) ? readFirstDateString(stage, ["entered_at", "entered_on", "started_at"]) : null;
}

function readFirstDateString(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value))) {
      return value;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
