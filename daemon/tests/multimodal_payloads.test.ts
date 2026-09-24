import { expect, test } from "bun:test";
import { AnthropicProvider } from "../src/llm/providers/anthropic.ts";
import { OpenAIProvider } from "../src/llm/providers/openai.ts";
import { ZaiProvider } from "../src/llm/providers/zai.ts";
import { VercelProvider } from "../src/llm/providers/vercel.ts";
import { GeminiProvider } from "../src/llm/providers/gemini.ts";
import { toCallToolResult } from "../src/llm/providers/claude_agent_tools.ts";
import { withToolImages } from "../src/llm/tool_images.ts";
import { genericToolLoopEvents } from "../src/llm/providers/generic_loop.ts";
import { HistoryStore } from "../src/engine/history_store.ts";
import { contentForClient, MULTIMODAL_TOOL_RESULTS } from "../src/swp/content_projection.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";
import type { SidecarProvider, SidecarRequest, StreamEvent } from "../src/llm/types.ts";
import { countImageBlocks, MAX_REQUEST_IMAGES, REQUEST_IMAGE_DROP_STEP } from "../src/llm/image_support.ts";
import { required } from "../src/util/required.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const image: ContentBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } };
const uses: ContentBlock[] = ["a", "b"].map((id) => ({ type: "tool_use", id, name: "inspect", input: { id } }));
const results: ContentBlock[] = ["a", "b"].map((id) => ({ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: `image ${id}` }, image], is_error: false }));
function request(sdk: SidecarRequest["sdk"] = "openai"): SidecarRequest {
  return {
    sdk, model: "vision-test", api_key: "test", max_tokens: 64, replay_prior_thinking: "all",
    tools: [{ name: "inspect", description: "inspect", input_schema: { type: "object" } }],
    messages: [{ role: "assistant", content: uses }, ...results.map((block) => ({ role: "user" as const, content: [block] }))],
  };
}

for (const sdk of ["anthropic", "openai", "nanogpt", "zai", "openrouter", "deepseek", "moonshot", "gemini"] as const) {
  test(`${sdk} sends actual associated images in its final HTTP payload`, async () => {
    const bodies: Record<string, unknown>[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      bodies.push(await req.json() as Record<string, unknown>);
      return Response.json({ error: { type: "invalid_request_error", message: "fixture stops after payload" } }, { status: 400 });
    } });
    const provider: SidecarProvider = sdk === "anthropic" ? new AnthropicProvider() : sdk === "gemini" ? new GeminiProvider() : sdk === "zai" ? new ZaiProvider() : ["openai", "nanogpt"].includes(sdk) ? new OpenAIProvider() : new VercelProvider();
    try {
      const req = { ...request(sdk), base_url: server.url.toString(), provider_options: { gemini_generation: 3 } };
      try { await provider.generate(req, AbortSignal.timeout(5000)); } catch {}
      expect(bodies).toHaveLength(1);
      const body = required(bodies[0]);
      const messages = body.messages as Array<Record<string, unknown>> | undefined;
      if (sdk === "gemini") {
        const contents = body.contents as Array<{ parts: Array<Record<string, unknown>> }>;
        const parts = required(contents[1]).parts;
        for (const [index, id] of ["a", "b"].entries()) expect(parts[index]).toEqual({
          functionResponse: { id, name: "inspect", response: { result: `image ${id}` }, parts: [{ inlineData: { mimeType: "image/png", data: PNG } }] },
        });
      } else if (sdk === "anthropic") {
        const parts = required(messages).slice(1).flatMap((message) => message.content as Array<Record<string, unknown>>);
        for (const [index, id] of ["a", "b"].entries()) expect(parts[index]).toMatchObject({ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: `image ${id}` }, image] });
      } else {
        const msgs = required(messages);
        expect(msgs.map((m) => m.role)).toEqual(["assistant", "tool", "tool", "user"]);
        expect(msgs[1]).toMatchObject({ tool_call_id: "a", content: "image a" });
        expect(msgs[2]).toMatchObject({ tool_call_id: "b", content: "image b" });
        const parts = required(msgs[3]).content as Array<Record<string, unknown>>;
        for (const [index, id] of ["a", "b"].entries()) {
          expect(parts[index * 2]).toMatchObject({ type: "text", text: `Images from tool inspect (tool_call_id: ${id}):` });
          expect(parts[index * 2 + 1]).toMatchObject({ type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } });
        }
      }
    } finally { await server.stop(true); }
  });
}

test("Claude Agent uses native MCP image content", () => {
  const result = toCallToolResult(required(results[0]));
  expect(result.content).toEqual([{ type: "text", text: "image a" }, { type: "image", mimeType: "image/png", data: PNG }]);
});

const done: StreamEvent = { type: "done", content: "done", finish_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, timing: { total_ms: 0, time_to_first_token_ms: 0 } };

test("vision requests carry only the newest images within the per-request cap", async () => {
  const sent: SidecarRequest[] = [];
  const warnings: string[] = [];
  const base: SidecarProvider = {
    generate: () => Promise.reject(new Error("not used")),
    async *stream(call) { sent.push(call); yield done; },
  };
  const provider = withToolImages(base, { support: () => true, rejected: () => {}, warn: (s) => warnings.push(s) });
  const req = request();
  req.messages = Array.from({ length: MAX_REQUEST_IMAGES + 1 }, (_, i) => ({ role: "user" as const, content: [{ type: "text" as const, text: String(i) }, image] }));
  for await (const _event of provider.stream(req)) { void _event; }
  expect(countImageBlocks(required(sent[0]).messages)).toBe(MAX_REQUEST_IMAGES + 1 - REQUEST_IMAGE_DROP_STEP);
  expect(required(sent[0]).messages[0]?.content[1]).toMatchObject({ type: "text" });
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain(`${String(REQUEST_IMAGE_DROP_STEP)} older image(s) omitted`);
  expect(countImageBlocks(req.messages)).toBe(MAX_REQUEST_IMAGES + 1);
});

test.each([false, true])("image policy applies to new results and retries only the failed continuation (reject: %s)", async (reject) => {
  const req = request();
  req.messages = [{ role: "user", content: [{ type: "text", text: "inspect" }] }];
  const sent: SidecarRequest[] = [];
  const recorded: ContentBlock[][] = [];
  const warnings: string[] = [];
  let executed = 0;
  let rejections = 0;
  const base: SidecarProvider = {
    generate: () => Promise.reject(new Error("not used")),
    async *stream(call) {
      sent.push(structuredClone(call));
      if (sent.length === 1) {
        yield { type: "tool_use", id: "a", name: "inspect", input: {} };
        yield { ...done, finish_reason: "tool_use" };
      } else if (reject && sent.length === 2) {
        yield { type: "error", message: "image input is not supported", usage: done.usage, timing: done.timing };
      } else yield done;
    },
  };
  const provider = withToolImages(base, { support: () => reject ? undefined : false, rejected: () => { rejections += 1; }, warn: (s) => warnings.push(s) });
  for await (const _event of genericToolLoopEvents(provider, req, {
    messages: [], runTool: () => { executed += 1; return Promise.resolve(required(results[0])); },
    recordTurn: (_role, blocks) => { recorded.push(blocks); },
  })) { void _event; }
  expect(executed).toBe(1);
  expect(sent).toHaveLength(reject ? 3 : 2);
  expect(rejections).toBe(reject ? 1 : 0);
  expect(warnings).toHaveLength(1);
  expect(countImageBlocks(required(sent.at(-1)).messages)).toBe(0);
  expect(required(sent.at(-1)).messages.at(-1)?.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "a", is_error: true });
  expect(recorded[1]).toEqual([required(results[0])]);
  expect(countImageBlocks(req.messages)).toBe(1);
});

test("structured image results survive history storage and legacy wire projection", () => {
  const store = HistoryStore.openInMemory();
  const message: Message = { msg_id: "u1", role: "user", content: "image a\nimage b", alt_index: 0, alt_count: 1, images: [], content_blocks: results, timestamp: "2026-09-21T00:00:00Z" };
  const alt = { content: message.content, images: [], content_blocks: results, timestamp: message.timestamp };
  message.alternatives = [alt];
  try {
    store.putSegment("ada", 0, { file: "0001.jsonl", message_count: 1, compacted_at: message.timestamp }, [message]);
    expect(store.readSegment("ada", 0)).toEqual([message]);
    const wire = JSON.parse(JSON.stringify({ type: "history", messages: [message], config: {}, revision: 1 })) as import("../src/protocol/ServerMessage.ts").ServerMessage;
    const legacy = contentForClient(wire, []);
    expect(JSON.stringify(legacy)).not.toContain(PNG);
    expect(JSON.stringify(legacy)).toContain("Image attached");
    expect(contentForClient(wire, [MULTIMODAL_TOOL_RESULTS])).toBe(wire);
    expect(store.readSegment("ada", 0)).toEqual([message]);
  } finally { store.close(); }
});

test("Gemini preserves signed call IDs through execution and replay", async () => {
  const { geminiStreamEvents, translateMessages } = await import("../src/llm/providers/gemini.ts");
  const chunks = (async function* () {
    yield { candidates: [{ content: { parts: [{ functionCall: { id: "native-id", name: "read", args: { file_path: "chart.png" } }, thoughtSignature: "opaque-signature" }] }, finishReason: "STOP" }] } as unknown as import("@google/genai").GenerateContentResponse;
  })();
  const events = await Array.fromAsync(geminiStreamEvents("gemini-3-pro", chunks));
  const use = events.find((event) => event.type === "tool_use");
  expect(use).toMatchObject({ id: "native-id", thought_signature: "opaque-signature" });
  expect(events.at(-1)).toMatchObject({ type: "done", finish_reason: "tool_use" });
  if (use?.type !== "tool_use") throw new Error("no function call");
  const contents = translateMessages([
    { role: "assistant", content: [use] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: [image] }] },
  ], 3);
  expect(contents[0]?.parts?.[0]).toMatchObject({ functionCall: { id: "native-id", name: "read" }, thoughtSignature: "opaque-signature" });
  expect(contents[1]?.parts?.[0]).toMatchObject({ functionResponse: { id: "native-id", name: "read", parts: [{ inlineData: { mimeType: "image/png", data: PNG } }] } });
});
