import { readAllScopedRows, readStatusMessage } from "../../read-all.js";
import { type RecruiterToolRuntime, type ToolDeadline } from "../../runtime.js";
import { classifyUpstreamError, isRateLimitError } from "../../upstream-error.js";
import type { RecruiterDenialCode } from "../../types.js";
import type { AliasEntry } from "./aliases.js";
import { getJobInventoryProvider } from "./services.js";

/**
 * Normalized, safe job-metadata record. The resolver never sees candidate
 * contact info, resumes, attachments, raw profiles, or private note content.
 * Only operational job metadata is carried here — including JOB-level custom-field
 * VALUES from select/short-text fields (Job Level, Priority, Cost Center, Hiring
 * Location(s)...), which are the vocabulary recruiters query by. long_text values
 * (free text), booleans, and nulls are deliberately excluded from the index.
 */
export interface JobInventoryRecord {
  greenhouse_job_id: number;
  requisition_id: string | null;
  title: string;
  status: string;
  // Singular fields = first-element aliases, kept for output/back-compat. The MULTI-VALUED
  // arrays below are the real matching signals: v3 jobs carry only bare office_ids /
  // department_id (the embedded-object reads were null on live data), a job can span several
  // offices, and a job POSTED to a city often carries only a country-level tag — the live
  // "FDE roles in NY" miss (2026-07-02).
  department: string | null;
  office: string | null;
  location: string | null;
  offices: string[];
  locations: string[]; // office locations ∪ job-post plain_text_locations ∪ Hiring Location(s) custom field
  departments: string[];
  posted_titles: string[]; // external job-post titles that differ from the internal name
  custom_field_values: string[]; // select/short-text job custom-field values (IC5, P0, Cost Center...)
  opened_at: string | null;
  closed_at: string | null;
  recruiters: string[];
  hiring_managers: string[];
  confidential: boolean;
  historical_titles: string[];
  normalized_title: string;
  normalized_text: string;
}

export type InventoryScopeKind = "jobs" | "operator" | "all";

export interface JobInventory {
  records: JobInventoryRecord[];
  scopeKind: InventoryScopeKind;
  canViewConfidential: boolean;
  /**
   * Job ids that are in this actor's permission-filtered inventory but were
   * dropped by the confidential-projection filter (only populated when the actor
   * cannot view confidential jobs). Used to return a diagnosable denial when an
   * actor passes the exact id of a confidential job they are assigned to — never
   * to broaden access, and never surfaced to the model in resolver output.
   */
  confidentialExcludedIds: number[];
  complete: boolean;
  truncated: boolean;
  accessibleSeen: number;
  estimated: number | null;
  rawRowsSeen: number;
  unnormalizableRows: number;
  source: "live_greenhouse" | "cached_index" | "hybrid";
  indexAsOf: string | null;
  paginationError: string | null;
  freshnessSeconds: number | null;
  aliasTable: AliasEntry[];
  actorId: number | null;
  /**
   * Names of enrichment joins (offices/departments/job_posts/job_post_locations) that failed or
   * truncated. Enrichment degrades — records still build from the jobs read — but the gap is
   * NAMED so the resolver can disclose weaker matching instead of silently under-matching.
   */
  enrichmentIncomplete: string[];
}

export type JobInventoryLoad =
  | { ok: true; inventory: JobInventory }
  | { ok: false; code: RecruiterDenialCode; message: string };

export interface JobInventoryProvider {
  loadInventory(runtime: RecruiterToolRuntime, deadline?: ToolDeadline): Promise<JobInventoryLoad>;
}

const INVENTORY_PAGE_SIZE = 500;
// Job custom-field types whose VALUES are safe, useful matching vocabulary. long_text is free
// text (could carry anything sensitive) and boolean values are noise — both stay out.
const CUSTOM_FIELD_INDEXABLE_TYPES = new Set(["single_select", "multi_select", "short_text"]);
const MAX_PERSON_NAMES = 25;

export async function loadJobInventory(
  runtime: RecruiterToolRuntime,
  deadline?: ToolDeadline
): Promise<JobInventoryLoad> {
  const provider = getJobInventoryProvider(runtime.resolution);
  if (provider) {
    return provider.loadInventory(runtime, deadline);
  }
  return loadScopedReaderInventory(runtime, deadline);
}

/**
 * Production inventory: paginated `list_jobs` through the scoped reader. The
 * scoped core owns permission filtering, so a narrow recruiter only ever sees
 * their permitted jobs while an operator/all actor sees the org inventory.
 */
export async function loadScopedReaderInventory(
  runtime: RecruiterToolRuntime,
  deadline?: ToolDeadline
): Promise<JobInventoryLoad> {
  let readResult: Awaited<ReturnType<typeof readAllScopedRows<Record<string, unknown>>>>;
  try {
    readResult = await readAllScopedRows<Record<string, unknown>>(
      runtime,
      "list_jobs",
      "list_jobs",
      {},
      deadline,
      { perPage: INVENTORY_PAGE_SIZE }
    );
  } catch (error) {
    // Classify the cause instead of collapsing 401/403/422/5xx/network into one opaque string —
    // this loader backs resolve_job_scope, capabilities, recipe validation, and the planner, so a
    // transient blip should read differently from a dead credential or a permanent rejection.
    if (isRateLimitError(error)) {
      return { ok: false, code: "RATE_LIMITED", message: "Job inventory read was rate limited before completing." };
    }
    return {
      ok: false,
      code: "UPSTREAM_ERROR",
      message: classifyUpstreamError(error, "Job inventory pagination failed before completing."),
    };
  }
  if (readResult.kind === "denial") {
    if (readResult.result.ok) {
      return { ok: false, code: "UPSTREAM_ERROR", message: "Job inventory pagination failed before completing." };
    }
    return { ok: false, code: readResult.result.denial.code, message: readResult.result.denial.message };
  }

  const rows = readResult.rows;
  const scopeKind = inventoryScopeKindFrom(readResult.permissionScope?.kind);
  const actorId = typeof readResult.actorId === "number" ? readResult.actorId : null;
  const truncated = readResult.paginationTruncated;
  const paginationError = readStatusMessage(readResult.status) ?? null;
  const canViewConfidential = scopeKind !== "jobs";
  const { joins, enrichmentIncomplete } = await loadInventoryEnrichment(runtime, deadline);
  const normalized = rows.map((row) => normalizeLiveJobRow(row, joins));
  const unnormalizableRows = normalized.filter((record) => record === null).length;
  const normalizedRecords = normalized.filter((record): record is JobInventoryRecord => record !== null);
  const confidentialExcludedIds = canViewConfidential
    ? []
    : normalizedRecords.filter((record) => record.confidential).map((record) => record.greenhouse_job_id);
  const records = canViewConfidential
    ? normalizedRecords
    : normalizedRecords.filter((record) => !record.confidential);
  const complete = readResult.complete && unnormalizableRows === 0;

  return {
    ok: true,
    inventory: {
      records,
      scopeKind,
      canViewConfidential,
      confidentialExcludedIds,
      complete,
      truncated,
      accessibleSeen: records.length,
      estimated: complete ? records.length : null,
      rawRowsSeen: readResult.rawRowsRead,
      unnormalizableRows,
      source: "live_greenhouse",
      indexAsOf: null,
      paginationError,
      freshnessSeconds: 0,
      aliasTable: [],
      actorId,
      enrichmentIncomplete,
    },
  };
}

interface InventoryJoins {
  officesById: Map<number, { name: string | null; location: string | null }>;
  departmentNamesById: Map<number, string>;
  postsByJobId: Map<number, Array<{ postId: number; title: string | null }>>;
  postLocationsByPostId: Map<number, string[]>;
}

const EMPTY_JOINS: InventoryJoins = {
  officesById: new Map(),
  departmentNamesById: new Map(),
  postsByJobId: new Map(),
  postLocationsByPostId: new Map(),
};

/**
 * The dictionary + job-post joins that turn bare v3 ids into matchable names. Each read degrades
 * independently (a failed join never fails the inventory); the gaps are returned by name so the
 * resolver can disclose weaker matching. Raw pages ride the module read-cache, so these amortize
 * across requests and actors within the TTL.
 */
async function loadInventoryEnrichment(
  runtime: RecruiterToolRuntime,
  deadline?: ToolDeadline
): Promise<{ joins: InventoryJoins; enrichmentIncomplete: string[] }> {
  const [offices, departments, jobPosts, postLocations] = await Promise.all([
    readEnrichmentRows(runtime, "list_offices", deadline),
    readEnrichmentRows(runtime, "list_departments", deadline),
    readEnrichmentRows(runtime, "list_job_posts", deadline),
    readEnrichmentRows(runtime, "list_job_post_locations", deadline),
  ]);

  const officesById = new Map<number, { name: string | null; location: string | null }>();
  for (const row of offices.rows) {
    const id = readPositiveInteger(row.id);
    if (id === null) continue;
    officesById.set(id, { name: stringField(row.name), location: readLocationName(row.location) });
  }
  const departmentNamesById = new Map<number, string>();
  for (const row of departments.rows) {
    const id = readPositiveInteger(row.id);
    const name = stringField(row.name);
    if (id !== null && name) departmentNamesById.set(id, name);
  }
  const postsByJobId = new Map<number, Array<{ postId: number; title: string | null }>>();
  for (const row of jobPosts.rows) {
    const postId = readPositiveInteger(row.id);
    const jobId = readPositiveInteger(row.job_id);
    if (postId === null || jobId === null) continue;
    const list = postsByJobId.get(jobId) ?? [];
    list.push({ postId, title: stringField(row.title) });
    postsByJobId.set(jobId, list);
  }
  const postLocationsByPostId = new Map<number, string[]>();
  for (const row of postLocations.rows) {
    const postId = readPositiveInteger(row.job_post_id);
    // v3 field is plain_text_location (verified against the vendored contract — NOT `location`).
    const name = stringField(row.plain_text_location) ?? readLocationName(row.location);
    if (postId === null || !name) continue;
    const list = postLocationsByPostId.get(postId) ?? [];
    if (!list.includes(name)) list.push(name);
    postLocationsByPostId.set(postId, list);
  }

  const enrichmentIncomplete: string[] = [];
  if (!offices.ok) enrichmentIncomplete.push("offices");
  if (!departments.ok) enrichmentIncomplete.push("departments");
  if (!jobPosts.ok) enrichmentIncomplete.push("job_posts");
  if (!postLocations.ok) enrichmentIncomplete.push("job_post_locations");

  return { joins: { officesById, departmentNamesById, postsByJobId, postLocationsByPostId }, enrichmentIncomplete };
}

async function readEnrichmentRows(
  runtime: RecruiterToolRuntime,
  toolName: string,
  deadline?: ToolDeadline
): Promise<{ rows: Array<Record<string, unknown>>; ok: boolean }> {
  try {
    const read = await readAllScopedRows<Record<string, unknown>>(runtime, toolName, toolName, {}, deadline, {
      perPage: INVENTORY_PAGE_SIZE,
    });
    if (read.kind === "denial") return { rows: [], ok: false };
    return { rows: read.rows, ok: read.complete };
  } catch {
    return { rows: [], ok: false };
  }
}

export interface JobScopeFixturePersona {
  id: string;
  greenhouse_user_id: number;
  permission_scope_kind: string;
  risk_profile?: string;
  accessible_job_ids: number[] | "all";
  can_view_confidential: boolean;
}

export interface JobScopeFixtureJob {
  greenhouse_job_id: number;
  requisition_id: string | null;
  title: string;
  status: string;
  department: string | null;
  office: string | null;
  location: string | null;
  opened_at: string | null;
  closed_at: string | null;
  recruiters?: string[];
  hiring_managers?: string[];
  confidential?: boolean;
  historical_titles?: string[];
  offices?: string[];
  locations?: string[];
  departments?: string[];
  posted_titles?: string[];
  custom_field_values?: string[];
}

export interface JobScopeFixture {
  personas: JobScopeFixturePersona[];
  jobs: JobScopeFixtureJob[];
  aliases?: AliasEntry[];
}

export interface FixtureInventoryOptions {
  complete?: boolean;
  source?: "live_greenhouse" | "cached_index" | "hybrid";
  indexAsOf?: string | null;
  freshnessSeconds?: number | null;
}

/**
 * Test/index inventory backed by the golden fixture. Permission filtering and
 * confidential filtering are applied here exactly as the scoped core would
 * apply them in production, so the resolver policy is exercised faithfully.
 */
export function buildFixtureInventory(
  fixture: JobScopeFixture,
  personaId: string,
  options: FixtureInventoryOptions = {}
): JobInventoryLoad {
  const persona = fixture.personas.find((entry) => entry.id === personaId);
  if (!persona) {
    return { ok: false, code: "IDENTITY_NOT_RESOLVED", message: `Unknown fixture persona ${personaId}.` };
  }
  const accessible = persona.accessible_job_ids;
  const isAll = accessible === "all";
  const accessibleSet = isAll ? null : new Set(accessible as number[]);
  const canViewConfidential = persona.can_view_confidential === true;
  const permittedRecords = fixture.jobs
    .filter((job) => isAll || accessibleSet!.has(job.greenhouse_job_id))
    .map((job) => normalizeFixtureJob(job));
  const confidentialExcludedIds = canViewConfidential
    ? []
    : permittedRecords.filter((record) => record.confidential).map((record) => record.greenhouse_job_id);
  const records = canViewConfidential
    ? permittedRecords
    : permittedRecords.filter((record) => !record.confidential);
  const complete = options.complete ?? true;
  const scopeKind: InventoryScopeKind = persona.permission_scope_kind === "operator"
    ? "operator"
    : persona.permission_scope_kind === "all"
      ? "all"
      : "jobs";
  return {
    ok: true,
    inventory: {
      records,
      scopeKind,
      canViewConfidential,
      confidentialExcludedIds,
      complete,
      truncated: !complete,
      accessibleSeen: records.length,
      estimated: isAll ? (complete ? records.length : null) : records.length,
      rawRowsSeen: records.length,
      unnormalizableRows: 0,
      source: options.source ?? "cached_index",
      indexAsOf: options.indexAsOf ?? null,
      paginationError: null,
      freshnessSeconds: options.freshnessSeconds ?? 0,
      aliasTable: Array.isArray(fixture.aliases) ? fixture.aliases : [],
      actorId: typeof persona.greenhouse_user_id === "number" ? persona.greenhouse_user_id : null,
      enrichmentIncomplete: [],
    },
  };
}

export function createFixtureInventoryProvider(
  fixture: JobScopeFixture,
  personaId: string,
  options: FixtureInventoryOptions = {}
): JobInventoryProvider {
  return {
    loadInventory: async (): Promise<JobInventoryLoad> => buildFixtureInventory(fixture, personaId, options),
  };
}

function normalizeFixtureJob(job: JobScopeFixtureJob): JobInventoryRecord {
  const office = nullableString(job.office);
  const location = nullableString(job.location);
  const department = nullableString(job.department);
  const offices = stringList(job.offices);
  const locations = stringList(job.locations);
  const departments = stringList(job.departments);
  if (office) pushUnique(offices, office);
  if (location) pushUnique(locations, location);
  if (department) pushUnique(departments, department);
  return finalizeRecord({
    greenhouse_job_id: job.greenhouse_job_id,
    requisition_id: nullableString(job.requisition_id),
    title: stringOrEmpty(job.title),
    status: stringOrEmpty(job.status).toLowerCase(),
    department,
    office,
    location,
    offices,
    locations,
    departments,
    posted_titles: stringList(job.posted_titles),
    custom_field_values: stringList(job.custom_field_values),
    opened_at: nullableString(job.opened_at),
    closed_at: nullableString(job.closed_at),
    recruiters: stringList(job.recruiters),
    hiring_managers: stringList(job.hiring_managers),
    confidential: job.confidential === true,
    historical_titles: stringList(job.historical_titles),
  });
}

function normalizeLiveJobRow(row: Record<string, unknown>, joins: InventoryJoins = EMPTY_JOINS): JobInventoryRecord | null {
  const id = readPositiveInteger(row.id);
  if (id === null) return null;

  // v3 rows carry bare ids (office_ids/department_id) — resolve via the dictionaries. The
  // embedded-object reads stay as fallbacks for fixture/older shapes.
  const officeIds = positiveIntegerList(row.office_ids);
  const offices: string[] = [];
  const locations: string[] = [];
  for (const officeId of officeIds) {
    const entry = joins.officesById.get(officeId);
    if (entry?.name) pushUnique(offices, entry.name);
    if (entry?.location) pushUnique(locations, entry.location);
  }
  const embeddedOffice = firstRecord(row.offices) ?? recordField(row.office);
  if (offices.length === 0 && embeddedOffice) {
    const name = stringField(embeddedOffice.name);
    if (name) pushUnique(offices, name);
    const embeddedLocation = readLocationName(embeddedOffice.location);
    if (embeddedLocation) pushUnique(locations, embeddedLocation);
  }

  const departments: string[] = [];
  const departmentId = readPositiveInteger(row.department_id);
  if (departmentId !== null) {
    const name = joins.departmentNamesById.get(departmentId);
    if (name) pushUnique(departments, name);
  }
  if (departments.length === 0) {
    const embedded = firstNamed(row.departments) ?? namedField(row.department);
    if (embedded) pushUnique(departments, embedded);
  }

  const title = stringField(row.name) ?? "";
  const postedTitles: string[] = [];
  for (const post of joins.postsByJobId.get(id) ?? []) {
    if (post.title && post.title !== title) pushUnique(postedTitles, post.title);
    for (const locationName of joins.postLocationsByPostId.get(post.postId) ?? []) {
      pushUnique(locations, locationName);
    }
  }

  // Job-level custom fields (live probe 2026-07-02): Hiring Location(s) is an explicit per-job
  // location signal, and select/short-text values (Job Level, Priority, Cost Center, Employment
  // Type...) are the vocabulary recruiters query by. long_text (free text), booleans, and nulls
  // never enter the index.
  const customFieldValues: string[] = [];
  const customFields = recordField(row.custom_fields);
  if (customFields) {
    for (const entry of Object.values(customFields)) {
      const field = recordField(entry);
      if (!field) continue;
      const fieldType = stringField(field.type);
      if (fieldType === null || !CUSTOM_FIELD_INDEXABLE_TYPES.has(fieldType)) continue;
      const values = Array.isArray(field.value)
        ? field.value.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : typeof field.value === "string" && field.value.trim().length > 0
          ? [field.value]
          : [];
      if (values.length === 0) continue;
      const fieldName = stringField(field.name) ?? "";
      const isHiringLocation = /hiring\s*location/i.test(fieldName);
      for (const value of values) {
        if (isHiringLocation) pushUnique(locations, value.trim());
        else pushUnique(customFieldValues, value.trim());
      }
    }
  }

  const hiringTeam = recordField(row.hiring_team);
  return finalizeRecord({
    greenhouse_job_id: id,
    requisition_id: stringField(row.requisition_id),
    title,
    status: (stringField(row.status) ?? "").toLowerCase(),
    department: departments[0] ?? null,
    office: offices[0] ?? null,
    location: locations[0] ?? null,
    offices,
    locations,
    departments,
    posted_titles: postedTitles,
    custom_field_values: customFieldValues,
    opened_at: stringField(row.opened_at),
    closed_at: stringField(row.closed_at),
    recruiters: hiringTeam ? readTeamNames(hiringTeam.recruiters) : [],
    hiring_managers: hiringTeam ? readTeamNames(hiringTeam.hiring_managers) : [],
    confidential: row.confidential === true,
    historical_titles: [],
  });
}

function positiveIntegerList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids: number[] = [];
  for (const entry of value) {
    const id = readPositiveInteger(entry);
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function finalizeRecord(record: Omit<JobInventoryRecord, "normalized_title" | "normalized_text">): JobInventoryRecord {
  const normalizedTitle = normalizeText(record.title);
  const textParts = [
    record.title,
    record.department,
    record.office,
    record.location,
    ...record.historical_titles,
    // Multi-valued signals: every office/location/department name and the EXTERNAL posted
    // titles are searchable — a recruiter searching by the name the candidate saw must match.
    ...record.offices,
    ...record.locations,
    ...record.departments,
    ...record.posted_titles,
    ...record.custom_field_values,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  return {
    ...record,
    normalized_title: normalizedTitle,
    normalized_text: normalizeText([...new Set(textParts)].join(" | ")),
  };
}

export function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function inventoryScopeKindFrom(kind: string | undefined): InventoryScopeKind {
  if (kind === "operator") return "operator";
  if (kind === "all") return "all";
  return "jobs";
}

function nullableString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringField(value: unknown): string | null {
  return nullableString(value);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim())
    .slice(0, MAX_PERSON_NAMES);
}

function readTeamNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (isRecord(entry)) {
      const name = stringField(entry.name);
      if (name) names.push(name);
    }
    if (names.length >= MAX_PERSON_NAMES) break;
  }
  return names;
}

function firstNamed(value: unknown): string | null {
  const record = firstRecord(value);
  return record ? stringField(record.name) : null;
}

function namedField(value: unknown): string | null {
  const record = recordField(value);
  return record ? stringField(record.name) : null;
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    if (isRecord(entry)) return entry;
  }
  return null;
}

function recordField(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function readLocationName(value: unknown): string | null {
  if (typeof value === "string") return nullableString(value);
  const record = recordField(value);
  return record ? stringField(record.name) : null;
}

function readPositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
