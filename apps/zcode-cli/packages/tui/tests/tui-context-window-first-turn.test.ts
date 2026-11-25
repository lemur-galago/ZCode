import assert from "node:assert/strict";
import test from "node:test";
import { createTestRenderer } from "@mbears/opentui-core/testing";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type { UiThemeMode } from "@zcode/contracts";
import React, { act } from "react";
import { applySessionEventToState } from "../src/app-events.js";
import type { ContextUsage } from "../src/app-model.js";
import { inputContextUsageBadge } from "../src/app-input-status.js";
import { runTuiWithRenderer } from "../src/tui.js";
import type { TuiOptions } from "../src/types.js";

// Local patch (context-window-first-turn): in a fresh session the badge showed
// only the used tokens ("165K") for the whole first turn and the total
// ("165K / 1M (17%)") appeared once the turn was over. The window arrives with
// the model_selected event that the first submission emits, but the TUI read
// only the model name from that event; the projection of the turn result was
// the first place it looked at the window.

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type ActEnvironment = { IS_REACT_ACT_ENVIRONMENT?: boolean };
const actEnvironment = globalThis as typeof globalThis & ActEnvironment;

const MODEL_SELECTED = {
  contextWindow: 1_000_000,
  modelSelection: { modelId: "GLM-5.4", options: { reasoningLevel: "max" }, providerId: "zai-api" },
};
const MODEL_COMPLETE = {
  usage: {
    inputTokens: 165_000,
    outputTokens: 1_200,
    totalTokens: 166_200,
  },
};

test("a model_selected event brings the context window of the model", () => {
  const state = eventState();

  state.apply(sessionEvent(SessionEventType.ModelSelected, MODEL_SELECTED));
  assert.deepEqual(state.contextUsage, { contextWindow: 1_000_000 });
  assert.equal(inputContextUsageBadge(state.contextUsage), undefined);

  state.apply(sessionEvent(SessionEventType.ModelComplete, MODEL_COMPLETE));
  assert.deepEqual(state.contextUsage, { contextUsed: 165_000, contextWindow: 1_000_000 });
  assert.equal(inputContextUsageBadge(state.contextUsage), "165K / 1M (17%)");
});

test("a model_selected event without a usable window keeps the known one", () => {
  const state = eventState();

  state.apply(sessionEvent(SessionEventType.SessionCreated, { contextWindow: 200_000 }));
  // Old events carry no window at all; null means "nothing new".
  for (const extra of [
    {},
    { contextWindow: null },
    { contextWindow: 0 },
    { contextWindow: -1 },
    { contextWindow: "1M" },
  ]) {
    state.apply(
      sessionEvent(SessionEventType.ModelSelected, {
        modelSelection: { modelId: "glm-5" },
        ...extra,
      }),
    );
    assert.equal(state.contextUsage.contextWindow, 200_000, JSON.stringify(extra));
  }
});

test("the badge of a fresh session shows the total from its first response", async () => {
  const app = await startFirstTurn();

  try {
    const row = await app.badgeRow();
    assert.match(row, /165K \/ 1M \(17%\)/);
  } finally {
    await app.close();
  }
});

test("a model switch changes the total together with the model", async () => {
  const app = await startFirstTurn();

  try {
    assert.match(await app.badgeRow(), /165K \/ 1M \(17%\)/);

    // A /model switch during the turn: the next frame already shows the new total.
    await app.emit(
      sessionEvent(SessionEventType.ModelSelected, {
        contextWindow: 200_000,
        modelSelection: { modelId: "glm-5", providerId: "zai-api" },
      }),
    );
    const row = await app.badgeRow();
    assert.match(row, /165K \/ 200K \(\d+%\)/);
    assert.doesNotMatch(row, /GLM-5\.4/);

    // A later response still reports the same usage: the total is not stale.
    await app.emit(sessionEvent(SessionEventType.ModelComplete, MODEL_COMPLETE));
    assert.match(await app.badgeRow(), /165K \/ 200K/);
  } finally {
    await app.close();
  }
});

function eventState(): { apply: (event: SessionEvent) => void; contextUsage: ContextUsage } {
  const state = { contextUsage: {} as ContextUsage };
  return {
    apply: (event) => {      applySessionEventToState(event, {
        assistantMessageIdsByToolCallId: new Map(),
        setActiveTurnId: () => undefined,
        setCacheStats: () => undefined,
        setContextUsage: (updater) => {
          state.contextUsage =
            typeof updater === "function" ? updater(state.contextUsage) : updater;
        },
        setLastError: () => undefined,
        setLiveModelText: () => undefined,
        setMessages: () => undefined,
        setModel: () => undefined,
        setNetworkRequests: () => undefined,
        setStatus: () => undefined,
        setTodos: () => undefined,
        setUsage: () => undefined,
        toolNamesById: new Map(),
      });
    },
    get contextUsage() {
      return state.contextUsage;
    },
  };
}

async function startFirstTurn(): Promise<{
  badgeRow: () => Promise<string>;
  close: () => Promise<void>;
  emit: (event: SessionEvent) => Promise<void>;
}> {
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
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
  // The turn stays busy: its result is the other source of the window and must
  // not be the one that feeds the badge here.
  let finishTurn!: () => void;
  const turn = new Promise<void>((resolve) => {
    finishTurn = resolve;
  });
  // The cross-turn subscription is the sink that carries a model switch.
  const sinks = new Set<(event: SessionEvent) => void>();
  const options: TuiOptions = {
    locale: "en-US",
    noColor: true,
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    submitPrompt: async (_input, submitOptions) => {
      await submitOptions.onEvent?.(sessionEvent(SessionEventType.ModelSelected, MODEL_SELECTED));
      await submitOptions.onEvent?.(sessionEvent(SessionEventType.ModelComplete, MODEL_COMPLETE));
      await turn;
      return { response: "done" };
    },
    subscribeSessionEvents: (sink) => {
      sinks.add(sink);
      return () => sinks.delete(sink);
    },
    workspaceDirectory: "/test/workspace",
  };
  let outcome: Promise<number> | undefined;
  await act(async () => {
    outcome = runTuiWithRenderer(options, terminal.renderer);
    await terminal.renderOnce();
  });
  const paint = async () => {
    await act(async () => {
      await settle();
      await terminal.renderOnce();
    });
  };
  await act(async () => {
    await terminal.mockInput.typeText("hello");
    await settle();
    await terminal.renderOnce();
  });
  await act(async () => {
    terminal.mockInput.pressEnter();
    await settle();
  });
  const rows = () => terminal.captureCharFrame().split("\n");
  const findBadgeRow = () => rows().find((line) => line.includes("165K"));
  for (let attempt = 0; attempt < 40 && !findBadgeRow(); attempt += 1) {
    await act(async () => {
      await sleep(50);
      await terminal.renderOnce();
    });
  }
  return {
    badgeRow: async () => {
      await paint();
      const row = findBadgeRow();
      assert.ok(row, "the badge row with the used tokens is rendered");
      return row;
    },
    close: async () => {
      await act(async () => {
        finishTurn();
        resolveThemeMode("dark");
        terminal.renderer.destroy();
      });
      await outcome;
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    },
    emit: async (event) => {
      // The cross-turn subscription is the sink that carries a model switch.
      await act(async () => {
        for (const sink of sinks) sink(event);
        await settle();
      });
      await paint();
    },
  };
}

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
