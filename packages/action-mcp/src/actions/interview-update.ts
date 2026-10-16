import { z } from "zod";
import { ActionDeniedError } from "../errors.js";
import { INTERVIEW_UPDATE_FIELDS } from "../types.js";
import type { GreenhouseRow, InterviewUpdateBinding, InterviewUpdateField } from "../types.js";
import {
  assertActiveInterviewers,
  externalEventId,
  instant,
  interviewLocation,
  interviewTime,
  interviewerNames,
  interviewsWhere,
  namedPanel,
  panelFor,
  panelInput,
  panelUserIds,
  responseStatus,
  videoConferencingUrl,
} from "./interview-create.js";
import type { PanelMember } from "./interview-create.js";
import {
  authorizedApplication,
  classifyState,
  nullableText,
  positive,
  prepared,
  sameValue,
  uniqueById,
} from "./shared.js";
import type { ActionContext, ActionDefinition } from "./types.js";

/**
 * Updates a recorded interview: time, location, video link, calendar event id, or panel.
 *
 * `0100-patch_v3-interviews-id.md:7` is the whole contract and three of its clauses are load-bearing:
 *   - "Patch a SCHEDULED interview's …" — so an interview in any other lifecycle state is refused
 *     (statuses at `0099-get_v3-interviews.md:703-720`; `scheduled` is "on the calendar").
 *   - the `interviewers` array "is replaced wholesale" — so the approval always shows the full
 *     current panel and the full desired panel, and a panel holding an external attendee (a row with
 *     no Greenhouse user, `0097-get_v3-interviewers.md:616-622`) is refused rather than silently
 *     dropped, since this connector identifies interviewers by `user_id` only.
 *   - it "updates the Greenhouse interview record only" — the calendar event is not touched, which
 *     the approval's effects say out loud.
 *
 * RSVPs are the calendar's (`0097-get_v3-interviewers.md:7`: `response_status` reflects the calendar
 * RSVP). The signed approval, the STATE_CHANGED fingerprint and read-back therefore compare WHO is on
 * the panel, never the live RSVPs, which move between preview and apply and after a write lands. The
 * preview still shows every member's current RSVP. A panel edit that changes only RSVPs is no change.
 *
 * Fingerprints cover the interview's status plus the fields being changed, so a later edit to some
 * other field is not a read-back conflict; drift in the other fields between preview and apply still
 * stops the apply, because the signed approval's `before` carries them.
 */

const id = z.number().int().positive().safe();

const catalogPreviewSchema = z.object({
  interview_id: id,
  starts_at: interviewTime.optional(),
  ends_at: interviewTime.optional(),
  // `0100:617-620`: location is a plain string on PATCH, so it can be changed but not cleared.
  location: interviewLocation.optional(),
  // `0100:621-626`: the video link is nullable on PATCH; null clears it.
  video_conferencing_url: videoConferencingUrl.nullable().optional(),
  external_event_id: externalEventId.optional(),
  interviewers: panelInput.optional(),
}).strict();
const previewSchema = catalogPreviewSchema.refine(
  (value) => INTERVIEW_UPDATE_FIELDS.some((field) => value[field] !== undefined),
  "Name at least one field to change.",
);

const recordedText = z.string().max(1_000).nullable();
/** Who is on the panel now. RSVPs ride on the preview only (see the file comment). */
const signedCurrentPanel = z.array(z.object({ user_id: id.nullable() }).strict()).max(100);
/** The panel after: the current members when unchanged, or the members and RSVPs a PATCH will send. */
const signedAfterPanel = z.array(z.object({ user_id: id.nullable(), response_status: responseStatus.optional() }).strict()).max(100);
const scalarShape = {
  starts_at: recordedText,
  ends_at: recordedText,
  location: recordedText,
  video_conferencing_url: recordedText,
  external_event_id: recordedText,
};
const approvalSchema = z.object({
  target: z.object({ interview_id: id, application_id: id, job_id: id }).strict(),
  changed_fields: z.array(z.enum(INTERVIEW_UPDATE_FIELDS)).min(1).max(INTERVIEW_UPDATE_FIELDS.length),
  before: z.object({ status: z.literal("scheduled"), ...scalarShape, interviewers: signedCurrentPanel }).strict(),
  after: z.object({ ...scalarShape, interviewers: signedAfterPanel }).strict(),
  effects: z.array(z.string()).min(1).max(5),
}).strict();
const applySchema = z.object({ intent: z.string().min(1).max(131_072), approval: approvalSchema }).strict();

type UpdateInput = z.infer<typeof previewSchema>;

interface InterviewState {
  starts_at: string | null;
  ends_at: string | null;
  location: string | null;
  video_conferencing_url: string | null;
  external_event_id: string | null;
  interviewers: PanelMember[];
}

function stateOf(row: GreenhouseRow, panel: PanelMember[]): InterviewState {
  return {
    starts_at: nullableText(row.starts_at ?? null, "interview start"),
    ends_at: nullableText(row.ends_at ?? null, "interview end"),
    location: nullableText(row.location ?? null, "interview location"),
    video_conferencing_url: nullableText(row.video_conferencing_url ?? null, "interview video link"),
    external_event_id: nullableText(row.external_event_id ?? null, "interview external event id"),
    interviewers: panel,
  };
}

/**
 * Status plus the fields being changed, compared on instants and on the panel's members as a set, so
 * an offset, an ordering or an RSVP is never a change.
 */
function comparable(status: unknown, state: InterviewState, fields: readonly InterviewUpdateField[]) {
  return {
    status,
    ...Object.fromEntries(fields.map((field) => [
      field,
      field === "starts_at" || field === "ends_at" ? instant(state[field])
        : field === "interviewers" ? panelUserIds(state.interviewers)
          : state[field],
    ])),
  };
}

function differs(field: InterviewUpdateField, before: InterviewState, requested: unknown, context: ActionContext): boolean {
  if (field === "starts_at" || field === "ends_at") return instant(before[field]) !== instant(requested as string);
  if (field === "interviewers") return !sameValue(panelUserIds(before.interviewers), panelUserIds(requested as PanelMember[]), context);
  return before[field] !== requested;
}

/**
 * Create keys a booking by its calendar event id, one interview per event on an application. An
 * update that re-pointed this interview at an event another interview already carries would break
 * that key for every later create and read-back on it. Run at preview and again at apply.
 */
async function assertEventIdFree(interviewId: number, applicationId: number, externalEventId: string, context: ActionContext): Promise<void> {
  const carriers = (await interviewsWhere({ application_ids: String(applicationId), external_event_id: externalEventId }, context))
    .filter((row) => row.application_id === applicationId && row.external_event_id === externalEventId && row.id !== interviewId);
  if (carriers.length > 0) {
    throw new ActionDeniedError(
      "EXTERNAL_EVENT_ID_IN_USE",
      "Another interview on this application already carries this calendar event id; nothing was changed.",
    );
  }
}

async function loadInterview(interviewId: number, context: ActionContext): Promise<GreenhouseRow> {
  // `0099-get_v3-interviews.md:419`: resolved by `ids` to its application before anything is shown.
  return uniqueById(await interviewsWhere({ ids: String(interviewId) }, context), interviewId, "Interview");
}

async function prepare(input: UpdateInput, context: ActionContext) {
  const row = await loadInterview(input.interview_id, context);
  const application = await authorizedApplication(positive(row.application_id, "interview application id"), context);
  if (row.status !== "scheduled") {
    throw new ActionDeniedError("INTERVIEW_NOT_SCHEDULED", "Only a scheduled interview can be updated; this one is not on the calendar as scheduled.");
  }
  const before = stateOf(row, await panelFor(input.interview_id, context));
  const changed = INTERVIEW_UPDATE_FIELDS.filter((field) =>
    input[field] !== undefined && differs(field, before, input[field], context));

  if (changed.includes("interviewers") && before.interviewers.some(({ user_id }) => user_id === null)) {
    throw new ActionDeniedError(
      "PANEL_HAS_EXTERNAL_ATTENDEES",
      "This interview's panel includes an attendee with no Greenhouse user. Replacing the panel would remove them, so change it on the calendar instead.",
    );
  }
  const after: InterviewState = {
    starts_at: changed.includes("starts_at") ? input.starts_at! : before.starts_at,
    ends_at: changed.includes("ends_at") ? input.ends_at! : before.ends_at,
    location: changed.includes("location") ? input.location! : before.location,
    video_conferencing_url: changed.includes("video_conferencing_url") ? input.video_conferencing_url ?? null : before.video_conferencing_url,
    external_event_id: changed.includes("external_event_id") ? input.external_event_id! : before.external_event_id,
    interviewers: changed.includes("interviewers")
      ? input.interviewers!.map(({ user_id, response_status }) => ({ user_id, response_status }))
      : before.interviewers,
  };
  if (changed.includes("starts_at") || changed.includes("ends_at")) {
    if (after.starts_at === null || after.ends_at === null || Date.parse(after.ends_at) <= Date.parse(after.starts_at)) {
      throw new ActionDeniedError("INTERVIEW_TIME_INVALID", "The interview would end before it starts.");
    }
  }
  if (changed.includes("interviewers")) {
    await assertActiveInterviewers(after.interviewers.map(({ user_id }) => user_id as number), context);
  }
  if (changed.includes("external_event_id")) {
    await assertEventIdFree(input.interview_id, application.id, after.external_event_id!, context);
  }

  const { interviewers: _livePanel, ...beforeScalars } = before;
  const { interviewers: _afterPanel, ...afterScalars } = after;
  const currentMembers = before.interviewers.map(({ user_id }) => ({ user_id }));
  const approval = {
    target: { interview_id: input.interview_id, application_id: application.id, job_id: application.jobId },
    changed_fields: changed,
    before: { status: "scheduled" as const, ...beforeScalars, interviewers: currentMembers },
    after: {
      ...afterScalars,
      interviewers: changed.includes("interviewers")
        ? after.interviewers.map(({ user_id, response_status }) => ({ user_id, response_status: response_status! }))
        : currentMembers,
    },
    effects: [
      "Updates the Greenhouse interview record only. The calendar event is not changed and nobody is notified; make the matching change on the calendar event too.",
      ...(changed.includes("interviewers")
        ? ["The interviewer panel is replaced as a whole: anyone not in the after panel is removed from this interview."]
        : []),
    ],
  };
  const binding: InterviewUpdateBinding = {
    interview_id: input.interview_id,
    application_id: application.id,
    fields: changed,
  };
  const names = await interviewerNames(
    [...before.interviewers, ...after.interviewers].flatMap(({ user_id }) => (user_id === null ? [] : [user_id])),
    context,
  );
  return prepared({
    kind: "interview_update",
    lockKey: `application:${application.id}`,
    scopeJobId: application.jobId,
    binding,
    current: comparable("scheduled", before, changed),
    desired: comparable("scheduled", after, changed),
    approval,
    preview: {
      ...approval,
      // Display only, so never a reason to fail: in service_user mode this is likely the
      // integration's service user rather than the human (CLO-400).
      target: { ...approval.target, organizer_id: typeof row.organizer_id === "number" ? row.organizer_id : null },
      before: { ...approval.before, interviewers: namedPanel(before.interviewers, names) },
      after: { ...approval.after, interviewers: namedPanel(after.interviewers, names) },
    },
    highImpact: false,
    changeRequired: changed.length > 0,
    context,
    subject: { candidateId: application.candidateId, jobId: application.jobId },
    fenceTargets: [{ kind: "application", id: application.id, requiresUnredacted: false }],
  });
}

export const interviewUpdateAction: ActionDefinition = {
  kind: "interview_update",
  previewTool: "preview_interview_update",
  applyTool: "apply_interview_update",
  previewTitle: "Preview interview update",
  applyTitle: "Update interview",
  previewDescription: "Preview a change to a scheduled Greenhouse interview's time, location, video link, calendar event id, or interviewer panel, showing the full panel before and after.",
  applyDescription: "Apply the approved interview update exactly once. A panel change replaces the whole panel. The calendar event itself is not changed.",
  destructive: true,
  previewSchema,
  applySchema,
  catalogPreviewSchema,
  getApproval(value) { return applySchema.parse(value).approval; },
  preparePreview(value, context) { return prepare(previewSchema.parse(value), context); },
  prepareApply(value, context) {
    const approval = approvalSchema.parse(value);
    return prepare(previewSchema.parse({
      interview_id: approval.target.interview_id,
      ...Object.fromEntries(approval.changed_fields.map((field) => [field, approval.after[field]])),
    }), context);
  },
  async mutation(value, preparedAction) {
    const approval = approvalSchema.parse(value);
    const binding = preparedAction.binding as InterviewUpdateBinding;
    return {
      method: "PATCH",
      path: `/interviews/${binding.interview_id}`,
      body: Object.fromEntries(binding.fields.map((field) => [
        field,
        field === "interviewers"
          ? approval.after.interviewers.map(({ user_id, response_status }) => ({ user_id, response_status }))
          : approval.after[field],
      ])),
    };
  },
  async observe(record, context) {
    const binding = record.binding as InterviewUpdateBinding;
    const rows = (await interviewsWhere({ ids: String(binding.interview_id) }, context))
      .filter((row) => row.id === binding.interview_id);
    // A vanished interview is never the signed original state.
    if (rows.length !== 1 || rows[0]!.application_id !== binding.application_id) return "conflict";
    const panel = binding.fields.includes("interviewers") ? await panelFor(binding.interview_id, context) : [];
    return classifyState(record, comparable(rows[0]!.status, stateOf(rows[0]!, panel), binding.fields), context);
  },
};
