import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import fixture from "./commands_fixtures/config_commands.json" with { type: "json" };

import {
  config,
  configCheck,
  configReload,
  reportedDefaults,
  settableKeySpellings,
  tools,
  type ConfigContext,
  type ConfigRuntime,
} from "../src/commands/config.ts";
import { CommandError } from "../src/commands/errors.ts";
import { loadConfig } from "../src/config/loader.ts";
import { pathsSetBy, replayOntoCurrentDefaults } from "./config_delta.ts";
import { testTmp } from "./support/tmp.ts";

const REMOVED = [
  "defaults.dreaming",
  "defaults.background.dreaming",
  "memory.dreaming",
  "tools.sandbox",
  "connections.matrix",
  "daemon.unsafe_allow_remote_access",
  "daemon.allowed_hosts",
  "usage.spike_warnings",
] as const;

function stripRemoved(blob: unknown): unknown {
  if (blob === null || typeof blob !== "object") return blob;
  const out = structuredClone(blob) as Record<string, unknown>;
  for (const path of REMOVED) {
    const parts = path.split(".");
    let node: Record<string, unknown> | undefined = out;
    for (const part of parts.slice(0, -1)) {
      const next: unknown = node?.[part];
      if (!isRecord(next)) {
        node = undefined;
        break;
      }
      node = next;
    }
    if (node !== undefined) delete node[parts[parts.length - 1] as string];
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripSection(section: string, blob: unknown): unknown {
  const wrapped = stripRemoved({ [section]: blob }) as Record<string, unknown>;
  return wrapped[section];
}

interface Row {
  name: string;
  note?: string;
  state_after: Record<string, unknown>;
  changed_after?: string[];
  ok?: unknown;
  err?: { code: string; message: string };
}

type Section =
  | "tools"
  | "config_check"
  | "config_read"
  | "config_set"
  | "config_reload";

const row = (section: Section, name: string): Row => {
  const found = (fixture[section] as unknown as Row[]).find((r) => r.name === name);
  if (found === undefined) throw new Error(`no fixture row named ${JSON.stringify(name)}`);
  return found;
};

interface World {
  root: string;
  ctx: ConfigContext;
  calls: string[];
}

function recorder(calls: string[]): ConfigRuntime {
  return {
    reloadRuntimeConfig: () => calls.push("reloadRuntimeConfig"),
    setUsageConfig: () => calls.push("setUsageConfig"),
    setCacheKeepaliveCeiling: () => calls.push("setCacheKeepaliveCeiling"),
    notifyPromptSnapshotRefreshed: (c) => calls.push(`notifyPromptSnapshotRefreshed:${c}`),
  };
}

async function build(
  character: string | undefined,
  configToml: string,
  extra: [path: string, text: string][] = [],
): Promise<World> {
  const root = await mkdtemp(testTmp("shore-config-cmd-"));
  for (const [path, text] of extra) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  }
  const configPath = join(root, "config", "config.toml");
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, configToml);

  const env = {
    XDG_CONFIG_HOME: root,
    XDG_DATA_HOME: join(root, "data-home"),
    XDG_CACHE_HOME: join(root, "cache-home"),
    XDG_RUNTIME_DIR: join(root, "run-home"),
  };
  const onWarn = () => {};
  const loaded = loadConfig(configPath, { env, onWarn });
  await mkdir(loaded.dirs.data, { recursive: true });

  const calls: string[] = [];
  return {
    root,
    calls,
    ctx: {
      config: loaded,
      configPath,
      characterName: character,
      activeModel: undefined,
      runtime: recorder(calls),
      env,
    },
  };
}

const scrub = (value: unknown, root: string): unknown =>
  JSON.parse(JSON.stringify(value ?? null).split(root).join("<root>"));

const stateOf = (w: World): unknown =>
  scrub(
    {
      active_model: w.ctx.activeModel ?? null,
      defaults_stream: w.ctx.config.app.defaults.stream,
      autonomy_enabled: w.ctx.config.app.behavior.autonomy.enabled,
      defaults_model: w.ctx.config.app.defaults.model ?? null,
      chat_models: w.ctx.config.models.chat.size,
    },
    w.root,
  );

const PARSE_BOUNDARIES = [
  /^([\s\S]*failed to parse config\.toml: )[\s\S]*$/,
  /^([\s\S]*failed to parse include file [^:]*: )[\s\S]*$/,
];

function upToParser(message: string): string {
  for (const re of PARSE_BOUNDARIES) {
    const m = re.exec(message);
    if (m !== null) return m[1] as string;
  }
  return message;
}

async function check(
  r: Row,
  w: World,
  run: () => unknown,
  normalize: (ok: unknown) => unknown = (v) => v,
  normalizeResult: (actual: unknown) => unknown = normalize,
): Promise<void> {
  let result: unknown;
  let thrown: unknown;
  try {
    result = await run();
  } catch (e) {
    thrown = e;
  }

  if (r.err !== undefined) {
    expect(thrown, r.name).toBeInstanceOf(CommandError);
    expect((thrown as CommandError).code, r.name).toBe(r.err.code as never);
    const actual = (thrown as CommandError).message.split(w.root).join("<root>");
    expect(upToParser(actual), r.name).toBe(upToParser(r.err.message));
  } else {
    expect(thrown, r.name).toBeUndefined();
    expect(normalizeResult(scrub(result, w.root)), r.name).toEqual(normalize(r.ok) as never);
  }
  expect(stateOf(w), `${r.name} (state_after)`).toEqual(r.state_after as never);
}

const FURNISHED = `
[chat.anthropic.primary]
model_id = "claude-primary"
api_key_env = "SHORE_FIXTURE_KEY_SET"

[chat.anthropic.secondary]
model_id = "claude-secondary"
api_key_env = "SHORE_FIXTURE_KEY_MISSING"

[defaults]
model = "primary"
stream = false

[behavior.autonomy]
enabled = true

[tools]
enabled_tools = ["web_search", "not_a_real_tool"]
enabled_subagents = ["researcher", "ghost"]

[subagents.researcher]
description = "Looks things up"
prompt = "You look things up."
tools = ["web_search", "also_not_real"]
model = "primary"

[subagents.idle]
description = "Never enabled"
prompt = "You are idle."
tools = ["fetch_url", "idle_not_real"]
`;

const BARE = "";

const ENV = { SHORE_FIXTURE_KEY_SET: "sk-present", SHORE_FIXTURE_KEY_BLANK: "" } as NodeJS.ProcessEnv;

async function seedPromptFiles(
  w: World,
  soul: string,
  soulSnapshot: string | undefined,
  user: string,
): Promise<void> {
  const workspace = join(w.ctx.config.dirs.config, "characters", "mid", "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "SOUL.md"), soul);
  await writeFile(join(workspace, "USER.md"), user);

  const snapshot = join(w.ctx.config.dirs.data, "mid", "active_prompt");
  await mkdir(snapshot, { recursive: true });
  if (soulSnapshot !== undefined) await writeFile(join(snapshot, "SOUL.md"), soulSnapshot);
  await writeFile(join(snapshot, "USER.md"), user);
}

describe("tools", () => {
  const cases: [name: string, toml: string][] = [
    ["the furnished surface, with every warning kind", FURNISHED],
    ["an empty config still lists every registered tool", BARE],
  ];
  for (const [name, toml] of cases) {
    test(name, async () => {
      const w = await build("mid", toml);
      await check(row("tools", name), w, () => tools(w.ctx));
    });
  }

  const withSubagent = (extra: string, subagentTools: string): string =>
    '\n[chat.anthropic.primary]\nmodel_id = "claude-primary"\n\n' +
    '[defaults]\nmodel = "primary"\n' +
    extra +
    '\n[tools]\nenabled_subagents = ["probe"]\n\n' +
    '[subagents.probe]\ndescription = "d"\nprompt = "p"\nmodel = "primary"\n' +
    `tools = [${subagentTools}]\n`;

  test("a configured mcp server's tools are not reported as unknown", async () => {
    const w = await build(
      "mid",
      withSubagent('\n[mcp.whoop]\nurl = "http://mcp-whoop:3000/mcp"\n', '"mcp__whoop__*"'),
    );
    const out = tools(w.ctx) as { warnings: string[] };
    expect(out.warnings.filter((x) => x.includes("mcp__whoop__"))).toEqual([]);
  });

  test("an mcp server name with an underscore still resolves", async () => {
    const w = await build(
      "mid",
      withSubagent(
        '\n[mcp.listening_stats]\nurl = "http://mcp-listening-stats:3000/mcp"\n',
        '"mcp__listening_stats__*"',
      ),
    );
    const out = tools(w.ctx) as { warnings: string[] };
    expect(out.warnings.filter((x) => x.includes("mcp__listening_stats__"))).toEqual([]);
  });

  test("a provider-only config is not reported as having no models", async () => {
    const w = await build(
      "mid",
      '\n[providers.anthropic]\nsdk = "anthropic"\napi_key_env = "SHORE_FIXTURE_KEY_SET"\n',
    );
    const out = configCheck(w.ctx, ENV) as { warnings: string[]; providers: number };
    expect(out.providers).toBe(1);
    expect(out.warnings.filter((x) => x.includes("No chat models configured"))).toEqual([]);
  });

  test("an mcp tool for a server that is not configured is still unknown", async () => {
    const w = await build("mid", withSubagent("", '"mcp__nosuchserver__*"'));
    const out = tools(w.ctx) as { warnings: string[] };
    expect(out.warnings.some((x) => x.includes("mcp__nosuchserver__"))).toBe(true);
  });
});

describe("configCheck", () => {
  const cases: [name: string, toml: string][] = [
    ["a config with a missing api key env var", FURNISHED],
    ["no models at all", BARE],
    [
      "a default model that is not in the catalog",
      '\n[chat.anthropic.primary]\nmodel_id = "claude-primary"\n\n[defaults]\nmodel = "nonexistent"\n',
    ],
    ["models but no default set", '\n[chat.anthropic.primary]\nmodel_id = "claude-primary"\n'],
    [
      "an api key env var that is set but empty",
      '\n[chat.anthropic.blank]\nmodel_id = "claude-blank"\napi_key_env = "SHORE_FIXTURE_KEY_BLANK"\n',
    ],
  ];
  for (const [name, toml] of cases) {
    test(name, async () => {
      const w = await build("mid", toml);
      await check(row("config_check", name), w, () => configCheck(w.ctx, ENV));
    });
  }

  test("a provider:model_id default is a working setup, not two warnings", async () => {
    const w = await build(
      "mid",
      '\n[providers.deepseek]\napi_key_env = "SHORE_FIXTURE_KEY_SET"\n\n' +
        '[defaults]\nmodel = "deepseek:deepseek-v4-flash"\n',
    );
    const result = configCheck(w.ctx, ENV) as { warnings: string[]; info: string[] };

    expect(result.warnings).toEqual([]);
    expect(result.info).toContain("Default model: deepseek:deepseek-v4-flash");
  });

  test("a default naming an unconfigured provider is still called out", async () => {
    const w = await build("mid", '\n[defaults]\nmodel = "ghost:whatever"\n');
    const result = configCheck(w.ctx, ENV) as { warnings: string[] };

    expect(result.warnings).toContain('Default model "ghost:whatever" not found in catalog');
  });
});

describe("config read", () => {
  const liveDefaults = () => stripRemoved(reportedDefaults());
  const liveSectionDefaults = (section: string) =>
    stripSection(section, reportedDefaults()[section]);

  const actualWhole = (ok: unknown) => {
    const whole = ok as { config: unknown; defaults: unknown };
    return {
      config: stripRemoved(whole.config),
      defaults: stripRemoved(whole.defaults),
    };
  };
  const explicit = pathsSetBy(Bun.TOML.parse(FURNISHED));

  const recordedWhole = (ok: unknown) => {
    const whole = ok as { config: unknown; defaults: unknown };
    return {
      config: replayOntoCurrentDefaults(
        stripRemoved(whole.config),
        stripRemoved(whole.defaults),
        liveDefaults(),
        explicit,
      ),
      defaults: liveDefaults(),
    };
  };

  test("the whole config and the whole default baseline", async () => {
    const w = await build("mid", FURNISHED);
    await check(
      row("config_read", "the whole config and the whole default baseline"),
      w,
      () => config(w.ctx, {}),
      recordedWhole,
      actualWhole,
    );
  });

  const sectionCases: [name: string, args: Record<string, unknown>, section: string][] = [
    ["one section by key", { key: "tools" }, "tools"],
    ["a map-valued section", { key: "subagents" }, "subagents"],
  ];
  for (const [name, args, section] of sectionCases) {
    test(name, async () => {
      const w = await build("mid", FURNISHED);
      await check(
        row("config_read", name),
        w,
        () => config(w.ctx, args),
        (ok) => {
          const whole = ok as Record<string, unknown> & { config: unknown; defaults: unknown };
          return {
            ...whole,
            config: replayOntoCurrentDefaults(
              stripSection(section, whole.config),
              stripSection(section, whole.defaults),
              liveSectionDefaults(section),
              new Set([...explicit].flatMap((p) => (p.startsWith(`${section}.`) ? [p.slice(section.length + 1)] : []))),
            ),
            defaults: liveSectionDefaults(section),
          };
        },
        (ok) => {
          const whole = ok as Record<string, unknown> & { config: unknown; defaults: unknown };
          return {
            ...whole,
            config: stripSection(section, whole.config),
            defaults: stripSection(section, whole.defaults),
          };
        },
      );
    });
  }

  const wholeCases: [name: string, args: Record<string, unknown>][] = [
    ["a non-string key is no key at all", { key: 7 }],
    ["a value without a key is still a read", { value: "true" }],
  ];
  for (const [name, args] of wholeCases) {
    test(name, async () => {
      const w = await build("mid", FURNISHED);
      await check(
        row("config_read", name),
        w,
        () => config(w.ctx, args),
        recordedWhole,
        actualWhole,
      );
    });
  }

  test("an unknown section", async () => {
    const w = await build("mid", FURNISHED);
    await check(row("config_read", "an unknown section"), w, () =>
      config(w.ctx, { key: "nosuchsection" }),
    );
  });
});

describe("config read walks dots", () => {
  const cases: [key: string, value: unknown][] = [
    ["defaults.model", "primary"],
    ["defaults.stream", false],
    ["behavior.autonomy.enabled", true],
    ["daemon.addr", "127.0.0.1:7320"],
    ["tools.enabled_tools", ["web_search", "not_a_real_tool"]],
  ];
  for (const [key, value] of cases) {
    test(`\`${key}\` reads back`, async () => {
      const w = await build("mid", FURNISHED);
      const ok = config(w.ctx, { key }) as { key: string; config: unknown };
      expect(ok.key).toBe(key);
      expect(ok.config).toEqual(value as never);
    });
  }

  test("`advanced.editor` is gone; the CLI reads $VISUAL and $EDITOR itself", async () => {
    expect(build("mid", `${FURNISHED}\n[advanced]\neditor = "hx"\n`)).rejects.toThrow(
      "`editor` was removed",
    );
  });

  test("every settable key reads back, or says where it reads back from", async () => {
    const w = await build("mid", FURNISHED);
    for (const key of settableKeySpellings()) {
      let redirect: string | undefined;
      try {
        config(w.ctx, { key });
      } catch (e) {
        redirect = (e as Error).message;
      }
      if (redirect === undefined) continue;
      const named = /read it as (\S+)$/.exec(redirect)?.[1];
      expect(named, `${key} missed without naming a readable path`).toBeDefined();
      expect(() => config(w.ctx, { key: required(named) })).not.toThrow();
    }
  });

  test("the set arm accepts exactly the spellings the table lists", async () => {
    const w = await build("mid", FURNISHED);
    for (const key of settableKeySpellings()) {
      const value = key.endsWith("model") ? "primary" : "true";
      expect(() => config(w.ctx, { key, value })).not.toThrow();
    }
  });

  test("the default baseline is scoped to the same key", async () => {
    const w = await build("mid", FURNISHED);
    const ok = config(w.ctx, { key: "defaults.stream" }) as { config: unknown; defaults: unknown };
    expect(ok.config).toBe(false as never);
    expect(ok.defaults).toBe(true as never);
  });

  test("a key whose value is null is found, not missing", async () => {
    const w = await build("mid", FURNISHED);
    const ok = config(w.ctx, { key: "defaults.display_name" }) as { config: unknown };
    expect(ok.config).toBeNull();
  });

  const misses: [why: string, key: string][] = [
    ["an unknown leaf", "defaults.nosuchkey"],
    ["an unknown branch", "nosuchsection.nosuchkey"],
    ["a walk through a scalar", "defaults.stream.deeper"],
    ["a walk into an array", "tools.enabled_tools.0"],
    ["a trailing dot", "defaults."],
  ];
  for (const [why, key] of misses) {
    test(`${why} is still not_found`, async () => {
      const w = await build("mid", FURNISHED);
      expect(() => config(w.ctx, { key })).toThrow(`Config section not found: ${key}`);
    });
  }
});

describe("config set", () => {
  const cases: [name: string, args: Record<string, unknown>][] = [
    ["defaults.model is written to the config file", { key: "defaults.model", value: "secondary" }],
    ["model is an alias for defaults.model", { key: "model", value: "secondary" }],
    ["a model that is not in the catalog", { key: "defaults.model", value: "ghost" }],
    ["defaults.stream parses the value as a bool", { key: "defaults.stream", value: "true" }],
    ["yes is accepted as a bool", { key: "stream", value: "yes" }],
    ["a value that is not a bool", { key: "stream", value: "maybe" }],
    ["autonomy.enabled echoes the canonical key", { key: "autonomy.enabled", value: "false" }],
    ["the long spelling of autonomy.enabled", { key: "behavior.autonomy.enabled", value: "false" }],
    ["a key that is not in the schema", { key: "memory.mode", value: "x" }],
    ["a table is not settable as a whole", { key: "memory.compaction", value: "x" }],
    [
      "an enum rejects a value outside its variants",
      { key: "behavior.user_message_timestamps", value: "sometimes" },
    ],
    ["a duration is normalised before it is written", { key: "cache.keepalive_max", value: "90m" }],
    ["a new key is added to an existing section", { key: "defaults.display_name", value: "Ellie" }],
    [
      "a list is set from a comma separated value",
      { key: "tools.enabled_subagents", value: "researcher" },
    ],
  ];
  for (const [name, args] of cases) {
    test(name, async () => {
      const w = await build("mid", FURNISHED);
      await check(row("config_set", name), w, () => config(w.ctx, args));
    });
  }

  test("a saved model preference still masks the new default", async () => {
    const w = await build("mid", FURNISHED);
    w.ctx.activeModel = "primary";
    await check(
      row("config_set", "a saved model preference still masks the new default"),
      w,
      () => config(w.ctx, { key: "defaults.model", value: "secondary" }),
    );
  });

  test("a list is not checked against its source as one string", async () => {
    const w = await build("mid", FURNISHED);

    const result = config(w.ctx, {
      key: "tools.enabled_subagents",
      value: "researcher,idle",
    }) as { value: unknown };

    expect(result.value).toEqual(["researcher", "idle"]);
    expect(await readFile(w.ctx.configPath, "utf8")).toContain(
      'enabled_subagents = ["researcher", "idle"]',
    );
  });

  test("the file keeps its comments and untouched lines", async () => {
    const w = await build("mid", FURNISHED);
    const before = await readFile(w.ctx.configPath, "utf8");
    config(w.ctx, { key: "defaults.stream", value: "true" });
    const after = await readFile(w.ctx.configPath, "utf8");
    expect(after).toBe(before.replace("stream = false", "stream = true"));
  });
});

describe("configReload", () => {
  test("check mode reports without applying", async () => {
    const w = await build("mid", FURNISHED);
    await check(row("config_reload", "check mode reports without applying"), w, () =>
      configReload(w.ctx, {}),
    );
    expect(w.calls).toEqual([]);
  });

  test("a truthy non-boolean apply is not an apply", async () => {
    const w = await build("mid", FURNISHED);
    await check(row("config_reload", "a truthy non-boolean apply is not an apply"), w, () =>
      configReload(w.ctx, { apply: 1, refresh_prompts: 1 }),
    );
    expect(w.calls).toEqual([]);
  });

  test("apply adopts the config on disk", async () => {
    const w = await build("mid", FURNISHED);
    await writeFile(
      w.ctx.configPath,
      '\n[chat.anthropic.primary]\nmodel_id = "claude-primary"\n\n' +
        '[chat.anthropic.third]\nmodel_id = "claude-third"\n\n' +
        '[defaults]\nmodel = "third"\nstream = true\n',
    );
    await check(row("config_reload", "apply adopts the config on disk"), w, () =>
      configReload(w.ctx, { apply: true }),
    );
    expect(w.calls).toEqual([
      "reloadRuntimeConfig",
      "setUsageConfig",
      "setCacheKeepaliveCeiling",
    ]);
  });

  test("a broken config aborts before adopting anything", async () => {
    const w = await build("mid", FURNISHED);
    await writeFile(w.ctx.configPath, "this is not toml [[[");
    await check(row("config_reload", "a broken config aborts before adopting anything"), w, () =>
      configReload(w.ctx, { apply: true }),
    );
    expect(w.calls).toEqual([]);
  });

  test("a broken character overlay aborts the reload", async () => {
    const w = await build("mid", FURNISHED, [
      ["config/characters/broken/workspace/SOUL.md", "x"],
      ["config/characters/broken/config.toml", "nope = [[["],
    ]);
    await check(row("config_reload", "a broken character overlay aborts the reload"), w, () =>
      configReload(w.ctx, { apply: true }),
    );
    expect(w.calls).toEqual([]);
  });

  test("reload with no character context", async () => {
    const w = await build(undefined, FURNISHED);
    await check(row("config_reload", "reload with no character context"), w, () =>
      configReload(w.ctx, {}),
    );
  });

  test("check mode lists the prompt files that differ", async () => {
    const w = await build("mid", FURNISHED);
    await seedPromptFiles(w, "canonical soul", "stale soul", "shared user");
    await check(row("config_reload", "check mode lists the prompt files that differ"), w, () =>
      configReload(w.ctx, {}),
    );
  });

  test("a prompt file with no snapshot at all is changed", async () => {
    const w = await build("mid", FURNISHED);
    await seedPromptFiles(w, "canonical soul", undefined, "shared user");
    await check(row("config_reload", "a prompt file with no snapshot at all is changed"), w, () =>
      configReload(w.ctx, {}),
    );
  });

  test("apply with refresh_prompts activates the pending edits", async () => {
    const w = await build("mid", FURNISHED);
    await seedPromptFiles(w, "canonical soul", "stale soul", "shared user");
    const r = row("config_reload", "apply with refresh_prompts activates the pending edits");
    await check(r, w, () => configReload(w.ctx, { apply: true, refresh_prompts: true }));

    const { changedPromptFiles } = await import("../src/memory/deferred_edits.ts");
    expect(
      await changedPromptFiles(
        join(w.ctx.config.dirs.data, "mid"),
        w.ctx.config.dirs.config,
        "mid",
      ),
    ).toEqual(r.changed_after as string[]);

    expect(w.calls).toEqual([
      "notifyPromptSnapshotRefreshed:mid",
      "reloadRuntimeConfig",
      "setUsageConfig",
      "setCacheKeepaliveCeiling",
    ]);
  });

  test("apply without refresh_prompts leaves the snapshot alone", async () => {
    const w = await build("mid", FURNISHED);
    await seedPromptFiles(w, "canonical soul", "stale soul", "shared user");
    const r = row("config_reload", "apply without refresh_prompts leaves the snapshot alone");
    await check(r, w, () => configReload(w.ctx, { apply: true, refresh_prompts: false }));

    const { changedPromptFiles } = await import("../src/memory/deferred_edits.ts");
    expect(
      await changedPromptFiles(
        join(w.ctx.config.dirs.data, "mid"),
        w.ctx.config.dirs.config,
        "mid",
      ),
    ).toEqual(r.changed_after as string[]);
    expect(w.calls).not.toContain("notifyPromptSnapshotRefreshed:mid");
  });
});
