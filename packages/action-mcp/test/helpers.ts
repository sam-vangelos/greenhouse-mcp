import { GreenhouseError } from "../src/greenhouse.js";
import type {
  FenceTarget,
  TargetVisibilityProbe,
  VisibilityVerdict,
  ActionClient,
  ActionEntitlement,
  ActionIntent,
  ActionRecord,
  ActionSession,
  ActionStore,
  ClaimResult,
  Clock,
  GreenhouseGateway,
  GreenhouseRow,
  MutationResponse,
  ResolvedIdentity,
} from "../src/types.js";

/** Everything visible, nothing redacted — the pre-fence behavior, for tests not about the fence. */
export function allowAllVisibility(): TargetVisibilityProbe {
  return { async probe() { return { state: "visible", redacted: false }; } };
}

/** A probe returning one fixed verdict, recording what it was asked. */
export function probeReturning(verdict: VisibilityVerdict): TargetVisibilityProbe & { asked: FenceTarget[] } {
  const asked: FenceTarget[] = [];
  return { asked, async probe(target) { asked.push(target); return verdict; } };
}

export const TEST_SECRET = "action-test-signing-secret-that-is-at-least-32-bytes";
export const IDENTITY_ID = "11111111-1111-4111-8111-111111111111";

export function testSession(overrides: Partial<ActionSession> = {}): ActionSession {
  return {
    version: 1,
    kind: "greenhouse_action_session",
    audience: "greenhouse_action_mcp",
    subject: "google-subject-1",
    client: "test",
    tokenId: "action:test-session-1234",
    issuedAtMs: 1_700_000_000_000,
    expiresAtMs: 1_700_000_000_000 + 30 * 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

export class TestClock implements Clock {
  constructor(public value = 1_700_000_100_000) {}
  now(): number { return this.value; }
  async delay(ms: number): Promise<void> { this.value += ms; }
  advance(ms: number): void { this.value += ms; }
}

export class MemoryActionStore implements ActionStore {
  identity: ResolvedIdentity = { identityId: IDENTITY_ID, greenhouseUserId: 10 };
  entitlement: ActionEntitlement | null = {
    identityId: IDENTITY_ID,
    greenhouseUserId: 10,
    client: "test",
    canPreview: true,
    canApply: true,
    canApplyHighImpact: true,
  };
  revoked = false;
  failClaim = false;
  failBegin = false;
  failFinish = false;
  finishReturnsNull = false;
  readonly records = new Map<string, ActionRecord>();

  constructor(private readonly clock: TestClock) {}

  async resolveIdentity(_session: ActionSession): Promise<ResolvedIdentity> { return { ...this.identity }; }
  async isSessionRevoked(_tokenId: string): Promise<boolean> { return this.revoked; }
  async getEntitlement(_identity: ResolvedIdentity, client: ActionClient): Promise<ActionEntitlement | null> {
    return this.entitlement?.client === client ? clone(this.entitlement) : null;
  }
  async getAction(actionId: string): Promise<ActionRecord | null> { return clone(this.records.get(actionId) ?? null); }

  async claimAction(input: {
    intent: ActionIntent;
    subjectFingerprint: string;
    sessionFingerprint: string;
    ownerToken: string;
  }): Promise<ClaimResult> {
    if (this.failClaim) throw new Error("state unavailable");
    const replay = this.records.get(input.intent.actionId);
    if (replay) return { disposition: "replay", record: clone(replay) };
    const busy = [...this.records.values()].find((record) =>
      record.lockKey === input.intent.lockKey && (record.status === "executing" || record.status === "unknown")
    );
    if (busy) return { disposition: "target_busy", record: clone(busy) };
    const now = new Date(this.clock.now()).toISOString();
    const record: ActionRecord = {
      actionId: input.intent.actionId,
      actionKind: input.intent.actionKind,
      lockKey: input.intent.lockKey,
      scopeJobId: input.intent.scopeJobId,
      binding: clone(input.intent.binding),
      identityId: input.intent.identityId,
      actorUserId: input.intent.actorUserId,
      subjectFingerprint: input.subjectFingerprint,
      sessionFingerprint: input.sessionFingerprint,
      client: input.intent.client,
      currentFingerprint: input.intent.currentFingerprint,
      desiredFingerprint: input.intent.desiredFingerprint,
      approvalFingerprint: input.intent.approvalFingerprint,
      highImpact: input.intent.highImpact,
      intentExpiresAt: new Date(input.intent.expiresAtMs).toISOString(),
      notAppliedBefore: new Date(this.clock.now() + 90_000 + input.intent.reconciliationGraceMs).toISOString(),
      status: "executing",
      phase: "preflight",
      ownerToken: input.ownerToken,
      leaseExpiresAt: new Date(this.clock.now() + 90_000).toISOString(),
      observation: null,
      errorCode: null,
      upstreamStatus: null,
      upstreamRequestId: null,
      upstreamResourceId: null,
      firstOriginalObservationAt: null,
      resolutionSource: null,
      resolvedByFingerprint: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.actionId, record);
    return { disposition: "owned", record: clone(record) };
  }

  async beginMutation(input: { actionId: string; ownerToken: string }): Promise<boolean> {
    if (this.failBegin) return false;
    const record = this.records.get(input.actionId);
    if (!record || record.ownerToken !== input.ownerToken || record.status !== "executing" || record.phase !== "preflight"
      || Date.parse(record.leaseExpiresAt) <= this.clock.now() || Date.parse(record.intentExpiresAt) <= this.clock.now()) return false;
    record.phase = "mutation_sent";
    const graceMs = Date.parse(record.notAppliedBefore) - Date.parse(record.leaseExpiresAt);
    record.leaseExpiresAt = new Date(this.clock.now() + 120_000).toISOString();
    record.notAppliedBefore = new Date(Date.parse(record.leaseExpiresAt) + graceMs).toISOString();
    record.updatedAt = new Date(this.clock.now()).toISOString();
    return true;
  }

  async finishAction(input: {
    actionId: string;
    ownerToken: string;
    status: "succeeded" | "failed" | "unknown" | "reconciled";
    observation?: "desired_observed" | "not_observed" | "conflict" | null;
    errorCode?: string | null;
    upstreamStatus?: number | null;
    upstreamRequestId?: string | null;
    upstreamResourceId?: number | null;
  }): Promise<ActionRecord | null> {
    if (this.failFinish) throw new Error("state unavailable");
    if (this.finishReturnsNull) return null;
    const record = this.records.get(input.actionId);
    if (!record || record.ownerToken !== input.ownerToken || record.status !== "executing"
      || Date.parse(record.leaseExpiresAt) <= this.clock.now()
      || (record.phase !== "mutation_sent" && input.status !== "failed")) return null;
    record.status = input.status;
    record.observation = input.observation ?? null;
    record.errorCode = input.errorCode ?? null;
    record.upstreamStatus = input.upstreamStatus ?? null;
    record.upstreamRequestId = input.upstreamRequestId ?? null;
    record.upstreamResourceId = input.upstreamResourceId ?? null;
    record.resolutionSource = input.status === "reconciled" ? "automatic" : null;
    record.resolvedByFingerprint = null;
    record.completedAt = input.status === "unknown" ? null : new Date(this.clock.now()).toISOString();
    record.updatedAt = new Date(this.clock.now()).toISOString();
    return clone(record);
  }

  async prepareReconciliation(actionId: string): Promise<ActionRecord | null> {
    const record = this.records.get(actionId);
    if (!record) return null;
    if (record.status === "executing" && Date.parse(record.leaseExpiresAt) <= this.clock.now()) {
      if (record.phase === "preflight") {
        record.status = "failed";
        record.errorCode = "STALE_PREFLIGHT";
        record.completedAt = new Date(this.clock.now()).toISOString();
      } else {
        record.status = "unknown";
        record.errorCode = "STALE_MUTATION";
      }
    }
    return clone(record);
  }

  async deferUnknown(actionId: string): Promise<ActionRecord | null> {
    const record = this.records.get(actionId);
    if (!record || record.status !== "unknown" || record.observation === "conflict") return null;
    record.updatedAt = new Date(this.clock.now()).toISOString();
    return clone(record);
  }

  async reconcileOriginalObservation(actionId: string): Promise<ActionRecord | null> {
    const record = this.records.get(actionId);
    if (!record || record.status !== "unknown" || record.observation === "conflict") return null;
    record.observation = "not_observed";
    if (record.firstOriginalObservationAt === null) {
      record.firstOriginalObservationAt = new Date(this.clock.now()).toISOString();
    } else if (this.clock.now() >= Date.parse(record.notAppliedBefore)
      && this.clock.now() >= Date.parse(record.firstOriginalObservationAt) + 30_000) {
      record.status = "reconciled";
      record.errorCode = "UPSTREAM_RESULT_NOT_APPLIED";
      record.resolutionSource = "automatic";
      record.completedAt = new Date(this.clock.now()).toISOString();
    }
    return clone(record);
  }

  async resolveUnknown(input: {
    actionId: string;
    status: "reconciled" | "unknown";
    observation: "desired_observed" | "not_observed" | "conflict";
    errorCode?: string | null;
    resolutionSource?: "automatic" | "operator";
    resolvedByFingerprint?: string | null;
  }): Promise<ActionRecord | null> {
    const record = this.records.get(input.actionId);
    if (!record || record.status !== "unknown") return null;
    const source = input.resolutionSource ?? "automatic";
    if (source === "automatic" && record.observation === "conflict") return clone(record);
    record.status = input.status;
    record.observation = input.observation;
    record.errorCode = input.errorCode ?? null;
    record.resolutionSource = input.status === "reconciled" ? source : null;
    record.resolvedByFingerprint = input.status === "reconciled" ? input.resolvedByFingerprint ?? null : null;
    record.completedAt = input.status === "reconciled" ? new Date(this.clock.now()).toISOString() : null;
    return clone(record);
  }

  async listRecoverableActions(): Promise<ActionRecord[]> {
    return [...this.records.values()]
      .filter((record) => (record.status === "executing" || record.status === "unknown") && record.observation !== "conflict")
      .map(clone);
  }
}

type ListHandler = (params: Record<string, string>, actorUserId: number) => GreenhouseRow[] | Promise<GreenhouseRow[]>;
type MutationHandler = (input: {
  method: "POST" | "PATCH" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
  actorUserId: number;
}) => MutationResponse | Promise<MutationResponse>;

export class RouteGreenhouse implements GreenhouseGateway {
  readonly listCalls: Array<{ path: string; params: Record<string, string>; actorUserId: number }> = [];
  readonly mutationCalls: Array<{ method: "POST" | "PATCH" | "DELETE"; path: string; body?: Record<string, unknown>; actorUserId: number }> = [];
  afterList: (() => void) | null = null;
  private readonly listHandlers = new Map<string, ListHandler>();
  private readonly mutationHandlers = new Map<string, MutationHandler>();

  onList(path: string, handler: ListHandler): this {
    this.listHandlers.set(path, handler);
    return this;
  }

  onMutation(method: "POST" | "PATCH" | "DELETE", path: string, handler: MutationHandler): this {
    this.mutationHandlers.set(`${method} ${path}`, handler);
    return this;
  }

  async probe(): Promise<void> {}

  async list(path: string, params: Record<string, string>, actorUserId: number): Promise<GreenhouseRow[]> {
    this.listCalls.push({ path, params: { ...params }, actorUserId });
    const handler = this.listHandlers.get(path);
    if (!handler) throw new Error(`Unexpected Greenhouse list route: ${path}`);
    const result = await handler(params, actorUserId);
    this.afterList?.();
    this.afterList = null;
    return clone(result);
  }

  async mutate(input: {
    method: "POST" | "PATCH" | "DELETE";
    path: string;
    body?: Record<string, unknown>;
    actorUserId: number;
  }): Promise<MutationResponse> {
    this.mutationCalls.push(clone(input));
    const handler = this.mutationHandlers.get(`${input.method} ${input.path}`);
    if (!handler) throw new Error(`Unexpected Greenhouse mutation route: ${input.method} ${input.path}`);
    return clone(await handler(input));
  }
}

export type MutationBehavior = "success" | "definite_failure" | "ambiguous_desired" | "ambiguous_original";

export function assignmentGreenhouse() {
  const greenhouse = new RouteGreenhouse();
  const state = {
    application: {
      id: 100,
      candidate_id: 300,
      job_id: 200,
      recruiter_id: 20 as number | null,
      coordinator_id: 30 as number | null,
      stage_id: 500,
      status: "in_process",
      source_id: 600 as number | null,
      referrer_id: 700 as number | null,
    },
    users: new Map<number, GreenhouseRow>([
      [10, { id: 10, name: "Actor", deactivated: false, site_admin: false }],
      [20, { id: 20, name: "Current Recruiter", deactivated: false, site_admin: false }],
      [30, { id: 30, name: "Current Coordinator", deactivated: false, site_admin: false }],
      [40, { id: 40, name: "Proposed", deactivated: false, site_admin: false }],
    ]),
    job: { id: 200, confidential: false, name: "Staff Forward Deployed AI Engineer - India" },
    candidate: { id: 300, first_name: "Priya", last_name: "Raman" } as GreenhouseRow,
    currentStage: { id: 500, application_id: 100, job_interview_stage_id: 601, current: true },
    permitted: true,
    mutationBehavior: "success" as MutationBehavior,
  };

  greenhouse
    .onList("/applications", (params) => params.ids === "100" ? [state.application] : [])
    .onList("/users", (params) => String(params.ids).split(",").flatMap((raw) => {
      const row = state.users.get(Number(raw));
      return row ? [row] : [];
    }))
    .onList("/jobs", (params) => params.ids === "200" ? [state.job] : [])
    .onList("/candidates", (params) => params.ids === "300" ? [state.candidate] : [])
    .onList("/user_job_permissions", (params) => state.permitted
      ? [{ id: 900, user_id: Number(params.user_ids), job_id: Number(params.job_ids), role_id: 1, automated: false }]
      : [])
    .onList("/application_stages", () => [state.currentStage])
    .onList("/job_interview_stages", (params) => [{
      id: Number(params.ids), job_id: 200, name: "Onsite", active: true, sort_order: 2,
    }])
    .onMutation("PATCH", "/applications/100", (input) => {
      if (state.mutationBehavior === "definite_failure") {
        throw new GreenhouseError("rejected", { status: 422, requestId: "request-rejected", ambiguous: false });
      }
      if (state.mutationBehavior === "success" || state.mutationBehavior === "ambiguous_desired") {
        if (Object.hasOwn(input.body ?? {}, "recruiter_id")) state.application.recruiter_id = input.body!.recruiter_id as number;
        if (Object.hasOwn(input.body ?? {}, "coordinator_id")) state.application.coordinator_id = input.body!.coordinator_id as number;
      }
      if (state.mutationBehavior.startsWith("ambiguous")) {
        throw new GreenhouseError("unknown", { requestId: "request-unknown", ambiguous: true });
      }
      return { status: 200, requestId: "request-success", body: { id: 100 } };
    })
    .onMutation("POST", "/applications/100/move", (input) => {
      state.currentStage.job_interview_stage_id = Number(input.body?.to_stage_id);
      return { status: 200, requestId: "request-success", body: { id: 100 } };
    });
  return { greenhouse, state };
}

export function clone<T>(value: T): T { return structuredClone(value); }
