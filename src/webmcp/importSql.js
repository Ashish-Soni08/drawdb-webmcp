// Both parsers are CommonJS bundles; default-import + destructure works under
// Vite's interop and Node's ESM loader alike (named imports fail in Node).
import nodeSqlParser from "node-sql-parser";
import oracleSqlParser from "oracle-sql-parser";
import { nanoid } from "nanoid";
import {
  Cardinality,
  Constraint,
  DB,
  defaultRelationshipColor,
} from "../data/constants";

const { Parser } = nodeSqlParser;
const { Parser: OracleParser } = oracleSqlParser;
import { importSQL } from "../utils/importSQL";
import { SQL_DIALECTS } from "./generateSql";
import { placeNewTables } from "./planSchemaChanges";

/**
 * `import_sql`: turns DDL text into tables/relationships using drawDB's own
 * SQL importer (the same code path as File > Import > SQL) and appends them to
 * the live diagram. Append-only by design: overwriting the diagram is a
 * destructive action reserved for the human UI.
 */

export const IMPORT_LIMITS = Object.freeze({
  sqlBytes: 200_000,
  tables: 100,
});

function parseSql(sql, dialect) {
  try {
    if (dialect === DB.ORACLESQL) {
      return new OracleParser().parse(sql);
    }
    return new Parser().astify(sql, { database: dialect });
  } catch (error) {
    const where = error.location
      ? ` [line ${error.location.start.line}, column ${error.location.start.column}]`
      : "";
    throw new Error(`SQL parse error${where}: ${error.message}`);
  }
}

// Accepts a column definition ({ column: column_ref }) or a bare column_ref
// ({ column: { expr } } or { column: "name" } depending on the dialect).
const columnName = (c) => {
  const ref = c?.column ?? c;
  const inner = ref?.column ?? ref;
  return inner?.expr?.value ?? (typeof inner === "string" ? inner : undefined);
};
const tableName = (t) => (Array.isArray(t) ? t[0]?.table : t?.table) ?? t;

function constraintFromActions(actions, type) {
  const action = (actions ?? []).find((a) => a.type === type);
  if (!action) return Constraint.NONE;
  const value = String(action.value?.value ?? action.value ?? "");
  return value ? value[0].toUpperCase() + value.slice(1) : Constraint.NONE;
}

/** Foreign keys declared in the parsed DDL, as plain names (node-sql-parser ASTs). */
function extractForeignKeys(ast) {
  const fks = [];
  for (const statement of Array.isArray(ast) ? ast : [ast]) {
    if (statement?.type !== "create" || statement.keyword !== "table") continue;
    const startTable = tableName(statement.table);
    for (const d of statement.create_definitions ?? []) {
      if (d.resource === "column" && d.reference_definition) {
        const ref = d.reference_definition;
        fks.push({
          startTable,
          startFields: [columnName(d)],
          endTable: tableName(ref.table),
          endFields: (ref.definition ?? []).map(columnName),
          actions: ref.on_action,
        });
      } else if (
        d.resource === "constraint" &&
        String(d.constraint_type).toLowerCase() === "foreign key"
      ) {
        const ref = d.reference_definition;
        fks.push({
          startTable,
          startFields: (d.definition ?? []).map(columnName),
          endTable: tableName(ref.table),
          endFields: (ref.definition ?? []).map(columnName),
          actions: ref.on_action,
        });
      }
    }
  }
  return fks;
}

/**
 * drawDB's importer only links foreign keys to tables defined in the same
 * DDL. This adds the relationships whose referenced table already exists on
 * the canvas, so "CREATE TABLE payments (... REFERENCES invoices(id))" works
 * against a diagram that already has `invoices`.
 */
function resolveExternalReferences(ast, importedTables, existingTables, relationships) {
  const added = [];
  const importedNames = new Set(importedTables.map((t) => t.name));
  for (const fk of extractForeignKeys(ast)) {
    if (!fk.endTable || importedNames.has(fk.endTable)) continue;
    const startTable = importedTables.find((t) => t.name === fk.startTable);
    const endTable = existingTables.find((t) => t.name === fk.endTable);
    if (!startTable || !endTable) continue;

    const pairs = [];
    for (let i = 0; i < fk.startFields.length; i++) {
      const sf = startTable.fields.find((f) => f.name === fk.startFields[i]);
      const ef = endTable.fields.find((f) => f.name === fk.endFields[i]);
      if (!sf || !ef) break;
      pairs.push({ startFieldId: sf.id, endFieldId: ef.id });
    }
    if (pairs.length === 0 || pairs.length !== fk.startFields.length) continue;
    if (
      relationships.some(
        (r) => r.startTableId === startTable.id && r.startFieldId === pairs[0].startFieldId,
      )
    ) {
      continue;
    }
    const startField = startTable.fields.find((f) => f.id === pairs[0].startFieldId);
    added.push({
      id: nanoid(),
      name: `fk_${startTable.name}_${startField.name}_${endTable.name}`,
      startTableId: startTable.id,
      startFieldId: pairs[0].startFieldId,
      endTableId: endTable.id,
      endFieldId: pairs[0].endFieldId,
      fields: pairs,
      cardinality:
        startField.unique || startField.primary
          ? Cardinality.ONE_TO_ONE
          : Cardinality.MANY_TO_ONE,
      updateConstraint: constraintFromActions(fk.actions, "on update"),
      deleteConstraint: constraintFromActions(fk.actions, "on delete"),
      color: defaultRelationshipColor,
    });
  }
  return added;
}

/**
 * @param {{sql:string, dialect?:string}} input
 * @param {{database:string, tables:Array, relationships:Array, enums?:Array}} diagram live state
 * @param {{tableWidth:number, pan:{x:number,y:number}}} layout
 * @returns {{ok:true, next:{tables,relationships,enums}, summary, warnings:string[]}
 *         | {ok:false, message:string}}
 */
export function planSqlImport(input, diagram, layout) {
  const sql = typeof input?.sql === "string" ? input.sql.trim() : "";
  if (!sql) return { ok: false, message: '"sql" must be a non-empty string of DDL.' };
  if (sql.length > IMPORT_LIMITS.sqlBytes) {
    return {
      ok: false,
      message: `SQL is too large (${sql.length} chars); the limit is ${IMPORT_LIMITS.sqlBytes}.`,
    };
  }

  let dialect = input.dialect ? String(input.dialect).toLowerCase() : undefined;
  if (dialect && !SQL_DIALECTS.includes(dialect)) {
    return {
      ok: false,
      message: `Unknown dialect "${input.dialect}". Use one of: ${SQL_DIALECTS.join(", ")}.`,
    };
  }
  if (diagram.database === DB.GENERIC) {
    dialect ??= DB.POSTGRES;
  } else if (dialect && dialect !== diagram.database) {
    return {
      ok: false,
      message: `This diagram targets ${diagram.database}; import SQL written for that dialect (or omit "dialect").`,
    };
  } else {
    dialect = diagram.database;
  }

  let imported;
  let ast;
  try {
    ast = parseSql(sql, dialect);
    imported = importSQL(ast, dialect, diagram.database);
  } catch (error) {
    return { ok: false, message: error.message };
  }

  const tables = imported.tables ?? [];
  const relationships = imported.relationships ?? [];
  if (dialect !== DB.ORACLESQL) {
    relationships.push(
      ...resolveExternalReferences(ast, tables, diagram.tables ?? [], relationships),
    );
  }
  const enums = imported.enums ?? [];
  if (tables.length === 0 && enums.length === 0) {
    return { ok: false, message: "No CREATE TABLE statements were found in the SQL." };
  }
  if (tables.length > IMPORT_LIMITS.tables) {
    return {
      ok: false,
      message: `The SQL defines ${tables.length} tables; the limit is ${IMPORT_LIMITS.tables} per import.`,
    };
  }

  const existingNames = new Set(
    (diagram.tables ?? []).map((t) => t.name.toLowerCase()),
  );
  const collisions = tables
    .map((t) => t.name)
    .filter((name) => existingNames.has(name.toLowerCase()));
  if (collisions.length) {
    return {
      ok: false,
      message: `These tables already exist in the diagram: ${collisions.join(", ")}. Rename them in the SQL or extend them with apply_schema_changes instead.`,
    };
  }
  const existingEnums = new Set((diagram.enums ?? []).map((e) => e.name.toLowerCase()));
  const enumCollisions = enums
    .map((e) => e.name)
    .filter((name) => existingEnums.has(name.toLowerCase()));
  if (enumCollisions.length) {
    return {
      ok: false,
      message: `These enums already exist in the diagram: ${enumCollisions.join(", ")}.`,
    };
  }

  const warnings = [];
  if ((imported.types ?? []).length) {
    warnings.push(
      `${imported.types.length} custom type(s) were skipped; import types through the UI.`,
    );
  }

  placeNewTables(diagram.tables ?? [], tables, layout);

  return {
    ok: true,
    dialect,
    next: {
      tables: [...(diagram.tables ?? []), ...tables],
      relationships: [...(diagram.relationships ?? []), ...relationships],
      enums: [...(diagram.enums ?? []), ...enums],
    },
    summary: {
      tables: tables.map((t) => t.name),
      fields: [],
      indexes: [],
      relationships: relationships.map((r) => r.name),
      updatedTables: [],
      updatedFields: [],
      enums: enums.map((e) => e.name),
    },
    warnings,
  };
}
