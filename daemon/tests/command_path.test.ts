import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import fixture from "./handler_captures/command_path.json" with { type: "json" };
import { CharacterError, CharacterRegistry } from "../src/characters.ts";
import { MAIN_THREAD } from "../src/config/dirs.ts";
import { ConversationEngine } from "../src/engine/conversation.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import { AutonomyService } from "../src/autonomy/service.ts";
import {
  dispatchCommand,
  sessionEmitter,
  type CommandPathDeps,
} from "../src/handler/commands.ts";
import { characterPreferencesPath, loadPreferences } from "../src/config/preferences.ts";
import { SessionRouter, type RequestMeta } from "../src/swp/session.ts";
import { buildHandshakeProvider } from "../src/swp/handshake.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { existsSync } from "node:fs";
import { testTmp } from "./support/tmp.ts";
import { SnapshotGate } from "../src/snapshot_gate.ts";
import { parseOperationResult } from "../src/operations/contracts.ts";

const RID_DROPPED = new Set(["list_characters", "list_models", "list_providers"]);

const FIXTURE_MODEL = {
  name: "fixture",
  qualifiedName: "chat.fixture",
  category: "chat",
  providerKey: "anthropic",
  sdk: "anthropic",
  modelId: "claude-fixture",
  apiKeyEnv: "SHORE_FIXTURE_API_KEY",
  maxContextTokens: 200_000,
  maxOutputTokens: 4096,
  maxToolIterations: 4,
} as never;

interface Harness {
  deps: CommandPathDeps;
  savedModel(character: string): string | undefined;
  configDir: string;
  dirs: { config: string; data: string; cache: string; runtime: string };
  wireArchive(gate: SnapshotGate): void;
}

async function harness(characters: readonly string[]): Promise<Harness> {
  const root = await mkdtemp(testTmp("shore-cmdpath-"));
  const dirs = {
    config: join(root, "config"),
    data: join(root, "data"),
    cache: join(root, "cache"),
    runtime: join(root, "runtime"),
  };
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });
  for (const name of characters) {
    const workspace = join(dirs.config, "characters", name, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "SOUL.md"), `# ${name}`);
  }

  const app = defaultAppConfig();
  app.defaults.model = "fixture";
  const models = emptyCatalog();
  models.chat.set("chat.fixture", FIXTURE_MODEL);
  models.chat.set("chat.spare", {
    ...(FIXTURE_MODEL as unknown as Record<string, unknown>),
    name: "spare",
    qualifiedName: "chat.spare",
    modelId: "claude-spare",
  } as never);
  const config: LoadedConfig = {
    app,
    models,
    providers: ProviderRegistry.empty(),
    dirs,
    rawTable: undefined,
  };

  const engines = new Map<string, ConversationEngine>();

  const deps: CommandPathDeps = {
    registry: {
      resolveCharacter: (selected) => resolveCharacter(selected, characters, dirs.config),
      getOrCreate: async (name) => {
        const existing = engines.get(name);
        if (existing !== undefined) return existing;
        await mkdir(join(dirs.data, name), { recursive: true });
        const engine = await ConversationEngine.load(name, dirs.data, undefined);
        engines.set(name, engine);
        return engine;
      },
      effectiveConfig: () => config,
      listThreads: () => [{ id: MAIN_THREAD, created_at: "2026-09-03T00:00:00.000Z", compaction: true }],
    },
    globalConfig: () => config,
    configPath: join(dirs.config, "config.toml"),
    dataDir: dirs.data,
    commands: {
      autonomy: new AutonomyService(
        { run: async () => ({ ok: false, detail: "unwired" }) } as never,
      ),
      diagnostics: new Diagnostics(),
      callStore: undefined,
      ledgerPath: undefined,
      now: () => 0,
      localNow: () => 0,
    },
    runtime: {
      reloadRuntimeConfig: () => {},
      adoptGlobalConfig: () => {},
      notifyPromptSnapshotRefreshed: () => {},
    },
    dispatchRuntime: {
      globalConfig: () => config,
      reloadGlobalConfig: () => undefined,
      setEffectiveConfig: async () => {},
      reloadRuntimeConfig: () => {},
      refreshCachedRequest: async () => {},
      homeThread: () => MAIN_THREAD,
      cachedCharacters: () => [],
      warmThread: () => undefined,
      applyReloadedConfig: async () => ({
        characterDiscoveryChanged: false,
        droppedEngines: 0,
      }),
    },
    router: {
      characterFor: () => null,
      threadFor: () => null,
      setSelectedCharacter: () => {},
      sendToSession: async () => {},
    } as never,
    handshake: { history: async () => ({ messages: [], config: {} }) } as never,
  };

  return {
    deps,
    savedModel: (character) => savedSelection(dirs.data, character),
    configDir: dirs.config,
    dirs,
    wireArchive: (gate: SnapshotGate) => {
      deps.commands.archive = {
        dirs,
        hasCharacter: (name: string) => characters.includes(name),
        withSnapshot: async <T>(work: () => Promise<T>) => await gate.withSnapshot(work),
        refreshDiscovery: async () => undefined,
        releaseCharacter: async () => undefined,
      };
    },
  };
}

function charactersInPlay(input: Record<string, unknown>): string[] {
  return (input["characters_on_disk"] as string[]).slice().sort();
}

function savedSelection(dataDir: string, character: string): string | undefined {
  const selected = loadPreferences(characterPreferencesPath(dataDir, character)).selected;
  if (selected.provider === undefined || selected.modelId === undefined) return undefined;
  return `${selected.provider}:${selected.modelId}`;
}

function resolveCharacter(
  selected: string | undefined,
  available: readonly string[],
  configDir: string,
): string {
  if (selected !== undefined) {
    if (!available.includes(selected)) throw CharacterError.notFound(selected, available);
    return selected;
  }
  if (available.length === 0) throw CharacterError.noneAvailable(configDir);
  if (available.length > 1) throw CharacterError.ambiguous(available);
  return required(available[0]);
}

const RUST_NONE_AVAILABLE =
  "no characters available — create one at characters/<name>/workspace/SOUL.md";

function expectedMessage(message: string, configDir: string): string {
  if (message !== RUST_NONE_AVAILABLE) return message;
  return (
    `no characters available — create one at ${configDir}/characters/<name>/workspace/SOUL.md, ` +
    "or run: shore character --new <name>"
  );
}

function meta(selected: string | null, rid: string | null): RequestMeta {
  return {
    session: {
      clientId: 1,
      sessionId: 1,
      clientType: "test-client",
      clientName: "test-1",
      capabilities: ["streaming"],
      selectedCharacter: selected,
      selectedThread: null,
    },
    rid,
    kind: "command",
  };
}

test("discovery remains available when character configuration cannot load", async () => {
  const h = await harness(["ada"]);
  h.deps.registry.effectiveConfig = () => { throw new Error("bad character configuration"); };
  const frame = await dispatchCommand(h.deps, { name: "discover_operations", args: {} }, meta("ada", "discover"));
  expect(frame).toMatchObject({ type: "command_output", rid: "discover" });
  if (frame.type !== "command_output") throw new Error("Missing discovery result");
  const catalogue = parseOperationResult("discover_operations", frame.data);
  expect(catalogue.operations.find((operation) => operation.name === "create_character")?.available).toBe(true);
  expect(catalogue.operations.find((operation) => operation.name === "edit")?.available).toBe(false);
});

test("all provider operations remain global and reject malformed requests before discovery", async () => {
  const h = await harness([]);
  h.deps.registry.resolveCharacter = () => { throw new Error("Provider operations must not resolve a character"); };
  let fetched = false;
  h.deps.commands.fetchImpl = Object.assign(async () => { fetched = true; throw new Error("Unexpected provider request"); }, { preconnect: fetch.preconnect });
  const discovered = await dispatchCommand(h.deps, { name: "discover_operations", args: {} }, meta(null, "discover"));
  if (discovered.type !== "command_output") throw new Error("Missing discovery result");
  const operations = parseOperationResult("discover_operations", discovered.data).operations.filter((operation) => operation.category === "Providers");
  expect(operations).toHaveLength(4);
  expect(operations.every((operation) => operation.scope === "global" && operation.available === true)).toBe(true);
  const all = await dispatchCommand(h.deps, { name: "refresh_all_provider_models", args: {} }, meta(null, "all"));
  expect(all).toMatchObject({ type: "command_output", rid: "all", data: { results: [], skipped: [] } });
  const one = await dispatchCommand(h.deps, { name: "refresh_provider_models", args: { provider: "absent" } }, meta(null, "one"));
  expect(one).toMatchObject({ type: "error", rid: "one", message: 'provider "absent" is not configured' });
  for (const [name, args] of [["refresh_provider_models", {}], ["refresh_all_provider_models", { provider: "unexpected" }], ["list_provider_models", { provider: "fixture", include_hidden: "true" }]] as const) {
    const frame = await dispatchCommand(h.deps, { name, args }, meta(null, "invalid"));
    expect(frame).toMatchObject({ type: "error", rid: "invalid", code: "invalid_request" });
  }
  expect(fetched).toBe(false);
});

for (const thread of ["main", "side"]) {
  test(`resync restores full ${thread} history after a filtered log loses the delta anchor`, async () => {
    const h = await harness(["ada"]);
    const sent: ServerMessage[] = [];
    const registry = await CharacterRegistry.create(h.dirs.config, h.dirs.data, h.deps.globalConfig(),
      history => sent.push({ type: "history", ...history }));
    if (thread !== MAIN_THREAD) await registry.createThread("ada", thread);
    h.deps.registry = registry;
    h.deps.commands.threads = registry;
    h.deps.handshake = buildHandshakeProvider(registry);
    h.deps.router = new SessionRouter();
    h.deps.router.registerSession({ id: 1, clientType: "tui", clientName: "test", capabilities: ["history-deltas"], character: "ada", thread },
      async frame => { sent.push(frame); });
    h.deps.dispatchRuntime.refreshCachedRequest = async () => { throw new Error("resync must not reprime the cache"); };
    const initialRequest = meta("ada", "resync");
    const request = { ...initialRequest, session: { ...initialRequest.session, selectedThread: thread } };
    const engine = await registry.getOrCreate("ada", thread);
    const message = (id: string, role: "user" | "assistant") => ({ msg_id: id, role, content: id, images: [], content_blocks: [], timestamp: "2026-09-10T00:00:00Z" });
    await engine.appendMessage(message("user", "user"));
    await engine.appendMessage(message("reply", "assistant"));
    const filtered = await dispatchCommand(h.deps, { name: "log", args: { role: "system" } }, request);
    expect(filtered.type).toBe("command_output");
    if (filtered.type !== "command_output") throw new Error("log failed");
    expect(filtered.data).toMatchObject({ messages: [] });
    await engine.appendMessage(message("next", "user"));
    expect(sent.at(-1)).toMatchObject({ type: "history", delta: { after: "user" } });
    sent.length = 0;

    const response = await dispatchCommand(h.deps, { name: "switch_thread", args: { name: thread, resync: true } }, request);

    expect(response).toMatchObject({ type: "command_output", data: { thread, changed: false } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "history", selected_character: "ada", selected_thread: thread, revision: engine.currentRevision(), messages: engine.historySnapshot({}).messages });
    expect(sent[0]).not.toHaveProperty("delta");
    expect(h.deps.router.threadFor(1)).toBe(thread);
  });
}

function envelope(frame: Awaited<ReturnType<typeof dispatchCommand>>): Record<string, unknown> {
  if (frame.type === "command_output") {
    const data = frame.data;
    const record =
      typeof data === "object" && data !== null && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {};
    return {
      kind: "command_output",
      rid: frame.rid,
      name: frame.name,
      data_keys: Object.keys(record).sort(),
      data_active: record["active_model"] ?? record["active"] ?? null,
    };
  }
  if (frame.type === "error") {
    return { kind: "error", rid: frame.rid, code: frame.code, message: frame.message };
  }
  return { kind: "unexpected" };
}

describe("dispatchCommand", () => {
  for (const c of fixture.dispatch_command) {
    test(c.name, async () => {
      const input = c.input as Record<string, unknown>;
      const out = c.output as Record<string, unknown>;
      const h = await harness(input["characters_on_disk"] as string[]);
      const selected = (input["selected_character"] as string | null) ?? null;
      const prior = (input["prior_selected"] as string | null) ?? selected;

      if (input["prior_command"] !== null) {
        await dispatchCommand(
          h.deps,
          { rid: null, name: input["prior_command"] as string, args: input["prior_args"] },
          meta(prior, null),
        );
      }
      const savedBefore = charactersInPlay(input).map(
        (name) => [name, h.savedModel(name) ?? null] as const,
      );

      const frame = await dispatchCommand(
        h.deps,
        { rid: null, name: input["command"] as string, args: input["args"] },
        meta(selected, (input["rid"] as string | null) ?? null),
      );

      const got = envelope(frame);
      const want = out["frame"] as Record<string, unknown>;

      expect(got["kind"]).toBe(want["kind"] as string);

      const requestRid = (input["rid"] as string | null) ?? null;
      if (RID_DROPPED.has(input["command"] as string) && want["rid"] === null) {
        expect(got["rid"]).toBe(requestRid);
      } else {
        expect(got["rid"]).toBe(want["rid"] as string | null);
      }

      if (want["kind"] === "error") {
        expect(got["code"]).toBe(want["code"] as never);
        expect(got["message"]).toBe(expectedMessage(want["message"] as string, h.configDir));
      } else {
        expect(got["name"]).toBe(want["name"] as string);
        expect(got["data_keys"]).toEqual(expect.arrayContaining(want["data_keys"] as string[]));
        expect(got["data_active"]).toEqual(want["data_active"] ?? null);
      }

      expect(Object.fromEntries(savedBefore)).toEqual(
        (out["saved_models_before"] ?? {}) as never,
      );
      expect(
        Object.fromEntries(
          charactersInPlay(input).map((name) => [name, h.savedModel(name) ?? null] as const),
        ),
      ).toEqual((out["saved_models_after"] ?? {}) as never);
    });
  }
});

test("a character whose engine will not open is an internal error", async () => {
  const h = await harness(["ada"]);
  h.deps.registry.getOrCreate = async () => {
    throw new Error("active.jsonl is a directory");
  };

  const frame = await dispatchCommand(
    h.deps,
    { rid: null, name: "status", args: {} },
    meta("ada", "r-engine"),
  );

  expect(frame.type).toBe("error");
  if (frame.type === "error") {
    expect(frame.code).toBe("internal_error");
    expect(frame.message).toBe("active.jsonl is a directory");
    expect(frame.rid).toBe("r-engine");
  }
});

test("switch_character establishes an ambiguous unpinned session", async () => {
  const h = await harness(["Yuna", "frank"]);
  const selected: Array<[number, string | null]> = [];
  const sent: unknown[] = [];
  h.deps.router = {
    characterFor: () => null,
    setSelectedCharacter: (sessionId: number, character: string | null) => {
      selected.push([sessionId, character]);
      return true;
    },
    sendToSession: async (_sessionId: number, frame: unknown) => {
      sent.push(frame);
    },
  } as never;
  h.deps.handshake = {
    hello: async () => ({ characters: [{ name: "Yuna" }, { name: "frank" }] }),
    history: async (character: string | null) => ({
      messages: [],
      activeStart: 0,
      config: {},
      selectedCharacter: character,
      selectedThread: null,
      revision: 0,
    }),
  };

  const frame = await dispatchCommand(
    h.deps,
    { rid: null, name: "switch_character", args: { name: "frank" } },
    meta(null, "r-switch"),
  );

  expect(frame.type).toBe("command_output");
  if (frame.type === "command_output") expect(frame.rid).toBe("r-switch");
  expect(selected).toEqual([[1, "frank"]]);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ type: "history", selected_character: "frank" });
});

test("the character path is given the character's effective config", async () => {
  const h = await harness(["ada"]);
  const global = h.deps.globalConfig();
  const perCharacter: LoadedConfig = {
    ...global,
    app: { ...global.app, defaults: { ...global.app.defaults, model: "spare" } },
  };
  h.deps.registry.effectiveConfig = () => perCharacter;

  const frame = await dispatchCommand(
    h.deps,
    { rid: null, name: "status", args: {} },
    meta("ada", null),
  );

  expect(frame.type).toBe("command_output");
  if (frame.type === "command_output") {
    expect((frame.data as Record<string, unknown>)["active_model"]).toBe("chat.spare");
  }
});

async function setDefaultModel(h: Harness, value: string): Promise<Record<string, unknown>> {
  const frame = await dispatchCommand(
    h.deps,
    { rid: null, name: "config", args: { key: "chat.model", value } },
    meta("ada", null),
  );
  expect(frame.type).toBe("command_output");
  return frame.type === "command_output" ? (frame.data as Record<string, unknown>) : {};
}

test("a character with nothing saved masks no default", async () => {
  const h = await harness(["ada"]);
  await writeFile(h.deps.configPath, "[chat]\nmodel = \"fixture\"\n");

  expect(h.savedModel("ada")).toBeUndefined();
  expect((await setDefaultModel(h, "spare"))["masked_by_preference"]).toBeNull();
});

test("a saved model preference masks the default under its qualified name", async () => {
  const h = await harness(["ada"]);
  await writeFile(h.deps.configPath, "[chat]\nmodel = \"spare\"\n");

  await dispatchCommand(
    h.deps,
    { rid: null, name: "switch_model", args: { name: "spare" } },
    meta("ada", null),
  );
  expect(h.savedModel("ada")).toBe("anthropic:claude-spare");

  expect((await setDefaultModel(h, "fixture"))["masked_by_preference"]).toBe("chat.spare");
});

test("config_reload adopts the config the command re-read, not the one it started from", async () => {
  const h = await harness(["ada"]);
  await writeFile(
    h.deps.configPath,
    "[chat]\nmodel = \"spare\"\n",
  );
  const before = h.deps.globalConfig();
  const adopted: LoadedConfig[] = [];
  h.deps.dispatchRuntime.applyReloadedConfig = async (config) => {
    adopted.push(config);
    return { characterDiscoveryChanged: false, droppedEngines: 0 };
  };

  await dispatchCommand(
    h.deps,
    { rid: null, name: "config_reload", args: { apply: true } },
    meta("ada", null),
  );

  expect(adopted).toHaveLength(1);
  expect(adopted[0]).not.toBe(before);
  expect(adopted[0]?.app.defaults.model).toBe("spare");
});

test("progress frames from a command reach the session that asked, stamped with its rid", () => {
  const sent: Array<[number, Record<string, unknown>]> = [];
  const router = {
    sendToSession: async (sessionId: number, frame: unknown) => {
      sent.push([sessionId, frame as Record<string, unknown>]);
    },
  };

  const emit = sessionEmitter(router, 7, "r-compact");
  emit({ type: "phase", rid: null, phase: "compacting round 1", model: null });
  emit({
    type: "tool_call",
    rid: null,
    tool_id: "t1",
    tool_name: "edit",
    input: { path: "memory/notes.md" },
    subagent: "compaction",
    task_id: null,
  });

  expect(sent).toHaveLength(2);
  expect(sent[0]?.[0]).toBe(7);
  expect(sent[0]?.[1]).toMatchObject({ phase: "compacting round 1", rid: "r-compact" });
  expect(sent[1]?.[1]).toMatchObject({
    tool_name: "edit",
    subagent: "compaction",
    rid: "r-compact",
  });
});

test("a session with no rid still gets its progress frames", () => {
  const sent: unknown[] = [];
  const emit = sessionEmitter(
    { sendToSession: async (_id: number, frame: unknown) => void sent.push(frame) },
    3,
    undefined,
  );
  emit({ type: "phase", rid: null, phase: "compacting round 2", model: null });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ phase: "compacting round 2", rid: null });
});

describe("deleting a character through the command path", () => {
  test("it runs with no character selected and takes the workspace with it", async () => {
    const h = await harness(["ada", "bea"]);
    h.wireArchive(new SnapshotGate());

    const frame = await dispatchCommand(
      h.deps,
      { rid: null, name: "delete_character", args: { character: "ada", confirm: "ada" } },
      meta(null, null),
      new AbortController().signal,
    );

    expect(envelope(frame)["kind"]).toBe("command_output");
    expect(existsSync(join(h.dirs.config, "characters", "ada"))).toBe(false);
    expect(existsSync(join(h.dirs.config, "characters", "bea"))).toBe(true);
  });

  test("one abandoned while it waits for the snapshot leaves the character alone", async () => {
    const h = await harness(["ada"]);
    const gate = new SnapshotGate();
    h.wireArchive(gate);

    const controller = new AbortController();
    let releaseReader = (): void => undefined;
    const readerHeld = new Promise<void>((resolve) => {
      releaseReader = resolve;
    });
    const reader = gate.withActivity(async () => {
      await readerHeld;
    });

    const frame = dispatchCommand(
      h.deps,
      { rid: null, name: "delete_character", args: { character: "ada", confirm: "ada" } },
      meta(null, null),
      controller.signal,
    );

    controller.abort();
    releaseReader();
    await reader;

    expect(envelope(await frame)["kind"]).toBe("error");
    expect(existsSync(join(h.dirs.config, "characters", "ada"))).toBe(true);
  });
});

describe("an export abandoned while it waits for the snapshot", () => {
  test("dispatchCommand does not stage the character after its client leaves", async () => {
    const h = await harness(["ada"]);
    const gate = new SnapshotGate();
    h.wireArchive(gate);

    const controller = new AbortController();
    const output = join(h.dirs.cache, "ada.shore");

    let releaseReader = (): void => undefined;
    const readerHeld = new Promise<void>((resolve) => {
      releaseReader = resolve;
    });
    const reader = gate.withActivity(async () => {
      await readerHeld;
    });

    const frame = dispatchCommand(
      h.deps,
      { rid: null, name: "export_character", args: { character: "ada", output } },
      meta(null, null),
      controller.signal,
    );

    controller.abort();
    releaseReader();
    await reader;

    expect(envelope(await frame)["kind"]).toBe("error");
    expect(existsSync(output)).toBe(false);
  });

  test("the same export succeeds when the client stays", async () => {
    const h = await harness(["ada"]);
    h.wireArchive(new SnapshotGate());
    const output = join(h.dirs.cache, "ada.shore");

    const frame = await dispatchCommand(
      h.deps,
      { rid: null, name: "export_character", args: { character: "ada", output } },
      meta(null, null),
      new AbortController().signal,
    );

    expect(envelope(frame)["kind"]).toBe("command_output");
    expect(existsSync(output)).toBe(true);
  });
});
