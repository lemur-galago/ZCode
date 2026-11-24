import assert from "node:assert/strict";
import test from "node:test";
import { EditBufferRenderable, RGBA, TextBufferRenderable } from "@mbears/opentui-core";
import { testRender } from "@mbears/opentui-react/test-utils";
import React, { act } from "react";
import { installThemeSelectionColors, withThemeSelectionBackground } from "../src/app-selection-colors.js";
import { MessageRow } from "../src/app-transcript-components.js";
import { DARK_TUI_THEME, LIGHT_TUI_THEME, setActiveTuiThemeMode } from "../src/theme/index.js";

type Span = { text: string; fg: RGBA; bg: RGBA };
type View = Awaited<ReturnType<typeof testRender>> & {
  captureSpans(): { lines: Array<{ spans: Span[] }> };
};

const MESSAGE = "Readme target_token words";
const WORD = "target_token";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const hex = (color: RGBA): string =>
  `#${color
    .toInts()
    .slice(0, 3)
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("")}`;

async function renderMessage(): Promise<View> {
  let view: View | undefined;
  await act(async () => {
    view = (await testRender(
      React.createElement(MessageRow, {
        index: 0,
        message: { content: MESSAGE, role: "agent" },
        terminalWidth: 80,
      }),
      { height: 10, width: 80 },
    )) as View;
  });
  assert.ok(view);
  return view;
}

/** Markdown is drawn once its highlighting is in; waits for the word to appear. */
async function locateWord(view: View): Promise<{ column: number; row: number }> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await act(async () => {
      await sleep(25);
      await view.renderOnce();
    });
    const rows = view.captureCharFrame().split("\n");
    const row = rows.findIndex((line) => line.includes(WORD));
    if (row >= 0) return { column: rows[row]?.indexOf(WORD) ?? -1, row };
  }
  assert.fail(`"${WORD}" is not rendered`);
}

async function selectWord(view: View): Promise<Span | undefined> {
  const { column, row } = await locateWord(view);
  await act(async () => {
    await view.mockMouse.drag(column, row, column + WORD.length, row);
    await view.renderOnce();
  });
  return view.captureSpans().lines[row]?.spans.find((span) => span.text === WORD);
}

test("lends the theme selection background only while the target has none", () => {
  // Local patch (selection-theme-colors): a text renderable without selection
  // colors of its own gets the selection background of the active theme.
  const holder = { _selectionBg: undefined as RGBA | undefined };
  const seen: Array<RGBA | undefined> = [];
  withThemeSelectionBackground(
    holder,
    () => {
      seen.push(holder._selectionBg);
    },
    LIGHT_TUI_THEME,
  );
  withThemeSelectionBackground(
    holder,
    () => {
      seen.push(holder._selectionBg);
    },
    DARK_TUI_THEME,
  );
  assert.deepEqual(seen.map((color) => hex(color as RGBA)), [
    LIGHT_TUI_THEME.selectionBackground,
    DARK_TUI_THEME.selectionBackground,
  ]);
  assert.equal(holder._selectionBg, undefined);

  assert.throws(
    () =>
      withThemeSelectionBackground(
        holder,
        () => {
          throw new Error("boom");
        },
        LIGHT_TUI_THEME,
      ),
    /boom/,
  );
  assert.equal(holder._selectionBg, undefined);

  // Colors of its own are left alone, and objects without the field untouched.
  const ownColor = RGBA.fromHex("#123456");
  const own = { _selectionBg: ownColor as RGBA | undefined };
  withThemeSelectionBackground(own, () => assert.equal(own._selectionBg, ownColor), LIGHT_TUI_THEME);
  const plain: Record<string, unknown> = {};
  assert.equal(withThemeSelectionBackground(plain, () => "ran", LIGHT_TUI_THEME), "ran");
  assert.deepEqual(Object.keys(plain), []);
});

test("nested installations wrap once and the last release restores the methods", () => {
  const textChanged = TextBufferRenderable.prototype.onSelectionChanged;
  const editorSetSelection = EditBufferRenderable.prototype.setSelection;

  const first = installThemeSelectionColors();
  const wrapped = TextBufferRenderable.prototype.onSelectionChanged;
  assert.notEqual(wrapped, textChanged);

  const second = installThemeSelectionColors();
  assert.equal(TextBufferRenderable.prototype.onSelectionChanged, wrapped);

  first();
  assert.equal(TextBufferRenderable.prototype.onSelectionChanged, wrapped);

  second();
  second();
  assert.equal(TextBufferRenderable.prototype.onSelectionChanged, textChanged);
  assert.equal(EditBufferRenderable.prototype.setSelection, editorSetSelection);
});

test("a selection keeps the text color on the selection background of each theme", async () => {
  const uninstall = installThemeSelectionColors();
  try {
    for (const theme of [LIGHT_TUI_THEME, DARK_TUI_THEME]) {
      setActiveTuiThemeMode(theme.mode);
      const view = await renderMessage();
      try {
        const selected = await selectWord(view);
        assert.ok(selected, "the word is one span of its own");
        assert.equal(hex(selected.bg), theme.selectionBackground);
        assert.equal(hex(selected.fg), theme.text);
      } finally {
        await act(async () => {
          view.renderer.destroy();
        });
        setActiveTuiThemeMode("dark");
      }
    }
  } finally {
    uninstall();
  }
});

test("without the patch the light theme selects dark on dark", async () => {
  // Documents the defect: OpenTUI swaps the foreground and the background and
  // uses black for the text, which cannot be read on the dark palette's block.
  setActiveTuiThemeMode("light");
  const view = await renderMessage();
  try {
    const selected = await selectWord(view);
    assert.ok(selected);
    assert.equal(hex(selected.bg), LIGHT_TUI_THEME.text);
    assert.equal(hex(selected.fg), "#000000");
  } finally {
    await act(async () => {
      view.renderer.destroy();
    });
    setActiveTuiThemeMode("dark");
  }
});
