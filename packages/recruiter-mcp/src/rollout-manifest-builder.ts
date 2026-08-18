import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { normalizeSessionIssuedAt, normalizeSessionTokenId } from "./auth.js";
import { classifyNonProductionHostname } from "./production-host.js";
import type { RolloutEvidenceManifest } from "./rollout-gate.js";

export interface RolloutManifestBuildOptions {
  outputPath?: string;
  force?: boolean;
  paths?: Partial<RolloutManifestEvidencePaths>;
  candidateMcpUrl?: string;
  candidateCommit?: string;
  permissionFreshnessEvidence: RolloutManifestPermissionFreshnessOptions;
}

export interface RolloutManifestEvidencePaths {
  smallReqProbe: string;
  manyReqProbe: string;
  allJobsOrOperatorProbe: string;
  noPermissionsProbe: string;
  chatgptDistribution: string;
  claudeDistribution: string;
  claudeCodeDistribution: string;
  productionEnv: string;
  revocationDrill: string;
  claudeRevocationDrill: string;
  claudeCodeRevocationDrill: string;
  sessionRevocation: string;
  claudeSessionRevocation: string;
  claudeCodeSessionRevocation: string;
  identityBootstrap?: string;
  rosterPreflight: string;
  sessionIssuance: string;
  desktopConfig: string;
  desktopDelivery: string;
  chatgptDesktopTest: string;
  claudeDesktopTest: string;
  claudeCodeDesktopTest: string;
  leakageSample: string;
  auditReview: string;
}

export interface RolloutManifestPermissionFreshnessOptions {
  removedReqDisappearedOnNextRead?: boolean;
  addedReqAppearedWithoutDeploy?: boolean;
  privateNotesDropped?: boolean;
  scopedVsUnscopedLeakageSamplePassed?: boolean;
  durableAccessTestedWithoutRoutineReverification?: boolean;
  verifiedAt?: string;
  verifiedBy?: string;
  removedReqId?: number;
  removedReqRowsBeforeRemoval?: number;
  removedReqRowsAfterRemoval?: number;
  addedReqId?: number;
  addedReqRowsBeforeAddition?: number;
  addedReqRowsAfterAddition?: number;
  privateNoteId?: number;
  privateNoteRowsReturnedAfterScope?: number;
  durableSessionEmail?: string;
  durableSessionSurface?: "chatgpt_desktop" | "claude_desktop";
  durableSessionTokenId?: string;
  durableSessionTokenIdAfterRestart?: string;
  durableSessionIssuedAt?: string;
  durableSessionIssuedAtAfterRestart?: string;
  routineReverificationPrompted?: boolean;
}

export interface RolloutManifestBuildReport {
  ok: true;
  manifestPath: string | null;
  manifest: RolloutEvidenceManifest;
}

const DEFAULT_PATHS: RolloutManifestEvidencePaths = {
  smallReqProbe: "live-probe-small-req-set.json",
  manyReqProbe: "live-probe-many-req-set.json",
  allJobsOrOperatorProbe: "live-probe-all-jobs-or-operator.json",
  noPermissionsProbe: "live-probe-no-permissions.json",
  chatgptDistribution: "distribution-chatgpt-desktop.json",
  claudeDistribution: "distribution-claude-desktop.json",
  claudeCodeDistribution: "distribution-claude-code.json",
  productionEnv: "production-env-check.json",
  revocationDrill: "revocation-drill-chatgpt-codex.json",
  claudeRevocationDrill: "revocation-drill-claude-desktop.json",
  claudeCodeRevocationDrill: "revocation-drill-claude-code.json",
  sessionRevocation: "session-revocation-chatgpt-codex.json",
  claudeSessionRevocation: "session-revocation-claude-desktop.json",
  claudeCodeSessionRevocation: "session-revocation-claude-code.json",
  rosterPreflight: "roster-preflight.json",
  sessionIssuance: "issued-sessions/manifest.json",
  desktopConfig: "desktop-configs/manifest.json",
  desktopDelivery: "desktop-delivery.json",
  chatgptDesktopTest: "desktop-chatgpt-desktop.json",
  claudeDesktopTest: "desktop-claude-desktop.json",
  claudeCodeDesktopTest: "desktop-claude-code.json",
  leakageSample: "leakage-sample.json",
  auditReview: "audit-review.json",
};

const REQUIRED_PERMISSION_FLAGS: Array<keyof RolloutManifestPermissionFreshnessOptions> = [
  "removedReqDisappearedOnNextRead",
  "addedReqAppearedWithoutDeploy",
  "privateNotesDropped",
  "scopedVsUnscopedLeakageSamplePassed",
  "durableAccessTestedWithoutRoutineReverification",
];

const PERMISSION_FLAG_ARGS: Record<string, keyof RolloutManifestPermissionFreshnessOptions> = {
  "--removed-req-disappeared-on-next-read": "removedReqDisappearedOnNextRead",
  "--added-req-appeared-without-deploy": "addedReqAppearedWithoutDeploy",
  "--private-notes-dropped": "privateNotesDropped",
  "--scoped-vs-unscoped-leakage-sample-passed": "scopedVsUnscopedLeakageSamplePassed",
  "--durable-access-tested-without-routine-reverification": "durableAccessTestedWithoutRoutineReverification",
};

const PERMISSION_STRING_ARGS: Record<string, keyof RolloutManifestPermissionFreshnessOptions> = {
  "--permission-freshness-verified-at": "verifiedAt",
  "--permission-freshness-verified-by": "verifiedBy",
  "--durable-session-email": "durableSessionEmail",
  "--durable-session-surface": "durableSessionSurface",
  "--durable-session-token-id": "durableSessionTokenId",
  "--durable-session-token-id-after-restart": "durableSessionTokenIdAfterRestart",
  "--durable-session-issued-at": "durableSessionIssuedAt",
  "--durable-session-issued-at-after-restart": "durableSessionIssuedAtAfterRestart",
};

const PERMISSION_NUMBER_ARGS: Record<string, keyof RolloutManifestPermissionFreshnessOptions> = {
  "--removed-req-id": "removedReqId",
  "--removed-req-rows-before": "removedReqRowsBeforeRemoval",
  "--removed-req-rows-after": "removedReqRowsAfterRemoval",
  "--added-req-id": "addedReqId",
  "--added-req-rows-before": "addedReqRowsBeforeAddition",
  "--added-req-rows-after": "addedReqRowsAfterAddition",
  "--private-note-id": "privateNoteId",
  "--private-note-rows-returned": "privateNoteRowsReturnedAfterScope",
};

const PATH_ARGS: Record<string, keyof RolloutManifestEvidencePaths> = {
  "--small-req-probe": "smallReqProbe",
  "--many-req-probe": "manyReqProbe",
  "--all-jobs-probe": "allJobsOrOperatorProbe",
  "--no-permissions-probe": "noPermissionsProbe",
  "--chatgpt-distribution": "chatgptDistribution",
  "--claude-distribution": "claudeDistribution",
  "--claude-code-distribution": "claudeCodeDistribution",
  "--production-env": "productionEnv",
  "--revocation-drill": "revocationDrill",
  "--chatgpt-revocation-drill": "revocationDrill",
  "--claude-revocation-drill": "claudeRevocationDrill",
  "--claude-code-revocation-drill": "claudeCodeRevocationDrill",
  "--session-revocation": "sessionRevocation",
  "--chatgpt-session-revocation": "sessionRevocation",
  "--claude-session-revocation": "claudeSessionRevocation",
  "--claude-code-session-revocation": "claudeCodeSessionRevocation",
  "--identity-bootstrap": "identityBootstrap",
  "--roster-preflight": "rosterPreflight",
  "--session-issuance": "sessionIssuance",
  "--desktop-config": "desktopConfig",
  "--desktop-delivery": "desktopDelivery",
  "--chatgpt-desktop-test": "chatgptDesktopTest",
  "--claude-desktop-test": "claudeDesktopTest",
  "--claude-code-desktop-test": "claudeCodeDesktopTest",
  "--leakage-sample": "leakageSample",
  "--audit-review": "auditReview",
};

export async function runRolloutManifestBuild(options: RolloutManifestBuildOptions): Promise<RolloutManifestBuildReport> {
  assertPermissionFreshnessConfirmed(options.permissionFreshnessEvidence);
  const candidate = normalizeCandidate(options.candidateMcpUrl, options.candidateCommit);
  const outputPath = options.outputPath ? resolve(options.outputPath) : undefined;
  const paths = normalizePaths(options.paths ?? {}, outputPath ? dirname(outputPath) : undefined);
  const manifest = buildManifest(paths, options.permissionFreshnessEvidence, candidate);

  if (outputPath) {
    if (!options.force && await exists(outputPath)) {
      throw new Error(`${outputPath} already exists; pass --force to overwrite it.`);
    }
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return { ok: true, manifestPath: outputPath, manifest };
  }

  return { ok: true, manifestPath: null, manifest };
}

export async function startRolloutManifestBuildCli(args: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseRolloutManifestBuildArgs(args);
  const report = await runRolloutManifestBuild(options);
  if (report.manifestPath) {
    process.stdout.write(`${JSON.stringify({ ok: true, manifestPath: report.manifestPath }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(report.manifest, null, 2)}\n`);
}

function buildManifest(
  paths: RolloutManifestEvidencePaths,
  permissionFreshnessEvidence: Required<RolloutManifestPermissionFreshnessOptions>,
  candidate: RolloutEvidenceManifest["candidate"]
): RolloutEvidenceManifest {
  return {
    version: 2,
    candidate,
    liveProbes: [
      { profile: "small_req_set", path: paths.smallReqProbe, strict: true, expectVisibleData: true },
      { profile: "many_req_set", path: paths.manyReqProbe, strict: true, expectVisibleData: true },
      { profile: "all_jobs_or_operator", path: paths.allJobsOrOperatorProbe, strict: true, expectVisibleData: true },
      { profile: "no_permissions", path: paths.noPermissionsProbe, strict: false, expectZeroVisibleJobs: true },
    ],
    distributionValidations: [
      { surface: "claude_desktop", client: "claude_desktop_chat", path: paths.claudeDistribution },
      { surface: "claude_desktop", client: "claude_code", path: paths.claudeCodeDistribution },
      { surface: "chatgpt_desktop", client: "chatgpt_codex_host", path: paths.chatgptDistribution },
    ],
    productionEnvEvidence: { path: paths.productionEnv },
    revocationDrillEvidence: [
      { surface: "claude_desktop", client: "claude_desktop_chat", path: paths.claudeRevocationDrill },
      { surface: "claude_desktop", client: "claude_code", path: paths.claudeCodeRevocationDrill },
      { surface: "chatgpt_desktop", client: "chatgpt_codex_host", path: paths.revocationDrill },
    ],
    sessionRevocationEvidence: [
      { surface: "claude_desktop", client: "claude_desktop_chat", path: paths.claudeSessionRevocation },
      { surface: "claude_desktop", client: "claude_code", path: paths.claudeCodeSessionRevocation },
      { surface: "chatgpt_desktop", client: "chatgpt_codex_host", path: paths.sessionRevocation },
    ],
    ...(paths.identityBootstrap ? { identityBootstrapEvidence: { path: paths.identityBootstrap } } : {}),
    rosterPreflightEvidence: { path: paths.rosterPreflight },
    sessionIssuanceEvidence: { path: paths.sessionIssuance },
    desktopConfigEvidence: { path: paths.desktopConfig },
    desktopDeliveryEvidence: { path: paths.desktopDelivery },
    desktopUserTests: [
      { surface: "claude_desktop", client: "claude_desktop_chat", path: paths.claudeDesktopTest },
      { surface: "claude_desktop", client: "claude_code", path: paths.claudeCodeDesktopTest },
      { surface: "chatgpt_desktop", client: "chatgpt_codex_host", path: paths.chatgptDesktopTest },
    ],
    permissionFreshnessEvidence,
    leakageSampleEvidence: { path: paths.leakageSample },
    auditReviewEvidence: { path: paths.auditReview },
  };
}

function normalizePaths(
  overrides: Partial<RolloutManifestEvidencePaths>,
  manifestBaseDir?: string
): RolloutManifestEvidencePaths {
  const paths = { ...DEFAULT_PATHS, ...overrides };
  const empty = Object.entries(paths)
    .filter(([, value]) => typeof value !== "string" || value.trim().length === 0)
    .map(([key]) => key);
  if (empty.length > 0) {
    throw new Error(`Evidence paths must be non-empty: ${empty.join(", ")}`);
  }
  if (!manifestBaseDir) return paths;

  const normalized: Partial<RolloutManifestEvidencePaths> = {};
  for (const [key, value] of Object.entries(paths) as Array<[keyof RolloutManifestEvidencePaths, string]>) {
    normalized[key] = normalizeEvidencePathForManifest(value, manifestBaseDir, key) as never;
  }
  return normalized as RolloutManifestEvidencePaths;
}

function normalizeEvidencePathForManifest(
  evidencePath: string,
  manifestBaseDir: string,
  key: keyof RolloutManifestEvidencePaths
): string {
  const trimmed = evidencePath.trim();
  const cwdResolved = resolve(trimmed);
  if (isInsidePath(manifestBaseDir, cwdResolved)) {
    return portableManifestRelativePath(manifestBaseDir, cwdResolved, key);
  }

  if (isAbsolute(trimmed)) {
    throw new Error(`Evidence path ${key} must be inside the rollout evidence directory: ${evidencePath}`);
  }

  const manifestResolved = resolve(manifestBaseDir, trimmed);
  if (!isInsidePath(manifestBaseDir, manifestResolved)) {
    throw new Error(`Evidence path ${key} must not escape the rollout evidence directory: ${evidencePath}`);
  }
  return portableManifestRelativePath(manifestBaseDir, manifestResolved, key);
}

function portableManifestRelativePath(manifestBaseDir: string, targetPath: string, key: keyof RolloutManifestEvidencePaths): string {
  const manifestRelative = relative(manifestBaseDir, targetPath);
  if (!manifestRelative || manifestRelative.startsWith("..") || isAbsolute(manifestRelative)) {
    throw new Error(`Evidence path ${key} must point to a file inside the rollout evidence directory.`);
  }
  return manifestRelative.split(sep).join("/");
}

function isInsidePath(baseDir: string, targetPath: string): boolean {
  const pathFromBase = relative(baseDir, targetPath);
  return pathFromBase === "" || (!pathFromBase.startsWith("..") && !isAbsolute(pathFromBase));
}

function assertPermissionFreshnessConfirmed(
  evidence: RolloutManifestPermissionFreshnessOptions
): asserts evidence is Required<RolloutManifestPermissionFreshnessOptions> {
  const missing = REQUIRED_PERMISSION_FLAGS.filter((key) => evidence[key] !== true)
    .map((key) => permissionFlagForKey(key));
  if (!isValidIsoTimestamp(evidence.verifiedAt)) missing.push("--permission-freshness-verified-at");
  if (!isNonEmptyString(evidence.verifiedBy)) missing.push("--permission-freshness-verified-by");
  if (!isPositiveInteger(evidence.removedReqId)) missing.push("--removed-req-id");
  if (!isPositiveInteger(evidence.removedReqRowsBeforeRemoval)) missing.push("--removed-req-rows-before");
  if (evidence.removedReqRowsAfterRemoval !== 0) missing.push("--removed-req-rows-after");
  if (!isPositiveInteger(evidence.addedReqId)) missing.push("--added-req-id");
  if (evidence.addedReqRowsBeforeAddition !== 0) missing.push("--added-req-rows-before");
  if (!isPositiveInteger(evidence.addedReqRowsAfterAddition)) missing.push("--added-req-rows-after");
  if (!isPositiveInteger(evidence.privateNoteId)) missing.push("--private-note-id");
  if (evidence.privateNoteRowsReturnedAfterScope !== 0) missing.push("--private-note-rows-returned");
  if (!isValidEmail(evidence.durableSessionEmail)) missing.push("--durable-session-email");
  if (!isRecruiterDesktopSurface(evidence.durableSessionSurface)) missing.push("--durable-session-surface");
  if (!isValidDurableSessionTokenId(evidence.durableSessionTokenId)) missing.push("--durable-session-token-id");
  if (!isValidDurableSessionTokenId(evidence.durableSessionTokenIdAfterRestart) || evidence.durableSessionTokenIdAfterRestart !== evidence.durableSessionTokenId) missing.push("--durable-session-token-id-after-restart");
  if (!isValidDurableSessionIssuedAt(evidence.durableSessionIssuedAt)) missing.push("--durable-session-issued-at");
  if (!isValidDurableSessionIssuedAt(evidence.durableSessionIssuedAtAfterRestart) || evidence.durableSessionIssuedAtAfterRestart !== evidence.durableSessionIssuedAt) missing.push("--durable-session-issued-at-after-restart");
  if (missing.length === 0) {
    evidence.routineReverificationPrompted = false;
    return;
  }
  throw new Error(`Permission freshness confirmations are required before building a final manifest: ${missing.join(", ")}`);
}

function permissionFlagForKey(key: keyof RolloutManifestPermissionFreshnessOptions): string {
  for (const [flag, value] of Object.entries(PERMISSION_FLAG_ARGS)) {
    if (value === key) return flag;
  }
  return key;
}

function isValidEmail(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized);
}

function isRecruiterDesktopSurface(value: unknown): value is "chatgpt_desktop" | "claude_desktop" {
  return value === "chatgpt_desktop" || value === "claude_desktop";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidIsoTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isValidDurableSessionTokenId(value: unknown): value is string {
  try {
    normalizeSessionTokenId(value);
    return true;
  } catch {
    return false;
  }
}

function isValidDurableSessionIssuedAt(value: unknown): value is string {
  try {
    normalizeSessionIssuedAt(value);
    return true;
  } catch {
    return false;
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function setPermissionFlag(
  evidence: RolloutManifestPermissionFreshnessOptions,
  key: keyof RolloutManifestPermissionFreshnessOptions
): void {
  switch (key) {
    case "removedReqDisappearedOnNextRead": evidence.removedReqDisappearedOnNextRead = true; break;
    case "addedReqAppearedWithoutDeploy": evidence.addedReqAppearedWithoutDeploy = true; break;
    case "privateNotesDropped": evidence.privateNotesDropped = true; break;
    case "scopedVsUnscopedLeakageSamplePassed": evidence.scopedVsUnscopedLeakageSamplePassed = true; break;
    case "durableAccessTestedWithoutRoutineReverification":
      evidence.durableAccessTestedWithoutRoutineReverification = true;
      evidence.routineReverificationPrompted = false;
      break;
  }
}

function setPermissionString(
  evidence: RolloutManifestPermissionFreshnessOptions,
  key: keyof RolloutManifestPermissionFreshnessOptions,
  value: string
): void {
  switch (key) {
    case "verifiedAt": evidence.verifiedAt = value; break;
    case "verifiedBy": evidence.verifiedBy = value; break;
    case "durableSessionEmail": evidence.durableSessionEmail = value.trim().toLowerCase(); break;
    case "durableSessionSurface":
      if (value === "chatgpt_desktop" || value === "claude_desktop") {
        evidence.durableSessionSurface = value;
      }
      break;
    case "durableSessionTokenId": evidence.durableSessionTokenId = value; break;
    case "durableSessionTokenIdAfterRestart": evidence.durableSessionTokenIdAfterRestart = value; break;
    case "durableSessionIssuedAt": evidence.durableSessionIssuedAt = value; break;
    case "durableSessionIssuedAtAfterRestart": evidence.durableSessionIssuedAtAfterRestart = value; break;
  }
}

function setPermissionNumber(
  evidence: RolloutManifestPermissionFreshnessOptions,
  key: keyof RolloutManifestPermissionFreshnessOptions,
  value: number
): void {
  switch (key) {
    case "removedReqId": evidence.removedReqId = value; break;
    case "removedReqRowsBeforeRemoval": evidence.removedReqRowsBeforeRemoval = value; break;
    case "removedReqRowsAfterRemoval": evidence.removedReqRowsAfterRemoval = value; break;
    case "addedReqId": evidence.addedReqId = value; break;
    case "addedReqRowsBeforeAddition": evidence.addedReqRowsBeforeAddition = value; break;
    case "addedReqRowsAfterAddition": evidence.addedReqRowsAfterAddition = value; break;
    case "privateNoteId": evidence.privateNoteId = value; break;
    case "privateNoteRowsReturnedAfterScope": evidence.privateNoteRowsReturnedAfterScope = value; break;
  }
}

export function parseRolloutManifestBuildArgs(args: string[]): RolloutManifestBuildOptions {
  const paths: Partial<RolloutManifestEvidencePaths> = {};
  const permissionFreshnessEvidence: RolloutManifestPermissionFreshnessOptions = {};
  let outputPath: string | undefined;
  let candidateMcpUrl: string | undefined;
  let candidateCommit: string | undefined;
  let force = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if ((arg === "--out" || arg === "-o") && args[index + 1]) {
      outputPath = args[index + 1]!;
      index += 1;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--candidate-mcp-url" && args[index + 1]) {
      candidateMcpUrl = args[index + 1]!;
      index += 1;
      continue;
    }
    if (arg === "--candidate-commit" && args[index + 1]) {
      candidateCommit = args[index + 1]!;
      index += 1;
      continue;
    }
    const permissionKey = PERMISSION_FLAG_ARGS[arg];
    if (permissionKey) {
      setPermissionFlag(permissionFreshnessEvidence, permissionKey);
      continue;
    }
    const permissionStringKey = PERMISSION_STRING_ARGS[arg];
    if (permissionStringKey && args[index + 1]) {
      setPermissionString(permissionFreshnessEvidence, permissionStringKey, args[index + 1]!);
      index += 1;
      continue;
    }
    const permissionNumberKey = PERMISSION_NUMBER_ARGS[arg];
    if (permissionNumberKey) {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error(`Missing value for ${arg}.`);
      }
      setPermissionNumber(permissionFreshnessEvidence, permissionNumberKey, readExactNonNegativeIntegerArg(arg, value));
      index += 1;
      continue;
    }
    const pathKey = PATH_ARGS[arg];
    if (pathKey && args[index + 1]) {
      paths[pathKey] = args[index + 1]!;
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${arg}`);
  }

  return { outputPath, force, paths, candidateMcpUrl, candidateCommit, permissionFreshnessEvidence };
}

function normalizeCandidate(mcpUrl: string | undefined, commit: string | undefined): RolloutEvidenceManifest["candidate"] {
  if (typeof mcpUrl !== "string") {
    throw new Error("--candidate-mcp-url is required.");
  }
  let parsed: URL;
  try {
    parsed = new URL(mcpUrl);
  } catch {
    throw new Error("--candidate-mcp-url must be an exact production HTTPS /mcp URL.");
  }
  const hostname = parsed.hostname.toLowerCase();
  const hostnameReason = classifyNonProductionHostname(hostname);
  if (parsed.protocol !== "https:"
    || parsed.pathname !== "/mcp"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || hostnameReason !== null) {
    throw new Error("--candidate-mcp-url must be an exact production HTTPS /mcp URL without credentials, query, or fragment.");
  }
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error("--candidate-commit must be an exact 40-character Git SHA.");
  }
  return { mcpUrl: parsed.toString(), commit: commit.toLowerCase() };
}

function readExactNonNegativeIntegerArg(flag: string, value: string): number {
  if (value.trim() !== value || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${flag} must be an exact non-negative integer.`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${flag} must be a safe non-negative integer.`);
  }
  return parsed;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startRolloutManifestBuildCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[greenhouse-recruiter-build-rollout-manifest] ${message}\n`);
    process.exit(1);
  });
}
