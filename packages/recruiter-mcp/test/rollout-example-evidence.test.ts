import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runRolloutGate } from "../src/rollout-gate.js";
import { buildClaudeMcpb } from "../src/claude-mcpb.js";

describe("rollout example evidence", () => {
  it("keeps checked-in example live and client reports explicitly ineligible as real rollout evidence", async () => {
    const exampleDir = await mkdtemp(join(tmpdir(), "greenhouse-rollout-example-"));
    await cp(resolve("examples/rollout-evidence"), exampleDir, { recursive: true });
    await buildClaudeMcpb({
      issuedSessionFile: join(exampleDir, "issued-sessions/recruiter-claude.example.json"),
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      outputDir: join(exampleDir, "desktop-configs"),
    });
    const report = await runRolloutGate({
      manifestPath: join(exampleDir, "manifest.example.json"),
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });

    assert.equal(report.ok, false);
    assert.equal(report.status, "not_ready");
    const failures = report.checks.filter((check) => check.status !== "pass");
    assert.deepEqual(failures.map((check) => check.name), ["manifest_paths_portable"]);
    const invalidPaths = failures[0]?.details?.invalidPaths as Array<{ label: string; reason: string }>;
    assert.ok(invalidPaths.length >= 20);
    assert.ok(invalidPaths.every((entry) => entry.reason === "example_artifact_ineligible"));
  });
});
