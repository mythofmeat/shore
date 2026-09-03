import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  buildHandshakeProvider,
  buildSessionHistorySnapshot,
  helloSnapshot,
  HistorySnapshotError,
  type HandshakeRegistry,
} from "../src/swp/handshake.ts";
import { EngineCharacterNotFound } from "../src/characters.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { MAIN_THREAD } from "../src/config/dirs.ts";
import type { ConversationEngine, History } from "../src/engine/conversation.ts";
import type { ThreadRecord } from "../src/engine/threads.ts";
import { testTmp } from "./support/tmp.ts";

const MODEL = {
  name: "fixture",
  qualifiedName: "chat.fixture",
  category: "chat",
  providerKey: "anthropic",
  sdk: "anthropic",
  modelId: "claude-fixture",
  maxContextTokens: 200_000,
  maxOutputTokens: 4096,
} as never;

function configFor(
  root: string,
  over: { model?: string; catalog?: false | string } = {},
): LoadedConfig {
  const app = defaultAppConfig();
  if (over.model !== undefined) app.defaults.model = over.model;
  const models = emptyCatalog();
  if (over.catalog !== false) {
    const name = over.catalog ?? "chat.fixture";
    models.chat.set(name, { ...(MODEL as object), qualifiedName: name } as never);
  }
  return {
    app,
    models,
    providers: ProviderRegistry.empty(),
    dirs: {
      config: join(root, "config"),
      data: join(root, "data"),
      cache: join(root, "cache"),
      runtime: join(root, "runtime"),
    },
    rawTable: undefined,
  };
}

function engineWith(history: Partial<History>, thread = MAIN_THREAD): ConversationEngine {
  return {
    thread,
    historySnapshot: () => ({
      messages: [],
      config: {},
      revision: 0,
      ...history,
    }),
  } as unknown as ConversationEngine;
}

function threadRecords(...ids: string[]): ThreadRecord[] {
  return ids.map((id) => ({ id, created_at: "2026-09-03T00:00:00.000Z", compaction: false }));
}

function registry(
  parts: Partial<HandshakeRegistry> & { globalConfig: () => LoadedConfig },
): HandshakeRegistry {
  return {
    availableCharacters: () => [],
    effectiveConfig: parts.globalConfig,
    getOrCreate: () => Promise.reject(new Error("character not found")),
    listThreads: () => [],
    ...parts,
  };
}

describe("the hello snapshot", () => {
  test("names every character on disk and inlines the avatars it finds", async () => {
    const root = await mkdtemp(testTmp("shore-handshake-hello-"));
    const config = configFor(root);
    await mkdir(join(config.dirs.config, "characters", "ada"), { recursive: true });
    await writeFile(join(config.dirs.config, "characters", "ada", "avatar.png"), "PNGBYTES");
    await mkdir(join(config.dirs.config, "characters", "nova"), { recursive: true });

    const hello = helloSnapshot(
      registry({ globalConfig: () => config, availableCharacters: () => ["ada", "nova"] }),
    );

    expect(hello.characters).toEqual([
      { name: "ada", avatar: { mime_type: "image/png", data: btoa("PNGBYTES") } },
      { name: "nova" },
    ]);
  });

  test("no characters is an empty list, not a placeholder", async () => {
    const root = await mkdtemp(testTmp("shore-handshake-none-"));
    expect(helloSnapshot(registry({ globalConfig: () => configFor(root) })).characters).toEqual([]);
  });
});

describe("the history snapshot", () => {
  test("no character selected is an empty conversation with a config block", async () => {
    const root = await mkdtemp(testTmp("shore-handshake-nochar-"));
    const config = configFor(root, { model: "chat.fixture" });

    const snapshot = await buildSessionHistorySnapshot(
      registry({ globalConfig: () => config }),
      null,
    );

    expect(snapshot.messages).toEqual([]);
    expect(snapshot.selectedCharacter).toBeNull();
    expect(snapshot.revision).toBe(0);
    expect(snapshot.config).toEqual({ active_model: "chat.fixture" });
  });

  test("a character that is gone answers empty rather than refusing the handshake", async () => {
    const root = await mkdtemp(testTmp("shore-handshake-gone-"));
    const config = configFor(root, { model: "chat.fixture" });

    const snapshot = await buildSessionHistorySnapshot(
      registry({
        globalConfig: () => config,
        getOrCreate: () => Promise.reject(new EngineCharacterNotFound("ghost")),
      }),
      "ghost",
    );

    expect(snapshot.messages).toEqual([]);
    expect(snapshot.selectedCharacter).toBeNull();
  });

  test("the snapshot names the thread the engine is actually on", async () => {
    const root = await mkdtemp(testTmp("shore-handshake-thread-"));
    const config = configFor(root, { model: "chat.fixture" });
    const opened: Array<string | undefined> = [];

    const snapshot = await buildSessionHistorySnapshot(
      registry({
        globalConfig: () => config,
        listThreads: () => threadRecords(MAIN_THREAD, "scratch"),
        getOrCreate: (_name, thread) => {
          opened.push(thread);
          return Promise.resolve(engineWith({ selected_character: "ada" }, thread ?? MAIN_THREAD));
        },
      }),
      "ada",
      "scratch",
    );

    expect(opened).toEqual(["scratch"]);
    expect(snapshot.selectedThread).toBe("scratch");
  });

  test("a session pointed at a thread that no longer exists falls back to home", async () => {
    const root = await mkdtemp(testTmp("shore-handshake-stale-"));
    const config = configFor(root, { model: "chat.fixture" });
    const opened: Array<string | undefined> = [];

    const snapshot = await buildSessionHistorySnapshot(
      registry({
        globalConfig: () => config,
        listThreads: () => threadRecords(MAIN_THREAD),
        getOrCreate: (_name, thread) => {
          opened.push(thread);
          return Promise.resolve(engineWith({ selected_character: "ada" }));
        },
      }),
      "ada",
      "archived",
    );

    expect(opened).toEqual([undefined]);
    expect(snapshot.selectedThread).toBe(MAIN_THREAD);
  });

  test("a character that fails to load is an error, not an empty conversation", async () => {
    const root = await mkdtemp(testTmp("shore-handshake-broken-"));
    const config = configFor(root, { model: "chat.fixture" });

    const attempt = buildSessionHistorySnapshot(
      registry({
        globalConfig: () => config,
        getOrCreate: () => Promise.reject(new Error("transcript.jsonl: unexpected end of JSON input")),
      }),
      "yuna",
    );

    expect(attempt).rejects.toThrow(HistorySnapshotError);
    expect(attempt).rejects.toThrow(/unexpected end of JSON input/);
  });

  test("a live character carries its conversation, revision and resolved name", async () => {
    const root = await mkdtemp(testTmp("shore-handshake-live-"));
    const config = configFor(root, { model: "chat.fixture" });
    const messages = [{ msg_id: "m_1", role: "user", content: "hi" }] as never;

    const snapshot = await buildSessionHistorySnapshot(
      registry({
        globalConfig: () => config,
        getOrCreate: () =>
          Promise.resolve(
            engineWith({ messages, revision: 7, selected_character: "ada" }),
          ),
      }),
      "ada",
    );

    expect(snapshot.messages).toEqual(messages);
    expect(snapshot.revision).toBe(7);
    expect(snapshot.selectedCharacter).toBe("ada");
  });

  test("a push snapshot starts at zero, because it carries no scrollback", async () => {
    const root = await mkdtemp(testTmp("shore-handshake-start-"));
    const config = configFor(root, { model: "chat.fixture" });

    const snapshot = await buildSessionHistorySnapshot(
      registry({
        globalConfig: () => config,
        getOrCreate: () => Promise.resolve(engineWith({ selected_character: "ada" })),
      }),
      "ada",
    );

    expect(snapshot.activeStart).toBe(0);
  });

  test("with no character selected the registry is never asked for an engine", async () => {
    const root = await mkdtemp(testTmp("shore-handshake-unasked-"));
    const config = configFor(root, { model: "chat.fixture" });
    const asked: unknown[] = [];

    await buildSessionHistorySnapshot(
      registry({
        globalConfig: () => config,
        getOrCreate: (name) => {
          asked.push(name);
          return Promise.resolve(engineWith({ revision: 9, selected_character: "ada" }));
        },
      }),
      null,
    );

    expect(asked).toEqual([]);
  });

  test("the snapshot reports the engine's own name, not the one asked for", async () => {
    const root = await mkdtemp(testTmp("shore-handshake-resolved-"));
    const config = configFor(root, { model: "chat.fixture" });

    const snapshot = await buildSessionHistorySnapshot(
      registry({
        globalConfig: () => config,
        getOrCreate: () => Promise.resolve(engineWith({ selected_character: "ada" })),
      }),
      "ADA",
    );

    expect(snapshot.selectedCharacter).toBe("ada");
  });

  test("a selected character is read through its effective config", async () => {
    const root = await mkdtemp(testTmp("shore-handshake-effective-"));
    const global = configFor(root, { catalog: "chat.global" });
    const perCharacter = configFor(root, { catalog: "chat.override" });

    const snapshot = await buildSessionHistorySnapshot(
      registry({
        globalConfig: () => global,
        effectiveConfig: () => perCharacter,
        getOrCreate: () => Promise.resolve(engineWith({ selected_character: "ada" })),
      }),
      "ada",
    );

    expect(snapshot.config).toEqual({ active_model: "chat.override" });
  });
});

describe("which model the config block reports", () => {
  test("the caller's choice outranks anything resolved", async () => {
    const root = await mkdtemp(testTmp("shore-handshake-given-"));
    const config = configFor(root, { model: "chat.fixture" });

    const snapshot = await buildSessionHistorySnapshot(
      registry({
        globalConfig: () => config,
        getOrCreate: () => Promise.resolve(engineWith({ selected_character: "ada" })),
      }),
      "ada",
      null,
      "chat.just-selected",
    );

    expect(snapshot.config).toEqual({ active_model: "chat.just-selected" });
  });

  test("with no default configured it falls back to the first model in the catalog", async () => {
    const root = await mkdtemp(testTmp("shore-handshake-first-"));
    const config = configFor(root);

    const snapshot = await buildSessionHistorySnapshot(
      registry({ globalConfig: () => config }),
      null,
    );

    expect(snapshot.config).toEqual({ active_model: "chat.fixture" });
  });

  test("a character's saved pick outranks the config default", async () => {
    const root = await mkdtemp(testTmp("shore-handshake-prefs-"));
    const config = configFor(root, { model: "chat.fixture" });
    config.models.chat.set("chat.picked", {
      ...(MODEL as object),
      qualifiedName: "chat.picked",
      modelId: "claude-picked",
    } as never);

    const prefs = join(config.dirs.data, "ada", "preferences", "models.toml");
    await mkdir(join(config.dirs.data, "ada", "preferences"), { recursive: true });
    await writeFile(prefs, '[selected]\nprovider = "anthropic"\nmodel_id = "claude-picked"\n');

    const snapshot = await buildSessionHistorySnapshot(
      registry({
        globalConfig: () => config,
        getOrCreate: () => Promise.resolve(engineWith({ selected_character: "ada" })),
      }),
      "ada",
    );

    expect(snapshot.config).toEqual({ active_model: "chat.picked" });
  });

  test("with nothing to report at all it is null rather than absent", async () => {
    const root = await mkdtemp(testTmp("shore-handshake-empty-"));
    const config = configFor(root, { catalog: false });

    const snapshot = await buildSessionHistorySnapshot(
      registry({ globalConfig: () => config }),
      null,
    );

    expect(snapshot.config).toEqual({ active_model: null });
  });
});

describe("the provider the transport is handed", () => {
  test("answers both snapshots from the live registry", async () => {
    const root = await mkdtemp(testTmp("shore-handshake-provider-"));
    const config = configFor(root, { model: "chat.fixture" });
    await mkdir(join(config.dirs.config, "characters", "ada"), { recursive: true });

    const provider = buildHandshakeProvider(
      registry({
        globalConfig: () => config,
        availableCharacters: () => ["ada"],
        getOrCreate: () => Promise.resolve(engineWith({ revision: 2, selected_character: "ada" })),
      }),
    );

    expect((await provider.hello()).characters).toEqual([{ name: "ada" }]);
    expect((await provider.history("ada")).revision).toBe(2);
  });
});
