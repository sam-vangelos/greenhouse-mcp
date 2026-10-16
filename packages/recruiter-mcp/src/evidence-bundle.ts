import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { containsTokenOrConfigPayload } from "./evidence-hygiene.js";
import type { RolloutEvidenceManifest } from "./rollout-gate.js";

export interface RolloutEvidenceBundleOptions {
  manifestPath: string;
  outputDir?: string;
  force?: boolean;
}

export interface RolloutEvidenceBundleFile {
  sourcePath: string;
  bundledPath: string;
  sizeBytes: number;
}

export interface RolloutEvidenceBundleReport {
  ok: true;
  manifestPath: string;
  outputDir: string | null;
  containsTokens: false;
  fileCount: number;
  files: RolloutEvidenceBundleFile[];
  skippedSensitiveFiles: string[];
  warning: string;
}

interface EvidencePathEntry {
  label: string;
  path: string;
}

export async function buildRolloutEvidenceBundle(options: RolloutEvidenceBundleOptions): Promise<RolloutEvidenceBundleReport> {
  const manifestPath = resolveNonEmptyPath(options.manifestPath, "manifestPath");
  const manifestBaseDir = dirname(manifestPath);
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText) as unknown;
  if (!isRolloutEvidenceManifestLike(manifest)) {
    throw new Error("Rollout evidence manifest is missing required top-level evidence paths.");
  }

  const entries = collectEvidencePathEntries(manifest);
  const filesToBundle = new Map<string, { label: string; destinationRelativePath: string }>();
  filesToBundle.set(manifestPath, { label: "manifest", destinationRelativePath: relative(manifestBaseDir, manifestPath) || "manifest.json" });
  for (const entry of entries) {
    const sourcePath = resolvePortableEvidencePath(manifestBaseDir, entry.path, entry.label);
    const destinationRelativePath = normalizeBundleRelativePath(manifestBaseDir, sourcePath, entry.label);
    filesToBundle.set(sourcePath, { label: entry.label, destinationRelativePath });
  }

  const sensitiveSiblingPaths = new Set<string>();
  const bundledFiles: RolloutEvidenceBundleFile[] = [];
  const outputDir = options.outputDir ? resolveNonEmptyPath(options.outputDir, "outputDir") : null;
  if (outputDir) {
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    await chmod(outputDir, 0o700);
  }

  for (const [sourcePath, metadata] of filesToBundle.entries()) {
    const text = await readFile(sourcePath, "utf8");
    const json = JSON.parse(text) as unknown;
    if (containsTokenOrConfigPayload(json)) {
      throw new Error(`${metadata.label} contains durable tokens, Authorization headers, or config payloads: ${metadata.destinationRelativePath}`);
    }
    collectSensitiveSiblingPaths(sourcePath, json, sensitiveSiblingPaths);
    if (outputDir) {
      const bundledPath = resolveBundleOutputPath(outputDir, metadata.destinationRelativePath);
      if (!options.force && await exists(bundledPath)) {
        throw new Error(`${bundledPath} already exists; pass --force to overwrite it.`);
      }
      await mkdir(dirname(bundledPath), { recursive: true, mode: 0o700 });
      await writeFile(bundledPath, text.endsWith("\n") ? text : `${text}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(bundledPath, 0o600);
      bundledFiles.push({ sourcePath, bundledPath, sizeBytes: Buffer.byteLength(text) });
    } else {
      bundledFiles.push({ sourcePath, bundledPath: metadata.destinationRelativePath, sizeBytes: Buffer.byteLength(text) });
    }
  }

  const skippedSensitiveFiles = [...sensitiveSiblingPaths]
    .filter((path) => !filesToBundle.has(path))
    .sort();

  const report: RolloutEvidenceBundleReport = {
    ok: true,
    manifestPath,
    outputDir,
    containsTokens: false,
    fileCount: bundledFiles.length,
    files: bundledFiles,
    skippedSensitiveFiles,
    warning: "Token-free rollout evidence bundle. It intentionally excludes token-bearing issued-session and desktop-config files; distribute those only to their intended recruiters.",
  };

  if (outputDir) {
    const reportPath = resolve(outputDir, "bundle-report.json");
    if (!options.force && await exists(reportPath)) {
      throw new Error(`${reportPath} already exists; pass --force to overwrite it.`);
    }
    await writeFile(reportPath, `${JSON.stringify(portableBundleReport(report, manifestBaseDir), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(reportPath, 0o600);
  }

  return report;
}

export async function startRolloutEvidenceBundleCli(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv.slice(2)
): Promise<void> {
  try {
    const parsed = parseArgs(args);
    const report = await buildRolloutEvidenceBundle({
      manifestPath: parsed.manifestPath ?? env.GREENHOUSE_RECRUITER_ROLLOUT_EVIDENCE_MANIFEST ?? "",
      outputDir: parsed.outputDir ?? env.GREENHOUSE_RECRUITER_EVIDENCE_BUNDLE_OUT_DIR,
      force: parsed.force,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[greenhouse-recruiter-pack-rollout-evidence] ${message}\n`);
    process.exitCode = 1;
  }
}

function parseArgs(args: string[]): { manifestPath?: string; outputDir?: string; force: boolean } {
  let manifestPath: string | undefined;
  let outputDir: string | undefined;
  let force = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg !== "--manifest" && arg !== "--out-dir") continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) continue;
    if (arg === "--manifest") manifestPath = value;
    if (arg === "--out-dir") outputDir = value;
    index += 1;
  }
  return { manifestPath, outputDir, force };
}

function portableBundleReport(report: RolloutEvidenceBundleReport, manifestBaseDir: string): RolloutEvidenceBundleReport {
  return {
    ...report,
    manifestPath: relativeBundlePath(manifestBaseDir, report.manifestPath, "manifest"),
    outputDir: report.outputDir ? "." : null,
    files: report.files.map((file) => ({
      ...file,
      sourcePath: relativeBundlePath(manifestBaseDir, file.sourcePath, "sourcePath"),
      bundledPath: relativeOutputPath(report.outputDir, file.bundledPath, "bundledPath"),
    })),
    skippedSensitiveFiles: report.skippedSensitiveFiles.map((path) => relativeBundlePath(manifestBaseDir, path, "skippedSensitiveFiles")),
  };
}

function relativeBundlePath(baseDir: string, path: string, label: string): string {
  const relativePath = relative(baseDir, resolve(path));
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`${label} cannot be reported outside the rollout evidence directory.`);
  }
  return relativePath;
}

function relativeOutputPath(outputDir: string | null, path: string, label: string): string {
  if (!outputDir) return path;
  const relativePath = relative(outputDir, resolve(path));
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`${label} cannot be reported outside the rollout evidence bundle directory.`);
  }
  return relativePath;
}

function collectEvidencePathEntries(manifest: RolloutEvidenceManifest): EvidencePathEntry[] {
  return [
    ...manifest.liveProbes.map((entry) => ({ label: `liveProbes.${entry.profile}`, path: entry.path })),
    ...manifest.distributionValidations.map((entry) => ({ label: `distributionValidations.${entry.surface}`, path: entry.path })),
    { label: "productionEnvEvidence", path: manifest.productionEnvEvidence.path },
    ...manifest.revocationDrillEvidence.map((entry) => ({ label: `revocationDrillEvidence.${entry.client}`, path: entry.path })),
    ...manifest.sessionRevocationEvidence.map((entry) => ({ label: `sessionRevocationEvidence.${entry.client}`, path: entry.path })),
    ...(manifest.identityBootstrapEvidence ? [{ label: "identityBootstrapEvidence", path: manifest.identityBootstrapEvidence.path }] : []),
    { label: "rosterPreflightEvidence", path: manifest.rosterPreflightEvidence.path },
    { label: "sessionIssuanceEvidence", path: manifest.sessionIssuanceEvidence.path },
    { label: "desktopConfigEvidence", path: manifest.desktopConfigEvidence.path },
    { label: "desktopDeliveryEvidence", path: manifest.desktopDeliveryEvidence.path },
    ...manifest.desktopUserTests.map((entry) => ({ label: `desktopUserTests.${entry.surface}`, path: entry.path })),
    { label: "leakageSampleEvidence", path: manifest.leakageSampleEvidence.path },
    { label: "auditReviewEvidence", path: manifest.auditReviewEvidence.path },
  ];
}

function collectSensitiveSiblingPaths(sourcePath: string, value: unknown, output: Set<string>): void {
  if (!isRecord(value) || !Array.isArray(value.files)) return;
  if (value.sessionFilesContainTokens !== true && value.configFilesContainTokens !== true) return;
  const baseDir = dirname(sourcePath);
  for (const file of value.files) {
    if (!isRecord(file) || typeof file.path !== "string" || file.path.trim().length === 0) continue;
    const siblingPath = isAbsolute(file.path) ? resolve(file.path) : resolve(baseDir, file.path);
    output.add(siblingPath);
  }
}

function resolvePortableEvidencePath(baseDir: string, path: string, label: string): string {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error(`${label} evidence path is required.`);
  }
  if (isAbsolute(path)) {
    throw new Error(`${label} must use a manifest-relative path for a portable token-free evidence bundle.`);
  }
  const resolved = resolve(baseDir, path);
  const relativePath = relative(baseDir, resolved);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`${label} must stay inside the rollout evidence manifest directory.`);
  }
  return resolved;
}

function normalizeBundleRelativePath(baseDir: string, sourcePath: string, label: string): string {
  const relativePath = relative(baseDir, sourcePath);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`${label} cannot be bundled outside the rollout evidence directory.`);
  }
  return relativePath;
}

function resolveBundleOutputPath(outputDir: string, relativePath: string): string {
  if (relativePath.split(sep).some((part) => part === "..")) {
    throw new Error(`Unsafe bundle output path: ${relativePath}`);
  }
  return resolve(outputDir, relativePath);
}

function isRolloutEvidenceManifestLike(value: unknown): value is RolloutEvidenceManifest {
  return isRecord(value)
    && value.version === 2
    && Array.isArray(value.liveProbes)
    && Array.isArray(value.distributionValidations)
    && isPathObject(value.productionEnvEvidence)
    && Array.isArray(value.revocationDrillEvidence)
    && value.revocationDrillEvidence.every(isClientPathObject)
    && Array.isArray(value.sessionRevocationEvidence)
    && value.sessionRevocationEvidence.every(isClientPathObject)
    && isPathObject(value.rosterPreflightEvidence)
    && isPathObject(value.sessionIssuanceEvidence)
    && isPathObject(value.desktopConfigEvidence)
    && isPathObject(value.desktopDeliveryEvidence)
    && Array.isArray(value.desktopUserTests)
    && isPathObject(value.leakageSampleEvidence)
    && isPathObject(value.auditReviewEvidence);
}

function isClientPathObject(value: unknown): value is { surface: string; client: string; path: string } {
  return isRecord(value)
    && typeof value.path === "string"
    && value.path.trim().length > 0
    && typeof value.surface === "string"
    && typeof value.client === "string";
}

function isPathObject(value: unknown): value is { path: string } {
  return isRecord(value) && typeof value.path === "string" && value.path.trim().length > 0;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function resolveNonEmptyPath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required.`);
  }
  return resolve(value.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startRolloutEvidenceBundleCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[greenhouse-recruiter-pack-rollout-evidence] ${message}\n`);
    process.exit(1);
  });
}
