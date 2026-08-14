/**
 * The dispatcher's after-effects: what four commands make the handler do once
 * the command itself has returned, and what the client is told to forget.
 *
 * Ported alongside the four `post_process_*` methods in
 * `the deleted port` and
 * `restart_required_changes` in `handler/mod.rs`.
 *
 * **Not fixture-derived.** The Rust has real tests for three of the four — they
 * are `switch_character_pushes_authoritative_history_to_session`,
 * `config_reset_refreshes_registry_runtime_state`,
 * `config_reload_check_is_side_effect_free_and_apply_propagates` and
 * `config_set_runtime_override_survives_next_command` in `handler/tests.rs` —
 * and each drives a whole live `MessageHandler` to assert two or three fields
 * of JSON. Those assertions are the spec and are reproduced below, one section
 * per Rust test, against fakes for the state the handler owns. Recording a
 * fixture would have meant building the handler and the registry, neither of
 * which is ported, to freeze values that are already written down.
 *
 * `restartRequiredChanges` gets its own section because the Rust has no test
 * for it beyond "this reload needed none": five sections and their negative
 * case, so that the list is pinned rather than inherited.
 */

import { describe, expect, test } from "bun:test";

import { defaultAppConfig } from "../src/config/app.ts";
import { ConfigDuration } from "../src/config/duration.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { restartRequiredChanges } from "../src/config/restart.ts";
import {
  afterCommand,
  type DispatchContext,
  type DispatchRuntime,
  type ReloadSummary,
} from "../src/handler/command_dispatch.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import type { HandshakeProvider, HistorySnapshot } from "../src/swp/connection.ts";
import { SessionRouter } from "../src/swp/session.ts";

// ── the world these run in ────────────────────────────────────────────────

function config(mutate: (c: LoadedConfig) => void = () => {}): LoadedConfig {
  const loaded: LoadedConfig = {
    app: defaultAppConfig(),
    models: emptyCatalog(),
    providers: ProviderRegistry.empty(),
    dirs: { config: "/cfg", data: "/data", cache: "/cache", runtime: "/run" },
    rawTable: undefined,
  };
  mutate(loaded);
  return loaded;
}

const SESSION = 7;
const CHARACTER = "ashe";

/** Every effect the post-processing can have, in the order it had them. */
interface Log {
  readonly order: string[];
  readonly effective: Array<{ character: string; config: LoadedConfig }>;
  readonly schedulers: LoadedConfig[];
  readonly adopted: LoadedConfig[];
  readonly sent: ServerMessage[];
}

interface Fakes {
  readonly log: Log;
  readonly ctx: DispatchContext;
  /** The config `globalConfig()` reports, which adoption moves. */
  current: LoadedConfig;
}

function fakes(
  opts: {
    /** The command context's config after the command ran. */
    config?: LoadedConfig;
    /** What re-reading the config file yields; `undefined` means it no longer
     *  parses. */
    onDisk?: LoadedConfig | undefined;
    summary?: ReloadSummary;
    snapshot?: Partial<HistorySnapshot>;
    /** What the snapshot throws instead of answering. */
    historyFails?: Error;
    rid?: string;
  } = {},
): Fakes {
  const log: Log = { order: [], effective: [], schedulers: [], adopted: [], sent: [] };
  const summary = opts.summary ?? { characterDiscoveryChanged: false, droppedEngines: 0 };

  const state: Fakes = {
    log,
    current: config(),
    ctx: undefined as unknown as DispatchContext,
  };

  const runtime: DispatchRuntime = {
    globalConfig: () => state.current,
    reloadGlobalConfig: () => {
      log.order.push("reload-file");
      return "onDisk" in opts ? opts.onDisk : config();
    },
    setEffectiveConfig: async (character, cfg) => {
      log.order.push("effective");
      log.effective.push({ character, config: cfg });
    },
    reloadRuntimeConfig: (cfg) => {
      log.order.push("schedulers");
      log.schedulers.push(cfg);
    },
    applyReloadedConfig: async (cfg) => {
      log.order.push("adopt");
      log.adopted.push(cfg);
      // Adoption is what makes the daemon's config the fresh one — which is
      // why `restart_required` has to be computed before it.
      state.current = cfg;
      return summary;
    },
  };

  const router = new SessionRouter();

  const handshake: HandshakeProvider = {
    // Tagged with what the session points at *right now*, so the log says
    // whether the move happened before the snapshot was taken.
    history: (selectedCharacter) => {
      log.order.push(`history@${router.characterFor(SESSION)}`);
      if (opts.historyFails !== undefined) return Promise.reject(opts.historyFails);
      return Promise.resolve({
        messages: [],
        activeStart: 0,
        config: { active_model: "anthropic:opus" },
        selectedCharacter,
        revision: 3,
        ...opts.snapshot,
      });
    },
    hello: () => Promise.resolve({ characters: [] }),
  };

  router.registerSession(
    { id: SESSION, clientType: "tui", clientName: "test", capabilities: [], character: CHARACTER },
    async (msg) => {
      log.order.push("send");
      log.sent.push(msg);
    },
  );

  (state as { ctx: DispatchContext }).ctx = {
    character: CHARACTER,
    config: opts.config ?? config(),
    sessionId: SESSION,
    rid: opts.rid,
    runtime,
    router,
    handshake,
  };
  return state;
}

// ── restart_required ──────────────────────────────────────────────────────

describe("restartRequiredChanges", () => {
  const changes = (mutate: (c: LoadedConfig) => void) =>
    restartRequiredChanges(config(), config(mutate));

  test("a config that only moved live-reloadable settings needs no restart", () => {
    expect(changes((c) => (c.app.defaults.stream = !c.app.defaults.stream))).toEqual([]);
    expect(restartRequiredChanges(config(), config())).toEqual([]);
  });

  test("the listener's address", () => {
    expect(changes((c) => (c.app.daemon.addr = "127.0.0.1:9999"))).toEqual(["[daemon]"]);
  });

  test("a notification setting nested two levels down", () => {
    expect(changes((c) => (c.app.notifications.events.error = true))).toEqual(["[notifications]"]);
  });

  test("a notification setting that is a duration", () => {
    // The one field in these sections that is an object rather than a scalar,
    // so it is the one that says the comparison is structural.
    expect(
      changes((c) => (c.app.notifications.generation_threshold = ConfigDuration.fromSecs(30))),
    ).toEqual(["[notifications]"]);
  });

  test("a duration that was rewritten to the same length is not a change", () => {
    expect(
      changes((c) => (c.app.notifications.generation_threshold = ConfigDuration.fromSecs(0))),
    ).toEqual([]);
  });

  test("the advanced switch that has a reader, named individually", () => {
    expect(changes((c) => (c.app.cache.forensics = true))).toEqual([
      "[cache].forensics",
    ]);
  });

  test("all three at once, in the order a client prints them", () => {
    expect(
      changes((c) => {
        c.app.daemon.addr = "0.0.0.0:1";
        c.app.notifications.enabled = true;
        c.app.cache.forensics = true;
      }),
    ).toEqual(["[daemon]", "[notifications]", "[cache].forensics"]);
  });
});

// ── config, with a value ──────────────────────────────────────────────────

describe("a runtime config set", () => {
  const SET = { set: "defaults.stream", value: false };

  test("publishes the merged config and invalidates the client's copy", async () => {
    const f = fakes({ config: config((c) => (c.app.defaults.stream = false)) });

    const out = await afterCommand("config", { key: "defaults.stream", value: "false" }, SET, f.ctx);

    expect(out).toEqual({ ...SET, invalidated: { merged_character_configs: true } });
    expect(f.log.effective).toEqual([{ character: CHARACTER, config: f.ctx.config }]);
    expect(f.log.schedulers).toEqual([f.ctx.config]);
    // The registry first, so a scheduler tick that lands between the two reads
    // the new config rather than the old one.
    expect(f.log.order).toEqual(["effective", "schedulers"]);
  });

  test("does not touch discovery or the engine list", async () => {
    const f = fakes();
    const out = await afterCommand("config", { key: "x", value: "1" }, SET, f.ctx);

    expect(f.log.adopted).toEqual([]);
    expect(Object.keys((out as { invalidated: object }).invalidated)).toEqual([
      "merged_character_configs",
    ]);
  });

  test("a read publishes nothing", async () => {
    // `config` with no string value is `shore config defaults`. Republishing
    // there would adopt the character-merged config as the global one.
    for (const args of [{ key: "defaults" }, { key: "defaults", value: null }, {}, "nonsense"]) {
      const f = fakes();
      const data = { config: { stream: false } };

      expect(await afterCommand("config", args, data, f.ctx)).toBe(data);
      expect(f.log.order).toEqual([]);
    }
  });
});

// ── config_reload ─────────────────────────────────────────────────────────

describe("a config_reload", () => {
  const check = { applied: false, config_path: "/cfg/config.toml", changed_prompt_files: [] };
  const apply = { ...check, applied: true, prompts_refreshed: false };

  test("the check phase re-reads the file and adopts nothing", async () => {
    const f = fakes({ onDisk: config((c) => (c.app.daemon.addr = "0.0.0.0:1")) });

    const out = await afterCommand("config_reload", {}, check, f.ctx);

    expect(out).toEqual({ ...check, restart_required: ["[daemon]"] });
    expect(f.log.order).toEqual(["reload-file"]);
    expect(f.log.adopted).toEqual([]);
  });

  test("the check phase compares the file, not the command's merged config", async () => {
    // The context's config is what a character overlay produced. Comparing
    // against it would report a restart for every character that sets one.
    const f = fakes({
      config: config((c) => (c.app.daemon.addr = "0.0.0.0:1")),
      onDisk: config(),
    });

    expect(await afterCommand("config_reload", {}, check, f.ctx)).toEqual({
      ...check,
      restart_required: [],
    });
  });

  test("a file that stopped parsing between validation and here drops the annotation", async () => {
    const f = fakes({ onDisk: undefined });
    const out = await afterCommand("config_reload", {}, check, f.ctx);

    // The command already succeeded, so this cannot become a failure.
    expect(out).toBe(check);
    expect(f.log.adopted).toEqual([]);
  });

  test("the apply phase adopts the command's config and invalidates all three", async () => {
    const f = fakes({
      config: config((c) => (c.app.defaults.stream = false)),
      summary: { characterDiscoveryChanged: true, droppedEngines: 1 },
    });

    const out = await afterCommand("config_reload", { apply: true }, apply, f.ctx);

    expect(out).toEqual({
      ...apply,
      restart_required: [],
      invalidated: {
        character_discovery: true,
        merged_character_configs: true,
        removed_character_engines: 1,
      },
    });
    expect(f.log.adopted).toEqual([f.ctx.config]);
    // No file read: on apply the context already holds the fresh config.
    expect(f.log.order).toEqual(["adopt"]);
  });

  test("restart_required is computed before the adoption, not after", async () => {
    // Afterwards the daemon's config *is* the fresh one, so every comparison
    // comes back empty and the client is never told what it will not see move.
    const f = fakes({ config: config((c) => (c.app.cache.forensics = true)) });

    const out = await afterCommand("config_reload", { apply: true }, apply, f.ctx);

    expect((out as { restart_required: string[] }).restart_required).toEqual([
      "[cache].forensics",
    ]);
  });

  test("`applied` decides, and only the literal true counts", async () => {
    for (const data of [{ applied: "true" }, { applied: 1 }, {}]) {
      const f = fakes();
      await afterCommand("config_reload", { apply: true }, data, f.ctx);
      expect(f.log.order).toEqual(["reload-file"]);
    }
  });
});

// ── switch_character ──────────────────────────────────────────────────────

describe("a switch_character", () => {
  test("moves the session and pushes it the new character's history", async () => {
    const f = fakes({ rid: "r-1" });

    const out = await afterCommand("switch_character", { name: "bob" }, { character: "bob" }, f.ctx);

    expect(out).toEqual({
      character: "bob",
      selected_character: "bob",
      active_model: "anthropic:opus",
    });
    expect(f.ctx.router.characterFor(SESSION)).toBe("bob");
    expect(f.log.sent).toEqual([
      {
        type: "history",
        rid: "r-1",
        messages: [],
        config: { active_model: "anthropic:opus" },
        selected_character: "bob",
        revision: 3,
      },
    ]);
    // The session is moved before the snapshot is taken — otherwise a frame
    // routed by selected character in between would go to the old one.
    expect(f.log.order).toEqual(["history@bob", "send"]);
  });

  test("a snapshot that will not load leaves the session where it was", async () => {
    const f = fakes({ historyFails: new Error("transcript.jsonl: unexpected end of JSON input") });

    const attempt = afterCommand(
      "switch_character",
      { name: "bob" },
      { character: "bob" },
      f.ctx,
    );

    await expect(attempt).rejects.toThrow(/unexpected end of JSON input/);
    // Moved for the snapshot and moved back when it failed. Left on bob, the
    // daemon would route bob's frames to a client still showing ashe — the
    // cross-character leak this ordering exists to prevent, in reverse.
    expect(f.ctx.router.characterFor(SESSION)).toBe(CHARACTER);
    expect(f.log.sent).toEqual([]);
  });

  test("the pushed history carries no rid when the command had none", async () => {
    const f = fakes();
    await afterCommand("switch_character", {}, { character: "bob" }, f.ctx);

    expect(Object.hasOwn(f.log.sent[0]!, "rid")).toBe(false);
  });

  test("active_model is null when the snapshot names none", async () => {
    const f = fakes({ snapshot: { config: {} } });

    const out = await afterCommand("switch_character", {}, { character: "bob" }, f.ctx);

    expect(out).toEqual({ character: "bob", selected_character: "bob", active_model: null });
  });

  test("a refused switch moves nothing", async () => {
    // The command names the character it accepted; without one there is
    // nothing to move the session to.
    for (const data of [{}, { character: null }, { error: "no such character" }]) {
      const f = fakes();

      expect(await afterCommand("switch_character", {}, data, f.ctx)).toBe(data);
      expect(f.log.order).toEqual([]);
      expect(f.ctx.router.characterFor(SESSION)).toBe(CHARACTER);
    }
  });
});

// ── everything else ───────────────────────────────────────────────────────

describe("every other command", () => {
  test("passes through untouched", async () => {
    for (const name of ["status", "list_models", "memory", "usage", "config_get"]) {
      const f = fakes();
      const data = { anything: true };

      expect(await afterCommand(name, { value: "set" }, data, f.ctx)).toBe(data);
      expect(f.log.order).toEqual([]);
    }
  });

  test("an answer that is not an object keeps its shape, and its effects run", async () => {
    const f = fakes();

    expect(await afterCommand("config", { value: "false" }, ["a", "b"], f.ctx)).toEqual(["a", "b"]);
    // The config still has to reach the registry: what the reply looked like
    // says nothing about what the command did.
    expect(f.log.order).toEqual(["effective", "schedulers"]);
  });
});
