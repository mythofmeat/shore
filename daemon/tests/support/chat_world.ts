import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TurnAutonomyBridge } from "../../src/autonomy/registration.ts";
import { defaultAppConfig, type AppConfig } from "../../src/config/app.ts";
import type { LoadedConfig } from "../../src/config/loader.ts";
import { emptyCatalog, type ModelCatalog, type ResolvedModel } from "../../src/config/models.ts";
import { ProviderRegistry } from "../../src/config/providers.ts";
import { Diagnostics } from "../../src/diagnostics.ts";
import { buildGenerationDeps } from "../../src/handler/deps.ts";
import { runGeneration } from "../../src/handler/generation.ts";
import type { SidecarProvider } from "../../src/llm/types.ts";
import type { ServerMessage } from "../../src/protocol/ServerMessage.ts";
import { createRuntime } from "../../src/runtime.ts";
import { setTestEnv } from "./env.ts";
import { testTmp } from "./tmp.ts";

export type ChatRuntime = Awaited<ReturnType<typeof createRuntime>>;

export interface ChatWorld {
  root: string;
  config: LoadedConfig;
  workspace: string;
  runtime: ChatRuntime;
  say: (text: string, thread?: string) => Promise<void>;
}

export interface ChatWorldOptions {
  name: string;
  keyEnv: string;
  provider: SidecarProvider;
  tools: readonly string[];
  autonomy?: boolean;
  models?: readonly string[];
  model?: Partial<ResolvedModel>;
  tune?: (app: AppConfig, models: ModelCatalog) => void;
  prepare?: (workspace: string) => Promise<void> | void;
  started?: (runtime: ChatRuntime) => () => void;
  emitEvent?: (event: ServerMessage) => void;
}

export async function afterFirstChat(options: ChatWorldOptions, run: (world: ChatWorld) => Promise<void>): Promise<void> {
  setTestEnv(options.keyEnv, "fixture-key");
  const root = await mkdtemp(testTmp(`shore-${options.name}-`));
  const app = defaultAppConfig();
  app.chat.model = "fixture";
  app.chat.max_retries = 0;
  app.compaction.enabled = false;
  app.tools.enabled = [...options.tools];
  if (options.autonomy === true) app.triggers.enabled = true;
  const models = emptyCatalog();
  for (const name of options.models ?? ["fixture"]) {
    models.chat.set(`chat.${name}`, {
      name, qualifiedName: `chat.${name}`, category: "chat", providerKey: "anthropic",
      sdk: "anthropic", modelId: `claude-${name}`, apiKeyEnv: options.keyEnv,
      maxContextTokens: 200_000, maxOutputTokens: 4096,
      ...(name === "fixture" ? options.model : {}),
    });
  }
  options.tune?.(app, models);
  const config: LoadedConfig = {
    app, models, providers: ProviderRegistry.empty(), rawTable: undefined,
    dirs: { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "runtime") },
  };
  const workspace = join(config.dirs.config, "characters", "ada", "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "SOUL.md"), "Ada");
  await options.prepare?.(workspace);
  const env = { [options.keyEnv]: "fixture-key" };
  const runtime = await createRuntime({
    config, providers: { anthropic: options.provider }, env,
    ...(options.emitEvent === undefined ? {} : { emitEvent: options.emitEvent }),
  });
  const stop = options.started?.(runtime);
  try {
    const autonomy = new TurnAutonomyBridge(runtime.autonomy);
    const deps = buildGenerationDeps({
      runtime, providers: runtime.providers, autonomy, diagnostics: new Diagnostics(), env, emitEvent: () => {},
    });
    const say = async (text: string, thread = "main"): Promise<void> => {
      await runGeneration(deps, {
        meta: {
          session: { sessionId: 1, clientId: 1, clientType: "test", clientName: "test", capabilities: [], selectedCharacter: "ada", selectedThread: thread },
          rid: "chat", kind: "message",
        },
        body: { rid: "chat", text, stream: true, images: [], image_data: [] },
        charName: "ada", regen: false, rid: "chat", signal: new AbortController().signal, send: async () => {},
      });
      await autonomy.settled("ada");
    };
    await say("hello");
    await run({ root, config, workspace, runtime, say });
  } finally {
    stop?.();
    await runtime.autonomy.shutdown();
    await runtime.shutdown();
  }
}
