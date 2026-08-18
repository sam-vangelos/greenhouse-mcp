import { readPositiveInt } from "../limits.js";
import { combineReadStatuses, denialTruncationStatus, readAllScopedRows, type ReadAllRowsResult, type ReadAllStatus } from "../read-all.js";
import { assertWithinToolDeadline, scopedReadWithTimeout, type RecruiterToolRuntime, type ToolDeadline } from "../runtime.js";
import { readApplicationCandidateId, readApplicationJobId } from "./application-shapes.js";
import type { RecruiterPermissionScope, RecruiterToolResult, RecruiterDenialCode } from "../types.js";

const APPLICATION_ID_BATCH_SIZE = 25;
const APPLICATION_LOOKUP_PER_PAGE = 100;
// v3 caps every filter-array param at maxItems:50 (e.g. /v3/applications.job_ids,
// /v3/interviews.job_ids — vendored docs/harvest-v3-api). A confirmed scope can span >50 jobs (a broad
// role / multi-req scope), so the derive read MUST chunk job_ids the way the endpoint read chunks
// application_ids — otherwise v3 rejects or silently caps at 50, under-scoping the bridge (R3).
const JOB_ID_BATCH_SIZE = 50;

export interface ApplicationJobLookup {
  jobIdsByApplication: Map<number, number | null>;
  denials: Array<Record<string, unknown>>;
  denial?: {
    code: RecruiterDenialCode;
    message: string;
  };
}

export async function loadApplicationJobIdsFromScopedList(
  runtime: RecruiterToolRuntime,
  applicationIds: number[],
  deadline?: ToolDeadline
): Promise<ApplicationJobLookup> {
  const uniqueIds = [...new Set(applicationIds.filter(isPositiveInteger))];
  const jobIdsByApplication = new Map<number, number | null>();
  const denials: Array<Record<string, unknown>> = [];

  const idBatches = chunks(uniqueIds, APPLICATION_ID_BATCH_SIZE);
  const responses = await mapWithConcurrency(idBatches, async (batch) => {
    assertWithinToolDeadline(deadline);
    return scopedReadWithTimeout(
      runtime,
      "list_applications",
      { ids: batch.join(","), per_page: APPLICATION_LOOKUP_PER_PAGE },
      undefined,
      deadline
    );
  });

  for (const [batchIndex, batch] of idBatches.entries()) {
    const response = responses[batchIndex];

    if (!response.ok) {
      for (const applicationId of batch) {
        denials.push({ application_id: applicationId, denial_code: response.denial.code });
        jobIdsByApplication.set(applicationId, null);
      }
      return {
        jobIdsByApplication,
        denials,
        denial: {
          code: response.denial.code,
          message: response.denial.message,
        },
      };
    }

    const rowsById = new Map<number, Record<string, unknown>>();
    const rows = Array.isArray(response.data) ? response.data.filter(isRecord) : [];
    for (const row of rows) {
      const id = readPositiveInt(row.id);
      if (id !== null && batch.includes(id) && !rowsById.has(id)) {
        rowsById.set(id, row);
      }
    }

    for (const applicationId of batch) {
      const row = rowsById.get(applicationId) ?? null;
      jobIdsByApplication.set(applicationId, row ? readApplicationJobId(row) : null);
    }
  }

  return { jobIdsByApplication, denials };
}

export interface JobScopeIdBridge {
  kind: "ids";
  // The derived target ids the confirmed scope resolves to: application_ids, candidate ids, interview
  // ids, or scorecard ids depending on the helper. Always sourced through the scoped reader, so every id
  // belongs to a permitted-bounded row — the bridge can only NARROW the permitted set to the scope.
  ids: number[];
  status: ReadAllStatus;
  complete: boolean;
  rawRowsRead: number;
  returnedRowsRead: number;
  permissionExcluded: number;
  unresolvedRows: number;
  pagesRead: number;
  rateLimitRetries: number;
  rateLimitSleepMs: number;
  cacheHits: number;
  warnings: string[];
  // Carried so a scope that resolves to ZERO ids can still build a correct audit/envelope (the derive
  // read ran and observed the actor + permission scope).
  actorId?: number;
  effectiveActorId?: number;
  scoped?: boolean;
  permissionScope?: RecruiterPermissionScope;
}

export type JobScopeIdBridgeResult =
  | JobScopeIdBridge
  | { kind: "denial"; result: RecruiterToolResult };

/**
 * The job -> application_ids bridge (the inverse of loadApplicationJobIdsFromScopedList).
 *
 * The application-backed v3 endpoints (application_stages, scorecards, rejection_details, notes,
 * attachments) can only be filtered by application_ids — there is NO job_ids filter — so a confirmed
 * requisition scope is inert on them unless something translates the scope's jobs into the
 * application_ids that belong to them (live-pilot finding L1). This reads /v3/applications filtered by
 * the resolved job_ids through the read-all engine (server-side cursor following, scoped) and returns
 * every application id on those jobs. analyze_stage_latency does exactly this inline; this is that
 * pattern generalized into one reusable bridge.
 *
 * Safety floor: the read goes through the scoped reader, so it only ever returns applications on jobs
 * this actor is permitted to see. The bridge therefore NARROWS the permitted set to the confirmed
 * scope; it can never widen past it. An incomplete read is reported (status/complete) rather than
 * silently yielding a partial id set as if it were the whole scope.
 */
export async function loadApplicationIdsForJobScope(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  jobIds: number[],
  deadline?: ToolDeadline
): Promise<JobScopeIdBridgeResult> {
  return deriveIdsFromJobScope(runtime, exposedToolName, jobIds, "list_applications", (row) => readPositiveInt(row.id), deadline);
}

/**
 * job -> candidate ids. Reads /v3/applications by the scope's job_ids (scoped, permitted-bounded) and
 * collects each application's top-level candidate_id. Feeds the candidate-backed tools
 * (candidates/candidate_educations/candidate_employments) whose endpoints have no job_ids filter — the
 * R2 siblings of the L1 application bridge.
 */
export async function loadCandidateIdsForJobScope(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  jobIds: number[],
  deadline?: ToolDeadline
): Promise<JobScopeIdBridgeResult> {
  return deriveIdsFromJobScope(runtime, exposedToolName, jobIds, "list_applications", readApplicationCandidateId, deadline);
}

/**
 * job -> interview ids. Reads /v3/interviews by the scope's job_ids (the endpoint natively supports
 * job_ids; scoped, permitted-bounded) and collects each interview id. Feeds the interview-backed tool
 * (interviewers) whose endpoint can only be filtered by interview_ids. No application hop is needed.
 */
export async function loadInterviewIdsForJobScope(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  jobIds: number[],
  deadline?: ToolDeadline
): Promise<JobScopeIdBridgeResult> {
  return deriveIdsFromJobScope(runtime, exposedToolName, jobIds, "list_interviews", (row) => readPositiveInt(row.id), deadline);
}

/**
 * job -> scorecard ids. The only two-hop derivation: first resolves the scope's application_ids (reusing
 * loadApplicationIdsForJobScope), then reads /v3/scorecards by application_ids (chunked 25/req, scoped)
 * and collects each scorecard id. Feeds the scorecard-backed tool (scorecard_question_answers) whose
 * endpoint can only be filtered by scorecard_ids. Completeness rolls up across BOTH hops; a later-chunk
 * timeout keeps the scorecard ids already collected and reports incomplete (mirrors the bridged read).
 */
export async function loadScorecardIdsForJobScope(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  jobIds: number[],
  deadline?: ToolDeadline
): Promise<JobScopeIdBridgeResult> {
  const apps = await loadApplicationIdsForJobScope(runtime, exposedToolName, jobIds, deadline);
  if (apps.kind === "denial") return apps;

  const scorecardIds: number[] = [];
  const seen = new Set<number>();
  const statuses: ReadAllStatus[] = [apps.status];
  let rawRowsRead = apps.rawRowsRead;
  let returnedRowsRead = apps.returnedRowsRead;
  let permissionExcluded = apps.permissionExcluded;
  let unresolvedRows = apps.unresolvedRows;
  let cacheHits = apps.cacheHits;
  let pagesRead = apps.pagesRead;
  let rateLimitRetries = apps.rateLimitRetries;
  let rateLimitSleepMs = apps.rateLimitSleepMs;
  const warnings = [...apps.warnings];
  let actorId = apps.actorId;
  let effectiveActorId = apps.effectiveActorId;
  let scoped = apps.scoped;
  let permissionScope = apps.permissionScope;
  let completedScorecardBatches = 0;

  const scorecardReads = await mapWithConcurrency(chunks(apps.ids, APPLICATION_ID_BATCH_SIZE), (batch) =>
    readAllScopedRows<Record<string, unknown>>(
      runtime,
      exposedToolName,
      "list_scorecards",
      { application_ids: batch.join(",") },
      deadline
    )
  );
  for (const read of scorecardReads) {
    if (read.kind === "denial") {
      // Mirror the bridged endpoint read: failure after a completed batch is an honest partial result,
      // even if that batch returned zero ids; a failure in the first batch is a hard denial.
      const truncated = denialTruncationStatus(read.result);
      if (truncated && completedScorecardBatches > 0) {
        statuses.push(truncated);
        warnings.push(`scorecard-id derivation stopped after a later batch (${truncated})`);
        break;
      }
      return { kind: "denial", result: read.result };
    }
    for (const row of read.rows) {
      const id = readPositiveInt(row.id);
      if (id !== null && !seen.has(id)) {
        seen.add(id);
        scorecardIds.push(id);
      }
    }
    statuses.push(read.status);
    completedScorecardBatches += 1;
    rawRowsRead += read.rawRowsRead;
    returnedRowsRead += read.rowsReturnedRead ?? read.rows.length;
    permissionExcluded += read.permissionExcluded;
    unresolvedRows += read.unresolvedRows;
    cacheHits += read.cacheHits;
    pagesRead += read.pagesRead;
    rateLimitRetries += read.rateLimitRetries;
    rateLimitSleepMs += read.rateLimitSleepMs;
    warnings.push(...read.warnings);
    actorId ??= read.actorId;
    effectiveActorId ??= read.effectiveActorId;
    scoped ??= read.scoped;
    permissionScope ??= read.permissionScope;
  }

  const status = combineReadStatuses(statuses);
  return {
    kind: "ids",
    ids: scorecardIds,
    status,
    complete: status === "complete",
    rawRowsRead,
    returnedRowsRead,
    permissionExcluded,
    unresolvedRows,
    cacheHits,
    pagesRead,
    rateLimitRetries,
    rateLimitSleepMs,
    warnings,
    actorId,
    effectiveActorId,
    scoped,
    permissionScope,
  };
}

/**
 * Read full ROWS of an APPLICATION-BACKED endpoint (/v3/scorecards, /v3/rejection_details, …) for a
 * confirmed job scope, bridged through application_ids. These endpoints have NO job_ids filter:
 * Harvest v3 REJECTS an unknown job_ids param with 422 (it does not silently ignore it), so a recipe
 * must never forward job_ids to them. This derives the scope's application_ids (the L1 bridge) and
 * reads `scopedToolName` by application_ids (chunked 25/req, scoped), returning the same
 * ReadAllRowsResult shape a direct readAllScopedRows call returns so the caller's downstream is
 * unchanged. extraParams carries non-scope read filters (e.g. created_at window, per_page); any
 * job_ids there is stripped defensively so it can never reach the endpoint. Completeness rolls up
 * across the derive hop and every chunk; a later-chunk truncation keeps the rows already collected and
 * reports incomplete (mirrors loadScorecardIdsForJobScope).
 */
export async function readApplicationBackedRowsForJobScope<T extends Record<string, unknown>>(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  scopedToolName: string,
  jobIds: number[],
  extraParams: Record<string, unknown> = {},
  deadline?: ToolDeadline
): Promise<ReadAllRowsResult<T>> {
  const apps = await loadApplicationIdsForJobScope(runtime, exposedToolName, jobIds, deadline);
  if (apps.kind === "denial") return apps;

  const { job_ids: _drop, scope_handle: _dropHandle, ...safeExtra } = extraParams;
  const rows: T[] = [];
  const statuses: ReadAllStatus[] = [apps.status];
  const warnings = [...apps.warnings];
  let rawRowsRead = apps.rawRowsRead;
  let rowsReturnedRead = apps.returnedRowsRead;
  let permissionExcluded = apps.permissionExcluded;
  let unresolvedRows = apps.unresolvedRows;
  let cacheHits = apps.cacheHits;
  let pagesRead = apps.pagesRead;
  let rateLimitRetries = apps.rateLimitRetries;
  let rateLimitSleepMs = apps.rateLimitSleepMs;
  let paginationTruncated = false;
  let perPage = 0;
  let actorId = apps.actorId;
  let effectiveActorId = apps.effectiveActorId;
  let scoped = apps.scoped;
  let permissionScope = apps.permissionScope;
  let completedBackedBatches = 0;

  const backedReads = await mapWithConcurrency(chunks(apps.ids, APPLICATION_ID_BATCH_SIZE), (batch) =>
    readAllScopedRows<T>(
      runtime,
      exposedToolName,
      scopedToolName,
      { ...safeExtra, application_ids: batch.join(",") },
      deadline
    )
  );
  for (const read of backedReads) {
    if (read.kind === "denial") {
      const truncated = denialTruncationStatus(read.result);
      if (truncated && completedBackedBatches > 0) {
        statuses.push(truncated);
        warnings.push(`application-backed read stopped after a later batch (${truncated})`);
        break;
      }
      return { kind: "denial", result: read.result };
    }
    rows.push(...read.rows);
    statuses.push(read.status);
    completedBackedBatches += 1;
    warnings.push(...read.warnings);
    rawRowsRead += read.rawRowsRead;
    rowsReturnedRead += read.rowsReturnedRead ?? read.rows.length;
    permissionExcluded += read.permissionExcluded;
    unresolvedRows += read.unresolvedRows;
    cacheHits += read.cacheHits;
    pagesRead += read.pagesRead;
    rateLimitRetries += read.rateLimitRetries;
    rateLimitSleepMs += read.rateLimitSleepMs;
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
    unresolvedRows,
    pagesRead,
    status,
    complete: status === "complete",
    paginationTruncated,
    nextCursor: null,
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
 * The scorecard-specific bridged read used by the scorecard recipes. Delegates to
 * readApplicationBackedRowsForJobScope with the /v3/scorecards scoped tool.
 */
export async function readScorecardRowsForJobScope<T extends Record<string, unknown>>(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  jobIds: number[],
  extraParams: Record<string, unknown> = {},
  deadline?: ToolDeadline
): Promise<ReadAllRowsResult<T>> {
  return readApplicationBackedRowsForJobScope<T>(runtime, exposedToolName, "list_scorecards", jobIds, extraParams, deadline);
}

// Shared single-hop derivation: read a scoped LIST tool by the scope's job_ids (read-all,
// permitted-bounded) and collect a deduped positive id per row via pickId. Returns the same id-bridge
// shape as the multi-hop scorecard derivation so completeness rolls up uniformly. An empty job set short-
// circuits to zero ids (complete); a first-page denial propagates as a hard failure.
async function deriveIdsFromJobScope(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  jobIds: number[],
  scopedToolName: string,
  pickId: (row: Record<string, unknown>) => number | null,
  deadline?: ToolDeadline
): Promise<JobScopeIdBridgeResult> {
  const uniqueJobIds = [...new Set(jobIds.filter(isPositiveInteger))];
  if (uniqueJobIds.length === 0) {
    return {
      kind: "ids",
      ids: [],
      status: "complete",
      complete: true,
      rawRowsRead: 0,
      returnedRowsRead: 0,
      permissionExcluded: 0,
      unresolvedRows: 0,
      pagesRead: 0,
      rateLimitRetries: 0,
      rateLimitSleepMs: 0,
      cacheHits: 0,
      warnings: [],
    };
  }

  const ids: number[] = [];
  const seen = new Set<number>();
  const statuses: ReadAllStatus[] = [];
  let rawRowsRead = 0;
  let returnedRowsRead = 0;
  let permissionExcluded = 0;
  let unresolvedRows = 0;
  let cacheHits = 0;
  let pagesRead = 0;
  let rateLimitRetries = 0;
  let rateLimitSleepMs = 0;
  const warnings: string[] = [];
  let actorId: number | undefined;
  let effectiveActorId: number | undefined;
  let scoped: boolean | undefined;
  let permissionScope: RecruiterPermissionScope | undefined;
  let completedJobBatches = 0;

  // Chunk job_ids at v3's maxItems:50 cap and union the results (R3). Mirrors the chunked endpoint read
  // and the two-hop scorecard derive: failure after a completed chunk is an honest partial result,
  // even if that chunk returned zero ids; failure in the first chunk is a hard denial.
  const jobBatches = chunks(uniqueJobIds, JOB_ID_BATCH_SIZE);
  const jobReads = await mapWithConcurrency(jobBatches, (jobBatch) =>
    readAllScopedRows<Record<string, unknown>>(
      runtime,
      exposedToolName,
      scopedToolName,
      { job_ids: jobBatch.join(",") },
      deadline
    )
  );
  for (const read of jobReads) {
    if (read.kind === "denial") {
      const truncated = denialTruncationStatus(read.result);
      if (truncated && completedJobBatches > 0) {
        statuses.push(truncated);
        warnings.push(`scope-id derivation stopped after a later job batch (${truncated})`);
        break;
      }
      return { kind: "denial", result: read.result };
    }
    for (const row of read.rows) {
      const id = pickId(row);
      if (id !== null && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    statuses.push(read.status);
    completedJobBatches += 1;
    rawRowsRead += read.rawRowsRead;
    returnedRowsRead += read.rowsReturnedRead ?? read.rows.length;
    permissionExcluded += read.permissionExcluded;
    unresolvedRows += read.unresolvedRows;
    cacheHits += read.cacheHits;
    pagesRead += read.pagesRead;
    rateLimitRetries += read.rateLimitRetries;
    rateLimitSleepMs += read.rateLimitSleepMs;
    warnings.push(...read.warnings);
    actorId ??= read.actorId;
    effectiveActorId ??= read.effectiveActorId;
    scoped ??= read.scoped;
    permissionScope ??= read.permissionScope;
  }

  const status = combineReadStatuses(statuses);
  return {
    kind: "ids",
    ids,
    status,
    complete: status === "complete",
    rawRowsRead,
    returnedRowsRead,
    permissionExcluded,
    unresolvedRows,
    cacheHits,
    pagesRead,
    rateLimitRetries,
    rateLimitSleepMs,
    warnings,
    actorId,
    effectiveActorId,
    scoped,
    permissionScope,
  };
}

export function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

// Bounded concurrency for independent chunk reads (T1.3). Chunks carry disjoint id sets, so the
// network calls are independent; only the FOLD is order-sensitive (denial precedence, truncation
// break). Workers run up to CHUNK_READ_CONCURRENCY at a time; results settle into their original
// slot so callers fold IN CHUNK ORDER and observable semantics stay byte-identical to the
// sequential loop (a truncation break simply ignores any later chunks' results, exactly as the
// sequential loop never ran them). The limit is deliberately small: all sessions share ONE Harvest
// token budget, and a cross-session budget scheduler is the S1 residual — until that exists, a
// larger burst here would trade 429 risk for latency.
const CHUNK_READ_CONCURRENCY = 3;

export async function mapWithConcurrency<TIn, TOut>(
  items: TIn[],
  worker: (item: TIn) => Promise<TOut>,
  limit: number = CHUNK_READ_CONCURRENCY
): Promise<TOut[]> {
  const results = new Array<TOut>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(lanes);
  return results;
}


function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
