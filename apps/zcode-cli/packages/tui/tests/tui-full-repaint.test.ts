import assert from "node:assert/strict";
import test from "node:test";
import { createTestRenderer } from "@mbears/opentui-core/testing";
import type { UiThemeMode } from "@zcode/contracts";
import { act } from "react";
import { runTuiWithRenderer } from "../src/tui.js";
import type { TuiOptions } from "../src/types.js";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

type ActEnvironment = { IS_REACT_ACT_ENVIRONMENT?: boolean };
type Frame = { cells: number };

const WIDTH = 100;
const HEIGHT = 24;

// Local patch (ctrl-l-full-repaint): the renderer writes only the cells that
// changed since its previous frame. Whatever the terminal loses meanwhile - a
// cleared screen, a buffer it rebuilt - stays lost until a resize, and the
// interface is a ghost of itself: no sidebar, no composer frame, only the
// cells that changed after the loss. Ctrl+L asks the renderer for a frame of
// every cell.

test("Ctrl+L repaints every cell of the terminal and leaves the draft alone", async () => {
  const app = await startApp();
  try {
    await app.type("draft");
    // Nothing changed since the previous frame: a frame in place writes no cell.
    assert.equal((await app.frame()).cells, 0);

    // Ctrl+L: one frame of every cell of the terminal, and no more after it.
    assert.equal((await app.key("l", { ctrl: true })).cells, WIDTH * HEIGHT);
    assert.equal(app.repaints(), 1);
    assert.equal((await app.frame()).cells, 0);
    assert.equal(app.repaints(), 1);

    // The key is not a letter of the composer: the draft is as it was.
    await app.key("\r");
    assert.deepEqual(app.submitted, ["draft"]);
  } finally {
    await app.close();
  }
});

test("a plain L is a letter and repaints nothing", async () => {
  const app = await startApp();
  try {
    const letter = (await app.key("l")).cells;
    assert.ok(letter > 0 && letter < (WIDTH * HEIGHT) / 10, `a letter wrote ${letter} cells`);
    await app.key("\r");
    assert.deepEqual(app.submitted, ["l"]);
    assert.equal(app.repaints(), 0);
  } finally {
    await app.close();
  }
});

test("Ctrl+L also repaints while a selection is open, and keeps it", async () => {
  const app = await startApp();
  try {
    await app.selectResponseWord();
    assert.equal(app.selectedText(), "target_token");

    assert.equal((await app.key("l", { ctrl: true })).cells, WIDTH * HEIGHT);
    assert.equal(app.selectedText(), "target_token");
  } finally {
    await app.close();
  }
});

async function startApp(): Promise<{
  close: () => Promise<void>;
  frame: () => Promise<Frame>;
  key: (key: string, modifiers?: { ctrl?: boolean }) => Promise<Frame>;
  repaints: () => number;
  selectResponseWord: () => Promise<void>;
  selectedText: () => string | null;
  submitted: string[];
  type: (text: string) => Promise<void>;
}> {
  const environment = globalThis as typeof globalThis & ActEnvironment;
  const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const terminal = await createTestRenderer({
    exitOnCtrlC: false,
    height: HEIGHT,
    screenMode: "alternate-screen",
    targetFps: 30,
    useThread: false,
    width: WIDTH,
  });
  let resolveThemeMode!: (mode: UiThemeMode) => void;
  terminal.renderer.waitForThemeMode = () => new Promise<UiThemeMode>((resolve) => {
    resolveThemeMode = resolve;
  });
  const requestRepaint = terminal.renderer.requestFullRepaintRender.bind(terminal.renderer);
  let repaints = 0;
  terminal.renderer.requestFullRepaintRender = () => {
    repaints += 1;
    requestRepaint();
  };
  // What the renderer wrote since the last count: every frame adds its cells.
  let written = 0;
  const frameWriter = terminal.renderer as unknown as { renderNative(): void };
  const renderNative = frameWriter.renderNative.bind(frameWriter);
  frameWriter.renderNative = () => {
    renderNative();
    written += terminal.getNativeStats().cellsUpdated;
  };
  const submitted: string[] = [];
  const options: TuiOptions = {
    locale: "en-US",
    noColor: true,
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    submitPrompt: async (input) => {
      submitted.push(typeof input === "string" ? input : input.text);
      return { response: "The token is target_token here." };
    },
    workspaceDirectory: "/test/workspace",
    // With somewhere to copy to, the selection stays after the mouse is released.
    writeClipboardText: async () => undefined,
  };
  let outcome: Promise<number> | undefined;

  await act(async () => {
    outcome = runTuiWithRenderer(options, terminal.renderer);
    await terminal.renderOnce();
  });
  // Asked for a frame, the renderer renders it itself, on the next tick or
  // after a timer. The cells of a frame still in flight must not be lost, so
  // every count waits for the renderer to come to rest.
  const rest = async (): Promise<void> => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const state = terminal.renderer.getSchedulerState();
      if (!state.isRunning && !state.isRendering && !state.hasScheduledRender) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("the renderer did not come to rest");
  };
  // What the next frame wrote: the frame after the interface came to rest.
  const frame = async (): Promise<Frame> => {
    await act(async () => {
      await rest();
      written = 0;
      await terminal.renderOnce();
    });
    return { cells: written };
  };
  // What the frames caused by the action wrote, the next one and any the
  // renderer rendered itself before it.
  const frameOf = async (action: () => unknown | Promise<unknown>): Promise<Frame> => {
    await act(async () => {
      await rest();
      written = 0;
      await action();
      await rest();
      await terminal.renderOnce();
    });
    return { cells: written };
  };

  return {
    close: async () => {
      await act(async () => {
        resolveThemeMode("dark");
        terminal.renderer.destroy();
      });
      await outcome;
      environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    },
    frame,
    key: (key, modifiers) => frameOf(() => terminal.mockInput.pressKey(key, modifiers)),
    repaints: () => repaints,
    selectResponseWord: async () => {
      await act(async () => {
        terminal.mockInput.typeText("hello");
        await settle();
        terminal.mockInput.pressEnter();
        await frame();
      });
      let rows: string[] = [];
      for (let attempt = 0; attempt < 40 && !rows.some((line) => line.includes("target_token")); attempt += 1) {
        await act(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
          await terminal.renderOnce();
        });
        rows = terminal.captureCharFrame().split("\n");
      }
      const row = rows.findIndex((line) => line.includes("target_token"));
      assert.notEqual(row, -1, "the response is on screen");
      const column = rows[row].indexOf("target_token");
      await act(async () => {
        await terminal.mockMouse.drag(column, row, column + "target_token".length, row);
        await settle();
      });
    },
    selectedText: () => terminal.renderer.getSelection()?.getSelectedText() ?? null,
    submitted,
    type: (text) => frameOf(() => terminal.mockInput.typeText(text)),
  };
}
