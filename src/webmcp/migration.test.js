import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMigration, snapshotSchema } from "./migration.js";

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

const users = {
  id: "u",
  name: "users",
  x: 0,
  y: 0,
  color: "#175e7a",
  comment: "",
  indices: [],
  fields: [
    field("u1", "id", { primary: true, notNull: true, increment: true }),
  ],
};

test("no changes -> empty migration", () => {
  const base = snapshotSchema({ tables: [users], relationships: [] });
  const r = buildMigration(
    base,
    snapshotSchema({ tables: [{ ...users, x: 500 }], relationships: [] }),
    "postgresql",
  );
  assert.equal(r.ok, true);
  assert.equal(r.changeCount, 0, "position changes are ignored");
  assert.equal(r.up, "");
});

test("adding a table and a column produces up and down SQL", () => {
  const base = snapshotSchema({ tables: [users], relationships: [] });
  const after = snapshotSchema({
    tables: [
      {
        ...users,
        fields: [
          ...users.fields,
          field("u2", "email", { type: "VARCHAR", size: 255, notNull: true }),
        ],
      },
      {
        id: "p",
        name: "posts",
        x: 0,
        y: 0,
        color: "#175e7a",
        comment: "",
        indices: [],
        fields: [
          field("p1", "id", { primary: true, notNull: true }),
          field("p2", "user_id", { notNull: true }),
        ],
      },
    ],
    relationships: [
      {
        id: "r1",
        name: "fk_posts_user_id_users",
        startTableId: "p",
        startFieldId: "p2",
        endTableId: "u",
        endFieldId: "u1",
        fields: [{ startFieldId: "p2", endFieldId: "u1" }],
        cardinality: "many_to_one",
        updateConstraint: "No action",
        deleteConstraint: "Cascade",
      },
    ],
  });
  const r = buildMigration(base, after, "postgresql");
  assert.equal(r.ok, true, r.message);
  assert.ok(r.changeCount > 0);
  assert.match(r.up, /CREATE TABLE[\s\S]*"posts"/);
  assert.match(r.up, /ALTER TABLE "users"[\s\S]*ADD COLUMN "email"/i);
  assert.match(r.down, /DROP TABLE[\s\S]*"posts"/);
  assert.match(r.down, /DROP COLUMN "email"/i);
});

test("dialect handling mirrors generate_sql", () => {
  const base = snapshotSchema({ tables: [], relationships: [] });
  const after = snapshotSchema({ tables: [users], relationships: [] });
  assert.equal(buildMigration(base, after, "postgresql", "mysql").ok, false);
  assert.equal(buildMigration(base, after, "generic").dialect, "postgresql");
  assert.equal(
    buildMigration(base, after, "generic", "mysql").dialect,
    "mysql",
  );
  assert.equal(buildMigration(base, after, "generic", "cobol").ok, false);
});
