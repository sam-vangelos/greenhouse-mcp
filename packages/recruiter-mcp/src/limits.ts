import type { RecruiterSurface, RecruiterToolKind } from "./types.js";
import { isActionToolName, type ActionToolName } from "./action-tools.js";
import { readBooleanEnvFlag } from "./env.js";

export interface RecruiterToolLimits {
  maxPerPage: number;
  defaultPerPage: number;
  maxLookbackDays: number;
  maxRankings: number;
  maxEvidenceIds: number;
  // Per-scoped-READ timeout: the guard against a single hung Greenhouse API call. NOT the whole-
  // analysis budget — a multi-page analysis must not be capped at one call's timeout.
  maxToolDurationMs: number;
  // Whole-ANALYSIS budget: how long a recipe may spend reading its full cohort across many pages before
  // it self-truncates honestly (createToolDeadline). Decoupled from maxToolDurationMs so a big req is
  // read comprehensively, not clipped to a single read's timeout. Optional so test/literal limits fall
  // back to maxToolDurationMs; the hosted runtime always sets it (createRecruiterToolLimits).
  maxAnalysisDurationMs?: number;
}

export interface RecruiterToolConfig {
  serverDisabled: boolean;
  /**
   * The WRITE-PLANE names this session is entitled to — the paired `preview_…` / `apply_…` action tools
   * for a recruiter who holds an entitlement. Grants are per session and arrive from the entitlement
   * store, so they are attached to an already-built config (`{ ...toolConfig, grantedTools }`) rather
   * than read from env here.
   *
   * ACTION TOOLS ONLY, and the type says so. `ActionToolName` (action-tools.ts) makes naming a read here
   * a compile error, and `isActionToolGranted` re-tests the name's shape at runtime, so a cast or a
   * JSON-rehydrated grant cannot smuggle a read tool onto the write path. (Reads need no grant at all:
   * every registered reader mounts for every session — see tools/catalog-order.ts.)
   *
   * Strictly ADDITIVE: the read catalog of a session with no grants is byte-identical to before, which
   * two gates demand — `toolCatalogCheck` 503s the service unless the mounted catalog is the exact
   * ordered read list (readiness.ts), and `assertExactCatalog` fails the container self-check unless a
   * synthetic session holding no entitlement sees exactly that same list (container-self-check.ts).
   */
  grantedTools?: ReadonlySet<ActionToolName>;
  disabledTools: Set<string>;
  evidenceToolsEnabled: boolean;
  analyticalToolsEnabled: boolean;
  claudeDesktopEnabled: boolean;
  chatgptDesktopEnabled: boolean;
  operatorUnscopedEnabled: boolean;
}

export interface SanitizeReadParamsOptions {
  allowedParamNames?: ReadonlySet<string>;
  /**
   * The Harvest endpoint this read targets, so a documented query filter whose NAME collides with an
   * actor-identity parameter is kept instead of dropped (see ENDPOINT_QUERY_FILTER_PARAMS).
   */
  endpointPath?: string;
}

/**
 * Documented endpoint filters that share a name with an actor-identity parameter.
 *
 * `isIdentityParamName` drops `email` everywhere, because naming the actor in params is how a caller
 * would try to read as someone else — and the actor comes from the session, never from params. On
 * these two endpoints `email` is the endpoint's own filter over its own rows, and dropping it made
 * two tools lie: `search_my_user_emails` returned the whole staff directory to an admin who asked
 * for one colleague, and `search_my_candidates` — whose description says "Filter by email to find a
 * specific person" — ignored the filter entirely. Mirrors the same exact-pair exemption at the
 * scoped-reader boundary, which is the security boundary and enforces it independently.
 */
const ENDPOINT_QUERY_FILTER_PARAMS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["/v3/user_emails", new Set(["email"])],
  ["/v3/candidates", new Set(["email"])],
]);

export function isEndpointQueryFilterParam(endpointPath: string | undefined, key: string): boolean {
  return endpointPath !== undefined && (ENDPOINT_QUERY_FILTER_PARAMS.get(endpointPath)?.has(key) ?? false);
}

export interface AnalysisWindow {
  windowStart: string;
  windowEnd: string;
}

export const HARD_MAX_TOOL_DURATION_MS = 30_000;
export const HARD_MAX_ANALYSIS_DURATION_MS = 120_000;

const COMMON_PAGINATION_PARAM_NAMES = ["cursor", "per_page"] as const;
const MAX_READ_PARAM_STRING_LENGTH = 2048;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const MAX_ANALYSIS_WINDOW_DATE_LENGTH = 64;
const ISO_LIKE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:$|T)/;
const INVALID_ANALYSIS_WINDOW_MESSAGE = "Analysis requires a valid window_start and window_end.";
const POSITIVE_ID_PARAM_NAMES = new Set([
  "id",
  "ids",
  "job_ids",
  "application_ids",
  "candidate_ids",
  "stage_ids",
  "job_interview_ids",
  "job_interview_stage_ids",
  "rejection_reason_ids",
  "source_ids",
  "referrer_ids",
  "job_board_ids",
  "job_post_ids",
]);

export const EVIDENCE_SEARCH_READ_PARAM_NAMES = readParamNames(
  ...COMMON_PAGINATION_PARAM_NAMES,
  "ids",
  "job_ids",
  "application_ids",
  "candidate_ids",
  "stage_ids",
  "job_interview_ids",
  "job_interview_stage_ids",
  "rejection_reason_ids",
  "source_ids",
  "referrer_ids",
  "job_board_ids",
  "job_post_ids",
  "stage_name",
  "status",
  "active",
  "current",
  "open",
  "opened_at",
  "closed_at",
  "starts_at",
  "ends_at",
  "scheduling_type",
  "created_at",
  "updated_at"
);

// v3 GET /application_stages supports ONLY these filters beyond pagination:
// application_ids, job_interview_stage_ids, current, plus the universal
// created_at/updated_at date filters. It does NOT support status/active/open/
// stage_name/scheduling_type — those must be stripped before the scoped read.
export const EVIDENCE_APPLICATION_STAGES_READ_PARAM_NAMES = readParamNames(
  ...COMMON_PAGINATION_PARAM_NAMES,
  "application_ids",
  "job_interview_stage_ids",
  "current",
  "created_at",
  "updated_at"
);

export const EVIDENCE_GET_READ_PARAM_NAMES = readParamNames(
  ...COMMON_PAGINATION_PARAM_NAMES,
  "id"
);

// interviewed_at / submitted_at are the basis the scorecard recipes actually analyse on, and
// /v3/scorecards accepts both as server-side range filters (harvest-v3-registry.generated.ts,
// /v3/scorecards). A bracket key (interviewed_at[gte]) is admitted by sanitizeReadParams against its
// base name below. created_at stays admitted so a caller can still filter on it explicitly; the
// recipes no longer send it as a window floor.
export const SCORECARD_ANALYSIS_READ_PARAM_NAMES = readParamNames(
  ...COMMON_PAGINATION_PARAM_NAMES,
  "job_ids",
  "created_at",
  "interviewed_at",
  "submitted_at"
);

/**
 * The hire read's own filters on /v3/offers. `sanitizeReadParams` drops an unlisted param SILENTLY,
 * so a hire read that asked for `status=Accepted&current_only=true` without this set would have
 * become an unfiltered read of every offer version in the permitted scope — the same number,
 * silently wrong. Every name here is on the vendored /v3/offers contract
 * (harvest-v3-registry.generated.ts, /v3/offers): `current_only` collapses the version chain to the
 * latest row per application, `status` is the {Created,Accepted,Rejected,Deprecated} enum, and
 * `resolved_at` / `sent_on` / `starts_on` are its range filters (admitted here as base names; the
 * bracket forms are matched against them).
 */
export const HIRE_FACTS_OFFER_READ_PARAM_NAMES = readParamNames(
  ...COMMON_PAGINATION_PARAM_NAMES,
  "ids",
  "job_ids",
  "application_ids",
  "candidate_ids",
  "opening_ids",
  "status",
  "current_only",
  "resolved_at",
  "sent_on",
  "starts_on"
);

/**
 * The reconciliation line's filters on /v3/openings: `open=false` plus a `closed_at` range and, when
 * the caller already knows the hire close reasons, `close_reason_ids`. Same silent-drop hazard as
 * above — `open` and `closed_at` reach the evidence search set but no ANALYSIS set carried them.
 */
export const HIRE_FACTS_OPENING_READ_PARAM_NAMES = readParamNames(
  ...COMMON_PAGINATION_PARAM_NAMES,
  "ids",
  "job_ids",
  "open",
  "opened_at",
  "closed_at",
  "close_reason_ids"
);

/**
 * The id-bridge reads the hire path makes to put names and application status beside a hire:
 * /v3/candidates?ids= and /v3/applications?ids=, in 50-id chunks. Nothing but the id filter and
 * pagination — a bridge read is a lookup of rows the caller already holds ids for, and any other
 * filter on it would narrow a set that is already exactly bounded.
 */
export const HIRE_FACTS_ID_BRIDGE_READ_PARAM_NAMES = readParamNames(
  ...COMMON_PAGINATION_PARAM_NAMES,
  "ids"
);

export const REJECTION_REASON_DRIFT_READ_PARAM_NAMES = readParamNames(
  ...COMMON_PAGINATION_PARAM_NAMES,
  "job_ids",
  "created_at"
);

export const APPLICATION_ANALYSIS_READ_PARAM_NAMES = readParamNames(
  ...COMMON_PAGINATION_PARAM_NAMES,
  "job_ids",
  "status"
);

export const SOURCE_QUALITY_APPLICATION_READ_PARAM_NAMES = readParamNames(
  ...COMMON_PAGINATION_PARAM_NAMES,
  "job_ids",
  "source_ids",
  "referrer_ids",
  "status"
);

const IDENTITY_PARAM_NAMES = new Set([
  "actor_id",
  "actorId",
  "actAsUser",
  "actAsUserId",
  "act_as_user",
  "act_as_user_id",
  "on_behalf_of_user_id",
  "user_id",
  "userId",
  "greenhouse_user_id",
  "greenhouseUserId",
  "greenhouseUserID",
  "email",
  "work_email",
  "workEmail",
  "user_email",
  "userEmail",
  "recruiter_email",
  "recruiterEmail",
  "authenticated_email",
  "authenticatedEmail",
  "subject",
  "session_subject",
  "sessionSubject",
  "sub",
]);

const NORMALIZED_IDENTITY_PARAM_NAMES = new Set(
  Array.from(IDENTITY_PARAM_NAMES, normalizeParamName)
);

export const DEFAULT_LIMITS: RecruiterToolLimits = {
  // v3 supports per_page up to 500; reading at full page size cuts pages ~5x (ledger #20).
  maxPerPage: 500,
  defaultPerPage: 500,
  // 365-day lookback: the cap is applied in-memory after a full read, so it guards no API cost;
  // 180 denied year-long questions for nothing (ledger #40). Still bounded to avoid unbounded windows.
  maxLookbackDays: 365,
  maxRankings: 25,
  // Evidence-id lists are sliced in-memory from already-read rows (zero API cost). 200 is generous
  // (was a hard 25 per entry / 50 per headline that silently cut "give me every backing id"), and
  // env-overridable. The per-call full-set path for a caller is the un-floored evidence_pack
  // (evidence_pack_limit), which returns the complete id set with its own truncated flag.
  maxEvidenceIds: 200,
  // Per-READ guard only (one Greenhouse call). A single page/read rarely exceeds a few seconds; 30s is
  // a generous hung-call ceiling. This is deliberately NOT the analysis budget (see below).
  maxToolDurationMs: HARD_MAX_TOOL_DURATION_MS,
  // Whole-analysis/front-door budget. Keep it comfortably below client transport ceilings so an
  // honest incomplete result reaches the caller instead of becoming dead air.
  maxAnalysisDurationMs: HARD_MAX_ANALYSIS_DURATION_MS,
};

const LIMIT_ENV_NAMES = {
  maxPerPage: "GREENHOUSE_RECRUITER_MAX_PER_PAGE",
  defaultPerPage: "GREENHOUSE_RECRUITER_DEFAULT_PER_PAGE",
  maxLookbackDays: "GREENHOUSE_RECRUITER_MAX_LOOKBACK_DAYS",
  maxRankings: "GREENHOUSE_RECRUITER_MAX_RANKINGS",
  maxEvidenceIds: "GREENHOUSE_RECRUITER_MAX_EVIDENCE_IDS",
  maxToolDurationMs: "GREENHOUSE_RECRUITER_MAX_TOOL_DURATION_MS",
  maxAnalysisDurationMs: "GREENHOUSE_RECRUITER_MAX_ANALYSIS_DURATION_MS",
} as const satisfies Record<keyof RecruiterToolLimits, string>;

/**
 * R2a deleted `GREENHOUSE_RECRUITER_ALLOWED_TOOLS`. It was never a control — it failed OPEN when
 * unset — and it was the only thing hiding 22 built, tested readers behind a count with no reason.
 * What remains are gates that name what they remove: the server kill switch, the per-tool denylist
 * `GREENHOUSE_RECRUITER_DISABLE_TOOLS`, the two surface switches and the two category switches.
 * Setting the old variable now does nothing; it is not read anywhere.
 */
export function createRecruiterToolConfig(
  env: NodeJS.ProcessEnv = process.env
): RecruiterToolConfig {
  const config: RecruiterToolConfig = {
    serverDisabled: readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_MCP_DISABLED"),
    disabledTools: parseNameList(env.GREENHOUSE_RECRUITER_DISABLE_TOOLS),
    evidenceToolsEnabled: !readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_DISABLE_EVIDENCE"),
    analyticalToolsEnabled: !readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_DISABLE_ANALYTICS"),
    claudeDesktopEnabled: !readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_DISABLE_CLAUDE_DESKTOP"),
    chatgptDesktopEnabled: !readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_DISABLE_CHATGPT_DESKTOP"),
    operatorUnscopedEnabled: !readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_DISABLE_OPERATOR_UNSCOPED"),
  };
  return config;
}

export function createRecruiterToolLimits(
  env: NodeJS.ProcessEnv = process.env
): RecruiterToolLimits {
  validateRecruiterToolLimitEnv(env);
  return {
    maxPerPage: readPositiveInt(env.GREENHOUSE_RECRUITER_MAX_PER_PAGE) ?? DEFAULT_LIMITS.maxPerPage,
    defaultPerPage: readPositiveInt(env.GREENHOUSE_RECRUITER_DEFAULT_PER_PAGE) ?? DEFAULT_LIMITS.defaultPerPage,
    maxLookbackDays: readPositiveInt(env.GREENHOUSE_RECRUITER_MAX_LOOKBACK_DAYS) ?? DEFAULT_LIMITS.maxLookbackDays,
    maxRankings: readPositiveInt(env.GREENHOUSE_RECRUITER_MAX_RANKINGS) ?? DEFAULT_LIMITS.maxRankings,
    maxEvidenceIds: readPositiveInt(env.GREENHOUSE_RECRUITER_MAX_EVIDENCE_IDS) ?? DEFAULT_LIMITS.maxEvidenceIds,
    maxToolDurationMs: Math.min(
      readPositiveInt(env.GREENHOUSE_RECRUITER_MAX_TOOL_DURATION_MS) ?? HARD_MAX_TOOL_DURATION_MS,
      HARD_MAX_TOOL_DURATION_MS
    ),
    maxAnalysisDurationMs: Math.min(
      readPositiveInt(env.GREENHOUSE_RECRUITER_MAX_ANALYSIS_DURATION_MS) ?? HARD_MAX_ANALYSIS_DURATION_MS,
      HARD_MAX_ANALYSIS_DURATION_MS
    ),
  };
}

export function validateRecruiterToolLimitEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of Object.values(LIMIT_ENV_NAMES)) {
    const raw = env[name];
    if (raw === undefined || raw.trim().length === 0) continue;
    if (readPositiveInt(raw) === null) {
      throw new Error(`${name} must be a positive integer.`);
    }
  }
}

/**
 * The one place a grant is looked up, so the two conditions that make a grant safe are enforced once:
 * the name must be shaped like an action tool at RUNTIME (not merely typed as one — a cast, a JS
 * caller, or a grant rehydrated from JSON all reach here with a plain string), and the set must
 * actually carry it. Everything else about a granted name is decided by the gates that call this.
 */
function isGrantedActionTool(config: RecruiterToolConfig, name: string): boolean {
  return isActionToolName(name) && config.grantedTools?.has(name) === true;
}

/**
 * NOT AN ENTITLEMENT CHECK, and nothing may use it as one. It answers a narrower question: has an
 * operator switched this READ tool, this surface, or this category off? Every name that reaches it and
 * is not switched off enables — including a name no catalog defines. That is correct for reads (the
 * catalog is the registrar's own definition list, tools/catalog-order.ts) and useless as a write gate.
 *
 * So an action tool's REGISTRATION goes through `isActionToolGranted` below, which tests grant
 * membership directly and therefore cannot inherit this permissiveness.
 */
export function isToolEnabled(
  config: RecruiterToolConfig,
  surface: RecruiterSurface,
  name: string,
  kind: RecruiterToolKind
): boolean {
  if (config.serverDisabled) return false;
  if (config.disabledTools.has(name)) return false;
  if (surface === "claude_desktop" && !config.claudeDesktopEnabled) {
    return false;
  }
  if (surface === "chatgpt_desktop" && !config.chatgptDesktopEnabled) {
    return false;
  }
  if (kind === "evidence" && !config.evidenceToolsEnabled) {
    return false;
  }
  if (kind === "analysis" && !config.analyticalToolsEnabled) {
    return false;
  }
  return true;
}

/**
 * THE gate for registering a write-plane tool. Deliberately not implemented in terms of
 * `isToolEnabled`, and deliberately sitting next to it so the contrast is unmissable: reads mount
 * unless an operator removed them, writes mount only on an explicit grant. There is no configuration —
 * hosted, local, probe, or a runtime assembled from `{}` — in which a session without a grant sees an
 * action tool.
 *
 * Reading the gates in order: an explicit grant is REQUIRED (never optional, never inferred), the
 * server kill switch and the operator denylist both still win, and a surface an operator has switched
 * off receives nothing. The read-plane category switches (`evidence`, `analysis`) are intentionally not
 * consulted — an action tool is neither, and disabling the analyzers says nothing about writes.
 *
 * What this does NOT decide is whether a mutation may proceed. Catalog visibility and apply
 * authorization are different questions with different freshness requirements; the second is re-read
 * atomically at apply time through the action plane's own store.
 */
export function isActionToolGranted(
  config: RecruiterToolConfig,
  surface: RecruiterSurface,
  name: string
): boolean {
  if (config.serverDisabled) return false;
  if (!isGrantedActionTool(config, name)) return false;
  if (config.disabledTools.has(name)) return false;
  if (surface === "claude_desktop" && !config.claudeDesktopEnabled) return false;
  if (surface === "chatgpt_desktop" && !config.chatgptDesktopEnabled) return false;
  return true;
}

export function sanitizeReadParams(
  params: Record<string, unknown>,
  limits: RecruiterToolLimits,
  options: SanitizeReadParamsOptions = {}
): Record<string, string | number | boolean | undefined> {
  const safe: Record<string, string | number | boolean | undefined> = {};
  const allowedParamNames = options.allowedParamNames;
  for (const [key, value] of Object.entries(params)) {
    if (isIdentityParamName(key) && !isEndpointQueryFilterParam(options.endpointPath, key)) {
      continue;
    }
    // v3 range filters arrive as bracket params (resolved_at[gte]=...) after translation; a
    // bracket key is allowed exactly when its BASE param is an allowed endpoint param.
    const rangeBaseKey = key.replace(/\[(gte|lte|gt|lt)\]$/, "");
    if (allowedParamNames && !allowedParamNames.has(key) && !allowedParamNames.has(rangeBaseKey)) {
      continue;
    }
    if (typeof value === "string") {
      const safeString = POSITIVE_ID_PARAM_NAMES.has(key)
        ? sanitizePositiveIdParamString(value)
        : sanitizeReadParamString(value);
      if (safeString !== undefined) safe[key] = safeString;
    } else if (typeof value === "number") {
      const minimum = POSITIVE_ID_PARAM_NAMES.has(key) ? 1 : 0;
      if (Number.isSafeInteger(value) && value >= minimum) safe[key] = value;
    } else if (value === undefined || typeof value === "boolean") {
      safe[key] = value;
    }
  }
  const cursorValue = typeof safe.cursor === "string" && safe.cursor.length > 0 ? safe.cursor : undefined;
  if (cursorValue !== undefined) {
    // Greenhouse v3 requires a cursor request to carry the cursor as its ONLY
    // query parameter — the original filters and page size are encoded in the
    // cursor itself. Injecting per_page (or carrying any other param) alongside
    // it collides at the raw reader ("Cannot combine cursor with other
    // parameters"), which surfaces as UPSTREAM_ERROR and breaks pagination past
    // page 1 for every list_* tool (and silently truncates paginating recipes).
    // So a cursor read passes through the cursor alone.
    return { cursor: cursorValue };
  }
  if (!allowedParamNames || allowedParamNames.has("per_page")) {
    const requestedPerPage = readPositiveInt(safe.per_page);
    safe.per_page = Math.min(requestedPerPage ?? limits.defaultPerPage, limits.maxPerPage);
  }
  return safe;
}

function readParamNames(...names: string[]): ReadonlySet<string> {
  return new Set(names);
}

export function isIdentityParamName(key: string): boolean {
  return IDENTITY_PARAM_NAMES.has(key) || NORMALIZED_IDENTITY_PARAM_NAMES.has(normalizeParamName(key));
}

function normalizeParamName(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sanitizeReadParamString(value: string): string | undefined {
  if (value.length === 0) return undefined;
  if (value.length > MAX_READ_PARAM_STRING_LENGTH) return undefined;
  if (value.trim() !== value) return undefined;
  if (CONTROL_CHARACTER_PATTERN.test(value)) return undefined;
  return value;
}

function sanitizePositiveIdParamString(value: string): string | undefined {
  const safeString = sanitizeReadParamString(value);
  if (safeString === undefined) return undefined;
  const normalizedIds: string[] = [];
  for (const token of safeString.split(",")) {
    const normalizedToken = token.trim();
    if (normalizedToken.length === 0) return undefined;
    const parsed = readPositiveInt(normalizedToken);
    if (parsed === null) return undefined;
    normalizedIds.push(String(parsed));
  }
  return normalizedIds.length > 0 ? normalizedIds.join(",") : undefined;
}

function readAnalysisWindowDate(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(INVALID_ANALYSIS_WINDOW_MESSAGE);
  }
  if (
    value.length === 0 ||
    value.length > MAX_ANALYSIS_WINDOW_DATE_LENGTH ||
    value.trim() !== value ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    !ISO_LIKE_DATE_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(INVALID_ANALYSIS_WINDOW_MESSAGE);
  }
  return value;
}

const WINDOW_ORDER_MESSAGE = "Analysis window_start must be on or before window_end.";

/**
 * The ONE window validator, for every path that accepts explicit bounds.
 *
 * The recipes have always run every present bound through `readAnalysisWindowDate` (strict ISO
 * shape, no control characters, parses) and then through an ordering check. The planned-domain
 * path did neither: it tested key PRESENCE and parsed with a bare `Date.parse`, so `window_start:
 * ""` suppressed the sentence's own window and answered ALL TIME, `"0"` was read as the year 2000
 * under an ISO contract, and a start after an end came back as a confident, complete zero. Which
 * answer a caller got depended on which path their question routed to, which is not a contract.
 *
 * Returns the message to deny with, or null when every present bound is usable. Absent bounds are
 * absent — a one-sided window stays one-sided rather than becoming an error.
 */
export function explicitAnalysisWindowError(params: Record<string, unknown>): string | null {
  let start: string | null;
  let end: string | null;
  try {
    start = readAnalysisWindowDate(params.window_start);
    end = readAnalysisWindowDate(params.window_end);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (start !== null && end !== null && Date.parse(start) > Date.parse(end)) return WINDOW_ORDER_MESSAGE;
  return null;
}

/**
 * True when the caller supplied BOTH window bounds explicitly. An explicit window runs free of
 * maxLookbackDays (the 9179880 pattern: explicit values run past defaults) — the cap is applied
 * in-memory after a full read, so it guards no API cost; it exists only to bound the FUZZY default
 * window, not to deny a deliberate year-plus question.
 */
export function hasExplicitAnalysisWindow(params: Record<string, unknown>): boolean {
  return readAnalysisWindowDate(params.window_start) !== null && readAnalysisWindowDate(params.window_end) !== null;
}

export function assertWindowWithinLimit(
  startIso: string,
  endIso: string,
  limits: RecruiterToolLimits
): void {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    throw new Error(INVALID_ANALYSIS_WINDOW_MESSAGE);
  }
  const days = (end - start) / (24 * 60 * 60 * 1000);
  if (days > limits.maxLookbackDays) {
    throw new Error(`Analysis window exceeds ${limits.maxLookbackDays} days.`);
  }
}

export function resolveAnalysisWindow(
  params: Record<string, unknown>,
  now: () => number,
  defaultLookbackDays: number
): AnalysisWindow {
  const fallbackEnd = new Date(now()).toISOString();
  const end = readAnalysisWindowDate(params.window_end) ?? fallbackEnd;
  const endMs = Date.parse(end);
  if (!Number.isFinite(endMs)) {
    throw new Error(INVALID_ANALYSIS_WINDOW_MESSAGE);
  }

  const fallbackStart = new Date(endMs - defaultLookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const start = readAnalysisWindowDate(params.window_start) ?? fallbackStart;
  const startMs = Date.parse(start);
  if (!Number.isFinite(startMs) || startMs > endMs) {
    throw new Error(INVALID_ANALYSIS_WINDOW_MESSAGE);
  }

  return { windowStart: start, windowEnd: end };
}

function parseNameList(raw: string | undefined): Set<string> {
  if (!raw) return new Set<string>();
  return new Set(raw.split(",").map((token) => token.trim()).filter(Boolean));
}

export function readPositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return parsed > 0 && Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

export function readNonNegativeFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (
    typeof value === "string" &&
    value.trim() === value &&
    value.length <= 64 &&
    /^\d+(\.\d+)?$/.test(value)
  ) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}
