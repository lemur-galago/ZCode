import assert from "node:assert/strict";
import test from "node:test";
import type { McpServerStatus, TodoItem } from "@zcode/contracts";
import type { ScrollBoxRenderable } from "@mbears/opentui-core";
import { parseColor } from "@mbears/opentui-core";
import { testRender } from "@mbears/opentui-react/test-utils";
import { getZCodeCopy } from "@zcode/i18n";
import React, { act } from "react";
import { AppShell } from "../src/app-components.js";
import type { SidebarState } from "../src/app-model.js";
import { Sidebar } from "../src/app-sidebar.js";
import {
  SIDEBAR_SCROLLBAR_ID,
  sidebarThumbGeometry,
} from "../src/app-sidebar-scrollbar.js";
import { SIDEBAR_WIDTH } from "../src/app-sidebar-layout.js";
import { BUILTIN_TUI_THEMES, setActiveTuiThemeMode } from "../src/theme/index.js";

// Local patch (sidebar-scrollbar): the stock slider of the scroll box drew the
// thumb with block glyphs (small squares, "beads", in the user's font) and
// sized it from a viewport of one row whenever the sidebar mounted with little
// content: short, and in the middle of the track. The thumb is now drawn by the
// sidebar itself, with filled cells, from the real scroll state.

type View = Awaited<ReturnType<typeof testRender>>;
type Span = { bg?: { buffer: Record<string, number> }; text: string; width?: number };
type ActEnvironment = { IS_REACT_ACT_ENVIRONMENT?: boolean };
const actEnvironment = globalThis as typeof globalThis & ActEnvironment;

const WIDTH = 160;
const HEIGHT = 28;
const DOCKED = { overlay: false, reservedWidth: SIDEBAR_WIDTH, visible: true, wide: true };
const BLOCK_GLYPHS = /[\u2580\u2584\u2588]/;
// The sidebar is flush right: its last column is the scrollbar column.
const COLUMN = WIDTH - 1;
// The sidebar shows 25 rows of the sections in a 28 row terminal; the full
// state below takes 30.
const TRACK_TOP = 1;
const TRACK_ROWS = 25;

const FULL: SidebarState = {
  busy: false,
  contextUsage: {},
  draft: "",
  lastEvent: "idle",
  messageCount: 0,
  mcpStatus: mcp(6),
  mode: "build",
  model: "glm-5.3",
  modifiedFiles: Array.from({ length: 4 }, (_, index) => ({
    additions: 1,
    deletions: 10,
    filePath: `src/file${index}.ts`,
  })),
  networkRequests: [],
  status: "Ready.",
  statusDetails: [],
  thoughtLevel: "medium",
  todos: todos(14),
};
const EMPTY: SidebarState = { ...FULL, mcpStatus: { loading: false, servers: {} }, modifiedFiles: [], todos: [] };

test("the thumb takes the share of the viewport and travels what the content can scroll", () => {
  // 25 of 30 rows visible: the thumb is 21 of the 25 rows of the track.
  assert.deepEqual(sidebarThumbGeometry({ content: 30, scrollTop: 0, viewport: 25 }, 25), {
    size: 21,
    start: 0,
  });
  assert.deepEqual(sidebarThumbGeometry({ content: 30, scrollTop: 3, viewport: 25 }, 25), {
    size: 21,
    start: 2,
  });
  assert.deepEqual(sidebarThumbGeometry({ content: 30, scrollTop: 5, viewport: 25 }, 25), {
    size: 21,
    start: 4,
  });
  // A long list keeps a thumb of at least one row and puts it at the end.
  assert.deepEqual(sidebarThumbGeometry({ content: 3000, scrollTop: 2975, viewport: 25 }, 25), {
    size: 1,
    start: 24,
  });
  // Nothing to scroll: no thumb.
  assert.equal(sidebarThumbGeometry({ content: 25, scrollTop: 0, viewport: 25 }, 25), null);
  assert.equal(sidebarThumbGeometry({ content: 10, scrollTop: 0, viewport: 25 }, 25), null);
  assert.equal(sidebarThumbGeometry({ content: 30, scrollTop: 3, viewport: 25 }, 0), null);
});

test("the thumb is drawn from the first frame and follows the scroll", async () => {
  const screen = await showSidebar({ state: FULL });
  try {
    assert.deepEqual(screen.thumb(), { size: 21, start: 0 });

    await screen.wheel(3);
    assert.equal(screen.scrollTop(), 3);
    assert.deepEqual(screen.thumb(), { size: 21, start: 2 });
    assert.equal(screen.stockSliderVisible(), false);
  } finally {
    await screen.close();
  }
});

test("a sidebar that fills after it mounted gets the same thumb", async () => {
  // The scenario of the screenshot: empty at mount, the content comes later.
  const screen = await showSidebar({ state: EMPTY });
  try {
    assert.equal(screen.thumb(), null);
    assert.equal(screen.stockSliderVisible(), false);

    await screen.set(FULL);
    assert.equal(screen.scrollSize(), 30);
    assert.deepEqual(screen.thumb(), { size: 21, start: 0 });
    assert.equal(screen.stockSliderVisible(), false);

    await screen.wheel(3);
    assert.deepEqual(screen.thumb(), { size: 21, start: 2 });
  } finally {
    await screen.close();
  }
});

test("the thumb follows the terminal size", async () => {
  const screen = await showSidebar({ state: FULL });
  try {
    await screen.wheel(3);
    assert.deepEqual(screen.thumb(), { size: 21, start: 2 });

    // One row less: 24 of 30 rows visible, 19 rows of thumb, a third of the way.
    await screen.resize(WIDTH, HEIGHT - 1);
    assert.equal(screen.viewportRows(), 24);
    assert.deepEqual(screen.thumb(), { size: 19, start: 3 });

    await screen.resize(WIDTH, HEIGHT);
    assert.deepEqual(screen.thumb(), { size: 21, start: 2 });
  } finally {
    await screen.close();
  }
});

test("the column carries no block glyphs, in the theme color of the muted text", async () => {
  const darkThumb = await thumbOfTheme("dark");
  const lightThumb = await thumbOfTheme("light");

  assert.equal(darkThumb.color, paletteMutedFor("dark"));
  assert.equal(lightThumb.color, paletteMutedFor("light"));
  assert.notEqual(lightThumb.color, darkThumb.color);
  // The thumb is background color only: the font has nothing to say about it.
  for (const characters of [darkThumb.characters, lightThumb.characters]) {
    assert.equal(characters.some((character) => BLOCK_GLYPHS.test(character)), false);
    assert.deepEqual(characters, [" "]);
  }
});

async function thumbOfTheme(mode: "dark" | "light"): Promise<{ characters: string[]; color: string }> {
  setActiveTuiThemeMode(mode);
  const screen = await showSidebar({ state: FULL });
  try {
    await screen.wheel(3);
    assert.deepEqual(screen.thumb(), { size: 21, start: 2 });
    return { characters: [...screen.columnCharacters()], color: screen.thumbColor() };
  } finally {
    await screen.close();
    setActiveTuiThemeMode("dark");
  }
}

// The frame keeps the colors as OpenTUI parses them.
function paletteMutedFor(mode: "dark" | "light"): string {
  const [red, green, blue] = parseColor(BUILTIN_TUI_THEMES[mode].textMuted).toInts();
  return [red, green, blue].map((part) => part.toString(16)).join(",");
}

test("a press on the track jumps there, a drag moves the thumb with the pointer", async () => {
  const screen = await showSidebar({ state: FULL });
  try {
    // Below the thumb: the thumb lands under the pointer as far as it travels.
    await screen.click(TRACK_TOP + TRACK_ROWS - 3);
    assert.equal(screen.scrollTop(), 5);
    assert.deepEqual(screen.thumb(), { size: 21, start: 4 });

    // On the thumb, three rows down: the thumb keeps its grip on the pointer.
    await screen.wheel(-5);
    await screen.drag(TRACK_TOP + 9, TRACK_TOP + 12);
    assert.equal(screen.scrollTop(), 4);
    assert.deepEqual(screen.thumb(), { size: 21, start: 3 });
    // The column is a control: none of this selected or copied anything.
    assert.equal(screen.view.renderer.hasSelection, false);

    // A drag that leaves the track stops at its end (the last row of the terminal).
    await screen.drag(TRACK_TOP + 10, HEIGHT - 2);
    assert.equal(screen.scrollTop(), 5);
    assert.deepEqual(screen.thumb(), { size: 21, start: 4 });
  } finally {
    await screen.close();
  }
});

test("the wheel over the column scrolls the sections too", async () => {
  const screen = await showSidebar({ state: FULL });
  try {
    await screen.wheel(3, COLUMN);
    assert.equal(screen.scrollTop(), 3);
    await screen.wheel(-2, COLUMN);
    assert.equal(screen.scrollTop(), 1);
  } finally {
    await screen.close();
  }
});

test("the layout facts the column relies on", async () => {
  const screen = await showSidebar({ state: FULL });
  try {
    const column = screen.column();
    const viewport = screen.scroller().viewport;
    // The column is exactly the viewport of the scroll box, one row wide.
    assert.equal(column.width, 1);
    assert.equal(column.height, viewport.height);
    assert.equal(column.x, WIDTH - 1);
    assert.equal(column.y, viewport.y);
    // The rows keep their 40 columns: the scroll box no longer shares with a slider.
    assert.equal(screen.scroller().viewport.width, 40);
    assert.ok(screen.rows().some((line) => /-10 ?$/.test(line)));
  } finally {
    await screen.close();
  }
});

let updateState: (state: SidebarState) => void = () => undefined;

function SidebarView({ state }: { state: SidebarState }): React.ReactElement {
  const [current, setCurrent] = React.useState(state);
  updateState = setCurrent;
  return React.createElement(AppShell, {
    sidebar: React.createElement(Sidebar, {
      ...current,
      copy: getZCodeCopy("en-US").tui,
      workspaceDirectory: "E:\\LSF",
    }),
    sidebarLayout: DOCKED,
  });
}

async function showSidebar(options: { state: SidebarState }): Promise<{
  click: (row: number) => Promise<void>;
  close: () => Promise<void>;
  column: () => ScrollBoxRenderable;
  columnCharacters: () => Set<string>;
  drag: (fromRow: number, toRow: number) => Promise<void>;
  resize: (width: number, height: number) => Promise<void>;
  rows: () => string[];
  scroller: () => ScrollBoxRenderable;
  scrollSize: () => number;
  scrollTop: () => number;
  set: (state: SidebarState) => Promise<void>;
  stockSliderVisible: () => boolean;
  thumb: () => { size: number; start: number } | null;
  thumbColor: () => string;
  view: View;
  viewportRows: () => number;
  wheel: (turns: number, x?: number) => Promise<void>;
}> {
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  let view: View | undefined;
  await act(async () => {
    view = await testRender(React.createElement(SidebarView, { state: options.state }), {
      height: HEIGHT,
      width: WIDTH,
    });
    await view.flush();
  });
  if (!view) throw new Error("The sidebar was not rendered.");
  const paint = async () => {
    for (let pass = 0; pass < 2; pass += 1) {
      await act(async () => {
        await settle();
        await view?.renderOnce();
      });
    }
  };
  await paint();
  const scrollerOf = () => {
    const box = view?.renderer.root.findDescendantById("sidebar-scroll") as ScrollBoxRenderable | undefined;
    assert.ok(box, "the scroll box of the sidebar");
    return box;
  };
  const backgrounds = () => {
    const lines = (view?.captureSpans() as unknown as { lines: Array<{ spans: Span[] }> }).lines;
    return lines.map((line) => {
      let start = 0;
      for (const span of line.spans) {
        const end = start + (span.width ?? [...span.text].length);
        if (COLUMN >= start && COLUMN < end) return span.bg?.buffer;
        start = end;
      }
      return undefined;
    });
  };
  const thumbRows = () => {
    const cells = backgrounds();
    const background = JSON.stringify(cells[0]);
    return cells.flatMap((cell, row) => (cell && JSON.stringify(cell) !== background ? [row] : []));
  };
  return {
    click: async (row) => {
      await act(async () => {
        await view?.mockMouse.click(COLUMN, row);
        await settle();
      });
      await paint();
    },
    close: async () => {
      await act(async () => {
        view?.renderer.destroy();
      });
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    },
    column: () => {
      const column = view?.renderer.root.findDescendantById(SIDEBAR_SCROLLBAR_ID) as ScrollBoxRenderable;
      assert.ok(column, "the scrollbar column");
      return column;
    },
    columnCharacters: () =>
      new Set(
        view
          ?.captureCharFrame()
          .split("\n")
          .filter((line) => line.length > COLUMN)
          .map((line) => line.charAt(COLUMN)) ?? [],
      ),
    drag: async (fromRow, toRow) => {
      await act(async () => {
        await view?.mockMouse.pressDown(COLUMN, fromRow);
        await settle();
      });
      await act(async () => {
        await view?.mockMouse.moveTo(COLUMN, toRow);
        await settle();
      });
      await act(async () => {
        await view?.mockMouse.release(COLUMN, toRow);
        await settle();
      });
      await paint();
    },
    resize: async (width, height) => {
      await act(async () => {
        view?.resize(width, height);
        await settle();
        await view?.renderOnce();
      });
      await paint();
    },
    rows: () => view?.captureCharFrame().split("\n") ?? [],
    scroller: scrollerOf,
    scrollSize: () => scrollerOf().scrollHeight,
    scrollTop: () => scrollerOf().scrollTop,
    set: async (state) => {
      await act(async () => {
        updateState(state);
        await settle();
      });
      await paint();
    },
    stockSliderVisible: () => scrollerOf().verticalScrollBar.visible,
    thumb: () => {
      const rows = thumbRows();
      if (rows.length === 0) return null;
      assert.deepEqual(rows, rows.map((_, index) => rows[0] + index), "the thumb is one run of rows");
      return { size: rows.length, start: rows[0] - TRACK_TOP };
    },
    thumbColor: () => {
      const cell = thumbRows().map((row) => backgrounds()[row]).find(Boolean);
      assert.ok(cell, "a thumb cell");
      return [cell["0"], cell["1"], cell["2"]].map((part) => part.toString(16)).join(",");
    },
    view,
    viewportRows: () => scrollerOf().viewport.height,
    wheel: async (turns, x = WIDTH - 20) => {
      await act(async () => {
        for (let turn = 0; turn < Math.abs(turns); turn += 1) {
          await view?.mockMouse.scroll(x, TRACK_TOP + 10, turns > 0 ? "down" : "up");
        }
        await settle();
      });
      await paint();
    },
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function mcp(count: number): { loading: boolean; servers: Record<string, McpServerStatus> } {
  const servers: Record<string, McpServerStatus> = {};
  for (let index = 1; index <= count; index += 1) {
    servers[`server${index}`] = {
      status: "connected",
      toolCount: index,
      transport: "stdio",
      updatedAt: "2026-11-25T00:00:00.000Z",
    };
  }
  return { loading: false, servers };
}

function todos(count: number): TodoItem[] {
  return Array.from({ length: count }, (_, index) => ({
    content: `Task number ${index + 1}`,
    priority: "medium",
    status: "pending",
  }));
}
