import { CliRenderEvents, type CliRenderer, type ScrollBoxRenderable } from "@mbears/opentui-core";
import { useRenderer } from "@mbears/opentui-react";
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { palette } from "./app-model.js";
import {
  SIDEBAR_SCROLLBOX_ID,
  toggleSidebarListExpansion,
  type SidebarListExpansion,
  type SidebarListId,
} from "./app-sidebar-layout.js";

// Local patch (sidebar-fold): the lists of the sidebar show their first rows
// and fold the rest behind a "+N more" row that was plain text. The row is a
// toggle now: a click reveals the rows, the next click folds them back.

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

const SIDEBAR_TEXT_ROW_STYLE = { flexShrink: 0, height: 1, truncate: true, wrapMode: "none" };
const FOLDED_LISTS: SidebarListExpansion = { apis: false, mcp: false, modifiedFiles: false, todos: false };

// The copy tables name the folded rows for every list but have no way back.
// This fork runs the English copy, so the fold-back row is English here.
function foldBackLabel(count: number): string {
  return `-${count} less`;
}

export function sidebarFoldRowId(list: SidebarListId): string {
  return `sidebar-fold-${list}`;
}

/** Rows of a list that are shown: all of them, or the first ones while folded. */
export function visibleSidebarRowCount(
  total: number,
  limit: number,
  expanded: boolean | undefined,
): number {
  return expanded ? total : Math.min(total, limit);
}

type SidebarFoldMouseEvent = { stopPropagation?: () => void };

/** The fold row of a list, or null while the list fits its limit. */
export function sidebarFoldRow(input: {
  /** Rows behind the fold, or revealed by it. */
  count: number;
  expanded: boolean | undefined;
  list: SidebarListId;
  moreLabel: (count: number) => string;
  onToggle?: () => void;
}): React.ReactElement | null {
  if (input.count <= 0) return null;
  const id = sidebarFoldRowId(input.list);
  const onToggle = input.onToggle;
  return h(
    "text",
    {
      id,
      key: id,
      // Same contract as a section header: the click is not a selection copy.
      ...(onToggle
        ? {
            onMouseUp: (event: SidebarFoldMouseEvent) => {
              event.stopPropagation?.();
              onToggle();
            },
            selectable: false,
          }
        : {}),
      style: { ...SIDEBAR_TEXT_ROW_STYLE, fg: onToggle ? palette.accent : palette.muted },
    },
    input.expanded ? foldBackLabel(input.count) : input.moreLabel(input.count),
  );
}

/**
 * Scrolls the sidebar by the least amount that shows the fold row of a list
 * again. A list that just unfolded pushes the row down by the revealed rows;
 * a folded one pulls it up, possibly out of view.
 */
export function keepSidebarFoldRowInView(renderer: CliRenderer, list: SidebarListId): void {
  const root = renderer.root;
  const scroller = root?.findDescendantById(SIDEBAR_SCROLLBOX_ID) as ScrollBoxRenderable | undefined;
  const row = root?.findDescendantById(sidebarFoldRowId(list));
  if (!scroller || !row || scroller.isDestroyed || row.isDestroyed) return;
  const viewport = scroller.viewport;
  const below = row.screenY + row.height - (viewport.screenY + viewport.height);
  if (below > 0) {
    scroller.scrollBy(below);
    return;
  }
  const above = row.screenY - viewport.screenY;
  if (above < 0) scroller.scrollBy(above);
}

/**
 * Which folded lists are unfolded, for one view. The state lives in the view
 * and not in the sidebar: closing the narrow overlay unmounts the sidebar,
 * and the unfolded lists should survive that.
 */
export function useSidebarFold(): {
  listExpansion: SidebarListExpansion;
  onToggleList: (list: SidebarListId) => void;
} {
  const renderer = useRenderer();
  const [listExpansion, setListExpansion] = useState<SidebarListExpansion>(FOLDED_LISTS);
  const toggledListRef = useRef<SidebarListId | undefined>(undefined);
  const foldRowToRevealRef = useRef<SidebarListId | undefined>(undefined);

  const onToggleList = useCallback((list: SidebarListId) => {
    toggledListRef.current = list;
    setListExpansion((current) => toggleSidebarListExpansion(current, list));
  }, []);

  // Runs inside the commit that applied the toggle. The rows are laid out in
  // the next frame, so only that frame knows where the fold row has landed.
  useLayoutEffect(() => {
    const list = toggledListRef.current;
    if (list === undefined) return;
    toggledListRef.current = undefined;
    foldRowToRevealRef.current = list;
  });

  useEffect(() => {
    const onFrame = () => {
      const list = foldRowToRevealRef.current;
      if (list === undefined) return;
      foldRowToRevealRef.current = undefined;
      keepSidebarFoldRowInView(renderer, list);
    };
    renderer.on(CliRenderEvents.FRAME, onFrame);
    return () => {
      renderer.off(CliRenderEvents.FRAME, onFrame);
    };
  }, [renderer]);

  return { listExpansion, onToggleList };
}
