// Build/version identity for the running service. `version` is the package
// (MCP protocol server) version; `commit` is the deployed git SHA so the live
// service can report which commit it is running — closing the "deployed sha is
// unknowable from outside" gap. Render injects RENDER_GIT_COMMIT natively; the
// GREENHOUSE_RECRUITER_BUILD_SHA override lets any other host set it explicitly.
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
