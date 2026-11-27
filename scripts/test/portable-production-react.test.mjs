import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { pinProductionReact, productionEntry } from "../portable-production-react.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");

// What npm ships: the production file when NODE_ENV says so, the development one otherwise.
// Some entries carry the license comment of Meta before 'use strict'.
const license =
  "/**\n * Copyright (c) Meta Platforms, Inc. and affiliates.\n *\n * This source code is licensed under the MIT license found in the\n * LICENSE file in the root directory of this source tree.\n */\n\n";
const conditional = (file, header = "") =>
  [
    ...(header ? [header.trimEnd(), ""] : []),
    "'use strict';",
    "",
    "if (process.env.NODE_ENV === 'production') {",
    `  module.exports = require('./cjs/${file}.production.js');`,
    "} else {",
    `  module.exports = require('./cjs/${file}.development.js');`,
    "}",
    "",
  ].join("\n");
const buildOf = (build) => `'use strict';\nexports.build = "${build}";\n`;
const jsxRuntimeOf = (build) =>
  [
    "'use strict';",
    'exports.Fragment = "fragment";',
    `exports.${build === "production" ? "jsx" : "jsxDEV"} = function createElement(type, config, maybeKey) {`,
    '  return { $$typeof: Symbol.for("react.transitional.element"), type, key: maybeKey ?? null, props: config };',
    "};",
    build === "production" ? "exports.jsxDEV = void 0;" : "exports.jsx = void 0;",
    "",
  ].join("\n");

const fixture = () => ({
  "node_modules/react/package.json": '{"name":"react","version":"0.0.0-fixture","main":"index.js"}',
  "node_modules/react/LICENSE": "MIT",
  "node_modules/react/index.js": conditional("react"),
  "node_modules/react/compiler-runtime.js": conditional("react-compiler-runtime", license),
  "node_modules/react/cjs/react-compiler-runtime.production.js": buildOf("production"),
  "node_modules/react/cjs/react-compiler-runtime.development.js": buildOf("development"),
  "node_modules/react/cjs/react.production.js": buildOf("production"),
  "node_modules/react/cjs/react.development.js": buildOf("development"),
  "node_modules/react/jsx-runtime.js": conditional("react-jsx-runtime"),
  "node_modules/react/cjs/react-jsx-runtime.production.js": jsxRuntimeOf("production"),
  "node_modules/react/cjs/react-jsx-runtime.development.js": jsxRuntimeOf("development"),
  "node_modules/react/jsx-dev-runtime.js": conditional("react-jsx-dev-runtime"),
  "node_modules/react/cjs/react-jsx-dev-runtime.production.js":
    "'use strict';\nexports.Fragment = \"fragment\";\nexports.jsxDEV = void 0;\n",
  "node_modules/react/cjs/react-jsx-dev-runtime.development.js": jsxRuntimeOf("development"),
  "node_modules/react-reconciler/package.json":
    '{"name":"react-reconciler","version":"0.0.0-fixture"}',
  "node_modules/react-reconciler/index.js": conditional("react-reconciler"),
  "node_modules/react-reconciler/cjs/react-reconciler.production.js": buildOf("production"),
  "node_modules/react-reconciler/cjs/react-reconciler.development.js": buildOf("development"),
  "node_modules/scheduler/package.json": '{"name":"scheduler","version":"0.0.0-fixture"}',
  "node_modules/scheduler/index.js": conditional("scheduler"),
  "node_modules/scheduler/cjs/scheduler.production.js": buildOf("production"),
  "node_modules/scheduler/cjs/scheduler.development.js": buildOf("development"),
  // A file of the closure the step must not touch.
  "node_modules/@zcode/tui/dist/tui.js": "export const tui = 'untouched';\n",
});

async function makePackage(root, { omit = [], replace = {}, extra = {} } = {}) {
  const files = { ...fixture(), ...extra };
  for (const path of omit) delete files[path];
  Object.assign(files, replace);
  const agentDirectory = join(root, "agent");
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(agentDirectory, path)), { recursive: true });
    await writeFile(join(agentDirectory, path), content);
  }
  const filePaths = Object.keys(files);
  return { agentDirectory, filePaths };
}

const readAgentFile = (agentDirectory, path) => readFile(join(agentDirectory, path), "utf8");

// Children: what a process of the package gets from the pinned entries. One file per module kind,
// because an ESM import and a require() read the entry differently.
const commonjsProbe = `
const path = require("node:path");
const load = (entry) => require(path.join(process.env.ZCODE_PIN_ROOT, "agent", "node_modules", entry));
const react = load("react");
const runtime = load("react/jsx-dev-runtime");
const element = runtime.jsxDEV("box", { children: "x" }, "k", false, undefined, null);
console.log(JSON.stringify({
  nodeEnv: process.env.NODE_ENV ?? null,
  react: react.build,
  reconciler: load("react-reconciler").build,
  scheduler: load("scheduler").build,
  act: typeof react.act,
  jsxDEV: typeof runtime.jsxDEV,
  sameAsJsx: runtime.jsxDEV === load("react/jsx-runtime").jsx,
  element: { type: element.type, key: element.key, children: element.props.children },
}));
`;
const moduleProbe = `
import { Fragment, jsxDEV } from "./agent/node_modules/react/jsx-dev-runtime.js";
import * as entry from "./agent/node_modules/react/index.js";
const element = jsxDEV("text", { children: "hello" }, undefined, false, undefined, null);
console.log(JSON.stringify({
  defaultExport: entry.default.build,
  fragment: Fragment,
  jsxDEV: typeof jsxDEV,
  element: { type: element.type, key: element.key, children: element.props.children },
}));
`;

function environment(nodeEnv) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "NODE_ENV") delete env[key];
  }
  if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
  return env;
}

function runProbe(root, file, nodeEnv) {
  const result = spawnSync(process.execPath, [join(root, file)], {
    cwd: root,
    encoding: "utf8",
    env: { ...environment(nodeEnv), ZCODE_PIN_ROOT: root },
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `node ${file} with NODE_ENV=${nodeEnv}:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function withPackage(options, run) {
  const root = await mkdtemp(join(tmpdir(), "zcode-portable-react-"));
  try {
    const packaged = await makePackage(root, options);
    await writeFile(join(root, "probe.cjs"), commonjsProbe);
    await writeFile(join(root, "probe.mjs"), moduleProbe);
    return await run({ root, ...packaged });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function fileHashes(agentDirectory, filePaths) {
  const hashes = new Map();
  for (const path of filePaths) {
    hashes.set(path, await readFile(join(agentDirectory, path)));
  }
  return hashes;
}

test("the entry npm ships is recognized, with either line ending and without a final newline", () => {
  const source = conditional("react");
  const pinned = productionEntry({ fileName: "index.js", source });
  assert.equal(pinned.target, "react.production.js");
  assert.equal(pinned.changed, true);
  assert.equal(
    pinned.body,
    "'use strict';\n\n// Pinned to the production build by scripts/portable-production-react.mjs.\nmodule.exports = require('./cjs/react.production.js');\n",
  );
  assert.equal(pinned.body.includes("NODE_ENV"), false);
  for (const variant of [
    source.replaceAll("\n", "\r\n"),
    source.trimEnd(),
    source.trimEnd().replaceAll("\n", "\r\n"),
    conditional("react", license),
    conditional("react", license).replaceAll("\n", "\r\n"),
  ]) {
    const entry = productionEntry({ fileName: "index.js", source: variant });
    assert.equal(entry.body, variant.includes("Copyright") ? license + pinned.body : pinned.body);
  }
  // A pinned entry with the license comment is recognized again.
  const withLicense = productionEntry({
    fileName: "index.js",
    source: conditional("react", license),
  });
  assert.deepEqual(productionEntry({ fileName: "index.js", source: withLicense.body }), {
    body: withLicense.body,
    changed: false,
    target: "react.production.js",
  });
});

test("an entry with another switch is not recognized", () => {
  const cases = [
    conditional("react").replace("'production'", "'development'"),
    conditional("react").replace("react.development.js", "react.other.development.js"),
    conditional("react").replace("./cjs/react.production.js", "../cjs/react.production.js"),
    "module.exports = require('./cjs/react.development.js');\n",
    "",
  ];
  for (const source of cases) {
    assert.equal(productionEntry({ fileName: "index.js", source }), null, source);
  }
  // The pinned form itself is recognized again, but only inside cjs/.
  const written = productionEntry({ fileName: "index.js", source: conditional("react") }).body;
  assert.deepEqual(productionEntry({ fileName: "index.js", source: written }), {
    body: written,
    changed: false,
    target: "react.production.js",
  });
  assert.equal(
    productionEntry({ fileName: "index.js", source: written.replace("./cjs/", "./cjs/other/") }),
    null,
  );
});

test("jsx-dev-runtime gives the development JSX callers the production jsx", () => {
  const pinned = productionEntry({
    fileName: "jsx-dev-runtime.js",
    source: conditional("react-jsx-dev-runtime"),
  });
  assert.equal(pinned.target, "react-jsx-runtime.production.js");
  assert.equal(pinned.changed, true);
  assert.equal(pinned.body.includes("NODE_ENV"), false);
  assert.equal(pinned.body.includes("react-jsx-dev-runtime"), false);
  // The second run leaves the entry as it is.
  assert.equal(
    productionEntry({ fileName: "jsx-dev-runtime.js", source: pinned.body }).changed,
    false,
  );
  // The entry of another packages does not get this body.
  assert.equal(
    productionEntry({ fileName: "jsx-dev-runtime.js", source: conditional("other") }),
    null,
  );
});

test("the entries are pinned; the files under cjs and the rest of the closure are not touched", async () => {
  await withPackage({}, async ({ agentDirectory, filePaths }) => {
    const before = await fileHashes(agentDirectory, filePaths);
    const pinned = await pinProductionReact({ agentDirectory, filePaths });
    assert.deepEqual(pinned.map(({ path, target }) => [path, target]).sort(), [
      ["node_modules/react-reconciler/index.js", "react-reconciler.production.js"],
      ["node_modules/react/compiler-runtime.js", "react-compiler-runtime.production.js"],
      ["node_modules/react/index.js", "react.production.js"],
      ["node_modules/react/jsx-dev-runtime.js", "react-jsx-runtime.production.js"],
      ["node_modules/react/jsx-runtime.js", "react-jsx-runtime.production.js"],
      ["node_modules/scheduler/index.js", "scheduler.production.js"],
    ]);
    for (const path of filePaths) {
      const isEntry = pinned.some((entry) => entry.path === path);
      const after = await readAgentFile(agentDirectory, path);
      if (isEntry) {
        assert.equal(after.includes("NODE_ENV"), false, path);
        assert.notEqual(after, before.get(path).toString("utf8"), path);
      } else {
        assert.equal(after, before.get(path).toString("utf8"), path);
      }
    }
    assert.equal(
      await readAgentFile(agentDirectory, "node_modules/react/index.js"),
      productionEntry({ fileName: "index.js", source: conditional("react") }).body,
    );
    // The license comment of an entry stays in front of the pinned body.
    assert.equal(
      await readAgentFile(agentDirectory, "node_modules/react/compiler-runtime.js"),
      `${license}'use strict';\n\n// Pinned to the production build by scripts/portable-production-react.mjs.\nmodule.exports = require('./cjs/react-compiler-runtime.production.js');\n`,
    );
  });
});

test("a second run changes nothing", async () => {
  await withPackage({}, async ({ agentDirectory, filePaths }) => {
    const first = await pinProductionReact({ agentDirectory, filePaths });
    const snapshot = await fileHashes(agentDirectory, filePaths);
    const second = await pinProductionReact({ agentDirectory, filePaths });
    assert.deepEqual(second, first);
    for (const [path, content] of snapshot) {
      assert.equal((await readFile(join(agentDirectory, path))).equals(content), true, path);
    }
  });
});

test("the pinned entries give the production build whatever NODE_ENV says and leave NODE_ENV alone", async () => {
  await withPackage({}, async ({ root, agentDirectory, filePaths }) => {
    // Without the pin the tab's environment loads the development build.
    assert.deepEqual(runProbe(root, "probe.cjs", undefined), {
      act: "undefined",
      element: { children: "x", key: "k", type: "box" },
      jsxDEV: "function",
      nodeEnv: null,
      react: "development",
      reconciler: "development",
      sameAsJsx: false,
      scheduler: "development",
    });
    await pinProductionReact({ agentDirectory, filePaths });
    for (const [nodeEnv, expected] of [
      [undefined, null],
      ["development", "development"],
      ["production", "production"],
    ]) {
      const probe = runProbe(root, "probe.cjs", nodeEnv);
      assert.deepEqual(probe, {
        act: "undefined",
        element: { children: "x", key: "k", type: "box" },
        jsxDEV: "function",
        nodeEnv: expected,
        react: "production",
        reconciler: "production",
        sameAsJsx: true,
        scheduler: "production",
      });
    }
    // An ESM importer gets jsxDEV as a named export of the entry.
    const module = runProbe(root, "probe.mjs", undefined);
    assert.deepEqual(module, {
      defaultExport: "production",
      element: { children: "hello", key: null, type: "text" },
      fragment: "fragment",
      jsxDEV: "function",
    });
  });
});

test("an entry of another shape stops the packaging", async () => {
  await withPackage(
    {
      replace: {
        "node_modules/scheduler/index.js":
          "module.exports = require('./cjs/scheduler.development.js');\n",
      },
    },
    async ({ agentDirectory, filePaths }) =>
      assert.rejects(
        pinProductionReact({ agentDirectory, filePaths }),
        /Unexpected entry file node_modules\/scheduler\/index\.js/u,
      ),
  );
  // Also a file the step did not know the package had.
  await withPackage(
    { extra: { "node_modules/react/switch.js": conditional("switch") } },
    async ({ agentDirectory, filePaths }) =>
      assert.rejects(pinProductionReact({ agentDirectory, filePaths }), /react\/switch\.js/u),
  );
});

test("a production file missing from the closure stops the packaging", async () => {
  await withPackage(
    { omit: ["node_modules/react-reconciler/cjs/react-reconciler.production.js"] },
    async ({ agentDirectory, filePaths }) =>
      assert.rejects(
        pinProductionReact({ agentDirectory, filePaths }),
        /Missing cjs\/react-reconciler\.production\.js next to node_modules\/react-reconciler\/index\.js/u,
      ),
  );
});

test("a closure without the main entry of one of the packages stops the packaging", async () => {
  await withPackage(
    { omit: ["node_modules/scheduler/index.js"] },
    async ({ agentDirectory, filePaths }) =>
      assert.rejects(
        pinProductionReact({ agentDirectory, filePaths }),
        /Missing scheduler\/index\.js in the TUI closure/u,
      ),
  );
});

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

test("the packages of this repository: the pin runs and React loads as the production build", async (context) => {
  const requireFromTui = createRequire(
    resolve(repositoryRoot, "apps/zcode-cli/packages/tui/package.json"),
  );
  const packageDirectories = {};
  for (const name of ["react", "react-reconciler", "scheduler"]) {
    try {
      packageDirectories[name] = dirname(requireFromTui.resolve(`${name}/package.json`));
    } catch {
      context.skip(`npm packages are not installed (${name} is not resolvable)`);
      return;
    }
  }
  const root = await mkdtemp(join(tmpdir(), "zcode-portable-react-real-"));
  try {
    const agentDirectory = join(root, "agent");
    for (const [name, directory] of Object.entries(packageDirectories)) {
      await cp(directory, join(agentDirectory, "node_modules", name), { recursive: true });
    }
    const filePaths = (await walk(agentDirectory)).map((path) =>
      relative(agentDirectory, path).replaceAll("\\", "/"),
    );
    const entryPaths = filePaths.filter((path) =>
      /^node_modules\/(react|react-reconciler|scheduler)\/[^/]+\.js$/u.test(path),
    );
    const before = await fileHashes(agentDirectory, filePaths);
    const pinned = await pinProductionReact({ agentDirectory, filePaths });
    assert.equal(pinned.length, entryPaths.length);
    assert.equal(pinned.length, 14);
    assert.equal(pinned.filter(({ path }) => path.startsWith("node_modules/react/")).length, 7);
    for (const [path, content] of before) {
      const isEntry = pinned.some((entry) => entry.path === path);
      const after = await readFile(join(agentDirectory, path));
      if (isEntry) assert.equal(after.toString("utf8").includes("NODE_ENV"), false, path);
      else assert.equal(after.equals(content), true, path);
    }

    const probe = `
const path = require("node:path");
const modules = path.join(process.env.ZCODE_PIN_ROOT, "agent", "node_modules");
const React = require(path.join(modules, "react"));
const runtime = require(path.join(modules, "react/jsx-dev-runtime"));
const element = runtime.jsxDEV("box", { key: "the-key", children: "x" }, undefined, false, undefined, null);
console.log(JSON.stringify({
  nodeEnv: process.env.NODE_ENV ?? null,
  version: React.version,
  act: typeof React.act,
  captureOwnerStack: typeof React.captureOwnerStack,
  jsxDEV: typeof runtime.jsxDEV,
  sameAsJsx: runtime.jsxDEV === require(path.join(modules, "react/jsx-runtime")).jsx,
  valid: React.isValidElement(element),
  element: { type: element.type, key: element.key, children: element.props.children },
}));
`;
    await writeFile(join(root, "probe.cjs"), probe);
    await writeFile(
      join(root, "probe.mjs"),
      `import { Fragment, jsxDEV } from "./agent/node_modules/react/jsx-dev-runtime.js";
import { jsx } from "./agent/node_modules/react/jsx-runtime.js";
import * as entry from "./agent/node_modules/react/index.js";
console.log(JSON.stringify({ named: typeof Fragment === "symbol" && typeof jsxDEV === "function" && jsxDEV === jsx, valid: entry.default.isValidElement(jsxDEV("text", { children: "hello" }, undefined, false, undefined, null)) }));
`,
    );
    const version = JSON.parse(
      await readFile(join(agentDirectory, "node_modules/react/package.json"), "utf8"),
    ).version;
    for (const nodeEnv of [undefined, "development", "production"]) {
      assert.deepEqual(runProbe(root, "probe.cjs", nodeEnv), {
        act: "undefined",
        captureOwnerStack: "undefined",
        element: { children: "x", key: "the-key", type: "box" },
        jsxDEV: "function",
        nodeEnv: nodeEnv ?? null,
        sameAsJsx: true,
        valid: true,
        version,
      });
    }
    assert.deepEqual(runProbe(root, "probe.mjs", undefined), { named: true, valid: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
