import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runRolloutStatus } from "../src/rollout-status.js";

const now = () => new Date("2026-06-23T00:00:00.000Z");

describe("rollout evidence status", () => {
  it("reports the first operator action when the rollout manifest is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-status-"));
    const report = await runRolloutStatus({ manifestPath: join(dir, "manifest.json"), now });
    const serialized = JSON.stringify(report);

    assert.equal(report.ok, false);
    assert.equal(report.status, "not_ready");
    assert.equal(report.manifestPresent, false);
    assert.equal(report.evidenceFilesMissing, 1);
    assert.equal(report.evidenceFiles[0]?.label, "manifest");
    assert.match(report.nextActions.join("\\n"), /greenhouse-recruiter-init-rollout-evidence/);
    assert.doesNotMatch(serialized, /ENOENT|no such file|stack/i);
  });

  it("summarizes missing rollout artifacts before the full gate can pass", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-status-"));
    await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifestFixture(), null, 2)}\n`, "utf8");

    const report = await runRolloutStatus({ manifestPath: join(dir, "manifest.json"), now });
    const labels = report.evidenceFiles.filter((entry) => entry.status === "missing").map((entry) => entry.label);

    assert.equal(report.ok, false);
    assert.equal(report.manifestPresent, true);
    assert.equal(report.manifestReadable, true);
    assert.equal(report.evidenceFilesTotal, 23);
    assert.equal(report.evidenceFilesPresent, 0);
    assert.equal(report.evidenceFilesMissing, 23);
    assert.ok(labels.includes("live_probe:small_req_set"));
    assert.ok(labels.includes("distribution:chatgpt_codex_host"));
    assert.ok(labels.includes("production_env"));
    assert.ok(report.gateChecksFailing > 0);
    assert.match(report.nextActions.join("\\n"), /missing evidence artifacts/);
  });

  it("flags non-portable manifest paths without reading outside the rollout directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-status-"));
    const manifest = manifestFixture();
    manifest.productionEnvEvidence.path = "/tmp/production-env-check.json";
    manifest.auditReviewEvidence.path = "../audit-review.json";
    await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const report = await runRolloutStatus({ manifestPath: join(dir, "manifest.json"), now });
    const invalid = report.evidenceFiles.filter((entry) => entry.status === "invalid_path");

    assert.equal(report.ok, false);
    assert.equal(report.evidenceFilesInvalid, 2);
    assert.deepEqual(invalid.map((entry) => entry.label).sort(), ["audit_review", "production_env"]);
    assert.deepEqual(invalid.map((entry) => entry.reason).sort(), ["absolute_path", "path_escapes_rollout_dir"]);
    assert.equal(invalid.some((entry) => "path" in entry), false);
  });
});

function manifestFixture() {
  return {
    version: 2,
    candidate: {
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      commit: "151dbc3fa5a9099875604bc96dd6882a9f7fcf97",
    },
    liveProbes: [
      { profile: "small_req_set", path: "live-probe-small-req-set.json", strict: true },
      { profile: "many_req_set", path: "live-probe-many-req-set.json", strict: true },
      { profile: "all_jobs_or_operator", path: "live-probe-all-jobs-or-operator.json", strict: true },
      { profile: "no_permissions", path: "live-probe-no-permissions.json", strict: false, expectZeroVisibleJobs: true },
    ],
    distributionValidations: [
      { surface: "claude_desktop", client: "claude_desktop_chat", path: "distribution-claude-desktop.json" },
      { surface: "claude_desktop", client: "claude_code", path: "distribution-claude-code.json" },
      { surface: "chatgpt_desktop", client: "chatgpt_codex_host", path: "distribution-chatgpt-desktop.json" },
    ],
    productionEnvEvidence: { path: "production-env-check.json" },
    revocationDrillEvidence: [
      { surface: "claude_desktop", client: "claude_desktop_chat", path: "revocation-drill-claude-desktop.json" },
      { surface: "claude_desktop", client: "claude_code", path: "revocation-drill-claude-code.json" },
      { surface: "chatgpt_desktop", client: "chatgpt_codex_host", path: "revocation-drill-chatgpt.json" },
    ],
    sessionRevocationEvidence: [
      { surface: "claude_desktop", client: "claude_desktop_chat", path: "session-revocation-claude-desktop.json" },
      { surface: "claude_desktop", client: "claude_code", path: "session-revocation-claude-code.json" },
      { surface: "chatgpt_desktop", client: "chatgpt_codex_host", path: "session-revocation-chatgpt.json" },
    ],
    rosterPreflightEvidence: { path: "roster-preflight.json" },
    sessionIssuanceEvidence: { path: "issued-sessions/manifest.json" },
    desktopConfigEvidence: { path: "desktop-configs/manifest.json" },
    desktopDeliveryEvidence: { path: "desktop-delivery.json" },
    desktopUserTests: [
      { surface: "claude_desktop", client: "claude_desktop_chat", path: "desktop-claude-desktop.json" },
      { surface: "claude_desktop", client: "claude_code", path: "desktop-claude-code.json" },
      { surface: "chatgpt_desktop", client: "chatgpt_codex_host", path: "desktop-chatgpt-desktop.json" },
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
  };
}
