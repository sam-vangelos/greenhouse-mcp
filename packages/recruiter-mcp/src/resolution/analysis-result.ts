import type { AnalysisContextHeader, UnresolvedEvidence } from "./types.js";
import type { ProvenanceAssessment } from "./provenance.js";

export interface AnalysisCompleteness {
  status: "complete" | "partial" | "incomplete";
  total_records_in_scope: number | null;
  records_analyzed: number;
  records_excluded: number;
  exclusion_reasons: Array<{ reason: string; count: number }>;
  inventory_complete: boolean;
  any_pagination_truncated: boolean;
  data_freshness_ok: boolean;
  // Migration/provenance assessment of the analyzed records (live-pilot finding L4). Present on every
  // recipe; `migration_suspected: true` degrades status to at least `partial` and carries the
  // operator-facing warning so artifacts of a data load are never presented as recruiting findings.
  provenance?: ProvenanceAssessment;
  message?: string;
}

// How completely the analyzed records resolved into ranked findings. This is NOT a
// graded confidence score — the recipes compute no per-finding confidence. It reports
// the count of findings surfaced and the count of input records that could not be
// attributed to one. Data-quality degradation lives in `completeness`, not here.
export interface AttributionSummary {
  findings_ranked: number;
  unresolved: number;
}

export interface AnalysisResultEnvelope<TData> {
  data: TData;
  completeness: AnalysisCompleteness;
  attribution_summary: AttributionSummary;
  unresolved_evidence: UnresolvedEvidence[];
  scope?: AnalysisContextHeader;
}

export interface BuildAnalysisCompletenessInput {
  totalRecordsInScope?: number | null;
  recordsAnalyzed: number;
  recordsExcluded?: number;
  exclusionReasons?: Array<{ reason: string; count: number }>;
  inventoryComplete?: boolean;
  anyPaginationTruncated?: boolean;
  dataFreshnessOk?: boolean;
  provenance?: ProvenanceAssessment;
  message?: string;
}

export function buildAnalysisCompleteness(input: BuildAnalysisCompletenessInput): AnalysisCompleteness {
  const recordsExcluded = input.recordsExcluded ?? sumExclusions(input.exclusionReasons ?? []);
  const inventoryComplete = input.inventoryComplete ?? true;
  const anyPaginationTruncated = input.anyPaginationTruncated ?? false;
  const dataFreshnessOk = input.dataFreshnessOk ?? true;
  const migrationSuspected = input.provenance?.migration_suspected === true;
  const totalRecordsInScope = input.totalRecordsInScope ?? null;
  const accountingMismatch = totalRecordsInScope !== null && totalRecordsInScope !== input.recordsAnalyzed + recordsExcluded;
  const message = accountingMismatch
    ? [input.message, `Accounting mismatch: total_records_in_scope (${totalRecordsInScope}) != records_analyzed (${input.recordsAnalyzed}) + records_excluded (${recordsExcluded}).`]
        .filter(Boolean)
        .join(" ")
    : input.message;
  return {
    status: completenessStatus(inventoryComplete, anyPaginationTruncated, dataFreshnessOk, recordsExcluded, migrationSuspected, accountingMismatch),
    total_records_in_scope: totalRecordsInScope,
    records_analyzed: input.recordsAnalyzed,
    records_excluded: recordsExcluded,
    exclusion_reasons: input.exclusionReasons ?? [],
    inventory_complete: inventoryComplete,
    any_pagination_truncated: anyPaginationTruncated,
    data_freshness_ok: dataFreshnessOk,
    ...(input.provenance ? { provenance: input.provenance } : {}),
    ...(message ? { message } : {}),
  };
}

export function emptyAttributionSummary(): AttributionSummary {
  return { findings_ranked: 0, unresolved: 0 };
}

export function attachAnalysisScope<TData>(
  envelope: Omit<AnalysisResultEnvelope<TData>, "scope">,
  scope: AnalysisContextHeader | null
): AnalysisResultEnvelope<TData> {
  return scope ? { ...envelope, scope } : envelope;
}

function completenessStatus(
  inventoryComplete: boolean,
  anyPaginationTruncated: boolean,
  dataFreshnessOk: boolean,
  recordsExcluded: number,
  migrationSuspected: boolean,
  accountingMismatch: boolean
): AnalysisCompleteness["status"] {
  if (!inventoryComplete || anyPaginationTruncated || accountingMismatch) return "incomplete";
  // Suspected-migration data is never "complete": the records may be load artifacts, so the analysis
  // is at best provisional. Degrade to partial and let the provenance warning carry the why.
  if (!dataFreshnessOk || recordsExcluded > 0 || migrationSuspected) return "partial";
  return "complete";
}

function sumExclusions(exclusions: Array<{ count: number }>): number {
  return exclusions.reduce((sum, entry) => sum + Math.max(0, entry.count), 0);
}
