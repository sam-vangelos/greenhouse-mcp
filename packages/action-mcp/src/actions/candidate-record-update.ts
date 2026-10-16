import { z } from "zod";
import {
  buildCompleteCandidateCustomFields,
  customFieldInputSchema,
  projectReadCustomFields,
  projectWriteCustomFields,
  validateCustomFields,
} from "../custom-fields.js";
import type { CandidateUpdateBinding, GreenhouseRow } from "../types.js";
import {
  assertActiveUser,
  authorizedApplication,
  classifyState,
  prepared,
  sameValue,
  uniqueById,
} from "./shared.js";
import type { ActionContext, ActionDefinition } from "./types.js";

const id = z.number().int().positive().safe();
const scalar = z.string().trim().min(1).max(255);
const clearableScalar = z.string().trim().max(255);
const CLEARABLE_SCALARS = new Set(["preferred_name", "company", "title"]);
const CANDIDATE_TIME_ZONES = new Set(`international date line west
midway island
american samoa
hawaii
alaska
pacific time (us & canada)
tijuana
mountain time (us & canada)
arizona
chihuahua
mazatlan
central time (us & canada)
saskatchewan
guadalajara
mexico city
monterrey
central america
eastern time (us & canada)
indiana (east)
bogota
lima
quito
atlantic time (canada)
caracas
la paz
santiago
asuncion
newfoundland
brasilia
buenos aires
montevideo
georgetown
puerto rico
greenland
mid-atlantic
azores
cape verde is.
dublin
edinburgh
lisbon
london
casablanca
monrovia
utc
belgrade
bratislava
budapest
ljubljana
prague
sarajevo
skopje
warsaw
zagreb
brussels
copenhagen
madrid
paris
amsterdam
berlin
bern
zurich
rome
stockholm
vienna
west central africa
bucharest
cairo
helsinki
kyiv
riga
sofia
tallinn
vilnius
athens
istanbul
minsk
jerusalem
harare
pretoria
kaliningrad
moscow
st. petersburg
volgograd
samara
kuwait
riyadh
nairobi
baghdad
tehran
abu dhabi
muscat
baku
tbilisi
yerevan
kabul
ekaterinburg
islamabad
karachi
tashkent
chennai
kolkata
mumbai
new delhi
kathmandu
dhaka
sri jayawardenepura
almaty
astana
novosibirsk
rangoon
bangkok
hanoi
jakarta
krasnoyarsk
beijing
chongqing
hong kong
urumqi
kuala lumpur
singapore
taipei
perth
irkutsk
ulaanbaatar
seoul
osaka
sapporo
tokyo
yakutsk
darwin
adelaide
canberra
melbourne
sydney
brisbane
hobart
vladivostok
guam
port moresby
magadan
srednekolymsk
solomon is.
new caledonia
fiji
kamchatka
marshall is.
auckland
wellington
nuku'alofa
tokelau is.
chatham is.
samoa`.split("\n"));
const timeZone = z.string().trim().min(1).max(255)
  .transform((value) => value.toLowerCase())
  .refine((value) => CANDIDATE_TIME_ZONES.has(value), "Candidate time zone is not supported by Greenhouse.");
const phone = z.object({ value: z.string().trim().min(1).max(255), type: z.enum(["home", "work", "mobile", "skype", "other"]) }).strict();
const address = z.object({ value: z.string().trim().min(1).max(10_000), type: z.enum(["home", "work", "other"]) }).strict();
const email = z.object({ value: z.string().trim().min(1).max(320), type: z.enum(["personal", "work", "other"]) }).strict();
// Greenhouse documents website values as plain strings and returns domains
// without a URL scheme, so do not impose browser-URL syntax here.
const website = z.object({ value: z.string().trim().min(1).max(10_000), type: z.enum(["personal", "company", "portfolio", "blog", "other"]) }).strict();
const social = z.object({ value: z.string().trim().min(1).max(10_000) }).strict();
const tag = z.string().trim().min(1).max(255);

function edits<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    add: z.array(item).max(500).optional(),
    remove: z.array(item).max(500).optional(),
  }).strict().refine((value) => (value.add?.length ?? 0) > 0 || (value.remove?.length ?? 0) > 0, "Collection edit is empty.");
}

const changesSchema = z.object({
  first_name: scalar.optional(),
  last_name: scalar.optional(),
  preferred_name: clearableScalar.optional(),
  company: clearableScalar.optional(),
  title: clearableScalar.optional(),
  time_zone: timeZone.optional(),
  phone_numbers: edits(phone).optional(),
  addresses: edits(address).optional(),
  email_addresses: edits(email).optional(),
  website_addresses: edits(website).optional(),
  social_media_addresses: edits(social).optional(),
  tags: edits(tag).optional(),
  linked_user_ids: edits(id).optional(),
  custom_fields: z.array(customFieldInputSchema).min(1).max(200).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one candidate field change is required.");

const previewSchema = z.object({ context_application_id: id, changes: changesSchema }).strict();
const fieldName = z.enum([
  "first_name", "last_name", "preferred_name", "company", "title", "time_zone",
  "phone_numbers", "addresses", "email_addresses", "website_addresses",
  "social_media_addresses", "tags", "linked_user_ids", "custom_fields",
]);
const projectionSchema = z.object({
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  preferred_name: z.string().nullable().optional(),
  company: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  time_zone: z.string().nullable().optional(),
  phone_numbers: z.array(phone).optional(),
  addresses: z.array(address).optional(),
  email_addresses: z.array(email).optional(),
  website_addresses: z.array(website).optional(),
  social_media_addresses: z.array(social).optional(),
  tags: z.array(tag).optional(),
  linked_user_ids: z.array(id).optional(),
  custom_fields: z.array(customFieldInputSchema).optional(),
}).strict();
const approvalSchema = z.object({
  target: z.object({ context_application_id: id, candidate_id: id, job_id: id }).strict(),
  changed_fields: z.array(fieldName).min(1).max(14),
  before: projectionSchema,
  after: projectionSchema,
  effects: z.array(z.string()).min(1).max(5),
}).strict();
const applySchema = z.object({ intent: z.string().min(1).max(131_072), approval: approvalSchema }).strict();

type Projection = z.infer<typeof projectionSchema>;

async function candidate(candidateId: number, context: ActionContext): Promise<GreenhouseRow> {
  return uniqueById(await context.greenhouse.list("/candidates", {
    ids: String(candidateId),
    fields: [
      "id", "first_name", "last_name", "preferred_name", "company", "title", "time_zone",
      "phone_numbers", "addresses", "email_addresses", "website_addresses",
      "social_media_addresses", "tags", "linked_user_ids", "custom_fields",
    ].join(","),
  }, context.actorUserId), candidateId, "Candidate");
}

function normalizeCollection(row: GreenhouseRow, key: string): unknown[] {
  const value = row[key];
  if (!Array.isArray(value)) throw new Error(`Greenhouse candidate ${key} is invalid.`);
  const parsed = key === "phone_numbers" ? z.array(phone).parse(value)
    : key === "addresses" ? z.array(address).parse(value)
      : key === "email_addresses" ? z.array(email).parse(value)
        : key === "website_addresses" ? z.array(website).parse(value)
          : key === "social_media_addresses" ? z.array(social).parse(value)
            : key === "tags" ? z.array(tag).parse(value)
              : key === "linked_user_ids" ? z.array(id).parse(value)
                : null;
  if (parsed === null) throw new Error(`Greenhouse candidate ${key} is invalid.`);
  return canonicalCollection(parsed as unknown[]);
}

function projected(row: GreenhouseRow, fields: string[]): Projection {
  const result: Projection = {};
  const customNames = fields.filter((field) => field.startsWith("custom:")).map((field) => field.slice(7));
  for (const field of fields.filter((value) => !value.startsWith("custom:"))) {
    if (field === "custom_fields") continue;
    if (["phone_numbers", "addresses", "email_addresses", "website_addresses", "social_media_addresses", "tags", "linked_user_ids"].includes(field)) {
      (result as Record<string, unknown>)[field] = normalizeCollection(row, field);
    } else {
      const value = row[field];
      if (value !== null && typeof value !== "string") throw new Error(`Greenhouse candidate ${field} is invalid.`);
      (result as Record<string, unknown>)[field] = CLEARABLE_SCALARS.has(field) && value === ""
        ? null
        : field === "time_zone" && typeof value === "string" ? value.toLowerCase() : value;
    }
  }
  if (customNames.length > 0) result.custom_fields = projectReadCustomFields(row, customNames);
  return projectionSchema.parse(result);
}

function applyEdits<T>(current: T[], edit: { add?: T[]; remove?: T[] }, label: string): T[] {
  const result = [...current];
  for (const value of edit.remove ?? []) {
    const key = JSON.stringify(value);
    const index = result.findIndex((entry) => JSON.stringify(entry) === key);
    if (index === -1) throw new Error(`Candidate ${label} removal did not match an existing value.`);
    result.splice(index, 1);
  }
  for (const value of edit.add ?? []) {
    const key = JSON.stringify(value);
    if (!result.some((entry) => JSON.stringify(entry) === key)) result.push(value);
  }
  return canonicalCollection(result);
}

function canonicalCollection<T>(values: T[]): T[] {
  return [...values].sort((left, right) => {
    const leftKey = JSON.stringify(left);
    const rightKey = JSON.stringify(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

async function prepareApproved(approved: z.infer<typeof approvalSchema>, context: ActionContext) {
  const application = await authorizedApplication(approved.target.context_application_id, context);
  if (application.candidateId !== approved.target.candidate_id || application.jobId !== approved.target.job_id) {
    throw new Error("Candidate update target no longer matches its context application.");
  }
  const row = await candidate(application.candidateId, context);
  if (approved.changed_fields.includes("linked_user_ids")) {
    const existing = new Set(approved.before.linked_user_ids ?? []);
    await Promise.all((approved.after.linked_user_ids ?? [])
      .filter((userId) => !existing.has(userId))
      .map((userId) => assertActiveUser(userId, context)));
  }
  let validatedCustomFields: Awaited<ReturnType<typeof validateCustomFields>> | null = null;
  if (approved.changed_fields.includes("custom_fields")) {
    validatedCustomFields = await validateCustomFields({
      greenhouse: context.greenhouse,
      actorUserId: context.actorUserId,
      fieldType: "candidate",
      values: approved.after.custom_fields ?? [],
    });
  }
  const customNames = (approved.after.custom_fields ?? []).map((field) => `custom:${field.name_key}`);
  const bindingFields = approved.changed_fields.flatMap((field) => field === "custom_fields" ? customNames : [field]).sort();
  const currentReadShape = projected(row, bindingFields);
  const currentApproval = projectionSchema.parse({
    ...currentReadShape,
    ...(validatedCustomFields ? {
      custom_fields: buildCompleteCandidateCustomFields({
        row,
        definitions: validatedCustomFields.definitions,
        changes: [],
      }),
    } : {}),
  });
  const desired = projectionSchema.parse(approved.after);
  const binding: CandidateUpdateBinding = {
    candidate_id: application.candidateId,
    context_application_id: application.id,
    fields: bindingFields,
  };
  const canonicalApproval = { ...approved, before: currentApproval, after: desired };
  const currentFingerprintValue = validatedCustomFields
    ? canonicalizeCustomFields(currentApproval, validatedCustomFields.definitions)
    : currentApproval;
  const desiredFingerprintValue = validatedCustomFields
    ? canonicalizeCustomFields(desired, validatedCustomFields.definitions)
    : desired;
  return prepared({
    kind: "candidate_record_update",
    lockKey: `candidate:${application.candidateId}`,
    scopeJobId: application.jobId,
    binding,
    current: currentFingerprintValue,
    desired: desiredFingerprintValue,
    approval: canonicalApproval,
    preview: {
      ...canonicalApproval,
      before: currentFingerprintValue,
      after: desiredFingerprintValue,
    },
    changeRequired: !sameValue(currentFingerprintValue, desiredFingerprintValue, context),
    reconciliationGraceMs: 30 * 60_000,
    context,
    subject: { candidateId: application.candidateId, jobId: application.jobId },
    fenceTargets: [
      { kind: "application", id: application.id, requiresUnredacted: false },
      // Redaction, not privacy: get_application already gates candidate privacy, but the candidate's
      // private custom-field VALUES are only observable on the candidate resource itself, and this
      // action reads them exactly when custom_fields is among the changed fields.
      { kind: "candidate", id: application.candidateId, requiresUnredacted: approved.changed_fields.includes("custom_fields") },
    ],
  });
}

async function preparePreview(input: z.infer<typeof previewSchema>, context: ActionContext) {
  const application = await authorizedApplication(input.context_application_id, context);
  const row = await candidate(application.candidateId, context);
  const changedFields = Object.keys(input.changes) as z.infer<typeof fieldName>[];
  const before: Projection = {};
  const after: Projection = {};
  for (const field of changedFields) {
    if (field === "custom_fields") continue;
    if (["phone_numbers", "addresses", "email_addresses", "website_addresses", "social_media_addresses", "tags", "linked_user_ids"].includes(field)) {
      const current = normalizeCollection(row, field);
      (before as Record<string, unknown>)[field] = current;
      (after as Record<string, unknown>)[field] = applyEdits(current, (input.changes as Record<string, unknown>)[field] as { add?: unknown[]; remove?: unknown[] }, field);
    } else {
      const current = row[field];
      if (current !== null && typeof current !== "string") throw new Error(`Greenhouse candidate ${field} is invalid.`);
      (before as Record<string, unknown>)[field] = current;
      const desired = (input.changes as Record<string, unknown>)[field];
      (after as Record<string, unknown>)[field] = CLEARABLE_SCALARS.has(field) && desired === "" ? null : desired;
    }
  }
  if (input.changes.custom_fields !== undefined) {
    const validated = await validateCustomFields({
      greenhouse: context.greenhouse,
      actorUserId: context.actorUserId,
      fieldType: "candidate",
      values: input.changes.custom_fields,
    });
    const complete = buildCompleteCandidateCustomFields({ row, definitions: validated.definitions, changes: input.changes.custom_fields });
    before.custom_fields = buildCompleteCandidateCustomFields({ row, definitions: validated.definitions, changes: [] });
    after.custom_fields = complete;
  }
  const approved = approvalSchema.parse({
    target: { context_application_id: application.id, candidate_id: application.candidateId, job_id: application.jobId },
    changed_fields: changedFields,
    before: projectionSchema.parse(before),
    after: projectionSchema.parse(after),
    effects: ["Touched collections are patched as the complete displayed arrays; omitted candidate fields are not sent."],
  });
  return prepareApproved(approved, context);
}

export const candidateRecordUpdateAction: ActionDefinition = {
  kind: "candidate_record_update",
  previewTool: "preview_candidate_record_update",
  applyTool: "apply_candidate_record_update",
  previewTitle: "Preview candidate record update",
  applyTitle: "Update candidate record",
  previewDescription: "Preview profile, contact, tag, linked-user, and candidate custom-field changes with complete resulting collections.",
  applyDescription: "Apply the approved candidate record fields once; privacy and email-consent flags are not exposed.",
  destructive: true,
  previewSchema,
  applySchema,
  getApproval(value) { return applySchema.parse(value).approval; },
  preparePreview(value, context) { return preparePreview(previewSchema.parse(value), context); },
  prepareApply(value, context) { return prepareApproved(approvalSchema.parse(value), context); },
  async mutation(value, preparedAction) {
    const approved = approvalSchema.parse(value);
    const binding = preparedAction.binding as CandidateUpdateBinding;
    const body: Record<string, unknown> = {};
    for (const field of approved.changed_fields) {
      const desired = approved.after[field];
      body[field] = CLEARABLE_SCALARS.has(field) && desired === null ? "" : desired;
    }
    return { method: "PATCH", path: `/candidates/${binding.candidate_id}`, body };
  },
  async observe(record, context) {
    const binding = record.binding as CandidateUpdateBinding;
    const row = await candidate(binding.candidate_id, context);
    return classifyState(record, projected(row, binding.fields), context);
  },
};

function canonicalizeCustomFields(
  projection: Projection,
  definitions: Awaited<ReturnType<typeof validateCustomFields>>["definitions"]
): Projection {
  if (!projection.custom_fields) return projection;
  return projectionSchema.parse({
    ...projection,
    custom_fields: projectWriteCustomFields(projection.custom_fields, definitions),
  });
}
