// Local patch (account-quota-indicator): used quota of the Coding Plan account
// in the input status row — the weekly and the 5-hour credit pools as "week
// 74% · 5h 10%", colored as a pool fills up. A click shows the details
// (credits, reset times, plan) as a notice and asks for a fresh read. The TUI
// only renders what the host supplies through TuiOptions.readAccountQuota; the
// reader itself lives in the CLI, so nothing here touches credentials or the
// network.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { STATUS_NOTICE_CLAUSE_SEPARATOR, type StatusNotice } from "./app-input-status.js";

export type AccountQuotaWindowKind = "five-hour" | "week";

/** One credit pool of the plan, e.g. the 5-hour or the weekly pool. */
export type AccountQuotaWindow = {
  kind: AccountQuotaWindowKind;
  /** Row label, e.g. "5h" or "week". */
  label: string;
  usedCredits: number;
  totalCredits: number;
  remainingCredits: number;
  /** Used share of the pool, whole percent 0..100. */
  usedPercent: number;
  /** Epoch milliseconds; absent when the server sent none. */
  nextResetAt?: number;
};

/** One successful read of the account; the pools come in display order. */
export type AccountQuotaSnapshot = {
  /** Epoch milliseconds of the read. */
  fetchedAt: number;
  /** Plan tier as the server names it, e.g. "max". */
  level?: string;
  /** Plan name, e.g. "GLM Coding Max"; the row names the plan by tier when there is one. */
  planName?: string;
  /** Date the plan renews (or, with `expires`, ends), DD.MM. */
  planDate?: string;
  /** The plan ends on `planDate` instead of renewing. */
  expires?: boolean;
  windows: AccountQuotaWindow[];
};

export type AccountQuotaLevel = "danger" | "normal" | "warning";

/** One pool as the row shows it. */
export type AccountQuotaPart = {
  label: string;
  level: AccountQuotaLevel;
};

/** What the status row shows for one snapshot. */
export type AccountQuotaUsage = {
  parts: AccountQuotaPart[];
  /** Clause for the notice: the plan and when it renews. */
  planLabel?: string;
  /** The pools behind `parts`, same order. */
  windows: AccountQuotaWindow[];
};

/** Resolves `undefined` when the account has no readable quota (no Coding Plan key). */
export type ReadAccountQuota = (input: { providerId?: string }) => Promise<AccountQuotaSnapshot | undefined>;

export const ACCOUNT_QUOTA_WARNING_PERCENT = 70;
export const ACCOUNT_QUOTA_DANGER_PERCENT = 90;
/** A snapshot nobody could refresh for this long is not shown anymore. */
export const ACCOUNT_QUOTA_STALE_MS = 30 * 60_000;
export const ACCOUNT_QUOTA_FIRST_READ_DELAY_MS = 2_000;
export const ACCOUNT_QUOTA_READ_INTERVAL_MS = 60_000;
export const ACCOUNT_QUOTA_UNAVAILABLE_RETRY_MS = 10 * 60_000;
export const ACCOUNT_QUOTA_RETRY_DELAYS_MS: readonly number[] = [
  60_000,
  2 * 60_000,
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
];
// A read is asked for again right after a pool resets, plus this slack.
const ACCOUNT_QUOTA_RESET_SLACK_MS = 5_000;
const ACCOUNT_QUOTA_MIN_READ_DELAY_MS = 1_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const KILO = 1_000;
const MEGA = KILO * KILO;

export function accountQuotaLevel(usedPercent: number): AccountQuotaLevel {
  if (usedPercent >= ACCOUNT_QUOTA_DANGER_PERCENT) return "danger";
  if (usedPercent >= ACCOUNT_QUOTA_WARNING_PERCENT) return "warning";
  return "normal";
}

/** Credits the way the context badge shows tokens: 935, 3.0K, 25.0K, 104.7K, 140K, 1.2M. */
export function formatAccountQuotaCredits(value: number): string {
  if (!Number.isFinite(value)) return "-";
  if (Math.abs(value) < KILO) return String(Math.round(value));
  const unit = Math.abs(value) < MEGA ? KILO : MEGA;
  const scaled = (value / unit).toFixed(1);
  // "140K", not "140.0K": the decimal goes only when it really is zero.
  const shown = Number(scaled) === value / unit ? String(Number(scaled)) : scaled;
  return `${shown}${unit === KILO ? "K" : "M"}`;
}

/** Time left, in whole minutes: "45m", "2h 58m", "1d 3h". */
export function formatAccountQuotaDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE_MS));
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  const rest = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
  return `${rest}m`;
}

/**
 * When a pool resets: within a day the time left is what matters ("resets in
 * 2h 58m"), beyond it the moment ("resets 25.11 10:12 (in 1d 3h)"), local time.
 */
export function formatAccountQuotaReset(
  nextResetAt: number | undefined,
  now: number,
): string | undefined {
  if (nextResetAt === undefined || !Number.isFinite(nextResetAt)) return undefined;
  const remaining = nextResetAt - now;
  if (remaining < MINUTE_MS) return "resets now";
  const duration = formatAccountQuotaDuration(remaining);
  if (remaining < DAY_MS) return `resets in ${duration}`;
  return `resets ${formatLocalDate(nextResetAt)} (in ${duration})`;
}

function formatLocalDate(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The row content of a snapshot. A pool whose reset time has passed is unknown
 * until the next read and is left out.
 */
export function createAccountQuotaUsage(
  snapshot: AccountQuotaSnapshot | undefined,
  now: number = Date.now(),
): AccountQuotaUsage | undefined {
  if (!snapshot || now - snapshot.fetchedAt > ACCOUNT_QUOTA_STALE_MS) return undefined;
  const windows = snapshot.windows.filter(
    (window) => window.nextResetAt === undefined || window.nextResetAt > now,
  );
  if (windows.length === 0) return undefined;
  return {
    parts: windows.map((window) => ({
      label: `${window.label} ${window.usedPercent}%`,
      level: accountQuotaLevel(window.usedPercent),
    })),
    planLabel: accountQuotaPlanLabel(snapshot),
    windows,
  };
}

// "Max, renews 07.12" — the tier and the billing date.
function accountQuotaPlanLabel(snapshot: AccountQuotaSnapshot): string | undefined {
  const tier = snapshot.level?.trim();
  const name = tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : snapshot.planName?.trim();
  if (!name) return undefined;
  if (!snapshot.planDate) return `${name} plan`;
  return `${name}, ${snapshot.expires ? "expires" : "renews"} ${snapshot.planDate}`;
}

export const ACCOUNT_QUOTA_PENDING_NOTICE_TEXT = "Reading the account quota...";

// Shown from the click on the segment until the read it asks for lands.
export function accountQuotaPendingNotice(): StatusNotice {
  return { text: ACCOUNT_QUOTA_PENDING_NOTICE_TEXT };
}

/**
 * Clauses of decreasing importance: the pools (week first), then the plan.
 * The status row joins them with the notice clause separator, so a narrow
 * terminal drops whole clauses from the end instead of cutting a number.
 */
export function accountQuotaNoticeClauses(usage: AccountQuotaUsage, now: number): string[] {
  const clauses = usage.windows.map((window) => {
    const reset = formatAccountQuotaReset(window.nextResetAt, now) ?? "reset time unknown";
    const used = formatAccountQuotaCredits(window.usedCredits);
    const total = formatAccountQuotaCredits(window.totalCredits);
    return `${window.label} ${window.usedPercent}% (${used}/${total}), ${reset}`;
  });
  if (usage.planLabel) clauses.push(usage.planLabel);
  return clauses;
}

/** What a click on the quota segment shows: credits, reset times and the plan. */
export function accountQuotaNotice(usage: AccountQuotaUsage, now: number = Date.now()): StatusNotice {
  return { text: accountQuotaNoticeClauses(usage, now).join(STATUS_NOTICE_CLAUSE_SEPARATOR) };
}

function sameAccountQuotaUsage(
  current: AccountQuotaUsage | undefined,
  next: AccountQuotaUsage | undefined,
): boolean {
  if (current === next) return true;
  if (!current || !next || current.planLabel !== next.planLabel) return false;
  return (
    current.parts.length === next.parts.length &&
    current.parts.every(
      (part, index) => part.label === next.parts[index]?.label && part.level === next.parts[index]?.level,
    )
  );
}

export type UseAccountQuotaOptions = {
  read?: ReadAccountQuota;
  /** Provider of the current model: the reader takes that provider's credentials. */
  providerId?: string;
  now?: () => number;
  firstReadDelayMs?: number;
  intervalMs?: number;
  /** Waits before the next attempt after 1, 2, 3... failed reads (the last one repeats). */
  retryDelaysMs?: readonly number[];
  /** Wait before looking again when the account has no readable quota. */
  unavailableRetryMs?: number;
};

function NO_REFRESH(): void {
  // Nothing is wired (tests, embedded hosts): a click has nothing to ask for.
}

/**
 * Latest account quota, undefined until the first read and whenever there is
 * nothing to show. State only changes when the shown values change, so the
 * regular reads never re-render an idle session. `refresh` asks for a read at
 * once; one asked for while a read is running gets one of its own after it.
 * Only the reader and the provider start the reads over; the timings are
 * looked up when they are needed, so they may change from render to render.
 */
export function useAccountQuota(options: UseAccountQuotaOptions = {}): {
  usage: AccountQuotaUsage | undefined;
  refresh: () => void;
} {
  const { read, providerId } = options;
  const settings = useRef(options);
  settings.current = options;
  const [usage, setUsage] = useState<AccountQuotaUsage | undefined>(undefined);
  const requestRef = useRef<() => void>(NO_REFRESH);

  // Another provider is another account: its numbers do not carry over, not
  // even for the single render in which the provider changes.
  const knownProviderRef = useRef(providerId);
  if (knownProviderRef.current !== providerId) {
    knownProviderRef.current = providerId;
    if (usage !== undefined) setUsage(undefined);
  }

  useEffect(() => {
    if (!read) return;
    const readQuota: ReadAccountQuota = read;
    let disposed = false;
    let inFlight = false;
    let again = false;
    let failures = 0;
    let lastSnapshot: AccountQuotaSnapshot | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const now = () => settings.current.now?.() ?? Date.now();
    const intervalMs = () => settings.current.intervalMs ?? ACCOUNT_QUOTA_READ_INTERVAL_MS;
    // After 1, 2, 3... failed reads in a row; the last wait repeats.
    const retryDelayMs = () => {
      const delays = settings.current.retryDelaysMs ?? ACCOUNT_QUOTA_RETRY_DELAYS_MS;
      return delays[Math.min(failures, delays.length) - 1] ?? intervalMs();
    };

    function schedule(delayMs: number) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void poll(), delayMs);
    }

    function publish(snapshot: AccountQuotaSnapshot | undefined) {
      const next = createAccountQuotaUsage(snapshot, now());
      setUsage((current) => (sameAccountQuotaUsage(current, next) ? current : next));
    }

    // The regular interval, or right after the nearest pool resets so the row
    // follows a reset at once.
    function nextReadDelay(snapshot: AccountQuotaSnapshot): number {
      const resets = snapshot.windows.flatMap((window) =>
        window.nextResetAt === undefined ? [] : [window.nextResetAt - now()],
      );
      const nearest = resets.length > 0 ? Math.min(...resets) : Number.POSITIVE_INFINITY;
      return Math.max(ACCOUNT_QUOTA_MIN_READ_DELAY_MS, Math.min(intervalMs(), nearest + ACCOUNT_QUOTA_RESET_SLACK_MS));
    }

    async function poll(): Promise<void> {
      if (inFlight) {
        again = true;
        return;
      }
      // This read schedules the next one itself.
      if (timer) clearTimeout(timer);
      timer = undefined;
      inFlight = true;
      try {
        let snapshot: AccountQuotaSnapshot | undefined;
        let failed = false;
        try {
          snapshot = await readQuota({ providerId });
        } catch {
          failed = true;
        }
        if (disposed) return;
        if (failed) {
          // Keep what was read before (minus what went stale) and back off.
          failures += 1;
          publish(lastSnapshot);
          schedule(retryDelayMs());
          return;
        }
        failures = 0;
        lastSnapshot = snapshot;
        publish(snapshot);
        schedule(
          snapshot
            ? nextReadDelay(snapshot)
            : (settings.current.unavailableRetryMs ?? ACCOUNT_QUOTA_UNAVAILABLE_RETRY_MS),
        );
      } finally {
        inFlight = false;
        if (again && !disposed) {
          again = false;
          void poll();
        }
      }
    }

    requestRef.current = () => {
      if (!disposed) void poll();
    };
    schedule(settings.current.firstReadDelayMs ?? ACCOUNT_QUOTA_FIRST_READ_DELAY_MS);

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      requestRef.current = NO_REFRESH;
    };
  }, [providerId, read]);

  const refresh = useCallback(() => requestRef.current(), []);
  return useMemo(() => ({ refresh, usage }), [refresh, usage]);
}
