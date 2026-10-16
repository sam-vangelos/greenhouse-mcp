#!/usr/bin/env node
// CLO-119 — Cloud Run deploy preflight. Refuse to build or deploy any commit that is not contained
// in origin/main. Without this gate, a deploy from an unmerged branch ships code no reviewer has
// seen. This is a PREFLIGHT ONLY — it never runs gcloud. Wrap the real deploy with it so
// a refusal short-circuits before anything ships:
//
//   node packages/recruiter-mcp/deploy/cloud-run-deploy.mjs <sha> && gcloud run deploy ...
//
// Exit 0 => the commit is on main, proceed. Non-zero => refused, and the caller's && stops the deploy.
// The commit defaults to HEAD; the base ref defaults to origin/main (override CLOUD_RUN_DEPLOY_BASE_REF).
import { spawnSync } from "node:child_process";

const baseRef = (process.env.CLOUD_RUN_DEPLOY_BASE_REF ?? "origin/main").trim() || "origin/main";
const requested = (process.argv[2] ?? "HEAD").trim() || "HEAD";

function git(args) {
  return spawnSync("git", args, { encoding: "utf8" });
}

function refuse(message) {
  console.error(`[cloud-run-deploy] REFUSED: ${message}`);
  console.error("[cloud-run-deploy] Deploy only commits merged to main. Merge or rebase onto main first, then re-run.");
  process.exit(1);
}

// Best-effort refresh so the check is against the current main, not a stale local copy. Skippable for
// offline/CI-local runs; a fetch failure warns but does not block — the local ref is then authoritative.
if (baseRef === "origin/main" && !process.env.CLOUD_RUN_DEPLOY_SKIP_FETCH) {
  const fetched = git(["fetch", "--quiet", "origin", "main"]);
  if (fetched.status !== 0) {
    console.error("[cloud-run-deploy] WARNING: could not fetch origin/main; checking the local ref instead.");
  }
}

const resolved = git(["rev-parse", "--verify", "--quiet", `${requested}^{commit}`]);
if (resolved.status !== 0 || resolved.stdout.trim().length === 0) {
  refuse(`"${requested}" is not a resolvable commit.`);
}
const sha = resolved.stdout.trim();

const baseResolved = git(["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
if (baseResolved.status !== 0 || baseResolved.stdout.trim().length === 0) {
  refuse(`base ref "${baseRef}" does not resolve; fetch it before deploying.`);
}

const ancestor = git(["merge-base", "--is-ancestor", sha, baseRef]);
if (ancestor.status !== 0) {
  refuse(`${sha} is not contained in ${baseRef}.`);
}

console.error(`[cloud-run-deploy] OK: ${sha} is contained in ${baseRef}; deploy preflight passed.`);
console.error("[cloud-run-deploy] This gate does not deploy — run the gcloud deploy command next.");
process.exit(0);
