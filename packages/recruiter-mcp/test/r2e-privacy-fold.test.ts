import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createHarvestPermissionProvider,
  createScopedGreenhouseReader,
  type ApiResponse,
  type RawReadClient,
  type ReadParams,
} from "../../scoped-core/src/index.js";
import { createSiteAdminAwarePermissionProvider } from "../src/site-admin-permission.js";
import { runEvidenceTool } from "../src/tools/evidence.js";
import {
  EVIDENCE_HYGIENE_EXEMPTIONS,
  profileForPermissionScope,
  projectEvidenceResult,
} from "../src/tools/evidence-projection.js";
import { getEvidenceEndpointAdapter } from "../src/tools/scoped-endpoint-adapters.js";
import { HARVEST_V3_ENDPOINT_REGISTRY } from "../src/harvest-v3-registry.js";
import { isForbiddenEvidencePayloadKey } from "../src/evidence-hygiene.js";
import { fakeScopedReader, scopedSuccess, testRuntime } from "./test-helpers.js";
import type { AuthenticatedSession, ScopedReaderLike } from "../src/types.js";

/**
 * The R2 fold: the privacy and authorization findings.
 *
 * Every case here fails on faa1ecf. The recurring shape of the bugs is the same one the reviewers
 * named: a ROLE decision keyed off something that is not a role, and a withholding announced by the
 * numbers around it.
 */

const STAFF_EMAIL_ROW = { id: 2, user_id: 77, email: "colleague@example.com", verified: true };
const FUTURE_PERMISSION_ROW = { id: 1, user_id: 77, role_id: 4, department_id: 3, office_id: 4 };
const USER_ROW = { id: 77, first_name: "Jordan", last_name: "Ellis", primary_email: "jordan@example.com", site_admin: false };
const TEMPLATE_ROW = {
  id: 3,
  name: "Rejection — after onsite",
  subject: "An update on your application",
  body: "Thank you for interviewing with us.",
  user_id: 77,
  recipients: "jordan@example.com, riley@example.com",
};

/** The rows Greenhouse answers with, keyed by the raw path the reader asks for. */
const TENANT_ROWS: Record<string, unknown[]> = {
  "/user_emails": [STAFF_EMAIL_ROW],
  "/future_job_permissions": [FUTURE_PERMISSION_ROW],
  "/users": [USER_ROW],
  "/email_templates": [TEMPLATE_ROW],
  "/custom_fields": [],
  "/jobs": [],
};

interface TenantReaderOptions {
  /** The /user_job_permissions rows the base provider sweeps for this actor. */
  permissionRows: unknown[];
  siteAdmin: boolean;
  rows?: Record<string, unknown[]>;
}

function tenantRuntime(options: TenantReaderOptions) {
  const reads: Array<{ path: string; params?: ReadParams }> = [];
  const rows = { ...TENANT_ROWS, ...(options.rows ?? {}) };
  const rawReader: RawReadClient = {
    async read<T>(path: string, params?: ReadParams): Promise<ApiResponse<T>> {
      reads.push({ path, params });
      if (path === "/user_job_permissions") return { data: options.permissionRows as T, nextCursor: null };
      return { data: (rows[path] ?? []) as T, nextCursor: null };
    },
  };
  const base = createHarvestPermissionProvider({ rawReader });
  const permissionProvider = createSiteAdminAwarePermissionProvider({
    base,
    rawReader,
    detectSiteAdmin: async () => options.siteAdmin,
  });
  const scopedReader = createScopedGreenhouseReader({
    actorResolver: { resolveActor: () => 7 },
    permissionProvider,
    rawReader,
  }) as unknown as ScopedReaderLike<AuthenticatedSession>;
  return { ...testRuntime(scopedReader), reads };
}

/**
 * The Greenhouse shape that makes `kind: "all"` ambiguous: an ordinary job admin holding an
 * all-jobs role marker, whom the BASE provider widens to org-wide job access
 * (`rowGrantsAllJobAccess`). They are not a site admin — nobody read `/v3/users.site_admin` for
 * them — and Greenhouse does not show them its permission settings or staff directory.
 */
const ALL_JOBS_NON_ADMIN_ROWS = [{ id: 1, user_id: 7, role: { name: "All Jobs" } }];

describe("R2 fold 1: the admin projection needs a proven role, not a scope kind", () => {
  it("withholds the staff email directory from a NON-site-admin who holds an all-jobs grant", async () => {
    const { runtime } = tenantRuntime({ permissionRows: ALL_JOBS_NON_ADMIN_ROWS, siteAdmin: false });
    const result = await runEvidenceTool(runtime, "search_my_user_emails", {});
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.data : null, [], "an all-jobs job admin is not a site admin");
    assert.equal(
      JSON.stringify(result.ok ? result.data : []).includes("colleague@example.com"),
      false
    );
  });

  it("withholds standing permission grants and template recipients from the same actor", async () => {
    const { runtime } = tenantRuntime({ permissionRows: ALL_JOBS_NON_ADMIN_ROWS, siteAdmin: false });

    const permissions = await runEvidenceTool(runtime, "search_my_future_job_permissions", {});
    assert.deepEqual(permissions.ok ? permissions.data : null, []);

    const templates = await runEvidenceTool(runtime, "search_my_email_templates", {});
    const templateRow = ((templates.ok ? templates.data : []) as Array<Record<string, unknown>>)[0] ?? {};
    assert.equal(templateRow.subject, "An update on your application", "the copy is still the point of the read");
    assert.equal(templateRow.recipients, undefined, "colleague addresses need the site-admin role");
  });

  it("closes the same hole on the WEEK-ONE restore: users.primary_email is not theirs either", async () => {
    const { runtime } = tenantRuntime({ permissionRows: ALL_JOBS_NON_ADMIN_ROWS, siteAdmin: false });
    const result = await runEvidenceTool(runtime, "search_my_users", {});
    const row = ((result.ok ? result.data : []) as Array<Record<string, unknown>>)[0] ?? {};
    assert.equal(row.first_name, "Jordan", "a teammate's NAME is operational and stays");
    assert.equal(row.primary_email, undefined, "the work email is the site admin's to see");
  });

  it("returns every one of those rows to a PROVEN site admin", async () => {
    const { runtime } = tenantRuntime({ permissionRows: [], siteAdmin: true });

    const emails = await runEvidenceTool(runtime, "search_my_user_emails", {});
    const emailRow = ((emails.ok ? emails.data : []) as Array<Record<string, unknown>>)[0] ?? {};
    assert.equal(emailRow.email, "colleague@example.com", "the address IS the directory read (fold item 4/19)");
    assert.equal(emailRow.user_id, 77);

    const users = await runEvidenceTool(runtime, "search_my_users", {});
    const userRow = ((users.ok ? users.data : []) as Array<Record<string, unknown>>)[0] ?? {};
    assert.equal(userRow.primary_email, "jordan@example.com");

    const templates = await runEvidenceTool(runtime, "search_my_email_templates", {});
    const templateRow = ((templates.ok ? templates.data : []) as Array<Record<string, unknown>>)[0] ?? {};
    assert.equal(templateRow.recipients, "jordan@example.com, riley@example.com");
  });

  it("keys the profile off the proven signal, never off the kind", () => {
    assert.equal(profileForPermissionScope({ kind: "all", siteAdmin: true }), "operator_site_admin");
    assert.equal(profileForPermissionScope({ kind: "operator" }), "operator_site_admin");
    assert.equal(profileForPermissionScope({ kind: "all" }), "recruiter_default");
    assert.equal(profileForPermissionScope({ kind: "jobs" }), "recruiter_default");
    assert.equal(profileForPermissionScope(undefined), "recruiter_default");
  });
});

describe("R2 fold 2/20: the counts around a withheld row are the disclosure", () => {
  async function gatedEnvelope(userIds: string) {
    const reader = fakeScopedReader((toolName, params) =>
      scopedSuccess(
        toolName,
        params?.user_ids === "77" ? [STAFF_EMAIL_ROW] : [],
        null,
        { permissionScope: { kind: "jobs", permittedJobCount: 3 } }
      )
    );
    const { runtime } = testRuntime(reader);
    const result = await runEvidenceTool(runtime, "search_my_user_emails", { user_ids: userIds });
    assert.equal(result.ok, true);
    return result.ok ? result : assert.fail("read failed");
  }

  it("reports a colleague who HAS a staff-email row exactly as it reports an id nobody holds", async () => {
    const existing = await gatedEnvelope("77");
    const missing = await gatedEnvelope("999999");

    assert.deepEqual(existing.data, []);
    assert.deepEqual(existing.rowCounts, missing.rowCounts, "row counts must not answer the question the gate refuses");
    assert.deepEqual(existing.read, missing.read, "nor may the read envelope");
    assert.equal(existing.rowCounts?.raw, 0);
    assert.equal(existing.read?.raw_rows_read, 0);
    assert.equal(existing.read?.rows_returned, 0);
  });

  it("says WHY the rows are absent, with a privacy reason rather than not_projected", async () => {
    const existing = await gatedEnvelope("77");
    assert.equal(existing.projection?.roleGatedRowsWithheld?.reason, "privacy");
    assert.match(existing.projection?.roleGatedRowsWithheld?.note ?? "", /site admin/i);
    // Fold 2: the omission LIST itself is now empty rather than privacy-reasoned. Naming the fields
    // a withheld row carried — `email`, `id`, `user_id`, `verified` for a row that exists, nothing
    // for an id nobody holds — was the same disclosure the counts were, in a different column. The
    // single roleGatedRowsWithheld note carries the whole explanation.
    assert.deepEqual(existing.projection?.omittedFields, []);
  });

  it("states the withholding on every call, including one that matched nothing", async () => {
    // A disclosure that appeared only when rows existed would restore the oracle it exists to close.
    const missing = await gatedEnvelope("999999");
    assert.equal(missing.projection?.roleGatedRowsWithheld?.reason, "privacy");
  });

  it("says nothing of the kind to a site admin, who gets the rows", async () => {
    const reader = fakeScopedReader((toolName) =>
      scopedSuccess(toolName, [STAFF_EMAIL_ROW], null, { permissionScope: { kind: "all", permittedJobCount: null, siteAdmin: true } })
    );
    const { runtime } = testRuntime(reader);
    const result = await runEvidenceTool(runtime, "search_my_user_emails", {});
    assert.equal(result.ok && (result.data as unknown[]).length, 1);
    assert.equal(result.ok ? result.projection?.roleGatedRowsWithheld : "unread", undefined);
    assert.equal(result.ok ? result.rowCounts?.raw : 0, 1);
  });
});

describe("R2 fold 3: an endpoint filter that shares a name with an identity param", () => {
  it("passes user_emails.email through to the reader instead of silently returning the directory", async () => {
    const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime } = testRuntime(reader);
    await runEvidenceTool(runtime, "search_my_user_emails", { email: "colleague@example.com" });
    const call = reader.calls.find((entry) => entry.toolName === "list_user_emails");
    assert.equal(call?.params?.email, "colleague@example.com", "an admin asking for one colleague must not get all of them");
  });

  it("passes candidates.email through, which is what search_my_candidates tells the model to do", async () => {
    const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime } = testRuntime(reader);
    await runEvidenceTool(runtime, "search_my_candidates", { email: "jane@example.com" });
    const call = reader.calls.find((entry) => entry.toolName === "list_candidates");
    assert.equal(call?.params?.email, "jane@example.com");
  });

  it("still drops an actor-identity param on an endpoint that has no such filter", async () => {
    const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime } = testRuntime(reader);
    await runEvidenceTool(runtime, "search_my_jobs", { email: "someone.else@example.com", user_id: 9 });
    const call = reader.calls.find((entry) => entry.toolName === "list_jobs");
    assert.equal(call?.params?.email, undefined);
    assert.equal(call?.params?.user_id, undefined);
  });
});

describe("R2 fold 7/8: bulk-request integration fields and signed result files", () => {
  it("drops the callback address and its echoed payload, and keeps every outcome count", () => {
    const projected = projectEvidenceResult(
      {
        ok: true,
        toolName: "search_my_bulk_requests",
        scoped: true,
        nextCursor: null,
        data: [{
          id: 5,
          bulk_action_uuid: "abc-123",
          api_endpoint: "/v3/applications",
          status: "completed",
          record_count: 40,
          success_count: 38,
          failure_count: 2,
          callback_url: "https://hooks.example.com/greenhouse?key=s3cret",
          callback_response: { body: "ok" },
        }],
      } as never,
      getEvidenceEndpointAdapter("search_my_bulk_requests")
    );
    const row = ((projected.ok ? projected.data : []) as Array<Record<string, unknown>>)[0] ?? {};
    assert.equal(row.callback_url, undefined);
    assert.equal(row.callback_response, undefined);
    assert.equal(row.failure_count, 2, "how much of it failed is the question the tool answers");
    assert.equal(row.bulk_action_uuid, "abc-123");
  });

  it("keeps a blocked spam source's value: the address IS the blocklist entry", () => {
    const projected = projectEvidenceResult(
      {
        ok: true,
        toolName: "search_my_blocked_spam_sources",
        scoped: true,
        nextCursor: null,
        data: [{ id: 1, source_type: "email_address", value: "spammer@spam.example", note: "bulk applier" }],
      } as never,
      getEvidenceEndpointAdapter("search_my_blocked_spam_sources")
    );
    const row = ((projected.ok ? projected.data : []) as Array<Record<string, unknown>>)[0] ?? {};
    assert.equal(row.value, "spammer@spam.example");
  });

  it("binds get_my_bulk_request and withholds only the expiring signed result files", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      assert.equal(toolName, "get_bulk_request");
      assert.equal(params?.bulk_action_uuid, "abc-123");
      return scopedSuccess(toolName, {
        id: 5,
        bulk_action_uuid: "abc-123",
        status: "completed",
        record_count: 40,
        success_count: 38,
        failure_count: 2,
        success_results_url: "https://files.example.com/success.csv?sig=abc",
        failure_results_url: "https://files.example.com/failure.csv?sig=abc",
        results_urls_expire_at: "2026-09-10T00:00:00.000Z",
        callback_url: "https://hooks.example.com/greenhouse?key=s3cret",
      });
    });
    const { runtime } = testRuntime(reader);
    const result = await runEvidenceTool(runtime, "get_my_bulk_request", { bulk_action_uuid: "abc-123" });
    assert.equal(result.ok, true);
    const row = (result.ok ? result.data : {}) as Record<string, unknown>;
    assert.equal(row.failure_count, 2);
    assert.equal(row.results_urls_expire_at, "2026-09-10T00:00:00.000Z", "when the files stop being fetchable is honest metadata");
    assert.equal(row.success_results_url, undefined, "an expiring signed capability is not data");
    assert.equal(row.failure_results_url, undefined);
    assert.equal(row.callback_url, undefined);
  });
});

describe("R2 fold 18: a reference catalogue's admin note is not withheld by policy", () => {
  /**
   * The reviewer's finding was that `private_note` was dropped for a reason that cited no
   * permission. It was — and the drop was also INERT, because the v3 contract documents no such
   * field on this endpoint (`created_at, id, name, type, updated_at`) and the contract is the outer
   * allowlist. So what the fold can change, and does, is the reason the model is handed: a field v3
   * never returns is `not_projected`, not `privacy`. Labelling it "privacy" told the model a
   * permission was withholding org instructions that a job admin can read in the Greenhouse UI.
   */
  it("no longer claims a privacy gate over a field the contract does not return", () => {
    const projected = projectEvidenceResult(
      {
        ok: true,
        toolName: "search_my_rejection_reasons",
        scoped: true,
        nextCursor: null,
        permissionScope: { kind: "jobs", permittedJobCount: 2 },
        data: [{ id: 4, name: "Lacking skill(s)/qualification(s)", private_note: "Use for technical screen failures only." }],
      } as never,
      getEvidenceEndpointAdapter("search_my_rejection_reasons")
    );
    const omitted = new Map(
      (projected.ok ? projected.projection?.omittedFields ?? [] : []).map((field) => [field.field, field.reason])
    );
    assert.equal(omitted.get("private_note"), "not_projected");
    assert.notEqual(omitted.get("private_note"), "privacy");
    const row = ((projected.ok ? projected.data : []) as Array<Record<string, unknown>>)[0] ?? {};
    assert.equal(row.name, "Lacking skill(s)/qualification(s)");
  });

  it("keeps no omission POLICY over the rejection-reason catalogue at all", () => {
    // The contract's own field list is the only thing withholding anything here. Locked by asking
    // for a documented field back and by the reason above; a re-added policy would flip it.
    const entry = HARVEST_V3_ENDPOINT_REGISTRY.find((endpoint) => endpoint.path === "/v3/rejection_reasons");
    assert.deepEqual(
      entry?.responseFields.map((field) => field.name).sort(),
      ["created_at", "id", "name", "type", "updated_at"]
    );
  });
});

describe("R2 fold 22/24: the credential-hygiene exemption set is exactly the public slugs", () => {
  it("is exactly tracking_links.token and job_boards.url_token", () => {
    assert.deepEqual(
      [...EVIDENCE_HYGIENE_EXEMPTIONS].map(([endpoint, fields]) => [endpoint, [...fields].sort()]).sort(),
      [
        ["/v3/job_boards", ["url_token"]],
        ["/v3/tracking_links", ["token"]],
      ]
    );
  });

  it("returns the job board's public url_token, which post attribution joins on", () => {
    const projected = projectEvidenceResult(
      {
        ok: true,
        toolName: "search_my_job_boards",
        scoped: true,
        nextCursor: null,
        data: [{ id: 1, company_name: "Example Systems", url_token: "example-careers", status: "active" }],
      } as never,
      getEvidenceEndpointAdapter("search_my_job_boards")
    );
    const row = ((projected.ok ? projected.data : []) as Array<Record<string, unknown>>)[0] ?? {};
    assert.equal(row.url_token, "example-careers");
  });

  it("still drops a token-shaped key on an endpoint that has no exemption", () => {
    for (const [toolName, row] of [
      ["search_my_users", { id: 77, first_name: "Jordan", token: "definitely-a-credential", api_key: "sk-live-123" }],
      ["search_my_candidates", { id: 5, first_name: "Jane", url_token: "not-yours", api_key: "sk-live-123" }],
    ] as const) {
      const projected = projectEvidenceResult(
        { ok: true, toolName, scoped: true, nextCursor: null, data: [row] } as never,
        getEvidenceEndpointAdapter(toolName)
      );
      const projectedRow = ((projected.ok ? projected.data : []) as Array<Record<string, unknown>>)[0] ?? {};
      assert.equal(projectedRow.token, undefined, `${toolName} must not inherit the exemption`);
      assert.equal(projectedRow.url_token, undefined, `${toolName} must not inherit the exemption`);
      assert.equal(projectedRow.api_key, undefined);
    }
  });

  it("sweeps the whole contract: no OTHER documented field is being swallowed unnoticed", () => {
    // The guard matches on key SHAPE, so any documented field whose name ends in "token" is dropped
    // whether or not it is a credential. Exactly two are, both public slugs, both exempt above. A
    // third appearing is a decision — exempt it if it is a slug, leave it dropped if it is a secret —
    // and this fails until someone makes it.
    const swallowed = HARVEST_V3_ENDPOINT_REGISTRY.flatMap((endpoint) =>
      endpoint.responseFields
        .filter((field) => isForbiddenEvidencePayloadKey(field.name))
        .map((field) => `${endpoint.path}.${field.name}`)
    ).sort();
    assert.deepEqual(swallowed, ["/v3/job_boards.url_token", "/v3/tracking_links.token"]);
    for (const pair of swallowed) {
      const [endpointPath, field] = [pair.slice(0, pair.lastIndexOf(".")), pair.slice(pair.lastIndexOf(".") + 1)];
      assert.equal(
        EVIDENCE_HYGIENE_EXEMPTIONS.get(endpointPath)?.has(field),
        true,
        `${pair} is dropped by the credential guard with no decision recorded`
      );
    }
  });
});
