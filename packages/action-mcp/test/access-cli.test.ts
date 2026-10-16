import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  assertCanonicalActionDatabaseUrl,
  disableActionEntitlement,
  provisionActionAccess,
  revokeActionSession,
} from "../src/access-cli.js";
import { IDENTITY_ID, TEST_SECRET } from "./helpers.js";

const SUPABASE_URL = "https://exampleprojectref000.supabase.co";
const EXPECTED_ENTITLEMENT = {
  identity_id: IDENTITY_ID,
  greenhouse_user_id: 42,
  client: "codex",
  can_preview: true,
  can_apply: true,
  can_apply_high_impact: false,
  status: "active",
  expires_at: "2023-12-14T22:13:20.000Z",
  updated_at: "2023-11-14T22:13:20.000Z",
};
const EXPECTED_DISABLED_ENTITLEMENT = {
  ...EXPECTED_ENTITLEMENT,
  can_preview: false,
  can_apply: false,
  can_apply_high_impact: false,
  status: "disabled",
  expires_at: "2023-11-14T22:13:20.000Z",
};

describe("action access operator", () => {
  test("preflights identity, rotates stale entitlement expiry, and writes split token files with a token-free manifest", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "greenhouse-action-access-"));
    const writes: Array<{ url: string; body: unknown }> = [];
    let entitlementExpiry = "2020-01-01T00:00:00.000Z";
    try {
      const report = await provisionActionAccess({
        supabaseUrl: SUPABASE_URL,
        supabaseKey: "service-role-key",
        signingSecret: TEST_SECRET,
        now: () => 1_700_000_000_000,
        tokenId: () => "action:test-token-123456",
        fetchImpl: async (input, init = {}) => {
          const url = String(input);
          if ((init.method ?? "GET") === "GET") {
            return Response.json([{ id: IDENTITY_ID, greenhouse_user_id: 42, status: "resolved" }]);
          }
          const body = JSON.parse(String(init.body)) as Array<{ expires_at: string }>;
          entitlementExpiry = body[0]!.expires_at;
          writes.push({ url, body });
          await assert.rejects(readFile(join(outputDir, "manifest.json"), "utf8"), /ENOENT/);
          return new Response(null, { status: 204 });
        },
      }, {
        roster: { users: [{ subject: "google-subject-1", clients: ["codex"], can_apply: true }] },
        outputDir,
      });

      assert.equal(report.user_count, 1);
      assert.equal(report.entitlement_count, 1);
      assert.equal(report.session_file_count, 1);
      assert.equal(writes.length, 1);
      assert.match(writes[0]!.url, /greenhouse_action_entitlement/);
      assert.equal(entitlementExpiry, "2023-12-14T22:13:20.000Z");
      assert.deepEqual(writes[0]!.body, [EXPECTED_ENTITLEMENT]);

      const sessionPath = join(outputDir, report.sessions[0]!.path);
      const sessionJson = await readFile(sessionPath, "utf8");
      const session = JSON.parse(sessionJson) as { token: string };
      const manifestJson = await readFile(join(outputDir, "manifest.json"), "utf8");
      assert.ok(session.token.length > 40);
      assert.equal(manifestJson.includes(session.token), false);
      assert.equal((await stat(sessionPath)).mode & 0o777, 0o600);
      assert.equal((await stat(join(outputDir, "manifest.json"))).mode & 0o777, 0o600);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("does not grant entitlements when roster identity resolution fails", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "greenhouse-action-access-"));
    let writes = 0;
    try {
      await assert.rejects(provisionActionAccess({
        supabaseUrl: SUPABASE_URL,
        supabaseKey: "service-role-key",
        signingSecret: TEST_SECRET,
        fetchImpl: async (_input, init = {}) => {
          if ((init.method ?? "GET") === "POST") writes += 1;
          return Response.json([]);
        },
      }, {
        roster: { users: [{ subject: "unresolved-subject" }] },
        outputDir,
      }), /not uniquely resolved/);
      assert.equal(writes, 0);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("does not grant entitlements when a sensitive artifact cannot be written", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "greenhouse-action-access-"));
    const sessionPath = join(outputDir, "session-test-token-123456.json");
    const firstSessionPath = join(outputDir, "session-first-token-123456.json");
    const tokenIds = ["action:first-token-123456", "action:test-token-123456"];
    let writes = 0;
    try {
      await writeFile(sessionPath, "existing sensitive artifact\n", "utf8");
      await assert.rejects(provisionActionAccess({
        supabaseUrl: SUPABASE_URL,
        supabaseKey: "service-role-key",
        signingSecret: TEST_SECRET,
        now: () => 1_700_000_000_000,
        tokenId: () => tokenIds.shift()!,
        fetchImpl: async (_input, init = {}) => {
          if ((init.method ?? "GET") === "POST") {
            writes += 1;
            return new Response(null, { status: 204 });
          }
          return Response.json([{ id: IDENTITY_ID, greenhouse_user_id: 42, status: "resolved" }]);
        },
      }, {
        roster: { users: [{ subject: "google-subject-1", clients: ["codex", "claude_code"], can_apply: true }] },
        outputDir,
      }), /Refusing to overwrite sensitive action access artifact/);
      assert.equal(writes, 0);
      await assert.rejects(readFile(firstSessionPath, "utf8"), /ENOENT/);
      assert.equal(await readFile(sessionPath, "utf8"), "existing sensitive artifact\n");
      await assert.rejects(readFile(join(outputDir, "manifest.json"), "utf8"), /ENOENT/);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("publishes the final manifest when an ambiguous entitlement write has exact desired readback", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "greenhouse-action-access-"));
    let writes = 0;
    let readbacks = 0;
    try {
      const report = await provisionActionAccess({
        supabaseUrl: SUPABASE_URL,
        supabaseKey: "service-role-key",
        signingSecret: TEST_SECRET,
        now: () => 1_700_000_000_000,
        tokenId: () => "action:test-token-123456",
        fetchImpl: async (input, init = {}) => {
          const url = String(input);
          if (url.includes("recruiter_identity_directory")) {
            return Response.json([{ id: IDENTITY_ID, greenhouse_user_id: 42, status: "resolved" }]);
          }
          if ((init.method ?? "GET") === "POST") {
            writes += 1;
            throw new TypeError("connection reset after send");
          }
          readbacks += 1;
          assert.match(url, new RegExp(`identity_id=eq\\.${IDENTITY_ID}`));
          assert.match(url, /client=eq\.codex/);
          return Response.json([{
            ...EXPECTED_ENTITLEMENT,
            expires_at: "2023-12-14T22:13:20+00:00",
            updated_at: "2023-11-14T22:13:20+00:00",
          }]);
        },
      }, {
        roster: { users: [{ subject: "google-subject-1", clients: ["codex"], can_apply: true }] },
        outputDir,
      });

      assert.equal(writes, 1);
      assert.equal(readbacks, 1);
      assert.equal(JSON.parse(await readFile(report.manifest_path, "utf8")).ok, true);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("does not publish the final manifest when an ambiguous entitlement write cannot be reconciled", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "greenhouse-action-access-"));
    let readbacks = 0;
    const writes: unknown[] = [];
    try {
      await assert.rejects(provisionActionAccess({
        supabaseUrl: SUPABASE_URL,
        supabaseKey: "service-role-key",
        signingSecret: TEST_SECRET,
        now: () => 1_700_000_000_000,
        tokenId: () => "action:test-token-123456",
        fetchImpl: async (input, init = {}) => {
          const url = String(input);
          if (url.includes("recruiter_identity_directory")) {
            return Response.json([{ id: IDENTITY_ID, greenhouse_user_id: 42, status: "resolved" }]);
          }
          if ((init.method ?? "GET") === "POST") {
            const body = JSON.parse(String(init.body)) as unknown;
            writes.push(body);
            if (writes.length === 1) throw new TypeError("connection reset after send");
            return new Response(null, { status: 204 });
          }
          readbacks += 1;
          return Response.json([{ ...EXPECTED_ENTITLEMENT, can_apply: false }]);
        },
      }, {
        roster: { users: [{ subject: "google-subject-1", clients: ["codex"], can_apply: true }] },
        outputDir,
      }), /affected entitlements were disabled and bearer files were removed/);
      assert.equal(readbacks, 1);
      assert.deepEqual(writes, [[EXPECTED_ENTITLEMENT], [EXPECTED_DISABLED_ENTITLEMENT]]);
      await assert.rejects(readFile(join(outputDir, "session-test-token-123456.json"), "utf8"), /ENOENT/);
      await assert.rejects(readFile(join(outputDir, "manifest.json"), "utf8"), /ENOENT/);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("reconciles an ambiguous entitlement 5xx instead of treating it as a definite rejection", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "greenhouse-action-access-"));
    let readbacks = 0;
    try {
      const report = await provisionActionAccess({
        supabaseUrl: SUPABASE_URL,
        supabaseKey: "service-role-key",
        signingSecret: TEST_SECRET,
        now: () => 1_700_000_000_000,
        tokenId: () => "action:test-token-123456",
        fetchImpl: async (input, init = {}) => {
          if (String(input).includes("recruiter_identity_directory")) {
            return Response.json([{ id: IDENTITY_ID, greenhouse_user_id: 42, status: "resolved" }]);
          }
          if ((init.method ?? "GET") === "POST") return new Response(null, { status: 503 });
          readbacks += 1;
          return Response.json([EXPECTED_ENTITLEMENT]);
        },
      }, {
        roster: { users: [{ subject: "google-subject-1", clients: ["codex"], can_apply: true }] },
        outputDir,
      });
      assert.equal(readbacks, 1);
      assert.equal(JSON.parse(await readFile(report.manifest_path, "utf8")).ok, true);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("does not publish the final manifest after a definite entitlement rejection", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "greenhouse-action-access-"));
    let readbacks = 0;
    const writes: unknown[] = [];
    try {
      await assert.rejects(provisionActionAccess({
        supabaseUrl: SUPABASE_URL,
        supabaseKey: "service-role-key",
        signingSecret: TEST_SECRET,
        now: () => 1_700_000_000_000,
        tokenId: () => "action:test-token-123456",
        fetchImpl: async (input, init = {}) => {
          if (String(input).includes("recruiter_identity_directory")) {
            return Response.json([{ id: IDENTITY_ID, greenhouse_user_id: 42, status: "resolved" }]);
          }
          if ((init.method ?? "GET") === "POST") {
            const body = JSON.parse(String(init.body)) as unknown;
            writes.push(body);
            return new Response(null, { status: writes.length === 1 ? 409 : 204 });
          }
          readbacks += 1;
          return Response.json([EXPECTED_ENTITLEMENT]);
        },
      }, {
        roster: { users: [{ subject: "google-subject-1", clients: ["codex"], can_apply: true }] },
        outputDir,
      }), /HTTP 409/);
      assert.equal(readbacks, 0);
      assert.deepEqual(writes, [[EXPECTED_ENTITLEMENT]]);
      await assert.rejects(readFile(join(outputDir, "session-test-token-123456.json"), "utf8"), /ENOENT/);
      await assert.rejects(readFile(join(outputDir, "manifest.json"), "utf8"), /ENOENT/);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("disables and verifies entitlement before cleaning up after manifest publication failure", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "greenhouse-action-access-"));
    const writes: unknown[] = [];
    try {
      await assert.rejects(provisionActionAccess({
        supabaseUrl: SUPABASE_URL,
        supabaseKey: "service-role-key",
        signingSecret: TEST_SECRET,
        now: () => 1_700_000_000_000,
        tokenId: () => "action:test-token-123456",
        fetchImpl: async (input, init = {}) => {
          if (String(input).includes("recruiter_identity_directory")) {
            return Response.json([{ id: IDENTITY_ID, greenhouse_user_id: 42, status: "resolved" }]);
          }
          writes.push(JSON.parse(String(init.body)) as unknown);
          if (writes.length === 1) {
            await writeFile(join(outputDir, "manifest.json"), "competing manifest\n", "utf8");
          }
          return new Response(null, { status: 204 });
        },
      }, {
        roster: { users: [{ subject: "google-subject-1", clients: ["codex"], can_apply: true }] },
        outputDir,
      }), /affected entitlements were disabled and bearer files were removed/);

      assert.deepEqual(writes, [[EXPECTED_ENTITLEMENT], [EXPECTED_DISABLED_ENTITLEMENT]]);
      assert.equal(await readFile(join(outputDir, "manifest.json"), "utf8"), "competing manifest\n");
      await assert.rejects(readFile(join(outputDir, "session-test-token-123456.json"), "utf8"), /ENOENT/);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("removes bearer files but retains a token-free recovery manifest when disable cannot be verified", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "greenhouse-action-access-"));
    let writes = 0;
    try {
      await assert.rejects(provisionActionAccess({
        supabaseUrl: SUPABASE_URL,
        supabaseKey: "service-role-key",
        signingSecret: TEST_SECRET,
        now: () => 1_700_000_000_000,
        tokenId: () => "action:test-token-123456",
        fetchImpl: async (input, init = {}) => {
          if (String(input).includes("recruiter_identity_directory")) {
            return Response.json([{ id: IDENTITY_ID, greenhouse_user_id: 42, status: "resolved" }]);
          }
          if ((init.method ?? "GET") === "GET") return Response.json([EXPECTED_ENTITLEMENT]);
          writes += 1;
          if (writes === 1) {
            await writeFile(join(outputDir, "manifest.json"), "competing manifest\n", "utf8");
            return new Response(null, { status: 204 });
          }
          return new Response(null, { status: 503 });
        },
      }, {
        roster: { users: [{ subject: "google-subject-1", clients: ["codex"], can_apply: true }] },
        outputDir,
      }), /entitlement state could not be confirmed disabled/);

      assert.equal(writes, 2);
      await assert.rejects(readFile(join(outputDir, "session-test-token-123456.json"), "utf8"), /ENOENT/);
      const pending = (await readdir(outputDir)).find((name) => name.startsWith(".manifest-"));
      assert.ok(pending);
      const recovery = JSON.parse(await readFile(join(outputDir, pending), "utf8")) as {
        contains_tokens: boolean;
        sessions: Array<{ token_id: string }>;
      };
      assert.equal(recovery.contains_tokens, false);
      assert.deepEqual(recovery.sessions.map(({ token_id }) => token_id), ["action:test-token-123456"]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("reports bearer cleanup failure and retains the token-free recovery manifest", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "greenhouse-action-access-"));
    let writes = 0;
    try {
      await assert.rejects(provisionActionAccess({
        supabaseUrl: SUPABASE_URL,
        supabaseKey: "service-role-key",
        signingSecret: TEST_SECRET,
        now: () => 1_700_000_000_000,
        tokenId: () => "action:test-token-123456",
        fetchImpl: async (input, init = {}) => {
          if (String(input).includes("recruiter_identity_directory")) {
            return Response.json([{ id: IDENTITY_ID, greenhouse_user_id: 42, status: "resolved" }]);
          }
          writes += 1;
          if (writes === 1) {
            await writeFile(join(outputDir, "manifest.json"), "competing manifest\n", "utf8");
          } else {
            await chmod(outputDir, 0o500);
          }
          return new Response(null, { status: 204 });
        },
      }, {
        roster: { users: [{ subject: "google-subject-1", clients: ["codex"], can_apply: true }] },
        outputDir,
      }), /bearer files could not all be deleted/);

      assert.equal(writes, 2);
      assert.ok((await readFile(join(outputDir, "session-test-token-123456.json"), "utf8")).includes("\"token\""));
      assert.ok((await readdir(outputDir)).some((name) => name.startsWith(".manifest-")));
    } finally {
      await chmod(outputDir, 0o700).catch(() => undefined);
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("disables one identity/client entitlement through the supported operator path", async () => {
    const writes: unknown[] = [];
    const report = await disableActionEntitlement({
      supabaseUrl: SUPABASE_URL,
      supabaseKey: "service-role-key",
      now: () => 1_700_000_000_000,
      fetchImpl: async (input, init = {}) => {
        if ((init.method ?? "GET") === "GET") {
          return Response.json([{ id: IDENTITY_ID, greenhouse_user_id: 42, status: "resolved" }]);
        }
        writes.push(JSON.parse(String(init.body)) as unknown);
        return new Response(null, { status: 204 });
      },
    }, { subject: "google-subject-1", client: "codex" });

    assert.equal(report.status, "disabled");
    assert.deepEqual(writes, [[EXPECTED_DISABLED_ENTITLEMENT]]);
  });

  test("revokes one action token id without accepting a bearer token", async () => {
    let request: { url: string; body: unknown } | undefined;
    const report = await revokeActionSession({
      supabaseUrl: SUPABASE_URL,
      supabaseKey: "service-role-key",
      now: () => 1_700_000_000_000,
      fetchImpl: async (input, init = {}) => {
        request = { url: String(input), body: JSON.parse(String(init.body)) as unknown };
        return new Response(null, { status: 204 });
      },
    }, {
      tokenId: "action:test-token-123456",
      revokedBy: "ops@example.com",
      reason: "device replacement",
    });
    assert.equal(report.status, "revoked");
    assert.match(request!.url, /recruiter_mcp_session_revocation/);
    assert.deepEqual(request!.body, [{
      token_id: "action:test-token-123456",
      status: "revoked",
      revoked_at: "2023-11-14T22:13:20.000Z",
      revoked_by: "ops@example.com",
      reason: "device replacement",
      evidence_detail: { source: "greenhouse_action_access_cli", contains_token_string: false },
    }]);
    await assert.rejects(revokeActionSession({
      supabaseUrl: SUPABASE_URL,
      supabaseKey: "service-role-key",
    }, {
      tokenId: "header.payload.signature",
      revokedBy: "ops@example.com",
      reason: "invalid",
    }), /token ID, not a signed bearer token/);
  });

  test("accepts only canonical direct or pooler database URLs", () => {
    assert.equal(assertCanonicalActionDatabaseUrl(
      "postgresql://postgres:secret@db.exampleprojectref000.supabase.co:5432/postgres"
    ).connection, "direct");
    assert.equal(assertCanonicalActionDatabaseUrl(
      "postgres://postgres.exampleprojectref000:secret@aws-0-us-west-1.pooler.supabase.com:6543/postgres"
    ).connection, "pooler");
    assert.throws(() => assertCanonicalActionDatabaseUrl(
      "postgresql://postgres:secret@db.wrongproject.supabase.co:5432/postgres"
    ), /canonical project/);
  });
});
