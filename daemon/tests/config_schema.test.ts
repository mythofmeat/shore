import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { acceptedTopLevelSections, defaultAppConfig } from "../src/config/app.ts";
import { configSchema, type SchemaEntry } from "../src/config/schema.ts";
import { schemaValueLiteral, SchemaValueError } from "../src/config/schema_value.ts";
import { setTomlValue, TomlEditError } from "../src/config/toml_edit.ts";
import { serializeConfigValue } from "../src/config/serialize.ts";
import { config, schemaOf, type ConfigContext, type ConfigRuntime } from "../src/commands/config.ts";
import { loadConfig } from "../src/config/loader.ts";
import { publicConfig, parseConfigPath } from "../src/config/surface.ts";
import { testTmp } from "./support/tmp.ts";

const NO_INSTANCES = { instancesAt: () => [] };

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

function leafPaths(value: unknown, prefix: string, out: string[]): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    out.push(prefix);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    leafPaths(child, prefix === "" ? key : `${prefix}.${key}`, out);
  }
}

describe("configSchema", () => {
  const entries = configSchema(NO_INSTANCES);
  const byKey = new Map(entries.map((e) => [e.key, e]));

  test("offers every top level section the parser accepts", () => {
    for (const section of acceptedTopLevelSections()) {
      expect(byKey.has(section), `schema is missing top level \`${section}\``).toBe(true);
    }
  });

  test("every leaf of the default config has a schema entry", () => {
    const defaults = publicConfig(serializeConfigValue(defaultAppConfig()) as Record<string, unknown>);
    const paths: string[] = [];
    leafPaths(defaults, "", paths);
    const missing = paths.filter((p) => !byKey.has(p));
    expect(missing, "config fields with no schema entry — add a typed reader").toEqual([]);
  });

  test("no key is typed as unknown", () => {
    const untyped = entries.filter((e) => e.kind === "unknown").map((e) => e.key);
    expect(untyped, "these readers carry no type descriptor").toEqual([]);
  });

  test("booleans and enums carry their candidate values", () => {
    expect(byKey.get("heartbeat.enabled")?.values).toEqual(["true", "false"]);
    expect(byKey.get("chat.user_timestamps")?.values).toEqual([
      "auto",
      "always",
      "never",
    ]);
    expect(byKey.get("notifications.via")?.values).toEqual(["off", "notify_send", "ntfy", "command"]);
  });

  test("model valued keys point at the catalog", () => {
    expect(byKey.get("chat.model")?.source).toBe("chat_models");
    expect(byKey.get("heartbeat.model")?.source).toBe("chat_models");
    expect(byKey.get("embedding.model")?.source).toBe("embedding_models");
    expect(byKey.get("tools.enabled")?.source).toBe("tools");
    expect(byKey.get("subagents.enabled")?.source).toBe("subagents");
  });

  test("map keys say what their names are drawn from", () => {
    expect(byKey.get("tools")?.key_source).toBe("tools");
    expect(byKey.get("mcp")?.key_source).toBeUndefined();
  });

  test("the keys that need a daemon restart say so", () => {
    expect(byKey.get("daemon.listen_addr")?.restart_required).toBe(true);
    expect(byKey.get("daemon.cache_forensics")?.restart_required).toBe(true);
    expect(byKey.get("compaction.idle_after")?.restart_required).toBe(false);
    expect(byKey.get("heartbeat.enabled")?.restart_required).toBe(false);
  });

  test("tables and maps are readable but not settable", () => {
    expect(byKey.get("compaction")?.settable).toBe(false);
    expect(byKey.get("mcp")?.settable).toBe(false);
    expect(byKey.get("budgets")?.settable).toBe(false);
    for (const section of ["chat", "embedding", "image", "providers"]) {
      expect(byKey.get(section)?.settable, `${section} must not be settable`).toBe(false);
    }
  });

  test("map instances are expanded from live config", async () => {
    const ctx = await world(
      '[mcp.beets]\ncommand = "beet"\n\n[subagents.scribe]\ndescription = "d"\nprompt = "p"\n',
    );
    const keys = new Set(schemaOf(ctx).map((e) => e.key));
    expect(keys.has("mcp.beets.command")).toBe(true);
    expect(keys.has("mcp.beets.args")).toBe(true);
    expect(keys.has("subagents.scribe.prompt")).toBe(true);
  });
});

describe("schemaValueLiteral", () => {
  const entries = configSchema(NO_INSTANCES);
  const at = (key: string): SchemaEntry => {
    const found = entries.find((e) => e.key === key);
    if (found === undefined) throw new Error(`no schema entry ${key}`);
    return found;
  };

  test("booleans accept the friendly spellings", () => {
    for (const yes of ["true", "yes", "on", "1", "TRUE"]) {
      expect(schemaValueLiteral(at("heartbeat.enabled"), yes)).toBe("true");
    }
    for (const no of ["false", "no", "off", "0"]) {
      expect(schemaValueLiteral(at("heartbeat.enabled"), no)).toBe("false");
    }
  });

  test("durations are normalised to their largest whole unit", () => {
    expect(schemaValueLiteral(at("compaction.idle_after"), "90m")).toBe('"90m"');
    expect(schemaValueLiteral(at("compaction.idle_after"), "120m")).toBe('"2h"');
    expect(schemaValueLiteral(at("compaction.idle_after"), "3600s")).toBe('"1h"');
    expect(() => schemaValueLiteral(at("compaction.idle_after"), "soon")).toThrow(SchemaValueError);
  });

  test("integers reject overflow and junk", () => {
    expect(() => schemaValueLiteral(at("compaction.min_turns"), "-1")).toThrow(
      SchemaValueError,
    );
    expect(() => schemaValueLiteral(at("compaction.min_turns"), "lots")).toThrow(
      SchemaValueError,
    );
    expect(schemaValueLiteral(at("compaction.min_turns"), "20")).toBe("20");
  });

  test("lists split on commas and quote their items", () => {
    expect(schemaValueLiteral(at("tools.enabled"), "read, edit")).toBe('["read", "edit"]');
    expect(schemaValueLiteral(at("tools.enabled"), "")).toBe("[]");
    expect(schemaValueLiteral(at("tools.enabled"), "[read, edit]")).toBe('["read", "edit"]');
  });

  test("every settable key produces a literal the parser accepts", async () => {
    const ctx = await world("");
    const settable = schemaOf(ctx).filter((e) => e.settable);
    expect(settable.length).toBeGreaterThan(30);
    for (const entry of settable) {
      const sample = sampleFor(entry);
      const literal = schemaValueLiteral(entry, sample);
      const text = setTomlValue("", parseConfigPath(entry.key), literal).text;
      expect(() => Bun.TOML.parse(text), `${entry.key} = ${literal}`).not.toThrow();
    }
  });
});

function sampleFor(entry: SchemaEntry): string {
  if (entry.values.length > 0) return entry.values[0] as string;
  switch (entry.kind === "list" ? (entry.item_kind ?? "string") : entry.kind) {
    case "integer":
      return "1";
    case "float":
      return "0.5";
    case "duration":
      return "30s";
    default:
      return "sample";
  }
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
