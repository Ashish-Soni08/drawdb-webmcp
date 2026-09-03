import { DB } from "../data/constants";
import { getRelationshipFields } from "../utils/utils";

/**
 * Turns common, mechanically fixable problems into ready-to-apply
 * `apply_schema_changes` operations so an agent can validate and repair in one
 * round trip. Only deterministic fixes are suggested; everything else stays a
 * plain issue string from drawDB's issue engine.
 */

function integerType(database) {
  return database === DB.GENERIC ? "INT" : "INTEGER";
}

export function suggestFixes(diagram) {
  const suggestions = [];
  const tables = diagram.tables ?? [];
  const relationships = diagram.relationships ?? [];

  for (const table of tables) {
    const fields = table.fields ?? [];
    if (!table.name) continue;

    if (!fields.some((f) => f.primary)) {
      const hasId = fields.some((f) => f.name.toLowerCase() === "id");
      suggestions.push({
        table: table.name,
        issue: `Table "${table.name}" has no primary key.`,
        operation: hasId
          ? {
              op: "update_field",
              table: table.name,
              field: fields.find((f) => f.name.toLowerCase() === "id").name,
              set: { primary: true, notNull: true },
            }
          : {
              op: "add_field",
              table: table.name,
              field: {
                name: "id",
                type: integerType(diagram.database),
                primary: true,
                notNull: true,
                increment: true,
              },
            },
      });
    }

    for (const field of fields) {
      if ((field.type === "ENUM" || field.type === "SET") && !(field.values?.length)) {
        suggestions.push({
          table: table.name,
          field: field.name,
          issue: `Field "${table.name}.${field.name}" is ${field.type} but has no values.`,
          operation: {
            op: "update_field",
            table: table.name,
            field: field.name,
            set: { values: ["<add values here>"] },
          },
          needsInput: true,
        });
      }
    }
  }

  // Foreign-key columns without an index: not an error in drawDB's validator,
  // but the most common performance oversight and cheap to fix additively.
  const tablesById = new Map(tables.map((t) => [t.id, t]));
  for (const relationship of relationships) {
    const table = tablesById.get(relationship.startTableId);
    if (!table) continue;
    for (const pair of getRelationshipFields(relationship)) {
      const field = table.fields.find((f) => f.id === pair.startFieldId);
      if (!field || field.primary || field.unique) continue;
      const covered = (table.indices ?? []).some(
        (index) => index.fields?.[0] === field.name,
      );
      if (covered) continue;
      const name = `${table.name}_${field.name}_idx`;
      if (suggestions.some((s) => s.operation?.index?.name === name)) continue;
      suggestions.push({
        table: table.name,
        field: field.name,
        issue: `Foreign key column "${table.name}.${field.name}" has no index.`,
        severity: "hint",
        operation: {
          op: "add_index",
          table: table.name,
          index: { name, fields: [field.name] },
        },
      });
    }
  }

  return suggestions;
}
