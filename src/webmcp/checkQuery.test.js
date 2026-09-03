import { test } from "node:test";
import assert from "node:assert/strict";
import { checkQuery } from "./checkQuery.js";

const f = (id, name, extra = {}) => ({
  id,
  name,
  type: "INTEGER",
  primary: false,
  unique: false,
  ...extra,
});
const diagram = {
  database: "postgresql",
  tables: [
    {
      id: "u",
      name: "users",
      indices: [],
      fields: [
        f("u1", "id", { primary: true }),
        f("u2", "email", { unique: true }),
        f("u3", "name"),
      ],
    },
    {
      id: "s",
      name: "subscriptions",
      indices: [],
      fields: [
        f("s1", "id", { primary: true }),
        f("s2", "user_id"),
        f("s3", "status"),
      ],
    },
  ],
  relationships: [
    {
      id: "r1",
      startTableId: "s",
      startFieldId: "s2",
      endTableId: "u",
      endFieldId: "u1",
      fields: [{ startFieldId: "s2", endFieldId: "u1" }],
    },
  ],
};

test("a correct query is valid and gets index suggestions for filter and join columns", () => {
  const r = checkQuery(diagram, {
    sql: "SELECT u.email, s.status FROM users u JOIN subscriptions s ON s.user_id = u.id WHERE s.status = 'active'",
  });
  assert.equal(r.ok, true);
  assert.equal(r.valid, true, JSON.stringify(r.problems));
  assert.deepEqual(r.tables, ["users", "subscriptions"]);
  const codes = r.suggestions.map((x) => x.operation.index.name).sort();
  assert.deepEqual(codes, [
    "subscriptions_status_idx",
    "subscriptions_user_id_idx",
  ]);
  assert.match(
    r.suggestions.find(
      (x) => x.operation.index.name === "subscriptions_user_id_idx",
    ).message,
    /join/,
  );
});

test("reports unknown tables and columns, ambiguity, and joins without ON", () => {
  const r = checkQuery(diagram, {
    sql: "SELECT id, u.nickname, o.total FROM users u JOIN orders o JOIN subscriptions s",
  });
  assert.equal(r.valid, false);
  const codes = r.problems.map((p) => p.code);
  assert.ok(codes.includes("unknown_table"));
  assert.ok(codes.includes("unknown_column"));
  assert.ok(codes.includes("join_without_on"));
  assert.ok(
    r.problems.some((p) => /ambiguous/.test(p.message)),
    "unqualified id exists in two tables",
  );
  assert.ok(r.problems.some((p) => /nickname/.test(p.message)));
});

test("syntax errors and bad input are reported, never thrown", () => {
  const r = checkQuery(diagram, { sql: "SELEC * FRM users" });
  assert.equal(r.ok, true);
  assert.equal(r.valid, false);
  assert.equal(r.problems[0].code, "syntax");
  assert.equal(checkQuery(diagram, {}).ok, false);
  assert.equal(
    checkQuery(diagram, { sql: "SELECT 1", dialect: "cobol" }).ok,
    false,
  );
  const generic = checkQuery(
    { ...diagram, database: "generic" },
    { sql: "SELECT * FROM users" },
  );
  assert.equal(generic.valid, true);
});
