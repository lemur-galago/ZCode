#!/usr/bin/env node
// Once-per-day self-update check for the fork source checkout.
// Usage:
//   node check-update.mjs --repo <path-to-source-repo> --install-dir <zcode-install-root> [--git <git.exe>] [--yes] [--force]
// Behavior:
//   - skipped when .update-check-stamp in the install root is younger than 24 hours (--force overrides)
//   - git fetch origin main; on network failure exits silently (never blocks launching)
//   - when origin/main is ahead: shows the new commits (Russian) and asks "Install now? [Y/n]"
//   - on accept: git pull --ff-only, then runs scripts/install.ps1 from the source repo
import { spawnSync } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
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
const DAY_MS = 24 * 60 * 60 * 1000;

// git: explicit --git > portable MinGit next to this script > system git
function resolveGit() {
  const explicit = readArg("--git");
  if (explicit) return explicit;
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const portable = resolve(scriptDir, "..", "..", "git", "cmd", "git.exe");
  try {
    return statSync(portable) ? portable : "git";
  } catch {
    return "git";
  }
}

const git = resolveGit();

function gitRun(gitArgs, opts = {}) {
  return spawnSync(git, ["-C", REPO, ...gitArgs], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", opts.inherit ? "inherit" : "pipe"],
    ...opts.extra,
  });
}

function touchStamp() {
  try {
    writeFileSync(STAMP, String(Date.now()));
  } catch {
    // best effort only
  }
}

async function stampIsFresh() {
  try {
    const s = await stat(STAMP);
    return Date.now() - s.mtimeMs < DAY_MS;
  } catch {
    return false;
  }
}

async function ask(question) {
  return new Promise((resolvePromise) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolvePromise(answer.trim().toLowerCase());
    });
  });
}

if (!REPO || !INSTALL_DIR) {
  console.error("check-update: --repo and --install-dir are required");
  process.exit(0); // never block the launcher on argument errors
}

if ((await stampIsFresh()) && !FLAG_FORCE) process.exit(0);

const fetch = gitRun(["fetch", "origin", "main"]);
if (fetch.status !== 0) process.exit(0); // offline or no remote: stay quiet

const head = gitRun(["rev-parse", "HEAD"]).stdout?.trim();
const origin = gitRun(["rev-parse", "origin/main"]).stdout?.trim();
if (!head || !origin || head === origin) {
  touchStamp();
  process.exit(0);
}

const count = gitRun(["rev-list", "--count", `${head}..${origin}`]).stdout?.trim() ?? "?";
const log = gitRun(["log", "--oneline", "--max-count=5", `${head}..${origin}`]).stdout?.trim() ?? "";

console.log("");
console.log(`=== Доступно обновление ZCode CLI: ${count} новых коммитов ===`);
for (const line of log.split("\n")) if (line) console.log("  " + line);
if (count === "?" || Number(count) > 5) console.log("  ...");

let accept = true;
if (!FLAG_YES) {
  const answer = await ask("Установить сейчас? [Y/n] ");
  accept = answer === "" || answer === "y" || answer === "д" || answer === "yes";
}

if (accept) {
  const pull = gitRun(["pull", "--ff-only", "origin", "main"]);
  if (pull.status !== 0) {
    console.log("Не удалось обновить исходники (git pull). Установку пропущено, попробуй позже.");
    touchStamp();
    process.exit(0);
  }
  console.log("Исходники обновлены, собираю и устанавливаю (несколько минут)...");
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
    console.log("Обновление установлено. Запускаю новую версию...");
  } else {
    console.log("Установка не удалась (код " + install.status + "). Проверь вывод выше.");
  }
} else {
  console.log("Хорошо, обновление отложено (спрошу не раньше чем через сутки).");
}
touchStamp();
process.exit(0);
