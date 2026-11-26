#!/usr/bin/env node
// Once-per-day self-update check for the fork source checkout.
// Usage:
//   node check-update.mjs --repo <path-to-source-repo> --install-dir <zcode-install-root> [--git <git.exe>] [--yes] [--force]
// Behavior:
//   - skipped when .update-check-stamp in the install root is younger than 24 hours (--force overrides)
//   - first asks only whether the tip of origin/main has moved (10 seconds): nothing is downloaded
//     while there is nothing new, and a network that does not answer is recognized quickly
//   - a failed attempt (offline) is not tried again for an hour and never blocks launching
//   - when the tip has moved: fetches the new commits (they can be tens of megabytes and a killed
//     fetch keeps nothing, so this step may take minutes), shows them and asks "Установить сейчас? [y/N]";
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
const RETRY_MS = 60 * 60 * 1000; // after a failed attempt: offline must not mean waiting on every launch
const TIP_TIMEOUT_MS = 10000;
// The fetch and the pull download the update: it can be tens of megabytes (the v4.0.0 merge: 15 MB),
// and a killed fetch keeps nothing. The build that follows needs far more from the network anyway.
const FETCH_TIMEOUT_MS = 10 * 60 * 1000;
const PULL_TIMEOUT_MS = 10 * 60 * 1000;
const SLOW_FETCH_NOTICE_MS = 3000; // in a terminal: say what the start is waiting for

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
    let killed = false;
    const timer = setTimeout(() => {
      result.timedOut = true;
      killed = true;
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    }, timeoutMs);
    const done = (status) => {
      clearTimeout(timer);
      result.status = status;
      resolvePromise(result);
    };
    child.on("error", (error) => {
      clearTimeout(timer);
      result.error = error;
      resolvePromise(result);
    });
    // A grandchild that the kill did not reach can keep the pipes open (seen with a hook's child):
    // after the kill the wait ends with git itself, not with its output.
    child.on("exit", (status) => {
      if (killed) done(status);
    });
    child.on("close", (status) => {
      if (!killed) done(status);
    });
  });
}

// Why a git command did not finish, for the diagnostic of --force.
function failureReason(result, timeoutMs) {
  if (result.timedOut) return `no answer in ${timeoutMs / 1000} s`;
  return result.error?.code ?? `exit code ${result.status ?? "none"}`;
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

// Only the tip of origin/main is asked for first: that is fast even when the update is big, and
// a network that does not answer is recognized in the same 10 seconds as before.
const tip = await gitRunWithTimeout(["ls-remote", "--exit-code", "origin", "refs/heads/main"], TIP_TIMEOUT_MS);
const remoteHead = tip.stdout
  .split("\n")
  .find((line) => line.trim().endsWith("\trefs/heads/main"))
  ?.split("\t")[0]
  .trim();
if (!remoteHead) {
  // Offline, no remote or no git: stay quiet. The stamp skips the wait on the launches of the next hour.
  writeStamp(FAILED_STAMP);
  if (FLAG_FORCE) {
    say(`check-update: git ls-remote failed (${tip.status === 0 ? "origin/main is not listed" : failureReason(tip, TIP_TIMEOUT_MS)})`);
  }
  process.exit(0);
}

const head = gitRun(["rev-parse", "HEAD"]).stdout?.trim();
if (!head || head === remoteHead) {
  writeStamp(STAMP);
  process.exit(0);
}

// origin/main has moved: the new commits are needed for the list. That is the download.
const notice = process.stdin.isTTY
  ? setTimeout(() => say("Скачиваю обновление исходников..."), SLOW_FETCH_NOTICE_MS)
  : undefined;
const fetch = await gitRunWithTimeout(["fetch", "origin", "main"], FETCH_TIMEOUT_MS);
clearTimeout(notice);
if (fetch.status !== 0) {
  if (fetch.timedOut) {
    // The link is too slow for this update. Asked again tomorrow: the wait must not come back every hour.
    writeStamp(STAMP);
    say(`Обновление есть, но скачать его за ${FETCH_TIMEOUT_MS / 60000} минут не удалось (медленная сеть). Попробую завтра.`);
  } else {
    // Offline, no remote or no git: stay quiet. The stamp skips the wait on the launches of the next hour.
    writeStamp(FAILED_STAMP);
  }
  if (FLAG_FORCE) {
    say(`check-update: git fetch failed (${failureReason(fetch, FETCH_TIMEOUT_MS)})`);
  }
  process.exit(0);
}

const origin = gitRun(["rev-parse", "origin/main"]).stdout?.trim();
if (!origin || head === origin) {
  writeStamp(STAMP);
  process.exit(0);
}

const count = gitRun(["rev-list", "--count", `${head}..${origin}`]).stdout?.trim() ?? "?";
if (count === "0") {
  // The checkout has commits of its own and lacks none of origin/main: nothing to install.
  writeStamp(STAMP);
  process.exit(0);
}
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
