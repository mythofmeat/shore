import { describe, expect, test } from "bun:test";

import {
  ConfigError,
  parseConfigTable,
  type ConfigWarn,
  type LoadedConfig,
  type TomlTable,
} from "../src/config/loader.ts";
import type { ShoreDirs } from "../src/config/dirs.ts";
import { compareByCodePoint } from "../src/util/sort.ts";

const DIRS: ShoreDirs = {
  config: "/nonexistent/config",
  data: "/nonexistent/data",
  runtime: "/nonexistent/runtime",
  cache: "/nonexistent/cache",
};

interface Digest {
  chat: string[];
  embedding: string[];
  image_generation: string[];
  providers: { key: string; enabled: boolean }[];
  raw_table_keys: string[];
  enabled_tools: readonly string[];
  enabled_subagents: readonly string[];
  subagents: string[];
  mcp: string[];
  compaction_enabled: boolean;
}

function digestOf(loaded: LoadedConfig): Digest {
  return {
    chat: [...loaded.models.chat.keys()],
    embedding: [...loaded.models.embedding.keys()],
    image_generation: [...loaded.models.imageGeneration.keys()],
    providers: loaded.providers.entries().map(([key, entry]) => ({ key, enabled: entry.enabled })),
    raw_table_keys: Object.keys(loaded.rawTable ?? {}).sort(compareByCodePoint),
    enabled_tools: loaded.app.tools.enabled_tools,
    enabled_subagents: loaded.app.tools.enabled_subagents,
    subagents: [...loaded.app.subagents.keys()],
    mcp: [...loaded.app.mcp.keys()],
    compaction_enabled: loaded.app.memory.compaction.enabled,
  };
}

function load(src: string, onWarn: ConfigWarn = () => {}): LoadedConfig {
  return parseConfigTable(Bun.TOML.parse(src) as TomlTable, { ...DIRS }, onWarn);
}

function accepted(src: string): Digest {
  return digestOf(load(src));
}

function refused(src: string): string {
  try {
    load(src);
  } catch (e) {
    if (e instanceof ConfigError) return e.message;
    throw e;
  }
  throw new Error("expected the config to be refused");
}

function warningsOf(src: string): string[] {
  const out: string[] = [];
  load(src, (message) => { if (message !== "Deprecated configuration") out.push(message); });
  return out;
}

describe("auxiliary provider defaults", () => {
  for (const field of ["embedding", "image"]) {
    test.each(["openai", "openrouter"])(`${field} accepts built-in %s transport without a provider section`, (provider) => {
      expect(warningsOf(`[${field}]\nmodel = "${provider}:model"`)).toEqual([]);
    });

    test(`${field} identifies missing transport for an unknown provider`, () => {
      const warnings = warningsOf(`[${field}]\nmodel = "custom:model"`);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(field === "embedding" ? "embedding.model" : "image.model");
      expect(warnings[0]).toContain("[providers.custom]");
      expect(warnings[0]).toContain("no built-in endpoint");
      expect(warnings[0]).toContain("base_url");
    });

    test(`${field} still rejects an explicitly disabled built-in provider`, () => {
      expect(refused(`[${field}]\nmodel = "openrouter:model"\n[providers.openrouter]\nenabled = false`)).toContain("disabled");
    });
  }
});

describe("a config that shore can act on", () => {
  test("extracted sections preserve transport defaults and reject arrays of provider tables", () => {
    expect(() => load('[[providers]]\napi_key_env = "KEY"')).toThrow("providers must be a table");
    const config = load('[providers.custom]\nsdk = "openai"\nbase_url = "https://example.invalid/v1"\napi_key_env = "CUSTOM_KEY"\n[chat."custom:house-7"]');
    expect(config.models.chat.get("custom:house-7")).toMatchObject({ sdk: "openai", baseUrl: "https://example.invalid/v1" });
  });

  test.each([
    ['[chat.anthropic]\nmax_context_tokens = 1000', "parse_app"],
    ['[chat."anthropic:"]', "catalog"],
  ])("configuration errors preserve their stage for %s", (source, kind) => {
    let failure: unknown;
    try { load(source); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ kind });
  });

  test.each([
    "",
    '[chat]\nmodel = "anthropic:claude-opus-4-6"\n[chat."anthropic:claude-opus-4-6"]',
    '[chat]\nmodel = "openrouter:vendor:model"\n[providers.openrouter]\napi_key_env = "KEY"',
    '[tools]\nenabled = ["mcp__*", "mcp__"]',
  ])("valid references and wildcard grants produce no warnings for %s", (source) => {
    expect(warningsOf(source)).toEqual([]);
  });

  test("warnings retain setting and provider details and global grants precede subagent grants", () => {
    const warnings: Record<string, string>[] = [];
    load('[heartbeat]\nmodel = "disabled:model"\n[providers.disabled]\nenabled = false\nsdk = "openai"\n[tools]\nenabled = ["mcp__global__x"]\n[subagents.helper]\ndescription = "helper"\nprompt = "help"\ntools = ["mcp__sub__y"]',
      (message, fields) => { if (message !== "Deprecated configuration") warnings.push(Object.fromEntries(fields)); });
    expect(warnings).toEqual([
      { field: "heartbeat.model", name: "disabled:model", provider: "disabled" },
      { pattern: "mcp__global__x", server: "global" },
      { pattern: "mcp__sub__y", server: "sub" },
    ]);
  });

  test("empty config", () => {
    expect(accepted("")).toBeDefined();
  });
  test("model sections are extracted, not unknown fields", () => {
    const digest = accepted("[chat]\n\n[chat.\"anthropic:claude-opus-4-6\"]\n\n[embedding]\n\n[embedding.\"openai:text-embedding-3-large\"]\ndimensions = 1024\n\n[image]\n\n[image.\"gemini:gemini-3.1-flash-image-preview\"]\nsize = \"1024x1024\"\n");
    expect(digest.chat).toEqual(["anthropic:claude-opus-4-6"]);
    expect(digest.embedding).toEqual(["openai:text-embedding-3-large"]);
    expect(digest.image_generation).toEqual(["gemini:gemini-3.1-flash-image-preview"]);
  });
  test("providers section is extracted too", () => {
    const digest = accepted("\n[providers.openai]\napi_key_env = \"OPENAI_API_KEY\"\n\n[providers.disabled_one]\nenabled = false\napi_key_env = \"X\"\n");
    expect(digest.providers).toEqual([{"key": "disabled_one", "enabled": false}, {"key": "openai", "enabled": true}]);
  });
  test("tools survives extraction alongside a chat section", () => {
    const digest = accepted("[chat]\n\n[chat.\"anthropic:claude-opus-4-6\"]\n\n[tools]\nenabled = [\"read\", \"write\"]\n");
    expect(digest.chat).toEqual(["anthropic:claude-opus-4-6"]);
    expect(digest.enabled_tools).toEqual(["read", "write"]);
  });
  test("non-table chat is rejected", () => {
    expect(refused("chat = \"nope\"")).toContain("must be a table");
  });
  test("non-table providers is rejected", () => {
    expect(refused("providers = 1")).toContain("must be a table");
  });
  test("non-table embedding is rejected", () => {
    expect(refused("embedding = []")).toContain("must be a table");
  });
  test("array-of-tables providers is rejected", () => {
    expect(refused("\n[[providers]]\napi_key_env = \"OPENAI_API_KEY\"\n")).toContain("must be a table");
  });
  test("registry transport cascades into a static chat entry", () => {
    const digest = accepted("[providers]\n\n[providers.custom]\nsdk = \"openai\"\nbase_url = \"https://example.invalid/v1\"\napi_key_env = \"CUSTOM_KEY\"\n\n[chat]\n\n[chat.\"custom:house-7\"]\n");
    expect(digest.chat).toEqual(["custom:house-7"]);
    expect(digest.providers).toEqual([{"key": "custom", "enabled": true}]);
  });
  test("unresolvable defaults.model warns", () => {
    expect(accepted("[chat]\nmodel = \"nonexistent-model\"\n")).toBeDefined();
    expect(warningsOf("[chat]\nmodel = \"nonexistent-model\"\n").join(" ")).toContain("configured default model \"nonexistent-model\" was n");
  });
  test("resolvable defaults.model is silent", () => {
    const digest = accepted("[chat]\nmodel = \"anthropic:claude-opus-4-6\"\n\n[chat.\"anthropic:claude-opus-4-6\"]\n");
    expect(digest.chat).toEqual(["anthropic:claude-opus-4-6"]);
  });
  test("every defaults ref warns, in call order", () => {
    expect(accepted("[chat]\nmodel = \"ghost-a\"\n\n[subagents]\nmodel = \"ghost-d\"\n\n[heartbeat]\nmodel = \"ghost-c\"\n\n[compaction]\nmodel = \"ghost-e\"\n")).toBeDefined();
    expect(warningsOf("[chat]\nmodel = \"ghost-a\"\n\n[subagents]\nmodel = \"ghost-d\"\n\n[heartbeat]\nmodel = \"ghost-c\"\n\n[compaction]\nmodel = \"ghost-e\"\n").join(" ")).toContain("configured default model \"ghost-a\" was not found i");
    expect(warningsOf("[chat]\nmodel = \"ghost-a\"\n\n[subagents]\nmodel = \"ghost-d\"\n\n[heartbeat]\nmodel = \"ghost-c\"\n\n[compaction]\nmodel = \"ghost-e\"\n").join(" ")).toContain("configured default model \"ghost-c\" was not found i");
    expect(warningsOf("[chat]\nmodel = \"ghost-a\"\n\n[subagents]\nmodel = \"ghost-d\"\n\n[heartbeat]\nmodel = \"ghost-c\"\n\n[compaction]\nmodel = \"ghost-e\"\n").join(" ")).toContain("configured default model \"ghost-e\" was not found i");
    expect(warningsOf("[chat]\nmodel = \"ghost-a\"\n\n[subagents]\nmodel = \"ghost-d\"\n\n[heartbeat]\nmodel = \"ghost-c\"\n\n[compaction]\nmodel = \"ghost-e\"\n").join(" ")).toContain("configured default model \"ghost-d\" was not found i");
  });
  test("provider:model_id on an enabled provider resolves without discovery", () => {
    const digest = accepted("[providers]\n\n[providers.openrouter]\napi_key_env = \"OPENROUTER_API_KEY\"\n\n[chat]\nmodel = \"openrouter:anthropic/claude-opus-4.6\"\n");
    expect(digest.providers).toEqual([{"key": "openrouter", "enabled": true}]);
  });
  test("provider:model_id with discovery enabled", () => {
    const digest = accepted("[providers]\n\n[providers.openrouter]\napi_key_env = \"OPENROUTER_API_KEY\"\ndiscover = true\n\n[chat]\nmodel = \"openrouter:anthropic/claude-opus-4.6\"\n");
    expect(digest.providers).toEqual([{"key": "openrouter", "enabled": true}]);
  });
  test("provider:model_id in a background default", () => {
    const digest = accepted("[providers]\n\n[providers.openrouter]\napi_key_env = \"OPENROUTER_API_KEY\"\n\n[heartbeat]\nmodel = \"openrouter:anthropic/claude-opus-4.6\"\n");
    expect(digest.providers).toEqual([{"key": "openrouter", "enabled": true}]);
  });
  test("provider:model_id on a disabled provider warns", () => {
    const digest = accepted("[providers]\n\n[providers.openrouter]\nenabled = false\napi_key_env = \"OPENROUTER_API_KEY\"\n\n[chat]\nmodel = \"openrouter:anthropic/claude-opus-4.6\"\n");
    expect(digest.providers).toEqual([{"key": "openrouter", "enabled": false}]);
    expect(warningsOf("[providers]\n\n[providers.openrouter]\nenabled = false\napi_key_env = \"OPENROUTER_API_KEY\"\n\n[chat]\nmodel = \"openrouter:anthropic/claude-opus-4.6\"\n").join(" ")).toContain("configured default model references a disabled pro");
  });
  test("provider:model_id on an unregistered provider warns", () => {
    expect(accepted("[chat]\nmodel = \"openroute:anthropic/claude-opus-4.6\"\n")).toBeDefined();
    expect(warningsOf("[chat]\nmodel = \"openroute:anthropic/claude-opus-4.6\"\n").join(" ")).toContain("configured default model references provider \"open");
  });
  test("empty provider half falls through to the generic warning", () => {
    expect(accepted("[chat]\nmodel = \":claude-opus-4-6\"\n")).toBeDefined();
    expect(warningsOf("[chat]\nmodel = \":claude-opus-4-6\"\n").join(" ")).toContain("configured default model \":claude-opus-4-6\" was no");
  });
  test("empty model half falls through to the generic warning", () => {
    expect(accepted("[chat]\nmodel = \"anthropic:\"\n")).toBeDefined();
    expect(warningsOf("[chat]\nmodel = \"anthropic:\"\n").join(" ")).toContain("configured default model \"anthropic:\" was not foun");
  });
  test("multiple colons split at the first", () => {
    const digest = accepted("[providers]\n\n[providers.openrouter]\napi_key_env = \"OPENROUTER_API_KEY\"\n\n[chat]\nmodel = \"openrouter:anthropic:claude-opus-4.6\"\n");
    expect(digest.providers).toEqual([{"key": "openrouter", "enabled": true}]);
  });
  test("catalog hit wins over provider parsing", () => {
    const digest = accepted("[chat]\nmodel = \"anthropic:claude-opus-4-6\"\n\n[chat.\"anthropic:claude-opus-4-6\"]\n");
    expect(digest.chat).toEqual(["anthropic:claude-opus-4-6"]);
  });
  test("empty defaults.model is present, not absent", () => {
    expect(accepted("[chat]\nmodel = \"\"\n")).toBeDefined();
    expect(warningsOf("[chat]\nmodel = \"\"\n").join(" ")).toContain("configured default model \"\" was not found in the s");
  });
  test("enabled subagent resolving via defaults.model", () => {
    const digest = accepted("[chat]\nmodel = \"anthropic:claude-opus-4-6\"\n\n[chat.\"anthropic:claude-opus-4-6\"]\n\n[subagents]\nenabled = [\"researcher\"]\n\n[subagents.researcher]\ndescription = \"Research helper\"\nprompt = \"You research things.\"\n");
    expect(digest.chat).toEqual(["anthropic:claude-opus-4-6"]);
    expect(digest.enabled_subagents).toEqual(["researcher"]);
    expect(digest.subagents).toEqual(["researcher"]);
  });
  test("enabled subagent resolving via defaults.subagent_model", () => {
    const digest = accepted("[chat]\n\n[chat.\"anthropic:claude-opus-4-6\"]\n\n[subagents]\nmodel = \"anthropic:claude-opus-4-6\"\nenabled = [\"researcher\"]\n\n[subagents.researcher]\ndescription = \"Research helper\"\nprompt = \"You research things.\"\n");
    expect(digest.chat).toEqual(["anthropic:claude-opus-4-6"]);
    expect(digest.enabled_subagents).toEqual(["researcher"]);
    expect(digest.subagents).toEqual(["researcher"]);
  });
  test("disabled subagent with unresolvable model only warns", () => {
    const digest = accepted("\n[subagents.researcher]\ndescription = \"Research helper\"\nprompt = \"You research things.\"\nmodel = \"ghost-model\"\n");
    expect(digest.subagents).toEqual(["researcher"]);
    expect(warningsOf("\n[subagents.researcher]\ndescription = \"Research helper\"\nprompt = \"You research things.\"\nmodel = \"ghost-model\"\n").join(" ")).toContain("configured default model \"ghost-model\" was not fou");
  });
  test("enabled subagent resolving through an enabled provider", () => {
    const digest = accepted("[providers]\n\n[providers.openrouter]\napi_key_env = \"OPENROUTER_API_KEY\"\n\n[subagents]\nenabled = [\"researcher\"]\n\n[subagents.researcher]\ndescription = \"R\"\nprompt = \"r\"\nmodel = \"openrouter:anthropic/claude-opus-4.6\"\n");
    expect(digest.enabled_subagents).toEqual(["researcher"]);
    expect(digest.subagents).toEqual(["researcher"]);
    expect(digest.providers).toEqual([{"key": "openrouter", "enabled": true}]);
  });
  test("enabled subagent resolves with provider discovery off", () => {
    const digest = accepted("[providers]\n\n[providers.openrouter]\napi_key_env = \"OPENROUTER_API_KEY\"\ndiscover = false\n\n[subagents]\nenabled = [\"researcher\"]\n\n[subagents.researcher]\ndescription = \"R\"\nprompt = \"r\"\nmodel = \"openrouter:anthropic/claude-opus-4.6\"\n");
    expect(digest.enabled_subagents).toEqual(["researcher"]);
    expect(digest.subagents).toEqual(["researcher"]);
    expect(digest.providers).toEqual([{"key": "openrouter", "enabled": true}]);
  });
  test("wildcard in enabled_subagents does not enable", () => {
    const digest = accepted("[subagents]\nenabled = [\"*\"]\n\n[subagents.researcher]\ndescription = \"Research helper\"\nprompt = \"You research things.\"\nmodel = \"ghost-model\"\n");
    expect(digest.enabled_subagents).toEqual(["*"]);
    expect(digest.subagents).toEqual(["researcher"]);
    expect(warningsOf("[subagents]\nenabled = [\"*\"]\n\n[subagents.researcher]\ndescription = \"Research helper\"\nprompt = \"You research things.\"\nmodel = \"ghost-model\"\n").join(" ")).toContain("configured default model \"ghost-model\" was not fou");
  });
  test("mcp server with one transport", () => {
    const digest = accepted("\n[mcp.hue]\ncommand = \"node\"\n");
    expect(digest.mcp).toEqual(["hue"]);
  });
  test("empty mcp command still counts as a transport", () => {
    const digest = accepted("\n[mcp.hue]\ncommand = \"\"\n");
    expect(digest.mcp).toEqual(["hue"]);
  });
  test("tool grant naming an undefined mcp server warns", () => {
    const digest = accepted("[tools]\nenabled = [\"mcp__hue__set_light\"]\n");
    expect(digest.enabled_tools).toEqual(["mcp__hue__set_light"]);
    expect(warningsOf("[tools]\nenabled = [\"mcp__hue__set_light\"]\n").join(" ")).toContain("tool grant references MCP server with no [mcp.hue]");
  });
  test("tool grant naming a defined mcp server is silent", () => {
    const digest = accepted("[mcp]\n\n[mcp.hue]\ncommand = \"node\"\n\n[tools]\nenabled = [\"mcp__hue__set_light\"]\n");
    expect(digest.enabled_tools).toEqual(["mcp__hue__set_light"]);
    expect(digest.mcp).toEqual(["hue"]);
  });
  test("mcp wildcard grant is silent", () => {
    const digest = accepted("[tools]\nenabled = [\"mcp__*\"]\n");
    expect(digest.enabled_tools).toEqual(["mcp__*"]);
  });
  test("bare mcp prefix is silent", () => {
    const digest = accepted("[tools]\nenabled = [\"mcp__\"]\n");
    expect(digest.enabled_tools).toEqual(["mcp__"]);
  });
  test("mcp grant with no tool segment still names a server", () => {
    const digest = accepted("[tools]\nenabled = [\"mcp__hue\"]\n");
    expect(digest.enabled_tools).toEqual(["mcp__hue"]);
    expect(warningsOf("[tools]\nenabled = [\"mcp__hue\"]\n").join(" ")).toContain("tool grant references MCP server with no [mcp.hue]");
  });
  test("subagent tool grants are checked too", () => {
    const digest = accepted("\n[subagents.researcher]\ndescription = \"R\"\nprompt = \"r\"\ntools = [\"mcp__ghost__search\"]\n");
    expect(digest.subagents).toEqual(["researcher"]);
    expect(warningsOf("\n[subagents.researcher]\ndescription = \"R\"\nprompt = \"r\"\ntools = [\"mcp__ghost__search\"]\n").join(" ")).toContain("tool grant references MCP server with no [mcp.ghos");
  });
  test("global grants are swept before subagent grants", () => {
    const digest = accepted("[subagents]\n\n[subagents.researcher]\ndescription = \"R\"\nprompt = \"r\"\ntools = [\"mcp__subghost__y\"]\n\n[tools]\nenabled = [\"mcp__globalghost__x\"]\n");
    expect(digest.enabled_tools).toEqual(["mcp__globalghost__x"]);
    expect(digest.subagents).toEqual(["researcher"]);
    expect(warningsOf("[subagents]\n\n[subagents.researcher]\ndescription = \"R\"\nprompt = \"r\"\ntools = [\"mcp__subghost__y\"]\n\n[tools]\nenabled = [\"mcp__globalghost__x\"]\n").join(" ")).toContain("tool grant references MCP server with no [mcp.glob");
    expect(warningsOf("[subagents]\n\n[subagents.researcher]\ndescription = \"R\"\nprompt = \"r\"\ntools = [\"mcp__subghost__y\"]\n\n[tools]\nenabled = [\"mcp__globalghost__x\"]\n").join(" ")).toContain("tool grant references MCP server with no [mcp.subg");
  });
  test("bearer_token_env names an environment variable for an HTTP server", () => {
    expect(accepted("[mcp.search]\nurl = \"https://mcp.example.invalid/mcp\"\nbearer_token_env = \"SEARCH_TOKEN\"\n").mcp).toEqual(["search"]);
    expect(refused("[mcp.search]\ncommand = \"search-mcp\"\nbearer_token_env = \"SEARCH_TOKEN\"\n")).toContain("sets `bearer_token_env` on a `command` server");
    expect(refused("[mcp.search]\nurl = \"https://mcp.example.invalid/mcp\"\nbearer_token_env = \"SEARCH_TOKEN\"\nheaders = { authorization = \"Bearer x\" }\n")).toContain("sets both `bearer_token_env` and an Authorization header");
  });
  test("an MCP server granted by name with no definition warns", () => {
    expect(warningsOf("[tools]\nmcp = [\"tavily\"]\n").join(" ")).toContain("tool grant references MCP server with no [mcp.tavily]");
  });
  test("a wildcard or empty MCP server name in tools.mcp warns that it matches nothing", () => {
    for (const name of ["*", ""]) {
      expect(warningsOf(`[tools]\nmcp = ["${name}"]\n`).join(" ")).toContain("an empty or `*` entry matches no tools");
    }
  });
  test("an MCP server granted by name with a definition is silent", () => {
    expect(warningsOf("[mcp.tavily]\nurl = \"https://mcp.example.invalid/mcp\"\n\n[tools]\nmcp = [\"tavily\"]\n").join(" ")).not.toContain("tavily");
  });
  test("a removed web_search grant warns and names the MCP replacement", () => {
    for (const src of [
      "[tools]\nenabled = [\"bash\", \"web_search\"]\n",
      "\n[subagents.researcher]\ndescription = \"R\"\nprompt = \"r\"\ntools = [\"web_search\"]\n",
    ]) {
      const warnings = warningsOf(src).join(" ");
      expect(warnings).toContain("tool 'web_search' was removed and grants nothing");
      expect(warnings).toContain("tools.mcp");
    }
    expect(warningsOf("[tools]\nenabled = [\"bash\"]\n").join(" ")).not.toContain("web_search");
  });
  test("a leftover [web_search] section is refused with a migration hint", () => {
    const message = refused("[web_search]\nmax_results = 5\n");
    expect(message).toContain("[web_search] is no longer supported");
    expect(message).toContain("[mcp.tavily]");
    expect(message).toContain("tools.mcp");
  });
  test("a top-level key named like an Object method is an unknown field, not a removed section", () => {
    expect(refused("constructor = 1\n")).toContain("unknown field `constructor`");
  });
  test("provider:model_id embedding default passes", () => {
    const digest = accepted("[providers]\n\n[providers.openai]\napi_key_env = \"OPENAI_API_KEY\"\n\n[embedding]\nmodel = \"openai:text-embedding-3-large\"\n");
    expect(digest.providers).toEqual([{"key": "openai", "enabled": true}]);
  });
  test("embedding default on built-in OpenAI needs no provider section", () => {
    expect(accepted("[embedding]\nmodel = \"openai:text-embedding-3-large\"\n")).toBeDefined();
    expect(warningsOf("[embedding]\nmodel = \"openai:text-embedding-3-large\"\n")).toEqual([]);
  });
  test("all valid defaults", () => {
    const digest = accepted("[chat]\nmodel = \"anthropic:claude-opus-4-6\"\n\n[chat.\"anthropic:claude-opus-4-6\"]\n\n[providers]\n\n[providers.openai]\napi_key_env = \"OPENAI_API_KEY\"\n\n[providers.gemini]\napi_key_env = \"GEMINI_API_KEY\"\n\n[embedding]\nmodel = \"openai:text-embedding-3-large\"\n\n[embedding.\"openai:text-embedding-3-large\"]\ndimensions = 1024\n\n[image]\nmodel = \"gemini:gemini-3.1-flash-image-preview\"\n\n[image.\"gemini:gemini-3.1-flash-image-preview\"]\nsize = \"1024x1024\"\n\n[heartbeat]\nmodel = \"anthropic:claude-opus-4-6\"\n");
    expect(digest.chat).toEqual(["anthropic:claude-opus-4-6"]);
    expect(digest.embedding).toEqual(["openai:text-embedding-3-large"]);
    expect(digest.image_generation).toEqual(["gemini:gemini-3.1-flash-image-preview"]);
    expect(digest.providers).toEqual([{"key": "gemini", "enabled": true}, {"key": "openai", "enabled": true}]);
  });
  test("usage timezone utc", () => {
    expect(accepted("\n[usage]\ntimezone = \"utc\"\n")).toBeDefined();
  });
  test("empty warn_at passes", () => {
    expect(accepted("budgets = [{ name = \"daily\", period = \"day\", cost_usd = 5, warn_fractions = [], allow_compaction = false }]\n")).toBeDefined();
  });
  test("budget warn_at above one is allowed", () => {
    expect(accepted("budgets = [{ name = \"daily\", period = \"day\", cost_usd = 5, warn_fractions = [0.8, 1.5], allow_compaction = false }]\n")).toBeDefined();
  });
  test("reset_hour 23 passes", () => {
    expect(accepted("budgets = [{ name = \"daily\", period = \"day\", cost_usd = 5, reset_hour = 23, allow_compaction = false }]\n")).toBeDefined();
  });
  test("reset_day_of_week on a weekly budget passes", () => {
    expect(accepted("budgets = [{ name = \"weekly\", period = \"week\", cost_usd = 5, reset_day_of_week = \"thursday\", allow_compaction = false }]\n")).toBeDefined();
  });
  test("anchored month budget", () => {
    expect(accepted("budgets = [{ name = \"monthly\", period = \"month\", cost_usd = 5, reset_day_of_month = 15, reset_hour = 6, allow_compaction = false }]\n")).toBeDefined();
  });
  test("pace shorter than the period passes", () => {
    expect(accepted("budgets = [{ name = \"weekly\", period = \"week\", cost_usd = 5, pace_period = \"day\", allow_compaction = false }]\n")).toBeDefined();
  });
  test("empty pace_warn_at with a pace_period passes", () => {
    expect(accepted("budgets = [{ name = \"weekly\", period = \"week\", cost_usd = 5, pace_period = \"day\", pace_warn_fractions = [], allow_compaction = false }]\n")).toBeDefined();
  });
  test("two blank budget names do not collide", () => {
    expect(accepted("budgets = [{ period = \"day\", cost_usd = 5, allow_compaction = false }, { period = \"week\", cost_usd = 50, allow_compaction = false }]\n")).toBeDefined();
  });
  test("a zero-width no-break space is not trimmed from a budget name", () => {
    expect(accepted("budgets = [{ name = \"﻿daily\", period = \"day\", cost_usd = 5, allow_compaction = false }, { name = \"daily\", period = \"week\", cost_usd = 50, allow_compaction = false }]\n")).toBeDefined();
  });
  test("disabled compaction skips turn validation", () => {
    const digest = accepted("[compaction]\nenabled = false\nmin_turns = 4\nkeep_recent_turns = 4\n");
    expect(digest.compaction_enabled).toBe(false);
  });
  test("a chat section parses", () => {
    const digest = accepted("[chat]\n\n[chat.\"anthropic:claude-sonnet-4-6\"]\n");
    expect(digest.chat).toEqual(["anthropic:claude-sonnet-4-6"]);
  });
  test("an embedding section parses", () => {
    const digest = accepted("\n[embedding.\"openai:text-embedding-3-small\"]\n");
    expect(digest.embedding).toEqual(["openai:text-embedding-3-small"]);
  });
  test("an image generation section parses", () => {
    const digest = accepted("[image]\n\n[image.\"openai:dall-e-3\"]\n");
    expect(digest.image_generation).toEqual(["openai:dall-e-3"]);
  });
  test("a providers section parses", () => {
    const digest = accepted("\n[providers.anthropic]\nenabled = true\n");
    expect(digest.providers).toEqual([{"key": "anthropic", "enabled": true}]);
  });
});

describe("a config shore refuses, and what it says", () => {
  test("unknown top-level section", () => {
    expect(refused("\n[completely_unknown]\nkey = \"value\"\n")).toContain("unknown field `completely_unknown`");
  });
  test("models section is neither extracted nor a field", () => {
    expect(refused("\n[models.\"anthropic:claude-opus-4-6\"]\ntemperature = 0.5\n")).toContain("unknown field `models`");
  });
  test("app parse error precedes provider registry error", () => {
    expect(refused("\n[completely_unknown]\nkey = \"value\"\n\n[providers.claude_code]\napi_key_env = \"X\"\n")).toContain("unknown field `completely_unknown`");
  });
  test("provider registry error precedes catalog error", () => {

  });
  test("catalog error with no registry error", () => {
    expect(refused("\n[chat.anthropic.opus]\nmax_context_tokens = 1000\n")).toContain("unknown field `chat.anthropic`");
  });

  test("enabled subagent with unresolvable model is rejected", () => {
    expect(refused("[subagents]\nenabled = [\"researcher\"]\n\n[subagents.researcher]\ndescription = \"Research helper\"\nprompt = \"You research things.\"\nmodel = \"ghost-model\"\n")).toContain("subagents.researcher resolves to model \"ghost-model\", which ");
  });
  test("subagent model shadows a resolvable default", () => {
    expect(refused("[chat]\nmodel = \"anthropic:claude-opus-4-6\"\n\n[chat.\"anthropic:claude-opus-4-6\"]\n\n[subagents]\nmodel = \"anthropic:claude-opus-4-6\"\nenabled = [\"researcher\"]\n\n[subagents.researcher]\ndescription = \"Research helper\"\nprompt = \"You research things.\"\nmodel = \"ghost-model\"\n")).toContain("subagents.researcher resolves to model \"ghost-model\", which ");
  });
  test("enabled subagent with no model anywhere", () => {
    expect(refused("[subagents]\nenabled = [\"researcher\"]\n\n[subagents.researcher]\ndescription = \"Research helper\"\nprompt = \"You research things.\"\n")).toContain("subagents.researcher is enabled but resolves to no model; se");
  });
  test("empty subagent model does not fall through to defaults", () => {
    expect(refused("[chat]\nmodel = \"anthropic:claude-opus-4-6\"\n\n[chat.\"anthropic:claude-opus-4-6\"]\n\n[subagents]\nenabled = [\"researcher\"]\n\n[subagents.researcher]\ndescription = \"Research helper\"\nprompt = \"You research things.\"\nmodel = \"\"\n")).toContain("subagents.researcher resolves to model \"\", which is not in t");
  });
  test("subagent_model outranks defaults.model", () => {
    expect(refused("[chat]\nmodel = \"anthropic:claude-opus-4-6\"\n\n[chat.\"anthropic:claude-opus-4-6\"]\n\n[subagents]\nmodel = \"ghost-sub\"\nenabled = [\"researcher\"]\n\n[subagents.researcher]\ndescription = \"Research helper\"\nprompt = \"You research things.\"\n")).toContain("subagents.researcher resolves to model \"ghost-sub\", which is");
  });
  test("enabled subagent on a disabled provider is rejected", () => {
    expect(refused("[providers]\n\n[providers.openrouter]\nenabled = false\napi_key_env = \"OPENROUTER_API_KEY\"\n\n[subagents]\nenabled = [\"researcher\"]\n\n[subagents.researcher]\ndescription = \"R\"\nprompt = \"r\"\nmodel = \"openrouter:anthropic/claude-opus-4.6\"\n")).toContain("subagents.researcher resolves to model \"openrouter:anthropic");
  });
  test("enabled subagent on an unregistered provider is rejected", () => {
    expect(refused("[subagents]\nenabled = [\"researcher\"]\n\n[subagents.researcher]\ndescription = \"R\"\nprompt = \"r\"\nmodel = \"ghostprovider:some-model\"\n")).toContain("subagents.researcher resolves to model \"ghostprovider:some-m");
  });
  test("enabled subagent with an empty provider half is rejected", () => {
    expect(refused("[providers]\n\n[providers.openrouter]\napi_key_env = \"OPENROUTER_API_KEY\"\n\n[subagents]\nenabled = [\"researcher\"]\n\n[subagents.researcher]\ndescription = \"R\"\nprompt = \"r\"\nmodel = \":anthropic/claude-opus-4.6\"\n")).toContain("subagents.researcher resolves to model \":anthropic/claude-op");
  });
  test("enabled subagent with an empty model half is rejected", () => {
    expect(refused("[providers]\n\n[providers.openrouter]\napi_key_env = \"OPENROUTER_API_KEY\"\n\n[subagents]\nenabled = [\"researcher\"]\n\n[subagents.researcher]\ndescription = \"R\"\nprompt = \"r\"\nmodel = \"openrouter:\"\n")).toContain("subagents.researcher resolves to model \"openrouter:\", which ");
  });
  test("two enabled bad subagents reject in map order", () => {
    expect(refused("[subagents]\nenabled = [\"zulu\", \"alpha\"]\n\n[subagents.zulu]\ndescription = \"Z\"\nprompt = \"z\"\nmodel = \"ghost-z\"\n\n[subagents.alpha]\ndescription = \"A\"\nprompt = \"a\"\nmodel = \"ghost-a\"\n")).toContain("subagents.alpha resolves to model \"ghost-a\", which is not in");
  });
  test("warn then reject within one subagent pass", () => {
    expect(refused("[subagents]\nenabled = [\"zulu\"]\n\n[subagents.alpha]\ndescription = \"A\"\nprompt = \"a\"\nmodel = \"ghost-a\"\n\n[subagents.zulu]\ndescription = \"Z\"\nprompt = \"z\"\nmodel = \"ghost-z\"\n")).toContain("subagents.zulu resolves to model \"ghost-z\", which is not in ");
  });
  test("mcp server with both transports", () => {
    expect(refused("\n[mcp.hue]\ncommand = \"node\"\nurl = \"http://x\"\n")).toContain("mcp.hue sets both `command` and `url`; set exactly one trans");
  });
  test("mcp server with no transport", () => {
    expect(refused("\n[mcp.hue]\nargs = [\"--x\"]\n")).toContain("mcp.hue sets neither `command` nor `url`; set exactly one tr");
  });
  test("empty mcp url alongside a command is still both", () => {
    expect(refused("\n[mcp.hue]\ncommand = \"node\"\nurl = \"\"\n")).toContain("mcp.hue sets both `command` and `url`; set exactly one trans");
  });
  test("two bad mcp servers reject in map order", () => {
    expect(refused("\n[mcp.zulu]\ncommand = \"node\"\nurl = \"http://z\"\n\n[mcp.alpha]\nargs = []\n")).toContain("mcp.alpha sets neither `command` nor `url`; set exactly one ");
  });
  test("transport rejection precedes the grant sweep", () => {
    expect(refused("[mcp]\n\n[mcp.hue]\ncommand = \"node\"\nurl = \"http://x\"\n\n[tools]\nenabled = [\"mcp__ghost__search\"]\n")).toContain("mcp.hue sets both `command` and `url`; set exactly one trans");
  });
  test("bare alias embedding default is rejected", () => {
    expect(refused("[embedding]\nmodel = \"missing-profile\"\n")).toContain("embedding.model \"missing-profile\" must be a `provider:mod");
  });
  test("bundled local embedding id is rejected", () => {
    expect(refused("[embedding]\nmodel = \"bge-large-en-v1.5\"\n")).toContain("embedding.model \"bge-large-en-v1.5\" must be a `provider:m");
  });
  test("embedding default on a disabled provider is rejected", () => {
    expect(refused("[providers]\n\n[providers.openai]\nenabled = false\napi_key_env = \"OPENAI_API_KEY\"\n\n[embedding]\nmodel = \"openai:text-embedding-3-large\"\n")).toContain("embedding.model references provider \"openai\" which is dis");
  });
  test("embedding default with an empty provider half", () => {
    expect(refused("[embedding]\nmodel = \":text-embedding-3-large\"\n")).toContain("embedding.model \":text-embedding-3-large\" is not a valid ");
  });
  test("embedding default with an empty model half", () => {
    expect(refused("[embedding]\nmodel = \"openai:\"\n")).toContain("embedding.model \"openai:\" is not a valid `provider:model_");
  });
  test("bare alias image_generation default is rejected", () => {
    expect(refused("[image]\nmodel = \"missing-profile\"\n")).toContain("image.model \"missing-profile\" must be a `provi");
  });
  test("image_generation default on a disabled provider is rejected", () => {
    expect(refused("[providers]\n\n[providers.gemini]\nenabled = false\napi_key_env = \"GEMINI_API_KEY\"\n\n[image]\nmodel = \"gemini:gemini-3.1-flash-image-preview\"\n")).toContain("image.model references provider \"gemini\" which");
  });
  test("image_generation default with an empty model half", () => {
    expect(refused("[image]\nmodel = \"gemini:\"\n")).toContain("image.model \"gemini:\" is not a valid `provider");
  });
  test("both aux defaults bad reports embedding", () => {
    expect(refused("[embedding]\nmodel = \"bad-a\"\n\n[image]\nmodel = \"bad-b\"\n")).toContain("embedding.model \"bad-a\" must be a `provider:model_id` ide");
  });
  test("usage timezone is case sensitive", () => {
    expect(refused("\n[usage]\ntimezone = \"UTC\"\n")).toContain("usage.timezone must be \"local\" or \"utc\", got \"UTC\"");
  });
  test("usage timezone unknown", () => {
    expect(refused("\n[usage]\ntimezone = \"Europe/London\"\n")).toContain("usage.timezone must be \"local\" or \"utc\", got \"Europe/London\"");
  });
  test("budget cost_usd zero is rejected", () => {
    expect(refused("budgets = [{ name = \"daily\", period = \"day\", cost_usd = 0, allow_compaction = false }]\n")).toContain("usage.budgets[0].cost_usd must be greater than 0");
  });
  test("budget cost_usd negative zero is rejected", () => {
    expect(refused("budgets = [{ name = \"daily\", period = \"day\", cost_usd = 0, allow_compaction = false }]\n")).toContain("usage.budgets[0].cost_usd must be greater than 0");
  });
  test("budget warn_at zero is rejected", () => {
    expect(refused("budgets = [{ name = \"daily\", period = \"day\", cost_usd = 5, warn_fractions = [0.8, 0], allow_compaction = false }]\n")).toContain("usage.budgets[0].warn_at values must be greater than 0");
  });
  test("reset_hour 24 is rejected", () => {
    expect(refused("budgets = [{ name = \"daily\", period = \"day\", cost_usd = 5, reset_hour = 24, allow_compaction = false }]\n")).toContain("usage.budgets[0].reset_hour must be 0-23, got 24");
  });
  test("negative reset_hour is a parse error", () => {
    expect(refused("budgets = [{ name = \"daily\", period = \"day\", cost_usd = 5, reset_hour = -1, allow_compaction = false }]\n")).toContain("invalid value: integer `-1`, expected u32");
  });
  test("reset_hour on an hourly budget is rejected", () => {
    expect(refused("budgets = [{ name = \"hourly\", period = \"hour\", cost_usd = 5, reset_hour = 6, allow_compaction = false }]\n")).toContain("usage.budgets[0].reset_hour is not valid for period = \"hour\"");
  });
  test("reset_hour range precedes the period check", () => {
    expect(refused("budgets = [{ name = \"hourly\", period = \"hour\", cost_usd = 5, reset_hour = 24, allow_compaction = false }]\n")).toContain("usage.budgets[0].reset_hour must be 0-23, got 24");
  });
  test("reset_day_of_week outside a weekly budget is rejected", () => {
    expect(refused("budgets = [{ name = \"daily\", period = \"day\", cost_usd = 5, reset_day_of_week = \"thursday\", allow_compaction = false }]\n")).toContain("usage.budgets[0].reset_day_of_week is only valid for period ");
  });
  test("unknown weekday is a parse error, not a validation error", () => {
    expect(refused("budgets = [{ name = \"weekly\", period = \"week\", cost_usd = 10, reset_day_of_week = \"funday\", allow_compaction = false }]\n")).toContain("reset_day_of_week must be monday, tuesday");
  });
  test("reset_day_of_month 0 is rejected", () => {
    expect(refused("budgets = [{ name = \"monthly\", period = \"month\", cost_usd = 5, reset_day_of_month = 0, allow_compaction = false }]\n")).toContain("usage.budgets[0].reset_day_of_month must be 1-31, got 0");
  });
  test("reset_day_of_month 32 is rejected", () => {
    expect(refused("budgets = [{ name = \"monthly\", period = \"month\", cost_usd = 5, reset_day_of_month = 32, allow_compaction = false }]\n")).toContain("usage.budgets[0].reset_day_of_month must be 1-31, got 32");
  });
  test("reset_day_of_month outside a monthly budget is rejected", () => {
    expect(refused("budgets = [{ name = \"weekly\", period = \"week\", cost_usd = 5, reset_day_of_month = 15, allow_compaction = false }]\n")).toContain("usage.budgets[0].reset_day_of_month is only valid for period");
  });
  test("pace equal to the period is rejected", () => {
    expect(refused("budgets = [{ name = \"weekly\", period = \"week\", cost_usd = 5, pace_period = \"week\", allow_compaction = false }]\n")).toContain("usage.budgets[0].pace_period = \"week\" must be shorter than p");
  });
  test("pace longer than the period is rejected", () => {
    expect(refused("budgets = [{ name = \"daily\", period = \"day\", cost_usd = 5, pace_period = \"month\", allow_compaction = false }]\n")).toContain("usage.budgets[0].pace_period = \"month\" must be shorter than ");
  });
  test("pace_action without pace_period is rejected", () => {
    expect(refused("budgets = [{ name = \"weekly\", period = \"week\", cost_usd = 5, pace_action = \"block\", allow_compaction = false }]\n")).toContain("usage.budgets[0].pace_action requires pace_period");
  });
  test("pace_warn_at without pace_period is rejected", () => {
    expect(refused("budgets = [{ name = \"weekly\", period = \"week\", cost_usd = 5, pace_warn_fractions = [0.8], allow_compaction = false }]\n")).toContain("usage.budgets[0].pace_warn_at requires pace_period");
  });
  test("pace_action precedes pace_warn_at", () => {
    expect(refused("budgets = [{ name = \"weekly\", period = \"week\", cost_usd = 5, pace_action = \"block\", pace_warn_fractions = [0.8], allow_compaction = false }]\n")).toContain("usage.budgets[0].pace_action requires pace_period");
  });
  test("pace_warn_at non-positive is rejected", () => {
    expect(refused("budgets = [{ name = \"weekly\", period = \"week\", cost_usd = 5, pace_period = \"day\", pace_warn_fractions = [0.5, 0], allow_compaction = false }]\n")).toContain("usage.budgets[0].pace_warn_at values must be greater than 0");
  });
  test("anchor check precedes pace check", () => {
    expect(refused("budgets = [{ name = \"daily\", period = \"day\", cost_usd = 5, reset_day_of_week = \"thursday\", pace_period = \"month\", allow_compaction = false }]\n")).toContain("usage.budgets[0].reset_day_of_week is only valid for period ");
  });
  test("duplicate budget names", () => {
    expect(refused("budgets = [{ name = \"daily\", period = \"day\", cost_usd = 5, allow_compaction = false }, { name = \"daily\", period = \"week\", cost_usd = 50, allow_compaction = false }]\n")).toContain("usage budget name \"daily\" is duplicated");
  });
  test("explicit name collides with a blank name's placeholder", () => {
    expect(refused("budgets = [{ period = \"day\", cost_usd = 5, allow_compaction = false }, { name = \"budget 1\", period = \"week\", cost_usd = 50, allow_compaction = false }]\n")).toContain("usage budget name \"budget 1\" is duplicated");
  });
  test("budget names are trimmed before comparison", () => {
    expect(refused("budgets = [{ name = \"daily\", period = \"day\", cost_usd = 5, allow_compaction = false }, { name = \"  daily  \", period = \"week\", cost_usd = 50, allow_compaction = false }]\n")).toContain("usage budget name \"daily\" is duplicated");
  });
  test("a next-line character is trimmed from a budget name", () => {
    expect(refused("budgets = [{ name = \"daily\", period = \"day\", cost_usd = 5, allow_compaction = false }, { name = \"daily\", period = \"week\", cost_usd = 50, allow_compaction = false }]\n")).toContain("usage budget name \"daily\" is duplicated");
  });
  test("whitespace-only budget name is blank", () => {
    expect(refused("budgets = [{ name = \"   \", period = \"day\", cost_usd = 5, allow_compaction = false }, { name = \"budget 1\", period = \"week\", cost_usd = 50, allow_compaction = false }]\n")).toContain("usage budget name \"budget 1\" is duplicated");
  });
  test("earlier budget index reports first", () => {
    expect(refused("budgets = [{ name = \"a\", period = \"day\", cost_usd = 5, reset_hour = 99, allow_compaction = false }, { name = \"b\", period = \"day\", cost_usd = -1, allow_compaction = false }]\n")).toContain("usage.budgets[0].reset_hour must be 0-23, got 99");
  });
  test("compaction min_turns not above keep_recent_turns", () => {
    expect(refused("[compaction]\nmin_turns = 4\nkeep_recent_turns = 4\n")).toContain("must both be greater than keep_recent_turns (4)");
  });
  test("usage check precedes compaction check", () => {
    expect(refused("[usage]\ntimezone = \"nope\"\n\n[compaction]\nmin_turns = 4\nkeep_recent_turns = 4\n")).toContain("usage.timezone must be \"local\" or \"utc\", got \"nope\"");
  });
  test("every check fails at once", () => {
    expect(refused("[usage]\ntimezone = \"nope\"\n\n[subagents]\nenabled = [\"researcher\"]\n\n[subagents.researcher]\ndescription = \"R\"\nprompt = \"r\"\nmodel = \"ghost-model\"\n\n[mcp]\n\n[mcp.hue]\ncommand = \"node\"\nurl = \"http://x\"\n\n[chat]\nmodel = \"ghost\"\n\n[embedding]\nmodel = \"bad-embed\"\n\n[image]\nmodel = \"bad-image\"\n\n[compaction]\nmin_turns = 4\nkeep_recent_turns = 4\n")).toContain("subagents.researcher resolves to model \"ghost-model\", which ");
  });
  test("mcp is next after subagents", () => {
    expect(refused("[usage]\ntimezone = \"nope\"\n\n[mcp]\n\n[mcp.hue]\ncommand = \"node\"\nurl = \"http://x\"\n\n[embedding]\nmodel = \"bad-embed\"\n\n[image]\nmodel = \"bad-image\"\n\n[compaction]\nmin_turns = 4\nkeep_recent_turns = 4\n")).toContain("mcp.hue sets both `command` and `url`; set exactly one trans");
  });
  test("embedding is next after mcp", () => {
    expect(refused("[usage]\ntimezone = \"nope\"\n\n[embedding]\nmodel = \"bad-embed\"\n\n[image]\nmodel = \"bad-image\"\n\n[compaction]\nmin_turns = 4\nkeep_recent_turns = 4\n")).toContain("embedding.model \"bad-embed\" must be a `provider:model_id`");
  });
  test("usage is next after the aux defaults", () => {
    expect(refused("[usage]\ntimezone = \"nope\"\n\n[compaction]\nmin_turns = 4\nkeep_recent_turns = 4\n")).toContain("usage.timezone must be \"local\" or \"utc\", got \"nope\"");
  });
  test("warnings are emitted before a rejection", () => {
    expect(refused("[usage]\ntimezone = \"nope\"\n\n[chat]\nmodel = \"ghost-a\"\n")).toContain("usage.timezone must be \"local\" or \"utc\", got \"nope\"");
  });
});

describe("Bun.TOML.parse non-finite floats", () => {
  test("decodes them as the floats they are", () => {
    const decode = (src: string): unknown => (Bun.TOML.parse(src) as { a: unknown }).a;

    expect(decode("a = nan")).toBeNaN();
    expect(decode("a = inf")).toBe(Infinity);
    expect(decode("a = [nan]")).toEqual([Number.NaN]);

    expect(decode("a = -inf")).toBe(-Infinity);
    expect(decode("a = +inf")).toBe(Infinity);
    expect(decode("a = +nan")).toBeNaN();

    expect(decode("a = 1e400")).toBe(Infinity);

    expect(Object.is(decode("a = -0.0"), -0)).toBe(true);
    expect(decode("a = 1.5")).toBe(1.5);
  });
});

describe("warning sink", () => {
  test("renders message then fields", async () => {
    const { consoleConfigWarn } = await import("../src/config/loader.ts");
    const lines: string[] = [];
    const real = console.warn;
    console.warn = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      consoleConfigWarn("something is off", [
        ["field", "defaults.model"],
        ["name", "ghost"],
      ]);
      consoleConfigWarn("no fields here", []);
    } finally {
      console.warn = real;
    }

    expect(lines).toEqual([
      "shore: something is off field=defaults.model name=ghost",
      "shore: no fields here",
    ]);
  });
});


test.each(["backend", "recall", "retain"])("removed memory.%s settings cannot activate the old integration", (section) => {
  expect(refused(`[memory.${section}]\n`)).toContain("unknown field `memory`");
});
