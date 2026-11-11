import { afterAll, afterEach, expect, jest, test } from "bun:test";
import { join } from "node:path";
import { unfoldedDiary } from "../src/autonomy/diary.ts";
import type { HeartbeatEvent } from "../src/autonomy/heartbeat_log.ts";
import { wrapUpNudgeText } from "../src/autonomy/heartbeat_shape.ts";
import type { Message } from "../src/engine/types.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import { required } from "../src/util/required.ts";
import { eventsForResponse } from "./support/stream.ts";
import { afterFirstChat, type ChatWorld } from "./support/chat_world.ts";
import { restoreTestEnv } from "./support/env.ts";

const MINUTE = 60_000;
const KEY_ENV = "SHORE_HEARTBEAT_TIME_LIMIT_KEY";

afterAll(restoreTestEnv);
afterEach(() => { jest.useRealTimers(); });

interface Round {
  minutes: number;
  blocks: GenerateResponse["content_blocks"];
}

type Script = (request: SidecarRequest, heartbeat: number) => Round;

const READ_SOUL: Round["blocks"] = [{ type: "tool_use", id: "read", name: "read", input: { file_path: "SOUL.md" } }];

function textOf(request: SidecarRequest): string {
  return request.messages.flatMap((message) => message.content.flatMap((block) => block.type === "text" ? [block.text] : [])).join("\n");
}

function instructionsOf(request: SidecarRequest): string {
  const instructions = request.messages.findLast((message) => message.role === "system");
  return instructions?.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n") ?? "";
}

function nudged(request: SidecarRequest): boolean {
  return request.messages.at(-1)?.content.some((block) => block.type === "text" && block.text.startsWith("[System nudge")) === true;
}

function slowProvider(script: Script, seen: SidecarRequest[]): SidecarProvider {
  let heartbeats = 0;
  const response = (request: SidecarRequest, blocks: Round["blocks"]): GenerateResponse => ({
    model: request.model,
    content: blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join(""),
    content_blocks: blocks,
    finish_reason: blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    timing: { total_ms: 1, time_to_first_token_ms: 1 },
  });
  return {
    generate: async (request) => response(request, [{ type: "text", text: "hello" }]),
    stream: async function* (request, signal) {
      if (request.context?.call_type.startsWith("heartbeat") !== true) {
        yield* eventsForResponse(response(request, [{ type: "text", text: "hello" }]));
        return;
      }
      if (request.context.call_type === "heartbeat") heartbeats += 1;
      seen.push(structuredClone(request));
      const round = script(request, heartbeats);
      jest.advanceTimersByTime(round.minutes * MINUTE);
      signal?.throwIfAborted();
      yield* eventsForResponse(response(request, round.blocks));
    },
  };
}

interface Heartbeats {
  run: () => Promise<void>;
  log: () => HeartbeatEvent[];
  messages: () => Promise<readonly Message[]>;
}

async function afterOneChat(script: Script, seen: SidecarRequest[], heartbeats: (h: Heartbeats) => Promise<void>): Promise<void> {
  await afterFirstChat({
    name: "heartbeat-time-limit",
    keyEnv: KEY_ENV,
    provider: slowProvider(script, seen),
    tools: ["read", "set_next_wake"],
    autonomy: true,
  }, async ({ runtime }) => {
    jest.useFakeTimers();
    try {
      await heartbeats({
        run: async () => {
          expect(runtime.autonomy.forceHeartbeatNow("ada")).toBeDefined();
          await runtime.autonomy.tick();
        },
        log: () => runtime.autonomy.log("ada", 100),
        messages: async () => (await runtime.registry.getOrCreate("ada", "main")).messages(),
      });
    } finally {
      jest.useRealTimers();
    }
  });
}

test("a heartbeat still busy at 25 minutes is told how long it has left, and its wrap-up runs before the 30-minute limit", async () => {
  const seen: SidecarRequest[] = [];
  await afterOneChat(
    (request) => {
      if (nudged(request)) return { minutes: 0.5, blocks: READ_SOUL };
      if (textOf(request).includes("[System nudge")) {
        return { minutes: 0.5, blocks: [{ type: "text", text: "<sendMessage>I'll finish this next time.</sendMessage>" }] };
      }
      return { minutes: 7, blocks: READ_SOUL };
    },
    seen,
    async ({ run, log, messages }) => {
      await run();
      const nudges = seen.filter(nudged);
      expect(nudges).toHaveLength(1);
      expect(textOf(required(nudges[0]))).toContain("about 2 minutes");
      expect((await messages()).at(-1)?.content).toBe("I'll finish this next time.");
      const kinds = log().map((event) => event.kind);
      expect(kinds).toContain("message_sent");
      expect(kinds).not.toContain("timeout");
      expect(kinds).not.toContain("call_failed");
    },
  );
});

test("a heartbeat stopped at its 30-minute limit is logged as such, and only the next heartbeat is told", async () => {
  const seen: SidecarRequest[] = [];
  await afterOneChat(
    (_request, heartbeat) => heartbeat === 1
      ? { minutes: 7, blocks: READ_SOUL }
      : { minutes: 0, blocks: [{ type: "text", text: "HEARTBEAT_OK" }] },
    seen,
    async ({ run, log, messages }) => {
      await run();
      const stopped = log().filter((event) => event.kind === "timeout");
      expect(stopped).toHaveLength(1);
      expect(stopped[0]?.detail).toContain("30-minute limit");
      expect(log().map((event) => event.kind)).not.toContain("call_failed");
      expect((await messages()).filter((message) => message.origin === "autonomous")).toEqual([]);

      await run();
      await run();
      const opening = seen.filter((request) => request.context?.call_type === "heartbeat");
      expect(opening).toHaveLength(3);
      const told = instructionsOf(required(opening[1]));
      expect(told).toContain("reached its 30-minute limit");
      expect(told).toContain("after 4 rounds");
      expect(told).toContain("Nothing from it was sent");
      expect(instructionsOf(required(opening[2]))).not.toContain("30-minute limit and was stopped");
    },
  );
});

test("the wrap-up nudge asks for the closing note, and for set_next_wake only when the heartbeat has that tool", () => {
  expect(wrapUpNudgeText(4 * MINUTE, 3, true)).toBe(
    "[System nudge: this heartbeat stops in about 4 minutes or after 3 more rounds, counting this one, whichever comes first. " +
    "Wrap up now: call set_next_wake if you haven't yet, then finish with your note to yourself, saying where you stopped so future-you can pick it up. " +
    "Only what you put in <sendMessage> tags is sent.]",
  );
  expect(wrapUpNudgeText(30_000, 1, false)).toBe(
    "[System nudge: this heartbeat stops in less than a minute or after this round, whichever comes first. " +
    "Wrap up now: finish with your note to yourself, saying where you stopped so future-you can pick it up. " +
    "Only what you put in <sendMessage> tags is sent.]",
  );
});

interface RingOptions {
  maxToolIterations?: number;
  wrapUpRounds?: number;
  started?: (world: ChatWorld) => void;
}

async function wokenInRing(script: Script, seen: SidecarRequest[], limitMs: number | undefined, after: (world: ChatWorld) => Promise<void>, options: RingOptions = {}): Promise<void> {
  const { maxToolIterations, wrapUpRounds } = options;
  await afterFirstChat({
    name: "wake-time-limit",
    keyEnv: KEY_ENV,
    provider: slowProvider(script, seen),
    tools: ["read"],
    autonomy: true,
    ...(maxToolIterations === undefined ? {} : { model: { maxToolIterations } }),
    ...(wrapUpRounds === undefined ? {} : { tune: (app) => { app.behavior.autonomy.heartbeat.wrap_up_grace_rounds = wrapUpRounds; } }),
  }, async (world) => {
    await world.runtime.registry.createThread("ada", "ring");
    options.started?.(world);
    jest.useFakeTimers();
    try {
      world.runtime.autonomy.wakeFor("ada", { name: "show", reason: "The show.", at: Date.now(), thread: "ring", limitMs });
      await world.runtime.autonomy.tick();
      await after(world);
    } finally {
      jest.useRealTimers();
    }
  });
}

function ringNotes(world: ChatWorld): [source: string, text: string][] {
  return unfoldedDiary(join(world.config.dirs.data, "ada")).map((note) => [note.source, note.text]);
}

async function ringEnd(world: ChatWorld): Promise<[role: string, origin: string, content: string][]> {
  const ring = await world.runtime.registry.getOrCreate("ada", "ring");
  return ring.messages().slice(-2).map((message) => [message.role, message.origin ?? "", message.content.startsWith("[") ? message.content : "…"]);
}

test("a wake in a thread runs to the limit its trigger set, is warned a quarter of an hour before, and can finish inside it", async () => {
  const seen: SidecarRequest[] = [];
  await wokenInRing(
    (request) => textOf(request).includes("[System nudge")
      ? { minutes: 1, blocks: [{ type: "text", text: "Stopped at the second act.\n<sendMessage>More tomorrow.</sendMessage>" }] }
      : { minutes: 22, blocks: READ_SOUL },
    seen,
    120 * MINUTE,
    async (world) => {
      expect(seen).toHaveLength(6);
      expect(textOf(required(seen[0]))).toContain("A wake here can run for up to 2 hours. After 105 minutes, you will get a nudge to wrap up");
      expect(seen.map(nudged)).toEqual([false, false, false, false, false, true]);
      expect(textOf(required(seen[5]))).toEndWith(
        "[System nudge: this wake stops in about 10 minutes or after 3 more rounds, counting this one, whichever comes first. " +
        "Wrap up now: finish with your note to yourself, saying where you stopped so you can pick it up here next time. " +
        "Only what you put in <sendMessage> tags is posted for User.]",
      );
      expect(ringNotes(world)).toEqual([["wake", "Stopped at the second act."]]);
      expect(await ringEnd(world)).toEqual([["assistant", "", "…"], ["assistant", "autonomous", "…"]]);
      expect(world.runtime.autonomy.log("ada", 100).map((event) => event.kind)).not.toContain("timeout");
    },
  );
});

test("a wake in a thread still busy at its limit is stopped there, and the thread and the diary say so", async () => {
  const seen: SidecarRequest[] = [];
  await wokenInRing(
    () => ({ minutes: 27, blocks: READ_SOUL }),
    seen,
    120 * MINUTE,
    async (world) => {
      expect(seen.map(nudged)).toEqual([false, false, false, false, true]);
      expect((await ringEnd(world)).map(([role, origin, content]) => [role, origin, content.slice(0, 20)])).toEqual([
        ["system", "autonomous", "[System nudge: this "],
        ["system", "autonomous", "[This wake reached i"],
      ]);
      expect((await ringEnd(world)).at(-1)?.[2]).toBe("[This wake reached its limit of 2 hours, and Shore stopped it here.]");
      expect(ringNotes(world)).toEqual([["shore", 'Your wake in "ring" reached its limit of 2 hours before you finished. Where it stopped is in that thread.']]);
      expect(world.runtime.autonomy.log("ada", 100).filter((event) => event.kind !== "tool_use").map((event) => [event.kind, event.detail]).slice(-3)).toEqual([
        ["tick_fired", 'Woken in "ring" by trigger "show"'],
        ["timeout", 'Wake in "ring" reached its limit of 2 hours and was stopped'],
        ["message_skipped", "Tick completed — no message sent"],
      ]);
    },
  );
});

test("a wake in a thread that keeps using tools past its rounds is stopped, and without a limit of its own it gets half an hour", async () => {
  const seen: SidecarRequest[] = [];
  await wokenInRing(
    () => ({ minutes: 1, blocks: READ_SOUL }),
    seen,
    undefined,
    async (world) => {
      expect(textOf(required(seen[0]))).toContain("A wake here can run for up to 30 minutes. After 25 minutes, or after 2 rounds of tool use if that comes first, you will get a nudge to wrap up");
      expect(seen.map(nudged)).toEqual([false, false, true, false, false]);
      expect(await ringEnd(world)).toEqual([
        ["user", "", "…"],
        ["system", "autonomous", "[This wake used up its rounds of tool use, and Shore stopped it here.]"],
      ]);
      expect(ringNotes(world)).toEqual([["shore", 'Your wake in "ring" used up its rounds of tool use before you finished. Where it stopped is in that thread.']]);
      expect(world.runtime.autonomy.log("ada", 100).filter((event) => event.kind === "timeout").map((event) => event.detail)).toEqual([
        'Wake in "ring" used up its rounds and was stopped',
      ]);
    },
    { maxToolIterations: 2 },
  );
});

test("a trigger handed to a wake as it runs out of rounds isn't lost with the wake: it isn't written into the thread, and it wakes the character there again", async () => {
  for (const [wrapUpRounds, lastCall] of [[3, 5], [0, 2]] as const) {
    const seen: SidecarRequest[] = [];
    let ring: ChatWorld | undefined;
    await wokenInRing(
      () => {
        if (seen.length === lastCall) {
          expect(ring?.runtime.autonomy.wakeFor("ada", { name: "encore", reason: "The encore.", at: Date.now(), thread: "ring" })).toBe("handed");
        }
        return { minutes: 1, blocks: READ_SOUL };
      },
      seen,
      undefined,
      async (world) => {
        expect(seen).toHaveLength(lastCall);
        expect(seen.map(textOf).join("\n")).not.toContain("encore");
        const kept = (await world.runtime.registry.getOrCreate("ada", "ring")).messages();
        expect(kept.filter((message) => message.content.includes("encore"))).toEqual([]);
        expect(kept.at(-1)?.content).toBe("[This wake used up its rounds of tool use, and Shore stopped it here.]");

        await world.runtime.autonomy.tick();
        expect(seen.length).toBeGreaterThan(lastCall);
        expect(textOf(required(seen[lastCall]))).toContain('[Your trigger "encore" fired at ');
        expect(world.runtime.autonomy.log("ada", 100).filter((event) => event.kind === "tick_fired").map((event) => event.detail)).toEqual([
          'Woken in "ring" by trigger "show"',
          'Woken in "ring" by trigger "encore"',
        ]);
      },
      { maxToolIterations: 2, wrapUpRounds, started: (world) => { ring = world; } },
    );
  }
});

test("a trigger shown to a wake in a step that its time limit then cuts off wakes the character there again", async () => {
  const seen: SidecarRequest[] = [];
  let ring: ChatWorld | undefined;
  await wokenInRing(
    () => {
      if (seen.length === 1) {
        expect(ring?.runtime.autonomy.wakeFor("ada", { name: "encore", reason: "The encore.", at: Date.now(), thread: "ring" })).toBe("handed");
        return { minutes: 1, blocks: READ_SOUL };
      }
      return seen.length === 2 ? { minutes: 40, blocks: READ_SOUL } : { minutes: 1, blocks: [{ type: "text", text: "HEARTBEAT_OK" }] };
    },
    seen,
    undefined,
    async (world) => {
      expect(seen).toHaveLength(2);
      expect(textOf(required(seen[1]))).toContain('[Your trigger "encore" fired at ');
      expect(world.runtime.autonomy.log("ada", 100).map((event) => event.kind)).toContain("timeout");

      await world.runtime.autonomy.tick();
      expect(seen).toHaveLength(3);
      expect(world.runtime.autonomy.log("ada", 100).filter((event) => event.kind === "tick_fired").map((event) => event.detail)).toEqual([
        'Woken in "ring" by trigger "show"',
        'Woken in "ring" by trigger "encore"',
      ]);
      await world.runtime.autonomy.tick();
      expect(seen).toHaveLength(3);
    },
    { started: (world) => { ring = world; } },
  );
});

test("a wake is nudged the moment its wrap-up time begins, and one that uses up its wrap-up rounds, or is allowed none, is stopped as out of time", async () => {
  const seen: SidecarRequest[] = [];
  await wokenInRing(
    () => ({ minutes: seen.length <= 3 ? 35 : 1, blocks: READ_SOUL }),
    seen,
    120 * MINUTE,
    async (world) => {
      expect(seen.map(nudged)).toEqual([false, false, false, true, false, false]);
      expect(textOf(required(seen[3]))).toContain("[System nudge: this wake stops in about 15 minutes or after 3 more rounds, counting this one, whichever comes first.");
      expect((await ringEnd(world)).at(-1)).toEqual(["system", "autonomous", "[This wake reached its limit of 2 hours, and Shore stopped it here.]"]);
      expect(ringNotes(world)).toEqual([["shore", 'Your wake in "ring" reached its limit of 2 hours before you finished. Where it stopped is in that thread.']]);
    },
  );

  const unwarned: SidecarRequest[] = [];
  await wokenInRing(
    () => ({ minutes: 35, blocks: READ_SOUL }),
    unwarned,
    120 * MINUTE,
    async (world) => {
      expect(unwarned.map(nudged)).toEqual([false, false, false]);
      expect((await ringEnd(world)).at(-1)).toEqual(["system", "autonomous", "[This wake reached its limit of 2 hours, and Shore stopped it here.]"]);
    },
    { wrapUpRounds: 0 },
  );
});
