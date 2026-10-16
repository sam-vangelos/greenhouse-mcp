import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as client from "../src/client.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const legacyModules = [
  "admin-control-plane",
  "admin-plane",
  "admin-snapshot-store",
  "control-plane-types",
  "record-plane",
  "register-admin-tools",
  "write-ops",
];
const legacyClientExports = [
  "apiPost",
  "apiPatch",
  "apiDelete",
  "adminApiGet",
  "adminApiPost",
  "adminApiPatch",
  "adminApiDelete",
  "configureAdminAdapter",
];
const legacyTools = [
  "add_job_coordinator_owner",
  "add_job_recruiter_owner",
  "apply_job_workflow_patch",
  "apply_scorecard_pack_patch",
  "apply_source_catalog_patch",
  "create_offer_draft",
  "create_standing_query",
  "deprecate_offer_draft",
  "move_application_to_stage",
  "patch_application_metadata",
  "patch_candidate_contact",
  "patch_candidate_custom_fields",
  "patch_candidate_profile",
  "patch_offer_compensation",
  "patch_offer_core",
  "patch_offer_custom_fields",
  "patch_opening_metadata",
  "preview_job_workflow_patch",
  "preview_scorecard_pack_patch",
  "preview_source_catalog_patch",
  "reject_application",
  "remove_job_coordinator_owner",
  "remove_job_recruiter_owner",
  "restore_job_configuration_snapshot",
  "set_offer_draft_opening",
  "snapshot_job_configuration",
  "update_application_assignment",
  "upsert_application_note",
  "upsert_job_note",
  "upsert_offer_review_note",
];

describe("base Greenhouse MCP read-only boundary", () => {
  it("does not ship the retired legacy write/admin modules", () => {
    for (const moduleName of legacyModules) {
      assert.equal(
        existsSync(`${packageRoot}/src/${moduleName}.ts`),
        false,
        `${moduleName}.ts must remain retired`
      );
    }
  });

  it("does not export a mutation or admin client primitive", () => {
    for (const exportName of legacyClientExports) {
      assert.equal(exportName in client, false, `${exportName} must not be importable`);
    }
  });

  it("registers no legacy write/admin tool", () => {
    const indexSource = readFileSync(`${packageRoot}/src/index.ts`, "utf8");
    for (const name of legacyTools) {
      assert.doesNotMatch(indexSource, new RegExp(`registerTool\\(\\s*[\"']${name}[\"']`));
    }
  });
});
