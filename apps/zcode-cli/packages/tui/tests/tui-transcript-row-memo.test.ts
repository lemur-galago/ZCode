// Local patch (transcript-row-memo).
import assert from "node:assert/strict";
import test from "node:test";
import { createTestRenderer } from "@mbears/opentui-core/testing";
import type { RGBA } from "@mbears/opentui-core";
import { SessionEventType, type SessionEvent, type UiThemeMode } from "@zcode/contracts";
import { getZCodeCopy } from "@zcode/i18n";
import React, { act } from "react";
import type { Message, ToolTranscriptPart } from "../src/app-model.js";
import {
  ContentPane,
  MemoizedMessageRow,
  MessageRow,
} from "../src/app-transcript-components.js";
import { applyToolTranscriptEvent } from "../src/app-tool-transcript.js";
import { runTuiWithRenderer } from "../src/tui.js";
import {
  DARK_TUI_THEME,
  LIGHT_TUI_THEME,
  getActiveTuiThemeMode,
  setActiveTuiThemeMode,
} from "../src/theme/index.js";
import type { TuiThemeTokens } from "../src/theme/index.js";
import type { TuiOptions } from "../src/types.js";

// Local patch (transcript-row-memo): every landing of stream text drew the
// whole transcript again, and that cost grew with the history. The transcript
// draws its rows through a memoized component now, so a landing draws the row
// whose message changed. The theme is a prop of the row: the row reads it while
// it renders, and a memoized row would have kept the colors of the old theme
// after a switch if the theme had stayed a module read.

const COPY = getZCodeCopy("en-US").tui;
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type ActEnvironment = { IS_REACT_ACT_ENVIRONMENT?: boolean };
const actEnvironment = globalThis as typeof globalThis & ActEnvironment;
type Span = { bg?: RGBA; text: string };
type MemoComponent = { type: (props: unknown) => React.ReactElement };

const propsOf = (element: unknown): Record<string, any> =>
  (element as { props: Record<string, any> }).props;
const childrenOf = (element: unknown): unknown[] => React.Children.toArray(propsOf(element).children);

/** Counts the draws of the memoized row, by the function React reaches: `type`. */
function countRowDraws(): {
  of: (content: string) => number;
  restore: () => void;
  total: () => number;
} {
  const memo = MemoizedMessageRow as unknown as MemoComponent;
  const inner = memo.type;
  let total = 0;
  const byKey = new Map<string, number>();
  memo.type = (props) => {
    // A streamed message has its text in parts; the id tells its rows apart.
    const message = (props as { message: Message }).message;
    const key = message.id ?? message.content;
    total += 1;
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
    return inner(props);
  };
  return {
    of: (key) => byKey.get(key) ?? 0,
    restore: () => {
      memo.type = inner;
    },
    total: () => total,
  };
}

test("a row is drawn in the theme it is given, not in the active one", () => {
  const previousMode = getActiveTuiThemeMode();
  setActiveTuiThemeMode("dark");
  try {
    const user: Message = { content: "hello", role: "user" };
    assert.equal(
      propsOf(MessageRow({ index: 0, message: user, theme: LIGHT_TUI_THEME })).style.backgroundColor,
      LIGHT_TUI_THEME.backgroundMessageUser,
    );
    assert.equal(
      propsOf(MessageRow({ index: 0, message: user, theme: DARK_TUI_THEME })).style.backgroundColor,
      DARK_TUI_THEME.backgroundMessageUser,
    );
    // A row that is not a user prompt takes the background of the theme.
    assert.equal(
      propsOf(MessageRow({ index: 0, message: { content: "x", role: "agent" }, theme: LIGHT_TUI_THEME }))
        .style.backgroundColor,
      LIGHT_TUI_THEME.background,
    );

    const system: Message = { content: "watch out", role: "system" };
    assert.equal(propsOf(childrenOf(MessageRow({ index: 0, message: system, theme: LIGHT_TUI_THEME }))[0]).style.fg, LIGHT_TUI_THEME.warning);

    const timeline: Message = {
      content: "",
      role: "timeline",
      timeline: { operationId: "op-1", status: "completed", type: "context_compaction" },
    };
    const line = MessageRow({ copy: COPY, index: 0, message: timeline, theme: LIGHT_TUI_THEME });
    // The row of a compaction is its own component; it gets the theme as well.
    assert.equal(propsOf(line).theme, LIGHT_TUI_THEME);

    // Without a theme the row takes the active one, as it always did.
    assert.equal(
      propsOf(MessageRow({ index: 0, message: user })).style.backgroundColor,
      DARK_TUI_THEME.backgroundMessageUser,
    );
  } finally {
    setActiveTuiThemeMode(previousMode);
  }
});

test("the transcript hands its theme to rows that are memoized", () => {
  const messages: Message[] = [
    { content: "one", role: "agent" },
    { content: "two", role: "user" },
  ];
  // The row the transcript draws is the memoized one, built on MessageRow.
  assert.equal((MemoizedMessageRow as unknown as { $$typeof: symbol }).$$typeof, Symbol.for("react.memo"));
  assert.equal((MemoizedMessageRow as unknown as MemoComponent).type, MessageRow);

  const rows = childrenOf(ContentPane({ focused: false, messages, theme: LIGHT_TUI_THEME }));
  assert.deepEqual(
    rows.map((row) => (row as { type: unknown }).type),
    [MemoizedMessageRow, MemoizedMessageRow],
  );
  assert.deepEqual(
    rows.map((row) => propsOf(row).theme),
    [LIGHT_TUI_THEME, LIGHT_TUI_THEME],
  );
  assert.deepEqual(
    rows.map((row) => propsOf(row).message),
    messages,
  );

  // Without a theme the transcript passes the active one.
  const previousMode = getActiveTuiThemeMode();
  setActiveTuiThemeMode("light");
  try {
    assert.equal(propsOf(childrenOf(ContentPane({ focused: false, messages }))[1]).theme, LIGHT_TUI_THEME);
  } finally {
    setActiveTuiThemeMode(previousMode);
  }
});

test("the scroll box keeps one style object per theme", () => {
  const pane = (theme: TuiThemeTokens) => propsOf(ContentPane({ focused: false, messages: [], theme })).style;
  const dark = pane(DARK_TUI_THEME);
  assert.equal(pane(DARK_TUI_THEME), dark, "the same object for the same theme");
  const light = pane(LIGHT_TUI_THEME);
  assert.notEqual(light, dark);
  assert.equal(dark.backgroundColor, DARK_TUI_THEME.background);
  assert.equal(light.backgroundColor, LIGHT_TUI_THEME.background);
  assert.equal(dark.contentOptions.backgroundColor, DARK_TUI_THEME.background);
  assert.equal(light.viewportOptions.backgroundColor, LIGHT_TUI_THEME.background);
});

test("a tool event keeps the messages it does not change", () => {
  const tool = (toolCallId: string): ToolTranscriptPart => ({
    detailLines: [],
    status: "pending",
    toolCallId,
    toolName: "Read",
    type: "tool",
  });
  const messages: Message[] = [
    { content: "", id: "a1", parts: [tool("c1")], role: "agent" },
    { content: "an answer in between", role: "agent" },
    { content: "", id: "a2", parts: [tool("c2")], role: "agent" },
    { content: "", id: "a3", parts: [tool("c3")], role: "agent" },
  ];
  const apply = (type: SessionEventType, payload: unknown): Message[] => {
    let next = messages;
    applyToolTranscriptEvent({ payload, type } as SessionEvent, {
      setMessages: (update) => {
        next = update(messages);
      },
      toolNamesById: new Map<string, string>(),
    });
    return next;
  };

  const finished = apply(SessionEventType.ToolCallResult, { toolCallId: "c2", result: { content: "x" } });
  assert.equal(finished.length, messages.length);
  assert.equal(finished[0], messages[0]);
  assert.equal(finished[1], messages[1]);
  assert.notEqual(finished[2], messages[2]);
  assert.equal((finished[2]?.parts?.[0] as ToolTranscriptPart).status, "completed");
  // The rows after the one the event changed are the same objects as before.
  assert.equal(finished[3], messages[3]);

  const started = apply(SessionEventType.ToolCallStarted, { toolCallId: "c3" });
  assert.equal(started[0], messages[0]);
  assert.equal(started[1], messages[1]);
  assert.equal(started[2], messages[2]);
  assert.notEqual(started[3], messages[3]);
  assert.equal((started[3]?.parts?.[0] as ToolTranscriptPart).status, "running");
});

test("in the whole TUI a landing of stream text draws the row it changes and no other; a theme switch draws every row", async () => {
  const width = 110;
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const previousMode = getActiveTuiThemeMode();
  const terminal = await createTestRenderer({
    exitOnCtrlC: false,
    height: 30,
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
  let sink: ((event: SessionEvent) => void) | undefined;
  let emit: (type: SessionEventType, payload: unknown) => void = () => {
    throw new Error("the prompt handler was not entered");
  };
  let finishTurn!: () => void;
  const turn = new Promise<void>((resolve) => {
    finishTurn = resolve;
  });
  const options: TuiOptions = {
    locale: "en-US",
    noColor: false,
    // No memory probe in this test.
    readProcessMemory: async () => ({}),
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    submitPrompt: async (_input, submitOptions) => {
      emit = (type, payload) => submitOptions.onEvent?.(sessionEvent(type, payload));
      await turn;
      return { response: "" };
    },
    subscribeSessionEvents: (listener) => {
      sink = listener;
      return () => {};
    },
    workspaceDirectory: "/test/workspace",
  };
  let outcome: Promise<number> | undefined;
  const paint = async () => {
    await act(async () => {
      await settle();
      await terminal.renderOnce();
    });
  };
  // Paints until the frame shows the text; the frame at the end.
  const frameShowing = async (text: string): Promise<string> => {
    let frame = terminal.captureCharFrame();
    for (let attempt = 0; attempt < 80 && !frame.includes(text); attempt += 1) {
      await act(async () => {
        await sleep(25);
        await terminal.renderOnce();
      });
      frame = terminal.captureCharFrame();
    }
    return frame;
  };
  // The row of the frame that shows the text, as the spans the frame holds.
  const spansOfRow = (text: string): Span[] => {
    const row = terminal.captureCharFrame().split("\n").findIndex((line) => line.includes(text));
    assert.ok(row >= 0, `the frame shows ${JSON.stringify(text)}`);
    return (terminal.captureSpans() as unknown as { lines: Array<{ spans: Span[] }> }).lines[row]
      ?.spans as Span[];
  };
  const hex = (color: RGBA | undefined): string | undefined =>
    color
      ? `#${color
          .toInts()
          .slice(0, 3)
          .map((part) => part.toString(16).padStart(2, "0"))
          .join("")}`
      : undefined;
  const history = ["The first answer", "The second answer", "The third answer"];
  const draws = countRowDraws();

  await act(async () => {
    outcome = runTuiWithRenderer(options, terminal.renderer);
    await terminal.renderOnce();
  });

  try {
    assert.equal(getActiveTuiThemeMode(), "dark");
    // Three turns of history, the way the session subscription delivers them.
    await act(async () => {
      for (const content of history) {
        sink?.(sessionEvent(SessionEventType.AssistantMessage, { content }));
      }
      await settle();
    });
    await paint();
    assert.deepEqual(history.map((content) => draws.of(content)), [1, 1, 1]);
    assert.equal(draws.total(), 3);
    const historyFrame = await frameShowing(history[0] ?? "");
    for (const content of history) {
      assert.ok(historyFrame.includes(content), `the frame shows ${JSON.stringify(content)}:\n${historyFrame}`);
    }

    // A prompt typed into the composer: the turn runs from here to finishTurn.
    await act(async () => {
      await terminal.mockInput.typeText("go");
      await settle();
    });
    await paint();
    await act(async () => {
      terminal.mockInput.pressEnter();
      await settle();
    });
    await paint();
    assert.equal(draws.of("go"), 1, "the prompt is a row of its own");
    assert.equal(draws.of("a-live"), 0);
    const before = draws.total();

    // The answer streams: the deltas of the text land one after another. Each
    // delta gets its own scope, with more time in it than the buffer waits
    // between two landings, so every delta is a landing of its own.
    const deltas = 12;
    await act(async () => {
      emit(SessionEventType.TurnStarted, {});
    });
    for (let index = 0; index < deltas; index += 1) {
      await act(async () => {
        emit(SessionEventType.ModelStreaming, {
          assistantMessageId: "a-live",
          delta: "word ",
          kind: "text_delta",
        });
        await sleep(80);
      });
    }
    await act(async () => {
      emit(SessionEventType.ModelStreaming, { assistantMessageId: "a-live", kind: "finish" });
      emit(SessionEventType.TurnComplete, { response: "" });
    });
    await paint();
    // The turn ends and its result is applied.
    await act(async () => {
      finishTurn();
      await settle();
    });
    await paint();

    // Every row of the history and the prompt kept its object through the
    // whole turn: none of them drew again.
    assert.deepEqual(
      history.map((content) => draws.of(content)),
      [1, 1, 1],
    );
    assert.equal(draws.of("go"), 1);
    // Only the row that streamed drew: once per landing of its text, and
    // again when the stream finished.
    const liveDraws = draws.of("a-live");
    assert.equal(draws.total() - before, liveDraws);
    assert.equal(liveDraws, deltas + 1, "one draw per landing, one for the end of the stream");
    const streamedFrame = await frameShowing("word word");
    assert.ok(streamedFrame.includes("word word"), `the frame shows the streamed text:\n${streamedFrame}`);

    // The terminal reports a light theme: the rows draw again, in its colors.
    const beforeSwitch = history.map((content) => draws.of(content));
    await act(async () => {
      resolveThemeMode("light");
      await settle();
    });
    await paint();
    assert.equal(getActiveTuiThemeMode(), "light");
    assert.deepEqual(
      history.map((content) => draws.of(content)),
      beforeSwitch.map((count) => count + 1),
    );
    assert.equal(draws.of("go"), 2);
    assert.equal(draws.of("a-live"), liveDraws + 1);
    const hexOf = (color: string): string => `#${color.slice(1).toLowerCase()}`;
    // The prompt row lies on the user background of the light theme, and the
    // row of the history on the light background of the page: nothing of the
    // dark theme is left on either.
    const backgrounds = (text: string): string[] => [...new Set(spansOfRow(text).map((span) => hex(span.bg)))];
    assert.ok(backgrounds("go").includes(hexOf(LIGHT_TUI_THEME.backgroundMessageUser)));
    assert.ok(backgrounds(history[0] ?? "").includes(hexOf(LIGHT_TUI_THEME.background)));
    for (const text of ["go", ...history]) {
      for (const dark of [DARK_TUI_THEME.background, DARK_TUI_THEME.backgroundMessageUser]) {
        assert.equal(backgrounds(text).includes(hexOf(dark)), false, `${JSON.stringify(text)} still has ${dark}`);
      }
    }
  } finally {
    draws.restore();
    await act(async () => {
      resolveThemeMode("dark");
      terminal.renderer.destroy();
    });
    await outcome;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    setActiveTuiThemeMode(previousMode);
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
