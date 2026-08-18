import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isJSONRPCRequest, isJSONRPCResultResponse } from "@modelcontextprotocol/sdk/types.js";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() !== value) throw new Error(`Missing or malformed ${name}.`);
  return value;
}

function decodeClaims(token) {
  if (token.length < 32 || /\s/.test(token)) throw new Error("The pilot credential is malformed.");
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("The pilot credential is malformed.");
  try {
    const claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) throw new Error("invalid claims");
    return claims;
  } catch {
    throw new Error("The pilot credential is malformed.");
  }
}

function readConfig() {
  const remoteUrl = requiredEnv("GREENHOUSE_RECRUITER_REMOTE_MCP_URL");
  const token = requiredEnv("GREENHOUSE_RECRUITER_REMOTE_AUTH_TOKEN");
  const expectedEmail = requiredEnv("GREENHOUSE_RECRUITER_EXPECTED_EMAIL").toLowerCase();
  const expectedTokenId = requiredEnv("GREENHOUSE_RECRUITER_EXPECTED_TOKEN_ID");
  const expectedIssuedAt = requiredEnv("GREENHOUSE_RECRUITER_EXPECTED_ISSUED_AT");
  const parsed = new URL(remoteUrl);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("The configured recruiter MCP endpoint is invalid.");
  }
  const claims = decodeClaims(token);
  if (claims.email !== expectedEmail || claims.subject !== `email:${expectedEmail}` ||
      claims.surface !== "claude_desktop" || claims.client !== "claude_desktop_chat" ||
      claims.tokenId !== expectedTokenId || claims.issuedAt !== expectedIssuedAt) {
    throw new Error("The pilot credential does not match this Claude Desktop extension.");
  }
  return { remoteUrl, token };
}

async function startBridge() {
  const { remoteUrl, token } = readConfig();
  const remote = new StreamableHTTPClientTransport(new URL(remoteUrl), {
    requestInit: { cache: "no-store", headers: { Authorization: `Bearer ${token}` } },
  });
  const local = new StdioServerTransport();
  let closing = false;
  const closeBoth = async () => {
    if (closing) return;
    closing = true;
    await Promise.allSettled([local.close(), remote.close()]);
  };
  local.onmessage = (message) => void remote.send(message).catch(() => void sendRequestError(local, message));
  remote.onmessage = (message) => {
    if (remote.setProtocolVersion && isJSONRPCResultResponse(message)) {
      const result = message.result;
      if (result && typeof result === "object" && !Array.isArray(result) && typeof result.protocolVersion === "string") {
        remote.setProtocolVersion(result.protocolVersion);
      }
    }
    void local.send(message).catch(() => process.stderr.write("[greenhouse-recruiter] local transport send failed.\n"));
  };
  local.onerror = () => process.stderr.write("[greenhouse-recruiter] local transport error.\n");
  remote.onerror = () => process.stderr.write("[greenhouse-recruiter] remote transport error.\n");
  local.onclose = () => void closeBoth();
  remote.onclose = () => void closeBoth();
  await remote.start();
  await local.start();
  process.once("SIGINT", () => void closeBoth());
  process.once("SIGTERM", () => void closeBoth());
}

async function sendRequestError(local, original) {
  if (!isJSONRPCRequest(original)) return;
  await local.send({
    jsonrpc: "2.0",
    id: original.id,
    error: { code: -32603, message: "The remote Greenhouse recruiting service could not complete the request." },
  });
}

startBridge().catch((error) => {
  const message = error instanceof Error && /^(Missing or malformed|The configured|The pilot credential)/.test(error.message)
    ? error.message
    : "The Greenhouse recruiting extension could not start.";
  process.stderr.write(`[greenhouse-recruiter] ${message}\n`);
  process.exit(1);
});
