import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LIMITS,
  placeNewTables,
  planSchemaChanges,
  summarizeChanges,
} from "./planSchemaChanges.js";

const layout = { tableWidth: 220, pan: { x: 0, y: 0 } };

function baseDiagram() {
  return {
    database: "postgresql",
    enums: [],
    types: [],
    relationships: [],
    tables: [
      {
        id: "t_users",
        name: "users",
        x: 100,
        y: 50,
        comment: "",
        color: "#175e7a",
        indices: [],
        uniqueConstraints: [],
        fields: [
          { id: "f_users_id", name: "id", type: "INTEGER", default: "", check: "", primary: true, unique: false, notNull: true, increment: true, comment: "" },
          { id: "f_users_email", name: "email", type: "VARCHAR", size: 255, default: "", check: "", primary: false, unique: true, notNull: true, increment: false, comment: "" },
        ],
      },
    ],
  };
}

test("rejects malformed requests without touching input", () => {
  const diagram = baseDiagram();
  const snapshot = JSON.stringify(diagram);
  for (const bad of [undefined, null, {}, { operations: "x" }, { operations: [] }]) {
    const result = planSchemaChanges(bad, diagram, layout);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length >= 1);
  }
  assert.equal(JSON.stringify(diagram), snapshot);
});

test("enforces the per-call operation limit", () => {
  const operations = Array.from({ length: LIMITS.operations + 1 }, (_, i) => ({
    op: "add_table",
    name: `t${i}`,
    fields: [{ name: "id", type: "INT", primary: true }],
  }));
  const result = planSchemaChanges({ operations }, baseDiagram(), layout);
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /Too many operations/);
});

test("adds related tables, fields, indexes and relationships in one request", () => {
  const diagram = baseDiagram();
  const result = planSchemaChanges(
    {
      operations: [
        {
          op: "add_table",
          name: "plans",
          fields: [
            { name: "id", type: "INT", primary: true, increment: true },
            { name: "name", type: "VARCHAR", size: 120, notNull: true },
            { name: "price_cents", type: "INT", notNull: true, default: 0 },
          ],
          indexes: [{ name: "plans_name_idx", fields: ["name"], unique: true }],
        },
        {
          op: "add_table",
          name: "subscriptions",
          fields: [
            { name: "id", type: "INT", primary: true, increment: true },
            { name: "user_id", type: "INT", notNull: true },
            { name: "plan_id", type: "INT", notNull: true },
            { name: "status", type: "VARCHAR" },
          ],
        },
        { op: "add_field", table: "users", field: { name: "created_at", type: "TIMESTAMP" } },
        { op: "add_index", table: "subscriptions", index: { fields: ["user_id", "plan_id"] } },
        {
          op: "add_relationship",
          from: { table: "subscriptions", field: "user_id" },
          to: { table: "users", field: "id" },
          onDelete: "cascade",
        },
        {
          op: "add_relationship",
          from: { table: "subscriptions", field: "plan_id" },
          to: { table: "plans", field: "id" },
        },
      ],
    },
    diagram,
    layout,
  );

  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const { tables, relationships } = result.next;
  assert.deepEqual(tables.map((t) => t.name), ["users", "plans", "subscriptions"]);

  const plans = tables.find((t) => t.name === "plans");
  assert.equal(plans.fields[1].size, 120);
  assert.equal(plans.fields[2].default, "0");
  assert.equal(plans.fields[0].notNull, true, "primary keys imply NOT NULL");
  assert.deepEqual(plans.indices, [
    { id: 0, name: "plans_name_idx", unique: true, fields: ["name"] },
  ]);

  const subscriptions = tables.find((t) => t.name === "subscriptions");
  assert.equal(subscriptions.fields[3].size, 255, "VARCHAR gets the default size");
  assert.equal(subscriptions.indices[0].name, "subscriptions_index_0");

  const users = tables.find((t) => t.name === "users");
  assert.equal(users.fields.length, 3);
  assert.equal(users.id, "t_users", "existing ids are preserved");
  assert.equal(users.fields[0].id, "f_users_id");

  assert.equal(relationships.length, 2);
  const userFk = relationships[0];
  assert.equal(userFk.name, "fk_subscriptions_user_id_users");
  assert.equal(userFk.startTableId, subscriptions.id);
  assert.equal(userFk.endTableId, "t_users");
  assert.equal(userFk.endFieldId, "f_users_id");
  assert.equal(userFk.cardinality, "many_to_one");
  assert.equal(userFk.deleteConstraint, "Cascade");
  assert.equal(userFk.updateConstraint, "No action");
  assert.deepEqual(userFk.fields, [
    { startFieldId: subscriptions.fields[1].id, endFieldId: "f_users_id" },
  ]);

  // New tables are placed to the right of the existing diagram.
  assert.equal(plans.x, 100 + 220 + 80);
  assert.equal(plans.y, 50);
  assert.equal(subscriptions.x, plans.x);
  assert.ok(subscriptions.y > plans.y);

  assert.deepEqual(result.summary.tables, ["plans", "subscriptions"]);
  assert.equal(result.summary.relationships.length, 2);
  assert.match(summarizeChanges(result.summary), /added 2 table\(s\)/);

  // The input diagram is never mutated by planning.
  assert.equal(diagram.tables.length, 1);
  assert.equal(diagram.tables[0].fields.length, 2);
});

test("reports every invalid reference and applies nothing", () => {
  const result = planSchemaChanges(
    {
      operations: [
        { op: "add_field", table: "orders", field: { name: "x", type: "INT" } },
        { op: "add_field", table: "users", field: { name: "email", type: "INT" } },
        { op: "add_field", table: "users", field: { name: "flag", type: "NOT_A_TYPE" } },
        { op: "add_index", table: "users", index: { fields: ["nope"] } },
        {
          op: "add_relationship",
          from: { table: "users", field: "email" },
          to: { table: "users", field: "id" },
        },
        { op: "delete_table", table: "users" },
        { op: "add_table", name: "1bad", fields: [{ name: "id", type: "INT" }] },
        { op: "add_table", name: "USERS", fields: [{ name: "id", type: "INT" }] },
      ],
    },
    baseDiagram(),
    layout,
  );
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 8);
  assert.deepEqual(result.errors.map((e) => e.operation), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.match(result.errors[0].message, /does not exist/);
  assert.match(result.errors[1].message, /already exists/);
  assert.match(result.errors[2].message, /not available for postgresql/);
  assert.match(result.errors[3].message, /does not exist/);
  assert.match(result.errors[4].message, /incompatible types/);
  assert.match(result.errors[5].message, /Unknown operation/);
  assert.match(result.errors[6].message, /identifier/);
  assert.match(result.errors[7].message, /already exists/);
});

test("rejects ambiguous case-insensitive references instead of guessing", () => {
  const diagram = baseDiagram();
  diagram.tables.push({ ...diagram.tables[0], id: "t_users2", name: "Users" });
  const result = planSchemaChanges(
    { operations: [{ op: "add_field", table: "USERS", field: { name: "a", type: "INT" } }] },
    diagram,
    layout,
  );
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /ambiguous/);
});

test("update_field only allows safe properties and keeps index names in sync", () => {
  const diagram = baseDiagram();
  diagram.tables[0].indices.push({ id: 0, name: "users_email_idx", unique: true, fields: ["email"] });
  const ok = planSchemaChanges(
    {
      operations: [
        { op: "update_field", table: "users", field: "email", set: { name: "email_address", notNull: false } },
        { op: "update_table", table: "users", set: { comment: "Registered accounts" } },
      ],
    },
    diagram,
    layout,
  );
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  const users = ok.next.tables[0];
  assert.equal(users.fields[1].name, "email_address");
  assert.equal(users.fields[1].id, "f_users_email");
  assert.equal(users.fields[1].notNull, false);
  assert.deepEqual(users.indices[0].fields, ["email_address"]);
  assert.equal(users.comment, "Registered accounts");

  const bad = planSchemaChanges(
    { operations: [{ op: "update_field", table: "users", field: "email", set: { id: "x" } }] },
    diagram,
    layout,
  );
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0].message, /can only change/);
});

test("enum and generic-database types are validated", () => {
  const diagram = { ...baseDiagram(), database: "postgresql", enums: [{ name: "status", values: ["a"] }] };
  const ok = planSchemaChanges(
    {
      operations: [
        { op: "add_field", table: "users", field: { name: "status", type: "status" } },
        { op: "add_field", table: "users", field: { name: "n", type: "int" } },
      ],
    },
    diagram,
    layout,
  );
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(ok.next.tables[0].fields[2].type, "STATUS");
  assert.equal(ok.next.tables[0].fields[3].type, "INTEGER", "INT is aliased to INTEGER on PostgreSQL");

  const mysql = { ...baseDiagram(), database: "mysql" };
  const withValues = planSchemaChanges(
    { operations: [{ op: "add_field", table: "users", field: { name: "tags", type: "ENUM", values: ["x", "y"] } }] },
    mysql,
    layout,
  );
  assert.equal(withValues.ok, true, JSON.stringify(withValues.errors));
  assert.deepEqual(withValues.next.tables[0].fields[2].values, ["x", "y"]);
  const missingValues = planSchemaChanges(
    { operations: [{ op: "add_field", table: "users", field: { name: "e", type: "ENUM" } }] },
    mysql,
    layout,
  );
  assert.equal(missingValues.ok, false);
  assert.match(missingValues.errors[0].message, /values/);

  const generic = planSchemaChanges(
    { operations: [{ op: "add_field", table: "users", field: { name: "n", type: "int" } }] },
    { ...baseDiagram(), database: "generic" },
    layout,
  );
  assert.equal(generic.ok, true, JSON.stringify(generic.errors));
  assert.equal(generic.next.tables[0].fields[2].type, "INT");
});

test("placeNewTables centres the block on the pan point of an empty canvas", () => {
  const fresh = [
    { name: "a", fields: [{ name: "id" }], comment: "" },
    { name: "b", fields: [{ name: "id" }], comment: "" },
  ];
  placeNewTables([], fresh, { tableWidth: 200, pan: { x: 40, y: 30 } });
  assert.equal(fresh[0].x, 40 - 100, "single column centred horizontally");
  assert.equal(fresh[1].x, fresh[0].x);
  assert.ok(fresh[0].y < 30 && fresh[1].y > fresh[0].y, "stacked around the vertical centre");
  const mid = (fresh[0].y + fresh[1].y + 93) / 2; // 93 = one-field table height
  assert.ok(Math.abs(mid - 30) <= 1);
});
