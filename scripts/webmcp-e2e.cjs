// End-to-end WebMCP workflow test for SchemaPair. Launches Chrome with the
// WebMCP feature enabled, drives it over the DevTools protocol, and runs the
// inspect -> apply -> validate -> generate_sql -> undo/redo -> reload loop.
//
// Usage: node scripts/webmcp-e2e.cjs <baseUrl> [--headed] [--no-webmcp]
//   baseUrl     e.g. http://127.0.0.1:5173 (npm run dev) or a deployed URL
//   --no-webmcp launches Chrome without the feature to check the fallback
//   CHROME_PATH env var overrides the Chrome executable location
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

const DEFAULT_CHROME = {
  win32: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  linux: "/usr/bin/google-chrome",
};
const CHROME =
  process.env.CHROME_PATH ||
  DEFAULT_CHROME[process.platform] ||
  DEFAULT_CHROME.linux;
const base = process.argv[2] || "http://127.0.0.1:5180";
const headed = process.argv.includes("--headed");
const noWebmcp = process.argv.includes("--no-webmcp");
const port = 9400 + Math.floor(Math.random() * 100);
const os = require("os");
const udd = path.join(os.tmpdir(), "schemapair-e2e-profile-" + port);
const shots = path.join(os.tmpdir(), "schemapair-e2e-shots");
fs.mkdirSync(shots, { recursive: true });

const args = [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${udd}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-sync",
  "--window-size=1500,950",
  "about:blank",
];
if (!noWebmcp) args.unshift("--enable-features=WebMCP");
if (!headed) args.unshift("--headless=new");
const chrome = spawn(CHROME, args, { stdio: "ignore" });

const getJSON = (p) =>
  new Promise((res, rej) =>
    http
      .get(`http://127.0.0.1:${port}${p}`, (r) => {
        let d = "";
        r.on("data", (c) => (d += c));
        r.on("end", () => {
          try {
            res(JSON.parse(d));
          } catch (e) {
            rej(e);
          }
        });
      })
      .on("error", rej),
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, info) {
  results.push({ name, pass: Boolean(pass), info });
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${name}${info !== undefined ? "  -> " + JSON.stringify(info).slice(0, 300) : ""}`,
  );
}

(async () => {
  let targets;
  for (let i = 0; i < 50; i++) {
    try {
      targets = await getJSON("/json");
      break;
    } catch {
      await sleep(200);
    }
  }
  if (!targets) throw new Error("chrome did not start");
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const consoleLog = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === "Runtime.consoleAPICalled") {
      consoleLog.push(
        `[${msg.params.type}] ` +
          msg.params.args.map((a) => a.value ?? a.description).join(" "),
      );
    } else if (msg.method === "Runtime.exceptionThrown") {
      consoleLog.push(
        "[exception] " +
          JSON.stringify(
            msg.params.exceptionDetails.exception?.description ??
              msg.params.exceptionDetails.text,
          ),
      );
    }
  };
  await new Promise((r) => (ws.onopen = r));
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: 30000,
    });
    if (r.result?.exceptionDetails)
      throw new Error(
        "evaluate failed: " +
          JSON.stringify(
            r.result.exceptionDetails.exception?.description ??
              r.result.exceptionDetails,
          ),
      );
    return r.result?.result?.value;
  };
  const shot = async (name) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(
      path.join(shots, name + ".png"),
      Buffer.from(r.result.data, "base64"),
    );
  };
  const key = async (keyName, code, vk, modifiers) => {
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: keyName,
      code,
      windowsVirtualKeyCode: vk,
      modifiers,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: keyName,
      code,
      windowsVirtualKeyCode: vk,
      modifiers,
    });
  };
  await send("Runtime.enable");
  await send("Page.enable");

  const waitForApp = async (timeoutMs = 120000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ready = await evaluate(
        "!!document.getElementById('root') && document.getElementById('root').children.length > 0 && document.body.innerText.length > 20",
      ).catch(() => false);
      if (ready) return true;
      await sleep(500);
    }
    return false;
  };
  const nav = async (url, wait = 1500) => {
    await send("Page.navigate", { url });
    await sleep(wait);
    const ok = await waitForApp();
    if (!ok) console.log("WARN app did not render within timeout for", url);
    await sleep(800);
  };

  // Helper injected into the page for calling tools.
  const helper = `
    window.__sp = {
      async tools() { const mc = document.modelContext; return mc ? (await mc.getTools()).map(t => t.name) : null; },
      async call(name, input) {
        const mc = document.modelContext; const tools = await mc.getTools();
        const tool = tools.find(t => t.name === name); if (!tool) throw new Error('no tool ' + name);
        const raw = await mc.executeTool(tool, JSON.stringify(input ?? {}));
        try { return JSON.parse(raw); } catch { return { raw }; }
      },
      async callRaw(name, rawInput) {
        const mc = document.modelContext; const tools = await mc.getTools();
        const tool = tools.find(t => t.name === name);
        try { return { value: await mc.executeTool(tool, rawInput) }; } catch (e) { return { threw: String(e) }; }
      },
      clickText(text, tag) {
        const els = [...document.querySelectorAll(tag || '*')].filter(e => e.children.length === 0 && e.textContent.trim() === text);
        if (!els.length) return false; els[0].click(); return true;
      },
      hasText(t) { return document.body.innerText.includes(t); },
    }; true;`;

  await nav(base + "/editor");
  await evaluate(helper);

  if (noWebmcp) {
    check(
      "no-webmcp: modelContext absent",
      (await evaluate("'modelContext' in document")) === false,
    );
    check(
      "no-webmcp: editor renders",
      await evaluate(
        "!!document.getElementById('canvas') || document.body.innerText.length > 50",
      ),
    );
    // pick a database if the modal is present, then add a table via the UI
    await evaluate("window.__sp.clickText('PostgreSQL')");
    await sleep(300);
    await evaluate("window.__sp.clickText('Confirm')");
    await sleep(800);
    const bridgeErrors = consoleLog.filter((l) =>
      /SchemaPair|modelContext/.test(l),
    );
    check(
      "no-webmcp: no bridge errors in console",
      bridgeErrors.length === 0,
      bridgeErrors,
    );
    await shot("no-webmcp");
    console.log("CONSOLE:", consoleLog.slice(0, 20));
    ws.close();
    chrome.kill();
    await sleep(500);
    try {
      fs.rmSync(udd, { recursive: true, force: true });
    } catch {}
    process.exit(results.some((r) => !r.pass) ? 1 : 0);
  }

  // Gate: tools discovered
  let tools = null;
  for (let i = 0; i < 20 && (!tools || tools.length < 13); i++) {
    tools = await evaluate("window.__sp.tools()");
    if (!tools || tools.length < 13) await sleep(300);
  }
  const EXPECTED_TOOLS = [
    "annotate_diagram",
    "apply_schema_changes",
    "arrange_tables",
    "explain_join_path",
    "generate_migration",
    "generate_sample_inserts",
    "generate_sql",
    "import_sql",
    "inspect_schema",
    "plan_removal",
    "removal_status",
    "review_schema",
    "validate_schema",
  ];
  check(
    `${EXPECTED_TOOLS.length} tools registered on /editor`,
    JSON.stringify(tools) === JSON.stringify(EXPECTED_TOOLS),
    tools,
  );

  // Pick PostgreSQL in the first-run modal
  await evaluate("window.__sp.clickText('PostgreSQL')");
  await sleep(300);
  await evaluate("window.__sp.clickText('Confirm')");
  await sleep(800);

  let r = await evaluate("window.__sp.call('inspect_schema')");
  check(
    "inspect: empty postgres diagram",
    r.ok && r.database === "postgresql" && r.tables.length === 0,
    r,
  );

  // Malformed / invalid inputs
  r = await evaluate("window.__sp.callRaw('apply_schema_changes', 'not json')");
  check("malformed JSON input rejected by browser", r.threw !== undefined, r);
  r = await evaluate(
    "window.__sp.call('apply_schema_changes', { operations: 'x' })",
  );
  check(
    "malformed operations -> ok:false",
    r.ok === false && r.error.code === "invalid_request",
    r.error,
  );
  r = await evaluate("window.__sp.call('apply_schema_changes', {})");
  check("missing operations -> ok:false", r.ok === false, r.error);
  r = await evaluate(
    "window.__sp.call('apply_schema_changes', { operations: Array.from({length: 26}, (_, i) => ({ op: 'add_table', name: 't' + i, fields: [{ name: 'id', type: 'INT', primary: true }] })) })",
  );
  check(
    "26 operations -> limit error",
    r.ok === false && /limit is 25/.test(r.error.details[0].message),
    r.error,
  );
  r = await evaluate(
    "window.__sp.call('apply_schema_changes', { operations: [{ op: 'add_field', table: 'ghost', field: { name: 'x', type: 'INT' } }, { op: 'add_relationship', from: { table: 'a', field: 'b' }, to: { table: 'c', field: 'd' } }] })",
  );
  check(
    "invalid references -> errors, nothing applied",
    r.ok === false && r.error.details.length === 2,
    r.error.details,
  );
  r = await evaluate("window.__sp.call('inspect_schema')");
  check("diagram still empty after rejected requests", r.tables.length === 0);

  // Dry run
  const saas = {
    operations: [
      {
        op: "add_table",
        name: "users",
        fields: [
          { name: "id", type: "INT", primary: true, increment: true },
          {
            name: "email",
            type: "VARCHAR",
            size: 255,
            notNull: true,
            unique: true,
          },
          {
            name: "created_at",
            type: "TIMESTAMP",
            notNull: true,
            default: "now()",
          },
        ],
      },
      {
        op: "add_table",
        name: "plans",
        fields: [
          { name: "id", type: "INT", primary: true, increment: true },
          { name: "name", type: "VARCHAR", size: 100, notNull: true },
          { name: "price_cents", type: "INT", notNull: true },
        ],
        indexes: [{ name: "plans_name_idx", fields: ["name"], unique: true }],
      },
      {
        op: "add_table",
        name: "subscriptions",
        fields: [
          { name: "id", type: "INT", primary: true, increment: true },
          { name: "user_id", type: "INT", notNull: true },
          { name: "plan_id", type: "INT", notNull: true },
          {
            name: "status",
            type: "VARCHAR",
            size: 20,
            notNull: true,
            default: "active",
          },
        ],
      },
      {
        op: "add_relationship",
        from: { table: "subscriptions", field: "user_id" },
        to: { table: "users", field: "id" },
        onDelete: "Cascade",
      },
      {
        op: "add_relationship",
        from: { table: "subscriptions", field: "plan_id" },
        to: { table: "plans", field: "id" },
      },
    ],
  };
  r = await evaluate(
    `window.__sp.call('apply_schema_changes', ${JSON.stringify({ ...saas, dryRun: true })})`,
  );
  check(
    "dryRun validates without applying",
    r.ok && r.dryRun && r.wouldApply.tables.length === 3,
    r,
  );
  r = await evaluate("window.__sp.call('inspect_schema')");
  check("diagram still empty after dryRun", r.tables.length === 0);

  // Apply for real
  r = await evaluate(
    `window.__sp.call('apply_schema_changes', ${JSON.stringify(saas)})`,
  );
  check(
    "apply SaaS schema",
    r.ok &&
      r.applied.tables.length === 3 &&
      r.applied.relationships.length === 2,
    r.message,
  );
  await sleep(800);
  r = await evaluate("window.__sp.call('inspect_schema')");
  check(
    "inspect reflects 3 tables + 2 relationships in request order",
    r.tables.length === 3 &&
      r.relationships.length === 2 &&
      r.tables.map((t) => t.name).join() === "users,plans,subscriptions" &&
      r.tables[2].fields.length === 4,
    r.tables.map((t) => t.name),
  );
  check(
    "INT aliased to INTEGER for PostgreSQL",
    r.tables[0].fields[0].type === "INTEGER",
    r.tables[0].fields[0],
  );
  const canvasHas = await evaluate(
    "['users','plans','subscriptions'].every(n => window.__sp.hasText(n))",
  );
  check("canvas shows the new tables", canvasHas);
  const panelText = await evaluate(
    "(() => { const t = document.body.innerText; const i = t.indexOf('Agent activity'); return i < 0 ? '' : t.slice(i, i + 400); })()",
  );
  check(
    "activity panel lists the apply call",
    /apply_schema_changes/.test(panelText) && /added 3 table/.test(panelText),
    panelText.slice(0, 160),
  );
  const tableOnScreen = await evaluate(
    "(() => { const el = [...document.querySelectorAll('foreignObject, div')].find(e => e.textContent.trim() === 'subscriptions' && e.getBoundingClientRect().width > 0); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: innerWidth, h: innerHeight }; })()",
  );
  check(
    "canvas panned so the new tables are on screen",
    tableOnScreen &&
      tableOnScreen.x > 0 &&
      tableOnScreen.x < tableOnScreen.w &&
      tableOnScreen.y > 0 &&
      tableOnScreen.y < tableOnScreen.h,
    tableOnScreen,
  );
  await shot("after-apply");

  r = await evaluate("window.__sp.call('validate_schema')");
  check(
    "validate: clean schema",
    r.ok && r.valid === true && r.issueCount === 0,
    r,
  );

  // Introduce an issue and fix it
  r = await evaluate(
    "window.__sp.call('apply_schema_changes', { operations: [{ op: 'add_table', name: 'invoices', fields: [{ name: 'ref', type: 'VARCHAR' }, { name: 'subscription_id', type: 'INT' }] }, { op: 'add_relationship', from: { table: 'invoices', field: 'subscription_id' }, to: { table: 'subscriptions', field: 'id' } }] })",
  );
  check("add invoices table without PK", r.ok, r.message);
  await sleep(300);
  r = await evaluate("window.__sp.call('validate_schema')");
  check(
    "validate: reports missing primary key",
    r.valid === false &&
      r.issues.some((i) => /primary key/i.test(i) && /invoices/.test(i)),
    r.issues,
  );
  check(
    "validate: suggests an add_field fix",
    r.suggestions?.some(
      (s) => s.operation.op === "add_field" && s.table === "invoices",
    ),
    r.suggestions,
  );
  r = await evaluate(
    "window.__sp.call('apply_schema_changes', { operations: [{ op: 'add_field', table: 'invoices', field: { name: 'id', type: 'INT', primary: true, increment: true } }] })",
  );
  check("fix: add PK field", r.ok, r.message);
  await sleep(300);
  r = await evaluate("window.__sp.call('validate_schema')");
  check("validate: clean after fix", r.valid === true, r.issues);

  // Import SQL (append-only) then undo it via Ctrl+Z
  const ddl =
    "CREATE TABLE payments (id SERIAL PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id), amount_cents INTEGER NOT NULL, paid_at TIMESTAMP);";
  const importCall = (extra) =>
    `window.__sp.call('import_sql', { sql: ${JSON.stringify(ddl)}${extra || ""} })`;
  r = await evaluate(importCall(", dryRun: true"));
  check(
    "import_sql dryRun previews without applying",
    r.ok && r.dryRun && r.wouldImport.tables.join() === "payments",
    r,
  );
  r = await evaluate(importCall());
  check(
    "import_sql appends a table with its FK",
    r.ok &&
      r.imported.tables.join() === "payments" &&
      r.imported.relationships.length === 1,
    r.message,
  );
  await sleep(400);
  r = await evaluate(
    "window.__sp.call('inspect_schema', { tables: ['payments'] })",
  );
  check(
    "inspect shows imported table linked to invoices",
    r.tables.length === 1 &&
      r.relationships.some((x) => x.to.table === "invoices"),
    r.relationships,
  );
  r = await evaluate(importCall());
  check(
    "import_sql rejects a colliding table name",
    r.ok === false && /already exist/.test(r.error.message),
    r.error,
  );
  r = await evaluate(
    "window.__sp.call('import_sql', { sql: 'CREATE TABLE (' })",
  );
  check(
    "import_sql reports parse errors",
    r.ok === false && /parse error/i.test(r.error.message),
    r.error,
  );
  await evaluate("document.body.focus(); true");
  await key("z", "KeyZ", 90, 2);
  await sleep(500);
  r = await evaluate("window.__sp.call('inspect_schema')");
  check(
    "undo removes the imported table and FK",
    !r.tables.some((t) => t.name === "payments") &&
      r.relationships.length === 3,
    r.counts,
  );

  // Review, migration, arrange
  r = await evaluate("window.__sp.call('review_schema')");
  check(
    "review_schema returns structured findings with fixes",
    r.ok &&
      r.summary &&
      r.findings.some((f) => f.code === "fk_without_index" && f.fix),
    r.summary,
  );
  r = await evaluate("window.__sp.call('generate_migration')");
  // The baseline is the diagram as loaded; the first autosave of a new diagram
  // reloads it, so by now the baseline holds the first three tables and the
  // migration covers what was added since (invoices).
  check(
    "generate_migration since load creates the newer tables",
    r.ok &&
      r.changeCount > 0 &&
      /CREATE TABLE[\s\S]*"invoices"/.test(r.up) &&
      /DROP TABLE/.test(r.down),
    { changes: r.changeCount, up: r.up?.slice(0, 80) },
  );
  r = await evaluate(
    "window.__sp.call('generate_migration', { resetBaseline: true })",
  );
  r = await evaluate(
    "window.__sp.call('apply_schema_changes', { operations: [{ op: 'add_field', table: 'plans', field: { name: 'currency', type: 'VARCHAR', size: 3, notNull: true, default: 'USD' } }] })",
  );
  r = await evaluate("window.__sp.call('generate_migration')");
  check(
    "generate_migration after reset shows only the new column",
    r.ok &&
      /ALTER TABLE "plans"[\s\S]*ADD COLUMN "currency"/i.test(r.up) &&
      !/CREATE TABLE/.test(r.up),
    r.up?.slice(0, 160),
  );
  await key("z", "KeyZ", 90, 2);
  await sleep(400);
  const before = await evaluate(
    "window.__sp.call('inspect_schema').then(x => x.tables.map(t => t.id))",
  );
  r = await evaluate("window.__sp.call('arrange_tables')");
  check("arrange_tables moves tables", r.ok && r.movedTables > 0, r.message);
  await sleep(400);
  const undoArrange = await evaluate(
    "(() => { const b = [...document.querySelectorAll('button')].find(b => /Undo last agent change/.test(b.textContent) && !b.disabled); if (!b) return false; b.click(); return true; })()",
  );
  await sleep(400);
  const after = await evaluate(
    "window.__sp.call('inspect_schema').then(x => x.tables.map(t => t.id))",
  );
  check(
    "panel undo reverts arrange (schema untouched)",
    undoArrange && JSON.stringify(before) === JSON.stringify(after),
    { undoArrange },
  );

  // Annotations, sample data, join path
  r = await evaluate(
    "window.__sp.call('annotate_diagram', { areas: [{ name: 'Billing', tables: ['plans', 'subscriptions', 'invoices'] }], notes: [{ title: 'Agent note', content: 'Invoices are issued per subscription period.', near: 'invoices' }] })",
  );
  check(
    "annotate_diagram adds an area and a note",
    r.ok && r.annotated.notes === 1 && r.annotated.areas === 1,
    r,
  );
  await sleep(500);
  // The activity panel also prints these names, so look at the canvas only.
  const canvasText = (t) =>
    `(document.getElementById('canvas') || document.body).textContent.includes(${JSON.stringify(t)})`;
  check(
    "canvas shows the area and note",
    await evaluate(`${canvasText("Billing")} && ${canvasText("Agent note")}`),
  );
  const undoNote = await evaluate(
    "(() => { const b = [...document.querySelectorAll('button')].find(b => /Undo last agent change/.test(b.textContent) && !b.disabled); if (!b) return false; b.click(); return true; })()",
  );
  await sleep(400);
  check(
    "panel undo removes the note (last agent add)",
    undoNote &&
      !(await evaluate(canvasText("Agent note"))) &&
      (await evaluate(canvasText("Billing"))),
  );
  await evaluate("document.body.focus(); true");
  await key("z", "KeyZ", 90, 2);
  await sleep(400);
  check("Ctrl+Z removes the area", !(await evaluate(canvasText("Billing"))));
  r = await evaluate(
    "window.__sp.call('generate_sample_inserts', { rows: 2 })",
  );
  check(
    "generate_sample_inserts orders parents first",
    r.ok &&
      r.tableOrder.indexOf("users") < r.tableOrder.indexOf("subscriptions") &&
      /INSERT INTO "subscriptions"/.test(r.sql),
    r.tableOrder,
  );
  r = await evaluate(
    "window.__sp.call('explain_join_path', { from: 'users', to: 'invoices' })",
  );
  check(
    "explain_join_path finds the two-hop chain",
    r.ok && r.connected && r.hops.length === 2 && /JOIN "invoices"/.test(r.sql),
    r.hops,
  );

  // Removal with human confirmation
  r = await evaluate(
    "window.__sp.call('plan_removal', { targets: [{ kind: 'table', table: 'invoices' }], reason: 'Demo: retire invoices' })",
  );
  check(
    "plan_removal returns a pending proposal with impact",
    r.ok &&
      r.status === "pending" &&
      r.impact.tables[0].name === "invoices" &&
      r.impact.relationships.length >= 1,
    r.impact,
  );
  const proposalId = r.proposalId;
  await sleep(300);
  let inspect = await evaluate("window.__sp.call('inspect_schema')");
  check(
    "nothing removed before confirmation",
    inspect.tables.some((t) => t.name === "invoices"),
  );
  check(
    "confirmation card is visible",
    await evaluate(
      "window.__sp.hasText('The agent proposes a removal') && window.__sp.hasText('Confirm removal')",
    ),
  );
  await shot("removal-proposal");
  const rejected = await evaluate(
    "(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Reject'); if (!b) return false; b.click(); return true; })()",
  );
  await sleep(300);
  r = await evaluate(
    `window.__sp.call('removal_status', { proposalId: ${JSON.stringify(proposalId)} })`,
  );
  check(
    "reject leaves the schema intact and reports rejected",
    rejected &&
      r.status === "rejected" &&
      (await evaluate(
        "window.__sp.call('inspect_schema').then(x => x.tables.some(t => t.name === 'invoices'))",
      )),
    r.status,
  );
  r = await evaluate(
    "window.__sp.call('plan_removal', { targets: [{ kind: 'table', table: 'invoices' }] })",
  );
  const proposalId2 = r.proposalId;
  await sleep(300);
  const confirmed = await evaluate(
    "(() => { const b = [...document.querySelectorAll('button')].find(b => /Confirm removal/.test(b.textContent) && !b.disabled); if (!b) return false; b.click(); return true; })()",
  );
  await sleep(500);
  inspect = await evaluate("window.__sp.call('inspect_schema')");
  r = await evaluate(
    `window.__sp.call('removal_status', { proposalId: ${JSON.stringify(proposalId2)} })`,
  );
  check(
    "confirm removes the table and its relationships",
    confirmed &&
      r.status === "confirmed" &&
      !inspect.tables.some((t) => t.name === "invoices") &&
      !inspect.relationships.some(
        (x) => x.from.table === "invoices" || x.to.table === "invoices",
      ),
    inspect.counts,
  );
  await evaluate("document.body.focus(); true");
  await key("z", "KeyZ", 90, 2);
  await sleep(500);
  inspect = await evaluate("window.__sp.call('inspect_schema')");
  check(
    "Ctrl+Z restores the removed table and relationships",
    inspect.tables.some((t) => t.name === "invoices") &&
      inspect.relationships.some((x) => x.from.table === "invoices"),
    inspect.counts,
  );

  // Generate SQL
  r = await evaluate("window.__sp.call('generate_sql')");
  check(
    "generate_sql postgres",
    r.ok &&
      r.dialect === "postgresql" &&
      /CREATE TABLE (IF NOT EXISTS )?"subscriptions"/.test(r.sql) &&
      /FOREIGN KEY\("user_id"\) REFERENCES "users"\("id"\)/.test(r.sql) &&
      /ON DELETE CASCADE/.test(r.sql),
    r.sql?.slice(0, 200),
  );
  r = await evaluate("window.__sp.call('generate_sql', { dialect: 'mysql' })");
  check("generate_sql wrong dialect -> error", r.ok === false, r.error);
  fs.writeFileSync(
    path.join(shots, "generated.sql"),
    (await evaluate("window.__sp.call('generate_sql')")).sql,
  );

  // Undo: Ctrl+Z twice should remove the PK fix and then the invoices table
  await evaluate("document.body.focus(); true");
  await key("z", "KeyZ", 90, 2);
  await sleep(500);
  r = await evaluate(
    "window.__sp.call('inspect_schema', { tables: ['invoices'] })",
  );
  check(
    "undo 1: PK field removed",
    r.tables.length === 1 && r.tables[0].fields.length === 2,
    r.tables[0]?.fields?.map((f) => f.name),
  );
  await key("z", "KeyZ", 90, 2);
  await sleep(500);
  r = await evaluate("window.__sp.call('inspect_schema')");
  check(
    "undo 2: invoices table + relationship removed",
    r.tables.length === 3 && r.relationships.length === 2,
    r.counts,
  );
  await key("y", "KeyY", 89, 2);
  await sleep(500);
  r = await evaluate("window.__sp.call('inspect_schema')");
  check(
    "redo: invoices back",
    r.tables.length === 4 && r.relationships.length === 3,
    r.counts,
  );
  await shot("after-undo-redo");
  const clicked = await evaluate(
    "(() => { const b = [...document.querySelectorAll('button')].find(b => /Undo last agent change/.test(b.textContent) && !b.disabled); if (!b) return false; b.click(); return true; })()",
  );
  await sleep(600);
  r = await evaluate("window.__sp.call('inspect_schema')");
  check(
    "panel Undo button reverts the latest agent change",
    clicked && r.tables.length === 3 && r.relationships.length === 2,
    r.counts,
  );
  await key("y", "KeyY", 89, 2);
  await sleep(500);
  r = await evaluate("window.__sp.call('inspect_schema')");
  check(
    "redo after panel undo restores it",
    r.tables.length === 4 && r.relationships.length === 3,
    r.counts,
  );

  // Persistence: wait for autosave, reload, inspect
  await sleep(2500);
  const url = await evaluate("location.href");
  check(
    "autosave navigated to a diagram id",
    /\/editor\/diagrams\//.test(url),
    url,
  );
  await send("Page.reload");
  await sleep(1500);
  await waitForApp();
  await sleep(1500);
  await evaluate(helper);
  r = await evaluate("window.__sp.call('inspect_schema')");
  check(
    "after reload: diagram persisted",
    r.ok && r.tables.length === 4 && r.relationships.length === 3,
    r.counts,
  );
  tools = await evaluate("window.__sp.tools()");
  check(
    "after reload: exactly 13 tools (no duplicates)",
    tools.length === 13,
    tools,
  );

  // Cleanup on navigation away from the editor
  await nav(base + "/");
  await evaluate(helper);
  tools = await evaluate("window.__sp.tools()");
  check(
    "landing page: tools unregistered",
    Array.isArray(tools) && tools.length === 0,
    tools,
  );
  await nav(base + "/editor");
  await evaluate(helper);
  for (let i = 0; i < 20; i++) {
    tools = await evaluate("window.__sp.tools()");
    if (tools && tools.length >= 13) break;
    await sleep(300);
  }
  check("back on /editor: 13 tools again", tools.length === 13, tools);

  console.log(
    "\nCONSOLE (filtered):",
    consoleLog
      .filter((l) => !/\[log\]|Download the React DevTools/.test(l))
      .slice(0, 30),
  );
  const failed = results.filter((r) => !r.pass);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed`,
  );
  ws.close();
  chrome.kill();
  await sleep(300);
  try {
    fs.rmSync(udd, { recursive: true, force: true });
  } catch {}
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error("E2E crashed:", e);
  chrome.kill();
  process.exit(2);
});
