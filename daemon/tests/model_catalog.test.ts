import { describe, expect, test } from "bun:test";

import {
  applicability,
  defaultValue,
  FIELDS,
  fieldFromKey,
  rejectsSampling,
  type Field,
} from "../src/llm/capabilities.ts";
import { SDK_VARIANTS } from "../src/config/models.ts";

const MODELS = [
  "",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-haiku-4-5",
  "anthropic/claude-opus-4-7",
  "gpt-5.6",
  "o3-mini",
  "gemini-3.1-pro",
] as const;

const VERDICTS = ["honored", "ignored", "rejected"];

const CAPABILITY_SHAPES = [
  undefined,
  { supported_parameters: ["temperature", "top_p", "reasoning"] },
  { supported_parameters: ["reasoning", "max_tokens"] },
] as const;

describe("applicability answers for every sdk, model and field", () => {
  test("it always answers, and always with one of the three verdicts", () => {
    for (const sdk of SDK_VARIANTS) {
      for (const model of MODELS) {
        for (const field of FIELDS) {
          expect(VERDICTS, `${sdk}/${model} ${field}`).toContain(applicability(sdk, model, field));
        }
      }
    }
  });

  test("a vendor field is honored on its own sdk and ignored on every other", () => {
    for (const [field, owner] of [
      ["cache_ttl", "anthropic"],
      ["openrouter_provider", "openrouter"],
      ["gemini_generation", "gemini"],
      ["zai_clear_thinking", "zai"],
      ["zai_subscription", "zai"],
    ] as const) {
      for (const sdk of SDK_VARIANTS) {
        for (const model of MODELS) {
          expect(applicability(sdk, model, field), `${field} on ${sdk}`).toBe(
            sdk === owner ? "honored" : "ignored",
          );
        }
      }
    }
  });

  test("the universal fields are honored everywhere", () => {
    for (const field of ["max_context_tokens", "max_output_tokens", "cache_keepalive", "reasoning_effort"] as Field[]) {
      for (const sdk of SDK_VARIANTS) {
        for (const model of MODELS) {
          expect(applicability(sdk, model, field), `${field} on ${sdk}/${model}`).toBe("honored");
        }
      }
    }
  });

  test("sampling is decided by the discovered model, not the sdk", () => {
    for (const field of ["temperature", "top_p"] as Field[]) {
      for (const caps of CAPABILITY_SHAPES) {
        const want = rejectsSampling(caps) ? "rejected" : "honored";
        for (const sdk of SDK_VARIANTS) {
          for (const model of MODELS) {
            expect(applicability(sdk, model, field, caps), `${field} on ${sdk}/${model}`).toBe(want);
          }
        }
      }
    }
  });

  test("temperature and top_p are never split", () => {
    for (const sdk of SDK_VARIANTS) {
      for (const model of MODELS) {
        for (const caps of CAPABILITY_SHAPES) {
          expect(applicability(sdk, model, "temperature", caps), `${sdk}/${model}`).toBe(
            applicability(sdk, model, "top_p", caps),
          );
        }
      }
    }
  });

  test("budget_tokens is honored only where a thinking budget exists", () => {
    for (const model of MODELS) {
      expect(applicability("gemini", model, "budget_tokens")).toBe("honored");
      expect(applicability("moonshot", model, "budget_tokens")).toBe("honored");
      for (const sdk of ["openai", "openrouter", "zai", "deepseek"] as const) {
        expect(applicability(sdk, model, "budget_tokens"), `${sdk}/${model}`).toBe("ignored");
      }
    }
    expect(
      applicability("anthropic", "claude-opus-4-7", "budget_tokens", { thinking_enabled: false }),
    ).toBe("rejected");
    expect(applicability("anthropic", "claude-haiku-4-5", "budget_tokens")).toBe("honored");
  });

  test("replay_prior_thinking is ignored exactly where thinking is not replayed", () => {
    for (const model of MODELS) {
      for (const sdk of SDK_VARIANTS) {
        expect(applicability(sdk, model, "replay_prior_thinking"), sdk).toBe(
          sdk === "deepseek" || sdk === "moonshot" ? "ignored" : "honored",
        );
      }
    }
  });

  test("every field is reachable from a settings key, and back", () => {
    for (const field of FIELDS) {
      if (field === "max_context_tokens" || field === "max_output_tokens") continue;
      expect(fieldFromKey(field), `${field} has no key`).toBe(field);
    }
    expect(fieldFromKey("not_a_field")).toBeUndefined();
  });
});

describe("defaultValue", () => {
  test("only Anthropic starts a field at anything, and only cache_ttl", () => {
    for (const sdk of SDK_VARIANTS) {
      for (const field of FIELDS) {
        const want = sdk === "anthropic" && field === "cache_ttl" ? "1h" : undefined;
        expect(defaultValue(sdk, field), `${sdk} ${field}`).toBe(want);
      }
    }
  });

  test("cache_keepalive defaults to nothing on every sdk", () => {
    for (const sdk of SDK_VARIANTS) {
      expect(defaultValue(sdk, "cache_keepalive"), sdk).toBeUndefined();
    }
  });

  test("a default is only ever offered for a field the sdk honors", () => {
    for (const sdk of SDK_VARIANTS) {
      for (const field of FIELDS) {
        if (defaultValue(sdk, field) === undefined) continue;
        expect(applicability(sdk, "claude-opus-4-7", field), `${sdk} ${field}`).toBe("honored");
      }
    }
  });
});
