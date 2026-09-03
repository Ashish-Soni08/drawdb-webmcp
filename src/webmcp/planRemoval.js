import { getRelationshipFields } from "../utils/utils";

/**
 * Pure planner for `plan_removal`.
 *
 * Removal is the only destructive capability exposed to agents, and it is
 * split in two: this module computes exactly what would disappear (the
 * "impact") and the resulting next state, but nothing is applied until a
 * human clicks Confirm in the editor. Agents cannot confirm.
 */

export const REMOVAL_LIMITS = Object.freeze({ targets: 10 });
export const REMOVAL_KINDS = Object.freeze(["table", "field", "relationship", "index"]);

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

function findByName(items, name, label) {
  if (typeof name !== "string" || name === "") throw new Error(`${label} name is required.`);
  const exact = items.find((i) => i.name === name);
  if (exact) return exact;
  const matches = items.filter((i) => i.name.toLowerCase() === name.toLowerCase());
  if (matches.length === 0) throw new Error(`${label} "${name}" does not exist.`);
  if (matches.length > 1) throw new Error(`${label} "${name}" is ambiguous.`);
  return matches[0];
}

/**
 * @param {{targets:Array}} request
 * @param {{tables:Array, relationships:Array}} diagram
 * @returns {{ok:true, targets:Array, impact:object, next:{tables,relationships}}
 *         | {ok:false, errors:Array<{target:number|null, message:string}>}}
 */
export function planRemoval(request, diagram) {
  if (!isObject(request) || !Array.isArray(request.targets) || request.targets.length === 0) {
    return { ok: false, errors: [{ target: null, message: 'Expected { "targets": [ { "kind": "table" | "field" | "relationship" | "index", ... } ] }.' }] };
  }
  if (request.targets.length > REMOVAL_LIMITS.targets) {
    return { ok: false, errors: [{ target: null, message: `At most ${REMOVAL_LIMITS.targets} targets per proposal.` }] };
  }

  const tables = clone(diagram.tables ?? []);
  const relationships = clone(diagram.relationships ?? []);
  const errors = [];
  const targets = [];

  const removeTableIds = new Set();
  const removeFieldIds = new Set();
  const removeRelationshipIds = new Set();
  const removeIndexes = []; // { tableId, name }

  request.targets.forEach((t, i) => {
    try {
      if (!isObject(t) || !REMOVAL_KINDS.includes(t.kind)) {
        throw new Error(`Unknown target kind "${t?.kind}". Use: ${REMOVAL_KINDS.join(", ")}.`);
      }
      if (t.kind === "table") {
        const table = findByName(tables, t.table, "Table");
        removeTableIds.add(table.id);
        targets.push({ kind: "table", table: table.name });
      } else if (t.kind === "field") {
        const table = findByName(tables, t.table, "Table");
        const field = findByName(table.fields, t.field, "Field");
        removeFieldIds.add(field.id);
        targets.push({ kind: "field", table: table.name, field: field.name });
      } else if (t.kind === "relationship") {
        const rel = findByName(relationships, t.name, "Relationship");
        removeRelationshipIds.add(rel.id);
        targets.push({ kind: "relationship", name: rel.name });
      } else {
        const table = findByName(tables, t.table, "Table");
        const index = findByName(table.indices ?? [], t.name, "Index");
        removeIndexes.push({ tableId: table.id, name: index.name });
        targets.push({ kind: "index", table: table.name, index: index.name });
      }
    } catch (error) {
      errors.push({ target: i, message: error.message });
    }
  });
  if (errors.length) return { ok: false, errors };

  const tableById = new Map(tables.map((t) => [t.id, t]));
  const impact = { tables: [], fields: [], relationships: [], indexes: [] };

  // Relationships: explicitly targeted, or touching a removed table/field.
  const nextRelationships = relationships.filter((r) => {
    const pairs = getRelationshipFields(r);
    const touchesRemoved =
      removeRelationshipIds.has(r.id) ||
      removeTableIds.has(r.startTableId) ||
      removeTableIds.has(r.endTableId) ||
      pairs.some((p) => removeFieldIds.has(p.startFieldId) || removeFieldIds.has(p.endFieldId));
    if (touchesRemoved) {
      impact.relationships.push({
        name: r.name,
        from: tableById.get(r.startTableId)?.name,
        to: tableById.get(r.endTableId)?.name,
      });
    }
    return !touchesRemoved;
  });

  const nextTables = tables
    .filter((table) => {
      if (removeTableIds.has(table.id)) {
        impact.tables.push({ name: table.name, fieldCount: table.fields.length });
        return false;
      }
      return true;
    })
    .map((table) => {
      const removedNames = new Set();
      const fields = table.fields.filter((f) => {
        if (removeFieldIds.has(f.id)) {
          removedNames.add(f.name);
          impact.fields.push({ table: table.name, field: f.name });
          return false;
        }
        return true;
      });
      const dropIndex = new Set(
        removeIndexes.filter((x) => x.tableId === table.id).map((x) => x.name),
      );
      const indices = (table.indices ?? [])
        .map((index) => ({ ...index, fields: index.fields.filter((n) => !removedNames.has(n)) }))
        .filter((index) => {
          const gone = dropIndex.has(index.name) || index.fields.length === 0;
          if (gone) impact.indexes.push({ table: table.name, index: index.name });
          return !gone;
        })
        .map((index, i) => ({ ...index, id: i }));
      const uniqueConstraints = (table.uniqueConstraints ?? [])
        .map((uc) => ({ ...uc, fields: uc.fields.filter((n) => !removedNames.has(n)) }))
        .filter((uc) => uc.fields.length > 0)
        .map((uc, i) => ({ ...uc, id: i }));
      return { ...table, fields, indices, uniqueConstraints };
    });

  return {
    ok: true,
    targets,
    impact,
    next: { tables: nextTables, relationships: nextRelationships },
  };
}

/** Human summary for the confirmation card and the undo history. */
export function summarizeRemoval(impact) {
  const parts = [];
  if (impact.tables.length) parts.push(`${impact.tables.length} table(s): ${impact.tables.map((t) => t.name).join(", ")}`);
  if (impact.fields.length) parts.push(`${impact.fields.length} column(s)`);
  if (impact.relationships.length) parts.push(`${impact.relationships.length} relationship(s)`);
  if (impact.indexes.length) parts.push(`${impact.indexes.length} index(es)`);
  return parts.length ? `remove ${parts.join("; ")}` : "remove nothing";
}
