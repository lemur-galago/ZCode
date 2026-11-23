import {
  CliRenderEvents,
  Renderable,
  type CliRenderer,
  type CliRendererRawMouseEvent,
} from "@mbears/opentui-core";

// Local patch (double-click-word-select): OpenTUI only selects by dragging.
// Two plain left presses on one cell within the system double-click interval
// select the word under the pointer (a third press selects the row) through
// the renderer selection that Ctrl+C already copies.

export const DOUBLE_CLICK_INTERVAL_MS = 500;

const WORD_CHARACTER = /^[\p{L}\p{M}\p{N}\p{Pc}]+$/u;
// Keeps compound tokens whole: app-view.tsx, --force, что-то.
const WORD_JOINER = /^[-.]$/u;

type Point = { x: number; y: number };
type CellRange = { start: number; end: number };

export function isWordCharacter(text: string): boolean {
  return WORD_CHARACTER.test(text) || WORD_JOINER.test(text);
}

export function createClickCounter(now: () => number = Date.now): (point: Point) => number {
  let previous: (Point & { count: number; time: number }) | undefined;
  return (point) => {
    const time = now();
    const count =
      previous !== undefined &&
      previous.y === point.y &&
      Math.abs(previous.x - point.x) <= 1 &&
      time - previous.time <= DOUBLE_CLICK_INTERVAL_MS
        ? previous.count + 1
        : 1;
    previous = { ...point, count, time };
    return count;
  };
}

/**
 * Cell range [start, end) of the word or single glyph at column x.
 * `probe(start, cells)` returns the text rendered in the cells [start, start + cells).
 */
export function wordRangeAt(
  probe: (start: number, cells: number) => string,
  x: number,
  minX: number,
  maxX: number,
): CellRange | undefined {
  const clicked = probe(x, 1);
  if (!clicked) return undefined;
  if (!isWordCharacter(clicked)) {
    // A two-cell glyph reports the same text on both of its cells.
    const start = x > minX && probe(x - 1, 2) === clicked ? x - 1 : x;
    return { start, end: x + 1 };
  }
  let start = x;
  while (start > minX && isWordCharacter(probe(start - 1, 1))) start -= 1;
  let end = x + 1;
  while (end < maxX && isWordCharacter(probe(end, 1))) end += 1;
  // The end of a sentence or of a wrapped line is not part of the word.
  while (end > start + 1 && WORD_JOINER.test(probe(end - 1, 1))) end -= 1;
  if (x >= end) return { start: x, end: x + 1 };
  return { start, end };
}

function selectByClickCount(renderer: CliRenderer, x: number, y: number, count: number): void {
  if (renderer.isDestroyed) return;
  const target = Renderable.renderablesByNumber.get(renderer.hitTest(x, y));
  if (
    !target?.selectable ||
    target.isDestroyed ||
    typeof target.getSelectedText !== "function" ||
    !target.shouldStartSelection(x, y)
  ) {
    return;
  }
  const probe = (start: number, cells: number): string => {
    renderer.startSelection(target, start, y);
    renderer.updateSelection(target, start + cells, y, { finishDragging: true });
    return target.getSelectedText();
  };
  const maxX = target.x + target.width;
  const range =
    count >= 3
      ? { start: target.x, end: maxX }
      : wordRangeAt(probe, x, target.x, maxX);
  if (!range) return;
  probe(range.start, range.end - range.start);
}

export function installDoubleClickSelection(renderer: CliRenderer): () => void {
  const clicks = createClickCounter();
  let pending: (Point & { count: number }) | undefined;
  const applyPending = () => {
    const target = pending;
    pending = undefined;
    if (target) selectByClickCount(renderer, target.x, target.y, target.count);
  };
  const onRawMouse = ({ input }: CliRendererRawMouseEvent) => {
    if (input.button !== 0) return;
    if (input.modifiers.ctrl || input.modifiers.alt || input.modifiers.shift) return;
    if (input.type === "up") {
      // Press and release read together: apply before the release is dispatched.
      applyPending();
      return;
    }
    if (input.type !== "down") return;
    const count = clicks(input);
    if (count < 2) return;
    pending = { count, x: input.x, y: input.y };
    // The renderer still processes this press (it collapses the selection);
    // the word range is applied right after that.
    queueMicrotask(applyPending);
  };
  renderer.on(CliRenderEvents.RAW_MOUSE, onRawMouse);
  return () => {
    renderer.off(CliRenderEvents.RAW_MOUSE, onRawMouse);
  };
}
