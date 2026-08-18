import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runRolloutEvidenceInit } from "../src/rollout-evidence-init.js";
import { runRolloutGate } from "../src/rollout-gate.js";
import { DESKTOP_ROUTING_CASES, MIN_ROUTING_RUNS, ROUTING_TEST_VERSION } from "../src/desktop-user-test.js";

describe("rollout evidence initializer", () => {
  it("writes a red-by-default evidence scaffold for durable desktop access", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-evidence-init-"));

    const report = await runRolloutEvidenceInit({ outputDir: dir });
    const manifest = JSON.parse(await readFile(report.manifestPath, "utf8"));
    const chatgptDesktop = JSON.parse(await readFile(join(dir, "desktop-chatgpt-desktop.json"), "utf8"));
    const claudeDesktop = JSON.parse(await readFile(join(dir, "desktop-claude-desktop.json"), "utf8"));
    const claudeCode = JSON.parse(await readFile(join(dir, "desktop-claude-code.json"), "utf8"));
    const desktopDelivery = JSON.parse(await readFile(join(dir, "desktop-delivery.json"), "utf8"));
    const revocationDrill = JSON.parse(await readFile(join(dir, "revocation-drill-chatgpt-codex.json"), "utf8"));
    const sessionRevocation = JSON.parse(await readFile(join(dir, "session-revocation-chatgpt-codex.json"), "utf8"));
    const productionEnv = JSON.parse(await readFile(join(dir, "production-env-check.json"), "utf8"));
    const readme = await readFile(join(dir, "README.md"), "utf8");
    const runbook = await readFile(join(dir, "RUNBOOK.md"), "utf8");

    assert.equal(report.ok, true);
    assert.equal(report.filesWritten.includes("manifest.json"), true);
    assert.equal(report.filesWritten.includes("RUNBOOK.md"), true);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(report.manifestPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "RUNBOOK.md"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "desktop-chatgpt-desktop.json"))).mode & 0o777, 0o600);
    assert.equal(manifest.version, 2);
    assert.deepEqual(manifest.permissionFreshnessEvidence, {
      removedReqDisappearedOnNextRead: false,
      addedReqAppearedWithoutDeploy: false,
      privateNotesDropped: false,
      scopedVsUnscopedLeakageSamplePassed: false,
      durableAccessTestedWithoutRoutineReverification: false,
      verifiedAt: "",
      verifiedBy: "",
      removedReqId: 0,
      removedReqRowsBeforeRemoval: 0,
      removedReqRowsAfterRemoval: -1,
      addedReqId: 0,
      addedReqRowsBeforeAddition: -1,
      addedReqRowsAfterAddition: 0,
      privateNoteId: 0,
      privateNoteRowsReturnedAfterScope: -1,
      durableSessionEmail: "",
      durableSessionSurface: "",
      durableSessionTokenId: "",
      durableSessionTokenIdAfterRestart: "",
      durableSessionIssuedAt: "",
      durableSessionIssuedAtAfterRestart: "",
      routineReverificationPrompted: true,
    });
    assert.deepEqual(manifest.leakageSampleEvidence, { path: "leakage-sample.json" });
    assert.deepEqual(manifest.productionEnvEvidence, { path: "production-env-check.json" });
    assert.deepEqual(manifest.revocationDrillEvidence.map((entry: { client: string }) => entry.client), [
      "claude_desktop_chat",
      "claude_code",
      "chatgpt_codex_host",
    ]);
    assert.deepEqual(manifest.sessionRevocationEvidence.map((entry: { client: string }) => entry.client), [
      "claude_desktop_chat",
      "claude_code",
      "chatgpt_codex_host",
    ]);
    assert.deepEqual(manifest.rosterPreflightEvidence, { path: "roster-preflight.json" });
    assert.deepEqual(manifest.sessionIssuanceEvidence, { path: "issued-sessions/manifest.json" });
    assert.deepEqual(manifest.desktopConfigEvidence, { path: "desktop-configs/manifest.json" });
    assert.deepEqual(manifest.desktopDeliveryEvidence, { path: "desktop-delivery.json" });
    assert.equal(desktopDelivery.ok, false);
    assert.equal(desktopDelivery.containsTokens, false);
    for (const desktop of [chatgptDesktop, claudeDesktop, claudeCode]) {
      assert.equal(desktop.status, "pending");
      assert.equal(desktop.clientVersion, "");
      assert.equal(desktop.modelVersion, "");
      assert.equal(desktop.routingTestVersion, ROUTING_TEST_VERSION);
      assert.deepEqual(desktop.routingChecks, DESKTOP_ROUTING_CASES.map(({ caseId }) => ({
        caseId,
        runs: Array.from({ length: MIN_ROUTING_RUNS }, (_, index) => ({
          run: index + 1,
          observedTools: [],
          passed: false,
        })),
      })));
      assert.equal(desktop.resumeInstructionsTreatedAsUntrusted, false);
      assert.equal(desktop.writeOrAdminToolsVisible, true);
      assert.equal(desktop.containsTokens, false);
    }
    assert.equal(revocationDrill.ok, false);
    assert.equal(revocationDrill.reportVersion, 2);
    assert.equal(revocationDrill.activeSessionClient, "chatgpt_codex_host");
    assert.equal(revocationDrill.containsTokens, false);
    assert.equal(sessionRevocation.ok, false);
    assert.equal(sessionRevocation.containsTokens, false);
    assert.equal(productionEnv.ok, false);
    assert.equal(productionEnv.source, "env_file");
    assert.deepEqual(productionEnv.configuredSurfaces, []);
    assert.equal(report.filesWritten.includes("desktop-delivery.json"), true);
    assert.equal(report.filesWritten.includes("production-env-check.json"), true);
    assert.equal(report.filesWritten.includes("revocation-drill-claude-desktop.json"), true);
    assert.equal(report.filesWritten.includes("revocation-drill-claude-code.json"), true);
    assert.equal(report.filesWritten.includes("revocation-drill-chatgpt-codex.json"), true);
    assert.equal(report.filesWritten.includes("session-revocation-claude-desktop.json"), true);
    assert.equal(report.filesWritten.includes("session-revocation-claude-code.json"), true);
    assert.equal(report.filesWritten.includes("session-revocation-chatgpt-codex.json"), true);
    assert.equal(chatgptDesktop.status, "pending");
    assert.equal(chatgptDesktop.testerEmail, "");
    assert.equal(chatgptDesktop.sessionTokenId, "");
    assert.equal(chatgptDesktop.sessionTokenIdAfterRestart, "");
    assert.equal(chatgptDesktop.sessionIssuedAt, "");
    assert.equal(chatgptDesktop.sessionIssuedAtAfterRestart, "");
    assert.equal(chatgptDesktop.attachmentMethod, "chatgpt_developer_mode_remote_mcp");
    assert.equal(chatgptDesktop.durableSessionAccess, false);
    assert.equal(chatgptDesktop.routineReverificationPrompted, true);
    assert.equal(claudeDesktop.status, "pending");
    assert.equal(claudeDesktop.attachmentMethod, "claude_desktop_mcpb");
    assert.equal(claudeDesktop.sessionPersistedAcrossRestart, false);
    assert.equal(claudeCode.client, "claude_code");
    assert.equal(claudeCode.attachmentMethod, "claude_code_http_mcp");
    assert.deepEqual(manifest.distributionValidations.map((entry: { client: string }) => entry.client), [
      "claude_desktop_chat",
      "claude_code",
      "chatgpt_codex_host",
    ]);
    assert.match(runbook, /durable at-will recruiter access/);
    assert.match(readme, /routing-test v2 results for all 25 canonical cases with at least 3 ordered observed-tool runs per case/);
    assert.match(readme, /Prompts, responses, ATS records, and resume text never belong in evidence JSON/);
    assert.match(readme, /GREENHOUSE_RECRUITER_ROLLOUT_LIVE_READYZ_URL=https:\/\/greenhouse-recruiter-mcp\.example\.com\/readyz/);
    assert.match(readme, /GREENHOUSE_RECRUITER_READYZ_TOKEN=<operator-readyz-token>/);
    assert.match(readme, /re-fetches that candidate's public `\/version`/);
    assert.match(runbook, /greenhouse-recruiter-preflight-roster[\s\S]*--surface both[\s\S]*--source okta_group[\s\S]*--verified-by ops-reviewer@example\.com/);
    assert.match(runbook, /greenhouse-recruiter-check-production-env --env-file \.\/greenhouse-recruiter-production\.env > production-env-check\.json/);
    assert.match(runbook, /--production-env \.\/production-env-check\.json/);
    assert.match(runbook, /greenhouse-recruiter-validate-distribution[\s\S]*sessionTokenId/);
    assert.match(runbook, /GREENHOUSE_RECRUITER_REMOTE_READY_TOKEN=<operator-readyz-token>/);
    assert.match(runbook, /greenhouse-recruiter-revoke-session[\s\S]*--token-id <revoked-token-id>[\s\S]*> session-revocation-claude-desktop\.json/);
    assert.match(runbook, /Do not paste the signed token into the revocation table command/);
    assert.match(runbook, /greenhouse-recruiter-revocation-drill[\s\S]*GREENHOUSE_RECRUITER_REVOKED_SESSION_TOKEN=<revoked-drill-token>/);
    assert.doesNotMatch(runbook, /GREENHOUSE_RECRUITER_REVOKED_TOKEN_IDS/);
    assert.match(runbook, /token metadata matches the token-free manifests/);
    assert.match(runbook, /name the physical `client` and actual `attachmentMethod` tested/);
    assert.match(runbook, /include the non-secret `sessionTokenId` and `sessionIssuedAt` issued for that tester\/client pair plus matching `sessionTokenIdAfterRestart` and `sessionIssuedAtAfterRestart`/);
    assert.match(runbook, /generated payload alone is not sufficient client proof/);
    assert.match(runbook, /client\/model versions shown by that client/);
    assert.deepEqual(DESKTOP_ROUTING_CASES.map(({ caseId }) => caseId), [
      "critical_offer_acceptance_rate",
      "aggregate_offer_acceptance_by_source",
      "critical_candidates_stuck",
      "critical_source_quality_change",
      "critical_late_scorecards",
      "critical_rejection_reason_drift",
      "open_resume_summary",
      "compare_resumes_to_job",
      "list_candidate_files",
      "candidate_work_education",
      "interviewer_actual_feedback",
      "candidate_rejection_reason",
      "requisition_ownership",
      "candidate_stage_history",
      "candidate_origin",
      "scheduled_interview_event",
      "interviewer_panel",
      "candidate_note",
      "job_note_unavailable",
      "source_name_lookup",
      "scorecard_summary",
      "exact_application_record",
      "confirm_job_scope",
      "get_job_scope",
      "untrusted_resume_instruction",
    ]);
    assert.match(runbook, /What is our offer acceptance rate last quarter/);
    assert.match(runbook, /Compare offer acceptance rates by source last quarter/);
    assert.match(runbook, /Open and summarize this candidate's resume/);
    assert.match(runbook, /Compare these two resumes against the job requirements/);
    assert.match(runbook, /When is this candidate's next scheduled interview/);
    assert.match(runbook, /Show notes attached to this requisition/);
    assert.match(runbook, /authorized_test_attachment_id_with_document_instruction/);
    assert.match(runbook, /Record tool selection, not prompt or response content/);
    assert.match(runbook, /every canonical routing case at least 3 times/);
    assert.match(runbook, /routing-checks-chatgpt\.txt/);
    assert.match(runbook, /routing_args\[@\]/);
    assert.match(runbook, /--client chatgpt_codex_host/);
    assert.match(runbook, /--client-version/);
    assert.match(runbook, /--model-version/);
    assert.match(runbook, /--task-outcome useful/);
    assert.match(runbook, /--task-outcome-reason answer_received/);
    assert.match(runbook, /job_note_unavailable=/);
    assert.match(runbook, /tool_a\+tool_b/);
    assert.match(runbook, /--attest-resume-instructions-untrusted/);
    assert.match(runbook, /missing real-client results remain pending and block rollout/i);
    assert.match(runbook, /missing zero-regression comparison as a manual release blocker/);
    assert.match(runbook, /GREENHOUSE_RECRUITER_EXPECTED_COMMIT_SHA/);
    assert.match(runbook, /GREENHOUSE_RECRUITER_PROBE_PROFILE=small_req_set/);
    assert.match(runbook, /GREENHOUSE_RECRUITER_BUILD_SHA=<40-character-candidate-git-sha>/);
    assert.match(runbook, /--candidate-mcp-url https:\/\/greenhouse-recruiter-mcp\.example\.com\/mcp/);
    assert.match(runbook, /--candidate-commit <40-character-candidate-git-sha>/);
    assert.match(runbook, /greenhouse-recruiter-build-rollout-manifest \\\n  --force \\\n  --out \.\/manifest\.json/);
    assert.match(runbook, /unauthenticated `?\/readyz`? denial/);
    assert.match(runbook, /session\/config token ids and issued-at timestamps agree for every recruiter\/surface\/client identity/);
    assert.match(runbook, /revocation-drill-claude-code\.json[\s\S]*revocation-drill-chatgpt-codex\.json/);
    assert.match(runbook, /audit sample must remain metadata-only and include success and denial events plus paired v2 terminal attribution/);
    assert.match(runbook, /durable-session-email/);
    assert.match(runbook, /Permission-freshness durable session fields must name the recruiter work email/);
    assert.match(runbook, /desktop-delivery\.json/);
    assert.match(runbook, /greenhouse-recruiter-record-desktop-delivery/);
    assert.match(runbook, /greenhouse-recruiter-record-desktop-test/);
    assert.match(runbook, /--attest-session-persisted-across-restart/);
    assert.match(runbook, /--attest-no-routine-reverification/);
    assert.match(runbook, /GREENHOUSE_RECRUITER_ROLLOUT_EVIDENCE_MANIFEST=\.\/manifest\.json \\\nGREENHOUSE_RECRUITER_ROLLOUT_LIVE_READYZ_URL=https:\/\/greenhouse-recruiter-mcp\.example\.com\/readyz \\\nGREENHOUSE_RECRUITER_READYZ_TOKEN=<operator-readyz-token> \\\ngreenhouse-recruiter-rollout-gate/);
    assert.match(runbook, /greenhouse-recruiter-pack-rollout-evidence/);
    assert.match(runbook, /token-free-review-bundle/);
    assert.match(runbook, /copies only manifest-referenced evidence JSON/);
    assert.match(runbook, /--private-notes-dropped \\\n  --scoped-vs-unscoped-leakage-sample-passed \\\n  --durable-access-tested-without-routine-reverification \\\n  --permission-freshness-verified-at/);
    assert.doesNotMatch(runbook, /--private-notes-dropped\s+--scoped-vs-unscoped-leakage-sample-passed/);
    assert.doesNotMatch(runbook, /Signal|SMS|short-lived|expiresAt|expires_at/);

    const gate = await runRolloutGate({
      manifestPath: report.manifestPath,
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });

    assert.equal(gate.ok, false);
    assert.equal(gate.status, "not_ready");
    assert.equal(gate.checks.find((check) => check.name === "manifest_shape")?.status, "pass");
    assert.equal(gate.checks.find((check) => check.name === "production_env_preflight")?.status, "fail");
    assert.equal(gate.checks.find((check) => check.name === "permission_freshness_and_leakage")?.status, "fail");
    assert.equal(gate.checks.find((check) => check.name === "revocation_drill_chatgpt_codex_host")?.status, "fail");
    assert.equal(gate.checks.find((check) => check.name === "session_revocation_write_chatgpt_codex_host")?.status, "fail");
    assert.equal(gate.checks.find((check) => check.name === "roster_preflight")?.status, "fail");
    assert.equal(gate.checks.find((check) => check.name === "session_issuance_manifest")?.status, "fail");
    assert.equal(gate.checks.find((check) => check.name === "desktop_config_manifest")?.status, "fail");
    assert.equal(gate.checks.find((check) => check.name === "desktop_config_delivery")?.status, "fail");
    assert.equal(gate.checks.find((check) => check.name === "desktop_chatgpt_codex_host")?.status, "fail");
    assert.equal(gate.checks.find((check) => check.name === "desktop_claude_code")?.status, "fail");
    assert.equal(gate.checks.find((check) => check.name === "leakage_sample")?.status, "fail");
    assert.equal(gate.checks.find((check) => check.name === "live_probe_small_req_set")?.status, "fail");
    assert.equal(gate.checks.find((check) => check.name === "audit_review")?.status, "fail");
  });

  it("does not overwrite changed scaffold files unless force is set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-evidence-init-"));
    await runRolloutEvidenceInit({ outputDir: dir });
    await writeFile(join(dir, "manifest.json"), "{}\n", "utf8");

    await assert.rejects(
      () => runRolloutEvidenceInit({ outputDir: dir }),
      /manifest\.json already exists; pass --force to overwrite scaffold files\./
    );
  });

  it("can force-regenerate the scaffold", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-evidence-init-"));
    await runRolloutEvidenceInit({ outputDir: dir });
    await writeFile(join(dir, "manifest.json"), "{}\n", "utf8");

    const report = await runRolloutEvidenceInit({ outputDir: dir, force: true });
    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));

    assert.equal(report.filesWritten.includes("manifest.json"), true);
    assert.equal(manifest.version, 2);
  });

  it("repairs permissions on unchanged scaffold files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-evidence-init-"));
    const initial = await runRolloutEvidenceInit({ outputDir: dir });
    await chmod(dir, 0o755);
    await chmod(initial.manifestPath, 0o644);

    const rerun = await runRolloutEvidenceInit({ outputDir: dir });

    assert.equal(rerun.filesWritten.length, 0);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(initial.manifestPath)).mode & 0o777, 0o600);
  });
});
