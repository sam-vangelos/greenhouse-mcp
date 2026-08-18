import { createMemoryAuditSink } from "./audit.js";
import { readSessionFromEnv } from "./auth.js";
import { createIdentityDirectoryFromEnv } from "./identity.js";
import { DEFAULT_LIMITS, createRecruiterToolConfig, createRecruiterToolLimits } from "./limits.js";
import { createRecruiterToolRuntime } from "./runtime.js";
import { configureGreenhouseFromEnv, createProductionScopedReader } from "./scoped-reader.js";
import { readBooleanEnvFlag } from "./env.js";
import { isSafePositiveGreenhouseUserId } from "./identity.js";
import { runEvidenceTool } from "./tools/evidence.js";
import { runInterviewFeedbackDrag } from "./tools/interview-feedback-drag.js";
// All probe evidence reads are bounded SAMPLES (reachability/shape checks), not full scans. Route
// them through the sample path so a list read stays a single page — without this, read-all would
// full-scan every permitted job per check (very heavy for an all-scope readiness probe). get_* reads
// are single-record already, so the flag is a no-op there.
function runEvidenceSampleRead(
  runtime: ReturnType<typeof createRecruiterToolRuntime>,
  toolName: string,
  params: Record<string, unknown>
): ReturnType<typeof runEvidenceTool> {
  return runEvidenceTool(runtime, toolName, params, { sample: true });
}
import { runPipelineQuality } from "./tools/pipeline-quality.js";
import { runRejectionReasonDrift } from "./tools/rejection-reason-drift.js";
import { runRecruitingQuestionAnswer } from "./tools/question-answer.js";
import { runScorecardAccountability } from "./tools/scorecard-accountability.js";
import { runSourceQuality } from "./tools/source-quality.js";
import { runStageLatency } from "./tools/stage-latency.js";
import type { AuthenticatedSession, RecruiterToolResult, ScopedReaderLike } from "./types.js";
import { readBuildCommit } from "./version.js";

export type ProbeStatus = "pass" | "fail" | "warn" | "skip";
export type RecruiterReadinessProbeProfile = "small_req_set" | "many_req_set" | "all_jobs_or_operator" | "no_permissions";

export interface ProbeCheck {
  name: string;
  status: ProbeStatus;
  summary: string;
  details?: Record<string, unknown>;
}

export interface RecruiterReadinessProbeReport {
  ok: boolean;
  strict: boolean;
  generatedAt: string;
  surface: AuthenticatedSession["surface"] | null;
  client: AuthenticatedSession["client"] | null;
  sessionSubjectPresent: boolean;
  sessionTokenId: string | null;
  sessionIssuedAt: string | null;
  checks: ProbeCheck[];
  auditEventCount: number;
  profile?: RecruiterReadinessProbeProfile;
  buildCommit: string;
}

export interface RecruiterReadinessProbeOptions {
  session: AuthenticatedSession;
  scopedReader: ScopedReaderLike<AuthenticatedSession>;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  expectedJobIds?: number[];
  forbiddenJobIds?: number[];
  strict?: boolean;
  expectVisibleData?: boolean;
  profile?: RecruiterReadinessProbeProfile;
}

const DEFAULT_SAMPLE_PER_PAGE = 25;

// Checks whose `details` carry a "rows that fed the analysis" denominator, paired with the detail key
// that holds it. When expectVisibleData is set (a profile the operator declares must carry data), a
// zero denominator flips the check to fail — symmetric to the gate's expectZeroVisibleJobs. This is
// the assertion that catches analyze_stage_latency reporting aging_applications:0 because a v3 field
// break dropped every row: without it the probe reports "analysis completed" → pass over empty data.
export const VISIBLE_DATA_DENOMINATORS: ReadonlyArray<readonly [string, string]> = [
  ["scoped_jobs_sample", "rowsReturned"],
  ["scoped_applications_sample", "rowsReturned"],
  ["scorecard_accountability_analysis", "totalScorecards"],
  ["interview_feedback_drag_analysis", "scorecardsConsidered"],
  ["stage_latency_analysis", "applicationsConsidered"],
  ["pipeline_quality_analysis", "applicationsConsidered"],
  ["source_quality_analysis", "applicationsConsidered"],
];

// The no-permissions profile proves zero visibility across every domain that can return recruiter
// data. This is intentionally broader than VISIBLE_DATA_DENOMINATORS: a normal recruiter may have
// no notes/rejections/scorecards, but a no-permissions recruiter must have zero in every one.
export const NO_PERMISSION_DATA_DENOMINATORS: ReadonlyArray<readonly [string, string]> = [
  ...VISIBLE_DATA_DENOMINATORS,
  ["candidate_shape_sample", "rowsReturned"],
  ["scorecard_shape_sample", "rowsReturned"],
  ["notes_visibility_sample", "rowsReturned"],
  ["rejection_reason_drift_analysis", "rejectionsConsidered"],
  ["question_planner_analysis", "rowsRead"],
  ["question_planner_analysis", "rowsConsidered"],
];

export async function runRecruiterReadinessProbe(
  options: RecruiterReadinessProbeOptions
): Promise<RecruiterReadinessProbeReport> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Date.now());
  const strict = options.strict ?? readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_PROBE_STRICT");
  const expectVisibleData = options.expectVisibleData ?? readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_PROBE_EXPECT_VISIBLE_DATA");
  const auditSink = createMemoryAuditSink();
  const configuredTools = createRecruiterToolConfig(env);
  const runtime = createRecruiterToolRuntime({
    session: options.session,
    scopedReader: options.scopedReader,
    auditSink,
    limits: createRecruiterToolLimits(env),
    // The allowlist controls model registration, not recipe/probe internals. Keep every other kill
    // switch (including per-tool containment) while allowing this operator-run probe to exercise the
    // hidden scoped readers that the visible analyzers depend on.
    toolConfig: { ...configuredTools, allowedTools: undefined },
    now,
  });
  const checks: ProbeCheck[] = [];

  checks.push(
    await sampleListCheck(runtime, "search_my_jobs", "scoped_jobs_sample", {
      per_page: DEFAULT_SAMPLE_PER_PAGE,
    })
  );
  checks.push(...await expectedJobChecks(runtime, options.expectedJobIds ?? []));
  checks.push(...await forbiddenJobChecks(runtime, options.forbiddenJobIds ?? []));
  checks.push(...await endpointContractChecks(runtime, options.expectedJobIds ?? [], options.forbiddenJobIds ?? []));
  checks.push(
    await sampleListCheck(runtime, "search_my_applications", "scoped_applications_sample", {
      per_page: DEFAULT_SAMPLE_PER_PAGE,
    })
  );
  checks.push(await candidateShapeCheck(runtime));
  checks.push(await scorecardShapeCheck(runtime));
  checks.push(await notesShapeCheck(runtime));
  checks.push(await scorecardAnalysisCheck(runtime));
  checks.push(await interviewFeedbackDragAnalysisCheck(runtime));
  checks.push(await stageLatencyAnalysisCheck(runtime));
  checks.push(await pipelineQualityAnalysisCheck(runtime));
  checks.push(await sourceQualityAnalysisCheck(runtime));
  checks.push(await rejectionReasonDriftAnalysisCheck(runtime));
  checks.push(await questionPlannerAnalysisCheck(runtime));
  checks.push({
    name: "activity_endpoint_shape",
    status: "skip",
    summary: "list_activity is intentionally not exposed in v1; run a separate live Harvest shape probe before adding activity-backed tools.",
  });
  if (strict) {
    checks.push(...strictProbeChecks(checks, options.expectedJobIds ?? [], options.forbiddenJobIds ?? []));
  }
  if (expectVisibleData) {
    applyExpectVisibleData(checks);
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    strict,
    generatedAt: new Date(now()).toISOString(),
    surface: options.session.surface,
    client: options.session.client ?? null,
    sessionSubjectPresent: Boolean(options.session.subject),
    sessionTokenId: options.session.tokenId ?? null,
    sessionIssuedAt: options.session.issuedAt ?? null,
    checks,
    auditEventCount: auditSink.events.length,
    buildCommit: readBuildCommit(env),
    ...(options.profile ? { profile: options.profile } : {}),
  };
}

export async function runRecruiterReadinessProbeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = () => Date.now()
): Promise<RecruiterReadinessProbeReport> {
  const sessionResult = await readSessionFromEnv(env);
  if (sessionResult.status !== "valid") {
    return failedStartupReport(now, env, "session_validation", startupFailureSummary("session_validation"));
  }

  try {
    configureGreenhouseFromEnv(env);
    const identityDirectory = createIdentityDirectoryFromEnv(env);
    const scopedReader = createProductionScopedReader(identityDirectory, env);
    return await runRecruiterReadinessProbe({
      session: sessionResult.session,
      scopedReader,
      env,
      now,
      expectedJobIds: parseIdList(env.GREENHOUSE_RECRUITER_PROBE_EXPECT_JOB_IDS),
      forbiddenJobIds: parseIdList(env.GREENHOUSE_RECRUITER_PROBE_FORBIDDEN_JOB_IDS),
      strict: readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_PROBE_STRICT"),
      expectVisibleData: readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_PROBE_EXPECT_VISIBLE_DATA"),
      profile: readProbeProfile(env.GREENHOUSE_RECRUITER_PROBE_PROFILE),
    });
  } catch (error) {
    return failedStartupReport(now, env, "probe_startup", startupFailureSummary("probe_startup"));
  }
}

function readProbeProfile(value: string | undefined): RecruiterReadinessProbeProfile | undefined {
  if (value === undefined) return undefined;
  if (value === "small_req_set" || value === "many_req_set" || value === "all_jobs_or_operator" || value === "no_permissions") {
    return value;
  }
  throw new Error("GREENHOUSE_RECRUITER_PROBE_PROFILE must name a supported rollout profile.");
}

export async function startRecruiterReadinessProbeCli(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const report = await runRecruiterReadinessProbeFromEnv(env);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

async function sampleListCheck(
  runtime: ReturnType<typeof createRecruiterToolRuntime>,
  toolName: string,
  checkName: string,
  params: Record<string, unknown>
): Promise<ProbeCheck> {
  const result = await runEvidenceSampleRead(runtime, toolName, params);
  if (!result.ok) {
    return denialCheck(checkName, result);
  }
  const rows = rowsFrom(result.data);
  return {
    name: checkName,
    status: "pass",
    summary: `Scoped ${toolName} returned ${rows.length} sampled row(s).`,
    details: {
      rowsReturned: rows.length,
      scoped: result.scoped,
      permissionScopeKind: result.permissionScope?.kind ?? "unknown",
      permittedJobCount: result.permissionScope?.kind === "jobs" ? result.permissionScope.permittedJobCount : null,
    },
  };
}

async function expectedJobChecks(
  runtime: ReturnType<typeof createRecruiterToolRuntime>,
  jobIds: number[]
): Promise<ProbeCheck[]> {
  if (jobIds.length === 0) {
    return [{ name: "expected_job_visibility", status: "skip", summary: "No GREENHOUSE_RECRUITER_PROBE_EXPECT_JOB_IDS configured." }];
  }
  const checks: ProbeCheck[] = [];
  for (const jobId of jobIds) {
    const result = await runEvidenceSampleRead(runtime, "get_my_job", { id: jobId });
    if (!result.ok) {
      checks.push(denialCheck("expected_job_visibility", result, { jobId }));
      continue;
    }
    const visible = isRecord(result.data) && readPositiveInteger(result.data.id) === jobId;
    checks.push({
      name: "expected_job_visibility",
      status: visible ? "pass" : "fail",
      summary: visible ? "Expected job is visible through scoped reads." : "Expected job was not visible through scoped reads.",
      details: { jobId },
    });
  }
  return checks;
}

async function forbiddenJobChecks(
  runtime: ReturnType<typeof createRecruiterToolRuntime>,
  jobIds: number[]
): Promise<ProbeCheck[]> {
  if (jobIds.length === 0) {
    return [{ name: "forbidden_job_exclusion", status: "skip", summary: "No GREENHOUSE_RECRUITER_PROBE_FORBIDDEN_JOB_IDS configured." }];
  }
  const checks: ProbeCheck[] = [];
  for (const jobId of jobIds) {
    const result = await runEvidenceSampleRead(runtime, "get_my_job", { id: jobId });
    if (!result.ok && result.denial.code === "TOOL_DISABLED") {
      // get_my_job is turned off, so this check cannot OBSERVE exclusion — reporting "pass" would
      // claim a scoping proof the probe never made. Report skip (honest "not tested"); the list-path
      // forbidden check (endpoint_contract_forbidden_jobs_ids) proves exclusion independently.
      checks.push({
        name: "forbidden_job_exclusion",
        status: "skip",
        summary: "get_my_job is disabled; forbidden-job exclusion was not tested through get_my_job (the list-path forbidden check tests exclusion independently).",
        details: { jobId, denialCode: result.denial.code },
      });
      continue;
    }
    if (!result.ok) {
      checks.push(denialCheck("forbidden_job_exclusion", result, { jobId }));
      continue;
    }
    const returnedData = result.data !== null && result.data !== undefined;
    checks.push({
      name: "forbidden_job_exclusion",
      status: returnedData ? "fail" : "pass",
      summary: returnedData ? "Forbidden exact job read returned data through scoped reads." : "Forbidden job did not return data through scoped reads.",
      details: { jobId, returnedId: isRecord(result.data) ? readPositiveInteger(result.data.id) : null },
    });
  }
  return checks;
}


async function endpointContractChecks(
  runtime: ReturnType<typeof createRecruiterToolRuntime>,
  expectedJobIds: number[],
  forbiddenJobIds: number[]
): Promise<ProbeCheck[]> {
  const checks: ProbeCheck[] = [];
  const jobSeed = expectedJobIds[0] ?? await firstPositiveId(runtime, "search_my_jobs", "id");

  if (jobSeed) {
    checks.push(await idsExactnessCheck(runtime, "search_my_jobs", "endpoint_contract_jobs_ids", "/jobs", jobSeed));
  } else {
    checks.push(skipEndpointContract("endpoint_contract_jobs_ids", "/jobs", "ids", "No visible job id available for list-by-id validation."));
  }

  if (forbiddenJobIds.length > 0) {
    for (const jobId of forbiddenJobIds) {
      const result = await runEvidenceSampleRead(runtime, "search_my_jobs", { ids: String(jobId), per_page: DEFAULT_SAMPLE_PER_PAGE });
      if (!result.ok) {
        checks.push(denialCheck("endpoint_contract_forbidden_jobs_ids", result, { endpoint: "/jobs", filter: "ids", expectedAbsentId: jobId }));
        continue;
      }
      const rows = rowsFrom(result.data);
      const exactLeaks = rows.filter((row) => readPositiveInteger(row.id) === jobId).length;
      const unexpectedRows = rows.length - exactLeaks;
      checks.push({
        name: "endpoint_contract_forbidden_jobs_ids",
        status: rows.length === 0 ? "pass" : "fail",
        summary: rows.length === 0
          ? "Forbidden job id-filter returned an honest zero-row result."
          : "Forbidden job id-filter returned rows, so exclusion or exact-filter handling is not proven.",
        details: endpointDetails(result, "/jobs", "ids", { expectedAbsentId: jobId, rowsReturned: rows.length, exactLeaks, unexpectedRows }),
      });
    }
  } else {
    checks.push(skipEndpointContract(
      "endpoint_contract_forbidden_jobs_ids",
      "/jobs",
      "ids",
      "No GREENHOUSE_RECRUITER_PROBE_FORBIDDEN_JOB_IDS configured."
    ));
  }

  const applicationSeed = await evidenceRows(runtime, "search_my_applications", { per_page: DEFAULT_SAMPLE_PER_PAGE }, "endpoint_contract_applications_seed");
  if (applicationSeed.check) {
    checks.push(applicationSeed.check);
    return checks;
  }
  const applicationRows = applicationSeed.rows;
  const applicationId = firstRowId(applicationRows, "id");
  const applicationJobId = firstRowId(applicationRows, "job_id");
  const applicationCandidateId = firstRowId(applicationRows, "candidate_id");

  if (applicationId) {
    checks.push(await idsExactnessCheck(runtime, "search_my_applications", "endpoint_contract_applications_ids", "/applications", applicationId));
  } else {
    checks.push(skipEndpointContract("endpoint_contract_applications_ids", "/applications", "ids", "No visible application id available for list-by-id validation."));
  }

  if (applicationJobId) {
    checks.push(await fieldFilterCheck(runtime, "search_my_applications", "endpoint_contract_applications_job_ids", "/applications", "job_ids", applicationJobId, "job_id"));
  } else {
    checks.push(skipEndpointContract("endpoint_contract_applications_job_ids", "/applications", "job_ids", "No visible application job_id available for job_ids validation."));
  }

  if (applicationCandidateId) {
    checks.push(await fieldFilterCheck(runtime, "search_my_applications", "endpoint_contract_applications_candidate_ids", "/applications", "candidate_ids", applicationCandidateId, "candidate_id"));
  } else {
    checks.push(skipEndpointContract("endpoint_contract_applications_candidate_ids", "/applications", "candidate_ids", "No visible application candidate_id available for candidate_ids validation."));
  }

  const scorecardSeed = await evidenceRows(runtime, "search_my_scorecards", { per_page: DEFAULT_SAMPLE_PER_PAGE }, "endpoint_contract_scorecards_seed");
  if (scorecardSeed.check) {
    checks.push(scorecardSeed.check);
    return checks;
  }
  const scorecardApplicationId = firstRowId(scorecardSeed.rows, "application_id");
  if (scorecardApplicationId) {
    checks.push(await fieldFilterCheck(runtime, "search_my_scorecards", "endpoint_contract_scorecards_application_ids", "/scorecards", "application_ids", scorecardApplicationId, "application_id"));
  } else {
    checks.push({
      name: "endpoint_contract_scorecards_application_ids",
      status: "pass",
      summary: "Scoped scorecard endpoint was reachable; no scorecard application_id was available for application_ids validation.",
      details: { endpoint: "/scorecards", filter: "application_ids", rowsReturned: scorecardSeed.rows.length },
    });
  }

  return checks;
}

async function idsExactnessCheck(
  runtime: ReturnType<typeof createRecruiterToolRuntime>,
  toolName: string,
  checkName: string,
  endpoint: string,
  id: number
): Promise<ProbeCheck> {
  const result = await runEvidenceSampleRead(runtime, toolName, { ids: String(id), per_page: DEFAULT_SAMPLE_PER_PAGE });
  if (!result.ok) {
    return denialCheck(checkName, result, { endpoint, filter: "ids", expectedId: id });
  }
  const rows = rowsFrom(result.data);
  const exactRows = rows.filter((row) => readPositiveInteger(row.id) === id).length;
  const wrongIdRows = rows.filter((row) => {
    const rowId = readPositiveInteger(row.id);
    return rowId !== null && rowId !== id;
  }).length;
  const passed = exactRows === 1 && wrongIdRows === 0;
  return {
    name: checkName,
    status: passed ? "pass" : "fail",
    summary: passed ? `${endpoint} ids filter returned exactly the requested row.` : `${endpoint} ids filter did not return exactly the requested row.`,
    details: endpointDetails(result, endpoint, "ids", { expectedId: id, rowsReturned: rows.length, exactRows, wrongIdRows }),
  };
}

async function fieldFilterCheck(
  runtime: ReturnType<typeof createRecruiterToolRuntime>,
  toolName: string,
  checkName: string,
  endpoint: string,
  filterName: string,
  expectedId: number,
  fieldName: string
): Promise<ProbeCheck> {
  const result = await runEvidenceSampleRead(runtime, toolName, { [filterName]: String(expectedId), per_page: DEFAULT_SAMPLE_PER_PAGE });
  if (!result.ok) {
    return denialCheck(checkName, result, { endpoint, filter: filterName, expectedId });
  }
  const rows = rowsFrom(result.data);
  const matchingRows = rows.filter((row) => readPositiveInteger(row[fieldName]) === expectedId).length;
  const wrongRows = rows.filter((row) => {
    const value = readPositiveInteger(row[fieldName]);
    return value !== null && value !== expectedId;
  }).length;
  const passed = rows.length > 0 && matchingRows === rows.length && wrongRows === 0;
  return {
    name: checkName,
    status: passed ? "pass" : "fail",
    summary: passed ? `${endpoint} ${filterName} filter returned only matching rows.` : `${endpoint} ${filterName} filter did not return matching rows.`,
    details: endpointDetails(result, endpoint, filterName, { expectedId, rowsReturned: rows.length, matchingRows, wrongRows }),
  };
}

async function evidenceRows(
  runtime: ReturnType<typeof createRecruiterToolRuntime>,
  toolName: string,
  params: Record<string, unknown>,
  checkName: string
): Promise<{ rows: Record<string, unknown>[]; result?: RecruiterToolResult; check?: ProbeCheck }> {
  const result = await runEvidenceSampleRead(runtime, toolName, params);
  if (!result.ok) {
    return { rows: [], result, check: denialCheck(checkName, result) };
  }
  return { rows: rowsFrom(result.data), result };
}

async function firstPositiveId(
  runtime: ReturnType<typeof createRecruiterToolRuntime>,
  toolName: string,
  fieldName: string
): Promise<number | null> {
  const result = await runEvidenceSampleRead(runtime, toolName, { per_page: DEFAULT_SAMPLE_PER_PAGE });
  if (!result.ok) return null;
  return firstRowId(rowsFrom(result.data), fieldName);
}

function firstRowId(rows: Record<string, unknown>[], fieldName: string): number | null {
  for (const row of rows) {
    const id = readPositiveInteger(row[fieldName]);
    if (id !== null) return id;
  }
  return null;
}

function skipEndpointContract(name: string, endpoint: string, filter: string, summary: string): ProbeCheck {
  return { name, status: "skip", summary, details: { endpoint, filter } };
}

function endpointDetails(result: RecruiterToolResult, endpoint: string, filter: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    endpoint,
    filter,
    actorId: result.ok ? result.actorId : null,
    effectiveActorId: result.ok ? result.effectiveActorId : null,
    scoped: result.ok ? result.scoped : null,
    permissionScopeKind: result.ok ? result.permissionScope?.kind ?? "unknown" : "unknown",
    permittedJobCount: result.ok && result.permissionScope?.kind === "jobs" ? result.permissionScope.permittedJobCount : null,
    ...extra,
  };
}

function probeScopeDetails(result: RecruiterToolResult): Record<string, unknown> {
  return {
    scoped: result.ok ? result.scoped : null,
    permissionScopeKind: result.ok ? result.permissionScope?.kind ?? "unknown" : "unknown",
    permittedJobCount: result.ok && result.permissionScope?.kind === "jobs" ? result.permissionScope.permittedJobCount : null,
  };
}

async function scorecardShapeCheck(
  runtime: ReturnType<typeof createRecruiterToolRuntime>
): Promise<ProbeCheck> {
  const result = await runEvidenceSampleRead(runtime, "search_my_scorecards", {
    per_page: DEFAULT_SAMPLE_PER_PAGE,
  });
  if (!result.ok) {
    return denialCheck("scorecard_shape_sample", result);
  }
  const rows = rowsFrom(result.data);
  if (rows.length === 0) {
    return {
      name: "scorecard_shape_sample",
      status: "pass",
      summary: "Scoped scorecard endpoint was reachable and returned an honest-zero sample.",
      details: { rowsReturned: 0, rowsWithApplication: 0, rowsWithStatusSignal: 0, ...probeScopeDetails(result) },
    };
  }
  const rowsWithApplication = rows.filter((row) => readPositiveInteger(row.application_id) !== null).length;
  const rowsWithStatusSignal = rows.filter((row) => typeof row.status === "string" || typeof row.submitted_at === "string" || row.submitted_at === null).length;
  return {
    name: "scorecard_shape_sample",
    status: rowsWithApplication > 0 && rowsWithStatusSignal === rows.length ? "pass" : "warn",
    summary: "Sampled scoped scorecards for application/status fields used by scorecard accountability.",
    details: { rowsReturned: rows.length, rowsWithApplication, rowsWithStatusSignal, ...probeScopeDetails(result) },
  };
}

async function candidateShapeCheck(
  runtime: ReturnType<typeof createRecruiterToolRuntime>
): Promise<ProbeCheck> {
  const result = await runEvidenceSampleRead(runtime, "search_my_candidates", {
    per_page: DEFAULT_SAMPLE_PER_PAGE,
  });
  if (!result.ok) {
    return denialCheck("candidate_shape_sample", result);
  }
  const rows = rowsFrom(result.data);
  if (rows.length === 0) {
    return {
      name: "candidate_shape_sample",
      status: "pass",
      summary: "Scoped candidate endpoint was reachable and returned an honest-zero sample.",
      details: { rowsReturned: 0, rowsWithId: 0, rowsWithPrivateFlag: 0, ...probeScopeDetails(result) },
    };
  }
  const rowsWithId = rows.filter((row) => readPositiveInteger(row.id) !== null).length;
  const rowsWithPrivateFlag = rows.filter((row) => typeof row.private === "boolean").length;
  return {
    name: "candidate_shape_sample",
    status: rowsWithId === rows.length ? "pass" : "warn",
    summary: "Sampled scoped candidates for id/private fields and candidate-grain filtering coverage.",
    details: {
      rowsReturned: rows.length,
      rowsWithId,
      rowsWithPrivateFlag,
      ...probeScopeDetails(result),
    },
  };
}

async function notesShapeCheck(
  runtime: ReturnType<typeof createRecruiterToolRuntime>
): Promise<ProbeCheck> {
  const result = await runEvidenceSampleRead(runtime, "search_my_notes", {
    per_page: DEFAULT_SAMPLE_PER_PAGE,
  });
  if (!result.ok) {
    return denialCheck("notes_visibility_sample", result);
  }
  const rows = rowsFrom(result.data);
  const gatedRows = rows.filter((row) => {
    const visibility = typeof row.visibility === "string" ? row.visibility.trim().toLowerCase() : "";
    return visibility !== "publicly_visible" && visibility !== "admin_only_visible";
  });
  const gatedFieldLeaks = gatedRows.filter((row) =>
    ["body", "body_with_tags", "subject"].some((field) => Object.hasOwn(row, field))
  ).length;
  return {
    name: "notes_visibility_sample",
    status: gatedFieldLeaks === 0 ? "pass" : "fail",
    summary: gatedFieldLeaks === 0
      ? "Visibility-gated note rows omitted body and subject fields."
      : "Visibility-gated note rows leaked body or subject fields.",
    details: { rowsReturned: rows.length, gatedRows: gatedRows.length, gatedFieldLeaks, ...probeScopeDetails(result) },
  };
}

async function scorecardAnalysisCheck(
  runtime: ReturnType<typeof createRecruiterToolRuntime>
): Promise<ProbeCheck> {
  const result = await runScorecardAccountability(runtime, {
    max_rankings: 10,
    per_page: DEFAULT_SAMPLE_PER_PAGE,
  });
  if (!result.ok) {
    return denialCheck("scorecard_accountability_analysis", result);
  }
  const data = isRecord(result.data) ? result.data : {};
  const metrics = isRecord(data.metrics) ? data.metrics : {};
  return {
    name: "scorecard_accountability_analysis",
    status: "pass",
    summary: "Scorecard accountability analysis completed on scoped data.",
    details: {
      totalScorecards: readNonNegativeInteger(metrics.total_scorecards),
      unsubmittedScorecards: readNonNegativeInteger(metrics.unsubmitted_scorecards),
      ...probeScopeDetails(result),
    },
  };
}

async function stageLatencyAnalysisCheck(
  runtime: ReturnType<typeof createRecruiterToolRuntime>
): Promise<ProbeCheck> {
  const result = await runStageLatency(runtime, {
    max_rankings: 10,
    per_page: DEFAULT_SAMPLE_PER_PAGE,
    min_age_days: 7,
  });
  if (!result.ok) {
    return denialCheck("stage_latency_analysis", result);
  }
  const data = isRecord(result.data) ? result.data : {};
  const metrics = isRecord(data.metrics) ? data.metrics : {};
  return {
    name: "stage_latency_analysis",
    status: "pass",
    summary: "Stage latency analysis completed on scoped application data.",
    details: {
      applicationsConsidered: readNonNegativeInteger(metrics.applications_considered),
      agingApplications: readNonNegativeInteger(metrics.aging_applications),
      ...probeScopeDetails(result),
    },
  };
}

async function interviewFeedbackDragAnalysisCheck(
  runtime: ReturnType<typeof createRecruiterToolRuntime>
): Promise<ProbeCheck> {
  const result = await runInterviewFeedbackDrag(runtime, {
    max_rankings: 10,
    per_page: DEFAULT_SAMPLE_PER_PAGE,
    due_days: 2,
  });
  if (!result.ok) {
    return denialCheck("interview_feedback_drag_analysis", result);
  }
  const data = isRecord(result.data) ? result.data : {};
  const metrics = isRecord(data.metrics) ? data.metrics : {};
  return {
    name: "interview_feedback_drag_analysis",
    status: "pass",
    summary: "Interview feedback drag analysis completed on scoped scorecard data.",
    details: {
      scorecardsConsidered: readNonNegativeInteger(metrics.scorecards_considered),
      lateOrUnsubmittedScorecards: readNonNegativeInteger(metrics.late_or_unsubmitted_scorecards),
      ...probeScopeDetails(result),
    },
  };
}

async function pipelineQualityAnalysisCheck(
  runtime: ReturnType<typeof createRecruiterToolRuntime>
): Promise<ProbeCheck> {
  const result = await runPipelineQuality(runtime, {
    max_rankings: 10,
    per_page: DEFAULT_SAMPLE_PER_PAGE,
    stale_days: 14,
  });
  if (!result.ok) {
    return denialCheck("pipeline_quality_analysis", result);
  }
  const data = isRecord(result.data) ? result.data : {};
  const metrics = isRecord(data.metrics) ? data.metrics : {};
  return {
    name: "pipeline_quality_analysis",
    status: "pass",
    summary: "Pipeline quality analysis completed on scoped application data.",
    details: {
      applicationsConsidered: readNonNegativeInteger(metrics.applications_considered),
      activeApplications: readNonNegativeInteger(metrics.active_applications),
      staleActiveApplications: readNonNegativeInteger(metrics.stale_active_applications),
      ...probeScopeDetails(result),
    },
  };
}

async function sourceQualityAnalysisCheck(
  runtime: ReturnType<typeof createRecruiterToolRuntime>
): Promise<ProbeCheck> {
  const result = await runSourceQuality(runtime, {
    max_rankings: 10,
    per_page: DEFAULT_SAMPLE_PER_PAGE,
    stale_days: 14,
  });
  if (!result.ok) {
    return denialCheck("source_quality_analysis", result);
  }
  const data = isRecord(result.data) ? result.data : {};
  const metrics = isRecord(data.metrics) ? data.metrics : {};
  return {
    name: "source_quality_analysis",
    status: "pass",
    summary: "Source/referrer quality analysis completed on scoped application data.",
    details: {
      applicationsConsidered: readNonNegativeInteger(metrics.applications_considered),
      sourceGroups: readNonNegativeInteger(metrics.source_groups),
      referrerGroups: readNonNegativeInteger(metrics.referrer_groups),
      staleActiveApplications: readNonNegativeInteger(metrics.stale_active_applications),
      ...probeScopeDetails(result),
    },
  };
}

async function rejectionReasonDriftAnalysisCheck(
  runtime: ReturnType<typeof createRecruiterToolRuntime>
): Promise<ProbeCheck> {
  const result = await runRejectionReasonDrift(runtime, {
    max_rankings: 10,
    per_page: DEFAULT_SAMPLE_PER_PAGE,
    window_start: "2026-01-01T00:00:00.000Z",
    window_end: new Date(runtime.now()).toISOString(),
  });
  if (!result.ok) {
    return denialCheck("rejection_reason_drift_analysis", result);
  }
  const data = isRecord(result.data) ? result.data : {};
  const metrics = isRecord(data.metrics) ? data.metrics : {};
  return {
    name: "rejection_reason_drift_analysis",
    status: "pass",
    summary: "Rejection reason drift analysis completed on scoped rejection data.",
    details: {
      rejectionsConsidered: readNonNegativeInteger(metrics.rejections_considered),
      distinctReasons: readNonNegativeInteger(metrics.distinct_reasons),
      ...probeScopeDetails(result),
    },
  };
}

async function questionPlannerAnalysisCheck(
  runtime: ReturnType<typeof createRecruiterToolRuntime>
): Promise<ProbeCheck> {
  const result = await runRecruitingQuestionAnswer(runtime, {
    question: "What is broken across my reqs right now?",
    recipes: "pipeline_quality",
    max_recipes: 1,
    max_rankings: 10,
    per_page: DEFAULT_SAMPLE_PER_PAGE,
    stale_days: 14,
  });
  if (!result.ok) {
    return denialCheck("question_planner_analysis", result);
  }
  const data = isRecord(result.data) ? result.data : {};
  const summary = isRecord(data.summary) ? data.summary : {};
  const selectedRecipes = Array.isArray(summary.selected_recipes) ? summary.selected_recipes.filter((value): value is string => typeof value === "string") : [];
  return {
    name: "question_planner_analysis",
    status: selectedRecipes.includes("pipeline_quality") ? "pass" : "warn",
    summary: "Constrained natural-language planner completed with an approved scoped analysis recipe.",
    details: {
      selectedRecipes,
      selectedRecipeCount: readNonNegativeInteger(summary.selected_recipe_count),
      rowsRead: readNonNegativeInteger(summary.rows_read),
      rowsConsidered: readNonNegativeInteger(summary.rows_considered),
      ...probeScopeDetails(result),
    },
  };
}

function denialCheck(name: string, result: RecruiterToolResult, details: Record<string, unknown> = {}): ProbeCheck {
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

function failedStartupReport(now: () => number, env: NodeJS.ProcessEnv, name: string, summary: string): RecruiterReadinessProbeReport {
  return {
    ok: false,
    strict: false,
    generatedAt: new Date(now()).toISOString(),
    surface: null,
    client: null,
    sessionSubjectPresent: false,
    sessionTokenId: null,
    sessionIssuedAt: null,
    checks: [{ name, status: "fail", summary }],
    auditEventCount: 0,
    buildCommit: readBuildCommit(env),
  };
}

function startupFailureSummary(name: string): string {
  if (name === "session_validation") {
    return "Recruiter MCP session could not be validated; no scoped evidence checks ran.";
  }
  return "Readiness probe startup failed before scoped evidence checks could run.";
}

function strictProbeChecks(
  checks: ProbeCheck[],
  expectedJobIds: number[],
  forbiddenJobIds: number[]
): ProbeCheck[] {
  const strictChecks: ProbeCheck[] = [];
  if (expectedJobIds.length === 0) {
    strictChecks.push({
      name: "strict_expected_job_ids_required",
      status: "fail",
      summary: "Strict rollout probe requires GREENHOUSE_RECRUITER_PROBE_EXPECT_JOB_IDS for at least one known-visible req.",
    });
  }
  if (forbiddenJobIds.length === 0) {
    strictChecks.push({
      name: "strict_forbidden_job_ids_required",
      status: "fail",
      summary: "Strict rollout probe requires GREENHOUSE_RECRUITER_PROBE_FORBIDDEN_JOB_IDS for at least one known-revoked or non-visible req.",
    });
  }
  const warningNames = checks.filter((check) => check.status === "warn").map((check) => check.name);
  if (warningNames.length > 0) {
    strictChecks.push({
      name: "strict_warnings_clear",
      status: "fail",
      summary: "Strict rollout probe requires all warning checks to be resolved before distribution.",
      details: { warningChecks: warningNames },
    });
  }
  return strictChecks;
}

// Flip data-bearing checks that considered zero rows to fail. Only downgrades a currently-passing
// check whose denominator detail is exactly 0; a denial (already fail) or a non-zero denominator is
// left as-is. Mutates the checks in place so the report's `ok` (computed after) reflects the failures.
function applyExpectVisibleData(checks: ProbeCheck[]): void {
  const denominatorByCheck = new Map<string, string>(VISIBLE_DATA_DENOMINATORS);
  for (const check of checks) {
    const denominatorKey = denominatorByCheck.get(check.name);
    if (!denominatorKey || check.status !== "pass") continue;
    if (check.details?.[denominatorKey] === 0) {
      check.status = "fail";
      check.summary = `${check.summary} Strict probe expected visible data for this profile but ${denominatorKey} was 0 — the scope carries no data, or a contract/field break is dropping every row.`;
      check.details = { ...check.details, expectVisibleData: true };
    }
  }
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

function rowsFrom(data: unknown): Record<string, unknown>[] {
  return Array.isArray(data) ? data.filter(isRecord) : [];
}

function readPositiveInteger(value: unknown): number | null {
  if (isSafePositiveGreenhouseUserId(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return isSafePositiveGreenhouseUserId(parsed) ? parsed : null;
  }
  return null;
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startRecruiterReadinessProbeCli().catch((error) => {
    process.stderr.write("[greenhouse-recruiter-probe] failed before a report could be written.\n");
    process.exit(1);
  });
}
