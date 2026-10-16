import { z } from "zod";
import { EXTERNAL_EVENT_ID_PATTERN, fingerprintValue } from "../crypto.js";
import { ActionDeniedError } from "../errors.js";
import type { GreenhouseRow, InterviewCreateBinding } from "../types.js";
import {
  authorizedApplication,
  createdResourceId,
  nullablePositive,
  nullableText,
  positive,
  prepared,
  uniqueById,
} from "./shared.js";
import type { ActionContext, ActionDefinition } from "./types.js";

/**
 * Records an interview the scheduling resident has ALREADY put on the calendar.
 *
 * Harvest v3 endpoint behavior:
 *   - `POST /v3/interviews` records an already-scheduled calendar event rather than creating one
 *     on an external calendar; `application_id`, `job_interview_id`, `starts_at`, `ends_at` and
 *     `external_event_id` are required.
 *   - `GET /v3/interviews` supports lookup by `external_event_id`, which is what makes the
 *     calendar event id the idempotency key here: replay and reconciliation find the recorded
 *     interview by it, and nothing ever POSTs a second interview for the same event.
 *   - `GET /v3/job_interviews` returns the `id` passed as `job_interview_id` to the Create
 *     Interview endpoint. The slot is validated through that read, the one the read plane's
 *     `search_my_job_interviews` already uses.
 *
 * The organizer is NOT chosen here: the POST body has no organizer field (`0101:646-743`), and in
 * service_user attribution Greenhouse records the integration's service user as organizer. That is
 * CLO-400's problem; this action reads `organizer_id` back and never tries to set it.
 *
 * The helpers below are shared with `interview-update.ts`. They live in this file rather than a
 * shared module so the plane-parity sweep (every file under actions/ reaches a job-scope gate) and
 * the fence inventory keep covering them without a new exemption.
 */

const id = z.number().int().positive().safe();

/** `0101-post_v3-interviews.md:704-712` and `0100-patch_v3-interviews-id.md:678-686`. */
export const responseStatus = z.enum(["accepted", "declined", "tentative", "needs_action"]);
export type ResponseStatus = z.infer<typeof responseStatus>;

/**
 * Interviewers are identified by Greenhouse `user_id` only. The endpoints also accept `email` or
 * `employee_id` (`0101-post_v3-interviews.md:658-702`); those are deliberately not offered yet.
 */
const interviewerInput = z.object({ user_id: id, response_status: responseStatus }).strict();
export const panelInput = z.array(interviewerInput).min(1).max(50)
  .refine((rows) => new Set(rows.map((row) => row.user_id)).size === rows.length, "Each interviewer may appear once.");

const RFC3339_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * RFC 3339 with an explicit offset (`Z` or `±hh:mm`). A bare local time is refused: the calendar
 * event has a definite instant, and guessing a zone for it is how an interview lands an hour off.
 * `Date.parse` alone rolls 2026-02-31 over into March, so the calendar date is checked as well.
 */
export function isRfc3339WithOffset(value: string): boolean {
  const match = RFC3339_WITH_OFFSET.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false;
  if (new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) return false;
  if (match[8] !== undefined && (Number(match[8]) > 23 || Number(match[9]) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

export const interviewTime = z.string().max(40)
  .refine(isRfc3339WithOffset, "Use an RFC 3339 date-time with an explicit offset, e.g. 2026-10-08T10:00:00-07:00.");
/** `0101-post_v3-interviews.md:724-727` / `0100-patch_v3-interviews-id.md:605-608`: maxLength 255. */
export const externalEventId = z.string().regex(EXTERNAL_EVENT_ID_PATTERN);
/** `0101-post_v3-interviews.md:728-734` / `0100-patch_v3-interviews-id.md:617-620`: maxLength 255. */
export const interviewLocation = z.string().trim().min(1).max(255);
/** `0101-post_v3-interviews.md:735-742` / `0100-patch_v3-interviews-id.md:621-626`: a URI, maxLength 255. */
export const videoConferencingUrl = z.string().max(255).url().refine((value) => /^https?:\/\//i.test(value), "Use an http(s) link.");

export const INTERVIEW_FIELDS =
  "id,application_id,job_id,job_interview_id,external_event_id,starts_at,ends_at,location,video_conferencing_url,status,organizer_id";

/**
 * One panel row as read back. `response_status` is nullable on the read side
 * (`0097-get_v3-interviewers.md:637-641`), unlike on POST/PATCH, so a row with no RSVP is a normal
 * state, never an upstream error.
 */
export interface PanelMember {
  user_id: number | null;
  response_status: ResponseStatus | null;
}

/** Canonical comparison order; display order stays whatever the caller or Greenhouse gave. */
export function sortedPanel(panel: readonly PanelMember[]): PanelMember[] {
  return panel
    .map(({ user_id, response_status }) => ({ user_id, response_status }))
    .sort((left, right) => (left.user_id ?? 0) - (right.user_id ?? 0)
      || (left.response_status ?? "").localeCompare(right.response_status ?? ""));
}

/**
 * WHO is on a panel, ascending. RSVPs are left out on purpose: `response_status` mirrors the calendar
 * RSVP (`0097-get_v3-interviewers.md:7`), so it moves on its own between preview and apply and after a
 * write lands. A fingerprint over it turned an interviewer accepting into STATE_CHANGED or a conflict.
 */
export function panelUserIds(panel: readonly PanelMember[]): Array<number | null> {
  return panel.map(({ user_id }) => user_id).sort((left, right) => (left ?? 0) - (right ?? 0));
}

/** One instant, whatever offset it was written in. Greenhouse answers in UTC; callers may not. */
export function instant(value: string | null): string | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new ActionDeniedError("UPSTREAM_STATE_INVALID", "Greenhouse returned an invalid interview time.");
  return new Date(parsed).toISOString();
}

export async function interviewsWhere(params: Record<string, string>, context: ActionContext): Promise<GreenhouseRow[]> {
  // `0099-get_v3-interviews.md:419` (ids), `:503` (application_ids), `:694-701` (external_event_id).
  return context.greenhouse.list("/interviews", { ...params, per_page: "500", fields: INTERVIEW_FIELDS }, context.actorUserId);
}

/**
 * The full current panel. GET /v3/interviews carries no interviewer list (`0099:548-579`), so the
 * panel comes from GET /v3/interviewers (`0097-get_v3-interviewers.md:488`, `interview_ids`). A row
 * with `user_id: null` is an external calendar attendee (`0097:616-622`); its email is never read.
 */
export async function panelFor(interviewId: number, context: ActionContext): Promise<PanelMember[]> {
  const rows = await context.greenhouse.list("/interviewers", {
    interview_ids: String(interviewId),
    per_page: "500",
    fields: "id,interview_id,user_id,response_status",
  }, context.actorUserId);
  return sortedPanel(rows.filter((row) => row.interview_id === interviewId).map((row) => {
    const status = responseStatus.nullable().safeParse(row.response_status ?? null);
    if (!status.success) throw new ActionDeniedError("UPSTREAM_STATE_INVALID", "Greenhouse returned an invalid interviewer response status.");
    return { user_id: nullablePositive(row.user_id, "interviewer user id"), response_status: status.data };
  }));
}

/** Every interviewer must exist and be active. One batched read; returns names for the preview. */
export async function assertActiveInterviewers(userIds: readonly number[], context: ActionContext): Promise<Map<number, string | null>> {
  const rows = await context.greenhouse.list("/users", {
    ids: userIds.join(","), fields: "id,name,deactivated", show_service_accounts: "true",
  }, context.actorUserId);
  const names = new Map<number, string | null>();
  for (const userId of userIds) {
    const user = uniqueById(rows, userId, "Interviewer");
    if (user.deactivated !== false) throw new ActionDeniedError("USER_INACTIVE", "An interviewer on this panel is not an active Greenhouse user.");
    names.set(userId, typeof user.name === "string" && user.name.length > 0 ? user.name : null);
  }
  return names;
}

/** Names for display only. Fail-soft, like every label read: a name must never fail a preview. */
export async function interviewerNames(userIds: readonly number[], context: ActionContext): Promise<Map<number, string | null>> {
  const names = new Map<number, string | null>();
  if (userIds.length === 0) return names;
  try {
    const rows = await context.greenhouse.list("/users", {
      ids: [...new Set(userIds)].join(","), fields: "id,name", show_service_accounts: "true",
    }, context.actorUserId);
    for (const row of rows) {
      if (typeof row.id === "number") names.set(row.id, typeof row.name === "string" && row.name.length > 0 ? row.name : null);
    }
  } catch {
    // Legibility only; every gate has already run.
  }
  return names;
}

export function namedPanel(panel: readonly PanelMember[], names: ReadonlyMap<number, string | null>) {
  return panel.map(({ user_id, response_status }) => ({
    user_id,
    name: user_id === null ? "(external attendee)" : names.get(user_id) ?? "(name unavailable)",
    response_status,
  }));
}

async function jobInterviewOnJob(jobInterviewId: number, jobId: number, context: ActionContext): Promise<string | null> {
  // Read by id alone, then compared, so a slot from another job is refused by name rather than
  // looking like a missing one. Its name is disclosed only once it is known to be on this job.
  const rows = await context.greenhouse.list("/job_interviews", {
    ids: String(jobInterviewId), fields: "id,job_id,name,active",
  }, context.actorUserId);
  const row = uniqueById(rows, jobInterviewId, "Job interview");
  if (positive(row.job_id, "job interview job id") !== jobId) {
    throw new ActionDeniedError("JOB_INTERVIEW_NOT_ON_JOB", "This interview slot is not on the application's job.");
  }
  // `0109-get_v3-job-interviews.md:712-715`: an inactive slot is retained for history and "not used
  // for new applications".
  if (row.active === false) throw new ActionDeniedError("JOB_INTERVIEW_INACTIVE", "This interview slot is not on the job's current interview plan.");
  if (row.active !== true) throw new ActionDeniedError("UPSTREAM_STATE_INVALID", "Greenhouse omitted the interview slot's active state.");
  return typeof row.name === "string" && row.name.length > 0 ? row.name : null;
}

const catalogPreviewSchema = z.object({
  application_id: id,
  job_interview_id: id,
  interviewers: panelInput,
  starts_at: interviewTime,
  ends_at: interviewTime,
  external_event_id: externalEventId,
  location: interviewLocation.optional(),
  video_conferencing_url: videoConferencingUrl.optional(),
}).strict();
const previewSchema = catalogPreviewSchema.refine(
  (value) => Date.parse(value.ends_at) > Date.parse(value.starts_at),
  "ends_at must be after starts_at.",
);
const approvalSchema = z.object({
  target: z.object({ application_id: id, candidate_id: id, job_id: id, job_interview_id: id }).strict(),
  before: z.object({
    already_recorded_interview_id: id.nullable(),
    existing_interview_count: z.number().int().nonnegative().safe(),
  }).strict(),
  after: z.object({
    external_event_id: externalEventId,
    starts_at: interviewTime,
    ends_at: interviewTime,
    location: interviewLocation.nullable(),
    video_conferencing_url: videoConferencingUrl.nullable(),
    interviewers: z.array(interviewerInput).min(1).max(50),
  }).strict(),
  effects: z.array(z.string()).min(1).max(5),
}).strict();
const applySchema = z.object({ intent: z.string().min(1).max(131_072), approval: approvalSchema }).strict();

type CreateInput = z.infer<typeof previewSchema>;

/**
 * The scalar shape a recorded interview is compared on. The panel is not in it: read-back checks the
 * panel separately, as "every requested interviewer is on it" (see `requestedPanelPresent`), because
 * the live panel's RSVPs and extra rows are not the action's to fix.
 */
function createComparable(input: {
  application_id: unknown;
  job_interview_id: unknown;
  external_event_id: unknown;
  starts_at: string | null;
  ends_at: string | null;
  location: unknown;
  video_conferencing_url: unknown;
}) {
  return {
    application_id: input.application_id,
    job_interview_id: input.job_interview_id,
    external_event_id: input.external_event_id,
    starts_at: instant(input.starts_at),
    ends_at: instant(input.ends_at),
    location: input.location,
    video_conferencing_url: input.video_conferencing_url,
  };
}

function requestedPanelPresent(requested: readonly number[], recorded: readonly PanelMember[]): boolean {
  const present = new Set(recorded.map(({ user_id }) => user_id));
  return requested.every((userId) => present.has(userId));
}

const RECORDED_FIELDS = ["job_interview_id", "starts_at", "ends_at", "location", "video_conferencing_url", "interviewers"] as const;

/**
 * What an already-recorded interview holds, set against the request. A plain "already recorded" told
 * the caller the booking was in Greenhouse even when the record there had another time or slot.
 * Disclosure only: nothing is written either way, and a mismatch is the update kind's job.
 */
async function recordedComparison(row: GreenhouseRow, input: CreateInput, context: ActionContext) {
  const interviewId = positive(row.id, "interview id");
  const panel = await panelFor(interviewId, context);
  const recorded = {
    job_interview_id: row.job_interview_id ?? null,
    starts_at: nullableText(row.starts_at ?? null, "interview start"),
    ends_at: nullableText(row.ends_at ?? null, "interview end"),
    location: row.location ?? null,
    video_conferencing_url: row.video_conferencing_url ?? null,
  };
  const differs: Record<typeof RECORDED_FIELDS[number], boolean> = {
    job_interview_id: recorded.job_interview_id !== input.job_interview_id,
    starts_at: instant(recorded.starts_at) !== instant(input.starts_at),
    ends_at: instant(recorded.ends_at) !== instant(input.ends_at),
    location: recorded.location !== (input.location ?? null),
    video_conferencing_url: recorded.video_conferencing_url !== (input.video_conferencing_url ?? null),
    interviewers: !requestedPanelPresent(input.interviewers.map(({ user_id }) => user_id), panel),
  };
  const differences = RECORDED_FIELDS.filter((field) => differs[field]);
  return {
    interview_id: interviewId,
    status: typeof row.status === "string" ? row.status : null,
    ...recorded,
    interviewer_user_ids: panelUserIds(panel),
    organizer_id: typeof row.organizer_id === "number" ? row.organizer_id : null,
    matches_request: differences.length === 0,
    differences,
    ...(differences.length > 0
      ? { next_step: "Greenhouse already holds this calendar event with different details. Nothing will be created; use preview_interview_update on this interview to change it." }
      : {}),
  };
}

async function prepare(input: CreateInput, context: ActionContext, phase: "preview" | "apply") {
  const application = await authorizedApplication(input.application_id, context);
  const slotName = await jobInterviewOnJob(input.job_interview_id, application.jobId, context);
  const names = await assertActiveInterviewers(input.interviewers.map(({ user_id }) => user_id), context);
  const onApplication = (await interviewsWhere({ application_ids: String(application.id) }, context))
    .filter((row) => row.application_id === application.id);
  const recorded = onApplication.filter((row) => row.external_event_id === input.external_event_id);
  if (recorded.length > 1) {
    throw new ActionDeniedError("UPSTREAM_STATE_INVALID", "More than one interview on this application carries this calendar event id.");
  }
  const alreadyRecordedId = recorded.length === 1 ? positive(recorded[0]!.id, "interview id") : null;
  if (phase === "apply" && alreadyRecordedId !== null) {
    // Belt and braces: the baseline below already makes this STATE_CHANGED, but the reason a
    // duplicate is refused deserves its own code in the ledger.
    throw new ActionDeniedError("INTERVIEW_ALREADY_RECORDED", "This calendar event is already recorded as a Greenhouse interview; nothing was created.");
  }
  const alreadyRecorded = recorded.length === 1 ? await recordedComparison(recorded[0]!, input, context) : null;
  const baseline = onApplication
    .map((row) => ({ id: positive(row.id, "interview id"), external_event_id: nullableText(row.external_event_id ?? null, "interview external event id") }))
    .sort((left, right) => left.id - right.id);

  const after = {
    external_event_id: input.external_event_id,
    starts_at: input.starts_at,
    ends_at: input.ends_at,
    location: input.location ?? null,
    video_conferencing_url: input.video_conferencing_url ?? null,
    interviewers: input.interviewers.map(({ user_id, response_status }) => ({ user_id, response_status })),
  };
  const approval = {
    target: {
      application_id: application.id,
      candidate_id: application.candidateId,
      job_id: application.jobId,
      job_interview_id: input.job_interview_id,
    },
    before: { already_recorded_interview_id: alreadyRecordedId, existing_interview_count: onApplication.length },
    after,
    effects: [
      "Records an interview that is already on the calendar. Greenhouse creates no calendar event and sends nobody anything.",
      "Greenhouse may create a placeholder scorecard for each interviewer on the panel.",
      "Greenhouse sets the interview's organizer itself; this action does not choose it.",
    ],
  };
  const binding: InterviewCreateBinding = {
    application_id: application.id,
    job_interview_id: input.job_interview_id,
    external_event_id: input.external_event_id,
    interviewer_user_ids: input.interviewers.map(({ user_id }) => user_id).sort((left, right) => left - right),
  };
  return prepared({
    kind: "interview_create",
    lockKey: `application:${application.id}`,
    scopeJobId: application.jobId,
    binding,
    current: { interviews: baseline },
    desired: createComparable({
      application_id: application.id,
      job_interview_id: input.job_interview_id,
      external_event_id: after.external_event_id,
      starts_at: after.starts_at,
      ends_at: after.ends_at,
      location: after.location,
      video_conferencing_url: after.video_conferencing_url,
    }),
    approval,
    // Names ride on the preview, never the fingerprinted approval; `effects` stays the same array.
    preview: {
      ...approval,
      target: { ...approval.target, job_interview_name: slotName ?? "(name unavailable)" },
      after: { ...after, interviewers: namedPanel(after.interviewers, names) },
      ...(alreadyRecorded ? { already_recorded: alreadyRecorded } : {}),
    },
    changeRequired: alreadyRecordedId === null,
    context,
    subject: { candidateId: application.candidateId, jobId: application.jobId },
    fenceTargets: [{ kind: "application", id: application.id, requiresUnredacted: false }],
  });
}

export const interviewCreateAction: ActionDefinition = {
  kind: "interview_create",
  previewTool: "preview_interview_create",
  applyTool: "apply_interview_create",
  previewTitle: "Preview interview record",
  applyTitle: "Record interview",
  previewDescription: "Preview recording an already-scheduled calendar event as a Greenhouse interview on an application, including its exact time, slot, and interviewer panel.",
  applyDescription: "Record the approved interview exactly once, keyed by its calendar event id. Creates no calendar event and sends nothing.",
  destructive: false,
  previewSchema,
  applySchema,
  catalogPreviewSchema,
  getApproval(value) { return applySchema.parse(value).approval; },
  preparePreview(value, context) { return prepare(previewSchema.parse(value), context, "preview"); },
  prepareApply(value, context) {
    const approval = approvalSchema.parse(value);
    return prepare(previewSchema.parse({
      application_id: approval.target.application_id,
      job_interview_id: approval.target.job_interview_id,
      interviewers: approval.after.interviewers,
      starts_at: approval.after.starts_at,
      ends_at: approval.after.ends_at,
      external_event_id: approval.after.external_event_id,
      ...(approval.after.location !== null ? { location: approval.after.location } : {}),
      ...(approval.after.video_conferencing_url !== null ? { video_conferencing_url: approval.after.video_conferencing_url } : {}),
    }), context, "apply");
  },
  async mutation(value, preparedAction) {
    const approval = approvalSchema.parse(value);
    const binding = preparedAction.binding as InterviewCreateBinding;
    return {
      method: "POST",
      path: "/interviews",
      body: {
        application_id: binding.application_id,
        job_interview_id: binding.job_interview_id,
        interviewers: approval.after.interviewers.map(({ user_id, response_status }) => ({ user_id, response_status })),
        starts_at: approval.after.starts_at,
        ends_at: approval.after.ends_at,
        external_event_id: binding.external_event_id,
        ...(approval.after.location !== null ? { location: approval.after.location } : {}),
        ...(approval.after.video_conferencing_url !== null ? { video_conferencing_url: approval.after.video_conferencing_url } : {}),
      },
    };
  },
  async observe(record, context) {
    const binding = record.binding as InterviewCreateBinding;
    const rows = (await interviewsWhere({
      application_ids: String(binding.application_id),
      external_event_id: binding.external_event_id,
    }, context)).filter((row) => row.application_id === binding.application_id && row.external_event_id === binding.external_event_id);
    // Absence of the event id is the create not (yet) landing — read-after-write lag included — and
    // is never a reason to resend: the service does not retry, and the reconciler only observes.
    if (rows.length === 0) return "not_observed";
    if (rows.length > 1) return "conflict";
    const row = rows[0]!;
    if (record.upstreamResourceId !== null && row.id !== record.upstreamResourceId) return "conflict";
    const observed = createComparable({
      application_id: row.application_id,
      job_interview_id: row.job_interview_id,
      external_event_id: row.external_event_id,
      starts_at: nullableText(row.starts_at ?? null, "interview start"),
      ends_at: nullableText(row.ends_at ?? null, "interview end"),
      location: row.location ?? null,
      video_conferencing_url: row.video_conferencing_url ?? null,
    });
    if (fingerprintValue("interview-create-desired", observed, context.signingSecret) !== record.desiredFingerprint) return "conflict";
    // Every requested interviewer must be on the recorded panel. RSVPs and extra rows (the organizer,
    // `0097:628`) are not compared: they move after the POST, and reconciliation runs much later.
    return requestedPanelPresent(binding.interviewer_user_ids, await panelFor(positive(row.id, "interview id"), context))
      ? "desired_observed" : "conflict";
  },
  resultResourceId: createdResourceId,
};
