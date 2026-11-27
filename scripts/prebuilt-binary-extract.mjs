import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { runCommand } from "./spawn-command.mjs";

// Bugfix: Windows GNU tar（Git Bash）会把绝对路径里的盘符冒号（C:）当成远程主机名，
// 反斜杠路径也会被 MSYS 参数转换破坏。tar 参数统一转正斜杠，归档路径优先改用
// 相对 cwd 的形式避开盘符冒号；对 bsdtar 与 Linux/macOS CI 无影响。
function toTarPosixPath(pathValue) {
  return pathValue.replaceAll("\\", "/");
}

function resolveTarArchiveArg(archivePath, cwd) {
  if (process.platform === "win32") {
    try {
      const relativeArchivePath = relative(cwd, archivePath);
      if (relativeArchivePath && !relativeArchivePath.startsWith("..")) {
        return toTarPosixPath(relativeArchivePath);
      }
    } catch {
      // 跨盘符时 relative 会抛错，退回正斜杠绝对路径（bsdtar 可用）。
    }
  }

  return toTarPosixPath(archivePath);
}

// Windows 10 1803+ / Server 2019+ 自带 libarchive 版 tar.exe（bsdtar），可以直接读 zip。
const resolveWindowsSystemTar = () => {
  const systemRoot = process.env.SystemRoot ?? process.env.windir;
  if (!systemRoot) {
    throw new Error("Cannot locate the Windows system tar.exe: SystemRoot is not set");
  }
  return join(systemRoot, "System32", "tar.exe");
};

// bsdtar 按系统 ANSI 代码页解析 argv，代码页之外的字符会变成 "?"（例如非中文系统上的中文用户目录）。
// 归档经继承的文件描述符走 stdin，解包目录经 cwd（Node 用宽字符 API 传递），argv 里不出现任何路径。
function extractZipWithWindowsSystemTar(archivePath, extractDir) {
  const archiveFd = openSync(archivePath, "r");
  try {
    runCommand(resolveWindowsSystemTar(), ["-xf", "-"], {
      cwd: extractDir,
      stdio: [archiveFd, "inherit", "inherit"],
    });
  } finally {
    closeSync(archiveFd);
  }
}

export function extractPrebuiltArchive({ archivePath, archiveExt, extractDir, cwd }) {
  mkdirSync(extractDir, { recursive: true });
  if (archiveExt === "zip") {
    if (process.platform === "win32") {
      // Bugfix: 不能用 powershell.exe 的 Expand-Archive。GitHub Actions 的 windows runner 以 pwsh 执行 step，
      // Node 继承的 PSModulePath 以 PowerShell 7 的模块目录开头，而 Windows PowerShell 5.1 按该顺序解析
      // cmdlet，会加载只兼容 PowerShell 7 的 Microsoft.PowerShell.Archive，解包时报
      // "Cannot find an overload for ExtractToDirectory and the argument count: 3"。
      // 必须按绝对路径调用系统 tar.exe：不经过模块解析，也不会被 PATH 里的 GNU tar（Git Bash，不认 zip）截获。
      extractZipWithWindowsSystemTar(archivePath, extractDir);
      return;
    }

    runCommand("unzip", ["-q", archivePath, "-d", extractDir], { cwd });
    return;
  }

  const tarCwd = cwd ?? process.cwd();
  runCommand(
    "tar",
    ["-xzf", resolveTarArchiveArg(archivePath, tarCwd), "-C", toTarPosixPath(extractDir)],
    { cwd: tarCwd },
  );
}

export function findPrebuiltBinary(rootDir, binaryName) {
  const entries = readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = findPrebuiltBinary(fullPath, binaryName);
      if (nested) return nested;
      continue;
    }

    if (entry.isFile() && entry.name === binaryName) return fullPath;
  }

  return undefined;
}

export function assertPrebuiltArchiveSha256(expectedSha256) {
  const normalizedExpectedSha256 = String(expectedSha256 ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalizedExpectedSha256)) {
    throw new Error("missing prebuilt archive SHA-256");
  }
  return normalizedExpectedSha256;
}

export function verifyPrebuiltArchiveSha256(archivePath, expectedSha256) {
  const normalizedExpectedSha256 = assertPrebuiltArchiveSha256(expectedSha256);
  const actualSha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  if (actualSha256 !== normalizedExpectedSha256) {
    throw new Error(
      `Archive SHA-256 mismatch: expected ${normalizedExpectedSha256}, received ${actualSha256}`,
    );
  }
}

export async function extractPrebuiltBinary({
  archiveExt,
  archivePath,
  archiveSha256,
  binaryName,
  binaryPath,
  cwd,
  targetPlatform,
  validateBinary,
}) {
  verifyPrebuiltArchiveSha256(archivePath, archiveSha256);
  mkdirSync(dirname(binaryPath), { recursive: true });
  mkdirSync(tmpdir(), { recursive: true });
  const tempDir = mkdtempSync(join(tmpdir(), "zcode-prebuilt-binary-"));
  const extractDir = join(tempDir, "extract");

  try {
    extractPrebuiltArchive({ archivePath, archiveExt, extractDir, cwd });
    const extractedBinaryPath = findPrebuiltBinary(extractDir, binaryName);
    if (!extractedBinaryPath) {
      throw new Error(`Failed to locate ${binaryName} in extracted archive`);
    }

    // foreign target 不能靠执行目标文件验真，必须在覆盖正式路径前校验临时产物。
    await validateBinary?.(extractedBinaryPath);
    copyFileSync(extractedBinaryPath, binaryPath);
    if (targetPlatform !== "win32") {
      chmodSync(binaryPath, 0o755);
    }
  } finally {
    // Bugfix: Windows 下解压产物可能被杀毒/索引器或尚未退出的解压子进程短暂持有句柄，
    // rmSync 立即删除会 EPERM，且 finally 里抛出的异常会掩盖真正的解压错误。
    // 带重试删除，失败时仅告警，让原始错误正常抛出。
    try {
      rmSync(tempDir, { force: true, recursive: true, maxRetries: 10, retryDelay: 500 });
    } catch (error) {
      console.warn(`[warn] 清理临时目录失败（可忽略）: ${tempDir}`);
      console.warn(`[warn] ${String(error)}`);
    }
  }
}
