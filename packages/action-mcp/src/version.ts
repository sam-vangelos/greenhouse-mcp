export const SERVER_NAME = "greenhouse-action-mcp";
export const SERVER_VERSION = "0.2.0";

export function buildVersionInfo(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.RENDER_GIT_COMMIT ?? env.GREENHOUSE_ACTION_BUILD_SHA;
  const commit = raw?.trim() || "unknown";
  return { name: SERVER_NAME, version: SERVER_VERSION, commit };
}
