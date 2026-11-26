import assert from "node:assert/strict";
import test from "node:test";
import { EditBufferRenderable, RGBA, TextBufferRenderable, TextTableRenderable } from "@mbears/opentui-core";
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
// OpenTUI draws a markdown table with a renderable of its own.
const TABLE_MESSAGE = [
  "| Command | Effect |",
  "| ------- | ------ |",
  "| alpha | twelve columns |",
  "| beta | thirty rows |",
  "| gamma | uses `sed` here |",
].join("\n");
const TABLE_WORD = "thirty";
const TABLE_CODE_WORD = "sed";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const hex = (color: RGBA): string =>
  `#${color
    .toInts()
    .slice(0, 3)
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("")}`;

async function renderMessage(content = MESSAGE): Promise<View> {
  let view: View | undefined;
  await act(async () => {
    view = (await testRender(
      React.createElement(MessageRow, {
        index: 0,
        message: { content, role: "agent" },
        terminalWidth: 80,
      }),
      { height: 10, width: 80 },
    )) as View;
  });
  assert.ok(view);
  return view;
}

/** Markdown is drawn once its highlighting is in; waits for the word to appear. */
async function locateWord(view: View, word = WORD): Promise<{ column: number; row: number }> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await act(async () => {
      await sleep(25);
      await view.renderOnce();
    });
    const rows = view.captureCharFrame().split("\n");
    const row = rows.findIndex((line) => line.includes(word));
    if (row >= 0) return { column: rows[row]?.indexOf(word) ?? -1, row };
  }
  assert.fail(`"${word}" is not rendered`);
}

function wordSpan(view: View, word: string, row: number): Span | undefined {
  return view.captureSpans().lines[row]?.spans.find((span) => span.text === word);
}

// Before a selection a whole cell is one span; once selected the word is a span of its own.
function textSpan(view: View, word: string, row: number): Span | undefined {
  return view.captureSpans().lines[row]?.spans.find((span) => span.text.includes(word));
}

async function selectWord(view: View, word = WORD): Promise<Span | undefined> {
  const { column, row } = await locateWord(view, word);
  await act(async () => {
    await view.mockMouse.drag(column, row, column + word.length, row);
    await view.renderOnce();
  });
  return wordSpan(view, word, row);
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
  const tablePrototype = TextTableRenderable.prototype as unknown as Record<string, unknown>;
  const tableApplySelection = tablePrototype.applySelectionToCells;

  const first = installThemeSelectionColors();
  const wrapped = TextBufferRenderable.prototype.onSelectionChanged;
  assert.notEqual(wrapped, textChanged);
  assert.notEqual(tablePrototype.applySelectionToCells, tableApplySelection);

  const second = installThemeSelectionColors();
  assert.equal(TextBufferRenderable.prototype.onSelectionChanged, wrapped);

  first();
  assert.equal(TextBufferRenderable.prototype.onSelectionChanged, wrapped);

  second();
  second();
  assert.equal(TextBufferRenderable.prototype.onSelectionChanged, textChanged);
  assert.equal(EditBufferRenderable.prototype.setSelection, editorSetSelection);
  assert.equal(tablePrototype.applySelectionToCells, tableApplySelection);
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

test("a selection in a markdown table takes the selection background of each theme", async () => {
  // Local patch (selection-theme-colors): OpenTUI draws a markdown table with
  // a renderable of its own, which hands the colors to its cells itself; it
  // takes part in the same lending.
  const uninstall = installThemeSelectionColors();
  try {
    for (const theme of [LIGHT_TUI_THEME, DARK_TUI_THEME]) {
      setActiveTuiThemeMode(theme.mode);
      const view = await renderMessage(TABLE_MESSAGE);
      try {
        for (const word of [TABLE_WORD, TABLE_CODE_WORD]) {
          const { row } = await locateWord(view, word);
          const plain = textSpan(view, word, row);
          const selected = await selectWord(view, word);
          assert.ok(plain && selected, `"${word}" is one span of its own once selected`);
          assert.equal(hex(selected.bg), theme.selectionBackground);
          assert.equal(hex(selected.fg), hex(plain.fg));
        }
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

test("a selection in a table keeps the theme colors after the table is laid out again", async () => {
  // A resized terminal lays the table out again, and the colors are handed to
  // the cells a second time. The word sits at the left of its cell, so the
  // selection covers it again at the new width.
  const uninstall = installThemeSelectionColors();
  try {
    setActiveTuiThemeMode("light");
    const view = await renderMessage(TABLE_MESSAGE);
    try {
      assert.ok(await selectWord(view, "beta"));
      await act(async () => {
        view.resize(60, 10);
        await view.renderOnce();
      });
      const { row } = await locateWord(view, "beta");
      const selected = wordSpan(view, "beta", row);
      assert.ok(selected, "the selection outlives the resize");
      assert.equal(hex(selected.bg), LIGHT_TUI_THEME.selectionBackground);
      assert.equal(hex(selected.fg), LIGHT_TUI_THEME.text);
    } finally {
      await act(async () => {
        view.renderer.destroy();
      });
      setActiveTuiThemeMode("dark");
    }
  } finally {
    uninstall();
  }
});

test("without the patch the light theme selects dark on dark in a table", async () => {
  setActiveTuiThemeMode("light");
  const view = await renderMessage(TABLE_MESSAGE);
  try {
    const selected = await selectWord(view, TABLE_WORD);
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
