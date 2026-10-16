import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeWorkEmail, parseEmailList } from "./email-session.js";
import { isSafePositiveGreenhouseUserId } from "./identity.js";
import { assertCanonicalSupabaseProjectRef, normalizeOptionalSupabaseIdentifier, normalizeSupabaseApiKey, normalizeSupabaseRestOrigin } from "./supabase-config.js";

export type IdentityBootstrapDeniedStatus =
  | "unresolved"
  | "email_missing"
  | "greenhouse_missing"
  | "ambiguous"
  | "deactivated";

export interface RecruiterIdentityDirectoryRow {
  greenhouse_user_id: number;
  primary_email: string;
  google_subject: null;
  slack_user_id: null;
  status: "resolved";
  source: string;
  evidence_detail: Record<string, unknown>;
  last_verified_at: string;
}

export interface IdentityBootstrapResolvedEntry {
  email: string;
  greenhouseUserId: number;
  row: RecruiterIdentityDirectoryRow;
}

export interface IdentityBootstrapDeniedEntry {
  email: string;
  status: IdentityBootstrapDeniedStatus;
  reason: string;
  greenhouseUserIds?: number[];
}

export interface IdentityBootstrapPlan {
  ok: boolean;
  generatedAt: string;
  source: string;
  requestedEmailCount: number;
  normalizedEmailCount: number;
  resolved: IdentityBootstrapResolvedEntry[];
  denied: IdentityBootstrapDeniedEntry[];
  containsTokens: false;
  canApply: boolean;
}

export interface BuildIdentityBootstrapPlanOptions {
  rosterEmails: string[];
  greenhouseUsers: unknown;
  allowedDomains: string[];
  generatedAt?: string;
  source?: string;
}

export interface SupabaseIdentityApplyConfig {
  supabaseUrl: string;
  apiKey: string;
  table?: string;
  fetchImpl?: typeof fetch;
  appliedAt?: string;
}

export interface IdentityBootstrapApplyReport {
  ok: true;
  appliedAt: string;
  table: string;
  rowCount: number;
  containsTokens: false;
}

interface GreenhouseUserMatch {
  id: number | null;
  emails: string[];
  inactive: boolean;
}

export function buildIdentityBootstrapPlan(
  options: BuildIdentityBootstrapPlanOptions
): IdentityBootstrapPlan {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const source = options.source ?? "greenhouse_users_roster_bootstrap";
  const userIndex = indexGreenhouseUsers(options.greenhouseUsers);
  const resolved: IdentityBootstrapResolvedEntry[] = [];
  const denied: IdentityBootstrapDeniedEntry[] = [];
  const seenEmails = new Set<string>();

  for (const rawEmail of options.rosterEmails) {
    let email: string;
    try {
      email = normalizeWorkEmail(rawEmail, options.allowedDomains);
    } catch (error) {
      denied.push({ email: rawEmail, status: "unresolved", reason: errorMessage(error) });
      continue;
    }

    if (seenEmails.has(email)) {
      denied.push({ email, status: "ambiguous", reason: "Duplicate email in recruiter identity bootstrap roster." });
      continue;
    }
    seenEmails.add(email);

    const matches = userIndex.get(email) ?? [];
    if (matches.length === 0) {
      denied.push({ email, status: "email_missing", reason: "No Greenhouse user record matched this work email." });
      continue;
    }

    const hasUnsafeIdMatch = matches.some((match) => match.id === null);
    const ids = uniqueNumbers(matches.flatMap((match) => match.id === null ? [] : [match.id]));
    if (hasUnsafeIdMatch || ids.length === 0) {
      denied.push({ email, status: "greenhouse_missing", reason: "Matched Greenhouse user record has no valid safe positive id." });
      continue;
    }
    if (ids.length > 1) {
      denied.push({
        email,
        status: "ambiguous",
        reason: "Work email matched multiple Greenhouse user ids; resolve the directory row manually before issuing durable sessions.",
        greenhouseUserIds: ids,
      });
      continue;
    }

    const activeMatch = matches.find((match) => match.id === ids[0] && !match.inactive);
    if (!activeMatch) {
      denied.push({ email, status: "deactivated", reason: "Matched Greenhouse user is inactive or deactivated." });
      continue;
    }

    const greenhouseUserId = ids[0]!;
    resolved.push({
      email,
      greenhouseUserId,
      row: {
        greenhouse_user_id: greenhouseUserId,
        primary_email: email,
        google_subject: null,
        slack_user_id: null,
        status: "resolved",
        source,
        evidence_detail: {
          source,
          matched_by: "work_email",
          matched_greenhouse_emails: activeMatch.emails,
        },
        last_verified_at: generatedAt,
      },
    });
  }

  return {
    ok: denied.length === 0 && resolved.length > 0,
    generatedAt,
    source,
    requestedEmailCount: options.rosterEmails.length,
    normalizedEmailCount: seenEmails.size,
    resolved,
    denied,
    containsTokens: false,
    canApply: denied.length === 0 && resolved.length > 0,
  };
}

export async function applyIdentityBootstrapPlan(
  plan: IdentityBootstrapPlan,
  config: SupabaseIdentityApplyConfig
): Promise<IdentityBootstrapApplyReport> {
  if (!plan.canApply || !plan.ok || plan.denied.length > 0) {
    throw new Error("Identity bootstrap plan contains denied rows; fix them before applying to the production identity directory.");
  }
  if (plan.resolved.length === 0) {
    throw new Error("Identity bootstrap plan contains no resolved rows to apply.");
  }
  const baseUrl = normalizeSupabaseRestOrigin(config.supabaseUrl, "Supabase identity directory");
  const apiKey = normalizeSupabaseApiKey(config.apiKey, "Supabase identity directory");

  const table = normalizeOptionalSupabaseIdentifier(config.table, "recruiter_identity_directory", "Supabase identity directory table");
  const url = new URL(`${baseUrl}/rest/v1/${encodeURIComponent(table)}`);
  url.searchParams.set("on_conflict", "greenhouse_user_id");
  const response = await (config.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: {
      apikey: apiKey,
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(plan.resolved.map((entry) => entry.row)),
  });

  if (!response.ok) {
    throw new Error(`Identity directory apply failed with status ${response.status}.`);
  }

  return {
    ok: true,
    appliedAt: config.appliedAt ?? new Date().toISOString(),
    table,
    rowCount: plan.resolved.length,
    containsTokens: false,
  };
}

export async function startIdentityBootstrapCli(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv.slice(2)
): Promise<void> {
  try {
    const parsed = parseIdentityBootstrapArgs(args);
    const allowedDomains = parseAllowedDomains(env.GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS);
    if (allowedDomains.length === 0) {
      throw new Error("GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS is required to bootstrap the recruiter identity directory.");
    }

    const rosterEmails = parseEmailList(await readFile(parsed.emailsFile, "utf8"));
    const greenhouseUsers = JSON.parse(await readFile(parsed.greenhouseUsersFile, "utf8")) as unknown;
    const plan = buildIdentityBootstrapPlan({
      rosterEmails,
      greenhouseUsers,
      allowedDomains,
    });

    if (parsed.out) {
      await writeFile(resolve(parsed.out), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    }

    if (!parsed.apply) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      if (!plan.ok) process.exitCode = 1;
      return;
    }

    const report = await applyIdentityBootstrapPlan(plan, {
      supabaseUrl: assertCanonicalSupabaseProjectRef(
        requireEnv(env, "GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL"),
        "Supabase identity directory",
      ),
      apiKey: requireEnv(env, "GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY"),
      table: env.GREENHOUSE_RECRUITER_IDENTITY_TABLE,
    });
    process.stdout.write(`${JSON.stringify({ ...report, plan }, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[greenhouse-recruiter-bootstrap-identity] ${message}\n`);
    process.exitCode = 1;
  }
}

function indexGreenhouseUsers(input: unknown): Map<string, GreenhouseUserMatch[]> {
  const rows = extractRows(input);
  const index = new Map<string, GreenhouseUserMatch[]>();
  for (const row of rows) {
    const match = parseGreenhouseUser(row);
    if (!match) continue;
    for (const email of match.emails) {
      const list = index.get(email) ?? [];
      list.push(match);
      index.set(email, list);
    }
  }
  return index;
}

export function extractRows(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  if (input && typeof input === "object") {
    const object = input as Record<string, unknown>;
    if (Array.isArray(object.data)) return object.data;
    if (Array.isArray(object.users)) return object.users;
  }
  return [];
}

function parseGreenhouseUser(input: unknown): GreenhouseUserMatch | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const row = input as Record<string, unknown>;
  const emails = uniqueStrings([
    ...emailValues(row.email),
    ...emailValues(row.primary_email),
    ...emailValues(row.work_email),
    ...emailValues(row.emails),
    ...emailValues(row.email_addresses),
  ].map(normalizeMaybeEmail).filter((value): value is string => Boolean(value)));
  if (emails.length === 0) return null;
  const id = parsePositiveId(row.id ?? row.user_id ?? row.greenhouse_user_id) ?? null;
  return { id, emails, inactive: isInactiveUser(row) };
}

function emailValues(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const object = entry as Record<string, unknown>;
        return [object.value, object.email, object.address];
      }
      return [entry];
    });
  }
  return [value];
}

function normalizeMaybeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized) ? normalized : null;
}

export function parsePositiveId(value: unknown): number | undefined {
  if (isSafePositiveGreenhouseUserId(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    if (isSafePositiveGreenhouseUserId(parsed)) return parsed;
  }
  return undefined;
}

export function isInactiveUser(row: Record<string, unknown>): boolean {
  if (row.disabled === true || row.deactivated === true || row.is_disabled === true) return true;
  if (row.active === false) return true;
  if (typeof row.status === "string") {
    const status = row.status.trim().toLowerCase();
    return status === "disabled" || status === "deactivated" || status === "inactive";
  }
  return false;
}

function parseIdentityBootstrapArgs(args: string[]): { emailsFile: string; greenhouseUsersFile: string; out?: string; apply: boolean } {
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (!arg?.startsWith("--")) continue;
    const next = args[index + 1];
    if (!next || next.startsWith("--")) continue;
    values.set(arg.slice(2), next);
    index += 1;
  }
  const emailsFile = values.get("emails-file");
  const greenhouseUsersFile = values.get("greenhouse-users-file");
  if (!emailsFile || !greenhouseUsersFile) {
    throw new Error("Usage: greenhouse-recruiter-bootstrap-identity --emails-file recruiters.txt --greenhouse-users-file greenhouse-users.json [--out identity-bootstrap-plan.json] [--apply]");
  }
  return { emailsFile, greenhouseUsersFile, out: values.get("out"), apply };
}

function parseAllowedDomains(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required when --apply is used.`);
  return value;
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startIdentityBootstrapCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[greenhouse-recruiter-bootstrap-identity] ${message}\n`);
    process.exit(1);
  });
}
