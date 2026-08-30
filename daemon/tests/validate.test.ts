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
  load(src, (message) => out.push(message));
  return out;
}

describe("a config that shore can act on", () => {
  test("empty config", () => {
    expect(accepted("")).toBeDefined();
  });
  test("model sections are extracted, not unknown fields", () => {
    const digest = accepted("\n[chat.anthropic.opus]\nmodel_id = \"claude-opus-4-6\"\n\n[embedding.\"openai:text-embedding-3-large\"]\ndimensions = 1024\n\n[image_generation.\"gemini:gemini-3.1-flash-image-preview\"]\nsize = \"1024x1024\"\n");
    expect(digest.chat).toEqual(["chat.anthropic.opus"]);
    expect(digest.embedding).toEqual(["openai:text-embedding-3-large"]);
    expect(digest.image_generation).toEqual(["gemini:gemini-3.1-flash-image-preview"]);
  });
  test("providers section is extracted too", () => {
    const digest = accepted("\n[providers.openai]\napi_key_env = \"OPENAI_API_KEY\"\n\n[providers.disabled_one]\nenabled = false\napi_key_env = \"X\"\n");
    expect(digest.providers).toEqual([{"key": "disabled_one", "enabled": false}, {"key": "openai", "enabled": true}]);
  });
  test("tools survives extraction alongside a chat section", () => {
    const digest = accepted("\n[tools]\nenabled_tools = [\"read\", \"write\"]\n\n[chat.anthropic.opus]\nmodel_id = \"claude-opus-4-6\"\n");
    expect(digest.chat).toEqual(["chat.anthropic.opus"]);
    expect(digest.enabled_tools).toEqual(["read", "write"]);
  });
  test("non-table chat is removed and ignored", () => {
    expect(accepted("chat = \"nope\"")).toBeDefined();
  });
  test("non-table providers is removed and ignored", () => {
    expect(accepted("providers = 1")).toBeDefined();
  });
  test("non-table embedding is removed and ignored", () => {
    expect(accepted("embedding = []")).toBeDefined();
  });
  test("array-of-tables providers silently yields an empty registry", () => {
    expect(accepted("\n[[providers]]\napi_key_env = \"OPENAI_API_KEY\"\n")).toBeDefined();
  });
  test("registry transport cascades into a static chat entry", () => {
    const digest = accepted("\n[providers.custom]\nsdk = \"openai\"\nbase_url = \"https://example.invalid/v1\"\napi_key_env = \"CUSTOM_KEY\"\n\n[chat.custom.house]\nmodel_id = \"house-7\"\n");
    expect(digest.chat).toEqual(["chat.custom.house"]);
    expect(digest.providers).toEqual([{"key": "custom", "enabled": true}]);
  });
  test("unresolvable defaults.model warns", () => {
    expect(accepted("\n[defaults]\nmodel = \"nonexistent-model\"\n")).toBeDefined();
    expect(warningsOf("\n[defaults]\nmodel = \"nonexistent-model\"\n").join(" ")).toContain("configured default model \"nonexistent-model\" was n");
  });
  test("resolvable defaults.model is silent", () => {
    const digest = accepted("\n[defaults]\nmodel = \"opus\"\n\n[chat.anthropic.opus]\nmodel_id = \"claude-opus-4-6\"\n");
    expect(digest.chat).toEqual(["chat.anthropic.opus"]);
  });
  test("every defaults ref warns, in call order", () => {
    expect(accepted("\n[defaults]\nmodel = \"ghost-a\"\nsubagent_model = \"ghost-d\"\n\n[defaults.background]\nmodel = \"ghost-b\"\nheartbeat = \"ghost-c\"\ncompaction = \"ghost-e\"\n")).toBeDefined();
    expect(warningsOf("\n[defaults]\nmodel = \"ghost-a\"\nsubagent_model = \"ghost-d\"\n\n[defaults.background]\nmodel = \"ghost-b\"\nheartbeat = \"ghost-c\"\ncompaction = \"ghost-e\"\n").join(" ")).toContain("configured default model \"ghost-a\" was not found i");
    expect(warningsOf("\n[defaults]\nmodel = \"ghost-a\"\nsubagent_model = \"ghost-d\"\n\n[defaults.background]\nmodel = \"ghost-b\"\nheartbeat = \"ghost-c\"\ncompaction = \"ghost-e\"\n").join(" ")).toContain("configured default model \"ghost-b\" was not found i");
    expect(warningsOf("\n[defaults]\nmodel = \"ghost-a\"\nsubagent_model = \"ghost-d\"\n\n[defaults.background]\nmodel = \"ghost-b\"\nheartbeat = \"ghost-c\"\ncompaction = \"ghost-e\"\n").join(" ")).toContain("configured default model \"ghost-c\" was not found i");
    expect(warningsOf("\n[defaults]\nmodel = \"ghost-a\"\nsubagent_model = \"ghost-d\"\n\n[defaults.background]\nmodel = \"ghost-b\"\nheartbeat = \"ghost-c\"\ncompaction = \"ghost-e\"\n").join(" ")).toContain("configured default model \"ghost-e\" was not found i");
    expect(warningsOf("\n[defaults]\nmodel = \"ghost-a\"\nsubagent_model = \"ghost-d\"\n\n[defaults.background]\nmodel = \"ghost-b\"\nheartbeat = \"ghost-c\"\ncompaction = \"ghost-e\"\n").join(" ")).toContain("configured default model \"ghost-d\" was not found i");
  });
  test("provider:model_id on an enabled provider resolves without discovery", () => {
    const digest = accepted("\n[defaults]\nmodel = \"openrouter:anthropic/claude-opus-4.6\"\n\n[providers.openrouter]\napi_key_env = \"OPENROUTER_API_KEY\"\n");
    expect(digest.providers).toEqual([{"key": "openrouter", "enabled": true}]);
  });
  test("provider:model_id with discovery enabled", () => {
    const digest = accepted("\n[defaults]\nmodel = \"openrouter:anthropic/claude-opus-4.6\"\n\n[providers.openrouter]\napi_key_env = \"OPENROUTER_API_KEY\"\n\n[providers.openrouter.discovery]\nenabled = true\n");
    expect(digest.providers).toEqual([{"key": "openrouter", "enabled": true}]);
  });
  test("provider:model_id in a background default", () => {
    const digest = accepted("\n[defaults.background]\nheartbeat = \"openrouter:anthropic/claude-opus-4.6\"\n\n[providers.openrouter]\napi_key_env = \"OPENROUTER_API_KEY\"\n");
    expect(digest.providers).toEqual([{"key": "openrouter", "enabled": true}]);
  });
  test("provider:model_id on a disabled provider warns", () => {
    const digest = accepted("\n[defaults]\nmodel = \"openrouter:anthropic/claude-opus-4.6\"\n\n[providers.openrouter]\nenabled = false\napi_key_env = \"OPENROUTER_API_KEY\"\n");
    expect(digest.providers).toEqual([{"key": "openrouter", "enabled": false}]);
    expect(warningsOf("\n[defaults]\nmodel = \"openrouter:anthropic/claude-opus-4.6\"\n\n[providers.openrouter]\nenabled = false\napi_key_env = \"OPENROUTER_API_KEY\"\n").join(" ")).toContain("configured default model references a disabled pro");
  });
  test("provider:model_id on an unregistered provider warns", () => {
    expect(accepted("\n[defaults]\nmodel = \"openroute:anthropic/claude-opus-4.6\"\n")).toBeDefined();
    expect(warningsOf("\n[defaults]\nmodel = \"openroute:anthropic/claude-opus-4.6\"\n").join(" ")).toContain("configured default model references provider \"open");
  });
  test("empty provider half falls through to the generic warning", () => {
    expect(accepted("\n[defaults]\nmodel = \":claude-opus-4-6\"\n")).toBeDefined();
    expect(warningsOf("\n[defaults]\nmodel = \":claude-opus-4-6\"\n").join(" ")).toContain("configured default model \":claude-opus-4-6\" was no");
  });
  test("empty model half falls through to the generic warning", () => {
    expect(accepted("\n[defaults]\nmodel = \"anthropic:\"\n")).toBeDefined();
    expect(warningsOf("\n[defaults]\nmodel = \"anthropic:\"\n").join(" ")).toContain("configured default model \"anthropic:\" was not foun");
  });
  test("multiple colons split at the first", () => {
    const digest = accepted("\n[defaults]\nmodel = \"openrouter:anthropic:claude-opus-4.6\"\n\n[providers.openrouter]\napi_key_env = \"OPENROUTER_API_KEY\"\n");
    expect(digest.providers).toEqual([{"key": "openrouter", "enabled": true}]);
  });
  test("catalog hit wins over provider parsing", () => {
    const digest = accepted("\n[defaults]\nmodel = \"chat.anthropic.opus\"\n\n[chat.anthropic.opus]\nmodel_id = \"claude-opus-4-6\"\n");
    expect(digest.chat).toEqual(["chat.anthropic.opus"]);
  });
  test("empty defaults.model is present, not absent", () => {
    expect(accepted("\n[defaults]\nmodel = \"\"\n")).toBeDefined();
    expect(warningsOf("\n[defaults]\nmodel = \"\"\n").join(" ")).toContain("configured default model \"\" was not found in the s");
  });
  test("enabled subagent resolving via defaults.model", () => {
    const digest = accepted("\n[defaults]\nmodel = \"opus\"\n\n[chat.anthropic.opus]\nmodel_id = \"claude-opus-4-6\"\n\n[tools]\nenabled_subagents = [\"researcher\"]\n\n[subagents.researcher]\ndescription = \"Research helper\"\nprompt = \"You research things.\"\n");
    expect(digest.chat).toEqual(["chat.anthropic.opus"]);
    expect(digest.enabled_subagents).toEqual(["researcher"]);
    expect(digest.subagents).toEqual(["researcher"]);
  });
  test("enabled subagent resolving via defaults.subagent_model", () => {
    const digest = accepted("\n[defaults]\nsubagent_model = \"opus\"\n\n[chat.anthropic.opus]\nmodel_id = \"claude-opus-4-6\"\n\n[tools]\nenabled_subagents = [\"researcher\"]\n\n[subagents.researcher]\ndescription = \"Research helper\"\nprompt = \"You research things.\"\n");
    expect(digest.chat).toEqual(["chat.anthropic.opus"]);
    expect(digest.enabled_subagents).toEqual(["researcher"]);
    expect(digest.subagents).toEqual(["researcher"]);
  });
  test("disabled subagent with unresolvable model only warns", () => {
    const digest = accepted("\n[subagents.researcher]\ndescription = \"Research helper\"\nprompt = \"You research things.\"\nmodel = \"ghost-model\"\n");
    expect(digest.subagents).toEqual(["researcher"]);
    expect(warningsOf("\n[subagents.researcher]\ndescription = \"Research helper\"\nprompt = \"You research things.\"\nmodel = \"ghost-model\"\n").join(" ")).toContain("configured default model \"ghost-model\" was not fou");
  });
  test("enabled subagent resolving through an enabled provider", () => {
    const digest = accepted("\n[providers.openrouter]\napi_key_env = \"OPENROUTER_API_KEY\"\n\n[tools]\nenabled_subagents = [\"researcher\"]\n\n[subagents.researcher]\ndescription = \"R\"\nprompt = \"r\"\nmodel = \"openrouter:anthropic/claude-opus-4.6\"\n");
    expect(digest.enabled_subagents).toEqual(["researcher"]);
    expect(digest.subagents).toEqual(["researcher"]);
    expect(digest.providers).toEqual([{"key": "openrouter", "enabled": true}]);
  });
  test("enabled subagent resolves with provider discovery off", () => {
    const digest = accepted("\n[providers.openrouter]\napi_key_env = \"OPENROUTER_API_KEY\"\n\n[providers.openrouter.discovery]\nenabled = false\n\n[tools]\nenabled_subagents = [\"researcher\"]\n\n[subagents.researcher]\ndescription = \"R\"\nprompt = \"r\"\nmodel = \"openrouter:anthropic/claude-opus-4.6\"\n");
    expect(digest.enabled_subagents).toEqual(["researcher"]);
    expect(digest.subagents).toEqual(["researcher"]);
    expect(digest.providers).toEqual([{"key": "openrouter", "enabled": true}]);
  });
  test("wildcard in enabled_subagents does not enable", () => {
    const digest = accepted("\n[tools]\nenabled_subagents = [\"*\"]\n\n[subagents.researcher]\ndescription = \"Research helper\"\nprompt = \"You research things.\"\nmodel = \"ghost-model\"\n");
    expect(digest.enabled_subagents).toEqual(["*"]);
    expect(digest.subagents).toEqual(["researcher"]);
    expect(warningsOf("\n[tools]\nenabled_subagents = [\"*\"]\n\n[subagents.researcher]\ndescription = \"Research helper\"\nprompt = \"You research things.\"\nmodel = \"ghost-model\"\n").join(" ")).toContain("configured default model \"ghost-model\" was not fou");
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
    const digest = accepted("\n[tools]\nenabled_tools = [\"mcp__hue__set_light\"]\n");
    expect(digest.enabled_tools).toEqual(["mcp__hue__set_light"]);
    expect(warningsOf("\n[tools]\nenabled_tools = [\"mcp__hue__set_light\"]\n").join(" ")).toContain("tool grant references MCP server with no [mcp.hue]");
  });
  test("tool grant naming a defined mcp server is silent", () => {
    const digest = accepted("\n[tools]\nenabled_tools = [\"mcp__hue__set_light\"]\n\n[mcp.hue]\ncommand = \"node\"\n");
    expect(digest.enabled_tools).toEqual(["mcp__hue__set_light"]);
    expect(digest.mcp).toEqual(["hue"]);
  });
  test("mcp wildcard grant is silent", () => {
    const digest = accepted("\n[tools]\nenabled_tools = [\"mcp__*\"]\n");
    expect(digest.enabled_tools).toEqual(["mcp__*"]);
  });
  test("bare mcp prefix is silent", () => {
    const digest = accepted("\n[tools]\nenabled_tools = [\"mcp__\"]\n");
    expect(digest.enabled_tools).toEqual(["mcp__"]);
  });
  test("mcp grant with no tool segment still names a server", () => {
    const digest = accepted("\n[tools]\nenabled_tools = [\"mcp__hue\"]\n");
    expect(digest.enabled_tools).toEqual(["mcp__hue"]);
    expect(warningsOf("\n[tools]\nenabled_tools = [\"mcp__hue\"]\n").join(" ")).toContain("tool grant references MCP server with no [mcp.hue]");
  });
  test("subagent tool grants are checked too", () => {
    const digest = accepted("\n[subagents.researcher]\ndescription = \"R\"\nprompt = \"r\"\ntools = [\"mcp__ghost__search\"]\n");
    expect(digest.subagents).toEqual(["researcher"]);
    expect(warningsOf("\n[subagents.researcher]\ndescription = \"R\"\nprompt = \"r\"\ntools = [\"mcp__ghost__search\"]\n").join(" ")).toContain("tool grant references MCP server with no [mcp.ghos");
  });
  test("global grants are swept before subagent grants", () => {
    const digest = accepted("\n[tools]\nenabled_tools = [\"mcp__globalghost__x\"]\n\n[subagents.researcher]\ndescription = \"R\"\nprompt = \"r\"\ntools = [\"mcp__subghost__y\"]\n");
    expect(digest.enabled_tools).toEqual(["mcp__globalghost__x"]);
    expect(digest.subagents).toEqual(["researcher"]);
    expect(warningsOf("\n[tools]\nenabled_tools = [\"mcp__globalghost__x\"]\n\n[subagents.researcher]\ndescription = \"R\"\nprompt = \"r\"\ntools = [\"mcp__subghost__y\"]\n").join(" ")).toContain("tool grant references MCP server with no [mcp.glob");
    expect(warningsOf("\n[tools]\nenabled_tools = [\"mcp__globalghost__x\"]\n\n[subagents.researcher]\ndescription = \"R\"\nprompt = \"r\"\ntools = [\"mcp__subghost__y\"]\n").join(" ")).toContain("tool grant references MCP server with no [mcp.subg");
  });
  test("provider:model_id embedding default passes", () => {
    const digest = accepted("\n[defaults]\nembedding = \"openai:text-embedding-3-large\"\n\n[providers.openai]\napi_key_env = \"OPENAI_API_KEY\"\n");
    expect(digest.providers).toEqual([{"key": "openai", "enabled": true}]);
  });
  test("embedding default on an unregistered provider only warns", () => {
    expect(accepted("\n[defaults]\nembedding = \"openai:text-embedding-3-large\"\n")).toBeDefined();
    expect(warningsOf("\n[defaults]\nembedding = \"openai:text-embedding-3-large\"\n").join(" ")).toContain("defaults.embedding references provider \"openai\" no");
  });
  test("all valid defaults", () => {
    const digest = accepted("\n[defaults]\nmodel = \"opus\"\nembedding = \"openai:text-embedding-3-large\"\nimage_generation = \"gemini:gemini-3.1-flash-image-preview\"\n\n[defaults.background]\nheartbeat = \"opus\"\n\n[chat.anthropic.opus]\nmodel_id = \"claude-opus-4-6\"\n\n[providers.openai]\napi_key_env = \"OPENAI_API_KEY\"\n\n[providers.gemini]\napi_key_env = \"GEMINI_API_KEY\"\n\n[embedding.\"openai:text-embedding-3-large\"]\ndimensions = 1024\n\n[image_generation.\"gemini:gemini-3.1-flash-image-preview\"]\nsize = \"1024x1024\"\n");
    expect(digest.chat).toEqual(["chat.anthropic.opus"]);
    expect(digest.embedding).toEqual(["openai:text-embedding-3-large"]);
    expect(digest.image_generation).toEqual(["gemini:gemini-3.1-flash-image-preview"]);
    expect(digest.providers).toEqual([{"key": "gemini", "enabled": true}, {"key": "openai", "enabled": true}]);
  });
  test("usage timezone utc", () => {
    expect(accepted("\n[usage]\ntimezone = \"utc\"\n")).toBeDefined();
  });
  test("empty warn_at passes", () => {
    expect(accepted("\n[[usage.budgets]]\nname = \"daily\"\nperiod = \"day\"\ncost_usd = 5.0\nwarn_at = []\n")).toBeDefined();
  });
  test("budget warn_at above one is allowed", () => {
    expect(accepted("\n[[usage.budgets]]\nname = \"daily\"\nperiod = \"day\"\ncost_usd = 5.0\nwarn_at = [0.8, 1.5]\n")).toBeDefined();
  });
  test("reset_hour 23 passes", () => {
    expect(accepted("\n[[usage.budgets]]\nname = \"daily\"\nperiod = \"day\"\ncost_usd = 5.0\nreset_hour = 23\n")).toBeDefined();
  });
  test("reset_day_of_week on a weekly budget passes", () => {
    expect(accepted("\n[[usage.budgets]]\nname = \"weekly\"\nperiod = \"week\"\ncost_usd = 5.0\nreset_day_of_week = \"thursday\"\n")).toBeDefined();
  });
  test("anchored month budget", () => {
    expect(accepted("\n[[usage.budgets]]\nname = \"monthly\"\nperiod = \"month\"\ncost_usd = 5.0\nreset_day_of_month = 15\nreset_hour = 6\n")).toBeDefined();
  });
  test("pace shorter than the period passes", () => {
    expect(accepted("\n[[usage.budgets]]\nname = \"weekly\"\nperiod = \"week\"\ncost_usd = 5.0\npace_period = \"day\"\n")).toBeDefined();
  });
  test("empty pace_warn_at with a pace_period passes", () => {
    expect(accepted("\n[[usage.budgets]]\nname = \"weekly\"\nperiod = \"week\"\ncost_usd = 5.0\npace_period = \"day\"\npace_warn_at = []\n")).toBeDefined();
  });
  test("two blank budget names do not collide", () => {
    expect(accepted("\n[[usage.budgets]]\nperiod = \"day\"\ncost_usd = 5.0\n\n[[usage.budgets]]\nperiod = \"week\"\ncost_usd = 50.0\n")).toBeDefined();
  });
  test("a zero-width no-break space is not trimmed from a budget name", () => {
    expect(accepted("\n[[usage.budgets]]\nname = \"\\uFEFFdaily\"\nperiod = \"day\"\ncost_usd = 5.0\n\n[[usage.budgets]]\nname = \"daily\"\nperiod = \"week\"\ncost_usd = 50.0\n")).toBeDefined();
  });
  test("disabled compaction skips turn validation", () => {
    const digest = accepted("\n[memory.compaction]\nenabled = false\nmin_turns = 4\nkeep_recent_turns = 4\n");
    expect(digest.compaction_enabled).toBe(false);
  });
  test("a chat section parses", () => {
    const digest = accepted("\n[chat.anthropic.sonnet]\nmodel_id = \"claude-sonnet-4-6\"\n");
    expect(digest.chat).toEqual(["chat.anthropic.sonnet"]);
  });
  test("an embedding section parses", () => {
    const digest = accepted("\n[embedding.\"openai:text-embedding-3-small\"]\n");
    expect(digest.embedding).toEqual(["openai:text-embedding-3-small"]);
  });
  test("an image generation section parses", () => {
    const digest = accepted("\n[image_generation.\"openai:dall-e-3\"]\n");
    expect(digest.image_generation).toEqual(["openai:dall-e-3"]);
  });
  test("a providers section parses", () => {
    const digest = accepted("\n[providers.anthropic]\nenabled = true\n");
    expect(digest.providers).toEqual([{"key": "anthropic", "enabled": true}]);
  });
});

describe("a config shore refuses, and what it says", () => {
  test("unknown top-level section", () => {
    expect(refused("\n[completely_unknown]\nkey = \"value\"\n")).toContain("unknown field `completely_unknown`, expected one of `daemon`");
  });
  test("models section is neither extracted nor a field", () => {
    expect(refused("\n[models.\"anthropic:claude-opus-4-6\"]\ntemperature = 0.5\n")).toContain("unknown field `models`, expected one of `daemon`, `defaults`");
  });
  test("app parse error precedes provider registry error", () => {
    expect(refused("\n[completely_unknown]\nkey = \"value\"\n\n[providers.claude_code]\napi_key_env = \"X\"\n")).toContain("unknown field `completely_unknown`, expected one of `daemon`");
  });
  test("provider registry error precedes catalog error", () => {
    expect(refused("\n[providers.claude_code]\napi_key_env = \"X\"\n\n[chat.claude_code.opus]\nmodel_id = \"x\"\n")).toContain("[providers.claude_code] is no longer supported — the Claude ");
  });
  test("catalog error with no registry error", () => {
    expect(refused("\n[chat.anthropic.opus]\nmax_context_tokens = 1000\n")).toContain("model \"opus\" in [chat.anthropic] is missing required field `");
  });
  test("the retired defaults.heartbeat is refused with a pointer", () => {
    expect(refused("\n[defaults]\nheartbeat = \"ghost-haiku\"\n\n[chat.anthropic.opus]\nmodel_id = \"claude-opus-4-6\"\n")).toContain("`heartbeat` was removed — set it under `[defaults.background");
  });
  test("enabled subagent with unresolvable model is rejected", () => {
    expect(refused("\n[tools]\nenabled_subagents = [\"researcher\"]\n\n[subagents.researcher]\ndescription = \"Research helper\"\nprompt = \"You research things.\"\nmodel = \"ghost-model\"\n")).toContain("subagents.researcher resolves to model \"ghost-model\", which ");
  });
  test("subagent model shadows a resolvable default", () => {
    expect(refused("\n[defaults]\nmodel = \"opus\"\nsubagent_model = \"opus\"\n\n[chat.anthropic.opus]\nmodel_id = \"claude-opus-4-6\"\n\n[tools]\nenabled_subagents = [\"researcher\"]\n\n[subagents.researcher]\ndescription = \"Research helper\"\nprompt = \"You research things.\"\nmodel = \"ghost-model\"\n")).toContain("subagents.researcher resolves to model \"ghost-model\", which ");
  });
  test("enabled subagent with no model anywhere", () => {
    expect(refused("\n[tools]\nenabled_subagents = [\"researcher\"]\n\n[subagents.researcher]\ndescription = \"Research helper\"\nprompt = \"You research things.\"\n")).toContain("subagents.researcher is enabled but resolves to no model; se");
  });
  test("empty subagent model does not fall through to defaults", () => {
    expect(refused("\n[defaults]\nmodel = \"opus\"\n\n[chat.anthropic.opus]\nmodel_id = \"claude-opus-4-6\"\n\n[tools]\nenabled_subagents = [\"researcher\"]\n\n[subagents.researcher]\ndescription = \"Research helper\"\nprompt = \"You research things.\"\nmodel = \"\"\n")).toContain("subagents.researcher resolves to model \"\", which is not in t");
  });
  test("subagent_model outranks defaults.model", () => {
    expect(refused("\n[defaults]\nmodel = \"opus\"\nsubagent_model = \"ghost-sub\"\n\n[chat.anthropic.opus]\nmodel_id = \"claude-opus-4-6\"\n\n[tools]\nenabled_subagents = [\"researcher\"]\n\n[subagents.researcher]\ndescription = \"Research helper\"\nprompt = \"You research things.\"\n")).toContain("subagents.researcher resolves to model \"ghost-sub\", which is");
  });
  test("enabled subagent on a disabled provider is rejected", () => {
    expect(refused("\n[providers.openrouter]\nenabled = false\napi_key_env = \"OPENROUTER_API_KEY\"\n\n[tools]\nenabled_subagents = [\"researcher\"]\n\n[subagents.researcher]\ndescription = \"R\"\nprompt = \"r\"\nmodel = \"openrouter:anthropic/claude-opus-4.6\"\n")).toContain("subagents.researcher resolves to model \"openrouter:anthropic");
  });
  test("enabled subagent on an unregistered provider is rejected", () => {
    expect(refused("\n[tools]\nenabled_subagents = [\"researcher\"]\n\n[subagents.researcher]\ndescription = \"R\"\nprompt = \"r\"\nmodel = \"ghostprovider:some-model\"\n")).toContain("subagents.researcher resolves to model \"ghostprovider:some-m");
  });
  test("enabled subagent with an empty provider half is rejected", () => {
    expect(refused("\n[providers.openrouter]\napi_key_env = \"OPENROUTER_API_KEY\"\n\n[tools]\nenabled_subagents = [\"researcher\"]\n\n[subagents.researcher]\ndescription = \"R\"\nprompt = \"r\"\nmodel = \":anthropic/claude-opus-4.6\"\n")).toContain("subagents.researcher resolves to model \":anthropic/claude-op");
  });
  test("enabled subagent with an empty model half is rejected", () => {
    expect(refused("\n[providers.openrouter]\napi_key_env = \"OPENROUTER_API_KEY\"\n\n[tools]\nenabled_subagents = [\"researcher\"]\n\n[subagents.researcher]\ndescription = \"R\"\nprompt = \"r\"\nmodel = \"openrouter:\"\n")).toContain("subagents.researcher resolves to model \"openrouter:\", which ");
  });
  test("two enabled bad subagents reject in map order", () => {
    expect(refused("\n[tools]\nenabled_subagents = [\"zulu\", \"alpha\"]\n\n[subagents.zulu]\ndescription = \"Z\"\nprompt = \"z\"\nmodel = \"ghost-z\"\n\n[subagents.alpha]\ndescription = \"A\"\nprompt = \"a\"\nmodel = \"ghost-a\"\n")).toContain("subagents.alpha resolves to model \"ghost-a\", which is not in");
  });
  test("warn then reject within one subagent pass", () => {
    expect(refused("\n[tools]\nenabled_subagents = [\"zulu\"]\n\n[subagents.alpha]\ndescription = \"A\"\nprompt = \"a\"\nmodel = \"ghost-a\"\n\n[subagents.zulu]\ndescription = \"Z\"\nprompt = \"z\"\nmodel = \"ghost-z\"\n")).toContain("subagents.zulu resolves to model \"ghost-z\", which is not in ");
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
    expect(refused("\n[tools]\nenabled_tools = [\"mcp__ghost__search\"]\n\n[mcp.hue]\ncommand = \"node\"\nurl = \"http://x\"\n")).toContain("mcp.hue sets both `command` and `url`; set exactly one trans");
  });
  test("bare alias embedding default is rejected", () => {
    expect(refused("\n[defaults]\nembedding = \"missing-profile\"\n")).toContain("defaults.embedding \"missing-profile\" must be a `provider:mod");
  });
  test("bundled local embedding id is rejected", () => {
    expect(refused("\n[defaults]\nembedding = \"bge-large-en-v1.5\"\n")).toContain("defaults.embedding \"bge-large-en-v1.5\" must be a `provider:m");
  });
  test("embedding default on a disabled provider is rejected", () => {
    expect(refused("\n[defaults]\nembedding = \"openai:text-embedding-3-large\"\n\n[providers.openai]\nenabled = false\napi_key_env = \"OPENAI_API_KEY\"\n")).toContain("defaults.embedding references provider \"openai\" which is dis");
  });
  test("embedding default with an empty provider half", () => {
    expect(refused("\n[defaults]\nembedding = \":text-embedding-3-large\"\n")).toContain("defaults.embedding \":text-embedding-3-large\" is not a valid ");
  });
  test("embedding default with an empty model half", () => {
    expect(refused("\n[defaults]\nembedding = \"openai:\"\n")).toContain("defaults.embedding \"openai:\" is not a valid `provider:model_");
  });
  test("bare alias image_generation default is rejected", () => {
    expect(refused("\n[defaults]\nimage_generation = \"missing-profile\"\n")).toContain("defaults.image_generation \"missing-profile\" must be a `provi");
  });
  test("image_generation default on a disabled provider is rejected", () => {
    expect(refused("\n[defaults]\nimage_generation = \"gemini:gemini-3.1-flash-image-preview\"\n\n[providers.gemini]\nenabled = false\napi_key_env = \"GEMINI_API_KEY\"\n")).toContain("defaults.image_generation references provider \"gemini\" which");
  });
  test("image_generation default with an empty model half", () => {
    expect(refused("\n[defaults]\nimage_generation = \"gemini:\"\n")).toContain("defaults.image_generation \"gemini:\" is not a valid `provider");
  });
  test("both aux defaults bad reports embedding", () => {
    expect(refused("\n[defaults]\nembedding = \"bad-a\"\nimage_generation = \"bad-b\"\n")).toContain("defaults.embedding \"bad-a\" must be a `provider:model_id` ide");
  });
  test("usage timezone is case sensitive", () => {
    expect(refused("\n[usage]\ntimezone = \"UTC\"\n")).toContain("usage.timezone must be \"local\" or \"utc\", got \"UTC\"");
  });
  test("usage timezone unknown", () => {
    expect(refused("\n[usage]\ntimezone = \"Europe/London\"\n")).toContain("usage.timezone must be \"local\" or \"utc\", got \"Europe/London\"");
  });
  test("budget cost_usd zero is rejected", () => {
    expect(refused("\n[[usage.budgets]]\nname = \"daily\"\nperiod = \"day\"\ncost_usd = 0.0\n")).toContain("usage.budgets[0].cost_usd must be greater than 0");
  });
  test("budget cost_usd negative zero is rejected", () => {
    expect(refused("\n[[usage.budgets]]\nname = \"daily\"\nperiod = \"day\"\ncost_usd = -0.0\n")).toContain("usage.budgets[0].cost_usd must be greater than 0");
  });
  test("budget warn_at zero is rejected", () => {
    expect(refused("\n[[usage.budgets]]\nname = \"daily\"\nperiod = \"day\"\ncost_usd = 5.0\nwarn_at = [0.8, 0.0]\n")).toContain("usage.budgets[0].warn_at values must be greater than 0");
  });
  test("reset_hour 24 is rejected", () => {
    expect(refused("\n[[usage.budgets]]\nname = \"daily\"\nperiod = \"day\"\ncost_usd = 5.0\nreset_hour = 24\n")).toContain("usage.budgets[0].reset_hour must be 0-23, got 24");
  });
  test("negative reset_hour is a parse error", () => {
    expect(refused("\n[[usage.budgets]]\nname = \"daily\"\nperiod = \"day\"\ncost_usd = 5.0\nreset_hour = -1\n")).toContain("invalid value: integer `-1`, expected u32");
  });
  test("reset_hour on an hourly budget is rejected", () => {
    expect(refused("\n[[usage.budgets]]\nname = \"hourly\"\nperiod = \"hour\"\ncost_usd = 5.0\nreset_hour = 6\n")).toContain("usage.budgets[0].reset_hour is not valid for period = \"hour\"");
  });
  test("reset_hour range precedes the period check", () => {
    expect(refused("\n[[usage.budgets]]\nname = \"hourly\"\nperiod = \"hour\"\ncost_usd = 5.0\nreset_hour = 24\n")).toContain("usage.budgets[0].reset_hour must be 0-23, got 24");
  });
  test("reset_day_of_week outside a weekly budget is rejected", () => {
    expect(refused("\n[[usage.budgets]]\nname = \"daily\"\nperiod = \"day\"\ncost_usd = 5.0\nreset_day_of_week = \"thursday\"\n")).toContain("usage.budgets[0].reset_day_of_week is only valid for period ");
  });
  test("unknown weekday is a parse error, not a validation error", () => {
    expect(refused("\n[[usage.budgets]]\nname = \"weekly\"\nperiod = \"week\"\ncost_usd = 10.0\nreset_day_of_week = \"funday\"\n")).toContain("unknown variant `funday`, expected one of `monday`, `tuesday");
  });
  test("reset_day_of_month 0 is rejected", () => {
    expect(refused("\n[[usage.budgets]]\nname = \"monthly\"\nperiod = \"month\"\ncost_usd = 5.0\nreset_day_of_month = 0\n")).toContain("usage.budgets[0].reset_day_of_month must be 1-31, got 0");
  });
  test("reset_day_of_month 32 is rejected", () => {
    expect(refused("\n[[usage.budgets]]\nname = \"monthly\"\nperiod = \"month\"\ncost_usd = 5.0\nreset_day_of_month = 32\n")).toContain("usage.budgets[0].reset_day_of_month must be 1-31, got 32");
  });
  test("reset_day_of_month outside a monthly budget is rejected", () => {
    expect(refused("\n[[usage.budgets]]\nname = \"weekly\"\nperiod = \"week\"\ncost_usd = 5.0\nreset_day_of_month = 15\n")).toContain("usage.budgets[0].reset_day_of_month is only valid for period");
  });
  test("pace equal to the period is rejected", () => {
    expect(refused("\n[[usage.budgets]]\nname = \"weekly\"\nperiod = \"week\"\ncost_usd = 5.0\npace_period = \"week\"\n")).toContain("usage.budgets[0].pace_period = \"week\" must be shorter than p");
  });
  test("pace longer than the period is rejected", () => {
    expect(refused("\n[[usage.budgets]]\nname = \"daily\"\nperiod = \"day\"\ncost_usd = 5.0\npace_period = \"month\"\n")).toContain("usage.budgets[0].pace_period = \"month\" must be shorter than ");
  });
  test("pace_action without pace_period is rejected", () => {
    expect(refused("\n[[usage.budgets]]\nname = \"weekly\"\nperiod = \"week\"\ncost_usd = 5.0\npace_action = \"block\"\n")).toContain("usage.budgets[0].pace_action requires pace_period");
  });
  test("pace_warn_at without pace_period is rejected", () => {
    expect(refused("\n[[usage.budgets]]\nname = \"weekly\"\nperiod = \"week\"\ncost_usd = 5.0\npace_warn_at = [0.8]\n")).toContain("usage.budgets[0].pace_warn_at requires pace_period");
  });
  test("pace_action precedes pace_warn_at", () => {
    expect(refused("\n[[usage.budgets]]\nname = \"weekly\"\nperiod = \"week\"\ncost_usd = 5.0\npace_action = \"block\"\npace_warn_at = [0.8]\n")).toContain("usage.budgets[0].pace_action requires pace_period");
  });
  test("pace_warn_at non-positive is rejected", () => {
    expect(refused("\n[[usage.budgets]]\nname = \"weekly\"\nperiod = \"week\"\ncost_usd = 5.0\npace_period = \"day\"\npace_warn_at = [0.5, 0.0]\n")).toContain("usage.budgets[0].pace_warn_at values must be greater than 0");
  });
  test("anchor check precedes pace check", () => {
    expect(refused("\n[[usage.budgets]]\nname = \"daily\"\nperiod = \"day\"\ncost_usd = 5.0\nreset_day_of_week = \"thursday\"\npace_period = \"month\"\n")).toContain("usage.budgets[0].reset_day_of_week is only valid for period ");
  });
  test("duplicate budget names", () => {
    expect(refused("\n[[usage.budgets]]\nname = \"daily\"\nperiod = \"day\"\ncost_usd = 5.0\n\n[[usage.budgets]]\nname = \"daily\"\nperiod = \"week\"\ncost_usd = 50.0\n")).toContain("usage budget name \"daily\" is duplicated");
  });
  test("explicit name collides with a blank name's placeholder", () => {
    expect(refused("\n[[usage.budgets]]\nperiod = \"day\"\ncost_usd = 5.0\n\n[[usage.budgets]]\nname = \"budget 1\"\nperiod = \"week\"\ncost_usd = 50.0\n")).toContain("usage budget name \"budget 1\" is duplicated");
  });
  test("budget names are trimmed before comparison", () => {
    expect(refused("\n[[usage.budgets]]\nname = \"daily\"\nperiod = \"day\"\ncost_usd = 5.0\n\n[[usage.budgets]]\nname = \"  daily  \"\nperiod = \"week\"\ncost_usd = 50.0\n")).toContain("usage budget name \"daily\" is duplicated");
  });
  test("a next-line character is trimmed from a budget name", () => {
    expect(refused("\n[[usage.budgets]]\nname = \"\\u0085daily\"\nperiod = \"day\"\ncost_usd = 5.0\n\n[[usage.budgets]]\nname = \"daily\"\nperiod = \"week\"\ncost_usd = 50.0\n")).toContain("usage budget name \"daily\" is duplicated");
  });
  test("whitespace-only budget name is blank", () => {
    expect(refused("\n[[usage.budgets]]\nname = \"   \"\nperiod = \"day\"\ncost_usd = 5.0\n\n[[usage.budgets]]\nname = \"budget 1\"\nperiod = \"week\"\ncost_usd = 50.0\n")).toContain("usage budget name \"budget 1\" is duplicated");
  });
  test("earlier budget index reports first", () => {
    expect(refused("\n[[usage.budgets]]\nname = \"a\"\nperiod = \"day\"\ncost_usd = 5.0\nreset_hour = 99\n\n[[usage.budgets]]\nname = \"b\"\nperiod = \"day\"\ncost_usd = -1.0\n")).toContain("usage.budgets[0].reset_hour must be 0-23, got 99");
  });
  test("compaction min_turns not above keep_recent_turns", () => {
    expect(refused("\n[memory.compaction]\nmin_turns = 4\nkeep_recent_turns = 4\n")).toContain("must both be greater than keep_recent_turns (4)");
  });
  test("injecting recall requires usable limits and a backend", () => {
    expect(refused("\n[memory.recall]\nmode = \"inject\"\n")).toContain(
      "memory.backend.url must be set when memory.recall.mode is not \"off\"",
    );
    expect(refused("\n[memory.backend]\nurl = \"http://localhost:8888/mcp/\"\n\n[memory.recall]\nmode = \"inject\"\nmax_memories = 0\n")).toContain(
      "memory.recall.max_memories must be greater than 0",
    );
    expect(refused("\n[memory.backend]\nurl = \"http://localhost:8888/mcp/\"\n\n[memory.recall]\nmode = \"inject\"\nrecent_messages = 0\n")).toContain(
      "memory.recall.recent_messages must be greater than 0",
    );
    expect(refused("\n[memory.backend]\nurl = \"http://localhost:8888/mcp/\"\n\n[memory.recall]\nmode = \"inject\"\nmax_tokens = 0\n")).toContain(
      "memory.recall.max_tokens must be greater than 0",
    );
    expect(refused("\n[memory.backend]\nurl = \"http://localhost:8888/mcp/\"\n\n[memory.recall]\nmode = \"inject\"\ntimeout = \"0s\"\n")).toContain(
      "memory.recall.timeout must be greater than 0",
    );
    expect(refused("\n[memory.backend]\nurl = \"mcp-hindsight:8888\"\n\n[memory.recall]\nmode = \"inject\"\n")).toContain(
      "memory.backend.url must be an http or https URL, got 'mcp-hindsight:8888'",
    );
    expect(refused("\n[memory.backend]\nurl = \"://nope\"\n\n[memory.recall]\nmode = \"inject\"\n")).toContain(
      "memory.backend.url is not a valid URL",
    );
    expect(refused("\n[memory.backend]\nurl = \"ftp://hindsight/mcp/\"\n\n[memory.recall]\nmode = \"inject\"\n")).toContain(
      "memory.backend.url must be an http or https URL",
    );
    expect(accepted("\n[memory.backend]\nurl = \"http://localhost:8888/mcp/\"\n\n[memory.recall]\nmode = \"inject\"\n")).toBeDefined();
    expect(accepted("\n[memory.backend]\nurl = \"http://localhost:8888/mcp/\"\nbank = \"shared\"\n\n[memory.recall]\nmode = \"inject\"\n")).toBeDefined();
  });
  test("off recall permits zero limits because it performs no work", () => {
    expect(accepted("\n[memory.recall]\nmode = \"off\"\nrecent_messages = 0\nmax_memories = 0\ntimeout = \"0s\"\n")).toBeDefined();
  });
  test("archive retain has one memory owner and a configured backend", () => {
    expect(refused("\n[memory.backend]\nurl = \"http://localhost:8888/mcp/\"\n\n[memory.retain]\nenabled = true\n")).toContain(
      "memory.retain.enabled requires memory.compaction.write_memory = false",
    );
    expect(refused("\n[memory.compaction]\nwrite_memory = false\n\n[memory.retain]\nenabled = true\n")).toContain(
      "memory.backend.url must be set when memory.recall.mode is not \"off\"",
    );
    expect(refused("\n[memory.backend]\nurl = \"http://localhost:8888/mcp/\"\n\n[memory.compaction]\nwrite_memory = false\n\n[memory.retain]\nenabled = true\npossessive_pronoun = \"  \"\n")).toContain(
      "memory.retain.possessive_pronoun must not be blank",
    );
    expect(refused("\n[memory.backend]\nurl = \"http://localhost:8888/mcp/\"\n\n[memory.compaction]\nwrite_memory = false\n\n[memory.retain]\nenabled = true\ntimeout = \"0s\"\n")).toContain(
      "memory.retain.timeout must be greater than 0",
    );
    expect(accepted("\n[memory.backend]\nurl = \"http://localhost:8888/mcp/\"\n\n[memory.compaction]\nwrite_memory = false\n\n[memory.retain]\nenabled = true\nuser_name = \"Ren\"\npossessive_pronoun = \"her\"\n")).toBeDefined();
  });
  test("usage check precedes compaction check", () => {
    expect(refused("\n[usage]\ntimezone = \"nope\"\n\n[memory.compaction]\nmin_turns = 4\nkeep_recent_turns = 4\n")).toContain("usage.timezone must be \"local\" or \"utc\", got \"nope\"");
  });
  test("every check fails at once", () => {
    expect(refused("\n[defaults]\nmodel = \"ghost\"\nembedding = \"bad-embed\"\nimage_generation = \"bad-image\"\n\n[tools]\nenabled_subagents = [\"researcher\"]\n\n[usage]\ntimezone = \"nope\"\n\n[subagents.researcher]\ndescription = \"R\"\nprompt = \"r\"\nmodel = \"ghost-model\"\n\n[mcp.hue]\ncommand = \"node\"\nurl = \"http://x\"\n\n[memory.compaction]\nmin_turns = 4\nkeep_recent_turns = 4\n")).toContain("subagents.researcher resolves to model \"ghost-model\", which ");
  });
  test("mcp is next after subagents", () => {
    expect(refused("\n[defaults]\nembedding = \"bad-embed\"\nimage_generation = \"bad-image\"\n\n[usage]\ntimezone = \"nope\"\n\n[mcp.hue]\ncommand = \"node\"\nurl = \"http://x\"\n\n[memory.compaction]\nmin_turns = 4\nkeep_recent_turns = 4\n")).toContain("mcp.hue sets both `command` and `url`; set exactly one trans");
  });
  test("embedding is next after mcp", () => {
    expect(refused("\n[defaults]\nembedding = \"bad-embed\"\nimage_generation = \"bad-image\"\n\n[usage]\ntimezone = \"nope\"\n\n[memory.compaction]\nmin_turns = 4\nkeep_recent_turns = 4\n")).toContain("defaults.embedding \"bad-embed\" must be a `provider:model_id`");
  });
  test("usage is next after the aux defaults", () => {
    expect(refused("\n[usage]\ntimezone = \"nope\"\n\n[memory.compaction]\nmin_turns = 4\nkeep_recent_turns = 4\n")).toContain("usage.timezone must be \"local\" or \"utc\", got \"nope\"");
  });
  test("warnings are emitted before a rejection", () => {
    expect(refused("\n[defaults]\nmodel = \"ghost-a\"\n\n[usage]\ntimezone = \"nope\"\n")).toContain("usage.timezone must be \"local\" or \"utc\", got \"nope\"");
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
