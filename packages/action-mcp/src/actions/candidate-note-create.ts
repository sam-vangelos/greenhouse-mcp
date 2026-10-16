import { z } from "zod";
import { fingerprintValue } from "../crypto.js";
import type { CandidateNoteBinding, GreenhouseRow } from "../types.js";
import {
  authorizedApplication,
  createdResourceId,
  positive,
  prepared,
  sameValue,
} from "./shared.js";
import type { ActionContext, ActionDefinition } from "./types.js";

const id = z.number().int().positive().safe();
const noteType = z.enum(["NOTE", "ACTIVITY"]);
const visibility = z.enum(["admin_only", "private", "public"]);
const previewSchema = z.object({
  application_id: id,
  body: z.string().trim().min(1).max(50_000),
  visibility,
  note_type: noteType,
}).strict();
const approvalSchema = z.object({
  target: z.object({ application_id: id, candidate_id: id, job_id: id, author_user_id: id }).strict(),
  before: z.object({ identical_note_ids: z.array(id).max(200), additional_identical_note_count: z.number().int().nonnegative() }).strict(),
  after: z.object({ body: z.string().trim().min(1).max(50_000), visibility, note_type: noteType }).strict(),
  effects: z.array(z.string()).min(1).max(5),
}).strict();
const applySchema = z.object({ intent: z.string().min(1).max(131_072), approval: approvalSchema }).strict();

function responseVisibility(value: unknown): "admin_only" | "private" | "public" | null {
  if (value === "admin_only_visible") return "admin_only";
  if (value === "privately_visible") return "private";
  if (value === "publicly_visible") return "public";
  return null;
}

function normalized(row: GreenhouseRow) {
  return {
    candidate_id: row.candidate_id,
    application_id: row.application_id,
    user_id: row.user_id,
    note_type: row.type,
    visibility: responseVisibility(row.visibility),
    body: row.body,
  };
}

async function notes(applicationId: number, candidateId: number, actorUserId: number, context: ActionContext) {
  return context.greenhouse.list("/notes", {
    application_ids: String(applicationId),
    candidate_ids: String(candidateId),
    user_ids: String(actorUserId),
    per_page: "500",
    fields: "id,candidate_id,application_id,user_id,type,visibility,body,created_at",
  }, context.actorUserId);
}

async function prepare(input: z.infer<typeof previewSchema>, context: ActionContext) {
  const application = await authorizedApplication(input.application_id, context);
  const desired = {
    candidate_id: application.candidateId,
    application_id: application.id,
    user_id: context.actorUserId,
    note_type: input.note_type,
    visibility: input.visibility,
    body: input.body,
  };
  const existing = await notes(application.id, application.candidateId, context.actorUserId, context);
  const identical = existing
    .filter((row) => sameValue(normalized(row), desired, context))
    .map((row) => positive(row.id, "note id"))
    .sort((a, b) => a - b);
  const baseline = existing.map((row) => positive(row.id, "note id")).sort((a, b) => a - b);
  const approval = {
    target: {
      application_id: application.id,
      candidate_id: application.candidateId,
      job_id: application.jobId,
      author_user_id: context.actorUserId,
    },
    before: {
      identical_note_ids: identical.slice(0, 200),
      additional_identical_note_count: Math.max(0, identical.length - 200),
    },
    after: { body: input.body, visibility: input.visibility, note_type: input.note_type },
    effects: ["Creates an immutable Greenhouse candidate/application note; a normal identical note is still a new note."],
  };
  const binding: CandidateNoteBinding = {
    application_id: application.id,
    candidate_id: application.candidateId,
    note_type: input.note_type,
    visibility: input.visibility,
    baseline_count: baseline.length,
    baseline_fingerprint: fingerprintValue("candidate-note-create-baseline", baseline, context.signingSecret),
  };
  return prepared({
    kind: "candidate_note_create",
    lockKey: `application:${application.id}`,
    scopeJobId: application.jobId,
    binding,
    current: { matching_ids: identical },
    desired,
    approval,
    changeRequired: true,
    context,
    subject: { candidateId: application.candidateId, jobId: application.jobId },
    fenceTargets: [{ kind: "application", id: application.id, requiresUnredacted: false }],
  });
}

export const candidateNoteCreateAction: ActionDefinition = {
  kind: "candidate_note_create",
  previewTool: "preview_candidate_note_create",
  applyTool: "apply_candidate_note_create",
  previewTitle: "Preview candidate note",
  applyTitle: "Create candidate note",
  previewDescription: "Preview an application-anchored candidate note, including its exact body and visibility.",
  applyDescription: "Create the approved candidate note exactly once. Candidate notes cannot be edited or deleted through Harvest v3.",
  destructive: true,
  previewSchema,
  applySchema,
  getApproval(value) { return applySchema.parse(value).approval; },
  preparePreview(value, context) { return prepare(previewSchema.parse(value), context); },
  prepareApply(value, context) {
    const approval = approvalSchema.parse(value);
    return prepare({
      application_id: approval.target.application_id,
      body: approval.after.body,
      visibility: approval.after.visibility,
      note_type: approval.after.note_type,
    }, context);
  },
  async mutation(value, preparedAction, context) {
    const approval = approvalSchema.parse(value);
    const binding = preparedAction.binding as CandidateNoteBinding;
    return {
      method: "POST",
      path: "/notes",
      body: {
        candidate_id: binding.candidate_id,
        application_id: binding.application_id,
        body: approval.after.body,
        visibility: binding.visibility,
        note_type: binding.note_type,
        user_id: context.actorUserId,
      },
    };
  },
  async observe(record, context) {
    const binding = record.binding as CandidateNoteBinding;
    const values = await notes(binding.application_id, binding.candidate_id, record.actorUserId, context);
    const desired = values.filter((row) =>
      fingerprintValue("candidate-note-create-desired", normalized(row), context.signingSecret) === record.desiredFingerprint
    );
    const currentIds = values.map((row) => positive(row.id, "note id")).sort((a, b) => a - b);
    const matchesBaseline = (ids: number[]) => ids.length === binding.baseline_count
      && fingerprintValue("candidate-note-create-baseline", ids, context.signingSecret) === binding.baseline_fingerprint;
    if (record.upstreamResourceId !== null) {
      const returned = values.find((row) => row.id === record.upstreamResourceId);
      if (returned) return desired.some((row) => row.id === record.upstreamResourceId) ? "desired_observed" : "conflict";
      return matchesBaseline(currentIds) ? "not_observed" : "conflict";
    }
    const plausible = desired.filter((row) => {
      const rowId = positive(row.id, "note id");
      return matchesBaseline(currentIds.filter((candidateId) => candidateId !== rowId));
    });
    if (plausible.length === 1) return "desired_observed";
    return matchesBaseline(currentIds) ? "not_observed" : "conflict";
  },
  resultResourceId: createdResourceId,
};
