import { z } from "zod";
import { customFieldInputSchema, projectReadCustomFields } from "../custom-fields.js";
import type { GreenhouseRow } from "../types.js";
import { positive } from "./shared.js";
import type { ActionContext } from "./types.js";

export const offerDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
  (value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  },
  "Offer date must be a real calendar date.",
);
export const offerValuesSchema = z.object({
  starts_on: offerDate.nullable().optional(),
  custom_fields: z.array(customFieldInputSchema).max(200).optional(),
}).strict();

export async function offers(applicationId: number, currentOnly: boolean, context: ActionContext): Promise<GreenhouseRow[]> {
  return context.greenhouse.list("/offers", {
    application_ids: String(applicationId),
    ...(currentOnly ? { current_only: "true" } : {}),
    per_page: "500",
    fields: "id,version,application_id,job_id,candidate_id,status,starts_on,custom_fields,created_at,updated_at",
  }, context.actorUserId);
}

export function offerProjection(row: GreenhouseRow, fields: string[]) {
  const customNames = fields.filter((field) => field.startsWith("custom:")).map((field) => field.slice(7));
  const result: Record<string, unknown> = { status: row.status };
  if (fields.includes("starts_on")) result.starts_on = normalizeDate(row.starts_on);
  if (customNames.length > 0) result.custom_fields = projectReadCustomFields(row, customNames);
  return result;
}

export function offerIdentity(row: GreenhouseRow) {
  return {
    offer_id: positive(row.id, "offer id"),
    version: positive(row.version, "offer version"),
    status: row.status,
  };
}

export function normalizeDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("Greenhouse returned an invalid offer start date.");
  const match = value.match(/^\d{4}-\d{2}-\d{2}/);
  if (!match) throw new Error("Greenhouse returned an invalid offer start date.");
  return match[0]!;
}
