// Local patch (process-memory-indicator): memory usage of this session process,
// shown in the input status row. On Windows it is the commit charge that
// accumulates in a long session (native renderer buffers), and Node exposes no
// per-process commit number, so the commit size comes from a short PowerShell
// probe; the working set is read in-process.
import { execFile } from "node:child_process";
import { useEffect, useRef, useState } from "react";
import type { StatusNotice } from "./app-input-status.js";
import { createOutputMarkers, readMarkedOutput, type OutputMarkers } from "./app-marked-output.js";

export type ProcessMemorySample = {
  /** Private committed memory ("commit size"), when it can be read. */
  commitBytes?: number;
  /** Resident set size. */
  workingSetBytes?: number;
};

export type ProcessMemoryLevel = "danger" | "normal" | "warning";

export type ProcessMemoryUsage = {
  commitLabel: string | undefined;
  level: ProcessMemoryLevel;
  workingSetLabel: string | undefined;
};

export type ReadProcessMemory = () => Promise<ProcessMemorySample>;

// Local patch (process-memory-idle-interval): each sample starts a
// powershell.exe, which costs ~230 ms of CPU in that process, so the interval
// is 30 s while a turn runs (memory grows then) and 60 s in an idle tab - it
// used to be 10 s always, 2.3% of one core per open tab for nothing.
export const PROCESS_MEMORY_SAMPLE_INTERVAL_MS = 30_000;
export const PROCESS_MEMORY_IDLE_SAMPLE_INTERVAL_MS = 60_000;
export const PROCESS_MEMORY_FIRST_SAMPLE_DELAY_MS = 1_000;
export const PROCESS_MEMORY_RETRY_INTERVAL_MS = 30_000;
export const PROCESS_MEMORY_PROBE_TIMEOUT_MS = 5_000;

const BYTE_UNIT = 1024;
const BYTE_UNITS = ["", "K", "M", "G", "T", "P"] as const;
const GIB = 1024 ** 3;
const PROCESS_MEMORY_WARNING_COMMIT_BYTES = 4 * GIB;
const PROCESS_MEMORY_DANGER_COMMIT_BYTES = 16 * GIB;

/** At most three significant digits, binary units: "85.3M", "1.21G", "12.3G". */
export function formatProcessMemoryBytes(bytes: number): string | undefined {
  if (!Number.isFinite(bytes) || bytes < 0) return undefined;
  let value = bytes;
  let unit = 0;
  while (value >= BYTE_UNIT && unit < BYTE_UNITS.length - 1) {
    value /= BYTE_UNIT;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${Number(value.toFixed(digits))}${BYTE_UNITS[unit]}`;
}

export function processMemoryLevel(commitBytes: number | undefined): ProcessMemoryLevel {
  if (commitBytes === undefined) return "normal";
  if (commitBytes >= PROCESS_MEMORY_DANGER_COMMIT_BYTES) return "danger";
  if (commitBytes >= PROCESS_MEMORY_WARNING_COMMIT_BYTES) return "warning";
  return "normal";
}

export function createProcessMemoryUsage(
  sample: ProcessMemorySample,
): ProcessMemoryUsage | undefined {
  const commitBytes = validBytes(sample.commitBytes) ? sample.commitBytes : undefined;
  const commitLabel = commitBytes === undefined ? undefined : formatProcessMemoryBytes(commitBytes);
  const workingSetLabel = validBytes(sample.workingSetBytes)
    ? formatProcessMemoryBytes(sample.workingSetBytes)
    : undefined;
  if (!commitLabel && !workingSetLabel) return undefined;
  return { commitLabel, level: processMemoryLevel(commitBytes), workingSetLabel };
}

function validBytes(bytes: number | undefined): bytes is number {
  return bytes !== undefined && Number.isFinite(bytes) && bytes >= 0;
}

export const STATUS_NOTICE_DURATION_MS = 15_000;
const RESTART_NOTICE_TEXT = "Restart to free memory:";
const RESTART_NOTICE_WITHOUT_SESSION_TEXT = "Memory is freed only by restarting zcode.";

// A click on the memory segment shows this notice. Native memory a session has
// accumulated is released only when the process exits, so the way to "clear" it
// is to restart the session, which the command does.
export function processMemoryNotice(sessionId: string | undefined): StatusNotice {
  return sessionId
    ? { command: `zcode --resume ${sessionId}`, text: RESTART_NOTICE_TEXT }
    : { text: RESTART_NOTICE_WITHOUT_SESSION_TEXT };
}

type ExecFileRun = typeof execFile;

// Local patch (marked-output): the number goes between the markers of the
// call, so foreign lines in the output of powershell.exe (an injected hooking
// DLL) no longer hide the commit size.
/** Commit size of a process in bytes, read through PowerShell (Windows only). */
export function readWindowsCommitBytes(
  run: ExecFileRun = execFile,
  pid: number = process.pid,
  markers: OutputMarkers = createOutputMarkers(),
): Promise<number> {
  return new Promise((resolve, reject) => {
    run(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p=[Diagnostics.Process]::GetProcessById(${pid}); [Console]::Out.Write('${markers.open}' + $p.PagedMemorySize64 + '${markers.close}')`,
      ],
      { encoding: "utf8", maxBuffer: 4096, timeout: PROCESS_MEMORY_PROBE_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        const text = readMarkedOutput(stdout, markers) ?? "";
        const bytes = /^\d+$/u.test(text) ? Number(text) : Number.NaN;
        if (error || !Number.isSafeInteger(bytes)) {
          reject(error ?? new Error("Commit size is not a number."));
          return;
        }
        resolve(bytes);
      },
    );
  });
}

export async function readProcessMemory(
  readCommit: () => Promise<number> = readWindowsCommitBytes,
): Promise<ProcessMemorySample> {
  const sample: ProcessMemorySample = { workingSetBytes: process.memoryUsage.rss() };
  if (process.platform === "win32") {
    sample.commitBytes = await readCommit().catch(() => undefined);
  }
  return sample;
}

// Latest memory usage, undefined until the first sample. State only changes
// when a formatted value changes, so the polling itself never re-renders.
export function useProcessMemory(options: {
  read?: ReadProcessMemory;
  intervalMs?: number;
  firstSampleDelayMs?: number;
  retryIntervalMs?: number;
} = {}): ProcessMemoryUsage | undefined {
  const { read = readProcessMemory } = options;
  const [usage, setUsage] = useState<ProcessMemoryUsage | undefined>(undefined);
  // The timings are read when a sample is scheduled, not when the options
  // change, so a changed interval does not restart the polling with a sample.
  const settings = useRef(options);
  settings.current = options;

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function schedule(delayMs: number) {
      timer = setTimeout(() => {
        void sample();
      }, delayMs);
    }

    async function sample() {
      try {
        const next = createProcessMemoryUsage(await read());
        if (disposed) return;
        if (next) {
          setUsage((current) => (sameProcessMemoryUsage(current, next) ? current : next));
        }
        schedule(settings.current.intervalMs ?? PROCESS_MEMORY_SAMPLE_INTERVAL_MS);
      } catch {
        if (disposed) return;
        schedule(settings.current.retryIntervalMs ?? PROCESS_MEMORY_RETRY_INTERVAL_MS);
      }
    }

    schedule(settings.current.firstSampleDelayMs ?? PROCESS_MEMORY_FIRST_SAMPLE_DELAY_MS);

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [read]);

  return usage;
}

function sameProcessMemoryUsage(
  current: ProcessMemoryUsage | undefined,
  next: ProcessMemoryUsage,
): boolean {
  return (
    current !== undefined &&
    current.commitLabel === next.commitLabel &&
    current.level === next.level &&
    current.workingSetLabel === next.workingSetLabel
  );
}
