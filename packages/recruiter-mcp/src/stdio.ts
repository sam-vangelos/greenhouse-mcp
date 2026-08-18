import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readSessionFromEnv } from "./auth.js";
import { createAuditSinkFromEnv } from "./audit.js";
import { createRecruiterMcpServer } from "./server.js";
import { mountActionPlane } from "./action-plane.js";
import { readBooleanEnvFlag } from "./env.js";

export async function startStdioRecruiterMcp(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_MCP_DISABLED")) {
    throw new Error("Recruiter Greenhouse MCP is disabled.");
  }
  const sessionResult = await readSessionFromEnv(env);
  if (sessionResult.status !== "valid") {
    throw new Error(sessionResult.reason);
  }
  if (sessionResult.session.surface === "test" && !readBooleanEnvFlag(env, "GREENHOUSE_RECRUITER_ALLOW_TEST_SURFACE")) {
    throw new Error("Stdio recruiter MCP test surface requires GREENHOUSE_RECRUITER_ALLOW_TEST_SURFACE=true.");
  }
  if (sessionResult.session.surface !== "claude_desktop" && sessionResult.session.surface !== "test") {
    throw new Error("Stdio recruiter MCP requires a claude_desktop session token.");
  }
  // A distributable stdio surface (claude_desktop given to a recruiter) must fail
  // closed without retained audit, matching the hosted path; only the gated dev
  // test surface may fall back to the console audit sink.
  const auditSink = createAuditSinkFromEnv(env, {
    requireRetained: sessionResult.session.surface !== "test",
  });
  const actionPlane = await mountActionPlane({ session: sessionResult.session, env });
  const { server, registeredTools } = createRecruiterMcpServer({
    session: sessionResult.session,
    env,
    auditSink,
    ...(actionPlane ? { actionPlane } : {}),
  });
  console.error(`[greenhouse-recruiter-mcp] registered ${registeredTools.length} scoped recruiter tools for stdio`);
  await server.connect(new StdioServerTransport());
}
