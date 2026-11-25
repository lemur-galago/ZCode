import { TextAttributes } from "@mbears/opentui-core";
import type { TuiCopy } from "@zcode/i18n";
import React from "react";
import type { CacheStats, ContextUsage, SidebarState } from "./app-model.js";
import { DEFAULT_TUI_COPY } from "./app-locale.js";
import { palette } from "./app-model.js";
import { modelDisplayParts } from "./app-model-ref.js";
import { displayWidth, truncateDisplay } from "./app-terminal-width.js";
import { formatNumber } from "./state.js";
import { ApiSection } from "./app-sidebar-api.js";
import { sidebarFoldRow, visibleSidebarRowCount } from "./app-sidebar-fold.js";
import { McpSection } from "./app-sidebar-mcp.js";
import { ModifiedFilesSection } from "./app-sidebar-modified-files.js";
import { SidebarSectionHeader } from "./app-sidebar-section-header.js";
import { SubagentsSection } from "./app-sidebar-subagents.js";
import type { SubagentItem, SubagentsController } from "./app-subagents.js";
import {
  SIDEBAR_CONTENT_WIDTH,
  SIDEBAR_HORIZONTAL_PADDING_COLUMNS,
  SIDEBAR_SCROLLBOX_ID,
  SIDEBAR_WIDTH,
  type SidebarListExpansion,
  type SidebarListId,
  type SidebarSectionId,
  type SidebarSectionExpansion,
} from "./app-sidebar-layout.js";

export { SIDEBAR_CONTENT_WIDTH } from "./app-sidebar-layout.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

const SIDEBAR_LABEL_WIDTH = 9;
const SIDEBAR_ROW_VALUE_WIDTH = SIDEBAR_CONTENT_WIDTH - SIDEBAR_LABEL_WIDTH - 1;
const SIDEBAR_TODO_CONTENT_WIDTH = SIDEBAR_CONTENT_WIDTH - 4;
const SIDEBAR_TODO_ROW_LIMIT = 6;
const SIDEBAR_TEXT_ROW_STYLE = { flexShrink: 0, height: 1, truncate: true, wrapMode: "none" };
const PRODUCT_NAME = "ZCode";
const PRODUCT_NAME_WIDTH = displayWidth(PRODUCT_NAME);
const DEFAULT_PRODUCT_VERSION = "0.0.0";
const DEFAULT_MCP_STATUS = { loading: false, servers: {} };

export type SidebarProps = SidebarState & {
  subagents?: SubagentsController;
  onOpenSubagent?: (item: SubagentItem) => void;
  copy?: TuiCopy;
  developerMode?: boolean;
  onToggleSection?: (section: SidebarSectionId) => void;
  sectionExpansion?: SidebarSectionExpansion;
  version?: string;
  // Local patch (adddir-command): click handler + count for the workspace row
  // add-directory trigger ("➕" pinned to the row's right edge).
  onAddDirClick?: () => void;
  additionalDirectoryCount?: number;
  // Local patch (sidebar-fold): which folded lists ("+N more") are unfolded,
  // and the handler a click on such a row wakes.
  listExpansion?: Partial<SidebarListExpansion>;
  onToggleList?: (list: SidebarListId) => void;
};

export function Sidebar(props: SidebarProps): React.ReactElement {
  const copy = props.copy ?? DEFAULT_TUI_COPY;
  const developerMode = props.developerMode === true;
  return h(
    "box",
    {
      style: {
        backgroundColor: palette.panelAlt,
        border: false,
        flexDirection: "column",
        flexShrink: 0,
        height: "100%",
        // Local patch (sidebar-scroll): the sections scroll and the workspace
        // footer stays pinned. The scrollbar takes the right padding column,
        // so the rows keep their width while it is shown.
        paddingBottom: SIDEBAR_HORIZONTAL_PADDING_COLUMNS,
        paddingLeft: SIDEBAR_HORIZONTAL_PADDING_COLUMNS,
        paddingRight: 0,
        paddingTop: SIDEBAR_HORIZONTAL_PADDING_COLUMNS,
        width: SIDEBAR_WIDTH,
      },
    },
    h(
      "scrollbox",
      {
        id: SIDEBAR_SCROLLBOX_ID,
        focused: false,
        scrollX: false,
        // No explicit width or height here: OpenTUI makes a sized box rigid
        // (flexShrink 0), and the box must shrink to the space the footer
        // leaves. It stretches to the inner width of the sidebar instead.
        style: {
          flexGrow: 1,
          minHeight: 0,
          scrollbarOptions: {
            trackOptions: { backgroundColor: palette.panelAlt, foregroundColor: palette.muted },
          },
        },
      },
      h(
        "box",
        { style: { flexDirection: "column", width: SIDEBAR_CONTENT_WIDTH } },
        productVersionHeader(props.version),
        ...(developerMode
          ? [
              h(
                "text",
                { key: "developer-subtitle", style: { ...SIDEBAR_TEXT_ROW_STYLE, fg: palette.muted } },
                copy.sidebar.shellSubtitle,
              ),
            ]
          : []),
        sidebarSection(copy.sidebar.sections.status, statusLines(props)),
        props.subagents
          ? h(SubagentsSection, {
              controller: props.subagents,
              copy,
              expanded: props.sectionExpansion?.subagents ?? true,
              onToggle: () => props.onToggleSection?.("subagents"),
              onOpen: props.onOpenSubagent ?? props.subagents.open,
            })
          : null,
        ...(developerMode ? [sidebarSection(copy.sidebar.sections.run, runLines(props))] : []),
        McpSection({
          copy,
          expanded: props.sectionExpansion?.mcp ?? true,
          mcpStatus: props.mcpStatus ?? DEFAULT_MCP_STATUS,
          onToggle: () => props.onToggleSection?.("mcp"),
          listExpanded: props.listExpansion?.mcp,
          onToggleList: props.onToggleList && (() => props.onToggleList?.("mcp")),
        }),
        ModifiedFilesSection({
          copy,
          expanded: props.sectionExpansion?.modifiedFiles ?? true,
          files: props.modifiedFiles,
          onToggle: () => props.onToggleSection?.("modifiedFiles"),
          listExpanded: props.listExpansion?.modifiedFiles,
          onToggleList: props.onToggleList && (() => props.onToggleList?.("modifiedFiles")),
        }),
        ...(developerMode ? [sidebarSection(copy.sidebar.sections.context, contextLines(props))] : []),
        sidebarSection(copy.sidebar.sections.todos, todoLines(props), {
          expanded: props.sectionExpansion?.todos ?? true,
          onToggle: () => props.onToggleSection?.("todos"),
        }),
        ...(developerMode
          ? [
              ApiSection({
                copy,
                expanded: props.sectionExpansion?.apis ?? true,
                networkRequests: props.networkRequests,
                onToggle: () => props.onToggleSection?.("apis"),
                usage: props.usage,
                listExpanded: props.listExpansion?.apis,
                onToggleList: props.onToggleList && (() => props.onToggleList?.("apis")),
              }),
            ]
          : []),
      ),
    ),
    // Local patch (adddir-command): the always-visible workspace footer gets a
    // clickable "➕" pinned to its right edge (opens the folder picker, same as the
    // composer-status badge) and shows the additional-directory count.
    props.onAddDirClick
      ? workspaceFooterWithAddDir(props)
      : h(
          "text",
          { key: "workspace-footer", style: { ...SIDEBAR_TEXT_ROW_STYLE, fg: palette.muted } },
          workspaceFooterLabel(props),
        ),
  );
}

function workspaceFooterWithAddDir(props: SidebarProps): React.ReactElement {
  const count = props.additionalDirectoryCount ?? 0;
  const countText = count > 0 ? `(+${count}) ` : "";
  const labelBudget = Math.max(
    1,
    SIDEBAR_CONTENT_WIDTH - SIDEBAR_ADD_DIR_GLYPH_WIDTH - displayWidth(countText),
  );
  return h(
    "box",
    {
      key: "workspace-footer",
      style: { flexDirection: "row", flexShrink: 0, height: 1, width: SIDEBAR_CONTENT_WIDTH },
    },
    h(
      "text",
      {
        key: "workspace-footer-label",
        style: { ...SIDEBAR_TEXT_ROW_STYLE, fg: palette.muted },
      },
      truncateDisplay(workspaceFooterValue(props), labelBudget),
    ),
    h("box", { key: "workspace-footer-spacer", style: { flexGrow: 1, minHeight: 0 } }),
    countText
      ? h(
          "text",
          {
            key: "workspace-footer-count",
            style: { ...SIDEBAR_TEXT_ROW_STYLE, fg: palette.accent },
          },
          countText,
        )
      : null,
    h(
      "text",
      {
        key: "workspace-footer-add",
        onMouseDown: (event: { preventDefault: () => void; stopPropagation: () => void }) => {
          event.preventDefault();
          event.stopPropagation();
          props.onAddDirClick?.();
        },
        style: {
          ...SIDEBAR_TEXT_ROW_STYLE,
          fg: palette.accent,
          width: SIDEBAR_ADD_DIR_GLYPH_WIDTH,
        },
      },
      SIDEBAR_ADD_DIR_GLYPH,
    ),
  );
}

function workspaceFooterValue(props: SidebarProps): string {
  const workspace = props.workspaceDirectory ?? "-";
  const branch = props.workspaceGitBranch;
  return branch ? `${workspace}:${branch}` : workspace;
}

function productVersionHeader(version: string | undefined): React.ReactElement {
  return h(
    "box",
    {
      key: "product-version",
      style: {
        flexDirection: "row",
        flexShrink: 0,
        height: 1,
        width: SIDEBAR_CONTENT_WIDTH,
      },
    },
    h(
      "text",
      {
        key: "product-name",
        style: {
          ...SIDEBAR_TEXT_ROW_STYLE,
          attributes: TextAttributes.BOLD,
          fg: palette.accent,
          width: PRODUCT_NAME_WIDTH,
        },
      },
      PRODUCT_NAME,
    ),
    h(
      "text",
      {
        key: "product-version",
        style: {
          ...SIDEBAR_TEXT_ROW_STYLE,
          fg: palette.muted,
          width: SIDEBAR_CONTENT_WIDTH - PRODUCT_NAME_WIDTH,
        },
      },
      ` ${version ?? DEFAULT_PRODUCT_VERSION}`,
    ),
  );
}

function sidebarSection(
  title: string,
  children: React.ReactNode[],
  collapse?: { expanded: boolean; onToggle: () => void },
): React.ReactElement {
  return h(
    "box",
    {
      key: title,
      style: {
        flexDirection: "column",
        flexShrink: 0,
        marginTop: 1,
      },
    },
    collapse
      ? SidebarSectionHeader({ ...collapse, title })
      : h(
          "text",
          {
            style: {
              ...SIDEBAR_TEXT_ROW_STYLE,
              attributes: TextAttributes.BOLD,
              fg: palette.accent,
            },
          },
          title,
        ),
    ...((collapse?.expanded ?? true) ? children : []),
  );
}

function statusLines(props: SidebarProps): React.ReactNode[] {
  const copy = props.copy ?? DEFAULT_TUI_COPY;
  const lines = [
    textLine(
      truncateDisplay(props.status, SIDEBAR_CONTENT_WIDTH),
      props.busy ? palette.accent : palette.text,
      "status",
    ),
    rowLine(copy.sidebar.status.last, props.lastEvent, "last"),
  ];

  for (const detail of props.statusDetails.slice(0, 2)) {
    lines.push(
      textLine(truncateDisplay(detail, SIDEBAR_CONTENT_WIDTH), palette.warning, `detail-${detail}`),
    );
  }
  if (props.lastError) {
    lines.push(
      textLine(truncateDisplay(props.lastError, SIDEBAR_CONTENT_WIDTH), palette.danger, "error"),
    );
  }
  return lines;
}

function runLines(props: SidebarProps): React.ReactNode[] {
  const copy = props.copy ?? DEFAULT_TUI_COPY;
  const modelParts = modelDisplayParts(props.model);
  return [
    rowLine(copy.sidebar.run.mode, props.mode, "mode"),
    rowLine(copy.sidebar.run.provider, modelParts.provider, "provider"),
    rowLine(copy.sidebar.run.model, modelParts.model, "model"),
    rowLine(copy.sidebar.run.thought, props.thoughtLevel, "thought"),
    // Local patch (adddir-command): the workspace row grows a clickable "➕"
    // pinned to its right edge (opens the folder picker, same as the
    // composer-status badge) and shows the additional-directory count. Emoji
    // glyph: 2 terminal cells (displayWidth undercounts astral emoji).
    props.onAddDirClick
      ? workspaceRowWithAddDir(props)
      : rowLine(copy.sidebar.run.workspace, props.workspaceDirectory ?? "-", "workspace"),
    rowLine(copy.sidebar.run.turn, props.activeTurnId ?? "-", "turn"),
    rowLine(copy.sidebar.run.trace, props.traceId ?? "-", "trace"),
    rowLine(copy.sidebar.run.messages, String(props.messageCount), "messages"),
    rowLine(
      copy.sidebar.run.draft,
      props.draft ? copy.sidebar.run.draftChars(props.draft.length) : copy.sidebar.run.draftEmpty,
      "draft",
    ),
  ];
}

const SIDEBAR_ADD_DIR_GLYPH = "➕";
const SIDEBAR_ADD_DIR_GLYPH_WIDTH = 2;

function workspaceRowWithAddDir(props: SidebarProps): React.ReactElement {
  const copy = props.copy ?? DEFAULT_TUI_COPY;
  const count = props.additionalDirectoryCount ?? 0;
  const countText = count > 0 ? `(+${count}) ` : "";
  const valueBudget = Math.max(
    1,
    SIDEBAR_ROW_VALUE_WIDTH - SIDEBAR_ADD_DIR_GLYPH_WIDTH - displayWidth(countText),
  );
  return h(
    "box",
    { key: "workspace", style: { flexDirection: "row", flexShrink: 0, height: 1 } },
    h(
      "text",
      {
        key: "workspace-value",
        style: { ...SIDEBAR_TEXT_ROW_STYLE, fg: palette.text },
      },
      `${padEndDisplay(copy.sidebar.run.workspace, SIDEBAR_LABEL_WIDTH)} ${truncateDisplay(
        props.workspaceDirectory ?? "-",
        valueBudget,
      )}`,
    ),
    h("box", { key: "workspace-spacer", style: { flexGrow: 1, minHeight: 0 } }),
    countText
      ? h(
          "text",
          {
            key: "workspace-count",
            style: { ...SIDEBAR_TEXT_ROW_STYLE, fg: palette.accent },
          },
          countText,
        )
      : null,
    h(
      "text",
      {
        key: "workspace-add",
        onMouseDown: (event: { preventDefault: () => void; stopPropagation: () => void }) => {
          event.preventDefault();
          event.stopPropagation();
          props.onAddDirClick?.();
        },
        style: {
          ...SIDEBAR_TEXT_ROW_STYLE,
          fg: palette.accent,
          width: SIDEBAR_ADD_DIR_GLYPH_WIDTH,
        },
      },
      SIDEBAR_ADD_DIR_GLYPH,
    ),
  );
}

function contextLines(props: SidebarProps): React.ReactNode[] {
  const copy = props.copy ?? DEFAULT_TUI_COPY;
  const usage = props.usage;
  return [
    rowLine(
      copy.sidebar.context.window,
      formatOptionalNumber(props.contextUsage.contextWindow),
      "window",
    ),
    rowLine(copy.sidebar.context.used, contextUsedLabel(props.contextUsage), "used"),
    rowLine(
      copy.sidebar.context.tokens,
      usage ? `${formatNumber(usage.totalTokens)} ${copy.sidebar.cache.total}` : "-",
      "tokens",
    ),
    rowLine(
      copy.sidebar.context.inputOutput,
      usage
        ? `${formatNumber(usage.inputTokens)} in / ${formatNumber(usage.outputTokens)} out`
        : "-",
      "io",
    ),
    rowLine(
      copy.sidebar.context.reason,
      usage ? formatNumber(usage.reasoningTokens) : "-",
      "reasoning",
    ),
    rowLine(copy.sidebar.context.cache, cacheHitLabel(usage, props.cacheStats, copy), "cache"),
    rowLine(
      copy.sidebar.context.cacheReadWrite,
      cacheReadWriteLabel(usage, props.cacheStats, copy),
      "cache-rw",
    ),
  ];
}

function todoLines(props: SidebarProps): React.ReactNode[] {
  const copy = props.copy ?? DEFAULT_TUI_COPY;
  const completed = props.todos.filter((todo) => todo.status === "completed").length;
  const lines = [
    rowLine(copy.sidebar.todos.progress, `${completed}/${props.todos.length}`, "todo-progress"),
  ];

  if (props.todos.length === 0) {
    lines.push(textLine(copy.sidebar.todos.empty, palette.muted, "todo-empty"));
    return lines;
  }

  for (const [index, todo] of props.todos
    .slice(0, visibleSidebarRowCount(props.todos.length, SIDEBAR_TODO_ROW_LIMIT, props.listExpansion?.todos))
    .entries()) {
    lines.push(
      textLine(
        `${todoMarker(todo.status)} ${truncateDisplay(todo.content, SIDEBAR_TODO_CONTENT_WIDTH)}`,
        todoColor(todo.status),
        `todo-${index}-${todo.content}`,
      ),
    );
  }
  const foldRow = sidebarFoldRow({
    count: props.todos.length - SIDEBAR_TODO_ROW_LIMIT,
    expanded: props.listExpansion?.todos,
    list: "todos",
    moreLabel: copy.sidebar.todos.more,
    onToggle: props.onToggleList && (() => props.onToggleList?.("todos")),
  });
  if (foldRow) lines.push(foldRow);
  return lines;
}

function rowLine(label: string, value: string, key: string): React.ReactElement {
  return textLine(
    `${padEndDisplay(label, SIDEBAR_LABEL_WIDTH)} ${truncateDisplay(value, SIDEBAR_ROW_VALUE_WIDTH)}`,
    palette.text,
    key,
  );
}

function textLine(value: string, color: string, key: string): React.ReactElement {
  // Yoga can shrink sidebar text rows to 0 height under pressure while the
  // native text buffer still draws glyph tails into the next row.
  return h("text", { key, style: { ...SIDEBAR_TEXT_ROW_STYLE, fg: color } }, value);
}

function padEndDisplay(value: string, targetCells: number): string {
  const visible = truncateDisplay(value, targetCells);
  return `${visible}${" ".repeat(Math.max(0, targetCells - displayWidth(visible)))}`;
}

function contextUsedLabel(contextUsage: ContextUsage): string {
  const used = contextUsage.contextUsed;
  const window = contextUsage.contextWindow;
  if (used === undefined && window === undefined) return "-";
  if (used !== undefined && window !== undefined && window > 0) {
    return `${formatNumber(used)} (${formatPercent(used / window)})`;
  }
  if (used !== undefined) return formatNumber(used);
  return "-";
}

function cacheHitLabel(
  usage: SidebarState["usage"],
  cacheStats: CacheStats | undefined,
  copy: TuiCopy,
): string {
  if (usage && usage.inputTokens > 0) {
    return `${formatPercent(usage.cacheReadTokens / usage.inputTokens)} ${copy.sidebar.cache.hit}`;
  }
  if (cacheStats?.lastCacheHit !== undefined) {
    return cacheStats.lastCacheHit ? copy.sidebar.cache.lastHit : copy.sidebar.cache.lastMiss;
  }
  return "-";
}

function cacheReadWriteLabel(
  usage: SidebarState["usage"],
  cacheStats: CacheStats | undefined,
  copy: TuiCopy,
): string {
  const read = usage?.cacheReadTokens ?? cacheStats?.cacheReadTokens;
  const write = usage?.cacheWriteTokens;
  if (read === undefined && write === undefined) return "-";
  return copy.sidebar.cache.readWrite({
    read: formatOptionalNumber(read),
    write: formatOptionalNumber(write),
  });
}

function workspaceFooterLabel(props: SidebarProps): string {
  return truncateDisplay(workspaceFooterValue(props), SIDEBAR_CONTENT_WIDTH);
}

function formatOptionalNumber(value: number | undefined): string {
  return value === undefined ? "-" : formatNumber(value);
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return `${Math.round(value * 100)}%`;
}

function todoMarker(status: "completed" | "in_progress" | "pending"): string {
  if (status === "completed") return "[x]";
  if (status === "in_progress") return "[>]";
  return "[ ]";
}

function todoColor(status: "completed" | "in_progress" | "pending"): string {
  if (status === "completed") return palette.muted;
  if (status === "in_progress") return palette.accent;
  return palette.text;
}
