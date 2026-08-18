import { createSessionValidatorFromEnv, type SessionValidationResult } from "./auth.js";
import { createIdentityDirectoryFromEnv, isSafePositiveGreenhouseUserId, type IdentityDirectory } from "./identity.js";
import type { AuthenticatedSession, RecruiterSurface } from "./types.js";

export type IdentityResolutionCheckStatus =
  | "resolved"
  | "invalid_session"
  | "unresolved"
  | "ambiguous"
  | "invalid_identity"
  | "lookup_failed";

export interface IdentityResolutionCheckReport {
  ok: boolean;
  status: IdentityResolutionCheckStatus;
  checkedAt: string;
  surface?: RecruiterSurface;
  subjectPresent: boolean;
  emailPresent: boolean;
  greenhouseUserId?: number;
  greenhouseUserIds?: number[];
  reason?: string;
}

export interface IdentityResolutionCheckOptions {
  session: AuthenticatedSession;
  directory: IdentityDirectory;
  now?: () => Date;
}

export interface IdentityResolutionCheckFromEnvOptions {
  env?: NodeJS.ProcessEnv;
  token?: string;
  now?: () => Date;
}

export async function runIdentityResolutionCheck(
  options: IdentityResolutionCheckOptions
): Promise<IdentityResolutionCheckReport> {
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const base = reportBase(checkedAt, options.session);
  try {
    const resolution = await options.directory.resolve(options.session);
    if (resolution.status === "resolved") {
      if (!isSafePositiveGreenhouseUserId(resolution.greenhouseUserId)) {
        return {
          ...base,
          ok: false,
          status: "invalid_identity",
          reason: "Identity directory returned an invalid Greenhouse user id.",
        };
      }
      return {
        ...base,
        ok: true,
        status: "resolved",
        greenhouseUserId: resolution.greenhouseUserId,
      };
    }
    if (resolution.status === "ambiguous") {
      return {
        ...base,
        ok: false,
        status: "ambiguous",
        greenhouseUserIds: resolution.greenhouseUserIds,
        reason: resolution.reason,
      };
    }
    if (resolution.status === "invalid") {
      return {
        ...base,
        ok: false,
        status: "invalid_identity",
        reason: resolution.reason,
      };
    }
    return {
      ...base,
      ok: false,
      status: "unresolved",
      reason: resolution.reason,
    };
  } catch {
    return {
      ...base,
      ok: false,
      status: "lookup_failed",
      reason: identityLookupFailureReason(),
    };
  }
}

export async function runIdentityResolutionCheckFromEnv(
  options: IdentityResolutionCheckFromEnvOptions = {}
): Promise<IdentityResolutionCheckReport> {
  const env = options.env ?? process.env;
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const sessionResult = await validateSession(env, options.token);
  if (sessionResult.status !== "valid") {
    return {
      ok: false,
      status: "invalid_session",
      checkedAt,
      subjectPresent: false,
      emailPresent: false,
      reason: sessionResult.reason,
    };
  }
  try {
    const directory = createIdentityDirectoryFromEnv(env);
    return runIdentityResolutionCheck({
      session: sessionResult.session,
      directory,
      now: () => new Date(checkedAt),
    });
  } catch {
    return {
      ...reportBase(checkedAt, sessionResult.session),
      ok: false,
      status: "lookup_failed",
      reason: identityLookupFailureReason(),
    };
  }
}

export async function startIdentityResolutionCheckCli(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv.slice(2)
): Promise<void> {
  const report = await runIdentityResolutionCheckFromEnv({
    env,
    token: readTokenArg(args),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

async function validateSession(
  env: NodeJS.ProcessEnv,
  tokenOverride: string | undefined
): Promise<SessionValidationResult> {
  const validator = createSessionValidatorFromEnv(env);
  if ("status" in validator) return validator;
  return validator.validate(tokenOverride ?? env.GREENHOUSE_RECRUITER_SESSION_TOKEN);
}

function reportBase(checkedAt: string, session: AuthenticatedSession) {
  return {
    checkedAt,
    surface: session.surface,
    subjectPresent: Boolean(session.subject),
    emailPresent: Boolean(session.email),
  };
}

function readTokenArg(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if ((arg === "--token" || arg === "-t") && args[index + 1]) {
      return args[index + 1];
    }
  }
  return undefined;
}

function identityLookupFailureReason(): string {
  return "Identity directory lookup failed before a resolved Greenhouse actor could be verified.";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startIdentityResolutionCheckCli().catch(() => {
    process.stderr.write("[greenhouse-recruiter-check-identity] failed before a report could be written.\n");
    process.exit(1);
  });
}
