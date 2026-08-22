import { describe, expect, test } from "bun:test";

import {
  appendWrapUpNudge,
  budgetDecision,
  buildAutonomousMessage,
  buildHeartbeatPrompt,
  captureToolSendMessage,
  extractSendMessage,
  extractToolSendMessage,
  generatedImageRef,
  isSendMessageTool,
  renderHeartbeatPrompt,
  WRAP_UP_NUDGE_TEXT,
  type BudgetAction,
  type ImageRef,
  type ToolUse,
  type WireMessageLike,
  type WireRole,
} from "../src/autonomy/heartbeat_shape.ts";

interface Fixture {
  send_message_tag: { content: string; extracted: string | null }[];
  send_message_tool_names: { name: string; is_send_message: boolean }[];
  send_message_tool_input: { input: unknown; extracted: string | null }[];
  capture_across_one_iteration: Record<string, string | null>;
  budget: {
    deadline_reached: boolean;
    normal_cap_reached: boolean;
    wrap_up_grace: number;
    wrap_up_nudged: boolean;
    action: BudgetAction;
  }[];
  wrap_up_nudge_text: string;
  wrap_up_nudge_placement: Record<
    string,
    { message_count: number; last_role: string | null; last_block_count: number | null }
  >;
  autonomous_message: Record<
    string,
    {
      role: string;
      origin: string | null;
      content: string;
      content_block_count: number;
      image_count: number;
      provider_key: string | null;
      model: string | null;
    }
  >;
  generated_image_ref: {
    value: unknown;
    image_ref: { path: string; caption: string | null; data_is_none: boolean } | null;
  }[];
}

const fixture = (await Bun.file(
  new URL("./autonomy_captures/heartbeat_shape.json", import.meta.url),
).json()) as Fixture;

const opt = (value: string | null): string | undefined => value ?? undefined;

describe("what a heartbeat asked to send", () => {
  test("the tag, over every shape the Rust was driven with", () => {
    expect(fixture.send_message_tag.length).toBeGreaterThan(0);
    for (const { content, extracted } of fixture.send_message_tag) {
      expect(extractSendMessage(content), JSON.stringify(content)).toBe(opt(extracted));
    }
  });

  test("the tool names it hallucinates instead", () => {
    for (const { name, is_send_message } of fixture.send_message_tool_names) {
      expect(isSendMessageTool(name), name).toBe(is_send_message);
    }
  });

  test("the field it puts the text in", () => {
    for (const { input, extracted } of fixture.send_message_tool_input) {
      expect(extractToolSendMessage(input), JSON.stringify(input)).toBe(opt(extracted));
    }
  });

  test("and which call wins across one round", () => {
    const cases: Record<string, readonly ToolUse[]> = {
      none: [["tu_1", "read", { path: "a" }]],
      one: [["tu_1", "sendMessage", { message: "hi" }]],
      last_wins: [
        ["tu_1", "sendMessage", { message: "first" }],
        ["tu_1", "send_message", { text: "second" }],
      ],
      skips_other_tools: [
        ["tu_1", "read", { path: "a" }],
        ["tu_1", "sendMessage", { message: "only me" }],
        ["tu_1", "write", { path: "b" }],
      ],
      empty_input_ignored: [
        ["tu_1", "sendMessage", { message: "kept" }],
        ["tu_1", "sendMessage", {}],
      ],
    };
    for (const [name, expected] of Object.entries(fixture.capture_across_one_iteration)) {
      const calls = cases[name];
      expect(calls, `fixture case ${name} has no replay`).toBeDefined();
      expect(captureToolSendMessage(calls ?? []), name).toBe(opt(expected));
    }
  });
});

describe("when the tool loop stops", () => {
  test("every combination the Rust was swept over", () => {
    expect(fixture.budget.length).toBe(24);
    for (const c of fixture.budget) {
      const label = `deadline=${c.deadline_reached} cap=${c.normal_cap_reached} grace=${c.wrap_up_grace} nudged=${c.wrap_up_nudged}`;
      expect(
        budgetDecision(c.deadline_reached, c.normal_cap_reached, c.wrap_up_grace, c.wrap_up_nudged),
        label,
      ).toBe(c.action);
    }
  });

  test("the nudge text is byte-identical", () => {
    expect(WRAP_UP_NUDGE_TEXT).toBe(fixture.wrap_up_nudge_text);
  });

  test("and it lands where a provider will accept it", () => {
    const build = (role: WireRole | undefined): WireMessageLike[] =>
      role === undefined ? [] : [{ role, content: [{ type: "text", text: "tail" }] }];

    const cases: Record<string, WireRole | undefined> = {
      onto_trailing_user: "user",
      after_trailing_assistant: "assistant",
      onto_empty_request: undefined,
    };
    for (const [name, role] of Object.entries(fixture.wrap_up_nudge_placement)) {
      const messages = build(cases[name]);
      appendWrapUpNudge(messages);
      const last = messages[messages.length - 1];
      expect(messages.length, name).toBe(role.message_count);
      expect(last?.role as string | undefined, name).toBe(role.last_role ?? undefined);
      expect(last?.content.length, name).toBe(role.last_block_count ?? undefined);
    }
  });
});

describe("the message it ends up sending", () => {
  test("matches the Rust in every shape, image-only included", () => {
    const image: ImageRef = { path: "img/a.png", caption: "a cat", data: undefined };
    const built = {
      text_only: buildAutonomousMessage("hello there", [], "anthropic", "claude-opus-4-6"),
      image_only: buildAutonomousMessage("", [image], undefined, undefined),
      text_and_image: buildAutonomousMessage("look", [image], "anthropic", "claude-opus-4-6"),
    };

    for (const [name, expected] of Object.entries(fixture.autonomous_message)) {
      const actual = built[name as keyof typeof built];
      expect(actual, `fixture case ${name} has no replay`).toBeDefined();
      expect(actual.role as string, name).toBe(expected.role);
      expect(actual.origin as string, name).toBe(expected.origin ?? "");
      expect(actual.content, name).toBe(expected.content);
      expect(actual.contentBlocks.length, name).toBe(expected.content_block_count);
      expect(actual.images.length, name).toBe(expected.image_count);
      expect(actual.providerKey, name).toBe(opt(expected.provider_key));
      expect(actual.model, name).toBe(opt(expected.model));
    }
  });

  test("an image-only tick carries no empty text block", () => {
    const built = buildAutonomousMessage("", [{ path: "img/a.png" }], undefined, undefined);
    expect(built.contentBlocks).toEqual([]);
    expect(built.content).toBe("");
  });

  test("and an image reference needs a path to exist at all", () => {
    for (const { value, image_ref } of fixture.generated_image_ref) {
      const actual = generatedImageRef(value);
      const label = JSON.stringify(value);
      if (image_ref === null) {
        expect(actual, label).toBeUndefined();
        continue;
      }
      expect(actual?.path, label).toBe(image_ref.path);
      expect(actual?.caption, label).toBe(opt(image_ref.caption));
      expect(actual?.data === undefined, label).toBe(image_ref.data_is_none);
    }
  });
});

describe("the prompt", () => {
  test("renders time and user into the built-in template", () => {
    const prompt = buildHeartbeatPrompt("Thursday 2026-07-30 · 9:00 AM", "Sam", "1 hour");
    expect(prompt).toStartWith("[Current time: Thursday 2026-07-30 · 9:00 AM]");
    expect(prompt).toContain("send a message to Sam");
    expect(prompt).toContain("delivered to Sam");
    expect(prompt).not.toContain("{{");
    expect(prompt).not.toContain("${");
  });

  test("the built-in template no longer spends the interval variable", () => {
    const withOneHour = buildHeartbeatPrompt("Thursday 2026-07-30 · 9:00 AM", "Sam", "1 hour");
    const withThree = buildHeartbeatPrompt("Thursday 2026-07-30 · 9:00 AM", "Sam", "3 hours");
    expect(withThree).toBe(withOneHour);
  });

  test("renders a caller-supplied template through the same variables", () => {
    const prompt = renderHeartbeatPrompt(
      "[{{now}}] {{user}} wakes in {{default_interval}}",
      "Thursday 2026-07-30 · 9:00 AM",
      "Sam",
      "2 hours",
    );
    expect(prompt).toBe("[Thursday 2026-07-30 · 9:00 AM] Sam wakes in 2 hours");
  });
});
