// Local patch (script-highlight): finds the scripts in a draft - the fenced
// blocks, or the whole draft when it is a script - so the composer and the
// transcript can highlight what the user types or pastes. Pure text handling:
// the names are resolved to Shiki languages by app-script-highlight.ts.

export type FencedBlock = {
  /** Character offset of the first line after the opening fence. */
  start: number;
  /** Character offset of the closing fence, or of the end of the text. */
  end: number;
  /** The words after the opening backticks, e.g. "bash" or "python title=x.py". */
  info: string;
  /** The fence lines themselves, as character ranges. */
  marks: Array<{ start: number; end: number }>;
};

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/u;

/** The fenced code blocks of a text; a block still being typed counts as open. */
export function fencedBlocks(text: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  const lines = text.split("\n");
  let offset = 0;
  let open:
    | { char: string; info: string; length: number; mark: { start: number; end: number }; start: number }
    | undefined;
  for (const line of lines) {
    const match = FENCE_LINE.exec(line);
    const mark = { end: offset + line.length, start: offset };
    if (open) {
      const closes =
        match !== null && match[1][0] === open.char && match[1].length >= open.length && match[2].trim() === "";
      if (closes) {
        blocks.push({ end: mark.start, info: open.info, marks: [open.mark, mark], start: open.start });
        open = undefined;
      }
    } else if (match) {
      open = { char: match[1][0], info: match[2].trim(), length: match[1].length, mark, start: mark.end + 1 };
    }
    offset += line.length + 1;
  }
  if (open) {
    blocks.push({ end: text.length, info: open.info, marks: [open.mark], start: open.start });
  }
  return blocks;
}

type RegexList = RegExp[];
type Signatures = { common: RegexList; strong: RegexList };

// A shell command at the start of a line, with or without a pasted "$ " prompt.
const SHELL_COMMANDS =
  "npm|npx|pnpm|yarn|bun|node|python3?|pip3?|git|docker|docker-compose|sudo|apt|apt-get|curl|wget|mkdir|cp|mv|rm|ls|chmod|chown|tar|unzip|zip|sed|awk|grep|rg|cat|touch|which|brew|systemctl|service|ssh|scp|rsync|kill|ps|head|tail|sleep|printf|ln|date|find|xargs|tee|jq|make|cmake|cargo|go|java|mvn|gradle|kubectl|helm|dotnet|cd|echo|pwd|clear|alias";
const SHELL_COMMAND_LINE = new RegExp(`^(?:\\$\\s+|>\\s+)?(?:${SHELL_COMMANDS})(?:\\s|$|;|&|\\|)`, "u");
// `$var` outside braces: both shells read it the same way.
const SHELL_VARIABLE = /\$(?!env:)[A-Za-z_]\w*/u;
const C_COMMENT = [/^\s*\/\//u, /^\s*\/\*/u, /^\s*\*\//u];

// Each list belongs to one language: `strong` lines occur in that language only,
// `common` lines also in a neighbouring one (shell commands, plain imports).
const SIGNATURES: Record<string, Signatures> = {
  bash: {
    common: [SHELL_COMMAND_LINE, /^\s*#/u],
    strong: [
      /^#!.*\b(?:bash|sh|zsh|dash|ksh)\b/u,
      /^\s*set\s+-[euxo]{1,4}\b/u,
      /^\s*(?:for\s+\S+\s+in\s+.+;\s*do|while\s+.+;\s*do|until\s+.+;\s*do|if\s+.+;\s*then|elif\s+.+;\s*then)\s*$/u,
      /^\s*(?:done|fi|esac|;;)\s*$/u,
      /\$\{[\w#@*?!]+\}|\$\([^)]*\)|\$(?:[0-9]+|[?#@!$*])/u,
      /^\s*[\w-]+\s*\(\s*\)\s*\{/u,
      /^\s*function\s+[\w-]+\s*\(\s*\)/u,
      /[\w-]+\s*\(\s*\)\s*\{/u,
      /^\s*(?:export|unset|readonly|declare\s+-\w)\s+\w+/u,
      /2>&1|>&2|&>>?|\[\s+-[efdnhs]\s|\[\s!?\s-\w+\s/u,
      /\\\s*$/u,
      /^\s*(?:source|\.)\s+[\w./~-]+/u,
      /^\s*(?:alias\s+\w+=|shopt\s|trap\s|umask\s)/u,
      /\|\|\s|&&\s|;\s*do\b|\bthen\b.*\bfi\b/u,
      SHELL_VARIABLE,
    ],
  },
  powershell: {
    common: [SHELL_COMMAND_LINE, /^\s*#/u, /^\s*<#/u],
    strong: [
      /^#!.*\b(?:pwsh|powershell)\b/iu,
      /^\s*param\s*\(/u,
      /\bWrite-(?:Host|Output|Error|Warning|Debug|Verbose)\b/u,
      /\b(?:Get|Set|New|Remove|Test|Select|Import|Export|Invoke|Register|Unregister|Start|Stop|Restart|Update|Copy|Move|Rename|Out|Convert|Join|Split|Resolve|Measure|Wait|ForEach|Where|Group|Sort|Tee|Push|Pop|Enter|Exit|Save|Read|Send|Receive|Publish|Find|Format|Compare|Compress|Expand|Mount)-[A-Z][a-z]+/u,
      /\$(?:env:|PSVersionTable|null|true|false|_|args|input|Matches|this|script:|global:|local:)/u,
      /\[(?:string|int|long|object|bool|boolean|switch|double|decimal|datetime|char|byte|int\[\]|string\[\]|object\[\]|Parameter|Validate\w+|Alias|CmdletBinding)/u,
      /\s-[A-Z][a-zA-Z]+\b/u,
      /^\s*function\s+[\w-]+\s*(?:\(|\{)/u,
      /\|\s*(?:ForEach-Object|Where-Object|Select-Object|Sort-Object|Format-Table|Out-Null|Out-File|Tee-Object)\b/u,
      /-NoProfile|-ExecutionPolicy|-NonInteractive|-LiteralPath/u,
      SHELL_VARIABLE,
    ],
  },
  python: {
    common: [/^\s*import\s+[\w.]+\s*$/u, /^\s*#/u, /:\s*$/u],
    strong: [
      /^#!.*\bpython[\d.]*\b/u,
      /^\s*def\s+\w+\s*\(.*\)\s*(?:->\s*[^:]+)?:\s*$/u,
      /^\s*class\s+\w+(?:\(.*\))?\s*:\s*$/u,
      /^\s*from\s+[\w.]+\s+import\s+\w+/u,
      /^\s*if\s+__name__\s*==/u,
      /^\s*@\w+(?:\.\w+)*\s*$/u,
      /^\s*(?:elif\b.*:\s*$|except\b.*:\s*$|finally:\s*$|with\s+\w+(?:\s*,\s*\w+)*(?:\s+as\s+\w+)+\s*:\s*$)/u,
      /\braise\s+\w+|\byield\b|\blambda\b|\bassert\s|\bnonlocal\s|\bself\./u,
      /\bNone\b|\bprint\(f?["']/u,
    ],
  },
  typescript: {
    common: [/^\s*import\s+[\w./-]+\s*;?\s*$/u, ...C_COMMENT],
    strong: [
      /^\s*import\s+.*\sfrom\s+['"]/u,
      /^\s*export\s+(?:default\b|const\s|let\s|var\s|function\s|class\s|async\s|interface\s|type\s|enum\s)/u,
      /^\s*(?:const|let|var)\s+\w+\s*=\s*(?:require\(|await\b|async\b|\(|\[|\{|new\s)/u,
      /^\s*(?:async\s+)?function\s*\*?\s*\w*\s*\(/u,
      /\bconsole\.(?:log|error|warn|info|debug)\(/u,
      /^\s*(?:interface|type|enum)\s+\w+/u,
      /=>\s*\{?/u,
      /\brequire\(['"]|\bmodule\.exports|\bprocess\.env\.|\bdocument\.|\bwindow\./u,
      /^\s*await\s|\basync\s+\w+\s*=>/u,
    ],
  },
  sql: {
    common: [/^\s*--/u, /;\s*$/u],
    strong: [
      /^\s*(?:SELECT|INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|INDEX|VIEW|DATABASE|FUNCTION|TYPE|EXTENSION)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX|VIEW)\s+IF\s+EXISTS|TRUNCATE|WITH\s+\w+\s+AS)\b/u,
      /^\s*(?:FROM|WHERE|JOIN|LEFT\s+(?:OUTER\s+)?JOIN|RIGHT\s+(?:OUTER\s+)?JOIN|INNER\s+JOIN|FULL\s+(?:OUTER\s+)?JOIN|CROSS\s+JOIN|GROUP\s+BY|ORDER\s+BY|HAVING|UNION(?:\s+ALL)?|VALUES|LIMIT|OFFSET|ON\s+CONFLICT|RETURNING|AND|OR|NOT|EXISTS)\b/u,
      /^\s*select\s+.+\s+from\s+/iu,
      /\b(?:INT|INTEGER|VARCHAR|TEXT|BOOLEAN|TIMESTAMP|PRIMARY\s+KEY|NOT\s+NULL|FOREIGN\s+KEY|REFERENCES)\b/u,
    ],
  },
  go: {
    common: [/^\s*\/\//u],
    strong: [
      /^\s*package\s+\w+\s*$/u,
      /^\s*import\s+\(/u,
      /^\s*func\s+(?:\(\w+\s+\*?\w+\)\s*)?\w+\s*\(/u,
      /:=/u,
      /^\s*(?:defer\s|go\s+\w+\(|type\s+\w+\s+struct|chan\s+[\w<>\s]+)/u,
      /\bfmt\.(?:Print|Sprint|Errorf)/u,
    ],
  },
  rust: {
    common: [/^\s*\/\//u],
    strong: [
      /^\s*fn\s+\w+/u,
      /^\s*(?:use\s+[\w:]+::|let\s+mut\s)/u,
      /^\s*impl\b/u,
      /^\s*(?:struct|enum|trait|mod)\s+\w+/u,
      /->\s*(?:Result|Option)</u,
      /::\w+|&mut\s/u,
      /println!|\bmacro_rules!|\.unwrap\(\)|\.expect\(/u,
    ],
  },
  docker: {
    common: [/^\s*#/u],
    strong: [
      /^(?:FROM|RUN|CMD|ENTRYPOINT|COPY|ADD)\b/u,
      /^(?:WORKDIR|ENV|ARG|EXPOSE|VOLUME|USER|LABEL|HEALTHCHECK|SHELL|STOPSIGNAL|MAINTAINER)\b/u,
    ],
  },
  bat: {
    common: [/^\s*(?:rem\b|::)/iu, SHELL_COMMAND_LINE, SHELL_VARIABLE],
    strong: [
      /^@?echo\s+(?:off|on)\s*$/iu,
      /^\s*(?:call|goto)\s+:/u,
      /^\s*(?:setlocal|endlocal)\b/iu,
      /^\s*set\s+"?\w+=[^)]*\b/iu,
      /^\s*(?:if|for)\s+.*[()]\s*$/iu,
      /^\s*\)\s*else\b/iu,
      /^\s*(?:pause|exit\s*\/b)\s*$/iu,
    ],
  },
  c: {
    common: C_COMMENT,
    strong: [
      /^\s*#include\s*[<"]/u,
      /^\s*#(?:define|ifdef|ifndef|endif|pragma|if)\b/u,
      /\b(?:std::|cout|cin|endl|printf\(|scanf\(|malloc\(|free\(|nullptr|NULL|sizeof\()/u,
      /^\s*(?:int|void|char|float|double|bool|long|unsigned|auto|struct\s+\w+|class\s+\w+)\s+\*?\w+\s*\([^;]*\)\s*\{?\s*$/u,
    ],
  },
  java: {
    common: C_COMMENT,
    strong: [
      /^\s*package\s+[\w.]+\s*;\s*$/u,
      /^\s*import\s+(?:java|javax|jakarta)\./u,
      /^\s*(?:public|private|protected)\s+(?:static\s+)?(?:final\s+|abstract\s+)?(?:class|interface|enum)\s+\w+/u,
      /^\s*@\w+(?:\([^)]*\))?\s*$/u,
      /System\.(?:out|err)\./u,
      /^\s*(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?[\w<>\[\], ?]+\s+\w+\s*(?:=[^;]*)?;/u,
      /^\s*(?:public|private|protected)\s+(?:static\s+)?[\w<>\[\], ?]+\s+\w+\s*\([^;]*\)\s*(?:throws\s+[\w, ]+)?\s*\{/u,
    ],
  },
  kotlin: {
    common: C_COMMENT,
    strong: [
      /^\s*fun\s+\w+\s*\(/u,
      /^\s*(?:val|var)\s+\w+\s*(?::\s*[\w<>?, ]+)?\s*=/u,
      /\bprintln\(|\blistOf\(|\bmapOf\(|\bmutableListOf\(/u,
      /^\s*(?:data\s+|open\s+|sealed\s+|abstract\s+)?class\s+\w+\s*\(/u,
      /^\s*object\s+\w+/u,
    ],
  },
  groovy: {
    common: C_COMMENT,
    strong: [
      /^\s*def\s+(?:[\w<>, ?]+\s+)?\w+\s*(?:=|\()/u,
      /^\s*import\s+groovy\./u,
      /\bprintln\s+['"]/u,
      /^\s*(?:String|int|long|boolean)\s+\w+\s*=\s*\S/u,
      /@\w+\([^)]*\)\s*$/u,
    ],
  },
  // Local patch (lsfusion-highlight): a module written like the lsFusion
  // documentation, keywords in upper case; a statement may carry a comment
  // behind its semicolon.
  lsfusion: {
    common: [/^\s*\/\//u, /;(?=\s*(?:\/\/.*)?$)/u],
    strong: [
      /^\s*CLASS\s+\w+(?:\s+'[^']*')?\s*(?:;|:|\{|$)/u,
      /=\s*DATA\b/u,
      /\bGROUP\s+(?:MAX|MIN|SUM|AGGR|CONCAT|LAST|ADD)\b/u,
      /^\s*FORM\s+\w+(?:\s+'[^']*')?\s*(?:;|$)/u,
      /^\s*OBJECTS\s+\w+\s*=/u,
      /\b(?:OBJECTS|PROPERTIES|FILTERS|ORDERS)\s*\(/u,
      /^\s*META\s+\w+\s*\(/u,
      /^\s*(?:MODULE|REQUIRE|NAMESPACE|WINDOW)\b.*;(?=\s*(?:\/\/.*)?$)/u,
      /^\s*(?:NAVIGATOR|DESIGN|WINDOW)\b.*\{/u,
      /\bNEW\s+(?:FOLDER|WINDOW)\b/u,
      /\b(?:NEWSESSION|NESTEDSESSION|NEWTHREAD|NEWEXECUTOR)\b/u,
      /\bIF\b[^;\n]*\bTHEN\b/u,
      /\bWHEN\b.*\bTHEN\s*$/u,
      /\b(?:FOR|WHILE)\b.*\bDO\s*\{?\s*$/u,
      /^\s*CASE\s*$/u,
      // An action with a body; the braces of an if or a loop of another language do not count.
      /^\s*(?!(?:if|for|while|switch|catch|else|try|do)\b)[A-Za-z_]\w*(?:\s+'[^']*')?\s*(?:\([^()\n]*\))?\s*\{/u,
      /\b(?:ABSTRACT|OVERRIDE|MULTI|EXCLUSIVE|PARTITION|RECURSION|EXTENDS?|ISCLASS)\b/u,
      /<-/u,
      /^\s*@\w+\s*\(/u,
    ],
  },
};

// A line of brackets alone belongs to every language and to none.
const NEUTRAL_LINE = /^[\s{}()[\];,]*(?:else|catch\b.*|finally|end)?[\s{}()[\];,:]*$/u;

// What the interpreter of a shebang line means for Shiki.
const SHEBANG_LANGUAGES: Record<string, string> = {
  bash: "bash",
  dash: "bash",
  fish: "fish",
  ksh: "bash",
  lua: "lua",
  node: "javascript",
  perl: "perl",
  php: "php",
  powershell: "powershell",
  pwsh: "powershell",
  python: "python",
  r: "r",
  ruby: "ruby",
  sh: "bash",
  tclsh: "tcl",
  wish: "tcl",
  zsh: "bash",
};

const basename = (value: string): string => value.replace(/^.*[/\\]/u, "");

/** The language named by the interpreter of a shebang line, e.g. `#!/usr/bin/env python3`. */
export function shebangLanguage(line: string): string | undefined {
  const text = line.trim();
  if (!line.startsWith("#!")) return undefined;
  if (/\b(?:pwsh|powershell)(?:\.exe)?\s*$/iu.test(text)) return "powershell";
  const match = /^#!\s*(\S+)(?:\s+(\S+))?/u.exec(text);
  if (!match) return undefined;
  let interpreter = basename(match[1]);
  if (interpreter === "env") interpreter = basename(match[2] ?? "");
  const name = interpreter.replace(/\.exe$/iu, "").replace(/\d+(?:\.\d+)*$/u, "");
  return SHEBANG_LANGUAGES[interpreter.replace(/\.exe$/iu, "")] ?? SHEBANG_LANGUAGES[name];
}

/**
 * The language of a draft that is a script as a whole, or undefined for prose.
 * The text must take the shape of one language, with two characteristic lines
 * at least, so that a sentence with a command in it stays uncolored.
 */
export function detectScriptLanguage(text: string): string | undefined {
  const rawLines = text.split("\n");
  const lines = rawLines.map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) return undefined;

  const shebang = shebangLanguage(lines[0]);
  if (shebang) return shebang;

  const trimmed = text.trim();
  if (/^[[{]/u.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // Not JSON: the signatures below decide.
    }
  }
  const markup = markupLanguage(lines);
  if (markup) return markup;
  if (isYaml(rawLines)) return "yaml";

  const coding = lines.filter((line) => !NEUTRAL_LINE.test(line));
  if (coding.length === 0) return undefined;
  const ranked = Object.entries(SIGNATURES)
    .map(([language, lists]) => scoreLanguage(language, lists, coding))
    .filter((score) => score.matched >= Math.max(1, Math.ceil(0.6 * coding.length)))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  if (!best) return undefined;
  const solid =
    best.strong >= 2 ||
    (best.matched === coding.length && coding.length >= 3) ||
    (coding.length <= 2 && best.strong >= 1);
  if (!solid) return undefined;
  const runnerUp = ranked[1];
  if (runnerUp && runnerUp.score === best.score) {
    // A list of plain commands reads the same in both shells.
    return [best.language, runnerUp.language].every((name) => name === "bash" || name === "powershell")
      ? "bash"
      : undefined;
  }
  return best.language;
}

type LanguageScore = { language: string; matched: number; score: number; strong: number };

function scoreLanguage(language: string, lists: Signatures, lines: string[]): LanguageScore {
  let matched = 0;
  const strongHits = new Set<number>();
  for (const line of lines) {
    const common = lists.common.some((pattern) => pattern.test(line));
    let strong = false;
    lists.strong.forEach((pattern, index) => {
      if (pattern.test(line)) {
        strong = true;
        strongHits.add(index);
      }
    });
    if (common || strong) matched += 1;
  }
  // C++ reads as C with the standard library; "cpp" highlights both well.
  const name =
    language === "c" && /\b(?:std::|cout|endl|nullptr|#include\s*<iostream>)/u.test(lines.join("\n"))
      ? "cpp"
      : language;
  return { language: name, matched, score: matched + 2 * strongHits.size, strong: strongHits.size };
}

function markupLanguage(lines: string[]): string | undefined {
  if (!/^<\w[\w:-]*|^<!DOCTYPE|^<\?xml/iu.test(lines[0])) return undefined;
  if (!lines.at(-1)?.endsWith(">")) return undefined;
  return /<!DOCTYPE html|<html\b|<\/?(?:div|span|p|a|body|head|h\d|ul|li|table|script|style|br|img)\b/iu.test(
    lines.join("\n"),
  )
    ? "html"
    : "xml";
}

/** Every line has the shape of YAML, with a nested line or a document marker among them. */
function isYaml(rawLines: string[]): boolean {
  const lines = rawLines.filter((line) => line.trim().length > 0);
  const entry =
    /^ *(?:[\w.$/\[\]"'&*!|>%@`-]+:(?:\s|$)|- +[\w.$/\[\]"'&*!|>-]+:(?:\s|$)|- +\S.*|- *|#.*|---|\.\.\.)/u;
  if (lines.length < 2 || !lines.every((line) => entry.test(line))) return false;
  return (
    lines.some((line) => /^\s+- /u.test(line) || /^ {2,}[\w.$/\[\]"'-]+:/u.test(line)) || lines.includes("---")
  );
}
