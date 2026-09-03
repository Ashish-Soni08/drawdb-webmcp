<div align="center">
    <h1>SchemaPair</h1>
    <h3>Agent-native database diagramming powered by drawDB and WebMCP</h3>
</div>

SchemaPair is a WebMCP-enabled fork of [drawDB](https://github.com/drawdb-io/drawdb), built for [The WebMCP Challenge](https://webmcp.devpost.com/). It keeps the full drawDB editor and adds thirteen browser-native [WebMCP](https://developer.chrome.com/docs/ai/webmcp) tools, so an AI agent running in the browser can inspect the diagram that is open on the canvas, make bounded schema changes, validate the result, and generate SQL — while the human keeps the visual canvas, undo, and final control.

SchemaPair retains the original project's **AGPL-3.0 license** and credits the drawDB project and its contributors. Challenge-period work starts at upstream commit `5efc5fd10a27241f0844dfd31efff4a9e53a61fb`; everything added for the challenge lives in `src/webmcp/`, `src/components/WebMCPBridge.jsx`, `scripts/`, `docs/`, and the three-line mount in `src/pages/Editor.jsx` (plus `vercel.json` headers and the `test` script).

### WebMCP tools

Registered on `document.modelContext` only while the editor route is open, and only in browsers that support WebMCP. Every other browser gets plain drawDB.

| Tool | Kind | What it does |
| --- | --- | --- |
| `inspect_schema` | read-only | Compact view of the live diagram: database type, tables, columns, indexes, relationships, counts. Optional `tables` filter. |
| `apply_schema_changes` | mutating | Adds tables, columns, indexes, and relationships, or updates safe properties. The whole request is validated first; on any error nothing changes. Max 25 operations per call, `dryRun` supported. Every call is one undo step and the canvas pans to the change. |
| `validate_schema` | read-only | Runs drawDB's built-in issue engine and returns ready-to-apply `suggestions` (operations) for mechanically fixable problems. |
| `review_schema` | read-only | Design review beyond hard errors: foreign keys without indexes, nullable FKs, missing timestamps, unsized VARCHARs, isolated tables, naming. Each finding has a severity and, where safe, a `fix` operation. |
| `generate_sql` | read-only | Generates DDL for the diagram's dialect (or any dialect for generic diagrams). Text only — never executed. |
| `generate_migration` | read-only | Up/down migration SQL between the diagram as loaded (or the last `resetBaseline`) and its current state, via drawDB's migration generator. |
| `generate_sample_inserts` | read-only | Deterministic `INSERT` statements with sample rows, parents before children so foreign keys resolve. |
| `explain_join_path` | read-only | Shortest chain of foreign keys between two tables plus a `SELECT … JOIN` skeleton. |
| `import_sql` | mutating | Imports `CREATE TABLE` DDL as new tables and relationships using drawDB's SQL importer. Append-only, rejects name collisions, links foreign keys to tables already on the canvas, one undo step. |
| `annotate_diagram` | mutating | Adds sticky notes (optionally next to a table) and subject areas sized to wrap the tables they group. Undoable. |
| `arrange_tables` | mutating (layout only) | Auto-arranges tables with the editor's layout engine. One undo step. |
| `plan_removal` | proposal | Proposes removing tables, columns, relationships, or indexes and returns the full cascade impact. **Nothing is deleted**: a confirmation card appears in the editor and only the human can click Confirm (or Reject). Confirmed removals are one undo step. |
| `removal_status` | read-only | Reports whether a proposal is pending, confirmed, rejected, or superseded. |

An **Agent activity** panel on the canvas lists every tool call, hosts the removal confirmation card, and offers an "Undo last agent change" button, so the human always sees and controls what the agent did.

### Try it with an agent

1. Open the editor in a WebMCP-capable browser: the ChatGPT desktop app's built-in browser, or Chrome 149+ with `chrome://flags/#enable-webmcp-testing` enabled (the [Model Context Tool Inspector](https://github.com/beaufortfrancois/model-context-tool-inspector) extension lets you call the tools by hand).
2. Pick a database (PostgreSQL works best for the demo) or open an existing diagram.
3. Prompts that exercise the whole loop:
   - "Inspect the schema currently open in SchemaPair."
   - "Add `plans` and `subscriptions` tables for a SaaS product and link subscriptions to users and plans."
   - "Validate the diagram and fix any problems you find."
   - "Review the schema and apply the safe fixes."
   - "Import this DDL: CREATE TABLE payments (...) and link it to invoices."
   - "Generate the PostgreSQL SQL for this diagram, and the migration since I opened it."
   - "Add sample data inserts and show me how to join users to invoices."
   - "Group the billing tables into an area and add a note explaining invoices."
   - "Remove the invoices table." (the agent proposes; you confirm in the Agent activity panel)
   - "Tidy up the layout."
   - Press Ctrl+Z on the canvas to undo the agent's last change.

### Local development and tests

```bash
npm ci
npm run dev      # http://localhost:5173/editor
npm test         # unit tests for the WebMCP layer (Node test runner)
npm run lint
npm run build
```

To test the WebMCP tools locally without the flag UI, launch Chrome with `--enable-features=WebMCP`. The deployed build sends `Origin-Agent-Cluster: ?1` (see `vercel.json`) because WebMCP is only available in origin-isolated documents.

---

<div align="center">
    <img width="64" alt="drawDB logo" src="./src/assets/icon-dark.png">
    <h1>drawDB</h1>
</div>

<h3 align="center">Free, simple, and intuitive database schema editor and SQL generator.</h3>

<div align="center" style="margin-bottom:12px;">
    <a href="https://drawdb.app/" style="display: flex; align-items: center;">
        <img src="https://img.shields.io/badge/Start%20building-grey" alt="drawDB"/>
    </a>
    <a href="https://discord.gg/BrjZgNrmR6" style="display: flex; align-items: center;">
        <img src="https://img.shields.io/discord/1196658537208758412.svg?label=Join%20the%20Discord&logo=discord" alt="Discord"/>
    </a>
    <a href="https://x.com/drawDB_" style="display: flex; align-items: center;">
        <img src="https://img.shields.io/badge/Follow%20us%20on%20X-blue?logo=X" alt="Follow us on X"/>
    </a>
</div>

<h3 align="center"><img width="700" style="border-radius:5px;" alt="drawDB screenshot demo" src="drawdb.png"></h3>

DrawDB is a robust and user-friendly database entity relationship diagram (ERD) editor right in your browser. Build diagrams with a few clicks, export and import SQL scripts, generate migrations, customize your editor, and more without creating an account. See the full set of features on [here](https://drawdb.app/).

## Getting Started

### Local Development

```bash
git clone https://github.com/drawdb-io/drawdb
cd drawdb
npm install
npm run dev
```

### Build

```bash
git clone https://github.com/drawdb-io/drawdb
cd drawdb
npm install
npm run build
```

### Docker Build

```bash
docker build -t drawdb .
docker run -p 3000:80 drawdb
```

If you want to enable sharing, set up the [server](https://github.com/drawdb-io/drawdb-server) and environment variables according to `.env.sample`. This is optional unless you need to share files.

## Contributing

Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to contribute to this project.

## Support
- Join discussions: [Discord](https://discord.gg/BrjZgNrmR6)
