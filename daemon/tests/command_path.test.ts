/**
 * Recorded cases for command path.
 *
 * These cases were captured from the deleted Rust port. That is where they
 * came from, not what makes them right: the port is gone, this side is the
 * implementation, and a case that turns out to disagree with what shore
 * should do gets corrected here rather than shimmed around. The corpus is
 * worth keeping for its inputs, which are hard to re-derive by hand.
 */

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
import { dispatchCommand, type CommandPathDeps } from "../src/handler/commands.ts";
import type { RequestMeta } from "../src/swp/session.ts";
import { testTmp } from "./support/tmp.ts";

/**
 * The three names the Rust answered with a null rid, whatever the request
 * carried — its characterless path forgot `.with_rid(...)`.
 */
const RID_DROPPED = new Set(["list_characters", "list_models", "list_providers"]);

/** The one session every fixture case runs on — see {@link meta}. */
const SESSION_ID = 1;

/** What `defaults.model` resolves to when nothing is cached for the asker. */
const DEFAULT_MODEL = "chat.fixture";

/** The one model in the catalog, named as `defaults.model`. */
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

// ── harness ─────────────────────────────────────────────────────────────

interface Harness {
  deps: CommandPathDeps;
  activeModel(character: string | undefined): string | undefined;
  /** Needed to rebuild the `none_available` message — see {@link RUST_NONE_AVAILABLE}. */
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
  const activeModels = new Map<string, string>();
  const modelKey = (id: number, character: string | undefined) => `${id} ${character ?? ""}`;

  const deps: CommandPathDeps = {
    registry: {
      // The registry's own three-way resolution, reproduced here rather than
      // reached for: `characters.ts` owns it and is pinned by its own fixture,
      // and building a real registry would drag its config loading in too.
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
    sessions: {
      activeModel: (id, character) => activeModels.get(modelKey(id, character)),
      setActiveModel: (id, character, model) => {
        if (model === undefined) activeModels.delete(modelKey(id, character));
        else activeModels.set(modelKey(id, character), model);
      },
    },
    commands: {
      sessionTokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
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
      clearActiveModel: () => {
        activeModels.clear();
      },
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
    activeModel: (character) => activeModels.get(modelKey(SESSION_ID, character)),
    configDir: dirs.config,
  };
}

/**
 * `CharacterRegistry.resolveCharacter`'s three answers, which is what the
 * fixture's three failure cases are about.
 */
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
  return available[0]!;
}

/**
 * The `none_available` message the Rust returned, verbatim, and the absolute
 * path the port answers with instead (#41).
 *
 * The reasoning lives in `characters.test.ts`, which owns the message;
 * this file replays a handler that only relays it. Both keyed on the exact old
 * string for the same reason.
 */
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
  } as RequestMeta;
}

/** The envelope the generator recorded. */
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
      data_active: record["active"] ?? null,
    };
  }
  if (frame.type === "error") {
    return { kind: "error", rid: frame.rid, code: frame.code, message: frame.message };
  }
  return { kind: "unexpected" };
}

// ── the cases ───────────────────────────────────────────────────────────

describe("dispatchCommand", () => {
  for (const c of fixture.dispatch_command) {
    test(c.name, async () => {
      const input = c.input as Record<string, any>;
      const out = c.output as Record<string, any>;
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
      const activeModelBefore = h.activeModel(selected ?? undefined);

      const frame = await dispatchCommand(
        h.deps,
        { rid: null, name: input["command"] as string, args: input["args"] },
        meta(selected, (input["rid"] as string | null) ?? null),
      );

      const got = envelope(frame);
      const want = out["frame"] as Record<string, unknown>;

      expect(got["kind"]).toBe(want["kind"] as string);

      // The rid: the same as recorded, except on the three names the Rust's
      // characterless path dropped it for — there, this side must carry it.
      const requestRid = (input["rid"] as string | null) ?? null;
      if (RID_DROPPED.has(input["command"] as string) && want["rid"] === null) {
        expect(got["rid"]).toBe(requestRid);
      } else {
        expect(got["rid"]).toBe(want["rid"] as string | null);
      }

      const crossCharacter = prior !== selected;

      if (want["kind"] === "error") {
        expect(got["code"]).toBe(want["code"] as never);
        expect(got["message"]).toBe(expectedMessage(want["message"] as string, h.configDir));
      } else {
        expect(got["name"]).toBe(want["name"] as string);
        // Routing, not payload: the recorded keys must still be there, so a
        // handler answering with someone else's reply fails, but a field added
        // to a payload since does not. `status.test.ts` owns that envelope.
        expect(got["data_keys"]).toEqual(expect.arrayContaining(want["data_keys"] as string[]));
        // The character that set it is not the character asking, so the answer
        // is the configured default rather than the other character's pick.
        expect(got["data_active"]).toEqual(
          crossCharacter ? DEFAULT_MODEL : (want["data_active"] ?? null),
        );
      }

      if (crossCharacter) {
        expect(activeModelBefore).toBeUndefined();
        expect(h.activeModel(selected ?? undefined)).toBeUndefined();
        expect(h.activeModel(prior ?? undefined) ?? null).toEqual(
          out["active_model_after"] ?? null,
        );
        return;
      }

      expect(activeModelBefore ?? null).toEqual(out["active_model_before"] ?? null);
      expect(h.activeModel(selected ?? undefined) ?? null).toEqual(
        out["active_model_after"] ?? null,
      );
    });
  }
});

// ── two decisions the fixture cannot reach, and why ─────────────────────

/**
 * An engine that will not open is an internal error, not an invalid request.
 *
 * No recorded case has one: the Rust's `get_or_create` succeeded in every world
 * the generator could build, because it creates what it cannot find. The
 * distinction still matters — `invalid_request` tells a client to change
 * something and this is not something a client can change — so it is asserted
 * from this side.
 */
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
  expect(selected).toEqual([[1, "poppy"]]);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ type: "history", selected_character: "poppy" });
});

/**
 * The character path reads the character-*effective* config, not the global.
 *
 * Also not recorded, and the fixture's own note says why: making it observable
 * needs a per-character overlay, and a `LoadedConfig` built for a test carries
 * no raw table, so merging one over it re-derives an empty catalog and every
 * model command stops resolving. Here the registry is a stub, so the two
 * configs can simply be made to differ — which is the whole assertion.
 */
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
    // `status` reports the model the *effective* config resolves. Under the
    // global one it would be `chat.fixture`.
    expect((frame.data as Record<string, unknown>)["active_model"]).toBe("chat.spare");
  }
});

/**
 * The post-processing sees the config the command produced, not the one it
 * started from.
 *
 * Not recorded: the annotation a reload adds is the same either way — what
 * moves is the config that gets *adopted*, which never reaches the frame. So
 * the adoption is what is asserted, through `config_reset`, which is the one
 * command that *replaces* its context's config rather than editing it in place.
 */
test("config_reset adopts the config the command re-read, not the one it started from", async () => {
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

  await dispatchCommand(h.deps, { rid: null, name: "config_reset", args: {} }, meta("ada", null));

  expect(adopted).toHaveLength(1);
  expect(adopted[0]).not.toBe(before);
  expect(adopted[0]?.app.defaults.model).toBe("spare");
});
