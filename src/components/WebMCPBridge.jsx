import { useCallback, useEffect, useRef, useState } from "react";
import { Toast } from "@douyinfe/semi-ui";
import { Action, ObjectType } from "../data/constants";
import {
  useAreas,
  useDiagram,
  useEnums,
  useLayout,
  useNotes,
  useSelect,
  useSettings,
  useTransform,
  useTypes,
  useUndoRedo,
} from "../hooks";
import { autoArrange } from "../utils/autoArrange";
import { applyDiagramPlan } from "../utils/dbml/applyPlan";
import { diffDiagram } from "../utils/dbml/diff";
import { getTableHeight } from "../utils/utils";
import { snapshotSchema } from "../webmcp/migration";
import { getModelContext, registerTools } from "../webmcp/modelContext";
import { summarizeChanges } from "../webmcp/planSchemaChanges";
import { summarizeRemoval } from "../webmcp/planRemoval";
import { createSchemaPairTools } from "../webmcp/tools";
import WebMCPActivityPanel from "./WebMCPActivityPanel";

// Only one bridge may own the tool registration at a time. If a second
// instance mounts (route remount, hot reload), it takes over the previous one
// instead of registering duplicate tools.
let activeRegistration = null;

const AGENT_UNDO_TAG = "schemapair-agent";
const MAX_ACTIVITY_ENTRIES = 30;

// Outcomes of past removal proposals so removal_status can report them.
const decidedProposals = new Map();

/**
 * Registers SchemaPair's WebMCP tools against the live editor state and shows
 * the agent-activity trail.
 *
 * Must be mounted inside the editor provider tree (see `pages/Editor.jsx`) so
 * it can read and mutate the same contexts the canvas uses. In browsers
 * without WebMCP it renders nothing and registers nothing.
 */
export default function WebMCPBridge() {
  const diagram = useDiagram();
  const { enums, setEnums } = useEnums();
  const { types } = useTypes();
  const { layout } = useLayout();
  const { settings } = useSettings();
  const { transform, setTransform } = useTransform();
  const { setSelectedElement } = useSelect();
  const { notes, setNotes } = useNotes();
  const { areas, setAreas } = useAreas();
  const { undoStack, setUndoStack, setRedoStack } = useUndoRedo();
  const [supported, setSupported] = useState(false);
  const [activity, setActivity] = useState([]);
  // The one removal proposal awaiting a human decision (agents cannot decide).
  const [proposal, setProposal] = useState(null);
  const proposalRef = useRef(null);
  proposalRef.current = proposal;

  // Registered handlers are created once; they read this ref on every call so
  // they always see the latest state and setters instead of a stale closure.
  const stateRef = useRef(null);
  stateRef.current = {
    diagram,
    enums,
    setEnums,
    types,
    readOnly: layout.readOnly,
    settings,
    notes,
    setNotes,
    areas,
    setAreas,
    tableWidth: settings.tableWidth,
    showComments: settings.showComments,
    pan: transform.pan,
    setTransform,
    setSelectedElement,
    setUndoStack,
    setRedoStack,
  };

  // Baseline for generate_migration: the schema as loaded. Loading a diagram
  // resets the undo history, and every edit (human or agent) pushes onto it,
  // so "the latest state seen with an empty undo stack" is the loaded state.
  // The tool can move the baseline forward with resetBaseline.
  const baselineRef = useRef(snapshotSchema({}));
  const historyLength = undoStack.length;
  useEffect(() => {
    if (historyLength === 0) {
      baselineRef.current = snapshotSchema({
        tables: diagram.tables,
        relationships: diagram.relationships,
        types,
        enums,
      });
    }
  }, [historyLength, diagram.tables, diagram.relationships, types, enums]);

  const record = useCallback((entry) => {
    setActivity((prev) =>
      [
        { id: `${Date.now()}-${prev.length}`, at: Date.now(), ...entry },
        ...prev,
      ].slice(0, MAX_ACTIVITY_ENTRIES),
    );
  }, []);

  useEffect(() => {
    const modelContext = getModelContext();
    if (!modelContext || typeof modelContext.registerTool !== "function") {
      return undefined;
    }
    setSupported(true);

    if (activeRegistration) activeRegistration.abort();
    const controller = new AbortController();
    activeRegistration = controller;

    const bridge = {
      getState() {
        const s = stateRef.current;
        return {
          database: s.diagram.database,
          tables: s.diagram.tables,
          relationships: s.diagram.relationships,
          enums: s.enums,
          types: s.types,
          readOnly: s.readOnly,
          notes: s.notes,
          areas: s.areas,
          tableWidth: s.tableWidth,
          pan: s.pan,
        };
      },
      proposeRemoval(plan, reason) {
        // A new proposal supersedes any pending one; the agent is told so.
        const previous = proposalRef.current;
        const next = {
          id: `rm_${Date.now().toString(36)}`,
          status: "pending",
          reason,
          targets: plan.targets,
          impact: plan.impact,
          next: plan.next,
          createdAt: Date.now(),
        };
        setProposal(next);
        proposalRef.current = next;
        if (previous && previous.status === "pending") {
          decidedProposals.set(previous.id, {
            ...previous,
            status: "superseded",
          });
        }
        return next;
      },
      getProposal(id) {
        const current = proposalRef.current;
        if (current && current.id === id) return current;
        return decidedProposals.get(id) ?? null;
      },
      addAnnotations(plan) {
        const s = stateRef.current;
        // drawDB's own undo entries for notes/areas: each ADD pops the last one.
        if (plan.areas.length) {
          s.setAreas((prev) => [
            ...prev,
            ...plan.areas.map((a, i) => ({ ...a, id: prev.length + i })),
          ]);
          s.setUndoStack((prev) => [
            ...prev,
            ...plan.areas.map((a) => ({
              action: Action.ADD,
              element: ObjectType.AREA,
              message: `SchemaPair agent: added area "${a.name}"`,
              source: AGENT_UNDO_TAG,
            })),
          ]);
        }
        if (plan.notes.length) {
          s.setNotes((prev) => [
            ...prev,
            ...plan.notes.map((n, i) => ({ ...n, id: prev.length + i })),
          ]);
          s.setUndoStack((prev) => [
            ...prev,
            ...plan.notes.map((n) => ({
              action: Action.ADD,
              element: ObjectType.NOTE,
              message: `SchemaPair agent: added note "${n.title}"`,
              source: AGENT_UNDO_TAG,
            })),
          ]);
        }
        s.setRedoStack([]);
        Toast.info({
          content: `SchemaPair agent: added ${plan.notes.length} note(s), ${plan.areas.length} area(s)`,
          duration: 4,
        });
      },
      applyChanges(next, summary) {
        const s = stateRef.current;
        const before = {
          tables: s.diagram.tables,
          relationships: s.diagram.relationships,
          enums: s.enums,
        };
        const message = `SchemaPair agent: ${summarizeChanges(summary)}`;

        // One snapshot entry makes the whole tool call a single undo step. It
        // reuses the mechanism the DBML editor already uses: undo/redo diffs
        // the snapshot against the live state and applies the difference.
        s.setUndoStack((prev) => [
          ...prev,
          {
            action: Action.EDIT,
            element: ObjectType.DBML,
            data: { snapshot: before },
            message,
            source: AGENT_UNDO_TAG,
          },
        ]);
        s.setRedoStack([]);
        // The planner already produced the complete next state (existing ids
        // and order preserved), so it is committed in one update per slice.
        s.diagram.setTables(next.tables);
        s.diagram.setRelationships(next.relationships);
        if (next.enums) s.setEnums(next.enums);
        Toast.info({ content: message, duration: 4 });
        revealChanges(next.tables, summary, s);
      },
      getBaseline() {
        return baselineRef.current ?? snapshotSchema({});
      },
      setBaseline(snapshot) {
        baselineRef.current = snapshot;
      },
      arrangeTables() {
        const s = stateRef.current;
        const { tables, relationships } = s.diagram;
        const positions = autoArrange(tables, relationships, s.settings);
        const byId = new Map(positions.map((p) => [p.id, p]));
        const elements = [];
        for (const table of tables) {
          const pos = byId.get(table.id);
          if (!pos || (pos.x === table.x && pos.y === table.y)) continue;
          elements.push({
            id: table.id,
            type: ObjectType.TABLE,
            undo: { x: table.x, y: table.y },
            redo: { x: pos.x, y: pos.y },
          });
        }
        if (elements.length === 0) return 0;
        // Same bulk-move entry the editor's own Auto-arrange action pushes.
        for (const element of elements)
          s.diagram.updateTable(element.id, element.redo);
        s.setUndoStack((prev) => [
          ...prev,
          {
            action: Action.MOVE,
            bulk: true,
            elements,
            message: "SchemaPair agent: auto-arranged tables",
            source: AGENT_UNDO_TAG,
          },
        ]);
        s.setRedoStack([]);
        const arranged = tables.map((t) => ({
          ...t,
          ...(byId.get(t.id) ?? {}),
        }));
        revealChanges(
          arranged,
          {
            tables: arranged.map((t) => t.name),
            fields: [],
            indexes: [],
            updatedTables: [],
            updatedFields: [],
          },
          s,
          false,
        );
        Toast.info({
          content: `SchemaPair agent: arranged ${elements.length} table(s)`,
          duration: 4,
        });
        return elements.length;
      },
      record,
    };

    registerTools(modelContext, createSchemaPairTools(bridge), {
      signal: controller.signal,
    })
      .then((names) => {
        if (!controller.signal.aborted) {
          console.info(
            `[SchemaPair] WebMCP tools registered: ${names.join(", ")}`,
          );
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          console.warn("[SchemaPair] WebMCP tool registration failed:", error);
        }
      });

    return () => {
      controller.abort();
      if (activeRegistration === controller) activeRegistration = null;
    };
  }, [record]);

  const latest = undoStack[undoStack.length - 1];
  const canUndoLatest = Boolean(
    latest && latest.source === AGENT_UNDO_TAG && !layout.readOnly,
  );

  const undoLatest = () => {
    const s = stateRef.current;
    const entry = s.diagram && undoStack[undoStack.length - 1];
    if (!entry || entry.source !== AGENT_UNDO_TAG) return;
    if (entry.action === Action.ADD && entry.element === ObjectType.NOTE) {
      s.setNotes((prev) => prev.slice(0, -1));
      s.setUndoStack((prev) => prev.slice(0, -1));
      s.setRedoStack((prev) => [...prev, entry]);
      record({ tool: "undo", ok: true, summary: `Reverted: ${entry.message}` });
      return;
    }
    if (entry.action === Action.ADD && entry.element === ObjectType.AREA) {
      s.setAreas((prev) => prev.slice(0, -1));
      s.setUndoStack((prev) => prev.slice(0, -1));
      s.setRedoStack((prev) => [...prev, entry]);
      record({ tool: "undo", ok: true, summary: `Reverted: ${entry.message}` });
      return;
    }
    if (entry.bulk) {
      // arrange_tables: restore the previous positions.
      for (const element of entry.elements)
        s.diagram.updateTable(element.id, element.undo);
      s.setUndoStack((prev) => prev.slice(0, -1));
      s.setRedoStack((prev) => [...prev, entry]);
      record({ tool: "undo", ok: true, summary: `Reverted: ${entry.message}` });
      return;
    }
    const current = {
      tables: s.diagram.tables,
      relationships: s.diagram.relationships,
      enums: s.enums,
    };
    // Same swap the editor performs for Ctrl+Z on a snapshot entry.
    applyDiagramPlan(diffDiagram(current, entry.data.snapshot), {
      addTable: s.diagram.addTable,
      updateTable: s.diagram.updateTable,
      updateField: s.diagram.updateField,
      deleteTable: s.diagram.deleteTable,
      addRelationship: s.diagram.addRelationship,
      updateRelationship: s.diagram.updateRelationship,
      deleteRelationship: s.diagram.deleteRelationship,
      setEnums: s.setEnums,
    });
    s.setUndoStack((prev) => prev.slice(0, -1));
    s.setRedoStack((prev) => [
      ...prev,
      { ...entry, data: { snapshot: current } },
    ]);
    record({ tool: "undo", ok: true, summary: `Reverted: ${entry.message}` });
  };

  const decideProposal = (accepted) => {
    const current = proposalRef.current;
    if (!current || current.status !== "pending") return;
    const s = stateRef.current;
    if (accepted && !s.readOnly) {
      const before = {
        tables: s.diagram.tables,
        relationships: s.diagram.relationships,
        enums: s.enums,
      };
      const message = `SchemaPair agent (confirmed by you): ${summarizeRemoval(current.impact)}`;
      s.setUndoStack((prev) => [
        ...prev,
        {
          action: Action.EDIT,
          element: ObjectType.DBML,
          data: { snapshot: before },
          message,
          source: AGENT_UNDO_TAG,
        },
      ]);
      s.setRedoStack([]);
      s.diagram.setTables(current.next.tables);
      s.diagram.setRelationships(current.next.relationships);
      Toast.info({ content: message, duration: 4 });
    }
    const status = accepted ? "confirmed" : "rejected";
    decidedProposals.set(current.id, { ...current, status, next: undefined });
    setProposal(null);
    proposalRef.current = null;
    record({
      tool: "plan_removal",
      ok: true,
      summary: `${status}: ${summarizeRemoval(current.impact)}`,
    });
  };

  if (!supported) return null;

  return (
    <WebMCPActivityPanel
      entries={activity}
      canUndoLatest={canUndoLatest}
      onUndoLatest={undoLatest}
      onClear={() => setActivity([])}
      proposal={proposal}
      onConfirmProposal={() => decideProposal(true)}
      onRejectProposal={() => decideProposal(false)}
      readOnly={layout.readOnly}
    />
  );
}

/**
 * Pans the canvas to the tables the agent just touched and selects the first
 * new table, so a change is never applied somewhere the user cannot see.
 */
function revealChanges(tables, summary, s, select = true) {
  const touched = new Set([
    ...summary.tables,
    ...summary.fields.map((f) => f.table),
    ...summary.indexes.map((i) => i.table),
    ...summary.updatedTables,
    ...summary.updatedFields.map((f) => f.table),
  ]);
  const targets = tables.filter((t) => touched.has(t.name));
  if (targets.length === 0) return;

  const width = s.tableWidth;
  const minX = Math.min(...targets.map((t) => t.x));
  const maxX = Math.max(...targets.map((t) => t.x + width));
  const minY = Math.min(...targets.map((t) => t.y));
  const maxY = Math.max(
    ...targets.map((t) => t.y + getTableHeight(t, width, s.showComments)),
  );
  // The pan point is the diagram coordinate shown at the viewport centre.
  s.setTransform((prev) => ({
    ...prev,
    pan: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
  }));

  if (!select) return;
  const first =
    tables.find((t) => summary.tables.includes(t.name)) ?? targets[0];
  s.setSelectedElement((prev) => ({
    ...prev,
    element: ObjectType.TABLE,
    id: first.id,
    open: false,
  }));
}
