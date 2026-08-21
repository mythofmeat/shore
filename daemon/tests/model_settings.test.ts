import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";

import { CommandError } from "../src/commands/errors.ts";
import {
  applySamplerValue,
  capabilityCheck,
  keyApplicability,
  reasoningEffortDomain,
  SAMPLER_KEYS,
} from "../src/commands/model_settings.ts";
import { applicability, fieldFromKey, supportsReasoningOff } from "../src/llm/capabilities.ts";
import { SDK_VARIANTS, type Sdk } from "../src/config/models.ts";
import { SAMPLER_FIELD_BY_KEY, type SamplerSettings } from "../src/config/preferences.ts";

const MODELS = [
  "claude-3-5-sonnet-20241022",
  "claude-opus-4-8",
  "gemini-3.1-pro",
  "google/gemini-2.5-flash",
  "openai/o3-mini",
  "x-ai/grok-4",
  "some-model",
] as const;

const PROBES: readonly unknown[] = [1, "x", true, 0.5, "55m", { order: ["a"] }];

describe("every settable key is wired end to end", () => {
  test("each key maps to a field", () => {
    for (const key of SAMPLER_KEYS) {
      expect(SAMPLER_FIELD_BY_KEY.get(key), `${key} has no field`).toBeDefined();
    }
  });

  test("a key nobody declared is refused by name", () => {
    expect(() => applySamplerValue({}, "frobnicate", 1)).toThrow(/unknown setting key: frobnicate/);
  });

  test("the order is load-bearing — it is joined into the rejection message", () => {
    expect(SAMPLER_KEYS).toEqual([...SAMPLER_KEYS].filter((k) => SAMPLER_FIELD_BY_KEY.has(k)));
    expect(SAMPLER_KEYS.length).toBe(SAMPLER_FIELD_BY_KEY.size);
  });
});

interface KeyCase {
  key: string;
  accepts: unknown;
  stored?: unknown;
  rejects: readonly unknown[];
}

const KEY_CASES: readonly KeyCase[] = [
  { key: "temperature", accepts: 0.7, rejects: ["0.7", true, { a: 1 }] },
  { key: "top_p", accepts: 0.9, rejects: ["0.9", false] },
  { key: "reasoning_effort", accepts: "low", rejects: [1, true] },
  { key: "budget_tokens", accepts: 1024, rejects: [-1, 1.5, "1024", true] },
  { key: "max_output_tokens", accepts: 4096, rejects: [-1, 2.5, "4096"] },
  { key: "cache_ttl", accepts: "1h", rejects: [1, true] },
  { key: "cache_keepalive", accepts: "55m", stored: undefined, rejects: ["soon", "0s", 55, true] },
  {
    key: "cache_keepalive_max",
    accepts: "90m",
    stored: undefined,
    rejects: ["soon", "0s", 90, true],
  },
  { key: "sdk", accepts: "anthropic", rejects: ["nope", 1, true] },
  { key: "replay_prior_thinking", accepts: "none", rejects: ["maybe", 1] },
  { key: "max_tool_iterations", accepts: 4, rejects: [0, -1, "4"] },
  { key: "openrouter_provider", accepts: { order: ["a"] }, rejects: [["a"], "a", 1] },
  { key: "gemini_generation", accepts: 3, rejects: [-1, "3"] },
  { key: "zai_clear_thinking", accepts: true, rejects: ["true", 1] },
  { key: "zai_subscription", accepts: false, rejects: ["false", 0] },
  { key: "supports_images", accepts: false, rejects: ["false", 0] },
];

describe("applySamplerValue", () => {
  test("the table covers every settable key", () => {
    expect(KEY_CASES.map((c) => c.key).sort()).toEqual([...SAMPLER_KEYS].sort());
  });

  for (const c of KEY_CASES) {
    test(`${c.key} accepts its type`, () => {
      const sampler: SamplerSettings = {};
      applySamplerValue(sampler, c.key, c.accepts);
      const field = required(SAMPLER_FIELD_BY_KEY.get(c.key));
      expect((sampler as Record<string, unknown>)[field]).toBeDefined();
    });

    test(`${c.key} refuses what it cannot parse, and writes nothing on the way out`, () => {
      for (const bad of c.rejects) {
        const sampler: SamplerSettings = {};
        applySamplerValue(sampler, c.key, c.accepts);
        const before = { ...sampler };

        expect(() => applySamplerValue(sampler, c.key, bad), `${c.key} accepted ${String(bad)}`)
          .toThrow(CommandError);
        expect(sampler, `${c.key} mutated while rejecting ${String(bad)}`).toEqual(before);
      }
    });
  }

  test("null clears the field on every key", () => {
    for (const c of KEY_CASES) {
      const sampler: SamplerSettings = {};
      applySamplerValue(sampler, c.key, c.accepts);
      applySamplerValue(sampler, c.key, null);
      const field = required(SAMPLER_FIELD_BY_KEY.get(c.key));
      expect((sampler as Record<string, unknown>)[field], `${c.key} not cleared`).toBeUndefined();
    }
  });

  test("replay_prior_thinking still takes the booleans the old config wrote", () => {
    const sampler: SamplerSettings = {};
    applySamplerValue(sampler, "replay_prior_thinking", true);
    expect(sampler.replayPriorThinking).toBe("all");
    applySamplerValue(sampler, "replay_prior_thinking", false);
    expect(sampler.replayPriorThinking).toBe("none");
  });
});

describe("capabilityCheck follows applicability, for every sdk and key", () => {
  test("a key that is not honored is refused whatever you pass it", () => {
    for (const sdk of SDK_VARIANTS) {
      for (const model of MODELS) {
        for (const key of SAMPLER_KEYS) {
          const field = fieldFromKey(key);
          if (field === undefined) continue;
          if (applicability(sdk, field) === "honored") continue;

          for (const probe of PROBES) {
            const failure = capabilityCheck(sdk, key, probe);
            expect(failure, `${sdk}/${model} ${key}=${String(probe)}`).toBeInstanceOf(CommandError);
            expect(required(failure).message).toBe(
              `\`${field}\` is not applicable to the \`${sdk}\` sdk for this model`,
            );
          }
        }
      }
    }
  });

  test("a honored key accepts a value of its own type", () => {
    const inDomain = (sdk: Sdk, model: string, key: string): unknown => {
      if (key === "reasoning_effort") return reasoningEffortDomain(sdk)[0] ?? "low";
      if (key === "cache_keepalive") return "55m";
      if (key === "cache_keepalive_max") return "90m";
      return 1;
    };
    for (const sdk of SDK_VARIANTS) {
      for (const model of MODELS) {
        for (const key of SAMPLER_KEYS) {
          const field = fieldFromKey(key);
          if (field === undefined) continue;
          if (applicability(sdk, field) !== "honored") continue;

          const failure = capabilityCheck(sdk, key, inDomain(sdk, model, key));
          expect(failure, `${sdk}/${model} ${key} rejected an in-domain value`).toBeUndefined();
        }
      }
    }
  });

  test("clearing a key is never a capability error, even where the key is meaningless", () => {
    for (const sdk of SDK_VARIANTS) {
      for (const key of SAMPLER_KEYS) {
        expect(capabilityCheck(sdk, key, null)).toBeUndefined();
        expect(capabilityCheck(sdk, key, undefined)).toBeUndefined();
      }
    }
  });

  test("a key with no capability field is left to the parser", () => {
    for (const sdk of SDK_VARIANTS) {
      expect(capabilityCheck(sdk, "frobnicate", 1)).toBeUndefined();
    }
  });
});

describe("the three refusals, spelled out", () => {
  test("not applicable names the field and the sdk", () => {
    expect(capabilityCheck("openai", "cache_ttl", "1h")?.message).toBe(
      "`cache_ttl` is not applicable to the `openai` sdk for this model",
    );
  });

  test("out of domain lists what was allowed", () => {
    expect(capabilityCheck("anthropic", "cache_keepalive", "soon")?.message).toBe(
      '`cache_keepalive` value "soon" is out of domain; allowed: off, or a duration string like 55m / 6h / 30s',
    );
  });

  test("a non-string keepalive is reported as the string it is not", () => {
    expect(capabilityCheck("anthropic", "cache_keepalive", 55)?.message).toBe(
      '`cache_keepalive` value "true" is out of domain; allowed: off, or a duration string like 55m / 6h / 30s',
    );
  });

  test("a non-string idle ceiling is reported as the string it is not", () => {
    expect(capabilityCheck("anthropic", "cache_keepalive_max", 90)?.message).toBe(
      '`cache_keepalive_max` value "true" is out of domain; allowed: a duration string like 90m / 12h',
    );
  });

  test("an unparseable idle ceiling is refused, with its own domain", () => {
    expect(capabilityCheck("anthropic", "cache_keepalive_max", "soon")?.message).toBe(
      '`cache_keepalive_max` value "soon" is out of domain; allowed: a duration string like 90m / 12h',
    );
  });

  test("`off` is a keepalive value but never a ceiling — a ceiling of none stops nothing", () => {
    expect(capabilityCheck("anthropic", "cache_keepalive_max", "off")).toBeInstanceOf(CommandError);
    expect(capabilityCheck("anthropic", "cache_keepalive_max", "90m")).toBeUndefined();
  });

  test("an effort outside the model's domain names the domain", () => {
    const domain = reasoningEffortDomain("anthropic");
    const failure = capabilityCheck("anthropic", "reasoning_effort", "banana");
    expect(failure?.message).toBe(
      `\`reasoning_effort\` value "banana" is out of domain; allowed: ${domain.join(", ")}`,
    );
  });
});

describe("reasoning effort", () => {
  test("every sdk has a non-empty domain", () => {
    for (const sdk of SDK_VARIANTS) {
      expect(reasoningEffortDomain(sdk).length, sdk).toBeGreaterThan(0);
    }
  });

  test('"off" is accepted exactly where the sdk supports turning thinking off', () => {
    for (const sdk of SDK_VARIANTS) {
      const failure = capabilityCheck(sdk, "reasoning_effort", "off");
      expect(failure === undefined, `${sdk} disagreed with supportsReasoningOff`).toBe(
        supportsReasoningOff(sdk) || reasoningEffortDomain(sdk).includes("off"),
      );
    }
  });

  test("discovered effort levels narrow the domain the sdk offers", () => {
    const base = reasoningEffortDomain("openrouter");
    for (const levels of [["low", "medium", "high"], ["minimal", "low"]]) {
      const narrowed = reasoningEffortDomain("openrouter", { effort_levels: levels });
      expect(narrowed, levels.join("/")).not.toEqual(base);
      expect(narrowed.every((e) => base.includes(e)), `${levels.join("/")} left the base domain`).toBe(true);
    }
  });
});

describe("keyApplicability", () => {
  test("it answers for every settable key, on every sdk", () => {
    for (const sdk of SDK_VARIANTS) {
      const table = keyApplicability(sdk);
      expect(Object.keys(table).sort()).toEqual([...SAMPLER_KEYS].sort());
      for (const [key, verdict] of Object.entries(table)) {
        expect(["honored", "ignored", "rejected", "always"], `${sdk} ${key}`).toContain(verdict);
      }
    }
  });

  test("a vendor key is honored on its own sdk and ignored elsewhere", () => {
    for (const [key, owner] of [
      ["cache_ttl", "anthropic"],
      ["openrouter_provider", "openrouter"],
      ["gemini_generation", "gemini"],
      ["zai_clear_thinking", "zai"],
    ] as const) {
      for (const sdk of SDK_VARIANTS) {
        expect(keyApplicability(sdk)[key], `${key} on ${sdk}`).toBe(
          sdk === owner ? "honored" : "ignored",
        );
      }
    }
  });

  test("sampling is rejected on the models that reject it, honored on the rest", () => {
    expect(
      keyApplicability("anthropic", {
        supported_parameters: ["reasoning", "max_tokens"],
      })["temperature"],
    ).toBe("rejected");
    expect(keyApplicability("anthropic")["temperature"]).toBe(
      "honored",
    );
  });
});

describe("what a rejection says, and what a value is stored as", () => {
  function refusal(key: string, value: unknown): string {
    const sampler: SamplerSettings = {};
    try {
      applySamplerValue(sampler, key, value);
    } catch (e) {
      return (e as CommandError).message;
    }
    throw new Error(`${key} accepted ${String(value)}`);
  }

  test("each key is refused under its own name", () => {
    expect(refusal("temperature", "warm")).toContain("temperature must be a number");
    expect(refusal("top_p", "wide")).toContain("top_p must be a number");
    expect(refusal("zai_clear_thinking", "yes")).toContain("zai_clear_thinking must be a boolean");
    expect(refusal("zai_subscription", "yes")).toContain("zai_subscription must be a boolean");
  });

  test("the offending value is quoted, so an empty string is visible", () => {
    expect(refusal("sdk", "nope")).toContain('got "nope"');
    expect(refusal("sdk", "")).toContain('got ""');
  });

  test("a keepalive that will not parse says which key it was", () => {
    expect(refusal("cache_keepalive", "soon")).toContain("cache_keepalive: ");
  });

  test("cache_ttl is stored as written — it is not a keepalive", () => {
    const sampler: SamplerSettings = {};
    applySamplerValue(sampler, "cache_ttl", "banana");
    expect(sampler.cacheTtl, "cache_ttl takes any string; the provider validates it").toBe(
      "banana",
    );
  });

  test("an sdk is stored as the user spelled it, not canonicalised", () => {
    const sampler: SamplerSettings = {};
    applySamplerValue(sampler, "sdk", "moonshotai");
    expect(sampler.sdk).toBe("moonshotai");
  });

  test("a u32 takes its whole range and nothing past it", () => {
    const sampler: SamplerSettings = {};
    applySamplerValue(sampler, "budget_tokens", 0xff_ff_ff_ff);
    expect(sampler.budgetTokens).toBe(0xff_ff_ff_ff);
    expect(refusal("budget_tokens", 0x1_00_00_00_00)).toContain("fitting in u32");
  });

  test("one tool iteration is a legal setting; zero is not", () => {
    const sampler: SamplerSettings = {};
    applySamplerValue(sampler, "max_tool_iterations", 1);
    expect(sampler.maxToolIterations).toBe(1);
    expect(refusal("max_tool_iterations", 0)).toBeTruthy();
  });

  test("a null anywhere in a provider preference is refused, at any depth", () => {
    expect(refusal("openrouter_provider", { order: [null] })).toBeTruthy();
    expect(refusal("openrouter_provider", { order: { first: null } })).toBeTruthy();
    expect(refusal("openrouter_provider", { nested: { deeper: [null] } })).toBeTruthy();
  });

  test("clearing one key leaves the others alone", () => {
    const sampler: SamplerSettings = {};
    applySamplerValue(sampler, "temperature", 0.7);
    applySamplerValue(sampler, "top_p", 0.9);
    applySamplerValue(sampler, "temperature", null);

    expect(sampler.temperature).toBeUndefined();
    expect(sampler.topP).toBe(0.9);
  });
});

describe("the keys with no applicability matrix", () => {
  test("they answer `always`, not a verdict they never had", () => {
    const table = keyApplicability("anthropic");
    for (const key of ["sdk", "max_tool_iterations", "supports_images"]) {
      expect(table[key], `${key} has no Field, so no sdk can have an opinion`).toBe("always");
    }
    expect(table["temperature"]).toBe("honored");
  });
});

describe("capabilityCheck, past the honored/ignored split", () => {
  test("a rejected key is refused, not merely reported", () => {
    const rejectsSampling = { supported_parameters: ["reasoning", "max_tokens"] };
    expect(
      capabilityCheck("openrouter", "temperature", 0.7, rejectsSampling),
    ).toBeInstanceOf(CommandError);
  });

  test("`off` is a reasoning_effort sentinel, and not a licence for other keys", () => {
    expect(capabilityCheck("anthropic", "reasoning_effort", "off")).toBeUndefined();
    expect(
      capabilityCheck("anthropic", "cache_keepalive", "off"),
      "`off` is a real keepalive value and must still go through its own parse",
    ).toBeUndefined();
  });
});
