import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ACTION_DEFINITIONS, readActionRuntimeFlags } from "../../action-mcp/dist/index.js";
import { classifyDistributionCatalog, validateRemoteToolCatalog } from "../src/distribution-validation.js";
import { EXPECTED_CATALOG_TOOL_COUNTS, catalogToolNamesHash } from "../src/desktop-user-test.js";
import { PILOT_TOOL_NAMES } from "../src/tools/register.js";

/**
 * CLO-401 made two action kinds opt-in, so the write-entitled catalog a default deployment serves is
 * no longer "every ACTION_DEFINITIONS pair". `mountActionPlane` grants only the kinds in
 * `catalogCapabilities` (action-plane.ts), whose default excludes the interview kinds. The release
 * tooling (distribution validator, rollout gate, desktop evidence, container self-check) must hold a
 * deployment to that same catalog, or a correct, unchanged production deployment fails its own gate.
 */

const DEFAULT_KINDS = readActionRuntimeFlags({}).catalogCapabilities;
const DEFAULT_ACTION_TOOLS = ACTION_DEFINITIONS
  .filter((definition) => DEFAULT_KINDS.has(definition.kind))
  .flatMap((definition) => [definition.previewTool, definition.applyTool]);
const ALL_ACTION_TOOLS = ACTION_DEFINITIONS.flatMap((definition) => [definition.previewTool, definition.applyTool]);

describe("CLO-401: the write-entitled catalog is the default-on action catalog", () => {
  it("the default-on action catalog is the 22 non-interview tools", () => {
    assert.equal(DEFAULT_ACTION_TOOLS.length, 22);
    assert.equal(DEFAULT_ACTION_TOOLS.some((name) => name.includes("interview")), false);
  });

  it("classifies a default production write-entitled catalog as write_entitled and passes validation", () => {
    const served = [...PILOT_TOOL_NAMES, ...DEFAULT_ACTION_TOOLS];
    const classified = classifyDistributionCatalog(served);
    assert.equal(classified.variant, "write_entitled");
    assert.deepEqual(classified.expected, served);
    for (const check of validateRemoteToolCatalog(served)) assert.equal(check.status, "pass", check.name);
  });

  it("does not treat a catalog carrying the opt-in interview tools as the default write-entitled one", () => {
    // Enabling the interview kinds is an explicit env change; the release gate's canonical catalog
    // has to be widened in the same change, not silently adopt whatever the deployment served.
    const withOptIn = [...PILOT_TOOL_NAMES, ...ALL_ACTION_TOOLS];
    assert.equal(classifyDistributionCatalog(withOptIn).variant, "read_only");
  });

  it("desktop evidence expects the default-on count and the default-on ordered-name hash", () => {
    assert.equal(EXPECTED_CATALOG_TOOL_COUNTS.write_entitled_full_catalog, PILOT_TOOL_NAMES.length + 22);
    const served = [...PILOT_TOOL_NAMES, ...DEFAULT_ACTION_TOOLS];
    assert.equal(
      catalogToolNamesHash("write_entitled_full_catalog"),
      createHash("sha256").update(served.join("\n")).digest("hex"),
    );
  });

  it("the container self-check reports the action tool count production serves", async () => {
    const { runContainerSelfCheck } = await import("../src/container-self-check.js");
    const result = await runContainerSelfCheck({} as NodeJS.ProcessEnv);
    assert.equal(result.ok, true);
    assert.equal(result.actionToolCount, 22);
    assert.equal(result.entitledCatalogToolCount, (result.catalogToolCount as number) + 22);
  });
});
