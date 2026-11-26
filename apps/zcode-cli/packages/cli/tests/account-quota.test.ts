import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { TuiOptions } from "@zcode/tui";
import type { RunDependencies } from "../src/cli-types.js";
import { createCommandCenter, parseSlashCommand } from "../src/command-center.js";
import { listAvailableCommandNames } from "../src/command-center/slash-commands.js";
import { SLASH_COMMAND_HELP_ENTRIES } from "../src/command-center/slash-command-help.js";
import {
  ACCOUNT_QUOTA_PLAN_CACHE_MS,
  AccountQuotaReadError,
  createNodeAccountQuotaReader,
  formatAccountQuotaReport,
  parseAccountQuotaPlan,
  parseAccountQuotaSnapshot,
  pickCodingPlanQuotaTarget,
  resolveAccountQuotaReader,
  resolvePersonalProviderConfigPath,
} from "../src/account-quota.js";
import { runTuiCommand } from "../src/tui-command.js";

// Local patch (account-quota-indicator).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 10, 23, 18, 0, 0);
const ZAI_KEY = "zai-id.zai-secret";
const BIGMODEL_KEY = "bigmodel-id.bigmodel-secret";
const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const SUBSCRIPTION_URL = "https://api.z.ai/api/biz/subscription/list";

const PROVIDER_CONFIG = {
  schemaVersion: 1,
  config: {
    providerOrder: ["openai", "zai-api"],
    providerConfigRules: {
      providerRules: [
        {
          providerId: "zai-api",
          templateId: "zai-api",
          providerName: "Z.ai Coding Plan",
          config: {
            group: "standard-personal",
            access: { type: "zhipu-coding-plan-api-key", apiKey: ZAI_KEY },
          },
        },
        {
          providerId: "openai",
          templateId: "openai",
          config: {
            access: { type: "api-key", apiKey: "sk-openai" },
            api: { baseUrl: "https://api.openai.com/v1" },
          },
        },
      ],
    },
  },
};

// The shape api.z.ai answered on 2026-11-23 (GLM Coding Max).
const QUOTA_RESPONSE = {
  code: 200,
  msg: "Operation successful",
  data: {
    limits: [
      {
        type: "CREDIT_LIMIT",
        unit: 3,
        number: 5,
        usage: 28_000,
        currentValue: 3_007,
        remaining: 24_992,
        percentage: 10,
        nextResetTime: NOW + 178 * MINUTE,
      },
      {
        type: "CREDIT_LIMIT",
        unit: 6,
        number: 1,
        usage: 140_000,
        currentValue: 104_664,
        remaining: 35_335,
        percentage: 74,
        nextResetTime: NOW + 27 * HOUR,
      },
    ],
    level: "max",
  },
  success: true,
};

const SUBSCRIPTION_RESPONSE = {
  code: 200,
  msg: "Operation successful",
  data: [
    {
      productName: "GLM Coding Max",
      status: "VALID",
      autoRenew: 1,
      nextRenewTime: "2026-12-07",
      valid: "2026-12-07 15:12:18-2027-01-07 15:12:18",
      inCurrentPeriod: true,
    },
  ],
  success: true,
};

type FakeResponse = { status: number } | Record<string, unknown>;

// Answers the listed URLs; any other URL is answered with a failed envelope.
function fakeFetch(responses: Record<string, FakeResponse> = {}) {
  const log: Array<{ headers: Record<string, string>; url: string }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    log.push({ headers: (init?.headers ?? {}) as Record<string, string>, url });
    const response = responses[url] ?? { code: 404, msg: "NOT_FOUND", success: false };
    const status = "status" in response && Object.keys(response).length === 1 ? response.status : 200;
    return new Response(JSON.stringify(response), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, log };
}

function readerWith(
  config: unknown,
  responses: Record<string, FakeResponse> = {},
  options: { env?: Record<string, string | undefined> } = {},
) {
  const { fetchImpl, log } = fakeFetch(responses);
  let clock = NOW;
  const read = createNodeAccountQuotaReader({
    env: options.env ?? {},
    fetchImpl,
    home: join("home", "tester"),
    now: () => clock,
    readFile: async () => JSON.stringify(config),
  });
  return {
    advance: (ms: number) => {
      clock += ms;
    },
    log,
    read,
  };
}

function withRule(rule: Record<string, unknown>) {
  return {
    ...PROVIDER_CONFIG,
    config: {
      ...PROVIDER_CONFIG.config,
      providerConfigRules: {
        providerRules: [
          { ...PROVIDER_CONFIG.config.providerConfigRules.providerRules[0], ...rule },
          PROVIDER_CONFIG.config.providerConfigRules.providerRules[1],
        ],
      },
    },
  };
}

test("finds the personal provider config the way the CLI does", () => {
  const home = join("home", "tester");
  assert.equal(resolvePersonalProviderConfigPath({}, home), join(home, ".zcode", "v2", "provider_config.json"));
  assert.equal(
    resolvePersonalProviderConfigPath({ ZCODE_DATA_BASE_DIR: " D:\\zcode-data " }, home),
    join("D:\\zcode-data", ".zcode", "v2", "provider_config.json"),
  );
  assert.equal(
    resolvePersonalProviderConfigPath({ ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "D:\\elsewhere.json" }, home),
    "D:\\elsewhere.json",
  );
});

test("takes the Coding Plan key of the current model's provider, else the first configured one", () => {
  assert.deepEqual(pickCodingPlanQuotaTarget(PROVIDER_CONFIG, "zai-api"), {
    apiKey: ZAI_KEY,
    origin: "https://api.z.ai",
  });
  // The current model runs on another provider: the account is still the plan's.
  assert.equal(pickCodingPlanQuotaTarget(PROVIDER_CONFIG, "openai")?.apiKey, ZAI_KEY);
  assert.equal(pickCodingPlanQuotaTarget(PROVIDER_CONFIG)?.apiKey, ZAI_KEY);
});

test("never takes a key that is not a Coding Plan key for its template's own host", () => {
  // No API key at all (an account-based Coding Plan provider).
  const withoutKey = withRule({ config: { access: { type: "zhipu-coding-plan-api-key" } } });
  assert.equal(pickCodingPlanQuotaTarget(withoutKey, "zai-api"), undefined);
  // Another access type under a Coding Plan template id.
  const otherAccess = withRule({ config: { access: { type: "api-key", apiKey: "not-a-plan-key" } } });
  assert.equal(pickCodingPlanQuotaTarget(otherAccess, "zai-api"), undefined);
  // The provider was pointed at another endpoint: its key is not theirs to send.
  const relay = withRule({
    config: {
      access: { type: "zhipu-coding-plan-api-key", apiKey: ZAI_KEY },
      api: { baseUrl: "https://relay.example.com/api/anthropic" },
    },
  });
  assert.equal(pickCodingPlanQuotaTarget(relay, "zai-api"), undefined);
  // Garbage instead of a config.
  assert.equal(pickCodingPlanQuotaTarget(undefined, "zai-api"), undefined);
  assert.equal(pickCodingPlanQuotaTarget({ config: { providerConfigRules: { providerRules: "nope" } } }), undefined);
});

test("follows a Coding Plan provider to its template's host and nothing else", () => {
  const config = {
    config: {
      providerOrder: ["bigmodel-api"],
      providerConfigRules: {
        providerRules: [
          {
            providerId: "bigmodel-api",
            templateId: "bigmodel-api",
            config: {
              access: { type: "zhipu-coding-plan-api-key", apiKey: BIGMODEL_KEY },
              // Same host as the template: fine.
              api: { baseUrl: "https://open.bigmodel.cn/api/paas/anthropic" },
            },
          },
        ],
      },
    },
  };
  assert.deepEqual(pickCodingPlanQuotaTarget(config), {
    apiKey: BIGMODEL_KEY,
    origin: "https://open.bigmodel.cn",
  });
});

test("reads the pools of a quota response, the week first", () => {
  const snapshot = parseAccountQuotaSnapshot(QUOTA_RESPONSE, NOW);
  assert.ok(snapshot);
  assert.equal(snapshot.fetchedAt, NOW);
  assert.equal(snapshot.level, "max");
  assert.deepEqual(
    snapshot.windows.map((window) => [window.kind, window.label]),
    [["week", "week"], ["five-hour", "5h"]],
  );
  const [week, fiveHours] = snapshot.windows;
  assert.deepEqual(week, {
    kind: "week",
    label: "week",
    usedCredits: 104_664,
    totalCredits: 140_000,
    remainingCredits: 35_335,
    // Floored, like the percentage the server reports.
    usedPercent: 74,
    nextResetAt: NOW + 27 * HOUR,
  });
  assert.equal(fiveHours?.usedPercent, 10);
});

test("accepts the older token pools and ignores what is not a credit pool", () => {
  const limits = [
    // Legacy shape of the 5-hour pool, without remaining credits.
    { type: "TOKENS_LIMIT", unit: 3, number: 5, usage: 120_000, currentValue: 30_000, percentage: 25 },
    // The MCP / tools monthly pool is not a prompt pool.
    { type: "TIME_LIMIT", unit: 5, number: 1, usage: 100, currentValue: 40, remaining: 60, percentage: 40 },
    { type: "CREDIT_LIMIT", unit: 5, number: 1, usage: 100, currentValue: 40 },
    { type: "CREDIT_LIMIT", unit: 3, usage: 100, currentValue: 40 },
    { type: "CREDIT_LIMIT", unit: 3, number: 0, usage: 100, currentValue: 40 },
    { type: "CREDIT_LIMIT", unit: 3, number: 2, usage: 0, currentValue: 0 },
    { type: "CREDIT_LIMIT", unit: 3, number: 2, usage: "many", currentValue: 0 },
    { unit: 3, number: 5, usage: 100, currentValue: 40 },
  ];
  const snapshot = parseAccountQuotaSnapshot({ code: 200, data: { limits } }, NOW);
  assert.deepEqual(snapshot, {
    fetchedAt: NOW,
    windows: [
      {
        kind: "five-hour",
        label: "5h",
        usedCredits: 30_000,
        totalCredits: 120_000,
        remainingCredits: 90_000,
        usedPercent: 25,
      },
    ],
  });
  // More used than there is never shows above 100%.
  const overdrawn = parseAccountQuotaSnapshot(
    { code: 200, data: { limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 100, currentValue: 130 }] } },
    NOW,
  );
  assert.equal(overdrawn?.windows[0]?.usedPercent, 100);
  assert.equal(overdrawn?.windows[0]?.remainingCredits, 0);
});

test("a response without a recognized pool, or a failed one, yields nothing", () => {
  assert.equal(parseAccountQuotaSnapshot(QUOTA_RESPONSE, NOW)?.windows.length, 2);
  assert.equal(parseAccountQuotaSnapshot({ code: 200, data: { limits: [] }, success: true }, NOW), undefined);
  assert.equal(parseAccountQuotaSnapshot({ code: 200, data: { level: "max" }, success: true }, NOW), undefined);
  assert.equal(parseAccountQuotaSnapshot({ code: 500, msg: "404 NOT_FOUND", success: false }, NOW), undefined);
  assert.equal(parseAccountQuotaSnapshot({ code: 2007, data: { limits: [] } }, NOW), undefined);
  assert.equal(parseAccountQuotaSnapshot("not an envelope", NOW), undefined);
  assert.equal(parseAccountQuotaSnapshot(undefined, NOW), undefined);
});

test("reads the plan of the current period and the day it renews or ends", () => {
  assert.deepEqual(parseAccountQuotaPlan(SUBSCRIPTION_RESPONSE), { planDate: "07.12", planName: "GLM Coding Max" });
  assert.deepEqual(
    parseAccountQuotaPlan({
      code: 0,
      data: [
        { productName: "GLM Coding Lite", status: "VALID", inCurrentPeriod: false, autoRenew: 1, nextRenewTime: "2026-05-01" },
        { productName: "GLM Coding Pro", status: "VALID", inCurrentPeriod: true, autoRenew: 0, valid: "2026-10-01 09:00:00-2026-11-01 09:00:00" },
      ],
    }),
    { expires: true, planDate: "01.11", planName: "GLM Coding Pro" },
  );
  // One plan is enough to tell which; an empty or failed list tells nothing.
  assert.deepEqual(parseAccountQuotaPlan({ code: 200, data: [{ productName: "GLM Coding Max" }] }), {
    planName: "GLM Coding Max",
  });
  assert.equal(parseAccountQuotaPlan({ code: 200, data: [] }), undefined);
  assert.equal(parseAccountQuotaPlan({ code: 200 }), undefined);
  assert.equal(parseAccountQuotaPlan({ code: 500, success: false, data: [] }), undefined);
});

test("resolves nothing, and asks nothing, without a Coding Plan key", async () => {
  const missingFile = createNodeAccountQuotaReader({
    env: {},
    fetchImpl: fakeFetch().fetchImpl,
    home: join("home", "tester"),
    readFile: async () => {
      throw new Error("ENOENT");
    },
  });
  assert.equal(await missingFile({ providerId: "zai-api" }), undefined);

  const { log, read } = readerWith({ config: { providerConfigRules: { providerRules: [] } } });
  assert.equal(await read({ providerId: "zai-api" }), undefined);
  assert.equal(await read(), undefined);
  assert.equal(log.length, 0);
});

test("sends the key as is, to the host it belongs to, and reads pools with plan", async () => {
  const { advance, log, read } = readerWith(PROVIDER_CONFIG, {
    [QUOTA_URL]: QUOTA_RESPONSE,
    [SUBSCRIPTION_URL]: SUBSCRIPTION_RESPONSE,
  });

  const snapshot = await read({ providerId: "zai-api" });
  assert.deepEqual(snapshot, {
    fetchedAt: NOW,
    level: "max",
    planDate: "07.12",
    planName: "GLM Coding Max",
    windows: parseAccountQuotaSnapshot(QUOTA_RESPONSE, NOW)?.windows,
  });

  assert.deepEqual(
    log.map((entry) => entry.url),
    [QUOTA_URL, SUBSCRIPTION_URL],
  );
  for (const entry of log) {
    // The monitor endpoints take the full key in the authorization header, without a Bearer prefix.
    assert.deepEqual(entry.headers, { accept: "application/json", authorization: ZAI_KEY });
    assert.equal(entry.url.startsWith("https://api.z.ai/"), true);
  }

  // The plan is read again only after a while.
  const again = await read({ providerId: "zai-api" });
  assert.equal(again?.planDate, "07.12");
  assert.deepEqual(
    log.map((entry) => entry.url),
    [QUOTA_URL, SUBSCRIPTION_URL, QUOTA_URL],
  );
  advance(ACCOUNT_QUOTA_PLAN_CACHE_MS);
  await read({ providerId: "zai-api" });
  assert.deepEqual(
    log.map((entry) => entry.url),
    [QUOTA_URL, SUBSCRIPTION_URL, QUOTA_URL, QUOTA_URL, SUBSCRIPTION_URL],
  );
});

test("the plan is read with or without a tier, and never in the way of the pools", async () => {
  const untiered = { code: 200, data: { limits: QUOTA_RESPONSE.data.limits }, success: true };
  const { read } = readerWith(PROVIDER_CONFIG, {
    [QUOTA_URL]: untiered,
    [SUBSCRIPTION_URL]: SUBSCRIPTION_RESPONSE,
  });
  const snapshot = await read({ providerId: "zai-api" });
  assert.equal(snapshot?.planName, "GLM Coding Max");
  assert.equal(snapshot?.planDate, "07.12");
  assert.equal(snapshot?.level, undefined);
  assert.equal(snapshot?.windows.length, 2);
});

test("a plan that cannot be read leaves the pools alone", async () => {
  const { log, read } = readerWith(PROVIDER_CONFIG, { [QUOTA_URL]: QUOTA_RESPONSE });
  const snapshot = await read({ providerId: "zai-api" });
  assert.equal(snapshot?.level, "max");
  assert.equal(snapshot?.planDate, undefined);
  assert.equal(snapshot?.planName, undefined);
  assert.equal(snapshot?.windows.length, 2);
  assert.equal(log.some((entry) => entry.url === SUBSCRIPTION_URL), true);
});

async function failureOf(run: () => Promise<unknown>): Promise<AccountQuotaReadError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof AccountQuotaReadError, `not an AccountQuotaReadError: ${String(error)}`);
    return error;
  }
  throw new Error("expected the read to fail");
}

test("a failed read says why, in a term to act on and never with the key", async () => {
  const readerFailingWith = (fetchImpl: typeof fetch) =>
    createNodeAccountQuotaReader({
      env: {},
      fetchImpl,
      home: join("home", "tester"),
      readFile: async () => JSON.stringify(PROVIDER_CONFIG),
    });

  const byStatus = async (status: number) =>
    failureOf(() =>
      readerWith(PROVIDER_CONFIG, { [QUOTA_URL]: { status } }).read({ providerId: "zai-api" }),
    );
  assert.equal((await byStatus(401)).failure, "unauthorized");
  assert.equal((await byStatus(403)).failure, "unauthorized");
  assert.equal((await byStatus(404)).failure, "rejected");
  assert.equal((await byStatus(429)).failure, "rejected");
  assert.equal((await byStatus(500)).failure, "server");
  assert.equal((await byStatus(503)).detail, "HTTP 503");
  // The status line never carries a body, a URL query or the key.
  assert.equal((await byStatus(503)).message.includes(ZAI_KEY), false);

  const gone = await failureOf(() =>
    readerWith(PROVIDER_CONFIG, { [QUOTA_URL]: { code: 500, msg: "404 NOT_FOUND", success: false } }).read({
      providerId: "zai-api",
    }),
  );
  assert.equal(gone.failure, "rejected");

  const offline = (async () => {
    throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
  }) as unknown as typeof fetch;
  const unreachable = await failureOf(() =>
    readerFailingWith(offline)({ providerId: "zai-api" }),
  );
  assert.equal(unreachable.failure, "offline");
  assert.equal(unreachable.message.includes("fetch failed"), false);

  const slow = (async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  }) as unknown as typeof fetch;
  assert.equal(
    (await failureOf(() => readerFailingWith(slow)({ providerId: "zai-api" }))).failure,
    "timeout",
  );

  const garbage = (async () =>
    new Response(`not json ${ZAI_KEY}`, { status: 200 }),
  ) as unknown as typeof fetch;
  const invalid = await failureOf(() => readerFailingWith(garbage)({ providerId: "zai-api" }));
  assert.equal(invalid.failure, "rejected");
  assert.equal(invalid.detail, "invalid response");
  assert.equal(invalid.message.includes(ZAI_KEY), false);
});

test("the CLI's reader is one per environment, and an injected one wins", () => {
  const env = { ZCODE_DATA_BASE_DIR: "D:\\zcode-data" };
  const injected = async () => undefined;
  assert.equal(resolveAccountQuotaReader({ env, readAccountQuota: injected }), injected);
  const first = resolveAccountQuotaReader({ env });
  assert.equal(typeof first, "function");
  assert.equal(resolveAccountQuotaReader({ env }), first);
  // Another environment is another account root: another reader.
  assert.notEqual(resolveAccountQuotaReader({ env: { ...env } }), first);
  assert.equal(resolveAccountQuotaReader({}), resolveAccountQuotaReader({ env: process.env }));
});

test("an account whose plan has no pools is not an error", async () => {
  const { read } = readerWith(PROVIDER_CONFIG, {
    [QUOTA_URL]: { code: 200, msg: "Operation successful", data: { level: "max" }, success: true },
  });
  assert.equal(await read({ providerId: "zai-api" }), undefined);
});

test("the TUI gets the reader of the CLI, unless the embedder brings its own", async () => {
  const seen: Array<TuiOptions["readAccountQuota"]> = [];
  const app = { close: async () => undefined };
  const depsWith = (extra: Record<string, unknown>) =>
    ({
      env: {},
      cwd: () => process.cwd(),
      skipUserConfig: true,
      loadDotenv: () => ({ keys: [], loaded: false, path: "" }),
      createZCodeApp: async () => app,
      startProcessProviderRegistryRuntime: async () => ({ dispose() {} }),
      resolveWorkspaceGitBranch: async () => undefined,
      listCustomCommands: async () => ({ commands: [], diagnostics: [], totalDiscovered: 0 }),
      runTui: async (options: TuiOptions) => {
        seen.push(options.readAccountQuota);
        return 0;
      },
      ...extra,
    }) as unknown as RunDependencies;
  const ctx = { argv: [], stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };
  const options = { noColor: true, force: false, json: false, verbose: false, locale: "en-US" };

  assert.equal(await runTuiCommand(ctx, options, depsWith({}), "test"), 0);
  assert.equal(typeof seen[0], "function");
  // Nothing was read on the way: the TUI asks when it wants the numbers.
  assert.equal(seen.length, 1);

  const own = async () => undefined;
  assert.equal(await runTuiCommand(ctx, options, depsWith({ readAccountQuota: own }), "test"), 0);
  assert.equal(seen[1], own);
});

// The reset moment is shown in local time; derive the expectation the same way.
function localDate(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function liveAccountSnapshot() {
  const snapshot = parseAccountQuotaSnapshot(QUOTA_RESPONSE, NOW);
  assert.ok(snapshot);
  return { ...snapshot, planDate: "07.12", planName: "GLM Coding Max" };
}

// /usage shows the time left from the real clock: the fixture's offsets from the real now, both resets ahead.
function snapshotOnTheRealClock() {
  const now = Date.now();
  const snapshot = liveAccountSnapshot();
  const offsets = [27 * HOUR, 178 * MINUTE];   // week, then 5 hours, as in the fixture
  return {
    ...snapshot,
    fetchedAt: now,
    windows: snapshot.windows.map((window, index) => ({ ...window, nextResetAt: now + offsets[index] })),
  };
}

test("/usage is a known local command that /help and the suggestions list", () => {
  assert.deepEqual(parseSlashCommand("/usage"), { args: "", name: "usage", rawName: "usage", type: "known" });
  assert.deepEqual(parseSlashCommand("/USAGE now"), { args: "now", name: "usage", rawName: "usage", type: "known" });
  const entry = SLASH_COMMAND_HELP_ENTRIES.find((candidate) => candidate.name === "usage");
  assert.ok(entry);
  assert.equal(entry.usage, "/usage");
  assert.equal(listAvailableCommandNames().includes("/usage"), true);
});

test("the report draws a bar per pool with the credits behind it", () => {
  const bar = (filled: number) => `${"█".repeat(filled)}${"░".repeat(30 - filled)}`;
  assert.equal(
    formatAccountQuotaReport(liveAccountSnapshot(), NOW),
    [
      "```",
      "Coding Plan usage - GLM Coding Max, renews 07.12",
      "",
      `Week     ${bar(22)}  74.8% used`,
      `         104.7K of 140K credits, 35.3K left, resets ${localDate(NOW + 27 * HOUR)} (in 1d 3h)`,
      "",
      `5 hours  ${bar(3)}  10.7% used`,
      "         3.0K of 28K credits, 25.0K left, resets in 2h 58m",
      "```",
    ].join("\n"),
  );
});

test("the report copes without a plan, a reset time, or a limit that was exceeded", () => {
  const bare = formatAccountQuotaReport(
    {
      fetchedAt: NOW,
      windows: [{ kind: "five-hour", label: "5h", usedCredits: 935, totalCredits: 935, remainingCredits: 0, usedPercent: 100 }],
    },
    NOW,
  );
  assert.deepEqual(bare.split("\n"), [
    "```",
    "Coding Plan usage",
    "",
    `5 hours  ${"█".repeat(30)}  100.0% used`,
    "         935 of 935 credits, 0 left",
    "```",
  ]);
  const overdrawn = formatAccountQuotaReport(
    {
      expires: true,
      fetchedAt: NOW,
      level: "pro",
      planDate: "01.11",
      windows: [{ kind: "week", label: "week", usedCredits: 1_500_000, totalCredits: 1_000_000, remainingCredits: 0, usedPercent: 100, nextResetAt: NOW + 30_000 }],
    },
    NOW,
  );
  // One pool only: the label column is as wide as that label.
  assert.deepEqual(overdrawn.split("\n"), [
    "```",
    "Coding Plan usage - Pro, expires 01.11",
    "",
    `Week  ${"█".repeat(30)}  100.0% used`,
    "      1.5M of 1M credits, 0 left, resets now",
    "```",
  ]);
});

function usageFixture(reader: TuiOptions["readAccountQuota"]) {
  const inputs: unknown[] = [];
  const commandCenter = createCommandCenter({
    getApp: async () => {
      throw new Error("getApp should not be called for /usage");
    },
    getMode: () => "build",
    readAccountQuota: async (input) => {
      inputs.push(input);
      return reader(input);
    },
    resumeApp: async () => {
      throw new Error("resume should not be called");
    },
  });
  return { commandCenter, inputs };
}

test("/usage prints the report of the account without starting a session", async () => {
  const { commandCenter, inputs } = usageFixture(async () => snapshotOnTheRealClock());
  const result = await commandCenter("/usage", {});
  assert.equal(result.mode, "build");
  assert.match(result.response ?? "", /^```\nCoding Plan usage - GLM Coding Max, renews 07\.12\n/);
  // The time left depends on the real clock; the bars and credits do not.
  assert.match(result.response ?? "", /\nWeek {5}█{22}░{8} {2}74\.8% used\n/);
  assert.match(result.response ?? "", /\n5 hours {2}█{3}░{27} {2}10\.7% used\n/);
  assert.match(result.response ?? "", /104\.7K of 140K credits, 35\.3K left, resets /);
  assert.match(result.response ?? "", /3\.0K of 28K credits, 25\.0K left, resets in /);
  assert.deepEqual(inputs, [{}]);
});

test("/usage says what is wrong instead of a report", async () => {
  // No Coding Plan key: nothing to read.
  const unconfigured = usageFixture(async () => undefined);
  assert.match(
    (await unconfigured.commandCenter("/usage", {})).response ?? "",
    /No Z\.ai or BigModel Coding Plan API key is configured.*\/login/,
  );

  // A rejected key, with the reason and what to do.
  const rejected = usageFixture(async () => {
    throw new AccountQuotaReadError("unauthorized", "HTTP 401");
  });
  assert.equal(
    (await rejected.commandCenter("/usage", {})).response,
    "Could not read the plan usage: unauthorized (HTTP 401). The API key was rejected. Check it with /login.",
  );

  // Whatever else breaks: never the error text, it could hold credentials.
  const broken = usageFixture(async () => {
    throw new Error(`fetch failed for ${ZAI_KEY}`);
  });
  const response = (await broken.commandCenter("/usage", {})).response ?? "";
  assert.match(response, /^Could not read the plan usage: offline\. /);
  assert.equal(response.includes(ZAI_KEY), false);

  // A client without the reader.
  const withoutReader = createCommandCenter({
    getApp: async () => {
      throw new Error("getApp should not be called for /usage");
    },
    resumeApp: async () => {
      throw new Error("resume should not be called");
    },
  });
  assert.equal((await withoutReader("/usage", {})).response, "Account usage is not available in this client.");
});

test("/usage takes no arguments and reads nothing then", async () => {
  const { commandCenter, inputs } = usageFixture(async () => liveAccountSnapshot());
  assert.deepEqual(await commandCenter("/usage later", {}), { mode: "build", response: "Usage: /usage" });
  assert.deepEqual(inputs, []);
});
