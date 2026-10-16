// Candidate pipeline-state fetch+join for the `list_candidates` tool.
//
// Harvest v3 `GET /v3/candidates` does NOT embed applications[] (strict-closed,
// additionalProperties:false), so candidate pipeline state must be assembled from a
// separate `/v3/applications` read. This module fetches the listed candidates'
// applications and injects them onto each candidate as `raw.applications`, which the
// projection's deriveStageSnapshot then reads.
//
// Two v3 limits drive the shape of the fetch, and getting either wrong silently
// produces a partial answer that looks complete (the failure mode the project's
// ambition posture forbids):
//   - `candidate_ids` is documented maxItems:50 (0015-get_v3-applications.md). The
//     candidate page can hold up to 500, so the ids are chunked into batches of 50;
//     joining the whole page would 4xx and (caught) null every candidate's snapshot.
//   - a single page caps at per_page:500, so each batch follows the cursor to
//     exhaustion (bounded backstop) — a clipped batch would under-report a
//     candidate's pipeline as a non-null array with no signal.
//
// Failure is best-effort and HONEST: a candidate whose batch fetch throws is left
// untouched (no injected applications → stage_snapshot null = "could not fetch"),
// never a fabricated empty []. The fetch is scoped strictly to candidate ids already
// returned — no scope widening.

import { apiGet, apiGetWithCursor } from "./client.js";

// v3 /applications candidate_ids filter is documented maxItems:50.
export const MAX_CANDIDATE_IDS_PER_QUERY = 50;
// Bounded cursor-follow backstop per batch (20 * 500 = 10k applications for ≤50
// candidates — far beyond any realistic pipeline; a runaway guard, not a real cap).
export const MAX_APPLICATION_PAGES_PER_BATCH = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveId(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** Split candidate ids into batches no larger than the v3 candidate_ids maxItems. */
export function chunkCandidateIds(
  ids: number[],
  size: number = MAX_CANDIDATE_IDS_PER_QUERY
): number[][] {
  const chunks: number[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }
  return chunks;
}

/** Group raw application rows by their flat v3 candidate_id. */
export function groupApplicationsByCandidate(applications: unknown[]): Map<number, unknown[]> {
  const byCandidate = new Map<number, unknown[]>();
  for (const application of applications) {
    if (!isRecord(application)) continue;
    const candidateId = positiveId(application.candidate_id);
    if (candidateId === null) continue;
    const existing = byCandidate.get(candidateId);
    if (existing) existing.push(application);
    else byCandidate.set(candidateId, [application]);
  }
  return byCandidate;
}

/**
 * Inject each candidate's applications as `raw.applications`. Only candidates whose
 * batch fetch SUCCEEDED (present in fetchedCandidateIds) are injected — a candidate
 * with applications gets them, one with none gets `[]`. A candidate whose batch
 * failed is returned untouched so the projection yields a null stage_snapshot
 * ("could not fetch"), never a fabricated empty.
 */
export function injectApplications(
  candidates: unknown[],
  byCandidate: Map<number, unknown[]>,
  fetchedCandidateIds: Set<number>
): unknown[] {
  return candidates.map((candidate) => {
    if (!isRecord(candidate)) return candidate;
    const id = positiveId(candidate.id);
    if (id === null || !fetchedCandidateIds.has(id)) return candidate;
    return { ...candidate, applications: byCandidate.get(id) ?? [] };
  });
}

// The two reads the orchestrator needs, injectable so the chunk/cursor/merge/failure
// logic is testable without live HTTP. Default to the real Harvest client.
export interface ApplicationFetchDeps {
  get: (
    path: string,
    params: Record<string, string | number | boolean | undefined>
  ) => Promise<{ data: unknown; nextCursor: string | null }>;
  getWithCursor: (path: string, cursor: string) => Promise<{ data: unknown; nextCursor: string | null }>;
}

const DEFAULT_FETCH_DEPS: ApplicationFetchDeps = {
  get: (path, params) => apiGet<unknown[]>(path, params),
  getWithCursor: (path, cursor) => apiGetWithCursor<unknown[]>(path, cursor),
};

/**
 * Fetch the listed candidates' applications (chunked ≤50, cursor-followed) and
 * inject them so the projection can derive stage_snapshot. Best-effort per batch.
 */
export async function attachCandidateApplicationsForStageSnapshot(
  candidates: unknown,
  deps: ApplicationFetchDeps = DEFAULT_FETCH_DEPS
): Promise<unknown> {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return candidates;
  }
  const candidateIds = candidates
    .map((candidate) => (isRecord(candidate) ? positiveId(candidate.id) : null))
    .filter((id): id is number => id !== null);
  if (candidateIds.length === 0) {
    return candidates;
  }

  const byCandidate = new Map<number, unknown[]>();
  const fetched = new Set<number>();
  for (const batch of chunkCandidateIds(candidateIds)) {
    try {
      let response = await deps.get("/applications", {
        candidate_ids: batch.join(","),
        per_page: 500,
      });
      let pages = 1;
      for (;;) {
        const rows = Array.isArray(response.data) ? response.data : [];
        for (const [candidateId, list] of groupApplicationsByCandidate(rows)) {
          const existing = byCandidate.get(candidateId);
          if (existing) existing.push(...list);
          else byCandidate.set(candidateId, [...list]);
        }
        const cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
        if (!cursor || pages >= MAX_APPLICATION_PAGES_PER_BATCH) break;
        response = await deps.getWithCursor("/applications", cursor);
        pages += 1;
      }
      // The batch returned: every candidate in it was fetched (even if it has zero
      // applications, which injects [] rather than the "could not fetch" null).
      for (const id of batch) fetched.add(id);
    } catch {
      // Leave this batch's candidates untouched → null stage_snapshot (honest unknown).
    }
  }
  return injectApplications(candidates, byCandidate, fetched);
}
