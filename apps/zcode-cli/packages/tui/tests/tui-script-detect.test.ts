import assert from "node:assert/strict";
import test from "node:test";
import {
  detectScriptLanguage,
  fencedBlocks,
  shebangLanguage,
} from "../src/app-script-detect.js";
import { resetScriptDraftForTest, scriptDraft } from "../src/app-script-draft.js";

// Local patch (script-highlight): what of a draft is code. A draft that is a
// script as a whole is told from prose by its lines; prose must stay uncolored.

test("finds the fenced code blocks, including one still being typed", () => {
  const text = "Intro\n```bash\necho one\n```\nbetween\n```python title=x.py\nprint(1)\n```\ntail ``` not a fence\n~~~\nplain fence\n```js\nconst x = 1;\nif (x) {\n";
  const blocks = fencedBlocks(text).map((block) => ({
    code: text.slice(block.start, block.end),
    info: block.info,
    marks: block.marks.map((mark) => text.slice(mark.start, mark.end)),
  }));
  assert.deepEqual(blocks, [
    { code: "echo one\n", info: "bash", marks: ["```bash", "```"] },
    { code: "print(1)\n", info: "python title=x.py", marks: ["```python title=x.py", "```"] },
    // A backtick fence does not close a tilde fence.
    { code: "plain fence\n```js\nconst x = 1;\nif (x) {\n", info: "", marks: ["~~~"] },
  ]);
  // A fence in the middle of a line is none; the last line may be empty.
  assert.deepEqual(fencedBlocks("no fences `inline` here\n```\n"), [
    { end: 28, info: "", marks: [{ end: 27, start: 24 }], start: 28 },
  ]);
  assert.deepEqual(fencedBlocks("only `inline` code\n"), []);
});

test("reads the language of a shebang line", () => {
  assert.equal(shebangLanguage("#!/bin/bash"), "bash");
  assert.equal(shebangLanguage("#!/usr/bin/env python3.12"), "python");
  assert.equal(shebangLanguage("#!/usr/bin/env pwsh"), "powershell");
  assert.equal(shebangLanguage("#!C:\\Program Files\\PowerShell\\7\\pwsh.exe"), "powershell");
  assert.equal(shebangLanguage("#!/usr/bin/node"), "javascript");
  assert.equal(shebangLanguage("echo '#! not a shebang'"), undefined);
  assert.equal(shebangLanguage("#!/usr/bin/something-else"), undefined);
});

test("recognizes a draft that is a script", () => {
  const scripts: Array<[string, string]> = [
    ["#!/bin/bash\nset -euo pipefail\ncd \"$(dirname \"$0\")\"\nnpm ci\n", "bash"],
    ["set -e\ncd build\nnpm ci\nnpm run build 2>&1 | tee log.txt\n", "bash"],
    ["function deploy() {\n  rsync -a dist/ host:/srv/app/\n}\n\ndeploy\n", "bash"],
    ["cd D:\\tmp\nnpm install\nnpm test\n", "bash"],
    ["#!/usr/bin/env python3\nimport sys\nprint(sys.argv)\n", "python"],
    [
      "param([string]$Name)\nWrite-Host \"hello $Name\"\nGet-ChildItem -Path . -Recurse | Where-Object { $_.Name -like '*.log' }\n",
      "powershell",
    ],
    ["npm run build\nGet-Content log.txt -Tail 20\nRemove-Item -Recurse -Force dist\n", "powershell"],
    [
      "import os\nfrom pathlib import Path\n\ndef main(count: int = 3) -> None:\n    print(Path(os.getcwd()), count * 2)\n",
      "python",
    ],
    [
      "import fs from \"node:fs\";\n\nconst out = [];\nfor (const name of fs.readdirSync(\".\")) {\n  out.push(name);\n}\nexport default out;\n",
      "typescript",
    ],
    [
      "interface Options {\n  retries: number;\n}\n\nexport async function run(options: Options): Promise<void> {\n  await fetch(\"https://example.com\");\n}\n",
      "typescript",
    ],
    ["SELECT id, name\nFROM users\nWHERE id = $1 AND name LIKE '%a%';\n", "sql"],
    // SQL does not mind the case.
    ["select id, name from users where id = 1;\nupdate users set name = 'x' where id = 2;\n", "sql"],
    ["{\n  \"name\": \"demo\",\n  \"version\": \"1.0.0\",\n  \"private\": true\n}\n", "json"],
    ["name: demo\n# comment\nitems:\n  - id: 1\n    enabled: true\n", "yaml"],
    ["<?xml version=\"1.0\"?>\n<project>\n  <modelVersion>4.0.0</modelVersion>\n</project>\n", "xml"],
    ["<div class=\"x\">\n  <p>hello</p>\n</div>\n", "html"],
    [
      "package a.b;\n\npublic final class Foo extends Bar {\n  private int x = 1;\n\n  @Override\n  public String run() { return \"s\" + x; }\n}\n",
      "java",
    ],
    ["fun main(args: Array<String>) {\n  val x: Int = 1\n  println(\"hi $x\")\n}\n", "kotlin"],
    ["def x = 1\n// comment\nString s = \"v\"\nif (x == 1) { println s }\n", "groovy"],
    ["package main\n\nimport \"fmt\"\n\nfunc main() {\n  x := 1\n  fmt.Println(\"hi\", x)\n}\n", "go"],
    [
      "fn main() {\n    let mut v: Vec<u8> = Vec::new();\n    v.push(1);\n    println!(\"{:?}\", v);\n}\n",
      "rust",
    ],
    ["#include <stdio.h>\n\nint main(void) {\n  printf(\"hi\\n\");\n  return 0;\n}\n", "c"],
    ["#include <iostream>\n\nint main() {\n  std::cout << \"hi\" << std::endl;\n  return 0;\n}\n", "cpp"],
    ["FROM node:24\nWORKDIR /app\nCOPY . .\nRUN npm ci\nCMD [\"node\", \"server.js\"]\n", "docker"],
    [
      "@echo off\nsetlocal\nset \"NAME=demo\"\nif exist dist (\n  rmdir /s /q dist\n) else (\n  echo no dist\n)\npause\n",
      "bat",
    ],
  ];
  for (const [text, language] of scripts) {
    assert.equal(detectScriptLanguage(text), language, text.split("\n")[0]);
  }
});

test("leaves prose uncolored", () => {
  const prose = [
    "нашёл ещё проблему, что перепутаны темы оформления в идеа.\nНапример, при выводе bash скрипта в консоле IDEA.\nОдна из тем там светлая.\n",
    "Update the config so it works.\nReturn the result when done.\nFind the bug in the script and fix it.\n",
    "The function deploy should run after the build.\nSet the timeout to 30 seconds.\nFind out why export fails.\n",
    "Note: this is important\nTODO: fix the bug later\n",
    "как сделать так, чтобы выделенный участок не пропадал?",
    "npm install",
    "npm install\nnpm test",
    "Запусти set NAME=demo и скажи что вышло\n",
    "Error: ENOENT: no such file or directory, open 'C:\\tmp\\x.txt'\n    at Object.openSync (node:fs:123)\n    at main (D:\\app\\index.js:5)\n",
    "# Title\n\nSome **bold** text.\n\n- item one\n- item two\n",
    // A build file of a kind the detection does not know.
    "build:\n\tnpm run build\n\ntest: build\n\tnpm test\n",
  ];
  for (const text of prose) assert.equal(detectScriptLanguage(text), undefined, text.split("\n")[0]);
});

test("the code of a draft is its fenced blocks, or the whole draft when it is a script", () => {
  resetScriptDraftForTest();
  const fenced = [
    "Look:",
    "```bash",
    "echo one",
    "```",
    "```text",
    "nothing",
    "```",
    "```lsfusion",
    "FORM demo",
    "```",
    "",
  ].join("\n");
  const draft = scriptDraft(fenced);
  // "text" and a language Shiki does not know give no code; the fences are still marked.
  assert.deepEqual(
    draft.regions.map((region) => ({ ...region, code: fenced.slice(region.start, region.end) })),
    [{ code: "echo one\n", end: 23, language: "shellscript", start: 14 }],
  );
  assert.deepEqual(
    draft.fenceMarks.map((mark) => fenced.slice(mark.start, mark.end)),
    ["```bash", "```", "```text", "```", "```lsfusion", "```"],
  );
  // Fence names map like in the responses; JSX and TSX are known to Shiki.
  assert.deepEqual(
    scriptDraft("```jsx\n<a/>\n```\n```ts\nlet x;\n```\n").regions.map((region) => region.language),
    ["jsx", "typescript"],
  );

  const script = "set -e\nnpm ci\n";
  assert.deepEqual(scriptDraft(script), {
    fenceMarks: [],
    regions: [{ end: script.length, language: "bash", start: 0 }],
  });

  // Prose has no code; a long draft is only searched for fenced blocks.
  assert.deepEqual(scriptDraft("Просто текст\nвторая строка"), { fenceMarks: [], regions: [] });
  const long = `${"set -e\n".repeat(5000)}npm ci\n`;
  assert.deepEqual(scriptDraft(long), { fenceMarks: [], regions: [] });

  // The answer of a draft is remembered.
  assert.equal(scriptDraft(script), scriptDraft(script));
});
