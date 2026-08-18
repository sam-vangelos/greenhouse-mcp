export const GREENHOUSE_RECRUITER_STATE_BACKEND_ENV = "GREENHOUSE_RECRUITER_STATE_BACKEND";
export const SUPPORTED_STATE_BACKEND = "supabase_postgrest";

export type RecruiterStateBackend = typeof SUPPORTED_STATE_BACKEND;

export function readRecruiterStateBackend(
  env: NodeJS.ProcessEnv = process.env
): RecruiterStateBackend | undefined {
  const raw = env[GREENHOUSE_RECRUITER_STATE_BACKEND_ENV];
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  if (raw.trim() !== raw) {
    throw new Error(`${GREENHOUSE_RECRUITER_STATE_BACKEND_ENV} must not contain leading or trailing whitespace.`);
  }
  if (raw === SUPPORTED_STATE_BACKEND) {
    return raw;
  }
  throw new Error(
    `${GREENHOUSE_RECRUITER_STATE_BACKEND_ENV}=${raw} is not implemented. Supported value: ${SUPPORTED_STATE_BACKEND}.`
  );
}

export function requireHostedRecruiterStateBackend(
  env: NodeJS.ProcessEnv = process.env
): RecruiterStateBackend {
  const backend = readRecruiterStateBackend(env);
  if (backend !== SUPPORTED_STATE_BACKEND) {
    throw new Error(`${GREENHOUSE_RECRUITER_STATE_BACKEND_ENV}=${SUPPORTED_STATE_BACKEND} is required for hosted recruiter MCP state.`);
  }
  return backend;
}
