import { DB } from "../data/constants";
import { exportSQL } from "../utils/exportSQL";
import {
  jsonToMariaDB,
  jsonToMySQL,
  jsonToOracleSQL,
  jsonToPostgreSQL,
  jsonToSQLite,
  jsonToSQLServer,
} from "../utils/exportSQL/generic";

/** Dialects an agent may request. Mirrors the editor's Export > SQL menu. */
export const SQL_DIALECTS = [
  DB.POSTGRES,
  DB.MYSQL,
  DB.MARIADB,
  DB.SQLITE,
  DB.MSSQL,
  DB.ORACLESQL,
];

// A "generic" diagram can be exported to any dialect through drawDB's
// generic exporters, exactly like the Export menu does.
const GENERIC_EXPORTERS = {
  [DB.POSTGRES]: jsonToPostgreSQL,
  [DB.MYSQL]: jsonToMySQL,
  [DB.MARIADB]: jsonToMariaDB,
  [DB.SQLITE]: jsonToSQLite,
  [DB.MSSQL]: jsonToSQLServer,
  [DB.ORACLESQL]: jsonToOracleSQL,
};

/**
 * Generates DDL for the live diagram. The SQL is returned as text only; it is
 * never executed and no database connection is involved.
 *
 * @param {{database:string, tables:Array, relationships:Array, types?:Array, enums?:Array}} diagram
 * @param {string} [requestedDialect] optional; required only for generic diagrams
 * @returns {{ok:true, dialect:string, sql:string} | {ok:false, message:string}}
 */
export function generateSql(diagram, requestedDialect) {
  const dialect = requestedDialect
    ? String(requestedDialect).toLowerCase()
    : undefined;

  if (dialect && !SQL_DIALECTS.includes(dialect)) {
    return {
      ok: false,
      message: `Unknown dialect "${requestedDialect}". Use one of: ${SQL_DIALECTS.join(", ")}.`,
    };
  }

  const payload = {
    tables: diagram.tables ?? [],
    references: diagram.relationships ?? [],
    types: diagram.types ?? [],
    enums: diagram.enums ?? [],
    database: diagram.database,
  };

  if (diagram.database === DB.GENERIC) {
    const target = dialect ?? DB.POSTGRES;
    return {
      ok: true,
      dialect: target,
      sql: GENERIC_EXPORTERS[target](payload),
    };
  }

  if (dialect && dialect !== diagram.database) {
    return {
      ok: false,
      message: `This diagram targets ${diagram.database}; SQL can only be generated for that dialect. Omit "dialect" or pass "${diagram.database}".`,
    };
  }

  return { ok: true, dialect: diagram.database, sql: exportSQL(payload) };
}
