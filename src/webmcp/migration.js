import { DB } from "../data/constants";
import { deepDiff } from "../utils/diff";
import { generateMigrationSQL } from "../utils/migrations/diffToSQL";
import { SQL_DIALECTS } from "./generateSql";

/**
 * `generate_migration`: up/down SQL between a baseline snapshot of the
 * diagram and its live state, using drawDB's own migration generator (the
 * one behind the version-history "Generate migration" sheet). Text only.
 */

// Visual and metadata keys never produce DDL.
const KEYS_TO_IGNORE = [
  "x",
  "y",
  "width",
  "height",
  "locked",
  "color",
  "collapsed",
  "title",
  "transform",
  "notes",
  "subjectAreas",
  "database",
];

/** Minimal, serialisable copy of the schema-relevant diagram state. */
export function snapshotSchema(state) {
  return JSON.parse(
    JSON.stringify({
      tables: state.tables ?? [],
      relationships: state.relationships ?? [],
      types: state.types ?? [],
      enums: state.enums ?? [],
    }),
  );
}

/**
 * @param {object} from baseline snapshot (see snapshotSchema)
 * @param {object} to current snapshot
 * @param {string} database diagram database
 * @param {string} [requestedDialect] required only for generic diagrams
 * @returns {{ok:true, dialect:string, up:string, down:string, changeCount:number}
 *         | {ok:false, message:string}}
 */
export function buildMigration(from, to, database, requestedDialect) {
  let dialect = requestedDialect
    ? String(requestedDialect).toLowerCase()
    : undefined;
  if (dialect && !SQL_DIALECTS.includes(dialect)) {
    return {
      ok: false,
      message: `Unknown dialect "${requestedDialect}". Use one of: ${SQL_DIALECTS.join(", ")}.`,
    };
  }
  if (database === DB.GENERIC) {
    dialect ??= DB.POSTGRES;
  } else if (dialect && dialect !== database) {
    return {
      ok: false,
      message: `This diagram targets ${database}; omit "dialect" or pass "${database}".`,
    };
  } else {
    dialect = database;
  }

  const diff = {};
  deepDiff(from, to, diff, KEYS_TO_IGNORE);
  const changeCount = Object.keys(diff).length;
  if (changeCount === 0) {
    return { ok: true, dialect, up: "", down: "", changeCount: 0 };
  }
  const { up, down } = generateMigrationSQL(diff, dialect, { from, to });
  return { ok: true, dialect, up, down, changeCount };
}
