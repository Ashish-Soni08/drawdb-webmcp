import { getIssues } from "../utils/issues";
import { suggestFixes } from "./suggestFixes";
import { IMPORT_LIMITS, planSqlImport } from "./importSql";
import { reviewSchema } from "./reviewSchema";
import { buildMigration, snapshotSchema } from "./migration";
import {
  planRemoval,
  REMOVAL_KINDS,
  REMOVAL_LIMITS,
  summarizeRemoval,
} from "./planRemoval";
import { ANNOTATE_LIMITS, planAnnotations } from "./annotate";
import { generateSampleInserts, SAMPLE_LIMITS } from "./sampleData";
import { explainJoinPath } from "./joinPath";
import { describeSchema } from "./describeSchema";
import { generateSql, SQL_DIALECTS } from "./generateSql";
import { toolFailure, toolSuccess } from "./modelContext";
import {
  LIMITS,
  OPERATIONS,
  planSchemaChanges,
  summarizeChanges,
} from "./planSchemaChanges";

/**
 * SchemaPair's WebMCP tools.
 *
 * `bridge` is supplied by `WebMCPBridge` and always reads the *current* React
 * state through refs, so these handlers never see stale closures:
 *   bridge.getState()  -> { database, tables, relationships, enums, types,
 *                          readOnly, tableWidth, pan }
 *   bridge.applyChanges(next, summary) -> applies a planned next state as one
 *                                          undoable action
 *   bridge.record?({ tool, ok, summary }) -> optional activity-trail hook
 */

const fieldSchema = {
  type: "object",
  description:
    "Column definition. Types must be valid for the diagram's database (see inspect_schema.database), e.g. INT, BIGINT, VARCHAR, TEXT, BOOLEAN, TIMESTAMP, DECIMAL, UUID (PostgreSQL).",
  properties: {
    name: { type: "string" },
    type: { type: "string" },
    size: {
      type: "number",
      description: "Length/precision for sized types such as VARCHAR.",
    },
    primary: { type: "boolean" },
    notNull: { type: "boolean" },
    unique: { type: "boolean" },
    increment: {
      type: "boolean",
      description: "Auto-increment (integer types only).",
    },
    default: { type: "string" },
    comment: { type: "string" },
    values: {
      type: "array",
      items: { type: "string" },
      description: "Required for ENUM/SET fields.",
    },
  },
  required: ["name", "type"],
};

const endpointSchema = {
  type: "object",
  properties: {
    table: { type: "string" },
    field: { type: "string" },
  },
  required: ["table", "field"],
};

const operationSchema = {
  type: "object",
  description:
    "One change. add_table: {name, fields[], indexes?[], comment?}. add_field: {table, field}. add_index: {table, index:{name?, fields[], unique?}}. add_relationship: {from:{table,field} (child/FK side), to:{table,field} (referenced side), name?, cardinality?, onUpdate?, onDelete?}. update_table: {table, set:{name?, comment?, color?}}. update_field: {table, field, set:{...field properties}}.",
  properties: {
    op: { type: "string", enum: [...OPERATIONS] },
    name: { type: "string" },
    table: { type: "string" },
    field: {
      description:
        "For add_field: a column object. For update_field: the existing column name.",
      anyOf: [{ type: "string" }, fieldSchema],
    },
    fields: { type: "array", items: fieldSchema },
    indexes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          fields: { type: "array", items: { type: "string" } },
          unique: { type: "boolean" },
        },
        required: ["fields"],
      },
    },
    index: {
      type: "object",
      properties: {
        name: { type: "string" },
        fields: { type: "array", items: { type: "string" } },
        unique: { type: "boolean" },
      },
      required: ["fields"],
    },
    from: endpointSchema,
    to: endpointSchema,
    cardinality: {
      type: "string",
      enum: ["one_to_one", "one_to_many", "many_to_one"],
    },
    onUpdate: {
      type: "string",
      enum: ["No action", "Restrict", "Cascade", "Set null", "Set default"],
    },
    onDelete: {
      type: "string",
      enum: ["No action", "Restrict", "Cascade", "Set null", "Set default"],
    },
    comment: { type: "string" },
    color: { type: "string", description: "#rrggbb" },
    set: { type: "object" },
  },
  required: ["op"],
};

function guard(bridge, toolName, handler) {
  return async (input) => {
    let result;
    try {
      result = await handler(input ?? {});
    } catch (error) {
      result = toolFailure("internal_error", String(error?.message ?? error));
    }
    try {
      bridge.record?.({ tool: toolName, ...describeResult(result) });
    } catch {
      // The activity trail must never break a tool call.
    }
    return result;
  };
}

/** One-line human summary of a tool result for the activity trail. */
function describeResult(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: true, summary: "completed" };
  }
  if (!parsed.ok)
    return { ok: false, summary: parsed.error?.message ?? "failed" };
  if (parsed.applied)
    return { ok: true, summary: summarizeChanges(parsed.applied) };
  if (parsed.imported)
    return {
      ok: true,
      summary: `imported ${summarizeChanges(parsed.imported)}`,
    };
  if (parsed.dryRun) {
    return {
      ok: true,
      summary: `dry run: ${summarizeChanges(parsed.wouldApply ?? parsed.wouldImport)}`,
    };
  }
  if (parsed.counts) {
    return {
      ok: true,
      summary: `read ${parsed.counts.tables} table(s), ${parsed.counts.relationships} relationship(s)`,
    };
  }
  if (typeof parsed.issueCount === "number") {
    return {
      ok: true,
      summary: parsed.valid
        ? "no issues found"
        : `${parsed.issueCount} issue(s) found`,
    };
  }
  if (parsed.tableOrder) {
    return {
      ok: true,
      summary: `generated sample inserts for ${parsed.tableOrder.length} table(s)`,
    };
  }
  if (parsed.hops) {
    return {
      ok: true,
      summary: parsed.connected
        ? `join path with ${parsed.hops.length} hop(s)`
        : "no join path",
    };
  }
  if (parsed.sql !== undefined) {
    return {
      ok: true,
      summary: `generated ${parsed.dialect} SQL (${parsed.sql.split("\n").length} lines)`,
    };
  }
  if (parsed.up !== undefined) {
    return {
      ok: true,
      summary: `generated ${parsed.dialect} migration (${parsed.changeCount} change(s))`,
    };
  }
  if (parsed.findings) {
    const s = parsed.summary;
    return {
      ok: true,
      summary: `review: ${s.error} error(s), ${s.warning} warning(s), ${s.hint} hint(s)`,
    };
  }
  if (parsed.movedTables !== undefined) {
    return { ok: true, summary: `arranged ${parsed.movedTables} table(s)` };
  }
  if (parsed.proposalId && parsed.impact) {
    return {
      ok: true,
      summary: `proposed: ${summarizeRemoval(parsed.impact)} (awaiting your confirmation)`,
    };
  }
  if (parsed.status && parsed.proposalId) {
    return { ok: true, summary: `removal proposal is ${parsed.status}` };
  }
  if (parsed.annotated) {
    return {
      ok: true,
      summary: `added ${parsed.annotated.notes} note(s), ${parsed.annotated.areas} area(s)`,
    };
  }
  return { ok: true, summary: "completed" };
}

export function createSchemaPairTools(bridge) {
  const inspectSchema = {
    name: "inspect_schema",
    description:
      "Read the database diagram currently open in the SchemaPair (drawDB) editor: database type, tables, columns, indexes, and relationships. Call this first; use the returned names in other tools. Optionally filter by table names.",
    inputSchema: {
      type: "object",
      properties: {
        tables: {
          type: "array",
          items: { type: "string" },
          description: "Only return these tables (and their relationships).",
        },
      },
    },
    annotations: { readOnlyHint: true },
    execute: guard(bridge, "inspect_schema", async (input) => {
      const state = bridge.getState();
      return toolSuccess({
        ...describeSchema(state, { tables: input.tables }),
        readOnly: Boolean(state.readOnly),
      });
    }),
  };

  const applySchemaChanges = {
    name: "apply_schema_changes",
    description: `Add tables, columns, indexes, and relationships to the live diagram, or update safe properties of existing ones. The whole request is validated first; on any error nothing changes. Changes appear on the canvas immediately and can be undone by the user (Ctrl+Z). Deleting is not supported. Max ${LIMITS.operations} operations per call. Set dryRun to validate without applying.`,
    inputSchema: {
      type: "object",
      properties: {
        operations: { type: "array", items: operationSchema },
        dryRun: { type: "boolean" },
      },
      required: ["operations"],
    },
    execute: guard(bridge, "apply_schema_changes", async (input) => {
      const state = bridge.getState();
      if (state.readOnly) {
        return toolFailure(
          "read_only",
          "The editor is in read-only mode (viewing a shared or historical version); changes are not allowed.",
        );
      }
      const plan = planSchemaChanges(input, state, {
        tableWidth: state.tableWidth,
        pan: state.pan,
      });
      if (!plan.ok) {
        return toolFailure(
          "invalid_request",
          "No changes were applied. Fix the listed problems and retry.",
          plan.errors,
        );
      }
      if (input.dryRun) {
        return toolSuccess({ dryRun: true, wouldApply: plan.summary });
      }
      bridge.applyChanges(plan.next, plan.summary);
      return toolSuccess({
        applied: plan.summary,
        message: `Applied: ${summarizeChanges(plan.summary)}. The canvas is updated; the user can undo with Ctrl+Z.`,
      });
    }),
  };

  const validateSchema = {
    name: "validate_schema",
    description:
      "Run the editor's built-in schema checks on the live diagram (missing primary keys, duplicate names, empty fields, invalid defaults, circular references, ...). Returns human-readable issues plus 'suggestions': ready-made operations you can pass straight to apply_schema_changes to fix them (entries with needsInput:true need real values first). Empty issues means the diagram is valid.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    execute: guard(bridge, "validate_schema", async () => {
      const state = bridge.getState();
      const issues = getIssues({
        tables: state.tables,
        relationships: state.relationships,
        types: state.types,
        enums: state.enums,
        database: state.database,
      });
      return toolSuccess({
        valid: issues.length === 0,
        issueCount: issues.length,
        issues,
        suggestions: suggestFixes(state),
      });
    }),
  };

  const generateSqlTool = {
    name: "generate_sql",
    description: `Generate CREATE TABLE / foreign-key SQL for the live diagram in its database dialect. The SQL is returned as text only and is never executed. For generic diagrams pass "dialect" (default postgresql). Dialects: ${SQL_DIALECTS.join(", ")}.`,
    inputSchema: {
      type: "object",
      properties: {
        dialect: { type: "string", enum: [...SQL_DIALECTS] },
      },
    },
    annotations: { readOnlyHint: true },
    execute: guard(bridge, "generate_sql", async (input) => {
      const state = bridge.getState();
      const result = generateSql(state, input.dialect);
      if (!result.ok) return toolFailure("invalid_request", result.message);
      return toolSuccess({
        dialect: result.dialect,
        tableCount: state.tables.length,
        sql: result.sql,
      });
    }),
  };

  const importSqlTool = {
    name: "import_sql",
    description: `Import CREATE TABLE statements (DDL) into the live diagram as new tables and relationships, using the editor's own SQL importer. Append-only: tables that already exist are rejected, nothing is overwritten, and the whole import is one undo step. For generic diagrams pass "dialect" (default postgresql). Max ${IMPORT_LIMITS.sqlBytes} characters. Set dryRun to preview.`,
    inputSchema: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description: "DDL text, e.g. CREATE TABLE ... statements.",
        },
        dialect: { type: "string", enum: [...SQL_DIALECTS] },
        dryRun: { type: "boolean" },
      },
      required: ["sql"],
    },
    execute: guard(bridge, "import_sql", async (input) => {
      const state = bridge.getState();
      if (state.readOnly) {
        return toolFailure(
          "read_only",
          "The editor is in read-only mode; imports are not allowed.",
        );
      }
      const plan = planSqlImport(input, state, {
        tableWidth: state.tableWidth,
        pan: state.pan,
      });
      if (!plan.ok) return toolFailure("invalid_request", plan.message);
      if (input.dryRun) {
        return toolSuccess({
          dryRun: true,
          wouldImport: plan.summary,
          warnings: plan.warnings,
        });
      }
      bridge.applyChanges(plan.next, plan.summary);
      return toolSuccess({
        dialect: plan.dialect,
        imported: plan.summary,
        warnings: plan.warnings,
        message: `Imported ${summarizeChanges(plan.summary)}. The canvas is updated; the user can undo with Ctrl+Z.`,
      });
    }),
  };

  const reviewSchemaTool = {
    name: "review_schema",
    description:
      "Design review of the live diagram: validator errors plus warnings and hints (foreign keys without indexes, nullable FKs, missing primary keys or timestamps, unsized VARCHARs, isolated tables, naming). Each finding has severity, code, table/field, and, where safe, a ready-made 'fix' operation for apply_schema_changes. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        severity: {
          type: "string",
          enum: ["error", "warning", "hint"],
          description: "Only return findings at this severity or above.",
        },
      },
    },
    annotations: { readOnlyHint: true },
    execute: guard(bridge, "review_schema", async (input) => {
      const state = bridge.getState();
      const issues = getIssues({
        tables: state.tables,
        relationships: state.relationships,
        types: state.types,
        enums: state.enums,
        database: state.database,
      });
      const review = reviewSchema(state, issues);
      const rank = { error: 0, warning: 1, hint: 2 };
      const max = rank[input.severity] ?? 2;
      const findings = review.findings.filter((f) => rank[f.severity] <= max);
      return toolSuccess({
        summary: review.summary,
        fixableCount: findings.filter((f) => f.fix).length,
        findings,
      });
    }),
  };

  const generateMigrationTool = {
    name: "generate_migration",
    description:
      "Generate up/down migration SQL between a baseline and the current diagram. The baseline is the diagram as it was when the editor loaded (or the last call with resetBaseline=true). Text only, never executed. For generic diagrams pass 'dialect'.",
    inputSchema: {
      type: "object",
      properties: {
        dialect: { type: "string", enum: [...SQL_DIALECTS] },
        resetBaseline: {
          type: "boolean",
          description:
            "After generating, make the current diagram the new baseline.",
        },
      },
    },
    annotations: { readOnlyHint: true },
    execute: guard(bridge, "generate_migration", async (input) => {
      const state = bridge.getState();
      const current = snapshotSchema(state);
      const baseline = bridge.getBaseline?.() ?? snapshotSchema({});
      const result = buildMigration(
        baseline,
        current,
        state.database,
        input.dialect,
      );
      if (!result.ok) return toolFailure("invalid_request", result.message);
      if (input.resetBaseline) bridge.setBaseline?.(current);
      return toolSuccess({
        dialect: result.dialect,
        changeCount: result.changeCount,
        up: result.up,
        down: result.down,
        baselineReset: Boolean(input.resetBaseline),
      });
    }),
  };

  const arrangeTablesTool = {
    name: "arrange_tables",
    description:
      "Auto-arrange all unlocked tables on the canvas using the editor's layout engine (related tables are placed near each other). Only positions change; the schema is untouched. One undo step.",
    inputSchema: { type: "object", properties: {} },
    execute: guard(bridge, "arrange_tables", async () => {
      const state = bridge.getState();
      if (state.readOnly) {
        return toolFailure("read_only", "The editor is in read-only mode.");
      }
      const moved = bridge.arrangeTables?.() ?? 0;
      return toolSuccess({
        movedTables: moved,
        message: moved
          ? `Rearranged ${moved} table(s). The user can undo with Ctrl+Z.`
          : "Tables were already arranged; nothing moved.",
      });
    }),
  };

  const planRemovalTool = {
    name: "plan_removal",
    description: `Propose removing tables, columns, relationships, or indexes. Nothing is deleted by this call: it returns the full impact (cascaded relationships, pruned indexes) and shows a confirmation card in the editor. Only the user can confirm or reject it there; poll removal_status to learn the outcome. Max ${REMOVAL_LIMITS.targets} targets.`,
    inputSchema: {
      type: "object",
      properties: {
        targets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: [...REMOVAL_KINDS] },
              table: {
                type: "string",
                description: "For table, field, index.",
              },
              field: { type: "string", description: "For field." },
              name: {
                type: "string",
                description: "Relationship or index name.",
              },
            },
            required: ["kind"],
          },
        },
        reason: {
          type: "string",
          description: "Shown to the user on the confirmation card.",
        },
      },
      required: ["targets"],
    },
    execute: guard(bridge, "plan_removal", async (input) => {
      const state = bridge.getState();
      if (state.readOnly)
        return toolFailure("read_only", "The editor is in read-only mode.");
      const plan = planRemoval(input, state);
      if (!plan.ok) {
        return toolFailure(
          "invalid_request",
          "No proposal was created. Fix the listed problems and retry.",
          plan.errors,
        );
      }
      const proposal = bridge.proposeRemoval?.(
        plan,
        typeof input.reason === "string" ? input.reason : "",
      );
      if (!proposal)
        return toolFailure(
          "unavailable",
          "Removal proposals are not available here.",
        );
      return toolSuccess({
        proposalId: proposal.id,
        status: "pending",
        impact: plan.impact,
        message: `Proposed to ${summarizeRemoval(plan.impact)}. Ask the user to click Confirm in the editor's Agent activity panel, then call removal_status.`,
      });
    }),
  };

  const removalStatusTool = {
    name: "removal_status",
    description:
      "Check whether a removal proposal from plan_removal is pending, confirmed, rejected, or superseded.",
    inputSchema: {
      type: "object",
      properties: { proposalId: { type: "string" } },
      required: ["proposalId"],
    },
    annotations: { readOnlyHint: true },
    execute: guard(bridge, "removal_status", async (input) => {
      const proposal = bridge.getProposal?.(input.proposalId);
      if (!proposal)
        return toolFailure("not_found", `No proposal "${input.proposalId}".`);
      return toolSuccess({
        proposalId: proposal.id,
        status: proposal.status,
        impact: proposal.impact,
      });
    }),
  };

  const annotateTool = {
    name: "annotate_diagram",
    description: `Add sticky notes and subject areas (colored groups) to the canvas. notes: [{content, title?, near?: tableName, color?}]; areas: [{name, tables: [names], color?}] — an area is sized to wrap its tables. Undoable. Max ${ANNOTATE_LIMITS.notes} notes and ${ANNOTATE_LIMITS.areas} areas per call.`,
    inputSchema: {
      type: "object",
      properties: {
        notes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              title: { type: "string" },
              near: {
                type: "string",
                description: "Place next to this table.",
              },
              color: { type: "string", description: "#rrggbb" },
            },
            required: ["content"],
          },
        },
        areas: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              tables: { type: "array", items: { type: "string" } },
              color: { type: "string", description: "#rrggbb" },
            },
            required: ["name", "tables"],
          },
        },
      },
    },
    execute: guard(bridge, "annotate_diagram", async (input) => {
      const state = bridge.getState();
      if (state.readOnly)
        return toolFailure("read_only", "The editor is in read-only mode.");
      const plan = planAnnotations(input, state, {
        tableWidth: state.tableWidth,
        pan: state.pan,
      });
      if (!plan.ok)
        return toolFailure(
          "invalid_request",
          "Nothing was added.",
          plan.errors,
        );
      bridge.addAnnotations?.(plan);
      return toolSuccess({
        annotated: { notes: plan.notes.length, areas: plan.areas.length },
        message: `Added ${plan.notes.length} note(s) and ${plan.areas.length} area(s). The user can undo with Ctrl+Z.`,
      });
    }),
  };

  const sampleInsertsTool = {
    name: "generate_sample_inserts",
    description: `Generate deterministic INSERT statements with sample rows for the diagram (parents before children so foreign keys resolve). Text only, never executed. rows: 1-${SAMPLE_LIMITS.rows} per table (default 3); optional tables filter.`,
    inputSchema: {
      type: "object",
      properties: {
        rows: { type: "number" },
        tables: { type: "array", items: { type: "string" } },
      },
    },
    annotations: { readOnlyHint: true },
    execute: guard(bridge, "generate_sample_inserts", async (input) => {
      const state = bridge.getState();
      const result = generateSampleInserts(state, input);
      if (!result.ok) return toolFailure("invalid_request", result.message);
      return toolSuccess(result);
    }),
  };

  const joinPathTool = {
    name: "explain_join_path",
    description:
      "Explain how two tables connect: the shortest chain of foreign keys between them and a SELECT ... JOIN skeleton that follows it. Read-only.",
    inputSchema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"],
    },
    annotations: { readOnlyHint: true },
    execute: guard(bridge, "explain_join_path", async (input) => {
      const result = explainJoinPath(bridge.getState(), input);
      if (!result.ok) return toolFailure("invalid_request", result.message);
      return toolSuccess(result);
    }),
  };

  return [
    inspectSchema,
    applySchemaChanges,
    validateSchema,
    generateSqlTool,
    importSqlTool,
    reviewSchemaTool,
    generateMigrationTool,
    arrangeTablesTool,
    planRemovalTool,
    removalStatusTool,
    annotateTool,
    sampleInsertsTool,
    joinPathTool,
  ];
}
