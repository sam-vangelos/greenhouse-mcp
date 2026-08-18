import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildAnalysisCompleteness } from "../src/resolution/analysis-result.js";
import { createSignedArtifactSigner } from "../src/resolution/artifacts.js";
import { createDefaultResolverRegistry } from "../src/resolution/registry.js";
import { adaptJobScopeResolution } from "../src/resolvers/job-scope/adapter.js";
import { buildFixtureInventory, type JobScopeFixture } from "../src/resolvers/job-scope/inventory.js";
import { resolveJobScope, type ResolveJobScopeInput } from "../src/resolvers/job-scope/resolver.js";
import { createScopeSigner } from "../src/resolvers/job-scope/scope-handle.js";

const fixture = JSON.parse(
  readFileSync(resolve("test/fixtures/job-scope-resolution.fixture.json"), "utf8")
) as JobScopeFixture;
const signer = createScopeSigner("framework-secret-framework-secret-012345");
const NOW = Date.parse("2026-06-23T12:00:00.000Z");

describe("resolver framework contracts", () => {
  it("keeps runtime independent of src/tools/job-scope internals", () => {
    const runtimeSource = readFileSync(resolve("src/runtime.ts"), "utf8");
    assert.equal(runtimeSource.includes("./tools/job-scope/"), false);
    assert.match(runtimeSource, /ResolutionServices/);
  });

  it("registers only the implemented job_scope resolver", () => {
    const registry = createDefaultResolverRegistry();
    assert.deepEqual(registry.domains(), ["job_scope"]);
    assert.ok(registry.get("job_scope"));
    assert.equal(registry.get("source_normalization"), undefined);
    assert.equal(registry.get("stage_normalization"), undefined);
    assert.equal(registry.get("rejection_normalization"), undefined);
  });

  it("keeps resolver framework docs links resolvable", () => {
    const docsDir = resolve("docs/resolver-framework");
    for (const file of [
      "README.md",
      "adr.md",
      "implementation-plan.md",
      "contracts.md",
      "safety-invariants.md",
      "test-matrix.md",
    ]) {
      assert.equal(existsSync(resolve(docsDir, file)), true, `${file} exists`);
    }
  });
});

describe("analysis result completeness helpers", () => {
  it("marks truncated or excluded records as incomplete or partial", () => {
    assert.equal(buildAnalysisCompleteness({ recordsAnalyzed: 3 }).status, "complete");
    assert.equal(buildAnalysisCompleteness({ recordsAnalyzed: 3, anyPaginationTruncated: true }).status, "incomplete");
    assert.equal(buildAnalysisCompleteness({
      recordsAnalyzed: 3,
      exclusionReasons: [{ reason: "missing_job", count: 2 }],
    }).status, "partial");
  });
});

describe("generic signed artifacts", () => {
  it("rejects tampered, expired, cross-subject, and short-secret artifacts", () => {
    const artifactSigner = createSignedArtifactSigner("artifact-secret-artifact-secret-012345");
    const token = artifactSigner.signArtifact({
      kind: "framework_test",
      sub: "subject-a",
      exp: NOW + 60_000,
      value: "safe-metadata",
    });
    assert.equal(artifactSigner.verifyArtifact(token, "framework_test", { subject: "subject-a", nowMs: NOW }).ok, true);

    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
    assert.deepEqual(
      artifactSigner.verifyArtifact(tampered, "framework_test", { subject: "subject-a", nowMs: NOW }),
      { ok: false, reason: "invalid" }
    );
    assert.deepEqual(
      artifactSigner.verifyArtifact(token, "framework_test", { subject: "subject-b", nowMs: NOW }),
      { ok: false, reason: "forbidden" }
    );
    assert.deepEqual(
      artifactSigner.verifyArtifact(token, "framework_test", { subject: "subject-a", nowMs: NOW + 60_001 }),
      { ok: false, reason: "expired" }
    );
    assert.throws(() => createSignedArtifactSigner("short"), /at least 32/);
  });
});

describe("job-scope framework adapter", () => {
  it("maps resolved public job-scope output into ResolutionResult", () => {
    const output = resolveFixture("narrow_recruiter", {
      greenhouse_job_ids: [9001006],
      purpose: "scorecard_accountability",
    });
    const result = adaptJobScopeResolution(output, { nowMs: NOW, requestId: "req-1" });

    assert.equal(result.domain, "job_scope");
    assert.equal(result.status, "resolved");
    assert.equal(result.resolved.length, 1);
    assert.equal(result.resolved[0]?.greenhouse_job_id, 9001006);
    assert.equal(result.confidence.level, "high");
    assert.equal(result.confidence.method, "exact_id");
    assert.equal(result.completeness.status, "complete");
    assert.equal(result.metadata.resolver_domain, "job_scope");
    assert.equal(result.metadata.correlation_id, "req-1");
  });

  it("preserves no-match and incomplete inventory as unresolved evidence", () => {
    const noMatch = adaptJobScopeResolution(
      resolveFixture("narrow_recruiter", { query: "Nonexistent Launch Role" }),
      { nowMs: NOW }
    );
    assert.equal(noMatch.status, "unresolved");
    assert.equal(noMatch.resolved.length, 0);
    assert.equal(noMatch.unresolved_evidence[0]?.reason, "unknown");

    const incomplete = adaptJobScopeResolution(
      resolveFixture("narrow_recruiter", { query: "Senior Cloud Solutions Engineer" }, false),
      { nowMs: NOW }
    );
    assert.equal(incomplete.status, "incomplete");
    assert.equal(incomplete.completeness.status, "incomplete");
    assert.equal(incomplete.unresolved_evidence[0]?.reason, "incomplete_inventory");
  });

  it("preserves duplicate requisition ambiguity", () => {
    const ambiguous = adaptJobScopeResolution(
      resolveFixture("narrow_recruiter", { requisition_ids: ["DUP-1"] }),
      { nowMs: NOW }
    );
    assert.equal(ambiguous.status, "ambiguous");
    assert.equal(ambiguous.unresolved_evidence.some((entry) => entry.reason === "ambiguous_match"), true);
  });

  it("maps confirmation-required and fail-closed error outputs without claiming resolution", () => {
    const needsConfirmation = adaptJobScopeResolution(
      resolveFixture("site_admin", { query: "Senior Cloud Solutions Engineer" }),
      { nowMs: NOW }
    );
    assert.equal(needsConfirmation.status, "needs_confirmation");
    assert.equal(needsConfirmation.completeness.status, "complete");
    assert.equal(needsConfirmation.metadata.resolver_domain, "job_scope");

    // Owner filters are now an applied resolution path, but only when the async tool layer has
    // pre-resolved them into ctx.ownerScopedJobIds. The PURE resolver (called here without that
    // pre-resolution) must still FAIL CLOSED rather than silently broaden — the defensive floor.
    const error = adaptJobScopeResolution(
      resolveFixture("narrow_recruiter", {
        query: "Frontier Data",
        filters: { recruiter_user_ids: [7001001] },
      } as ResolveJobScopeInput),
      { nowMs: NOW }
    );
    assert.equal(error.status, "error");
    assert.equal(error.resolved.length, 0);
    assert.ok(error.metadata.warnings.some((warning) => /owner filter .* could not be resolved|not broadened to ignore it/.test(warning)));
  });

  it("maps a forbidden resolver status to a forbidden ResolutionResult with no resolved entities", () => {
    // The v1 resolver does not currently emit "forbidden", but the shared adapter
    // contract must map it without leaking resolved entities. Synthesize it over a
    // real fail-closed (error) output so the mapping branch is exercised directly.
    const base = resolveFixture("narrow_recruiter", {
      query: "Frontier Data",
      filters: { recruiter_user_ids: [7001001] },
    } as ResolveJobScopeInput);
    const forbidden = adaptJobScopeResolution({ ...base, resolution_status: "forbidden" }, { nowMs: NOW });
    assert.equal(forbidden.status, "forbidden");
    assert.equal(forbidden.resolved.length, 0);
    assert.equal(forbidden.metadata.resolver_domain, "job_scope");
  });

  it("surfaces unnormalizable inventory rows in framework completeness and unresolved evidence", () => {
    const load = buildFixtureInventory(fixture, "narrow_recruiter");
    assert.equal(load.ok, true);
    if (!load.ok) throw new Error("load failed");
    const output = resolveJobScope(
      { query: "Senior Cloud Solutions Engineer" },
      {
        inventory: {
          ...load.inventory,
          complete: false,
          estimated: null,
          rawRowsSeen: load.inventory.rawRowsSeen + 1,
          unnormalizableRows: 1,
        },
        subject: "user-1",
        signer,
        nowMs: NOW,
      }
    );
    const result = adaptJobScopeResolution(output, { nowMs: NOW });
    assert.equal(result.status, "incomplete");
    assert.equal(result.completeness.unnormalizable_records, 1);
    assert.equal(result.unresolved_evidence.some((entry) => entry.entity_type === "job_inventory_row"), true);
  });
});

function resolveFixture(
  personaId: string,
  input: ResolveJobScopeInput,
  complete = true
) {
  const load = buildFixtureInventory(fixture, personaId, { complete });
  assert.equal(load.ok, true);
  return resolveJobScope(input, {
    inventory: load.inventory,
    subject: "user-1",
    signer,
    nowMs: NOW,
  });
}
