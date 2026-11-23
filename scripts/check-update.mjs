#!/usr/bin/env node
// Once-per-day self-update check for the fork source checkout.
// Usage:
//   node check-update.mjs --repo <path-to-source-repo> --install-dir <zcode-install-root> [--git <git.exe>] [--yes] [--force]
// Behavior:
//   - skipped when .update-check-stamp in the install root is younger than 24 hours (--force overrides)
//   - a failed git fetch (offline) is not tried again for an hour and never blocks launching
//   - when origin/main is ahead: shows the new commits and asks "Установить сейчас? [y/N]";
//     without a terminal on stdin nothing is asked, one line goes to stderr instead
//   - on accept: git pull --ff-only, then runs scripts/install.ps1 from the source repo
//   - every message goes to stderr: stdout belongs to the CLI (`zcode -p`)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const readArg = (name, fallback = "") => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const REPO = resolve(readArg("--repo"));
const INSTALL_DIR = resolve(readArg("--install-dir"));
const FLAG_YES = args.includes("--yes");
const FLAG_FORCE = args.includes("--force");
const STAMP = resolve(INSTALL_DIR, ".update-check-stamp");
const FAILED_STAMP = resolve(INSTALL_DIR, ".update-check-stamp-failed");
const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000; // after a failed fetch: offline must not mean waiting on every launch
const FETCH_TIMEOUT_MS = 10000;
const PULL_TIMEOUT_MS = 10 * 60 * 1000;

// git: explicit --git > system git (the one that made the clone) > MinGit bundled with the install.
// Resolved on first use.
let git;
function resolveGit() {
  const explicit = readArg("--git");
  if (explicit) return explicit;
  if (!spawnSync("git", ["--version"], { stdio: "ignore" }).error) return "git";
  // one level above agent\: <ZCode-CLI-Portable>\git\cmd\git.exe
  const portable = resolve(dirname(fileURLToPath(import.meta.url)), "..", "git", "cmd", "git.exe");
  return existsSync(portable) ? portable : "git";
}

function gitRun(gitArgs) {
  git ??= resolveGit();
  return spawnSync(git, ["-C", REPO, ...gitArgs], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// Like gitRun, but gives up after timeoutMs. git is then killed together with its helper
// processes (git-remote-https and the like): killed alone, it leaves them waiting on the network.
function gitRunWithTimeout(gitArgs, timeoutMs) {
  return new Promise((resolvePromise) => {
    git ??= resolveGit();
    const child = spawn(git, ["-C", REPO, ...gitArgs], { stdio: ["ignore", "pipe", "pipe"] });
    const result = { status: null, stdout: "", stderr: "", timedOut: false };
    child.stdout?.setEncoding("utf8").on("data", (chunk) => (result.stdout += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk) => (result.stderr += chunk));
    const timer = setTimeout(() => {
      result.timedOut = true;
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      result.error = error;
      resolvePromise(result);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      result.status = status;
      resolvePromise(result);
    });
  });
}

function writeStamp(file) {
  try {
    writeFileSync(file, String(Date.now()));
  } catch {
    // best effort only
  }
}

async function isFresh(file, maxAgeMs) {
  try {
    const s = await stat(file);
    return Date.now() - s.mtimeMs < maxAgeMs;
  } catch {
    return false;
  }
}

// Resolves with the trimmed answer, or with "" when stdin closes before there is one.
function ask(question) {
  return new Promise((resolvePromise) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    let settled = false;
    const answer = (value) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolvePromise(value.trim().toLowerCase());
    };
    rl.on("close", () => answer(""));
    rl.question(question, answer);
  });
}

const say = (text = "") => console.error(text);

if (!readArg("--repo") || !readArg("--install-dir")) {
  say("check-update: --repo and --install-dir are required");
  process.exit(0); // never block the launcher on argument errors
}

if ((await isFresh(STAMP, DAY_MS)) && !FLAG_FORCE) process.exit(0);
if ((await isFresh(FAILED_STAMP, RETRY_MS)) && !FLAG_FORCE) process.exit(0);

const fetch = await gitRunWithTimeout(["fetch", "origin", "main"], FETCH_TIMEOUT_MS);
if (fetch.status !== 0) {
  // Offline, no remote or no git: stay quiet. The stamp skips the wait on the launches of the next hour.
  writeStamp(FAILED_STAMP);
  if (FLAG_FORCE) {
    say(`check-update: git fetch failed (${fetch.timedOut ? `no answer in ${FETCH_TIMEOUT_MS / 1000} s` : fetch.error?.code ?? `exit code ${fetch.status ?? "none"}`})`);
  }
  process.exit(0);
}

const head = gitRun(["rev-parse", "HEAD"]).stdout?.trim();
const origin = gitRun(["rev-parse", "origin/main"]).stdout?.trim();
if (!head || !origin || head === origin) {
  writeStamp(STAMP);
  process.exit(0);
}

const count = gitRun(["rev-list", "--count", `${head}..${origin}`]).stdout?.trim() ?? "?";
const log = gitRun(["log", "--oneline", "--max-count=5", `${head}..${origin}`]).stdout?.trim() ?? "";

// Nobody can answer here (zcode -p, app-server, closed stdin): one line instead of a question.
if (!FLAG_YES && !process.stdin.isTTY) {
  say(`Доступно обновление ZCode CLI: ${count} новых коммитов. Запусти zcode в терминале, чтобы установить.`);
  writeStamp(STAMP);
  process.exit(0);
}

say("");
say(`=== Доступно обновление ZCode CLI: ${count} новых коммитов ===`);
for (const line of log.split("\n")) if (line) say("  " + line);
if (count === "?" || Number(count) > 5) say("  ...");

let accept = FLAG_YES;
if (!accept) {
  const answer = await ask("Установить сейчас? [y/N] ");
  accept = answer === "y" || answer === "д" || answer === "yes";
}

if (accept) {
  const pull = await gitRunWithTimeout(["pull", "--ff-only", "origin", "main"], PULL_TIMEOUT_MS);
  if (pull.status !== 0) {
    const reason = pull.timedOut
      ? `no answer in ${PULL_TIMEOUT_MS / 60000} minutes`
      : pull.stderr?.trim().split("\n").pop();
    say(`Не удалось обновить исходники (git pull${reason ? `: ${reason}` : ""}). Установку пропущено, попробуй позже.`);
    writeStamp(STAMP);
    process.exit(0);
  }
  say("Исходники обновлены, собираю и устанавливаю (несколько минут)...");
  const install = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(REPO, "scripts/install.ps1"),
      "-InstallDir",
      INSTALL_DIR,
    ],
    { stdio: "inherit" },
  );
  if (install.status === 0) {
    say("Обновление установлено. Запускаю новую версию...");
  } else {
    say("Установка не удалась (код " + install.status + "). Проверь вывод выше.");
  }
} else {
  say("Хорошо, обновление отложено (спрошу не раньше чем через сутки).");
}
writeStamp(STAMP);
process.exit(0);
