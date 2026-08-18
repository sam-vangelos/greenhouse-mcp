import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MIN_SESSION_SECRET_LENGTH, createSignedSessionToken, hasLeadingOrTrailingWhitespace, isClientSurfaceCompatible, isRecruiterClient, isStrongSessionSecret, normalizeSessionTokenId, surfaceForRecruiterClient } from "./auth.js";
import { createIdentityDirectoryFromEnv } from "./identity.js";
import { isSafePositiveGreenhouseUserId, type IdentityDirectory } from "./identity.js";
import type { AuthenticatedSession, RecruiterClient } from "./types.js";

const SENSITIVE_DIR_MODE = 0o700;
const SENSITIVE_FILE_MODE = 0o600;
const SENSITIVE_ARTIFACT_EXISTS_MESSAGE = "Refusing to overwrite existing sensitive recruiter artifact; choose an empty output directory.";

export type IssuableRecruiterSurface = "claude_desktop" | "chatgpt_desktop";

export const MANAGED_ROSTER_SOURCES = [
  "admin_managed_roster",
  "google_workspace_group",
  "okta_group",
  "hris_report",
  "greenhouse_users_export",
] as const;

export type ManagedRosterSource = typeof MANAGED_ROSTER_SOURCES[number];

export interface EmailSessionIssuerConfig {
  secret: string;
  allowedDomains: string[];
  now?: () => number;
  tokenId?: () => string;
}

export interface IssueVerifiedEmailSessionOptions {
  email: string;
  surface: IssuableRecruiterSurface;
  client?: RecruiterClient;
}

export interface IssuedEmailSession {
  email: string;
  session: AuthenticatedSession;
  token: string;
}

export interface IssueVerifiedEmailSessionBatchOptions {
  emails: string[];
  surfaces: IssuableRecruiterSurface[];
  clients?: RecruiterClient[];
}

export interface EmailRosterPreflightConfig {
  allowedDomains: string[];
  rosterSource?: string;
  verifiedBy?: string;
  now?: () => number;
}

export interface PreflightVerifiedEmailRosterOptions {
  emails: string[];
  surfaces: IssuableRecruiterSurface[];
}

export interface DeniedEmailSessionIssue {
  email: string;
  reason: string;
}

export interface IssuedEmailSessionBatch {
  ok: boolean;
  requestedEmailCount: number;
  requestedSurfaces: IssuableRecruiterSurface[];
  issued: IssuedEmailSession[];
  denied: DeniedEmailSessionIssue[];
}

export interface PreflightResolvedEmailRosterEntry {
  email: string;
  subject: string;
  greenhouseUserId: number;
  surfaces: IssuableRecruiterSurface[];
}

export interface PreflightVerifiedEmailRosterReport {
  ok: boolean;
  generatedAt: string;
  rosterSource: ManagedRosterSource;
  verifiedBy: string;
  requestedEmailCount: number;
  normalizedEmailCount: number;
  requestedSurfaces: IssuableRecruiterSurface[];
  resolved: PreflightResolvedEmailRosterEntry[];
  denied: DeniedEmailSessionIssue[];
  containsTokens: false;
  canIssueSessions: boolean;
}

export interface IssuedEmailSessionFileManifestEntry {
  email: string;
  surface: IssuableRecruiterSurface;
  client?: RecruiterClient;
  subject: string;
  tokenId?: string;
  issuedAt?: string;
  path: string;
}

export interface IssuedEmailSessionFileManifest {
  ok: true;
  outputDir: string;
  manifestPath: string;
  requestedEmailCount: number;
  requestedSurfaces: IssuableRecruiterSurface[];
  fileCount: number;
  containsTokens: false;
  sessionFilesContainTokens: true;
  warning: string;
  files: IssuedEmailSessionFileManifestEntry[];
}

export function issueVerifiedEmailSessionToken(
  config: EmailSessionIssuerConfig,
  options: IssueVerifiedEmailSessionOptions
): IssuedEmailSession {
  const email = normalizeWorkEmail(options.email, config.allowedDomains);
  if (!isIssuableSurface(options.surface)) {
    throw new Error("Recruiter session issuance supports only claude_desktop and chatgpt_desktop surfaces.");
  }
  const client = options.client ?? defaultClientForSurface(options.surface);
  if (!isRecruiterClient(client) || !isClientSurfaceCompatible(client, options.surface)) {
    throw new Error("Recruiter session client identity is incompatible with its surface.");
  }
  const now = config.now ?? (() => Date.now());
  const issuedAtMs = now();
  const tokenId = normalizeSessionTokenId((config.tokenId ?? randomUUID)());
  const session: AuthenticatedSession = {
    subject: `email:${email}`,
    email,
    surface: options.surface,
    client,
    tokenId,
    issuedAt: new Date(issuedAtMs).toISOString(),
  };
  return {
    email,
    session,
    token: createSignedSessionToken(session, config.secret),
  };
}

export async function issueDirectoryVerifiedEmailSessionToken(
  config: EmailSessionIssuerConfig,
  options: IssueVerifiedEmailSessionOptions,
  directory: IdentityDirectory
): Promise<IssuedEmailSession> {
  const issued = issueVerifiedEmailSessionToken(config, options);
  const resolution = await directory.resolve(issued.session);
  if (resolution.status === "resolved") {
    if (!isSafePositiveGreenhouseUserId(resolution.greenhouseUserId)) {
      throw new Error("Work email maps to an invalid Greenhouse user id.");
    }
    return issued;
  }
  if (resolution.status === "ambiguous") {
    throw new Error("Work email is not uniquely mapped to a Greenhouse user in the recruiter identity directory.");
  }
  if (resolution.status === "invalid") {
    throw new Error("Work email maps to an invalid Greenhouse user id.");
  }
  throw new Error("Work email is not mapped to a Greenhouse user in the recruiter identity directory.");
}

export async function issueDirectoryVerifiedEmailSessionBatch(
  config: EmailSessionIssuerConfig,
  options: IssueVerifiedEmailSessionBatchOptions,
  directory: IdentityDirectory
): Promise<IssuedEmailSessionBatch> {
  const issued: IssuedEmailSession[] = [];
  const denied: DeniedEmailSessionIssue[] = [];
  const seenEmails = new Set<string>();
  const surfaces = uniqueSurfaces(options.surfaces);
  const clients = options.clients === undefined
    ? surfaces.map(defaultClientForSurface)
    : uniqueClients(options.clients);

  if (clients.length === 0) {
    throw new Error("At least one physical client is required to issue recruiter sessions.");
  }

  for (const rawEmail of options.emails) {
    let normalizedEmail: string;
    try {
      normalizedEmail = normalizeWorkEmail(rawEmail, config.allowedDomains);
    } catch (error) {
      denied.push({ email: rawEmail, reason: errorMessage(error) });
      continue;
    }

    if (seenEmails.has(normalizedEmail)) {
      denied.push({ email: normalizedEmail, reason: "Duplicate email in recruiter session issuance request." });
      continue;
    }
    seenEmails.add(normalizedEmail);

    const resolution = await directory.resolve({
      subject: `email:${normalizedEmail}`,
      email: normalizedEmail,
      surface: surfaceForRecruiterClient(clients[0]!),
      client: clients[0]!,
    });
    if (resolution.status === "ambiguous") {
      denied.push({ email: normalizedEmail, reason: "Work email is not uniquely mapped to a Greenhouse user in the recruiter identity directory." });
      continue;
    }
    if (resolution.status === "invalid") {
      denied.push({ email: normalizedEmail, reason: "Work email maps to an invalid Greenhouse user id." });
      continue;
    }
    if (resolution.status !== "resolved") {
      denied.push({ email: normalizedEmail, reason: "Work email is not mapped to a Greenhouse user in the recruiter identity directory." });
      continue;
    }
    if (!isSafePositiveGreenhouseUserId(resolution.greenhouseUserId)) {
      denied.push({ email: normalizedEmail, reason: "Work email maps to an invalid Greenhouse user id." });
      continue;
    }

    for (const client of clients) {
      issued.push(issueVerifiedEmailSessionToken(config, {
        email: normalizedEmail,
        surface: surfaceForRecruiterClient(client),
        client,
      }));
    }
  }

  return {
    ok: denied.length === 0,
    requestedEmailCount: options.emails.length,
    requestedSurfaces: uniqueSurfaces(clients.map(surfaceForRecruiterClient)),
    issued,
    denied,
  };
}

export async function preflightDirectoryVerifiedEmailRoster(
  config: EmailRosterPreflightConfig,
  options: PreflightVerifiedEmailRosterOptions,
  directory: IdentityDirectory
): Promise<PreflightVerifiedEmailRosterReport> {
  const rosterSource = normalizeManagedRosterSource(config.rosterSource);
  const verifiedBy = normalizeRosterVerifiedBy(config.verifiedBy);
  const now = config.now ?? (() => Date.now());
  const generatedAt = new Date(now()).toISOString();
  const resolved: PreflightResolvedEmailRosterEntry[] = [];
  const denied: DeniedEmailSessionIssue[] = [];
  const seenEmails = new Set<string>();
  const surfaces = uniqueSurfaces(options.surfaces);

  if (surfaces.length === 0) {
    throw new Error("At least one desktop surface is required to preflight recruiter sessions.");
  }

  for (const rawEmail of options.emails) {
    let normalizedEmail: string;
    try {
      normalizedEmail = normalizeWorkEmail(rawEmail, config.allowedDomains);
    } catch (error) {
      denied.push({ email: rawEmail, reason: errorMessage(error) });
      continue;
    }

    if (seenEmails.has(normalizedEmail)) {
      denied.push({ email: normalizedEmail, reason: "Duplicate email in recruiter session issuance request." });
      continue;
    }
    seenEmails.add(normalizedEmail);

    const subject = `email:${normalizedEmail}`;
    const resolution = await directory.resolve({
      subject,
      email: normalizedEmail,
      surface: surfaces[0]!,
    });
    if (resolution.status === "ambiguous") {
      denied.push({ email: normalizedEmail, reason: "Work email is not uniquely mapped to a Greenhouse user in the recruiter identity directory." });
      continue;
    }
    if (resolution.status === "invalid") {
      denied.push({ email: normalizedEmail, reason: "Work email maps to an invalid Greenhouse user id." });
      continue;
    }
    if (resolution.status !== "resolved") {
      denied.push({ email: normalizedEmail, reason: "Work email is not mapped to a Greenhouse user in the recruiter identity directory." });
      continue;
    }
    if (!isSafePositiveGreenhouseUserId(resolution.greenhouseUserId)) {
      denied.push({ email: normalizedEmail, reason: "Work email maps to an invalid Greenhouse user id." });
      continue;
    }

    resolved.push({
      email: normalizedEmail,
      subject,
      greenhouseUserId: resolution.greenhouseUserId,
      surfaces,
    });
  }

  return {
    ok: denied.length === 0,
    generatedAt,
    rosterSource,
    verifiedBy,
    requestedEmailCount: options.emails.length,
    normalizedEmailCount: seenEmails.size,
    requestedSurfaces: surfaces,
    resolved,
    denied,
    containsTokens: false,
    canIssueSessions: denied.length === 0 && resolved.length > 0,
  };
}

export async function writeIssuedEmailSessionBatchFiles(
  batch: IssuedEmailSessionBatch,
  outputDir: string
): Promise<IssuedEmailSessionFileManifest> {
  if (!batch.ok || batch.denied.length > 0) {
    throw new Error("Session issuance batch contains denied rows; fix them before writing durable session files.");
  }
  if (batch.issued.length === 0) {
    throw new Error("Session issuance batch contains no issued sessions.");
  }

  const resolvedOutputDir = resolve(outputDir);
  await mkdir(resolvedOutputDir, { recursive: true, mode: SENSITIVE_DIR_MODE });
  await chmod(resolvedOutputDir, SENSITIVE_DIR_MODE);
  const usedFilenames = new Set<string>();
  const files: IssuedEmailSessionFileManifestEntry[] = [];
  const writes: Array<{ path: string; value: unknown }> = [];
  for (const issued of batch.issued) {
    if (!isIssuableSurface(issued.session.surface)) {
      throw new Error("Session issuance batch contains a non-distributable surface.");
    }
    const filename = uniqueFilename(
      `${safeFileSegment(issued.email)}--${issued.session.client?.replaceAll("_", "-") ?? issued.session.surface.replace("_", "-")}.json`,
      usedFilenames
    );
    const path = resolve(resolvedOutputDir, filename);
    writes.push({ path, value: toCliIssuedSession(issued) });
    files.push({
      email: issued.email,
      surface: issued.session.surface,
      client: issued.session.client!,
      subject: issued.session.subject,
      tokenId: issued.session.tokenId,
      issuedAt: issued.session.issuedAt,
      path: filename,
    });
  }

  const manifestPath = resolve(resolvedOutputDir, "manifest.json");
  const manifest: IssuedEmailSessionFileManifest = {
    ok: true,
    outputDir: ".",
    manifestPath: "manifest.json",
    requestedEmailCount: batch.requestedEmailCount,
    requestedSurfaces: batch.requestedSurfaces,
    fileCount: files.length,
    containsTokens: false,
    sessionFilesContainTokens: true,
    warning: "Manifest omits durable tokens, but each generated session file contains one recruiter's durable MCP token. Distribute each file only to its intended user or use it as input to desktop config generation.",
    files,
  };
  await assertSensitiveArtifactPathsDoNotExist([...writes.map((entry) => entry.path), manifestPath]);
  for (const write of writes) {
    await writeSensitiveJsonFile(write.path, write.value);
  }
  await writeSensitiveJsonFile(manifestPath, manifest);
  return manifest;
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

export function createEmailSessionIssuerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): EmailSessionIssuerConfig {
  const secret = env.GREENHOUSE_RECRUITER_SESSION_SECRET;
  if (!secret) {
    throw new Error("GREENHOUSE_RECRUITER_SESSION_SECRET is required to issue verified-email sessions.");
  }
  if (hasLeadingOrTrailingWhitespace(secret)) {
    throw new Error("GREENHOUSE_RECRUITER_SESSION_SECRET must not contain leading or trailing whitespace.");
  }
  if (!isStrongSessionSecret(secret)) {
    throw new Error(`GREENHOUSE_RECRUITER_SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters.`);
  }
  const allowedDomains = parseAllowedDomains(env.GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS);
  if (allowedDomains.length === 0) {
    throw new Error("GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS is required to issue verified-email sessions.");
  }
  return {
    secret,
    allowedDomains,
  };
}

export function createEmailRosterPreflightConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): EmailRosterPreflightConfig {
  const allowedDomains = parseAllowedDomains(env.GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS);
  if (allowedDomains.length === 0) {
    throw new Error("GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS is required to preflight recruiter session rosters.");
  }
  return { allowedDomains };
}

export function normalizeWorkEmail(email: string, allowedDomains: string[]): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    throw new Error("Enter a valid work email address.");
  }
  const domain = normalized.split("@")[1]!;
  const normalizedDomains = allowedDomains.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (normalizedDomains.length > 0 && !normalizedDomains.includes(domain)) {
    throw new Error("Email domain is not allowed for the recruiter-scoped Greenhouse MCP.");
  }
  return normalized;
}

export function normalizeManagedRosterSource(value: string | undefined): ManagedRosterSource {
  const normalized = value?.trim().toLowerCase();
  if (normalized && MANAGED_ROSTER_SOURCES.includes(normalized as ManagedRosterSource)) {
    return normalized as ManagedRosterSource;
  }
  throw new Error(`Roster preflight source must be one of: ${MANAGED_ROSTER_SOURCES.join(", ")}.`);
}

function normalizeRosterVerifiedBy(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error("Roster preflight verified-by is required.");
  }
  return normalized;
}

export async function startEmailSessionIssuerCli(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv.slice(2)
): Promise<void> {
  try {
    const parsedArgs = parseIssueArgs(args);
    const config = createEmailSessionIssuerConfigFromEnv(env);
    const directory = createIdentityDirectoryFromEnv(env);
    const targetCount = parsedArgs.clients?.length ?? parsedArgs.surfaces.length;
    if (parsedArgs.mode === "single" && targetCount === 1 && !parsedArgs.outDir) {
      const issued = await issueDirectoryVerifiedEmailSessionToken(
        config,
        { email: parsedArgs.email, surface: parsedArgs.surfaces[0]!, client: parsedArgs.clients?.[0] },
        directory
      );
      process.stdout.write(`${JSON.stringify(toCliIssuedSession(issued), null, 2)}\n`);
      return;
    }

    const emails = parsedArgs.mode === "single"
      ? [parsedArgs.email]
      : parseEmailList(await readFile(parsedArgs.emailsFile, "utf8"));
    const batch = await issueDirectoryVerifiedEmailSessionBatch(config, { emails, surfaces: parsedArgs.surfaces, clients: parsedArgs.clients }, directory);
    if (parsedArgs.outDir) {
      const manifest = await writeIssuedEmailSessionBatchFiles(batch, parsedArgs.outDir);
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify({
      ...batch,
      issued: batch.issued.map(toCliIssuedSession),
    }, null, 2)}\n`);
    if (!batch.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[greenhouse-recruiter-issue-session] ${message}\n`);
    process.exitCode = 1;
  }
}

export async function startEmailRosterPreflightCli(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv.slice(2)
): Promise<void> {
  try {
    const parsedArgs = parseRosterPreflightArgs(args);
    const config = createEmailRosterPreflightConfigFromEnv(env);
    const directory = createIdentityDirectoryFromEnv(env);
    const emails = parseEmailList(await readFile(parsedArgs.emailsFile, "utf8"));
    const report = await preflightDirectoryVerifiedEmailRoster(
      {
        ...config,
        rosterSource: parsedArgs.rosterSource ?? env.GREENHOUSE_RECRUITER_ROSTER_SOURCE,
        verifiedBy: parsedArgs.verifiedBy ?? env.GREENHOUSE_RECRUITER_ROSTER_VERIFIED_BY,
      },
      { emails, surfaces: parsedArgs.surfaces },
      directory
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[greenhouse-recruiter-preflight-roster] ${message}\n`);
    process.exitCode = 1;
  }
}

function parseIssueArgs(args: string[]):
  | { mode: "single"; email: string; surfaces: IssuableRecruiterSurface[]; clients?: RecruiterClient[]; outDir?: string }
  | { mode: "batch"; emailsFile: string; surfaces: IssuableRecruiterSurface[]; clients?: RecruiterClient[]; outDir?: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith("--")) continue;
    const next = args[index + 1];
    if (!next || next.startsWith("--")) continue;
    values.set(arg.slice(2), next);
    index += 1;
  }
  const email = values.get("email");
  const emailsFile = values.get("emails-file");
  const outDir = values.get("out-dir");
  const rawClients = values.get("clients") ?? values.get("client");
  const rawSurfaces = values.get("surfaces") ?? values.get("surface");
  if (rawClients !== undefined && rawSurfaces !== undefined) {
    throw new Error("Choose --client/--clients or --surface/--surfaces, not both.");
  }
  const clients = parseIssueClients(rawClients);
  const surfaces = clients
    ? uniqueSurfaces(clients.map(surfaceForRecruiterClient))
    : parseIssueSurfaces(rawSurfaces);
  if (Boolean(email) === Boolean(emailsFile)) {
    throw new Error("Usage: greenhouse-recruiter-issue-session --email user@company.com --surface claude_desktop|chatgpt_desktop|both OR --emails-file recruiters.txt --surface both");
  }
  if (email) {
    return { mode: "single", email, surfaces, clients, outDir };
  }
  return { mode: "batch", emailsFile: emailsFile!, surfaces, clients, outDir };
}

function parseRosterPreflightArgs(args: string[]): { emailsFile: string; surfaces: IssuableRecruiterSurface[]; rosterSource?: string; verifiedBy?: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith("--")) continue;
    const next = args[index + 1];
    if (!next || next.startsWith("--")) continue;
    values.set(arg.slice(2), next);
    index += 1;
  }
  const emailsFile = values.get("emails-file");
  if (!emailsFile) {
    throw new Error("Usage: greenhouse-recruiter-preflight-roster --emails-file recruiters.txt --surface claude_desktop|chatgpt_desktop|both --source admin_managed_roster|google_workspace_group|okta_group|hris_report|greenhouse_users_export --verified-by ops@example.com");
  }
  return {
    emailsFile,
    surfaces: parseIssueSurfaces(values.get("surfaces") ?? values.get("surface")),
    rosterSource: values.get("source"),
    verifiedBy: values.get("verified-by"),
  };
}

function parseAllowedDomains(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

export function parseEmailList(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .flatMap((line) => line.split("#")[0]!.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseIssueSurfaces(raw: string | undefined): IssuableRecruiterSurface[] {
  if (!raw) {
    throw new Error("--surface must be claude_desktop, chatgpt_desktop, or both.");
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "both") return ["claude_desktop", "chatgpt_desktop"];
  const surfaces = normalized.split(",").map((value) => value.trim()).filter(Boolean);
  if (surfaces.length === 0 || surfaces.some((surface) => !isIssuableSurface(surface))) {
    throw new Error("--surface must be claude_desktop, chatgpt_desktop, or both.");
  }
  return uniqueSurfaces(surfaces as IssuableRecruiterSurface[]);
}

function uniqueSurfaces(surfaces: IssuableRecruiterSurface[]): IssuableRecruiterSurface[] {
  const result: IssuableRecruiterSurface[] = [];
  for (const surface of surfaces) {
    if (!result.includes(surface)) result.push(surface);
  }
  return result;
}

function uniqueClients(clients: RecruiterClient[]): RecruiterClient[] {
  return [...new Set(clients)];
}

function parseIssueClients(raw: string | undefined): RecruiterClient[] | undefined {
  if (raw === undefined) return undefined;
  const clients = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (clients.length === 0 || clients.some((client) => !isRecruiterClient(client))) {
    throw new Error("--client/--clients must contain only claude_desktop_chat, claude_code, or chatgpt_codex_host.");
  }
  if (new Set(clients).size !== clients.length) throw new Error("--client/--clients must not contain duplicates.");
  return uniqueClients(clients as RecruiterClient[]);
}

function defaultClientForSurface(surface: IssuableRecruiterSurface): RecruiterClient {
  return surface === "claude_desktop" ? "claude_desktop_chat" : "chatgpt_codex_host";
}

function isIssuableSurface(value: unknown): value is IssuableRecruiterSurface {
  return value === "claude_desktop" || value === "chatgpt_desktop";
}

function toCliIssuedSession(issued: IssuedEmailSession): Record<string, unknown> {
  return {
    email: issued.email,
    surface: issued.session.surface,
    client: issued.session.client,
    subject: issued.session.subject,
    tokenId: issued.session.tokenId,
    issuedAt: issued.session.issuedAt,
    token: issued.token,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeFileSegment(value: string): string {
  const safe = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) {
    throw new Error("Cannot derive session filename from empty email.");
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

if (import.meta.url === `file://${process.argv[1]}`) {
  startEmailSessionIssuerCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[greenhouse-recruiter-issue-session] ${message}\n`);
    process.exit(1);
  });
}
