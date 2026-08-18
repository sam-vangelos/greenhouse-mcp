import { parseActionBinding } from "./crypto.js";
import { ACTION_KINDS } from "./types.js";
import type {
  ActionClient,
  ActionEntitlement,
  ActionKind,
  ActionRecord,
  ActionStore,
  ClaimResult,
} from "./types.js";

const CANONICAL_PROJECT_REF = "exampleprojectref000";
const DEFAULT_TIMEOUT_MS = 8_000;

export interface SupabaseActionStoreConfig {
  url: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ActionSupabaseConfig {
  url: string;
  apiKey: string;
}

export class ActionStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionStoreError";
  }
}

export function createSupabaseActionStore(config: SupabaseActionStoreConfig): ActionStore {
  const origin = normalizeSupabaseOrigin(config.url);
  const apiKey = requireSecret(config.apiKey, "Supabase service-role key");
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ActionStoreError("Action state request timed out."));
      }, timeoutMs);
    });
    try {
      return await Promise.race([requestAndRead(), timeout]);
    } catch (error) {
      if (error instanceof ActionStoreError) throw error;
      throw new ActionStoreError(error instanceof Error && error.name === "AbortError"
        ? "Action state request timed out." : "Action state request failed.");
    } finally {
      if (timer) clearTimeout(timer);
    }

    async function requestAndRead(): Promise<unknown> {
      const response = await fetchImpl(`${origin}/rest/v1/${path}`, {
        ...init,
        redirect: "error",
        signal: controller.signal,
        headers: {
          apikey: apiKey,
          authorization: `Bearer ${apiKey}`,
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      });
      if (!response.ok) throw new ActionStoreError(`Action state request failed with HTTP ${response.status}.`);
      const text = await response.text();
      return text.length > 0 ? JSON.parse(text) as unknown : null;
    }
  }

  async function rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
    return request(`rpc/${name}`, { method: "POST", body: JSON.stringify(body) });
  }

  return {
    async resolveIdentity(session) {
      const lookup = identityLookup(session.subject);
      const query = new URLSearchParams({
        select: "id,greenhouse_user_id,status",
        [lookup.column]: `eq.${lookup.value}`,
        status: "eq.resolved",
        limit: "2",
      });
      const rows = requireRows(await request(`recruiter_identity_directory?${query}`));
      if (rows.length !== 1 || rows[0]?.status !== "resolved") throw new ActionStoreError("Action identity is not uniquely resolved.");
      return {
        identityId: requireUuid(rows[0]!.id, "identity id"),
        greenhouseUserId: requirePositiveInteger(rows[0]!.greenhouse_user_id, "identity Greenhouse user id"),
      };
    },

    async isSessionRevoked(tokenId) {
      const query = new URLSearchParams({
        select: "token_id",
        token_id: `eq.${tokenId}`,
        status: "eq.revoked",
        limit: "1",
      });
      return requireRows(await request(`recruiter_mcp_session_revocation?${query}`)).length === 1;
    },

    async getEntitlement(identity, client): Promise<ActionEntitlement | null> {
      const query = new URLSearchParams({
        select: "identity_id,greenhouse_user_id,client,can_preview,can_apply,can_apply_high_impact,status,expires_at",
        identity_id: `eq.${identity.identityId}`,
        greenhouse_user_id: `eq.${identity.greenhouseUserId}`,
        client: `eq.${client}`,
        status: "eq.active",
        limit: "1",
      });
      const rows = requireRows(await request(`greenhouse_action_entitlement?${query}`));
      if (rows.length === 0) return null;
      const row = rows[0]!;
      if (typeof row.expires_at === "string" && Date.parse(row.expires_at) <= Date.now()) return null;
      return {
        identityId: requireUuid(row.identity_id, "entitlement identity id"),
        greenhouseUserId: requirePositiveInteger(row.greenhouse_user_id, "entitlement Greenhouse user id"),
        client: requireClient(row.client),
        canPreview: row.can_preview === true,
        canApply: row.can_apply === true,
        canApplyHighImpact: row.can_apply_high_impact === true,
      };
    },

    async getAction(actionId) {
      const query = new URLSearchParams({ select: "*", action_id: `eq.${actionId}`, limit: "1" });
      const rows = requireRows(await request(`greenhouse_action?${query}`));
      return rows.length === 0 ? null : parseActionRecord(rows[0]!);
    },

    async claimAction(input) {
      const value = requireRecord(await rpc("claim_greenhouse_action", {
        p_action_id: input.intent.actionId,
        p_action_kind: input.intent.actionKind,
        p_lock_key: input.intent.lockKey,
        p_scope_job_id: input.intent.scopeJobId,
        p_binding: input.intent.binding,
        p_identity_id: input.intent.identityId,
        p_actor_user_id: input.intent.actorUserId,
        p_subject_fingerprint: input.subjectFingerprint,
        p_session_fingerprint: input.sessionFingerprint,
        p_client: input.intent.client,
        p_current_fingerprint: input.intent.currentFingerprint,
        p_desired_fingerprint: input.intent.desiredFingerprint,
        p_approval_fingerprint: input.intent.approvalFingerprint,
        p_high_impact: input.intent.highImpact,
        p_intent_expires_at: new Date(input.intent.expiresAtMs).toISOString(),
        p_reconciliation_grace_seconds: Math.ceil(input.intent.reconciliationGraceMs / 1000),
        p_owner_token: input.ownerToken,
      }), "claim result");
      const disposition = value.disposition;
      if (disposition !== "owned" && disposition !== "replay" && disposition !== "target_busy") {
        throw new ActionStoreError("Action claim returned an invalid disposition.");
      }
      return { disposition, record: parseActionRecord(requireRecord(value.record, "claim record")) } as ClaimResult;
    },

    async beginMutation(input) {
      return await rpc("begin_greenhouse_action_mutation", {
        p_action_id: input.actionId,
        p_owner_token: input.ownerToken,
      }) === true;
    },

    async finishAction(input) {
      const value = await rpc("finish_greenhouse_action", {
        p_action_id: input.actionId,
        p_owner_token: input.ownerToken,
        p_status: input.status,
        p_observation: input.observation ?? null,
        p_error_code: input.errorCode ?? null,
        p_upstream_status: input.upstreamStatus ?? null,
        p_upstream_request_id: input.upstreamRequestId ?? null,
        p_upstream_resource_id: input.upstreamResourceId ?? null,
      });
      return value === null ? null : parseActionRecord(requireRecord(value, "finished action"));
    },

    async prepareReconciliation(actionId) {
      const value = await rpc("prepare_greenhouse_action_reconciliation", { p_action_id: actionId });
      return value === null ? null : parseActionRecord(requireRecord(value, "reconciliation action"));
    },

    async deferUnknown(actionId) {
      const value = await rpc("defer_greenhouse_action_unknown", { p_action_id: actionId });
      return value === null ? null : parseActionRecord(requireRecord(value, "deferred action"));
    },

    async reconcileOriginalObservation(actionId) {
      const value = await rpc("reconcile_greenhouse_action_original_observation", { p_action_id: actionId });
      return value === null ? null : parseActionRecord(requireRecord(value, "original-state reconciliation"));
    },

    async resolveUnknown(input) {
      const value = await rpc("resolve_greenhouse_action_unknown", {
        p_action_id: input.actionId,
        p_status: input.status,
        p_observation: input.observation,
        p_error_code: input.errorCode ?? null,
        p_resolution_source: input.resolutionSource ?? "automatic",
        p_resolved_by_fingerprint: input.resolvedByFingerprint ?? null,
      });
      return value === null ? null : parseActionRecord(requireRecord(value, "resolved action"));
    },

    async listRecoverableActions() {
      const query = new URLSearchParams({
        select: "*",
        status: "in.(executing,unknown)",
        or: "(observation.is.null,observation.neq.conflict)",
        order: "status.asc,updated_at.asc",
        limit: "100",
      });
      return requireRows(await request(`greenhouse_action?${query}`)).map(parseActionRecord);
    },
  };
}

function identityLookup(subject: string): { column: "google_subject" | "primary_email"; value: string } {
  if (!subject.startsWith("email:")) return { column: "google_subject", value: subject };
  const email = subject.slice("email:".length);
  if (
    email.length === 0
    || email.length > 254
    || email !== email.trim().toLowerCase()
    || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
  ) {
    throw new ActionStoreError("Action email identity subject is invalid.");
  }
  return { column: "primary_email", value: email };
}

export function createActionStoreFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): ActionStore {
  const config = readActionSupabaseConfig(env);
  return createSupabaseActionStore({
    ...config,
    fetchImpl,
  });
}

export function readActionSupabaseConfig(env: NodeJS.ProcessEnv = process.env): ActionSupabaseConfig {
  return {
    url: normalizeSupabaseOrigin(requireEnv(env, "GREENHOUSE_ACTION_SUPABASE_URL")),
    apiKey: requireSecret(requireEnv(env, "GREENHOUSE_ACTION_SUPABASE_KEY"), "Supabase service-role key"),
  };
}

function parseActionRecord(row: Record<string, unknown>): ActionRecord {
  const actionKind = requireActionKind(row.action_kind);
  const binding = parseActionBinding(actionKind, row.binding);
  const status = row.status;
  const phase = row.phase;
  const observation = row.observation;
  if (!binding) throw new ActionStoreError("Action state row has an invalid binding.");
  if (!isActionStatus(status) || (phase !== "preflight" && phase !== "mutation_sent")) {
    throw new ActionStoreError("Action state row has an invalid state.");
  }
  if (observation !== null && observation !== "desired_observed" && observation !== "not_observed" && observation !== "conflict") {
    throw new ActionStoreError("Action state row has an invalid observation.");
  }
  return {
    actionId: requireUuid(row.action_id, "action id"),
    actionKind,
    lockKey: requireLockKey(row.lock_key),
    scopeJobId: row.scope_job_id === null ? null : requirePositiveInteger(row.scope_job_id, "scope job id"),
    binding,
    identityId: requireUuid(row.identity_id, "identity id"),
    actorUserId: requirePositiveInteger(row.actor_user_id, "actor user id"),
    subjectFingerprint: requireFingerprint(row.subject_fingerprint, "subject fingerprint"),
    sessionFingerprint: requireFingerprint(row.session_fingerprint, "session fingerprint"),
    client: requireClient(row.client),
    currentFingerprint: requireFingerprint(row.current_fingerprint, "current fingerprint"),
    desiredFingerprint: requireFingerprint(row.desired_fingerprint, "desired fingerprint"),
    approvalFingerprint: requireFingerprint(row.approval_fingerprint, "approval fingerprint"),
    highImpact: requireBoolean(row.high_impact, "high impact flag"),
    intentExpiresAt: requireTimestamp(row.intent_expires_at, "intent expiry"),
    notAppliedBefore: requireTimestamp(row.not_applied_before, "not-applied boundary"),
    status,
    phase,
    ownerToken: requireUuid(row.owner_token, "owner token"),
    leaseExpiresAt: requireTimestamp(row.lease_expires_at, "lease expiry"),
    observation,
    errorCode: optionalString(row.error_code, "error code"),
    upstreamStatus: row.upstream_status === null ? null : requireHttpStatus(row.upstream_status),
    upstreamRequestId: optionalString(row.upstream_request_id, "upstream request id"),
    upstreamResourceId: row.upstream_resource_id === null ? null : requirePositiveInteger(row.upstream_resource_id, "upstream resource id"),
    firstOriginalObservationAt: optionalTimestamp(row.first_original_observation_at, "first original observation"),
    resolutionSource: row.resolution_source === null ? null
      : row.resolution_source === "automatic" || row.resolution_source === "operator"
        ? row.resolution_source : invalid("resolution source"),
    resolvedByFingerprint: row.resolved_by_fingerprint === null ? null : requireFingerprint(row.resolved_by_fingerprint, "operator fingerprint"),
    completedAt: optionalTimestamp(row.completed_at, "completion time"),
    createdAt: requireTimestamp(row.created_at, "created time"),
    updatedAt: requireTimestamp(row.updated_at, "updated time"),
  };
}

function normalizeSupabaseOrigin(raw: string): string {
  const value = requireSecret(raw, "Supabase URL").replace(/\/$/, "");
  let url: URL;
  try { url = new URL(value); } catch { throw new ActionStoreError("Supabase URL is invalid."); }
  if (url.protocol !== "https:" || url.hostname !== `${CANONICAL_PROJECT_REF}.supabase.co`
    || url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new ActionStoreError(`Supabase URL must be the canonical Greenhouse MCP project (${CANONICAL_PROJECT_REF}).`);
  }
  return url.origin;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new ActionStoreError(`${name} is required.`);
  return requireSecret(value, name);
}

function requireSecret(value: string, label: string): string {
  if (value.length === 0 || value.trim() !== value) throw new ActionStoreError(`${label} must be a non-empty trimmed value.`);
  return value;
}

function requireRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) throw new ActionStoreError("Action state response was invalid.");
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ActionStoreError(`${label} was invalid.`);
  return value;
}

function requireActionKind(value: unknown): ActionKind {
  if (typeof value !== "string" || !(ACTION_KINDS as readonly string[]).includes(value)) return invalid("action kind");
  return value as ActionKind;
}

function requireClient(value: unknown): ActionClient {
  if (value !== "codex" && value !== "claude_code" && value !== "claude_desktop_chat" && value !== "test") return invalid("client");
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return invalid(label);
  return value;
}

function requireHttpStatus(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 100 || value > 599) return invalid("upstream status");
  return value;
}

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return invalid(label);
  return value;
}

function requireLockKey(value: unknown): string {
  if (typeof value !== "string" || !/^(application|candidate|job|offer-chain):[1-9]\d{0,18}$/.test(value)) return invalid("lock key");
  return value;
}

function requireFingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return invalid(label);
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") return invalid(label);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) return invalid(label);
  return value;
}

function optionalString(value: unknown, label: string): string | null { return value === null ? null : requireString(value, label); }

function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return invalid(label);
  return value;
}

function optionalTimestamp(value: unknown, label: string): string | null { return value === null ? null : requireTimestamp(value, label); }

function isActionStatus(value: unknown): value is ActionRecord["status"] {
  return value === "executing" || value === "succeeded" || value === "failed" || value === "unknown" || value === "reconciled";
}

function invalid(label: string): never { throw new ActionStoreError(`Action state row has an invalid ${label}.`); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
