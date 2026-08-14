import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { turnToOpenAI } from "../src/llm/providers/openai.ts";
import type { TurnMessage } from "../src/llm/types.ts";

const FIXTURE_DIR = join(import.meta.dir, "fixtures");

interface Fixture {
  source: string;
  sdk: string;
  model: string;
  messages: TurnMessage[];
}

function loadFixtures(): Array<{ name: string; fx: Fixture }> {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({
      name: f.replace(/\.json$/, ""),
      fx: JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) as Fixture,
    }));
}

function convert(fx: Fixture): Array<Record<string, unknown>> {
  return fx.messages.flatMap(
    (turn) => turnToOpenAI(turn) as unknown as Array<Record<string, unknown>>,
  );
}

const fixtures = loadFixtures();

test("fixtures are present", () => {
  expect(fixtures.length).toBeGreaterThan(0);
});

describe("OpenAI conversion regression (real production sequences)", () => {
  for (const { name, fx } of fixtures) {
    describe(name, () => {
      const out = convert(fx);

      test("assistant thinking blocks emit reasoning_content; nothing else does", () => {
        let cursor = 0;
        for (const turn of fx.messages) {
          const emitted = turnToOpenAI(turn) as unknown as Array<Record<string, unknown>>;
          const slice = out.slice(cursor, cursor + emitted.length);
          cursor += emitted.length;

          const thinking = turn.content
            .filter((b) => b.type === "thinking")
            .map((b) => (b as { thinking: string }).thinking)
            .join("\n\n");
          for (const msg of slice) {
            expect(msg).not.toHaveProperty("reasoning");
            if (msg["role"] === "assistant" && thinking) {
              expect(msg["reasoning_content"]).toBe(thinking);
            } else {
              expect(msg).not.toHaveProperty("reasoning_content");
            }
          }
        }
        expect(cursor).toBe(out.length);
      });

      test("never emits content:null (assistant tool-call turns omit content)", () => {
        for (const msg of out) {
          if (msg["role"] === "assistant" && "content" in msg) {
            expect(msg["content"]).not.toBeNull();
          }
        }
      });

      test("tool_use → assistant.tool_calls; tool_result → role:tool, ids paired", () => {
        const announced = new Set<string>();
        const srcToolUseIds: string[] = [];
        const srcToolResultIds: string[] = [];
        for (const turn of fx.messages) {
          for (const b of turn.content) {
            if (b.type === "tool_use") srcToolUseIds.push(b.id);
            if (b.type === "tool_result") srcToolResultIds.push(b.tool_use_id);
          }
        }

        const emittedToolCallIds: string[] = [];
        const toolMsgIds: string[] = [];
        for (const msg of out) {
          if (msg["role"] === "assistant" && Array.isArray(msg["tool_calls"])) {
            for (const tc of msg["tool_calls"] as Array<Record<string, unknown>>) {
              expect(tc["type"]).toBe("function");
              const id = String(tc["id"]);
              announced.add(id);
              emittedToolCallIds.push(id);
            }
          }
          if (msg["role"] === "tool") {
            const id = String(msg["tool_call_id"]);
            toolMsgIds.push(id);
            expect(announced.has(id)).toBe(true);
          }
        }

        expect(emittedToolCallIds.sort()).toEqual([...srcToolUseIds].sort());
        expect(toolMsgIds.sort()).toEqual([...srcToolResultIds].sort());
      });

      test("every emitted message has a valid role", () => {
        for (const msg of out) {
          expect(["system", "user", "assistant", "tool"]).toContain(
            String(msg["role"]),
          );
        }
      });
    });
  }
});
