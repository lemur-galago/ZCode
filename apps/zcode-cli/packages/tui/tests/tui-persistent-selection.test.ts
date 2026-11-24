import assert from "node:assert/strict";
import test from "node:test";
import { createTestRenderer } from "@mbears/opentui-core/testing";
import { testRender } from "@mbears/opentui-react/test-utils";
import type { UiThemeMode } from "@zcode/contracts";
import React, { act } from "react";
import { installPersistentSelection } from "../src/app-persistent-selection.js";
import { runTuiWithRenderer } from "../src/tui.js";
import type { TuiOptions } from "../src/types.js";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

// Local patch (persistent-selection): the highlight used to be cleared on every
// mouse-up, right after the copy, so it could not be seen.

test("a selection stays after the mouse is released until it is copied or dismissed", async () => {
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
    const column = rows[row].indexOf("target_token");
    const selectedText = () => terminal.renderer.getSelection()?.getSelectedText() ?? null;

    // Dragging over the word copies it on release, as before, and leaves it selected.
    await act(async () => {
      await terminal.mockMouse.drag(column, row, column + "target_token".length, row);
      await settle();
    });
    assert.deepEqual(copied, ["target_token"]);
    assert.equal(selectedText(), "target_token");

    // Ctrl+C copies the selection again and removes the highlight.
    await act(async () => {
      terminal.mockInput.pressCtrlC();
      await settle();
      await terminal.renderOnce();
    });
    assert.deepEqual(copied, ["target_token", "target_token"]);
    assert.equal(terminal.renderer.hasSelection, false);

    // A double click selects the word and leaves it selected as well.
    await act(async () => {
      await terminal.mockMouse.doubleClick(column + 8, row);
      await settle();
    });
    assert.equal(selectedText(), "target_token");
    assert.deepEqual(copied, ["target_token", "target_token", "target_token"]);

    // A plain press dismisses the selection and copies nothing.
    await act(async () => {
      await terminal.mockMouse.click(column, row);
      await settle();
    });
    assert.equal(terminal.renderer.hasSelection, false);
    assert.equal(copied.length, 3);
  } finally {
    await act(async () => {
      resolveThemeMode("dark");
      terminal.renderer.destroy();
    });
    await outcome;
    environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

test("a press dismisses the selection, also on a control that swallows the mouse event", async () => {
  let view: Awaited<ReturnType<typeof testRender>> | undefined;

  await act(async () => {
    view = await testRender(
      React.createElement(
        "box",
        { style: { border: true } },
        React.createElement("text", { content: "selectable words", key: "label" }),
        React.createElement("text", {
          content: "[control]",
          key: "control",
          onMouseDown: (event: { preventDefault: () => void }) => event.preventDefault(),
          selectable: false,
        }),
      ),
      { height: 6, width: 40 },
    );
    await view.renderOnce();
  });
  // The text is selectable once the first frames have laid it out.
  await act(async () => {
    await settle();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await view?.renderOnce();
  });

  try {
    assert.ok(view);
    const selectedText = () => view.renderer.getSelection()?.getSelectedText() ?? null;

    await act(async () => {
      await view.mockMouse.drag(1, 1, 9, 1);
      await settle();
    });
    assert.equal(selectedText(), "selectab");

    // The control swallows the press, so the renderer alone would keep the selection.
    await act(async () => {
      await view.mockMouse.click(3, 2);
      await settle();
    });
    assert.equal(selectedText(), "selectab");

    const uninstall = installPersistentSelection(view.renderer);
    await act(async () => {
      await view.mockMouse.click(3, 2);
      await settle();
    });
    assert.equal(view.renderer.hasSelection, false);

    // A press without a drag does not leave an empty selection behind either.
    await act(async () => {
      await view.mockMouse.click(5, 1);
      await settle();
    });
    assert.equal(view.renderer.hasSelection, false);
    uninstall();
  } finally {
    await act(async () => {
      view?.renderer.destroy();
    });
  }
});
