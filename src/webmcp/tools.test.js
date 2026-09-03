import { test } from "node:test";
import assert from "node:assert/strict";
import { createSchemaPairTools } from "./tools.js";

/** Builds the four tools against an in-memory stand-in for the editor state. */
function harness(initial = {}) {
  const state = {
    database: "postgresql",
    tables: [],
    relationships: [],
    enums: [],
    types: [],
    readOnly: false,
    tableWidth: 220,
    pan: { x: 0, y: 0 },
    ...initial,
  };
  const applied = [];
  const activity = [];
  const tools = createSchemaPairTools({
    getState: () => state,
    applyChanges: (next, summary) => {
      applied.push(summary);
      state.tables = next.tables;
      state.relationships = next.relationships;
    },
    record: (entry) => activity.push(entry),
  });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const call = async (name, input) => JSON.parse(await byName[name].execute(input));
  return { state, applied, activity, tools, call };
}

test("every call is recorded in the activity trail with a one-line summary", async () => {
  const { call, activity } = harness();
  await call("inspect_schema");
  await call("apply_schema_changes", { operations: "bad" });
  await call("apply_schema_changes", {
    operations: [{ op: "add_table", name: "t", fields: [{ name: "id", type: "INT", primary: true }] }],
  });
  await call("validate_schema");
  await call("generate_sql");
  assert.deepEqual(
    activity.map((e) => [e.tool, e.ok]),
    [
      ["inspect_schema", true],
      ["apply_schema_changes", false],
      ["apply_schema_changes", true],
      ["validate_schema", true],
      ["generate_sql", true],
    ],
  );
  assert.match(activity[2].summary, /added 1 table/);
  assert.equal(activity[3].summary, "no issues found");
  assert.match(activity[4].summary, /generated postgresql SQL \(\d+ lines\)/);
  await call("generate_sample_inserts", { rows: 1 });
  await call("explain_join_path", { from: "t", to: "t" });
  assert.equal(activity[5].summary, "generated sample inserts for 1 table(s)");
  assert.equal(activity[6].ok, false, "same-table join path is an error");
});

test("validate_schema returns ready-to-apply suggestions that fix the issue", async () => {
  const { call } = harness();
  await call("apply_schema_changes", {
    operations: [
      { op: "add_table", name: "users", fields: [{ name: "id", type: "INT", primary: true }] },
      { op: "add_table", name: "orders", fields: [{ name: "user_id", type: "INT" }] },
      { op: "add_relationship", from: { table: "orders", field: "user_id" }, to: { table: "users", field: "id" } },
    ],
  });
  let r = await call("validate_schema");
  assert.equal(r.valid, false);
  assert.equal(r.suggestions.length, 2, JSON.stringify(r.suggestions));
  const fixes = r.suggestions.filter((s) => !s.needsInput).map((s) => s.operation);
  r = await call("apply_schema_changes", { operations: fixes });
  assert.equal(r.ok, true, JSON.stringify(r));
  r = await call("validate_schema");
  assert.equal(r.valid, true);
  assert.equal(r.suggestions.length, 0);
});

test("exposes the thirteen tools with schemas and annotations", () => {
  const { tools } = harness();
  assert.deepEqual(
    tools.map((t) => t.name),
    [
      "inspect_schema",
      "apply_schema_changes",
      "validate_schema",
      "generate_sql",
      "import_sql",
      "review_schema",
      "generate_migration",
      "arrange_tables",
      "plan_removal",
      "removal_status",
      "annotate_diagram",
      "generate_sample_inserts",
      "explain_join_path",
    ],
  );
  for (const tool of tools) {
    assert.equal(typeof tool.description, "string");
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(typeof tool.execute, "function");
  }
  assert.equal(tools[0].annotations.readOnlyHint, true);
  assert.equal(tools[1].annotations, undefined, "the mutating tool carries no readOnlyHint");
  assert.equal(tools[2].annotations.readOnlyHint, true);
  assert.equal(tools[3].annotations.readOnlyHint, true);
});

test("full loop: apply -> inspect -> validate -> fix -> generate_sql", async () => {
  const { call, applied, state } = harness();

  let r = await call("inspect_schema");
  assert.equal(r.ok, true);
  assert.equal(r.tables.length, 0);
  assert.equal(r.readOnly, false);

  r = await call("apply_schema_changes", {
    operations: [
      { op: "add_table", name: "users", fields: [{ name: "id", type: "INT", primary: true }] },
      { op: "add_table", name: "invoices", fields: [{ name: "user_id", type: "INT" }] },
      {
        op: "add_relationship",
        from: { table: "invoices", field: "user_id" },
        to: { table: "users", field: "id" },
      },
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.applied.tables, ["users", "invoices"]);
  assert.equal(applied.length, 1);
  assert.equal(state.tables.length, 2);

  r = await call("validate_schema");
  assert.equal(r.valid, false);
  assert.ok(r.issues.some((i) => /invoices/.test(i) && /primary key/i.test(i)), r.issues);

  r = await call("apply_schema_changes", {
    operations: [
      { op: "add_field", table: "invoices", field: { name: "id", type: "INT", primary: true } },
    ],
  });
  assert.equal(r.ok, true);

  r = await call("validate_schema");
  assert.equal(r.valid, true);
  assert.equal(r.issueCount, 0);

  r = await call("generate_sql");
  assert.equal(r.ok, true);
  assert.equal(r.dialect, "postgresql");
  assert.match(r.sql, /CREATE TABLE (IF NOT EXISTS )?"users"/);
  assert.match(r.sql, /FOREIGN KEY\("user_id"\) REFERENCES "users"\("id"\)/);

  r = await call("generate_sql", { dialect: "sqlite" });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "invalid_request");
});

test("refuses mutations in read-only mode and applies nothing", async () => {
  const { call, applied } = harness({ readOnly: true });
  const r = await call("apply_schema_changes", {
    operations: [{ op: "add_table", name: "t", fields: [{ name: "id", type: "INT" }] }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "read_only");
  assert.equal(applied.length, 0);
  const inspect = await call("inspect_schema");
  assert.equal(inspect.readOnly, true, "read-only state is visible to the agent");
});

test("invalid requests and dry runs never reach applyChanges", async () => {
  const { call, applied } = harness();
  let r = await call("apply_schema_changes", { operations: "nope" });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "invalid_request");
  assert.ok(Array.isArray(r.error.details));

  r = await call("apply_schema_changes", {
    operations: [{ op: "add_field", table: "missing", field: { name: "x", type: "INT" } }],
  });
  assert.equal(r.ok, false);
  assert.match(r.error.details[0].message, /does not exist/);

  r = await call("apply_schema_changes", {
    dryRun: true,
    operations: [{ op: "add_table", name: "t", fields: [{ name: "id", type: "INT" }] }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.deepEqual(r.wouldApply.tables, ["t"]);
  assert.equal(applied.length, 0);
});

test("generic diagrams can target any dialect", async () => {
  const { call } = harness({
    database: "generic",
    tables: [
      {
        id: "t", name: "things", x: 0, y: 0, comment: "", color: "#175e7a", indices: [], uniqueConstraints: [],
        fields: [{ id: "f", name: "id", type: "INT", default: "", check: "", primary: true, unique: false, notNull: true, increment: true, comment: "" }],
      },
    ],
  });
  const pg = await call("generate_sql");
  assert.equal(pg.dialect, "postgresql");
  assert.match(pg.sql, /"things"/);
  const my = await call("generate_sql", { dialect: "mysql" });
  assert.equal(my.dialect, "mysql");
  assert.match(my.sql, /`things`/);
  const bad = await call("generate_sql", { dialect: "cobol" });
  assert.equal(bad.ok, false);
});

test("review_schema, generate_migration and arrange_tables work through the bridge", async () => {
  let baseline = null;
  let arranged = 0;
  const state = {
    database: "postgresql",
    tables: [],
    relationships: [],
    enums: [],
    types: [],
    readOnly: false,
    tableWidth: 220,
    pan: { x: 0, y: 0 },
  };
  const tools = createSchemaPairTools({
    getState: () => state,
    applyChanges: (next) => {
      state.tables = next.tables;
      state.relationships = next.relationships;
    },
    getBaseline: () => baseline,
    setBaseline: (s) => {
      baseline = s;
    },
    arrangeTables: () => {
      arranged += 1;
      return 2;
    },
  });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const call = async (name, input) => JSON.parse(await byName[name].execute(input));

  await call("apply_schema_changes", {
    operations: [
      { op: "add_table", name: "users", fields: [{ name: "id", type: "INT", primary: true }] },
      { op: "add_table", name: "posts", fields: [{ name: "id", type: "INT", primary: true }, { name: "user_id", type: "INT" }] },
      { op: "add_relationship", from: { table: "posts", field: "user_id" }, to: { table: "users", field: "id" } },
    ],
  });

  let r = await call("review_schema");
  assert.equal(r.ok, true);
  assert.equal(r.summary.error, 0);
  assert.ok(r.findings.some((f) => f.code === "fk_without_index" && f.fix));
  assert.ok(r.findings.some((f) => f.code === "nullable_fk"));
  r = await call("review_schema", { severity: "warning" });
  assert.ok(r.findings.every((f) => f.severity !== "hint"));

  r = await call("generate_migration");
  assert.equal(r.ok, true);
  assert.ok(r.changeCount > 0);
  assert.match(r.up, /CREATE TABLE[\s\S]*"posts"/);
  assert.match(r.down, /DROP TABLE/);
  r = await call("generate_migration", { resetBaseline: true });
  assert.equal(r.baselineReset, true);
  r = await call("generate_migration");
  assert.equal(r.changeCount, 0);
  assert.equal(r.up, "");
  r = await call("generate_migration", { dialect: "mysql" });
  assert.equal(r.ok, false);

  r = await call("arrange_tables");
  assert.equal(r.movedTables, 2);
  assert.equal(arranged, 1);
  state.readOnly = true;
  r = await call("arrange_tables");
  assert.equal(r.error.code, "read_only");
});

test("plan_removal never deletes by itself; the bridge owns confirmation", async () => {
  const proposals = new Map();
  const state = {
    database: "postgresql",
    tables: [],
    relationships: [],
    enums: [],
    types: [],
    notes: [],
    areas: [],
    readOnly: false,
    tableWidth: 220,
    pan: { x: 0, y: 0 },
  };
  let annotated = null;
  const tools = createSchemaPairTools({
    getState: () => state,
    applyChanges: (next) => {
      state.tables = next.tables;
      state.relationships = next.relationships;
    },
    proposeRemoval: (plan, reason) => {
      const p = { id: `rm_${proposals.size + 1}`, status: "pending", reason, impact: plan.impact, next: plan.next };
      proposals.set(p.id, p);
      return p;
    },
    getProposal: (id) => proposals.get(id) ?? null,
    addAnnotations: (plan) => {
      annotated = plan;
    },
  });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const call = async (name, input) => JSON.parse(await byName[name].execute(input));

  await call("apply_schema_changes", {
    operations: [
      { op: "add_table", name: "users", fields: [{ name: "id", type: "INT", primary: true }] },
      { op: "add_table", name: "posts", fields: [{ name: "id", type: "INT", primary: true }, { name: "user_id", type: "INT" }] },
      { op: "add_relationship", from: { table: "posts", field: "user_id" }, to: { table: "users", field: "id" } },
    ],
  });

  let r = await call("plan_removal", { targets: [{ kind: "table", table: "users" }], reason: "legacy" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.status, "pending");
  assert.deepEqual(r.impact.tables, [{ name: "users", fieldCount: 1 }]);
  assert.equal(r.impact.relationships.length, 1);
  assert.equal(state.tables.length, 2, "nothing removed");

  r = await call("removal_status", { proposalId: r.proposalId });
  assert.equal(r.status, "pending");
  r = await call("removal_status", { proposalId: "nope" });
  assert.equal(r.error.code, "not_found");

  r = await call("plan_removal", { targets: [{ kind: "table", table: "ghost" }] });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "invalid_request");

  r = await call("annotate_diagram", { areas: [{ name: "Core", tables: ["users", "posts"] }], notes: [{ content: "hi", near: "posts" }] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.annotated, { notes: 1, areas: 1 });
  assert.equal(annotated.areas[0].name, "Core");
  r = await call("annotate_diagram", {});
  assert.equal(r.ok, false);

  r = await call("generate_sample_inserts", { rows: 2 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.tableOrder, ["users", "posts"]);
  assert.match(r.sql, /INSERT INTO "posts"/);
  r = await call("generate_sample_inserts", { rows: 0 });
  assert.equal(r.ok, false);

  r = await call("explain_join_path", { from: "posts", to: "users" });
  assert.equal(r.connected, true);
  assert.equal(r.hops.length, 1);
  assert.match(r.sql, /JOIN "users"/);
  r = await call("explain_join_path", { from: "posts", to: "nope" });
  assert.equal(r.ok, false);

  state.readOnly = true;
  r = await call("plan_removal", { targets: [{ kind: "table", table: "users" }] });
  assert.equal(r.error.code, "read_only");
  r = await call("annotate_diagram", { notes: [{ content: "x" }] });
  assert.equal(r.error.code, "read_only");
});

test("unexpected handler errors are returned as structured failures", async () => {
  const tools = createSchemaPairTools({
    getState: () => {
      throw new Error("boom");
    },
  });
  const r = JSON.parse(await tools[0].execute({}));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "internal_error");
  assert.equal(r.error.message, "boom");
});
