import { describe, expect, test } from "bun:test";

import {
  SubagentTaskManager,
  statusDetailPreview,
  subagentResultMessage,
  subagentStartedAck,
  type SubagentTaskRecord,
} from "../src/tools/subagent_tasks.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";

interface Harness {
  manager: SubagentTaskManager;
  emitted: ServerMessage[];
  settled: SubagentTaskRecord[];
}

function harness(ids: string[] = ["sa_1"]): Harness {
  const emitted: ServerMessage[] = [];
  const settled: SubagentTaskRecord[] = [];
  const queue = [...ids];
  const manager = new SubagentTaskManager({
    emit: (msg) => emitted.push(msg),
    onSettled: (task) => {
      settled.push({ ...task });
    },
    newTaskId: () => queue.shift() ?? `sa_${queue.length}`,
  });
  return { manager, emitted, settled };
}

function statusMessages(emitted: ServerMessage[]) {
  return emitted.filter((m) => m.type === "subagent_status");
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe("SubagentTaskManager", () => {
  test("a started task returns an ack and announces itself as running", () => {
    const { manager, emitted } = harness();
    const ack = manager.start({
      character: "poppy",
      name: "research",
      query: "tide tables",
      run: () => new Promise<string>(() => {}),
    });

    expect(ack).toContain("'research'");
    expect(ack).toContain("sa_1");
    expect(ack).toContain("background");

    const statuses = statusMessages(emitted);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      task_id: "sa_1",
      character: "poppy",
      name: "research",
      query: "tide tables",
      status: "running",
    });
  });

  test("a finished task announces done, then settles with the result", async () => {
    const { manager, emitted, settled } = harness();
    manager.start({
      character: "poppy",
      name: "research",
      query: "tide tables",
      run: async () => "high tide at 18:04",
    });
    await flush();

    const statuses = statusMessages(emitted);
    expect(statuses.map((m) => m.type === "subagent_status" && m.status)).toEqual([
      "running",
      "done",
    ]);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      id: "sa_1",
      status: "done",
      detail: "high tide at 18:04",
    });
  });

  test("a failed task settles as an error with the failure message", async () => {
    const { manager, emitted, settled } = harness();
    manager.start({
      character: "poppy",
      name: "research",
      query: "tide tables",
      run: async () => {
        throw new Error("model exploded");
      },
    });
    await flush();

    const statuses = statusMessages(emitted);
    expect(statuses[1]).toMatchObject({ status: "error", detail: "model exploded" });
    expect(settled[0]?.status).toBe("error");
  });

  test("a task that outruns its timeout is aborted and reported as timed out", async () => {
    const { manager, settled } = harness();
    let sawAbort = false;
    manager.start({
      character: "poppy",
      name: "research",
      query: "tide tables",
      timeoutMs: 10,
      run: (_task, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            sawAbort = true;
            reject(new Error("aborted"));
          });
        }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flush();

    expect(sawAbort).toBe(true);
    expect(settled[0]?.status).toBe("error");
    expect(settled[0]?.detail).toBe("timed out after 0s and was cancelled");
  });

  test("several tasks run concurrently and settle independently", async () => {
    const { manager, settled } = harness(["sa_1", "sa_2"]);
    let releaseSecond: ((value: string) => void) | undefined;
    manager.start({
      character: "poppy",
      name: "research",
      query: "slow one",
      run: () =>
        new Promise<string>((resolve) => {
          releaseSecond = resolve;
        }),
    });
    manager.start({
      character: "poppy",
      name: "code",
      query: "fast one",
      run: async () => "instant",
    });
    await flush();

    expect(settled.map((t) => t.id)).toEqual(["sa_2"]);
    releaseSecond?.("eventually");
    await flush();
    expect(settled.map((t) => t.id)).toEqual(["sa_2", "sa_1"]);
  });

  test("cancelAll aborts running tasks and skips result delivery", async () => {
    const { manager, settled } = harness();
    manager.start({
      character: "poppy",
      name: "research",
      query: "tide tables",
      run: (_task, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    manager.cancelAll();
    await flush();

    expect(settled).toHaveLength(0);
  });
});

describe("the messages a task produces", () => {
  const task: SubagentTaskRecord = {
    id: "sa_1",
    character: "poppy",
    name: "research",
    query: "tide tables",
    status: "done",
    detail: "high tide at 18:04",
  };

  test("the ack tells the caller not to wait, and to keep going", () => {
    const ack = subagentStartedAck(task);
    expect(ack).toContain("sa_1");
    expect(ack).toContain("will arrive");
    expect(ack).toContain("continue");
  });

  test("the result message carries id, name, status, query and result", () => {
    const text = subagentResultMessage(task);
    expect(text).toContain('task_id="sa_1"');
    expect(text).toContain('name="research"');
    expect(text).toContain('status="done"');
    expect(text).toContain("tide tables");
    expect(text).toContain("high tide at 18:04");
  });

  test("an error result is marked as one", () => {
    const text = subagentResultMessage({ ...task, status: "error", detail: "boom" });
    expect(text).toContain('status="error"');
    expect(text).toContain("boom");
  });

  test("the status broadcast only ever carries a preview of a long result", () => {
    const long = "x".repeat(5000);
    expect(statusDetailPreview(long)).toHaveLength(501);
    expect(statusDetailPreview("short")).toBe("short");
  });
});
