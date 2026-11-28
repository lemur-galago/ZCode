import assert from "node:assert/strict";
import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import test from "node:test";
import { pickWindowsDirectory } from "../src/app-directory-picker.js";
import {
  createOutputMarkers,
  readMarkedOutput,
  type OutputMarkers,
} from "../src/app-marked-output.js";
import { readWindowsCommitBytes } from "../src/app-process-memory.js";
import { readWindowsClipboardText } from "../src/app-selection-paste.js";

// Local patch (marked-output).

const MARKERS: OutputMarkers = { close: "<<end>>", open: "<<begin>>" };
// What an injected hooking DLL (mhook) adds to the output of every process on
// some machines. The readers used to take it for the result itself: the
// picker submitted `/adddir` of these lines, the paste was refused as
// multiline and the commit size was never read.
const NOISE = "[0x7FFDFF84B830] ANOMALY: meaningless REX prefix used\r\n";
const windowsOnly = { skip: process.platform !== "win32" };

test("markers differ per call and hold nothing a PowerShell string cares about", () => {
  const first = createOutputMarkers();
  const second = createOutputMarkers();
  assert.notDeepEqual(first, second);
  assert.notEqual(first.open, first.close);
  // They travel inside a single-quoted PowerShell string in a command line.
  for (const marker of [first.open, first.close]) assert.match(marker, /^[a-z0-9-]+$/u);
});

test("readMarkedOutput returns only the text between the markers", () => {
  assert.equal(readMarkedOutput("<<begin>>C:\\tmp<<end>>", MARKERS), "C:\\tmp");
  assert.equal(readMarkedOutput(`${NOISE}${NOISE}<<begin>>C:\\tmp<<end>>\r\n${NOISE}`, MARKERS), "C:\\tmp");
  assert.equal(readMarkedOutput("<<begin>><<end>>", MARKERS), "");
  assert.equal(readMarkedOutput("", MARKERS), undefined);
  assert.equal(readMarkedOutput(NOISE, MARKERS), undefined);
  assert.equal(readMarkedOutput("<<begin>>no end", MARKERS), undefined);
  assert.equal(readMarkedOutput("no begin<<end>>", MARKERS), undefined);
});

function fakeExecFile(output: string, error?: Error) {
  const calls: string[][] = [];
  const run = (
    _command: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string) => void,
  ) => {
    calls.push(args);
    queueMicrotask(() => callback(error ?? null, output));
  };
  return { calls, run: run as unknown as typeof execFile };
}

test("readWindowsClipboardText returns only the text between its markers", async () => {
  const { calls, run } = fakeExecFile(`${NOISE}${MARKERS.open}clipboard text${MARKERS.close}${NOISE}`);
  assert.equal(await readWindowsClipboardText(run, MARKERS), "clipboard text");
  const script = calls[0]?.at(-1) ?? "";
  assert.ok(script.includes(`[Console]::Write('${MARKERS.open}')`));
  assert.ok(script.includes(`[Console]::Write('${MARKERS.close}')`));
});

test("readWindowsClipboardText resolves an empty text for an empty clipboard", async () => {
  const { run } = fakeExecFile(`${MARKERS.open}${MARKERS.close}`);
  assert.equal(await readWindowsClipboardText(run, MARKERS), "");
});

test("readWindowsClipboardText rejects output without markers and names none of it", async () => {
  // The script did not run as intended. The rejection must not quote the
  // output: the clipboard may hold credentials.
  const { run } = fakeExecFile(`${NOISE}hunter2${NOISE}`);
  await assert.rejects(readWindowsClipboardText(run, MARKERS), (error: Error) => {
    assert.match(error.message, /no marked output/);
    assert.doesNotMatch(error.message, /hunter2/);
    return true;
  });
});

test("readWindowsClipboardText rejects on subprocess error", async () => {
  const { run } = fakeExecFile("", new Error("powershell missing"));
  await assert.rejects(readWindowsClipboardText(run, MARKERS), /powershell missing/);
});

// The real powershell.exe, started by the readers as in production, with the
// foreign lines put before and after everything it writes. `replacements`
// edits the script of the call, so the dialog is answered and the clipboard
// set without touching the desktop: the clipboard of the machine running the
// tests is never read or changed.
function noisyPowershell(replacements: Record<string, string> = {}) {
  const run = (
    file: string,
    args: string[],
    options: ExecFileOptionsWithStringEncoding,
    callback: (error: Error | null, stdout: string) => void,
  ) => {
    const script = Object.entries(replacements).reduce(
      (text, [from, to]) => text.replace(from, to),
      args.at(-1) ?? "",
    );
    execFile(file, [...args.slice(0, -1), script], options, (error, stdout) => {
      callback(error, `${NOISE}${stdout}${NOISE}`);
    });
  };
  return run as unknown as typeof execFile;
}

test("the readers take their result from a real powershell.exe through foreign lines", windowsOnly, async () => {
  // The dialog answers OK and holds a path; a property assignment is a
  // statement, so it goes next to the Description line, not into the `if`.
  const dialog = "$dialog.ShowDialog($owner)";
  const described = "$dialog.Description='Select a working directory to add'";
  const chosen = {
    [dialog]: "[System.Windows.Forms.DialogResult]::OK",
    [described]: `${described}; $dialog.SelectedPath='C:\\Program Files'`,
  };
  assert.equal(await pickWindowsDirectory(noisyPowershell(chosen)), "C:\\Program Files");

  const cancelled = { [dialog]: "[System.Windows.Forms.DialogResult]::Cancel" };
  assert.equal(await pickWindowsDirectory(noisyPowershell(cancelled)), undefined);

  const clipboard = "Get-Clipboard -Raw";
  assert.equal(await readWindowsClipboardText(noisyPowershell({ [clipboard]: "'Из буфера'" })), "Из буфера");
  assert.equal(await readWindowsClipboardText(noisyPowershell({ [clipboard]: "$null" })), "");

  const bytes = await readWindowsCommitBytes(noisyPowershell(), process.pid);
  assert.ok(Number.isSafeInteger(bytes) && bytes > 0, `commit size read as ${bytes}`);
});
