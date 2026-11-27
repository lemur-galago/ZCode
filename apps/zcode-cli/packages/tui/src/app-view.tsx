import type { ModelUsageSummary, TodoItem, TurnId } from "@zcode/contracts";
import React from "react";
import type { AccountQuotaUsage } from "./app-account-quota.js";
import { ApprovalArea } from "./app-approval-panel.js";
import {
  actionPanelContentWidthForTerminal,
  AppShell,
  LoginRequiredPanel,
  SlashSuggestionPanel,
} from "./app-components.js";
import type { SelectionCopyOptions } from "./app-copy.js";
import { SelectionPanel } from "./app-selection-panel.js";
import { ContentPane } from "./app-transcript-components.js";
import { FileMentionPanel } from "./app-file-mention-panel.js";
import type { FileMentionState } from "./app-file-mentions.js";
import { EffortSuggestionPanel } from "./app-effort-suggestion-panel.js";
import { InputPane, type PromptInputEditor } from "./app-input-pane.js";
import { InputActiveStatus, type StatusNotice } from "./app-input-status.js";
import type { ProcessMemoryUsage } from "./app-process-memory.js";
import { QueuedInputPanel } from "./app-queued-inputs.js";
import { ModeSuggestionPanel } from "./app-mode-suggestion-panel.js";
import { ModelSuggestionPanel } from "./app-model-suggestion-panel.js";
import { useMcpSidebarStatus } from "./app-mcp-status.js";
import { Sidebar } from "./app-sidebar.js";
import { useSidebarFold } from "./app-sidebar-fold.js";
import {
  type SidebarLayout,
  type SidebarSectionId,
  type SidebarSectionExpansion,
} from "./app-sidebar-layout.js";
import type {
  ApprovalPrompt,
  CacheStats,
  ContextUsage,
  EffortCommandSelectionState,
  Message,
  ModifiedFileStat,
  ModeCommandSelectionState,
  ModelCommandSelectionState,
  NetworkRequest,
  QueuedInput,
  SelectionState,
  SlashSelectionState,
} from "./app-model.js";
import type { TuiEffortOption, TuiModeOption, TuiOptions } from "./types.js";
import type { TuiWorkflowCard } from "./app-workflow-mirror.js";
import type { SubagentItem, SubagentsController } from "./app-subagents.js";
import { SubagentView } from "./app-subagent-view.js";
import { activeTuiTheme, type TuiThemeTokens } from "./theme/index.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

// Local patch (panel-memo): the same objects for as long as the view lives. A
// fresh empty list or a fresh function on every render of the view is a
// changed prop for a memoized component, and drew it for nothing.
const NO_QUEUED_INPUTS: QueuedInput[] = [];
const noDraftChange = () => {};
const noSubmit = () => {};

export function AppView(props: {
  subagents?: SubagentsController;
  toggleSidebar?: () => boolean;
  activeTurnId?: TurnId;
  approvalQueue: ApprovalPrompt[];
  busy: boolean;
  cacheStats?: CacheStats;
  contextUsage: ContextUsage;
  copy: ReturnType<typeof import("@zcode/i18n").getZCodeCopy>["tui"];
  copyCurrentSelection: (options?: SelectionCopyOptions) => boolean;
  draft: string;
  editorRef: React.MutableRefObject<PromptInputEditor | null>;
  effortOptions: readonly TuiEffortOption[];
  effortSelection?: EffortCommandSelectionState;
  fileMention?: FileMentionState;
  inputCursorToEndVersion: number;
  lastError?: string;
  lastEvent: string;
  loginRequired: boolean;
  liveModelText: string;
  mode: string;
  modeOptions: readonly TuiModeOption[];
  modeSelection?: ModeCommandSelectionState;
  model: string;
  modifiedFiles: ModifiedFileStat[];
  // Local patch (model-effort-status-switcher): click-to-cycle handlers for
  // the model/effort segments in the status row next to the context badge.
  onStatusModelClick?: () => void;
  onStatusEffortClick?: () => void;
  // Local patch (status-compact-button): click handler for the compact glyph.
  onStatusCompactClick?: () => void;
  // Local patch (process-memory-indicator): the session's memory usage, the
  // notice a click on it shows, and that click handler.
  processMemory?: ProcessMemoryUsage;
  statusNotice?: StatusNotice;
  onStatusMemoryClick?: () => void;
  // Local patch (account-quota-indicator): the account quota shown in the
  // status row and the handler a click on it wakes.
  accountQuota?: AccountQuotaUsage;
  onStatusQuotaClick?: () => void;
  // Local patch (adddir-command): click handlers for the composer folder
  // badge — "➕" opens the native folder picker, the folder name lists the directories.
  onStatusAddDirClick?: () => void;
  onStatusDirClick?: () => void;
  modelOptions: readonly NonNullable<TuiOptions["modelOptions"]>[number][];
  modelSelection?: ModelCommandSelectionState;
  messages: Message[];
  networkRequests: NetworkRequest[];
  options: TuiOptions;
  queuedInputs?: QueuedInput[];
  selection?: SelectionState;
  setDraftValue: (value: string) => void;
  sidebarLayout: SidebarLayout;
  sidebarSections: SidebarSectionExpansion;
  slashCommands: readonly NonNullable<TuiOptions["slashCommands"]>[number][];
  slashSelection?: SlashSelectionState;
  status: string;
  statusDetails: string[];
  submitValue: (value: string) => void;
  thoughtLevel: string;
  // Local patch (adddir-command): additional working directories shown as a
  // count in the composer folder badge.
  workingDirectories: readonly string[];
  todos: TodoItem[];
  toggleSidebarSection?: (section: SidebarSectionId) => boolean;
  traceId?: string;
  // Local patch (transcript-row-memo): the theme the view is drawn in, passed
  // down to the memoized parts; the active one unless given.
  theme?: TuiThemeTokens;
  terminalWidth: number;
  usage?: ModelUsageSummary;
  workflowCardsByToolCallId?: ReadonlyMap<string, TuiWorkflowCard>;
  expandedWorkflowRunIds?: ReadonlySet<string>;
}): React.ReactElement {
  const readOnly = Boolean(props.subagents?.selected);
  const theme = props.theme ?? activeTuiTheme();
  const handleShellMouseUp = React.useCallback(() => {
    // Local patch (persistent-selection): the text is copied on release as
    // before, but the highlight stays until it is copied again or dismissed.
    props.copyCurrentSelection({ keepSelection: true });
    if (!readOnly) props.editorRef.current?.focus();
  }, [props.copyCurrentSelection, props.editorRef, readOnly]);
  // Local patch (panel-memo): the handler of the sidebar is a prop of the
  // memoized sidebar, so it is the same function while its inputs are.
  const openSubagent = React.useCallback(
    (item: SubagentItem) => {
      props.subagents?.open(item);
      if (props.sidebarLayout.overlay) props.toggleSidebar?.();
    },
    [props.subagents, props.sidebarLayout.overlay, props.toggleSidebar],
  );
  const actionPanelContentWidth = actionPanelContentWidthForTerminal(
    props.terminalWidth,
    props.sidebarLayout.reservedWidth,
  );
  const mcpStatus = useMcpSidebarStatus(
    props.loginRequired ? undefined : props.options.listMcpServers,
  );
  const transcriptMessages = props.liveModelText
    ? [
        ...props.messages,
        {
          content: props.liveModelText,
          role: "agent" as const,
          streaming: true,
        },
      ]
    : props.messages;

  // 旧的测试入口和嵌入式调用不会传 queuedInputs；默认空队列，避免队列面板在无数据时打断焦点交互。
  // Local patch (panel-memo): the default is one list, see NO_QUEUED_INPUTS.
  const queuedInputs = props.queuedInputs ?? NO_QUEUED_INPUTS;
  const composerSelection = props.selection?.placement === "composer" ? props.selection : undefined;
  const actionSelection = props.selection && !composerSelection ? props.selection : undefined;
  // Local patch (sidebar-fold): the state of the folded lists lives here and
  // not in the sidebar, which the narrow overlay unmounts when it closes.
  const sidebarFold = useSidebarFold();
  const sidebar = props.sidebarLayout.visible
    ? h(MemoizedSidebar, {
        subagents: props.subagents,
        onOpenSubagent: openSubagent,
        activeTurnId: props.activeTurnId,
        busy: props.busy,
        cacheStats: props.cacheStats,
        contextUsage: props.contextUsage,
        draft: props.draft,
        lastError: props.lastError,
        lastEvent: props.lastEvent,
        messageCount: transcriptMessages.length,
        mcpStatus,
        // Local patch (adddir-command): workspace row add-directory trigger.
        additionalDirectoryCount: props.workingDirectories.length,
        onAddDirClick: readOnly ? undefined : props.onStatusAddDirClick,
        mode: props.mode,
        model: props.model,
        modifiedFiles: props.modifiedFiles,
        networkRequests: props.networkRequests,
        onToggleSection: props.toggleSidebarSection,
        sectionExpansion: props.sidebarSections,
        status: props.status,
        statusDetails: props.statusDetails,
        thoughtLevel: props.thoughtLevel,
        todos: props.todos,
        traceId: props.traceId,
        usage: props.usage,
        developerMode: props.options.developerMode,
        version: props.options.version,
        workspaceDirectory: props.options.workspaceDirectory,
        workspaceGitBranch: props.options.workspaceGitBranch,
        copy: props.copy,
        // Local patch (sidebar-fold).
        listExpansion: sidebarFold.listExpansion,
        onToggleList: sidebarFold.onToggleList,
        // Local patch (panel-memo): the theme, see SidebarProps.
        theme,
      })
    : null;

  return h(
    AppShell,
    { onMouseUp: handleShellMouseUp, sidebar, sidebarLayout: props.sidebarLayout },
    readOnly && props.subagents
      ? h(SubagentView, {
          controller: props.subagents,
          copy: props.copy,
          contentWidth: actionPanelContentWidth,
          pendingMain: props.approvalQueue.length > 0 || Boolean(props.selection),
        })
      : null,
    h(
      "box",
      {
        id: "main-conversation-view",
        visible: !readOnly,
        style: { flexDirection: "column", flexGrow: 1, minHeight: 0 },
      },
      h(ContentPane, {
        id: "main-transcript",
        animateEmptyLogo: !props.options.noColor,
        copy: props.copy,
        focused: false,
        messages: transcriptMessages,
        terminalWidth: actionPanelContentWidth,
        theme,
        workflowCardsByToolCallId: props.workflowCardsByToolCallId,
        expandedWorkflowRunIds: props.expandedWorkflowRunIds,
      }),
      props.approvalQueue[0]
        ? h(ApprovalArea, {
            approval: props.approvalQueue[0],
            contentWidth: actionPanelContentWidth,
            copy: props.copy,
            mainSessionId: props.options.getMainSessionId?.(),
          })
        : actionSelection
          ? h(SelectionPanel, {
              contentWidth: actionPanelContentWidth,
              copy: props.copy,
              selection: actionSelection,
            })
          : h(MemoizedComposerInputArea, {
              focused: !readOnly,
              busy: props.busy,
              contentWidth: actionPanelContentWidth,
              contextUsage: props.contextUsage,
              copy: props.copy,
              draft: props.draft,
              editorRef: props.editorRef,
              effortOptions: props.effortOptions,
              effortSelection: props.effortSelection,
              fileMention: props.fileMention,
              inputCursorToEndVersion: props.inputCursorToEndVersion,
              loginRequired: props.loginRequired,
              mode: props.mode,
              modeOptions: props.modeOptions,
              modeSelection: props.modeSelection,
              model: props.model,
              modelOptions: props.modelOptions,
              modelSelection: props.modelSelection,
              onStatusModelClick: readOnly ? undefined : props.onStatusModelClick,
              onStatusEffortClick: readOnly ? undefined : props.onStatusEffortClick,
              onStatusCompactClick: readOnly ? undefined : props.onStatusCompactClick,
              // Local patch (process-memory-indicator).
              processMemory: props.processMemory,
              statusNotice: props.statusNotice,
              onStatusMemoryClick: readOnly ? undefined : props.onStatusMemoryClick,
              // Local patch (account-quota-indicator).
              accountQuota: props.accountQuota,
              onStatusQuotaClick: readOnly ? undefined : props.onStatusQuotaClick,
              onStatusAddDirClick: readOnly ? undefined : props.onStatusAddDirClick,
              onStatusDirClick: readOnly ? undefined : props.onStatusDirClick,
              queuedInputs,
              selection: composerSelection,
              setDraftValue: readOnly ? noDraftChange : props.setDraftValue,
              slashCommands: props.slashCommands,
              slashSelection: props.slashSelection,
              submitValue: readOnly ? noSubmit : props.submitValue,
              thoughtLevel: props.thoughtLevel,
              // Local patch (panel-memo): the theme, see the props of the composer area.
              theme,
              workingDirectories: props.workingDirectories,
              workingDirectory: props.options.workspaceDirectory,
            }),
    ),
  );
}

export function ComposerInputArea(props: {
  focused?: boolean;
  busy: boolean;
  contentWidth: number;
  contextUsage: ContextUsage;
  copy: ReturnType<typeof import("@zcode/i18n").getZCodeCopy>["tui"];
  draft: string;
  editorRef: React.MutableRefObject<PromptInputEditor | null>;
  effortOptions: readonly TuiEffortOption[];
  effortSelection?: EffortCommandSelectionState;
  fileMention?: FileMentionState;
  inputCursorToEndVersion: number;
  loginRequired: boolean;
  mode: string;
  modeOptions: readonly TuiModeOption[];
  modeSelection?: ModeCommandSelectionState;
  model: string;
  modelOptions: readonly NonNullable<TuiOptions["modelOptions"]>[number][];
  modelSelection?: ModelCommandSelectionState;
  // Local patch (model-effort-status-switcher): click-to-cycle handlers for
  // the model/effort segments in the status row next to the context badge.
  onStatusModelClick?: () => void;
  onStatusEffortClick?: () => void;
  // Local patch (status-compact-button): click handler for the compact glyph
  // rendered after the context badge, the last segment of the status row.
  onStatusCompactClick?: () => void;
  // Local patch (process-memory-indicator).
  processMemory?: ProcessMemoryUsage;
  statusNotice?: StatusNotice;
  onStatusMemoryClick?: () => void;
  // Local patch (account-quota-indicator): the account quota shown in the
  // status row and the handler a click on it wakes.
  accountQuota?: AccountQuotaUsage;
  onStatusQuotaClick?: () => void;
  // Local patch (adddir-command): click handlers for the composer folder
  // badge — "➕" opens the native folder picker, the folder name lists the directories.
  onStatusAddDirClick?: () => void;
  onStatusDirClick?: () => void;
  workingDirectories?: readonly string[];
  workingDirectory?: string;
  queuedInputs: QueuedInput[];
  selection?: SelectionState;
  setDraftValue: (value: string) => void;
  slashCommands: readonly NonNullable<TuiOptions["slashCommands"]>[number][];
  slashSelection?: SlashSelectionState;
  submitValue: (value: string) => void;
  thoughtLevel: string;
  // Local patch (panel-memo): the theme the composer area is drawn in, the
  // key that makes MemoizedComposerInputArea draw itself again on a theme
  // switch; its parts read the colors from the active theme, as the sidebar does.
  theme?: TuiThemeTokens;
}): React.ReactElement {
  return h(
    React.Fragment,
    null,
    props.loginRequired ? h(LoginRequiredPanel, { copy: props.copy }) : null,
    props.fileMention
      ? h(FileMentionPanel, {
          contentWidth: props.contentWidth,
          copy: props.copy,
          state: props.fileMention,
        })
      : null,
    props.selection
      ? h(SelectionPanel, {
          contentWidth: props.contentWidth,
          copy: props.copy,
          selection: props.selection,
        })
      : null,
    props.modelSelection
      ? h(ModelSuggestionPanel, {
          contentWidth: props.contentWidth,
          currentModel: props.model,
          models: props.modelOptions,
          selectedIndex: props.modelSelection.selectedIndex,
        })
      : null,
    props.effortSelection
      ? h(EffortSuggestionPanel, {
          contentWidth: props.contentWidth,
          currentEffort: props.thoughtLevel,
          efforts: props.effortOptions,
          selectedIndex: props.effortSelection.selectedIndex,
        })
      : null,
    props.modeSelection
      ? h(ModeSuggestionPanel, {
          contentWidth: props.contentWidth,
          currentMode: props.mode,
          modes: props.modeOptions,
          selectedIndex: props.modeSelection.selectedIndex,
        })
      : null,
    props.slashSelection
      ? h(SlashSuggestionPanel, {
          contentWidth: props.contentWidth,
          commands: props.slashCommands,
          copy: props.copy,
          selectedIndex: props.slashSelection.selectedIndex,
        })
      : null,
    h(QueuedInputPanel, {
      contentWidth: props.contentWidth,
      copy: props.copy,
      inputs: props.queuedInputs,
    }),
    h(InputPane, {
      busy: props.busy,
      contentWidth: props.contentWidth,
      copy: props.copy,
      editorRef: props.editorRef,
      focused: props.focused ?? true,
      mode: props.mode,
      model: props.model,
      onInput: props.setDraftValue,
      onSubmit: props.submitValue,
      // Local patch (adddir-command): composer folder badge data + handlers.
      onStatusAddDirMouseDown: props.onStatusAddDirClick
        ? () => props.onStatusAddDirClick?.()
        : undefined,
      onStatusDirMouseDown: props.onStatusDirClick ? () => props.onStatusDirClick?.() : undefined,
      resetCursorToEndVersion: props.inputCursorToEndVersion,
      thoughtLevel: props.thoughtLevel,
      value: props.draft,
      workingDirectories: props.workingDirectories,
      workingDirectory: props.workingDirectory,
    }),
    h(InputActiveStatus, {
      active: props.busy,
      contentWidth: props.contentWidth,
      contextUsage: props.contextUsage,
      copy: props.copy,
      model: props.model,
      thoughtLevel: props.thoughtLevel,
      onStatusModelMouseDown: props.onStatusModelClick
        ? () => props.onStatusModelClick?.()
        : undefined,
      onStatusEffortMouseDown: props.onStatusEffortClick
        ? () => props.onStatusEffortClick?.()
        : undefined,
      onStatusCompactMouseDown: props.onStatusCompactClick
        ? () => props.onStatusCompactClick?.()
        : undefined,
      // Local patch (process-memory-indicator).
      notice: props.statusNotice,
      processMemory: props.processMemory,
      onStatusMemoryMouseDown: props.onStatusMemoryClick
        ? () => props.onStatusMemoryClick?.()
        : undefined,
      // Local patch (account-quota-indicator).
      accountQuota: props.accountQuota,
      onStatusQuotaMouseDown: props.onStatusQuotaClick
        ? () => props.onStatusQuotaClick?.()
        : undefined,
    }),
  );
}

// Local patch (panel-memo): the sidebar and the composer area as the view
// renders them. React draws a memoized component again only when one of its
// props changed, so they are drawn for their own data now and not because a
// landing of stream text drew the view: before, every landing drew both, and
// the composer area with its status row is the larger part of what a landing
// of text still cost once the rows of the transcript stopped drawing.
// That holds only as long as every prop keeps its object while its value is
// the same, which is what the app does for the functions it hands down (the
// submit function, the setter of the draft, the click handlers of the status
// row, the subagent controller) and this view does for its own (the handler
// of the sidebar, the empty queue, the read-only no-ops). The theme is a prop
// of both, so a theme switch draws them again.
export const MemoizedSidebar = React.memo(Sidebar);
export const MemoizedComposerInputArea = React.memo(ComposerInputArea);
