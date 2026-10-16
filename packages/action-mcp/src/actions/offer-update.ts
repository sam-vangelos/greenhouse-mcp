import { z } from "zod";
import {
  customFieldInputSchema,
  customFieldNames,
  projectReadCustomFields,
  projectWriteCustomFields,
  validateCustomFields,
} from "../custom-fields.js";
import { fingerprintValue } from "../crypto.js";
import type { OfferUpdateBinding } from "../types.js";
import { authorizedApplication, prepared, sameValue } from "./shared.js";
import { normalizeDate, offerDate, offerIdentity, offerProjection, offers } from "./offer-shared.js";
import type { ActionContext, ActionDefinition } from "./types.js";

const id = z.number().int().positive().safe();
const catalogPreviewSchema = z.object({
  application_id: id,
  offer_id: id,
  starts_on: offerDate.optional(),
  custom_fields: z.array(customFieldInputSchema).min(1).max(200).optional(),
}).strict();
const previewSchema = catalogPreviewSchema.refine(
  (value) => value.starts_on !== undefined || value.custom_fields !== undefined,
  "Offer update requires starts_on or custom_fields.",
);
const valuesSchema = z.object({
  starts_on: offerDate.nullable().optional(),
  custom_fields: z.array(customFieldInputSchema).min(1).optional(),
}).strict();
const approvalSchema = z.object({
  target: z.object({ application_id: id, job_id: id, offer_id: id }).strict(),
  before: z.object({ offer_id: id, version: id, status: z.literal("Created"), values: valuesSchema }).strict(),
  after: z.object({ values: valuesSchema }).strict(),
  changed_fields: z.array(z.enum(["starts_on", "custom_fields"])).min(1).max(2),
  effects: z.array(z.string()).min(1).max(5),
}).strict();
const applySchema = z.object({ intent: z.string().min(1).max(131_072), approval: approvalSchema }).strict();

async function prepare(input: z.infer<typeof previewSchema>, context: ActionContext) {
  const application = await authorizedApplication(input.application_id, context);
  const currentRows = await offers(application.id, true, context);
  if (currentRows.length !== 1) throw new Error("Current offer was not found uniquely.");
  const row = currentRows[0]!;
  const identity = offerIdentity(row);
  if (identity.offer_id !== input.offer_id) throw new Error("Supplied offer is no longer the current offer.");
  if (identity.status !== "Created") throw new Error("Only a current Created offer can be updated.");
  const customFields = input.custom_fields ?? [];
  const validated = await validateCustomFields({
    greenhouse: context.greenhouse,
    actorUserId: context.actorUserId,
    fieldType: "offer",
    values: customFields,
  });
  const changedFields = [input.starts_on !== undefined ? "starts_on" : null, input.custom_fields !== undefined ? "custom_fields" : null]
    .filter((value): value is "starts_on" | "custom_fields" => value !== null);
  const fields = [...(input.starts_on !== undefined ? ["starts_on"] : []), ...customFieldNames(customFields)].sort();
  const beforeValues: Record<string, unknown> = {};
  const afterValues: Record<string, unknown> = {};
  if (input.starts_on !== undefined) {
    beforeValues.starts_on = normalizeDate(row.starts_on);
    afterValues.starts_on = input.starts_on;
  }
  if (input.custom_fields !== undefined) {
    beforeValues.custom_fields = projectReadCustomFields(row, customFields.map((field) => field.name_key));
    afterValues.custom_fields = customFields.slice().sort((a, b) => a.name_key.localeCompare(b.name_key));
  }
  const current = { status: "Created", ...beforeValues };
  const currentWithIdentity = { ...identity, ...beforeValues };
  const desired = {
    status: "Created",
    ...afterValues,
    ...(input.custom_fields !== undefined ? {
      custom_fields: projectWriteCustomFields(customFields, validated.definitions),
    } : {}),
  };
  const approval = {
    target: { application_id: application.id, job_id: application.jobId, offer_id: identity.offer_id },
    before: { offer_id: identity.offer_id, version: identity.version, status: "Created" as const, values: beforeValues },
    after: { values: afterValues },
    changed_fields: changedFields,
    effects: ["A start-date or version-triggering custom-field change may create a new current offer ID/version and deprecate this row."],
  };
  const binding: OfferUpdateBinding = {
    application_id: application.id,
    offer_id: identity.offer_id,
    version: identity.version,
    fields,
    has_currency: validated.hasCurrency,
  };
  return prepared({
    kind: "offer_update",
    lockKey: `offer-chain:${application.id}`,
    scopeJobId: application.jobId,
    binding,
    current: currentWithIdentity,
    desired,
    approval,
    preview: {
      ...approval,
      after: {
        values: {
          ...afterValues,
          ...(input.custom_fields !== undefined ? {
            custom_fields: projectWriteCustomFields(customFields, validated.definitions),
          } : {}),
        },
      },
    },
    highImpact: validated.hasCurrency,
    reconciliationGraceMs: 10 * 60_000,
    changeRequired: !sameValue(current, desired, context),
    context,
    subject: { candidateId: application.candidateId, jobId: application.jobId },
    fenceTargets: [
      { kind: "application", id: application.id, requiresUnredacted: false },
      { kind: "offer", id: identity.offer_id, requiresUnredacted: input.custom_fields !== undefined },
    ],
  });
}

export const offerUpdateAction: ActionDefinition = {
  kind: "offer_update",
  previewTool: "preview_offer_update",
  applyTool: "apply_offer_update",
  previewTitle: "Preview current offer update",
  applyTitle: "Update current offer",
  previewDescription: "Preview start-date and selected offer custom-field changes, including possible version creation.",
  applyDescription: "Apply the approved current-offer update once; currency changes require high-impact entitlement.",
  destructive: true,
  previewSchema,
  applySchema,
  catalogPreviewSchema,
  getApproval(value) { return applySchema.parse(value).approval; },
  preparePreview(value, context) { return prepare(previewSchema.parse(value), context); },
  prepareApply(value, context) {
    const approved = approvalSchema.parse(value);
    return prepare({
      application_id: approved.target.application_id,
      offer_id: approved.target.offer_id,
      ...(approved.changed_fields.includes("starts_on") ? { starts_on: approved.after.values.starts_on! } : {}),
      ...(approved.changed_fields.includes("custom_fields") ? { custom_fields: approved.after.values.custom_fields! } : {}),
    }, context);
  },
  async mutation(value, preparedAction) {
    const approved = approvalSchema.parse(value);
    const binding = preparedAction.binding as OfferUpdateBinding;
    return {
      method: "PATCH",
      path: `/offers/${binding.offer_id}`,
      body: {
        ...(approved.changed_fields.includes("starts_on") ? { starts_on: approved.after.values.starts_on } : {}),
        ...(approved.changed_fields.includes("custom_fields") ? { custom_fields: approved.after.values.custom_fields } : {}),
      },
    };
  },
  async observe(record, context) {
    const binding = record.binding as OfferUpdateBinding;
    const current = await offers(binding.application_id, true, context);
    if (current.length !== 1) return current.length === 0 ? "unavailable" : "conflict";
    const projection = offerProjection(current[0]!, binding.fields);
    if (fingerprintValue("offer-update-desired", projection, context.signingSecret) === record.desiredFingerprint) {
      return "desired_observed";
    }
    const identity = offerIdentity(current[0]!);
    const original = { ...identity, ...Object.fromEntries(Object.entries(projection).filter(([key]) => key !== "status")) };
    return fingerprintValue("offer-update-current", original, context.signingSecret) === record.currentFingerprint
      ? "not_observed"
      : "conflict";
  },
};
