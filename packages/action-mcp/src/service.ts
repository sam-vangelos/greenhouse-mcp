import { randomUUID } from "node:crypto";
import { actionDefinition } from "./actions/index.js";
import type { ActionContext, ActionDefinition } from "./actions/index.js";
import {
  fingerprintSession,
  fingerprintSubject,
  fingerprintValue,
  issueActionIntent,
  verifyActionIntent,
} from "./crypto.js";
import { reportActionError } from "./diagnostics.js";
import { ActionDeniedError } from "./errors.js";
import { GreenhouseError } from "./greenhouse.js";
import type {
  ActionIntent,
  FenceTarget,
  TargetVisibilityProbe,
  ActionKind,
  ActionRecord,
  ActionSession,
  ActionStore,
  Clock,
  GreenhouseGateway,
  MutationPlan,
  Observation,
  PreparedAction,
  ResolvedIdentity,
} from "./types.js";

const READBACK_DELAYS_MS = [0, 2_000, 3_000] as const;

export interface GreenhouseActionServiceConfig {
  session: ActionSession;
  store: ActionStore;
  greenhouse: GreenhouseGateway;
  signingSecret: string;
  /**
   * The read plane's answer to "can this human see this resource" — Phase 2c §4.1. REQUIRED: a
   * service with no probe cannot exist, so the fence cannot be forgotten by omission. Hosts supply
   * a real probe; the standalone env path supplies unavailableVisibilityProbe, which denies.
   */
  visibility: TargetVisibilityProbe;
  writesEnabled: boolean;
  production: boolean;
  writeCapabilities?: ReadonlySet<ActionKind>;
  clock?: Clock;
}

export class GreenhouseActionService {
  private readonly clock: Clock;

  constructor(private readonly config: GreenhouseActionServiceConfig) {
    this.clock = config.clock ?? {
      now: () => Date.now(),
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
    if (config.production && config.session.client === "test") {
      throw new ActionDeniedError("TEST_CLIENT_FORBIDDEN", "Test action sessions are forbidden in production.");
    }
  }

  async preview(kind: ActionKind, input: unknown): Promise<Record<string, unknown>> {
    const definition = actionDefinition(kind);
    const parsed = parseDefinitionInput(definition.previewSchema, input, "Preview input is invalid.");
    const { identity } = await this.authorizeSession("preview", false);
    const context = this.context(identity.greenhouseUserId);
    let prepared: PreparedAction;
    try {
      prepared = await definition.preparePreview(parsed, context);
    } catch (error) {
      throw publicPreflightError(error);
    }
    // The preview fence — §4.3. Before the no_change return and before issueActionIntent: nothing
    // has been returned to the caller yet, so fencing here prevents every disclosure, including the
    // no-change echo of current state.
    await this.assertTargetsVisible(prepared.fenceTargets);
    if (!prepared.changeRequired) {
      return {
        status: "no_change",
        change_required: false,
        high_impact: prepared.highImpact,
        actor: { greenhouse_user_id: identity.greenhouseUserId },
        ...prepared.preview,
        approval: prepared.approval,
        intent: null,
        expires_at: null,
      };
    }
    const issued = issueActionIntent({
      session: this.config.session,
      identityId: identity.identityId,
      actorUserId: identity.greenhouseUserId,
      applyTool: definition.applyTool,
      prepared,
      nowMs: this.clock.now(),
    }, this.config.signingSecret);
    return {
      status: "ready",
      change_required: true,
      high_impact: prepared.highImpact,
      actor: { greenhouse_user_id: identity.greenhouseUserId },
      ...prepared.preview,
      approval: prepared.approval,
      intent: issued.token,
      expires_at: new Date(issued.intent.expiresAtMs).toISOString(),
    };
  }

  async apply(kind: ActionKind, input: unknown): Promise<Record<string, unknown>> {
    const definition = actionDefinition(kind);
    const parsed = parseDefinitionInput(definition.applySchema, input, "Apply input is invalid.");
    const parsedRecord = requireRecord(parsed, "Apply input is invalid.");
    const rawIntent = parsedRecord.intent;
    if (typeof rawIntent !== "string") throw new ActionDeniedError("INTENT_INVALID", "Action intent is invalid.");
    const approval = definition.getApproval(parsed);
    await this.assertNotRevoked();
    const verified = verifyActionIntent(rawIntent, this.config.signingSecret);
    if (!verified.ok) throw new ActionDeniedError("INTENT_INVALID", "Action intent is invalid.");
    const intent = verified.intent;
    this.assertIntentSession(intent);
    if (intent.actionKind !== kind || intent.applyTool !== definition.applyTool) {
      throw new ActionDeniedError("INTENT_ACTION_MISMATCH", "Action intent belongs to a different tool.");
    }
    if (fingerprintValue("approval", approval, this.config.signingSecret) !== intent.approvalFingerprint) {
      throw new ActionDeniedError("APPROVAL_DISPLAY_MISMATCH", "Approved action details do not match the signed preview.");
    }
    if (intent.expiresAtMs <= this.clock.now() || intent.issuedAtMs > this.clock.now() + 60_000) {
      throw new ActionDeniedError("INTENT_EXPIRED", "Action intent has expired; create a new preview.");
    }

    const subjectFingerprint = fingerprintSubject(this.config.session.subject, this.config.signingSecret);
    const sessionFingerprint = fingerprintSession(this.config.session.tokenId, this.config.signingSecret);
    const existing = await this.config.store.getAction(intent.actionId);
    if (existing) {
      this.assertRecordMatches(existing, intent, subjectFingerprint, sessionFingerprint);
      return this.replayOrReconcile(existing);
    }
    if (!this.config.writesEnabled) throw new ActionDeniedError("WRITES_DISABLED", "Greenhouse action writes are disabled.");
    if (this.config.writeCapabilities && !this.config.writeCapabilities.has(kind)) {
      throw new ActionDeniedError("CAPABILITY_WRITES_DISABLED", "Writes for this Greenhouse action are disabled.");
    }

    const { identity } = await this.authorizeSession("apply", intent.highImpact);
    this.assertIntentIdentity(intent, identity);
    const ownerToken = randomUUID();
    const claim = await this.config.store.claimAction({ intent, subjectFingerprint, sessionFingerprint, ownerToken });
    if (claim.disposition === "target_busy") {
      throw new ActionDeniedError("TARGET_BUSY", "This Greenhouse resource has an executing or unresolved action.");
    }
    if (claim.disposition === "replay") {
      this.assertRecordMatches(claim.record, intent, subjectFingerprint, sessionFingerprint);
      return this.replayOrReconcile(claim.record);
    }

    let freshPrepared: PreparedAction;
    try {
      freshPrepared = await definition.prepareApply(approval, this.context(identity.greenhouseUserId));
      this.assertPreparedMatches(intent, freshPrepared);
      // The apply fence — §4.3. Fresh targets from the fresh preparation; a valid signed intent
      // cannot satisfy this, because visibility is re-derived live, never carried in the token.
      await this.assertTargetsVisible(freshPrepared.fenceTargets);
      await this.assertNotRevoked();
      const fresh = await this.authorizeSession("apply", intent.highImpact);
      this.assertIntentIdentity(intent, fresh.identity);
      if (intent.expiresAtMs <= this.clock.now()) throw new ActionDeniedError("INTENT_EXPIRED", "Action intent has expired; create a new preview.");
    } catch (error) {
      const failure = publicPreflightError(error);
      if (failure.diagnostic) {
        reportActionError("apply_preflight_failed", error, {
          action_id: intent.actionId,
          action_kind: kind,
          code: failure.code,
          source_error_name: failure.diagnostic.sourceErrorName,
          ...(typeof failure.diagnostic.upstreamStatus === "number"
            ? { upstream_status: failure.diagnostic.upstreamStatus } : {}),
          ...(typeof failure.diagnostic.upstreamRequestId === "string"
            ? { upstream_request_id: failure.diagnostic.upstreamRequestId } : {}),
        });
      }
      return this.finishPreflightFailure(claim.record, ownerToken, denialCode(failure));
    }

    if (!await this.config.store.beginMutation({ actionId: intent.actionId, ownerToken })) {
      throw new ActionDeniedError("ACTION_OWNERSHIP_LOST", "Action execution ownership was lost before mutation; no write was sent.");
    }

    let plan: MutationPlan;
    try {
      plan = await definition.mutation(approval, freshPrepared, this.context(identity.greenhouseUserId));
    } catch (error) {
      reportActionError("mutation_build_failed", error, {
        action_id: intent.actionId,
        action_kind: kind,
      });
      return this.finishResult(claim.record, ownerToken, {
        status: "failed",
        errorCode: "MUTATION_BUILD_FAILED",
      }, false);
    }

    let upstreamStatus: number | null = null;
    let upstreamRequestId: string | null = null;
    let upstreamResourceId: number | null = null;
    try {
      const response = await this.config.greenhouse.mutate({ ...plan, actorUserId: intent.actorUserId });
      upstreamStatus = response.status;
      upstreamRequestId = response.requestId;
      upstreamResourceId = definition.resultResourceId?.(response) ?? null;
    } catch (error) {
      if (error instanceof GreenhouseError && !error.ambiguous) {
        return this.finishResult(claim.record, ownerToken, {
          status: "failed",
          errorCode: "UPSTREAM_REJECTED",
          upstreamStatus: error.status,
          upstreamRequestId: error.requestId,
        }, true);
      }
      if (error instanceof GreenhouseError) {
        upstreamStatus = error.status;
        upstreamRequestId = error.requestId;
      }
    }

    const observationRecord = { ...claim.record, upstreamResourceId, phase: "mutation_sent" as const };
    const observation = await observeWithDelays(definition, observationRecord, this.context(intent.actorUserId), this.clock);
    if (observation === "desired_observed") {
      return this.finishResult(claim.record, ownerToken, {
        status: upstreamStatus !== null && upstreamStatus >= 200 && upstreamStatus < 300 ? "succeeded" : "reconciled",
        observation,
        upstreamStatus,
        upstreamRequestId,
        upstreamResourceId,
      }, true);
    }
    return this.finishResult(claim.record, ownerToken, {
      status: "unknown",
      observation: observation === "unavailable" ? null : observation,
      errorCode: observation === "not_observed" ? "UPSTREAM_RESULT_NOT_OBSERVED"
        : observation === "conflict" ? "UPSTREAM_RESULT_CONFLICT" : "UPSTREAM_READBACK_FAILED",
      upstreamStatus,
      upstreamRequestId,
      upstreamResourceId,
    }, true);
  }

  private context(actorUserId: number): ActionContext {
    return {
      actorUserId,
      greenhouse: this.config.greenhouse,
      signingSecret: this.config.signingSecret,
      clock: this.clock,
    };
  }

  private async authorizeSession(capability: "preview" | "apply", highImpact: boolean): Promise<{ identity: ResolvedIdentity }> {
    await this.assertNotRevoked();
    const identity = await this.config.store.resolveIdentity(this.config.session);
    const entitlement = await this.config.store.getEntitlement(identity, this.config.session.client);
    if (!entitlement || !entitlement.canPreview || (capability === "apply" && !entitlement.canApply)) {
      throw new ActionDeniedError("ACTION_NOT_ENTITLED", `Action session is not entitled to ${capability}.`);
    }
    if (capability === "apply" && highImpact && !entitlement.canApplyHighImpact) {
      throw new ActionDeniedError("HIGH_IMPACT_NOT_ENTITLED", "Action session is not entitled to high-impact applies.");
    }
    if (entitlement.identityId !== identity.identityId || entitlement.greenhouseUserId !== identity.greenhouseUserId) {
      throw new ActionDeniedError("IDENTITY_DRIFT", "Action identity mapping no longer matches its entitlement.");
    }
    return { identity };
  }

  /**
   * The visibility fence — Phase 2c §4.3. A mutation may proceed only if the acting human can read,
   * through the scoped read plane's full pipeline, every resource it reads or discloses.
   *
   * `hidden` denies: the read plane conclusively filtered the target from this human. `unavailable`
   * ALSO denies — with its own code, so an outage is diagnosable instead of masquerading as a
   * revoked grant. And a target that requires the unredacted view denies when the read plane would
   * withhold fields from this human: previewing a change to a redacted resource would disclose
   * exactly what the redaction exists to withhold, and an approval over data the approver cannot
   * see is ceremonial rather than meaningful.
   *
   * Probed sequentially and in declaration order, so the first denial names a deterministic target.
   */
  private async assertTargetsVisible(targets: readonly FenceTarget[]): Promise<void> {
    for (const target of targets) {
      const verdict = await this.config.visibility.probe(target);
      if (verdict.state === "unavailable") {
        throw new ActionDeniedError(
          "TARGET_UNAVAILABLE",
          `Visibility of the ${target.kind} this action targets could not be established (${verdict.reason}); the action is denied rather than guessed.`
        );
      }
      if (verdict.state === "hidden") {
        throw new ActionDeniedError(
          "TARGET_NOT_VISIBLE",
          `The ${target.kind} this action targets is not visible to you through the scoped read plane.`
        );
      }
      if (target.requiresUnredacted && verdict.redacted) {
        throw new ActionDeniedError(
          "TARGET_NOT_VISIBLE",
          `The ${target.kind} this action reads carries fields the read plane withholds from you, and this change would read or disclose them.`
        );
      }
    }
  }

  private async assertNotRevoked(): Promise<void> {
    if (await this.config.store.isSessionRevoked(this.config.session.tokenId)) {
      throw new ActionDeniedError("SESSION_REVOKED", "Action session has been revoked.");
    }
  }

  private assertIntentSession(intent: ActionIntent): void {
    const session = this.config.session;
    if (intent.subject !== session.subject || intent.sessionTokenId !== session.tokenId || intent.client !== session.client) {
      throw new ActionDeniedError("INTENT_SESSION_MISMATCH", "Action intent is bound to a different action session.");
    }
  }

  private assertIntentIdentity(intent: ActionIntent, identity: ResolvedIdentity): void {
    if (intent.identityId !== identity.identityId || intent.actorUserId !== identity.greenhouseUserId) {
      throw new ActionDeniedError("IDENTITY_DRIFT", "Action intent actor no longer matches the resolved identity.");
    }
  }

  private assertPreparedMatches(intent: ActionIntent, prepared: PreparedAction): void {
    if (prepared.actionKind !== intent.actionKind
      || prepared.lockKey !== intent.lockKey
      || prepared.scopeJobId !== intent.scopeJobId
      || prepared.highImpact !== intent.highImpact
      || prepared.reconciliationGraceMs !== intent.reconciliationGraceMs
      || fingerprintValue("binding", prepared.binding, this.config.signingSecret) !== fingerprintValue("binding", intent.binding, this.config.signingSecret)
      || prepared.currentFingerprint !== intent.currentFingerprint
      || prepared.desiredFingerprint !== intent.desiredFingerprint
      || prepared.approvalFingerprint !== intent.approvalFingerprint) {
      throw new ActionDeniedError("STATE_CHANGED", "Greenhouse state changed; create a new preview.");
    }
  }

  private assertRecordMatches(record: ActionRecord, intent: ActionIntent, subjectFingerprint: string, sessionFingerprint: string): void {
    if (record.actionKind !== intent.actionKind || record.lockKey !== intent.lockKey || record.scopeJobId !== intent.scopeJobId
      || record.identityId !== intent.identityId || record.actorUserId !== intent.actorUserId
      || record.subjectFingerprint !== subjectFingerprint || record.sessionFingerprint !== sessionFingerprint
      || record.client !== intent.client || record.currentFingerprint !== intent.currentFingerprint
      || record.desiredFingerprint !== intent.desiredFingerprint || record.approvalFingerprint !== intent.approvalFingerprint
      || record.highImpact !== intent.highImpact
      || fingerprintValue("binding", record.binding, this.config.signingSecret) !== fingerprintValue("binding", intent.binding, this.config.signingSecret)) {
      throw new ActionDeniedError("ACTION_BINDING_MISMATCH", "Recorded action does not match the signed intent.");
    }
  }

  private async replayOrReconcile(record: ActionRecord): Promise<Record<string, unknown>> {
    if (record.status === "succeeded" || record.status === "failed" || record.status === "reconciled") return actionResult(record, true);
    const prepared = await this.config.store.prepareReconciliation(record.actionId);
    if (!prepared) throw new ActionDeniedError("ACTION_STATE_UNAVAILABLE", "Recorded action could not be loaded.");
    if (prepared.status === "executing") return actionResult(prepared, true, "in_progress");
    if (prepared.status !== "unknown" || prepared.observation === "conflict") return actionResult(prepared, true);
    const reconciled = await reconcileUnknown(prepared, this.config.store, this.config.greenhouse, this.config.signingSecret, this.clock);
    return actionResult(reconciled ?? prepared, true);
  }

  private async finishPreflightFailure(record: ActionRecord, ownerToken: string, errorCode: string) {
    return this.finishResult(record, ownerToken, { status: "failed", errorCode }, false);
  }

  private async finishResult(
    record: ActionRecord,
    ownerToken: string,
    outcome: {
      status: "succeeded" | "failed" | "unknown" | "reconciled";
      observation?: "desired_observed" | "not_observed" | "conflict" | null;
      errorCode?: string | null;
      upstreamStatus?: number | null;
      upstreamRequestId?: string | null;
      upstreamResourceId?: number | null;
    },
    mutationMayHaveHappened: boolean
  ): Promise<Record<string, unknown>> {
    try {
      const finished = await this.config.store.finishAction({
        actionId: record.actionId,
        ownerToken,
        status: outcome.status,
        observation: outcome.observation,
        errorCode: outcome.errorCode,
        upstreamStatus: outcome.upstreamStatus,
        upstreamRequestId: outcome.upstreamRequestId,
        upstreamResourceId: outcome.upstreamResourceId,
      });
      if (finished) return actionResult(finished, false);
      if (mutationMayHaveHappened) return actionResult({ ...record, status: "unknown", phase: "mutation_sent", errorCode: "ACTION_OWNERSHIP_LOST" }, false);
      return actionResult({ ...record, errorCode: "ACTION_OWNERSHIP_LOST" }, false, "in_progress");
    } catch (error) {
      // A write may already have happened. Never turn an audit-store failure into a retry signal.
      reportActionError("action_record_finalize_failed", error, { action_id: record.actionId });
    }
    if (mutationMayHaveHappened) return actionResult({ ...record, status: "unknown", phase: "mutation_sent", errorCode: "ACTION_STATE_UNAVAILABLE" }, false);
    return actionResult({ ...record, errorCode: "ACTION_STATE_UNAVAILABLE" }, false, "in_progress");
  }
}

export async function reconcileRecoverableActions(input: {
  store: ActionStore;
  greenhouse: GreenhouseGateway;
  signingSecret: string;
  clock?: Clock;
}): Promise<Record<string, unknown>[]> {
  const clock = input.clock ?? { now: () => Date.now(), delay: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };
  const results: Record<string, unknown>[] = [];
  for (const action of await input.store.listRecoverableActions()) {
    const prepared = await input.store.prepareReconciliation(action.actionId);
    if (!prepared || prepared.status === "executing") {
      if (prepared) results.push(actionResult(prepared, true, "in_progress"));
      continue;
    }
    if (prepared.status === "unknown") {
      const reconciled = await reconcileUnknown(prepared, input.store, input.greenhouse, input.signingSecret, clock);
      results.push(actionResult(reconciled ?? prepared, true));
    } else {
      results.push(actionResult(prepared, true));
    }
  }
  return results;
}

async function reconcileUnknown(
  record: ActionRecord,
  store: ActionStore,
  greenhouse: GreenhouseGateway,
  signingSecret: string,
  clock: Clock
): Promise<ActionRecord | null> {
  if (record.observation === "conflict") return record;
  const definition = actionDefinition(record.actionKind);
  const observation = await observeWithDelays(definition, record, {
    actorUserId: record.actorUserId,
    greenhouse,
    signingSecret,
    clock,
  }, clock);
  if (observation === "desired_observed") {
    return store.resolveUnknown({ actionId: record.actionId, status: "reconciled", observation });
  }
  if (observation === "conflict") {
    return store.resolveUnknown({ actionId: record.actionId, status: "unknown", observation, errorCode: "UPSTREAM_RESULT_CONFLICT" });
  }
  if (observation === "not_observed") return store.reconcileOriginalObservation(record.actionId);
  return store.deferUnknown(record.actionId);
}

async function observeWithDelays(
  definition: ActionDefinition,
  record: ActionRecord,
  context: ActionContext,
  clock: Clock
): Promise<Observation> {
  let sawUnavailable = false;
  for (const delay of READBACK_DELAYS_MS) {
    if (delay > 0) await clock.delay(delay);
    try {
      const observation = await definition.observe(record, context);
      if (observation === "desired_observed" || observation === "conflict") return observation;
      if (observation === "unavailable") sawUnavailable = true;
    } catch {
      sawUnavailable = true;
    }
  }
  return sawUnavailable ? "unavailable" : "not_observed";
}

function actionResult(record: ActionRecord, replayed: boolean, stateOverride?: string): Record<string, unknown> {
  return {
    action_id: record.actionId,
    action_kind: record.actionKind,
    state: stateOverride ?? record.status,
    observation: record.observation,
    error_code: record.errorCode,
    upstream_status: record.upstreamStatus,
    upstream_request_id: record.upstreamRequestId,
    result_resource_id: record.upstreamResourceId,
    replayed,
  };
}

function parseDefinitionInput(schema: ActionDefinition["previewSchema"], input: unknown, message: string): unknown {
  const result = schema.safeParse(input);
  if (!result.success) throw new ActionDeniedError("INPUT_INVALID", message);
  return result.data;
}

function publicPreflightError(error: unknown): ActionDeniedError {
  if (error instanceof ActionDeniedError) return error;
  if (error instanceof GreenhouseError) {
    return new ActionDeniedError("UPSTREAM_UNAVAILABLE", "Required Greenhouse state is unavailable.", {
      sourceErrorName: error.name,
      upstreamStatus: error.status,
      upstreamRequestId: error.requestId,
    });
  }
  return new ActionDeniedError("PREFLIGHT_FAILED", "Action preflight failed.", {
    sourceErrorName: error instanceof Error ? error.name : "UnknownError",
  });
}

function denialCode(error: unknown): string {
  return error instanceof ActionDeniedError ? error.code : "PREFLIGHT_FAILED";
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ActionDeniedError("INPUT_INVALID", message);
  return value as Record<string, unknown>;
}
