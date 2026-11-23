import assert from "node:assert/strict";
import test from "node:test";
import { createTestRenderer } from "@mbears/opentui-core/testing";
import { testRender } from "@mbears/opentui-react/test-utils";
import type { UiThemeMode } from "@zcode/contracts";
import React, { act } from "react";
import {
  DOUBLE_CLICK_INTERVAL_MS,
  createClickCounter,
  installDoubleClickSelection,
  wordRangeAt,
} from "../src/app-double-click-select.js";
import { runTuiWithRenderer } from "../src/tui.js";
import type { TuiOptions } from "../src/types.js";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("counts presses on one cell within the double-click interval", () => {
  let now = 0;
  const clicks = createClickCounter(() => now);

  assert.equal(clicks({ x: 10, y: 2 }), 1);
  now = DOUBLE_CLICK_INTERVAL_MS;
  assert.equal(clicks({ x: 11, y: 2 }), 2);
  now = DOUBLE_CLICK_INTERVAL_MS * 2;
  assert.equal(clicks({ x: 10, y: 2 }), 3);

  now += DOUBLE_CLICK_INTERVAL_MS + 1;
  assert.equal(clicks({ x: 10, y: 2 }), 1);
  now += 1;
  assert.equal(clicks({ x: 20, y: 2 }), 1);
  now += 1;
  assert.equal(clicks({ x: 20, y: 3 }), 1);
});

// Column layout of a rendered row: Han glyphs take two cells, everything else one.
function layout(text: string) {
  const units = [...new Intl.Segmenter().segment(text)].map(({ segment }) => ({
    cells: /^\p{Script=Han}$/u.test(segment) ? 2 : 1,
    text: segment,
  }));
  let column = 0;
  const columns = units.map((unit) => {
    const start = column;
    column += unit.cells;
    return start;
  });
  const probe = (start: number, cells: number) =>
    units
      .filter((unit, index) => columns[index] < start + cells && columns[index] + unit.cells > start)
      .map((unit) => unit.text)
      .join("");
  return { columnOf: (index: number) => columns[index], probe, width: column };
}

test("word range follows word characters and keeps two-cell glyphs whole", () => {
  // П0 р1 и2 в3 е4 т5 _6 м7 и8 р9 _10 f11 o12 o13 _14 b15 a16 r17 _18 4_19 2_20 _21 猫22 ,23 _24 x25
  const row = layout("Привет мир foo_bar_42 猫, x");

  assert.deepEqual(wordRangeAt(row.probe, row.columnOf(16), 0, row.width), {
    end: row.columnOf(21),
    start: row.columnOf(11),
  });
  assert.deepEqual(wordRangeAt(row.probe, row.columnOf(2), 0, row.width), {
    end: row.columnOf(6),
    start: row.columnOf(0),
  });
  assert.deepEqual(wordRangeAt(row.probe, row.columnOf(25), 0, row.width), {
    end: row.width,
    start: row.columnOf(25),
  });
  assert.deepEqual(
    wordRangeAt(row.probe, row.columnOf(22) + 1, 0, row.width),
    { end: row.columnOf(22) + 2, start: row.columnOf(22) },
  );
  assert.deepEqual(wordRangeAt(row.probe, row.columnOf(23), 0, row.width), {
    end: row.columnOf(24),
    start: row.columnOf(23),
  });
  assert.equal(wordRangeAt(row.probe, row.width + 3, 0, row.width), undefined);

  // a0 p1 p2 -3 v4 i5 e6 w7 .8 t9 s10 x11 _12 -13 -14 f15 o16 r17 c18 e19 _20 ч21 т22 о23 -24 т25 о26 .27 _28 e29 n30 d31 .32
  const tokens = layout("app-view.tsx --force что-то. end.");
  assert.deepEqual(wordRangeAt(tokens.probe, tokens.columnOf(1), 0, tokens.width), {
    end: tokens.columnOf(12),
    start: tokens.columnOf(0),
  });
  assert.deepEqual(wordRangeAt(tokens.probe, tokens.columnOf(13), 0, tokens.width), {
    end: tokens.columnOf(20),
    start: tokens.columnOf(13),
  });
  assert.deepEqual(wordRangeAt(tokens.probe, tokens.columnOf(24), 0, tokens.width), {
    end: tokens.columnOf(27),
    start: tokens.columnOf(21),
  });
  assert.deepEqual(wordRangeAt(tokens.probe, tokens.columnOf(30), 0, tokens.width), {
    end: tokens.width - 1,
    start: tokens.columnOf(29),
  });
  assert.deepEqual(wordRangeAt(tokens.probe, tokens.columnOf(27), 0, tokens.width), {
    end: tokens.columnOf(28),
    start: tokens.columnOf(27),
  });
});

test("double click selects the word under the pointer in rendered text", async () => {
  const content = "Привет мир foo_bar_42 app-view.tsx 猫.";
  let view: Awaited<ReturnType<typeof testRender>> | undefined;

  await act(async () => {
    view = await testRender(
      React.createElement(
        "box",
        { style: { border: true } },
        React.createElement("text", { content }),
      ),
      { height: 6, width: 60 },
    );
    await view.renderOnce();
    installDoubleClickSelection(view.renderer);
  });

  const selected = () => view?.renderer.getSelection()?.getSelectedText() ?? null;
  // A click on the empty tail ends the previous click run and clears the selection.
  const doubleClick = async (x: number, y: number) => {
    await act(async () => {
      await view?.mockMouse.click(45, 1, 0, { delayMs: 0 });
      await view?.mockMouse.doubleClick(x, y, 0, { delayMs: 5 });
      await settle();
    });
    return selected();
  };

  try {
    assert.equal(await doubleClick(16, 1), "foo_bar_42");
    assert.equal(await doubleClick(4, 1), "Привет");
    assert.equal(await doubleClick(28, 1), "app-view.tsx");
    assert.equal(await doubleClick(37, 1), "猫");
    assert.equal(await doubleClick(38, 1), ".");
    assert.equal(await doubleClick(40, 1), "");
    assert.equal(await doubleClick(30, 0), null);

    await act(async () => {
      await view?.mockMouse.click(45, 1, 0, { delayMs: 0 });
      for (let press = 0; press < 3; press += 1) {
        await view?.mockMouse.click(15, 1, 0, { delayMs: 5 });
      }
      await settle();
    });
    assert.equal(selected(), content);

    await act(async () => {
      await view?.mockMouse.click(45, 1, 0, { delayMs: 0 });
      await settle();
    });
    assert.equal(selected(), "");
  } finally {
    await act(async () => {
      view?.renderer.destroy();
    });
  }
});

test("double click copies the word under the pointer from the transcript and the composer", async () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const terminal = await createTestRenderer({
    exitOnCtrlC: false,
    height: 32,
    screenMode: "alternate-screen",
    targetFps: 30,
    useThread: false,
    width: 110,
  });
  let resolveThemeMode!: (mode: UiThemeMode) => void;
  terminal.renderer.waitForThemeMode = () => new Promise<UiThemeMode>((resolve) => {
    resolveThemeMode = resolve;
  });
  const copied: string[] = [];
  const options: TuiOptions = {
    locale: "en-US",
    noColor: true,
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    submitPrompt: async () => ({ response: "The token is target_token here." }),
    workspaceDirectory: "/test/workspace",
    writeClipboardText: async (text) => {
      copied.push(text);
    },
  };
  let outcome: Promise<number> | undefined;

  await act(async () => {
    outcome = runTuiWithRenderer(options, terminal.renderer);
    await terminal.renderOnce();
  });

  try {
    await act(async () => {
      await terminal.mockInput.typeText("hello");
      await settle();
      await terminal.renderOnce();
    });
    await act(async () => {
      terminal.mockInput.pressEnter();
      await terminal.renderOnce();
    });
    let rows: string[] = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      await act(async () => {
        await terminal.renderOnce();
      });
      rows = terminal.captureCharFrame().split("\n");
      if (rows.some((line) => line.includes("target_token"))) break;
    }

    const row = rows.findIndex((line) => line.includes("target_token"));
    assert.notEqual(row, -1);
    const column = rows[row].indexOf("target_token") + 8;

    // Releasing the mouse over the app shell copies the current selection.
    await act(async () => {
      await terminal.mockMouse.doubleClick(column, row);
      await settle();
    });
    assert.deepEqual(copied, ["target_token"]);

    // A slow reader gets both clicks of a double click in one stdin chunk;
    // the word must still be selected before the release is dispatched.
    const tokenColumn = rows[row].indexOf("The token") + 6;
    const sgr = (type: "down" | "up") =>
      `\x1b[<0;${tokenColumn + 1};${row + 1}${type === "down" ? "M" : "m"}`;
    await act(async () => {
      terminal.renderer.stdin.emit(
        "data",
        Buffer.from(sgr("down") + sgr("up") + sgr("down") + sgr("up")),
      );
      await settle();
    });
    assert.deepEqual(copied, ["target_token", "token"]);

    await act(async () => {
      await terminal.mockInput.typeText("edit composer_word here");
      await settle();
      await terminal.renderOnce();
    });
    const composer = terminal.captureCharFrame().split("\n");
    const composerRow = composer.findIndex((line) => line.includes("composer_word"));
    assert.notEqual(composerRow, -1);
    const composerColumn = composer[composerRow].indexOf("composer_word") + 10;

    await act(async () => {
      await terminal.mockMouse.doubleClick(composerColumn, composerRow);
      await settle();
      await terminal.renderOnce();
    });
    assert.deepEqual(copied, ["target_token", "token", "composer_word"]);
    assert.match(terminal.captureCharFrame(), /edit composer_word here/);
  } finally {
    await act(async () => {
      resolveThemeMode("dark");
      terminal.renderer.destroy();
    });
    await outcome;
    environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});
