import { DB } from "../data/constants";
import { getRelationshipFields } from "../utils/utils";

/**
 * `explain_join_path`: shortest chain of foreign keys between two tables,
 * plus a SELECT skeleton that joins along it. Read-only; helps users (and
 * agents) understand how to query the schema they are looking at.
 */

function quoteFor(database) {
  if (database === DB.MYSQL || database === DB.MARIADB) return (s) => `\`${s}\``;
  if (database === DB.MSSQL) return (s) => `[${s}]`;
  return (s) => `"${s}"`;
}

function findTable(tables, name) {
  if (typeof name !== "string" || !name) return null;
  return (
    tables.find((t) => t.name === name) ??
    tables.find((t) => t.name.toLowerCase() === name.toLowerCase()) ??
    null
  );
}

/**
 * @param {{database:string, tables:Array, relationships:Array}} diagram
 * @param {{from:string, to:string}} input
 */
export function explainJoinPath(diagram, input) {
  const tables = diagram.tables ?? [];
  const relationships = diagram.relationships ?? [];
  const from = findTable(tables, input?.from);
  const to = findTable(tables, input?.to);
  if (!from || !to) {
    return { ok: false, message: `Both "from" and "to" must be existing table names (got "${input?.from}" and "${input?.to}").` };
  }
  if (from.id === to.id) return { ok: false, message: "from and to are the same table." };

  const byId = new Map(tables.map((t) => [t.id, t]));
  // Undirected adjacency: a join can walk a foreign key in either direction.
  const edges = new Map(tables.map((t) => [t.id, []]));
  for (const r of relationships) {
    if (!byId.has(r.startTableId) || !byId.has(r.endTableId)) continue;
    const pair = getRelationshipFields(r)[0];
    const startField = byId.get(r.startTableId).fields.find((f) => f.id === pair.startFieldId);
    const endField = byId.get(r.endTableId).fields.find((f) => f.id === pair.endFieldId);
    if (!startField || !endField) continue;
    edges.get(r.startTableId).push({ next: r.endTableId, rel: r, nearField: startField.name, farField: endField.name });
    edges.get(r.endTableId).push({ next: r.startTableId, rel: r, nearField: endField.name, farField: startField.name });
  }

  const prev = new Map([[from.id, null]]);
  const queue = [from.id];
  while (queue.length && !prev.has(to.id)) {
    const id = queue.shift();
    for (const edge of edges.get(id)) {
      if (prev.has(edge.next)) continue;
      prev.set(edge.next, { fromId: id, edge });
      queue.push(edge.next);
    }
  }
  if (!prev.has(to.id)) {
    return { ok: true, connected: false, message: `No chain of relationships connects ${from.name} to ${to.name}.`, hops: [] };
  }

  const hops = [];
  for (let id = to.id; prev.get(id); id = prev.get(id).fromId) {
    const { fromId, edge } = prev.get(id);
    hops.unshift({
      from: { table: byId.get(fromId).name, field: edge.nearField },
      to: { table: byId.get(id).name, field: edge.farField },
      via: edge.rel.name,
    });
  }

  const q = quoteFor(diagram.database);
  const lines = [`SELECT *`, `FROM ${q(from.name)}`];
  for (const hop of hops) {
    lines.push(`JOIN ${q(hop.to.table)} ON ${q(hop.to.table)}.${q(hop.to.field)} = ${q(hop.from.table)}.${q(hop.from.field)}`);
  }
  return { ok: true, connected: true, hops, sql: lines.join("\n") };
}
