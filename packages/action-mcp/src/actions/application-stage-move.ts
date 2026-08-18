import { z } from "zod";
import type { StageMoveBinding } from "../types.js";
import {
  authorizedApplication,
  classifyState,
  getApplication,
  getCurrentStage,
  positive,
  prepared,
  uniqueById,
} from "./shared.js";
import type { ActionContext, ActionDefinition } from "./types.js";

const id = z.number().int().positive().safe();
const previewSchema = z.object({ application_id: id, to_stage_id: id }).strict();
const approvalSchema = z.object({
  target: z.object({ application_id: id, job_id: id }).strict(),
  before: z.object({ application_stage_id: id, interview_stage_id: id }).strict(),
  after: z.object({ interview_stage_id: id, stage_name: z.string().nullable() }).strict(),
  effects: z.array(z.string()).min(1).max(5),
}).strict();
const applySchema = z.object({ intent: z.string().min(1).max(131_072), approval: approvalSchema }).strict();

async function prepare(input: z.infer<typeof previewSchema>, context: ActionContext) {
  const application = await authorizedApplication(input.application_id, context);
  if (application.status !== "in_process") throw new Error("Only an in-process application can move stages.");
  const current = await getCurrentStage(application.id, context);
  if (application.applicationStageId === null || current.applicationStageId !== application.applicationStageId) {
    throw new Error("Application and application-stage state disagree.");
  }
  const destinationRows = await context.greenhouse.list("/job_interview_stages", {
    ids: String(input.to_stage_id),
    job_ids: String(application.jobId),
    active: "true",
    fields: "id,job_id,name,active,sort_order",
  }, context.actorUserId);
  const destination = uniqueById(destinationRows, input.to_stage_id, "Destination interview stage");
  if (destination.job_id !== application.jobId || destination.active !== true) {
    throw new Error("Destination interview stage is not active on this application job.");
  }
  const beforeState = { status: application.status, interview_stage_id: current.interviewStageId };
  const afterState = { status: "in_process", interview_stage_id: input.to_stage_id };
  const approval = {
    target: { application_id: application.id, job_id: application.jobId },
    before: { application_stage_id: current.applicationStageId, interview_stage_id: current.interviewStageId },
    after: {
      interview_stage_id: input.to_stage_id,
      stage_name: typeof destination.name === "string" ? destination.name : null,
    },
    effects: ["Greenhouse may run configured stage-transition rules, including candidate email."],
  };
  const binding: StageMoveBinding = {
    application_id: application.id,
    from_application_stage_id: current.applicationStageId,
    from_interview_stage_id: current.interviewStageId,
    to_interview_stage_id: input.to_stage_id,
  };
  return prepared({
    kind: "application_stage_move",
    lockKey: `application:${application.id}`,
    scopeJobId: application.jobId,
    binding,
    current: beforeState,
    desired: afterState,
    approval,
    highImpact: true,
    changeRequired: current.interviewStageId !== input.to_stage_id,
    context,
    subject: { candidateId: application.candidateId, jobId: application.jobId },
    fenceTargets: [{ kind: "application", id: application.id, requiresUnredacted: false }],
  });
}

export const applicationStageMoveAction: ActionDefinition = {
  kind: "application_stage_move",
  previewTool: "preview_application_stage_move",
  applyTool: "apply_application_stage_move",
  previewTitle: "Preview application stage move",
  applyTitle: "Apply application stage move",
  previewDescription: "Preview a same-job stage move and disclose possible transition-rule effects.",
  applyDescription: "Apply the approved same-job stage move once. This is a high-impact action.",
  destructive: true,
  previewSchema,
  applySchema,
  getApproval(value) { return applySchema.parse(value).approval; },
  preparePreview(value, context) { return prepare(previewSchema.parse(value), context); },
  prepareApply(value, context) {
    const approval = approvalSchema.parse(value);
    return prepare({ application_id: approval.target.application_id, to_stage_id: approval.after.interview_stage_id }, context);
  },
  async mutation(_value, preparedAction) {
    const binding = preparedAction.binding as StageMoveBinding;
    return {
      method: "POST",
      path: `/applications/${binding.application_id}/move`,
      body: { from_stage_id: binding.from_application_stage_id, to_stage_id: binding.to_interview_stage_id },
    };
  },
  async observe(record, context) {
    const binding = record.binding as StageMoveBinding;
    const [application, current] = await Promise.all([
      getApplication(binding.application_id, context),
      getCurrentStage(binding.application_id, context),
    ]);
    if (application.applicationStageId === null || application.applicationStageId !== current.applicationStageId) {
      return "unavailable";
    }
    return classifyState(record, { status: application.status, interview_stage_id: current.interviewStageId }, context);
  },
};
