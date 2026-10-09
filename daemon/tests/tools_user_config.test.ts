import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configSchema } from "../src/config/schema.ts";
import { loadConfig, type LoadedConfig } from "../src/config/loader.ts";
import { characterToolsFor, characterWorkspace } from "../src/tools/character_workspace.ts";
import { testTmp } from "./support/tmp.ts";

async function configured(files: Record<string, string>): Promise<LoadedConfig> {
  const root = testTmp(`tools-user-${crypto.randomUUID()}`);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return loadConfig(join(root, "config.toml"), {
    env: { HOME: root, SHORE_DATA_DIR: join(root, "data"), SHORE_CACHE_DIR: join(root, "cache"), SHORE_WORKSPACE_DIR: join(root, "workspace") },
    onWarn: () => {},
  });
}

function failure(load: () => unknown): string {
  try {
    load();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the config to be refused");
}

describe("tools.user and tools.pass_env", () => {
  test("are tool settings, not overrides for tools named user and pass_env", async () => {
    const config = await configured({ "config.toml": '[tools]\nuser = "2001:1000"\npass_env = ["TODOIST_API_KEY", "LANG_2"]\n' });
    expect(config.app.tools.user).toBe("2001:1000");
    expect(config.app.tools.pass_env).toEqual(["TODOIST_API_KEY", "LANG_2"]);
    expect([...config.app.tools.config.keys()]).toEqual([]);
  });

  test("default to the daemon's user and none of its variables", async () => {
    const config = await configured({ "config.toml": "" });
    expect(config.app.tools.user).toBeUndefined();
    expect(config.app.tools.pass_env).toEqual([]);
  });

  test("refuse values that are not a user or a variable name", async () => {
    const root = testTmp(`tools-user-bad-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "config.toml"), '[tools]\nuser = "ada lovelace"\n');
    expect(failure(() => loadConfig(join(root, "config.toml"), { env: { HOME: root }, onWarn: () => {} })))
      .toContain("`ada lovelace` is not a user: give a user name, a numeric uid, or uid:gid");
    await writeFile(join(root, "config.toml"), '[tools]\npass_env = ["NOT-A-NAME"]\n');
    expect(failure(() => loadConfig(join(root, "config.toml"), { env: { HOME: root }, onWarn: () => {} })))
      .toContain("`NOT-A-NAME` is not an environment variable name");
  });

  test("a stdio MCP server takes a user of its own", async () => {
    const config = await configured({ "config.toml": '[mcp.cards]\ncommand = "cards-mcp"\nuser = "ada"\n' });
    expect(config.app.mcp.get("cards")?.user).toBe("ada");
  });

  test("are described in the config schema", () => {
    const schema = configSchema({ instancesAt: (key) => key === "mcp" ? ["cards"] : [] });
    const row = (key: string) => schema.find((entry) => entry.key === key);
    expect(row("tools.user")).toMatchObject({ kind: "string", optional: true, settable: true });
    expect(row("tools.user")?.description).toContain("Unix user the character's tools run as");
    expect(row("tools.pass_env")).toMatchObject({ kind: "list", item_kind: "string" });
    expect(row("mcp.cards.user")?.description).toContain("Unix user this stdio server runs as");
  });
});

describe("a character's user", () => {
  test("comes from its own config.toml before the global one, from either config", async () => {
    const global = await configured({
      "config.toml": '[tools]\nuser = "shared"\npass_env = ["A"]\n',
      "characters/ada/config.toml": '[tools]\nuser = "ada"\n',
    });
    expect(characterToolsFor(global, "ada")).toEqual({ user: "ada", passEnv: ["A"] });
    expect(characterToolsFor(global, "bob")).toEqual({ user: "shared", passEnv: ["A"] });
    const workspace = characterWorkspace(global, "ada");
    expect(workspace.isolated).toBe(true);
    expect(workspace.dir).toBe(join(global.dirs.workspace ?? "", "ada"));
  });

  test("is unset when no config names one", async () => {
    const workspace = characterWorkspace(await configured({ "config.toml": "" }), "ada");
    expect(workspace.isolated).toBe(false);
    expect(workspace.tools).toEqual({ user: undefined, passEnv: [] });
  });

  test("an overlay that appears later is read again only when asked to look fresh", async () => {
    const global = await configured({ "config.toml": "" });
    expect(characterToolsFor(global, "ada").user).toBeUndefined();
    const overlay = join(global.dirs.config, "characters", "ada", "config.toml");
    await mkdir(dirname(overlay), { recursive: true });
    await writeFile(overlay, '[tools]\nuser = "ada"\n');
    expect(characterWorkspace(global, "ada").tools.user).toBeUndefined();
    expect(characterWorkspace(global, "ada", { fresh: true }).tools.user).toBe("ada");
  });
});
