import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_SUPABASE_PROJECT_REF,
  CANONICAL_SUPABASE_REST_ORIGIN,
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

  it("rejects the recruiting-ops-analytics project by name", () => {
    assert.throws(
      () => assertCanonicalSupabaseProjectRef(ANALYTICS, "Supabase identity directory"),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /recruiting-ops-analytics/);
        assert.match(message, /otherprojectref00000/);
        assert.match(message, /exampleprojectref000/);
        return true;
      },
    );
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
