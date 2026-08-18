// Tool-registration guards for the Greenhouse MCP.
//
// This module centralizes tool availability and approval-list decisions
// used at server startup to:
//   1. Keep expanded Tier 3 reads available by default. Teams can explicitly
//      turn them off, or add GREENHOUSE_TIER3_ACTOR_IDS when they want an
//      approval-user list for those calls.
//   2. Honor the GREENHOUSE_DISABLE_TOOLS kill-switch, which lets an operator
//      drop any tool from registration at startup without a code deploy.
//   3. Enforce the Tier 3 actor allowlist at REQUEST time when a team chooses
//      to provide one.
//   4. Emit read-audit events for denied and error outcomes from the gate
//      layer itself (P2.1 / S5). Success emission happens at the handler
//      site in index.ts where the response size class is known.
//
// Policy anchors:
//   - docs/greenhouse-mcp-output-doctrine.md §6 "Feature Flags and Kill Switches"
//   - docs/greenhouse-mcp-output-doctrine.md §7 "Audit Posture"
//   - docs/greenhouse-mcp-read-audit-spec.md §§2, 6 (denied + fail-closed)
//   - docs/data-privacy-security-roadmap.md §8 S2 / §8 S5 / §8 S6

import {
  logReadAudit,
  READ_AUDIT_FAILURE_MESSAGE,
  type ReadAuditResultSizeClass,
  type ReadAuditTier,
} from "./read-audit.js";

export interface ToolGateConfig {
  /** Names of tools an operator explicitly disabled via GREENHOUSE_DISABLE_TOOLS. */
  disabledTools: Set<string>;
  /** False only when GREENHOUSE_ENABLE_TIER3_READS === "false". */
  tier3ReadsEnabled: boolean;
  /** Allowlisted actor IDs from GREENHOUSE_TIER3_ACTOR_IDS. */
  tier3ActorIds: Set<number>;
  /**
   * True when the expanded read tools should be registered. Empty actor list
   * means available without an approval-user list.
   */
  tier3ReadsAvailable: boolean;
}

export function parseDisabledToolNames(raw: string | undefined): Set<string> {
  if (!raw) {
    return new Set<string>();
  }

  const names = new Set<string>();
  for (const token of raw.split(",")) {
    const trimmed = token.trim();
    if (trimmed) {
      names.add(trimmed);
    }
  }
  return names;
}

export function parseTier3ActorIds(raw: string | undefined): Set<number> {
  if (!raw) {
    return new Set<number>();
  }

  const ids = new Set<number>();
  for (const token of raw.split(",")) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      ids.add(parsed);
    }
  }
  return ids;
}

export function createToolGateConfig(
  env: NodeJS.ProcessEnv = process.env
): ToolGateConfig {
  const disabledTools = parseDisabledToolNames(env.GREENHOUSE_DISABLE_TOOLS);
  const tier3ReadsEnabled = env.GREENHOUSE_ENABLE_TIER3_READS !== "false";
  const tier3ActorIds = parseTier3ActorIds(env.GREENHOUSE_TIER3_ACTOR_IDS);
  return {
    disabledTools,
    tier3ReadsEnabled,
    tier3ActorIds,
    tier3ReadsAvailable: tier3ReadsEnabled,
  };
}

export function isToolDisabled(config: ToolGateConfig, toolName: string): boolean {
  return config.disabledTools.has(toolName);
}

// ---------------------------------------------------------------------------
// Tier 3 request-time gate
// ---------------------------------------------------------------------------

/**
 * The exact names of the four Tier 3 tools this gate applies to. Kept here so
 * that index.ts, the tests, and any future helper see one canonical list.
 * Policy anchor: docs/greenhouse-mcp-output-doctrine.md §6.
 */
export const TIER3_TOOL_NAMES = [
  "list_email_templates",
  "list_interview_kits",
  "list_scheduled_interviews",
  "list_user_emails",
] as const;

export type Tier3ToolName = (typeof TIER3_TOOL_NAMES)[number];

/**
 * Single sanitized error message used for BOTH "missing on_behalf_of_user_id"
 * and "actor not on allowlist" cases. The shape is intentionally stable so the
 * model cannot distinguish the two outcomes and cannot probe allowlist
 * membership by comparing error strings. The message mentions only the
 * parameter name and the env var name; it does not echo the attempted actor
 * ID, the allowlist contents, or the allowlist size.
 */
export const TIER3_GATE_DENIED_MESSAGE =
  "Expanded read denied: use an approved Greenhouse user ID for this setup.";

export interface Tier3ActorAssertionInput {
  toolName: Tier3ToolName | string;
  params: { on_behalf_of_user_id?: unknown } & Record<string, unknown>;
  config: Pick<ToolGateConfig, "tier3ActorIds">;
}

/**
 * Throws TIER3_GATE_DENIED_MESSAGE only when the team supplied an approval-user
 * list and the caller has not supplied a valid, allowlisted on_behalf_of_user_id.
 *
 * The on_behalf_of_user_id parameter is a GATE field only. The Harvest API
 * does not accept it on these four list endpoints; callers of this helper are
 * responsible for stripping it from the params they forward to listEndpoint.
 * See index.ts where the wrapTier3Handler factory destructures it out.
 */
export function assertTier3ActorAllowed(input: Tier3ActorAssertionInput): number | null {
  const actor = input.params.on_behalf_of_user_id;
  if (input.config.tier3ActorIds.size === 0) {
    return typeof actor === "number" && Number.isInteger(actor) && actor > 0
      ? actor
      : null;
  }
  if (typeof actor !== "number" || !Number.isInteger(actor) || actor <= 0) {
    throw new Error(TIER3_GATE_DENIED_MESSAGE);
  }
  if (!input.config.tier3ActorIds.has(actor)) {
    throw new Error(TIER3_GATE_DENIED_MESSAGE);
  }
  return actor;
}

/**
 * True when expanded Tier 3 reads should register. This is the predicate
 * index.ts uses when deciding whether to register each of the four Tier 3 tools
 * at startup.
 */
export function shouldRegisterTier3Tool(config: ToolGateConfig): boolean {
  return config.tier3ReadsAvailable;
}

/**
 * Context handed to the inner handler so it can emit the success audit
 * event with the correct actor (the one that passed the gate) without
 * having to re-derive it from params (which have had on_behalf_of_user_id
 * already stripped by the wrapper).
 */
export interface Tier3HandlerContext {
  /**
   * The numeric actor that passed assertTier3ActorAllowed, or null when this
   * wrapped call ran in an ungated posture.
   */
  actorId: number | null;
}

export interface WrapTier3HandlerOptions<P extends Record<string, unknown> = Record<string, unknown>> {
  /**
   * Error-path projection posture for gated Tier 3 tools. Defaults to false so
   * the four legacy gated tools preserve their existing audit shape. Gated
   * projected tools (for example, purpose-built workflow bundles) can opt in to
   * `true` so downstream errors record the same projection posture as success.
   */
  projectionAppliedOnError?: boolean;
  /**
   * Optional predicate that decides whether this invocation must pass the
   * actor approval-list check when a team has configured one.
   */
  shouldGate?: (params: P) => boolean;
}

/**
 * Wrap a Tier 3 list handler so that:
 *   1. The first action on every call is the actor approval-list assertion,
 *      when a team configured an approval-user list.
 *   2. on_behalf_of_user_id is stripped from the params object before the
 *      inner handler runs, so it never reaches listEndpoint or Harvest.
 *   3. Denied outcomes emit a sanitized read-audit line (actor=null).
 *   4. Downstream handler errors emit an error read-audit line and then
 *      re-throw. Success emission is NOT done here because the result
 *      size class lives at the call site (see emitTier3SuccessReadAudit).
 *
 * Fail-closed discipline (spec §6): if the denied or error audit emission
 * itself throws, the wrapper surfaces READ_AUDIT_FAILURE_MESSAGE rather
 * than the underlying cause and rather than the original denial/error
 * message. This prevents a silent successful-looking return and avoids
 * leaking audit-emitter internals.
 *
 * The inner handler receives the params with on_behalf_of_user_id already
 * removed, so call sites can forward the narrowed params to listEndpoint
 * without a second destructure. It also receives a context object with the
 * gate-passed actorId so the call site can emit the success audit.
 */
export function wrapTier3Handler<
  P extends Record<string, unknown> & { on_behalf_of_user_id?: unknown },
  R
>(
  toolName: Tier3ToolName | string,
  config: Pick<ToolGateConfig, "tier3ActorIds">,
  inner: (
    params: Omit<P, "on_behalf_of_user_id">,
    context?: Tier3HandlerContext
  ) => Promise<R> | R,
  options: WrapTier3HandlerOptions<P> = {}
): (params: P) => Promise<R> {
  return async (params: P) => {
    const gateRequired =
      (options.shouldGate ? options.shouldGate(params) : true) &&
      config.tier3ActorIds.size > 0;
    let actor: number | null = null;
    if (gateRequired) {
      try {
        actor = assertTier3ActorAllowed({ toolName, params, config });
      } catch (denyError) {
        // Denied: emit audit with actor=null (spec §§2, 3.1). Fail closed if
        // the emitter itself throws — surface READ_AUDIT_FAILURE_MESSAGE
        // rather than the original denial message so the failure cannot be
        // confused with a successful deny.
        try {
          logReadAudit({
            tool: toolName,
            tier: 3 satisfies ReadAuditTier,
            callerIdentity: { on_behalf_of_user_id: null },
            projectionApplied: false,
            outcome: "denied",
          });
        } catch (auditError) {
          if (
            auditError instanceof Error &&
            auditError.message === READ_AUDIT_FAILURE_MESSAGE
          ) {
            throw auditError;
          }
          throw new Error(READ_AUDIT_FAILURE_MESSAGE);
        }
        throw denyError;
      }
    } else {
      const actorParam = params.on_behalf_of_user_id;
      actor =
        typeof actorParam === "number" &&
        Number.isInteger(actorParam) &&
        actorParam > 0
          ? actorParam
          : null;
    }

    const { on_behalf_of_user_id: _actor, ...rest } = params;
    try {
      return await Promise.resolve(
        inner(rest as Omit<P, "on_behalf_of_user_id">, { actorId: actor })
      );
    } catch (innerError) {
      // A thrown READ_AUDIT_FAILURE_MESSAGE from inside the inner handler
      // (emitted by emitTier3SuccessReadAudit when the stderr sink failed)
      // must propagate untouched. Re-emitting an "error" audit for it
      // would double-emit for the same call and confuse the audit stream.
      if (
        innerError instanceof Error &&
        innerError.message === READ_AUDIT_FAILURE_MESSAGE
      ) {
        throw innerError;
      }

      // Downstream error after the gate passed: emit audit with the
      // gate-passed actor (spec §3.1 "error" branch). Fail closed if the
      // emitter itself throws.
      try {
        logReadAudit({
          tool: toolName,
          tier: 3 satisfies ReadAuditTier,
          callerIdentity: { on_behalf_of_user_id: actor },
          projectionApplied: options.projectionAppliedOnError ?? false,
          outcome: "error",
        });
      } catch (auditError) {
        if (
          auditError instanceof Error &&
          auditError.message === READ_AUDIT_FAILURE_MESSAGE
        ) {
          throw auditError;
        }
        throw new Error(READ_AUDIT_FAILURE_MESSAGE);
      }
      throw innerError;
    }
  };
}

/**
 * Emit the Tier 3 success audit event from a handler call site. Kept out
 * of wrapTier3Handler because the call site is the only layer that knows
 * the Harvest response's data shape and can compute the result size class
 * (P2.1 spec §3.2) without reinventing `formatResult`.
 *
 * Fail-closed discipline: if the emitter throws, this helper re-throws
 * READ_AUDIT_FAILURE_MESSAGE so the caller returns nothing to the model
 * — matching P2.1 spec §6.1.
 *
 * `actorId` accepts `null` so non-gated Tier 3 tools (e.g. `list_notes`
 * per P2.2 slice 1) can emit with `caller_identity.on_behalf_of_user_id:
 * null`. Doctrine §7 treats the null-actor case as a legitimate signal,
 * not a gap.
 *
 * `projectionApplied` carries the per-tool P2.2 rollout signal. Defaults
 * to `false` so the four gated Tier 3 tools (which do not yet project)
 * keep emitting `projection_applied: false`. `list_notes` passes `true`
 * because slice 1 lands its projection.
 */
export interface Tier3SuccessAuditInput {
  toolName: Tier3ToolName | string;
  actorId: number | null;
  resultSizeClass: ReadAuditResultSizeClass;
  projectionApplied?: boolean;
}

export function emitTier3SuccessReadAudit(
  input: Tier3SuccessAuditInput
): void {
  try {
    logReadAudit({
      tool: input.toolName,
      tier: 3 satisfies ReadAuditTier,
      callerIdentity: { on_behalf_of_user_id: input.actorId },
      projectionApplied: input.projectionApplied ?? false,
      resultSizeClass: input.resultSizeClass,
      outcome: "success",
    });
  } catch (auditError) {
    if (
      auditError instanceof Error &&
      auditError.message === READ_AUDIT_FAILURE_MESSAGE
    ) {
      throw auditError;
    }
    throw new Error(READ_AUDIT_FAILURE_MESSAGE);
  }
}

/**
 * Emit a Tier 3 error audit event from a handler call site. Companion
 * to emitTier3SuccessReadAudit for non-gated Tier 3 tools (i.e. tools
 * that are not wrapped by wrapTier3Handler and therefore own their own
 * catch-and-audit flow). The four wrapped tools still get their error
 * emission from inside wrapTier3Handler; call sites must not double-emit.
 *
 * Spec anchors:
 *   - docs/greenhouse-mcp-projection-slice-1-spec.md §5.5
 *   - docs/greenhouse-mcp-read-audit-spec.md §3.1 "error" branch,
 *     §3.2 (result_size_class omitted), §6 fail-closed.
 *
 * `projectionApplied` defaults to `false` so any future non-gated
 * Tier 3 tool that has not yet rolled out projection keeps the
 * pre-P2.2 posture. `list_notes` passes `true` to record posture
 * (projection IS the steady-state for this tool, even on error paths).
 */
export interface Tier3ErrorAuditInput {
  toolName: Tier3ToolName | string;
  actorId: number | null;
  projectionApplied?: boolean;
}

export function emitTier3ErrorReadAudit(
  input: Tier3ErrorAuditInput
): void {
  try {
    logReadAudit({
      tool: input.toolName,
      tier: 3 satisfies ReadAuditTier,
      callerIdentity: { on_behalf_of_user_id: input.actorId },
      projectionApplied: input.projectionApplied ?? false,
      outcome: "error",
    });
  } catch (auditError) {
    if (
      auditError instanceof Error &&
      auditError.message === READ_AUDIT_FAILURE_MESSAGE
    ) {
      throw auditError;
    }
    throw new Error(READ_AUDIT_FAILURE_MESSAGE);
  }
}
