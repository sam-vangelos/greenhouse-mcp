export const RECRUITER_BOOLEAN_ENV_FLAGS = [
  "GREENHOUSE_RECRUITER_ALLOW_PUBLIC_READYZ_FOR_DEV",
  "GREENHOUSE_RECRUITER_ALLOW_STATIC_IDENTITY_FOR_DEV",
  "GREENHOUSE_RECRUITER_ALLOW_TEST_SURFACE",
  "GREENHOUSE_RECRUITER_DISABLE_ANALYTICS",
  "GREENHOUSE_RECRUITER_DISABLE_CHATGPT_DESKTOP",
  "GREENHOUSE_RECRUITER_DISABLE_CLAUDE_DESKTOP",
  "GREENHOUSE_RECRUITER_DISABLE_EVIDENCE",
  "GREENHOUSE_RECRUITER_DISABLE_OPERATOR_UNSCOPED",
  "GREENHOUSE_RECRUITER_FORCE_PERMISSION_TTL_ZERO",
  "GREENHOUSE_RECRUITER_LEAKAGE_STRICT",
  "GREENHOUSE_RECRUITER_MCP_DISABLED",
  "GREENHOUSE_RECRUITER_PROBE_STRICT",
  "GREENHOUSE_RECRUITER_RATE_LIMIT_DISABLED",
] as const;

export function readBooleanEnvFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name];
  if (raw === undefined || raw.length === 0) return false;
  if (raw !== raw.trim() || (raw !== "true" && raw !== "false")) {
    throw new Error(`${name} must be exactly "true" or "false" without whitespace.`);
  }
  return raw === "true";
}

export function validateBooleanEnvFlags(
  env: NodeJS.ProcessEnv,
  names: readonly string[] = RECRUITER_BOOLEAN_ENV_FLAGS
): void {
  for (const name of names) {
    readBooleanEnvFlag(env, name);
  }
}
