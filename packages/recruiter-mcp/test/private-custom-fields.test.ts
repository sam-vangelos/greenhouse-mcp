import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { runEvidenceTool } from "../src/tools/evidence.js";
import { _resetPrivateCustomFieldCache } from "../src/private-custom-fields.js";
import { fakeScopedReader, scopedSuccess, testRuntime } from "./test-helpers.js";

// Greenhouse marks a custom-field DEFINITION `private`, restricting its VALUES to holders of the
// matching "View Private" permission (0077-get_v3-custom-fields.md). The evidence projector gates on
// key NAMES only, so before this gate a private definition's values — visa status, background-check
// result, salary expectation — flowed verbatim to any recruiter with job permission. Scoped reads
// use an org-wide service credential, so Greenhouse's own permission never fires here.

function candidateRow(customFields: Record<string, unknown>): Record<string, unknown> {
  return { id: 501, private: false, job_id: 1, custom_fields: customFields };
}

describe("private custom-field values", () => {
  beforeEach(() => {
    _resetPrivateCustomFieldCache();
  });

  it("withholds values whose definition is private and keeps the rest", async () => {
    const reader = fakeScopedReader((toolName) => {
      if (toolName === "list_custom_fields") {
        return scopedSuccess("list_custom_fields", [
          { id: 1, name_key: "visa_status", private: true, field_type: "candidate" },
          { id: 2, name_key: "referral_source", private: false, field_type: "candidate" },
        ]);
      }
      return scopedSuccess("list_candidates", [
        candidateRow({
          visa_status: { value: "H-1B, expires 2027" },
          referral_source: { value: "Employee referral" },
        }),
      ]);
    });

    const result = await runEvidenceTool(testRuntime(reader).runtime, "search_my_candidates", {});

    assert.equal(result.ok, true);
    const rows = result.ok ? (result.data as Record<string, unknown>[]) : [];
    const fields = rows[0]?.custom_fields as Record<string, unknown>;
    assert.equal(
      "visa_status" in fields,
      false,
      "a private definition's value must not reach the model"
    );
    assert.deepEqual(
      fields.referral_source,
      { value: "Employee referral" },
      "a non-private custom field still passes through"
    );
  });

  it("strips a private definition that is archived, and never asks for live fields only", async () => {
    // /v3/custom_fields "defaults to returning both active and archived"; asking for `active=true`
    // dropped archived private definitions off the strip list. Archiving a definition does not
    // remove its values from the rows that already carry them, so those values became readable.
    const definitions = [
      { id: 1, name_key: "background_check", private: true, active: false, field_type: "candidate" },
    ];
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_custom_fields") {
        // Honour `active` the way Greenhouse does — `true` means live fields ONLY. A fake that
        // ignored the param would return the archived definition either way and lock nothing.
        const rows = params?.active === "true" || params?.active === true
          ? definitions.filter((definition) => definition.active !== false)
          : definitions;
        return scopedSuccess("list_custom_fields", rows);
      }
      return scopedSuccess("list_candidates", [
        candidateRow({ background_check: { value: "Adverse — pending adjudication" } }),
      ]);
    });
    const { runtime } = testRuntime(reader);

    const result = await runEvidenceTool(runtime, "search_my_candidates", {});

    assert.equal(result.ok, true);
    const rows = result.ok ? (result.data as Record<string, unknown>[]) : [];
    const fields = (rows[0]?.custom_fields ?? {}) as Record<string, unknown>;
    assert.equal(
      "background_check" in fields,
      false,
      "an archived private definition still strips its values"
    );
  });

  it("reads every page of definitions, so one past page 1 still strips", async () => {
    // Only the first page was read, so a private definition on any later page was simply absent
    // from the strip list and its values flowed through.
    const pages: Record<string, unknown>[][] = [
      [{ id: 1, name_key: "referral_source", private: false, field_type: "candidate" }],
      [{ id: 2, name_key: "salary_expectation", private: true, field_type: "candidate" }],
    ];
    const cursors: (string | undefined)[] = [];
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_custom_fields") {
        const cursor = params?.cursor as string | undefined;
        cursors.push(cursor);
        return cursor === undefined
          ? scopedSuccess("list_custom_fields", pages[0], "page-2")
          : scopedSuccess("list_custom_fields", pages[1], null);
      }
      return scopedSuccess("list_candidates", [
        candidateRow({
          salary_expectation: { value: "$310,000 base" },
          referral_source: { value: "Employee referral" },
        }),
      ]);
    });

    const result = await runEvidenceTool(testRuntime(reader).runtime, "search_my_candidates", {});

    assert.equal(result.ok, true);
    const fields = ((result.ok ? (result.data as Record<string, unknown>[]) : [])[0]?.custom_fields ??
      {}) as Record<string, unknown>;
    assert.equal(
      "salary_expectation" in fields,
      false,
      "a private definition on page 2 must strip just like one on page 1"
    );
    assert.deepEqual(fields.referral_source, { value: "Employee referral" });
    assert.deepEqual(cursors, [undefined, "page-2"], "the second page must actually be requested");
  });

  it("withholds every value rather than returning a partial strip list when a later page fails", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_custom_fields") {
        return params?.cursor === undefined
          ? scopedSuccess("list_custom_fields", [
              { id: 1, name_key: "referral_source", private: false, field_type: "candidate" },
            ], "page-2")
          : ({
              ok: false as const,
              toolName: "list_custom_fields",
              denial: { code: "UPSTREAM_ERROR", message: "definitions unavailable" },
            } as never);
      }
      return scopedSuccess("list_candidates", [
        candidateRow({ referral_source: { value: "Employee referral" } }),
      ]);
    });

    const result = await runEvidenceTool(testRuntime(reader).runtime, "search_my_candidates", {});

    assert.equal(result.ok, true);
    const rows = result.ok ? (result.data as Record<string, unknown>[]) : [];
    assert.equal(
      "custom_fields" in (rows[0] ?? {}),
      false,
      "an incomplete strip list is unknown privacy, not a complete answer"
    );
  });

  it("withholds every custom-field value when the definitions cannot be read", async () => {
    const reader = fakeScopedReader((toolName) => {
      if (toolName === "list_custom_fields") {
        return {
          ok: false as const,
          toolName: "list_custom_fields",
          denial: { code: "UPSTREAM_ERROR", message: "definitions unavailable" },
        } as never;
      }
      return scopedSuccess("list_candidates", [
        candidateRow({ visa_status: { value: "H-1B" }, referral_source: { value: "Referral" } }),
      ]);
    });

    const result = await runEvidenceTool(testRuntime(reader).runtime, "search_my_candidates", {});

    assert.equal(result.ok, true);
    const rows = result.ok ? (result.data as Record<string, unknown>[]) : [];
    // The key is omitted entirely rather than emptied, matching how the projector signals every
    // other withheld field — an absent key, never a hollowed-out one that reads as "no data".
    assert.equal(
      "custom_fields" in (rows[0] ?? {}),
      false,
      "unknown privacy withholds all values rather than guessing which are safe"
    );
  });
});
