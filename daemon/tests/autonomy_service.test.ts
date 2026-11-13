import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import type { AutonomyExecutor, DreamActionResult, OpenedSeal, TriggerFiring, WakeHooks, WakeResult, WakeRun } from "../src/autonomy/runner.ts";
import { AutonomyService } from "../src/autonomy/service.ts";
import { decodeState, STATE_FILENAME } from "../src/autonomy/state_file.ts";
import { readCharacterState } from "../src/storage/store.ts";
import { testTmp } from "./support/tmp.ts";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 30, 12);

interface Ran {
  thread: string | undefined;
  fired: string[];
  limitMs: number;
}

interface World {
  service: AutonomyService;
  dataDir: string;
  ran: Ran[];
  compactions: string[];
  dream: PromiseWithResolvers<DreamActionResult>;
  seals: OpenedSeal[];
  clock: { now: number };
  during: { run?: (wake: WakeRun, hooks: WakeHooks) => Promise<WakeResult> | WakeResult };
  woken: () => string[];
}

async function world({ idleCompactionSecs = 0, maxIdleWakes = 10, enabled = true } = {}): Promise<World> {
  const clock = { now: T0 };
  const ran: Ran[] = [];
  const compactions: string[] = [];
  const seals: OpenedSeal[] = [];
  const during: World["during"] = {};
  const dream = Promise.withResolvers<DreamActionResult>();
  const executor: AutonomyExecutor = {
    runWake: async (_character, wake, hooks) => {
      ran.push({ thread: wake.thread, fired: wake.fired.map((firing) => firing.name), limitMs: wake.limitMs });
      return await during.run?.(wake, hooks) ?? { events: [] };
    },
    runCompaction: async (_character, reason) => {
      compactions.push(reason);
      return { events: [] };
    },
    runDeepArchive: async () => ({ events: [] }),
    runDream: async () => await dream.promise,
    openSeals: async () => seals.splice(0),
  };
  const service = new AutonomyService(executor, () => clock.now);
  const dataDir = join(await mkdtemp(testTmp("shore-autonomy-service-")), "ada");
  await service.register({
    character: "ada",
    data_dir: dataDir,
    config: { autonomyEnabled: enabled, compactionEnabled: idleCompactionSecs > 0, minTurns: 0, maxTurns: 0, idleTriggerSecs: idleCompactionSecs, archiveAfterSecs: 0, maxContextTokens: 0 },
    dormancy: { maxIdleWakes, maxSilentMs: 4 * HOUR },
  });
  const woken = (): string[] => service.log("ada", 20).filter((event) => event.kind === "tick_fired").map((event) => event.detail);
  return { service, dataDir, ran, compactions, dream, seals, clock, during, woken };
}

const fired = (name: string, over: Partial<TriggerFiring> = {}): TriggerFiring => ({ name, reason: "the lamp is low", at: T0, ...over });

test("when the user last wrote is taken from the history where nothing is on record, and never over what is", async () => {
  const { service } = await world();
  expect(service.status("ada")?.last_user_at).toBeUndefined();
  service.backfillActivity("ada", [], undefined);
  expect(service.status("ada")).toMatchObject({ state: "Active", wakes_without_user: 0, max_idle_wakes: 10, max_silent_ms: 4 * HOUR });
  expect(service.status("ada")?.last_user_at).toBeUndefined();

  service.backfillActivity("ada", [], T0 - 5 * HOUR);
  expect(service.status("ada")).toMatchObject({ last_user_at: T0 - 5 * HOUR, state: "Dormant" });
  service.backfillActivity("ada", [], T0 - HOUR);
  expect(service.status("ada")?.last_user_at).toBe(T0 - 5 * HOUR);
});

test("what fired together wakes the character once for each thread, the own-time thread among them, each for the longest limit asked of it or 30 minutes", async () => {
  const { service, ran, woken } = await world();
  service.wakeFor("ada", fired("lamp"));
  service.wakeFor("ada", fired("song", { thread: "ring", limitMs: 10 * MINUTE }));
  service.wakeFor("ada", fired("tide", { limitMs: 5 * MINUTE }));
  service.wakeFor("ada", fired("verse", { thread: "ring", limitMs: 45 * MINUTE }));
  service.wakeFor("ada", fired("weeds", { thread: "garden", limitMs: 12 * MINUTE }));
  await service.tick();

  expect(ran).toEqual([
    { thread: undefined, fired: ["lamp", "tide"], limitMs: 1_800_000 },
    { thread: "ring", fired: ["song", "verse"], limitMs: 45 * MINUTE },
    { thread: "garden", fired: ["weeds"], limitMs: 12 * MINUTE },
  ]);
  expect(woken()).toEqual(['Woken by trigger "lamp", "tide"', 'Woken in "ring" by trigger "song", "verse"', 'Woken in "garden" by trigger "weeds"']);
  await service.tick();
  expect(ran).toHaveLength(3);
});

test("a wake waits until the user has been quiet in its thread for ten minutes, and one in the own-time thread never waits", async () => {
  const { service, ran, clock } = await world();
  service.userActiveIn("ada", "ring");
  clock.now = T0 + 10 * MINUTE - 1;
  service.wakeFor("ada", fired("song", { thread: "ring" }));
  service.wakeFor("ada", fired("lamp"));
  await service.tick();
  expect(ran.map((each) => each.thread)).toEqual([undefined]);

  clock.now = T0 + 10 * MINUTE;
  await service.tick();
  expect(ran.map((each) => each.thread)).toEqual([undefined, "ring"]);
});

test("a running wake can be asked whether the user has written in its thread since it started", async () => {
  const { service, ran, during } = await world();
  const heard: boolean[] = [];
  during.run = (wake) => {
    heard.push(wake.interrupted());
    service.userActiveIn("ada", "garden");
    heard.push(wake.interrupted());
    service.userActiveIn("ada", wake.thread ?? "own-time");
    heard.push(wake.interrupted());
    return { events: [] };
  };
  service.wakeFor("ada", fired("song", { thread: "ring" }));
  await service.tick();
  service.wakeFor("ada", fired("lamp"));
  await service.tick();
  expect(ran.map((each) => each.thread)).toEqual(["ring", undefined]);
  expect(heard).toEqual([false, false, true, false, false, false]);
});

test("while a wake runs, the character counts as having one more wake without the user, on record before the wake does anything", async () => {
  const { service, dataDir, during } = await world();
  const seen: unknown[] = [];
  during.run = (wake) => {
    seen.push(service.runningWake("ada"), service.runningWakes(), service.status("ada")?.wakes_without_user);
    seen.push(decodeState(readCharacterState(dataDir, STATE_FILENAME) ?? "")?.wakesWithoutUser, wake.thread);
    return { events: [] };
  };
  expect(service.runningWake("ada")).toBeUndefined();
  service.wakeFor("ada", fired("song", { thread: "ring" }));
  await service.tick();
  expect(seen).toEqual([{ startedAt: T0, thread: "ring", news: [], firings: [fired("song", { thread: "ring" })], userTold: false }, [{ character: "ada", startedAt: T0 }], 1, 1, "ring"]);
  expect([service.runningWake("ada"), service.runningWakes()]).toEqual([undefined, []]);
});

test("a dormant character is woken by nothing but a seal coming off, and what came due meanwhile is not made up", async () => {
  const { service, ran, seals, clock, woken } = await world({ maxIdleWakes: 2 });
  service.wakeFor("ada", fired("lamp"));
  await service.tick();
  service.wakeFor("ada", fired("tide"));
  await service.tick();
  expect(service.status("ada")).toMatchObject({ state: "Dormant", wakes_without_user: 2 });

  service.wakeFor("ada", fired("ferry"));
  seals.push({ thread: "gift", reason: "It is open." });
  await service.tick();
  expect(ran.map((each) => [each.thread, each.fired])).toEqual([[undefined, ["lamp"]], [undefined, ["tide"]], ["gift", [""]]]);
  expect(woken().at(-1)).toBe('Woken in "gift" by its seal coming off');
  expect(service.log("ada", 20).filter((event) => event.kind === "dormant").map((event) => event.detail)).toEqual(["Went dormant (wakes without the user: 2)"]);

  clock.now = T0 + HOUR;
  service.onUserMessage("ada", 1, clock.now);
  expect(service.status("ada")).toMatchObject({ state: "Active", wakes_without_user: 0 });
  await service.tick();
  expect(ran).toHaveLength(3);
});

test("a wake started by hand runs in the own-time thread unless the character is dormant, and making it dormant or active starts none", async () => {
  const { service, ran, woken } = await world();
  expect(service.wakeNow("ada")).toBe(false);
  await service.tick();
  expect(ran).toEqual([{ thread: undefined, fired: [""], limitMs: 30 * MINUTE }]);
  expect(woken()).toEqual(["Woken by a start by hand"]);

  expect(service.forceDormancy("ada", "dormant")).toBe(true);
  expect(service.status("ada")?.state).toBe("Dormant");
  expect(service.wakeNow("ada")).toBe(true);
  await service.tick();
  expect(ran).toHaveLength(1);

  expect(service.forceDormancy("ada", "active")).toBe(true);
  expect(service.status("ada")).toMatchObject({ state: "Active", wakes_without_user: 0, last_user_at: T0 });
  await service.tick();
  expect(ran).toHaveLength(1);

  expect(service.wakeNow("nobody")).toBeUndefined();
  expect(service.forceDormancy("nobody", "active")).toBe(false);
});

test("the log says what woke the character: triggers by name, a hand-off by the thread it came from, a seal, a start by hand", async () => {
  const { service, woken } = await world();
  service.wakeFor("ada", fired("song", { thread: "ring" }));
  service.requestWake("ada", fired("", { thread: "ring", from: "main" }), false);
  await service.tick();
  expect(woken()).toEqual(['Woken in "ring" by trigger "song" and a hand-off from "main"']);
});

test("with the user's switch off nothing wakes the character, and what fired is let go", async () => {
  const { service, ran } = await world({ enabled: false });
  expect(service.wakesMayRun("ada")).toBe(false);
  expect(service.wakesMayRun("nobody")).toBe(false);
  service.wakeFor("ada", fired("lamp"));
  await service.tick();
  await service.tick();
  expect(ran).toEqual([]);
  expect((await world()).service.wakesMayRun("ada")).toBe(true);
});

test("the user's new dormancy settings take effect at the next look", async () => {
  const { service, ran } = await world();
  service.wakeFor("ada", fired("lamp"));
  await service.tick();
  service.setDormancyConfig("ada", { maxIdleWakes: 1, maxSilentMs: 4 * HOUR });
  expect(service.status("ada")).toMatchObject({ state: "Dormant", max_idle_wakes: 1 });
  service.wakeFor("ada", fired("tide"));
  await service.tick();
  expect(ran).toHaveLength(1);
});

test("nothing wakes the character while it is dreaming, and what came due meanwhile wakes it once the dream is over", async () => {
  const { service, ran, dream, clock } = await world();
  expect(service.forceDreamNow("ada")).toBe("queued");
  await service.tick();
  expect(service.runningDreams()).toEqual([{ character: "ada", startedAt: T0 }]);

  clock.now = T0 + HOUR;
  expect(service.wakeFor("ada", fired("lamp"))).toBe("queued");
  await service.tick();
  expect(ran).toEqual([]);

  dream.resolve({ events: [], dream: "finished" });
  await service.dreamsEnded();
  await service.tick();
  expect(ran.map((each) => each.fired)).toEqual([["lamp"]]);
  await service.shutdown();
});

test("a dream that is due waits for the next look when this one woke the character, in any thread, or compacted its home thread", async () => {
  for (const thread of [undefined, "ring"]) {
    const woken = await world();
    expect(woken.service.forceDreamNow("ada")).toBe("queued");
    expect(woken.service.wakeFor("ada", fired("lamp", { thread }))).toBe("queued");
    await woken.service.tick();
    expect([woken.ran.map((each) => each.thread), woken.service.runningDreams()]).toEqual([[thread], []]);
    await woken.service.tick();
    expect(woken.service.runningDreams()).toEqual([{ character: "ada", startedAt: T0 }]);
    woken.dream.resolve({ events: [], dream: "finished" });
    await woken.service.shutdown();
  }

  const waiting = await world();
  waiting.service.userActiveIn("ada", "ring");
  expect(waiting.service.forceDreamNow("ada")).toBe("queued");
  waiting.service.wakeFor("ada", fired("song", { thread: "ring" }));
  await waiting.service.tick();
  expect([waiting.ran, waiting.service.runningDreams()]).toEqual([[], [{ character: "ada", startedAt: T0 }]]);
  waiting.dream.resolve({ events: [], dream: "finished" });
  await waiting.service.shutdown();

  const compacted = await world({ idleCompactionSecs: 60 });
  expect(compacted.service.forceDreamNow("ada")).toBe("queued");
  compacted.clock.now = T0 + 60_000;
  await compacted.service.tick();
  expect([compacted.compactions, compacted.service.runningDreams()]).toEqual([["idle"], []]);
  await compacted.service.tick();
  expect([compacted.compactions, compacted.service.runningDreams()]).toEqual([["idle"], [{ character: "ada", startedAt: T0 + 60_000 }]]);
  compacted.dream.resolve({ events: [], dream: "finished" });
  await compacted.service.shutdown();
});
