import nodeSqlParser from "node-sql-parser";
import { DB } from "../data/constants";
import { getRelationshipFields } from "../utils/utils";
import { SQL_DIALECTS } from "./generateSql";

const { Parser } = nodeSqlParser;

/**
 * `check_query`: validates a SELECT/INSERT/UPDATE/DELETE statement against the
 * live diagram without running it. Reports unknown tables and columns,
 * ambiguous unqualified columns, joins without an ON clause, and filter/join
 * columns that have no index (with a ready-made add_index operation).
 */

export const QUERY_LIMITS = Object.freeze({ sqlBytes: 20_000 });

function findTable(tables, name) {
  const lower = String(name).toLowerCase();
  return (
    tables.find((t) => t.name === name) ??
    tables.find((t) => t.name.toLowerCase() === lower) ??
    null
  );
}

function findField(table, name) {
  const lower = String(name).toLowerCase();
  return (
    table.fields.find((f) => f.name === name) ??
    table.fields.find((f) => f.name.toLowerCase() === lower) ??
    null
  );
}

/** Column references inside an expression tree (WHERE / ON / HAVING). */
function collectColumnRefs(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) collectColumnRefs(item, out);
    return out;
  }
  if (node.type === "column_ref") {
    const column =
      node.column?.expr?.value ?? node.column?.column ?? node.column;
    if (typeof column === "string")
      out.push({ table: node.table ?? null, column });
    return out;
  }
  for (const key of ["left", "right", "expr", "args", "value", "ast"]) {
    if (node[key] !== undefined) collectColumnRefs(node[key], out);
  }
  return out;
}

function fromClauses(statement) {
  const from = statement.from ?? statement.table ?? [];
  return Array.isArray(from) ? from : [from];
}

/**
 * @param {{database:string, tables:Array, relationships:Array}} diagram
 * @param {{sql:string, dialect?:string}} input
 */
export function checkQuery(diagram, input) {
  const sql = typeof input?.sql === "string" ? input.sql.trim() : "";
  if (!sql)
    return { ok: false, message: '"sql" must be a non-empty SQL statement.' };
  if (sql.length > QUERY_LIMITS.sqlBytes) {
    return {
      ok: false,
      message: `SQL is too long (${sql.length} chars); the limit is ${QUERY_LIMITS.sqlBytes}.`,
    };
  }
  let dialect = input.dialect
    ? String(input.dialect).toLowerCase()
    : diagram.database;
  if (dialect === DB.GENERIC || dialect === DB.ORACLESQL) dialect = DB.POSTGRES;
  if (!SQL_DIALECTS.includes(dialect)) {
    return { ok: false, message: `Unknown dialect "${input.dialect}".` };
  }

  let parsed;
  try {
    parsed = new Parser().parse(sql, { database: dialect });
  } catch (error) {
    const where = error.location
      ? ` [line ${error.location.start.line}, column ${error.location.start.column}]`
      : "";
    return {
      ok: true,
      valid: false,
      problems: [
        {
          code: "syntax",
          message: `SQL parse error${where}: ${error.message}`,
        },
      ],
      suggestions: [],
    };
  }

  const tables = diagram.tables ?? [];
  const problems = [];
  const suggestions = [];
  const statements = Array.isArray(parsed.ast) ? parsed.ast : [parsed.ast];

  // Tables referenced (with aliases) across all statements.
  const aliases = new Map(); // alias or name (lowercase) -> table
  const referenced = [];
  for (const statement of statements) {
    for (const clause of fromClauses(statement)) {
      if (!clause?.table) continue; // subquery or expression
      const table = findTable(tables, clause.table);
      if (!table) {
        problems.push({
          code: "unknown_table",
          message: `Table "${clause.table}" does not exist in the diagram.`,
          table: clause.table,
        });
        continue;
      }
      referenced.push(table);
      aliases.set(String(clause.table).toLowerCase(), table);
      if (clause.as) aliases.set(String(clause.as).toLowerCase(), table);
      if (clause.join && !clause.on && !clause.using) {
        problems.push({
          code: "join_without_on",
          message: `${clause.join} on "${clause.table}" has no ON condition (cross join).`,
          table: table.name,
        });
      }
    }
  }

  const resolve = (tableRef, column) => {
    if (tableRef) {
      const table = aliases.get(String(tableRef).toLowerCase());
      if (!table)
        return {
          error: `Unknown table or alias "${tableRef}" for column "${column}".`,
        };
      if (column === "*") return { table };
      const field = findField(table, column);
      return field
        ? { table, field }
        : { error: `Column "${table.name}.${column}" does not exist.` };
    }
    if (column === "*") return {};
    const matches = referenced.filter((t) => findField(t, column));
    if (matches.length === 0)
      return {
        error: `Column "${column}" does not exist in any referenced table.`,
      };
    if (matches.length > 1) {
      return {
        error: `Column "${column}" is ambiguous (${matches.map((t) => t.name).join(", ")}); qualify it.`,
      };
    }
    return { table: matches[0], field: findField(matches[0], column) };
  };

  const seen = new Set();
  for (const entry of parsed.columnList ?? []) {
    const [, tableRef, rawColumn] = entry.split("::");
    // node-sql-parser encodes SELECT * as "(.*)".
    const column = rawColumn === "(.*)" ? "*" : rawColumn;
    const key = `${tableRef}::${column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const result = resolve(tableRef === "null" ? null : tableRef, column);
    if (result.error)
      problems.push({ code: "unknown_column", message: result.error });
  }

  // Filter/join columns without an index -> suggest one.
  const indexedNames = new Map();
  for (const table of tables) {
    const names = new Set(
      table.fields.filter((f) => f.primary || f.unique).map((f) => f.name),
    );
    for (const index of table.indices ?? [])
      if (index.fields?.[0]) names.add(index.fields[0]);
    indexedNames.set(table.id, names);
  }
  const fkFieldIds = new Set();
  for (const r of diagram.relationships ?? [])
    for (const p of getRelationshipFields(r)) fkFieldIds.add(p.startFieldId);

  const predicateRefs = [];
  for (const statement of statements) {
    collectColumnRefs(statement.where, predicateRefs);
    for (const clause of fromClauses(statement))
      collectColumnRefs(clause.on, predicateRefs);
  }
  const suggested = new Set();
  for (const ref of predicateRefs) {
    const result = resolve(ref.table, ref.column);
    if (!result.table || !result.field) continue;
    const { table, field } = result;
    if (indexedNames.get(table.id)?.has(field.name)) continue;
    const name = `${table.name}_${field.name}_idx`;
    if (suggested.has(name)) continue;
    suggested.add(name);
    suggestions.push({
      code: "missing_index",
      message: `"${table.name}.${field.name}" is used in a ${fkFieldIds.has(field.id) ? "join" : "filter"} but has no index.`,
      operation: {
        op: "add_index",
        table: table.name,
        index: { name, fields: [field.name] },
      },
    });
  }

  return {
    ok: true,
    valid: problems.length === 0,
    tables: [...new Set(referenced.map((t) => t.name))],
    problems,
    suggestions,
  };
}
