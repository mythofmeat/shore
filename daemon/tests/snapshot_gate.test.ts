import { describe, expect, test } from "bun:test";

import { SnapshotGate } from "../src/snapshot_gate.ts";
import { outcomeOf } from "./support/outcome.ts";

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

  test("activity that stops waiting leaves the queue, and the snapshot ahead of it and the work behind it still run", async () => {
    const gate = new SnapshotGate();
    const events: string[] = [];
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const first = gate.withActivity(async () => {
      await held;
    });
    await Promise.resolve();
    const snapshot = gate.withSnapshot(async () => {
      events.push("snapshot");
    });
    const stop = new AbortController();
    const waiting = gate.withActivity(async () => {
      events.push("abandoned");
    }, stop.signal);
    const behind = gate.withActivity(async () => {
      events.push("behind");
    });
    stop.abort(new Error("stopped"));
    expect(await outcomeOf(waiting)).toThrow("stopped");
    release();
    await Promise.all([first, snapshot, behind]);
    await gate.withSnapshot(async () => {
      events.push("next snapshot");
    });
    expect(events).toEqual(["snapshot", "behind", "next snapshot"]);
  });

  test("activity asked for with a signal already stopped never runs", async () => {
    const gate = new SnapshotGate();
    const stop = new AbortController();
    stop.abort(new Error("already stopped"));
    let ran = false;
    expect(await outcomeOf(gate.withActivity(async () => {
      ran = true;
    }, stop.signal))).toThrow("already stopped");
    expect(ran).toBe(false);
    expect(await gate.withSnapshot(async () => "taken")).toBe("taken");
  });

  test("stopping a signal after its activity started leaves the queue behind it alone", async () => {
    const gate = new SnapshotGate();
    const stop = new AbortController();
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const running = gate.withActivity(async () => {
      await held;
      return "finished";
    }, stop.signal);
    await Promise.resolve();
    const snapshot = gate.withSnapshot(async () => "taken");
    stop.abort(new Error("stopped late"));
    release();
    expect(await running).toBe("finished");
    expect(await snapshot).toBe("taken");
  });

  test("a running snapshot holds back activity asked for during it and activity queued behind it", async () => {
    const gate = new SnapshotGate();
    const events: string[] = [];
    const { promise: readerHeld, resolve: releaseReader } = Promise.withResolvers<void>();
    const { promise: snapshotHeld, resolve: releaseSnapshot } = Promise.withResolvers<void>();
    const reader = gate.withActivity(async () => {
      await readerHeld;
    });
    await Promise.resolve();
    const snapshot = gate.withSnapshot(async () => {
      events.push("snapshot");
      await snapshotHeld;
      events.push("snapshot done");
    });
    const queued = gate.withActivity(async () => {
      events.push("queued");
    });
    releaseReader();
    await reader;
    await Promise.resolve();
    const during = gate.withActivity(async () => {
      events.push("during");
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["snapshot"]);
    releaseSnapshot();
    await Promise.all([snapshot, queued, during]);
    expect(events).toEqual(["snapshot", "snapshot done", "queued", "during"]);
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
