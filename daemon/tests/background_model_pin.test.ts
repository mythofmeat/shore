import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ConfigRuntime } from "../src/commands/config.ts";
import { CommandError } from "../src/commands/errors.ts";
import {
  modelRoles,
  resetModel,
  switchModel,
  type ModelsContext,
} from "../src/commands/models.ts";
import { loadConfig } from "../src/config/loader.ts";
import { characterPreferencesPath } from "../src/config/preferences.ts";
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
  const root = await mkdtemp(testTmp("shore-bg-pin-"));
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

describe("pinning a background model", () => {
  test("writes the per-task key and moves only that role", async () => {
    const { ctx, configPath } = await build(`[defaults]\nmodel = "opus"\n`);
    expect(roleOf(ctx, "heartbeat")?.source).toBe("inherits chat");

    const result = switchModel(ctx, { name: "kimi", background_task: "heartbeat" }) as Record<
      string,
      unknown
    >;

    expect(result["role"]).toBe("heartbeat");
    expect(result["config_key"]).toBe("defaults.background.heartbeat");
    expect(result["qualified_name"]).toBe("chat.openrouter.kimi");
    expect(await readToml(configPath)).toContain("heartbeat = \"chat.openrouter.kimi\"");

    expect(roleOf(ctx, "heartbeat")?.model).toBe("chat.openrouter.kimi");
    expect(roleOf(ctx, "heartbeat")?.source).toBe("defaults.background.heartbeat");
    expect(roleOf(ctx, "compaction")?.source).toBe("inherits chat");
    expect(roleOf(ctx, "chat")?.model).toBe("chat.anthropic.opus");
  });

  test("leaves the character's chat selection alone", async () => {
    const { ctx } = await build(`[defaults]\nmodel = "opus"\n`);
    switchModel(ctx, { name: "kimi", background_task: "heartbeat" });

    const prefs = characterPreferencesPath(ctx.dataDir, "Tester");
    expect(await readFile(prefs, "utf8").catch(() => "")).toBe("");
    expect(ctx.activeModel).toBeUndefined();
  });

  test("`all` writes the shared key and drops per-task pins", async () => {
    const { ctx, configPath } = await build(
      `[defaults]\nmodel = "opus"\n\n[defaults.background]\nheartbeat = "haiku"\n`,
    );

    const result = switchModel(ctx, { name: "kimi", background_task: "all" }) as Record<
      string,
      unknown
    >;

    expect(result["role"]).toBe("background");
    expect(result["config_key"]).toBe("defaults.background.model");
    expect(result["cleared"]).toEqual(["defaults.background.heartbeat"]);

    const written = await readToml(configPath);
    expect(written).toContain("model = \"chat.openrouter.kimi\"");
    expect(written).not.toContain("heartbeat =");

    expect(roleOf(ctx, "heartbeat")?.model).toBe("chat.openrouter.kimi");
    expect(roleOf(ctx, "compaction")?.model).toBe("chat.openrouter.kimi");
    expect(roleOf(ctx, "heartbeat")?.source).toBe("defaults.background.model");
  });

  test("an unknown name is an error and writes nothing", async () => {
    const { ctx, configPath } = await build(`[defaults]\nmodel = "opus"\n`);
    const before = await readToml(configPath);

    let thrown: unknown;
    try {
      switchModel(ctx, { name: "ghost", background_task: "heartbeat" });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(CommandError);
    expect(await readToml(configPath)).toBe(before);
  });

  test("an unknown task is an error", async () => {
    const { ctx } = await build(`[defaults]\nmodel = "opus"\n`);
    expect(() => switchModel(ctx, { name: "kimi", background_task: "dreaming" })).toThrow(
      /unknown background task/,
    );
  });
});

describe("unpinning a background model", () => {
  test("removes the per-task key and falls back to the shared one", async () => {
    const { ctx, configPath } = await build(
      `[defaults]\nmodel = "opus"\n\n[defaults.background]\nmodel = "haiku"\nheartbeat = "kimi"\n`,
    );

    const result = resetModel(ctx, { background_task: "heartbeat" }) as Record<string, unknown>;

    expect(result["cleared"]).toEqual(["defaults.background.heartbeat"]);
    expect(result["source"]).toBe("defaults.background.model");
    expect(result["active"]).toBe("chat.anthropic.haiku");
    expect(await readToml(configPath)).not.toContain("heartbeat =");
    expect(roleOf(ctx, "heartbeat")?.model).toBe("chat.anthropic.haiku");
  });

  test("`all` clears every background key and the tasks inherit chat", async () => {
    const { ctx, configPath } = await build(
      `[defaults]\nmodel = "opus"\n\n[defaults.background]\nmodel = "haiku"\ncompaction = "kimi"\n`,
    );

    const result = resetModel(ctx, { background_task: "all" }) as Record<string, unknown>;

    expect(result["cleared"]).toEqual([
      "defaults.background.model",
      "defaults.background.compaction",
    ]);
    const written = await readToml(configPath);
    expect(written).not.toContain("compaction =");
    expect(roleOf(ctx, "heartbeat")?.source).toBe("inherits chat");
    expect(roleOf(ctx, "compaction")?.source).toBe("inherits chat");
  });

  test("clearing a key that was never set is not an error", async () => {
    const { ctx } = await build(`[defaults]\nmodel = "opus"\n`);
    const result = resetModel(ctx, { background_task: "compaction" }) as Record<string, unknown>;

    expect(result["cleared"]).toEqual([]);
    expect(result["source"]).toBe("inherits chat");
  });

  test("a bare reset still targets the chat model", async () => {
    const { ctx } = await build(`[defaults]\nmodel = "opus"\n`);
    const result = resetModel(ctx) as Record<string, unknown>;

    expect(result["reset_to"]).toBe("config default");
    expect(result["role"]).toBeUndefined();
  });
});
