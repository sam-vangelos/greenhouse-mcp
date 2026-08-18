export const ACTION_KINDS = [
  "application_assignment_change",
  "job_owner_change",
  "application_stage_move",
  "application_rejection",
  "application_unreject",
  "candidate_note_create",
  "job_note_change",
  "application_attribution_change",
  "candidate_record_update",
  "offer_create",
  "offer_update",
] as const;

export type ActionKind = typeof ACTION_KINDS[number];
export type ActionClient = "codex" | "claude_code" | "claude_desktop_chat" | "test";
export type AssignmentRole = "recruiter" | "coordinator";
export type OwnerType = "sourcer" | "recruiter" | "coordinator";

export interface ActionSession {
  version: 1;
  kind: "greenhouse_action_session" | "greenhouse_assignment_action_session";
  audience: "greenhouse_action_mcp" | "greenhouse_assignment_action_mcp";
  subject: string;
  client: ActionClient;
  tokenId: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

export interface ResolvedIdentity {
  identityId: string;
  greenhouseUserId: number;
}

export interface ActionEntitlement {
  identityId: string;
  greenhouseUserId: number;
  client: ActionClient;
  canPreview: boolean;
  canApply: boolean;
  canApplyHighImpact: boolean;
}

export interface AssignmentBinding {
  application_id: number;
  assignment_role: AssignmentRole;
  previous_user_id: number | null;
  proposed_user_id: number;
}

export interface JobOwnerBinding {
  job_id: number;
  user_id: number;
  owner_type: OwnerType;
  verb: "add" | "remove";
  owner_row_id: number | null;
}

export interface StageMoveBinding {
  application_id: number;
  from_application_stage_id: number;
  from_interview_stage_id: number;
  to_interview_stage_id: number;
}

export interface RejectionBinding {
  application_id: number;
  rejection_reason_id: number;
  previous_interview_stage_id: number;
  has_notes: boolean;
}

export interface UnrejectBinding {
  application_id: number;
  previous_interview_stage_id: number;
}

export interface CandidateNoteBinding {
  application_id: number;
  candidate_id: number;
  note_type: "NOTE" | "ACTIVITY";
  visibility: "admin_only" | "private" | "public";
  baseline_count: number;
  baseline_fingerprint: string;
}

export interface JobNoteBinding {
  job_id: number;
  verb: "create" | "update" | "delete";
  note_id: number | null;
  visibility: "admin_only_visible" | "privately_visible" | null;
  baseline_count: number;
  baseline_fingerprint: string;
}

export interface AttributionBinding {
  application_id: number;
  source_id: number | null;
  referrer_id: number | null;
  touches_source: boolean;
  touches_referrer: boolean;
}

export interface CandidateUpdateBinding {
  candidate_id: number;
  context_application_id: number;
  fields: string[];
}

export interface OfferCreateBinding {
  application_id: number;
  fields: string[];
  baseline_ids: number[];
  has_currency: boolean;
}

export interface OfferUpdateBinding {
  application_id: number;
  offer_id: number;
  version: number;
  fields: string[];
  has_currency: boolean;
}

export type ActionBinding =
  | AssignmentBinding
  | JobOwnerBinding
  | StageMoveBinding
  | RejectionBinding
  | UnrejectBinding
  | CandidateNoteBinding
  | JobNoteBinding
  | AttributionBinding
  | CandidateUpdateBinding
  | OfferCreateBinding
  | OfferUpdateBinding;

export interface ActionIntent {
  version: 2;
  kind: "greenhouse_action_intent";
  actionId: string;
  actionKind: ActionKind;
  subject: string;
  identityId: string;
  actorUserId: number;
  sessionTokenId: string;
  client: ActionClient;
  applyTool: string;
  lockKey: string;
  scopeJobId: number | null;
  binding: ActionBinding;
  currentFingerprint: string;
  desiredFingerprint: string;
  approvalFingerprint: string;
  highImpact: boolean;
  reconciliationGraceMs: number;
  issuedAtMs: number;
  expiresAtMs: number;
}

export type ActionStatus = "executing" | "succeeded" | "failed" | "unknown" | "reconciled";
export type ActionPhase = "preflight" | "mutation_sent";
export type ReconciliationObservation = "desired_observed" | "not_observed" | "conflict";
export type Observation = ReconciliationObservation | "unavailable";

export interface ActionRecord {
  actionId: string;
  actionKind: ActionKind;
  lockKey: string;
  scopeJobId: number | null;
  binding: ActionBinding;
  identityId: string;
  actorUserId: number;
  subjectFingerprint: string;
  sessionFingerprint: string;
  client: ActionClient;
  currentFingerprint: string;
  desiredFingerprint: string;
  approvalFingerprint: string;
  highImpact: boolean;
  intentExpiresAt: string;
  notAppliedBefore: string;
  status: ActionStatus;
  phase: ActionPhase;
  ownerToken: string;
  leaseExpiresAt: string;
  observation: ReconciliationObservation | null;
  errorCode: string | null;
  upstreamStatus: number | null;
  upstreamRequestId: string | null;
  upstreamResourceId: number | null;
  firstOriginalObservationAt: string | null;
  resolutionSource: "automatic" | "operator" | null;
  resolvedByFingerprint: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ClaimResult =
  | { disposition: "owned"; record: ActionRecord }
  | { disposition: "replay"; record: ActionRecord }
  | { disposition: "target_busy"; record: ActionRecord };

export interface ActionStore {
  resolveIdentity(session: ActionSession): Promise<ResolvedIdentity>;
  isSessionRevoked(tokenId: string): Promise<boolean>;
  getEntitlement(identity: ResolvedIdentity, client: ActionClient): Promise<ActionEntitlement | null>;
  getAction(actionId: string): Promise<ActionRecord | null>;
  claimAction(input: {
    intent: ActionIntent;
    subjectFingerprint: string;
    sessionFingerprint: string;
    ownerToken: string;
  }): Promise<ClaimResult>;
  beginMutation(input: { actionId: string; ownerToken: string }): Promise<boolean>;
  finishAction(input: {
    actionId: string;
    ownerToken: string;
    status: Exclude<ActionStatus, "executing">;
    observation?: ReconciliationObservation | null;
    errorCode?: string | null;
    upstreamStatus?: number | null;
    upstreamRequestId?: string | null;
    upstreamResourceId?: number | null;
  }): Promise<ActionRecord | null>;
  prepareReconciliation(actionId: string): Promise<ActionRecord | null>;
  deferUnknown(actionId: string): Promise<ActionRecord | null>;
  reconcileOriginalObservation(actionId: string): Promise<ActionRecord | null>;
  resolveUnknown(input: {
    actionId: string;
    status: "reconciled" | "unknown";
    observation: ReconciliationObservation;
    errorCode?: string | null;
    resolutionSource?: "automatic" | "operator";
    resolvedByFingerprint?: string | null;
  }): Promise<ActionRecord | null>;
  listRecoverableActions(): Promise<ActionRecord[]>;
}

export type GreenhouseRow = Record<string, unknown>;

export interface MutationResponse {
  status: number;
  requestId: string | null;
  body: unknown;
}

export interface GreenhouseGateway {
  probe(): Promise<void>;
  list(path: string, params: Record<string, string>, actorUserId: number): Promise<GreenhouseRow[]>;
  mutate(input: {
    method: "POST" | "PATCH" | "DELETE";
    path: string;
    body?: Record<string, unknown>;
    actorUserId: number;
  }): Promise<MutationResponse>;
}

export interface Clock {
  now(): number;
  delay(ms: number): Promise<void>;
}

/**
 * The visibility fence seam — Phase 2c §4.1.
 *
 * A mutation may proceed only if the acting human can read, through the scoped read plane's FULL
 * pipeline, every resource that mutation reads or discloses — and the read plane's answer, not a
 * second implementation of it, is what decides. These types are the seam that carries that answer
 * across the package boundary: the recruiter host implements the probe against its own read
 * pipeline; this package only consumes verdicts.
 *
 * Three states, not a boolean, because the read plane returns denials AS VALUES. Collapsing them
 * would turn a transient permission-lookup outage into a silent authorization denial. `hidden`
 * denies; `unavailable` ALSO denies — with a distinct code, so an outage is diagnosable instead of
 * looking like a revoked grant.
 */
export type TargetKind = "application" | "candidate" | "job" | "offer" | "job_note";

export interface FenceTarget {
  kind: TargetKind;
  id: number;
  /** This target's data is read into the mutation or its preview, so redaction is data loss. */
  requiresUnredacted: boolean;
}

export type VisibilityVerdict =
  | { state: "visible"; redacted: boolean }
  | { state: "hidden" }
  | { state: "unavailable"; reason: string };

export interface TargetVisibilityProbe {
  probe(target: FenceTarget, signal?: AbortSignal): Promise<VisibilityVerdict>;
}

export interface PreparedAction {
  actionKind: ActionKind;
  lockKey: string;
  scopeJobId: number | null;
  binding: ActionBinding;
  currentFingerprint: string;
  desiredFingerprint: string;
  approvalFingerprint: string;
  highImpact: boolean;
  reconciliationGraceMs: number;
  changeRequired: boolean;
  approval: Record<string, unknown>;
  preview: Record<string, unknown>;
  /**
   * The resources this action reads or discloses — per §4.4, NOT the aggregate root. Required, so a
   * twelfth action cannot forget it: job scope is per-parent, but redaction is per-resource and
   * per-field, and both wrong spec drafts came from conflating them.
   */
  fenceTargets: readonly FenceTarget[];
}

export interface MutationPlan {
  method: "POST" | "PATCH" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
}
