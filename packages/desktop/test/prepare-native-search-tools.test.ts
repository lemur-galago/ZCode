import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  intranetConfigured: true,
  downloadNativeSearchTools: vi.fn(),
}));

// 用可切换的替身模拟“依赖源已配置 / 未配置时抛错”两种环境；已配置时显式注入中性主机，
// 不依赖仓库默认的内网地址（开源导出里默认地址为空），其余导出保持真实实现。
vi.mock("../../../scripts/intranetDefaults.mjs", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const resolveActual = actual.resolveIntranetDepsBaseUrl as (env?: NodeJS.ProcessEnv) => string;
  return {
    ...actual,
    resolveIntranetDepsBaseUrl: (env?: NodeJS.ProcessEnv) => {
      if (!mocks.intranetConfigured) {
        throw new Error("Configure ZCODE_DEPS_BASE_URL or INTRANET_MACHINE_HOST");
      }
      return resolveActual({ INTRANET_MACHINE_HOST: "intranet-deps.example", ...env });
    },
  };
});

vi.mock("../../../scripts/download-native-search-tools.mjs", () => ({
  downloadNativeSearchTools: mocks.downloadNativeSearchTools,
}));

import {
  NATIVE_SEARCH_DEPENDENCIES_DIR,
  LEGACY_REMOTE_RIPGREP_ARCHIVE_SHA256_BY_TARGET as CONFIG_LEGACY_SHA256,
  LEGACY_REMOTE_RIPGREP_VERSION as CONFIG_LEGACY_VERSION,
  resolveNativeSearchArtifactSource,
  resolveNativeSearchPrebuiltPlan,
} from "../../../scripts/native-search-tools-config.mjs";
import { prepareNativeSearchTools } from "../../../scripts/prepare-native-search-tools.mjs";
import {
  extractPrebuiltBinary,
  verifyPrebuiltArchiveSha256,
} from "../../../scripts/prebuilt-binary-extract.mjs";
import {
  LEGACY_REMOTE_RIPGREP_ARCHIVE_SHA256_BY_TARGET,
  LEGACY_REMOTE_RIPGREP_VERSION,
  resolveRemoteNativeSearchPrebuiltPlan,
} from "../../../scripts/remote-native-search-tools-config.mjs";

type PrebuiltArtifact = {
  toolId: string;
  release: string;
  archiveExt: string;
  archivePath: string;
  archiveSha256: string;
  binaryName: string;
  binaryPath: string;
  downloadUrl?: string;
};
type PrebuiltPlan = { platformKey: string; artifacts: PrebuiltArtifact[] };

const localTargets = [
  ["darwin", "arm64"],
  ["darwin", "x64"],
  ["linux", "arm64"],
  ["linux", "x64"],
  ["win32", "arm64"],
  ["win32", "x64"],
] as const;
const remoteTargets = localTargets.filter(([platform]) => platform !== "win32");

const temporaryDirectories: string[] = [];
async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-prepare-native-search-"));
  temporaryDirectories.push(directory);
  return directory;
}

function readSources(artifact: PrebuiltArtifact): {
  binary: { origin: string; toolId: string };
} {
  return JSON.parse(readFileSync(join(dirname(artifact.binaryPath), "SOURCES.json"), "utf8"));
}

beforeEach(() => {
  mocks.intranetConfigured = true;
  mocks.downloadNativeSearchTools.mockReset();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("native search 归档来源判定", () => {
  it("内网依赖源已配置时判定为 intranet，计划同时带下载地址与同名仓库归档", () => {
    expect(resolveNativeSearchArtifactSource({})).toBe("intranet");
    for (const [platform, arch] of localTargets) {
      const plan = resolveNativeSearchPrebuiltPlan({ platform, arch, env: {} }) as PrebuiltPlan;
      for (const artifact of plan.artifacts) {
        expect(
          artifact.downloadUrl?.endsWith(`/${artifact.archivePath.split(/[\\/]/).pop()}`),
        ).toBe(true);
      }
    }
  });

  it("显式 NATIVE_SEARCH_TOOLS_DOWNLOAD_BASE_URL 在依赖源未配置时仍走 intranet", () => {
    mocks.intranetConfigured = false;
    expect(
      resolveNativeSearchArtifactSource({
        NATIVE_SEARCH_TOOLS_DOWNLOAD_BASE_URL: "https://deps.example.test/native-search-tools",
      }),
    ).toBe("intranet");
  });

  it("显式 NATIVE_SEARCH_TOOLS_ARTIFACT_SOURCE=repository 在依赖源已配置时强制走仓库归档", () => {
    expect(
      resolveNativeSearchArtifactSource({
        NATIVE_SEARCH_TOOLS_ARTIFACT_SOURCE: "repository",
        NATIVE_SEARCH_TOOLS_DOWNLOAD_BASE_URL: "https://deps.example.test/native-search-tools",
      }),
    ).toBe("repository");
    const plan = resolveNativeSearchPrebuiltPlan({
      platform: "linux",
      arch: "x64",
      env: { NATIVE_SEARCH_TOOLS_ARTIFACT_SOURCE: " repository " },
    }) as PrebuiltPlan;
    expect(plan.artifacts.length).toBeGreaterThan(0);
    expect(plan.artifacts.every((artifact) => artifact.downloadUrl === undefined)).toBe(true);
  });

  it("显式 NATIVE_SEARCH_TOOLS_ARTIFACT_SOURCE=intranet 在依赖源未配置时仍走 intranet", () => {
    mocks.intranetConfigured = false;
    expect(
      resolveNativeSearchArtifactSource({ NATIVE_SEARCH_TOOLS_ARTIFACT_SOURCE: "intranet" }),
    ).toBe("intranet");
  });

  it("NATIVE_SEARCH_TOOLS_ARTIFACT_SOURCE 取值非法时直接失败，不回落到推断来源", () => {
    expect(() =>
      resolveNativeSearchArtifactSource({ NATIVE_SEARCH_TOOLS_ARTIFACT_SOURCE: "repo" }),
    ).toThrow(/Unsupported NATIVE_SEARCH_TOOLS_ARTIFACT_SOURCE: repo/);
  });

  it("依赖源未配置时判定为 repository，计划不再解析下载地址", () => {
    mocks.intranetConfigured = false;
    expect(resolveNativeSearchArtifactSource({})).toBe("repository");
    const plan = resolveNativeSearchPrebuiltPlan({
      platform: "linux",
      arch: "x64",
      env: {},
    }) as PrebuiltPlan;
    expect(plan.artifacts.every((artifact) => artifact.downloadUrl === undefined)).toBe(true);
  });

  it("本地与远端计划引用的仓库归档全部存在且摘要与固定值一致", () => {
    const plans = [
      ...localTargets.map(([platform, arch]) =>
        resolveNativeSearchPrebuiltPlan({ platform, arch }),
      ),
      ...remoteTargets.map(([platform, arch]) =>
        resolveRemoteNativeSearchPrebuiltPlan({ platform, arch }),
      ),
    ] as PrebuiltPlan[];
    for (const plan of plans) {
      for (const artifact of plan.artifacts) {
        expect(artifact.archivePath.startsWith(NATIVE_SEARCH_DEPENDENCIES_DIR)).toBe(true);
        expect(() =>
          verifyPrebuiltArchiveSha256(artifact.archivePath, artifact.archiveSha256),
        ).not.toThrow();
      }
    }
    // legacy rg13 常量只有一个所有者，远端配置只转出。
    expect(LEGACY_REMOTE_RIPGREP_VERSION).toBe(CONFIG_LEGACY_VERSION);
    expect(LEGACY_REMOTE_RIPGREP_ARCHIVE_SHA256_BY_TARGET).toBe(CONFIG_LEGACY_SHA256);
    const darwinRemote = resolveRemoteNativeSearchPrebuiltPlan({
      platform: "darwin",
      arch: "arm64",
    }) as PrebuiltPlan;
    expect(darwinRemote.artifacts.map(({ toolId, release }) => [toolId, release])).toEqual([
      ["ripgrep", CONFIG_LEGACY_VERSION],
    ]);
  });
});

describe("prepareNativeSearchTools", () => {
  it("intranet 来源原样委托既有下载链路，并在工具目录写入 intranet-mirror 声明", async () => {
    const outputDir = join(await createTemporaryDirectory(), "tools");
    const env = { NATIVE_SEARCH_TOOLS_DOWNLOAD_BASE_URL: "https://deps.example.test/native" };
    mocks.downloadNativeSearchTools.mockImplementation(async (options) => {
      const plan = resolveNativeSearchPrebuiltPlan(options) as PrebuiltPlan;
      for (const artifact of plan.artifacts) {
        mkdirSync(dirname(artifact.binaryPath), { recursive: true });
        writeFileSync(artifact.binaryPath, `${artifact.toolId}-downloaded`);
      }
      return plan;
    });

    const plan = (await prepareNativeSearchTools({
      platform: "linux",
      arch: "x64",
      outputDir,
      env,
    })) as PrebuiltPlan;

    expect(mocks.downloadNativeSearchTools).toHaveBeenCalledTimes(1);
    expect(mocks.downloadNativeSearchTools).toHaveBeenCalledWith({
      platform: "linux",
      arch: "x64",
      outputDir,
      env,
      prebuiltPlan: undefined,
    });
    for (const artifact of plan.artifacts) {
      expect(existsSync(join(dirname(artifact.binaryPath), "THIRD-PARTY-NOTICES.txt"))).toBe(true);
      expect(readSources(artifact).binary).toMatchObject({
        origin: "intranet-mirror",
        toolId: artifact.toolId,
      });
    }
  });

  it("repository 来源解包仓库归档，不触发下载；缓存命中时跳过解包但刷新声明", async () => {
    mocks.intranetConfigured = false;
    const outputDir = join(await createTemporaryDirectory(), "tools");

    const plan = (await prepareNativeSearchTools({
      platform: "linux",
      arch: "x64",
      outputDir,
      env: {},
    })) as PrebuiltPlan;

    expect(mocks.downloadNativeSearchTools).not.toHaveBeenCalled();
    expect(plan.artifacts.map(({ toolId }) => toolId)).toEqual(["bfs", "ugrep", "ripgrep"]);
    for (const artifact of plan.artifacts) {
      expect(existsSync(artifact.binaryPath)).toBe(true);
      expect(readSources(artifact).binary.origin).toBe("repository-archive");
      rmSync(join(dirname(artifact.binaryPath), "THIRD-PARTY-NOTICES.txt"));
    }

    const binaryBeforeCacheHit = readFileSync(plan.artifacts[0].binaryPath);
    await prepareNativeSearchTools({ platform: "linux", arch: "x64", outputDir, env: {} });
    expect(readFileSync(plan.artifacts[0].binaryPath)).toEqual(binaryBeforeCacheHit);
    for (const artifact of plan.artifacts) {
      expect(existsSync(join(dirname(artifact.binaryPath), "THIRD-PARTY-NOTICES.txt"))).toBe(true);
    }
  });

  it("依赖源已配置但显式选择 repository 时，返回的计划不带下载地址且不触发下载", async () => {
    const outputDir = join(await createTemporaryDirectory(), "tools");

    const plan = (await prepareNativeSearchTools({
      platform: "linux",
      arch: "x64",
      outputDir,
      env: { NATIVE_SEARCH_TOOLS_ARTIFACT_SOURCE: "repository" },
    })) as PrebuiltPlan;

    expect(mocks.downloadNativeSearchTools).not.toHaveBeenCalled();
    expect(plan.artifacts.length).toBeGreaterThan(0);
    for (const artifact of plan.artifacts) {
      expect(artifact.downloadUrl).toBeUndefined();
      expect(readSources(artifact).binary.origin).toBe("repository-archive");
    }
  });

  it("仓库归档被改动时在替换任何产物前失败", async () => {
    const root = await createTemporaryDirectory();
    const dependenciesDir = join(root, "dependencies");
    cpSync(NATIVE_SEARCH_DEPENDENCIES_DIR, dependenciesDir, { recursive: true });
    const plan = resolveNativeSearchPrebuiltPlan({
      platform: "linux",
      arch: "x64",
      outputDir: join(root, "tools"),
      dependenciesDir,
    }) as PrebuiltPlan;
    writeFileSync(plan.artifacts[1].archivePath, "tampered");

    await expect(
      prepareNativeSearchTools({ prebuiltPlan: plan, source: "repository" }),
    ).rejects.toThrow(/Invalid local native search archive/u);
    expect(plan.artifacts.some((artifact) => existsSync(artifact.binaryPath))).toBe(false);
  });
});

// GitHub Actions 的 windows runner 用 pwsh（PowerShell 7）执行 step，Node 因此继承以 PowerShell 7 模块目录
// 开头的 PSModulePath；Windows PowerShell 5.1 按这个顺序解析 Expand-Archive，会加载只兼容 PowerShell 7 的
// Microsoft.PowerShell.Archive。下面用同构的替身模块占住同一个解析位置，约束 zip 解包不依赖它。
const incompatibleArchiveModuleManifest = `@{
  RootModule = 'Microsoft.PowerShell.Archive.psm1'
  ModuleVersion = '99.0.0'
  GUID = '4f2a5e0b-7c3d-4b1e-9a68-0d5c7e2f1b34'
  FunctionsToExport = @('Expand-Archive')
  CmdletsToExport = @()
  PowerShellVersion = '5.1'
}
`;
const incompatibleArchiveModule = `function Expand-Archive {
  throw "incompatible Microsoft.PowerShell.Archive resolved from PSModulePath"
}
`;

describe.skipIf(process.platform !== "win32")("Windows 宿主机解包 zip 归档", () => {
  it("PSModulePath 首位是只兼容 PowerShell 7 的 Microsoft.PowerShell.Archive 时仍能解包", async () => {
    mocks.intranetConfigured = false;
    const root = await createTemporaryDirectory();
    const moduleDirectory = join(root, "pwsh-modules", "Microsoft.PowerShell.Archive");
    mkdirSync(moduleDirectory, { recursive: true });
    writeFileSync(
      join(moduleDirectory, "Microsoft.PowerShell.Archive.psd1"),
      incompatibleArchiveModuleManifest,
    );
    writeFileSync(
      join(moduleDirectory, "Microsoft.PowerShell.Archive.psm1"),
      incompatibleArchiveModule,
    );
    vi.stubEnv("PSModulePath", join(root, "pwsh-modules"));

    const plan = (await prepareNativeSearchTools({
      platform: "win32",
      arch: "x64",
      outputDir: join(root, "tools"),
      env: {},
    })) as PrebuiltPlan;

    expect(plan.artifacts.map(({ toolId }) => toolId)).toEqual(["ugrep", "ripgrep"]);
    for (const artifact of plan.artifacts) {
      expect(existsSync(artifact.binaryPath)).toBe(true);
      expect(readSources(artifact).binary.origin).toBe("repository-archive");
    }
  });

  it("归档路径与临时目录含系统 ANSI 代码页之外的字符时仍能解包", async () => {
    // 中文与亚美尼亚文无法同时落进任何系统 ANSI 代码页，经 argv 传给原生程序的路径必然失真。
    const root = await createTemporaryDirectory();
    const nonAnsiDirectory = join(root, "归档 Հայերեն");
    mkdirSync(nonAnsiDirectory, { recursive: true });
    const plan = resolveNativeSearchPrebuiltPlan({
      platform: "win32",
      arch: "x64",
      outputDir: join(root, "tools"),
      env: {},
    }) as PrebuiltPlan;
    const artifact = plan.artifacts.find(({ toolId }) => toolId === "ugrep") as PrebuiltArtifact;
    const archivePath = join(nonAnsiDirectory, "ugrep 归档.zip");
    cpSync(artifact.archivePath, archivePath);
    vi.stubEnv("TEMP", nonAnsiDirectory);
    vi.stubEnv("TMP", nonAnsiDirectory);
    expect(tmpdir()).toBe(nonAnsiDirectory);

    const binaryPath = join(nonAnsiDirectory, "工具", "ugrep.exe");
    await extractPrebuiltBinary({
      archiveExt: artifact.archiveExt,
      archivePath,
      archiveSha256: artifact.archiveSha256,
      binaryName: artifact.binaryName,
      binaryPath,
      targetPlatform: "win32",
    });

    expect(readFileSync(binaryPath).length).toBeGreaterThan(0);
  });
});
