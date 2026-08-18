import { createAuditSinkFromEnv, createCountingAuditSink, createMemoryAuditSink, type AuditSink } from "./audit.js";
import { readSessionFromEnv } from "./auth.js";
import { createIdentityDirectoryFromEnv } from "./identity.js";
import { createRecruiterToolConfig, createRecruiterToolLimits } from "./limits.js";
import { createRecruiterToolRuntime } from "./runtime.js";
import { configureGreenhouseFromEnv, createProductionScopedReader } from "./scoped-reader.js";
import { readBooleanEnvFlag } from "./env.js";
import { isSafePositiveGreenhouseUserId } from "./identity.js";
import { runEvidenceTool } from "./tools/evidence.js";
import type { AuthenticatedSession, RecruiterToolResult, ScopedReaderLike } from "./types.js";
import { readBuildCommit } from "./version.js";

export type LeakageSampleStatus = "pass" | "fail" | "warn" | "skip";

export interface LeakageSampleCheck {
  name: string;
  status: LeakageSampleStatus;
  summary: string;
  details?: Record<string, unknown>;
}

export interface ScopeLeakageSampleReport {
  ok: boolean;
  strict: boolean;
  generatedAt: string;
  surface: AuthenticatedSession["surface"] | null;
  client: AuthenticatedSession["client"] | null;
  sessionSubjectPresent: boolean;
  actAsUser: number | null;
  checks: LeakageSampleCheck[];
  auditEventCount: number;
  buildCommit: string;
}

export interface ScopeLeakageSampleOptions {
  session: AuthenticatedSession;
  scopedReader: ScopedReaderLike<AuthenticatedSession>;
  actAsUser: number;
  expectedScopedJobIds?: number[];
  forbiddenJobIds?: number[];
  perPage?: number;
  strict?: boolean;
  env?: NodeJS.ProcessEnv;
  auditSink?: AuditSink;
  now?: () => number;
}

const DEFAULT_SAMPLE_PER_PAGE = 50;

export async function runScopeLeakageSample(
  options: ScopeLeakageSampleOptions
): Promise<ScopeLeakageSampleReport> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Date.now());
  const strict = options.strict ?? readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_LEAKAGE_STRICT");
  // Wrap whatever sink is configured (env file/console sink in production, memory sink in tests) so we
  // can report the ACTUAL number of audit events emitted for any sink type. The prior code reported
  // auditSink.events.length only for the memory sink and silently substituted checks.length for the
  // production file sink — a fabricated number unrelated to the persisted audit trail.
  const auditSink = createCountingAuditSink(options.auditSink ?? createMemoryAuditSink());
  const perPage = Math.max(1, Math.min(options.perPage ?? DEFAULT_SAMPLE_PER_PAGE, 100));
  const checks: LeakageSampleCheck[] = [];

  const operatorRuntime = createRecruiterToolRuntime({
    session: options.session,
    scopedReader: options.scopedReader,
    auditSink,
    limits: createRecruiterToolLimits(env),
    toolConfig: createRecruiterToolConfig(env),
    now,
  });
  const previewRuntime = createRecruiterToolRuntime({
    session: options.session,
    scopedReader: options.scopedReader,
    auditSink,
    limits: createRecruiterToolLimits(env),
    toolConfig: createRecruiterToolConfig(env),
    trustedActAsUser: options.actAsUser,
    now,
  });

  // Bounded SAMPLE reads (a leak check compares an unscoped vs a scoped job sample). Use the sample
  // path so each stays a single page — without it, read-all full-scans every job for the operator
  // runtime, a needlessly heavy read for a comparison that only needs a representative page.
  const unscopedJobs = await runEvidenceTool(operatorRuntime, "search_my_jobs", { per_page: perPage }, { sample: true });
  const scopedJobs = await runEvidenceTool(previewRuntime, "search_my_jobs", { per_page: perPage }, { sample: true });
  checks.push(unscopedSampleCheck(unscopedJobs));
  checks.push(scopedPreviewCheck(scopedJobs, options.actAsUser));
  checks.push(sampleComparisonCheck(unscopedJobs, scopedJobs));

  for (const jobId of options.expectedScopedJobIds ?? []) {
    checks.push(await expectedScopedJobCheck(previewRuntime, jobId));
  }
  for (const jobId of options.forbiddenJobIds ?? []) {
    checks.push(await forbiddenJobLeakageCheck(operatorRuntime, previewRuntime, jobId));
  }
  if (strict) {
    checks.push(...strictLeakageChecks(scopedJobs, options.forbiddenJobIds ?? []));
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    strict,
    generatedAt: new Date(now()).toISOString(),
    surface: options.session.surface,
    client: options.session.client ?? null,
    sessionSubjectPresent: Boolean(options.session.subject),
    actAsUser: options.actAsUser,
    checks,
    auditEventCount: auditSink.count,
    buildCommit: readBuildCommit(env),
  };
}

export async function runScopeLeakageSampleFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = () => Date.now()
): Promise<ScopeLeakageSampleReport> {
  const sessionResult = await readSessionFromEnv(env);
  if (sessionResult.status !== "valid") {
    return failedStartupReport(now, env, "session_validation", startupFailureSummary("session_validation"));
  }
  const actAsUser = readPositiveInteger(env.GREENHOUSE_RECRUITER_LEAKAGE_ACT_AS_USER_ID);
  if (actAsUser === null) {
    return failedStartupReport(now, env, "act_as_user_required", "GREENHOUSE_RECRUITER_LEAKAGE_ACT_AS_USER_ID must be a positive Greenhouse user id.", sessionResult.session);
  }

  try {
    configureGreenhouseFromEnv(env);
    const identityDirectory = createIdentityDirectoryFromEnv(env);
    const scopedReader = createProductionScopedReader(identityDirectory, env);
    return await runScopeLeakageSample({
      session: sessionResult.session,
      scopedReader,
      actAsUser,
      expectedScopedJobIds: parseIdList(env.GREENHOUSE_RECRUITER_LEAKAGE_EXPECT_JOB_IDS),
      forbiddenJobIds: parseIdList(env.GREENHOUSE_RECRUITER_LEAKAGE_FORBIDDEN_JOB_IDS),
      perPage: readPositiveInteger(env.GREENHOUSE_RECRUITER_LEAKAGE_PER_PAGE) ?? DEFAULT_SAMPLE_PER_PAGE,
      strict: readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_LEAKAGE_STRICT"),
      env,
      auditSink: createAuditSinkFromEnv(env),
      now,
    });
  } catch (error) {
    return failedStartupReport(now, env, "leakage_sample_startup", startupFailureSummary("leakage_sample_startup"), sessionResult.session);
  }
}

export async function startScopeLeakageSampleCli(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const report = await runScopeLeakageSampleFromEnv(env);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

function unscopedSampleCheck(result: RecruiterToolResult): LeakageSampleCheck {
  if (!result.ok) return denialCheck("operator_unscoped_sample", result);
  const rows = rowsFrom(result.data);
  const pass = result.scoped === false && result.permissionScope?.kind === "operator";
  return {
    name: "operator_unscoped_sample",
    status: pass ? "pass" : "fail",
    summary: pass ? "Operator unscoped sample returned through the operator scope." : "Operator sample was not unscoped; check OPERATOR_ACTOR_IDS and session identity.",
    details: {
      rowsReturned: rows.length,
      jobIds: rows.map((row) => readPositiveInteger(row.id)).filter((id): id is number => id !== null),
      scoped: result.scoped,
      permissionScopeKind: result.permissionScope?.kind ?? "unknown",
    },
  };
}

function scopedPreviewCheck(result: RecruiterToolResult, actAsUser: number): LeakageSampleCheck {
  if (!result.ok) return denialCheck("act_as_user_scoped_sample", result, { actAsUser });
  const rows = rowsFrom(result.data);
  const previewed = result.effectiveActorId === actAsUser && result.permissionScope?.kind !== "operator";
  return {
    name: "act_as_user_scoped_sample",
    status: previewed ? "pass" : "fail",
    summary: previewed ? "Operator actAsUser sample used the recruiter's scoped view." : "Operator actAsUser sample did not use the target recruiter's scoped view.",
    details: {
      actAsUser,
      effectiveActorId: result.effectiveActorId ?? null,
      rowsReturned: rows.length,
      jobIds: rows.map((row) => readPositiveInteger(row.id)).filter((id): id is number => id !== null),
      scoped: result.scoped,
      permissionScopeKind: result.permissionScope?.kind ?? "unknown",
      permittedJobCount: result.permissionScope?.kind === "jobs" ? result.permissionScope.permittedJobCount : null,
    },
  };
}

function sampleComparisonCheck(unscoped: RecruiterToolResult, scoped: RecruiterToolResult): LeakageSampleCheck {
  if (!unscoped.ok || !scoped.ok) {
    return { name: "sample_comparison", status: "skip", summary: "Sample comparison skipped because one of the samples did not return data." };
  }
  const unscopedIds = new Set(jobIdsFrom(unscoped.data));
  const scopedIds = jobIdsFrom(scoped.data);
  const scopedIdsMissingFromUnscoped = scopedIds.filter((jobId) => !unscopedIds.has(jobId));
  return {
    name: "sample_comparison",
    status: scopedIdsMissingFromUnscoped.length === 0 ? "pass" : "fail",
    summary: scopedIdsMissingFromUnscoped.length === 0 ? "Scoped sample job ids were a subset of the operator sample." : "Scoped sample included job ids missing from the operator sample.",
    details: {
      unscopedRowsReturned: unscopedIds.size,
      scopedRowsReturned: scopedIds.length,
      scopedIdsMissingFromUnscoped,
    },
  };
}

async function expectedScopedJobCheck(
  previewRuntime: ReturnType<typeof createRecruiterToolRuntime>,
  jobId: number
): Promise<LeakageSampleCheck> {
  const result = await runEvidenceTool(previewRuntime, "get_my_job", { id: jobId });
  if (!result.ok) return denialCheck("expected_scoped_job_visibility", result, { jobId });
  const visible = isRecord(result.data) && readPositiveInteger(result.data.id) === jobId;
  return {
    name: "expected_scoped_job_visibility",
    status: visible ? "pass" : "fail",
    summary: visible ? "Expected scoped job is visible in actAsUser preview." : "Expected scoped job was not visible in actAsUser preview.",
    details: { jobId },
  };
}

async function forbiddenJobLeakageCheck(
  operatorRuntime: ReturnType<typeof createRecruiterToolRuntime>,
  previewRuntime: ReturnType<typeof createRecruiterToolRuntime>,
  jobId: number
): Promise<LeakageSampleCheck> {
  const unscoped = await runEvidenceTool(operatorRuntime, "get_my_job", { id: jobId });
  const scoped = await runEvidenceTool(previewRuntime, "get_my_job", { id: jobId });
  const unscopedVisible = unscoped.ok && isRecord(unscoped.data) && readPositiveInteger(unscoped.data.id) === jobId;
  const scopedVisible = scoped.ok && isRecord(scoped.data) && readPositiveInteger(scoped.data.id) === jobId;
  const pass = unscopedVisible && !scopedVisible;
  return {
    name: "forbidden_job_leakage",
    status: pass ? "pass" : "fail",
    summary: pass ? "Known forbidden job is visible to operator but hidden from actAsUser scoped preview." : "Known forbidden job did not prove scoped exclusion.",
    details: {
      jobId,
      unscopedVisible,
      scopedVisible,
      unscopedDenialCode: unscoped.ok ? null : unscoped.denial.code,
      scopedDenialCode: scoped.ok ? null : scoped.denial.code,
    },
  };
}

function strictLeakageChecks(scoped: RecruiterToolResult, forbiddenJobIds: number[]): LeakageSampleCheck[] {
  const checks: LeakageSampleCheck[] = [];
  if (forbiddenJobIds.length === 0) {
    checks.push({
      name: "strict_forbidden_job_ids_required",
      status: "fail",
      summary: "Strict leakage sampling requires GREENHOUSE_RECRUITER_LEAKAGE_FORBIDDEN_JOB_IDS for at least one known-unassigned req.",
    });
  }
  if (scoped.ok && scoped.permissionScope?.kind !== "jobs") {
    checks.push({
      name: "strict_target_scope_limited",
      status: "fail",
      summary: "Strict leakage sampling requires a target recruiter with job-scoped permissions, not all-jobs access.",
      details: { permissionScopeKind: scoped.permissionScope?.kind ?? "unknown" },
    });
  }
  return checks;
}

function denialCheck(name: string, result: RecruiterToolResult, details: Record<string, unknown> = {}): LeakageSampleCheck {
  return {
    name,
    status: "fail",
    summary: result.ok ? "Unexpected successful result was passed to denialCheck." : result.denial.message,
    details: {
      ...details,
      denialCode: result.ok ? null : result.denial.code,
    },
  };
}

function failedStartupReport(now: () => number, env: NodeJS.ProcessEnv, name: string, summary: string, session?: AuthenticatedSession): ScopeLeakageSampleReport {
  return {
    ok: false,
    strict: false,
    generatedAt: new Date(now()).toISOString(),
    surface: session?.surface ?? null,
    client: session?.client ?? null,
    sessionSubjectPresent: Boolean(session?.subject),
    actAsUser: null,
    checks: [{ name, status: "fail", summary }],
    auditEventCount: 0,
    buildCommit: readBuildCommit(env),
  };
}

function startupFailureSummary(name: string): string {
  if (name === "session_validation") {
    return "Recruiter MCP session could not be validated; no scope leakage checks ran.";
  }
  return "Scope leakage sample startup failed before scoped evidence checks could run.";
}

function rowsFrom(data: unknown): Record<string, unknown>[] {
  return Array.isArray(data) ? data.filter(isRecord) : [];
}

function jobIdsFrom(data: unknown): number[] {
  return rowsFrom(data).map((row) => readPositiveInteger(row.id)).filter((id): id is number => id !== null);
}

export function parseIdList(raw: string | undefined): number[] {
  if (!raw) return [];
  const ids = new Set<number>();
  for (const token of raw.split(",")) {
    const id = readPositiveInteger(token.trim());
    if (id !== null) ids.add(id);
  }
  return [...ids];
}

function readPositiveInteger(value: unknown): number | null {
  if (isSafePositiveGreenhouseUserId(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return isSafePositiveGreenhouseUserId(parsed) ? parsed : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startScopeLeakageSampleCli().catch((error) => {
    process.stderr.write("[greenhouse-recruiter-sample-leakage] failed before a report could be written.\n");
    process.exit(1);
  });
}
