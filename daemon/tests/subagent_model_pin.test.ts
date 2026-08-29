import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ConfigRuntime } from "../src/commands/config.ts";
import { CommandError } from "../src/commands/errors.ts";
import {
  modelInfo,
  modelRoles,
  modelSettings,
  resetModel,
  setModelSetting,
  switchModel,
  type ModelsContext,
} from "../src/commands/models.ts";
import { loadConfig } from "../src/config/loader.ts";
import { testTmp } from "./support/tmp.ts";

const CATALOG = `
[chat.anthropic.opus]
model_id = "opus-id"
sdk = "anthropic"

[chat.anthropic.haiku]
model_id = "haiku-id"
sdk = "anthropic"

[chat.openrouter.kimi]
model_id = "kimi-id"
sdk = "openrouter"

[subagents.music]
description = "plays things"
prompt = "you are a dj"

[subagents.librarian]
description = "finds things"
prompt = "you are a librarian"
`;

const silentRuntime = (): ConfigRuntime => ({
  reloadRuntimeConfig: () => {},
  adoptGlobalConfig: () => {},
  notifyPromptSnapshotRefreshed: () => {},
});

interface World {
  ctx: ModelsContext;
  configPath: string;
}

async function build(defaults: string): Promise<World> {
  const root = await mkdtemp(testTmp("shore-sub-pin-"));
  const configPath = join(root, "config", "config.toml");
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${defaults}\n${CATALOG}`);

  const env = {
    XDG_CONFIG_HOME: root,
    XDG_DATA_HOME: join(root, "data-home"),
    XDG_CACHE_HOME: join(root, "cache-home"),
    XDG_RUNTIME_DIR: join(root, "run-home"),
  };
  const loaded = loadConfig(configPath, { env, onWarn: () => {} });
  await mkdir(loaded.dirs.data, { recursive: true });

  return {
    configPath,
    ctx: {
      config: loaded,
      configPath,
      dataDir: loaded.dirs.data,
      characterName: "Tester",
      activeModel: undefined,
      runtime: silentRuntime(),
      env,
    },
  };
}

const roleOf = (ctx: ModelsContext, role: string) =>
  modelRoles(ctx).find((r) => r.role === role);

const readToml = (path: string) => readFile(path, "utf8");

const record = (value: unknown) => value as Record<string, unknown>;

interface OverviewRole {
  role: string;
  flag: string;
  model: string | null;
  source: string | null;
  settings: { key: string; value: unknown; scope: string }[];
  same_settings_as: string | null;
  error: string | null;
}

const overview = (ctx: ModelsContext) =>
  modelSettings(ctx, { overview: true }) as {
    roles: OverviewRole[];
    inherited_count: number;
    character: string | null;
  };

const roleNamed = (ctx: ModelsContext, role: string): OverviewRole | undefined =>
  overview(ctx).roles.find((r) => r.role === role);

describe("pinning a sub-agent's model", () => {
  test("a named sub-agent gets its own key and nothing else moves", async () => {
    const { ctx, configPath } = await build(`[defaults]\nmodel = "opus"\n`);

    const result = record(switchModel(ctx, { name: "kimi", subagent: "music" }));

    expect(result["role"]).toBe("sub-agent: music");
    expect(result["config_key"]).toBe("subagents.music.model");
    expect(result["qualified_name"]).toBe("chat.openrouter.kimi");
    expect(await readToml(configPath)).toContain('model = "chat.openrouter.kimi"');

    expect(ctx.config.app.subagents.get("music")?.model).toBe("chat.openrouter.kimi");
    expect(ctx.config.app.subagents.get("librarian")?.model).toBeUndefined();
    expect(roleOf(ctx, "chat")?.model).toBe("chat.anthropic.opus");
  });

  test("bare `all` writes the shared default and drops per-sub-agent pins", async () => {
    const { ctx, configPath } = await build(`[defaults]\nmodel = "opus"\n`);
    switchModel(ctx, { name: "haiku", subagent: "music" });

    const result = record(switchModel(ctx, { name: "kimi", subagent: "all" }));

    expect(result["role"]).toBe("sub-agents");
    expect(result["config_key"]).toBe("defaults.subagent_model");
    expect(result["cleared"]).toEqual(["subagents.music.model"]);

    const written = await readToml(configPath);
    expect(written).toContain('subagent_model = "chat.openrouter.kimi"');
    expect(ctx.config.app.subagents.get("music")?.model).toBeUndefined();
    expect(roleOf(ctx, "sub-agents")?.model).toBe("chat.openrouter.kimi");
  });

  test("pinning one sub-agent leaves another one's pin alone", async () => {
    const { ctx } = await build(`[defaults]\nmodel = "opus"\n`);
    switchModel(ctx, { name: "kimi", subagent: "music" });

    const result = record(switchModel(ctx, { name: "haiku", subagent: "librarian" }));

    expect(result["cleared"]).toEqual([]);
    expect(ctx.config.app.subagents.get("music")?.model).toBe("chat.openrouter.kimi");
    expect(ctx.config.app.subagents.get("librarian")?.model).toBe("chat.anthropic.haiku");
  });

  test("an unknown sub-agent is an error and writes nothing", async () => {
    const { ctx, configPath } = await build(`[defaults]\nmodel = "opus"\n`);
    const before = await readToml(configPath);

    let thrown: unknown;
    try {
      switchModel(ctx, { name: "kimi", subagent: "ghost" });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(CommandError);
    expect((thrown as CommandError).message).toContain("unknown sub-agent: ghost");
    expect((thrown as CommandError).message).toContain("librarian, music");
    expect(await readToml(configPath)).toBe(before);
  });

  test("an unknown model is an error and writes nothing", async () => {
    const { ctx, configPath } = await build(`[defaults]\nmodel = "opus"\n`);
    const before = await readToml(configPath);

    expect(() => switchModel(ctx, { name: "ghost", subagent: "music" })).toThrow(CommandError);
    expect(await readToml(configPath)).toBe(before);
  });
});

describe("unpinning a sub-agent's model", () => {
  test("a named sub-agent falls back to the shared default", async () => {
    const { ctx } = await build(
      `[defaults]\nmodel = "opus"\nsubagent_model = "haiku"\n`,
    );
    switchModel(ctx, { name: "kimi", subagent: "music" });

    const result = record(resetModel(ctx, { subagent: "music" }));

    expect(result["cleared"]).toEqual(["subagents.music.model"]);
    expect(ctx.config.app.subagents.get("music")?.model).toBeUndefined();
    expect(roleOf(ctx, "sub-agents")?.model).toBe("chat.anthropic.haiku");
  });

  test("bare `all` clears the shared default and every override", async () => {
    const { ctx, configPath } = await build(
      `[defaults]\nmodel = "opus"\nsubagent_model = "haiku"\n`,
    );
    switchModel(ctx, { name: "kimi", subagent: "music" });

    const result = record(resetModel(ctx, { subagent: "all" }));

    expect(result["cleared"]).toEqual(["defaults.subagent_model", "subagents.music.model"]);
    expect(await readToml(configPath)).not.toContain("subagent_model");
    expect(roleOf(ctx, "sub-agents")?.source).toBe("inherits chat");
  });

  test("clearing what was never pinned is not an error", async () => {
    const { ctx } = await build(`[defaults]\nmodel = "opus"\n`);
    const result = record(resetModel(ctx, { subagent: "librarian" }));

    expect(result["cleared"]).toEqual([]);
  });

  test("an unknown sub-agent is still an error", async () => {
    const { ctx } = await build(`[defaults]\nmodel = "opus"\n`);
    expect(() => resetModel(ctx, { subagent: "ghost" })).toThrow(/unknown sub-agent/);
  });
});

describe("describing a role instead of a model", () => {
  test("info follows the role to whatever it resolves to", async () => {
    const { ctx } = await build(`[defaults]\nmodel = "opus"\n`);
    switchModel(ctx, { name: "kimi", background_task: "compaction" });

    const described = record(modelInfo(ctx, { name: "", background_task: "compaction" }));
    expect(described["qualified_name"]).toBe("chat.openrouter.kimi");
  });

  test("naming both a model and a role is refused", async () => {
    const { ctx } = await build(`[defaults]\nmodel = "opus"\n`);
    expect(() => modelInfo(ctx, { name: "haiku", background_task: "compaction" })).toThrow(
      /not both/,
    );
  });
});

describe("the settings overview", () => {
  test("a fresh config shows chat alone and counts the rest as inherited", async () => {
    const { ctx } = await build(`[defaults]\nmodel = "opus"\n`);
    const shown = overview(ctx);

    expect(shown.roles.map((r) => r.role)).toEqual(["chat"]);
    expect(shown.inherited_count).toBe(5);
    expect(shown.character).toBe("Tester");
  });

  test("a pinned role appears with the flag that targets it", async () => {
    const { ctx } = await build(`[defaults]\nmodel = "opus"\n`);
    switchModel(ctx, { name: "kimi", background_task: "compaction" });

    const compaction = roleNamed(ctx, "compaction");
    expect(compaction?.model).toBe("chat.openrouter.kimi");
    expect(compaction?.flag).toBe("--background=compaction");
    expect(compaction?.source).toBe("defaults.background.compaction");
    expect(roleNamed(ctx, "heartbeat")).toBeUndefined();
  });

  test("a role that only inherits still shows up once it is tuned", async () => {
    const { ctx } = await build(`[defaults]\nmodel = "opus"\n`);
    setModelSetting(ctx, {
      key: "temperature",
      value: 0.25,
      scope: "character",
      subagent: "music",
    });

    const music = roleNamed(ctx, "sub-agent: music");
    expect(music?.flag).toBe("--subagent=music");
    expect(music?.settings).toEqual([{ key: "temperature", value: 0.25, scope: "character" }]);
  });

  test("character settings win over global ones and say so", async () => {
    const { ctx } = await build(`[defaults]\nmodel = "opus"\n`);
    setModelSetting(ctx, { key: "temperature", value: 0.1, scope: "global" });
    setModelSetting(ctx, { key: "top_p", value: 0.9, scope: "global" });
    setModelSetting(ctx, { key: "temperature", value: 0.8, scope: "character" });

    expect(roleNamed(ctx, "chat")?.settings).toEqual([
      { key: "temperature", value: 0.8, scope: "character" },
      { key: "top_p", value: 0.9, scope: "global" },
    ]);
  });

  test("two roles on one model are told they share the same settings", async () => {
    const { ctx } = await build(`[defaults]\nmodel = "opus"\n`);
    switchModel(ctx, { name: "opus", background_task: "compaction" });
    setModelSetting(ctx, { key: "temperature", value: 0.4, scope: "character" });

    expect(roleNamed(ctx, "chat")?.same_settings_as).toBeNull();
    expect(roleNamed(ctx, "compaction")?.same_settings_as).toBe("chat");
  });

  test("a role that cannot resolve is surfaced, not quietly dropped", async () => {
    const { ctx } = await build(`[defaults]\nmodel = "opus"\n`);
    switchModel(ctx, { name: "kimi", subagent: "music" });

    const shared = roleNamed(ctx, "sub-agents");
    expect(shared?.source).toStartWith("inherits chat");
    expect(shared?.error).toContain("different models");
    expect(shared?.model).toBeNull();
  });

  test("a sub-agent on the chat model still keeps its settings to itself", async () => {
    const { ctx } = await build(`[defaults]\nmodel = "opus"\n`);
    setModelSetting(ctx, { key: "temperature", value: 0.9, scope: "character" });
    setModelSetting(ctx, {
      key: "temperature",
      value: 0.2,
      scope: "character",
      subagent: "music",
    });

    const music = roleNamed(ctx, "sub-agent: music");
    expect(music?.model).toBe("chat.anthropic.opus");
    expect(music?.same_settings_as).toBeNull();
    expect(music?.settings).toEqual([{ key: "temperature", value: 0.2, scope: "character" }]);
    expect(roleNamed(ctx, "chat")?.settings).toEqual([
      { key: "temperature", value: 0.9, scope: "character" },
    ]);
  });
});

describe("naming one setting", () => {
  test("an unknown key is refused", async () => {
    const { ctx } = await build(`[defaults]\nmodel = "opus"\n`);
    expect(() => modelSettings(ctx, { key: "nonsense" })).toThrow(/unknown setting key/);
  });

  test("a sub-agent's name in the key slot suggests the flag", async () => {
    const { ctx } = await build(`[defaults]\nmodel = "opus"\n`);
    expect(() => modelSettings(ctx, { key: "music" })).toThrow(
      /music is a sub-agent, not a setting; write --subagent=music/,
    );
  });

  test("a known key comes back on the response so the view can narrow", async () => {
    const { ctx } = await build(`[defaults]\nmodel = "opus"\n`);
    expect(record(modelSettings(ctx, { key: "temperature" }))["key"]).toBe("temperature");
  });
});
