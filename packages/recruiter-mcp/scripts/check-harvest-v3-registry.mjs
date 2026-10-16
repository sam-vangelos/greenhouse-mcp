#!/usr/bin/env node
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(packageRoot, "../../..");
const referenceDir = join(repoRoot, "docs/harvest-v3-api/raw/reference");
const generatedPath = join(packageRoot, "src/harvest-v3-registry.generated.ts");

const writeMode = process.argv.includes("--write");

// The vendored Harvest v3 reference mirror is not distributed with this repository
// (it is Greenhouse's documentation). The GENERATED registry ships; this checker
// verifies it against a local mirror when one exists and is a no-op otherwise.
import { existsSync } from "node:fs";
if (!existsSync(referenceDir)) {
  console.log("[harvest-v3-registry] no local vendor-docs mirror at docs/harvest-v3-api — skipping (the generated registry is source-controlled).");
  process.exit(0);
}

const facts = await readHarvestGetEndpointFacts(referenceDir);
const source = buildGeneratedSource(facts);

if (writeMode) {
  await mkdir(dirname(generatedPath), { recursive: true });
  await writeFile(generatedPath, source, "utf8");
  console.log(`[harvest-v3-registry] wrote ${facts.length} GET endpoint facts to ${relative(repoRoot, generatedPath)}`);
} else {
  const current = await readFile(generatedPath, "utf8");
  if (current !== source) {
    console.error("[harvest-v3-registry] generated facts are stale. Run npm run check:harvest-registry -- --write from the scoped recruiter package.");
    process.exit(1);
  }
  console.log(`[harvest-v3-registry] verified ${facts.length} GET endpoint facts from vendored docs.`);
}

async function readHarvestGetEndpointFacts(dir) {
  const entries = [];
  const files = (await readdir(dir)).filter((file) => file.endsWith(".md")).sort();
  for (const file of files) {
    const sourceDocPath = relative(repoRoot, join(dir, file)).replaceAll("\\", "/");
    const markdown = await readFile(join(dir, file), "utf8");
    const openApi = parseOpenApiBlock(markdown, sourceDocPath);
    if (!openApi?.paths || typeof openApi.paths !== "object") continue;
    for (const [path, operations] of Object.entries(openApi.paths)) {
      if (!isRecord(operations)) continue;
      // OpenAPI path-level parameters (e.g. a required {bulk_action_uuid} path param) apply to every
      // operation under the path. Merge them with the GET operation's own parameters; operation-level
      // wins on a name+location collision. The prior code read only operation.parameters and silently
      // dropped path-level required params.
      const pathLevelParameters = readParameters(operations.parameters);
      for (const [method, operation] of Object.entries(operations)) {
        if (method.toUpperCase() !== "GET" || !isRecord(operation)) continue;
        const parameters = mergeParameters(pathLevelParameters, readParameters(operation.parameters));
        entries.push({
          path,
          method: "GET",
          sourceDocPath,
          summary: typeof operation.summary === "string" ? operation.summary : null,
          list: parameters.some((param) => param.name === "cursor" || param.name === "per_page"),
          cursorPaginated: parameters.some((param) => param.name === "cursor"),
          parameters,
          responseFields: readResponseFields(operation),
        });
      }
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path) || a.sourceDocPath.localeCompare(b.sourceDocPath));
}

function parseOpenApiBlock(markdown, sourceDocPath) {
  const match = markdown.match(/```json\n([\s\S]*?)\n```/);
  if (!match) {
    throw new Error(`No OpenAPI JSON block found in ${sourceDocPath}`);
  }
  return JSON.parse(match[1]);
}

function readParameters(parameters) {
  if (!Array.isArray(parameters)) return [];
  return parameters
    .filter(isRecord)
    .map((param) => {
      const schema = isRecord(param.schema) ? param.schema : {};
      return compactObject({
        name: String(param.name),
        in: typeof param.in === "string" ? param.in : "query",
        required: param.required === true,
        type: readSchemaType(schema),
        enumValues: readEnumValues(schema),
      });
    });
}

function mergeParameters(pathLevel, operationLevel) {
  const byKey = new Map();
  for (const param of pathLevel) byKey.set(`${param.in}:${param.name}`, param);
  for (const param of operationLevel) byKey.set(`${param.in}:${param.name}`, param);
  return [...byKey.values()];
}

function readResponseFields(operation) {
  const fields = new Map();
  const schemas = [];
  const responses = isRecord(operation.responses) ? operation.responses : {};
  for (const [status, response] of Object.entries(responses)) {
    if (!status.startsWith("2") || !isRecord(response)) continue;
    const content = isRecord(response.content) ? response.content : {};
    for (const mediaType of Object.values(content)) {
      if (isRecord(mediaType) && isRecord(mediaType.schema)) schemas.push(mediaType.schema);
    }
  }
  for (const schema of schemas) {
    collectResponseFields(schema, fields, new Set());
  }
  return [...fields.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function collectResponseFields(schema, fields, seen) {
  if (!isRecord(schema) || seen.has(schema)) return;
  seen.add(schema);
  if (schema.type === "array" && isRecord(schema.items)) {
    collectResponseFields(schema.items, fields, seen);
    return;
  }
  for (const variantKey of ["oneOf", "anyOf", "allOf"]) {
    const variants = schema[variantKey];
    if (Array.isArray(variants)) {
      for (const variant of variants) collectResponseFields(variant, fields, seen);
    }
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((name) => typeof name === "string") : []);
  for (const [name, property] of Object.entries(properties)) {
    const existing = fields.get(name);
    fields.set(name, compactObject({
      name,
      required: existing?.required === true || required.has(name),
      type: readSchemaType(isRecord(property) ? property : {}),
    }));
  }
}

function readSchemaType(schema) {
  const type = schema.type;
  if (typeof type === "string") return type;
  if (Array.isArray(type)) return type.filter((entry) => entry !== "null").join("|") || "unknown";
  if (Array.isArray(schema.oneOf)) return "oneOf";
  if (Array.isArray(schema.anyOf)) return "anyOf";
  if (Array.isArray(schema.allOf)) return "allOf";
  return "unknown";
}

function readEnumValues(schema) {
  return Array.isArray(schema.enum) ? schema.enum.filter((entry) => typeof entry === "string") : undefined;
}

function compactObject(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function buildGeneratedSource(entries) {
  return [
    "// Generated by scripts/check-harvest-v3-registry.mjs. Do not edit by hand.",
    `// Source: docs/harvest-v3-api/raw/reference/*.md (${entries.length} GET endpoints).`,
    "",
    `export const HARVEST_V3_ENDPOINT_DOC_FACTS = ${JSON.stringify(entries, null, 2)} as const;`,
    "",
  ].join("\n");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
