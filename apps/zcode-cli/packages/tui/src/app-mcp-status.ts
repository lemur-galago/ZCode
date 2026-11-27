import { useEffect, useRef, useState } from "react";
import type { McpServerStatus } from "@zcode/contracts";
import type { McpSidebarState } from "./app-model.js";
import type { TuiListMcpServers } from "./types.js";

const MCP_STATUS_REFRESH_INTERVAL_MS = 5_000;
const MCP_STATUS_RETRY_INTERVAL_MS = 10_000;

// Local patch (mcp-status-on-change): the list is read every 5 s to follow a
// server that connects or drops, but it used to be stored as a new object on
// every read, so the whole view re-rendered (and asked for a frame) twice per
// 5 s in an idle tab - a 95-190 ms burst of CPU in a session with a long
// transcript. Now only a real change is stored, which React skips otherwise.
// `updatedAt` is left out of the comparison: the lister stamps the current
// time on every server without a live status, so it changes on every read,
// and the sidebar never shows it.
export function sameMcpStatuses(
  left: Record<string, McpServerStatus>,
  right: Record<string, McpServerStatus>,
): boolean {
  return sameValue(ignoreUpdatedAt(left), ignoreUpdatedAt(right));
}

function ignoreUpdatedAt(servers: Record<string, McpServerStatus>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, status]) => [name, { ...status, updatedAt: undefined }]),
  );
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  return (
    leftKeys.length === Object.keys(rightRecord).length &&
    leftKeys.every((key) => Object.hasOwn(rightRecord, key) && sameValue(leftRecord[key], rightRecord[key]))
  );
}

export function useMcpSidebarStatus(
  listMcpServers: TuiListMcpServers | undefined,
  options: { refreshIntervalMs?: number; retryIntervalMs?: number } = {},
): McpSidebarState {
  const [state, setState] = useState<McpSidebarState>(() => ({
    loading: listMcpServers !== undefined,
    servers: {},
  }));
  // Read when a read is scheduled, not when the options change.
  const settings = useRef(options);
  settings.current = options;

  useEffect(() => {
    if (!listMcpServers) {
      // Local patch (panel-memo): the state it already is, is kept as the same
      // object: a fresh one drew the memoized sidebar once more at the mount.
      setState((current) =>
        !current.loading && current.error === undefined && Object.keys(current.servers).length === 0
          ? current
          : { loading: false, servers: {} },
      );
      return;
    }
    const loadMcpServers = listMcpServers;

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function scheduleRefresh(delayMs: number) {
      timer = setTimeout(() => {
        void refresh();
      }, delayMs);
    }

    async function refresh() {
      setState((current) => {
        // Only the first read loads; a retry after a failure keeps the error.
        const loading = Object.keys(current.servers).length === 0 && current.error === undefined;
        return current.loading === loading ? current : { ...current, loading };
      });

      try {
        const servers = await loadMcpServers();
        if (disposed) return;
        setState((current) =>
          sameMcpStatuses(current.servers, servers) && !current.loading && current.error === undefined
            ? current
            : { loading: false, servers },
        );
        scheduleRefresh(settings.current.refreshIntervalMs ?? MCP_STATUS_REFRESH_INTERVAL_MS);
      } catch (error) {
        if (disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        setState((current) =>
          current.error === message && !current.loading
            ? current
            : { ...current, error: message, loading: false },
        );
        scheduleRefresh(settings.current.retryIntervalMs ?? MCP_STATUS_RETRY_INTERVAL_MS);
      }
    }

    void refresh();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [listMcpServers]);

  return state;
}
