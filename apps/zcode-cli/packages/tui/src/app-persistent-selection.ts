import { CliRenderEvents, type CliRenderer, type CliRendererRawMouseEvent } from "@mbears/opentui-core";
import { hasCopyableSelectionText } from "./app-copy.js";

// Local patch (persistent-selection): the stock TUI cleared the selection on
// every mouse-up, right after copying it, so the highlight was gone before it
// could be seen. The selection now stays highlighted after the mouse is
// released; Ctrl+C and Ctrl+Y still copy it and then remove it. A plain left
// press dismisses it - also on controls that swallow the mouse event, which
// stops the renderer from clearing the selection itself. A press without a
// drag leaves an empty selection behind; that one is dropped on release.

export function installPersistentSelection(renderer: CliRenderer): () => void {
  const onRawMouse = ({ input }: CliRendererRawMouseEvent) => {
    if (input.button !== 0) return;
    if (input.type === "down") {
      // Ctrl+press extends the current selection instead of replacing it.
      if (!input.modifiers.ctrl && renderer.hasSelection) renderer.clearSelection();
      return;
    }
    if (input.type === "up") {
      // The renderer finishes the selection while dispatching this event.
      queueMicrotask(() => {
        if (renderer.isDestroyed || !renderer.hasSelection) return;
        if (!hasCopyableSelectionText(renderer.getSelection()?.getSelectedText())) {
          renderer.clearSelection();
        }
      });
    }
  };
  renderer.on(CliRenderEvents.RAW_MOUSE, onRawMouse);
  return () => {
    renderer.off(CliRenderEvents.RAW_MOUSE, onRawMouse);
  };
}
