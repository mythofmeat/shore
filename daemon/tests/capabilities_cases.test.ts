import { expect, test } from "bun:test";

import fixture from "./capability_cases.toml";
import {
  claudeThinkingCaps,
  parseClaudeModel,
  rejectsSampling,
} from "../src/llm/capabilities.ts";

interface Case {
  model: string;
  is_claude: boolean;
  rejects_sampling: boolean;
  adaptive?: boolean;
  enabled?: boolean;
}

const cases = (fixture as { case: Case[] }).case;

test("every recorded model resolves to the same claude shape", () => {
  expect(cases.length).toBeGreaterThan(0);
  for (const c of cases) {
    expect(parseClaudeModel(c.model) !== undefined, `is_claude: ${c.model}`).toBe(c.is_claude);
    expect(rejectsSampling(c.model), `rejects_sampling: ${c.model}`).toBe(c.rejects_sampling);
    if (c.adaptive !== undefined && c.enabled !== undefined) {
      expect(claudeThinkingCaps(c.model), `thinking: ${c.model}`).toEqual({
        adaptive: c.adaptive,
        enabled: c.enabled,
      });
    }
  }
});
