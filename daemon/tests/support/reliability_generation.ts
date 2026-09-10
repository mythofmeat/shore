import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { testTmp } from "./tmp.ts";
import { defaultAppConfig } from "../../src/config/app.ts";
import { emptyCatalog } from "../../src/config/models.ts";
import { ProviderRegistry } from "../../src/config/providers.ts";
import type { LoadedConfig } from "../../src/config/loader.ts";
import { ConversationEngine } from "../../src/engine/conversation.ts";
import { generationEngine, runGeneration, type GenerationDeps } from "../../src/handler/generation.ts";
import type { SidecarProvider } from "../../src/llm/types.ts";
import type { ServerMessage } from "../../src/protocol/ServerMessage.ts";

export async function reliabilityGeneration(provider: SidecarProvider, thread = "main") {
  const root = await mkdtemp(testTmp("reliability-"));
  const config: LoadedConfig = {
    app: defaultAppConfig(), models: emptyCatalog(), providers: ProviderRegistry.empty(),
    dirs: { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "runtime") },
    rawTable: undefined,
  };
  for (const dir of [config.dirs.config, config.dirs.data, config.dirs.cache, config.dirs.runtime]) await mkdir(dir, { recursive: true });
  await mkdir(join(config.dirs.config, "characters", "ada"), { recursive: true });
  await writeFile(join(config.dirs.config, "characters", "ada", "character.md"), "Ada");
  config.app.defaults.model = "fixture";
  config.models.chat.set("chat.fixture", {
    name: "fixture", qualifiedName: "chat.fixture", category: "chat", providerKey: "anthropic",
    sdk: "anthropic", modelId: "claude-fixture", apiKeyEnv: "SHORE_RELIABILITY_KEY",
    maxContextTokens: 200_000, maxOutputTokens: 4096, maxToolIterations: 4,
  });
  const engine = await ConversationEngine.load("ada", config.dirs.data, undefined, thread);
  const frames: ServerMessage[] = [];
  const deps: GenerationDeps = {
    registry: {
      getOrCreate: async () => generationEngine(engine), effectiveConfig: () => config,
      listThreads: () => [{ id: thread, created_at: new Date().toISOString(), compaction: true }],
    },
    dataDir: config.dirs.data, providers: { anthropic: provider },
    autonomy: {
      ensureState: () => false, needsActivityBackfill: () => false, backfillActivity: () => {},
      onUserMessage: () => {}, shouldCompactNow: () => false, onCompactionComplete: () => {},
      onCompactionFailed: () => {}, notifyLastRequest: () => {}, notifyAssistantMessage: () => {},
    },
    notifier: { notifyMessageComplete: () => {} } as unknown as GenerationDeps["notifier"],
    diagnostics: { key_fallbacks: { push: () => {} } }, emitEvent: (frame) => { frames.push(frame); },
    mcpRegistry: { toolDefsFiltered: () => [], call: async () => undefined },
    compaction: { run: async () => ({ kind: "completed", retained: 0 }), applyDeferredEdits: async () => {} },
    newlyCrossedUsageBudgetWarnings: async () => [], env: { SHORE_RELIABILITY_KEY: "fixture" },
    sleep: async () => {},
  };
  return {
    root, config, engine, deps, frames,
    run: (signal = new AbortController().signal, text = "hello") => runGeneration(deps, {
      meta: { session: { sessionId: 1 } } as never,
      body: { rid: null, text, stream: true, images: [], image_data: [] },
      regen: false, charName: "ada", rid: null, signal,
      send: async (frame) => { frames.push(frame); },
    }),
  };
}
