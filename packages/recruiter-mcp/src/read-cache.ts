import type { ApiResponse, RawReadClient, ReadParams } from "../../scoped-core/src/index.js";

/**
 * Shared short-TTL cache for upstream Greenhouse GET reads — the scale-ceiling fix.
 *
 * All recruiters share ONE Harvest OAuth token (one org-wide rate budget), reads are
 * sequential, and the same org pages are read over and over (within one analysis: a
 * recipe reads applications, then stages, then scorecards; a broad diagnostic re-reads
 * applications per recipe; across recruiters: overlapping job scopes). Without a cache,
 * N concurrent analyses cascade into 429s. This collapses identical concurrent/near-term
 * reads to a single upstream fetch.
 *
 * SAFETY — why caching a raw response across actors is not a leak: this wraps ONLY the
 * data reader. The scoped layer applies the actor's permission filter (filterApplicationBackedRow
 * etc.) AFTER every read, so a cache hit still passes through that filter — actor B never sees
 * a row B isn't entitled to, even if actor A populated the entry. Actor-specific reads
 * (permission lookups) are NOT routed through this cache; they keep their own provider TTL.
 *
 * LIFETIME: the store is module-scoped so it survives the per-request server rebuild
 * (remote.ts), and the service runs a single instance (numInstances:1), so one process
 * cache is shared across every session. Errors are never cached (only resolved reads set it).
 */

interface CacheEntry {
  expiresAt: number;
  value: ApiResponse<unknown>;
}

const store = new Map<string, CacheEntry>();
interface InflightEntry {
  promise: Promise<ApiResponse<unknown>>;
  controller: AbortController;
  subscribers: number;
  settled: boolean;
}

const inflight = new Map<string, InflightEntry>();

export interface ReadCacheConfig {
  enabled: boolean;
  ttlMs: number;
  maxEntries: number;
  now: () => number;
}

const DEFAULT_READ_CACHE_TTL_MS = 30_000;
const DEFAULT_READ_CACHE_MAX_ENTRIES = 200;

export function readReadCacheConfig(env: NodeJS.ProcessEnv = process.env): ReadCacheConfig {
  return {
    // Opt-out, not opt-in: the cache is a correctness-neutral latency/rate-limit win and is on by
    // default. A single flag disables it entirely (e.g. to isolate a freshness question in debugging).
    enabled: env.GREENHOUSE_RECRUITER_READ_CACHE_DISABLED !== "true",
    ttlMs: readNonNegativeIntEnv(env.GREENHOUSE_RECRUITER_READ_CACHE_TTL_MS, "GREENHOUSE_RECRUITER_READ_CACHE_TTL_MS") ?? DEFAULT_READ_CACHE_TTL_MS,
    maxEntries: readPositiveIntEnv(env.GREENHOUSE_RECRUITER_READ_CACHE_MAX_ENTRIES, "GREENHOUSE_RECRUITER_READ_CACHE_MAX_ENTRIES") ?? DEFAULT_READ_CACHE_MAX_ENTRIES,
    now: () => Date.now(),
  };
}

/**
 * Deterministic key over (path, params, cursor). Param keys are sorted so a caller that
 * supplies the same filters in a different order still hits the same entry; undefined/empty
 * params are dropped (they never reach Greenhouse either — see createGreenhouseRawReader).
 */
export function readCacheKey(path: string, params: ReadParams = {}, cursor?: string): string {
  const normalizedParams = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== "")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify({ path, params: normalizedParams, cursor: cursor ?? null });
}

export function createCachingRawReader(inner: RawReadClient, config: ReadCacheConfig): RawReadClient {
  if (!config.enabled || config.ttlMs <= 0) return inner;
  return {
    async read<T = unknown>(
      path: string,
      params: ReadParams = {},
      cursor?: string,
      signal?: AbortSignal
    ): Promise<ApiResponse<T>> {
      throwIfAborted(signal);
      // Attachment rows carry seven-day signed download URLs. A resume read must mint/refetch that
      // URL through the permission-scoped path on every invocation, so this endpoint bypasses both
      // the TTL cache and single-flight coalescing. Scope filtering still happens after this raw read.
      if (path === "/attachments") {
        return inner.read<T>(path, params, cursor, signal);
      }
      const key = readCacheKey(path, params, cursor);

      const hit = store.get(key);
      if (hit && hit.expiresAt > config.now()) {
        return markCacheHit(hit.value) as ApiResponse<T>;
      }

      // Single-flight: concurrent identical reads coalesce onto one upstream fetch (the auth.ts
      // in-flight-token pattern) — the case that matters most when N sessions stampede the same page.
      const pending = inflight.get(key);
      if (pending) return subscribeToInflight<T>(pending, signal, true);

      const controller = new AbortController();
      let entry: InflightEntry;
      const promise = inner
        .read<T>(path, params, cursor, controller.signal)
        .then((value) => {
          store.set(key, { expiresAt: config.now() + config.ttlMs, value });
          evictIfNeeded(config.maxEntries);
          inflight.delete(key);
          entry.settled = true;
          return value;
        })
        .catch((error) => {
          inflight.delete(key);
          entry.settled = true;
          throw error;
        });
      entry = { controller, subscribers: 0, settled: false, promise };
      inflight.set(key, entry);
      return subscribeToInflight<T>(entry, signal, false);
    },
  };
}

function subscribeToInflight<T>(
  entry: InflightEntry,
  signal: AbortSignal | undefined,
  cacheHit: boolean
): Promise<ApiResponse<T>> {
  throwIfAborted(signal);
  entry.subscribers += 1;
  return new Promise<ApiResponse<T>>((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.subscribers -= 1;
      signal?.removeEventListener("abort", onAbort);
      // A shared request belongs to all current subscribers. One caller can
      // abandon it without cancelling another; the upstream is aborted only
      // after the last subscriber leaves.
      if (entry.subscribers === 0 && !entry.settled) entry.controller.abort();
    };
    const onAbort = () => {
      release();
      reject(abortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    entry.promise.then(
      (value) => {
        release();
        resolve((cacheHit ? markCacheHit(value) : value) as ApiResponse<T>);
      },
      (error) => {
        release();
        reject(error);
      }
    );
    if (signal?.aborted) onAbort();
  });
}

function markCacheHit(value: ApiResponse<unknown>): ApiResponse<unknown> {
  if (!value.meta) return value;
  return {
    ...value,
    meta: {
      ...value.meta,
      cacheHits: (value.meta.cacheHits ?? 0) + 1,
    },
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("Scoped Greenhouse cached read was cancelled by the caller.");
  error.name = "AbortError";
  return error;
}

// Bounded memory: on the single starter instance a burst of distinct keys could grow unbounded
// within the TTL window, so cap entries and evict oldest-inserted (Map preserves insertion order).
function evictIfNeeded(maxEntries: number): void {
  if (store.size <= maxEntries) return;
  const overflow = store.size - maxEntries;
  let removed = 0;
  for (const key of store.keys()) {
    store.delete(key);
    if (++removed >= overflow) break;
  }
}

/** Test-only: clear the module-scoped store + in-flight map so cases don't leak into each other. */
export function _resetReadCache(): void {
  store.clear();
  inflight.clear();
}

function readNonNegativeIntEnv(raw: string | undefined, name: string): number | null {
  if (raw === undefined || raw.trim().length === 0) return null;
  if (raw.trim() === raw && /^\d+$/.test(raw)) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error(`${name} must be a non-negative integer number.`);
}

function readPositiveIntEnv(raw: string | undefined, name: string): number | null {
  if (raw === undefined || raw.trim().length === 0) return null;
  if (raw.trim() === raw && /^[1-9]\d*$/.test(raw)) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error(`${name} must be a positive integer number.`);
}
