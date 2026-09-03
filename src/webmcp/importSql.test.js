import { test } from "node:test";
import assert from "node:assert/strict";
import { planSqlImport } from "./importSql.js";

const layout = { tableWidth: 220, pan: { x: 0, y: 0 } };

const DDL = `
CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE
);
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  total NUMERIC(10,2) NOT NULL DEFAULT 0
);
`;

test("imports PostgreSQL DDL into tables and relationships, appended after existing ones", () => {
  const existing = {
    database: "postgresql",
    enums: [],
    relationships: [],
    tables: [{ id: "t0", name: "users", x: 0, y: 0, fields: [], indices: [], comment: "" }],
  };
  const r = planSqlImport({ sql: DDL }, existing, layout);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.dialect, "postgresql");
  assert.deepEqual(r.next.tables.map((t) => t.name), ["users", "customers", "orders"]);
  assert.equal(r.next.relationships.length, 1);
  const fk = r.next.relationships[0];
  const orders = r.next.tables[2];
  assert.equal(fk.startTableId, orders.id);
  assert.equal(fk.endTableId, r.next.tables[1].id);
  assert.equal(fk.deleteConstraint, "Cascade");
  assert.ok(orders.x > 0, "placed to the right of the existing table");
  assert.deepEqual(r.summary.tables, ["customers", "orders"]);
  assert.equal(existing.tables.length, 1, "input not mutated");
});

test("links foreign keys to tables that already exist on the canvas", () => {
  const existing = {
    database: "postgresql",
    enums: [],
    relationships: [],
    tables: [
      {
        id: "inv",
        name: "invoices",
        x: 0,
        y: 0,
        comment: "",
        indices: [],
        fields: [{ id: "inv_id", name: "id", type: "INTEGER", primary: true, unique: false }],
      },
    ],
  };
  const sql = `
    CREATE TABLE payments (
      id SERIAL PRIMARY KEY,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      amount_cents INTEGER NOT NULL
    );
    CREATE TABLE refunds (
      id SERIAL PRIMARY KEY,
      payment_id INTEGER NOT NULL,
      invoice_id INTEGER,
      CONSTRAINT fk_refund_payment FOREIGN KEY (payment_id) REFERENCES payments(id),
      CONSTRAINT fk_refund_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON UPDATE CASCADE
    );`;
  const r = planSqlImport({ sql }, existing, layout);
  assert.equal(r.ok, true, r.message);
  const names = r.next.relationships.map((x) => x.name).sort();
  assert.deepEqual(names, [
    "fk_payments_invoice_id_invoices",
    "fk_refunds_invoice_id_invoices",
    "fk_refunds_payment_id_payments",
  ]);
  const toInvoices = r.next.relationships.find((x) => x.name === "fk_payments_invoice_id_invoices");
  assert.equal(toInvoices.endTableId, "inv");
  assert.equal(toInvoices.endFieldId, "inv_id");
  assert.equal(toInvoices.deleteConstraint, "Cascade");
  assert.equal(toInvoices.cardinality, "many_to_one");
  const refundInvoice = r.next.relationships.find((x) => x.name === "fk_refunds_invoice_id_invoices");
  assert.equal(refundInvoice.updateConstraint, "Cascade");
  assert.equal(r.summary.relationships.length, 3);
});

test("rejects empty, unparsable, colliding, and wrong-dialect input", () => {
  const diagram = {
    database: "postgresql",
    enums: [],
    relationships: [],
    tables: [{ id: "t0", name: "orders", x: 0, y: 0, fields: [], indices: [], comment: "" }],
  };
  assert.equal(planSqlImport({}, diagram, layout).ok, false);
  assert.equal(planSqlImport({ sql: "   " }, diagram, layout).ok, false);

  const bad = planSqlImport({ sql: "CREATE TABLE (" }, diagram, layout);
  assert.equal(bad.ok, false);
  assert.match(bad.message, /parse error/i);

  const collision = planSqlImport({ sql: DDL }, diagram, layout);
  assert.equal(collision.ok, false);
  assert.match(collision.message, /already exist.*orders/);

  const wrong = planSqlImport({ sql: DDL, dialect: "mysql" }, diagram, layout);
  assert.equal(wrong.ok, false);
  assert.match(wrong.message, /targets postgresql/);

  const none = planSqlImport({ sql: "SELECT 1;" }, { ...diagram, tables: [] }, layout);
  assert.equal(none.ok, false);
  assert.match(none.message, /No CREATE TABLE/);
});

test("generic diagrams default to PostgreSQL syntax and accept a dialect", () => {
  const diagram = { database: "generic", enums: [], relationships: [], tables: [] };
  const pg = planSqlImport({ sql: DDL }, diagram, layout);
  assert.equal(pg.ok, true, pg.message);
  assert.equal(pg.dialect, "postgresql");
  const my = planSqlImport(
    { sql: "CREATE TABLE t (id INT PRIMARY KEY, name VARCHAR(50));", dialect: "mysql" },
    diagram,
    layout,
  );
  assert.equal(my.ok, true, my.message);
  assert.equal(my.next.tables[0].fields[1].type, "VARCHAR");
});
