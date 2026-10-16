import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// CLO-119: the deploy preflight refuses any commit not contained in the base branch — the guard the
// Render era never had. It never runs gcloud; it only gates the deploy command it wraps.
//
// The test is HERMETIC: it builds a throwaway git repo with a `base` branch and an off-base commit,
// and points the guard at it via CLOUD_RUN_DEPLOY_BASE_REF. It must NOT read the real `origin/main`
// ref — CI checks out a detached merge ref with no `origin/main`, so `git rev-parse origin/main`
// throws there (the bug this replaces). A controlled fixture proves the ancestry logic without any
// dependency on the checkout's refs or the network.
const scriptPath = fileURLToPath(new URL("../deploy/cloud-run-deploy.mjs", import.meta.url));

let repo: string;
let onBase: string; // a commit reachable from `base`
let offBase: string; // a commit NOT reachable from `base`

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function runGuard(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      // Hermetic: check a fixture branch, never the real origin/main, and never the network.
      CLOUD_RUN_DEPLOY_BASE_REF: "base",
      CLOUD_RUN_DEPLOY_SKIP_FETCH: "1",
    },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

before(() => {
  repo = mkdtempSync(join(tmpdir(), "clo119-deploy-guard-"));
  git(repo, ["init", "--quiet", "--initial-branch", "base"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["commit", "--quiet", "--allow-empty", "-m", "on base"]);
  onBase = git(repo, ["rev-parse", "HEAD"]);
  // A second commit on a different branch — reachable from nothing named `base`.
  git(repo, ["checkout", "--quiet", "-b", "feature"]);
  git(repo, ["commit", "--quiet", "--allow-empty", "-m", "off base"]);
  offBase = git(repo, ["rev-parse", "HEAD"]);
});

after(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("cloud run deploy preflight (CLO-119)", () => {
  it("refuses an unresolvable commit", () => {
    const result = runGuard(["0000000000000000000000000000000000000000"]);
    assert.notEqual(result.status, 0, "an unresolvable commit must not pass the deploy gate");
    assert.match(`${result.stdout}${result.stderr}`, /REFUSED/);
  });

  it("refuses a commit that is not contained in the base branch", () => {
    const result = runGuard([offBase]);
    assert.notEqual(result.status, 0, "an off-base commit must not pass the deploy gate");
    assert.match(`${result.stdout}${result.stderr}`, /REFUSED/);
  });

  it("proceeds for a commit contained in the base branch", () => {
    const result = runGuard([onBase]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, /preflight passed/);
  });

  it("is a preflight only — it never invokes gcloud itself", () => {
    const result = runGuard([onBase]);
    // It states that the caller runs the deploy next; it must not shell out to gcloud on its own.
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /^\s*Deploying|Service \[.*\] revision/m);
  });
});
