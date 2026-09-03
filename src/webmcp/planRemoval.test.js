import { test } from "node:test";
import assert from "node:assert/strict";
import { planRemoval, summarizeRemoval } from "./planRemoval.js";

const f = (id, name, extra = {}) => ({ id, name, type: "INTEGER", primary: false, unique: false, notNull: false, ...extra });

function diagram() {
  return {
    tables: [
      { id: "u", name: "users", fields: [f("u1", "id", { primary: true }), f("u2", "email")], indices: [{ id: 0, name: "users_email_idx", unique: true, fields: ["email"] }], uniqueConstraints: [] },
      { id: "s", name: "subs", fields: [f("s1", "id", { primary: true }), f("s2", "user_id"), f("s3", "plan")], indices: [{ id: 0, name: "subs_user_plan_idx", unique: false, fields: ["user_id", "plan"] }], uniqueConstraints: [] },
      { id: "i", name: "invoices", fields: [f("i1", "id", { primary: true }), f("i2", "sub_id")], indices: [], uniqueConstraints: [] },
    ],
    relationships: [
      { id: "r1", name: "fk_subs_user", startTableId: "s", startFieldId: "s2", endTableId: "u", endFieldId: "u1", fields: [{ startFieldId: "s2", endFieldId: "u1" }] },
      { id: "r2", name: "fk_inv_sub", startTableId: "i", startFieldId: "i2", endTableId: "s", endFieldId: "s1", fields: [{ startFieldId: "i2", endFieldId: "s1" }] },
    ],
  };
}

test("removing a table cascades to its relationships and reports the impact", () => {
  const r = planRemoval({ targets: [{ kind: "table", table: "users" }] }, diagram());
  assert.equal(r.ok, true);
  assert.deepEqual(r.impact.tables, [{ name: "users", fieldCount: 2 }]);
  assert.deepEqual(r.impact.relationships.map((x) => x.name), ["fk_subs_user"]);
  assert.deepEqual(r.next.tables.map((t) => t.name), ["subs", "invoices"]);
  assert.deepEqual(r.next.relationships.map((x) => x.name), ["fk_inv_sub"]);
  assert.match(summarizeRemoval(r.impact), /1 table\(s\): users; 1 relationship/);
});

test("removing a field drops dependent relationships and prunes indexes", () => {
  const r = planRemoval({ targets: [{ kind: "field", table: "subs", field: "user_id" }] }, diagram());
  assert.equal(r.ok, true);
  assert.deepEqual(r.impact.fields, [{ table: "subs", field: "user_id" }]);
  assert.deepEqual(r.impact.relationships.map((x) => x.name), ["fk_subs_user"]);
  const subs = r.next.tables.find((t) => t.name === "subs");
  assert.deepEqual(subs.fields.map((x) => x.name), ["id", "plan"]);
  assert.deepEqual(subs.indices[0].fields, ["plan"], "index keeps its remaining column");
  assert.equal(r.impact.indexes.length, 0);

  const r2 = planRemoval({ targets: [{ kind: "field", table: "users", field: "email" }] }, diagram());
  assert.deepEqual(r2.impact.indexes, [{ table: "users", index: "users_email_idx" }], "index with no columns left is dropped");
});

test("relationship and index targets, and validation errors", () => {
  const r = planRemoval(
    { targets: [{ kind: "relationship", name: "fk_inv_sub" }, { kind: "index", table: "subs", name: "subs_user_plan_idx" }] },
    diagram(),
  );
  assert.equal(r.ok, true);
  assert.equal(r.next.relationships.length, 1);
  assert.equal(r.next.tables.find((t) => t.name === "subs").indices.length, 0);
  assert.equal(r.next.tables.length, 3, "no tables or fields touched");

  const bad = planRemoval(
    { targets: [{ kind: "table", table: "ghost" }, { kind: "column", table: "users" }, { kind: "field", table: "users", field: "nope" }] },
    diagram(),
  );
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors.map((e) => e.target), [0, 1, 2]);
  assert.equal(planRemoval({}, diagram()).ok, false);
  assert.equal(planRemoval({ targets: [] }, diagram()).ok, false);
});
