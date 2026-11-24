// Local patch (account-quota-indicator): reads the used quota of the Coding
// Plan account for the quota segment of the TUI status row — the weekly and
// the 5-hour credit pools, with the plan and the day it renews. The key is the
// one the personal provider config already holds for a Z.ai / BigModel Coding
// Plan provider, and it is sent only to the host that provider's own requests
// go to (the origin of its template). The quota endpoint is unofficial: a pool
// is matched by type, unit and number, and a response without a recognized
// pool yields nothing instead of a guess.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";
import type {
  AccountQuotaSnapshot,
  AccountQuotaWindow,
  AccountQuotaWindowKind,
  TuiReadAccountQuota,
} from "@zcode/tui";

const DATA_BASE_DIR_ENV_KEY = "ZCODE_DATA_BASE_DIR";
// Access type of the two Coding Plan templates that authenticate with an API
// key, and the host each of them belongs to.
const CODING_PLAN_ACCESS_TYPE = "zhipu-coding-plan-api-key";
const CODING_PLAN_TEMPLATE_ORIGINS: Readonly<Record<string, string>> = {
  "zai-api": "https://api.z.ai",
  "bigmodel-api": "https://open.bigmodel.cn",
};
const QUOTA_PATH = "/api/monitor/usage/quota/limit";
const SUBSCRIPTION_PATH = "/api/biz/subscription/list";
// `unit` of the quota response: 3 = hours (5-hour pool), 6 = week.
const HOUR_UNIT = 3;
const WEEK_UNIT = 6;
const POOL_TYPES = new Set(["CREDIT_LIMIT", "TOKENS_LIMIT"]);

export const ACCOUNT_QUOTA_REQUEST_TIMEOUT_MS = 10_000;
// The plan and its renewal day change rarely: they are read at most this often.
export const ACCOUNT_QUOTA_PLAN_CACHE_MS = 30 * 60_000;

type UnknownRecord = Record<string, unknown>;

export type AccountQuotaTarget = {
  /** The provider's API key; the monitor endpoints take it as the authorization header as is. */
  apiKey: string;
  /** The host the key belongs to, e.g. "https://api.z.ai". */
  origin: string;
};

export type AccountQuotaPlan = Pick<
  AccountQuotaSnapshot,
  "expires" | "planDate" | "planName"
>;

/** Path of the personal provider config, the one the CLI runs its model providers from. */
export function resolvePersonalProviderConfigPath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const explicit = env[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim();
  if (explicit) return explicit;
  const dataBaseDir = env[DATA_BASE_DIR_ENV_KEY]?.trim() || home;
  return join(dataBaseDir, ".zcode", "v2", PERSONAL_PROVIDER_CONFIG_FILE_NAME);
}

/**
 * The Coding Plan provider the quota is read for: the provider of the current
 * model when it is one, else the first configured one. Only the two Coding
 * Plan templates with an API key qualify, and only while the provider still
 * talks to its template's own host — a key pointed at another endpoint is not
 * theirs to send there.
 */
export function pickCodingPlanQuotaTarget(
  source: unknown,
  providerId?: string,
): AccountQuotaTarget | undefined {
  // The file is { schemaVersion, config: { providerOrder, providerConfigRules } }.
  const config = asRecord(asRecord(source).config);
  const order = Array.isArray(config.providerOrder) ? config.providerOrder : [];
  const rules = asRecord(config.providerConfigRules).providerRules;
  const candidates = (Array.isArray(rules) ? rules : []).flatMap((rule) => {
    const provider = nonEmptyString(asRecord(rule).providerId);
    const templateId = nonEmptyString(asRecord(rule).templateId);
    const origin = templateId ? CODING_PLAN_TEMPLATE_ORIGINS[templateId] : undefined;
    const ruleConfig = asRecord(asRecord(rule).config);
    const apiKey = nonEmptyString(asRecord(ruleConfig.access).apiKey);
    if (!provider || !origin || !apiKey) return [];
    if (asRecord(ruleConfig.access).type !== CODING_PLAN_ACCESS_TYPE) return [];
    const baseUrl = nonEmptyString(asRecord(ruleConfig.api).baseUrl);
    if (baseUrl !== undefined && originOf(baseUrl) !== origin) return [];
    return [{ apiKey, origin, provider, rank: order.indexOf(provider) }];
  });
  if (candidates.length === 0) return undefined;
  candidates.sort(
    (left, right) =>
      (left.rank < 0 ? Number.POSITIVE_INFINITY : left.rank) -
      (right.rank < 0 ? Number.POSITIVE_INFINITY : right.rank),
  );
  const wanted = providerId?.trim();
  const chosen =
    (wanted ? candidates.find((candidate) => candidate.provider === wanted) : undefined) ??
    candidates[0];
  return chosen ? { apiKey: chosen.apiKey, origin: chosen.origin } : undefined;
}

/**
 * The pools of a quota response in display order (week first). A response
 * without a recognized pool yields undefined.
 */
export function parseAccountQuotaSnapshot(
  payload: unknown,
  fetchedAt: number,
): AccountQuotaSnapshot | undefined {
  if (!isSuccessfulEnvelope(payload)) return undefined;
  const data = asRecord(asRecord(payload).data);
  const limits = Array.isArray(data.limits) ? data.limits : [];
  const windows = limits.flatMap(parseAccountQuotaWindow);
  if (windows.length === 0) return undefined;
  windows.sort((left, right) => (left.kind === right.kind ? 0 : left.kind === "week" ? -1 : 1));
  const level = nonEmptyString(data.level);
  return { fetchedAt, ...(level ? { level } : {}), windows };
}

function parseAccountQuotaWindow(limit: unknown): AccountQuotaWindow[] {
  const record = asRecord(limit);
  if (typeof record.type !== "string" || !POOL_TYPES.has(record.type)) return [];
  const hours = finiteNumber(record.number);
  const kind = poolKind(record.unit, hours);
  if (!kind) return [];
  const total = finiteNumber(record.usage);
  const used = finiteNumber(record.currentValue);
  if (total === undefined || used === undefined || total <= 0) return [];
  const remaining = finiteNumber(record.remaining);
  const nextResetAt = finiteNumber(record.nextResetTime);
  return [
    {
      kind,
      label: kind === "week" ? "week" : `${hours}h`,
      usedCredits: used,
      totalCredits: total,
      remainingCredits: remaining ?? Math.max(0, total - used),
      // Floored like the percentage the server reports next to these numbers.
      usedPercent: Math.min(100, Math.max(0, Math.floor((used / total) * 100))),
      ...(nextResetAt === undefined ? {} : { nextResetAt }),
    },
  ];
}

function poolKind(unit: unknown, hours: number | undefined): AccountQuotaWindowKind | undefined {
  if (unit === WEEK_UNIT) return "week";
  if (unit === HOUR_UNIT && hours !== undefined && hours > 0) return "five-hour";
  return undefined;
}

/** The plan in its current period: its name and the day it renews (or ends). */
export function parseAccountQuotaPlan(payload: unknown): AccountQuotaPlan | undefined {
  if (!isSuccessfulEnvelope(payload)) return undefined;
  const list = asRecord(payload).data;
  if (!Array.isArray(list)) return undefined;
  const plans = list.map(asRecord);
  const plan = plans.find((candidate) => candidate.inCurrentPeriod === true) ?? plans[0];
  if (!plan) return undefined;
  const planName = nonEmptyString(plan.productName);
  if (plan.autoRenew === true || plan.autoRenew === 1) {
    const planDate = dayMonth(plan.nextRenewTime);
    return { ...(planName ? { planName } : {}), ...(planDate ? { planDate } : {}) };
  }
  // Without auto-renewal the plan runs out at the end of the paid period.
  const planDate = lastDayMonth(plan.valid);
  return {
    ...(planName ? { planName } : {}),
    ...(planDate ? { expires: true, planDate } : {}),
  };
}

export type AccountQuotaReadFailure = "offline" | "rejected" | "server" | "timeout" | "unauthorized";

/** Why the account could not be read, in terms the user can act on. Never carries the key. */
export class AccountQuotaReadError extends Error {
  constructor(
    readonly failure: AccountQuotaReadFailure,
    readonly detail: string = "",
  ) {
    super(`Account quota read failed: ${failure}${detail ? ` (${detail})` : ""}`);
    this.name = "AccountQuotaReadError";
  }
}

export type NodeAccountQuotaReaderOptions = {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  home?: string;
  now?: () => number;
  readFile?: (path: string) => Promise<string>;
  timeoutMs?: number;
};

/**
 * Reads the quota for the TUI status row and the /usage command. Resolves
 * undefined when there is no Coding Plan key to read it with; a request that
 * fails throws an AccountQuotaReadError, so the TUI keeps its last numbers and
 * the command can say what went wrong.
 */
export function createNodeAccountQuotaReader(
  options: NodeAccountQuotaReaderOptions = {},
): TuiReadAccountQuota {
  const {
    env = process.env,
    fetchImpl = fetch,
    home = homedir(),
    now = Date.now,
    timeoutMs = ACCOUNT_QUOTA_REQUEST_TIMEOUT_MS,
  } = options;
  const readFileImpl = options.readFile ?? ((path: string) => readFile(path, "utf8"));
  let planCache: {
    apiKey: string;
    plan: AccountQuotaPlan | undefined;
    readAt: number;
  } | undefined;

  async function getJson(target: AccountQuotaTarget, path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${target.origin}${path}`, {
        headers: { accept: "application/json", authorization: target.apiKey },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
        ? new AccountQuotaReadError("timeout")
        : new AccountQuotaReadError("offline");
    }
    if (!response.ok) {
      const failure: AccountQuotaReadFailure =
        response.status === 401 || response.status === 403
          ? "unauthorized"
          : response.status >= 500
            ? "server"
            : "rejected";
      throw new AccountQuotaReadError(failure, `HTTP ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new AccountQuotaReadError("rejected", "invalid response");
    }
  }

  // Best effort: without the plan the TUI shows the tier alone.
  async function readPlan(target: AccountQuotaTarget): Promise<AccountQuotaPlan | undefined> {
    if (planCache && planCache.apiKey === target.apiKey && now() - planCache.readAt < ACCOUNT_QUOTA_PLAN_CACHE_MS) {
      return planCache.plan;
    }
    try {
      const plan = parseAccountQuotaPlan(await getJson(target, SUBSCRIPTION_PATH));
      planCache = { apiKey: target.apiKey, plan, readAt: now() };
      return plan;
    } catch {
      return undefined;
    }
  }

  return async ({ providerId } = {}) => {
    let config: unknown;
    try {
      config = JSON.parse(await readFileImpl(resolvePersonalProviderConfigPath(env, home)));
    } catch {
      return undefined;
    }
    const target = pickCodingPlanQuotaTarget(config, providerId);
    if (!target) return undefined;
    const payload = await getJson(target, QUOTA_PATH);
    if (!isSuccessfulEnvelope(payload)) throw new AccountQuotaReadError("rejected");
    const snapshot = parseAccountQuotaSnapshot(payload, now());
    if (!snapshot) return undefined;
    const plan = await readPlan(target);
    return plan ? { ...snapshot, ...plan } : snapshot;
  };
}

// One default reader per environment object, so the status row and /usage of a
// process share the plan cache.
const defaultReaders = new WeakMap<object, TuiReadAccountQuota>();

/** The reader the embedder injected, else the CLI's own for that environment. */
export function resolveAccountQuotaReader(deps: {
  env?: Record<string, string | undefined>;
  readAccountQuota?: TuiReadAccountQuota;
}): TuiReadAccountQuota {
  if (deps.readAccountQuota) return deps.readAccountQuota;
  const env = deps.env ?? process.env;
  let reader = defaultReaders.get(env);
  if (!reader) {
    reader = createNodeAccountQuotaReader({ env });
    defaultReaders.set(env, reader);
  }
  return reader;
}

const REPORT_BAR_CELLS = 30;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The /usage report: a bar per pool with the credits behind it. It sits in a
 * code block, so the columns stay aligned however the transcript is shown.
 */
export function formatAccountQuotaReport(
  snapshot: AccountQuotaSnapshot,
  now: number = Date.now(),
): string {
  const lines = [reportTitle(snapshot), ""];
  const labelWidth = Math.max(...snapshot.windows.map((window) => reportLabel(window).length));
  for (const window of snapshot.windows) {
    const share = Math.min(1, Math.max(0, window.usedCredits / window.totalCredits));
    const filled = Math.round(REPORT_BAR_CELLS * share);
    const label = reportLabel(window).padEnd(labelWidth);
    lines.push(`${label}  ${"█".repeat(filled)}${"░".repeat(REPORT_BAR_CELLS - filled)}  ${(share * 100).toFixed(1)}% used`);
    lines.push(
      `${"".padEnd(labelWidth)}  ${reportCredits(window.usedCredits)} of ${reportCredits(window.totalCredits)} credits, ${reportCredits(window.remainingCredits)} left${reportReset(window.nextResetAt, now)}`,
    );
    lines.push("");
  }
  lines.pop();
  return ["```", ...lines, "```"].join("\n");
}

function reportTitle(snapshot: AccountQuotaSnapshot): string {
  const tier = snapshot.level?.trim();
  const name = snapshot.planName?.trim() || (tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : "");
  if (!name) return "Coding Plan usage";
  if (!snapshot.planDate) return `Coding Plan usage - ${name}`;
  return `Coding Plan usage - ${name}, ${snapshot.expires ? "expires" : "renews"} ${snapshot.planDate}`;
}

function reportLabel(window: AccountQuotaWindow): string {
  return window.kind === "week" ? "Week" : `${window.label.replace(/h$/u, "")} hours`;
}

function reportReset(nextResetAt: number | undefined, now: number): string {
  if (nextResetAt === undefined || !Number.isFinite(nextResetAt)) return "";
  const remaining = nextResetAt - now;
  if (remaining < MINUTE_MS) return ", resets now";
  const left = reportDuration(remaining);
  // Within a day the time left is what matters, beyond it the moment.
  return remaining < DAY_MS ? `, resets in ${left}` : `, resets ${reportDate(nextResetAt)} (in ${left})`;
}

function reportDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE_MS));
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  const rest = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
  return `${rest}m`;
}

function reportDate(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function reportCredits(value: number): string {
  if (Math.abs(value) < 1_000) return String(Math.round(value));
  const unit = Math.abs(value) < 1_000_000 ? 1_000 : 1_000_000;
  const scaled = (value / unit).toFixed(1);
  // "140K", not "140.0K": the decimal goes only when it really is zero.
  const shown = Number(scaled) === value / unit ? String(Number(scaled)) : scaled;
  return `${shown}${unit === 1_000 ? "K" : "M"}`;
}

// Z.ai and BigModel answer code 200 and code 0 for success alike.
function isSuccessfulEnvelope(payload: unknown): boolean {
  const record = asRecord(payload);
  if (record.success === false) return false;
  return record.code === undefined || record.code === 0 || record.code === 200;
}

function asRecord(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null ? (value as UnknownRecord) : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

// A date of the subscription list ("2026-12-07 ...") as day and month: "07.12".
function dayMonth(value: unknown): string | undefined {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})/u.exec(value) : null;
  return match ? `${match[3]}.${match[2]}` : undefined;
}

function lastDayMonth(value: unknown): string | undefined {
  const dates = typeof value === "string" ? value.match(/\d{4}-\d{2}-\d{2}/gu) : null;
  return dates && dates.length > 0 ? dayMonth(dates[dates.length - 1]) : undefined;
}
