import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ACTION_DEFINITIONS } from "../src/actions/index.js";
import { GreenhouseActionService } from "../src/service.js";
import { MemoryActionStore, TEST_SECRET, TestClock, allowAllVisibility, assignmentGreenhouse, testSession } from "./helpers.js";

/**
 * A delta a human cannot check is not an approval.
 *
 * Every approval payload identifies its target by bare integer. "Application 100 -> Onsite" is not
 * something a recruiter can verify; "Priya Raman, Staff Forward Deployed AI Engineer - India ->
 * Onsite" is. That matters twice over here: preview is also serving as the tenant-shape probe, so a
 * human reads every first-use delta; and an injected instruction that swaps the target id produces a
 * mutation that looks locally correct while naming someone else entirely — a wrong NAME is visible
 * where a wrong number is not.
 */

function fixture() {
  const clock = new TestClock();
  const { greenhouse, state } = assignmentGreenhouse();
  const service = new GreenhouseActionService({
    session: testSession(),
    store: new MemoryActionStore(clock),
    greenhouse,
    signingSecret: TEST_SECRET,
    visibility: allowAllVisibility(),
    writesEnabled: true,
    production: false,
    clock,
  });
  return { service, greenhouse, state };
}

describe("preview legibility", () => {
  test("names the candidate and the job, not just their ids", async () => {
    const { service } = fixture();
    const preview = await service.preview("application_stage_move", {
      application_id: 100,
      to_stage_id: 602,
    });
    assert.equal(preview.status, "ready", "a real move, not the no_change path");

    const subject = preview.subject as Record<string, unknown> | undefined;
    assert.ok(subject, "the preview must carry a subject block");
    assert.equal(subject.candidate, "Priya Raman", "the human must see WHO this delta is about");
    assert.equal(
      subject.job,
      "Staff Forward Deployed AI Engineer - India",
      "and which req, since a recruiter holds many"
    );
  });

  test("puts the subject FIRST, so who-it-is-about is read before what-changes", async () => {
    const { service } = fixture();
    const preview = await service.preview("application_stage_move", { application_id: 100, to_stage_id: 602 });
    assert.equal(Object.keys(preview).indexOf("subject") >= 0, true);
    const keys = Object.keys(preview);
    assert.ok(
      keys.indexOf("subject") < keys.indexOf("approval"),
      "a delta rendered top-down must lead with the person"
    );
  });

  test("does NOT put labels in the approval, so a rename cannot false-fail the apply", async () => {
    const { service } = fixture();
    const preview = await service.preview("application_stage_move", { application_id: 100, to_stage_id: 602 });
    const approval = preview.approval as Record<string, unknown>;
    assert.equal(
      "subject" in approval,
      false,
      "the approval is fingerprinted and re-derived on apply; a candidate renamed in between would " +
        "throw STATE_CHANGED even though nothing about the mutation changed"
    );
  });

  test("says so out loud when a name cannot be resolved, rather than omitting it", async () => {
    const { service, greenhouse } = fixture();
    // A label read that fails must not fail the preview: labels are legibility, not authorization,
    // and every real gate has already run. But silence would let the human assume there was no name.
    greenhouse.onList("/candidates", () => {
      throw new Error("candidates unavailable");
    });
    const preview = await service.preview("application_stage_move", { application_id: 100, to_stage_id: 602 });
    const subject = preview.subject as Record<string, unknown>;
    assert.equal(preview.status, "ready", "a label outage must never block the mutation path");
    assert.equal(subject.candidate, "(name unavailable)");
    assert.equal(subject.job, "Staff Forward Deployed AI Engineer - India", "the other label still resolves");
  });

  test("every capability that has a candidate names one", async () => {
    // The population, not one sample. An action whose preview omits the subject is one whose approval
    // a human cannot check, and there is no capability here without at least a job.
    const { service } = fixture();
    const inputs: Partial<Record<string, Record<string, unknown>>> = {
      application_stage_move: { application_id: 100, to_stage_id: 602 },
      application_assignment_change: { application_id: 100, assignment_role: "recruiter", proposed_user_id: 40 },
    };
    for (const definition of ACTION_DEFINITIONS) {
      const input = inputs[definition.kind];
      if (!input) continue;
      const preview = await service.preview(definition.kind, input);
      const subject = preview.subject as Record<string, unknown> | undefined;
      assert.ok(subject?.candidate, `${definition.previewTool} must name its candidate`);
      assert.ok(subject?.job, `${definition.previewTool} must name its job`);
    }
  });
});
