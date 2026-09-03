import { DB } from "../data/constants";
import { getRelationshipFields } from "../utils/utils";

/**
 * `generate_sample_inserts`: deterministic INSERT statements for the diagram,
 * parents before children so foreign keys resolve. Values are derived from
 * column types and names; nothing is random and nothing is executed.
 */

export const SAMPLE_LIMITS = Object.freeze({ rows: 20 });

function quoteFor(database) {
  if (database === DB.MYSQL || database === DB.MARIADB) return (s) => `\`${s}\``;
  if (database === DB.MSSQL) return (s) => `[${s}]`;
  return (s) => `"${s}"`;
}

const INT_TYPES = /INT|SERIAL|NUMBER$/i;
const DEC_TYPES = /DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL|MONEY/i;
const BOOL_TYPES = /BOOL|BIT$/i;
const DATE_ONLY = /^DATE$/i;
const TIME_TYPES = /TIME|DATETIME/i;
const JSON_TYPES = /JSON/i;
const UUID_TYPES = /UUID|UNIQUEIDENTIFIER/i;

function sampleValue(field, table, row, fkTarget) {
  if (fkTarget) return String(((row - 1) % fkTarget.rows) + 1);
  if (field.primary && INT_TYPES.test(field.type)) return String(row);
  const type = String(field.type).toUpperCase();
  if (Array.isArray(field.values) && field.values.length) {
    return `'${field.values[(row - 1) % field.values.length].replace(/'/g, "''")}'`;
  }
  if (BOOL_TYPES.test(type)) return row % 2 ? "TRUE" : "FALSE";
  if (INT_TYPES.test(type)) return String(row * 10);
  if (DEC_TYPES.test(type)) return `${row * 10}.50`;
  if (DATE_ONLY.test(type)) return `'2026-01-${String(row).padStart(2, "0")}'`;
  if (TIME_TYPES.test(type)) return "CURRENT_TIMESTAMP";
  if (JSON_TYPES.test(type)) return `'{"sample": ${row}}'`;
  if (UUID_TYPES.test(type)) {
    return `'00000000-0000-4000-8000-${String(row).padStart(12, "0")}'`;
  }
  const base = `${table.name}_${field.name}_${row}`;
  const size = Number(field.size);
  const text = size > 0 && base.length > size ? `${field.name.slice(0, Math.max(1, size - 2))}${row}`.slice(0, size) : base;
  return `'${text.replace(/'/g, "''")}'`;
}

/** Parents first (Kahn's algorithm); cycles fall back to declaration order. */
export function orderTablesByDependency(tables, relationships) {
  const ids = new Set(tables.map((t) => t.id));
  const indegree = new Map(tables.map((t) => [t.id, 0]));
  const children = new Map(tables.map((t) => [t.id, []]));
  for (const r of relationships) {
    if (!ids.has(r.startTableId) || !ids.has(r.endTableId) || r.startTableId === r.endTableId) continue;
    // start = child (FK owner) depends on end = parent
    indegree.set(r.startTableId, indegree.get(r.startTableId) + 1);
    children.get(r.endTableId).push(r.startTableId);
  }
  const queue = tables.filter((t) => indegree.get(t.id) === 0).map((t) => t.id);
  const ordered = [];
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
    for (const child of children.get(id)) {
      indegree.set(child, indegree.get(child) - 1);
      if (indegree.get(child) === 0) queue.push(child);
    }
  }
  for (const t of tables) if (!seen.has(t.id)) ordered.push(t.id);
  const byId = new Map(tables.map((t) => [t.id, t]));
  return ordered.map((id) => byId.get(id));
}

/**
 * @param {{database:string, tables:Array, relationships:Array}} diagram
 * @param {{rows?:number, tables?:string[]}} [options]
 * @returns {{ok:true, sql:string, tableOrder:string[], rows:number} | {ok:false, message:string}}
 */
export function generateSampleInserts(diagram, options = {}) {
  const rows = options.rows === undefined ? 3 : Number(options.rows);
  if (!Number.isInteger(rows) || rows < 1 || rows > SAMPLE_LIMITS.rows) {
    return { ok: false, message: `"rows" must be an integer between 1 and ${SAMPLE_LIMITS.rows}.` };
  }
  const all = diagram.tables ?? [];
  const relationships = diagram.relationships ?? [];
  let selected = all;
  if (Array.isArray(options.tables) && options.tables.length) {
    const wanted = new Set(options.tables.map((n) => String(n).toLowerCase()));
    selected = all.filter((t) => wanted.has(t.name.toLowerCase()));
    if (selected.length !== wanted.size) {
      const found = new Set(selected.map((t) => t.name.toLowerCase()));
      const missing = [...wanted].filter((n) => !found.has(n));
      return { ok: false, message: `Unknown table(s): ${missing.join(", ")}.` };
    }
  }
  if (selected.length === 0) return { ok: false, message: "The diagram has no tables." };

  const q = quoteFor(diagram.database);
  const ordered = orderTablesByDependency(selected, relationships);
  const fkByField = new Map();
  for (const r of relationships) {
    for (const p of getRelationshipFields(r)) fkByField.set(p.startFieldId, { rows });
  }

  const statements = [];
  for (const table of ordered) {
    const fields = table.fields ?? [];
    if (fields.length === 0) continue;
    const columns = fields.map((f) => q(f.name)).join(", ");
    const values = [];
    for (let row = 1; row <= rows; row++) {
      values.push(`(${fields.map((f) => sampleValue(f, table, row, fkByField.get(f.id))).join(", ")})`);
    }
    statements.push(`INSERT INTO ${q(table.name)} (${columns}) VALUES\n\t${values.join(",\n\t")};`);
  }
  return { ok: true, sql: statements.join("\n\n"), tableOrder: ordered.map((t) => t.name), rows };
}
