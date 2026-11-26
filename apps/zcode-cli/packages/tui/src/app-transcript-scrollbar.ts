import type { ScrollBoxRenderable } from "@mbears/opentui-core";
import { palette } from "./app-model.js";
import {
  createThumbDrag,
  scrollbarColor,
  sidebarThumbGeometry,
  type ThumbTrack,
} from "./app-sidebar-scrollbar.js";

// Local patch (transcript-scrollbar): the transcript draws the scrollbar of its
// scroll box itself, like the sidebar does. The stock parts stay for what they
// do well - the column that shows and hides itself with the content, the
// arrows that scroll by half a viewport - but their look is fixed for a dark
// theme: a #252527 track, white arrows (invisible on the light theme) and a
// thumb of block glyphs, which the user's font renders as small squares with
// gaps ("beads"). The stock thumb is also sized from a viewport that it clamps
// to the scroll range while that range is still small, so a transcript that
// starts empty keeps a thumb of one cell. The thumb here is drawn with filled
// rows, in the colors of the theme, from the real scroll state at draw time.

const ARROW_CHARACTERS = { down: "▼", left: "◀", right: "▶", up: "▲" } as const;

/**
 * Ref of the scroll box of the transcript. Each part of its scrollbar draws
 * itself once more after its stock drawing of the frame, and the slider takes
 * the drag of the thumb drawn here.
 */
export function trackTranscriptScroller(box: ScrollBoxRenderable | null): void {
  if (!box || box.isDestroyed) return;
  const { endArrow, slider, startArrow } = box.verticalScrollBar;
  // The track is the slider between the two arrows: where it is on screen and
  // how many rows it has, read at call time.
  const track = (): ThumbTrack | undefined => {
    if (box.isDestroyed) return undefined;
    return {
      content: box.scrollHeight,
      rows: slider.height,
      screenTop: slider.y,
      scrollTop: box.scrollTop,
      viewport: box.viewport.height,
      scrollTo: (scrollTop) => {
        box.scrollTop = scrollTop;
      },
    };
  };

  slider.renderAfter = (buffer) => {
    // The stock track and its glyphs are already there: these rows cover them.
    const background = scrollbarColor(palette.background);
    buffer.fillRect(slider.x, slider.y, slider.width, slider.height, background);
    const current = track();
    const thumb = current && sidebarThumbGeometry(current, current.rows);
    if (current && thumb) {
      buffer.fillRect(
        slider.x,
        current.screenTop + thumb.start,
        slider.width,
        thumb.size,
        scrollbarColor(palette.muted),
      );
    }
  };
  for (const arrow of [startArrow, endArrow]) {
    arrow.renderAfter = (buffer) => {
      // The stock arrow is white whatever the theme: it is drawn again.
      const background = scrollbarColor(palette.background);
      buffer.fillRect(arrow.x, arrow.y, arrow.width, arrow.height, background);
      buffer.drawText(ARROW_CHARACTERS[arrow.direction], arrow.x, arrow.y, scrollbarColor(palette.muted), background);
    };
  }

  // The stock drag follows the stock thumb, which sits elsewhere than this one.
  const drag = createThumbDrag(track);
  slider.onMouseDown = drag.mouseDown;
  slider.onMouseDrag = drag.drag;
  slider.onMouseUp = drag.mouseUp;
  slider.onMouseMove = drag.cancel;
}
