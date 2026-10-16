import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GREENHOUSE_RECIPES, RECIPES_NOTE } from "../src/control-plane.js";

describe("read-only capability recipe registry", () => {
  it("advertises only well-formed, verified read recipes", () => {
    assert.ok(GREENHOUSE_RECIPES.length > 0);
    for (const recipe of GREENHOUSE_RECIPES) {
      assert.ok(recipe.id.length > 0, "recipe missing id");
      assert.ok(recipe.name.length > 0, `recipe ${recipe.id} missing name`);
      assert.ok(recipe.example_question.length > 0);
      assert.ok(recipe.summary.length > 0);
      assert.ok(recipe.required_tools.length > 0);
      assert.ok(
        recipe.required_tools.every((tool) => /^(list|get)_[a-z0-9_]+$/.test(tool)),
        `recipe ${recipe.id} references a non-read tool`
      );
      assert.equal(recipe.verification, "live_verified");
    }
  });

  it("documents recipe verification semantics", () => {
    assert.match(RECIPES_NOTE, /live_verified/);
    assert.match(RECIPES_NOTE, /shape_verified/);
  });
});
