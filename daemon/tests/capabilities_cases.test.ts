/**
 * Recorded cases for capabilities.
 *
 * These cases were captured from the deleted Rust port. That is where they
 * came from, not what makes them right: the port is gone, this side is the
 * implementation, and a case that turns out to disagree with what shore
 * should do gets corrected here rather than shimmed around. The corpus is
 * worth keeping for its inputs, which are hard to re-derive by hand.
 */
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

// Shared with the Rust tests (originally shared with the deleted port's own tests):
// both reimplementations of the parser + rule evaluator must agree with these.
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
