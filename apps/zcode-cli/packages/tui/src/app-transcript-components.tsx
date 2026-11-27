import React from "react";
import type { TuiCopy } from "@zcode/i18n";
import type { Message } from "./app-model.js";
import { EmptyTranscriptLogo } from "./app-empty-transcript.js";
import { DEFAULT_TUI_COPY } from "./app-locale.js";
// Local patch (script-highlight): scripts in user messages.
import { ScriptText } from "./app-script-text.js";
import { scriptDraft } from "./app-script-draft.js";
// Local patch (transcript-scrollbar): the scrollbar of the transcript, drawn
// in the colors of the theme.
import { trackTranscriptScroller } from "./app-transcript-scrollbar.js";
import { MarkdownText, substituteUnsupportedGlyphs } from "./app-markdown.js";
import { ThoughtTranscriptPartView } from "./app-thought-components.js";
import { ToolTranscriptPartView } from "./app-tool-components.js";
import { WorkflowRunCardView } from "./app-workflow-card.js";
import type { TuiWorkflowCard } from "./app-workflow-mirror.js";
// Local patch (transcript-row-memo).
import { activeTuiTheme, type TuiThemeTokens } from "./theme/index.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

const USER_MESSAGE_VERTICAL_PADDING = 1;

// Local patch (transcript-row-memo): one style object per theme. The transcript
// re-renders whenever the app does, and a fresh object each time made OpenTUI
// re-apply the nested options of the scroll box on every such render.
const scrollboxStyles = new WeakMap<TuiThemeTokens, Record<string, unknown>>();

function transcriptScrollboxStyle(theme: TuiThemeTokens): Record<string, unknown> {
  let style = scrollboxStyles.get(theme);
  if (style === undefined) {
    style = {
      backgroundColor: theme.background,
      border: false,
      flexGrow: 1,
      marginBottom: 1,
      minHeight: 8,
      contentOptions: {
        backgroundColor: theme.background,
        flexDirection: "column",
        padding: 1,
      },
      rootOptions: {
        backgroundColor: theme.background,
      },
      scrollbarOptions: {
        showArrows: true,
      },
      viewportOptions: {
        backgroundColor: theme.background,
      },
      wrapperOptions: {
        backgroundColor: theme.background,
      },
    };
    scrollboxStyles.set(theme, style);
  }
  return style;
}

export function ContentPane({
  animateEmptyLogo = false,
  copy = DEFAULT_TUI_COPY,
  expandedWorkflowRunIds,
  emptyText,
  id,
  focused,
  messages,
  // Local patch (transcript-row-memo): the theme of the rows, see MessageRow.
  theme = activeTuiTheme(),
  terminalWidth = 100,
  workflowCardsByToolCallId,
}: {
  animateEmptyLogo?: boolean;
  copy?: TuiCopy;
  expandedWorkflowRunIds?: ReadonlySet<string>;
  emptyText?: string;
  id?: string;
  focused: boolean;
  messages: Message[];
  theme?: TuiThemeTokens;
  terminalWidth?: number;
  workflowCardsByToolCallId?: ReadonlyMap<string, TuiWorkflowCard>;
}): React.ReactElement {
  return h(
    "scrollbox",
    {
      id,
      focused,
      stickyScroll: true,
      stickyStart: "bottom",
      viewportCulling: true,
      // Local patch (transcript-scrollbar): the parts of the scrollbar draw
      // themselves after their stock drawing.
      ref: trackTranscriptScroller,
      style: transcriptScrollboxStyle(theme),
    },
    ...(messages.length === 0
      ? [
          emptyText
            ? h("text", { key: "empty", style: { fg: theme.textMuted } }, emptyText)
            : h(EmptyTranscriptLogo, { animated: animateEmptyLogo, key: "empty-transcript-logo" }),
        ]
      : messages.map((message, index) =>
          h(MemoizedMessageRow, {
            copy,
            expandedWorkflowRunIds,
            index,
            key: `${index}-${message.role}`,
            message,
            terminalWidth,
            theme,
            workflowCardsByToolCallId,
          }),
        )),
  );
}

export function MessageRow({
  copy = DEFAULT_TUI_COPY,
  expandedWorkflowRunIds,
  message,
  // Local patch (transcript-row-memo): the theme is a prop. The row reads it
  // while it renders, and through MemoizedMessageRow it renders only when its
  // props change: handing it the theme is what makes a theme switch draw the
  // rows again. It is the built-in theme object of the active mode, so it
  // changes only on a switch.
  theme = activeTuiTheme(),
  terminalWidth = 100,
  workflowCardsByToolCallId,
}: {
  copy?: TuiCopy;
  expandedWorkflowRunIds?: ReadonlySet<string>;
  index: number;
  message: Message;
  theme?: TuiThemeTokens;
  terminalWidth?: number;
  workflowCardsByToolCallId?: ReadonlyMap<string, TuiWorkflowCard>;
}): React.ReactElement {
  const parts = message.parts ?? [];
  if (message.role === "timeline") {
    return h(CompactTimelineRow, { copy, message, terminalWidth, theme });
  }
  // speaker labels were visually noisy; only user prompts carry row chrome.
  const isUserMessage = message.role === "user";
  const rowBackground = isUserMessage ? theme.backgroundMessageUser : theme.background;
  const assistantText = message.role === "agent";
  const plainTextColor = message.role === "system" ? theme.warning : theme.text;

  return h(
    "box",
    {
      style: {
        backgroundColor: rowBackground,
        flexDirection: "column",
        marginBottom: 1,
        minHeight: 2,
        paddingLeft: 1,
        paddingRight: 1,
        paddingBottom: isUserMessage ? USER_MESSAGE_VERTICAL_PADDING : 0,
        paddingTop: isUserMessage ? USER_MESSAGE_VERTICAL_PADDING : 0,
        width: "100%",
      },
    },
    ...(assistantText && parts.length === 0
      ? [
          h(MarkdownText, {
            backgroundColor: rowBackground,
            content: message.content,
            key: "content",
            streaming: message.streaming,
          }),
        ]
      : parts.length === 0
        ? [plainContent(message.content, plainTextColor)]
        : []),
    ...parts.map((part, partIndex) => {
      if (part.type === "tool") {
        // 卡片 join 按 toolCallId（与 GUI buildWorkflowRunByToolCallId 同规）。命中即渲染实时卡：
        // 工具行自己的 status 在 CreateWorkflow 上会在 run 还在飞的时候就变成 completed
        // （工具一launch完 run 就返回），所以状态必须读镜像，不能读 part.status。
        const workflowCard = workflowCardsByToolCallId?.get(part.toolCallId);
        if (workflowCard) {
          return h(WorkflowRunCardView, {
            card: workflowCard,
            copy,
            expanded: expandedWorkflowRunIds?.has(workflowCard.runId) ?? false,
            key: `workflow-${part.toolCallId}`,
            terminalWidth,
          });
        }
        // 无命中就回落今日的文本投影（编过但没有 run、或镜像尚未补种）。
        return h(ToolTranscriptPartView, {
          key: `tool-${part.toolCallId}`,
          part,
          terminalWidth,
        });
      }
      if (part.type === "thought") {
        return h(ThoughtTranscriptPartView, {
          copy,
          key: `thought-${partIndex}`,
          part,
        });
      }
      return assistantText && part.format !== "plain"
        ? h(MarkdownText, {
            backgroundColor: rowBackground,
            content: part.text,
            key: `text-${partIndex}`,
            streaming: message.streaming,
          })
        : h(
            "text",
            { key: `text-${partIndex}`, style: { fg: plainTextColor } },
            substituteUnsupportedGlyphs(part.text),
          );
    }),
  );
}

// Local patch (transcript-row-memo): the transcript draws its rows through this
// component. React draws a memoized component again only when one of its props
// changed. The props are the whole input of a row, and the state updates of a
// stream keep every message object they do not touch, so a landing of stream
// text draws the row whose message changed and no other; before, every landing
// drew the whole transcript again, and that cost grew with the history. The
// theme is one of the props (see MessageRow).
export const MemoizedMessageRow = React.memo(MessageRow);

// Local patch (script-highlight): a user message shows the scripts it holds in
// color, as in the composer where it was typed; prose stays the plain text
// element it always was.
function plainContent(content: string, color: string): React.ReactElement {
  if (scriptDraft(content).regions.length > 0) {
    return h(ScriptText, { content, foregroundColor: color, key: "content" });
  }
  return h("text", { key: "content", style: { fg: color } }, substituteUnsupportedGlyphs(content));
}

function CompactTimelineRow({
  copy,
  message,
  terminalWidth,
  // Local patch (transcript-row-memo).
  theme,
}: {
  copy: TuiCopy;
  message: Message;
  terminalWidth: number;
  theme: TuiThemeTokens;
}): React.ReactElement {
  const timeline = message.timeline;
  if (!timeline || timeline.type !== "context_compaction") {
    return h("box", null);
  }
  const compactCopy = copy.transcript.compact;
  const label =
    timeline.status === "started"
      ? compactCopy.started
      : timeline.status === "retrying"
        ? compactCopy.retrying({
            attempt: timeline.attempt ?? 0,
            maxAttempts: timeline.maxAttempts ?? 0,
          })
        : timeline.status === "skipped"
          ? compactCopy.skipped
          : timeline.status === "failed"
            ? compactCopy.failed
            : timeline.status === "interrupted"
              ? compactCopy.interrupted
              : compactCopy.completed;
  const retry =
    timeline.status === "failed" || timeline.status === "interrupted"
      ? compactCopy.retry(timeline.command ?? "/compact")
      : undefined;
  const center = retry ? ` ${label} | ${retry} ` : ` ${label} `;
  const sideWidth = Math.max(4, Math.floor((terminalWidth - center.length - 6) / 2));
  const line = "-".repeat(sideWidth);
  const color =
    timeline.status === "failed"
      ? theme.warning
      : timeline.status === "started"
        ? theme.accent
        : timeline.status === "retrying"
          ? theme.accent
          : theme.textMuted;

  return h(
    "box",
    {
      style: {
        backgroundColor: theme.background,
        flexDirection: "column",
        marginBottom: 1,
        minHeight: 1,
        paddingLeft: 1,
        paddingRight: 1,
        width: "100%",
      },
    },
    h(
      "text",
      {
        key: "compact-timeline",
        style: { fg: color },
      },
      `${line}${center}${line}`,
    ),
  );
}
