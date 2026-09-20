import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog, resolvedModelFromParts } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import { buildGenerationDeps } from "../src/handler/deps.ts";
import { runGeneration } from "../src/handler/generation.ts";
import { OpenAIProvider } from "../src/llm/providers/openai.ts";
import type { Sdk } from "../src/llm/types.ts";
import { createRuntime } from "../src/runtime.ts";
import { required } from "../src/util/required.ts";
import { testTmp } from "./support/tmp.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";

async function chat(modelId: string, sdk: Sdk, cacheTtl?: string, reasoningEffort?: string) {
  const seen: Array<{ path: string; accept: string | null; body: Record<string, unknown> }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/usage")) return Response.json({ active: false, state: "inactive" });
      const body = await request.json() as Record<string, unknown>;
      seen.push({ path, accept: request.headers.get("accept"), body });
      const chunk = {
        id: "fixture", object: "chat.completion.chunk", created: 1, model: modelId,
        choices: [{ index: 0, delta: { content: "image received" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 2 },
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const root = await mkdtemp(testTmp("shore-nanogpt-transport-"));
  const app = defaultAppConfig();
  app.defaults.model = "fixture";
  app.advanced.max_retries = 0;
  app.memory.compaction.enabled = false;
  app.tools.enabled_tools = [];
  const models = emptyCatalog();
  models.chat.set("chat.fixture", resolvedModelFromParts(
    "fixture", "chat.fixture", "chat", "nanogpt", modelId, sdk,
    { sdk, baseUrl: `http://localhost:${server.port}/api/v1`, apiKeyEnv: "SHORE_NANOGPT_WIRE_KEY",
      maxContextTokens: 200_000, maxOutputTokens: 128, supportsImages: true,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(cacheTtl === undefined ? {} : { cacheTtl }) },
  ));
  const config: LoadedConfig = {
    app, models, providers: ProviderRegistry.empty(), rawTable: undefined,
    dirs: { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "runtime") },
  };
  const workspace = join(config.dirs.config, "characters", "ada", "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "SOUL.md"), "Ada");
  const imagePath = join(root, "picture.png");
  await writeFile(imagePath, Buffer.from(PNG, "base64"));
  const env = { SHORE_NANOGPT_WIRE_KEY: "fixture-key" };
  const runtime = await createRuntime({ config, providers: { [sdk]: new OpenAIProvider() }, env });
  try {
    const autonomy = new TurnAutonomyBridge(runtime.autonomy);
    const deps = buildGenerationDeps({
      runtime, providers: runtime.providers, autonomy, diagnostics: new Diagnostics(), env, emitEvent: () => {},
    });
    await runGeneration(deps, {
      meta: {
        session: { sessionId: 1, clientId: 1, clientType: "test", clientName: "test", capabilities: [], selectedCharacter: "ada", selectedThread: "main" },
        rid: "chat", kind: "message",
      },
      body: { rid: "chat", text: "Describe this image", stream: true, images: [imagePath], image_data: [{ filename: "picture.png", mime_type: "image/png", data: PNG }] },
      charName: "ada", regen: false, rid: "chat", signal: AbortSignal.timeout(5000), send: async () => {},
    });
    await autonomy.settled("ada");
    expect(runtime.keepalive.nextPingAt("ada")).toBeUndefined();
    return required(seen[0]);
  } finally {
    await runtime.autonomy.shutdown();
    await runtime.shutdown();
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}

test.each(["nanogpt", "openai"] as const)("Gemini chat via %s uses NanoGPT's documented streaming transport", async (sdk) => {
  const sent = await chat("google/gemini-flash-latest", sdk);
  expect(sent.path).toBe("/api/v1/chat/completions");
  expect(sent.accept).toBe("text/event-stream");
  expect(sent.body["model"]).toBe("google/gemini-flash-latest");
  expect(sent.body["max_tokens"]).toBe(128);
  expect(sent.body["max_completion_tokens"]).toBeUndefined();
  expect(sent.body["stream_options"]).toEqual({ include_usage: true });
});

test("DeepSeek image attachments reach the chat endpoint byte for byte", async () => {
  const sent = await chat("deepseek/deepseek-v4.1-flash", "nanogpt");
  const messages = sent.body["messages"] as Array<{ content: unknown }>;
  const parts: unknown[] = messages.flatMap((message): unknown[] => Array.isArray(message.content) ? message.content as unknown[] : []);
  expect(parts.filter((part) => typeof part === "object" && part !== null && "type" in part && part.type === "image_url")).toEqual([
    { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
  ]);
});

test("turning reasoning off survives model resolution and reaches NanoGPT", async () => {
  const sent = await chat("google/gemini-flash-latest", "nanogpt", undefined, "off");
  expect(sent.body["reasoning_effort"]).toBe("none");
});

test.each(["google/gemini-flash-latest", "deepseek/deepseek-v4.1-flash"])("%s never receives Claude cache controls", async (model) => {
  const sent = await chat(model, "nanogpt", "1h");
  expect(sent.body["prompt_caching"]).toBeUndefined();
  expect(JSON.stringify(sent.body["messages"])).not.toContain("cache_control");
});

test("NanoGPT rejects the native Gemini transport during model resolution", () => {
  expect(() => resolvedModelFromParts(
    "gemini", "nanogpt:google/gemini-flash-latest", "chat", "nanogpt",
    "google/gemini-flash-latest", "nanogpt", { sdk: "gemini" },
  )).toThrow('sdk = "nanogpt"');
});
