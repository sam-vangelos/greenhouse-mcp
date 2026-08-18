import { issueActionSession, MAX_SESSION_TTL_MS } from "./crypto.js";
import { readActionSigningSecret } from "./env.js";
import type { ActionClient } from "./types.js";

export function issueSessionFromArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now()
): Record<string, unknown> {
  const subject = readFlag(args, "--subject");
  const client = (readOptionalFlag(args, "--client") ?? "codex") as ActionClient;
  if (client !== "codex" && client !== "claude_code" && client !== "claude_desktop_chat" && client !== "test") throw new Error("--client must be codex, claude_code, claude_desktop_chat, or test.");
  if (env.NODE_ENV === "production" && client === "test") throw new Error("Test action sessions are forbidden in production.");
  const ttlMinutesRaw = readOptionalFlag(args, "--ttl-minutes") ?? "43200";
  if (!/^[1-9]\d*$/.test(ttlMinutesRaw)) throw new Error("--ttl-minutes must be a positive integer.");
  const ttlMs = Number(ttlMinutesRaw) * 60_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs > MAX_SESSION_TTL_MS) throw new Error("--ttl-minutes cannot exceed 43200 (30 days).");
  const issued = issueActionSession({ subject, client, ttlMs, nowMs }, readActionSigningSecret(env));
  return {
    token: issued.token,
    token_id: issued.session.tokenId,
    client,
    issued_at: new Date(issued.session.issuedAtMs).toISOString(),
    expires_at: new Date(issued.session.expiresAtMs).toISOString(),
  };
}

function readFlag(args: string[], name: string): string {
  const value = readOptionalFlag(args, name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function readOptionalFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--") || value.trim() !== value) throw new Error(`${name} requires a trimmed value.`);
  if (args.indexOf(name, index + 1) >= 0) throw new Error(`${name} may be provided only once.`);
  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.stdout.write(`${JSON.stringify(issueSessionFromArgs(process.argv.slice(2)))}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Could not issue action session.");
    process.exitCode = 1;
  }
}
