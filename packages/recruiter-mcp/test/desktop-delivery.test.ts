import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  buildDesktopDeliveryEvidenceFromManifestFile,
  writeDesktopDeliveryEvidenceFile,
} from "../src/desktop-delivery.js";

describe("desktop config delivery evidence", () => {
  it("builds a token-free delivery report from the desktop config manifest", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-desktop-delivery-"));
    const manifestPath = join(tmp, "manifest.json");
    const reportPath = join(tmp, "desktop-delivery.json");
    await writeDesktopConfigManifest(manifestPath);

    const report = await buildDesktopDeliveryEvidenceFromManifestFile({
      desktopConfigManifestPath: manifestPath,
      reportPath,
      deliveredBy: "ops-reviewer@example.com",
      deliveryChannel: "managed_desktop_install",
      deliveredAt: "2026-06-23T00:00:00.000Z",
      attestDeliveredToMatchingRecruiters: true,
    });

    assert.equal(report.ok, true);
    assert.equal(report.containsTokens, false);
    assert.equal(report.desktopConfigManifestPath, "manifest.json");
    assert.equal(report.deliveries.length, 2);
    assert.deepEqual(report.deliveries.map((entry) => `${entry.email}:${entry.surface}:${entry.tokenId}`), [
      "recruiter.one@company.com:claude_desktop:claude-token-id",
      "recruiter.one@company.com:chatgpt_desktop:chatgpt-token-id",
    ]);
    assert.equal(report.deliveries.every((entry) => entry.recipientEmail === entry.email), true);
    assert.equal(report.deliveries.every((entry) => entry.deliveryChannel === "managed_desktop_install"), true);
    assert.equal(report.deliveries[0]?.configPath, "desktop-configs/recruiter-one-claude.json");
    assert.equal(report.deliveries.every((entry) => !entry.configPath.startsWith("/")), true);
    assert.equal(JSON.stringify(report).includes(tmp), false);
    assert.equal(JSON.stringify(report).includes("durable-user-token"), false);
    assert.doesNotMatch(JSON.stringify(report), /"token"|"authorization"|"Authorization"|"config"/);
  });

  it("requires an explicit matching-recipient attestation", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-desktop-delivery-"));
    const manifestPath = join(tmp, "manifest.json");
    await writeDesktopConfigManifest(manifestPath);

    await assert.rejects(
      buildDesktopDeliveryEvidenceFromManifestFile({
        desktopConfigManifestPath: manifestPath,
        deliveredBy: "ops-reviewer@example.com",
        deliveryChannel: "managed_desktop_install",
        deliveredAt: "2026-06-23T00:00:00.000Z",
        attestDeliveredToMatchingRecruiters: false,
      }),
      /attest-delivered-to-matching-recruiters/
    );
  });

  it("rejects ad hoc desktop delivery channels for broad rollout", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-desktop-delivery-"));
    const manifestPath = join(tmp, "manifest.json");
    await writeDesktopConfigManifest(manifestPath);

    await assert.rejects(
      buildDesktopDeliveryEvidenceFromManifestFile({
        desktopConfigManifestPath: manifestPath,
        deliveredBy: "ops-reviewer@example.com",
        deliveryChannel: "email_attachment",
        deliveredAt: "2026-06-23T00:00:00.000Z",
        attestDeliveredToMatchingRecruiters: true,
      }),
      /deliveryChannel must be one of/
    );
  });

  it("rejects manifests that contain token or config payloads", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-desktop-delivery-"));
    const cases: Array<{ name: string; extra: Record<string, unknown> }> = [
      { name: "exact-token", extra: { token: "durable-user-token" } },
      { name: "auth-token", extra: { authToken: "durable-user-token" } },
      { name: "raw-config", extra: { rawConfig: { mcpServers: { greenhouse: {} } } } },
      { name: "bearer-string", extra: { operatorNote: "proxy leaked Authorization: Bearer durable-session-token-value" } },
      { name: "greenhouse-secret-string", extra: { operatorNote: "GREENHOUSE_CLIENT_SECRET=client-secret-value" } },
    ];

    for (const { name, extra } of cases) {
      const manifestPath = join(tmp, `${name}-manifest.json`);
      await writeDesktopConfigManifest(manifestPath, extra);

      await assert.rejects(
        buildDesktopDeliveryEvidenceFromManifestFile({
          desktopConfigManifestPath: manifestPath,
          deliveredBy: "ops-reviewer@example.com",
          deliveryChannel: "managed_desktop_install",
          deliveredAt: "2026-06-23T00:00:00.000Z",
          attestDeliveredToMatchingRecruiters: true,
        }),
        /must not contain durable tokens/
      );
    }
  });

  it("rejects desktop config manifests with non-exact durable token metadata", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-desktop-delivery-"));
    const tokenIdManifestPath = join(tmp, "manifest-token-id.json");
    await writeDesktopConfigManifest(tokenIdManifestPath, {
      files: [{
        email: "recruiter.one@company.com",
        surface: "chatgpt_desktop",
        subject: "email:recruiter.one@company.com",
        tokenId: " chatgpt-token-id",
        issuedAt: "2026-06-23T00:00:00.000Z",
        path: join("desktop-configs", "recruiter-one-chatgpt.json"),
      }],
    });

    await assert.rejects(
      buildDesktopDeliveryEvidenceFromManifestFile({
        desktopConfigManifestPath: tokenIdManifestPath,
        deliveredBy: "ops-reviewer@example.com",
        deliveryChannel: "managed_desktop_install",
        deliveredAt: "2026-06-23T00:00:00.000Z",
        attestDeliveredToMatchingRecruiters: true,
      }),
      /token id/
    );

    const issuedAtManifestPath = join(tmp, "manifest-issued-at.json");
    await writeDesktopConfigManifest(issuedAtManifestPath, {
      files: [{
        email: "recruiter.one@company.com",
        surface: "chatgpt_desktop",
        subject: "email:recruiter.one@company.com",
        tokenId: "chatgpt-token-id",
        issuedAt: "2026-06-23T00:00:00Z",
        path: join("desktop-configs", "recruiter-one-chatgpt.json"),
      }],
    });

    await assert.rejects(
      buildDesktopDeliveryEvidenceFromManifestFile({
        desktopConfigManifestPath: issuedAtManifestPath,
        deliveredBy: "ops-reviewer@example.com",
        deliveryChannel: "managed_desktop_install",
        deliveredAt: "2026-06-23T00:00:00.000Z",
        attestDeliveredToMatchingRecruiters: true,
      }),
      /issued-at/
    );
  });

  it("rejects desktop config manifests with non-portable file paths", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-desktop-delivery-"));
    const absolutePathManifestPath = join(tmp, "absolute-path-manifest.json");
    await writeDesktopConfigManifest(absolutePathManifestPath, {
      manifestPath: "absolute-path-manifest.json",
      files: [{
        email: "recruiter.one@company.com",
        surface: "chatgpt_desktop",
        subject: "email:recruiter.one@company.com",
        tokenId: "chatgpt-token-id",
        issuedAt: "2026-06-23T00:00:00.000Z",
        path: join(tmpdir(), "recruiter-one-chatgpt.json"),
      }],
    });

    await assert.rejects(
      buildDesktopDeliveryEvidenceFromManifestFile({
        desktopConfigManifestPath: absolutePathManifestPath,
        deliveredBy: "ops-reviewer@example.com",
        deliveryChannel: "managed_desktop_install",
        deliveredAt: "2026-06-23T00:00:00.000Z",
        attestDeliveredToMatchingRecruiters: true,
      }),
      /portable relative path/
    );

    const escapingPathManifestPath = join(tmp, "escaping-path-manifest.json");
    await writeDesktopConfigManifest(escapingPathManifestPath, {
      manifestPath: "escaping-path-manifest.json",
      files: [{
        email: "recruiter.one@company.com",
        surface: "chatgpt_desktop",
        subject: "email:recruiter.one@company.com",
        tokenId: "chatgpt-token-id",
        issuedAt: "2026-06-23T00:00:00.000Z",
        path: "../recruiter-one-chatgpt.json",
      }],
    });

    await assert.rejects(
      buildDesktopDeliveryEvidenceFromManifestFile({
        desktopConfigManifestPath: escapingPathManifestPath,
        deliveredBy: "ops-reviewer@example.com",
        deliveryChannel: "managed_desktop_install",
        deliveredAt: "2026-06-23T00:00:00.000Z",
        attestDeliveredToMatchingRecruiters: true,
      }),
      /portable relative path/
    );
  });

  it("writes delivery reports with restrictive permissions", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "greenhouse-desktop-delivery-"));
    const manifestPath = join(tmp, "manifest.json");
    const outPath = join(tmp, "desktop-delivery.json");
    await writeDesktopConfigManifest(manifestPath);

    const report = await buildDesktopDeliveryEvidenceFromManifestFile({
      desktopConfigManifestPath: manifestPath,
      reportPath: outPath,
      deliveredBy: "ops-reviewer@example.com",
      deliveryChannel: "managed_desktop_install",
      deliveredAt: "2026-06-23T00:00:00.000Z",
      attestDeliveredToMatchingRecruiters: true,
    });
    await writeDesktopDeliveryEvidenceFile(report, outPath);

    const written = JSON.parse(await readFile(outPath, "utf8"));
    assert.equal(written.containsTokens, false);
    assert.equal((await stat(outPath)).mode & 0o777, 0o600);
  });
});

async function writeDesktopConfigManifest(path: string, extra: Record<string, unknown> = {}): Promise<void> {
  await writeFile(path, JSON.stringify({
    ok: true,
    outputDir: ".",
    manifestPath: basename(path),
    fileCount: 2,
    containsTokens: false,
    configFilesContainTokens: true,
    warning: "token-free manifest",
    files: [
      {
        email: "Recruiter.One@Company.com",
        surface: "claude_desktop",
        subject: "email:recruiter.one@company.com",
        tokenId: "claude-token-id",
        issuedAt: "2026-06-23T00:00:00.000Z",
        path: "desktop-configs/recruiter-one-claude.json",
      },
      {
        email: "recruiter.one@company.com",
        surface: "chatgpt_desktop",
        subject: "email:recruiter.one@company.com",
        tokenId: "chatgpt-token-id",
        issuedAt: "2026-06-23T00:00:00.000Z",
        path: "desktop-configs/recruiter-one-chatgpt.json",
      },
    ],
    ...extra,
  }, null, 2), "utf8");
}
