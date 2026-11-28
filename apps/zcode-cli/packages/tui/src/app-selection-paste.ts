import { execFile } from "node:child_process";
import type { KeyEvent } from "@mbears/opentui-core";
import type React from "react";
import type { ActiveSelectionInput, SelectionState } from "./app-model.js";
import { createOutputMarkers, readMarkedOutput, type OutputMarkers } from "./app-marked-output.js";

type SetSelection = React.Dispatch<React.SetStateAction<SelectionState | undefined>>;
type SetStatus = (status: string) => void;

export interface SelectionPasteEvent {
  bytes: Uint8Array;
  metadata?: { kind?: string };
  preventDefault: () => void;
  stopPropagation: () => void;
}

const PASTE_STATUS_SINGLE_LINE = "Paste a single line of text.";
const PASTE_STATUS_CLIPBOARD_UNAVAILABLE = "Clipboard unavailable. Try Ctrl+Shift+V in Windows Terminal.";
const PASTE_MAX_LENGTH = 16384;
const PASTE_FORBIDDEN_CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/;

export function appendSelectionPaste(
  text: string,
  input: ActiveSelectionInput,
  setSelection: SetSelection,
  setStatus: SetStatus,
): boolean {
  if (typeof text !== "string") return false;
  const value = text.trim();
  if (!value) return false;
  if (value.length > PASTE_MAX_LENGTH || PASTE_FORBIDDEN_CONTROL_CHARACTERS.test(value)) {
    setStatus(PASTE_STATUS_SINGLE_LINE);
    return false;
  }
  setSelection((current) =>
    current?.input === input && !current.pending
      ? { ...current, input: { ...current.input, value: current.input.value + value } }
      : current,
  );
  return true;
}

export function handleSelectionPaste(
  event: SelectionPasteEvent,
  selection: SelectionState | undefined,
  setSelection: SetSelection,
  setStatus: SetStatus,
): boolean {
  if (!selection) return false;
  event.preventDefault();
  event.stopPropagation();
  if (!selection.input || selection.pending || event.metadata?.kind === "binary") return true;
  appendSelectionPaste(new TextDecoder().decode(event.bytes), selection.input, setSelection, setStatus);
  return true;
}

type ExecFileRun = typeof execFile;

// Local patch (marked-output): the text goes between the markers of the call,
// so foreign lines in the output of powershell.exe (an injected hooking DLL)
// are never pasted. Output without markers means the script did not run as
// intended; the rejection shows the hint to use the terminal's own paste.
export function readWindowsClipboardText(
  run: ExecFileRun = execFile,
  markers: OutputMarkers = createOutputMarkers(),
): Promise<string> {
  return new Promise((resolve, reject) => {
    run(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-Command",
        `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $text = Get-Clipboard -Raw; [Console]::Write('${markers.open}'); if ($null -ne $text) { [Console]::Write($text) }; [Console]::Write('${markers.close}')`,
      ],
      { windowsHide: true, encoding: "utf8", timeout: 5000, maxBuffer: 65536 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const text = readMarkedOutput(stdout, markers);
        // The message quotes no output: the clipboard may hold credentials.
        if (text === undefined) {
          reject(new Error("The clipboard reader wrote no marked output."));
          return;
        }
        resolve(text);
      },
    );
  });
}

export async function pasteWindowsSelectionInput(
  selection: SelectionState | undefined,
  setSelection: SetSelection,
  setStatus: SetStatus,
  read: () => Promise<string> = readWindowsClipboardText,
): Promise<void> {
  const input = selection?.input;
  if (!input || selection.pending || process.platform !== "win32") return;
  try {
    appendSelectionPaste(await read(), input, setSelection, setStatus);
  } catch {
    // Do not print subprocess output: it could contain credentials.
    setStatus(PASTE_STATUS_CLIPBOARD_UNAVAILABLE);
  }
}

export function isSelectionPasteShortcut(key: KeyEvent): boolean {
  return (
    (key.name === "v" && (key.ctrl || key.meta)) ||
    key.raw === "\x16" ||
    (key.name === "insert" && key.shift)
  );
}
