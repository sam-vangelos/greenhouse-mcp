import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  CANONICAL_SUPABASE_PROJECT_REF,
  CANONICAL_SUPABASE_REST_ORIGIN,
  KNOWN_WRONG_SUPABASE_PROJECTS_ENV,
  assertCanonicalSupabaseProjectRef,
  extractSupabaseProjectRef,
} from "../src/supabase-config.js";

const CANONICAL = "https://exampleprojectref000.supabase.co";
const ANALYTICS = "https://otherprojectref00000.supabase.co";

describe("canonical Supabase project ref enforcement", () => {
  it("exposes the canonical project constants", () => {
    assert.equal(CANONICAL_SUPABASE_PROJECT_REF, "exampleprojectref000");
    assert.equal(CANONICAL_SUPABASE_REST_ORIGIN, CANONICAL);
  });

  it("extracts the project ref from a Supabase REST origin", () => {
    assert.equal(extractSupabaseProjectRef(CANONICAL), "exampleprojectref000");
    assert.equal(extractSupabaseProjectRef(ANALYTICS), "otherprojectref00000");
    assert.equal(extractSupabaseProjectRef("https://example.supabase.co"), "example");
  });

  it("returns undefined for hosts that are not Supabase project origins", () => {
    assert.equal(extractSupabaseProjectRef("https://evil.example.com"), undefined);
    // a suffix attack: canonical ref as a label but not the real supabase.co project host
    assert.equal(extractSupabaseProjectRef("https://exampleprojectref000.supabase.co.evil.com"), undefined);
    assert.equal(extractSupabaseProjectRef("not-a-url"), undefined);
  });

  it("accepts the canonical project URL and returns its normalized origin", () => {
    assert.equal(assertCanonicalSupabaseProjectRef(CANONICAL, "Supabase identity directory"), CANONICAL);
  });

  it("rejects a configured sibling project by name", () => {
    const previous = process.env[KNOWN_WRONG_SUPABASE_PROJECTS_ENV];
    process.env[KNOWN_WRONG_SUPABASE_PROJECTS_ENV] = "otherprojectref00000=recruiting-analytics";
    try {
      assert.throws(
        () => assertCanonicalSupabaseProjectRef(ANALYTICS, "Supabase identity directory"),
        (error: unknown) => {
          const message = (error as Error).message;
          assert.match(message, /the recruiting-analytics project/);
          assert.match(message, /otherprojectref00000/);
          assert.match(message, /exampleprojectref000/);
          assert.match(message, /GREENHOUSE_MCP_SUPABASE_PROJECT_REF/);
          return true;
        },
      );
    } finally {
      if (previous === undefined) delete process.env[KNOWN_WRONG_SUPABASE_PROJECTS_ENV];
      else process.env[KNOWN_WRONG_SUPABASE_PROJECTS_ENV] = previous;
    }
  });

  it("takes the canonical project ref from the environment when set", () => {
    const moduleUrl = new URL("../src/supabase-config.ts", import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", `const m = await import(${JSON.stringify(moduleUrl)}); console.log(m.CANONICAL_SUPABASE_REST_ORIGIN);`],
      { encoding: "utf8", env: { ...process.env, GREENHOUSE_MCP_SUPABASE_PROJECT_REF: "deployedref000000000" } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "https://deployedref000000000.supabase.co");
  });

  it("rejects any other Supabase project ref", () => {
    assert.throws(
      () => assertCanonicalSupabaseProjectRef("https://someotherproject.supabase.co", "Supabase session revocation"),
      /must point at the canonical Greenhouse MCP Supabase project/,
    );
  });

  it("rejects a non-Supabase host that has no recognizable project ref", () => {
    assert.throws(
      () => assertCanonicalSupabaseProjectRef("https://identity.internal.acme.com", "Supabase identity directory"),
      /no recognizable Supabase project ref/,
    );
  });

  it("surfaces the URL shape error first for a malformed URL (ref check never reached)", () => {
    // normalizeSupabaseRestOrigin runs before the ref check, so a path / whitespace / non-HTTPS URL
    // reports the shape error — this is why the bare normalizer stays usable as the test seam.
    assert.throws(() => assertCanonicalSupabaseProjectRef(`${CANONICAL}/rest/v1`, "X"), /valid HTTPS origin/);
    assert.throws(() => assertCanonicalSupabaseProjectRef(` ${CANONICAL} `, "X"), /whitespace/);
    assert.throws(() => assertCanonicalSupabaseProjectRef("http://exampleprojectref000.supabase.co", "X"), /valid HTTPS origin/);
  });
});
