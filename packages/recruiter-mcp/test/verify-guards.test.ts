import { describe, it } from "node:test";
import assert from "node:assert/strict";

// verify-guards.mjs is an un-typed build script (no .d.ts is ever emitted for it), so a static
// import — or a dynamic import of a string LITERAL — trips TS7016 under this package's strict
// tsconfig. A non-literal specifier is resolved only at runtime (tsx loads the real module), so
// tsc leaves it `any` and we cast to the typed view.
//
// These tests drive the REAL scanner collectors (collectWriteHelperHits /
// collectRawClientImportHits) over fixture files, NOT a bare `PATTERN.test(string)`. That locks
// the guard's ENFORCEMENT: neutering the scan body (e.g. `if (false)` or emptying the loop)
// fails these, whereas a regex-only test would stay green while the guard stopped guarding.
const guardModuleSpecifier = "../scripts/verify-guards.mjs";
const { collectWriteHelperHits, collectRawClientImportHits } = (await import(
  guardModuleSpecifier
)) as {
  collectWriteHelperHits: (files: Array<{ file: string; content: string }>) => string[];
  collectRawClientImportHits: (
    files: Array<{ file: string; content: string }>,
    readerChokepointPath: string,
  ) => string[];
};

const READER = "/pkg/src/scoped-reader.ts";
const file = (content: string, path = "/pkg/src/some-tool.ts") => [{ file: path, content }];

describe("verify-guards write-helper enforcement", () => {
  // adminApi*/configureAdminAdapter (admin) and apiPost/apiPatch/apiDelete/patch_ (write) are
  // primitives the read-only pilot must never NAME. Driven through the real collector.
  for (const fixture of [
    "const r = await adminApiGet(path);",
    "await adminApiPost(path, body);",
    "adminApiPatch(path, body);",
    "await adminApiDelete(path);",
    "adminApiGetWithCursor(path, cursor);",
    "configureAdminAdapter({ origin });",
    "apiPost(path)",
    "apiPatch(path)",
    "apiDelete(path)",
    "patch_application",
  ]) {
    it(`flags ${JSON.stringify(fixture)}`, () => {
      assert.equal(collectWriteHelperHits(file(fixture)).length, 1, fixture);
    });
  }

  it("does not flag read primitives or the read-only module import (no over-clamp)", () => {
    for (const fixture of [
      'import { apiGet, apiGetWithCursor, configure } from "../../control-plane/dist/client-readonly.js";',
      'import { RATE_LIMIT_ERROR_NAME } from "../../control-plane/dist/client-readonly.js";',
    ]) {
      assert.equal(collectWriteHelperHits(file(fixture)).length, 0, fixture);
    }
  });
});

describe("verify-guards raw-client import boundary enforcement", () => {
  it("forbids the write-bearing client.js module EVEN on the scoped-reader chokepoint (residency lock)", () => {
    // The exact pre-Slice-A line. scoped-reader is exempt from the read-NAME rule but NEVER from
    // the write-MODULE rule, so reverting its import to dist/client.js re-loads the write/admin
    // surface and must fail. This is the data-corruption-lens hole, now closed.
    const hits = collectRawClientImportHits(
      [
        {
          file: READER,
          content: 'import { apiGet, apiGetWithCursor, configure } from "../../dist/client.js";',
        },
      ],
      READER,
    );
    assert.equal(hits.length, 1, "scoped-reader importing dist/client.js must be flagged");
  });

  it("allows the sanctioned read-only module import on the chokepoint (no over-clamp)", () => {
    const hits = collectRawClientImportHits(
      [
        {
          file: READER,
          content:
            'import { apiGet, apiGetWithCursor, configure } from "../../control-plane/dist/client-readonly.js";',
        },
      ],
      READER,
    );
    assert.equal(hits.length, 0);
  });

  it("forbids client.js reached via a non-canonical path (path-enumeration lock)", () => {
    // ../../../greenhouse/src/client.js dodged every token in the old single pattern.
    const hits = collectRawClientImportHits(
      file('import { apiPost } from "../../../greenhouse/src/client.js";'),
      READER,
    );
    assert.ok(hits.length >= 1, "client.js at any relative depth must be flagged");
  });

  it("forbids the raw read-primitive names in a non-reader file", () => {
    for (const fixture of ["const r = await apiGet(path);", "configure(clientId, clientSecret);"]) {
      assert.equal(collectRawClientImportHits(file(fixture), READER).length, 1, fixture);
    }
  });

  it("allows read-all.ts's real read-only import (no over-clamp)", () => {
    const hits = collectRawClientImportHits(
      [
        {
          file: "/pkg/src/read-all.ts",
          content: 'import { RATE_LIMIT_ERROR_NAME } from "../../control-plane/dist/client-readonly.js";',
        },
      ],
      READER,
    );
    assert.equal(hits.length, 0);
  });
});
