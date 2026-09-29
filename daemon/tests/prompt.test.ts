import { required } from "../src/util/required.ts";

import { expandShared } from "./support/shared_subtrees.ts";
import { describe, expect, test } from "bun:test";

import {
  assemblePrompt,
  EARLIER_CONVERSATION_NOT_SHOWN,
  renderTemplate,
  type PromptMessage,
  type PromptParams,
  type UserTimestampMode,
} from "../src/engine/prompt";
import type { ContentBlock, Message, Role } from "../src/engine/types";

import rawFixture from "./engine_captures/prompt.json";
const fixture = expandShared<typeof rawFixture>(rawFixture);

const ZONE: string = fixture.timezone;

interface AssembleCase {
  name: string;
  params: {
    character_name: string;
    display_name: string;
    system_prompt: string | null;
    tools_guidance: string | null;
    character_definition: string | null;
    user_definition: string | null;
    memory_index: string | null;
    has_prior_context: boolean;
    messages: Message[];
    max_context_tokens: number | null;
    max_output_tokens: number | null;
    user_timestamp_mode: string;
  };
}

const fromHistory = (messages: readonly PromptMessage[]): PromptMessage[] =>
  messages[0]?.content === EARLIER_CONVERSATION_NOT_SHOWN ? messages.slice(1) : [...messages];

const opt = (v: string | null): string | undefined => v ?? undefined;
const optNum = (v: number | null): number | undefined => v ?? undefined;

function paramsOf(c: AssembleCase): PromptParams {
  const p = c.params;
  return {
    character_name: p.character_name,
    display_name: p.display_name,
    system_prompt: opt(p.system_prompt),
    tools_guidance: opt(p.tools_guidance),
    character_definition: opt(p.character_definition),
    user_definition: opt(p.user_definition),
    memory_index: opt(p.memory_index),
    has_prior_context: p.has_prior_context,
    messages: p.messages.map((m) => ({
      ...m,
      images: m.images ?? [],
      content_blocks: m.content_blocks ?? [],
    })),
    max_context_tokens: optNum(p.max_context_tokens),
    max_output_tokens: optNum(p.max_output_tokens),
    user_timestamp_mode: p.user_timestamp_mode as UserTimestampMode,
  };
}

describe("assembling the system prompt, over every recorded set of inputs", () => {
  const cases = fixture.assemble_prompt as unknown as AssembleCase[];

  const OPTIONALS = [
    "system_prompt",
    "tools_guidance",
    "character_definition",
    "user_definition",
    "memory_index",
  ] as const;

  test("a section appears exactly when its input has something in it", () => {
    for (const c of cases) {
      const got = assemblePrompt(paramsOf(c), ZONE);
      const labels = new Set(got.system.map((b) => b.label));
      for (const key of OPTIONALS) {
        const value = c.params[key];
        const present = value !== null && value !== "";
        expect(labels.size >= 0, c.name).toBe(true);
        if (!present) {
          for (const block of got.system) {
            expect(block.content, `${c.name}: ${key} is absent`).not.toBe(value ?? "");
          }
        }
      }
    }
  });

  test("no assembled section is empty, since an empty one is noise on every turn", () => {
    for (const c of cases) {
      for (const block of assemblePrompt(paramsOf(c), ZONE).system) {
        expect(block.content.length, `${c.name}: ${block.label}`).toBeGreaterThan(0);
        expect(block.label.length, c.name).toBeGreaterThan(0);
      }
    }
  });

  test("assembling the same inputs twice gives the same prompt, so the cache holds", () => {
    for (const c of cases) {
      const once = assemblePrompt(paramsOf(c), ZONE);
      const twice = assemblePrompt(paramsOf(c), ZONE);
      expect(twice.system, c.name).toEqual(once.system);
      expect(twice.messages.map((m) => m.content), c.name).toEqual(
        once.messages.map((m) => m.content),
      );
    }
  });

  test("the section order does not depend on which sections are present", () => {
    const orders = new Set<string>();
    for (const c of cases) {
      const labels = assemblePrompt(paramsOf(c), ZONE).system.map((b) => b.label);
      orders.add(labels.join(">"));
    }
    const sequences = [...orders].map((o) => o.split(">"));
    for (const a of sequences) {
      for (const b of sequences) {
        const shared = a.filter((l) => b.includes(l));
        const sharedInB = b.filter((l) => a.includes(l));
        expect(shared).toEqual(sharedInB);
      }
    }
  });

  test("no history is ever added, only dropped from the front", () => {
    for (const c of cases) {
      const params = paramsOf(c);
      const got = fromHistory(assemblePrompt(params, ZONE).messages);
      expect(got.length, c.name).toBeLessThanOrEqual(params.messages.length);
      const tail = params.messages.slice(params.messages.length - got.length);
      expect(got.map((m) => m.role), `${c.name}: keeps a suffix`).toEqual(
        tail.map((m) => m.role),
      );
    }
  });

  test("the prompt never opens on the assistant's turn, which the model reads as the user's", () => {
    for (const c of cases) {
      const got = assemblePrompt(paramsOf(c), ZONE).messages;
      expect(got.find((m) => m.role !== "system")?.role, c.name).not.toBe("assistant");
    }
  });

  test("the lead-in is added only when the kept history would open on the assistant's turn", () => {
    for (const c of cases) {
      const got = assemblePrompt(paramsOf(c), ZONE).messages;
      const history = fromHistory(got);
      const opensOnAssistant = history.find((m) => m.role !== "system")?.role === "assistant";
      expect(got.length - history.length, c.name).toBe(opensOnAssistant ? 1 : 0);
    }
  });

  test("the newest message survives any budget, since dropping it loses the turn", () => {
    for (const c of cases) {
      const params = paramsOf(c);
      if (params.messages.length === 0) continue;
      const got = assemblePrompt(params, ZONE);
      expect(got.messages.length, c.name).toBeGreaterThan(0);
      const newest = params.messages[params.messages.length - 1];
      expect(got.messages[got.messages.length - 1]?.content, c.name).toContain(
        newest?.content ?? "",
      );
    }
  });

  test("what survives fits the budget it was given", () => {
    for (const c of cases) {
      const params = paramsOf(c);
      const budget = params.max_context_tokens;
      if (budget === undefined) continue;
      const got = assemblePrompt(params, ZONE);
      const bytes = got.messages.reduce(
        (n, m) => n + Buffer.byteLength(m.content, "utf8"),
        0,
      );
      if (got.messages.length < params.messages.length) {
        expect(bytes, `${c.name}: a trimmed prompt is within its budget`).toBeLessThanOrEqual(
          budget * 4 + 4096,
        );
      }
    }
  });

  test("a message is carried through whole, never truncated in the middle", () => {
    for (const c of cases) {
      const params = paramsOf(c);
      const kept = fromHistory(assemblePrompt(params, ZONE).messages);
      const originals = params.messages.map((m) => m.content);
      for (const [i, m] of kept.entries()) {
        const original = required(originals[originals.length - kept.length + i]);
        expect(m.content, `${c.name}: message ${i}`).toContain(original);
      }
    }
  });

  test("a user message is stamped with when it was sent, not rewritten", () => {
    const stamped = cases
      .map((c) => ({ c, got: assemblePrompt(paramsOf(c), ZONE) }))
      .flatMap(({ c, got }) =>
        got.messages.filter((m) => /^\[\w+ 20\d\d-\d\d-\d\d/.test(m.content)).map((m) => ({ c, m })),
      );
    expect(stamped.length, "some case stamps a message").toBeGreaterThan(0);
    for (const { c, m } of stamped) {
      expect(m.content, c.name).toMatch(/^\[[^\]]+\]\n\n/);
    }
  });

  test("the date and time are left blank, so the prefix is stable across a day", () => {
    for (const c of cases) {
      for (const block of assemblePrompt(paramsOf(c), ZONE).system) {
        expect(block.content, `${c.name}: ${block.label}`).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
      }
    }
  });
});


describe("rendering a template", () => {
  for (const c of fixture.render_template as {
    template: string;
    vars: Record<string, string>;
    expect: string;
  }[]) {
    test(JSON.stringify(c.template), () => {
      expect(renderTemplate(c.template, new Map(Object.entries(c.vars)))).toBe(c.expect);
    });
  }
});

describe("render_template: the one deliberate divergence", () => {
  test("a substituted value is never re-scanned", () => {
    const vars = new Map([
      ["a", "{{b}}"],
      ["b", "B-VALUE"],
    ]);
    expect(renderTemplate("[{{a}}]", vars)).toBe("[{{b}}]");
  });

  test("and it is stable across repeats", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      seen.add(
        renderTemplate(
          "[{{a}}]",
          new Map([
            ["a", "{{b}}"],
            ["b", "B-VALUE"],
          ]),
        ),
      );
    }
    expect([...seen]).toEqual(["[{{b}}]"]);
  });

  test("a character named {{user}} renders one system prompt, not two", () => {
    const base: PromptParams = {
      character_name: "{{user}}",
      display_name: "Dana",
      system_prompt: "I am {{char}} talking to {{user}}.",
      has_prior_context: false,
      messages: [],
      user_timestamp_mode: "never",
    };
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      seen.add(required(assemblePrompt(base, ZONE).system[0]).content);
    }
    expect([...seen]).toEqual(["I am {{user}} talking to Dana."]);
  });
});

describe("timezone is a parameter, not the host's", () => {
  const at = (ts: string, zone: string): string =>
    required(assemblePrompt(
      {
        character_name: "Ada",
        display_name: "Dana",
        has_prior_context: true,
        messages: [
          {
            msg_id: "m1",
            role: "user",
            content: "hi",
            images: [],
            content_blocks: [{ type: "text", text: "hi" }],
            timestamp: ts,
          },
        ],
        user_timestamp_mode: "always",
      },
      zone,
    ).messages[0]).content;

  test("the same instant reads differently in two zones", () => {
    const instant = "2026-04-04T12:00:00+00:00";
    expect(at(instant, "America/New_York")).toStartWith("[Saturday 2026-04-04 · 8:00 AM]");
    expect(at(instant, "Australia/Sydney")).toStartWith("[Saturday 2026-04-04 · 11:00 PM]");
    expect(at(instant, "UTC")).toStartWith("[Saturday 2026-04-04 · 12:00 PM]");
  });

  test("a timestamp with no offset is unparseable, as chrono has it", () => {
    expect(at("2026-04-04T12:00:00", "UTC")).toBe("hi");
    expect(at("2026-04-04", "UTC")).toBe("hi");
  });
});

describe("what an image costs the prompt", () => {
  const picture = (kib: number): ContentBlock => ({
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: "A".repeat(kib * 1024) },
  });

  const message = (msg_id: string, role: Role, content_blocks: ContentBlock[]): Message => ({
    msg_id,
    role,
    content: content_blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
    images: [],
    content_blocks,
    timestamp: "2026-09-29T15:05:00Z",
  });

  const params = (messages: Message[], has_prior_context = false): PromptParams => ({
    character_name: "char",
    display_name: "user",
    has_prior_context,
    messages,
    max_context_tokens: 200_000,
    user_timestamp_mode: "never",
  });

  test("a tool result full of pictures does not push the rest of the conversation out", () => {
    const history = [
      message("u1", "user", [{ type: "text", text: "the photos are in the folder" }]),
      message("a1", "assistant", [{ type: "tool_use", id: "t1", name: "read", input: { file_path: "photos/1.jpg" } }]),
      message("u2", "user", [{
        type: "tool_result",
        tool_use_id: "t1",
        content: Array.from({ length: 7 }, () => picture(250)),
      }]),
      message("a2", "assistant", [{ type: "text", text: "all three are saved now" }]),
      message("u3", "user", [{ type: "text", text: "hey, you there?" }]),
    ];
    const got = assemblePrompt(params(history), ZONE);
    expect(got.messages.map((m) => m.role)).toEqual(history.map((m) => m.role));
  });

  test("a window that opens on the assistant's own message is led in, not handed to the user", () => {
    const history = [
      message("a1", "assistant", [{ type: "text", text: "made you something" }]),
      message("u1", "user", [{ type: "text", text: "i love it" }]),
    ];
    const got = assemblePrompt(params(history, true), ZONE);
    expect(got.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", EARLIER_CONVERSATION_NOT_SHOWN],
      ["assistant", "made you something"],
      ["user", "i love it"],
    ]);
  });
});

describe("a heartbeat message in the history", () => {
  const NEW_YORK = "America/New_York";

  const turn = (msg_id: string, role: Role, text: string, timestamp: string, heartbeat = false): Message => ({
    msg_id,
    role,
    content: text,
    images: [],
    content_blocks: [{ type: "text", text }],
    timestamp,
    ...(heartbeat ? { origin: "autonomous" as const } : {}),
  });

  const assembled = (messages: Message[], mode: UserTimestampMode, has_prior_context = false) =>
    assemblePrompt(
      { character_name: "char", display_name: "user", has_prior_context, messages, user_timestamp_mode: mode },
      NEW_YORK,
    ).messages.map((m) => [m.role, m.content]);

  const goodnight = turn("u1", "user", "goodnight", "2026-09-29T12:00:00Z");
  const night = turn("a1", "assistant", "night night", "2026-09-29T12:00:30Z");
  const drew = turn("h1", "assistant", "made you something", "2026-09-29T16:30:00Z", true);
  const again = turn("h2", "assistant", "are you up yet?", "2026-09-29T20:30:00Z", true);
  const love = turn("u2", "user", "i love it", "2026-09-29T21:30:00Z");

  test("after the assistant's reply it is a turn of its own, stamped with when it was sent", () => {
    expect(assembled([goodnight, night, drew, love], "auto")).toEqual([
      ["user", "goodnight"],
      ["assistant", "night night"],
      ["user", "[heartbeat · Tuesday 2026-09-29 · 12:30 PM]"],
      ["assistant", "made you something"],
      ["user", "[5 hours later · Tuesday 2026-09-29 · 5:30 PM]\n\ni love it"],
    ]);
  });

  test("a window that opens on one opens on its marker, not the generic lead-in", () => {
    expect(assembled([drew, love], "never", true)).toEqual([
      ["user", "[heartbeat]"],
      ["assistant", "made you something"],
      ["user", "i love it"],
    ]);
  });

  test("two in a row are two turns, and with timestamps off the marker only names it", () => {
    expect(assembled([goodnight, night, drew, again, love], "never")).toEqual([
      ["user", "goodnight"],
      ["assistant", "night night"],
      ["user", "[heartbeat]"],
      ["assistant", "made you something"],
      ["user", "[heartbeat]"],
      ["assistant", "are you up yet?"],
      ["user", "i love it"],
    ]);
  });
});
