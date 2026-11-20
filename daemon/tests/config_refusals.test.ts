import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { typeWords } from "../src/config/app.ts";
import { placed } from "../src/config/failure.ts";
import { loadConfig, parseConfigTable } from "../src/config/loader.ts";
import { catalogFromSections, readModelConfigFields } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { configSchema, findSchemaEntry } from "../src/config/schema.ts";
import { schemaValueLiteral } from "../src/config/schema_value.ts";
import { testTmp } from "./support/tmp.ts";

const fromSection = (section: Record<string, unknown>): ProviderRegistry => ProviderRegistry.fromSection(section);
const refusalOf = (section: Record<string, unknown>): string => {
  try {
    fromSection(section);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "accepted";
};

describe("a provider's settings", () => {
  test("a value of the wrong kind is refused naming the provider and the key", () => {
    for (const [entry, refusal] of [
      [5, "providers.x: invalid type: integer `5`, expected table"],
      [{ enabled: "yes" }, 'providers.x.enabled: invalid type: string "yes", expected boolean'],
      [{ subscription: 1 }, "providers.x.subscription: invalid type: integer `1`, expected boolean"],
      [{ no_auth: "no" }, 'providers.x.no_auth: invalid type: string "no", expected boolean'],
      [{ pin: 5 }, "providers.x.pin: invalid type: integer `5`, expected string"],
      [{ sdk: 5 }, "providers.x.sdk: invalid type: integer `5`, expected string"],
      [{ sdk: "pigeon" }, "providers.x.sdk: unknown variant `pigeon`"],
      [{ base_url: 5 }, "providers.x.base_url: invalid type: integer `5`, expected string"],
      [{ api_key_env: true }, "providers.x.api_key_env: invalid type: boolean `true`, expected string"],
      [{ keys: "work" }, 'providers.x.keys: invalid type: string "work", expected list of table'],
    ] as const) {
      expect(refusalOf({ x: entry })).toBe(refusal);
    }
  });

  test("a provider that signs in is a subscription unless it says otherwise, and any other is not", () => {
    const entry = (settings: Record<string, unknown>) => fromSection({ x: settings }).get("x");
    expect([entry({ sdk: "claude_agent" })?.sdk, entry({ sdk: "claude_agent" })?.subscription]).toEqual(["claude_agent", true]);
    expect(entry({ sdk: "claude_agent", subscription: false })?.subscription).toBe(false);
    expect([entry({ sdk: "anthropic" })?.sdk, entry({ sdk: "anthropic" })?.subscription]).toEqual(["anthropic", false]);
  });

  test("its one api_key_env becomes a key named default, and it can't also list keys or go without auth", () => {
    const entry = fromSection({ x: { api_key_env: "X_KEY" } }).get("x");
    expect([entry?.keys.map((key) => [key.name, key.apiKeyEnv]), entry && "apiKeyEnv" in entry]).toEqual([[["default", "X_KEY"]], false]);
    expect(refusalOf({ x: { api_key_env: "X_KEY", keys: [{ name: "work" }] } })).toBe("[providers.x] declares both `api_key_env` and explicit `[[keys]]`; use one form per provider");
    expect(refusalOf({ x: { no_auth: true, api_key_env: "X_KEY" } })).toBe("[providers.x] sets `no_auth = true` and also lists keys; use one or the other");
    expect(fromSection({ x: { no_auth: true } }).get("x")?.keys).toEqual([]);
  });
});

describe("a provider's keys", () => {
  test("a key that is wrong is refused naming its place in the list and the setting", () => {
    for (const [key, refusal] of [
      [5, "providers.x.keys[0]: invalid type: integer `5`, expected table"],
      [{}, "providers.x.keys[0]: missing field `name`"],
      [{ name: 5 }, "providers.x.keys[0].name: invalid type: integer `5`, expected string"],
      [{ name: "work", api_key_env: "  " }, "providers.x.keys[0].api_key_env: must name an environment variable"],
      [{ name: "work", api_key_env: 5 }, "providers.x.keys[0].api_key_env: must name an environment variable"],
      [{ name: "work", spend_limit_usd: 0 }, "providers.x.keys[0].spend_limit_usd: must be a positive number"],
      [{ name: "work", spend_limit_usd: -1 }, "providers.x.keys[0].spend_limit_usd: must be a positive number"],
      [{ name: "work", spend_limit_usd: "lots" }, "providers.x.keys[0].spend_limit_usd: must be a positive number"],
      [{ name: "work", spend_limit_usd: Number.POSITIVE_INFINITY }, "providers.x.keys[0].spend_limit_usd: must be a positive number"],
      [{ name: "work", spend_limit_usd: 5, spend_period: "fortnight" }, "providers.x.keys[0].spend_period: must be one of hour, day, week, month"],
      [{ name: "work", spend_limit_usd: 5, spend_period: 7 }, "providers.x.keys[0].spend_period: must be one of hour, day, week, month"],
      [{ name: "work", spend_period: "day" }, "providers.x.keys[0].spend_period: needs `spend_limit_usd`"],
      [{ name: "work", enabled: "no" }, 'providers.x.keys[0].enabled: invalid type: string "no", expected boolean'],
      [{ name: "work", warn_on_fallback: 1 }, "providers.x.keys[0].warn_on_fallback: invalid type: integer `1`, expected boolean"],
    ] as const) {
      expect(refusalOf({ x: { keys: [key] } })).toBe(refusal);
    }
    expect(refusalOf({ x: { keys: [{ name: "home" }, { name: "" }] } })).toBe("[providers.x] key #1 is missing `name`");
    expect(refusalOf({ x: { keys: [{ name: "home" }, { name: "home" }] } })).toBe('[providers.x] has duplicate key name "home"; each key under a provider must have a unique name');
  });

  test("a spending limit is a positive cost per day, week or month, and month when no period is given", () => {
    const limit = (key: Record<string, unknown>) => fromSection({ x: { keys: [{ name: "work", ...key }] } }).get("x")?.keys[0]?.spendLimit;
    expect([limit({ spend_limit_usd: 0.5 }), limit({ spend_limit_usd: BigInt(5), spend_period: "week" })]).toEqual([{ costUsd: 0.5, period: "month" }, { costUsd: 5, period: "week" }]);
  });

  test("a login's share of a window is above 0 and at most 1, and only a provider that signs in has logins with folders and windows", () => {
    const login = (key: Record<string, unknown>) => fromSection({ x: { sdk: "claude_agent", keys: [{ name: "work", ...key }] } }).get("x")?.keys[0];
    expect([login({ session_limit: 1 })?.windowLimits, login({ weekly_limit: BigInt(1) })?.windowLimits, login({ session_limit: 0.5, dir: "work-2" })?.dir])
      .toEqual([{ session: 1 }, { weekly: 1 }, "work-2"]);
    for (const [key, refusal] of [
      [{ session_limit: 0 }, "providers.x.keys[0].session_limit: must be a fraction above 0 and at most 1 (0.5 is half the window)"],
      [{ weekly_limit: 1.5 }, "providers.x.keys[0].weekly_limit: must be a fraction above 0 and at most 1 (0.5 is half the window)"],
      [{ weekly_limit: "half" }, "providers.x.keys[0].weekly_limit: must be a fraction above 0 and at most 1 (0.5 is half the window)"],
      [{ session_limit: Number.NaN }, "providers.x.keys[0].session_limit: must be a fraction above 0 and at most 1 (0.5 is half the window)"],
      [{ dir: 5 }, "providers.x.keys[0].dir: invalid type: integer `5`, expected string"],
    ] as const) {
      expect(refusalOf({ x: { sdk: "claude_agent", keys: [{ name: "work", ...key }] } })).toBe(refusal);
    }
    expect(refusalOf({ x: { sdk: "claude_agent", keys: [{ name: "a", dir: "shared" }, { name: "b", dir: "shared" }] } })).toBe('providers.x: logins "a" and "b" both use the folder "shared"');
    expect(refusalOf({ x: { keys: [{ name: "work", dir: "work" }] } })).toBe('[providers.x] key "work" sets `dir`, which only a login of a provider that signs in (claude_agent) has');
  });

  test("a pin names a key the provider has that is on", () => {
    expect(fromSection({ x: { pin: "work", keys: [{ name: "work" }] } }).get("x")?.pin).toBe("work");
    expect(refusalOf({ x: { pin: "home", keys: [{ name: "work" }] } })).toBe('[providers.x] pins key "home", but it has no key by that name');
    expect(refusalOf({ x: { pin: "work", keys: [{ name: "work", enabled: false }] } })).toBe('[providers.x] pins key "work", which is disabled; enable it or clear `pin`');
  });
});

describe("a model's settings", () => {
  const settingRefusal = (table: Record<string, unknown>): string => {
    const read = readModelConfigFields(table);
    return "err" in read ? placed(read) : "accepted";
  };

  test("a value of the wrong kind or out of range is refused naming the setting, and each right one is kept", () => {
    for (const [table, refusal] of [
      [{ bogus: 1 }, "unknown field `bogus`, expected one of "],
      [{ sdk: 5 }, "sdk: invalid type: integer `5`, expected string"],
      [{ sdk: "pigeon" }, "sdk: unknown variant `pigeon`, expected one of "],
      [{ system_prompt: 5 }, "system_prompt: invalid type: integer `5`, expected string"],
      [{ max_output_tokens: "5" }, 'max_output_tokens: invalid type: string "5", expected integer'],
      [{ max_output_tokens: 1.5 }, "max_output_tokens: invalid type: floating point `1.5`, expected integer"],
      [{ max_output_tokens: -1 }, "max_output_tokens: invalid value: integer `-1`, expected an integer from 0 to 4294967295"],
      [{ max_output_tokens: 4_294_967_296 }, "max_output_tokens: invalid value: integer `4294967296`, expected an integer from 0 to 4294967295"],
      [{ temperature: "hot" }, 'temperature: invalid type: string "hot", expected number'],
      [{ supports_images: "yes" }, 'supports_images: invalid type: string "yes", expected boolean'],
      [{ reasoning_replay: "some" }, "reasoning_replay: must be all or none"],
    ] as const) {
      expect(settingRefusal(table)).toStartWith(refusal);
    }
    expect(readModelConfigFields({ sdk: "anthropic", system_prompt: "Be brief.", max_output_tokens: 4_294_967_295, top_p: 0.5, supports_images: false, reasoning_replay: "none" }))
      .toEqual({ ok: { sdk: "anthropic", systemPrompt: "Be brief.", maxOutputTokens: 4_294_967_295, topP: 0.5, supportsImages: false, reasoningReplay: "none" } });
  });
});

describe("the model tables", () => {
  const tableRefusal = (chat: Record<string, unknown> | undefined, image?: Record<string, unknown>): string => {
    try {
      catalogFromSections(chat, image);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return "accepted";
  };

  test("a chat model's table is keyed provider:model_id, holds no identity, and a setting in it that is wrong names the model and the setting", () => {
    for (const [section, refusal] of [
      [{ ":claude-x": {} }, "failed to parse model entry [chat..claude-x]: expected a provider:model_id settings table"],
      [{ "anthropic:": {} }, "failed to parse model entry [chat.anthropic.]: expected a provider:model_id settings table"],
      [{ "anthropic:claude-x": 5 }, "failed to parse model entry [chat.anthropic.claude-x]: expected a provider:model_id settings table"],
      [{ claude: {} }, "failed to parse model entry [chat.claude.]: expected a provider:model_id settings table"],
      [{ "anthropic:claude-x": { model_id: "y" } }, "failed to parse model entry [chat.anthropic.claude-x]: model identity belongs in the table key"],
      [{ "anthropic:claude-x": { api_key_env: "K" } }, "failed to parse model entry [chat.anthropic.claude-x]: model identity belongs in the table key"],
      [{ "anthropic:claude-x": { base_url: "u" } }, "failed to parse model entry [chat.anthropic.claude-x]: model identity belongs in the table key"],
      [{ "anthropic:claude-x": { temperature: "hot" } }, 'chat."anthropic:claude-x".temperature: invalid type: string "hot", expected number'],
    ] as const) {
      expect(tableRefusal(section)).toStartWith(refusal);
    }
  });

  test("a chat model starts from its provider's sdk and address and from what is known of its context window, in the order of its name", () => {
    const providers = ProviderRegistry.fromSection({ relay: { sdk: "anthropic", base_url: "https://relay.example" } });
    const catalog = catalogFromSections({ "relay:claude-x": {}, "openai:gpt-x": {}, "anthropic:claude-y": {} }, undefined, providers);
    expect([...catalog.chat.values()].map((model) => [model.qualifiedName, model.sdk, model.baseUrl ?? null, model.maxContextTokens ?? null])).toEqual([
      ["anthropic:claude-y", "anthropic", null, 200_000],
      ["openai:gpt-x", "openai", null, null],
      ["relay:claude-x", "anthropic", "https://relay.example", 200_000],
    ]);
  });

  test("an image model's table is keyed provider:model_id, and a setting in it that is wrong names the setting", () => {
    const why = (key: string, detail: string): string => `[image.${JSON.stringify(key)}] is not a valid \`provider:model_id\` settings table: ${detail}.`;
    for (const [section, refusal] of [
      [{ "gpt-image": {} }, why("gpt-image", "the key must be a `provider:model_id` identity, not a bare alias")],
      [{ ":gpt-image": {} }, why(":gpt-image", "both the provider and model_id halves of the `provider:model_id` key must be non-empty")],
      [{ "openai:": {} }, why("openai:", "both the provider and model_id halves of the `provider:model_id` key must be non-empty")],
      [{ "openai:gpt-image": 5 }, why("openai:gpt-image", "the value must be a settings table")],
      [{ "openai:gpt-image": { size: 5 } }, why("openai:gpt-image", "size: invalid type: integer `5`, expected string")],
    ] as const) {
      expect(tableRefusal(undefined, section)).toStartWith(refusal);
    }
    expect([...catalogFromSections(undefined, { "openai:b": {}, "openai:a": { size: "512x512" } }).imageGeneration]).toEqual([["openai:a", { size: "512x512" }], ["openai:b", {}]]);
  });
});

describe("the config as a whole", () => {
  const dirs = { config: "/nowhere/config", data: "/nowhere/data", cache: "/nowhere/cache", runtime: "/nowhere/runtime" };
  const failure = (table: Record<string, unknown>): unknown => {
    try {
      parseConfigTable(table, dirs, () => {});
    } catch (error) {
      return error;
    }
    return undefined;
  };

  test("a provider or model table that is wrong is refused as one, naming the key", () => {
    expect(failure({ providers: { x: { enabled: "yes" } } })).toMatchObject({ kind: "provider_registry", message: 'providers.x.enabled: invalid type: string "yes", expected boolean' });
    expect(failure({ chat: { "anthropic:": {} } })).toMatchObject({ kind: "catalog", message: "failed to parse model entry [chat.anthropic.]: expected a provider:model_id settings table" });
    expect(failure({ triggers: { max_idle_wakes: 4_294_967_296 } })).toMatchObject({ kind: "parse_app", message: "triggers.max_idle_wakes: invalid value: integer `4294967296`, expected an integer from 0 to 4294967295" });
    expect(failure({ tools: { max_result_chars: -1 } })).toMatchObject({ message: "tools.max_result_chars: invalid value: integer `-1`, expected an integer from 0" });
    expect(failure({ tools: { max_result_chars: 1.5 } })).toMatchObject({ message: "tools.max_result_chars: invalid type: floating point `1.5`, expected integer" });
    expect(failure({ tools: { enabled: "bash" } })).toMatchObject({ message: 'tools.enabled: invalid type: string "bash", expected list of string' });
    expect(failure({ tools: { pass_env: ["HOME", 5] } })).toMatchObject({ message: "tools.pass_env[1]: invalid type: integer `5`, expected string" });
    expect(failure({ tools: { user: 5 } })).toMatchObject({ message: "tools.user: invalid type: integer `5`, expected string" });
    expect(failure({ mcp: { search: { command: "srch", env: 5 } } })).toMatchObject({ message: "mcp.search.env: invalid type: integer `5`, expected table of string" });
    expect(failure({ notifications: { via: 5 } })).toMatchObject({ message: "notifications.via: invalid type: integer `5`, expected off | notify_send | ntfy | command" });
    expect(failure({ notifications: { via: "pigeon" } })).toMatchObject({ message: "notifications.via: unknown variant `pigeon`, expected one of `off`, `notify_send`, `ntfy`, `command`" });
    expect(parseConfigTable({ triggers: { max_idle_wakes: 4_294_967_295 } }, dirs, () => {}).app.triggers.max_idle_wakes).toBe(4_294_967_295);
  });

  test("a provider that is wrong in a config file names the file", async () => {
    const root = await mkdtemp(testTmp("shore-config-refusals-"));
    const file = join(root, "config.toml");
    await writeFile(file, '[providers.x]\nenabled = "yes"\n');
    expect(() => loadConfig(file, { env: { SHORE_CONFIG_DIR: root }, onWarn: () => {} })).toThrow(`${file}: providers.x.enabled: invalid type: string "yes", expected boolean`);
  });
});

describe("the list of settings", () => {
  const entries = configSchema({ instancesAt: () => [] });
  const entry = (key: string) => {
    const found = findSchemaEntry(entries, key);
    if (found === undefined) throw new Error(`no setting ${key}`);
    return found;
  };

  test("says how wide a whole number may be only where it is limited, and a setting of no one kind is a value", () => {
    expect([entry("triggers.max_idle_wakes").type, entry("triggers.max_idle_wakes").width, Object.hasOwn(entry("triggers.enabled"), "width")]).toEqual(["integer", "u32", false]);
    expect([typeWords({ kind: "unknown" }), typeWords({ kind: "map", item: { kind: "integer" } }), typeWords({ kind: "map" })]).toEqual(["value", "table of integer", "table of values"]);
  });

  test("a key it doesn't know at the top is refused with the top-level keys it does know", async () => {
    const root = await mkdtemp(testTmp("shore-config-refusals-"));
    const file = join(root, "config.toml");
    await writeFile(file, "[bogus]\n");
    const refusal = (() => { try { loadConfig(file, { env: { SHORE_CONFIG_DIR: root }, onWarn: () => {} }); } catch (error) { return String(error); } return ""; })();
    expect([refusal.includes("unknown field `bogus`, expected one of "), refusal.includes("`tools`"), refusal.includes("`tools.enabled`")]).toEqual([true, true, false]);
  });

  test("a whole number set by command is refused when it is too large to hold or above its width", () => {
    expect(() => schemaValueLiteral(entry("triggers.max_idle_wakes"), "9007199254740993")).toThrow('"9007199254740993" is too large');
    expect(() => schemaValueLiteral(entry("triggers.max_idle_wakes"), "4294967296")).toThrow("4294967296 is more than the most it can be, 4294967295");
    expect(schemaValueLiteral(entry("triggers.max_idle_wakes"), "4294967295")).toBe("4294967295");
    expect(schemaValueLiteral(entry("tools.max_result_chars"), "4294967296")).toBe("4294967296");
  });
});
