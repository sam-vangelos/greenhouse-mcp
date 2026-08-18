import { chmod, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { normalizeSessionIssuedAt, normalizeSessionTokenId } from "./auth.js";
import { containsTokenOrConfigPayload } from "./evidence-hygiene.js";
import type { DesktopConfigFileManifest } from "./desktop-config.js";
import type { RecruiterClient } from "./types.js";

export const APPROVED_DESKTOP_DELIVERY_CHANNELS = [
  "managed_desktop_install",
  "mdm_profile",
  "endpoint_management",
  "secure_vault_delivery",
] as const;

export type ApprovedDesktopDeliveryChannel = typeof APPROVED_DESKTOP_DELIVERY_CHANNELS[number];

export interface DesktopDeliveryEntry {
  email: string;
  recipientEmail: string;
  surface: "claude_desktop" | "chatgpt_desktop";
  client?: RecruiterClient;
  tokenId: string;
  issuedAt: string;
  configPath: string;
  deliveryChannel: ApprovedDesktopDeliveryChannel;
  deliveredToMatchingRecruiter: true;
}

export interface DesktopDeliveryReport {
  ok: true;
  deliveredAt: string;
  deliveredBy: string;
  containsTokens: false;
  desktopConfigManifestPath: string;
  deliveryChannel: ApprovedDesktopDeliveryChannel;
  warning: string;
  deliveries: DesktopDeliveryEntry[];
}

export interface BuildDesktopDeliveryEvidenceOptions {
  desktopConfigManifestPath: string;
  reportPath?: string;
  deliveredBy: string;
  deliveryChannel: string;
  deliveredAt?: string;
  attestDeliveredToMatchingRecruiters: boolean;
  now?: () => number;
}

export async function buildDesktopDeliveryEvidenceFromManifestFile(
  options: BuildDesktopDeliveryEvidenceOptions
): Promise<DesktopDeliveryReport> {
  const manifestPath = resolveNonEmptyPath(options.desktopConfigManifestPath, "desktop config manifest path");
  const deliveredBy = normalizeNonEmptyString(options.deliveredBy, "deliveredBy");
  const deliveryChannel = normalizeDeliveryChannel(options.deliveryChannel);
  const deliveredAt = normalizeTimestamp(options.deliveredAt ?? new Date(options.now?.() ?? Date.now()).toISOString(), "deliveredAt");
  if (options.attestDeliveredToMatchingRecruiters !== true) {
    throw new Error("--attest-delivered-to-matching-recruiters is required to generate delivery evidence.");
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  assertTokenFreeDesktopConfigManifest(manifest);
  const typedManifest = manifest as DesktopConfigFileManifest;
  assertPortableDesktopConfigManifest(typedManifest, manifestPath);
  const manifestDir = dirname(manifestPath);
  const reportBaseDir = options.reportPath
    ? dirname(resolveNonEmptyPath(options.reportPath, "desktop delivery output path"))
    : manifestDir;
  const deliveries = typedManifest.files.map((file) => {
    if (!isRecord(file)) {
      throw new Error("Desktop config manifest contains a malformed file entry.");
    }
    const email = normalizeEmail(file.email, "desktop config email");
    const surface = normalizeSurface(file.surface);
    const tokenId = normalizeDurableTokenId(file.tokenId, "desktop config tokenId");
    const issuedAt = normalizeDurableIssuedAt(file.issuedAt, "desktop config issuedAt");
    const configPath = portableRelativePath(reportBaseDir, resolve(manifestDir, normalizeNonEmptyString(file.path, "desktop config path")), "desktop config path");
    return {
      email,
      recipientEmail: email,
      surface,
      client: file.client,
      tokenId,
      issuedAt,
      configPath,
      deliveryChannel,
      deliveredToMatchingRecruiter: true,
    } satisfies DesktopDeliveryEntry;
  });

  if (deliveries.length === 0) {
    throw new Error("Desktop config manifest contains no generated config files.");
  }

  return {
    ok: true,
    deliveredAt,
    deliveredBy,
    containsTokens: false,
    desktopConfigManifestPath: portableRelativePath(reportBaseDir, manifestPath, "desktop config manifest path"),
    deliveryChannel,
    warning: "Token-free delivery evidence. It records only metadata from the desktop config manifest; do not paste durable tokens, Authorization headers, or config payloads into this report.",
    deliveries,
  };
}

export async function writeDesktopDeliveryEvidenceFile(report: DesktopDeliveryReport, path: string): Promise<void> {
  const outputPath = resolveNonEmptyPath(path, "desktop delivery output path");
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(outputPath, 0o600);
}

export async function startDesktopDeliveryEvidenceCli(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv.slice(2)
): Promise<void> {
  try {
    const parsed = parseArgs(args);
    const report = await buildDesktopDeliveryEvidenceFromManifestFile({
      desktopConfigManifestPath: parsed.desktopConfigManifest ?? env.GREENHOUSE_RECRUITER_DESKTOP_CONFIG_MANIFEST ?? "",
      reportPath: parsed.out,
      deliveredBy: parsed.deliveredBy ?? env.GREENHOUSE_RECRUITER_DESKTOP_DELIVERED_BY ?? "",
      deliveryChannel: parsed.deliveryChannel ?? env.GREENHOUSE_RECRUITER_DESKTOP_DELIVERY_CHANNEL ?? "",
      deliveredAt: parsed.deliveredAt ?? env.GREENHOUSE_RECRUITER_DESKTOP_DELIVERED_AT,
      attestDeliveredToMatchingRecruiters: parsed.attestDeliveredToMatchingRecruiters,
    });
    if (parsed.out) {
      await writeDesktopDeliveryEvidenceFile(report, parsed.out);
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[greenhouse-recruiter-record-desktop-delivery] ${message}\n`);
    process.exitCode = 1;
  }
}

function parseArgs(args: string[]): {
  desktopConfigManifest?: string;
  deliveredBy?: string;
  deliveryChannel?: string;
  deliveredAt?: string;
  out?: string;
  attestDeliveredToMatchingRecruiters: boolean;
} {
  const values = new Map<string, string>();
  let attestDeliveredToMatchingRecruiters = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--attest-delivered-to-matching-recruiters") {
      attestDeliveredToMatchingRecruiters = true;
      continue;
    }
    if (!arg?.startsWith("--")) continue;
    const next = args[index + 1];
    if (!next || next.startsWith("--")) continue;
    values.set(arg.slice(2), next);
    index += 1;
  }
  return {
    desktopConfigManifest: values.get("desktop-config-manifest"),
    deliveredBy: values.get("delivered-by"),
    deliveryChannel: values.get("delivery-channel"),
    deliveredAt: values.get("delivered-at"),
    out: values.get("out"),
    attestDeliveredToMatchingRecruiters,
  };
}

function assertTokenFreeDesktopConfigManifest(value: unknown): asserts value is DesktopConfigFileManifest {
  if (!isRecord(value) || value.ok !== true) {
    throw new Error("Desktop config manifest must be an ok=true JSON object.");
  }
  if (value.containsTokens !== false || value.configFilesContainTokens !== true) {
    throw new Error("Desktop config manifest must be token-free and mark config files as token-bearing.");
  }
  if (containsTokenOrConfigPayload(value)) {
    throw new Error("Desktop config manifest must not contain durable tokens, Authorization headers, or config payloads.");
  }
  if (!Array.isArray(value.files)) {
    throw new Error("Desktop config manifest must contain a files array.");
  }
}

function assertPortableDesktopConfigManifest(
  value: DesktopConfigFileManifest,
  manifestPath: string
): void {
  const manifestDir = dirname(manifestPath);
  if (value.outputDir !== ".") {
    throw new Error("Desktop config manifest must use portable relative paths under the manifest directory.");
  }
  if (typeof value.manifestPath !== "string") {
    throw new Error("Desktop config manifest must use portable relative paths under the manifest directory.");
  }
  const manifestMetadataPath = resolvePortableManifestPath(manifestDir, value.manifestPath, "manifestPath");
  if (manifestMetadataPath !== manifestPath) {
    throw new Error("Desktop config manifest path metadata must point to the manifest file being read.");
  }
  for (const file of value.files) {
    if (!isRecord(file) || typeof file.path !== "string") {
      throw new Error("Desktop config manifest contains a malformed file entry.");
    }
    resolvePortableManifestPath(manifestDir, file.path, "desktop config path");
  }
}

function resolvePortableManifestPath(baseDir: string, path: string, field: string): string {
  if (path.trim().length === 0 || path.trim() !== path || isAbsolute(path)) {
    throw new Error(`${field} must use a portable relative path under the manifest directory.`);
  }
  const resolvedPath = resolve(baseDir, path);
  const relativePath = relative(baseDir, resolvedPath);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`${field} must use a portable relative path under the manifest directory.`);
  }
  return resolvedPath;
}

export function normalizeDeliveryChannel(value: unknown): ApprovedDesktopDeliveryChannel {
  const normalized = normalizeNonEmptyString(value, "deliveryChannel");
  if (APPROVED_DESKTOP_DELIVERY_CHANNELS.includes(normalized as ApprovedDesktopDeliveryChannel)) {
    return normalized as ApprovedDesktopDeliveryChannel;
  }
  throw new Error(`deliveryChannel must be one of: ${APPROVED_DESKTOP_DELIVERY_CHANNELS.join(", ")}.`);
}

function normalizeEmail(value: unknown, field: string): string {
  const normalized = normalizeNonEmptyString(value, field).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    throw new Error(`${field} must be a valid email.`);
  }
  return normalized;
}

function normalizeSurface(value: unknown): "claude_desktop" | "chatgpt_desktop" {
  if (value === "claude_desktop" || value === "chatgpt_desktop") return value;
  throw new Error("Desktop config surface must be claude_desktop or chatgpt_desktop.");
}

function normalizeTimestamp(value: unknown, field: string): string {
  const normalized = normalizeNonEmptyString(value, field);
  if (Number.isNaN(Date.parse(normalized))) {
    throw new Error(`${field} must be a valid timestamp.`);
  }
  return normalized;
}

function normalizeDurableTokenId(value: unknown, field: string): string {
  try {
    return normalizeSessionTokenId(value);
  } catch {
    throw new Error(`${field} must be a valid durable session token id.`);
  }
}

function normalizeDurableIssuedAt(value: unknown, field: string): string {
  try {
    return normalizeSessionIssuedAt(value);
  } catch {
    throw new Error(`${field} must be a canonical durable session issued-at timestamp.`);
  }
}

function resolveNonEmptyPath(value: unknown, field: string): string {
  return resolve(normalizeNonEmptyString(value, field));
}

function portableRelativePath(baseDir: string, targetPath: string, field: string): string {
  const relativePath = relative(baseDir, targetPath);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`${field} must stay under the desktop delivery report directory.`);
  }
  return relativePath.split(sep).join("/");
}

function normalizeNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startDesktopDeliveryEvidenceCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[greenhouse-recruiter-record-desktop-delivery] ${message}\n`);
    process.exit(1);
  });
}
