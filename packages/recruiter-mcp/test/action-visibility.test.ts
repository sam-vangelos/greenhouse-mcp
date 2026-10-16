import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRecruiterVisibilityProbe } from "../src/action-visibility.js";
import { _resetPrivateCustomFieldCache } from "../src/private-custom-fields.js";
import { createScopedGreenhouseReader, type ApiResponse, type RawReadClient } from "../../scoped-core/src/index.js";
import { fakeScopedReader, scopedDenial, scopedSuccess, testRuntime } from "./test-helpers.js";

/**
 * The probe IS the fence's verdict — Phase 2c §4.2. Each case here was red-tested by breaking the
 * probe the specific way the assertion claims to catch (returning hidden for denials, inferring
 * redaction from policy, skipping the projection), and observed to fail.
 */

describe("createRecruiterVisibilityProbe", () => {
  beforeEach(() => _resetPrivateCustomFieldCache());

  function probeOver(handler: Parameters<typeof fakeScopedReader>[0]) {
    const { runtime } = testRuntime(fakeScopedReader(handler));
    return createRecruiterVisibilityProbe({ runtime });
  }

  it("reports a permitted, unredacted application as visible", async () => {
    const probe = probeOver((toolName) => {
      if (toolName === "get_application") {
        return scopedSuccess(toolName, { id: 100, job_id: 200, candidate_id: 300, status: "in_process" });
      }
      throw new Error(`unexpected scoped read: ${toolName}`);
    });
    assert.deepEqual(
      await probe.probe({ kind: "application", id: 100, requiresUnredacted: false }),
      { state: "visible", redacted: false }
    );
  });

  it("reports a row the read plane filtered out as hidden — the private-candidate case", async () => {
    // get_application runs the private-candidate gate; a withheld row comes back ok:true, data:null.
    const probe = probeOver((toolName) => {
      if (toolName === "get_application") return scopedSuccess(toolName, null);
      throw new Error(`unexpected scoped read: ${toolName}`);
    });
    assert.deepEqual(
      await probe.probe({ kind: "application", id: 100, requiresUnredacted: false }),
      { state: "hidden" }
    );
  });

  it("reports a permission-lookup outage as unavailable, NEVER as hidden", async () => {
    // Collapsing these would turn a transient outage into a silent authorization denial with the
    // wrong diagnosis — the exact conflation §4.1 exists to prevent.
    const probe = probeOver((toolName) => {
      if (toolName === "get_candidate") return scopedDenial(toolName, "PERMISSION_LOOKUP_FAILED");
      throw new Error(`unexpected scoped read: ${toolName}`);
    });
    const verdict = await probe.probe({ kind: "candidate", id: 300, requiresUnredacted: false });
    assert.equal(verdict.state, "unavailable");
    assert.match((verdict as { reason: string }).reason, /PERMISSION_LOOKUP_FAILED/);
  });

  it("reports a candidate whose private custom-field values are stripped as visible, redacted", async () => {
    const probe = probeOver((toolName) => {
      if (toolName === "get_candidate") {
        return scopedSuccess(toolName, {
          id: 300,
          first_name: "Casey",
          applications: [{ id: 100, job_id: 200 }],
          custom_fields: { current_compensation: "900000", desired_role: "FDE" },
        });
      }
      if (toolName === "list_custom_fields") {
        // One PRIVATE definition. The projection strips its VALUE; the probe must read that strip
        // out of the pipeline's own before/after, not re-derive it from policy.
        return scopedSuccess(toolName, [
          { id: 1, name: "Current Compensation", name_key: "current_compensation", field_type: "candidate", private: true },
          { id: 2, name: "Desired Role", name_key: "desired_role", field_type: "candidate", private: false },
        ]);
      }
      throw new Error(`unexpected scoped read: ${toolName}`);
    });
    assert.deepEqual(
      await probe.probe({ kind: "candidate", id: 300, requiresUnredacted: true }),
      { state: "visible", redacted: true }
    );
  });

  it("probes offers and job notes through the exact-id list shape, and treats absence as hidden", async () => {
    const probe = probeOver((toolName, params) => {
      if (toolName === "list_offers") {
        // The read plane returned a page that does NOT contain the requested id: list-shaped null.
        assert.equal(params?.ids, "950");
        return scopedSuccess(toolName, [{ id: 951, job_id: 200, application_id: 101, candidate_id: 301 }]);
      }
      throw new Error(`unexpected scoped read: ${toolName}`);
    });
    assert.deepEqual(
      await probe.probe({ kind: "offer", id: 950, requiresUnredacted: false }),
      { state: "hidden" }
    );
  });

  it("reports a privately_visible job note — body withheld by projection — as redacted", async () => {
    const probe = probeOver((toolName) => {
      if (toolName === "list_job_notes") {
        return scopedSuccess(toolName, [
          { id: 700, job_id: 200, user_id: 10, body: "the withheld body", visibility: "privately_visible", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
        ]);
      }
      throw new Error(`unexpected scoped read: ${toolName}`);
    });
    const verdict = await probe.probe({ kind: "job_note", id: 700, requiresUnredacted: true });
    assert.equal(verdict.state, "visible");
    assert.equal((verdict as { redacted: boolean }).redacted, true,
      "projectJobNoteRow deletes the body on privately_visible — the probe must see that deletion");
  });
});

/**
 * B4 — the write plane inherits the attestation by construction.
 *
 * The fence asks the READ plane whether the acting human can see the target, and
 * `action-mcp/src/service.ts:295-301` turns a `hidden` verdict into `TARGET_NOT_VISIBLE` for every
 * action kind (locked in `action-mcp/test/all-capabilities-concurrency.test.ts`). So the thing that
 * has to be proved here is the half that is new: that the REAL scoped pipeline — not a fake
 * scopedRead — answers `hidden` for an unattested org-wide session and `visible` for an attested
 * one. Nothing in `action-visibility.ts` changes; that is the point.
 */
describe("B4: the visibility fence inherits the private-candidate attestation", () => {
  const PRIVATE_CANDIDATE_ID = 300;

  function tenant(): RawReadClient {
    return {
      async read<T>(path: string, params?: Record<string, unknown>): Promise<ApiResponse<T>> {
        const ids = String(params?.ids ?? "")
          .split(",")
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value > 0);
        if (path === "/applications") {
          return { data: [{ id: 100, job_id: 200, candidate_id: PRIVATE_CANDIDATE_ID, status: "in_process" }].filter((row) => ids.includes(row.id)) as T, nextCursor: null };
        }
        if (path === "/candidates") {
          return { data: ids.map((id) => ({ id, private: id === PRIVATE_CANDIDATE_ID })) as T, nextCursor: null };
        }
        return { data: [] as T, nextCursor: null };
      },
    };
  }

  function probeOverRealPipeline(scope: unknown) {
    const scopedReader = createScopedGreenhouseReader<unknown>({
      actorResolver: { resolveActor: () => 100 },
      permissionProvider: { async getPermittedJobIds() { return scope as never; } },
      rawReader: tenant(),
    });
    const { runtime } = testRuntime(scopedReader as never);
    return createRecruiterVisibilityProbe({ runtime });
  }

  it("hides a private candidate's application from an unattested org-wide session", async () => {
    const verdict = await probeOverRealPipeline({ kind: "all" })
      .probe({ kind: "application", id: 100, requiresUnredacted: false });
    assert.deepEqual(verdict, { state: "hidden" },
      "hidden is what action-mcp turns into TARGET_NOT_VISIBLE, for every action kind");
  });

  it("shows it to an attested org-wide session", async () => {
    const verdict = await probeOverRealPipeline({ kind: "all", privateCandidatesAttested: true })
      .probe({ kind: "application", id: 100, requiresUnredacted: false });
    assert.deepEqual(verdict, { state: "visible", redacted: false });
  });

  it("hides it from an unattested session that holds no private-capable role on the target's job", async () => {
    const verdict = await probeOverRealPipeline({ kind: "all", privateCapableJobIds: new Set([999]) })
      .probe({ kind: "application", id: 100, requiresUnredacted: false });
    assert.deepEqual(verdict, { state: "hidden" });
  });

  it("shows it when the unattested session holds a private-capable role on that job", async () => {
    const verdict = await probeOverRealPipeline({ kind: "all", privateCapableJobIds: new Set([200]) })
      .probe({ kind: "application", id: 100, requiresUnredacted: false });
    assert.deepEqual(verdict, { state: "visible", redacted: false },
      "Greenhouse itself grants private access on job 200; the fence must not deny what the org allowed");
  });
});
