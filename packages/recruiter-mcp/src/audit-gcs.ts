import type { AuditSink, RecruiterAuditEvent } from "./audit.js";

/**
 * GCS object-per-event retained audit backend (CLO-204). GCS objects are immutable — a FUSE mount
 * cannot append a JSONL line — so on Cloud Run the retained audit trail is one create-only JSON
 * object per audit event, written through the Cloud Storage SDK. Every emit is awaited before it
 * resolves: no buffering or batching, ever, because a crash between flushes would lose exactly the
 * events the audit gate exists to protect.
 *
 * Object name contract (a cross-reader contract — readers parse it):
 *   <prefix>/<YYYY-MM>/<YYYYMMDDTHHMMSSmmmZ>-<correlationId>-<suffix>.json
 * where the month directory and timestamp are UTC from the per-emit clock (matching the JSONL
 * sink's per-emit month partitioning), the timestamp is fixed-width digits-only so lexicographic
 * order equals chronological order, and <suffix> is the event's auditStage when present, else six
 * random base36 chars. Writability probes live under <prefix>/.probe/ and are excluded by readers.
 *
 * The @google-cloud/storage SDK is loaded lazily via dynamic import on first actual use, never at
 * module evaluation, so a boot without the GCS backend (Render, stdio, desktop) never loads it.
 * This module imports only TYPES from audit.js — no runtime cycle with the sink selector there.
 */

export const AUDIT_BACKEND_ENV = "GREENHOUSE_RECRUITER_AUDIT_BACKEND";
export const AUDIT_GCS_BUCKET_ENV = "GREENHOUSE_RECRUITER_AUDIT_GCS_BUCKET";
export const AUDIT_GCS_PREFIX_ENV = "GREENHOUSE_RECRUITER_AUDIT_GCS_PREFIX";
export const DEFAULT_AUDIT_GCS_PREFIX = "audit";

// Narrow structural slice of @google-cloud/storage that the real `Storage` instance satisfies (the
// lazy loader below is the compile-time proof) and tests satisfy with in-memory fakes.
export interface GcsObjectSaveOptions {
  preconditionOpts: { ifGenerationMatch: number };
  resumable: boolean;
  contentType: string;
}

export interface GcsObjectFileLike {
  readonly name: string;
  save(data: string, options: GcsObjectSaveOptions): Promise<unknown>;
  delete(): Promise<unknown>;
  download(): Promise<[Buffer]>;
}

export interface GcsBucketLike {
  file(path: string): GcsObjectFileLike;
  getFiles(query: { prefix: string; autoPaginate?: boolean }): Promise<[GcsObjectFileLike[], ...unknown[]]>;
}

export interface GcsStorageLike {
  bucket(name: string): GcsBucketLike;
}

export interface GcsObjectAuditSinkOptions {
  bucket: string;
  prefix: string;
  storage?: GcsStorageLike;
  now?: () => Date;
}

type GcsStorageFactory = () => Promise<GcsStorageLike>;

// The real client factory: the only place the SDK is imported, and only via dynamic import at first
// use. The typed assignment below is what structurally locks GcsStorageLike to the real SDK.
async function loadRealGcsStorage(): Promise<GcsStorageLike> {
  const { Storage } = await import("@google-cloud/storage");
  const storage: GcsStorageLike = new Storage();
  return storage;
}

let activeStorageFactory: GcsStorageFactory = loadRealGcsStorage;
// One shared client per process (the SDK client is designed to be long-lived; the hosted path
// constructs a fresh sink per request). A failed load clears itself so the next emit retries
// instead of wedging every future request on one rejected promise.
let sharedStoragePromise: Promise<GcsStorageLike> | null = null;

// Test-only seam (the withRevocationLookup global-fetch precedent): replaces the SDK factory so
// tests can count loads and inject fakes without touching the network. Passing null restores the
// real dynamic-import factory. Also resets the shared client and probe memo for hermetic tests.
export function setGcsStorageFactoryForTests(factory: GcsStorageFactory | null): void {
  activeStorageFactory = factory ?? loadRealGcsStorage;
  resetGcsAuditRuntimeStateForTests();
}

export function resetGcsAuditRuntimeStateForTests(): void {
  sharedStoragePromise = null;
  preflightVerifiedTargets.clear();
}

// Lazily resolves the process-shared storage client (or the test override). Exported for the
// readers that run in production without an injected instance (audit review CLI, summary timer).
export function resolveGcsAuditStorage(): Promise<GcsStorageLike> {
  if (!sharedStoragePromise) {
    const attempt: Promise<GcsStorageLike> = Promise.resolve()
      .then(() => activeStorageFactory())
      .catch((error) => {
        if (sharedStoragePromise === attempt) sharedStoragePromise = null;
        throw error;
      });
    sharedStoragePromise = attempt;
  }
  return sharedStoragePromise;
}

export type AuditBackend = "jsonl_file" | "gcs_object";

// Unset or empty means the historical default (the JSONL file backend). Any other value is a hard
// failure at every consumer — an unrecognized backend must never fall back to the console sink,
// because that would be a silent audit-off switch. Exact match only; padding is misconfiguration.
export function readAuditBackendFromEnv(env: NodeJS.ProcessEnv = process.env): AuditBackend {
  const raw = env[AUDIT_BACKEND_ENV];
  if (raw === undefined || raw.length === 0) return "jsonl_file";
  if (raw === "jsonl_file" || raw === "gcs_object") return raw;
  throw new Error(
    `${AUDIT_BACKEND_ENV} is not a supported audit backend. Supported values: jsonl_file, gcs_object. An unrecognized backend never falls back to the console sink.`
  );
}

export interface GcsAuditTarget {
  bucket: string;
  prefix: string;
}

// The GCS target from env: bucket required and shape-checked, prefix optional (default "audit",
// normalized). Pure string math, no I/O — safe for readiness checks and the per-request gate. The
// JSONL path and durable-mount env are deliberately not consulted: the GCS arm has no file paths.
export function buildGcsAuditConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GcsAuditTarget {
  const bucket = assertGcsAuditBucketShape(env[AUDIT_GCS_BUCKET_ENV]);
  const rawPrefix = env[AUDIT_GCS_PREFIX_ENV];
  if (rawPrefix === undefined || rawPrefix.length === 0) {
    return { bucket, prefix: DEFAULT_AUDIT_GCS_PREFIX };
  }
  return { bucket, prefix: normalizeGcsAuditPrefix(rawPrefix) };
}

// The hosted path preflights per request, so a probe write per request would double every tool
// call's storage traffic. A probe SUCCESS memoizes per bucket+prefix for the LIFE OF THE PROCESS:
// per-event emits are independently fail-closed, so the audit invariant never rests on this memo,
// and Cloud Run cold starts re-probe naturally on each new instance. (An earlier 60s TTL only taxed
// bursty recruiter traffic — ~2 extra GCS round-trips per memo miss — for zero protection.) Failure
// is NEVER memoized: every request retries a failing probe until the store recovers.
const preflightVerifiedTargets = new Set<string>();

// Retained for signature stability: the process-lifetime memo needs no clock, so the preflight
// currently takes no options.
export interface GcsPreflightOptions {}

// The GCS arm of the retained-audit preflight: proves the target is WRITABLE with a real create
// (then best-effort delete) under <prefix>/.probe/ — the fix for the silent-green class that
// shipped the FUSE-append bug. Throws plain errors; audit.ts wraps them in AuditUnavailableError.
export async function preflightGcsObjectAuditSinkFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  _options: GcsPreflightOptions = {}
): Promise<AuditSink> {
  const target = buildGcsAuditConfigFromEnv(env);
  const memoKey = `${target.bucket}\n${target.prefix}`;
  if (!preflightVerifiedTargets.has(memoKey)) {
    await probeGcsAuditTargetWritable(target);
    preflightVerifiedTargets.add(memoKey);
  }
  return createGcsObjectAuditSink({ bucket: target.bucket, prefix: target.prefix });
}

async function probeGcsAuditTargetWritable(target: GcsAuditTarget): Promise<void> {
  const storage = await resolveGcsAuditStorage();
  const probeName = `${target.prefix}/.probe/${gcsAuditObjectTimestamp(new Date())}-${randomBase36(6)}.json`;
  const file = storage.bucket(target.bucket).file(probeName);
  await file.save("{}", {
    preconditionOpts: { ifGenerationMatch: 0 },
    resumable: false,
    contentType: "application/json",
  });
  try {
    await file.delete();
  } catch (error) {
    // Writability is what is gated; a lingering probe object is cleanup debt, not an outage.
    // Name-only, matching the repo's error_name= style — never message content.
    const errorName = error instanceof Error && error.name ? error.name : typeof error;
    console.error(`[greenhouse-recruiter-mcp] audit gcs probe cleanup failed error_name=${errorName}`);
  }
}

export function createGcsObjectAuditSink(options: GcsObjectAuditSinkOptions): AuditSink {
  const bucketName = assertGcsAuditBucketShape(options.bucket);
  const prefix = normalizeGcsAuditPrefix(options.prefix);
  const clock = options.now ?? (() => new Date());
  const injected = options.storage;
  return {
    async emit(event) {
      const storage = injected ?? await resolveGcsAuditStorage();
      const objectName = gcsAuditObjectName(prefix, clock(), event);
      // Create-only, awaited, non-resumable: a name collision fails loudly (412) instead of
      // silently overwriting an audit record, and the SDK auto-retries safely under this
      // precondition. Any failure propagates — callers wrap it into AuditUnavailableError and the
      // request fails closed.
      await storage.bucket(bucketName).file(objectName).save(JSON.stringify(event), {
        preconditionOpts: { ifGenerationMatch: 0 },
        resumable: false,
        contentType: "application/json",
      });
    },
  };
}

// UTC month directory for an emit instant: "YYYY-MM", identical to the JSONL sink's partition key.
export function gcsAuditMonthDir(at: Date): string {
  return at.toISOString().slice(0, 7);
}

// Fixed-width digits-only UTC stamp: 2026-08-18T14:23:59.123Z -> 20260818T142359123Z. toISOString
// always carries milliseconds, so the width is constant and lexicographic order is chronological.
export function gcsAuditObjectTimestamp(at: Date): string {
  return at.toISOString().replace(/[-:.]/g, "");
}

function gcsAuditObjectName(prefix: string, at: Date, event: RecruiterAuditEvent): string {
  const suffix = event.auditStage ?? randomBase36(6);
  // Correlation ids are generated internally with a safe charset; the replace keeps a malformed one
  // from injecting path separators or breaking the name parse readers depend on.
  const correlationId = event.correlationId.replace(/[^A-Za-z0-9._:-]/g, "-");
  return `${prefix}/${gcsAuditMonthDir(at)}/${gcsAuditObjectTimestamp(at)}-${correlationId}-${suffix}.json`;
}

function randomBase36(length: number): string {
  return Math.random().toString(36).slice(2, 2 + length).padEnd(length, "0");
}

export interface GcsAuditReadWindow {
  fromMs?: number;
  toMs?: number;
}

// Reader counterpart of the sink, matching readAuditJsonlAcrossPartitions' contract: text is each
// object's JSON joined by newlines (chronological — the fixed-width name timestamp makes the sort
// trivial) and newline-terminated, paths are the object names actually read. Probe artifacts under
// <prefix>/.probe/ are excluded. With BOTH window bounds, only month dirs intersecting the window
// are listed, and listed objects outside the window are skipped by name timestamp without a fetch —
// the periodic summary must never sweep a whole month per tick. Windows are half-open
// [fromMs, toMs), matching buildAuditSummary, so consecutive ticks tile without double-fetching a
// boundary-stamped object. An unparsable name is included by UNWINDOWED reads rather than silently
// dropped (review completeness beats a saved fetch) but excluded from windowed reads, which select
// strictly by name timestamp.
export interface GcsAuditReadOptions {
  /** Clock for the month-listing upper bound when a window has fromMs but no toMs. Tests inject it. */
  now?: () => number;
}

// A month of recruiter traffic is thousands of small objects; sequential downloads made every
// windowed read crawl. Sixteen keeps the review CLI and the summary tick fast while staying far
// under the SDK's connection defaults.
const GCS_AUDIT_READ_MAX_CONCURRENT_DOWNLOADS = 16;

export async function readGcsAuditEvents(
  storage: GcsStorageLike,
  bucket: string,
  prefix: string,
  window: GcsAuditReadWindow = {},
  options: GcsAuditReadOptions = {}
): Promise<{ text: string; paths: string[] }> {
  const normalizedPrefix = normalizeGcsAuditPrefix(prefix);
  const bucketRef = storage.bucket(assertGcsAuditBucketShape(bucket));
  const probePrefix = `${normalizedPrefix}/.probe/`;
  const files: GcsObjectFileLike[] = [];
  if (window.fromMs !== undefined) {
    // A lower bound alone is enough to narrow the listing: an absent toMs means "through now" for
    // the month range (no honest clock names an object in a future month), and the name filter
    // below still applies whatever bounds the window carries. toMs is EXCLUSIVE, so the last
    // instant inside the window is toMs-1 — a window ending exactly on a month boundary must not
    // list the next month.
    const monthRangeEndMs = window.toMs !== undefined ? window.toMs - 1 : (options.now ?? (() => Date.now()))();
    for (const month of utcMonthDirsInRange(window.fromMs, monthRangeEndMs)) {
      const [listed] = await bucketRef.getFiles({ prefix: `${normalizedPrefix}/${month}/`, autoPaginate: true });
      files.push(...listed);
    }
  } else {
    // No lower bound (unwindowed, or toMs-only): list the whole prefix.
    const [listed] = await bucketRef.getFiles({ prefix: `${normalizedPrefix}/`, autoPaginate: true });
    files.push(...listed);
  }
  const selected = files
    .filter((file) => !file.name.startsWith(probePrefix))
    .filter((file) => objectNameWithinWindow(file.name, window))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  // Bounded-concurrency downloads assembled into per-index slots: the text/paths output stays
  // byte-identical to a sequential read — chronological by name — whatever order downloads land in.
  const chunks = new Array<string>(selected.length);
  let nextIndex = 0;
  await Promise.all(Array.from(
    { length: Math.min(GCS_AUDIT_READ_MAX_CONCURRENT_DOWNLOADS, selected.length) },
    async () => {
      while (nextIndex < selected.length) {
        const index = nextIndex;
        nextIndex += 1;
        const [data] = await selected[index]!.download();
        chunks[index] = data.toString("utf8");
      }
    }
  ));
  const paths = selected.map((file) => file.name);
  return { text: chunks.length > 0 ? `${chunks.join("\n")}\n` : "", paths };
}

// Every UTC "YYYY-MM" month dir from fromMs's month through toMs's month, inclusive.
function utcMonthDirsInRange(fromMs: number, toMs: number): string[] {
  if (toMs < fromMs) return [];
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const months: string[] = [];
  let year = from.getUTCFullYear();
  let month = from.getUTCMonth();
  while (year < to.getUTCFullYear() || (year === to.getUTCFullYear() && month <= to.getUTCMonth())) {
    months.push(`${year}-${String(month + 1).padStart(2, "0")}`);
    month += 1;
    if (month === 12) {
      month = 0;
      year += 1;
    }
  }
  return months;
}

function objectNameEmitMs(name: string): number | null {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z/.exec(base);
  if (!match) return null;
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Number(match[7])
  );
}

function objectNameWithinWindow(name: string, window: GcsAuditReadWindow): boolean {
  if (window.fromMs === undefined && window.toMs === undefined) return true;
  const emitMs = objectNameEmitMs(name);
  // A window bound means timestamp-based selection: a name that cannot be placed in any window is
  // excluded — including it would refetch the same junk object on every periodic tick forever. The
  // unwindowed arm above keeps including unparsable names: review completeness beats a saved fetch.
  if (emitMs === null) return false;
  if (window.fromMs !== undefined && emitMs < window.fromMs) return false;
  // Half-open [fromMs, toMs), matching buildAuditSummary: consecutive timer ticks tile without
  // fetching (or counting) a boundary-stamped object twice.
  if (window.toMs !== undefined && emitMs >= window.toMs) return false;
  return true;
}

// Normalize-then-validate: surrounding whitespace and a leading gs:// scheme are operator
// spellings of the same bucket, so they are stripped and SERVED rather than failing a deploy over
// punctuation. A "/" in what remains stays a hard error — "bucket/path" is genuinely ambiguous
// with the prefix env — and empty-after-normalize is still missing config.
export function assertGcsAuditBucketShape(bucket: string | undefined): string {
  const normalized = (bucket ?? "").trim().replace(/^gs:\/\//i, "");
  if (normalized.length === 0) {
    throw new Error(`${AUDIT_GCS_BUCKET_ENV} is required when ${AUDIT_BACKEND_ENV}=gcs_object.`);
  }
  if (normalized.includes("/")) {
    throw new Error(`${AUDIT_GCS_BUCKET_ENV} must be a bucket name without path segments.`);
  }
  return normalized;
}

export function normalizeGcsAuditPrefix(prefix: string): string {
  const normalized = prefix.trim().replace(/^\/+|\/+$/g, "");
  if (normalized.length === 0) {
    throw new Error(`${AUDIT_GCS_PREFIX_ENV} must contain a non-empty object prefix when set.`);
  }
  return normalized;
}
