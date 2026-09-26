import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Message } from "../src/protocol/Message.ts";
import { blockViews, dayLabel, formatToolInput, lastAssistantIndex, regenInFlight, regenStart, swipeState, toolSummary, transcriptItems, visibleStreams } from "../src/browser/chat/transcript.ts";
import { Markdown, safeHref } from "../src/browser/markdown.tsx";
import { avatarTone, initial } from "../src/browser/ui/avatar.tsx";
import { parseRoute } from "../src/browser/app/routing.ts";
import { DEFAULT_THEME, THEME_STORAGE_KEY, ThemeStore, isThemeId, storedTheme } from "../src/browser/theme.ts";

const message = (id: string, role: Message["role"], timestamp: string, extra: Partial<Message> = {}): Message => ({ msg_id: id, role, content: id, images: [], content_blocks: [], timestamp, ...extra });

test("transcript items add day dividers, one context boundary and mark only the last assistant reply", () => {
  const now = new Date(2026, 8, 25, 12);
  const messages = [
    message("a", "assistant", new Date(2026, 8, 24, 21).toISOString()),
    message("b", "user", new Date(2026, 8, 25, 8).toISOString()),
    message("c", "assistant", new Date(2026, 8, 25, 8, 1).toISOString()),
    message("d", "user", new Date(2026, 8, 25, 8, 2).toISOString()),
  ];
  const items = transcriptItems(messages, 1, now);
  expect(items.map((item) => item.kind === "message" ? item.message.msg_id : item.kind === "day" ? item.label : "context")).toEqual(["Yesterday", "a", "context", "Today", "b", "c", "d"]);
  expect(items.filter((item) => item.kind === "message" && item.last).map((item) => item.kind === "message" ? item.message.msg_id : "")).toEqual(["c"]);
  expect(transcriptItems(messages, 0, now).some((item) => item.kind === "context")).toBe(false);
  expect(lastAssistantIndex([message("x", "user", "")])).toBe(-1);
  expect(transcriptItems([message("bad", "user", "not a date")], 0, now).map((item) => item.kind)).toEqual(["message"]);
});

test("day labels use Today, Yesterday, weekdays within a week and dates beyond it", () => {
  const now = new Date(2026, 8, 25, 12);
  expect(dayLabel(new Date(2026, 8, 25, 0, 1), now)).toBe("Today");
  expect(dayLabel(new Date(2026, 8, 24, 23, 59), now)).toBe("Yesterday");
  expect(dayLabel(new Date(2026, 8, 21), now)).toContain(new Date(2026, 8, 21).toLocaleDateString(undefined, { weekday: "long" }));
  expect(dayLabel(new Date(2025, 0, 2), now)).toContain("2025");
});

test("content blocks pair tool calls with results and keep reasoning, images and errors", () => {
  const views = blockViews([
    { type: "thinking", thinking: "pondering" },
    { type: "tool_use", id: "t1", name: "read", input: { path: "notes/trip.md" } },
    { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "contents" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] },
    { type: "tool_use", id: "t2", name: "bash", input: { command: "false" } },
    { type: "tool_result", tool_use_id: "t2", content: "exit 1", is_error: true },
    { type: "tool_result", tool_use_id: "orphan", content: "late" },
    { type: "redacted_thinking", data: "x" },
    { type: "text", text: "  " },
    { type: "text", text: "Answer" },
  ]);
  expect(views.map((view) => view.kind)).toEqual(["thinking", "tool", "tool", "tool", "thinking", "text"]);
  expect(views[1]).toMatchObject({ name: "read", output: "contents", error: false, images: ["data:image/png;base64,AA=="] });
  expect(views[2]).toMatchObject({ name: "bash", output: "exit 1", error: true });
  expect(views[3]).toMatchObject({ id: "orphan", output: "late" });
  expect(views[4]).toMatchObject({ redacted: true });
  expect(blockViews([{ type: "tool_use", id: "t", name: "run", input: {} }])[0]).toMatchObject({ output: null });
});

test("tool summaries and inputs are readable, never [object Object]", () => {
  expect(toolSummary({ path: "notes/trip.md", limit: 5 })).toBe("notes/trip.md");
  expect(toolSummary({ count: 3 })).toBe("3");
  expect(toolSummary({ command: "ls\n-la" })).toBe("ls");
  expect(toolSummary({ nested: { a: 1 } })).toBe("");
  expect(toolSummary(null)).toBe("");
  expect(toolSummary("raw")).toBe("raw");
  expect(formatToolInput({ path: "a", flag: true })).toBe("path: a\nflag: true");
  expect(formatToolInput({ list: [1, 2] })).toBe("list: [\n  1,\n  2\n]");
  expect(formatToolInput(undefined)).toBe("");
  expect(formatToolInput(4)).toBe("4");
});

test("swipe state is one-based, clamped and knows when the next swipe must generate", () => {
  expect(swipeState({ alt_index: null, alt_count: null })).toEqual({ position: 1, count: 1, canPrevious: false, atLast: true });
  expect(swipeState({ alt_index: 0, alt_count: 3 })).toEqual({ position: 1, count: 3, canPrevious: false, atLast: false });
  expect(swipeState({ alt_index: 2, alt_count: 3 })).toEqual({ position: 3, count: 3, canPrevious: true, atLast: true });
  expect(swipeState({ alt_index: 9, alt_count: 2 })).toMatchObject({ position: 2, atLast: true });
});

test("finished streams disappear once their message arrives or their request is no longer this tab's", () => {
  const stream = (rid: string, final: boolean, msgId: string | null, subagent: string | null = null) => ({ rid, final, msgId, subagent });
  const streams = [stream("live", false, null), stream("done", true, "m1"), stream("stale", true, "old"), stream("mine", true, "new"), stream("sub", false, null, "worker")];
  expect(visibleStreams(streams, [message("m1", "assistant", "")], new Set(["done", "mine"])).map((item) => item.rid)).toEqual(["live", "mine"]);
  expect(visibleStreams(streams, [], new Set()).map((item) => item.rid)).toEqual(["live"]);
});

test("a regeneration replaces everything after the last real user turn, within the active context", () => {
  const toolResult = message("r", "user", "", { content_blocks: [{ type: "tool_result", tool_use_id: "t", content: "ok", is_error: false }] });
  const messages = [message("u", "user", ""), message("a1", "assistant", ""), toolResult, message("a2", "assistant", ""), message("s", "system", "")];
  expect(regenStart(messages, 0)).toBe(1);
  expect(regenStart([message("u", "user", "", { content_blocks: [] })], 0)).toBe(1);
  expect(regenStart([message("a", "assistant", ""), message("b", "assistant", "")], 1)).toBe(1);
});

test("the replaced reply stays hidden until the regeneration's own stream takes over", () => {
  expect(regenInFlight([], ["pending"])).toBe(true);
  expect(regenInFlight([{ regen: true }], [])).toBe(true);
  expect(regenInFlight([{ regen: false }, {}], [])).toBe(false);
  expect(regenInFlight([], [])).toBe(false);
  expect(regenInFlight([{ rid: "quiet", regen: false }], [], ["quiet"])).toBe(true);
  expect(regenInFlight([{ rid: "other", regen: false }], [], ["quiet"])).toBe(false);
});

test("markdown renders formatting but never raw HTML, unsafe links or remote images", () => {
  const html = renderToStaticMarkup(createElement(Markdown, { text: "*waves* **hi** `code`\n\n- one\n- two\n\n<img src=x onerror=alert(1)>\n\n[ok](https://example.com) [bad](javascript:alert(1)) ![pic](https://example.com/p.png)" }));
  expect(html).toContain("<em>waves</em>");
  expect(html).toContain("<strong>hi</strong>");
  expect(html).toContain("<code>code</code>");
  expect(html).toContain("<li>one</li>");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(html).toContain('href="https://example.com" target="_blank" rel="noopener noreferrer"');
  expect(html).not.toContain("javascript:");
  expect(html).toContain(">pic</a>");
  expect(safeHref(" mailto:a@b.c ")).toBe("mailto:a@b.c");
  expect(safeHref("data:text/html,x")).toBeUndefined();
  expect(renderToStaticMarkup(createElement(Markdown, { text: "# Title" }))).toContain("<h3>Title</h3>");
});

test("avatar initials respect graphemes and tones are stable per name", () => {
  expect(initial("nova")).toBe("N");
  expect(initial("  élan")).toBe("É");
  expect(initial("👩‍🚀 crew")).toBe("👩‍🚀");
  expect(initial("")).toBe("?");
  expect(avatarTone("Nova")).toBe(avatarTone("Nova"));
  expect(new Set(["Nova", "Ada", "Marlow", "Juniper", "Iris", "Wren"].map(avatarTone)).size).toBeGreaterThan(1);
});

test("settings routes come from the hash and unknown pages fall back to models", () => {
  expect(parseRoute("")).toEqual({ view: "chat" });
  expect(parseRoute("#settings")).toEqual({ view: "settings", page: "models" });
  expect(parseRoute("#settings/appearance")).toEqual({ view: "settings", page: "appearance" });
  expect(parseRoute("#settings/nope")).toEqual({ view: "settings", page: "models" });
  expect(parseRoute("#other")).toEqual({ view: "chat" });
});

test("theme choice persists, applies to the document, survives storage failures and follows other tabs", () => {
  const data = new Map<string, string>();
  let fail = false;
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { if (fail) throw new Error("quota"); data.set(key, value); } };
  const root: { dataset: Record<string, string | undefined> } = { dataset: {} };
  const store = new ThemeStore(storage, root);
  expect(store.theme).toBe(DEFAULT_THEME);
  expect(root.dataset["theme"]).toBe("default");
  store.select("fog");
  expect(data.get(THEME_STORAGE_KEY)).toBe("fog");
  expect(root.dataset["theme"]).toBe("fog");
  fail = true;
  store.select("default");
  expect(store.theme).toBe("default");
  expect(store.error).toContain("couldn't save");
  data.set(THEME_STORAGE_KEY, "fog");
  store.reload();
  expect(store.theme).toBe("fog");
  expect(storedTheme({ getItem: () => "neon" })).toBe(DEFAULT_THEME);
  expect(storedTheme({ getItem: () => { throw new Error("blocked"); } })).toBe(DEFAULT_THEME);
  expect(isThemeId("fog")).toBe(true);
});
