/**
 * The capability tables the model catalog answers from: whether a field means
 * anything for an sdk and model, and what an sdk starts that field at.
 *
 * This replaces the `applicability` and `default_value` halves of
 * `model_resolution`, which recorded 728 and 91 rows respectively — the cartesian
 * product of 7 sdks, 8 model ids and 13 fields, filled in by a Rust binary that
 * no longer builds. The rules are `applicability` and `defaultValue` in
 * `capabilities.ts`, about sixty lines between them.
 *
 * The sweep is regenerated here from `SDK_VARIANTS` and `FIELDS`, so a new sdk
 * or field is covered on the day it lands. What it asserts is the shape of the
 * table rather than 819 recorded cells: a vendor field belongs to one sdk, a
 * universal field belongs to all of them, and the two model-shaped rules key on
 * the model rather than the sdk.
 */

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

/** Model ids that land on each branch the rules take, plus the empty string. */
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
    // The whole point of the table: setting `gemini_generation` on an Anthropic
    // model is not an error, it just does nothing.
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

  test("sampling is decided by the model, not the sdk", () => {
    for (const field of ["temperature", "top_p"] as Field[]) {
      for (const model of MODELS) {
        const want = rejectsSampling(model) ? "rejected" : "honored";
        for (const sdk of SDK_VARIANTS) {
          expect(applicability(sdk, model, field), `${field} on ${sdk}/${model}`).toBe(want);
        }
      }
    }
  });

  test("temperature and top_p are never split", () => {
    // They are one decision. A model that rejects one and honors the other
    // would be a rule someone wrote by hand and got half right.
    for (const sdk of SDK_VARIANTS) {
      for (const model of MODELS) {
        expect(applicability(sdk, model, "temperature"), `${sdk}/${model}`).toBe(
          applicability(sdk, model, "top_p"),
        );
      }
    }
  });

  test("budget_tokens is honored only where a thinking budget exists", () => {
    // Anthropic is model-shaped; the rest are flat per sdk.
    for (const model of MODELS) {
      expect(applicability("gemini", model, "budget_tokens")).toBe("honored");
      expect(applicability("moonshot", model, "budget_tokens")).toBe("honored");
      for (const sdk of ["openai", "openrouter", "zai", "deepseek"] as const) {
        expect(applicability(sdk, model, "budget_tokens"), `${sdk}/${model}`).toBe("ignored");
      }
    }
    expect(applicability("anthropic", "claude-opus-4-7", "budget_tokens")).toBe("rejected");
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
    // #47 moved the keepalive default to nothing. Two shapes save money against
    // a 1h TTL — a 55m cadence, or off — and choosing for every character is a
    // spend decision the config exists to make.
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
