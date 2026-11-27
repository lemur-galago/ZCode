import assert from "node:assert/strict";
import test from "node:test";
import { createTestRenderer } from "@mbears/opentui-core/testing";
import { testRender } from "@mbears/opentui-react/test-utils";
import { SessionEventType, type SessionEvent, type UiThemeMode } from "@zcode/contracts";
import { getZCodeCopy } from "@zcode/i18n";
import React, { act } from "react";
import { inputActiveStatusRow } from "../src/app-input-status.js";
import { palette } from "../src/app-model.js";
import { spinnerFrame } from "../src/app-motion.js";
import { runTuiWithRenderer } from "../src/tui.js";
import type { TuiOptions } from "../src/types.js";

// Local patch (status-compact-button): the compact glyph closes the status row,
// right after the context badge (user asked for it at the far right).

const COPY = getZCodeCopy("en-US").tui;
const BADGE = "45.2K / 1M (5%)";
const GLYPH = "🔄";
const STATUS_OPTIONS = {
  contextUsage: { contextUsed: 45_231, contextWindow: 1_000_000 },
  model: "zai-api/GLM-5.3",
  thoughtLevel: "high",
};
const SESSION_ID = "sess_1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

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

const rowTexts = (options: Parameters<typeof inputActiveStatusRow>[2]) =>
  collectTextNodes(inputActiveStatusRow(COPY, undefined, options)).map((node) => node.text);

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type ActEnvironment = { IS_REACT_ACT_ENVIRONMENT?: boolean };
const actEnvironment = globalThis as typeof globalThis & ActEnvironment;

test("the compact glyph is the last segment, one cell after the context badge", () => {
  let clicks = 0;
  const nodes = collectTextNodes(
    inputActiveStatusRow(COPY, undefined, {
      ...STATUS_OPTIONS,
      contentWidth: 120,
      onStatusCompactMouseDown: () => {
        clicks += 1;
      },
    }),
  );

  assert.deepEqual(nodes.map((node) => node.text), ["GLM-5.3", " · ", "high", "  ", BADGE, " ", GLYPH]);
  // The badge and the gaps are plain text; only the glyph closes the row as a target.
  assert.deepEqual(
    nodes.slice(3).map((node) => typeof node.onMouseDown),
    ["undefined", "undefined", "undefined", "function"],
  );

  const glyph = nodes[6];
  assert.deepEqual(glyph?.style, { fg: palette.accent, flexShrink: 0 });
  let prevented = 0;
  let stopped = 0;
  glyph?.onMouseDown?.({
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

test("without a click handler the row has no glyph", () => {
  assert.deepEqual(rowTexts({ ...STATUS_OPTIONS, contentWidth: 120 }), [
    "GLM-5.3",
    " · ",
    "high",
    "  ",
    BADGE,
  ]);
});

test("before the first response of a session the glyph follows the model and the effort", () => {
  // No context usage yet: the badge is hidden, the usual gap separates the glyph.
  assert.deepEqual(
    rowTexts({
      ...STATUS_OPTIONS,
      contextUsage: undefined,
      contentWidth: 120,
      onStatusCompactMouseDown: () => undefined,
    }),
    ["GLM-5.3", " · ", "high", "  ", GLYPH],
  );
});

test("a notice owns the row and the glyph still closes it", () => {
  const frame = spinnerFrame(0);
  const nodes = collectTextNodes(
    inputActiveStatusRow(COPY, frame, {
      ...STATUS_OPTIONS,
      contentWidth: 120,
      notice: { command: `zcode --resume ${SESSION_ID}`, text: "Restart to free memory:" },
      onStatusCompactMouseDown: () => undefined,
    }),
  );

  assert.deepEqual(nodes.map((node) => node.text), [
    frame,
    " ",
    COPY.input.activeStatusHint,
    "Restart to free memory:",
    " ",
    `zcode --resume ${SESSION_ID}`,
    "  ",
    BADGE,
    " ",
    GLYPH],
  );
});

test("a rendered row ends with the glyph and only its cells take the click", async () => {
  const width = 60;
  let clicks = 0;
  const view = await testRender(
    inputActiveStatusRow(COPY, undefined, {
      ...STATUS_OPTIONS,
      contentWidth: width,
      onStatusCompactMouseDown: () => {
        clicks += 1;
      },
    }),
    { height: 1, width },
  );

  try {
    await act(async () => {
      await view.renderOnce();
    });
    const row = view.captureCharFrame().split("\n")[0] ?? "";
    // The glyph is the last cell pair of the row, one cell after the badge. The
    // second cell of the emoji has no character of its own in the frame, so the
    // row counts one code unit per cell.
    assert.ok(row.endsWith(`${BADGE} ${GLYPH}`), JSON.stringify(row));
    assert.equal(row.length, width);

    const click = async (column: number) => {
      await act(async () => {
        await view.mockMouse.click(column, 0);
      });
    };
    await click(width - 2);
    await click(width - 1);
    assert.equal(clicks, 2);
    // The gap and the badge next to the glyph are not targets.
    for (const column of [width - 3, width - 4, width - 10]) {
      await click(column);
    }
    assert.equal(clicks, 2);
  } finally {
    await act(async () => {
      view.renderer.destroy();
    });
  }
});

test("in the whole TUI the glyph is the last thing on the status row and a click submits /compact", async () => {
  const width = 110;
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const terminal = await createTestRenderer({
    exitOnCtrlC: false,
    height: 24,
    screenMode: "alternate-screen",
    targetFps: 30,
    useThread: false,
    width,
  });
  let resolveThemeMode!: (mode: UiThemeMode) => void;
  terminal.renderer.waitForThemeMode = () =>
    new Promise<UiThemeMode>((resolve) => {
      resolveThemeMode = resolve;
    });
  let finishTurn!: () => void;
  const turn = new Promise<void>((resolve) => {
    finishTurn = resolve;
  });
  const submitted: string[] = [];
  const options: TuiOptions = {
    locale: "en-US",
    noColor: true,
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    submitPrompt: async (input, submitOptions) => {
      submitted.push(input);
      if (input !== "hello") return { response: "unused" };
      // The first response of the session brings the context badge.
      await submitOptions.onEvent?.(
        sessionEvent(SessionEventType.ModelSelected, {
          contextWindow: 1_000_000,
          modelSelection: { modelId: "GLM-5.4", options: { reasoningLevel: "max" }, providerId: "zai-api" },
        }),
      );
      await submitOptions.onEvent?.(
        sessionEvent(SessionEventType.ModelComplete, {
          usage: { inputTokens: 165_000, outputTokens: 1_200, totalTokens: 166_200 },
        }),
      );
      await turn;
      return { response: "done" };
    },
    workspaceDirectory: "/test/workspace",
  };
  let outcome: Promise<number> | undefined;
  const frameRows = async () => {
    await act(async () => {
      await terminal.renderOnce();
    });
    return terminal.captureCharFrame().split("\n");
  };
  const findBadgeRow = (rows: string[]) => rows.find((line) => line.includes("165K"));

  await act(async () => {
    outcome = runTuiWithRenderer(options, terminal.renderer);
    await terminal.renderOnce();
  });

  try {
    await act(async () => {
      await terminal.mockInput.typeText("hello");
      await settle();
      await terminal.renderOnce();
    });
    await act(async () => {
      terminal.mockInput.pressEnter();
      await settle();
    });
    let row: string | undefined;
    for (let attempt = 0; attempt < 40 && !row; attempt += 1) {
      await act(async () => {
        await sleep(50);
        await terminal.renderOnce();
      });
      row = findBadgeRow(terminal.captureCharFrame().split("\n"));
    }
    assert.ok(row, "the badge row is rendered");
    const closesRow = (line: string | undefined) => {
      const column = line?.indexOf(GLYPH) ?? -1;
      // The glyph follows the badge, and nothing visible comes after it: the
      // composer area keeps a blank margin column at its right edge.
      return column > 0 && line?.slice(0, column).endsWith("165K / 1M (17%) ") === true && line
        .slice(column + GLYPH.length)
        .trim() === "";
    };
    assert.ok(closesRow(row), JSON.stringify(row));

    // The turn ends; the row keeps the badge and the glyph.
    await act(async () => {
      finishTurn();
      await settle();
      await terminal.renderOnce();
    });
    const rows = await frameRows();
    const statusRow = rows.findIndex((line) => line.includes("165K"));
    assert.notEqual(statusRow, -1);
    assert.ok(closesRow(rows[statusRow]), JSON.stringify(rows[statusRow]));

    // Both cells of the glyph submit the command; the cell before it does not.
    const glyphColumn = rows[statusRow]?.indexOf(GLYPH) ?? -1;
    assert.ok(glyphColumn > 0);
    const clicksBefore = submitted.length;
    await act(async () => {
      await terminal.mockMouse.click(glyphColumn - 1, statusRow);
      await settle();
    });
    await frameRows();
    assert.equal(submitted.length, clicksBefore);
    for (const column of [glyphColumn, glyphColumn + 1]) {
      await act(async () => {
        await terminal.mockMouse.click(column, statusRow);
        await settle();
      });
      await frameRows();
    }
    assert.deepEqual(submitted.slice(clicksBefore), ["/compact", "/compact"]);
  } finally {
    await act(async () => {
      resolveThemeMode("dark");
      terminal.renderer.destroy();
    });
    await outcome;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

let sequenceNumber = 0;

function sessionEvent(type: SessionEventType, payload: unknown): SessionEvent {
  sequenceNumber += 1;
  return {
    id: `event-${sequenceNumber}`,
    payload,
    sequenceNumber,
    sessionId: "session-1",
    timestamp: new Date(0),
    traceId: "trace-1",
    type,
  } as SessionEvent;
}
