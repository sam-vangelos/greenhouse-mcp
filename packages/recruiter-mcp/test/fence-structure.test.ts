import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The fence's structural assertions — Phase 2c Slice 5.
 *
 * The per-capability tests prove the fence denies when a probe says hidden. What they cannot prove
 * is COVERAGE: that every Greenhouse resource a mutation reads is either fenced or consciously
 * exempted. That is exactly how the job-note hole survived two spec drafts — the invariant was
 * argued about in prose while a prepare quietly read a resource nobody had listed. These checks make
 * the inventory mechanical: a new action, a new read, or a moved gate fails here until someone
 * decides what it means.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ACTIONS_DIR = join(HERE, "../../action-mcp/src/actions");
const ACTION_SRC = join(HERE, "../../action-mcp/src");
const SCOPED_INDEX = join(HERE, "../../scoped-core/src/index.ts");

function listPaths(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...new Set([...source.matchAll(/greenhouse\.list\("([^"]+)"/g)].map((m) => m[1]!))].sort();
}

/**
 * Exactly what each source file reads from Greenhouse. Hand-maintained ON PURPOSE: when a prepare
 * gains a read, this table goes stale and the equality assertion below fails — which is the moment
 * someone must classify the new path as fenced or exempt, in writing, before the suite goes green.
 */
const EXPECTED_READS: Readonly<Record<string, readonly string[]>> = {
  "application-assignment.ts": ["/users"],
  "application-attribution.ts": ["/referrers", "/sources"],
  "application-rejection.ts": ["/notes", "/rejection_details", "/rejection_reasons"],
  "application-stage-move.ts": ["/job_interview_stages"],
  "application-unreject.ts": ["/application_stages"],
  "candidate-note-create.ts": ["/notes"],
  "candidate-record-update.ts": ["/candidates"],
  "index.ts": [],
  "job-note-change.ts": ["/job_notes"],
  "job-owner.ts": ["/job_owners", "/users"],
  "offer-create.ts": [],
  "offer-shared.ts": ["/offers"],
  "offer-update.ts": [],
  "shared.ts": ["/application_stages", "/applications", "/jobs", "/user_job_permissions", "/users"],
  "types.ts": [],
};

/**
 * Every path above is either COVERED by a fence-target kind whose probe governs it, or EXEMPT with
 * the written reason. An entry here is a decision; a path missing from both is a defect.
 */
const PATH_DISPOSITION: Readonly<Record<string, { coveredBy?: string; exempt?: string }>> = {
  "/applications": { coveredBy: "application — probed via get_application, which runs the private-candidate gate" },
  "/candidates": { coveredBy: "candidate — probed via get_candidate; redaction observed via the projected row" },
  "/offers": { coveredBy: "offer — probed via list_offers with ids; offer_create reads only baseline ids into its approval" },
  "/job_notes": { coveredBy: "job_note — probed via list_job_notes with ids on update/delete; create discloses only identical-note counts and fingerprints" },
  "/job_owners": { exempt: "rows carry no redacted field (§4.4); the job fence target governs the parent" },
  "/application_stages": { exempt: "rows keyed to the fenced application; the application probe's privacy verdict governs them transitively" },
  "/rejection_details": { exempt: "keyed to the fenced application; same transitive coverage" },
  "/notes": { exempt: "keyed to the fenced application; the approval discloses identical-note ids and counts, never bodies of other notes" },
  "/users": { exempt: "org user dictionary — names and active flags, no candidate substance" },
  "/jobs": { exempt: "id + confidential existence read inside assertJobAccess; job-targeted actions also carry a job fence target" },
  "/user_job_permissions": { exempt: "the authorization lookup itself" },
  "/job_interview_stages": { exempt: "pipeline-structure dictionary for a job the actor already holds through assertJobAccess" },
  "/rejection_reasons": { exempt: "org dictionary" },
  "/sources": { exempt: "org dictionary" },
  "/referrers": { exempt: "org dictionary" },
  "/custom_fields": { exempt: "schema dictionary — definitions and privacy flags, never values" },
  "/custom_field_options": { exempt: "schema dictionary" },
};

describe("fence structure (Phase 2c Slice 5)", () => {
  it("(a) every resource a mutation reads has a fence disposition, and the inventory cannot drift silently", () => {
    const files = readdirSync(ACTIONS_DIR).filter((file) => file.endsWith(".ts")).sort();
    assert.deepEqual(files, Object.keys(EXPECTED_READS).sort(),
      "an action file appeared or vanished — extend EXPECTED_READS with its reads and classify them");

    for (const file of files) {
      const discovered = listPaths(join(ACTIONS_DIR, file));
      assert.deepEqual(discovered, [...EXPECTED_READS[file]!].sort(),
        `${file} reads a different set of Greenhouse resources than recorded — classify the change ` +
        `in PATH_DISPOSITION before going green`);
      for (const path of discovered) {
        const disposition = PATH_DISPOSITION[path];
        assert.ok(disposition && (disposition.coveredBy || disposition.exempt),
          `${file} reads ${path}, which has neither a fence target covering it nor a written exemption`);
      }
    }

    // custom-fields.ts sits outside actions/ but is read by four prepares; same rule.
    for (const path of listPaths(join(ACTION_SRC, "custom-fields.ts"))) {
      assert.ok(PATH_DISPOSITION[path], `custom-fields.ts reads ${path} with no disposition`);
    }
  });

  it("(b) get_application gates candidate privacy, which is what lets the application probe cover it", () => {
    // The fence's application target relies on this: §4.4 drops a separate candidate target from
    // application-shaped actions BECAUSE get_application runs the private-candidate gate. If it ever
    // leaves CANDIDATE_SUBSTANCE_TOOLS, that reasoning is void and this fails until someone re-decides.
    const source = readFileSync(SCOPED_INDEX, "utf8");
    const block = source.match(/CANDIDATE_SUBSTANCE_TOOLS[^=]*=\s*new Set\(\[[\s\S]*?\]\)/)?.[0];
    assert.ok(block, "CANDIDATE_SUBSTANCE_TOOLS not found in scoped-greenhouse");
    assert.match(block!, /"get_application"/,
      "get_application must be privacy-gated for the fence's application probe to cover candidate privacy");
  });

  it("(c) there is exactly ONE mutation call site, so the fence cannot be bypassed by a second door", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else if (entry.name.endsWith(".ts")) files.push(join(dir, entry.name));
      }
    };
    walk(ACTION_SRC);
    const sites: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/\.mutate\(/g)) {
        // Skip type signatures (interface members) and comments — only real call sites count.
        const lineStart = source.lastIndexOf("\n", match.index!) + 1;
        const line = source.slice(lineStart, source.indexOf("\n", match.index!));
        if (/^\s*mutate\(/.test(line) || /^\s*(\*|\/\/)/.test(line)) continue;
        sites.push(`${file.split("/").slice(-2).join("/")}: ${line.trim()}`);
      }
    }
    assert.equal(sites.length, 1,
      `expected exactly one gateway.mutate() call site (service.ts); found: ${JSON.stringify(sites)}`);
    assert.match(sites[0]!, /service\.ts/);
  });
});
