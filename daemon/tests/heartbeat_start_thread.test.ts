import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import { readThreadsIndex } from "../src/engine/threads.ts";
import { buildGenerationDeps } from "../src/handler/deps.ts";
import { runGeneration } from "../src/handler/generation.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { createRuntime } from "../src/runtime.ts";
import { eventsForResponse } from "./support/stream.ts";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";
import { testTmp } from "./support/tmp.ts";

const KEY_ENV = "SHORE_HEARTBEAT_START_THREAD_KEY";

afterAll(restoreTestEnv);

function threadToolsProvider(toolResults: string[]): SidecarProvider {
  const calls: GenerateResponse["content_blocks"] = [
    {
      type: "tool_use",
      id: "start",
      name: "start_thread",
      input: { name: "lighthouse", label: "The lighthouse story", opening: "The lamp was already lit when we got there." },
    },
    { type: "tool_use", id: "edit", name: "edit_thread", input: { name: "lighthouse", purpose: "The keeper's winter, a chapter at a time." } },
  ];
  const reply = (request: SidecarRequest): GenerateResponse => {
    const heartbeat = request.context?.call_type.startsWith("heartbeat") === true;
    const tail = request.messages.at(-1)?.content;
    const results = Array.isArray(tail) ? tail.filter((block) => block.type === "tool_result") : [];
    for (const result of results) toolResults.push(JSON.stringify(result));
    const call = heartbeat ? calls[toolResults.length] : undefined;
    const blocks: GenerateResponse["content_blocks"] = call === undefined
      ? [{ type: "text", text: heartbeat ? "HEARTBEAT_OK" : "hello" }]
      : [call];
    return {
      model: request.model,
      content: blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join(""),
      content_blocks: blocks,
      finish_reason: call === undefined ? "end_turn" : "tool_use",
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      timing: { total_ms: 1, time_to_first_token_ms: 1 },
    };
  };
  return { generate: async (request) => reply(request), stream: (request) => eventsForResponse(reply(request)) };
}

test("a thread started and edited on a heartbeat opens with her message, takes the edit and shows up for the user, as in chat", async () => {
  setTestEnv(KEY_ENV, "fixture-key");
  const root = await mkdtemp(testTmp("shore-heartbeat-start-thread-"));
  const app = defaultAppConfig();
  app.defaults.model = "fixture";
  app.advanced.max_retries = 0;
  app.memory.compaction.enabled = false;
  app.tools.enabled_tools = ["start_thread", "edit_thread"];
  app.behavior.autonomy.enabled = true;
  const models = emptyCatalog();
  models.chat.set("chat.fixture", {
    name: "fixture", qualifiedName: "chat.fixture", category: "chat", providerKey: "anthropic",
    sdk: "anthropic", modelId: "claude-fixture", apiKeyEnv: KEY_ENV,
    maxContextTokens: 200_000, maxOutputTokens: 4096, maxToolIterations: 3,
  });
  const config: LoadedConfig = {
    app, models, providers: ProviderRegistry.empty(), rawTable: undefined,
    dirs: { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "runtime") },
  };
  const workspace = join(config.dirs.config, "characters", "ada", "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "SOUL.md"), "Ada");
  const toolResults: string[] = [];
  const events: ServerMessage[] = [];
  const env = { [KEY_ENV]: "fixture-key" };
  const runtime = await createRuntime({
    config, providers: { anthropic: threadToolsProvider(toolResults) }, env, emitEvent: (event) => events.push(event),
  });
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
      body: { rid: "chat", text: "hello", stream: true, images: [], image_data: [] },
      charName: "ada", regen: false, rid: "chat", signal: new AbortController().signal, send: async () => {},
    });
    await autonomy.settled("ada");
    expect(runtime.autonomy.forceHeartbeatNow("ada")).toBeDefined();
    await runtime.autonomy.tick();

    expect(toolResults).toHaveLength(2);
    expect(toolResults[0]).toContain('Started the thread \\"lighthouse\\"');
    expect(toolResults[1]).toContain('Changed the thread \\"lighthouse\\": purpose set.');
    const threads = await readThreadsIndex(config.dirs.data, "ada");
    expect(threads?.threads.find((thread) => thread.id === "lighthouse")).toMatchObject({
      label: "The lighthouse story", purpose: "The keeper's winter, a chapter at a time.", created_by: "character",
    });
    const thread = await runtime.registry.getOrCreate("ada", "lighthouse");
    expect(thread.messages().map((message) => [message.role, message.content])).toEqual([
      ["assistant", "The lamp was already lit when we got there."],
    ]);
    expect(events.filter((event) => event.type === "new_message" && event.thread === "lighthouse")).toHaveLength(1);
    expect(events.filter((event) => event.type === "threads_changed")).toEqual([
      { type: "threads_changed", character: "ada", thread: "heartbeat" },
      { type: "threads_changed", character: "ada", thread: "lighthouse" },
      { type: "threads_changed", character: "ada", thread: "lighthouse" },
    ]);
  } finally {
    await runtime.autonomy.shutdown();
    await runtime.shutdown();
  }
});
