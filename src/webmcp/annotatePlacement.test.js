import { test } from "node:test";
import assert from "node:assert/strict";
import { planAnnotations } from "./annotate.js";

const layout = { tableWidth: 200, pan: { x: 0, y: 0 } };
const table = (id, name, x, y) => ({
  id,
  name,
  x,
  y,
  comment: "",
  fields: [{ name: "id" }, { name: "a" }, { name: "b" }],
});

test("a note near a table avoids covering a neighbouring table", () => {
  // invoices sits immediately to the right of subscriptions (compact layout),
  // so the note must not be dropped on top of it.
  const state = {
    tables: [table("s", "subscriptions", 0, 0), table("i", "invoices", 260, 0)],
    notes: [],
    areas: [],
  };
  const r = planAnnotations(
    { notes: [{ content: "Billing periods", near: "subscriptions" }] },
    state,
    layout,
  );
  assert.equal(r.ok, true);
  const [note] = r.notes;
  const invoices = { x: 260, y: 0, width: 200, height: 165 };
  const overlaps =
    note.x < invoices.x + invoices.width &&
    note.x + note.width > invoices.x &&
    note.y < invoices.y + invoices.height &&
    note.y + note.height > invoices.y;
  assert.equal(overlaps, false, `note at ${note.x},${note.y} covers invoices`);
  assert.equal(note.x, 0, "falls back to the slot below the table");
  assert.ok(note.y > 100);
});

test("two notes near the same table do not stack on each other", () => {
  const state = {
    tables: [table("s", "subscriptions", 0, 0)],
    notes: [],
    areas: [],
  };
  const r = planAnnotations(
    {
      notes: [
        { content: "one", near: "subscriptions" },
        { content: "two", near: "subscriptions" },
      ],
    },
    state,
    layout,
  );
  assert.equal(r.ok, true);
  const [a, b] = r.notes;
  assert.notDeepEqual([a.x, a.y], [b.x, b.y]);
});
