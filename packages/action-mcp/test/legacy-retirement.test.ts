import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { legacyRetirementSql } from "../deploy/retire-legacy-assignment-state.mjs";

describe("legacy assignment-state retirement", () => {
  test("locks and rechecks the drained table before archiving it and dropping exactly seven legacy RPCs", () => {
    const sql = legacyRetirementSql();
    assert.match(sql, /lock table public\.greenhouse_application_assignment_action in access exclusive mode/);
    assert.match(sql, /status in \('executing', 'unknown'\)/);
    assert.match(sql, /create schema if not exists greenhouse_mcp_archive/);
    assert.match(sql, /set schema greenhouse_mcp_archive/);
    assert.equal((sql.match(/drop function if exists/g) ?? []).length, 7);
    assert.match(sql, /^\s*begin;/);
    assert.match(sql, /commit;\s*$/);
  });
});
