import type { ApiResponseMeta, ScopedReadResult } from "../../scoped-core/src/index.js";
import {
  assertWithinToolDeadline,
  deny,
  fromScopedRead,
  isToolCancelledError,
  isToolTimeoutError,
  scopedReadWithTimeout,
  type RecruiterToolRuntime,
  type ToolDeadline,
} from "./runtime.js";
import type { RecruiterPermissionScope, RecruiterToolResult } from "./types.js";
import { RATE_LIMIT_ERROR_NAME } from "../../control-plane/dist/client-readonly.js";

const DEFAULT_READ_ALL_PER_PAGE = 500;
const RATE_LIMIT_SAFETY_BUFFER_MS = 250;
// Hard backstop against a runaway or cyclic cursor when no deadline is set (or a self-referential
// cursor that would otherwise burn the full budget). At per_page=500 a very large tenant can exceed the page budget — far beyond
// any recruiter scope — so it never truncates a real read; hitting it yields incomplete_page_cap,
// never "complete".
const MAX_READ_ALL_PAGES = 1000;

export type ReadAllStatus =
  | "complete"
  | "incomplete_scope_resolution"
  | "incomplete_timeout"
  | "incomplete_rate_limited"
  | "incomplete_page_cap";

export type ReadAllRowsResult<T extends Record<string, unknown>> =
  | {
      kind: "rows";
      rows: T[];
      rawRowsRead: number;
      /** Rows returned by every upstream read folded into this result, including bridge reads. */
      rowsReturnedRead?: number;
      permissionExcluded: number;
      unresolvedRows: number;
      pagesRead: number;
      status: ReadAllStatus;
      complete: boolean;
      paginationTruncated: boolean;
      nextCursor: string | null;
      perPage: number;
      rateLimitRetries: number;
      rateLimitSleepMs: number;
      cacheHits: number;
      warnings: string[];
      actorId?: number;
      effectiveActorId?: number;
      scoped?: boolean;
      permissionScope?: RecruiterPermissionScope;
    }
  | { kind: "denial"; result: RecruiterToolResult };

export interface ReadAllOptions {
  perPage?: number;
}

export let readAllSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function _setReadAllSleep(fn: typeof readAllSleep): void {
  readAllSleep = fn;
}

export async function readAllScopedRows<T extends Record<string, unknown>>(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  scopedToolName: string,
  params: Record<string, unknown>,
  deadline?: ToolDeadline,
  options: ReadAllOptions = {}
): Promise<ReadAllRowsResult<T>> {
  const rows: T[] = [];
  const perPage = options.perPage ?? DEFAULT_READ_ALL_PER_PAGE;
  const warnings: string[] = [];
  let rawRowsRead = 0;
  let rowsReturnedRead = 0;
  let permissionExcluded = 0;
  let unresolvedRows = 0;
  let actorId: number | undefined;
  let effectiveActorId: number | undefined;
  let scoped: boolean | undefined;
  let permissionScope: RecruiterPermissionScope | undefined;
  let pagesRead = 0;
  let cursor: string | null = typeof params.cursor === "string" && params.cursor.length > 0 ? params.cursor : null;
  let rateLimitRetries = 0;
  let rateLimitSleepMs = 0;
  let cacheHits = 0;
  let status: ReadAllStatus = "complete";
  const seenCursors = new Set<string>();

  while (true) {
    if (deadlineExpired(deadline)) {
      if (pagesRead === 0) {
        return {
          kind: "denial",
          result: deny(exposedToolName, "TOOL_TIMEOUT", "Scoped Greenhouse tool timed out before returning data."),
        };
      }
      status = "incomplete_timeout";
      warnings.push("read deadline elapsed before the next page could be fetched");
      break;
    }

    let response: ScopedReadResult;
    try {
      assertWithinToolDeadline(deadline);
      response = await scopedReadWithTimeout(
        runtime,
        scopedToolName,
        cursor ? { cursor } : firstPageParams(params, perPage),
        undefined,
        deadline
      );
    } catch (error) {
      if (isToolCancelledError(error)) {
        return {
          kind: "denial",
          result: deny(exposedToolName, "CANCELLED", "Scoped Greenhouse tool was cancelled because the client request ended."),
        };
      }
      if (isToolTimeoutError(error)) {
        if (pagesRead === 0) {
          return {
            kind: "denial",
            result: deny(exposedToolName, "TOOL_TIMEOUT", "Scoped Greenhouse tool timed out before returning data."),
          };
        }
        status = "incomplete_timeout";
        warnings.push("read deadline elapsed while fetching a page");
        break;
      }
      if (isRateLimitError(error)) {
        if (pagesRead === 0) {
          return {
            kind: "denial",
            result: deny(exposedToolName, "RATE_LIMITED", "Scoped Greenhouse read was rate limited before returning data."),
          };
        }
        status = "incomplete_rate_limited";
        warnings.push("upstream rate limit was still active after retry budget");
        break;
      }
      throw error;
    }

    const mapped = fromScopedRead(exposedToolName, response);
    if (!mapped.ok) {
      if (mapped.denial.code === "PERMISSION_JOIN_FAILED" && pagesRead > 0) {
        status = "incomplete_scope_resolution";
        warnings.push("a required parent permission read failed after earlier pages had completed");
        break;
      }
      return { kind: "denial", result: mapped };
    }

    pagesRead += 1;
    actorId ??= mapped.actorId;
    effectiveActorId ??= mapped.effectiveActorId;
    scoped ??= mapped.scoped;
    permissionScope ??= mapped.permissionScope;
    rawRowsRead += mapped.rowCounts?.raw ?? (Array.isArray(mapped.data) ? mapped.data.length : 0);
    rowsReturnedRead += mapped.rowCounts?.returned ?? (Array.isArray(mapped.data) ? mapped.data.length : 0);
    permissionExcluded += mapped.rowCounts?.permissionExcluded ?? 0;
    unresolvedRows += mapped.rowCounts?.unresolved ?? 0;
    if (mapped.rowCounts?.status === "incomplete_scope_resolution") {
      status = "incomplete_scope_resolution";
      warnings.push("one or more records could not be resolved through the required job-scope parent chain");
    }
    if (Array.isArray(mapped.data)) {
      rows.push(...(mapped.data.filter(isRecord) as T[]));
    }

    const meta = response.ok ? response.meta : undefined;
    rateLimitRetries += meta?.retry.rateLimitRetries ?? 0;
    rateLimitSleepMs += meta?.retry.sleptMs ?? 0;
    cacheHits += meta?.cacheHits ?? 0;

    cursor = response.ok ? response.nextCursor : null;
    if (!cursor) break;
    if (pagesRead >= MAX_READ_ALL_PAGES) {
      status = "incomplete_page_cap";
      warnings.push(`read stopped at the ${MAX_READ_ALL_PAGES}-page hard ceiling before exhausting all cursor pages`);
      break;
    }
    if (seenCursors.has(cursor)) {
      status = "incomplete_page_cap";
      warnings.push("read stopped after the upstream returned a repeated pagination cursor (cursor-cycle guard)");
      break;
    }
    seenCursors.add(cursor);

    const waitMs = nextRateLimitWaitMs(meta, runtime.now());
    if (waitMs > 0) {
      if (!deadlineAllowsWait(deadline, waitMs)) {
        status = "incomplete_rate_limited";
        warnings.push("rate-limit reset was beyond the remaining analysis deadline");
        break;
      }
      try {
        await waitForReadAll(waitMs, runtime.signal);
      } catch (error) {
        if (isToolCancelledError(error)) {
          return {
            kind: "denial",
            result: deny(exposedToolName, "CANCELLED", "Scoped Greenhouse tool was cancelled because the client request ended."),
          };
        }
        throw error;
      }
      rateLimitSleepMs += waitMs;
    }
  }

  const complete = status === "complete" && cursor === null;
  return {
    kind: "rows",
    rows,
    rawRowsRead,
    rowsReturnedRead,
    permissionExcluded,
    unresolvedRows,
    pagesRead,
    status: complete ? "complete" : status,
    complete,
    paginationTruncated: !complete,
    nextCursor: cursor,
    perPage,
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

function waitForReadAll(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return readAllSleep(ms);
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? abortError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    readAllSleep(ms).then(
      () => { cleanup(); resolve(); },
      (error) => { cleanup(); reject(error); }
    );
    if (signal.aborted) onAbort();
  });
}

function abortError(): Error {
  const error = new Error("Scoped Greenhouse read wait was cancelled by the caller.");
  error.name = "AbortError";
  return error;
}

export function combineReadStatuses(statuses: ReadAllStatus[]): ReadAllStatus {
  if (statuses.includes("incomplete_scope_resolution")) return "incomplete_scope_resolution";
  if (statuses.includes("incomplete_rate_limited")) return "incomplete_rate_limited";
  if (statuses.includes("incomplete_timeout")) return "incomplete_timeout";
  if (statuses.includes("incomplete_page_cap")) return "incomplete_page_cap";
  return "complete";
}

/**
 * Map a read-all denial to the truncation status it represents, or null if it is a hard failure that
 * must NOT be folded into a partial-but-honest aggregate. Only deadline/budget exhaustion
 * (TOOL_TIMEOUT / RATE_LIMITED) is truncation; a permission/upstream/audit denial is a real error.
 * Shared by the bridged endpoint read and the chunked scorecard id-derivation so a later-batch timeout
 * keeps already-collected rows/ids and discloses incomplete instead of discarding completed work.
 */
export function denialTruncationStatus(result: RecruiterToolResult): ReadAllStatus | null {
  if (result.ok) return null;
  if (result.denial.code === "TOOL_TIMEOUT") return "incomplete_timeout";
  if (result.denial.code === "RATE_LIMITED") return "incomplete_rate_limited";
  if (result.denial.code === "PERMISSION_JOIN_FAILED") return "incomplete_scope_resolution";
  return null;
}

export function readStatusMessage(status: ReadAllStatus): string | undefined {
  if (status === "complete") return undefined;
  if (status === "incomplete_rate_limited") {
    return "The read stopped before all cursor pages were fetched because the upstream rate-limit reset exceeded the remaining deadline.";
  }
  if (status === "incomplete_page_cap") {
    return "The read stopped before all cursor pages were fetched because it hit the hard page ceiling or a repeated pagination cursor.";
  }
  if (status === "incomplete_scope_resolution") {
    return "The read is incomplete because one or more required parent records could not be resolved to job permissions.";
  }
  return "The read stopped before all cursor pages were fetched because the analysis deadline elapsed.";
}

function firstPageParams(params: Record<string, unknown>, perPage: number): Record<string, unknown> {
  const { cursor: _cursor, per_page: _perPage, ...rest } = params;
  return { ...rest, per_page: perPage };
}

function deadlineExpired(deadline: ToolDeadline | undefined): boolean {
  if (!deadline) return false;
  return deadline.now() - deadline.startedAt >= deadline.timeoutMs;
}

function deadlineAllowsWait(deadline: ToolDeadline | undefined, waitMs: number): boolean {
  if (!deadline) return true;
  const remaining = deadline.timeoutMs - Math.max(0, deadline.now() - deadline.startedAt);
  return remaining > waitMs + RATE_LIMIT_SAFETY_BUFFER_MS;
}

function nextRateLimitWaitMs(meta: ApiResponseMeta | undefined, now: number): number {
  if (!meta?.rateLimit) return 0;
  const remaining = meta.rateLimit.remaining;
  if (remaining !== 0) return 0;
  if (typeof meta.rateLimit.retryAfterSeconds === "number") {
    return Math.max(0, Math.ceil(meta.rateLimit.retryAfterSeconds * 1000));
  }
  if (typeof meta.rateLimit.resetAt === "number") {
    return Math.max(0, Math.ceil(meta.rateLimit.resetAt - now));
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // Primary: the stable error-identity contract from the raw client. Fallback: legacy message match
  // in case the error is rewrapped across a layer that preserves the message but not the name.
  return error.name === RATE_LIMIT_ERROR_NAME || error.message.toLowerCase().includes("rate limited");
}

// Upstream-error classification lives in a dependency-free module so it can be used by both the
// runtime error mapper and read-all without an import cycle; re-exported here for existing callers.
export { httpErrorStatus, classifyUpstreamError } from "./upstream-error.js";
