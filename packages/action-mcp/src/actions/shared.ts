import { fingerprintValue } from "../crypto.js";
import { ActionDeniedError } from "../errors.js";
import type {
  FenceTarget,
  ActionBinding,
  ActionKind,
  ActionRecord,
  GreenhouseRow,
  Observation,
  PreparedAction,
} from "../types.js";
import type { ActionContext } from "./types.js";

export interface ApplicationState {
  id: number;
  candidateId: number;
  jobId: number;
  recruiterId: number | null;
  coordinatorId: number | null;
  applicationStageId: number | null;
  status: "in_process" | "rejected" | "hired" | "converted";
  sourceId: number | null;
  referrerId: number | null;
}

export interface CurrentStage {
  applicationStageId: number;
  interviewStageId: number;
  current: boolean;
}

export async function authorizedApplication(applicationId: number, context: ActionContext): Promise<ApplicationState> {
  const application = await getApplication(applicationId, context);
  await assertJobAccess(application.jobId, context);
  return application;
}

export async function getApplication(applicationId: number, context: ActionContext): Promise<ApplicationState> {
  const rows = await context.greenhouse.list("/applications", {
    ids: String(applicationId),
    fields: "id,candidate_id,job_id,recruiter_id,coordinator_id,stage_id,status,source_id,referrer_id",
  }, context.actorUserId);
  const row = uniqueById(rows, applicationId, "Application");
  const status = row.status;
  if (status !== "in_process" && status !== "rejected" && status !== "hired" && status !== "converted") {
    throw new ActionDeniedError("UPSTREAM_STATE_INVALID", "Greenhouse returned an invalid application status.");
  }
  return {
    id: positive(row.id, "application id"),
    candidateId: positive(row.candidate_id, "candidate id"),
    jobId: positive(row.job_id, "application job id"),
    recruiterId: nullablePositive(row.recruiter_id, "application recruiter id"),
    coordinatorId: nullablePositive(row.coordinator_id, "application coordinator id"),
    applicationStageId: nullablePositive(row.stage_id, "application stage id"),
    status,
    sourceId: nullablePositive(row.source_id, "application source id"),
    referrerId: nullablePositive(row.referrer_id, "application referrer id"),
  };
}

export async function getCurrentStage(applicationId: number, context: ActionContext): Promise<CurrentStage> {
  const rows = await context.greenhouse.list("/application_stages", {
    application_ids: String(applicationId),
    current: "true",
    fields: "id,application_id,job_interview_stage_id,current,entered_at,exited_at",
  }, context.actorUserId);
  const matches = rows.filter((row) => row.application_id === applicationId && row.current === true);
  if (matches.length !== 1) throw new ActionDeniedError("TARGET_NOT_FOUND", "Current application stage was not found uniquely.");
  return {
    applicationStageId: positive(matches[0]!.id, "application stage row id"),
    interviewStageId: positive(matches[0]!.job_interview_stage_id, "job interview stage id"),
    current: true,
  };
}

export async function assertJobAccess(jobId: number, context: ActionContext): Promise<void> {
  const [users, jobs, permissions] = await Promise.all([
    context.greenhouse.list("/users", {
      ids: String(context.actorUserId),
      fields: "id,name,deactivated,site_admin",
      show_service_accounts: "true",
    }, context.actorUserId),
    context.greenhouse.list("/jobs", { ids: String(jobId), fields: "id,confidential" }, context.actorUserId),
    context.greenhouse.list("/user_job_permissions", {
      user_ids: String(context.actorUserId),
      job_ids: String(jobId),
      fields: "id,user_id,job_id,role_id,automated",
    }, context.actorUserId),
  ]);
  const actor = uniqueById(users, context.actorUserId, "Greenhouse actor");
  const job = uniqueById(jobs, jobId, "Job");
  if (actor.deactivated !== false) throw new ActionDeniedError("ACTOR_INACTIVE", "Resolved Greenhouse actor is not active.");
  if (typeof actor.site_admin !== "boolean" || typeof job.confidential !== "boolean") {
    throw new ActionDeniedError("UPSTREAM_STATE_INVALID", "Greenhouse omitted required permission state.");
  }
  const explicit = permissions.some((row) => row.user_id === context.actorUserId && row.job_id === jobId);
  if (!(actor.site_admin && job.confidential === false) && !explicit) {
    throw new ActionDeniedError("JOB_PERMISSION_DENIED", "Actor does not currently have access to this job.");
  }
}

export async function assertActiveUser(userId: number, context: ActionContext): Promise<GreenhouseRow> {
  const rows = await context.greenhouse.list("/users", {
    ids: String(userId), fields: "id,name,deactivated,site_admin", show_service_accounts: "true",
  }, context.actorUserId);
  const user = uniqueById(rows, userId, "Greenhouse user");
  if (user.deactivated !== false) throw new ActionDeniedError("USER_INACTIVE", "Selected Greenhouse user is not active.");
  return user;
}

export async function assertUserMayOwnJob(userId: number, jobId: number, context: ActionContext): Promise<GreenhouseRow> {
  const user = await assertActiveUser(userId, context);
  if (user.site_admin === true) return user;
  const permissions = await context.greenhouse.list("/user_job_permissions", {
    user_ids: String(userId), job_ids: String(jobId), fields: "id,user_id,job_id,role_id,automated",
  }, context.actorUserId);
  if (!permissions.some((row) => row.user_id === userId && row.job_id === jobId)) {
    throw new ActionDeniedError("USER_JOB_PERMISSION_DENIED", "Selected user does not have access to this job.");
  }
  return user;
}

/**
 * Human-readable names for the ids a delta is about.
 *
 * Why this exists: every approval payload identifies its target by bare integer — `application_id`,
 * `candidate_id`, `job_id`. A human asked to approve "application 4821 -> Onsite" cannot check it,
 * so exact-delta approval does nothing on its own; and an injected instruction that swaps the target
 * id produces a delta that looks locally correct while naming the wrong person. A name is what makes
 * both visible.
 *
 * Best-effort by design. A label lookup that fails must never fail the preview: these are for
 * legibility, not authorization, and every real gate has already run by this point. A missing name
 * comes back null and is rendered as unavailable rather than silently omitted, so the human can tell
 * "we could not name this" from "this has no name".
 */
export interface ActionLabels {
  candidate: string | null;
  job: string | null;
}

async function labelFor(
  path: string,
  id: number,
  render: (row: GreenhouseRow) => string | null,
  context: ActionContext
): Promise<string | null> {
  try {
    const rows = await context.greenhouse.list(path, { ids: String(id), per_page: "1" }, context.actorUserId);
    const row = rows.find((candidate) => Number(candidate.id) === id);
    return row ? render(row) : null;
  } catch {
    return null;
  }
}

export async function resolveActionLabels(
  input: { candidateId?: number | null; jobId?: number | null },
  context: ActionContext
): Promise<ActionLabels> {
  const [candidate, job] = await Promise.all([
    input.candidateId
      ? labelFor("/candidates", input.candidateId, (row) => {
          const name = [row.first_name, row.last_name].filter((part) => typeof part === "string" && part.length > 0).join(" ");
          return name.length > 0 ? name : null;
        }, context)
      : Promise.resolve(null),
    input.jobId
      ? labelFor("/jobs", input.jobId, (row) => (typeof row.name === "string" && row.name.length > 0 ? row.name : null), context)
      : Promise.resolve(null),
  ]);
  return { candidate, job };
}

export async function prepared(input: {
  kind: ActionKind;
  lockKey: string;
  scopeJobId: number | null;
  binding: ActionBinding;
  current: unknown;
  desired: unknown;
  approval: Record<string, unknown>;
  preview?: Record<string, unknown>;
  highImpact?: boolean;
  reconciliationGraceMs?: number;
  changeRequired: boolean;
  context: ActionContext;
  /**
   * REQUIRED, so a twelfth action cannot forget it. Every mutation is about a job, a candidate, or
   * both; an action with genuinely neither would have to say `{}` out loud, which is a decision
   * someone makes rather than an omission nobody notices.
   */
  subject: { candidateId?: number | null; jobId?: number | null };
  /** The visibility-fence targets, per the §4.4 table. Required for the same reason subject is. */
  fenceTargets: readonly FenceTarget[];
}): Promise<PreparedAction> {
  const domain = input.kind.replaceAll("_", "-");
  // Merged into PREVIEW, never into approval. The approval is fingerprinted and echoed back on
  // apply, so a candidate renamed between preview and apply would fail assertPreparedMatches as
  // STATE_CHANGED — a false stop, since nothing about the mutation changed. The preview is what the
  // human reads; the fingerprint stays over the ids.
  const labels = await resolveActionLabels(input.subject, input.context);
  const named = {
    ...(input.subject.candidateId ? { candidate: labels.candidate ?? "(name unavailable)" } : {}),
    ...(input.subject.jobId ? { job: labels.job ?? "(name unavailable)" } : {}),
  };
  const basePreview = input.preview ?? input.approval;
  // `subject` FIRST, so the human reads who this is about before reading what changes.
  const preview = Object.keys(named).length > 0 ? { subject: named, ...basePreview } : basePreview;
  return {
    actionKind: input.kind,
    lockKey: input.lockKey,
    scopeJobId: input.scopeJobId,
    binding: input.binding,
    currentFingerprint: fingerprintValue(`${domain}-current`, input.current, input.context.signingSecret),
    desiredFingerprint: fingerprintValue(`${domain}-desired`, input.desired, input.context.signingSecret),
    approvalFingerprint: fingerprintValue("approval", input.approval, input.context.signingSecret),
    highImpact: input.highImpact ?? false,
    reconciliationGraceMs: input.reconciliationGraceMs ?? 5 * 60_000,
    changeRequired: input.changeRequired,
    approval: input.approval,
    preview,
    fenceTargets: input.fenceTargets,
  };
}

export function classifyState(record: ActionRecord, current: unknown, context: ActionContext): Observation {
  const domain = record.actionKind.replaceAll("_", "-");
  const currentAsDesired = fingerprintValue(`${domain}-desired`, current, context.signingSecret);
  if (currentAsDesired === record.desiredFingerprint) return "desired_observed";
  const currentAsOriginal = fingerprintValue(`${domain}-current`, current, context.signingSecret);
  return currentAsOriginal === record.currentFingerprint ? "not_observed" : "conflict";
}

export function approval(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ActionDeniedError("APPROVAL_DISPLAY_MISMATCH", "Approved action details are invalid.");
  return value;
}

export function uniqueById(rows: GreenhouseRow[], id: number, label: string): GreenhouseRow {
  const matches = rows.filter((row) => row.id === id);
  if (matches.length !== 1) throw new ActionDeniedError("TARGET_NOT_FOUND", `${label} was not found uniquely.`);
  return matches[0]!;
}

export function positive(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ActionDeniedError("UPSTREAM_STATE_INVALID", `Greenhouse returned an invalid ${label}.`);
  }
  return value;
}

export function nullablePositive(value: unknown, label: string): number | null {
  return value === null ? null : positive(value, label);
}

export function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new ActionDeniedError("UPSTREAM_STATE_INVALID", `Greenhouse returned an invalid ${label}.`);
  return value;
}

export function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}

export function rowObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ActionDeniedError("UPSTREAM_STATE_INVALID", `Greenhouse returned an invalid ${label}.`);
  return value;
}

export function sortedIds(rows: GreenhouseRow[]): number[] {
  return rows.map((row) => positive(row.id, "resource id")).sort((a, b) => a - b);
}

export function sameValue(left: unknown, right: unknown, context: ActionContext): boolean {
  return fingerprintValue("comparison", left, context.signingSecret) === fingerprintValue("comparison", right, context.signingSecret);
}

export function createdResourceId(response: { body: unknown }): number | null {
  return isRecord(response.body) && typeof response.body.id === "number" && Number.isSafeInteger(response.body.id) && response.body.id > 0
    ? response.body.id : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
