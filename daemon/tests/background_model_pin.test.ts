import { parseOperationInput } from "../src/operations/contracts.ts";
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

const CATALOG = "[chat.\"anthropic:opus-id\"]\nsdk = \"anthropic\"\n\n[chat.\"anthropic:haiku-id\"]\nsdk = \"anthropic\"\n\n[chat.\"openrouter:kimi-id\"]\nsdk = \"openrouter\"\n";

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
    const { ctx, configPath } = await build("[chat]\nmodel = \"opus-id\"\n");
    expect(roleOf(ctx, "heartbeat")?.source).toBe("inherits chat");

    const result = switchModel(ctx, { name: "kimi-id", background_task: "heartbeat" }) as Record<
      string,
      unknown
    >;

    expect(result["role"]).toBe("heartbeat");
    expect(result["config_key"]).toBe("heartbeat.model");
    expect(result["qualified_name"]).toBe("openrouter:kimi-id");
    expect(Bun.TOML.parse(await readToml(configPath))).toHaveProperty("heartbeat.model", "openrouter:kimi-id");

    expect(roleOf(ctx, "heartbeat")?.model).toBe("openrouter:kimi-id");
    expect(roleOf(ctx, "heartbeat")?.source).toBe("heartbeat.model");
    expect(roleOf(ctx, "compaction")?.source).toBe("inherits chat");
    expect(roleOf(ctx, "chat")?.model).toBe("anthropic:opus-id");
  });

  test("leaves the character's chat selection alone", async () => {
    const { ctx } = await build("[chat]\nmodel = \"opus-id\"\n");
    switchModel(ctx, { name: "kimi-id", background_task: "heartbeat" });

    const prefs = characterPreferencesPath(ctx.dataDir, "Tester");
    expect(await readFile(prefs, "utf8").catch(() => "")).toBe("");
    expect(ctx.activeModel).toBeUndefined();
  });

  test("`all` writes both task models and replaces both per-task pins", async () => {
    const { ctx, configPath } = await build(
      "[chat]\nmodel = \"opus-id\"\n\n[heartbeat]\nmodel = \"haiku-id\"\n",
    );

    const result = switchModel(ctx, { name: "kimi-id", background_task: "all" }) as Record<
      string,
      unknown
    >;

    expect(result["role"]).toBe("background");
    expect(result["config_key"]).toBe("heartbeat.model");
    expect(result["config_keys"]).toEqual(["heartbeat.model", "compaction.model"]);
    expect(result["cleared"]).toEqual([]);

    const written = await readToml(configPath);
    expect(written).toContain("model = \"openrouter:kimi-id\"");
    expect(written).not.toContain("heartbeat =");

    expect(roleOf(ctx, "heartbeat")?.model).toBe("openrouter:kimi-id");
    expect(roleOf(ctx, "compaction")?.model).toBe("openrouter:kimi-id");
    expect(roleOf(ctx, "heartbeat")?.source).toBe("heartbeat.model");
  });

  test("an unknown name is an error and writes nothing", async () => {
    const { ctx, configPath } = await build("[chat]\nmodel = \"opus-id\"\n");
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
    const { ctx } = await build("[chat]\nmodel = \"opus-id\"\n");
    expect(() => switchModel(ctx, parseOperationInput("switch_model", { name: "kimi-id", background_task: "dreaming" }))).toThrow(
      /background_task/,
    );
  });
});

describe("unpinning a background model", () => {


  test("`all` clears every background key and the tasks inherit chat", async () => {
    const { ctx, configPath } = await build(
      `[chat]
model = "opus-id"

[heartbeat]
model = "haiku-id"
[compaction]
model = "kimi-id"
`,
    );

    const result = resetModel(ctx, { background_task: "all" }) as Record<string, unknown>;

    expect(result["cleared"]).toEqual([
      "heartbeat.model",
      "compaction.model",
    ]);
    const written = await readToml(configPath);
    expect(written).not.toContain("compaction =");
    expect(roleOf(ctx, "heartbeat")?.source).toBe("inherits chat");
    expect(roleOf(ctx, "compaction")?.source).toBe("inherits chat");
  });

  test("`all` reports each task's model when a thread pin makes them diverge", async () => {
    const { ctx } = await build("[chat]\nmodel = \"opus-id\"\n\n[heartbeat]\nmodel = \"kimi-id\"\n");
    ctx.threadModel = "anthropic:haiku-id";
    ctx.thread = "side";

    const result = resetModel(ctx, { background_task: "all" }) as Record<string, unknown>;

    expect(result["roles"]).toEqual([
      { role: "heartbeat", model: "anthropic:opus-id", source: "inherits chat" },
      { role: "compaction", model: "anthropic:haiku-id", source: "inherits chat" },
    ]);
    expect(result["active"]).toBeNull();
    expect(result["source"]).toBeNull();
    expect(result["reset_to"]).toBe("per-task defaults");
  });

  test("`all` reports the shared model when every task agrees", async () => {
    const { ctx } = await build("[chat]\nmodel = \"opus-id\"\n");
    const result = resetModel(ctx, { background_task: "all" }) as Record<string, unknown>;

    expect(result["active"]).toBe("anthropic:opus-id");
    expect(result["source"]).toBe("inherits chat");
    expect(result["roles"]).toHaveLength(2);
  });

  test("clearing a key that was never set is not an error", async () => {
    const { ctx } = await build("[chat]\nmodel = \"opus-id\"\n");
    const result = resetModel(ctx, { background_task: "compaction" }) as Record<string, unknown>;

    expect(result["cleared"]).toEqual([]);
    expect(result["source"]).toBe("inherits chat");
  });

  test("a bare reset still targets the chat model", async () => {
    const { ctx } = await build("[chat]\nmodel = \"opus-id\"\n");
    const result = resetModel(ctx) as Record<string, unknown>;

    expect(result["reset_to"]).toBe("config default");
    expect(result["role"]).toBeUndefined();
  });
});
