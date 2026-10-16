import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  projectOffer,
  projectOffersArray,
  type ProjectedOffer,
} from "../src/projection-offers.js";

const ALLOWED_KEYS = new Set<keyof ProjectedOffer>([
  "id",
  "application_id",
  "status",
  "start_date",
]);

const RAW_OFFER_WITH_COMPENSATION = Object.freeze({
  id: 9001,
  application_id: 55501,
  status: "created",
  // v3 names the start date `starts_on` (0130-get_v3-offers.md); `start_date` is not a v3 field.
  starts_on: "2026-06-01",
  created_at: "2026-05-01T00:00:00Z",
  updated_at: "2026-05-08T00:00:00Z",
  custom_fields: {
    rsu_grant: "100000",
    bay_area_required: true,
  },
  keyed_custom_fields: {
    ote_split: { value: "70/30" },
  },
  base_salary: 250000,
  equity: "100000",
  job: {
    id: 333,
    name: "Principal AI Engineer",
  },
  candidate: {
    id: 70015,
    first_name: "Jane",
    email: "jane.doe@example.com",
  },
});

describe("projectOffer — operational profile", () => {
  it("returns exactly the four allowlisted keys by default", () => {
    const projected = projectOffer(RAW_OFFER_WITH_COMPENSATION);
    const keys = Object.keys(projected).sort();

    assert.deepStrictEqual(keys, [
      "application_id",
      "id",
      "start_date",
      "status",
    ]);

    for (const key of Object.keys(projected)) {
      assert.ok(
        ALLOWED_KEYS.has(key as keyof ProjectedOffer),
        `unexpected key "${key}" in projected output`
      );
    }
  });

  it("reads start_date from the v3 starts_on field (#H)", () => {
    // The fixture carries `starts_on` (v3), not `start_date`. The earlier code read
    // `raw.start_date`, which v3 never emits, so this was always null on the live path.
    assert.equal(projectOffer(RAW_OFFER_WITH_COMPENSATION).start_date, "2026-06-01");
  });

  it("still reads a legacy start_date when v3 starts_on is absent (back-compat)", () => {
    assert.equal(projectOffer({ id: 1, application_id: 2, status: "created", start_date: "2026-07-01" }).start_date, "2026-07-01");
  });
});

describe("projectOffer — detail profile", () => {
  it("broadens to timestamps + real custom_fields, without fabricating structured compensation (#H)", () => {
    const projected = projectOffer(RAW_OFFER_WITH_COMPENSATION, {
      detailProfile: "compensation",
    });

    assert.equal(projected.id, 9001);
    assert.equal(projected.application_id, 55501);
    assert.equal(projected.status, "created");
    assert.equal(projected.start_date, "2026-06-01");
    assert.equal(projected.created_at, "2026-05-01T00:00:00Z");
    assert.equal(projected.updated_at, "2026-05-08T00:00:00Z");
    assert.deepStrictEqual(projected.custom_fields, {
      rsu_grant: "100000",
      bay_area_required: true,
    });
    // #H: structured compensation is not a v3 offer field (pay lives in pay_inputs), and
    // `keyed_custom_fields` is not a v3 field — both were always null. They must not be
    // present at all, rather than fabricated/empty, even though the raw fixture carries
    // base_salary/equity/keyed_custom_fields (which the projection must drop).
    assert.ok(!("compensation" in projected), "must not fabricate a structured compensation field");
    assert.ok(!("keyed_custom_fields" in projected), "keyed_custom_fields is not a v3 offer field");
    const serialized = JSON.stringify(projected);
    assert.ok(!serialized.includes("base_salary"), "raw pay key leaked");
    assert.ok(!serialized.includes('"equity"'), "raw pay key leaked");
  });

  it("projects arrays in compensation mode without leaking nested candidate or job objects", () => {
    const projected = projectOffersArray([RAW_OFFER_WITH_COMPENSATION], {
      detailProfile: "compensation",
    });
    const serialized = JSON.stringify(projected);

    assert.ok(!serialized.includes('"candidate":'));
    assert.ok(!serialized.includes('"job":'));
    assert.ok(!serialized.includes("Jane"));
    assert.ok(!serialized.includes("jane.doe@example.com"));
  });
});
