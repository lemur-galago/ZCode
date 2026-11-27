import type { ModelUsageSummary, TodoItem, TurnId } from "@zcode/contracts";
import { getZCodeCopy } from "@zcode/i18n";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppView } from "./app-view.js";
import type { PromptInputEditor } from "./app-input-pane.js";
import {
  selectionCopyStatus,
  type SelectionCopyOptions,
  type SelectionCopyResult,
} from "./app-copy.js";
import { useClipboardImagePaste } from "./app-clipboard-image.js";
import { useFileMentionController } from "./app-file-mentions.js";
import { useTuiKeyboardControls } from "./app-keyboard.js";
import { useTuiModeSwitcher } from "./app-mode.js";
import { createTuiPermissionRequester } from "./app-permission.js";
import { appendAgentResult } from "./app-submit.js";
import { useSubmitValue } from "./app-submit-controller.js";
import { filterSlashCommands, reconcileSlashSelection } from "./app-input.js";
import { modelDisplayParts, modelOptionValue, UNKNOWN_MODEL_FIELD } from "./app-model-ref.js";
import { useEffortCommandController } from "./app-effort-command.js";
import { useInputHistory } from "./app-input-history.js";
import { type StatusNotice } from "./app-input-status.js";
import { useModeCommandController } from "./app-mode-command.js";
import { useModelCommandController } from "./app-model-command.js";
import {
  PROCESS_MEMORY_IDLE_SAMPLE_INTERVAL_MS,
  PROCESS_MEMORY_SAMPLE_INTERVAL_MS,
  STATUS_NOTICE_DURATION_MS,
  processMemoryNotice,
  useProcessMemory,
} from "./app-process-memory.js";
// Local patch (account-quota-indicator).
import {
  accountQuotaNotice,
  accountQuotaPendingNotice,
  useAccountQuota,
} from "./app-account-quota.js";
import {
  createDirectoryPickerGate,
  isDirectoryPickerSupported,
  pickWindowsDirectory,
  type DirectoryPickerGate,
} from "./app-directory-picker.js";
import { useSidebarController } from "./app-sidebar-layout.js";
import { createSelectionState } from "./app-selection-state.js";
import { resolveComposerSubmittedText } from "./app-submit-resolver.js";
import type {
  ApprovalPrompt,
  CacheStats,
  ContextUsage,
  DraftAttachment,
  Message,
  ModifiedFileStat,
  NetworkRequest,
  QueuedInput,
  SelectionState,
  SlashSelectionState,
} from "./app-model.js";
import { useTuiThemeSync } from "./app-theme-sync.js";
import { useSessionEventApplier } from "./app-session-event-handler.js";
// Local patch (stream-coalesce).
import { createStreamBuffer, useStreamFrameCost } from "./app-stream-coalesce.js";
import { useTuiWorkflowRuns } from "./app-workflow-controller.js";
import { useTuiApplyResult } from "./app-result.js";
import { useSubagents } from "./app-subagents.js";
import type { TuiOptions } from "./types.js";

type TuiAppProps = {
  copySelection: (options?: SelectionCopyOptions) => Promise<SelectionCopyResult>;
  hasCopyableSelection: () => boolean;
  options: TuiOptions;
  onExit: (code: number) => void;
};

export function TuiApp({
  copySelection,
  hasCopyableSelection,
  onExit,
  options,
}: TuiAppProps): React.ReactElement {
  // Startup sentinels are diagnostics, not user-visible transcript messages.
  const initialResult = options.initialResult;
  const initialLoginRequired = initialResult?.loginRequired ?? options.loginRequired ?? false;
  const initialLocale = options.locale ?? "en-US";
  const initialCopy = getZCodeCopy(initialLocale).tui;
  // Local patch (transcript-row-memo): the theme travels down as a prop.
  const theme = useTuiThemeSync(options);
  const [messages, setMessages] = useState<Message[]>(() =>
    initialResult
      ? appendAgentResult([], initialResult, { workspaceDirectory: options.workspaceDirectory })
      : [],
  );
  const [draft, setDraftState] = useState("");
  const [, setDraftAttachmentsState] = useState<DraftAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState(initialResult?.mode ?? options.initialMode ?? "build");
  const [model, setModel] = useState(initialResult?.model ?? options.initialModel ?? "unknown");
  const [thoughtLevel, setThoughtLevel] = useState(
    initialResult?.thoughtLevel ?? options.initialThoughtLevel ?? "",
  );
  // Local patch (adddir-command): additional working directories live in the
  // prompt handler; results and startup options carry the current list.
  const [workingDirectories, setWorkingDirectories] = useState<readonly string[]>(
    () => initialResult?.workingDirectories ?? options.initialWorkingDirectories ?? [],
  );
  const [locale, setLocale] = useState(initialLocale);
  const [lastEvent, setLastEvent] = useState("idle");
  const [lastError, setLastError] = useState<string | undefined>();
  const copy = useMemo(() => getZCodeCopy(locale), [locale]);
  const [loginRequired, setLoginRequired] = useState(initialLoginRequired);
  const [status, setStatus] = useState(
    initialResult?.selection?.prompt ??
      (initialLoginRequired ? initialCopy.loginRequired.status : initialCopy.status.ready),
  );
  const [statusDetails, setStatusDetails] = useState<string[]>([]);
  const [traceId, setTraceId] = useState<string | undefined>();
  const [activeTurnId, setActiveTurnId] = useState<TurnId | undefined>();
  const [contextUsage, setContextUsage] = useState<ContextUsage>({});
  const [cacheStats, setCacheStats] = useState<CacheStats | undefined>();
  const [usage, setUsage] = useState<ModelUsageSummary | undefined>();
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [networkRequests, setNetworkRequests] = useState<NetworkRequest[]>([]);
  const [modifiedFiles, setModifiedFiles] = useState<ModifiedFileStat[]>([]);
  const [liveModelText, setLiveModelText] = useState("");
  // Local patch (stream-coalesce): stream deltas land in the transcript at a
  // bounded rate instead of one re-render of everything per event.
  const streamBuffer = useMemo(
    () => createStreamBuffer({ setLiveModelText, setMessages, setStatus }),
    [setLiveModelText, setMessages, setStatus],
  );
  useEffect(() => () => streamBuffer.dispose(), [streamBuffer]);
  useStreamFrameCost(streamBuffer);
  const [queuedInputs, setQueuedInputs] = useState<QueuedInput[]>([]);
  const [selection, setSelection] = useState<SelectionState | undefined>(() =>
    createSelectionState(initialResult?.selection),
  );
  const [slashSelection, setSlashSelection] = useState<SlashSelectionState | undefined>();
  const [approvalQueue, setApprovalQueue] = useState<ApprovalPrompt[]>([]);
  const [inputCursorToEndVersion, setInputCursorToEndVersion] = useState(0);
  // dwf 运行态镜像：共享 reducer 逐事件维护 + 冷启动一次性补种，无第二时钟。
  const workflowRuns = useTuiWorkflowRuns({ copy: copy.tui, options, setMessages });
  const sidebar = useSidebarController();
  const subagents = useSubagents(options);

  const abortControllerRef = useRef<AbortController | undefined>(undefined);
  const draftRef = useRef("");
  // Local patch (terminal-steer-queue-delivery): latest-value ref so session
  // event handlers can read the queue without joining the React effect graph.
  const queuedInputsRef = useRef<QueuedInput[]>(queuedInputs);
  queuedInputsRef.current = queuedInputs;
  const draftAttachmentsRef = useRef<DraftAttachment[]>([]);
  const inputEditorRef = useRef<PromptInputEditor | null>(null);
  const inputHistoryIndexRef = useRef(0);
  const inputHistoryDraftAttachmentsRef = useRef<DraftAttachment[] | undefined>(undefined);
  const inputHistoryDraftRef = useRef<string | undefined>(undefined);
  const nextAttachmentIdRef = useRef(1);
  const assistantMessageIdsByToolCallIdRef = useRef(new Map<string, string>());
  const modifiedFileToolCallIdsRef = useRef(new Set<string>());
  const toolNamesByIdRef = useRef(new Map<string, string>());

  // Local patch (panel-memo): one list for a session without slash commands.
  // A fresh empty one on every render reached the setter of the composer draft
  // through its dependencies, and that setter is a prop of the memoized composer.
  const slashCommands = useMemo(
    () => options.slashCommands ?? [],
    [options.slashCommands],
  );
  const [effortOptions, setEffortOptions] = useState<NonNullable<TuiOptions["effortOptions"]>>(
    () => initialResult?.effortOptions ?? options.effortOptions ?? [],
  );
  const filteredSlashCommands = useMemo(
    () => filterSlashCommands(draft, slashCommands),
    [draft, slashCommands],
  );
  const effortCommand = useEffortCommandController(draft, effortOptions);
  const modelCommand = useModelCommandController(draft, options);
  const modeCommand = useModeCommandController(draft);

  const setDraftAttachments = useCallback((action: React.SetStateAction<DraftAttachment[]>) => {
    const nextAttachments =
      typeof action === "function" ? action(draftAttachmentsRef.current) : action;
    draftAttachmentsRef.current = nextAttachments;
    setDraftAttachmentsState(nextAttachments);
  }, []);

  const setDraftValue = useCallback(
    (value: string) => {
      draftRef.current = value;
      setDraftState(value);
      setDraftAttachments((current) =>
        current.filter((attachment) => value.includes(attachment.placeholder)),
      );
      inputHistoryIndexRef.current = 0;
      inputHistoryDraftAttachmentsRef.current = undefined;
      inputHistoryDraftRef.current = undefined;
      const nextModelSelection = modelCommand.reconcileDraft(value);
      const nextEffortSelection = nextModelSelection
        ? undefined
        : effortCommand.reconcileDraft(value);
      const nextModeSelection =
        nextModelSelection || nextEffortSelection ? undefined : modeCommand.reconcileDraft(value);
      if (nextModelSelection) {
        effortCommand.setSelection(undefined);
        modeCommand.setSelection(undefined);
      } else if (nextEffortSelection) {
        modelCommand.setSelection(undefined);
        modeCommand.setSelection(undefined);
      } else if (nextModeSelection) {
        effortCommand.setSelection(undefined);
        modelCommand.setSelection(undefined);
      }
      setSlashSelection(
        nextModelSelection || nextEffortSelection || nextModeSelection
          ? undefined
          : reconcileSlashSelection(value, slashCommands),
      );
    },
    [effortCommand, modeCommand, modelCommand, setDraftAttachments, slashCommands],
  );

  // Local patch (terminal-steer-queue-delivery): undelivered queue items are
  // restored into the composer draft when their turn ends, so a typed message
  // is never silently lost — the user decides when to resend it.
  const restoreDroppedQueuedInputs = useCallback(
    (texts: string[]) => {
      const restored = texts.filter((text) => text.trim().length > 0);
      if (restored.length === 0) return;
      setDraftValue(
        [...(draftRef.current.trim() ? [draftRef.current] : []), ...restored].join("\n"),
      );
      setInputCursorToEndVersion((version) => version + 1);
      setStatus(
        restored.length > 1
          ? `${restored.length} queued inputs restored to the composer.`
          : "Queued input restored to the composer.",
      );
    },
    [setDraftValue, setInputCursorToEndVersion, setStatus],
  );

  const applyResult = useTuiApplyResult({
    fallback: { locale, loginRequired, mode, model },
    modifiedFileToolCallIds: modifiedFileToolCallIdsRef.current,
    setActiveTurnId,
    setCacheStats,
    setContextUsage,
    setEffortOptions,
    setLastEvent,
    setLiveModelText,
    setLocale,
    setLoginRequired,
    setMessages,
    setMode,
    setModel,
    setModelOptions: modelCommand.setModelOptions,
    setModifiedFiles,
    setNetworkRequests,
    setQueuedInputs,
    setSelection,
    setStatus,
    setThoughtLevel,
    setTodos,
    setTraceId,
    setUsage,
    setWorkingDirectories,
    workspaceDirectory: options.workspaceDirectory,
    // Local patch (stream-coalesce): a result is appended after the buffered deltas.
    flushStream: streamBuffer.flush,
  });

  const applySessionEvent = useSessionEventApplier({
    streamBuffer,
    subscribeSessionEvents: options.subscribeSessionEvents,
    observeSessionEvent: subagents.onEvent,
    copy: copy.tui,
    getMainSessionId: options.getMainSessionId,
    getQueuedInputs: () => queuedInputsRef.current,
    restoreDroppedQueuedInputs,
    setActiveTurnId,
    setCacheStats,
    setContextUsage,
    setLastError,
    setLastEvent,
    setLiveModelText,
    setMessages,
    setModel,
    setThoughtLevel,
    setModifiedFiles,
    setNetworkRequests,
    setQueuedInputs,
    setStatus,
    setTodos,
    setUsage,
    setWorkflowMirror: workflowRuns.setMirror,
    assistantMessageIdsByToolCallId: assistantMessageIdsByToolCallIdRef.current,
    modifiedFileToolCallIds: modifiedFileToolCallIdsRef.current,
    toolNamesById: toolNamesByIdRef.current,
    workspaceDirectory: options.workspaceDirectory,
  });

  const requestPermission = useMemo(
    () => createTuiPermissionRequester({ setApprovalQueue, setStatus }),
    [],
  );
  const registerPermissionRequester = options.registerPermissionRequester;
  // 挂载期间审批入口一直有效：主会话回合之外的询问（后台会话、通知驱动的回合）也进同一队列。
  useEffect(
    () => registerPermissionRequester?.(requestPermission),
    [registerPermissionRequester, requestPermission],
  );

  const resolveSubmittedText = useCallback(
    (submittedValue: string) => {
      const modelOption = modelCommand.selectedOption(submittedValue);
      const effortOption = modelOption ? undefined : effortCommand.selectedOption(submittedValue);
      return resolveComposerSubmittedText({
        effortOption,
        modeOption:
          modelOption || effortOption ? undefined : modeCommand.selectedOption(submittedValue),
        modelOption,
        slashCommands: filteredSlashCommands,
        slashSelection,
        submittedValue,
      });
    },
    [effortCommand, filteredSlashCommands, modeCommand, modelCommand, slashSelection],
  );

  const submitValue = useSubmitValue({
    activeTurnId,
    applyResult,
    applySessionEvent,
    busy,
    draftAttachmentsRef,
    emptyPromptStatus: copy.tui.input.typePrompt,
    // Local patch (stream-coalesce): the prompt is placed after the buffered deltas.
    flushStream: streamBuffer.flush,
    messageInsertIndex: messages.length,
    options,
    resolveSubmittedText,
    resolveSubmittedModel: (value) => modelCommand.selectedOption(value)?.ref,
    setBusy,
    setDraftAttachments,
    setDraftValue,
    setLastError,
    setLiveModelText,
    setMessages,
    setQueuedInputs,
    setSelection,
    setSlashSelection,
    setStatus,
    setStatusDetails,
    turnRef: abortControllerRef,
  });

  const pasteClipboardImage = useClipboardImagePaste({
    abortControllerRef,
    busy,
    getDraftValue: () => draftRef.current,
    inputEditorRef,
    nextAttachmentIdRef,
    options,
    setDraftAttachments,
    setDraftValue,
    setStatus,
    setStatusDetails,
  });

  const { recallNextInput, recallPreviousInput } = useInputHistory({
    copy: copy.tui,
    draftAttachmentsRef,
    draftRef,
    inputHistoryDraftAttachmentsRef,
    inputHistoryDraftRef,
    inputHistoryIndexRef,
    nextAttachmentIdRef,
    options,
    setDraftAttachments,
    setDraftState,
    setDraftValue,
    setInputCursorToEndVersion,
    setSlashSelection,
    setStatus,
    setStatusDetails,
  });

  const fileMentions = useFileMentionController({
    busy,
    draft,
    editorRef: inputEditorRef,
    listWorkspacePathSuggestions: options.listWorkspacePathSuggestions,
    nextAttachmentIdRef,
    setDraftAttachments,
    setDraftValue,
    setSlashSelection,
    setStatus,
  });

  const copyCurrentSelection = useCallback(
    (selectionOptions?: SelectionCopyOptions): boolean => {
      if (!hasCopyableSelection()) return false;
      void copySelection(selectionOptions).then((result) => {
        const copyStatus = selectionCopyStatus(result, copy.tui.copy);
        if (copyStatus.status) setStatus(copyStatus.status);
        if (copyStatus.details) setStatusDetails(copyStatus.details);
      });
      return true;
    },
    [copy, copySelection, hasCopyableSelection],
  );
  const switchMode = useTuiModeSwitcher({
    mode,
    setMode,
    setModeHandler: options.setMode,
    setStatus,
  });

  // Local patch (model-effort-status-switcher): clicking the model or effort
  // segment in the status row cycles to the next option by submitting the
  // same /model or /effort command the composer sends for a typed switch.
  const cycleStatusModel = useCallback(async () => {
    if (subagents.selected || approvalQueue[0] || busy) {
      if (busy) setStatus("Stop or finish the current turn to switch the model.");
      return;
    }
    const listModelOptions = options.listModelOptions;
    let models = modelCommand.modelOptions;
    if (models.length === 0 && listModelOptions) {
      try {
        models = await listModelOptions();
      } catch {
        models = [];
      }
    }
    if (models.length === 0) {
      setStatus("No models available to switch to.");
      return;
    }
    const current = model.trim().toLowerCase();
    const currentIndex = models.findIndex(
      (option) => modelOptionValue(option).toLowerCase() === current,
    );
    const next = models[(currentIndex + 1 + models.length) % models.length];
    void submitValue(`/model ${modelOptionValue(next)}`);
  }, [
    approvalQueue.length,
    busy,
    model,
    modelCommand.modelOptions,
    options.listModelOptions,
    setStatus,
    submitValue,
    subagents.selected,
  ]);

  const cycleStatusEffort = useCallback(() => {
    if (subagents.selected || approvalQueue[0] || busy) {
      if (busy) setStatus("Stop or finish the current turn to switch effort.");
      return;
    }
    const efforts = effortOptions;
    if (efforts.length === 0) return;
    const current = thoughtLevel.trim().toLowerCase();
    const currentIndex = efforts.findIndex((option) => option.id.toLowerCase() === current);
    const next = efforts[(currentIndex + 1) % efforts.length];
    void submitValue(`/effort ${next.id}`);
  }, [
    approvalQueue.length,
    busy,
    effortOptions,
    setStatus,
    submitValue,
    subagents.selected,
    thoughtLevel,
  ]);

  // Local patch (status-compact-button): clicking the compact glyph submits
  // /compact — identical to typing the command, so busy-turn behaviour (the
  // sendInput command path) matches the manual flow exactly.
  const submitStatusCompact = useCallback(() => {
    if (subagents.selected || approvalQueue[0]) return;
    void submitValue("/compact");
  }, [approvalQueue.length, submitValue, subagents.selected]);

  // Local patch (adddir-command): clicking the ➕ glyph next to the composer
  // folder badge opens the native folder picker (Windows FolderBrowserDialog
  // via powershell -STA); the chosen path is submitted as `/adddir "<path>"`
  // automatically. Platforms without the picker fall back to prefilling
  // "/adddir " so the path can be typed. Clicking the folder name itself
  // lists the current additional directories.
  const directoryPickerGateRef = useRef<DirectoryPickerGate | undefined>(undefined);
  directoryPickerGateRef.current ??= createDirectoryPickerGate();

  const openStatusDirPicker = useCallback(() => {
    if (subagents.selected || approvalQueue[0]) return;
    if (!isDirectoryPickerSupported()) {
      setDraftValue("/adddir ");
      setInputCursorToEndVersion((version) => version + 1);
      inputEditorRef.current?.focus();
      setStatus("Type a directory path after /adddir and press Enter.");
      return;
    }
    void directoryPickerGateRef.current?.run(async () => {
      setStatus("Waiting for folder selection...");
      let picked: string | undefined;
      try {
        picked = await pickWindowsDirectory();
      } catch {
        picked = undefined;
      }
      if (picked) {
        await submitValue(`/adddir "${picked}"`);
        return;
      }
      setStatus("Folder selection cancelled.");
      inputEditorRef.current?.focus();
    });
  }, [approvalQueue.length, setDraftValue, setStatus, submitValue, subagents.selected]);

  const submitStatusDirList = useCallback(() => {
    if (subagents.selected || approvalQueue[0]) return;
    void submitValue("/adddir");
  }, [approvalQueue.length, submitValue, subagents.selected]);

  // Local patch (process-memory-indicator): the session's memory usage in the
  // status row. A click shows, for a while, the command that restarts the
  // session — the only way to release the memory it has accumulated.
  // Local patch (process-memory-idle-interval): memory grows while a turn
  // runs, so the probe is more frequent then; an idle tab reads it once a minute.
  const processMemory = useProcessMemory({
    read: options.readProcessMemory,
    intervalMs: busy ? PROCESS_MEMORY_SAMPLE_INTERVAL_MS : PROCESS_MEMORY_IDLE_SAMPLE_INTERVAL_MS,
  });
  const [statusNotice, setStatusNotice] = useState<StatusNotice | undefined>(undefined);
  const statusNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Local patch (account-quota-indicator): the segment whose notice is shown.
  const statusNoticeOwnerRef = useRef<"memory" | "quota" | undefined>(undefined);
  useEffect(
    () => () => {
      if (statusNoticeTimerRef.current) clearTimeout(statusNoticeTimerRef.current);
    },
    [],
  );
  // Shows a notice for a while; a newer one replaces the one shown.
  const showStatusNotice = useCallback((owner: "memory" | "quota", notice: StatusNotice) => {
    if (statusNoticeTimerRef.current) clearTimeout(statusNoticeTimerRef.current);
    statusNoticeOwnerRef.current = owner;
    statusNoticeTimerRef.current = setTimeout(() => {
      statusNoticeTimerRef.current = undefined;
      statusNoticeOwnerRef.current = undefined;
      setStatusNotice(undefined);
    }, STATUS_NOTICE_DURATION_MS);
    setStatusNotice(notice);
  }, []);
  const showStatusMemoryNotice = useCallback(() => {
    if (subagents.selected) return;
    showStatusNotice("memory", processMemoryNotice(options.getMainSessionId?.()));
  }, [options.getMainSessionId, showStatusNotice, subagents.selected]);

  // Local patch (account-quota-indicator): used quota of the Coding Plan
  // account in the status row. A click shows the details as a notice and asks
  // for a fresh read; while that notice is shown it follows the quota.
  const quotaProvider = modelDisplayParts(model).provider;
  // Local patch (panel-memo): the quota and its refresh are taken apart: the
  // object the hook returns is a fresh one on every render, and the click
  // handler below is a prop of the memoized composer.
  const { refresh: refreshAccountQuota, usage: accountQuotaUsage } = useAccountQuota({
    providerId: quotaProvider === UNKNOWN_MODEL_FIELD ? undefined : quotaProvider,
    read: options.readAccountQuota,
  });
  const showStatusQuotaNotice = useCallback(() => {
    if (subagents.selected) return;
    showStatusNotice(
      "quota",
      accountQuotaUsage ? accountQuotaNotice(accountQuotaUsage) : accountQuotaPendingNotice(),
    );
    refreshAccountQuota();
  }, [accountQuotaUsage, refreshAccountQuota, showStatusNotice, subagents.selected]);
  useEffect(() => {
    if (statusNoticeOwnerRef.current !== "quota") return;
    setStatusNotice(
      accountQuotaUsage ? accountQuotaNotice(accountQuotaUsage) : accountQuotaPendingNotice(),
    );
  }, [accountQuotaUsage]);

  useTuiKeyboardControls({
    readOnlyView: subagents.selected ? { back: subagents.back } : undefined,
    abortControllerRef,
    approvalQueue,
    busy,
    copyCurrentSelection,
    effortSelection: effortCommand.selection,
    filteredEffortOptions: effortCommand.filteredOptions,
    filteredSlashCommands,
    filteredModeOptions: modeCommand.filteredOptions,
    filteredModelOptions: modelCommand.filteredOptions,
    handleFileMentionKey: fileMentions.handleKey,
    inputEditorRef,
    onExit,
    pasteClipboardImage,
    recallNextInput,
    recallPreviousInput,
    draftValue: draft,
    inputHistoryActive: inputHistoryDraftRef.current !== undefined,
    messages,
    modelSelection: modelCommand.selection,
    modeSelection: modeCommand.selection,
    selection,
    setApprovalQueue,
    setDraftAttachments,
    setDraftValue,
    setEffortSelection: effortCommand.setSelection,
    setModelSelection: modelCommand.setSelection,
    setModeSelection: modeCommand.setSelection,
    setSelection,
    setSlashSelection,
    setStatus,
    slashSelection,
    submitValue,
    switchMode,
    workflowExpansion: workflowRuns.expansion,
    toggleSidebar: sidebar.toggleSidebar,
    toggleSidebarSection: sidebar.toggleSidebarSection,
  });

  return React.createElement(AppView, {
    subagents,
    toggleSidebar: sidebar.toggleSidebar,
    activeTurnId,
    approvalQueue,
    busy,
    cacheStats,
    contextUsage,
    copy: copy.tui,
    copyCurrentSelection,
    draft,
    editorRef: inputEditorRef,
    inputCursorToEndVersion,
    lastError,
    lastEvent,
    loginRequired,
    liveModelText,
    mode,
    model,
    messages,
    modifiedFiles,
    networkRequests,
    options,
    queuedInputs,
    selection,
    fileMention: fileMentions.state,
    setDraftValue,
    sidebarLayout: sidebar.layout,
    sidebarSections: sidebar.sections,
    effortOptions: effortCommand.filteredOptions,
    effortSelection: effortCommand.selection,
    modelOptions: modelCommand.filteredOptions,
    modelSelection: modelCommand.selection,
    modeOptions: modeCommand.filteredOptions,
    modeSelection: modeCommand.selection,
    onStatusModelClick: cycleStatusModel,
    onStatusEffortClick: cycleStatusEffort,
    onStatusCompactClick: submitStatusCompact,
    // Local patch (process-memory-indicator).
    processMemory,
    statusNotice,
    onStatusMemoryClick: showStatusMemoryNotice,
    // Local patch (account-quota-indicator, panel-memo).
    accountQuota: accountQuotaUsage,
    onStatusQuotaClick: showStatusQuotaNotice,
    onStatusAddDirClick: openStatusDirPicker,
    onStatusDirClick: submitStatusDirList,
    slashCommands: filteredSlashCommands,
    slashSelection,
    status,
    statusDetails,
    submitValue,
    thoughtLevel,
    workingDirectories,
    todos,
    toggleSidebarSection: sidebar.toggleSidebarSection,
    traceId,
    terminalWidth: sidebar.terminalWidth,
    // Local patch (transcript-row-memo).
    theme,
    usage,
    workflowCardsByToolCallId: workflowRuns.cardsByToolCallId,
    expandedWorkflowRunIds: workflowRuns.expandedRunIds,
  });
}
