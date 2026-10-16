import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { runRolloutGate, type RolloutGateCheck } from "./rollout-gate.js";

export interface RolloutStatusOptions {
  manifestPath?: string;
  rolloutDir?: string;
  now?: () => Date;
}

export interface RolloutEvidenceArtifactStatus {
  label: string;
  status: "present" | "missing" | "invalid_path";
  path?: string;
  reason?: string;
}

export interface RolloutStatusReport {
  ok: boolean;
  status: "ready" | "not_ready";
  checkedAt: string;
  rolloutDir: string;
  manifestPath: string;
  manifestPresent: boolean;
  manifestReadable: boolean;
  evidenceFilesTotal: number;
  evidenceFilesPresent: number;
  evidenceFilesMissing: number;
  evidenceFilesInvalid: number;
  evidenceFiles: RolloutEvidenceArtifactStatus[];
  gateChecksTotal: number;
  gateChecksPassing: number;
  gateChecksFailing: number;
  failingChecks: Array<Pick<RolloutGateCheck, "name" | "summary">>;
  nextActions: string[];
}

interface EvidencePathEntry {
  label: string;
  path: unknown;
}

export async function runRolloutStatus(options: RolloutStatusOptions = {}): Promise<RolloutStatusReport> {
  const manifestPath = resolveManifestPath(options);
  const rolloutDir = dirname(manifestPath);
  const now = options.now ?? (() => new Date());
  const checkedAt = now().toISOString();

  if (!await fileExists(manifestPath)) {
    return {
      ok: false,
      status: "not_ready",
      checkedAt,
      rolloutDir,
      manifestPath,
      manifestPresent: false,
      manifestReadable: false,
      evidenceFilesTotal: 1,
      evidenceFilesPresent: 0,
      evidenceFilesMissing: 1,
      evidenceFilesInvalid: 0,
      evidenceFiles: [{ label: "manifest", status: "missing", path: relativeOrBasename(rolloutDir, manifestPath) }],
      gateChecksTotal: 0,
      gateChecksPassing: 0,
      gateChecksFailing: 0,
      failingChecks: [],
      nextActions: missingManifestActions(rolloutDir),
    };
  }

  const manifestRead = await readJson(manifestPath);
  const evidenceFiles = manifestRead.ok
    ? await collectEvidenceFileStatuses(rolloutDir, manifestRead.value)
    : [];
  const gate = await runRolloutGate({ manifestPath, now });
  const failingChecks = gate.checks
    .filter((check) => check.status === "fail")
    .map((check) => ({ name: check.name, summary: check.summary }));
  const present = evidenceFiles.filter((entry) => entry.status === "present").length;
  const missing = evidenceFiles.filter((entry) => entry.status === "missing").length;
  const invalid = evidenceFiles.filter((entry) => entry.status === "invalid_path").length;

  return {
    ok: gate.ok,
    status: gate.ok ? "ready" : "not_ready",
    checkedAt: gate.checkedAt,
    rolloutDir,
    manifestPath,
    manifestPresent: true,
    manifestReadable: manifestRead.ok,
    evidenceFilesTotal: evidenceFiles.length,
    evidenceFilesPresent: present,
    evidenceFilesMissing: missing,
    evidenceFilesInvalid: invalid,
    evidenceFiles,
    gateChecksTotal: gate.checks.length,
    gateChecksPassing: gate.checks.filter((check) => check.status === "pass").length,
    gateChecksFailing: failingChecks.length,
    failingChecks,
    nextActions: nextActions({ gateOk: gate.ok, manifestReadable: manifestRead.ok, missing, invalid, failingChecks }),
  };
}

export async function startRolloutStatusCli(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv.slice(2)
): Promise<void> {
  const options = parseArgs(env, args);
  const report = await runRolloutStatus(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

function resolveManifestPath(options: RolloutStatusOptions): string {
  if (options.manifestPath) return resolve(options.manifestPath);
  const rolloutDir = options.rolloutDir ? resolve(options.rolloutDir) : resolve("rollout-evidence");
  return resolve(rolloutDir, "manifest.json");
}

function parseArgs(env: NodeJS.ProcessEnv, args: string[]): RolloutStatusOptions {
  const parsed: RolloutStatusOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if ((arg === "--manifest" || arg === "--manifest-path") && next && !next.startsWith("--")) {
      parsed.manifestPath = next;
      index += 1;
    } else if ((arg === "--dir" || arg === "--rollout-dir") && next && !next.startsWith("--")) {
      parsed.rolloutDir = next;
      index += 1;
    }
  }

  if (!parsed.manifestPath && env.GREENHOUSE_RECRUITER_ROLLOUT_EVIDENCE_MANIFEST) {
    parsed.manifestPath = env.GREENHOUSE_RECRUITER_ROLLOUT_EVIDENCE_MANIFEST;
  }
  if (!parsed.manifestPath && !parsed.rolloutDir && env.GREENHOUSE_RECRUITER_ROLLOUT_EVIDENCE_DIR) {
    parsed.rolloutDir = env.GREENHOUSE_RECRUITER_ROLLOUT_EVIDENCE_DIR;
  }
  if (parsed.manifestPath && parsed.rolloutDir) {
    throw new Error("Use either --manifest or --dir, not both.");
  }
  return parsed;
}

async function collectEvidenceFileStatuses(baseDir: string, manifest: unknown): Promise<RolloutEvidenceArtifactStatus[]> {
  const entries = collectEvidencePathEntries(manifest);
  const statuses: RolloutEvidenceArtifactStatus[] = [];
  for (const entry of entries) {
    const resolved = resolveEvidencePath(baseDir, entry.path);
    if (!resolved.ok) {
      statuses.push({ label: entry.label, status: "invalid_path", reason: resolved.reason });
      continue;
    }
    statuses.push(await fileExists(resolved.path)
      ? { label: entry.label, status: "present", path: resolved.relativePath }
      : { label: entry.label, status: "missing", path: resolved.relativePath });
  }
  return statuses;
}

function collectEvidencePathEntries(manifest: unknown): EvidencePathEntry[] {
  if (!isRecord(manifest)) return [];
  const entries: EvidencePathEntry[] = [];
  const liveProbes = Array.isArray(manifest.liveProbes) ? manifest.liveProbes : [];
  liveProbes.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    entries.push({ label: `live_probe:${stringLabel(entry.profile, index)}`, path: entry.path });
  });
  const distributions = Array.isArray(manifest.distributionValidations) ? manifest.distributionValidations : [];
  distributions.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    entries.push({ label: `distribution:${stringLabel(entry.client, index)}`, path: entry.path });
  });
  pushPath(entries, manifest.productionEnvEvidence, "production_env");
  const revocationDrills = Array.isArray(manifest.revocationDrillEvidence) ? manifest.revocationDrillEvidence : [];
  revocationDrills.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    entries.push({ label: `revocation_drill:${stringLabel(entry.client, index)}`, path: entry.path });
  });
  const sessionRevocations = Array.isArray(manifest.sessionRevocationEvidence) ? manifest.sessionRevocationEvidence : [];
  sessionRevocations.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    entries.push({ label: `session_revocation:${stringLabel(entry.client, index)}`, path: entry.path });
  });
  pushPath(entries, manifest.identityBootstrapEvidence, "identity_bootstrap");
  pushPath(entries, manifest.rosterPreflightEvidence, "roster_preflight");
  pushPath(entries, manifest.sessionIssuanceEvidence, "session_issuance");
  pushPath(entries, manifest.desktopConfigEvidence, "desktop_config");
  pushPath(entries, manifest.desktopDeliveryEvidence, "desktop_delivery");
  const desktopTests = Array.isArray(manifest.desktopUserTests) ? manifest.desktopUserTests : [];
  desktopTests.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    entries.push({ label: `desktop_test:${stringLabel(entry.client, index)}`, path: entry.path });
  });
  pushPath(entries, manifest.leakageSampleEvidence, "leakage_sample");
  pushPath(entries, manifest.auditReviewEvidence, "audit_review");
  return entries;
}

function pushPath(entries: EvidencePathEntry[], evidence: unknown, label: string): void {
  if (!isRecord(evidence) || !("path" in evidence)) return;
  entries.push({ label, path: evidence.path });
}

function resolveEvidencePath(baseDir: string, value: unknown): { ok: true; path: string; relativePath: string } | { ok: false; reason: string } {
  if (typeof value !== "string" || value.trim().length === 0) return { ok: false, reason: "path_required" };
  const trimmed = value.trim();
  if (trimmed !== value) return { ok: false, reason: "path_not_exact" };
  if (isAbsolute(trimmed)) return { ok: false, reason: "absolute_path" };
  const target = resolve(baseDir, trimmed);
  const relativePath = relative(baseDir, target);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return { ok: false, reason: "path_escapes_rollout_dir" };
  }
  return { ok: true, path: target, relativePath: relativePath.split(sep).join("/") };
}

async function readJson(path: string): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: JSON.parse(await readFile(path, "utf8")) as unknown };
  } catch {
    return { ok: false };
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function nextActions(input: {
  gateOk: boolean;
  manifestReadable: boolean;
  missing: number;
  invalid: number;
  failingChecks: Array<Pick<RolloutGateCheck, "name" | "summary">>;
}): string[] {
  if (input.gateOk) {
    return [
      "Run npm run verify:rollout before distributing configs.",
      "Build the token-free review bundle with greenhouse-recruiter-pack-rollout-evidence.",
      "Distribute only after protected core/analytics diff checks remain empty.",
    ];
  }
  if (!input.manifestReadable) {
    return [
      "Regenerate the rollout manifest with greenhouse-recruiter-build-rollout-manifest or re-run greenhouse-recruiter-init-rollout-evidence.",
      "Do not hand-edit malformed rollout JSON into a passing state.",
    ];
  }
  const actions: string[] = [];
  if (input.invalid > 0) {
    actions.push("Fix invalid manifest evidence paths; every path must be exact, relative, and stay inside the rollout evidence directory.");
  }
  if (input.missing > 0) {
    actions.push("Generate or copy the missing evidence artifacts listed in evidenceFiles, then rebuild the manifest if paths changed.");
  }
  if (input.failingChecks.length > 0) {
    actions.push("Run greenhouse-recruiter-rollout-gate for full failing-check details, then regenerate stale or incomplete live evidence.");
  }
  actions.push("Keep token-bearing issued session and desktop config files out of review bundles; use greenhouse-recruiter-pack-rollout-evidence after the gate is green.");
  return actions;
}

function missingManifestActions(rolloutDir: string): string[] {
  return [
    `Initialize the rollout evidence workspace with greenhouse-recruiter-init-rollout-evidence --out ${rolloutDir}.`,
    "Generate real production evidence into the scaffolded paths; red templates are intentionally not rollout-ready.",
    "Build a final manifest with greenhouse-recruiter-build-rollout-manifest after the live checks are complete.",
  ];
}

function relativeOrBasename(baseDir: string, path: string): string {
  const relativePath = relative(baseDir, path);
  return relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)
    ? relativePath.split(sep).join("/")
    : "manifest.json";
}

function stringLabel(value: unknown, fallback: number): string {
  return typeof value === "string" && value.trim().length > 0 ? value : String(fallback);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startRolloutStatusCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[greenhouse-recruiter-rollout-status] ${message}
`);
    process.exit(1);
  });
}
