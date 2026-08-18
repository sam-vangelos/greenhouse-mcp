import { z } from "zod";
import { ActionDeniedError } from "../errors.js";
import type { AssignmentBinding } from "../types.js";
import {
  assertActiveUser,
  authorizedApplication,
  classifyState,
  getApplication,
  prepared,
  uniqueById,
} from "./shared.js";
import type { ActionContext, ActionDefinition } from "./types.js";

const positiveId = z.number().int().positive().safe();
const role = z.enum(["recruiter", "coordinator"]);

const previewSchema = z.object({
  application_id: positiveId.describe("Exact Greenhouse application ID."),
  assignment_role: role.describe("Assignment field to preview."),
  proposed_user_id: positiveId.describe("Exact active Greenhouse user ID to assign."),
}).strict();

const approvalSchema = z.object({
  application_id: positiveId,
  job_id: positiveId,
  assignment_role: role,
  current_user_id: positiveId.nullable(),
  proposed_user_id: positiveId,
}).strict();

const legacyApplySchema = approvalSchema.extend({
  intent: z.string().min(1).max(131_072),
}).strict();
const structuredApplySchema = z.object({
  intent: z.string().min(1).max(131_072),
  approval: approvalSchema,
}).strict();
const applySchema = z.union([legacyApplySchema, structuredApplySchema]);
const catalogApplySchema = z.object({
  intent: z.string().min(1).max(131_072),
  approval: approvalSchema.optional().describe("Preferred exact approval echo returned by preview."),
  application_id: positiveId.optional().describe("Legacy flat approval echo."),
  job_id: positiveId.optional().describe("Legacy flat approval echo."),
  assignment_role: role.optional().describe("Legacy flat approval echo."),
  current_user_id: positiveId.nullable().optional().describe("Legacy flat approval echo."),
  proposed_user_id: positiveId.optional().describe("Legacy flat approval echo."),
}).strict();

type Preview = z.infer<typeof previewSchema>;
type Approval = z.infer<typeof approvalSchema>;

async function prepare(input: Preview, context: ActionContext) {
  const application = await authorizedApplication(input.application_id, context);
  const proposed = await assertActiveUser(input.proposed_user_id, context);
  const currentId = input.assignment_role === "recruiter" ? application.recruiterId : application.coordinatorId;
  const current = currentId === null ? null : uniqueById(await context.greenhouse.list("/users", {
    ids: String(currentId), fields: "id,name,deactivated,site_admin", show_service_accounts: "true",
  }, context.actorUserId), currentId, "Current assignee");
  // The endpoint patches one assignment field. Fingerprint only that field so
  // unrelated recruiter/coordinator changes do not invalidate or misclassify it.
  const beforeState = { assignment_role: input.assignment_role, user_id: currentId };
  const afterState = { assignment_role: input.assignment_role, user_id: input.proposed_user_id };
  const approval: Approval = {
    application_id: application.id,
    job_id: application.jobId,
    assignment_role: input.assignment_role,
    current_user_id: currentId,
    proposed_user_id: input.proposed_user_id,
  };
  const binding: AssignmentBinding = {
    application_id: application.id,
    assignment_role: input.assignment_role,
    previous_user_id: currentId,
    proposed_user_id: input.proposed_user_id,
  };
  return prepared({
    kind: "application_assignment_change",
    lockKey: `application:${application.id}`,
    scopeJobId: application.jobId,
    binding,
    current: beforeState,
    desired: afterState,
    approval,
    preview: {
      target: { application_id: application.id, job_id: application.jobId, assignment_role: input.assignment_role },
      before: { user_id: currentId, name: typeof current?.name === "string" ? current.name : null },
      after: { user_id: input.proposed_user_id, name: typeof proposed.name === "string" ? proposed.name : null },
      effects: ["Changes only the selected assignment field; the sibling recruiter/coordinator field is not patched."],
    },
    changeRequired: currentId !== input.proposed_user_id,
    context,
    subject: { candidateId: application.candidateId, jobId: application.jobId },
    fenceTargets: [{ kind: "application", id: application.id, requiresUnredacted: false }],
  });
}

export const applicationAssignmentAction: ActionDefinition = {
  kind: "application_assignment_change",
  previewTool: "preview_application_assignment_change",
  applyTool: "apply_application_assignment_change",
  previewTitle: "Preview application assignment change",
  applyTitle: "Apply application assignment change",
  previewDescription: "Read current Greenhouse assignment state and show the exact selected-field change without writing.",
  applyDescription: "Apply the signed assignment preview exactly once after explicit human approval.",
  destructive: true,
  previewSchema,
  applySchema,
  catalogApplySchema,
  getApproval(value) {
    const input = applySchema.parse(value);
    if ("approval" in input) return input.approval;
    const { intent: _intent, ...approval } = input;
    return approval;
  },
  preparePreview(value, context) { return prepare(previewSchema.parse(value), context); },
  prepareApply(value, context) {
    const approval = approvalSchema.parse(value);
    return prepare({
      application_id: approval.application_id,
      assignment_role: approval.assignment_role,
      proposed_user_id: approval.proposed_user_id,
    }, context);
  },
  async mutation(_value, preparedAction) {
    const binding = preparedAction.binding as AssignmentBinding;
    if (preparedAction.actionKind !== "application_assignment_change") {
      throw new ActionDeniedError("ACTION_BINDING_MISMATCH", "Assignment action binding is invalid.");
    }
    return {
      method: "PATCH",
      path: `/applications/${binding.application_id}`,
      body: binding.assignment_role === "recruiter"
        ? { recruiter_id: binding.proposed_user_id }
        : { coordinator_id: binding.proposed_user_id },
    };
  },
  async observe(record, context) {
    const binding = record.binding as AssignmentBinding;
    const application = await getApplication(binding.application_id, context);
    return classifyState(record, {
      assignment_role: binding.assignment_role,
      user_id: binding.assignment_role === "recruiter" ? application.recruiterId : application.coordinatorId,
    }, context);
  },
};
