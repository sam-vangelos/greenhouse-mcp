import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { referenceName } from "../src/tools/reference-names.js";

// F2: a reference id used in the data but absent from the (complete) reference list —
// an archived/global id like rejection reason 4999999004 (a majority class on some requisitions) —
// used to collapse to a bare number / null in a join. It must render an honest label.
describe("referenceName — honest labels for unresolved reference ids (F2)", () => {
  const names = new Map<number, string>([[5, "LinkedIn"]]);

  it("resolves a known id to its name", () => {
    assert.equal(referenceName(names, 5, "source"), "LinkedIn");
  });

  it("labels an id absent from the reference set honestly, never a bare id or silent null", () => {
    assert.equal(referenceName(names, 4999999004, "reason"), "reason 4999999004 (name unavailable)");
    assert.equal(referenceName(names, 999, "source"), "source 999 (name unavailable)");
  });

  it("returns null only when there is no id at all", () => {
    assert.equal(referenceName(names, null, "source"), null);
    assert.equal(referenceName(names, undefined, "source"), null);
    assert.equal(referenceName(names, "not-a-number", "source"), null);
  });
});
