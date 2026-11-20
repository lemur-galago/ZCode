import type { TuiCopy } from "@zcode/i18n";
import React from "react";
import type { ContextUsage } from "./app-model.js";
import { DEFAULT_TUI_COPY } from "./app-locale.js";
import { palette } from "./app-model.js";
import { modelDisplayParts, UNKNOWN_MODEL_FIELD } from "./app-model-ref.js";
import { spinnerFrame, useSpinnerFrame } from "./app-motion.js";
import { displayWidth, truncateDisplay } from "./app-terminal-width.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

const ACTIVE_STATUS_HEIGHT = 1;
const ACTIVE_STATUS_HORIZONTAL_PADDING_WIDTH = 1;
const ACTIVE_STATUS_CONTEXT_SPACER_WIDTH = 1;
// Local patch (model-effort-status-switcher): separators inside the status
// row's right-aligned group "model · effort  context badge".
const STATUS_MODEL_EFFORT_SEPARATOR = " · ";
const STATUS_RIGHT_GROUP_GAP = "  ";
// Local patch (status-compact-button): clickable compact trigger glyph. The
// emoji renders ~1.7x taller than text glyphs (user asked for a bigger icon)
// and takes 2 terminal cells; displayWidth() undercounts astral emoji, so the
// budget uses the explicit width below (2 cells + 1 trailing space = hit area).
const STATUS_COMPACT_GLYPH = "🔄 ";
const STATUS_COMPACT_GLYPH_WIDTH = 3;
const COMPOSER_STATUS_HEIGHT = 1;
const COMPOSER_STATUS_HORIZONTAL_PADDING_WIDTH = 0;
const COMPOSER_STATUS_MIN_METADATA_WIDTH = 8;
const STATUS_MIN_CONTEXT_WIDTH = 4;
const COMPOSER_STATUS_FALLBACK_WIDTH = 80;
const COMPOSER_STATUS_MIN_CONTENT_WIDTH = 8;
const TOKEN_COUNT_KILO = 1_000;
const TOKEN_COUNT_MEGA = TOKEN_COUNT_KILO * TOKEN_COUNT_KILO;
const TOKEN_COUNT_DECIMAL_PLACES = 1;

type InputComposerStatusParts = {
  model: string;
  provider: string;
  thought: string;
};

// Local patch (model-effort-status-switcher): the status row shows the current
// model name and thought level next to the context badge; the segments accept
// mouse-down handlers so a click cycles the value (wired in app.tsx by
// submitting /model and /effort commands).
type StatusMouseHandler = (event: { preventDefault: () => void; stopPropagation: () => void }) => void;

type InputActiveStatusOptions = {
  contentWidth?: number;
  contextUsage?: ContextUsage;
  model?: string;
  thoughtLevel?: string;
  onStatusModelMouseDown?: StatusMouseHandler;
  onStatusEffortMouseDown?: StatusMouseHandler;
  onStatusCompactMouseDown?: StatusMouseHandler;
};

function triggerStatusMouseHandler(
  event: { preventDefault: () => void; stopPropagation: () => void },
  handler: StatusMouseHandler | undefined,
): void {
  event.preventDefault();
  event.stopPropagation();
  handler?.(event);
}

export function InputActiveStatus({
  active,
  contentWidth,
  contextUsage,
  copy = DEFAULT_TUI_COPY,
  frameMs,
  model,
  thoughtLevel,
  onStatusModelMouseDown,
  onStatusEffortMouseDown,
  onStatusCompactMouseDown,
}: {
  active: boolean;
  contentWidth?: number;
  contextUsage?: ContextUsage;
  copy?: TuiCopy;
  frameMs?: number;
  model?: string;
  thoughtLevel?: string;
  onStatusModelMouseDown?: StatusMouseHandler;
  onStatusEffortMouseDown?: StatusMouseHandler;
  onStatusCompactMouseDown?: StatusMouseHandler;
}): React.ReactElement {
  if (frameMs !== undefined || !active) {
    return inputActiveStatusRow(copy, active ? spinnerFrame(frameMs ?? 0) : undefined, {
      contentWidth,
      contextUsage,
      model,
      thoughtLevel,
      onStatusModelMouseDown,
      onStatusEffortMouseDown,
      onStatusCompactMouseDown,
    });
  }
  return h(InputActiveStatusContent, {
    contentWidth,
    contextUsage,
    copy,
    model,
    thoughtLevel,
    onStatusModelMouseDown,
    onStatusEffortMouseDown,
    onStatusCompactMouseDown,
  });
}

function InputActiveStatusContent({
  contentWidth,
  contextUsage,
  copy,
  model,
  thoughtLevel,
  onStatusModelMouseDown,
  onStatusEffortMouseDown,
  onStatusCompactMouseDown,
}: {
  contentWidth?: number;
  contextUsage?: ContextUsage;
  copy: TuiCopy;
  model?: string;
  thoughtLevel?: string;
  onStatusModelMouseDown?: StatusMouseHandler;
  onStatusEffortMouseDown?: StatusMouseHandler;
  onStatusCompactMouseDown?: StatusMouseHandler;
}): React.ReactElement {
  return inputActiveStatusRow(copy, useSpinnerFrame(true), {
    contentWidth,
    contextUsage,
    model,
    thoughtLevel,
    onStatusModelMouseDown,
    onStatusEffortMouseDown,
    onStatusCompactMouseDown,
  });
}

export function InputComposerStatus({
  contentWidth,
  model,
  thoughtLevel,
}: {
  contentWidth?: number;
  model: string;
  thoughtLevel: string;
}): React.ReactElement {
  return inputComposerStatusRow({
    contentWidth,
    model,
    thoughtLevel,
  });
}

export function inputActiveStatusRow(
  copy: TuiCopy,
  frame?: string,
  options: InputActiveStatusOptions = {},
): React.ReactElement {
  // Local patch (model-effort-status-switcher): the right-aligned group pairs
  // "model · effort" with the context badge; each segment is a separate text
  // node with an onMouseDown handler (OpenTUI hit-tests renderables), so the
  // switcher needs no coordinate math.
  const rightGroup = fitStatusRightGroup(
    statusRightGroupParts(options),
    activeStatusContextBadgeWidth({
      contentWidth: options.contentWidth,
      copy,
      frame,
    }),
  );
  const hasRightGroup = Boolean(
    rightGroup && (rightGroup.badge || rightGroup.compact || rightGroup.model || rightGroup.effort),
  );
  return h(
    "box",
    {
      style: {
        flexDirection: "row",
        height: ACTIVE_STATUS_HEIGHT,
        paddingLeft: 1,
        width: "100%",
      },
    },
    frame
      ? h(
          "box",
          { style: { flexDirection: "row", flexShrink: 0 } },
          h(
            "text",
            { style: { fg: palette.accent, flexShrink: 0, width: displayWidth(frame) } },
            frame,
          ),
          h("text", { style: { fg: palette.muted } }, " "),
          h("text", { style: { fg: palette.muted } }, copy.input.activeStatusHint),
        )
      : null,
    hasRightGroup ? h("box", { style: { flexGrow: 1, minWidth: 1 } }) : null,
    rightGroup?.model
      ? h(
          "text",
          {
            onMouseDown: (event: { preventDefault: () => void; stopPropagation: () => void }) =>
              triggerStatusMouseHandler(event, options.onStatusModelMouseDown),
            style: { fg: palette.text, flexShrink: 0 },
          },
          rightGroup.model,
        )
      : null,
    rightGroup?.model && rightGroup.effort
      ? h("text", { style: { fg: palette.muted, flexShrink: 0 } }, STATUS_MODEL_EFFORT_SEPARATOR)
      : null,
    rightGroup?.effort
      ? h(
          "text",
          {
            onMouseDown: (event: { preventDefault: () => void; stopPropagation: () => void }) =>
              triggerStatusMouseHandler(event, options.onStatusEffortMouseDown),
            style: { fg: palette.warning, flexShrink: 0 },
          },
          rightGroup.effort,
        )
      : null,
    rightGroup?.badge && (rightGroup.model || rightGroup.effort)
      ? h("text", { style: { fg: palette.muted, flexShrink: 0 } }, STATUS_RIGHT_GROUP_GAP)
      : null,
    // Local patch (status-compact-button): clickable compact glyph right before
    // the context badge; a compact emoji target (2 cells + trailing space) for
    // the same /compact command the composer submits — the badge itself stays
    // a plain indicator.
    rightGroup?.compact
      ? h(
          "text",
          {
            onMouseDown: (event: { preventDefault: () => void; stopPropagation: () => void }) =>
              triggerStatusMouseHandler(event, options.onStatusCompactMouseDown),
            style: { fg: palette.accent, flexShrink: 0 },
          },
          STATUS_COMPACT_GLYPH,
        )
      : null,
    rightGroup?.badge
      ? h("text", { style: { fg: palette.muted, flexShrink: 0 } }, rightGroup.badge)
      : null,
  );
}

export function inputComposerStatusRow({
  contentWidth,
  model,
  thoughtLevel,
}: {
  contentWidth?: number;
  model: string;
  thoughtLevel: string;
}): React.ReactElement {
  const parts = inputComposerStatusParts(
    model,
    thoughtLevel,
    composerStatusMetadataWidth(contentWidth),
  );
  return h(
    "box",
    {
      style: {
        alignItems: "center",
        flexDirection: "row",
        flexShrink: 0,
        height: COMPOSER_STATUS_HEIGHT,
        width: "100%",
      },
    },
    h(
      "box",
      { style: { flexDirection: "row", flexShrink: 1, minWidth: 1 } },
      h("text", { style: { fg: palette.text, flexShrink: 1 } }, parts.model),
      h("text", { style: { fg: palette.muted } }, ` ${parts.provider} | `),
      h("text", { style: { fg: palette.warning, flexShrink: 0 } }, parts.thought),
    ),
  );
}

export function inputComposerStatusParts(
  modelSelection: string,
  thoughtLevel: string,
  maxWidth?: number,
): InputComposerStatusParts {
  const modelParts = modelDisplayParts(modelSelection);
  const thought = thoughtLevel.trim();
  return fitComposerStatusParts(
    {
      ...modelParts,
      thought: thought || "-",
    },
    maxWidth,
  );
}

export function inputContextUsageBadge(contextUsage?: ContextUsage): string | undefined {
  const used = contextUsage?.contextUsed;
  if (!validContextTokenCount(used)) return undefined;

  const usedLabel = formatCompactTokenCount(used);
  const window = contextUsage?.contextWindow;
  if (!validContextWindow(window)) return usedLabel;

  // Local patch (context-window-badge): show the resolved context window size
  // alongside usage, matching the desktop context meter ("used / total"); the
  // window value comes from the CDN-refreshed zcode-builtin model rules.
  return `${usedLabel} / ${formatCompactTokenCount(window)} (${formatComposerPercent(used / window)})`;
}

function composerStatusMetadataWidth(contentWidth?: number): number {
  const rowWidth = normalizeComposerStatusContentWidth(contentWidth);
  return Math.max(
    COMPOSER_STATUS_MIN_METADATA_WIDTH,
    rowWidth - COMPOSER_STATUS_HORIZONTAL_PADDING_WIDTH,
  );
}

function activeStatusContextBadgeWidth({
  contentWidth,
  copy,
  frame,
}: {
  contentWidth?: number;
  copy: TuiCopy;
  frame?: string;
}): number | undefined {
  const rowWidth = normalizeComposerStatusContentWidth(contentWidth);
  const activeHintWidth = frame
    ? displayWidth(frame) + 1 + displayWidth(copy.input.activeStatusHint)
    : 0;
  const activeSpacerWidth = activeHintWidth > 0 ? ACTIVE_STATUS_CONTEXT_SPACER_WIDTH : 0;
  const availableWidth =
    rowWidth - ACTIVE_STATUS_HORIZONTAL_PADDING_WIDTH - activeHintWidth - activeSpacerWidth;
  if (availableWidth < STATUS_MIN_CONTEXT_WIDTH) return undefined;
  return Math.floor(availableWidth);
}

type StatusRightGroupParts = {
  badge: string | undefined;
  compact: string | undefined;
  effort: string | undefined;
  model: string | undefined;
};

function statusRightGroupParts(options: InputActiveStatusOptions): StatusRightGroupParts {
  const modelParts = modelDisplayParts((options.model ?? "").trim());
  const model = modelParts.model;
  return {
    badge: inputContextUsageBadge(options.contextUsage),
    // Local patch (status-compact-button): the compact glyph only renders when
    // a click handler is wired, so plain callers keep the old badge-only row.
    compact: options.onStatusCompactMouseDown ? STATUS_COMPACT_GLYPH : undefined,
    effort: (options.thoughtLevel ?? "").trim() || undefined,
    model:
      model && model !== UNKNOWN_MODEL_FIELD && model.toLowerCase() !== "unknown"
        ? model
        : undefined,
  };
}

function fitStatusRightGroup(
  parts: StatusRightGroupParts,
  maxWidth?: number,
): Partial<StatusRightGroupParts> {
  if (maxWidth === undefined || !Number.isFinite(maxWidth)) return parts;
  if (maxWidth < STATUS_MIN_CONTEXT_WIDTH) return {};

  const gapWidth = displayWidth(STATUS_RIGHT_GROUP_GAP);
  const separatorWidth = displayWidth(STATUS_MODEL_EFFORT_SEPARATOR);
  let remaining = Math.floor(maxWidth);

  let badge = parts.badge;
  if (badge) {
    if (displayWidth(badge) > remaining) badge = truncateDisplay(badge, remaining);
    remaining -= displayWidth(badge);
  }

  let compact = parts.compact;
  if (compact && STATUS_COMPACT_GLYPH_WIDTH > remaining) compact = undefined;
  if (compact) remaining -= STATUS_COMPACT_GLYPH_WIDTH;

  if (parts.model || parts.effort) {
    if (badge || compact) remaining -= gapWidth;
    if (remaining < STATUS_MIN_CONTEXT_WIDTH) {
      return { badge, compact };
    }

    const modelWidth = parts.model ? displayWidth(parts.model) : 0;
    const effortWidth = parts.effort ? displayWidth(parts.effort) : 0;
    const separatorCount = parts.model && parts.effort ? 1 : 0;
    if (modelWidth + separatorCount * separatorWidth + effortWidth <= remaining) {
      return { badge, compact, model: parts.model, effort: parts.effort };
    }

    // Narrow terminal: drop the effort segment first, then truncate the model.
    if (parts.model) {
      const model = truncateDisplay(parts.model, remaining);
      return {
        badge,
        compact,
        model: displayWidth(model) > 0 ? model : undefined,
      };
    }
    if (parts.effort) {
      const effort = truncateDisplay(parts.effort, remaining);
      return {
        badge,
        compact,
        effort: displayWidth(effort) > 0 ? effort : undefined,
      };
    }
  }
  return { badge, compact };
}

function fitComposerStatusParts(
  parts: InputComposerStatusParts,
  maxWidth?: number,
): InputComposerStatusParts {
  if (maxWidth === undefined || !Number.isFinite(maxWidth)) return parts;
  const width = Math.max(1, Math.floor(maxWidth));
  const separatorWidth = displayWidth(" | ");
  const modelProviderGapWidth = 1;
  const thoughtWidth = displayWidth(parts.thought);
  const modelProviderWidth =
    displayWidth(parts.model) + modelProviderGapWidth + displayWidth(parts.provider);

  if (modelProviderWidth + separatorWidth + thoughtWidth <= width) return parts;

  const modelProviderBudget = width - separatorWidth - thoughtWidth;
  if (modelProviderBudget <= 0) {
    return {
      model: "",
      provider: "",
      thought: truncateDisplay(parts.thought, width),
    };
  }

  if (modelProviderBudget <= modelProviderGapWidth) {
    return {
      ...parts,
      model: truncateDisplay(parts.model, modelProviderBudget),
      provider: "",
    };
  }

  const providerBudget = Math.min(
    displayWidth(parts.provider),
    Math.max(1, Math.floor(modelProviderBudget * 0.4)),
  );
  const modelBudget = Math.max(1, modelProviderBudget - providerBudget - modelProviderGapWidth);

  return {
    ...parts,
    model: truncateDisplay(parts.model, modelBudget),
    provider: truncateDisplay(parts.provider, providerBudget),
  };
}

function normalizeComposerStatusContentWidth(contentWidth?: number): number {
  if (contentWidth === undefined || !Number.isFinite(contentWidth)) {
    return COMPOSER_STATUS_FALLBACK_WIDTH;
  }
  return Math.max(COMPOSER_STATUS_MIN_CONTENT_WIDTH, Math.floor(contentWidth));
}

function formatCompactTokenCount(value: number): string {
  if (value < TOKEN_COUNT_KILO) return String(Math.round(value));
  if (value < TOKEN_COUNT_MEGA) return `${formatCompactDecimal(value / TOKEN_COUNT_KILO)}K`;
  return `${formatCompactDecimal(value / TOKEN_COUNT_MEGA)}M`;
}

function formatCompactDecimal(value: number): string {
  return value.toFixed(TOKEN_COUNT_DECIMAL_PLACES).replace(/\.0$/u, "");
}

function formatComposerPercent(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return `${Math.round(value * 100)}%`;
}

function validContextTokenCount(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

function validContextWindow(value: number | undefined): value is number {
  return validContextTokenCount(value) && value > 0;
}
