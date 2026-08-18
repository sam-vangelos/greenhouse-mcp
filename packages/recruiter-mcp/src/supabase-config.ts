const SUPABASE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function normalizeSupabaseApiKey(value: string | undefined, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} API key is required.`);
  }
  if (value.trim() !== value) {
    throw new Error(`${label} API key must not contain leading or trailing whitespace.`);
  }
  return value;
}

export function normalizeSupabaseRestOrigin(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} URL is required.`);
  }
  if (trimmed !== value) {
    throw new Error(`${label} URL must not contain leading or trailing whitespace.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} URL must be a valid HTTPS origin.`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${label} URL must be a valid HTTPS origin.`);
  }
  return url.origin;
}

// The scoped Greenhouse MCP's identity directory and session revocation list live in ONE
// dedicated Supabase project. Pointing a runtime/operator Supabase URL at any other project
// silently breaks the access-control keystone: the identity lookup reads PII from the wrong
// store, and (worse) the revocation kill-switch reads from a project that does not hold the
// revocations, so deactivated sessions stay alive. Shape validation alone (above) does not
// catch this — these helpers extract the project ref from the host and assert it is canonical.
// The deployment's dedicated project ref. Override per environment; the default is a
// placeholder with the right shape so tests and docs stay runnable.
export const CANONICAL_SUPABASE_PROJECT_REF =
  process.env.GREENHOUSE_RECRUITER_SUPABASE_PROJECT_REF?.trim() || "exampleprojectref000";
export const CANONICAL_SUPABASE_PROJECT_NAME = "Greenhouse MCP";
export const CANONICAL_SUPABASE_REST_ORIGIN = `https://${CANONICAL_SUPABASE_PROJECT_REF}.supabase.co`;

// Refs that are emphatically NOT this MCP's project, named so the failure message is actionable.
const KNOWN_WRONG_SUPABASE_PROJECTS = new Map<string, string>([
  ["otherprojectref00000", "recruiting-ops-analytics"],
]);

// Supabase REST origins are https://<ref>.supabase.co; the project ref is the leading host label.
// Returns undefined for any host that is not a *.supabase.co project origin (e.g. a custom domain).
export function extractSupabaseProjectRef(origin: string): string | undefined {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  const match = /^([a-z0-9]+)\.supabase\.co$/.exec(host);
  return match ? match[1] : undefined;
}

// Validates URL shape (via normalizeSupabaseRestOrigin, so shape errors surface first) AND that the
// host resolves to the canonical Greenhouse MCP project. Use this on every runtime/operator path
// that reads a Supabase URL from the environment; the bare normalizer stays shape-only for the test
// seam and for any non-canonical-but-well-formed URL a unit test constructs directly.
export function assertCanonicalSupabaseProjectRef(value: string, label: string): string {
  const origin = normalizeSupabaseRestOrigin(value, label);
  const ref = extractSupabaseProjectRef(origin);
  if (ref === CANONICAL_SUPABASE_PROJECT_REF) {
    return origin;
  }
  const wrongName = ref ? KNOWN_WRONG_SUPABASE_PROJECTS.get(ref) : undefined;
  const got = wrongName
    ? `the ${wrongName} project (ref ${ref})`
    : ref
      ? `project ref ${ref}`
      : "a host with no recognizable Supabase project ref";
  throw new Error(
    `${label} URL must point at the canonical ${CANONICAL_SUPABASE_PROJECT_NAME} Supabase project ` +
      `(ref ${CANONICAL_SUPABASE_PROJECT_REF}); got ${got}. ` +
      `Set it to ${CANONICAL_SUPABASE_REST_ORIGIN}.`,
  );
}

export function normalizeSupabaseIdentifier(value: string, label: string): string {
  if (value.trim() !== value) {
    throw new Error(`${label} must not contain leading or trailing whitespace.`);
  }
  if (!SUPABASE_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label} must contain only letters, numbers, and underscores, and must start with a letter or underscore.`);
  }
  return value;
}

export function normalizeOptionalSupabaseIdentifier(
  value: string | undefined,
  fallback: string,
  label: string
): string {
  return normalizeSupabaseIdentifier(value === undefined || value.length === 0 ? fallback : value, label);
}
