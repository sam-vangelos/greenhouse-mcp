import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  DESKTOP_USER_TEST_EVIDENCE_WARNING,
  DESKTOP_ROUTING_CASES,
  MIN_ROUTING_RUNS,
  ROUTING_TEST_VERSION,
  buildDesktopUserTestEvidenceFromManifests,
  validateDesktopRoutingAttestation,
  writeDesktopUserTestEvidenceFile,
} from "../src/desktop-user-test.js";
import { PILOT_TOOL_NAMES } from "../src/tools/register.js";

const ROUTING_CHECKS = DESKTOP_ROUTING_CASES.flatMap((routingCase) => Array.from(
  { length: MIN_ROUTING_RUNS },
  (_, index) => ({ caseId: routingCase.caseId, observedTools: validObservedTools(routingCase, index) })
));
const ROUTING_TOOLS = [...new Set(ROUTING_CHECKS.flatMap(({ observedTools }) => observedTools))];
const ROUTING_ATTESTATION = {
  clientVersion: "ChatGPT Desktop 1.2026.175",
  modelVersion: "gpt-5.4",
  routingChecks: ROUTING_CHECKS,
  resumeInstructionsTreatedAsUntrusted: true,
} as const;

describe("desktop user-test evidence", () => {
  it("builds token-free attestation evidence bound to issued and desktop manifests", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-desktop-user-test-"));
    const sessionManifestPath = join(tmp, "issued-sessions-manifest.json");
    const desktopManifestPath = join(tmp, "desktop-config-manifest.json");
    await writeSessionManifest(sessionManifestPath);
    await writeDesktopManifest(desktopManifestPath);

    const report = await buildDesktopUserTestEvidenceFromManifests({
      surface: "chatgpt_desktop",
      testerEmail: "Recruiter.One@Company.com",
      tester: "Recruiter One",
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      attachmentMethod: "chatgpt_developer_mode_remote_mcp",
      sessionIssuanceManifestPath: sessionManifestPath,
      desktopConfigManifestPath: desktopManifestPath,
      sessionTokenIdAfterRestart: "chatgpt-token-id",
      sessionIssuedAtAfterRestart: "2026-06-23T00:00:00.000Z",
      exercisedTools: ROUTING_TOOLS,
      testedAt: "2026-06-23T00:00:00.000Z",
      durableSessionAccess: true,
      sessionPersistedAcrossRestart: true,
      routineReverificationPrompted: false,
      writeOrAdminToolsVisible: false,
      taskOutcome: "useful",
      taskOutcomeReason: "answer_received",
      ...ROUTING_ATTESTATION,
    });

    assert.equal(report.status, "pass");
    assert.equal(report.containsTokens, false);
    assert.equal(report.testerEmail, "recruiter.one@company.com");
    assert.equal(report.sessionTokenId, "chatgpt-token-id");
    assert.equal(report.sessionTokenIdAfterRestart, "chatgpt-token-id");
    assert.equal(report.sessionIssuedAt, "2026-06-23T00:00:00.000Z");
    assert.equal(report.sessionIssuedAtAfterRestart, "2026-06-23T00:00:00.000Z");
    assert.deepEqual(report.exercisedTools, ROUTING_TOOLS);
    assert.equal(report.taskOutcome, "useful");
    assert.equal(report.taskOutcomeReason, "answer_received");
    assert.equal(report.clientVersion, "ChatGPT Desktop 1.2026.175");
    assert.equal(report.modelVersion, "gpt-5.4");
    assert.equal(report.routingTestVersion, ROUTING_TEST_VERSION);
    assert.deepEqual(report.routingChecks, DESKTOP_ROUTING_CASES.map((routingCase) => ({
      caseId: routingCase.caseId,
      runs: Array.from({ length: MIN_ROUTING_RUNS }, (_, index) => ({
        run: index + 1,
        observedTools: validObservedTools(routingCase, index),
        passed: true,
      })),
    })));
    assert.equal(report.resumeInstructionsTreatedAsUntrusted, true);
    assert.deepEqual(validateDesktopRoutingAttestation(report), { ok: true, problems: [] });
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes("durable-user-token"), false);
    assert.equal(serialized.includes("What is our offer acceptance rate last quarter?"), false);
    assert.equal(serialized.includes("<visible_application_id>"), false);
    assert.doesNotMatch(serialized, /"token"|"authorization"|"Authorization"|"config"/);
  });

  it("records Claude Code with its own client-bound credential and attachment method", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-desktop-user-test-"));
    const sessionManifestPath = join(tmp, "issued-sessions-manifest.json");
    const desktopManifestPath = join(tmp, "desktop-config-manifest.json");
    const files = manifestFiles().map((file) => file.surface === "claude_desktop"
      ? { ...file, client: "claude_code", path: "recruiter-one-claude-code.json" }
      : file);
    await writeSessionManifest(sessionManifestPath, files);
    await writeDesktopManifest(desktopManifestPath, files);

    const report = await buildDesktopUserTestEvidenceFromManifests({
      surface: "claude_desktop",
      client: "claude_code",
      testerEmail: "recruiter.one@company.com",
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      attachmentMethod: "claude_code_http_mcp",
      sessionIssuanceManifestPath: sessionManifestPath,
      desktopConfigManifestPath: desktopManifestPath,
      sessionTokenIdAfterRestart: "claude-token-id",
      sessionIssuedAtAfterRestart: "2026-06-23T00:00:00.000Z",
      exercisedTools: ROUTING_TOOLS,
      testedAt: "2026-06-23T00:00:00.000Z",
      durableSessionAccess: true,
      sessionPersistedAcrossRestart: true,
      routineReverificationPrompted: false,
      writeOrAdminToolsVisible: false,
      taskOutcome: "useful",
      taskOutcomeReason: "answer_received",
      ...ROUTING_ATTESTATION,
    });

    assert.equal(report.client, "claude_code");
    assert.equal(report.attachmentMethod, "claude_code_http_mcp");
  });

  it("rejects post-restart metadata that does not match the durable issued session", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-desktop-user-test-"));
    const sessionManifestPath = join(tmp, "issued-sessions-manifest.json");
    const desktopManifestPath = join(tmp, "desktop-config-manifest.json");
    await writeSessionManifest(sessionManifestPath);
    await writeDesktopManifest(desktopManifestPath);

    await assert.rejects(
      buildDesktopUserTestEvidenceFromManifests({
        surface: "claude_desktop",
        testerEmail: "recruiter.one@company.com",
        mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
        attachmentMethod: "claude_desktop_mcpb",
        sessionIssuanceManifestPath: sessionManifestPath,
        desktopConfigManifestPath: desktopManifestPath,
        sessionTokenIdAfterRestart: "new-session-token-id",
        sessionIssuedAtAfterRestart: "2026-06-23T00:00:00.000Z",
        exercisedTools: ["analyze_scorecard_accountability"],
        durableSessionAccess: true,
        sessionPersistedAcrossRestart: true,
        routineReverificationPrompted: false,
        writeOrAdminToolsVisible: false,
      }),
      /Post-restart token id must match/
    );
  });

  it("rejects non-exact durable token metadata in post-restart attestations", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-desktop-user-test-"));
    const sessionManifestPath = join(tmp, "issued-sessions-manifest.json");
    const desktopManifestPath = join(tmp, "desktop-config-manifest.json");
    await writeSessionManifest(sessionManifestPath);
    await writeDesktopManifest(desktopManifestPath);

    await assert.rejects(
      buildDesktopUserTestEvidenceFromManifests({
        surface: "chatgpt_desktop",
        testerEmail: "recruiter.one@company.com",
        mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
        attachmentMethod: "chatgpt_developer_mode_remote_mcp",
        sessionIssuanceManifestPath: sessionManifestPath,
        desktopConfigManifestPath: desktopManifestPath,
        sessionTokenIdAfterRestart: " chatgpt-token-id",
        sessionIssuedAtAfterRestart: "2026-06-23T00:00:00.000Z",
        exercisedTools: ["search_my_jobs", "analyze_scorecard_accountability"],
        durableSessionAccess: true,
        sessionPersistedAcrossRestart: true,
        routineReverificationPrompted: false,
        writeOrAdminToolsVisible: false,
      }),
      /sessionTokenIdAfterRestart.*token id/
    );

    await assert.rejects(
      buildDesktopUserTestEvidenceFromManifests({
        surface: "chatgpt_desktop",
        testerEmail: "recruiter.one@company.com",
        mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
        attachmentMethod: "chatgpt_developer_mode_remote_mcp",
        sessionIssuanceManifestPath: sessionManifestPath,
        desktopConfigManifestPath: desktopManifestPath,
        sessionTokenIdAfterRestart: "chatgpt-token-id",
        sessionIssuedAtAfterRestart: "2026-06-23T00:00:00Z",
        exercisedTools: ["search_my_jobs", "analyze_scorecard_accountability"],
        durableSessionAccess: true,
        sessionPersistedAcrossRestart: true,
        routineReverificationPrompted: false,
        writeOrAdminToolsVisible: false,
      }),
      /sessionIssuedAtAfterRestart.*issued-at/
    );
  });

  it("rejects non-exact durable token metadata in session or desktop manifests", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-desktop-user-test-"));
    const badSessionManifestPath = join(tmp, "bad-issued-sessions-manifest.json");
    const badDesktopManifestPath = join(tmp, "bad-desktop-config-manifest.json");
    const goodSessionManifestPath = join(tmp, "issued-sessions-manifest.json");
    const goodDesktopManifestPath = join(tmp, "desktop-config-manifest.json");
    await writeSessionManifest(goodSessionManifestPath);
    await writeDesktopManifest(goodDesktopManifestPath);
    await writeSessionManifest(badSessionManifestPath, [{ ...manifestFiles()[1], tokenId: "chatgpt token id" }]);
    await writeDesktopManifest(badDesktopManifestPath, [{ ...manifestFiles()[1], issuedAt: "2026-06-23T00:00:00Z" }]);

    await assert.rejects(
      buildDesktopUserTestEvidenceFromManifests({
        surface: "chatgpt_desktop",
        testerEmail: "recruiter.one@company.com",
        mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
        attachmentMethod: "chatgpt_developer_mode_remote_mcp",
        sessionIssuanceManifestPath: badSessionManifestPath,
        desktopConfigManifestPath: goodDesktopManifestPath,
        sessionTokenIdAfterRestart: "chatgpt-token-id",
        sessionIssuedAtAfterRestart: "2026-06-23T00:00:00.000Z",
        exercisedTools: ["search_my_jobs", "analyze_scorecard_accountability"],
        durableSessionAccess: true,
        sessionPersistedAcrossRestart: true,
        routineReverificationPrompted: false,
        writeOrAdminToolsVisible: false,
      }),
      /session issuance manifest tokenId.*token id/
    );

    await assert.rejects(
      buildDesktopUserTestEvidenceFromManifests({
        surface: "chatgpt_desktop",
        testerEmail: "recruiter.one@company.com",
        mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
        attachmentMethod: "chatgpt_developer_mode_remote_mcp",
        sessionIssuanceManifestPath: goodSessionManifestPath,
        desktopConfigManifestPath: badDesktopManifestPath,
        sessionTokenIdAfterRestart: "chatgpt-token-id",
        sessionIssuedAtAfterRestart: "2026-06-23T00:00:00.000Z",
        exercisedTools: ["search_my_jobs", "analyze_scorecard_accountability"],
        durableSessionAccess: true,
        sessionPersistedAcrossRestart: true,
        routineReverificationPrompted: false,
        writeOrAdminToolsVisible: false,
      }),
      /desktop config manifest issuedAt.*issued-at/
    );
  });

  it("rejects session and desktop manifests that contain token or config payloads", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-desktop-user-test-"));
    const cases: Array<{
      name: string;
      sessionExtra?: Record<string, unknown>;
      desktopExtra?: Record<string, unknown>;
      error: RegExp;
    }> = [
      { name: "session-auth-token", sessionExtra: { authToken: "durable-user-token" }, error: /Session issuance manifest must not contain durable tokens/ },
      { name: "session-bearer-string", sessionExtra: { operatorNote: "proxy leaked Authorization: Bearer durable-session-token-value" }, error: /Session issuance manifest must not contain durable tokens/ },
      { name: "desktop-raw-config", desktopExtra: { rawConfig: { mcpServers: { greenhouse: {} } } }, error: /Desktop config manifest must not contain durable tokens/ },
      { name: "desktop-greenhouse-secret-string", desktopExtra: { operatorNote: "GREENHOUSE_RECRUITER_SESSION_TOKEN=durable-session-token-value" }, error: /Desktop config manifest must not contain durable tokens/ },
    ];

    for (const { name, sessionExtra, desktopExtra, error } of cases) {
      const sessionManifestPath = join(tmp, `${name}-issued-sessions-manifest.json`);
      const desktopManifestPath = join(tmp, `${name}-desktop-config-manifest.json`);
      await writeSessionManifest(sessionManifestPath, manifestFiles(), sessionExtra);
      await writeDesktopManifest(desktopManifestPath, manifestFiles(), desktopExtra);

      await assert.rejects(
        buildDesktopUserTestEvidenceFromManifests({
          surface: "chatgpt_desktop",
          testerEmail: "recruiter.one@company.com",
          mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
          attachmentMethod: "chatgpt_developer_mode_remote_mcp",
          sessionIssuanceManifestPath: sessionManifestPath,
          desktopConfigManifestPath: desktopManifestPath,
          sessionTokenIdAfterRestart: "chatgpt-token-id",
          sessionIssuedAtAfterRestart: "2026-06-23T00:00:00.000Z",
          exercisedTools: ["search_my_jobs", "analyze_scorecard_accountability"],
          durableSessionAccess: true,
          sessionPersistedAcrossRestart: true,
          routineReverificationPrompted: false,
          writeOrAdminToolsVisible: false,
        }),
        error
      );
    }
  });

  it("rejects session and desktop manifests with non-portable file paths", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-desktop-user-test-"));
    const goodSessionManifestPath = join(tmp, "issued-sessions-manifest.json");
    const goodDesktopManifestPath = join(tmp, "desktop-config-manifest.json");
    const badSessionManifestPath = join(tmp, "bad-issued-sessions-manifest.json");
    const badDesktopManifestPath = join(tmp, "bad-desktop-config-manifest.json");
    await writeSessionManifest(goodSessionManifestPath);
    await writeDesktopManifest(goodDesktopManifestPath);
    await writeSessionManifest(badSessionManifestPath, [{
      ...manifestFiles()[1],
      path: join(tmpdir(), "recruiter-one-chatgpt.json"),
    }]);
    await writeDesktopManifest(badDesktopManifestPath, [{
      ...manifestFiles()[1],
      path: "../desktop-configs/recruiter-one-chatgpt.json",
    }]);

    await assert.rejects(
      buildDesktopUserTestEvidenceFromManifests({
        surface: "chatgpt_desktop",
        testerEmail: "recruiter.one@company.com",
        mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
        attachmentMethod: "chatgpt_developer_mode_remote_mcp",
        sessionIssuanceManifestPath: badSessionManifestPath,
        desktopConfigManifestPath: goodDesktopManifestPath,
        sessionTokenIdAfterRestart: "chatgpt-token-id",
        sessionIssuedAtAfterRestart: "2026-06-23T00:00:00.000Z",
        exercisedTools: ["search_my_jobs", "analyze_scorecard_accountability"],
        durableSessionAccess: true,
        sessionPersistedAcrossRestart: true,
        routineReverificationPrompted: false,
        writeOrAdminToolsVisible: false,
      }),
      /portable relative path/
    );

    await assert.rejects(
      buildDesktopUserTestEvidenceFromManifests({
        surface: "chatgpt_desktop",
        testerEmail: "recruiter.one@company.com",
        mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
        attachmentMethod: "chatgpt_developer_mode_remote_mcp",
        sessionIssuanceManifestPath: goodSessionManifestPath,
        desktopConfigManifestPath: badDesktopManifestPath,
        sessionTokenIdAfterRestart: "chatgpt-token-id",
        sessionIssuedAtAfterRestart: "2026-06-23T00:00:00.000Z",
        exercisedTools: ["search_my_jobs", "analyze_scorecard_accountability"],
        durableSessionAccess: true,
        sessionPersistedAcrossRestart: true,
        routineReverificationPrompted: false,
        writeOrAdminToolsVisible: false,
      }),
      /portable relative path/
    );
  });

  it("requires explicit no-reverification and no-visible-write-admin attestations", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-desktop-user-test-"));
    const sessionManifestPath = join(tmp, "issued-sessions-manifest.json");
    const desktopManifestPath = join(tmp, "desktop-config-manifest.json");
    await writeSessionManifest(sessionManifestPath);
    await writeDesktopManifest(desktopManifestPath);

    await assert.rejects(
      buildDesktopUserTestEvidenceFromManifests({
        surface: "chatgpt_desktop",
        testerEmail: "recruiter.one@company.com",
        mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
        attachmentMethod: "chatgpt_developer_mode_remote_mcp",
        sessionIssuanceManifestPath: sessionManifestPath,
        desktopConfigManifestPath: desktopManifestPath,
        sessionTokenIdAfterRestart: "chatgpt-token-id",
        sessionIssuedAtAfterRestart: "2026-06-23T00:00:00.000Z",
        exercisedTools: ["analyze_scorecard_accountability"],
        durableSessionAccess: true,
        sessionPersistedAcrossRestart: true,
        routineReverificationPrompted: true,
        writeOrAdminToolsVisible: false,
      }),
      /no-routine-reverification/
    );
  });

  it("rejects evidence that did not exercise an analytical tool", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-desktop-user-test-"));
    const sessionManifestPath = join(tmp, "issued-sessions-manifest.json");
    const desktopManifestPath = join(tmp, "desktop-config-manifest.json");
    await writeSessionManifest(sessionManifestPath);
    await writeDesktopManifest(desktopManifestPath);

    await assert.rejects(
      buildDesktopUserTestEvidenceFromManifests({
        surface: "chatgpt_desktop",
        testerEmail: "recruiter.one@company.com",
        mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
        attachmentMethod: "chatgpt_developer_mode_remote_mcp",
        sessionIssuanceManifestPath: sessionManifestPath,
        desktopConfigManifestPath: desktopManifestPath,
        sessionTokenIdAfterRestart: "chatgpt-token-id",
        sessionIssuedAtAfterRestart: "2026-06-23T00:00:00.000Z",
        exercisedTools: ["search_my_jobs"],
        durableSessionAccess: true,
        sessionPersistedAcrossRestart: true,
        routineReverificationPrompted: false,
        writeOrAdminToolsVisible: false,
      }),
      /analytical tool/
    );
  });

  it("rejects evidence that did not exercise an evidence tool", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-desktop-user-test-"));
    const sessionManifestPath = join(tmp, "issued-sessions-manifest.json");
    const desktopManifestPath = join(tmp, "desktop-config-manifest.json");
    await writeSessionManifest(sessionManifestPath);
    await writeDesktopManifest(desktopManifestPath);

    await assert.rejects(
      buildDesktopUserTestEvidenceFromManifests({
        surface: "chatgpt_desktop",
        testerEmail: "recruiter.one@company.com",
        mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
        attachmentMethod: "chatgpt_developer_mode_remote_mcp",
        sessionIssuanceManifestPath: sessionManifestPath,
        desktopConfigManifestPath: desktopManifestPath,
        sessionTokenIdAfterRestart: "chatgpt-token-id",
        sessionIssuedAtAfterRestart: "2026-06-23T00:00:00.000Z",
        exercisedTools: ["analyze_scorecard_accountability"],
        durableSessionAccess: true,
        sessionPersistedAcrossRestart: true,
        routineReverificationPrompted: false,
        writeOrAdminToolsVisible: false,
      }),
      /evidence tool/
    );
  });

  it("requires a complete real-task outcome pair", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-desktop-user-test-"));
    const sessionManifestPath = join(tmp, "issued-sessions-manifest.json");
    const desktopManifestPath = join(tmp, "desktop-config-manifest.json");
    await writeSessionManifest(sessionManifestPath);
    await writeDesktopManifest(desktopManifestPath);

    const base = {
      surface: "chatgpt_desktop" as const,
      testerEmail: "recruiter.one@company.com",
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      attachmentMethod: "chatgpt_developer_mode_remote_mcp" as const,
      sessionIssuanceManifestPath: sessionManifestPath,
      desktopConfigManifestPath: desktopManifestPath,
      sessionTokenIdAfterRestart: "chatgpt-token-id",
      sessionIssuedAtAfterRestart: "2026-06-23T00:00:00.000Z",
      exercisedTools: ["search_my_jobs", "analyze_scorecard_accountability"],
      durableSessionAccess: true,
      sessionPersistedAcrossRestart: true,
      routineReverificationPrompted: false,
      writeOrAdminToolsVisible: false,
    };
    await assert.rejects(buildDesktopUserTestEvidenceFromManifests(base), /taskOutcome and taskOutcomeReason are required/);
    await assert.rejects(buildDesktopUserTestEvidenceFromManifests({ ...base, taskOutcome: "useful" }), /taskOutcomeReason is invalid/);
  });

  it("requires exact canonical routing, client/model versions, and untrusted-resume handling", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-desktop-user-test-"));
    const sessionManifestPath = join(tmp, "issued-sessions-manifest.json");
    const desktopManifestPath = join(tmp, "desktop-config-manifest.json");
    await writeSessionManifest(sessionManifestPath);
    await writeDesktopManifest(desktopManifestPath);
    const base = {
      surface: "chatgpt_desktop" as const,
      testerEmail: "recruiter.one@company.com",
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      attachmentMethod: "chatgpt_developer_mode_remote_mcp" as const,
      sessionIssuanceManifestPath: sessionManifestPath,
      desktopConfigManifestPath: desktopManifestPath,
      sessionTokenIdAfterRestart: "chatgpt-token-id",
      sessionIssuedAtAfterRestart: "2026-06-23T00:00:00.000Z",
      exercisedTools: ROUTING_TOOLS,
      durableSessionAccess: true,
      sessionPersistedAcrossRestart: true,
      routineReverificationPrompted: false,
      writeOrAdminToolsVisible: false,
      taskOutcome: "useful" as const,
      taskOutcomeReason: "answer_received" as const,
      ...ROUTING_ATTESTATION,
    };
    const visibleTools = new Set<string>(PILOT_TOOL_NAMES);
    assert.deepEqual(DESKTOP_ROUTING_CASES.slice(0, 15).map(({ testPrompt }) => testPrompt), [
      "What is our offer acceptance rate last quarter?",
      "Compare offer acceptance rates by source last quarter.",
      "Where are candidates stuck?",
      "How has source quality changed?",
      "Which interviewers are late submitting scorecards?",
      "How have rejection reasons drifted?",
      "Open and summarize this candidate's resume.",
      "Compare these two resumes against the job requirements.",
      "List this candidate's files.",
      "Show me this candidate's work and education history.",
      "What did interviewers actually say about this candidate?",
      "Why was this candidate rejected?",
      "Who owns this requisition and who is the hiring manager?",
      "Show the candidate's stage history.",
      "Where did this candidate come from?",
    ]);
    assert.deepEqual(
      [...new Set(DESKTOP_ROUTING_CASES.flatMap(({ allowedTools }) => allowedTools))].filter((tool) => !visibleTools.has(tool)),
      []
    );
    for (const routingCase of DESKTOP_ROUTING_CASES) {
      const allowed = new Set<string>(routingCase.allowedTools);
      assert.equal(Object.keys(routingCase.requiredToolCounts).every((tool) => allowed.has(tool)), true);
      if ("requireAnyOf" in routingCase) {
        assert.equal(routingCase.requireAnyOf.every((tool) => allowed.has(tool)), true);
      }
      assert.equal(routingCase.maxToolCalls >= Object.values(routingCase.requiredToolCounts).reduce((sum, count) => sum + count, 0), true);
      if ("mustPrecede" in routingCase) {
        assert.equal(routingCase.mustPrecede.every(([before, after]) => allowed.has(before) && allowed.has(after)), true);
      }
    }
    const validReport = await buildDesktopUserTestEvidenceFromManifests(base);
    const duplicateValidation = validateDesktopRoutingAttestation({
      ...validReport,
      routingChecks: [...validReport.routingChecks, validReport.routingChecks[0]],
    });
    assert.equal(duplicateValidation.ok, false);
    assert.equal(duplicateValidation.problems.includes("routing_case_duplicate:critical_offer_acceptance_rate"), true);
    const promptLeakValidation = validateDesktopRoutingAttestation({
      ...validReport,
      routingChecks: validReport.routingChecks.map((check, index) => index === 0
        ? { ...check, prompt: "ATS prompt must not be stored" }
        : check),
    });
    assert.equal(promptLeakValidation.ok, false);
    assert.equal(promptLeakValidation.problems.includes("routing_check_shape_invalid"), true);
    assert.equal(
      validateDesktopRoutingAttestation({ ...validReport, atsData: { candidate: "must not be stored" } }).problems
        .includes("routing_attestation_contains_prompt_response_or_ats_data"),
      true
    );
    const nestedContentValidation = validateDesktopRoutingAttestation({
      ...validReport,
      metadata: { prompt: "must not be retained", resumeText: "must not be retained" },
    });
    assert.equal(nestedContentValidation.ok, false);
    assert.equal(
      nestedContentValidation.problems.includes("routing_attestation_unknown_fields:metadata"),
      true
    );
    assert.equal(validReport.warning, DESKTOP_USER_TEST_EVIDENCE_WARNING);

    await assert.rejects(
      buildDesktopUserTestEvidenceFromManifests({ ...base, clientVersion: undefined }),
      /clientVersion is required/
    );
    await assert.rejects(
      buildDesktopUserTestEvidenceFromManifests({ ...base, modelVersion: "Authorization: Bearer secret-value-123456" }),
      /modelVersion must be printable version metadata/
    );
    await assert.rejects(
      buildDesktopUserTestEvidenceFromManifests({ ...base, routingChecks: ROUTING_CHECKS.slice(MIN_ROUTING_RUNS) }),
      /critical_offer_acceptance_rate requires at least 3 observed runs/
    );
    await assert.rejects(
      buildDesktopUserTestEvidenceFromManifests({
        ...base,
        routingChecks: ROUTING_CHECKS.map((entry, index) => entry.caseId === "compare_resumes_to_job" && index % MIN_ROUTING_RUNS === 0
          ? { ...entry, observedTools: ["search_my_attachments", "read_my_resume", "search_my_job_posts"] }
          : entry),
      }),
      /compare_resumes_to_job requires read_my_resume at least 2 time\(s\)/
    );
    for (const caseId of ["open_resume_summary", "compare_resumes_to_job", "untrusted_resume_instruction"]) {
      await assert.rejects(
        buildDesktopUserTestEvidenceFromManifests({
          ...base,
          routingChecks: ROUTING_CHECKS.map((entry, index) => entry.caseId === caseId && index % MIN_ROUTING_RUNS === 0
            ? { ...entry, observedTools: entry.observedTools.filter((tool) => tool !== "search_my_attachments") }
            : entry),
        }),
        new RegExp(`${caseId} requires search_my_attachments at least 1 time\\(s\\)`)
      );
    }
    await assert.rejects(
      buildDesktopUserTestEvidenceFromManifests({
        ...base,
        routingChecks: ROUTING_CHECKS.map((entry, index) => entry.caseId === "list_candidate_files" && index % MIN_ROUTING_RUNS === 0
          ? { ...entry, observedTools: ["search_my_job_notes"] }
          : entry),
      }),
      /list_candidate_files observed disallowed tool\(s\): search_my_job_notes/
    );
    await assert.rejects(
      buildDesktopUserTestEvidenceFromManifests({
        ...base,
        routingChecks: [...ROUTING_CHECKS, { caseId: "unknown_case", observedTools: ["search_my_jobs"] }],
      }),
      /Unknown routing case\(s\): unknown_case/
    );
    await assert.rejects(
      buildDesktopUserTestEvidenceFromManifests({ ...base, exercisedTools: [...ROUTING_TOOLS, "search_my_job_notes"] }),
      /Unknown recruiter tool\(s\) in exercised tools: search_my_job_notes/
    );
    const wrongOrders = [
      ["open_resume_summary", ["read_my_resume", "search_my_attachments"], /requires search_my_attachments before read_my_resume/],
      ["interviewer_actual_feedback", ["search_my_scorecard_question_answers", "search_my_scorecards"], /requires search_my_scorecards before search_my_scorecard_question_answers/],
      ["candidate_rejection_reason", ["search_my_rejection_reasons", "search_my_rejection_details"], /requires search_my_rejection_details before search_my_rejection_reasons/],
      ["requisition_ownership", ["get_my_user", "search_my_job_owners", "search_my_job_hiring_managers"], /requires search_my_job_owners before get_my_user/],
      ["candidate_stage_history", ["search_my_job_interview_stages", "search_my_application_stages"], /requires search_my_application_stages before search_my_job_interview_stages/],
      ["candidate_origin", ["search_my_sources", "search_my_applications", "search_my_referrers"], /requires candidate resolution before evidence tools/],
      ["candidate_note", ["search_my_notes", "search_my_candidates"], /requires candidate resolution before evidence tools/],
    ] as const;
    for (const [caseId, observedTools, expectedError] of wrongOrders) {
      await assert.rejects(
        buildDesktopUserTestEvidenceFromManifests({
          ...base,
          routingChecks: ROUTING_CHECKS.map((entry, index) => entry.caseId === caseId && index % MIN_ROUTING_RUNS === 0
            ? { ...entry, observedTools: [...observedTools] }
            : entry),
        }),
        expectedError
      );
    }
    await assert.rejects(
      buildDesktopUserTestEvidenceFromManifests({
        ...base,
        routingChecks: ROUTING_CHECKS.map((entry, index) => entry.caseId === "list_candidate_files" && index % MIN_ROUTING_RUNS === 0
          ? { ...entry, observedTools: ["search_my_candidates", "get_my_candidate", "search_my_attachments", "search_my_attachments"] }
          : entry),
      }),
      /list_candidate_files exceeds its 3-call maximum/
    );
    await assert.rejects(
      buildDesktopUserTestEvidenceFromManifests({ ...base, resumeInstructionsTreatedAsUntrusted: false }),
      /attest-resume-instructions-untrusted/
    );
  });

  it("writes attestation reports with restrictive permissions", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-desktop-user-test-"));
    const sessionManifestPath = join(tmp, "issued-sessions-manifest.json");
    const desktopManifestPath = join(tmp, "desktop-config-manifest.json");
    const outPath = join(tmp, "desktop-chatgpt.json");
    await writeSessionManifest(sessionManifestPath);
    await writeDesktopManifest(desktopManifestPath);

    const report = await buildDesktopUserTestEvidenceFromManifests({
      surface: "chatgpt_desktop",
      testerEmail: "recruiter.one@company.com",
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      attachmentMethod: "responses_api_broker",
      sessionIssuanceManifestPath: sessionManifestPath,
      desktopConfigManifestPath: desktopManifestPath,
      sessionTokenIdAfterRestart: "chatgpt-token-id",
      sessionIssuedAtAfterRestart: "2026-06-23T00:00:00.000Z",
      exercisedTools: ROUTING_TOOLS,
      durableSessionAccess: true,
      sessionPersistedAcrossRestart: true,
      routineReverificationPrompted: false,
      writeOrAdminToolsVisible: false,
      taskOutcome: "useful",
      taskOutcomeReason: "answer_received",
      ...ROUTING_ATTESTATION,
      now: () => Date.parse("2026-06-23T00:00:00.000Z"),
    });
    await writeDesktopUserTestEvidenceFile(report, outPath);

    const written = JSON.parse(await readFile(outPath, "utf8"));
    assert.equal(written.status, "pass");
    assert.equal((await stat(outPath)).mode & 0o777, 0o600);
  });
});

async function writeSessionManifest(
  path: string,
  files = manifestFiles(),
  extra: Record<string, unknown> = {}
): Promise<void> {
  await writeFile(path, JSON.stringify({
    ok: true,
    outputDir: ".",
    manifestPath: basename(path),
    requestedEmailCount: 1,
    requestedSurfaces: ["claude_desktop", "chatgpt_desktop"],
    fileCount: 2,
    containsTokens: false,
    sessionFilesContainTokens: true,
    warning: "token-free manifest",
    files,
    ...extra,
  }, null, 2), "utf8");
}

async function writeDesktopManifest(
  path: string,
  files = manifestFiles(),
  extra: Record<string, unknown> = {}
): Promise<void> {
  await writeFile(path, JSON.stringify({
    ok: true,
    outputDir: ".",
    manifestPath: basename(path),
    fileCount: 2,
    containsTokens: false,
    configFilesContainTokens: true,
    warning: "token-free manifest",
    files,
    ...extra,
  }, null, 2), "utf8");
}

function manifestFiles() {
  return [
    {
      email: "recruiter.one@company.com",
      surface: "claude_desktop",
      subject: "email:recruiter.one@company.com",
      tokenId: "claude-token-id",
      issuedAt: "2026-06-23T00:00:00.000Z",
      path: "recruiter-one-claude.json",
    },
    {
      email: "recruiter.one@company.com",
      surface: "chatgpt_desktop",
      subject: "email:recruiter.one@company.com",
      tokenId: "chatgpt-token-id",
      issuedAt: "2026-06-23T00:00:00.000Z",
      path: "recruiter-one-chatgpt.json",
    },
  ];
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
