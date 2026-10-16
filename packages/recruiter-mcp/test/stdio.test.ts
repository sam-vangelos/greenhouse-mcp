import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSignedSessionToken } from "../src/auth.js";
import { startStdioRecruiterMcp } from "../src/stdio.js";
import type { AuthenticatedSession } from "../src/types.js";

const STRONG_SESSION_SECRET = "stdio-session-secret-with-at-least-32-chars";

const testSession: AuthenticatedSession = {
  subject: "test-user",
  email: "test-user@example.com",
  surface: "test",
  tokenId: "stdio-test-token-id",
  issuedAt: "2026-06-23T00:00:00.000Z",
};

describe("stdio recruiter MCP startup", () => {
  it("honors the whole-server kill switch before validating local session config", async () => {
    await assert.rejects(
      async () => startStdioRecruiterMcp({ GREENHOUSE_RECRUITER_MCP_DISABLED: "true" } as NodeJS.ProcessEnv),
      /disabled/
    );
  });

  it("rejects malformed stdio kill-switch booleans instead of silently starting", async () => {
    await assert.rejects(
      async () => startStdioRecruiterMcp({ GREENHOUSE_RECRUITER_MCP_DISABLED: " true " } as NodeJS.ProcessEnv),
      /GREENHOUSE_RECRUITER_MCP_DISABLED must be exactly "true" or "false"/
    );
  });

  it("denies internal test-surface stdio sessions unless explicitly enabled", async () => {
    const token = createSignedSessionToken(testSession, STRONG_SESSION_SECRET);

    await assert.rejects(
      async () => startStdioRecruiterMcp({
        GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
        GREENHOUSE_RECRUITER_SESSION_TOKEN: token,
      } as NodeJS.ProcessEnv),
      /ALLOW_TEST_SURFACE=true/
    );
  });
});
