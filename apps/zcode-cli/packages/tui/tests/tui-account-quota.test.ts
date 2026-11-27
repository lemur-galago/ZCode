import assert from "node:assert/strict";
import test from "node:test";
import { createTestRenderer } from "@mbears/opentui-core/testing";
import { testRender } from "@mbears/opentui-react/test-utils";
import type { UiThemeMode } from "@zcode/contracts";
import { getZCodeCopy } from "@zcode/i18n";
import React, { act } from "react";
import {
  inputActiveStatusRow,
  STATUS_NOTICE_CLAUSE_SEPARATOR,
} from "../src/app-input-status.js";
import {
  ACCOUNT_QUOTA_PENDING_NOTICE_TEXT,
  ACCOUNT_QUOTA_STALE_MS,
  accountQuotaLevel,
  accountQuotaNotice,
  accountQuotaNoticeClauses,
  accountQuotaPendingNotice,
  createAccountQuotaUsage,
  formatAccountQuotaCredits,
  formatAccountQuotaDuration,
  formatAccountQuotaReset,
  useAccountQuota,
  type AccountQuotaSnapshot,
  type AccountQuotaUsage,
  type AccountQuotaWindow,
} from "../src/app-account-quota.js";
import type { ProcessMemoryUsage } from "../src/app-process-memory.js";
import { palette } from "../src/app-model.js";
import { spinnerFrame } from "../src/app-motion.js";
import { displayWidth, truncateDisplay } from "../src/app-terminal-width.js";
import { runTuiWithRenderer } from "../src/tui.js";
import type { TuiOptions } from "../src/types.js";

// Local patch (account-quota-indicator).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 10, 23, 18, 0, 0);
const COPY = getZCodeCopy("en-US").tui;
const BADGE = "45.2K / 1M (5%)";
const MEMORY: ProcessMemoryUsage = { commitLabel: "520M", level: "normal", workingSetLabel: "610M" };
const STATUS_OPTIONS = {
  contextUsage: { contextUsed: 45_231, contextWindow: 1_000_000 },
  model: "zai-api/GLM-5.3",
  onStatusCompactMouseDown: () => undefined,
  thoughtLevel: "high",
};

// GLM Coding Max on 2026-11-23: the week three quarters used, the 5-hour pool nearly full.
const WEEK: AccountQuotaWindow = {
  kind: "week",
  label: "week",
  usedCredits: 104_664,
  totalCredits: 140_000,
  remainingCredits: 35_335,
  usedPercent: 74,
  nextResetAt: NOW + 27 * HOUR,
};
const FIVE_HOURS: AccountQuotaWindow = {
  kind: "five-hour",
  label: "5h",
  usedCredits: 3_007,
  totalCredits: 28_000,
  remainingCredits: 24_992,
  usedPercent: 10,
  nextResetAt: NOW + 178 * MINUTE,
};
const SNAPSHOT: AccountQuotaSnapshot = {
  fetchedAt: NOW,
  level: "max",
  planDate: "07.12",
  windows: [WEEK, FIVE_HOURS],
};

// The reset moment is shown in local time; derive the expectation the same way.
function localDate(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// For the tests that run on the real clock: fresh, with both resets still ahead.
function liveSnapshot(): AccountQuotaSnapshot {
  const now = Date.now();
  return {
    ...SNAPSHOT,
    fetchedAt: now,
    windows: [
      { ...WEEK, nextResetAt: now + 27 * HOUR },
      { ...FIVE_HOURS, nextResetAt: now + 178 * MINUTE },
    ],
  };
}

const NOTICE_CLAUSES = [
  `week 74% (104.7K/140K), resets ${localDate(NOW + 27 * HOUR)} (in 1d 3h)`,
  "5h 10% (3.0K/28K), resets in 2h 58m",
  "Max, renews 07.12",
];

function usageAt(snapshot: AccountQuotaSnapshot = SNAPSHOT, now: number = NOW): AccountQuotaUsage {
  const usage = createAccountQuotaUsage(snapshot, now);
  assert.ok(usage);
  return usage;
}

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
// Retry waits of the hook under test, short enough to measure.
const RETRY_DELAYS = [40, 80];

test("formats credits like the context badge", () => {
  assert.equal(formatAccountQuotaCredits(0), "0");
  assert.equal(formatAccountQuotaCredits(935), "935");
  assert.equal(formatAccountQuotaCredits(3_007), "3.0K");
  assert.equal(formatAccountQuotaCredits(24_992), "25.0K");
  assert.equal(formatAccountQuotaCredits(104_664), "104.7K");
  assert.equal(formatAccountQuotaCredits(140_000), "140K");
  assert.equal(formatAccountQuotaCredits(1_200_000), "1.2M");
  assert.equal(formatAccountQuotaCredits(Number.NaN), "-");
});

test("levels follow how full the pool is", () => {
  assert.equal(accountQuotaLevel(0), "normal");
  assert.equal(accountQuotaLevel(69), "normal");
  assert.equal(accountQuotaLevel(70), "warning");
  assert.equal(accountQuotaLevel(89), "warning");
  assert.equal(accountQuotaLevel(90), "danger");
  assert.equal(accountQuotaLevel(100), "danger");
});

test("formats the time left and the moment a pool resets", () => {
  assert.equal(formatAccountQuotaDuration(30_000), "0m");
  assert.equal(formatAccountQuotaDuration(44 * MINUTE), "44m");
  assert.equal(formatAccountQuotaDuration(HOUR), "1h");
  assert.equal(formatAccountQuotaDuration(178 * MINUTE), "2h 58m");
  assert.equal(formatAccountQuotaDuration(24 * HOUR), "1d");
  assert.equal(formatAccountQuotaDuration(27 * HOUR), "1d 3h");

  assert.equal(formatAccountQuotaReset(undefined, NOW), undefined);
  assert.equal(formatAccountQuotaReset(Number.NaN, NOW), undefined);
  assert.equal(formatAccountQuotaReset(NOW - HOUR, NOW), "resets now");
  assert.equal(formatAccountQuotaReset(NOW + 30_000, NOW), "resets now");
  assert.equal(formatAccountQuotaReset(NOW + 178 * MINUTE, NOW), "resets in 2h 58m");
  // Within a day the time left is what matters, beyond it the moment.
  assert.equal(formatAccountQuotaReset(NOW + 23 * HOUR, NOW), "resets in 23h");
  assert.equal(
    formatAccountQuotaReset(NOW + 27 * HOUR, NOW),
    `resets ${localDate(NOW + 27 * HOUR)} (in 1d 3h)`,
  );
});

test("builds the row parts, leaving out pools that already reset", () => {
  const usage = usageAt();
  assert.deepEqual(usage.parts, [
    { label: "week 74%", level: "warning" },
    { label: "5h 10%", level: "normal" },
  ]);
  assert.deepEqual(usage.windows, [WEEK, FIVE_HOURS]);
  assert.equal(usage.planLabel, "Max, renews 07.12");

  // The 5-hour pool reset a moment ago: nothing is known about it until the
  // next read. (The snapshot itself must still be fresh.)
  const afterReset = NOW + 178 * MINUTE + 1;
  const fiveHoursGone = createAccountQuotaUsage({ ...SNAPSHOT, fetchedAt: afterReset - MINUTE }, afterReset);
  assert.deepEqual(
    fiveHoursGone?.parts.map((part) => part.label),
    ["week 74%"],
  );
  // Every pool reset: nothing to show.
  const weekGone = afterReset + 27 * HOUR - 178 * MINUTE;
  assert.equal(
    createAccountQuotaUsage({ ...SNAPSHOT, fetchedAt: weekGone - MINUTE }, weekGone),
    undefined,
  );
  // Nobody could refresh the numbers for a while.
  assert.equal(createAccountQuotaUsage(SNAPSHOT, NOW + ACCOUNT_QUOTA_STALE_MS)?.parts.length, 2);
  assert.equal(createAccountQuotaUsage(SNAPSHOT, NOW + ACCOUNT_QUOTA_STALE_MS + 1), undefined);
  assert.equal(createAccountQuotaUsage(undefined, NOW), undefined);
  assert.equal(createAccountQuotaUsage({ fetchedAt: NOW, windows: [] }, NOW), undefined);
});

test("names the plan by tier, by name, and by how it ends", () => {
  const planLabel = (snapshot: Partial<AccountQuotaSnapshot>) =>
    createAccountQuotaUsage({ ...SNAPSHOT, ...snapshot }, NOW)?.planLabel;
  assert.equal(planLabel({}), "Max, renews 07.12");
  assert.equal(planLabel({ planDate: undefined }), "Max plan");
  assert.equal(planLabel({ expires: true, planDate: "07.01" }), "Max, expires 07.01");
  assert.equal(planLabel({ level: " pro " }), "Pro, renews 07.12");
  assert.equal(planLabel({ level: undefined, planName: "GLM Coding Max" }), "GLM Coding Max, renews 07.12");
  assert.equal(planLabel({ level: undefined, planDate: undefined }), undefined);
  assert.equal(planLabel({ level: "  ", planName: "GLM Coding Max" }), "GLM Coding Max, renews 07.12");
});

test("the notice lists the pools, then the plan, as clauses of falling importance", () => {
  const usage = usageAt();
  assert.deepEqual(accountQuotaNoticeClauses(usage, NOW), NOTICE_CLAUSES);
  assert.deepEqual(accountQuotaNotice(usage, NOW), {
    text: NOTICE_CLAUSES.join(STATUS_NOTICE_CLAUSE_SEPARATOR),
  });
  // A pool without a reset time still tells what it can.
  const noReset = createAccountQuotaUsage(
    { fetchedAt: NOW, windows: [{ ...WEEK, nextResetAt: undefined }] },
    NOW,
  );
  assert.ok(noReset);
  assert.equal(
    accountQuotaNotice(noReset, NOW).text,
    "week 74% (104.7K/140K), reset time unknown",
  );
  assert.deepEqual(accountQuotaPendingNotice(), { text: ACCOUNT_QUOTA_PENDING_NOTICE_TEXT });
});

test("shows the quota between the model and the context badge, one node per pool", () => {
  const nodes = collectTextNodes(
    inputActiveStatusRow(COPY, undefined, { ...STATUS_OPTIONS, accountQuota: usageAt(), contentWidth: 120 }),
  );
  const labels = ["week 74%", " · ", "5h 10%"];

  assert.deepEqual(nodes.map((node) => node.text), [
    "GLM-5.3",
    " · ",
    "high",
    "  ",
    ...labels,
    "  ",
    BADGE,
    " ",
    "🔄",
  ]);
  const [week, separator, fiveHours] = nodes.slice(4, 7);
  assert.deepEqual(week?.style, { fg: palette.warning, flexShrink: 0 });
  assert.deepEqual(separator?.style, { fg: palette.muted, flexShrink: 0 });
  assert.deepEqual(fiveHours?.style, { fg: palette.muted, flexShrink: 0 });

  // The memory segment stays first.
  assert.deepEqual(
    collectTextNodes(
      inputActiveStatusRow(COPY, undefined, {
        ...STATUS_OPTIONS,
        accountQuota: usageAt(),
        contentWidth: 120,
        processMemory: MEMORY,
      }),
    ).map((node) => node.text),
    ["ram 610M · commit 520M", "  ", "GLM-5.3", " · ", "high", "  ", ...labels, "  ", BADGE, " ", "🔄"],
  );
});

test("a click on a pool wakes the handler", () => {
  let clicks = 0;
  const nodes = collectTextNodes(
    inputActiveStatusRow(COPY, undefined, {
      ...STATUS_OPTIONS,
      accountQuota: usageAt(),
      contentWidth: 120,
      onStatusQuotaMouseDown: () => {
        clicks += 1;
      },
    }),
  );
  const [week, separator, fiveHours] = nodes.slice(4, 7);
  assert.ok(week?.onMouseDown && fiveHours?.onMouseDown);

  let prevented = 0;
  let stopped = 0;
  for (const node of [week, fiveHours]) {
    node?.onMouseDown?.({
      preventDefault: () => {
        prevented += 1;
      },
      stopPropagation: () => {
        stopped += 1;
      },
    });
  }
  assert.equal(clicks, 2);
  assert.equal(prevented, 2);
  assert.equal(stopped, 2);
  // The separator between the pools is not a target of its own.
  assert.equal(separator?.onMouseDown, undefined);
});

test("colors each pool by how full it is", () => {
  const styleOf = (label: string, level: "danger" | "normal" | "warning") =>
    collectTextNodes(
      inputActiveStatusRow(COPY, undefined, {
        ...STATUS_OPTIONS,
        accountQuota: { parts: [{ label, level }], windows: [WEEK] },
        contentWidth: 120,
      }),
    ).find((node) => node.text === label)?.style;
  assert.deepEqual(styleOf("week 40%", "normal"), { fg: palette.muted, flexShrink: 0 });
  assert.deepEqual(styleOf("week 75%", "warning"), { fg: palette.warning, flexShrink: 0 });
  assert.deepEqual(styleOf("5h 96%", "danger"), { fg: palette.danger, flexShrink: 0 });
});

test("on a narrow terminal the effort and the model give way before the quota", () => {
  const quota = ["week 74%", " · ", "5h 10%"];
  const badgeThenGlyph = [BADGE, " ", "🔄"];
  const quotaThenBadge = [...quota, "  ", ...badgeThenGlyph];
  const textsAt = (contentWidth: number) =>
    collectTextNodes(
      inputActiveStatusRow(COPY, undefined, { ...STATUS_OPTIONS, accountQuota: usageAt(), contentWidth }),
    ).map((node) => node.text);

  // 34 cells for model, effort, glyph and badge, 2 for the gap, 17 for the quota.
  assert.deepEqual(textsAt(54), ["GLM-5.3", " · ", "high", "  ", ...quotaThenBadge]);
  // One cell short: the effort goes, the quota stays whole.
  assert.deepEqual(textsAt(53), ["GLM-5.3", "  ", ...quotaThenBadge]);
  // Then the model is shortened, and dropped.
  assert.deepEqual(textsAt(44), ["G...", "  ", ...quotaThenBadge]);
  assert.deepEqual(textsAt(43), quotaThenBadge);
  assert.deepEqual(textsAt(38), quotaThenBadge);
  // Both pools no longer fit: only the fuller one stays, ahead of a shortened model.
  assert.deepEqual(textsAt(37), ["GLM...", "  ", "week 74%", "  ", ...badgeThenGlyph]);
  assert.deepEqual(textsAt(34), ["week 74%", "  ", ...badgeThenGlyph]);
  assert.deepEqual(textsAt(29), ["week 74%", "  ", ...badgeThenGlyph]);
  // The badge and the compact glyph outrank the quota.
  assert.deepEqual(textsAt(28), ["GLM-5.3", "  ", ...badgeThenGlyph]);
  assert.deepEqual(textsAt(24), badgeThenGlyph);
});

test("keeps only the fuller pool when both no longer fit", () => {
  // The 5-hour pool is the one worth watching here, though it comes second.
  const accountQuota = createAccountQuotaUsage(
    {
      fetchedAt: NOW,
      windows: [
        { ...WEEK, usedPercent: 12 },
        { ...FIVE_HOURS, usedCredits: 26_900, remainingCredits: 1_100, usedPercent: 96 },
      ],
    },
    NOW,
  );
  assert.ok(accountQuota);
  const textsAt = (contentWidth: number) =>
    collectTextNodes(
      inputActiveStatusRow(COPY, undefined, { ...STATUS_OPTIONS, accountQuota, contentWidth }),
    ).map((node) => node.text);

  // 6 cells for "5h 96%", 2 for the gap, 3 for the glyph with its gap, 15 for the badge.
  assert.deepEqual(textsAt(27), ["5h 96%", "  ", BADGE, " ", "🔄"]);
  assert.deepEqual(textsAt(54), ["GLM-5.3", " · ", "high", "  ", "week 12%", " · ", "5h 96%", "  ", BADGE, " ", "🔄"]);
  // One cell less than the pool needs: the quota is gone and the model takes the room.
  assert.deepEqual(textsAt(26), ["GL...", "  ", BADGE, " ", "🔄"]);
});

test("keeps the row unchanged when no quota is known", () => {
  const texts = collectTextNodes(
    inputActiveStatusRow(COPY, undefined, { ...STATUS_OPTIONS, accountQuota: undefined, contentWidth: 120 }),
  ).map((node) => node.text);
  assert.deepEqual(texts, ["GLM-5.3", " · ", "high", "  ", BADGE, " ", "🔄"]);
  assert.equal(texts.some((text) => /^(?:week|\d+h) \d+%$/u.test(text)), false);
});

test("a quota notice owns the row and loses whole clauses before any is cut", () => {
  const frame = spinnerFrame(0);
  const busyLeftWidth = displayWidth(frame) + 1 + displayWidth(COPY.input.activeStatusHint);
  const [week, fiveHours, plan] = NOTICE_CLAUSES;
  const full = NOTICE_CLAUSES.join(STATUS_NOTICE_CLAUSE_SEPARATOR);
  const textsAt = (availableWidth: number) =>
    collectTextNodes(
      inputActiveStatusRow(COPY, frame, {
        ...STATUS_OPTIONS,
        // padding + busy hint + spacer are not part of the available width
        contentWidth: availableWidth + busyLeftWidth + 2,
        accountQuota: usageAt(),
        notice: accountQuotaNotice(usageAt(), NOW),
        processMemory: MEMORY,
      }),
    ).map((node) => node.text);
  const left = [frame, " ", COPY.input.activeStatusHint];

  // Model, effort, memory and the quota give way; the context badge with the compact glyph stay
  // (the glyph with its gap takes 3 cells).
  assert.deepEqual(textsAt(displayWidth(full) + 2 + 3 + displayWidth(BADGE)), [
    ...left,
    full,
    "  ",
    BADGE,
    " ",
    "🔄",
  ]);
  // No room for the whole notice: the plan clause goes first, then the 5-hour one.
  assert.deepEqual(textsAt(displayWidth(full) - 1), [...left, `${week} · ${fiveHours}`, "  ", BADGE]);
  assert.deepEqual(textsAt(displayWidth(week)), [...left, week]);
  // A single clause is shortened like any text.
  const narrow = displayWidth(week) - 12;
  assert.deepEqual(textsAt(narrow), [...left, truncateDisplay(week, narrow)]);
});

// A reader the test answers by hand: every call waits until `release` settles
// it, so each read is an event the test controls.
function gatedReader() {
  const state = { calls: 0, inputs: [] as Array<{ providerId?: string }> };
  const pending: Array<{
    reject: (error: Error) => void;
    resolve: (snapshot: AccountQuotaSnapshot | undefined) => void;
  }> = [];
  const read = ({ providerId }: { providerId?: string } = {}) => {
    state.inputs.push({ providerId });
    state.calls += 1;
    return new Promise<AccountQuotaSnapshot | undefined>((resolve, reject) => {
      pending.push({ reject, resolve });
    });
  };
  const release = (step: AccountQuotaSnapshot | undefined | Error): void => {
    const gate = pending.shift();
    if (!gate) return;
    if (step instanceof Error) gate.reject(step);
    else gate.resolve(step);
  };
  return { read, release, state };
}

type Reader = ReturnType<typeof gatedReader>;
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

// Waits, in one act scope, until the reader has been called `until` times.
async function waitReaderCalls(view: TestView, reader: Reader, until: number): Promise<void> {
  await act(async () => {
    for (let attempt = 0; attempt < 160 && reader.state.calls < until; attempt += 1) {
      await sleep(25);
    }
    await view.renderOnce();
  });
  assert.ok(reader.state.calls >= until);
}

// Answers the pending reader call in an act scope, so the update it causes is
// an act update; React renders when the scope ends, so the frame is painted in
// a second scope.
async function releaseReader(view: TestView, reader: Reader, step: AccountQuotaSnapshot | undefined | Error) {
  await act(async () => {
    reader.release(step);
    await sleep(25);
  });
  await act(async () => {
    await view.renderOnce();
  });
}

async function destroy(view: TestView): Promise<void> {
  await act(async () => {
    view.renderer.destroy();
  });
}

test("polls the quota and keeps the state while the shown values are unchanged", async () => {
  const reader = gatedReader();
  const seen: Array<AccountQuotaUsage | undefined> = [];
  const clock = { now: NOW };
  function Probe() {
    const { usage } = useAccountQuota({
      firstReadDelayMs: 5,
      intervalMs: 5,
      now: () => clock.now,
      read: reader.read,
    });
    seen.push(usage);
    return React.createElement(
      "text",
      null,
      usage ? usage.parts.map((part) => part.label).join("|") : "none",
    );
  }
  const view = await mountProbe(React.createElement(Probe));

  try {
    assert.equal(view.captureCharFrame().includes("week"), false);
    await waitReaderCalls(view, reader, 1);
    assert.deepEqual(reader.state.inputs, [{ providerId: undefined }]);
    await releaseReader(view, reader, SNAPSHOT);
    const first = seen.at(-1);
    assert.deepEqual(first?.parts.map((part) => part.label), ["week 74%", "5h 10%"]);
    assert.equal(view.captureCharFrame().includes("week 74%|5h 10%"), true);

    // The same values from a newer read is not a state change.
    clock.now += MINUTE;
    await waitReaderCalls(view, reader, 2);
    await releaseReader(view, reader, { ...SNAPSHOT, fetchedAt: clock.now });
    assert.equal(seen.at(-1), first);

    // A pool that fills up changes its level.
    clock.now += MINUTE;
    await waitReaderCalls(view, reader, 3);
    await releaseReader(view, reader, {
      ...SNAPSHOT,
      fetchedAt: clock.now,
      windows: [{ ...WEEK, usedPercent: 91 }, FIVE_HOURS],
    });
    assert.notEqual(seen.at(-1), first);
    assert.deepEqual(seen.at(-1)?.parts, [
      { label: "week 91%", level: "danger" },
      { label: "5h 10%", level: "normal" },
    ]);
  } finally {
    await destroy(view);
  }
});

test("keeps the last quota when a read fails, backs off, and drops a pool once it resets", async () => {
  const reader = gatedReader();
  const clock = { now: NOW };
  const calledAt: number[] = [];
  const read = (input: { providerId?: string }) => {
    calledAt.push(performance.now());
    return reader.read(input);
  };
  const seen: Array<AccountQuotaUsage | undefined> = [];
  function Probe() {
    const { usage } = useAccountQuota({
      firstReadDelayMs: 5,
      intervalMs: 5,
      now: () => clock.now,
      read,
      retryDelaysMs: RETRY_DELAYS,
    });
    seen.push(usage);
    return React.createElement("text", null, usage ? usage.parts.map((part) => part.label).join("|") : "none");
  }
  const view = await mountProbe(React.createElement(Probe));

  try {
    await waitReaderCalls(view, reader, 1);
    // The 5-hour pool is about to reset.
    const closeReset = { ...SNAPSHOT, windows: [WEEK, { ...FIVE_HOURS, nextResetAt: NOW + 2 * MINUTE }] };
    await releaseReader(view, reader, closeReset);
    const known = seen.at(-1);

    // The read fails: the last quota stays.
    await waitReaderCalls(view, reader, 2);
    await releaseReader(view, reader, new Error("offline"));
    assert.equal(seen.at(-1), known);
    assert.equal(view.captureCharFrame().includes("week 74%|5h 10%"), true);
    // ... and the next attempt waits for the first retry delay, not the interval.
    await waitReaderCalls(view, reader, 3);
    assert.ok(calledAt[2]! - calledAt[1]! >= 35, "first retry comes after the first delay");

    // It fails again after the 5-hour pool has reset: that pool is not shown anymore.
    clock.now = NOW + 2 * MINUTE + 1;
    await releaseReader(view, reader, new Error("offline"));
    assert.deepEqual(seen.at(-1)?.parts.map((part) => part.label), ["week 74%"]);
    assert.equal(view.captureCharFrame().includes("week 74%|5h 10%"), false);
    // The second failure backs off further.
    await waitReaderCalls(view, reader, 4);
    assert.ok(calledAt[3]! - calledAt[2]! >= 70, "second retry comes after the second delay");
  } finally {
    await destroy(view);
  }
});

test("stops polling while the account has no readable quota", async () => {
  const reader = gatedReader();
  const calledAt: number[] = [];
  const read = () => {
    calledAt.push(performance.now());
    return reader.read();
  };
  const seen: Array<AccountQuotaUsage | undefined> = [];
  function Probe() {
    const { usage } = useAccountQuota({
      firstReadDelayMs: 5,
      intervalMs: 5,
      read,
      unavailableRetryMs: 60,
    });
    seen.push(usage);
    return React.createElement("text", null, usage ? "known" : "none");
  }
  const view = await mountProbe(React.createElement(Probe));

  try {
    await waitReaderCalls(view, reader, 1);
    await releaseReader(view, reader, undefined);
    assert.equal(view.captureCharFrame().includes("known"), false);
    // Nothing to show and nothing to retry fast: the next look comes much later.
    await waitReaderCalls(view, reader, 2);
    assert.ok(calledAt[1]! - calledAt[0]! >= 55, "an unavailable account is not polled at the interval");
    assert.deepEqual([...new Set(seen)], [undefined]);
    await releaseReader(view, reader, liveSnapshot());
    assert.equal(view.captureCharFrame().includes("known"), true);
  } finally {
    await destroy(view);
  }
});

test("a refresh asks for a read at once; one asked for during a read follows it", async () => {
  const reader = gatedReader();
  let refresh: () => void = () => undefined;
  function Probe() {
    const quota = useAccountQuota({ firstReadDelayMs: 5, intervalMs: 60_000, read: reader.read });
    refresh = quota.refresh;
    return React.createElement("text", null, quota.usage ? "known" : "none");
  }
  const view = await mountProbe(React.createElement(Probe));

  try {
    // The first read is still running when the refresh comes: no second concurrent read.
    await waitReaderCalls(view, reader, 1);
    await act(async () => {
      refresh();
      await settle();
    });
    assert.equal(reader.state.calls, 1);

    // The running read lands and the refresh gets a read of its own right after.
    await releaseReader(view, reader, liveSnapshot());
    assert.equal(view.captureCharFrame().includes("known"), true);
    assert.equal(reader.state.calls, 2);
    await releaseReader(view, reader, liveSnapshot());
    assert.equal(reader.state.calls, 2);

    // With no read running, a refresh reads at once instead of waiting for the interval.
    await act(async () => {
      refresh();
      await settle();
    });
    await waitReaderCalls(view, reader, 3);
    await releaseReader(view, reader, SNAPSHOT);
  } finally {
    await destroy(view);
  }
});

test("another provider is another account: its numbers do not carry over", async () => {
  const reader = gatedReader();
  let switchProvider: (providerId: string) => void = () => undefined;
  function Probe() {
    const [providerId, setProviderId] = React.useState("zai-api");
    switchProvider = setProviderId;
    const { usage } = useAccountQuota({
      firstReadDelayMs: 5,
      intervalMs: 60_000,
      providerId,
      read: reader.read,
      unavailableRetryMs: 50,
    });
    return React.createElement("text", null, usage ? "known" : "none");
  }
  const view = await mountProbe(React.createElement(Probe));

  try {
    await waitReaderCalls(view, reader, 1);
    assert.deepEqual(reader.state.inputs, [{ providerId: "zai-api" }]);
    await releaseReader(view, reader, liveSnapshot());
    assert.equal(view.captureCharFrame().includes("known"), true);

    // The switch is painted in a scope of its own: React commits it when the
    // scope that took the update ends.
    await act(async () => {
      switchProvider("other-provider");
    });
    await act(async () => {
      await view.renderOnce();
    });
    assert.equal(view.captureCharFrame().includes("known"), false);
    await waitReaderCalls(view, reader, 2);
    assert.deepEqual(reader.state.inputs.at(-1), { providerId: "other-provider" });
    // The other account has no readable quota: the old numbers do not come back.
    await releaseReader(view, reader, undefined);
    assert.equal(view.captureCharFrame().includes("known"), false);
    await waitReaderCalls(view, reader, 3);
    assert.deepEqual(reader.state.inputs.at(-1), { providerId: "other-provider" });
    await releaseReader(view, reader, liveSnapshot());
    assert.equal(view.captureCharFrame().includes("known"), true);
  } finally {
    await destroy(view);
  }
});

test("nothing is read without a reader", async () => {
  let refresh: () => void = () => undefined;
  function Probe() {
    const quota = useAccountQuota({});
    refresh = quota.refresh;
    return React.createElement("text", null, quota.usage ? "known" : "none");
  }
  const view = await mountProbe(React.createElement(Probe));
  try {
    await act(async () => {
      refresh();
      await sleep(30);
    });
    assert.equal(view.captureCharFrame().includes("known"), false);
  } finally {
    await destroy(view);
  }
});

test("clicking the quota shows the details as a notice and asks for a fresh read", async () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const terminal = await createTestRenderer({
    exitOnCtrlC: false,
    height: 24,
    screenMode: "alternate-screen",
    targetFps: 30,
    useThread: false,
    // Wide enough for the whole notice next to the compact glyph.
    width: 200,
  });
  let resolveThemeMode!: (mode: UiThemeMode) => void;
  terminal.renderer.waitForThemeMode = () => new Promise<UiThemeMode>((resolve) => {
    resolveThemeMode = resolve;
  });
  const reader = gatedReader();
  const copied: string[] = [];
  const options: TuiOptions = {
    initialModel: "zai-api/GLM-5.4",
    locale: "en-US",
    noColor: true,
    readAccountQuota: reader.read,
    // No memory segment in this test.
    readProcessMemory: async () => ({}),
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

  const live = liveSnapshot();

  try {
    let rows: string[] = [];
    for (let attempt = 0; attempt < 120 && reader.state.calls === 0; attempt += 1) {
      await act(async () => {
        await sleep(50);
      });
      rows = await frameRows();
    }
    assert.equal(reader.state.calls, 1);
    assert.deepEqual(reader.state.inputs, [{ providerId: "zai-api" }]);
    await act(async () => {
      reader.release(live);
      await sleep(25);
    });
    rows = await frameRows();
    const quotaRow = rows.findIndex((line) => line.includes("week 74% · 5h 10%"));
    assert.notEqual(quotaRow, -1);
    const quotaColumn = rows[quotaRow]?.indexOf("week 74%") ?? -1;
    assert.ok(quotaColumn >= 0);

    await act(async () => {
      terminal.mockMouse.click(quotaColumn + 2, quotaRow);
      await settle();
    });
    rows = await frameRows();
    // The segment gave way to its details; the read the click asks for is running.
    const noticeRow = rows.findIndex((line) => line.includes("week 74% (104.7K/140K)"));
    assert.notEqual(noticeRow, -1);
    assert.ok(rows[noticeRow]?.includes("Max, renews 07.12"));
    assert.equal(rows.some((line) => line.includes("week 74% · 5h 10%")), false);
    assert.equal(reader.state.calls, 2);

    // The notice follows the fresh numbers. The reset times stay on the real
    // clock this test runs on: a window whose reset lies in the past is not shown.
    const [week, fiveHours] = live.windows;
    assert.ok(week && fiveHours);
    await act(async () => {
      reader.release({ ...live, windows: [{ ...week, usedPercent: 92 }, fiveHours] });
      await sleep(25);
    });
    rows = await frameRows();
    assert.ok(rows.some((line) => line.includes("week 92% (104.7K/140K)")));
    assert.equal(copied.length, 0);
  } finally {
    await act(async () => {
      resolveThemeMode("dark");
      terminal.renderer.destroy();
    });
    await outcome;
    environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

// /usage is handled in the CLI; what reaches the TUI is its report as the
// response of the command.
const USAGE_REPORT = [
  "```",
  "Coding Plan usage - GLM Coding Max, renews 07.12",
  "",
  `Week     ${"█".repeat(22)}${"░".repeat(8)}  74.8% used`,
  "         104.7K of 140K credits, 35.3K left, resets 25.11 10:12 (in 1d 3h)",
  "",
  `5 hours  ${"█".repeat(3)}${"░".repeat(27)}  10.7% used`,
  "         3.0K of 28K credits, 25.0K left, resets in 2h 58m",
  "```",
].join("\n");

test("the /usage report keeps its columns in the transcript: one cell per bar block", async () => {
  // Both block glyphs are single cells for the TUI's own width measure.
  assert.equal(displayWidth("█░"), 2);
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const terminal = await createTestRenderer({
    exitOnCtrlC: false,
    height: 30,
    screenMode: "alternate-screen",
    targetFps: 30,
    useThread: false,
    width: 120,
  });
  let resolveThemeMode!: (mode: UiThemeMode) => void;
  terminal.renderer.waitForThemeMode = () => new Promise<UiThemeMode>((resolve) => {
    resolveThemeMode = resolve;
  });
  const submitted: string[] = [];
  const options: TuiOptions = {
    locale: "en-US",
    noColor: true,
    readProcessMemory: async () => ({}),
    slashCommands: [{ name: "usage", summary: "Show the Coding Plan quota usage.", usage: "/usage" }],
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    submitPrompt: async (input) => {
      submitted.push(typeof input === "string" ? input : input.text);
      return { response: USAGE_REPORT };
    },
    workspaceDirectory: "/test/workspace",
    writeClipboardText: async () => undefined,
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
    await act(async () => {
      terminal.mockInput.typeText("/usage");
    });
    await act(async () => {
      terminal.mockInput.pressEnter();
    });
    let rows: string[] = [];
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await act(async () => {
        await sleep(50);
      });
      rows = await frameRows();
      if (rows.some((line) => line.includes("74.8% used"))) break;
    }
    assert.deepEqual(submitted, ["/usage"]);

    const weekRow = rows.findIndex((line) => line.includes("74.8% used"));
    assert.notEqual(weekRow, -1);
    assert.match(rows[weekRow] ?? "", /Week {5}█{22}░{8} {2}74\.8% used/);
    assert.match(rows[weekRow + 1] ?? "", /104\.7K of 140K credits, 35\.3K left, resets 25\.11 10:12 \(in 1d 3h\)/);
    // The credits start where the bar starts: the columns survived the layout.
    assert.equal(rows[weekRow]?.indexOf("█"), rows[weekRow + 1]?.indexOf("104.7K"));

    const fiveHoursRow = rows.findIndex((line) => line.includes("10.7% used"));
    assert.notEqual(fiveHoursRow, -1);
    assert.match(rows[fiveHoursRow] ?? "", /5 hours {2}█{3}░{27} {2}10\.7% used/);
    assert.match(rows[fiveHoursRow + 1] ?? "", /3\.0K of 28K credits, 25\.0K left, resets in 2h 58m/);
    assert.equal(rows[fiveHoursRow]?.indexOf("█"), rows[fiveHoursRow + 1]?.indexOf("3.0K"));
    assert.equal(rows[weekRow]?.indexOf("█"), rows[fiveHoursRow]?.indexOf("█"));
    assert.ok(rows.some((line) => line.includes("Coding Plan usage - GLM Coding Max, renews 07.12")));
  } finally {
    await act(async () => {
      resolveThemeMode("dark");
      terminal.renderer.destroy();
    });
    await outcome;
    environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});
