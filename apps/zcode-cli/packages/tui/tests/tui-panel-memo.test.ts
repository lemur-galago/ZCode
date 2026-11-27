// Local patch (panel-memo).
import assert from "node:assert/strict";
import test from "node:test";
import { createTestRenderer } from "@mbears/opentui-core/testing";
import { testRender } from "@mbears/opentui-react/test-utils";
import { SessionEventType, type SessionEvent, type UiThemeMode } from "@zcode/contracts";
import { getZCodeCopy } from "@zcode/i18n";
import React, { act } from "react";
import type { DraftAttachment } from "../src/app-model.js";
import { useEffortCommandController } from "../src/app-effort-command.js";
import { useModeCommandController } from "../src/app-mode-command.js";
import { useModelCommandController } from "../src/app-model-command.js";
import { useSubagents } from "../src/app-subagents.js";
import { useSubmitValue } from "../src/app-submit-controller.js";
import { MemoizedComposerInputArea, MemoizedSidebar } from "../src/app-view.js";
import { ComposerInputArea } from "../src/app-view.js";
import { Sidebar } from "../src/app-sidebar.js";
import { runTuiWithRenderer } from "../src/tui.js";
import {
  DARK_TUI_THEME,
  LIGHT_TUI_THEME,
  getActiveTuiThemeMode,
  setActiveTuiThemeMode,
} from "../src/theme/index.js";
import type { TuiEffortOption, TuiOptions } from "../src/types.js";

// Local patch (panel-memo): the sidebar and the composer area with its status
// row were drawn on every landing of stream text, although nothing of theirs
// had changed: the view re-rendered, and they are function components. They
// are drawn through memoized components now, which draws a component again only
// when one of its props changed. That needs every prop to keep its object while
// its value is the same, which is what these tests pin down: the functions the
// app hands down, and in the whole TUI the draws themselves.

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type ActEnvironment = { IS_REACT_ACT_ENVIRONMENT?: boolean };
const actEnvironment = globalThis as typeof globalThis & ActEnvironment;
type MemoComponent = { type: (props: unknown) => React.ReactElement };
type Span = { bg?: { toInts: () => number[] }; text: string };
type View = Awaited<ReturnType<typeof testRender>>;

const EFFORTS: readonly TuiEffortOption[] = [
  { description: "Fast answers", id: "low", label: "Low" },
  { description: "Deeper thinking", id: "high", label: "High" },
];

async function mountProbe(element: React.ReactElement): Promise<View> {
  let view: View | undefined;
  await act(async () => {
    view = await testRender(element, { height: 3, width: 40 });
    await view.renderOnce();
  });
  assert.ok(view);
  return view;
}

async function destroy(view: View): Promise<void> {
  await act(async () => {
    view.renderer.destroy();
  });
}

test("the submit function is one object for the life of its hook and takes the input of the latest render", async () => {
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  type Input = Parameters<typeof useSubmitValue>[0];
  const prompts: string[] = [];
  const statuses: string[] = [];
  const seen: Array<(value: string) => Promise<void>> = [];
  let setResolve!: (resolve: (value: string) => string) => void;
  function Host() {
    // The initializer is lazy: a function state starts through a function of it.
    const [resolveSubmittedText, applyResolve] = React.useState<(value: string) => string>(
      () => (value) => value,
    );
    setResolve = applyResolve;
    const attachments = React.useRef<DraftAttachment[]>([]);
    const turnRef = React.useRef<AbortController | undefined>(undefined);
    const input: Input = {
      activeTurnId: undefined,
      applyResult: () => undefined,
      applySessionEvent: () => undefined,
      busy: false,
      draftAttachmentsRef: attachments,
      emptyPromptStatus: "Type a prompt",
      messageInsertIndex: 0,
      options: {
        submitPrompt: async (prompt) => {
          prompts.push(JSON.stringify(prompt));
          return { response: "" };
        },
      } as unknown as TuiOptions,
      resolveSubmittedText,
      setBusy: () => undefined,
      setDraftAttachments: () => undefined,
      setDraftValue: () => undefined,
      setLastError: () => undefined,
      setLiveModelText: () => undefined,
      setMessages: () => undefined,
      setQueuedInputs: () => undefined,
      setSelection: () => undefined,
      setSlashSelection: () => undefined,
      setStatus: (status) => {
        statuses.push(status);
      },
      setStatusDetails: () => undefined,
      turnRef,
    };
    seen.push(useSubmitValue(input));
    return React.createElement("text", null, "probe");
  }
  const view = await mountProbe(React.createElement(Host));

  try {
    assert.equal(seen.length, 1);
    await act(async () => {
      await seen[0]?.("hello");
    });
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0]?.includes("hello"));

    // The input of the hook changes with the state of its host. (A function
    // handed to a setter is an update, as one handed to useState is lazy.)
    await act(async () => {
      setResolve(() => () => "");
      await settle();
    });
    assert.equal(seen.length, 2);
    assert.equal(seen[1], seen[0], "the same function after a render");

    // A call goes with the input of the latest render: every text resolves to
    // the empty prompt now, so nothing is submitted.
    await act(async () => {
      await seen[0]?.("hello again");
    });
    assert.equal(prompts.length, 1);
    // The first call started a turn with the input of the first render; the
    // second found the empty prompt of the latest one.
    assert.deepEqual(statuses, ["Thinking...", "Type a prompt"]);
  } finally {
    await destroy(view);
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

test("the controllers the app builds its handlers from are the same object while their members are", async () => {
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const seen: Array<{
    effort: unknown;
    mode: unknown;
    model: unknown;
    subagents: unknown;
  }> = [];
  let setDraft!: (draft: string) => void;
  let tick!: () => void;
  // One object, as the app has one: the controller keeps the callbacks it
  // builds from the options for as long as the options are the same.
  const options = { workspaceDirectory: "/test/workspace" } as TuiOptions;
  function Host() {
    const [draft, applyDraft] = React.useState("");
    const [, bump] = React.useState(0);
    setDraft = applyDraft;
    tick = () => bump((current) => current + 1);
    seen.push({
      effort: useEffortCommandController(draft, EFFORTS),
      mode: useModeCommandController(draft),
      model: useModelCommandController(draft, {}),
      subagents: useSubagents(options),
    });
    return React.createElement("text", null, draft);
  }
  const view = await mountProbe(React.createElement(Host));

  try {
    // The mount itself renders more than once (the effect of the subagents
    // stores its initial state again); the first objects are the reference.
    const first = seen[0];
    assert.ok(first);
    const mounted = seen.length;
    assert.ok(mounted >= 1);

    // A render that changes none of their members keeps their objects.
    await act(async () => {
      tick();
      await settle();
    });
    assert.ok(seen.length > mounted, "the host rendered again");
    const afterTick = seen.at(-1);
    assert.equal(afterTick?.effort, first.effort);
    assert.equal(afterTick?.mode, first.mode);
    assert.equal(afterTick?.model, first.model);
    assert.equal(afterTick?.subagents, first.subagents);

    // A draft that opens a command changes the filtered options with it.
    await act(async () => {
      setDraft("/h");
      await settle();
    });
    const afterDraft = seen.at(-1);
    assert.ok(afterDraft !== afterTick, "the host rendered for the draft");
    assert.notEqual(afterDraft?.effort, first.effort);
    assert.notEqual(afterDraft?.mode, first.mode);
    assert.notEqual(afterDraft?.model, first.model);
    // The subagents do not depend on the draft.
    assert.equal(afterDraft?.subagents, first.subagents);
  } finally {
    await destroy(view);
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

test("the view draws the sidebar and the composer area through memoized components", () => {
  assert.equal((MemoizedSidebar as unknown as MemoComponent).type, Sidebar);
  assert.equal((MemoizedComposerInputArea as unknown as MemoComponent).type, ComposerInputArea);
});

test("in the whole TUI a landing of stream text draws neither the sidebar nor the composer area", async () => {
  // Wide enough for the sidebar to be docked (it shows from 121 columns).
  const width = 140;
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
    workspaceDirectory: "/test/workspace",
  };
  let outcome: Promise<number> | undefined;
  const paint = async () => {
    await act(async () => {
      await settle();
      await terminal.renderOnce();
    });
  };
  /** Counts the draws of memoized components, by the function React reaches. */
  const counters = new Map<MemoComponent, number>();
  const inner = new Map<MemoComponent, (props: unknown) => React.ReactElement>();
  for (const component of [MemoizedSidebar, MemoizedComposerInputArea] as unknown as MemoComponent[]) {
    inner.set(component, component.type);
    counters.set(component, 0);
    component.type = (props) => {
      counters.set(component, (counters.get(component) ?? 0) + 1);
      return inner.get(component)?.(props) as React.ReactElement;
    };
  }
  const draws = {
    composer: () => counters.get(MemoizedComposerInputArea as unknown as MemoComponent) ?? 0,
    restore: () => {
      for (const [component, type] of inner) component.type = type;
    },
    sidebar: () => counters.get(MemoizedSidebar as unknown as MemoComponent) ?? 0,
  };
  const hex = (color: { toInts: () => number[] } | undefined): string | undefined =>
    color
      ? `#${color
          .toInts()
          .slice(0, 3)
          .map((part) => part.toString(16).padStart(2, "0"))
          .join("")}`
      : undefined;
  /** The backgrounds on the frame row that shows the text. */
  const backgrounds = (text: string): string[] => {
    const row = terminal.captureCharFrame().split("\n").findIndex((line) => line.includes(text));
    assert.ok(row >= 0, `the frame shows ${JSON.stringify(text)}`);
    const spans = (terminal.captureSpans() as unknown as { lines: Array<{ spans: Span[] }> }).lines[row]
      ?.spans as Span[];
    return [...new Set(spans.map((span) => hex(span.bg)))];
  };

  await act(async () => {
    outcome = runTuiWithRenderer(options, terminal.renderer);
    await terminal.renderOnce();
  });

  try {
    assert.equal(getActiveTuiThemeMode(), "dark");
    await paint();
    assert.deepEqual({ composer: draws.composer(), sidebar: draws.sidebar() }, { composer: 1, sidebar: 1 });

    // The sidebar shows the product name on the background of its panel.
    const panelBefore = backgrounds("ZCode");
    assert.ok(panelBefore.includes(`#${DARK_TUI_THEME.backgroundElement.slice(1)}`), JSON.stringify(panelBefore));

    // Typing is the composer's own data: the draft.
    await act(async () => {
      await terminal.mockInput.typeText("go");
      await settle();
    });
    await paint();
    const afterTyping = { composer: draws.composer(), sidebar: draws.sidebar() };
    assert.ok(afterTyping.composer >= 2, `the composer drew ${afterTyping.composer} times`);
    assert.ok(terminal.captureCharFrame().includes("go"));

    // The turn starts: busy is a prop of both, the status of the sidebar.
    await act(async () => {
      terminal.mockInput.pressEnter();
      await settle();
    });
    await paint();
    const atTurnStart = { composer: draws.composer(), sidebar: draws.sidebar() };
    assert.equal(atTurnStart.composer, afterTyping.composer + 1);
    assert.ok(atTurnStart.sidebar >= afterTyping.sidebar + 1);
    // The status row is on with the turn: the spinner is in the frame.
    const streaming = terminal.captureCharFrame();
    assert.ok(
      [...streaming].some((character) => "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏".includes(character)),
      "the spinner turns under the composer",
    );

    // The answer streams: one landing per delta. The first delta is also a
    // new status and a new kind of event, which the sidebar shows: it draws
    // once for them. The composer has no such prop.
    const deltas = 12;
    await act(async () => {
      emit(SessionEventType.TurnStarted, {});
    });
    await paint();
    const atStreamStart = { composer: draws.composer(), sidebar: draws.sidebar() };
    const firstDelta = () => {
      emit(SessionEventType.ModelStreaming, {
        assistantMessageId: "a-live",
        delta: "word ",
        kind: "text_delta",
      });
    };
    await act(async () => {
      firstDelta();
      await sleep(80);
    });
    await paint();
    const beforeStream = { composer: draws.composer(), sidebar: draws.sidebar() };
    assert.equal(beforeStream.composer, atStreamStart.composer);
    assert.equal(beforeStream.sidebar, atStreamStart.sidebar + 1);
    assert.ok(
      terminal.captureCharFrame().split("\n").some((line) => line.includes("Streaming model")),
      "the sidebar shows the status of the stream",
    );
    // The text of the answer grows: neither panel has a prop that changes with it.
    for (let index = 1; index < deltas; index += 1) {
      await act(async () => {
        firstDelta();
        await sleep(80);
      });
    }
    await paint();
    assert.ok(terminal.captureCharFrame().includes("word word"), "the frame shows the streamed text");
    assert.deepEqual(
      { composer: draws.composer(), sidebar: draws.sidebar() },
      beforeStream,
      `after ${deltas} landings of stream text`,
    );

    // The stream and the turn end: the status and busy change again, and
    // with them the panels that show them.
    await act(async () => {
      emit(SessionEventType.ModelStreaming, { assistantMessageId: "a-live", kind: "finish" });
      emit(SessionEventType.TurnComplete, { response: "" });
    });
    await paint();
    await act(async () => {
      finishTurn();
      await settle();
    });
    await paint();
    assert.ok(draws.sidebar() > beforeStream.sidebar, `the sidebar drew ${draws.sidebar()} times`);
    assert.ok(draws.composer() > beforeStream.composer, `the composer drew ${draws.composer()} times`);

    // The terminal reports a light theme: both draw once more, in its colors.
    const beforeSwitch = { composer: draws.composer(), sidebar: draws.sidebar() };
    await act(async () => {
      resolveThemeMode("light");
      await settle();
    });
    await paint();
    assert.equal(getActiveTuiThemeMode(), "light");
    assert.deepEqual(
      { composer: draws.composer(), sidebar: draws.sidebar() },
      { composer: beforeSwitch.composer + 1, sidebar: beforeSwitch.sidebar + 1 },
    );
    const panelAfter = backgrounds("ZCode");
    assert.ok(panelAfter.includes(`#${LIGHT_TUI_THEME.backgroundElement.slice(1)}`), JSON.stringify(panelAfter));
    assert.equal(panelAfter.includes(`#${DARK_TUI_THEME.backgroundElement.slice(1)}`), false);
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
