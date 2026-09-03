import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewSchema } from "./reviewSchema.js";

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

test("produces structured findings with fixes and severity counts", () => {
  const out = reviewSchema(
    {
      database: "postgresql",
      tables: [
        {
          id: "u",
          name: "Users",
          indices: [],
          fields: [
            field("u1", "id", { primary: true, notNull: true }),
            field("u2", "created_at", { type: "TIMESTAMP", notNull: true }),
            field("u3", "nickName", { type: "VARCHAR" }),
          ],
        },
        {
          id: "s",
          name: "sessions",
          indices: [],
          fields: [
            field("s1", "id", { primary: true, notNull: true }),
            field("s2", "user_id"),
          ],
        },
        {
          id: "l",
          name: "logs",
          indices: [],
          fields: [field("l1", "id", { primary: true, notNull: true })],
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
    },
    ["Table 'logs' has no primary key"],
  );

  const codes = out.findings.map((f) => f.code);
  assert.ok(codes.includes("validator"));
  assert.ok(codes.includes("fk_without_index"));
  assert.ok(codes.includes("naming"));
  assert.ok(codes.includes("isolated_table"));
  assert.ok(codes.includes("no_created_at"));
  assert.ok(codes.includes("unsized_type"));
  assert.ok(codes.includes("nullable_fk"));

  assert.equal(out.findings[0].severity, "error");
  assert.equal(out.summary.error, 1);
  assert.ok(out.summary.warning >= 1);
  assert.ok(out.summary.hint >= 4);
  assert.ok(out.fixableCount >= 3);

  const nullableFk = out.findings.find((f) => f.code === "nullable_fk");
  assert.deepEqual(nullableFk.fix, {
    op: "update_field",
    table: "sessions",
    field: "user_id",
    set: { notNull: true },
  });
  const createdAt = out.findings.find(
    (f) => f.code === "no_created_at" && f.table === "sessions",
  );
  assert.equal(createdAt.fix.field.type, "TIMESTAMP");
  const isolated = out.findings.find((f) => f.code === "isolated_table");
  assert.equal(isolated.table, "logs");
});

test("a clean, well-formed schema yields no warnings or errors", () => {
  const out = reviewSchema(
    {
      database: "postgresql",
      tables: [
        {
          id: "u",
          name: "users",
          indices: [],
          fields: [
            field("u1", "id", { primary: true, notNull: true }),
            field("u2", "created_at", { type: "TIMESTAMP", notNull: true }),
          ],
        },
      ],
      relationships: [],
    },
    [],
  );
  assert.equal(out.summary.error, 0);
  assert.equal(out.summary.warning, 0);
  assert.equal(out.findings.length, 0);
});
