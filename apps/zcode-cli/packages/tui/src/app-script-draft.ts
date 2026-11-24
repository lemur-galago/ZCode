import { infoStringToFiletype } from "@mbears/opentui-core";
import { detectScriptLanguage, fencedBlocks } from "./app-script-detect.js";
import {
  shikiLanguageId,
  tokenizeScript,
  tokenizeScriptSync,
  type ScriptToken,
} from "./app-script-highlight.js";

// Local patch (script-highlight): what of a draft is code - its fenced blocks,
// or the whole draft when it is a script - and the styled ranges of that code,
// for the composer and for the user messages of the transcript.

/** A range of a draft that is code in one language, as character offsets into the draft. */
export type ScriptRegion = { end: number; language: string; start: number };

/** The code of a draft: its fenced blocks, or the whole draft when it is a script. */
export type ScriptDraft = {
  fenceMarks: Array<{ end: number; start: number }>;
  regions: ScriptRegion[];
};

/** The styled ranges of a draft; the scope "fence" marks the fence lines. */
export type DraftHighlight = { tokens: ScriptToken[] };

// Longer drafts are only searched for fenced blocks: telling a script from
// prose costs a handful of regular expressions per line, on every keystroke.
const MAX_DETECTED_CHARACTERS = 10_000;
// A longer block is left plain: tokenizing it would cost tens of milliseconds per keystroke.
const MAX_HIGHLIGHTED_REGION_CHARACTERS = 10_000;
const DRAFT_CACHE_LIMIT = 200;

const draftCache = new Map<string, ScriptDraft>();

export function scriptDraft(text: string): ScriptDraft {
  const cached = draftCache.get(text);
  if (cached) return cached;
  let draft: ScriptDraft;
  const blocks = fencedBlocks(text);
  if (blocks.length > 0) {
    draft = {
      fenceMarks: blocks.flatMap((block) => block.marks),
      regions: blocks.flatMap((block): ScriptRegion[] => {
        const filetype = block.info ? (infoStringToFiletype(block.info) ?? block.info) : "";
        const language = shikiLanguageId(filetype);
        const fits = block.end - block.start <= MAX_HIGHLIGHTED_REGION_CHARACTERS;
        return language && fits && block.end > block.start
          ? [{ end: block.end, language, start: block.start }]
          : [];
      }),
    };
  } else {
    const language = text.length <= MAX_DETECTED_CHARACTERS ? detectScriptLanguage(text) : undefined;
    draft = {
      fenceMarks: [],
      regions: language ? [{ end: text.length, language, start: 0 }] : [],
    };
  }
  draftCache.set(text, draft);
  if (draftCache.size > DRAFT_CACHE_LIMIT) {
    const oldest = draftCache.keys().next();
    if (!oldest.done) draftCache.delete(oldest.value);
  }
  return draft;
}

/** The styled ranges of a draft once its languages are loaded; undefined before that. */
export function draftTokensSync(text: string): DraftHighlight | undefined {
  const { regions } = scriptDraft(text);
  const tokens: ScriptToken[][] = [];
  for (const region of regions) {
    const regionTokens = tokenizeScriptSync(text.slice(region.start, region.end), region.language);
    if (!regionTokens) return undefined;
    tokens.push(regionTokens);
  }
  return draftHighlight(text, regions, tokens);
}

/** The styled ranges of a draft; loads the languages on first use. */
export async function draftTokens(text: string): Promise<DraftHighlight> {
  const { regions } = scriptDraft(text);
  const tokens = await Promise.all(
    regions.map((region) => tokenizeScript(text.slice(region.start, region.end), region.language)),
  );
  return draftHighlight(text, regions, tokens);
}

export function resetScriptDraftForTest(): void {
  draftCache.clear();
}

function draftHighlight(text: string, regions: ScriptRegion[], tokens: ScriptToken[][]): DraftHighlight {
  const merged: ScriptToken[] = [];
  regions.forEach((region, index) => {
    for (const token of tokens[index] ?? []) {
      merged.push({ end: token.end + region.start, scope: token.scope, start: token.start + region.start });
    }
  });
  for (const mark of scriptDraft(text).fenceMarks) {
    merged.push({ end: mark.end, scope: "fence", start: mark.start });
  }
  merged.sort((left, right) => left.start - right.start);
  return { tokens: merged };
}
