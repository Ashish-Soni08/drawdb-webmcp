import { DB } from "../data/constants";

/**
 * Returns a function that quotes an SQL identifier the way the given dialect
 * expects. Mirrors the quoting used by drawDB's exporters.
 */
export function identifierQuoter(database) {
  if (database === DB.MYSQL || database === DB.MARIADB) {
    return (name) => `\`${name}\``;
  }
  if (database === DB.MSSQL) return (name) => `[${name}]`;
  return (name) => `"${name}"`;
}
