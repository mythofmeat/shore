import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTomlValue, TomlEditError } from "../src/config/toml_edit.ts";
import { clearConfigKey, commitConfigEdits, config, type ConfigContext, type ConfigRuntime } from "../src/commands/config.ts";
import { loadConfig, type LoadedConfig } from "../src/config/loader.ts";
import { setTestEnv } from "./support/env.ts";
import { testTmp } from "./support/tmp.ts";

const runtime = (): ConfigRuntime => ({
  reloadRuntimeConfig: () => {},
  adoptGlobalConfig: () => {},
  notifyPromptSnapshotRefreshed: () => {},
});

function refusalOf(edit: () => unknown): Error {
  try {
    edit();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("the edit was accepted");
}

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

  test("an accepted change is adopted by the running daemon, environment file included", async () => {
    const ctx = await world("[compaction]\nkeep_recent_turns = 2\n");
    const adopted: LoadedConfig[] = [];
    const reloaded: LoadedConfig[] = [];
    ctx.runtime = { ...runtime(), adoptGlobalConfig: (fresh) => { adopted.push(fresh); }, reloadRuntimeConfig: (fresh) => { reloaded.push(fresh); } };
    setTestEnv("SHORE_ADOPTED_BY_SET", "before");
    await writeFile(join(dirname(ctx.configPath), ".env"), "SHORE_ADOPTED_BY_SET=from-dotenv\n");
    config(ctx, { key: "compaction.keep_recent_turns", value: "3" });
    expect(adopted).toHaveLength(1);
    expect(reloaded).toEqual(adopted);
    expect(ctx.config).toBe(adopted[0] as LoadedConfig);
    expect(config(ctx, { key: "compaction.keep_recent_turns" })).toMatchObject({ config: 3 });
    expect(process.env["SHORE_ADOPTED_BY_SET"]).toBe("from-dotenv");
  });

  test("a refused change names the key and value but never a secret's value, and leaves the file as it was", async () => {
    const ctx = await world('[mcp.search]\ncommand = "tavily"\n\n[mcp.search.env]\nREGION = "eu"\n', [["conf.d/10-local.toml", "[tools]\nmax_result_chars = 10\n"]]);
    await writeFile(join(ctx.config.dirs.config, "conf.d", "10-local.toml"), "[tools\n");
    const before = await readFile(ctx.configPath, "utf8");
    const secret = refusalOf(() => config(ctx, { key: "mcp.search.env.REGION", value: "my-private-region" }));
    expect(secret.message.startsWith("mcp.search.env.REGION = <redacted> was rejected: ")).toBe(true);
    expect(secret.message).not.toContain("my-private-region");
    const plain = refusalOf(() => config(ctx, { key: "compaction.idle_after", value: "6h" }));
    expect(plain.message.startsWith('compaction.idle_after = "6h" was rejected: ')).toBe(true);
    expect(await readFile(ctx.configPath, "utf8")).toBe(before);
  });

  test("a refused change to a config file that didn't exist removes the file again", async () => {
    const ctx = await world("", [["conf.d/10-local.toml", "[tools]\nmax_result_chars = 10\n"]]);
    await writeFile(join(ctx.config.dirs.config, "conf.d", "10-local.toml"), "[tools\n");
    await rm(ctx.configPath);
    expect(refusalOf(() => config(ctx, { key: "compaction.idle_after", value: "6h" })).message).toContain("was rejected");
    expect(await Bun.file(ctx.configPath).exists()).toBe(false);
  });

  test("a config file that can't be read is reported rather than overwritten", async () => {
    const ctx = await world("[heartbeat]\nenabled = true\n");
    await rm(ctx.configPath);
    await mkdir(ctx.configPath);
    expect(refusalOf(() => config(ctx, { key: "heartbeat.enabled", value: "false" })).message).toStartWith(`failed to read ${ctx.configPath}: `);
  });

  test("setting the default model points out a character whose own model still wins", async () => {
    const ctx = await world('[providers.anthropic]\napi_key_env = "ANTHROPIC_API_KEY"\n\n[chat]\nmodel = "anthropic:claude-one"\n');
    ctx.activeModel = "anthropic:claude-two";
    expect(config(ctx, { key: "chat.model", value: "anthropic:claude-one" })).toMatchObject({ masked_by_preference: "anthropic:claude-two" });
    expect(config(ctx, { key: "chat.model", value: "anthropic:claude-two" })).toMatchObject({ masked_by_preference: null });
    ctx.activeModel = undefined;
    expect(config(ctx, { key: "chat.model", value: "anthropic:claude-one" })).toMatchObject({ masked_by_preference: null });
    ctx.activeModel = "anthropic:claude-two";
    expect(config(ctx, { key: "compaction.idle_after", value: "6h" })).toMatchObject({ masked_by_preference: null });
  });

  test("clearing a key removes it from the file that holds it and says when there was nothing to clear", async () => {
    const ctx = await world("[compaction]\nidle_after = \"6h\"\n");
    expect(clearConfigKey(ctx, "compaction.idle_after")).toMatchObject({ set: "compaction.idle_after", action: "removed" });
    expect(await readFile(ctx.configPath, "utf8")).toBe("[compaction]\n");
    expect(clearConfigKey(ctx, " compaction . idle_after ")).toMatchObject({ set: "compaction.idle_after", action: "absent" });
  });

  test("reading a key walks into tables and reports a key that isn't there", async () => {
    const ctx = await world("[compaction]\nidle_after = \"6h\"\n");
    expect(config(ctx, { key: "compaction.idle_after" })).toMatchObject({ key: "compaction.idle_after", config: "6h" });
    for (const key of ["compaction.nope", "compaction.idle_after.deeper", "compaction.idle_after.deeper.still"]) {
      expect(refusalOf(() => config(ctx, { key })).message).toBe(`Config section not found: ${key}`);
    }
  });

  test("several files change together or not at all", async () => {
    const ctx = await world("[heartbeat]\nenabled = true\n", [["conf.d/10-local.toml", "[tools]\nmax_result_chars = 10\n"]]);
    const confd = join(ctx.config.dirs.config, "conf.d", "10-local.toml");
    const mainBefore = await readFile(ctx.configPath, "utf8");
    const confdBefore = await readFile(confd, "utf8");
    const rejected = refusalOf(() => commitConfigEdits(ctx, [
      { file: ctx.configPath, edit: (text) => text.replace("true", "false") },
      { file: confd, edit: (text) => text.replace("10", "\"ten\"") },
    ], "the pair"));
    expect(rejected.message).toStartWith("the pair was rejected: ");
    expect(await readFile(ctx.configPath, "utf8")).toBe(mainBefore);
    expect(await readFile(confd, "utf8")).toBe(confdBefore);

    const unreadable = join(ctx.config.dirs.config, "a-directory");
    await mkdir(unreadable);
    expect(refusalOf(() => commitConfigEdits(ctx, [{ file: unreadable, edit: () => "x = 1\n" }], "the read")).message).toStartWith(`failed to read ${unreadable}: `);

    const toml = refusalOf(() => commitConfigEdits(ctx, [{ file: ctx.configPath, edit: () => { throw new TomlEditError("can't edit that"); } }], "the edit"));
    expect(toml).toMatchObject({ code: "invalid_request", message: "can't edit that" });

    const kept = commitConfigEdits(ctx, [
      { file: ctx.configPath, edit: (text) => text },
      { file: confd, edit: (text) => text.replace("10", "12") },
    ], "the change");
    expect(kept.fresh.app.tools.max_result_chars).toBe(12);
    expect(ctx.config).toBe(kept.fresh);
  });

  test.skipIf(process.getuid?.() === 0)("a write that fails part way puts back the files already written", async () => {
    const ctx = await world("[heartbeat]\nenabled = true\n", [["conf.d/10-local.toml", "[tools]\nmax_result_chars = 10\n"]]);
    const confd = join(ctx.config.dirs.config, "conf.d", "10-local.toml");
    const newFile = join(ctx.config.dirs.config, "conf.d", "20-new.toml");
    const locked = join(ctx.config.dirs.config, "locked");
    await mkdir(locked);
    await chmod(locked, 0o555);
    const unwritable = join(locked, "30-new.toml");
    const failed = refusalOf(() => commitConfigEdits(ctx, [
      { file: confd, edit: (text) => text.replace("10", "11") },
      { file: newFile, edit: () => "[tools]\nmax_result_chars = 11\n" },
      { file: unwritable, edit: () => "x = 1\n" },
    ], "the write"));
    expect(failed.message).toStartWith(`failed to write ${unwritable}: `);
    expect(await Bun.file(newFile).exists()).toBe(false);
    expect(await readFile(confd, "utf8")).toBe("[tools]\nmax_result_chars = 10\n");
  });

  test("a value of the wrong kind, or for a key that doesn't exist or doesn't parse, is refused before the file is touched", async () => {
    const ctx = await world("[compaction]\nkeep_recent_turns = 2\n");
    const before = await readFile(ctx.configPath, "utf8");
    expect(refusalOf(() => config(ctx, { key: "compaction.keep_recent_turns", value: "many" }))).toMatchObject({ code: "invalid_request", message: 'compaction.keep_recent_turns: expected a whole number, got "many"' });
    expect(refusalOf(() => config(ctx, { key: "compaction.nope", value: "1" }))).toMatchObject({ code: "not_found", message: "Config section not found: compaction.nope" });
    expect(refusalOf(() => config(ctx, { key: 'compaction."open', value: "1" }))).toMatchObject({ code: "not_found", message: 'Config section not found: compaction."open' });
    expect(refusalOf(() => clearConfigKey(ctx, 'compaction."open'))).toMatchObject({ code: "not_found", message: 'Config section not found: compaction."open' });
    expect(await readFile(ctx.configPath, "utf8")).toBe(before);
  });

  test("a value naming something its source doesn't have is refused, while lists, blanks and empty sources go unchecked", async () => {
    const ctx = await world('[providers.anthropic]\napi_key_env = "ANTHROPIC_API_KEY"\n\n[chat."anthropic:claude-one"]\nmax_output_tokens = 100\n\n[image."openai:gpt-image-1"]\nsize = "1024x1024"\n\n[image."openai:gpt-image-2"]\nsize = "1024x1024"\n');
    expect(refusalOf(() => config(ctx, { key: "image.model", value: "openai:dall-e-9" }))).toMatchObject({ code: "not_found", message: 'image.model: no image_models named "openai:dall-e-9". Known: openai:gpt-image-1, openai:gpt-image-2' });
    expect(config(ctx, { key: "image.model", value: "openai:gpt-image-2" })).toMatchObject({ value: "openai:gpt-image-2" });
    expect(refusalOf(() => config(ctx, { key: "chat.model", value: "nosuch:model" }))).toMatchObject({ code: "not_found", message: 'model "nosuch:model" not found in static catalog or discovered models' });
    expect(config(ctx, { key: "chat.model", value: "claude-one" }), "a configured model may go by its bare name").toMatchObject({ value: "claude-one" });
    expect(config(ctx, { key: "tools.enabled", value: "read, edit" })).toMatchObject({ value: ["read", "edit"] });
    const blank = refusalOf(() => config(ctx, { key: "image.model", value: " " }));
    expect(blank, "a blank isn't a name to look up, so the loader judges it").toMatchObject({ code: "invalid_request" });
    expect(blank.message).toStartWith('image.model = " " was rejected: ');
    const bare = await world("");
    expect(config(bare, { key: "image.model", value: "openai:dall-e-9" }), "with no image models configured there is nothing to check against").toMatchObject({ value: "openai:dall-e-9" });
  });

  test("an edit the TOML editor can't make is refused as an invalid request", async () => {
    const ctx = await world('[mcp.search]\ncommand = "tavily"\nenv = { REGION = "eu" }\n');
    const before = await readFile(ctx.configPath, "utf8");
    const refused = refusalOf(() => config(ctx, { key: "mcp.search.env.REGION", value: "us" }));
    expect(refused).toMatchObject({ code: "invalid_request", message: "`mcp.search.env.REGION` lives inside the value of `mcp.search.env` on line 3; edit that line by hand" });
    expect(await readFile(ctx.configPath, "utf8")).toBe(before);
  });

  test.skipIf(process.getuid?.() === 0)("a config file that can't be written is reported and left as it was", async () => {
    const ctx = await world("[heartbeat]\nenabled = true\n");
    const folder = dirname(ctx.configPath);
    await chmod(folder, 0o555);
    let refused: Error;
    try {
      refused = refusalOf(() => config(ctx, { key: "heartbeat.enabled", value: "false" }));
    } finally {
      await chmod(folder, 0o755);
    }
    expect(refused).toMatchObject({ code: "internal_error" });
    expect(refused.message).toStartWith(`failed to write ${ctx.configPath}: `);
    expect(await readFile(ctx.configPath, "utf8")).toBe("[heartbeat]\nenabled = true\n");
  });

  test("a rejected change that wrote one new file twice still removes it", async () => {
    const ctx = await world("[heartbeat]\nenabled = true\n");
    const fresh = join(ctx.config.dirs.config, "conf.d", "20-new.toml");
    const rejected = refusalOf(() => commitConfigEdits(ctx, [
      { file: fresh, edit: () => '[tools]\nmax_result_chars = "ten"\n' },
      { file: fresh, edit: () => '[tools]\nmax_result_chars = "eleven"\n' },
    ], "the pair"));
    expect(rejected).toMatchObject({ code: "invalid_request" });
    expect(rejected.message).toStartWith("the pair was rejected: ");
    expect(await Bun.file(fresh).exists()).toBe(false);
  });

  test("a rejected change that can't be taken back says the file still holds it", async () => {
    const ctx = await world("[heartbeat]\nenabled = true\n");
    const fresh = join(ctx.config.dirs.config, "conf.d", "20-new.toml");
    const removal = spyOn(fs, "rmSync").mockImplementation(() => {
      throw new Error("the disk went away");
    });
    let refused: Error;
    try {
      refused = refusalOf(() => commitConfigEdits(ctx, [{ file: fresh, edit: () => '[tools]\nmax_result_chars = "ten"\n' }], "the edit"));
    } finally {
      removal.mockRestore();
    }
    expect(refused).toMatchObject({ code: "internal_error", message: `${fresh} was left holding a rejected edit: restoring it failed: the disk went away` });
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
