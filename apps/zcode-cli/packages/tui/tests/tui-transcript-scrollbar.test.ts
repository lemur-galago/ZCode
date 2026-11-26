import assert from "node:assert/strict";
import test from "node:test";
import type { ScrollBoxRenderable } from "@mbears/opentui-core";
import { parseColor } from "@mbears/opentui-core";
import { testRender } from "@mbears/opentui-react/test-utils";
import React, { act } from "react";
import type { Message } from "../src/app-model.js";
import { ContentPane } from "../src/app-transcript-components.js";
import {
  BUILTIN_TUI_THEMES,
  getActiveTuiThemeMode,
  setActiveTuiThemeMode,
} from "../src/theme/index.js";

// Local patch (transcript-scrollbar): the transcript showed the stock scrollbar
// of its scroll box as is. Its look is fixed for a dark theme whatever the
// theme of the TUI: a dark track and white arrows, invisible on the light one.
// Its thumb is made of block glyphs, small squares in the user's font, and the
// stock slider sizes it from a viewport that it clamps to the scroll range
// while that range is still small, so a transcript that starts empty keeps a
// thumb of one cell. The column now shows a thumb of whole rows in the colors
// of the theme.

type View = Awaited<ReturnType<typeof testRender>>;
type CapturedColor = { buffer: Record<string, number> };
type Span = { bg?: CapturedColor; fg?: CapturedColor; text: string; width?: number };
type ActEnvironment = { IS_REACT_ACT_ENVIRONMENT?: boolean };
const actEnvironment = globalThis as typeof globalThis & ActEnvironment;

const WIDTH = 50;
const HEIGHT = 15;
// The scroll box fills the frame except for the row of its bottom margin: 14
// rows. Its scrollbar is the last column: an arrow above the 12 rows of the
// track and one below them.
const COLUMN = WIDTH - 1;
const BOX_ROWS = HEIGHT - 1;
const TRACK_TOP = 1;
const TRACK_ROWS = BOX_ROWS - 2;
const BLOCK_GLYPHS = /[\u2580\u2584\u2588]/;
// A message of one line takes three rows: two for its row, one for the gap
// after it. Six messages make 20 rows of content, with the padding of the
// content: 6 rows of scroll, a thumb of 8 rows that travels the other 4.
const SIX_MESSAGES = { content: 20, range: 6, thumb: 8, travel: 4 };

test("a transcript that fits the screen has no scrollbar", async () => {
  const screen = await showTranscript({ messages: messages(3) });
  try {
    assert.equal(screen.scrollSize(), BOX_ROWS);
    assert.equal(screen.stockScrollbarVisible(), false);
    assert.equal(screen.thumb(), null);
    // The column goes back to the transcript.
    assert.equal(screen.scroller().viewport.width, WIDTH);
    assert.deepEqual([...screen.columnCharacters()], [" "]);
  } finally {
    await screen.close();
  }
});

test("a long transcript gets a thumb of whole rows between two arrows, in the colors of the theme", async () => {
  const screen = await showTranscript({ messages: messages(6) });
  try {
    const theme = BUILTIN_TUI_THEMES.dark;
    assert.equal(screen.scrollSize(), SIX_MESSAGES.content);
    assert.equal(screen.stockScrollbarVisible(), true);
    // At the end of the transcript: the thumb sits at the end of the track.
    assert.equal(screen.scrollTop(), SIX_MESSAGES.range);
    assert.deepEqual(screen.thumb(), { size: SIX_MESSAGES.thumb, start: SIX_MESSAGES.travel });

    // No block glyph is left in the column, and the arrows are still there.
    const characters = [...screen.columnCharacters()];
    assert.equal(characters.some((character) => BLOCK_GLYPHS.test(character)), false);
    assert.deepEqual(screen.columnCharacters(), new Set([" ", "▲", "▼"]));
    assert.deepEqual(screen.columnRows("▲"), [0]);
    assert.deepEqual(screen.columnRows("▼"), [BOX_ROWS - 1]);
    // The dark track of the stock slider is gone: the rows around the thumb
    // take the background of the theme, the thumb the color of the muted text.
    for (const row of screen.columnRows(" ", TRACK_TOP, BOX_ROWS - 1)) {
      assert.equal(
        screen.cell(row).background,
        row < TRACK_TOP + SIX_MESSAGES.travel ? themeColor(theme.background) : themeColor(theme.textMuted),
      );
    }

    // The arrows follow the theme too: the stock ones are white.
    for (const row of [0, BOX_ROWS - 1]) {
      assert.equal(screen.cell(row).foreground, themeColor(theme.textMuted));
      assert.equal(screen.cell(row).background, themeColor(theme.background));
    }
  } finally {
    await screen.close();
  }
});

test("the column takes the colors of the light theme, also of a live transcript", async () => {
  const screen = await showTranscript({ messages: messages(6) });
  try {
    const dark = BUILTIN_TUI_THEMES.dark;
    const light = BUILTIN_TUI_THEMES.light;
    const thumbRow = TRACK_TOP + SIX_MESSAGES.travel;
    assert.equal(screen.cell(thumbRow).background, themeColor(dark.textMuted));
    assert.notEqual(themeColor(dark.textMuted), themeColor(light.textMuted));
    assert.notEqual(themeColor(dark.background), themeColor(light.background));

    setActiveTuiThemeMode("light");
    await screen.repaint();
    assert.deepEqual(screen.thumb(), { size: SIX_MESSAGES.thumb, start: SIX_MESSAGES.travel });
    assert.equal(screen.cell(thumbRow - 1).background, themeColor(light.background));
    assert.equal(screen.cell(thumbRow).background, themeColor(light.textMuted));
    assert.equal(screen.cell(0).foreground, themeColor(light.textMuted));
  } finally {
    await screen.close();
    setActiveTuiThemeMode("dark");
  }
});

test("a transcript that fills after it mounted gets the same thumb", async () => {
  // The scenario of a real session: empty at mount, the messages come later.
  const screen = await showTranscript({ messages: [] });
  try {
    assert.equal(screen.stockScrollbarVisible(), false);
    assert.equal(screen.thumb(), null);

    await screen.set(messages(6));
    assert.equal(screen.scrollSize(), SIX_MESSAGES.content);
    assert.equal(screen.stockScrollbarVisible(), true);
    assert.deepEqual(screen.thumb(), { size: SIX_MESSAGES.thumb, start: SIX_MESSAGES.travel });

    // Two rows up of the six the content scrolls: two thirds of the way.
    await screen.wheel(-2);
    assert.equal(screen.scrollTop(), 4);
    assert.deepEqual(screen.thumb(), { size: SIX_MESSAGES.thumb, start: 3 });
  } finally {
    await screen.close();
  }
});

test("the thumb follows the wheel, also a wheel turn over the column", async () => {
  const screen = await showTranscript({ messages: messages(6) });
  try {
    // Halfway up: halfway along the travel of the thumb.
    await screen.wheel(-3);
    assert.equal(screen.scrollTop(), 3);
    assert.deepEqual(screen.thumb(), { size: SIX_MESSAGES.thumb, start: 2 });

    await screen.wheel(2, COLUMN);
    assert.equal(screen.scrollTop(), 5);
    assert.deepEqual(screen.thumb(), { size: SIX_MESSAGES.thumb, start: 3 });
  } finally {
    await screen.close();
  }
});

test("a press on the track jumps there, a drag moves the thumb with the pointer", async () => {
  const screen = await showTranscript({ messages: messages(6) });
  try {
    // Just above the thumb, which sits at the end of the track: it lands under
    // the pointer as far as it travels.
    await screen.click(TRACK_TOP + 3);
    assert.equal(screen.scrollTop(), 0);
    assert.deepEqual(screen.thumb(), { size: SIX_MESSAGES.thumb, start: 0 });
    // The slider is a control: the press selected and copied nothing.
    assert.equal(screen.hasSelection(), false);

    // On the thumb, two rows down: the thumb keeps its grip on the pointer.
    await screen.drag(TRACK_TOP + 6, TRACK_TOP + 8);
    assert.equal(screen.scrollTop(), 3);
    assert.deepEqual(screen.thumb(), { size: SIX_MESSAGES.thumb, start: 2 });

    // A drag that leaves the track stops at its end.
    await screen.drag(TRACK_TOP + 6, HEIGHT - 2);
    assert.equal(screen.scrollTop(), SIX_MESSAGES.range);
    assert.deepEqual(screen.thumb(), { size: SIX_MESSAGES.thumb, start: SIX_MESSAGES.travel });
  } finally {
    await screen.close();
  }
});

test("the arrows scroll by half a viewport", async () => {
  // Eight messages: 26 rows of content, 12 rows of scroll.
  const screen = await showTranscript({ messages: messages(8) });
  try {
    assert.equal(screen.scrollTop(), 12);
    await screen.click(0);
    assert.equal(screen.scrollTop(), 5);
    await screen.click(BOX_ROWS - 1);
    assert.equal(screen.scrollTop(), 12);
  } finally {
    await screen.close();
  }
});

test("the layout facts the thumb relies on", async () => {
  const screen = await showTranscript({ messages: messages(6) });
  try {
    const { endArrow, slider, startArrow } = screen.scroller().verticalScrollBar;
    // The column is one cell wide at the right edge of the scroll box.
    assert.equal(slider.x, COLUMN);
    assert.equal(slider.width, 1);
    assert.equal(screen.scroller().viewport.width, WIDTH - 1);
    // The track is the slider, between the two arrows.
    assert.equal(startArrow.y, 0);
    assert.equal(slider.y, TRACK_TOP);
    assert.equal(slider.height, TRACK_ROWS);
    assert.equal(endArrow.y, BOX_ROWS - 1);
  } finally {
    await screen.close();
  }
});

let updateMessages: (messages: Message[]) => void = () => undefined;

function TranscriptView({ initial }: { initial: Message[] }): React.ReactElement {
  const [messages, setMessages] = React.useState(initial);
  updateMessages = setMessages;
  return React.createElement(
    "box",
    { style: { flexDirection: "column", height: "100%", width: "100%" } },
    React.createElement(ContentPane, {
      emptyText: "Nothing here yet.",
      focused: false,
      id: "main-transcript",
      messages,
    }),
  );
}

async function showTranscript(options: { messages: Message[] }): Promise<{
  cell: (row: number) => { background: string | undefined; character: string; foreground: string | undefined };
  click: (row: number) => Promise<void>;
  close: () => Promise<void>;
  columnCharacters: () => Set<string>;
  columnRows: (character: string, from?: number, to?: number) => number[];
  drag: (fromRow: number, toRow: number) => Promise<void>;
  hasSelection: () => boolean;
  repaint: () => Promise<void>;
  scrollSize: () => number;
  scrollTop: () => number;
  scroller: () => ScrollBoxRenderable;
  set: (messages: Message[]) => Promise<void>;
  stockScrollbarVisible: () => boolean;
  thumb: () => { size: number; start: number } | null;
  wheel: (turns: number, x?: number) => Promise<void>;
}> {
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  let view: View | undefined;
  await act(async () => {
    view = await testRender(React.createElement(TranscriptView, { initial: options.messages }), {
      height: HEIGHT,
      width: WIDTH,
    });
    await view.flush();
  });
  if (!view) throw new Error("The transcript was not rendered.");
  const paint = async () => {
    for (let pass = 0; pass < 2; pass += 1) {
      await act(async () => {
        await settle();
        await view?.renderOnce();
      });
    }
  };
  await paint();
  const scrollerOf = () => {
    const box = view?.renderer.root.findDescendantById("main-transcript") as ScrollBoxRenderable | undefined;
    assert.ok(box, "the scroll box of the transcript");
    return box;
  };
  const cell = (row: number) => {
    const lines = (view?.captureSpans() as unknown as { lines: Array<{ spans: Span[] }> }).lines;
    let start = 0;
    for (const span of lines[row]?.spans ?? []) {
      const end = start + (span.width ?? [...span.text].length);
      if (COLUMN >= start && COLUMN < end) {
        return {
          background: colorOf(span.bg),
          character: span.text.charAt(COLUMN - start) ?? " ",
          foreground: colorOf(span.fg),
        };
      }
      start = end;
    }
    return { background: undefined, character: " ", foreground: undefined };
  };
  const rowsOf = (predicate: (row: number) => boolean) =>
    Array.from({ length: HEIGHT }, (_, row) => row).filter(predicate);
  return {
    cell,
    click: async (row) => {
      await act(async () => {
        await view?.mockMouse.click(COLUMN, row);
        await settle();
      });
      await paint();
    },
    close: async () => {
      await act(async () => {
        view?.renderer.destroy();
      });
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    },
    columnCharacters: () =>
      new Set(
        view
          ?.captureCharFrame()
          .split("\n")
          .filter((line) => line.length > COLUMN)
          .map((line) => line.charAt(COLUMN)) ?? [],
      ),
    columnRows: (character, from = 0, to = HEIGHT) =>
      rowsOf((row) => row >= from && row < to && cell(row).character === character),
    drag: async (fromRow, toRow) => {
      await act(async () => {
        await view?.mockMouse.pressDown(COLUMN, fromRow);
        await settle();
      });
      await act(async () => {
        await view?.mockMouse.moveTo(COLUMN, toRow);
        await settle();
      });
      await act(async () => {
        await view?.mockMouse.release(COLUMN, toRow);
        await settle();
      });
      await paint();
    },
    hasSelection: () => Boolean(view?.renderer.hasSelection),
    repaint: paint,
    scrollSize: () => scrollerOf().scrollHeight,
    scrollTop: () => scrollerOf().scrollTop,
    scroller: scrollerOf,
    set: async (messages) => {
      await act(async () => {
        updateMessages(messages);
        await settle();
      });
      await paint();
    },
    stockScrollbarVisible: () => scrollerOf().verticalScrollBar.visible,
    thumb: () => {
      const muted = themeColor(BUILTIN_TUI_THEMES[getActiveTuiThemeMode()].textMuted);
      const rows = rowsOf(
        (row) => row >= TRACK_TOP && row < TRACK_TOP + TRACK_ROWS && cell(row).background === muted,
      );
      if (rows.length === 0) return null;
      assert.deepEqual(rows, rows.map((_, index) => rows[0] + index), "the thumb is one run of rows");
      return { size: rows.length, start: rows[0] - TRACK_TOP };
    },
    wheel: async (turns, x = WIDTH - 20) => {
      await act(async () => {
        for (let turn = 0; turn < Math.abs(turns); turn += 1) {
          await view?.mockMouse.scroll(x, TRACK_TOP + 4, turns > 0 ? "down" : "up");
        }
        await settle();
      });
      await paint();
    },
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function messages(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    content: `Message number ${index + 1}`,
    parts: [],
    role: "agent" as const,
  }));
}

/** The colors as OpenTUI parsed them, both sides: the capture and the theme. */
function colorOf(color: CapturedColor | undefined): string | undefined {
  return color && [color.buffer["0"], color.buffer["1"], color.buffer["2"]].join(",");
}

function themeColor(source: string): string {
  return parseColor(source)
    .toInts()
    .slice(0, 3)
    .join(",");
}
