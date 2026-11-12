import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import type { AutonomyExecutor, DreamActionResult } from "../src/autonomy/runner.ts";
import { AutonomyService } from "../src/autonomy/service.ts";
import { testTmp } from "./support/tmp.ts";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 30, 12);

interface World {
  service: AutonomyService;
  beats: string[];
  compactions: string[];
  dream: PromiseWithResolvers<DreamActionResult>;
  clock: { now: number };
}

async function world(idleCompactionSecs = 0): Promise<World> {
  const clock = { now: T0 };
  const beats: string[] = [];
  const compactions: string[] = [];
  const dream = Promise.withResolvers<DreamActionResult>();
  const executor: AutonomyExecutor = {
    runHeartbeatTick: async (_character, hooks) => {
      beats.push(hooks.fired.map((firing) => firing.name).join(","));
      return { events: [] };
    },
    runCompaction: async (_character, reason) => {
      compactions.push(reason);
      return { events: [] };
    },
    runDeepArchive: async () => ({ events: [] }),
    runDream: async () => await dream.promise,
  };
  const service = new AutonomyService(executor, () => clock.now);
  await service.register({
    character: "ada",
    data_dir: join(await mkdtemp(testTmp("shore-autonomy-service-")), "ada"),
    config: { autonomyEnabled: true, heartbeatEnabled: true, compactionEnabled: idleCompactionSecs > 0, minTurns: 0, maxTurns: 0, idleTriggerSecs: idleCompactionSecs, archiveAfterSecs: 0, maxContextTokens: 0 },
    ownTime: { defaultIntervalMs: 24 * HOUR, minIntervalMs: HOUR, maxIntervalMs: 48 * HOUR, maxIdleWakes: 10, maxSilentMs: 4 * HOUR },
  });
  return { service, beats, compactions, dream, clock };
}

test("when the user last wrote is taken from the history where nothing is on record, and never over what is", async () => {
  const { service } = await world();
  expect(service.status("ada")?.last_user_at).toBeUndefined();
  service.backfillActivity("ada", [], undefined);
  expect(service.status("ada")).toMatchObject({ heartbeat_state: "Active" });
  expect(service.status("ada")?.last_user_at).toBeUndefined();

  service.backfillActivity("ada", [], T0 - 5 * HOUR);
  expect(service.status("ada")).toMatchObject({ last_user_at: T0 - 5 * HOUR, heartbeat_state: "Dormant" });
  service.backfillActivity("ada", [], T0 - HOUR);
  expect(service.status("ada")?.last_user_at).toBe(T0 - 5 * HOUR);
});

test("nothing wakes the character while it is dreaming, and what came due meanwhile wakes it once the dream is over", async () => {
  const { service, beats, dream, clock } = await world();
  expect(service.forceDreamNow("ada")).toBe("queued");
  await service.tick();
  expect(service.runningDreams()).toEqual([{ character: "ada", startedAt: T0 }]);

  clock.now = T0 + HOUR;
  expect(service.wakeFor("ada", { name: "lamp", reason: "the lamp is low", at: clock.now })).toBe("queued");
  await service.tick();
  expect(beats).toEqual([]);

  dream.resolve({ events: [], dream: "finished" });
  await service.dreamsEnded();
  await service.tick();
  expect(beats).toEqual(["lamp"]);
  await service.shutdown();
});

test("a dream that is due waits for the next look when this one woke the character or compacted its home thread", async () => {
  const woken = await world();
  expect(woken.service.forceDreamNow("ada")).toBe("queued");
  expect(woken.service.wakeFor("ada", { name: "lamp", reason: "the lamp is low", at: T0 })).toBe("queued");
  await woken.service.tick();
  expect([woken.beats, woken.service.runningDreams()]).toEqual([["lamp"], []]);
  await woken.service.tick();
  expect(woken.service.runningDreams()).toEqual([{ character: "ada", startedAt: T0 }]);
  woken.dream.resolve({ events: [], dream: "finished" });
  await woken.service.shutdown();

  const compacted = await world(60);
  expect(compacted.service.forceDreamNow("ada")).toBe("queued");
  compacted.clock.now = T0 + 60_000;
  await compacted.service.tick();
  expect([compacted.compactions, compacted.service.runningDreams()]).toEqual([["idle"], []]);
  await compacted.service.tick();
  expect([compacted.compactions, compacted.service.runningDreams()]).toEqual([["idle"], [{ character: "ada", startedAt: T0 + 60_000 }]]);
  compacted.dream.resolve({ events: [], dream: "finished" });
  await compacted.service.shutdown();
});
