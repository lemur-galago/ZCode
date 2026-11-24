import { EditBufferRenderable, TextBufferRenderable, parseColor } from "@mbears/opentui-core";
import type { RGBA } from "@mbears/opentui-core";
import { activeTuiTheme } from "./theme/index.js";
import type { TuiThemeTokens } from "./theme/index.js";

// Local patch (selection-theme-colors): OpenTUI draws a selection by swapping
// the foreground and the background of every cell, and uses black for the text
// when the cell has no background of its own. On the dark palette that gives
// light blocks with black text; on the light palette the text is dark on a
// dark block and cannot be read. A text renderable that has no selection
// colors of its own therefore borrows the selection background of the active
// theme for the calls that hand the colors to the native layer. The text keeps
// its own color, as in an editor.

// The methods of the two text-bearing base classes that pass the colors on.
const COLORED_METHODS = [
  "onSelectionChanged",
  "updateLocalSelection",
  "refreshSelectionStyle",
  "setSelection",
] as const;

type MethodRecord = Record<string, (...args: unknown[]) => unknown>;
// The private field every one of those methods reads; checked with `in` so that
// a renamed field in a newer OpenTUI leaves the selection as it was.
type SelectionColorHolder = { _selectionBg: RGBA | undefined };

/** Runs `task` with the selection background of the theme while `target` has none. */
export function withThemeSelectionBackground<T>(
  target: object,
  task: () => T,
  theme: TuiThemeTokens = activeTuiTheme(),
): T {
  const holder = target as SelectionColorHolder;
  if (!("_selectionBg" in holder) || holder._selectionBg !== undefined || !theme.selectionBackground) {
    return task();
  }
  holder._selectionBg = parseColor(theme.selectionBackground);
  try {
    return task();
  } finally {
    holder._selectionBg = undefined;
  }
}

let installations = 0;
const restoreOriginals: Array<() => void> = [];

/** Lends the theme selection background to every text renderable without own colors. */
export function installThemeSelectionColors(): () => void {
  installations += 1;
  if (installations === 1) {
    for (const prototype of [TextBufferRenderable.prototype, EditBufferRenderable.prototype]) {
      const methods = prototype as unknown as MethodRecord;
      for (const method of COLORED_METHODS) {
        const original = methods[method];
        if (typeof original !== "function") continue;
        methods[method] = function (this: object, ...args: unknown[]): unknown {
          return withThemeSelectionBackground(this, () => original.apply(this, args));
        };
        restoreOriginals.push(() => {
          methods[method] = original;
        });
      }
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    installations -= 1;
    if (installations === 0) {
      for (const restore of restoreOriginals.splice(0)) restore();
    }
  };
}
