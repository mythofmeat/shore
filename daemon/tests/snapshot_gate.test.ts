import { describe, expect, test } from "bun:test";

import { SnapshotGate } from "../src/snapshot_gate.ts";

describe("SnapshotGate", () => {
  test("a snapshot waits for activity and blocks work queued behind it", async () => {
    const gate = new SnapshotGate();
    const events: string[] = [];
    let releaseFirst = () => {};
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = gate.withActivity(async () => {
      events.push("first-start");
      await held;
      events.push("first-end");
    });
    await Promise.resolve();
    const snapshot = gate.withSnapshot(async () => {
      events.push("snapshot");
    });
    const second = gate.withActivity(async () => {
      events.push("second");
    });
    await Promise.resolve();
    expect(events).toEqual(["first-start"]);

    releaseFirst();
    await Promise.all([first, snapshot, second]);
    expect(events).toEqual(["first-start", "first-end", "snapshot", "second"]);
  });

  test("ordinary activity can overlap", async () => {
    const gate = new SnapshotGate();
    let active = 0;
    let peak = 0;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await held;
      active -= 1;
    };
    const both = [gate.withActivity(run), gate.withActivity(run)];
    await Promise.resolve();
    expect(peak).toBe(2);
    release();
    await Promise.all(both);
  });
});
