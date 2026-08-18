import { createHash } from "node:crypto";
import type { PermissionScope, ScopedReadOptions, ScopedReadResult } from "../../scoped-core/src/index.js";
import { emitAudit, isAuditUnavailableError, newCorrelationId, resolvedJobHash, type AuditSink } from "./audit.js";
import { IdentityResolutionError } from "./identity.js";
import { classifyUpstreamError, isRateLimitError } from "./upstream-error.js";
import { createNoopRateLimiter, type RecruiterRateLimiter } from "./rate-limit.js";
import {
  DEFAULT_LIMITS,
  HARD_MAX_ANALYSIS_DURATION_MS,
  HARD_MAX_TOOL_DURATION_MS,
  createRecruiterToolConfig,
  sanitizeReadParams,
  isToolEnabled,
  type RecruiterToolConfig,
  type RecruiterToolLimits,
  type SanitizeReadParamsOptions,
} from "./limits.js";
import type {
  AuthenticatedSession,
  RecruiterDenialCode,
  RecruiterPermissionScope,
  RecruiterSurface,
  RecruiterToolKind,
  RecruiterToolResult,
  ScopedReaderLike,
} from "./types.js";
import type { RecruiterAuditEvent } from "./audit.js";
import type { ActionPlaneMount } from "./action-plane.js";
import type { ResolutionServices } from "./resolution/services.js";

const TOOL_TIMEOUT_ERROR_MESSAGE = "SCOPED_GREENHOUSE_TOOL_TIMEOUT";
const TOOL_CANCELLED_ERROR_MESSAGE = "SCOPED_GREENHOUSE_TOOL_CANCELLED";
export const AUDIT_UNAVAILABLE_DENIAL_MESSAGE = "Scoped Greenhouse audit logging is unavailable, so no Greenhouse data was returned.";

export interface ToolDeadline {
  startedAt: number;
  timeoutMs: number;
  now: () => number;
}

interface AuditCallContext {
  startedAt: number;
  preflightFinishedAt: number;
  scopeResolvedAt?: number;
  permissionScopeKind?: "jobs" | "all";
  permittedJobIds?: number[];
  resolvedJobIds?: number[];
  explicitResolvedScope: boolean;
  actorId?: number;
  effectiveActorId?: number;
  pagesRead: number;
  retries: number;
  cacheHits: number;
}

export interface RecruiterToolRuntime<SessionIdentity extends AuthenticatedSession = AuthenticatedSession> {
  session: SessionIdentity;
  scopedReader: ScopedReaderLike<SessionIdentity>;
  auditSink: AuditSink;
  limits: RecruiterToolLimits;
  toolConfig: RecruiterToolConfig;
  rateLimiter: RecruiterRateLimiter;
  trustedActAsUser?: number;
  /** Client-request lifetime; aborts on disconnect and is never model-supplied. */
  signal?: AbortSignal;
  now: () => number;
  /** Optional resolver-framework wiring. Domain-specific providers live behind this bag. */
  resolution?: ResolutionServices;
  /**
   * Server-internal signal (never model-supplied) that an upstream planner has
   * already resolved and gated the analysis scope, so a downstream recipe must
   * not re-run the no-scope inventory probe. Only set by the recruiting-question
   * planner when invoking recipes after its own scope gate.
   */
  scopeContextResolved?: boolean;
  /**
   * The mounted write plane, when this session holds an entitlement. Absent for everyone else, which
   * is what keeps the base catalog byte-identical — see action-plane.ts.
   */
  actionPlane?: ActionPlaneMount;
  /** Request-local dedupe for required v2 audit start rows. */
  auditStartedCorrelations?: Set<string>;
  /** Request-local audit-only state; never included in RecruiterToolResult. */
  auditCallContexts?: Map<string, AuditCallContext>;
  auditActiveCorrelations?: string[];
}

export function createRecruiterToolRuntime<SessionIdentity extends AuthenticatedSession>(
  input: Omit<RecruiterToolRuntime<SessionIdentity>, "limits" | "toolConfig" | "rateLimiter" | "now"> & {
    limits?: RecruiterToolLimits;
    toolConfig?: RecruiterToolConfig;
    rateLimiter?: RecruiterRateLimiter;
    now?: () => number;
  }
): RecruiterToolRuntime<SessionIdentity> {
  return {
    ...input,
    limits: input.limits ?? DEFAULT_LIMITS,
    toolConfig: input.toolConfig ?? createRecruiterToolConfig({}),
    rateLimiter: input.rateLimiter ?? createNoopRateLimiter(),
    now: input.now ?? (() => Date.now()),
    auditStartedCorrelations: input.auditStartedCorrelations ?? new Set<string>(),
    auditCallContexts: input.auditCallContexts ?? new Map<string, AuditCallContext>(),
    auditActiveCorrelations: input.auditActiveCorrelations ?? [],
  };
}

export async function runScopedTool<SessionIdentity extends AuthenticatedSession>(
  runtime: RecruiterToolRuntime<SessionIdentity>,
  exposedToolName: string,
  scopedToolName: string,
  params: Record<string, unknown>,
  kind: RecruiterToolKind,
  allowedParamNames?: SanitizeReadParamsOptions["allowedParamNames"]
): Promise<RecruiterToolResult> {
  const startedAt = runtime.now();
  const correlationId = newCorrelationId(runtime.now);
  const actAsUser = runtime.trustedActAsUser ?? null;
  const surface = runtime.session.surface;

  if (!isToolEnabled(runtime.toolConfig, surface, exposedToolName, kind)) {
    const denied = deny(exposedToolName, "TOOL_DISABLED", "This scoped Greenhouse tool is disabled for this runtime.");
    const auditDenied = await emitRequiredToolAudit(runtime, exposedToolName, kind, startedAt, correlationId, denied, null, null, actAsUser);
    return auditDenied ?? denied;
  }

  const rateDenied = await enforceUsageBudget(runtime, exposedToolName, kind, surface, startedAt, correlationId, actAsUser);
  if (rateDenied) {
    return rateDenied;
  }

  try {
    const safeParams = sanitizeReadParams(params, runtime.limits, { allowedParamNames });
    const response = await scopedReadWithTimeout(runtime, scopedToolName, safeParams);
    const result = fromScopedRead(exposedToolName, response);
    const auditDenied = await emitRequiredToolAudit(runtime, exposedToolName, kind, startedAt, correlationId, result, rowsRead(result), rowsReturned(result), actAsUser);
    return auditDenied ?? result;
  } catch (error) {
    const denied = denialFromError(exposedToolName, error);
    const auditDenied = await emitRequiredToolAudit(runtime, exposedToolName, kind, startedAt, correlationId, denied, null, null, actAsUser);
    return auditDenied ?? denied;
  }
}

export async function enforceUsageBudget<SessionIdentity extends AuthenticatedSession>(
  runtime: RecruiterToolRuntime<SessionIdentity>,
  exposedToolName: string,
  kind: RecruiterToolKind,
  surface: RecruiterSurface,
  startedAt: number,
  correlationId: string,
  actAsUser: number | null
): Promise<RecruiterToolResult | null> {
  const startAuditDenied = await emitRequiredToolAuditStart(
    runtime,
    exposedToolName,
    kind,
    startedAt,
    correlationId,
    actAsUser
  );
  if (startAuditDenied) return startAuditDenied;
  const decision = runtime.rateLimiter.check({
    session: runtime.session,
    toolName: exposedToolName,
    toolKind: kind,
    now: runtime.now(),
  });
  markAuditPreflightComplete(runtime, correlationId);
  if (decision.allowed) return null;
  const denied = deny(
    exposedToolName,
    "RATE_LIMITED",
    `Scoped Greenhouse tool rate limit exceeded for ${decision.reason} calls. Retry after ${decision.resetAt}.`
  );
  const auditDenied = await emitRequiredToolAudit(runtime, exposedToolName, kind, startedAt, correlationId, denied, null, null, actAsUser);
  return auditDenied ?? denied;
}

export async function scopedReadWithTimeout<SessionIdentity extends AuthenticatedSession>(
  runtime: RecruiterToolRuntime<SessionIdentity>,
  scopedToolName: string,
  params?: Record<string, unknown>,
  options: ScopedReadOptions | undefined = trustedOptions(runtime),
  deadline?: ToolDeadline
): Promise<ScopedReadResult> {
  recordExplicitAuditJobIds(runtime, params?.job_ids);
  const timeoutMs = remainingTimeoutMs(runtime, deadline);
  if (timeoutMs !== undefined && timeoutMs <= 0) {
    throw new Error(`${TOOL_TIMEOUT_ERROR_MESSAGE}:deadline`);
  }
  if (runtime.signal?.aborted || options?.signal?.aborted) {
    throw new Error(TOOL_CANCELLED_ERROR_MESSAGE);
  }
  const effectiveTimeoutMs = timeoutMs ?? clampedToolTimeoutMs(runtime);
  const controller = new AbortController();
  let timedOut = false;
  const parentSignals = [...new Set([runtime.signal, options?.signal].filter((signal): signal is AbortSignal => signal !== undefined))];
  const abortFromParent = () => controller.abort();
  for (const signal of parentSignals) signal.addEventListener("abort", abortFromParent, { once: true });
  const timer = Number.isFinite(effectiveTimeoutMs) && effectiveTimeoutMs > 0
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, effectiveTimeoutMs)
    : undefined;
  const operation = runtime.scopedReader.scopedRead(runtime.session, scopedToolName, params, {
    ...(options ?? {}),
    signal: controller.signal,
  });
  const cancelled = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => {
      reject(new Error(timedOut ? `${TOOL_TIMEOUT_ERROR_MESSAGE}:${effectiveTimeoutMs}` : TOOL_CANCELLED_ERROR_MESSAGE));
    }, { once: true });
  });
  try {
    const response = await Promise.race([operation, cancelled]);
    recordAuditActor(runtime, response);
    recordAuditReadMetrics(runtime, response);
    return response;
  } catch (error) {
    if (timedOut) throw new Error(`${TOOL_TIMEOUT_ERROR_MESSAGE}:${effectiveTimeoutMs}`);
    if (parentSignals.some((signal) => signal.aborted)) throw new Error(TOOL_CANCELLED_ERROR_MESSAGE);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    for (const signal of parentSignals) signal.removeEventListener("abort", abortFromParent);
  }
}

export function createToolDeadline(runtime: RecruiterToolRuntime, startedAt: number = runtime.now()): ToolDeadline | undefined {
  // The WHOLE-analysis budget (read the full cohort across many pages), NOT a single read's timeout.
  // Falls back to maxToolDurationMs only for test/literal limits that don't set the analysis budget; the
  // hosted runtime sets maxAnalysisDurationMs. Invalid internal literal limits fail safely to a finite
  // budget; no caller can turn the front door into an uncapped operation.
  const configuredAnalysisMs = runtime.limits.maxAnalysisDurationMs;
  const configuredFallbackMs = runtime.limits.maxToolDurationMs;
  const timeoutMs = Number.isFinite(configuredAnalysisMs) && (configuredAnalysisMs ?? 0) > 0
    ? Math.min(configuredAnalysisMs as number, HARD_MAX_ANALYSIS_DURATION_MS)
    : Number.isFinite(configuredFallbackMs) && configuredFallbackMs > 0
      ? Math.min(configuredFallbackMs, HARD_MAX_TOOL_DURATION_MS)
      : HARD_MAX_ANALYSIS_DURATION_MS;
  return { startedAt, timeoutMs, now: runtime.now };
}

export function assertWithinToolDeadline(deadline: ToolDeadline | undefined): void {
  if (!deadline) return;
  if (deadline.now() - deadline.startedAt >= deadline.timeoutMs) {
    throw new Error(`${TOOL_TIMEOUT_ERROR_MESSAGE}:deadline`);
  }
}

function remainingTimeoutMs(runtime: RecruiterToolRuntime, deadline: ToolDeadline | undefined): number | undefined {
  if (!deadline) return undefined;
  const remaining = deadline.timeoutMs - Math.max(0, deadline.now() - deadline.startedAt);
  return Math.min(clampedToolTimeoutMs(runtime), remaining);
}

function clampedToolTimeoutMs(runtime: RecruiterToolRuntime): number {
  const configured = runtime.limits.maxToolDurationMs;
  return Number.isFinite(configured) && configured > 0
    ? Math.min(configured, HARD_MAX_TOOL_DURATION_MS)
    : HARD_MAX_TOOL_DURATION_MS;
}

export function trustedOptions(runtime: RecruiterToolRuntime): ScopedReadOptions | undefined {
  const observePermissionScope = (scope: PermissionScope | { kind: "operator" }) => {
    recordAuditPermissionScope(runtime, scope);
  };
  const auditActive = (runtime.auditActiveCorrelations?.length ?? 0) > 0;
  if (runtime.trustedActAsUser === undefined && !runtime.signal && !auditActive) return undefined;
  return {
    ...(runtime.trustedActAsUser === undefined ? {} : { actAsUser: runtime.trustedActAsUser }),
    ...(runtime.signal ? { signal: runtime.signal } : {}),
    ...(auditActive ? { onPermissionScopeResolved: observePermissionScope } : {}),
  };
}

export function isToolTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(TOOL_TIMEOUT_ERROR_MESSAGE);
}

export function isToolCancelledError(error: unknown): boolean {
  return error instanceof Error && (
    error.message.startsWith(TOOL_CANCELLED_ERROR_MESSAGE) ||
    error.name === "RequestAbortedError" ||
    error.name === "AbortError"
  );
}

/**
 * Run one write-plane tool and put it on the SAME required audit sink the reads use.
 *
 * The action plane keeps its own durable `greenhouse_action` ledger, and that ledger — not this row —
 * is the authoritative record of a mutation. This exists because the hosted `/mcp` gate treats audit
 * as required at request time: a read returns AUDIT_UNAVAILABLE rather than data when the sink is
 * down. A write that quietly skipped that would be the one call type able to proceed unlogged, which
 * inverts the property exactly where it matters most.
 *
 * `ActionDeniedError` becomes a denial rather than a throw, so a refusal reaches the model as a
 * structured result it can act on. Its `code` is carried in the message rather than mapped onto
 * `RecruiterDenialCode` — the read plane's codes are about scope and identity and none of them mean
 * "not entitled to write" or "target busy"; forcing a write denial into one would misreport it.
 */
export async function runActionTool(
  runtime: RecruiterToolRuntime,
  tool: string,
  run: () => Promise<Record<string, unknown>>
): Promise<RecruiterToolResult> {
  const startedAt = runtime.now();
  const correlationId = newCorrelationId();
  let result: RecruiterToolResult;
  try {
    const data = await run();
    result = {
      ok: true,
      toolName: tool,
      scoped: true,
      rowCounts: { raw: null, returned: 1 },
      data,
      nextCursor: null,
    };
  } catch (error) {
    const code = typeof (error as { code?: unknown })?.code === "string"
      ? (error as { code: string }).code
      : "UPSTREAM_ERROR";
    const message = error instanceof Error ? error.message : "Greenhouse action failed.";
    result = deny(tool, "UPSTREAM_ERROR", `${code}: ${message}`);
  }

  try {
    await emitAudit(runtime.auditSink, {
      schemaVersion: 2,
      event: "scoped_greenhouse_tool_call",
      auditStage: "terminal",
      at: new Date(runtime.now()).toISOString(),
      surface: runtime.session.surface,
      client: runtime.session.client ?? "legacy_unknown",
      tokenId: runtime.session.tokenId ?? null,
      tool,
      toolKind: "analysis",
      actorGreenhouseUserId: null,
      effectiveGreenhouseUserId: null,
      operator: false,
      actAsUser: null,
      permissionScopeKind: "unknown",
      permittedJobCount: null,
      rowsRead: null,
      rowsReturned: result.ok ? 1 : 0,
      denialCode: result.ok ? null : result.denial.code,
      durationMs: Math.max(0, runtime.now() - startedAt),
      correlationId,
      outcome: result.ok ? "ok" : "denied",
      failurePhase: null,
      cancellationReason: null,
      pagesRead: 0,
      retries: 0,
      cacheHits: 0,
      phaseTimingsMs: null,
      resolvedJobIds: null,
      resolvedJobCount: null,
      resolvedJobHash: null,
    } as unknown as RecruiterAuditEvent);
  } catch (error) {
    if (isAuditUnavailableError(error)) {
      return deny(tool, "AUDIT_UNAVAILABLE", AUDIT_UNAVAILABLE_DENIAL_MESSAGE);
    }
    throw error;
  }
  return result;
}

export function deny(
  toolName: string,
  code: RecruiterDenialCode,
  message: string,
  actorId?: number,
  effectiveActorId?: number
): RecruiterToolResult {
  return {
    ok: false,
    toolName,
    actorId,
    effectiveActorId,
    denial: { code, message },
  };
}

export function fromScopedRead(toolName: string, response: ScopedReadResult): RecruiterToolResult {
  if (!response.ok) {
    return deny(
      toolName,
      response.denial.code,
      response.denial.message,
      response.actorId,
      response.effectiveActorId
    );
  }
  return {
    ok: true,
    toolName,
    actorId: response.actorId,
    effectiveActorId: response.effectiveActorId,
    scoped: response.scoped,
    permissionScope: response.permissionScope,
    rowCounts: response.rowCounts,
    data: response.data,
    nextCursor: response.nextCursor,
    meta: response.meta,
  };
}

export const RECRUITER_RESULT_PAYLOAD_BUDGET_BYTES = 700_000;

export function mcpTextResult(result: RecruiterToolResult): { content: { type: "text"; text: string }[] } {
  const text = JSON.stringify(result, null, 2);
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= RECRUITER_RESULT_PAYLOAD_BUDGET_BYTES) {
    return { content: [{ type: "text", text }] };
  }
  const resultSha256 = createHash("sha256").update(text, "utf8").digest("hex");
  const truncated = {
    ok: result.ok,
    toolName: result.toolName,
    ...(result.actorId === undefined ? {} : { actorId: result.actorId }),
    ...(result.effectiveActorId === undefined ? {} : { effectiveActorId: result.effectiveActorId }),
    ...(result.ok
      ? {
          scoped: result.scoped,
          permissionScope: result.permissionScope,
          data: {
            output_truncated: true,
            message: `Serialized tool result exceeded the ${RECRUITER_RESULT_PAYLOAD_BUDGET_BYTES}-byte response limit.`,
            continuation: {
              resumable: false,
              strategy: "repeat_same_scope_with_smaller_output",
              preserve: ["job scope", "time window"],
              reduce_one_of: ["max_rankings", "evidence_pack_limit", "per_page"],
              result_sha256: resultSha256,
              note: "Repeat the same request and scope with a lower supported output limit. The hash identifies this exact omitted serialized result.",
            },
          },
          nextCursor: null,
        }
      : {
          denial: {
            code: result.denial.code,
            message: `The original denial exceeded the ${RECRUITER_RESULT_PAYLOAD_BUDGET_BYTES}-byte response limit and was omitted.`,
          },
        }),
    output: {
      truncated: true,
      limit_bytes: RECRUITER_RESULT_PAYLOAD_BUDGET_BYTES,
      original_bytes: originalBytes,
      original_sha256: resultSha256,
    },
  };
  const truncatedText = JSON.stringify(truncated, null, 2);
  if (Buffer.byteLength(truncatedText, "utf8") <= RECRUITER_RESULT_PAYLOAD_BUDGET_BYTES) {
    return { content: [{ type: "text", text: truncatedText }] };
  }

  // Scope metadata can itself be unusually large. Fall back to a fixed-size envelope so the
  // response ceiling is universal even for malformed internal results, while retaining a stable
  // fingerprint and an honest retry instruction.
  const bounded = {
    ok: result.ok,
    toolName: boundedResultLabel(result.toolName),
    ...(result.ok
      ? {
          data: {
            output_truncated: true,
            message: `Serialized tool result exceeded the ${RECRUITER_RESULT_PAYLOAD_BUDGET_BYTES}-byte response limit.`,
            continuation: {
              resumable: false,
              strategy: "repeat_same_scope_with_smaller_output",
              result_sha256: resultSha256,
            },
          },
          nextCursor: null,
        }
      : {
          denial: {
            code: result.denial.code,
            message: `The original denial exceeded the ${RECRUITER_RESULT_PAYLOAD_BUDGET_BYTES}-byte response limit and was omitted.`,
          },
        }),
    output: {
      truncated: true,
      limit_bytes: RECRUITER_RESULT_PAYLOAD_BUDGET_BYTES,
      original_bytes: originalBytes,
      original_sha256: resultSha256,
    },
  };
  return { content: [{ type: "text", text: JSON.stringify(bounded, null, 2) }] };
}

function boundedResultLabel(value: string): string {
  return value.length <= 200 ? value : `${value.slice(0, 197)}...`;
}

export function denialFromError(toolName: string, error: unknown): RecruiterToolResult {
  if (isAuditUnavailableError(error)) {
    return deny(toolName, "AUDIT_UNAVAILABLE", AUDIT_UNAVAILABLE_DENIAL_MESSAGE);
  }
  if (error instanceof IdentityResolutionError) {
    return deny(toolName, error.code, error.message);
  }
  if (isToolTimeoutError(error)) {
    return deny(toolName, "TOOL_TIMEOUT", "Scoped Greenhouse tool timed out before returning data.");
  }
  if (isToolCancelledError(error)) {
    return deny(toolName, "CANCELLED", "Scoped Greenhouse tool was cancelled because the client request ended.");
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("window exceeds") || message.includes("requires a valid window")) {
    return deny(toolName, "LIMIT_EXCEEDED", message);
  }
  // A RateLimitError doesn't carry the "Greenhouse API error: 429" text classifyUpstreamError
  // keys on, so classify it explicitly here (the single-read get_my_* path, which never reaches
  // read-all's own rate-limit interception) rather than mislabel it as an opaque UPSTREAM_ERROR.
  if (isRateLimitError(error)) {
    return deny(toolName, "RATE_LIMITED", "Scoped Greenhouse read was rate limited before returning data.");
  }
  return deny(toolName, "UPSTREAM_ERROR", classifyUpstreamError(error, "Scoped Greenhouse tool failed before returning data."));
}

function rowsReturned(result: RecruiterToolResult): number | null {
  if (!result.ok) return null;
  if (result.rowCounts) return result.rowCounts.returned;
  if (Array.isArray(result.data)) return result.data.length;
  if (result.data && typeof result.data === "object") return 1;
  return 0;
}

function rowsRead(result: RecruiterToolResult): number | null {
  if (!result.ok) return null;
  return result.rowCounts?.raw ?? rowsReturned(result);
}

export async function emitRequiredToolAudit(
  runtime: RecruiterToolRuntime,
  tool: string,
  toolKind: RecruiterToolKind,
  startedAt: number,
  correlationId: string,
  result: RecruiterToolResult,
  rowsRead: number | null,
  rowsReturnedValue: number | null,
  actAsUser: number | null,
  extra?: Partial<RecruiterAuditEvent>
): Promise<RecruiterToolResult | null> {
  let auditContext: AuditCallContext | undefined;
  try {
    const startDenied = await emitRequiredToolAuditStart(
      runtime,
      tool,
      toolKind,
      startedAt,
      correlationId,
      actAsUser
    );
    if (startDenied) return startDenied;
    auditContext = runtime.auditCallContexts?.get(correlationId);
    const completedAt = runtime.now();
    const durationMs = Math.max(0, completedAt - startedAt);
    const resolvedJobIds = normalizeAuditJobIds(
      extra?.resolvedJobIds ?? auditContext?.resolvedJobIds ?? auditContext?.permittedJobIds
    );
    const resultScopeKind = result.ok ? auditScopeKind(result.permissionScope) : "unknown";
    const permissionScopeKind = resultScopeKind === "unknown"
      ? auditContext?.permissionScopeKind ?? "unknown"
      : resultScopeKind;
    const permittedJobCount = result.ok
      ? auditPermittedJobCount(result.permissionScope) ?? (permissionScopeKind === "jobs" ? auditContext?.permittedJobIds?.length ?? null : null)
      : permissionScopeKind === "jobs" ? auditContext?.permittedJobIds?.length ?? null : null;
    await emitAudit(runtime.auditSink, {
      ...(extra ?? {}),
      schemaVersion: 2,
      event: "scoped_greenhouse_tool_call",
      auditStage: "terminal",
      at: new Date(completedAt).toISOString(),
      surface: runtime.session.surface,
      client: runtime.session.client ?? "legacy_unknown",
      tokenId: runtime.session.tokenId ?? null,
      tool,
      toolKind,
      actorGreenhouseUserId: result.actorId ?? auditContext?.actorId ?? null,
      effectiveGreenhouseUserId: result.effectiveActorId ?? auditContext?.effectiveActorId ?? null,
      operator: isOperatorAuditCall(result, actAsUser),
      actAsUser,
      permissionScopeKind,
      permittedJobCount,
      rowsRead,
      rowsReturned: rowsReturnedValue,
      denialCode: result.ok ? null : result.denial.code,
      durationMs,
      correlationId,
      outcome: auditOutcome(result),
      failurePhase: auditFailurePhase(result),
      cancellationReason: !result.ok && (result.denial.code === "TOOL_TIMEOUT" || result.denial.code === "CANCELLED")
        ? result.denial.code
        : null,
      pagesRead: auditContext?.pagesRead ?? auditReadMetric(result, "pages") ?? 0,
      retries: auditContext?.retries ?? auditReadMetric(result, "retries") ?? 0,
      cacheHits: auditContext?.cacheHits ?? auditReadMetric(result, "cache") ?? 0,
      phaseTimingsMs: auditPhaseTimings(auditContext, startedAt, completedAt),
      resolvedJobIds,
      resolvedJobCount: resolvedJobIds?.length ?? null,
      resolvedJobHash: resolvedJobIds === null ? null : resolvedJobHash(resolvedJobIds),
    });
    return null;
  } catch (error) {
    if (isAuditUnavailableError(error)) {
      return deny(tool, "AUDIT_UNAVAILABLE", AUDIT_UNAVAILABLE_DENIAL_MESSAGE, result.actorId, result.effectiveActorId);
    }
    throw error;
  } finally {
    endAuditContext(runtime, correlationId);
  }
}

async function emitRequiredToolAuditStart(
  runtime: RecruiterToolRuntime,
  tool: string,
  toolKind: RecruiterToolKind,
  startedAt: number,
  correlationId: string,
  actAsUser: number | null
): Promise<RecruiterToolResult | null> {
  beginAuditContext(runtime, correlationId, startedAt);
  const started = runtime.auditStartedCorrelations ??= new Set<string>();
  if (started.has(correlationId)) return null;
  try {
    await emitAudit(runtime.auditSink, {
      schemaVersion: 2,
      event: "scoped_greenhouse_tool_call",
      auditStage: "start",
      at: new Date(startedAt).toISOString(),
      surface: runtime.session.surface,
      client: runtime.session.client ?? "legacy_unknown",
      tokenId: runtime.session.tokenId ?? null,
      tool,
      toolKind,
      actorGreenhouseUserId: null,
      effectiveGreenhouseUserId: null,
      operator: actAsUser !== null,
      actAsUser,
      permissionScopeKind: "unknown",
      permittedJobCount: null,
      rowsRead: null,
      rowsReturned: null,
      denialCode: null,
      durationMs: 0,
      correlationId,
      outcome: "started",
      failurePhase: null,
      cancellationReason: null,
      pagesRead: null,
      retries: null,
      cacheHits: null,
      phaseTimingsMs: { total: 0, preflight: 0, authorizationOrScope: 0, tool: 0 },
      resolvedJobIds: null,
      resolvedJobCount: null,
      resolvedJobHash: null,
    });
    started.add(correlationId);
    return null;
  } catch (error) {
    if (isAuditUnavailableError(error)) {
      endAuditContext(runtime, correlationId);
      return deny(tool, "AUDIT_UNAVAILABLE", AUDIT_UNAVAILABLE_DENIAL_MESSAGE);
    }
    throw error;
  }
}

function beginAuditContext(runtime: RecruiterToolRuntime, correlationId: string, startedAt: number): void {
  const contexts = runtime.auditCallContexts ??= new Map<string, AuditCallContext>();
  if (contexts.has(correlationId)) return;
  contexts.set(correlationId, {
    startedAt,
    preflightFinishedAt: startedAt,
    explicitResolvedScope: false,
    pagesRead: 0,
    retries: 0,
    cacheHits: 0,
  });
  (runtime.auditActiveCorrelations ??= []).push(correlationId);
}

function endAuditContext(runtime: RecruiterToolRuntime, correlationId: string): void {
  runtime.auditCallContexts?.delete(correlationId);
  if (!runtime.auditActiveCorrelations) return;
  const index = runtime.auditActiveCorrelations.lastIndexOf(correlationId);
  if (index >= 0) runtime.auditActiveCorrelations.splice(index, 1);
}

function markAuditPreflightComplete(runtime: RecruiterToolRuntime, correlationId: string): void {
  const context = runtime.auditCallContexts?.get(correlationId);
  if (context) context.preflightFinishedAt = Math.max(context.startedAt, runtime.now());
}

function recordAuditPermissionScope(
  runtime: RecruiterToolRuntime,
  scope: PermissionScope | { kind: "operator" }
): void {
  const now = runtime.now();
  for (const correlationId of runtime.auditActiveCorrelations ?? []) {
    const context = runtime.auditCallContexts?.get(correlationId);
    if (!context) continue;
    context.scopeResolvedAt ??= now;
    if (scope.kind === "jobs") {
      const ids = normalizeAuditJobIds([...scope.jobIds]) ?? [];
      context.permissionScopeKind = "jobs";
      context.permittedJobIds = ids;
      if (context.explicitResolvedScope) {
        const permitted = new Set(ids);
        context.resolvedJobIds = (context.resolvedJobIds ?? []).filter((id) => permitted.has(id));
      } else {
        context.resolvedJobIds = ids;
      }
    } else {
      context.permissionScopeKind = "all";
      context.permittedJobIds = undefined;
      if (!context.explicitResolvedScope) context.resolvedJobIds = undefined;
    }
  }
}

function recordAuditActor(runtime: RecruiterToolRuntime, response: ScopedReadResult): void {
  if (response.actorId === undefined && response.effectiveActorId === undefined) return;
  for (const correlationId of runtime.auditActiveCorrelations ?? []) {
    const context = runtime.auditCallContexts?.get(correlationId);
    if (!context) continue;
    context.actorId ??= response.actorId;
    context.effectiveActorId ??= response.effectiveActorId;
  }
}

function recordAuditReadMetrics(runtime: RecruiterToolRuntime, response: ScopedReadResult): void {
  if (!response.ok) return;
  const retries = response.meta?.retry.rateLimitRetries ?? 0;
  const cacheHits = response.meta?.cacheHits ?? 0;
  for (const correlationId of runtime.auditActiveCorrelations ?? []) {
    const context = runtime.auditCallContexts?.get(correlationId);
    if (!context) continue;
    context.pagesRead += 1;
    context.retries += retries;
    context.cacheHits += cacheHits;
  }
}

function recordExplicitAuditJobIds(runtime: RecruiterToolRuntime, value: unknown): void {
  const ids = parseAuditJobIds(value);
  if (ids === null) return;
  const now = runtime.now();
  for (const correlationId of runtime.auditActiveCorrelations ?? []) {
    const context = runtime.auditCallContexts?.get(correlationId);
    if (!context) continue;
    let resolved = context.explicitResolvedScope
      ? normalizeAuditJobIds([...(context.resolvedJobIds ?? []), ...ids]) ?? []
      : ids;
    if (context.permissionScopeKind === "jobs") {
      const permitted = new Set(context.permittedJobIds ?? []);
      resolved = resolved.filter((id) => permitted.has(id));
    }
    context.explicitResolvedScope = true;
    context.resolvedJobIds = resolved;
    context.scopeResolvedAt ??= now;
  }
}

function parseAuditJobIds(value: unknown): number[] | null {
  const parts = Array.isArray(value)
    ? value
    : typeof value === "string" && value.trim().length > 0
      ? value.split(",")
      : [];
  if (parts.length === 0) return null;
  const ids: number[] = [];
  for (const part of parts) {
    const normalized = typeof part === "string" && /^\d+$/.test(part.trim())
      ? Number.parseInt(part.trim(), 10)
      : part;
    if (typeof normalized === "number" && Number.isSafeInteger(normalized) && normalized > 0) ids.push(normalized);
  }
  return normalizeAuditJobIds(ids);
}

function auditPhaseTimings(
  context: AuditCallContext | undefined,
  startedAt: number,
  completedAt: number
): NonNullable<RecruiterAuditEvent["phaseTimingsMs"]> {
  const total = Math.max(0, completedAt - startedAt);
  const preflightEnd = clampTime(context?.preflightFinishedAt ?? startedAt, startedAt, completedAt);
  const scopeEnd = clampTime(context?.scopeResolvedAt ?? preflightEnd, preflightEnd, completedAt);
  return {
    total,
    preflight: preflightEnd - startedAt,
    authorizationOrScope: scopeEnd - preflightEnd,
    tool: completedAt - scopeEnd,
  };
}

function clampTime(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function auditOutcome(result: RecruiterToolResult): "success" | "denied" | "cancelled" | "failed" {
  if (result.ok) return "success";
  if (result.denial.code === "TOOL_TIMEOUT" || result.denial.code === "CANCELLED") return "cancelled";
  if (result.denial.code === "UPSTREAM_ERROR" || result.denial.code === "AUDIT_UNAVAILABLE") return "failed";
  return "denied";
}

function auditFailurePhase(result: RecruiterToolResult): "authorization" | "rate_limit" | "tool" | "audit" | null {
  if (result.ok) return null;
  if (["IDENTITY_NOT_RESOLVED", "IDENTITY_AMBIGUOUS", "IDENTITY_INVALID", "ACTOR_DENIED", "PERMISSION_LOOKUP_FAILED"].includes(result.denial.code)) {
    return "authorization";
  }
  if (result.denial.code === "RATE_LIMITED") return "rate_limit";
  if (result.denial.code === "AUDIT_UNAVAILABLE") return "audit";
  return "tool";
}

function normalizeAuditJobIds(value: RecruiterAuditEvent["resolvedJobIds"]): number[] | null {
  if (value === null || value === undefined) return null;
  return [...new Set(value.filter((id) => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b);
}

function auditReadMetric(result: RecruiterToolResult, metric: "pages" | "retries" | "cache"): number | null {
  if (!result.ok) return null;
  if (metric === "pages" && result.read) return result.read.pages_read;
  if (metric === "retries" && result.read) return result.read.rate_limit_retries;
  if (metric === "cache" && result.read) return result.read.cache_hits;
  if (metric === "pages" && result.meta) return 1;
  if (metric === "retries" && result.meta) return result.meta.retry.rateLimitRetries;
  if (metric === "cache" && result.meta) return result.meta.cacheHits ?? 0;
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) return null;
  const summary = (result.data as Record<string, unknown>).summary;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return null;
  const entries = Object.entries(summary as Record<string, unknown>);
  const values = metric === "pages"
    ? entries.filter(([key]) => key === "pages_read" || key.endsWith("_pages_read"))
    : metric === "retries"
      ? entries.filter(([key]) => key === "rate_limit_retries" || key.endsWith("_rate_limit_retries"))
      : entries.filter(([key]) => key === "cache_hits" || key.endsWith("_cache_hits"));
  const numbers = values.map(([, value]) => value).filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  return numbers.length === 0 ? null : numbers.reduce((sum, value) => sum + value, 0);
}

function isOperatorAuditCall(result: RecruiterToolResult, actAsUser: number | null): boolean {
  if (result.ok) {
    return result.permissionScope?.kind === "operator" ||
      actAsUser !== null;
  }
  return actAsUser !== null && result.effectiveActorId === actAsUser;
}

function auditScopeKind(scope: RecruiterPermissionScope | undefined): "unknown" | "jobs" | "all" {
  if (!scope) return "unknown";
  return scope.kind === "jobs" ? "jobs" : "all";
}

function auditPermittedJobCount(scope: RecruiterPermissionScope | undefined): number | null {
  return scope?.kind === "jobs" ? scope.permittedJobCount : null;
}
