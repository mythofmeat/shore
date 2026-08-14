import { expect, test } from "bun:test";

import {
  effortBudget,
  foldEffort,
  geminiLevelName,
  modelOverrideRejectsSampling,
  reasoningDomain,
  rejectsSampling,
} from "../src/llm/capabilities.ts";

test("openai/openrouter accept xhigh and max (both passthrough)", () => {
  for (const sdk of ["openai", "openrouter"] as const) {
    expect(reasoningDomain(sdk)).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(foldEffort(sdk, "xhigh")).toBe("xhigh");
    expect(foldEffort(sdk, "high")).toBe("high");
    expect(foldEffort(sdk, "max")).toBe("max");
  }
});

test("anthropic keeps max/xhigh; effort→budget table intact", () => {
  expect(reasoningDomain("anthropic")).toContain("max");
  expect(reasoningDomain("anthropic")).toContain("xhigh");
  expect(effortBudget("max")).toBe(24576);
  expect(effortBudget("xhigh")).toBe(16384);
  expect(effortBudget("medium")).toBe(8192);
});

test("gemini thinking levels stop at high", () => {
  expect(geminiLevelName("high")).toBe("high");
  expect(geminiLevelName("max")).toBeUndefined();
  expect(geminiLevelName("xhigh")).toBeUndefined();
});

test("gemini-3.1 Pro drops `minimal` via model_override (Flash keeps it)", () => {
  const pro = "google/gemini-3.1-pro-preview";
  expect(reasoningDomain("gemini", pro)).toEqual(["low", "medium", "high"]);
  expect(foldEffort("gemini", "minimal", pro)).toBeUndefined();
  expect(foldEffort("gemini", "low", pro)).toBe("low");
  for (const flash of [
    "google/gemini-3.1-flash-image-preview",
    "google/gemini-3.1-flash-lite",
    "gemini-3.5-flash",
  ]) {
    expect(reasoningDomain("gemini", flash)).toContain("minimal");
  }
});

test("OpenRouter per-vendor reasoning domains (issue #164)", () => {
  expect(reasoningDomain("openrouter", "google/gemini-2.5-flash")).toEqual([
    "minimal",
    "low",
    "medium",
    "high",
  ]);
  expect(reasoningDomain("openrouter", "google/gemini-3.1-pro")).toEqual(["low", "medium", "high"]);
  expect(reasoningDomain("openrouter", "x-ai/grok-4.3")).toEqual(["low", "medium", "high"]);
  const generic = ["minimal", "low", "medium", "high", "xhigh", "max"];
  expect(reasoningDomain("openrouter", "moonshotai/kimi-k2.6")).toEqual(generic);
  expect(reasoningDomain("openrouter", "z-ai/glm-5.1")).toEqual(generic);
  expect(reasoningDomain("openrouter", "some-vendor/mystery")).toEqual(generic);
});

test("OpenRouter o-series reject samplers; GPT-5 does not (issue #164)", () => {
  for (const id of ["openai/o1-mini", "openai/o3", "openai/o4-mini"]) {
    expect(modelOverrideRejectsSampling(id), id).toBe(true);
    expect(rejectsSampling(id), id).toBe(true);
  }
  expect(modelOverrideRejectsSampling("openai/gpt-5")).toBe(false);
  expect(rejectsSampling("openai/gpt-5")).toBe(false);
  expect(rejectsSampling("claude-opus-4-8")).toBe(true);
});
