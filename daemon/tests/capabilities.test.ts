import { expect, test } from "bun:test";

import { ThinkingLevel } from "@google/genai";
import { ChatRequestEffort } from "@openrouter/sdk/models";

import {
  applicability,
  geminiLevelName,
  reasoningDomain,
  rejectsSampling,
  supportsReasoningOff,
  validate,
} from "../src/llm/capabilities.ts";

test("the openrouter domain is the sdk enum minus the disable sentinel", () => {
  const fromSdk = Object.values(ChatRequestEffort).filter((v) => v !== "none");
  expect([...reasoningDomain("openrouter")].sort()).toEqual([...fromSdk].sort());
  expect(reasoningDomain("openrouter")).toContain("max");
  expect(reasoningDomain("openrouter")).not.toContain("none");
});

test("the gemini domain is the sdk enum, lowercased, without the unspecified member", () => {
  expect([...reasoningDomain("gemini")].sort()).toEqual(["high", "low", "medium", "minimal"]);
  expect(geminiLevelName("high")).toBe(ThinkingLevel.HIGH);
  expect(geminiLevelName("minimal")).toBe(ThinkingLevel.MINIMAL);
  expect(geminiLevelName("xhigh")).toBeUndefined();
});

test("zai is a graded domain, not an on/off toggle", () => {
  expect(reasoningDomain("zai")).toContain("minimal");
  expect(reasoningDomain("zai")).toContain("max");
});

test("moonshot exposes the levels its provider accepts", () => {
  expect([...reasoningDomain("moonshot")].sort()).toEqual(["high", "low", "max"]);
});

test("a model with no discovered capabilities is permissive", () => {
  expect(rejectsSampling(undefined)).toBe(false);
  expect(applicability("openai", "mystery-model", "temperature")).toBe("honored");
  expect(applicability("openai", "mystery-model", "top_p")).toBe("honored");
  expect(validate("openai", "mystery-model", "reasoning_effort", "xhigh")).toBeUndefined();
});

test("discovered supported_parameters decide sampler applicability", () => {
  const reasoningOnly = { supported_parameters: ["reasoning", "max_tokens"] };
  expect(rejectsSampling(reasoningOnly)).toBe(true);
  expect(applicability("openrouter", "openai/o3", "temperature", reasoningOnly)).toBe("rejected");
  expect(applicability("openrouter", "openai/o3", "top_p", reasoningOnly)).toBe("rejected");

  const sampled = { supported_parameters: ["temperature", "top_p", "reasoning"] };
  expect(rejectsSampling(sampled)).toBe(false);
  expect(applicability("openrouter", "openai/gpt-5", "temperature", sampled)).toBe("honored");
});

test("discovered effort levels narrow the sdk domain", () => {
  const caps = { effort_levels: ["low", "medium", "high"] };
  expect(reasoningDomain("anthropic", caps)).toEqual(["low", "medium", "high"]);
  expect(validate("anthropic", "claude-opus-4-8", "reasoning_effort", "xhigh", caps)).toBeDefined();
  expect(validate("anthropic", "claude-opus-4-8", "reasoning_effort", "high", caps)).toBeUndefined();
});

test("an effort set the provider does not name at all falls back to the sdk domain", () => {
  const caps = { effort_levels: ["turbo"] };
  expect(reasoningDomain("openai", caps)).toEqual([...reasoningDomain("openai")]);
});

test("budget_tokens follows the discovered thinking capability", () => {
  expect(applicability("anthropic", "claude-opus-4-8", "budget_tokens")).toBe("honored");
  expect(
    applicability("anthropic", "claude-opus-4-8", "budget_tokens", { thinking_enabled: false }),
  ).toBe("rejected");
  expect(applicability("openai", "gpt-5.6", "budget_tokens")).toBe("ignored");
});

test("every sdk but gemini can turn reasoning off", () => {
  for (const sdk of ["anthropic", "openai", "openrouter", "zai", "deepseek", "moonshot"] as const) {
    expect(supportsReasoningOff(sdk), sdk).toBe(true);
  }
  expect(supportsReasoningOff("gemini")).toBe(false);
});
