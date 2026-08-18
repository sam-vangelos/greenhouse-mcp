import { newCorrelationId } from "../audit.js";
import { httpErrorStatus } from "../upstream-error.js";
import { isToolEnabled, readPositiveInt, sanitizeReadParams } from "../limits.js";
import {
  combineReadStatuses,
  denialTruncationStatus,
  classifyUpstreamError,
  readAllScopedRows,
  readStatusMessage,
  type ReadAllRowsResult,
  type ReadAllStatus,
} from "../read-all.js";
import {
  createToolDeadline,
  deny,
  emitRequiredToolAudit,
  enforceUsageBudget,
  isToolTimeoutError,
  type RecruiterToolRuntime,
  type ToolDeadline,
} from "../runtime.js";
import { IdentityResolutionError } from "../identity.js";
import {
  redeemScopeHandle,
  validateExactJobIds,
  type JobScopeContextResolution,
} from "../resolution/analysis-context.js";
import type {
  EvidenceBridgeEnvelope,
  EvidenceReadEnvelope,
  EvidenceScopeEnvelope,
  RecruiterPermissionScope,
  RecruiterToolResult,
} from "../types.js";
import {
  loadApplicationIdsForJobScope,
  loadCandidateIdsForJobScope,
  loadInterviewIdsForJobScope,
  loadScorecardIdsForJobScope,
  chunks as idChunks,
  mapWithConcurrency,
  type JobScopeIdBridge,
  type JobScopeIdBridgeResult,
} from "./application-job-lookup.js";
import {
  SCOPED_ENDPOINT_ADAPTERS_BY_PATH,
  type EvidenceEndpointAdapter,
} from "./scoped-endpoint-adapters.js";

const APPLICATION_ID_BATCH_SIZE = 25;

type RowsResult = Extract<ReadAllRowsResult<Record<string, unknown>>, { kind: "rows" }>;

/**
 * Read-all-backed execution for an evidence SEARCH (list_*) tool, with an auto-bridge that makes a
 * confirmed requisition scope actually constrain the application-backed endpoints.
 *
 * L2 (the read-all routing): the raw search tools used to do a single scoped read — one page of up to
 * per_page rows plus a cursor. v3 returns 100 rows by default, so the host model saw "100 + cursor",
 * read it as truncated, and tried to follow the cursor by hand. This routes the search through the
 * same read-all engine the recipes use, so ONE call returns the COMPLETE scoped set with an honest
 * completeness/truncation envelope.
 *
 * L1 (the job -> application_ids bridge): the application-backed endpoints (application_stages,
 * scorecards, rejection_details, notes, attachments) can ONLY be filtered by application_ids — there
 * is no job_ids filter — so a confirmed scope was inert on them and they returned rows across every
 * permitted job. When the caller supplies a scope (scope_handle / validated job_ids) on one of these
 * tools, the read now auto-bridges: it derives the application_ids on the scope's jobs (via
 * /v3/applications, scoped) and constrains the read to those applications, disclosing the bridge. The
 * permitted-jobs floor is unchanged — the bridge NARROWS within the permitted set and never widens.
 *
 * The guard/audit structure mirrors runScopedTool (enabled -> rate-limit -> read -> required audit ->
 * fail-closed when audit is unavailable); only the read primitive differs.
 */
export async function runEvidenceListRead(
  runtime: RecruiterToolRuntime,
  adapter: EvidenceEndpointAdapter,
  params: Record<string, unknown>,
  allowedParamNames: ReadonlySet<string> | undefined
): Promise<RecruiterToolResult> {
  const exposedToolName = adapter.evidenceToolName;
  const startedAt = runtime.now();
  const correlationId = newCorrelationId(runtime.now);
  const actAsUser = runtime.trustedActAsUser ?? null;
  const surface = runtime.session.surface;

  if (!isToolEnabled(runtime.toolConfig, surface, exposedToolName, "evidence")) {
    const denied = deny(exposedToolName, "TOOL_DISABLED", "This scoped Greenhouse tool is disabled for this runtime.");
    return (await emitRequiredToolAudit(runtime, exposedToolName, "evidence", startedAt, correlationId, denied, null, null, actAsUser)) ?? denied;
  }

  const rateDenied = await enforceUsageBudget(runtime, exposedToolName, "evidence", surface, startedAt, correlationId, actAsUser);
  if (rateDenied) return rateDenied;

  const deadline = createToolDeadline(runtime, startedAt);
  const auditDenial = (denied: RecruiterToolResult, rowsRead: number | null = null) =>
    emitRequiredToolAudit(runtime, exposedToolName, "evidence", startedAt, correlationId, denied, rowsRead, null, actAsUser).then((d) => d ?? denied);

  try {
    // 1. Resolve a confirmed requisition scope. The bridgeable tools (application/scorecard/interview/
    //    candidate-backed) have endpoints with NO job_ids filter, so a confirmed scope is inert on them
    //    unless it is auto-bridged to the endpoint's own id filter (L1 for application_ids; R2 for the
    //    four sibling targets). getScopeBridgeSpec returns the per-class bridge plan, or null for tools
    //    where job_ids is the endpoint's native filter (handled by sanitizeReadParams).
    const bridgeSpec = getScopeBridgeSpec(adapter);
    const scope = bridgeSpec
      ? await resolveEvidenceScope(runtime, params, deadline)
      : ({ ok: true, jobIds: null, header: null } as const);
    if (!scope.ok) {
      return auditDenial(deny(exposedToolName, scope.code, scope.message));
    }

    const { translated, windowSpecs } = translateRangeParams(params, allowedParamNames);
    const safeParams = sanitizeReadParams(translated, runtime.limits, { allowedParamNames });
    let windowAppliedLocally: { fields: string[]; rows_missing_field: number; note: string } | undefined;

    let rows: RowsResult;
    let bridgeEnvelope: EvidenceBridgeEnvelope | undefined;
    let scopeEnvelope: EvidenceScopeEnvelope | undefined;

    if (bridgeSpec && scope.jobIds) {
      const bridged = await readBridgedByScope(runtime, adapter, bridgeSpec, safeParams, scope.jobIds, deadline);
      if (bridged.kind === "denial") return auditDenial(bridged.result);
      rows = bridged.rows;
      bridgeEnvelope = bridged.bridge;
      scopeEnvelope = buildScopeEnvelope(scope);
    } else {
      let readAll: Awaited<ReturnType<typeof readAllScopedRows<Record<string, unknown>>>>;
      try {
        readAll = await readAllScopedRows<Record<string, unknown>>(runtime, exposedToolName, adapter.scopedToolName, safeParams, deadline);
      } catch (error) {
        // Self-healing docs-vs-live divergence (live demo, 2026-07-02): some LIVE endpoints 422
        // date filters the vendored contract advertises (offers rejects resolved_at/created_at/
        // updated_at; applications accepts them). Native filtering stays the first attempt —
        // cheap where supported — and a 422 with range params in play re-reads WITHOUT them and
        // applies the window locally to the complete scoped set, disclosed below.
        if (windowSpecs.length === 0 || httpErrorStatus(error) !== 422) throw error;
        const stripped = Object.fromEntries(
          Object.entries(safeParams).filter(([key]) => !/\[(gte|lte|gt|lt)\]$/.test(key))
        );
        readAll = await readAllScopedRows<Record<string, unknown>>(runtime, exposedToolName, adapter.scopedToolName, stripped, deadline);
        if (readAll.kind !== "denial") {
          const windowed = applyLocalWindow(readAll.rows, windowSpecs);
          windowAppliedLocally = {
            fields: windowSpecs.map((spec) => spec.field),
            rows_missing_field: windowed.missing,
            note: "Upstream rejected the date filter (422 — this endpoint does not support it live); the window was applied locally to the complete scoped set. Rows lacking the field were excluded.",
          };
          readAll = { ...readAll, rows: windowed.rows };
        }
      }
      if (readAll.kind === "denial") return auditDenial(readAll.result);
      rows = readAll;
      if (bridgeSpec) {
        // A bridgeable read with NO confirmed scope is disclosed honestly with a pointer to narrow —
        // never a silent all-permitted result. The note is accurate to what actually bounds the read:
        // a raw target-id filter narrows it; otherwise it spans all permitted jobs.
        scopeEnvelope = unscopedBridgeableNote(safeParams, bridgeSpec);
      }
    }

    // Live-pilot fix (2026-07-02): the complete-set-by-default design collided with the MCP
    // client's 1MB tool-result cap on large scopes (search_my_jobs over ~1,030 fat post-denylist
    // rows serialized past 1MB and the client dropped it — worse than a truncated answer).
    // Two honest governors, both disclosed in the envelope, neither silent:
    //   1. An EXPLICIT caller per_page is honored as a RESULT cap (a caller asking for 5 rows and
    //      receiving 1,030 is the ignored-explicit-param class).
    //   2. A serialization size guard keeps the payload under the transport cap by returning the
    //      largest row prefix that fits, marked truncated with guidance to narrow.
    const explicitPerPage = readExplicitResultCap(params);
    const explicitOffset = readPositiveInt(params.offset) ?? 0;
    let returnedRows = rows.rows;
    let truncatedBy: "per_page" | "payload_size" | "offset" | null = null;
    if (explicitOffset > 0) {
      returnedRows = returnedRows.slice(explicitOffset);
      truncatedBy = "offset";
    }
    if (explicitPerPage !== null && returnedRows.length > explicitPerPage) {
      returnedRows = returnedRows.slice(0, explicitPerPage);
      truncatedBy = "per_page";
    }
    const rowsBeforeSizeGuard = returnedRows.length;
    const sized = fitRowsToPayloadBudget(returnedRows);
    let oversizedRowsOmitted = 0;
    if (sized.truncated) {
      returnedRows = sized.rows;
      truncatedBy = "payload_size";
      // If even the first projected row cannot fit, disclose and advance past that one row so the
      // continuation is deterministic rather than an offset=0 loop.
      if (returnedRows.length === 0 && rowsBeforeSizeGuard > 0) oversizedRowsOmitted = 1;
    }
    // Deterministic continuation over the complete scoped set: the read is stable-sorted upstream,
    // so offset+per_page pages it without server state. next_offset names the next slice whenever
    // ANY governor left a suffix unreturned.
    const consumedThrough = explicitOffset + returnedRows.length + oversizedRowsOmitted;
    const nextOffset = consumedThrough < rows.rows.length ? consumedThrough : undefined;

    const result: RecruiterToolResult = {
      ok: true,
      toolName: exposedToolName,
      actorId: rows.actorId,
      effectiveActorId: rows.effectiveActorId,
      scoped: rows.scoped ?? true,
      permissionScope: rows.permissionScope,
      rowCounts: {
        raw: rows.rawRowsRead,
        returned: returnedRows.length,
        permissionExcluded: rows.permissionExcluded,
        unresolved: rows.unresolvedRows,
        status: rows.status === "incomplete_scope_resolution" ? "incomplete_scope_resolution" : "complete",
      },
      data: returnedRows,
      nextCursor: null,
      read: {
        ...buildReadEnvelope(rows),
        ...(windowAppliedLocally ? { window_applied_locally: windowAppliedLocally } : {}),
        ...(truncatedBy
          ? {
              result_truncated: {
                by: truncatedBy,
                rows_returned: returnedRows.length,
                rows_in_scoped_set: rows.rows.length,
                ...(oversizedRowsOmitted > 0 ? { oversized_rows_omitted: oversizedRowsOmitted } : {}),
                ...(nextOffset !== undefined ? { next_offset: nextOffset } : {}),
                note:
                  truncatedBy === "per_page" || truncatedBy === "offset"
                    ? "Returned the requested slice of the complete scoped set. Page onward by passing offset=next_offset (with per_page), or narrow with a date range (e.g. resolved_at: {\"gte\": \"2026-04-01\", \"lte\": \"2026-06-30\"})."
                    : "The complete scoped set exceeds the client's tool-result size cap; returned the largest prefix that fits. Page onward with offset=next_offset (+ per_page), or narrow with job_ids/scope_handle or a date range (e.g. resolved_at: {\"gte\": ..., \"lte\": ...}).",
              },
            }
          : {}),
      },
      ...(scopeEnvelope ? { scope: scopeEnvelope } : {}),
      ...(bridgeEnvelope ? { bridge: bridgeEnvelope } : {}),
    };

    const auditDenied = await emitRequiredToolAudit(runtime, exposedToolName, "evidence", startedAt, correlationId, result, rows.rawRowsRead, rows.rows.length, actAsUser);
    return auditDenied ?? result;
  } catch (error) {
    return auditDenial(evidenceReadError(exposedToolName, error));
  }
}

const RANGE_OPERATORS = new Set(["gte", "lte", "gt", "lt"]);
const DATE_PARAM_PATTERN = /(_at|_on)$/;

/**
 * Translate model-friendly date-range forms into v3's bracket params BEFORE sanitization:
 *   resolved_at: "2026-04-01..2026-06-30"      -> resolved_at[gte] / resolved_at[lte]
 *   resolved_at: { gte: "...", lte: "..." }     -> resolved_at[gte] / resolved_at[lte]
 * The registry generation flattened v3's object-typed range filters to bare strings, so the tool
 * boundary could not express a time window at all — the live model guessed "A..B", the raw string
 * passed through, and Greenhouse 400'd (live-pilot finding #2). Bare scalars pass through unchanged;
 * a base param not in the endpoint's allowlist keeps its original shape so sanitize drops it.
 */
interface DateWindowSpec {
  field: string;
  gte?: string;
  lte?: string;
  gt?: string;
  lt?: string;
}

function translateRangeParams(
  params: Record<string, unknown>,
  allowedParamNames: ReadonlySet<string> | undefined
): { translated: Record<string, unknown>; windowSpecs: DateWindowSpec[] } {
  const out: Record<string, unknown> = {};
  const windowSpecs: DateWindowSpec[] = [];
  for (const [key, value] of Object.entries(params)) {
    const translatable = DATE_PARAM_PATTERN.test(key) && (!allowedParamNames || allowedParamNames.has(key));
    if (translatable && typeof value === "string" && value.includes("..")) {
      const [start, end] = value.split("..", 2);
      const spec: DateWindowSpec = { field: key };
      if (start) {
        out[`${key}[gte]`] = start;
        spec.gte = start;
      }
      if (end) {
        out[`${key}[lte]`] = end;
        spec.lte = end;
      }
      if (spec.gte || spec.lte) windowSpecs.push(spec);
      continue;
    }
    if (translatable && value && typeof value === "object" && !Array.isArray(value)) {
      const spec: DateWindowSpec = { field: key };
      for (const [operator, bound] of Object.entries(value as Record<string, unknown>)) {
        if (RANGE_OPERATORS.has(operator) && typeof bound === "string") {
          out[`${key}[${operator}]`] = bound;
          spec[operator as "gte" | "lte" | "gt" | "lt"] = bound;
        }
      }
      if (spec.gte || spec.lte || spec.gt || spec.lt) windowSpecs.push(spec);
      continue;
    }
    out[key] = value;
  }
  return { translated: out, windowSpecs };
}

// Date-only bounds (YYYY-MM-DD) are END-of-day inclusive for upper bounds under local windowing —
// a timestamp ON the lte date must stay in-window, matching the upstream filters' semantics.
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function upperBound(bound: string): string {
  return DATE_ONLY_PATTERN.test(bound) ? `${bound}T23:59:59.999Z` : bound;
}

function applyLocalWindow(
  rows: Array<Record<string, unknown>>,
  specs: DateWindowSpec[]
): { rows: Array<Record<string, unknown>>; missing: number } {
  let missing = 0;
  const kept = rows.filter((row) => {
    for (const spec of specs) {
      const value = row[spec.field];
      if (typeof value !== "string" || value.length === 0) {
        missing += 1;
        return false;
      }
      if (spec.gte && value < spec.gte) return false;
      if (spec.gt && value <= upperBound(spec.gt)) return false;
      if (spec.lte && value > upperBound(spec.lte)) return false;
      if (spec.lt && value >= spec.lt) return false;
    }
    return true;
  });
  return { rows: kept, missing };
}

// An explicit caller per_page is a RESULT cap on list reads (upstream paging always runs at the
// read-all default page size — a small result cap must never multiply upstream round trips; a
// per_page:50 read of a 3k-row scope meant 62 round trips and a live client timeout).
// Only an explicitly-present positive integer counts — absent/blank means the
// complete-set default.
function readExplicitResultCap(params: Record<string, unknown>): number | null {
  const raw = params.per_page;
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) return raw;
  if (typeof raw === "string" && /^[1-9]\d*$/.test(raw.trim())) return Number.parseInt(raw.trim(), 10);
  return null;
}

// Reserve headroom inside the universal 700 KB response ceiling for the read/scope/bridge envelope.
// Measure UTF-8 bytes (not JavaScript code units) and return the largest deterministic prefix.
const RESULT_ROWS_PAYLOAD_BUDGET_BYTES = 550_000;

function fitRowsToPayloadBudget(
  rows: Array<Record<string, unknown>>
): { rows: Array<Record<string, unknown>>; truncated: boolean } {
  if (rows.length === 0) return { rows, truncated: false };
  const fits = (candidate: Array<Record<string, unknown>>): boolean =>
    Buffer.byteLength(JSON.stringify(candidate, null, 2), "utf8") <= RESULT_ROWS_PAYLOAD_BUDGET_BYTES;
  if (fits(rows)) return { rows, truncated: false };

  let low = 0;
  let high = rows.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(rows.slice(0, mid))) low = mid;
    else high = mid - 1;
  }
  return { rows: rows.slice(0, low), truncated: true };
}

// Resolve scope_handle / job_ids into validated, currently-accessible job ids using the same
// machinery the analysis recipes use (redeemScopeHandle re-validates a frozen scope against live
// permissions; validateExactJobIds checks raw ids against the permission-scoped inventory). Returns
// jobIds: null when no scope carrier was supplied. A failed/forbidden/expired scope fails closed.
async function resolveEvidenceScope(
  runtime: RecruiterToolRuntime,
  params: Record<string, unknown>,
  deadline: ToolDeadline | undefined
): Promise<{ ok: true; jobIds: number[] | null; header: ScopeHeader | null } | { ok: false; code: ScopeDenialCode; message: string }> {
  const scopeHandle = typeof params.scope_handle === "string" && params.scope_handle.trim().length > 0 ? params.scope_handle.trim() : null;
  const hasJobIds = params.job_ids !== undefined && params.job_ids !== null && !(typeof params.job_ids === "string" && params.job_ids.trim().length === 0);

  if (!scopeHandle && !hasJobIds) {
    return { ok: true, jobIds: null, header: null };
  }

  const resolution = scopeHandle
    ? await redeemScopeHandle(runtime, scopeHandle, hasJobIds, deadline)
    : await validateExactJobIds(runtime, params.job_ids, deadline);

  if (!resolution.ok) {
    return { ok: false, code: resolution.code, message: resolution.message };
  }

  const jobIds = parseJobIdCsv(resolution.jobIds);
  if (jobIds.length === 0) {
    return { ok: false, code: "INVALID_REQUEST", message: "The confirmed scope resolved to no accessible jobs." };
  }
  return { ok: true, jobIds, header: resolution.header ?? null };
}

type ScopeHeader = NonNullable<Extract<JobScopeContextResolution, { ok: true }>["header"]>;
type ScopeDenialCode = Extract<JobScopeContextResolution, { ok: false }>["code"];

interface BridgedRead {
  kind: "rows";
  rows: RowsResult;
  bridge: EvidenceBridgeEnvelope;
}

// The per-class plan for auto-bridging a confirmed scope onto an endpoint that has no job_ids filter.
// deriveIds resolves the scope's jobs to the endpoint's own id filter (targetParam) through the scoped
// reader (so the ids are permitted-bounded); dropVectors are parallel filters that must be removed under
// a confirmed scope because they could surface out-of-scope rows. null => unbridgeable (today's
// behavior; job_ids is the endpoint's native filter).
interface ScopeBridgeSpec {
  targetParam: string;
  via: EvidenceBridgeEnvelope["via"];
  deriveIds: (
    runtime: RecruiterToolRuntime,
    exposedToolName: string,
    jobIds: number[],
    deadline?: ToolDeadline
  ) => Promise<JobScopeIdBridgeResult>;
  dropVectors: string[];
  basis: string;
  // Plain-language noun for the unscoped-read disclosure ("applications"/"scorecards"/...).
  spanNoun: string;
}

const APPLICATION_BRIDGE_BASIS =
  "Derived application_ids from /v3/applications filtered by the confirmed job scope, then constrained this application-backed read to those applications (the endpoint has no job_ids filter). Application-level (no application_id) rows are not part of a requisition-scoped read.";

// Resolve the bridge plan for a tool, or null when job_ids is the endpoint's own native filter (no
// bridge needed). One source of truth for both the dispatch here and the schema-carrier advertising in
// evidence.ts (and the registry schema lock). The candidate_ids drop stays ONLY on application_backed —
// candidate_ids is the dual-parent widening vector on /v3/notes,/v3/attachments; the other classes have
// no parallel parent filter (their secondary *_ids filters AND-narrow), so they drop nothing.
export function getScopeBridgeSpec(adapter: EvidenceEndpointAdapter | undefined): ScopeBridgeSpec | null {
  if (!adapter || adapter.evidenceToolName.startsWith("get_")) return null;
  if (adapter.scopePolicy?.kind === "direct") {
    const targetParam = adapter.scopePolicy.terminal.filter;
    return {
      targetParam,
      via: "ids",
      deriveIds: async (_runtime, _tool, jobIds) => ({
        kind: "ids",
        ids: [...new Set(jobIds)],
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
      }),
      dropVectors: [],
      basis: `Applied the confirmed job scope through the registered ${targetParam} terminal filter.`,
      spanNoun: "jobs",
    };
  }
  if (adapter.scopePolicy?.kind === "join_backed") {
    const targetParam = adapter.scopePolicy.dependencies[0]?.sourceFilter;
    if (!targetParam) return null;
    return {
      targetParam,
      // Preserve the established typed disclosure when the registry resolves to a known target
      // filter (application_ids for application_stages); unfamiliar future filters use `ids` as
      // the generic envelope shape. Request construction still comes from the policy graph.
      via: bridgeViaForTargetParam(targetParam),
      deriveIds: (runtime, exposedToolName, jobIds, deadline) =>
        deriveJoinBackedFilterIds(runtime, exposedToolName, adapter, jobIds, deadline),
      dropVectors: [],
      basis:
        `Derived ${targetParam} by reversing the registered ${adapter.endpointPath} permission-join chain from the confirmed job scope, then constrained this read with that documented filter.`,
      spanNoun: "records",
    };
  }
  switch (adapter.scopeClass) {
    case "application_backed":
      return {
        targetParam: "application_ids",
        via: "application_ids",
        deriveIds: loadApplicationIdsForJobScope,
        dropVectors: ["candidate_ids"],
        basis: APPLICATION_BRIDGE_BASIS,
        spanNoun: "applications",
      };
    case "scorecard_backed":
      return {
        targetParam: "scorecard_ids",
        via: "scorecard_ids",
        deriveIds: loadScorecardIdsForJobScope,
        dropVectors: [],
        basis:
          "Derived scorecard_ids from /v3/scorecards on the confirmed scope's applications (job scope -> applications -> scorecards), then constrained this scorecard-backed read to those scorecards (the endpoint has no job_ids filter).",
        spanNoun: "scorecards",
      };
    case "interview_backed":
      return {
        targetParam: "interview_ids",
        via: "interview_ids",
        deriveIds: loadInterviewIdsForJobScope,
        dropVectors: [],
        basis:
          "Derived interview_ids from /v3/interviews filtered by the confirmed job scope, then constrained this interview-backed read to those interviews (the endpoint has no job_ids filter).",
        spanNoun: "interviews",
      };
    case "candidate_backed":
      return {
        // The candidate id IS the /v3/candidates row id (filter `ids`); candidate_educations and
        // candidate_employments filter by `candidate_ids`.
        targetParam: adapter.evidenceToolName === "search_my_candidates" ? "ids" : "candidate_ids",
        via: adapter.evidenceToolName === "search_my_candidates" ? "ids" : "candidate_ids",
        deriveIds: loadCandidateIdsForJobScope,
        dropVectors: [],
        basis:
          "Derived candidate ids from /v3/applications filtered by the confirmed job scope, then constrained this candidate-backed read to those candidates (the endpoint has no job_ids filter).",
        spanNoun: "candidates",
      };
    default:
      return null;
  }
}

function bridgeViaForTargetParam(targetParam: string): EvidenceBridgeEnvelope["via"] {
  if (
    targetParam === "application_ids" ||
    targetParam === "scorecard_ids" ||
    targetParam === "interview_ids" ||
    targetParam === "candidate_ids"
  ) {
    return targetParam;
  }
  return "ids";
}

async function deriveJoinBackedFilterIds(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  adapter: EvidenceEndpointAdapter,
  jobIds: number[],
  deadline?: ToolDeadline
): Promise<JobScopeIdBridgeResult> {
  const policy = adapter.scopePolicy;
  if (!policy || policy.kind !== "join_backed" || policy.dependencies.length === 0) {
    return {
      kind: "denial",
      result: deny(exposedToolName, "INVALID_REQUEST", "This endpoint has no executable scope-join policy."),
    };
  }

  const statuses: ReadAllStatus[] = [];
  const warnings: string[] = [];
  let rawRowsRead = 0;
  let returnedRowsRead = 0;
  let permissionExcluded = 0;
  let unresolvedRows = 0;
  let pagesRead = 0;
  let rateLimitRetries = 0;
  let rateLimitSleepMs = 0;
  let cacheHits = 0;
  let actorId: number | undefined;
  let effectiveActorId: number | undefined;
  let scoped: boolean | undefined;
  let permissionScope: RecruiterPermissionScope | undefined;

  const absorb = (hop: JobScopeIdBridge): void => {
    statuses.push(hop.status);
    warnings.push(...hop.warnings);
    rawRowsRead += hop.rawRowsRead;
    returnedRowsRead += hop.returnedRowsRead;
    permissionExcluded += hop.permissionExcluded;
    unresolvedRows += hop.unresolvedRows;
    pagesRead += hop.pagesRead;
    rateLimitRetries += hop.rateLimitRetries;
    rateLimitSleepMs += hop.rateLimitSleepMs;
    cacheHits += hop.cacheHits;
    actorId ??= hop.actorId;
    effectiveActorId ??= hop.effectiveActorId;
    scoped ??= hop.scoped;
    permissionScope ??= hop.permissionScope;
  };

  const dependencies = policy.dependencies;
  const deepest = dependencies[dependencies.length - 1]!;
  let hop = await deriveIdsFromRegisteredEndpoint(
    runtime,
    exposedToolName,
    deepest.targetEndpoint,
    policy.terminal.filter,
    jobIds,
    deepest.targetField,
    deadline
  );
  if (hop.kind === "denial") return hop;
  absorb(hop);
  let ids = hop.ids;

  for (let index = dependencies.length - 1; index > 0; index -= 1) {
    const childDependency = dependencies[index]!;
    const childEndpoint = dependencies[index - 1]!.targetEndpoint;
    hop = await deriveIdsFromRegisteredEndpoint(
      runtime,
      exposedToolName,
      childEndpoint,
      childDependency.sourceFilter,
      ids,
      dependencies[index - 1]!.targetField,
      deadline
    );
    if (hop.kind === "denial") return hop;
    absorb(hop);
    ids = hop.ids;
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
    pagesRead,
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

async function deriveIdsFromRegisteredEndpoint(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  endpointPath: string,
  filter: string,
  filterIds: number[],
  idField: string,
  deadline?: ToolDeadline
): Promise<JobScopeIdBridgeResult> {
  const endpoint = SCOPED_ENDPOINT_ADAPTERS_BY_PATH.get(endpointPath);
  const binding = endpoint?.evidenceTools.find((tool) => tool.toolName.startsWith("search_"));
  if (!binding) {
    return {
      kind: "denial",
      result: deny(exposedToolName, "INVALID_REQUEST", `Scope join target is not readable: ${endpointPath}.`),
    };
  }
  const uniqueFilterIds = [...new Set(filterIds)].filter((id) => Number.isSafeInteger(id) && id > 0);
  if (uniqueFilterIds.length === 0) {
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

  const reads = await mapWithConcurrency(idChunks(uniqueFilterIds, 50), (batch) =>
    readAllScopedRows<Record<string, unknown>>(
      runtime,
      exposedToolName,
      binding.scopedToolName,
      { [filter]: batch.join(",") },
      deadline
    )
  );
  const ids: number[] = [];
  const seen = new Set<number>();
  const statuses: ReadAllStatus[] = [];
  const warnings: string[] = [];
  let rawRowsRead = 0;
  let returnedRowsRead = 0;
  let permissionExcluded = 0;
  let unresolvedRows = 0;
  let pagesRead = 0;
  let rateLimitRetries = 0;
  let rateLimitSleepMs = 0;
  let cacheHits = 0;
  let actorId: number | undefined;
  let effectiveActorId: number | undefined;
  let scoped: boolean | undefined;
  let permissionScope: RecruiterPermissionScope | undefined;
  let completedReads = 0;
  for (const read of reads) {
    if (read.kind === "denial") {
      const truncated = denialTruncationStatus(read.result);
      if (truncated && completedReads > 0) {
        statuses.push(truncated);
        warnings.push(`scope-id derivation stopped after a later batch (${truncated})`);
        break;
      }
      return read;
    }
    for (const row of read.rows) {
      const id = readPositiveInt(row[idField]);
      if (id !== null && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    statuses.push(read.status);
    completedReads += 1;
    warnings.push(...read.warnings);
    rawRowsRead += read.rawRowsRead;
    returnedRowsRead += read.rowsReturnedRead ?? read.rows.length;
    permissionExcluded += read.permissionExcluded;
    unresolvedRows += read.unresolvedRows;
    pagesRead += read.pagesRead;
    rateLimitRetries += read.rateLimitRetries;
    rateLimitSleepMs += read.rateLimitSleepMs;
    cacheHits += read.cacheHits;
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
    pagesRead,
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

// The auto-bridge: job scope -> target ids (via spec.deriveIds, scoped/permitted-bounded) -> a read of
// this endpoint constrained to those ids in 25-id chunks. Both the derive and the endpoint read are
// read-all, so the result is the COMPLETE constrained set with an honest combined completeness status.
// Generalizes the L1 application_ids bridge to every class whose endpoint lacks a job_ids filter; for
// application_backed the output (rows + envelope) is byte-for-byte the L1 result.
async function readBridgedByScope(
  runtime: RecruiterToolRuntime,
  adapter: EvidenceEndpointAdapter,
  spec: ScopeBridgeSpec,
  safeParams: Record<string, unknown>,
  jobIds: number[],
  deadline: ToolDeadline | undefined
): Promise<BridgedRead | { kind: "denial"; result: RecruiterToolResult }> {
  const exposedToolName = adapter.evidenceToolName;
  const bridge = await spec.deriveIds(runtime, exposedToolName, jobIds, deadline);
  if (bridge.kind === "denial") return bridge;

  // If the caller ALSO passed the endpoint's id filter, INTERSECT — honor both narrowings, never widen
  // past either. The scope-derived set is the authority; an explicit id list only narrows further. A
  // caller value OUTSIDE the derived set drops out (intersection), so a caller can never widen the scope.
  const callerIds = parseJobIdCsv(safeParams[spec.targetParam]);
  const effectiveIds = callerIds.length > 0 ? bridge.ids.filter((id) => callerIds.includes(id)) : bridge.ids;

  // Endpoint filters carry through unchanged EXCEPT the target id filter (injected per batch), per_page
  // (read-all owns the page size), and the cursor. The scope carriers were already stripped by
  // sanitizeReadParams.
  const endpointParams: Record<string, unknown> = { ...safeParams };
  delete endpointParams[spec.targetParam];
  delete endpointParams.per_page;
  delete endpointParams.cursor;
  // dropVectors are SCOPE-WIDENING parallel filters under a confirmed scope (only application_backed has
  // one: candidate_ids on /v3/notes,/v3/attachments — a candidate can have candidate-level rows on
  // applications outside the confirmed req). The bridge must only ever narrow within the scope, never
  // read by a parallel filter that could surface out-of-scope rows. (The scoped reader still bounds every
  // row to permitted jobs; this is the additional req-scope floor.)
  for (const vector of spec.dropVectors) delete endpointParams[vector];

  const aggregate = emptyRows();
  applyBridgeAccounting(aggregate, bridge);
  const statuses: ReadAllStatus[] = [bridge.status];
  let completedEndpointBatches = 0;

  for (const batch of chunks(effectiveIds, APPLICATION_ID_BATCH_SIZE)) {
    const read = await readAllScopedRows<Record<string, unknown>>(
      runtime,
      exposedToolName,
      adapter.scopedToolName,
      { ...endpointParams, [spec.targetParam]: batch.join(",") },
      deadline
    );
    if (read.kind === "denial") {
      // A truncation denial after a completed batch is an honest partial result, even when that batch
      // returned zero rows. A truncation in the first batch, or any non-truncation denial, hard-denies.
      const truncated = denialTruncationStatus(read.result);
      if (truncated && completedEndpointBatches > 0) {
        statuses.push(truncated);
        aggregate.warnings.push(`bridged endpoint read stopped after a later batch (${truncated})`);
        break;
      }
      return read;
    }
    mergeRows(aggregate, read);
    statuses.push(read.status);
    completedEndpointBatches += 1;
  }

  const combinedStatus = combineReadStatuses(statuses);
  aggregate.status = combinedStatus;
  aggregate.complete = combinedStatus === "complete";
  aggregate.paginationTruncated = !aggregate.complete;
  // The bridged read is NOT manually resumable by cursor: each batch's cursor is the pagination state
  // of one 25-id slice, and the bridge re-derives the target ids on every call (the raw cursor is
  // dropped above). Surfacing a batch cursor as "resumable" would be misleading, so never expose one —
  // an incomplete bridged read is recovered by re-running the scoped call (re-bridging), not by cursor
  // continuation. Completeness is still disclosed honestly via status + complete:false.
  aggregate.nextCursor = null;

  return { kind: "rows", rows: aggregate, bridge: buildBridgeEnvelope(spec, effectiveIds.length, bridge) };
}

// Build the honest bridge disclosure. application_ids keeps its original L1 field names (byte-for-byte);
// the R2 targets use generic, accurate names (their derivation is not an "application read" — interviews
// read interviews, the scorecard derive is a two-hop applications->scorecards read).
function buildBridgeEnvelope(spec: ScopeBridgeSpec, scopedCount: number, derive: JobScopeIdBridge): EvidenceBridgeEnvelope {
  if (spec.via === "application_ids") {
    return {
      bridged: true,
      via: "application_ids",
      basis: spec.basis,
      scoped_application_count: scopedCount,
      application_read_status: derive.status,
      application_read_complete: derive.complete,
    };
  }
  return {
    bridged: true,
    via: spec.via,
    basis: spec.basis,
    scoped_id_count: scopedCount,
    derive_read_status: derive.status,
    derive_read_complete: derive.complete,
  };
}

function buildScopeEnvelope(scope: { jobIds: number[] | null; header: ScopeHeader | null }): EvidenceScopeEnvelope {
  const header = scope.header;
  return {
    applied: true,
    ...(header?.source === "scope_handle" || header?.source === "exact_ids" ? { source: header.source } : {}),
    job_count: header?.job_count ?? scope.jobIds?.length ?? 0,
    ...(header?.scope_label !== undefined ? { scope_label: header.scope_label } : {}),
    ...(header?.scope_hash !== undefined ? { scope_hash: header.scope_hash } : {}),
    ...(header?.warnings && header.warnings.length > 0 ? { warnings: header.warnings } : {}),
  };
}

// Disclose an UNSCOPED bridgeable read (no confirmed scope -> spans all permitted jobs), never silently.
// application_ids keeps its exact L1 disclosure (byte-for-byte); the R2 classes get an analogous note
// keyed to their own target filter.
function unscopedBridgeableNote(safeParams: Record<string, unknown>, spec: ScopeBridgeSpec): EvidenceScopeEnvelope {
  if (spec.via === "application_ids") {
    return unscopedApplicationBackedNote(safeParams);
  }
  const hasRawTargetFilter = parseJobIdCsv(safeParams[spec.targetParam]).length > 0;
  return {
    applied: false,
    note: hasRawTargetFilter
      ? `No confirmed job scope was supplied; this read is bounded by the supplied ${spec.targetParam} (and your permitted jobs). Pass scope_handle (from resolve_job_scope/confirm_job_scope) or job_ids to scope to a requisition instead.`
      : `No confirmed job scope was supplied, so this read spans ${spec.spanNoun} across all of your permitted jobs. Pass scope_handle (from resolve_job_scope/confirm_job_scope) or job_ids to narrow it to a requisition.`,
  };
}

function unscopedApplicationBackedNote(safeParams: Record<string, unknown>): EvidenceScopeEnvelope {
  const hasRawApplicationFilter =
    parseJobIdCsv(safeParams.application_ids).length > 0 || parseJobIdCsv(safeParams.candidate_ids).length > 0;
  return {
    applied: false,
    note: hasRawApplicationFilter
      ? "No confirmed job scope was supplied; this read is bounded by the supplied application_ids/candidate_ids (and your permitted jobs). Pass scope_handle (from resolve_job_scope/confirm_job_scope) or job_ids to scope to a requisition instead."
      : "No confirmed job scope was supplied, so this application-backed read spans applications across all of your permitted jobs. Pass scope_handle (from resolve_job_scope/confirm_job_scope) or job_ids to narrow it to a requisition.",
  };
}


export function buildReadEnvelope(readAll: RowsResult): EvidenceReadEnvelope {
  const message = readStatusMessage(readAll.status);
  return {
    complete: readAll.complete,
    status: readAll.status,
    rows_returned: readAll.rowsReturnedRead ?? readAll.rows.length,
    raw_rows_read: readAll.rawRowsRead,
    permission_excluded: readAll.permissionExcluded,
    unresolved_scope_rows: readAll.unresolvedRows,
    pages_read: readAll.pagesRead,
    per_page: readAll.perPage,
    pagination_truncated: readAll.paginationTruncated,
    next_cursor: readAll.complete ? null : readAll.nextCursor,
    rate_limit_retries: readAll.rateLimitRetries,
    cache_hits: readAll.cacheHits,
    warnings: readAll.warnings,
    ...(message ? { message } : {}),
  };
}

function emptyRows(): RowsResult {
  return {
    kind: "rows",
    rows: [],
    rawRowsRead: 0,
    rowsReturnedRead: 0,
    permissionExcluded: 0,
    unresolvedRows: 0,
    pagesRead: 0,
    status: "complete",
    complete: true,
    paginationTruncated: false,
    nextCursor: null,
    perPage: 500,
    rateLimitRetries: 0,
    rateLimitSleepMs: 0,
    cacheHits: 0,
    warnings: [],
  };
}

function applyBridgeAccounting(
  aggregate: RowsResult,
  bridge: JobScopeIdBridge
): void {
  aggregate.rawRowsRead += bridge.rawRowsRead;
  aggregate.rowsReturnedRead = (aggregate.rowsReturnedRead ?? 0) + bridge.returnedRowsRead;
  aggregate.permissionExcluded += bridge.permissionExcluded;
  aggregate.unresolvedRows += bridge.unresolvedRows;
  aggregate.pagesRead += bridge.pagesRead;
  aggregate.rateLimitRetries += bridge.rateLimitRetries;
  aggregate.rateLimitSleepMs += bridge.rateLimitSleepMs;
  aggregate.cacheHits += bridge.cacheHits;
  aggregate.warnings.push(...bridge.warnings);
  aggregate.actorId = bridge.actorId;
  aggregate.effectiveActorId = bridge.effectiveActorId;
  aggregate.scoped = bridge.scoped;
  aggregate.permissionScope = bridge.permissionScope;
}

function mergeRows(aggregate: RowsResult, read: RowsResult): void {
  aggregate.rows.push(...read.rows);
  aggregate.rawRowsRead += read.rawRowsRead;
  aggregate.rowsReturnedRead = (aggregate.rowsReturnedRead ?? 0) + (read.rowsReturnedRead ?? read.rows.length);
  aggregate.permissionExcluded += read.permissionExcluded;
  aggregate.unresolvedRows += read.unresolvedRows;
  aggregate.pagesRead += read.pagesRead;
  aggregate.rateLimitRetries += read.rateLimitRetries;
  aggregate.rateLimitSleepMs += read.rateLimitSleepMs;
  aggregate.cacheHits += read.cacheHits;
  aggregate.warnings.push(...read.warnings);
  aggregate.nextCursor ??= read.nextCursor;
  aggregate.perPage = read.perPage;
  aggregate.actorId ??= read.actorId;
  aggregate.effectiveActorId ??= read.effectiveActorId;
  aggregate.scoped ??= read.scoped;
  aggregate.permissionScope ??= read.permissionScope;
}

function parseJobIdCsv(value: unknown): number[] {
  if (typeof value === "number") {
    return readPositiveInt(value) !== null ? [value] : [];
  }
  if (typeof value !== "string") return [];
  const ids: number[] = [];
  for (const token of value.split(",")) {
    const id = readPositiveInt(token.trim());
    if (id !== null) ids.push(id);
  }
  return ids;
}

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

function evidenceReadError(toolName: string, error: unknown): RecruiterToolResult {
  if (error instanceof IdentityResolutionError) {
    return deny(toolName, error.code, error.message);
  }
  if (isToolTimeoutError(error)) {
    return deny(toolName, "TOOL_TIMEOUT", "Scoped Greenhouse tool timed out before returning data.");
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("window exceeds") || message.includes("requires a valid window")) {
    return deny(toolName, "LIMIT_EXCEEDED", message);
  }
  return deny(toolName, "UPSTREAM_ERROR", classifyUpstreamError(error, "Scoped Greenhouse tool failed before returning data."));
}
