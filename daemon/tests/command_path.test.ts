import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import fixture from "./handler_fixtures/command_path.json" with { type: "json" };
import { CharacterError } from "../src/characters.ts";
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
import type { RequestMeta } from "../src/swp/session.ts";
import { testTmp } from "./support/tmp.ts";

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
      setUsageConfig: () => {},
      setCacheKeepaliveCeiling: () => {},
      notifyPromptSnapshotRefreshed: () => {},
    },
    dispatchRuntime: {
      globalConfig: () => config,
      reloadGlobalConfig: () => undefined,
      setEffectiveConfig: async () => {},
      reloadRuntimeConfig: () => {},
      applyReloadedConfig: async () => ({
        characterDiscoveryChanged: false,
        droppedEngines: 0,
      }),
    },
    router: {
      characterFor: () => null,
      setSelectedCharacter: () => {},
      sendToSession: async () => {},
    } as never,
    handshake: { history: async () => ({ messages: [], config: {} }) } as never,
  };

  return {
    deps,
    savedModel: (character) => savedSelection(dirs.data, character),
    configDir: dirs.config,
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
    },
    rid,
    kind: "command",
  };
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
  const h = await harness(["Yuna", "poppy"]);
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
    hello: async () => ({ characters: [{ name: "Yuna" }, { name: "poppy" }] }),
    history: async (character: string | null) => ({
      messages: [],
      activeStart: 0,
      config: {},
      selectedCharacter: character,
      revision: 0,
    }),
  };

  const frame = await dispatchCommand(
    h.deps,
    { rid: null, name: "switch_character", args: { name: "poppy" } },
    meta(null, "r-switch"),
  );

  expect(frame.type).toBe("command_output");
  if (frame.type === "command_output") expect(frame.rid).toBe("r-switch");
  expect(selected).toEqual([[1, "poppy"]]);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ type: "history", selected_character: "poppy" });
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
    { rid: null, name: "config", args: { key: "defaults.model", value } },
    meta("ada", null),
  );
  expect(frame.type).toBe("command_output");
  return frame.type === "command_output" ? (frame.data as Record<string, unknown>) : {};
}

test("a character with nothing saved masks no default", async () => {
  const h = await harness(["ada"]);
  await writeFile(h.deps.configPath, '[defaults]\nmodel = "fixture"\n');

  expect(h.savedModel("ada")).toBeUndefined();
  expect((await setDefaultModel(h, "spare"))["masked_by_preference"]).toBeNull();
});

test("a saved model preference masks the default under its qualified name", async () => {
  const h = await harness(["ada"]);
  await writeFile(h.deps.configPath, '[defaults]\nmodel = "spare"\n');

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
    '[defaults]\nmodel = "spare"\n',
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
