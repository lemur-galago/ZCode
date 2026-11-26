// Assembles a Windows x64 portable ZCode CLI from a built source tree.
// Usage:
//   node scripts/assemble-portable.mjs [--src <repo>] [--out <dir>] [--install-dir <dir>] [--node <dir>]
// --src          source repo root (default: the repo containing this script)
// --out          output root that will contain ZCode-CLI-Portable (default: <repo>/.build/portable)
// --install-dir  existing install root; runtime/ and git/ are reused from its newest version
//                (default: %LOCALAPPDATA%/Programs/ZCodeCLI)
// --node         Node.js distribution dir used as the portable runtime when no previous install exists
// Writes .build/portable-info.json { dir, versionId } for the installer.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? resolve(args[i + 1]) : fallback;
};
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SRC = readArg("--src", resolve(SCRIPT_DIR, ".."));
const OUT_ROOT = readArg("--out", resolve(SRC, ".build/portable"));
const INSTALL_DIR = readArg(
  "--install-dir",
  resolve(process.env.LOCALAPPDATA ?? process.cwd(), "Programs/ZCodeCLI"),
);
const NODE_DIR = readArg("--node", "");
const PACKAGE_ROOT = resolve(OUT_ROOT, "ZCode-CLI-Portable");

const { collectSeaTuiAssets, seaTuiAssetPrefix } = await import(
  pathToFileURL(resolve(SRC, "apps/zcode-cli/packages/cli/scripts/sea-tui-assets.mjs")).href
);

async function assertDirectory(path, label) {
  const s = await stat(path).catch(() => null);
  if (!s?.isDirectory()) throw new Error(`Missing ${label}: ${path}`);
}
async function pathExists(path) {
  return stat(path).then(() => true, () => false);
}
async function newestVersionDir(probeRelative) {
  const versions = resolve(INSTALL_DIR, "versions");
  const entries = await readdir(versions).catch(() => []);
  entries.sort();
  entries.reverse();
  for (const id of entries) {
    const dir = resolve(versions, id, "ZCode-CLI-Portable");
    if (dir !== PACKAGE_ROOT && (await pathExists(probeRelative(dir)))) return dir;
  }
  return undefined;
}

const runGit = (gitArgs) =>
  execFileSync("git", gitArgs, { cwd: SRC, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const packageJson = JSON.parse(await readFile(resolve(SRC, "package.json"), "utf8"));
// `zcode --version` reports apps/zcode-cli/package.json; the root version is the one of the source release.
const cliVersion = JSON.parse(await readFile(resolve(SRC, "apps/zcode-cli/package.json"), "utf8")).version;
let commit = "unknown";
try {
  commit = runGit(["rev-parse", "--short=7", "HEAD"]).split("\n")[0];
} catch {
  // git may be absent; keep "unknown"
}
const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const versionId = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${commit}`;

await rm(OUT_ROOT, { recursive: true, force: true });
await mkdir(resolve(PACKAGE_ROOT, "agent"), { recursive: true });

const cliDist = resolve(SRC, "apps/zcode-cli/packages/cli/dist");
await assertDirectory(cliDist, "CLI dist (run the build first)");
if (!(await pathExists(resolve(cliDist, "zcode.cjs")))) {
  throw new Error(`Missing CLI bundle: ${resolve(cliDist, "zcode.cjs")}`);
}

await cp(resolve(cliDist, "zcode.cjs"), resolve(PACKAGE_ROOT, "agent/zcode.cjs"));
await cp(resolve(cliDist, "provider"), resolve(PACKAGE_ROOT, "agent/provider"), { recursive: true });
await cp(
  resolve(cliDist, "THIRD-PARTY-NOTICES.md"),
  resolve(PACKAGE_ROOT, "agent/THIRD-PARTY-NOTICES.md"),
).catch(() => {});
await cp(resolve(SCRIPT_DIR, "check-update.mjs"), resolve(PACKAGE_ROOT, "agent/check-update.mjs"));

// TUI runtime closure (win-x64 only) into agent/node_modules, via the repo's own collector.
const stagingDirectory = resolve(OUT_ROOT, "tui-staging");
const { assets, manifest } = await collectSeaTuiAssets({
  root: resolve(SRC, "apps/zcode-cli"),
  stagingDirectory,
  target: "win-x64",
});
for (const file of manifest.files) {
  const destination = resolve(PACKAGE_ROOT, "agent", file.path);
  await mkdir(dirname(destination), { recursive: true });
  await cp(assets[`${seaTuiAssetPrefix}${file.path}`], destination);
}
await rm(stagingDirectory, { recursive: true, force: true });

// playwright-core is a CLI external (browser-use); copy from the cli package's resolution.
const requireFromCli = createRequire(resolve(SRC, "apps/zcode-cli/packages/cli/package.json"));
const playwrightDir = dirname(requireFromCli.resolve("playwright-core/package.json"));
await cp(playwrightDir, resolve(PACKAGE_ROOT, "agent/node_modules/playwright-core"), {
  dereference: true,
  recursive: true,
});

// @napi-rs/keyring is a CLI external as well: the OS credential store behind /login. The collector
// walks `dependencies` only, so the wrapper arrives without its native half, an optional
// dependency, and /login fails with "System credential storage is unavailable". Resolved from the
// wrapper's own folder, the way the wrapper itself does it at runtime.
const keyringNativePackage = "@napi-rs/keyring-win32-x64-msvc";
const keyringDir = dirname(requireFromCli.resolve("@napi-rs/keyring/package.json"));
let keyringNativeDir;
try {
  keyringNativeDir = dirname(
    createRequire(resolve(keyringDir, "package.json")).resolve(`${keyringNativePackage}/package.json`),
  );
} catch {
  throw new Error(`Missing ${keyringNativePackage}: /login cannot reach the OS credential store without it`);
}
await cp(keyringNativeDir, resolve(PACKAGE_ROOT, `agent/node_modules/${keyringNativePackage}`), {
  dereference: true,
  recursive: true,
});

// Runtime: reuse the proven Node runtime from the current install, else use --node.
const reuseRuntime = await newestVersionDir((d) => resolve(d, "runtime/node.exe"));
if (reuseRuntime) {
  await cp(resolve(reuseRuntime, "runtime"), resolve(PACKAGE_ROOT, "runtime"), { recursive: true });
} else if (NODE_DIR) {
  await assertDirectory(NODE_DIR, "node toolchain dir (--node)");
  await cp(NODE_DIR, resolve(PACKAGE_ROOT, "runtime"), { recursive: true });
} else {
  throw new Error("No runtime source: pass --node <dir> or install over an existing ZCodeCLI install");
}

// MinGit: reuse from the current install when there is one. It is optional: git is required for the
// installation anyway, and the update check uses the system git first.
const reuseGit = await newestVersionDir((d) => resolve(d, "git/cmd/git.exe"));
if (reuseGit) {
  await cp(resolve(reuseGit, "git"), resolve(PACKAGE_ROOT, "git"), { recursive: true });
} else {
  console.log("note: no MinGit to reuse from a previous install; the system git is used");
}

// Inner launcher: runs the bundled runtime against the CLI bundle.
// chcp 65001 is REQUIRED: without it the console decodes the TUI's UTF-8
// output as the OEM codepage and every box-drawing glyph turns to mojibake.
// PATH gets the bundled runtime and MinGit so the CLI can spawn git.
// The code page that was active before is restored on exit: the console must not stay changed.
// chcp's line ends with a period in some locales, hence the second delimiter.
await writeFile(
  resolve(PACKAGE_ROOT, "zcode.cmd"),
  [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    'set "OLDCP="',
    "for /f \"tokens=2 delims=:.\" %%C in ('chcp') do set \"OLDCP=%%C\"",
    "chcp 65001 >nul",
    'set "PATH=%~dp0runtime;%~dp0git\\cmd;%PATH%"',
    '"%~dp0runtime\\node.exe" "%~dp0agent\\zcode.cjs" %*',
    'set "RC=%errorlevel%"',
    "if defined OLDCP chcp %OLDCP% >nul",
    "exit /b %RC%",
    "",
  ].join("\r\n"),
  "ascii",
);

await writeFile(
  resolve(PACKAGE_ROOT, "BUILD.json"),
  JSON.stringify(
    {
      repository: "https://github.com/lemur-galago/ZCode",
      commit,
      version: cliVersion,
      sourceVersion: packageJson.version,
      node: process.version,
      target: "win-x64",
      builtAt: now.toISOString(),
      packaging: "Locally built from the fork source; self-updating install (scripts/install.ps1)",
      sourceRepo: SRC,
    },
    null,
    2,
  ),
);

await writeFile(
  resolve(PACKAGE_ROOT, "PATCH-NOTES.txt"),
  [
    `ZCode CLI ${cliVersion} (source ${packageJson.version}) — build ${versionId} of the fork lemur-galago/ZCode.`,
    "All local patches are part of the git history of the fork.",
    "Update: run zcode — the launcher checks the fork once per day and offers to update.",
    "",
  ].join("\r\n"),
  "utf8",
);

await mkdir(resolve(SRC, ".build"), { recursive: true });
await writeFile(
  resolve(SRC, ".build/portable-info.json"),
  JSON.stringify({ dir: PACKAGE_ROOT, versionId }, null, 2),
);

console.log("tui dist files:", (await readdir(resolve(PACKAGE_ROOT, "agent/node_modules/@zcode/tui/dist"))).length);
console.log("check-update present:", await pathExists(resolve(PACKAGE_ROOT, "agent/check-update.mjs")));
console.log(
  "keyring native present:",
  await pathExists(
    resolve(PACKAGE_ROOT, `agent/node_modules/${keyringNativePackage}/keyring.win32-x64-msvc.node`),
  ),
);
console.log("DONE", PACKAGE_ROOT, versionId);
