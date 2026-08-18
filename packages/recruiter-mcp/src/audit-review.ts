import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { RecruiterAuditEvent } from "./audit.js";
import { resolvedJobHash } from "./audit.js";
import { containsTokenOrConfigPayload } from "./evidence-hygiene.js";
import { RECRUITER_TOOL_DEFINITIONS } from "./tools/register.js";
import type { RecruiterClient, RecruiterSurface, RecruiterToolKind } from "./types.js";

export interface AuditReviewCheck {
  name: string;
  status: "pass" | "fail";
  summary: string;
  details?: Record<string, unknown>;
}

export interface AuditReviewReport {
  reportVersion: 2;
  ok: boolean;
  status: "pass" | "fail";
  reviewedAt: string;
  reviewer: string;
  auditPath: string;
  totalEvents: number;
  successEvents: number;
  denialEvents: number;
  v2StartEvents: number;
  v2TerminalEvents: number;
  undatedLegacyEvents: number;
  unmatchedV2StartEvents: number;
  legacyUnknownV2TerminalEvents: number;
  surfaces: RecruiterSurface[];
  v2Clients: RecruiterClient[];
  toolKinds: RecruiterToolKind[];
  retainedAuditSink: boolean;
  successEventsPresent: boolean;
  denialEventsPresent: boolean;
  surfaceCoveragePresent: boolean;
  v2ClientCoveragePresent: boolean;
  toolKindCoveragePresent: boolean;
  noSensitivePayloadsFound: boolean;
  checks: AuditReviewCheck[];
}

export interface AuditReviewOptions {
  auditPath: string;
  reviewer?: string;
  now?: () => Date;
}

// Base metadata keys present on EVERY audit line (evidence, analysis, and scope-resolution calls).
const REQUIRED_AUDIT_EVENT_KEYS = new Set<keyof RecruiterAuditEvent>([
  "event",
  "surface",
  "tool",
  "toolKind",
  "actorGreenhouseUserId",
  "effectiveGreenhouseUserId",
  "operator",
  "actAsUser",
  "permissionScopeKind",
  "permittedJobCount",
  "rowsRead",
  "rowsReturned",
  "denialCode",
  "durationMs",
  "correlationId",
]);
// v2 scope-resolution audit fields. OPTIONAL and metadata-only: they appear on resolve / confirm /
// get / capabilities audit lines (emitRequiredToolAudit `extra`) and are absent on evidence/analysis
// lines. The cert MUST recognize them or it rejects every real scope-resolution audit line as an
// "unknown audit key" and the whole audit_schema_closed gate fails — but each is shape-validated so
// free text or PII cannot ride in under a scope_* name. Verified metadata-only against the post-flip
// evidence-projection.ts denylist: scopeHash is a job-id-set sha256 prefix, the statuses are resolver
// enum codes, the rest are a count / boolean / fixed action enum — none carry projected payload data.
const OPTIONAL_AUDIT_EVENT_KEYS = new Set<keyof RecruiterAuditEvent>([
  "scopeAction",
  "scopeResolutionStatus",
  "scopeStatus",
  "scopeJobCount",
  "scopeConfirmationRequired",
  "scopeHash",
  "schemaVersion",
  "auditStage",
  "at",
  "client",
  "tokenId",
  "outcome",
  "failurePhase",
  "cancellationReason",
  "pagesRead",
  "retries",
  "cacheHits",
  "phaseTimingsMs",
  "resolvedJobIds",
  "resolvedJobCount",
  "resolvedJobHash",
  "resumeAttachmentId",
  "resumeApplicationId",
  "resumeCandidateId",
  "resumeContentType",
  "resumeDownloadedBytes",
  "resumeExtractedBytes",
  "resumeOutputTruncated",
  "resumeDownloadMs",
  "resumeParseMs",
  "resumeErrorClass",
]);
const ALLOWED_AUDIT_EVENT_KEYS = new Set<keyof RecruiterAuditEvent>([
  ...REQUIRED_AUDIT_EVENT_KEYS,
  ...OPTIONAL_AUDIT_EVENT_KEYS,
]);
const SCOPE_ACTION_VALUES = new Set<string>(["resolve", "confirm", "get", "redeem", "capabilities"]);
// Lowercase snake_case status codes (resolver ResolutionStatus + ScopeStatus enums: resolved,
// needs_confirmation, confirmed, proposed, rejected, expired, needs_revision, forbidden, invalid, …).
// Shape-validated, not enum-pinned, so a future resolver status does not silently fail the cert; but
// spaces / capitals / @ / punctuation — i.e. free text, names, emails — are rejected.
const SCOPE_STATUS_CODE_VALUE = /^[a-z][a-z0-9_]{1,63}$/;
// scopeHash is scopeHashOf(): a sha256 hex digest sliced to 16 chars. Accept 16–64 lowercase hex so a
// longer digest stays valid; reject anything non-hex so a name / email / free-text cannot masquerade.
const SCOPE_HASH_VALUE = /^[0-9a-f]{16,64}$/;
const TOKEN_ID_VALUE = /^[A-Za-z0-9:_-]{1,160}$/;
const V2_REQUIRED_AUDIT_EVENT_KEYS = new Set<keyof RecruiterAuditEvent>([
  "schemaVersion", "auditStage", "at", "client", "tokenId", "outcome", "failurePhase",
  "cancellationReason", "pagesRead", "retries", "cacheHits", "phaseTimingsMs",
  "resolvedJobIds", "resolvedJobCount", "resolvedJobHash",
]);

const EMAIL_LIKE_VALUE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const CODE_SHAPED_VALUE = /^[A-Z][A-Z0-9_]{1,63}$/;
const OPAQUE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,96}$/;
const RESUME_CONTENT_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
]);
const RESUME_ERROR_CLASSES = new Set([
  "invalid_attachment_id",
  "not_found_or_not_permitted",
  "authorization_failed",
  "metadata_timeout",
  "metadata_failed",
  "cancelled",
  "invalid_signed_url",
  "expired_url",
  "expired_url_not_refreshed",
  "redirect_refused",
  "download_timeout",
  "download_failed",
  "download_http",
  "unsupported_type",
  "size_limit",
  "encrypted",
  "malformed",
  "suspicious",
  "no_extractable_text",
  "parse_timeout",
  "parser_busy",
]);
const REQUIRED_AUDIT_SURFACES: readonly RecruiterSurface[] = ["chatgpt_desktop", "claude_desktop"];
const REQUIRED_AUDIT_CLIENTS: readonly RecruiterClient[] = ["claude_desktop_chat", "claude_code", "chatgpt_codex_host"];
const REQUIRED_AUDIT_TOOL_KINDS: readonly RecruiterToolKind[] = ["evidence", "analysis"];
const APPROVED_AUDIT_TOOL_NAMES = new Set(RECRUITER_TOOL_DEFINITIONS.map((tool) => tool.name));

export async function runAuditReview(options: AuditReviewOptions): Promise<AuditReviewReport> {
  const auditPath = options.auditPath.trim();
  const reportAuditPath = auditPathForReport(auditPath);
  const reviewer = options.reviewer?.trim() || "unknown";
  const checks: AuditReviewCheck[] = [];
  let raw = "";
  try {
    raw = await readFile(auditPath, "utf8");
    checks.push({ name: "audit_file_readable", status: "pass", summary: "Audit JSONL file was read." });
  } catch {
    checks.push({
      name: "audit_file_readable",
      status: "fail",
      summary: "Audit JSONL file could not be read.",
    });
    return buildReport(options, reviewer, reportAuditPath, checks, 0, 0, 0);
  }

  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let validEvents = 0;
  let successEvents = 0;
  let denialEvents = 0;
  let v2StartEvents = 0;
  let v2TerminalEvents = 0;
  let undatedLegacyEvents = 0;
  let legacyUnknownV2TerminalEvents = 0;
  const surfaces = new Set<RecruiterSurface>();
  const v2Clients = new Set<RecruiterClient>();
  const toolKinds = new Set<RecruiterToolKind>();
  const invalidLines: number[] = [];
  const schemaViolations: Array<{ line: number; reason: string }> = [];
  const sensitiveLines: number[] = [];
  const credentialLines: number[] = [];
  const v2Starts = new Map<string, RecruiterAuditEvent>();
  const v2Terminals = new Map<string, RecruiterAuditEvent>();

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      invalidLines.push(lineNumber);
      return;
    }
    const hasEmailLikeValue = containsEmailLikeValue(parsed);
    const hasCredentialLikeValue = containsTokenOrConfigPayload(parsed);
    const schemaResult = validateAuditEventShape(parsed);
    if (!schemaResult.ok) {
      if (hasEmailLikeValue) sensitiveLines.push(lineNumber);
      if (hasCredentialLikeValue) credentialLines.push(lineNumber);
      schemaViolations.push({ line: lineNumber, reason: schemaResult.reason });
      return;
    }
    if (hasEmailLikeValue) {
      sensitiveLines.push(lineNumber);
      return;
    }
    if (hasCredentialLikeValue) {
      credentialLines.push(lineNumber);
      return;
    }
    if (schemaResult.event.schemaVersion === 2 && schemaResult.event.auditStage === "start") {
      v2StartEvents += 1;
      v2Starts.set(schemaResult.event.correlationId, schemaResult.event);
    } else {
      validEvents += 1;
      if (schemaResult.event.schemaVersion === 2) v2TerminalEvents += 1;
      if (schemaResult.event.schemaVersion === 2) {
        v2Terminals.set(schemaResult.event.correlationId, schemaResult.event);
        if (schemaResult.event.client === "legacy_unknown") legacyUnknownV2TerminalEvents += 1;
        else if (schemaResult.event.client) v2Clients.add(schemaResult.event.client);
      }
      else if (schemaResult.event.at === undefined) undatedLegacyEvents += 1;
      surfaces.add(schemaResult.event.surface);
      toolKinds.add(schemaResult.event.toolKind);
      if (schemaResult.event.denialCode === null) successEvents += 1;
      else denialEvents += 1;
    }
  });

  checks.push(lines.length > 0
    ? { name: "audit_events_present", status: "pass", summary: "Audit file contains retained events.", details: { eventLines: lines.length } }
    : { name: "audit_events_present", status: "fail", summary: "Audit file contains no events." });
  checks.push(invalidLines.length === 0
    ? { name: "audit_json_valid", status: "pass", summary: "Every retained audit line is valid JSON." }
    : { name: "audit_json_valid", status: "fail", summary: "One or more retained audit lines are invalid JSON.", details: { invalidLines } });
  checks.push(schemaViolations.length === 0
    ? { name: "audit_schema_closed", status: "pass", summary: "Audit events use the closed metadata-only schema." }
    : { name: "audit_schema_closed", status: "fail", summary: "One or more audit events failed the closed-schema review.", details: { schemaViolations } });
  checks.push(sensitiveLines.length === 0
    ? { name: "audit_no_email_like_values", status: "pass", summary: "No email-like values were found in retained audit events." }
    : { name: "audit_no_email_like_values", status: "fail", summary: "Email-like values were found in retained audit events.", details: { sensitiveLines } });
  checks.push(credentialLines.length === 0
    ? { name: "audit_no_credential_like_values", status: "pass", summary: "No credential-like values were found in retained audit events." }
    : { name: "audit_no_credential_like_values", status: "fail", summary: "Credential-like values were found in retained audit events.", details: { credentialLines } });
  checks.push(successEvents > 0
    ? { name: "audit_success_events_present", status: "pass", summary: "Retained audit sample includes success events.", details: { successEvents } }
    : { name: "audit_success_events_present", status: "fail", summary: "Retained audit sample has no success events." });
  checks.push(denialEvents > 0
    ? { name: "audit_denial_events_present", status: "pass", summary: "Retained audit sample includes denial events.", details: { denialEvents } }
    : { name: "audit_denial_events_present", status: "fail", summary: "Retained audit sample has no denial events." });
  checks.push(hasAll(surfaces, REQUIRED_AUDIT_SURFACES)
    ? { name: "audit_surface_coverage", status: "pass", summary: "Retained audit sample includes both desktop surfaces.", details: { surfaces: [...surfaces].sort() } }
    : { name: "audit_surface_coverage", status: "fail", summary: "Retained audit sample must include ChatGPT Desktop and Claude Desktop events.", details: { surfaces: [...surfaces].sort(), requiredSurfaces: REQUIRED_AUDIT_SURFACES } });
  checks.push(hasAll(v2Clients, REQUIRED_AUDIT_CLIENTS)
    ? { name: "audit_v2_client_coverage", status: "pass", summary: "Retained v2 audit terminals include Claude Desktop, Claude Code, and ChatGPT/Codex attribution.", details: { clients: [...v2Clients].sort() } }
    : { name: "audit_v2_client_coverage", status: "fail", summary: "Retained v2 audit terminals must cover all three physical clients.", details: { clients: [...v2Clients].sort(), requiredClients: REQUIRED_AUDIT_CLIENTS, legacyUnknownV2TerminalEvents } });
  checks.push(hasAll(toolKinds, REQUIRED_AUDIT_TOOL_KINDS)
    ? { name: "audit_tool_kind_coverage", status: "pass", summary: "Retained audit sample includes evidence and analysis tool calls.", details: { toolKinds: [...toolKinds].sort() } }
    : { name: "audit_tool_kind_coverage", status: "fail", summary: "Retained audit sample must include evidence and analysis tool calls.", details: { toolKinds: [...toolKinds].sort(), requiredToolKinds: REQUIRED_AUDIT_TOOL_KINDS } });
  const orphanTerminals = [...v2Terminals.keys()].filter((correlationId) => !v2Starts.has(correlationId));
  checks.push(orphanTerminals.length === 0
    ? { name: "audit_v2_terminal_has_start", status: "pass", summary: "Every v2 terminal row has a retained start row." }
    : { name: "audit_v2_terminal_has_start", status: "fail", summary: "One or more v2 terminal rows have no retained start row.", details: { orphanTerminalCount: orphanTerminals.length } });
  const mismatchedPairs = [...v2Terminals.entries()].flatMap(([correlationId, terminal]) => {
    const start = v2Starts.get(correlationId);
    if (!start || v2PairAttributionMatches(start, terminal)) return [];
    return [correlationId];
  });
  checks.push(mismatchedPairs.length === 0
    ? { name: "audit_v2_pair_attribution", status: "pass", summary: "Every v2 start/terminal pair has coherent client attribution." }
    : { name: "audit_v2_pair_attribution", status: "fail", summary: "One or more v2 start/terminal pairs disagree on surface, client, token id, or tool.", details: { mismatchedPairCount: mismatchedPairs.length } });
  const unmatchedV2StartEvents = [...v2Starts.keys()].filter((correlationId) => !v2Terminals.has(correlationId)).length;

  return buildReport(options, reviewer, reportAuditPath, checks, validEvents, successEvents, denialEvents, [...surfaces].sort(), [...toolKinds].sort(), v2StartEvents, v2TerminalEvents, undatedLegacyEvents, unmatchedV2StartEvents, [...v2Clients].sort(), legacyUnknownV2TerminalEvents);
}

export async function runAuditReviewFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: Pick<AuditReviewOptions, "now"> = {}
): Promise<AuditReviewReport> {
  const auditPath = env.GREENHOUSE_RECRUITER_AUDIT_REVIEW_JSONL_PATH ?? env.GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH;
  if (!auditPath) {
    return buildReport(
      options,
      env.GREENHOUSE_RECRUITER_AUDIT_REVIEWER?.trim() || "unknown",
      "",
      [{ name: "audit_path", status: "fail", summary: "GREENHOUSE_RECRUITER_AUDIT_JSONL_PATH is required." }],
      0,
      0,
      0,
      [],
      []
    );
  }
  return runAuditReview({
    ...options,
    auditPath,
    reviewer: env.GREENHOUSE_RECRUITER_AUDIT_REVIEWER,
  });
}

export async function startAuditReviewCli(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv.slice(2)
): Promise<void> {
  const parsed = parseArgs(args);
  const report = parsed.auditPath
    ? await runAuditReview({ auditPath: parsed.auditPath, reviewer: parsed.reviewer ?? env.GREENHOUSE_RECRUITER_AUDIT_REVIEWER })
    : await runAuditReviewFromEnv(env);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

function buildReport(
  options: Pick<AuditReviewOptions, "now">,
  reviewer: string,
  auditPath: string,
  checks: AuditReviewCheck[],
  totalEvents: number,
  successEvents: number,
  denialEvents: number,
  surfaces: RecruiterSurface[] = [],
  toolKinds: RecruiterToolKind[] = [],
  v2StartEvents = 0,
  v2TerminalEvents = 0,
  undatedLegacyEvents = 0,
  unmatchedV2StartEvents = 0,
  v2Clients: RecruiterClient[] = [],
  legacyUnknownV2TerminalEvents = 0
): AuditReviewReport {
  const ok = checks.every((check) => check.status === "pass");
  return {
    reportVersion: 2,
    ok,
    status: ok ? "pass" : "fail",
    reviewedAt: (options.now ?? (() => new Date()))().toISOString(),
    reviewer,
    auditPath,
    totalEvents,
    successEvents,
    denialEvents,
    v2StartEvents,
    v2TerminalEvents,
    undatedLegacyEvents,
    unmatchedV2StartEvents,
    legacyUnknownV2TerminalEvents,
    surfaces,
    v2Clients,
    toolKinds,
    retainedAuditSink: totalEvents > 0,
    successEventsPresent: successEvents > 0,
    denialEventsPresent: denialEvents > 0,
    surfaceCoveragePresent: hasAll(new Set(surfaces), REQUIRED_AUDIT_SURFACES),
    v2ClientCoveragePresent: hasAll(new Set(v2Clients), REQUIRED_AUDIT_CLIENTS),
    toolKindCoveragePresent: hasAll(new Set(toolKinds), REQUIRED_AUDIT_TOOL_KINDS),
    noSensitivePayloadsFound: checks.every((check) => ![
      "audit_schema_closed",
      "audit_no_email_like_values",
      "audit_no_credential_like_values",
    ].includes(check.name) || check.status === "pass"),
    checks,
  };
}

function validateAuditEventShape(value: unknown): { ok: true; event: RecruiterAuditEvent } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return { ok: false, reason: "event is not an object" };
  }
  const keys = Object.keys(value);
  const unknownKeys = keys.filter((key) => !ALLOWED_AUDIT_EVENT_KEYS.has(key as keyof RecruiterAuditEvent));
  if (unknownKeys.length > 0) {
    return { ok: false, reason: `unknown audit key(s): ${unknownKeys.join(", ")}` };
  }
  const missingKeys = [...REQUIRED_AUDIT_EVENT_KEYS].filter((key) => !(key in value));
  if (missingKeys.length > 0) {
    return { ok: false, reason: `missing audit key(s): ${missingKeys.join(", ")}` };
  }
  if (value.schemaVersion !== undefined && value.schemaVersion !== 2) return { ok: false, reason: "invalid schemaVersion" };
  if (value.schemaVersion === 2) {
    const missingV2Keys = [...V2_REQUIRED_AUDIT_EVENT_KEYS].filter((key) => !(key in value));
    if (missingV2Keys.length > 0) return { ok: false, reason: `missing v2 audit key(s): ${missingV2Keys.join(", ")}` };
    const v2Reason = validateV2AuditFields(value);
    if (v2Reason) return { ok: false, reason: v2Reason };
  } else {
    const v2Keys = [...V2_REQUIRED_AUDIT_EVENT_KEYS].filter((key) => key !== "schemaVersion" && key in value);
    if (v2Keys.length > 0) return { ok: false, reason: "v2 audit keys require schemaVersion=2" };
  }
  if (value.event !== "scoped_greenhouse_tool_call") return { ok: false, reason: "invalid event" };
  if (!isSurface(value.surface)) return { ok: false, reason: "invalid surface" };
  if (typeof value.tool !== "string" || !APPROVED_AUDIT_TOOL_NAMES.has(value.tool)) return { ok: false, reason: "invalid tool" };
  if (value.toolKind !== "evidence" && value.toolKind !== "analysis") return { ok: false, reason: "invalid toolKind" };
  if (!isNullablePositiveSafeInteger(value.actorGreenhouseUserId)) return { ok: false, reason: "invalid actorGreenhouseUserId" };
  if (!isNullablePositiveSafeInteger(value.effectiveGreenhouseUserId)) return { ok: false, reason: "invalid effectiveGreenhouseUserId" };
  if (typeof value.operator !== "boolean") return { ok: false, reason: "invalid operator" };
  if (!isNullablePositiveSafeInteger(value.actAsUser)) return { ok: false, reason: "invalid actAsUser" };
  if (value.permissionScopeKind !== "unknown" && value.permissionScopeKind !== "jobs" && value.permissionScopeKind !== "all") return { ok: false, reason: "invalid permissionScopeKind" };
  if (!isNullableNonNegativeSafeInteger(value.permittedJobCount)) return { ok: false, reason: "invalid permittedJobCount" };
  if (!isNullableNonNegativeSafeInteger(value.rowsRead)) return { ok: false, reason: "invalid rowsRead" };
  if (!isNullableNonNegativeSafeInteger(value.rowsReturned)) return { ok: false, reason: "invalid rowsReturned" };
  if (value.denialCode !== null && (typeof value.denialCode !== "string" || !CODE_SHAPED_VALUE.test(value.denialCode))) return { ok: false, reason: "invalid denialCode" };
  if (typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0) return { ok: false, reason: "invalid durationMs" };
  if (typeof value.correlationId !== "string" || !OPAQUE_CORRELATION_ID.test(value.correlationId)) return { ok: false, reason: "invalid correlationId" };
  const scopeFieldReason = validateScopeAuditFields(value);
  if (scopeFieldReason) return { ok: false, reason: scopeFieldReason };
  const resumeFieldReason = validateResumeAuditFields(value);
  if (resumeFieldReason) return { ok: false, reason: resumeFieldReason };
  return { ok: true, event: value as unknown as RecruiterAuditEvent };
}

function validateV2AuditFields(value: Record<string, unknown>): string | null {
  if (value.auditStage !== "start" && value.auditStage !== "terminal") return "invalid auditStage";
  if (typeof value.at !== "string" || Number.isNaN(Date.parse(value.at)) || new Date(Date.parse(value.at)).toISOString() !== value.at) return "invalid at";
  if (value.client !== "claude_desktop_chat" && value.client !== "claude_code" && value.client !== "chatgpt_codex_host" && value.client !== "legacy_unknown") return "invalid client";
  if ((value.client === "chatgpt_codex_host" && value.surface !== "chatgpt_desktop") ||
      ((value.client === "claude_desktop_chat" || value.client === "claude_code") && value.surface !== "claude_desktop")) return "client/surface mismatch";
  if (value.tokenId !== null && (typeof value.tokenId !== "string" || !TOKEN_ID_VALUE.test(value.tokenId))) return "invalid tokenId";
  if (!["started", "success", "denied", "cancelled", "failed"].includes(String(value.outcome))) return "invalid outcome";
  if ((value.auditStage === "start") !== (value.outcome === "started")) return "auditStage/outcome mismatch";
  if (value.failurePhase !== null && !["authorization", "rate_limit", "tool", "audit"].includes(String(value.failurePhase))) return "invalid failurePhase";
  if (value.cancellationReason !== null && (typeof value.cancellationReason !== "string" || !CODE_SHAPED_VALUE.test(value.cancellationReason))) return "invalid cancellationReason";
  for (const key of ["pagesRead", "retries", "cacheHits"] as const) {
    if (!isNullableNonNegativeSafeInteger(value[key])) return `invalid ${key}`;
  }
  if (!isRecord(value.phaseTimingsMs)) return "invalid phaseTimingsMs";
  const phaseTimings = value.phaseTimingsMs;
  const phaseKeys = ["total", "preflight", "authorizationOrScope", "tool"] as const;
  if (Object.keys(phaseTimings).some((key) => !phaseKeys.includes(key as typeof phaseKeys[number])) ||
      phaseKeys.some((key) => !isNonNegativeFiniteNumber(phaseTimings[key]))) return "invalid phaseTimingsMs";
  const phaseTotal = phaseKeys.slice(1).reduce((sum, key) => sum + Number(phaseTimings[key]), 0);
  if (Math.abs(phaseTotal - Number(phaseTimings.total)) > 0.001 ||
      Math.abs(Number(phaseTimings.total) - Number(value.durationMs)) > 0.001) return "incoherent phaseTimingsMs";
  const ids = value.resolvedJobIds;
  const count = value.resolvedJobCount;
  const hash = value.resolvedJobHash;
  if (ids === null || count === null || hash === null) {
    if (!(ids === null && count === null && hash === null)) return "incomplete resolved job metadata";
  } else {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)) return "invalid resolvedJobIds";
    if (ids.some((id, index) => index > 0 && id <= ids[index - 1]!)) return "resolvedJobIds must be sorted and unique";
    if (!isNullableNonNegativeSafeInteger(count) || count !== ids.length) return "resolvedJobCount mismatch";
    if (typeof hash !== "string" || hash !== resolvedJobHash(ids)) return "resolvedJobHash mismatch";
  }
  if (value.auditStage === "terminal" && value.outcome === "success" && value.permissionScopeKind === "jobs") {
    if (ids === null) return "successful jobs-scoped terminal requires resolved job metadata";
    if (!isNullableNonNegativeSafeInteger(value.permittedJobCount) || value.permittedJobCount === null) return "successful jobs-scoped terminal requires permittedJobCount";
  }
  if ((value.permissionScopeKind === "all" || value.permissionScopeKind === "unknown") && value.permittedJobCount !== null) {
    return "non-jobs scope must not have permittedJobCount";
  }
  return null;
}

function v2PairAttributionMatches(start: RecruiterAuditEvent, terminal: RecruiterAuditEvent): boolean {
  return start.surface === terminal.surface
    && start.client === terminal.client
    && start.tokenId === terminal.tokenId
    && start.tool === terminal.tool;
}

// Per-field validators for the optional v2 scope-resolution fields. Each runs only when the field is
// present (the fields are optional); an absent field is fine, a malformed one fails the closed-schema
// cert. Tight shapes here are what keep the wider scope surface from rubber-stamping free text/PII.
function validateScopeAuditFields(value: Record<string, unknown>): string | null {
  if ("scopeAction" in value && !(typeof value.scopeAction === "string" && SCOPE_ACTION_VALUES.has(value.scopeAction))) {
    return "invalid scopeAction";
  }
  if ("scopeResolutionStatus" in value && !isNullableScopeStatusCode(value.scopeResolutionStatus)) {
    return "invalid scopeResolutionStatus";
  }
  if ("scopeStatus" in value && !isNullableScopeStatusCode(value.scopeStatus)) {
    return "invalid scopeStatus";
  }
  if ("scopeJobCount" in value && !isNullableNonNegativeSafeInteger(value.scopeJobCount)) {
    return "invalid scopeJobCount";
  }
  if ("scopeConfirmationRequired" in value && !(value.scopeConfirmationRequired === null || typeof value.scopeConfirmationRequired === "boolean")) {
    return "invalid scopeConfirmationRequired";
  }
  if ("scopeHash" in value && !isNullableScopeHash(value.scopeHash)) {
    return "invalid scopeHash";
  }
  return null;
}

function validateResumeAuditFields(value: Record<string, unknown>): string | null {
  const keys = [
    "resumeAttachmentId",
    "resumeApplicationId",
    "resumeCandidateId",
    "resumeContentType",
    "resumeDownloadedBytes",
    "resumeExtractedBytes",
    "resumeOutputTruncated",
    "resumeDownloadMs",
    "resumeParseMs",
    "resumeErrorClass",
  ];
  const present = keys.filter((key) => key in value);
  const isResumeTerminal = value.tool === "read_my_resume" && value.auditStage === "terminal";
  if (present.length === 0 && !isResumeTerminal) return null;
  if (
    present.length === 0
    && isResumeTerminal
    && value.outcome !== "success"
    && (value.denialCode === "TOOL_DISABLED" || value.denialCode === "RATE_LIMITED" || value.denialCode === "AUDIT_UNAVAILABLE")
  ) {
    // These denials happen before the resume runner owns attachment/error metadata. They remain
    // valid generic terminal audit rows; every post-preflight resume denial carries a fixed class.
    return null;
  }
  if (!isResumeTerminal) {
    return "resume audit metadata is terminal-only for read_my_resume";
  }
  for (const key of ["resumeAttachmentId", "resumeApplicationId", "resumeCandidateId"]) {
    if (key in value && !isPositiveSafeInteger(value[key])) return `invalid ${key}`;
  }
  if ("resumeContentType" in value && !(typeof value.resumeContentType === "string" && RESUME_CONTENT_TYPES.has(value.resumeContentType))) {
    return "invalid resumeContentType";
  }
  for (const key of ["resumeDownloadedBytes", "resumeExtractedBytes", "resumeDownloadMs", "resumeParseMs"]) {
    if (key in value && !isNonNegativeSafeInteger(value[key])) return `invalid ${key}`;
  }
  if ("resumeOutputTruncated" in value && typeof value.resumeOutputTruncated !== "boolean") {
    return "invalid resumeOutputTruncated";
  }
  if ("resumeErrorClass" in value && value.resumeErrorClass !== null && !(typeof value.resumeErrorClass === "string" && RESUME_ERROR_CLASSES.has(value.resumeErrorClass))) {
    return "invalid resumeErrorClass";
  }
  if (value.outcome === "success") {
    for (const key of [
      "resumeAttachmentId",
      "resumeContentType",
      "resumeDownloadedBytes",
      "resumeExtractedBytes",
      "resumeOutputTruncated",
      "resumeDownloadMs",
      "resumeParseMs",
      "resumeErrorClass",
    ]) {
      if (!(key in value)) return `successful resume audit missing ${key}`;
    }
    if (value.resumeErrorClass !== null) return "successful resume audit has an error class";
  } else if (value.resumeErrorClass === null || value.resumeErrorClass === undefined) {
    return "failed resume audit is missing an error class";
  }
  return null;
}

function isNullableScopeStatusCode(value: unknown): boolean {
  return value === null || (typeof value === "string" && SCOPE_STATUS_CODE_VALUE.test(value));
}

function isNullableScopeHash(value: unknown): boolean {
  return value === null || (typeof value === "string" && SCOPE_HASH_VALUE.test(value));
}

function containsEmailLikeValue(value: unknown): boolean {
  if (typeof value === "string") return EMAIL_LIKE_VALUE.test(value);
  if (Array.isArray(value)) return value.some(containsEmailLikeValue);
  if (!isRecord(value)) return false;
  return Object.values(value).some(containsEmailLikeValue);
}


function hasAll<T extends string>(actual: ReadonlySet<T>, required: readonly T[]): boolean {
  return required.every((entry) => actual.has(entry));
}

function auditPathForReport(auditPath: string): string {
  const trimmed = auditPath.trim();
  if (!trimmed) return "";
  return basename(trimmed) || "audit.jsonl";
}

function parseArgs(args: string[]): { auditPath?: string; reviewer?: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith("--")) continue;
    const next = args[index + 1];
    if (!next || next.startsWith("--")) continue;
    values.set(arg.slice(2), next);
    index += 1;
  }
  return {
    auditPath: values.get("audit") ?? values.get("audit-path"),
    reviewer: values.get("reviewer"),
  };
}

function isSurface(value: unknown): value is RecruiterSurface {
  return value === "chatgpt_desktop" || value === "claude_desktop" || value === "test";
}

function isNullablePositiveSafeInteger(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

function isNullableNonNegativeSafeInteger(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function isPositiveSafeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startAuditReviewCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[greenhouse-recruiter-review-audit] ${message}\n`);
    process.exit(1);
  });
}
