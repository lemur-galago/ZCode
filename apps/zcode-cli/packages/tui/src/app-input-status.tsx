import type { TuiCopy } from "@zcode/i18n";
import React from "react";
import type { ContextUsage } from "./app-model.js";
import { DEFAULT_TUI_COPY } from "./app-locale.js";
import { palette } from "./app-model.js";
import { modelDisplayParts, UNKNOWN_MODEL_FIELD } from "./app-model-ref.js";
import { spinnerFrame, useSpinnerFrame } from "./app-motion.js";
import type {
  AccountQuotaLevel,
  AccountQuotaPart,
  AccountQuotaUsage,
} from "./app-account-quota.js";
import {
  type ProcessMemoryLevel,
  type ProcessMemoryUsage,
} from "./app-process-memory.js";
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
// Local patch (status-compact-button): clickable compact trigger glyph, the
// last segment of the row - right after the context badge (user asked for it
// at the far right). The emoji renders ~1.7x taller than text glyphs and
// takes 2 terminal cells; displayWidth() undercounts astral emoji, so the
// budget uses the explicit width below. The glyph sits one cell after the
// badge - the room its trailing space took before the move - so the row keeps
// its width; after any other segment the usual gap separates it.
const STATUS_COMPACT_GLYPH = "🔄";
const STATUS_COMPACT_GLYPH_WIDTH = 2;
const STATUS_COMPACT_BADGE_GAP = " ";
// Local patch (process-memory-indicator): the session's memory usage segment
// ("ram <working set> · commit <commit size>") and the transient notice a click
// on it shows in the left part of the row. The notice owns the row while it is
// shown: the model, effort and memory segments are hidden and the context
// badge with the compact glyph give way when the terminal is narrow.
const STATUS_MEMORY_WORKING_SET_PREFIX = "ram ";
const STATUS_MEMORY_COMMIT_PREFIX = "commit ";
const STATUS_NOTICE_COMMAND_GAP = " ";
// Local patch (account-quota-indicator): the account quota segment of the right
// group, one text node per pool ("week 74%", "5h 10%") so each has its own
// color. A notice is clauses joined by the same separator: one that does not
// fit loses whole clauses from the end before any is cut.
const STATUS_QUOTA_SEPARATOR = " · ";
export const STATUS_NOTICE_CLAUSE_SEPARATOR = " · ";
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

// Local patch (process-memory-indicator): notice shown for a while in the
// status row; `command` is the part the user may want to select and copy.
export type StatusNotice = {
  command?: string;
  text?: string;
};

type InputActiveStatusOptions = {
  contentWidth?: number;
  contextUsage?: ContextUsage;
  model?: string;
  // Local patch (process-memory-indicator).
  notice?: StatusNotice;
  processMemory?: ProcessMemoryUsage;
  thoughtLevel?: string;
  // Local patch (account-quota-indicator).
  accountQuota?: AccountQuotaUsage;
  onStatusModelMouseDown?: StatusMouseHandler;
  onStatusEffortMouseDown?: StatusMouseHandler;
  onStatusCompactMouseDown?: StatusMouseHandler;
  onStatusMemoryMouseDown?: StatusMouseHandler;
  onStatusQuotaMouseDown?: StatusMouseHandler;
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
  // Local patch (process-memory-indicator).
  notice,
  processMemory,
  model,
  thoughtLevel,
  accountQuota,
  onStatusModelMouseDown,
  onStatusEffortMouseDown,
  onStatusCompactMouseDown,
  onStatusMemoryMouseDown,
  onStatusQuotaMouseDown,
}: {
  active: boolean;
  contentWidth?: number;
  contextUsage?: ContextUsage;
  copy?: TuiCopy;
  frameMs?: number;
  notice?: StatusNotice;
  processMemory?: ProcessMemoryUsage;
  model?: string;
  thoughtLevel?: string;
  // Local patch (account-quota-indicator).
  accountQuota?: AccountQuotaUsage;
  onStatusModelMouseDown?: StatusMouseHandler;
  onStatusEffortMouseDown?: StatusMouseHandler;
  onStatusCompactMouseDown?: StatusMouseHandler;
  onStatusMemoryMouseDown?: StatusMouseHandler;
  onStatusQuotaMouseDown?: StatusMouseHandler;
}): React.ReactElement {
  if (frameMs !== undefined || !active) {
    return inputActiveStatusRow(copy, active ? spinnerFrame(frameMs ?? 0) : undefined, {
      contentWidth,
      contextUsage,
      notice,
      processMemory,
      model,
      thoughtLevel,
      accountQuota,
      onStatusModelMouseDown,
      onStatusEffortMouseDown,
      onStatusCompactMouseDown,
      onStatusMemoryMouseDown,
      onStatusQuotaMouseDown,
    });
  }
  return h(InputActiveStatusContent, {
    contentWidth,
    contextUsage,
    copy,
    notice,
    processMemory,
    model,
    thoughtLevel,
    accountQuota,
    onStatusModelMouseDown,
    onStatusEffortMouseDown,
    onStatusCompactMouseDown,
    onStatusMemoryMouseDown,
    onStatusQuotaMouseDown,
  });
}

function InputActiveStatusContent({
  contentWidth,
  contextUsage,
  copy,
  notice,
  processMemory,
  model,
  thoughtLevel,
  accountQuota,
  onStatusModelMouseDown,
  onStatusEffortMouseDown,
  onStatusCompactMouseDown,
  onStatusMemoryMouseDown,
  onStatusQuotaMouseDown,
}: {
  contentWidth?: number;
  contextUsage?: ContextUsage;
  copy: TuiCopy;
  notice?: StatusNotice;
  processMemory?: ProcessMemoryUsage;
  model?: string;
  thoughtLevel?: string;
  // Local patch (account-quota-indicator).
  accountQuota?: AccountQuotaUsage;
  onStatusModelMouseDown?: StatusMouseHandler;
  onStatusEffortMouseDown?: StatusMouseHandler;
  onStatusCompactMouseDown?: StatusMouseHandler;
  onStatusMemoryMouseDown?: StatusMouseHandler;
  onStatusQuotaMouseDown?: StatusMouseHandler;
}): React.ReactElement {
  return inputActiveStatusRow(copy, useSpinnerFrame(true), {
    contentWidth,
    contextUsage,
    notice,
    processMemory,
    model,
    thoughtLevel,
    accountQuota,
    onStatusModelMouseDown,
    onStatusEffortMouseDown,
    onStatusCompactMouseDown,
    onStatusMemoryMouseDown,
    onStatusQuotaMouseDown,
  });
}

export function InputComposerStatus({
  contentWidth,
  model,
  thoughtLevel,
  // Local patch (adddir-command): folder badge props — "+" prefills /adddir,
  // the folder name lists the additional directories.
  additionalDirectoryCount = 0,
  onStatusAddDirMouseDown,
  onStatusDirMouseDown,
  workingDirectory,
}: {
  contentWidth?: number;
  model: string;
  thoughtLevel: string;
  additionalDirectoryCount?: number;
  onStatusAddDirMouseDown?: StatusMouseHandler;
  onStatusDirMouseDown?: StatusMouseHandler;
  workingDirectory?: string;
}): React.ReactElement {
  return inputComposerStatusRow({
    additionalDirectoryCount,
    contentWidth,
    model,
    thoughtLevel,
    onStatusAddDirMouseDown,
    onStatusDirMouseDown,
    workingDirectory,
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
  // Local patch (model-effort-status-switcher): the right-aligned group pairs
  // "model · effort" with the context badge; each segment is a separate text
  // node with an onMouseDown handler (OpenTUI hit-tests renderables), so the
  // switcher needs no coordinate math.
  const parts = statusRightGroupParts(options);
  const maxWidth = activeStatusContextBadgeWidth({
    contentWidth: options.contentWidth,
    copy,
    frame,
  });
  // Local patch (process-memory-indicator): a notice owns the row while it is
  // shown — the model, effort and memory segments are hidden, and the context
  // badge with the compact glyph give way too when the terminal is narrow.
  // Local patch (account-quota-indicator): the quota segment gives way as well
  // (its notice repeats it).
  const noticeParts = options.notice ? fitStatusNotice(options.notice, maxWidth) : undefined;
  const hasNotice = statusNoticeWidth(noticeParts) > 0;
  const rightGroup = hasNotice
    ? fitStatusRightGroup(
        {
          ...parts,
          effort: undefined,
          memory: undefined,
          model: undefined,
          quota: undefined,
        },
        shiftStatusWidth(maxWidth, -(statusNoticeWidth(noticeParts) + displayWidth(STATUS_RIGHT_GROUP_GAP))),
      )
    : fitStatusRightGroup(parts, maxWidth);
  const hasRightGroup = Boolean(
    rightGroup &&
      (rightGroup.badge ||
        rightGroup.compact ||
        rightGroup.memory ||
        rightGroup.model ||
        rightGroup.effort ||
        rightGroup.quota?.length),
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
    hasRightGroup || hasNotice ? h("box", { style: { flexGrow: 1, minWidth: 1 } }) : null,
    // Local patch (process-memory-indicator): the notice text is plain text, so
    // the command in it can be selected with the mouse like any transcript text.
    noticeParts?.text
      ? h("text", { style: { fg: palette.muted, flexShrink: 0 } }, noticeParts.text)
      : null,
    noticeParts?.text && noticeParts.command
      ? h("text", { style: { fg: palette.muted } }, STATUS_NOTICE_COMMAND_GAP)
      : null,
    noticeParts?.command
      ? h("text", { style: { fg: palette.accent, flexShrink: 0 } }, noticeParts.command)
      : null,
    hasNotice && hasRightGroup
      ? h("text", { style: { fg: palette.muted, flexShrink: 0 } }, STATUS_RIGHT_GROUP_GAP)
      : null,
    // Local patch (process-memory-indicator): session memory segment, the
    // first item of the right group; clicking it shows the restart notice.
    rightGroup?.memory
      ? h(
          "text",
          {
            onMouseDown: (event: { preventDefault: () => void; stopPropagation: () => void }) =>
              triggerStatusMouseHandler(event, options.onStatusMemoryMouseDown),
            style: {
              fg: processMemoryColor(options.processMemory?.level),
              flexShrink: 0,
            },
          },
          rightGroup.memory,
        )
      : null,
    rightGroup?.memory &&
    (rightGroup.model || rightGroup.effort || rightGroup.badge || rightGroup.compact)
      ? h("text", { style: { fg: palette.muted, flexShrink: 0 } }, STATUS_RIGHT_GROUP_GAP)
      : null,
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
    // Local patch (account-quota-indicator): the account quota between the
    // model and the context badge, separated like the badge is, one text node
    // per pool with its own color; a click on a pool shows the details.
    (rightGroup?.badge || rightGroup?.quota?.length) &&
    (rightGroup.model || rightGroup.effort)
      ? h("text", { style: { fg: palette.muted, flexShrink: 0 } }, STATUS_RIGHT_GROUP_GAP)
      : null,
    ...(rightGroup?.quota ? renderStatusQuota(rightGroup.quota, options.onStatusQuotaMouseDown) : []),
    rightGroup?.quota?.length && (rightGroup.badge || rightGroup.compact)
      ? h("text", { style: { fg: palette.muted, flexShrink: 0 } }, STATUS_RIGHT_GROUP_GAP)
      : null,
    rightGroup?.badge
      ? h("text", { style: { fg: palette.muted, flexShrink: 0 } }, rightGroup.badge)
      : null,
    // Local patch (status-compact-button): clickable compact glyph, the last
    // segment of the row, right after the context badge; a compact emoji
    // target (2 cells) for the same /compact command the composer submits —
    // the badge itself stays a plain indicator.
    rightGroup?.compact &&
    (rightGroup.badge || rightGroup.quota?.length || rightGroup.model || rightGroup.effort)
      ? h(
          "text",
          { style: { fg: palette.muted, flexShrink: 0 } },
          rightGroup.badge ? STATUS_COMPACT_BADGE_GAP : STATUS_RIGHT_GROUP_GAP,
        )
      : null,
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
  );
}

export function inputComposerStatusRow({
  contentWidth,
  model,
  thoughtLevel,
  additionalDirectoryCount = 0,
  onStatusAddDirMouseDown,
  onStatusDirMouseDown,
  workingDirectory,
}: {
  contentWidth?: number;
  model: string;
  thoughtLevel: string;
  additionalDirectoryCount?: number;
  onStatusAddDirMouseDown?: StatusMouseHandler;
  onStatusDirMouseDown?: StatusMouseHandler;
  workingDirectory?: string;
}): React.ReactElement {
  const metadataWidth = composerStatusMetadataWidth(contentWidth);
  // Local patch (adddir-command): the folder badge leads the row ("+ name
  // (+n)"); its width is subtracted from the model metadata budget so the
  // existing fit logic keeps fitting the rest of the row.
  const folder = fitComposerFolderBadge(
    workingDirectoryBadgeLabel(workingDirectory),
    additionalDirectoryCount,
    metadataWidth,
  );
  const folderWidth = folder ? composerFolderBadgeWidth(folder) : 0;
  const parts = inputComposerStatusParts(
    model,
    thoughtLevel,
    Math.max(1, metadataWidth - folderWidth),
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
    folder
      ? h(
          "box",
          { style: { flexDirection: "row", flexShrink: 0 } },
          h(
            "text",
            {
              onMouseDown: (event: { preventDefault: () => void; stopPropagation: () => void }) =>
                triggerStatusMouseHandler(event, onStatusAddDirMouseDown),
              style: { fg: palette.accent, flexShrink: 0, width: COMPOSER_FOLDER_ADD_GLYPH_WIDTH },
            },
            COMPOSER_FOLDER_ADD_GLYPH,
          ),
          h(
            "text",
            {
              onMouseDown: (event: { preventDefault: () => void; stopPropagation: () => void }) =>
                triggerStatusMouseHandler(event, onStatusDirMouseDown),
              style: { fg: palette.text, flexShrink: 0 },
            },
            folder.label,
          ),
          folder.count
            ? h("text", { style: { fg: palette.accent, flexShrink: 0 } }, ` ${folder.count}`)
            : null,
          h("text", { style: { fg: palette.muted, flexShrink: 0 } }, "  "),
        )
      : null,
    h(
      "box",
      { style: { flexDirection: "row", flexShrink: 1, minWidth: 1 } },
      h("text", { style: { fg: palette.text, flexShrink: 1 } }, parts.model),
      h("text", { style: { fg: palette.muted } }, ` ${parts.provider} | `),
      h("text", { style: { fg: palette.warning, flexShrink: 0 } }, parts.thought),
    ),
  );
}

// Local patch (adddir-command): folder badge helpers — the last path segment
// of the working directory, with an additional-directory count when present.
export function workingDirectoryBadgeLabel(
  workingDirectory: string | undefined,
): string | undefined {
  const trimmed = (workingDirectory ?? "").trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.replace(/[\\/]+$/u, "");
  const segments = normalized.split(/[\\/]/u).filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1];
  return last && last.length > 0 ? last : normalized;
}

type ComposerFolderBadgeParts = {
  label: string;
  count: string | undefined;
};

// Local patch (adddir-command, resized 2026-11-22 per «кнопку надо сделать
// заметнее»): the add-directory trigger is an EMOJI glyph ("➕ " heavy plus),
// same treatment as the compact button — it renders ~1.7x taller than text
// glyphs and takes 2 terminal cells; displayWidth() undercounts astral emoji,
// so the budget uses the explicit constant (2 cells + 1 trailing space).
const COMPOSER_FOLDER_ADD_GLYPH = "➕ ";
const COMPOSER_FOLDER_ADD_GLYPH_WIDTH = 3;
const COMPOSER_FOLDER_BADGE_FIXED_WIDTH =
  COMPOSER_FOLDER_ADD_GLYPH_WIDTH + 2; // glyph incl. hit-area space + trailing two-space gap

function composerFolderBadgeWidth(parts: ComposerFolderBadgeParts): number {
  return (
    COMPOSER_FOLDER_BADGE_FIXED_WIDTH +
    displayWidth(parts.label) +
    (parts.count ? 1 + displayWidth(parts.count) : 0)
  );
}

function fitComposerFolderBadge(
  label: string | undefined,
  additionalDirectoryCount: number,
  maxWidth: number,
): ComposerFolderBadgeParts | undefined {
  if (!label) return undefined;
  const count = additionalDirectoryCount > 0 ? `(+${additionalDirectoryCount})` : undefined;
  const full: ComposerFolderBadgeParts = { label, count };
  if (composerFolderBadgeWidth(full) <= maxWidth) return full;
  if (count) {
    const withoutCount: ComposerFolderBadgeParts = { label, count: undefined };
    if (composerFolderBadgeWidth(withoutCount) <= maxWidth) return withoutCount;
  }
  const labelBudget = Math.max(1, maxWidth - COMPOSER_FOLDER_BADGE_FIXED_WIDTH);
  const truncated = truncateDisplay(label, labelBudget);
  return truncated.length > 0 ? { label: truncated, count: undefined } : undefined;
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
  memory: string | undefined;
  model: string | undefined;
  // Local patch (account-quota-indicator).
  quota: AccountQuotaPart[] | undefined;
};

// Local patch (account-quota-indicator): the color follows how full the pool is.
function accountQuotaColor(level: AccountQuotaLevel): string {
  if (level === "danger") return palette.danger;
  if (level === "warning") return palette.warning;
  return palette.muted;
}

function statusQuotaWidth(parts: AccountQuotaPart[]): number {
  return parts.reduce(
    (width, part, index) =>
      width + displayWidth(part.label) + (index > 0 ? displayWidth(STATUS_QUOTA_SEPARATOR) : 0),
    0,
  );
}

function statusQuotaRank(part: AccountQuotaPart): number {
  return part.level === "danger" ? 2 : part.level === "warning" ? 1 : 0;
}

// The segment keeps its place longer than the model and the effort. When it no
// longer fits whole, only the fuller pool stays (the one worth watching).
function fitStatusQuota(
  parts: AccountQuotaPart[] | undefined,
  maxWidth: number,
): AccountQuotaPart[] | undefined {
  if (!parts || parts.length === 0) return undefined;
  if (statusQuotaWidth(parts) <= maxWidth) return parts;
  const fullest = parts.reduce((best, part) => (statusQuotaRank(part) > statusQuotaRank(best) ? part : best));
  return displayWidth(fullest.label) <= maxWidth ? [fullest] : undefined;
}

function renderStatusQuota(
  parts: AccountQuotaPart[],
  onMouseDown: StatusMouseHandler | undefined,
): React.ReactElement[] {
  return parts.flatMap((part, index) => {
    const nodes: React.ReactElement[] = [];
    if (index > 0) {
      nodes.push(h("text", { style: { fg: palette.muted, flexShrink: 0 } }, STATUS_QUOTA_SEPARATOR));
    }
    nodes.push(
      h(
        "text",
        {
          onMouseDown: (event: { preventDefault: () => void; stopPropagation: () => void }) =>
            triggerStatusMouseHandler(event, onMouseDown),
          style: { fg: accountQuotaColor(part.level), flexShrink: 0 },
        },
        part.label,
      ),
    );
    return nodes;
  });
}

// Local patch (process-memory-indicator): "ram <working set> · commit <commit
// size>"; the half that could not be read is omitted.
export function processMemoryStatusLabel(usage: ProcessMemoryUsage): string | undefined {
  const parts = [
    usage.workingSetLabel ? `${STATUS_MEMORY_WORKING_SET_PREFIX}${usage.workingSetLabel}` : undefined,
    usage.commitLabel ? `${STATUS_MEMORY_COMMIT_PREFIX}${usage.commitLabel}` : undefined,
  ].filter((part) => part !== undefined);
  return parts.length > 0 ? parts.join(STATUS_MODEL_EFFORT_SEPARATOR) : undefined;
}

// The color follows the commit size: the working set stays small even when the
// commit charge of a session grows into gigabytes.
function processMemoryColor(level: ProcessMemoryLevel | undefined): string {
  if (level === "danger") return palette.danger;
  if (level === "warning") return palette.warning;
  return palette.muted;
}

function statusRightGroupParts(options: InputActiveStatusOptions): StatusRightGroupParts {
  const modelParts = modelDisplayParts((options.model ?? "").trim());
  const model = modelParts.model;
  return {
    badge: inputContextUsageBadge(options.contextUsage),
    // Local patch (status-compact-button): the compact glyph only renders when
    // a click handler is wired, so plain callers keep the old badge-only row.
    compact: options.onStatusCompactMouseDown ? STATUS_COMPACT_GLYPH : undefined,
    effort: (options.thoughtLevel ?? "").trim() || undefined,
    // Local patch (process-memory-indicator).
    memory: options.processMemory ? processMemoryStatusLabel(options.processMemory) : undefined,
    // Local patch (account-quota-indicator).
    quota: options.accountQuota && options.accountQuota.parts.length > 0 ? options.accountQuota.parts : undefined,
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

  // Local patch (status-compact-button): the glyph closes the row, so the
  // gap it keeps after the badge is part of its width.
  let compact = parts.compact;
  const compactWidth = STATUS_COMPACT_GLYPH_WIDTH + (badge ? displayWidth(STATUS_COMPACT_BADGE_GAP) : 0);
  if (compact && compactWidth > remaining) compact = undefined;
  if (compact) remaining -= compactWidth;

  // Local patch (account-quota-indicator): the quota yields to the context
  // badge and to the compact glyph only - the two right-most segments; the
  // model and the effort, which precede it in the row, get what is left.
  const quotaLeads = Boolean(badge || compact);
  const quota = fitStatusQuota(parts.quota, quotaLeads ? remaining - gapWidth : remaining);
  if (quota) remaining -= statusQuotaWidth(quota) + (quotaLeads ? gapWidth : 0);

  if (parts.model || parts.effort) {
    if (badge || compact || quota) remaining -= gapWidth;
    if (remaining < STATUS_MIN_CONTEXT_WIDTH) {
      return withStatusMemory({ badge, compact, quota }, parts.memory, 0);
    }

    const modelWidth = parts.model ? displayWidth(parts.model) : 0;
    const effortWidth = parts.effort ? displayWidth(parts.effort) : 0;
    const separatorCount = parts.model && parts.effort ? 1 : 0;
    const groupWidth = modelWidth + separatorCount * separatorWidth + effortWidth;
    if (groupWidth <= remaining) {
      return withStatusMemory(
        { badge, compact, model: parts.model, effort: parts.effort, quota },
        parts.memory,
        remaining - groupWidth,
      );
    }

    // Narrow terminal: drop the effort segment first, then truncate the model.
    if (parts.model) {
      const model = truncateDisplay(parts.model, remaining);
      const fitted = displayWidth(model) > 0 ? model : undefined;
      return withStatusMemory(
        { badge, compact, model: fitted, quota },
        parts.memory,
        remaining - displayWidth(fitted ?? ""),
      );
    }
    if (parts.effort) {
      const effort = truncateDisplay(parts.effort, remaining);
      const fitted = displayWidth(effort) > 0 ? effort : undefined;
      return withStatusMemory(
        { badge, compact, effort: fitted, quota },
        parts.memory,
        remaining - displayWidth(fitted ?? ""),
      );
    }
  }
  return withStatusMemory({ badge, compact, quota }, parts.memory, remaining);
}

// Local patch (process-memory-indicator): the memory segment has the lowest
// priority of the group — it is shown only when it fits next to everything
// that survived.
function withStatusMemory<T extends Partial<StatusRightGroupParts>>(
  group: T,
  memory: string | undefined,
  remaining: number,
): T {
  const gap = group.badge || group.compact || group.effort || group.model ? displayWidth(STATUS_RIGHT_GROUP_GAP) : 0;
  return memory && displayWidth(memory) + gap <= remaining ? { ...group, memory } : group;
}

type StatusNoticeParts = {
  command: string | undefined;
  text: string | undefined;
};

function fitStatusNotice(notice: StatusNotice, maxWidth?: number): StatusNoticeParts | undefined {
  if (!notice.text && !notice.command) return undefined;
  if (maxWidth === undefined || !Number.isFinite(maxWidth)) {
    return { command: notice.command, text: notice.text };
  }
  let remaining = Math.floor(maxWidth);
  // The command is the part worth copying, so the text gives way first.
  let command = notice.command;
  if (command) {
    if (displayWidth(command) > remaining) command = truncateDisplay(command, remaining);
    remaining -= displayWidth(command);
  }
  let text = notice.text;
  if (text) {
    if (command) remaining -= displayWidth(STATUS_NOTICE_COMMAND_GAP);
    text = remaining > 0 ? fitStatusNoticeText(text, remaining) : "";
  }
  return { command: command || undefined, text: text || undefined };
}

// Local patch (account-quota-indicator): a notice of clauses ("week 74% ... ·
// 5h 10% ... · Max, renews 07.12") loses whole clauses from the end while it
// does not fit, so the line never ends in a cut number; a single clause is
// shortened like any text.
function fitStatusNoticeText(text: string, maxWidth: number): string {
  const clauses = text.split(STATUS_NOTICE_CLAUSE_SEPARATOR);
  while (
    clauses.length > 1 &&
    displayWidth(clauses.join(STATUS_NOTICE_CLAUSE_SEPARATOR)) > maxWidth
  ) {
    clauses.pop();
  }
  return truncateDisplay(clauses.join(STATUS_NOTICE_CLAUSE_SEPARATOR), maxWidth);
}

function statusNoticeWidth(parts: StatusNoticeParts | undefined): number {
  if (!parts) return 0;
  const both = parts.text && parts.command ? displayWidth(STATUS_NOTICE_COMMAND_GAP) : 0;
  return displayWidth(parts.text ?? "") + displayWidth(parts.command ?? "") + both;
}

function shiftStatusWidth(maxWidth: number | undefined, delta: number): number | undefined {
  if (maxWidth === undefined || !Number.isFinite(maxWidth)) return undefined;
  return maxWidth + delta;
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
