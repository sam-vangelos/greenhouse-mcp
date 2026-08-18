import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseRolloutManifestBuildArgs, runRolloutManifestBuild } from "../src/rollout-manifest-builder.js";
import { runRolloutGate } from "../src/rollout-gate.js";

const COMPLETE_PERMISSION_FLAGS = {
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
  durableSessionSurface: "chatgpt_desktop" as const,
  durableSessionTokenId: "chatgpt-token-id",
  durableSessionTokenIdAfterRestart: "chatgpt-token-id",
  durableSessionIssuedAt: "2026-06-23T00:00:00.000Z",
  durableSessionIssuedAtAfterRestart: "2026-06-23T00:00:00.000Z",
  routineReverificationPrompted: false,
};
const COMPLETE_CANDIDATE = {
  candidateMcpUrl: "https://greenhouse-recruiter.example.com/mcp",
  candidateCommit: "151dbc3fa5a9099875604bc96dd6882a9f7fcf97",
};

describe("rollout manifest builder", () => {
  it("builds the final rollout manifest shape from default evidence paths", async () => {
    const report = await runRolloutManifestBuild({
      ...COMPLETE_CANDIDATE,
      permissionFreshnessEvidence: COMPLETE_PERMISSION_FLAGS,
    });

    assert.equal(report.ok, true);
    assert.equal(report.manifestPath, null);
    assert.equal(report.manifest.version, 2);
    assert.deepEqual(report.manifest.candidate, {
      mcpUrl: COMPLETE_CANDIDATE.candidateMcpUrl,
      commit: COMPLETE_CANDIDATE.candidateCommit,
    });
    assert.deepEqual(report.manifest.liveProbes.map((entry) => entry.profile), [
      "small_req_set",
      "many_req_set",
      "all_jobs_or_operator",
      "no_permissions",
    ]);
    assert.deepEqual(report.manifest.distributionValidations.map((entry) => `${entry.surface}:${entry.client}`), [
      "claude_desktop:claude_desktop_chat",
      "claude_desktop:claude_code",
      "chatgpt_desktop:chatgpt_codex_host",
    ]);
    assert.deepEqual(report.manifest.desktopUserTests.map((entry) => entry.client), [
      "claude_desktop_chat",
      "claude_code",
      "chatgpt_codex_host",
    ]);
    assert.deepEqual(report.manifest.productionEnvEvidence, { path: "production-env-check.json" });
    assert.deepEqual(report.manifest.revocationDrillEvidence.map((entry) => entry.client), [
      "claude_desktop_chat",
      "claude_code",
      "chatgpt_codex_host",
    ]);
    assert.deepEqual(report.manifest.sessionRevocationEvidence.map((entry) => entry.client), [
      "claude_desktop_chat",
      "claude_code",
      "chatgpt_codex_host",
    ]);
    assert.deepEqual(report.manifest.rosterPreflightEvidence, { path: "roster-preflight.json" });
    assert.deepEqual(report.manifest.sessionIssuanceEvidence, { path: "issued-sessions/manifest.json" });
    assert.deepEqual(report.manifest.desktopConfigEvidence, { path: "desktop-configs/manifest.json" });
    assert.deepEqual(report.manifest.desktopDeliveryEvidence, { path: "desktop-delivery.json" });
    assert.deepEqual(report.manifest.permissionFreshnessEvidence, COMPLETE_PERMISSION_FLAGS);
  });

  it("writes override paths while still leaving evidence validation to the rollout gate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-manifest-builder-"));
    const manifestPath = join(dir, "nested", "manifest.json");

    const report = await runRolloutManifestBuild({
      ...COMPLETE_CANDIDATE,
      outputPath: manifestPath,
      paths: {
        smallReqProbe: "probes/small.json",
        productionEnv: "env/production-env-check.json",
        revocationDrill: "drills/revocation.json",
        claudeRevocationDrill: "drills/claude-revocation.json",
        claudeCodeRevocationDrill: "drills/claude-code-revocation.json",
        sessionRevocation: "drills/session-revocation.json",
        claudeSessionRevocation: "drills/claude-session-revocation.json",
        claudeCodeSessionRevocation: "drills/claude-code-session-revocation.json",
        identityBootstrap: "identity/bootstrap-plan.json",
        rosterPreflight: "rosters/preflight.json",
        sessionIssuance: "sessions/manifest.json",
        desktopConfig: "configs/manifest.json",
        desktopDelivery: "delivery/report.json",
        auditReview: "audit/review.json",
      },
      permissionFreshnessEvidence: COMPLETE_PERMISSION_FLAGS,
    });
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

    assert.equal(report.manifestPath, manifestPath);
    assert.equal(manifest.liveProbes[0].path, "probes/small.json");
    assert.equal(manifest.productionEnvEvidence.path, "env/production-env-check.json");
    assert.deepEqual(manifest.revocationDrillEvidence.map((entry: { path: string }) => entry.path), [
      "drills/claude-revocation.json",
      "drills/claude-code-revocation.json",
      "drills/revocation.json",
    ]);
    assert.deepEqual(manifest.sessionRevocationEvidence.map((entry: { path: string }) => entry.path), [
      "drills/claude-session-revocation.json",
      "drills/claude-code-session-revocation.json",
      "drills/session-revocation.json",
    ]);
    assert.equal(manifest.identityBootstrapEvidence.path, "identity/bootstrap-plan.json");
    assert.equal(manifest.rosterPreflightEvidence.path, "rosters/preflight.json");
    assert.equal(manifest.sessionIssuanceEvidence.path, "sessions/manifest.json");
    assert.equal(manifest.desktopConfigEvidence.path, "configs/manifest.json");
    assert.equal(manifest.desktopDeliveryEvidence.path, "delivery/report.json");
    assert.equal(manifest.auditReviewEvidence.path, "audit/review.json");

    const gate = await runRolloutGate({
      manifestPath,
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });
    assert.equal(gate.ok, false);
    assert.equal(gate.checks.find((check) => check.name === "manifest_shape")?.status, "pass");
    assert.equal(gate.checks.find((check) => check.name === "live_probe_small_req_set")?.status, "fail");
    assert.equal(gate.checks.find((check) => check.name === "roster_preflight")?.status, "fail");
    assert.equal(gate.checks.find((check) => check.name === "session_issuance_manifest")?.status, "fail");
    assert.equal(gate.checks.find((check) => check.name === "audit_review")?.status, "fail");
  });

  it("stores cwd-relative evidence paths under the output directory as manifest-relative paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-manifest-builder-"));
    const originalCwd = process.cwd();

    try {
      process.chdir(dir);
      const report = await runRolloutManifestBuild({
        ...COMPLETE_CANDIDATE,
        outputPath: "rollout-evidence/manifest.json",
        paths: {
        smallReqProbe: "./rollout-evidence/probes/small.json",
        productionEnv: "rollout-evidence/env/production-env-check.json",
        sessionIssuance: "rollout-evidence/issued-sessions/manifest.json",
          desktopConfig: "rollout-evidence/desktop-configs/manifest.json",
        },
        permissionFreshnessEvidence: COMPLETE_PERMISSION_FLAGS,
      });
      assert.ok(report.manifestPath);
      const manifest = JSON.parse(await readFile(report.manifestPath, "utf8"));

      assert.equal(report.manifestPath, join(process.cwd(), "rollout-evidence", "manifest.json"));
      assert.equal(report.manifest.liveProbes[0].path, "probes/small.json");
      assert.equal(report.manifest.productionEnvEvidence.path, "env/production-env-check.json");
      assert.equal(report.manifest.sessionIssuanceEvidence.path, "issued-sessions/manifest.json");
      assert.equal(report.manifest.desktopConfigEvidence.path, "desktop-configs/manifest.json");
      assert.equal(manifest.liveProbes[0].path, "probes/small.json");
      assert.equal(manifest.productionEnvEvidence.path, "env/production-env-check.json");
      assert.equal(manifest.sessionIssuanceEvidence.path, "issued-sessions/manifest.json");
      assert.equal(manifest.desktopConfigEvidence.path, "desktop-configs/manifest.json");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("rejects evidence paths that cannot be made portable under the output directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-manifest-builder-"));
    const manifestPath = join(dir, "rollout-evidence", "manifest.json");

    await assert.rejects(
      () => runRolloutManifestBuild({
        ...COMPLETE_CANDIDATE,
        outputPath: manifestPath,
        paths: { smallReqProbe: join(dir, "outside", "small.json") },
        permissionFreshnessEvidence: COMPLETE_PERMISSION_FLAGS,
      }),
      /Evidence path smallReqProbe must be inside the rollout evidence directory/
    );

    await assert.rejects(
      () => runRolloutManifestBuild({
        ...COMPLETE_CANDIDATE,
        outputPath: manifestPath,
        paths: { manyReqProbe: "../outside.json" },
        permissionFreshnessEvidence: COMPLETE_PERMISSION_FLAGS,
      }),
      /Evidence path manyReqProbe must not escape the rollout evidence directory/
    );
  });

  it("requires every permission freshness confirmation before building a final manifest", async () => {
    await assert.rejects(
      () => runRolloutManifestBuild({
        permissionFreshnessEvidence: {
          removedReqDisappearedOnNextRead: true,
        },
      }),
      /--added-req-appeared-without-deploy.*--private-notes-dropped.*--scoped-vs-unscoped-leakage-sample-passed.*--durable-access-tested-without-routine-reverification.*--permission-freshness-verified-at/
    );
  });

  it("requires an exact production candidate MCP URL and commit", async () => {
    await assert.rejects(
      () => runRolloutManifestBuild({ permissionFreshnessEvidence: COMPLETE_PERMISSION_FLAGS }),
      /--candidate-mcp-url is required/
    );
    await assert.rejects(
      () => runRolloutManifestBuild({
        candidateMcpUrl: "https://user:secret@greenhouse-recruiter.example.com/mcp?token=secret",
        candidateCommit: COMPLETE_CANDIDATE.candidateCommit,
        permissionFreshnessEvidence: COMPLETE_PERMISSION_FLAGS,
      }),
      /exact production HTTPS \/mcp URL without credentials, query, or fragment/
    );
    for (const candidateMcpUrl of [
      "https://[::1]/mcp",
      "https://[::ffff:127.0.0.1]/mcp",
      "https://0.0.0.0/mcp",
      "https://10.0.0.1/mcp",
    ]) {
      await assert.rejects(
        () => runRolloutManifestBuild({
          candidateMcpUrl,
          candidateCommit: COMPLETE_CANDIDATE.candidateCommit,
          permissionFreshnessEvidence: COMPLETE_PERMISSION_FLAGS,
        }),
        /exact production HTTPS \/mcp URL without credentials, query, or fragment/,
        candidateMcpUrl
      );
    }
    await assert.rejects(
      () => runRolloutManifestBuild({
        candidateMcpUrl: COMPLETE_CANDIDATE.candidateMcpUrl,
        candidateCommit: "not-a-sha",
        permissionFreshnessEvidence: COMPLETE_PERMISSION_FLAGS,
      }),
      /exact 40-character Git SHA/
    );
  });

  it("rejects non-exact durable session metadata in permission freshness confirmations", async () => {
    await assert.rejects(
      () => runRolloutManifestBuild({
        permissionFreshnessEvidence: {
          ...COMPLETE_PERMISSION_FLAGS,
          durableSessionTokenId: " chatgpt-token-id",
          durableSessionTokenIdAfterRestart: " chatgpt-token-id",
          durableSessionIssuedAt: "2026-06-23T00:00:00Z",
          durableSessionIssuedAtAfterRestart: "2026-06-23T00:00:00Z",
        },
      }),
      /--durable-session-token-id.*--durable-session-token-id-after-restart.*--durable-session-issued-at.*--durable-session-issued-at-after-restart/
    );
  });

  it("rejects unsafe programmatic permission freshness ids and counts", async () => {
    await assert.rejects(
      () => runRolloutManifestBuild({
        permissionFreshnessEvidence: {
          ...COMPLETE_PERMISSION_FLAGS,
          removedReqId: Number.MAX_SAFE_INTEGER + 1,
          addedReqRowsAfterAddition: Number.MAX_SAFE_INTEGER + 1,
        },
      }),
      /--removed-req-id.*--added-req-rows-after/
    );
  });

  it("does not overwrite an existing manifest unless force is set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-manifest-builder-"));
    const manifestPath = join(dir, "manifest.json");
    await writeFile(manifestPath, "{}\n", "utf8");

    await assert.rejects(
      () => runRolloutManifestBuild({
        ...COMPLETE_CANDIDATE,
        outputPath: manifestPath,
        permissionFreshnessEvidence: COMPLETE_PERMISSION_FLAGS,
      }),
      /already exists; pass --force to overwrite it/
    );

    const report = await runRolloutManifestBuild({
      ...COMPLETE_CANDIDATE,
      outputPath: manifestPath,
      force: true,
      permissionFreshnessEvidence: COMPLETE_PERMISSION_FLAGS,
    });
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

    assert.equal(report.ok, true);
    assert.equal(manifest.version, 2);
  });

  it("parses command-line path overrides and permission confirmations", () => {
    const options = parseRolloutManifestBuildArgs([
      "--out", "rollout-evidence/manifest.json",
      "--force",
      "--candidate-mcp-url", COMPLETE_CANDIDATE.candidateMcpUrl,
      "--candidate-commit", COMPLETE_CANDIDATE.candidateCommit,
      "--small-req-probe", "probes/small.json",
      "--production-env", "env/production-env-check.json",
      "--revocation-drill", "drills/revocation.json",
      "--claude-revocation-drill", "drills/claude-revocation.json",
      "--claude-code-revocation-drill", "drills/claude-code-revocation.json",
      "--session-revocation", "drills/session-revocation.json",
      "--claude-session-revocation", "drills/claude-session-revocation.json",
      "--claude-code-session-revocation", "drills/claude-code-session-revocation.json",
      "--roster-preflight", "rosters/preflight.json",
      "--session-issuance", "sessions/manifest.json",
      "--desktop-config", "configs/manifest.json",
      "--desktop-delivery", "delivery/report.json",
      "--claude-code-distribution", "distribution/claude-code.json",
      "--claude-code-desktop-test", "desktop/claude-code.json",
      "--removed-req-disappeared-on-next-read",
      "--added-req-appeared-without-deploy",
      "--private-notes-dropped",
      "--scoped-vs-unscoped-leakage-sample-passed",
      "--durable-access-tested-without-routine-reverification",
      "--permission-freshness-verified-at", "2026-06-23T00:00:00.000Z",
      "--permission-freshness-verified-by", "ops-reviewer@example.com",
      "--removed-req-id", "123",
      "--removed-req-rows-before", "1",
      "--removed-req-rows-after", "0",
      "--added-req-id", "456",
      "--added-req-rows-before", "0",
      "--added-req-rows-after", "1",
      "--private-note-id", "789",
      "--private-note-rows-returned", "0",
      "--durable-session-email", "Recruiter@Example.com",
      "--durable-session-surface", "chatgpt_desktop",
      "--durable-session-token-id", "chatgpt-token-id",
      "--durable-session-token-id-after-restart", "chatgpt-token-id",
      "--durable-session-issued-at", "2026-06-23T00:00:00.000Z",
      "--durable-session-issued-at-after-restart", "2026-06-23T00:00:00.000Z",
    ]);

    assert.equal(options.outputPath, "rollout-evidence/manifest.json");
    assert.equal(options.force, true);
    assert.equal(options.candidateMcpUrl, COMPLETE_CANDIDATE.candidateMcpUrl);
    assert.equal(options.candidateCommit, COMPLETE_CANDIDATE.candidateCommit);
    assert.equal(options.paths?.smallReqProbe, "probes/small.json");
    assert.equal(options.paths?.productionEnv, "env/production-env-check.json");
    assert.equal(options.paths?.revocationDrill, "drills/revocation.json");
    assert.equal(options.paths?.claudeRevocationDrill, "drills/claude-revocation.json");
    assert.equal(options.paths?.claudeCodeRevocationDrill, "drills/claude-code-revocation.json");
    assert.equal(options.paths?.sessionRevocation, "drills/session-revocation.json");
    assert.equal(options.paths?.claudeSessionRevocation, "drills/claude-session-revocation.json");
    assert.equal(options.paths?.claudeCodeSessionRevocation, "drills/claude-code-session-revocation.json");
    assert.equal(options.paths?.rosterPreflight, "rosters/preflight.json");
    assert.equal(options.paths?.sessionIssuance, "sessions/manifest.json");
    assert.equal(options.paths?.desktopConfig, "configs/manifest.json");
    assert.equal(options.paths?.desktopDelivery, "delivery/report.json");
    assert.equal(options.paths?.claudeCodeDistribution, "distribution/claude-code.json");
    assert.equal(options.paths?.claudeCodeDesktopTest, "desktop/claude-code.json");
    assert.deepEqual(options.permissionFreshnessEvidence, COMPLETE_PERMISSION_FLAGS);
  });

  it("rejects malformed numeric permission confirmations instead of prefix-parsing them", () => {
    assert.throws(
      () => parseRolloutManifestBuildArgs(["--removed-req-id", "123abc"]),
      /--removed-req-id must be an exact non-negative integer/
    );
    assert.throws(
      () => parseRolloutManifestBuildArgs(["--added-req-rows-before", " 0"]),
      /--added-req-rows-before must be an exact non-negative integer/
    );
    assert.throws(
      () => parseRolloutManifestBuildArgs(["--private-note-id", "9007199254740993"]),
      /--private-note-id must be a safe non-negative integer/
    );
  });
});
