import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { createTestRenderer } from "@mbears/opentui-core/testing";
import { testRender } from "@mbears/opentui-react/test-utils";
import type { UiThemeMode } from "@zcode/contracts";
import { getZCodeCopy } from "@zcode/i18n";
import React, { act } from "react";
import {
  InputActiveStatus,
  inputActiveStatusRow,
  processMemoryStatusLabel,
} from "../src/app-input-status.js";
import {
  PROCESS_MEMORY_IDLE_SAMPLE_INTERVAL_MS,
  PROCESS_MEMORY_SAMPLE_INTERVAL_MS,
  createProcessMemoryUsage,
  formatProcessMemoryBytes,
  processMemoryLevel,
  processMemoryNotice,
  readWindowsCommitBytes,
  useProcessMemory,
  type ProcessMemorySample,
  type ProcessMemoryUsage,
} from "../src/app-process-memory.js";
import { palette } from "../src/app-model.js";
import { spinnerFrame } from "../src/app-motion.js";
import { displayWidth } from "../src/app-terminal-width.js";
import { runTuiWithRenderer } from "../src/tui.js";
import type { TuiOptions } from "../src/types.js";

// Local patch (process-memory-indicator).

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const COPY = getZCodeCopy("en-US").tui;
const SESSION_ID = "sess_1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const MEMORY: ProcessMemoryUsage = { commitLabel: "520M", level: "normal", workingSetLabel: "610M" };
const STATUS_OPTIONS = {
  contextUsage: { contextUsed: 45_231, contextWindow: 1_000_000 },
  model: "zai-api/GLM-5.3",
  onStatusCompactMouseDown: () => undefined,
  thoughtLevel: "high",
};
const RIGHT_GROUP_AFTER_MEMORY = ["GLM-5.3", " · ", "high", "  ", "45.2K / 1M (5%)", " ", "🔄"];

type TextNode = {
  onMouseDown?: (event: { preventDefault: () => void; stopPropagation: () => void }) => void;
  style?: unknown;
  text: string;
};

function collectTextNodes(node: unknown): TextNode[] {
  if (Array.isArray(node)) return node.flatMap(collectTextNodes);
  if (typeof node !== "object" || node === null || !("props" in node)) return [];

  const element = node as {
    props?: { children?: unknown; onMouseDown?: TextNode["onMouseDown"]; style?: unknown };
    type?: unknown;
  };
  const children = element.props?.children;
  const current =
    element.type === "text" && typeof children === "string"
      ? [{ onMouseDown: element.props?.onMouseDown, style: element.props?.style, text: children }]
      : [];
  return [...current, ...collectTextNodes(children)];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("formats memory sizes with at most three significant digits", () => {
  assert.equal(formatProcessMemoryBytes(0), "0");
  assert.equal(formatProcessMemoryBytes(1023), "1023");
  assert.equal(formatProcessMemoryBytes(1024), "1K");
  assert.equal(formatProcessMemoryBytes(85.3 * MIB), "85.3M");
  assert.equal(formatProcessMemoryBytes(612 * MIB), "612M");
  assert.equal(formatProcessMemoryBytes(1000 * MIB), "1000M");
  assert.equal(formatProcessMemoryBytes(GIB), "1G");
  assert.equal(formatProcessMemoryBytes(1.21 * GIB), "1.21G");
  assert.equal(formatProcessMemoryBytes(12.3 * GIB), "12.3G");
  assert.equal(formatProcessMemoryBytes(123 * GIB), "123G");
  assert.equal(formatProcessMemoryBytes(-1), undefined);
  assert.equal(formatProcessMemoryBytes(Number.NaN), undefined);
});

test("levels follow the commit size", () => {
  assert.equal(processMemoryLevel(undefined), "normal");
  assert.equal(processMemoryLevel(4 * GIB - 1), "normal");
  assert.equal(processMemoryLevel(4 * GIB), "warning");
  assert.equal(processMemoryLevel(16 * GIB - 1), "warning");
  assert.equal(processMemoryLevel(16 * GIB), "danger");
});

test("builds a usage only from valid sample values", () => {
  assert.equal(createProcessMemoryUsage({}), undefined);
  assert.equal(createProcessMemoryUsage({ commitBytes: Number.NaN }), undefined);
  assert.deepEqual(createProcessMemoryUsage({ commitBytes: 48 * GIB, workingSetBytes: 3 * GIB }), {
    commitLabel: "48G",
    level: "danger",
    workingSetLabel: "3G",
  });
  assert.deepEqual(createProcessMemoryUsage({ workingSetBytes: 40 * MIB }), {
    commitLabel: undefined,
    level: "normal",
    workingSetLabel: "40M",
  });
});

test("reads the commit size through a hidden PowerShell probe", async () => {
  const calls: Array<{ args: string[]; file: string; options: Record<string, unknown> }> = [];
  const run = ((
    file: string,
    args: string[],
    options: Record<string, unknown>,
    callback: (error: Error | null, stdout: string) => void,
  ) => {
    calls.push({ args, file, options });
    queueMicrotask(() => callback(null, "524288000\r\n"));
  }) as unknown as typeof execFile;

  assert.equal(await readWindowsCommitBytes(run, 4242), 524288000);
  assert.equal(calls[0]?.file, "powershell.exe");
  assert.ok(calls[0]?.args.some((argument) => argument.includes("GetProcessById(4242)")));
  assert.ok(calls[0]?.args.some((argument) => argument.includes("PagedMemorySize64")));
  assert.equal(calls[0]?.options.windowsHide, true);
  assert.ok(typeof calls[0]?.options.timeout === "number");

  const failing = ((_file: string, _args: string[], _options: unknown, callback: (error: Error | null) => void) => {
    queueMicrotask(() => callback(new Error("PowerShell is not available"), ""));
  }) as unknown as typeof execFile;
  await assert.rejects(readWindowsCommitBytes(failing, 4242), /PowerShell is not available/);

  const garbage = ((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
    queueMicrotask(() => callback(null, "not a number"));
  }) as unknown as typeof execFile;
  await assert.rejects(readWindowsCommitBytes(garbage, 4242), /not a number/);
});

test("the notice carries the command that restarts the session", () => {
  assert.deepEqual(processMemoryNotice(SESSION_ID), {
    command: `zcode --resume ${SESSION_ID}`,
    text: "Restart to free memory:",
  });
  assert.deepEqual(processMemoryNotice(undefined), {
    text: "Memory is freed only by restarting zcode.",
  });
});

test("labels the usage as ram and commit, omitting a half that was not read", () => {
  assert.equal(processMemoryStatusLabel(MEMORY), "ram 610M · commit 520M");
  assert.equal(processMemoryStatusLabel({ ...MEMORY, commitLabel: undefined }), "ram 610M");
  assert.equal(processMemoryStatusLabel({ ...MEMORY, workingSetLabel: undefined }), "commit 520M");
  assert.equal(
    processMemoryStatusLabel({ commitLabel: undefined, level: "normal", workingSetLabel: undefined }),
    undefined,
  );
});

test("shows the memory segment first in the right group and wires its click", () => {
  let clicks = 0;
  const row = inputActiveStatusRow(COPY, undefined, {
    ...STATUS_OPTIONS,
    contentWidth: 120,
    processMemory: MEMORY,
    onStatusMemoryMouseDown: () => {
      clicks += 1;
    },
  });
  const nodes = collectTextNodes(row);

  assert.deepEqual(nodes.map((node) => node.text), [
    "ram 610M · commit 520M",
    "  ",
    ...RIGHT_GROUP_AFTER_MEMORY,
  ]);
  assert.deepEqual(nodes[0]?.style, { fg: palette.muted, flexShrink: 0 });

  let prevented = 0;
  let stopped = 0;
  nodes[0]?.onMouseDown?.({
    preventDefault: () => {
      prevented += 1;
    },
    stopPropagation: () => {
      stopped += 1;
    },
  });
  assert.equal(clicks, 1);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
});

test("colors the memory segment by the commit level", () => {
  const memoryStyle = (level: ProcessMemoryUsage["level"]) =>
    collectTextNodes(
      inputActiveStatusRow(COPY, undefined, { ...STATUS_OPTIONS, contentWidth: 120, processMemory: { ...MEMORY, level } }),
    )[0]?.style;
  assert.deepEqual(memoryStyle("normal"), { fg: palette.muted, flexShrink: 0 });
  assert.deepEqual(memoryStyle("warning"), { fg: palette.warning, flexShrink: 0 });
  assert.deepEqual(memoryStyle("danger"), { fg: palette.danger, flexShrink: 0 });
});

test("drops the memory segment before anything else on a narrow terminal", () => {
  const textsAt = (contentWidth: number) =>
    collectTextNodes(
      inputActiveStatusRow(COPY, undefined, { ...STATUS_OPTIONS, contentWidth, processMemory: MEMORY }),
    ).map((node) => node.text);

  // 22 cells for the segment, 2 for its gap, 34 for the rest of the group.
  assert.deepEqual(textsAt(59), ["ram 610M · commit 520M", "  ", ...RIGHT_GROUP_AFTER_MEMORY]);
  assert.deepEqual(textsAt(58), RIGHT_GROUP_AFTER_MEMORY);
  // Below that the existing order applies: effort first, then the model.
  assert.deepEqual(textsAt(40), RIGHT_GROUP_AFTER_MEMORY);
  assert.deepEqual(textsAt(30), ["GLM-5.3", "  ", "45.2K / 1M (5%)", " ", "🔄"]);
});

test("keeps the row unchanged when no memory usage is known", () => {
  assert.deepEqual(collectTextNodes(InputActiveStatus({ active: false, copy: COPY })), []);
  assert.equal(
    collectTextNodes(inputActiveStatusRow(COPY, undefined, STATUS_OPTIONS)).some((node) =>
      node.text.startsWith("ram "),
    ),
    false,
  );
});

test("a notice owns the row while it is shown", () => {
  const frame = spinnerFrame(0);
  const notice = processMemoryNotice(SESSION_ID);
  const nodes = collectTextNodes(
    inputActiveStatusRow(COPY, frame, {
      ...STATUS_OPTIONS,
      contentWidth: 120,
      notice,
      onStatusMemoryMouseDown: () => undefined,
      processMemory: MEMORY,
    }),
  );

  // Model, effort and memory give way; the context badge and the compact glyph stay.
  assert.deepEqual(nodes.map((node) => node.text), [
    frame,
    " ",
    COPY.input.activeStatusHint,
    "Restart to free memory:",
    " ",
    `zcode --resume ${SESSION_ID}`,
    "  ",
    "45.2K / 1M (5%)",
    " ",
    "🔄",
  ]);
  const command = nodes.find((node) => node.text.startsWith("zcode --resume"));
  assert.deepEqual(command?.style, { fg: palette.accent, flexShrink: 0 });
  // Plain text, so the mouse can select it.
  assert.equal(command?.onMouseDown, undefined);
});

test("a notice keeps the command whole on a narrow terminal", () => {
  const frame = spinnerFrame(0);
  const busyLeftWidth = displayWidth(frame) + 1 + displayWidth(COPY.input.activeStatusHint);
  const notice = processMemoryNotice(SESSION_ID);
  const textsAt = (availableWidth: number) =>
    collectTextNodes(
      inputActiveStatusRow(COPY, frame, {
        ...STATUS_OPTIONS,
        // padding + busy hint + spacer are not part of the available width
        contentWidth: availableWidth + busyLeftWidth + 2,
        notice,
        processMemory: MEMORY,
      }),
    ).map((node) => node.text);
  const command = `zcode --resume ${SESSION_ID}`;
  const left = [frame, " ", COPY.input.activeStatusHint];
  const fullNoticeWidth = displayWidth(notice.text ?? "") + 1 + displayWidth(command);
  // The glyph with its gap takes 3 cells.
  const rightGroupWidth = 3 + displayWidth("45.2K / 1M (5%)");

  // Everything fits: the notice and the rest of the row.
  assert.deepEqual(textsAt(fullNoticeWidth + 2 + rightGroupWidth), [
    ...left,
    "Restart to free memory:",
    " ",
    command,
    "  ",
    "45.2K / 1M (5%)",
    " ",
    "🔄",
  ]);
  // The notice no longer fits whole: the right group gives way and the text is
  // shortened; the command is the part worth copying, so it stays whole.
  assert.deepEqual(textsAt(fullNoticeWidth - 1), [...left, "Restart to free mem...", " ", command]);
  assert.deepEqual(textsAt(displayWidth(command)), [...left, command]);
});

// A probe the test answers by hand: every call waits until `release` settles it,
// so each sample is an event the test controls.
function gatedProbe() {
  const state = { calls: 0 };
  const pending: Array<{
    reject: (error: Error) => void;
    resolve: (sample: ProcessMemorySample) => void;
  }> = [];
  const read = (): Promise<ProcessMemorySample> =>
    new Promise<ProcessMemorySample>((resolve, reject) => {
      pending.push({ reject, resolve });
      state.calls += 1;
    });
  const release = (step: ProcessMemorySample | Error): void => {
    const gate = pending.shift();
    if (!gate) return;
    if (step instanceof Error) gate.reject(step);
    else gate.resolve(step);
  };
  return { read, release, state };
}

type Probe = ReturnType<typeof gatedProbe>;
type TestView = Awaited<ReturnType<typeof testRender>>;

// Mounts a probe component. The mount is its own act scope: the effect that
// starts the polling runs when it ends.
async function mountProbe(element: React.ReactElement): Promise<TestView> {
  let view: TestView | undefined;
  await act(async () => {
    view = await testRender(element, { height: 3, width: 40 });
    await view.renderOnce();
  });
  assert.ok(view);
  return view;
}

// Waits, in one act scope, until the probe has been called `until` times.
async function waitProbeCalls(view: TestView, probe: Probe, until: number): Promise<void> {
  await act(async () => {
    for (let attempt = 0; attempt < 120 && probe.state.calls < until; attempt += 1) {
      await sleep(25);
    }
    await view.renderOnce();
  });
  assert.ok(probe.state.calls >= until);
}

// Answers the pending probe call in an act scope, so the update it causes is an
// act update; by the end of the scope the next call is pending again. React
// renders when the scope ends, so the frame is painted in a second scope.
async function releaseProbe(view: TestView, probe: Probe, step: ProcessMemorySample | Error) {
  await act(async () => {
    probe.release(step);
    await sleep(25);
  });
  await act(async () => {
    await view.renderOnce();
  });
}

test("polls the memory usage and keeps the state while the labels are unchanged", async () => {
  const probe = gatedProbe();
  const seen: Array<ProcessMemoryUsage | undefined> = [];
  function Probe() {
    const usage = useProcessMemory({ firstSampleDelayMs: 5, intervalMs: 5, read: probe.read });
    seen.push(usage);
    return React.createElement("text", null, usage ? processMemoryStatusLabel(usage) : "none");
  }
  const view = await mountProbe(React.createElement(Probe));
  const first = { commitLabel: "500M", level: "normal", workingSetLabel: "100M" } as const;

  try {
    assert.equal(view.captureCharFrame().includes("ram "), false);
    await waitProbeCalls(view, probe, 1);
    await releaseProbe(view, probe, { commitBytes: 500 * MIB, workingSetBytes: 100 * MIB });
    assert.deepEqual([...new Set(seen)], [undefined, first]);
    assert.equal(view.captureCharFrame().includes("ram 100M · commit 500M"), true);

    // The same labels after rounding is not a state change.
    await waitProbeCalls(view, probe, 2);
    await releaseProbe(view, probe, {
      commitBytes: 500 * MIB + 0.4 * MIB,
      workingSetBytes: 100 * MIB + 0.4 * MIB,
    });
    assert.equal(seen.at(-1), seen[1]);

    await waitProbeCalls(view, probe, 3);
    await releaseProbe(view, probe, { commitBytes: 500 * MIB, workingSetBytes: 101 * MIB });
    assert.deepEqual(seen.at(-1), {
      commitLabel: "500M",
      level: "normal",
      workingSetLabel: "101M",
    });
    assert.equal(view.captureCharFrame().includes("ram 101M · commit 500M"), true);
  } finally {
    await act(async () => {
      view.renderer.destroy();
    });
  }
});

test("keeps the last usage when a sample fails and asks again later", async () => {
  const probe = gatedProbe();
  const seen: Array<ProcessMemoryUsage | undefined> = [];
  function Probe() {
    const usage = useProcessMemory({
      firstSampleDelayMs: 5,
      intervalMs: 5,
      read: probe.read,
      retryIntervalMs: 5,
    });
    seen.push(usage);
    return React.createElement("text", null, usage ? "known" : "none");
  }
  const view = await mountProbe(React.createElement(Probe));
  const sample = { commitBytes: 500 * MIB, workingSetBytes: 100 * MIB };

  try {
    await waitProbeCalls(view, probe, 1);
    await releaseProbe(view, probe, sample);

    await waitProbeCalls(view, probe, 2);
    await releaseProbe(view, probe, new Error("probe failed"));
    assert.equal(seen.at(-1), seen[1]);
    assert.equal(view.captureCharFrame().includes("known"), true);

    // A failed sample is not retried at the regular interval.
    await waitProbeCalls(view, probe, 3);
    await releaseProbe(view, probe, sample);
    assert.equal(seen.at(-1), seen[1]);
    assert.deepEqual([...new Set(seen)].length, 2);
  } finally {
    await act(async () => {
      view.renderer.destroy();
    });
  }
});

// Local patch (process-memory-idle-interval).

test("the probe runs every 30 s while a turn runs and every 60 s in an idle tab", () => {
  assert.equal(PROCESS_MEMORY_SAMPLE_INTERVAL_MS, 30_000);
  assert.equal(PROCESS_MEMORY_IDLE_SAMPLE_INTERVAL_MS, 60_000);
});

test("the next sample waits the interval that is current when it is scheduled", async () => {
  const probe = gatedProbe();
  let setBusy: (busy: boolean) => void = () => {};
  function Probe({ busy }: { busy: boolean }) {
    useProcessMemory({ firstSampleDelayMs: 400, intervalMs: busy ? 5 : 80, read: probe.read });
    return React.createElement("text", null, "probe");
  }
  function Host() {
    const [busy, setBusyState] = React.useState(true);
    setBusy = setBusyState;
    return React.createElement(Probe, { busy });
  }
  const view = await mountProbe(React.createElement(Host));
  const sample = { commitBytes: 500 * MIB, workingSetBytes: 100 * MIB };

  try {
    await waitProbeCalls(view, probe, 1);
    await releaseProbe(view, probe, sample);

    // The interval changes from 5 ms to 80 ms. That is not a restart of the
    // polling: the second sample comes with the 5 ms timer scheduled before,
    // not 400 ms later as a first sample would.
    await act(async () => {
      setBusy(false);
      await sleep(25);
    });
    await waitProbeCalls(view, probe, 2);
    await releaseProbe(view, probe, sample);

    // The sample scheduled while idle waits the idle interval.
    await act(async () => {
      await sleep(40);
    });
    assert.equal(probe.state.calls, 2);
    await waitProbeCalls(view, probe, 3);
  } finally {
    await act(async () => {
      view.renderer.destroy();
    });
  }
});

test("clicking the memory segment shows the restart notice, whose command can be selected", async () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const terminal = await createTestRenderer({
    exitOnCtrlC: false,
    height: 24,
    screenMode: "alternate-screen",
    targetFps: 30,
    useThread: false,
    width: 110,
  });
  let resolveThemeMode!: (mode: UiThemeMode) => void;
  terminal.renderer.waitForThemeMode = () => new Promise<UiThemeMode>((resolve) => {
    resolveThemeMode = resolve;
  });
  const copied: string[] = [];
  const options: TuiOptions = {
    getMainSessionId: () => SESSION_ID,
    locale: "en-US",
    noColor: true,
    readProcessMemory: async () => ({ commitBytes: 500 * MIB, workingSetBytes: 100 * MIB }),
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    submitPrompt: async () => ({ response: "unused" }),
    workspaceDirectory: "/test/workspace",
    writeClipboardText: async (text) => {
      copied.push(text);
    },
  };
  let outcome: Promise<number> | undefined;

  const frameRows = async () => {
    await act(async () => {
      await terminal.renderOnce();
    });
    return terminal.captureCharFrame().split("\n");
  };

  await act(async () => {
    outcome = runTuiWithRenderer(options, terminal.renderer);
    await terminal.renderOnce();
  });

  try {
    // The first sample arrives shortly after startup (its update must land in an act scope).
    let rows: string[] = [];
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await act(async () => {
        await sleep(50);
      });
      rows = await frameRows();
      if (rows.some((line) => line.includes("ram 100M · commit 500M"))) break;
    }
    const memoryRow = rows.findIndex((line) => line.includes("ram 100M · commit 500M"));
    assert.notEqual(memoryRow, -1);
    const memoryColumn = rows[memoryRow]?.indexOf("ram 100M") ?? -1;
    assert.ok(memoryColumn >= 0);

    await act(async () => {
      await terminal.mockMouse.click(memoryColumn + 2, memoryRow);
      await settle();
    });
    rows = await frameRows();
    const command = `zcode --resume ${SESSION_ID}`;
    const noticeRow = rows.findIndex((line) => line.includes(`Restart to free memory: ${command}`));
    assert.notEqual(noticeRow, -1);
    // The segment the notice replaces.
    assert.equal(rows.some((line) => line.includes("ram 100M")), false);

    // The command is plain text: a drag over it selects it, the release copies it.
    const commandColumn = rows[noticeRow]?.indexOf(command) ?? -1;
    assert.ok(commandColumn >= 0);
    await act(async () => {
      await terminal.mockMouse.drag(commandColumn, noticeRow, commandColumn + command.length, noticeRow);
      await settle();
    });
    assert.deepEqual(copied, [command]);
  } finally {
    await act(async () => {
      resolveThemeMode("dark");
      terminal.renderer.destroy();
    });
    await outcome;
    environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});
