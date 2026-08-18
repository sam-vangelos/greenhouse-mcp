import { readAllScopedRows } from "../read-all.js";
import { readPositiveInt } from "../limits.js";
import type { RecruiterToolRuntime, ToolDeadline } from "../runtime.js";

/**
 * Read a Greenhouse reference list (/v3/sources, /v3/referrers, /v3/rejection_reasons, …)
 * and build an id -> display-name map. Best-effort enrichment within the already-authorized
 * session: a reference-read failure degrades to an empty map rather than converting an
 * already-successful scoped analysis into a denial.
 */
export async function resolveReferenceNames(
  runtime: RecruiterToolRuntime,
  toolName: string,
  scopedToolName: string,
  deadline: ToolDeadline | undefined
): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  try {
    const read = await readAllScopedRows<{ id?: unknown; name?: unknown }>(runtime, toolName, scopedToolName, {}, deadline);
    if (read.kind !== "rows") return names;
    for (const row of read.rows) {
      const id = readPositiveInt(row.id);
      if (id === null) continue;
      const name = typeof row.name === "string" && row.name.trim().length > 0 ? row.name.trim() : null;
      if (name !== null) names.set(id, name);
    }
  } catch {
    return names;
  }
  return names;
}

/**
 * The display name for a reference id: the resolved name, or an HONEST "unavailable"
 * label when the id is present but absent from the reference set — an archived or
 * Greenhouse-global id the org's current list omits (a class that can
 * cover the majority of a requisition's rejections). Never a bare id or a silent null; null only when there is
 * no id at all. `kind` is the reference noun ("source", "referrer", "reason") shown in
 * the label so a recruiter reads "reason 4999999004 (name unavailable)" rather than a
 * bare number.
 */
export function referenceName(names: Map<number, string>, idValue: unknown, kind: string): string | null {
  const id = readPositiveInt(idValue);
  if (id === null) return null;
  return names.get(id) ?? `${kind} ${id} (name unavailable)`;
}
