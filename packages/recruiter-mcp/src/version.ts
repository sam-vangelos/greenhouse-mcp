// Build/version identity for the running service. `version` is the package
// (MCP protocol server) version; `commit` is the deployed git SHA so the live
// service can report which commit it is running — closing the "deployed sha is
// unknowable from outside" gap. Hosts that inject RENDER_GIT_COMMIT are read
// natively; GREENHOUSE_RECRUITER_BUILD_SHA lets any other host (Cloud Run included) set it.
export const SERVER_NAME = "greenhouse-recruiter-mcp";
export const SERVER_VERSION = "0.1.0";

export interface BuildVersionInfo {
  name: string;
  version: string;
  commit: string;
}

export function readBuildCommit(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.RENDER_GIT_COMMIT ?? env.GREENHOUSE_RECRUITER_BUILD_SHA;
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "unknown";
}

export function buildVersionInfo(env: NodeJS.ProcessEnv = process.env): BuildVersionInfo {
  return { name: SERVER_NAME, version: SERVER_VERSION, commit: readBuildCommit(env) };
}
