import { dbToTypes } from "../data/datatypes";
import { getRelationshipFields } from "../utils/utils";
import { suggestFixes } from "./suggestFixes";

/**
 * `review_schema`: opinionated design review of the live diagram, beyond the
 * hard errors drawDB's validator reports. Every finding is structured
 * (severity, code, table, field, message) and carries a ready-to-apply
 * `fix` operation when one is safe to propose. The agent decides what to do;
 * nothing here mutates state.
 */

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;
const TIMESTAMP_NAMES = ["created_at", "createdat", "created", "inserted_at"];

function finding(severity, code, message, extra = {}) {
  return { severity, code, message, ...extra };
}

export function reviewSchema(diagram, validatorIssues = []) {
  const findings = [];
  const tables = diagram.tables ?? [];
  const relationships = diagram.relationships ?? [];
  const types = dbToTypes[diagram.database] || {};

  for (const issue of validatorIssues) {
    findings.push(finding("error", "validator", issue));
  }

  for (const suggestion of suggestFixes(diagram)) {
    findings.push(
      finding(
        suggestion.severity === "hint" ? "hint" : "warning",
        suggestion.operation.op === "add_index" ? "fk_without_index" : "fixable",
        suggestion.issue,
        {
          table: suggestion.table,
          ...(suggestion.field && { field: suggestion.field }),
          ...(!suggestion.needsInput && { fix: suggestion.operation }),
        },
      ),
    );
  }

  const linkedTableIds = new Set();
  for (const r of relationships) {
    linkedTableIds.add(r.startTableId);
    linkedTableIds.add(r.endTableId);
  }
  const fkFieldIds = new Set();
  for (const r of relationships) {
    for (const pair of getRelationshipFields(r)) fkFieldIds.add(pair.startFieldId);
  }

  for (const table of tables) {
    const fields = table.fields ?? [];

    if (!SNAKE_CASE.test(table.name)) {
      findings.push(
        finding("hint", "naming", `Table "${table.name}" is not snake_case; mixed naming styles make generated SQL harder to use.`, {
          table: table.name,
        }),
      );
    }

    if (tables.length > 1 && !linkedTableIds.has(table.id)) {
      findings.push(
        finding("hint", "isolated_table", `Table "${table.name}" has no relationships to any other table.`, {
          table: table.name,
        }),
      );
    }

    if (!fields.some((f) => TIMESTAMP_NAMES.includes(f.name.toLowerCase()))) {
      const timestampType = types.TIMESTAMP ? "TIMESTAMP" : types.DATETIME ? "DATETIME" : null;
      findings.push(
        finding("hint", "no_created_at", `Table "${table.name}" has no creation timestamp column.`, {
          table: table.name,
          ...(timestampType && {
            fix: {
              op: "add_field",
              table: table.name,
              field: { name: "created_at", type: timestampType, notNull: true },
            },
          }),
        }),
      );
    }

    for (const field of fields) {
      if (!SNAKE_CASE.test(field.name)) {
        findings.push(
          finding("hint", "naming", `Column "${table.name}.${field.name}" is not snake_case.`, {
            table: table.name,
            field: field.name,
          }),
        );
      }
      const meta = types[field.type];
      if (meta?.isSized && (field.size === undefined || field.size === "")) {
        findings.push(
          finding("warning", "unsized_type", `Column "${table.name}.${field.name}" is ${field.type} without a length.`, {
            table: table.name,
            field: field.name,
          }),
        );
      }
      if (fkFieldIds.has(field.id) && !field.notNull && !field.primary) {
        findings.push(
          finding("hint", "nullable_fk", `Foreign key column "${table.name}.${field.name}" allows NULL; make it NOT NULL if the relationship is mandatory.`, {
            table: table.name,
            field: field.name,
            fix: { op: "update_field", table: table.name, field: field.name, set: { notNull: true } },
          }),
        );
      }
    }
  }

  const counts = { error: 0, warning: 0, hint: 0 };
  for (const f of findings) counts[f.severity] += 1;

  return {
    summary: counts,
    findings,
    fixableCount: findings.filter((f) => f.fix).length,
  };
}
