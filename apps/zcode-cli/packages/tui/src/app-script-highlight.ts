import { bundledLanguages, type BundledLanguage, type BundledTheme } from "shiki";
import { getTreeSitterClient } from "@mbears/opentui-core";
import type { TreeSitterClient } from "@mbears/opentui-core";
import {
  isShikiLanguageLoaded,
  loadShikiLanguage,
  loadedHighlighter,
  type ShikiHighlighter,
} from "./app-shiki-highlighter.js";
import { LSFUSION_LANGUAGE, LSFUSION_LANGUAGE_NAMES } from "./app-lsfusion-grammar.js";
import { SHIKI_FILETYPE_NAMES, SHIKI_LANGUAGE_NAMES } from "./app-shiki-languages.js";

// Local patch (script-highlight): OpenTUI ships tree-sitter grammars for four
// languages only (javascript, typescript, markdown, zig), so every other fenced
// block was plain text. Shiki is bundled anyway for the file diffs and knows
// about 250 languages. It fills the gap and reports Textmate scopes, which are
// reduced here to the scope names the TUI theme styles, so a bash block takes
// the same colors as a javascript one.

/** A styled range of a script, as character offsets into the whole text. */
export type ScriptToken = {
  end: number;
  scope: string;
  start: number;
};

type ScriptHighlight = [number, number, string];
type ScopeExplanation = { content?: string; scopes: Array<{ scopeName: string }> };
type ExplainedToken = { content: string; explanation?: ScopeExplanation[]; offset: number };

// The filetypes the bundled tree-sitter grammars cover keep their own highlighting.
const TREE_SITTER_FILETYPES = new Set(["javascript", "typescript", "markdown", "zig"]);
// Local patch (lsfusion-highlight): the grammar of lsFusion is carried along.
const SHIKI_LANGUAGE_KEYS = new Set([...Object.keys(bundledLanguages), LSFUSION_LANGUAGE]);
// Scopes do not depend on the theme; Shiki only needs one to tokenize.
const SHIKI_THEME = "github-light";
const MAX_HIGHLIGHTED_CHARACTERS = 40_000;
const TOKEN_CACHE_LIMIT = 400;
// Blocks longer than this are tokenized once they stop changing, see tokenizeScript.
const HEAVY_CHARACTERS = 10_000;
const HEAVY_SETTLE_MS = 150;
const NAME_IS_TYPE = new Set(["class", "enum", "interface", "namespace", "package", "struct", "tag", "trait", "type"]);
const DECLARATION_WORDS = new Set(["alias", "annotation", "class", "def", "enum", "function", "interface", "type"]);
// Languages whose plain storage.type scope is const, let, struct and the like.
const DECLARATION_ONLY_TYPES = new Set([
  "javascript",
  "javascript.jsx",
  "js",
  "jsx",
  "rust",
  "svelte",
  "ts",
  "tsx",
  "typescript",
  "typescript.tsx",
  "vue",
]);

const tokenCache = new Map<string, ScriptToken[]>();
const pendingTokens = new Map<string, Promise<ScriptToken[]>>();
// The long block of a language that is waiting to stop changing, by language.
const heavyRequests = new Map<
  string,
  { reject: (reason: unknown) => void; resolve: (tokens: ScriptToken[]) => void }
>();
let sharedClient: TreeSitterClient | undefined;

/** The Shiki language for a fence name or filetype, or undefined when Shiki does not know it. */
export function shikiLanguageId(name: string): string | undefined {
  const normalized = name.trim().toLowerCase().replace(/^\./u, "");
  if (!normalized) return undefined;
  const id =
    LSFUSION_LANGUAGE_NAMES[normalized] ??
    SHIKI_FILETYPE_NAMES[normalized] ??
    SHIKI_LANGUAGE_NAMES[normalized] ??
    normalized;
  return SHIKI_LANGUAGE_KEYS.has(id) ? id : undefined;
}

/** The theme scope of a Textmate scope list, judged by its most specific entry. */
export function themeScopeOf(scopeNames: readonly string[]): string | undefined {
  let scope: string | undefined;
  for (const name of scopeNames) {
    if (!/^(?:source|meta|text)\./u.test(name)) scope = name;
  }
  if (!scope) return undefined;
  const [head, second, third] = scope.split(".");
  switch (head) {
    case "comment":
      return "comment";
    case "string":
      return "string";
    case "constant":
      if (second === "language") return "boolean";
      if (second === "numeric") return "number";
      return second === "character" ? "string" : undefined;
    case "keyword":
      return second === "operator" ? undefined : "keyword";
    case "storage":
      if (second === "type") {
        // Words that declare something read as keywords, type names as types.
        // The scope ends with the language, sometimes with two of them ("js.jsx").
        const words = scope.split(".").slice(2, -1);
        if (words.some((word) => DECLARATION_WORDS.has(word))) return "keyword";
        if (words.every((word) => DECLARATION_ONLY_TYPES.has(word))) {
          if (DECLARATION_ONLY_TYPES.has(scope.split(".").at(-1) ?? "")) return "keyword";
        }
        return "type";
      }
      return second === "modifier" ? "keyword" : undefined;
    case "support":
      if (second === "function") return "function";
      return second === "class" || second === "type" ? "type" : undefined;
    case "entity":
      if (second === "name") {
        if (third === "command" || third === "function") return "function";
        if (third !== undefined && NAME_IS_TYPE.has(third)) return "type";
      }
      return second === "other" && third === "inherited-class" ? "type" : undefined;
    case "punctuation":
      if (second === "definition" && third === "comment") return "comment";
      if (second === "definition" && third === "string") return "string";
      return undefined;
    case "invalid":
      return "error";
    case "markup":
      if (second === "inserted") return "diff.plus";
      if (second === "deleted") return "diff.minus";
      if (second === "changed") return "diff.delta";
      return undefined;
    default:
      return undefined;
  }
}

/** The styled ranges of a script once its language is loaded; undefined before that. */
export function tokenizeScriptSync(code: string, languageId: string): ScriptToken[] | undefined {
  const key = `${languageId}\0${code}`;
  const cached = tokenCache.get(key);
  if (cached) return cached;
  const highlighter = loadedHighlighter();
  if (!highlighter || !isShikiLanguageLoaded(languageId)) return undefined;
  const tokens = tokensFromShiki(highlighter, code, languageId);
  rememberTokens(key, tokens);
  return tokens;
}

/**
 * The styled ranges of a script; loads the language on first use.
 *
 * A long block is tokenized once it stops changing: OpenTUI asks again for every
 * change while a block streams in, and tokenizing a long block takes tens of
 * milliseconds on the thread of the terminal. A request that is overtaken by a
 * newer one for the same language gets no ranges, which shows the plain text.
 */
export function tokenizeScript(code: string, languageId: string): Promise<ScriptToken[]> {
  const key = `${languageId}\0${code}`;
  const cached = tokenCache.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = pendingTokens.get(key);
  if (pending) return pending;
  if (code.length <= HEAVY_CHARACTERS) return startTokenization(code, languageId, key);

  const request = defer<ScriptToken[]>();
  heavyRequests.get(languageId)?.resolve([]);
  heavyRequests.set(languageId, request);
  setTimeout(() => {
    // Overtaken meanwhile: it has got its empty answer already.
    if (heavyRequests.get(languageId) !== request) return;
    heavyRequests.delete(languageId);
    startTokenization(code, languageId, key).then(request.resolve, request.reject);
  }, HEAVY_SETTLE_MS);
  return request.promise;
}

function defer<T>(): { promise: Promise<T>; reject: (reason: unknown) => void; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function startTokenization(code: string, languageId: string, key: string): Promise<ScriptToken[]> {
  const task = tokenize(code, languageId, key).finally(() => {
    pendingTokens.delete(key);
  });
  pendingTokens.set(key, task);
  return task;
}

async function tokenize(code: string, languageId: string, key: string): Promise<ScriptToken[]> {
  await loadShikiLanguage(languageId as BundledLanguage);
  const highlighter = loadedHighlighter();
  if (!highlighter) return [];
  const tokens = tokensFromShiki(highlighter, code, languageId);
  rememberTokens(key, tokens);
  return tokens;
}

/**
 * The tree-sitter client of the markdown element with the Shiki fallback: a
 * filetype without a bundled grammar is highlighted by Shiki instead.
 */
export function scriptHighlightClient(): TreeSitterClient {
  // OpenTUI disposes its tree-sitter client together with the renderer and
  // creates a new one on the next request, so the base client is looked up on
  // every use instead of being held.
  sharedClient ??= new Proxy({} as TreeSitterClient, {
    get(_target, property) {
      const base = getTreeSitterClient();
      if (property === "highlightOnce") {
        return (content: string, filetype: string) => highlightWithShiki(base, content, filetype);
      }
      const value = Reflect.get(base, property, base);
      return typeof value === "function" ? value.bind(base) : value;
    },
  });
  return sharedClient;
}

async function highlightWithShiki(
  base: TreeSitterClient,
  content: string,
  filetype: string,
): ReturnType<TreeSitterClient["highlightOnce"]> {
  const language = TREE_SITTER_FILETYPES.has(filetype) ? undefined : shikiLanguageId(filetype);
  if (!language || content.length > MAX_HIGHLIGHTED_CHARACTERS) {
    return base.highlightOnce(content, filetype);
  }
  try {
    const highlights = (await tokenizeScript(content, language)).map(
      (token): ScriptHighlight => [token.start, token.end, token.scope],
    );
    return { highlights };
  } catch {
    return base.highlightOnce(content, filetype);
  }
}

export function resetScriptHighlightForTest(): void {
  tokenCache.clear();
  pendingTokens.clear();
  for (const request of heavyRequests.values()) request.resolve([]);
  heavyRequests.clear();
  sharedClient = undefined;
}

function tokensFromShiki(highlighter: ShikiHighlighter, code: string, languageId: string): ScriptToken[] {
  const tokens: ScriptToken[] = [];
  const { tokens: tokenLines } = highlighter.codeToTokens(code, {
    // Scope names are all that is needed, and three times faster than the full explanation.
    includeExplanation: "scopeName",
    lang: languageId as BundledLanguage,
    theme: SHIKI_THEME as BundledTheme,
  });
  tokenLines.forEach((line) => {
    for (const token of line) {
      const explained = token as ExplainedToken;
      const explanation = explained.explanation;
      // A token may consist of parts with different scopes, e.g. "$" and "x".
      const parts: ScopeExplanation[] =
        explanation && explanation.length > 0 ? explanation : [{ content: token.content, scopes: [] }];
      // Shiki counts the offsets from the start of the whole code.
      let offset = token.offset;
      for (const part of parts) {
        const content = part.content ?? token.content;
        const scope = themeScopeOf(part.scopes.map((entry) => entry.scopeName));
        if (scope && content.length > 0) {
          tokens.push({ end: offset + content.length, scope, start: offset });
        }
        offset += content.length;
      }
    }
  });
  // The parts of one token share a scope, e.g. the quotes and the text of a string.
  const merged: ScriptToken[] = [];
  for (const token of tokens) {
    const previous = merged.at(-1);
    if (previous && previous.scope === token.scope && previous.end === token.start) {
      previous.end = token.end;
    } else {
      merged.push(token);
    }
  }
  return merged;
}

function rememberTokens(key: string, tokens: ScriptToken[]): void {
  tokenCache.set(key, tokens);
  if (tokenCache.size > TOKEN_CACHE_LIMIT) {
    const oldest = tokenCache.keys().next();
    if (!oldest.done) tokenCache.delete(oldest.value);
  }
}
