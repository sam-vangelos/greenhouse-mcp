import { randomUUID } from "node:crypto";

export function reportActionError(
  event: string,
  error: unknown,
  details: Record<string, string | number | boolean | null> = {}
): string {
  const correlationId = randomUUID();
  const status = error !== null && typeof error === "object" && "status" in error
    && typeof error.status === "number" ? error.status : undefined;
  const requestId = error !== null && typeof error === "object" && "requestId" in error
    && typeof error.requestId === "string" ? error.requestId : undefined;
  console.error(JSON.stringify({
    service: "greenhouse-action-mcp",
    event,
    correlation_id: correlationId,
    ...details,
    error_name: error instanceof Error ? error.name : "UnknownError",
    ...(status === undefined ? {} : { upstream_status: status }),
    ...(requestId === undefined ? {} : { upstream_request_id: requestId }),
  }));
  return correlationId;
}
