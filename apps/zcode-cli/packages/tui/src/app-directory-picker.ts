import { execFile } from "node:child_process";
import type React from "react";

// Local patch (adddir-command): native folder picker behind the ➕ trigger.
// Windows only — FolderBrowserDialog via powershell.exe -STA, the same
// subprocess pattern as the clipboard reader in app-selection-paste.ts.
// Writes the selected path to stdout (UTF-8, no newline); cancel/error write
// nothing and resolve to undefined. The hidden owner form is TopMost so the
// dialog lands in front of the terminal window instead of behind it.
export function isDirectoryPickerSupported(): boolean {
  return process.platform === "win32";
}

const PICKER_TIMEOUT_MS = 600_000;
const PICKER_MAX_BUFFER = 32_768;

const PICKER_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
  "Add-Type -AssemblyName System.Windows.Forms",
  "$dialog=New-Object System.Windows.Forms.FolderBrowserDialog",
  "$dialog.Description='Select a working directory to add'",
  "$dialog.ShowNewFolderButton=$false",
  "$owner=New-Object System.Windows.Forms.Form",
  "$owner.TopMost=$true",
  "if($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Write($dialog.SelectedPath)}",
].join("; ");

type ExecFileRun = typeof execFile;

export function pickWindowsDirectory(run: ExecFileRun = execFile): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    run(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-Command",
        PICKER_SCRIPT,
      ],
      { windowsHide: true, encoding: "utf8", timeout: PICKER_TIMEOUT_MS, maxBuffer: PICKER_MAX_BUFFER },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const picked = stdout.trim();
        resolve(picked.length > 0 ? picked : undefined);
      },
    );
  });
}

/** Guard against double dialogs while one picker is already open. */
export function createDirectoryPickerGate(): {
  isOpen: () => boolean;
  run: <T>(operation: () => Promise<T>) => Promise<T | undefined>;
} {
  let open = false;
  return {
    isOpen: () => open,
    run: async (operation) => {
      if (open) return undefined;
      open = true;
      try {
        return await operation();
      } finally {
        open = false;
      }
    },
  };
}

export type DirectoryPickerGate = ReturnType<typeof createDirectoryPickerGate>;
export type DirectoryPickerRef = React.MutableRefObject<DirectoryPickerGate | undefined>;
