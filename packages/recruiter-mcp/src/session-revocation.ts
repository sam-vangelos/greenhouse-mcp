import { assertCanonicalSupabaseProjectRef, normalizeOptionalSupabaseIdentifier, normalizeSupabaseApiKey, normalizeSupabaseIdentifier, normalizeSupabaseRestOrigin } from "./supabase-config.js";
import { normalizeSessionTokenId } from "./auth.js";

export interface SessionRevocationWriteConfig {
  supabaseUrl: string;
  apiKey: string;
  table?: string;
  columns?: Partial<SessionRevocationWriteColumns>;
  fetchImpl?: typeof fetch;
  revokedAt?: string;
}

export interface SessionRevocationWriteColumns {
  tokenId: string;
  status: string;
  revokedAt: string;
  revokedBy: string;
  reason: string;
  evidenceDetail: string;
}

export interface RecordSessionRevocationOptions {
  tokenId: string;
  revokedBy?: string;
  reason?: string;
}

export interface SessionRevocationWriteReport {
  ok: true;
  revokedAt: string;
  table: string;
  tokenId: string;
  status: "revoked";
  revokedBy: string | null;
  reason: string | null;
  containsTokens: false;
}

const DEFAULT_REVOCATION_WRITE_COLUMNS: SessionRevocationWriteColumns = {
  tokenId: "token_id",
  status: "status",
  revokedAt: "revoked_at",
  revokedBy: "revoked_by",
  reason: "reason",
  evidenceDetail: "evidence_detail",
};

export async function recordSessionRevocation(
  config: SessionRevocationWriteConfig,
  options: RecordSessionRevocationOptions
): Promise<SessionRevocationWriteReport> {
  const tokenId = normalizeRevocationTokenId(options.tokenId);
  const baseUrl = normalizeSupabaseRestOrigin(config.supabaseUrl, "Supabase session revocation");
  const apiKey = normalizeSupabaseApiKey(config.apiKey, "Supabase session revocation");

  const table = normalizeOptionalSupabaseIdentifier(config.table, "recruiter_mcp_session_revocation", "Supabase session revocation table");
  const columns = mergeRevocationColumns(config.columns);
  const revokedAt = config.revokedAt ?? new Date().toISOString();
  const revokedBy = normalizeOptionalText(options.revokedBy);
  const reason = normalizeOptionalText(options.reason);
  const url = new URL(`${baseUrl}/rest/v1/${encodeURIComponent(table)}`);
  url.searchParams.set("on_conflict", columns.tokenId);

  const row: Record<string, unknown> = {
    [columns.tokenId]: tokenId,
    [columns.status]: "revoked",
    [columns.revokedAt]: revokedAt,
    [columns.revokedBy]: revokedBy,
    [columns.reason]: reason,
    [columns.evidenceDetail]: {
      source: "greenhouse_recruiter_revoke_session_cli",
      contains_token_string: false,
    },
  };

  const response = await (config.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: {
      apikey: apiKey,
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify([row]),
  });

  if (!response.ok) {
    throw new Error(`Session revocation write failed with status ${response.status}.`);
  }

  return {
    ok: true,
    revokedAt,
    table,
    tokenId,
    status: "revoked",
    revokedBy,
    reason,
    containsTokens: false,
  };
}

export function normalizeRevocationTokenId(raw: string): string {
  try {
    return normalizeSessionTokenId(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/has no token id/.test(message)) throw new Error("A durable session token id is required.");
    if (/signed token string/.test(message)) throw new Error("Pass the durable session token id, not the signed session token string.");
    if (/scoped identity, permission, or expiry/.test(message)) throw new Error("A token id cannot contain scoped identity, permission, or expiry claim names.");
    if (/may contain only/.test(message)) throw new Error("A token id may contain only letters, numbers, colon, underscore, and hyphen, up to 160 characters.");
    throw error;
  }
}

export async function recordSessionRevocationFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv.slice(2)
): Promise<SessionRevocationWriteReport> {
  const parsed = parseSessionRevocationArgs(args);
  return recordSessionRevocation(
    {
      supabaseUrl: assertCanonicalSupabaseProjectRef(
        requireEnv(env, "GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL"),
        "Supabase session revocation",
      ),
      apiKey: requireEnv(env, "GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY"),
      table: env.GREENHOUSE_RECRUITER_REVOCATION_TABLE,
      columns: {
        tokenId: env.GREENHOUSE_RECRUITER_REVOCATION_TOKEN_ID_COLUMN,
        status: env.GREENHOUSE_RECRUITER_REVOCATION_STATUS_COLUMN,
        revokedAt: env.GREENHOUSE_RECRUITER_REVOCATION_REVOKED_AT_COLUMN,
        revokedBy: env.GREENHOUSE_RECRUITER_REVOCATION_REVOKED_BY_COLUMN,
        reason: env.GREENHOUSE_RECRUITER_REVOCATION_REASON_COLUMN,
        evidenceDetail: env.GREENHOUSE_RECRUITER_REVOCATION_EVIDENCE_DETAIL_COLUMN,
      },
    },
    parsed
  );
}

export async function startSessionRevocationCli(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv.slice(2)
): Promise<void> {
  try {
    const report = await recordSessionRevocationFromEnv(env, args);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[greenhouse-recruiter-revoke-session] ${message}\n`);
    process.exitCode = 1;
  }
}

function mergeRevocationColumns(
  overrides: Partial<SessionRevocationWriteColumns> | undefined
): SessionRevocationWriteColumns {
  const columns: SessionRevocationWriteColumns = { ...DEFAULT_REVOCATION_WRITE_COLUMNS };
  if (overrides) for (const [key, value] of Object.entries(overrides) as Array<[keyof SessionRevocationWriteColumns, string | undefined]>) {
    if (typeof value === "string" && value.length > 0) {
      columns[key] = value;
    }
  }
  columns.tokenId = normalizeSupabaseIdentifier(columns.tokenId, "Supabase session revocation token id column");
  columns.status = normalizeSupabaseIdentifier(columns.status, "Supabase session revocation status column");
  columns.revokedAt = normalizeSupabaseIdentifier(columns.revokedAt, "Supabase session revocation revoked-at column");
  columns.revokedBy = normalizeSupabaseIdentifier(columns.revokedBy, "Supabase session revocation revoked-by column");
  columns.reason = normalizeSupabaseIdentifier(columns.reason, "Supabase session revocation reason column");
  columns.evidenceDetail = normalizeSupabaseIdentifier(columns.evidenceDetail, "Supabase session revocation evidence-detail column");
  return columns;
}

function parseSessionRevocationArgs(args: string[]): RecordSessionRevocationOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith("--")) continue;
    const next = args[index + 1];
    if (!next || next.startsWith("--")) continue;
    values.set(arg.slice(2), next);
    index += 1;
  }
  const tokenId = values.get("token-id");
  if (!tokenId) {
    throw new Error("Usage: greenhouse-recruiter-revoke-session --token-id <durable-session-token-id> [--revoked-by ops@example.com] [--reason reason]");
  }
  return {
    tokenId,
    revokedBy: values.get("revoked-by"),
    reason: values.get("reason"),
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function normalizeOptionalText(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startSessionRevocationCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[greenhouse-recruiter-revoke-session] ${message}\n`);
    process.exit(1);
  });
}
