import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { AuditReviewReport } from "./audit-review.js";
import type { DesktopConfigFileManifest, DesktopConfigFileManifestEntry } from "./desktop-config.js";
import { APPROVED_DESKTOP_DELIVERY_CHANNELS } from "./desktop-delivery.js";
import type { DistributionValidationReport } from "./distribution-validation.js";
import { MANAGED_ROSTER_SOURCES } from "./email-session.js";
import type { IssuedEmailSessionFileManifest, PreflightVerifiedEmailRosterReport } from "./email-session.js";
import type { IdentityBootstrapPlan } from "./identity-bootstrap.js";
import type { ScopeLeakageSampleReport } from "./leakage-sample.js";
import type { RecruiterReadinessProbeReport } from "./probe.js";
import { NO_PERMISSION_DATA_DENOMINATORS, VISIBLE_DATA_DENOMINATORS } from "./probe.js";
import type { ProductionEnvCheckReport } from "./production-env-check.js";
import type { SessionRevocationDrillReport } from "./revocation-drill.js";
import type { SessionRevocationWriteReport } from "./session-revocation.js";
import { isClientSurfaceCompatible, isRecruiterClient, normalizeSessionTokenId } from "./auth.js";
import { containsTokenOrConfigPayload } from "./evidence-hygiene.js";
import { MIN_ROUTING_RUNS, ROUTING_TEST_VERSION, validateDesktopRoutingAttestation } from "./desktop-user-test.js";
import { isSafePositiveGreenhouseUserId } from "./identity.js";
import { RECRUITER_MCP_READINESS_CHECK_NAMES } from "./readiness.js";
import { classifyNonProductionHostname } from "./production-host.js";
import { PILOT_TOOL_NAMES, RECRUITER_TOOL_DEFINITIONS } from "./tools/register.js";
import type { RecruiterClient } from "./types.js";

export interface RolloutGateCheck {
  name: string;
  status: "pass" | "fail";
  summary: string;
  details?: Record<string, unknown>;
}

export interface RolloutGateReport {
  ok: boolean;
  status: "ready" | "not_ready";
  checkedAt: string;
  manifestPath: string;
  checks: RolloutGateCheck[];
}

export interface RolloutEvidenceManifest {
  version: 2;
  candidate: CandidateReleaseEvidence;
  liveProbes: LiveProbeEvidence[];
  distributionValidations: DistributionValidationEvidence[];
  productionEnvEvidence: ProductionEnvEvidence;
  revocationDrillEvidence: RevocationDrillEvidence[];
  sessionRevocationEvidence: SessionRevocationEvidence[];
  identityBootstrapEvidence?: IdentityBootstrapEvidence;
  rosterPreflightEvidence: RosterPreflightEvidence;
  sessionIssuanceEvidence: SessionIssuanceEvidence;
  desktopConfigEvidence: DesktopConfigEvidence;
  desktopDeliveryEvidence: DesktopDeliveryEvidence;
  desktopUserTests: DesktopUserTestEvidence[];
  permissionFreshnessEvidence: PermissionFreshnessEvidence;
  leakageSampleEvidence: LeakageSampleEvidence;
  auditReviewEvidence: AuditReviewEvidence;
}

export interface CandidateReleaseEvidence {
  mcpUrl: string;
  commit: string;
}

export interface LiveProbeEvidence {
  profile: "small_req_set" | "many_req_set" | "all_jobs_or_operator" | "no_permissions";
  path: string;
  strict?: boolean;
  expectZeroVisibleJobs?: boolean;
  // Symmetric to expectZeroVisibleJobs: assert this data-bearing profile actually carried data. Set
  // for the recruiter profiles whose scope is expected to be non-empty so the gate re-derives, from
  // the probe evidence, that no analysis denominator (applications/scorecards considered, sampled
  // rows) was 0 — defense in depth against an old/stale probe that did not self-enforce it.
  expectVisibleData?: boolean;
}

export interface DistributionValidationEvidence {
  surface: "chatgpt_desktop" | "claude_desktop";
  client: RecruiterClient;
  path: string;
}

export interface ProductionEnvEvidence {
  path: string;
}

export interface RevocationDrillEvidence {
  surface: "chatgpt_desktop" | "claude_desktop";
  client: RecruiterClient;
  path: string;
}

export interface SessionRevocationEvidence {
  surface: "chatgpt_desktop" | "claude_desktop";
  client: RecruiterClient;
  path: string;
}

export interface DesktopUserTestEvidence {
  surface: "chatgpt_desktop" | "claude_desktop";
  client: RecruiterClient;
  path: string;
}

export interface DesktopConfigEvidence {
  path: string;
}

export interface DesktopDeliveryEvidence {
  path: string;
}

export interface IdentityBootstrapEvidence {
  path: string;
}

export interface RosterPreflightEvidence {
  path: string;
}

export interface SessionIssuanceEvidence {
  path: string;
}

export interface PermissionFreshnessEvidence {
  removedReqDisappearedOnNextRead?: boolean;
  addedReqAppearedWithoutDeploy?: boolean;
  privateNotesDropped?: boolean;
  scopedVsUnscopedLeakageSamplePassed?: boolean;
  durableAccessTestedWithoutRoutineReverification?: boolean;
  verifiedAt?: string;
  verifiedBy?: string;
  removedReqId?: number;
  removedReqRowsBeforeRemoval?: number;
  removedReqRowsAfterRemoval?: number;
  addedReqId?: number;
  addedReqRowsBeforeAddition?: number;
  addedReqRowsAfterAddition?: number;
  privateNoteId?: number;
  privateNoteRowsReturnedAfterScope?: number;
  durableSessionEmail?: string;
  durableSessionSurface?: "chatgpt_desktop" | "claude_desktop";
  durableSessionTokenId?: string;
  durableSessionTokenIdAfterRestart?: string;
  durableSessionIssuedAt?: string;
  durableSessionIssuedAtAfterRestart?: string;
  routineReverificationPrompted?: boolean;
}

export interface AuditReviewEvidence {
  path: string;
}

export interface LeakageSampleEvidence {
  path: string;
}

interface DesktopUserTestReport {
  status?: string;
  surface?: string;
  client?: "claude_desktop_chat" | "claude_code" | "chatgpt_codex_host";
  testedAt?: string;
  tester?: string;
  testerEmail?: string;
  mcpUrl?: string;
  sessionTokenId?: string;
  sessionTokenIdAfterRestart?: string;
  sessionIssuedAt?: string;
  sessionIssuedAtAfterRestart?: string;
  durableSessionAccess?: boolean;
  sessionPersistedAcrossRestart?: boolean;
  routineReverificationPrompted?: boolean;
  attachmentMethod?: string;
  exercisedTools?: unknown;
  writeOrAdminToolsVisible?: boolean;
  containsTokens?: boolean;
  taskOutcome?: "useful" | "not_useful" | "could_not_use";
  taskOutcomeReason?: "wrong_scope" | "timeout_error" | "installation_blocked" | "answer_received" | "not_yet_needed";
  clientVersion?: unknown;
  modelVersion?: unknown;
  routingTestVersion?: unknown;
  routingChecks?: unknown;
  resumeInstructionsTreatedAsUntrusted?: unknown;
}

interface DesktopDeliveryReport {
  ok?: boolean;
  deliveredAt?: string;
  deliveredBy?: string;
  deliveryChannel?: string;
  containsTokens?: boolean;
  deliveries?: unknown;
}

interface SessionTokenMetadata {
  subject?: string;
  email?: string;
  surface?: string;
  client?: string;
  tokenId?: string;
  issuedAt?: string;
}

interface ExpectedSessionTokenMetadata {
  email: string;
  surface: (typeof REQUIRED_SURFACES)[number];
  client?: RecruiterClient;
  subject?: string;
  tokenId?: string;
  issuedAt?: string;
}

export interface RolloutGateOptions {
  manifestPath: string;
  now?: () => Date;
  // When provided (the env/CLI deploy entrypoints supply it), the gate performs a REAL live
  // observation of the hosted /readyz and pinned /version commit after validating the recorded evidence. The pure
  // runRolloutGate({manifestPath}) path leaves it undefined and stays offline-deterministic.
  liveReadyz?: LiveReadyzObservationInput;
}

export interface LiveReadyzObservationInput {
  url?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const LIVE_READYZ_DEFAULT_TIMEOUT_MS = 10_000;

const REQUIRED_PROBE_PROFILES = ["small_req_set", "many_req_set", "all_jobs_or_operator", "no_permissions"] as const;
const REQUIRED_SURFACES = ["chatgpt_desktop", "claude_desktop"] as const;
const REQUIRED_CLIENT_IDENTITIES = [
  { surface: "claude_desktop", client: "claude_desktop_chat" },
  { surface: "claude_desktop", client: "claude_code" },
  { surface: "chatgpt_desktop", client: "chatgpt_codex_host" },
] as const satisfies ReadonlyArray<{ surface: (typeof REQUIRED_SURFACES)[number]; client: RecruiterClient }>;
// Exported so the producing modules' tests can guard that every required check name is one the
// producer actually emits — killing the hand-maintained-parallel-list drift class. See
// distribution-validation.test.ts and probe.test.ts.
export const REQUIRED_DISTRIBUTION_CHECKS = [
  "healthz",
  "readyz_unauthorized_denied",
  "readyz",
  "version_commit",
  "mcp_initialize",
  "mcp_tools_list",
  "expected_tool_catalog",
  "no_unexpected_tools",
  "exact_tool_catalog",
  "no_write_tools",
  "read_only_tool_annotations",
];

// Derived from the readiness catalog (the SINGLE SOURCE OF TRUTH in readiness.ts), not a hand-kept
// parallel list. The old copy silently dropped `scope_signing_secret`, so production-env evidence
// missing that check passed the gate; deriving from the catalog restores it and any future readiness
// check automatically. readiness.test.ts locks the catalog to the report's real output.
export const REQUIRED_PRODUCTION_ENV_CHECKS: readonly string[] = RECRUITER_MCP_READINESS_CHECK_NAMES;

// The analysis tools the rollout evidence (live probes + distribution toolNames) must
// carry. Deliberately NOT derived from RECRUITER_TOOL_DEFINITIONS: this is the set of
// live-probed analysis tools, so a new analysis tool is added here only once it is itself
// live-probed (see REQUIRED_LIVE_PROBE_CHECKS).
const REQUIRED_ANALYSIS_TOOLS = [
  "analyze_scorecard_accountability",
  "analyze_interview_feedback_drag",
  "analyze_stage_latency",
  "analyze_pipeline_quality",
  "analyze_source_quality",
  "analyze_rejection_reason_drift",
  "answer_my_recruiting_question",
];

export const REQUIRED_LIVE_PROBE_CHECKS = [
  "scoped_jobs_sample",
  "expected_job_visibility",
  "forbidden_job_exclusion",
  "endpoint_contract_jobs_ids",
  "endpoint_contract_forbidden_jobs_ids",
  "endpoint_contract_applications_ids",
  "endpoint_contract_applications_job_ids",
  "endpoint_contract_applications_candidate_ids",
  "endpoint_contract_scorecards_application_ids",
  "scoped_applications_sample",
  "candidate_shape_sample",
  "scorecard_shape_sample",
  "notes_visibility_sample",
  "scorecard_accountability_analysis",
  "interview_feedback_drag_analysis",
  "stage_latency_analysis",
  "pipeline_quality_analysis",
  "source_quality_analysis",
  "rejection_reason_drift_analysis",
  "question_planner_analysis",
  "activity_endpoint_shape",
];
const SCOPE_BOUND_LIVE_PROBE_CHECKS = new Set([
  "scoped_jobs_sample",
  "scoped_applications_sample",
  "candidate_shape_sample",
  "scorecard_shape_sample",
  "notes_visibility_sample",
  "scorecard_accountability_analysis",
  "interview_feedback_drag_analysis",
  "stage_latency_analysis",
  "pipeline_quality_analysis",
  "source_quality_analysis",
  "rejection_reason_drift_analysis",
  "question_planner_analysis",
]);
const DYNAMIC_EVIDENCE_MAX_AGE_DAYS = 14;
const DYNAMIC_EVIDENCE_MAX_AGE_MS = DYNAMIC_EVIDENCE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

const REQUIRED_DESKTOP_ATTACHMENT_METHODS = {
  chatgpt_desktop: [
    "chatgpt_developer_mode_remote_mcp",
    "chatgpt_desktop_remote_mcp",
    "responses_api_broker",
  ],
  claude_desktop: ["claude_desktop_mcpb", "claude_code_http_mcp"],
} as const;
const REQUIRED_RECRUITER_TOOL_NAMES = [...PILOT_TOOL_NAMES];
const PILOT_TOOL_NAME_SET = new Set<string>(PILOT_TOOL_NAMES);
const REQUIRED_EVIDENCE_TOOLS = RECRUITER_TOOL_DEFINITIONS
  .filter((tool) => tool.kind === "evidence" && PILOT_TOOL_NAME_SET.has(tool.name))
  .map((tool) => tool.name);

export async function runRolloutGate(options: RolloutGateOptions): Promise<RolloutGateReport> {
  const manifestPath = resolve(options.manifestPath);
  const checks: RolloutGateCheck[] = [];
  const manifestRead = await readJson(manifestPath, "Rollout evidence manifest");
  if (!manifestRead.ok) {
    checks.push({ name: "manifest_readable", status: "fail", summary: manifestRead.error });
    return report(options, manifestPath, checks);
  }
  const manifest = manifestRead.value;
  if (!isRolloutEvidenceManifest(manifest)) {
    checks.push({ name: "manifest_shape", status: "fail", summary: "Rollout evidence manifest is missing required top-level sections." });
    return report(options, manifestPath, checks);
  }
  checks.push({ name: "manifest_shape", status: "pass", summary: "Rollout evidence manifest has the expected top-level sections." });
  const manifestTokenPayloadPresent = manifestContainsTokenPayload(manifest);
  checks.push(manifestTokenPayloadPresent
    ? { name: "manifest_token_free", status: "fail", summary: "Rollout evidence manifest contains a token, Authorization header, or generated config payload." }
    : { name: "manifest_token_free", status: "pass", summary: "Rollout evidence manifest is token-free." });
  if (manifestTokenPayloadPresent) return report(options, manifestPath, checks);

  const baseDir = dirname(manifestPath);
  const evidencePathChecks = validateManifestEvidencePaths(baseDir, manifest);
  checks.push(...evidencePathChecks);
  if (evidencePathChecks.some((check) => check.status === "fail")) {
    return report(options, manifestPath, checks);
  }

  const checkedAt = (options.now ?? (() => new Date()))();
  checks.push(...validateRequiredProfiles(manifest.liveProbes));
  checks.push(await validateDistinctLiveProbeArtifacts(baseDir, manifest.liveProbes));
  checks.push(...validateRequiredClients("distribution_validation_manifest", manifest.distributionValidations));
  checks.push(...validateRequiredClients("revocation_drill_manifest", manifest.revocationDrillEvidence));
  checks.push(...validateRequiredClients("session_revocation_manifest", manifest.sessionRevocationEvidence));
  checks.push(...validateRequiredClients("desktop_user_test_manifest", manifest.desktopUserTests));
  const candidateBinding = await validateCandidateReleaseBinding(
    baseDir,
    manifest.candidate,
    manifest.distributionValidations
  );
  checks.push(candidateBinding.check);
  checks.push(...await validateProductionEnvEvidence(baseDir, manifest.productionEnvEvidence, checkedAt));
  for (const evidence of manifest.revocationDrillEvidence) {
    checks.push(...await validateRevocationDrill(
      baseDir,
      evidence,
      manifest.sessionIssuanceEvidence,
      manifest.desktopConfigEvidence,
      checkedAt
    ));
  }
  for (const evidence of manifest.sessionRevocationEvidence) {
    const drillEvidence = manifest.revocationDrillEvidence.find((entry) =>
      entry.surface === evidence.surface && entry.client === evidence.client);
    checks.push(...await validateSessionRevocationEvidence(
      baseDir,
      evidence,
      drillEvidence,
      checkedAt
    ));
  }
  checks.push(...await validateDistinctRevokedTokenIds(baseDir, manifest.revocationDrillEvidence));
  if (manifest.identityBootstrapEvidence) {
    checks.push(...await validateIdentityBootstrapEvidence(baseDir, manifest.identityBootstrapEvidence, manifest.rosterPreflightEvidence));
  }
  checks.push(...await validateRosterPreflightEvidence(baseDir, manifest.rosterPreflightEvidence, checkedAt));
  checks.push(...await validateSessionIssuanceEvidence(baseDir, manifest.sessionIssuanceEvidence));
  checks.push(...await validateDesktopConfigEvidence(baseDir, manifest.desktopConfigEvidence));
  checks.push(await validateDesktopConfigCandidateBinding(baseDir, manifest.desktopConfigEvidence, candidateBinding));
  checks.push(...await validateDesktopDeliveryEvidence(baseDir, manifest.desktopDeliveryEvidence, manifest.desktopConfigEvidence, checkedAt));
  checks.push(...await validateRosterSessionConfigConsistency(
    baseDir,
    manifest.rosterPreflightEvidence,
    manifest.sessionIssuanceEvidence,
    manifest.desktopConfigEvidence
  ));
  checks.push(...await validatePermissionFreshness(
    baseDir,
    checkedAt,
    manifest.permissionFreshnessEvidence,
    manifest.sessionIssuanceEvidence,
    manifest.desktopConfigEvidence
  ));
  checks.push(...await validateLeakageSample(baseDir, manifest.leakageSampleEvidence, candidateBinding, checkedAt));
  checks.push(...await validateAuditReview(baseDir, manifest.auditReviewEvidence, checkedAt));

  for (const entry of manifest.liveProbes) {
    checks.push(...await validateLiveProbeEvidence(
      baseDir,
      entry,
      manifest.sessionIssuanceEvidence,
      candidateBinding,
      checkedAt
    ));
  }
  for (const entry of manifest.distributionValidations) {
    checks.push(...await validateDistributionEvidence(
      baseDir,
      entry,
      manifest.sessionIssuanceEvidence,
      manifest.desktopConfigEvidence,
      checkedAt
    ));
  }
  checks.push(await validateRevocationCandidateBinding(baseDir, manifest.revocationDrillEvidence, candidateBinding));
  for (const entry of manifest.desktopUserTests) {
    const distributionEvidence = manifest.distributionValidations.find((candidate) =>
      candidate.surface === entry.surface && candidate.client === entry.client);
    checks.push(...await validateDesktopUserEvidence(
      baseDir,
      entry,
      manifest.rosterPreflightEvidence,
      manifest.sessionIssuanceEvidence,
      manifest.desktopConfigEvidence,
      distributionEvidence,
      checkedAt
    ));
  }

  // Live observation runs ONLY on the deploy entrypoints (env/CLI pass options.liveReadyz). The pure
  // manifest-validation path stays offline-deterministic. Appended after the recorded-evidence checks
  // so the report shows both the attested evidence and whether the gate actually observed the pinned
  // candidate's liveness and build identity.
  if (options.liveReadyz) {
    const liveBinding = validateLiveReadyzCandidateBinding(options.liveReadyz.url, candidateBinding);
    checks.push(liveBinding);
    if (liveBinding.status === "pass" && candidateBinding.ok) {
      // Derive both destinations from the validated candidate binding. Never send the readiness
      // bearer token to the caller-provided URL merely because it is syntactically valid HTTPS.
      checks.push(...await observeLiveReadyz({ ...options.liveReadyz, url: candidateBinding.readyzUrl }));
      checks.push(...await observeLiveVersion({
        url: candidateBinding.versionUrl,
        expectedCommit: candidateBinding.commit,
        fetchImpl: options.liveReadyz.fetchImpl,
        timeoutMs: options.liveReadyz.timeoutMs,
      }));
    } else {
      checks.push(
        {
          name: "live_readyz_observation",
          status: "fail",
          summary: "Live /readyz was not requested because its URL was not bound to the pinned candidate.",
        },
        {
          name: "live_version_observation",
          status: "fail",
          summary: "Live /version was not requested because the pinned candidate binding was invalid.",
        }
      );
    }
  }

  return report(options, manifestPath, checks);
}

export async function runRolloutGateFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: Pick<RolloutGateOptions, "now"> = {}
): Promise<RolloutGateReport> {
  const manifestPath = env.GREENHOUSE_RECRUITER_ROLLOUT_EVIDENCE_MANIFEST;
  if (!manifestPath) {
    return report(
      options,
      "",
      [{ name: "manifest_path", status: "fail", summary: "GREENHOUSE_RECRUITER_ROLLOUT_EVIDENCE_MANIFEST is required." }]
    );
  }
  return runRolloutGate({ manifestPath, now: options.now, liveReadyz: liveReadyzFromEnv(env) });
}

export async function startRolloutGateCli(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv.slice(2)
): Promise<void> {
  const manifestPath = readManifestPathArg(args) ?? env.GREENHOUSE_RECRUITER_ROLLOUT_EVIDENCE_MANIFEST;
  const gate = manifestPath
    ? await runRolloutGate({ manifestPath, liveReadyz: liveReadyzFromEnv(env) })
    : await runRolloutGateFromEnv(env);
  process.stdout.write(`${JSON.stringify(gate, null, 2)}\n`);
  if (!gate.ok) {
    process.exitCode = 1;
  }
}

async function validateProductionEnvEvidence(
  baseDir: string,
  evidence: ProductionEnvEvidence,
  checkedAt: Date
): Promise<RolloutGateCheck[]> {
  if (typeof evidence.path !== "string" || evidence.path.trim().length === 0) {
    return [{ name: "production_env_preflight", status: "fail", summary: "Production env preflight evidence path is required." }];
  }
  const evidencePath = resolveEvidencePath(baseDir, evidence.path);
  const read = await readJson(evidencePath);
  if (!read.ok) {
    return [{ name: "production_env_preflight", status: "fail", summary: read.error, details: { path: evidence.path } }];
  }

  const report = read.value as ProductionEnvCheckReport;
  const missing: string[] = [];
  const invalidCheckShapes: unknown[] = [];
  const unexpectedTopLevelKeys = isRecord(report)
    ? Object.keys(report).filter((key) => !["ok", "status", "generatedAt", "source", "envFile", "checks", "configuredSurfaces"].includes(key))
    : [];
  if (!isRecord(report)) missing.push("reportShape");
  if (unexpectedTopLevelKeys.length > 0) missing.push("closedTopLevelShape");
  if (report.ok !== true || report.status !== "ready") missing.push("passingReport");
  if (report.source !== "env_file") missing.push("envFileSource");
  if (typeof report.envFile !== "string" || report.envFile.trim().length === 0) missing.push("envFilePath");
  appendTimestampFreshnessMissing(missing, report.generatedAt, "generatedAt", "generatedAtFreshness", checkedAt);
  if (!Array.isArray(report.configuredSurfaces)) missing.push("configuredSurfaces");
  const configuredSurfaces = Array.isArray(report.configuredSurfaces) ? report.configuredSurfaces : [];
  const missingSurfaces = REQUIRED_SURFACES.filter((surface) => !configuredSurfaces.includes(surface));
  if (missingSurfaces.length > 0) missing.push("requiredSurfaces");
  if (!Array.isArray(report.checks) || report.checks.length === 0) missing.push("checks");

  const checks = Array.isArray(report.checks) ? report.checks : [];
  const checkNames: string[] = [];
  const nonPassingChecks: string[] = [];
  for (const check of checks) {
    if (!isRecord(check)
      || typeof check.name !== "string"
      || typeof check.summary !== "string"
      || (check.status !== "pass" && check.status !== "warn" && check.status !== "fail")
      || Object.keys(check).some((key) => !["name", "status", "summary"].includes(key))) {
      invalidCheckShapes.push(check);
      continue;
    }
    checkNames.push(check.name);
    if (check.status !== "pass") nonPassingChecks.push(check.name);
  }
  if (invalidCheckShapes.length > 0) missing.push("closedCheckShape");
  if (nonPassingChecks.length > 0) missing.push("allChecksPassing");
  const missingRequiredChecks = REQUIRED_PRODUCTION_ENV_CHECKS.filter((name) => !checkNames.includes(name));
  if (missingRequiredChecks.length > 0) missing.push("requiredReadinessChecks");
  if (manifestContainsTokenPayload(report)) missing.push("reportHasTokenOrConfigPayload");

  return [missing.length === 0
    ? {
        name: "production_env_preflight",
        status: "pass",
        summary: "Production env preflight passed with secret-free env-file readiness evidence for both desktop surfaces.",
        details: { path: evidence.path, generatedAt: report.generatedAt, configuredSurfaces },
      }
    : {
        name: "production_env_preflight",
        status: "fail",
        summary: "Production env preflight evidence is missing, stale, incomplete, warning-bearing, not env-file based, or unsafe for rollout evidence.",
        details: { path: evidence.path, missing, missingSurfaces, missingRequiredChecks, nonPassingChecks, unexpectedTopLevelKeys, invalidCheckShapes },
      }];
}

async function validateLiveProbeEvidence(
  baseDir: string,
  entry: LiveProbeEvidence,
  sessionEvidence: SessionIssuanceEvidence,
  candidate: CandidateReleaseBinding,
  checkedAt: Date
): Promise<RolloutGateCheck[]> {
  const evidencePath = resolveEvidencePath(baseDir, entry.path);
  const read = await readJson(evidencePath);
  if (!read.ok) {
    return [{ name: `live_probe_${entry.profile}`, status: "fail", summary: read.error, details: { path: entry.path } }];
  }
  const report = read.value as RecruiterReadinessProbeReport;
  const checks: RolloutGateCheck[] = [];
  if (!isRecord(report) || report.ok !== true || !Array.isArray(report.checks)) {
    checks.push({ name: `live_probe_${entry.profile}`, status: "fail", summary: "Live probe report did not pass or has an invalid shape.", details: { path: entry.path } });
    return checks;
  }
  checks.push({ name: `live_probe_${entry.profile}`, status: "pass", summary: "Recorded live-probe evidence validated (shape, freshness, required checks); this gate validates attested evidence, it does not itself observe the live MCP.", details: { path: entry.path, strict: report.strict } });
  checks.push(manifestContainsTokenPayload(report)
    ? { name: `live_probe_${entry.profile}_token_free`, status: "fail", summary: "Live probe evidence must not contain durable tokens, Authorization headers, or config payloads.", details: { path: entry.path } }
    : { name: `live_probe_${entry.profile}_token_free`, status: "pass", summary: "Live probe evidence is token-free." });
  checks.push(timestampFreshnessCheck(
    `live_probe_${entry.profile}_freshness`,
    report.generatedAt,
    checkedAt,
    "Live probe evidence was generated recently.",
    "Live probe evidence is missing, invalid, future-dated, or too old for final rollout.",
    { path: entry.path }
  ));
  checks.push(report.profile === entry.profile
    ? { name: `live_probe_${entry.profile}_profile_binding`, status: "pass", summary: "Live probe report is self-identified as the manifest profile." }
    : { name: `live_probe_${entry.profile}_profile_binding`, status: "fail", summary: "Live probe report profile must exactly match the manifest profile.", details: { reportedProfile: report.profile ?? null } });
  const reportedBuildCommit = typeof report.buildCommit === "string" && /^[0-9a-f]{40}$/i.test(report.buildCommit)
    ? report.buildCommit.toLowerCase()
    : null;
  checks.push(candidate.ok && reportedBuildCommit === candidate.commit
    ? { name: `live_probe_${entry.profile}_candidate_binding`, status: "pass", summary: "Live probe ran from the authoritative candidate build commit." }
    : { name: `live_probe_${entry.profile}_candidate_binding`, status: "fail", summary: "Live probe build commit must match the authoritative candidate commit.", details: { reportedBuildCommit } });
  const runBindingProblems = await validateLiveProbeRunBinding(baseDir, report, sessionEvidence);
  checks.push(runBindingProblems.length === 0
    ? { name: `live_probe_${entry.profile}_production_binding`, status: "pass", summary: "Live probe used an issued production client session and emitted audit events." }
    : { name: `live_probe_${entry.profile}_production_binding`, status: "fail", summary: "Live probe must use an issued production client session and emit audit events.", details: { problems: runBindingProblems } });

  const jobsSample = report.checks.find((check) => check.name === "scoped_jobs_sample");
  const scopeBinding = validateLiveProbeScopeBinding(entry.profile, jobsSample);
  checks.push(scopeBinding.ok
    ? { name: `live_probe_${entry.profile}_scope_binding`, status: "pass", summary: "Live probe permission scope matches its rollout profile." }
    : { name: `live_probe_${entry.profile}_scope_binding`, status: "fail", summary: "Live probe permission scope does not match its rollout profile.", details: { reason: scopeBinding.reason } });
  const scopeProblems = validateLiveProbeCheckScopes(entry.profile, report.checks, jobsSample);
  checks.push(scopeProblems.length === 0
    ? { name: `live_probe_${entry.profile}_scope_consistency`, status: "pass", summary: "Every data-bearing probe check ran under the same expected permission scope." }
    : { name: `live_probe_${entry.profile}_scope_consistency`, status: "fail", summary: "Every data-bearing probe check must run under the same expected permission scope.", details: { problems: scopeProblems } });

  const strictRequired = entry.profile !== "no_permissions";
  if (entry.strict !== strictRequired || report.strict !== strictRequired) {
    checks.push({ name: `live_probe_${entry.profile}_strict`, status: "fail", summary: "Manifest and report strictness must exactly match the rollout profile policy.", details: { manifestStrict: entry.strict ?? null, reportStrict: report.strict, strictRequired } });
  } else {
    checks.push({ name: `live_probe_${entry.profile}_strict`, status: "pass", summary: strictRequired ? "Strict rollout probe evidence is present." : "Strict rollout probe is not required for this profile." });
  }

  const requiredCheckProblems = validateLiveProbeRequiredChecks(entry.profile, report.checks);
  checks.push(requiredCheckProblems.length === 0
    ? { name: `live_probe_${entry.profile}_required_checks`, status: "pass", summary: "Live probe report includes exactly one acceptable result for every required scoped evidence and analysis check." }
    : {
        name: `live_probe_${entry.profile}_required_checks`,
        status: "fail",
        summary: "Live probe report has missing, duplicate, malformed, or disallowed required-check results.",
        details: { problems: requiredCheckProblems },
      });

  const failed = report.checks.filter((check) => check.status === "fail").map((check) => check.name);
  const warnings = report.checks.filter((check) => check.status === "warn").map((check) => check.name);
  if (failed.length > 0 || (strictRequired && warnings.length > 0)) {
    checks.push({ name: `live_probe_${entry.profile}_checks`, status: "fail", summary: "Live probe report still contains failed checks or strict-blocking warnings.", details: { failed, warnings } });
  } else {
    checks.push({ name: `live_probe_${entry.profile}_checks`, status: "pass", summary: "Live probe checks are acceptable for this rollout profile." });
  }

  const activityCheck = report.checks.find((check) => check.name === "activity_endpoint_shape");
  if (!activityCheck) {
    checks.push({
      name: `live_probe_${entry.profile}_activity_scope`,
      status: "fail",
      summary: "Live probe evidence must explicitly record the activity scoping decision.",
    });
  } else if (activityCheck.status !== "skip" && activityCheck.status !== "pass") {
    checks.push({
      name: `live_probe_${entry.profile}_activity_scope`,
      status: "fail",
      summary: "Activity scoping evidence must be skipped for v1 or passed after live endpoint validation.",
      details: { status: activityCheck.status },
    });
  } else {
    checks.push({
      name: `live_probe_${entry.profile}_activity_scope`,
      status: "pass",
      summary: activityCheck.status === "skip"
        ? "Activity endpoint remains intentionally unexposed in v1."
        : "Activity endpoint shape was validated before exposure.",
    });
  }

  if (entry.profile === "no_permissions") {
    const denominators = validateProbeDenominators(report.checks, "zero");
    checks.push(denominators.length === 0
      ? { name: `live_probe_${entry.profile}_zero_data`, status: "pass", summary: "No-permissions probe returned zero rows across every required evidence and analysis denominator." }
      : { name: `live_probe_${entry.profile}_zero_data`, status: "fail", summary: "No-permissions probe did not prove zero visibility across every required denominator.", details: { problems: denominators } });
  }
  if (entry.profile !== "no_permissions") {
    // Re-derive the non-empty assertion from the recorded probe evidence so an old probe that did not
    // self-enforce expectVisibleData still cannot ship a zero-denominator analysis through the gate.
    const denominatorProblems = validateProbeDenominators(report.checks, "positive");
    checks.push(denominatorProblems.length === 0
      ? { name: `live_probe_${entry.profile}_visible_data`, status: "pass", summary: "Data-bearing probe profile carried visible data through every present analysis denominator and sample." }
      : { name: `live_probe_${entry.profile}_visible_data`, status: "fail", summary: "Data-bearing probe profile must report a positive exact integer for every required evidence and analysis denominator.", details: { problems: denominatorProblems } });
  }
  return checks;
}

// Scan recorded probe checks for any data-bearing denominator that is exactly 0 (returns
// "checkName.denominatorKey" entries). Shares VISIBLE_DATA_DENOMINATORS with the probe so the gate's
// re-derivation and the probe's self-enforcement can never disagree on which signals must be non-empty.
function validateProbeDenominators(
  checks: RecruiterReadinessProbeReport["checks"],
  expected: "zero" | "positive"
): string[] {
  const problems: string[] = [];
  const denominators = expected === "zero" ? NO_PERMISSION_DATA_DENOMINATORS : VISIBLE_DATA_DENOMINATORS;
  for (const [checkName, denominatorKey] of denominators) {
    const check = checks.find((candidate) => isRecord(candidate) && candidate.name === checkName);
    if (!isRecord(check) || !isRecord(check.details)) {
      problems.push(`${checkName}.${denominatorKey}:missing`);
      continue;
    }
    const value = check.details[denominatorKey];
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      problems.push(`${checkName}.${denominatorKey}:invalid`);
    } else if (expected === "zero" ? value !== 0 : value === 0) {
      problems.push(`${checkName}.${denominatorKey}:${expected === "zero" ? "nonzero" : "zero"}`);
    }
  }
  return problems;
}

const NO_PERMISSIONS_ALLOWED_SKIPS = new Set([
  "expected_job_visibility",
  "forbidden_job_exclusion",
  "endpoint_contract_jobs_ids",
  "endpoint_contract_forbidden_jobs_ids",
  "endpoint_contract_applications_ids",
  "endpoint_contract_applications_job_ids",
  "endpoint_contract_applications_candidate_ids",
  "scorecard_shape_sample",
  "activity_endpoint_shape",
]);
const REPEATABLE_LIVE_PROBE_CHECKS = new Set([
  "expected_job_visibility",
  "forbidden_job_exclusion",
  "endpoint_contract_forbidden_jobs_ids",
]);

function validateLiveProbeRequiredChecks(
  profile: LiveProbeEvidence["profile"],
  checks: RecruiterReadinessProbeReport["checks"]
): string[] {
  const problems: string[] = [];
  for (const name of REQUIRED_LIVE_PROBE_CHECKS) {
    const matches = checks.filter((check) => isRecord(check) && check.name === name);
    if (matches.length === 0 || (!REPEATABLE_LIVE_PROBE_CHECKS.has(name) && matches.length !== 1)) {
      problems.push(`${name}:${matches.length === 0 ? "missing" : "duplicate"}`);
      continue;
    }
    for (const match of matches) {
      const status = match.status;
      const allowed = name === "activity_endpoint_shape"
        ? status === "skip" || status === "pass"
        : profile === "no_permissions" && NO_PERMISSIONS_ALLOWED_SKIPS.has(name)
          ? status === "skip" || status === "pass"
          : status === "pass";
      if (!allowed) problems.push(`${name}:status_${String(status)}`);
    }
  }
  return problems;
}

function validateLiveProbeCheckScopes(
  profile: LiveProbeEvidence["profile"],
  checks: RecruiterReadinessProbeReport["checks"],
  jobsSample: RecruiterReadinessProbeReport["checks"][number] | undefined
): string[] {
  if (!isRecord(jobsSample) || !isRecord(jobsSample.details)) return ["scoped_jobs_sample:scope_missing"];
  const expectedKind = jobsSample.details.permissionScopeKind;
  const expectedCount = jobsSample.details.permittedJobCount;
  const expectedScoped = expectedKind === "operator" ? false : true;
  const problems: string[] = [];
  for (const check of checks) {
    if (!isRecord(check) || typeof check.name !== "string" || !SCOPE_BOUND_LIVE_PROBE_CHECKS.has(check.name)) continue;
    if (!isRecord(check.details)) {
      problems.push(`${check.name}:details_missing`);
      continue;
    }
    if (check.details.permissionScopeKind !== expectedKind) {
      problems.push(`${check.name}:scope_kind_mismatch`);
    }
    if (check.details.scoped !== expectedScoped) {
      problems.push(`${check.name}:scoped_flag_mismatch`);
    }
    if (profile === "all_jobs_or_operator") {
      if (check.details.permittedJobCount !== null) problems.push(`${check.name}:permitted_count_mismatch`);
    } else if (check.details.permittedJobCount !== expectedCount) {
      problems.push(`${check.name}:permitted_count_mismatch`);
    }
  }
  return problems;
}

async function validateLiveProbeRunBinding(
  baseDir: string,
  report: RecruiterReadinessProbeReport,
  sessionEvidence: SessionIssuanceEvidence
): Promise<string[]> {
  const problems: string[] = [];
  const surface = report.surface === "chatgpt_desktop" || report.surface === "claude_desktop" ? report.surface : null;
  const client = isRecruiterClient(report.client) ? report.client : null;
  if (!surface) problems.push("production_surface");
  if (!client || (surface && !isClientSurfaceCompatible(client, surface))) problems.push("physical_client");
  if (report.sessionSubjectPresent !== true) problems.push("session_subject");
  if (!Number.isSafeInteger(report.auditEventCount) || report.auditEventCount <= 0) problems.push("positive_audit_event_count");
  if (!isExactSessionTokenId(report.sessionTokenId)) problems.push("session_token_id");
  if (!isExactIsoTimestamp(report.sessionIssuedAt)) problems.push("session_issued_at");

  const read = await readJson(resolveEvidencePath(baseDir, sessionEvidence.path));
  const files = read.ok && isRecord(read.value) && Array.isArray(read.value.files) ? read.value.files : [];
  const issuedBinding = surface && client && isExactSessionTokenId(report.sessionTokenId) && isExactIsoTimestamp(report.sessionIssuedAt)
    ? files.some((file) => isRecord(file)
        && file.surface === surface
        && file.client === client
        && file.tokenId === report.sessionTokenId
        && file.issuedAt === report.sessionIssuedAt)
    : false;
  if (!issuedBinding) problems.push("issued_session_binding");
  return problems;
}

function validateLiveProbeScopeBinding(
  profile: LiveProbeEvidence["profile"],
  check: RecruiterReadinessProbeReport["checks"][number] | undefined
): { ok: true } | { ok: false; reason: string } {
  if (!isRecord(check) || !isRecord(check.details)) return { ok: false, reason: "scoped_jobs_details_missing" };
  const kind = check.details.permissionScopeKind;
  const count = check.details.permittedJobCount;
  if (profile === "small_req_set") {
    return kind === "jobs" && Number.isSafeInteger(count) && (count as number) >= 1 && (count as number) <= 25
      ? { ok: true }
      : { ok: false, reason: "small_req_scope_mismatch" };
  }
  if (profile === "many_req_set") {
    return kind === "jobs" && Number.isSafeInteger(count) && (count as number) >= 26
      ? { ok: true }
      : { ok: false, reason: "many_req_scope_mismatch" };
  }
  if (profile === "all_jobs_or_operator") {
    return kind === "all" || kind === "operator"
      ? { ok: true }
      : { ok: false, reason: "all_jobs_scope_mismatch" };
  }
  return kind === "jobs" && count === 0
    ? { ok: true }
    : { ok: false, reason: "no_permissions_scope_mismatch" };
}

async function validateRevocationDrill(
  baseDir: string,
  evidence: RevocationDrillEvidence,
  sessionEvidence: SessionIssuanceEvidence,
  desktopEvidence: DesktopConfigEvidence,
  checkedAt: Date
): Promise<RolloutGateCheck[]> {
  const checkName = `revocation_drill_${evidence.client}`;
  if (typeof evidence.path !== "string" || evidence.path.trim().length === 0) {
    return [{ name: checkName, status: "fail", summary: "Session revocation drill evidence path is required." }];
  }
  const evidencePath = resolveEvidencePath(baseDir, evidence.path);
  const read = await readJson(evidencePath);
  if (!read.ok) {
    return [{ name: checkName, status: "fail", summary: read.error, details: { path: evidence.path } }];
  }

  const report = read.value as SessionRevocationDrillReport;
  const missing: string[] = [];
  if (!isRecord(report) || report.reportVersion !== 2 || report.ok !== true || report.status !== "pass") missing.push("passingV2Report");
  appendTimestampFreshnessMissing(missing, report.checkedAt, "checkedAt", "checkedAtFreshness", checkedAt);
  const activeSessionTokenIdValid = isExactSessionTokenId(report.activeSessionTokenId);
  const activeSessionIssuedAtValid = isExactIsoTimestamp(report.activeSessionIssuedAt);
  const activeSessionSurfaceValid = REQUIRED_SURFACES.includes(report.activeSessionSurface as (typeof REQUIRED_SURFACES)[number]);
  if (!activeSessionTokenIdValid) missing.push("activeSessionTokenId");
  if (!activeSessionIssuedAtValid) missing.push("activeSessionIssuedAt");
  if (!isExactSessionTokenId(report.revokedSessionTokenId)) missing.push("revokedSessionTokenId");
  if (!isExactIsoTimestamp(report.revokedSessionIssuedAt)) missing.push("revokedSessionIssuedAt");
  if (report.activeSessionTokenId && report.revokedSessionTokenId && report.activeSessionTokenId === report.revokedSessionTokenId) missing.push("distinctTokenIds");
  if (!activeSessionSurfaceValid) missing.push("activeSessionSurface");
  if (!REQUIRED_SURFACES.includes(report.revokedSessionSurface as (typeof REQUIRED_SURFACES)[number])) missing.push("revokedSessionSurface");
  if (report.activeSessionSurface !== evidence.surface) missing.push("activeSessionSurfaceMatchesManifest");
  if (report.revokedSessionSurface !== evidence.surface) missing.push("revokedSessionSurfaceMatchesManifest");
  if (report.activeSessionClient !== evidence.client) missing.push("activeSessionClientMatchesManifest");
  if (report.revokedSessionClient !== evidence.client) missing.push("revokedSessionClientMatchesManifest");
  if (report.containsTokens !== false) missing.push("tokenFreeReport");
  if (manifestContainsTokenPayload(report)) missing.push("reportHasTokenOrConfigPayload");

  const productionUrl = validateProductionMcpUrl(report.mcpUrl);
  if (!productionUrl.ok) missing.push("productionHttpsMcpUrl");

  const activeTokenBinding = activeSessionTokenIdValid && activeSessionIssuedAtValid && activeSessionSurfaceValid
    ? await validateActiveRevocationTokenBinding(baseDir, report, evidence.client, sessionEvidence, desktopEvidence)
    : { ok: true as const };
  if (!activeTokenBinding.ok) missing.push("activeSessionIssuedTokenBinding");

  const checks = isRecord(report) && Array.isArray(report.checks) ? report.checks : [];
  const requiredChecks = ["active_token_metadata", "revoked_token_metadata", "matching_client_identity", "distinct_token_ids", "active_initialize", "revoked_initialize_denied"];
  const missingChecks = requiredChecks.filter((name) => !checks.some((check) => isRecord(check) && check.name === name && check.status === "pass"));
  if (missingChecks.length > 0) missing.push("requiredPassingChecks");
  const failedChecks = checks.flatMap((check) => {
    if (!isRecord(check) || check.status !== "fail" || typeof check.name !== "string") return [];
    return [check.name];
  });
  if (failedChecks.length > 0) missing.push("failedChecks");

  return [missing.length === 0
    ? { name: checkName, status: "pass", summary: "Remote session revocation drill passed for the required physical client with an active token from the issued rollout set.", details: { path: evidence.path, client: evidence.client, activeSessionTokenId: report.activeSessionTokenId, activeSessionIssuedAt: report.activeSessionIssuedAt, revokedSessionTokenId: report.revokedSessionTokenId, revokedSessionIssuedAt: report.revokedSessionIssuedAt } }
    : { name: checkName, status: "fail", summary: "Remote session revocation drill evidence is incomplete, attributed to the wrong client, did not prove revoked-token denial, or used an active token outside the issued rollout set.", details: { path: evidence.path, client: evidence.client, missing, missingChecks, failedChecks, activeTokenBindingMissing: activeTokenBinding.ok ? [] : activeTokenBinding.missing, mcpUrlReason: productionUrl.ok ? undefined : productionUrl.reason } }];
}

async function validateSessionRevocationEvidence(
  baseDir: string,
  evidence: SessionRevocationEvidence,
  drillEvidence: RevocationDrillEvidence | undefined,
  checkedAt: Date
): Promise<RolloutGateCheck[]> {
  const checkName = `session_revocation_write_${evidence.client}`;
  if (typeof evidence.path !== "string" || evidence.path.trim().length === 0) {
    return [{ name: checkName, status: "fail", summary: "Session revocation write evidence path is required." }];
  }
  const evidencePath = resolveEvidencePath(baseDir, evidence.path);
  const read = await readJson(evidencePath);
  if (!read.ok) {
    return [{ name: checkName, status: "fail", summary: read.error, details: { path: evidence.path } }];
  }

  const report = read.value as SessionRevocationWriteReport;
  const missing: string[] = [];
  if (!isRecord(report) || report.ok !== true) missing.push("passingReport");
  if (report.status !== "revoked") missing.push("revokedStatus");
  if (typeof report.table !== "string" || report.table.trim().length === 0) missing.push("table");
  if (!isExactSessionTokenId(report.tokenId)) missing.push("tokenId");
  appendTimestampFreshnessMissing(missing, report.revokedAt, "revokedAt", "revokedAtFreshness", checkedAt);
  if (typeof report.revokedBy !== "string" || report.revokedBy.trim().length === 0) missing.push("revokedBy");
  if (typeof report.reason !== "string" || report.reason.trim().length === 0) missing.push("reason");
  if (report.containsTokens !== false) missing.push("tokenFreeReport");
  if (manifestContainsTokenPayload(report)) missing.push("reportHasTokenOrConfigPayload");

  let revokedDrillTokenId: string | undefined;
  if (!drillEvidence || typeof drillEvidence.path !== "string" || drillEvidence.path.trim().length === 0) {
    missing.push("revocationDrillPath");
  } else {
    const drillRead = await readJson(resolveEvidencePath(baseDir, drillEvidence.path));
    if (!drillRead.ok) {
      missing.push("revocationDrillReadable");
    } else {
      const drillReport = drillRead.value as SessionRevocationDrillReport;
      revokedDrillTokenId = exactSessionTokenIdOrEmpty(drillReport.revokedSessionTokenId) || undefined;
      if (!revokedDrillTokenId) missing.push("revokedSessionTokenId");
      if (isExactSessionTokenId(report.tokenId) && revokedDrillTokenId && report.tokenId !== revokedDrillTokenId) {
        missing.push("revokedTokenIdMatchesDrill");
      }
    }
  }

  return [missing.length === 0
    ? {
        name: checkName,
        status: "pass",
        summary: "Session revocation write evidence proves the revoked drill token id was written to the central revocation table.",
        details: { path: evidence.path, client: evidence.client, tokenId: report.tokenId, revokedAt: report.revokedAt, table: report.table },
      }
    : {
        name: checkName,
        status: "fail",
        summary: "Session revocation write evidence is missing, stale, token-bearing, or does not match the revoked drill token id.",
        details: { path: evidence.path, missing, revokedDrillTokenId },
      }];
}

async function validateDistinctRevokedTokenIds(
  baseDir: string,
  evidenceEntries: RevocationDrillEvidence[]
): Promise<RolloutGateCheck[]> {
  const tokenIdsByClient = new Map<RecruiterClient, string>();
  const unreadableClients: RecruiterClient[] = [];
  for (const evidence of evidenceEntries) {
    const read = await readJson(resolveEvidencePath(baseDir, evidence.path));
    if (!read.ok) {
      unreadableClients.push(evidence.client);
      continue;
    }
    const report = read.value as SessionRevocationDrillReport;
    const tokenId = exactSessionTokenIdOrEmpty(report.revokedSessionTokenId);
    if (tokenId) tokenIdsByClient.set(evidence.client, tokenId);
  }
  const duplicateTokenIds = [...new Set([...tokenIdsByClient.values()].filter((tokenId, index, values) =>
    values.indexOf(tokenId) !== index))];
  const missingClients = REQUIRED_CLIENT_IDENTITIES.map((identity) => identity.client)
    .filter((client) => !tokenIdsByClient.has(client));
  return [unreadableClients.length === 0 && missingClients.length === 0 && duplicateTokenIds.length === 0
    ? {
        name: "revocation_distinct_client_tokens",
        status: "pass",
        summary: "Each physical client revocation drill used a distinct revoked token id.",
      }
    : {
        name: "revocation_distinct_client_tokens",
        status: "fail",
        summary: "Physical-client revocation drills must use three readable, distinct revoked token ids.",
        details: { unreadableClients, missingClients, duplicateTokenIds },
      }];
}

async function validateActiveRevocationTokenBinding(
  baseDir: string,
  report: SessionRevocationDrillReport,
  client: RecruiterClient,
  sessionEvidence: SessionIssuanceEvidence,
  desktopEvidence: DesktopConfigEvidence
): Promise<{ ok: true } | { ok: false; missing: string[] }> {
  const missing: string[] = [];
  const surface = report.activeSessionSurface as (typeof REQUIRED_SURFACES)[number];
  const tokenId = exactSessionTokenIdOrEmpty(report.activeSessionTokenId);
  const issuedAt = isExactIsoTimestamp(report.activeSessionIssuedAt) ? report.activeSessionIssuedAt : "";

  const sessionRead = await readJson(resolveEvidencePath(baseDir, sessionEvidence.path));
  const desktopRead = await readJson(resolveEvidencePath(baseDir, desktopEvidence.path));
  if (!sessionRead.ok) missing.push("sessionIssuanceEvidenceReadable");
  if (!desktopRead.ok) missing.push("desktopConfigEvidenceReadable");

  if (sessionRead.ok) {
    const expectedIssuedAt = issuedAtForTokenIdFromManifestFiles(sessionRead.value as IssuedEmailSessionFileManifest, surface, tokenId, client);
    if (expectedIssuedAt === undefined) missing.push("activeSessionIssuanceTokenId");
    else if (expectedIssuedAt !== issuedAt) missing.push("activeSessionIssuanceIssuedAt");
  }
  if (desktopRead.ok) {
    const expectedIssuedAt = issuedAtForTokenIdFromManifestFiles(desktopRead.value as DesktopConfigFileManifest, surface, tokenId, client);
    if (expectedIssuedAt === undefined) missing.push("activeDesktopConfigTokenId");
    else if (expectedIssuedAt !== issuedAt) missing.push("activeDesktopConfigIssuedAt");
  }

  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

async function validateDistributionEvidence(
  baseDir: string,
  entry: DistributionValidationEvidence,
  sessionEvidence: SessionIssuanceEvidence,
  desktopEvidence: DesktopConfigEvidence,
  checkedAt: Date
): Promise<RolloutGateCheck[]> {
  const checkPrefix = `distribution_${entry.client}`;
  const evidencePath = resolveEvidencePath(baseDir, entry.path);
  const read = await readJson(evidencePath);
  if (!read.ok) {
    return [{ name: checkPrefix, status: "fail", summary: read.error, details: { path: entry.path } }];
  }
  const report = read.value as DistributionValidationReport;
  if (!isRecord(report) || report.ok !== true || report.status !== "ready" || !Array.isArray(report.toolNames) || !Array.isArray(report.checks)) {
    return [{ name: checkPrefix, status: "fail", summary: "Distribution validation report did not pass or has an invalid shape.", details: { path: entry.path } }];
  }
  const validatorChecks = summarizeRequiredDistributionChecks(report.checks);
  const toolSet = new Set(report.toolNames);
  const missingAnalysis = REQUIRED_ANALYSIS_TOOLS.filter((toolName) => !toolSet.has(toolName));
  const missingCatalog = REQUIRED_RECRUITER_TOOL_NAMES.filter((toolName) => !toolSet.has(toolName));
  const unexpectedCatalog = report.toolNames.filter((toolName) => !PILOT_TOOL_NAME_SET.has(toolName));
  const duplicateCatalog = [...new Set(report.toolNames.filter((toolName, index) => report.toolNames.indexOf(toolName) !== index))];
  const catalogOrderMatches = report.toolNames.every((toolName, index) => toolName === REQUIRED_RECRUITER_TOOL_NAMES[index]);
  const productionUrl = validateProductionMcpUrl(report.mcpUrl);
  const endpointBinding = validateDistributionEndpointBinding(report);
  const versionBinding = validateDistributionVersionBinding(report);
  const tokenPayloadPresent = manifestContainsTokenPayload(report);
  const sessionSurfaceMatches = report.sessionSurface === entry.surface;
  const sessionClientMatches = report.sessionClient === entry.client;
  const tokenBinding = await validateDistributionIssuedTokenBinding(
    baseDir,
    report.sessionTokenId,
    report.sessionIssuedAt,
    entry.surface,
    entry.client,
    sessionEvidence,
    desktopEvidence
  );
  return [
    { name: checkPrefix, status: "pass", summary: "Recorded remote-MCP distribution evidence validated; this gate validates attested evidence, it does not itself observe the live MCP.", details: { path: entry.path, client: entry.client, toolCount: report.toolNames.length } },
    tokenPayloadPresent
      ? { name: `${checkPrefix}_token_free`, status: "fail", summary: "Distribution validation evidence must not contain durable tokens, Authorization headers, or config payloads.", details: { path: entry.path } }
      : { name: `${checkPrefix}_token_free`, status: "pass", summary: "Distribution validation evidence is token-free." },
    timestampFreshnessCheck(
      `${checkPrefix}_freshness`,
      report.checkedAt,
      checkedAt,
      "Remote MCP distribution validation evidence was generated recently.",
      "Remote MCP distribution validation evidence is missing, invalid, future-dated, or too old for final rollout.",
      { path: entry.path }
    ),
    sessionSurfaceMatches
      ? { name: `${checkPrefix}_session_surface`, status: "pass", summary: "Distribution validation used a durable session token for the expected desktop surface.", details: { sessionSurface: report.sessionSurface } }
      : { name: `${checkPrefix}_session_surface`, status: "fail", summary: "Distribution validation evidence must be generated with a durable session token for the manifest desktop surface.", details: { expectedSurface: entry.surface, sessionSurface: report.sessionSurface ?? null } },
    sessionClientMatches
      ? { name: `${checkPrefix}_session_client`, status: "pass", summary: "Distribution validation used a durable session token for the expected physical client.", details: { sessionClient: report.sessionClient } }
      : { name: `${checkPrefix}_session_client`, status: "fail", summary: "Distribution validation evidence must be generated with a durable session token for the manifest physical client.", details: { expectedClient: entry.client, sessionClient: report.sessionClient ?? null } },
    tokenBinding.ok
      ? { name: `${checkPrefix}_issued_token`, status: "pass", summary: "Distribution validation used durable session metadata present in both session issuance and desktop config evidence for this client.", details: { tokenId: tokenBinding.tokenId, issuedAt: tokenBinding.issuedAt } }
      : { name: `${checkPrefix}_issued_token`, status: "fail", summary: "Distribution validation session metadata must match an issued session and generated desktop config for the manifest client.", details: { tokenId: report.sessionTokenId ?? null, issuedAt: report.sessionIssuedAt ?? null, missing: tokenBinding.missing } },
    productionUrl.ok
      ? { name: `${checkPrefix}_production_url`, status: "pass", summary: "Distribution validation used a production HTTPS MCP URL.", details: { mcpUrl: productionUrl.url } }
      : { name: `${checkPrefix}_production_url`, status: "fail", summary: "Final rollout distribution evidence must use a credential-free production HTTPS MCP URL, not localhost or an insecure development URL.", details: { reason: productionUrl.reason } },
    endpointBinding.ok
      ? { name: `${checkPrefix}_candidate_endpoints`, status: "pass", summary: "Distribution health, readiness, version, and MCP checks used canonical paths on one candidate origin.", details: { origin: endpointBinding.origin } }
      : { name: `${checkPrefix}_candidate_endpoints`, status: "fail", summary: "Distribution health, readiness, version, and MCP URLs must use canonical paths on one credential-free candidate origin.", details: { reason: endpointBinding.reason } },
    versionBinding.ok
      ? { name: `${checkPrefix}_version_commit`, status: "pass", summary: "Distribution validation observed the exact expected candidate commit at the same-origin /version endpoint.", details: { expectedCommit: versionBinding.commit, versionUrl: versionBinding.versionUrl } }
      : { name: `${checkPrefix}_version_commit`, status: "fail", summary: "Distribution validation must bind the tested MCP to an exact expected 40-character candidate commit at its same-origin /version endpoint.", details: { reason: versionBinding.reason } },
    validatorChecks.ok
      ? { name: `${checkPrefix}_validator_checks`, status: "pass", summary: "Distribution validation report includes the current production catalog and transport checks." }
      : {
          name: `${checkPrefix}_validator_checks`,
          status: "fail",
          summary: "Distribution validation report is stale or has failing validator checks.",
          details: {
            missingRequiredChecks: validatorChecks.missingRequiredChecks,
            failedChecks: validatorChecks.failedChecks,
          },
        },
    missingCatalog.length === 0 && unexpectedCatalog.length === 0 && duplicateCatalog.length === 0 && report.toolNames.length === REQUIRED_RECRUITER_TOOL_NAMES.length && catalogOrderMatches
      ? { name: `${checkPrefix}_exact_catalog`, status: "pass", summary: `Remote catalog exactly matches the ${REQUIRED_RECRUITER_TOOL_NAMES.length}-tool pilot allowlist.` }
      : { name: `${checkPrefix}_exact_catalog`, status: "fail", summary: "Remote catalog does not exactly match the active pilot allowlist.", details: { missing: missingCatalog, unexpected: unexpectedCatalog, duplicates: duplicateCatalog, orderMatch: catalogOrderMatches, expectedCount: REQUIRED_RECRUITER_TOOL_NAMES.length, actualCount: report.toolNames.length } },
    missingAnalysis.length === 0
      ? { name: `${checkPrefix}_analysis_tools`, status: "pass", summary: "Remote catalog includes the ambitious analysis tools." }
      : { name: `${checkPrefix}_analysis_tools`, status: "fail", summary: "Remote catalog is missing required analysis tools.", details: { missing: missingAnalysis } },
  ];
}

function validateDistributionEndpointBinding(
  report: DistributionValidationReport
): { ok: true; origin: string } | { ok: false; reason: string } {
  const fields = [
    ["mcpUrl", report.mcpUrl, "/mcp"],
    ["healthUrl", report.healthUrl, "/healthz"],
    ["readinessUrl", report.readinessUrl, "/readyz"],
    ["versionUrl", report.versionUrl, "/version"],
  ] as const;
  const parsed: URL[] = [];
  for (const [name, value, pathname] of fields) {
    if (typeof value !== "string") return { ok: false, reason: `${name}_missing` };
    try {
      const url = new URL(value);
      if (url.protocol !== "https:") return { ok: false, reason: `${name}_not_https` };
      if (url.username || url.password || url.search || url.hash) return { ok: false, reason: `${name}_unsafe_url_components` };
      if (url.pathname !== pathname) return { ok: false, reason: `${name}_noncanonical_path` };
      parsed.push(url);
    } catch {
      return { ok: false, reason: `${name}_invalid` };
    }
  }
  const origin = parsed[0]!.origin;
  return parsed.every((url) => url.origin === origin)
    ? { ok: true, origin }
    : { ok: false, reason: "mixed_endpoint_origins" };
}

function validateDistributionVersionBinding(
  report: DistributionValidationReport
): { ok: true; commit: string; versionUrl: string } | { ok: false; reason: string } {
  if (typeof report.versionUrl !== "string") return { ok: false, reason: "version_url_missing" };
  if (typeof report.expectedCommit !== "string" || !/^[0-9a-f]{40}$/i.test(report.expectedCommit)) {
    return { ok: false, reason: "expected_commit_invalid" };
  }
  if (typeof report.observedCommit !== "string" || report.observedCommit.toLowerCase() !== report.expectedCommit.toLowerCase()) {
    return { ok: false, reason: "observed_commit_mismatch" };
  }
  try {
    const mcp = new URL(report.mcpUrl);
    const version = new URL(report.versionUrl);
    if (version.protocol !== "https:" || version.origin !== mcp.origin || version.pathname !== "/version" || version.search || version.hash) {
      return { ok: false, reason: "version_url_not_same_origin_canonical_path" };
    }
    return { ok: true, commit: report.expectedCommit.toLowerCase(), versionUrl: version.toString() };
  } catch {
    return { ok: false, reason: "version_url_invalid" };
  }
}

type CandidateReleaseBinding =
  | { ok: true; mcpUrl: string; readyzUrl: string; versionUrl: string; commit: string; check: RolloutGateCheck }
  | { ok: false; check: RolloutGateCheck };

async function validateCandidateReleaseBinding(
  baseDir: string,
  authoritative: CandidateReleaseEvidence,
  entries: DistributionValidationEvidence[]
): Promise<CandidateReleaseBinding> {
  const mcpUrls: string[] = [];
  const commits: string[] = [];
  const problems: string[] = [];
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) problems.push("duplicate_evidence_paths");

  const authoritativeUrl = validateCanonicalCandidateMcpUrl(authoritative.mcpUrl);
  const authoritativeCommit = typeof authoritative.commit === "string" && /^[0-9a-f]{40}$/i.test(authoritative.commit)
    ? authoritative.commit.toLowerCase()
    : null;
  if (!authoritativeUrl.ok) problems.push(`authoritative_candidate_url:${authoritativeUrl.reason}`);
  if (!authoritativeCommit) problems.push("authoritative_candidate_commit_invalid");

  for (const entry of entries) {
    const read = await readJson(resolveEvidencePath(baseDir, entry.path));
    if (!read.ok || !isRecord(read.value)) {
      problems.push(`unreadable_report:${entry.client}`);
      continue;
    }
    const report = read.value as unknown as DistributionValidationReport;
    const endpoints = validateDistributionEndpointBinding(report);
    const version = validateDistributionVersionBinding(report);
    if (!endpoints.ok) problems.push(`invalid_endpoints:${entry.client}`);
    if (!version.ok) problems.push(`invalid_commit:${entry.client}`);
    const mcp = validateProductionMcpUrl(report.mcpUrl);
    if (mcp.ok) {
      mcpUrls.push(mcp.url);
      if (authoritativeUrl.ok && mcp.url !== authoritativeUrl.url) problems.push(`candidate_url_mismatch:${entry.client}`);
    }
    if (version.ok) {
      commits.push(version.commit);
      if (authoritativeCommit && version.commit !== authoritativeCommit) problems.push(`candidate_commit_mismatch:${entry.client}`);
    }
  }

  const uniqueUrls = [...new Set(mcpUrls)];
  const uniqueCommits = [...new Set(commits)];
  if (uniqueUrls.length !== 1) problems.push("mixed_candidate_mcp_urls");
  if (uniqueCommits.length !== 1) problems.push("mixed_candidate_commits");
  if (mcpUrls.length !== REQUIRED_CLIENT_IDENTITIES.length) problems.push("candidate_url_coverage");
  if (commits.length !== REQUIRED_CLIENT_IDENTITIES.length) problems.push("candidate_commit_coverage");

  if (problems.length > 0) {
    return {
      ok: false,
      check: {
        name: "candidate_release_binding",
        status: "fail",
        summary: "All physical-client distribution reports must bind to one exact candidate MCP URL and commit.",
        details: { problems: [...new Set(problems)] },
      },
    };
  }
  const mcpUrl = authoritativeUrl.ok ? authoritativeUrl.url : uniqueUrls[0]!;
  const readyzUrl = siblingCandidateUrl(mcpUrl, "/readyz");
  const versionUrl = siblingCandidateUrl(mcpUrl, "/version");
  const commit = authoritativeCommit ?? uniqueCommits[0]!;
  return {
    ok: true,
    mcpUrl,
    readyzUrl,
    versionUrl,
    commit,
    check: {
      name: "candidate_release_binding",
      status: "pass",
      summary: "All physical-client distribution reports bind to one exact candidate MCP URL and commit.",
      details: { mcpUrl, commit },
    },
  };
}

function validateCanonicalCandidateMcpUrl(value: unknown): ReturnType<typeof validateProductionMcpUrl> {
  const validated = validateProductionMcpUrl(value);
  if (!validated.ok) return validated;
  const parsed = new URL(validated.url);
  if (parsed.pathname !== "/mcp") return { ok: false, reason: "non_canonical_mcp_path" };
  return validated;
}

async function validateRevocationCandidateBinding(
  baseDir: string,
  entries: RevocationDrillEvidence[],
  candidate: CandidateReleaseBinding
): Promise<RolloutGateCheck> {
  if (!candidate.ok) {
    return { name: "revocation_candidate_binding", status: "fail", summary: "Revocation drills cannot be bound until candidate distribution reports agree." };
  }
  const mismatchedClients: string[] = [];
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) mismatchedClients.push("duplicate_evidence_paths");
  for (const entry of entries) {
    const read = await readJson(resolveEvidencePath(baseDir, entry.path));
    const mcp = read.ok && isRecord(read.value) ? validateProductionMcpUrl(read.value.mcpUrl) : { ok: false as const, reason: "unreadable" };
    if (!mcp.ok || mcp.url !== candidate.mcpUrl) mismatchedClients.push(entry.client);
  }
  return mismatchedClients.length === 0
    ? { name: "revocation_candidate_binding", status: "pass", summary: "Every physical-client revocation drill used the pinned candidate MCP endpoint." }
    : { name: "revocation_candidate_binding", status: "fail", summary: "Every physical-client revocation drill must use the pinned candidate MCP endpoint.", details: { mismatchedClients } };
}

function validateLiveReadyzCandidateBinding(
  value: unknown,
  candidate: CandidateReleaseBinding
): RolloutGateCheck {
  if (!candidate.ok) {
    return { name: "live_readyz_candidate_binding", status: "fail", summary: "Live readiness cannot be bound until candidate distribution reports agree." };
  }
  const readyz = validateProductionMcpUrl(value);
  return readyz.ok && readyz.url === candidate.readyzUrl
    ? { name: "live_readyz_candidate_binding", status: "pass", summary: "Live /readyz observation targets the pinned candidate origin." }
    : { name: "live_readyz_candidate_binding", status: "fail", summary: "Live /readyz observation must target the pinned candidate origin and canonical /readyz path.", details: { reason: readyz.ok ? "candidate_url_mismatch" : readyz.reason } };
}

function siblingCandidateUrl(mcpUrl: string, pathname: string): string {
  const url = new URL(mcpUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function summarizeRequiredDistributionChecks(checks: unknown[]): { ok: true } | { ok: false; missingRequiredChecks: string[]; failedChecks: string[] } {
  const missingRequiredChecks = REQUIRED_DISTRIBUTION_CHECKS.filter(
    (name) => !checks.some((check) => isRecord(check) && check.name === name && check.status === "pass")
  );
  const failedChecks = checks.flatMap((check) => {
    if (!isRecord(check) || check.status !== "fail" || typeof check.name !== "string") return [];
    return [check.name];
  });
  return missingRequiredChecks.length === 0 && failedChecks.length === 0
    ? { ok: true }
    : { ok: false, missingRequiredChecks, failedChecks };
}

async function validateDistributionIssuedTokenBinding(
  baseDir: string,
  tokenId: unknown,
  issuedAt: unknown,
  surface: DistributionValidationEvidence["surface"],
  client: DistributionValidationEvidence["client"],
  sessionEvidence: SessionIssuanceEvidence,
  desktopEvidence: DesktopConfigEvidence
): Promise<{ ok: true; tokenId: string; issuedAt: string } | { ok: false; missing: string[] }> {
  const missing: string[] = [];
  const normalizedTokenId = exactSessionTokenIdOrEmpty(tokenId);
  const normalizedIssuedAt = isExactIsoTimestamp(issuedAt) ? issuedAt : "";
  const issuedAtValid = normalizedIssuedAt.length > 0;
  if (!normalizedTokenId) missing.push("distributionSessionTokenId");
  if (!issuedAtValid) missing.push("distributionSessionIssuedAt");

  const sessionRead = await readJson(resolveEvidencePath(baseDir, sessionEvidence.path));
  const desktopRead = await readJson(resolveEvidencePath(baseDir, desktopEvidence.path));
  if (!sessionRead.ok) missing.push("sessionIssuanceEvidenceReadable");
  if (!desktopRead.ok) missing.push("desktopConfigEvidenceReadable");

  if (normalizedTokenId && sessionRead.ok) {
    const expectedIssuedAt = issuedAtForTokenIdFromManifestFiles(sessionRead.value as IssuedEmailSessionFileManifest, surface, normalizedTokenId, client);
    if (expectedIssuedAt === undefined) missing.push("sessionIssuanceTokenId");
    else if (issuedAtValid && expectedIssuedAt !== normalizedIssuedAt) missing.push("sessionIssuanceIssuedAt");
  }
  if (normalizedTokenId && desktopRead.ok) {
    const expectedIssuedAt = issuedAtForTokenIdFromManifestFiles(desktopRead.value as DesktopConfigFileManifest, surface, normalizedTokenId, client);
    if (expectedIssuedAt === undefined) missing.push("desktopConfigTokenId");
    else if (issuedAtValid && expectedIssuedAt !== normalizedIssuedAt) missing.push("desktopConfigIssuedAt");
  }

  return missing.length === 0
    ? { ok: true, tokenId: normalizedTokenId, issuedAt: normalizedIssuedAt }
    : { ok: false, missing };
}

async function validateDesktopUserEvidence(
  baseDir: string,
  entry: DesktopUserTestEvidence,
  rosterEvidence: RosterPreflightEvidence,
  sessionEvidence: SessionIssuanceEvidence,
  desktopEvidence: DesktopConfigEvidence,
  distributionEvidence: DistributionValidationEvidence | undefined,
  checkedAt: Date
): Promise<RolloutGateCheck[]> {
  const checkName = `desktop_${entry.client}`;
  const evidencePath = resolveEvidencePath(baseDir, entry.path);
  const read = await readJson(evidencePath);
  if (!read.ok) {
    return [{ name: checkName, status: "fail", summary: read.error, details: { path: entry.path } }];
  }
  const evidence = read.value as DesktopUserTestReport;
  const exercisedTools = Array.isArray(evidence.exercisedTools) ? evidence.exercisedTools.filter((tool): tool is string => typeof tool === "string") : [];
  const missingEvidence = REQUIRED_EVIDENCE_TOOLS.every((toolName) => !exercisedTools.includes(toolName));
  const missingAnalysis = REQUIRED_ANALYSIS_TOOLS.every((toolName) => !exercisedTools.includes(toolName));
  const testerEmail = isRecord(evidence) && typeof evidence.testerEmail === "string"
    ? evidence.testerEmail.trim().toLowerCase()
    : "";
  const rosterRead = await readJson(resolveEvidencePath(baseDir, rosterEvidence.path));
  const testerRosterPair = sessionIdentityKey(testerEmail, entry.surface, entry.client);
  const testerInPreflightRoster = rosterRead.ok && testerEmail.length > 0
    ? pairSetFromRoster(rosterRead.value as PreflightVerifiedEmailRosterReport).has(testerRosterPair)
    : false;
  const productionUrl = validateProductionMcpUrl(evidence.mcpUrl);
  const sessionTokenId = isRecord(evidence) ? exactSessionTokenIdOrEmpty(evidence.sessionTokenId) : "";
  const sessionTokenIdAfterRestart = isRecord(evidence) ? exactSessionTokenIdOrEmpty(evidence.sessionTokenIdAfterRestart) : "";
  const sessionIssuedAt = isRecord(evidence) && isExactIsoTimestamp(evidence.sessionIssuedAt)
    ? evidence.sessionIssuedAt
    : "";
  const sessionIssuedAtAfterRestart = isRecord(evidence) && isExactIsoTimestamp(evidence.sessionIssuedAtAfterRestart)
    ? evidence.sessionIssuedAtAfterRestart
    : "";
  const sessionIssuedAtValid = sessionIssuedAt.length > 0;
  const postRestartTokenMatches = sessionTokenId.length > 0 && sessionTokenIdAfterRestart === sessionTokenId;
  const postRestartIssuedAtMatches = sessionIssuedAtValid && sessionIssuedAtAfterRestart === sessionIssuedAt;
  const attachmentMethod = isRecord(evidence) && typeof evidence.attachmentMethod === "string"
    ? evidence.attachmentMethod.trim()
    : "";
  const allowedAttachmentMethods = [...REQUIRED_DESKTOP_ATTACHMENT_METHODS[entry.surface]];
  const attachmentMethodAllowed = allowedAttachmentMethods.includes(attachmentMethod as never);
  const client = isRecord(evidence) && isRecruiterClient(evidence.client) ? evidence.client : undefined;
  const clientMatchesManifest = client === entry.client;
  const clientMatchesSurface = clientMatchesManifest && isClientSurfaceCompatible(client, entry.surface);
  const clientMatchesAttachment = attachmentMethod === "claude_desktop_mcpb"
    ? client === "claude_desktop_chat"
    : attachmentMethod === "claude_code_http_mcp"
      ? client === "claude_code"
      : entry.surface === "chatgpt_desktop" && client === "chatgpt_codex_host";
  const taskOutcomeValid = evidence.taskOutcome === "useful"
    || evidence.taskOutcome === "not_useful"
    || evidence.taskOutcome === "could_not_use";
  const taskOutcomeReasonValid = evidence.taskOutcomeReason === "wrong_scope"
    || evidence.taskOutcomeReason === "timeout_error"
    || evidence.taskOutcomeReason === "installation_blocked"
    || evidence.taskOutcomeReason === "answer_received"
    || evidence.taskOutcomeReason === "not_yet_needed";
  const taskOutcomeSuccessful = evidence.taskOutcome === "useful"
    && evidence.taskOutcomeReason === "answer_received";
  const testedAtFresh = isTimestampFresh(evidence.testedAt, checkedAt);
  const tokenBinding = await validateDesktopAttestationTokenBinding(
    baseDir,
    testerEmail,
    entry.surface,
    entry.client,
    sessionTokenId,
    sessionIssuedAt,
    sessionEvidence,
    desktopEvidence
  );
  const endpointBinding = await validateDesktopEndpointBinding(
    baseDir,
    evidence.mcpUrl,
    testerEmail,
    entry.surface,
    entry.client,
    desktopEvidence,
    distributionEvidence
  );
  const tokenPayloadPresent = manifestContainsTokenPayload(evidence);
  const routing = validateDesktopRoutingAttestation(evidence);
  const routingDetails = {
    clientVersion: safeRoutingVersion(evidence.clientVersion),
    modelVersion: safeRoutingVersion(evidence.modelVersion),
    routingTestVersion: evidence.routingTestVersion === ROUTING_TEST_VERSION ? ROUTING_TEST_VERSION : null,
    routingCaseCount: Array.isArray(evidence.routingChecks) ? evidence.routingChecks.length : 0,
    minRoutingRuns: MIN_ROUTING_RUNS,
    routingProblems: routing.problems,
  };
  const pass = isRecord(evidence)
    && evidence.status === "pass"
    && evidence.surface === entry.surface
    && evidence.client === entry.client
    && typeof evidence.tester === "string"
    && evidence.tester.trim().length > 0
    && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(testerEmail)
    && testerInPreflightRoster
    && testedAtFresh
    && typeof evidence.mcpUrl === "string"
    && productionUrl.ok
    && tokenBinding.ok
    && evidence.durableSessionAccess === true
    && evidence.sessionPersistedAcrossRestart === true
    && postRestartTokenMatches
    && postRestartIssuedAtMatches
    && evidence.routineReverificationPrompted === false
    && attachmentMethodAllowed
    && clientMatchesSurface
    && clientMatchesAttachment
    && taskOutcomeSuccessful
    && evidence.writeOrAdminToolsVisible === false
    && evidence.containsTokens === false
    && exercisedTools.length > 0
    && !missingEvidence
    && !missingAnalysis
    && routing.ok
    && endpointBinding.ok
    && !tokenPayloadPresent;
  return [pass
    ? { name: checkName, status: "pass", summary: "Real desktop user test evidence passed with a useful answer, client/model attribution, repeated candidate routing conformance evidence, candidate-endpoint binding, durable at-will access, restart persistence, and exercised evidence plus analysis tools.", details: { path: entry.path, testerEmail, client, taskOutcome: evidence.taskOutcome, taskOutcomeReason: evidence.taskOutcomeReason, testedAt: evidence.testedAt, mcpUrl: productionUrl.url, sessionTokenId, sessionTokenIdAfterRestart, sessionIssuedAt, sessionIssuedAtAfterRestart, attachmentMethod, exercisedTools, ...routingDetails } }
    : { name: checkName, status: "fail", summary: "Real desktop user test evidence is missing a useful answer, required client/model attribution, repeated candidate routing conformance proof, candidate-endpoint binding, durable restart proof, issued-session binding, exercised tools, exact no-write/no-token attestations, or token-free evidence hygiene.", details: { path: entry.path, testerEmail, client, clientMatchesManifest, clientMatchesSurface, clientMatchesAttachment, taskOutcome: evidence.taskOutcome, taskOutcomeReason: evidence.taskOutcomeReason, taskOutcomeValid, taskOutcomeReasonValid, taskOutcomeSuccessful, testedAt: evidence.testedAt, testedAtFresh, maxEvidenceAgeDays: DYNAMIC_EVIDENCE_MAX_AGE_DAYS, testerInPreflightRoster, sessionTokenId, sessionTokenIdAfterRestart, sessionIssuedAt, sessionIssuedAtAfterRestart, postRestartTokenMatches, postRestartIssuedAtMatches, attachmentMethod, allowedAttachmentMethods, attachmentMethodAllowed, writeOrAdminToolsVisible: evidence.writeOrAdminToolsVisible, containsTokens: evidence.containsTokens, tokenBindingMissing: tokenBinding.ok ? [] : tokenBinding.missing, endpointBindingMissing: endpointBinding.ok ? [] : endpointBinding.missing, mcpUrlReason: productionUrl.ok ? undefined : productionUrl.reason, exercisedTools, missingEvidence, missingAnalysis, tokenPayloadPresent, ...routingDetails } }];
}

function safeRoutingVersion(value: unknown): string | null {
  return typeof value === "string"
    && value.length <= 128
    && value.trim() === value
    && /^[A-Za-z0-9][A-Za-z0-9._+() /:-]*$/.test(value)
    && !containsTokenOrConfigPayload(value)
    ? value
    : null;
}

async function validateDesktopAttestationTokenBinding(
  baseDir: string,
  email: string,
  surface: (typeof REQUIRED_SURFACES)[number],
  client: RecruiterClient,
  tokenId: string,
  issuedAt: string,
  sessionEvidence: SessionIssuanceEvidence,
  desktopEvidence: DesktopConfigEvidence
): Promise<{ ok: true } | { ok: false; missing: string[] }> {
  const missing: string[] = [];
  if (!tokenId) missing.push("sessionTokenId");
  if (!email) missing.push("testerEmail");
  const normalizedIssuedAt = isExactIsoTimestamp(issuedAt) ? issuedAt : "";
  const issuedAtValid = normalizedIssuedAt.length > 0;
  if (!issuedAtValid) missing.push("sessionIssuedAt");

  const sessionRead = await readJson(resolveEvidencePath(baseDir, sessionEvidence.path));
  const desktopRead = await readJson(resolveEvidencePath(baseDir, desktopEvidence.path));
  if (!sessionRead.ok) missing.push("sessionIssuanceEvidenceReadable");
  if (!desktopRead.ok) missing.push("desktopConfigEvidenceReadable");

  if (tokenId && email && sessionRead.ok) {
    const expected = tokenIdForPairFromManifestFiles(sessionRead.value as IssuedEmailSessionFileManifest, email, surface, client);
    if (expected !== tokenId) missing.push("sessionIssuanceTokenIdForTester");
  }
  if (issuedAtValid && email && sessionRead.ok) {
    const expected = issuedAtForPairFromManifestFiles(sessionRead.value as IssuedEmailSessionFileManifest, email, surface, client);
    if (expected !== normalizedIssuedAt) missing.push("sessionIssuanceIssuedAtForTester");
  }
  if (tokenId && email && desktopRead.ok) {
    const expected = tokenIdForPairFromManifestFiles(desktopRead.value as DesktopConfigFileManifest, email, surface, client);
    if (expected !== tokenId) missing.push("desktopConfigTokenIdForTester");
  }
  if (issuedAtValid && email && desktopRead.ok) {
    const expected = issuedAtForPairFromManifestFiles(desktopRead.value as DesktopConfigFileManifest, email, surface, client);
    if (expected !== normalizedIssuedAt) missing.push("desktopConfigIssuedAtForTester");
  }

  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

async function validateDesktopEndpointBinding(
  baseDir: string,
  attestedMcpUrl: unknown,
  email: string,
  surface: (typeof REQUIRED_SURFACES)[number],
  client: RecruiterClient,
  desktopEvidence: DesktopConfigEvidence,
  distributionEvidence: DistributionValidationEvidence | undefined
): Promise<{ ok: true } | { ok: false; missing: string[] }> {
  const missing: string[] = [];
  const attested = validateProductionMcpUrl(attestedMcpUrl);
  if (!attested.ok) missing.push("attestedMcpUrl");

  const configured = await readDesktopConfigMcpUrl(baseDir, desktopEvidence, email, surface, client);
  if (!configured.ok) missing.push(configured.reason);

  let distributed: ReturnType<typeof validateProductionMcpUrl> = { ok: false, reason: "distributionEvidenceManifestEntry" };
  if (!distributionEvidence) {
    missing.push("distributionEvidenceManifestEntry");
  } else {
    const read = await readJson(resolveEvidencePath(baseDir, distributionEvidence.path));
    if (!read.ok || !isRecord(read.value)) {
      missing.push("distributionEvidenceReadable");
    } else {
      distributed = validateProductionMcpUrl(read.value.mcpUrl);
      if (!distributed.ok) missing.push("distributionMcpUrl");
    }
  }

  if (attested.ok && configured.ok && attested.url !== configured.url) {
    missing.push("attestedMcpUrlMatchesDesktopConfig");
  }
  if (attested.ok && distributed.ok && attested.url !== distributed.url) {
    missing.push("attestedMcpUrlMatchesDistribution");
  }
  if (configured.ok && distributed.ok && configured.url !== distributed.url) {
    missing.push("desktopConfigMcpUrlMatchesDistribution");
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

async function readDesktopConfigMcpUrl(
  baseDir: string,
  desktopEvidence: DesktopConfigEvidence,
  email: string,
  surface: (typeof REQUIRED_SURFACES)[number],
  client: RecruiterClient
): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  const manifestPath = resolveEvidencePath(baseDir, desktopEvidence.path);
  const read = await readJson(manifestPath);
  if (!read.ok || !isRecord(read.value)) return { ok: false, reason: "desktopConfigEvidenceReadable" };
  const entry = desktopConfigEntriesByPair(read.value as unknown as DesktopConfigFileManifest)
    .get(sessionIdentityKey(email, surface, client));
  if (!entry) return { ok: false, reason: "desktopConfigEntryForTester" };
  return readDesktopConfigEntryMcpUrl(manifestPath, entry, surface);
}

async function readDesktopConfigEntryMcpUrl(
  manifestPath: string,
  entry: DesktopConfigFileManifestEntry,
  surface: (typeof REQUIRED_SURFACES)[number]
): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  const manifestDir = dirname(manifestPath);
  if (evidencePathPortabilityIssue(manifestDir, entry.path)) {
    return { ok: false, reason: "desktopConfigPathPortable" };
  }
  const artifactPath = resolveEvidencePath(manifestDir, entry.path);
  let rawUrl: unknown;
  if (entry.path.endsWith(".mcpb")) {
    const packed = readZipJson(artifactPath, "manifest.json");
    const server = packed.ok && isRecord(packed.value.server) ? packed.value.server : undefined;
    const mcpConfig = server && isRecord(server.mcp_config) ? server.mcp_config : undefined;
    const env = mcpConfig && isRecord(mcpConfig.env) ? mcpConfig.env : undefined;
    rawUrl = env?.GREENHOUSE_RECRUITER_REMOTE_MCP_URL;
  } else {
    let text: string;
    try {
      text = await readFile(artifactPath, "utf8");
    } catch {
      return { ok: false, reason: "desktopConfigArtifactReadable" };
    }
    const parsed = parseJsonString(text);
    if (!parsed.ok || !isRecord(parsed.value)) return { ok: false, reason: "desktopConfigArtifactReadable" };
    if (surface === "chatgpt_desktop") {
      rawUrl = parsed.value.server_url;
    } else {
      const mcpServers = parsed.value.mcpServers;
      const server = isRecord(mcpServers) ? Object.values(mcpServers).find(isRecord) : undefined;
      rawUrl = server?.url;
    }
  }
  const normalized = validateProductionMcpUrl(rawUrl);
  return normalized.ok ? normalized : { ok: false, reason: "desktopConfigMcpUrl" };
}

async function validateDesktopConfigCandidateBinding(
  baseDir: string,
  evidence: DesktopConfigEvidence,
  candidate: CandidateReleaseBinding
): Promise<RolloutGateCheck> {
  if (!candidate.ok) {
    return {
      name: "desktop_config_candidate_binding",
      status: "fail",
      summary: "Desktop configs cannot be bound until the authoritative candidate URL and commit validate.",
    };
  }
  const manifestPath = resolveEvidencePath(baseDir, evidence.path);
  const read = await readJson(manifestPath);
  if (!read.ok || !isRecord(read.value) || !Array.isArray(read.value.files)) {
    return {
      name: "desktop_config_candidate_binding",
      status: "fail",
      summary: "Every generated desktop config must target the authoritative candidate MCP URL.",
      details: { problems: ["desktop_config_manifest_unreadable"] },
    };
  }

  const problems: string[] = [];
  for (const [index, rawFile] of read.value.files.entries()) {
    if (!isRecord(rawFile)
      || typeof rawFile.path !== "string"
      || !REQUIRED_SURFACES.includes(rawFile.surface as (typeof REQUIRED_SURFACES)[number])) {
      problems.push(`invalid_file_entry:${index}`);
      continue;
    }
    const surface = rawFile.surface as (typeof REQUIRED_SURFACES)[number];
    const configured = await readDesktopConfigEntryMcpUrl(
      manifestPath,
      rawFile as unknown as DesktopConfigFileManifestEntry,
      surface
    );
    if (!configured.ok) {
      problems.push(`${configured.reason}:${index}`);
    } else if (configured.url !== candidate.mcpUrl) {
      problems.push(`candidate_url_mismatch:${index}`);
    }
  }
  if (read.value.files.length === 0) problems.push("no_config_files");

  return problems.length === 0
    ? {
        name: "desktop_config_candidate_binding",
        status: "pass",
        summary: "Every generated desktop config targets the authoritative candidate MCP URL.",
      }
    : {
        name: "desktop_config_candidate_binding",
        status: "fail",
        summary: "Every generated desktop config must target the authoritative candidate MCP URL.",
        details: { problems },
      };
}

async function validateDesktopConfigEvidence(baseDir: string, evidence: DesktopConfigEvidence): Promise<RolloutGateCheck[]> {
  if (typeof evidence.path !== "string" || evidence.path.trim().length === 0) {
    return [{ name: "desktop_config_manifest", status: "fail", summary: "Desktop config manifest evidence path is required." }];
  }
  const evidencePath = resolveEvidencePath(baseDir, evidence.path);
  const read = await readJson(evidencePath);
  if (!read.ok) {
    return [{ name: "desktop_config_manifest", status: "fail", summary: read.error, details: { path: evidence.path } }];
  }

  const manifest = read.value as DesktopConfigFileManifest;
  const checks: RolloutGateCheck[] = [];
  const missing: string[] = [];
  if (!isRecord(manifest) || manifest.ok !== true) missing.push("passingManifest");
  if (manifest.containsTokens !== false) missing.push("tokenFreeManifest");
  if (manifest.configFilesContainTokens !== true) missing.push("configFilesMarkedSensitive");
  if (typeof manifest.outputDir !== "string" || manifest.outputDir.trim().length === 0) missing.push("outputDir");
  if (typeof manifest.manifestPath !== "string" || manifest.manifestPath.trim().length === 0) missing.push("manifestPath");
  if (typeof manifest.fileCount !== "number" || manifest.fileCount <= 0) missing.push("fileCount");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) missing.push("files");
  if (Array.isArray(manifest.files) && typeof manifest.fileCount === "number" && manifest.fileCount !== manifest.files.length) missing.push("fileCountMatchesFiles");
  if (manifestContainsTokenPayload(manifest)) missing.push("manifestHasTokenOrConfigPayload");

  const manifestDir = dirname(evidencePath);
  const pathProblems: string[] = [];
  if (isRecord(manifest)) {
    if (manifest.outputDir !== ".") pathProblems.push("outputDir:not_portable");
    if (typeof manifest.manifestPath === "string") {
      const manifestPathIssue = evidencePathPortabilityIssue(manifestDir, manifest.manifestPath);
      if (manifestPathIssue) pathProblems.push(`manifestPath:${manifestPathIssue}`);
    }
  }

  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const surfaces = files
    .filter(isRecord)
    .map((file) => typeof file.surface === "string" ? file.surface : "")
    .filter(Boolean);
  const missingSurfaces = REQUIRED_SURFACES.filter((surface) => !surfaces.includes(surface));
  if (missingSurfaces.length > 0) missing.push("requiredSurfaces");
  const clients = files
    .filter(isRecord)
    .map((file) => typeof file.client === "string" ? file.client : "")
    .filter(Boolean);
  const missingClients = REQUIRED_CLIENT_IDENTITIES
    .map((identity) => identity.client)
    .filter((client) => !clients.includes(client));
  if (missingClients.length > 0) missing.push("requiredClients");

  const invalidFiles: unknown[] = [];
  const credentialLeaks: string[] = [];
  const configShapeProblems: string[] = [];
  const configTokenMetadataProblems: string[] = [];
  for (const file of files) {
    if (!isRecord(file)
      || typeof file.email !== "string"
      || !REQUIRED_SURFACES.includes(file.surface as (typeof REQUIRED_SURFACES)[number])
      || !isRecruiterClient(file.client)
      || !isClientSurfaceCompatible(file.client, file.surface as (typeof REQUIRED_SURFACES)[number])
      || typeof file.subject !== "string"
      || !isExactSessionTokenId(file.tokenId)
      || typeof file.issuedAt !== "string"
      || !isExactIsoTimestamp(file.issuedAt)
      || typeof file.path !== "string"
      || file.path.trim().length === 0) {
      invalidFiles.push(file);
      continue;
    }
    const pathIssue = evidencePathPortabilityIssue(manifestDir, file.path);
    if (pathIssue) {
      pathProblems.push(`${file.surface}:${file.email}:${pathIssue}`);
      continue;
    }
    const surface = file.surface as (typeof REQUIRED_SURFACES)[number];
    const configPath = resolveEvidencePath(manifestDir, file.path);
    if (surface === "claude_desktop" && file.path.endsWith(".mcpb")) {
      if (manifest.artifactContainsToken !== true) missing.push("claudeMcpbMarkedTokenBearing");
      if (manifest.metadataContainsToken !== false) missing.push("claudeMcpbMetadataMarkedTokenFree");
      const mcpbProblems = validateClaudeMcpbArtifact(configPath, {
        email: file.email,
        subject: file.subject,
        tokenId: file.tokenId,
        issuedAt: file.issuedAt,
        client: file.client,
      });
      for (const problem of mcpbProblems.shape) {
        configShapeProblems.push(`${file.surface}:${file.email}:${problem}`);
      }
      for (const problem of mcpbProblems.credentials) {
        credentialLeaks.push(`${file.surface}:${file.email}:${problem}`);
      }
      for (const problem of mcpbProblems.metadata) {
        configTokenMetadataProblems.push(`${file.surface}:${file.email}:${problem}`);
      }
      continue;
    }
    const configRead = await readText(configPath);
    if (!configRead.ok) {
      credentialLeaks.push(`${file.surface}:${file.email}:unreadable`);
      configShapeProblems.push(`${file.surface}:${file.email}:unreadable`);
      continue;
    }
    if (/GREENHOUSE_CLIENT_ID|GREENHOUSE_CLIENT_SECRET|GREENHOUSE_RECRUITER_IDENTITY|GREENHOUSE_RECRUITER_SESSION_SECRET/.test(configRead.value)) {
      credentialLeaks.push(`${file.surface}:${file.email}:server_credentials`);
    }
    const configProblems = validateDesktopConfigFileShape(surface, configRead.value, file.client);
    for (const problem of configProblems) {
      configShapeProblems.push(`${file.surface}:${file.email}:${problem}`);
    }
    const parsedConfig = parseJsonString(configRead.value);
    const tokenRead = parsedConfig.ok && isRecord(parsedConfig.value)
      ? extractDesktopConfigSessionToken(surface, parsedConfig.value)
      : { ok: false as const, reason: "invalid_json" };
    if (!tokenRead.ok) {
      configShapeProblems.push(`${file.surface}:${file.email}:${tokenRead.reason}`);
      continue;
    }
    const metadataProblems = validateSessionTokenMetadata(tokenRead.token, {
      email: file.email,
      surface,
      client: isRecruiterClient(file.client) ? file.client : undefined,
      subject: file.subject,
      tokenId: file.tokenId,
      issuedAt: file.issuedAt,
    });
    for (const problem of metadataProblems) {
      configTokenMetadataProblems.push(`${file.surface}:${file.email}:${problem}`);
    }
  }
  if (invalidFiles.length > 0) missing.push("validFileEntries");
  if (credentialLeaks.length > 0) missing.push("configFilesWithoutServerCredentials");
  if (configShapeProblems.length > 0) missing.push("configFilesHaveValidRemoteShape");
  if (configTokenMetadataProblems.length > 0) missing.push("configFilesMatchManifestTokenMetadata");
  if (pathProblems.length > 0) missing.push("portableManifestPaths");

  checks.push(missing.length === 0
    ? { name: "desktop_config_manifest", status: "pass", summary: "Split desktop config manifest is token-free and config files are production remote recruiter configs with manifest-matching tokens and no server credentials.", details: { path: evidence.path, fileCount: manifest.fileCount, surfaces: REQUIRED_SURFACES } }
    : { name: "desktop_config_manifest", status: "fail", summary: "Desktop config split-output evidence is incomplete or unsafe.", details: { path: evidence.path, missing, missingSurfaces, missingClients, credentialLeaks, configShapeProblems, configTokenMetadataProblems, pathProblems } });
  return checks;
}

async function validateDesktopDeliveryEvidence(
  baseDir: string,
  evidence: DesktopDeliveryEvidence,
  desktopEvidence: DesktopConfigEvidence,
  checkedAt: Date
): Promise<RolloutGateCheck[]> {
  if (typeof evidence.path !== "string" || evidence.path.trim().length === 0) {
    return [{ name: "desktop_config_delivery", status: "fail", summary: "Desktop config delivery evidence path is required." }];
  }

  const evidencePath = resolveEvidencePath(baseDir, evidence.path);
  const read = await readJson(evidencePath);
  if (!read.ok) {
    return [{ name: "desktop_config_delivery", status: "fail", summary: read.error, details: { path: evidence.path } }];
  }

  const desktopEvidencePath = resolveEvidencePath(baseDir, desktopEvidence.path);
  const desktopRead = await readJson(desktopEvidencePath);
  if (!desktopRead.ok) {
    return [{
      name: "desktop_config_delivery",
      status: "fail",
      summary: "Desktop config delivery evidence cannot be checked because the desktop config manifest is unreadable.",
      details: { path: evidence.path, desktopConfigPath: desktopEvidence.path },
    }];
  }

  const report = read.value as DesktopDeliveryReport;
  const desktopManifest = desktopRead.value as DesktopConfigFileManifest;
  const missing: string[] = [];
  if (!isRecord(report) || report.ok !== true) missing.push("passingReport");
  appendTimestampFreshnessMissing(missing, report.deliveredAt, "deliveredAt", "deliveredAtFreshness", checkedAt);
  if (typeof report.deliveredBy !== "string" || report.deliveredBy.trim().length === 0) missing.push("deliveredBy");
  const reportDeliveryChannel = typeof report.deliveryChannel === "string" ? report.deliveryChannel.trim() : "";
  if (!isApprovedDesktopDeliveryChannel(reportDeliveryChannel)) missing.push("approvedDeliveryChannel");
  if (report.containsTokens !== false) missing.push("tokenFreeDeliveryReport");
  if (manifestContainsTokenPayload(report)) missing.push("deliveryReportHasTokenOrConfigPayload");

  const expected = desktopConfigEntriesByPair(desktopManifest);
  const deliveries = isRecord(report) && Array.isArray(report.deliveries) ? report.deliveries : [];
  if (deliveries.length === 0) missing.push("deliveries");
  if (expected.size === 0) missing.push("desktopConfigPairs");

  const deliveryPairs = new Set<string>();
  const invalidDeliveries: unknown[] = [];
  const duplicateDeliveries: string[] = [];
  const mismatches: string[] = [];
  const unsafeDeliveryChannels: string[] = [];
  const deliveryBaseDir = dirname(evidencePath);
  const desktopManifestDir = dirname(desktopEvidencePath);

  for (const delivery of deliveries) {
    if (!isRecord(delivery)
      || typeof delivery.email !== "string"
      || typeof delivery.recipientEmail !== "string"
      || !REQUIRED_SURFACES.includes(delivery.surface as (typeof REQUIRED_SURFACES)[number])
      || !isRecruiterClient(delivery.client)
      || !isClientSurfaceCompatible(delivery.client, delivery.surface as (typeof REQUIRED_SURFACES)[number])
      || !isExactSessionTokenId(delivery.tokenId)
      || typeof delivery.issuedAt !== "string"
      || !isExactIsoTimestamp(delivery.issuedAt)
      || typeof delivery.configPath !== "string"
      || delivery.configPath.trim().length === 0
      || typeof delivery.deliveryChannel !== "string"
      || delivery.deliveryChannel.trim().length === 0
      || delivery.deliveredToMatchingRecruiter !== true) {
      invalidDeliveries.push(delivery);
      continue;
    }

    const email = delivery.email.trim().toLowerCase();
    const recipientEmail = delivery.recipientEmail.trim().toLowerCase();
    const deliveryChannel = delivery.deliveryChannel.trim();
    const surface = delivery.surface as (typeof REQUIRED_SURFACES)[number];
    const client = delivery.client as RecruiterClient;
    const pair = sessionIdentityKey(email, surface, client);
    if (!isApprovedDesktopDeliveryChannel(deliveryChannel)) unsafeDeliveryChannels.push(`${pair}:${deliveryChannel}`);
    if (reportDeliveryChannel && deliveryChannel !== reportDeliveryChannel) mismatches.push(`${pair}:deliveryChannel`);
    if (deliveryPairs.has(pair)) duplicateDeliveries.push(pair);
    deliveryPairs.add(pair);

    const expectedEntry = expected.get(pair);
    if (!expectedEntry) {
      continue;
    }
    if (recipientEmail !== email) mismatches.push(`${pair}:recipientEmail`);
    if (delivery.tokenId !== expectedEntry.tokenId) mismatches.push(`${pair}:tokenId`);
    if (delivery.issuedAt !== expectedEntry.issuedAt) mismatches.push(`${pair}:issuedAt`);
    const expectedConfigPath = resolveEvidencePath(desktopManifestDir, expectedEntry.path);
    const deliveredConfigPath = resolveEvidencePath(deliveryBaseDir, delivery.configPath);
    if (deliveredConfigPath !== expectedConfigPath) mismatches.push(`${pair}:configPath`);
  }

  const expectedPairs = [...expected.keys()];
  const deliveredPairs = [...deliveryPairs];
  const deliveryMissing = expectedPairs.filter((pair) => !deliveryPairs.has(pair));
  const deliveryUnexpected = deliveredPairs.filter((pair) => !expected.has(pair));
  if (invalidDeliveries.length > 0) missing.push("validDeliveryEntries");
  if (duplicateDeliveries.length > 0) missing.push("noDuplicateDeliveries");
  if (deliveryMissing.length > 0) missing.push("deliveryForEveryGeneratedDesktopConfig");
  if (deliveryUnexpected.length > 0) missing.push("noDeliveryOutsideDesktopConfigManifest");
  if (unsafeDeliveryChannels.length > 0 && !missing.includes("approvedDeliveryChannel")) missing.push("approvedDeliveryChannel");
  if (mismatches.length > 0) missing.push("deliveryEntriesMatchDesktopConfigManifest");

  return [missing.length === 0
    ? {
      name: "desktop_config_delivery",
      status: "pass",
      summary: "Desktop config delivery evidence proves every generated config was delivered only through an approved channel to the matching recruiter email and durable session metadata.",
      details: { path: evidence.path, deliveredCount: deliveries.length, deliveredBy: report.deliveredBy, deliveryChannel: reportDeliveryChannel },
    }
    : {
      name: "desktop_config_delivery",
      status: "fail",
      summary: "Desktop config delivery evidence is missing, uses an unapproved channel, or does not match the generated config manifest.",
      details: { path: evidence.path, missing, deliveryMissing, deliveryUnexpected, duplicateDeliveries, mismatches, unsafeDeliveryChannels },
    }];
}



function isApprovedDesktopDeliveryChannel(value: string): boolean {
  return APPROVED_DESKTOP_DELIVERY_CHANNELS.includes(value as typeof APPROVED_DESKTOP_DELIVERY_CHANNELS[number]);
}

function validateSessionTokenMetadata(token: unknown, expected: ExpectedSessionTokenMetadata): string[] {
  const metadataRead = readSessionTokenMetadata(token);
  if (!metadataRead.ok) {
    return [metadataRead.reason];
  }
  const metadata = metadataRead.metadata;
  const expectedEmail = expected.email.trim().toLowerCase();
  const problems: string[] = [];
  if (metadata.email !== expectedEmail) problems.push("token_email_mismatch");
  if (metadata.surface !== expected.surface) problems.push("token_surface_mismatch");
  if (expected.subject !== undefined && metadata.subject !== expected.subject) problems.push("token_subject_mismatch");
  if (!isExactSessionTokenId(metadata.tokenId)) {
    problems.push("token_id_invalid");
  } else if (expected.tokenId !== undefined && metadata.tokenId !== expected.tokenId) {
    problems.push("token_id_mismatch");
  }
  if (typeof metadata.issuedAt !== "string" || metadata.issuedAt.length === 0) {
    problems.push("token_issued_at_missing");
  } else if (!isExactIsoTimestamp(metadata.issuedAt)) {
    problems.push("token_issued_at_invalid");
  } else if (expected.issuedAt !== undefined && metadata.issuedAt !== expected.issuedAt) {
    problems.push("token_issued_at_mismatch");
  }
  if (expected.client !== undefined && metadata.client !== expected.client) {
    problems.push("token_client_mismatch");
  }
  return problems;
}

function readSessionTokenMetadata(token: unknown): { ok: true; metadata: SessionTokenMetadata } | { ok: false; reason: string } {
  if (typeof token !== "string" || token.trim().length === 0) {
    return { ok: false, reason: "token_missing" };
  }
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: "token_malformed" };
  }
  try {
    const parsed = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as unknown;
    if (!isRecord(parsed)) return { ok: false, reason: "token_payload_invalid" };
    return {
      ok: true,
      metadata: {
        subject: typeof parsed.subject === "string" ? parsed.subject : undefined,
        email: typeof parsed.email === "string" ? parsed.email : undefined,
        surface: typeof parsed.surface === "string" ? parsed.surface : undefined,
        client: typeof parsed.client === "string" ? parsed.client : undefined,
        tokenId: typeof parsed.tokenId === "string" ? parsed.tokenId : undefined,
        issuedAt: typeof parsed.issuedAt === "string" ? parsed.issuedAt : undefined,
      },
    };
  } catch {
    return { ok: false, reason: "token_payload_invalid" };
  }
}

function validateClaudeMcpbArtifact(
  artifactPath: string,
  expected: {
    email: string;
    subject: string;
    tokenId: string;
    issuedAt: string;
    client: unknown;
  }
): { shape: string[]; credentials: string[]; metadata: string[] } {
  const shape: string[] = [];
  const credentials: string[] = [];
  const metadata: string[] = [];
  if (expected.client !== "claude_desktop_chat") {
    metadata.push("manifest_client_claude_desktop_chat_required");
  }

  const listing = readZipListing(artifactPath);
  if (!listing.ok) {
    shape.push("mcpb_unreadable");
    return { shape, credentials, metadata };
  }
  const requiredEntries = ["manifest.json", "provenance.json", "server/index.mjs", "README.md", "THIRD_PARTY_NOTICES.txt"];
  for (const entry of requiredEntries) {
    if (listing.entries.filter((candidate) => candidate === entry).length !== 1) {
      shape.push(`mcpb_${entry.replace(/[^a-z0-9]+/gi, "_")}_required_once`);
    }
  }
  if (listing.entries.some((entry) => entry.startsWith("/") || entry.split("/").includes(".."))) {
    shape.push("mcpb_unsafe_archive_path");
  }

  const packedManifest = readZipJson(artifactPath, "manifest.json");
  if (!packedManifest.ok) {
    shape.push(`mcpb_manifest_${packedManifest.reason}`);
    return { shape, credentials, metadata };
  }
  const manifest = packedManifest.value;
  if (manifest.$schema !== "https://raw.githubusercontent.com/anthropics/mcpb/main/schemas/mcpb-manifest-v0.4.schema.json") {
    shape.push("mcpb_schema_required");
  }
  if (manifest.manifest_version !== "0.4") shape.push("mcpb_manifest_version_0_4_required");
  if (typeof manifest.name !== "string" || manifest.name.trim().length === 0
    || typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version)
    || typeof manifest.description !== "string" || manifest.description.trim().length === 0
    || !isRecord(manifest.author) || typeof manifest.author.name !== "string" || manifest.author.name.trim().length === 0) {
    shape.push("mcpb_required_identity_metadata");
  }
  const server = isRecord(manifest.server) ? manifest.server : undefined;
  if (!server || server.type !== "node" || server.entry_point !== "server/index.mjs") {
    shape.push("mcpb_node_server_required");
  }
  const mcpConfig = server && isRecord(server.mcp_config) ? server.mcp_config : undefined;
  if (!mcpConfig || mcpConfig.command !== "node" || !arrayEquals(mcpConfig.args, ["${__dirname}/server/index.mjs"])) {
    shape.push("mcpb_node_command_required");
  }
  const env = mcpConfig && isRecord(mcpConfig.env) ? mcpConfig.env : undefined;
  const expectedEnvKeys = [
    "GREENHOUSE_RECRUITER_EXPECTED_EMAIL",
    "GREENHOUSE_RECRUITER_EXPECTED_ISSUED_AT",
    "GREENHOUSE_RECRUITER_EXPECTED_TOKEN_ID",
    "GREENHOUSE_RECRUITER_REMOTE_AUTH_TOKEN",
    "GREENHOUSE_RECRUITER_REMOTE_MCP_URL",
  ];
  if (!env || !arrayEquals(Object.keys(env).sort(), expectedEnvKeys)) {
    shape.push("mcpb_exact_bridge_env_required");
  }
  const url = validateProductionMcpUrl(env?.GREENHOUSE_RECRUITER_REMOTE_MCP_URL);
  if (!url.ok) shape.push(`mcpb_url_${url.reason}`);
  if (env?.GREENHOUSE_RECRUITER_EXPECTED_EMAIL !== expected.email) metadata.push("mcpb_expected_email_mismatch");
  if (env?.GREENHOUSE_RECRUITER_EXPECTED_TOKEN_ID !== expected.tokenId) metadata.push("mcpb_expected_token_id_mismatch");
  if (env?.GREENHOUSE_RECRUITER_EXPECTED_ISSUED_AT !== expected.issuedAt) metadata.push("mcpb_expected_issued_at_mismatch");
  for (const problem of validateSessionTokenMetadata(env?.GREENHOUSE_RECRUITER_REMOTE_AUTH_TOKEN, {
    email: expected.email,
    surface: "claude_desktop",
    client: "claude_desktop_chat",
    subject: expected.subject,
    tokenId: expected.tokenId,
    issuedAt: expected.issuedAt,
  })) {
    metadata.push(problem);
  }

  const provenanceRead = readZipJson(artifactPath, "provenance.json");
  if (!provenanceRead.ok) {
    shape.push(`mcpb_provenance_${provenanceRead.reason}`);
  } else {
    const provenance = provenanceRead.value;
    if (provenance.schemaVersion !== 1
      || provenance.surface !== "claude_desktop"
      || provenance.client !== "claude_desktop_chat"
      || provenance.tokenId !== expected.tokenId
      || provenance.issuedAt !== expected.issuedAt
      || provenance.artifactContainsToken !== true
      || provenance.metadataContainsToken !== false
      || typeof provenance.bridgeSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(provenance.bridgeSha256)) {
      metadata.push("mcpb_provenance_mismatch");
    }
    if (manifestContainsTokenPayload(provenance)) metadata.push("mcpb_provenance_contains_token_payload");
  }

  const bridgeRead = readZipText(artifactPath, "server/index.mjs");
  if (!bridgeRead.ok) {
    shape.push("mcpb_bridge_unreadable");
  } else {
    if (/GREENHOUSE_CLIENT_ID|GREENHOUSE_CLIENT_SECRET|GREENHOUSE_RECRUITER_IDENTITY|GREENHOUSE_RECRUITER_SESSION_SECRET/.test(bridgeRead.value)) {
      credentials.push("server_credentials");
    }
    const bridgeHash = createSha256(bridgeRead.value);
    if (provenanceRead.ok && provenanceRead.value.bridgeSha256 !== bridgeHash) {
      metadata.push("mcpb_bridge_hash_mismatch");
    }
  }
  return { shape, credentials, metadata };
}

function readZipListing(path: string): { ok: true; entries: string[] } | { ok: false } {
  const result = spawnSync("unzip", ["-Z1", path], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) return { ok: false };
  return { ok: true, entries: (result.stdout ?? "").trim().split(/\r?\n/).filter(Boolean) };
}

function readZipText(path: string, entry: string): { ok: true; value: string } | { ok: false } {
  const result = spawnSync("unzip", ["-p", path, entry], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return result.status === 0 ? { ok: true, value: result.stdout ?? "" } : { ok: false };
}

function readZipJson(path: string, entry: string): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  const text = readZipText(path, entry);
  if (!text.ok) return { ok: false, reason: "unreadable" };
  const parsed = parseJsonString(text.value);
  return parsed.ok && isRecord(parsed.value)
    ? { ok: true, value: parsed.value }
    : { ok: false, reason: "invalid_json" };
}

function arrayEquals(value: unknown, expected: string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index]);
}

function createSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function extractDesktopConfigSessionToken(
  surface: (typeof REQUIRED_SURFACES)[number],
  config: Record<string, unknown>
): { ok: true; token: string } | { ok: false; reason: string } {
  if (surface === "chatgpt_desktop") {
    return typeof config.authorization === "string" && config.authorization.length > 0 && config.authorization.trim() === config.authorization
      ? { ok: true, token: config.authorization }
      : { ok: false, reason: "authorization_required" };
  }
  const mcpServers = config.mcpServers;
  if (!isRecord(mcpServers)) return { ok: false, reason: "missing_mcp_servers" };
  const server = Object.values(mcpServers).find(isRecord);
  if (!isRecord(server)) return { ok: false, reason: "missing_remote_server_config" };
  const headers = server.headers;
  const authorization = isRecord(headers) ? headers.Authorization : undefined;
  if (typeof authorization !== "string") return { ok: false, reason: "missing_bearer_authorization" };
  const match = authorization.match(/^Bearer ([^\s]+)$/);
  return match?.[1] && match[1].trim() === match[1]
    ? { ok: true, token: match[1] }
    : { ok: false, reason: "missing_bearer_authorization" };
}

function validateDesktopConfigFileShape(
  surface: (typeof REQUIRED_SURFACES)[number],
  configFileText: string,
  client?: unknown
): string[] {
  const parsed = parseJsonString(configFileText);
  if (!parsed.ok || !isRecord(parsed.value)) {
    return ["invalid_json"];
  }
  return surface === "claude_desktop"
    ? validateClaudeDesktopConfigShape(parsed.value, client === "claude_code")
    : validateChatGptDesktopConfigShape(parsed.value);
}

function validateClaudeDesktopConfigShape(config: Record<string, unknown>, requireClaudeCodeType = false): string[] {
  const problems: string[] = [];
  const mcpServers = config.mcpServers;
  if (!isRecord(mcpServers)) {
    return ["missing_mcp_servers"];
  }
  const entries = Object.entries(mcpServers).filter(([, value]) => isRecord(value));
  if (entries.length !== 1) {
    problems.push("single_remote_server_required");
  }
  const server = entries[0]?.[1];
  if (!isRecord(server)) {
    problems.push("missing_remote_server_config");
    return problems;
  }
  if (requireClaudeCodeType && server.type !== "http") {
    problems.push("claude_code_http_type_required");
  }
  if ("command" in server || "env" in server) {
    problems.push("local_command_or_env_present");
  }
  const url = validateProductionMcpUrl(server.url);
  if (!url.ok) {
    problems.push(`url_${url.reason}`);
  }
  const headers = server.headers;
  const authorization = isRecord(headers) ? headers.Authorization : undefined;
  if (typeof authorization !== "string" || !/^Bearer [^\s]+$/.test(authorization)) {
    problems.push("missing_bearer_authorization");
  }
  return problems;
}

function validateChatGptDesktopConfigShape(config: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (config.type !== "mcp") {
    problems.push("type_mcp_required");
  }
  if (typeof config.server_label !== "string" || config.server_label.trim().length === 0) {
    problems.push("server_label_required");
  }
  const url = validateProductionMcpUrl(config.server_url);
  if (!url.ok) {
    problems.push(`url_${url.reason}`);
  }
  if (typeof config.authorization !== "string" || config.authorization.trim().length === 0) {
    problems.push("authorization_required");
  }
  if (config.require_approval !== "always" && config.require_approval !== "never") {
    problems.push("require_approval_required");
  }
  const rawAllowedTools = Array.isArray(config.allowed_tools) ? config.allowed_tools : undefined;
  const allowedTools = rawAllowedTools
    ? rawAllowedTools.filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0)
    : [];
  if (allowedTools.length === 0) {
    problems.push("allowed_tools_required");
  }
  if (rawAllowedTools && allowedTools.length !== rawAllowedTools.length) {
    problems.push("allowed_tools_invalid_entries");
  }
  const allowedToolSet = new Set(allowedTools);
  const missingTools = REQUIRED_RECRUITER_TOOL_NAMES.filter((toolName) => !allowedToolSet.has(toolName));
  const unexpectedTools = allowedTools.filter((toolName) => !PILOT_TOOL_NAME_SET.has(toolName));
  const duplicateTools = [...new Set(allowedTools.filter((toolName, index) => allowedTools.indexOf(toolName) !== index))];
  if (missingTools.length > 0) {
    problems.push("allowed_tools_missing_recruiter_catalog");
  }
  if (unexpectedTools.length > 0) {
    problems.push("allowed_tools_contains_unknown_entries");
  }
  if (duplicateTools.length > 0) {
    problems.push("allowed_tools_contains_duplicates");
  }
  if (allowedTools.length !== REQUIRED_RECRUITER_TOOL_NAMES.length) {
    problems.push("allowed_tools_count_mismatch");
  }
  if (allowedTools.some((toolName, index) => toolName !== REQUIRED_RECRUITER_TOOL_NAMES[index])) {
    problems.push("allowed_tools_order_mismatch");
  }
  return problems;
}


async function validateIdentityBootstrapEvidence(
  baseDir: string,
  evidence: IdentityBootstrapEvidence,
  rosterEvidence: RosterPreflightEvidence
): Promise<RolloutGateCheck[]> {
  if (typeof evidence.path !== "string" || evidence.path.trim().length === 0) {
    return [{ name: "identity_bootstrap", status: "fail", summary: "Identity bootstrap evidence path is required when the manifest includes identityBootstrapEvidence." }];
  }
  const evidencePath = resolveEvidencePath(baseDir, evidence.path);
  const read = await readJson(evidencePath);
  if (!read.ok) {
    return [{ name: "identity_bootstrap", status: "fail", summary: read.error, details: { path: evidence.path } }];
  }

  const plan = read.value as IdentityBootstrapPlan;
  const missing: string[] = [];
  if (!isRecord(plan) || plan.ok !== true) missing.push("passingPlan");
  if (plan.canApply !== true) missing.push("canApply");
  if (plan.containsTokens !== false) missing.push("tokenFreePlan");
  if (manifestContainsTokenPayload(plan)) missing.push("planHasTokenPayload");
  if (!isValidIsoTimestamp(plan.generatedAt)) missing.push("generatedAt");
  if (typeof plan.source !== "string" || plan.source.trim().length === 0) missing.push("source");
  if (typeof plan.requestedEmailCount !== "number" || plan.requestedEmailCount <= 0) missing.push("requestedEmailCount");
  if (typeof plan.normalizedEmailCount !== "number" || plan.normalizedEmailCount <= 0) missing.push("normalizedEmailCount");
  if (!Array.isArray(plan.resolved) || plan.resolved.length === 0) missing.push("resolvedRows");
  if (!Array.isArray(plan.denied) || plan.denied.length > 0) missing.push("noDeniedRows");

  const bootstrapRows = Array.isArray(plan.resolved) ? plan.resolved : [];
  const invalidRows: unknown[] = [];
  const bootstrapEmailIds = new Map<string, number>();
  for (const row of bootstrapRows) {
    if (!isRecord(row)
      || typeof row.email !== "string"
      || typeof row.greenhouseUserId !== "number"
      || !isSafePositiveGreenhouseUserId(row.greenhouseUserId)
      || !isRecord(row.row)
      || row.row.greenhouse_user_id !== row.greenhouseUserId
      || row.row.primary_email !== row.email.trim().toLowerCase()
      || row.row.status !== "resolved"
      || typeof row.row.source !== "string"
      || row.row.source.trim().length === 0
      || !isValidIsoTimestamp(row.row.last_verified_at)) {
      invalidRows.push(row);
      continue;
    }
    bootstrapEmailIds.set(row.email.trim().toLowerCase(), row.greenhouseUserId);
  }
  if (invalidRows.length > 0) missing.push("validResolvedRows");
  if (typeof plan.normalizedEmailCount === "number" && bootstrapEmailIds.size > 0 && plan.normalizedEmailCount !== bootstrapEmailIds.size) {
    missing.push("normalizedCountMatchesResolvedRows");
  }

  const rosterRead = await readJson(resolveEvidencePath(baseDir, rosterEvidence.path));
  if (!rosterRead.ok) {
    missing.push("rosterPreflightEvidenceReadable");
  } else {
    const rosterEmailIds = emailIdsFromRoster(rosterRead.value as PreflightVerifiedEmailRosterReport);
    if (rosterEmailIds.size === 0) missing.push("rosterResolvedRows");
    const bootstrapEmails = [...bootstrapEmailIds.keys()].sort();
    const rosterEmails = [...rosterEmailIds.keys()].sort();
    const missingFromBootstrap = rosterEmails.filter((email) => !bootstrapEmailIds.has(email));
    const missingFromRoster = bootstrapEmails.filter((email) => !rosterEmailIds.has(email));
    const idMismatches = bootstrapEmails.flatMap((email) => {
      const rosterId = rosterEmailIds.get(email);
      const bootstrapId = bootstrapEmailIds.get(email);
      return rosterId !== undefined && bootstrapId !== undefined && rosterId !== bootstrapId
        ? [`${email}:bootstrap=${bootstrapId}:roster=${rosterId}`]
        : [];
    });
    if (missingFromBootstrap.length > 0 || missingFromRoster.length > 0 || idMismatches.length > 0) {
      missing.push("bootstrapMatchesRosterPreflight");
    }
    if (missingFromBootstrap.length > 0) missing.push("bootstrapCoversPreflightRoster");
    if (missingFromRoster.length > 0) missing.push("bootstrapHasNoRowsOutsidePreflightRoster");
    if (idMismatches.length > 0) missing.push("bootstrapGreenhouseIdsMatchPreflight");
    return [missing.length === 0
      ? { name: "identity_bootstrap", status: "pass", summary: "Identity bootstrap evidence is token-free, clean, and matches the roster preflight Greenhouse user mapping.", details: { path: evidence.path, resolvedCount: bootstrapRows.length } }
      : { name: "identity_bootstrap", status: "fail", summary: "Identity bootstrap evidence is missing, unsafe, contains denied rows, or does not match roster preflight evidence.", details: { path: evidence.path, missing, invalidRows, missingFromBootstrap, missingFromRoster, idMismatches } }];
  }

  return [{ name: "identity_bootstrap", status: "fail", summary: "Identity bootstrap evidence cannot be validated because roster preflight evidence is unreadable or incomplete.", details: { path: evidence.path, missing, invalidRows } }];
}

function emailIdsFromRoster(report: PreflightVerifiedEmailRosterReport): Map<string, number> {
  const emailIds = new Map<string, number>();
  const resolved = Array.isArray(report.resolved) ? report.resolved : [];
  for (const row of resolved) {
    if (!isRecord(row)
      || typeof row.email !== "string"
      || typeof row.greenhouseUserId !== "number"
      || !isSafePositiveGreenhouseUserId(row.greenhouseUserId)) {
      continue;
    }
    emailIds.set(row.email.trim().toLowerCase(), row.greenhouseUserId);
  }
  return emailIds;
}

async function validateRosterPreflightEvidence(baseDir: string, evidence: RosterPreflightEvidence, checkedAt: Date): Promise<RolloutGateCheck[]> {
  if (typeof evidence.path !== "string" || evidence.path.trim().length === 0) {
    return [{ name: "roster_preflight", status: "fail", summary: "Roster preflight evidence path is required." }];
  }
  const evidencePath = resolveEvidencePath(baseDir, evidence.path);
  const read = await readJson(evidencePath);
  if (!read.ok) {
    return [{ name: "roster_preflight", status: "fail", summary: read.error, details: { path: evidence.path } }];
  }

  const report = read.value as PreflightVerifiedEmailRosterReport;
  const missing: string[] = [];
  if (!isRecord(report) || report.ok !== true) missing.push("passingReport");
  appendTimestampFreshnessMissing(missing, report.generatedAt, "generatedAt", "generatedAtFreshness", checkedAt);
  if (typeof report.rosterSource !== "string" || !MANAGED_ROSTER_SOURCES.includes(report.rosterSource as typeof MANAGED_ROSTER_SOURCES[number])) missing.push("managedRosterSource");
  if (typeof report.verifiedBy !== "string" || report.verifiedBy.trim().length === 0) missing.push("verifiedBy");
  if (report.containsTokens !== false) missing.push("tokenFreeReport");
  if (report.canIssueSessions !== true) missing.push("canIssueSessions");
  if (typeof report.requestedEmailCount !== "number" || report.requestedEmailCount <= 0) missing.push("requestedEmailCount");
  if (typeof report.normalizedEmailCount !== "number" || report.normalizedEmailCount <= 0) missing.push("normalizedEmailCount");
  if (!Array.isArray(report.requestedSurfaces) || report.requestedSurfaces.length === 0) missing.push("requestedSurfaces");
  if (!Array.isArray(report.resolved) || report.resolved.length === 0) missing.push("resolvedRoster");
  if (!Array.isArray(report.denied) || report.denied.length > 0) missing.push("noDeniedRows");
  if (manifestContainsTokenPayload(report)) missing.push("reportHasTokenPayload");

  const requestedSurfaces = Array.isArray(report.requestedSurfaces)
    ? report.requestedSurfaces.map((surface) => typeof surface === "string" ? surface : "").filter(Boolean)
    : [];
  const missingSurfaces = REQUIRED_SURFACES.filter((surface) => !requestedSurfaces.includes(surface));
  if (missingSurfaces.length > 0) missing.push("requiredSurfaces");

  const invalidResolvedRows: unknown[] = [];
  const resolved = Array.isArray(report.resolved) ? report.resolved : [];
  for (const row of resolved) {
    if (!isRecord(row)
      || typeof row.email !== "string"
      || typeof row.subject !== "string"
      || typeof row.greenhouseUserId !== "number"
      || !isSafePositiveGreenhouseUserId(row.greenhouseUserId)
      || !Array.isArray(row.surfaces)
      || REQUIRED_SURFACES.some((surface) => !row.surfaces.includes(surface))) {
      invalidResolvedRows.push(row);
    }
  }
  if (invalidResolvedRows.length > 0) missing.push("validResolvedRows");
  if (typeof report.normalizedEmailCount === "number" && resolved.length > 0 && report.normalizedEmailCount !== resolved.length) {
    missing.push("normalizedCountMatchesResolvedRows");
  }

  return [missing.length === 0
    ? {
        name: "roster_preflight",
        status: "pass",
        summary: "Recruiter email roster preflight is recent, token-free, admin-sourced, fully resolved, and covers both desktop surfaces.",
        details: {
          path: evidence.path,
          requestedEmailCount: report.requestedEmailCount,
          resolvedCount: resolved.length,
          rosterSource: report.rosterSource,
          verifiedBy: report.verifiedBy,
          generatedAt: report.generatedAt,
        },
      }
    : { name: "roster_preflight", status: "fail", summary: "Recruiter email roster preflight evidence is incomplete, stale, self-asserted, or unsafe.", details: { path: evidence.path, missing, missingSurfaces, invalidResolvedRows } }];
}

async function validateSessionIssuanceEvidence(baseDir: string, evidence: SessionIssuanceEvidence): Promise<RolloutGateCheck[]> {
  if (typeof evidence.path !== "string" || evidence.path.trim().length === 0) {
    return [{ name: "session_issuance_manifest", status: "fail", summary: "Session issuance manifest evidence path is required." }];
  }
  const evidencePath = resolveEvidencePath(baseDir, evidence.path);
  const read = await readJson(evidencePath);
  if (!read.ok) {
    return [{ name: "session_issuance_manifest", status: "fail", summary: read.error, details: { path: evidence.path } }];
  }

  const manifest = read.value as IssuedEmailSessionFileManifest;
  const missing: string[] = [];
  if (!isRecord(manifest) || manifest.ok !== true) missing.push("passingManifest");
  if (manifest.containsTokens !== false) missing.push("tokenFreeManifest");
  if (manifest.sessionFilesContainTokens !== true) missing.push("sessionFilesMarkedSensitive");
  if (typeof manifest.outputDir !== "string" || manifest.outputDir.trim().length === 0) missing.push("outputDir");
  if (typeof manifest.manifestPath !== "string" || manifest.manifestPath.trim().length === 0) missing.push("manifestPath");
  if (typeof manifest.requestedEmailCount !== "number" || manifest.requestedEmailCount <= 0) missing.push("requestedEmailCount");
  if (!Array.isArray(manifest.requestedSurfaces) || manifest.requestedSurfaces.length === 0) missing.push("requestedSurfaces");
  if (typeof manifest.fileCount !== "number" || manifest.fileCount <= 0) missing.push("fileCount");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) missing.push("files");
  if (Array.isArray(manifest.files) && typeof manifest.fileCount === "number" && manifest.fileCount !== manifest.files.length) missing.push("fileCountMatchesFiles");
  if (manifestContainsTokenPayload(manifest)) missing.push("manifestHasTokenOrConfigPayload");

  const manifestDir = dirname(evidencePath);
  const pathProblems: string[] = [];
  if (isRecord(manifest)) {
    if (manifest.outputDir !== ".") pathProblems.push("outputDir:not_portable");
    if (typeof manifest.manifestPath === "string") {
      const manifestPathIssue = evidencePathPortabilityIssue(manifestDir, manifest.manifestPath);
      if (manifestPathIssue) pathProblems.push(`manifestPath:${manifestPathIssue}`);
    }
  }

  const requestedSurfaces = Array.isArray(manifest.requestedSurfaces)
    ? manifest.requestedSurfaces.map((surface) => typeof surface === "string" ? surface : "").filter(Boolean)
    : [];
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const fileSurfaces = files
    .filter(isRecord)
    .map((file) => typeof file.surface === "string" ? file.surface : "")
    .filter(Boolean);
  const missingSurfaces = REQUIRED_SURFACES.filter((surface) => !requestedSurfaces.includes(surface) || !fileSurfaces.includes(surface));
  if (missingSurfaces.length > 0) missing.push("requiredSurfaces");
  const fileClients = files
    .filter(isRecord)
    .map((file) => typeof file.client === "string" ? file.client : "")
    .filter(Boolean);
  const missingClients = REQUIRED_CLIENT_IDENTITIES
    .map((identity) => identity.client)
    .filter((client) => !fileClients.includes(client));
  if (missingClients.length > 0) missing.push("requiredClients");

  const invalidFiles: unknown[] = [];
  const unsafeFiles: string[] = [];
  const sessionMetadataProblems: string[] = [];
  for (const file of files) {
    if (!isRecord(file)
      || typeof file.email !== "string"
      || !REQUIRED_SURFACES.includes(file.surface as (typeof REQUIRED_SURFACES)[number])
      || !isRecruiterClient(file.client)
      || !isClientSurfaceCompatible(file.client, file.surface as (typeof REQUIRED_SURFACES)[number])
      || typeof file.subject !== "string"
      || !isExactSessionTokenId(file.tokenId)
      || typeof file.issuedAt !== "string"
      || !isExactIsoTimestamp(file.issuedAt)
      || typeof file.path !== "string"
      || file.path.trim().length === 0) {
      invalidFiles.push(file);
      continue;
    }
    const pathIssue = evidencePathPortabilityIssue(manifestDir, file.path);
    if (pathIssue) {
      pathProblems.push(`${file.surface}:${file.email}:${pathIssue}`);
      continue;
    }
    const surface = file.surface as (typeof REQUIRED_SURFACES)[number];
    const sessionPath = resolveEvidencePath(manifestDir, file.path);
    const sessionRead = await readText(sessionPath);
    if (!sessionRead.ok) {
      unsafeFiles.push(`${file.surface}:${file.email}:unreadable`);
      continue;
    }
    if (/GREENHOUSE_CLIENT_ID|GREENHOUSE_CLIENT_SECRET|GREENHOUSE_RECRUITER_IDENTITY|GREENHOUSE_RECRUITER_SESSION_SECRET/.test(sessionRead.value)) {
      unsafeFiles.push(`${file.surface}:${file.email}:server_credentials`);
    }
    if (/greenhouseUserId|greenhouse_user_id|permittedJobIds|permitted_job_ids|jobIds|job_ids|permissions|expiresAt|expires_at/.test(sessionRead.value)) {
      unsafeFiles.push(`${file.surface}:${file.email}:forbidden_claims`);
    }
    const parsed = parseJsonString(sessionRead.value);
    if (!parsed.ok || !isRecord(parsed.value) || typeof parsed.value.token !== "string" || parsed.value.token.trim().length === 0) {
      unsafeFiles.push(`${file.surface}:${file.email}:missing_token`);
      continue;
    }
    if (parsed.value.email !== file.email
      || parsed.value.surface !== surface
      || (file.client !== undefined && parsed.value.client !== file.client)
      || parsed.value.subject !== file.subject
      || parsed.value.tokenId !== file.tokenId
      || parsed.value.issuedAt !== file.issuedAt) {
      sessionMetadataProblems.push(`${file.surface}:${file.email}:file_metadata_mismatch`);
    }
    const metadataProblems = validateSessionTokenMetadata(parsed.value.token, {
      email: file.email,
      surface,
      client: isRecruiterClient(file.client) ? file.client : undefined,
      subject: file.subject,
      tokenId: file.tokenId,
      issuedAt: file.issuedAt,
    });
    for (const problem of metadataProblems) {
      sessionMetadataProblems.push(`${file.surface}:${file.email}:${problem}`);
    }
  }
  if (invalidFiles.length > 0) missing.push("validFileEntries");
  if (unsafeFiles.length > 0) missing.push("sessionFilesWithoutSecretsOrScopedClaims");
  if (sessionMetadataProblems.length > 0) missing.push("sessionFilesMatchManifestTokenMetadata");
  if (pathProblems.length > 0) missing.push("portableManifestPaths");

  return [missing.length === 0
    ? { name: "session_issuance_manifest", status: "pass", summary: "Split session issuance manifest is token-free and session files avoid server credentials, scoped permission claims, expiry claims, and token metadata mismatches.", details: { path: evidence.path, fileCount: manifest.fileCount, surfaces: REQUIRED_SURFACES } }
    : { name: "session_issuance_manifest", status: "fail", summary: "Session issuance split-output evidence is incomplete or unsafe.", details: { path: evidence.path, missing, missingSurfaces, missingClients, unsafeFiles, sessionMetadataProblems, pathProblems } }];
}

async function validateRosterSessionConfigConsistency(
  baseDir: string,
  rosterEvidence: RosterPreflightEvidence,
  sessionEvidence: SessionIssuanceEvidence,
  desktopEvidence: DesktopConfigEvidence
): Promise<RolloutGateCheck[]> {
  const rosterRead = await readJson(resolveEvidencePath(baseDir, rosterEvidence.path));
  const sessionRead = await readJson(resolveEvidencePath(baseDir, sessionEvidence.path));
  const desktopRead = await readJson(resolveEvidencePath(baseDir, desktopEvidence.path));
  const unreadable: string[] = [];
  if (!rosterRead.ok) unreadable.push("rosterPreflightEvidence");
  if (!sessionRead.ok) unreadable.push("sessionIssuanceEvidence");
  if (!desktopRead.ok) unreadable.push("desktopConfigEvidence");
  if (!rosterRead.ok || !sessionRead.ok || !desktopRead.ok) {
    return [{
      name: "roster_session_config_consistency",
      status: "fail",
      summary: "Roster, session issuance, and desktop config evidence must all be readable for consistency validation.",
      details: { unreadable },
    }];
  }

  const roster = rosterRead.value as PreflightVerifiedEmailRosterReport;
  const sessionManifest = sessionRead.value as IssuedEmailSessionFileManifest;
  const desktopManifest = desktopRead.value as DesktopConfigFileManifest;
  const missing: string[] = [];
  const expectedPairs = pairSetFromRoster(roster);
  const sessionPairs = pairSetFromManifestFiles(sessionManifest);
  const desktopPairs = pairSetFromManifestFiles(desktopManifest);
  if (expectedPairs.size === 0) missing.push("rosterPairs");
  if (sessionPairs.size === 0) missing.push("sessionPairs");
  if (desktopPairs.size === 0) missing.push("desktopPairs");
  if (typeof roster.normalizedEmailCount === "number" && typeof sessionManifest.requestedEmailCount === "number"
    && roster.normalizedEmailCount !== sessionManifest.requestedEmailCount) {
    missing.push("rosterCountMatchesSessionRequest");
  }

  const sessionMissing = [...expectedPairs].filter((pair) => !sessionPairs.has(pair));
  const sessionUnexpected = [...sessionPairs].filter((pair) => !expectedPairs.has(pair));
  const desktopMissing = [...expectedPairs].filter((pair) => !desktopPairs.has(pair));
  const desktopUnexpected = [...desktopPairs].filter((pair) => !expectedPairs.has(pair));
  const tokenMismatches = tokenIdMismatchesBetweenManifests(sessionManifest, desktopManifest);
  const issuedAtMismatches = issuedAtMismatchesBetweenManifests(sessionManifest, desktopManifest);
  if (sessionMissing.length > 0) missing.push("sessionsForEveryPreflightedRecruiterSurface");
  if (sessionUnexpected.length > 0) missing.push("noSessionFilesOutsidePreflightRoster");
  if (desktopMissing.length > 0) missing.push("desktopConfigsForEveryPreflightedRecruiterSurface");
  if (desktopUnexpected.length > 0) missing.push("noDesktopConfigsOutsidePreflightRoster");
  if (tokenMismatches.length > 0) missing.push("sessionAndDesktopTokenIdsMatch");
  if (issuedAtMismatches.length > 0) missing.push("sessionAndDesktopIssuedAtMatch");

  return [missing.length === 0
    ? {
      name: "roster_session_config_consistency",
      status: "pass",
      summary: "Roster preflight, session issuance, and desktop config evidence cover the same recruiter/client set and durable session metadata.",
      details: { recruiterClientPairs: expectedPairs.size },
    }
    : {
      name: "roster_session_config_consistency",
      status: "fail",
      summary: "Roster preflight, session issuance, and desktop config evidence do not cover the same recruiter/client set and durable session metadata.",
      details: { missing, sessionMissing, sessionUnexpected, desktopMissing, desktopUnexpected, tokenMismatches, issuedAtMismatches },
    }];
}

function pairSetFromRoster(report: PreflightVerifiedEmailRosterReport): Set<string> {
  const pairs = new Set<string>();
  const resolved = Array.isArray(report.resolved) ? report.resolved : [];
  for (const row of resolved) {
    if (!isRecord(row) || typeof row.email !== "string" || !Array.isArray(row.surfaces)) continue;
    const email = row.email.trim().toLowerCase();
    for (const identity of REQUIRED_CLIENT_IDENTITIES) {
      if (row.surfaces.includes(identity.surface)) {
        pairs.add(sessionIdentityKey(email, identity.surface, identity.client));
      }
    }
  }
  return pairs;
}

function pairSetFromManifestFiles(manifest: IssuedEmailSessionFileManifest | DesktopConfigFileManifest): Set<string> {
  const pairs = new Set<string>();
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  for (const file of files) {
    if (!isRecord(file) || typeof file.email !== "string" || typeof file.surface !== "string" || !isRecruiterClient(file.client)) continue;
    if (!REQUIRED_SURFACES.includes(file.surface as (typeof REQUIRED_SURFACES)[number])) continue;
    if (!isClientSurfaceCompatible(file.client, file.surface as (typeof REQUIRED_SURFACES)[number])) continue;
    pairs.add(sessionIdentityKey(file.email, file.surface as (typeof REQUIRED_SURFACES)[number], file.client));
  }
  return pairs;
}

function desktopConfigEntriesByPair(manifest: DesktopConfigFileManifest): Map<string, DesktopConfigFileManifestEntry & { client: RecruiterClient; tokenId: string; issuedAt: string }> {
  const entries = new Map<string, DesktopConfigFileManifestEntry & { client: RecruiterClient; tokenId: string; issuedAt: string }>();
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  for (const file of files) {
    if (!isRecord(file)
      || typeof file.email !== "string"
      || typeof file.surface !== "string"
      || !isRecruiterClient(file.client)
      || typeof file.tokenId !== "string"
      || typeof file.issuedAt !== "string"
      || typeof file.path !== "string") {
      continue;
    }
    if (!REQUIRED_SURFACES.includes(file.surface as (typeof REQUIRED_SURFACES)[number])) continue;
    if (!isClientSurfaceCompatible(file.client, file.surface as (typeof REQUIRED_SURFACES)[number])) continue;
    const pair = sessionIdentityKey(file.email, file.surface as (typeof REQUIRED_SURFACES)[number], file.client);
    const tokenId = isExactSessionTokenId(file.tokenId) ? file.tokenId : "";
    const issuedAt = isExactIsoTimestamp(file.issuedAt) ? file.issuedAt : "";
    const path = file.path.trim();
    if (tokenId && issuedAt && path) {
      entries.set(pair, {
        email: file.email,
        surface: file.surface as (typeof REQUIRED_SURFACES)[number],
        client: file.client,
        tokenId,
        subject: typeof file.subject === "string" ? file.subject : undefined,
        issuedAt,
        path,
      });
    }
  }
  return entries;
}


function tokenIdMismatchesBetweenManifests(
  sessionManifest: IssuedEmailSessionFileManifest,
  desktopManifest: DesktopConfigFileManifest
): string[] {
  const sessionTokenIds = tokenIdsByPair(sessionManifest);
  const desktopTokenIds = tokenIdsByPair(desktopManifest);
  const mismatches: string[] = [];
  for (const [pair, sessionTokenId] of sessionTokenIds.entries()) {
    const desktopTokenId = desktopTokenIds.get(pair);
    if (desktopTokenId !== undefined && desktopTokenId !== sessionTokenId) {
      mismatches.push(`${pair}:session=${sessionTokenId}:desktop=${desktopTokenId}`);
    }
  }
  return mismatches;
}

function issuedAtMismatchesBetweenManifests(
  sessionManifest: IssuedEmailSessionFileManifest,
  desktopManifest: DesktopConfigFileManifest
): string[] {
  const sessionIssuedAts = issuedAtsByPair(sessionManifest);
  const desktopIssuedAts = issuedAtsByPair(desktopManifest);
  const mismatches: string[] = [];
  for (const [pair, sessionIssuedAt] of sessionIssuedAts.entries()) {
    const desktopIssuedAt = desktopIssuedAts.get(pair);
    if (desktopIssuedAt !== undefined && desktopIssuedAt !== sessionIssuedAt) {
      mismatches.push(`${pair}:session=${sessionIssuedAt}:desktop=${desktopIssuedAt}`);
    }
  }
  return mismatches;
}

function tokenIdForPairFromManifestFiles(
  manifest: IssuedEmailSessionFileManifest | DesktopConfigFileManifest,
  email: string,
  surface: (typeof REQUIRED_SURFACES)[number],
  client: RecruiterClient
): string | undefined {
  return tokenIdsByPair(manifest).get(sessionIdentityKey(email, surface, client));
}

function issuedAtForPairFromManifestFiles(
  manifest: IssuedEmailSessionFileManifest | DesktopConfigFileManifest,
  email: string,
  surface: (typeof REQUIRED_SURFACES)[number],
  client: RecruiterClient
): string | undefined {
  return issuedAtsByPair(manifest).get(sessionIdentityKey(email, surface, client));
}

function tokenIdsByPair(manifest: IssuedEmailSessionFileManifest | DesktopConfigFileManifest): Map<string, string> {
  const tokenIds = new Map<string, string>();
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  for (const file of files) {
    if (!isRecord(file) || typeof file.email !== "string" || typeof file.surface !== "string" || !isRecruiterClient(file.client) || typeof file.tokenId !== "string") continue;
    if (!REQUIRED_SURFACES.includes(file.surface as (typeof REQUIRED_SURFACES)[number])) continue;
    if (!isClientSurfaceCompatible(file.client, file.surface as (typeof REQUIRED_SURFACES)[number])) continue;
    const pair = sessionIdentityKey(file.email, file.surface as (typeof REQUIRED_SURFACES)[number], file.client);
    const tokenId = isExactSessionTokenId(file.tokenId) ? file.tokenId : "";
    if (tokenId) tokenIds.set(pair, tokenId);
  }
  return tokenIds;
}

function issuedAtsByPair(manifest: IssuedEmailSessionFileManifest | DesktopConfigFileManifest): Map<string, string> {
  const issuedAts = new Map<string, string>();
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  for (const file of files) {
    if (!isRecord(file) || typeof file.email !== "string" || typeof file.surface !== "string" || !isRecruiterClient(file.client) || typeof file.issuedAt !== "string") continue;
    if (!REQUIRED_SURFACES.includes(file.surface as (typeof REQUIRED_SURFACES)[number])) continue;
    if (!isClientSurfaceCompatible(file.client, file.surface as (typeof REQUIRED_SURFACES)[number])) continue;
    const pair = sessionIdentityKey(file.email, file.surface as (typeof REQUIRED_SURFACES)[number], file.client);
    const issuedAt = isExactIsoTimestamp(file.issuedAt) ? file.issuedAt : "";
    if (issuedAt) issuedAts.set(pair, issuedAt);
  }
  return issuedAts;
}

function issuedAtForTokenIdFromManifestFiles(
  manifest: IssuedEmailSessionFileManifest | DesktopConfigFileManifest,
  surface: (typeof REQUIRED_SURFACES)[number],
  tokenId: string,
  client?: RecruiterClient
): string | undefined {
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  for (const file of files) {
    if (!isRecord(file)
      || file.surface !== surface
      || (client !== undefined && file.client !== client)
      || typeof file.tokenId !== "string"
      || !isExactSessionTokenId(file.tokenId)
      || file.tokenId !== tokenId
      || typeof file.issuedAt !== "string") {
      continue;
    }
    if (isExactIsoTimestamp(file.issuedAt)) return file.issuedAt;
  }
  return undefined;
}

function sessionIdentityKey(
  email: string,
  surface: (typeof REQUIRED_SURFACES)[number],
  client: RecruiterClient
): string {
  return `${email.trim().toLowerCase()}:${surface}:${client}`;
}

function tokenIdSetFromManifestFiles(
  manifest: IssuedEmailSessionFileManifest | DesktopConfigFileManifest,
  surface: (typeof REQUIRED_SURFACES)[number]
): Set<string> {
  const tokenIds = new Set<string>();
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  for (const file of files) {
    if (!isRecord(file) || file.surface !== surface || typeof file.tokenId !== "string") continue;
    const tokenId = isExactSessionTokenId(file.tokenId) ? file.tokenId : "";
    if (tokenId) tokenIds.add(tokenId);
  }
  return tokenIds;
}

function validateProductionMcpUrl(value: unknown): { ok: true; url: string } | { ok: false; reason: string } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, reason: "missing_url" };
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "not_https" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "embedded_credentials" };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, reason: "query_or_fragment" };
  }
  const hostname = parsed.hostname.toLowerCase();
  const hostnameReason = classifyNonProductionHostname(hostname);
  if (hostnameReason) return { ok: false, reason: hostnameReason };
  return { ok: true, url: parsed.toString() };
}

function validateRequiredProfiles(entries: LiveProbeEvidence[]): RolloutGateCheck[] {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.profile, (counts.get(entry.profile) ?? 0) + 1);
  const missing = REQUIRED_PROBE_PROFILES.filter((profile) => !counts.has(profile));
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([profile]) => profile);
  const unexpected = [...counts.keys()].filter((profile) => !REQUIRED_PROBE_PROFILES.includes(profile as never));
  const duplicatePaths = [...new Set(entries.map((entry) => entry.path).filter((path, index, paths) => paths.indexOf(path) !== index))];
  const exact = entries.length === REQUIRED_PROBE_PROFILES.length
    && missing.length === 0
    && duplicates.length === 0
    && unexpected.length === 0
    && duplicatePaths.length === 0;
  return [exact
    ? { name: "live_probe_manifest", status: "pass", summary: "Manifest includes exactly one distinct evidence path for every required live probe profile." }
    : { name: "live_probe_manifest", status: "fail", summary: "Manifest must include exactly one distinct evidence path for every required live probe profile.", details: { missing, duplicates, unexpected, duplicatePaths } }];
}

async function validateDistinctLiveProbeArtifacts(
  baseDir: string,
  entries: LiveProbeEvidence[]
): Promise<RolloutGateCheck> {
  const hashes: Array<{ profile: string; hash: string }> = [];
  const unreadable: string[] = [];
  for (const entry of entries) {
    try {
      const content = await readFile(resolveEvidencePath(baseDir, entry.path));
      hashes.push({ profile: entry.profile, hash: createHash("sha256").update(content).digest("hex") });
    } catch {
      unreadable.push(entry.profile);
    }
  }
  const reused = [...new Set(hashes
    .filter((entry, index) => hashes.findIndex((candidate) => candidate.hash === entry.hash) !== index)
    .flatMap((entry) => hashes.filter((candidate) => candidate.hash === entry.hash).map((candidate) => candidate.profile)))];
  return unreadable.length === 0 && reused.length === 0
    ? { name: "live_probe_artifact_uniqueness", status: "pass", summary: "Every required live probe profile has a distinct report artifact." }
    : { name: "live_probe_artifact_uniqueness", status: "fail", summary: "Live probe profiles must not reuse the same report artifact.", details: { unreadable, reused } };
}

function validateRequiredClients(
  name: string,
  entries: Array<DistributionValidationEvidence | DesktopUserTestEvidence | RevocationDrillEvidence | SessionRevocationEvidence>
): RolloutGateCheck[] {
  const expected = new Set(REQUIRED_CLIENT_IDENTITIES.map((identity) => `${identity.surface}:${identity.client}`));
  const counts = new Map<string, number>();
  const unexpected: string[] = [];
  for (const entry of entries) {
    const key = `${entry.surface}:${entry.client}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!expected.has(key)) unexpected.push(key);
  }
  const missing = [...expected].filter((key) => !counts.has(key));
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key);
  return [missing.length === 0 && duplicates.length === 0 && unexpected.length === 0
    ? { name, status: "pass", summary: "Manifest includes exactly one validation for Claude Desktop, Claude Code, and ChatGPT/Codex." }
    : { name, status: "fail", summary: "Manifest must include exactly one validation for each required physical client.", details: { missing, duplicates, unexpected } }];
}

async function validatePermissionFreshness(
  baseDir: string,
  checkedAt: Date,
  evidence: PermissionFreshnessEvidence,
  sessionEvidence: SessionIssuanceEvidence,
  desktopEvidence: DesktopConfigEvidence
): Promise<RolloutGateCheck[]> {
  const missing: string[] = [];
  const requiredFlags: Array<keyof PermissionFreshnessEvidence> = [
    "removedReqDisappearedOnNextRead",
    "addedReqAppearedWithoutDeploy",
    "privateNotesDropped",
    "scopedVsUnscopedLeakageSamplePassed",
    "durableAccessTestedWithoutRoutineReverification",
  ];
  missing.push(...requiredFlags.filter((key) => evidence[key] !== true));
  appendTimestampFreshnessMissing(missing, evidence.verifiedAt, "verifiedAt", "verifiedAtFreshness", checkedAt);
  if (!isNonEmptyString(evidence.verifiedBy)) missing.push("verifiedBy");
  if (!isPositiveInteger(evidence.removedReqId)) missing.push("removedReqId");
  if (!isPositiveInteger(evidence.removedReqRowsBeforeRemoval)) missing.push("removedReqRowsBeforeRemoval");
  if (evidence.removedReqRowsAfterRemoval !== 0) missing.push("removedReqRowsAfterRemoval");
  if (!isPositiveInteger(evidence.addedReqId)) missing.push("addedReqId");
  if (evidence.addedReqRowsBeforeAddition !== 0) missing.push("addedReqRowsBeforeAddition");
  if (!isPositiveInteger(evidence.addedReqRowsAfterAddition)) missing.push("addedReqRowsAfterAddition");
  if (!isPositiveInteger(evidence.privateNoteId)) missing.push("privateNoteId");
  if (evidence.privateNoteRowsReturnedAfterScope !== 0) missing.push("privateNoteRowsReturnedAfterScope");
  const durableSessionEmail = normalizeEvidenceEmail(evidence.durableSessionEmail);
  const durableSessionSurface = isRecruiterDesktopSurface(evidence.durableSessionSurface) ? evidence.durableSessionSurface : null;
  if (!durableSessionEmail) missing.push("durableSessionEmail");
  if (!durableSessionSurface) missing.push("durableSessionSurface");
  if (!isExactSessionTokenId(evidence.durableSessionTokenId)) missing.push("durableSessionTokenId");
  if (!isExactSessionTokenId(evidence.durableSessionTokenIdAfterRestart) || evidence.durableSessionTokenIdAfterRestart !== evidence.durableSessionTokenId) missing.push("durableSessionTokenIdAfterRestart");
  if (!isExactIsoTimestamp(evidence.durableSessionIssuedAt)) missing.push("durableSessionIssuedAt");
  if (!isExactIsoTimestamp(evidence.durableSessionIssuedAtAfterRestart) || evidence.durableSessionIssuedAtAfterRestart !== evidence.durableSessionIssuedAt) missing.push("durableSessionIssuedAtAfterRestart");
  if (evidence.routineReverificationPrompted !== false) missing.push("routineReverificationPrompted");

  const binding = durableSessionEmail && durableSessionSurface && isExactSessionTokenId(evidence.durableSessionTokenId) && isExactIsoTimestamp(evidence.durableSessionIssuedAt)
    ? await validateDurablePermissionSessionBinding(
      baseDir,
      durableSessionEmail,
      durableSessionSurface,
      evidence.durableSessionTokenId,
      evidence.durableSessionIssuedAt,
      sessionEvidence,
      desktopEvidence
    )
    : { ok: true as const };
  if (!binding.ok) missing.push("durableSessionIssuedTokenBinding");

  return [missing.length === 0
    ? { name: "permission_freshness_and_leakage", status: "pass", summary: "Permission freshness, note visibility, leakage, and durable-access evidence are present with recent concrete token-free samples tied to the issued recruiter email, desktop surface, token, and issued-at timestamp." }
    : { name: "permission_freshness_and_leakage", status: "fail", summary: "Permission freshness or leakage evidence is stale, incomplete, or not tied to the issued recruiter email, desktop surface, token, and issued-at timestamp.", details: { missing, durableSessionBindingMissing: binding.ok ? [] : binding.missing, maxEvidenceAgeDays: DYNAMIC_EVIDENCE_MAX_AGE_DAYS, maxVerifiedAtAgeDays: DYNAMIC_EVIDENCE_MAX_AGE_DAYS } }];
}

async function validateDurablePermissionSessionBinding(
  baseDir: string,
  email: string,
  surface: (typeof REQUIRED_SURFACES)[number],
  tokenId: string,
  issuedAt: string,
  sessionEvidence: SessionIssuanceEvidence,
  desktopEvidence: DesktopConfigEvidence
): Promise<{ ok: true } | { ok: false; missing: string[] }> {
  const missing: string[] = [];
  const sessionRead = await readJson(resolveEvidencePath(baseDir, sessionEvidence.path));
  const desktopRead = await readJson(resolveEvidencePath(baseDir, desktopEvidence.path));
  if (!sessionRead.ok) missing.push("sessionIssuanceEvidenceReadable");
  if (!desktopRead.ok) missing.push("desktopConfigEvidenceReadable");

  const sessionMatch = sessionRead.ok
    ? manifestEntryForEmailSurface(sessionRead.value as IssuedEmailSessionFileManifest, email, surface, tokenId)
    : undefined;
  const desktopMatch = desktopRead.ok
    ? manifestEntryForEmailSurface(desktopRead.value as DesktopConfigFileManifest, email, surface, tokenId)
    : undefined;

  if (sessionMatch) {
    if (!sessionMatch.entryFound) missing.push("durableSessionIssuanceEmailSurface");
    else if (sessionMatch.tokenId !== tokenId) missing.push("durableSessionIssuanceTokenId");
    else if (sessionMatch.issuedAt !== issuedAt) missing.push("durableSessionIssuanceIssuedAt");
  }
  if (desktopMatch) {
    if (!desktopMatch.entryFound) missing.push("durableDesktopConfigEmailSurface");
    else if (desktopMatch.tokenId !== tokenId) missing.push("durableDesktopConfigTokenId");
    else if (desktopMatch.issuedAt !== issuedAt) missing.push("durableDesktopConfigIssuedAt");
  }

  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

function manifestEntryForEmailSurface(
  manifest: IssuedEmailSessionFileManifest | DesktopConfigFileManifest,
  email: string,
  surface: (typeof REQUIRED_SURFACES)[number],
  tokenId?: string
): { entryFound: false } | { entryFound: true; tokenId: string | null; issuedAt: string | null } {
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const normalizedEmail = email.trim().toLowerCase();
  let fallback: { entryFound: true; tokenId: string | null; issuedAt: string | null } | undefined;
  for (const file of files) {
    if (!isRecord(file)
      || typeof file.email !== "string"
      || file.email.trim().toLowerCase() !== normalizedEmail
      || file.surface !== surface) {
      continue;
    }
    const candidate = {
      entryFound: true,
      tokenId: isExactSessionTokenId(file.tokenId) ? file.tokenId : null,
      issuedAt: isExactIsoTimestamp(file.issuedAt) ? file.issuedAt : null,
    } as const;
    if (tokenId !== undefined && file.tokenId === tokenId) return candidate;
    fallback ??= candidate;
  }
  return fallback ?? { entryFound: false };
}

function normalizeEvidenceEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized) ? normalized : null;
}

function isRecruiterDesktopSurface(value: unknown): value is (typeof REQUIRED_SURFACES)[number] {
  return REQUIRED_SURFACES.includes(value as (typeof REQUIRED_SURFACES)[number]);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidIsoTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isExactSessionTokenId(value: unknown): value is string {
  try {
    normalizeSessionTokenId(value);
    return true;
  } catch {
    return false;
  }
}

function exactSessionTokenIdOrEmpty(value: unknown): string {
  return isExactSessionTokenId(value) ? value : "";
}

function isExactIsoTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && value.trim() === value
    && value.length > 0
    && Number.isFinite(Date.parse(value));
}

function isTimestampWithinAge(value: string, now: Date, maxAgeMs: number): boolean {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const ageMs = now.getTime() - timestamp;
  return ageMs >= 0 && ageMs <= maxAgeMs;
}

function isTimestampFresh(value: unknown, now: Date): boolean {
  return isValidIsoTimestamp(value) && isTimestampWithinAge(value, now, DYNAMIC_EVIDENCE_MAX_AGE_MS);
}

function appendTimestampFreshnessMissing(
  missing: string[],
  value: unknown,
  timestampField: string,
  freshnessField: string,
  now: Date
): void {
  if (!isValidIsoTimestamp(value)) {
    missing.push(timestampField);
    return;
  }
  if (!isTimestampWithinAge(value, now, DYNAMIC_EVIDENCE_MAX_AGE_MS)) {
    missing.push(freshnessField);
  }
}

function timestampFreshnessCheck(
  name: string,
  value: unknown,
  now: Date,
  passSummary: string,
  failSummary: string,
  details: Record<string, unknown> = {}
): RolloutGateCheck {
  const timestamp = typeof value === "string" ? value.trim() : "";
  const fresh = isTimestampFresh(value, now);
  return fresh
    ? { name, status: "pass", summary: passSummary, details: { ...details, timestamp } }
    : {
        name,
        status: "fail",
        summary: failSummary,
        details: {
          ...details,
          timestamp: timestamp || null,
          maxEvidenceAgeDays: DYNAMIC_EVIDENCE_MAX_AGE_DAYS,
        },
      };
}

function isPositiveInteger(value: unknown): value is number {
  return isSafePositiveGreenhouseUserId(value);
}

async function validateAuditReview(baseDir: string, evidence: AuditReviewEvidence, checkedAt: Date): Promise<RolloutGateCheck[]> {
  if (typeof evidence.path !== "string" || evidence.path.trim().length === 0) {
    return [{ name: "audit_review", status: "fail", summary: "Audit review evidence path is required." }];
  }
  const evidencePath = resolveEvidencePath(baseDir, evidence.path);
  const read = await readJson(evidencePath);
  if (!read.ok) {
    return [{ name: "audit_review", status: "fail", summary: read.error, details: { path: evidence.path } }];
  }
  const report = read.value as AuditReviewReport;
  const missing: string[] = [];
  if (!isRecord(report) || report.reportVersion !== 2 || report.ok !== true || report.status !== "pass") missing.push("passingV2Report");
  if (typeof report.reviewer !== "string" || report.reviewer.trim().length === 0) missing.push("reviewer");
  appendTimestampFreshnessMissing(missing, report.reviewedAt, "reviewedAt", "reviewedAtFreshness", checkedAt);
  if (report.retainedAuditSink !== true) missing.push("retainedAuditSink");
  if (report.successEventsPresent !== true) missing.push("successEventsPresent");
  if (report.denialEventsPresent !== true) missing.push("denialEventsPresent");
  if (report.surfaceCoveragePresent !== true) missing.push("surfaceCoveragePresent");
  if (report.v2ClientCoveragePresent !== true) missing.push("v2ClientCoveragePresent");
  const v2Clients = Array.isArray(report.v2Clients) ? report.v2Clients : [];
  const missingV2Clients = REQUIRED_CLIENT_IDENTITIES.map((identity) => identity.client)
    .filter((client) => !v2Clients.includes(client));
  const unexpectedV2Clients = v2Clients.filter((client) => !REQUIRED_CLIENT_IDENTITIES.some((identity) => identity.client === client));
  if (missingV2Clients.length > 0 || unexpectedV2Clients.length > 0 || new Set(v2Clients).size !== v2Clients.length) missing.push("exactV2ClientCoverage");
  if (typeof report.v2TerminalEvents !== "number" || report.v2TerminalEvents < REQUIRED_CLIENT_IDENTITIES.length) missing.push("v2TerminalEvents");
  if (report.unmatchedV2StartEvents !== 0) missing.push("unmatchedV2StartEvents");
  if (report.toolKindCoveragePresent !== true) missing.push("toolKindCoveragePresent");
  if (report.noSensitivePayloadsFound !== true) missing.push("noSensitivePayloadsFound");
  if (typeof report.totalEvents !== "number" || report.totalEvents <= 0) missing.push("totalEvents");
  const auditChecks = Array.isArray(report.checks) ? report.checks : [];
  for (const requiredCheck of ["audit_v2_client_coverage", "audit_v2_pair_attribution"]) {
    if (!auditChecks.some((check) => isRecord(check) && check.name === requiredCheck && check.status === "pass")) {
      missing.push(requiredCheck);
    }
  }
  if (manifestContainsTokenPayload(report)) missing.push("reportHasTokenOrConfigPayload");
  return [missing.length === 0
    ? { name: "audit_review", status: "pass", summary: "Audit retention, redaction, and three-client v2 attribution review passed.", details: { path: evidence.path, totalEvents: report.totalEvents, v2Clients } }
    : { name: "audit_review", status: "fail", summary: "Audit retention, redaction, or v2 physical-client attribution review is incomplete.", details: { path: evidence.path, missing, missingV2Clients, unexpectedV2Clients } }];
}

async function validateLeakageSample(
  baseDir: string,
  evidence: LeakageSampleEvidence,
  candidate: CandidateReleaseBinding,
  checkedAt: Date
): Promise<RolloutGateCheck[]> {
  if (typeof evidence.path !== "string" || evidence.path.trim().length === 0) {
    return [{ name: "leakage_sample", status: "fail", summary: "Scoped-vs-unscoped leakage sample evidence path is required." }];
  }
  const evidencePath = resolveEvidencePath(baseDir, evidence.path);
  const read = await readJson(evidencePath);
  if (!read.ok) {
    return [{ name: "leakage_sample", status: "fail", summary: read.error, details: { path: evidence.path } }];
  }
  const sample = read.value as ScopeLeakageSampleReport;
  const sampleChecks = isRecord(sample) && Array.isArray(sample.checks) ? sample.checks : [];
  const failed = sampleChecks
    .filter((check) => isRecord(check) && check.status === "fail")
    .map((check) => check.name)
    .filter((name): name is string => typeof name === "string");
  const operatorSampleCheck = sampleChecks.find((check) => isRecord(check) && check.name === "operator_unscoped_sample");
  const scopedSampleCheck = sampleChecks.find((check) => isRecord(check) && check.name === "act_as_user_scoped_sample");
  const forbiddenLeakageCheck = sampleChecks.find((check) => isRecord(check) && check.name === "forbidden_job_leakage");
  const missing: string[] = [];
  if (!isRecord(sample) || sample.ok !== true) missing.push("passingReport");
  const sampleSurface = sample.surface === "chatgpt_desktop" || sample.surface === "claude_desktop" ? sample.surface : null;
  const sampleClient = isRecruiterClient(sample.client) ? sample.client : null;
  if (!sampleSurface) missing.push("productionSurface");
  if (!sampleClient || (sampleSurface && !isClientSurfaceCompatible(sampleClient, sampleSurface))) missing.push("physicalClient");
  const buildCommit = typeof sample.buildCommit === "string" && /^[0-9a-f]{40}$/i.test(sample.buildCommit)
    ? sample.buildCommit.toLowerCase()
    : null;
  if (!candidate.ok || buildCommit !== candidate.commit) missing.push("candidateBuildCommit");
  appendTimestampFreshnessMissing(missing, sample.generatedAt, "generatedAt", "generatedAtFreshness", checkedAt);
  if (sample.strict !== true) missing.push("strict");
  if (sample.sessionSubjectPresent !== true) missing.push("sessionSubjectPresent");
  if (typeof sample.actAsUser !== "number" || sample.actAsUser <= 0) missing.push("actAsUser");
  if (typeof sample.auditEventCount !== "number" || sample.auditEventCount <= 0) missing.push("auditEventCount");
  if (!isRecord(operatorSampleCheck) || operatorSampleCheck.status !== "pass") missing.push("operator_unscoped_sample");
  if (!operatorUnscopedDetailsPassed(operatorSampleCheck)) missing.push("operator_unscoped_details");
  if (!isRecord(scopedSampleCheck) || scopedSampleCheck.status !== "pass") missing.push("act_as_user_scoped_sample");
  if (!actAsUserScopedDetailsPassed(scopedSampleCheck, sample.actAsUser)) missing.push("act_as_user_scoped_details");
  if (!isRecord(forbiddenLeakageCheck) || forbiddenLeakageCheck.status !== "pass") missing.push("forbidden_job_leakage");
  if (!forbiddenLeakageDetailsPassed(forbiddenLeakageCheck)) missing.push("forbidden_job_leakage_details");
  if (failed.length > 0) missing.push("failedChecks");
  if (manifestContainsTokenPayload(sample)) missing.push("reportHasTokenOrConfigPayload");
  return [missing.length === 0
    ? { name: "leakage_sample", status: "pass", summary: "Scoped-vs-unscoped leakage sample report passed with operator-unscoped, actAsUser-scoped, and forbidden-job exclusion details.", details: { path: evidence.path, actAsUser: sample.actAsUser, auditEventCount: sample.auditEventCount } }
    : { name: "leakage_sample", status: "fail", summary: "Scoped-vs-unscoped leakage sample report is incomplete or failed.", details: { path: evidence.path, missing, failed } }];
}

function operatorUnscopedDetailsPassed(check: unknown): boolean {
  if (!isRecord(check) || !isRecord(check.details)) return false;
  return check.details.scoped === false && check.details.permissionScopeKind === "operator";
}

function actAsUserScopedDetailsPassed(check: unknown, actAsUser: unknown): boolean {
  if (typeof actAsUser !== "number" || !isRecord(check) || !isRecord(check.details)) return false;
  return check.details.actAsUser === actAsUser
    && check.details.effectiveActorId === actAsUser
    && check.details.scoped === true
    && check.details.permissionScopeKind === "jobs";
}

function forbiddenLeakageDetailsPassed(check: unknown): boolean {
  if (!isRecord(check) || !isRecord(check.details)) return false;
  return check.details.unscopedVisible === true && check.details.scopedVisible === false;
}

function report(options: Pick<RolloutGateOptions, "now">, manifestPath: string, checks: RolloutGateCheck[]): RolloutGateReport {
  const ok = checks.every((check) => check.status === "pass");
  return {
    ok,
    status: ok ? "ready" : "not_ready",
    checkedAt: (options.now ?? (() => new Date()))().toISOString(),
    manifestPath,
    checks,
  };
}

function liveReadyzFromEnv(env: NodeJS.ProcessEnv): LiveReadyzObservationInput {
  return {
    url: env.GREENHOUSE_RECRUITER_ROLLOUT_LIVE_READYZ_URL,
    token: env.GREENHOUSE_RECRUITER_READYZ_TOKEN,
  };
}

// A REAL live readiness check against the hosted recruiter MCP, the de-theatered counterpart to the
// recorded evidence above. The deploy gate pairs it with a fresh public /version observation. It
// fetches production /readyz with the readiness bearer token and asserts the hosted server reports
// ready RIGHT NOW. CLI/deploy entrypoints always call this check, so a missing
// URL fails instead of letting recorded evidence masquerade as a live observation. The pure
// runRolloutGate manifest-validation path remains offline-deterministic. fetch is injectable for
// offline testing. The token is never echoed into the report.
export async function observeLiveReadyz(input: LiveReadyzObservationInput): Promise<RolloutGateCheck[]> {
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (url.length === 0) {
    return [{
      name: "live_readyz_observation",
      status: "fail",
      summary: "Live /readyz observation is required. Set GREENHOUSE_RECRUITER_ROLLOUT_LIVE_READYZ_URL and GREENHOUSE_RECRUITER_READYZ_TOKEN on the deploy step.",
    }];
  }
  const productionUrl = validateProductionMcpUrl(url);
  if (!productionUrl.ok) {
    return [{ name: "live_readyz_observation", status: "fail", summary: "Live /readyz URL must be a production HTTPS URL, not localhost or an insecure development URL.", details: { reason: productionUrl.reason } }];
  }
  const token = typeof input.token === "string" ? input.token.trim() : "";
  if (token.length === 0) {
    return [{ name: "live_readyz_observation", status: "fail", summary: "Live /readyz observation requires GREENHOUSE_RECRUITER_READYZ_TOKEN to read the detailed hosted readiness report." }];
  }
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return [{ name: "live_readyz_observation", status: "fail", summary: "No fetch implementation is available to observe live /readyz." }];
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? LIVE_READYZ_DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(productionUrl.url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (response.url && response.url !== productionUrl.url) {
      return [{ name: "live_readyz_observation", status: "fail", summary: "Live /readyz response did not remain on the pinned candidate URL." }];
    }
    if (!response.ok) {
      return [{ name: "live_readyz_observation", status: "fail", summary: "Live /readyz did not return a 2xx ready response from the hosted recruiter MCP.", details: { httpStatus: response.status } }];
    }
    const body = await response.json().catch(() => null) as unknown;
    const observedReady = isRecord(body) && body.ok === true && body.status === "ready";
    return [observedReady
      ? { name: "live_readyz_observation", status: "pass", summary: "Observed live /readyz: the hosted recruiter MCP reported ready." }
      : { name: "live_readyz_observation", status: "fail", summary: "Live /readyz responded but did not report ok:true / status:ready.", details: { observedStatus: isRecord(body) && typeof body.status === "string" ? body.status : null } }];
  } catch {
    return [{ name: "live_readyz_observation", status: "fail", summary: "Live /readyz observation could not reach the hosted recruiter MCP within the timeout." }];
  } finally {
    clearTimeout(timeout);
  }
}

interface LiveVersionObservationInput {
  url: string;
  expectedCommit: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

async function observeLiveVersion(input: LiveVersionObservationInput): Promise<RolloutGateCheck[]> {
  const productionUrl = validateProductionMcpUrl(input.url);
  if (!productionUrl.ok) {
    return [{ name: "live_version_observation", status: "fail", summary: "Live /version URL must be a production HTTPS URL.", details: { reason: productionUrl.reason } }];
  }
  const parsed = new URL(productionUrl.url);
  if (parsed.pathname !== "/version") {
    return [{ name: "live_version_observation", status: "fail", summary: "Live build observation must use the canonical /version path." }];
  }
  if (!/^[0-9a-f]{40}$/i.test(input.expectedCommit)) {
    return [{ name: "live_version_observation", status: "fail", summary: "Live build observation requires the exact pinned 40-character candidate commit." }];
  }
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return [{ name: "live_version_observation", status: "fail", summary: "No fetch implementation is available to observe live /version." }];
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? LIVE_READYZ_DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(productionUrl.url, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (response.url && response.url !== productionUrl.url) {
      return [{ name: "live_version_observation", status: "fail", summary: "Live /version response did not remain on the pinned candidate URL." }];
    }
    if (!response.ok) {
      return [{ name: "live_version_observation", status: "fail", summary: "Live /version did not return a 2xx response from the pinned candidate.", details: { httpStatus: response.status } }];
    }
    const body = await response.json().catch(() => null) as unknown;
    const observedCommit = isRecord(body) && typeof body.commit === "string" && /^[0-9a-f]{40}$/i.test(body.commit)
      ? body.commit.toLowerCase()
      : null;
    const expectedCommit = input.expectedCommit.toLowerCase();
    return [observedCommit === expectedCommit
      ? { name: "live_version_observation", status: "pass", summary: "Observed live /version: the hosted candidate reports the pinned commit.", details: { expectedCommit, observedCommit } }
      : { name: "live_version_observation", status: "fail", summary: "Live /version does not report the pinned candidate commit.", details: { expectedCommit, observedCommit } }];
  } catch {
    return [{ name: "live_version_observation", status: "fail", summary: "Live /version observation could not reach the pinned candidate within the timeout." }];
  } finally {
    clearTimeout(timeout);
  }
}

async function readJson(path: string, label = "JSON evidence file"): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  try {
    return { ok: true, value: JSON.parse(await readFile(path, "utf8")) as unknown };
  } catch {
    return { ok: false, error: `${label} could not be read or parsed.` };
  }
}

async function readText(path: string): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await readFile(path, "utf8") };
  } catch {
    return { ok: false, error: "Text evidence file could not be read." };
  }
}

function parseJsonString(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false };
  }
}

function resolveEvidencePath(baseDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

function validateManifestEvidencePaths(baseDir: string, manifest: RolloutEvidenceManifest): RolloutGateCheck[] {
  const invalidPaths = collectManifestEvidencePaths(manifest)
    .map((entry) => ({ label: entry.label, reason: evidencePathPortabilityIssue(baseDir, entry.path) }))
    .filter((entry): entry is { label: string; reason: string } => entry.reason !== null);

  return [invalidPaths.length === 0
    ? {
      name: "manifest_paths_portable",
      status: "pass",
      summary: "Rollout evidence manifest paths are relative and stay under the manifest directory.",
    }
    : {
      name: "manifest_paths_portable",
      status: "fail",
      summary: "Rollout evidence manifest paths must be relative, stay under the manifest directory, and must not reference checked-in .example artifacts.",
      details: { invalidPaths },
    }];
}

function collectManifestEvidencePaths(manifest: RolloutEvidenceManifest): Array<{ label: string; path: string }> {
  return [
    ...manifest.liveProbes.map((entry, index) => ({ label: `liveProbes[${index}].path`, path: entry.path })),
    ...manifest.distributionValidations.map((entry, index) => ({ label: `distributionValidations[${index}].path`, path: entry.path })),
    { label: "productionEnvEvidence.path", path: manifest.productionEnvEvidence.path },
    ...manifest.revocationDrillEvidence.map((entry, index) => ({ label: `revocationDrillEvidence[${index}].path`, path: entry.path })),
    ...manifest.sessionRevocationEvidence.map((entry, index) => ({ label: `sessionRevocationEvidence[${index}].path`, path: entry.path })),
    ...(manifest.identityBootstrapEvidence ? [{ label: "identityBootstrapEvidence.path", path: manifest.identityBootstrapEvidence.path }] : []),
    { label: "rosterPreflightEvidence.path", path: manifest.rosterPreflightEvidence.path },
    { label: "sessionIssuanceEvidence.path", path: manifest.sessionIssuanceEvidence.path },
    { label: "desktopConfigEvidence.path", path: manifest.desktopConfigEvidence.path },
    { label: "desktopDeliveryEvidence.path", path: manifest.desktopDeliveryEvidence.path },
    ...manifest.desktopUserTests.map((entry, index) => ({ label: `desktopUserTests[${index}].path`, path: entry.path })),
    { label: "leakageSampleEvidence.path", path: manifest.leakageSampleEvidence.path },
    { label: "auditReviewEvidence.path", path: manifest.auditReviewEvidence.path },
  ];
}

function evidencePathPortabilityIssue(baseDir: string, path: string): string | null {
  const trimmed = path.trim();
  if (trimmed.length === 0) return "empty_path";
  if (isAbsolute(trimmed)) return "absolute_path";
  const pathFromBase = relative(baseDir, resolve(baseDir, trimmed));
  if (!pathFromBase) return "path_points_at_manifest_directory";
  if (pathFromBase.startsWith("..") || isAbsolute(pathFromBase)) return "path_escapes_manifest_directory";
  if (/(?:^|[\\/])[^\\/]*\.example(?:\.[^\\/]+)?$/i.test(pathFromBase)) return "example_artifact_ineligible";
  return null;
}

function readManifestPathArg(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if ((arg === "--manifest" || arg === "-m") && args[index + 1]) {
      return args[index + 1];
    }
  }
  return undefined;
}

function isRolloutEvidenceManifest(value: unknown): value is RolloutEvidenceManifest {
  return isRecord(value)
    && value.version === 2
    && isRecord(value.candidate)
    && typeof value.candidate.mcpUrl === "string"
    && typeof value.candidate.commit === "string"
    && Array.isArray(value.liveProbes)
    && value.liveProbes.every(isLiveProbeEvidenceEntry)
    && Array.isArray(value.distributionValidations)
    && value.distributionValidations.every(isClientEvidenceEntry)
    && isRecord(value.productionEnvEvidence)
    && typeof value.productionEnvEvidence.path === "string"
    && Array.isArray(value.revocationDrillEvidence)
    && value.revocationDrillEvidence.every(isClientEvidenceEntry)
    && Array.isArray(value.sessionRevocationEvidence)
    && value.sessionRevocationEvidence.every(isClientEvidenceEntry)
    && (value.identityBootstrapEvidence === undefined || (isRecord(value.identityBootstrapEvidence) && typeof value.identityBootstrapEvidence.path === "string"))
    && isRecord(value.rosterPreflightEvidence)
    && typeof value.rosterPreflightEvidence.path === "string"
    && isRecord(value.sessionIssuanceEvidence)
    && typeof value.sessionIssuanceEvidence.path === "string"
    && isRecord(value.desktopConfigEvidence)
    && typeof value.desktopConfigEvidence.path === "string"
    && isRecord(value.desktopDeliveryEvidence)
    && typeof value.desktopDeliveryEvidence.path === "string"
    && Array.isArray(value.desktopUserTests)
    && value.desktopUserTests.every(isClientEvidenceEntry)
    && isRecord(value.permissionFreshnessEvidence)
    && isRecord(value.leakageSampleEvidence)
    && typeof value.leakageSampleEvidence.path === "string"
    && isRecord(value.auditReviewEvidence)
    && typeof value.auditReviewEvidence.path === "string";
}

function isLiveProbeEvidenceEntry(value: unknown): boolean {
  return isRecord(value)
    && typeof value.path === "string"
    && typeof value.strict === "boolean"
    && (value.profile === "small_req_set"
      || value.profile === "many_req_set"
      || value.profile === "all_jobs_or_operator"
      || value.profile === "no_permissions");
}

function isClientEvidenceEntry(value: unknown): boolean {
  return isRecord(value)
    && typeof value.path === "string"
    && (value.surface === "chatgpt_desktop" || value.surface === "claude_desktop")
    && isRecruiterClient(value.client)
    && isClientSurfaceCompatible(value.client, value.surface);
}

const manifestContainsTokenPayload = containsTokenOrConfigPayload;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startRolloutGateCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[greenhouse-recruiter-rollout-gate] ${message}\n`);
    process.exit(1);
  });
}
