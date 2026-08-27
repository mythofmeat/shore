import { describe, expect, test } from "bun:test";

import { CommandError } from "../src/commands/errors.ts";
import {
  applySamplerValue,
  capabilityCheck,
  SAMPLER_KEYS,
  settingSchema,
} from "../src/commands/model_settings.ts";
import { SDK_VARIANTS } from "../src/llm/types.ts";
import {
  SETTING_DEFINITIONS,
  SETTING_STORAGE_FIELDS,
  reasoningSuggestions,
  samplerToWire,
} from "../src/llm/settings.ts";
import type { SamplerSettings } from "../src/config/preferences.ts";

const EXPECTED_KEYS = [
  "temperature",
  "top_p",
  "reasoning_effort",
  "budget_tokens",
  "max_output_tokens",
  "cache_ttl",
  "cache_keepalive",
  "cache_keepalive_max",
  "sdk",
  "replay_prior_thinking",
  "max_tool_iterations",
  "openrouter_provider",
  "gemini_generation",
  "zai_clear_thinking",
  "supports_images",
] as const;

describe("the canonical setting registry", () => {
  test("owns all fields exactly once and in stable wire order", () => {
    expect(SAMPLER_KEYS).toEqual([...EXPECTED_KEYS]);
    expect(SETTING_DEFINITIONS.map((definition) => definition.key)).toEqual([...EXPECTED_KEYS]);
    expect(new Set(SETTING_STORAGE_FIELDS.map(([field]) => field)).size).toBe(15);
    expect(new Set(SETTING_STORAGE_FIELDS.map(([, key]) => key)).size).toBe(15);
  });

  test("emits a complete typed schema for every sdk", () => {
    for (const sdk of SDK_VARIANTS) {
      const schema = settingSchema(sdk);
      expect(schema.map((entry) => entry.key), sdk).toEqual([...EXPECTED_KEYS]);
      for (const entry of schema) {
        expect(["number", "u32", "boolean", "string", "duration", "duration_or_off", "json_object"])
          .toContain(entry.kind);
        expect(["always", "honored", "ignored", "rejected"]).toContain(entry.applicability);
        expect(Array.isArray(entry.suggestions)).toBe(true);
      }
    }
  });

  test("is the source of slider metadata", () => {
    expect(settingSchema("openai").find((entry) => entry.key === "temperature")?.editor)
      .toEqual({ kind: "slider", min: 0, max: 2, step: 0.1 });
    expect(settingSchema("openai").find((entry) => entry.key === "top_p")?.editor)
      .toEqual({ kind: "slider", min: 0, max: 1, step: 0.05 });
    expect(settingSchema("openai").filter((entry) => entry.editor !== undefined)).toHaveLength(2);
  });
});

describe("authoritative coercion", () => {
  test("accepts native values and their textual CLI forms", () => {
    const sampler: SamplerSettings = {};
    for (const [key, value] of [
      ["temperature", "0.7"],
      ["top_p", 0.9],
      ["budget_tokens", "2048"],
      ["max_output_tokens", 4096],
      ["gemini_generation", "3"],
      ["max_tool_iterations", "8"],
      ["zai_clear_thinking", "YES"],
      ["supports_images", "off"],
    ] as const) applySamplerValue(sampler, key, value);

    expect(samplerToWire(sampler)).toMatchObject({
      temperature: 0.7,
      top_p: 0.9,
      budget_tokens: 2048,
      max_output_tokens: 4096,
      gemini_generation: 3,
      max_tool_iterations: 8,
      zai_clear_thinking: true,
      supports_images: false,
    });
  });

  test("normalizes reasoning and replay aliases", () => {
    const sampler: SamplerSettings = {};
    for (const alias of ["none", "disable", "disabled"]) {
      applySamplerValue(sampler, "reasoning_effort", alias);
      expect(sampler.reasoningEffort).toBe("off");
    }
    applySamplerValue(sampler, "replay_prior_thinking", "yes");
    expect(sampler.replayPriorThinking).toBe("all");
    applySamplerValue(sampler, "replay_prior_thinking", "off");
    expect(sampler.replayPriorThinking).toBe("none");
  });

  test("parses durations and JSON-object strings into persisted types", () => {
    const sampler: SamplerSettings = {};
    applySamplerValue(sampler, "cache_keepalive", "55m");
    applySamplerValue(sampler, "cache_keepalive_max", "12h");
    applySamplerValue(sampler, "openrouter_provider", '{"order":["Anthropic"]}');
    expect(samplerToWire(sampler)).toMatchObject({
      cache_keepalive: "55m",
      cache_keepalive_max: "12h",
      openrouter_provider: { order: ["Anthropic"] },
    });
  });

  test("retains TOML representability checks", () => {
    expect(() => applySamplerValue({}, "openrouter_provider", '{"order":[null]}'))
      .toThrow(/TOML-compatible/);
  });

  test("null clears every setting, including vendor settings", () => {
    for (const [key] of SETTING_STORAGE_FIELDS) {
      const sampler = { [key]: "sentinel" } as SamplerSettings;
      const wireKey = SETTING_STORAGE_FIELDS.find(([field]) => field === key)?.[1];
      expect(wireKey).toBeDefined();
      applySamplerValue(sampler, wireKey as string, null);
      expect(sampler[key]).toBeUndefined();
    }
  });

  test("rejects invalid typed text without mutating an existing value", () => {
    const sampler: SamplerSettings = { temperature: 0.7 };
    expect(() => applySamplerValue(sampler, "temperature", "warm")).toThrow(CommandError);
    expect(() => applySamplerValue(sampler, "temperature", " ")).toThrow(/number/);
    expect(sampler.temperature).toBe(0.7);
    expect(() => applySamplerValue(sampler, "max_tool_iterations", "0")).toThrow(/>= 1/);
    expect(() => applySamplerValue(sampler, "reasoning_effort", " ")).toThrow(/non-empty/);
  });
});

describe("applicability", () => {
  test("vendor settings belong only to their adapters", () => {
    for (const [key, owner] of [
      ["cache_ttl", "anthropic"],
      ["openrouter_provider", "openrouter"],
      ["gemini_generation", "gemini"],
      ["zai_clear_thinking", "zai"],
    ] as const) {
      for (const sdk of SDK_VARIANTS) {
        const entry = settingSchema(sdk).find((candidate) => candidate.key === key);
        expect(entry?.applicability, `${key}/${sdk}`).toBe(sdk === owner ? "honored" : "ignored");
      }
    }
  });

  test("local settings and both advanced settings are always applicable", () => {
    for (const sdk of SDK_VARIANTS) {
      const schema = settingSchema(sdk);
      for (const key of ["max_output_tokens", "cache_keepalive", "cache_keepalive_max", "sdk", "replay_prior_thinking", "max_tool_iterations", "supports_images"]) {
        expect(schema.find((entry) => entry.key === key)?.applicability, `${key}/${sdk}`).toBe("always");
      }
    }
  });

  test("explicit empty supported_parameters rejects both samplers", () => {
    const schema = settingSchema("openrouter", { supported_parameters: [] });
    expect(schema.find((entry) => entry.key === "temperature")?.applicability).toBe("rejected");
    expect(schema.find((entry) => entry.key === "top_p")?.applicability).toBe("rejected");
    expect(capabilityCheck("openrouter", "temperature", "0.7", { supported_parameters: [] }))
      .toBeInstanceOf(CommandError);
  });

  test("missing supported_parameters remains permissive", () => {
    expect(settingSchema("openrouter").find((entry) => entry.key === "temperature")?.applicability)
      .toBe("honored");
  });

  test("budget support is limited by sdk and explicit model claims", () => {
    for (const sdk of ["anthropic", "gemini", "moonshot"] as const) {
      expect(settingSchema(sdk).find((entry) => entry.key === "budget_tokens")?.applicability)
        .toBe("honored");
      expect(settingSchema(sdk, { thinking: { enabled: false } }).find((entry) => entry.key === "budget_tokens")?.applicability)
        .toBe("rejected");
    }
    expect(settingSchema("openai").find((entry) => entry.key === "budget_tokens")?.applicability)
      .toBe("ignored");
  });

  test("clearing an inapplicable setting is always allowed", () => {
    expect(capabilityCheck("openai", "cache_ttl", null)).toBeUndefined();
  });
});

describe("reasoning behavior", () => {
  test("Gemini is closed to its runtime enum", () => {
    const entry = settingSchema("gemini").find((candidate) => candidate.key === "reasoning_effort");
    expect(entry?.allow_custom).toBe(false);
    expect(entry?.suggestions).toEqual(["minimal", "low", "medium", "high"]);
    expect(capabilityCheck("gemini", "reasoning_effort", "turbo")).toBeInstanceOf(CommandError);
  });

  test("OpenRouter uses runtime suggestions but remains open", () => {
    const entry = settingSchema("openrouter").find((candidate) => candidate.key === "reasoning_effort");
    expect(entry?.allow_custom).toBe(true);
    expect(entry?.suggestions).toContain("max");
    expect(capabilityCheck("openrouter", "reasoning_effort", "turbo")).toBeUndefined();
  });

  test("type-only adapters suggest known values without gating custom input", () => {
    for (const sdk of ["anthropic", "openai", "zai", "deepseek", "moonshot"] as const) {
      expect(settingSchema(sdk).find((entry) => entry.key === "reasoning_effort")?.allow_custom, sdk)
        .toBe(true);
      expect(capabilityCheck(sdk, "reasoning_effort", "provider-future-value"), sdk)
        .toBeUndefined();
    }
  });

  test("an explicit model domain is closed, including an empty domain", () => {
    const closed = { effort: { supported: true, levels: ["low", "high"] } } as const;
    expect(reasoningSuggestions("anthropic", closed)).toEqual(["low", "high", "off"]);
    expect(settingSchema("anthropic", closed).find((entry) => entry.key === "reasoning_effort")?.allow_custom)
      .toBe(false);
    expect(capabilityCheck("anthropic", "reasoning_effort", "medium", closed)).toBeInstanceOf(CommandError);
    expect(capabilityCheck("anthropic", "reasoning_effort", "off", closed)).toBeUndefined();

    const empty = { effort: { supported: false, levels: [] } } as const;
    expect(reasoningSuggestions("anthropic", empty)).toEqual(["off"]);
    expect(capabilityCheck("anthropic", "reasoning_effort", "low", empty)).toBeInstanceOf(CommandError);
  });

  test("adaptive is an independently advertised pseudo-value", () => {
    const support = {
      effort: { supported: false, levels: [] },
      thinking: { adaptive: true },
    } as const;
    expect(reasoningSuggestions("anthropic", support)).toEqual(["adaptive", "off"]);
    expect(capabilityCheck("anthropic", "reasoning_effort", "adaptive", support)).toBeUndefined();
  });

  test("thinking metadata alone does not close an unknown effort domain", () => {
    const support = { thinking: { adaptive: true, enabled: true } } as const;
    const entry = settingSchema("anthropic", support)
      .find((candidate) => candidate.key === "reasoning_effort");

    expect(entry?.suggestions).toEqual(["adaptive", "off"]);
    expect(entry?.allow_custom).toBe(true);
    expect(capabilityCheck("anthropic", "reasoning_effort", "provider-future-value", support))
      .toBeUndefined();
  });
});
