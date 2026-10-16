import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVersionInfo, readBuildCommit, SERVER_NAME, SERVER_VERSION } from "../src/version.js";

test("readBuildCommit reads RENDER_GIT_COMMIT", () => {
  assert.equal(readBuildCommit({ RENDER_GIT_COMMIT: "abc1234" } as NodeJS.ProcessEnv), "abc1234");
});

test("readBuildCommit honors the explicit override when Render's var is absent", () => {
  assert.equal(readBuildCommit({ GREENHOUSE_RECRUITER_BUILD_SHA: "deadbeef" } as NodeJS.ProcessEnv), "deadbeef");
});

test("readBuildCommit prefers RENDER_GIT_COMMIT over the override", () => {
  assert.equal(
    readBuildCommit({ RENDER_GIT_COMMIT: "render-sha", GREENHOUSE_RECRUITER_BUILD_SHA: "override" } as NodeJS.ProcessEnv),
    "render-sha"
  );
});

test("readBuildCommit falls back to 'unknown' when unset or blank", () => {
  assert.equal(readBuildCommit({} as NodeJS.ProcessEnv), "unknown");
  assert.equal(readBuildCommit({ RENDER_GIT_COMMIT: "   " } as NodeJS.ProcessEnv), "unknown");
});

test("buildVersionInfo carries name, package version, and the resolved commit", () => {
  const info = buildVersionInfo({ RENDER_GIT_COMMIT: "abc1234" } as NodeJS.ProcessEnv);
  assert.deepEqual(info, { name: SERVER_NAME, version: SERVER_VERSION, commit: "abc1234" });
});
