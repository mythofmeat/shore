import { describe, expect, test } from "bun:test";

import { HELP, parseInput, parseSettingValue, parseToggle } from "../src/connections/matrix/commands.ts";
import { preview, renderCommandOutput } from "../src/connections/matrix/render.ts";

describe("plain text", () => {
  test("anything without a leading bang is a message, whitespace intact", () => {
    expect(parseInput("hello there")).toEqual({ kind: "text", text: "hello there" });
    expect(parseInput("  leading space matters\n")).toEqual({
      kind: "text",
      text: "  leading space matters\n",
    });
  });

  test("a bang inside the line is not a command", () => {
    expect(parseInput("what about !status")).toMatchObject({ kind: "text" });
  });
});

describe("commands the bridge answers itself", () => {
  test("help", () => {
    expect(parseInput("!help")).toEqual({ kind: "reply", text: HELP });
  });

  test("bind, with and without a character", () => {
    expect(parseInput("!bind")).toEqual({ kind: "bind", character: undefined });
    expect(parseInput("!bind alice")).toEqual({ kind: "bind", character: "alice" });
    expect(parseInput("!unbind")).toEqual({ kind: "unbind" });
  });

  test("view takes a key and an optional toggle", () => {
    expect(parseInput("!view")).toEqual({ kind: "view", key: undefined, value: undefined });
    expect(parseInput("!view thinking")).toEqual({
      kind: "view",
      key: "thinking",
      value: undefined,
    });
    expect(parseInput("!view thinking on")).toEqual({
      kind: "view",
      key: "thinking",
      value: true,
    });
    expect(parseInput("!view tools off")).toEqual({ kind: "view", key: "tools", value: false });
  });

  test("the toggle words", () => {
    for (const on of ["on", "true", "yes", "1", "ON"]) expect(parseToggle(on)).toBe(true);
    for (const off of ["off", "false", "no", "0"]) expect(parseToggle(off)).toBe(false);
    expect(parseToggle("maybe")).toBeUndefined();
    expect(parseToggle(undefined)).toBeUndefined();
  });
});

describe("stream control", () => {
  test("regen and cancel carry nothing, trailing words and all", () => {
    expect(parseInput("!regen")).toEqual({ kind: "regen" });
    expect(parseInput("!regen be shorter")).toEqual({ kind: "regen" });
    expect(parseInput("!cancel")).toEqual({ kind: "cancel" });
  });
});

describe("commands that become daemon commands", () => {
  test("the argument-free ones", () => {
    expect(parseInput("!status")).toEqual({ kind: "command", name: "status", args: {} });
    expect(parseInput("!usage")).toEqual({ kind: "command", name: "usage", args: {} });
    expect(parseInput("!tools")).toEqual({ kind: "command", name: "tools", args: {} });
  });

  test("character lists with no argument and switches with one", () => {
    expect(parseInput("!character")).toEqual({
      kind: "command",
      name: "list_characters",
      args: {},
    });
    expect(parseInput("!character sage")).toEqual({
      kind: "command",
      name: "switch_character",
      args: { name: "sage" },
    });
  });

  test("model lists, unhides, resets and switches", () => {
    expect(parseInput("!model")).toEqual({
      kind: "command",
      name: "list_models",
      args: { include_hidden: false },
    });
    expect(parseInput("!model all")).toEqual({
      kind: "command",
      name: "list_models",
      args: { include_hidden: true },
    });
    expect(parseInput("!model reset")).toEqual({ kind: "command", name: "reset_model", args: {} });
    expect(parseInput("!model opus")).toEqual({
      kind: "command",
      name: "switch_model",
      args: { name: "opus" },
    });
  });

  test("setting lists, assigns typed values, and resets to null", () => {
    expect(parseInput("!setting")).toEqual({ kind: "command", name: "model_settings", args: {} });
    expect(parseInput("!setting temperature 0.7")).toEqual({
      kind: "command",
      name: "set_model_setting",
      args: { key: "temperature", value: 0.7 },
    });
    expect(parseInput("!setting stream true")).toMatchObject({ args: { value: true } });
    expect(parseInput("!setting temperature reset")).toMatchObject({ args: { value: null } });
    expect(parseInput("!setting temperature")).toMatchObject({ kind: "reply" });
  });

  test("setting values keep their type", () => {
    expect(parseSettingValue("0.7")).toBe(0.7);
    expect(parseSettingValue("12")).toBe(12);
    expect(parseSettingValue("true")).toBe(true);
    expect(parseSettingValue("false")).toBe(false);
    expect(parseSettingValue("reset")).toBeNull();
    expect(parseSettingValue("null")).toBeNull();
    expect(parseSettingValue("some words")).toBe("some words");
  });

  test("memory needs a query", () => {
    expect(parseInput("!memory the beach")).toEqual({
      kind: "command",
      name: "memory",
      args: { query: "the beach" },
    });
    expect(parseInput("!memory")).toMatchObject({ kind: "reply" });
  });

  test("log takes an optional turn count", () => {
    expect(parseInput("!log")).toEqual({ kind: "command", name: "log", args: {} });
    expect(parseInput("!log 20")).toEqual({ kind: "command", name: "log", args: { turns: 20 } });
    expect(parseInput("!log lots")).toEqual({ kind: "command", name: "log", args: {} });
  });

  test("compact takes dry and keep", () => {
    expect(parseInput("!compact")).toEqual({ kind: "command", name: "compact", args: {} });
    expect(parseInput("!compact dry")).toMatchObject({ args: { dry_run: true } });
    expect(parseInput("!compact keep 5")).toMatchObject({ args: { keep_turns: 5 } });
    expect(parseInput("!compact dry keep 5")).toMatchObject({
      args: { dry_run: true, keep_turns: 5 },
    });
    expect(parseInput("!compact keep")).toMatchObject({ kind: "reply" });
    expect(parseInput("!compact nonsense")).toMatchObject({ kind: "reply" });
  });

  test("delete takes one or more refs", () => {
    expect(parseInput("!delete m1")).toEqual({
      kind: "command",
      name: "delete",
      args: { refs: ["m1"] },
    });
    expect(parseInput("!delete m1 m2 m3")).toMatchObject({ args: { refs: ["m1", "m2", "m3"] } });
    expect(parseInput("!delete")).toMatchObject({ kind: "reply" });
  });

  test("edit splits the ref from the rest of the line", () => {
    expect(parseInput("!edit m1 the new content here")).toEqual({
      kind: "command",
      name: "edit",
      args: { ref: "m1", content: "the new content here" },
    });
    expect(parseInput("!edit m1")).toMatchObject({ kind: "reply" });
  });

  test("alt lists, steps by direction, and jumps by position", () => {
    expect(parseInput("!alt")).toEqual({ kind: "command", name: "list_alternatives", args: {} });
    expect(parseInput("!alt list")).toMatchObject({ name: "list_alternatives" });
    expect(parseInput("!alt next")).toEqual({
      kind: "command",
      name: "alt",
      args: { direction: "next" },
    });
    expect(parseInput("!alt prev")).toMatchObject({ args: { direction: "prev" } });
    expect(parseInput("!alt 2")).toEqual({ kind: "command", name: "alt", args: { position: 2 } });
    expect(parseInput("!alt sideways")).toMatchObject({ kind: "reply" });
  });

  test("sys injects text", () => {
    expect(parseInput("!sys remember the milk")).toEqual({
      kind: "command",
      name: "inject_system",
      args: { text: "remember the milk" },
    });
    expect(parseInput("!sys")).toMatchObject({ kind: "reply" });
  });
});

describe("the raw escape hatch and unmapped commands", () => {
  test("raw sends any command with JSON arguments", () => {
    expect(parseInput('!raw diagnostics {"count": 5}')).toEqual({
      kind: "command",
      name: "diagnostics",
      args: { count: 5 },
    });
    expect(parseInput("!raw config_check")).toEqual({
      kind: "command",
      name: "config_check",
      args: {},
    });
  });

  test("raw refuses arguments that are not a JSON object", () => {
    expect(parseInput("!raw thing {broken")).toMatchObject({ kind: "reply" });
    expect(parseInput("!raw thing [1,2]")).toMatchObject({ kind: "reply" });
    expect(parseInput("!raw")).toMatchObject({ kind: "reply" });
  });

  test("an unmapped bang with no arguments is passed through for the daemon to judge", () => {
    expect(parseInput("!session_activate")).toEqual({
      kind: "command",
      name: "session_activate",
      args: {},
    });
  });

  test("an unmapped bang with arguments says so rather than dropping them", () => {
    const parsed = parseInput("!something with args");
    expect(parsed.kind).toBe("reply");
    expect(parsed.kind === "reply" && parsed.text).toContain("!raw something");
  });

  test("the name is matched case-insensitively", () => {
    expect(parseInput("!STATUS")).toMatchObject({ name: "status" });
  });
});

describe("rendering command output", () => {
  test("an unknown command falls back to a JSON block", () => {
    const out = renderCommandOutput("mystery", { a: 1 });
    expect(out).toStartWith("**mystery**");
    expect(out).toContain("```json");
    expect(out).toContain('"a": 1');
  });

  test("a known command with the wrong shape falls back rather than half-rendering", () => {
    expect(renderCommandOutput("status", { weird: true })).toContain("```json");
    expect(renderCommandOutput("list_models", { models: { anthropic: [{ nope: 1 }] } })).toContain(
      "```json",
    );
  });

  test("status renders summary lines and no code block", () => {
    const out = renderCommandOutput("status", {
      character: "frank",
      active_model: "claude-sonnet-5",
      turn_count: 42,
      tokens: { input: 100, output: 50, cache_read: 10, cache_write: 5 },
      autonomy: { state: "active" },
    });
    expect(out).toContain("**frank**");
    expect(out).toContain("`claude-sonnet-5`");
    expect(out).toContain("turns: 42");
    expect(out).toContain("100 in / 50 out (cache 10 read / 5 write)");
    expect(out).toContain("autonomy: active");
    expect(out).not.toContain("```");
  });

  test("characters render with and without descriptions", () => {
    const out = renderCommandOutput("list_characters", {
      characters: [{ name: "frank", description: "flower enthusiast" }, { name: "sage" }],
    });
    expect(out).toContain("**frank** — flower enthusiast");
    expect(out).toContain("- **sage**");
  });

  test("models mark the active one and note what is hidden", () => {
    const out = renderCommandOutput("list_models", {
      models: {
        anthropic: [{ name: "sonnet", qualified_name: "anthropic:sonnet" }],
        openai: [{ name: "gpt", qualified_name: "openai:gpt" }],
      },
      active: "anthropic:sonnet",
      include_hidden: false,
      hidden_count: 3,
    });
    expect(out).toContain("**●** `anthropic:sonnet`");
    expect(out).not.toContain("**●** `openai:gpt`");
    expect(out).toContain("3 hidden");
  });

  test("sampler settings show scope, skip nulls, and say when empty", () => {
    const out = renderCommandOutput("model_settings", {
      model: "anthropic:opus",
      effective_sampler: { temperature: 0.7, top_p: null },
      scopes: { temperature: "character" },
    });
    expect(out).toContain("- temperature: `0.7` _(character)_");
    expect(out).not.toContain("top_p");

    expect(
      renderCommandOutput("model_settings", { model: "m", effective_sampler: {} }),
    ).toContain("_all defaults_");
  });

  test("alternatives preview each candidate and mark the active one", () => {
    const out = renderCommandOutput("list_alternatives", {
      alt_count: 2,
      alternatives: [
        { position: 1, content: "first answer", active: true },
        { position: 2, content: "second answer" },
      ],
    });
    expect(out).toContain("**Alternate responses** (2)");
    expect(out).toContain("**▶** 1. first answer");
    expect(out).toContain("· 2. second answer");
  });

  test("an applied alt swap is a short confirmation", () => {
    expect(
      renderCommandOutput("alt", { position: 2, alt_count: 3, content: "the other one" }),
    ).toBe("Switched to alternative 2/3:\n\nthe other one");
  });

  test("memory renders labelled snippets, bare strings, and the empty case", () => {
    const out = renderCommandOutput("memory", {
      query: "the beach",
      results: [{ file: "trip.md", snippet: "we went to the beach" }, "a bare string"],
    });
    expect(out).toContain("**Memory matches** — _the beach_");
    expect(out).toContain("- **trip.md** — we went to the beach");
    expect(out).toContain("- a bare string");

    expect(renderCommandOutput("memory", { query: "nothing", results: [] })).toBe(
      "No memory matches for _nothing_.",
    );
  });

  test("the log renders one line per message with a role icon", () => {
    const out = renderCommandOutput("log", {
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
    });
    expect(out).toContain("**Recent messages** (2)");
    expect(out).toContain("- 👤 hello");
    expect(out).toContain("- 🤖 hi");

    expect(renderCommandOutput("log", { messages: [] })).toBe("_No messages._");
  });

  test("previews flatten newlines and cut on a character boundary", () => {
    expect(preview("one\ntwo", 100)).toBe("one two");
    expect(preview("abcdef", 3)).toBe("abc…");
    expect(preview("abc", 3)).toBe("abc");
    expect(preview("🎵🎵🎵🎵", 2)).toBe("🎵🎵…");
  });
});
