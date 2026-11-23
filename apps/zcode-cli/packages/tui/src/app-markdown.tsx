import { baseComponents } from "@mbears/opentui-react";
import type { SyntaxStyle } from "@mbears/opentui-core";
import React from "react";
import { createMarkdownSyntaxStyle } from "./app-markdown-theme.js";
import { activeTuiTheme } from "./theme/index.js";
import type { TuiThemeTokens } from "./theme/index.js";

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

// Local patch (markdown-syntax-style-cache): OpenTUI treats a new syntaxStyle
// object as a style change and on the next frame re-applies the content of
// every block of the message; each native re-apply leaks a 64 KB block. A
// message re-rendered on every spinner tick therefore grew its session by
// tens of GB a day. The theme object is stable per theme, so keep one style.
let cachedSyntaxStyleTheme: TuiThemeTokens | undefined;
let cachedSyntaxStyle: SyntaxStyle | undefined;

function markdownSyntaxStyle(theme: TuiThemeTokens): SyntaxStyle | undefined {
  if (theme !== cachedSyntaxStyleTheme) {
    cachedSyntaxStyleTheme = theme;
    cachedSyntaxStyle = createMarkdownSyntaxStyle(theme);
  }
  return cachedSyntaxStyle;
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

  const syntaxStyle = markdownSyntaxStyle(theme);
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
