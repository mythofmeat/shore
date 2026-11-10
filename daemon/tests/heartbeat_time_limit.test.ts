import { afterAll, afterEach, expect, jest, test } from "bun:test";
import type { HeartbeatEvent } from "../src/autonomy/heartbeat_log.ts";
import { wrapUpNudgeText } from "../src/autonomy/heartbeat_shape.ts";
import type { Message } from "../src/engine/types.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import { required } from "../src/util/required.ts";
import { eventsForResponse } from "./support/stream.ts";
import { afterFirstChat } from "./support/chat_world.ts";
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
