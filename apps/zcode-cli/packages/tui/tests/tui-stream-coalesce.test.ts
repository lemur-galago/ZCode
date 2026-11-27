// Local patch (stream-coalesce).
import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { createTestRenderer } from "@mbears/opentui-core/testing";
import { createRoot } from "@mbears/opentui-react";
import { testRender } from "@mbears/opentui-react/test-utils";
import { getZCodeCopy } from "@zcode/i18n";
import React, { act } from "react";
import type { Message, ThoughtTranscriptPart } from "../src/app-model.js";
import {
  appendStreamingDelta,
  streamingDeltaOf,
  type StreamingDelta,
} from "../src/app-model-streaming.js";
import { applyMainSessionEvent } from "../src/app-session-event-handler.js";
import {
  applyStreamDeltas,
  createStreamBuffer,
  streamingThoughtExpanded,
  useStreamFrameCost,
  watchExpandedStreamingThought,
  STREAM_FLUSH_INTERVAL_MS,
  STREAM_MAX_FLUSH_INTERVAL_MS,
  type StreamBuffer,
} from "../src/app-stream-coalesce.js";
import { ThoughtTranscriptPartView } from "../src/app-thought-components.js";

const COPY = getZCodeCopy("en-US").tui;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400 && !condition(); attempt += 1) await sleep(5);
  assert.ok(condition(), what);
}

function event(id: string, type: SessionEventType, payload: unknown): SessionEvent {
  return { id, payload, type } as unknown as SessionEvent;
}

const reasoning = (id: string, delta: string) =>
  event(id, SessionEventType.ModelStreaming, {
    assistantMessageId: "a1",
    delta,
    kind: "reasoning_delta",
  });
const text = (id: string, delta: string) =>
  event(id, SessionEventType.ModelStreaming, { assistantMessageId: "a1", delta, kind: "text_delta" });
// Text of no message: the live text buffer below the tool rows.
const liveText = (id: string, delta: string) =>
  event(id, SessionEventType.ModelStreaming, { delta, kind: "text_delta" });
const reasoningEnd = (id: string) =>
  event(id, SessionEventType.ModelStreaming, { assistantMessageId: "a1", kind: "reasoning_end" });
const finish = (id: string) =>
  event(id, SessionEventType.ModelStreaming, { assistantMessageId: "a1", kind: "finish" });
const toolCall = (id: string) =>
  event(id, SessionEventType.ModelStreaming, {
    assistantMessageId: "a1",
    kind: "tool_call",
    toolCallId: "c1",
    toolName: "Read",
  });
const toolScheduled = (id: string) =>
  event(id, SessionEventType.ToolCallScheduled, {
    input: { file_path: "package.json" },
    toolCallId: "c1",
    toolName: "Read",
  });

// The state the buffer lands in, applied at once the way React would. Two
// state updates of one event are one render, as React batches them; separate
// events are separate renders, as the runtime delivers them.
function harness(intervalMs = 40) {
  const state = { liveText: "", messages: [] as Message[], renders: 0, statuses: [] as string[] };
  let dirty = false;
  const touched = () => {
    if (dirty) return;
    dirty = true;
    state.renders += 1;
  };
  const setMessages = (update: (current: Message[]) => Message[]) => {
    state.messages = update(state.messages);
    touched();
  };
  const setLiveModelText = (update: (current: string) => string) => {
    state.liveText = update(state.liveText);
    touched();
  };
  const setStatus = (status: string) => {
    state.statuses.push(status);
  };
  const buffer = createStreamBuffer({ setLiveModelText, setMessages, setStatus }, intervalMs);
  const applied = new Set<string>();
  const input = {
    assistantMessageIdsByToolCallId: new Map<string, string>(),
    copy: COPY,
    setActiveTurnId: () => {},
    setLastEvent: () => {},
    setLiveModelText,
    setMessages,
    setStatus,
    streamBuffer: buffer,
    toolNamesById: new Map<string, string>(),
  } as unknown as Parameters<typeof applyMainSessionEvent>[2];
  let sequence = 0;
  const send = async (make: (id: string) => SessionEvent): Promise<boolean> => {
    const appliedNow = applyMainSessionEvent(make(`e${(sequence += 1)}`), applied, input);
    await new Promise<void>((resolve) => setImmediate(resolve));
    dirty = false;
    return appliedNow;
  };
  return { buffer, send, state };
}

function onlyThoughtPart(messages: Message[]): ThoughtTranscriptPart {
  const part = messages[0]?.parts?.[0];
  assert.equal(part?.type, "thought");
  return part;
}

type View = Awaited<ReturnType<typeof testRender>>;
async function mountProbe(element: React.ReactElement): Promise<View> {
  let view: View | undefined;
  await act(async () => {
    view = await testRender(element, { height: 3, width: 40 });
    await view.renderOnce();
  });
  assert.ok(view);
  return view;
}

function onlyText(messages: Message[]): string {
  const parts = messages[0]?.parts ?? [];
  return parts
    .filter((part): part is Extract<(typeof parts)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

test("only reasoning and text deltas are stream deltas", () => {
  assert.deepEqual(streamingDeltaOf({ assistantMessageId: "a", delta: "x", kind: "reasoning_delta" }), {
    assistantMessageId: "a",
    delta: "x",
    kind: "reasoning",
  });
  assert.deepEqual(streamingDeltaOf({ delta: "x", kind: "text_delta" }), {
    assistantMessageId: undefined,
    delta: "x",
    kind: "text",
  });
  assert.deepEqual(streamingDeltaOf({ delta: "x" }), {
    assistantMessageId: undefined,
    delta: "x",
    kind: "text",
  });
  assert.equal(streamingDeltaOf({ delta: "{", kind: "tool_input_delta" }), undefined);
  assert.equal(streamingDeltaOf({ kind: "reasoning_end" }), undefined);
  assert.equal(streamingDeltaOf({}), undefined);
});

test("a batch lands exactly where its deltas would land one by one", () => {
  const delta = (
    kind: "reasoning" | "text",
    assistantMessageId: string,
    text: string,
  ): StreamingDelta => ({ assistantMessageId, delta: text, kind });
  const batch = [
    delta("reasoning", "a", "one "),
    delta("reasoning", "a", "two "),
    delta("text", "a", "Hello "),
    delta("reasoning", "a", "again "),
    delta("text", "a", " world"),
    delta("text", "b", "other"),
  ];
  let single: Message[] = [];
  for (const piece of batch) single = appendStreamingDelta(single, piece);

  const landed = applyStreamDeltas([], batch);
  assert.deepEqual(landed, single);
  assert.deepEqual(
    landed[0]?.parts?.map((part) => part.type),
    ["thought", "text", "thought", "text"],
  );
  assert.equal(landed[1]?.parts?.[0]?.type, "text");
  // Nothing to land: the same array.
  assert.equal(applyStreamDeltas(landed, []), landed);
});

test("a collapsed thought renders its first delta and then waits for the end of the reasoning", async () => {
  const h = harness();
  await h.send((id) => reasoning(id, "first "));
  assert.equal(h.state.renders, 1);
  await h.send((id) => reasoning(id, "second "));
  await h.send((id) => reasoning(id, "third"));
  assert.equal(h.state.renders, 1);
  // Nothing lands by itself while the thought is collapsed.
  await sleep(120);
  assert.equal(h.state.renders, 1);

  await h.send(reasoningEnd);
  assert.equal(h.state.renders, 2);
  const part = onlyThoughtPart(h.state.messages);
  assert.equal(part.text, "first second third");
  assert.equal(part.status, "thought");
  assert.equal(part.contentCharCount, "first second third".length);
});

test("text deltas land at most once per interval and in order", async () => {
  const h = harness(40);
  await h.send((id) => text(id, "a"));
  assert.equal(h.state.renders, 1);
  for (const piece of ["b", "c", "d", "e"]) await h.send((id) => text(id, piece));
  assert.equal(h.state.renders, 1);
  await waitFor(() => h.state.renders === 2, "the buffered text lands after the interval");
  assert.equal(onlyText(h.state.messages), "abcde");

  // Right after a landing the next piece waits again.
  await h.send((id) => text(id, "f"));
  assert.equal(h.state.renders, 2);
  await waitFor(() => h.state.renders === 3, "the next piece lands after the interval");
  assert.equal(onlyText(h.state.messages), "abcdef");
  h.buffer.dispose();
});

test("another event lands after the deltas buffered before it", async () => {
  const h = harness();
  await h.send((id) => reasoning(id, "one "));
  await h.send((id) => reasoning(id, "two "));
  await h.send(toolCall);
  await h.send(toolScheduled);
  assert.deepEqual(
    h.state.messages[0]?.parts?.map((part) => part.type),
    ["thought", "tool"],
  );
  assert.equal(onlyThoughtPart(h.state.messages).text, "one two ");
});

test("the end of the stream lands what is held and completes the message", async () => {
  const h = harness();
  await h.send((id) => reasoning(id, "think "));
  await h.send((id) => reasoning(id, "more"));
  await h.send(finish);
  assert.equal(h.state.renders, 2);
  assert.equal(h.state.messages[0]?.streaming, false);
  assert.equal(onlyThoughtPart(h.state.messages).text, "think more");
  assert.equal(onlyThoughtPart(h.state.messages).status, "thought");
});

test("a buffered text is part of the completed message", async () => {
  const h = harness();
  await h.send((id) => text(id, "Hold "));
  await h.send((id) => text(id, "me"));
  await h.send(finish);
  assert.equal(onlyText(h.state.messages), "Hold me");
  assert.equal(h.state.messages[0]?.streaming, false);
});

test("an expanded streaming thought shows what was held and keeps updating", async () => {
  const h = harness(40);
  const view = Symbol("view");
  let collapse = (): void => {};
  try {
    await h.send((id) => reasoning(id, "one "));
    await h.send((id) => reasoning(id, "two "));
    assert.equal(h.state.renders, 1);

    collapse = watchExpandedStreamingThought(view);
    assert.equal(streamingThoughtExpanded(), true);
    assert.equal(h.state.renders, 2);
    assert.equal(onlyThoughtPart(h.state.messages).text, "one two ");

    await h.send((id) => reasoning(id, "three "));
    await waitFor(() => h.state.renders === 3, "a delta of an expanded thought lands after the interval");
    assert.equal(onlyThoughtPart(h.state.messages).text, "one two three ");

    // Collapsed again: back to waiting for the end.
    collapse();
    await sleep(60);
    await h.send((id) => reasoning(id, "four "));
    assert.equal(h.state.renders, 3);
    await h.send(reasoningEnd);
    assert.equal(onlyThoughtPart(h.state.messages).text, "one two three four ");
  } finally {
    collapse();
    h.buffer.dispose();
  }
});

test("text without a message joins the live text the same way", async () => {
  const h = harness(40);
  await h.send((id) => liveText(id, "a"));
  await h.send((id) => liveText(id, "b"));
  assert.equal(h.state.liveText, "a");
  assert.equal(h.state.renders, 1);
  await waitFor(() => h.state.renders === 2, "the buffered live text lands after the interval");
  assert.equal(h.state.liveText, "ab");
  h.buffer.dispose();
});

test("the status follows the phase, and an empty delta renders nothing", async () => {
  const h = harness();
  await h.send((id) => reasoning(id, ""));
  assert.equal(h.state.renders, 0);
  assert.deepEqual(h.state.statuses, ["Streaming model reasoning..."]);
  await h.send((id) => reasoning(id, "thinking"));
  await h.send((id) => text(id, "answer"));
  assert.equal(h.state.statuses.at(-1), "Streaming model response...");
});

test("events that are not deltas are applied as before", async () => {
  const h = harness();
  assert.equal(await h.send(toolCall), true);
  assert.equal(await h.send(toolScheduled), true);
  assert.equal(h.state.messages[0]?.parts?.[0]?.type, "tool");
});

test("after dispose the deltas take the direct way again", async () => {
  const h = harness();
  h.buffer.dispose();
  await h.send((id) => reasoning(id, "one "));
  await h.send((id) => reasoning(id, "two "));
  assert.equal(h.state.renders, 2);
  assert.equal(onlyThoughtPart(h.state.messages).text, "one two ");
});

test("dispose stops the timer", async () => {
  const h = harness(20);
  await h.send((id) => text(id, "a"));
  await h.send((id) => text(id, "b"));
  assert.equal(h.state.renders, 1);
  h.buffer.dispose();
  await sleep(80);
  assert.equal(h.state.renders, 1);
});

test("an expensive frame makes the text refresh rarer, a cheap one faster again", async () => {
  const h = harness(20);
  assert.equal(STREAM_FLUSH_INTERVAL_MS, 50);
  assert.equal(h.buffer.intervalMs(), 20);
  // A frame of 80 ms: four refreshes a second keep the stream at a quarter core.
  for (let frame = 0; frame < 4; frame += 1) h.buffer.noteFrame(80);
  assert.equal(h.buffer.intervalMs(), 320);
  // An outlier is capped.
  h.buffer.noteFrame(5000);
  assert.equal(h.buffer.intervalMs(), STREAM_MAX_FLUSH_INTERVAL_MS);
  // Nothing measured is not a frame.
  h.buffer.noteFrame(0);
  h.buffer.noteFrame(Number.NaN);
  assert.equal(h.buffer.intervalMs(), STREAM_MAX_FLUSH_INTERVAL_MS);

  await h.send((id) => text(id, "a"));
  await h.send((id) => text(id, "b"));
  await sleep(150);
  assert.equal(h.state.renders, 1, "the held text waits for the long interval");
  await waitFor(() => h.state.renders === 2, "it lands after the long interval");

  // Cheap frames again: back to the base interval.
  for (let frame = 0; frame < 16; frame += 1) h.buffer.noteFrame(1);
  assert.equal(h.buffer.intervalMs(), 20);
  h.buffer.dispose();
});

test("the frame cost hook measures the main thread once per rendered frame", async () => {
  const noted: number[] = [];
  const noop = (): void => {};
  const buffer = {
    dispose: noop,
    flush: noop,
    intervalMs: () => STREAM_FLUSH_INTERVAL_MS,
    noteFrame: (cpuMs: number) => {
      noted.push(cpuMs);
    },
    offer: () => false,
  } satisfies StreamBuffer;
  function Probe() {
    useStreamFrameCost(buffer);
    return React.createElement("text", null, "probe");
  }
  const view = await mountProbe(React.createElement(Probe));
  try {
    await act(async () => {
      await view.renderOnce();
      await view.renderOnce();
    });
    if (typeof process.threadCpuUsage === "function") {
      assert.ok(noted.length >= 2, `frames measured: ${noted.length}`);
      assert.ok(noted.every((cpu) => Number.isFinite(cpu) && cpu >= 0));
    } else {
      assert.deepEqual(noted, []);
    }
  } finally {
    await act(async () => {
      view.renderer.destroy();
    });
  }
});

test("the thought view announces itself while it shows a thought that still streams", async () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const terminal = await createTestRenderer({
    exitOnCtrlC: false,
    height: 10,
    screenMode: "alternate-screen",
    useThread: false,
    width: 80,
  });
  const root = createRoot(terminal.renderer);
  const part = (status: "thinking" | "thought"): ThoughtTranscriptPart => ({
    contentCharCount: 3,
    status,
    text: "abc",
    type: "thought",
  });
  // The status of the thought changes through state. (A second root.render
  // would mount a second copy of the view in OpenTUI's React binding.)
  let show: (status: "thinking" | "thought") => void = () => {};
  function Host() {
    const [status, setStatus] = React.useState<"thinking" | "thought">("thinking");
    show = setStatus;
    return React.createElement(ThoughtTranscriptPartView, { part: part(status) });
  }
  const settle = async () => {
    await act(async () => {
      await terminal.renderOnce();
    });
  };
  // The mouse-up handler of the row, the way OpenTUI keeps it: the toggle.
  const toggle = async () => {
    const row = terminal.renderer.root.getChildren()[0] as
      | { _mouseListeners?: { up?: (event: unknown) => void } }
      | undefined;
    const up = row?._mouseListeners?.up;
    assert.equal(typeof up, "function", "the row answers the mouse");
    await act(async () => {
      up?.({});
    });
    await settle();
  };

  try {
    await act(async () => {
      root.render(React.createElement(Host));
    });
    await settle();
    assert.equal(streamingThoughtExpanded(), false);
    await toggle();
    assert.equal(streamingThoughtExpanded(), true);

    // The reasoning ends while the thought is expanded: reading is not streaming.
    await act(async () => {
      show("thought");
    });
    await settle();
    assert.equal(streamingThoughtExpanded(), false);
    // A completed thought that gets expanded does not count either.
    await toggle();
    await toggle();
    assert.equal(streamingThoughtExpanded(), false);

    // Expanded again, then the stream completes.
    await act(async () => {
      show("thinking");
    });
    await settle();
    assert.equal(streamingThoughtExpanded(), true);
    await act(async () => {
      show("thought");
    });
    await settle();
    assert.equal(streamingThoughtExpanded(), false);
    await act(async () => {
      show("thinking");
    });
    await settle();
    assert.equal(streamingThoughtExpanded(), true);
  } finally {
    await act(async () => {
      root.unmount();
    });
    await act(async () => {
      terminal.renderer.destroy();
    });
    environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
  assert.equal(streamingThoughtExpanded(), false);
});
