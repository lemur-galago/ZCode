import assert from "node:assert/strict";
import test from "node:test";
import { createTestRenderer } from "@mbears/opentui-core/testing";
import type { UiThemeMode } from "@zcode/contracts";
import { getZCodeCopy } from "@zcode/i18n";
import React, { act } from "react";
import { inputComposerStatusRow } from "../src/app-input-status.js";
import type { SidebarState } from "../src/app-model.js";
import { palette } from "../src/app-model.js";
import { Sidebar } from "../src/app-sidebar.js";
import { runTuiWithRenderer } from "../src/tui.js";
import type { TuiOptions } from "../src/types.js";

// Local patch (adddir-count-click): the count "(+N)" of additional directories
// reads as something to expand, in the composer status row and in the sidebar
// footer alike, but was a plain label in both. A click on it lists the folders
// now, exactly like the folder name next to it.

const COPY = getZCodeCopy("en-US").tui;
const COUNT = /^\s*\(\+\d+\)\s*$/u;
const GLYPH = "➕";

type MouseHandler = (event: { preventDefault: () => void; stopPropagation: () => void }) => void;
type TextNode = { onMouseDown?: MouseHandler; style: unknown; text: string };

function textNodes(node: unknown): TextNode[] {
  if (Array.isArray(node)) return node.flatMap(textNodes);
  if (typeof node !== "object" || node === null || !("props" in node)) return [];
  const element = node as {
    props?: { children?: unknown; onMouseDown?: MouseHandler; style?: unknown };
    type?: unknown;
  };
  const children = element.props?.children;
  const current =
    element.type === "text" && typeof children === "string"
      ? [{ onMouseDown: element.props?.onMouseDown, style: element.props?.style, text: children }]
      : [];
  return [...current, ...textNodes(children)];
}

const clickable = (node: unknown) => textNodes(node).filter((item) => item.onMouseDown);
const colorOf = (node: TextNode | undefined) => (node?.style as { fg?: unknown } | undefined)?.fg;

function press(node: TextNode | undefined): void {
  assert.ok(node?.onMouseDown, "the node takes no click");
  let prevented = 0;
  let stopped = 0;
  node.onMouseDown({
    preventDefault: () => {
      prevented += 1;
    },
    stopPropagation: () => {
      stopped += 1;
    },
  });
  // The click is consumed: it is not a selection drag nor a focus change.
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
}

function sidebarState(state: Partial<SidebarState> = {}): SidebarState {
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

test("in the composer status row the count is a target of the list, like the folder name", () => {
  const clicks: string[] = [];
  const nodes = clickable(
    inputComposerStatusRow({
      additionalDirectoryCount: 2,
      contentWidth: 120,
      model: "default-deepseek/deepseek-v4-pro",
      onStatusAddDirMouseDown: () => clicks.push("picker"),
      onStatusDirMouseDown: () => clicks.push("list"),
      thoughtLevel: "max",
      workingDirectory: "C:\\Users\\vital",
    }),
  );

  // The glyph opens the picker, the name and the count list the folders; the
  // model text after them stays plain.
  assert.deepEqual(
    nodes.map((node) => [node.text, colorOf(node)]),
    [
      [`${GLYPH} `, palette.accent],
      ["vital", palette.text],
      [" (+2)", palette.accent],
    ],
  );
  press(nodes[2]);
  assert.deepEqual(clicks, ["list"]);
  press(nodes[0]);
  assert.deepEqual(clicks, ["list", "picker"]);
});

test("in the sidebar footer the count lists the folders and the glyph still opens the picker", () => {
  const clicks: string[] = [];
  const footer = clickable(
    Sidebar({
      ...sidebarState({ workspaceDirectory: "C:\\Users\\vital" }),
      additionalDirectoryCount: 3,
      copy: COPY,
      onAddDirClick: () => clicks.push("picker"),
      onListDirsClick: () => clicks.push("list"),
    }),
  );
  const count = footer.find((node) => COUNT.test(node.text));
  const glyph = footer.find((node) => node.text.trim() === GLYPH);

  assert.equal(count?.text, "(+3) ");
  assert.equal(colorOf(count), palette.accent);
  press(count);
  assert.deepEqual(clicks, ["list"]);
  press(glyph);
  assert.deepEqual(clicks, ["list", "picker"]);
});

test("without a list handler the footer count stays a plain label", () => {
  const counts = textNodes(
    Sidebar({
      ...sidebarState(),
      additionalDirectoryCount: 1,
      copy: COPY,
      onAddDirClick: () => undefined,
    }),
  ).filter((node) => COUNT.test(node.text));
  assert.equal(counts.length, 1);
  assert.equal(counts[0]?.onMouseDown, undefined);
});

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type ActEnvironment = { IS_REACT_ACT_ENVIRONMENT?: boolean };
const actEnvironment = globalThis as typeof globalThis & ActEnvironment;

test("in the whole TUI a click on either count submits /adddir", async () => {
  const width = 160;
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const terminal = await createTestRenderer({
    exitOnCtrlC: false,
    height: 30,
    screenMode: "alternate-screen",
    targetFps: 30,
    useThread: false,
    width,
  });
  let resolveThemeMode!: (mode: UiThemeMode) => void;
  terminal.renderer.waitForThemeMode = () =>
    new Promise<UiThemeMode>((resolve) => {
      resolveThemeMode = resolve;
    });
  const submitted: string[] = [];
  const options: TuiOptions = {
    initialWorkingDirectories: ["C:\\extra"],
    locale: "en-US",
    noColor: true,
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    submitPrompt: async (input) => {
      submitted.push(input);
      return { response: "unused" };
    },
    workspaceDirectory: "/test/workspace",
  };
  let outcome: Promise<number> | undefined;

  const frameRows = async () => {
    await act(async () => {
      await terminal.renderOnce();
    });
    return terminal.captureCharFrame().split("\n");
  };
  // Both counts can share one line of the frame: the sidebar footer lies to
  // the right of the composer status row. The footer count is the one the
  // glyph follows, the composer count the other one.
  const countHits = (rows: string[]) =>
    rows.flatMap((line, row) => {
      const hits: Array<{ column: number; footer: boolean; row: number }> = [];
      for (let column = line.indexOf("(+1)"); column >= 0; column = line.indexOf("(+1)", column + 1)) {
        hits.push({ column, footer: line.slice(column + "(+1)".length).trim() === GLYPH, row });
      }
      return hits;
    });
  const countAt = async (footer: boolean) => {
    let seen: string[] = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const rows = await frameRows();
      seen = rows.filter((line) => line.includes("(+1)"));
      const hits = countHits(rows).filter((hit) => hit.footer === footer);
      if (hits.length === 1) return hits[0];
      await act(async () => {
        await sleep(50);
      });
    }
    assert.fail(`the ${footer ? "footer" : "composer"} count is rendered once; rows holding (+1): ${JSON.stringify(seen)}`);
  };
  const clickCount = async (hit: { column: number; row: number }) => {
    const before = submitted.length;
    await act(async () => {
      // The plus sign inside the parentheses.
      await terminal.mockMouse.click(hit.column + 2, hit.row);
      await settle();
    });
    for (let attempt = 0; attempt < 40 && submitted.length === before; attempt += 1) {
      await act(async () => {
        await sleep(50);
      });
    }
    await frameRows();
  };

  await act(async () => {
    outcome = runTuiWithRenderer(options, terminal.renderer);
    await terminal.renderOnce();
  });

  try {
    // The sidebar footer...
    let hit = await countAt(true);
    await clickCount(hit);
    assert.deepEqual(submitted, ["/adddir"]);

    // ...and the composer status row; the first command has changed the transcript since.
    hit = await countAt(false);
    await clickCount(hit);
    assert.deepEqual(submitted, ["/adddir", "/adddir"]);

    // The cell right of the count is not a target.
    hit = await countAt(false);
    const before = submitted.length;
    await act(async () => {
      await terminal.mockMouse.click(hit.column + 5, hit.row);
      await settle();
    });
    await frameRows();
    assert.equal(submitted.length, before);
  } finally {
    await act(async () => {
      resolveThemeMode("dark");
      terminal.renderer.destroy();
    });
    await outcome;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});
