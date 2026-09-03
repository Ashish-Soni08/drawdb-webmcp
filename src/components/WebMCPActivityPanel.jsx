import { useState } from "react";
import { Button, Tag, Tooltip } from "@douyinfe/semi-ui";

const ICONS = {
  inspect_schema: "bi-search",
  apply_schema_changes: "bi-pencil-square",
  validate_schema: "bi-check2-circle",
  generate_sql: "bi-file-earmark-code",
  import_sql: "bi-box-arrow-in-down",
  review_schema: "bi-clipboard-check",
  generate_migration: "bi-signpost-split",
  arrange_tables: "bi-grid-3x3-gap",
  plan_removal: "bi-trash",
  removal_status: "bi-hourglass-split",
  annotate_diagram: "bi-sticky",
  generate_sample_inserts: "bi-table",
  explain_join_path: "bi-diagram-3",
  undo: "bi-arrow-counterclockwise",
};

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Floating "Agent activity" trail shown only in WebMCP-capable browsers.
 * Lists every tool call against this diagram and lets the user undo the most
 * recent agent change directly, keeping the human in control.
 */
function ProposalCard({ proposal, onConfirm, onReject, readOnly }) {
  const { impact } = proposal;
  return (
    <div className="px-3 py-3 text-xs border-b border-red-400/40 bg-red-500/5">
      <div className="flex items-center gap-2 font-semibold text-red-500">
        <i className="bi bi-exclamation-triangle-fill" />
        The agent proposes a removal
      </div>
      {proposal.reason && <div className="mt-1 italic opacity-80">{proposal.reason}</div>}
      <ul className="mt-2 space-y-1 list-disc ps-4">
        {impact.tables.map((t) => (
          <li key={`t-${t.name}`}>
            Table <b>{t.name}</b> ({t.fieldCount} column{t.fieldCount === 1 ? "" : "s"})
          </li>
        ))}
        {impact.fields.map((f) => (
          <li key={`f-${f.table}.${f.field}`}>
            Column <b>{f.table}.{f.field}</b>
          </li>
        ))}
        {impact.relationships.map((r) => (
          <li key={`r-${r.name}`}>
            Relationship <b>{r.name}</b> ({r.from} → {r.to})
          </li>
        ))}
        {impact.indexes.map((i) => (
          <li key={`i-${i.table}.${i.index}`}>
            Index <b>{i.index}</b> on {i.table}
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2 mt-3">
        <Button
          size="small"
          type="danger"
          theme="solid"
          disabled={readOnly}
          onClick={onConfirm}
          icon={<i className="bi bi-trash" />}
        >
          Confirm removal
        </Button>
        <Button size="small" theme="light" onClick={onReject}>
          Reject
        </Button>
      </div>
      <div className="mt-2 opacity-60">Only you can confirm this; the agent cannot. Confirmed removals stay undoable.</div>
    </div>
  );
}

export default function WebMCPActivityPanel({
  entries,
  canUndoLatest,
  onUndoLatest,
  onClear,
  proposal,
  onConfirmProposal,
  onRejectProposal,
  readOnly,
}) {
  const [collapsed, setCollapsed] = useState(false);
  const changes = entries.filter(
    (e) =>
      ["apply_schema_changes", "import_sql", "arrange_tables", "annotate_diagram", "plan_removal"].includes(e.tool) &&
      e.ok,
  );
  const expanded = !collapsed || Boolean(proposal);

  return (
    <div className="fixed right-4 top-24 z-30 w-80 max-w-[90vw] select-none">
      <div className="popover-theme rounded-lg shadow-lg overflow-hidden">
        <div
          className="flex items-center justify-between px-3 py-2 cursor-pointer"
          onClick={() => setCollapsed((c) => !c)}
        >
          <div className="flex items-center gap-2 font-semibold text-sm">
            <i className="bi bi-robot" />
            Agent activity
            <Tag size="small" color="light-blue">
              {entries.length}
            </Tag>
            {proposal && (
              <Tag size="small" color="red">
                needs your decision
              </Tag>
            )}
          </div>
          <i className={`bi ${expanded ? "bi-chevron-up" : "bi-chevron-down"}`} />
        </div>

        {proposal && (
          <ProposalCard
            proposal={proposal}
            onConfirm={onConfirmProposal}
            onReject={onRejectProposal}
            readOnly={readOnly}
          />
        )}

        {expanded && (
          <div className="border-t border-zinc-300/40">
            {entries.length === 0 ? (
              <div className="px-3 py-3 text-xs opacity-70">
                WebMCP tools are registered. Ask your browser agent to inspect
                or change this diagram; its actions will appear here.
              </div>
            ) : (
              <div className="max-h-64 overflow-y-auto">
                {entries.map((entry) => (
                  <div
                    key={entry.id}
                    className="px-3 py-2 text-xs border-b border-zinc-300/20 last:border-b-0"
                  >
                    <div className="flex items-center gap-2">
                      <i
                        className={`bi ${ICONS[entry.tool] ?? "bi-lightning"} ${
                          entry.ok ? "" : "text-red-500"
                        }`}
                      />
                      <span className="font-medium">{entry.tool}</span>
                      <span className="ms-auto opacity-60">
                        {formatTime(entry.at)}
                      </span>
                    </div>
                    <div className={`mt-1 ${entry.ok ? "" : "text-red-500"}`}>
                      {entry.summary}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2 px-3 py-2 border-t border-zinc-300/40">
              <Tooltip
                content={
                  canUndoLatest
                    ? "Reverts the agent's most recent change"
                    : "Only available while the agent's change is the latest edit (use Ctrl+Z otherwise)"
                }
              >
                <Button
                  size="small"
                  type="danger"
                  theme="light"
                  disabled={!canUndoLatest || changes.length === 0}
                  onClick={onUndoLatest}
                  icon={<i className="bi bi-arrow-counterclockwise" />}
                >
                  Undo last agent change
                </Button>
              </Tooltip>
              <Button
                size="small"
                theme="borderless"
                type="tertiary"
                className="ms-auto"
                disabled={entries.length === 0}
                onClick={onClear}
              >
                Clear
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
