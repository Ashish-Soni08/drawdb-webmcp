import { test } from "node:test";
import assert from "node:assert/strict";
import { describeSchema } from "./describeSchema.js";

const diagram = {
  database: "postgresql",
  enums: [{ name: "status", values: ["active", "paused"] }],
  types: [],
  tables: [
    {
      id: "u",
      name: "users",
      x: 1,
      y: 2,
      color: "#123456",
      comment: "",
      indices: [
        { id: 0, name: "users_email_idx", unique: true, fields: ["email"] },
      ],
      fields: [
        {
          id: "u_id",
          name: "id",
          type: "INT",
          default: "",
          primary: true,
          notNull: true,
          increment: true,
          unique: false,
          comment: "",
        },
        {
          id: "u_email",
          name: "email",
          type: "VARCHAR",
          size: 255,
          default: "",
          primary: false,
          notNull: true,
          increment: false,
          unique: true,
          comment: "login",
        },
      ],
    },
    {
      id: "s",
      name: "subscriptions",
      x: 0,
      y: 0,
      color: "#123456",
      comment: "Billing",
      indices: [],
      fields: [
        {
          id: "s_id",
          name: "id",
          type: "INT",
          default: "",
          primary: true,
          notNull: true,
          increment: true,
          unique: false,
          comment: "",
        },
        {
          id: "s_user",
          name: "user_id",
          type: "INT",
          default: "",
          primary: false,
          notNull: true,
          increment: false,
          unique: false,
          comment: "",
        },
      ],
    },
  ],
  relationships: [
    {
      id: "r1",
      name: "fk_subscriptions_user_id_users",
      startTableId: "s",
      startFieldId: "s_user",
      endTableId: "u",
      endFieldId: "u_id",
      fields: [{ startFieldId: "s_user", endFieldId: "u_id" }],
      cardinality: "many_to_one",
      updateConstraint: "No action",
      deleteConstraint: "Cascade",
      color: "#808080",
    },
  ],
};

test("describes the diagram compactly without visual noise", () => {
  const out = describeSchema(diagram);
  assert.equal(out.database, "postgresql");
  assert.deepEqual(out.counts, {
    tables: 2,
    fields: 4,
    relationships: 1,
    enums: 1,
    types: 0,
  });
  assert.deepEqual(out.tables[0], {
    id: "u",
    name: "users",
    fields: [
      {
        id: "u_id",
        name: "id",
        type: "INT",
        primary: true,
        notNull: true,
        increment: true,
      },
      {
        id: "u_email",
        name: "email",
        type: "VARCHAR",
        size: 255,
        notNull: true,
        unique: true,
        comment: "login",
      },
    ],
    indexes: [{ name: "users_email_idx", unique: true, fields: ["email"] }],
  });
  assert.equal(out.tables[1].comment, "Billing");
  assert.equal("x" in out.tables[0], false);
  assert.deepEqual(out.relationships[0], {
    id: "r1",
    name: "fk_subscriptions_user_id_users",
    from: { table: "subscriptions", field: "user_id" },
    to: { table: "users", field: "id" },
    cardinality: "many_to_one",
    onUpdate: "No action",
    onDelete: "Cascade",
  });
  assert.deepEqual(out.enums, [
    { name: "status", values: ["active", "paused"] },
  ]);
  assert.equal("types" in out, false);
});

test("filters by table name while keeping global counts", () => {
  const out = describeSchema(diagram, { tables: ["USERS"] });
  assert.equal(out.tables.length, 1);
  assert.equal(out.tables[0].name, "users");
  assert.equal(
    out.relationships.length,
    1,
    "relationships touching the table are kept",
  );
  assert.equal(out.counts.tables, 2);
});
