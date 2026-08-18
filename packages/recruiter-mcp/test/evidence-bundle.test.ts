import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRolloutEvidenceBundle } from "../src/evidence-bundle.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exampleEvidenceDir = join(packageRoot, "examples", "rollout-evidence");

describe("rollout evidence bundle packer", () => {
  it("copies only manifest-referenced token-free evidence and skips generated token-bearing session/config files", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-evidence-bundle-"));
    const sourceDir = join(tmp, "source");
    const outputDir = join(tmp, "bundle");
    await cp(exampleEvidenceDir, sourceDir, { recursive: true });

    const report = await buildRolloutEvidenceBundle({
      manifestPath: join(sourceDir, "manifest.example.json"),
      outputDir,
    });

    assert.equal(report.ok, true);
    assert.equal(report.containsTokens, false);
    assert.equal(report.outputDir, outputDir);
    assert.ok(report.fileCount > 10);
    assert.ok(existsSync(join(outputDir, "manifest.example.json")));
    assert.ok(existsSync(join(outputDir, "production-env-check.example.json")));
    assert.ok(existsSync(join(outputDir, "issued-sessions", "manifest.example.json")));
    assert.ok(existsSync(join(outputDir, "desktop-configs", "manifest.example.json")));
    assert.equal(existsSync(join(outputDir, "issued-sessions", "recruiter-chatgpt.example.json")), false);
    assert.equal(existsSync(join(outputDir, "issued-sessions", "recruiter-claude.example.json")), false);
    assert.equal(existsSync(join(outputDir, "issued-sessions", "recruiter-claude-code.example.json")), false);
    assert.equal(existsSync(join(outputDir, "desktop-configs", "recruiter-chatgpt.example.json")), false);
    assert.equal(existsSync(join(outputDir, "desktop-configs", "recruiter-claude.example.json")), false);
    assert.equal(existsSync(join(outputDir, "desktop-configs", "recruiter-claude-code.example.json")), false);
    assert.equal(report.skippedSensitiveFiles.length, 6);
    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /durable-user-token|Authorization|"token"|"authorization"|"config"/);
    assert.equal((await stat(join(outputDir, "bundle-report.json"))).mode & 0o777, 0o600);

    const bundleReport = JSON.parse(await readFile(join(outputDir, "bundle-report.json"), "utf8"));
    const bundledSerialized = JSON.stringify(bundleReport);
    assert.equal(bundleReport.manifestPath, "manifest.example.json");
    assert.equal(bundleReport.outputDir, ".");
    assert.equal(bundleReport.files.every((file: any) => !file.sourcePath.startsWith("/")), true);
    assert.equal(bundleReport.files.every((file: any) => !file.bundledPath.startsWith("/")), true);
    assert.equal(bundleReport.skippedSensitiveFiles.every((path: string) => !path.startsWith("/")), true);
    assert.equal(bundleReport.skippedSensitiveFiles.some((path: string) => path.startsWith("issued-sessions/")), true);
    assert.equal(bundleReport.skippedSensitiveFiles.some((path: string) => path.startsWith("desktop-configs/")), true);
    assert.doesNotMatch(bundledSerialized, new RegExp(escapeRegExp(tmp)));
    assert.doesNotMatch(bundledSerialized, new RegExp(escapeRegExp(sourceDir)));
    assert.doesNotMatch(bundledSerialized, new RegExp(escapeRegExp(outputDir)));
  });

  it("rejects manifest paths that would make the bundle non-portable", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-evidence-bundle-"));
    const sourceDir = join(tmp, "source");
    await cp(exampleEvidenceDir, sourceDir, { recursive: true });
    const manifestPath = join(sourceDir, "manifest.example.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.liveProbes[0].path = "../outside.json";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}
`, "utf8");

    await assert.rejects(
      buildRolloutEvidenceBundle({ manifestPath }),
      /must stay inside the rollout evidence manifest directory/
    );
  });

  it("rejects referenced evidence that contains token or config payloads", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-evidence-bundle-"));
    const sourceDir = join(tmp, "source");
    await cp(exampleEvidenceDir, sourceDir, { recursive: true });
    const manifestPath = join(sourceDir, "manifest.example.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.liveProbes[0].path = "unsafe.json";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}
`, "utf8");
    await writeFile(join(sourceDir, "unsafe.json"), JSON.stringify({ ok: true, token: "durable-user-token" }), "utf8");

    await assert.rejects(
      buildRolloutEvidenceBundle({ manifestPath }),
      /contains durable tokens, Authorization headers, or config payloads/
    );

    manifest.liveProbes[0].path = "unsafe-auth-token.json";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}
`, "utf8");
    await writeFile(join(sourceDir, "unsafe-auth-token.json"), JSON.stringify({ ok: true, authToken: "durable-user-token" }), "utf8");

    await assert.rejects(
      buildRolloutEvidenceBundle({ manifestPath }),
      /contains durable tokens, Authorization headers, or config payloads/
    );

    manifest.liveProbes[0].path = "unsafe-raw-config.json";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}
`, "utf8");
    await writeFile(join(sourceDir, "unsafe-raw-config.json"), JSON.stringify({ ok: true, rawConfig: { server_url: "https://example.com/mcp" } }), "utf8");

    await assert.rejects(
      buildRolloutEvidenceBundle({ manifestPath }),
      /contains durable tokens, Authorization headers, or config payloads/
    );
  });

  it("rejects referenced evidence that hides credential-shaped strings in normal fields", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-evidence-bundle-"));
    const sourceDir = join(tmp, "source");
    await cp(exampleEvidenceDir, sourceDir, { recursive: true });
    const manifestPath = join(sourceDir, "manifest.example.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

    manifest.liveProbes[0].path = "unsafe-bearer.json";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}
`, "utf8");
    await writeFile(join(sourceDir, "unsafe-bearer.json"), JSON.stringify({ ok: true, summary: "proxy leaked Authorization: Bearer durable-session-token-value" }), "utf8");

    await assert.rejects(
      buildRolloutEvidenceBundle({ manifestPath }),
      /contains durable tokens, Authorization headers, or config payloads/
    );

    manifest.liveProbes[0].path = "unsafe-secret.json";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}
`, "utf8");
    await writeFile(join(sourceDir, "unsafe-secret.json"), JSON.stringify({ ok: true, details: { note: "GREENHOUSE_CLIENT_SECRET=client-secret-value" } }), "utf8");

    await assert.rejects(
      buildRolloutEvidenceBundle({ manifestPath }),
      /contains durable tokens, Authorization headers, or config payloads/
    );
  });

  it("allows token-free warning text that names forbidden artifact classes without carrying values", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-evidence-bundle-"));
    const sourceDir = join(tmp, "source");
    await cp(exampleEvidenceDir, sourceDir, { recursive: true });
    const manifestPath = join(sourceDir, "manifest.example.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.liveProbes[0].path = "safe-warning.json";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}
`, "utf8");
    await writeFile(join(sourceDir, "safe-warning.json"), JSON.stringify({ ok: true, warning: "Never paste durable tokens, Authorization headers, or config payloads." }), "utf8");

    const report = await buildRolloutEvidenceBundle({ manifestPath });

    assert.equal(report.ok, true);
  });

  it("refuses to overwrite an existing bundle file unless force is set", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-evidence-bundle-"));
    const outputDir = join(tmp, "bundle");
    const manifestPath = join(exampleEvidenceDir, "manifest.example.json");
    await buildRolloutEvidenceBundle({ manifestPath, outputDir });

    await assert.rejects(
      buildRolloutEvidenceBundle({ manifestPath, outputDir }),
      /already exists; pass --force to overwrite it/
    );

    const report = await buildRolloutEvidenceBundle({ manifestPath, outputDir, force: true });
    assert.equal(report.ok, true);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
