# CLAUDE.md — working rules for this repository

SchemaPair is a WebMCP-enabled fork of [drawDB](https://github.com/drawdb-io/drawdb)
(AGPL-3.0). Everything that is not under `src/webmcp/`, `src/components/WebMCPBridge.jsx`,
`scripts/`, or the docs is upstream drawDB code. Keep the upstream footprint minimal and
never remove the license or attribution.

Read `progress.MD` first in every session; it is the hand-off document. Keep it current.

## Stack and commands

- Vite + React 18, plain JavaScript (`.jsx`), Tailwind, Semi UI (`@douyinfe/semi-ui`).
- `npm run dev` (Vite), `npm run build` (production), `npm run lint` (ESLint, zero warnings
  allowed), `npm test` (Node's built-in test runner for `src/webmcp/**/*.test.js`).
- Node 24 / npm 11. Tests run without a bundler thanks to `scripts/test-loader.mjs`, which
  resolves the app's extension-less imports. Only import browser-free modules from tests.

## Code style (match upstream drawDB)

- Prettier defaults: 2-space indent, double quotes, trailing commas, semicolons, ~80 cols.
- ES modules, named exports for utilities, default export for React components.
- React: function components + hooks; contexts live in `src/context/`, thin hooks in
  `src/hooks/` (`useDiagram`, `useUndoRedo`, `useLayout`, ...). Consume state through
  those hooks, never by importing a context provider's internals.
- Data shapes are defined by `src/data/schemas.js` (table/field/index/relationship) and
  `src/data/constants.js` (`DB`, `Action`, `ObjectType`, `Cardinality`, `Constraint`).
  Use `nanoid()` for table/field/relationship ids; index ids are positional integers.
- Type validity comes from `dbToTypes[database]` in `src/data/datatypes.js`; do not
  hard-code type lists.
- Comments explain *why* and non-obvious invariants, not what the code already says.
- Every user-visible string goes through `t()` with a key in `src/i18n/locales/en.js`
  (WebMCP keys are prefixed `webmcp_`). Tool results returned to the agent are English
  JSON, with one deliberate exception: `validate_schema.issues` and `review_schema`
  "validator" findings reuse drawDB's `getIssues()` messages, which follow the editor's
  language so they match the Problems panel. The structured `suggestions`/`fix` fields are
  locale-independent; agents should key off those. Tests force `i18n` to English.
- Run `npx prettier --write` on files you touch; CI only runs lint + build, but the repo
  ships a Prettier config and upstream expects it.

## Editor state rules (important)

- The React contexts are the single source of truth. Never keep a parallel copy of the
  diagram; read live state through refs when handlers outlive a render.
- Every mutation must be undoable. Either push the matching entry drawDB expects (see the
  `undo`/`redo` handlers in `src/components/EditorHeader/ControlPanel.jsx`) or, for a
  multi-step change, push one `ObjectType.DBML` snapshot entry
  (`{ action: Action.EDIT, element: ObjectType.DBML, data: { snapshot: { tables,
  relationships, enums } }, message }`) — that is what makes one agent call one undo step.
- Autosave is triggered by changes to the undo stack; do not write to IndexedDB directly.
- Respect `layout.readOnly` before mutating anything.
- Relationship semantics: `startTableId/startFieldId` is the child (FK column),
  `endTableId/endFieldId` is the referenced parent. Index `fields` are field *names*.

## WebMCP rules (`src/webmcp/`)

- Feature-detect `document.modelContext` (fallback `navigator.modelContext`); the app must
  behave identically when it is absent.
- Register only from `WebMCPBridge` (mounted in `src/pages/Editor.jsx`), under one
  `AbortController`; abort on unmount. Never register the same tool twice.
- `execute` receives a parsed object and must return a **string**; use `toolSuccess` /
  `toolFailure` from `modelContext.js`. Return errors, do not throw.
- Validate a whole request before touching state (`planSchemaChanges`), enforce `LIMITS`,
  and reject ambiguous names instead of guessing. No delete operations in the MVP.
- Never execute generated SQL or contact a database. Keep tool I/O compact and structured.
- Keep tool names/descriptions stable; agents and the demo depend on them. Current tools:
  `inspect_schema`, `apply_schema_changes`, `validate_schema`, `generate_sql`, `import_sql`,
  `review_schema`, `generate_migration`, `arrange_tables`, `plan_removal`, `removal_status`,
  `annotate_diagram`, `generate_sample_inserts`, `explain_join_path`, `check_query`,
  `list_workspace`, `open_diagram`, `checkpoint`.
- Destructive changes are proposal-only: `plan_removal` computes impact and shows a card in
  the activity panel; only a human click in `WebMCPActivityPanel` applies it. Never add a
  tool parameter that lets an agent confirm a removal.
- Every tool call goes through `guard()` in `tools.js`, which records it in the activity
  panel; tag agent undo entries with `source: "schemapair-agent"` so the panel's undo works.
- Browser verification: `node scripts/webmcp-e2e.cjs <baseUrl>` (add `--no-webmcp` for the
  fallback run). Extend it when you add a tool; the expected tool list is alphabetical.

## Verification bar

A change is done only when: `npm run lint`, `npm test`, and `npm run build` pass, and the
inspect → apply → validate → generate_sql → undo loop has been exercised in a real WebMCP
browser (Chrome 149+ with `--enable-features=WebMCP` or `chrome://flags/#enable-webmcp-testing`).
Pre-existing upstream build warnings (lottie `eval`, chunk size) are not ours to fix.

## Do not

- Push, deploy, open PRs, or submit anywhere without explicit user approval.
- Refactor or restyle upstream drawDB code beyond what the feature needs.
- Add a test framework or heavy dependencies; Node's test runner is enough.
