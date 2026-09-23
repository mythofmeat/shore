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

const CATALOG = "[chat.\"anthropic:opus-id\"]\nsdk = \"anthropic\"\n\n[chat.\"anthropic:haiku-id\"]\nsdk = \"anthropic\"\n\n[chat.\"openrouter:kimi-id\"]\nsdk = \"openrouter\"\n\n[subagents.music]\ndescription = \"plays things\"\nprompt = \"you are a dj\"\n\n[subagents.librarian]\ndescription = \"finds things\"\nprompt = \"you are a librarian\"\n";

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

test("model information reports the targeted subagent's sampler and scope", async () => {
  const { ctx } = await build("[chat]\nmodel = \"opus-id\"\n");
  setModelSetting(ctx, { key: "temperature", value: 0.2 });
  setModelSetting(ctx, { subagent: "music", key: "temperature", value: 0.8 });
  expect(modelInfo(ctx, {})).toMatchObject({ effective_sampler: { temperature: 0.2 }, scopes: { temperature: "character_model" } });
  expect(modelInfo(ctx, { subagent: "music" })).toMatchObject({ effective_sampler: { temperature: 0.8 }, scopes: { temperature: "character_subagent" } });
});

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
    const { ctx, configPath } = await build("[chat]\nmodel = \"opus-id\"\n");

    const result = record(switchModel(ctx, { name: "kimi-id", subagent: "music" }));

    expect(result["role"]).toBe("sub-agent: music");
    expect(result["config_key"]).toBe("subagents.music.model");
    expect(result["qualified_name"]).toBe("openrouter:kimi-id");
    expect(await readToml(configPath)).toContain('model = "openrouter:kimi-id"');

    expect(ctx.config.app.subagents.get("music")?.model).toBe("openrouter:kimi-id");
    expect(ctx.config.app.subagents.get("librarian")?.model).toBeUndefined();
    expect(roleOf(ctx, "chat")?.model).toBe("anthropic:opus-id");
  });

  test("bare `all` writes the shared default and drops per-sub-agent pins", async () => {
    const { ctx, configPath } = await build("[chat]\nmodel = \"opus-id\"\n");
    switchModel(ctx, { name: "haiku-id", subagent: "music" });

    const result = record(switchModel(ctx, { name: "kimi-id", subagent: "all" }));

    expect(result["role"]).toBe("sub-agents");
    expect(result["config_key"]).toBe("subagents.model");
    expect(result["cleared"]).toEqual(["subagents.music.model"]);

    const written = await readToml(configPath);
    expect(Bun.TOML.parse(written)).toHaveProperty('subagents.model', "openrouter:kimi-id");
    expect(ctx.config.app.subagents.get("music")?.model).toBeUndefined();
    expect(roleOf(ctx, "sub-agents")?.model).toBe("openrouter:kimi-id");
  });

  test("pinning one sub-agent leaves another one's pin alone", async () => {
    const { ctx } = await build("[chat]\nmodel = \"opus-id\"\n");
    switchModel(ctx, { name: "kimi-id", subagent: "music" });

    const result = record(switchModel(ctx, { name: "haiku-id", subagent: "librarian" }));

    expect(result["cleared"]).toEqual([]);
    expect(ctx.config.app.subagents.get("music")?.model).toBe("openrouter:kimi-id");
    expect(ctx.config.app.subagents.get("librarian")?.model).toBe("anthropic:haiku-id");
  });

  test("an unknown sub-agent is an error and writes nothing", async () => {
    const { ctx, configPath } = await build("[chat]\nmodel = \"opus-id\"\n");
    const before = await readToml(configPath);

    let thrown: unknown;
    try {
      switchModel(ctx, { name: "kimi-id", subagent: "ghost" });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(CommandError);
    expect((thrown as CommandError).message).toContain("unknown sub-agent: ghost");
    expect((thrown as CommandError).message).toContain("librarian, music");
    expect(await readToml(configPath)).toBe(before);
  });

  test("an unknown model is an error and writes nothing", async () => {
    const { ctx, configPath } = await build("[chat]\nmodel = \"opus-id\"\n");
    const before = await readToml(configPath);

    expect(() => switchModel(ctx, { name: "ghost", subagent: "music" })).toThrow(CommandError);
    expect(await readToml(configPath)).toBe(before);
  });
});

describe("unpinning a sub-agent's model", () => {
  test("a named sub-agent falls back to the shared default", async () => {
    const { ctx } = await build(
      "[chat]\nmodel = \"opus-id\"\n\n[subagents]\nmodel = \"haiku-id\"\n",
    );
    switchModel(ctx, { name: "kimi-id", subagent: "music" });

    const result = record(resetModel(ctx, { subagent: "music" }));

    expect(result["cleared"]).toEqual(["subagents.music.model"]);
    expect(result["role"]).toBe("sub-agent: music");
    expect(result["roles"]).toEqual([expect.objectContaining({ role: "sub-agent: music", model: "anthropic:haiku-id" })]);
    expect(ctx.config.app.subagents.get("music")?.model).toBeUndefined();
    expect(roleOf(ctx, "sub-agents")?.model).toBe("anthropic:haiku-id");
  });

  test("bare `all` clears the shared default and every override", async () => {
    const { ctx, configPath } = await build(
      "[chat]\nmodel = \"opus-id\"\n\n[subagents]\nmodel = \"haiku-id\"\n",
    );
    switchModel(ctx, { name: "kimi-id", subagent: "music" });

    const result = record(resetModel(ctx, { subagent: "all" }));

    expect(result["cleared"]).toEqual(["subagents.model", "subagents.music.model"]);
    expect(await readToml(configPath)).not.toContain("subagent_model");
    expect(roleOf(ctx, "sub-agents")?.source).toBe("inherits chat");
  });

  test("clearing what was never pinned is not an error", async () => {
    const { ctx } = await build("[chat]\nmodel = \"opus-id\"\n");
    const result = record(resetModel(ctx, { subagent: "librarian" }));

    expect(result["cleared"]).toEqual([]);
  });

  test("an unknown sub-agent is still an error", async () => {
    const { ctx } = await build("[chat]\nmodel = \"opus-id\"\n");
    expect(() => resetModel(ctx, { subagent: "ghost" })).toThrow(/unknown sub-agent/);
  });
});

describe("describing a role instead of a model", () => {
  test("info follows the role to whatever it resolves to", async () => {
    const { ctx } = await build("[chat]\nmodel = \"opus-id\"\n");
    switchModel(ctx, { name: "kimi-id", background_task: "compaction" });

    const described = record(modelInfo(ctx, { name: "", background_task: "compaction" }));
    expect(described["qualified_name"]).toBe("openrouter:kimi-id");
  });

  test("naming both a model and a role is refused", async () => {
    const { ctx } = await build("[chat]\nmodel = \"opus-id\"\n");
    expect(() => modelInfo(ctx, { name: "haiku-id", background_task: "compaction" })).toThrow(
      /not both/,
    );
  });
});

describe("the settings overview", () => {
  test("a fresh config shows chat alone and counts the rest as inherited", async () => {
    const { ctx } = await build("[chat]\nmodel = \"opus-id\"\n");
    const shown = overview(ctx);

    expect(shown.roles.map((r) => r.role)).toEqual(["chat"]);
    expect(shown.inherited_count).toBe(5);
    expect(shown.character).toBe("Tester");
  });

  test("a pinned role appears with the flag that targets it", async () => {
    const { ctx } = await build("[chat]\nmodel = \"opus-id\"\n");
    switchModel(ctx, { name: "kimi-id", background_task: "compaction" });

    const compaction = roleNamed(ctx, "compaction");
    expect(compaction?.model).toBe("openrouter:kimi-id");
    expect(compaction?.flag).toBe("--background=compaction");
    expect(compaction?.source).toBe("compaction.model");
    expect(roleNamed(ctx, "heartbeat")).toBeUndefined();
  });

  test("a role that only inherits still shows up once it is tuned", async () => {
    const { ctx } = await build("[chat]\nmodel = \"opus-id\"\n");
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
    const { ctx } = await build("[chat]\nmodel = \"opus-id\"\n");
    setModelSetting(ctx, { key: "temperature", value: 0.1, scope: "global" });
    setModelSetting(ctx, { key: "top_p", value: 0.9, scope: "global" });
    setModelSetting(ctx, { key: "temperature", value: 0.8, scope: "character" });

    expect(roleNamed(ctx, "chat")?.settings).toEqual([
      { key: "temperature", value: 0.8, scope: "character" },
      { key: "top_p", value: 0.9, scope: "global" },
    ]);
  });

  test("two roles on one model are told they share the same settings", async () => {
    const { ctx } = await build("[chat]\nmodel = \"opus-id\"\n");
    switchModel(ctx, { name: "opus-id", background_task: "compaction" });
    setModelSetting(ctx, { key: "temperature", value: 0.4, scope: "character" });

    expect(roleNamed(ctx, "chat")?.same_settings_as).toBeNull();
    expect(roleNamed(ctx, "compaction")?.same_settings_as).toBe("chat");
  });

  test("a role that cannot resolve is surfaced, not quietly dropped", async () => {
    const { ctx } = await build("[chat]\nmodel = \"opus-id\"\n");
    switchModel(ctx, { name: "kimi-id", subagent: "music" });

    const shared = roleNamed(ctx, "sub-agents");
    expect(shared?.source).toStartWith("inherits chat");
    expect(shared?.error).toContain("different models");
    expect(shared?.model).toBeNull();
  });

  test("a sub-agent on the chat model still keeps its settings to itself", async () => {
    const { ctx } = await build("[chat]\nmodel = \"opus-id\"\n");
    setModelSetting(ctx, { key: "temperature", value: 0.9, scope: "character" });
    setModelSetting(ctx, {
      key: "temperature",
      value: 0.2,
      scope: "character",
      subagent: "music",
    });

    const music = roleNamed(ctx, "sub-agent: music");
    expect(music?.model).toBe("anthropic:opus-id");
    expect(music?.same_settings_as).toBeNull();
    expect(music?.settings).toEqual([{ key: "temperature", value: 0.2, scope: "character" }]);
    expect(roleNamed(ctx, "chat")?.settings).toEqual([
      { key: "temperature", value: 0.9, scope: "character" },
    ]);
  });
});

describe("naming one setting", () => {
  test("an unknown key is refused", async () => {
    const { ctx } = await build("[chat]\nmodel = \"opus-id\"\n");
    expect(() => modelSettings(ctx, { key: "nonsense" })).toThrow(/unknown setting key/);
  });

  test("a sub-agent's name in the key slot suggests the flag", async () => {
    const { ctx } = await build("[chat]\nmodel = \"opus-id\"\n");
    expect(() => modelSettings(ctx, { key: "music" })).toThrow(
      /music is a sub-agent, not a setting; write --subagent=music/,
    );
  });

  test("a known key comes back on the response so the view can narrow", async () => {
    const { ctx } = await build("[chat]\nmodel = \"opus-id\"\n");
    expect(record(modelSettings(ctx, { key: "temperature" }))["key"]).toBe("temperature");
  });
});
