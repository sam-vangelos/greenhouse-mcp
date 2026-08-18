import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isClientSurfaceCompatible, isRecruiterClient, normalizeSessionIssuedAt, normalizeSessionTokenId } from "./auth.js";
import { containsTokenOrConfigPayload } from "./evidence-hygiene.js";
import { PILOT_TOOL_NAMES } from "./tools/register.js";
import type { RecruiterClient } from "./types.js";

export type DesktopConfigSurface = "claude_desktop" | "chatgpt_desktop";

export interface DesktopConfigOptions {
  surface: DesktopConfigSurface;
  client?: RecruiterClient;
  mcpUrl: string;
  token: string;
  serverName?: string;
  serverDescription?: string;
  requireApproval?: "always" | "never";
  includeAllowedTools?: boolean;
}

export interface DesktopConfigReport {
  surface: DesktopConfigSurface;
  client?: RecruiterClient;
  serverName: string;
  mcpUrl: string;
  sensitive: true;
  warning: string;
  config: unknown;
}

export interface IssuedDesktopSessionInput {
  email: string;
  surface: DesktopConfigSurface;
  client?: RecruiterClient;
  token: string;
  tokenId?: string;
  subject?: string;
  issuedAt?: string;
}

export interface DesktopConfigBatchOptions extends Omit<DesktopConfigOptions, "surface" | "token"> {
  issuedSessions: IssuedDesktopSessionInput[];
  sourceOk?: boolean;
  deniedCount?: number;
}

export interface DesktopConfigBatchEntry extends DesktopConfigReport {
  email: string;
  client?: RecruiterClient;
  tokenId?: string;
  subject?: string;
  issuedAt?: string;
}

export interface DesktopConfigBatchReport {
  ok: true;
  sensitive: true;
  warning: string;
  mcpUrl: string;
  serverName: string;
  configCount: number;
  configs: DesktopConfigBatchEntry[];
}

export interface DesktopConfigFileManifestEntry {
  email: string;
  surface: DesktopConfigSurface;
  client?: RecruiterClient;
  tokenId?: string;
  subject?: string;
  issuedAt?: string;
  path: string;
}

export interface DesktopConfigFileManifest {
  ok: true;
  outputDir: string;
  manifestPath: string;
  fileCount: number;
  containsTokens: false;
  configFilesContainTokens: true;
  artifactsContainTokens?: true;
  artifactContainsToken?: true;
  metadataContainsToken?: false;
  warning: string;
  files: DesktopConfigFileManifestEntry[];
}

const DEFAULT_SERVER_NAME = "greenhouse-recruiter";
const DEFAULT_SERVER_DESCRIPTION = "Recruiter-scoped Greenhouse read and analysis tools.";
const SENSITIVE_DIR_MODE = 0o700;
const SENSITIVE_FILE_MODE = 0o600;
const SENSITIVE_ARTIFACT_EXISTS_MESSAGE = "Refusing to overwrite existing sensitive recruiter artifact; choose an empty output directory.";

export function generateDesktopConfig(options: DesktopConfigOptions): DesktopConfigReport {
  if (options.client !== undefined && !isClientSurfaceCompatible(options.client, options.surface)) {
    throw new Error("Desktop config client does not match its protocol surface.");
  }
  const serverName = normalizeServerName(options.serverName ?? DEFAULT_SERVER_NAME);
  const mcpUrl = normalizeUrl(options.mcpUrl);
  const token = normalizeToken(options.token);
  if (options.surface === "claude_desktop" && options.client !== "claude_code") {
    throw new Error("Claude Desktop does not load remote {url, headers} MCP entries. Generate a personalized .mcpb with greenhouse-recruiter-claude-mcpb instead.");
  }
  const includeAllowedTools = options.includeAllowedTools ?? true;
  const toolNames = [...PILOT_TOOL_NAMES];
  const config = options.client === "claude_code" ? claudeCodeRemoteMcpConfig({
    serverName,
    mcpUrl,
    token,
  }) : chatGptRemoteMcpConfig({
        serverName,
        serverDescription: options.serverDescription ?? DEFAULT_SERVER_DESCRIPTION,
        mcpUrl,
        token,
        requireApproval: options.requireApproval ?? "always",
        allowedTools: includeAllowedTools ? toolNames : undefined,
    });
  return {
    surface: options.surface,
    client: options.client,
    serverName,
    mcpUrl,
    sensitive: true,
    warning: "This config contains a durable recruiter MCP session token. Distribute only to the intended user and revoke by token id if exposed.",
    config,
  };
}

export function generateDesktopConfigBatchFromIssuedSessions(
  options: DesktopConfigBatchOptions
): DesktopConfigBatchReport {
  if (options.sourceOk === false || (options.deniedCount ?? 0) > 0) {
    throw new Error("Issued-session report contains denied rows; fix them before generating desktop configs.");
  }
  const issuedSessions = options.client === undefined
    ? options.issuedSessions
    : options.issuedSessions.filter((issued) => issued.client === options.client);
  if (issuedSessions.length === 0) {
    throw new Error("Issued-session report contains no issued sessions.");
  }

  const configs = issuedSessions.map((issued) => {
    const tokenId = issued.tokenId === undefined ? undefined : normalizeSessionTokenId(issued.tokenId);
    const issuedAt = issued.issuedAt === undefined ? undefined : normalizeSessionIssuedAt(issued.issuedAt);
    const report = generateDesktopConfig({
      surface: issued.surface,
      client: issued.client,
      mcpUrl: options.mcpUrl,
      token: issued.token,
      serverName: options.serverName,
      serverDescription: options.serverDescription,
      requireApproval: options.requireApproval,
      includeAllowedTools: options.includeAllowedTools,
    });
    return {
      ...report,
      email: normalizeEmailForReport(issued.email),
      client: issued.client,
      tokenId,
      subject: issued.subject,
      issuedAt,
    };
  });

  return {
    ok: true,
    sensitive: true,
    warning: "This batch contains durable recruiter MCP session tokens. Split and distribute only each user's own config; revoke by token id if exposed.",
    mcpUrl: configs[0]!.mcpUrl,
    serverName: configs[0]!.serverName,
    configCount: configs.length,
    configs,
  };
}

export async function generateDesktopConfigBatchFromIssuedSessionsFile(
  path: string,
  options: Omit<DesktopConfigBatchOptions, "issuedSessions" | "sourceOk" | "deniedCount">
): Promise<DesktopConfigBatchReport> {
  const source = await readIssuedSessionSource(path);
  return generateDesktopConfigBatchFromIssuedSessions({
    ...options,
    issuedSessions: source.issuedSessions,
    sourceOk: source.sourceOk,
    deniedCount: source.deniedCount,
  });
}

export async function writeDesktopConfigBatchFiles(
  report: DesktopConfigBatchReport,
  outputDir: string
): Promise<DesktopConfigFileManifest> {
  const resolvedOutputDir = resolve(outputDir);
  await mkdir(resolvedOutputDir, { recursive: true, mode: SENSITIVE_DIR_MODE });
  await chmod(resolvedOutputDir, SENSITIVE_DIR_MODE);
  const usedFilenames = new Set<string>();
  const files: DesktopConfigFileManifestEntry[] = [];
  const writes: Array<{ path: string; value: unknown }> = [];

  for (const entry of report.configs) {
    const filename = uniqueFilename(
      `${safeFileSegment(entry.email)}--${safeFileSegment(entry.client ?? entry.surface)}.json`,
      usedFilenames
    );
    const path = resolve(resolvedOutputDir, filename);
    writes.push({ path, value: entry.config });
    files.push({
      email: entry.email,
      surface: entry.surface,
      client: entry.client,
      tokenId: entry.tokenId,
      subject: entry.subject,
      issuedAt: entry.issuedAt,
      path: filename,
    });
  }

  const manifestPath = resolve(resolvedOutputDir, "manifest.json");
  const manifest: DesktopConfigFileManifest = {
    ok: true,
    outputDir: ".",
    manifestPath: "manifest.json",
    fileCount: files.length,
    containsTokens: false,
    configFilesContainTokens: true,
    warning: "Manifest omits durable tokens, but each generated config file contains one recruiter's durable MCP token. Distribute each file only to its intended user.",
    files,
  };
  await assertSensitiveArtifactPathsDoNotExist([...writes.map((entry) => entry.path), manifestPath]);
  for (const write of writes) {
    await writeSensitiveJsonFile(write.path, write.value);
  }
  await writeSensitiveJsonFile(manifestPath, manifest);
  return manifest;
}

export async function mergeDesktopConfigManifests(
  manifestPaths: string[],
  outputDir: string
): Promise<DesktopConfigFileManifest> {
  if (manifestPaths.length === 0) {
    throw new Error("At least one --merge-manifest path is required.");
  }
  const resolvedOutputDir = resolve(outputDir);
  await mkdir(resolvedOutputDir, { recursive: true, mode: SENSITIVE_DIR_MODE });
  await chmod(resolvedOutputDir, SENSITIVE_DIR_MODE);
  const outputManifestPath = resolve(resolvedOutputDir, "manifest.json");
  await assertSensitiveArtifactPathsDoNotExist([outputManifestPath]);

  const files: DesktopConfigFileManifestEntry[] = [];
  const identities = new Set<string>();
  for (const manifestPath of manifestPaths) {
    const resolvedManifestPath = resolve(manifestPath);
    if (!isPathInside(resolvedOutputDir, resolvedManifestPath) || resolvedManifestPath === outputManifestPath) {
      throw new Error("Merged manifests and their artifacts must be inside --out-dir subdirectories.");
    }
    const value = JSON.parse(await readFile(resolvedManifestPath, "utf8")) as unknown;
    const source = await parseTokenFreeArtifactManifest(value, resolvedManifestPath, resolvedOutputDir);
    for (const file of source.files) {
      const identity = `${file.email}:${file.client}`;
      if (identities.has(identity)) {
        throw new Error(`Duplicate desktop artifact for ${identity}.`);
      }
      identities.add(identity);
      files.push(file);
    }
  }

  const requiredClients: RecruiterClient[] = ["claude_desktop_chat", "claude_code", "chatgpt_codex_host"];
  const emails = [...new Set(files.map((file) => file.email))];
  for (const email of emails) {
    const missing = requiredClients.filter((client) => !identities.has(`${email}:${client}`));
    if (missing.length > 0) {
      throw new Error(`Desktop artifact manifests are missing required clients for ${email}: ${missing.join(", ")}.`);
    }
  }
  const clientOrder = new Map(requiredClients.map((client, index) => [client, index]));
  files.sort((left, right) => left.email.localeCompare(right.email)
    || (clientOrder.get(left.client!) ?? 99) - (clientOrder.get(right.client!) ?? 99));

  const manifest: DesktopConfigFileManifest = {
    ok: true,
    outputDir: ".",
    manifestPath: "manifest.json",
    fileCount: files.length,
    containsTokens: false,
    configFilesContainTokens: true,
    artifactsContainTokens: true,
    artifactContainsToken: true,
    metadataContainsToken: false,
    warning: "Manifest metadata is token-free, but every referenced client artifact contains one recruiter's durable MCP token. Deliver each artifact only to its intended user.",
    files,
  };
  await writeSensitiveJsonFile(outputManifestPath, manifest);
  return manifest;
}

async function parseTokenFreeArtifactManifest(
  value: unknown,
  manifestPath: string,
  combinedOutputDir: string
): Promise<{ files: DesktopConfigFileManifestEntry[] }> {
  if (!isRecord(value)
    || value.ok !== true
    || value.configFilesContainTokens !== true
    || !Array.isArray(value.files)
    || value.files.length === 0
    || containsTokenOrConfigPayload(value)) {
    throw new Error("Merged artifact manifests must be passing, token-free metadata that marks referenced artifacts as token-bearing.");
  }
  const metadataTokenFree = value.containsTokens === false || value.metadataContainsToken === false;
  if (!metadataTokenFree || value.outputDir !== "." || value.manifestPath !== "manifest.json") {
    throw new Error("Merged artifact manifests must use token-free, portable manifest metadata.");
  }
  const manifestDir = dirname(manifestPath);
  if (resolvePortableManifestPath(manifestDir, value.manifestPath) !== manifestPath) {
    throw new Error("Merged artifact manifest path metadata must point to the manifest being read.");
  }

  const files: DesktopConfigFileManifestEntry[] = [];
  for (const rawFile of value.files) {
    if (!isRecord(rawFile)
      || typeof rawFile.email !== "string"
      || typeof rawFile.surface !== "string"
      || !isRecruiterClient(rawFile.client)
      || typeof rawFile.subject !== "string"
      || typeof rawFile.tokenId !== "string"
      || typeof rawFile.issuedAt !== "string"
      || typeof rawFile.path !== "string") {
      throw new Error("Merged artifact manifest contains an incomplete file entry.");
    }
    const email = normalizeEmailForReport(rawFile.email);
    const surface = parseSurface(rawFile.surface);
    if (!surface || !isClientSurfaceCompatible(rawFile.client, surface)) {
      throw new Error("Merged artifact manifest contains an invalid client identity for its surface.");
    }
    const subject = rawFile.subject.trim();
    if (subject !== `email:${email}`) {
      throw new Error("Merged artifact manifest subject must match its normalized recruiter email.");
    }
    const tokenId = normalizeSessionTokenId(rawFile.tokenId);
    const issuedAt = normalizeSessionIssuedAt(rawFile.issuedAt);
    const artifactPath = resolvePortableManifestPath(manifestDir, rawFile.path);
    if (!isPathInside(combinedOutputDir, artifactPath)) {
      throw new Error("Merged artifact paths must remain inside --out-dir.");
    }
    if (!(await pathExists(artifactPath))) {
      throw new Error("Merged artifact manifest references a missing client artifact.");
    }
    if (rawFile.path.endsWith(".mcpb") && (value.artifactContainsToken !== true || value.metadataContainsToken !== false)) {
      throw new Error("Claude Desktop MCPB metadata must distinguish a token-bearing artifact from token-free metadata.");
    }
    const combinedRelativePath = relative(combinedOutputDir, artifactPath);
    files.push({
      email,
      surface,
      client: rawFile.client,
      subject,
      tokenId,
      issuedAt,
      path: combinedRelativePath.split(sep).join("/"),
    });
  }
  return { files };
}

function isPathInside(baseDir: string, targetPath: string): boolean {
  const pathFromBase = relative(baseDir, targetPath);
  return pathFromBase === "" || (!pathFromBase.startsWith("..") && !isAbsolute(pathFromBase));
}

async function writeSensitiveJsonFile(path: string, value: unknown): Promise<void> {
  try {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: SENSITIVE_FILE_MODE, flag: "wx" });
  } catch (error) {
    if (isPathExistsError(error)) {
      throw new Error(SENSITIVE_ARTIFACT_EXISTS_MESSAGE);
    }
    throw error;
  }
  await chmod(path, SENSITIVE_FILE_MODE);
}

async function assertSensitiveArtifactPathsDoNotExist(paths: string[]): Promise<void> {
  for (const path of paths) {
    if (await pathExists(path)) {
      throw new Error(SENSITIVE_ARTIFACT_EXISTS_MESSAGE);
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isPathExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

export function generateDesktopConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv.slice(2)
): DesktopConfigReport {
  const parsed = parseArgs(args);
  const surface = parseSurface(parsed.surface ?? env.GREENHOUSE_RECRUITER_DESKTOP_SURFACE);
  const mcpUrl = parsed.mcpUrl ?? env.GREENHOUSE_RECRUITER_REMOTE_MCP_URL;
  const token = parsed.token ?? env.GREENHOUSE_RECRUITER_REMOTE_AUTH_TOKEN ?? env.GREENHOUSE_RECRUITER_SESSION_TOKEN;
  if (!surface) {
    throw new Error("--surface or GREENHOUSE_RECRUITER_DESKTOP_SURFACE is required: claude_desktop|chatgpt_desktop");
  }
  if (!mcpUrl) {
    throw new Error("--mcp-url or GREENHOUSE_RECRUITER_REMOTE_MCP_URL is required.");
  }
  if (!token) {
    throw new Error("--token, GREENHOUSE_RECRUITER_REMOTE_AUTH_TOKEN, or GREENHOUSE_RECRUITER_SESSION_TOKEN is required.");
  }
  return generateDesktopConfig({
    surface,
    client: parseClient(parsed.client ?? env.GREENHOUSE_RECRUITER_CLIENT),
    mcpUrl,
    token,
    serverName: parsed.serverName ?? env.GREENHOUSE_RECRUITER_DESKTOP_SERVER_NAME,
    serverDescription: parsed.serverDescription ?? env.GREENHOUSE_RECRUITER_DESKTOP_SERVER_DESCRIPTION,
    requireApproval: parseRequireApproval(parsed.requireApproval ?? env.GREENHOUSE_RECRUITER_CHATGPT_REQUIRE_APPROVAL),
    includeAllowedTools: parsed.includeAllowedTools,
  });
}

export async function startDesktopConfigCli(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv.slice(2)
): Promise<void> {
  try {
    const parsed = parseArgs(args);
    let report: DesktopConfigReport | DesktopConfigBatchReport | DesktopConfigFileManifest;
    if (parsed.mergeManifests.length > 0) {
      if (!parsed.outDir) {
        throw new Error("--merge-manifest requires --out-dir.");
      }
      if (parsed.issuedSessionsFile) {
        throw new Error("--merge-manifest cannot be combined with --issued-sessions-file.");
      }
      report = await mergeDesktopConfigManifests(parsed.mergeManifests, parsed.outDir);
    } else if (parsed.outDir) {
      if (!parsed.issuedSessionsFile) {
        throw new Error("--out-dir requires --issued-sessions-file.");
      }
      const batch = await generateDesktopConfigBatchFromIssuedSessionsFile(parsed.issuedSessionsFile, desktopOptionsFromParsedEnv(parsed, env));
      report = await writeDesktopConfigBatchFiles(batch, parsed.outDir);
    } else {
      report = parsed.issuedSessionsFile
        ? await generateDesktopConfigBatchFromIssuedSessionsFile(parsed.issuedSessionsFile, desktopOptionsFromParsedEnv(parsed, env))
        : generateDesktopConfigFromEnv(env, args);
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[greenhouse-recruiter-desktop-config] ${message}\n`);
    process.exitCode = 1;
  }
}

function chatGptRemoteMcpConfig(options: {
  serverName: string;
  serverDescription: string;
  mcpUrl: string;
  token: string;
  requireApproval: "always" | "never";
  allowedTools?: string[];
}): unknown {
  return {
    type: "mcp",
    server_label: options.serverName,
    server_description: options.serverDescription,
    server_url: options.mcpUrl,
    authorization: options.token,
    require_approval: options.requireApproval,
    ...(options.allowedTools ? { allowed_tools: options.allowedTools } : {}),
  };
}

function claudeCodeRemoteMcpConfig(options: {
  serverName: string;
  mcpUrl: string;
  token: string;
}): unknown {
  return {
    mcpServers: {
      [options.serverName]: {
        type: "http",
        url: options.mcpUrl,
        headers: { Authorization: `Bearer ${options.token}` },
      },
    },
  };
}

function parseArgs(args: string[]): {
  surface?: string;
  client?: string;
  mcpUrl?: string;
  token?: string;
  issuedSessionsFile?: string;
  mergeManifests: string[];
  outDir?: string;
  serverName?: string;
  serverDescription?: string;
  requireApproval?: string;
  includeAllowedTools?: boolean;
} {
  const values = new Map<string, string>();
  const mergeManifests: string[] = [];
  let includeAllowedTools: boolean | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--no-allowed-tools") {
      includeAllowedTools = false;
      continue;
    }
    if (arg === "--allowed-tools") {
      includeAllowedTools = true;
      continue;
    }
    if (arg === "--merge-manifest") {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("--merge-manifest requires a path.");
      }
      mergeManifests.push(next);
      index += 1;
      continue;
    }
    if (!arg?.startsWith("--")) continue;
    const next = args[index + 1];
    if (!next || next.startsWith("--")) continue;
    values.set(arg.slice(2), next);
    index += 1;
  }
  return {
    surface: values.get("surface"),
    client: values.get("client"),
    mcpUrl: values.get("mcp-url"),
    token: values.get("token"),
    issuedSessionsFile: values.get("issued-sessions-file"),
    mergeManifests,
    outDir: values.get("out-dir"),
    serverName: values.get("server-name"),
    serverDescription: values.get("server-description"),
    requireApproval: values.get("require-approval"),
    includeAllowedTools,
  };
}

function desktopOptionsFromParsedEnv(
  parsed: ReturnType<typeof parseArgs>,
  env: NodeJS.ProcessEnv
): Omit<DesktopConfigBatchOptions, "issuedSessions" | "sourceOk" | "deniedCount"> {
  const mcpUrl = parsed.mcpUrl ?? env.GREENHOUSE_RECRUITER_REMOTE_MCP_URL;
  if (!mcpUrl) {
    throw new Error("--mcp-url or GREENHOUSE_RECRUITER_REMOTE_MCP_URL is required.");
  }
  return {
    mcpUrl,
    client: parseClient(parsed.client ?? env.GREENHOUSE_RECRUITER_CLIENT),
    serverName: parsed.serverName ?? env.GREENHOUSE_RECRUITER_DESKTOP_SERVER_NAME,
    serverDescription: parsed.serverDescription ?? env.GREENHOUSE_RECRUITER_DESKTOP_SERVER_DESCRIPTION,
    requireApproval: parseRequireApproval(parsed.requireApproval ?? env.GREENHOUSE_RECRUITER_CHATGPT_REQUIRE_APPROVAL),
    includeAllowedTools: parsed.includeAllowedTools,
  };
}

async function readIssuedSessionSource(path: string): Promise<{
  issuedSessions: IssuedDesktopSessionInput[];
  sourceOk?: boolean;
  deniedCount: number;
}> {
  const resolvedPath = resolve(path);
  const value = JSON.parse(await readFile(resolvedPath, "utf8")) as unknown;
  if (isSplitSessionManifest(value)) {
    if (value.containsTokens !== false || value.sessionFilesContainTokens !== true) {
      throw new Error("Split session manifest must be token-free and mark session files as token-bearing.");
    }
    assertPortableSplitSessionManifestMetadata(value, resolvedPath);
    if (containsTokenOrConfigPayload(value)) {
      throw new Error("Split session manifest must not contain durable tokens or config payloads.");
    }
    const baseDir = dirname(resolvedPath);
    const issuedSessions: IssuedDesktopSessionInput[] = [];
    for (const file of value.files) {
      if (!isRecord(file)
        || typeof file.email !== "string"
        || typeof file.surface !== "string"
        || typeof file.subject !== "string"
        || typeof file.tokenId !== "string"
        || typeof file.issuedAt !== "string"
        || typeof file.path !== "string"
        || file.path.trim().length === 0) {
        throw new Error("Split session manifest contains an invalid file entry.");
      }
      let manifestTokenId: string;
      let manifestIssuedAt: string;
      try {
        manifestTokenId = normalizeSessionTokenId(file.tokenId);
        manifestIssuedAt = normalizeSessionIssuedAt(file.issuedAt);
      } catch {
        throw new Error("Split session manifest contains an invalid file entry.");
      }
      const sessionPath = resolvePortableManifestPath(baseDir, file.path);
      const issued = parseIssuedSessionInput(JSON.parse(await readFile(sessionPath, "utf8")) as unknown);
      if (normalizeEmailForReport(file.email) !== normalizeEmailForReport(issued.email)) {
        throw new Error("Split session manifest email does not match token file.");
      }
      if (file.surface !== issued.surface) {
        throw new Error("Split session manifest surface does not match token file.");
      }
      if (file.client !== undefined && file.client !== issued.client) {
        throw new Error("Split session manifest client does not match token file.");
      }
      if (file.subject !== issued.subject) {
        throw new Error("Split session manifest subject does not match token file.");
      }
      if (manifestTokenId !== issued.tokenId) {
        throw new Error("Split session manifest token id does not match token file.");
      }
      if (manifestIssuedAt !== issued.issuedAt) {
        throw new Error("Split session manifest issued-at timestamp does not match token file.");
      }
      issuedSessions.push(issued);
    }
    return {
      issuedSessions,
      sourceOk: value.ok === true,
      deniedCount: 0,
    };
  }

  if (!isRecord(value)) {
    throw new Error("Issued-session report must be a JSON object.");
  }
  const rawIssued = Array.isArray(value.issued) ? value.issued : [value];
  const issuedSessions = rawIssued.map(parseIssuedSessionInput);
  const deniedCount = Array.isArray(value.denied) ? value.denied.length : 0;
  return {
    issuedSessions,
    sourceOk: typeof value.ok === "boolean" ? value.ok : undefined,
    deniedCount,
  };
}

function isSplitSessionManifest(value: unknown): value is Record<string, unknown> & { files: unknown[] } {
  return isRecord(value)
    && Array.isArray(value.files)
    && value.sessionFilesContainTokens === true;
}

function assertPortableSplitSessionManifestMetadata(
  value: Record<string, unknown>,
  resolvedPath: string
): void {
  const baseDir = dirname(resolvedPath);
  if (value.outputDir !== ".") {
    throw new Error("Split session manifest must use portable relative paths under the manifest directory.");
  }
  if (typeof value.manifestPath !== "string") {
    throw new Error("Split session manifest must use portable relative paths under the manifest directory.");
  }
  const manifestPath = resolvePortableManifestPath(baseDir, value.manifestPath);
  if (manifestPath !== resolvedPath) {
    throw new Error("Split session manifest path metadata must point to the manifest file being read.");
  }
}

function resolvePortableManifestPath(baseDir: string, path: string): string {
  if (path.trim().length === 0 || path.trim() !== path || isAbsolute(path)) {
    throw new Error("Split session manifest must use portable relative paths under the manifest directory.");
  }
  const resolvedPath = resolve(baseDir, path);
  const relativePath = relative(baseDir, resolvedPath);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("Split session manifest must use portable relative paths under the manifest directory.");
  }
  return resolvedPath;
}

function parseIssuedSessionInput(value: unknown): IssuedDesktopSessionInput {
  if (!isRecord(value)) {
    throw new Error("Issued session entries must be JSON objects.");
  }
  if (typeof value.email !== "string" || value.email.trim().length === 0) {
    throw new Error("Issued session entry is missing email.");
  }
  const surface = parseSurface(typeof value.surface === "string" ? value.surface : undefined);
  if (!surface) {
    throw new Error("Issued session entry has invalid surface.");
  }
  const client = value.client === undefined ? undefined : value.client;
  if (client !== undefined && (!isRecruiterClient(client) || !isClientSurfaceCompatible(client, surface))) {
    throw new Error("Issued session entry has invalid client identity for surface.");
  }
  if (typeof value.token !== "string" || value.token.trim().length === 0) {
    throw new Error("Issued session entry is missing token.");
  }
  let issuedAt: string;
  try {
    issuedAt = normalizeSessionIssuedAt(value.issuedAt);
  } catch {
    throw new Error("Issued session entry is missing a valid issued-at timestamp.");
  }
  return {
    email: value.email,
    surface,
    client,
    token: normalizeToken(value.token),
    tokenId: value.tokenId === undefined ? undefined : normalizeSessionTokenId(value.tokenId),
    subject: typeof value.subject === "string" ? value.subject : undefined,
    issuedAt,
  };
}

function parseSurface(value: string | undefined): DesktopConfigSurface | undefined {
  if (value === "claude_desktop" || value === "chatgpt_desktop") return value;
  return undefined;
}

function parseClient(value: string | undefined): RecruiterClient | undefined {
  if (value === undefined) return undefined;
  if (isRecruiterClient(value)) return value;
  throw new Error("--client or GREENHOUSE_RECRUITER_CLIENT must be claude_desktop_chat, claude_code, or chatgpt_codex_host.");
}

function parseRequireApproval(value: string | undefined): "always" | "never" | undefined {
  if (value === "always" || value === "never") return value;
  return undefined;
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("Remote MCP URL must use https except for localhost validation.");
  }
  return url.toString();
}

function normalizeToken(value: string): string {
  if (value.trim().length === 0) {
    throw new Error("Desktop config token must be non-empty.");
  }
  if (value.trim() !== value) {
    throw new Error("Desktop config token must not contain leading or trailing whitespace.");
  }
  return value;
}

function normalizeEmailForReport(value: string): string {
  const email = value.trim().toLowerCase();
  if (!email) {
    throw new Error("Issued session entry is missing email.");
  }
  return email;
}

function normalizeServerName(value: string): string {
  const name = value.trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{2,63}$/.test(name)) {
    throw new Error("Desktop MCP server name must start with a letter and use 3-64 letters, numbers, underscores, or hyphens.");
  }
  return name;
}

function safeFileSegment(value: string): string {
  const safe = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) {
    throw new Error("Cannot derive desktop config filename from empty email.");
  }
  return safe.slice(0, 96);
}

function uniqueFilename(filename: string, usedFilenames: Set<string>): string {
  if (!usedFilenames.has(filename)) {
    usedFilenames.add(filename);
    return filename;
  }
  const suffixIndex = filename.lastIndexOf(".");
  const base = suffixIndex > 0 ? filename.slice(0, suffixIndex) : filename;
  const extension = suffixIndex > 0 ? filename.slice(suffixIndex) : "";
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}${extension}`;
    if (!usedFilenames.has(candidate)) {
      usedFilenames.add(candidate);
      return candidate;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startDesktopConfigCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[greenhouse-recruiter-desktop-config] ${message}\n`);
    process.exit(1);
  });
}
