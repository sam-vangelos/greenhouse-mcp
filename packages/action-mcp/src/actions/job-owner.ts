import { z } from "zod";
import type { JobOwnerBinding } from "../types.js";
import {
  assertJobAccess,
  assertUserMayOwnJob,
  classifyState,
  createdResourceId,
  positive,
  prepared,
  text,
  uniqueById,
} from "./shared.js";
import type { ActionContext, ActionDefinition } from "./types.js";

const id = z.number().int().positive().safe();
const verb = z.enum(["add", "remove"]);
const ownerType = z.enum(["sourcer", "recruiter", "coordinator"]);

const previewSchema = z.object({ verb, job_id: id, user_id: id, owner_type: ownerType }).strict();
const approvalSchema = z.object({
  target: z.object({ job_id: id, user_id: id, owner_type: ownerType, verb }).strict(),
  before: z.object({ present: z.boolean(), owner_row_id: id.nullable() }).strict(),
  after: z.object({ present: z.boolean() }).strict(),
  effects: z.array(z.string()).max(5),
}).strict();
const applySchema = z.object({ intent: z.string().min(1).max(131_072), approval: approvalSchema }).strict();

type Input = z.infer<typeof previewSchema>;

async function rows(jobId: number, context: ActionContext) {
  return context.greenhouse.list("/job_owners", {
    job_ids: String(jobId), per_page: "500", fields: "id,job_id,user_id,type,responsible",
  }, context.actorUserId);
}

function exactMatches(values: Awaited<ReturnType<typeof rows>>, target: {
  job_id: number;
  user_id: number;
  owner_type: Input["owner_type"];
}) {
  return values.filter((row) =>
    row.job_id === target.job_id && row.user_id === target.user_id && row.type === target.owner_type
  );
}

async function prepare(input: Input, context: ActionContext) {
  await assertJobAccess(input.job_id, context);
  const existing = await rows(input.job_id, context);
  const matches = exactMatches(existing, input);
  if (matches.length > 1) throw new Error("The exact job-owner tuple exists more than once.");
  const matchId = matches.length === 1 ? positive(matches[0]!.id, "job owner row id") : null;
  if (input.verb === "remove" && matchId === null) throw new Error("The exact job-owner tuple does not exist.");
  if (input.verb === "remove") {
    const responsible = matches[0]!.responsible;
    if (responsible === true) {
      throw new Error("Candidate-responsible job owners cannot be removed through this action.");
    }
    if (input.owner_type !== "sourcer" && responsible !== false) {
      throw new Error("Greenhouse omitted the job owner's candidate-responsibility state.");
    }
  }
  const selectedUser = input.verb === "add"
    ? await assertUserMayOwnJob(input.user_id, input.job_id, context)
    : uniqueById(await context.greenhouse.list("/users", {
      ids: String(input.user_id), fields: "id,name,deactivated,site_admin", show_service_accounts: "true",
    }, context.actorUserId), input.user_id, "Greenhouse user");
  const beforeState = input.verb === "remove"
    ? { present: true, owner_row_id: matchId }
    : { present: matchId !== null };
  const afterState = input.verb === "remove"
    ? { present: false, owner_row_id: null }
    : { present: true };
  const approval = {
    target: { job_id: input.job_id, user_id: input.user_id, owner_type: input.owner_type, verb: input.verb },
    before: { present: matchId !== null, owner_row_id: matchId },
    after: { present: input.verb === "add" },
    effects: [input.verb === "remove"
      ? "Removes only this exact hiring-team role; other roles for the user remain."
      : "Adds this hiring-team role without reassigning candidate responsibility."],
  };
  const binding: JobOwnerBinding = {
    job_id: input.job_id,
    user_id: input.user_id,
    owner_type: input.owner_type,
    verb: input.verb,
    owner_row_id: input.verb === "remove" ? matchId : null,
  };
  return prepared({
    kind: "job_owner_change",
    lockKey: `job:${input.job_id}`,
    scopeJobId: input.job_id,
    binding,
    current: beforeState,
    desired: afterState,
    approval,
    preview: {
      ...approval,
      target: { ...approval.target, user_name: text(selectedUser.name, "Greenhouse user name") },
    },
    changeRequired: input.verb === "remove" || matchId === null,
    context,
    subject: { jobId: input.job_id },
    fenceTargets: [{ kind: "job", id: input.job_id, requiresUnredacted: false }],
  });
}

export const jobOwnerAction: ActionDefinition = {
  kind: "job_owner_change",
  previewTool: "preview_job_owner_change",
  applyTool: "apply_job_owner_change",
  previewTitle: "Preview job owner change",
  applyTitle: "Apply job owner change",
  previewDescription: "Preview an exact hiring-team role add or removal without changing candidate responsibility.",
  applyDescription: "Apply the approved exact job-owner tuple change once.",
  destructive: true,
  previewSchema,
  applySchema,
  getApproval(value) { return applySchema.parse(value).approval; },
  preparePreview(value, context) { return prepare(previewSchema.parse(value), context); },
  prepareApply(value, context) {
    const approval = approvalSchema.parse(value);
    return prepare(approval.target, context);
  },
  async mutation(_value, preparedAction) {
    const binding = preparedAction.binding as JobOwnerBinding;
    return binding.verb === "add"
      ? { method: "POST", path: "/job_owners", body: { job_id: binding.job_id, user_id: binding.user_id, type: binding.owner_type } }
      : { method: "DELETE", path: `/job_owners/${binding.owner_row_id!}` };
  },
  async observe(record, context) {
    const binding = record.binding as JobOwnerBinding;
    const matches = exactMatches(await rows(binding.job_id, context), binding);
    if (matches.length > 1) return "conflict";
    const current = binding.verb === "remove"
      ? { present: matches.length === 1, owner_row_id: matches.length === 1 ? positive(matches[0]!.id, "job owner row id") : null }
      : { present: matches.length === 1 };
    return classifyState(record, current, context);
  },
  resultResourceId: createdResourceId,
};
