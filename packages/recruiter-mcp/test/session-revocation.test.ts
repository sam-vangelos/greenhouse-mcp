import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRevocationTokenId,
  recordSessionRevocation,
  recordSessionRevocationFromEnv,
} from "../src/session-revocation.js";

describe("central durable session revocation", () => {
  it("writes an idempotent token-id revocation row to Supabase/PostgREST", async () => {
    const requests: Array<{ url: URL; method?: string; headers: Headers; body: unknown }> = [];
    const fetchImpl = async (url: URL | RequestInfo, init?: RequestInit) => {
      requests.push({
        url: new URL(String(url)),
        method: init?.method,
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return { ok: true, status: 201, json: async () => [] } as Response;
    };

    const report = await recordSessionRevocation(
      {
        supabaseUrl: "https://project.supabase.co/",
        apiKey: "service-key",
        fetchImpl: fetchImpl as typeof fetch,
        revokedAt: "2026-06-23T12:00:00.000Z",
      },
      {
        tokenId: "session-123",
        revokedBy: "ops@example.com",
        reason: "managed offboarding",
      }
    );

    assert.deepEqual(report, {
      ok: true,
      revokedAt: "2026-06-23T12:00:00.000Z",
      table: "recruiter_mcp_session_revocation",
      tokenId: "session-123",
      status: "revoked",
      revokedBy: "ops@example.com",
      reason: "managed offboarding",
      containsTokens: false,
    });
    assert.equal(requests[0]?.url.pathname, "/rest/v1/recruiter_mcp_session_revocation");
    assert.equal(requests[0]?.url.searchParams.get("on_conflict"), "token_id");
    assert.equal(requests[0]?.method, "POST");
    assert.equal(requests[0]?.headers.get("apikey"), "service-key");
    assert.equal(requests[0]?.headers.get("authorization"), "Bearer service-key");
    assert.equal(requests[0]?.headers.get("prefer"), "resolution=merge-duplicates,return=representation");
    assert.deepEqual(requests[0]?.body, [{
      token_id: "session-123",
      status: "revoked",
      revoked_at: "2026-06-23T12:00:00.000Z",
      revoked_by: "ops@example.com",
      reason: "managed offboarding",
      evidence_detail: {
        source: "greenhouse_recruiter_revoke_session_cli",
        contains_token_string: false,
      },
    }]);
  });

  it("loads the revocation writer config from the production revocation env", async () => {
    const requests: Array<{ url: URL; body: unknown }> = [];
    const fetchImpl = async (url: URL | RequestInfo, init?: RequestInit) => {
      requests.push({ url: new URL(String(url)), body: JSON.parse(String(init?.body)) });
      return { ok: true, status: 200, json: async () => [] } as Response;
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl as typeof fetch;
    try {
      const report = await recordSessionRevocationFromEnv(
        {
          GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
          GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY: "service-key",
          GREENHOUSE_RECRUITER_REVOCATION_TABLE: "custom_revocations",
        } as NodeJS.ProcessEnv,
        ["--token-id", "session-env-1", "--revoked-by", "ops@example.com"]
      );

      assert.equal(report.table, "custom_revocations");
      assert.equal(report.tokenId, "session-env-1");
      assert.equal(requests[0]?.url.pathname, "/rest/v1/custom_revocations");
      assert.equal((requests[0]?.body as Array<Record<string, unknown>>)[0]?.token_id, "session-env-1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects a non-canonical Supabase revocation project on the revoke CLI env path (Slice F #3)", async () => {
    let fetched = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetched = true;
      return { ok: true, status: 200, json: async () => [] } as Response;
    }) as typeof fetch;
    try {
      await assert.rejects(
        () => recordSessionRevocationFromEnv(
          {
            GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_URL: "https://otherprojectref00000.supabase.co",
            GREENHOUSE_RECRUITER_REVOCATION_SUPABASE_KEY: "service-key",
          } as NodeJS.ProcessEnv,
          ["--token-id", "session-canonical-guard"]
        ),
        /canonical Greenhouse MCP Supabase project/
      );
      assert.equal(fetched, false, "must not write a revocation to a non-canonical project");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects signed token strings and scoped-claim-looking values", async () => {
    assert.throws(() => normalizeRevocationTokenId("payload.signature"), /not the signed session token string/);
    assert.throws(() => normalizeRevocationTokenId("permittedJobIds"), /scoped identity, permission, or expiry/);
    assert.throws(() => normalizeRevocationTokenId("token id with spaces"), /may contain only/);

    let called = false;
    await assert.rejects(
      () => recordSessionRevocation(
        {
          supabaseUrl: "https://project.supabase.co",
          apiKey: "service-key",
          fetchImpl: (async () => {
            called = true;
            return { ok: true, status: 200 } as Response;
          }) as typeof fetch,
        },
        { tokenId: "payload.signature" }
      ),
      /not the signed session token string/
    );
    assert.equal(called, false);
  });

  it("rejects insecure or unsafe Supabase revocation write config before network calls", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return { ok: true, status: 200 } as Response;
    }) as typeof fetch;

    await assert.rejects(
      () => recordSessionRevocation(
        { supabaseUrl: "http://project.supabase.co", apiKey: "service-key", fetchImpl },
        { tokenId: "session-123" }
      ),
      /HTTPS origin/
    );
    await assert.rejects(
      () => recordSessionRevocation(
        { supabaseUrl: " https://project.supabase.co ", apiKey: "service-key", fetchImpl },
        { tokenId: "session-123" }
      ),
      /leading or trailing whitespace/
    );
    await assert.rejects(
      () => recordSessionRevocation(
        {
          supabaseUrl: "https://project.supabase.co",
          apiKey: "service-key",
          fetchImpl,
          columns: { evidenceDetail: "evidence_detail,payload" },
        },
        { tokenId: "session-123" }
      ),
      /evidence-detail column/
    );
    await assert.rejects(
      () => recordSessionRevocation(
        {
          supabaseUrl: "https://project.supabase.co",
          apiKey: "service-key",
          fetchImpl,
          table: " recruiter_mcp_session_revocation ",
        },
        { tokenId: "session-123" }
      ),
      /leading or trailing whitespace/
    );
    await assert.rejects(
      () => recordSessionRevocation(
        {
          supabaseUrl: "https://project.supabase.co",
          apiKey: "service-key",
          fetchImpl,
          columns: { tokenId: " token_id " },
        },
        { tokenId: "session-123" }
      ),
      /leading or trailing whitespace/
    );
    await assert.rejects(
      () => recordSessionRevocation(
        { supabaseUrl: "https://project.supabase.co", apiKey: "   ", fetchImpl },
        { tokenId: "session-123" }
      ),
      /API key is required/
    );
    await assert.rejects(
      () => recordSessionRevocation(
        { supabaseUrl: "https://project.supabase.co", apiKey: " service-key ", fetchImpl },
        { tokenId: "session-123" }
      ),
      /leading or trailing whitespace/
    );
    assert.equal(called, false);
  });
});
