/**
 * Pure classification of upstream Greenhouse read failures from their sanitized
 * error text. Kept dependency-free (no runtime/read-all imports) so it can be used
 * by both the runtime error mapper and read-all without an import cycle.
 */

/**
 * The HTTP status of an upstream Greenhouse read error, or null if it isn't one. The raw client's
 * handleNonOkResponse throws `Error("Greenhouse API error: <status> ...")` (client-readonly.ts), and
 * read-all/scopedReadWithTimeout re-throw it unwrapped, so the status is recoverable from the message.
 * Used to distinguish a 403 (the deployed token structurally lacks an endpoint's scope — forbidden on
 * every call) from a transient 5xx/network failure. A miss returns null, so callers that key on a
 * specific status fail closed (the safe direction) rather than mis-degrade.
 */
export function httpErrorStatus(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const match = /Greenhouse API error:\s*(\d{3})\b/.exec(error.message);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * A rate-limit failure (the raw client's RateLimitError, thrown when the 429 retry
 * budget is exhausted). It does NOT carry the "Greenhouse API error: 429" text
 * httpErrorStatus keys on, so single-read paths (get_my_*) that only call
 * classifyUpstreamError would mislabel it as an opaque UPSTREAM_ERROR. Detected by
 * the client's error name (kept dependency-free — the constant value is "RateLimitError")
 * with a message fallback, matching read-all's own rate-limit interception.
 */
export function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "RateLimitError" || error.message.toLowerCase().includes("rate limited");
}

/**
 * Turn an upstream Greenhouse failure into a caller-safe denial message that names
 * the CAUSE CLASS instead of the opaque "failed before returning data" — so an
 * operator can tell "regenerate the credential" (401/403) from "back off" (429)
 * from "a param/code bug" (422) from "transient, retry" (5xx). The status is
 * recovered from the sanitized error text via httpErrorStatus (no body/PII). When
 * the status is unknown or not a recognized class, returns the caller's fallback.
 */
export function classifyUpstreamError(error: unknown, fallbackMessage: string): string {
  const status = httpErrorStatus(error);
  if (status === 401 || status === 403) {
    return "Upstream Greenhouse authentication failed — the Greenhouse API credential may need to be regenerated.";
  }
  if (status === 429) {
    return "Upstream Greenhouse rate limit is still active after the retry budget — retry shortly.";
  }
  if (status === 422) {
    return "Upstream Greenhouse rejected the request (unsupported parameter or value).";
  }
  if (status !== null && status >= 500) {
    return "Upstream Greenhouse service error (transient) — retry shortly.";
  }
  return fallbackMessage;
}
