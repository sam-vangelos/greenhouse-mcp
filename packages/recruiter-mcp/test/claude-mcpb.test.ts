import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeMcpb } from "../src/claude-mcpb.js";

describe("Claude Desktop MCPB packaging", () => {
  it("packages a personalized credential-bound bridge while keeping metadata token-free", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-mcpb-test-"));
    const sessionPath = join(tmp, "session.json");
    const outputDir = join(tmp, "out");
    const session = claudeSession();
    await writeFile(sessionPath, `${JSON.stringify(session)}\n`, { mode: 0o600 });

    const report = await buildClaudeMcpb({
      issuedSessionFile: sessionPath,
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      outputDir,
    });

    const artifactPath = join(outputDir, report.artifactPath);
    const metadataPath = join(outputDir, "manifest.json");
    const metadata = await readFile(metadataPath, "utf8");
    const packedManifest = spawnSync("unzip", ["-p", artifactPath, "manifest.json"], { encoding: "utf8" });
    assert.equal(report.artifactContainsToken, true);
    assert.equal(report.metadataContainsToken, false);
    assert.equal(report.artifactsContainTokens, true);
    assert.equal("containsTokens" in report, false);
    assert.equal(metadata.includes(session.token), false);
    assert.equal(packedManifest.status, 0);
    assert.equal(packedManifest.stdout.includes(session.token), true);
    assert.equal((await stat(outputDir)).mode & 0o777, 0o700);
    assert.equal((await stat(artifactPath)).mode & 0o777, 0o600);
    assert.equal((await stat(metadataPath)).mode & 0o777, 0o600);
    await assert.rejects(() => buildClaudeMcpb({
      issuedSessionFile: sessionPath,
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      outputDir,
    }), /Refusing to overwrite/);
  });

  it("rejects a Claude Code credential instead of reusing it for Desktop", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-mcpb-client-test-"));
    const sessionPath = join(tmp, "session.json");
    const session = claudeSession("claude_code");
    await writeFile(sessionPath, JSON.stringify(session), { mode: 0o600 });

    await assert.rejects(() => buildClaudeMcpb({
      issuedSessionFile: sessionPath,
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      outputDir: join(tmp, "out"),
    }), /claude_desktop_chat/);
  });
});

function claudeSession(client: "claude_desktop_chat" | "claude_code" = "claude_desktop_chat") {
  const claims = {
    subject: "email:recruiter@example.com",
    email: "recruiter@example.com",
    surface: "claude_desktop",
    client,
    tokenId: `test-${client}`,
    issuedAt: "2026-07-15T20:00:00.000Z",
  };
  return { ...claims, token: `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${"signature".repeat(5)}` };
}
