import {
  APPLICATION_ANALYSIS_READ_PARAM_NAMES,
  HIRE_FACTS_ID_BRIDGE_READ_PARAM_NAMES,
  HIRE_FACTS_OFFER_READ_PARAM_NAMES,
  HIRE_FACTS_OPENING_READ_PARAM_NAMES,
  sanitizeReadParams,
} from "../limits.js";
import {
  combineReadStatuses,
  denialTruncationStatus,
  isCancellationDenial,
  type ReadAllRowsResult,
  type ReadAllStatus,
} from "../read-all.js";
import { deny, isToolCancelledError, type RecruiterToolRuntime, type ToolDeadline } from "../runtime.js";
import type { RecruiterToolResult } from "../types.js";
import { buildHireFacts, HIRE_ACCEPTED_OFFER_STATUS } from "../facts.js";
import { chunks } from "./application-job-lookup.js";
import {
  bracketParamsForWindows,
  readAllWithDateFallback,
  type DateWindowSpec,
} from "./read-with-date-fallback.js";

/**
 * The hire read. One definition of a hire, read once, for every People Ops recipe above it.
 *
 * Three facts about the live API decide the shape:
 *
 *  1. The LIVE `/v3/offers` endpoint 422s every date filter the vendored contract advertises, so
 *     the `resolved_at` range goes through `readAllWithDateFallback` — native filter first, local
 *     window and a disclosure second. Never a denial.
 *  2. The default org-wide scope carries NO `job_ids` (analysis-context.ts), so a permission-wide
 *     hire read is ONE permission-bounded read. Chunking is for a FROZEN explicit job set only;
 *     chunking a permission-wide read would turn one call into one per permitted req for nothing.
 *  3. On the privacy-only branches every offer batch also walks `application_id` and
 *     `candidate_id` upstream, so each optional bridge here is a real cost and is opt-in.
 */

/** 50 is Greenhouse's practical id-filter batch size, and the one the sibling bridges already use. */
export const HIRE_JOB_ID_CHUNK_SIZE = 50;
export const HIRE_ID_BRIDGE_CHUNK_SIZE = 50;

export interface HireScope {
  /**
   * The FROZEN explicit job set to constrain the read to. Undefined means permission-wide: the
   * scoped reader's own permission floor is the scope, and no `job_ids` are invented for it.
   */
  jobIds?: number[];
  /** What to call this scope in the answer. Mandatory — a count with no stated scope is a rumour. */
  label: string;
}

export interface HireWindow {
  start: string;
  end: string;
  /** What to call this window in the answer ("Q2 2026", "last quarter", "2026-04-01 to 2026-06-30"). */
  label: string;
}

export interface HireSetOptions {
  /**
   * Also read every VERSION of the accepted set's offers (`current_only=false`, keyed by their
   * application_ids), which is the only honest source for offer-rows-per-hire (the re-extension
   * denominator). Off by default: it is a second full read.
   */
  includeChain?: boolean;
  /**
   * Also bridge the hires' `candidate_ids` to candidate rows for names. The private-candidate gate
   * runs upstream, so what comes back is what this actor may see and the withheld count is reported
   * beside it rather than silently absorbed.
   */
  includeCandidates?: boolean;
}

export interface HireReadStatus {
  status: ReadAllStatus;
  complete: boolean;
  pagesRead: number;
  rawRowsRead: number;
  /**
   * Rows Greenhouse's private-candidate permission withheld from THIS read. Never summed with
   * another read's figure: each read has its own population and its own privacy regime.
   */
  privacyWithheld: number;
  windowAppliedLocally: boolean;
  dateParamsRejected: string[];
  /**
   * Rows the LOCAL window dropped because they carried neither `resolved_at` nor the declared
   * `sent_on` fallback. Surfaced rather than swallowed: it is the only number that says how much of
   * the scoped set the fallback leg could not place on any clock at all.
   */
  rowsMissingField: number;
  warnings: string[];
}

export interface HireCandidateRow {
  id: number;
  first_name?: string;
  last_name?: string;
  preferred_name?: string;
}

export type HireSetResult =
  | {
      kind: "rows";
      hires: Array<Record<string, unknown>>;
      chain?: Array<Record<string, unknown>>;
      candidates?: HireCandidateRow[];
      read: HireReadStatus;
      chainRead?: HireReadStatus;
      candidatesRead?: HireReadStatus;
      scope: HireScope;
      window: HireWindow;
    }
  | { kind: "denial"; result: RecruiterToolResult };

type RowsResult = Extract<ReadAllRowsResult<Record<string, unknown>>, { kind: "rows" }>;

export function hireWindowSpec(window: HireWindow): DateWindowSpec {
  return {
    field: "resolved_at",
    // A hire whose resolved_at Greenhouse never wrote is still a hire; on the local-window leg it
    // is placed by sent_on rather than dropped. buildHireFacts labels the substitution on the row.
    fallbackFields: ["sent_on"],
    gte: window.start,
    lte: window.end,
  };
}

export async function readHireSet(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  scope: HireScope,
  window: HireWindow,
  deadline?: ToolDeadline,
  options: HireSetOptions = {}
): Promise<HireSetResult> {
  const spec = hireWindowSpec(window);
  // `undefined` and `[]` are DIFFERENT scopes and always were: undefined means "whatever my
  // Greenhouse permissions reach" (one unfiltered read), `[]` means "these zero reqs" — an
  // explicit empty set a caller froze. Treating the empty set as permission-wide silently WIDENED
  // it to the whole tenant, which is the one direction a scope must never move on its own.
  const jobChunks: Array<number[] | null> = scope.jobIds === undefined
    ? [null]
    : chunks([...new Set(scope.jobIds)], HIRE_JOB_ID_CHUNK_SIZE);

  const hires: Array<Record<string, unknown>> = [];
  const statuses: ReadAllStatus[] = [];
  const warnings: string[] = [];
  let pagesRead = 0;
  let rawRowsRead = 0;
  let privacyWithheld = 0;
  let rowsMissingField = 0;
  let windowAppliedLocally = false;
  let completedChunks = 0;
  const dateParamsRejected = new Set<string>();

  for (const jobChunk of jobChunks) {
    const params = sanitizeReadParams(
      {
        status: HIRE_ACCEPTED_OFFER_STATUS,
        current_only: true,
        ...(jobChunk ? { job_ids: jobChunk.join(",") } : {}),
        ...bracketParamsForWindows([spec]),
      },
      runtime.limits,
      { allowedParamNames: HIRE_FACTS_OFFER_READ_PARAM_NAMES }
    );
    const outcome = await readAllWithDateFallback<Record<string, unknown>>(
      runtime,
      exposedToolName,
      "list_offers",
      params,
      [spec],
      deadline
    );
    if (outcome.read.kind === "denial") {
      const truncation = denialTruncationStatus(outcome.read.result);
      // A budget/deadline denial on a LATER chunk is truncation, not failure: the chunks already
      // read are real and the answer says the set is short. A permission/upstream denial is a real
      // error at any point, and so is any denial before ANY chunk completed.
      //
      // COMPLETED CHUNKS, not returned rows: a scope whose first two reqs genuinely hired nobody
      // returns zero rows, and reading that as "nothing was read" turned a third-chunk timeout
      // into a hard denial over two reads that had succeeded.
      if (truncation === null || completedChunks === 0) return { kind: "denial", result: outcome.read.result };
      statuses.push(truncation);
      warnings.push("the hire read stopped before every explicit req chunk was read");
      break;
    }
    completedChunks += 1;
    foldRead(outcome.read, hires, statuses, warnings);
    pagesRead += outcome.read.pagesRead;
    rawRowsRead += outcome.read.rawRowsRead;
    privacyWithheld += outcome.read.privacyWithheld;
    rowsMissingField += outcome.rowsMissingField;
    // Its own number, never added to the primary leg's: the two legs' populations overlap.
    if (outcome.fallbackFieldPrivacyWithheld > 0) {
      warnings.push(
        `a further ${outcome.fallbackFieldPrivacyWithheld} row(s) were withheld as private candidates on the ${outcome.fallbackFieldsQueried.join(", ")} leg of this window; that figure is reported separately because it overlaps the resolved_at leg's and the two must not be added`
      );
    }
    if (outcome.windowAppliedLocally) windowAppliedLocally = true;
    for (const rejected of outcome.dateParamsRejected) dateParamsRejected.add(rejected);
  }

  const read: HireReadStatus = {
    status: combineReadStatuses(statuses),
    complete: combineReadStatuses(statuses) === "complete",
    pagesRead,
    rawRowsRead,
    privacyWithheld,
    rowsMissingField,
    windowAppliedLocally,
    dateParamsRejected: [...dateParamsRejected].sort(),
    warnings,
  };

  // Keyed off the HIRES, not off every row the read handed back. buildHireFacts is the one
  // definition of a hire, and the bridges have to use it too: a stray row the builder refuses put
  // its offer versions into the numerator of offer-rows-per-hire while its own row stayed out of
  // the denominator, and it spent a candidate-bridge slot on somebody who was never hired.
  const hireRows = buildHireFacts(hires).facts as unknown as Array<Record<string, unknown>>;
  const applicationIds = uniquePositiveIds(hireRows, "application_id");
  const candidateIds = uniquePositiveIds(hireRows, "candidate_id");

  // The hire read has already happened and its rows are real. Both bridges below are OPTIONAL
  // enrichments — a version chain and a set of names — so a failure on either reduces what the
  // answer can say and is disclosed, but it never destroys the count that was already computed.
  // Returning the bridge's denial here converted a complete hire read into "we cannot tell you
  // anything", which is the worse answer by every measure.
  //
  // Both shapes of failure are contained, because a read can fail in two: readAllScopedRows
  // RETHROWS a 5xx and RETURNS a denial for a permission/deadline refusal. Containing only the
  // second let an ordinary upstream 500 escape as an exception — the same destruction, by the
  // other route. The one thing that still stops everything is a cancellation: the client is gone,
  // and nothing downstream should keep running or answer as if it had not.
  let chain: Array<Record<string, unknown>> | undefined;
  let chainRead: HireReadStatus | undefined;
  if (options.includeChain) {
    const chainResult = await contain("the offer version chain", () =>
      readOfferChain(runtime, exposedToolName, applicationIds, deadline)
    );
    if (chainResult.kind === "cancelled") return { kind: "denial", result: chainResult.result };
    if (chainResult.kind === "failed") {
      read.warnings.push(chainResult.warning);
      // A read the caller ASKED FOR and did not get is not the same as one nobody asked for. Both
      // leave `chain` unset; only this one means a population is missing from the answer, and the
      // status is where a caller aggregating these reads can see it. Leaving it undefined reported
      // "complete" on a line whose second population had failed.
      chainRead = failedReadStatus(chainResult.warning);
    } else {
      chain = chainResult.value.rows;
      chainRead = chainResult.value.read;
    }
  }

  let candidates: HireCandidateRow[] | undefined;
  let candidatesRead: HireReadStatus | undefined;
  if (options.includeCandidates) {
    const bridgedResult = await contain("the candidate name bridge", () =>
      readHireCandidates(runtime, exposedToolName, candidateIds, deadline)
    );
    if (bridgedResult.kind === "cancelled") return { kind: "denial", result: bridgedResult.result };
    if (bridgedResult.kind === "failed") {
      read.warnings.push(bridgedResult.warning);
      return {
        kind: "rows",
        hires,
        ...(chain ? { chain } : {}),
        read,
        ...(chainRead ? { chainRead } : {}),
        // Requested and not delivered: the status says so, exactly as the chain's does above.
        candidatesRead: failedReadStatus(bridgedResult.warning),
        scope,
        window,
      };
    }
    const bridged = bridgedResult.value;
    candidates = bridged.candidates;
    candidatesRead = bridged.read;
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    for (let index = 0; index < hires.length; index += 1) {
      const candidateId = hires[index]!.candidate_id;
      const candidate = typeof candidateId === "number" ? byId.get(candidateId) : undefined;
      // A hire whose candidate the privacy gate withheld carries NO candidate key at all, rather
      // than a placeholder that would read as a name Greenhouse does not have.
      if (candidate) hires[index] = { ...hires[index]!, candidate };
    }
  }

  return {
    kind: "rows",
    hires,
    ...(chain ? { chain } : {}),
    ...(candidates ? { candidates } : {}),
    read,
    ...(chainRead ? { chainRead } : {}),
    ...(candidatesRead ? { candidatesRead } : {}),
    scope,
    window,
  };
}

/**
 * Every VERSION of the accepted set's offers. `current_only=false` and NO status filter: a
 * superseded version carries status `Deprecated`, so filtering on `Accepted` would return exactly
 * the rows the caller already has and report a re-extension count of 1.0 for every hire.
 */
async function readOfferChain(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  applicationIds: number[],
  deadline: ToolDeadline | undefined
): Promise<{ kind: "rows"; rows: Array<Record<string, unknown>>; read: HireReadStatus } | { kind: "denial"; result: RecruiterToolResult }> {
  return readIdChunks(
    runtime,
    exposedToolName,
    "list_offers",
    applicationIds,
    (batch) => sanitizeReadParams(
      { application_ids: batch.join(","), current_only: false },
      runtime.limits,
      { allowedParamNames: HIRE_FACTS_OFFER_READ_PARAM_NAMES }
    ),
    deadline
  );
}

async function readHireCandidates(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  candidateIds: number[],
  deadline: ToolDeadline | undefined
): Promise<{ kind: "rows"; candidates: HireCandidateRow[]; read: HireReadStatus } | { kind: "denial"; result: RecruiterToolResult }> {
  const bridged = await readIdChunks(
    runtime,
    exposedToolName,
    "list_candidates",
    candidateIds,
    (batch) => sanitizeReadParams(
      { ids: batch.join(",") },
      runtime.limits,
      { allowedParamNames: HIRE_FACTS_ID_BRIDGE_READ_PARAM_NAMES }
    ),
    deadline
  );
  if (bridged.kind === "denial") return bridged;
  const candidates: HireCandidateRow[] = [];
  for (const row of bridged.rows) {
    const id = row.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) continue;
    candidates.push({
      id,
      ...(typeof row.first_name === "string" && row.first_name.length > 0 ? { first_name: row.first_name } : {}),
      ...(typeof row.last_name === "string" && row.last_name.length > 0 ? { last_name: row.last_name } : {}),
      ...(typeof row.preferred_name === "string" && row.preferred_name.length > 0 ? { preferred_name: row.preferred_name } : {}),
    });
  }
  return { kind: "rows", candidates, read: bridged.read };
}

/**
 * Read an endpoint in id-bounded chunks and fold the results into ONE honest read status. Shared by
 * the chain read, the candidate bridge and the applications bridge so all three account for
 * truncation and privacy the same way.
 */
export async function readIdChunks(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  scopedToolName: string,
  ids: number[],
  paramsFor: (batch: number[]) => Record<string, unknown>,
  deadline: ToolDeadline | undefined
): Promise<{ kind: "rows"; rows: Array<Record<string, unknown>>; read: HireReadStatus } | { kind: "denial"; result: RecruiterToolResult }> {
  const rows: Array<Record<string, unknown>> = [];
  const statuses: ReadAllStatus[] = [];
  const warnings: string[] = [];
  let pagesRead = 0;
  let rawRowsRead = 0;
  let privacyWithheld = 0;

  if (ids.length === 0) {
    return {
      kind: "rows",
      rows,
      read: {
        status: "complete",
        complete: true,
        pagesRead: 0,
        rawRowsRead: 0,
        privacyWithheld: 0,
        rowsMissingField: 0,
        windowAppliedLocally: false,
        dateParamsRejected: [],
        warnings,
      },
    };
  }

  let completedBatches = 0;
  for (const batch of chunks(ids, HIRE_ID_BRIDGE_CHUNK_SIZE)) {
    const outcome = await readAllWithDateFallback<Record<string, unknown>>(
      runtime,
      exposedToolName,
      scopedToolName,
      paramsFor(batch),
      [],
      deadline
    );
    if (outcome.read.kind === "denial") {
      const truncation = denialTruncationStatus(outcome.read.result);
      // Completed BATCHES, not returned rows: a first batch of ids that legitimately matches
      // nothing is a successful read, and counting it as "nothing was read" turned a later
      // deadline expiry into a hard denial over work that had actually succeeded.
      if (truncation === null || completedBatches === 0) return { kind: "denial", result: outcome.read.result };
      statuses.push(truncation);
      warnings.push(`the ${scopedToolName} bridge stopped before every id batch was read`);
      break;
    }
    completedBatches += 1;
    foldRead(outcome.read, rows, statuses, warnings);
    pagesRead += outcome.read.pagesRead;
    rawRowsRead += outcome.read.rawRowsRead;
    privacyWithheld += outcome.read.privacyWithheld;
  }

  return {
    kind: "rows",
    rows,
    read: {
      status: combineReadStatuses(statuses),
      complete: combineReadStatuses(statuses) === "complete",
      pagesRead,
      rawRowsRead,
      privacyWithheld,
      rowsMissingField: 0,
      windowAppliedLocally: false,
      dateParamsRejected: [],
      warnings,
    },
  };
}

/** What an optional bridge's denial says on the answer that survived it. */
function denialWarning(what: string, result: RecruiterToolResult): string {
  const code = result.ok ? "UNKNOWN" : result.denial.code;
  return `${what} could not be read (${code}), so the counts that depend on it are not reported; the hire read itself stands.`;
}

/** What an optional bridge's THROWN failure says. Same sentence, the upstream message in place of a code. */
function errorWarning(what: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${what} could not be read (${message}), so the counts that depend on it are not reported; the hire read itself stands.`;
}

type ContainedRead<T> =
  | { kind: "value"; value: T }
  | { kind: "failed"; warning: string }
  | { kind: "cancelled"; result: RecruiterToolResult };

/**
 * Run ONE optional enrichment read and let neither shape of failure past.
 *
 * Both shapes exist and both used to escape somewhere: `readAllScopedRows` RETHROWS an ordinary
 * 5xx and RETURNS a denial for a refusal or a deadline. A cancellation, in either shape, is the
 * exception to containment and is handed back so the caller can stop.
 */
async function contain<T extends { kind: "rows" | "counts" } | { kind: "denial"; result: RecruiterToolResult }>(
  what: string,
  run: () => Promise<T>
): Promise<ContainedRead<Exclude<T, { kind: "denial" }>>> {
  let result: T;
  try {
    result = await run();
  } catch (error) {
    if (isToolCancelledError(error)) {
      return { kind: "cancelled", result: deny("hire_facts", "CANCELLED", "Scoped Greenhouse read was cancelled because the client request ended.") };
    }
    return { kind: "failed", warning: errorWarning(what, error) };
  }
  if (result.kind === "denial") {
    const denial = (result as { kind: "denial"; result: RecruiterToolResult }).result;
    if (isCancellationDenial(denial)) return { kind: "cancelled", result: denial };
    return { kind: "failed", warning: denialWarning(what, denial) };
  }
  return { kind: "value", value: result as Exclude<T, { kind: "denial" }> };
}

/**
 * The read status of an enrichment that WAS requested and did not come back.
 *
 * `incomplete_upstream` rather than a truncation status: nothing about this is recoverable by
 * asking again with a longer deadline, and combineReadStatuses ranks it first for that reason.
 */
function failedReadStatus(warning: string): HireReadStatus {
  return {
    status: "incomplete_upstream",
    complete: false,
    pagesRead: 0,
    rawRowsRead: 0,
    privacyWithheld: 0,
    rowsMissingField: 0,
    windowAppliedLocally: false,
    dateParamsRejected: [],
    warnings: [warning],
  };
}

function foldRead(
  read: RowsResult,
  rows: Array<Record<string, unknown>>,
  statuses: ReadAllStatus[],
  warnings: string[]
): void {
  rows.push(...read.rows);
  statuses.push(read.status);
  warnings.push(...read.warnings);
}

// ---------------------------------------------------------------------------
// The reconciliation line.
//
// In Greenhouse the accepted-offer count, the status=hired application count and
// the openings-closed-by-hire count are three DIFFERENT numbers, and each is
// right about a different thing. Printing one of them alone is how a hire report
// acquires a number nobody can reproduce. So the line prints them together, each
// with the clock it is dated on, the scope and window it ran over, and its OWN
// private-candidate withholding — never a total, because a total across three
// populations is a number no read produced.
// ---------------------------------------------------------------------------

export interface ReconciliationCount {
  /** null when the read this count needs was not made. */
  value: number | null;
  /** True when no read was made for this count. Distinct from a genuine zero. */
  not_read: boolean;
  /**
   * True when the read behind this count STOPPED EARLY (a deadline, a rate limit, a chunk that
   * never ran), so `value` is a floor rather than the number. Rendered as "at least N".
   *
   * Every count used to be reported as exact whatever its read had done, so a bridge that timed
   * out after one 50-id batch printed "50 of those applications are marked hired" beside a
   * complete offer count — the confident wrong number this line exists to prevent.
   */
  partial: boolean;
  /**
   * WHICH KIND of partial, because the two do not share a sentence.
   *
   * `floor` — the value can only GROW when the rest of the read arrives: a monotone count, or a
   * partial numerator over a denominator that is complete. Rendered "at least N".
   *
   * `uncertain` — the value can move in EITHER direction: a ratio whose denominator is short.
   * "at least 100 offer rows per hire" over one observed hire, when the 99 unread hires each have
   * one version and the true figure is 1.99, is a number no read produced and the arithmetic
   * refutes. Rendered as the value plus "the true value may be higher or lower".
   *
   * Absent when `partial` is false — a completed read carries no hedge of either kind.
   */
  partial_reading?: "floor" | "uncertain";
  /** The field this count is dated on. Three counts, three clocks. */
  clock: string;
  window_label: string;
  scope_label: string;
  /** Rows Greenhouse's private-candidate permission withheld from THIS read alone. */
  privacy_withheld: number;
  /**
   * Of `value`, how many rows this count could only date from a FALLBACK field (a hire whose
   * `resolved_at` Greenhouse never wrote, placed by `sent_on` instead). A labeled approximation,
   * carried on the count so the sentence can say it out loud rather than presenting an
   * approximated date as the real one.
   */
  dated_from_fallback: number;
  notes: string[];
}

export interface OpeningsClosedByHireCount extends ReconciliationCount {
  /** Closed openings carrying no close_reason_id at all — hire or cancel is unknowable. */
  closed_with_no_reason: number;
  /** Closed openings whose close_reason_id the close-reason dictionary did not resolve. */
  closed_reason_unresolved: number;
}

export interface HireReconciliationLine {
  accepted_current_offers: ReconciliationCount;
  offer_rows_per_hire: ReconciliationCount;
  accepted_offer_applications_marked_hired: ReconciliationCount;
  applications_status_hired_scope_all_time?: ReconciliationCount;
  openings_closed_by_hire: OpeningsClosedByHireCount;
  read: { status: ReadAllStatus; complete: boolean; warnings: string[] };
  scope: HireScope;
  window: HireWindow;
}

export interface ReconciliationOptions {
  /** Read every offer version for the accepted set, so offer-rows-per-hire has a real source. */
  includeChain?: boolean;
  /** Read the closed openings and the close-reason dictionary. A third population, a third read. */
  includeOpenings?: boolean;
  /**
   * Also count status=hired applications across the whole scope with NO window. Off by default and
   * labeled all-time when on: it answers a different question from the other counts and putting it
   * beside them unlabeled is how an all-time number gets read as a quarter's.
   */
  includeAllTimeHiredApplications?: boolean;
}

export type ReconciliationResult =
  | { kind: "line"; line: HireReconciliationLine }
  | { kind: "denial"; result: RecruiterToolResult };

const HIRE_CLOSE_REASON_PREFIX = "Hire -";

export async function reconciliationLine(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  scope: HireScope,
  window: HireWindow,
  deadline?: ToolDeadline,
  options: ReconciliationOptions = {}
): Promise<ReconciliationResult> {
  const hireSet = await readHireSet(runtime, exposedToolName, scope, window, deadline, {
    includeChain: options.includeChain === true,
  });
  if (hireSet.kind === "denial") return hireSet;

  const statuses: ReadAllStatus[] = [hireSet.read.status];
  const warnings = [...hireSet.read.warnings];
  const base = { window_label: window.label, scope_label: scope.label };

  // ONE definition of a hire for the whole line. Counting `hireSet.hires.length` counted RETURNED
  // ROWS, which is a different thing: a row the server-side `status=Accepted` filter let through
  // in some other casing, or a stray non-accepted row from the bracket-free fallback leg, was
  // counted as a hire, and a hire dated off `sent_on` was reported as dated on `resolved_at`.
  // buildHireFacts is where that definition lives, so the line goes through it too.
  const hireFacts = buildHireFacts(hireSet.hires);
  const datedFromSentOn = hireFacts.facts.filter((fact) => fact.dated_from === "sent_on").length;

  const accepted_current_offers: ReconciliationCount = {
    ...base,
    value: hireFacts.facts.length,
    not_read: false,
    // A count of rows: every chunk that has not arrived can only ADD hires, so a short read is a
    // floor and never an over-count.
    ...partialReading(!hireSet.read.complete, "floor"),
    clock: "offers.resolved_at",
    privacy_withheld: hireSet.read.privacyWithheld,
    dated_from_fallback: datedFromSentOn,
    notes: [
      ...shortReadNotes(hireSet.read.complete, "the hire read", hireSet.read.status, "floor"),
      ...(hireSet.read.windowAppliedLocally
        ? ["the upstream rejected the resolved_at filter, so the window was applied locally to the complete scoped set"]
        : []),
      ...(hireSet.read.rowsMissingField > 0
        ? [`${hireSet.read.rowsMissingField} offer row(s) carried neither resolved_at nor sent_on, so no clock could place them in the window`]
        : []),
      ...hireFacts.omissions,
    ],
  };

  const offer_rows_per_hire: ReconciliationCount = hireSet.chain
    ? {
        ...base,
        value: hireFacts.facts.length > 0
          ? Number((hireSet.chain.length / hireFacts.facts.length).toFixed(2))
          : null,
        not_read: false,
        // The DENOMINATOR decides the word. Hires complete + versions short is a genuine lower
        // bound: every version still to arrive belongs to a hire already counted. Hires short is
        // not a bound at all — the unread hires carry their own versions and can pull the ratio
        // down as easily as up.
        ...partialReading(
          !hireSet.read.complete || hireSet.chainRead?.complete === false,
          hireSet.read.complete ? "floor" : "uncertain"
        ),
        clock: "offers.resolved_at (accepted set), counted across every version",
        privacy_withheld: hireSet.chainRead?.privacyWithheld ?? 0,
        dated_from_fallback: 0,
        notes: [
          ...shortReadNotes(hireSet.read.complete, "the hire read", hireSet.read.status, hireSet.read.complete ? "floor" : "uncertain"),
          ...shortReadNotes(hireSet.chainRead?.complete !== false, "the offer version chain read", hireSet.chainRead?.status ?? "complete", hireSet.read.complete ? "floor" : "uncertain"),
          ...(hireFacts.facts.length > 0
            ? []
            : ["there are no hires in this window, so offer rows per hire has no denominator"]),
        ],
      }
    : {
        ...base,
        value: null,
        not_read: true,
        partial: false,
        clock: "offers.resolved_at (accepted set), counted across every version",
        privacy_withheld: 0,
        dated_from_fallback: 0,
        // A chain that was ASKED for and failed says which failure; one nobody asked for says so.
        notes: hireSet.chainRead ? hireSet.chainRead.warnings : ["superseded versions were not read"],
      };
  if (hireSet.chainRead) statuses.push(hireSet.chainRead.status);

  // Count B: the SAME hires, asked of the application row. Greenhouse only sets status=hired once
  // somebody calls the hire endpoint, so this legitimately trails the accepted-offer count.
  // Keyed off the FACTS, not the returned rows: a row buildHireFacts refused as not-a-hire has no
  // business contributing an application id to the count of "how many of THESE hires does
  // Greenhouse call hired".
  const applicationIds = uniquePositiveIds(hireFacts.facts as unknown as Array<Record<string, unknown>>, "application_id");
  const bridgedResult = await contain("the accepted set's applications", () => readIdChunks(
    runtime,
    exposedToolName,
    "list_applications",
    applicationIds,
    (batch) => sanitizeReadParams(
      { ids: batch.join(",") },
      runtime.limits,
      { allowedParamNames: HIRE_FACTS_ID_BRIDGE_READ_PARAM_NAMES }
    ),
    deadline
  ));
  if (bridgedResult.kind === "cancelled") return { kind: "denial", result: bridgedResult.result };
  const bridged = bridgedResult.kind === "failed"
    ? ({ kind: "failed", warning: bridgedResult.warning } as const)
    : ({ kind: "rows", rows: bridgedResult.value.rows, read: bridgedResult.value.read } as const);
  // A bridge failure costs this ONE count, not the line. The accepted-offer count above is already
  // computed off a completed read; discarding it because a second population could not be read
  // would answer "we cannot tell you anything" to a question one read had already answered.
  const accepted_offer_applications_marked_hired: ReconciliationCount = bridged.kind === "failed"
    ? {
        ...base,
        value: null,
        not_read: true,
        partial: false,
        clock: "applications.status (point-in-time, not dated)",
        privacy_withheld: 0,
        dated_from_fallback: 0,
        notes: [bridged.warning],
      }
    : {
        ...base,
        value: bridged.rows.filter((row) => normalizedText(row.status) === "hired").length,
        not_read: false,
        // The hire read bounds this count too: a bridge keyed off a short accepted set is short.
        // Monotone either way — more ids or more batches can only add hired applications.
        ...partialReading(!bridged.read.complete || !hireSet.read.complete, "floor"),
        // Deliberately NOT dated: /v3/applications carries no hire timestamp, so this count is a
        // snapshot of the accepted set's applications as they stand right now.
        clock: "applications.status (point-in-time, not dated)",
        privacy_withheld: bridged.read.privacyWithheld,
        dated_from_fallback: 0,
        notes: [
          "Greenhouse sets status=hired only once the hire endpoint has fired, so this count trails the accepted-offer count rather than contradicting it",
          ...shortReadNotes(bridged.read.complete, "the applications bridge", bridged.read.status, "floor"),
          ...shortReadNotes(hireSet.read.complete, "the hire read", hireSet.read.status, "floor"),
        ],
      };
  if (bridged.kind === "failed") {
    warnings.push(bridged.warning);
    // A population the caller's question needs and this run never read. The aggregate has to say
    // so, or the line reports "complete" over an answer that is missing half its reconciliation.
    statuses.push("incomplete_upstream");
  } else {
    statuses.push(bridged.read.status);
    warnings.push(...bridged.read.warnings);
  }

  let applications_status_hired_scope_all_time: ReconciliationCount | undefined;
  if (options.includeAllTimeHiredApplications) {
    const allTimeResult = await contain("the all-time hired-application count", () =>
      readAllTimeHiredApplications(runtime, exposedToolName, scope, deadline)
    );
    if (allTimeResult.kind === "cancelled") return { kind: "denial", result: allTimeResult.result };
    if (allTimeResult.kind === "failed") {
      warnings.push(allTimeResult.warning);
      statuses.push("incomplete_upstream");
      applications_status_hired_scope_all_time = {
        value: null,
        not_read: true,
        partial: false,
        clock: "applications.status (point-in-time, not dated)",
        window_label: "all time",
        scope_label: scope.label,
        privacy_withheld: 0,
        dated_from_fallback: 0,
        notes: [allTimeResult.warning],
      };
    } else {
      const allTime = allTimeResult.value;
      statuses.push(allTime.read.status);
      warnings.push(...allTime.read.warnings);
      applications_status_hired_scope_all_time = {
        value: allTime.hired,
        not_read: false,
        ...partialReading(!allTime.read.complete, "floor"),
        clock: "applications.status (point-in-time, not dated)",
        window_label: "all time",
        scope_label: scope.label,
        privacy_withheld: allTime.read.privacyWithheld,
        dated_from_fallback: 0,
        notes: [
          "this count is NOT windowed — it is every hired application in scope, whenever it was hired",
          ...shortReadNotes(allTime.read.complete, "the all-time hired-application read", allTime.read.status, "floor"),
          ...(allTime.rowsNotHired > 0
            ? [`${allTime.rowsNotHired} row(s) the status=hired filter returned do not carry status=hired and were excluded here`]
            : []),
        ],
      };
    }
  }

  const openingsResult = options.includeOpenings
    ? await contain("the closed-openings count", () =>
        readOpeningsClosedByHire(runtime, exposedToolName, scope, window, deadline))
    : null;
  if (openingsResult?.kind === "cancelled") return { kind: "denial", result: openingsResult.result };
  const openings = openingsResult?.kind === "value" ? openingsResult.value : null;
  if (openings) {
    statuses.push(openings.status);
    warnings.push(...openings.warnings);
  }
  if (openingsResult?.kind === "failed") {
    warnings.push(openingsResult.warning);
    statuses.push("incomplete_upstream");
  }
  const openings_closed_by_hire: OpeningsClosedByHireCount = openings
    ? {
        ...base,
        value: openings.hireClosed,
        not_read: false,
        ...partialReading(openings.status !== "complete", "floor"),
        clock: "openings.closed_at",
        privacy_withheld: openings.privacyWithheld,
        dated_from_fallback: 0,
        closed_with_no_reason: openings.closedWithNoReason,
        closed_reason_unresolved: openings.closedReasonUnresolved,
        // The openings read's OWN disclosures. They used to be computed and thrown away, so a count
        // that had silently fallen back to a local window over an unfiltered read read as a clean
        // server-side number.
        notes: [
          ...shortReadNotes(openings.status === "complete", "the closed-openings read", openings.status, "floor"),
          ...(openings.windowAppliedLocally
            ? [`the upstream rejected the closed_at filter (${openings.dateParamsRejected.join(", ")}), so the window was applied locally to the complete scoped set of closed openings`]
            : []),
          ...(openings.rowsMissingField > 0
            ? [`${openings.rowsMissingField} closed opening(s) carried no closed_at, so no clock could place them in the window`]
            : []),
        ],
      }
    : {
        ...base,
        value: null,
        not_read: true,
        partial: false,
        clock: "openings.closed_at",
        privacy_withheld: 0,
        dated_from_fallback: 0,
        closed_with_no_reason: 0,
        closed_reason_unresolved: 0,
        notes: openingsResult?.kind === "failed"
          ? [openingsResult.warning]
          : ["openings closed by a hire were not read"],
      };

  const status = combineReadStatuses(statuses);
  return {
    kind: "line",
    line: {
      accepted_current_offers,
      offer_rows_per_hire,
      accepted_offer_applications_marked_hired,
      ...(applications_status_hired_scope_all_time ? { applications_status_hired_scope_all_time } : {}),
      openings_closed_by_hire,
      read: { status, complete: status === "complete", warnings },
      scope,
      window,
    },
  };
}

/**
 * Count C: seats closed by a hire.
 *
 * `list_openings` rows carry `application_id` and go through the candidate privacy gate, so this
 * count has its own withheld figure like the other two. The close reason is the only
 * hire-vs-cancel discriminator, and in practice it is often absent on closed
 * openings — so "no reason" and "reason we could not resolve" are reported as their
 * own numbers rather than folded into the hire count or into each other.
 */
async function readOpeningsClosedByHire(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  scope: HireScope,
  window: HireWindow,
  deadline: ToolDeadline | undefined
): Promise<
  | {
      kind: "counts";
      hireClosed: number;
      closedWithNoReason: number;
      closedReasonUnresolved: number;
      privacyWithheld: number;
      windowAppliedLocally: boolean;
      dateParamsRejected: string[];
      rowsMissingField: number;
      status: ReadAllStatus;
      warnings: string[];
    }
  | { kind: "denial"; result: RecruiterToolResult }
> {
  // Whether /v3/openings honours closed_at[gte] live is UNPROVEN, so this read goes through the
  // same 422 fallback the offer read does rather than assuming either answer.
  const spec: DateWindowSpec = { field: "closed_at", gte: window.start, lte: window.end };
  // Same two rules as the hire read: `undefined` is permission-wide (one read, no job_ids), an
  // explicit set chunks at 50 rather than being sent whole, and an explicit EMPTY set is zero reqs.
  const jobChunks: Array<number[] | null> = scope.jobIds === undefined
    ? [null]
    : chunks([...new Set(scope.jobIds)], HIRE_JOB_ID_CHUNK_SIZE);

  const rows: Array<Record<string, unknown>> = [];
  const statuses: ReadAllStatus[] = [];
  const warnings: string[] = [];
  let privacyWithheld = 0;
  let rowsMissingField = 0;
  let windowAppliedLocally = false;
  let completedChunks = 0;
  const dateParamsRejected = new Set<string>();

  for (const jobChunk of jobChunks) {
    const outcome = await readAllWithDateFallback<Record<string, unknown>>(
      runtime,
      exposedToolName,
      "list_openings",
      sanitizeReadParams(
        {
          open: false,
          ...(jobChunk ? { job_ids: jobChunk.join(",") } : {}),
          ...bracketParamsForWindows([spec]),
        },
        runtime.limits,
        { allowedParamNames: HIRE_FACTS_OPENING_READ_PARAM_NAMES }
      ),
      [spec],
      deadline
    );
    if (outcome.read.kind === "denial") {
      const truncation = denialTruncationStatus(outcome.read.result);
      if (truncation === null || completedChunks === 0) return { kind: "denial", result: outcome.read.result };
      statuses.push(truncation);
      warnings.push("the closed-openings read stopped before every explicit req chunk was read");
      break;
    }
    completedChunks += 1;
    rows.push(...outcome.read.rows);
    statuses.push(outcome.read.status);
    warnings.push(...outcome.read.warnings);
    privacyWithheld += outcome.read.privacyWithheld;
    rowsMissingField += outcome.rowsMissingField;
    // Its own number, never added to the primary leg's: the two legs' populations overlap.
    if (outcome.fallbackFieldPrivacyWithheld > 0) {
      warnings.push(
        `a further ${outcome.fallbackFieldPrivacyWithheld} row(s) were withheld as private candidates on the ${outcome.fallbackFieldsQueried.join(", ")} leg of this window; that figure is reported separately because it overlaps the resolved_at leg's and the two must not be added`
      );
    }
    if (outcome.windowAppliedLocally) windowAppliedLocally = true;
    for (const rejected of outcome.dateParamsRejected) dateParamsRejected.add(rejected);
  }

  // No closed openings means no close_reason_id to resolve, so the dictionary read is skipped
  // rather than paid for. An explicitly empty req scope must cost ZERO upstream reads, and this
  // was the one call that still fired on it.
  const reasonNames = new Map<number, string>();
  const reasonWarnings: string[] = [];
  const reasonStatuses: ReadAllStatus[] = [];
  if (rows.length > 0) {
    const reasons = await readAllWithDateFallback<Record<string, unknown>>(
      runtime,
      exposedToolName,
      "list_close_reasons",
      sanitizeReadParams({}, runtime.limits, { allowedParamNames: HIRE_FACTS_ID_BRIDGE_READ_PARAM_NAMES }),
      [],
      deadline
    );
    if (reasons.read.kind === "denial") return { kind: "denial", result: reasons.read.result };
    for (const row of reasons.read.rows) {
      if (typeof row.id === "number" && typeof row.name === "string") reasonNames.set(row.id, row.name);
    }
    reasonWarnings.push(...reasons.read.warnings);
    reasonStatuses.push(reasons.read.status);
  }

  let hireClosed = 0;
  let closedWithNoReason = 0;
  let closedReasonUnresolved = 0;
  for (const row of rows) {
    const reasonId = row.close_reason_id;
    if (typeof reasonId !== "number") {
      closedWithNoReason += 1;
      continue;
    }
    const name = reasonNames.get(reasonId);
    if (name === undefined) {
      closedReasonUnresolved += 1;
      continue;
    }
    // A seat closed by a hire has BOTH: a hire close reason and the application it was filled by.
    // Both conjuncts are load-bearing — a "Not Filling - Budget" close with an application on it
    // is not a hire, and a hire-reason close with no application names nobody it hired.
    if (name.startsWith(HIRE_CLOSE_REASON_PREFIX) && typeof row.application_id === "number") hireClosed += 1;
  }

  return {
    kind: "counts",
    hireClosed,
    closedWithNoReason,
    closedReasonUnresolved,
    privacyWithheld,
    windowAppliedLocally,
    dateParamsRejected: [...dateParamsRejected].sort(),
    rowsMissingField,
    status: combineReadStatuses([...statuses, ...reasonStatuses]),
    warnings: [...warnings, ...reasonWarnings],
  };
}

/**
 * Every hired application in scope, over all time.
 *
 * Chunked like every other explicit job set (a 120-req scope sent as one `job_ids` string is a URL
 * Greenhouse will not answer), and the returned `status` is re-checked in memory exactly as the
 * sibling count at the accepted-set bridge does: a count that trusts a server-side filter it never
 * verified is a count with no evidence behind it.
 */
async function readAllTimeHiredApplications(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  scope: HireScope,
  deadline: ToolDeadline | undefined
): Promise<
  | { kind: "counts"; hired: number; rowsNotHired: number; read: HireReadStatus }
  | { kind: "denial"; result: RecruiterToolResult }
> {
  const jobChunks: Array<number[] | null> = scope.jobIds === undefined
    ? [null]
    : chunks([...new Set(scope.jobIds)], HIRE_JOB_ID_CHUNK_SIZE);

  const rows: Array<Record<string, unknown>> = [];
  const statuses: ReadAllStatus[] = [];
  const warnings: string[] = [];
  let pagesRead = 0;
  let rawRowsRead = 0;
  let privacyWithheld = 0;
  let completedChunks = 0;

  for (const jobChunk of jobChunks) {
    const outcome = await readAllWithDateFallback<Record<string, unknown>>(
      runtime,
      exposedToolName,
      "list_applications",
      sanitizeReadParams(
        { status: "hired", ...(jobChunk ? { job_ids: jobChunk.join(",") } : {}) },
        runtime.limits,
        { allowedParamNames: APPLICATION_ANALYSIS_READ_PARAM_NAMES }
      ),
      [],
      deadline
    );
    if (outcome.read.kind === "denial") {
      const truncation = denialTruncationStatus(outcome.read.result);
      if (truncation === null || completedChunks === 0) return { kind: "denial", result: outcome.read.result };
      statuses.push(truncation);
      warnings.push("the all-time hired-application read stopped before every explicit req chunk was read");
      break;
    }
    completedChunks += 1;
    rows.push(...outcome.read.rows);
    statuses.push(outcome.read.status);
    warnings.push(...outcome.read.warnings);
    pagesRead += outcome.read.pagesRead;
    rawRowsRead += outcome.read.rawRowsRead;
    privacyWithheld += outcome.read.privacyWithheld;
  }

  const hired = rows.filter((row) => normalizedText(row.status) === "hired").length;
  return {
    kind: "counts",
    hired,
    rowsNotHired: rows.length - hired,
    read: {
      status: combineReadStatuses(statuses),
      complete: combineReadStatuses(statuses) === "complete",
      pagesRead,
      rawRowsRead,
      privacyWithheld,
      rowsMissingField: 0,
      windowAppliedLocally: false,
      dateParamsRejected: [],
      warnings,
    },
  };
}

/**
 * The line, in a recruiter's words: one sentence per count, each carrying its own clock, its own
 * privacy regime and the window and scope it ran over. Counts that were not read say so instead of
 * reading as zero.
 */
export function hireReconciliationSummary(line: HireReconciliationLine): string {
  const sentences: string[] = [];
  sentences.push(
    line.accepted_current_offers.not_read
      ? "Accepted current offers were not read."
      : `${countValue(line.accepted_current_offers)} accepted current offers${withheldClause(line.accepted_current_offers)}, dated on ${line.accepted_current_offers.clock} over ${line.window.label} across ${line.scope.label}${datedFromFallbackClause(line.accepted_current_offers)}${uncertaintyClause(line.accepted_current_offers)}.`
  );
  sentences.push(
    line.accepted_offer_applications_marked_hired.not_read
      ? `The accepted set's applications were not read${line.accepted_offer_applications_marked_hired.notes.length > 0 ? ` — ${line.accepted_offer_applications_marked_hired.notes[0]}` : "."}`
      : `${countValue(line.accepted_offer_applications_marked_hired)} of those applications are marked hired in Greenhouse${withheldClause(line.accepted_offer_applications_marked_hired)}${uncertaintyClause(line.accepted_offer_applications_marked_hired)} — ${line.accepted_offer_applications_marked_hired.clock}, so it trails the offer count until the hire endpoint fires.`
  );
  sentences.push(
    line.openings_closed_by_hire.not_read
      ? "Openings closed by a hire were not read."
      : `${countValue(line.openings_closed_by_hire)} openings closed on a hire reason${withheldClause(line.openings_closed_by_hire)}, dated on ${line.openings_closed_by_hire.clock}${uncertaintyClause(line.openings_closed_by_hire)}; ${line.openings_closed_by_hire.closed_with_no_reason} closed with no reason at all and ${line.openings_closed_by_hire.closed_reason_unresolved} on a reason this read could not resolve, so neither can be called a hire or a cancel.`
  );
  sentences.push(
    line.offer_rows_per_hire.not_read
      ? "Superseded versions were not read, so offer rows per hire is not reported."
      : line.offer_rows_per_hire.value === null
        ? "There are no hires in this window, so offer rows per hire is undefined rather than zero."
        : `${countValue(line.offer_rows_per_hire)} offer rows per hire across every version${withheldClause(line.offer_rows_per_hire)}${uncertaintyClause(line.offer_rows_per_hire)}.`
  );
  if (line.applications_status_hired_scope_all_time) {
    sentences.push(
      line.applications_status_hired_scope_all_time.not_read
        ? "The all-time hired-application count was asked for but could not be read."
        : `Separately, and over all time rather than ${line.window.label}: ${countValue(line.applications_status_hired_scope_all_time)} applications in scope carry status=hired${withheldClause(line.applications_status_hired_scope_all_time)}${uncertaintyClause(line.applications_status_hired_scope_all_time)}.`
    );
  }
  sentences.push("These count different populations on different clocks; they are not expected to match, and no total across them is meaningful.");
  return sentences.join(" ");
}

/**
 * `partial` and, when it is true, WHICH reading of partial. Spread onto the count so the two
 * always travel together and a completed read can never carry a stray `partial_reading`.
 */
function partialReading(
  partial: boolean,
  reading: "floor" | "uncertain"
): { partial: boolean; partial_reading?: "floor" | "uncertain" } {
  return partial ? { partial: true, partial_reading: reading } : { partial: false };
}

/** Which read stopped, and what that does to the count. Empty when the read finished. */
function shortReadNotes(
  complete: boolean,
  which: string,
  status: ReadAllStatus,
  reading: "floor" | "uncertain"
): string[] {
  if (complete) return [];
  const consequence = reading === "floor"
    ? "so this count is a floor rather than the number"
    : "so this count is uncertain rather than the number — it can be higher or lower once the rest is read";
  return [`${which} stopped before it had read everything in scope (${status}), ${consequence}`];
}

/** "at least 50" for a floor; the bare value for an uncertainty, which the sentence then qualifies. */
function countValue(count: ReconciliationCount): string {
  return `${count.partial && count.partial_reading === "floor" ? "at least " : ""}${count.value}`;
}

/**
 * The qualifier a floor does NOT need: an "at least" already says which way the number can move,
 * whereas an uncertain value has to say out loud that it can move either way.
 */
function uncertaintyClause(count: ReconciliationCount): string {
  return count.partial && count.partial_reading === "uncertain"
    ? " — from a partial read; the true value may be higher or lower"
    : "";
}

/** The labeled approximation, said out loud: N of these hires are dated off the send date. */
function datedFromFallbackClause(count: ReconciliationCount): string {
  return count.dated_from_fallback > 0
    ? `, ${count.dated_from_fallback} of which dated from the send date because the accepted date was missing`
    : "";
}

function withheldClause(count: ReconciliationCount): string {
  return count.privacy_withheld > 0
    ? ` (${count.privacy_withheld} withheld as private candidates you cannot see)`
    : "";
}

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function uniquePositiveIds(rows: Array<Record<string, unknown>>, field: string): number[] {
  const ids = new Set<number>();
  for (const row of rows) {
    const value = row[field];
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) ids.add(value);
  }
  return [...ids];
}
