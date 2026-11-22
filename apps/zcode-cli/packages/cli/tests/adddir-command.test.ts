import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import test from "node:test";
import { createCommandCenter, parseSlashCommand } from "../src/command-center.js";

// Local patch (adddir-command): /adddir resolves against the session cwd,
// requires an existing directory, dedupes, and reports the live list.

function createAddDirFixture(workingDirectory: string, initialDirectories: string[] = []) {
  let addedWorkingDirectories = [...initialDirectories];
  const updateConfigCalls: Array<Record<string, unknown>> = [];
  const commandCenter = createCommandCenter({
    addWorkingDirectory: async ({ path }) => {
      const raw = path.trim().replace(/^"([\s\S]*)"$/u, "$1").replace(/^'([\s\S]*)'$/u, "$1");
      if (raw.length === 0) return { outcome: "error", message: "Usage: /adddir <directory>" };
      const resolved = isAbsolute(raw) ? resolve(raw) : resolve(workingDirectory, raw);
      if (addedWorkingDirectories.includes(resolved)) {
        return { outcome: "duplicate", path: resolved, directories: [...addedWorkingDirectories] };
      }
      let stats;
      try {
        stats = await stat(resolved);
      } catch {
        return { outcome: "error", message: `Directory not found: ${resolved}` };
      }
      if (!stats.isDirectory()) return { outcome: "error", message: `Not a directory: ${resolved}` };
      addedWorkingDirectories = [...addedWorkingDirectories, resolved];
      return { outcome: "added", path: resolved, directories: [...addedWorkingDirectories] };
    },
    listWorkingDirectories: () => [...addedWorkingDirectories],
    getWorkingDirectoryBase: () => workingDirectory,
    getApp: async () => {
      throw new Error("getApp should not be called for /adddir");
    },
    getMode: () => "build",
    resumeApp: async () => {
      throw new Error("resume should not be called");
    },
  });
  return { commandCenter, updateConfigCalls };
}

test("parseSlashCommand recognizes adddir", () => {
  assert.deepEqual(parseSlashCommand("/adddir"), {
    args: "",
    name: "adddir",
    rawName: "adddir",
    type: "known",
  });
  assert.deepEqual(parseSlashCommand("/adddir D:\\ZCode"), {
    args: "D:\\ZCode",
    name: "adddir",
    rawName: "adddir",
    type: "known",
  });
});

test("/adddir without arguments lists the directories", async () => {
  const { commandCenter } = createAddDirFixture("D:\\ZCode\\src", ["D:\\tmp"]);
  const result = await commandCenter("/adddir", {});
  assert.match(result.response, /Working directory: D:\\ZCode\\src/);
  assert.match(result.response, /Additional directories \(1\):/);
  assert.match(result.response, /- D:\\tmp/);
});

test("/adddir adds an absolute existing directory", async () => {
  const { commandCenter } = createAddDirFixture("D:\\ZCode\\src");
  const result = await commandCenter("/adddir D:\\ZCode\\patches", {});
  assert.match(result.response, /Added working directory: D:\\ZCode\\patches/);
  assert.match(result.response, /Additional directories \(1\):/);
});

test("/adddir resolves a relative path against the session cwd", async () => {
  const { commandCenter } = createAddDirFixture("D:\\ZCode\\src");
  const result = await commandCenter("/adddir patches", {});
  assert.match(result.response, /Added working directory: D:\\ZCode\\src\\patches/);
});

test("/adddir rejects a missing directory", async () => {
  const { commandCenter } = createAddDirFixture("D:\\ZCode\\src");
  const result = await commandCenter("/adddir D:\\ZCode\\no-such-dir", {});
  assert.match(result.response, /Directory not found: D:\\ZCode\\no-such-dir/);
});

test("/adddir rejects a file path", async () => {
  const { commandCenter } = createAddDirFixture("D:\\ZCode\\patches");
  const result = await commandCenter("/adddir README.txt", {});
  assert.match(result.response, /Not a directory: D:\\ZCode\\patches\\README.txt/);
});

test("/adddir dedupes an already-added directory", async () => {
  const { commandCenter } = createAddDirFixture("D:\\ZCode", ["D:\\ZCode\\patches"]);
  const result = await commandCenter("/adddir patches", {});
  assert.match(result.response, /Already an additional working directory: D:\\ZCode\\patches/);
});

test("/adddir unquotes a quoted path", async () => {
  const { commandCenter } = createAddDirFixture("D:\\ZCode\\src");
  const result = await commandCenter('/adddir "D:\\ZCode\\patches"', {});
  assert.match(result.response, /Added working directory: D:\\ZCode\\patches/);
});
