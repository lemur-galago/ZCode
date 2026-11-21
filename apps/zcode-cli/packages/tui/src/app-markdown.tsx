import { baseComponents } from "@mbears/opentui-react";
import React from "react";
import { createMarkdownSyntaxStyle } from "./app-markdown-theme.js";
import { activeTuiTheme } from "./theme/index.js";

type MarkdownRenderMode = "markdown" | "code" | "plain";

type MarkdownTextProps = {
  backgroundColor?: string;
  content: string;
  foregroundColor?: string;
  mode?: MarkdownRenderMode;
  streaming?: boolean;
};

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

export function detectMarkdownRenderMode(
  components: Record<string, unknown> = baseComponents,
): MarkdownRenderMode {
  if (typeof components.markdown === "function") return "markdown";
  if (typeof components.code === "function") return "code";
  return "plain";
}

// terminal-glyph-substitution: U+2116 (numero sign) is an ambiguous-width
// glyph that JetBrains Mono / the IDEA terminal renders as a broken symbol;
// display the familiar "#" instead. Applies to every transcript message.
export function substituteUnsupportedGlyphs(value: string): string {
  return value.replace(/\u2116/g, "#");
}

export function MarkdownText({
  content,
  foregroundColor,
  mode = detectMarkdownRenderMode(),
  streaming = false,
}: MarkdownTextProps): React.ReactElement {
  const theme = activeTuiTheme();
  const textColor = foregroundColor ?? theme.markdownText;
  if (!content) {
    return h("text", { style: { fg: textColor } }, "");
  }
  const safeContent = substituteUnsupportedGlyphs(content);

  const syntaxStyle = createMarkdownSyntaxStyle(theme);
  if (mode === "markdown") {
    if (syntaxStyle) {
      return h("markdown", {
        conceal: true,
        content: safeContent,
        streaming,
        syntaxStyle,
      });
    }
    return h("text", { style: { fg: textColor } }, safeContent);
  }

  if (mode === "code" && syntaxStyle) {
    return h("code", {
      conceal: true,
      content: safeContent,
      drawUnstyledText: false,
      fg: textColor,
      filetype: "markdown",
      streaming,
      syntaxStyle,
    });
  }

  return h("text", { style: { fg: textColor } }, safeContent);
}
