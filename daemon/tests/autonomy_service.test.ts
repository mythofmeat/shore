import { expect, spyOn, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import type { AutonomyActionResult, AutonomyExecutor, OpenedSeal, TriggerFiring, WakeHooks, WakeResult, WakeRun } from "../src/autonomy/runner.ts";
import { AutonomyService } from "../src/autonomy/service.ts";
import { decodeState, STATE_FILENAME } from "../src/autonomy/state_file.ts";
import { shoreLog } from "../src/log.ts";
import { readCharacterState } from "../src/storage/store.ts";
import type { KeepaliveService } from "../src/cache/keepalive.ts";
import { outcomeOf } from "./support/outcome.ts";
import { until } from "./support/until.ts";
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
  archives: string[];
  seals: OpenedSeal[];
  clock: { now: number };
  during: { run?: (wake: WakeRun, hooks: WakeHooks) => Promise<WakeResult> | WakeResult; look?: () => Promise<void> };
  woken: () => string[];
}

interface WorldOptions {
  idleCompactionSecs?: number;
  archiveAfterSecs?: number;
  compaction?: boolean;
  minTurns?: number;
  maxIdleWakes?: number;
  enabled?: boolean;
  archived?: AutonomyActionResult;
}

async function world({ idleCompactionSecs = 0, archiveAfterSecs = 0, compaction = true, minTurns = 0, maxIdleWakes = 10, enabled = true, archived = { events: [] } }: WorldOptions = {}): Promise<World> {
  const clock = { now: T0 };
  const ran: Ran[] = [];
  const compactions: string[] = [];
  const archives: string[] = [];
  const seals: OpenedSeal[] = [];
  const during: World["during"] = {};
  const executor: AutonomyExecutor = {
    homeThread: () => "main",
    runWake: async (_character, wake, hooks) => {
      ran.push({ thread: wake.thread, fired: wake.fired.map((firing) => firing.name), limitMs: wake.limitMs });
      return await during.run?.(wake, hooks) ?? { events: [] };
    },
    runCompaction: async (_character, reason) => {
      compactions.push(reason);
      return { events: [] };
    },
    runDeepArchive: async (character) => {
      archives.push(character);
      return archived;
    },
    openSeals: async () => {
      await during.look?.();
      return seals.splice(0);
    },
  };
  const service = new AutonomyService(executor, () => clock.now);
  const dataDir = join(await mkdtemp(testTmp("shore-autonomy-service-")), "ada");
  await service.register({
    character: "ada",
    data_dir: dataDir,
    config: { autonomyEnabled: enabled, compactionEnabled: compaction, minTurns, maxTurns: 0, idleTriggerSecs: idleCompactionSecs, archiveAfterSecs, maxContextTokens: 0 },
    dormancy: { maxIdleWakes, maxSilentMs: 4 * HOUR },
  });
  const woken = (): string[] => service.log("ada", 20).filter((event) => event.kind === "tick_fired").map((event) => event.detail);
  return { service, dataDir, ran, compactions, archives, seals, clock, during, woken };
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

test("what fired together wakes the character once for each thread, home for a trigger that names none, each for the longest limit asked of it or 30 minutes", async () => {
  const { service, ran, woken } = await world();
  service.wakeFor("ada", fired("lamp"));
  service.wakeFor("ada", fired("song", { thread: "ring", limitMs: 10 * MINUTE }));
  service.wakeFor("ada", fired("tide", { limitMs: 5 * MINUTE }));
  service.wakeFor("ada", fired("verse", { thread: "ring", limitMs: 45 * MINUTE }));
  service.wakeFor("ada", fired("weeds", { thread: "garden", limitMs: 12 * MINUTE }));
  service.wakeFor("ada", fired("door", { thread: "main" }));
  await service.runDue();

  expect(ran).toEqual([
    { thread: "main", fired: ["lamp", "tide", "door"], limitMs: 1_800_000 },
    { thread: "ring", fired: ["song", "verse"], limitMs: 45 * MINUTE },
    { thread: "garden", fired: ["weeds"], limitMs: 12 * MINUTE },
  ]);
  expect(woken()).toEqual(['Woken in "main" by trigger "lamp", "tide", "door"', 'Woken in "ring" by trigger "song", "verse"', 'Woken in "garden" by trigger "weeds"']);
  await service.runDue();
  expect(ran).toHaveLength(3);
});

test("a wake waits until the user has been quiet in its thread for ten minutes, home included", async () => {
  const { service, ran, clock } = await world();
  service.userActiveIn("ada", "ring");
  clock.now = T0 + 10 * MINUTE - 1;
  service.wakeFor("ada", fired("song", { thread: "ring" }));
  service.wakeFor("ada", fired("lamp"));
  await service.runDue();
  expect(ran.map((each) => each.thread)).toEqual(["main"]);

  clock.now = T0 + 10 * MINUTE;
  await service.runDue();
  expect(ran.map((each) => each.thread)).toEqual(["main", "ring"]);

  service.userActiveIn("ada", "main");
  service.wakeFor("ada", fired("lamp"));
  clock.now = T0 + 20 * MINUTE - 1;
  await service.runDue();
  expect(ran.map((each) => each.thread)).toEqual(["main", "ring"]);
  clock.now = T0 + 20 * MINUTE;
  await service.runDue();
  expect(ran.map((each) => each.thread)).toEqual(["main", "ring", "main"]);
});

test("a wake started by hand doesn't wait for the user to be quiet in home, but once they stop it by writing there it waits like any other", async () => {
  const { service, ran, clock, during, woken } = await world();
  service.userActiveIn("ada", "main");
  clock.now = T0 + MINUTE;
  during.run = () => ({ events: [], interrupted: true });
  service.wakeFor("ada", fired("lamp"));
  await service.runDue();
  expect(ran).toEqual([]);

  expect(service.wakeNow("ada")).toBe(false);
  await service.runDue();
  expect(ran).toEqual([{ thread: "main", fired: ["lamp", ""], limitMs: 30 * MINUTE }]);
  expect(woken()).toEqual(['Woken in "main" by trigger "lamp" and a start by hand']);

  await service.runDue();
  clock.now = T0 + 10 * MINUTE - 1;
  await service.runDue();
  expect(ran).toHaveLength(1);
  clock.now = T0 + 10 * MINUTE;
  await service.runDue();
  expect(ran).toHaveLength(2);
});

test("a tick that fails says so to whoever asked for it, naming the character, and the next tick runs", async () => {
  const { service, ran, during } = await world();
  during.run = () => { throw new Error("the lamp went out"); };
  service.wakeFor("ada", fired("lamp"));
  expect(await outcomeOf(service.runDue())).toThrow("autonomy tick failed for ada: Error: the lamp went out");

  during.run = () => ({ events: [] });
  service.wakeFor("ada", fired("tide"));
  await service.runDue();
  expect(ran.map((wake) => wake.fired)).toEqual([["lamp"], ["tide"]]);
});

test("a tick in the background logs a failure and ends as usual", async () => {
  const { service, ran, during } = await world();
  const logged = spyOn(shoreLog, "error").mockImplementation(() => {});
  try {
    during.run = () => { throw new Error("the lamp went out"); };
    service.wakeFor("ada", fired("lamp"));
    await service.tick();
    expect(logged.mock.calls.map((call) => String(call[0]))).toEqual(["shore: autonomy tick failed for ada: Error: the lamp went out"]);
    expect(ran).toHaveLength(1);
  } finally {
    logged.mockRestore();
  }
});

test("a tick while a wake is still running leaves that character alone, and the next one after it picks up what waited", async () => {
  const { service, ran, during } = await world();
  const held = Promise.withResolvers<WakeResult>();
  let wakes = 0;
  during.run = async () => {
    wakes += 1;
    return wakes === 1 ? await held.promise : { events: [] };
  };
  service.wakeFor("ada", fired("lamp"));
  const first = service.runDue();
  await until(() => ran.length === 1, "the first wake starting");

  service.wakeFor("ada", fired("song", { thread: "ring" }));
  await service.runDue();
  expect(ran).toHaveLength(1);

  held.resolve({ events: [] });
  await first;
  await service.runDue();
  expect(ran.map((wake) => wake.fired)).toEqual([["lamp"], ["song"]]);
});

test("shutting down waits for a tick that is still running, and no tick runs after it", async () => {
  const { service, ran, during } = await world();
  const held = Promise.withResolvers<WakeResult>();
  during.run = async () => await held.promise;
  service.wakeFor("ada", fired("lamp"));
  const running = service.runDue();
  await until(() => ran.length === 1, "the wake starting");

  const closing = service.quiesce().then(() => "closed");
  expect(await Promise.race([closing, Bun.sleep(100).then(() => "waiting")])).toBe("waiting");
  held.resolve({ events: [] });
  await running;
  expect(await closing).toBe("closed");

  service.wakeFor("ada", fired("song", { thread: "ring" }));
  await service.runDue();
  expect(ran).toHaveLength(1);
});

test("each tick puts the character's keepalive schedule in its saved state", async () => {
  const { service, dataDir } = await world();
  const schedule = { model: "claude-fixture", interval: 4 * MINUTE, last_warm_at: T0, last_active_at: T0 - MINUTE };
  service.attachKeepalive({
    onEvent: () => {},
    scheduleFor: (character: string) => character === "ada" ? schedule : undefined,
    restore: () => {},
    haltsFor: () => [],
  } as unknown as KeepaliveService);

  await service.runDue();

  expect(decodeState(readCharacterState(dataDir, STATE_FILENAME) ?? "")?.keepalive).toEqual({ model: "claude-fixture", intervalMs: 4 * MINUTE, lastWarmAt: T0, lastActiveAt: T0 - MINUTE });
});

test("a character's state is saved once the user is heard from, here or in another thread, and not before", async () => {
  const { service, dataDir, clock } = await world();
  const saved = () => decodeState(readCharacterState(dataDir, STATE_FILENAME) ?? "");
  await service.runDue();
  expect(readCharacterState(dataDir, STATE_FILENAME)).toBeUndefined();
  clock.now = T0 + MINUTE;
  service.onUserActivityElsewhere("ada", clock.now);
  await service.runDue();
  expect(saved()).toMatchObject({ lastUserAt: T0 + MINUTE });
  clock.now = T0 + 2 * MINUTE;
  service.onUserMessage("ada", 1, clock.now);
  await service.runDue();
  expect(saved()?.lastUserAt).toBe(T0 + 2 * MINUTE);
});

test("an idle compaction waits for a turn to compact and counts the idle time from the user's last message", async () => {
  const { service, compactions, clock } = await world({ idleCompactionSecs: 60, minTurns: 1 });
  clock.now = T0 + 60_000;
  await service.runDue();
  expect(compactions).toEqual([]);
  service.onUserMessage("ada", 1, clock.now);
  clock.now = T0 + 119_000;
  await service.runDue();
  expect(compactions).toEqual([]);
  clock.now = T0 + 120_000;
  await service.runDue();
  expect(compactions).toEqual(["idle"]);
});

test("a compaction asked for because the conversation was full stops holding back the idle one once the user writes again", async () => {
  const { service, compactions, clock } = await world({ idleCompactionSecs: 60 });
  expect(service.shouldCompactNow("ada", 0, 0, true)).toBe(true);
  service.onUserMessage("ada", 1, T0);
  clock.now = T0 + 60_000;
  await service.runDue();
  expect(compactions).toEqual(["idle"]);
});

test("a long-idle conversation is archived once, with what the archive reported, and again only after the user has written since", async () => {
  const { service, archives, clock } = await world({ archiveAfterSecs: 3600, archived: { turnCount: 0, events: [{ kind: "wake", detail: "Archived after an idle hour" }] } });
  clock.now = T0 + HOUR;
  await service.runDue();
  expect(archives).toEqual(["ada"]);
  expect(service.log("ada", 20).map((event) => event.detail)).toContain("Archived after an idle hour");
  clock.now = T0 + 3 * HOUR;
  await service.runDue();
  expect(archives).toEqual(["ada"]);
  service.onUserMessage("ada", 1, clock.now);
  clock.now = T0 + 4 * HOUR;
  await service.runDue();
  expect(archives).toEqual(["ada", "ada"]);
});

test("nothing is archived while a reply is being written, and the archive waits for it to finish", async () => {
  const { service, archives, clock } = await world({ archiveAfterSecs: 3600 });
  const done = service.beginForeground("ada");
  clock.now = T0 + HOUR;
  await service.runDue();
  expect(archives).toEqual([]);
  done();
  await service.runDue();
  expect(archives).toEqual(["ada"]);
});

test("a running wake hears when the user writes to the character", async () => {
  const { service, during } = await world();
  const heard: string[][] = [];
  during.run = (_wake, hooks) => {
    service.onUserMessage("ada", 1, T0);
    heard.push(hooks.news(false).map((item) => item.kind));
    return { events: [] };
  };
  service.wakeFor("ada", fired("lamp"));
  await service.runDue();
  expect(heard).toEqual([["user_wrote"]]);
});

test("registering a character again saves its keepalive schedule first and hands it back to keepalive", async () => {
  const { service, dataDir } = await world();
  const schedule = { model: "claude-fixture", interval: 4 * MINUTE, last_warm_at: T0, last_active_at: T0 - MINUTE };
  const restored: unknown[][] = [];
  service.attachKeepalive({
    onEvent: () => {},
    scheduleFor: (character: string) => character === "ada" ? schedule : undefined,
    restore: (...told: unknown[]) => { restored.push(told); },
    haltsFor: () => [],
  } as unknown as KeepaliveService);

  await service.register({
    character: "ada",
    data_dir: dataDir,
    config: { autonomyEnabled: true, compactionEnabled: true, minTurns: 0, maxTurns: 0, idleTriggerSecs: 0, archiveAfterSecs: 0, maxContextTokens: 0 },
    dormancy: { maxIdleWakes: 10, maxSilentMs: 4 * HOUR },
  });

  expect(restored).toEqual([["ada", schedule]]);
});

test("a running wake can be asked whether the user has written in its thread since it started", async () => {
  const { service, ran, during } = await world();
  const heard: boolean[] = [];
  during.run = (wake) => {
    heard.push(wake.interrupted());
    service.userActiveIn("ada", "garden");
    heard.push(wake.interrupted());
    service.userActiveIn("ada", wake.thread);
    heard.push(wake.interrupted());
    return { events: [] };
  };
  service.wakeFor("ada", fired("song", { thread: "ring" }));
  await service.runDue();
  service.wakeFor("ada", fired("lamp"));
  await service.runDue();
  expect(ran.map((each) => each.thread)).toEqual(["ring", "main"]);
  expect(heard).toEqual([false, false, true, false, false, true]);
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
  await service.runDue();
  expect(seen).toEqual([{ startedAt: T0, thread: "ring", news: [], firings: [fired("song", { thread: "ring" })], userTold: false }, [{ character: "ada", startedAt: T0 }], 1, 1, "ring"]);
  expect([service.runningWake("ada"), service.runningWakes()]).toEqual([undefined, []]);
});

test("a dormant character is woken by nothing but a seal coming off, and what came due meanwhile is not made up", async () => {
  const { service, ran, seals, clock, woken } = await world({ maxIdleWakes: 2 });
  service.wakeFor("ada", fired("lamp"));
  await service.runDue();
  service.wakeFor("ada", fired("tide"));
  await service.runDue();
  expect(service.status("ada")).toMatchObject({ state: "Dormant", wakes_without_user: 2 });

  service.wakeFor("ada", fired("ferry"));
  seals.push({ thread: "gift", reason: "It is open." });
  await service.runDue();
  expect(ran.map((each) => [each.thread, each.fired])).toEqual([["main", ["lamp"]], ["main", ["tide"]], ["gift", [""]]]);
  expect(woken().at(-1)).toBe('Woken in "gift" by its seal coming off');
  expect(service.log("ada", 20).filter((event) => event.kind === "dormant").map((event) => event.detail)).toEqual(["Went dormant (wakes without the user: 2)"]);

  clock.now = T0 + HOUR;
  service.onUserMessage("ada", 1, clock.now);
  expect(service.status("ada")).toMatchObject({ state: "Active", wakes_without_user: 0 });
  await service.runDue();
  expect(ran).toHaveLength(3);
});

test("a wake started by hand runs in home unless the character is dormant, and making it dormant or active starts none", async () => {
  const { service, ran, woken } = await world();
  expect(service.wakeNow("ada")).toBe(false);
  await service.runDue();
  expect(ran).toEqual([{ thread: "main", fired: [""], limitMs: 30 * MINUTE }]);
  expect(woken()).toEqual(['Woken in "main" by a start by hand']);

  expect(service.forceDormancy("ada", "dormant")).toBe(true);
  expect(service.status("ada")?.state).toBe("Dormant");
  expect(service.wakeNow("ada")).toBe(true);
  await service.runDue();
  expect(ran).toHaveLength(1);

  expect(service.forceDormancy("ada", "active")).toBe(true);
  expect(service.status("ada")).toMatchObject({ state: "Active", wakes_without_user: 0, last_user_at: T0 });
  await service.runDue();
  expect(ran).toHaveLength(1);

  expect(service.wakeNow("nobody")).toBeUndefined();
  expect(service.forceDormancy("nobody", "active")).toBe(false);
});

test("the log says what woke the character: triggers by name, a hand-off by the thread it came from, a seal, a start by hand", async () => {
  const { service, woken } = await world();
  service.wakeFor("ada", fired("song", { thread: "ring" }));
  service.requestWake("ada", fired("", { thread: "ring", from: "main" }), false);
  await service.runDue();
  expect(woken()).toEqual(['Woken in "ring" by trigger "song" and a hand-off from "main"']);
});

test("with the user's switch off nothing wakes the character, and what fired is let go", async () => {
  const { service, ran } = await world({ enabled: false });
  expect(service.wakesMayRun("ada")).toBe(false);
  expect(service.wakesMayRun("nobody")).toBe(false);
  service.wakeFor("ada", fired("lamp"));
  await service.runDue();
  await service.runDue();
  expect(ran).toEqual([]);
  expect((await world()).service.wakesMayRun("ada")).toBe(true);
});

test("an idle conversation is compacted and then archived whether or not the user's switch is on, and neither happens with compaction off", async () => {
  for (const enabled of [true, false]) {
    const { service, compactions, archives, clock } = await world({ idleCompactionSecs: 60, archiveAfterSecs: 3600, minTurns: 1, enabled });
    service.onAssistantMessage("ada", 1);
    clock.now = T0 + 59_000;
    await service.runDue();
    expect([compactions, archives]).toEqual([[], []]);
    clock.now = T0 + 60_000;
    await service.runDue();
    expect([compactions, archives]).toEqual([["idle"], []]);
    service.onCompactionComplete("ada", 0);
    clock.now = T0 + HOUR + 59_000;
    await service.runDue();
    expect([compactions, archives]).toEqual([["idle"], []]);
    clock.now = T0 + HOUR + 60_000;
    await service.runDue();
    expect([compactions, archives]).toEqual([["idle"], ["ada"]]);
  }

  const off = await world({ idleCompactionSecs: 60, archiveAfterSecs: 3600, minTurns: 1, compaction: false });
  off.service.onAssistantMessage("ada", 1);
  off.clock.now = T0 + 60_000;
  await off.service.runDue();
  off.clock.now = T0 + HOUR;
  await off.service.runDue();
  expect([off.compactions, off.archives]).toEqual([[], []]);
});

test("a conversation being compacted because it is full is not compacted for being idle until that is over", async () => {
  const { service, compactions, clock } = await world({ idleCompactionSecs: 60 });
  expect(service.shouldCompactNow("ada", 0, 0, true)).toBe(true);
  clock.now = T0 + 60_000;
  await service.runDue();
  expect(compactions).toEqual([]);

  service.onCompactionComplete("ada", 0);
  clock.now = T0 + 119_000;
  await service.runDue();
  expect(compactions).toEqual([]);
  clock.now = T0 + 120_000;
  await service.runDue();
  expect(compactions).toEqual(["idle"]);
});

test("the user's new dormancy settings take effect at the next look", async () => {
  const { service, ran } = await world();
  service.wakeFor("ada", fired("lamp"));
  await service.runDue();
  service.setDormancyConfig("ada", { maxIdleWakes: 1, maxSilentMs: 4 * HOUR });
  expect(service.status("ada")).toMatchObject({ state: "Dormant", max_idle_wakes: 1 });
  service.wakeFor("ada", fired("tide"));
  await service.runDue();
  expect(ran).toHaveLength(1);
});

