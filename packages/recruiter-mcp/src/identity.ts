import { createHash } from "node:crypto";
import type { ActorResolver } from "../../scoped-core/src/index.js";
import type { AuthenticatedSession } from "./types.js";
import { DEFAULT_EXTERNAL_LOOKUP_TIMEOUT_MS, fetchWithTimeout, readLookupTimeoutMs } from "./fetch-timeout.js";
import { readRecruiterStateBackend } from "./state-backend.js";
import { assertCanonicalSupabaseProjectRef, normalizeOptionalSupabaseIdentifier, normalizeSupabaseApiKey, normalizeSupabaseIdentifier, normalizeSupabaseRestOrigin } from "./supabase-config.js";

export type IdentityResolution =
  // `identityId` is the directory row's own uuid primary key (migrations/0001:7). It is OPTIONAL
  // and purely additive: the read plane authorizes on `greenhouseUserId` alone and must keep
  // resolving exactly as it did when the column is absent, unreadable, or inconsistent across the
  // matched rows. The action plane's entitlement row is keyed on BOTH ids
  // (action-mcp/src/store.ts:105-118), so it is the one caller that needs this — and it treats a
  // missing `identityId` as a denial rather than resolving without one.
  | { status: "resolved"; greenhouseUserId: number; identityId?: string }
  | { status: "unresolved"; reason: string }
  | { status: "ambiguous"; greenhouseUserIds: number[]; reason: string }
  | { status: "invalid"; reason: string };

/** Both ids the action plane's entitlement row is keyed on. Neither is optional here. */
export interface ResolvedActionIdentity {
  identityId: string;
  greenhouseUserId: number;
}

export type ActionIdentityDenialCode =
  | "IDENTITY_NOT_RESOLVED"
  | "IDENTITY_AMBIGUOUS"
  | "IDENTITY_INVALID"
  | "IDENTITY_ID_UNAVAILABLE";

export type ActionIdentityResolution =
  | { status: "resolved"; identity: ResolvedActionIdentity }
  | { status: "denied"; code: ActionIdentityDenialCode; reason: string };

export interface IdentityDirectory {
  resolve(session: AuthenticatedSession): Promise<IdentityResolution> | IdentityResolution;
}

export interface SupabaseIdentityDirectoryConfig {
  supabaseUrl: string;
  apiKey: string;
  table?: string;
  columns?: Partial<SupabaseIdentityColumns>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface SupabaseIdentityColumns {
  greenhouseUserId: string;
  directoryId: string;
  email: string;
  subject: string;
  status: string;
  resolvedStatus: string;
}

const DEFAULT_SUPABASE_IDENTITY_COLUMNS: SupabaseIdentityColumns = {
  greenhouseUserId: "greenhouse_user_id",
  // The directory row's uuid primary key. Selecting it adds one column to the live identity
  // request, which is safe because the column provably exists on the table this server reads:
  // it is the `id uuid primary key` of supabase/migrations/0001_recruiter_identity_directory.sql,
  // and the action plane already selects it from the same table (action-mcp/src/store.ts:96-104).
  directoryId: "id",
  email: "primary_email",
  subject: "google_subject",
  status: "status",
  resolvedStatus: "resolved",
};

export class IdentityResolutionError extends Error {
  code: "IDENTITY_NOT_RESOLVED" | "IDENTITY_AMBIGUOUS" | "IDENTITY_INVALID";
  greenhouseUserIds?: number[];

  constructor(
    code: "IDENTITY_NOT_RESOLVED" | "IDENTITY_AMBIGUOUS" | "IDENTITY_INVALID",
    message: string,
    greenhouseUserIds?: number[]
  ) {
    super(message);
    this.name = "IdentityResolutionError";
    this.code = code;
    this.greenhouseUserIds = greenhouseUserIds;
  }
}

export function createIdentityActorResolver(
  directory: IdentityDirectory
): ActorResolver<AuthenticatedSession> {
  return {
    async resolveActor(session) {
      const result = await directory.resolve(session);
      if (result.status === "resolved") {
        if (!isSafePositiveGreenhouseUserId(result.greenhouseUserId)) {
          throw new IdentityResolutionError(
            "IDENTITY_INVALID",
            "Identity directory returned an invalid Greenhouse user id."
          );
        }
        return result.greenhouseUserId;
      }
      if (result.status === "ambiguous") {
        throw new IdentityResolutionError(
          "IDENTITY_AMBIGUOUS",
          result.reason,
          result.greenhouseUserIds
        );
      }
      if (result.status === "invalid") {
        throw new IdentityResolutionError("IDENTITY_INVALID", result.reason);
      }
      throw new IdentityResolutionError("IDENTITY_NOT_RESOLVED", result.reason);
    },
  };
}

/**
 * Resolve BOTH ids the action plane's entitlement row is keyed on, or say why it cannot.
 *
 * This is the same directory read the read plane already performs — it does not widen the
 * lookup, add a second source, or accept anything `createIdentityActorResolver` would reject.
 * The difference is only in what it demands back: the read plane authorizes on a Greenhouse
 * user id alone, while `greenhouse_action_entitlement` is keyed on (identity_id, client) and
 * filtered on greenhouse_user_id too (action-mcp/src/store.ts:105-118), so an actor without a
 * directory uuid cannot be matched to an entitlement row at all.
 *
 * Every non-resolved outcome is a denial, and it returns rather than throws because its caller
 * is deciding CATALOG VISIBILITY: a recruiter with no write entitlement must still get their
 * 44 read tools, not an exception. `IDENTITY_AMBIGUOUS` stays exactly as hard a denial as it is
 * on the read path — multiple mapped Greenhouse ids never resolve to an actor here either.
 */
export async function resolveActionIdentity(
  directory: IdentityDirectory,
  session: AuthenticatedSession
): Promise<ActionIdentityResolution> {
  const result = await directory.resolve(session);
  if (result.status === "ambiguous") {
    return { status: "denied", code: "IDENTITY_AMBIGUOUS", reason: result.reason };
  }
  if (result.status === "invalid") {
    return { status: "denied", code: "IDENTITY_INVALID", reason: result.reason };
  }
  if (result.status === "unresolved") {
    return { status: "denied", code: "IDENTITY_NOT_RESOLVED", reason: result.reason };
  }
  // The same guard createIdentityActorResolver applies before returning an actor id: a directory
  // that hands back an unsafe integer is a defect, not an actor.
  if (!isSafePositiveGreenhouseUserId(result.greenhouseUserId)) {
    return {
      status: "denied",
      code: "IDENTITY_INVALID",
      reason: "Identity directory returned an invalid Greenhouse user id.",
    };
  }
  const identityId = parseDirectoryIdentityId(result.identityId);
  if (identityId === undefined) {
    return {
      status: "denied",
      code: "IDENTITY_ID_UNAVAILABLE",
      reason: "Recruiter identity resolved without a single directory row id, which the action entitlement is keyed on.",
    };
  }
  return { status: "resolved", identity: { identityId, greenhouseUserId: result.greenhouseUserId } };
}

export interface StaticIdentityRow {
  subject?: string;
  email?: string;
  status: "resolved" | "unresolved";
  greenhouseUserId?: number;
  greenhouseUserIds?: number[];
  /** Directory row uuid, for a static-JSON identity that also has to reach the action plane. */
  identityId?: string;
}

export function createStaticIdentityDirectory(rows: StaticIdentityRow[]): IdentityDirectory {
  return {
    resolve(session) {
      const matches = rows.filter((row) => {
        const subjectMatches = row.subject && row.subject === session.subject;
        const emailMatches = row.email && session.email && row.email.toLowerCase() === session.email.toLowerCase();
        return Boolean(subjectMatches || emailMatches);
      });
      if (matches.length === 0) {
        return { status: "unresolved", reason: "No resolved recruiter identity mapping was found." };
      }
      const ids = new Set<number>();
      const directoryIds = new Set<string>();
      let sawRowWithoutDirectoryId = false;
      let resolvedRowCount = 0;
      let invalidResolvedRow = false;
      for (const row of matches) {
        if (row.status !== "resolved") {
          continue;
        }
        resolvedRowCount += 1;
        // A malformed identityId is NOT an invalid row: it withholds the action-plane id and
        // leaves the read-plane resolution untouched, which is the whole point of keeping the
        // second id optional. It does, however, mean this row cannot be the one keyed on — which
        // matters when a sibling row can, hence the flag rather than a bare discard.
        const directoryId = parseDirectoryIdentityId(row.identityId);
        if (directoryId === undefined) sawRowWithoutDirectoryId = true;
        else directoryIds.add(directoryId);
        const rowIds = staticRowGreenhouseIds(row);
        if (rowIds.status === "invalid") {
          invalidResolvedRow = true;
          continue;
        }
        for (const id of rowIds.ids) {
          ids.add(id);
        }
      }
      if (invalidResolvedRow || (resolvedRowCount > 0 && ids.size === 0)) {
        return {
          status: "invalid",
          reason: "Recruiter identity mapping has an invalid Greenhouse user id.",
        };
      }
      const greenhouseUserIds = [...ids];
      if (greenhouseUserIds.length === 1) {
        return {
          status: "resolved",
          greenhouseUserId: greenhouseUserIds[0]!,
          ...soleDirectoryId(directoryIds, sawRowWithoutDirectoryId),
        };
      }
      if (greenhouseUserIds.length > 1) {
        return {
          status: "ambiguous",
          greenhouseUserIds,
          reason: "Authenticated user maps to multiple Greenhouse user ids; scoped MCP requires a single resolved actor.",
        };
      }
      return { status: "unresolved", reason: "Recruiter identity mapping is not resolved." };
    },
  };
}

// The learned fact "this relation has no row-id column" has to OUTLIVE the request that learned it.
// The hosted server builds a fresh server per request (remote.ts:171-176) and a fresh directory with
// it (server.ts:82-90), so a flag scoped to the directory instance is discarded before it can save a
// single round trip: a supported custom view without the column would repeat the failing select AND
// its retry on every tool call, forever — three identity round trips where there were two, which is
// the opposite of what README.md:245 promises ("detects its absence on the first lookup and stops
// asking") and not the inertness Phase 1 claims for that configuration.
//
// Module-scoped keyed registry — the sharedPermissionProviders pattern
// (scoped-reader.ts:28-35,71,82) — rather than a second mechanism for the same problem. The key is
// everything that can change the answer, so two differently-configured directories can never inherit
// each other's: the PostgREST origin, the relation, the column name being asked for, and a digest of
// the API key. The key belongs in it because it authenticates a Postgres role, and the role decides
// which relation `table` resolves to and which of its columns are exposed. A DIGEST, never the key
// itself: this Set lives for the life of the process and its contents end up in heap dumps — the
// same reasoning, and the same construction, as the entitlement registry
// (action-entitlement.ts:242-250).
//
// Never re-checked, and that direction is safe: the only thing recorded here is an ABSENCE, which
// can withhold write eligibility and can never grant it. Adding the column to a custom directory
// therefore takes a restart to take effect — a schema migration is a deliberate operator action, and
// the alternative is a failing round trip on every tool call for as long as the deployment lives.
const directoriesWithoutRowIdColumn = new Set<string>();

function rowIdColumnRegistryKey(input: {
  baseUrl: string;
  table: string;
  directoryIdColumn: string;
  apiKey: string;
}): string {
  return [
    input.baseUrl,
    input.table,
    input.directoryIdColumn,
    createHash("sha256").update(input.apiKey).digest("base64url").slice(0, 16),
  ].join("|");
}

/** Test-only: forget every learned row-id-column absence so cases don't inherit each other's. */
export function _resetIdentityRowIdColumnLearning(): void {
  directoriesWithoutRowIdColumn.clear();
}

export function createSupabaseIdentityDirectory(
  config: SupabaseIdentityDirectoryConfig
): IdentityDirectory {
  const columns = normalizeSupabaseIdentityColumns(config.columns);
  const table = normalizeOptionalSupabaseIdentifier(config.table, "recruiter_identity_directory", "Supabase identity directory table");
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_EXTERNAL_LOOKUP_TIMEOUT_MS;
  const baseUrl = normalizeSupabaseRestOrigin(config.supabaseUrl, "Supabase identity directory");
  const apiKey = normalizeSupabaseApiKey(config.apiKey, "Supabase identity directory");
  // The row-id column is OPTIONAL, and this directory learns whether it exists rather than
  // asserting it. The canonical table has it (supabase/migrations/0001:7), but README documents
  // custom tables and views as supported configurations, and one of those is entitled to have no
  // `id` at all. Learned once, on the first PostgREST undefined-column answer, and recorded in the
  // module registry above so the whole PROCESS pays one extra request rather than one per lookup —
  // this directory object does not survive the request that built it.
  const rowIdColumnKey = rowIdColumnRegistryKey({ baseUrl, table, directoryIdColumn: columns.directoryId, apiKey });

  return {
    async resolve(session) {
      const rows: Array<Record<string, unknown>> = [];
      const lookup = (column: string, value: string) => fetchSupabaseIdentityRows({
        baseUrl,
        table,
        column,
        value,
        columns,
        apiKey,
        fetchImpl,
        timeoutMs,
        // Read per lookup, not per directory: the subject lookup below runs after the email lookup
        // has already had its answer, so within one request the second call is reduced too.
        includeDirectoryId: !directoriesWithoutRowIdColumn.has(rowIdColumnKey),
        onDirectoryIdColumnMissing: () => { directoriesWithoutRowIdColumn.add(rowIdColumnKey); },
      });
      const normalizedEmail = session.email?.trim().toLowerCase();
      if (normalizedEmail) {
        rows.push(...await lookup(columns.email, normalizedEmail));
      }
      if (session.subject) {
        rows.push(...await lookup(columns.subject, session.subject));
      }
      return resolveIdentityRows(rows, columns.greenhouseUserId, columns.directoryId);
    },
  };
}

function normalizeSupabaseIdentityColumns(columns: Partial<SupabaseIdentityColumns> | undefined): SupabaseIdentityColumns {
  const normalized: SupabaseIdentityColumns = { ...DEFAULT_SUPABASE_IDENTITY_COLUMNS };
  if (columns) for (const [key, value] of Object.entries(columns) as Array<[keyof SupabaseIdentityColumns, string | undefined]>) {
    if (typeof value === "string" && value.length > 0) {
      normalized[key] = value;
    }
  }
  normalized.greenhouseUserId = normalizeSupabaseIdentifier(normalized.greenhouseUserId, "Supabase identity Greenhouse user id column");
  normalized.directoryId = normalizeSupabaseIdentifier(normalized.directoryId, "Supabase identity directory id column");
  normalized.email = normalizeSupabaseIdentifier(normalized.email, "Supabase identity email column");
  normalized.subject = normalizeSupabaseIdentifier(normalized.subject, "Supabase identity subject column");
  normalized.status = normalizeSupabaseIdentifier(normalized.status, "Supabase identity status column");
  return normalized;
}

export function createIdentityDirectoryFromEnv(
  env: NodeJS.ProcessEnv = process.env
): IdentityDirectory {
  const backend = readRecruiterStateBackend(env);
  const raw = env.GREENHOUSE_RECRUITER_IDENTITY_JSON;
  const supabaseUrl = env.GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL;
  const apiKey = env.GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY;
  if (backend === "supabase_postgrest" && (!supabaseUrl || !apiKey)) {
    throw new Error(
      "GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL and GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY are required when GREENHOUSE_RECRUITER_STATE_BACKEND=supabase_postgrest."
    );
  }
  if (supabaseUrl || apiKey) {
    if (!supabaseUrl || !apiKey) {
      throw new Error(
        "GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL and GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY must be set together."
      );
    }
    return createSupabaseIdentityDirectory({
      supabaseUrl: assertCanonicalSupabaseProjectRef(supabaseUrl, "Supabase identity directory"),
      apiKey,
      table: env.GREENHOUSE_RECRUITER_IDENTITY_TABLE,
      timeoutMs: readLookupTimeoutMs(
        env.GREENHOUSE_RECRUITER_IDENTITY_LOOKUP_TIMEOUT_MS,
        "GREENHOUSE_RECRUITER_IDENTITY_LOOKUP_TIMEOUT_MS"
      ),
      columns: {
        greenhouseUserId: env.GREENHOUSE_RECRUITER_IDENTITY_GREENHOUSE_USER_ID_COLUMN,
        directoryId: env.GREENHOUSE_RECRUITER_IDENTITY_DIRECTORY_ID_COLUMN,
        email: env.GREENHOUSE_RECRUITER_IDENTITY_EMAIL_COLUMN,
        subject: env.GREENHOUSE_RECRUITER_IDENTITY_SUBJECT_COLUMN,
        status: env.GREENHOUSE_RECRUITER_IDENTITY_STATUS_COLUMN,
        resolvedStatus: env.GREENHOUSE_RECRUITER_IDENTITY_RESOLVED_STATUS,
      },
    });
  }
  if (raw) {
    return createStaticIdentityDirectoryFromJson(raw);
  }
  return createStaticIdentityDirectory([]);
}

export function createStaticIdentityDirectoryFromEnv(
  env: NodeJS.ProcessEnv = process.env
): IdentityDirectory {
  const raw = env.GREENHOUSE_RECRUITER_IDENTITY_JSON;
  if (!raw) {
    return createStaticIdentityDirectory([]);
  }
  return createStaticIdentityDirectoryFromJson(raw);
}

function createStaticIdentityDirectoryFromJson(raw: string): IdentityDirectory {
  const parsed = JSON.parse(raw) as StaticIdentityRow[];
  if (!Array.isArray(parsed)) {
    throw new Error("GREENHOUSE_RECRUITER_IDENTITY_JSON must be a JSON array.");
  }
  return createStaticIdentityDirectory(parsed);
}

interface FetchSupabaseIdentityRowsInput {
  baseUrl: string;
  table: string;
  column: string;
  value: string;
  columns: SupabaseIdentityColumns;
  apiKey: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  /** False once this PROCESS has learned this relation has no row-id column. */
  includeDirectoryId: boolean;
  /** Called exactly on the answer that proves the column is absent; records it process-wide. */
  onDirectoryIdColumnMissing(): void;
}

type IdentityRowsAttempt =
  | { status: "rows"; rows: Array<Record<string, unknown>> }
  | { status: "directory_id_column_missing"; error: Error }
  | { status: "failed"; error: Error };

/**
 * Read the directory, degrading — never failing — when the optional row-id column is not there.
 *
 * The row id is a WRITE-plane need: `greenhouse_action_entitlement` is keyed on it
 * (action-mcp/src/store.ts:105-118). The read plane authorizes on the Greenhouse user id and has
 * never needed it. So a table that cannot supply it must lose write eligibility and nothing else;
 * throwing here would take every read a recruiter has away over a column their reads never touch,
 * for a configuration the README explicitly supports.
 */
async function fetchSupabaseIdentityRows(input: FetchSupabaseIdentityRowsInput): Promise<Array<Record<string, unknown>>> {
  const first = await attemptIdentityRows(input, input.includeDirectoryId);
  if (first.status === "rows") return first.rows;
  if (first.status === "directory_id_column_missing") {
    const retried = await attemptIdentityRows(input, false);
    // Record the absence only once the retry has PROVEN it: the same select minus the row-id column
    // succeeded where the one carrying it failed. Recording on the classification alone let any 400
    // whose body happened to say "does not exist" — a missing subject or email column in one
    // misconfigured directory — permanently withhold write eligibility, process-wide until restart,
    // from every other directory sharing this key. If the retry fails too, the column was not the
    // problem: propagate that failure and learn nothing.
    if (retried.status === "rows") {
      input.onDirectoryIdColumnMissing();
      return retried.rows;
    }
    throw retried.error;
  }
  throw first.error;
}

async function attemptIdentityRows(
  input: FetchSupabaseIdentityRowsInput,
  includeDirectoryId: boolean
): Promise<IdentityRowsAttempt> {
  const url = new URL(`${input.baseUrl}/rest/v1/${encodeURIComponent(input.table)}`);
  url.searchParams.set("select", [
    input.columns.greenhouseUserId,
    ...(includeDirectoryId ? [input.columns.directoryId] : []),
    input.columns.email,
    input.columns.subject,
    input.columns.status,
  ].join(","));
  url.searchParams.set(input.column, `eq.${input.value}`);
  url.searchParams.set(input.columns.status, `eq.${input.columns.resolvedStatus}`);

  const response = await fetchWithTimeout(input.fetchImpl, url, {
    method: "GET",
    headers: {
      apikey: input.apiKey,
      authorization: `Bearer ${input.apiKey}`,
      accept: "application/json",
    },
  }, input.timeoutMs, "Identity directory lookup");
  if (!response.ok) {
    const error = new Error(`Identity directory lookup failed with status ${response.status}.`);
    return includeDirectoryId && await isUndefinedColumnResponse(response, input.columns)
      ? { status: "directory_id_column_missing", error }
      : { status: "failed", error };
  }
  const data = await response.json() as unknown;
  if (!Array.isArray(data)) {
    return { status: "failed", error: new Error("Identity directory lookup returned a non-array response.") };
  }
  return {
    status: "rows",
    rows: data.filter((row): row is Record<string, unknown> => row !== null && typeof row === "object" && !Array.isArray(row)),
  };
}

/**
 * PostgREST answers a select over a column the relation does not have with HTTP 400 carrying
 * SQLSTATE 42703. Matched on the code or on Postgres's own wording, because the envelope has moved
 * between PostgREST versions and the retry is cheap: the only thing it changes is dropping one
 * optional column, and if the retry fails too, that failure is what propagates.
 *
 * The match is deliberately loose about WHICH column, with one exception: an answer that names a
 * different selected column — and does not name the row-id column — is some other column's problem,
 * not this one's, so it is not classified here. That exception only ever suppresses a retry that
 * would have failed anyway; the retry itself, and the fact that only a SUCCESSFUL retry is allowed
 * to teach the registry anything, are what actually make the classification safe to be loose about.
 */
async function isUndefinedColumnResponse(
  response: Response,
  columns: SupabaseIdentityColumns
): Promise<boolean> {
  if (response.status !== 400) return false;
  try {
    const body = await response.text();
    if (!body.includes("42703") && !body.includes("does not exist")) return false;
    if (body.includes(columns.directoryId)) return true;
    const otherSelected = [columns.greenhouseUserId, columns.email, columns.subject, columns.status];
    return !otherSelected.some((column) => body.includes(column));
  } catch {
    return false;
  }
}

function resolveIdentityRows(
  rows: Array<Record<string, unknown>>,
  greenhouseUserIdColumn: string,
  directoryIdColumn: string
): IdentityResolution {
  if (rows.length === 0) {
    return { status: "unresolved", reason: "No resolved recruiter identity mapping was found." };
  }
  const ids = new Set<number>();
  const directoryIds = new Set<string>();
  let sawRowWithoutDirectoryId = false;
  let invalidRow = false;
  for (const row of rows) {
    // Deliberately NOT part of the invalid-row test below: a directory id that is absent or
    // malformed withholds the action-plane id and changes nothing about who the read plane
    // authorizes. The alternative — failing identity resolution over a column the read plane
    // never uses — would take the read plane down for a write-plane concern.
    const directoryId = parseDirectoryIdentityId(row[directoryIdColumn]);
    if (directoryId === undefined) sawRowWithoutDirectoryId = true;
    else directoryIds.add(directoryId);
    const parsed = parsePositiveGreenhouseUserId(row[greenhouseUserIdColumn]);
    if (parsed === undefined) {
      invalidRow = true;
      continue;
    }
    ids.add(parsed);
  }
  if (invalidRow || ids.size === 0) {
    return {
      status: "invalid",
      reason: "Recruiter identity mapping has an invalid Greenhouse user id.",
    };
  }
  const greenhouseUserIds = [...ids];
  if (greenhouseUserIds.length === 1) {
    return {
      status: "resolved",
      greenhouseUserId: greenhouseUserIds[0]!,
      ...soleDirectoryId(directoryIds, sawRowWithoutDirectoryId),
    };
  }
  if (greenhouseUserIds.length > 1) {
    return {
      status: "ambiguous",
      greenhouseUserIds,
      reason: "Authenticated user maps to multiple Greenhouse user ids; scoped MCP requires a single resolved actor.",
    };
  }
  return { status: "unresolved", reason: "Recruiter identity mapping is not resolved." };
}

function staticRowGreenhouseIds(row: StaticIdentityRow): { status: "valid"; ids: number[] } | { status: "invalid" } {
  const ids: number[] = [];
  if ("greenhouseUserId" in row) {
    const parsed = parsePositiveGreenhouseUserId(row.greenhouseUserId);
    if (parsed === undefined) return { status: "invalid" };
    ids.push(parsed);
  }
  if ("greenhouseUserIds" in row) {
    if (!Array.isArray(row.greenhouseUserIds) || row.greenhouseUserIds.length === 0) return { status: "invalid" };
    for (const rawId of row.greenhouseUserIds) {
      const parsed = parsePositiveGreenhouseUserId(rawId);
      if (parsed === undefined) return { status: "invalid" };
      ids.push(parsed);
    }
  }
  return ids.length > 0 ? { status: "valid", ids } : { status: "invalid" };
}

// Exactly one distinct directory id, and every matched row agreed on it. Two ids means the matched
// rows disagree about which directory row this session is (email matched one, subject another), and
// an entitlement is granted PER ROW — picking either would be a guess about which grant applies.
//
// `sawRowWithoutId` closes the half of that hazard a set cannot see. Discarding unusable ids and
// then counting what survived turned "one row has a uuid, the other has none" into a set of size
// one, which read as unanimity and made the session write-eligible on the strength of whichever row
// happened to carry an id. It is the same disagreement as two conflicting uuids: two rows matched,
// only one can be keyed on, and nothing here knows which grant the recruiter meant. The read plane
// is untouched either way — it never looks at this id — so the whole cost of refusing is that the
// action plane denies with IDENTITY_ID_UNAVAILABLE, which is the honest answer.
function soleDirectoryId(directoryIds: Set<string>, sawRowWithoutId: boolean): { identityId?: string } {
  if (sawRowWithoutId || directoryIds.size !== 1) return {};
  return { identityId: [...directoryIds][0]! };
}

// Same uuid shape the action plane validates its stored identity_id against
// (action-mcp/src/store.ts `requireUuid`). Validating here rather than at the query keeps a
// malformed id from ever reaching PostgREST as a filter value.
const DIRECTORY_IDENTITY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseDirectoryIdentityId(value: unknown): string | undefined {
  if (typeof value !== "string" || !DIRECTORY_IDENTITY_ID_PATTERN.test(value)) return undefined;
  return value;
}

function parsePositiveGreenhouseUserId(value: unknown): number | undefined {
  if (isSafePositiveGreenhouseUserId(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    if (isSafePositiveGreenhouseUserId(parsed)) return parsed;
  }
  return undefined;
}

export function isSafePositiveGreenhouseUserId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
