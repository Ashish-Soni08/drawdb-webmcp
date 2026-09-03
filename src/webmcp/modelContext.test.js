import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getModelContext,
  isWebMCPSupported,
  registerTools,
  toolFailure,
  toolSuccess,
} from "./modelContext.js";

/** Minimal stand-in for Chrome's ModelContext: register + abort-to-unregister. */
function fakeModelContext() {
  const tools = new Map();
  return {
    tools,
    async registerTool(tool, { signal } = {}) {
      if (signal?.aborted) throw new Error("aborted");
      tools.set(tool.name, tool);
      signal?.addEventListener("abort", () => tools.delete(tool.name));
    },
  };
}

test("feature detection is false outside a WebMCP browser", () => {
  assert.equal(getModelContext(), null);
  assert.equal(isWebMCPSupported(), false);
});

test("feature detection prefers document.modelContext over navigator", () => {
  const docCtx = { registerTool() {} };
  const navCtx = { registerTool() {} };
  const hadNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "document", { value: { modelContext: docCtx }, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: { modelContext: navCtx }, configurable: true });
  try {
    assert.equal(getModelContext(), docCtx);
    assert.equal(isWebMCPSupported(), true);
    delete globalThis.document.modelContext;
    assert.equal(getModelContext(), navCtx);
  } finally {
    delete globalThis.document;
    delete globalThis.navigator;
    if (hadNavigator) Object.defineProperty(globalThis, "navigator", hadNavigator);
  }
});

test("registerTools registers under one signal and abort removes all", async () => {
  const ctx = fakeModelContext();
  const controller = new AbortController();
  const tools = [
    { name: "a", execute: async () => "" },
    { name: "b", execute: async () => "" },
  ];
  const names = await registerTools(ctx, tools, { signal: controller.signal });
  assert.deepEqual(names, ["a", "b"]);
  assert.deepEqual([...ctx.tools.keys()], ["a", "b"]);
  controller.abort();
  assert.equal(ctx.tools.size, 0);
});

test("registerTools stops early when the signal is already aborted", async () => {
  const ctx = fakeModelContext();
  const controller = new AbortController();
  controller.abort();
  const names = await registerTools(ctx, [{ name: "a" }], { signal: controller.signal });
  assert.deepEqual(names, []);
  assert.equal(ctx.tools.size, 0);
});

test("results are compact JSON strings", () => {
  assert.deepEqual(JSON.parse(toolSuccess({ x: 1 })), { ok: true, x: 1 });
  assert.deepEqual(JSON.parse(toolFailure("bad", "msg", [1])), {
    ok: false,
    error: { code: "bad", message: "msg", details: [1] },
  });
  assert.deepEqual(JSON.parse(toolFailure("bad", "msg")), {
    ok: false,
    error: { code: "bad", message: "msg" },
  });
});
