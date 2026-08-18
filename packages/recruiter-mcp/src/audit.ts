import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { RecruiterAuditClient, RecruiterSurface, RecruiterToolKind } from "./types.js";

export const DEFAULT_AUDIT_FILE_MODE = 0o600;
export const AUDIT_UNAVAILABLE_ERROR_MESSAGE = "SCOPED_GREENHOUSE_AUDIT_UNAVAILABLE";

export class AuditUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super(AUDIT_UNAVAILABLE_ERROR_MESSAGE);
    this.name = "AuditUnavailableError";
  }
}

export type ResumeAuditErrorClass =
  | "invalid_attachment_id"
  | "not_found_or_not_permitted"
  | "authorization_failed"
  | "metadata_timeout"
  | "metadata_failed"
  | "cancelled"
  | "invalid_signed_url"
  | "expired_url"
  | "expired_url_not_refreshed"
  | "redirect_refused"
  | "download_timeout"
  | "download_failed"
  | "download_http"
  | "unsupported_type"
  | "size_limit"
  | "encrypted"
  | "malformed"
  | "suspicious"
  | "no_extractable_text"
  | "parse_timeout"
  | "parser_busy";

export interface RecruiterAuditEvent {
  /** Absent on retained v1 rows. New rows are always schema version 2. */
  schemaVersion?: 2;
  event: "scoped_greenhouse_tool_call";
  auditStage?: "start" | "terminal";
  at?: string;
  surface: RecruiterSurface;
  client?: RecruiterAuditClient;
  tokenId?: string | null;
  tool: string;
  toolKind: RecruiterToolKind;
  actorGreenhouseUserId: number | null;
  effectiveGreenhouseUserId: number | null;
  operator: boolean;
  actAsUser: number | null;
  permissionScopeKind: "unknown" | "jobs" | "all";
  permittedJobCount: number | null;
  rowsRead: number | null;
  rowsReturned: number | null;
  denialCode: string | null;
  durationMs: number;
  correlationId: string;
  outcome?: "started" | "success" | "denied" | "cancelled" | "failed";
  failurePhase?: "authorization" | "rate_limit" | "tool" | "audit" | null;
  cancellationReason?: string | null;
  pagesRead?: number | null;
  retries?: number | null;
  cacheHits?: number | null;
  phaseTimingsMs?: {
    total: number;
    preflight: number;
    authorizationOrScope: number;
    tool: number;
  };
  resolvedJobIds?: number[] | null;
  resolvedJobCount?: number | null;
  resolvedJobHash?: string | null;
  /** Optional, metadata-only scope-resolution fields (no raw prompts/payloads). */
  scopeAction?: "resolve" | "confirm" | "get" | "redeem" | "capabilities";
  scopeResolutionStatus?: string | null;
  scopeStatus?: string | null;
  scopeJobCount?: number | null;
  scopeConfirmationRequired?: boolean | null;
  scopeHash?: string | null;
  /** Optional terminal-only metadata for read_my_resume. Never contains names, URLs, raw document bytes, or text. */
  resumeAttachmentId?: number;
  resumeApplicationId?: number;
  resumeCandidateId?: number;
  resumeContentType?: "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document" | "text/plain";
  resumeDownloadedBytes?: number;
  resumeExtractedBytes?: number;
  resumeOutputTruncated?: boolean;
  resumeDownloadMs?: number;
  resumeParseMs?: number;
  resumeErrorClass?: ResumeAuditErrorClass | null;
}

export interface AuditSink {
  emit(event: RecruiterAuditEvent): void | Promise<void>;
}

export interface JsonlAuditSinkOptions {
  mkdir?: boolean;
  fileMode?: number;
}

export interface EnvAuditSinkOptions {
  requireRetained?: boolean;
}

export function createConsoleAuditSink(): AuditSink {
  return {
    emit(event) {
      console.error(`[greenhouse-recruiter-mcp] AUDIT ${JSON.stringify(event)}`);
    },
  };
}

export function createAuditSinkFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: EnvAuditSinkOptions = {}
): AuditSink {
  const jsonlPath = env.GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH;
  if (jsonlPath) {
    return createJsonlAuditSink(jsonlPath);
  }
  if (options.requireRetained) {
    throw new Error("GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH is required for hosted recruiter MCP audit retention.");
  }
  return createConsoleAuditSink();
}

export async function preflightRetainedAuditSinkFromEnv(
  env: NodeJS.ProcessEnv = process.env
): Promise<AuditSink> {
  try {
    const normalizedPath = validateAuditJsonlPath(env.GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH);
    await assertJsonlAuditPathAppendable(normalizedPath);
    return createJsonlAuditSink(normalizedPath, { mkdir: false });
  } catch (error) {
    if (isAuditUnavailableError(error)) throw error;
    throw new AuditUnavailableError(error);
  }
}

export function createJsonlAuditSink(path: string, options: JsonlAuditSinkOptions = {}): AuditSink {
  const normalizedPath = validateAuditJsonlPath(path);
  const fileMode = options.fileMode ?? DEFAULT_AUDIT_FILE_MODE;
  const ready = options.mkdir === false
    ? Promise.resolve()
    : mkdir(dirname(normalizedPath), { recursive: true });
  return {
    async emit(event) {
      await ready;
      await appendFile(normalizedPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: fileMode });
      await chmod(normalizedPath, fileMode);
    },
  };
}

export function validateAuditJsonlPath(path: string | undefined): string {
  const normalizedPath = path?.trim() ?? "";
  if (!normalizedPath) {
    throw new Error("GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH must not be empty.");
  }
  if (!isAbsolute(normalizedPath)) {
    throw new Error("GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH must be an absolute path to retained storage.");
  }
  if (!normalizedPath.endsWith(".jsonl")) {
    throw new Error("GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH must end with .jsonl.");
  }
  return normalizedPath;
}

async function assertJsonlAuditPathAppendable(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  try {
    await handle.appendFile("");
  } finally {
    await handle.close();
  }
  await chmod(path, DEFAULT_AUDIT_FILE_MODE);
}

export function createMemoryAuditSink(): AuditSink & { events: RecruiterAuditEvent[]; allEvents: RecruiterAuditEvent[] } {
  const events: RecruiterAuditEvent[] = [];
  const allEvents: RecruiterAuditEvent[] = [];
  return {
    events,
    allEvents,
    emit(event) {
      allEvents.push(event);
      if (event.auditStage !== "start") events.push(event);
    },
  };
}

// Wraps any sink and counts events that emit successfully (the inner sink does not throw). Lets a
// caller report the ACTUAL number of persisted audit events for any sink type — a file/console sink
// has no `.events` array to length, so the leakage sampler used to substitute `checks.length`, a
// fabricated count. `count` reflects only successful emits: if the inner sink throws (e.g. the JSONL
// path is unavailable), the event is not counted, and the throw propagates to the caller.
export function createCountingAuditSink(inner: AuditSink): AuditSink & { readonly count: number } {
  let count = 0;
  return {
    get count() {
      return count;
    },
    async emit(event) {
      await inner.emit(event);
      count += 1;
    },
  };
}

export async function emitAudit(sink: AuditSink, event: RecruiterAuditEvent): Promise<void> {
  try {
    await sink.emit(event);
  } catch (error) {
    if (isAuditUnavailableError(error)) throw error;
    throw new AuditUnavailableError(error);
  }
}

export function isAuditUnavailableError(error: unknown): error is AuditUnavailableError {
  return error instanceof AuditUnavailableError ||
    (error instanceof Error && error.name === "AuditUnavailableError" && error.message === AUDIT_UNAVAILABLE_ERROR_MESSAGE);
}

export function newCorrelationId(now: () => number = () => Date.now()): string {
  return `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function resolvedJobHash(jobIds: readonly number[]): string {
  return createHash("sha256").update([...jobIds].sort((a, b) => a - b).join(","), "utf8").digest("hex");
}
