export const DEFAULT_EXTERNAL_LOOKUP_TIMEOUT_MS = 5_000;

export class ExternalLookupTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms.`);
    this.name = "ExternalLookupTimeoutError";
  }
}

export function readLookupTimeoutMs(
  value: string | undefined,
  envName: string,
  fallback = DEFAULT_EXTERNAL_LOOKUP_TIMEOUT_MS
): number {
  if (value === undefined || value.trim().length === 0) return fallback;
  if (value.trim() === value && /^[1-9]\d*$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error(`${envName} must be a positive integer number of milliseconds.`);
}

/**
 * Bound an outbound lookup by `timeoutMs`, and — when the caller supplies one on `init` — by the
 * caller's own lifetime as well.
 *
 * The caller's signal used to be DROPPED here. This function owns `init.signal` for its timeout, so
 * `{ ...init, signal: controller.signal }` overwrote whatever the caller had put there, silently.
 * That is what made the entitlement memo's cancellation cosmetic: it checked its signal before
 * starting and then had no way to reach the request it started, so the last subscriber walking away
 * left a Supabase read running to full timeout. Linking the two signals costs one listener and makes
 * `signal` mean the same thing here as it does on `fetch`.
 *
 * The timeout still wins on its own terms: it aborts and rejects with `ExternalLookupTimeoutError`
 * rather than the caller's reason, so a slow upstream stays distinguishable from a cancelled one.
 */
export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: URL | RequestInfo,
  init: RequestInit,
  timeoutMs: number,
  label: string
): Promise<Response> {
  // No timeout to impose means no controller to substitute, so the caller's signal already reaches
  // the request untouched.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetchImpl(input, init);
  }
  const callerSignal = init.signal ?? undefined;
  callerSignal?.throwIfAborted();
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new ExternalLookupTimeoutError(label, timeoutMs));
    }, timeoutMs);
    // Both cleanups on every exit, including the one the timeout already rejected: a listener left
    // on a long-lived caller signal would otherwise accumulate one entry per lookup.
    const settle = () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    };
    fetchImpl(input, { ...init, signal: controller.signal }).then(
      (response) => {
        settle();
        resolve(response);
      },
      (error) => {
        settle();
        reject(error);
      }
    );
  });
}
