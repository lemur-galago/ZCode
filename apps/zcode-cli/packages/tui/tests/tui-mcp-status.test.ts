// Local patch (mcp-status-on-change).
import assert from "node:assert/strict";
import test from "node:test";
import { testRender } from "@mbears/opentui-react/test-utils";
import type { McpServerStatus } from "@zcode/contracts";
import React, { act } from "react";
import { sameMcpStatuses, useMcpSidebarStatus } from "../src/app-mcp-status.js";

const status = (overrides: Partial<McpServerStatus> = {}): McpServerStatus => ({
  status: "connected",
  toolCount: 3,
  transport: "stdio",
  updatedAt: "2026-11-27T10:00:00.000Z",
  ...overrides,
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("statuses compare by content, and the timestamp is not content", () => {
  assert.equal(sameMcpStatuses({ fs: status() }, { fs: status() }), true);
  // The lister stamps the current time on every server without a live status.
  assert.equal(sameMcpStatuses({ fs: status() }, { fs: status({ updatedAt: "later" }) }), true);
  assert.equal(sameMcpStatuses({}, {}), true);
  assert.equal(sameMcpStatuses({ fs: status() }, { fs: status({ toolCount: 4 }) }), false);
  assert.equal(
    sameMcpStatuses({ fs: status() }, { fs: status({ error: "down", status: "failed" }) }),
    false,
  );
  assert.equal(sameMcpStatuses({ fs: status() }, { fs: status(), git: status() }), false);
  assert.equal(sameMcpStatuses({ fs: status(), git: status() }, { fs: status() }), false);
  // Nested values compare by content as well.
  assert.equal(
    sameMcpStatuses(
      { fs: status({ workspaceTrust: { reviewed: true } as McpServerStatus["workspaceTrust"] }) },
      { fs: status({ workspaceTrust: { reviewed: true } as McpServerStatus["workspaceTrust"] }) },
    ),
    true,
  );
});

type View = Awaited<ReturnType<typeof testRender>>;

// Mounts the probe component; the effect that starts the polling runs when the
// act scope ends.
async function mount(element: React.ReactElement): Promise<View> {
  let view: View | undefined;
  await act(async () => {
    view = await testRender(element, { height: 3, width: 40 });
    await view.renderOnce();
  });
  assert.ok(view);
  return view;
}

// Waits, in one act scope, until the list was read `until` times.
async function waitReads(view: View, counter: { reads: number }, until: number): Promise<void> {
  await act(async () => {
    for (let attempt = 0; attempt < 400 && counter.reads < until; attempt += 1) {
      await sleep(5);
    }
    await view.renderOnce();
  });
  assert.ok(counter.reads >= until, `the list was read ${until} times`);
}

// Counts the commits of the component (a layout effect without dependencies
// runs after each of them). React may call the component and then bail out
// without committing, so calls are not commits: only a commit asks for a frame.
function useCommitCounter(): { commits: number } {
  const counter = React.useRef({ commits: 0 }).current;
  React.useLayoutEffect(() => {
    counter.commits += 1;
  });
  return counter;
}

test("an unchanged list is not stored again, so nothing is committed for it", async () => {
  const counter = { reads: 0 };
  let listed: Record<string, McpServerStatus> = { fs: status() };
  const listMcpServers = async (): Promise<Record<string, McpServerStatus>> => {
    counter.reads += 1;
    // A new object on every read, with a fresh timestamp, as the lister returns.
    return Object.fromEntries(
      Object.entries(listed).map(([name, server]) => [
        name,
        { ...server, updatedAt: new Date().toISOString() },
      ]),
    );
  };
  let commits: { commits: number } = { commits: 0 };
  function Probe() {
    useMcpSidebarStatus(listMcpServers, { refreshIntervalMs: 5 });
    commits = useCommitCounter();
    return React.createElement("text", null, "probe");
  }
  const view = await mount(React.createElement(Probe));

  try {
    await waitReads(view, counter, 3);
    // The mount, and the first list arriving.
    assert.equal(commits.commits, 2);
    await waitReads(view, counter, 14);
    assert.equal(commits.commits, 2);

    // A real change is stored and committed.
    listed = { fs: status({ error: "down", status: "failed" }) };
    await waitReads(view, counter, 18);
    assert.equal(commits.commits, 3);
    await waitReads(view, counter, 26);
    assert.equal(commits.commits, 3);
  } finally {
    await act(async () => {
      view.renderer.destroy();
    });
  }
});

test("a failing read stores its error once, and a recovered list clears it", async () => {
  const counter = { reads: 0 };
  let failing = true;
  const listMcpServers = async (): Promise<Record<string, McpServerStatus>> => {
    counter.reads += 1;
    if (failing) throw new Error("offline");
    return { fs: status() };
  };
  let commits: { commits: number } = { commits: 0 };
  const errors: Array<string | undefined> = [];
  function Probe() {
    const state = useMcpSidebarStatus(listMcpServers, { refreshIntervalMs: 5, retryIntervalMs: 5 });
    commits = useCommitCounter();
    React.useLayoutEffect(() => {
      errors.push(state.error);
    });
    return React.createElement("text", null, "probe");
  }
  const view = await mount(React.createElement(Probe));

  try {
    await waitReads(view, counter, 4);
    // The mount, and the error of the first read.
    assert.equal(commits.commits, 2);
    assert.deepEqual(errors, [undefined, "offline"]);
    await waitReads(view, counter, 12);
    assert.equal(commits.commits, 2);

    failing = false;
    await waitReads(view, counter, 16);
    assert.equal(commits.commits, 3);
    assert.equal(errors.at(-1), undefined);
  } finally {
    await act(async () => {
      view.renderer.destroy();
    });
  }
});

test("without a reader nothing is polled", async () => {
  const commits = { commits: 0 };
  function Probe() {
    useMcpSidebarStatus(undefined);
    React.useLayoutEffect(() => {
      commits.commits += 1;
    });
    return React.createElement("text", null, "probe");
  }
  const view = await mount(React.createElement(Probe));
  try {
    const afterMount = commits.commits;
    await act(async () => {
      await sleep(40);
      await view.renderOnce();
    });
    assert.equal(commits.commits, afterMount);
  } finally {
    await act(async () => {
      view.renderer.destroy();
    });
  }
});
