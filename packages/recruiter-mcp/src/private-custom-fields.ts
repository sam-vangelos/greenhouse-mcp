// Greenhouse marks a custom-field DEFINITION `private`, which restricts its VALUES to users holding
// the matching "View Private" permission (docs/harvest-v3-api/raw/reference/0077-get_v3-custom-fields.md).
// The evidence projector gates on key NAMES only, so private values — visa status, background-check
// result, salary expectation, the *_hris masked-PII variants — flowed verbatim on candidates, jobs
// and offers. Scoped reads run under an org-wide service credential, so Greenhouse's own permission
// never fires and this layer is the only enforcer.
//
// Definitions are org SCHEMA: they change on the order of weeks, not requests. One cached read per
// process per TTL keeps this off the per-request hot path.

import type { AuthenticatedSession } from "./types.js";
import type { RecruiterToolRuntime } from "./runtime.js";

const DEFAULT_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  promise: Promise<ReadonlySet<string>>;
  expiresAt: number;
}

let cache: CacheEntry | undefined;

/** Test seam: drop the memoized definition set. */
export function _resetPrivateCustomFieldCache(): void {
  cache = undefined;
}

function readTtlMs(env: NodeJS.ProcessEnv): number {
  const raw = env.GREENHOUSE_RECRUITER_PRIVATE_CUSTOM_FIELD_TTL_MS;
  if (raw === undefined || raw.length === 0) return DEFAULT_TTL_MS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_TTL_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// 500 definitions per page. A tenant with more than 50,000 custom-field definitions is a broken
// pagination contract, not a real configuration.
const MAX_DEFINITION_PAGES = 100;

/**
 * The `name_key`s of EVERY custom-field definition flagged `private` — active or archived, across
 * every page.
 *
 * This set is a strip list, so anything missing from it is a value that passes through. That makes
 * every narrowing of the INPUT a leak, and there were two:
 *
 *   - `active: "true"` asked for live fields only, but `/v3/custom_fields` "defaults to returning
 *     both active and archived". Archiving a private definition does not remove its values from the
 *     rows that already carry them, so the filter quietly dropped those keys off the strip list
 *     while the values stayed readable. The param is gone; the default is what this needs.
 *   - Only the first page was read. A definition past page 1 was simply absent from the strip list.
 *     Cursors are now followed to exhaustion, and a page that fails takes the whole lookup down to
 *     the fail-closed path rather than returning a partial set that reads as complete.
 *
 * Fails CLOSED in a bounded way: if the definitions cannot be read we cannot tell which fields are
 * private, so the caller withholds ALL custom-field values for that request rather than guessing.
 * That is signalled by a rejected promise, not by an empty set — an empty set means "read
 * succeeded, nothing is private".
 */
export async function resolvePrivateCustomFieldKeys<S extends AuthenticatedSession>(
  runtime: RecruiterToolRuntime<S>,
  env: NodeJS.ProcessEnv = process.env
): Promise<ReadonlySet<string>> {
  const ttlMs = readTtlMs(env);
  const now = runtime.now();
  if (cache && cache.expiresAt > now) return cache.promise;

  const promise = (async () => {
    const keys = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;

    do {
      const response = await runtime.scopedReader.scopedRead(
        runtime.session,
        "list_custom_fields",
        cursor === undefined ? { per_page: 500 } : { cursor },
        { signal: runtime.signal }
      );
      if (!response.ok) {
        throw new Error("custom-field definitions unavailable");
      }
      for (const row of Array.isArray(response.data) ? response.data : []) {
        if (!isRecord(row)) continue;
        if (row.private !== true) continue;
        const nameKey = row.name_key;
        if (typeof nameKey === "string" && nameKey.length > 0) keys.add(nameKey);
      }

      const next = response.nextCursor;
      cursor = typeof next === "string" && next.length > 0 ? next : undefined;
      // A repeated cursor, or an implausible page count, means the pagination contract is not
      // holding. Throwing hands the caller its fail-closed path; looping would hang the request and
      // breaking early would silently return a partial strip list, which is the leak this fixes.
      if (cursor !== undefined && seenCursors.has(cursor)) {
        throw new Error("custom-field definitions returned a repeating cursor");
      }
      if (cursor !== undefined) seenCursors.add(cursor);
      pages += 1;
      if (pages > MAX_DEFINITION_PAGES) {
        throw new Error("custom-field definitions exceeded the page ceiling");
      }
    } while (cursor !== undefined);

    return keys as ReadonlySet<string>;
  })();

  // A failed lookup must not be memoized as a stable answer; drop it so the next call retries.
  cache = { promise, expiresAt: now + ttlMs };
  promise.catch(() => {
    if (cache?.promise === promise) cache = undefined;
  });
  return promise;
}
