const MAX_ANALYSIS_LABEL_LENGTH = 128;
const MAX_ANALYSIS_STATUS_LENGTH = 64;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const ALLOWED_ANALYSIS_STATUSES = new Set([
  "active",
  "converted",
  "hired",
  "in_process",
  "rejected",
  "unknown",
]);

export function readAnalysisLabel(value: unknown, maxLength = MAX_ANALYSIS_LABEL_LENGTH): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) return null;
  if (CONTROL_CHARACTER_PATTERN.test(normalized)) return null;
  return normalized;
}

export function normalizeAnalysisStatus(value: unknown): string {
  const normalized = readAnalysisLabel(value, MAX_ANALYSIS_STATUS_LENGTH);
  if (!normalized) return "unknown";
  const status = normalized.toLowerCase().replace(/\s+/g, "_");
  return ALLOWED_ANALYSIS_STATUSES.has(status) ? status : "unknown";
}

const TERMINAL_ANALYSIS_STATUSES = new Set(["rejected", "hired", "converted"]);

/** A normalized application status that represents a reached disposition (vs. active/in_process). */
export function isTerminalAnalysisStatus(status: string): boolean {
  return TERMINAL_ANALYSIS_STATUSES.has(status);
}

const ACTIVE_ANALYSIS_STATUSES = new Set(["active", "in_process"]);

/**
 * A normalized application status still moving through the pipeline. Harvest v3's filter
 * vocabulary says `active`, but application rows themselves carry `in_process` — a consumer
 * that tests only one literal silently zeroes out live data.
 */
export function isActiveAnalysisStatus(status: string): boolean {
  return ACTIVE_ANALYSIS_STATUSES.has(status);
}
