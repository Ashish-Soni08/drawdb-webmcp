/**
 * Thin, dependency-free access layer for the WebMCP `ModelContext` API.
 *
 * Verified against Chrome 152 (`--enable-features=WebMCP`) on 2026-09-03:
 * - the API hangs off `document.modelContext` (the older `navigator.modelContext`
 *   alias is kept as a fallback only),
 * - `registerTool(tool, { signal })` resolves to `undefined`,
 * - there is no `unregisterTool`; aborting the signal removes the tool,
 * - `execute(input, { signal })` receives an already-parsed object and its
 *   return value is handed back to the agent verbatim, so tools return strings.
 */

/** Returns the ModelContext object, or `null` when the browser has no WebMCP. */
export function getModelContext() {
  if (typeof document !== "undefined" && document.modelContext) {
    return document.modelContext;
  }
  if (typeof navigator !== "undefined" && navigator.modelContext) {
    return navigator.modelContext;
  }
  return null;
}

/** True when a usable `registerTool` exists. Ordinary browsers return false. */
export function isWebMCPSupported() {
  const modelContext = getModelContext();
  return (
    Boolean(modelContext) && typeof modelContext.registerTool === "function"
  );
}

/**
 * Registers every tool sequentially under one AbortSignal so a single
 * `controller.abort()` unregisters all of them. Stops early if the signal is
 * aborted mid-way (React StrictMode remounts, route changes, hot reload).
 *
 * @returns {Promise<string[]>} names that were actually registered
 */
export async function registerTools(modelContext, tools, { signal }) {
  const registered = [];
  for (const tool of tools) {
    if (signal?.aborted) break;
    await modelContext.registerTool(tool, { signal });
    registered.push(tool.name);
  }
  return registered;
}

/** Serializes a successful tool result. Every tool returns `{ ok: true, ... }`. */
export function toolSuccess(data) {
  return JSON.stringify({ ok: true, ...data });
}

/**
 * Serializes a failed tool result. Errors are returned, not thrown, so the
 * agent always receives structured, actionable feedback.
 */
export function toolFailure(code, message, details) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  return JSON.stringify({ ok: false, error });
}
