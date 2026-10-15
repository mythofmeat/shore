import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTomlValue, TomlEditError } from "../src/config/toml_edit.ts";
import { config, type ConfigContext, type ConfigRuntime } from "../src/commands/config.ts";
import { loadConfig } from "../src/config/loader.ts";
import { testTmp } from "./support/tmp.ts";

const runtime = (): ConfigRuntime => ({
  reloadRuntimeConfig: () => {},
  adoptGlobalConfig: () => {},
  notifyPromptSnapshotRefreshed: () => {},
});

async function world(
  toml: string,
  extra: [path: string, text: string][] = [],
): Promise<ConfigContext> {
  const root = await mkdtemp(testTmp("shore-schema-"));
  const configPath = join(root, "config", "config.toml");
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, toml);
  for (const [path, text] of extra) {
    const target = join(root, "config", path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  }
  const env = {
    XDG_CONFIG_HOME: root,
    XDG_DATA_HOME: join(root, "data-home"),
    XDG_CACHE_HOME: join(root, "cache-home"),
    XDG_RUNTIME_DIR: join(root, "run-home"),
  };
  const loaded = loadConfig(configPath, { env, onWarn: () => {} });
  await mkdir(loaded.dirs.data, { recursive: true });
  return {
    config: loaded,
    configPath,
    characterName: "mid",
    activeModel: undefined,
    runtime: runtime(),
    env,
  };
}

describe("setTomlValue", () => {
  const SRC = `# top comment

[defaults]
# which model
model = "one"
stream = true

[tools]
enabled_tools = [
  "read",
]
`;

  test("replaces a value and leaves every other byte alone", () => {
    const out = setTomlValue(SRC, ["defaults", "model"], '"two"');
    expect(out.action).toBe("replaced");
    expect(out.text).toBe(SRC.replace('model = "one"', 'model = "two"'));
  });

  test("collapses a multi line array onto one line", () => {
    const out = setTomlValue(SRC, ["tools", "enabled_tools"], '["read", "edit"]');
    expect(out.text).toContain('enabled_tools = ["read", "edit"]');
    expect(out.text).not.toContain('  "read",');
    expect(Bun.TOML.parse(out.text)).toMatchObject({
      tools: { enabled_tools: ["read", "edit"] },
    });
  });

  test("adds a missing key into an existing section", () => {
    const out = setTomlValue(SRC, ["defaults", "display_name"], '"Ellie"');
    expect(out.action).toBe("added-to-section");
    expect(out.text).toContain("# top comment");
    expect(Bun.TOML.parse(out.text)).toMatchObject({
      defaults: { model: "one", display_name: "Ellie" },
    });
  });

  test("appends a section that does not exist yet", () => {
    const out = setTomlValue(SRC, ["cache", "forensics"], "true");
    expect(out.action).toBe("added-section");
    expect(out.text.startsWith(SRC)).toBe(true);
    expect(Bun.TOML.parse(out.text)).toMatchObject({ cache: { forensics: true } });
  });

  test("writes into an empty file", () => {
    const out = setTomlValue("", ["defaults", "stream"], "false");
    expect(Bun.TOML.parse(out.text)).toEqual({ defaults: { stream: false } });
  });

  test("honours a dotted key already written at the top level", () => {
    const dotted = 'chat.model = "one"\n';
    const out = setTomlValue(dotted, ["chat", "model"], '"two"');
    expect(out.action).toBe("replaced");
    expect(out.text).toBe('chat.model = "two"\n');
  });

  test("refuses to reach inside an inline table", () => {
    const inline = '[defaults]\nbackground = { model = "one" }\n';
    expect(() => setTomlValue(inline, ["defaults", "background", "model"], '"two"')).toThrow(
      TomlEditError,
    );
  });

  test("a value containing a bracket does not confuse the scanner", () => {
    const tricky = '[notifications.ntfy]\ntopic = "notify [shore] #1"\n';
    const out = setTomlValue(tricky, ["notifications", "ntfy", "topic"], '"hi"');
    expect(out.action).toBe("replaced");
    expect(Bun.TOML.parse(out.text)).toMatchObject({
      notifications: { ntfy: { topic: "hi" } },
    });
  });
});

describe("config set on disk", () => {
  test("rolls the file back when the result would not load", async () => {
    const ctx = await world('[compaction]\nkeep_recent_turns = 2\nmin_turns = 12\n');
    const before = await readFile(ctx.configPath, "utf8");
    expect(() => config(ctx, { key: "compaction.min_turns", value: "1" })).toThrow(
      /was rejected/,
    );
    expect(await readFile(ctx.configPath, "utf8")).toBe(before);
  });

  test("writes to the conf.d file that already owns the key", async () => {
    const ctx = await world("[heartbeat]\nenabled = true\n", [
      ["conf.d/10-local.toml", "# local\n[heartbeat]\nenabled = false\n"],
    ]);
    const confd = join(ctx.config.dirs.config, "conf.d", "10-local.toml");

    const result = config(ctx, { key: "heartbeat.enabled", value: "true" }) as { file: string };

    expect(result.file, "conf.d wins the merge, so that is the file worth editing").toBe(confd);
    expect(await readFile(confd, "utf8")).toBe("# local\n[heartbeat]\nenabled = true\n");
    expect(await readFile(ctx.configPath, "utf8")).toBe("[heartbeat]\nenabled = true\n");
  });

  test("a key no file defines yet lands in the main config", async () => {
    const ctx = await world("[heartbeat]\nenabled = true\n", [
      ["conf.d/10-local.toml", "[tools]\nmax_result_chars = 10\n"],
    ]);
    const result = config(ctx, { key: "compaction.idle_after", value: "6h" }) as { file: string };
    expect(result.file).toBe(ctx.configPath);
    expect(await readFile(ctx.configPath, "utf8")).toContain('idle_after = "6h"');
  });
});
