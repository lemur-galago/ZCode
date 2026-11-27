import React from "react";
import type { TuiCopy } from "@zcode/i18n";
import type { ThoughtTranscriptPart } from "./app-model.js";
import { palette } from "./app-model.js";
import { DEFAULT_TUI_COPY } from "./app-locale.js";
// Local patch (stream-coalesce).
import { watchExpandedStreamingThought } from "./app-stream-coalesce.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

const COLLAPSED_MARKER = "+";
const EXPANDED_MARKER = "-";

export function ThoughtTranscriptPartView({
  copy = DEFAULT_TUI_COPY,
  part,
}: {
  copy?: TuiCopy;
  part: ThoughtTranscriptPart;
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);
  // Local patch (stream-coalesce): the text of an expanded thought is on
  // screen, so the stream buffer has to keep it current; a collapsed one waits
  // for the end of the reasoning. Only a thought that still streams counts.
  const view = React.useMemo(() => Symbol("thought-view"), []);
  const streaming = part.status === "thinking";
  React.useEffect(() => {
    if (!expanded || !streaming) return undefined;
    return watchExpandedStreamingThought(view);
  }, [expanded, streaming, view]);
  return h(ThoughtTranscriptPartFrame, {
    copy,
    expanded,
    onToggle: () => setExpanded((current) => !current),
    part,
  });
}

export function ThoughtTranscriptPartFrame({
  copy = DEFAULT_TUI_COPY,
  expanded,
  onToggle,
  part,
}: {
  copy?: TuiCopy;
  expanded: boolean;
  onToggle: () => void;
  part: ThoughtTranscriptPart;
}): React.ReactElement {
  const label = thoughtPlaceholderLabel(part, copy);
  const marker = expanded ? EXPANDED_MARKER : COLLAPSED_MARKER;

  return h(
    "box",
    {
      onMouseUp: onToggle,
      style: {
        backgroundColor: "transparent",
        flexDirection: "column",
        marginBottom: 1,
        marginTop: 1,
        width: "100%",
      },
    },
    h(
      "text",
      {
        selectable: false,
        style: { fg: part.status === "thinking" ? palette.accent : palette.muted },
      },
      `${marker} ${label}`,
    ),
    ...(expanded
      ? [
          h(
            "text",
            {
              key: "thought-content",
              style: { fg: palette.muted, width: "100%", wrapMode: "word" },
            },
            part.text.trim(),
          ),
        ]
      : []),
  );
}

export function thoughtPlaceholderLabel(part: ThoughtTranscriptPart, copy: TuiCopy): string {
  return part.status === "thinking"
    ? copy.transcript.thought.thinking
    : copy.transcript.thought.complete;
}
