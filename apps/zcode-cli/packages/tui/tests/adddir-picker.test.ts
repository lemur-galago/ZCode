import assert from "node:assert/strict";
import test from "node:test";
import type { OutputMarkers } from "../src/app-marked-output.js";
import {
  createDirectoryPickerGate,
  isDirectoryPickerSupported,
  pickWindowsDirectory,
} from "../src/app-directory-picker.js";

type ExecFileCall = {
  args: string[];
  command: string;
};

const MARKERS: OutputMarkers = { close: "<<end>>", open: "<<begin>>" };
// Local patch (marked-output): what an injected hooking DLL (mhook) adds to
// the output of every process on some machines. The picker used to take it
// for the chosen folder, so a cancel submitted `/adddir` of these lines.
const NOISE = "[0x7FFDFF84B830] ANOMALY: meaningless REX prefix used\r\n";

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
  const { calls, run } = fakeExecFile(`${MARKERS.open}D:\\ZCode\\patches${MARKERS.close}`);
  const picked = await pickWindowsDirectory(run, MARKERS);
  assert.equal(picked, "D:\\ZCode\\patches");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "powershell.exe");
  const flags = calls[0].args.slice(0, 5);
  assert.deepEqual(flags, ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command"]);
  const script = calls[0].args[5] ?? "";
  assert.match(script, /FolderBrowserDialog/);
  assert.match(script, /SelectedPath/);
  // The script wraps the path in the markers the reader looks for.
  assert.ok(script.includes(`'${MARKERS.open}' + $dialog.SelectedPath + '${MARKERS.close}'`));
});

test("pickWindowsDirectory returns only the text between its markers", async () => {
  const path = "C:\\Users\\muren\\Проекты";
  const { run } = fakeExecFile(`${NOISE.repeat(2)}${MARKERS.open}${path}${MARKERS.close}${NOISE}`);
  assert.equal(await pickWindowsDirectory(run, MARKERS), path);
});

test("pickWindowsDirectory resolves undefined on cancel (empty stdout)", async () => {
  const { run } = fakeExecFile("");
  assert.equal(await pickWindowsDirectory(run, MARKERS), undefined);
});

test("pickWindowsDirectory resolves undefined when a cancel leaves only foreign lines", async () => {
  const { run } = fakeExecFile(NOISE.repeat(4));
  assert.equal(await pickWindowsDirectory(run, MARKERS), undefined);
});

test("pickWindowsDirectory resolves undefined for a path that is not absolute", async () => {
  const { run } = fakeExecFile(`${MARKERS.open}relative\\dir${MARKERS.close}`);
  assert.equal(await pickWindowsDirectory(run, MARKERS), undefined);
});

test("pickWindowsDirectory rejects on subprocess error", async () => {
  const { run } = fakeExecFile("", new Error("powershell missing"));
  await assert.rejects(() => pickWindowsDirectory(run, MARKERS), /powershell missing/);
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
