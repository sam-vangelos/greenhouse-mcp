import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const greenhouseRoot = resolve(packageRoot, "..");
const repoRoot = resolve(greenhouseRoot, "..", "..");
const srcRoot = resolve(packageRoot, "src");
const binRoot = resolve(packageRoot, "bin");
const runtimeRoots = [srcRoot, binRoot];

// Write/admin helper-name denylist. The scoped recruiter runtime is read-only by
// construction, so no source file under src/ or bin/ may NAME a write or admin primitive
// (POST/PATCH/DELETE, any adminApi*, configureAdminAdapter) or a write-shaped tool. This
// guard has no file exemption — it applies to every runtime file, scoped-reader.ts
// included — which makes it the strongest gate against an admin primitive slipping in.
export const RECRUITER_WRITE_HELPER_PATTERN =
  /\b(apiPost|apiPatch|apiDelete|adminApi\w*|configureAdminAdapter|reject_application|move_application_to_stage|create_offer_draft|update_application_assignment)\b|patch_/;

// Raw control-plane client import boundary, split into two concerns so the scoped-reader
// chokepoint is held to the SAME residency rule as every other runtime file:
//
//   (1) WRITE_CLIENT_MODULE_PATTERN — the write+admin-bearing client MODULE may never be
//       imported by ANY scoped runtime file, scoped-reader.ts INCLUDED. `client.js` is matched
//       at any relative depth, so both `../../control-plane/dist/client.js` and a non-canonical
//       `../../control-plane/src/client.js` are caught; the read-only foundation
//       `client-readonly.js` is the sanctioned surface and is deliberately NOT matched (the `-`
//       before `readonly` keeps the literal `client.js` from appearing). The raw source tree
//       (`control-plane/src/`, and the legacy `mcp/greenhouse/src` / `../../src/` shapes) is forbidden too. This is the rule that
//       was previously bypassable: scoped-reader.ts was whole-file exempt, so reverting its
//       import to `../../dist/client.js` re-loaded the full write/admin surface into the scoped
//       process with the guard still green (data-corruption-lens, Slice A).
//   (2) RAW_CLIENT_NAME_PATTERN — the read primitives' bare names. Sanctioned ONLY in
//       src/scoped-reader.ts (the single read chokepoint); any other runtime file naming them
//       is flagged. scoped-reader is exempt from THIS pattern only, NEVER from (1).
export const WRITE_CLIENT_MODULE_PATTERN =
  /\bclient\.js\b|mcp\/greenhouse\/src|control-plane\/src\/|\.\.\/\.\.\/src\//;
export const RAW_CLIENT_NAME_PATTERN = /\b(apiGet|apiGetWithCursor|configure)\b/;

export function runRecruiterPackageGuards(prefix = "[verify-package]") {
  assertRecruiterRuntimeIsReadOnly(prefix);
  assertRawClientImportBoundary(prefix);
  assertEvidencePayloadHygieneCentralized(prefix);
  assertPackageBinsPresentAndExecutable(prefix);
}

function assertRecruiterRuntimeIsReadOnly(prefix) {
  console.log(`${prefix} recruiter runtime write-helper guard`);
  const hits = collectWriteHelperHits(readRuntimeFiles());
  failOnHits(prefix, hits, "Recruiter runtime source contains write/admin helper names.");
}

function assertRawClientImportBoundary(prefix) {
  console.log(`${prefix} raw Greenhouse client import boundary`);
  const readerChokepoint = resolve(srcRoot, "scoped-reader.ts");
  const hits = collectRawClientImportHits(readRuntimeFiles(), readerChokepoint);
  failOnHits(
    prefix,
    hits,
    "Raw Greenhouse client usage must stay isolated to src/scoped-reader.ts (and the write-bearing client module is forbidden even there)."
  );
}

// Read every scoped runtime source file once as { file, content }. Shared by the pure
// collectors below so the SCANNING logic (not only the regexes) is unit-testable — a test can
// drive the real collector over fixtures, which locks enforcement, not just the denylist shape.
export function readRuntimeFiles() {
  const files = [];
  for (const root of runtimeRoots) {
    for (const file of listFiles(root)) {
      if (!file.endsWith(".ts") && !file.endsWith(".mjs")) continue;
      files.push({ file, content: readFileSync(file, "utf8") });
    }
  }
  return files;
}

// Pure: write/admin helper-name hits across the given files (no file is exempt).
export function collectWriteHelperHits(files) {
  const hits = [];
  for (const { file, content } of files) {
    content.split("\n").forEach((line, index) => {
      if (RECRUITER_WRITE_HELPER_PATTERN.test(line)) {
        hits.push(formatHit(file, index + 1, line));
      }
    });
  }
  return hits;
}

// Pure: raw-client import-boundary hits. The write-bearing client MODULE (1) is forbidden in
// every file INCLUDING the reader chokepoint; the read-primitive NAMES (2) are allowed only in
// the reader chokepoint.
export function collectRawClientImportHits(files, readerChokepointPath) {
  const hits = [];
  for (const { file, content } of files) {
    content.split("\n").forEach((line, index) => {
      if (WRITE_CLIENT_MODULE_PATTERN.test(line)) {
        hits.push(formatHit(file, index + 1, line));
      } else if (file !== readerChokepointPath && RAW_CLIENT_NAME_PATTERN.test(line)) {
        hits.push(formatHit(file, index + 1, line));
      }
    });
  }
  return hits;
}

function assertEvidencePayloadHygieneCentralized(prefix) {
  console.log(`${prefix} evidence payload hygiene boundary`);
  const allowed = resolve(srcRoot, "evidence-hygiene.ts");
  const forbidden = /\bfunction\s+(containsSensitivePayload|manifestContainsTokenPayload|isForbiddenEvidencePayloadKey|looksLikeSensitiveEvidenceString|looksLikeSensitiveString)\b|Authorization\\s\*:\\s\*Bearer|GREENHOUSE_\(\?:CLIENT_SECRET|\brawconfig\b|\bconfigpayload\b/i;
  const hits = scanRuntimeFiles((file, content) => {
    if (file === allowed) return [];
    const matches = [];
    const lines = content.split("\n");
    lines.forEach((line, index) => {
      if (forbidden.test(line)) {
        matches.push(formatHit(file, index + 1, line));
      }
    });
    return matches;
  });
  failOnHits(prefix, hits, "Evidence token/config payload detection must stay centralized in src/evidence-hygiene.ts.");
}

function assertPackageBinsPresentAndExecutable(prefix) {
  console.log(`${prefix} package bin guard`);
  const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
  const bins = packageJson.bin;
  if (!bins || typeof bins !== "object" || Array.isArray(bins)) {
    process.stderr.write(`${prefix} package.json must declare recruiter command bins.\n`);
    process.exit(1);
  }
  const hits = [];
  for (const [name, relativePath] of Object.entries(bins)) {
    if (typeof relativePath !== "string") {
      hits.push(`${name}: bin path must be a string`);
      continue;
    }
    const path = resolve(packageRoot, relativePath);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      hits.push(`${name}: missing ${relative(packageRoot, path)}`);
      continue;
    }
    if (!stat.isFile()) {
      hits.push(`${name}: ${relative(packageRoot, path)} is not a file`);
      continue;
    }
    if ((stat.mode & 0o111) === 0) {
      hits.push(`${name}: ${relative(packageRoot, path)} is not executable`);
    }
    const firstLine = readFileSync(path, "utf8").split("\n", 1)[0];
    if (firstLine !== "#!/usr/bin/env node") {
      hits.push(`${name}: ${relative(packageRoot, path)} must start with #!/usr/bin/env node`);
    }
  }
  failOnHits(prefix, hits, "Package bin declarations are not ready for operator use.");
}

function scanRuntimeFiles(visitor) {
  const hits = [];
  for (const root of runtimeRoots) {
    for (const file of listFiles(root)) {
      if (!file.endsWith(".ts") && !file.endsWith(".mjs")) continue;
      const content = readFileSync(file, "utf8");
      hits.push(...visitor(file, content));
    }
  }
  return hits;
}

function listFiles(root) {
  const entries = [];
  for (const name of readdirSync(root)) {
    const path = resolve(root, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      entries.push(...listFiles(path));
    } else if (stat.isFile()) {
      entries.push(path);
    }
  }
  return entries;
}

function formatHit(file, lineNumber, line) {
  return `${relative(repoRoot, file)}:${lineNumber}: ${line.trim()}`;
}

function failOnHits(prefix, hits, message) {
  if (hits.length === 0) return;
  process.stderr.write(`${prefix} ${message}\n${hits.join("\n")}\n`);
  process.exit(1);
}
