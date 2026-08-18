import { z } from "zod";
import { fingerprintValue } from "../crypto.js";
import type { RejectionBinding } from "../types.js";
import {
  authorizedApplication,
  classifyState,
  getApplication,
  getCurrentStage,
  nullablePositive,
  positive,
  prepared,
  uniqueById,
} from "./shared.js";
import type { ActionContext, ActionDefinition } from "./types.js";

const id = z.number().int().positive().safe();
const previewSchema = z.object({
  application_id: id,
  rejection_reason_id: id,
  notes: z.string().trim().min(1).max(50_000).optional(),
}).strict();
const approvalSchema = z.object({
  target: z.object({ application_id: id, job_id: id }).strict(),
  before: z.object({ status: z.literal("in_process"), interview_stage_id: id }).strict(),
  after: z.object({ status: z.literal("rejected"), rejection_reason_id: id, reason_name: z.string().nullable(), notes: z.string().optional() }).strict(),
  effects: z.array(z.string()).min(1).max(5),
}).strict();
const applySchema = z.object({ intent: z.string().min(1).max(131_072), approval: approvalSchema }).strict();

export interface RejectionState {
  status: string;
  interview_stage_id: number | null;
  rejection_reason_id: number | null;
  note_fingerprint: string | null;
}

export async function rejectionDetails(applicationId: number, context: ActionContext) {
  return context.greenhouse.list("/rejection_details", {
    application_ids: String(applicationId),
    per_page: "100",
    fields: "id,application_id,rejection_reason_id,rejection_note_id,rejected_at,rejected_by_id",
  }, context.actorUserId);
}

export async function readRejectionState(
  applicationId: number,
  context: ActionContext
): Promise<RejectionState | { conflict: true } | { unavailable: true }> {
  const application = await getApplication(applicationId, context);
  const details = await rejectionDetails(applicationId, context);
  if (details.length > 1) return { conflict: true };
  if (application.status !== "rejected") {
    if (application.status !== "in_process") return { conflict: true };
    if (details.length !== 0) return { unavailable: true };
    const stage = await getCurrentStage(applicationId, context);
    if (application.applicationStageId === null || application.applicationStageId !== stage.applicationStageId) {
      return { unavailable: true };
    }
    return {
      status: application.status,
      interview_stage_id: stage.interviewStageId,
      rejection_reason_id: null,
      note_fingerprint: null,
    };
  }
  if (details.length !== 1) return { unavailable: true };
  const detail = details[0]!;
  const noteId = nullablePositive(detail.rejection_note_id, "rejection note id");
  let noteFingerprint: string | null = null;
  if (noteId !== null) {
    const note = uniqueById(await context.greenhouse.list("/notes", {
      ids: String(noteId), fields: "id,body,candidate_id,application_id,type,user_id,visibility",
    }, context.actorUserId), noteId, "Rejection note");
    noteFingerprint = fingerprintValue("rejection-note", typeof note.body === "string" ? note.body : null, context.signingSecret);
  }
  return {
    status: "rejected",
    interview_stage_id: null,
    rejection_reason_id: positive(detail.rejection_reason_id, "rejection reason id"),
    note_fingerprint: noteFingerprint,
  };
}

async function prepare(input: z.infer<typeof previewSchema>, context: ActionContext) {
  const application = await authorizedApplication(input.application_id, context);
  if (application.status !== "in_process") throw new Error("Only an in-process application can be rejected.");
  if ((await rejectionDetails(application.id, context)).length !== 0) throw new Error("Application already has rejection details.");
  const stage = await getCurrentStage(application.id, context);
  if (application.applicationStageId === null || application.applicationStageId !== stage.applicationStageId) {
    throw new Error("Application and application-stage state disagree.");
  }
  const reason = uniqueById(await context.greenhouse.list("/rejection_reasons", {
    ids: String(input.rejection_reason_id), include_defaults: "true", fields: "id,name,type",
  }, context.actorUserId), input.rejection_reason_id, "Rejection reason");
  const beforeState: RejectionState = {
    status: "in_process",
    interview_stage_id: stage.interviewStageId,
    rejection_reason_id: null,
    note_fingerprint: null,
  };
  const afterState: RejectionState = {
    status: "rejected",
    interview_stage_id: null,
    rejection_reason_id: input.rejection_reason_id,
    note_fingerprint: input.notes === undefined ? null : fingerprintValue("rejection-note", input.notes, context.signingSecret),
  };
  const approval = {
    target: { application_id: application.id, job_id: application.jobId },
    before: { status: "in_process" as const, interview_stage_id: stage.interviewStageId },
    after: {
      status: "rejected" as const,
      rejection_reason_id: input.rejection_reason_id,
      reason_name: typeof reason.name === "string" ? reason.name : null,
      ...(input.notes === undefined ? {} : { notes: input.notes }),
    },
    effects: ["Rejects the application without sending a candidate email."],
  };
  const binding: RejectionBinding = {
    application_id: application.id,
    rejection_reason_id: input.rejection_reason_id,
    previous_interview_stage_id: stage.interviewStageId,
    has_notes: input.notes !== undefined,
  };
  return prepared({
    kind: "application_rejection",
    lockKey: `application:${application.id}`,
    scopeJobId: application.jobId,
    binding,
    current: beforeState,
    desired: afterState,
    approval,
    changeRequired: true,
    context,
    subject: { candidateId: application.candidateId, jobId: application.jobId },
    fenceTargets: [{ kind: "application", id: application.id, requiresUnredacted: false }],
  });
}

export const applicationRejectionAction: ActionDefinition = {
  kind: "application_rejection",
  previewTool: "preview_application_rejection",
  applyTool: "apply_application_rejection",
  previewTitle: "Preview application rejection",
  applyTitle: "Reject application",
  previewDescription: "Preview a structured rejection reason and optional notes without sending email.",
  applyDescription: "Reject the approved application exactly once without a rejection email.",
  destructive: true,
  previewSchema,
  applySchema,
  getApproval(value) { return applySchema.parse(value).approval; },
  preparePreview(value, context) { return prepare(previewSchema.parse(value), context); },
  prepareApply(value, context) {
    const approval = approvalSchema.parse(value);
    return prepare({
      application_id: approval.target.application_id,
      rejection_reason_id: approval.after.rejection_reason_id,
      notes: approval.after.notes,
    }, context);
  },
  async mutation(value, preparedAction) {
    const approval = approvalSchema.parse(value);
    const binding = preparedAction.binding as RejectionBinding;
    return {
      method: "POST",
      path: `/applications/${binding.application_id}/reject`,
      body: {
        rejection_reason_id: binding.rejection_reason_id,
        ...(approval.after.notes === undefined ? {} : { notes: approval.after.notes }),
      },
    };
  },
  async observe(record, context) {
    const binding = record.binding as RejectionBinding;
    const state = await readRejectionState(binding.application_id, context);
    if ("conflict" in state) return "conflict";
    if ("unavailable" in state) return "unavailable";
    if (binding.has_notes && state.status === "rejected"
      && state.rejection_reason_id === binding.rejection_reason_id && state.note_fingerprint === null) {
      return "unavailable";
    }
    return classifyState(record, state, context);
  },
};
