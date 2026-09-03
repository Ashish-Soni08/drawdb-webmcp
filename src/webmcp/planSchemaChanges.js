import { nanoid } from "nanoid";
import { dbToTypes } from "../data/datatypes";
import {
  Cardinality,
  Constraint,
  defaultBlue,
  defaultRelationshipColor,
} from "../data/constants";
import { getTableHeight } from "../utils/utils";

/**
 * Pure planner for `apply_schema_changes`.
 *
 * It validates an entire request against a working copy of the live diagram
 * and either returns the complete next state (tables + relationships) or a
 * list of errors. Nothing here touches React state, so the bridge can apply
 * the result atomically and the module is unit-testable under plain Node.
 *
 * Supported operations are additive or non-destructive updates only:
 *   add_table, add_field, add_index, add_relationship, update_table, update_field
 * Deletion is intentionally not exposed in the MVP.
 */

export const LIMITS = Object.freeze({
  operations: 25,
  fieldsPerTable: 40,
  indexFields: 8,
  nameLength: 64,
  enumValues: 50,
});

export const OPERATIONS = Object.freeze([
  "add_table",
  "add_field",
  "add_index",
  "add_relationship",
  "update_table",
  "update_field",
]);

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const TABLE_GAP_X = 80;
const TABLE_GAP_Y = 40;
const TABLES_PER_COLUMN = 3;

// Common synonyms resolved only when the exact type does not exist for the
// database (mirrors the aliases used by drawDB's AI import). Anything else is
// rejected with the list of valid types rather than guessed.
const TYPE_ALIASES = {
  INT: ["INTEGER"],
  INTEGER: ["INT"],
  BOOL: ["BOOLEAN"],
  BOOLEAN: ["BOOL", "BIT"],
  STRING: ["VARCHAR", "TEXT"],
  DATETIME: ["TIMESTAMP", "DATETIME2"],
  TIMESTAMPTZ: ["TIMESTAMP WITH TIME ZONE", "TIMESTAMP"],
  "DOUBLE PRECISION": ["DOUBLE", "FLOAT"],
  DOUBLE: ["DOUBLE PRECISION", "FLOAT"],
  FLOAT: ["REAL", "DOUBLE PRECISION", "DOUBLE"],
  SERIAL: ["INTEGER", "INT"],
  BIGSERIAL: ["BIGINT"],
  JSONB: ["JSON"],
  BYTEA: ["BLOB", "BINARY"],
  BLOB: ["BYTEA", "BINARY"],
  NUMBER: ["NUMERIC", "DECIMAL"],
  UUID: ["VARCHAR", "TEXT"],
};

const CONSTRAINT_ALIASES = {
  "no action": Constraint.NONE,
  none: Constraint.NONE,
  restrict: Constraint.RESTRICT,
  cascade: Constraint.CASCADE,
  "set null": Constraint.SET_NULL,
  "set default": Constraint.SET_DEFAULT,
};

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const clone = (value) => JSON.parse(JSON.stringify(value));

class PlanError extends Error {
  constructor(path, message) {
    super(message);
    this.path = path;
  }
}

function assert(condition, path, message) {
  if (!condition) throw new PlanError(path, message);
}

function checkName(value, path, label) {
  assert(
    typeof value === "string" && value.trim() !== "",
    path,
    `${label} is required.`,
  );
  assert(
    value.length <= LIMITS.nameLength,
    path,
    `${label} "${value}" is longer than ${LIMITS.nameLength} characters.`,
  );
  assert(
    NAME_RE.test(value),
    path,
    `${label} "${value}" must be an identifier (letters, digits, underscores; not starting with a digit).`,
  );
  return value;
}

/** Case-insensitive lookup that refuses ambiguous matches instead of guessing. */
function findByName(items, name, path, label) {
  assert(
    typeof name === "string" && name !== "",
    path,
    `${label} name is required.`,
  );
  const exact = items.find((item) => item.name === name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  const matches = items.filter((item) => item.name.toLowerCase() === lower);
  assert(matches.length !== 0, path, `${label} "${name}" does not exist.`);
  assert(
    matches.length === 1,
    path,
    `${label} "${name}" is ambiguous (${matches.map((m) => m.name).join(", ")}).`,
  );
  return matches[0];
}

function hasName(items, name, exceptId) {
  const lower = name.toLowerCase();
  return items.some(
    (item) => item.id !== exceptId && item.name.toLowerCase() === lower,
  );
}

/** Builds the set of type names an agent may use for this diagram. */
function buildTypeCatalog(database, enums, types) {
  const catalog = new Map();
  const builtin = dbToTypes[database] || {};
  for (const key of Object.keys(builtin)) catalog.set(key, builtin[key]);
  for (const e of enums ?? []) {
    if (e?.name)
      catalog.set(String(e.name).toUpperCase(), {
        type: e.name,
        custom: "enum",
      });
  }
  for (const t of types ?? []) {
    if (t?.name)
      catalog.set(String(t.name).toUpperCase(), {
        type: t.name,
        custom: "type",
      });
  }
  return catalog;
}

function resolveType(rawType, catalog, database, path) {
  assert(
    typeof rawType === "string" && rawType.trim() !== "",
    path,
    "Field type is required.",
  );
  const upper = rawType.trim().toUpperCase();
  let info = catalog.get(upper);
  let resolved = upper;
  if (!info) {
    for (const alias of TYPE_ALIASES[upper] ?? []) {
      if (catalog.has(alias)) {
        info = catalog.get(alias);
        resolved = alias;
        break;
      }
    }
  }
  if (!info) {
    const sample = [...catalog.keys()].slice(0, 12).join(", ");
    throw new PlanError(
      path,
      `Type "${rawType}" is not available for ${database}. Examples: ${sample}.`,
    );
  }
  return { type: resolved, info };
}

function normalizeDefault(value, path) {
  if (value === undefined || value === null) return "";
  assert(
    ["string", "number", "boolean"].includes(typeof value),
    path,
    "Field default must be a string, number, or boolean.",
  );
  return String(value);
}

function normalizeValues(values, type, path) {
  if (type !== "ENUM" && type !== "SET") return undefined;
  assert(
    Array.isArray(values) && values.length > 0,
    path,
    `${type} fields need a non-empty "values" array.`,
  );
  assert(values.length <= LIMITS.enumValues, path, `Too many ${type} values.`);
  assert(
    values.every((v) => typeof v === "string" && v !== ""),
    path,
    `${type} values must be non-empty strings.`,
  );
  return values;
}

/** Converts agent field input into drawDB's field shape. */
function buildField(input, ctx, path) {
  assert(isObject(input), path, "Field must be an object.");
  const name = checkName(input.name, `${path}.name`, "Field name");
  const { type, info } = resolveType(
    input.type,
    ctx.catalog,
    ctx.database,
    `${path}.type`,
  );

  const primary = Boolean(input.primary);
  const increment = Boolean(input.increment);
  assert(
    !increment || info.canIncrement,
    `${path}.increment`,
    `Type ${type} cannot auto-increment.`,
  );

  const field = {
    id: nanoid(),
    name,
    type,
    default: normalizeDefault(input.default, `${path}.default`),
    check: "",
    primary,
    unique: Boolean(input.unique),
    notNull: primary || Boolean(input.notNull),
    increment,
    comment: typeof input.comment === "string" ? input.comment : "",
  };

  if (info.isSized) {
    if (input.size !== undefined) {
      assert(
        (typeof input.size === "number" && input.size > 0) ||
          (typeof input.size === "string" && input.size !== ""),
        `${path}.size`,
        "Field size must be a positive number.",
      );
      field.size = input.size;
    } else if (info.defaultSize !== undefined) {
      field.size = info.defaultSize;
    }
  } else if (info.hasPrecision && input.size !== undefined) {
    field.size = input.size;
  }

  const values = normalizeValues(input.values, type, `${path}.values`);
  if (values) field.values = values;

  return field;
}

function buildIndex(input, table, path) {
  assert(isObject(input), path, "Index must be an object.");
  const n = table.indices.length;
  const name =
    input.name === undefined
      ? `${table.name}_index_${n}`
      : checkName(input.name, `${path}.name`, "Index name");
  assert(
    !table.indices.some((i) => i.name.toLowerCase() === name.toLowerCase()),
    `${path}.name`,
    `Index "${name}" already exists on table "${table.name}".`,
  );
  assert(
    Array.isArray(input.fields) && input.fields.length > 0,
    `${path}.fields`,
    'Index needs a non-empty "fields" array of field names.',
  );
  assert(
    input.fields.length <= LIMITS.indexFields,
    `${path}.fields`,
    `An index may cover at most ${LIMITS.indexFields} fields.`,
  );
  const fields = input.fields.map(
    (fieldName, i) =>
      findByName(table.fields, fieldName, `${path}.fields[${i}]`, "Field").name,
  );
  return { id: n, name, unique: Boolean(input.unique), fields };
}

function applyAddTable(op, ctx, path) {
  const name = checkName(op.name, `${path}.name`, "Table name");
  assert(
    !hasName(ctx.tables, name),
    `${path}.name`,
    `Table "${name}" already exists.`,
  );
  assert(
    Array.isArray(op.fields) && op.fields.length > 0,
    `${path}.fields`,
    'A new table needs a non-empty "fields" array.',
  );
  assert(
    op.fields.length <= LIMITS.fieldsPerTable,
    `${path}.fields`,
    `A table may have at most ${LIMITS.fieldsPerTable} fields.`,
  );

  const table = {
    id: nanoid(),
    name,
    x: 0,
    y: 0,
    locked: false,
    fields: [],
    comment: typeof op.comment === "string" ? op.comment : "",
    indices: [],
    uniqueConstraints: [],
    color: defaultBlue,
    collapsed: false,
  };
  if (op.color !== undefined) {
    assert(
      COLOR_RE.test(op.color),
      `${path}.color`,
      "Color must be a #rrggbb hex value.",
    );
    table.color = op.color;
  }

  op.fields.forEach((fieldInput, i) => {
    const field = buildField(fieldInput, ctx, `${path}.fields[${i}]`);
    assert(
      !hasName(table.fields, field.name),
      `${path}.fields[${i}].name`,
      `Field "${field.name}" is duplicated in table "${name}".`,
    );
    table.fields.push(field);
  });

  (op.indexes ?? []).forEach((indexInput, i) => {
    table.indices.push(buildIndex(indexInput, table, `${path}.indexes[${i}]`));
  });

  ctx.tables.push(table);
  ctx.createdTables.push(table);
  ctx.summary.tables.push(name);
}

function applyAddField(op, ctx, path) {
  const table = findByName(ctx.tables, op.table, `${path}.table`, "Table");
  assert(
    table.fields.length < LIMITS.fieldsPerTable,
    path,
    `Table "${table.name}" already has ${LIMITS.fieldsPerTable} fields.`,
  );
  const field = buildField(op.field, ctx, `${path}.field`);
  assert(
    !hasName(table.fields, field.name),
    `${path}.field.name`,
    `Field "${field.name}" already exists in table "${table.name}".`,
  );
  table.fields.push(field);
  ctx.summary.fields.push({ table: table.name, field: field.name });
}

function applyAddIndex(op, ctx, path) {
  const table = findByName(ctx.tables, op.table, `${path}.table`, "Table");
  const index = buildIndex(op.index, table, `${path}.index`);
  table.indices.push(index);
  ctx.summary.indexes.push({ table: table.name, index: index.name });
}

function resolveEndpoint(endpoint, ctx, path) {
  assert(
    isObject(endpoint),
    path,
    'Expected an object like { "table": "...", "field": "..." }.',
  );
  const table = findByName(
    ctx.tables,
    endpoint.table,
    `${path}.table`,
    "Table",
  );
  const field = findByName(
    table.fields,
    endpoint.field,
    `${path}.field`,
    "Field",
  );
  return { table, field };
}

function typesCompatible(database, typeA, typeB) {
  if (typeA === typeB) return true;
  const info = (dbToTypes[database] || {})[typeA];
  return Boolean(
    info && info.compatibleWith && info.compatibleWith.includes(typeB),
  );
}

function inferCardinality(startField, endField) {
  const startIsUnique = startField.unique || startField.primary;
  const endIsUnique = endField.unique || endField.primary;
  if (startIsUnique && endIsUnique) return Cardinality.ONE_TO_ONE;
  if (startIsUnique) return Cardinality.ONE_TO_MANY;
  return Cardinality.MANY_TO_ONE;
}

function resolveConstraint(value, path) {
  if (value === undefined) return Constraint.NONE;
  const key = String(value).toLowerCase().replace(/_/g, " ");
  const resolved = CONSTRAINT_ALIASES[key];
  assert(
    resolved,
    path,
    `Unknown referential action "${value}". Use: ${Object.values(Constraint).join(", ")}.`,
  );
  return resolved;
}

function applyAddRelationship(op, ctx, path) {
  // "from" owns the foreign-key column (drawDB's start side);
  // "to" is the referenced parent table (drawDB's end side).
  const from = resolveEndpoint(op.from, ctx, `${path}.from`);
  const to = resolveEndpoint(op.to, ctx, `${path}.to`);
  assert(
    !(from.table.id === to.table.id && from.field.id === to.field.id),
    path,
    "A relationship cannot link a field to itself.",
  );
  assert(
    typesCompatible(ctx.database, from.field.type, to.field.type),
    path,
    `Cannot relate ${from.table.name}.${from.field.name} (${from.field.type}) to ${to.table.name}.${to.field.name} (${to.field.type}): incompatible types.`,
  );
  assert(
    !ctx.relationships.some(
      (r) =>
        r.startTableId === from.table.id &&
        r.endTableId === to.table.id &&
        (r.startFieldId === from.field.id ||
          r.fields?.some((p) => p.startFieldId === from.field.id)),
    ),
    path,
    `${from.table.name}.${from.field.name} already references ${to.table.name}.`,
  );

  const name =
    op.name === undefined
      ? `fk_${from.table.name}_${from.field.name}_${to.table.name}`
      : checkName(op.name, `${path}.name`, "Relationship name");
  assert(
    !hasName(ctx.relationships, name),
    `${path}.name`,
    `Relationship "${name}" already exists.`,
  );

  let cardinality = inferCardinality(from.field, to.field);
  if (op.cardinality !== undefined) {
    const values = Object.values(Cardinality);
    assert(
      values.includes(op.cardinality),
      `${path}.cardinality`,
      `Cardinality must be one of: ${values.join(", ")}.`,
    );
    cardinality = op.cardinality;
  }

  const relationship = {
    id: nanoid(),
    name,
    startTableId: from.table.id,
    startFieldId: from.field.id,
    endTableId: to.table.id,
    endFieldId: to.field.id,
    fields: [{ startFieldId: from.field.id, endFieldId: to.field.id }],
    cardinality,
    updateConstraint: resolveConstraint(op.onUpdate, `${path}.onUpdate`),
    deleteConstraint: resolveConstraint(op.onDelete, `${path}.onDelete`),
    color: defaultRelationshipColor,
  };
  ctx.relationships.push(relationship);
  ctx.summary.relationships.push(name);
}

function applyUpdateTable(op, ctx, path) {
  const table = findByName(ctx.tables, op.table, `${path}.table`, "Table");
  assert(isObject(op.set), `${path}.set`, '"set" must be an object.');
  const allowed = ["name", "comment", "color"];
  const unknown = Object.keys(op.set).filter((k) => !allowed.includes(k));
  assert(
    unknown.length === 0,
    `${path}.set`,
    `update_table can only change: ${allowed.join(", ")} (got ${unknown.join(", ")}).`,
  );
  if (op.set.name !== undefined) {
    const name = checkName(op.set.name, `${path}.set.name`, "Table name");
    assert(
      !hasName(ctx.tables, name, table.id),
      `${path}.set.name`,
      `Table "${name}" already exists.`,
    );
    table.name = name;
  }
  if (op.set.comment !== undefined) {
    assert(
      typeof op.set.comment === "string",
      `${path}.set.comment`,
      "Comment must be a string.",
    );
    table.comment = op.set.comment;
  }
  if (op.set.color !== undefined) {
    assert(
      COLOR_RE.test(op.set.color),
      `${path}.set.color`,
      "Color must be a #rrggbb hex value.",
    );
    table.color = op.set.color;
  }
  ctx.summary.updatedTables.push(table.name);
}

function applyUpdateField(op, ctx, path) {
  const table = findByName(ctx.tables, op.table, `${path}.table`, "Table");
  const field = findByName(table.fields, op.field, `${path}.field`, "Field");
  assert(isObject(op.set), `${path}.set`, '"set" must be an object.');
  const allowed = [
    "name",
    "type",
    "size",
    "primary",
    "notNull",
    "unique",
    "increment",
    "default",
    "comment",
    "values",
  ];
  const unknown = Object.keys(op.set).filter((k) => !allowed.includes(k));
  assert(
    unknown.length === 0,
    `${path}.set`,
    `update_field can only change: ${allowed.join(", ")} (got ${unknown.join(", ")}).`,
  );

  // Build the merged field through the same validator used for new fields so
  // every rule (types, sizes, enum values, increment) applies uniformly.
  const merged = buildField(
    {
      name: field.name,
      type: field.type,
      size: field.size,
      primary: field.primary,
      notNull: field.notNull,
      unique: field.unique,
      increment: field.increment,
      default: field.default,
      comment: field.comment,
      values: field.values,
      ...op.set,
    },
    ctx,
    `${path}.set`,
  );
  assert(
    !hasName(table.fields, merged.name, field.id),
    `${path}.set.name`,
    `Field "${merged.name}" already exists in table "${table.name}".`,
  );

  const previousName = field.name;
  Object.assign(field, merged, { id: field.id, check: field.check });
  if (merged.size === undefined) delete field.size;
  if (merged.values === undefined) delete field.values;

  if (previousName !== field.name) {
    // Indexes reference fields by name; keep them consistent after a rename.
    for (const index of table.indices) {
      index.fields = index.fields.map((n) =>
        n === previousName ? field.name : n,
      );
    }
    for (const uc of table.uniqueConstraints ?? []) {
      uc.fields = uc.fields.map((n) => (n === previousName ? field.name : n));
    }
  }
  ctx.summary.updatedFields.push({ table: table.name, field: field.name });
}

const HANDLERS = {
  add_table: applyAddTable,
  add_field: applyAddField,
  add_index: applyAddIndex,
  add_relationship: applyAddRelationship,
  update_table: applyUpdateTable,
  update_field: applyUpdateField,
};

/**
 * Places newly created tables deterministically. Diagram coordinates put the
 * viewport centre at the pan point, so on an empty canvas the new block is
 * centred there; otherwise it goes in a column to the right of the existing
 * diagram. Columns wrap every few tables so the result stays legible.
 */
export function placeNewTables(existingTables, newTables, { tableWidth, pan }) {
  if (newTables.length === 0) return;

  // Lay out relative to (0, 0) first, tracking the block's overall size.
  let x = 0;
  let y = 0;
  let columnHeight = 0;
  let blockHeight = 0;
  newTables.forEach((table, i) => {
    if (i > 0 && i % TABLES_PER_COLUMN === 0) {
      x += tableWidth + TABLE_GAP_X;
      y = 0;
    }
    table.x = x;
    table.y = y;
    y += getTableHeight(table, tableWidth, false) + TABLE_GAP_Y;
    columnHeight = y - TABLE_GAP_Y;
    blockHeight = Math.max(blockHeight, columnHeight);
  });
  const blockWidth = x + tableWidth;

  let offsetX;
  let offsetY;
  if (existingTables.length === 0) {
    offsetX = (pan?.x ?? 0) - blockWidth / 2;
    offsetY = (pan?.y ?? 0) - blockHeight / 2;
  } else {
    offsetX =
      Math.max(...existingTables.map((t) => t.x)) + tableWidth + TABLE_GAP_X;
    offsetY = Math.min(...existingTables.map((t) => t.y));
  }
  for (const table of newTables) {
    table.x = Math.round(table.x + offsetX);
    table.y = Math.round(table.y + offsetY);
  }
}

function emptySummary() {
  return {
    tables: [],
    fields: [],
    indexes: [],
    relationships: [],
    updatedTables: [],
    updatedFields: [],
  };
}

/** One-line, human-readable description of a summary (used for undo history). */
export function summarizeChanges(summary) {
  const parts = [];
  if (summary.tables.length)
    parts.push(
      `added ${summary.tables.length} table(s): ${summary.tables.join(", ")}`,
    );
  if (summary.fields.length)
    parts.push(`added ${summary.fields.length} field(s)`);
  if (summary.indexes.length)
    parts.push(`added ${summary.indexes.length} index(es)`);
  if (summary.relationships.length)
    parts.push(`added ${summary.relationships.length} relationship(s)`);
  if (summary.updatedTables.length)
    parts.push(`updated table(s): ${summary.updatedTables.join(", ")}`);
  if (summary.updatedFields.length)
    parts.push(`updated ${summary.updatedFields.length} field(s)`);
  if (summary.enums?.length)
    parts.push(`added ${summary.enums.length} enum(s)`);
  if (summary.restored) parts.push(`restored checkpoint "${summary.restored}"`);
  return parts.length ? parts.join("; ") : "no changes";
}

/**
 * Validates and plans a whole request.
 *
 * @param {object} request `{ operations: [...] }`
 * @param {{database:string, tables:Array, relationships:Array, enums?:Array, types?:Array}} diagram live state
 * @param {{tableWidth:number, pan:{x:number,y:number}}} layout used to place new tables
 * @returns {{ok:true, next:{tables:Array, relationships:Array}, summary:object}
 *         | {ok:false, errors:Array<{operation:number|null, path:string, message:string}>}}
 */
export function planSchemaChanges(request, diagram, layout) {
  if (!isObject(request) || !Array.isArray(request.operations)) {
    return {
      ok: false,
      errors: [
        {
          operation: null,
          path: "operations",
          message: 'Expected { "operations": [...] }.',
        },
      ],
    };
  }
  if (request.operations.length === 0) {
    return {
      ok: false,
      errors: [
        {
          operation: null,
          path: "operations",
          message: "At least one operation is required.",
        },
      ],
    };
  }
  if (request.operations.length > LIMITS.operations) {
    return {
      ok: false,
      errors: [
        {
          operation: null,
          path: "operations",
          message: `Too many operations (${request.operations.length}); the limit is ${LIMITS.operations} per call. Split the request.`,
        },
      ],
    };
  }

  const ctx = {
    database: diagram.database,
    tables: clone(diagram.tables ?? []),
    relationships: clone(diagram.relationships ?? []),
    catalog: buildTypeCatalog(diagram.database, diagram.enums, diagram.types),
    createdTables: [],
    summary: emptySummary(),
  };
  for (const table of ctx.tables) {
    table.indices ??= [];
    table.uniqueConstraints ??= [];
    table.fields ??= [];
  }

  const errors = [];
  request.operations.forEach((op, i) => {
    const path = `operations[${i}]`;
    try {
      assert(isObject(op), path, "Operation must be an object.");
      assert(
        OPERATIONS.includes(op.op),
        `${path}.op`,
        `Unknown operation "${op.op}". Supported: ${OPERATIONS.join(", ")}.`,
      );
      HANDLERS[op.op](op, ctx, path);
    } catch (error) {
      if (!(error instanceof PlanError)) throw error;
      errors.push({ operation: i, path: error.path, message: error.message });
    }
  });

  if (errors.length) return { ok: false, errors };

  placeNewTables(
    ctx.tables.filter((t) => !ctx.createdTables.includes(t)),
    ctx.createdTables,
    layout,
  );

  return {
    ok: true,
    next: { tables: ctx.tables, relationships: ctx.relationships },
    summary: ctx.summary,
  };
}
