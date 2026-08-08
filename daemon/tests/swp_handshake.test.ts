/**
 * What a client is actually told on connect, now that something answers.
 *
 * The transport's own handshake is pinned by `swp_parity.json`; this is the
 * provider behind it, and what it is worth pinning for is the set of answers
 * that are deliberately *not* errors:
 *
 * - **No character selected** is the normal state of a fresh connection, not a
 *   missing one. It still carries the config block, because the client renders
 *   its model name from it before it has chosen anything.
 * - **A character that is not there** answers the same way. The Rust used
 *   `.ok()` on `get_or_create` — a client naming a character that has been
 *   deleted gets an empty conversation rather than a refused handshake, which
 *   would lock it out of the daemon entirely.
 *
 * And one that is an error nowhere and wrong everywhere: which *config* the
 * snapshot reads. A selected character reads its effective config, so a
 * per-character `[chat]` override is what the client is shown; reading the
 * global one instead shows a model the character will not use.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  buildHandshakeProvider,
  buildSessionHistorySnapshot,
  helloSnapshot,
  type HandshakeRegistry,
} from "../src/swp/handshake.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import type { ConversationEngine, History } from "../src/engine/conversation.ts";
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

/** A stub engine: the one snapshot method the provider reaches for. */
function engineWith(history: Partial<History>): ConversationEngine {
  return {
    historySnapshot: () => ({
      messages: [],
      config: {},
      revision: 0,
      ...history,
    }),
  } as unknown as ConversationEngine;
}

function registry(
  parts: Partial<HandshakeRegistry> & { globalConfig: () => LoadedConfig },
): HandshakeRegistry {
  return {
    availableCharacters: () => [],
    effectiveConfig: parts.globalConfig,
    getOrCreate: () => Promise.reject(new Error("character not found")),
    ...parts,
  } as HandshakeRegistry;
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

    // The bytes travel rather than the path: a client is not assumed to be able
    // to read the daemon's config directory, and may not be on this machine.
    expect(hello.characters).toEqual([
      { name: "ada", avatar: { mime_type: "image/png", data: btoa("PNGBYTES") } },
      { name: "nova" },
    ]);
  });

  test("no characters is an empty list, not a placeholder", async () => {
    const root = await mkdtemp(testTmp("shore-handshake-none-"));
    // `DEFAULT_HANDSHAKE` answers with one character called `default`, which is
    // the stub. A real daemon with nothing configured says so.
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
    // The client renders the model name from here before it has chosen a
    // character, so an empty conversation still has to carry it.
    expect(snapshot.config).toEqual({ active_model: "chat.fixture" });
  });

  test("a character that is gone answers empty rather than refusing the handshake", async () => {
    const root = await mkdtemp(testTmp("shore-handshake-gone-"));
    const config = configFor(root, { model: "chat.fixture" });

    const snapshot = await buildSessionHistorySnapshot(
      registry({
        globalConfig: () => config,
        getOrCreate: () => Promise.reject(new Error("character not found: ghost")),
      }),
      "ghost",
    );

    // Throwing here would lock the client out of the daemon over a character it
    // merely remembered from last time.
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.selectedCharacter).toBeNull();
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
    // The engine's own name, which is the one that has been resolved.
    expect(snapshot.selectedCharacter).toBe("ada");
  });

  test("a push snapshot starts at zero, because it carries no scrollback", async () => {
    const root = await mkdtemp(testTmp("shore-handshake-start-"));
    const config = configFor(root, { model: "chat.fixture" });

    const snapshot = await buildSessionHistorySnapshot(
      registry({
        globalConfig: () => config,
        // `historySnapshot` leaves the field unset — only bounded log/history
        // responses put archived messages in front of the index.
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

    // Asking with no name would create — or resurrect — an engine for a
    // character called `null`, and answer the client with its revision.
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

    // The engine's is the resolved one. Echoing the request back tells a client
    // its own spelling was accepted when what it is looking at is another
    // character's conversation.
    expect(snapshot.selectedCharacter).toBe("ada");
  });

  test("a selected character is read through its effective config", async () => {
    const root = await mkdtemp(testTmp("shore-handshake-effective-"));
    // The two configs differ in the catalog rather than only in
    // `defaults.model`, because the per-character resolver consults the
    // catalog first — a name that resolves nowhere falls through and both
    // configs would answer the same thing for the wrong reason.
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

    // Reading the global config here shows the client a model the character
    // will not actually use — a discrepancy with no error attached to it.
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
      "chat.just-selected",
    );

    // The character-switch and model-change callers have already set it. Going
    // back to preferences would report the model they just replaced.
    expect(snapshot.config).toEqual({ active_model: "chat.just-selected" });
  });

  test("with no default configured it falls back to the first model in the catalog", async () => {
    const root = await mkdtemp(testTmp("shore-handshake-first-"));
    const config = configFor(root);

    const snapshot = await buildSessionHistorySnapshot(
      registry({ globalConfig: () => config }),
      null,
    );

    // Better than a blank where the model name goes: a config with no
    // `defaults.model` still has a model it would use.
    expect(snapshot.config).toEqual({ active_model: "chat.fixture" });
  });

  test("a character's saved pick outranks the config default", async () => {
    const root = await mkdtemp(testTmp("shore-handshake-prefs-"));
    // Two chat models, and the config default is the other one — so only the
    // saved preference can produce this answer.
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
