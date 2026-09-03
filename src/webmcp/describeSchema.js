import { getRelationshipFields } from "../utils/utils";

/**
 * Builds the compact, agent-facing view of the live diagram used by
 * `inspect_schema`. Visual-only properties (positions, colors, collapse state)
 * are omitted; boolean flags are emitted only when true to keep output small.
 */

function describeField(field) {
  const out = { id: field.id, name: field.name, type: field.type };
  if (field.size !== undefined && field.size !== "") out.size = field.size;
  if (field.primary) out.primary = true;
  if (field.notNull) out.notNull = true;
  if (field.unique) out.unique = true;
  if (field.increment) out.increment = true;
  if (field.default !== undefined && field.default !== "") {
    out.default = field.default;
  }
  if (Array.isArray(field.values) && field.values.length) {
    out.values = field.values;
  }
  if (field.comment) out.comment = field.comment;
  return out;
}

function describeTable(table) {
  const out = {
    id: table.id,
    name: table.name,
    fields: (table.fields ?? []).map(describeField),
  };
  if (table.comment) out.comment = table.comment;
  const indexes = (table.indices ?? []).map((index) => ({
    name: index.name,
    unique: Boolean(index.unique),
    fields: index.fields ?? [],
  }));
  if (indexes.length) out.indexes = indexes;
  const uniqueConstraints = (table.uniqueConstraints ?? []).map((uc) => ({
    name: uc.name,
    fields: uc.fields ?? [],
  }));
  if (uniqueConstraints.length) out.uniqueConstraints = uniqueConstraints;
  return out;
}

function describeRelationship(relationship, tablesById) {
  const startTable = tablesById.get(relationship.startTableId);
  const endTable = tablesById.get(relationship.endTableId);
  const pairs = getRelationshipFields(relationship).map((pair) => ({
    from: startTable?.fields.find((f) => f.id === pair.startFieldId)?.name,
    to: endTable?.fields.find((f) => f.id === pair.endFieldId)?.name,
  }));
  const out = {
    id: relationship.id,
    name: relationship.name,
    // "from" is the child table that owns the foreign-key column;
    // "to" is the referenced (parent) table.
    from: { table: startTable?.name, field: pairs[0]?.from },
    to: { table: endTable?.name, field: pairs[0]?.to },
    cardinality: relationship.cardinality,
  };
  if (pairs.length > 1) out.columnPairs = pairs;
  if (relationship.updateConstraint) {
    out.onUpdate = relationship.updateConstraint;
  }
  if (relationship.deleteConstraint) {
    out.onDelete = relationship.deleteConstraint;
  }
  return out;
}

/**
 * @param {{database:string, tables:Array, relationships:Array, enums?:Array, types?:Array}} diagram
 * @param {{tables?: string[]}} [options] optional table-name filter
 */
export function describeSchema(diagram, options = {}) {
  const tables = diagram.tables ?? [];
  const relationships = diagram.relationships ?? [];
  const enums = diagram.enums ?? [];
  const types = diagram.types ?? [];

  const filter = Array.isArray(options.tables)
    ? new Set(options.tables.map((name) => String(name).toLowerCase()))
    : null;
  const selectedTables = filter
    ? tables.filter((t) => filter.has(String(t.name).toLowerCase()))
    : tables;
  const selectedIds = new Set(selectedTables.map((t) => t.id));
  const tablesById = new Map(tables.map((t) => [t.id, t]));

  const selectedRelationships = filter
    ? relationships.filter(
        (r) => selectedIds.has(r.startTableId) || selectedIds.has(r.endTableId),
      )
    : relationships;

  const out = {
    database: diagram.database,
    counts: {
      tables: tables.length,
      fields: tables.reduce((sum, t) => sum + (t.fields?.length ?? 0), 0),
      relationships: relationships.length,
      enums: enums.length,
      types: types.length,
    },
    tables: selectedTables.map(describeTable),
    relationships: selectedRelationships.map((r) =>
      describeRelationship(r, tablesById),
    ),
  };
  if (enums.length) {
    out.enums = enums.map((e) => ({ name: e.name, values: e.values ?? [] }));
  }
  if (types.length) {
    out.types = types.map((t) => ({
      name: t.name,
      fields: (t.fields ?? []).map((f) => ({ name: f.name, type: f.type })),
    }));
  }
  return out;
}
