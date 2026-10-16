/**
 * The scorecard recipes' window, read the same way it is reported.
 *
 * Both scorecard recipes analyse a card on its INTERVIEW date, falling back to its SUBMISSION date
 * when no interview date was recorded — but both used to ask Greenhouse for `created_at >= window_start`
 * instead. Those are different clocks: a card created before the window but interviewed inside it was
 * dropped upstream and never counted, while a card created inside the window but interviewed long
 * before it was read and then thrown away in memory. /v3/scorecards accepts `interviewed_at` and
 * `submitted_at` as server-side range filters (harvest-v3-registry.generated.ts, /v3/scorecards), so
 * the recipe now selects on the basis it reports.
 *
 * Two reads, unioned: one bounded on `interviewed_at`, one on `submitted_at`. The second read is what
 * catches a card carrying only a submission date; the union is deduped so a card matching both filters
 * is counted once. The in-memory `scorecardWindowBasis` check stays authoritative over both.
 *
 * Range encoding: BOTH of Harvest v3's date-filter forms are honoured, and neither is a legacy
 * accident. The pipe form (`created_at=gte|2024-01-01T00:00:00Z`) is the syntax the Harvest v3 list
 * endpoints guide documents; `analyze_rejection_reason_drift` still sends it and it reaches
 * Greenhouse intact. The bracket form (`interviewed_at[gte]=...`) is the one `evidence-read.ts`
 * translates the model-facing date shorthands into and the one `sanitizeReadParams` admits by
 * matching a bracket key against its BASE param name (limits.ts) — so it is what these reads use.
 * Neither form is rewritten anywhere between here and the client's `URLSearchParams` serialization
 * (control-plane/client-readonly.ts).
 *
 * That matters for what the OLD code was doing: `created_at=gte|<window_start>` was a real, honoured
 * server-side floor. It was not inert. It genuinely dropped every card created before the window,
 * including the ones interviewed inside it — which is exactly the bug this module exists to fix.
 */

import { combineReadStatuses, denialTruncationStatus, readAllScopedRows, type ReadAllRowsResult, type ReadAllStatus } from "../read-all.js";
import { chunks, loadApplicationIdsForJobScope, mapWithConcurrency, type JobScopeIdBridge } from "./application-job-lookup.js";
import type { RecruiterToolRuntime, ToolDeadline } from "../runtime.js";
import type { RecruiterPermissionScope } from "../types.js";

/** v3 caps every filter-array param at maxItems:50; the application-backed reads chunk at 25. */
const APPLICATION_ID_BATCH_SIZE = 25;
const APPLICATION_LOOKUP_PER_PAGE = 100;

/** The two server-side bases the window is read on, in the order the recipes report them. */
const WINDOW_FILTER_FIELDS = ["interviewed_at", "submitted_at"] as const;

export interface ScorecardWindowRow extends Record<string, unknown> {
  id: number | null;
  submitted_at: string | null;
  interviewed_at: string | null;
}

/**
 * The one timestamp a scorecard is analysed on: the interview it was owed against, or — when the
 * tenant recorded no interview date — the moment it was submitted. `null` means the card carries
 * neither and cannot be placed on the recipe's clock at all.
 */
export function scorecardWindowBasis(row: { interviewed_at?: unknown; submitted_at?: unknown }): string | null {
  const basis = (row.interviewed_at ?? row.submitted_at) as unknown;
  return typeof basis === "string" && basis.length > 0 ? basis : null;
}

export type ScorecardWindowPartition = "in_window" | "outside_window" | "missing_basis";

export function partitionScorecardByWindow(
  row: { interviewed_at?: unknown; submitted_at?: unknown },
  startIso: string,
  endIso: string
): ScorecardWindowPartition {
  const basis = scorecardWindowBasis(row);
  if (basis === null) return "missing_basis";
  const at = Date.parse(basis);
  if (!Number.isFinite(at)) return "missing_basis";
  return at >= Date.parse(startIso) && at <= Date.parse(endIso) ? "in_window" : "outside_window";
}

export interface ScorecardWindowCounts {
  in_window: number;
  outside_window: number;
  missing_basis: number;
}

export function countScorecardWindowPartitions(
  rows: Array<{ interviewed_at?: unknown; submitted_at?: unknown }>,
  startIso: string,
  endIso: string
): ScorecardWindowCounts {
  const counts: ScorecardWindowCounts = { in_window: 0, outside_window: 0, missing_basis: 0 };
  for (const row of rows) counts[partitionScorecardByWindow(row, startIso, endIso)] += 1;
  return counts;
}

/**
 * The disclosure both recipes carry: a card with neither timestamp cannot be SELECTED by either
 * server-side filter, so the count above is only what arrived through some other path (a job-scoped
 * read bridged by application_ids, say). It is not a census of basis-less scorecards in the tenant.
 */
export const SCORECARD_MISSING_BASIS_DISCLOSURE =
  "Scorecards with neither an interview date nor a submission date cannot be selected by /v3/scorecards' " +
  "interviewed_at or submitted_at range filters, so they are not read by this window; missing_basis counts " +
  "only such rows that reached the analysis through another filter, not every basis-less scorecard in the tenant.";

export const SCORECARD_WINDOW_BASIS_LABEL =
  "interviewed_at, or submitted_at when the scorecard records no interview date";

/**
 * Read the window twice — once bounded on interviewed_at, once on submitted_at — and union the rows.
 * `requestedJobIds` selects the same two read paths the recipes used before: the bridged
 * application_ids read for a narrowed scope, the direct read otherwise.
 *
 * On the bridged path the job -> application_ids derivation runs ONCE and both windowed reads are
 * issued against that one id set. Calling the whole bridge twice re-read /v3/applications for the
 * second filter and billed the caller for a set it already held (rows_read 6 -> 9 on the fixture);
 * the ids cannot change between two reads inside one tool call.
 */
export async function readScorecardsForWindow<T extends ScorecardWindowRow>(
  runtime: RecruiterToolRuntime,
  toolName: string,
  requestedJobIds: Set<number> | null,
  baseParams: Record<string, string | number | boolean | undefined>,
  window: { windowStart: string; windowEnd: string },
  deadline?: ToolDeadline
): Promise<ReadAllRowsResult<T>> {
  const paramsFor = (field: string) => ({
    ...baseParams,
    [`${field}[gte]`]: window.windowStart,
    [`${field}[lte]`]: window.windowEnd,
  });

  let bridge: JobScopeIdBridge | null = null;
  if (requestedJobIds) {
    const derived = await loadApplicationIdsForJobScope(runtime, toolName, [...requestedJobIds], deadline);
    if (derived.kind === "denial") return { kind: "denial", result: derived.result };
    bridge = derived;
  }

  const reads: Array<Extract<ReadAllRowsResult<T>, { kind: "rows" }>> = [];
  for (const field of WINDOW_FILTER_FIELDS) {
    const params = paramsFor(field);
    const read = bridge
      ? await readScorecardsByApplicationIds<T>(runtime, toolName, bridge, params, deadline)
      : await readAllScopedRows<T>(runtime, toolName, "list_scorecards", params, deadline);
    if (read.kind === "denial") {
      // A denial on the SECOND filter used to discard a completed first read and fail the whole
      // analysis. Mirror the bridged endpoint read (application-job-lookup.ts): a truncation-shaped
      // denial after a successful read is an honest partial result; only a first-read denial, and any
      // hard denial, propagates.
      const truncated = denialTruncationStatus(read.result);
      if (truncated && reads.length > 0) {
        return unionScorecardReads(reads, bridge, {
          status: truncated,
          warning: `scorecard window read stopped after the ${field} filter (${truncated}); the rows below are the ${WINDOW_FILTER_FIELDS[0]} read only`,
        });
      }
      return read;
    }
    reads.push(read);
  }
  return unionScorecardReads(reads, bridge);
}

/**
 * The two windowed reads against an ALREADY-DERIVED application_id set, chunked the way
 * readApplicationBackedRowsForJobScope chunks it. Carries no bridge cost of its own: the derive read's
 * counters are folded in once, by the union.
 */
async function readScorecardsByApplicationIds<T extends ScorecardWindowRow>(
  runtime: RecruiterToolRuntime,
  toolName: string,
  bridge: JobScopeIdBridge,
  params: Record<string, string | number | boolean | undefined>,
  deadline?: ToolDeadline
): Promise<ReadAllRowsResult<T>> {
  const { job_ids: _dropJobIds, scope_handle: _dropHandle, ...safeParams } = params;
  const batches = chunks(bridge.ids, APPLICATION_ID_BATCH_SIZE);
  const batchReads = await mapWithConcurrency(batches, (batch) =>
    readAllScopedRows<T>(runtime, toolName, "list_scorecards", { ...safeParams, application_ids: batch.join(",") }, deadline)
  );

  const rows: T[] = [];
  const statuses: ReadAllStatus[] = [];
  const warnings: string[] = [];
  let rawRowsRead = 0;
  let rowsReturnedRead = 0;
  let permissionExcluded = 0;
  let privacyWithheld = 0;
  let unresolvedRows = 0;
  let pagesRead = 0;
  let rateLimitRetries = 0;
  let rateLimitSleepMs = 0;
  let cacheHits = 0;
  let paginationTruncated = false;
  let perPage = 0;
  let actorId: number | undefined;
  let effectiveActorId: number | undefined;
  let scoped: boolean | undefined;
  let permissionScope: RecruiterPermissionScope | undefined;
  let completedBatches = 0;

  for (const read of batchReads) {
    if (read.kind === "denial") {
      const truncated = denialTruncationStatus(read.result);
      if (truncated && completedBatches > 0) {
        statuses.push(truncated);
        warnings.push(`scorecard window read stopped after a later application_ids batch (${truncated})`);
        break;
      }
      return read;
    }
    rows.push(...read.rows);
    statuses.push(read.status);
    completedBatches += 1;
    warnings.push(...read.warnings);
    rawRowsRead += read.rawRowsRead;
    rowsReturnedRead += read.rowsReturnedRead ?? read.rows.length;
    permissionExcluded += read.permissionExcluded;
    privacyWithheld += read.privacyWithheld;
    unresolvedRows += read.unresolvedRows;
    pagesRead += read.pagesRead;
    rateLimitRetries += read.rateLimitRetries;
    rateLimitSleepMs += read.rateLimitSleepMs;
    cacheHits += read.cacheHits;
    paginationTruncated = paginationTruncated || read.paginationTruncated;
    perPage = perPage || read.perPage;
    actorId ??= read.actorId;
    effectiveActorId ??= read.effectiveActorId;
    scoped ??= read.scoped;
    permissionScope ??= read.permissionScope;
  }

  const status = combineReadStatuses(statuses);
  return {
    kind: "rows",
    rows,
    rawRowsRead,
    rowsReturnedRead,
    permissionExcluded,
    privacyWithheld,
    unresolvedRows,
    pagesRead,
    status,
    complete: status === "complete",
    paginationTruncated,
    nextCursor: null,
    // A scope that resolved to zero application_ids ran no batch, so there is no observed page size.
    // Report the bridge's own, the way readApplicationBackedRowsForJobScope does, never 0.
    perPage: perPage || APPLICATION_LOOKUP_PER_PAGE,
    rateLimitRetries,
    rateLimitSleepMs,
    cacheHits,
    warnings,
    actorId,
    effectiveActorId,
    scoped,
    permissionScope,
  };
}

/**
 * Union the window reads by scorecard id, keeping the FRESHEST copy of a card returned by both.
 *
 * Keeping the first copy discarded a real update: a card unsubmitted when the interviewed_at read ran
 * and submitted by the time the submitted_at read ran came back twice, and the stale copy — the one
 * with no submitted_at — was the one reported, so the recipe called an owed card unsubmitted. The
 * newest `updated_at` wins; when neither copy carries one, the LATER read wins, because it observed
 * the record more recently.
 *
 * A row with no usable id cannot be identified across the two reads, so it is deduped on its
 * serialized payload instead — which collapses the genuine duplicate without discarding two distinct
 * id-less rows.
 */
function unionScorecardReads<T extends ScorecardWindowRow>(
  reads: Array<Extract<ReadAllRowsResult<T>, { kind: "rows" }>>,
  bridge: JobScopeIdBridge | null = null,
  truncation: { status: ReadAllStatus; warning: string } | null = null
): ReadAllRowsResult<T> {
  const order: string[] = [];
  const byKey = new Map<string, T>();
  for (const read of reads) {
    for (const row of read.rows) {
      const key = typeof row.id === "number" && Number.isSafeInteger(row.id) ? `id:${row.id}` : `row:${JSON.stringify(row)}`;
      const existing = byKey.get(key);
      if (existing === undefined) {
        order.push(key);
        byKey.set(key, row);
        continue;
      }
      if (!isStalerThan(existing, row)) continue;
      byKey.set(key, row);
    }
  }
  const rows = order.map((key) => byKey.get(key)!);
  // A card returned by BOTH filters was counted twice by the read-cost counter, so `rows_read` could
  // exceed the population `completeness.total_records_in_scope` reports from the same union. Net the
  // duplicates out here — once, where they are known — rather than leaving every caller to reconcile
  // two numbers that describe the same rows.
  const duplicateRowsDropped = sum(reads, (read) => read.rows.length) - rows.length;
  const first = reads[0]!;
  const status = combineReadStatuses([
    ...reads.map((read) => read.status),
    ...(bridge ? [bridge.status] : []),
    ...(truncation ? [truncation.status] : []),
  ]);
  return {
    kind: "rows",
    rows,
    // Both reads really did hit the API, so the read-cost counters sum — minus the rows the union
    // deduped, which are the same card counted twice, not two rows read. The bridge's own derive read
    // is added ONCE: it ran once, however many windowed reads used its ids.
    rawRowsRead: sum(reads, (read) => read.rawRowsRead) - duplicateRowsDropped + (bridge?.rawRowsRead ?? 0),
    rowsReturnedRead:
      sum(reads, (read) => read.rowsReturnedRead ?? read.rows.length) - duplicateRowsDropped + (bridge?.returnedRowsRead ?? 0),
    permissionExcluded: sum(reads, (read) => read.permissionExcluded) + (bridge?.permissionExcluded ?? 0),
    // The privacy gate's count rides on each read like every other counter; a card withheld by both
    // filters is the same card, so the union nets duplicates out of the returned rows, not this count.
    privacyWithheld: sum(reads, (read) => read.privacyWithheld) + ((bridge as { privacyWithheld?: number } | null | undefined)?.privacyWithheld ?? 0),
    unresolvedRows: sum(reads, (read) => read.unresolvedRows) + (bridge?.unresolvedRows ?? 0),
    pagesRead: sum(reads, (read) => read.pagesRead) + (bridge?.pagesRead ?? 0),
    status,
    complete: status === "complete",
    paginationTruncated: reads.some((read) => read.paginationTruncated) || truncation !== null,
    nextCursor: null,
    perPage: first.perPage,
    rateLimitRetries: sum(reads, (read) => read.rateLimitRetries) + (bridge?.rateLimitRetries ?? 0),
    rateLimitSleepMs: sum(reads, (read) => read.rateLimitSleepMs) + (bridge?.rateLimitSleepMs ?? 0),
    cacheHits: sum(reads, (read) => read.cacheHits) + (bridge?.cacheHits ?? 0),
    warnings: [
      ...(bridge?.warnings ?? []),
      ...reads.flatMap((read) => read.warnings),
      ...(truncation ? [truncation.warning] : []),
    ],
    actorId: first.actorId ?? bridge?.actorId,
    effectiveActorId: first.effectiveActorId ?? bridge?.effectiveActorId,
    scoped: first.scoped ?? bridge?.scoped,
    permissionScope: first.permissionScope ?? bridge?.permissionScope,
  };
}

/** True when `existing` is the older observation of the same card and should be replaced. */
function isStalerThan(existing: ScorecardWindowRow, candidate: ScorecardWindowRow): boolean {
  const existingAt = parseUpdatedAt(existing);
  const candidateAt = parseUpdatedAt(candidate);
  if (existingAt !== null && candidateAt !== null) return candidateAt > existingAt;
  // Neither copy (or only one) is dated: the later read observed the record more recently, so it wins.
  return true;
}

function parseUpdatedAt(row: Record<string, unknown>): number | null {
  const value = row.updated_at;
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

function sum<T>(reads: T[], pick: (read: T) => number): number {
  return reads.reduce((total, read) => total + pick(read), 0);
}
