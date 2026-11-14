import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test";
import { ConfigDuration } from "../src/config/duration.ts";
import { buildAnthropicPlan } from "../src/llm/providers/anthropic.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import { startRuntimeClocks } from "../src/runtime.ts";
import { required } from "../src/util/required.ts";
import { eventsForResponse } from "./support/stream.ts";
import { afterFirstChat } from "./support/chat_world.ts";
import { restoreTestEnv } from "./support/env.ts";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 8, 19, 12);
const KEY_ENV = "SHORE_KEEPALIVE_WAKE_KEY";
const CHAT_PREFIX_TOKENS = 4096;

afterAll(restoreTestEnv);
afterEach(() => setSystemTime());

function recordingProvider(seen: SidecarRequest[], wakeRead: number): SidecarProvider {
  const reply = (request: SidecarRequest): GenerateResponse => {
    seen.push(structuredClone(request));
    const waking = request.context?.call_type.startsWith("heartbeat") === true;
    const tail = request.messages.at(-1)?.content;
    const calledTool = Array.isArray(tail) && tail.some((block) => block.type === "tool_result");
    const blocks: GenerateResponse["content_blocks"] = waking && !calledTool
      ? [{ type: "tool_use", id: "look", name: "read", input: { file_path: "SOUL.md" } }]
      : [{ type: "text", text: waking ? "NO_NOTE" : "hello" }];
    return {
      model: request.model,
      content: blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join(""),
      content_blocks: blocks,
      finish_reason: waking && !calledTool ? "tool_use" : "end_turn",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: waking ? wakeRead : CHAT_PREFIX_TOKENS,
        cache_creation_tokens: 0,
      },
      timing: { total_ms: 1, time_to_first_token_ms: 1 },
    };
  };
  return { generate: async (request) => reply(request), stream: (request) => eventsForResponse(reply(request)) };
}

interface IdleChat {
  seen: SidecarRequest[];
  wakeAt: (minutes: number) => Promise<void>;
}

async function afterOneChat(wakeRead: number, idle: (chat: IdleChat) => Promise<void>): Promise<void> {
  setSystemTime(new Date(T0));
  const seen: SidecarRequest[] = [];
  await afterFirstChat({
    name: "keepalive-wake",
    keyEnv: KEY_ENV,
    provider: recordingProvider(seen, wakeRead),
    tools: [],
    autonomy: true,
    model: {
      maxToolRounds: 3,
      cacheTtl: "1h",
      cacheKeepalive: { kind: "every", interval: ConfigDuration.fromSecs(55 * 60) },
      cacheKeepalivePings: 1,
    },
    started: (runtime) => {
      const clocks = startRuntimeClocks(runtime);
      return () => { clocks.stop(); };
    },
  }, async ({ runtime }) => {
    await idle({
      seen,
      wakeAt: async (minutes) => {
        setSystemTime(new Date(T0 + minutes * MINUTE));
        expect(runtime.autonomy.wakeNow("ada")).toBeDefined();
        await runtime.autonomy.tick();
      },
    });
  });
}

function wireBlocks(messages: readonly { role: string; content: unknown }[]): { block: unknown; marked: boolean }[] {
  return messages.flatMap((message) =>
    (Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }]).map((block) => {
      const { cache_control: marker, ...rest } = block as { cache_control?: unknown };
      return { block: { role: message.role, ...rest }, marked: marker !== undefined };
    }),
  );
}

function wireOf(seen: SidecarRequest[], callType: string) {
  return buildAnthropicPlan(structuredClone(required(seen.find((request) => request.context?.call_type === callType)))).params;
}

test("a wake starts from a fresh context: none of the last wake's exchange is on its wire, under the same tools and system prompt", async () => {
  await afterOneChat(CHAT_PREFIX_TOKENS, async ({ seen, wakeAt }) => {
    await wakeAt(20);
    await wakeAt(50);
    const opening = seen.filter((request) => request.context?.call_type === "heartbeat");
    expect(opening).toHaveLength(2);
    const chat = wireOf(seen, "message");
    const first = buildAnthropicPlan(structuredClone(required(opening[0]))).params;
    const next = buildAnthropicPlan(structuredClone(required(opening[1]))).params;
    expect(next.tools).toEqual(chat.tools);
    expect(wireBlocks([{ role: "system", content: next.system }])).toEqual(wireBlocks([{ role: "system", content: first.system }]));
    expect(next.messages.map((message) => message.role)).toEqual(first.messages.map((message) => message.role));

    const sent = wireBlocks(next.messages).map((entry) => entry.block as { type?: string; text?: string });
    expect(sent.filter((block) => block.type === "tool_use" || block.type === "tool_result")).toEqual([]);
    expect(sent.some((block) => block.text === "NO_NOTE")).toBe(false);
  });
});
