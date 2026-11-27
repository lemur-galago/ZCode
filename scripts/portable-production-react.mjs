// Pins the TUI runtime closure of a portable package to the production builds of React.
//
// react, react-reconciler and scheduler choose their build when an entry file loads:
// `process.env.NODE_ENV === "production"` gives the production file, anything else the development
// one. A tab starts with NODE_ENV unset, so the TUI runs the development build, whose checks are a
// large part of the main-thread time of a stream landing. NODE_ENV cannot be set in the agent
// process instead: the tools inherit the environment of the agent (builds and tests of the user's
// projects). The package is what changes. Its entry files always give the production build, whatever
// NODE_ENV says, and nothing is written into the environment.
//
// The repository is not touched: its tests need the development build (React.act exists only
// there) and load the packages of the repository, not this package.
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Entry files of the three packages, as the collector lists them: top-level .js files.
const entryPathPattern =
  /^node_modules\/(?<package>react|react-reconciler|scheduler)\/(?<file>[^/]+\.js)$/u;
// What npm ships: the production file when NODE_ENV says so, the development one otherwise. Some
// entries carry the license comment of Meta before 'use strict'.
const conditionalEntryPattern =
  /^(?<header>\/\*\*[\s\S]*?\*\/\r?\n\r?\n)?'use strict';\r?\n\r?\nif \(process\.env\.NODE_ENV === 'production'\) \{\r?\n  module\.exports = require\('\.\/cjs\/(?<production>[^'"]+)'\);\r?\n\} else \{\r?\n  module\.exports = require\('\.\/cjs\/(?<development>[^'"]+)'\);\r?\n\}\r?\n?$/u;
// What an earlier run of this step wrote to a plain entry.
const pinnedEntryPattern =
  /^(?<header>\/\*\*[\s\S]*?\*\/\n\n)?'use strict';\n\n\/\/ Pinned to the production build by scripts\/portable-production-react\.mjs\.\nmodule\.exports = require\('\.\/cjs\/(?<production>[^'"]+)'\);\n$/u;

const pinnedBy = "// Pinned to the production build by scripts/portable-production-react.mjs.";
// The license comment keeps its lines; the file is written with line feeds.
const withHeader = (header, lines) =>
  header ? `${header.replace(/\r\n/gu, "\n")}${lines}` : lines;
const simpleEntry = (header, file) =>
  withHeader(
    header,
    ["'use strict';", "", pinnedBy, `module.exports = require('./cjs/${file}');`, ""].join("\n"),
  );

// The production file of this entry defines jsxDEV as undefined. Code bundled in the development
// JSX mode calls it on paths a tab reaches (@mbears/opentui-react: the fallback of its root error
// boundary and its slots), so jsxDEV is the production jsx there: the same element without the
// debug information.
const jsxDevRuntimeEntry = "jsx-dev-runtime.js";
const jsxDevRuntimeProduction = "react-jsx-dev-runtime.production.js";
const jsxRuntimeProduction = "react-jsx-runtime.production.js";
const jsxDevRuntimeLines = [
  "'use strict';",
  "",
  pinnedBy,
  "// The production file of this entry defines jsxDEV as undefined; a bundle made in the",
  "// development JSX mode calls it, so jsxDEV is the production jsx.",
  `var runtime = require('./cjs/${jsxRuntimeProduction}');`,
  "exports.Fragment = runtime.Fragment;",
  "exports.jsxDEV = runtime.jsx;",
  "",
].join("\n");

/**
 * The production body of one entry file of react, react-reconciler or scheduler.
 *
 * Returns `{ body, target, changed }` (`target` is the file under cjs/ the entry loads now), or
 * null when the source is neither the entry npm ships nor the pinned form of this entry.
 */
export function productionEntry({ fileName, source }) {
  if (fileName === jsxDevRuntimeEntry) {
    if (source === jsxDevRuntimeLines) {
      return { body: source, target: jsxRuntimeProduction, changed: false };
    }
    const shipped = conditionalEntryPattern.exec(source);
    if (shipped?.groups.production !== jsxDevRuntimeProduction) {
      return null;
    }
    return { body: jsxDevRuntimeLines, target: jsxRuntimeProduction, changed: true };
  }
  const pinned = pinnedEntryPattern.exec(source);
  if (pinned) {
    const { production } = pinned.groups;
    if (production.includes("/")) return null;
    return { body: source, target: production, changed: false };
  }
  const shipped = conditionalEntryPattern.exec(source);
  if (!shipped) return null;
  const { header, production, development } = shipped.groups;
  const stem = production.replace(/\.production\.js$/u, "");
  const sameBuild =
    production.endsWith(".production.js") && development === `${stem}.development.js`;
  if (production.includes("/") || !sameBuild) {
    return null;
  }
  const body = simpleEntry(header, production);
  return { body, target: production, changed: source !== body };
}

/**
 * Rewrites the entry files of react, react-reconciler and scheduler under `agentDirectory`.
 *
 * `filePaths` are the paths of the TUI closure relative to the agent directory. Returns what the
 * entries point at now. Throws when an entry has another shape than npm ships or this step writes:
 * the package must not ship a switch the step does not know about.
 */
export async function pinProductionReact({ agentDirectory, filePaths }) {
  const entries = filePaths.filter((filePath) => entryPathPattern.test(filePath)).sort();
  for (const required of ["react/index.js", "react-reconciler/index.js", "scheduler/index.js"]) {
    if (!entries.includes(`node_modules/${required}`)) {
      throw new Error(
        `Missing ${required} in the TUI closure: the production build cannot be pinned without it.`,
      );
    }
  }
  const pinned = [];
  for (const filePath of entries) {
    const { file: fileName } = entryPathPattern.exec(filePath).groups;
    const absolutePath = join(agentDirectory, filePath);
    const entry = productionEntry({ fileName, source: await readFile(absolutePath, "utf8") });
    if (!entry) {
      throw new Error(
        `Unexpected entry file ${filePath}: react, react-reconciler or scheduler changed the way an entry picks its build; scripts/portable-production-react.mjs needs a review.`,
      );
    }
    const productionFile = join(dirname(absolutePath), "cjs", entry.target);
    const present = await access(productionFile).then(
      () => true,
      () => false,
    );
    if (!present) {
      throw new Error(
        `Missing cjs/${entry.target} next to ${filePath}: the pinned entry cannot load it.`,
      );
    }
    if (entry.changed) await writeFile(absolutePath, entry.body, "utf8");
    pinned.push({ path: filePath, target: entry.target });
  }
  return pinned;
}
