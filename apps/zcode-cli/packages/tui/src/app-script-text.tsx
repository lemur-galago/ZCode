import React from "react";
import { scriptScopeStyle } from "./app-composer-highlight.js";
import { draftTokens, draftTokensSync } from "./app-script-draft.js";
import type { ScriptToken } from "./app-script-highlight.js";
import { substituteUnsupportedGlyphs } from "./app-markdown.js";
import { activeTuiTheme } from "./theme/index.js";
import type { TuiThemeTokens } from "./theme/index.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

// Local patch (script-highlight): the text of a user message with the scripts
// in it colored, the same way as in the composer where it was typed. A message
// without a script is rendered as the plain text element it always was.

function scriptSpans(content: string, tokens: ScriptToken[], theme: TuiThemeTokens): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  tokens.forEach((token, index) => {
    if (token.start > cursor) nodes.push(content.slice(cursor, token.start));
    const style = scriptScopeStyle(theme, token.scope);
    nodes.push(h("span", { key: index, style }, content.slice(token.start, token.end)));
    cursor = token.end;
  });
  if (cursor < content.length) nodes.push(content.slice(cursor));
  return nodes;
}

export function ScriptText({
  content,
  foregroundColor,
}: {
  content: string;
  foregroundColor?: string;
}): React.ReactElement {
  const theme = activeTuiTheme();
  // The replacement keeps the length, so the offsets of the ranges hold.
  const safeContent = substituteUnsupportedGlyphs(content);
  const [tokens, setTokens] = React.useState<ScriptToken[]>(() => draftTokensSync(safeContent)?.tokens ?? []);

  React.useEffect(() => {
    const ready = draftTokensSync(safeContent);
    if (ready) {
      setTokens(ready.tokens);
      return undefined;
    }
    let current = true;
    void draftTokens(safeContent).then(
      (highlight) => {
        if (current) setTokens(highlight.tokens);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [safeContent]);

  return h(
    "text",
    { style: { fg: foregroundColor ?? theme.text } },
    ...(tokens.length === 0 ? [safeContent] : scriptSpans(safeContent, tokens, theme)),
  );
}
