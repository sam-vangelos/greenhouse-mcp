import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generateDesktopConfig,
  generateDesktopConfigBatchFromIssuedSessions,
  generateDesktopConfigBatchFromIssuedSessionsFile,
  generateDesktopConfigFromEnv,
  mergeDesktopConfigManifests,
  writeDesktopConfigBatchFiles,
} from "../src/desktop-config.js";
import { PILOT_TOOL_NAMES } from "../src/tools/register.js";

describe("desktop distribution config generator", () => {
  it("refuses the unsupported Claude Desktop remote url/headers shape", () => {
    assert.throws(() => generateDesktopConfig({
      surface: "claude_desktop",
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      token: "durable-user-token",
      serverName: "greenhouse-recruiter",
    }), /personalized \.mcpb/);
  });

  it("generates a separate Claude Code HTTP config for a claude_code credential", () => {
    const report = generateDesktopConfig({
      surface: "claude_desktop",
      client: "claude_code",
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      token: "durable-claude-code-token",
      serverName: "greenhouse-recruiter",
    });

    assert.equal(report.client, "claude_code");
    assert.deepEqual(report.config, {
      mcpServers: {
        "greenhouse-recruiter": {
          type: "http",
          url: "https://greenhouse-recruiter.example.com/mcp",
          headers: { Authorization: "Bearer durable-claude-code-token" },
        },
      },
    });
    assert.throws(() => generateDesktopConfig({
      surface: "chatgpt_desktop",
      client: "claude_code",
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      token: "durable-claude-code-token",
    }), /does not match/);
  });

  it("generates an OpenAI remote MCP payload with allowed recruiter tools", () => {
    const report = generateDesktopConfig({
      surface: "chatgpt_desktop",
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      token: "durable-user-token",
      requireApproval: "always",
    });

    assert.equal(report.surface, "chatgpt_desktop");
    const expectedPilotTools = [
      "answer_my_recruiting_question",
      "analyze_scorecard_accountability",
      "analyze_interview_feedback_drag",
      "analyze_stage_latency",
      "analyze_pipeline_quality",
      "analyze_source_quality",
      "analyze_rejection_reason_drift",
      "resolve_job_scope",
      "confirm_job_scope",
      "get_job_scope",
      "get_recruiting_capabilities",
      "read_my_resume",
      "search_my_jobs",
      "get_my_job",
      "search_my_applications",
      "get_my_application",
      "search_my_interviews",
      "search_my_offers",
      "search_my_openings",
      "search_my_users",
      "search_my_job_owners",
      "search_my_job_interview_stages",
      "search_my_application_stages",
      "search_my_job_hiring_managers",
      "search_my_job_posts",
      "search_my_candidates",
      "get_my_candidate",
      "search_my_scorecards",
      "search_my_rejection_details",
      "search_my_rejection_reasons",
      "search_my_notes",
      "search_my_attachments",
      "search_my_interviewers",
      "search_my_scorecard_question_answers",
      "search_my_candidate_educations",
      "search_my_candidate_employments",
      "get_my_user",
      "search_my_sources",
      "search_my_referrers",
      "search_my_custom_field_options",
      "search_my_custom_fields",
      "search_my_departments",
      "search_my_offices",
      "search_my_close_reasons",
    ];
    assert.deepEqual([...PILOT_TOOL_NAMES], expectedPilotTools);
    assert.deepEqual(report.config, {
      type: "mcp",
      server_label: "greenhouse-recruiter",
      server_description: "Recruiter-scoped Greenhouse read and analysis tools.",
      server_url: "https://greenhouse-recruiter.example.com/mcp",
      authorization: "durable-user-token",
      require_approval: "always",
      allowed_tools: expectedPilotTools,
    });
    assert.equal(expectedPilotTools.length, 44);
  });

  it("loads generation options from env and supports intentionally restricted pilot payloads", () => {
    const report = generateDesktopConfigFromEnv({
      GREENHOUSE_RECRUITER_DESKTOP_SURFACE: "chatgpt_desktop",
      GREENHOUSE_RECRUITER_REMOTE_MCP_URL: "https://greenhouse-recruiter.example.com/mcp",
      GREENHOUSE_RECRUITER_SESSION_TOKEN: "durable-user-token",
      GREENHOUSE_RECRUITER_DESKTOP_SERVER_NAME: "greenhouse-recruiter-pilot",
      GREENHOUSE_RECRUITER_CHATGPT_REQUIRE_APPROVAL: "never",
    } as NodeJS.ProcessEnv, ["--no-allowed-tools"]);

    assert.deepEqual(report.config, {
      type: "mcp",
      server_label: "greenhouse-recruiter-pilot",
      server_description: "Recruiter-scoped Greenhouse read and analysis tools.",
      server_url: "https://greenhouse-recruiter.example.com/mcp",
      authorization: "durable-user-token",
      require_approval: "never",
    });
  });

  it("generates per-user desktop configs from a batch issued-session report", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-issued-sessions-"));
    const issuedSessionsPath = join(tmp, "issued-sessions.json");
    await writeFile(issuedSessionsPath, JSON.stringify({
      ok: true,
      issued: [
        {
          email: "recruiter.one@company.com",
          surface: "chatgpt_desktop",
          subject: "email:recruiter.one@company.com",
          tokenId: "token-1",
          issuedAt: "2026-06-23T00:00:00.000Z",
          token: "durable-chatgpt-token",
        },
      ],
      denied: [],
    }), "utf8");

    const report = await generateDesktopConfigBatchFromIssuedSessionsFile(issuedSessionsPath, {
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      serverName: "greenhouse-recruiter",
      requireApproval: "always",
    });

    assert.equal(report.ok, true);
    assert.equal(report.sensitive, true);
    assert.equal(report.configCount, 1);
    assert.deepEqual(report.configs.map((entry) => `${entry.email}:${entry.surface}:${entry.tokenId}`), [
      "recruiter.one@company.com:chatgpt_desktop:token-1",
    ]);
    assert.deepEqual(report.configs.map((entry) => entry.issuedAt), [
      "2026-06-23T00:00:00.000Z",
    ]);
    assert.equal((report.configs[0]?.config as { authorization?: string }).authorization, "durable-chatgpt-token");
    assert.doesNotMatch(JSON.stringify(report), /GREENHOUSE_CLIENT_ID|GREENHOUSE_CLIENT_SECRET|GREENHOUSE_RECRUITER_IDENTITY_JSON/);
  });

  it("refuses Claude entries from a split durable-session manifest", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-split-session-configs-"));
    const claudePath = join(tmp, "recruiter-claude.json");
    const chatgptPath = join(tmp, "recruiter-chatgpt.json");
    const manifestPath = join(tmp, "manifest.json");
    await writeFile(claudePath, JSON.stringify({
      email: "recruiter@example.com",
      surface: "claude_desktop",
      subject: "email:recruiter@example.com",
      tokenId: "claude-token-id",
      issuedAt: "2026-06-23T00:00:00.000Z",
      token: "durable-claude-token",
    }), "utf8");
    await writeFile(chatgptPath, JSON.stringify({
      email: "recruiter@example.com",
      surface: "chatgpt_desktop",
      subject: "email:recruiter@example.com",
      tokenId: "chatgpt-token-id",
      issuedAt: "2026-06-23T00:00:00.000Z",
      token: "durable-chatgpt-token",
    }), "utf8");
    await writeFile(manifestPath, JSON.stringify({
      ok: true,
      outputDir: ".",
      manifestPath: "manifest.json",
      requestedEmailCount: 1,
      requestedSurfaces: ["claude_desktop", "chatgpt_desktop"],
      fileCount: 2,
      containsTokens: false,
      sessionFilesContainTokens: true,
      files: [
        { email: "recruiter@example.com", surface: "claude_desktop", subject: "email:recruiter@example.com", tokenId: "claude-token-id", issuedAt: "2026-06-23T00:00:00.000Z", path: "recruiter-claude.json" },
        { email: "recruiter@example.com", surface: "chatgpt_desktop", subject: "email:recruiter@example.com", tokenId: "chatgpt-token-id", issuedAt: "2026-06-23T00:00:00.000Z", path: "recruiter-chatgpt.json" },
      ],
    }), "utf8");

    await assert.rejects(() => generateDesktopConfigBatchFromIssuedSessionsFile(manifestPath, {
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      serverName: "greenhouse-recruiter",
    }), /personalized \.mcpb/);
  });

  it("rejects split durable-session manifests that contain token or config payloads", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-split-session-configs-"));
    const sessionPath = join(tmp, "recruiter-chatgpt.json");
    const manifestPath = join(tmp, "manifest.json");
    await writeFile(sessionPath, JSON.stringify({
      email: "recruiter@example.com",
      surface: "chatgpt_desktop",
      subject: "email:recruiter@example.com",
      tokenId: "chatgpt-token-id",
      issuedAt: "2026-06-23T00:00:00.000Z",
      token: "durable-chatgpt-token",
    }), "utf8");
    const baseManifest = {
      ok: true,
      outputDir: ".",
      manifestPath: "manifest.json",
      requestedEmailCount: 1,
      requestedSurfaces: ["chatgpt_desktop"],
      fileCount: 1,
      containsTokens: false,
      sessionFilesContainTokens: true,
      files: [
        { email: "recruiter@example.com", surface: "chatgpt_desktop", subject: "email:recruiter@example.com", tokenId: "chatgpt-token-id", issuedAt: "2026-06-23T00:00:00.000Z", path: "recruiter-chatgpt.json" },
      ],
    };
    const cases: Array<{ name: string; extra: Record<string, unknown> }> = [
      { name: "auth-token", extra: { authToken: "durable-user-token" } },
      { name: "raw-config", extra: { rawConfig: { mcpServers: { greenhouse: {} } } } },
      { name: "bearer-string", extra: { operatorNote: "proxy leaked Authorization: Bearer durable-session-token-value" } },
      { name: "greenhouse-secret-string", extra: { operatorNote: "GREENHOUSE_RECRUITER_SESSION_TOKEN=durable-session-token-value" } },
    ];

    for (const { extra } of cases) {
      await writeFile(manifestPath, JSON.stringify({ ...baseManifest, ...extra }), "utf8");
      await assert.rejects(
        () => generateDesktopConfigBatchFromIssuedSessionsFile(manifestPath, {
          mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
          serverName: "greenhouse-recruiter",
        }),
        /Split session manifest must not contain durable tokens or config payloads\./
      );
    }
  });

  it("rejects split durable-session manifests with non-portable token file paths", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-split-session-configs-"));
    const sessionPath = join(tmp, "recruiter-chatgpt.json");
    const manifestPath = join(tmp, "manifest.json");
    await writeFile(sessionPath, JSON.stringify({
      email: "recruiter@example.com",
      surface: "chatgpt_desktop",
      subject: "email:recruiter@example.com",
      tokenId: "chatgpt-token-id",
      issuedAt: "2026-06-23T00:00:00.000Z",
      token: "durable-chatgpt-token",
    }), "utf8");

    const baseManifest = {
      ok: true,
      outputDir: ".",
      manifestPath: "manifest.json",
      requestedEmailCount: 1,
      requestedSurfaces: ["chatgpt_desktop"],
      fileCount: 1,
      containsTokens: false,
      sessionFilesContainTokens: true,
      files: [{
        email: "recruiter@example.com",
        surface: "chatgpt_desktop",
        subject: "email:recruiter@example.com",
        tokenId: "chatgpt-token-id",
        issuedAt: "2026-06-23T00:00:00.000Z",
        path: sessionPath,
      }],
    };

    await writeFile(manifestPath, JSON.stringify(baseManifest), "utf8");
    await assert.rejects(
      () => generateDesktopConfigBatchFromIssuedSessionsFile(manifestPath, {
        mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
        serverName: "greenhouse-recruiter",
      }),
      /portable relative paths/
    );

    await writeFile(manifestPath, JSON.stringify({
      ...baseManifest,
      files: [{ ...baseManifest.files[0], path: "../outside-session.json" }],
    }), "utf8");
    await assert.rejects(
      () => generateDesktopConfigBatchFromIssuedSessionsFile(manifestPath, {
        mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
        serverName: "greenhouse-recruiter",
      }),
      /portable relative paths/
    );
  });

  it("rejects split durable-session manifests whose issued-at timestamp does not match the token file", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-split-session-configs-"));
    const sessionPath = join(tmp, "recruiter-chatgpt.json");
    const manifestPath = join(tmp, "manifest.json");
    await writeFile(sessionPath, JSON.stringify({
      email: "recruiter@example.com",
      surface: "chatgpt_desktop",
      subject: "email:recruiter@example.com",
      tokenId: "chatgpt-token-id",
      issuedAt: "2026-06-23T00:00:00.000Z",
      token: "durable-chatgpt-token",
    }), "utf8");
    await writeFile(manifestPath, JSON.stringify({
      ok: true,
      outputDir: ".",
      manifestPath: "manifest.json",
      requestedEmailCount: 1,
      requestedSurfaces: ["chatgpt_desktop"],
      fileCount: 1,
      containsTokens: false,
      sessionFilesContainTokens: true,
      files: [
        { email: "recruiter@example.com", surface: "chatgpt_desktop", subject: "email:recruiter@example.com", tokenId: "chatgpt-token-id", issuedAt: "2026-06-24T00:00:00.000Z", path: "recruiter-chatgpt.json" },
      ],
    }), "utf8");

    await assert.rejects(
      () => generateDesktopConfigBatchFromIssuedSessionsFile(manifestPath, {
        mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
        serverName: "greenhouse-recruiter",
      }),
      /Split session manifest issued-at timestamp does not match token file\./
    );
  });

  it("rejects split durable-session manifests whose token files do not match manifest metadata", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-split-session-configs-"));
    const sessionPath = join(tmp, "recruiter-chatgpt.json");
    const manifestPath = join(tmp, "manifest.json");
    await writeFile(sessionPath, JSON.stringify({
      email: "recruiter@example.com",
      surface: "chatgpt_desktop",
      subject: "email:recruiter@example.com",
      tokenId: "chatgpt-token-id",
      issuedAt: "2026-06-23T00:00:00.000Z",
      token: "durable-chatgpt-token",
    }), "utf8");
    await writeFile(manifestPath, JSON.stringify({
      ok: true,
      outputDir: ".",
      manifestPath: "manifest.json",
      requestedEmailCount: 1,
      requestedSurfaces: ["chatgpt_desktop"],
      fileCount: 1,
      containsTokens: false,
      sessionFilesContainTokens: true,
      files: [
        { email: "recruiter@example.com", surface: "chatgpt_desktop", subject: "email:recruiter@example.com", tokenId: "wrong-token-id", issuedAt: "2026-06-23T00:00:00.000Z", path: "recruiter-chatgpt.json" },
      ],
    }), "utf8");

    await assert.rejects(
      () => generateDesktopConfigBatchFromIssuedSessionsFile(manifestPath, {
        mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
        serverName: "greenhouse-recruiter",
      }),
      /Split session manifest token id does not match token file\./
    );
  });

  it("rejects issued-session inputs whose token metadata would only be valid after trimming", async () => {
    assert.throws(() => generateDesktopConfigBatchFromIssuedSessions({
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      issuedSessions: [{
        email: "recruiter@example.com",
        surface: "claude_desktop",
        subject: "email:recruiter@example.com",
        tokenId: " token-id ",
        issuedAt: "2026-06-23T00:00:00.000Z",
        token: "durable-token",
      }],
    }), /token id/);

    assert.throws(() => generateDesktopConfigBatchFromIssuedSessions({
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      issuedSessions: [{
        email: "recruiter@example.com",
        surface: "claude_desktop",
        subject: "email:recruiter@example.com",
        tokenId: "token-id",
        issuedAt: "2026-06-23T00:00:00Z",
        token: "durable-token",
      }],
    }), /issued-at/);

    assert.throws(() => generateDesktopConfigBatchFromIssuedSessions({
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      issuedSessions: [{
        email: "recruiter@example.com",
        surface: "claude_desktop",
        subject: "email:recruiter@example.com",
        tokenId: "token-id",
        issuedAt: "2026-06-23T00:00:00.000Z",
        token: " durable-token",
      }],
    }), /leading or trailing whitespace/);
  });

  it("rejects split durable-session token files whose tokens need trimming", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-split-session-configs-"));
    const sessionPath = join(tmp, "recruiter-chatgpt.json");
    const manifestPath = join(tmp, "manifest.json");
    await writeFile(sessionPath, JSON.stringify({
      email: "recruiter@example.com",
      surface: "chatgpt_desktop",
      subject: "email:recruiter@example.com",
      tokenId: "chatgpt-token-id",
      issuedAt: "2026-06-23T00:00:00.000Z",
      token: "durable-chatgpt-token ",
    }), "utf8");
    await writeFile(manifestPath, JSON.stringify({
      ok: true,
      outputDir: ".",
      manifestPath: "manifest.json",
      requestedEmailCount: 1,
      requestedSurfaces: ["chatgpt_desktop"],
      fileCount: 1,
      containsTokens: false,
      sessionFilesContainTokens: true,
      files: [
        { email: "recruiter@example.com", surface: "chatgpt_desktop", subject: "email:recruiter@example.com", tokenId: "chatgpt-token-id", issuedAt: "2026-06-23T00:00:00.000Z", path: "recruiter-chatgpt.json" },
      ],
    }), "utf8");

    await assert.rejects(
      () => generateDesktopConfigBatchFromIssuedSessionsFile(manifestPath, {
        mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
        serverName: "greenhouse-recruiter",
      }),
      /leading or trailing whitespace/
    );
  });

  it("writes split per-user desktop config files and a token-free manifest", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-desktop-configs-"));
    const batch = generateDesktopConfigBatchFromIssuedSessions({
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      serverName: "greenhouse-recruiter",
      issuedSessions: [
        {
          email: "recruiter.one@company.com",
          surface: "chatgpt_desktop",
          subject: "email:recruiter.one@company.com",
          tokenId: "chatgpt-token-id",
          issuedAt: "2026-06-23T00:00:00.000Z",
          token: "durable-chatgpt-token",
        },
      ],
    });

    const manifest = await writeDesktopConfigBatchFiles(batch, tmp);
    const manifestPath = join(tmp, manifest.manifestPath);
    const manifestOnDisk = JSON.parse(await readFile(manifestPath, "utf8")) as typeof manifest;
    const manifestJson = JSON.stringify(manifestOnDisk);

    assert.equal(manifest.fileCount, 1);
    assert.equal(manifest.outputDir, ".");
    assert.equal(manifest.manifestPath, "manifest.json");
    assert.equal(manifest.containsTokens, false);
    assert.equal(manifest.configFilesContainTokens, true);
    assert.deepEqual(manifest.files.map((entry) => entry.issuedAt), [
      "2026-06-23T00:00:00.000Z",
    ]);
    assert.deepEqual(manifestOnDisk.files.map((entry) => entry.surface), ["chatgpt_desktop"]);
    assert.doesNotMatch(manifestJson, /durable-chatgpt-token|Authorization|authorization/);
    assert.equal(manifest.files.every((entry) => !entry.path.startsWith("/")), true);

    const chatgptPath = join(tmp, manifest.files[0]!.path);
    const chatgptConfig = await readFile(chatgptPath, "utf8");
    assert.match(chatgptConfig, /durable-chatgpt-token/);
    assert.doesNotMatch(chatgptConfig, /GREENHOUSE_CLIENT_SECRET/);
    assert.equal(await modeOf(tmp), 0o700);
    assert.equal(await modeOf(manifestPath), 0o600);
    assert.equal(await modeOf(chatgptPath), 0o600);
  });

  it("refuses to overwrite existing split desktop config files", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-desktop-configs-"));
    const batch = generateDesktopConfigBatchFromIssuedSessions({
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      serverName: "greenhouse-recruiter",
      issuedSessions: [
        {
          email: "recruiter.one@company.com",
          surface: "chatgpt_desktop",
          subject: "email:recruiter.one@company.com",
          tokenId: "chatgpt-token-id",
          issuedAt: "2026-06-23T00:00:00.000Z",
          token: "durable-chatgpt-token",
        },
      ],
    });
    const manifest = await writeDesktopConfigBatchFiles(batch, tmp);
    const configPath = join(tmp, manifest.files[0]!.path);
    const originalConfig = await readFile(configPath, "utf8");

    await assert.rejects(
      () => writeDesktopConfigBatchFiles(batch, tmp),
      /Refusing to overwrite existing sensitive recruiter artifact/
    );

    assert.equal(await readFile(configPath, "utf8"), originalConfig);
  });

  it("merges all three client artifacts into one portable token-free manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "greenhouse-desktop-merge-"));
    const clients = [
      { dir: "claude-desktop", surface: "claude_desktop", client: "claude_desktop_chat", tokenId: "claude-desktop-token", artifact: "recruiter.mcpb", mcpb: true },
      { dir: "claude-code", surface: "claude_desktop", client: "claude_code", tokenId: "claude-code-token", artifact: "recruiter.json", mcpb: false },
      { dir: "chatgpt", surface: "chatgpt_desktop", client: "chatgpt_codex_host", tokenId: "chatgpt-token", artifact: "recruiter.json", mcpb: false },
    ] as const;
    const manifestPaths: string[] = [];
    for (const entry of clients) {
      const dir = join(root, entry.dir);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, entry.artifact), "sensitive artifact", "utf8");
      const manifestPath = join(dir, "manifest.json");
      await writeFile(manifestPath, JSON.stringify({
        ok: true,
        outputDir: ".",
        manifestPath: "manifest.json",
        fileCount: 1,
        ...(entry.mcpb ? { metadataContainsToken: false, artifactContainsToken: true } : { containsTokens: false }),
        configFilesContainTokens: true,
        files: [{
          email: "recruiter@example.com",
          surface: entry.surface,
          client: entry.client,
          subject: "email:recruiter@example.com",
          tokenId: entry.tokenId,
          issuedAt: "2026-07-15T20:00:00.000Z",
          path: entry.artifact,
        }],
      }), "utf8");
      manifestPaths.push(manifestPath);
    }

    const merged = await mergeDesktopConfigManifests(manifestPaths, root);
    const onDisk = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));

    assert.equal(merged.containsTokens, false);
    assert.equal(merged.artifactContainsToken, true);
    assert.equal(merged.metadataContainsToken, false);
    assert.equal(merged.fileCount, 3);
    assert.deepEqual(merged.files.map((file) => file.client), [
      "claude_desktop_chat",
      "claude_code",
      "chatgpt_codex_host",
    ]);
    assert.deepEqual(merged.files.map((file) => file.path), [
      "claude-desktop/recruiter.mcpb",
      "claude-code/recruiter.json",
      "chatgpt/recruiter.json",
    ]);
    assert.doesNotMatch(JSON.stringify(onDisk), /Authorization|durable-user-token/);
    assert.equal(await modeOf(join(root, "manifest.json")), 0o600);
  });

  it("refuses a combined artifact manifest that omits a required physical client", async () => {
    const root = await mkdtemp(join(tmpdir(), "greenhouse-desktop-merge-missing-"));
    const dir = join(root, "chatgpt");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "recruiter.json"), "sensitive artifact", "utf8");
    const manifestPath = join(dir, "manifest.json");
    await writeFile(manifestPath, JSON.stringify({
      ok: true,
      outputDir: ".",
      manifestPath: "manifest.json",
      containsTokens: false,
      configFilesContainTokens: true,
      files: [{
        email: "recruiter@example.com",
        surface: "chatgpt_desktop",
        client: "chatgpt_codex_host",
        subject: "email:recruiter@example.com",
        tokenId: "chatgpt-token",
        issuedAt: "2026-07-15T20:00:00.000Z",
        path: "recruiter.json",
      }],
    }), "utf8");

    await assert.rejects(
      () => mergeDesktopConfigManifests([manifestPath], root),
      /missing required clients.*claude_desktop_chat, claude_code/
    );
  });

  it("refuses to generate desktop configs from a partial issued-session report", () => {
    assert.throws(() => generateDesktopConfigBatchFromIssuedSessions({
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      sourceOk: false,
      deniedCount: 1,
      issuedSessions: [{
        email: "valid@company.com",
        surface: "claude_desktop",
        token: "durable-user-token",
      }],
    }), /denied rows/);
  });

  it("rejects non-HTTPS remote MCP URLs except localhost validation", () => {
    assert.throws(() => generateDesktopConfig({
      surface: "chatgpt_desktop",
      mcpUrl: "http://greenhouse-recruiter.example.com/mcp",
      token: "durable-user-token",
    }), /https/);
    assert.equal(generateDesktopConfig({
      surface: "chatgpt_desktop",
      mcpUrl: "http://127.0.0.1:3333/mcp",
      token: "durable-user-token",
    }).mcpUrl, "http://127.0.0.1:3333/mcp");
  });

  it("requires a non-empty token and stable server name", () => {
    assert.throws(() => generateDesktopConfig({
      surface: "chatgpt_desktop",
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      token: "  ",
    }), /non-empty/);
    assert.throws(() => generateDesktopConfig({
      surface: "chatgpt_desktop",
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      token: " durable-user-token",
    }), /leading or trailing whitespace/);
    assert.throws(() => generateDesktopConfig({
      surface: "chatgpt_desktop",
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      token: "durable-user-token",
      serverName: "1bad",
    }), /server name/);
  });
});

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}
