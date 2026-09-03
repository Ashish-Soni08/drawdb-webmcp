import { useState } from "react";
import { Button, Tag, Tooltip } from "@douyinfe/semi-ui";
import { Trans, useTranslation } from "react-i18next";

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
  check_query: "bi-braces-asterisk",
  list_workspace: "bi-folder2-open",
  open_diagram: "bi-box-arrow-up-right",
  undo: "bi-arrow-counterclockwise",
};

const MUTATING_TOOLS = [
  "apply_schema_changes",
  "import_sql",
  "arrange_tables",
  "annotate_diagram",
  "plan_removal",
];

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const DETAIL_LIMIT = 4000;

function pretty(value) {
  if (value === undefined) return "";
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > DETAIL_LIMIT
    ? `${text.slice(0, DETAIL_LIMIT)}\n…`
    : text;
}

/** One tool call; click to reveal the exact input and output JSON. */
function ActivityEntry({ entry, open, onToggle }) {
  const { t } = useTranslation();
  const hasDetails = entry.input !== undefined || entry.output !== undefined;
  return (
    <div className="px-3 py-2 text-xs border-b border-zinc-300/20 last:border-b-0">
      <div
        className={`flex items-center gap-2 ${hasDetails ? "cursor-pointer" : ""}`}
        onClick={hasDetails ? onToggle : undefined}
      >
        <i
          className={`bi ${ICONS[entry.tool] ?? "bi-lightning"} ${
            entry.ok ? "" : "text-red-500"
          }`}
        />
        <span className="font-medium">{entry.tool}</span>
        <span className="ms-auto opacity-60">{formatTime(entry.at)}</span>
        {hasDetails && (
          <i
            className={`bi ${open ? "bi-chevron-up" : "bi-chevron-down"} opacity-60`}
          />
        )}
      </div>
      <div className={`mt-1 ${entry.ok ? "" : "text-red-500"}`}>
        {entry.summary}
      </div>
      {open && (
        <div className="mt-2 space-y-1">
          <div className="opacity-60">{t("webmcp_input")}</div>
          <pre className="whitespace-pre-wrap break-all max-h-32 overflow-y-auto rounded bg-zinc-500/10 p-2">
            {pretty(entry.input)}
          </pre>
          <div className="opacity-60">{t("webmcp_output")}</div>
          <pre className="whitespace-pre-wrap break-all max-h-40 overflow-y-auto rounded bg-zinc-500/10 p-2">
            {pretty(entry.output)}
          </pre>
        </div>
      )}
    </div>
  );
}

/**
 * Card shown while a `plan_removal` proposal awaits the human's decision.
 * Confirming is deliberately a UI-only action: agents have no tool for it.
 */
function ProposalCard({ proposal, onConfirm, onReject, readOnly }) {
  const { t } = useTranslation();
  const { impact } = proposal;
  return (
    <div className="px-3 py-3 text-xs border-b border-red-400/40 bg-red-500/5">
      <div className="flex items-center gap-2 font-semibold text-red-500">
        <i className="bi bi-exclamation-triangle-fill" />
        {t("webmcp_proposal_title")}
      </div>
      {proposal.reason && (
        <div className="mt-1 italic opacity-80">{proposal.reason}</div>
      )}
      <ul className="mt-2 space-y-1 list-disc ps-4">
        {impact.tables.map((table) => (
          <li key={`t-${table.name}`}>
            <Trans
              i18nKey="webmcp_proposal_table"
              count={table.fieldCount}
              values={{ name: table.name, count: table.fieldCount }}
              components={{ 1: <b /> }}
            />
          </li>
        ))}
        {impact.fields.map((field) => (
          <li key={`f-${field.table}.${field.field}`}>
            <Trans
              i18nKey="webmcp_proposal_field"
              values={{ table: field.table, field: field.field }}
              components={{ 1: <b /> }}
            />
          </li>
        ))}
        {impact.relationships.map((rel) => (
          <li key={`r-${rel.name}`}>
            <Trans
              i18nKey="webmcp_proposal_relationship"
              values={{ name: rel.name, from: rel.from, to: rel.to }}
              components={{ 1: <b /> }}
            />
          </li>
        ))}
        {impact.indexes.map((index) => (
          <li key={`i-${index.table}.${index.index}`}>
            <Trans
              i18nKey="webmcp_proposal_index"
              values={{ name: index.index, table: index.table }}
              components={{ 1: <b /> }}
            />
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
          {t("webmcp_confirm_removal")}
        </Button>
        <Button size="small" theme="light" onClick={onReject}>
          {t("webmcp_reject")}
        </Button>
      </div>
      <div className="mt-2 opacity-60">{t("webmcp_proposal_note")}</div>
    </div>
  );
}

/**
 * Floating "Agent activity" trail shown only in WebMCP-capable browsers.
 * Lists every tool call against this diagram and lets the user undo the most
 * recent agent change directly, keeping the human in control.
 */
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
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  const [openEntryId, setOpenEntryId] = useState(null);
  const changes = entries.filter(
    (e) => MUTATING_TOOLS.includes(e.tool) && e.ok,
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
            {t("webmcp_agent_activity")}
            <Tag size="small" color="light-blue">
              {entries.length}
            </Tag>
            {proposal && (
              <Tag size="small" color="red">
                {t("webmcp_needs_decision")}
              </Tag>
            )}
          </div>
          <i
            className={`bi ${expanded ? "bi-chevron-up" : "bi-chevron-down"}`}
          />
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
                {t("webmcp_empty_activity")}
              </div>
            ) : (
              <div className="max-h-64 overflow-y-auto">
                {entries.map((entry) => (
                  <ActivityEntry
                    key={entry.id}
                    entry={entry}
                    open={openEntryId === entry.id}
                    onToggle={() =>
                      setOpenEntryId((id) =>
                        id === entry.id ? null : entry.id,
                      )
                    }
                  />
                ))}
              </div>
            )}
            <div className="flex items-center gap-2 px-3 py-2 border-t border-zinc-300/40">
              <Tooltip
                content={
                  canUndoLatest
                    ? t("webmcp_undo_last_hint")
                    : t("webmcp_undo_last_disabled")
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
                  {t("webmcp_undo_last")}
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
                {t("webmcp_clear")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
