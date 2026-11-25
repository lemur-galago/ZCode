import assert from "node:assert/strict";
import test from "node:test";
import type { McpServerStatus, TodoItem } from "@zcode/contracts";
import type { ScrollBoxRenderable } from "@mbears/opentui-core";
import { testRender } from "@mbears/opentui-react/test-utils";
import { getZCodeCopy } from "@zcode/i18n";
import React, { act } from "react";
import { AppShell } from "../src/app-components.js";
import type { SidebarState } from "../src/app-model.js";
import { Sidebar } from "../src/app-sidebar.js";
import { useSidebarFold } from "../src/app-sidebar-fold.js";
import { SIDEBAR_WIDTH } from "../src/app-sidebar-layout.js";
import type { SubagentsController } from "../src/app-subagents.js";

// Local patch (sidebar-fold / sidebar-scroll): the sidebar was a rigid column:
// whatever did not fit the terminal was cut off, and the rows behind a
// "+N more" label could not be reached at all. The sections now scroll above
// the pinned workspace footer, and the label is a toggle that keeps itself in
// view.

type View = Awaited<ReturnType<typeof testRender>>;
type SidebarLayout = NonNullable<Parameters<typeof AppShell>[0]["sidebarLayout"]>;
type ActEnvironment = { IS_REACT_ACT_ENVIRONMENT?: boolean };
const actEnvironment = globalThis as typeof globalThis & ActEnvironment;

const NARROW = 56;
const DOCKED: SidebarLayout = { overlay: false, reservedWidth: SIDEBAR_WIDTH, visible: true, wide: true };
const OVERLAY: SidebarLayout = { overlay: true, reservedWidth: 0, visible: true, wide: false };
const THUMB = /[\u2580\u2584\u2588]/;
const END_OF_FILE_ROW = / -10(?: |[\u2580\u2584\u2588])?$/;

test("a click on '+N more' unfolds the list, a click on the way back folds it", async () => {
  const screen = await showSidebar({ height: 24, state: sidebarState({ mcpStatus: mcp(7) }) });
  try {
    assert.ok(screen.rows().some((line) => line.includes("+2 more")));
    assert.equal(screen.rows().some((line) => line.includes("server7")), false);

    await screen.click("+2 more");
    assert.ok(screen.rows().some((line) => line.includes("server6")));
    assert.ok(screen.rows().some((line) => line.includes("server7")));
    assert.ok(screen.rows().some((line) => line.includes("-2 less")));
    assert.equal(screen.rows().some((line) => line.includes("+2 more")), false);

    await screen.click("-2 less");
    assert.ok(screen.rows().some((line) => line.includes("+2 more")));
    assert.equal(screen.rows().some((line) => line.includes("server7")), false);
  } finally {
    await screen.close();
  }
});

test("the sidebar scrolls above the pinned footer instead of being cut off", async () => {
  const state = sidebarState({ mcpStatus: mcp(6), modifiedFiles: files(8), todos: todos(12) });
  const screen = await showSidebar({ height: 24, state, workspaceDirectory: "E:\\LSF" });
  try {
    const rows = screen.rows();
    assert.ok(rows.some((line) => line.includes("E:\\LSF")));
    assert.ok(rows.some((line) => line.includes("ZCode")));
    assert.equal(rows.some((line) => line.includes("Todos")), false);
    assert.ok(rows.some((line) => THUMB.test(line)));

    // A wheel turn over the sidebar moves the sections; the footer stays.
    await screen.wheel(9);
    assert.equal(screen.scrollTop(), 9);
    assert.equal(screen.rows().some((line) => line.includes("ZCode")), false);
    assert.ok(screen.rows().some((line) => line.includes("Todos")));
    assert.ok(screen.rows().some((line) => line.includes("E:\\LSF")));
    // The scrollbar took the right padding column: the rows are not truncated.
    assert.ok(screen.rows().some((line) => END_OF_FILE_ROW.test(line)));

    await screen.wheel(-9);
    assert.equal(screen.scrollTop(), 0);
    assert.ok(screen.rows().some((line) => line.includes("ZCode")));
  } finally {
    await screen.close();
  }
});

test("a sidebar that fits shows no scrollbar and does not move", async () => {
  const screen = await showSidebar({ height: 44, state: sidebarState({ mcpStatus: mcp(6) }) });
  try {
    assert.equal(screen.rows().some((line) => THUMB.test(line)), false);
    const before = screen.rows();

    await screen.wheel(3);
    assert.deepEqual(screen.rows(), before);
    assert.equal(screen.scrollTop(), 0);
  } finally {
    await screen.close();
  }
});

test("the fold row stays in view after a list unfolded below it", async () => {
  const state = sidebarState({ mcpStatus: mcp(3), todos: todos(12) });
  const screen = await showSidebar({ height: 24, state, workspaceDirectory: "E:\\LSF" });
  try {
    // The todos fold row is the last visible row: the rows it reveals would
    // land under the footer.
    await screen.wheel(30);
    const lastViewportRow = screen.rowOf("E:\\LSF") - 1;
    assert.equal(screen.rowOf("+6 more"), lastViewportRow);
    const scrollTopBefore = screen.scrollTop();

    await screen.click("+6 more");
    assert.equal(screen.rowOf("-6 less"), lastViewportRow);
    assert.ok(screen.rows().some((line) => line.includes("Task number 7")));
    assert.ok(screen.rows().some((line) => line.includes("Task number 12")));
    assert.ok(screen.scrollTop() > scrollTopBefore);
  } finally {
    await screen.close();
  }
});

test("the fold row stays in view after a list folded above the viewport", async () => {
  const state = sidebarState({
    developerMode: true,
    mcpStatus: mcp(3),
    modifiedFiles: files(8),
    todos: todos(12),
  });
  const screen = await showSidebar({ height: 24, state, workspaceDirectory: "E:\\LSF" });
  try {
    await screen.scrollToRow("+2 more");
    await screen.click("+2 more");
    // Scroll until the way back is the first visible row.
    await screen.scrollToRow("-2 less", 1);
    assert.equal(screen.rowOf("-2 less"), 1);

    // Folding pulls the row two lines up, out of the viewport.
    await screen.click("-2 less");
    assert.equal(screen.rowOf("+2 more"), 1);
  } finally {
    await screen.close();
  }
});

test("an unfolded list survives closing and reopening the narrow overlay", async () => {
  const screen = await showSidebar({ height: 24, state: sidebarState({ mcpStatus: mcp(7) }) });
  try {
    await screen.click("+2 more");
    assert.ok(screen.rows().some((line) => line.includes("-2 less")));

    // Closing the overlay unmounts the sidebar, as in the view.
    await screen.toggleSidebar();
    assert.equal(screen.rows().some((line) => line.includes("less")), false);
    assert.equal(screen.rows().some((line) => line.includes("ZCode")), false);

    await screen.toggleSidebar();
    assert.ok(screen.rows().some((line) => line.includes("-2 less")));
    assert.ok(screen.rows().some((line) => line.includes("server7")));
  } finally {
    await screen.close();
  }
});

test("a docked sidebar scrolls on its own, apart from the transcript", async () => {
  const transcript = React.createElement(
    "scrollbox",
    { id: "main-transcript", focused: false, style: { flexGrow: 1 } },
    ...Array.from({ length: 60 }, (_, index) =>
      React.createElement("text", { key: `line-${index}`, content: `transcript line ${index + 1}` }),
    ),
  );
  const screen = await showSidebar({
    children: transcript,
    height: 24,
    layout: DOCKED,
    state: sidebarState({ mcpStatus: mcp(6), todos: todos(12) }),
    width: 140,
  });
  try {
    await screen.wheel(4, 140 - SIDEBAR_WIDTH / 2);
    assert.equal(screen.scrollTop(), 4);
    assert.equal(screen.scrollTop("main-transcript"), 0);

    await screen.wheel(4, 5);
    assert.equal(screen.scrollTop("main-transcript"), 4);
    assert.equal(screen.scrollTop(), 4);
  } finally {
    await screen.close();
  }
});

test("a wheel turn over the subagent list does not also scroll the sidebar", async () => {
  const running = Array.from({ length: 10 }, (_, index) => ({
    childSessionId: `child-${index}`,
    title: `Worker ${index + 1}`,
    subagentType: "general",
    status: "running",
  }));
  const subagents = {
    directory: {
      revision: 1,
      childSessionIds: running.map((item) => item.childSessionId),
      running,
      ended: { total: 0, items: [] },
    },
  } as unknown as SubagentsController;
  const screen = await showSidebar({
    height: 40,
    state: sidebarState({
      mcpStatus: mcp(3),
      modifiedFiles: files(8),
      todos: todos(12),
    }),
    subagents,
  });
  try {
    const sidebarX = NARROW - SIDEBAR_WIDTH / 2;
    await screen.wheel(3, sidebarX, screen.rowOf("Worker 1") + 4);
    assert.ok(screen.scrollTop("subagent-directory") > 0);
    assert.equal(screen.scrollTop(), 0);

    // Anywhere else in the sidebar the wheel scrolls the sidebar.
    await screen.wheel(3, sidebarX, screen.rowOf("server1"));
    assert.ok(screen.scrollTop() > 0);
  } finally {
    await screen.close();
  }
});

// The same composition as the view: the fold state lives above the sidebar,
// which is unmounted while the narrow overlay is closed.
let closeOrOpenSidebar: () => void = () => undefined;

function SidebarView(props: {
  children?: React.ReactNode;
  layout: SidebarLayout;
  state: SidebarState;
  subagents?: SubagentsController;
  workspaceDirectory?: string;
}): React.ReactElement {
  const fold = useSidebarFold();
  const [visible, setVisible] = React.useState(props.layout.visible);
  closeOrOpenSidebar = () => setVisible((value) => !value);
  return React.createElement(
    AppShell,
    {
      sidebar: visible
        ? React.createElement(Sidebar, {
            ...props.state,
            copy: getZCodeCopy("en-US").tui,
            listExpansion: fold.listExpansion,
            onToggleList: fold.onToggleList,
            subagents: props.subagents,
            workspaceDirectory: props.workspaceDirectory ?? "/work",
          })
        : null,
      sidebarLayout: { ...props.layout, visible },
    },
    props.children,
  );
}

async function showSidebar(options: {
  children?: React.ReactNode;
  height: number;
  layout?: SidebarLayout;
  state: SidebarState;
  subagents?: SubagentsController;
  width?: number;
  workspaceDirectory?: string;
}): Promise<Screen> {
  return show(
    React.createElement(SidebarView, {
      children: options.children,
      layout: options.layout ?? OVERLAY,
      state: options.state,
      subagents: options.subagents,
      workspaceDirectory: options.workspaceDirectory,
    }),
    options.width ?? NARROW,
    options.height,
  );
}

type Screen = Awaited<ReturnType<typeof show>>;

async function show(
  element: React.ReactElement,
  width: number,
  height: number,
): Promise<{
  click: (text: string) => Promise<void>;
  close: () => Promise<void>;
  rowOf: (text: string) => number;
  rows: () => string[];
  scrollToRow: (text: string, targetRow?: number) => Promise<void>;
  scrollTop: (id?: string) => number;
  toggleSidebar: () => Promise<void>;
  wheel: (turns: number, x?: number, y?: number) => Promise<void>;
}> {
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  let view: View | undefined;
  await act(async () => {
    view = await testRender(element, { height, width });
    await view.flush();
  });
  if (!view) throw new Error("The sidebar was not rendered.");
  const paint = async () => {
    // Two frames: the first one lays a change out, the second one shows what
    // a frame listener did with it (the fold row kept in view).
    for (let pass = 0; pass < 2; pass += 1) {
      await act(async () => {
        await settle();
        await view?.renderOnce();
      });
    }
  };
  await paint();
  const frame = () => view?.captureCharFrame().split("\n") ?? [];
  const rowOf = (text: string) => frame().findIndex((line) => line.includes(text));
  return {
    click: async (text) => {
      const row = rowOf(text);
      assert.notEqual(row, -1, `No row with "${text}".`);
      const column = frame()[row]?.indexOf(text) ?? -1;
      assert.ok(column >= 0);
      await act(async () => {
        await view?.mockMouse.click(column + 1, row);
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
    rowOf,
    rows: frame,
    scrollToRow: async (text, targetRow = 10) => {
      for (let turn = 0; turn < 80 && rowOf(text) !== targetRow; turn += 1) {
        const before = rowOf(text);
        const scrollTopBefore = box(view, "sidebar-scroll").scrollTop;
        await wheelDown(view, 1);
        await paint();
        if (rowOf(text) === before && box(view, "sidebar-scroll").scrollTop === scrollTopBefore) break;
      }
      assert.equal(rowOf(text), targetRow, `"${text}" did not reach row ${targetRow}.`);
    },
    scrollTop: (id = "sidebar-scroll") => box(view, id).scrollTop,
    toggleSidebar: async () => {
      await act(async () => {
        closeOrOpenSidebar();
        await settle();
      });
      await paint();
    },
    wheel: async (turns, x = width - SIDEBAR_WIDTH / 2, y = 10) => {
      await act(async () => {
        for (let turn = 0; turn < Math.abs(turns); turn += 1) {
          await view?.mockMouse.scroll(Math.floor(x), y, turns > 0 ? "down" : "up");
        }
        await settle();
      });
      await paint();
    },
  };
}

function box(view: View | undefined, id: string): ScrollBoxRenderable {
  const found = view?.renderer.root.findDescendantById(id) as ScrollBoxRenderable | undefined;
  assert.ok(found, `No scroll box "${id}".`);
  return found;
}

async function wheelDown(view: View | undefined, turns: number): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < turns; turn += 1) {
      await view?.mockMouse.scroll(view.renderer.width - SIDEBAR_WIDTH / 2, 10, "down");
    }
    await settle();
  });
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function mcp(count: number): { loading: boolean; servers: Record<string, McpServerStatus> } {
  const entries: Record<string, McpServerStatus> = {};
  for (let index = 1; index <= count; index += 1) {
    entries[`server${index}`] = {
      status: "connected",
      toolCount: index,
      transport: "stdio",
      updatedAt: "2026-11-25T00:00:00.000Z",
    };
  }
  return { loading: false, servers: entries };
}

function todos(count: number): TodoItem[] {
  return Array.from({ length: count }, (_, index) => ({
    content: `Task number ${index + 1}`,
    priority: "medium",
    status: "pending",
  }));
}

function files(count: number): SidebarState["modifiedFiles"] {
  return Array.from({ length: count }, (_, index) => ({
    additions: index,
    deletions: 10,
    filePath: `src/file${index}.ts`,
  }));
}

function sidebarState(state: Partial<SidebarState>): SidebarState {
  return {
    busy: false,
    contextUsage: {},
    draft: "",
    lastEvent: "idle",
    messageCount: 0,
    mcpStatus: { loading: false, servers: {} },
    mode: "build",
    model: "glm-5.3",
    modifiedFiles: [],
    networkRequests: [],
    status: "Ready.",
    statusDetails: [],
    thoughtLevel: "medium",
    todos: [],
    ...state,
  };
}
