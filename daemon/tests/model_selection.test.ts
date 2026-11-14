import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import { effectiveChatModel } from "../src/commands/models.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { adoptHomeThreadModel } from "../src/config/home_model.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { loadForCharacter, saveCharacterPreferences } from "../src/config/preferences.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import { threadChatModel } from "../src/engine/threads.ts";
import { dispatchCommand } from "../src/handler/commands.ts";
import { buildCommandPathDeps } from "../src/handler/deps.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { createRuntime, type ShoreRuntime } from "../src/runtime.ts";
import { DEFAULT_HANDSHAKE } from "../src/swp/connection.ts";
import { SessionRouter } from "../src/swp/session.ts";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";
import { testTmp } from "./support/tmp.ts";

const KEY_ENV = "SHORE_MODEL_SELECTION_KEY";

afterAll(restoreTestEnv);

type Run = (name: string, args: Record<string, unknown>, thread: string | null) => Promise<ServerMessage>;

async function withAda(check: (runtime: ShoreRuntime, run: Run) => Promise<void>): Promise<void> {
  setTestEnv(KEY_ENV, "fixture-key");
  const root = await mkdtemp(testTmp("shore-model-selection-"));
  const app = defaultAppConfig();
  app.chat.model = "fixture";
  const models = emptyCatalog();
  for (const name of ["fixture", "pinned"]) {
    models.chat.set(`chat.${name}`, {
      name, qualifiedName: `chat.${name}`, category: "chat", providerKey: "anthropic",
      sdk: "anthropic", modelId: `claude-${name}`, apiKeyEnv: KEY_ENV,
      maxContextTokens: 200_000, maxOutputTokens: 4096,
    });
  }
  const config: LoadedConfig = {
    app, models, providers: ProviderRegistry.empty(), rawTable: undefined,
    dirs: { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "runtime") },
  };
  const workspace = join(config.dirs.config, "characters", "ada", "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "SOUL.md"), "Ada");
  const env = { [KEY_ENV]: "fixture-key" };
  const runtime = await createRuntime({ config, providers: {}, env });
  try {
    const commands = buildCommandPathDeps({
      runtime, autonomy: new TurnAutonomyBridge(runtime.autonomy), diagnostics: new Diagnostics(),
      router: new SessionRouter(), handshake: DEFAULT_HANDSHAKE, providers: runtime.providers, env,
    });
    await check(runtime, async (name, args, thread) => await dispatchCommand(commands, { name, args }, {
      session: { sessionId: 1, clientId: 1, clientType: "test", clientName: "test", capabilities: [], selectedCharacter: "ada", selectedThread: thread },
      rid: name,
      kind: "command",
    }));
  } finally {
    await runtime.autonomy.shutdown();
    await runtime.shutdown();
  }
}

function pins(runtime: ShoreRuntime): Record<string, string | undefined> {
  return Object.fromEntries(runtime.registry.listThreads("ada").map((thread) => [thread.id, thread.chat_model]));
}

test("choosing a model without naming a thread sets the character's model, even from a side thread, and a named thread keeps its own", async () => {
  await withAda(async (runtime, run) => {
    await runtime.registry.createThread("ada", "side");

    expect((await run("switch_model", { name: "pinned" }, "side")).type).toBe("command_output");
    expect(pins(runtime)).toEqual({ main: undefined, side: undefined });
    expect(effectiveChatModel(runtime.config, "ada")?.modelId).toBe("claude-pinned");

    expect((await run("thread_model", { name: "side", model: "fixture" }, "main")).type).toBe("command_output");
    expect(pins(runtime)).toEqual({ main: undefined, side: "chat.fixture" });
    expect((await run("thread_model", { name: "side", model: "no-such-model" }, "main")).type).toBe("error");
    expect(pins(runtime)).toEqual({ main: undefined, side: "chat.fixture" });

    expect((await run("reset_model", {}, "side")).type).toBe("command_output");
    expect(pins(runtime)).toEqual({ main: undefined, side: "chat.fixture" });
    expect(effectiveChatModel(runtime.config, "ada")?.modelId).toBe("claude-fixture");
  });
});

test("a home thread pinned while the character's saved model no longer resolves hands that model to the character, once", async () => {
  await withAda(async (runtime) => {
    const data = runtime.config.dirs.data;
    await runtime.registry.setThreadModel("ada", "main", "chat.pinned");
    const [, prefs] = loadForCharacter(data, "ada");
    prefs.selected = { provider: "claude-agent", modelId: "claude-gone" };
    saveCharacterPreferences(data, "ada", prefs);
    const unpin = async (thread: string): Promise<unknown> => await runtime.registry.setThreadModel("ada", thread, undefined);

    expect(await adoptHomeThreadModel(runtime.config, "ada", unpin)).toBe(true);
    expect(loadForCharacter(data, "ada")[1].selected).toEqual({ provider: "anthropic", modelId: "claude-pinned" });
    expect(await threadChatModel(data, "ada", "main")).toBeUndefined();
    expect(effectiveChatModel(runtime.config, "ada")?.modelId).toBe("claude-pinned");

    await runtime.registry.setThreadModel("ada", "main", "chat.fixture");
    expect(await adoptHomeThreadModel(runtime.config, "ada", unpin)).toBe(false);
    expect(await threadChatModel(data, "ada", "main")).toBe("chat.fixture");
  });
});
