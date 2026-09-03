import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestFixes } from "./suggestFixes.js";

const field = (id, name, extra = {}) => ({
  id,
  name,
  type: "INTEGER",
  default: "",
  check: "",
  primary: false,
  unique: false,
  notNull: false,
  increment: false,
  comment: "",
  ...extra,
});

test("suggests a primary key, reusing an existing id column when present", () => {
  const out = suggestFixes({
    database: "postgresql",
    relationships: [],
    tables: [
      { id: "a", name: "a", indices: [], fields: [field("a1", "ref")] },
      { id: "b", name: "b", indices: [], fields: [field("b1", "ID")] },
      { id: "c", name: "c", indices: [], fields: [field("c1", "id", { primary: true })] },
    ],
  });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].operation, {
    op: "add_field",
    table: "a",
    field: { name: "id", type: "INTEGER", primary: true, notNull: true, increment: true },
  });
  assert.deepEqual(out[1].operation, {
    op: "update_field",
    table: "b",
    field: "ID",
    set: { primary: true, notNull: true },
  });
});

test("suggests an index for un-indexed foreign key columns", () => {
  const out = suggestFixes({
    database: "postgresql",
    tables: [
      { id: "u", name: "users", indices: [], fields: [field("u1", "id", { primary: true })] },
      {
        id: "s",
        name: "subs",
        indices: [{ id: 0, name: "x", unique: false, fields: ["plan_id"] }],
        fields: [
          field("s1", "id", { primary: true }),
          field("s2", "user_id"),
          field("s3", "plan_id"),
        ],
      },
    ],
    relationships: [
      { id: "r1", startTableId: "s", startFieldId: "s2", endTableId: "u", endFieldId: "u1", fields: [{ startFieldId: "s2", endFieldId: "u1" }] },
      { id: "r2", startTableId: "s", startFieldId: "s3", endTableId: "u", endFieldId: "u1", fields: [{ startFieldId: "s3", endFieldId: "u1" }] },
    ],
  });
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.equal(out[0].severity, "hint");
  assert.deepEqual(out[0].operation, {
    op: "add_index",
    table: "subs",
    index: { name: "subs_user_id_idx", fields: ["user_id"] },
  });
});

test("flags ENUM fields without values as needing input", () => {
  const out = suggestFixes({
    database: "mysql",
    relationships: [],
    tables: [
      {
        id: "t",
        name: "t",
        indices: [],
        fields: [field("1", "id", { primary: true }), field("2", "kind", { type: "ENUM", values: [] })],
      },
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].needsInput, true);
  assert.equal(out[0].operation.op, "update_field");
});
