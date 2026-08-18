import { z } from "zod";
import { customFieldInputSchema, customFieldNames, projectWriteCustomFields, validateCustomFields } from "../custom-fields.js";
import { fingerprintValue } from "../crypto.js";
import type { OfferCreateBinding } from "../types.js";
import { authorizedApplication, createdResourceId, prepared } from "./shared.js";
import { normalizeDate, offerDate, offerIdentity, offerProjection, offers } from "./offer-shared.js";
import type { ActionContext, ActionDefinition } from "./types.js";

const id = z.number().int().positive().safe();
const previewSchema = z.object({
  application_id: id,
  starts_on: offerDate.optional(),
  custom_fields: z.array(customFieldInputSchema).max(200).optional(),
}).strict();
const approvalSchema = z.object({
  target: z.object({ application_id: id, job_id: id }).strict(),
  before: z.object({ offer_ids: z.array(id) }).strict(),
  after: z.object({ starts_on: offerDate.nullable(), custom_fields: z.array(customFieldInputSchema) }).strict(),
  included_fields: z.array(z.enum(["starts_on", "custom_fields"])).max(2),
  effects: z.array(z.string()).min(1).max(5),
}).strict();
const applySchema = z.object({ intent: z.string().min(1).max(131_072), approval: approvalSchema }).strict();

async function prepare(input: z.infer<typeof previewSchema>, context: ActionContext) {
  const application = await authorizedApplication(input.application_id, context);
  const existing = await offers(application.id, false, context);
  if (existing.length > 0) throw new Error("Offer create is refused because this application already has an offer chain.");
  const customFields = input.custom_fields ?? [];
  const validated = await validateCustomFields({
    greenhouse: context.greenhouse,
    actorUserId: context.actorUserId,
    fieldType: "offer",
    values: customFields,
  });
  const includedFields = [input.starts_on !== undefined ? "starts_on" : null, input.custom_fields !== undefined ? "custom_fields" : null]
    .filter((value): value is "starts_on" | "custom_fields" => value !== null);
  const fields = ["starts_on", ...customFieldNames(customFields)].sort();
  const desired = {
    status: "Created",
    starts_on: input.starts_on ?? null,
    ...(customFields.length > 0 ? {
      custom_fields: projectWriteCustomFields(customFields, validated.definitions),
    } : {}),
  };
  const approval = {
    target: { application_id: application.id, job_id: application.jobId },
    before: { offer_ids: [] as number[] },
    after: { starts_on: input.starts_on ?? null, custom_fields: customFields },
    included_fields: includedFields,
    effects: ["Creates version 1 of a new offer chain; configured approval flows attach automatically."],
  };
  const binding: OfferCreateBinding = {
    application_id: application.id,
    fields,
    baseline_ids: [],
    has_currency: validated.hasCurrency,
  };
  return prepared({
    kind: "offer_create",
    lockKey: `offer-chain:${application.id}`,
    scopeJobId: application.jobId,
    binding,
    current: { offer_ids: [] },
    desired,
    approval,
    preview: {
      ...approval,
      after: {
        ...approval.after,
        custom_fields: projectWriteCustomFields(customFields, validated.definitions),
      },
    },
    highImpact: validated.hasCurrency,
    reconciliationGraceMs: 10 * 60_000,
    changeRequired: true,
    context,
    subject: { candidateId: application.candidateId, jobId: application.jobId },
    fenceTargets: [{ kind: "application", id: application.id, requiresUnredacted: false }],
  });
}

export const offerCreateAction: ActionDefinition = {
  kind: "offer_create",
  previewTool: "preview_offer_create",
  applyTool: "apply_offer_create",
  previewTitle: "Preview offer creation",
  applyTitle: "Create offer",
  previewDescription: "Preview a new offer chain and disclose automatic approval-flow attachment.",
  applyDescription: "Create the approved offer once; refuses applications with an existing offer chain.",
  destructive: true,
  previewSchema,
  applySchema,
  getApproval(value) { return applySchema.parse(value).approval; },
  preparePreview(value, context) { return prepare(previewSchema.parse(value), context); },
  prepareApply(value, context) {
    const approved = approvalSchema.parse(value);
    return prepare({
      application_id: approved.target.application_id,
      ...(approved.included_fields.includes("starts_on") && approved.after.starts_on !== null ? { starts_on: approved.after.starts_on } : {}),
      ...(approved.included_fields.includes("custom_fields") ? { custom_fields: approved.after.custom_fields } : {}),
    }, context);
  },
  async mutation(value, preparedAction) {
    const approved = approvalSchema.parse(value);
    const binding = preparedAction.binding as OfferCreateBinding;
    return {
      method: "POST",
      path: "/offers",
      body: {
        application_id: binding.application_id,
        ...(approved.included_fields.includes("starts_on") ? { starts_on: approved.after.starts_on } : {}),
        ...(approved.included_fields.includes("custom_fields") ? { custom_fields: approved.after.custom_fields } : {}),
      },
    };
  },
  async observe(record, context) {
    const binding = record.binding as OfferCreateBinding;
    const chain = await offers(binding.application_id, false, context);
    if (chain.length === 0) return "not_observed";
    if (chain.length !== 1) return "conflict";
    const identity = offerIdentity(chain[0]!);
    if (identity.version !== 1 || (record.upstreamResourceId !== null && identity.offer_id !== record.upstreamResourceId)) {
      return "conflict";
    }
    const projection = offerProjection(chain[0]!, binding.fields);
    return projection.status === "Created"
      && record.desiredFingerprint === fingerprintValue("offer-create-desired", projection, context.signingSecret)
      ? "desired_observed" : "conflict";
  },
  resultResourceId: createdResourceId,
};
