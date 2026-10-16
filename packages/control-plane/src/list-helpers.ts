/**
 * Cursor-validation and list-endpoint routing for Greenhouse v3 pagination.
 */

import { apiGet, apiGetWithCursor, type ApiResponse } from "./client.js";

/**
 * Throws if cursor is combined with any defined parameter.
 * Per Greenhouse v3 docs, cursor must be the only query parameter.
 */
export function validateCursorExclusivity(
  params: Record<string, string | number | boolean | undefined>,
  cursor: string | undefined
): void {
  if (!cursor) return;
  const extraParams = Object.entries(params).filter(
    ([, value]) => value !== undefined && value !== ""
  );
  if (extraParams.length > 0) {
    throw new Error(
      `Cannot combine cursor with other parameters. Per Greenhouse v3 docs, cursor must be the only query parameter. ` +
      `Extra parameters provided: ${extraParams.map(([k]) => k).join(", ")}. ` +
      `Remove them or drop the cursor to start a new query.`
    );
  }
}

/**
 * Route a list request through cursor-based or param-based pagination.
 */
export async function listEndpoint<T>(
  path: string,
  params: Record<string, string | number | boolean | undefined>,
  cursor?: string
): Promise<ApiResponse<T>> {
  validateCursorExclusivity(params, cursor);
  if (cursor) {
    return apiGetWithCursor<T>(path, cursor);
  }
  return apiGet<T>(path, params);
}
