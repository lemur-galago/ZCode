import { SyntaxStyle } from "@mbears/opentui-core";
import type { EditBuffer, TextareaRenderable } from "@mbears/opentui-core";
import React from "react";
import { draftTokens, draftTokensSync, type DraftHighlight } from "./app-script-draft.js";
import { activeTuiTheme } from "./theme/index.js";
import type { TuiThemeTokens } from "./theme/index.js";

// Local patch (script-highlight): the composer colors the fenced blocks of the
// draft and a draft that is a script as a whole, with the ranges the OpenTUI
// editor can style. The colors are read from the ranges on every change: an
// edit drops the highlights of the buffer, so they are applied again right
// after the text was synced.

// Marks the highlights of this module, so that they can be replaced as a set.
const HIGHLIGHT_REF = 0x5c01;

const styles = new Map<TuiThemeTokens, SyntaxStyle>();

export type ScriptScopeStyle = { fg: string; italic?: boolean };

/** The theme color of a scope the script highlighting reports, as in the transcript. */
export function scriptScopeStyle(theme: TuiThemeTokens, scope: string): ScriptScopeStyle | undefined {
  switch (scope) {
    case "comment":
      return { fg: theme.syntaxComment, italic: true };
    case "string":
      return { fg: theme.syntaxString };
    case "keyword":
      return { fg: theme.syntaxKeyword };
    case "function":
      return { fg: theme.syntaxFunction };
    case "type":
      return { fg: theme.syntaxType };
    case "number":
    case "boolean":
      return { fg: theme.syntaxNumber };
    case "fence":
      return { fg: theme.textMuted };
    case "error":
      return { fg: theme.error };
    case "diff.plus":
      return { fg: theme.diffAdded };
    case "diff.minus":
      return { fg: theme.diffRemoved };
    case "diff.delta":
      return { fg: theme.diffHunkHeader };
    default:
      return undefined;
  }
}

/** The style of the script scopes for a theme, created once per theme. */
export function scriptSyntaxStyle(theme: TuiThemeTokens): SyntaxStyle {
  let style = styles.get(theme);
  if (!style) {
    const scopes: Record<string, ScriptScopeStyle> = {};
    for (const scope of [
      "boolean",
      "comment",
      "fence",
      "function",
      "keyword",
      "number",
      "string",
      "type",
    ]) {
      const scopeStyle = scriptScopeStyle(theme, scope);
      if (scopeStyle) scopes[scope] = scopeStyle;
    }
    style = SyntaxStyle.fromStyles(scopes);
    styles.set(theme, style);
  }
  return style;
}

/** Replaces the script highlights of an editor buffer with the ranges of its text. */
export function applyDraftHighlight(
  editBuffer: EditBuffer,
  text: string,
  highlight: DraftHighlight,
  style: SyntaxStyle,
): void {
  editBuffer.removeHighlightsByRef(HIGHLIGHT_REF);
  const lineStarts = lineStartOffsets(text);
  for (const token of highlight.tokens) {
    const styleId = style.getStyleId(token.scope);
    if (styleId === null) continue;
    // A token may span lines, e.g. a block comment; the buffer styles one line at a time.
    let line = lineOfOffset(lineStarts, token.start);
    let start = token.start;
    for (;;) {
      const next = lineStarts[line + 1];
      const lineEnd = next === undefined ? text.length : next - 1;
      const end = Math.min(token.end, lineEnd);
      if (end > start) {
        editBuffer.addHighlight(line, {
          end: end - lineStarts[line],
          hlRef: HIGHLIGHT_REF,
          start: start - lineStarts[line],
          styleId,
        });
      }
      if (token.end <= lineEnd || next === undefined) break;
      line += 1;
      start = next;
    }
  }
}

/** Colors the scripts of the composer draft; call it with the draft and the editor reference. */
export function useComposerHighlighting(
  editorRef: React.RefObject<TextareaRenderable | null>,
  value: string,
): void {
  const theme = activeTuiTheme();
  React.useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed) return undefined;
    const style = scriptSyntaxStyle(theme);
    if (editor.syntaxStyle !== style) editor.syntaxStyle = style;
    // The buffer was synced with the draft just before; its text is the reference.
    const text = editor.plainText;
    const paint = (highlight: DraftHighlight) => {
      if (!editor.isDestroyed && editor.plainText === text) {
        applyDraftHighlight(editor.editBuffer, text, highlight, style);
      }
    };
    const ready = draftTokensSync(text);
    if (ready) {
      paint(ready);
      return undefined;
    }
    let current = true;
    void draftTokens(text).then(
      (highlight) => {
        if (current) paint(highlight);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [editorRef, theme, value]);
}

function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

function lineOfOffset(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}
