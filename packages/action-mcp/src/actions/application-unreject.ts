import { z } from "zod";
import type { UnrejectBinding } from "../types.js";
import {
  authorizedApplication,
  classifyState,
  positive,
  prepared,
} from "./shared.js";
import { readRejectionState, rejectionDetails } from "./application-rejection.js";
import type { ActionContext, ActionDefinition } from "./types.js";

const id = z.number().int().positive().safe();
const previewSchema = z.object({ application_id: id }).strict();
const approvalSchema = z.object({
  target: z.object({ application_id: id, job_id: id }).strict(),
  before: z.object({ status: z.literal("rejected"), rejection_reason_id: id, rejection_note_id: id.nullable() }).strict(),
  after: z.object({
    status: z.literal("in_process"),
    interview_stage_id: id,
    rejection_reason_id: z.null(),
    rejection_note_id: z.null(),
  }).strict(),
  effects: z.array(z.string()).min(1).max(5),
}).strict();
const applySchema = z.object({ intent: z.string().min(1).max(131_072), approval: approvalSchema }).strict();

async function prepare(input: z.infer<typeof previewSchema>, context: ActionContext) {
  const application = await authorizedApplication(input.application_id, context);
  if (application.status !== "rejected") throw new Error("Only a rejected application can be unrejected.");
  const details = await rejectionDetails(application.id, context);
  if (details.length !== 1) throw new Error("Rejection details were not found uniquely.");
  const detail = details[0]!;
  const rejectedAt = typeof detail.rejected_at === "string" ? Date.parse(detail.rejected_at) : Number.NaN;
  const history = await context.greenhouse.list("/application_stages", {
    application_ids: String(application.id),
    per_page: "500",
    fields: "id,application_id,job_interview_stage_id,current,entered_at,exited_at",
  }, context.actorUserId);
  const eligible = history.filter((row) => {
    const entered = typeof row.entered_at === "string" ? Date.parse(row.entered_at) : Number.NaN;
    return row.application_id === application.id && Number.isFinite(entered) && (!Number.isFinite(rejectedAt) || entered <= rejectedAt);
  }).sort((left, right) => Date.parse(String(right.entered_at)) - Date.parse(String(left.entered_at)));
  if (eligible.length === 0) throw new Error("The pre-rejection interview stage could not be resolved.");
  const previousStageId = positive(eligible[0]!.job_interview_stage_id, "pre-rejection interview stage id");
  const beforeState = await readRejectionState(application.id, context);
  if ("conflict" in beforeState || "unavailable" in beforeState) throw new Error("Rejection state is unavailable.");
  const reasonId = positive(detail.rejection_reason_id, "rejection reason id");
  const noteId = detail.rejection_note_id === null ? null : positive(detail.rejection_note_id, "rejection note id");
  const approval = {
    target: { application_id: application.id, job_id: application.jobId },
    before: { status: "rejected" as const, rejection_reason_id: reasonId, rejection_note_id: noteId },
    after: {
      status: "in_process" as const,
      interview_stage_id: previousStageId,
      rejection_reason_id: null,
      rejection_note_id: null,
    },
    effects: [
      "Restores the application to its most recent pre-rejection interview stage.",
      "Clears the active rejection reason and linked rejection-note reference.",
    ],
  };
  const binding: UnrejectBinding = { application_id: application.id, previous_interview_stage_id: previousStageId };
  return prepared({
    kind: "application_unreject",
    lockKey: `application:${application.id}`,
    scopeJobId: application.jobId,
    binding,
    current: beforeState,
    desired: {
      status: "in_process",
      interview_stage_id: previousStageId,
      rejection_reason_id: null,
      note_fingerprint: null,
    },
    approval,
    changeRequired: true,
    context,
    subject: { candidateId: application.candidateId, jobId: application.jobId },
    fenceTargets: [{ kind: "application", id: application.id, requiresUnredacted: false }],
  });
}

export const applicationUnrejectAction: ActionDefinition = {
  kind: "application_unreject",
  previewTool: "preview_application_unreject",
  applyTool: "apply_application_unreject",
  previewTitle: "Preview application unreject",
  applyTitle: "Unreject application",
  previewDescription: "Preview restoring a rejected application to its pre-rejection stage.",
  applyDescription: "Unreject the approved application once and verify the restored stage.",
  destructive: true,
  previewSchema,
  applySchema,
  getApproval(value) { return applySchema.parse(value).approval; },
  preparePreview(value, context) { return prepare(previewSchema.parse(value), context); },
  prepareApply(value, context) { return prepare({ application_id: approvalSchema.parse(value).target.application_id }, context); },
  async mutation(_value, preparedAction) {
    return { method: "POST", path: `/applications/${(preparedAction.binding as UnrejectBinding).application_id}/unreject`, body: {} };
  },
  async observe(record, context) {
    const binding = record.binding as UnrejectBinding;
    const state = await readRejectionState(binding.application_id, context);
    if ("conflict" in state) return "conflict";
    return "unavailable" in state ? "unavailable" : classifyState(record, state, context);
  },
};
