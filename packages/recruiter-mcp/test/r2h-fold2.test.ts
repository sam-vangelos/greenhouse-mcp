import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ACTION_DEFINITIONS, readActionRuntimeFlags } from "../../action-mcp/dist/index.js";
import { createRecruiterMcpServer } from "../src/server.js";
import { classifyDistributionCatalog, validateRemoteToolCatalog } from "../src/distribution-validation.js";
import { PILOT_TOOL_NAMES } from "../src/tools/register.js";
import { createHarvestPermissionProvider, createScopedGreenhouseReader, type ApiResponse, type RawReadClient } from "../../scoped-core/src/index.js";
import { createSiteAdminAwarePermissionProvider } from "../src/site-admin-permission.js";
import { profileForPermissionScope } from "../src/tools/evidence-projection.js";
import { runEvidenceTool } from "../src/tools/evidence.js";
import type { AuthenticatedSession, ScopedReaderLike } from "../src/types.js";
import { fakeScopedReader, scopedSuccess, testRuntime } from "./test-helpers.js";

// The default-on action catalog: CLO-401's interview kinds are opt-in and not in a default grant.
const DEFAULT_KINDS = readActionRuntimeFlags({}).catalogCapabilities;
const ACTION_TOOL_NAMES = ACTION_DEFINITIONS.filter((definition) => DEFAULT_KINDS.has(definition.kind)).flatMap((definition: { previewTool: string; applyTool: string }) => [
  definition.previewTool,
  definition.applyTool,
]);

/**
 * The R2 fold 2: what the first fold left disclosing, adopting, assuming or stale.
 *
 * Every case here fails on 8e3483b (the fold-1 head). The recurring shape is the same one the
 * attacker named twice over: a property asserted on the three fields somebody remembered, while the
 * rest of the object went on answering the question the guard exists to refuse.
 */

const STAFF_EMAIL_ROW = { id: 2, user_id: 77, email: "colleague@example.com", verified: true };

/**
 * The same role-gated read, run three ways by the same job-scoped recruiter: an id that HAS a staff
 * email row, an id nobody holds, and an id whose rows span two upstream pages. The envelope the
 * caller receives has to be one object, not three.
 */
async function deniedEnvelope(options: { userIds: string; pages?: number }) {
  const pages = options.pages ?? 1;
  let page = 0;
  const reader = fakeScopedReader((toolName, params) => {
    const matches = params?.user_ids === "77" || params?.cursor !== undefined;
    if (!matches) return scopedSuccess(toolName, [], null, { permissionScope: { kind: "jobs", permittedJobCount: 3 } });
    page += 1;
    return scopedSuccess(
      toolName,
      [STAFF_EMAIL_ROW],
      page < pages ? `page-${page + 1}` : null,
      { permissionScope: { kind: "jobs", permittedJobCount: 3 } }
    );
  });
  const { runtime } = testRuntime(reader);
  const result = await runEvidenceTool(runtime, "search_my_user_emails", { user_ids: options.userIds });
  assert.equal(result.ok, true);
  return result;
}

describe("fold 2 item 1: the denied envelope is one canonical object", () => {
  it("returns a byte-identical result for an existing id, a missing id and a multi-page match", async () => {
    const existing = await deniedEnvelope({ userIds: "77" });
    const missing = await deniedEnvelope({ userIds: "999999" });
    const multiPage = await deniedEnvelope({ userIds: "77", pages: 3 });

    assert.deepStrictEqual(existing, missing, "the WHOLE envelope, not the three fields someone remembered");
    assert.deepStrictEqual(existing, multiPage, "nor may the pages the read cost say a row was there");
  });

  it("stays canonical when the caller sends an exclusive date bound", async () => {
    // The inclusive-bound disclosure is appended AFTER projection, so it could have reopened the
    // shape. A denied envelope has no answer to widen, so it is the same object here too.
    const reader = fakeScopedReader((toolName) =>
      scopedSuccess(toolName, [STAFF_EMAIL_ROW], null, { permissionScope: { kind: "jobs", permittedJobCount: 3 } })
    );
    const { runtime } = testRuntime(reader);
    const windowed = await runEvidenceTool(runtime, "search_my_user_emails", {
      user_ids: "77",
      created_at: "inclusive-bounds:2026-04-01..",
    });
    assert.equal(windowed.ok && windowed.read?.bounds_treated_inclusive, undefined);
    const plain = await deniedEnvelope({ userIds: "77" });
    assert.deepStrictEqual(
      windowed.ok ? windowed.read : null,
      plain.ok ? plain.read : undefined,
      "one denied envelope, whatever was asked"
    );
  });

  it("carries zero counts, a complete status, no pagination fields and an empty omission list", async () => {
    const denied = await deniedEnvelope({ userIds: "77", pages: 2 });
    assert.equal(denied.ok, true);
    if (!denied.ok) return;
    assert.deepStrictEqual(denied.data, []);
    assert.equal(denied.nextCursor, null);
    assert.deepStrictEqual(denied.rowCounts, { raw: 0, returned: 0, permissionExcluded: 0, unresolved: 0, status: "complete" });
    assert.deepStrictEqual(denied.read, {
      complete: true,
      status: "complete",
      rows_returned: 0,
      raw_rows_read: 0,
      permission_excluded: 0,
      unresolved_scope_rows: 0,
      warnings: [],
    });
    assert.deepStrictEqual(denied.projection?.omittedFields, [], "the source row's field names are the row's existence, spelled out");
    assert.equal(denied.projection?.requiredFieldOmissions.length, 0);
    assert.equal(denied.projection?.incompleteProjection, false);
    assert.equal(denied.projection?.roleGatedRowsWithheld?.reason, "privacy");
  });

  it("keeps the operator's own audit record on the RAW counts, which is not model-facing", async () => {
    const reader = fakeScopedReader((toolName, params) =>
      scopedSuccess(toolName, params?.user_ids === "77" ? [STAFF_EMAIL_ROW] : [], null, {
        permissionScope: { kind: "jobs", permittedJobCount: 3 },
      })
    );
    const { runtime, auditSink } = testRuntime(reader);
    await runEvidenceTool(runtime, "search_my_user_emails", { user_ids: "77" });
    await runEvidenceTool(runtime, "search_my_user_emails", { user_ids: "999999" });
    const reads = auditSink.events.filter((event) => event.tool === "search_my_user_emails");
    assert.equal(reads.length, 2);
    assert.equal(reads[0]?.rowsRead, 1, "the operator's log says what the read actually cost");
    assert.equal(reads[1]?.rowsRead, 0);
  });
});

describe("fold 2 item 2: the ACTION order is canonical, not whatever the deployment sent", () => {
  it("refuses a reversed action suffix instead of adopting it as expected", () => {
    const reversed = [...PILOT_TOOL_NAMES, ...[...ACTION_TOOL_NAMES].reverse()];
    const classified = classifyDistributionCatalog(reversed);
    assert.equal(classified.variant, "read_only", "a catalog in the wrong order is a defect, not a variant");

    const checks = validateRemoteToolCatalog(reversed);
    assert.equal(checks.find((check) => check.name === "exact_tool_catalog")?.status, "fail");
    assert.equal(checks.find((check) => check.name === "no_unexpected_tools")?.status, "fail");
  });

  it("refuses a one-swap action suffix", () => {
    const swapped = [...ACTION_TOOL_NAMES];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    const classified = classifyDistributionCatalog([...PILOT_TOOL_NAMES, ...swapped]);
    assert.equal(classified.variant, "read_only");
  });

  it("still accepts the canonical write-entitled catalog, and says so in canonical order", () => {
    const entitled = [...PILOT_TOOL_NAMES, ...ACTION_TOOL_NAMES];
    const classified = classifyDistributionCatalog(entitled);
    assert.equal(classified.variant, "write_entitled");
    assert.deepEqual(classified.expected, entitled);
    assert.equal(validateRemoteToolCatalog(entitled).find((check) => check.name === "exact_tool_catalog")?.status, "pass");
  });
});

describe("fold 2 item 4: a proven site admin keeps the role when only the JOB narrowing fails", () => {
  /** /users answers "site admin"; /jobs?confidential throws; the base grants jobs 7 and 8. */
  function narrowedAdminReader(): RawReadClient {
    return {
      async read<T>(path: string): Promise<ApiResponse<T>> {
        if (path === "/users") return { data: [{ id: 42, site_admin: true }] as T, nextCursor: null };
        if (path === "/jobs") throw new Error("confidential job read failed");
        if (path === "/user_job_permissions") {
          return { data: [{ id: 1, user_id: 42, job_id: 7 }, { id: 2, user_id: 42, job_id: 8 }] as T, nextCursor: null };
        }
        if (path === "/user_emails") return { data: [STAFF_EMAIL_ROW] as T, nextCursor: null };
        return { data: [] as T, nextCursor: null };
      },
    };
  }

  it("carries siteAdmin on the narrowed fallback scope", async () => {
    const rawReader = narrowedAdminReader();
    const provider = createSiteAdminAwarePermissionProvider({
      base: createHarvestPermissionProvider({ rawReader }),
      rawReader,
    });

    const scope = await provider.getPermittedJobIds(42);

    assert.equal("kind" in scope && scope.kind, "jobs", "the JOB narrowing is a correct fail-closed and stands");
    assert.deepEqual("kind" in scope && scope.kind === "jobs" ? [...scope.jobIds] : [], [7, 8]);
    assert.equal("kind" in scope && scope.siteAdmin, true, "the ROLE was proven by /users and nothing unproved it");
  });

  it("admits jobs + siteAdmin to the admin projection", () => {
    assert.equal(profileForPermissionScope({ kind: "jobs", siteAdmin: true }), "operator_site_admin");
    assert.equal(profileForPermissionScope({ kind: "jobs" }), "recruiter_default");
    assert.equal(profileForPermissionScope({ kind: "all" }), "recruiter_default", "an all-jobs grant is still not a role");
  });

  it("still shows the staff email directory to that admin while job-scoped to {7,8}", async () => {
    const rawReader = narrowedAdminReader();
    const permissionProvider = createSiteAdminAwarePermissionProvider({
      base: createHarvestPermissionProvider({ rawReader }),
      rawReader,
    });
    const scopedReader = createScopedGreenhouseReader({
      actorResolver: { resolveActor: () => 42 },
      permissionProvider,
      rawReader,
    }) as unknown as ScopedReaderLike<AuthenticatedSession>;
    const { runtime } = testRuntime(scopedReader);

    const result = await runEvidenceTool(runtime, "search_my_user_emails", {});

    const row = ((result.ok ? result.data : []) as Array<Record<string, unknown>>)[0] ?? {};
    assert.equal(row.email, "colleague@example.com", "a /jobs outage must not demote a proven admin");
    assert.equal(result.ok ? result.permissionScope?.kind : "unread", "jobs");
  });
});

/** A real McpServer + in-memory client: the schema boundary is where this bug lives. */
async function withClient<T>(
  run: (client: Client, calls: Array<{ toolName: string; params?: Record<string, unknown> }>) => Promise<T>
): Promise<T> {
  const calls: Array<{ toolName: string; params?: Record<string, unknown> }> = [];
  const reader = fakeScopedReader((toolName, params) => {
    calls.push({ toolName, params });
    return scopedSuccess(toolName, []);
  });
  const { server } = createRecruiterMcpServer({
    session: { subject: "google-subject-sam", surface: "test", client: "claude_desktop_chat", tokenId: "recruiter-token-abc123" },
    env: { GREENHOUSE_RECRUITER_ALLOW_TEST_SURFACE: "true" },
    configureGreenhouse: false,
    scopedReader: reader,
  });
  const client = new Client({ name: "r2h-fold2", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await run(client, calls);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

/**
 * One malformed date window through the real boundary. Reports whether the read was reached at all
 * and what the caller was told — a helper that folded the two together would let the params echoed
 * back in an assertion message masquerade as the schema error naming the key.
 */
async function dateCall(created_at: unknown): Promise<{ reachedRead: boolean; message: string }> {
  return withClient(async (client, calls) => {
    let message: string;
    try {
      message = JSON.stringify(await client.callTool({ name: "search_my_applications", arguments: { created_at } }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    return { reachedRead: calls.length > 0, message };
  });
}

async function assertDateRejected(created_at: unknown, key: RegExp): Promise<void> {
  const { reachedRead, message } = await dateCall(created_at);
  assert.equal(reachedRead, false, `a malformed date window must not reach the read (${JSON.stringify(created_at)})`);
  assert.match(message, key, "the error has to name the key the model got wrong");
}

describe("fold 2 item 5: a half-valid date object is a schema error, not a silent window", () => {
  it("rejects a non-string bound and names the key", async () => {
    await assertDateRejected({ gte: 5, lte: "2026-06-30" }, /gte/);
  });

  it("rejects an empty-string bound and names the key", async () => {
    await assertDateRejected({ gte: "", lte: "2026-06-30" }, /gte/);
  });

  it("rejects an unknown key rather than dropping it", async () => {
    await assertDateRejected({ gte: "2026-04-01", foo: 1 }, /foo/);
  });

  it("rejects gte and gt together, and lte and lt together", async () => {
    await assertDateRejected({ gte: "2026-04-01", gt: "2026-04-02" }, /gt/);
    await assertDateRejected({ lte: "2026-06-30", lt: "2026-06-29" }, /lt/);
  });

  it("still accepts every form the tool advertises and accepts", async () => {
    await withClient(async (client, calls) => {
      const result = await client.callTool({
        name: "search_my_applications",
        arguments: { created_at: { gte: "2026-04-01", lte: "2026-06-30" } },
      });
      assert.equal(result.isError ?? false, false);
      const call = calls.find((entry) => entry.toolName === "list_applications");
      assert.equal(call?.params?.["created_at[gte]"], "2026-04-01T00:00:00Z");
      assert.equal(call?.params?.["created_at[lte]"], "2026-06-30T23:59:59Z");

      const listed = await client.listTools();
      const applications = listed.tools.find((tool) => tool.name === "search_my_applications");
      const createdAt = (applications?.inputSchema?.properties ?? {})["created_at"] as Record<string, unknown>;
      assert.equal(createdAt?.type, "string", "the advertised schema stays the cheap string");
      assert.equal(createdAt?.anyOf, undefined);
    });
  });
});
