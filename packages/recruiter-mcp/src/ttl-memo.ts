/**
 * Single-flight TTL memo — extracted verbatim from the permission-scope cache that lived at
 * `scoped-reader.ts:36-113` so a second caller (the action-entitlement lookup) can reuse the
 * mechanism instead of growing a third hand-rolled cache in this package. The behaviour it
 * encodes was learned the expensive way and is preserved exactly:
 *
 *   - TTL: an entry serves until `expiresAt`, then the next caller reloads.
 *   - Single-flight: concurrent callers for one key subscribe to ONE in-flight load. All
 *     recruiters share one Harvest budget and one Supabase project; a stampede of identical
 *     lookups is the failure mode this package keeps hitting.
 *   - Subscriber refcount: the shared load belongs to every current subscriber, so one caller
 *     abandoning it must not cancel another's. The upstream is aborted only when the LAST
 *     subscriber leaves before the load settles.
 *   - Evict on failure: a rejected load is never memoized. A transient outage must not become
 *     a TTL-long outage, and a failed permission/entitlement read must never be reused as an
 *     answer.
 *
 * It lives in its own module rather than being exported from `scoped-reader.ts` because that
 * file is the sanctioned raw-Greenhouse-client chokepoint (scripts/verify-guards.mjs:53-62):
 * importing it drags the Harvest read client into any module that only wants a cache. The
 * cache has no Greenhouse dependency and should not manufacture one.
 */

interface MemoEntry<V> {
  expiresAt: number;
  value: Promise<V>;
  controller: AbortController;
  subscribers: number;
  settled: boolean;
}

export interface TtlMemoConfig<K, V> {
  /** Non-positive disables memoization entirely: every call loads (the TTL-0 opt-out path). */
  ttlMs: number;
  load(key: K, signal?: AbortSignal): Promise<V>;
  /**
   * Optional per-value expiry clamp, applied when a load resolves. The memo takes the MINIMUM
   * of the configured TTL and whatever this returns, so a hook can only ever SHORTEN an
   * entry's life, never extend it past `ttlMs`. That direction is the point: it lets a caller
   * honour an authoritative expiry carried by the value itself (an entitlement row's
   * `expires_at`) without handing the cache a way to outlive its own budget.
   */
  deriveExpiryMs?(value: V, defaultExpiryMs: number): number;
  /** Injectable clock. Tests need TTL expiry to be deterministic, not slept through. */
  now?(): number;
  /** Message for the AbortError raised when a caller's signal fires with no `reason`. */
  cancelledMessage?: string;
}

export type TtlMemo<K, V> = (key: K, signal?: AbortSignal) => Promise<V>;

export function createTtlMemo<K, V>(config: TtlMemoConfig<K, V>): TtlMemo<K, V> {
  // Passthrough, not a zero-length cache: TTL 0 must behave as if this wrapper were absent,
  // which is how the permission provider's explicit opt-out has always worked.
  if (config.ttlMs <= 0) {
    return (key, signal) => config.load(key, signal);
  }
  const now = config.now ?? (() => Date.now());
  const cancelledMessage = config.cancelledMessage ?? "Memoized lookup was cancelled by the caller.";
  const cache = new Map<K, MemoEntry<V>>();
  return (key, signal) => {
    signal?.throwIfAborted();
    let entry = cache.get(key);
    if (!entry || entry.expiresAt <= now()) {
      const controller = new AbortController();
      let created!: MemoEntry<V>;
      const value = config.load(key, controller.signal).then(
        (resolved) => {
          created.settled = true;
          if (config.deriveExpiryMs) {
            created.expiresAt = Math.min(created.expiresAt, config.deriveExpiryMs(resolved, created.expiresAt));
          }
          return resolved;
        },
        (error) => {
          created.settled = true;
          // Only if this entry is still the live one: a later call may already have replaced it.
          if (cache.get(key) === created) cache.delete(key);
          throw error;
        }
      );
      created = {
        expiresAt: now() + config.ttlMs,
        value,
        controller,
        subscribers: 0,
        settled: false,
      };
      entry = created;
      cache.set(key, entry);
    }
    return subscribeToMemoEntry(entry, signal, cancelledMessage);
  };
}

function subscribeToMemoEntry<V>(
  entry: MemoEntry<V>,
  signal: AbortSignal | undefined,
  cancelledMessage: string
): Promise<V> {
  signal?.throwIfAborted();
  entry.subscribers += 1;
  return new Promise<V>((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.subscribers -= 1;
      signal?.removeEventListener("abort", onAbort);
      if (entry.subscribers === 0 && !entry.settled) entry.controller.abort();
    };
    const onAbort = () => {
      release();
      reject(signal?.reason ?? memoAbortError(cancelledMessage));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    entry.value.then(
      (value) => { release(); resolve(value); },
      (error) => { release(); reject(error); }
    );
    if (signal?.aborted) onAbort();
  });
}

function memoAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
