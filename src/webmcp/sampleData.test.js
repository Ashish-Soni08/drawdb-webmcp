import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSampleInserts, orderTablesByDependency } from "./sampleData.js";
import { explainJoinPath } from "./joinPath.js";

const f = (id, name, type, extra = {}) => ({ id, name, type, primary: false, unique: false, notNull: false, ...extra });

const diagram = {
  database: "postgresql",
  tables: [
    { id: "i", name: "invoices", fields: [f("i1", "id", "INTEGER", { primary: true }), f("i2", "sub_id", "INTEGER"), f("i3", "total", "DECIMAL"), f("i4", "paid", "BOOLEAN")] },
    { id: "s", name: "subs", fields: [f("s1", "id", "INTEGER", { primary: true }), f("s2", "user_id", "INTEGER"), f("s3", "status", "VARCHAR", { size: 6 }), f("s4", "started", "TIMESTAMP")] },
    { id: "u", name: "users", fields: [f("u1", "id", "INTEGER", { primary: true }), f("u2", "email", "VARCHAR", { size: 255 })] },
    { id: "x", name: "audit", fields: [f("x1", "id", "INTEGER", { primary: true }), f("x2", "kind", "ENUM", { values: ["a", "b"] })] },
  ],
  relationships: [
    { id: "r1", name: "fk_subs_user", startTableId: "s", startFieldId: "s2", endTableId: "u", endFieldId: "u1", fields: [{ startFieldId: "s2", endFieldId: "u1" }] },
    { id: "r2", name: "fk_inv_sub", startTableId: "i", startFieldId: "i2", endTableId: "s", endFieldId: "s1", fields: [{ startFieldId: "i2", endFieldId: "s1" }] },
  ],
};

test("orders parents before children", () => {
  const order = orderTablesByDependency(diagram.tables, diagram.relationships).map((t) => t.name);
  assert.ok(order.indexOf("users") < order.indexOf("subs"));
  assert.ok(order.indexOf("subs") < order.indexOf("invoices"));
  assert.equal(order.length, 4);
});

test("generates deterministic inserts with valid foreign keys", () => {
  const r = generateSampleInserts(diagram, { rows: 2 });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(r.tableOrder.slice(0, 3).includes("users"), true);
  assert.match(r.sql, /INSERT INTO "users" \("id", "email"\) VALUES\n\t\(1, 'users_email_1'\),\n\t\(2, 'users_email_2'\);/);
  assert.match(r.sql, /INSERT INTO "subs"[\s\S]*\(1, 1, 'stat1', CURRENT_TIMESTAMP\)/, "FK points at row 1; VARCHAR(6) is truncated");
  assert.match(r.sql, /INSERT INTO "invoices"[\s\S]*\(2, 2, 20\.50, FALSE\)/);
  assert.match(r.sql, /INSERT INTO "audit"[\s\S]*\(1, 'a'\),\n\t\(2, 'b'\)/);
  assert.ok(r.sql.indexOf('"users"') < r.sql.indexOf('"invoices"'));
});

test("validates options and supports table filters and dialect quoting", () => {
  assert.equal(generateSampleInserts(diagram, { rows: 0 }).ok, false);
  assert.equal(generateSampleInserts(diagram, { rows: 99 }).ok, false);
  assert.equal(generateSampleInserts(diagram, { tables: ["nope"] }).ok, false);
  const only = generateSampleInserts({ ...diagram, database: "mysql" }, { tables: ["USERS"] });
  assert.equal(only.ok, true);
  assert.deepEqual(only.tableOrder, ["users"]);
  assert.match(only.sql, /INSERT INTO `users`/);
  assert.equal(generateSampleInserts({ database: "postgresql", tables: [], relationships: [] }).ok, false);
});

test("explainJoinPath finds the shortest FK chain in either direction", () => {
  const r = explainJoinPath(diagram, { from: "users", to: "invoices" });
  assert.equal(r.ok, true);
  assert.equal(r.connected, true);
  assert.deepEqual(r.hops, [
    { from: { table: "users", field: "id" }, to: { table: "subs", field: "user_id" }, via: "fk_subs_user" },
    { from: { table: "subs", field: "id" }, to: { table: "invoices", field: "sub_id" }, via: "fk_inv_sub" },
  ]);
  assert.equal(r.sql, 'SELECT *\nFROM "users"\nJOIN "subs" ON "subs"."user_id" = "users"."id"\nJOIN "invoices" ON "invoices"."sub_id" = "subs"."id"');

  const none = explainJoinPath(diagram, { from: "users", to: "audit" });
  assert.equal(none.ok, true);
  assert.equal(none.connected, false);
  assert.equal(explainJoinPath(diagram, { from: "users", to: "ghost" }).ok, false);
  assert.equal(explainJoinPath(diagram, { from: "users", to: "users" }).ok, false);
});
