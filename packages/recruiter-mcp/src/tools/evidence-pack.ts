import { readPositiveInt } from "../limits.js";

export interface EvidencePackSection {
  name: string;
  rows: Array<Record<string, unknown>>;
}

export interface EvidencePackTypeGroup {
  total_ids: number;
  returned_ids: number;
  ids: string[];
}

export interface EvidencePack {
  total_ids: number;
  returned_ids: number;
  truncated: boolean;
  limit: number;
  requested_limit: number | null;
  limit_clamped: boolean;
  ids: string[];
  by_type: Record<string, EvidencePackTypeGroup>;
  source_sections: string[];
  drilldown_tools: string[];
  content_policy: string;
}

const DEFAULT_EVIDENCE_PACK_LIMIT = 50;
const SAFE_EVIDENCE_ID = /^([a-z_]+):([1-9]\d*)$/;
const ALLOWED_EVIDENCE_ID_TYPES = new Set(["application", "application_stage", "candidate", "job", "note", "scorecard"]);

export function buildEvidencePack(
  params: Record<string, unknown>,
  sections: EvidencePackSection[],
  maxLimit: number = DEFAULT_EVIDENCE_PACK_LIMIT
): EvidencePack | undefined {
  if (params.evidence_pack !== true && params.include_evidence_pack !== true) {
    return undefined;
  }

  const requestedLimit = readPositiveInt(params.evidence_pack_limit);
  const runtimeLimit = Math.max(1, Math.floor(maxLimit));
  const limit = Math.min(requestedLimit ?? DEFAULT_EVIDENCE_PACK_LIMIT, runtimeLimit);
  const allIds = uniqueSafeEvidenceIds(sections);
  const returnedIds = allIds.slice(0, limit);
  return {
    total_ids: allIds.length,
    returned_ids: returnedIds.length,
    truncated: returnedIds.length < allIds.length,
    limit,
    requested_limit: requestedLimit,
    limit_clamped: requestedLimit !== null && requestedLimit > limit,
    ids: returnedIds,
    by_type: groupByType(allIds, returnedIds),
    source_sections: sections.map((section) => section.name),
    drilldown_tools: ["get_my_application", "get_my_job"],
    content_policy: "Evidence pack contains scoped record references only; it does not include candidate names, emails, notes, scorecard text, or raw rows.",
  };
}

export function stripEvidencePackParams(params: Record<string, unknown>): void {
  delete params.evidence_pack;
  delete params.include_evidence_pack;
  delete params.evidence_pack_limit;
}

function uniqueSafeEvidenceIds(sections: EvidencePackSection[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const section of sections) {
    for (const row of section.rows) {
      const rowIds = Array.isArray(row.evidence_ids) ? row.evidence_ids : [];
      for (const value of rowIds) {
        if (!isAllowedEvidenceId(value) || seen.has(value)) {
          continue;
        }
        seen.add(value);
        ids.push(value);
      }
    }
  }
  return ids;
}

function groupByType(allIds: string[], returnedIds: string[]): Record<string, EvidencePackTypeGroup> {
  const allByType = splitByType(allIds);
  const returnedByType = splitByType(returnedIds);
  const output: Record<string, EvidencePackTypeGroup> = {};
  for (const [type, ids] of Object.entries(allByType)) {
    const returned = returnedByType[type] ?? [];
    output[type] = {
      total_ids: ids.length,
      returned_ids: returned.length,
      ids: returned,
    };
  }
  return output;
}

function splitByType(ids: string[]): Record<string, string[]> {
  const byType: Record<string, string[]> = {};
  for (const id of ids) {
    const match = id.match(SAFE_EVIDENCE_ID);
    if (!match || !ALLOWED_EVIDENCE_ID_TYPES.has(match[1]!)) continue;
    const type = match[1]!;
    byType[type] ??= [];
    byType[type]!.push(id);
  }
  return byType;
}

function isAllowedEvidenceId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(SAFE_EVIDENCE_ID);
  return Boolean(match && ALLOWED_EVIDENCE_ID_TYPES.has(match[1]!));
}
