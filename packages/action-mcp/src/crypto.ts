import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { ACTION_KINDS } from "./types.js";
import type {
  ActionBinding,
  ActionClient,
  ActionIntent,
  ActionKind,
  ActionSession,
  PreparedAction,
} from "./types.js";

const MIN_SECRET_BYTES = 32;
const MAX_TOKEN_LENGTH = 131_072;
const SESSION_KIND = "greenhouse_action_session";
const SESSION_AUDIENCE = "greenhouse_action_mcp";
const LEGACY_SESSION_KIND = "greenhouse_assignment_action_session";
const LEGACY_SESSION_AUDIENCE = "greenhouse_assignment_action_mcp";
const INTENT_KIND = "greenhouse_action_intent";
const TOKEN_ID_PATTERN = /^action:[A-Za-z0-9_-]{8,120}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LOCK_KEY_PATTERN = /^(application|candidate|job|offer-chain):[1-9]\d{0,18}$/;
const TOOL_PATTERN = /^apply_[a-z][a-z0-9_]{0,95}$/;
const FIELD_PATTERN = /^(starts_on|first_name|last_name|preferred_name|company|title|time_zone|phone_numbers|addresses|email_addresses|website_addresses|social_media_addresses|tags|linked_user_ids|custom:[a-z0-9_]{1,255})$/;

export interface SessionIssueInput {
  subject: string;
  client: ActionClient;
  tokenId?: string;
  ttlMs?: number;
  nowMs?: number;
}

export type SessionValidationResult =
  | { ok: true; session: ActionSession }
  | { ok: false; reason: string };

export type IntentValidationResult =
  | { ok: true; intent: ActionIntent }
  | { ok: false; reason: "invalid" };

export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_SESSION_TTL_MS = DEFAULT_SESSION_TTL_MS;
export const INTENT_TTL_MS = 5 * 60 * 1000;

export function issueActionSession(
  input: SessionIssueInput,
  secret: string
): { token: string; session: ActionSession } {
  const subject = requireTrimmed(input.subject, "subject");
  const client = requireClient(input.client);
  const now = input.nowMs ?? Date.now();
  const ttl = input.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > MAX_SESSION_TTL_MS) {
    throw new Error("Action session TTL must be a positive integer no greater than 30 days.");
  }
  const tokenId = input.tokenId ?? `action:${randomUUID()}`;
  if (!TOKEN_ID_PATTERN.test(tokenId)) throw new Error("Action session token ID must use the action: namespace.");
  const session: ActionSession = {
    version: 1,
    kind: SESSION_KIND,
    audience: SESSION_AUDIENCE,
    subject,
    client,
    tokenId,
    issuedAtMs: now,
    expiresAtMs: now + ttl,
  };
  return { token: signJson(session, sessionKey(secret)), session };
}

export function validateActionSession(token: string | undefined, secret: string, nowMs = Date.now()): SessionValidationResult {
  const parsed = verifyJson(token, sessionKey(secret));
  if (!parsed || !isExactSession(parsed)) return { ok: false, reason: "Action session token is invalid." };
  const session = parsed as unknown as ActionSession;
  if (session.issuedAtMs > nowMs + 60_000) return { ok: false, reason: "Action session token was issued in the future." };
  if (session.expiresAtMs <= nowMs) return { ok: false, reason: "Action session token has expired." };
  if (session.expiresAtMs - session.issuedAtMs > MAX_SESSION_TTL_MS) {
    return { ok: false, reason: "Action session token exceeds the maximum lifetime." };
  }
  return { ok: true, session };
}

export function issueActionIntent(input: {
  session: ActionSession;
  identityId: string;
  actorUserId: number;
  applyTool: string;
  prepared: PreparedAction;
  nowMs: number;
}, secret: string): { token: string; intent: ActionIntent } {
  const intent: ActionIntent = {
    version: 2,
    kind: INTENT_KIND,
    actionId: randomUUID(),
    actionKind: input.prepared.actionKind,
    subject: input.session.subject,
    identityId: input.identityId,
    actorUserId: input.actorUserId,
    sessionTokenId: input.session.tokenId,
    client: input.session.client,
    applyTool: input.applyTool,
    lockKey: input.prepared.lockKey,
    scopeJobId: input.prepared.scopeJobId,
    binding: input.prepared.binding,
    currentFingerprint: input.prepared.currentFingerprint,
    desiredFingerprint: input.prepared.desiredFingerprint,
    approvalFingerprint: input.prepared.approvalFingerprint,
    highImpact: input.prepared.highImpact,
    reconciliationGraceMs: input.prepared.reconciliationGraceMs,
    issuedAtMs: input.nowMs,
    expiresAtMs: input.nowMs + INTENT_TTL_MS,
  };
  if (!isExactIntent(intent as unknown as Record<string, unknown>)) throw new Error("Prepared action intent is invalid.");
  return { token: signJson(intent, intentKey(secret)), intent };
}

export function verifyActionIntent(token: string, secret: string): IntentValidationResult {
  const parsed = verifyJson(token, intentKey(secret));
  return parsed && isExactIntent(parsed)
    ? { ok: true, intent: parsed as unknown as ActionIntent }
    : { ok: false, reason: "invalid" };
}

export function fingerprintValue(domain: string, value: unknown, secret: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(domain)) throw new Error("Fingerprint domain is invalid.");
  return createHmac("sha256", fingerprintKey(secret))
    .update(domain)
    .update("\0")
    .update(stableJson(value))
    .digest("base64url");
}

export function fingerprintSubject(subject: string, secret: string): string {
  return fingerprintValue("subject", requireTrimmed(subject, "subject"), secret);
}

export function fingerprintSession(tokenId: string, secret: string): string {
  return fingerprintValue("session", tokenId, secret);
}

export function fingerprintOperator(operator: string, secret: string): string {
  return fingerprintValue("operator", requireTrimmed(operator, "operator"), secret);
}

export function parseActionBinding(kind: ActionKind, value: unknown): ActionBinding | null {
  if (!isRecord(value)) return null;
  switch (kind) {
    case "application_assignment_change":
      return exact(value, ["application_id", "assignment_role", "previous_user_id", "proposed_user_id"])
        && positive(value.application_id)
        && (value.assignment_role === "recruiter" || value.assignment_role === "coordinator")
        && nullablePositive(value.previous_user_id)
        && positive(value.proposed_user_id)
        ? value as unknown as ActionBinding : null;
    case "job_owner_change":
      return exact(value, ["job_id", "user_id", "owner_type", "verb", "owner_row_id"])
        && positive(value.job_id) && positive(value.user_id)
        && (value.owner_type === "sourcer" || value.owner_type === "recruiter" || value.owner_type === "coordinator")
        && (value.verb === "add" || value.verb === "remove")
        && nullablePositive(value.owner_row_id)
        && ((value.verb === "add" && value.owner_row_id === null) || (value.verb === "remove" && positive(value.owner_row_id)))
        ? value as unknown as ActionBinding : null;
    case "application_stage_move":
      return exact(value, ["application_id", "from_application_stage_id", "from_interview_stage_id", "to_interview_stage_id"])
        && positive(value.application_id) && positive(value.from_application_stage_id)
        && positive(value.from_interview_stage_id) && positive(value.to_interview_stage_id)
        && value.from_interview_stage_id !== value.to_interview_stage_id
        ? value as unknown as ActionBinding : null;
    case "application_rejection":
      return exact(value, ["application_id", "rejection_reason_id", "previous_interview_stage_id", "has_notes"])
        && positive(value.application_id) && positive(value.rejection_reason_id)
        && positive(value.previous_interview_stage_id) && typeof value.has_notes === "boolean"
        ? value as unknown as ActionBinding : null;
    case "application_unreject":
      return exact(value, ["application_id", "previous_interview_stage_id"])
        && positive(value.application_id) && positive(value.previous_interview_stage_id)
        ? value as unknown as ActionBinding : null;
    case "candidate_note_create":
      return exact(value, ["application_id", "candidate_id", "note_type", "visibility", "baseline_count", "baseline_fingerprint"])
        && positive(value.application_id) && positive(value.candidate_id)
        && (value.note_type === "NOTE" || value.note_type === "ACTIVITY")
        && (value.visibility === "admin_only" || value.visibility === "private" || value.visibility === "public")
        && nonnegative(value.baseline_count) && fingerprint(value.baseline_fingerprint)
        ? value as unknown as ActionBinding : null;
    case "job_note_change":
      return exact(value, ["job_id", "verb", "note_id", "visibility", "baseline_count", "baseline_fingerprint"])
        && positive(value.job_id) && (value.verb === "create" || value.verb === "update" || value.verb === "delete")
        && nullablePositive(value.note_id)
        && (value.visibility === null || value.visibility === "admin_only_visible" || value.visibility === "privately_visible")
        && nonnegative(value.baseline_count) && fingerprint(value.baseline_fingerprint)
        && ((value.verb === "create" && value.note_id === null) || (value.verb !== "create" && positive(value.note_id)))
        ? value as unknown as ActionBinding : null;
    case "application_attribution_change":
      return exact(value, ["application_id", "source_id", "referrer_id", "touches_source", "touches_referrer"])
        && positive(value.application_id) && nullablePositive(value.source_id) && nullablePositive(value.referrer_id)
        && typeof value.touches_source === "boolean" && typeof value.touches_referrer === "boolean"
        && (value.touches_source || value.touches_referrer)
        ? value as unknown as ActionBinding : null;
    case "candidate_record_update":
      return exact(value, ["candidate_id", "context_application_id", "fields"])
        && positive(value.candidate_id) && positive(value.context_application_id) && fieldArray(value.fields)
        ? value as unknown as ActionBinding : null;
    case "offer_create":
      return exact(value, ["application_id", "fields", "baseline_ids", "has_currency"])
        && positive(value.application_id) && fieldArray(value.fields) && idArray(value.baseline_ids)
        && typeof value.has_currency === "boolean"
        ? value as unknown as ActionBinding : null;
    case "offer_update":
      return exact(value, ["application_id", "offer_id", "version", "fields", "has_currency"])
        && positive(value.application_id) && positive(value.offer_id) && positive(value.version) && fieldArray(value.fields)
        && typeof value.has_currency === "boolean"
        ? value as unknown as ActionBinding : null;
  }
}

function isExactSession(value: Record<string, unknown>): boolean {
  const identity = (value.kind === SESSION_KIND && value.audience === SESSION_AUDIENCE)
    || (value.kind === LEGACY_SESSION_KIND && value.audience === LEGACY_SESSION_AUDIENCE);
  return exact(value, ["version", "kind", "audience", "subject", "client", "tokenId", "issuedAtMs", "expiresAtMs"])
    && value.version === 1 && identity && isTrimmed(value.subject) && isClient(value.client)
    && typeof value.tokenId === "string" && TOKEN_ID_PATTERN.test(value.tokenId)
    && timestamp(value.issuedAtMs) && timestamp(value.expiresAtMs) && value.expiresAtMs > value.issuedAtMs;
}

function isExactIntent(value: Record<string, unknown>): boolean {
  const kind = isActionKind(value.actionKind) ? value.actionKind : null;
  return exact(value, [
    "version", "kind", "actionId", "actionKind", "subject", "identityId", "actorUserId",
    "sessionTokenId", "client", "applyTool", "lockKey", "scopeJobId", "binding",
    "currentFingerprint", "desiredFingerprint", "approvalFingerprint", "highImpact",
    "reconciliationGraceMs", "issuedAtMs", "expiresAtMs",
  ])
    && value.version === 2 && value.kind === INTENT_KIND
    && typeof value.actionId === "string" && UUID_PATTERN.test(value.actionId)
    && kind !== null && isTrimmed(value.subject)
    && typeof value.identityId === "string" && UUID_PATTERN.test(value.identityId)
    && positive(value.actorUserId)
    && typeof value.sessionTokenId === "string" && TOKEN_ID_PATTERN.test(value.sessionTokenId)
    && isClient(value.client)
    && typeof value.applyTool === "string" && TOOL_PATTERN.test(value.applyTool)
    && typeof value.lockKey === "string" && LOCK_KEY_PATTERN.test(value.lockKey)
    && nullablePositive(value.scopeJobId)
    && parseActionBinding(kind, value.binding) !== null
    && fingerprint(value.currentFingerprint) && fingerprint(value.desiredFingerprint) && fingerprint(value.approvalFingerprint)
    && typeof value.highImpact === "boolean"
    && typeof value.reconciliationGraceMs === "number" && Number.isSafeInteger(value.reconciliationGraceMs)
    && value.reconciliationGraceMs >= 300_000 && value.reconciliationGraceMs <= 30 * 60_000
    && timestamp(value.issuedAtMs) && timestamp(value.expiresAtMs)
    && value.expiresAtMs > value.issuedAtMs && value.expiresAtMs - value.issuedAtMs === INTENT_TTL_MS;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot fingerprint a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  throw new Error("Cannot fingerprint an unsupported value.");
}

function signJson(value: unknown, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const signature = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifyJson(token: string | undefined, key: Buffer): Record<string, unknown> | null {
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  const expected = createHmac("sha256", key).update(parts[0]).digest();
  let actual: Buffer;
  try { actual = Buffer.from(parts[1], "base64url"); } catch { return null; }
  if (actual.toString("base64url") !== parts[1]) return null;
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const decoded = Buffer.from(parts[0], "base64url");
    if (decoded.toString("base64url") !== parts[0]) return null;
    const value = JSON.parse(decoded.toString("utf8")) as unknown;
    return isRecord(value) ? value : null;
  } catch { return null; }
}

function sessionKey(secret: string): Buffer { return deriveKey(secret, "session"); }
function intentKey(secret: string): Buffer { return deriveKey(secret, "intent"); }
function fingerprintKey(secret: string): Buffer { return deriveKey(secret, "fingerprint"); }

function deriveKey(secret: string, domain: string): Buffer {
  const bytes = Buffer.from(secret, "utf8");
  if (bytes.length < MIN_SECRET_BYTES || secret.trim() !== secret) {
    throw new Error("Action signing secret must be trimmed and at least 32 bytes.");
  }
  return createHmac("sha256", bytes).update(`greenhouse-action:${domain}`).digest();
}

function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function requireTrimmed(value: string, label: string): string {
  if (!isTrimmed(value)) throw new Error(`${label} must be a non-empty trimmed string.`);
  return value;
}

function requireClient(value: ActionClient): ActionClient {
  if (!isClient(value)) throw new Error("Action session client is invalid.");
  return value;
}

function isActionKind(value: unknown): value is ActionKind {
  return typeof value === "string" && (ACTION_KINDS as readonly string[]).includes(value);
}

function isClient(value: unknown): value is ActionClient {
  return value === "codex" || value === "claude_code" || value === "claude_desktop_chat" || value === "test";
}

function isTrimmed(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nullablePositive(value: unknown): boolean { return value === null || positive(value); }
function timestamp(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function fingerprint(value: unknown): value is string { return typeof value === "string" && FINGERPRINT_PATTERN.test(value); }

function idArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= 200 && value.every(positive) && new Set(value).size === value.length;
}

function fieldArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 250
    && value.every((field) => typeof field === "string" && FIELD_PATTERN.test(field))
    && new Set(value).size === value.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
