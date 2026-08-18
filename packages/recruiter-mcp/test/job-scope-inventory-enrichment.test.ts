import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFixtureInventory, loadScopedReaderInventory, type JobScopeFixture } from "../src/resolvers/job-scope/inventory.js";
import { resolveJobScope, type ResolveJobScopeInput } from "../src/resolvers/job-scope/resolver.js";
import { createScopeSigner } from "../src/resolvers/job-scope/scope-handle.js";
import { fakeScopedReader, scopedSuccess, testRuntime } from "./test-helpers.js";

// Live-pilot finding #4 + exploration (2026-07-02): v3 /jobs rows carry only bare office_ids /
// department_id, so the embedded-object reads resolved to NULL on live data — location filtering
// effectively ran on title text alone, and "FDE roles in NY" missed a req POSTED to New York
// whose only tag was USA. The inventory now JOINS the offices/departments dictionaries and
// job-post targeting (job_posts + job_post_locations, field `plain_text_location`) into
// multi-valued records, and degrades DISCLOSED (never silently narrower) when a join read fails.

function enrichedReader(overrides: Partial<Record<string, () => ReturnType<typeof scopedSuccess>>> = {}) {
  return fakeScopedReader((toolName) => {
    const override = overrides[toolName];
    if (override) return override();
    switch (toolName) {
      case "list_jobs":
        return scopedSuccess(toolName, [
          {
            id: 1,
            name: "Forward Deployed Engineer - US",
            status: "open",
            requisition_id: "REQ-1",
            office_ids: [20, 30],
            department_id: 5,
          },
          { id: 2, name: "Data Analyst", status: "open", requisition_id: "REQ-2", office_ids: [30], department_id: null },
        ]);
      case "list_offices":
        return scopedSuccess(toolName, [
          { id: 20, name: "USA", location: "United States" },
          { id: 30, name: "Remote Hub", location: "Austin, TX, USA" },
        ]);
      case "list_departments":
        return scopedSuccess(toolName, [{ id: 5, name: "Engineering" }]);
      case "list_job_posts":
        return scopedSuccess(toolName, [
          { id: 11, job_id: 1, title: "AI Engineer (NYC)" },
          { id: 12, job_id: 2, title: "Data Analyst" }, // same as internal title -> no new signal
        ]);
      case "list_job_post_locations":
        return scopedSuccess(toolName, [
          { id: 99, job_post_id: 11, plain_text_location: "New York, NY" },
        ]);
      default:
        throw new Error(`unexpected scoped tool ${toolName}`);
    }
  });
}

describe("job inventory enrichment (dictionaries + job-post targeting)", () => {
  it("joins office/department dictionaries and job posts into multi-valued records", async () => {
    const reader = enrichedReader();
    const { runtime } = testRuntime(reader);
    const load = await loadScopedReaderInventory(runtime);
    assert.equal(load.ok, true);
    if (!load.ok) throw new Error("load failed");

    const fde = load.inventory.records.find((record) => record.greenhouse_job_id === 1)!;
    assert.deepStrictEqual(fde.offices, ["USA", "Remote Hub"], "ALL offices resolve via the dictionary, not just the first");
    assert.deepStrictEqual(fde.departments, ["Engineering"]);
    assert.ok(fde.locations.includes("United States") && fde.locations.includes("Austin, TX, USA"), "every office's location is carried");
    assert.ok(fde.locations.includes("New York, NY"), "job-post targeting locations join in (the NY fix)");
    assert.ok(fde.posted_titles.includes("AI Engineer (NYC)"), "external post titles are carried");
    assert.equal(fde.office, "USA", "singular fields stay as first-element aliases for compat");
    assert.equal(fde.department, "Engineering");
    assert.ok(fde.normalized_text.includes("nyc"), "posted titles are searchable");
    assert.ok(fde.normalized_text.includes("new york"), "posted locations are searchable");
    assert.deepStrictEqual(load.inventory.enrichmentIncomplete, [], "full enrichment reports no gaps");
  });

  it("a failing join read degrades DISCLOSED: records still build, the gap is named", async () => {
    const reader = enrichedReader({
      list_job_posts: () => {
        throw new Error("upstream blew up");
      },
    });
    const { runtime } = testRuntime(reader);
    const load = await loadScopedReaderInventory(runtime);
    assert.equal(load.ok, true, "an enrichment failure must never fail the whole inventory");
    if (!load.ok) throw new Error("load failed");
    const fde = load.inventory.records.find((record) => record.greenhouse_job_id === 1)!;
    assert.deepStrictEqual(fde.offices, ["USA", "Remote Hub"], "dictionary joins that succeeded still apply");
    assert.deepStrictEqual(fde.posted_titles, [], "the failed signal is absent, not fabricated");
    assert.ok(load.inventory.enrichmentIncomplete.includes("job_posts"), "the gap is named for downstream disclosure");
  });
});

describe("multi-signal location filtering (resolver over enriched records)", () => {
  const FIXTURE: JobScopeFixture = {
    personas: [
      { id: "admin", greenhouse_user_id: 900, permission_scope_kind: "all", accessible_job_ids: "all", can_view_confidential: true },
    ],
    jobs: [
      {
        greenhouse_job_id: 1,
        requisition_id: "REQ-1",
        title: "Principal Forward Deployed AI Engineer, NY",
        status: "open",
        department: "Engineering",
        office: "New York",
        location: "New York, NY",
        opened_at: "2026-03-02T00:00:00.000Z",
        closed_at: null,
      },
      {
        greenhouse_job_id: 2,
        requisition_id: "REQ-2",
        title: "Forward Deployed Engineer - US",
        status: "open",
        department: "Engineering",
        office: "USA",
        location: "United States",
        opened_at: "2026-02-24T00:00:00.000Z",
        closed_at: null,
        // The live shape of the NY miss: tag says USA, the JOB POST targets New York.
        locations: ["United States", "New York, NY"],
        posted_titles: ["Forward Deployed Engineer (New York)"],
      },
    ],
  };
  const signer = createScopeSigner("test-secret-test-secret-test-secret-0123");
  const NOW = Date.parse("2026-07-02T12:00:00.000Z");

  async function resolveWith(input: ResolveJobScopeInput) {
    const load = buildFixtureInventory(FIXTURE, "admin");
    assert.equal(load.ok, true);
    if (!load.ok) throw new Error("fixture load failed");
    return resolveJobScope(input, { inventory: load.inventory, subject: "email:admin", signer, nowMs: NOW });
  }

  it('a "New York" location filter matches the job POSTED to NY whose tag says USA', async () => {
    const output = await resolveWith({
      query: "forward deployed engineer",
      filters: { locations: ["New York"] },
    } as ResolveJobScopeInput);
    const matchedIds = output.scope.job_ids;
    assert.ok(matchedIds.includes(1), "the NY-tagged req matches");
    assert.ok(matchedIds.includes(2), "the posted-to-NY req matches too — the live miss this class fix exists for");
  });

  it("the location disclosure reflects the union when enrichment is complete", async () => {
    const output = await resolveWith({
      query: "forward deployed engineer",
      filters: { locations: ["New York"] },
    } as ResolveJobScopeInput);
    assert.ok(
      output.warnings.some((w) => /job-post targeting/.test(w) && !/TAGS only/.test(w)),
      "complete enrichment discloses union matching, not the degraded tag-only warning"
    );
  });
});

// Slice 5 re-scoped on the live probe (2026-07-02): the custom-field dept/office DICTIONARIES are
// offer-letter scoping config at this tenant (N/A for job taxonomy) — but the job rows' OWN
// custom_fields carry the vocabulary recruiters query by: Hiring Location(s) (an explicit per-job
// location signal), Job Level (IC5), Priority (P0), Cost Center, Employment Type. Ingest VALUES
// only from select/short-text/multi-select fields; long_text stays out (free text — hygiene).
describe("job custom-field ingestion (values into matching signals)", () => {
  it("Hiring Location(s) feeds locations[]; select/short-text values are searchable; long_text and nulls stay out", async () => {
    const reader = fakeScopedReader((toolName) => {
      if (toolName !== "list_jobs") throw new Error(`enrichment reads degrade: ${toolName}`);
      return scopedSuccess(toolName, [
        {
          id: 7,
          name: "Forward Deployed Engineer - India",
          status: "open",
          requisition_id: "REQ-7",
          custom_fields: {
            "hiring_location_s__job_175": { name: "Hiring Location(s)", type: "multi_select", value: ["India", "Brazil"] },
            job_level: { name: "Job Level", type: "single_select", value: "IC5" },
            priority: { name: "Priority", type: "multi_select", value: ["P0"] },
            cost_center: { name: "Cost Center", type: "single_select", value: "Delivery Engineering" },
            business_unit: { name: "Business Unit", type: "single_select", value: null },
            justification_for_hiring_this_role: {
              name: "Justification for hiring this role",
              type: "long_text",
              value: "CONFIDENTIAL-FREETEXT-MUST-NOT-INDEX",
            },
            paused: { name: "Paused", type: "boolean", value: false },
          },
        },
      ]);
    });
    const { runtime } = testRuntime(reader);
    const load = await loadScopedReaderInventory(runtime);
    assert.equal(load.ok, true);
    if (!load.ok) throw new Error("load failed");
    const record = load.inventory.records[0]!;
    assert.ok(record.locations.includes("India") && record.locations.includes("Brazil"), "Hiring Location(s) is a location signal");
    assert.ok(record.normalized_text.includes("ic5"), "Job Level is searchable");
    assert.ok(record.normalized_text.includes("p0"), "Priority is searchable");
    assert.ok(record.normalized_text.includes("delivery engineering"), "Cost Center is searchable");
    assert.equal(record.normalized_text.includes("confidential freetext"), false, "long_text values NEVER enter the index");
    assert.equal(record.normalized_text.includes("false"), false, "boolean/null values are not tokens");
  });
});
