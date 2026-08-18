import { randomUUID } from "node:crypto";
import { access, chmod, link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { issueActionSession, MAX_SESSION_TTL_MS } from "./crypto.js";
import { readActionSigningSecret } from "./env.js";
import { createSupabaseActionStore, readActionSupabaseConfig } from "./store.js";
import type { ActionClient, ActionSession } from "./types.js";

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const REQUEST_TIMEOUT_MS = 8_000;
const PROJECT_REF = "exampleprojectref000";
type ProvisionClient = Exclude<ActionClient, "test">;

// Spelled once. Every provisionable client must appear here, so adding one to ActionClient and
// forgetting the CLI is a type error rather than a client nobody can be entitled for.
const PROVISION_CLIENTS: readonly ProvisionClient[] = ["codex", "claude_code", "claude_desktop_chat"];

function isProvisionClient(value: unknown): value is ProvisionClient {
  return (PROVISION_CLIENTS as readonly unknown[]).includes(value);
}

interface RosterEntry {
  subject: string;
  clients: ProvisionClient[];
  canApply: boolean;
  canApplyHighImpact: boolean;
}

interface EntitlementRow {
  identity_id: string;
  greenhouse_user_id: number;
  client: ProvisionClient;
  can_preview: boolean;
  can_apply: boolean;
  can_apply_high_impact: boolean;
  status: "active" | "disabled";
  expires_at: string;
  updated_at: string;
}

const ENTITLEMENT_FIELDS = [
  "identity_id", "greenhouse_user_id", "client", "can_preview", "can_apply",
  "can_apply_high_impact", "status", "expires_at", "updated_at",
] as const;

class OperatorWriteRejectedError extends Error {}

export interface ActionAccessOperatorConfig {
  supabaseUrl: string;
  supabaseKey: string;
  signingSecret: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  tokenId?: () => string;
}

export interface ProvisionActionAccessOptions {
  roster: unknown;
  outputDir: string;
  ttlMs?: number;
}

export interface ProvisionActionAccessReport {
  ok: true;
  generated_at: string;
  output_dir: string;
  manifest_path: string;
  user_count: number;
  entitlement_count: number;
  session_file_count: number;
  contains_tokens: false;
  session_files_contain_tokens: true;
  sessions: Array<{
    subject: string;
    greenhouse_user_id: number;
    client: ProvisionClient;
    token_id: string;
    issued_at: string;
    expires_at: string;
    path: string;
  }>;
}

export async function provisionActionAccess(
  config: ActionAccessOperatorConfig,
  options: ProvisionActionAccessOptions
): Promise<ProvisionActionAccessReport> {
  const roster = parseRoster(options.roster);
  const outputDir = resolve(requireTrimmed(options.outputDir, "output directory"));
  const manifestPath = resolve(outputDir, "manifest.json");
  const ttlMs = options.ttlMs ?? MAX_SESSION_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_SESSION_TTL_MS) {
    throw new Error("Session TTL must be a positive integer no greater than 30 days.");
  }
  await mkdir(outputDir, { recursive: true, mode: DIRECTORY_MODE });
  await chmod(outputDir, DIRECTORY_MODE);
  if (await pathExists(manifestPath)) {
    throw new Error("Refusing to overwrite an existing action access manifest; choose a new output directory.");
  }

  const fetchImpl = config.fetchImpl ?? fetch;
  const store = createSupabaseActionStore({
    url: config.supabaseUrl,
    apiKey: config.supabaseKey,
    fetchImpl,
  });
  const nowMs = (config.now ?? Date.now)();
  const resolved = await Promise.all(roster.map(async (entry) => ({
    entry,
    identity: await store.resolveIdentity(operatorSession(entry.subject, nowMs)),
  })));

  const entitlementRows: EntitlementRow[] = resolved.flatMap(({ entry, identity }) => entry.clients.map((client) => ({
    identity_id: identity.identityId,
    greenhouse_user_id: identity.greenhouseUserId,
    client,
    can_preview: true,
    can_apply: entry.canApply,
    can_apply_high_impact: entry.canApplyHighImpact,
    status: "active",
    expires_at: new Date(nowMs + ttlMs).toISOString(),
    updated_at: new Date(nowMs).toISOString(),
  })));

  const sessions = resolved.flatMap(({ entry, identity }) => entry.clients.map((client) => {
    const issued = issueActionSession({
      subject: entry.subject,
      client,
      ttlMs,
      nowMs,
      ...(config.tokenId ? { tokenId: config.tokenId() } : {}),
    }, config.signingSecret);
    const filename = `session-${issued.session.tokenId.slice("action:".length)}.json`;
    return {
      tokenFile: {
        token: issued.token,
        token_id: issued.session.tokenId,
        subject: entry.subject,
        client,
        issued_at: new Date(issued.session.issuedAtMs).toISOString(),
        expires_at: new Date(issued.session.expiresAtMs).toISOString(),
      },
      manifest: {
        subject: entry.subject,
        greenhouse_user_id: identity.greenhouseUserId,
        client,
        token_id: issued.session.tokenId,
        issued_at: new Date(issued.session.issuedAtMs).toISOString(),
        expires_at: new Date(issued.session.expiresAtMs).toISOString(),
        path: filename,
      },
    };
  }));
  const report: ProvisionActionAccessReport = {
    ok: true,
    generated_at: new Date(nowMs).toISOString(),
    output_dir: ".",
    manifest_path: "manifest.json",
    user_count: roster.length,
    entitlement_count: entitlementRows.length,
    session_file_count: sessions.length,
    contains_tokens: false,
    session_files_contain_tokens: true,
    sessions: sessions.map(({ manifest }) => manifest),
  };
  const stagedManifestPath = resolve(outputDir, `.manifest-${randomUUID()}.pending.json`);
  const sessionPaths: string[] = [];
  let stagedManifestOwned = false;
  let entitlementsMayHaveChanged = false;
  try {
    await writeSensitiveJson(stagedManifestPath, report, () => { stagedManifestOwned = true; });
    for (const session of sessions) {
      const path = resolve(outputDir, session.manifest.path);
      await writeSensitiveJson(path, session.tokenFile, () => { sessionPaths.push(path); });
    }
    try {
      await writeEntitlements(config, entitlementRows, fetchImpl);
      entitlementsMayHaveChanged = true;
    } catch (error) {
      entitlementsMayHaveChanged = !(error instanceof OperatorWriteRejectedError);
      throw error;
    }
    await publishSensitiveArtifact(stagedManifestPath, manifestPath);
  } catch (error) {
    let disableError: unknown;
    if (entitlementsMayHaveChanged) {
      try {
        await writeEntitlements(config, disabledEntitlements(entitlementRows, nowMs), fetchImpl);
      } catch (caught) {
        disableError = caught;
      }
    }
    const bearerCleanupFailures = await removeArtifacts(sessionPaths);
    if (disableError || bearerCleanupFailures.length > 0) {
      throw new Error(
        bearerCleanupFailures.length > 0
          ? `Provisioning failed and bearer files could not all be deleted. Keep writes off; use ${basename(stagedManifestPath)} to disable entitlements and revoke token IDs, then delete: ${bearerCleanupFailures.map(({ path }) => basename(path)).join(", ")}.`
          : `Provisioning failed and action entitlement state could not be confirmed disabled. Bearer files were removed; keep writes off and use ${basename(stagedManifestPath)} to disable entitlements and revoke token IDs before retrying.`,
        {
          cause: new AggregateError([
            error,
            ...(disableError ? [disableError] : []),
            ...bearerCleanupFailures.map(({ error: cleanupError }) => cleanupError),
          ]),
        }
      );
    }
    const manifestCleanupFailures = stagedManifestOwned
      ? await removeArtifacts([stagedManifestPath])
      : [];
    if (manifestCleanupFailures.length > 0) {
      throw new Error(
        `Provisioning failed; bearer files were removed but the token-free pending manifest could not be deleted: ${basename(stagedManifestPath)}.`,
        { cause: new AggregateError([error, ...manifestCleanupFailures.map(({ error: cleanupError }) => cleanupError)]) }
      );
    }
    if (entitlementsMayHaveChanged) {
      throw new Error(
        "Provisioning failed; affected entitlements were disabled and bearer files were removed.",
        { cause: error }
      );
    }
    throw error;
  }
  return { ...report, output_dir: outputDir, manifest_path: manifestPath };
}

export async function disableActionEntitlement(
  config: Pick<ActionAccessOperatorConfig, "supabaseUrl" | "supabaseKey" | "fetchImpl" | "now">,
  options: { subject: string; client: ProvisionClient }
): Promise<Record<string, unknown>> {
  const subject = requireTrimmed(options.subject, "action identity subject");
  const client = parseClients([options.client])[0]!;
  const fetchImpl = config.fetchImpl ?? fetch;
  const nowMs = (config.now ?? Date.now)();
  const store = createSupabaseActionStore({
    url: config.supabaseUrl,
    apiKey: config.supabaseKey,
    fetchImpl,
  });
  const identity = await store.resolveIdentity(operatorSession(subject, nowMs));
  const rows = disabledEntitlements([{
    identity_id: identity.identityId,
    greenhouse_user_id: identity.greenhouseUserId,
    client,
    can_preview: false,
    can_apply: false,
    can_apply_high_impact: false,
    status: "disabled",
    expires_at: new Date(nowMs).toISOString(),
    updated_at: new Date(nowMs).toISOString(),
  }], nowMs);
  await writeEntitlements(config, rows, fetchImpl);
  return {
    ok: true,
    subject,
    greenhouse_user_id: identity.greenhouseUserId,
    client,
    status: "disabled",
  };
}

export async function revokeActionSession(
  config: Pick<ActionAccessOperatorConfig, "supabaseUrl" | "supabaseKey" | "fetchImpl" | "now">,
  options: { tokenId: string; revokedBy: string; reason: string }
): Promise<Record<string, unknown>> {
  const tokenId = requireActionTokenId(options.tokenId);
  const revokedBy = requireTrimmed(options.revokedBy, "revoked-by operator");
  const reason = requireTrimmed(options.reason, "revocation reason");
  const revokedAt = new Date((config.now ?? Date.now)()).toISOString();
  const url = new URL(`${normalizeOperatorOrigin(config.supabaseUrl)}/rest/v1/recruiter_mcp_session_revocation`);
  url.searchParams.set("on_conflict", "token_id");
  await operatorRequest(config, url, [{
    token_id: tokenId,
    status: "revoked",
    revoked_at: revokedAt,
    revoked_by: revokedBy,
    reason,
    evidence_detail: { source: "greenhouse_action_access_cli", contains_token_string: false },
  }], config.fetchImpl ?? fetch);
  return {
    ok: true,
    token_id: tokenId,
    status: "revoked",
    revoked_at: revokedAt,
    revoked_by: revokedBy,
    reason,
    contains_tokens: false,
  };
}

export function assertCanonicalActionDatabaseUrl(raw: string | undefined): {
  ok: true;
  project_ref: string;
  connection: "direct" | "pooler";
} {
  const value = requireTrimmed(raw ?? "", "GREENHOUSE_ACTION_DATABASE_URL");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("GREENHOUSE_ACTION_DATABASE_URL is invalid."); }
  if ((url.protocol !== "postgres:" && url.protocol !== "postgresql:") || url.pathname !== "/postgres"
    || url.search || url.hash || !url.hostname || !url.username) {
    throw new Error("GREENHOUSE_ACTION_DATABASE_URL must be a PostgreSQL connection to the canonical project database.");
  }
  const username = decodeURIComponent(url.username);
  const direct = url.hostname === `db.${PROJECT_REF}.supabase.co` && username === "postgres";
  const pooler = url.hostname.endsWith(".pooler.supabase.com") && username === `postgres.${PROJECT_REF}`;
  if (!direct && !pooler) {
    throw new Error(`GREENHOUSE_ACTION_DATABASE_URL must target canonical project ${PROJECT_REF}.`);
  }
  return { ok: true, project_ref: PROJECT_REF, connection: direct ? "direct" : "pooler" };
}

export async function runActionAccessCli(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv.slice(2)
): Promise<void> {
  const command = args[0];
  if (command === "check-db-url") {
    process.stdout.write(`${JSON.stringify(assertCanonicalActionDatabaseUrl(env.GREENHOUSE_ACTION_DATABASE_URL))}\n`);
    return;
  }
  const flags = parseFlags(args.slice(1));
  const supabase = readActionSupabaseConfig(env);
  if (command === "provision") {
    const rosterPath = requireFlag(flags, "roster");
    const outputDir = requireFlag(flags, "out-dir");
    const ttlMinutes = flags.get("ttl-minutes") ?? "43200";
    if (!/^[1-9]\d*$/.test(ttlMinutes)) throw new Error("--ttl-minutes must be a positive integer.");
    const roster = JSON.parse(await readFile(rosterPath, "utf8")) as unknown;
    const report = await provisionActionAccess({
      supabaseUrl: supabase.url,
      supabaseKey: supabase.apiKey,
      signingSecret: readActionSigningSecret(env),
    }, { roster, outputDir, ttlMs: Number(ttlMinutes) * 60_000 });
    process.stdout.write(`${JSON.stringify({
      ok: report.ok,
      manifest_path: report.manifest_path,
      user_count: report.user_count,
      entitlement_count: report.entitlement_count,
      session_file_count: report.session_file_count,
      contains_tokens: false,
    })}\n`);
    return;
  }
  if (command === "revoke") {
    const report = await revokeActionSession({
      supabaseUrl: supabase.url,
      supabaseKey: supabase.apiKey,
    }, {
      tokenId: requireFlag(flags, "token-id"),
      revokedBy: requireFlag(flags, "revoked-by"),
      reason: requireFlag(flags, "reason"),
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  if (command === "disable") {
    const client = requireFlag(flags, "client");
    if (!isProvisionClient(client)) {
      throw new Error("--client must be codex, claude_code, or claude_desktop_chat.");
    }
    const report = await disableActionEntitlement({
      supabaseUrl: supabase.url,
      supabaseKey: supabase.apiKey,
    }, {
      subject: requireFlag(flags, "subject"),
      client,
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  throw new Error("Usage: greenhouse-action-access <check-db-url|provision|revoke|disable> [options]");
}

async function writeEntitlements(
  config: Pick<ActionAccessOperatorConfig, "supabaseUrl" | "supabaseKey">,
  rows: EntitlementRow[],
  fetchImpl: typeof fetch
): Promise<void> {
  const url = new URL(`${normalizeOperatorOrigin(config.supabaseUrl)}/rest/v1/greenhouse_action_entitlement`);
  url.searchParams.set("on_conflict", "identity_id,client");
  try {
    await operatorRequest(config, url, rows, fetchImpl);
  } catch (error) {
    if (error instanceof OperatorWriteRejectedError) throw error;
    const reconciled = await entitlementsExactlyMatch(config, rows, fetchImpl).catch(() => false);
    if (!reconciled) throw new Error("Action access entitlement write outcome could not be reconciled.");
  }
}

function disabledEntitlements(rows: EntitlementRow[], nowMs: number): EntitlementRow[] {
  const disabledAt = new Date(nowMs).toISOString();
  return rows.map((row) => ({
    ...row,
    can_preview: false,
    can_apply: false,
    can_apply_high_impact: false,
    status: "disabled",
    expires_at: disabledAt,
    updated_at: disabledAt,
  }));
}

async function entitlementsExactlyMatch(
  config: Pick<ActionAccessOperatorConfig, "supabaseUrl" | "supabaseKey">,
  rows: EntitlementRow[],
  fetchImpl: typeof fetch
): Promise<boolean> {
  const origin = normalizeOperatorOrigin(config.supabaseUrl);
  const matches = await Promise.all(rows.map(async (expected) => {
    const url = new URL(`${origin}/rest/v1/greenhouse_action_entitlement`);
    url.searchParams.set("select", ENTITLEMENT_FIELDS.join(","));
    url.searchParams.set("identity_id", `eq.${expected.identity_id}`);
    url.searchParams.set("client", `eq.${expected.client}`);
    url.searchParams.set("limit", "2");
    const response = await fetchImpl(url, {
      method: "GET",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        apikey: config.supabaseKey,
        authorization: `Bearer ${config.supabaseKey}`,
        accept: "application/json",
      },
    });
    if (!response.ok) throw new Error(`Action access readback failed with HTTP ${response.status}.`);
    const value = await response.json() as unknown;
    return Array.isArray(value) && value.length === 1 && isRecord(value[0])
      && ENTITLEMENT_FIELDS.every((field) => entitlementFieldMatches(field, value[0]![field], expected[field]));
  }));
  return matches.every(Boolean);
}

async function operatorRequest(
  config: Pick<ActionAccessOperatorConfig, "supabaseKey">,
  url: URL,
  body: unknown,
  fetchImpl: typeof fetch
): Promise<void> {
  const response = await fetchImpl(url, {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      apikey: config.supabaseKey,
      authorization: `Bearer ${config.supabaseKey}`,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = new Error(`Action access write failed with HTTP ${response.status}.`);
    if (response.status !== 408 && response.status < 500) throw new OperatorWriteRejectedError(error.message);
    throw error;
  }
  await response.body?.cancel().catch(() => undefined);
}

function entitlementFieldMatches(field: typeof ENTITLEMENT_FIELDS[number], actual: unknown, expected: unknown): boolean {
  if (field !== "expires_at" && field !== "updated_at") return actual === expected;
  return typeof actual === "string" && typeof expected === "string"
    && Number.isFinite(Date.parse(actual)) && Date.parse(actual) === Date.parse(expected);
}

function parseRoster(value: unknown): RosterEntry[] {
  if (!isRecord(value) || !Array.isArray(value.users) || value.users.length === 0) {
    throw new Error("Roster must be a JSON object with a non-empty users array.");
  }
  const seen = new Set<string>();
  return value.users.map((raw) => {
    if (!isRecord(raw)) throw new Error("Every roster user must be an object.");
    const subject = requireTrimmed(typeof raw.subject === "string" ? raw.subject : "", "roster subject");
    if (seen.has(subject)) throw new Error(`Roster contains duplicate subject: ${subject}`);
    seen.add(subject);
    const clients = raw.clients === undefined ? [...PROVISION_CLIENTS]
      : parseClients(raw.clients);
    const canApply = raw.can_apply === undefined ? false : requireBoolean(raw.can_apply, "can_apply");
    const canApplyHighImpact = raw.can_apply_high_impact === undefined
      ? false : requireBoolean(raw.can_apply_high_impact, "can_apply_high_impact");
    if (canApplyHighImpact && !canApply) throw new Error("can_apply_high_impact requires can_apply.");
    return { subject, clients, canApply, canApplyHighImpact };
  });
}

function parseClients(value: unknown): ProvisionClient[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Roster clients must be a non-empty array.");
  const clients = value.map((client) => {
    if (!isProvisionClient(client)) throw new Error(`Roster clients may contain only ${PROVISION_CLIENTS.join(", ")}.`);
    return client;
  });
  if (new Set(clients).size !== clients.length) throw new Error("Roster clients cannot contain duplicates.");
  return clients;
}

function operatorSession(subject: string, nowMs: number): ActionSession {
  return {
    version: 1,
    kind: "greenhouse_action_session",
    audience: "greenhouse_action_mcp",
    subject,
    client: "codex",
    tokenId: "action:operator-preflight",
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + 60_000,
  };
}

function normalizeOperatorOrigin(raw: string): string {
  return readActionSupabaseConfig({
    GREENHOUSE_ACTION_SUPABASE_URL: raw,
    GREENHOUSE_ACTION_SUPABASE_KEY: "operator-config-validation",
  }).url;
}

async function writeSensitiveJson(path: string, value: unknown, onOwned: () => void): Promise<void> {
  let handle;
  try {
    handle = await open(path, "wx", FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Refusing to overwrite sensitive action access artifact: ${basename(path)}`);
    }
    throw error;
  }
  onOwned();
  let failure: unknown;
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
    await handle.chmod(FILE_MODE);
  } catch (error) {
    failure = error;
  }
  try {
    await handle.close();
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
}

async function publishSensitiveArtifact(stagedPath: string, finalPath: string): Promise<void> {
  try {
    await link(stagedPath, finalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Refusing to overwrite sensitive action access artifact: ${basename(finalPath)}`);
    }
    throw error;
  }
  await unlink(stagedPath).catch(() => undefined);
}

async function removeArtifacts(paths: string[]): Promise<Array<{ path: string; error: unknown }>> {
  const results = await Promise.all(paths.map(async (path) => {
    try {
      await unlink(path);
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return { path, error };
    }
  }));
  return results.filter((result): result is { path: string; error: unknown } => result !== null);
}

async function pathExists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function parseFlags(args: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--") || value.trim() !== value) {
      throw new Error("Action access options must be --name value pairs.");
    }
    const key = name.slice(2);
    if (values.has(key)) throw new Error(`${name} may be provided only once.`);
    values.set(key, value);
  }
  return values;
}

function requireFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function requireActionTokenId(value: string): string {
  const tokenId = requireTrimmed(value, "action token id");
  if (!/^action:[A-Za-z0-9_-]{8,120}$/.test(tokenId)) {
    throw new Error("--token-id must be an action: token ID, not a signed bearer token.");
  }
  return tokenId;
}

function requireTrimmed(value: string, label: string): string {
  if (value.length === 0 || value.trim() !== value) throw new Error(`${label} must be a non-empty trimmed value.`);
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runActionAccessCli().catch((error) => {
    console.error(error instanceof Error ? error.message : "Action access operation failed.");
    process.exitCode = 1;
  });
}
