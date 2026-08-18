import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRecruiterVisibilityProbe } from "../src/action-visibility.js";
import { _resetPrivateCustomFieldCache } from "../src/private-custom-fields.js";
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
          first_name: "Priya",
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
