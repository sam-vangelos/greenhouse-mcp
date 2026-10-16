import { httpErrorStatus } from "../upstream-error.js";
import {
  combineReadStatuses,
  isCancellationDenial,
  readAllScopedRows,
  type ReadAllOptions,
  type ReadAllRowsResult,
  type ReadAllStatus,
} from "../read-all.js";
import { isToolCancelledError, type RecruiterToolRuntime, type ToolDeadline } from "../runtime.js";
import type { RecruiterToolResult } from "../types.js";

/**
 * A date window a caller asked for, in the shape both legs of the read need: the field it applies
 * to, its bounds, and (for the hire path) the fields that stand in when the primary one is absent.
 *
 * `fallbackFields` exists because a hire's date is `resolved_at` OR, when Greenhouse never wrote
 * one, `sent_on` — windowing a hire set on `resolved_at` alone would drop those rows silently on
 * the fallback leg, which is exactly the class of quiet loss this module was lifted out to stop.
 * Empty for every other caller, whose window means one field and no substitutes.
 */
export interface DateWindowSpec {
  field: string;
  fallbackFields?: string[];
  gte?: string;
  lte?: string;
  gt?: string;
  lt?: string;
}

export interface DateFallbackOutcome<T extends Record<string, unknown>> {
  read: ReadAllRowsResult<T>;
  /** True when the upstream rejected the native filter and the window was applied here instead. */
  windowAppliedLocally: boolean;
  /** The bracket params the upstream 422'd, verbatim, so the disclosure can name them. */
  dateParamsRejected: string[];
  /** The row-level fields the local window was evaluated on (primary + declared fallbacks). */
  windowFields: string[];
  /** Rows dropped by the local window because they carried none of those fields. */
  rowsMissingField: number;
  /**
   * The rows as the upstream returned them, BEFORE the local window ran — set only on the leg where
   * the native filter was rejected and the window had to be applied here.
   *
   * It exists for one caller: the fallback-field legs, which have to decide which rows are theirs
   * (the ones no earlier field can date) BEFORE the window drops anything, or their missing-date
   * count is taken over the whole scoped set and reports rows the primary field dates perfectly
   * well as undatable. Never the set an answer is computed from — `read.rows` is.
   */
  rowsBeforeLocalWindow?: T[];
  /**
   * The declared fallback fields this read ALSO asked the upstream for, on the leg where the
   * native filter WORKED. Empty when no fallback field was declared, or when the native filter was
   * rejected and the whole window ran locally instead.
   */
  fallbackFieldsQueried: string[];
  /** Rows those extra legs recovered — rows the primary-field filter could never have returned. */
  fallbackFieldRowsAdded: number;
  /**
   * What the private-candidate gate withheld from the FALLBACK-FIELD legs, kept as its own number.
   *
   * Deliberately NOT added to the primary read's figure. The fallback leg's server-side filter
   * returns a population that OVERLAPS the primary leg's (a row can carry both dates), so the two
   * withheld counts are not disjoint and adding them would report a number no read produced. It is
   * reported beside the primary figure instead.
   */
  fallbackFieldPrivacyWithheld: number;
}

export const LOCAL_WINDOW_NOTE =
  "Upstream rejected the date filter (422 — this endpoint does not support it live); the window was applied locally to the complete scoped set. Rows lacking the field were excluded.";

/**
 * The v3 bracket params for a set of window specs, so every caller that wants a server-side date
 * filter builds the SAME shape (`resolved_at[gte]=…`) and the fallback leg can strip exactly what
 * it added.
 */
const DATE_ONLY_BOUND = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The value a bound takes ON THE WIRE. Harvest v3 validates bracket range params as RFC 3339
 * date-times and 422s a bare calendar date (`created_at[gte]=2026-09-01` → "value does not match
 * format: date-time", live 2026-09-03 on /v3/applications). Callers and the model think in
 * calendar dates, so a date-only bound is widened to the instant it means: the start of that day
 * for `gte`/`gt`/`lt`, the end of that day for the inclusive `lte`. A value that already carries a
 * time passes through untouched. The DateWindowSpec keeps the caller's original text — the local
 * window (applyLocalWindow) has its own calendar-date semantics and must not be fed wire strings.
 */
export function toWireDateTime(bound: string, operator: "gte" | "lte" | "gt" | "lt"): string {
  if (!DATE_ONLY_BOUND.test(bound)) return bound;
  return operator === "lte" ? `${bound}T23:59:59Z` : `${bound}T00:00:00Z`;
}

export function bracketParamsForWindows(specs: readonly DateWindowSpec[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const spec of specs) {
    for (const operator of ["gte", "lte", "gt", "lt"] as const) {
      const bound = spec[operator];
      if (typeof bound === "string" && bound.length > 0) params[`${spec.field}[${operator}]`] = toWireDateTime(bound, operator);
    }
  }
  return params;
}

/**
 * Read the complete scoped set for a windowed query, self-healing spec-vs-API divergence where some
 * Harvest v3 endpoints 422 date filters that the OpenAPI spec advertises. `/v3/offers` rejects every
 * one of them (`resolved_at`, `created_at`, `updated_at`); `/v3/applications` accepts them.
 *
 * Native filtering stays the FIRST attempt — it is cheap wherever the endpoint really supports it,
 * and this must never become "always read everything". A 422 with THIS CALL'S OWN range params in
 * play re-reads without them and applies the window locally to the complete scoped set, and the
 * caller is handed everything it needs to say so out loud.
 *
 * Two things the fallback deliberately does NOT do, because both turn a self-heal into silent data
 * loss (Codex review of 61e48ad):
 *
 *  - It does not treat every 422 as a date 422. Only the bracket keys these `windowSpecs` produced
 *    are stripped, and when the request carries none of them the error is rethrown: a 422 about a
 *    malformed `job_ids` would otherwise be "healed" into a full unfiltered read of the tenant.
 *  - It does not strip range params it did not add. A caller filtering `salary[gte]` alongside a
 *    date window keeps that filter on the re-read.
 *
 * Lifted out of `runEvidenceListRead`, where it was the only copy and unreachable from the recipes
 * and the planner (`read-all.ts` rethrows a non-timeout error), so the hire path and the planner's
 * offer read get the same two legs rather than a hard failure on the endpoint that needs it most.
 */
export async function readAllWithDateFallback<T extends Record<string, unknown>>(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  scopedToolName: string,
  params: Record<string, unknown>,
  windowSpecs: readonly DateWindowSpec[],
  deadline?: ToolDeadline,
  options: ReadAllOptions = {}
): Promise<DateFallbackOutcome<T>> {
  const windowFields = [...new Set(windowSpecs.flatMap((spec) => [spec.field, ...(spec.fallbackFields ?? [])]))];
  try {
    const read = await readAllScopedRows<T>(runtime, exposedToolName, scopedToolName, params, deadline, options);
    if (read.kind === "denial") {
      return {
        read,
        windowAppliedLocally: false,
        dateParamsRejected: [],
        windowFields,
        rowsMissingField: 0,
        fallbackFieldsQueried: [],
        fallbackFieldRowsAdded: 0,
        fallbackFieldPrivacyWithheld: 0,
      };
    }
    // The native filter held. A row whose PRIMARY field Greenhouse never wrote can never come back
    // from a primary-field range filter, so on this leg the declared fallback fields have to be
    // asked for separately or the two legs of this helper would answer with different populations —
    // the fallback leg counting a `sent_on`-dated hire and the native leg silently missing it.
    const supplement = await readFallbackFieldLegs<T>(
      runtime, exposedToolName, scopedToolName, params, windowSpecs, deadline, options
    );
    // A cancellation on a supplemental leg is not a supplement that failed — it is the client
    // request ending. It is handed back as the denial it is, never degraded to a warning.
    if (supplement.cancelled) {
      return {
        read: { kind: "denial", result: supplement.cancelled },
        windowAppliedLocally: false,
        dateParamsRejected: [],
        windowFields,
        rowsMissingField: 0,
        fallbackFieldsQueried: [],
        fallbackFieldRowsAdded: 0,
        fallbackFieldPrivacyWithheld: 0,
      };
    }
    return {
      // Merged whenever a leg RAN, not only when it produced rows or warnings: a leg that
      // legitimately matched nothing still fetched a page and scanned rows upstream, and dropping
      // it from the accounting understated the read's cost and hid the leg entirely.
      read: supplement.legsRun > 0
        ? {
            ...read,
            rows: [...read.rows, ...supplement.rows],
            rawRowsRead: read.rawRowsRead + supplement.rawRowsRead,
            pagesRead: read.pagesRead + supplement.pagesRead,
            warnings: [...read.warnings, ...supplement.warnings],
            status: combineReadStatuses([read.status, ...supplement.statuses]),
            complete: combineReadStatuses([read.status, ...supplement.statuses]) === "complete" && read.complete,
          }
        : read,
      windowAppliedLocally: false,
      dateParamsRejected: [],
      windowFields,
      // The supplemental legs' own missing-date count, folded up rather than dropped: a leg that
      // re-read unwindowed and found a row carrying NEITHER clock is the only place that number
      // exists, and hardcoding zero here reported a read that had lost rows as one that had not.
      rowsMissingField: supplement.rowsMissingField,
      fallbackFieldsQueried: supplement.fieldsQueried,
      fallbackFieldRowsAdded: supplement.rows.length,
      fallbackFieldPrivacyWithheld: supplement.privacyWithheld,
    };
  } catch (error) {
    if (windowSpecs.length === 0 || httpErrorStatus(error) !== 422) throw error;
    // Exactly the bracket keys these specs asked for — never every `*[gte]` in the request.
    const ownBracketKeys = new Set(Object.keys(bracketParamsForWindows(windowSpecs)));
    const rejected = Object.keys(params).filter((key) => ownBracketKeys.has(key));
    // A 422 on a request that carries none of this window's bracket params is about something
    // else. Re-reading without them would drop nothing and hide a real error.
    if (rejected.length === 0) throw error;
    const stripped = Object.fromEntries(Object.entries(params).filter(([key]) => !ownBracketKeys.has(key)));
    const read = await readAllScopedRows<T>(runtime, exposedToolName, scopedToolName, stripped, deadline, options);
    if (read.kind === "denial") {
      return {
        read,
        windowAppliedLocally: false,
        dateParamsRejected: rejected.sort(),
        windowFields,
        rowsMissingField: 0,
        fallbackFieldsQueried: [],
        fallbackFieldRowsAdded: 0,
        fallbackFieldPrivacyWithheld: 0,
      };
    }
    const windowed = applyLocalWindow(read.rows, windowSpecs);
    return {
      read: { ...read, rows: windowed.rows },
      rowsBeforeLocalWindow: read.rows,
      windowAppliedLocally: true,
      dateParamsRejected: rejected.sort(),
      windowFields,
      rowsMissingField: windowed.missing,
      fallbackFieldsQueried: [],
      fallbackFieldRowsAdded: 0,
      fallbackFieldPrivacyWithheld: 0,
    };
  }
}

interface FallbackLegResult<T extends Record<string, unknown>> {
  rows: T[];
  fieldsQueried: string[];
  rawRowsRead: number;
  pagesRead: number;
  privacyWithheld: number;
  /** Rows THIS leg was responsible for that carried no parseable value in its own field. */
  rowsMissingField: number;
  statuses: ReadAllStatus[];
  warnings: string[];
  /** Legs ATTEMPTED, including ones that returned nothing or failed. Drives the read merge. */
  legsRun: number;
  /** Set when a leg was cancelled: the whole read stops and hands this denial back. */
  cancelled?: RecruiterToolResult;
}

/**
 * One extra read per declared fallback field, for the leg where the native date filter WORKED.
 *
 * Each leg swaps that spec's own bracket params for the fallback field's, leaves every other
 * filter in place, and keeps only the rows the primary filter structurally could not have
 * returned — the ones carrying no value in the primary field (or in any earlier fallback), so the
 * legs never overlap and no row is counted twice.
 *
 * This is a read the previous version did not make, and it is an EXPANSION, not a narrowing: on
 * `/v3/offers` the native leg 422s live, so it costs nothing there; where an endpoint really does
 * honour the filter it buys back the rows a primary-field-only window would have dropped without
 * saying so.
 *
 * Each leg runs through `readAllWithDateFallback` itself — its own field as its own primary spec,
 * no fallbacks of its own, so the recursion is exactly one level deep. That is what gives the leg
 * the SAME 422 self-heal the primary leg has: before this, a 422 on the sent_on leg (the endpoint
 * where the 422 is the documented live behaviour) became a warning on a `complete: true` answer
 * that was quietly missing every sent_on-dated hire. A leg that fails for any OTHER reason still
 * degrades — the primary rows are real either way — but it marks the combined read
 * `incomplete_upstream` and names the field, so a short set can never read as a whole one.
 */
async function readFallbackFieldLegs<T extends Record<string, unknown>>(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  scopedToolName: string,
  params: Record<string, unknown>,
  windowSpecs: readonly DateWindowSpec[],
  deadline: ToolDeadline | undefined,
  options: ReadAllOptions
): Promise<FallbackLegResult<T>> {
  const result: FallbackLegResult<T> = {
    rows: [],
    fieldsQueried: [],
    rawRowsRead: 0,
    pagesRead: 0,
    privacyWithheld: 0,
    rowsMissingField: 0,
    statuses: [],
    warnings: [],
    legsRun: 0,
  };
  for (const spec of windowSpecs) {
    const fallbacks = spec.fallbackFields ?? [];
    for (let index = 0; index < fallbacks.length; index += 1) {
      const field = fallbacks[index] as string;
      const legSpec: DateWindowSpec = { field, gte: spec.gte, lte: spec.lte, gt: spec.gt, lt: spec.lt };
      const ownKeys = new Set(Object.keys(bracketParamsForWindows([spec])));
      const legParams = {
        ...Object.fromEntries(Object.entries(params).filter(([key]) => !ownKeys.has(key))),
        ...bracketParamsForWindows([legSpec]),
      };
      result.legsRun += 1;
      let outcome: DateFallbackOutcome<T>;
      try {
        // One level of recursion: legSpec declares no fallbackFields of its own, so this call
        // makes no further legs. It buys the leg the primary leg's 422 self-heal.
        outcome = await readAllWithDateFallback<T>(
          runtime, exposedToolName, scopedToolName, legParams, [legSpec], deadline, options
        );
      } catch (error) {
        if (isToolCancelledError(error)) throw error;
        result.warnings.push(
          `the ${field} leg of the ${spec.field} window failed (${error instanceof Error ? error.message : String(error)}), so rows carrying only ${field} are missing from this set`
        );
        result.statuses.push("incomplete_upstream");
        continue;
      }
      const read = outcome.read;
      if (read.kind === "denial") {
        if (isCancellationDenial(read.result)) {
          result.cancelled = read.result;
          return result;
        }
        result.warnings.push(
          `the ${field} leg of the ${spec.field} window was denied${read.result.ok === false ? ` (${read.result.denial.code})` : ""}, so rows carrying only ${field} are missing from this set`
        );
        result.statuses.push("incomplete_upstream");
        continue;
      }
      result.fieldsQueried.push(field);
      result.rawRowsRead += read.rawRowsRead;
      result.pagesRead += read.pagesRead;
      result.privacyWithheld += read.privacyWithheld;
      result.statuses.push(read.status);
      result.warnings.push(...read.warnings);
      if (outcome.windowAppliedLocally) {
        result.warnings.push(
          `the upstream rejected the ${field} filter (${outcome.dateParamsRejected.join(", ")}), so that leg's window was applied locally to the complete scoped set`
        );
      }
      // Only the rows this leg alone can supply: everything earlier in the fallback order carries
      // no USABLE date. "Usable" is `Date.parse` succeeding, the same test facts.ts applies before
      // it will date a hire on a field — an unparseable `resolved_at` is not a date, so the row is
      // this leg's to recover rather than one the primary leg silently dropped.
      //
      // Selected from the rows BEFORE the leg's own local window ran: the window drops every row
      // without the leg's field, including rows the primary field dates fine, so counting missing
      // dates after it would report most of the scoped set as undatable.
      const earlier = [spec.field, ...fallbacks.slice(0, index)];
      const source = outcome.rowsBeforeLocalWindow ?? read.rows;
      const recovered = source.filter((row) => earlier.every((name) => parseableDate(row[name]) === null));
      const windowed = applyLocalWindow(recovered, [legSpec]);
      result.rows.push(...windowed.rows);
      result.rowsMissingField += windowed.missing;
    }
  }
  return result;
}

/**
 * A date field's value, or null when the field carries nothing this code will treat AS a date.
 *
 * Non-empty is not enough. `{ resolved_at: "garbage", sent_on: "2026-05-05" }` used to read as
 * "the primary field is present", which both suppressed the declared sent_on fallback and lost the
 * row to a string comparison against the window's upper bound — dropped, uncounted, on a read that
 * still reported complete. Parseability is the same test facts.ts already applies (timestampField)
 * before it will date a hire on a field, so the read layer and the fact layer now agree.
 */
function parseableDate(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

/** The `read.window_applied_locally` envelope, or undefined when the native filter held. */
export function localWindowDisclosure<T extends Record<string, unknown>>(
  outcome: DateFallbackOutcome<T>
): { fields: string[]; rows_missing_field: number; note: string } | undefined {
  if (!outcome.windowAppliedLocally) return undefined;
  return { fields: outcome.windowFields, rows_missing_field: outcome.rowsMissingField, note: LOCAL_WINDOW_NOTE };
}

// Date-only bounds (YYYY-MM-DD) are END-of-day inclusive for INCLUSIVE upper bounds under local
// windowing — a timestamp ON the lte date must stay in-window, matching the upstream filters'
// semantics. It applies to `lte` and to nothing else: expanding an EXCLUSIVE lower bound to the end
// of its day excluded `2026-05-01T12:00:00Z` under `gt: "2026-05-01"`, which is a full day of rows
// the caller asked for, dropped by a bound that was supposed to admit them.
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function boundInstant(bound: string, field: string, operator: string): number {
  const at = Date.parse(bound);
  if (!Number.isFinite(at)) {
    // Loud rather than silent. A bound nobody can parse would otherwise compare false against
    // everything and quietly widen the window to all time.
    throw new Error(`Local date window received an unparseable ${field}[${operator}] bound: ${bound}`);
  }
  return at;
}

function inclusiveUpperInstant(bound: string, field: string): number {
  return boundInstant(DATE_ONLY_PATTERN.test(bound) ? `${bound}T23:59:59.999Z` : bound, field, "lte");
}

export function applyLocalWindow<T extends Record<string, unknown>>(
  rows: T[],
  specs: readonly DateWindowSpec[]
): { rows: T[]; missing: number } {
  // Bounds are compared as INSTANTS, not as strings: "2026-05-01" and "2026-05-01T00:00:00.000Z"
  // are the same moment and sorted differently as text, and a string comparison is what let a
  // malformed value ("garbage") lose an inequality and disappear.
  const bounds = specs.map((spec) => ({
    spec,
    gte: spec.gte === undefined ? null : boundInstant(spec.gte, spec.field, "gte"),
    gt: spec.gt === undefined ? null : boundInstant(spec.gt, spec.field, "gt"),
    lte: spec.lte === undefined ? null : inclusiveUpperInstant(spec.lte, spec.field),
    lt: spec.lt === undefined ? null : boundInstant(spec.lt, spec.field, "lt"),
  }));
  let missing = 0;
  const kept = rows.filter((row) => {
    for (const bound of bounds) {
      const value = firstPresentField(row, bound.spec);
      if (value === null) {
        missing += 1;
        return false;
      }
      const at = Date.parse(value);
      if (bound.gte !== null && at < bound.gte) return false;
      if (bound.gt !== null && at <= bound.gt) return false;
      if (bound.lte !== null && at > bound.lte) return false;
      if (bound.lt !== null && at >= bound.lt) return false;
    }
    return true;
  });
  return { rows: kept, missing };
}

function firstPresentField(row: Record<string, unknown>, spec: DateWindowSpec): string | null {
  for (const field of [spec.field, ...(spec.fallbackFields ?? [])]) {
    const value = parseableDate(row[field]);
    if (value !== null) return value;
  }
  return null;
}
