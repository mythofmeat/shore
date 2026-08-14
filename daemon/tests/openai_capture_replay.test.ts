import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { turnToOpenAI } from "../src/llm/providers/openai.ts";
import type { TurnMessage } from "../src/llm/types.ts";

const CAPTURES = [
  "deepseek_v4_textless_toolcalls",
  "deepseek_v4_thinking_replay",
  "glm_toolloop",
  "kimi_k2_toolloop",
] as const;

interface Capture {
  source: string;
  sdk: string;
  model: string;
  messages: TurnMessage[];
}

function capture(name: string): Capture {
  return JSON.parse(
    readFileSync(join(import.meta.dir, "fixtures", `${name}.json`), "utf8"),
  ) as Capture;
}

const convert = (messages: TurnMessage[]) => messages.flatMap((m) => turnToOpenAI(m));

type Converted = ReturnType<typeof convert>[number];

const isAssistant = (m: Converted) => m.role === "assistant";

function toolCallIds(messages: Converted[]): string[] {
  return messages.flatMap((m) =>
    isAssistant(m)
      ? ((m as { tool_calls?: { id: string }[] }).tool_calls ?? []).map((t) => t.id)
      : [],
  );
}

function toolReplyIds(messages: Converted[]): string[] {
  return messages.flatMap((m) =>
    m.role === "tool" ? [(m as { tool_call_id: string }).tool_call_id] : [],
  );
}

describe("the captured conversations are what the tests claim", () => {
  for (const name of CAPTURES) {
    test(`${name} is a real capture of the OpenAI-compat path`, () => {
      const c = capture(name);
      expect(c.sdk).toBe("Openai");
      expect(c.model).not.toBe("");
      expect(c.messages.length).toBeGreaterThan(10);
    });
  }

  test("the set covers textless tool calls, thinking replay and tool loops", () => {
    const textless = capture("deepseek_v4_textless_toolcalls").messages.filter(
      (m) =>
        m.role === "assistant" &&
        m.content.some((b) => b.type === "tool_use") &&
        !m.content.some((b) => b.type === "text"),
    );
    expect(textless.length).toBeGreaterThan(0);

    const thinking = capture("deepseek_v4_thinking_replay").messages.filter((m) =>
      m.content.some((b) => b.type === "thinking"),
    );
    expect(thinking.length).toBeGreaterThan(0);
  });
});

describe("converting a capture produces a body a provider accepts", () => {
  for (const name of CAPTURES) {
    test(`${name}: every tool call is answered exactly once`, () => {
      const converted = convert(capture(name).messages);
      const issued = toolCallIds(converted);
      const answered = toolReplyIds(converted);

      expect(new Set(issued).size, "an id was issued twice").toBe(issued.length);
      expect([...answered].sort()).toEqual([...issued].sort());
    });

    test(`${name}: no assistant message carries an empty content string`, () => {
      for (const m of convert(capture(name).messages)) {
        if (!isAssistant(m)) continue;
        const content = (m as { content?: unknown }).content;
        expect(content, `${name} produced an empty assistant content`).not.toBe("");
      }
    });

    test(`${name}: every message has a role the API defines`, () => {
      for (const m of convert(capture(name).messages)) {
        expect(["system", "user", "assistant", "tool"]).toContain(m.role);
      }
    });
  }
});

describe("the converted prefix is stable as the conversation grows", () => {
  for (const name of CAPTURES) {
    test(`${name}: converting a prefix matches the prefix of converting it all`, () => {
      const messages = capture(name).messages;
      const whole = convert(messages);

      for (let n = 1; n < messages.length; n += 1) {
        const prefix = convert(messages.slice(0, n));
        expect(
          JSON.stringify(prefix),
          `turn ${n} of ${name} rewrote an earlier turn`,
        ).toBe(JSON.stringify(whole.slice(0, prefix.length)));
      }
    });
  }

  test("converting twice is byte-identical, so a retry reuses the prefix", () => {
    for (const name of CAPTURES) {
      const messages = capture(name).messages;
      expect(JSON.stringify(convert(messages))).toBe(JSON.stringify(convert(messages)));
    }
  });
});

describe("thinking replay reaches the wire as reasoning_content", () => {
  test("a thinking block becomes reasoning_content, not text and not nothing", () => {
    const messages = capture("deepseek_v4_thinking_replay").messages;
    const withThinking = messages.filter((m) => m.content.some((b) => b.type === "thinking"));
    expect(withThinking.length).toBeGreaterThan(0);

    for (const turn of withThinking) {
      const [converted] = turnToOpenAI(turn);
      const reasoning = (converted as unknown as Record<string, unknown>)["reasoning_content"];
      expect(typeof reasoning, "a thinking block was dropped").toBe("string");
      expect(reasoning).not.toBe("");
    }
  });
});
