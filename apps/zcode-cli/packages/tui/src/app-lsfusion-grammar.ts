// Local patch (lsfusion-highlight): a Textmate grammar for the lsFusion language.
// Shiki has no grammar for it, so the TUI carries its own and the shared
// highlighter loads it like a bundled language. The scope names are the ones
// themeScopeOf (app-script-highlight.ts) gives a color of the theme.
//
// Keywords are the list of the Ace mode by the lsFusion team
// (github.com/lsfusion/ace, lib/ace/mode/lsf.js) and the few a later version
// added, written in upper case as in the lsFusion documentation. Identifiers
// are usually in camel case there, so a word in Pascal case reads as a class.

import type { LanguageRegistration } from "shiki";

export const LSFUSION_LANGUAGE = "lsfusion";

/** The fence names and filetypes of lsFusion, by the id the highlighter knows it under. */
export const LSFUSION_LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  lsf: LSFUSION_LANGUAGE,
  lsfusion: LSFUSION_LANGUAGE,
};

/** Built-in data classes. */
const TYPES = [
  "BOOLEAN", "BPISTRING", "BPSTRING", "COLOR", "CSVFILE", "CSVLINK", "DATE", "DATETIME", "DBFFILE", "DBFLINK",
  "DOUBLE", "EXCELFILE", "EXCELLINK", "FILE", "HTMLFILE", "HTMLLINK", "IMAGEFILE", "IMAGELINK", "INTEGER",
  "INTERVAL", "ISTRING", "JSONFILE", "JSONLINK", "LINK", "LONG", "NAMEDFILE", "NUMERIC", "PDFFILE", "PDFLINK",
  "RAWFILE", "RAWLINK", "RICHTEXT", "STRING", "TABLEFILE", "TABLELINK", "TBOOLEAN", "TEXT", "TEXTFILE", "TEXTLINK",
  "TIME", "WORDFILE", "WORDLINK", "XMLFILE", "XMLLINK", "YEAR", "ZDATETIME",
];

/** The logical constants and the empty value, in both spellings. */
const CONSTANTS = ["FALSE", "NULL", "TFALSE", "TRUE", "TTRUE", "false", "null", "true"];

const KEYWORDS = [
  "ABSTRACT", "ACTION", "ACTIONS", "ACTIVATE", "ACTIVE", "AFTER", "AGGR", "ALL", "AND", "APPEND", "APPLY", "AS",
  "ASK", "ASON", "ASYNCUPDATE", "ATTACH", "ATTR", "AUTH", "AUTO", "AUTOREFRESH", "AUTOSET", "BACKGROUND", "BCC",
  "BEFORE", "BODY", "BODYPARAMHEADERS", "BODYPARAMNAMES", "BODYURL", "BOTTOM", "BOX", "BREAK", "BY", "CALENDAR",
  "CANCEL", "CANONICALNAME", "CASE", "CATCH", "CC", "CENTER", "CHANGE", "CHANGEABLE", "CHANGECLASS", "CHANGED",
  "CHANGEKEY", "CHANGEMOUSE", "CHANGEWYS", "CHARSET", "CHARWIDTH", "CHECK", "CHECKBOX", "CHECKED", "CLASS",
  "CLASSCHOOSER", "CLIENT", "CLOSE", "COLLAPSE", "COLUMN", "COLUMNS", "COMPLEX", "CONCAT", "CONFIG", "CONFIRM",
  "CONNECTION", "CONSTRAINT", "CONSTRAINTFILTER", "CONTAINER", "CONTEXTMENU", "CONTINUE", "COOKIES", "COOKIESTO",
  "CSV", "CUSTOM", "CYCLES", "DATA", "DB", "DBF", "DEFAULT", "DEFAULTCOMPARE", "DELAY", "DELETE", "DESC", "DESIGN",
  "DIALOG", "DISABLE", "DISABLEIF", "DO", "DOC", "DOCKED", "DOCX", "DOWN", "DRAW", "DRILLDOWN", "DROP",
  "DROPCHANGED", "DROPPED", "ECHO", "EDIT", "ELSE", "EMAIL", "EMBEDDED", "END", "EQUAL", "ESCAPE", "EVAL", "EVENT",
  "EVENTID", "EVENTS", "EXCLUSIVE", "EXEC", "EXPAND", "EXPORT", "EXTEND", "EXTENDS", "EXTERNAL", "EXTID", "EXTKEY",
  "EXTNULL", "FIELDS", "FILTER", "FILTERBOX", "FILTERCONTROLS", "FILTERGROUP", "FILTERGROUPS", "FILTERS", "FINALLY",
  "FIRST", "FIXED", "FLEX", "FLOAT", "FOCUSED", "FOLDER", "FOOTER", "FOR", "FOREGROUND", "FORM", "FORMEXTID",
  "FORMS", "FORMULA", "FROM", "FULL", "GET", "GLOBAL", "GOAFTER", "GRID", "GROUP", "GROUPCHANGE", "HALIGN", "HEADER",
  "HEADERS", "HEADERSTO", "HIDE", "HIDESCROLLBARS", "HIDETITLE", "HINT", "HINTNOUPDATE", "HINTTABLE", "HORIZONTAL",
  "HOVER", "HTML", "HTTP", "IF", "IMAGE", "IMPORT", "IMPOSSIBLE", "IN", "INDEX", "INDEXED", "INIT", "INLINE",
  "INPUT", "INTERNAL", "IS", "ISCLASS", "JAVA", "JOIN", "JSON", "JSONTEXT", "KEYPRESS", "LAST", "LEFT", "LIKE",
  "LIMIT", "LIST", "LOCAL", "LOCALASYNC", "LOG", "LOGGABLE", "LSF", "MANAGESESSION", "MAP", "MATCH", "MATERIALIZED",
  "MAX", "MEASURE", "MEASURES", "MEMO", "MENU", "MESSAGE", "META", "MIN", "MODULE", "MOVE", "MS", "MULTI", "NAGGR",
  "NAME", "NAMESPACE", "NATIVE", "NAVIGATOR", "NESTED", "NESTEDSESSION", "NEW", "NEWCONNECTION", "NEWEDIT",
  "NEWEXECUTOR", "NEWSESSION", "NEWSQL", "NEWTHREAD", "NEXT", "NO", "NOCANCEL", "NOCHANGE", "NOCOMPLEX",
  "NOCONSTRAINTFILTER", "NODEFAULT", "NOENCODE", "NOESCAPE", "NOEXTID", "NOFLEX", "NOHEADER", "NOHINT", "NOIMAGE",
  "NOINLINE", "NOMANAGESESSION", "NONULL", "NOPREVIEW", "NOREPLACE", "NOSETTINGS", "NOSTICKY", "NOT", "NOWAIT",
  "OBJECT", "OBJECTS", "OK", "ON", "OPTIMISTICASYNC", "OPTIONS", "OR", "ORDER", "ORDERS", "OVERRIDE", "PAGESIZE",
  "PANEL", "PARAMS", "PARENT", "PARTITION", "PASSWORD", "PDF", "PERIOD", "PG", "PIVOT", "POPUP", "POSITION", "POST",
  "PREREAD", "PREV", "PREVIEW", "PRINT", "PRIORITY", "PROPERTIES", "PROPERTY", "PROPORTION", "PUT", "QUERYCLOSE",
  "QUERYOK", "QUICKFILTER", "READ", "READONLY", "READONLYIF", "RECALCULATE", "RECURSION", "REFLECTION", "REGEXP",
  "REMOVE", "REPLACE", "REPORT", "REPORTFILES", "REQUEST", "REQUIRE", "RESOLVE", "RETURN", "RGB", "RIGHT", "ROOT",
  "ROUND", "ROW", "ROWS", "RTF", "SCHEDULE", "SEEK", "SELECTED", "SELECTOR", "SERIALIZABLE", "SERVER", "SESSION",
  "SET", "SETCHANGED", "SETDROPPED", "SETTINGS", "SHEET", "SHOW", "SHOWDEP", "SHOWIF", "SINGLE", "SQL", "START",
  "STEP", "STICKY", "STRETCH", "STRICT", "STRONG", "STRUCT", "SUBJECT", "SUBREPORT", "SUCCESS", "SUM", "TAB",
  "TABLE", "TAG", "TCP", "TEXTHALIGN", "TEXTVALIGN", "THEN", "THREADS", "TO", "TOOLBAR", "TOOLBARBOX", "TOOLBARLEFT",
  "TOOLBARRIGHT", "TOOLBARSYSTEM", "TOP", "TREE", "TRY", "UDP", "UNGROUP", "UP", "USERFILTERS", "VALIGN", "VALUE",
  "VERTICAL", "VIEW", "WAIT", "WARN", "WEAK", "WHEN", "WHERE", "WHILE", "WINDOW", "WITHIN", "WRITE", "XLS", "XLSX",
  "XML", "XOR", "YES", "YESNO",
];

/** The same in the lower-case spelling, only the words an identifier is unlikely to share. */
const LOWER_CASE_KEYWORDS = [
  "abstract", "aggr", "and", "ask", "as", "break", "by", "case", "catch", "class", "concat", "cycles", "desc", "do",
  "else", "exclusive", "extends", "finally", "for", "if", "impossible", "is", "isclass", "match", "meta", "multi",
  "newexecutor", "newsession", "newthread", "nestedsession", "not", "offset", "or", "override", "partition",
  "recursion", "return", "then", "try", "when", "where", "while", "xor",
];

type Rule = NonNullable<LanguageRegistration["patterns"]>[number];

// Latin letters as the lsFusion documentation defines identifiers, and the
// Cyrillic block: older projects name classes and properties in Russian.
const UPPER = "A-Z\\u0410-\\u042F\\u0401\\u040E";
const LOWER = "a-z0-9\\u0430-\\u044F\\u0451\\u045E";
const IDENTIFIER = `[A-Za-z_\\u0400-\\u052F][\\w\\u0400-\\u052F]*`;
// Starts with a capital and has a lower-case letter somewhere: InvoiceDetail,
// HTTPSClient, but not an upper-case keyword such as STRING.
const PASCAL_CASE_WORD = `[${UPPER}][${UPPER}${LOWER}]*[${LOWER}][${UPPER}${LOWER}]*`;
const NOT_IN_WORD = "(?<![\\w$])";
const anyOf = (words: readonly string[]): string => `\\b(?:${words.join("|")})\\b`;
/** A statement never opens with one of these, so it is no declaration. */
const RESERVED = anyOf([...KEYWORDS, ...TYPES, ...CONSTANTS, ...LOWER_CASE_KEYWORDS]);
const group = (...patterns: Rule[]): Rule => ({ patterns });

export const lsfusionLanguage: LanguageRegistration = {
  aliases: ["lsf"],
  displayName: "lsFusion",
  fileTypes: ["lsf"],
  name: LSFUSION_LANGUAGE,
  patterns: [
    { include: "#comments" },
    { include: "#java" },
    { include: "#strings" },
    { include: "#literals" },
    { include: "#types" },
    { include: "#keywords" },
    { include: "#declarations" },
    { include: "#metacode" },
    { include: "#class-names" },
    { include: "#calls" },
    { include: "#parameters" },
    { include: "#operators" },
  ],
  repository: {
    // The block comment comes first: a line comment may hide inside its lines.
    comments: group(
      { begin: "/\\*", end: "\\*/", name: "comment.block.lsfusion" },
      { match: "//.*", name: "comment.line.double-slash.lsfusion" },
    ),
    // The inline Java of the INTERNAL operator: its quotes and slashes are not lsFusion's.
    java: group({ begin: "<\\{", end: "\\}>", name: "meta.embedded.java.lsfusion" }),
    strings: group(
      // A raw literal with a delimiter, e.g. r!'don't stop'!, ends at the quote and the delimiter.
      {
        begin: `${NOT_IN_WORD}[rR]([^\\w\\s'+*,=<>()\\[\\]{}#])'`,
        beginCaptures: { "1": { name: "punctuation.definition.string.begin.lsfusion" } },
        end: "'\\1",
        endCaptures: { "0": { name: "punctuation.definition.string.end.lsfusion" } },
        name: "string.quoted.single.raw.lsfusion",
      },
      { begin: `${NOT_IN_WORD}[rR]'`, end: "'", name: "string.quoted.single.raw.lsfusion" },
      {
        begin: "'",
        beginCaptures: { "0": { name: "punctuation.definition.string.begin.lsfusion" } },
        end: "'",
        endCaptures: { "0": { name: "punctuation.definition.string.end.lsfusion" } },
        name: "string.quoted.single.lsfusion",
        patterns: [
          { match: "\\\\[nrt'\\\\$]", name: "constant.character.escape.lsfusion" },
          // A localization key, e.g. {orders.title}.
          { match: "\\{[^{}'\\\\\\n]*\\}", name: "constant.other.localization.lsfusion" },
          // An embedded resource: $I{...}, $R{...} or $M{...}.
          { match: "\\$[IRM]\\{[^{}'\\\\\\n]*\\}", name: "keyword.control.directive.lsfusion" },
          {
            begin: "\\$\\{",
            beginCaptures: { "0": { name: "punctuation.definition.interpolation.begin.lsfusion" } },
            end: "\\}",
            endCaptures: { "0": { name: "punctuation.definition.interpolation.end.lsfusion" } },
            patterns: [
              // The quotes of a literal inside the expression are escaped.
              { begin: "\\\\'", end: "\\\\'", name: "string.quoted.single.lsfusion" },
              { include: "#expression" },
              // The rest of the expression is not part of the string color.
              { match: ".", name: "variable.other.expression.lsfusion" },
            ],
          },
        ],
      },
    ),
    literals: group(
      { match: anyOf(CONSTANTS), name: "constant.language.lsfusion" },
      { match: "\\b\\d{4}_\\d{2}_\\d{2}(?:_\\d{2}:\\d{2}(?::\\d{2})?)?\\b", name: "constant.numeric.date.lsfusion" },
      { match: "\\b\\d{2}:\\d{2}(?::\\d{2})?\\b", name: "constant.numeric.time.lsfusion" },
      { match: "#[0-9A-Fa-f]{6}\\b", name: "constant.numeric.color.lsfusion" },
      { match: "\\b\\d+(?:\\.\\d*)?[lLdD]?\\b", name: "constant.numeric.lsfusion" },
    ),
    types: group({ match: anyOf(TYPES), name: "support.type.primitive.lsfusion" }),
    keywords: group(
      { match: anyOf(KEYWORDS), name: "keyword.other.lsfusion" },
      { match: anyOf(LOWER_CASE_KEYWORDS), name: "keyword.other.lsfusion" },
    ),
    declarations: group(
      // The name of a class: CLASS ABSTRACT Document;
      {
        captures: {
          "1": { name: "keyword.other.lsfusion" },
          "2": { name: "keyword.other.lsfusion" },
          "3": { name: "entity.name.type.class.lsfusion" },
        },
        match: `\\b(CLASS)\\s+(?:(ABSTRACT|NATIVE)\\s+)?(${IDENTIFIER})\\b`,
      },
      // The name of a metacode.
      {
        captures: {
          "1": { name: "keyword.other.lsfusion" },
          "2": { name: "entity.name.function.macro.lsfusion" },
        },
        match: `\\b(META)\\s+(${IDENTIFIER})\\b`,
      },
      {
        // A statement opens with the name of what it declares: the name, a
        // caption, the parameters, then an operator, the body of an action, or
        // an option such as ABSTRACT. The scanner of Textmate takes the match
        // that starts first, so a keyword in front has to be ruled out here.
        captures: { "2": { name: "entity.name.function.lsfusion" } },
        match: `^([ \\t]*)(?!${RESERVED})(${IDENTIFIER})(?=[ \\t]*(?:'[^'\\n]*')?[ \\t]*(?:\\([^\\n]*?\\))?[ \\t]*(?:\\+<-|<-|==|=>|=|\\{|\\+|(?=[A-Z])))`,
      },
    ),
    metacode: group({ match: `${NOT_IN_WORD}@[A-Za-z_]\\w*`, name: "entity.name.function.macro.lsfusion" }),
    // A custom class: the name is in Pascal case by convention. It comes
    // before the calls, as a class is often followed by parameters too.
    "class-names": group({ match: `${NOT_IN_WORD}${PASCAL_CASE_WORD}(?![\\w$])`, name: "entity.name.type.class.lsfusion" }),
    // A property or an action with its parameters; (+) and the like are operators.
    calls: group({ match: `(?<![\\w$@#])${IDENTIFIER}(?=\\s*\\((?!\\s*[+*/-]\\s*\\)))`, name: "entity.name.function.lsfusion" }),
    // A parameter written with the dollar, e.g. $i in $i + 1.
    parameters: group({ match: "\\$[A-Za-z_]\\w*", name: "variable.parameter.lsfusion" }),
    operators: group({
      // (+) and the like are the arithmetics that treat NULL as zero; ## and ### join lexemes.
      match: "\\+<-|\\*->|<-|->|=>|==|!=|<=|>=|\\?\\?|&&|\\|\\||\\([+*/]\\)|#{2,3}|[+*/=<>!?:&|]",
      name: "keyword.operator.lsfusion",
    }),
    expression: group(
      { include: "#literals" },
      { include: "#types" },
      { include: "#keywords" },
      { include: "#class-names" },
      { include: "#calls" },
      { include: "#parameters" },
      { include: "#operators" },
    ),
  },
  scopeName: "source.lsfusion",
};
