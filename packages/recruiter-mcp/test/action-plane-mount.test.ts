import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ACTION_DEFINITIONS } from "../../action-mcp/dist/index.js";
import { createRecruiterMcpServer, createRecruiterRuntimeForServer } from "../src/server.js";
import { createActionToolGrant } from "../src/action-tools.js";
import { RECRUITER_TOOL_DEFINITIONS, registerRecruiterTools } from "../src/tools/register.js";
import type { ActionPlaneMount } from "../src/action-plane.js";
import type { AuthenticatedSession } from "../src/types.js";

/**
 * The catalog contract, from both sides.
 *
 * An unentitled session must see a byte-identical base catalog — two gates already assert that
 * (readiness `toolCatalogCheck`, and the container self-check), and this adds the other half those
 * cannot express: that an ENTITLED session actually receives the write tools, in a position that
 * leaves the read catalog untouched.
 */

const BASE_ENV: NodeJS.ProcessEnv = {
  GREENHOUSE_RECRUITER_ALLOWED_TOOLS: RECRUITER_TOOL_DEFINITIONS.map((tool) => tool.name).join(","),
  GREENHOUSE_RECRUITER_ALLOW_TEST_SURFACE: "true",
};

function session(): AuthenticatedSession {
  return {
    subject: "google-subject-sam",
    surface: "test",
    client: "claude_desktop_chat",
    tokenId: "recruiter-token-abc123",
  };
}

function stubMount(): ActionPlaneMount {
  return {
    grantedTools: createActionToolGrant(
      ACTION_DEFINITIONS.flatMap((definition) => [definition.previewTool, definition.applyTool])
    ),
    // Never invoked: these tests are about the CATALOG, not about executing a mutation.
    buildService: () => ({ preview: async () => ({}), apply: async () => ({}) }) as never,
  };
}

function catalogFor(actionPlane?: ActionPlaneMount): string[] {
  const { registeredTools } = createRecruiterMcpServer({
    session: session(),
    env: BASE_ENV,
    configureGreenhouse: false,
    scopedReader: { async scopedRead() { throw new Error("no read in a catalog test"); } },
    ...(actionPlane ? { actionPlane } : {}),
  });
  return registeredTools;
}

describe("action plane mount — catalog contract", () => {
  it("leaves the catalog untouched for a session with no entitlement", () => {
    const withoutGrant = catalogFor();
    assert.equal(
      withoutGrant.some((name) => name.startsWith("preview_") || name.startsWith("apply_")),
      false,
      "an unentitled session must not see a single write tool"
    );
  });

  it("adds all 22 write tools for an entitled session, and NOTHING else", () => {
    const base = catalogFor();
    const granted = catalogFor(stubMount());

    const added = granted.filter((name) => !base.includes(name));
    assert.equal(added.length, 22, `expected exactly 22 added tools, got ${added.length}`);
    assert.deepEqual(
      [...added].sort(),
      ACTION_DEFINITIONS.flatMap((d) => [d.previewTool, d.applyTool]).sort(),
      "the added set must be exactly the action package's own catalog"
    );
    assert.deepEqual(
      granted.filter((name) => base.includes(name)),
      base,
      "no read tool may be dropped, renamed, or reordered by mounting the write plane"
    );
  });

  it("appends them AFTER the curated read order, never interleaved", () => {
    const base = catalogFor();
    const granted = catalogFor(stubMount());
    assert.deepEqual(
      granted.slice(0, base.length),
      base,
      "the first N entries must be the base catalog in its exact curated order — a client that reads " +
        "the head of the list must see what it saw before writes existed"
    );
  });

  it("pairs every capability, so no apply ships without its preview", () => {
    const granted = catalogFor(stubMount());
    for (const definition of ACTION_DEFINITIONS) {
      assert.ok(granted.includes(definition.previewTool), `${definition.previewTool} missing`);
      assert.ok(granted.includes(definition.applyTool), `${definition.applyTool} missing`);
    }
    assert.equal(ACTION_DEFINITIONS.length, 11);
  });

  it("marks apply destructive and preview read-only, honestly", () => {
    // Advisory per the MCP spec — clients MUST treat annotations as untrusted and Cursor ignores
    // them entirely — but VS Code, Claude's connector and M365 Copilot all gate their confirmation
    // on readOnlyHint, so a wrong value here silently costs a confirmation step on a real mutation.
    const captured = new Map<string, { readOnlyHint?: boolean; destructiveHint?: boolean }>();
    const runtime = createRecruiterRuntimeForServer({
      session: session(),
      env: BASE_ENV,
      configureGreenhouse: false,
      scopedReader: { async scopedRead() { throw new Error("no read in a catalog test"); } },
      actionPlane: stubMount(),
    });
    registerRecruiterTools(
      {
        tool(name, _description, _schema, annotations) {
          captured.set(name, annotations as { readOnlyHint?: boolean; destructiveHint?: boolean });
        },
      },
      runtime
    );

    for (const definition of ACTION_DEFINITIONS) {
      assert.equal(captured.get(definition.previewTool)?.readOnlyHint, true,
        `${definition.previewTool} reads and signs but never mutates`);
      assert.equal(captured.get(definition.applyTool)?.readOnlyHint, false,
        `${definition.applyTool} mutates Greenhouse`);
      assert.equal(captured.get(definition.applyTool)?.destructiveHint, true,
        `${definition.applyTool} can fire ATS automation including candidate email, and Greenhouse ` +
          `exposes only unreject as a true reversal`);
    }
  });
});

/**
 * The gate the catalog test cannot reach.
 *
 * Those tests INJECT a mount, so they prove what happens once one exists — they say nothing about
 * whether one should. Every real decision lives in `mountActionPlane`, and the first version of the
 * unentitled-catalog test above passed with the registration guard deleted, because the outer
 * `if (runtime.actionPlane)` was carrying it. These aim at the decision itself.
 */
describe("mountActionPlane — who gets a mount at all", () => {
  const ENV: NodeJS.ProcessEnv = {
    GREENHOUSE_ACTION_SERVICE_ENABLED: "true",
    GREENHOUSE_ACTION_SIGNING_SECRET: "action-mount-test-signing-secret-32-bytes-min",
    GREENHOUSE_RECRUITER_SCOPE_SIGNING_SECRET: "mount-test-scope-signing-secret-at-least-32b",
  };

  function storeWith(entitlement: unknown) {
    return {
      async resolveIdentity() {
        return { identityId: "33333333-3333-4333-8333-333333333333", greenhouseUserId: 77 };
      },
      async isSessionRevoked() {
        return false;
      },
      async getEntitlement() {
        return entitlement;
      },
    } as never;
  }

  it("returns nothing when the actor holds no entitlement row — the normal state", async () => {
    const { mountActionPlane } = await import("../src/action-plane.js");
    const mount = await mountActionPlane({
      session: session(),
      env: ENV,
      store: storeWith(null),
      service: {} as never,
    });
    assert.equal(mount, null, "no entitlement row means no write tools, and that is the default for everyone");
  });

  it("returns nothing when the entitlement exists but withholds preview", async () => {
    const { mountActionPlane } = await import("../src/action-plane.js");
    const mount = await mountActionPlane({
      session: session(),
      env: ENV,
      store: storeWith({ identityId: "x", greenhouseUserId: 77, client: "claude_desktop_chat", canPreview: false, canApply: true }),
      service: {} as never,
    });
    assert.equal(mount, null, "canApply without canPreview must not open the catalog");
  });

  it("returns nothing when the session cannot be bridged", async () => {
    const { mountActionPlane } = await import("../src/action-plane.js");
    for (const broken of [{ tokenId: undefined }, { client: undefined }] as const) {
      const mount = await mountActionPlane({
        session: { ...session(), ...broken },
        env: ENV,
        store: storeWith({ identityId: "x", greenhouseUserId: 77, client: "claude_desktop_chat", canPreview: true, canApply: true }),
        service: {} as never,
      });
      assert.equal(mount, null, "a session that cannot be attributed or revoked gets no write authority");
    }
  });

  it("withholds the write tools on a store outage without failing the read session", async () => {
    const { mountActionPlane } = await import("../src/action-plane.js");
    const mount = await mountActionPlane({
      session: session(),
      env: ENV,
      store: {
        async resolveIdentity() { throw new Error("supabase unavailable"); },
        async isSessionRevoked() { return false; },
        async getEntitlement() { return null; },
      } as never,
      service: {} as never,
    });
    assert.equal(mount, null, "an outage narrows to no writes; it must not take the read catalog down with it");
  });

  it("returns nothing when the service switch is off, even for an entitled actor", async () => {
    // The switch is the one deliberate act that turns the plane on. Without honoring it, the plane
    // would activate because a secret exists in the environment — configuration mistaken for consent.
    const { mountActionPlane } = await import("../src/action-plane.js");
    const { GREENHOUSE_ACTION_SERVICE_ENABLED: _off, ...envWithoutSwitch } = ENV;
    const mount = await mountActionPlane({
      session: session(),
      env: envWithoutSwitch,
      store: storeWith({ identityId: "x", greenhouseUserId: 77, client: "claude_desktop_chat", canPreview: true, canApply: true }),
      service: {} as never,
    });
    assert.equal(mount, null, "a fully entitled actor still gets nothing until the plane is switched on");
  });

  it("withholds the write tools when the action runtime cannot be CONSTRUCTED, and never fails the read session", async () => {
    // The production outage, as a test. With the service switch on and GREENHOUSE_ACTION_CLIENT_ID
    // unset, createActionRuntimeFromEnv throws — and that throw was outside every catch, so it
    // propagated into the request handler and took the read session down with it. Reads must survive
    // any write-plane misconfiguration.
    const { mountActionPlane } = await import("../src/action-plane.js");
    const { GREENHOUSE_ACTION_SUPABASE_URL: _u, GREENHOUSE_ACTION_SUPABASE_KEY: _k, ...envMissingRuntime } = {
      ...ENV,
      GREENHOUSE_ACTION_SUPABASE_URL: "https://exampleprojectref000.supabase.co",
      GREENHOUSE_ACTION_SUPABASE_KEY: "service-role-key-placeholder",
    };
    // No store and no service override: the real construction path runs, and it has no credentials.
    const mount = await mountActionPlane({ session: session(), env: envMissingRuntime });
    assert.equal(mount, null, "a construction failure must withhold write tools, not throw");
  });

  it("grants all 22 to an entitled actor, built from the package catalog", async () => {
    const { mountActionPlane } = await import("../src/action-plane.js");
    const mount = await mountActionPlane({
      session: session(),
      env: ENV,
      store: storeWith({ identityId: "x", greenhouseUserId: 77, client: "claude_desktop_chat", canPreview: true, canApply: true }),
      service: {} as never,
    });
    assert.ok(mount, "an entitled actor must receive a mount");
    assert.equal(mount!.grantedTools.size, 22, "all of them — no per-tool dispensing");
  });
});
