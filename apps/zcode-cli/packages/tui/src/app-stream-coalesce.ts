// Local patch (stream-coalesce): the model stream arrives as dozens of events
// per second, and every delta used to re-render the whole transcript, while one
// frame costs more the longer the transcript is (measured on a 32-thread
// desktop: from 10 to 50 ms of CPU per event in a session of 5 to 30 turns, for
// a reasoning delta as much as for text). The buffer lands deltas in the state
// at a bounded rate instead: text at most once per interval, reasoning deltas
// not at all while the thought is collapsed, because nothing of them is on
// screen - they wait for the end of the reasoning, for any other event or for
// the user expanding the thought. The order of the stream is kept: every other
// event lands after the deltas buffered before it.
// A frame costs more the longer the transcript is, so the interval follows the
// frames the process actually renders: while they are cheap text refreshes up
// to 20 times a second, while a frame costs as much as the whole budget the
// refresh gets rarer, and the stream never takes more than its share of a core.
import { useEffect } from "react";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { CliRenderEvents } from "@mbears/opentui-core";
import { useRenderer } from "@mbears/opentui-react";
import type { Message } from "./app-model.js";
import {
  appendStreamingDelta,
  streamingDeltaOf,
  STREAMING_REASONING_STATUS,
  STREAMING_RESPONSE_STATUS,
  type StreamingDelta,
} from "./app-model-streaming.js";
import { asRecord } from "./state.js";

/** Shortest wait of a buffered text delta: 50 ms is up to 20 refreshes a second. */
export const STREAM_FLUSH_INTERVAL_MS = 50;
/** Share of one core the stream may spend on the frames its refreshes cause. */
export const STREAM_FRAME_BUDGET = 0.25;
/** The refresh never gets rarer than this, whatever a frame costs. */
export const STREAM_MAX_FLUSH_INTERVAL_MS = 400;

type StreamBufferHandlers = {
  setLiveModelText: (update: (current: string) => string) => void;
  setMessages: (update: (current: Message[]) => Message[]) => void;
  setStatus: (status: string) => void;
};

export type StreamBuffer = {
  /** Takes a stream delta into the buffer; false for every other event. */
  offer: (event: SessionEvent) => boolean;
  /** Lands the buffered deltas in the state now. */
  flush: () => void;
  /** Stops the timer and takes nothing more; the state is going away. */
  dispose: () => void;
  /** CPU the main thread spent on a frame that was just rendered. */
  noteFrame: (cpuMs: number) => void;
  /** The wait a buffered text delta currently has. */
  intervalMs: () => number;
};

// Views of thoughts that are expanded while the thought still streams: their
// text is on screen, so its deltas have to keep arriving.
const expandedStreamingThoughts = new Set<symbol>();
const expandedThoughtListeners = new Set<() => void>();

/** Registers such a view; the returned function removes it again. */
export function watchExpandedStreamingThought(token: symbol): () => void {
  const wasNone = expandedStreamingThoughts.size === 0;
  expandedStreamingThoughts.add(token);
  if (wasNone) {
    // What was held back is on screen from now on.
    for (const listener of [...expandedThoughtListeners]) listener();
  }
  return () => {
    expandedStreamingThoughts.delete(token);
  };
}

export function streamingThoughtExpanded(): boolean {
  return expandedStreamingThoughts.size > 0;
}

/** Lands a batch of deltas in one pass; the same array when it is empty. */
export function applyStreamDeltas(
  messages: Message[],
  deltas: readonly StreamingDelta[],
): Message[] {
  let next = messages;
  let index = 0;
  while (index < deltas.length) {
    const first = deltas[index] as StreamingDelta;
    // Consecutive deltas of one stream are a single append.
    let text = first.delta;
    let end = index + 1;
    while (
      end < deltas.length &&
      deltas[end]?.kind === first.kind &&
      deltas[end]?.assistantMessageId === first.assistantMessageId
    ) {
      text += deltas[end]?.delta ?? "";
      end += 1;
    }
    next = appendStreamingDelta(next, { ...first, delta: text });
    index = end;
  }
  return next;
}

export function createStreamBuffer(
  handlers: StreamBufferHandlers,
  intervalMs: number = STREAM_FLUSH_INTERVAL_MS,
): StreamBuffer {
  let deltas: StreamingDelta[] = [];
  let liveText = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastFlushAt = Number.NEGATIVE_INFINITY;
  // Whether the row of the current reasoning is on screen already: the first
  // delta of a reasoning brings it, the rest only extend its text. Any other
  // event may have closed the thought, so the next reasoning brings a row again.
  let reasoningShown = false;
  let disposed = false;
  // The cost of a frame, smoothed; negative until the first one was measured.
  let frameCostMs = -1;
  let interval = intervalMs;

  function flush(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const batch = deltas;
    const text = liveText;
    deltas = [];
    liveText = "";
    lastFlushAt = Date.now();
    if (batch.length > 0) handlers.setMessages((current) => applyStreamDeltas(current, batch));
    if (batch.some((delta) => delta.kind === "reasoning")) reasoningShown = true;
    if (text.length > 0) handlers.setLiveModelText((current) => current + text);
  }

  const showBuffered = (): void => {
    if (deltas.length > 0 || liveText.length > 0) flush();
  };
  expandedThoughtListeners.add(showBuffered);

  return {
    offer(event) {
      if (disposed || event.type !== SessionEventType.ModelStreaming) return false;
      const delta = streamingDeltaOf(asRecord(event.payload));
      if (!delta) {
        reasoningShown = false;
        return false;
      }
      handlers.setStatus(
        delta.kind === "reasoning" ? STREAMING_REASONING_STATUS : STREAMING_RESPONSE_STATUS,
      );
      // A reasoning delta without a message is not rendered, as without the buffer.
      if ((!delta.assistantMessageId && delta.kind !== "text") || delta.delta.length === 0) {
        return true;
      }
      if (delta.kind === "text" && !delta.assistantMessageId) liveText += delta.delta;
      else deltas.push(delta);
      // On screen: the row a reasoning starts with, text, and an expanded
      // thought; the further deltas of a collapsed thought are not.
      const onScreen =
        delta.kind === "text" || streamingThoughtExpanded() || (delta.kind === "reasoning" && !reasoningShown);
      if (!onScreen) return true;
      const wait = lastFlushAt + interval - Date.now();
      if (wait <= 0) flush();
      else if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined;
          flush();
        }, wait);
      }
      return true;
    },
    flush,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      expandedThoughtListeners.delete(showBuffered);
    },
    noteFrame(cpuMs) {
      if (!Number.isFinite(cpuMs) || cpuMs <= 0) return;
      frameCostMs = frameCostMs < 0 ? cpuMs : (frameCostMs + cpuMs) / 2;
      interval = Math.min(
        STREAM_MAX_FLUSH_INTERVAL_MS,
        Math.max(intervalMs, Math.round(frameCostMs / STREAM_FRAME_BUDGET)),
      );
    },
    intervalMs: () => interval,
  };
}

/**
 * Feeds the buffer the CPU the main thread spent since the previous frame.
 * That time is what the previous frame cost plus what was committed for the
 * next one, which is the cost the next stream refresh will cause as well.
 */
export function useStreamFrameCost(streamBuffer: StreamBuffer): void {
  const renderer = useRenderer();
  useEffect(() => {
    // The CPU time of a thread is not readable everywhere: the buffer then
    // keeps its base interval.
    if (typeof process.threadCpuUsage !== "function") return undefined;
    let previous = process.threadCpuUsage();
    const onFrame = (): void => {
      const spent = process.threadCpuUsage(previous);
      previous = process.threadCpuUsage();
      streamBuffer.noteFrame((spent.user + spent.system) / 1000);
    };
    renderer.on(CliRenderEvents.FRAME, onFrame);
    return () => {
      renderer.off(CliRenderEvents.FRAME, onFrame);
    };
  }, [renderer, streamBuffer]);
}
