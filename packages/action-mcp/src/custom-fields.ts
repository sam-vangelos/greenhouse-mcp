import { z } from "zod";
import type { GreenhouseGateway, GreenhouseRow } from "./types.js";

const currency = z.object({
  amount: z.number().finite(),
  currency_code: z.string().regex(/^[A-Z]{3}$/),
  rationale: z.string().max(10_000).optional(),
  frequency: z.string().max(255).optional(),
}).strict();

const currencyRange = z.object({
  min_amount: z.number().finite(),
  max_amount: z.number().finite(),
  currency_code: z.string().regex(/^[A-Z]{3}$/),
}).strict().refine((value) => value.min_amount <= value.max_amount, "min_amount must not exceed max_amount");

const numberRange = z.object({
  min_value: z.number().finite(),
  max_value: z.number().finite(),
}).strict().refine((value) => value.min_value <= value.max_value, "min_value must not exceed max_value");

export const customFieldValueSchema = z.union([
  z.string().max(50_000),
  z.boolean(),
  z.number().finite(),
  z.array(z.string().max(10_000)).max(500),
  z.array(z.number().finite()).max(500),
  currency,
  currencyRange,
  numberRange,
  z.null(),
]);

export const customFieldInputSchema = z.object({
  name_key: z.string().regex(/^[a-z0-9_]{1,255}$/),
  value: customFieldValueSchema,
}).strict();

export type CustomFieldInput = z.infer<typeof customFieldInputSchema>;

interface CustomFieldOption {
  id: number;
  name: string;
  active: boolean;
}

interface CustomFieldDefinition {
  id: number;
  nameKey: string;
  valueType: string;
  /** Archived definitions are loaded for PRESERVATION; only active ones accept requested writes. */
  active: boolean;
  triggerNewVersion: boolean;
  optionsById: Map<number, CustomFieldOption>;
  optionIdsByName: Map<string, number[]>;
}

const SUPPORTED_VALUE_TYPES = new Set([
  "short_text", "long_text", "yes_no", "single_select", "multi_select",
  "currency", "number", "date", "url", "currency_range", "number_range",
  "user", "rich_text",
]);

export async function validateCustomFields(input: {
  greenhouse: GreenhouseGateway;
  actorUserId: number;
  fieldType: "candidate" | "offer";
  values: CustomFieldInput[];
}): Promise<{ definitions: Map<string, CustomFieldDefinition>; hasCurrency: boolean }> {
  const requestedNameKeys = new Set(input.values.map((value) => value.name_key));
  if (requestedNameKeys.size !== input.values.length) {
    throw new Error("A custom field may be supplied only once.");
  }
  if (input.values.length === 0) return { definitions: new Map(), hasCurrency: false };
  // ARCHIVED definitions load too — deliberately, and this is the repair of an over-withhold
  // (Phase 2c Slice 6). The old active:"true" narrowing meant a candidate carrying a value under an
  // archived definition could not be written AT ALL: buildCompleteCandidateCustomFields found no
  // definition for the existing value and refused the whole write. Preservation needs the full
  // dictionary; the requested-write gate below still admits only ACTIVE definitions and options,
  // so nothing newly writable is archived — only previously-refused legitimate writes now succeed.
  const definitionParams = {
    field_type: input.fieldType,
    per_page: "500",
    fields: "id,name_key,value_type,trigger_new_version,active,field_type",
  };
  const rows = await input.greenhouse.list("/custom_fields", definitionParams, input.actorUserId);
  const definitions = new Map<string, CustomFieldDefinition>();
  for (const row of rows) {
    if (row.field_type !== input.fieldType) continue;
    if (typeof row.active !== "boolean") continue;
    const nameKey = string(row.name_key, "custom field name key");
    if (input.fieldType === "offer" && !requestedNameKeys.has(nameKey)) continue;
    const id = positive(row.id, "custom field id");
    const valueType = string(row.value_type, "custom field value type");
    definitions.set(nameKey, {
      id,
      nameKey,
      valueType,
      active: row.active,
      triggerNewVersion: row.trigger_new_version === true,
      optionsById: new Map(),
      optionIdsByName: new Map(),
    });
  }
  const requested = input.values.map((value) => {
    const definition = definitions.get(value.name_key);
    // Requested writes go only to ACTIVE definitions. Archived ones exist in the map so existing
    // values survive the round trip; they are not a write surface.
    if (!definition || !definition.active) throw new Error(`Custom field ${value.name_key} is not active for ${input.fieldType}.`);
    return { definition, value: value.value };
  });
  const selectableDefinitions = [...definitions.values()]
    .filter((definition) => definition.valueType === "single_select" || definition.valueType === "multi_select");
  for (let offset = 0; offset < selectableDefinitions.length; offset += 50) {
    const chunk = selectableDefinitions.slice(offset, offset + 50);
    const options = await input.greenhouse.list("/custom_field_options", {
      custom_field_ids: chunk.map((definition) => definition.id).join(","),
      per_page: "500",
      fields: "id,custom_field_id,name,active",
    }, input.actorUserId);
    for (const row of options) {
      if (typeof row.active !== "boolean") continue;
      const definition = [...definitions.values()].find((candidate) => candidate.id === row.custom_field_id);
      if (!definition) continue;
      const option: CustomFieldOption = {
        id: positive(row.id, "custom field option id"),
        name: string(row.name, "custom field option name"),
        active: row.active,
      };
      definition.optionsById.set(option.id, option);
      const matching = definition.optionIdsByName.get(option.name) ?? [];
      matching.push(option.id);
      definition.optionIdsByName.set(option.name, matching);
    }
  }
  for (const { definition, value } of requested) assertRequestedValue(definition, value, input.fieldType);
  return {
    definitions,
    hasCurrency: requested.some(({ definition }) => definition.valueType === "currency" || definition.valueType === "currency_range"),
  };
}

export function projectReadCustomFields(row: GreenhouseRow, fields: string[]): CustomFieldInput[] {
  const source = row.custom_fields;
  if (source === null || source === undefined) {
    return fields.map((name_key) => ({ name_key, value: null }));
  }
  if (!isRecord(source)) throw new Error("Greenhouse returned invalid custom fields.");
  return [...fields].sort().map((name_key) => ({
    name_key,
    value: readCustomFieldValue(source[name_key]),
  }));
}

export function buildCompleteCandidateCustomFields(input: {
  row: GreenhouseRow;
  definitions: Map<string, CustomFieldDefinition>;
  changes: CustomFieldInput[];
}): CustomFieldInput[] {
  const source = input.row.custom_fields;
  if (source !== null && source !== undefined && !isRecord(source)) {
    throw new Error("Greenhouse returned invalid candidate custom fields.");
  }
  const complete = new Map<string, CustomFieldInput>();
  for (const [nameKey, raw] of Object.entries(source ?? {})) {
    const definition = input.definitions.get(nameKey);
    if (!definition) {
      throw new Error(`Existing candidate custom field ${nameKey} cannot be written losslessly.`);
    }
    if (!SUPPORTED_VALUE_TYPES.has(definition.valueType)) {
      if (readCustomFieldValue(raw) === null) continue;
      throw new Error(`Existing candidate custom field ${nameKey} cannot be written losslessly.`);
    }
    complete.set(nameKey, {
      name_key: nameKey,
      value: readCustomFieldForWrite(raw, definition),
    });
  }
  for (const change of input.changes) complete.set(change.name_key, change);
  return [...complete.values()].sort((left, right) => compareStrings(left.name_key, right.name_key));
}

export function projectWriteCustomFields(
  values: CustomFieldInput[],
  definitions: Map<string, CustomFieldDefinition>
): CustomFieldInput[] {
  return values.map((entry) => {
    const definition = definitions.get(entry.name_key);
    if (!definition) throw new Error(`Custom field ${entry.name_key} is not active.`);
    if (entry.value === null) return entry;
    if (definition.valueType === "single_select") {
      if (typeof entry.value !== "number") throw new Error(`Custom field ${entry.name_key} requires one active option ID.`);
      const option = definition.optionsById.get(entry.value);
      if (!option) throw new Error(`Custom field ${entry.name_key} requires one active option ID.`);
      return { name_key: entry.name_key, value: option.name };
    }
    if (definition.valueType === "multi_select") {
      if (!Array.isArray(entry.value) || !entry.value.every((value) => typeof value === "number")) {
        throw new Error(`Custom field ${entry.name_key} requires active option IDs.`);
      }
      const labels = entry.value.map((value) => {
        const option = definition.optionsById.get(value);
        if (!option) throw new Error(`Custom field ${entry.name_key} requires active option IDs.`);
        return option.name;
      });
      return {
        name_key: entry.name_key,
        value: canonicalArray(labels),
      };
    }
    if (Array.isArray(entry.value)) return { ...entry, value: canonicalArray(entry.value) };
    return entry;
  }).sort((left, right) => compareStrings(left.name_key, right.name_key));
}

export function customFieldNames(values: CustomFieldInput[]): string[] {
  return values.map((value) => `custom:${value.name_key}`).sort();
}

function readCustomFieldValue(raw: unknown): CustomFieldInput["value"] {
  if (raw === undefined) return null;
  if (!isRecord(raw) || !Object.hasOwn(raw, "value")) throw new Error("A Greenhouse custom field could not be normalized.");
  const parsed = customFieldValueSchema.safeParse(raw.value);
  if (!parsed.success) throw new Error("A Greenhouse custom field value could not be written losslessly.");
  return Array.isArray(parsed.data) ? canonicalArray(parsed.data) : parsed.data;
}

function readCustomFieldForWrite(raw: unknown, definition: CustomFieldDefinition): CustomFieldInput["value"] {
  const value = readCustomFieldValue(raw);
  if (value === null) return null;
  if (definition.valueType === "single_select") {
    if (typeof value === "number" && definition.optionsById.has(value)) return value;
    if (typeof value !== "string") throw new Error(`Existing candidate custom field ${definition.nameKey} cannot be written losslessly.`);
    const ids = definition.optionIdsByName.get(value) ?? [];
    if (ids.length !== 1) throw new Error(`Existing candidate custom field ${definition.nameKey} cannot be written losslessly.`);
    return ids[0]!;
  }
  if (definition.valueType === "multi_select") {
    if (!Array.isArray(value)) throw new Error(`Existing candidate custom field ${definition.nameKey} cannot be written losslessly.`);
    const ids = value.map((entry) => {
      if (typeof entry === "number" && definition.optionsById.has(entry)) return entry;
      if (typeof entry !== "string") throw new Error(`Existing candidate custom field ${definition.nameKey} cannot be written losslessly.`);
      const ids = definition.optionIdsByName.get(entry) ?? [];
      if (ids.length !== 1) throw new Error(`Existing candidate custom field ${definition.nameKey} cannot be written losslessly.`);
      return ids[0]!;
    });
    return [...new Set(ids)].sort((left, right) => left - right);
  }
  assertRequestedValue(definition, value, "candidate");
  return value;
}

function assertRequestedValue(
  definition: CustomFieldDefinition,
  value: CustomFieldInput["value"],
  fieldType: "candidate" | "offer",
): void {
  if (!SUPPORTED_VALUE_TYPES.has(definition.valueType)) {
    throw new Error(`Custom field ${definition.nameKey} has an unsupported value type.`);
  }
  if (value === null) return;
  switch (definition.valueType) {
    case "short_text":
    case "long_text":
    case "url":
    case "rich_text":
      if (typeof value === "string") return;
      break;
    case "date":
      if (typeof value === "string" && isCalendarDate(value)) return;
      break;
    case "yes_no":
      if (typeof value === "boolean") return;
      break;
    case "number":
      if (typeof value === "number") return;
      break;
    case "user":
      if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return;
      break;
    case "currency":
      if (isRecord(value) && Object.hasOwn(value, "amount") && Object.hasOwn(value, "currency_code")
        && (fieldType === "offer" || (!Object.hasOwn(value, "rationale") && !Object.hasOwn(value, "frequency")))) return;
      break;
    case "currency_range":
      if (isRecord(value) && Object.hasOwn(value, "min_amount") && Object.hasOwn(value, "max_amount")
        && Object.hasOwn(value, "currency_code")) return;
      break;
    case "number_range":
      if (isRecord(value) && Object.hasOwn(value, "min_value") && Object.hasOwn(value, "max_value")) return;
      break;
    case "single_select":
      if (typeof value === "number" && Number.isSafeInteger(value)
        && definition.optionsById.get(value)?.active === true) return;
      break;
    case "multi_select":
      if (Array.isArray(value) && value.every((entry) => typeof entry === "number"
        && Number.isSafeInteger(entry) && definition.optionsById.get(entry)?.active === true)) return;
      break;
  }
  throw new Error(`Custom field ${definition.nameKey} value does not match ${definition.valueType}.`);
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function positive(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`Greenhouse returned an invalid ${label}.`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Greenhouse returned an invalid ${label}.`);
  return value;
}

function canonicalArray(values: string[] | number[]): string[] | number[] {
  return values.every((value): value is number => typeof value === "number")
    ? [...new Set(values)].sort((left, right) => left - right)
    : [...new Set(values as string[])].sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
