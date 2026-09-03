# SchemaPair — Devpost submission kit

Deadline: originally September 3, 2026, 1:00 PM PDT; Devpost granted everyone a 12-hour extension, so **September 4, 2026, 1:00 AM PDT** (= 13:30 IST on September 4). Reconfirm on the Devpost page before submitting.

## Links

- Live app: https://schemapair.vercel.app/editor
- Repository (AGPL-3.0, public): https://github.com/Ashish-Soni08/drawdb-webmcp
- Video: _paste the public YouTube link here_

## Text description (paste into Devpost)

**SchemaPair: agent-native database diagramming, built on drawDB and WebMCP.**

Database diagrams are visual, but today an AI agent can only "help" by guessing at the DOM or working on a separate copy of your schema. SchemaPair turns the drawDB editor into a shared workbench: the human keeps the canvas, undo, and the final say, and the agent gets sixteen real capabilities of the app through `document.modelContext.registerTool()`.

**Why WebMCP fits.** Schema design is a tight loop of inspect → change → validate → generate. Every step already exists as application logic inside drawDB (its validator, its SQL exporters, its SQL importer, its migration generator). WebMCP lets us expose those exact functions to the agent in the page, against the live editor state, instead of rebuilding them behind a chatbot or scraping the UI.

**What humans and agents can now do together.**
- Ask for a schema in plain language ("add plans and subscriptions and link them to users") and watch the tables and foreign keys appear on the canvas, panned into view, as one undoable step.
- Validate and repair: `validate_schema` and `review_schema` return findings with ready-to-apply fixes; the agent applies them and the Problems count drops to zero.
- Bring existing DDL in with `import_sql`, generate `CREATE TABLE` SQL, migration up/down scripts since the diagram was opened, sample INSERTs, and join-path SQL between any two tables.
- Check whether an existing SQL query still works against the schema, with index suggestions.
- Annotate the diagram with notes and grouped areas, tidy the layout, or open saved diagrams and templates.
- Removals are proposal-only: the agent calls `plan_removal`, the editor shows the full cascade (relationships, indexes) on a confirmation card, and only a human click applies it. The agent cannot confirm.
- An "Agent activity" panel lists every tool call with an "Undo last agent change" button.

**Implementation overview.** A single `WebMCPBridge` React component mounted in the editor registers the tools under one `AbortController` (feature-detected; browsers without WebMCP get plain drawDB). Handlers read live state through refs, validate whole requests before touching state, and commit changes as one snapshot entry on drawDB's own undo stack, so autosave, Ctrl+Z and the timeline all work unchanged. Pure planners (`src/webmcp/*.js`) are unit-tested with Node's test runner (52 tests); a Chrome DevTools-Protocol harness runs the complete workflow in a real WebMCP-enabled Chrome (64 checks) against the dev server, the production bundle and the deployed URL. Generated SQL is text only and is never executed.

**Attribution.** SchemaPair is a WebMCP-enabled fork of drawDB. It retains the AGPL-3.0 license and credits the drawDB project and its contributors. All challenge-period work starts at upstream commit `5efc5fd` and lives in `src/webmcp/`, `src/components/WebMCPBridge.jsx`, `src/components/WebMCPActivityPanel.jsx`, `scripts/`, and `docs/`.

## Testing instructions for judges

1. Open https://schemapair.vercel.app/editor in the ChatGPT desktop app's browser, or in Chrome 149+ with `chrome://flags/#enable-webmcp-testing` enabled (the Model Context Tool Inspector extension lists and calls the tools by hand).
2. Choose **PostgreSQL** when asked for a database.
3. Try, in order:
   - "Inspect the schema open in SchemaPair."
   - "Create a SaaS billing schema: users, plans, subscriptions, invoices, with foreign keys."
   - "Validate the diagram and apply the safe fixes."
   - "Generate the PostgreSQL SQL and the migration since I opened the diagram."
   - "Show me how to join users to invoices, and give me sample INSERTs."
   - "Remove the invoices table." → click **Confirm removal** (or Reject) in the Agent activity panel.
   - Press Ctrl+Z to undo any agent change.
4. Reload the page: the diagram persists (local IndexedDB), and the tools re-register.

## 3-minute video script (target 2:30–2:45, narrate over screen recording)

| Time | On screen | Say |
| --- | --- | --- |
| 0:00–0:15 | Empty SchemaPair editor, Agent activity panel visible | "Database diagrams are visual, so agents usually have to guess at the DOM. SchemaPair is drawDB with sixteen WebMCP tools, so the agent works on the same live canvas you do." |
| 0:15–0:30 | Tool inspector or agent listing tools | "The tools are registered with document.modelContext, feature-detected, and cleaned up when you leave the editor." |
| 0:30–1:10 | Prompt: build the SaaS schema; canvas pans, tables and FKs appear, toast + activity entry | "One prompt, four tables and three foreign keys. Every change is validated before it touches the canvas, and it lands as a single undo step." |
| 1:10–1:35 | Prompt: validate and fix; Problems badge goes to 0 | "Validate reuses drawDB's own checks and returns ready-made fixes. The agent applies them; nothing is guessed." |
| 1:35–1:55 | Prompt: generate SQL + migration; show output | "SQL and up/down migrations come from drawDB's exporters. Text only, never executed." |
| 1:55–2:20 | Prompt: remove invoices; confirmation card; click Confirm; then Ctrl+Z | "Deletes are proposal-only. The agent shows the cascade, and only I can confirm. And it's still undoable." |
| 2:20–2:40 | Reload page, tools re-register, diagram persists; close on README tool table | "Works in Chrome and the ChatGPT browser, degrades to plain drawDB elsewhere. Fork on GitHub, AGPL, credits to drawDB." |

Recording tips: 1080p, Chrome with the flag enabled, hide bookmarks bar, use the Model Context Tool Inspector or the ChatGPT browser as the agent, keep the Agent activity panel expanded.
