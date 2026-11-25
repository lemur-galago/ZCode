import assert from "node:assert/strict";
import test from "node:test";
import type { McpServerStatus, TodoItem } from "@zcode/contracts";
import { getZCodeCopy } from "@zcode/i18n";
import type { SidebarState } from "../src/app-model.js";
import { palette } from "../src/app-model.js";
import { sidebarFoldRowId, visibleSidebarRowCount } from "../src/app-sidebar-fold.js";
import { Sidebar } from "../src/app-sidebar.js";
import {
  toggleSidebarListExpansion,
  type SidebarListExpansion,
} from "../src/app-sidebar-layout.js";

// Local patch (sidebar-fold): the lists of the sidebar fold their tail behind
// a "+N more" row, which was plain text. The row is a toggle now: a click
// reveals the rows, the next click folds them back.

const copy = getZCodeCopy("en-US").tui;
const FOLDED: SidebarListExpansion = { apis: false, mcp: false, modifiedFiles: false, todos: false };

type TextNode = { props: Record<string, unknown> };

test("a folded list toggles on its own, the other lists keep their state", () => {
  const unfolded = toggleSidebarListExpansion(FOLDED, "todos");

  assert.deepEqual(unfolded, { apis: false, mcp: false, modifiedFiles: false, todos: true });
  assert.deepEqual(toggleSidebarListExpansion(unfolded, "mcp"), {
    apis: false,
    mcp: true,
    modifiedFiles: false,
    todos: true,
  });
  assert.deepEqual(toggleSidebarListExpansion(unfolded, "todos"), FOLDED);
  assert.equal(FOLDED.todos, false);
});

test("a list shows its limit while folded and every row once unfolded", () => {
  assert.equal(visibleSidebarRowCount(4, 5, false), 4);
  assert.equal(visibleSidebarRowCount(9, 5, false), 5);
  assert.equal(visibleSidebarRowCount(9, 5, true), 9);
  assert.equal(visibleSidebarRowCount(9, 5, undefined), 5);
  assert.equal(sidebarFoldRowId("todos"), "sidebar-fold-todos");
});

test("an unfolded list shows the rows behind the fold and the way back", () => {
  const state = sidebarState({ mcpStatus: { loading: false, servers: servers(7) } });
  const folded = textsOf(Sidebar({ ...state, copy }));
  const unfolded = textsOf(Sidebar({ ...state, copy, listExpansion: { mcp: true } }));

  assert.ok(folded.some((line) => line.includes("server5")));
  assert.equal(folded.some((line) => line.includes("server6")), false);
  assert.ok(folded.includes("+2 more"));
  assert.ok(unfolded.some((line) => line.includes("server6")));
  assert.ok(unfolded.some((line) => line.includes("server7")));
  assert.ok(unfolded.includes("-2 less"));
  assert.equal(unfolded.includes("+2 more"), false);

  // A list that fits its limit has no fold row, folded or not.
  const short = { loading: false, servers: servers(5) };
  for (const listExpansion of [undefined, { mcp: true }]) {
    const lines = textsOf(Sidebar({ ...sidebarState({ mcpStatus: short }), copy, listExpansion }));
    assert.equal(lines.some((line) => /more|less/.test(line)), false);
  }
});

test("the fold row is a clickable toggle, and stays a plain row without a handler", () => {
  const state = sidebarState({ todos: todos(10) });
  const plain = textNodes(Sidebar({ ...state, copy })).filter((node) => textOf(node) === "+4 more");
  const toggled: string[] = [];
  const stopped: string[] = [];
  const interactive = textNodes(
    Sidebar({ ...state, copy, onToggleList: (list) => toggled.push(list) }),
  ).filter((node) => textOf(node) === "+4 more");

  assert.equal(plain.length, 1);
  assert.equal(plain[0]?.props.onMouseUp, undefined);
  assert.equal(colorOf(plain[0]), palette.muted);

  assert.equal(interactive.length, 1);
  assert.equal(interactive[0]?.props.selectable, false);
  assert.equal(interactive[0]?.props.id, "sidebar-fold-todos");
  assert.equal(colorOf(interactive[0]), palette.accent);
  mouseUp(interactive[0], stopped);
  assert.deepEqual(toggled, ["todos"]);
  assert.deepEqual(stopped, ["fold"]);
});

test("every list that folds wakes its own toggle", () => {
  const state = sidebarState({
    modifiedFiles: files(9),
    networkRequests: requests(8),
    todos: todos(8),
  });
  const toggled: string[] = [];
  const nodes = textNodes(
    Sidebar({ ...state, copy, developerMode: true, onToggleList: (list) => toggled.push(list) }),
  );

  // Modified files, then todos, then API requests: the order of the sidebar.
  const clickable = nodes.filter((node) => /^\+\d+ more$/.test(textOf(node)) && node.props.id);
  assert.deepEqual(
    clickable.map((node) => [textOf(node), node.props.id]),
    [
      ["+3 more", "sidebar-fold-modifiedFiles"],
      ["+2 more", "sidebar-fold-todos"],
      ["+3 more", "sidebar-fold-apis"],
    ],
  );
  for (const node of clickable) mouseUp(node, []);
  assert.deepEqual(toggled, ["modifiedFiles", "todos", "apis"]);

  const unfolded = textsOf(
    Sidebar({
      ...state,
      copy,
      developerMode: true,
      listExpansion: { apis: true, mcp: true, modifiedFiles: true, todos: true },
    }),
  );
  // Two lists hide three rows, one hides two.
  assert.equal(unfolded.filter((line) => line === "-3 less").length, 2);
  assert.equal(unfolded.filter((line) => line === "-2 less").length, 1);
  assert.ok(unfolded.some((line) => line.includes("src/file8.ts")));
  assert.ok(unfolded.some((line) => line.includes("api.example.com/7")));
  assert.ok(unfolded.some((line) => line.includes("Task number 8")));
  assert.equal(unfolded.some((line) => /^\+\d+ more$/.test(line)), false);
});

function servers(count: number): Record<string, McpServerStatus> {
  const entries: Record<string, McpServerStatus> = {};
  for (let index = 1; index <= count; index += 1) {
    entries[`server${index}`] = {
      status: "connected",
      toolCount: index,
      transport: "stdio",
      updatedAt: "2026-11-25T00:00:00.000Z",
    };
  }
  return entries;
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
    deletions: 0,
    filePath: `src/file${index}.ts`,
  }));
}

function requests(count: number): SidebarState["networkRequests"] {
  return Array.from({ length: count }, (_, index) => ({
    id: `request-${index}`,
    method: "POST",
    requestId: `request-${index}`,
    source: "model",
    startedAt: "2026-11-25T00:00:00.000Z",
    status: "complete",
    updatedAt: "2026-11-25T00:00:01.000Z",
    url: `https://api.example.com/${index}`,
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

function textNodes(node: unknown, found: TextNode[] = []): TextNode[] {
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null || !("props" in value)) return;
    const element = value as { props: Record<string, unknown>; type?: unknown };
    if (element.type === "text") found.push({ props: element.props });
    visit(element.props.children);
  };
  visit(node);
  return found;
}

function textsOf(node: unknown): string[] {
  return textNodes(node).map(textOf);
}

function textOf(node: TextNode): string {
  const parts: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
  };
  visit(node.props.children);
  return parts.join("");
}

function colorOf(node: TextNode | undefined): unknown {
  return (node?.props.style as { fg?: unknown } | undefined)?.fg;
}

function mouseUp(node: TextNode | undefined, stopped: string[]): void {
  assert.ok(node?.props.onMouseUp);
  (node.props.onMouseUp as (event: { stopPropagation: () => void }) => void)({
    stopPropagation: () => stopped.push("fold"),
  });
}
