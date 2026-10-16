import { normalizeText, type JobInventoryRecord } from "./inventory.js";

/**
 * Searchable, model-safe job metadata. The resolver index deliberately carries
 * only job operational metadata and safe owner display names already present in
 * the scoped job inventory. It does not include candidate/application data.
 */
export interface JobSearchDocument {
  record: JobInventoryRecord;
  normalized_title: string;
  normalized_text: string;
}

export interface JobSearchIndex {
  documents: JobSearchDocument[];
  source: "live_greenhouse" | "cached_index" | "hybrid";
}

export function buildJobSearchIndex(
  records: readonly JobInventoryRecord[],
  source: JobSearchIndex["source"]
): JobSearchIndex {
  return {
    source,
    documents: records.map((record) => ({
      record,
      normalized_title: record.normalized_title,
      normalized_text: buildSearchText(record),
    })),
  };
}

function buildSearchText(record: JobInventoryRecord): string {
  return normalizeText(
    [
      record.title,
      record.requisition_id,
      record.status,
      record.department,
      record.office,
      record.location,
      ...record.historical_titles,
      ...record.recruiters,
      ...record.hiring_managers,
    ]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" | ")
  );
}
