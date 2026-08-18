import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  ApiResponse,
  PermissionLookupResult,
  PermissionProvider,
  RawReadClient,
} from "../../scoped-core/src/index.js";
import {
  createSiteAdminAwarePermissionProvider,
  fetchIsSiteAdmin,
} from "../src/site-admin-permission.js";

interface RawCall {
  path: string;
  params?: Record<string, unknown>;
  cursor?: string;
}

function rawReader(
  handler: (path: string, params?: Record<string, unknown>) => unknown
): RawReadClient & { calls: RawCall[] } {
  const calls: RawCall[] = [];
  return {
    calls,
    async read<T = unknown>(path: string, params?: Record<string, unknown>, cursor?: string): Promise<ApiResponse<T>> {
      calls.push({ path, params, cursor });
      const value = handler(path, params);
      if (value && typeof value === "object" && "data" in value && "nextCursor" in value) {
        return value as ApiResponse<T>;
      }
      return { data: value as T, nextCursor: null };
    },
  };
}

function baseProvider(result: PermissionLookupResult, calls: number[] = []): PermissionProvider {
  return {
    async getPermittedJobIds(id: number) {
      calls.push(id);
      return result;
    },
  };
}

const usersData = (rows: unknown[]) => ({ data: rows, nextCursor: null });

describe("site-admin-aware permission provider", () => {
  it("grants all-access when the user's site_admin flag is true, and does not consult the base provider", async () => {
    const baseCalls: number[] = [];
    const provider = createSiteAdminAwarePermissionProvider({
      base: baseProvider(new Set([1, 2, 3]), baseCalls),
      rawReader: rawReader(() => usersData([{ id: 5999999004, site_admin: true }])),
    });

    const scope = await provider.getPermittedJobIds(5999999004);

    assert.deepEqual(scope, { kind: "all" });
    assert.equal(baseCalls.length, 0, "base provider must not be consulted for a site admin");
  });

  it("queries /v3/users with an ids filter for the resolved actor", async () => {
    const reader = rawReader(() => usersData([{ id: 42, site_admin: true }]));
    const provider = createSiteAdminAwarePermissionProvider({ base: baseProvider(new Set()), rawReader: reader });

    await provider.getPermittedJobIds(42);

    assert.equal(reader.calls[0]?.path, "/users");
    assert.deepEqual(reader.calls[0]?.params, { ids: "42" });
    // A confirmed site admin then asks which jobs Greenhouse withholds from them.
    assert.equal(reader.calls[1]?.path, "/jobs");
    assert.deepEqual(reader.calls[1]?.params, { confidential: true, per_page: 500, fields: "id,confidential" });
    assert.equal(reader.calls.length, 2);
  });

  it("withholds legacy confidential jobs from a site admin who is not on their hiring team", async () => {
    // Greenhouse gives a site admin implicit access to every NON-confidential job, and restricts a
    // confidential one to users explicitly on its Hiring Team. Handing out an unfiltered org-wide
    // read granted access the organization's own model withholds. Job 900 is confidential and the
    // admin is on it (so it stays); 901 is confidential and they are not (so it goes).
    const baseCalls: number[] = [];
    const provider = createSiteAdminAwarePermissionProvider({
      base: baseProvider(new Set([900]), baseCalls),
      rawReader: rawReader((path) => {
        if (path === "/users") return [{ id: 42, site_admin: true }];
        if (path === "/jobs") {
          return [
            { id: 900, confidential: true },
            { id: 901, confidential: true },
          ];
        }
        return [];
      }),
    });

    const scope = await provider.getPermittedJobIds(42);

    assert.equal("kind" in scope && scope.kind, "all", "still org-wide — this narrows nothing else");
    const excluded = "kind" in scope && scope.kind === "all" ? scope.excludedJobIds : undefined;
    assert.deepEqual([...(excluded ?? [])], [901]);
    assert.deepEqual(baseCalls, [42], "the admin's explicit hiring-team grants decide what survives");
  });

  it("leaves a tenant with no confidential jobs on the untouched raw org-wide path", async () => {
    const baseCalls: number[] = [];
    const provider = createSiteAdminAwarePermissionProvider({
      base: baseProvider(new Set([1]), baseCalls),
      rawReader: rawReader((path) => (path === "/users" ? [{ id: 42, site_admin: true }] : [])),
    });

    const scope = await provider.getPermittedJobIds(42);

    assert.deepEqual(scope, { kind: "all" }, "no exclusions means the fast, unfiltered read path");
    assert.deepEqual(baseCalls, [], "and no reason to consult the base provider at all");
  });

  it("falls back to explicit grants when the confidential list cannot be read", async () => {
    // Same direction as the site-admin probe's own failure handling: if we cannot establish what
    // Greenhouse restricts, we must not hand out an unrestricted org-wide read. Falling back to the
    // admin's real per-job grants withholds rather than widens, and is not an outage.
    const provider = createSiteAdminAwarePermissionProvider({
      base: baseProvider(new Set([7, 8])),
      rawReader: rawReader((path) => {
        if (path === "/users") return [{ id: 42, site_admin: true }];
        throw new Error("jobs read failed");
      }),
    });

    const scope = await provider.getPermittedJobIds(42);

    assert.deepEqual(scope, new Set([7, 8]));
  });

  it("ignores a confidential filter the server did not honour", async () => {
    // If /jobs returned every job regardless of the filter, trusting the response shape would turn
    // the whole tenant into an exclusion set and black the admin out entirely.
    const provider = createSiteAdminAwarePermissionProvider({
      base: baseProvider(new Set()),
      rawReader: rawReader((path) => {
        if (path === "/users") return [{ id: 42, site_admin: true }];
        if (path === "/jobs") {
          return [
            { id: 900, confidential: false },
            { id: 901 },
            { id: 902, confidential: true },
          ];
        }
        return [];
      }),
    });

    const scope = await provider.getPermittedJobIds(42);

    const excluded = "kind" in scope && scope.kind === "all" ? scope.excludedJobIds : undefined;
    assert.deepEqual([...(excluded ?? [])], [902], "only rows that say they are confidential count");
  });

  it("delegates to the base provider when the user is not a site admin", async () => {
    const baseCalls: number[] = [];
    const provider = createSiteAdminAwarePermissionProvider({
      base: baseProvider(new Set([7, 8]), baseCalls),
      rawReader: rawReader(() => usersData([{ id: 99, site_admin: false }])),
    });

    const scope = await provider.getPermittedJobIds(99);

    assert.deepEqual(scope, new Set([7, 8]));
    assert.deepEqual(baseCalls, [99]);
  });

  it("fails closed: a probe error delegates to the base provider and never grants all-access", async () => {
    const baseCalls: number[] = [];
    const provider = createSiteAdminAwarePermissionProvider({
      base: baseProvider(new Set([5]), baseCalls),
      rawReader: rawReader(() => {
        throw new Error("Greenhouse API error: 422");
      }),
    });

    const scope = await provider.getPermittedJobIds(123);

    assert.deepEqual(scope, new Set([5]), "lookup failure must fall through to per-job scoping");
    assert.deepEqual(baseCalls, [123]);
  });

  it("fails closed via injected detector throwing", async () => {
    const baseCalls: number[] = [];
    const provider = createSiteAdminAwarePermissionProvider({
      base: baseProvider(new Set([9]), baseCalls),
      rawReader: rawReader(() => usersData([])),
      detectSiteAdmin: async () => {
        throw new Error("boom");
      },
    });

    const scope = await provider.getPermittedJobIds(1);
    assert.deepEqual(scope, new Set([9]));
    assert.deepEqual(baseCalls, [1]);
  });
});

describe("fetchIsSiteAdmin", () => {
  it("returns true only for a literal boolean true", async () => {
    assert.equal(await fetchIsSiteAdmin(rawReader(() => usersData([{ id: 5, site_admin: true }])), 5), true);
  });

  it("treats a stringy 'true' as NOT site admin (strict boolean)", async () => {
    assert.equal(await fetchIsSiteAdmin(rawReader(() => usersData([{ id: 5, site_admin: "true" }])), 5), false);
  });

  it("returns false when site_admin is false, missing, or null", async () => {
    assert.equal(await fetchIsSiteAdmin(rawReader(() => usersData([{ id: 5, site_admin: false }])), 5), false);
    assert.equal(await fetchIsSiteAdmin(rawReader(() => usersData([{ id: 5 }])), 5), false);
    assert.equal(await fetchIsSiteAdmin(rawReader(() => usersData([{ id: 5, site_admin: null }])), 5), false);
  });

  it("returns false on an empty result", async () => {
    assert.equal(await fetchIsSiteAdmin(rawReader(() => usersData([])), 5), false);
  });

  it("ignores rows whose id does not match the requested user (id-match guard)", async () => {
    // Even if the filter were ignored and other users were returned, a non-matching
    // site_admin row must never grant access to the requested user.
    assert.equal(
      await fetchIsSiteAdmin(rawReader(() => usersData([{ id: 999, site_admin: true }, { id: 5, site_admin: false }])), 5),
      false
    );
    assert.equal(
      await fetchIsSiteAdmin(rawReader(() => usersData([{ id: 999, site_admin: true }, { id: 5, site_admin: true }])), 5),
      true
    );
  });

  it("matches a string id from the API against the numeric user id", async () => {
    assert.equal(await fetchIsSiteAdmin(rawReader(() => usersData([{ id: "5", site_admin: true }])), 5), true);
  });

  it("denies a DEACTIVATED site admin (a departed admin must not keep all-jobs access)", async () => {
    // Greenhouse deactivation never strips site_admin from the row, so gating on the boolean
    // alone leaves a departed admin with org-wide access until a manual lever runs. Require active.
    assert.equal(
      await fetchIsSiteAdmin(rawReader(() => usersData([{ id: 5, site_admin: true, deactivated: true }])), 5),
      false
    );
    // An active admin (deactivated false or absent) is still granted — no live-pilot regression.
    assert.equal(
      await fetchIsSiteAdmin(rawReader(() => usersData([{ id: 5, site_admin: true, deactivated: false }])), 5),
      true
    );
    assert.equal(await fetchIsSiteAdmin(rawReader(() => usersData([{ id: 5, site_admin: true }])), 5), true);
  });
});
