import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createSupabaseActionStore } from "../src/store.js";
import type { ActionIntent } from "../src/types.js";

const row = {
  action_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  action_kind: "application_assignment_change",
  lock_key: "application:100",
  scope_job_id: 200,
  binding: { application_id: 100, assignment_role: "recruiter", previous_user_id: 20, proposed_user_id: 40 },
  identity_id: "11111111-1111-4111-8111-111111111111",
  actor_user_id: 10,
  subject_fingerprint: "A".repeat(43),
  session_fingerprint: "B".repeat(43),
  client: "claude_code",
  current_fingerprint: "C".repeat(43),
  desired_fingerprint: "D".repeat(43),
  approval_fingerprint: "E".repeat(43),
  high_impact: false,
  intent_expires_at: "2026-07-21T20:05:00.000Z",
  not_applied_before: "2026-07-21T20:05:00.000Z",
  status: "executing",
  phase: "preflight",
  owner_token: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  lease_expires_at: "2026-07-21T20:01:30.000Z",
  observation: null,
  error_code: null,
  upstream_status: null,
  upstream_request_id: null,
  upstream_resource_id: null,
  first_original_observation_at: null,
  resolution_source: null,
  resolved_by_fingerprint: null,
  completed_at: null,
  created_at: "2026-07-21T20:00:00.000Z",
  updated_at: "2026-07-21T20:00:00.000Z",
};

const intent: ActionIntent = {
  version: 2,
  kind: "greenhouse_action_intent",
  actionId: row.action_id,
  actionKind: "application_assignment_change",
  subject: "private-google-subject",
  identityId: row.identity_id,
  actorUserId: 10,
  sessionTokenId: "action:private-session",
  client: "claude_code",
  applyTool: "apply_application_assignment_change",
  lockKey: row.lock_key,
  scopeJobId: 200,
  binding: row.binding as ActionIntent["binding"],
  currentFingerprint: row.current_fingerprint,
  desiredFingerprint: row.desired_fingerprint,
  approvalFingerprint: row.approval_fingerprint,
  highImpact: false,
  reconciliationGraceMs: 5 * 60_000,
  issuedAtMs: Date.parse("2026-07-21T20:00:00.000Z"),
  expiresAtMs: Date.parse("2026-07-21T20:05:00.000Z"),
};

describe("Supabase action store", () => {
  test("refuses a non-canonical Supabase project", () => {
    for (const url of [
      "https://wrong-project.supabase.co",
      "https://exampleprojectref000.attacker.example",
      "https://exampleprojectref000.supabase.co.attacker.example",
      "https://exampleprojectref000.supabase.co:8443",
      "https://user@exampleprojectref000.supabase.co",
    ]) assert.throws(() => createSupabaseActionStore({ url, apiKey: "secret" }), /canonical Greenhouse MCP project/);
  });

  test("resolves Google and deployed email-session subjects through their canonical identity columns", async () => {
    const urls: string[] = [];
    const store = createSupabaseActionStore({
      url: "https://exampleprojectref000.supabase.co",
      apiKey: "service-role-secret",
      fetchImpl: async (input) => {
        urls.push(String(input));
        return Response.json([{
          id: "11111111-1111-4111-8111-111111111111",
          greenhouse_user_id: 10,
          status: "resolved",
        }]);
      },
    });
    const session = {
      version: 1 as const,
      kind: "greenhouse_action_session" as const,
      audience: "greenhouse_action_mcp" as const,
      client: "codex" as const,
      tokenId: "action:test-session",
      issuedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    };

    await store.resolveIdentity({ ...session, subject: "google-subject-1" });
    await store.resolveIdentity({ ...session, subject: "email:pilot.user@example.com" });

    assert.match(urls[0]!, /google_subject=eq.google-subject-1/);
    assert.match(urls[1]!, /primary_email=eq.pilot.user%40example.com/);
  });

  test("rejects a malformed email-session subject before querying identity state", async () => {
    let requests = 0;
    const store = createSupabaseActionStore({
      url: "https://exampleprojectref000.supabase.co",
      apiKey: "service-role-secret",
      fetchImpl: async () => {
        requests += 1;
        return Response.json([]);
      },
    });
    await assert.rejects(store.resolveIdentity({
      version: 1,
      kind: "greenhouse_action_session",
      audience: "greenhouse_action_mcp",
      subject: "email:Pilot.User@example.com",
      client: "codex",
      tokenId: "action:test-session",
      issuedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    }), /email identity subject is invalid/);
    assert.equal(requests, 0);
  });

  test("claim sends only generic metadata/fingerprints and parses the fenced record", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const store = createSupabaseActionStore({
      url: "https://exampleprojectref000.supabase.co",
      apiKey: "service-role-secret",
      fetchImpl: async (input, init = {}) => {
        calls.push({ url: String(input), init });
        return Response.json({ disposition: "owned", record: row });
      },
    });
    const result = await store.claimAction({
      intent,
      subjectFingerprint: row.subject_fingerprint,
      sessionFingerprint: row.session_fingerprint,
      ownerToken: row.owner_token,
    });
    assert.equal(result.disposition, "owned");
    assert.equal(result.record.actionKind, "application_assignment_change");
    assert.equal(result.record.lockKey, "application:100");
    assert.equal(result.record.client, "claude_code");
    const request = calls[0]!;
    assert.match(request.url, /\/rest\/v1\/rpc\/claim_greenhouse_action$/);
    const serialized = String(request.init.body);
    assert.doesNotMatch(serialized, /private-google-subject|private-session|"intent"/);
    assert.match(serialized, /p_action_kind/);
    assert.match(serialized, /p_binding/);
    assert.match(serialized, /p_approval_fingerprint/);
    assert.match(serialized, /p_reconciliation_grace_seconds/);
  });

  test("the state deadline includes response-body consumption", async () => {
    const store = createSupabaseActionStore({
      url: "https://exampleprojectref000.supabase.co",
      apiKey: "service-role-secret",
      timeoutMs: 20,
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("[")); },
      }), { status: 200 }),
    });
    await assert.rejects(store.isSessionRevoked("action:stalled-response"), /timed out/);
  });

  test("uses the seven generic fenced/reconciliation RPCs", async () => {
    const names: string[] = [];
    const store = createSupabaseActionStore({
      url: "https://exampleprojectref000.supabase.co",
      apiKey: "service-role-secret",
      fetchImpl: async (input) => {
        const name = String(input).match(/\/rpc\/([^?]+)$/)?.[1];
        if (name) names.push(name);
        return name === "begin_greenhouse_action_mutation" ? Response.json(true) : Response.json(row);
      },
    });
    assert.equal(await store.beginMutation({ actionId: row.action_id, ownerToken: row.owner_token }), true);
    await store.finishAction({ actionId: row.action_id, ownerToken: row.owner_token, status: "failed" });
    await store.prepareReconciliation(row.action_id);
    await store.deferUnknown(row.action_id);
    await store.reconcileOriginalObservation(row.action_id);
    await store.resolveUnknown({ actionId: row.action_id, status: "unknown", observation: "conflict" });
    assert.deepEqual(names, [
      "begin_greenhouse_action_mutation",
      "finish_greenhouse_action",
      "prepare_greenhouse_action_reconciliation",
      "defer_greenhouse_action_unknown",
      "reconcile_greenhouse_action_original_observation",
      "resolve_greenhouse_action_unknown",
    ]);
  });

  test("revocation lookup is fresh and recoverable action ordering is bounded", async () => {
    const urls: string[] = [];
    const store = createSupabaseActionStore({
      url: "https://exampleprojectref000.supabase.co",
      apiKey: "service-role-secret",
      fetchImpl: async (input) => {
        const url = String(input);
        urls.push(url);
        return Response.json(url.includes("recruiter_mcp_session_revocation") ? [{ token_id: "action:session-12345678" }] : []);
      },
    });
    assert.equal(await store.isSessionRevoked("action:session-12345678"), true);
    assert.deepEqual(await store.listRecoverableActions(), []);
    assert.match(urls[0]!, /token_id=eq.action%3Asession-12345678/);
    const recovery = new URL(urls[1]!);
    assert.equal(recovery.searchParams.get("status"), "in.(executing,unknown)");
    assert.equal(recovery.searchParams.get("or"), "(observation.is.null,observation.neq.conflict)");
    assert.equal(recovery.searchParams.get("order"), "status.asc,updated_at.asc");
    assert.equal(recovery.searchParams.get("limit"), "100");
  });
});
