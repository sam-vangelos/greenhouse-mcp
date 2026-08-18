import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ACTION_DEFINITIONS } from "./actions/index.js";
import { reportActionError } from "./diagnostics.js";
import { createGreenhouseActionServiceFromEnv, readActionRuntimeFlags } from "./env.js";
import type { ActionRuntime } from "./env.js";
import { ActionDeniedError } from "./errors.js";
import type { GreenhouseActionService } from "./service.js";
import type { ActionKind, ActionSession } from "./types.js";

export function createGreenhouseActionMcpServer(input: {
  session: ActionSession;
  env?: NodeJS.ProcessEnv;
  service?: GreenhouseActionService;
  runtime?: ActionRuntime;
  capabilities?: ReadonlySet<ActionKind>;
}): { server: McpServer } {
  const service = input.service ?? createGreenhouseActionServiceFromEnv(input.session, input.env, input.runtime);
  const capabilities = input.capabilities ?? readActionRuntimeFlags(input.env).catalogCapabilities;
  const server = new McpServer(
    { name: "greenhouse-action-mcp", version: "0.2.0" },
    {
      instructions: [
        "Greenhouse action server for explicit, approved writes.",
        "Always call the matching preview tool first and show its exact target, before, after, and effects to the human.",
        "Call apply only after fresh explicit human approval, passing the opaque intent and approval echo exactly as preview returned them.",
        "Never invent actor, act-as, confirmation, raw endpoint, or risk-tier fields. Replays return recorded results without another mutation.",
      ].join("\n"),
    }
  );

  for (const definition of ACTION_DEFINITIONS) {
    if (!capabilities.has(definition.kind)) continue;
    server.registerTool(definition.previewTool, {
      title: definition.previewTitle,
      description: definition.previewDescription,
      inputSchema: definition.catalogPreviewSchema ?? definition.previewSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    }, async (args) => toolResult(definition.previewTool, () => service.preview(definition.kind, args)));

    server.registerTool(definition.applyTool, {
      title: definition.applyTitle,
      description: definition.applyDescription,
      inputSchema: definition.catalogApplySchema ?? definition.applySchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: definition.destructive,
        idempotentHint: true,
        openWorldHint: true,
      },
    }, async (args) => toolResult(definition.applyTool, () => service.apply(definition.kind, args)));
  }
  return { server };
}

async function toolResult(tool: string, run: () => Promise<Record<string, unknown>>) {
  try {
    const structuredContent = await run();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  } catch (error) {
    const publicError = error instanceof ActionDeniedError
      ? {
          code: error.code,
          message: error.message,
          ...(typeof error.diagnostic?.upstreamStatus === "number"
            ? { upstream_status: error.diagnostic.upstreamStatus } : {}),
          ...(typeof error.diagnostic?.upstreamRequestId === "string"
            ? { upstream_request_id: error.diagnostic.upstreamRequestId } : {}),
        }
      : { code: "ACTION_SERVICE_UNAVAILABLE", message: "The Greenhouse action service is unavailable." };
    const shouldReport = !(error instanceof ActionDeniedError) || error.diagnostic !== undefined;
    const correlationId = shouldReport
      ? reportActionError("tool_failed", error, {
          tool,
          code: publicError.code,
          ...(error instanceof ActionDeniedError && error.diagnostic
            ? {
                source_error_name: error.diagnostic.sourceErrorName,
                ...(typeof error.diagnostic.upstreamStatus === "number"
                  ? { upstream_status: error.diagnostic.upstreamStatus } : {}),
                ...(typeof error.diagnostic.upstreamRequestId === "string"
                  ? { upstream_request_id: error.diagnostic.upstreamRequestId } : {}),
              } : {}),
        })
      : undefined;
    return {
      isError: true,
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          error: { ...publicError, ...(correlationId ? { correlation_id: correlationId } : {}) },
        }),
      }],
    };
  }
}
