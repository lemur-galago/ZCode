import assert from "node:assert/strict";
import test from "node:test";
import { createTestRenderer } from "@mbears/opentui-core/testing";
import type { UiThemeMode } from "@zcode/contracts";
import React, { act } from "react";
import { PROMPT_TEXTAREA_KEY_BINDINGS } from "../src/app-input-pane.js";
import { runTuiWithRenderer } from "../src/tui.js";
import type { TuiOptions } from "../src/types.js";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

type ActEnvironment = { IS_REACT_ACT_ENVIRONMENT?: boolean };

// Local patch (composer-select-all): OpenTUI binds Ctrl+A to the emacs "start
// of the line" and selects the whole buffer only on Cmd+A, which no Windows or
// Linux terminal has. Ctrl+A followed by Ctrl+C therefore used to wipe the
// draft: nothing was selected, so Ctrl+C fell through to "clear the draft".

test("the composer binds Ctrl+A to select-all instead of the line start", () => {
  const binding = PROMPT_TEXTAREA_KEY_BINDINGS.find((entry) => entry.name === "a" && entry.ctrl);

  assert.deepEqual(binding, { name: "a", ctrl: true, action: "select-all" });
});

test("Ctrl+A selects the unsent draft, Ctrl+C copies it and keeps the draft", async () => {
  const app = await startComposer();

  try {
    await app.type("first line");
    await app.key("\n");
    await app.type("second line");

    // Ctrl+A selects the whole draft, the line with the cursor included.
    await app.key("a", { ctrl: true });
    assert.equal(app.selectedText(), "first line\nsecond line");
    assert.deepEqual(app.copied, []);

    // Ctrl+C copies it: the draft stays in the composer, the highlight is gone.
    await app.ctrlC();
    assert.deepEqual(app.copied, ["first line\nsecond line"]);
    assert.equal(app.terminal.renderer.hasSelection, false);

    await app.type("!");
    await app.key("\r");
    assert.deepEqual(app.submitted, ["first line\nsecond line!"]);
  } finally {
    await app.close();
  }
});

test("typing over a select-all selection replaces the draft", async () => {
  const app = await startComposer();

  try {
    await app.type("old draft");
    await app.key("a", { ctrl: true });
    await app.type("new");
    await app.key("\r");
    assert.deepEqual(app.submitted, ["new"]);
  } finally {
    await app.close();
  }
});

test("Ctrl+A on an empty draft has nothing to copy and leaves Ctrl+C as it was", async () => {
  const app = await startComposer();

  try {
    await app.key("a", { ctrl: true });
    assert.equal(app.selectedText(), "");

    // Nothing is selected, so Ctrl+C does not take the copy branch.
    await app.ctrlC();
    assert.deepEqual(app.copied, []);
  } finally {
    await app.close();
  }
});

async function startComposer(): Promise<{
  close: () => Promise<void>;
  copied: string[];
  ctrlC: () => Promise<void>;
  key: (key: string, modifiers?: { ctrl?: boolean }) => Promise<void>;
  selectedText: () => string | null;
  submitted: string[];
  terminal: Awaited<ReturnType<typeof createTestRenderer>>;
  type: (text: string) => Promise<void>;
}> {
  const environment = globalThis as typeof globalThis & ActEnvironment;
  const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const terminal = await createTestRenderer({
    exitOnCtrlC: false,
    height: 24,
    screenMode: "alternate-screen",
    targetFps: 30,
    useThread: false,
    width: 100,
  });
  let resolveThemeMode!: (mode: UiThemeMode) => void;
  terminal.renderer.waitForThemeMode = () => new Promise<UiThemeMode>((resolve) => {
    resolveThemeMode = resolve;
  });
  const copied: string[] = [];
  const submitted: string[] = [];
  const options: TuiOptions = {
    locale: "en-US",
    noColor: true,
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    submitPrompt: async (input) => {
      submitted.push(typeof input === "string" ? input : input.text);
      return { response: "done" };
    },
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

  const flush = async () => {
    await act(async () => {
      await settle();
      await terminal.renderOnce();
    });
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
    copied,
    ctrlC: async () => {
      await act(async () => {
        terminal.mockInput.pressCtrlC();
        await settle();
        await terminal.renderOnce();
      });
    },
    key: async (key, modifiers) => {
      await act(async () => {
        terminal.mockInput.pressKey(key, modifiers);
        await settle();
        await terminal.renderOnce();
      });
    },
    selectedText: () => terminal.renderer.getSelection()?.getSelectedText() ?? null,
    submitted,
    terminal,
    type: async (text) => {
      await act(async () => {
        await terminal.mockInput.typeText(text);
        await settle();
        await terminal.renderOnce();
      });
    },
  };
}
