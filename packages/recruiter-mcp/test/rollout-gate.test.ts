import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { observeLiveReadyz, runRolloutGate as runRolloutGateWithClock, runRolloutGateFromEnv } from "../src/rollout-gate.js";
import { RECRUITER_MCP_READINESS_CHECK_NAMES } from "../src/readiness.js";
import { PILOT_TOOL_NAMES } from "../src/tools/register.js";
import { buildClaudeMcpb } from "../src/claude-mcpb.js";
import { DESKTOP_ROUTING_CASES, DESKTOP_USER_TEST_EVIDENCE_WARNING, MIN_ROUTING_RUNS, ROUTING_TEST_VERSION } from "../src/desktop-user-test.js";

type DesktopSurface = "chatgpt_desktop" | "claude_desktop";
type RecruiterClient = "claude_desktop_chat" | "claude_code" | "chatgpt_codex_host";

const RECRUITER_TOOL_NAMES = [...PILOT_TOOL_NAMES];
const EXPECTED_COMMIT = "151dbc3fa5a9099875604bc96dd6882a9f7fcf97";
const FIXED_NOW = () => new Date("2026-06-23T00:00:00.000Z");
const ROUTING_CHECKS = DESKTOP_ROUTING_CASES.map((routingCase) => ({
  caseId: routingCase.caseId,
  runs: Array.from({ length: MIN_ROUTING_RUNS }, (_, index) => ({
    run: index + 1,
    observedTools: validObservedTools(routingCase, index),
    passed: true,
  })),
}));
const ROUTING_TOOLS = [...new Set(ROUTING_CHECKS.flatMap((check) => check.runs.flatMap((run) => run.observedTools)))];

function runRolloutGate(options: Parameters<typeof runRolloutGateWithClock>[0]) {
  return runRolloutGateWithClock({ now: FIXED_NOW, ...options });
}

interface DesktopReportFixture {
  status: "pass";
  surface: DesktopSurface;
  client: RecruiterClient;
  testedAt: string;
  tester: string;
  testerEmail: string;
  mcpUrl: string;
  sessionTokenId: string;
  sessionTokenIdAfterRestart: string;
  sessionIssuedAt: string;
  sessionIssuedAtAfterRestart: string;
  durableSessionAccess: boolean;
  sessionPersistedAcrossRestart: boolean;
  routineReverificationPrompted: boolean;
  attachmentMethod: string;
  exercisedTools: string[];
  writeOrAdminToolsVisible: boolean;
  containsTokens: boolean;
  taskOutcome: "useful" | "not_useful" | "could_not_use";
  taskOutcomeReason: "wrong_scope" | "timeout_error" | "installation_blocked" | "answer_received" | "not_yet_needed";
  clientVersion: string;
  modelVersion: string;
  routingTestVersion: number;
  routingChecks: unknown[];
  resumeInstructionsTreatedAsUntrusted: boolean;
  warning: string;
}

interface RevocationDrillFixture {
  reportVersion: 2;
  ok: boolean;
  status: "pass" | "fail";
  checkedAt: string;
  mcpUrl: string;
  activeSessionSurface: DesktopSurface;
  activeSessionClient: RecruiterClient;
  activeSessionTokenId: string;
  activeSessionIssuedAt: string;
  revokedSessionSurface: DesktopSurface;
  revokedSessionClient: RecruiterClient;
  revokedSessionTokenId: string;
  revokedSessionIssuedAt: string;
  containsTokens: false;
  checks: Array<{ name: string; status: "pass" | "fail"; summary: string }>;
}

interface SessionRevocationFixture {
  ok: boolean;
  revokedAt: string;
  table: string;
  tokenId: string;
  status: "revoked";
  revokedBy: string | null;
  reason: string | null;
  containsTokens: false;
}

interface DesktopDeliveryEntryFixture {
  email: string;
  recipientEmail: string;
  surface: DesktopSurface;
  client: RecruiterClient;
  tokenId: string;
  issuedAt: string;
  configPath: string;
  deliveryChannel: string;
  deliveredToMatchingRecruiter: boolean;
}

interface DesktopDeliveryFixture {
  ok: boolean;
  deliveredAt: string;
  deliveredBy: string;
  deliveryChannel: string;
  containsTokens: false;
  deliveries: DesktopDeliveryEntryFixture[];
}

interface AuditReviewFixture {
  reportVersion: 2;
  ok: boolean;
  status: "pass" | "fail";
  reviewer: string;
  reviewedAt: string;
  auditPath: string;
  totalEvents: number;
  successEvents: number;
  denialEvents: number;
  v2StartEvents: number;
  v2TerminalEvents: number;
  undatedLegacyEvents: number;
  unmatchedV2StartEvents: number;
  legacyUnknownV2TerminalEvents: number;
  surfaces: DesktopSurface[];
  v2Clients: RecruiterClient[];
  toolKinds: Array<"evidence" | "analysis">;
  retainedAuditSink: boolean;
  successEventsPresent: boolean;
  denialEventsPresent: boolean;
  surfaceCoveragePresent: boolean;
  v2ClientCoveragePresent: boolean;
  toolKindCoveragePresent: boolean;
  noSensitivePayloadsFound: boolean;
  checks: unknown[];
}

interface LeakageSampleFixture {
  ok: boolean;
  strict: boolean;
  generatedAt: string;
  surface: "chatgpt_desktop" | "claude_desktop" | "test" | null;
  client: RecruiterClient;
  sessionSubjectPresent: boolean;
  sessionTokenId: string;
  sessionIssuedAt: string;
  actAsUser: number | null;
  checks: Array<{ name: string; status: "pass" | "fail" | "warn" | "skip"; summary: string; details?: Record<string, unknown> }>;
  auditEventCount: number;
  buildCommit: string;
}

describe("rollout evidence gate", () => {
  it("passes only when live probes, remote distribution validation, desktop tests, and freshness evidence are present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);

    const report = await runRolloutGate({
      manifestPath: join(dir, "manifest.json"),
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });

    assert.equal(report.ok, true);
    assert.equal(report.status, "ready");
    assert.equal(report.checks.every((check) => check.status === "pass"), true);
    assert.equal(report.checks.find((check) => check.name === "production_env_preflight")?.status, "pass");
    assert.equal(report.checks.find((check) => check.name === "roster_session_config_consistency")?.status, "pass");
    assert.ok(report.checks.some((check) => check.name === "desktop_chatgpt_codex_host"));
    assert.ok(report.checks.some((check) => check.name === "desktop_claude_desktop_chat"));
    assert.ok(report.checks.some((check) => check.name === "desktop_claude_code"));
  });

  it("fails production env preflight evidence that is not clean env-file readiness output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    await updateJson(join(dir, "production-env-check.json"), (report) => {
      report.source = "process_env";
      report.authorization = "Bearer should-not-appear-in-evidence";
      const checks = report.checks as Array<Record<string, unknown>>;
      checks[0]!.status = "warn";
    });

    const report = await runRolloutGate({
      manifestPath: join(dir, "manifest.json"),
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });
    const envCheck = report.checks.find((check) => check.name === "production_env_preflight");

    assert.equal(report.ok, false);
    assert.equal(envCheck?.status, "fail");
    assert.deepEqual((envCheck?.details?.missing as string[]).includes("envFileSource"), true);
    assert.deepEqual((envCheck?.details?.missing as string[]).includes("allChecksPassing"), true);
    assert.deepEqual((envCheck?.details?.missing as string[]).includes("closedTopLevelShape"), true);
    assert.deepEqual((envCheck?.details?.missing as string[]).includes("reportHasTokenOrConfigPayload"), true);
  });

  it("fails token-free rollout evidence that accidentally includes durable tokens or config payloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    await updateJson(join(dir, "probe-small.json"), (report) => {
      report.authToken = "signed-session-token-must-not-be-in-evidence";
    });
    await updateJson(join(dir, "probe-many.json"), (report) => {
      report.summary = "proxy leaked Authorization: Bearer durable-session-token-value";
    });
    await updateJson(join(dir, "distribution-chatgpt.json"), (report) => {
      report.Authorization = "Bearer signed-session-token-must-not-be-in-evidence";
    });
    await updateJson(join(dir, "desktop-chatgpt.json"), (report) => {
      report.rawConfig = { authorization: "signed-session-token-must-not-be-in-evidence" };
    });
    await updateJson(join(dir, "leakage-sample.json"), (report) => {
      report.token = "signed-session-token-must-not-be-in-evidence";
    });
    await updateJson(join(dir, "audit-review.json"), (report) => {
      report.configPayload = { headers: { Authorization: "Bearer signed-session-token-must-not-be-in-evidence" } };
    });

    const report = await runRolloutGate({
      manifestPath: join(dir, "manifest.json"),
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });
    const checks = new Map(report.checks.map((check) => [check.name, check]));

    assert.equal(report.ok, false);
    assert.equal(checks.get("live_probe_small_req_set_token_free")?.status, "fail");
    assert.equal(checks.get("live_probe_many_req_set_token_free")?.status, "fail");
    assert.equal(checks.get("distribution_chatgpt_codex_host_token_free")?.status, "fail");
    assert.equal(checks.get("desktop_chatgpt_codex_host")?.status, "fail");
    assert.equal(checks.get("desktop_chatgpt_codex_host")?.details?.tokenPayloadPresent, true);
    assert.ok((checks.get("leakage_sample")?.details?.missing as string[]).includes("reportHasTokenOrConfigPayload"));
    assert.ok((checks.get("audit_review")?.details?.missing as string[]).includes("reportHasTokenOrConfigPayload"));
  });

  it("fails before processing evidence when the manifest itself contains token or config payloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    await updateJson(join(dir, "manifest.json"), (manifest) => {
      manifest.authorization = "Bearer must-not-appear";
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    assert.deepEqual(report.checks.map((check) => check.name), ["manifest_shape", "manifest_token_free"]);
    assert.equal(report.checks[1]?.status, "fail");
    assert.doesNotMatch(JSON.stringify(report), /must-not-appear/);
  });

  it("fails before reading evidence when manifest evidence paths are absolute or escape the manifest directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    await updateJson(join(dir, "manifest.json"), (manifest) => {
      const liveProbes = manifest.liveProbes as Array<Record<string, unknown>>;
      const distributionValidations = manifest.distributionValidations as Array<Record<string, unknown>>;
      liveProbes[0]!.path = join(dir, "probe-small.json");
      distributionValidations[0]!.path = "../distribution-chatgpt.json";
    });

    const report = await runRolloutGate({
      manifestPath: join(dir, "manifest.json"),
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });

    const portabilityCheck = report.checks.find((check) => check.name === "manifest_paths_portable");
    assert.equal(report.ok, false);
    assert.equal(portabilityCheck?.status, "fail");
    assert.deepEqual(portabilityCheck?.details?.invalidPaths, [
      { label: "liveProbes[0].path", reason: "absolute_path" },
      { label: "distributionValidations[0].path", reason: "path_escapes_manifest_directory" },
    ]);
    assert.deepEqual(report.checks.map((check) => check.name), ["manifest_shape", "manifest_token_free", "manifest_paths_portable"]);
  });

  it("uses sanitized read-failure summaries for missing manifests and evidence files", async () => {
    const missingManifestReport = await runRolloutGate({ manifestPath: join(tmpdir(), "missing-rollout-manifest.json") });
    const manifestReadable = missingManifestReport.checks.find((check) => check.name === "manifest_readable");

    assert.equal(missingManifestReport.ok, false);
    assert.equal(manifestReadable?.summary, "Rollout evidence manifest could not be read or parsed.");
    assert.doesNotMatch(manifestReadable?.summary ?? "", /ENOENT|no such|missing-rollout-manifest/i);

    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    await updateJson(join(dir, "manifest.json"), (manifest) => {
      const liveProbes = manifest.liveProbes as Array<Record<string, unknown>>;
      liveProbes[0]!.path = "missing-probe.json";
    });

    const evidenceReport = await runRolloutGate({
      manifestPath: join(dir, "manifest.json"),
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });
    const liveProbe = evidenceReport.checks.find((check) => check.name === "live_probe_small_req_set");

    assert.equal(evidenceReport.ok, false);
    assert.equal(liveProbe?.summary, "JSON evidence file could not be read or parsed.");
    assert.doesNotMatch(liveProbe?.summary ?? "", /ENOENT|no such|missing-probe/i);
  });

  it("fails split session and desktop config manifests that contain non-portable paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    await updateJson(join(dir, "issued-sessions", "manifest.json"), (manifest) => {
      const files = manifest.files as Array<Record<string, unknown>>;
      manifest.outputDir = join(dir, "issued-sessions");
      manifest.manifestPath = join(dir, "issued-sessions", "manifest.json");
      files[0]!.path = join(dir, "issued-sessions", "recruiter-claude.json");
    });
    await updateJson(join(dir, "desktop-configs", "manifest.json"), (manifest) => {
      const files = manifest.files as Array<Record<string, unknown>>;
      manifest.outputDir = join(dir, "desktop-configs");
      manifest.manifestPath = "../outside/manifest.json";
      files[0]!.path = join(dir, "desktop-configs", "recruiter-claude.json");
    });

    const report = await runRolloutGate({
      manifestPath: join(dir, "manifest.json"),
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });
    const sessionCheck = report.checks.find((check) => check.name === "session_issuance_manifest");
    const configCheck = report.checks.find((check) => check.name === "desktop_config_manifest");

    assert.equal(report.ok, false);
    assert.equal(sessionCheck?.status, "fail");
    assert.equal(configCheck?.status, "fail");
    assert.deepEqual((sessionCheck?.details?.missing as string[]).includes("portableManifestPaths"), true);
    assert.deepEqual((configCheck?.details?.missing as string[]).includes("portableManifestPaths"), true);
    assert.deepEqual(sessionCheck?.details?.pathProblems, [
      "outputDir:not_portable",
      "manifestPath:absolute_path",
      "claude_desktop:recruiter@example.com:absolute_path",
    ]);
    assert.deepEqual(configCheck?.details?.pathProblems, [
      "outputDir:not_portable",
      "manifestPath:path_escapes_manifest_directory",
      "claude_desktop:recruiter@example.com:absolute_path",
    ]);
  });

  it("validates optional identity bootstrap evidence against roster preflight", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    await writeIdentityBootstrapEvidence(dir);
    await updateJson(join(dir, "manifest.json"), (manifest) => {
      manifest.identityBootstrapEvidence = { path: "identity-bootstrap-plan.json" };
    });

    const report = await runRolloutGate({
      manifestPath: join(dir, "manifest.json"),
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });

    assert.equal(report.ok, true);
    assert.equal(report.checks.find((check) => check.name === "identity_bootstrap")?.status, "pass");
  });

  it("fails optional identity bootstrap evidence with denied rows or roster mismatches", async () => {
    const deniedDir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(deniedDir);
    await writeIdentityBootstrapEvidence(deniedDir, {
      ok: false,
      canApply: false,
      denied: [{ email: "missing@example.com", status: "email_missing", reason: "No Greenhouse user record matched this work email." }],
    });
    await updateJson(join(deniedDir, "manifest.json"), (manifest) => {
      manifest.identityBootstrapEvidence = { path: "identity-bootstrap-plan.json" };
    });

    const deniedReport = await runRolloutGate({ manifestPath: join(deniedDir, "manifest.json") });

    assert.equal(deniedReport.ok, false);
    const deniedCheck = deniedReport.checks.find((check) => check.name === "identity_bootstrap");
    assert.equal(deniedCheck?.status, "fail");
    assert.deepEqual((deniedCheck?.details?.missing as string[]).includes("noDeniedRows"), true);

    const mismatchDir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(mismatchDir);
    await writeIdentityBootstrapEvidence(mismatchDir, {
      resolved: [{
        email: "recruiter@example.com",
        greenhouseUserId: 999,
        row: {
          greenhouse_user_id: 999,
          primary_email: "recruiter@example.com",
          google_subject: null,
          slack_user_id: null,
          status: "resolved",
          source: "greenhouse_users_roster_bootstrap",
          evidence_detail: { source: "greenhouse_users_roster_bootstrap", matched_by: "work_email", matched_greenhouse_emails: ["recruiter@example.com"] },
          last_verified_at: "2026-06-23T00:00:00.000Z",
        },
      }],
    });
    await updateJson(join(mismatchDir, "manifest.json"), (manifest) => {
      manifest.identityBootstrapEvidence = { path: "identity-bootstrap-plan.json" };
    });

    const mismatchReport = await runRolloutGate({ manifestPath: join(mismatchDir, "manifest.json") });
    const mismatchCheck = mismatchReport.checks.find((check) => check.name === "identity_bootstrap");

    assert.equal(mismatchReport.ok, false);
    assert.equal(mismatchCheck?.status, "fail");
    assert.deepEqual((mismatchCheck?.details?.missing as string[]).includes("bootstrapGreenhouseIdsMatchPreflight"), true);
  });

  it("fails roster and identity bootstrap evidence with unsafe Greenhouse user ids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    const unsafeGreenhouseUserId = Number.MAX_SAFE_INTEGER + 1;
    await writeCompleteEvidence(dir, {
      rosterPreflightOverrides: {
        resolved: [
          {
            email: "recruiter@example.com",
            subject: "email:recruiter@example.com",
            greenhouseUserId: unsafeGreenhouseUserId,
            surfaces: ["claude_desktop", "chatgpt_desktop"],
          },
        ],
      },
    });
    await writeIdentityBootstrapEvidence(dir, {
      resolved: [
        {
          email: "recruiter@example.com",
          greenhouseUserId: unsafeGreenhouseUserId,
          row: {
            greenhouse_user_id: unsafeGreenhouseUserId,
            primary_email: "recruiter@example.com",
            google_subject: null,
            slack_user_id: null,
            status: "resolved",
            source: "greenhouse_users_roster_bootstrap",
            evidence_detail: { source: "greenhouse_users_roster_bootstrap", matched_by: "work_email", matched_greenhouse_emails: ["recruiter@example.com"] },
            last_verified_at: "2026-06-23T00:00:00.000Z",
          },
        },
      ],
    });
    await updateJson(join(dir, "manifest.json"), (manifest) => {
      manifest.identityBootstrapEvidence = { path: "identity-bootstrap-plan.json" };
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });
    const rosterCheck = report.checks.find((check) => check.name === "roster_preflight");
    const bootstrapCheck = report.checks.find((check) => check.name === "identity_bootstrap");

    assert.equal(report.ok, false);
    assert.equal(rosterCheck?.status, "fail");
    assert.equal((rosterCheck?.details?.missing as string[]).includes("validResolvedRows"), true);
    assert.equal(bootstrapCheck?.status, "fail");
    assert.equal((bootstrapCheck?.details?.missing as string[]).includes("validResolvedRows"), true);
  });

  it("fails when required live probe profiles and desktop surfaces are missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeJson(join(dir, "probe-small.json"), probeReport({ strict: true, rowsReturned: 2 }));
    await writeJson(join(dir, "distribution-chatgpt.json"), distributionReport("chatgpt_codex_host"));
    await writeProductionEnvEvidence(dir);
    await writeJson(join(dir, "revocation-drill.json"), revocationDrill());
    await writeRosterPreflightEvidence(dir);
    await writeSessionIssuanceEvidence(dir);
    await writeDesktopConfigEvidence(dir);
    await writeDesktopDeliveryEvidence(dir);
    await writeJson(join(dir, "desktop-chatgpt.json"), desktopReport("chatgpt_codex_host"));
    await writeJson(join(dir, "leakage-sample.json"), leakageSample());
    await writeJson(join(dir, "audit-review.json"), auditReview());
    await writeJson(join(dir, "manifest.json"), {
      version: 2,
      candidate: { mcpUrl: "https://greenhouse-recruiter.example.com/mcp", commit: EXPECTED_COMMIT },
      liveProbes: [{ profile: "small_req_set", path: "probe-small.json", strict: true }],
      distributionValidations: [{ surface: "chatgpt_desktop", client: "chatgpt_codex_host", path: "distribution-chatgpt.json" }],
      productionEnvEvidence: { path: "production-env-check.json" },
      revocationDrillEvidence: [{ surface: "chatgpt_desktop", client: "chatgpt_codex_host", path: "revocation-drill.json" }],
      sessionRevocationEvidence: [{ surface: "chatgpt_desktop", client: "chatgpt_codex_host", path: "session-revocation.json" }],
      rosterPreflightEvidence: { path: "roster-preflight.json" },
      sessionIssuanceEvidence: { path: "issued-sessions/manifest.json" },
      desktopConfigEvidence: { path: "desktop-config-manifest.json" },
      desktopDeliveryEvidence: { path: "desktop-delivery.json" },
      desktopUserTests: [{ surface: "chatgpt_desktop", client: "chatgpt_codex_host", path: "desktop-chatgpt.json" }],
      permissionFreshnessEvidence: {
        removedReqDisappearedOnNextRead: true,
        addedReqAppearedWithoutDeploy: false,
        privateNotesDropped: true,
        scopedVsUnscopedLeakageSamplePassed: true,
        durableAccessTestedWithoutRoutineReverification: true,
      },
      leakageSampleEvidence: { path: "leakage-sample.json" },
      auditReviewEvidence: { path: "audit-review.json" },
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    assert.equal(report.status, "not_ready");
    assert.equal(report.checks.find((check) => check.name === "live_probe_manifest")?.status, "fail");
    assert.equal(report.checks.find((check) => check.name === "distribution_validation_manifest")?.status, "fail");
    assert.equal(report.checks.find((check) => check.name === "desktop_user_test_manifest")?.status, "fail");
    assert.equal(report.checks.find((check) => check.name === "permission_freshness_and_leakage")?.status, "fail");
  });

  it("requires distinct rollout evidence for all three physical clients", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-clients-"));
    await writeCompleteEvidence(dir);
    await updateJson(join(dir, "manifest.json"), (manifest) => {
      manifest.distributionValidations = (manifest.distributionValidations as Array<Record<string, unknown>>)
        .filter((entry) => entry.client !== "claude_code");
      manifest.desktopUserTests = (manifest.desktopUserTests as Array<Record<string, unknown>>)
        .filter((entry) => entry.client !== "claude_code");
      manifest.revocationDrillEvidence = (manifest.revocationDrillEvidence as Array<Record<string, unknown>>)
        .filter((entry) => entry.client !== "claude_code");
      manifest.sessionRevocationEvidence = (manifest.sessionRevocationEvidence as Array<Record<string, unknown>>)
        .filter((entry) => entry.client !== "claude_code");
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });
    const distribution = report.checks.find((check) => check.name === "distribution_validation_manifest");
    const desktop = report.checks.find((check) => check.name === "desktop_user_test_manifest");
    const revocation = report.checks.find((check) => check.name === "revocation_drill_manifest");
    const revocationWrite = report.checks.find((check) => check.name === "session_revocation_manifest");

    assert.equal(report.ok, false);
    assert.deepEqual(distribution?.details?.missing, ["claude_desktop:claude_code"]);
    assert.deepEqual(desktop?.details?.missing, ["claude_desktop:claude_code"]);
    assert.deepEqual(revocation?.details?.missing, ["claude_desktop:claude_code"]);
    assert.deepEqual(revocationWrite?.details?.missing, ["claude_desktop:claude_code"]);
  });

  it("rejects revocation drill evidence attributed to the other Claude physical client", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-revocation-client-"));
    await writeCompleteEvidence(dir);
    await updateJson(join(dir, "revocation-drill-claude-code.json"), (report) => {
      report.activeSessionClient = "claude_desktop_chat";
      report.revokedSessionClient = "claude_desktop_chat";
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });
    const check = report.checks.find((entry) => entry.name === "revocation_drill_claude_code");

    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.missing, ["activeSessionClientMatchesManifest", "revokedSessionClientMatchesManifest"]);
  });

  it("requires a distinct revoked token id for each physical client drill", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-revocation-distinct-"));
    await writeCompleteEvidence(dir);
    await updateJson(join(dir, "revocation-drill-claude-code.json"), (report) => {
      report.revokedSessionTokenId = "revoked-claude_desktop_chat-token-id";
    });
    await updateJson(join(dir, "session-revocation-claude-code.json"), (report) => {
      report.tokenId = "revoked-claude_desktop_chat-token-id";
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });
    const check = report.checks.find((entry) => entry.name === "revocation_distinct_client_tokens");

    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.duplicateTokenIds, ["revoked-claude_desktop_chat-token-id"]);
  });

  it("rejects a distribution report attributed to a different physical client", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-client-attribution-"));
    await writeCompleteEvidence(dir);
    await updateJson(join(dir, "distribution-claude-code.json"), (report) => {
      report.sessionClient = "claude_desktop_chat";
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });
    const check = report.checks.find((entry) => entry.name === "distribution_claude_code_session_client");

    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details, {
      expectedClient: "claude_code",
      sessionClient: "claude_desktop_chat",
    });
  });

  it("fails no-permissions evidence unless the probe proves zero visible jobs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, { noPermissionsRowsReturned: 1 });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    assert.equal(report.checks.find((check) => check.name === "live_probe_no_permissions_zero_data")?.status, "fail");
  });

  it("fails no-permissions evidence when any scoped data domain reports rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-zero-domain-"));
    await writeCompleteEvidence(dir);
    await updateJson(join(dir, "probe-none.json"), (probe) => {
      const checks = probe.checks as Array<Record<string, unknown>>;
      const notes = checks.find((check) => check.name === "notes_visibility_sample")!;
      notes.details = { ...(notes.details as Record<string, unknown>), rowsReturned: 1 };
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });
    const check = report.checks.find((entry) => entry.name === "live_probe_no_permissions_zero_data");
    assert.equal(check?.status, "fail");
    assert.ok((check?.details?.problems as string[]).includes("notes_visibility_sample.rowsReturned:nonzero"));
  });

  it("accepts repeated expected and forbidden-id checks while rejecting weakened strictness or mixed scopes", async () => {
    const repeatedDir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-repeatable-probe-"));
    await writeCompleteEvidence(repeatedDir);
    await updateJson(join(repeatedDir, "probe-small.json"), (probe) => {
      const checks = probe.checks as Array<Record<string, unknown>>;
      for (const name of ["expected_job_visibility", "forbidden_job_exclusion", "endpoint_contract_forbidden_jobs_ids"]) {
        const existing = checks.find((check) => check.name === name)!;
        checks.push({ ...existing, summary: `${String(existing.summary)} second id` });
      }
    });
    const repeated = await runRolloutGate({ manifestPath: join(repeatedDir, "manifest.json") });
    assert.equal(repeated.checks.find((entry) => entry.name === "live_probe_small_req_set_required_checks")?.status, "pass");

    const weakenedDir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-weakened-probe-"));
    await writeCompleteEvidence(weakenedDir);
    await updateJson(join(weakenedDir, "manifest.json"), (manifest) => {
      const probes = manifest.liveProbes as Array<Record<string, unknown>>;
      probes.find((probe) => probe.profile === "small_req_set")!.strict = false;
    });
    await updateJson(join(weakenedDir, "probe-small.json"), (probe) => {
      const checks = probe.checks as Array<Record<string, unknown>>;
      const stage = checks.find((check) => check.name === "stage_latency_analysis")!;
      stage.details = { ...(stage.details as Record<string, unknown>), permissionScopeKind: "operator", permittedJobCount: null, scoped: false };
    });
    const weakened = await runRolloutGate({ manifestPath: join(weakenedDir, "manifest.json") });
    assert.equal(weakened.checks.find((entry) => entry.name === "live_probe_small_req_set_strict")?.status, "fail");
    assert.equal(weakened.checks.find((entry) => entry.name === "live_probe_small_req_set_scope_consistency")?.status, "fail");
  });

  it("fails permission freshness evidence that has booleans but no concrete samples", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
    manifest.permissionFreshnessEvidence = {
      removedReqDisappearedOnNextRead: true,
      addedReqAppearedWithoutDeploy: true,
      privateNotesDropped: true,
      scopedVsUnscopedLeakageSamplePassed: true,
      durableAccessTestedWithoutRoutineReverification: true,
    };
    await writeJson(join(dir, "manifest.json"), manifest);

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "permission_freshness_and_leakage");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.missing, [
      "verifiedAt",
      "verifiedBy",
      "removedReqId",
      "removedReqRowsBeforeRemoval",
      "removedReqRowsAfterRemoval",
      "addedReqId",
      "addedReqRowsBeforeAddition",
      "addedReqRowsAfterAddition",
      "privateNoteId",
      "privateNoteRowsReturnedAfterScope",
      "durableSessionEmail",
      "durableSessionSurface",
      "durableSessionTokenId",
      "durableSessionTokenIdAfterRestart",
      "durableSessionIssuedAt",
      "durableSessionIssuedAtAfterRestart",
      "routineReverificationPrompted",
    ]);
  });

  it("fails permission freshness evidence with stale before-after counts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
    manifest.permissionFreshnessEvidence.removedReqRowsAfterRemoval = 1;
    manifest.permissionFreshnessEvidence.addedReqRowsBeforeAddition = 1;
    manifest.permissionFreshnessEvidence.privateNoteRowsReturnedAfterScope = 1;
    manifest.permissionFreshnessEvidence.durableSessionTokenIdAfterRestart = "new-token-id";
    manifest.permissionFreshnessEvidence.durableSessionIssuedAtAfterRestart = "2026-06-24T00:00:00.000Z";
    manifest.permissionFreshnessEvidence.routineReverificationPrompted = true;
    await writeJson(join(dir, "manifest.json"), manifest);

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "permission_freshness_and_leakage");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.missing, [
      "removedReqRowsAfterRemoval",
      "addedReqRowsBeforeAddition",
      "privateNoteRowsReturnedAfterScope",
      "durableSessionTokenIdAfterRestart",
      "durableSessionIssuedAtAfterRestart",
      "routineReverificationPrompted",
    ]);
  });

  it("fails permission freshness evidence whose verification timestamp is too old for final rollout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
    manifest.permissionFreshnessEvidence.verifiedAt = "2026-06-01T00:00:00.000Z";
    await writeJson(join(dir, "manifest.json"), manifest);

    const report = await runRolloutGate({
      manifestPath: join(dir, "manifest.json"),
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "permission_freshness_and_leakage");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.missing, ["verifiedAtFreshness"]);
    assert.equal(check?.details?.maxVerifiedAtAgeDays, 14);
  });

  it("fails dynamic rollout evidence whose artifact timestamps are too old for final rollout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    const staleTimestamp = "2026-06-01T00:00:00.000Z";

    await updateJson(join(dir, "probe-small.json"), (value) => { value.generatedAt = staleTimestamp; });
    await updateJson(join(dir, "distribution-chatgpt.json"), (value) => { value.checkedAt = staleTimestamp; });
    await updateJson(join(dir, "revocation-drill-chatgpt.json"), (value) => { value.checkedAt = staleTimestamp; });
    await updateJson(join(dir, "session-revocation-chatgpt.json"), (value) => { value.revokedAt = staleTimestamp; });
    await updateJson(join(dir, "desktop-delivery.json"), (value) => { value.deliveredAt = staleTimestamp; });
    await updateJson(join(dir, "desktop-chatgpt.json"), (value) => { value.testedAt = staleTimestamp; });
    await updateJson(join(dir, "leakage-sample.json"), (value) => { value.generatedAt = staleTimestamp; });
    await updateJson(join(dir, "audit-review.json"), (value) => { value.reviewedAt = staleTimestamp; });

    const report = await runRolloutGate({
      manifestPath: join(dir, "manifest.json"),
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });

    assert.equal(report.ok, false);
    const checks = new Map(report.checks.map((check) => [check.name, check]));
    assert.equal(checks.get("live_probe_small_req_set_freshness")?.status, "fail");
    assert.equal(checks.get("distribution_chatgpt_codex_host_freshness")?.status, "fail");

    const revocationMissing = checks.get("revocation_drill_chatgpt_codex_host")?.details?.missing;
    assert.ok(Array.isArray(revocationMissing));
    assert.ok(revocationMissing.includes("checkedAtFreshness"));

    const sessionRevocationMissing = checks.get("session_revocation_write_chatgpt_codex_host")?.details?.missing;
    assert.ok(Array.isArray(sessionRevocationMissing));
    assert.ok(sessionRevocationMissing.includes("revokedAtFreshness"));

    const deliveryMissing = checks.get("desktop_config_delivery")?.details?.missing;
    assert.ok(Array.isArray(deliveryMissing));
    assert.ok(deliveryMissing.includes("deliveredAtFreshness"));

    const desktop = checks.get("desktop_chatgpt_codex_host");
    assert.equal(desktop?.status, "fail");
    assert.equal(desktop?.details?.testedAtFresh, false);

    const leakageMissing = checks.get("leakage_sample")?.details?.missing;
    assert.ok(Array.isArray(leakageMissing));
    assert.ok(leakageMissing.includes("generatedAtFreshness"));

    const auditMissing = checks.get("audit_review")?.details?.missing;
    assert.ok(Array.isArray(auditMissing));
    assert.ok(auditMissing.includes("reviewedAtFreshness"));
  });

  it("fails permission freshness durable-access evidence whose token is outside the issued desktop rollout set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
    manifest.permissionFreshnessEvidence.durableSessionTokenId = "outside-durable-token-id";
    manifest.permissionFreshnessEvidence.durableSessionTokenIdAfterRestart = "outside-durable-token-id";
    await writeJson(join(dir, "manifest.json"), manifest);

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "permission_freshness_and_leakage");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.missing, ["durableSessionIssuedTokenBinding"]);
    assert.deepEqual(check?.details?.durableSessionBindingMissing, ["durableSessionIssuanceTokenId", "durableDesktopConfigTokenId"]);
  });

  it("fails permission freshness durable-access evidence whose email or surface is outside the issued desktop rollout set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
    manifest.permissionFreshnessEvidence.durableSessionEmail = "other@example.com";
    await writeJson(join(dir, "manifest.json"), manifest);

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "permission_freshness_and_leakage");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.missing, ["durableSessionIssuedTokenBinding"]);
    assert.deepEqual(check?.details?.durableSessionBindingMissing, ["durableSessionIssuanceEmailSurface", "durableDesktopConfigEmailSurface"]);
  });

  it("fails stale live probe evidence that omits the activity scoping decision", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    const staleProbe = probeReport({ strict: true, rowsReturned: 2 });
    staleProbe.checks = staleProbe.checks.filter((check) => check.name !== "activity_endpoint_shape");
    await writeJson(join(dir, "probe-small.json"), staleProbe);

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "live_probe_small_req_set_activity_scope");
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /activity scoping decision/);
  });

  it("fails live probe evidence that omits required evidence or analysis probe checks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    const staleProbe = probeReport({ strict: true, rowsReturned: 2 });
    staleProbe.checks = staleProbe.checks.filter((check) => check.name !== "rejection_reason_drift_analysis");
    await writeJson(join(dir, "probe-small.json"), staleProbe);

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "live_probe_small_req_set_required_checks");
    assert.equal(check?.status, "fail");
    assert.ok((check?.details?.problems as string[]).includes("rejection_reason_drift_analysis:missing"));
  });

  it("fails live probe evidence when activity scoping is neither skipped nor validated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    const staleProbe = probeReport({ strict: true, rowsReturned: 2 });
    const activityCheck = staleProbe.checks.find((check) => check.name === "activity_endpoint_shape");
    assert.ok(activityCheck);
    activityCheck.status = "warn";
    activityCheck.summary = "activity shape has not been resolved";
    await writeJson(join(dir, "probe-small.json"), staleProbe);

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "live_probe_small_req_set_activity_scope");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details, { status: "warn" });
  });

  it("fails when revocation drill evidence does not prove revoked-token denial", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, {
      revocationDrillOverrides: {
        ok: false,
        status: "fail",
        checks: [
          { name: "active_token_metadata", status: "pass", summary: "active" },
          { name: "revoked_token_metadata", status: "pass", summary: "revoked" },
          { name: "matching_client_identity", status: "pass", summary: "matching client" },
          { name: "distinct_token_ids", status: "pass", summary: "distinct" },
          { name: "active_initialize", status: "pass", summary: "active init" },
          { name: "revoked_initialize_denied", status: "fail", summary: "revoked token initialized" },
        ],
      },
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "revocation_drill_chatgpt_codex_host");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.failedChecks, ["revoked_initialize_denied"]);
  });

  it("fails revocation drill evidence whose active token is outside the issued desktop rollout set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, {
      revocationDrillOverrides: {
        activeSessionTokenId: "outside-active-token-id",
      },
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "revocation_drill_chatgpt_codex_host");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.missing, ["activeSessionIssuedTokenBinding"]);
    assert.deepEqual(check?.details?.activeTokenBindingMissing, ["activeSessionIssuanceTokenId", "activeDesktopConfigTokenId"]);
  });

  it("fails revocation drill evidence that omits durable issued-at metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, {
      revocationDrillOverrides: {
        activeSessionIssuedAt: "",
        revokedSessionIssuedAt: "not-a-date",
      },
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "revocation_drill_chatgpt_codex_host");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.missing, ["activeSessionIssuedAt", "revokedSessionIssuedAt"]);
  });

  it("fails when session revocation write evidence does not match the revoked drill token id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, {
      sessionRevocationOverrides: { tokenId: "different-revoked-token-id" },
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "session_revocation_write_chatgpt_codex_host");
    assert.equal(check?.status, "fail");
    assert.ok(Array.isArray(check?.details?.missing));
    assert.ok((check?.details?.missing as string[]).includes("revokedTokenIdMatchesDrill"));
  });

  it("fails when session revocation write evidence lacks operator accountability", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, {
      sessionRevocationOverrides: { revokedBy: null, reason: null },
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "session_revocation_write_chatgpt_codex_host");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.missing, ["revokedBy", "reason"]);
  });

  it("fails desktop evidence that requires recurring verification or does not survive restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, {
      desktopOverrides: {
        chatgpt_desktop: { routineReverificationPrompted: true },
        claude_desktop: { sessionPersistedAcrossRestart: false },
      },
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    assert.equal(report.checks.find((check) => check.name === "desktop_chatgpt_codex_host")?.status, "fail");
    assert.equal(report.checks.find((check) => check.name === "desktop_claude_desktop_chat")?.status, "fail");
  });

  it("fails desktop evidence that does not exercise both evidence and analysis tools", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, {
      desktopOverrides: {
        chatgpt_desktop: { exercisedTools: ["analyze_scorecard_accountability"] },
        claude_desktop: { exercisedTools: ["search_my_jobs"] },
      },
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const chatgpt = report.checks.find((check) => check.name === "desktop_chatgpt_codex_host");
    const claude = report.checks.find((check) => check.name === "desktop_claude_desktop_chat");
    assert.equal(chatgpt?.status, "fail");
    assert.equal(chatgpt?.details?.missingEvidence, true);
    assert.equal(chatgpt?.details?.missingAnalysis, false);
    assert.equal(claude?.status, "fail");
    assert.equal(claude?.details?.missingEvidence, false);
    assert.equal(claude?.details?.missingAnalysis, true);
  });

  it("fails desktop evidence without client attribution and a valid task outcome pair", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, {
      desktopOverrides: {
        chatgpt_desktop: { client: undefined as never, taskOutcome: undefined as never },
        claude_desktop: { taskOutcomeReason: "unsupported_reason" as never },
      },
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const chatgpt = report.checks.find((check) => check.name === "desktop_chatgpt_codex_host");
    const claude = report.checks.find((check) => check.name === "desktop_claude_desktop_chat");
    assert.equal(chatgpt?.status, "fail");
    assert.equal(chatgpt?.details?.clientMatchesSurface, false);
    assert.equal(chatgpt?.details?.taskOutcomeValid, false);
    assert.equal(claude?.status, "fail");
    assert.equal(claude?.details?.taskOutcomeReasonValid, false);
  });

  it("keeps rollout blocked when a supported physical client could not produce a useful answer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, {
      desktopOverrides: {
        chatgpt_desktop: { taskOutcome: "could_not_use", taskOutcomeReason: "installation_blocked" },
        claude_desktop: { taskOutcome: "not_useful", taskOutcomeReason: "wrong_scope" },
      },
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    for (const name of ["desktop_chatgpt_codex_host", "desktop_claude_desktop_chat"]) {
      const check = report.checks.find((entry) => entry.name === name);
      assert.equal(check?.status, "fail");
      assert.equal(check?.details?.taskOutcomeSuccessful, false);
    }
  });

  it("fails closed on stale, incomplete, unsafe, or injected routing attestations", async () => {
    const cases: Array<{ name: string; expectedProblem: string; mutate: (report: Record<string, unknown>) => void }> = [
      {
        name: "legacy-missing",
        expectedProblem: "routing_test_version_mismatch",
        mutate(report) { report.routingTestVersion = 1; report.routingChecks = []; },
      },
      {
        name: "duplicate-case",
        expectedProblem: "routing_case_duplicate:",
        mutate(report) {
          const checks = report.routingChecks as unknown[];
          checks.push(structuredClone(checks[0]));
        },
      },
      {
        name: "missing-run",
        expectedProblem: "routing_runs_missing:",
        mutate(report) {
          const checks = report.routingChecks as Array<{ runs: unknown[] }>;
          checks[0]!.runs = checks[0]!.runs.slice(1);
        },
      },
      {
        name: "hidden-disallowed-tool",
        expectedProblem: "observed disallowed tool(s)",
        mutate(report) {
          const checks = report.routingChecks as Array<{ caseId: string; runs: Array<{ observedTools: string[] }> }>;
          checks.find((check) => check.caseId === "list_candidate_files")!.runs[0]!.observedTools = ["search_my_job_notes"];
        },
      },
      {
        name: "wrong-required-count",
        expectedProblem: "requires read_my_resume at least 2 time(s)",
        mutate(report) {
          const checks = report.routingChecks as Array<{ caseId: string; runs: Array<{ observedTools: string[] }> }>;
          const run = checks.find((check) => check.caseId === "compare_resumes_to_job")!.runs[0]!;
          run.observedTools = run.observedTools.filter((tool, index) => tool !== "read_my_resume" || index === run.observedTools.indexOf(tool));
        },
      },
      {
        name: "prompt-field-injection",
        expectedProblem: "routing_attestation_contains_prompt_response_or_ats_data",
        mutate(report) { report.prompts = ["must not be retained"]; },
      },
      {
        name: "nested-content-wrapper",
        expectedProblem: "routing_attestation_unknown_fields:metadata",
        mutate(report) { report.metadata = { prompt: "must not be retained", resumeText: "must not be retained" }; },
      },
    ];

    for (const testCase of cases) {
      const dir = await mkdtemp(join(tmpdir(), `greenhouse-rollout-routing-${testCase.name}-`));
      await writeCompleteEvidence(dir);
      const desktop = structuredClone(desktopReport("chatgpt_codex_host")) as unknown as Record<string, unknown>;
      testCase.mutate(desktop);
      await writeJson(join(dir, "desktop-chatgpt.json"), desktop);

      const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });
      const check = report.checks.find((entry) => entry.name === "desktop_chatgpt_codex_host");
      const routingProblems = check?.details?.routingProblems as string[];

      assert.equal(report.ok, false, testCase.name);
      assert.equal(check?.status, "fail", testCase.name);
      assert.equal(routingProblems.some((problem) => problem.includes(testCase.expectedProblem)), true, `${testCase.name}: ${routingProblems.join(" | ")}`);
    }
  });

  it("binds each real-client attestation to the same MCP URL as its config and distribution evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-endpoint-binding-"));
    await writeCompleteEvidence(dir);
    await updateJson(join(dir, "desktop-chatgpt.json"), (report) => {
      report.mcpUrl = "https://old-greenhouse-recruiter.example.com/mcp";
    });
    await updateJson(join(dir, "distribution-claude-code.json"), (report) => {
      report.mcpUrl = "https://other-greenhouse-recruiter.example.com/mcp";
    });
    await updateJson(join(dir, "desktop-configs/recruiter-claude.json"), (config) => {
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      servers["greenhouse-recruiter"]!.url = "https://config-greenhouse-recruiter.example.com/mcp";
    });

    const report = await runRolloutGate({
      manifestPath: join(dir, "manifest.json"),
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });

    const chatgpt = report.checks.find((check) => check.name === "desktop_chatgpt_codex_host");
    const claudeCode = report.checks.find((check) => check.name === "desktop_claude_code");
    const claudeDesktop = report.checks.find((check) => check.name === "desktop_claude_desktop_chat");
    assert.equal(chatgpt?.status, "fail");
    assert.equal(claudeCode?.status, "fail");
    assert.equal(claudeDesktop?.status, "fail");
    assert.ok((chatgpt?.details?.endpointBindingMissing as string[]).includes("attestedMcpUrlMatchesDesktopConfig"));
    assert.ok((claudeCode?.details?.endpointBindingMissing as string[]).includes("attestedMcpUrlMatchesDistribution"));
    assert.ok((claudeDesktop?.details?.endpointBindingMissing as string[]).includes("desktopConfigMcpUrlMatchesDistribution"));
  });

  it("fails final rollout evidence that uses localhost MCP URLs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, {
      desktopOverrides: {
        chatgpt_desktop: { mcpUrl: "http://127.0.0.1:3333/mcp" },
      },
    });
    await writeJson(join(dir, "distribution-chatgpt.json"), {
      ...distributionReport("chatgpt_codex_host"),
      mcpUrl: "http://127.0.0.1:3333/mcp",
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    assert.equal(report.checks.find((check) => check.name === "distribution_chatgpt_codex_host")?.status, "pass");
    const distributionUrl = report.checks.find((check) => check.name === "distribution_chatgpt_codex_host_production_url");
    assert.equal(distributionUrl?.status, "fail");
    assert.equal(distributionUrl?.details?.reason, "not_https");
    const desktop = report.checks.find((check) => check.name === "desktop_chatgpt_codex_host");
    assert.equal(desktop?.status, "fail");
    assert.equal(desktop?.details?.mcpUrlReason, "not_https");
  });

  it("fails distribution evidence generated with the wrong desktop surface token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    await writeJson(join(dir, "distribution-claude.json"), distributionReport("chatgpt_codex_host"));

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "distribution_claude_desktop_chat_session_surface");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details, {
      expectedSurface: "claude_desktop",
      sessionSurface: "chatgpt_desktop",
    });
  });

  it("fails distribution evidence generated with a token outside the issued rollout files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    await writeJson(join(dir, "distribution-chatgpt.json"), distributionReport("chatgpt_codex_host", "outside-token-id"));

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "distribution_chatgpt_codex_host_issued_token");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details, {
      tokenId: "outside-token-id",
      issuedAt: "2026-06-23T00:00:00.000Z",
      missing: ["sessionIssuanceTokenId", "desktopConfigTokenId"],
    });
  });

  it("fails distribution evidence with non-exact durable session token metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    await writeJson(join(dir, "distribution-chatgpt.json"), distributionReport("chatgpt_codex_host", " chatgpt-token-id"));

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "distribution_chatgpt_codex_host_issued_token");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details, {
      tokenId: " chatgpt-token-id",
      issuedAt: "2026-06-23T00:00:00.000Z",
      missing: ["distributionSessionTokenId"],
    });
  });

  it("fails distribution evidence generated with the wrong issued-at timestamp", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    await writeJson(join(dir, "distribution-chatgpt.json"), distributionReport("chatgpt_codex_host", "chatgpt-token-id", "2026-06-24T00:00:00.000Z"));

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "distribution_chatgpt_codex_host_issued_token");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details, {
      tokenId: "chatgpt-token-id",
      issuedAt: "2026-06-24T00:00:00.000Z",
      missing: ["sessionIssuanceIssuedAt", "desktopConfigIssuedAt"],
    });
  });

  it("fails stale distribution evidence that lacks exact catalog validator checks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    const staleReport = distributionReport("chatgpt_codex_host");
    await writeJson(join(dir, "distribution-chatgpt.json"), {
      ...staleReport,
      checks: staleReport.checks.filter((check) => check.name !== "no_unexpected_tools"),
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "distribution_chatgpt_codex_host_validator_checks");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.missingRequiredChecks, ["no_unexpected_tools"]);
  });

  it("re-derives candidate commit binding instead of trusting a passing version label", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    const staleReport = distributionReport("chatgpt_codex_host");
    await writeJson(join(dir, "distribution-chatgpt.json"), {
      ...staleReport,
      observedCommit: "0000000000000000000000000000000000000000",
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "distribution_chatgpt_codex_host_version_commit");
    assert.equal(check?.status, "fail");
    assert.equal(check?.details?.reason, "observed_commit_mismatch");
  });

  it("binds every report to the manifest-owned candidate URL and commit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-candidate-binding-"));
    await writeCompleteEvidence(dir);
    await updateJson(join(dir, "manifest.json"), (manifest) => {
      manifest.candidate = {
        mcpUrl: "https://other-candidate.example.com/mcp",
        commit: "0000000000000000000000000000000000000000",
      };
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });
    const check = report.checks.find((entry) => entry.name === "candidate_release_binding");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.ok((check?.details?.problems as string[]).some((problem) => problem.startsWith("candidate_url_mismatch:")));
    assert.ok((check?.details?.problems as string[]).some((problem) => problem.startsWith("candidate_commit_mismatch:")));
  });

  it("binds every generated desktop config to the manifest-owned candidate URL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-config-binding-"));
    await writeCompleteEvidence(dir);
    await updateJson(join(dir, "desktop-configs", "recruiter-chatgpt.json"), (config) => {
      config.server_url = "https://other-candidate.example.com/mcp";
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });
    const check = report.checks.find((entry) => entry.name === "desktop_config_candidate_binding");
    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.ok((check?.details?.problems as string[]).includes("candidate_url_mismatch:2"));
  });

  it("requires candidate-bound production-session probe and leakage evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-live-binding-"));
    await writeCompleteEvidence(dir);
    await updateJson(join(dir, "probe-small.json"), (probe) => {
      probe.buildCommit = "0000000000000000000000000000000000000000";
      probe.surface = "test";
      probe.auditEventCount = 0;
    });
    await updateJson(join(dir, "leakage-sample.json"), (sample) => {
      sample.buildCommit = "0000000000000000000000000000000000000000";
      sample.surface = "test";
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((entry) => entry.name === "live_probe_small_req_set_candidate_binding")?.status, "fail");
    assert.equal(report.checks.find((entry) => entry.name === "live_probe_small_req_set_production_binding")?.status, "fail");
    assert.ok((report.checks.find((entry) => entry.name === "leakage_sample")?.details?.missing as string[]).includes("candidateBuildCommit"));
  });

  it("fails malformed manifest entries deterministically instead of throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-malformed-manifest-"));
    await writeCompleteEvidence(dir);
    await updateJson(join(dir, "manifest.json"), (manifest) => {
      manifest.liveProbes = [{}];
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((entry) => entry.name === "manifest_shape")?.status, "fail");
  });

  it("re-derives the exact 44-tool catalog instead of trusting stale passing labels", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    const staleReport = distributionReport("chatgpt_codex_host");
    await writeJson(join(dir, "distribution-chatgpt.json"), {
      ...staleReport,
      toolNames: [...staleReport.toolNames, "search_my_job_interviews"],
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "distribution_chatgpt_codex_host_exact_catalog");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.unexpected, ["search_my_job_interviews"]);
  });

  it("re-derives a duplicate-free remote catalog instead of trusting passing labels", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    const staleReport = distributionReport("chatgpt_codex_host");
    await writeJson(join(dir, "distribution-chatgpt.json"), {
      ...staleReport,
      toolNames: [...staleReport.toolNames, staleReport.toolNames[0]],
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });
    const check = report.checks.find((entry) => entry.name === "distribution_chatgpt_codex_host_exact_catalog");

    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.duplicates, [staleReport.toolNames[0]]);
  });

  it("re-derives canonical remote catalog order instead of trusting passing labels", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    const staleReport = distributionReport("chatgpt_codex_host");
    await writeJson(join(dir, "distribution-chatgpt.json"), {
      ...staleReport,
      toolNames: [...staleReport.toolNames].reverse(),
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });
    const check = report.checks.find((entry) => entry.name === "distribution_chatgpt_codex_host_exact_catalog");

    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.equal(check?.details?.orderMatch, false);
  });

  it("fails desktop evidence when the attested session token id was not issued for that tester surface", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, {
      desktopOverrides: {
        chatgpt_desktop: { sessionTokenId: "outside-token-id" },
      },
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "desktop_chatgpt_codex_host");
    assert.equal(check?.status, "fail");
    assert.equal(check?.details?.sessionTokenId, "outside-token-id");
    assert.deepEqual(check?.details?.tokenBindingMissing, [
      "sessionIssuanceTokenIdForTester",
      "desktopConfigTokenIdForTester",
    ]);
  });

  it("fails desktop evidence with non-exact durable session token metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, {
      desktopOverrides: {
        chatgpt_desktop: {
          sessionTokenId: " chatgpt-token-id",
          sessionTokenIdAfterRestart: " chatgpt-token-id",
        },
      },
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "desktop_chatgpt_codex_host");
    assert.equal(check?.status, "fail");
    assert.equal(check?.details?.sessionTokenId, "");
    assert.deepEqual(check?.details?.tokenBindingMissing, ["sessionTokenId"]);
  });

  it("fails desktop evidence when the post-restart token id does not match the issued durable token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, {
      desktopOverrides: {
        chatgpt_desktop: { sessionTokenIdAfterRestart: "new-short-lived-token-id" },
      },
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "desktop_chatgpt_codex_host");
    assert.equal(check?.status, "fail");
    assert.equal(check?.details?.sessionTokenId, "chatgpt-token-id");
    assert.equal(check?.details?.sessionTokenIdAfterRestart, "new-short-lived-token-id");
    assert.equal(check?.details?.postRestartTokenMatches, false);
  });

  it("fails desktop evidence when the post-restart issued-at timestamp does not match the issued durable session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, {
      desktopOverrides: {
        chatgpt_desktop: { sessionIssuedAtAfterRestart: "2026-06-24T00:00:00.000Z" },
      },
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "desktop_chatgpt_codex_host");
    assert.equal(check?.status, "fail");
    assert.equal(check?.details?.sessionIssuedAt, "2026-06-23T00:00:00.000Z");
    assert.equal(check?.details?.sessionIssuedAtAfterRestart, "2026-06-24T00:00:00.000Z");
    assert.equal(check?.details?.postRestartIssuedAtMatches, false);
  });

  it("fails ChatGPT desktop evidence that does not name an approved attachment method", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, {
      desktopOverrides: {
        chatgpt_desktop: { attachmentMethod: "responses_api_payload_only" },
      },
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "desktop_chatgpt_codex_host");
    assert.equal(check?.status, "fail");
    assert.equal(check?.details?.attachmentMethod, "responses_api_payload_only");
    assert.equal(check?.details?.attachmentMethodAllowed, false);
  });

  it("requires exact no-write and token-free desktop attestations", async () => {
    for (const override of [
      { writeOrAdminToolsVisible: undefined },
      { containsTokens: undefined },
      { containsTokens: true },
    ]) {
      const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
      await writeCompleteEvidence(dir, {
        desktopOverrides: {
          chatgpt_desktop: override,
        },
      });

      const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });
      const check = report.checks.find((entry) => entry.name === "desktop_chatgpt_codex_host");
      assert.equal(report.ok, false);
      assert.equal(check?.status, "fail");
    }
  });

  it("fails desktop evidence from a tester email outside the preflighted roster", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, {
      desktopOverrides: {
        chatgpt_desktop: { testerEmail: "outside@example.com" },
      },
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "desktop_chatgpt_codex_host");
    assert.equal(check?.status, "fail");
    assert.equal(check?.details?.testerEmail, "outside@example.com");
    assert.equal(check?.details?.testerInPreflightRoster, false);
  });

  it("fails when roster preflight evidence is missing, token-bearing, or has denied rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, {
      rosterPreflightOverrides: {
        ok: false,
        containsTokens: true,
        canIssueSessions: false,
        denied: [{ email: "missing@example.com", reason: "not mapped" }],
        token: "must-not-appear",
      },
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "roster_preflight");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.missing, ["passingReport", "tokenFreeReport", "canIssueSessions", "noDeniedRows", "reportHasTokenPayload"]);
  });

  it("fails when roster preflight evidence lacks recent managed-source provenance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, {
      rosterPreflightOverrides: {
        generatedAt: "2026-05-01T00:00:00.000Z",
        rosterSource: "self_reported_email",
        verifiedBy: "",
      },
    });

    const report = await runRolloutGate({
      manifestPath: join(dir, "manifest.json"),
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "roster_preflight");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.missing, ["generatedAtFreshness", "managedRosterSource", "verifiedBy"]);
  });

  it("fails when roster preflight, session issuance, and desktop config evidence cover different recruiters", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, {
      sessionIssuanceManifestOverrides: {
        files: [
          { email: "different@example.com", surface: "claude_desktop", client: "claude_desktop_chat", subject: "email:different@example.com", tokenId: "claude-token-id", issuedAt: "2026-06-23T00:00:00.000Z", path: "recruiter-claude.json" },
          { email: "recruiter@example.com", surface: "claude_desktop", client: "claude_code", subject: "email:recruiter@example.com", tokenId: "claude-code-token-id", issuedAt: "2026-06-23T00:00:00.000Z", path: "recruiter-claude-code.json" },
          { email: "recruiter@example.com", surface: "chatgpt_desktop", client: "chatgpt_codex_host", subject: "email:recruiter@example.com", tokenId: "chatgpt-token-id", issuedAt: "2026-06-23T00:00:00.000Z", path: "recruiter-chatgpt.json" },
        ],
      },
      desktopConfigManifestOverrides: {
        files: [
          { email: "recruiter@example.com", surface: "claude_desktop", client: "claude_desktop_chat", tokenId: "claude-token-id", subject: "email:recruiter@example.com", issuedAt: "2026-06-23T00:00:00.000Z", path: "recruiter-claude.json" },
          { email: "recruiter@example.com", surface: "claude_desktop", client: "claude_code", tokenId: "claude-code-token-id", subject: "email:recruiter@example.com", issuedAt: "2026-06-23T00:00:00.000Z", path: "recruiter-claude-code.json" },
          { email: "different@example.com", surface: "chatgpt_desktop", client: "chatgpt_codex_host", tokenId: "chatgpt-token-id", subject: "email:different@example.com", issuedAt: "2026-06-23T00:00:00.000Z", path: "recruiter-chatgpt.json" },
        ],
      },
    });
    await writeFile(join(dir, "issued-sessions", "recruiter-claude.json"), JSON.stringify({
      email: "different@example.com",
      surface: "claude_desktop",
      client: "claude_desktop_chat",
      subject: "email:different@example.com",
      tokenId: "claude-token-id",
      issuedAt: "2026-06-23T00:00:00.000Z",
      token: sessionToken("different@example.com", "claude_desktop", "claude_desktop_chat", "claude-token-id"),
    }, null, 2), "utf8");
    await writeFile(join(dir, "desktop-configs", "recruiter-chatgpt.json"), JSON.stringify({
      type: "mcp",
      server_label: "greenhouse-recruiter",
      server_url: "https://greenhouse-recruiter.example.com/mcp",
      authorization: sessionToken("different@example.com", "chatgpt_desktop", "chatgpt_codex_host", "chatgpt-token-id"),
      require_approval: "always",
      allowed_tools: RECRUITER_TOOL_NAMES,
    }, null, 2), "utf8");

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    assert.equal(report.checks.find((entry) => entry.name === "session_issuance_manifest")?.status, "pass");
    assert.equal(report.checks.find((entry) => entry.name === "desktop_config_manifest")?.status, "pass");
    const check = report.checks.find((entry) => entry.name === "roster_session_config_consistency");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.missing, [
      "sessionsForEveryPreflightedRecruiterSurface",
      "noSessionFilesOutsidePreflightRoster",
      "desktopConfigsForEveryPreflightedRecruiterSurface",
      "noDesktopConfigsOutsidePreflightRoster",
    ]);
    assert.deepEqual(check?.details?.sessionMissing, ["recruiter@example.com:claude_desktop:claude_desktop_chat"]);
    assert.deepEqual(check?.details?.sessionUnexpected, ["different@example.com:claude_desktop:claude_desktop_chat"]);
    assert.deepEqual(check?.details?.desktopMissing, ["recruiter@example.com:chatgpt_desktop:chatgpt_codex_host"]);
    assert.deepEqual(check?.details?.desktopUnexpected, ["different@example.com:chatgpt_desktop:chatgpt_codex_host"]);
  });

  it("fails when split session issuance evidence is missing, token-bearing, or carries scoped claims", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, {
      sessionIssuanceManifestOverrides: { containsTokens: true },
    });
    await writeFile(join(dir, "issued-sessions", "recruiter-claude.json"), JSON.stringify({
      email: "recruiter@example.com",
      surface: "claude_desktop",
      client: "claude_desktop_chat",
      subject: "email:recruiter@example.com",
      tokenId: "claude-token-id",
      issuedAt: "2026-06-23T00:00:00.000Z",
      token: sessionToken("recruiter@example.com", "claude_desktop", "claude_desktop_chat", "claude-token-id"),
      permittedJobIds: [123],
    }, null, 2), "utf8");

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "session_issuance_manifest");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.missing, ["tokenFreeManifest", "sessionFilesWithoutSecretsOrScopedClaims"]);
  });

  it("fails when split session issuance token metadata does not match the manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    await writeFile(join(dir, "issued-sessions", "recruiter-chatgpt.json"), JSON.stringify({
      email: "recruiter@example.com",
      surface: "chatgpt_desktop",
      client: "chatgpt_codex_host",
      subject: "email:recruiter@example.com",
      tokenId: "chatgpt-token-id",
      issuedAt: "2026-06-23T00:00:00.000Z",
      token: sessionToken("recruiter@example.com", "claude_desktop", "claude_desktop_chat", "chatgpt-token-id"),
    }, null, 2), "utf8");

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "session_issuance_manifest");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.missing, ["sessionFilesMatchManifestTokenMetadata"]);
    assert.deepEqual(check?.details?.sessionMetadataProblems, [
      "chatgpt_desktop:recruiter@example.com:token_surface_mismatch",
      "chatgpt_desktop:recruiter@example.com:token_client_mismatch",
    ]);
  });

  it("fails when split session issuance token metadata is not runtime-valid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    await writeFile(join(dir, "issued-sessions", "recruiter-chatgpt.json"), JSON.stringify({
      email: "recruiter@example.com",
      surface: "chatgpt_desktop",
      client: "chatgpt_codex_host",
      subject: "email:recruiter@example.com",
      tokenId: "chatgpt-token-id",
      issuedAt: "2026-06-23T00:00:00.000Z",
      token: sessionToken("recruiter@example.com", "chatgpt_desktop", "chatgpt_codex_host", " chatgpt-token-id"),
    }, null, 2), "utf8");

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "session_issuance_manifest");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.missing, ["sessionFilesMatchManifestTokenMetadata"]);
    assert.deepEqual(check?.details?.sessionMetadataProblems, ["chatgpt_desktop:recruiter@example.com:token_id_invalid"]);
  });

  it("fails when split desktop config token metadata does not match the manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    await writeFile(join(dir, "desktop-configs", "recruiter-chatgpt.json"), JSON.stringify({
      type: "mcp",
      server_label: "greenhouse-recruiter",
      server_url: "https://greenhouse-recruiter.example.com/mcp",
      authorization: sessionToken("outside@example.com", "chatgpt_desktop", "chatgpt_codex_host", "chatgpt-token-id"),
      require_approval: "always",
      allowed_tools: RECRUITER_TOOL_NAMES,
    }, null, 2), "utf8");

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "desktop_config_manifest");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.missing, ["configFilesMatchManifestTokenMetadata"]);
    assert.deepEqual(check?.details?.configTokenMetadataProblems, [
      "chatgpt_desktop:recruiter@example.com:token_email_mismatch",
      "chatgpt_desktop:recruiter@example.com:token_subject_mismatch",
    ]);
  });

  it("fails when split desktop config authorization trims into a valid token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    await writeFile(join(dir, "desktop-configs", "recruiter-chatgpt.json"), JSON.stringify({
      type: "mcp",
      server_label: "greenhouse-recruiter",
      server_url: "https://greenhouse-recruiter.example.com/mcp",
      authorization: `${sessionToken("recruiter@example.com", "chatgpt_desktop", "chatgpt_codex_host", "chatgpt-token-id")} `,
      require_approval: "always",
      allowed_tools: RECRUITER_TOOL_NAMES,
    }, null, 2), "utf8");

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "desktop_config_manifest");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.missing, ["configFilesHaveValidRemoteShape"]);
    assert.deepEqual(check?.details?.configShapeProblems, ["chatgpt_desktop:recruiter@example.com:authorization_required"]);
  });

  it("validates the personalized Claude MCPB archive and its client-bound credential", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    const sessionPath = join(dir, "claude-desktop-session.json");
    const client = "claude_desktop_chat";
    const claims = {
      subject: "email:recruiter@example.com",
      email: "recruiter@example.com",
      surface: "claude_desktop",
      client,
      tokenId: "claude-token-id",
      issuedAt: "2026-06-23T00:00:00.000Z",
    } as const;
    await writeJson(sessionPath, {
      ...claims,
      token: `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${"signature".repeat(5)}`,
    });
    const built = await buildClaudeMcpb({
      issuedSessionFile: sessionPath,
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      outputDir: join(dir, "mcpb-build"),
    });
    const artifactName = "recruiter-claude.mcpb";
    await copyFile(join(dir, "mcpb-build", built.artifactPath), join(dir, "desktop-configs", artifactName));
    await updateJson(join(dir, "desktop-configs", "manifest.json"), (manifest) => {
      manifest.artifactContainsToken = true;
      manifest.metadataContainsToken = false;
      const files = manifest.files as Array<Record<string, unknown>>;
      files[0]!.client = client;
      files[0]!.path = artifactName;
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.checks.find((entry) => entry.name === "desktop_config_manifest")?.status, "pass");

    await updateJson(join(dir, "desktop-configs", "manifest.json"), (manifest) => {
      const files = manifest.files as Array<Record<string, unknown>>;
      files[0]!.client = "claude_code";
    });
    const mismatched = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });
    const mismatchCheck = mismatched.checks.find((entry) => entry.name === "desktop_config_manifest");
    assert.equal(mismatchCheck?.status, "fail");
    assert.ok((mismatchCheck?.details?.configTokenMetadataProblems as string[]).includes(
      "claude_desktop:recruiter@example.com:manifest_client_claude_desktop_chat_required"
    ));
  });

  it("fails when Claude desktop config bearer authorization uses loose spacing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    await writeFile(join(dir, "desktop-configs", "recruiter-claude.json"), JSON.stringify({
      mcpServers: {
        "greenhouse-recruiter": {
          type: "streamable-http",
          url: "https://greenhouse-recruiter.example.com/mcp",
          headers: { Authorization: `Bearer  ${sessionToken("recruiter@example.com", "claude_desktop", "claude_desktop_chat", "claude-token-id")}` },
        },
      },
    }, null, 2), "utf8");

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "desktop_config_manifest");
    assert.equal(check?.status, "fail");
    assert.ok((check?.details?.missing as string[]).includes("configFilesHaveValidRemoteShape"));
    assert.ok((check?.details?.configShapeProblems as string[]).includes("claude_desktop:recruiter@example.com:missing_bearer_authorization"));
  });

  it("fails when session and desktop config manifests disagree on issued-at timestamps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, {
      desktopConfigManifestOverrides: {
        files: [
          { email: "recruiter@example.com", surface: "claude_desktop", client: "claude_desktop_chat", tokenId: "claude-token-id", subject: "email:recruiter@example.com", issuedAt: "2026-06-23T00:00:00.000Z", path: "recruiter-claude.json" },
          { email: "recruiter@example.com", surface: "claude_desktop", client: "claude_code", tokenId: "claude-code-token-id", subject: "email:recruiter@example.com", issuedAt: "2026-06-23T00:00:00.000Z", path: "recruiter-claude-code.json" },
          { email: "recruiter@example.com", surface: "chatgpt_desktop", client: "chatgpt_codex_host", tokenId: "chatgpt-token-id", subject: "email:recruiter@example.com", issuedAt: "2026-06-24T00:00:00.000Z", path: "recruiter-chatgpt.json" },
        ],
      },
    });
    await writeFile(join(dir, "desktop-configs", "recruiter-chatgpt.json"), JSON.stringify({
      type: "mcp",
      server_label: "greenhouse-recruiter",
      server_url: "https://greenhouse-recruiter.example.com/mcp",
      authorization: sessionToken("recruiter@example.com", "chatgpt_desktop", "chatgpt_codex_host", "chatgpt-token-id", "2026-06-24T00:00:00.000Z"),
      require_approval: "always",
      allowed_tools: RECRUITER_TOOL_NAMES,
    }, null, 2), "utf8");

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    assert.equal(report.checks.find((entry) => entry.name === "session_issuance_manifest")?.status, "pass");
    assert.equal(report.checks.find((entry) => entry.name === "desktop_config_manifest")?.status, "pass");
    const check = report.checks.find((entry) => entry.name === "roster_session_config_consistency");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.missing, ["sessionAndDesktopIssuedAtMatch"]);
    assert.deepEqual(check?.details?.issuedAtMismatches, [
      "recruiter@example.com:chatgpt_desktop:chatgpt_codex_host:session=2026-06-23T00:00:00.000Z:desktop=2026-06-24T00:00:00.000Z",
    ]);
  });

  it("fails when session and desktop config manifests disagree on token ids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, {
      desktopConfigManifestOverrides: {
        files: [
          { email: "recruiter@example.com", surface: "claude_desktop", client: "claude_desktop_chat", tokenId: "claude-token-id", subject: "email:recruiter@example.com", issuedAt: "2026-06-23T00:00:00.000Z", path: "recruiter-claude.json" },
          { email: "recruiter@example.com", surface: "claude_desktop", client: "claude_code", tokenId: "claude-code-token-id", subject: "email:recruiter@example.com", issuedAt: "2026-06-23T00:00:00.000Z", path: "recruiter-claude-code.json" },
          { email: "recruiter@example.com", surface: "chatgpt_desktop", client: "chatgpt_codex_host", tokenId: "wrong-chatgpt-token-id", subject: "email:recruiter@example.com", issuedAt: "2026-06-23T00:00:00.000Z", path: "recruiter-chatgpt.json" },
        ],
      },
    });
    await writeFile(join(dir, "desktop-configs", "recruiter-chatgpt.json"), JSON.stringify({
      type: "mcp",
      server_label: "greenhouse-recruiter",
      server_url: "https://greenhouse-recruiter.example.com/mcp",
      authorization: sessionToken("recruiter@example.com", "chatgpt_desktop", "chatgpt_codex_host", "wrong-chatgpt-token-id"),
      require_approval: "always",
      allowed_tools: RECRUITER_TOOL_NAMES,
    }, null, 2), "utf8");

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    assert.equal(report.checks.find((entry) => entry.name === "session_issuance_manifest")?.status, "pass");
    assert.equal(report.checks.find((entry) => entry.name === "desktop_config_manifest")?.status, "pass");
    const check = report.checks.find((entry) => entry.name === "roster_session_config_consistency");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.missing, ["sessionAndDesktopTokenIdsMatch"]);
    assert.deepEqual(check?.details?.tokenMismatches, [
      "recruiter@example.com:chatgpt_desktop:chatgpt_codex_host:session=chatgpt-token-id:desktop=wrong-chatgpt-token-id",
    ]);
  });

  it("fails when desktop config delivery evidence sends a generated config to the wrong recruiter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, {
      desktopDeliveryOverrides: {
        deliveries: [
          deliveryEntry("claude_desktop_chat"),
          deliveryEntry("claude_code"),
          { ...deliveryEntry("chatgpt_codex_host"), recipientEmail: "outside@example.com" },
        ],
      },
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "desktop_config_delivery");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.mismatches, ["recruiter@example.com:chatgpt_desktop:chatgpt_codex_host:recipientEmail"]);
  });

  it("fails when desktop config delivery evidence references the wrong issued-at timestamp", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, {
      desktopDeliveryOverrides: {
        deliveries: [
          deliveryEntry("claude_desktop_chat"),
          deliveryEntry("claude_code"),
          { ...deliveryEntry("chatgpt_codex_host"), issuedAt: "2026-06-24T00:00:00.000Z" },
        ],
      },
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "desktop_config_delivery");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.missing, ["deliveryEntriesMatchDesktopConfigManifest"]);
    assert.deepEqual(check?.details?.mismatches, ["recruiter@example.com:chatgpt_desktop:chatgpt_codex_host:issuedAt"]);
  });

  it("fails when desktop config delivery evidence uses an unapproved channel", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, {
      desktopDeliveryOverrides: {
        deliveryChannel: "email_attachment",
        deliveries: [
          { ...deliveryEntry("claude_desktop_chat"), deliveryChannel: "email_attachment" },
          { ...deliveryEntry("claude_code"), deliveryChannel: "email_attachment" },
          { ...deliveryEntry("chatgpt_codex_host"), deliveryChannel: "email_attachment" },
        ],
      },
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "desktop_config_delivery");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.missing, ["approvedDeliveryChannel"]);
    assert.deepEqual(check?.details?.unsafeDeliveryChannels, [
      "recruiter@example.com:claude_desktop:claude_desktop_chat:email_attachment",
      "recruiter@example.com:claude_desktop:claude_code:email_attachment",
      "recruiter@example.com:chatgpt_desktop:chatgpt_codex_host:email_attachment",
    ]);
  });

  it("fails when split desktop config evidence is missing, token-bearing, or embeds server credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, {
      desktopConfigManifestOverrides: { containsTokens: true },
    });
    await writeFile(join(dir, "desktop-configs", "recruiter-claude.json"), JSON.stringify({
      mcpServers: {
        "greenhouse-recruiter": {
          url: "https://greenhouse-recruiter.example.com/mcp",
          env: { GREENHOUSE_CLIENT_SECRET: "must-not-ship" },
        },
      },
    }, null, 2), "utf8");

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "desktop_config_manifest");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.missing, ["tokenFreeManifest", "configFilesWithoutServerCredentials", "configFilesHaveValidRemoteShape"]);
  });

  it("fails when desktop config files are not production remote recruiter payloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    await writeFile(join(dir, "desktop-configs", "recruiter-claude.json"), JSON.stringify({
      mcpServers: {
        "greenhouse-recruiter": {
          command: "greenhouse-recruiter-mcp",
          env: { GREENHOUSE_RECRUITER_SESSION_TOKEN: sessionToken("recruiter@example.com", "claude_desktop", "claude_desktop_chat", "claude-token-id") },
          headers: { Authorization: `Bearer ${sessionToken("recruiter@example.com", "claude_desktop", "claude_desktop_chat", "claude-token-id")}` },
        },
      },
    }, null, 2), "utf8");
    await writeFile(join(dir, "desktop-configs", "recruiter-chatgpt.json"), JSON.stringify({
      type: "mcp",
      server_label: "greenhouse-recruiter",
      server_url: "http://127.0.0.1:3333/mcp",
      authorization: sessionToken("recruiter@example.com", "chatgpt_desktop", "chatgpt_codex_host", "chatgpt-token-id"),
      require_approval: "always",
      allowed_tools: ["search_my_jobs", "unexpected_tool"],
    }, null, 2), "utf8");

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "desktop_config_manifest");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.missing, ["configFilesHaveValidRemoteShape"]);
    assert.deepEqual(check?.details?.configShapeProblems, [
      "claude_desktop:recruiter@example.com:local_command_or_env_present",
      "claude_desktop:recruiter@example.com:url_missing_url",
      "chatgpt_desktop:recruiter@example.com:url_not_https",
      "chatgpt_desktop:recruiter@example.com:allowed_tools_missing_recruiter_catalog",
      "chatgpt_desktop:recruiter@example.com:allowed_tools_contains_unknown_entries",
      "chatgpt_desktop:recruiter@example.com:allowed_tools_count_mismatch",
      "chatgpt_desktop:recruiter@example.com:allowed_tools_order_mismatch",
    ]);
  });

  it("fails when a ChatGPT desktop config omits the complete recruiter tool allowlist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    await writeFile(join(dir, "desktop-configs", "recruiter-chatgpt.json"), JSON.stringify({
      type: "mcp",
      server_label: "greenhouse-recruiter",
      server_url: "https://greenhouse-recruiter.example.com/mcp",
      authorization: sessionToken("recruiter@example.com", "chatgpt_desktop", "chatgpt_codex_host", "chatgpt-token-id"),
      require_approval: "always",
    }, null, 2), "utf8");

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "desktop_config_manifest");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.missing, ["configFilesHaveValidRemoteShape"]);
    assert.deepEqual(check?.details?.configShapeProblems, [
      "chatgpt_desktop:recruiter@example.com:allowed_tools_required",
      "chatgpt_desktop:recruiter@example.com:allowed_tools_missing_recruiter_catalog",
      "chatgpt_desktop:recruiter@example.com:allowed_tools_count_mismatch",
    ]);
  });

  it("fails when a ChatGPT desktop allowlist duplicates or reorders the canonical catalog", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    const reorderedWithDuplicate = [...RECRUITER_TOOL_NAMES.slice(1), RECRUITER_TOOL_NAMES[0], RECRUITER_TOOL_NAMES[0]];
    await writeFile(join(dir, "desktop-configs", "recruiter-chatgpt.json"), JSON.stringify({
      type: "mcp",
      server_label: "greenhouse-recruiter",
      server_url: "https://greenhouse-recruiter.example.com/mcp",
      authorization: sessionToken("recruiter@example.com", "chatgpt_desktop", "chatgpt_codex_host", "chatgpt-token-id"),
      require_approval: "always",
      allowed_tools: reorderedWithDuplicate,
    }, null, 2), "utf8");

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });
    const check = report.checks.find((entry) => entry.name === "desktop_config_manifest");

    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.configShapeProblems, [
      "chatgpt_desktop:recruiter@example.com:allowed_tools_contains_duplicates",
      "chatgpt_desktop:recruiter@example.com:allowed_tools_count_mismatch",
      "chatgpt_desktop:recruiter@example.com:allowed_tools_order_mismatch",
    ]);
  });

  it("fails when audit retention and redaction review evidence is incomplete", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, {
      auditReviewOverrides: {
        reviewer: "",
        denialEventsPresent: false,
        surfaceCoveragePresent: false,
        toolKindCoveragePresent: false,
        noSensitivePayloadsFound: false,
      },
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "audit_review");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.missing, ["reviewer", "denialEventsPresent", "surfaceCoveragePresent", "toolKindCoveragePresent", "noSensitivePayloadsFound"]);
  });

  it("fails audit evidence that covers both surfaces but omits Claude Code v2 attribution", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-audit-clients-"));
    await writeCompleteEvidence(dir, {
      auditReviewOverrides: {
        v2Clients: ["claude_desktop_chat", "chatgpt_codex_host"],
        v2ClientCoveragePresent: false,
        checks: [
          { name: "audit_v2_client_coverage", status: "fail", summary: "missing Claude Code" },
          { name: "audit_v2_pair_attribution", status: "pass", summary: "paired attribution" },
        ],
      },
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });
    const check = report.checks.find((entry) => entry.name === "audit_review");

    assert.equal(report.ok, false);
    assert.equal(check?.status, "fail");
    assert.ok((check?.details?.missing as string[]).includes("v2ClientCoveragePresent"));
    assert.ok((check?.details?.missing as string[]).includes("exactV2ClientCoverage"));
    assert.ok((check?.details?.missing as string[]).includes("audit_v2_client_coverage"));
    assert.deepEqual(check?.details?.missingV2Clients, ["claude_code"]);
  });

  it("fails when scoped-vs-unscoped leakage sample evidence is incomplete", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, {
      leakageSampleOverrides: {
        ok: false,
        strict: false,
        checks: [
          { name: "operator_unscoped_sample", status: "pass", summary: "operator" },
          { name: "act_as_user_scoped_sample", status: "pass", summary: "preview" },
          { name: "forbidden_job_leakage", status: "fail", summary: "leaked" },
        ],
      },
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "leakage_sample");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.missing, [
      "passingReport",
      "strict",
      "operator_unscoped_details",
      "act_as_user_scoped_details",
      "forbidden_job_leakage",
      "forbidden_job_leakage_details",
      "failedChecks",
    ]);
  });

  it("fails scoped-vs-unscoped leakage evidence that lacks proof details", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir, {
      leakageSampleOverrides: {
        checks: [
          { name: "operator_unscoped_sample", status: "pass", summary: "operator" },
          { name: "act_as_user_scoped_sample", status: "pass", summary: "preview" },
          { name: "forbidden_job_leakage", status: "pass", summary: "forbidden" },
        ],
      },
    });

    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json") });

    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === "leakage_sample");
    assert.equal(check?.status, "fail");
    assert.deepEqual(check?.details?.missing, [
      "operator_unscoped_details",
      "act_as_user_scoped_details",
      "forbidden_job_leakage_details",
    ]);
  });

  it("fails closed when no evidence manifest path is configured", async () => {
    const report = await runRolloutGateFromEnv({}, {
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });

    assert.equal(report.ok, false);
    assert.deepEqual(report.checks, [{
      name: "manifest_path",
      status: "fail",
      summary: "GREENHOUSE_RECRUITER_ROLLOUT_EVIDENCE_MANIFEST is required.",
    }]);
  });
});

describe("rollout gate — Slice C de-theater", () => {
  it("requires scope_signing_secret in production-env evidence (catalog-derived completeness)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    // Stale / hand-edited env evidence that omits the scope_signing_secret check entirely. The old
    // hand-maintained REQUIRED list dropped it, so this would have passed; deriving from the readiness
    // catalog restores it as a completeness requirement.
    await updateJson(join(dir, "production-env-check.json"), (report) => {
      report.checks = (report.checks as Array<Record<string, unknown>>).filter((check) => check.name !== "scope_signing_secret");
    });
    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json"), now: () => new Date("2026-06-23T00:00:00.000Z") });
    const envCheck = report.checks.find((check) => check.name === "production_env_preflight");
    assert.equal(report.ok, false);
    assert.equal(envCheck?.status, "fail");
    assert.ok((envCheck?.details?.missingRequiredChecks as string[]).includes("scope_signing_secret"));
  });

  it("labels recorded live-probe and distribution evidence as attested, not live observation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json"), now: () => new Date("2026-06-23T00:00:00.000Z") });
    const probeCheck = report.checks.find((check) => check.name === "live_probe_small_req_set");
    const distCheck = report.checks.find((check) => check.name === "distribution_chatgpt_codex_host");
    assert.match(probeCheck?.summary ?? "", /does not itself observe|attested/i);
    assert.match(distCheck?.summary ?? "", /does not itself observe|attested/i);
  });

  it("observeLiveReadyz fails when no live url is configured", async () => {
    const checks = await observeLiveReadyz({});
    assert.equal(checks.length, 1);
    assert.equal(checks[0]?.name, "live_readyz_observation");
    assert.equal(checks[0]?.status, "fail");
    assert.match(checks[0]?.summary ?? "", /is required/);
  });

  it("observeLiveReadyz passes only when the hosted /readyz reports ok:true and status:ready", async () => {
    const ready = await observeLiveReadyz({
      url: "https://greenhouse-recruiter.example.com/readyz",
      token: "x".repeat(32),
      fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({ ok: true, status: "ready" }) })) as unknown as typeof fetch,
    });
    assert.equal(ready[0]?.status, "pass");
    assert.match(ready[0]?.summary ?? "", /Observed live \/readyz/);
  });

  it("observeLiveReadyz fails on non-2xx, not-ready body, missing token, or an unreachable host", async () => {
    // Ready-looking body so ONLY the 503 status can cause the failure — isolates the HTTP-status
    // guard (a body of {} would also fail the ready-body check and mask a missing status guard).
    const non2xx = await observeLiveReadyz({
      url: "https://greenhouse-recruiter.example.com/readyz",
      token: "x".repeat(32),
      fetchImpl: (async () => ({ ok: false, status: 503, json: async () => ({ ok: true, status: "ready" }) })) as unknown as typeof fetch,
    });
    assert.equal(non2xx[0]?.status, "fail");
    assert.equal(non2xx[0]?.details?.httpStatus, 503);
    const notReady = await observeLiveReadyz({
      url: "https://greenhouse-recruiter.example.com/readyz",
      token: "x".repeat(32),
      fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({ ok: false, status: "not_ready" }) })) as unknown as typeof fetch,
    });
    assert.equal(notReady[0]?.status, "fail");
    const noToken = await observeLiveReadyz({ url: "https://greenhouse-recruiter.example.com/readyz" });
    assert.equal(noToken[0]?.status, "fail");
    const unreachable = await observeLiveReadyz({
      url: "https://greenhouse-recruiter.example.com/readyz",
      token: "x".repeat(32),
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    assert.equal(unreachable[0]?.status, "fail");
  });

  it("observeLiveReadyz rejects local and special-use IP literals before fetch", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ ok: true, status: "ready" }));
    }) as typeof fetch;
    for (const url of [
      "https://[::1]/readyz",
      "https://[::ffff:127.0.0.1]/readyz",
      "https://0.0.0.0/readyz",
      "https://10.0.0.1/readyz",
    ]) {
      const checks = await observeLiveReadyz({ url, token: "x".repeat(32), fetchImpl });
      assert.equal(checks[0]?.status, "fail", url);
    }
    assert.equal(fetchCalls, 0);
  });

  it("a configured live /readyz check can fail the gate even when recorded evidence is green (teeth)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    const failing = await runRolloutGate({
      manifestPath: join(dir, "manifest.json"),
      now: () => new Date("2026-06-23T00:00:00.000Z"),
      liveReadyz: {
        url: "https://greenhouse-recruiter.example.com/readyz",
        token: "x".repeat(32),
        fetchImpl: (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch,
      },
    });
    assert.equal(failing.ok, false);
    assert.equal(failing.checks.find((check) => check.name === "live_readyz_observation")?.status, "fail");

    const observedRequests: Array<{ url: string; authorization: string | null; redirect: RequestRedirect | undefined }> = [];
    const passing = await runRolloutGate({
      manifestPath: join(dir, "manifest.json"),
      now: () => new Date("2026-06-23T00:00:00.000Z"),
      liveReadyz: {
        url: "https://greenhouse-recruiter.example.com/readyz",
        token: "x".repeat(32),
        fetchImpl: (async (input, init) => {
          const url = String(input);
          observedRequests.push({ url, authorization: new Headers(init?.headers).get("authorization"), redirect: init?.redirect });
          const body = url.endsWith("/version")
            ? { name: "greenhouse-recruiter-mcp", version: "0.1.0", commit: EXPECTED_COMMIT }
            : { ok: true, status: "ready" };
          return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
        }) as typeof fetch,
      },
    });
    assert.equal(passing.ok, true);
    assert.equal(passing.checks.find((check) => check.name === "live_readyz_observation")?.status, "pass");
    assert.equal(passing.checks.find((check) => check.name === "live_version_observation")?.status, "pass");
    assert.deepEqual(observedRequests, [
      { url: "https://greenhouse-recruiter.example.com/readyz", authorization: `Bearer ${"x".repeat(32)}`, redirect: "error" },
      { url: "https://greenhouse-recruiter.example.com/version", authorization: null, redirect: "error" },
    ]);
  });

  it("does not send the readiness token when the requested live URL is not the pinned candidate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    let fetchCalls = 0;
    const report = await runRolloutGate({
      manifestPath: join(dir, "manifest.json"),
      liveReadyz: {
        url: "https://attacker.example.net/readyz",
        token: "readiness-secret",
        fetchImpl: (async () => {
          fetchCalls += 1;
          return new Response("{}");
        }) as typeof fetch,
      },
    });

    assert.equal(report.ok, false);
    assert.equal(report.checks.find((check) => check.name === "live_readyz_candidate_binding")?.status, "fail");
    assert.equal(report.checks.find((check) => check.name === "live_readyz_observation")?.status, "fail");
    assert.equal(report.checks.find((check) => check.name === "live_version_observation")?.status, "fail");
    assert.equal(fetchCalls, 0);
  });

  it("fails the final gate when live /version no longer reports the pinned commit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    const report = await runRolloutGate({
      manifestPath: join(dir, "manifest.json"),
      liveReadyz: {
        url: "https://greenhouse-recruiter.example.com/readyz",
        token: "x".repeat(32),
        fetchImpl: (async (input) => {
          const body = String(input).endsWith("/version")
            ? { commit: "a".repeat(40) }
            : { ok: true, status: "ready" };
          return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
        }) as typeof fetch,
      },
    });

    assert.equal(report.ok, false);
    assert.equal(report.checks.find((check) => check.name === "live_readyz_observation")?.status, "pass");
    assert.equal(report.checks.find((check) => check.name === "live_version_observation")?.status, "fail");
  });

  it("fails a data-bearing probe whose analysis denominator is zero when expectVisibleData is set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    await updateJson(join(dir, "probe-small.json"), (report) => {
      const checks = report.checks as Array<Record<string, unknown>>;
      const stageCheck = checks.find((check) => check.name === "stage_latency_analysis")!;
      stageCheck.details = { ...(stageCheck.details as Record<string, unknown>), applicationsConsidered: 0 };
    });
    await updateJson(join(dir, "manifest.json"), (manifest) => {
      const liveProbes = manifest.liveProbes as Array<Record<string, unknown>>;
      liveProbes.find((probe) => probe.profile === "small_req_set")!.expectVisibleData = true;
    });
    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json"), now: () => new Date("2026-06-23T00:00:00.000Z") });
    const visibleData = report.checks.find((check) => check.name === "live_probe_small_req_set_visible_data");
    assert.equal(report.ok, false);
    assert.equal(visibleData?.status, "fail");
    assert.ok((visibleData?.details?.problems as string[]).includes("stage_latency_analysis.applicationsConsidered:zero"));
  });

  it("passes the visible-data gate when a data-bearing profile carried rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-gate-"));
    await writeCompleteEvidence(dir);
    await updateJson(join(dir, "manifest.json"), (manifest) => {
      const liveProbes = manifest.liveProbes as Array<Record<string, unknown>>;
      liveProbes.find((probe) => probe.profile === "small_req_set")!.expectVisibleData = true;
    });
    const report = await runRolloutGate({ manifestPath: join(dir, "manifest.json"), now: () => new Date("2026-06-23T00:00:00.000Z") });
    assert.equal(report.checks.find((check) => check.name === "live_probe_small_req_set_visible_data")?.status, "pass");
  });
});

async function writeCompleteEvidence(
  dir: string,
  options: {
    noPermissionsRowsReturned?: number;
    desktopOverrides?: Partial<Record<DesktopSurface, Partial<DesktopReportFixture>>>;
    claudeCodeDesktopOverrides?: Partial<DesktopReportFixture>;
    auditReviewOverrides?: Partial<AuditReviewFixture>;
    leakageSampleOverrides?: Partial<LeakageSampleFixture>;
    rosterPreflightOverrides?: Record<string, unknown>;
    sessionIssuanceManifestOverrides?: Record<string, unknown>;
    desktopConfigManifestOverrides?: Record<string, unknown>;
    desktopDeliveryOverrides?: Partial<DesktopDeliveryFixture>;
    revocationDrillOverrides?: Partial<RevocationDrillFixture>;
    sessionRevocationOverrides?: Partial<SessionRevocationFixture>;
    productionEnvOverrides?: Record<string, unknown>;
  } = {}
): Promise<void> {
  await writeJson(join(dir, "probe-small.json"), probeReport({ profile: "small_req_set", strict: true, rowsReturned: 2 }));
  await writeJson(join(dir, "probe-many.json"), probeReport({ profile: "many_req_set", strict: true, rowsReturned: 25 }));
  await writeJson(join(dir, "probe-operator.json"), probeReport({ profile: "all_jobs_or_operator", strict: true, rowsReturned: 25 }));
  await writeJson(join(dir, "probe-none.json"), probeReport({ profile: "no_permissions", strict: false, rowsReturned: options.noPermissionsRowsReturned ?? 0 }));
  await writeJson(join(dir, "distribution-chatgpt.json"), distributionReport("chatgpt_codex_host"));
  await writeJson(join(dir, "distribution-claude.json"), distributionReport("claude_desktop_chat"));
  await writeJson(join(dir, "distribution-claude-code.json"), distributionReport("claude_code"));
  await writeProductionEnvEvidence(dir, options.productionEnvOverrides);
  await writeJson(join(dir, "revocation-drill-claude.json"), revocationDrill({}, "claude_desktop_chat"));
  await writeJson(join(dir, "revocation-drill-claude-code.json"), revocationDrill({}, "claude_code"));
  await writeJson(join(dir, "revocation-drill-chatgpt.json"), revocationDrill(options.revocationDrillOverrides, "chatgpt_codex_host"));
  await writeJson(join(dir, "session-revocation-claude.json"), sessionRevocation({}, "claude_desktop_chat"));
  await writeJson(join(dir, "session-revocation-claude-code.json"), sessionRevocation({}, "claude_code"));
  await writeJson(join(dir, "session-revocation-chatgpt.json"), sessionRevocation(options.sessionRevocationOverrides, "chatgpt_codex_host"));
  await writeRosterPreflightEvidence(dir, options.rosterPreflightOverrides);
  await writeSessionIssuanceEvidence(dir, options.sessionIssuanceManifestOverrides);
  await writeDesktopConfigEvidence(dir, options.desktopConfigManifestOverrides);
  await writeDesktopDeliveryEvidence(dir, options.desktopDeliveryOverrides);
  await writeJson(join(dir, "desktop-chatgpt.json"), desktopReport("chatgpt_codex_host", options.desktopOverrides?.chatgpt_desktop));
  await writeJson(join(dir, "desktop-claude.json"), desktopReport("claude_desktop_chat", options.desktopOverrides?.claude_desktop));
  await writeJson(join(dir, "desktop-claude-code.json"), desktopReport("claude_code", options.claudeCodeDesktopOverrides));
  await writeJson(join(dir, "leakage-sample.json"), leakageSample(options.leakageSampleOverrides));
  await writeJson(join(dir, "audit-review.json"), auditReview(options.auditReviewOverrides));
  await writeJson(join(dir, "manifest.json"), {
    version: 2,
    candidate: { mcpUrl: "https://greenhouse-recruiter.example.com/mcp", commit: EXPECTED_COMMIT },
    liveProbes: [
      { profile: "small_req_set", path: "probe-small.json", strict: true },
      { profile: "many_req_set", path: "probe-many.json", strict: true },
      { profile: "all_jobs_or_operator", path: "probe-operator.json", strict: true },
      { profile: "no_permissions", path: "probe-none.json", strict: false, expectZeroVisibleJobs: true },
    ],
    distributionValidations: [
      { surface: "claude_desktop", client: "claude_desktop_chat", path: "distribution-claude.json" },
      { surface: "claude_desktop", client: "claude_code", path: "distribution-claude-code.json" },
      { surface: "chatgpt_desktop", client: "chatgpt_codex_host", path: "distribution-chatgpt.json" },
    ],
    productionEnvEvidence: { path: "production-env-check.json" },
    revocationDrillEvidence: [
      { surface: "claude_desktop", client: "claude_desktop_chat", path: "revocation-drill-claude.json" },
      { surface: "claude_desktop", client: "claude_code", path: "revocation-drill-claude-code.json" },
      { surface: "chatgpt_desktop", client: "chatgpt_codex_host", path: "revocation-drill-chatgpt.json" },
    ],
    sessionRevocationEvidence: [
      { surface: "claude_desktop", client: "claude_desktop_chat", path: "session-revocation-claude.json" },
      { surface: "claude_desktop", client: "claude_code", path: "session-revocation-claude-code.json" },
      { surface: "chatgpt_desktop", client: "chatgpt_codex_host", path: "session-revocation-chatgpt.json" },
    ],
    rosterPreflightEvidence: { path: "roster-preflight.json" },
    sessionIssuanceEvidence: { path: "issued-sessions/manifest.json" },
    desktopConfigEvidence: { path: "desktop-configs/manifest.json" },
    desktopDeliveryEvidence: { path: "desktop-delivery.json" },
    desktopUserTests: [
      { surface: "claude_desktop", client: "claude_desktop_chat", path: "desktop-claude.json" },
      { surface: "claude_desktop", client: "claude_code", path: "desktop-claude-code.json" },
      { surface: "chatgpt_desktop", client: "chatgpt_codex_host", path: "desktop-chatgpt.json" },
    ],
    permissionFreshnessEvidence: {
  removedReqDisappearedOnNextRead: true,
  addedReqAppearedWithoutDeploy: true,
  privateNotesDropped: true,
  scopedVsUnscopedLeakageSamplePassed: true,
  durableAccessTestedWithoutRoutineReverification: true,
  verifiedAt: "2026-06-23T00:00:00.000Z",
  verifiedBy: "ops-reviewer@example.com",
  removedReqId: 123,
  removedReqRowsBeforeRemoval: 1,
  removedReqRowsAfterRemoval: 0,
  addedReqId: 456,
  addedReqRowsBeforeAddition: 0,
  addedReqRowsAfterAddition: 1,
  privateNoteId: 789,
  privateNoteRowsReturnedAfterScope: 0,
  durableSessionEmail: "recruiter@example.com",
  durableSessionSurface: "chatgpt_desktop",
  durableSessionTokenId: "chatgpt-token-id",
  durableSessionTokenIdAfterRestart: "chatgpt-token-id",
  durableSessionIssuedAt: "2026-06-23T00:00:00.000Z",
  durableSessionIssuedAtAfterRestart: "2026-06-23T00:00:00.000Z",
  routineReverificationPrompted: false,
},
    leakageSampleEvidence: { path: "leakage-sample.json" },
    auditReviewEvidence: { path: "audit-review.json" },
  });
}

async function writeIdentityBootstrapEvidence(dir: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await writeJson(join(dir, "identity-bootstrap-plan.json"), {
    ok: true,
    generatedAt: "2026-06-23T00:00:00.000Z",
    source: "greenhouse_users_roster_bootstrap",
    requestedEmailCount: 1,
    normalizedEmailCount: 1,
    resolved: [
      {
        email: "recruiter@example.com",
        greenhouseUserId: 123,
        row: {
          greenhouse_user_id: 123,
          primary_email: "recruiter@example.com",
          google_subject: null,
          slack_user_id: null,
          status: "resolved",
          source: "greenhouse_users_roster_bootstrap",
          evidence_detail: {
            source: "greenhouse_users_roster_bootstrap",
            matched_by: "work_email",
            matched_greenhouse_emails: ["recruiter@example.com"],
          },
          last_verified_at: "2026-06-23T00:00:00.000Z",
        },
      },
    ],
    denied: [],
    containsTokens: false,
    canApply: true,
    ...overrides,
  });
}

async function writeProductionEnvEvidence(dir: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await writeJson(join(dir, "production-env-check.json"), {
    ok: true,
    status: "ready",
    generatedAt: "2026-06-23T00:00:00.000Z",
    source: "env_file",
    envFile: "/secure/greenhouse-recruiter-production.env",
    configuredSurfaces: ["chatgpt_desktop", "claude_desktop"],
    // Derived from the canonical readiness catalog (the same source the gate now requires), so the
    // happy-path fixture and REQUIRED_PRODUCTION_ENV_CHECKS can never drift — and so scope_signing_secret,
    // which the old hand-list dropped, is always present here.
    checks: [...RECRUITER_MCP_READINESS_CHECK_NAMES].map((name) => ({ name, status: "pass", summary: `${name} passed.` })),
    ...overrides,
  });
}

async function writeRosterPreflightEvidence(dir: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await writeJson(join(dir, "roster-preflight.json"), {
    ok: true,
    generatedAt: "2026-06-23T00:00:00.000Z",
    rosterSource: "okta_group",
    verifiedBy: "ops-reviewer@example.com",
    requestedEmailCount: 1,
    normalizedEmailCount: 1,
    requestedSurfaces: ["claude_desktop", "chatgpt_desktop"],
    resolved: [
      {
        email: "recruiter@example.com",
        subject: "email:recruiter@example.com",
        greenhouseUserId: 123,
        surfaces: ["claude_desktop", "chatgpt_desktop"],
      },
    ],
    denied: [],
    containsTokens: false,
    canIssueSessions: true,
    ...overrides,
  });
}

async function writeSessionIssuanceEvidence(dir: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const outputDir = join(dir, "issued-sessions");
  await mkdir(outputDir, { recursive: true });
  const claudePath = join(outputDir, "recruiter-claude.json");
  const claudeCodePath = join(outputDir, "recruiter-claude-code.json");
  const chatgptPath = join(outputDir, "recruiter-chatgpt.json");
  await writeFile(claudePath, JSON.stringify({
    email: "recruiter@example.com",
    surface: "claude_desktop",
    client: "claude_desktop_chat",
    subject: "email:recruiter@example.com",
    tokenId: "claude-token-id",
    issuedAt: "2026-06-23T00:00:00.000Z",
    token: sessionToken("recruiter@example.com", "claude_desktop", "claude_desktop_chat", "claude-token-id"),
  }, null, 2), "utf8");
  await writeFile(claudeCodePath, JSON.stringify({
    email: "recruiter@example.com",
    surface: "claude_desktop",
    client: "claude_code",
    subject: "email:recruiter@example.com",
    tokenId: "claude-code-token-id",
    issuedAt: "2026-06-23T00:00:00.000Z",
    token: sessionToken("recruiter@example.com", "claude_desktop", "claude_code", "claude-code-token-id"),
  }, null, 2), "utf8");
  await writeFile(chatgptPath, JSON.stringify({
    email: "recruiter@example.com",
    surface: "chatgpt_desktop",
    client: "chatgpt_codex_host",
    subject: "email:recruiter@example.com",
    tokenId: "chatgpt-token-id",
    issuedAt: "2026-06-23T00:00:00.000Z",
    token: sessionToken("recruiter@example.com", "chatgpt_desktop", "chatgpt_codex_host", "chatgpt-token-id"),
  }, null, 2), "utf8");
  await writeJson(join(outputDir, "manifest.json"), {
    ok: true,
    outputDir: ".",
    manifestPath: "manifest.json",
    requestedEmailCount: 1,
    requestedSurfaces: ["claude_desktop", "chatgpt_desktop"],
    fileCount: 3,
    containsTokens: false,
    sessionFilesContainTokens: true,
    warning: "Manifest omits tokens; generated files are sensitive.",
    files: [
      { email: "recruiter@example.com", surface: "claude_desktop", client: "claude_desktop_chat", subject: "email:recruiter@example.com", tokenId: "claude-token-id", issuedAt: "2026-06-23T00:00:00.000Z", path: "recruiter-claude.json" },
      { email: "recruiter@example.com", surface: "claude_desktop", client: "claude_code", subject: "email:recruiter@example.com", tokenId: "claude-code-token-id", issuedAt: "2026-06-23T00:00:00.000Z", path: "recruiter-claude-code.json" },
      { email: "recruiter@example.com", surface: "chatgpt_desktop", client: "chatgpt_codex_host", subject: "email:recruiter@example.com", tokenId: "chatgpt-token-id", issuedAt: "2026-06-23T00:00:00.000Z", path: "recruiter-chatgpt.json" },
    ],
    ...overrides,
  });
}

async function writeDesktopConfigEvidence(dir: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const outputDir = join(dir, "desktop-configs");
  await mkdir(outputDir, { recursive: true });
  const claudePath = join(outputDir, "recruiter-claude.json");
  const claudeCodePath = join(outputDir, "recruiter-claude-code.json");
  const chatgptPath = join(outputDir, "recruiter-chatgpt.json");
  await writeFile(claudePath, JSON.stringify({
    mcpServers: {
      "greenhouse-recruiter": {
        url: "https://greenhouse-recruiter.example.com/mcp",
        headers: { Authorization: `Bearer ${sessionToken("recruiter@example.com", "claude_desktop", "claude_desktop_chat", "claude-token-id")}` },
      },
    },
  }, null, 2), "utf8");
  await writeFile(claudeCodePath, JSON.stringify({
    mcpServers: {
      "greenhouse-recruiter": {
        type: "http",
        url: "https://greenhouse-recruiter.example.com/mcp",
        headers: { Authorization: `Bearer ${sessionToken("recruiter@example.com", "claude_desktop", "claude_code", "claude-code-token-id")}` },
      },
    },
  }, null, 2), "utf8");
  await writeFile(chatgptPath, JSON.stringify({
    type: "mcp",
    server_label: "greenhouse-recruiter",
    server_url: "https://greenhouse-recruiter.example.com/mcp",
    authorization: sessionToken("recruiter@example.com", "chatgpt_desktop", "chatgpt_codex_host", "chatgpt-token-id"),
    require_approval: "always",
    allowed_tools: RECRUITER_TOOL_NAMES,
  }, null, 2), "utf8");
  await writeJson(join(outputDir, "manifest.json"), {
    ok: true,
    outputDir: ".",
    manifestPath: "manifest.json",
    fileCount: 3,
    containsTokens: false,
    configFilesContainTokens: true,
    warning: "Manifest omits tokens; generated files are sensitive.",
    files: [
      { email: "recruiter@example.com", surface: "claude_desktop", client: "claude_desktop_chat", tokenId: "claude-token-id", subject: "email:recruiter@example.com", issuedAt: "2026-06-23T00:00:00.000Z", path: "recruiter-claude.json" },
      { email: "recruiter@example.com", surface: "claude_desktop", client: "claude_code", tokenId: "claude-code-token-id", subject: "email:recruiter@example.com", issuedAt: "2026-06-23T00:00:00.000Z", path: "recruiter-claude-code.json" },
      { email: "recruiter@example.com", surface: "chatgpt_desktop", client: "chatgpt_codex_host", tokenId: "chatgpt-token-id", subject: "email:recruiter@example.com", issuedAt: "2026-06-23T00:00:00.000Z", path: "recruiter-chatgpt.json" },
    ],
    ...overrides,
  });
}

async function writeDesktopDeliveryEvidence(dir: string, overrides: Partial<DesktopDeliveryFixture> = {}): Promise<void> {
  await writeJson(join(dir, "desktop-delivery.json"), desktopDelivery(overrides));
}

function desktopDelivery(overrides: Partial<DesktopDeliveryFixture> = {}): DesktopDeliveryFixture {
  return {
    ok: true,
    deliveredAt: "2026-06-23T00:00:00.000Z",
    deliveredBy: "ops-reviewer@example.com",
    deliveryChannel: "managed_desktop_install",
    containsTokens: false,
    deliveries: [deliveryEntry("claude_desktop_chat"), deliveryEntry("claude_code"), deliveryEntry("chatgpt_codex_host")],
    ...overrides,
  };
}

function deliveryEntry(client: RecruiterClient): DesktopDeliveryEntryFixture {
  const surface: DesktopSurface = client === "chatgpt_codex_host" ? "chatgpt_desktop" : "claude_desktop";
  const tokenId = client === "claude_desktop_chat" ? "claude-token-id" : client === "claude_code" ? "claude-code-token-id" : "chatgpt-token-id";
  const filename = client === "claude_desktop_chat" ? "recruiter-claude.json" : client === "claude_code" ? "recruiter-claude-code.json" : "recruiter-chatgpt.json";
  return {
    email: "recruiter@example.com",
    recipientEmail: "recruiter@example.com",
    surface,
    client,
    tokenId,
    issuedAt: "2026-06-23T00:00:00.000Z",
    configPath: join("desktop-configs", filename),
    deliveryChannel: "managed_desktop_install",
    deliveredToMatchingRecruiter: true,
  };
}

function revocationDrill(
  overrides: Partial<RevocationDrillFixture> = {},
  client: RecruiterClient = "chatgpt_codex_host"
): RevocationDrillFixture {
  const surface: DesktopSurface = client === "chatgpt_codex_host" ? "chatgpt_desktop" : "claude_desktop";
  const activeTokenId = client === "claude_desktop_chat" ? "claude-token-id" : client === "claude_code" ? "claude-code-token-id" : "chatgpt-token-id";
  return {
    reportVersion: 2,
    ok: true,
    status: "pass",
    checkedAt: "2026-06-23T00:00:00.000Z",
    mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
    activeSessionSurface: surface,
    activeSessionClient: client,
    activeSessionTokenId: activeTokenId,
    activeSessionIssuedAt: "2026-06-23T00:00:00.000Z",
    revokedSessionSurface: surface,
    revokedSessionClient: client,
    revokedSessionTokenId: `revoked-${client}-token-id`,
    revokedSessionIssuedAt: "2026-06-23T00:00:00.000Z",
    containsTokens: false,
    checks: [
      { name: "active_token_metadata", status: "pass", summary: "active metadata" },
      { name: "revoked_token_metadata", status: "pass", summary: "revoked metadata" },
      { name: "matching_client_identity", status: "pass", summary: "matching client" },
      { name: "distinct_token_ids", status: "pass", summary: "distinct ids" },
      { name: "active_initialize", status: "pass", summary: "active initialized" },
      { name: "revoked_initialize_denied", status: "pass", summary: "revoked denied" },
    ],
    ...overrides,
  };
}

function sessionRevocation(
  overrides: Partial<SessionRevocationFixture> = {},
  client: RecruiterClient = "chatgpt_codex_host"
): SessionRevocationFixture {
  return {
    ok: true,
    revokedAt: "2026-06-23T00:00:00.000Z",
    table: "recruiter_mcp_session_revocation",
    tokenId: `revoked-${client}-token-id`,
    status: "revoked",
    revokedBy: "ops-reviewer@example.com",
    reason: "revocation drill",
    containsTokens: false,
    ...overrides,
  };
}

function auditReview(overrides: Partial<AuditReviewFixture> = {}): AuditReviewFixture {
  return {
    reportVersion: 2,
    ok: true,
    status: "pass",
    reviewer: "ops-reviewer@example.com",
    reviewedAt: "2026-06-23T00:00:00.000Z",
    auditPath: "/secure/audit.jsonl",
    totalEvents: 12,
    successEvents: 8,
    denialEvents: 4,
    v2StartEvents: 12,
    v2TerminalEvents: 12,
    undatedLegacyEvents: 0,
    unmatchedV2StartEvents: 0,
    legacyUnknownV2TerminalEvents: 0,
    surfaces: ["chatgpt_desktop", "claude_desktop"],
    v2Clients: ["claude_desktop_chat", "claude_code", "chatgpt_codex_host"],
    toolKinds: ["analysis", "evidence"],
    retainedAuditSink: true,
    successEventsPresent: true,
    denialEventsPresent: true,
    surfaceCoveragePresent: true,
    v2ClientCoveragePresent: true,
    toolKindCoveragePresent: true,
    noSensitivePayloadsFound: true,
    checks: [
      { name: "audit_v2_client_coverage", status: "pass", summary: "all clients" },
      { name: "audit_v2_pair_attribution", status: "pass", summary: "paired attribution" },
    ],
    ...overrides,
  };
}

function leakageSample(overrides: Partial<LeakageSampleFixture> = {}): LeakageSampleFixture {
  return {
    ok: true,
    strict: true,
    generatedAt: "2026-06-23T00:00:00.000Z",
    surface: "chatgpt_desktop",
    client: "chatgpt_codex_host",
    sessionSubjectPresent: true,
    sessionTokenId: "chatgpt-token-id",
    sessionIssuedAt: "2026-06-23T00:00:00.000Z",
    actAsUser: 123,
    checks: [
      {
        name: "operator_unscoped_sample",
        status: "pass",
        summary: "Operator sample passed.",
        details: { scoped: false, permissionScopeKind: "operator", rowsReturned: 10 },
      },
      {
        name: "act_as_user_scoped_sample",
        status: "pass",
        summary: "Preview sample passed.",
        details: { actAsUser: 123, effectiveActorId: 123, scoped: true, permissionScopeKind: "jobs", permittedJobCount: 3 },
      },
      {
        name: "forbidden_job_leakage",
        status: "pass",
        summary: "Known forbidden job was hidden from scoped preview.",
        details: { jobId: 999, unscopedVisible: true, scopedVisible: false },
      },
    ],
    auditEventCount: 5,
    buildCommit: EXPECTED_COMMIT,
    ...overrides,
  };
}

function probeReport(options: {
  strict: boolean;
  rowsReturned: number;
  profile?: "small_req_set" | "many_req_set" | "all_jobs_or_operator" | "no_permissions";
}) {
  const profile = options.profile ?? "small_req_set";
  const permissionScopeKind = profile === "all_jobs_or_operator" ? "operator" : "jobs";
  const permittedJobCount = profile === "small_req_set" ? 2 : profile === "many_req_set" ? 42 : profile === "no_permissions" ? 0 : null;
  const scope = { scoped: permissionScopeKind !== "operator", permissionScopeKind, permittedJobCount };
  const dataCount = profile === "no_permissions" ? 0 : Math.max(1, options.rowsReturned);
  return {
    ok: true,
    strict: options.strict,
    profile,
    buildCommit: EXPECTED_COMMIT,
    generatedAt: "2026-06-23T00:00:00.000Z",
    surface: "chatgpt_desktop",
    client: "chatgpt_codex_host",
    sessionSubjectPresent: true,
    sessionTokenId: "chatgpt-token-id",
    sessionIssuedAt: "2026-06-23T00:00:00.000Z",
    auditEventCount: 12,
    checks: [
      { name: "scoped_jobs_sample", status: "pass", summary: "sample", details: { rowsReturned: options.rowsReturned, ...scope } },
      { name: "expected_job_visibility", status: options.strict ? "pass" : "skip", summary: "expected" },
      { name: "forbidden_job_exclusion", status: "pass", summary: "forbidden" },
      { name: "endpoint_contract_jobs_ids", status: "pass", summary: "jobs ids" },
      { name: "endpoint_contract_forbidden_jobs_ids", status: "pass", summary: "forbidden jobs ids" },
      { name: "endpoint_contract_applications_ids", status: "pass", summary: "applications ids" },
      { name: "endpoint_contract_applications_job_ids", status: "pass", summary: "applications job_ids" },
      { name: "endpoint_contract_applications_candidate_ids", status: "pass", summary: "applications candidate_ids" },
      { name: "endpoint_contract_scorecards_application_ids", status: "pass", summary: "scorecards application_ids" },
      { name: "scoped_applications_sample", status: "pass", summary: "applications", details: { rowsReturned: dataCount, ...scope } },
      { name: "candidate_shape_sample", status: "pass", summary: "candidates", details: { rowsReturned: dataCount, ...scope } },
      { name: "scorecard_shape_sample", status: "pass", summary: "scorecards", details: { rowsReturned: dataCount, ...scope } },
      { name: "notes_visibility_sample", status: "pass", summary: "notes", details: { rowsReturned: dataCount, gatedFieldLeaks: 0, ...scope } },
      { name: "scorecard_accountability_analysis", status: "pass", summary: "scorecard analysis", details: { totalScorecards: dataCount, ...scope } },
      { name: "interview_feedback_drag_analysis", status: "pass", summary: "feedback analysis", details: { scorecardsConsidered: dataCount, ...scope } },
      { name: "stage_latency_analysis", status: "pass", summary: "stage analysis", details: { applicationsConsidered: dataCount, ...scope } },
      { name: "pipeline_quality_analysis", status: "pass", summary: "pipeline analysis", details: { applicationsConsidered: dataCount, ...scope } },
      { name: "source_quality_analysis", status: "pass", summary: "source analysis", details: { applicationsConsidered: dataCount, ...scope } },
      { name: "rejection_reason_drift_analysis", status: "pass", summary: "rejection reason drift analysis", details: { rejectionsConsidered: dataCount, ...scope } },
      { name: "question_planner_analysis", status: "pass", summary: "planner analysis", details: { rowsRead: dataCount, rowsConsidered: dataCount, ...scope } },
      { name: "activity_endpoint_shape", status: "skip", summary: "activity v1 skipped" },
    ],
  };
}

function distributionReport(
  client: RecruiterClient = "chatgpt_codex_host",
  tokenId: string = client === "claude_desktop_chat" ? "claude-token-id" : client === "claude_code" ? "claude-code-token-id" : "chatgpt-token-id",
  issuedAt = "2026-06-23T00:00:00.000Z"
) {
  const surface: DesktopSurface = client === "chatgpt_codex_host" ? "chatgpt_desktop" : "claude_desktop";
  return {
    ok: true,
    status: "ready",
    checkedAt: "2026-06-23T00:00:00.000Z",
    mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
    healthUrl: "https://greenhouse-recruiter.example.com/healthz",
    readinessUrl: "https://greenhouse-recruiter.example.com/readyz",
    versionUrl: "https://greenhouse-recruiter.example.com/version",
    expectedCommit: EXPECTED_COMMIT,
    observedCommit: EXPECTED_COMMIT,
    sessionSurface: surface,
    sessionClient: client,
    sessionTokenId: tokenId,
    sessionIssuedAt: issuedAt,
    checks: [
      { name: "healthz", status: "pass", summary: "health" },
      { name: "readyz_unauthorized_denied", status: "pass", summary: "protected ready" },
      { name: "readyz", status: "pass", summary: "ready" },
      { name: "version_commit", status: "pass", summary: "expected candidate commit" },
      { name: "mcp_initialize", status: "pass", summary: "initialize" },
      { name: "mcp_tools_list", status: "pass", summary: "tools/list" },
      { name: "expected_tool_catalog", status: "pass", summary: "tools" },
      { name: "no_unexpected_tools", status: "pass", summary: "exact catalog" },
      { name: "exact_tool_catalog", status: "pass", summary: "duplicate-free exact catalog" },
      { name: "no_write_tools", status: "pass", summary: "no writes" },
      { name: "read_only_tool_annotations", status: "pass", summary: "read-only annotations" },
    ],
    toolNames: RECRUITER_TOOL_NAMES,
  };
}

function desktopReport(client: RecruiterClient, overrides: Partial<DesktopReportFixture> = {}): DesktopReportFixture {
  const surface: DesktopSurface = client === "chatgpt_codex_host" ? "chatgpt_desktop" : "claude_desktop";
  const tokenId = client === "claude_desktop_chat" ? "claude-token-id" : client === "claude_code" ? "claude-code-token-id" : "chatgpt-token-id";
  const issuedAt = "2026-06-23T00:00:00.000Z";
  return {
    status: "pass",
    surface,
    client,
    testedAt: "2026-06-23T00:00:00.000Z",
    tester: "recruiter@example.com",
    testerEmail: "recruiter@example.com",
    mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
    sessionTokenId: tokenId,
    sessionTokenIdAfterRestart: tokenId,
    sessionIssuedAt: issuedAt,
    sessionIssuedAtAfterRestart: issuedAt,
    durableSessionAccess: true,
    sessionPersistedAcrossRestart: true,
    routineReverificationPrompted: false,
    attachmentMethod: client === "claude_desktop_chat" ? "claude_desktop_mcpb" : client === "claude_code" ? "claude_code_http_mcp" : "chatgpt_developer_mode_remote_mcp",
    exercisedTools: ROUTING_TOOLS,
    writeOrAdminToolsVisible: false,
    containsTokens: false,
    taskOutcome: "useful",
    taskOutcomeReason: "answer_received",
    clientVersion: "test-client-1.0",
    modelVersion: "test-model-1.0",
    routingTestVersion: ROUTING_TEST_VERSION,
    routingChecks: ROUTING_CHECKS,
    resumeInstructionsTreatedAsUntrusted: true,
    warning: DESKTOP_USER_TEST_EVIDENCE_WARNING,
    ...overrides,
  };
}

function validObservedTools(routingCase: (typeof DESKTOP_ROUTING_CASES)[number], runIndex = 0): string[] {
  const required: Readonly<Record<string, number>> = routingCase.requiredToolCounts;
  const requireAnyOf: readonly string[] = "requireAnyOf" in routingCase ? routingCase.requireAnyOf : [];
  const alternatives = requireAnyOf.filter((tool) => !required[tool]);
  const chosenAlternative = alternatives[runIndex % alternatives.length];
  return routingCase.allowedTools.flatMap((tool) => {
    const count = required[tool] ?? (tool === chosenAlternative ? 1 : 0);
    return Array.from({ length: count }, () => tool);
  });
}

function sessionToken(
  email: string,
  surface: DesktopSurface,
  client: RecruiterClient,
  tokenId: string,
  issuedAt = "2026-06-23T00:00:00.000Z"
): string {
  const normalizedEmail = email.trim().toLowerCase();
  const payload = Buffer.from(JSON.stringify({
    subject: `email:${normalizedEmail}`,
    email: normalizedEmail,
    surface,
    client,
    tokenId,
    issuedAt,
  }), "utf8").toString("base64url");
  return `${payload}.signature`;
}

async function updateJson(path: string, mutate: (value: Record<string, unknown>) => void): Promise<void> {
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  mutate(value);
  await writeJson(path, value);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
