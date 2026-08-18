import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  _resetActionEntitlementResolvers,
  createActionEntitlementResolver,
  createActionEntitlementResolverFromEnv,
  resolveActionCatalogVisibility,
  type ActionEntitlementResolver,
} from "../src/action-entitlement.js";
import {
  _resetIdentityRowIdColumnLearning,
  createStaticIdentityDirectory,
  createSupabaseIdentityDirectory,
  resolveActionIdentity,
  type IdentityDirectory,
} from "../src/identity.js";
import { testSession } from "./test-helpers.js";
import type { AuthenticatedSession } from "../src/types.js";

const IDENTITY_ID = "3f7c1a92-5b64-4c0e-9d21-8a6b4e2f10cd";
const OTHER_IDENTITY_ID = "9c2e5d10-7a38-4f6b-b1c4-0e5d3a8f2b71";
const GREENHOUSE_USER_ID = 4242;
const CANONICAL_SUPABASE_URL = "https://exampleprojectref000.supabase.co";

function entitlementRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    identity_id: IDENTITY_ID,
    greenhouse_user_id: GREENHOUSE_USER_ID,
    client: "claude_code",
    can_preview: true,
    status: "active",
    expires_at: null,
    ...overrides,
  };
}

interface StubFetch {
  fetchImpl: typeof fetch;
  urls: URL[];
  headers: Headers[];
}

function stubEntitlementFetch(
  respond: (call: number, url: URL) => unknown[] | { status: number }
): StubFetch {
  const urls: URL[] = [];
  const headers: Headers[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    urls.push(url);
    headers.push(new Headers(init?.headers));
    const result = respond(urls.length, url);
    if (Array.isArray(result)) {
      return { ok: true, status: 200, json: async () => result } as Response;
    }
    return { ok: false, status: result.status, json: async () => [] } as Response;
  }) as typeof fetch;
  return { fetchImpl, urls, headers };
}

function writeCapableSession(overrides: Partial<AuthenticatedSession> = {}): AuthenticatedSession {
  return testSession({ surface: "claude_desktop", client: "claude_code", ...overrides });
}

function directoryFor(identityId: string | undefined, greenhouseUserId = GREENHOUSE_USER_ID): IdentityDirectory {
  return createStaticIdentityDirectory([
    {
      email: "recruiter@example.com",
      status: "resolved",
      greenhouseUserId,
      ...(identityId === undefined ? {} : { identityId }),
    },
  ]);
}

describe("action entitlement lookup", () => {
  it("filters on BOTH ids, the client, and active status", async () => {
    const stub = stubEntitlementFetch(() => [entitlementRow()]);
    const resolver = createActionEntitlementResolver({
      supabaseUrl: CANONICAL_SUPABASE_URL,
      apiKey: "entitlement-key",
      fetchImpl: stub.fetchImpl,
    });

    const visibility = await resolver.resolveCatalogVisibility({
      identity: { identityId: IDENTITY_ID, greenhouseUserId: GREENHOUSE_USER_ID },
      client: "claude_code",
    });

    assert.deepEqual(visibility, { writeToolsVisible: true, reason: "entitled" });
    const url = stub.urls[0]!;
    assert.equal(url.pathname, "/rest/v1/greenhouse_action_entitlement");
    assert.equal(url.searchParams.get("identity_id"), `eq.${IDENTITY_ID}`);
    assert.equal(url.searchParams.get("greenhouse_user_id"), `eq.${GREENHOUSE_USER_ID}`);
    assert.equal(url.searchParams.get("client"), "eq.claude_code");
    assert.equal(url.searchParams.get("status"), "eq.active");
    assert.equal(stub.headers[0]?.get("apikey"), "entitlement-key");
    assert.equal(stub.headers[0]?.get("authorization"), "Bearer entitlement-key");
  });

  it("never reads the apply flags the mutation path owns", async () => {
    // The catalog answer must not be able to become an apply authorization by someone later
    // "just returning what we already fetched" — the flags are not in the projection at all.
    const stub = stubEntitlementFetch(() => [entitlementRow()]);
    const resolver = createActionEntitlementResolver({
      supabaseUrl: CANONICAL_SUPABASE_URL,
      apiKey: "entitlement-key",
      fetchImpl: stub.fetchImpl,
    });

    await resolver.resolveCatalogVisibility({
      identity: { identityId: IDENTITY_ID, greenhouseUserId: GREENHOUSE_USER_ID },
      client: "claude_code",
    });

    const select = stub.urls[0]!.searchParams.get("select") ?? "";
    assert.equal(select.includes("can_apply"), false, `apply flags must not be selected: ${select}`);
    assert.equal(select.includes("can_preview"), true);
  });

  it("hides the write plane when no active row exists", async () => {
    const resolver = createActionEntitlementResolver({
      supabaseUrl: CANONICAL_SUPABASE_URL,
      apiKey: "entitlement-key",
      fetchImpl: stubEntitlementFetch(() => []).fetchImpl,
    });

    assert.deepEqual(
      await resolver.resolveCatalogVisibility({
        identity: { identityId: IDENTITY_ID, greenhouseUserId: GREENHOUSE_USER_ID },
        client: "claude_code",
      }),
      { writeToolsVisible: false, reason: "no_active_entitlement" }
    );
  });

  it("hides the write plane for an expired grant", async () => {
    let clock = Date.parse("2026-07-26T12:00:00.000Z");
    const resolver = createActionEntitlementResolver({
      supabaseUrl: CANONICAL_SUPABASE_URL,
      apiKey: "entitlement-key",
      now: () => clock,
      fetchImpl: stubEntitlementFetch(() => [entitlementRow({ expires_at: "2026-07-26T11:59:59.000Z" })]).fetchImpl,
    });

    assert.deepEqual(
      await resolver.resolveCatalogVisibility({
        identity: { identityId: IDENTITY_ID, greenhouseUserId: GREENHOUSE_USER_ID },
        client: "claude_code",
      }),
      { writeToolsVisible: false, reason: "entitlement_expired" }
    );
  });

  it("hides the write plane for an active row that grants no preview", async () => {
    const resolver = createActionEntitlementResolver({
      supabaseUrl: CANONICAL_SUPABASE_URL,
      apiKey: "entitlement-key",
      fetchImpl: stubEntitlementFetch(() => [entitlementRow({ can_preview: false })]).fetchImpl,
    });

    assert.deepEqual(
      await resolver.resolveCatalogVisibility({
        identity: { identityId: IDENTITY_ID, greenhouseUserId: GREENHOUSE_USER_ID },
        client: "claude_code",
      }),
      { writeToolsVisible: false, reason: "preview_not_granted" }
    );
  });

  it("refuses a row that does not echo back the identity, user, client, and status it was asked for", async () => {
    // The failure this guards is a dropped filter: PostgREST answers an unfiltered query with the
    // first row of the table and HTTP 200, which would hand one recruiter another's grant.
    for (const wrongRow of [
      entitlementRow({ identity_id: OTHER_IDENTITY_ID }),
      entitlementRow({ greenhouse_user_id: GREENHOUSE_USER_ID + 1 }),
      entitlementRow({ client: "codex" }),
      // status was the filter whose echo went unchecked. Disabling a grant sets the status; it does
      // not clear can_preview, so a suspended row still says `can_preview: true` and every gate
      // after this one would have read it as an entitlement and restored the write plane's tools.
      entitlementRow({ status: "disabled" }),
      entitlementRow({ status: "revoked" }),
    ]) {
      const resolver = createActionEntitlementResolver({
        supabaseUrl: CANONICAL_SUPABASE_URL,
        apiKey: "entitlement-key",
        fetchImpl: stubEntitlementFetch(() => [wrongRow]).fetchImpl,
      });

      await assert.rejects(
        async () => {
          await resolver.resolveCatalogVisibility({
            identity: { identityId: IDENTITY_ID, greenhouseUserId: GREENHOUSE_USER_ID },
            client: "claude_code",
          });
        },
        /different identity, user, or client/
      );
    }
  });

  it("accepts a bigint user id rendered as a string", async () => {
    const resolver = createActionEntitlementResolver({
      supabaseUrl: CANONICAL_SUPABASE_URL,
      apiKey: "entitlement-key",
      fetchImpl: stubEntitlementFetch(() => [entitlementRow({ greenhouse_user_id: String(GREENHOUSE_USER_ID) })]).fetchImpl,
    });

    assert.deepEqual(
      await resolver.resolveCatalogVisibility({
        identity: { identityId: IDENTITY_ID, greenhouseUserId: GREENHOUSE_USER_ID },
        client: "claude_code",
      }),
      { writeToolsVisible: true, reason: "entitled" }
    );
  });
});

describe("action entitlement caching", () => {
  it("serves one lookup for the TTL, then re-reads", async () => {
    let clock = 1_000;
    const stub = stubEntitlementFetch(() => [entitlementRow()]);
    const resolver = createActionEntitlementResolver({
      supabaseUrl: CANONICAL_SUPABASE_URL,
      apiKey: "entitlement-key",
      fetchImpl: stub.fetchImpl,
      cacheTtlMs: 60_000,
      now: () => clock,
    });
    const key = { identity: { identityId: IDENTITY_ID, greenhouseUserId: GREENHOUSE_USER_ID }, client: "claude_code" as const };

    await resolver.resolveCatalogVisibility(key);
    clock += 59_999;
    await resolver.resolveCatalogVisibility(key);
    assert.equal(stub.urls.length, 1);
    clock += 1;
    await resolver.resolveCatalogVisibility(key);
    assert.equal(stub.urls.length, 2);
  });

  it("keys the cache on both ids AND the client", async () => {
    const stub = stubEntitlementFetch((_call, url) => {
      const identityId = (url.searchParams.get("identity_id") ?? "").slice("eq.".length);
      const client = (url.searchParams.get("client") ?? "").slice("eq.".length);
      const userId = Number((url.searchParams.get("greenhouse_user_id") ?? "").slice("eq.".length));
      return [entitlementRow({ identity_id: identityId, client, greenhouse_user_id: userId })];
    });
    const resolver = createActionEntitlementResolver({
      supabaseUrl: CANONICAL_SUPABASE_URL,
      apiKey: "entitlement-key",
      fetchImpl: stub.fetchImpl,
      cacheTtlMs: 60_000,
    });

    await resolver.resolveCatalogVisibility({ identity: { identityId: IDENTITY_ID, greenhouseUserId: GREENHOUSE_USER_ID }, client: "claude_code" });
    await resolver.resolveCatalogVisibility({ identity: { identityId: IDENTITY_ID, greenhouseUserId: GREENHOUSE_USER_ID }, client: "codex" });
    await resolver.resolveCatalogVisibility({ identity: { identityId: OTHER_IDENTITY_ID, greenhouseUserId: GREENHOUSE_USER_ID }, client: "claude_code" });
    await resolver.resolveCatalogVisibility({ identity: { identityId: IDENTITY_ID, greenhouseUserId: GREENHOUSE_USER_ID + 1 }, client: "claude_code" });
    // ...and the first key again, which must still be the cached one.
    await resolver.resolveCatalogVisibility({ identity: { identityId: IDENTITY_ID, greenhouseUserId: GREENHOUSE_USER_ID }, client: "claude_code" });

    assert.equal(stub.urls.length, 4);
  });

  it("collapses concurrent lookups for one session onto a single read", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const urls: URL[] = [];
    const resolver = createActionEntitlementResolver({
      supabaseUrl: CANONICAL_SUPABASE_URL,
      apiKey: "entitlement-key",
      cacheTtlMs: 60_000,
      fetchImpl: (async (input: URL | RequestInfo) => {
        urls.push(new URL(String(input)));
        await gate;
        return { ok: true, status: 200, json: async () => [entitlementRow()] } as Response;
      }) as typeof fetch,
    });
    const key = { identity: { identityId: IDENTITY_ID, greenhouseUserId: GREENHOUSE_USER_ID }, client: "claude_code" as const };

    const first = resolver.resolveCatalogVisibility(key);
    const second = resolver.resolveCatalogVisibility(key);
    release();

    const [firstVisibility, secondVisibility] = await Promise.all([first, second]);
    assert.deepEqual(firstVisibility, { writeToolsVisible: true, reason: "entitled" });
    assert.deepEqual(secondVisibility, firstVisibility);
    assert.equal(urls.length, 1, "two concurrent catalog builds must not double-read the entitlement");
  });

  it("evicts a failed lookup rather than memoizing it", async () => {
    const stub = stubEntitlementFetch((call) => (call === 1 ? { status: 500 } : [entitlementRow()]));
    const resolver = createActionEntitlementResolver({
      supabaseUrl: CANONICAL_SUPABASE_URL,
      apiKey: "entitlement-key",
      fetchImpl: stub.fetchImpl,
      cacheTtlMs: 60_000,
    });
    const key = { identity: { identityId: IDENTITY_ID, greenhouseUserId: GREENHOUSE_USER_ID }, client: "claude_code" as const };

    await assert.rejects(async () => { await resolver.resolveCatalogVisibility(key); }, /status 500/);
    // A Supabase blip must not cost an entitled recruiter the write plane for a full TTL.
    assert.deepEqual(await resolver.resolveCatalogVisibility(key), { writeToolsVisible: true, reason: "entitled" });
    assert.equal(stub.urls.length, 2);
  });

  it("clamps the cached answer to the row's own expires_at", async () => {
    let clock = Date.parse("2026-07-26T12:00:00.000Z");
    const stub = stubEntitlementFetch(() => [entitlementRow({ expires_at: "2026-07-26T12:00:05.000Z" })]);
    const resolver = createActionEntitlementResolver({
      supabaseUrl: CANONICAL_SUPABASE_URL,
      apiKey: "entitlement-key",
      fetchImpl: stub.fetchImpl,
      cacheTtlMs: 60_000,
      now: () => clock,
    });
    const key = { identity: { identityId: IDENTITY_ID, greenhouseUserId: GREENHOUSE_USER_ID }, client: "claude_code" as const };

    assert.deepEqual(await resolver.resolveCatalogVisibility(key), { writeToolsVisible: true, reason: "entitled" });
    clock += 4_000;
    await resolver.resolveCatalogVisibility(key);
    assert.equal(stub.urls.length, 1, "still inside the grant");

    clock += 1_001;
    // 55s short of the 60s TTL: the grant lapsed, so the answer must be re-read, and now it denies.
    assert.deepEqual(await resolver.resolveCatalogVisibility(key), { writeToolsVisible: false, reason: "entitlement_expired" });
    assert.equal(stub.urls.length, 2);
  });

  it("shares one resolver across per-request rebuilds so the cache actually survives", async () => {
    _resetActionEntitlementResolvers();
    const stub = stubEntitlementFetch(() => [entitlementRow()]);
    const env = {
      GREENHOUSE_ACTION_SUPABASE_URL: CANONICAL_SUPABASE_URL,
      GREENHOUSE_ACTION_SUPABASE_KEY: "entitlement-key",
    } as NodeJS.ProcessEnv;
    const key = { identity: { identityId: IDENTITY_ID, greenhouseUserId: GREENHOUSE_USER_ID }, client: "claude_code" as const };
    try {
      // The hosted server is rebuilt per request; a resolver built inside that assembly would
      // otherwise throw its cache away before it could serve a second request.
      const first = createActionEntitlementResolverFromEnv(env, stub.fetchImpl);
      const second = createActionEntitlementResolverFromEnv(env, stub.fetchImpl);
      assert.equal(first, second);

      await first!.resolveCatalogVisibility(key);
      await second!.resolveCatalogVisibility(key);

      assert.equal(stub.urls.length, 1);
    } finally {
      _resetActionEntitlementResolvers();
    }
  });

  it("gives a rotated key its own resolver instead of serving the old key's answers", async () => {
    _resetActionEntitlementResolvers();
    const stub = stubEntitlementFetch(() => [entitlementRow()]);
    const key = { identity: { identityId: IDENTITY_ID, greenhouseUserId: GREENHOUSE_USER_ID }, client: "claude_code" as const };
    try {
      const before = createActionEntitlementResolverFromEnv({
        GREENHOUSE_ACTION_SUPABASE_URL: CANONICAL_SUPABASE_URL,
        GREENHOUSE_ACTION_SUPABASE_KEY: "old-key",
      } as NodeJS.ProcessEnv, stub.fetchImpl);
      const after = createActionEntitlementResolverFromEnv({
        GREENHOUSE_ACTION_SUPABASE_URL: CANONICAL_SUPABASE_URL,
        GREENHOUSE_ACTION_SUPABASE_KEY: "rotated-key",
      } as NodeJS.ProcessEnv, stub.fetchImpl);
      assert.notEqual(before, after);

      await before!.resolveCatalogVisibility(key);
      await after!.resolveCatalogVisibility(key);

      assert.equal(stub.urls.length, 2);
      assert.equal(stub.headers[0]?.get("apikey"), "old-key");
      assert.equal(stub.headers[1]?.get("apikey"), "rotated-key");
    } finally {
      _resetActionEntitlementResolvers();
    }
  });

  it("never serves one transport's resolver to a caller that supplied a different one", async () => {
    // fetchImpl IS the backend. It was absent from the registry key, so two callers with different
    // transports and the same env got the same resolver: the second transport was never called and
    // its caller was answered out of the first one's store — entitled when its own backend denies.
    _resetActionEntitlementResolvers();
    const granting = stubEntitlementFetch(() => [entitlementRow()]);
    const denying = stubEntitlementFetch(() => []);
    const env = {
      GREENHOUSE_ACTION_SUPABASE_URL: CANONICAL_SUPABASE_URL,
      GREENHOUSE_ACTION_SUPABASE_KEY: "entitlement-key",
      // TTL 0 so neither answer can be served from a cache; the question here is which BACKEND
      // was asked, not whether the answer was memoized.
      GREENHOUSE_ACTION_ENTITLEMENT_CACHE_TTL_MS: "0",
    } as NodeJS.ProcessEnv;
    const key = { identity: { identityId: IDENTITY_ID, greenhouseUserId: GREENHOUSE_USER_ID }, client: "claude_code" as const };
    try {
      const grantingResolver = createActionEntitlementResolverFromEnv(env, granting.fetchImpl);
      const denyingResolver = createActionEntitlementResolverFromEnv(env, denying.fetchImpl);
      assert.notEqual(grantingResolver, denyingResolver, "a distinct transport must get its own resolver");

      const granted = await grantingResolver!.resolveCatalogVisibility(key);
      const denied = await denyingResolver!.resolveCatalogVisibility(key);

      assert.equal(granted.writeToolsVisible, true);
      assert.equal(denied.writeToolsVisible, false, "the second caller must be answered by ITS OWN backend");
      assert.equal(granting.urls.length, 1);
      assert.equal(denying.urls.length, 1, "the second transport must actually be called");
    } finally {
      _resetActionEntitlementResolvers();
    }
  });

  it("still shares one resolver per transport, so the per-request cache survives", async () => {
    // The bucketing must not cost the sharing the registry exists for.
    _resetActionEntitlementResolvers();
    const stub = stubEntitlementFetch(() => [entitlementRow()]);
    const env = {
      GREENHOUSE_ACTION_SUPABASE_URL: CANONICAL_SUPABASE_URL,
      GREENHOUSE_ACTION_SUPABASE_KEY: "entitlement-key",
    } as NodeJS.ProcessEnv;
    try {
      assert.equal(
        createActionEntitlementResolverFromEnv(env, stub.fetchImpl),
        createActionEntitlementResolverFromEnv(env, stub.fetchImpl)
      );
    } finally {
      _resetActionEntitlementResolvers();
    }
  });
});

describe("action identity resolution", () => {
  it("returns BOTH ids from a directory row that carries them", async () => {
    const resolution = await resolveActionIdentity(directoryFor(IDENTITY_ID), writeCapableSession());

    assert.deepEqual(resolution, {
      status: "resolved",
      identity: { identityId: IDENTITY_ID, greenhouseUserId: GREENHOUSE_USER_ID },
    });
  });

  it("denies an ambiguous identity, exactly as the read path does", async () => {
    const directory = createStaticIdentityDirectory([
      { email: "recruiter@example.com", status: "resolved", greenhouseUserId: 4242, identityId: IDENTITY_ID },
      { email: "recruiter@example.com", status: "resolved", greenhouseUserId: 5353, identityId: OTHER_IDENTITY_ID },
    ]);

    const resolution = await resolveActionIdentity(directory, writeCapableSession());

    assert.equal(resolution.status, "denied");
    assert.equal(resolution.status === "denied" && resolution.code, "IDENTITY_AMBIGUOUS");
  });

  it("denies when the directory row id is missing, malformed, or inconsistent", async () => {
    for (const identityId of [undefined, "not-a-uuid", ""]) {
      const resolution = await resolveActionIdentity(directoryFor(identityId), writeCapableSession());
      assert.equal(resolution.status, "denied");
      assert.equal(resolution.status === "denied" && resolution.code, "IDENTITY_ID_UNAVAILABLE");
    }

    // One Greenhouse user, two directory rows: the read plane resolves the actor, but there is no
    // single row to key an entitlement on, so the action plane must not pick one.
    const twoRows = createStaticIdentityDirectory([
      { email: "recruiter@example.com", status: "resolved", greenhouseUserId: GREENHOUSE_USER_ID, identityId: IDENTITY_ID },
      { subject: "user-1", status: "resolved", greenhouseUserId: GREENHOUSE_USER_ID, identityId: OTHER_IDENTITY_ID },
    ]);
    const resolution = await resolveActionIdentity(twoRows, writeCapableSession());
    assert.equal(resolution.status, "denied");
    assert.equal(resolution.status === "denied" && resolution.code, "IDENTITY_ID_UNAVAILABLE");
  });

  it("denies when only SOME of the matched rows can supply a usable row id", async () => {
    // The half of the two-row hazard a Set cannot see. Unusable ids were discarded and the survivors
    // counted, so "one row has a uuid, its sibling has none" collapsed to a set of size one, read as
    // unanimity, and made the session write-eligible on whichever row happened to carry an id. It is
    // the same disagreement as two conflicting uuids — two rows matched, only one can be keyed on,
    // and nothing here knows which grant the recruiter meant.
    for (const secondRowId of [undefined, "not-a-uuid", ""]) {
      const mixed = createStaticIdentityDirectory([
        { email: "recruiter@example.com", status: "resolved", greenhouseUserId: GREENHOUSE_USER_ID, identityId: IDENTITY_ID },
        {
          subject: "user-1",
          status: "resolved",
          greenhouseUserId: GREENHOUSE_USER_ID,
          ...(secondRowId === undefined ? {} : { identityId: secondRowId }),
        },
      ]);

      // Reads are untouched — one Greenhouse user id, one resolved actor, exactly as before.
      assert.deepEqual(await mixed.resolve(writeCapableSession()), {
        status: "resolved",
        greenhouseUserId: GREENHOUSE_USER_ID,
      });
      const denial = await resolveActionIdentity(mixed, writeCapableSession());
      assert.equal(denial.status, "denied", `row id ${JSON.stringify(secondRowId)} silently granted write eligibility`);
      assert.equal(denial.status === "denied" && denial.code, "IDENTITY_ID_UNAVAILABLE");
    }

    // Not over-triggering: ONE row matched by both the email and the subject lookup is still one
    // row, and it stays write-eligible.
    const oneRowMatchedTwice = createStaticIdentityDirectory([
      { email: "recruiter@example.com", subject: "user-1", status: "resolved", greenhouseUserId: GREENHOUSE_USER_ID, identityId: IDENTITY_ID },
    ]);
    assert.deepEqual(await resolveActionIdentity(oneRowMatchedTwice, writeCapableSession()), {
      status: "resolved",
      identity: { identityId: IDENTITY_ID, greenhouseUserId: GREENHOUSE_USER_ID },
    });
  });

  it("keeps resolving the read plane's actor when the directory id is unusable", async () => {
    // The read plane authorizes on the Greenhouse user id alone; a missing/malformed row id is a
    // write-plane concern and must never cost a recruiter their 44 read tools.
    const directory = directoryFor("not-a-uuid");

    assert.deepEqual(await directory.resolve(writeCapableSession()), {
      status: "resolved",
      greenhouseUserId: GREENHOUSE_USER_ID,
    });
  });

  it("reads the directory row id out of Supabase alongside the Greenhouse user id", async () => {
    const requests: URL[] = [];
    const directory = createSupabaseIdentityDirectory({
      supabaseUrl: CANONICAL_SUPABASE_URL,
      apiKey: "identity-key",
      fetchImpl: (async (input: URL | RequestInfo) => {
        const url = new URL(String(input));
        requests.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => url.searchParams.get("primary_email") === "eq.recruiter@example.com"
            ? [{ id: IDENTITY_ID, greenhouse_user_id: GREENHOUSE_USER_ID, primary_email: "recruiter@example.com", status: "resolved" }]
            : [],
        } as Response;
      }) as typeof fetch,
    });

    const resolution = await resolveActionIdentity(directory, writeCapableSession());

    assert.deepEqual(resolution, {
      status: "resolved",
      identity: { identityId: IDENTITY_ID, greenhouseUserId: GREENHOUSE_USER_ID },
    });
    assert.equal(requests[0]?.searchParams.get("select"), "greenhouse_user_id,id,primary_email,google_subject,status");
  });

  it("keeps READS working against a directory that has no row-id column at all", async () => {
    // README documents custom identity tables/views as supported. Selecting the row id
    // unconditionally and throwing on the PostgREST error would take ALL read authorization away
    // from a supported configuration for the sake of a write-plane column. A directory that cannot
    // supply the uuid loses write eligibility only.
    _resetIdentityRowIdColumnLearning();
    const selects: string[] = [];
    const directory = createSupabaseIdentityDirectory({
      supabaseUrl: CANONICAL_SUPABASE_URL,
      apiKey: "identity-key",
      table: "recruiter_identity_view",
      fetchImpl: (async (input: URL | RequestInfo) => {
        const url = new URL(String(input));
        const select = url.searchParams.get("select") ?? "";
        selects.push(select);
        if (select.split(",").includes("id")) {
          return {
            ok: false,
            status: 400,
            text: async () => JSON.stringify({
              code: "42703",
              message: 'column recruiter_identity_view.id does not exist',
            }),
            json: async () => [],
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => url.searchParams.get("primary_email") === "eq.recruiter@example.com"
            ? [{ greenhouse_user_id: GREENHOUSE_USER_ID, primary_email: "recruiter@example.com", status: "resolved" }]
            : [],
        } as Response;
      }) as typeof fetch,
    });

    // Reads: exactly the resolution this directory produced before the row id was ever selected.
    assert.deepEqual(await directory.resolve(writeCapableSession()), {
      status: "resolved",
      greenhouseUserId: GREENHOUSE_USER_ID,
    });
    // Writes: denied, and denied with the code that says why rather than a lookup failure.
    assert.deepEqual(await resolveActionIdentity(directory, writeCapableSession()), {
      status: "denied",
      code: "IDENTITY_ID_UNAVAILABLE",
      reason: "Recruiter identity resolved without a single directory row id, which the action entitlement is keyed on.",
    });

    // The retry is learned once, not paid on every lookup for the life of the deployment.
    assert.equal(selects.filter((select) => select.split(",").includes("id")).length, 1, `retried the id column repeatedly: ${JSON.stringify(selects)}`);
    assert.ok(selects.length >= 3, `expected a failed attempt, its retry, and the subject lookup: ${JSON.stringify(selects)}`);
  });

  it("learns the missing row-id column ONCE, across the per-request directory rebuild", async () => {
    // The degradation above is only inert if the learned fact SURVIVES the request. The hosted
    // server builds a fresh server per request (remote.ts:171-176) and a fresh identity directory
    // with it (server.ts:82-90), so a flag scoped to the directory instance is discarded before it
    // can save anything: a supported custom view without the column paid the failing select AND its
    // retry on every single tool call, forever. Three identity round trips where there were two —
    // the opposite of README.md:245 ("detects its absence on the first lookup and stops asking").
    _resetIdentityRowIdColumnLearning();
    const selects: string[] = [];
    const respond = (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      const select = url.searchParams.get("select") ?? "";
      selects.push(select);
      if (select.split(",").includes("id")) {
        return {
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ code: "42703", message: 'column recruiter_rebuilt_view.id does not exist' }),
          json: async () => [],
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => url.searchParams.get("primary_email") === "eq.recruiter@example.com"
          ? [{ greenhouse_user_id: GREENHOUSE_USER_ID, primary_email: "recruiter@example.com", status: "resolved" }]
          : [],
      } as Response;
    };
    const config = {
      supabaseUrl: CANONICAL_SUPABASE_URL,
      apiKey: "identity-key",
      table: "recruiter_rebuilt_view",
      fetchImpl: (async (input: URL | RequestInfo) => respond(input)) as typeof fetch,
    };
    // Exactly what the hosted path does with it: build it, use it, throw it away.
    const perRequestDirectory = () => createSupabaseIdentityDirectory(config);
    const resolved = { status: "resolved", greenhouseUserId: GREENHOUSE_USER_ID };

    assert.deepEqual(await perRequestDirectory().resolve(writeCapableSession()), resolved);
    const firstRequest = selects.splice(0);
    assert.equal(
      firstRequest.filter((select) => select.split(",").includes("id")).length,
      1,
      `the first request learns the column is absent, once: ${JSON.stringify(firstRequest)}`
    );

    assert.deepEqual(await perRequestDirectory().resolve(writeCapableSession()), resolved);
    const secondRequest = selects.splice(0);
    assert.deepEqual(
      secondRequest.filter((select) => select.split(",").includes("id")),
      [],
      `a rebuilt directory re-attempted the select its predecessor proved impossible: ${JSON.stringify(secondRequest)}`
    );
    assert.equal(
      secondRequest.length,
      firstRequest.length - 1,
      "the second request must be exactly one round trip cheaper: the failed attempt is gone, not the retry"
    );

    // A differently-configured directory must not inherit the answer — this table has the column.
    assert.deepEqual(
      await createSupabaseIdentityDirectory({ ...config, table: "recruiter_identity_directory" }).resolve(writeCapableSession()),
      resolved
    );
    assert.ok(
      selects.some((select) => select.split(",").includes("id")),
      `another relation inherited an absence proved about "recruiter_rebuilt_view": ${JSON.stringify(selects)}`
    );
  });

  it("does not let one directory's unrelated column error kill write eligibility for another", async () => {
    // The poisoning: the absence was recorded BEFORE the retry proved it, and any 400 whose body
    // said "does not exist" was read as the row-id column missing. So a directory misconfigured
    // with a wrong SUBJECT column taught the registry that a relation it shares an origin, table,
    // id-column and key with has no row id — and a correctly configured directory on that same key
    // then omitted `id` and denied IDENTITY_ID_UNAVAILABLE, process-wide, until restart.
    _resetIdentityRowIdColumnLearning();
    const shared = {
      supabaseUrl: CANONICAL_SUPABASE_URL,
      apiKey: "identity-key",
      table: "recruiter_identity_directory",
    };
    const brokenSubjectColumn = createSupabaseIdentityDirectory({
      ...shared,
      columns: { subject: "not_a_column" },
      // Every select carrying the bad subject column fails — including the retry that drops the
      // row id, because the row id was never the problem.
      fetchImpl: (async (input: URL | RequestInfo) => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({
          code: "42703",
          message: `column recruiter_identity_directory.not_a_column does not exist (${String(input)})`,
        }),
        json: async () => [],
      }) as unknown as Response) as typeof fetch,
    });

    await assert.rejects(
      () => Promise.resolve(brokenSubjectColumn.resolve(writeCapableSession())),
      /status 400/,
      "a misconfigured column must surface as a failure, not as a learned absence"
    );

    // Same origin, same table, same id column, same key — a correctly configured directory, which
    // DOES have the row id and must still be able to prove it.
    const selects: string[] = [];
    const healthy = createSupabaseIdentityDirectory({
      ...shared,
      fetchImpl: (async (input: URL | RequestInfo) => {
        const url = new URL(String(input));
        selects.push(url.searchParams.get("select") ?? "");
        return {
          ok: true,
          status: 200,
          json: async () => url.searchParams.get("primary_email") === "eq.recruiter@example.com"
            ? [{
                id: IDENTITY_ID,
                greenhouse_user_id: GREENHOUSE_USER_ID,
                primary_email: "recruiter@example.com",
                status: "resolved",
              }]
            : [],
        } as Response;
      }) as typeof fetch,
    });

    assert.deepEqual(await resolveActionIdentity(healthy, writeCapableSession()), {
      status: "resolved",
      identity: { identityId: IDENTITY_ID, greenhouseUserId: GREENHOUSE_USER_ID },
    });
    assert.ok(
      selects.every((select) => select.split(",").includes("id")),
      `a healthy directory stopped selecting its row id: ${JSON.stringify(selects)}`
    );
  });

  it("still fails loudly when the directory lookup breaks for any other reason", async () => {
    // The tolerance above is scoped to one missing optional column. A 500, a permission error, or a
    // table that is not there must still surface — silently resolving nobody would look identical to
    // "this recruiter has no mapping".
    const directory = createSupabaseIdentityDirectory({
      supabaseUrl: CANONICAL_SUPABASE_URL,
      apiKey: "identity-key",
      fetchImpl: (async () => ({
        ok: false,
        status: 500,
        text: async () => "upstream exploded",
        json: async () => [],
      }) as unknown as Response) as typeof fetch,
    });

    await assert.rejects(() => Promise.resolve(directory.resolve(writeCapableSession())), /status 500/);
  });
});

describe("action catalog visibility composition", () => {
  function alwaysEntitledResolver(calls: string[]): ActionEntitlementResolver {
    return {
      async resolveCatalogVisibility(key) {
        calls.push(`${key.identity.identityId}|${key.client}`);
        return { writeToolsVisible: true, reason: "entitled" };
      },
    };
  }

  it("shows the write plane to an entitled session", async () => {
    const calls: string[] = [];

    const visibility = await resolveActionCatalogVisibility({
      session: writeCapableSession(),
      directory: directoryFor(IDENTITY_ID),
      resolver: alwaysEntitledResolver(calls),
    });

    assert.deepEqual(visibility, { writeToolsVisible: true, reason: "entitled" });
    assert.deepEqual(calls, [`${IDENTITY_ID}|claude_code`]);
  });

  it("hides the write plane entirely when a custom identity relation could name a different actor", async () => {
    // The known-deferred divergence: this plane honours identity table/column overrides, the action
    // plane's store hardcodes both, so one opaque subject can resolve to different actors on each
    // side. The compositional fix is Phase 2's; until it lands the ONLY configuration that can
    // reach the hole is fenced off, so it cannot be opened by a config change alone.
    for (const overridden of [
      "GREENHOUSE_RECRUITER_IDENTITY_TABLE",
      "GREENHOUSE_RECRUITER_IDENTITY_SUBJECT_COLUMN",
      "GREENHOUSE_RECRUITER_IDENTITY_DIRECTORY_ID_COLUMN",
    ]) {
      const calls: string[] = [];

      const visibility = await resolveActionCatalogVisibility({
        session: writeCapableSession(),
        directory: directoryFor(IDENTITY_ID),
        resolver: alwaysEntitledResolver(calls),
        env: { [overridden]: "custom_value" } as NodeJS.ProcessEnv,
      });

      assert.equal(visibility.writeToolsVisible, false, `${overridden} must withhold the write plane`);
      assert.equal(visibility.reason, "identity_config_diverges_from_action_plane");
      assert.equal(visibility.detail, overridden);
      assert.deepEqual(calls, [], "and it must deny before any entitlement lookup");
    }
  });

  it("leaves the canonical identity configuration entitled", async () => {
    // The fence must cost today's deployments nothing: they all use the directory the store
    // hardcodes, and the settings that do not affect subject resolution are not divergence.
    const calls: string[] = [];

    const visibility = await resolveActionCatalogVisibility({
      session: writeCapableSession(),
      directory: directoryFor(IDENTITY_ID),
      resolver: alwaysEntitledResolver(calls),
      env: {
        GREENHOUSE_RECRUITER_IDENTITY_EMAIL_COLUMN: "work_email",
        GREENHOUSE_RECRUITER_IDENTITY_LOOKUP_TIMEOUT_MS: "5000",
      } as NodeJS.ProcessEnv,
    });

    assert.deepEqual(visibility, { writeToolsVisible: true, reason: "entitled" });
    assert.deepEqual(calls, [`${IDENTITY_ID}|claude_code`]);
  });

  it("hides the write plane, without any lookup, for a client the action plane cannot entitle", async () => {
    const calls: string[] = [];

    const visibility = await resolveActionCatalogVisibility({
      session: writeCapableSession({ client: "claude_desktop_chat" }),
      directory: directoryFor(IDENTITY_ID),
      resolver: alwaysEntitledResolver(calls),
    });

    assert.deepEqual(visibility, { writeToolsVisible: false, reason: "client_not_write_capable" });
    assert.deepEqual(calls, [], "an ineligible client must not cost a Supabase round trip");
  });

  it("hides the write plane from a hand-assembled session that names two actors", async () => {
    // The email/subject binding is enforced at token validation, but this path never runs a
    // validator: createRecruiterMcpServer takes an arbitrary AuthenticatedSession (server.ts:61-75).
    // Such a session would show B's catalog while the action plane authorized A's writes, because
    // the read plane resolves on the email claim and the action store reads the `email:` subject
    // (action-mcp/src/store.ts:83-95). It is refused here, and reported as an actor problem rather
    // than mislabelled a client problem.
    const calls: string[] = [];
    const divergent = writeCapableSession({
      subject: "email:recruiter@example.com",
      email: "someone.else@example.com",
    });

    const visibility = await resolveActionCatalogVisibility({
      session: divergent,
      directory: directoryFor(IDENTITY_ID),
      resolver: alwaysEntitledResolver(calls),
    });

    assert.deepEqual(visibility, { writeToolsVisible: false, reason: "session_actor_not_bound" });
    assert.deepEqual(calls, [], "a session that cannot name one actor must not cost a Supabase round trip");

    // The bound twin is untouched: this refuses divergence, not `email:` subjects.
    assert.deepEqual(
      await resolveActionCatalogVisibility({
        session: writeCapableSession({ subject: "email:recruiter@example.com" }),
        directory: directoryFor(IDENTITY_ID),
        resolver: alwaysEntitledResolver(calls),
      }),
      { writeToolsVisible: true, reason: "entitled" }
    );
  });

  it("hides the write plane when the entitlement store is not deployed", async () => {
    const visibility = await resolveActionCatalogVisibility({
      session: writeCapableSession(),
      directory: directoryFor(IDENTITY_ID),
      resolver: null,
    });

    assert.deepEqual(visibility, { writeToolsVisible: false, reason: "write_plane_not_deployed" });
  });

  it("hides the write plane for an ambiguous identity and never asks the store", async () => {
    const calls: string[] = [];
    const directory = createStaticIdentityDirectory([
      { email: "recruiter@example.com", status: "resolved", greenhouseUserId: 4242, identityId: IDENTITY_ID },
      { email: "recruiter@example.com", status: "resolved", greenhouseUserId: 5353, identityId: OTHER_IDENTITY_ID },
    ]);

    const visibility = await resolveActionCatalogVisibility({
      session: writeCapableSession(),
      directory,
      resolver: alwaysEntitledResolver(calls),
    });

    assert.deepEqual(visibility, {
      writeToolsVisible: false,
      reason: "identity_not_resolved",
      detail: "IDENTITY_AMBIGUOUS",
    });
    assert.deepEqual(calls, []);
  });

  it("fails write visibility closed — and reports why — when a lookup throws", async () => {
    const failingDirectory: IdentityDirectory = {
      resolve() { throw new Error("identity directory unreachable"); },
    };

    const identityFailure = await resolveActionCatalogVisibility({
      session: writeCapableSession(),
      directory: failingDirectory,
      resolver: alwaysEntitledResolver([]),
    });
    assert.deepEqual(identityFailure, {
      writeToolsVisible: false,
      reason: "identity_lookup_failed",
      detail: "identity directory unreachable",
    });

    const entitlementFailure = await resolveActionCatalogVisibility({
      session: writeCapableSession(),
      directory: directoryFor(IDENTITY_ID),
      resolver: {
        async resolveCatalogVisibility() { throw new Error("entitlement store unreachable"); },
      },
    });
    assert.deepEqual(entitlementFailure, {
      writeToolsVisible: false,
      reason: "entitlement_lookup_failed",
      detail: "entitlement store unreachable",
    });
  });
});

describe("action entitlement env wiring", () => {
  it("returns no resolver when the write plane is not deployed in this environment", () => {
    assert.equal(createActionEntitlementResolverFromEnv({} as NodeJS.ProcessEnv), null);
  });

  it("refuses half-set entitlement store config instead of reading it as 'nobody is entitled'", () => {
    assert.throws(
      () => createActionEntitlementResolverFromEnv({
        GREENHOUSE_ACTION_SUPABASE_URL: CANONICAL_SUPABASE_URL,
      } as NodeJS.ProcessEnv),
      /must be set together/
    );
    assert.throws(
      () => createActionEntitlementResolverFromEnv({
        GREENHOUSE_ACTION_SUPABASE_KEY: "entitlement-key",
      } as NodeJS.ProcessEnv),
      /must be set together/
    );
  });

  it("refuses an entitlement store in a non-canonical Supabase project", () => {
    assert.throws(
      () => createActionEntitlementResolverFromEnv({
        GREENHOUSE_ACTION_SUPABASE_URL: "https://otherprojectref00000.supabase.co",
        GREENHOUSE_ACTION_SUPABASE_KEY: "entitlement-key",
      } as NodeJS.ProcessEnv),
      /canonical Greenhouse MCP Supabase project/
    );
  });

  it("rejects a malformed cache TTL instead of silently changing how stale the catalog can be", () => {
    assert.throws(
      () => createActionEntitlementResolverFromEnv({
        GREENHOUSE_ACTION_SUPABASE_URL: CANONICAL_SUPABASE_URL,
        GREENHOUSE_ACTION_SUPABASE_KEY: "entitlement-key",
        GREENHOUSE_ACTION_ENTITLEMENT_CACHE_TTL_MS: "60000 ",
      } as NodeJS.ProcessEnv),
      /GREENHOUSE_ACTION_ENTITLEMENT_CACHE_TTL_MS must be a non-negative safe integer/
    );
  });
});
