#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(packageRoot, "src");
const sourceFiles = (await walk(sourceRoot)).filter((path) => path.endsWith(".ts"));
const sources = await Promise.all(sourceFiles.map(async (path) => ({ path, text: await readFile(path, "utf8") })));
const allSource = sources.map(({ text }) => text).join("\n");
const greenhouseSource = await readFile(join(sourceRoot, "greenhouse.ts"), "utf8");
const serverSource = await readFile(join(sourceRoot, "server.ts"), "utf8");
const envSource = await readFile(join(sourceRoot, "env.ts"), "utf8");
const cryptoSource = await readFile(join(sourceRoot, "crypto.ts"), "utf8");
const serviceSource = await readFile(join(sourceRoot, "service.ts"), "utf8");
const typesSource = await readFile(join(sourceRoot, "types.ts"), "utf8");
const indexSource = await readFile(join(sourceRoot, "index.ts"), "utf8");
const sql = await readFile(join(packageRoot, "supabase", "action-state.sql"), "utf8");
const readme = await readFile(join(packageRoot, "README.md"), "utf8");
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
// The lockfile lives at the workspace root; this package's identity is its workspace entry.
const workspaceLock = JSON.parse(await readFile(join(packageRoot, "..", "..", "package-lock.json"), "utf8"));

const capabilities = [
  ["application_assignment_change", "application_assignment_change"],
  ["job_owner_change", "job_owner_change"],
  ["application_stage_move", "application_stage_move"],
  ["application_rejection", "application_rejection"],
  ["application_unreject", "application_unreject"],
  ["candidate_note_create", "candidate_note_create"],
  ["job_note_change", "job_note_change"],
  ["application_attribution_change", "application_attribution_change"],
  ["candidate_record_update", "candidate_record_update"],
  ["offer_create", "offer_create"],
  ["offer_update", "offer_update"],
];
const expectedKinds = capabilities.map(([kind]) => kind);
const kindsBlock = typesSource.match(/export const ACTION_KINDS = \[([\s\S]*?)\] as const;/)?.[1] ?? "";
const actualKinds = [...kindsBlock.matchAll(/"([a-z][a-z0-9_]*)"/g)].map((match) => match[1]);
assert(JSON.stringify(actualKinds) === JSON.stringify(expectedKinds), "ACTION_KINDS must contain exactly the 11 approved capabilities in registry order.");

const actionSource = sources.filter(({ path }) => path.includes(`${join("src", "actions")}`)).map(({ text }) => text).join("\n");
const previewTools = [...actionSource.matchAll(/previewTool:\s*"([a-z][a-z0-9_]*)"/g)].map((match) => match[1]);
const applyTools = [...actionSource.matchAll(/applyTool:\s*"([a-z][a-z0-9_]*)"/g)].map((match) => match[1]);
assert(previewTools.length === 11 && new Set(previewTools).size === 11, "The action registry must define 11 unique preview tools.");
assert(applyTools.length === 11 && new Set(applyTools).size === 11, "The action registry must define 11 unique apply tools.");
for (const [, toolStem] of capabilities) {
  assert(previewTools.includes(`preview_${toolStem}`), `Missing preview_${toolStem}.`);
  assert(applyTools.includes(`apply_${toolStem}`), `Missing apply_${toolStem}.`);
}

assert(count(serverSource, "server.registerTool(") === 2, "The server must register one preview and one apply inside the closed registry loop.");
assert(serverSource.includes("for (const definition of ACTION_DEFINITIONS)"), "The MCP catalog must be owned by ACTION_DEFINITIONS.");
assert(envSource.includes("GREENHOUSE_ACTION_CAPABILITIES") && envSource.includes("GREENHOUSE_ACTION_WRITE_CAPABILITIES"), "Catalog and write capability allowlists are required.");
assert(envSource.includes("must be a subset"), "The write allowlist must be constrained to the catalog.");

const mutationBlock = greenhouseSource.match(/const MUTATION_PATHS:[\s\S]*?= \[([\s\S]*?)\];/)?.[1] ?? "";
const mutationPatterns = [...mutationBlock.matchAll(/\["(?:POST|PATCH|DELETE)",\s*\/\^/g)];
assert(mutationPatterns.length === 11, "The Greenhouse transport must contain exactly 11 fixed mutation route patterns.");
for (const fragment of [
  "applications\\/", "move|reject|unreject", "job_owners", "notes", "job_notes",
  "candidates", "offers",
]) assert(mutationBlock.includes(fragment), `Mutation route allowlist is missing ${fragment}.`);
assert(greenhouseSource.includes("mutation path is not owned by the action catalog"), "Unknown mutation routes must fail closed.");

assert(cryptoSource.includes("30 * 24 * 60 * 60 * 1000"), "Action sessions must default to the 30-day maximum.");
// Pinned as a SET rather than an exact string: the union grew to carry claude_desktop_chat (the
// client the pilot actually installs), and an exact-match assertion turns every legitimate
// addition into a guard failure while catching nothing a membership check misses. What must stay
// true is that every real client is representable and that "test" never becomes the only one.
for (const client of ["codex", "claude_code", "claude_desktop_chat", "test"]) {
  assert(new RegExp(`ActionClient =[^;]*"${client}"`).test(typesSource), `ActionClient must include ${client}.`);
  assert(new RegExp(`check \\(client in \\([^)]*'${client}'`).test(sql), `The installed schema must accept the ${client} client, or an entitlement for it cannot be written.`);
}
assert(/assertNotRevoked\(\)/.test(allSource) && /isSessionRevoked\(this\.config\.session\.tokenId\)/.test(allSource), "Every session must be checked against central token-id revocation.");
// Structural, not a count: there are three assertNotRevoked call sites and a threshold survives
// deleting the one that matters. What matters is that the FRESH PREFLIGHT re-checks — the block
// that runs after prepareApply and before the mutation — so a token revoked between preview and
// apply cannot still write.
assert(/assertPreparedMatches\([^;]*\);[\s\S]{0,400}?await this\.assertNotRevoked\(\)/.test(serviceSource), "Revocation must be re-checked inside apply's fresh preflight, after assertPreparedMatches (the visibility fence may sit between) — not only at entry, or a token revoked between preview and apply still writes.");
assert(indexSource.includes("ACTION_DEFINITIONS"), "The package entry must export the action catalog so a host builds its grant from source, not a copied list.");
assert(indexSource.includes("GreenhouseActionService"), "The package entry must export the service a host mounts.");
assert(!/export\s+\*/.test(indexSource), "The package entry must enumerate its exports; a star export would silently widen the surface as internals are added.");
assert(!/from "\.\/greenhouse\.js"/.test(indexSource), "The package entry must NOT re-export the Greenhouse gateway: service.ts holds the only mutate() call site and the visibility fence is specified against that.");

const intentAndRecord = typesSource.match(/export interface ActionIntent[\s\S]*?export interface ActionStore/)?.[0] ?? "";
assert(!/\b(body|notes|email_addresses|phone_numbers|compensation|salary|bearer|prompt)\b/i.test(intentAndRecord), "Intent and durable action types must remain metadata-only.");
const bindingTypes = typesSource.match(/export interface AssignmentBinding[\s\S]*?export type ActionStatus/)?.[0] ?? "";
assert(!/\b(body|notes|email_addresses|phone_numbers|compensation|salary|bearer|prompt)\??:/i.test(bindingTypes), "Signed action bindings must contain metadata, not sensitive values.");
assert(sql.includes("create table if not exists public.greenhouse_action ("), "The shared action ledger is required.");
assert(sql.includes("on public.greenhouse_action(lock_key)"), "Unresolved actions must lock the generic resource key.");
assert(sql.includes("where status in ('executing', 'unknown')"), "Unknown actions must retain their resource lock.");
for (const rpc of [
  "claim_greenhouse_action", "begin_greenhouse_action_mutation", "finish_greenhouse_action",
  "prepare_greenhouse_action_reconciliation", "defer_greenhouse_action_unknown",
  "reconcile_greenhouse_action_original_observation", "resolve_greenhouse_action_unknown",
]) assert(sql.includes(`function public.${rpc}`), `Action SQL is missing ${rpc}.`);
assert(count(sql, "enable row level security") === 2, "Both action-state tables must enable RLS.");
assert(!/candidate_(name|email)|prompt|bearer_token|signed_url|compensation|salary/i.test(sql), "The durable schema must remain metadata-only.");

assert(!allSource.includes("ENABLE_GREENHOUSE_WRITE_OPS"), "Legacy write enablement must never appear in the action package.");
assert(!allSource.includes("/control-plane"), "The nonexistent legacy control plane must never be referenced.");
assert(!sources.some(({ text }) => /from\s+["'](?:\.\.\/){2,}/.test(text)), "Runtime source must not import outside this package's src tree.");
assert(packageJson.name === "@greenhouse-mcp/action-mcp" && workspaceLock.packages?.["packages/action-mcp"]?.name === packageJson.name, "Package and lockfile identities must agree.");
assert(workspaceLock.packages?.["node_modules/@greenhouse-mcp/action-mcp"]?.link === true, "The workspace must link this package.");
assert(Object.keys(packageJson.bin).every((name) => name.startsWith("greenhouse-action-")), "Binary names must use the generalized action identity.");
assert(packageJson.main === "dist/index.js" && packageJson.types === "dist/index.d.ts", "The package must be importable: main and types must point at the built entry.");
assert(packageJson.exports === undefined, "Do not add an exports map — the shipped consumability spec (phase-1e §4.3) requires main/types WITHOUT it.");

const scopes = [
  "applications:list", "applications:update", "applications:move", "applications:reject", "applications:unreject",
  "users:list", "jobs:list", "user_job_permissions:list", "job_owners:list", "job_owners:create", "job_owners:destroy",
  "application_stages:list", "job_interview_stages:list", "rejection_reasons:list", "rejection_details:list",
  "candidates:list", "candidates:update", "notes:list", "notes:create", "job_notes:list", "job_notes:create",
  "job_notes:update", "job_notes:destroy", "sources:list", "referrers:list", "offers:list", "offers:create",
  "offers:update", "custom_fields:list", "custom_field_options:list",
];
for (const scope of scopes) assert(readme.includes(`harvest:${scope}`), `README is missing Harvest scope ${scope}.`);

process.stdout.write(`Greenhouse Action MCP package guard passed (${sourceFiles.length} runtime files, 11 capabilities, 22 tools).\n`);

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else result.push(path);
  }
  return result;
}

function count(value, fragment) {
  return value.split(fragment).length - 1;
}

function assert(condition, message) {
  if (!condition) throw new Error(`${message} (${relative(process.cwd(), packageRoot)})`);
}
