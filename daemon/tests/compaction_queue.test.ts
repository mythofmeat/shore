import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";

import type { LoadedConfig } from "../src/config/loader.ts";
import { shoreLog } from "../src/log.ts";
import { compactLater, stopBackgroundCompactions, type CompactionCompletion } from "../src/memory/compaction/background.ts";
import { compactAfterTurn, maybeCompact, type CompactionRunner } from "../src/handler/turn.ts";
import { turnAutonomy } from "../src/handler/deps.ts";
import type { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import { testTmp } from "./support/tmp.ts";
import { until } from "./support/until.ts";

const CONFIG = {} as LoadedConfig;
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await stopBackgroundCompactions(root);
});

async function dataDir(): Promise<string> {
  const root = await mkdtemp(testTmp("shore-compaction-queue-"));
  roots.push(root);
  return root;
}

function held(): { started: () => boolean; release: () => void; run: () => Promise<void> } {
  let started = false;
  const { promise, resolve } = Promise.withResolvers<void>();
  return {
    started: () => started,
    release: () => { resolve(); },
    run: async () => { started = true; await promise; },
  };
}

describe("archives queued after a turn", () => {
  test("wait one at a time for each character, are asked for once per thread while they wait, and can be asked for again once done", async () => {
    const data = await dataDir();
    const home = held();
    const side = held();
    let again = 0;
    compactLater(data, "ada", "main", home.run);
    compactLater(data, "ada", "main", async () => { again += 1; });
    compactLater(data, "ada", "side", side.run);
    let other = 0;
    compactLater(data, "bo", "main", async () => { other += 1; });
    await until(() => home.started() && other === 1, "home and the other character's archive starting");
    expect(side.started()).toBe(false);
    home.release();
    await until(side.started, "the side thread's archive starting once home's is done");
    compactLater(data, "ada", "main", async () => { again += 1; });
    side.release();
    await until(() => again > 0, "home's archive, asked for again once done, running");
    await stopBackgroundCompactions(data);
    expect(again).toBe(1);
  });

  test("that fail are logged, and the archives after them still run", async () => {
    const data = await dataDir();
    const warned = spyOn(shoreLog, "warn").mockImplementation(() => {});
    try {
      let ran = 0;
      compactLater(data, "ada", "main", () => Promise.reject(new Error("disk full")));
      compactLater(data, "ada", "side", async () => { ran += 1; });
      await until(() => ran > 0, "the archive after the failed one running");
      expect(ran).toBe(1);
      expect(warned.mock.calls.map(([line]) => String(line))).toEqual(["shore: background compaction for ada/main failed: Error: disk full"]);
    } finally {
      warned.mockRestore();
    }
  });

  test("aren't started while their daemon is stopping, which waits for the one running", async () => {
    const data = await dataDir();
    const home = held();
    let started = 0;
    compactLater(data, "ada", "main", home.run);
    compactLater(data, "ada", "side", async () => { started += 1; });
    await until(home.started, "home's archive starting");
    let stopped = false;
    const stopping = stopBackgroundCompactions(data).then(() => { stopped = true; });
    compactLater(data, "ada", "story", async () => { started += 1; });
    await Bun.sleep(20);
    expect(stopped).toBe(false);
    home.release();
    await stopping;
    expect(started).toBe(0);
    compactLater(data, "ada", "story", async () => { started += 1; });
    await until(() => started > 0, "an archive asked for after the stop running");
    expect(started).toBe(1);
  });
});

describe("an archive after a turn", () => {
  function autonomy(compact = true) {
    const told: string[] = [];
    return {
      told,
      ctx: { autonomy: {
        shouldCompactNow: () => compact,
        onCompactionComplete: (character: string, retained: number) => { told.push(`${character} complete, ${String(retained)} kept`); },
        onCompactionFailed: (character: string) => { told.push(`${character} failed`); },
      } },
    };
  }

  function runner(outcome: () => Promise<CompactionCompletion>, threads: (string | undefined)[] = []): CompactionRunner {
    return {
      run: async (_character, _config, thread) => { threads.push(thread); return await outcome(); },
      applyDeferredEdits: async () => {},
    };
  }

  test("tells the wake runner it finished and how many turns it kept, or that it didn't, whether it was skipped or threw", async () => {
    const warned = spyOn(shoreLog, "warn").mockImplementation(() => {});
    try {
      const done = autonomy();
      await compactAfterTurn(done.ctx, "ada", CONFIG, "main", runner(async () => ({ kind: "completed", retained: 2 })));
      const skipped = autonomy();
      await compactAfterTurn(skipped.ctx, "ada", CONFIG, "main", runner(async () => ({ kind: "skipped", reason: "empty_or_changed" })));
      const threw = autonomy();
      await compactAfterTurn(threw.ctx, "ada", CONFIG, "main", runner(() => Promise.reject(new Error("busy"))));
      expect([done.told, skipped.told, threw.told]).toEqual([["ada complete, 2 kept"], ["ada failed"], ["ada failed"]]);
      expect(warned.mock.calls.map(([line]) => String(line))).toEqual(["shore: compaction after a turn failed for ada/main: Error: busy"]);
    } finally {
      warned.mockRestore();
    }
  });

  test("is queued for the thread the turn was in only when the wake runner says it is time", async () => {
    const data = await dataDir();
    const threads: (string | undefined)[] = [];
    const engine = (thread: string) => ({ thread, userTurnCount: () => 4 });
    await maybeCompact(autonomy(false).ctx, engine("side"), "ada", CONFIG, data, 10, runner(async () => ({ kind: "completed", retained: 0 }), threads), false);
    await stopBackgroundCompactions(data);
    expect(threads).toEqual([]);
    await maybeCompact(autonomy().ctx, engine("side"), "ada", CONFIG, data, 10, runner(async () => ({ kind: "completed", retained: 0 }), threads), false);
    await until(() => threads.length > 0, "the archive being queued and run");
    expect(threads).toEqual(["side"]);
  });

  test("finished or failed, is passed on to the wake runner", () => {
    const told: string[] = [];
    const bridge = {
      onCompactionComplete: (character: string, retained: number) => { told.push(`${character} complete, ${String(retained)} kept`); },
      onCompactionFailed: (character: string) => { told.push(`${character} failed`); },
    } as unknown as TurnAutonomyBridge;
    const wired = turnAutonomy(bridge, { set: () => {} });
    wired.onCompactionComplete("ada", 2);
    wired.onCompactionFailed("ada");
    expect(told).toEqual(["ada complete, 2 kept", "ada failed"]);
  });
});
