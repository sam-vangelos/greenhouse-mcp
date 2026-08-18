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
  /** Undefined means no allowlist; a configured allowlist is always non-empty and validated. */
  allowedTools?: Set<string>;
  /**
   * Names THIS SESSION is entitled to beyond the env allowlist — in Phase 2, the write plane's paired
   * `preview_…` / `apply_…` action tools for a recruiter who holds an entitlement. Grants are per session and
   * arrive from the entitlement store, so they are attached to an already-built config
   * (`{ ...toolConfig, grantedTools }`) rather than read from env here.
   *
   * ACTION TOOLS ONLY, and the type says so. A grant is not a general reopen-the-allowlist key: the 22
   * withheld source readers stay withheld for an entitled recruiter exactly as they do for everyone else.
   * `ActionToolName` (action-tools.ts) makes naming a read here a compile error, and both gates below
   * re-test the name at runtime, so a cast or a JSON-rehydrated grant cannot smuggle one through either.
   *
   * Strictly ADDITIVE by construction: a grant can only admit a name the allowlist would have rejected,
   * and every other gate — denylist, surface, kind — runs unchanged over it. That is what keeps the base
   * catalog byte-identical for a session with no grants, which two separate gates demand:
   * `toolCatalogCheck` 503s the whole service unless the env catalog resolves to the exact ordered base
   * list (readiness.ts:530-563), and `assertExactCatalog` fails the container self-check unless a
   * synthetic session holding no entitlement at all sees exactly that same list
   * (container-self-check.ts:71-80).
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

export const SCORECARD_ANALYSIS_READ_PARAM_NAMES = readParamNames(
  ...COMMON_PAGINATION_PARAM_NAMES,
  "job_ids",
  "created_at"
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

export function createRecruiterToolConfig(
  env: NodeJS.ProcessEnv = process.env,
  knownToolNames?: Iterable<string>
): RecruiterToolConfig {
  const config: RecruiterToolConfig = {
    serverDisabled: readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_MCP_DISABLED"),
    allowedTools: parseAllowedNameList(env.GREENHOUSE_RECRUITER_ALLOWED_TOOLS),
    disabledTools: parseNameList(env.GREENHOUSE_RECRUITER_DISABLE_TOOLS),
    evidenceToolsEnabled: !readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_DISABLE_EVIDENCE"),
    analyticalToolsEnabled: !readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_DISABLE_ANALYTICS"),
    claudeDesktopEnabled: !readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_DISABLE_CLAUDE_DESKTOP"),
    chatgptDesktopEnabled: !readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_DISABLE_CHATGPT_DESKTOP"),
    operatorUnscopedEnabled: !readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_DISABLE_OPERATOR_UNSCOPED"),
  };
  if (knownToolNames) validateRecruiterToolConfig(config, knownToolNames);
  return config;
}

export function validateRecruiterToolConfig(
  config: RecruiterToolConfig,
  knownToolNames: Iterable<string>
): void {
  if (!config.allowedTools) return;
  const known = new Set(knownToolNames);
  // A granted name counts as known. Every caller passes the READ catalog (server.ts:100 and
  // register.ts:197 both pass RECRUITER_TOOL_DEFINITIONS), so once a session's action grants are merged
  // into its allowlist, an unmodified check here would reject every one of them as an unknown tool. This
  // runs on the request path — twice per request, at server.ts:100 via createRecruiterToolConfig and
  // again at register.ts:197 — and a throw there is caught by the outer handler and returned as an opaque
  // 500 "Internal server error" (http-server.ts:90-99), i.e. the write plane would take down the read
  // plane with an unreadable error. Env misconfiguration must still fail loudly; a name this session was
  // actually granted is not misconfiguration.
  //
  // Note the ordering constraint this does NOT solve: grants are attached after the config is built, so
  // the validation inside createRecruiterToolConfig (:230) sees `grantedTools` undefined. An action name
  // routed through GREENHOUSE_RECRUITER_ALLOWED_TOOLS therefore still throws there, by design — the env
  // allowlist governs the base catalog, and per-session entitlement belongs on the config object.
  const unknown = [...config.allowedTools].filter((name) => !known.has(name) && !isGrantedActionTool(config, name));
  if (unknown.length > 0) {
    throw new Error(`GREENHOUSE_RECRUITER_ALLOWED_TOOLS contains unknown tool name(s): ${unknown.join(", ")}.`);
  }
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
 * NOT AN ENTITLEMENT CHECK, and Phase 2 must not use it as one. This predicate FAILS OPEN when no
 * allowlist is configured: `config.allowedTools` being undefined short-circuits the only name-membership
 * test below, so every name reaching it enables — including a name that no catalog defines and that this
 * session was never granted. Production always configures the allowlist (`toolCatalogCheck` 503s the
 * service otherwise, readiness.ts:530-563), but nothing else has to: runtime.ts:93 builds a config from
 * `{}` for every runtime assembled without one, and probe.ts:115 erases the allowlist it just parsed.
 *
 * So an action tool's REGISTRATION must go through `isActionToolGranted` below, which tests grant
 * membership directly and can therefore never inherit this fail-open. The grant lookup here only reopens
 * the allowlist door for a name it would otherwise have closed; it proves nothing about whether the
 * caller may write.
 */
export function isToolEnabled(
  config: RecruiterToolConfig,
  surface: RecruiterSurface,
  name: string,
  kind: RecruiterToolKind
): boolean {
  if (config.serverDisabled) return false;
  // A grant admits an ACTION name past the allowlist and does nothing else — it is consulted here and by
  // no gate after it, so the denylist immediately below still wins over a grant, and a granted name is
  // filtered by surface and kind exactly like an allowlisted one. A withheld read is not admissible on
  // this path at all: `isGrantedActionTool` rejects the name's shape before the set is ever consulted.
  if (config.allowedTools && !config.allowedTools.has(name) && !isGrantedActionTool(config, name)) return false;
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
 * `isToolEnabled`, and deliberately sitting next to it so the contrast is unmissable: this one has no
 * allowlist branch to short-circuit, so there is no configuration — hosted, local, probe, or a runtime
 * assembled from `{}` — in which a session without a grant sees an action tool.
 *
 * Reading the gates in order: an explicit grant is REQUIRED (never optional, never inferred), the
 * server kill switch and the operator denylist both still win, and a surface an operator has switched
 * off receives nothing. The read-plane category switches (`evidence`, `analysis`) are intentionally not
 * consulted — an action tool is neither, and disabling the analyzers says nothing about writes.
 *
 * What this does NOT decide is whether a mutation may proceed. Catalog visibility and apply
 * authorization are different questions with different freshness requirements; the second is re-read
 * atomically at apply time through the action plane's own store (see action-entitlement.ts's module
 * comment).
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
    if (isIdentityParamName(key)) {
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

function parseAllowedNameList(raw: string | undefined): Set<string> | undefined {
  if (raw === undefined) return undefined;
  const tokens = raw.split(",").map((token) => token.trim());
  if (tokens.length === 0 || tokens.some((token) => token.length === 0 || !/^[a-z][a-z0-9_]*$/.test(token))) {
    throw new Error("GREENHOUSE_RECRUITER_ALLOWED_TOOLS must be a non-empty comma-separated list of tool names.");
  }
  const allowed = new Set(tokens);
  if (allowed.size !== tokens.length) {
    throw new Error("GREENHOUSE_RECRUITER_ALLOWED_TOOLS must not contain duplicate tool names.");
  }
  return allowed;
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
