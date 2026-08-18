import { z } from "zod";
import type { AttributionBinding } from "../types.js";
import {
  authorizedApplication,
  classifyState,
  getApplication,
  prepared,
  uniqueById,
} from "./shared.js";
import type { ActionContext, ActionDefinition } from "./types.js";

const id = z.number().int().positive().safe();
const catalogPreviewSchema = z.object({
  application_id: id,
  source_id: id.optional(),
  referrer_id: id.optional(),
}).strict();
const previewSchema = catalogPreviewSchema.refine(
  (value) => Object.hasOwn(value, "source_id") || Object.hasOwn(value, "referrer_id"),
  "Provide source_id or referrer_id.",
);
const selectedAttributionSchema = z.object({
  source_id: id.nullable().optional(),
  referrer_id: id.nullable().optional(),
}).strict();
const approvalSchema = z.object({
  target: z.object({ application_id: id, job_id: id }).strict(),
  before: selectedAttributionSchema,
  after: selectedAttributionSchema,
  changed_fields: z.array(z.enum(["source_id", "referrer_id"])).min(1).max(2),
  effects: z.array(z.string()).min(1).max(5),
}).strict();
const applySchema = z.object({ intent: z.string().min(1).max(131_072), approval: approvalSchema }).strict();

function selectedState(
  value: { source_id: number | null; referrer_id: number | null },
  touchesSource: boolean,
  touchesReferrer: boolean,
) {
  return {
    ...(touchesSource ? { source_id: value.source_id } : {}),
    ...(touchesReferrer ? { referrer_id: value.referrer_id } : {}),
  };
}

async function prepare(input: z.infer<typeof previewSchema>, context: ActionContext) {
  const application = await authorizedApplication(input.application_id, context);
  const touchesSource = Object.hasOwn(input, "source_id");
  const touchesReferrer = Object.hasOwn(input, "referrer_id");
  const proposedSource = touchesSource
    ? uniqueById(await context.greenhouse.list("/sources", {
      ids: String(input.source_id), fields: "id,name,type",
    }, context.actorUserId), input.source_id!, "Source") : null;
  const proposedReferrer = touchesReferrer
    ? uniqueById(await context.greenhouse.list("/referrers", {
      ids: String(input.referrer_id), fields: "id,name,user_id",
    }, context.actorUserId), input.referrer_id!, "Referrer") : null;
  const currentSource = touchesSource && application.sourceId !== null
    ? application.sourceId === input.source_id ? proposedSource : uniqueById(await context.greenhouse.list("/sources", {
      ids: String(application.sourceId), fields: "id,name,type",
    }, context.actorUserId), application.sourceId, "Current source")
    : null;
  const currentReferrer = touchesReferrer && application.referrerId !== null
    ? application.referrerId === input.referrer_id ? proposedReferrer : uniqueById(await context.greenhouse.list("/referrers", {
      ids: String(application.referrerId), fields: "id,name,user_id",
    }, context.actorUserId), application.referrerId, "Current referrer")
    : null;
  const before = { source_id: application.sourceId, referrer_id: application.referrerId };
  const after = {
    source_id: touchesSource ? input.source_id! : application.sourceId,
    referrer_id: touchesReferrer ? input.referrer_id! : application.referrerId,
  };
  const changedFields = [touchesSource ? "source_id" : null, touchesReferrer ? "referrer_id" : null]
    .filter((value): value is "source_id" | "referrer_id" => value !== null);
  const approval = {
    target: { application_id: application.id, job_id: application.jobId },
    before: selectedState(before, touchesSource, touchesReferrer),
    after: selectedState(after, touchesSource, touchesReferrer),
    changed_fields: changedFields,
    effects: ["Changes recruiting-source/referrer attribution used in funnel analytics; no other application field is patched."],
  };
  const binding: AttributionBinding = {
    application_id: application.id,
    source_id: touchesSource ? after.source_id : null,
    referrer_id: touchesReferrer ? after.referrer_id : null,
    touches_source: touchesSource,
    touches_referrer: touchesReferrer,
  };
  return prepared({
    kind: "application_attribution_change",
    lockKey: `application:${application.id}`,
    scopeJobId: application.jobId,
    binding,
    current: selectedState(before, touchesSource, touchesReferrer),
    desired: selectedState(after, touchesSource, touchesReferrer),
    approval,
    preview: {
      ...approval,
      before: {
        ...approval.before,
        ...(touchesSource ? { source_name: typeof currentSource?.name === "string" ? currentSource.name : null } : {}),
        ...(touchesReferrer ? { referrer_name: typeof currentReferrer?.name === "string" ? currentReferrer.name : null } : {}),
      },
      after: {
        ...approval.after,
        ...(touchesSource ? { source_name: typeof proposedSource?.name === "string" ? proposedSource.name : null } : {}),
        ...(touchesReferrer ? { referrer_name: typeof proposedReferrer?.name === "string" ? proposedReferrer.name : null } : {}),
      },
    },
    changeRequired: before.source_id !== after.source_id || before.referrer_id !== after.referrer_id,
    context,
    subject: { candidateId: application.candidateId, jobId: application.jobId },
    fenceTargets: [{ kind: "application", id: application.id, requiresUnredacted: false }],
  });
}

export const applicationAttributionAction: ActionDefinition = {
  kind: "application_attribution_change",
  previewTool: "preview_application_attribution_change",
  applyTool: "apply_application_attribution_change",
  previewTitle: "Preview application attribution change",
  applyTitle: "Apply application attribution change",
  previewDescription: "Preview changing an application's source and/or referrer attribution.",
  applyDescription: "Apply only the approved attribution fields once.",
  destructive: true,
  previewSchema,
  applySchema,
  catalogPreviewSchema,
  getApproval(value) { return applySchema.parse(value).approval; },
  preparePreview(value, context) { return prepare(previewSchema.parse(value), context); },
  prepareApply(value, context) {
    const approved = approvalSchema.parse(value);
    if (approved.changed_fields.includes("source_id") && approved.after.source_id === null) {
      throw new Error("Approved source attribution is invalid.");
    }
    if (approved.changed_fields.includes("referrer_id") && approved.after.referrer_id === null) {
      throw new Error("Approved referrer attribution is invalid.");
    }
    return prepare({
      application_id: approved.target.application_id,
      ...(approved.changed_fields.includes("source_id") ? { source_id: approved.after.source_id! } : {}),
      ...(approved.changed_fields.includes("referrer_id") ? { referrer_id: approved.after.referrer_id! } : {}),
    }, context);
  },
  async mutation(_value, preparedAction) {
    const binding = preparedAction.binding as AttributionBinding;
    return {
      method: "PATCH",
      path: `/applications/${binding.application_id}`,
      body: {
        ...(binding.touches_source ? { source_id: binding.source_id } : {}),
        ...(binding.touches_referrer ? { referrer_id: binding.referrer_id } : {}),
      },
    };
  },
  async observe(record, context) {
    const binding = record.binding as AttributionBinding;
    const application = await getApplication(binding.application_id, context);
    return classifyState(record, selectedState({
      source_id: application.sourceId,
      referrer_id: application.referrerId,
    }, binding.touches_source, binding.touches_referrer), context);
  },
};
