import type { TuiCopy } from "@zcode/i18n";
import React from "react";
import type { ModifiedFileStat } from "./app-modified-files.js";
import { palette } from "./app-model.js";
import { sidebarFoldRow, visibleSidebarRowCount } from "./app-sidebar-fold.js";
import { SIDEBAR_CONTENT_WIDTH } from "./app-sidebar-layout.js";
import { SidebarSectionHeader } from "./app-sidebar-section-header.js";
import { formatNumber, truncatePlain } from "./state.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

const MODIFIED_FILE_ROW_LIMIT = 6;
const MODIFIED_FILE_COUNT_WIDTH = 7;
const MODIFIED_FILE_PATH_WIDTH = SIDEBAR_CONTENT_WIDTH - MODIFIED_FILE_COUNT_WIDTH * 2;

export function ModifiedFilesSection(props: {
  copy: TuiCopy;
  expanded: boolean;
  files: ModifiedFileStat[];
  // Local patch (sidebar-fold): the files behind the "+N more" row.
  listExpanded?: boolean;
  onToggle?: () => void;
  onToggleList?: () => void;
}): React.ReactElement {
  return h(
    "box",
    {
      style: {
        flexDirection: "column",
        flexShrink: 0,
        marginTop: 1,
      },
    },
    SidebarSectionHeader({
      expanded: props.expanded,
      onToggle: props.onToggle,
      title: props.copy.sidebar.sections.modifiedFiles,
    }),
    ...(props.expanded ? modifiedFileLines(props.copy, props.files, props) : []),
  );
}

function modifiedFileLines(
  copy: TuiCopy,
  files: ModifiedFileStat[],
  list: { listExpanded?: boolean; onToggleList?: () => void },
): React.ReactNode[] {
  if (files.length === 0) {
    return [
      h("text", { key: "empty", style: { fg: palette.muted } }, copy.sidebar.modifiedFiles.empty),
    ];
  }

  const visibleFiles = files.slice(
    0,
    visibleSidebarRowCount(files.length, MODIFIED_FILE_ROW_LIMIT, list.listExpanded),
  );
  const lines = visibleFiles.map((file) => modifiedFileLine(file));
  const foldRow = sidebarFoldRow({
    count: files.length - MODIFIED_FILE_ROW_LIMIT,
    expanded: list.listExpanded,
    list: "modifiedFiles",
    moreLabel: copy.sidebar.modifiedFiles.more,
    onToggle: list.onToggleList,
  });
  if (foldRow) lines.push(foldRow);
  return lines;
}

function modifiedFileLine(file: ModifiedFileStat): React.ReactElement {
  const additions = countLabel("+", file.additions);
  const deletions = countLabel("-", file.deletions);

  return h(
    "box",
    {
      key: file.filePath,
      style: {
        flexDirection: "row",
        width: SIDEBAR_CONTENT_WIDTH,
      },
    },
    h(
      "text",
      {
        style: {
          fg: palette.muted,
          flexShrink: 0,
          width: MODIFIED_FILE_PATH_WIDTH,
        },
      },
      truncatePlain(file.filePath, MODIFIED_FILE_PATH_WIDTH),
    ),
    h(
      "text",
      {
        style: {
          fg: palette.accent,
          flexShrink: 0,
          width: MODIFIED_FILE_COUNT_WIDTH,
        },
      },
      additions,
    ),
    h(
      "text",
      {
        style: {
          fg: palette.danger,
          flexShrink: 0,
          width: MODIFIED_FILE_COUNT_WIDTH,
        },
      },
      deletions,
    ),
  );
}

function countLabel(prefix: string, value: number): string {
  return truncatePlain(`${prefix}${formatNumber(value)}`, MODIFIED_FILE_COUNT_WIDTH).padStart(
    MODIFIED_FILE_COUNT_WIDTH,
  );
}
