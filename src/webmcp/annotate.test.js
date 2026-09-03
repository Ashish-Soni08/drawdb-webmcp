import { test } from "node:test";
import assert from "node:assert/strict";
import { planAnnotations } from "./annotate.js";

const layout = { tableWidth: 200, pan: { x: 0, y: 0 } };
const state = {
  tables: [
    {
      id: "a",
      name: "users",
      x: 100,
      y: 100,
      comment: "",
      fields: [{ name: "id" }, { name: "email" }],
    },
    {
      id: "b",
      name: "subs",
      x: 400,
      y: 100,
      comment: "",
      fields: [{ name: "id" }],
    },
  ],
  notes: [{ id: 0 }],
  areas: [],
};

test("areas wrap their member tables and notes sit next to a table", () => {
  const r = planAnnotations(
    {
      areas: [{ name: "Billing", tables: ["users", "SUBS"], color: "#ff8800" }],
      notes: [
        {
          title: "Why",
          content: "Subscriptions belong to users.",
          near: "subs",
        },
        { content: "Free note" },
      ],
    },
    state,
    layout,
  );
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const [area] = r.areas;
  assert.equal(area.id, 0);
  assert.equal(area.name, "Billing");
  assert.equal(area.x, 60);
  assert.equal(area.y, 60);
  assert.equal(area.width, 400 + 200 + 40 - 60);
  assert.ok(area.height > 100);
  assert.equal(area.color, "#ff8800");

  const [near, free] = r.notes;
  assert.equal(near.id, 1, "ids continue after existing notes");
  assert.equal(near.x, 400 + 200 + 24);
  assert.equal(near.y, 100);
  assert.equal(near.title, "Why");
  assert.equal(free.id, 2);
  assert.equal(free.title, "note_2");
  assert.equal(free.x, -90);
});

test("rejects empty input, unknown tables, and bad colors", () => {
  assert.equal(planAnnotations({}, state, layout).ok, false);
  const r = planAnnotations(
    {
      areas: [
        { name: "X", tables: ["ghost"] },
        { name: "", tables: ["users"] },
      ],
      notes: [
        { content: "", near: "users" },
        { content: "hi", near: "nope" },
      ],
    },
    state,
    layout,
  );
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 4);
  assert.equal(
    planAnnotations(
      { areas: [{ name: "X", tables: ["users"], color: "red" }] },
      state,
      layout,
    ).ok,
    false,
  );
});
