import path from "node:path";
import { bundledLanguages, createHighlighter, type BundledLanguage, type BundledTheme } from "shiki";
import type { TuiThemeMode } from "./theme/index.js";

const SHIKI_DARK_THEME = "github-dark";
const SHIKI_LIGHT_THEME = "github-light";
const SHIKI_THEMES = [SHIKI_DARK_THEME, SHIKI_LIGHT_THEME] as const;
const HIGHLIGHT_TIMEOUT_MS = 2_500;

const LANGUAGE_BY_FILENAME: Record<string, BundledLanguage> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
};

const LANGUAGE_BY_EXTENSION: Record<string, BundledLanguage> = {
  cjs: "javascript",
  cts: "typescript",
  h: "c",
  hpp: "cpp",
  htm: "html",
  mjs: "javascript",
  mts: "typescript",
  psm1: "powershell",
  tsx: "tsx",
  jsx: "jsx",
  swift: "swift",
};

export type ShikiHighlightSegment = {
  color?: string;
  fontStyle?: number;
  text: string;
};

export type ShikiHighlighter = Awaited<ReturnType<typeof createHighlighter>>;

let highlighterPromise: Promise<ShikiHighlighter> | undefined;
let highlighter: ShikiHighlighter | undefined;
const loadedLanguages = new Set<BundledLanguage>();
const highlightCache = new Map<string, ShikiHighlightSegment[][] | undefined>();

export function inferShikiLanguage(filePath: string | undefined): BundledLanguage | undefined {
  if (!filePath) return undefined;
  const basename = path.basename(filePath).toLowerCase();
  const filenameMatch = LANGUAGE_BY_FILENAME[basename];
  if (filenameMatch) return filenameMatch;

  const extension = path.extname(basename).replace(/^\./u, "");
  if (!extension) return undefined;
  const mapped = LANGUAGE_BY_EXTENSION[extension] ?? extension;
  return isBundledLanguage(mapped) ? mapped : undefined;
}

export async function highlightShikiCodeLines(input: {
  filePath: string | undefined;
  lines: string[];
  mode: TuiThemeMode;
}): Promise<ShikiHighlightSegment[][] | undefined> {
  const language = inferShikiLanguage(input.filePath);
  if (!language) return undefined;

  const theme = shikiThemeForMode(input.mode);
  const cacheKey = `${theme}\0${language}\0${input.lines.join("\n")}`;
  if (highlightCache.has(cacheKey)) return highlightCache.get(cacheKey);

  const highlighted = await withTimeout(
    tokenizeLines({
      language,
      lines: input.lines,
      theme,
    }),
    HIGHLIGHT_TIMEOUT_MS,
  );
  highlightCache.set(cacheKey, highlighted);
  return highlighted;
}

export function resetShikiHighlighterForTest(): void {
  highlighterPromise = undefined;
  highlighter = undefined;
  loadedLanguages.clear();
  highlightCache.clear();
}

async function tokenizeLines(input: {
  language: BundledLanguage;
  lines: string[];
  theme: BundledTheme;
}): Promise<ShikiHighlightSegment[][] | undefined> {
  try {
    const highlighter = await loadShikiLanguage(input.language).then(() => loadedHighlighter());
    if (!highlighter) return undefined;

    const result = highlighter.codeToTokens(input.lines.join("\n"), {
      lang: input.language,
      theme: input.theme,
    });
    return padTokenLines(
      result.tokens.map((line) =>
        line.map((token) => ({
          color: token.color,
          fontStyle: token.fontStyle,
          text: token.content,
        })),
      ),
      input.lines.length,
    );
  } catch {
    return undefined;
  }
}

// Local patch (script-highlight): the same highlighter is shared with the
// fenced code blocks and the composer, which also need it synchronously once
// it is up, so the instance is kept besides the promise.
export function getHighlighter(): Promise<ShikiHighlighter> {
  highlighterPromise ??= createHighlighter({
    langs: [],
    themes: [...SHIKI_THEMES],
  }).then((instance) => {
    highlighter = instance;
    return instance;
  });
  return highlighterPromise;
}

/** The highlighter once it is ready; undefined before that. */
export function loadedHighlighter(): ShikiHighlighter | undefined {
  return highlighter;
}

export function isShikiLanguageLoaded(language: string): boolean {
  return loadedLanguages.has(language as BundledLanguage);
}

export async function loadShikiLanguage(language: BundledLanguage): Promise<void> {
  if (loadedLanguages.has(language)) return;
  const instance = await getHighlighter();
  await instance.loadLanguage(language);
  loadedLanguages.add(language);
}

function isBundledLanguage(language: string): language is BundledLanguage {
  return Object.prototype.hasOwnProperty.call(bundledLanguages, language);
}

function shikiThemeForMode(mode: TuiThemeMode): BundledTheme {
  return mode === "light" ? SHIKI_LIGHT_THEME : SHIKI_DARK_THEME;
}

function padTokenLines(
  lines: ShikiHighlightSegment[][],
  expectedLength: number,
): ShikiHighlightSegment[][] {
  if (lines.length >= expectedLength) return lines.slice(0, expectedLength);
  return [...lines, ...Array.from({ length: expectedLength - lines.length }, () => [])];
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
