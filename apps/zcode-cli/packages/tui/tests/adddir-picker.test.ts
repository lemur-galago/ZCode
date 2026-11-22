import assert from "node:assert/strict";
import test from "node:test";
import {
  createDirectoryPickerGate,
  isDirectoryPickerSupported,
  pickWindowsDirectory,
} from "../src/app-directory-picker.js";

type ExecFileCall = {
  args: string[];
  command: string;
};

function fakeExecFile(output: string, error?: Error) {
  const calls: ExecFileCall[] = [];
  const run = (
    command: string,
    args: string[],
    options: unknown,
    callback: (error: Error | null, stdout: string) => void,
  ) => {
    calls.push({ args, command });
    queueMicrotask(() => callback(error ?? null, output));
  };
  return { calls, run: run as unknown as typeof import("node:child_process").execFile };
}

test("pickWindowsDirectory runs powershell STA with the FolderBrowserDialog script", async () => {
  const { calls, run } = fakeExecFile("D:\\ZCode\\patches");
  const picked = await pickWindowsDirectory(run);
  assert.equal(picked, "D:\\ZCode\\patches");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "powershell.exe");
  const flags = calls[0].args.slice(0, 5);
  assert.deepEqual(flags, ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command"]);
  const script = calls[0].args[5] ?? "";
  assert.match(script, /FolderBrowserDialog/);
  assert.match(script, /SelectedPath/);
});

test("pickWindowsDirectory resolves undefined on cancel (empty stdout)", async () => {
  const { run } = fakeExecFile("");
  assert.equal(await pickWindowsDirectory(run), undefined);
});

test("pickWindowsDirectory rejects on subprocess error", async () => {
  const { run } = fakeExecFile("", new Error("powershell missing"));
  await assert.rejects(() => pickWindowsDirectory(run), /powershell missing/);
});

test("pickWindowsDirectory trims surrounding whitespace from stdout", async () => {
  const { run } = fakeExecFile("  D:\\tmp  \n");
  assert.equal(await pickWindowsDirectory(run), "D:\\tmp");
});

test("isDirectoryPickerSupported matches win32 platform", () => {
  assert.equal(isDirectoryPickerSupported(), process.platform === "win32");
});

test("picker gate runs one operation at a time", async () => {
  const gate = createDirectoryPickerGate();
  assert.equal(gate.isOpen(), false);
  let releaseFirst: (() => void) | undefined;
  const first = gate.run(
    () =>
      new Promise<string>((resolve) => {
        releaseFirst = () => resolve("first");
      }),
  );
  assert.equal(gate.isOpen(), true);
  assert.equal(await gate.run(async () => "second"), undefined);
  releaseFirst?.();
  assert.equal(await first, "first");
  assert.equal(gate.isOpen(), false);
  assert.equal(await gate.run(async () => "third"), "third");
});
