import { z } from "zod";
import { ActionDeniedError } from "../errors.js";
import type { AssignmentBinding } from "../types.js";
import {
  assertActiveUser,
  authorizedApplication,
  classifyJobAccess,
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
  const assigneeAccess = await classifyJobAccess(
    proposed,
    { id: application.jobId, confidential: application.jobConfidential },
    context,
  );
  const proposedName = typeof proposed.name === "string" && proposed.name.length > 0 ? proposed.name : "Selected user";
  // DISCLOSED, NOT DENIED — and the copy is load-bearing.
  //
  // No vendored Harvest page says Greenhouse refuses an assignment to a user without job access
  // (`0016-patch_v3-applications-id.md:486-491` documents no permission semantics), so a denial here
  // would be an invented rule. What the approver gets instead is the fact, plus the repair that
  // actually works: Job Admin access on the req. NOT "add them as a job owner" —
  // `0116-post_v3-job-owners.md:7` requires the user to ALREADY have permission to edit the job, so
  // that instruction sends the operator to a call that fails for exactly the user it is meant to fix.
  // "may not" rather than "cannot", because `0166:7` notes `/v3/future_job_permissions` grants
  // access too, and this classification does not read that endpoint.
  const accessEffect = assigneeAccess === "explicit_permission"
    ? `${proposedName} can open this job (explicit permission)`
    : assigneeAccess === "site_admin_non_confidential"
      ? `${proposedName} can open this job (site admin, non-confidential job)`
      : `${proposedName} has no permission row on req ${application.jobId} and may not be able to open this application in Greenhouse; grant them Job Admin access on this req in Greenhouse first.`;
  // Agency accounts are disclosed on the same terms. `0169-get_v3-users.md:785` marks a user as an
  // external agency recruiter rather than an employee; that is worth saying out loud before someone
  // hands them a req, and it is not a rule Greenhouse enforces on this endpoint.
  const agencyEffect = proposed.agency_id === null || proposed.agency_id === undefined
    ? null
    : `${proposedName} is an external agency account (agency ${String(proposed.agency_id)})`;
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
  // `assignee_access` deliberately does NOT ride in the binding. The binding is fingerprinted and
  // re-derived at apply, so carrying a disclosure in it turns the operator DOING WHAT THE PREVIEW
  // ASKED — granting the assignee access — into `STATE_CHANGED`, breaking the one path the warning
  // exists to produce. `mutation()` never reads it either. It lives in the preview's effects, which
  // is where the human reads it.
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
      effects: [
        "Changes only the selected assignment field; the sibling recruiter/coordinator field is not patched.",
        accessEffect,
        ...(agencyEffect ? [agencyEffect] : []),
      ],
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
