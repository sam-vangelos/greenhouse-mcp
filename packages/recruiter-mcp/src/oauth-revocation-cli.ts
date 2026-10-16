import { revokeOauthGrants, type OauthRevocationAccess, type OauthRevocationOutcome } from "./oauth-grant-store.js";
import { assertCanonicalSupabaseProjectRef, normalizeSupabaseApiKey } from "./supabase-config.js";

// greenhouse-recruiter-revoke-oauth: end a hosted-Claude (OAuth) session for good (CLO-272).
//
// `greenhouse-recruiter-revoke-session --token-id` kills one access-token jti and, since migration
// 0007, that alone is enough to make the family refuse its next refresh — but the operator usually
// knows an EMAIL, not a jti. This CLI revokes every live refresh family of an email (or one family
// by id) under the family lock and copies every jti those families minted into the revocation
// list, so the session is dead now, not at its next rotation.
//
// Access: the OAuth Supabase pair when the shell has it, else the identity pair — both name the
// same canonical project (assertCanonicalSupabaseProjectRef), and the RPCs live in that project.

export interface OauthRevocationCliArgs {
  email?: string;
  familyId?: string;
  reason?: string;
  revokedBy?: string;
}

export function parseOauthRevocationArgs(args: string[]): OauthRevocationCliArgs {
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
  const familyId = values.get("family-id");
  if ((email && familyId) || (!email && !familyId)) {
    throw new Error(
      "Usage: greenhouse-recruiter-revoke-oauth (--email recruiter@example.com | --family-id <family uuid>) [--reason reason] [--revoked-by ops@example.com]. " +
        "Revokes every live OAuth refresh family of the email (or the one family) and puts every access-token jti they minted on the revocation list."
    );
  }
  return {
    ...(email ? { email } : {}),
    ...(familyId ? { familyId } : {}),
    ...(values.get("reason") ? { reason: values.get("reason") } : {}),
    ...(values.get("revoked-by") ? { revokedBy: values.get("revoked-by") } : {}),
  };
}

export function readOauthRevocationAccessFromEnv(env: NodeJS.ProcessEnv): OauthRevocationAccess {
  const pairs: Array<[string, string]> = [
    ["GREENHOUSE_RECRUITER_OAUTH_SUPABASE_URL", "GREENHOUSE_RECRUITER_OAUTH_SUPABASE_KEY"],
    ["GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL", "GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY"],
  ];
  for (const [urlName, keyName] of pairs) {
    const url = env[urlName];
    const key = env[keyName];
    if (url && key) {
      return {
        supabaseUrl: assertCanonicalSupabaseProjectRef(url, "Supabase OAuth grants"),
        apiKey: normalizeSupabaseApiKey(key, "Supabase OAuth grants"),
      };
    }
  }
  throw new Error(
    "Set GREENHOUSE_RECRUITER_OAUTH_SUPABASE_URL + _KEY (or the GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL + _KEY pair for the same project) to revoke OAuth grants."
  );
}

export async function revokeOauthGrantsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv.slice(2),
  fetchImpl?: typeof fetch
): Promise<OauthRevocationOutcome & { target: OauthRevocationCliArgs; containsTokens: false }> {
  const parsed = parseOauthRevocationArgs(args);
  const access = readOauthRevocationAccessFromEnv(env);
  const outcome = await revokeOauthGrants(
    { ...access, ...(fetchImpl ? { fetchImpl } : {}) },
    {
      ...(parsed.email ? { email: parsed.email } : {}),
      ...(parsed.familyId ? { familyId: parsed.familyId } : {}),
      reason: parsed.reason ?? "operator_revocation",
      ...(parsed.revokedBy ? { revokedBy: parsed.revokedBy } : {}),
    }
  );
  return { ...outcome, target: parsed, containsTokens: false };
}

export async function startOauthRevocationCli(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv.slice(2)
): Promise<void> {
  try {
    const report = await revokeOauthGrantsFromEnv(env, args);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== "revoked") process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[greenhouse-recruiter-revoke-oauth] ${message}\n`);
    process.exitCode = 1;
  }
}
