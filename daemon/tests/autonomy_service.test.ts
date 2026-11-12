import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import type { OwnTimeConfig } from "../src/autonomy/own_time.ts";
import type { AutonomyExecutor, DreamActionResult } from "../src/autonomy/runner.ts";
import { AutonomyService } from "../src/autonomy/service.ts";
import { testTmp } from "./support/tmp.ts";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 30, 12);

interface World {
  service: AutonomyService;
  beats: string[];
  dream: PromiseWithResolvers<DreamActionResult>;
  clock: { now: number };
}

async function world(ownTime: Partial<OwnTimeConfig> = {}): Promise<World> {
  const clock = { now: T0 };
  const beats: string[] = [];
  const dream = Promise.withResolvers<DreamActionResult>();
  const executor: AutonomyExecutor = {
    runHeartbeatTick: async (_character, hooks) => {
      beats.push(hooks.fired.map((firing) => firing.name).join(","));
      return { events: [] };
    },
    runCompaction: async () => ({ events: [] }),
    runDeepArchive: async () => ({ events: [] }),
    runDream: async () => await dream.promise,
  };
  const service = new AutonomyService(executor, () => clock.now);
  await service.register({
    character: "ada",
    data_dir: join(await mkdtemp(testTmp("shore-autonomy-service-")), "ada"),
    config: { autonomyEnabled: true, heartbeatEnabled: true, compactionEnabled: false, minTurns: 0, maxTurns: 0, idleTriggerSecs: 0, archiveAfterSecs: 0, maxContextTokens: 0 },
    ownTime: { defaultIntervalMs: 24 * HOUR, minIntervalMs: HOUR, maxIntervalMs: 48 * HOUR, maxIdleWakes: 10, maxSilentMs: 4 * HOUR, ...ownTime },
  });
  return { service, beats, dream, clock };
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
