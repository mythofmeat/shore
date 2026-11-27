import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import { buildCommandPathDeps, buildGenerationDeps } from "../src/handler/deps.ts";
import { createRuntime } from "../src/runtime.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { DEFAULT_HANDSHAKE } from "../src/swp/handshake.ts";
import { SessionRouter } from "../src/swp/session.ts";
import { characterWorkspace } from "../src/tools/character_workspace.ts";
import { required } from "../src/util/required.ts";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";
import { promptedAppConfig } from "./support/prompt_list.ts";
import { testTmp } from "./support/tmp.ts";

const KEY_ENV = "SHORE_COMMAND_DEPS_KEY";

afterAll(restoreTestEnv);

async function world(): Promise<{ config: LoadedConfig; env: Record<string, string> }> {
  setTestEnv(KEY_ENV, "fixture-key");
  const root = await mkdtemp(testTmp("shore-command-deps-"));
  const app = promptedAppConfig();
  app.chat.model = "fixture";
  const models = emptyCatalog();
  models.chat.set("chat.fixture", {
    name: "fixture", qualifiedName: "chat.fixture", category: "chat", providerKey: "anthropic",
    sdk: "anthropic", modelId: "claude-fixture", apiKeyEnv: KEY_ENV, maxContextTokens: 200_000, maxOutputTokens: 4096,
  });
  const config: LoadedConfig = {
    app, models, providers: ProviderRegistry.empty(), rawTable: undefined,
    dirs: { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "runtime") },
  };
  await mkdir(join(config.dirs.config, "characters", "ada", "workspace"), { recursive: true });
  await writeFile(join(config.dirs.config, "characters", "ada", "workspace", "SOUL.md"), "Ada");
  return { config, env: { [KEY_ENV]: "fixture-key" } };
}

test("the commands' dependencies hand each command the runtime's parts, with the daemon's environment", async () => {
  const { config, env } = await world();
  const runtime = await createRuntime({ config, providers: {}, env });
  try {
    const autonomy = new TurnAutonomyBridge(runtime.autonomy);
    const emitted: ServerMessage[] = [];
    const reads = { lastRead: () => undefined } as never;
    const deps = buildCommandPathDeps({ runtime, autonomy, diagnostics: new Diagnostics(), router: new SessionRouter(), handshake: DEFAULT_HANDSHAKE, providers: runtime.providers, env, reads, emitEvent: (message) => emitted.push(message) }).commands;
    expect([deps.reads, deps.compaction?.run.env, deps.keepalive?.rebuild.env]).toEqual([reads, env, env]);

    const invalidated = spyOn(runtime.cache, "invalidate");
    const reprimed = spyOn(runtime.cache, "reprimeFromDisk").mockResolvedValue({ kind: "superseded" } as never);
    await deps.compaction?.repoint?.("ada", config);
    expect([invalidated.mock.calls, reprimed.mock.calls.map(([character, , , rebuild]) => [character, rebuild.env])]).toEqual([[["ada", "compaction"]], [["ada", env]]]);

    deps.threadsChanged?.("ada", "side");
    expect(emitted).toEqual([{ type: "threads_changed", character: "ada", thread: "side" }]);

    const status = spyOn(runtime.triggers, "statusChanged");
    await deps.presenceChanged?.();
    expect(status).toHaveBeenCalledTimes(1);

    const noted = spyOn(runtime.historyIndex, "noteMutation");
    deps.historyIndex?.noteMutation?.("ada");
    expect(noted.mock.calls).toEqual([["ada"]]);

    const reloaded = spyOn(runtime.registry, "reloadRuntimeState");
    await deps.archive?.refreshDiscovery?.();
    expect(reloaded).toHaveBeenCalledTimes(1);

    const ensured = spyOn(autonomy, "ensureState");
    const settled = spyOn(autonomy, "settled");
    await deps.onCharacterCreated?.("ada");
    expect([reloaded.mock.calls.length, ensured.mock.calls.map(([character]) => character), settled.mock.calls]).toEqual([2, ["ada"], [["ada"]]]);
    const created = await deps.activate?.register("ada", runtime.registry.effectiveConfig("ada"));
    expect([created, settled.mock.calls.length]).toEqual([ensured.mock.results.at(-1)?.value as boolean, 2]);
  } finally {
    await runtime.shutdown();
  }
});

test("without an environment, reads or a place to send events, the commands get none of them", async () => {
  const { config, env } = await world();
  const runtime = await createRuntime({ config, providers: {}, env });
  try {
    const deps = buildCommandPathDeps({ runtime, autonomy: new TurnAutonomyBridge(runtime.autonomy), diagnostics: new Diagnostics(), router: new SessionRouter(), handshake: DEFAULT_HANDSHAKE, providers: runtime.providers }).commands;
    expect(["reads" in deps, "threadsChanged" in deps, "env" in required(deps.compaction).run, "env" in required(deps.keepalive).rebuild]).toEqual([false, false, false, false]);
    const reprimed = spyOn(runtime.cache, "reprimeFromDisk").mockResolvedValue({ kind: "superseded" } as never);
    await deps.compaction?.repoint?.("ada", config);
    expect(reprimed.mock.calls.map(([, , , rebuild]) => "env" in rebuild)).toEqual([false]);
  } finally {
    await runtime.shutdown();
  }
});

test("an archive reads the character's workspace setup from disk, not from what was loaded before", async () => {
  const { config, env } = await world();
  const runtime = await createRuntime({ config, providers: {}, env });
  try {
    const deps = buildCommandPathDeps({ runtime, autonomy: new TurnAutonomyBridge(runtime.autonomy), diagnostics: new Diagnostics(), router: new SessionRouter(), handshake: DEFAULT_HANDSHAKE, providers: runtime.providers, env }).commands;
    const before = characterWorkspace(runtime.registry.globalConfig(), "ada").promptFiles;
    await writeFile(join(config.dirs.config, "characters", "ada", "config.toml"), '[[prompt]]\nworkspace = "LATER.md"\n');
    expect([before.includes("LATER.md"), required(deps.archive?.workspace?.("ada")).promptFiles.includes("LATER.md")]).toEqual([false, true]);
  } finally {
    await runtime.shutdown();
  }
});

test("a chat turn's archive passes the daemon's environment to the rebuilt cached request, and runs as activity", async () => {
  const { config, env } = await world();
  const runtime = await createRuntime({ config, providers: {}, env });
  try {
    const compaction = buildGenerationDeps({ runtime, providers: runtime.providers, autonomy: new TurnAutonomyBridge(runtime.autonomy), diagnostics: new Diagnostics(), env, emitEvent: () => {} }).compaction;
    const activity = spyOn(runtime.snapshotGate, "withActivity");
    const reprimed = spyOn(runtime.cache, "reprimeFromDisk").mockResolvedValue({ kind: "superseded" } as never);
    const engine = await runtime.registry.getOrCreate("ada", "main");
    for (const [index, role] of (["user", "assistant", "user", "assistant"] as const).entries()) {
      await engine.appendMessage({ msg_id: `m_${String(index)}`, role, content: "x", content_blocks: [{ type: "text", text: "x" }], images: [], timestamp: "2026-11-24T00:00:00Z" });
    }
    config.app.compaction.keep_recent_turns = 1;
    await compaction.run("ada", config, "main");
    expect([activity.mock.calls.length, reprimed.mock.calls.map(([, , , rebuild]) => rebuild.env)]).toEqual([1, [env]]);
  } finally {
    await runtime.shutdown();
  }
});
