// Local patch (provider-config-watch).
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await sleep(10);
  assert.ok(condition(), what);
}

async function temporaryConfig(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-provider-watch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "provider_config.json");
}

// Another writer of the file: a login in another terminal, the desktop app.
function writerOf(filePath: string): NodePersonalProviderConfigRepository {
  return new NodePersonalProviderConfigRepository({ filePath, pollingIntervalMs: false });
}
const selectModel = (modelId: string) => (current: { defaultModelSelection?: unknown }) => ({
  ...current,
  defaultModelSelection: { modelId, providerId: "custom" },
});

function reportsOf(repository: NodePersonalProviderConfigRepository): string[] {
  const reasons: string[] = [];
  repository.onDidChange((reason) => reasons.push(reason));
  return reasons;
}

test("a change made elsewhere is reported at once, not with the timed read", { timeout: 20_000 }, async (t) => {
  const filePath = await temporaryConfig(t);
  const watcher = new NodePersonalProviderConfigRepository({ filePath });
  const writer = writerOf(filePath);
  t.after(() => {
    watcher.dispose();
    writer.dispose();
  });
  const reasons = reportsOf(watcher);
  await writer.update(selectModel("model-a"));
  await watcher.read();

  const started = Date.now();
  await writer.update(selectModel("model-b"));
  await waitFor(() => reasons.length > 0, "the change is reported");
  // Long before the fallback read, which waits a minute.
  assert.ok(Date.now() - started < 10_000);
  // One write raises several file system events: still one report.
  await sleep(500);
  assert.deepEqual(reasons, ["poll-changed"]);
  assert.equal((await watcher.read()).defaultModelSelection?.modelId, "model-b");
});

test("a file that appears after the start is noticed", { timeout: 20_000 }, async (t) => {
  const filePath = await temporaryConfig(t);
  const watcher = new NodePersonalProviderConfigRepository({ filePath });
  const writer = writerOf(filePath);
  t.after(() => {
    watcher.dispose();
    writer.dispose();
  });
  const reasons = reportsOf(watcher);
  await watcher.read();
  assert.deepEqual(reasons, []);

  await writer.update(selectModel("model-a"));
  await waitFor(() => reasons.length > 0, "the new file is reported");
  assert.deepEqual(reasons, ["poll-changed"]);
});

test("nothing is watched or read once polling is switched off", { timeout: 20_000 }, async (t) => {
  const filePath = await temporaryConfig(t);
  const writer = writerOf(filePath);
  const quiet = new NodePersonalProviderConfigRepository({ filePath, pollingIntervalMs: false });
  t.after(() => {
    quiet.dispose();
    writer.dispose();
  });
  const reasons = reportsOf(quiet);
  await writer.update(selectModel("model-a"));
  await quiet.read();
  await writer.update(selectModel("model-b"));
  await sleep(600);
  assert.deepEqual(reasons, []);
});

test("where nothing can be watched, the timed read carries the change", { timeout: 20_000 }, async (t) => {
  const filePath = join(dirname(await temporaryConfig(t)), "missing", "provider_config.json");
  const polled = new NodePersonalProviderConfigRepository({ filePath, pollingIntervalMs: 40 });
  const writer = writerOf(filePath);
  t.after(() => {
    polled.dispose();
    writer.dispose();
  });
  const reasons = reportsOf(polled);
  // The directory does not exist yet: there is nothing to watch.
  await polled.read();
  await mkdir(dirname(filePath), { recursive: true });
  await writer.update(selectModel("model-a"));
  await waitFor(() => reasons.length > 0, "the timed read reports the change");
  assert.deepEqual(reasons, ["poll-changed"]);
});

test("a file caught half written is read again, not reported as broken", { timeout: 20_000 }, async (t) => {
  const filePath = await temporaryConfig(t);
  const errors: unknown[] = [];
  const watcher = new NodePersonalProviderConfigRepository({
    filePath,
    onPollingError: (error) => errors.push(error),
  });
  const writer = writerOf(filePath);
  t.after(() => {
    watcher.dispose();
    writer.dispose();
  });
  const reasons = reportsOf(watcher);
  await writer.update(selectModel("model-a"));
  const first = await readFile(filePath, "utf8");
  await writer.update(selectModel("model-b"));
  const second = await readFile(filePath, "utf8");
  await writer.update(selectModel("model-a"));
  await watcher.read();

  // A writer that does not replace the file atomically, caught in the middle,
  // and finishing a little later.
  await writeFile(filePath, '{ "config": {');
  await sleep(250);
  await writeFile(filePath, second);
  await waitFor(() => reasons.length > 0, "the completed write is reported");
  await sleep(500);
  assert.deepEqual(reasons, ["poll-changed"]);
  assert.deepEqual(errors, []);
});

test("dispose closes the watch", { timeout: 20_000 }, async (t) => {
  const filePath = await temporaryConfig(t);
  const watcher = new NodePersonalProviderConfigRepository({ filePath });
  const writer = writerOf(filePath);
  t.after(() => {
    watcher.dispose();
    writer.dispose();
  });
  const reasons = reportsOf(watcher);
  await writer.update(selectModel("model-a"));
  await watcher.read();
  watcher.dispose();
  assert.deepEqual(reasons, []);

  await writer.update(selectModel("model-b"));
  await sleep(500);
  assert.deepEqual(reasons, []);
});
