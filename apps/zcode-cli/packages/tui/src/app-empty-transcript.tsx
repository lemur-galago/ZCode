import React from "react";
import { palette } from "./app-model.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

// minimal-empty-transcript-logo: local patch — replace the six-line ASCII
// banner with the figlet "Rammstein" wordmark "zcode" (ASCII-only glyphs, so
// every glyph is single-cell even in JetBrains Mono / IDEA terminal — the
// earlier thin-line variant broke because ╱ renders two cells there). The
// first letter is the accent color, the rest is the text color. All rows are
// padded to one common width so per-row centering keeps the columns aligned.
// Statically centered, no shimmer; the `animated` prop is accepted and
// ignored. ZCODE_LOGO_LINES lists the rendered rows for tests.
const LOGO_ROW_WIDTH = 40;
const LOGO_ROWS: ReadonlyArray<readonly [string, string]> = [
  ["  ______", "  ______  _____  _____   ______ "],
  [" |___   |", "|   ___|/     \\|     \\ |   ___|"],
  ["  .-`.-`", " |   |__ |     ||      \\|   ___|"],
  [" |______|", "|______|\\_____/|______/|______|"],
] as const;

export const ZCODE_LOGO_LINES: readonly string[] = LOGO_ROWS.map(
  ([firstLetter, rest]) => firstLetter + rest,
);

export function EmptyTranscriptLogo(_props: { animated?: boolean } = {}): React.ReactElement {
  return h(
    "box",
    {
      style: {
        alignItems: "center",
        flexDirection: "column",
        flexGrow: 1,
        justifyContent: "center",
        width: "100%",
      },
    },
    ...LOGO_ROWS.map(([firstLetter, rest], index) =>
      h(
        "box",
        { key: `logo-row-${index}`, style: { flexDirection: "row" } },
        h("text", { style: { fg: palette.accent } }, firstLetter),
        h("text", { style: { fg: palette.text } }, rest),
      ),
    ),
  );
}

// Keep the row width invariant check next to the constants: every row must be
// exactly LOGO_ROW_WIDTH columns or per-row centering shifts the letters.
for (const [firstLetter, rest] of LOGO_ROWS) {
  if (firstLetter.length + rest.length !== LOGO_ROW_WIDTH) {
    throw new Error(`logo row width mismatch: ${firstLetter.length + rest.length} != ${LOGO_ROW_WIDTH}`);
  }
}
