import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecruiterClient, normalizeSessionIssuedAt, normalizeSessionTokenId } from "./auth.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE_SOURCE = resolve(PACKAGE_ROOT, "assets", "claude-mcpb", "server", "index.mjs");

interface ClaudeSessionFile {
  email: string;
  subject: string;
  surface: "claude_desktop";
  client: "claude_desktop_chat";
  tokenId: string;
  issuedAt: string;
  token: string;
}

export interface BuildClaudeMcpbOptions {
  issuedSessionFile: string;
  mcpUrl: string;
  outputDir: string;
  serverName?: string;
}

export interface ClaudeMcpbReport {
  ok: true;
  outputDir: ".";
  manifestPath: "manifest.json";
  fileCount: 1;
  configFilesContainTokens: true;
  artifactsContainTokens: true;
  warning: string;
  surface: "claude_desktop";
  client: "claude_desktop_chat";
  tokenId: string;
  issuedAt: string;
  artifactPath: string;
  artifactSha256: string;
  artifactContainsToken: true;
  metadataContainsToken: false;
  files: Array<{
    email: string;
    surface: "claude_desktop";
    client: "claude_desktop_chat";
    subject: string;
    tokenId: string;
    issuedAt: string;
    path: string;
  }>;
}

export async function buildClaudeMcpb(options: BuildClaudeMcpbOptions): Promise<ClaudeMcpbReport> {
  const session = parseClaudeSession(JSON.parse(await readFile(resolve(options.issuedSessionFile), "utf8")) as unknown);
  const mcpUrl = normalizeProductionUrl(options.mcpUrl);
  const outputDir = resolve(options.outputDir);
  const serverName = normalizeServerName(options.serverName ?? "greenhouse-recruiter");
  const slug = safeSegment(session.email);
  const artifactName = `${slug}--greenhouse-recruiter.mcpb`;
  const artifactPath = join(outputDir, artifactName);
  const reportPath = join(outputDir, "manifest.json");
  await mkdir(outputDir, { recursive: true, mode: DIR_MODE });
  await chmod(outputDir, DIR_MODE);
  await refuseOverwrite([artifactPath, reportPath]);

  const stage = await mkdtemp(join(tmpdir(), "greenhouse-claude-mcpb-"));
  await chmod(stage, DIR_MODE);
  const temporaryArtifact = `${artifactPath}.tmp-${process.pid}.zip`;
  try {
    const serverDir = join(stage, "server");
    await mkdir(serverDir, { mode: DIR_MODE });
    const bridgePath = join(serverDir, "index.mjs");
    const metaPath = join(stage, "esbuild-meta.json");
    run(esbuildBinary(), [
      BRIDGE_SOURCE, "--bundle", "--platform=node", "--format=esm", "--target=node18",
      `--metafile=${metaPath}`, `--outfile=${bridgePath}`,
    ], PACKAGE_ROOT, "Could not bundle the Claude Desktop bridge.");
    await chmod(bridgePath, FILE_MODE);

    const extensionManifest = {
      $schema: "https://raw.githubusercontent.com/anthropics/mcpb/main/schemas/mcpb-manifest-v0.4.schema.json",
      manifest_version: "0.4",
      name: safeMcpbName(serverName),
      display_name: "Greenhouse Recruiting Assistant",
      version: "1.0.0",
      description: "Read-only, recruiter-scoped Greenhouse evidence and analysis.",
      long_description: "Private pilot extension connecting Claude Desktop to the hosted recruiter-scoped Greenhouse MCP.",
      author: { name: "Talent Operations" },
      server: {
        type: "node",
        entry_point: "server/index.mjs",
        mcp_config: {
          command: "node",
          args: ["${__dirname}/server/index.mjs"],
          env: {
            GREENHOUSE_RECRUITER_REMOTE_MCP_URL: mcpUrl,
            GREENHOUSE_RECRUITER_REMOTE_AUTH_TOKEN: session.token,
            GREENHOUSE_RECRUITER_EXPECTED_EMAIL: session.email,
            GREENHOUSE_RECRUITER_EXPECTED_TOKEN_ID: session.tokenId,
            GREENHOUSE_RECRUITER_EXPECTED_ISSUED_AT: session.issuedAt,
          },
        },
      },
      tools_generated: true,
      keywords: ["greenhouse", "recruiting", "read-only"],
      compatibility: { claude_desktop: ">=1.0.0", platforms: ["darwin"], runtimes: { node: ">=18.0.0" } },
    };
    await writeSecureJson(join(stage, "manifest.json"), extensionManifest);
    await writeSecureJson(join(stage, "provenance.json"), {
      schemaVersion: 1,
      surface: session.surface,
      client: session.client,
      tokenId: session.tokenId,
      issuedAt: session.issuedAt,
      bridgeSha256: await sha256(bridgePath),
      artifactContainsToken: true,
      metadataContainsToken: false,
    });
    await writeSecure(join(stage, "README.md"), "# Greenhouse Recruiting Assistant\n\nPrivate read-only Claude Desktop bridge for the recruiter-scoped Greenhouse MCP.\n");
    await writeSecure(join(stage, "THIRD_PARTY_NOTICES.txt"), await buildThirdPartyNotices(metaPath));
    await rm(metaPath, { force: true });

    run("zip", ["-X", "-q", "-r", temporaryArtifact, "."], stage, "Could not package the Claude Desktop extension.");
    await chmod(temporaryArtifact, FILE_MODE);
    const entries = run("unzip", ["-Z1", temporaryArtifact], outputDir, "Could not validate the Claude Desktop extension.").stdout.trim().split(/\r?\n/);
    for (const required of ["manifest.json", "provenance.json", "server/index.mjs", "README.md", "THIRD_PARTY_NOTICES.txt"]) {
      if (!entries.includes(required)) throw new Error(`Claude Desktop extension is missing ${required}.`);
    }
    await rename(temporaryArtifact, artifactPath);
    await chmod(artifactPath, FILE_MODE);
    const report: ClaudeMcpbReport = {
      ok: true,
      outputDir: ".",
      manifestPath: "manifest.json",
      fileCount: 1,
      configFilesContainTokens: true,
      artifactsContainTokens: true,
      warning: "The .mcpb contains one user's durable recruiter credential. Deliver only to that user and revoke by token id if exposed.",
      surface: "claude_desktop",
      client: "claude_desktop_chat",
      tokenId: session.tokenId,
      issuedAt: session.issuedAt,
      artifactPath: artifactName,
      artifactSha256: await sha256(artifactPath),
      artifactContainsToken: true,
      metadataContainsToken: false,
      files: [{
        email: session.email,
        surface: "claude_desktop",
        client: "claude_desktop_chat",
        subject: session.subject,
        tokenId: session.tokenId,
        issuedAt: session.issuedAt,
        path: artifactName,
      }],
    };
    await writeSecureJson(reportPath, report);
    return report;
  } catch (error) {
    await rm(temporaryArtifact, { force: true });
    await rm(artifactPath, { force: true });
    await rm(reportPath, { force: true });
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function startClaudeMcpbCli(args: string[] = process.argv.slice(2)): Promise<void> {
  try {
    const values = parseArgs(args);
    const report = await buildClaudeMcpb({
      issuedSessionFile: required(values, "issued-session-file"),
      mcpUrl: required(values, "mcp-url"),
      outputDir: required(values, "out-dir"),
      serverName: values.get("server-name"),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[greenhouse-recruiter-claude-mcpb] ${message}\n`);
    process.exitCode = 1;
  }
}

function parseClaudeSession(value: unknown): ClaudeSessionFile {
  if (!isRecord(value)) throw new Error("Issued session file must be a JSON object.");
  const email = typeof value.email === "string" ? value.email.trim().toLowerCase() : "";
  const subject = typeof value.subject === "string" ? value.subject : "";
  const client = value.client;
  if (!email || subject !== `email:${email}` || value.surface !== "claude_desktop" ||
      !isRecruiterClient(client) || client !== "claude_desktop_chat") {
    throw new Error("Issued session must be bound to the claude_desktop_chat client.");
  }
  const tokenId = normalizeSessionTokenId(value.tokenId);
  const issuedAt = normalizeSessionIssuedAt(value.issuedAt);
  if (typeof value.token !== "string" || value.token.trim() !== value.token || value.token.length < 32) {
    throw new Error("Issued session contains a malformed credential.");
  }
  const claims = decodeClaims(value.token);
  if (claims.email !== email || claims.subject !== subject || claims.surface !== value.surface ||
      claims.client !== client || claims.tokenId !== tokenId || claims.issuedAt !== issuedAt) {
    throw new Error("Issued session metadata does not match its signed claims.");
  }
  return { email, subject, surface: "claude_desktop", client, tokenId, issuedAt, token: value.token };
}

function decodeClaims(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("Issued session contains a malformed credential.");
  try {
    const claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as unknown;
    if (!isRecord(claims)) throw new Error("bad claims");
    return claims;
  } catch {
    throw new Error("Issued session contains a malformed credential.");
  }
}

async function buildThirdPartyNotices(metaPath: string): Promise<string> {
  const meta = JSON.parse(await readFile(metaPath, "utf8")) as { inputs?: Record<string, unknown> };
  const packageNames = new Set<string>();
  for (const input of Object.keys(meta.inputs ?? {})) {
    const match = input.match(/node_modules\/(?:(@[^/]+)\/([^/]+)|([^/]+))\//);
    if (match) packageNames.add(match[1] ? `${match[1]}/${match[2]}` : match[3]!);
  }
  const sections = ["Third-party notices for the Greenhouse Recruiting Assistant bridge."];
  for (const name of [...packageNames].sort()) {
    const packageDir = await findPackageDir(name);
    const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as { name: string; version: string; license?: string };
    const licenseName = (await readdir(packageDir)).find((entry) => /^licen[cs]e(?:\.|$)/i.test(entry));
    sections.push(`\n===== ${manifest.name} ${manifest.version} (${manifest.license ?? "license unspecified"}) =====`);
    if (licenseName) sections.push((await readFile(join(packageDir, licenseName), "utf8")).trim());
  }
  return `${sections.join("\n")}\n`;
}

async function findPackageDir(name: string): Promise<string> {
  for (const root of [join(PACKAGE_ROOT, "node_modules"), join(dirname(PACKAGE_ROOT), "node_modules"), join(dirname(dirname(PACKAGE_ROOT)), "node_modules")]) {
    const candidate = join(root, ...name.split("/"));
    try { await access(join(candidate, "package.json")); return candidate; } catch { /* try parent */ }
  }
  throw new Error(`Could not locate license metadata for ${name}.`);
}

function esbuildBinary(): string {
  for (const candidate of [join(PACKAGE_ROOT, "node_modules", ".bin", "esbuild"), join(dirname(PACKAGE_ROOT), "node_modules", ".bin", "esbuild"), join(dirname(dirname(PACKAGE_ROOT)), "node_modules", ".bin", "esbuild")]) {
    try { if (spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0) return candidate; } catch { /* try parent */ }
  }
  throw new Error("The workspace esbuild binary is unavailable.");
}

function run(command: string, args: string[], cwd: string, errorMessage: string): { stdout: string } {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(errorMessage);
  return { stdout: result.stdout ?? "" };
}

function normalizeProductionUrl(value: string): string {
  if (value.trim() !== value) throw new Error("Remote MCP URL must not contain surrounding whitespace.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Remote MCP URL must use HTTPS.");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1" || host.startsWith("127.")) {
    throw new Error("Remote MCP URL must use a production host.");
  }
  return url.toString();
}

function normalizeServerName(value: string): string {
  const name = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]{2,63}$/.test(name)) throw new Error("MCP server name is invalid.");
  return name;
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) throw new Error("Cannot derive an artifact name from the issued session.");
  return safe.slice(0, 80);
}

function safeMcpbName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 64);
}

async function refuseOverwrite(paths: string[]): Promise<void> {
  for (const path of paths) {
    try { await access(path); throw new Error("Refusing to overwrite an existing Claude Desktop artifact."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

async function writeSecureJson(path: string, value: unknown): Promise<void> {
  await writeSecure(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeSecure(path: string, value: string): Promise<void> {
  await writeFile(path, value, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
  await chmod(path, FILE_MODE);
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function parseArgs(args: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg?.startsWith("--") && next && !next.startsWith("--")) { values.set(arg.slice(2), next); index += 1; }
  }
  return values;
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key)?.trim();
  if (!value) throw new Error(`--${key} is required.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.url === `file://${process.argv[1]}`) void startClaudeMcpbCli();
