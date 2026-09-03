import { defaultBlue, defaultNoteTheme, noteWidth } from "../data/constants";
import { getTableHeight } from "../utils/utils";

/**
 * `annotate_diagram`: plans sticky notes and subject areas (groups) around
 * existing tables. Pure: returns the note/area objects in drawDB's shape and
 * leaves committing them (with undo entries) to the bridge.
 */

export const ANNOTATE_LIMITS = Object.freeze({
  notes: 10,
  areas: 10,
  textLength: 2000,
});

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const AREA_PADDING = 40;
const NOTE_GAP = 24;

const isObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function findTable(tables, name) {
  if (typeof name !== "string" || !name) return null;
  return (
    tables.find((t) => t.name === name) ??
    tables.find((t) => t.name.toLowerCase() === name.toLowerCase()) ??
    null
  );
}

/**
 * @param {{notes?:Array, areas?:Array}} input
 * @param {{tables:Array, notes:Array, areas:Array}} state live editor state
 * @param {{tableWidth:number, pan:{x:number,y:number}}} layout
 * @returns {{ok:true, notes:Array, areas:Array} | {ok:false, errors:Array}}
 */
export function planAnnotations(input, state, layout) {
  const errors = [];
  const notesIn = Array.isArray(input?.notes) ? input.notes : [];
  const areasIn = Array.isArray(input?.areas) ? input.areas : [];
  if (notesIn.length === 0 && areasIn.length === 0) {
    return {
      ok: false,
      errors: [
        { path: "input", message: 'Provide "notes" and/or "areas" arrays.' },
      ],
    };
  }
  if (
    notesIn.length > ANNOTATE_LIMITS.notes ||
    areasIn.length > ANNOTATE_LIMITS.areas
  ) {
    return {
      ok: false,
      errors: [
        {
          path: "input",
          message: `At most ${ANNOTATE_LIMITS.notes} notes and ${ANNOTATE_LIMITS.areas} areas per call.`,
        },
      ],
    };
  }

  const tables = state.tables ?? [];
  const notes = [];
  const areas = [];
  let noteIndex = (state.notes ?? []).length;
  let areaIndex = (state.areas ?? []).length;
  let stackY = layout.pan?.y ?? 0;

  areasIn.forEach((a, i) => {
    const path = `areas[${i}]`;
    if (!isObject(a) || typeof a.name !== "string" || !a.name.trim()) {
      errors.push({ path, message: "Area needs a non-empty name." });
      return;
    }
    if (!Array.isArray(a.tables) || a.tables.length === 0) {
      errors.push({
        path,
        message: 'Area needs a non-empty "tables" array of table names.',
      });
      return;
    }
    const members = [];
    for (const name of a.tables) {
      const t = findTable(tables, name);
      if (!t) {
        errors.push({ path, message: `Table "${name}" does not exist.` });
        return;
      }
      members.push(t);
    }
    if (a.color !== undefined && !COLOR_RE.test(a.color)) {
      errors.push({ path, message: "Color must be #rrggbb." });
      return;
    }
    const minX = Math.min(...members.map((t) => t.x)) - AREA_PADDING;
    const minY = Math.min(...members.map((t) => t.y)) - AREA_PADDING;
    const maxX =
      Math.max(...members.map((t) => t.x + layout.tableWidth)) + AREA_PADDING;
    const maxY =
      Math.max(
        ...members.map(
          (t) => t.y + getTableHeight(t, layout.tableWidth, false),
        ),
      ) + AREA_PADDING;
    areas.push({
      id: areaIndex++,
      name: a.name.trim(),
      x: Math.round(minX),
      y: Math.round(minY),
      width: Math.round(maxX - minX),
      height: Math.round(maxY - minY),
      color: a.color ?? defaultBlue,
      locked: false,
    });
  });

  notesIn.forEach((n, i) => {
    const path = `notes[${i}]`;
    if (!isObject(n) || typeof n.content !== "string" || !n.content.trim()) {
      errors.push({ path, message: "Note needs non-empty text content." });
      return;
    }
    if (n.content.length > ANNOTATE_LIMITS.textLength) {
      errors.push({
        path,
        message: `Note content is longer than ${ANNOTATE_LIMITS.textLength} characters.`,
      });
      return;
    }
    let x;
    let y;
    if (n.near !== undefined) {
      const t = findTable(tables, n.near);
      if (!t) {
        errors.push({ path, message: `Table "${n.near}" does not exist.` });
        return;
      }
      x = t.x + layout.tableWidth + NOTE_GAP;
      y = t.y;
    } else {
      x = (layout.pan?.x ?? 0) - noteWidth / 2;
      y = stackY;
      stackY += 120;
    }
    const lines = n.content.split("\n").length;
    notes.push({
      id: noteIndex++,
      x: Math.round(x),
      y: Math.round(y),
      title:
        typeof n.title === "string" && n.title.trim()
          ? n.title.trim()
          : `note_${noteIndex - 1}`,
      content: n.content,
      locked: false,
      color: n.color && COLOR_RE.test(n.color) ? n.color : defaultNoteTheme,
      height: Math.max(88, 40 + lines * 20),
      width: noteWidth,
    });
  });

  if (errors.length) return { ok: false, errors };
  return { ok: true, notes, areas };
}
