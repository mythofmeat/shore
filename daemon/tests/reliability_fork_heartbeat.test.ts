import { afterAll, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CharacterRegistry } from "../src/characters.ts";
import { runHeartbeatTick } from "../src/autonomy/heartbeat_tick.ts";
import { LastRequestCache } from "../src/cache/last_request.ts";
import { characterDataDir, characterWorkspaceDir } from "../src/config/dirs.ts";
import { generationEngine } from "../src/handler/generation.ts";
import { recoverForks } from "../src/engine/fork.ts";
import { readState } from "../src/storage/store.ts";
import { applyDeferredEdits, pendingDeferredEditPaths, queueDeferredEdit, loadPromptFile } from "../src/memory/deferred_edits.ts";
import { buildHandshakeProvider } from "../src/swp/handshake.ts";
import type { SidecarRequest } from "../src/llm/types.ts";
import { reliabilityGeneration } from "./support/reliability_generation.ts";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";

afterAll(restoreTestEnv);

const plain = {
  generate: async () => { throw new Error("stream only"); },
  async *stream() {
    yield {
      type: "done" as const, content: "reply", finish_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      timing: { total_ms: 1, time_to_first_token_ms: 1 },
    };
  },
};

test("a first client can connect while a heartbeat is generating and receive its persisted message", async () => {
  setTestEnv("SHORE_RELIABILITY_KEY", "fixture");
  const h = await reliabilityGeneration(plain);
  await h.run();
  const registry = await CharacterRegistry.create(h.config.dirs.config, h.config.dirs.data, h.config);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const tick = runHeartbeatTick("ada", h.config, {
    cache: new LastRequestCache(),
    dispatch: async () => ({ output: "ok", isError: false }),
    scheduleNextWake: () => "scheduled",
    budgetBlockFor: () => undefined,
    engine: (name, thread) => registry.getOrCreate(name, thread),
    generate: async (request, phase) => {
      await phase.runTool({ id: "send", name: "send_message", input: { text: "heartbeat reply" } });
      started.resolve();
      await release.promise;
      return {
        content: "", content_blocks: [], finish_reason: "end_turn", model: request.model,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        timing: { total_ms: 1, time_to_first_token_ms: 1 },
      };
    },
  });
  await started.promise;
  const history = buildHandshakeProvider(registry).history("ada", "main");
  try {
    const connected = await Promise.race([history.then(() => true), Bun.sleep(1000).then(() => false)]);
    expect(connected).toBe(true);
  } finally {
    release.resolve();
  }
  await tick;
  expect((await registry.getOrCreate("ada")).messages().at(-1)?.content).toBe("heartbeat reply");
});

for (const source of ["main", "side"]) {
  test(`a fork from ${source} keeps frozen prompts and applies deferred edits independently`, async () => {
    const requests: SidecarRequest[] = [];
    const h = await reliabilityGeneration({ ...plain, async *stream(request) {
      requests.push(request);
      yield* plain.stream();
    } }, source);
    const registry = await CharacterRegistry.create(h.config.dirs.config, h.config.dirs.data, h.config);
    if (source !== "main") await registry.createThread("ada", source);
    const workspace = characterWorkspaceDir(h.config.dirs.config, "ada", h.config.dirs.workspace);
    await writeFile(join(workspace, "MEMORY.md"), "Original memory");
    await h.run();
    const original = JSON.stringify(requests.at(-1)?.system);
    const charDir = characterDataDir(h.config.dirs.data, "ada");
    for (const name of ["SOUL.md", "MEMORY.md"]) {
      await writeFile(join(workspace, name), `Deferred ${name}`);
      await queueDeferredEdit(charDir, name, source);
    }
    await registry.forkThread("ada", source, "child");
    const child = await registry.getOrCreate("ada", "child");
    h.deps.registry.getOrCreate = async () => generationEngine(child);
    await h.run();
    expect(JSON.stringify(requests.at(-1)?.system)).toBe(original);
    expect(await pendingDeferredEditPaths(charDir, "child")).toEqual(["MEMORY.md", "SOUL.md"]);
    await applyDeferredEdits(charDir, h.config.dirs.config, "ada", h.config.dirs.workspace, "child");
    await h.run();
    expect(JSON.stringify(requests.at(-1)?.system)).toContain("Deferred SOUL.md");
    expect(await pendingDeferredEditPaths(charDir, "child")).toEqual([]);
    expect(await pendingDeferredEditPaths(charDir, source)).toEqual(["MEMORY.md", "SOUL.md"]);
    h.deps.registry.getOrCreate = async () => generationEngine(h.engine);
    await h.run();
    expect(JSON.stringify(requests.at(-1)?.system)).toBe(original);
  });
}

for (const stage of ["context", "provenance", "publish"] as const) {
  test(`fork recovery preserves prompt ownership after interruption at ${stage}`, async () => {
    const h = await reliabilityGeneration(plain);
    const registry = await CharacterRegistry.create(h.config.dirs.config, h.config.dirs.data, h.config);
    await h.run();
    const charDir = characterDataDir(h.config.dirs.data, "ada");
    await queueDeferredEdit(charDir, "SOUL.md");
    expect(registry.forkThread("ada", "main", "child", { failAfter: stage })).rejects.toThrow("injected fork failure");
    await recoverForks(h.config.dirs.data, "ada");
    const snapshot = readState(h.config.dirs.data, "ada/threads/child/active_prompt/.snapshot", "ada");
    expect(snapshot).toBe(stage === "publish" ? "1" : undefined);
    expect(await pendingDeferredEditPaths(charDir, "child")).toEqual(stage === "publish" ? ["SOUL.md"] : []);
    expect(await loadPromptFile(charDir, h.config.dirs.config, "ada", "SOUL.md")).toBe("Ada");
    expect(await pendingDeferredEditPaths(charDir)).toEqual(["SOUL.md"]);
  });
}
