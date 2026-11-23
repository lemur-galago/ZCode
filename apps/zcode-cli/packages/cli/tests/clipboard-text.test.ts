import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { createNodeClipboardTextWriter } from "../src/clipboard-text.js";

// Runs the command in a real PowerShell with Set-Clipboard shadowed by a
// function that prints its argument as UTF-16 code units, so the real
// clipboard is never touched.
async function runShadowedClipboardCommand(args: string[], input: string): Promise<string> {
  const shadow =
    "function Set-Clipboard { param($Value) ($Value.ToCharArray() | " +
    "ForEach-Object { '{0:X4}' -f [int]$_ }) -join ' ' }";
  return await new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [...args.slice(0, -1), `${shadow}; ${args.at(-1)}`], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("ascii");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode !== 0) {
        reject(new Error(`powershell.exe exited with code ${exitCode}`));
        return;
      }
      resolve(
        output
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((unit) => String.fromCharCode(Number.parseInt(unit, 16)))
          .join(""),
      );
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

type CapturedWriteStream = {
  output: () => string;
  write: (chunk: string) => boolean;
};

const createWriteStream = (): CapturedWriteStream => {
  let output = "";

  return {
    output: () => output,
    write: (chunk: string): boolean => {
      output += chunk;
      return true;
    },
  };
};

test("text clipboard writer emits OSC 52 and falls back to native commands", async () => {
  const stdout = createWriteStream();
  const attemptedCommands: string[] = [];
  const writer = createNodeClipboardTextWriter({
    platform: "linux",
    runCommand: async (file, _args, options) => {
      attemptedCommands.push(`${file}:${options.input}`);
      return { exitCode: -1 };
    },
    stdout,
  });

  await writer("hello");

  assert.equal(stdout.output(), "\x1b]52;c;aGVsbG8=\x07");
  assert.deepEqual(attemptedCommands, ["wl-copy:hello", "xclip:hello", "xsel:hello"]);
});

test("text clipboard writer can use native clipboard without stdout", async () => {
  let copiedInput = "";
  const writer = createNodeClipboardTextWriter({
    platform: "darwin",
    runCommand: async (file, args, options) => {
      assert.equal(file, "pbcopy");
      assert.deepEqual(args, []);
      copiedInput = options.input;
      return { exitCode: 0 };
    },
  });

  await writer("from native");

  assert.equal(copiedInput, "from native");
});

test(
  "Windows clipboard command keeps non-ASCII text intact",
  { skip: process.platform !== "win32" },
  async () => {
    const text = "весь набор TUI — целиком";
    let pasted = "";
    const writer = createNodeClipboardTextWriter({
      platform: "win32",
      runCommand: async (file, args, options) => {
        assert.equal(file, "powershell.exe");
        pasted = await runShadowedClipboardCommand(args, options.input);
        return { exitCode: 0 };
      },
    });

    await writer(text);

    assert.equal(pasted, text);
  },
);
