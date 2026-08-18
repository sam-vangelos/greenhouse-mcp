/**
 * Read-only foundation of the Greenhouse Harvest v3 HTTP client.
 *
 * This module owns the read substrate shared by both the base read MCP and the
 * scoped-recruiter pilot: configuration, auth wiring, the rate-limit/retry machinery,
 * URL building, the sanitized error posture, and the GET primitives (apiGet /
 * apiGetWithCursor). It deliberately contains no write or admin adapter.
 *
 * Why this file exists: the scoped-recruiter pilot is read-only as a BUILD FACT, not a
 * convention. The scoped readers import this module exclusively, so write/admin primitives
 * are never resident in the scoped runtime's import graph. The static guard that enforces
 * this lives at scoped-recruiter-mcp/scripts/verify-guards.mjs.
 */

import { getAccessToken, _resetAuthState } from "./auth.js";

const API_ORIGIN = "https://harvest.greenhouse.io";
const DEFAULT_BASE_PATH = "/v3";

export interface ClientConfig {
  clientId: string;
  clientSecret: string;
}

let config: ClientConfig | null = null;

export function configure(clientId: string, clientSecret: string): void {
  config = { clientId, clientSecret };
}

/**
 * Reset all module-scoped state. For test isolation only.
 */
export function _resetClientState(): void {
  config = null;
  _resetAuthState();
}

function getConfig(): ClientConfig {
  if (!config) {
    throw new Error(
      "Greenhouse client not configured. Add your Greenhouse connection details in the MCP client setup."
    );
  }
  return config;
}

function buildUrl(
  path: string,
  params?: Record<string, string | number | boolean | undefined>
): string {
  return buildUrlForAdapter(
    {
      origin: API_ORIGIN,
      basePath: DEFAULT_BASE_PATH,
    },
    path,
    params
  );
}

function buildUrlForAdapter(
  adapter: { origin: string; basePath: string },
  path: string,
  params?: Record<string, string | number | boolean | undefined>
): string {
  const base =
    /^https?:\/\//.test(path)
      ? path
      : /^\/v\d+\//.test(path)
        ? `${adapter.origin}${path}`
        : `${adapter.origin}${adapter.basePath}${path}`;
  const url = new URL(base);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

function parseLinkHeader(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Rate-limit retry
// ---------------------------------------------------------------------------

export const MAX_RETRIES = 3;            // 1 initial attempt + up to 3 retries = 4 total
export const DEFAULT_RETRY_SECONDS = 30;
const MAX_RETRY_SECONDS = 120;    // cap absurd Retry-After values

// Injectable sleep for test isolation (avoids real delays in 429 retry tests)
export let sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export function _setSleep(fn: typeof sleep): void { sleep = fn; }

// Stable error-identity contract so consumers across packages can detect rate-limit exhaustion
// without matching on the (mutable) message text.
export const RATE_LIMIT_ERROR_NAME = "RateLimitError";

// Stable cancellation identity for caller-initiated aborts. This is deliberately
// distinct from UpstreamTimeoutError: a disconnected MCP client is not an
// upstream failure and must not be retried or reported as a clean empty read.
export const REQUEST_ABORTED_ERROR_NAME = "RequestAbortedError";

export class RequestAbortedError extends Error {
  constructor() {
    super("Greenhouse API request was cancelled by the caller.");
    this.name = REQUEST_ABORTED_ERROR_NAME;
  }
}

export class RateLimitError extends Error {
  retryAfterSeconds: number;
  constructor(retryAfter: number) {
    super(`Rate limited. Retry after ${retryAfter} seconds.`);
    this.name = RATE_LIMIT_ERROR_NAME;
    this.retryAfterSeconds = retryAfter;
  }
}

// Per-request upstream timeout (2026-07-02, the honesty floor): without an AbortSignal, one
// stalled Greenhouse socket hangs a tool through every between-page deadline until the MCP
// client's ~240s transport death with zero payload — misread live as a server outage. Every
// upstream request aborts at this budget and is retried once; the scoped runtime's deadline
// machinery then truncates honestly with whatever was already read.
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_RETRIES = 1;

export function requestTimeoutMs(): number {
  const raw = Number.parseInt(process.env.GREENHOUSE_REQUEST_TIMEOUT_MS ?? "", 10);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_REQUEST_TIMEOUT_MS;
}

export const UPSTREAM_TIMEOUT_ERROR_NAME = "UpstreamTimeoutError";

export class UpstreamTimeoutError extends Error {
  constructor(path: string, timeoutMs: number) {
    super(`Greenhouse API request timed out after ${timeoutMs}ms: ${path}`);
    this.name = UPSTREAM_TIMEOUT_ERROR_NAME;
  }
}

function isAbortTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

// One revoked-token recovery per request. A single fresh token fixes a
// revocation; if a brand-new token still 401s, the problem is not staleness, so
// surface it rather than loop.
export const MAX_AUTH_REFRESHES = 1;

// Stable error-identity contract (mirrors RATE_LIMIT_ERROR_NAME) so cross-package
// consumers can detect a revoked-token failure without matching message text.
export const AUTH_REVOKED_ERROR_NAME = "AuthRevokedError";

// A Harvest 401: the cached OAuth access token was revoked/superseded. Greenhouse
// client_credentials has single-active-token semantics, so a peer service on the
// same client_id/secret, a concurrent refresh, or a second instance can silently
// revoke this process's cached token. withRetry catches this to drop the cached
// token and retry ONCE with a fresh one. The message keeps the "Greenhouse API
// error: 401" prefix so read-all.ts httpErrorStatus() still recovers the status
// if a refresh does not clear the condition.
export class AuthRevokedError extends Error {
  readonly endpoint: string;
  readonly correlationId: string;
  constructor(endpoint: string, correlationId: string) {
    super(
      `Greenhouse API error: 401 Unauthorized (${endpoint}) [correlation_id=${correlationId}] (auth token revoked; refreshed and retried)`
    );
    this.name = AUTH_REVOKED_ERROR_NAME;
    this.endpoint = endpoint;
    this.correlationId = correlationId;
  }
}

export interface ApiRateLimitInfo {
  limit?: number;
  remaining?: number;
  resetAt?: number;
  retryAfterSeconds?: number;
  observedAt: number;
}

export interface ApiRetryInfo {
  attempts: number;
  rateLimitRetries: number;
  sleptMs: number;
  retryAfterSeconds: number[];
}

export interface ApiResponseMeta {
  rateLimit?: ApiRateLimitInfo;
  retry: ApiRetryInfo;
  /** Added by higher-level shared read caches; raw network responses report zero/undefined. */
  cacheHits?: number;
}

export interface RetryContext {
  attempts: number;
  rateLimitRetries: number;
  sleptMs: number;
  retryAfterSeconds: number[];
  authRefreshes: number;
  timeoutRetries: number;
}

export async function withRetry<T>(
  fn: (context: RetryContext) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const context: RetryContext = {
    attempts: 0,
    rateLimitRetries: 0,
    sleptMs: 0,
    retryAfterSeconds: [],
    authRefreshes: 0,
    timeoutRetries: 0,
  };
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    throwIfAborted(signal);
    try {
      context.attempts = attempt + 1;
      return await fn(context);
    } catch (err) {
      throwIfAborted(signal);
      if (err instanceof RateLimitError && attempt < MAX_RETRIES) {
        const waitSeconds = Math.min(err.retryAfterSeconds, MAX_RETRY_SECONDS);
        context.rateLimitRetries += 1;
        context.retryAfterSeconds.push(waitSeconds);
        context.sleptMs += waitSeconds * 1000;
        console.error(
          `[greenhouse-mcp] 429 rate limited — waiting ${waitSeconds}s (attempt ${attempt + 1}/${MAX_RETRIES})`
        );
        await waitForRetry(waitSeconds * 1000, signal);
        continue;
      }
      // A stalled socket aborted at the per-request timeout: retry once immediately (a fresh
      // connection usually succeeds), then fail with the stable error name so the runtime can
      // classify — never hang into the client's transport timeout.
      if (err instanceof UpstreamTimeoutError && context.timeoutRetries < MAX_TIMEOUT_RETRIES && attempt < MAX_RETRIES) {
        context.timeoutRetries += 1;
        console.error(`[greenhouse-mcp] request timed out after ${requestTimeoutMs()}ms — retrying once on a fresh connection`);
        continue;
      }
      // A revoked token was already dropped at the throw site (see
      // throwForRetriableStatus). Retry once with a fresh token WITHOUT spending
      // the rate-limit attempt budget, so a 401 and 429 can't starve each other.
      if (err instanceof AuthRevokedError && context.authRefreshes < MAX_AUTH_REFRESHES) {
        context.authRefreshes += 1;
        console.error(
          `[greenhouse-mcp] 401 auth token revoked — dropped cache, retrying with a fresh token`
        );
        attempt--;
        continue;
      }
      throw err;
    }
  }
  throw new Error("Unreachable");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new RequestAbortedError();
}

function waitForRetry(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return sleep(ms);
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new RequestAbortedError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    sleep(ms).then(
      () => {
        cleanup();
        resolve();
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
    if (signal.aborted) onAbort();
  });
}

function waitForCaller<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return operation;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new RequestAbortedError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
    if (signal.aborted) onAbort();
  });
}

function createFetchAbort(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; timedOut: () => boolean; cleanup: () => void } {
  const controller = new AbortController();
  let timeoutFired = false;
  const onCallerAbort = () => controller.abort();
  if (callerSignal?.aborted) {
    controller.abort();
  } else {
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timeoutFired = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeoutFired,
    cleanup: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

export function parseRetryAfter(res: Response): number {
  const raw = parseInt(res.headers.get("Retry-After") || "", 10);
  return isNaN(raw) ? DEFAULT_RETRY_SECONDS : raw;
}

function responseMeta(res: Response, retryContext: RetryContext): ApiResponseMeta {
  const retry: ApiRetryInfo = {
    attempts: retryContext.attempts,
    rateLimitRetries: retryContext.rateLimitRetries,
    sleptMs: retryContext.sleptMs,
    retryAfterSeconds: [...retryContext.retryAfterSeconds],
  };
  const rateLimit = readRateLimitInfo(res);
  return {
    retry,
    ...(rateLimit ? { rateLimit } : {}),
  };
}

function readRateLimitInfo(res: Response): ApiRateLimitInfo | undefined {
  const limit = readHeaderInt(res.headers, ["X-RateLimit-Limit", "RateLimit-Limit"]);
  const remaining = readHeaderInt(res.headers, ["X-RateLimit-Remaining", "RateLimit-Remaining"]);
  const resetAt = readResetAt(res.headers, ["X-RateLimit-Reset", "RateLimit-Reset"]);
  const retryAfterSeconds = readRetryAfterSeconds(res.headers.get("Retry-After"));
  if (
    limit === undefined &&
    remaining === undefined &&
    resetAt === undefined &&
    retryAfterSeconds === undefined
  ) {
    return undefined;
  }
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    observedAt: Date.now(),
  };
}

function readHeaderInt(headers: Headers, names: string[]): number | undefined {
  for (const name of names) {
    const raw = headers.get(name);
    if (!raw) continue;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function readResetAt(headers: Headers, names: string[]): number | undefined {
  for (const name of names) {
    const raw = headers.get(name);
    if (!raw) continue;
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric > 10_000_000_000 ? Math.trunc(numeric) : Math.trunc(numeric * 1000);
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readRetryAfterSeconds(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return Math.max(0, (parsed - Date.now()) / 1000);
  return undefined;
}

// ---------------------------------------------------------------------------
// Sanitized error posture
// ---------------------------------------------------------------------------
//
// Policy anchor: docs/greenhouse-mcp-output-doctrine.md §5 "Error Posture".
//
// On any non-2xx (non-429) response, the thrown Error message must be a
// caller-safe sanitized string and MUST NOT include response body, request
// params, query string, or any caller-supplied input. The response body is
// written to stderr only, keyed by a short correlation ID that also appears
// in the thrown message so an operator can cross-reference the two.

function newCorrelationId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Drain the error body to stderr under a fresh correlation id (never into the
// thrown message — sanitized-error posture, §5). Returns the correlation id so
// the thrown/rethrown error can reference the same line.
async function logUpstreamErrorBody(res: Response, endpoint: string): Promise<string> {
  const correlationId = newCorrelationId();
  let bodyText: string;
  try {
    bodyText = await res.text();
  } catch {
    bodyText = "<unreadable>";
  }
  console.error(
    `[greenhouse-mcp] ERROR ${correlationId} ${res.status} ${endpoint} body=${bodyText}`
  );
  return correlationId;
}

async function handleNonOkResponse(res: Response, endpoint: string): Promise<never> {
  const correlationId = await logUpstreamErrorBody(res, endpoint);
  const statusText = res.statusText ?? "";
  throw new Error(
    `Greenhouse API error: ${res.status} ${statusText} (${endpoint}) [correlation_id=${correlationId}]`
  );
}

/**
 * Single choke point for a non-2xx Harvest read. Returns normally for 2xx.
 *   429 -> RateLimitError            (withRetry backs off and retries)
 *   401 -> drop the revoked cached token + AuthRevokedError (withRetry mints a
 *          fresh token and retries once)
 *   other non-2xx -> terminal handleNonOkResponse
 */
async function throwForRetriableStatus(res: Response, endpoint: string): Promise<void> {
  if (res.status === 429) {
    throw new RateLimitError(parseRetryAfter(res));
  }
  if (res.status === 401) {
    const correlationId = await logUpstreamErrorBody(res, endpoint);
    _resetAuthState();
    throw new AuthRevokedError(endpoint, correlationId);
  }
  if (!res.ok) {
    await handleNonOkResponse(res, endpoint);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApiResponse<T> {
  data: T;
  nextCursor: string | null;
  meta?: ApiResponseMeta;
}

// ---------------------------------------------------------------------------
// Read primitives
// ---------------------------------------------------------------------------

async function adapterGet<T>(
  adapter: { origin: string; basePath: string },
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
  signal?: AbortSignal
): Promise<ApiResponse<T>> {
  return withRetry(async (retryContext) => {
    throwIfAborted(signal);
    const { clientId, clientSecret } = getConfig();
    // Token minting is single-flight and may have other subscribers. Stop this
    // caller's wait without cancelling the shared mint, then re-check before GET.
    const token = await waitForCaller(getAccessToken(clientId, clientSecret), signal);
    throwIfAborted(signal);
    const url = buildUrlForAdapter(adapter, path, params);

    console.error(`[greenhouse-mcp] GET ${new URL(url).pathname}`);

    let res: Response;
    const requestAbort = createFetchAbort(signal, requestTimeoutMs());
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: requestAbort.signal,
      });
    } catch (err: unknown) {
      if (signal?.aborted) {
        throw new RequestAbortedError();
      }
      if (requestAbort.timedOut() || isAbortTimeout(err)) {
        console.error(`[greenhouse-mcp] FETCH TIMED OUT after ${requestTimeoutMs()}ms: ${new URL(url).pathname}`);
        throw new UpstreamTimeoutError(new URL(url).pathname, requestTimeoutMs());
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[greenhouse-mcp] FETCH FAILED: ${msg}`);
      if (err instanceof Error && err.cause) {
        console.error(`[greenhouse-mcp] cause: ${JSON.stringify(err.cause)}`);
      }
      throw new Error(`Greenhouse API fetch failed: ${msg}`);
    } finally {
      requestAbort.cleanup();
    }

    console.error(`[greenhouse-mcp] Response: ${res.status}`);

    await throwForRetriableStatus(res, new URL(url).pathname);

    const data = (await res.json()) as T;
    const linkHeader = res.headers.get("link");
    const nextUrl = parseLinkHeader(linkHeader);

    let nextCursor: string | null = null;
    if (nextUrl) {
      const parsed = new URL(nextUrl);
      nextCursor = parsed.searchParams.get("cursor");
    }

    return { data, nextCursor, meta: responseMeta(res, retryContext) };
  }, signal);
}

export async function apiGet<T>(
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
  signal?: AbortSignal
): Promise<ApiResponse<T>> {
  return adapterGet(
    {
      origin: API_ORIGIN,
      basePath: DEFAULT_BASE_PATH,
    },
    path,
    params,
    signal
  );
}

/**
 * Fetch a single page using a cursor (for pagination).
 * Per v3 docs: when using cursor, it must be the only query param.
 */
export async function apiGetWithCursor<T>(
  path: string,
  cursor: string,
  signal?: AbortSignal
): Promise<ApiResponse<T>> {
  return adapterGetWithCursor(
    {
      origin: API_ORIGIN,
      basePath: DEFAULT_BASE_PATH,
    },
    path,
    cursor,
    signal
  );
}

async function adapterGetWithCursor<T>(
  adapter: { origin: string; basePath: string },
  path: string,
  cursor: string,
  signal?: AbortSignal
): Promise<ApiResponse<T>> {
  return withRetry(async (retryContext) => {
    throwIfAborted(signal);
    const { clientId, clientSecret } = getConfig();
    const token = await waitForCaller(getAccessToken(clientId, clientSecret), signal);
    throwIfAborted(signal);

    const url = new URL(
      buildUrlForAdapter(adapter, path)
    );
    url.searchParams.set("cursor", cursor);

    console.error(`[greenhouse-mcp] GET (cursor) ${url.pathname}`);

    let res: Response;
    const requestAbort = createFetchAbort(signal, requestTimeoutMs());
    try {
      res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: requestAbort.signal,
      });
    } catch (err: unknown) {
      if (signal?.aborted) {
        throw new RequestAbortedError();
      }
      if (requestAbort.timedOut() || isAbortTimeout(err)) {
        console.error(`[greenhouse-mcp] FETCH TIMED OUT after ${requestTimeoutMs()}ms: ${url.pathname}`);
        throw new UpstreamTimeoutError(url.pathname, requestTimeoutMs());
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[greenhouse-mcp] FETCH FAILED: ${msg}`);
      throw new Error(`Greenhouse API fetch failed: ${msg}`);
    } finally {
      requestAbort.cleanup();
    }

    await throwForRetriableStatus(res, url.pathname);

    const data = (await res.json()) as T;
    const linkHeader = res.headers.get("link");
    const nextUrl = parseLinkHeader(linkHeader);

    let nextCursor: string | null = null;
    if (nextUrl) {
      const parsed = new URL(nextUrl);
      nextCursor = parsed.searchParams.get("cursor");
    }

    return { data, nextCursor, meta: responseMeta(res, retryContext) };
  }, signal);
}
