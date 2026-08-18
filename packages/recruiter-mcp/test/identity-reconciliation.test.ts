import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyIdentityReconciliationPlan,
  buildIdentityReconciliationPlan,
  fetchResolvedDirectoryRows,
  type IdentityDirectoryRow,
} from "../src/identity-reconciliation.js";

const CANONICAL = "https://exampleprojectref000.supabase.co";
const ANALYTICS = "https://otherprojectref00000.supabase.co";

const DIRECTORY: IdentityDirectoryRow[] = [
  { greenhouseUserId: 111, primaryEmail: "keep@company.com", status: "resolved" },
  { greenhouseUserId: 222, primaryEmail: "revoke@company.com", status: "resolved" },
  { greenhouseUserId: 333, primaryEmail: "absent@company.com", status: "resolved" },
  { greenhouseUserId: 444, primaryEmail: "already-gone@company.com", status: "deactivated" },
];

// Roster: 111 active, 222 deactivated, 333 absent entirely, 444 not present (already deactivated row).
const ROSTER = {
  data: [
    { id: 111, email: "keep@company.com" },
    { id: 222, email: "revoke@company.com", deactivated: true },
  ],
};

function ids(entries: { greenhouseUserId: number }[]): number[] {
  return entries.map((entry) => entry.greenhouseUserId).sort((a, b) => a - b);
}

describe("identity directory reconciliation (Slice G #23)", () => {
  it("keeps present-active, revokes present-inactive, and tombstones absent under a complete roster", () => {
    const plan = buildIdentityReconciliationPlan({
      directoryRows: DIRECTORY,
      greenhouseUsers: ROSTER,
      rosterComplete: true,
      generatedAt: "2026-06-29T00:00:00.000Z",
    });

    assert.deepEqual(ids(plan.kept), [111]);
    assert.deepEqual(ids(plan.revoked), [222]);
    assert.deepEqual(ids(plan.tombstoned), [333]);
    assert.deepEqual(plan.skipped, []);
    assert.equal(plan.resolvedRowCount, 3, "only resolved rows are reconciled");
    assert.equal(plan.canApply, true);
    assert.equal(plan.containsTokens, false);
  });

  it("only ever processes resolved rows — never re-activates an already-deactivated row", () => {
    const plan = buildIdentityReconciliationPlan({
      directoryRows: DIRECTORY,
      greenhouseUsers: { data: [{ id: 444, email: "already-gone@company.com" }] },
      rosterComplete: true,
    });
    const allTouched = [...plan.kept, ...plan.revoked, ...plan.tombstoned, ...plan.skipped];
    assert.ok(!allTouched.some((entry) => entry.greenhouseUserId === 444), "deactivated row 444 must never be reconciled");
  });

  it("FAIL-SAFE: never tombstones an absent recruiter when the roster is not asserted complete", () => {
    const plan = buildIdentityReconciliationPlan({
      directoryRows: DIRECTORY,
      greenhouseUsers: ROSTER,
      rosterComplete: false,
    });

    // The deactivation signal (222) is still acted on — it is a positive signal, safe on any roster.
    assert.deepEqual(ids(plan.revoked), [222]);
    // The absent recruiter (333) is NOT deprovisioned; it is skipped, not tombstoned.
    assert.deepEqual(plan.tombstoned, []);
    assert.deepEqual(ids(plan.skipped), [333]);
    assert.equal(plan.canApply, true, "revokes still apply even on an incomplete roster");
  });

  it("treats a duplicated roster id as inactive if ANY occurrence is deactivated (order-independent)", () => {
    // Deactivated duplicate LAST.
    const deactivatedLast = buildIdentityReconciliationPlan({
      directoryRows: [{ greenhouseUserId: 555, primaryEmail: "dupe@company.com", status: "resolved" }],
      greenhouseUsers: { data: [{ id: 555, email: "dupe@company.com" }, { id: 555, email: "dupe@company.com", deactivated: true }] },
      rosterComplete: true,
    });
    assert.deepEqual(ids(deactivatedLast.revoked), [555]);
    assert.deepEqual(deactivatedLast.kept, []);

    // ACTIVE duplicate LAST — the distinguishing case: last-write-wins would KEEP a deactivated
    // recruiter (a deprovisioning bypass); the any-occurrence-wins rule must still revoke.
    const activeLast = buildIdentityReconciliationPlan({
      directoryRows: [{ greenhouseUserId: 555, primaryEmail: "dupe@company.com", status: "resolved" }],
      greenhouseUsers: { data: [{ id: 555, email: "dupe@company.com", deactivated: true }, { id: 555, email: "dupe@company.com" }] },
      rosterComplete: true,
    });
    assert.deepEqual(ids(activeLast.revoked), [555]);
    assert.deepEqual(activeLast.kept, []);
  });

  it("applies revokes and tombstones as status flips to 'deactivated' via PATCH on the canonical project", async () => {
    const plan = buildIdentityReconciliationPlan({
      directoryRows: DIRECTORY,
      greenhouseUsers: ROSTER,
      rosterComplete: true,
    });
    const requests: Array<{ method: string; url: URL; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      requests.push({ method: String(init?.method), url: new URL(String(input)), body: JSON.parse(String(init?.body)) });
      return { ok: true, status: 200 } as Response;
    }) as typeof fetch;

    const report = await applyIdentityReconciliationPlan(plan, {
      supabaseUrl: CANONICAL,
      apiKey: "sb_secret_service_role_key",
      appliedAt: "2026-06-29T00:00:00.000Z",
      fetchImpl,
    });

    assert.equal(report.revokedCount, 1);
    assert.equal(report.tombstonedCount, 1);
    assert.equal(report.containsTokens, false);
    assert.equal(requests.length, 2, "one PATCH per revoke/tombstone, never for kept rows");
    for (const request of requests) {
      assert.equal(request.method, "PATCH");
      assert.equal(request.url.pathname, "/rest/v1/recruiter_identity_directory");
      assert.equal(request.body.status, "deactivated");
      assert.equal(request.body.last_verified_at, "2026-06-29T00:00:00.000Z");
      const evidence = request.body.evidence_detail as Record<string, unknown>;
      assert.equal(evidence.source, "identity_directory_reconciliation");
      assert.ok(evidence.action === "revoke" || evidence.action === "tombstone");
      assert.ok(typeof evidence.reason === "string" && (evidence.reason as string).length > 0);
    }
    const patchedIds = requests.map((r) => r.url.searchParams.get("greenhouse_user_id")).sort();
    assert.deepEqual(patchedIds, ["eq.222", "eq.333"]);
  });

  it("rejects a non-canonical Supabase project on apply (Slice F #3 boundary holds for reconciliation)", async () => {
    const plan = buildIdentityReconciliationPlan({ directoryRows: DIRECTORY, greenhouseUsers: ROSTER, rosterComplete: true });
    let fetched = false;
    const fetchImpl = (async () => { fetched = true; return { ok: true, status: 200 } as Response; }) as typeof fetch;
    await assert.rejects(
      () => applyIdentityReconciliationPlan(plan, { supabaseUrl: ANALYTICS, apiKey: "k", fetchImpl }),
      /canonical Greenhouse MCP Supabase project/
    );
    assert.equal(fetched, false, "must not write deprovisioning to a non-canonical project");
  });

  it("fetches only resolved directory rows and rejects a non-canonical project", async () => {
    let fetched = false;
    const fetchImpl = (async (input: URL | RequestInfo) => {
      fetched = true;
      const url = new URL(String(input));
      assert.equal(url.searchParams.get("status"), "eq.resolved");
      assert.equal(url.searchParams.get("select"), "greenhouse_user_id,primary_email,status");
      return {
        ok: true,
        status: 200,
        json: async () => [
          { greenhouse_user_id: 111, primary_email: "keep@company.com", status: "resolved" },
          { greenhouse_user_id: "222", primary_email: "revoke@company.com", status: "resolved" },
          { greenhouse_user_id: 0, primary_email: "bad@company.com", status: "resolved" }, // invalid id -> dropped
        ],
      } as Response;
    }) as typeof fetch;

    const rows = await fetchResolvedDirectoryRows({ supabaseUrl: CANONICAL, apiKey: "k", fetchImpl });
    assert.deepEqual(ids(rows), [111, 222], "string ids parsed, invalid id dropped");
    assert.equal(fetched, true, "the canonical read actually reaches the fetch");

    fetched = false;
    await assert.rejects(
      () => fetchResolvedDirectoryRows({ supabaseUrl: ANALYTICS, apiKey: "k", fetchImpl }),
      /canonical Greenhouse MCP Supabase project/
    );
    assert.equal(fetched, false, "must not read from a non-canonical project (assert before read)");
  });

  it("reports canApply=false when nothing needs deprovisioning (all present and active)", () => {
    const plan = buildIdentityReconciliationPlan({
      directoryRows: [{ greenhouseUserId: 111, primaryEmail: "a@company.com", status: "resolved" }],
      greenhouseUsers: { data: [{ id: 111, email: "a@company.com" }] },
      rosterComplete: true,
    });
    assert.deepEqual(ids(plan.kept), [111]);
    assert.equal(plan.revoked.length, 0);
    assert.equal(plan.tombstoned.length, 0);
    assert.equal(plan.canApply, false);
  });

  it("FAIL-SAFE: refuses to tombstone the directory against an empty/error roster believed complete", () => {
    for (const roster of [{ data: [] }, { message: "Unauthorized" }, {}]) {
      const plan = buildIdentityReconciliationPlan({
        directoryRows: DIRECTORY, // resolved: 111, 222, 333
        greenhouseUsers: roster,
        rosterComplete: true,
        confirmMassDeprovision: true, // even with the override, an empty roster must NOT wipe the directory
      });
      assert.deepEqual(plan.tombstoned, [], "an empty/unparseable roster must never tombstone");
      assert.deepEqual(ids(plan.skipped), [111, 222, 333], "all resolved rows skipped, not deprovisioned");
      assert.match(plan.tombstonesBlockedReason ?? "", /empty/);
      assert.equal(plan.canApply, false);
    }
  });

  it("FAIL-SAFE: refuses a mass tombstone above the blast-radius floor unless explicitly confirmed", () => {
    // A 'complete' roster containing only 1 of 3 resolved rows -> 2/3 absent (>50%) -> suspicious.
    const roster = { data: [{ id: 111, email: "keep@company.com" }] };
    const blocked = buildIdentityReconciliationPlan({ directoryRows: DIRECTORY, greenhouseUsers: roster, rosterComplete: true });
    assert.deepEqual(ids(blocked.kept), [111]);
    assert.deepEqual(blocked.tombstoned, [], "blast-radius floor blocks the mass tombstone");
    assert.deepEqual(ids(blocked.skipped), [222, 333]);
    assert.match(blocked.tombstonesBlockedReason ?? "", /2\/3 resolved/);
    assert.equal(blocked.canApply, false);

    // With explicit confirmation, the same plan applies the tombstones.
    const confirmed = buildIdentityReconciliationPlan({
      directoryRows: DIRECTORY,
      greenhouseUsers: roster,
      rosterComplete: true,
      confirmMassDeprovision: true,
    });
    assert.deepEqual(ids(confirmed.tombstoned), [222, 333]);
    assert.equal(confirmed.tombstonesBlockedReason, undefined);
    assert.equal(confirmed.canApply, true);
  });
});
