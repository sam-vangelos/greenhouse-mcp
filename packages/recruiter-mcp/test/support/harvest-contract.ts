import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The vendored Harvest v3 OpenAPI, read as a machine-checkable contract.
 *
 * Every fake in this suite has, until now, been hand-written — which means every row shape was one I
 * chose. That is exactly how a green suite ships a shape bug: the code and the fake agree with each
 * other and both disagree with Greenhouse. `docs/harvest-v3-api/raw/reference` holds the real spec
 * for 165 endpoints, each with an OpenAPI block whose 200-response item schema is
 * `additionalProperties: false` and carries the full property list with types.
 *
 * So the fake stops being my opinion: `assertContractRow` rejects a field Greenhouse does not
 * define, and rejects a defined field carrying the wrong type. A test that seeds `candidate_id` on
 * a row that has no such field now fails, instead of quietly proving nothing.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REFERENCE_DIR = join(HERE, "../../../../docs/harvest-v3-api/raw/reference");

/**
 * The vendored mirror is Greenhouse's documentation and is not distributed with this
 * repository. Contract-checked tests consult this flag and skip with a note when the
 * mirror is absent; with a local mirror in docs/harvest-v3-api they run in full.
 */
import { existsSync } from "node:fs";
export const HARVEST_CONTRACT_AVAILABLE = existsSync(REFERENCE_DIR);

export interface EndpointContract {
  /** e.g. "/v3/applications" */
  path: string;
  /** Property name -> the JSON Schema node the vendored spec declares for it. */
  properties: Record<string, SchemaNode>;
  /** Documented query parameter names, so a fake cannot be asked to honour an invented filter. */
  queryParams: ReadonlySet<string>;
  /** Whether the spec forbids properties it does not name. */
  closed: boolean;
}

interface SchemaNode {
  type?: string | string[];
  format?: string;
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
  enum?: unknown[];
  [key: string]: unknown;
}

/**
 * Where the LIVE Harvest API and the vendored snapshot disagree, measured against the real tenant
 * on 2026-07-27 rather than assumed.
 *
 * The snapshot is a point-in-time capture and Greenhouse has moved since. Without this the referee
 * is stricter than reality: it would reject a row Greenhouse actually returns, and reject a query
 * parameter our own reader correctly sends. A checker with false positives is worse than none,
 * because the fix people reach for is to weaken the checker.
 *
 * Every entry here is a MEASUREMENT with a date, not a guess. Anything not measured stays rejected,
 * so the referee still catches an invented field — which is the whole point of it.
 */
const LIVE_ADDENDA: Record<string, { properties?: Record<string, SchemaNode>; queryParams?: string[] }> = {
  "/v3/applications": {
    properties: {
      // Present on every live application row; absent from the vendored schema, which declares
      // additionalProperties:false. This is the JOB-SPECIFIC stage id — see the query param below.
      job_interview_stage_id: { type: ["integer", "null"] },
    },
    queryParams: [
      // Works live (returns the bucket); undocumented in the snapshot. It is also the ONLY correct
      // way to select a stage bucket: the documented `stage_ids` filters on the application's own
      // `stage_id`, which is unique PER APPLICATION, so passing a job-interview-stage id to it
      // returns zero rows and no error. Measured on job 5059946004: `stage_ids=11925559004` -> 0
      // rows, `job_interview_stage_ids=11925559004` -> 100 rows, same stage.
      "job_interview_stage_ids",
    ],
  },
};

let cache: Map<string, EndpointContract> | null = null;

/**
 * Flatten a `oneOf` / `anyOf` / `allOf` row schema into one property map.
 *
 * `/v3/candidates` is the reason this exists: it declares two variants, because a private candidate
 * comes back as a redacted stub while a visible one carries the full record. A row is legal if it
 * matches EITHER, so the union of their properties is the right acceptance set — narrower would
 * reject rows Greenhouse really returns.
 *
 * The union is only closed if every variant is closed; one open variant means the endpoint can
 * return a field none of them names, and asserting otherwise would be inventing strictness.
 */
function collapseComposition(node: any): any {
  if (!node || typeof node !== "object") return node;
  const variants: any[] = node.oneOf ?? node.anyOf ?? node.allOf ?? [];
  if (variants.length === 0) return node;

  const properties: Record<string, SchemaNode> = { ...(node.properties ?? {}) };
  let closed = node.additionalProperties === false || node.properties === undefined;
  for (const raw of variants) {
    const variant = collapseComposition(raw);
    for (const [name, schema] of Object.entries(variant?.properties ?? {})) {
      // First variant to define a field wins; a later one merely widens the accepted set.
      if (!(name in properties)) properties[name] = schema as SchemaNode;
    }
    if (variant?.additionalProperties !== false) closed = false;
  }
  return { ...node, properties, additionalProperties: closed ? false : undefined };
}

function loadContracts(): Map<string, EndpointContract> {
  if (cache) return cache;
  const contracts = new Map<string, EndpointContract>();
  for (const file of readdirSync(REFERENCE_DIR)) {
    // Only GET list/detail endpoints describe the row shapes a reader sees.
    if (!file.endsWith(".md") || !file.includes("-get_v3-")) continue;
    const raw = readFileSync(join(REFERENCE_DIR, file), "utf8");
    const block = /```json\n([\s\S]*?)\n```/.exec(raw);
    if (!block) continue;
    let spec: any;
    try {
      spec = JSON.parse(block[1]!);
    } catch {
      continue;
    }
    for (const [path, operations] of Object.entries(spec.paths ?? {})) {
      const get = (operations as any).get;
      if (!get) continue;
      const schema = get.responses?.["200"]?.content?.["application/json"]?.schema;
      const item = collapseComposition(schema?.items ?? schema);
      const properties = item?.properties;
      if (!properties) continue;
      // A path can appear in several files (list vs detail); the first with a row schema wins, and
      // any later one must agree, so a contradiction is caught rather than silently overwritten.
      const existing = contracts.get(path);
      const parsed: EndpointContract = {
        path,
        properties,
        queryParams: new Set((get.parameters ?? []).map((p: any) => p?.name).filter(Boolean)),
        closed: item.additionalProperties === false,
      };
      if (!existing) {
        contracts.set(path, parsed);
      } else {
        for (const name of Object.keys(parsed.properties)) {
          if (!(name in existing.properties)) existing.properties[name] = parsed.properties[name]!;
        }
        for (const param of parsed.queryParams) (existing.queryParams as Set<string>).add(param);
      }
    }
  }
  for (const [path, addendum] of Object.entries(LIVE_ADDENDA)) {
    const contract = contracts.get(path);
    if (!contract) continue;
    for (const [name, schema] of Object.entries(addendum.properties ?? {})) {
      if (!(name in contract.properties)) contract.properties[name] = schema;
    }
    for (const param of addendum.queryParams ?? []) {
      (contract.queryParams as Set<string>).add(param);
    }
  }
  cache = contracts;
  return contracts;
}

/** The vendored contract for a reader path, accepting either "/applications" or "/v3/applications". */
export function endpointContract(path: string): EndpointContract {
  const contracts = loadContracts();
  const full = path.startsWith("/v3/") ? path : `/v3${path}`;
  const contract = contracts.get(full);
  if (!contract) {
    throw new Error(
      `No vendored Harvest contract for ${full}. Either the path is wrong, or docs/harvest-v3-api ` +
        `does not cover it — do not fake a shape the contract cannot vouch for.`
    );
  }
  return contract;
}

function typeMatches(value: unknown, node: SchemaNode): boolean {
  const types = node.type === undefined ? [] : Array.isArray(node.type) ? node.type : [node.type];
  if (types.length === 0) return true;
  for (const type of types) {
    if (type === "null" && value === null) return true;
    if (type === "string" && typeof value === "string") return true;
    if (type === "boolean" && typeof value === "boolean") return true;
    if ((type === "integer" || type === "number") && typeof value === "number") return true;
    if (type === "array" && Array.isArray(value)) return true;
    if (type === "object" && value !== null && typeof value === "object" && !Array.isArray(value)) return true;
  }
  return false;
}

/**
 * Assert a fake's row is a shape Greenhouse could actually return.
 *
 * Rejects an undefined field on a closed schema (the invented-field case) and a defined field whose
 * type is wrong. Deliberately does NOT require completeness: `fields=` projections and the reader's
 * own partial reads mean a real row is often a subset, so absence is legal and only presence is
 * checked.
 */
export function assertContractRow(
  path: string,
  row: Record<string, unknown>,
  context = ""
): void {
  const contract = endpointContract(path);
  const where = context ? ` (${context})` : "";
  for (const [key, value] of Object.entries(row)) {
    const node = contract.properties[key];
    if (!node) {
      if (!contract.closed) continue;
      throw new Error(
        `${contract.path} has no field "${key}"${where}, but a fake row supplies it. The vendored ` +
          `contract declares additionalProperties:false, so Greenhouse would never return this. ` +
          `Known fields: ${Object.keys(contract.properties).sort().join(", ")}`
      );
    }
    if (value === undefined) continue;
    if (!typeMatches(value, node)) {
      throw new Error(
        `${contract.path}.${key}${where} is typed ${JSON.stringify(node.type)} in the vendored ` +
          `contract, but the fake supplies ${JSON.stringify(value)}.`
      );
    }
  }
}

/** Assert a fake is only asked to honour query parameters Greenhouse documents. */
export function assertContractParams(path: string, params: Record<string, unknown>): void {
  const contract = endpointContract(path);
  for (const key of Object.keys(params)) {
    if (key === "cursor" && contract.queryParams.has("cursor")) continue;
    if (!contract.queryParams.has(key)) {
      throw new Error(
        `${contract.path} documents no query parameter "${key}". The reader is sending a filter ` +
          `Greenhouse would ignore — which silently WIDENS the read. Documented: ` +
          `${[...contract.queryParams].sort().join(", ")}`
      );
    }
  }
}
