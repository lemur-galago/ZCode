import assert from "node:assert/strict";
import test from "node:test";
import { createTestRenderer } from "@mbears/opentui-core/testing";
import type { EditBuffer, Highlight, RGBA } from "@mbears/opentui-core";
import { testRender } from "@mbears/opentui-react/test-utils";
import type { UiThemeMode } from "@zcode/contracts";
import React, { act } from "react";
import {
  applyDraftHighlight,
  scriptScopeStyle,
  scriptSyntaxStyle,
} from "../src/app-composer-highlight.js";
import type { DraftHighlight } from "../src/app-script-draft.js";
import { ScriptText } from "../src/app-script-text.js";
import { MessageRow } from "../src/app-transcript-components.js";
import { runTuiWithRenderer } from "../src/tui.js";
import { DARK_TUI_THEME, LIGHT_TUI_THEME, setActiveTuiThemeMode } from "../src/theme/index.js";
import type { TuiOptions } from "../src/types.js";

// Local patch (script-highlight): the composer colors the fenced blocks of the
// draft and a draft that is a script as a whole; a user message keeps the colors.

type Span = { text: string; fg: RGBA; bg: RGBA };
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const hex = (color: RGBA): string =>
  `#${color
    .toInts()
    .slice(0, 3)
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("")}`;

test("the script scopes take the colors of each theme", () => {
  assert.deepEqual(scriptScopeStyle(LIGHT_TUI_THEME, "comment"), {
    fg: LIGHT_TUI_THEME.syntaxComment,
    italic: true,
  });
  assert.deepEqual(scriptScopeStyle(DARK_TUI_THEME, "string"), { fg: DARK_TUI_THEME.syntaxString });
  assert.deepEqual(scriptScopeStyle(LIGHT_TUI_THEME, "fence"), { fg: LIGHT_TUI_THEME.textMuted });
  assert.equal(scriptScopeStyle(LIGHT_TUI_THEME, "not-a-scope"), undefined);

  const style = scriptSyntaxStyle(LIGHT_TUI_THEME);
  assert.equal(scriptSyntaxStyle(LIGHT_TUI_THEME), style);
  assert.notEqual(scriptSyntaxStyle(DARK_TUI_THEME), style);
  for (const scope of ["boolean", "comment", "fence", "function", "keyword", "number", "string", "type"]) {
    assert.notEqual(style.getStyleId(scope), null, scope);
  }
});

test("the ranges of a draft are applied line by line and replace the previous ones", () => {
  const calls: string[] = [];
  const editBuffer = {
    addHighlight(line: number, highlight: Highlight) {
      calls.push(`add ${line} ${highlight.start}-${highlight.end}`);
    },
    removeHighlightsByRef() {
      calls.push("remove");
    },
  } as unknown as EditBuffer;
  const style = scriptSyntaxStyle(LIGHT_TUI_THEME);
  //        echo "a"      line 0, the newline at 8
  //        /* one        line 1 from 9, the newline at 15
  //        two */        line 2 from 16, the newline at 22
  //        const n = 1;  line 3 from 23
  const text = 'echo "a"\n/* one\ntwo */\nconst n = 1;\n';
  const highlight: DraftHighlight = {
    tokens: [
      { end: 4, scope: "function", start: 0 },
      { end: 8, scope: "string", start: 5 },
      // A block comment across two lines.
      { end: 22, scope: "comment", start: 9 },
      { end: 28, scope: "keyword", start: 23 },
      // A scope the style does not know is skipped.
      { end: 35, scope: "not-a-scope", start: 29 },
    ],
  };

  applyDraftHighlight(editBuffer, text, highlight, style);

  assert.deepEqual(calls, [
    "remove",
    "add 0 0-4",
    "add 0 5-8",
    // "/* one" to the end of line 1, then "two */" on line 2, "const" on line 3.
    "add 1 0-6",
    "add 2 0-6",
    "add 3 0-5",
  ]);

  // Drafts without code only clear what was there.
  calls.length = 0;
  applyDraftHighlight(editBuffer, text, { tokens: [] }, style);
  assert.deepEqual(calls, ["remove"]);
});

test("a user message shows its script in color, prose stays the plain text element", async () => {
  setActiveTuiThemeMode("light");
  let view: Awaited<ReturnType<typeof testRender>> | undefined;
  try {
    await act(async () => {
      view = await testRender(
        React.createElement(MessageRow, {
          index: 0,
          message: {
            content: "#!/bin/bash\nset -e\nnpm ci\necho \"hi\"\n",
            role: "user",
          },
          terminalWidth: 80,
        }),
        { height: 10, width: 80 },
      );
      await view.renderOnce();
    });
    assert.ok(view);
    let spans: Span[] = [];
    for (let attempt = 0; attempt < 160; attempt += 1) {
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        await view.renderOnce();
      });
      spans = view.captureSpans().lines.flatMap((line) => line.spans);
      if (spans.some((span) => span.text === "npm" && hex(span.fg) === LIGHT_TUI_THEME.syntaxFunction)) break;
    }
    /** The color of the span whose trimmed text is this one; undefined when there is none. */
    const colorOf = (text: string): string | undefined => {
      const span = spans.find((candidate) => candidate.text.trim() === text);
      return span && hex(span.fg);
    };
    assert.equal(colorOf("#!/bin/bash"), LIGHT_TUI_THEME.syntaxComment);
    assert.equal(colorOf("set"), LIGHT_TUI_THEME.syntaxKeyword);
    assert.equal(colorOf("npm"), LIGHT_TUI_THEME.syntaxFunction);
    assert.equal(colorOf("ci"), LIGHT_TUI_THEME.syntaxString);
    assert.equal(colorOf("\"hi\""), LIGHT_TUI_THEME.syntaxString);
    // The words between the ranges keep the text color.
    assert.equal(colorOf("-e"), LIGHT_TUI_THEME.text);

    // Prose is the plain text element it always was; a script gets ScriptText.
    const contentElement = (content: string) =>
      React.Children.toArray(MessageRow({ index: 0, message: { content, role: "user" } }).props.children)[0];
    assert.equal(contentElement("Просто текст\nвторая строка").type, "text");
    assert.equal(contentElement("#!/bin/bash\nnpm ci\n").type, ScriptText);
  } finally {
    await act(async () => {
      view?.renderer.destroy();
    });
    setActiveTuiThemeMode("dark");
  }
});

test("the composer colors fenced blocks and scripts as they are typed", async () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const terminal = await createTestRenderer({
    exitOnCtrlC: false,
    height: 40,
    screenMode: "alternate-screen",
    targetFps: 30,
    useThread: false,
    width: 120,
  });
  let resolveThemeMode!: (mode: UiThemeMode) => void;
  terminal.renderer.waitForThemeMode = () => new Promise<UiThemeMode>((resolve) => {
    resolveThemeMode = resolve;
  });
  const options: TuiOptions = {
    locale: "en-US",
    noColor: false,
    // No memory segment in this test.
    readProcessMemory: async () => ({}),
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    submitPrompt: async () => ({ response: "ok" }),
    theme: "light",
    workspaceDirectory: "/test/workspace",
  };
  let outcome: Promise<number> | undefined;

  await act(async () => {
    outcome = runTuiWithRenderer(options, terminal.renderer);
    await terminal.renderOnce();
  });

  const type = async (text: string) => {
    await act(async () => {
      await terminal.mockInput.typeText(text);
    });
  };
  const newLine = async () => {
    await act(async () => {
      terminal.mockInput.pressKey("j", { ctrl: true });
    });
  };
  const clearDraft = async () => {
    await act(async () => {
      terminal.mockInput.pressCtrlC();
      await settle();
    });
  };
  /**
   * The colors of the frame by trimmed span text, once the span `text` has the
   * `color`; an empty map when that does not happen in time.
   */
  const frameColors = async (text: string, color: string): Promise<Map<string, string>> => {
    for (let attempt = 0; attempt < 160; attempt += 1) {
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        await terminal.renderOnce();
      });
      const spans = terminal.captureSpans().lines.flatMap((line) => line.spans);
      if (!spans.some((span) => span.text.trim() === text && hex(span.fg) === color)) continue;
      const colors = new Map<string, string>();
      for (const span of spans) {
        const key = span.text.trim();
        if (key) colors.set(key, hex(span.fg));
      }
      return colors;
    }
    return new Map();
  };

  try {
    const theme = LIGHT_TUI_THEME;

    // A fenced block: the fences are muted, the code inside is colored.
    await type("```bash");
    await newLine();
    await type('echo "hello" # note');
    await newLine();
    await type("npm ci");
    const fenced = await frameColors("echo", theme.syntaxFunction);
    assert.equal(fenced.get("echo"), theme.syntaxFunction);
    assert.equal(fenced.get('"hello"'), theme.syntaxString);
    assert.equal(fenced.get("# note"), theme.syntaxComment);
    assert.equal(fenced.get("```bash"), theme.textMuted);

    // A script without fences.
    await clearDraft();
    await type("set -euo pipefail");
    await newLine();
    await type("npm ci");
    await newLine();
    await type('echo "done $PWD"');
    const script = await frameColors("set", theme.syntaxKeyword);
    assert.equal(script.get("set"), theme.syntaxKeyword);
    assert.equal(script.get("npm"), theme.syntaxFunction);
    assert.equal(script.get("ci"), theme.syntaxString);
    assert.equal(script.get('"done'), theme.syntaxString);

    // Prose keeps one color.
    await clearDraft();
    await type("Проверка подсветки в поле ввода");
    await newLine();
    await type("вторая строка текста без кода");
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      await terminal.renderOnce();
    });
    const proseRow = terminal.captureCharFrame().split("\n").findIndex((line) => line.includes("Проверка"));
    const proseColors = new Set(
      (terminal.captureSpans().lines[proseRow]?.spans ?? [])
        .filter((span) => /[А-я]/u.test(span.text))
        .map((span) => hex(span.fg)),
    );
    assert.deepEqual([...proseColors], [theme.text]);

    // Clearing the draft leaves no highlights behind.
    await clearDraft();
    await act(async () => {
      await terminal.renderOnce();
    });
    assert.equal(terminal.captureCharFrame().includes("Проверка"), false);
  } finally {
    await act(async () => {
      resolveThemeMode("light");
      terminal.renderer.destroy();
    });
    await outcome;
    environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    setActiveTuiThemeMode("dark");
  }
});
