import {
  MouseEvent,
  parseColor,
  type ColorInput,
  type OptimizedBuffer,
  type RGBA,
  type Renderable,
  type ScrollBoxRenderable,
} from "@mbears/opentui-core";

// Local patch (sidebar-scrollbar): the sidebar does not use the stock slider of
// its scroll box. That slider draws the thumb with the block glyphs, which the
// user's font renders as small squares ("beads"), and it sizes the thumb from
// a viewport size that it clamps to the scroll range while that range is still
// small: a sidebar that mounts with little content kept a viewport of one row,
// so the thumb came out short and sat in the middle of the track. This column
// draws the thumb with filled cells, in the theme color, from the real scroll
// state at draw time.

export const SIDEBAR_SCROLLBAR_ID = "sidebar-scrollbar";
export const SIDEBAR_SCROLLBAR_WIDTH = 1;

type ScrollState = { content: number; scrollTop: number; viewport: number };
/** The state of the scroll box plus the place of its viewport on screen. */
type Track = ScrollState & { rows: number; screenTop: number };
export type ThumbGeometry = { size: number; start: number };
type ScrollbarColumn = Renderable & { thumbColor?: ColorInput };

/**
 * The thumb of a track `trackHeight` rows high, in whole rows. Its length is
 * the share of the viewport in the content; it travels the rows the content
 * can scroll. Null while there is nothing to scroll.
 */
export function sidebarThumbGeometry(
  scroll: ScrollState,
  trackHeight: number,
): ThumbGeometry | null {
  if (!(scroll.content > scroll.viewport) || !(trackHeight >= 1)) return null;
  const size = Math.max(1, Math.round((trackHeight * scroll.viewport) / scroll.content));
  const travel = trackHeight - size;
  const start = Math.round((scroll.scrollTop / (scroll.content - scroll.viewport)) * travel);
  return { size, start: Math.max(0, Math.min(start, travel)) };
}

let scroller: ScrollBoxRenderable | undefined;
let dragging = false;
let dragOffset = 0;

/**
 * Ref of the scroll box: the scrollbar column reads its scroll state, and the
 * stock slider stays hidden - the setter, not an option, so that the slider
 * does not show itself again once the content grows.
 */
export function trackSidebarScroller(box: ScrollBoxRenderable | null): void {
  scroller = box && !box.isDestroyed ? box : undefined;
  dragging = false;
  if (scroller) scroller.verticalScrollBar.visible = false;
}

/** `renderAfter` of the scrollbar column: the thumb is drawn after the column. */
export function drawSidebarScrollbar(this: ScrollbarColumn, buffer: OptimizedBuffer): void {
  const track = scrollTrack();
  if (!track) return;
  const thumb = sidebarThumbGeometry(track, track.rows);
  if (!thumb) return;
  buffer.fillRect(
    this.x,
    track.screenTop + thumb.start,
    this.width,
    thumb.size,
    thumbColor(this.thumbColor),
  );
}

/** A press on the column: on the thumb it starts a drag, on the track it jumps there. */
export function sidebarScrollbarMouseDown(this: Renderable, event: MouseEvent): void {
  // The column is a control: the press is neither a selection nor a copy.
  event.stopPropagation();
  event.preventDefault();
  const track = scrollTrack();
  dragging = track !== undefined;
  if (!track) return;
  const thumb = sidebarThumbGeometry(track, track.rows);
  if (!thumb) return;
  // One cell wide: the pointer is bound to the column for the drag, or the
  // first movement sideways would drop it.
  capturePointer(this);
  dragOffset = event.y - (track.screenTop + thumb.start);
  if (dragOffset < 0 || dragOffset >= thumb.size) {
    dragOffset = Math.floor(thumb.size / 2);
    scrollToPointer(track, event.y);
  }
}

export function sidebarScrollbarDrag(this: Renderable, event: MouseEvent): void {
  if (!dragging) return;
  event.stopPropagation();
  event.preventDefault();
  const track = scrollTrack();
  if (track) scrollToPointer(track, event.y);
}

export function sidebarScrollbarMouseUp(this: Renderable, event: MouseEvent): void {
  if (!dragging) return;
  sidebarScrollbarDrag.call(this, event);
  dragging = false;
}

export function sidebarScrollbarMove(): void {
  // Movement without a button: a release that never reached the column ends a drag.
  dragging = false;
}

export function sidebarScrollbarScroll(event: MouseEvent): void {
  // A wheel turn over the column scrolls the sections like anywhere else in the sidebar.
  if (scroller && !scroller.isDestroyed) scroller.processMouseEvent(new MouseEvent(scroller, event));
}

/**
 * Routes the pointer events to the column until the button is released. The
 * renderer method is not part of the public surface: without it the drag still
 * works, as long as the pointer stays over the column.
 */
function capturePointer(column: Renderable): void {
  const renderer = column.ctx as Renderable["ctx"] & {
    setCapturedRenderable?: (renderable: Renderable) => void;
  };
  renderer.setCapturedRenderable?.(column);
}

/**
 * The track is the viewport of the scroll box: where it is on screen and how
 * many rows it shows. The column is only the place the thumb lives in.
 */
function scrollTrack(): Track | undefined {
  if (!scroller || scroller.isDestroyed) return undefined;
  return {
    content: scroller.scrollHeight,
    rows: scroller.viewport.height,
    screenTop: scroller.viewport.y,
    scrollTop: scroller.scrollTop,
    viewport: scroller.viewport.height,
  };
}

/** Scrolls so that the thumb top lands `dragOffset` rows above the pointer. */
function scrollToPointer(track: Track, pointerY: number): void {
  if (!scroller) return;
  const thumb = sidebarThumbGeometry(track, track.rows);
  if (!thumb) return;
  const travel = track.rows - thumb.size;
  const start = Math.max(0, Math.min(pointerY - track.screenTop - dragOffset, travel));
  scroller.scrollTop =
    travel > 0 ? Math.round((start / travel) * (track.content - track.viewport)) : 0;
}

let cachedColorSource: ColorInput | undefined;
let cachedColor: RGBA | undefined;

function thumbColor(source: ColorInput | undefined): RGBA {
  // The color follows the theme: it is read on every render, parsed once per value.
  if (source !== cachedColorSource || !cachedColor) {
    cachedColor = parseColor(source ?? "#9a9ea3");
    cachedColorSource = source;
  }
  return cachedColor;
}
