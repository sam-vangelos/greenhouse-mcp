import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildEvidencePack } from "../src/tools/evidence-pack.js";

describe("analysis evidence packs", () => {
  it("returns capped scoped record references and drops unsafe evidence-like strings", () => {
    const pack = buildEvidencePack(
      { evidence_pack: true, evidence_pack_limit: 3 },
      [{
        name: "rankings",
        rows: [
          { evidence_ids: ["application:10", "application_stage:11", "candidate:20", "not-an-id", "candidate:20"] },
          { evidence_ids: ["scorecard:30", "candidate:recruiter@example.com", "job:40"] },
        ],
      }]
    );

    assert.ok(pack);
    assert.deepStrictEqual(pack.ids, ["application:10", "application_stage:11", "candidate:20"]);
    assert.equal(pack.total_ids, 5);
    assert.equal(pack.returned_ids, 3);
    assert.equal(pack.truncated, true);
    assert.deepStrictEqual(Object.keys(pack.by_type).sort(), ["application", "application_stage", "candidate", "job", "scorecard"]);
    assert.equal(pack.by_type.application_stage.total_ids, 1);
    assert.equal(pack.by_type.candidate.total_ids, 1);
    assert.match(pack.content_policy, /does not include candidate names/);
  });

  it("drops syntactically valid but unsupported record reference types", () => {
    const pack = buildEvidencePack(
      { evidence_pack: true },
      [{
        name: "rankings",
        rows: [{
          evidence_ids: [
            "application:10",
            "application_stage:11",
            "candidate:20",
            "job:30",
            "note:40",
            "scorecard:50",
            "user:60",
            "department:70",
            "offer:80",
            "custom_field:90",
          ],
        }],
      }]
    );

    assert.ok(pack);
    assert.deepStrictEqual(pack.ids, ["application:10", "application_stage:11", "candidate:20", "job:30", "note:40", "scorecard:50"]);
    assert.deepStrictEqual(Object.keys(pack.by_type).sort(), ["application", "application_stage", "candidate", "job", "note", "scorecard"]);
    assert.equal(pack.total_ids, 6);
    assert.equal(pack.returned_ids, 6);
    assert.equal(pack.truncated, false);
    assert.doesNotMatch(JSON.stringify(pack), /user:60|department:70|offer:80|custom_field:90/);
  });

  it("is absent unless explicitly requested", () => {
    assert.equal(buildEvidencePack({}, [{ name: "rankings", rows: [{ evidence_ids: ["application:10"] }] }]), undefined);
  });
});
