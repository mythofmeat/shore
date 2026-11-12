import { describe, expect, test } from "bun:test";

import { OwnTime, type OwnTimeConfig, type OwnWake } from "../src/autonomy/own_time.ts";
import { dispatchTool, nextWakeAnswer, type ToolContext } from "../src/tools/dispatch.ts";

const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 16);

function config(overrides: Partial<OwnTimeConfig> = {}): OwnTimeConfig {
  return {
    defaultIntervalMs: HOUR,
    maxIdleWakes: 100,
    maxSilentMs: 48 * HOUR,
    minIntervalMs: HOUR,
    maxIntervalMs: 48 * HOUR,
    ...overrides,
  };
}

function beat(own: OwnTime, now: number): OwnWake | undefined {
  const wake = own.due(now);
  if (wake !== undefined) own.wakeStarted(now, true);
  return wake;
}

const OWN: OwnWake = { kind: "heartbeat", byHand: false };
const BY_HAND: OwnWake = { kind: "heartbeat", byHand: true };

describe("a heartbeat the character asks for", () => {
  test("is held between min_interval and max_interval, counted from when it asks", () => {
    const own = new OwnTime(config({ minIntervalMs: 10 * MIN, maxIntervalMs: 3 * HOUR }), 0);
    expect(own.ask(1 / 60, "", 0)).toBe(10 * MIN);
    expect(own.nextAt(0)).toBe(10 * MIN);
    expect(own.ask(10, "", 0)).toBe(3 * HOUR);
    expect(own.nextAt(0)).toBe(3 * HOUR);
    expect(own.ask(2, "", 0)).toBe(2 * HOUR);
    expect(own.ask(0.5, "", HOUR)).toBe(30 * MIN);
    expect(own.nextAt(HOUR)).toBe(90 * MIN);
  });

  test("comes due at once when it was asked for in the past and nothing holds it back", () => {
    const own = new OwnTime(config({ minIntervalMs: 0 }), 0);
    expect(own.ask(-1, "", 10 * MIN)).toBe(0);
    expect(own.nextAt(10 * MIN)).toBe(10 * MIN);
    expect(own.due(10 * MIN)).toEqual({ kind: "asked", reason: "" });
  });

  test("comes with its reason as written, a blank reason is none, and a later call takes the earlier one's place", () => {
    const own = new OwnTime(config(), 0);
    expect(own.asked).toBeUndefined();
    own.ask(1, "first", 0);
    own.ask(2, " kept as written ", 0);
    expect(own.asked).toEqual({ at: 2 * HOUR, reason: " kept as written " });
    expect(own.due(HOUR)).toBeUndefined();
    expect(own.due(2 * HOUR)).toEqual({ kind: "asked", reason: " kept as written " });
    expect(own.asked).toBeUndefined();
    own.ask(1, " \n\t", 2 * HOUR);
    expect(own.due(3 * HOUR)).toEqual({ kind: "asked", reason: "" });
  });

  test("stays where it was set, however close to it the user writes or a reply ends", () => {
    const own = new OwnTime(config({ minIntervalMs: 2 * HOUR }), T0);
    own.ask(2, "", T0);
    own.onUserMessage(T0 + HOUR);
    own.onActivity(T0 + 2 * HOUR - 1);
    expect(own.nextAt(T0 + 2 * HOUR - 1)).toBe(T0 + 2 * HOUR);
    expect(own.due(T0 + 2 * HOUR - 1)).toBeUndefined();
    expect(own.due(T0 + 2 * HOUR)).toEqual({ kind: "asked", reason: "" });
  });
});

describe("Shore's own heartbeat", () => {
  test("comes default_interval after the last heartbeat, and not a millisecond sooner", () => {
    const own = new OwnTime(config({ defaultIntervalMs: 2 * HOUR }), T0);
    expect(own.nextAt(T0)).toBe(T0 + 2 * HOUR);
    expect(beat(own, T0 + 2 * HOUR - 1)).toBeUndefined();
    expect(beat(own, T0 + 2 * HOUR)).toEqual(OWN);
    expect(beat(own, T0 + 2 * HOUR + 1)).toBeUndefined();
    expect(own.nextAt(T0 + 2 * HOUR + 1)).toBe(T0 + 4 * HOUR);
  });

  test("is held between min_interval and max_interval like one the character asks for", () => {
    expect(new OwnTime(config({ defaultIntervalMs: 10 * MIN }), 0).nextAt(0)).toBe(HOUR);
    expect(new OwnTime(config({ defaultIntervalMs: 72 * HOUR }), 0).nextAt(0)).toBe(48 * HOUR);
    expect(new OwnTime(config({ defaultIntervalMs: 72 * HOUR }), 0).heartbeatIntervalMs).toBe(48 * HOUR);
  });

  test("waits behind a heartbeat the character asked for, and counts again from that one", () => {
    const own = new OwnTime(config({ defaultIntervalMs: 2 * HOUR }), T0);
    own.ask(5, "later", T0);
    expect(own.nextAt(T0)).toBe(T0 + 5 * HOUR);
    expect(beat(own, T0 + 2 * HOUR)).toBeUndefined();
    expect(beat(own, T0 + 5 * HOUR)).toEqual({ kind: "asked", reason: "later" });
    expect(own.nextAt(T0 + 5 * HOUR)).toBe(T0 + 7 * HOUR);
    expect(beat(own, T0 + 7 * HOUR)).toEqual(OWN);
  });

  test("counts from any heartbeat, whatever started it, and not from a wake in a thread", () => {
    const own = new OwnTime(config(), T0);
    own.wakeStarted(T0 + 30 * MIN, true);
    expect(own.nextAt(T0 + 30 * MIN)).toBe(T0 + 90 * MIN);
    own.wakeStarted(T0 + 40 * MIN, false);
    expect(own.nextAt(T0 + 40 * MIN)).toBe(T0 + 90 * MIN);
  });

  test("isn't moved by the user writing or a reply ending", () => {
    const own = new OwnTime(config({ defaultIntervalMs: 2 * HOUR }), T0);
    own.onUserMessage(T0 + 90 * MIN);
    own.onActivity(T0 + 110 * MIN);
    expect(own.nextAt(T0 + 110 * MIN)).toBe(T0 + 2 * HOUR);
  });

  test("never comes once the user has switched it off, while one the character asks for still does", () => {
    const own = new OwnTime(config({ heartbeatOff: true }), T0);
    expect(own.nextAt(T0)).toBeUndefined();
    expect(own.due(T0 + 100 * HOUR)).toBeUndefined();
    own.ask(1, "still mine", T0);
    expect(own.nextAt(T0)).toBe(T0 + HOUR);
    expect(beat(own, T0 + HOUR)).toEqual({ kind: "asked", reason: "still mine" });
    expect(own.nextAt(T0 + HOUR)).toBeUndefined();
  });
});

describe("with defer_on_activity", () => {
  test("a message or the end of a reply pushes the next heartbeat to min_interval after it, and never brings it closer", () => {
    const own = new OwnTime(config({ minIntervalMs: 2 * HOUR, deferOnActivity: true }), T0);
    own.ask(3, "", T0);
    own.onUserMessage(T0 + 2 * HOUR);
    expect(own.nextAt(T0 + 2 * HOUR)).toBe(T0 + 4 * HOUR);
    own.onActivity(T0 + 2.5 * HOUR);
    expect(own.nextAt(T0 + 2.5 * HOUR)).toBe(T0 + 4.5 * HOUR);
    expect(own.due(T0 + 4.5 * HOUR - 1)).toBeUndefined();
    expect(own.due(T0 + 4.5 * HOUR)).toEqual({ kind: "asked", reason: "" });

    own.ask(10, "", T0 + 5 * HOUR);
    own.onUserMessage(T0 + 6 * HOUR);
    expect(own.nextAt(T0 + 6 * HOUR)).toBe(T0 + 15 * HOUR);
  });

  test("Shore's own heartbeat is pushed the same way, and left alone when it is already far enough off", () => {
    const own = new OwnTime(config({ defaultIntervalMs: 3 * HOUR, deferOnActivity: true }), T0);
    own.wakeStarted(T0 + HOUR, true);
    own.onUserMessage(T0 + HOUR + MIN);
    expect(own.nextAt(T0 + HOUR + MIN)).toBe(T0 + 4 * HOUR);
    own.onUserMessage(T0 + 3.5 * HOUR);
    expect(own.nextAt(T0 + 3.5 * HOUR)).toBe(T0 + 4.5 * HOUR);
    expect(beat(own, T0 + 4 * HOUR)).toBeUndefined();
    expect(beat(own, T0 + 4.5 * HOUR)).toEqual(OWN);
  });
});

describe("going dormant", () => {
  test("silence: exactly at the limit is already too long, and a millisecond short is not", () => {
    const own = new OwnTime(config({ maxSilentMs: 2 * HOUR }), T0);
    own.onUserMessage(T0);
    expect(own.stateAt(T0 + 2 * HOUR - 1)).toBe("Active");
    expect(own.isDormant(T0 + 2 * HOUR - 1)).toBe(false);
    expect(own.stateAt(T0 + 2 * HOUR)).toBe("Dormant");
    expect(own.nextAt(T0 + 2 * HOUR)).toBeUndefined();
    expect(own.due(T0 + 2 * HOUR)).toBeUndefined();
  });

  test("a character the user has never written to isn't dormant for silence", () => {
    const own = new OwnTime(config({ maxSilentMs: HOUR }), T0);
    expect(own.lastUserAt).toBeUndefined();
    expect(own.isDormant(T0 + 1000 * HOUR)).toBe(false);
    own.seedLastUserAtIfUnset(T0);
    expect(own.isDormant(T0 + HOUR)).toBe(true);
    own.seedLastUserAtIfUnset(T0 + HOUR);
    expect(own.lastUserAt).toBe(T0);
  });

  test("wakes: every wake counts, in a thread or not, and reaching the limit is already dormant", () => {
    const own = new OwnTime(config({ maxIdleWakes: 2 }), T0);
    own.wakeStarted(T0, false);
    expect(own.wakesWithoutUser).toBe(1);
    expect(own.isDormant(T0)).toBe(false);
    own.wakeStarted(T0, true);
    expect(own.wakesWithoutUser).toBe(2);
    expect(own.isDormant(T0)).toBe(true);
    expect(own.due(T0 + 10 * HOUR)).toBeUndefined();
  });

  test("a heartbeat the character asked for is dropped when its time comes while dormant, and kept if the user is back before then", () => {
    const own = new OwnTime(config({ maxSilentMs: 2 * HOUR }), T0);
    own.onUserMessage(T0);
    own.ask(5, "wait for me", T0);
    expect(own.due(T0 + 5 * HOUR - 1)).toBeUndefined();
    expect(own.asked).toEqual({ at: T0 + 5 * HOUR, reason: "wait for me" });
    own.onUserMessage(T0 + 5 * HOUR - 1);
    expect(own.due(T0 + 5 * HOUR)).toEqual({ kind: "asked", reason: "wait for me" });

    own.ask(5, "too late", T0 + 5 * HOUR);
    expect(own.due(T0 + 10 * HOUR)).toBeUndefined();
    expect(own.asked).toBeUndefined();
  });

  test("a message from the user ends it, and Shore's own heartbeat then counts from that message alone", () => {
    const own = new OwnTime(config({ maxIdleWakes: 1, defaultIntervalMs: 3 * HOUR }), T0);
    own.wakeStarted(T0 + HOUR, true);
    expect(own.stateAt(T0 + HOUR)).toBe("Dormant");
    own.onUserMessage(T0 + 20 * HOUR);
    expect(own.stateAt(T0 + 20 * HOUR)).toBe("Active");
    expect(own.wakesWithoutUser).toBe(0);
    expect(own.lastUserAt).toBe(T0 + 20 * HOUR);
    own.onUserMessage(T0 + 22 * HOUR);
    expect(own.nextAt(T0 + 22 * HOUR)).toBe(T0 + 23 * HOUR);
    expect(beat(own, T0 + 23 * HOUR)).toEqual(OWN);
  });
});

describe("by hand", () => {
  test("a heartbeat started by hand comes at once and once, as the one the character asked for if one was waiting", () => {
    const own = new OwnTime(config({ heartbeatOff: true }), T0);
    own.forceNow();
    expect(own.nextAt(T0 + MIN)).toBe(T0 + MIN);
    expect(own.due(T0 + MIN)).toEqual(BY_HAND);
    expect(own.due(T0 + MIN)).toBeUndefined();

    own.ask(5, "mine", T0 + MIN);
    own.forceNow();
    expect(own.due(T0 + 2 * MIN)).toEqual({ kind: "asked", reason: "mine" });
    expect(own.asked).toBeUndefined();
  });

  test("it isn't held back by defer_on_activity, and doesn't come at all while dormant, then or once the user is back", () => {
    const deferred = new OwnTime(config({ deferOnActivity: true }), T0);
    deferred.onUserMessage(T0);
    deferred.forceNow();
    expect(deferred.due(T0 + MIN)).toEqual(BY_HAND);

    const own = new OwnTime(config(), T0);
    own.forceDormant();
    own.forceNow();
    expect(own.due(T0 + MIN)).toBeUndefined();
    own.onUserMessage(T0 + 2 * MIN);
    expect(own.due(T0 + 3 * MIN)).toBeUndefined();
  });

  test("put to sleep, a character loses the heartbeat it asked for and stays asleep until the user writes or wakes it", () => {
    const own = new OwnTime(config(), T0);
    own.ask(1, "put to sleep", T0);
    own.forceDormant();
    expect(own.asked).toBeUndefined();
    expect(own.stateAt(T0 + HOUR)).toBe("Dormant");
    expect(own.wakesWithoutUser).toBe(0);
    own.onUserMessage(T0 + 4 * HOUR);
    expect(own.stateAt(T0 + 4 * HOUR)).toBe("Active");
    expect(beat(own, T0 + 5 * HOUR)).toEqual(OWN);
  });

  test("woken by hand, a character is active again whatever made it dormant, and has a heartbeat at once", () => {
    const slept = new OwnTime(config(), T0);
    slept.forceDormant();
    slept.forceActive(T0 + MIN);
    expect(slept.due(T0 + MIN)).toEqual(BY_HAND);

    const idle = new OwnTime(config({ maxIdleWakes: 1 }), T0);
    idle.wakeStarted(T0, true);
    idle.forceActive(T0 + MIN);
    expect(idle.wakesWithoutUser).toBe(0);
    expect(idle.stateAt(T0 + MIN)).toBe("Active");

    const silent = new OwnTime(config({ maxSilentMs: HOUR }), T0);
    silent.onUserMessage(T0);
    silent.forceActive(T0 + 5 * HOUR);
    expect(silent.lastUserAt).toBe(T0 + 5 * HOUR);
    expect(silent.stateAt(T0 + 5 * HOUR)).toBe("Active");
  });
});

describe("when the user changes the settings", () => {
  test("Shore's own heartbeat follows the new interval, and one the character asked for stays put", () => {
    const own = new OwnTime(config(), 0);
    own.setConfig(config({ defaultIntervalMs: 2 * HOUR }), 5 * MIN);
    expect(own.config.defaultIntervalMs).toBe(2 * HOUR);
    expect(own.nextAt(5 * MIN)).toBe(2 * HOUR);
    own.ask(3, "", 6 * MIN);
    own.setConfig(config({ defaultIntervalMs: 4 * HOUR }), 7 * MIN);
    expect(own.nextAt(7 * MIN)).toBe(3 * HOUR + 6 * MIN);
  });

  test("a heartbeat the character asked for is raised to a longer min_interval, left by the same or a shorter one, and cut to a shorter max_interval", () => {
    const own = new OwnTime(config({ minIntervalMs: 30 * MIN }), 0);
    own.ask(1, "check the tide table", 0);
    own.setConfig(config({ minIntervalMs: 30 * MIN }), 50 * MIN);
    expect(own.nextAt(50 * MIN)).toBe(HOUR);
    own.setConfig(config({ minIntervalMs: 2 * HOUR }), 50 * MIN);
    expect(own.nextAt(50 * MIN), "raised to a new minimum").toBe(170 * MIN);
    own.setConfig(config({ minIntervalMs: HOUR }), 50 * MIN);
    expect(own.nextAt(50 * MIN)).toBe(170 * MIN);
    own.setConfig(config({ minIntervalMs: 30 * MIN, maxIntervalMs: HOUR }), 50 * MIN);
    expect(own.nextAt(50 * MIN), "cut to a new maximum").toBe(110 * MIN);
    expect(own.asked).toEqual({ at: 110 * MIN, reason: "check the tide table" });
  });
});

describe("across a restart", () => {
  test("everything it keeps comes back as it was", () => {
    const own = new OwnTime(config({ deferOnActivity: true }), T0);
    own.wakeStarted(T0 + HOUR, true);
    own.onUserMessage(T0 + 2 * HOUR);
    own.wakeStarted(T0 + 3 * HOUR, false);
    own.ask(6, "after the restart", T0 + 3 * HOUR);
    const kept = own.snapshot();
    expect(kept).toEqual({
      wakesWithoutUser: 1,
      lastUserAt: T0 + 2 * HOUR,
      forcedDormant: false,
      asked: { at: T0 + 9 * HOUR, reason: "after the restart" },
      lastHeartbeatAt: T0 + HOUR,
      notBefore: T0 + 3 * HOUR,
    });
    const back = new OwnTime(config({ deferOnActivity: true }), T0 + 4 * HOUR);
    back.restore(kept, T0 + 4 * HOUR);
    expect(back.snapshot()).toEqual(kept);
  });

  test("a character put to sleep stays asleep, and one with no heartbeat on record counts Shore's own from the start", () => {
    const slept = new OwnTime(config(), T0);
    slept.restore({ wakesWithoutUser: 0, lastUserAt: undefined, forcedDormant: true, asked: undefined, lastHeartbeatAt: undefined, notBefore: undefined }, T0);
    expect(slept.stateAt(T0)).toBe("Dormant");

    const fresh = new OwnTime(config(), T0);
    fresh.restore({ wakesWithoutUser: 0, lastUserAt: undefined, forcedDormant: false, asked: undefined, lastHeartbeatAt: undefined, notBefore: undefined }, T0);
    expect(fresh.nextAt(T0)).toBe(T0 + HOUR);
  });

  test("a heartbeat asked for further off than max_interval now allows is brought back to it", () => {
    const own = new OwnTime(config({ maxIntervalMs: 8 * HOUR }), T0);
    const asked = { at: T0 + 40 * HOUR, reason: "far" };
    own.restore({ wakesWithoutUser: 0, lastUserAt: undefined, forcedDormant: false, asked, lastHeartbeatAt: T0, notBefore: undefined }, T0 + HOUR);
    expect(own.asked).toEqual({ at: T0 + 9 * HOUR, reason: "far" });
    own.restore({ wakesWithoutUser: 0, lastUserAt: undefined, forcedDormant: false, asked: { at: T0 + 2 * HOUR, reason: "near" }, lastHeartbeatAt: T0, notBefore: undefined }, T0 + HOUR);
    expect(own.asked).toEqual({ at: T0 + 2 * HOUR, reason: "near" });
  });
});

test("the character is told when the heartbeat it asked for is, and when that was held to the soonest or the furthest ahead the user lets it ask for", async () => {
  expect(nextWakeAnswer(5, 5, "eve")).toBe("The heartbeat you asked for is in 5 hours.");
  expect(nextWakeAnswer(1, 1, "eve")).toBe("The heartbeat you asked for is in 1 hour.");
  expect(nextWakeAnswer(2, 2, "eve")).toBe("The heartbeat you asked for is in 2 hours.");
  expect(nextWakeAnswer(2.456, 2.456, "eve")).toBe("The heartbeat you asked for is in 2.46 hours.");
  expect(nextWakeAnswer(0.1, 0.1000000001, "eve")).toBe("The heartbeat you asked for is in 0.1 hours.");
  expect(nextWakeAnswer(2.5, 4, "eve")).toBe("You asked for 2.5 hours, and the heartbeat is in 4 hours: that is the soonest eve lets you ask for one.");
  expect(nextWakeAnswer(100, 48, "eve")).toBe("You asked for 100 hours, and the heartbeat is in 48 hours: that is the furthest ahead eve lets you ask for one.");

  const reasons: string[] = [];
  const ctx: ToolContext = {
    workspaceDir: "/nowhere", characterName: "ada", characterDataDir: "/nowhere", imageDir: "/nowhere", conversationDir: "/nowhere",
    historyDbPath: "/nowhere/shore.db", configDir: "/nowhere", userName: "eve",
    scheduleNextWake: (hours, reason) => {
      reasons.push(reason);
      return Math.min(Math.max(hours, 4), 48);
    },
  };
  expect(await dispatchTool("set_next_wake", { hours_from_now: 2.5, reason: "look at the tide" }, ctx)).toBe(
    "You asked for 2.5 hours, and the heartbeat is in 4 hours: that is the soonest eve lets you ask for one.",
  );
  expect(await dispatchTool("set_next_wake", { hours_from_now: 6, reason: "trim the lamp" }, ctx)).toBe("The heartbeat you asked for is in 6 hours.");
  expect(reasons).toEqual(["look at the tide", "trim the lamp"]);
});
