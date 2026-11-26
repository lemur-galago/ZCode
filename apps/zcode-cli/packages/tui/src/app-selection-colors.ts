import {
  EditBufferRenderable,
  TextBufferRenderable,
  TextTableRenderable,
  parseColor,
} from "@mbears/opentui-core";
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
// A markdown table is a renderable of its own that passes the colors to its
// cells from one method, for a new selection and again when it is laid out.
const TABLE_COLORED_METHODS = ["applySelectionToCells"] as const;

const COLORED_CLASSES: ReadonlyArray<readonly [object, readonly string[]]> = [
  [TextBufferRenderable.prototype, COLORED_METHODS],
  [EditBufferRenderable.prototype, COLORED_METHODS],
  [TextTableRenderable.prototype, TABLE_COLORED_METHODS],
];

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
    for (const [prototype, methods] of COLORED_CLASSES) {
      const record = prototype as unknown as MethodRecord;
      for (const method of methods) {
        const original = record[method];
        if (typeof original !== "function") continue;
        record[method] = function (this: object, ...args: unknown[]): unknown {
          return withThemeSelectionBackground(this, () => original.apply(this, args));
        };
        restoreOriginals.push(() => {
          record[method] = original;
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
