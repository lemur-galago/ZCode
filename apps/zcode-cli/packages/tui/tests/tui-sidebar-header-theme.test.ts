import assert from "node:assert/strict";
import test from "node:test";
import { testRender } from "@mbears/opentui-react/test-utils";
import { getZCodeCopy } from "@zcode/i18n";
import React, { act } from "react";
import type { SidebarState } from "../src/app-model.js";
import { Sidebar } from "../src/app-sidebar.js";
import { palette, setActiveTuiThemeMode } from "../src/theme/index.js";

// Local patch (sidebar-header-theme-color): the header style was a
// module-level constant, so it kept the text color of the theme that was
// active when the module loaded - the default dark one. On the light theme
// every section header was light gray on a light background: invisible,
// together with the collapse toggles the headers are.

type ActEnvironment = { IS_REACT_ACT_ENVIRONMENT?: boolean };
const actEnvironment = globalThis as typeof globalThis & ActEnvironment;
type Span = { fg?: { buffer: Record<string, number> }; text: string };
const HEADERS = ["MCP", "Modified Files", "Todos"];

test("section headers take the text color of the active theme", async () => {
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const headerColors: Record<string, number[]> = {};

  try {
    // The theme switches after the modules were loaded, as in the app: the
    // terminal reports its colors once the renderer is up.
    for (const mode of ["light", "dark"] as const) {
      setActiveTuiThemeMode(mode);
      let view: Awaited<ReturnType<typeof testRender>> | undefined;
      await act(async () => {
        view = await testRender(
          React.createElement(
            "box",
            { style: { height: 24, width: 42 } },
            React.createElement(Sidebar, { ...baseSidebarState, copy: getZCodeCopy("en-US").tui }),
          ),
          { height: 24, width: 42 },
        );
        await view.flush();
      });
      try {
        assert.ok(view);
        const lines = (
          (view.captureSpans() as unknown as { lines: Array<{ spans: Span[] }> }).lines ?? []
        );
        for (const title of HEADERS) {
          const span = lines
            .flatMap((line) => line.spans)
            .find((candidate) => candidate.text.trim().endsWith(title));
          assert.ok(span, `No header "${title}" in the ${mode} theme.`);
          const color = [span.fg?.buffer?.["0"], span.fg?.buffer?.["1"], span.fg?.buffer?.["2"]];
          assert.deepEqual(
            color,
            hexToRgb(palette.text),
            `"${title}" is not drawn in the text color of the ${mode} theme.`,
          );
          headerColors[title] = color as number[];
        }
      } finally {
        await act(async () => {
          view?.renderer.destroy();
        });
      }
    }
  } finally {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }

  // Both themes were checked with their own text color, and those differ.
  assert.equal(new Set(Object.values(headerColors).map((color) => color.join(","))).size, 1);
  assert.notDeepEqual(hexToRgb("#111827"), hexToRgb("#e5e7eb"));
});

function hexToRgb(hex: string): number[] {
  return [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((part) => Number.parseInt(part, 16));
}

const baseSidebarState: SidebarState = {
  busy: false,
  contextUsage: {},
  draft: "",
  lastEvent: "idle",
  messageCount: 0,
  mcpStatus: { loading: false, servers: {} },
  mode: "build",
  model: "glm-4.6",
  modifiedFiles: [],
  networkRequests: [],
  status: "Ready.",
  statusDetails: [],
  thoughtLevel: "medium",
  todos: [],
};
