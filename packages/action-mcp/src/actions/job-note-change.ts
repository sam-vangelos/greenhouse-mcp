import { z } from "zod";
import { fingerprintValue } from "../crypto.js";
import type { GreenhouseRow, JobNoteBinding } from "../types.js";
import {
  assertJobAccess,
  classifyState,
  createdResourceId,
  positive,
  prepared,
  sameValue,
  uniqueById,
} from "./shared.js";
import type { ActionContext, ActionDefinition } from "./types.js";

const id = z.number().int().positive().safe();
const visibility = z.enum(["admin_only_visible", "privately_visible"]);
const body = z.string().trim().min(1).max(50_000);
const createSchema = z.object({ verb: z.literal("create"), job_id: id, body, visibility }).strict();
const updateSchema = z.object({
  verb: z.literal("update"), job_id: id, note_id: id, body: body.optional(), visibility: visibility.optional(),
}).strict().refine(
  (value) => value.body !== undefined || value.visibility !== undefined,
  "Update requires body or visibility.",
);
const deleteSchema = z.object({ verb: z.literal("delete"), job_id: id, note_id: id }).strict();
const previewSchema = z.union([createSchema, updateSchema, deleteSchema]);
const catalogPreviewSchema = z.object({
  verb: z.enum(["create", "update", "delete"]),
  job_id: id,
  note_id: id.optional(),
  body: body.optional(),
  visibility: visibility.optional(),
}).strict();
type JobNoteInput =
  | z.infer<typeof createSchema>
  | z.infer<typeof updateSchema>
  | z.infer<typeof deleteSchema>;
const approvalSchema = z.object({
  target: z.object({ job_id: id, note_id: id.nullable(), verb: z.enum(["create", "update", "delete"]) }).strict(),
  before: z.object({ exists: z.boolean(), body: z.string().nullable(), visibility: visibility.nullable(), author_user_id: id.nullable() }).strict(),
  after: z.object({ exists: z.boolean(), body: z.string().nullable(), visibility: visibility.nullable() }).strict(),
  effects: z.array(z.string()).min(1).max(5),
}).strict();
const applySchema = z.object({ intent: z.string().min(1).max(131_072), approval: approvalSchema }).strict();

function normalized(row: GreenhouseRow) {
  const currentVisibility = visibility.safeParse(row.visibility);
  if (!currentVisibility.success) throw new Error("Greenhouse returned an invalid job note visibility.");
  return {
    id: positive(row.id, "job note id"),
    job_id: positive(row.job_id, "job note job id"),
    user_id: positive(row.user_id, "job note user id"),
    body: typeof row.body === "string" ? row.body : null,
    visibility: currentVisibility.data,
  };
}

async function list(jobId: number, context: ActionContext) {
  return context.greenhouse.list("/job_notes", {
    job_ids: String(jobId), per_page: "500", fields: "id,job_id,user_id,body,visibility,created_at,updated_at",
  }, context.actorUserId);
}

async function prepare(input: JobNoteInput, context: ActionContext) {
  await assertJobAccess(input.job_id, context);
  if (input.verb === "create") {
    const desired = { job_id: input.job_id, user_id: context.actorUserId, body: input.body, visibility: input.visibility };
    const existing = await list(input.job_id, context);
    const baseline = existing.map((row) => positive(row.id, "job note id")).sort((a, b) => a - b);
    const matching = existing
      .filter((row) => {
        const value = normalized(row);
        return sameValue({ job_id: value.job_id, user_id: value.user_id, body: value.body, visibility: value.visibility }, desired, context);
      })
      .map((row) => positive(row.id, "job note id")).sort((a, b) => a - b);
    const approval = {
      target: { job_id: input.job_id, note_id: null, verb: "create" as const },
      before: { exists: false, body: null, visibility: null, author_user_id: null },
      after: { exists: true, body: input.body, visibility: input.visibility },
      effects: ["Creates a job note attributed to the signed-in Greenhouse user."],
    };
    const binding: JobNoteBinding = {
      job_id: input.job_id,
      verb: "create",
      note_id: null,
      visibility: input.visibility,
      baseline_count: baseline.length,
      baseline_fingerprint: fingerprintValue("job-note-change-baseline", baseline, context.signingSecret),
    };
    return prepared({
      kind: "job_note_change", lockKey: `job:${input.job_id}`, scopeJobId: input.job_id, binding,
      current: { matching_ids: matching }, desired, approval, changeRequired: true, context,
      subject: { jobId: input.job_id },
      fenceTargets: [{ kind: "job", id: input.job_id, requiresUnredacted: false }],
    });
  }

  const row = uniqueById(await context.greenhouse.list("/job_notes", {
    ids: String(input.note_id), fields: "id,job_id,user_id,body,visibility,created_at,updated_at",
  }, context.actorUserId), input.note_id, "Job note");
  if (row.job_id !== input.job_id) throw new Error("Job note does not belong to the approved job.");
  const current = normalized(row);
  if (input.verb === "delete") {
    const desired = { deleted: true, note_id: input.note_id };
    const approval = {
      target: { job_id: input.job_id, note_id: input.note_id, verb: "delete" as const },
      before: {
        exists: true,
        body: current.body,
        visibility: current.visibility as "admin_only_visible" | "privately_visible",
        author_user_id: current.user_id,
      },
      after: { exists: false, body: null, visibility: null },
      effects: ["Permanently deletes this exact job note."],
    };
    const binding: JobNoteBinding = {
      job_id: input.job_id,
      verb: "delete",
      note_id: input.note_id,
      visibility: null,
      baseline_count: 0,
      baseline_fingerprint: fingerprintValue("job-note-change-baseline", [], context.signingSecret),
    };
    return prepared({
      kind: "job_note_change", lockKey: `job:${input.job_id}`, scopeJobId: input.job_id, binding,
      current, desired, approval, changeRequired: true, context,
      subject: { jobId: input.job_id },
      fenceTargets: [
        { kind: "job", id: input.job_id, requiresUnredacted: false },
        { kind: "job_note", id: input.note_id, requiresUnredacted: true },
      ],
    });
  }

  const desired = {
    ...current,
    body: input.body ?? current.body,
    visibility: input.visibility ?? current.visibility,
  };
  const approval = {
    target: { job_id: input.job_id, note_id: input.note_id, verb: "update" as const },
    before: { exists: true, body: current.body, visibility: current.visibility as "admin_only_visible" | "privately_visible", author_user_id: current.user_id },
    after: { exists: true, body: desired.body as string, visibility: desired.visibility as "admin_only_visible" | "privately_visible" },
    effects: ["Updates only the approved job-note fields."],
  };
  const binding: JobNoteBinding = {
    job_id: input.job_id,
    verb: "update",
    note_id: input.note_id,
    visibility: approval.after.visibility,
    baseline_count: 0,
    baseline_fingerprint: fingerprintValue("job-note-change-baseline", [], context.signingSecret),
  };
  return prepared({
    kind: "job_note_change", lockKey: `job:${input.job_id}`, scopeJobId: input.job_id, binding,
    current, desired, approval,
    changeRequired: !sameValue(current, desired, context),
    context,
    subject: { jobId: input.job_id },
    fenceTargets: [
      { kind: "job", id: input.job_id, requiresUnredacted: false },
      // The action reads the existing body and its preview discloses it: a redacted note is one
      // whose body the read plane withheld, and previewing a change to it would leak exactly that.
      { kind: "job_note", id: input.note_id, requiresUnredacted: true },
    ],
  });
}

export const jobNoteChangeAction: ActionDefinition = {
  kind: "job_note_change",
  previewTool: "preview_job_note_change",
  applyTool: "apply_job_note_change",
  previewTitle: "Preview job note change",
  applyTitle: "Apply job note change",
  previewDescription: "Preview creating, updating, or permanently deleting one job note.",
  applyDescription: "Apply the approved job-note change exactly once.",
  destructive: true,
  previewSchema,
  applySchema,
  catalogPreviewSchema,
  getApproval(value) { return applySchema.parse(value).approval; },
  preparePreview(value, context) { return prepare(previewSchema.parse(value), context); },
  prepareApply(value, context) {
    const approved = approvalSchema.parse(value);
    if (approved.target.verb === "create") {
      return prepare({ verb: "create", job_id: approved.target.job_id, body: approved.after.body!, visibility: approved.after.visibility! }, context);
    }
    if (approved.target.verb === "delete") {
      return prepare({ verb: "delete", job_id: approved.target.job_id, note_id: approved.target.note_id! }, context);
    }
    const changed = {
      ...(approved.before.body !== approved.after.body ? { body: approved.after.body! } : {}),
      ...(approved.before.visibility !== approved.after.visibility ? { visibility: approved.after.visibility! } : {}),
    };
    return prepare({
      verb: "update",
      job_id: approved.target.job_id,
      note_id: approved.target.note_id!,
      ...changed,
    }, context);
  },
  async mutation(value, preparedAction, context) {
    const approved = approvalSchema.parse(value);
    const binding = preparedAction.binding as JobNoteBinding;
    if (binding.verb === "create") {
      return {
        method: "POST", path: "/job_notes",
        body: { job_id: binding.job_id, user_id: context.actorUserId, body: approved.after.body!, visibility: approved.after.visibility! },
      };
    }
    if (binding.verb === "delete") return { method: "DELETE", path: `/job_notes/${binding.note_id!}` };
    const patch: Record<string, unknown> = {};
    if (approved.before.body !== approved.after.body) patch.body = approved.after.body;
    if (approved.before.visibility !== approved.after.visibility) patch.visibility = approved.after.visibility;
    return { method: "PATCH", path: `/job_notes/${binding.note_id!}`, body: patch };
  },
  async observe(record, context) {
    const binding = record.binding as JobNoteBinding;
    if (binding.verb === "create") {
      const values = await list(binding.job_id, context);
      const desired = values.filter((row) => {
        const value = normalized(row);
        const withoutId = { job_id: value.job_id, user_id: value.user_id, body: value.body, visibility: value.visibility };
        return fingerprintValue("job-note-change-desired", withoutId, context.signingSecret) === record.desiredFingerprint;
      });
      const currentIds = values.map((row) => positive(row.id, "job note id")).sort((a, b) => a - b);
      const matchesBaseline = (ids: number[]) => ids.length === binding.baseline_count
        && fingerprintValue("job-note-change-baseline", ids, context.signingSecret) === binding.baseline_fingerprint;
      if (record.upstreamResourceId !== null) {
        const returned = values.find((row) => row.id === record.upstreamResourceId);
        if (returned) return desired.some((row) => row.id === record.upstreamResourceId) ? "desired_observed" : "conflict";
        return matchesBaseline(currentIds) ? "not_observed" : "conflict";
      }
      const plausible = desired.filter((row) => {
        const rowId = positive(row.id, "job note id");
        return matchesBaseline(currentIds.filter((candidateId) => candidateId !== rowId));
      });
      if (plausible.length === 1) return "desired_observed";
      return matchesBaseline(currentIds) ? "not_observed" : "conflict";
    }
    const rows = await context.greenhouse.list("/job_notes", {
      ids: String(binding.note_id), fields: "id,job_id,user_id,body,visibility,created_at,updated_at",
    }, context.actorUserId);
    if (binding.verb === "delete") {
      if (rows.length === 0) return "desired_observed";
      if (rows.length !== 1) return "conflict";
      return classifyState(record, normalized(rows[0]!), context) === "not_observed" ? "not_observed" : "conflict";
    }
    if (rows.length !== 1) return "conflict";
    return classifyState(record, normalized(rows[0]!), context);
  },
  resultResourceId: createdResourceId,
};
