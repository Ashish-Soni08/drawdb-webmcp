# SchemaPair WebMCP Challenge Plan

## 1. Product thesis

SchemaPair is an agent-native database diagramming experience built on drawDB. A human keeps the visual canvas and final control, while an AI agent can inspect the current schema, make bounded schema changes, validate the result, and generate SQL through browser-native WebMCP tools.

The demo should prove one memorable loop:

> Ask an agent to turn a rough data-model request into a visible, valid database diagram and usable SQL—without screen scraping or fragile click automation.

## 2. Why drawDB is a strong base

- It already has the hard product surface: tables, fields, relationships, layout, undo/redo, persistence, validation, import, and SQL export.
- The current source contains no native WebMCP registration or `modelContext` integration.
- WebMCP can expose real application capabilities instead of recreating drawDB as a chat wrapper.
- The fork remains AGPL-3.0 and will clearly attribute drawDB and its contributors.

An unrelated community project named `drawdb-mcp` exists, but it is an external MCP server rather than browser-native WebMCP support in the drawDB application. SchemaPair's differentiator is direct, live interaction with the diagram open in the browser.

## 3. Target user and core story

**Target user:** a developer, founder, or product builder who can describe the data they need but wants help turning it into a sound relational schema.

**Core story:**

1. The user opens SchemaPair with a blank or existing drawDB diagram.
2. The agent reads a compact representation of the live diagram.
3. The user asks for a change, such as adding subscriptions and invoices to a SaaS schema.
4. The agent applies bounded additions or updates through a WebMCP tool.
5. The canvas visibly updates, preserving the normal drawDB experience and undo path.
6. The agent validates the schema and explains any remaining issues.
7. The agent generates SQL for the selected database dialect.

## 4. MVP WebMCP surface

Implement four tools, registered only while the editor is active.

| Tool | Kind | Purpose | MVP guardrails |
| --- | --- | --- | --- |
| `inspect_schema` | Read-only | Return database type, compact tables/fields, relationships, and summary counts. | Bounded output; omit visual-only noise unless requested. |
| `apply_schema_changes` | Mutating | Add tables, fields, indexes, and relationships; update safe schema properties. | Validate IDs/references, cap operation count, no delete operations in MVP, respect read-only mode, make every change visible. |
| `validate_schema` | Read-only | Run drawDB's existing issue detection and return actionable findings. | Reuse `src/utils/issues.js`; bounded structured results. |
| `generate_sql` | Read-only | Generate SQL for the current diagram and selected dialect. | Reuse `src/utils/exportSQL/index.js`; return SQL text but do not execute it or connect to a database. |

Tool names and descriptions will be concise, inputs will use explicit JSON schemas, and responses will be structured for both agent reliability and human readability.

## 5. Integration design

### Placement

Add a small `WebMCPBridge` component inside the editor's existing provider tree, close to `Workspace`, where it can access the live diagram, relationships, types, enums, areas, notes, layout, undo/redo, and read-only state.

### Registration lifecycle

- Feature-detect `document.modelContext` so normal browsers continue to work.
- Register tools after the editor context is ready.
- Use stable handlers backed by refs to avoid stale React state.
- Use an `AbortController` signal to unregister on unmount and prevent duplicate tools during hot reload or navigation.
- Keep all tool effects inside the active diagram; no remote service or extra backend is required for the MVP.

### State changes

- Translate tool input into a validated operation list before touching state.
- Apply the complete operation list as one logical user action where existing APIs allow it.
- Preserve drawDB's undo/autosave behavior and generate collision-safe IDs.
- Reject partial or ambiguous relationship references with a useful error rather than guessing.
- Auto-arrange only newly created content or offer a deterministic placement strategy so the demo remains legible.

### Deployment

- Add the WebMCP-required `Origin-Agent-Cluster: ?1` response header to the Vercel configuration if confirmed by the target browser/runtime test.
- Deploy from the public fork and test the exact production URL in the challenge's supported browser/agent environment.

## 6. Human control and safety

- The canvas is the source of truth: agent changes appear immediately and can be inspected visually.
- No table, field, or relationship deletion tool in the MVP.
- Refuse mutations when the editor is read-only.
- Cap the number of changes in one call and validate names, field types, references, and duplicate IDs.
- Never execute generated SQL or connect to a live database.
- Preserve undo/redo so a human can reverse an agent action.
- Return a concise change summary after every mutation.

If time permits, add a lightweight in-app activity notice showing that a WebMCP action ran. This is polish, not a dependency for the core implementation.

## 7. Explicitly out of scope

- Authentication, accounts, or cloud synchronization.
- Connecting to or executing against a real database.
- A separate chatbot or model embedded inside SchemaPair.
- Destructive schema operations through WebMCP.
- A backend MCP server or compatibility layer for non-WebMCP clients.
- Rebuilding drawDB's editor, importers, exporters, or collaboration system.
- Supporting every possible drawDB option in the first mutation schema.
- Large visual redesigns unrelated to the agent workflow.

These cuts protect the one experience the judges need to see: native agent-to-web-app cooperation on a live visual schema.

## 8. Implementation phases and estimates

### Phase A — baseline and contract (30–45 minutes)

- Finish dependency installation and run the unmodified build/lint baseline.
- Confirm the target WebMCP registration API with a minimal browser probe.
- Document the upstream baseline commit and new-work boundary.
- Define compact tool input/output contracts and example calls.

### Phase B — read capabilities (45–60 minutes)

- Add the bridge and lifecycle-safe registration.
- Implement `inspect_schema`.
- Implement `validate_schema` using the existing issue engine.
- Implement `generate_sql` using the existing exporter.

### Phase C — visible mutation (90–120 minutes)

- Implement schema-operation validation and normalization.
- Implement additive table, field, index, and relationship changes.
- Preserve undo/autosave behavior and deterministic placement.
- Return a structured before/after summary.

### Phase D — verification and hardening (45–75 minutes)

- Test unsupported-browser fallback.
- Test registration cleanup and duplicate-registration prevention.
- Test invalid references, excessive operations, read-only mode, and malformed inputs.
- Run lint and production build.
- Exercise the complete agent workflow against the deployed build.

### Phase E — submission package (60–90 minutes)

- Update README with SchemaPair positioning, WebMCP tool table, local setup, deployment, attribution, license, baseline commit, and exact challenge-period changes.
- Deploy the public build.
- Record a public demo under three minutes with audio.
- Complete the Devpost entry with repository, live URL, video, and testing instructions.

**Expected engineering time:** roughly 4–6 focused hours for the credible MVP, plus submission buffer. A polished activity UI or richer operations would add another 1–2 hours and should only happen after the end-to-end demo works.

## 9. Verification checklist

### Automated/local

- The unmodified baseline status is recorded before product changes.
- Lint passes, or every pre-existing failure is documented separately.
- Production build succeeds.
- Tool contract tests cover valid and invalid input.
- Registration tests cover absent `modelContext`, successful registration, and cleanup.
- Pure schema-operation tests verify that inputs create the expected tables and relationships without corrupting existing data.

### Browser/end-to-end

- The supported agent/browser discovers all four tools on the editor page.
- `inspect_schema` accurately reflects an existing diagram.
- One prompt creates at least two related tables and the canvas visibly updates.
- Undo restores the prior state.
- `validate_schema` reports a deliberately introduced issue and clears after correction.
- `generate_sql` returns valid-looking SQL for the selected dialect.
- Refresh preserves the modified diagram through the app's normal persistence.
- A browser without WebMCP still loads and edits diagrams normally.

## 10. Demo script (target: 2:15–2:40)

1. **0:00–0:20 — Problem:** database diagrams are visual, but agents normally have to guess at the DOM or operate a separate copy of the schema.
2. **0:20–0:35 — Native capability:** show the four discovered WebMCP tools and explain that they call the live app's capabilities.
3. **0:35–1:25 — Build:** ask the agent to inspect a small SaaS schema and add subscriptions, plans, and invoice relationships. Show the visible canvas change.
4. **1:25–1:55 — Verify:** ask the agent to validate the diagram and correct one issue.
5. **1:55–2:20 — Ship:** generate PostgreSQL SQL from the same live diagram.
6. **2:20–2:35 — Human control:** show undo and state that SQL is generated, never executed.

## 11. Submission positioning

**Name:** SchemaPair

**Short description:** Agent-native database diagramming powered by drawDB and WebMCP—design schemas, validate relationships, and generate SQL together on a shared visual canvas.

**README attribution:** SchemaPair is a WebMCP-enabled fork of drawDB. It retains the original project's AGPL-3.0 license and credits the drawDB project and contributors. Challenge-period work is isolated and documented from the upstream baseline commit.

### Judging alignment

- **WebMCP leverage:** the agent uses explicit app tools against live editor state, not DOM automation.
- **Execution:** a complete inspect → modify → validate → generate loop works in the deployed app.
- **Impact:** schema design is common, expensive to get wrong, and naturally benefits from human visual judgment plus agent reasoning.
- **Creativity and ambition:** the browser becomes a shared schema workbench where both human and agent operate on the same artifact.

## 12. Go/no-go gates

1. **Gate 1:** the target environment registers and discovers one minimal tool. If not, stop feature work and resolve compatibility.
2. **Gate 2:** read tools accurately reflect live diagram state. If not, do not start mutation work.
3. **Gate 3:** one additive mutation visibly updates the canvas and remains undoable. This is the MVP's critical proof.
4. **Gate 4:** the complete workflow works on the deployed URL. Only then spend time on visual polish.
5. **Gate 5:** repo, live URL, video, attribution, license, and challenge-period diff are all public and testable before submission.

## 13. Recommended build order

Proceed with the four-tool MVP exactly as scoped. Prioritize the critical path in this order:

`register one tool → inspect live schema → apply one visible additive change → validate → generate SQL → deploy → record demo → polish only if time remains`

