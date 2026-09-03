# SchemaPair WebMCP — Progress and Agent Handoff

Last updated: 2026-09-03 21:30 IST — thirteen tools + activity panel with removal confirmation implemented and verified locally; **not committed, not pushed, not deployed**.

## Read this first

This repository is a fork of drawDB being adapted for The WebMCP Challenge. The product name is **SchemaPair**.

Thirteen WebMCP tools and an on-canvas agent-activity panel (with a human-only removal confirmation card) are implemented and verified end-to-end in real Chrome 152 against both the dev server and the production bundle. Remaining work is the submission package (commit, deploy, deployed-URL test, video, Devpost), which needs explicit user approval before pushing/deploying.

Also read `CLAUDE.md` (repo working rules) and `docs/WEBMCP_PLAN.md` (original plan and gates).

## Repository and working location

- GitHub fork: `https://github.com/Ashish-Soni08/drawdb-webmcp`
- Main clone: `G:\AI\Projects\webmcp-challenge\drawdb-webmcp`
- **Feature worktree to use:** `G:\AI\Projects\webmcp-challenge\.worktrees\schemapair-webmcp-0903a`
- Feature branch: `agent/schemapair-webmcp-0903a` (tracks `origin/main`)
- Baseline commit: `5efc5fd10a27241f0844dfd31efff4a9e53a61fb`
- License: AGPL-3.0; retain the license and credit drawDB and its contributors.
- The worktree `.git` file is owned by a different Windows account; `git config --global --add safe.directory` has been added for the worktree and the parent.

## Challenge facts (verified 2026-09-03 from primary sources)

- Rules (webmcp.devpost.com/rules): submissions close **September 3, 2026, 1:00 PM PDT** (= 01:30 IST Sept 4). Judges use the ChatGPT desktop app's built-in browser or Chrome 149+ with `chrome://flags/#enable-webmcp-testing`. Required: public repo with an open-source license, live URL, ≤3-minute YouTube video with narration, text description, tools implemented via `document.modelContext.registerTool()`.
- Chrome docs: API is `document.modelContext`. WebMCP is disabled only in non-origin-isolated documents (`Origin-Agent-Cluster: ?0`); `vercel.json` sends `?1` explicitly as a safeguard.
- Spec IDL: `registerTool(tool, {signal, exposedTo})`, `getTools()`, `executeTool(tool, inputJsonString, {signal})`, `toolchange` event. No `unregisterTool`; abort the signal. Inputs to `executeTool` must be JSON strings; execute receives a parsed object and should return a string.

## Milestones (as agreed with the user)

| Milestone | Status |
| --- | --- |
| MVP (4 tools) | Done, verified |
| Tier 1: activity panel with undo, pan-to-change, validate suggestions | Done, verified |
| Tier 2: `import_sql`, `arrange_tables` | Done, verified |
| Tier 3: `review_schema`, `generate_migration` | Done, verified |
| Extras requested afterwards: `plan_removal` + `removal_status` (human-confirmed delete), `annotate_diagram` (notes/areas), `generate_sample_inserts`, `explain_join_path` | Done, verified |
| Gate 4/5: deploy, deployed-URL test, video, Devpost | **Not done — needs user approval** |

## Baseline (before any changes)

- `npm ci`: clean, 540 packages. Two npm audit advisories are upstream and untouched.
- `npm run lint`: exit 0. `npm run build`: exit 0 (~56s). Pre-existing build warnings only: direct `eval` in `lottie-web`, >500 kB chunk notice.
- Tooling: Node v24.18.0, npm 11.7.0, Chrome 152.0.7977.65 stable at `C:/Program Files/Google/Chrome/Application/chrome.exe`.

## What was built (all challenge-period code; everything else is upstream drawDB)

| File | Purpose |
| --- | --- |
| `src/webmcp/modelContext.js` | Feature detection, `registerTools` under one AbortSignal, `toolSuccess`/`toolFailure` JSON-string results. |
| `src/webmcp/describeSchema.js` | Compact agent-facing view of the diagram (`from` = FK/child side, `to` = referenced side). |
| `src/webmcp/planSchemaChanges.js` | Pure planner/validator for `apply_schema_changes` (add_table/field/index/relationship, update_table/field). Whole-request validation, `LIMITS`, type catalog + alias map, deterministic placement (`placeNewTables`). |
| `src/webmcp/suggestFixes.js` | Ready-to-apply operations for mechanically fixable issues (missing PK, FK without index, ENUM without values). |
| `src/webmcp/reviewSchema.js` | Structured design review (severity/code/table/field/fix). |
| `src/webmcp/generateSql.js` | Wraps `exportSQL` and the generic exporters. |
| `src/webmcp/migration.js` | `snapshotSchema` + `buildMigration` via drawDB's `deepDiff` and `generateMigrationSQL`. |
| `src/webmcp/importSql.js` | `planSqlImport`: node-sql-parser / oracle parser → drawDB `importSQL`, append-only, collision checks, plus `resolveExternalReferences` so FKs to tables already on the canvas are linked. |
| `src/webmcp/planRemoval.js` | Pure impact planner for removals (cascade to relationships, prune indexes/unique constraints); nothing applied here. |
| `src/webmcp/annotate.js` | Plans notes (optionally next to a table) and areas sized around member tables. |
| `src/webmcp/sampleData.js` | Deterministic INSERTs, parents first (Kahn ordering), dialect quoting. |
| `src/webmcp/joinPath.js` | BFS over relationships → hops + SELECT/JOIN skeleton. |
| `src/webmcp/tools.js` | The thirteen tool definitions wired to a `bridge` (`getState`, `applyChanges`, `record`, `getBaseline`/`setBaseline`, `arrangeTables`, `proposeRemoval`/`getProposal`, `addAnnotations`). Read-only mode → `read_only`; exceptions → `internal_error`; every call recorded to the activity trail. |
| `src/components/WebMCPBridge.jsx` | Mounted in `src/pages/Editor.jsx`. Ref-backed state (no stale closures), single registration under an AbortController with a module-level guard, cleanup on unmount. Mutations push one `ObjectType.DBML` snapshot undo entry (tagged `source: "schemapair-agent"`) and commit via `setTables`/`setRelationships`/`setEnums`; `arrange_tables` pushes drawDB's bulk MOVE entry. Pans to and selects changed tables. Captures the migration baseline as "latest state seen with an empty undo stack" (= the loaded diagram). |
| `src/components/WebMCPActivityPanel.jsx` | Floating "Agent activity" trail (only when WebMCP is present) with "Undo last agent change" (enabled only while the agent's entry is the top of the undo stack), Clear, and the **removal confirmation card** (Confirm removal / Reject). Confirm applies the planned state as one snapshot undo step; the agent has no way to confirm. |
| `src/webmcp/*.test.js` (46 tests) | Planner, describe, registration, suggestions, review, migration, import, and tool-level tests (read-only, dry run, activity trail, full loops). `npm test` = Node's runner + `scripts/test-loader.mjs` (resolves extension-less/directory imports, stubs image assets). |
| `scripts/webmcp-e2e.cjs` | Browser harness (Chrome + CDP): `node scripts/webmcp-e2e.cjs <baseUrl> [--no-webmcp] [--headed]`, `CHROME_PATH` override. 57 checks. |
| `README.md`, `vercel.json`, `package.json` (`test` script), `CLAUDE.md` | Docs, `Origin-Agent-Cluster: ?1`, test script, agent rules. |

Not built on purpose: agent-confirmable deletes (removal is proposal-only), overwrite-on-import, a chatbot, backend MCP server, auth, visual redesign.

## Verification results (2026-09-03)

- `npm run lint`: exit 0, zero warnings. `npm test`: 46/46. `npm run build`: exit 0 (same pre-existing warnings as baseline).
- Browser E2E with WebMCP (Chrome 152 headless, `--enable-features=WebMCP`): **57/57** on the dev server and on `vite preview` of the production bundle (21:30 IST). Covers: 13 tools discovered; inspect; non-JSON input rejected by the browser; malformed/missing `operations`; 26-op limit; invalid references (nothing applied); dryRun; apply 3-table SaaS schema + 2 FKs in request order; canvas shows tables, pans to them, activity panel lists the call; validate clean → add table without PK → issue + `add_field` suggestion → fix → clean; import_sql dryRun/apply/collision/parse-error, FK linked to existing `invoices`, undo; review_schema findings with fixes; generate_migration since load and after resetBaseline (only the new column); arrange_tables + panel undo (schema untouched); annotate_diagram (area + note on canvas, panel undo removes the note, Ctrl+Z the area); generate_sample_inserts (parents first); explain_join_path (2 hops users→invoices); plan_removal → pending, nothing removed, card visible → Reject → status rejected → new proposal → click "Confirm removal" → table + FKs gone, status confirmed → Ctrl+Z restores; generate_sql (Postgres DDL with FKs, CASCADE), wrong dialect rejected; Ctrl+Z ×2 / Ctrl+Y; panel "Undo last agent change" + redo; autosave to `/editor/diagrams/<id>`; after reload diagram persisted and exactly 13 tools; landing page unregisters; `/editor` re-registers.
- Fallback (Chrome without the feature, dev and prod): `modelContext` absent, editor renders, no bridge errors.
- Read-only mode: covered by `tools.test.js` (apply/import/arrange/plan_removal/annotate all return `read_only`). drawDB only enters read-only when viewing a shared/historical version, which needs the gist server, so it is not exercised in the browser run.

Screenshots from the last run: `%TEMP%\schemapair-e2e-shots\` (`after-apply.png`, `after-undo-redo.png`, `no-webmcp.png`).

## Known limitations / notes

- Judges may use the ChatGPT desktop browser; only Chrome was available here. Re-test on the deployed URL in whichever environment is available.
- Migration baseline: for a brand-new diagram, the first autosave navigates to `/editor/diagrams/<id>` and reloads it, which resets undo history; the baseline then becomes that first-saved state. Afterwards it is stable. Use `resetBaseline: true` to move it deliberately.
- Removal proposals live in component state; a page reload discards a pending proposal (the agent gets `not_found` from removal_status). Decided proposals are kept in a module-level map for the session.
- Notes/areas use drawDB's per-item ADD undo entries, so one annotate call with N items is N undo steps (matching how the editor itself behaves).
- Undo of an agent snapshot entry via Ctrl+Z goes through drawDB's `swapDbmlSnapshot` (diff by id); redo re-creates tables through `addTable`, so table order after a redo can differ. Cosmetic.
- `import_sql` skips PostgreSQL composite `CREATE TYPE`s (warning returned); enums are imported. Oracle DDL does not get external-FK resolution.
- Command-line flag is `--enable-features=WebMCP`; the chrome://flags entry is `#enable-webmcp-testing`.
- Shell gotchas for the next agent: write JS with the Write/Edit tools, not `node -e` heredocs (backticks and apostrophes get mangled); never pipe the Vite dev server through `head`.

## Current Git state

- Branch: `agent/schemapair-webmcp-0903a`, **no commits made**.
- Modified: `README.md`, `package.json`, `src/pages/Editor.jsx`, `vercel.json`.
- Untracked: `CLAUDE.md`, `docs/`, `progress.MD`, `scripts/`, `src/components/WebMCPBridge.jsx`, `src/components/WebMCPActivityPanel.jsx`, `src/webmcp/` (13 modules + 9 test files).

## Next steps (steps 2–5 need user approval)

1. Optionally re-run `npm test && npm run lint && npm run build`.
2. Commit on the feature branch (suggested: "Add SchemaPair WebMCP tools, agent activity panel, and human-confirmed removals").
3. Push and deploy the fork (Vercel config ready). Confirm the deployed response carries `Origin-Agent-Cluster: ?1`.
4. Test the deployed URL: `node scripts/webmcp-e2e.cjs https://<deployed-host>` (headless Chrome) and manually in Chrome with the flag / the Model Context Tool Inspector extension, plus the ChatGPT desktop browser if available.
5. Record the ≤3-minute demo (script in `docs/WEBMCP_PLAN.md` §10, now with review/import/migration beats), fill in Devpost. Reconfirm the deadline first.

## Product identity for public materials

- **Name:** SchemaPair
- **Repository:** `drawdb-webmcp`
- **Short description:** Agent-native database diagramming powered by drawDB and WebMCP—design schemas, validate relationships, and generate SQL together on a shared visual canvas.
- **Attribution wording:** SchemaPair is a WebMCP-enabled fork of drawDB. It retains the original project's AGPL-3.0 license and credits the drawDB project and contributors.
