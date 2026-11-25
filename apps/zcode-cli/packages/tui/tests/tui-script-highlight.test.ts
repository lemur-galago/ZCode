import assert from "node:assert/strict";
import test from "node:test";
import { createTestRenderer } from "@mbears/opentui-core/testing";
import { testRender } from "@mbears/opentui-react/test-utils";
import React, { act } from "react";
import { createMarkdownSyntaxStyle } from "../src/app-markdown-theme.js";
import {
  resetScriptHighlightForTest,
  scriptHighlightClient,
  shikiLanguageId,
  themeScopeOf,
  tokenizeScript,
  tokenizeScriptSync,
} from "../src/app-script-highlight.js";
import { MessageRow } from "../src/app-transcript-components.js";
import { DARK_TUI_THEME, LIGHT_TUI_THEME, setActiveTuiThemeMode } from "../src/theme/index.js";
import type { RGBA } from "@mbears/opentui-core";

// Local patch (script-highlight): fenced blocks in languages without a bundled
// tree-sitter grammar (bash, python, powershell, ...) are colored by Shiki.

type Span = { text: string; fg: RGBA; bg: RGBA };
type View = Awaited<ReturnType<typeof testRender>> & {
  captureSpans(): { lines: Array<{ spans: Span[] }> };
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const hex = (color: RGBA): string =>
  `#${color
    .toInts()
    .slice(0, 3)
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("")}`;

const CONTENT = [
  "```bash",
  'echo "hello world" # note',
  "```",
  "",
  "```python",
  "def main(count: int = 3) -> None:",
  '    print("ok", count)',
  "```",
  "",
  "```jsx",
  'const el = <div className="x">hi</div>;',
  "```",
  "",
  "```javascript",
  'const x = "s";',
  "```",
].join("\n");

test("maps fence names and filetypes to Shiki languages", () => {
  assert.equal(shikiLanguageId("bash"), "shellscript");
  assert.equal(shikiLanguageId("sh"), "shellscript");
  assert.equal(shikiLanguageId("console"), "shellsession");
  assert.equal(shikiLanguageId("PowerShell"), "powershell");
  assert.equal(shikiLanguageId("py"), "python");
  // Filetypes OpenTUI derives: JSX and TSX had no parser at all.
  assert.equal(shikiLanguageId("javascriptreact"), "jsx");
  assert.equal(shikiLanguageId("typescriptreact"), "tsx");
  assert.equal(shikiLanguageId("makefile"), "make");
  // A fence named "cmd" is a batch file, not Shiki's alias of Visual Basic.
  assert.equal(shikiLanguageId("cmd"), "bat");
  // Local patch (lsfusion-highlight): Shiki has no lsFusion grammar, the TUI carries its own.
  assert.equal(shikiLanguageId("lsfusion"), "lsfusion");
  assert.equal(shikiLanguageId("lsf"), "lsfusion");
  assert.equal(shikiLanguageId(" .LSF "), "lsfusion");
  assert.equal(shikiLanguageId("ls-fusion"), undefined);
  assert.equal(shikiLanguageId(""), undefined);
  assert.equal(shikiLanguageId("  .PY "), "python");
});

test("reduces Textmate scopes to the scopes the theme styles", () => {
  const scopeOf = (...scopeNames: string[]) => themeScopeOf(scopeNames);
  assert.equal(scopeOf("source.shell", "support.function.builtin.shell"), "function");
  assert.equal(scopeOf("source.shell", "entity.name.command.shell"), "function");
  assert.equal(scopeOf("source.shell", "string.quoted.double.shell"), "string");
  assert.equal(scopeOf("source.shell", "punctuation.definition.string.begin.shell"), "string");
  assert.equal(scopeOf("source.shell", "comment.line.number-sign.shell"), "comment");
  assert.equal(scopeOf("source.shell", "punctuation.definition.comment.shell"), "comment");
  assert.equal(scopeOf("source.shell", "keyword.operator.pipe.shell"), undefined);
  assert.equal(scopeOf("source.shell", "variable.other.normal.shell"), undefined);
  assert.equal(scopeOf("source.python", "storage.type.function.python"), "keyword");
  assert.equal(scopeOf("source.python", "keyword.control.import.python"), "keyword");
  assert.equal(scopeOf("source.python", "constant.numeric.dec.python"), "number");
  assert.equal(scopeOf("source.python", "constant.language.python"), "boolean");
  assert.equal(scopeOf("source.python", "support.type.python"), "type");
  assert.equal(scopeOf("source.js", "storage.type.js"), "keyword");
  assert.equal(scopeOf("source.js", "storage.type.js.jsx"), "keyword");
  assert.equal(scopeOf("source.js", "storage.type.class.js"), "keyword");
  assert.equal(scopeOf("source.java", "storage.type.primitive.java"), "type");
  assert.equal(scopeOf("source.java", "storage.modifier.java"), "keyword");
  assert.equal(scopeOf("source.java", "entity.name.type.class.java"), "type");
  assert.equal(scopeOf("source.java", "entity.other.inherited-class.java"), "type");
  assert.equal(scopeOf("text.html.basic", "entity.name.tag.html"), "type");
  assert.equal(scopeOf("source.diff", "markup.inserted.diff"), "diff.plus");
  assert.equal(scopeOf("source.diff", "markup.deleted.diff"), "diff.minus");
  assert.equal(scopeOf("source.shell", "invalid.illegal.shell"), "error");
  // Containers and the language alone say nothing.
  assert.equal(scopeOf("source.shell"), undefined);
  assert.equal(scopeOf("source.shell", "meta.statement.shell"), undefined);
  assert.equal(scopeOf(), undefined);
});

test("reports the styled ranges of a script with offsets from the start of the code", async () => {
  resetScriptHighlightForTest();
  const code = 'echo "hi" # c\nls -la\n';
  // Nothing is loaded before the first script of a language went through.
  assert.equal(tokenizeScriptSync(code, "shellscript"), undefined);

  const tokens = await tokenizeScript(code, "shellscript");
  const range = (text: string) => {
    const start = code.indexOf(text);
    return tokens.find((token) => token.start === start);
  };
  // The first line starts at 0; the second one at 14, after the newline.
  assert.deepEqual(range("echo"), { end: 4, scope: "function", start: 0 });
  assert.deepEqual(range('"hi"'), { end: 9, scope: "string", start: 5 });
  assert.deepEqual(range("# c"), { end: 13, scope: "comment", start: 10 });
  assert.deepEqual(range("ls"), { end: 16, scope: "function", start: 14 });
  // The option behind it has no styled scope.
  assert.equal(tokens.some((token) => token.start >= 16), false);
  // Every range is inside the code and carries a styled scope.
  for (const token of tokens) {
    assert.ok(token.start < token.end && token.end <= code.length);
    assert.notEqual(token.scope, undefined);
  }

  // Now that the language is loaded, the same code is answered at once.
  assert.deepEqual(tokenizeScriptSync(code, "shellscript"), tokens);
  resetScriptHighlightForTest();
});

test("a long block is tokenized once it stops changing", async () => {
  resetScriptHighlightForTest();
  const code = 'echo "x"\n'.repeat(2000);
  const grown = `${code}echo "y"\n`;

  const overtaken = tokenizeScript(code, "bash");
  const latest = tokenizeScript(grown, "bash");
  // The request that was overtaken gets no ranges, and nothing is tokenized yet.
  assert.deepEqual(await overtaken, []);
  // A block that is already in the cache is answered synchronously; this one is not.
  assert.equal(tokenizeScriptSync(grown, "bash"), undefined);

  const tokens = await latest;
  assert.ok(tokens.some((token) => token.scope === "function"));
  assert.ok(tokens.at(-1).end > code.length, "the last line is styled too");
  // The block that stopped changing is answered from the cache at once.
  assert.deepEqual(tokenizeScriptSync(grown, "bash"), tokens);
  resetScriptHighlightForTest();
});

test("the client highlights what tree-sitter has no grammar for and leaves the rest", async () => {
  resetScriptHighlightForTest();
  const client = scriptHighlightClient();
  assert.equal(scriptHighlightClient(), client);

  const bash = await client.highlightOnce('echo "x"\n', "bash");
  assert.deepEqual(bash.highlights?.map(([start, end, scope]) => [start, end, scope]), [
    [0, 4, "function"],
    [5, 8, "string"],
  ]);

  // The four bundled grammars keep their tree-sitter highlighting.
  const javascript = await client.highlightOnce('const x = "s";\n', "javascript");
  assert.ok(javascript.highlights?.some(([, , scope]) => scope === "keyword"));

  // A language Shiki does not know gets the answer of the base client.
  const unknown = await client.highlightOnce("echo x\n", "nope-lang");
  assert.equal(unknown.highlights, undefined);

  // Everything else is the base client.
  assert.equal(typeof client.isInitialized, "function");
  assert.equal(typeof client.isInitialized(), "boolean");
  resetScriptHighlightForTest();
});

test("the client follows the base client through a renderer restart", async () => {
  // OpenTUI disposes its tree-sitter client together with the renderer and
  // creates a new one on the next request; the client must not hold the old one.
  resetScriptHighlightForTest();
  const client = scriptHighlightClient();
  for (let round = 0; round < 2; round += 1) {
    const renderer = await createTestRenderer({ exitOnCtrlC: false, height: 6, width: 40 });
    await act(async () => {
      await renderer.renderOnce();
      renderer.renderer.destroy();
    });
    const bash = await client.highlightOnce('echo "x"\n', "bash");
    assert.ok(bash.highlights?.some(([, , scope]) => scope === "function"), `round ${round}: bash`);
    const javascript = await client.highlightOnce('const x = "s";\n', "javascript");
    assert.ok(javascript.highlights?.some(([, , scope]) => scope === "keyword"), `round ${round}: javascript`);
  }
  resetScriptHighlightForTest();
});

async function renderMessage(
  theme: typeof LIGHT_TUI_THEME,
  content = CONTENT,
  // Shiki answers for its blocks, tree-sitter in its worker for the JavaScript one.
  settled: (view: View) => boolean = (view) =>
    Boolean(coloredSpan(view, "echo", theme.syntaxFunction) && coloredSpan(view, '"s"', theme.syntaxString)),
): Promise<View> {
  let view: View | undefined;
  await act(async () => {
    view = (await testRender(
      React.createElement(MessageRow, {
        index: 0,
        message: { content, role: "agent" },
        terminalWidth: 90,
      }),
      { height: 30, width: 90 },
    )) as View;
  });
  assert.ok(view);
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await act(async () => {
      await sleep(25);
      await view.renderOnce();
    });
    if (settled(view)) break;
  }
  return view;
}

// Local patch (lsfusion-highlight): the one grammar that does not come with Shiki.
const LSFUSION = [
  "MODULE hr;",
  "CLASS Employee; // staff",
  "salary = DATA NUMERIC[14,2] (Employee);",
  "greeting (Employee e) = 'Hello, ${name(e)}';",
].join("\n");

test("an lsFusion script is styled by the grammar the TUI carries", async () => {
  resetScriptHighlightForTest();
  const tokens = await tokenizeScript(LSFUSION, "lsfusion");
  /** The scope and the text of the range that starts where this text does. */
  const rangeAt = (text: string, from = 0): string[] | undefined => {
    const start = LSFUSION.indexOf(text, from);
    const token = tokens.find((candidate) => candidate.start === start);
    return token && [token.scope, LSFUSION.slice(token.start, token.end)];
  };
  assert.deepEqual(rangeAt("MODULE"), ["keyword", "MODULE"]);
  assert.deepEqual(rangeAt("CLASS"), ["keyword", "CLASS"]);
  assert.deepEqual(rangeAt("Employee"), ["type", "Employee"]);
  assert.deepEqual(rangeAt("// staff"), ["comment", "// staff"]);
  assert.deepEqual(rangeAt("DATA"), ["keyword", "DATA"]);
  assert.deepEqual(rangeAt("NUMERIC"), ["type", "NUMERIC"]);
  assert.deepEqual(rangeAt("14"), ["number", "14"]);
  assert.deepEqual(rangeAt("salary"), ["function", "salary"]);
  assert.deepEqual(rangeAt("greeting"), ["function", "greeting"]);
  // The interpolated call keeps its own color inside the string.
  assert.deepEqual(rangeAt("'Hello, "), ["string", "'Hello, "]);
  assert.deepEqual(rangeAt("name("), ["function", "name"]);
  // The module name, the parameters and the operators are not styled.
  assert.equal(rangeAt("hr"), undefined);
  assert.equal(rangeAt(" e)"), undefined);
  assert.equal(rangeAt("= DATA"), undefined);

  // The answer is remembered, and the fence name and the filetype lead to it too.
  assert.deepEqual(tokenizeScriptSync(LSFUSION, "lsfusion"), tokens);
  const client = scriptHighlightClient();
  const block = await client.highlightOnce("CLASS Employee;\n", "lsf");
  assert.deepEqual(
    block.highlights?.map(([start, end, scope]) => [start, end, scope]),
    [
      [0, 5, "keyword"],
      [6, 14, "type"],
    ],
  );
  resetScriptHighlightForTest();
});

test("an lsf block takes the theme colors in a message", async () => {
  const content = ["```lsf", ...LSFUSION.split("\n"), "```"].join("\n");
  for (const theme of [LIGHT_TUI_THEME, DARK_TUI_THEME]) {
    resetScriptHighlightForTest();
    setActiveTuiThemeMode(theme.mode);
    const view = await renderMessage(theme, content, (frame) =>
      Boolean(coloredSpan(frame, "MODULE", theme.syntaxKeyword) && coloredSpan(frame, "salary", theme.syntaxFunction)),
    );
    try {
      assert.ok(coloredSpan(view, "MODULE", theme.syntaxKeyword), "module");
      assert.ok(coloredSpan(view, "CLASS", theme.syntaxKeyword), "class");
      assert.ok(coloredSpan(view, "// staff", theme.syntaxComment), "comment");
      assert.ok(coloredSpan(view, "DATA", theme.syntaxKeyword), "data");
      assert.ok(coloredSpan(view, "NUMERIC", theme.syntaxType), "type");
      assert.ok(coloredSpan(view, "Employee", theme.syntaxType), "class name");
      assert.ok(coloredSpan(view, "14", theme.syntaxNumber), "number");
      assert.ok(coloredSpan(view, "salary", theme.syntaxFunction), "property");
      assert.ok(coloredSpan(view, "'Hello, ", theme.syntaxString), "string");
      assert.ok(coloredSpan(view, "name", theme.syntaxFunction), "call in the string");
    } finally {
      await act(async () => {
        view.renderer.destroy();
      });
      setActiveTuiThemeMode("dark");
    }
  }
});

function coloredSpan(view: View, needle: string, color: string): Span | undefined {
  return view
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((span) => span.text === needle && hex(span.fg) === color);
}

test("fenced blocks of every bundled Shiki language take the theme colors", async () => {
  for (const theme of [LIGHT_TUI_THEME, DARK_TUI_THEME]) {
    resetScriptHighlightForTest();
    setActiveTuiThemeMode(theme.mode);
    const view = await renderMessage(theme);
    try {
      // bash through Shiki
      assert.ok(coloredSpan(view, "echo", theme.syntaxFunction), "bash command");
      assert.ok(coloredSpan(view, '"hello world"', theme.syntaxString), "bash string");
      assert.ok(coloredSpan(view, "# note", theme.syntaxComment), "bash comment");
      // python through Shiki
      assert.ok(coloredSpan(view, "def", theme.syntaxKeyword), "def");
      assert.ok(coloredSpan(view, "int", theme.syntaxType), "type");
      assert.ok(coloredSpan(view, "3", theme.syntaxNumber), "number");
      assert.ok(coloredSpan(view, "None", theme.syntaxNumber), "None");
      // jsx through Shiki
      assert.ok(coloredSpan(view, "const", theme.syntaxKeyword), "jsx const");
      assert.ok(coloredSpan(view, '"x"', theme.syntaxString), "jsx string");
      // javascript keeps tree-sitter
      assert.ok(coloredSpan(view, "const", theme.syntaxKeyword), "javascript const");
      assert.ok(coloredSpan(view, '"s"', theme.syntaxString), "javascript string");
    } finally {
      await act(async () => {
        view.renderer.destroy();
      });
      setActiveTuiThemeMode("dark");
    }
  }
});

test("without the client a bash block is one plain span", async () => {
  // Documents the defect the patch fixes: OpenTUI has no bash grammar.
  resetScriptHighlightForTest();
  let view: View | undefined;
  await act(async () => {
    view = (await testRender(
      React.createElement("markdown", {
        content: '```bash\necho "hello world"\n```\n',
        syntaxStyle: createMarkdownSyntaxStyle(DARK_TUI_THEME),
      }),
      { height: 10, width: 60 },
    )) as View;
  });
  try {
    assert.ok(view);
    let spans: Span[] = [];
    for (let attempt = 0; attempt < 120 && spans.length === 0; attempt += 1) {
      await act(async () => {
        await sleep(25);
        await view.renderOnce();
      });
      spans = view
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .filter((span) => span.text.trim().length > 0);
    }
    assert.deepEqual(
      spans.map((span) => [span.text.trimEnd(), hex(span.fg)]),
      [['echo "hello world"', "#ffffff"]],
    );
  } finally {
    await act(async () => {
      view?.renderer.destroy();
    });
  }
  resetScriptHighlightForTest();
});
