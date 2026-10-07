import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ImageUpload } from "../src/protocol/ImageUpload.ts";
import type { ContentBlock } from "../src/protocol/ContentBlock.ts";
import type { Message } from "../src/protocol/Message.ts";
import type { WebRequestInfo } from "../src/protocol/WebRequestInfo.ts";
import { checkAttachments, restoredDraft } from "../src/browser/request_forms.ts";
import { conversationCharacter, droppedNotice, sentFate } from "../src/browser/chat/sending.ts";
import { workspaceNote } from "../src/browser/chat/workspace_note.ts";
import { MAX_ATTACHMENTS } from "../src/swp/limits.ts";
import { activityHeadline, blockViews, bodyItems, dayLabel, formatToolInput, lastAssistantIndex, optimisticRegenReplaces, regenReplaces, replyBlocks, savedPart, segmentDetail, segmentName, swipeState, toolSummary, transcriptItems, visibleStreams, type LiveReply } from "../src/browser/chat/transcript.ts";
import { Markdown, markdownBlocks, safeHref, type SettledMarkdown } from "../src/browser/markdown.tsx";
import { avatarTone, initial } from "../src/browser/ui/avatar.tsx";
import { parseRoute } from "../src/browser/app/routing.ts";
import { DEFAULT_THEME, THEME_STORAGE_KEY, ThemeStore, isThemeId, storedTheme } from "../src/browser/theme.ts";

const message = (id: string, role: Message["role"], timestamp: string, extra: Partial<Message> = {}): Message => ({ msg_id: id, role, content: id, images: [], content_blocks: [], timestamp, ...extra });

test("transcript items add day dividers and mark only the last assistant reply", () => {
  const now = new Date(2026, 8, 25, 12);
  const messages = [
    message("a", "assistant", new Date(2026, 8, 24, 21).toISOString()),
    message("b", "user", new Date(2026, 8, 25, 8).toISOString()),
    message("c", "assistant", new Date(2026, 8, 25, 8, 1).toISOString()),
    message("d", "user", new Date(2026, 8, 25, 8, 2).toISOString()),
  ];
  const items = transcriptItems(messages, now);
  expect(items.map((item) => item.kind === "message" ? item.message.msg_id : item.label)).toEqual(["Yesterday", "a", "Today", "b", "c", "d"]);
  expect(items.filter((item) => item.kind === "message" && item.last).map((item) => item.kind === "message" ? item.message.msg_id : "")).toEqual(["c"]);
  expect(lastAssistantIndex([message("x", "user", "")])).toBe(-1);
  expect(transcriptItems([message("bad", "user", "not a date")], now).map((item) => item.kind)).toEqual(["message"]);
});

test("a segment is named by its index and label, and described by size, dates and exclusion", () => {
  const now = new Date(2026, 9, 2, 12);
  const segment = { index: 12, first_message_at: new Date(2026, 8, 28, 9).toISOString(), last_message_at: new Date(2026, 9, 1, 22).toISOString(), compacted_at: "", message_count: 340, excluded: false, label: null, note: null, memory_before: null, memory_after: null };
  const day = (date: Date, year = false) => date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: year ? "numeric" : undefined });
  expect(segmentName(segment)).toBe("Segment 12");
  expect(segmentName({ ...segment, label: "the trip" })).toBe("Segment 12 · the trip");
  expect(segmentDetail(segment, now)).toBe(`340 messages · ${day(new Date(2026, 8, 28))} – ${day(new Date(2026, 9, 1))}`);
  expect(segmentDetail({ ...segment, message_count: 1, last_message_at: segment.first_message_at, excluded: true }, now)).toBe(`1 message · ${day(new Date(2026, 8, 28))} · excluded from memory`);
  expect(segmentDetail({ ...segment, first_message_at: null, last_message_at: "not a date" }, now)).toBe("340 messages");
  expect(segmentDetail({ ...segment, first_message_at: null }, now)).toBe(`340 messages · ${day(new Date(2026, 9, 1))}`);
  expect(segmentDetail({ ...segment, first_message_at: new Date(2025, 11, 30).toISOString(), last_message_at: null }, now)).toBe(`340 messages · ${day(new Date(2025, 11, 30), true)}`);
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

test("consecutive reasoning and tool calls collapse into one summary, and text splits them", () => {
  const items = bodyItems(blockViews([
    { type: "thinking", thinking: "plan" },
    { type: "tool_use", id: "s1", name: "search", input: { query: "monday drawing" } },
    { type: "tool_result", tool_use_id: "s1", content: "found" },
    { type: "tool_use", id: "s2", name: "search", input: { query: "night" } },
    { type: "thinking", thinking: "narrow it down" },
    { type: "tool_use", id: "r1", name: "read", input: { path: "HEARTBEAT.md" } },
    { type: "tool_result", tool_use_id: "r1", content: "missing", is_error: true },
    { type: "text", text: "Let me look once more." },
    { type: "tool_use", id: "b1", name: "bash", input: { command: "ls" } },
    { type: "text", text: "Found it." },
  ]));
  expect(items.map((item) => item.kind === "activity" ? item.steps.map((step) => step.kind) : item.kind)).toEqual([["thinking", "tool", "tool", "thinking", "tool"], "text", ["tool"], "text"]);
  const steps = items.flatMap((item) => item.kind === "activity" ? [item.steps] : []);
  expect(activityHeadline(steps[0] ?? [], false)).toEqual({ label: "Reasoned and used 3 tools", detail: "search, read" });
  expect(activityHeadline(steps[1] ?? [], false)).toEqual({ label: "Used 1 tool", detail: "bash" });
  expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
});

test("an activity headline names at most three tools, and while live shows the step in progress", () => {
  const steps = bodyItems(blockViews([
    { type: "thinking", thinking: "a" },
    { type: "thinking", thinking: "b" },
  ])).flatMap((item) => item.kind === "activity" ? item.steps : []);
  expect(activityHeadline(steps, false)).toEqual({ label: "Reasoning", detail: "" });
  expect(activityHeadline(steps, true)).toEqual({ label: "Thinking…", detail: "" });
  const tools = blockViews(["a", "b", "c", "d", "e"].map((name) => ({ type: "tool_use" as const, id: name, name, input: { path: `${name}.md` } })));
  const done = tools.flatMap((view) => view.kind === "tool" ? [{ ...view, output: "ok" }] : []);
  expect(activityHeadline(done, false)).toEqual({ label: "Used 5 tools", detail: "a, b, c and 2 more" });
  expect(activityHeadline(done, true)).toEqual({ label: "Used 5 tools", detail: "a, b, c and 2 more" });
  const running = [...done.slice(0, 4), ...tools.slice(4).flatMap((view) => view.kind === "tool" ? [view] : [])];
  expect(activityHeadline(running, true)).toEqual({ label: "e", detail: "e.md" });
  expect(activityHeadline(running, false)).toEqual({ label: "Used 5 tools", detail: "a, b, c and 2 more" });
});

test("a streaming reply claims the saved message that holds its tool calls, never an earlier reply", () => {
  const partial = message("partial", "assistant", "", { content_blocks: [{ type: "thinking", thinking: "plan" }, { type: "tool_use", id: "t1", name: "read", input: {} }, { type: "tool_result", tool_use_id: "t1", content: "ok" }] });
  const pending = message("pending", "assistant", "", { content_blocks: [{ type: "thinking", thinking: "plan" }, { type: "tool_use", id: "t9", name: "read", input: {} }] });
  const earlier = message("earlier", "assistant", "", { content_blocks: [{ type: "tool_use", id: "old", name: "read", input: {} }, { type: "tool_result", tool_use_id: "old", content: "ok" }, { type: "text", text: "Done." }] });
  const question = message("question", "user", "");
  expect(savedPart([question, partial], { tools: ["t1"] })).toBe(partial);
  expect(savedPart([question, partial], { tools: ["elsewhere"] })).toBeUndefined();
  expect(savedPart([question, pending], { tools: [] })).toBe(pending);
  expect(savedPart([question, pending], { tools: ["elsewhere"] })).toBeUndefined();
  expect(savedPart([question, earlier], { tools: [] })).toBeUndefined();
  expect(savedPart([partial, question], { tools: ["t1"] })).toBeUndefined();
  expect(savedPart([], { tools: [] })).toBeUndefined();
});

test("a streaming reply shows each saved step once and adds only what isn't saved yet", () => {
  const steps = (stream: LiveReply, saved?: Message) => blockViews(replyBlocks(stream, saved)).map((view) => view.kind === "tool" ? `${view.id}:${view.output ?? "running"}` : view.kind === "thinking" ? `thinking:${view.text}` : view.kind === "text" ? `text:${view.text}` : view.kind);
  const round = (reasoning: string, text: string, tools: string[]) => ({ reasoning, text, tools });
  const use = { type: "tool_use" as const, id: "t1", name: "read", input: {} };
  const result = { type: "tool_result" as const, tool_use_id: "t1", content: "contents" };
  const saved = (...blocks: ContentBlock[]) => message("partial", "assistant", "", { content_blocks: [{ type: "thinking", thinking: "plan" }, ...blocks] });
  const thinking: LiveReply = { reasoning: "plan", text: "", blocks: [], tools: [], round: round("plan", "", []) };
  expect(steps(thinking)).toEqual(["thinking:plan"]);
  expect(steps(thinking, saved(use))).toEqual(["thinking:plan", "t1:running"]);
  const called: LiveReply = { ...thinking, blocks: [use], tools: ["t1"], round: round("plan", "", ["t1"]) };
  expect(steps(called)).toEqual(["thinking:plan", "t1:running"]);
  expect(steps(called, saved(use))).toEqual(["thinking:plan", "t1:running"]);
  const answered: LiveReply = { ...called, blocks: [use, result] };
  expect(steps(answered, saved(use))).toEqual(["thinking:plan", "t1:contents"]);
  expect(steps(answered, saved(use, result))).toEqual(["thinking:plan", "t1:contents"]);
  const next: LiveReply = { ...answered, reasoning: "plancheck", text: "Found it.", round: round("check", "Found it.", []) };
  expect(steps(next, saved(use, result))).toEqual(["thinking:plan", "t1:contents", "thinking:check", "text:Found it."]);
  const ended: LiveReply = { ...next, blocks: [{ type: "thinking", thinking: "check" }, { type: "text", text: "Found it." }] };
  expect(steps(ended, saved(use, result))).toEqual(["thinking:plan", "t1:contents", "thinking:check", "text:Found it."]);
  expect(steps(next)).toEqual(["thinking:plancheck", "text:Found it.", "t1:contents"]);
  expect(replyBlocks({ reasoning: "", text: "", blocks: [], tools: [], round: round("", "", []) }, undefined)).toEqual([]);
  const picture = { type: "tool_result" as const, tool_use_id: "t1", content: [{ type: "image" as const, source: { type: "base64" as const, media_type: "image/png", data: "AA==" } }] };
  expect(blockViews(replyBlocks(answered, saved(use, picture))).find((view) => view.kind === "tool")).toMatchObject({ images: ["data:image/png;base64,AA=="] });
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

test("until the daemon lists what a regeneration replaces, the guess is everything after the last real user turn", () => {
  const toolResult = message("r", "user", "", { content_blocks: [{ type: "tool_result", tool_use_id: "t", content: "ok", is_error: false }] });
  const messages = [message("u", "user", ""), message("a1", "assistant", ""), toolResult, message("a2", "assistant", ""), message("s", "system", "")];
  expect(optimisticRegenReplaces(messages)).toEqual(["a1", "r", "a2", "s"]);
  expect(optimisticRegenReplaces([message("u", "user", "", { content_blocks: [] })])).toEqual([]);
  expect(optimisticRegenReplaces([message("a", "assistant", ""), message("b", "assistant", "")])).toEqual(["a", "b"]);
  expect(regenReplaces(messages, [], true)).toEqual(["a1", "r", "a2", "s"]);
});

test("a started regeneration hides exactly the messages its stream_start lists", () => {
  const messages = [message("u", "user", ""), message("kept", "assistant", ""), message("old", "assistant", "")];
  expect(regenReplaces(messages, [{ replaces: ["old"] }], false)).toEqual(["old"]);
  expect(regenReplaces(messages, [{ replaces: ["old"] }, {}], false)).toEqual(["old"]);
  expect(regenReplaces(messages, [{}, { replaces: [] }], false)).toEqual([]);
  expect(regenReplaces(messages, [], false)).toEqual([]);
});

test("a message that wasn't saved comes back ahead of the draft and the draft stays sendable", () => {
  const image = (name: string, bytes = 3): ImageUpload => ({ filename: name, data: "A".repeat(bytes / 3 * 4), mime_type: "image/png" });
  const none: ImageUpload[] = [];
  const sent = { text: "sent", images: [image("s1"), image("s2")] };
  expect(restoredDraft(sent, { text: "", images: none, options: { stream: false } })).toEqual({ content: { text: "sent", images: sent.images, options: { stream: false } }, dropped: 0 });
  expect(restoredDraft({ text: "", images: none }, { text: "typed", images: none }).content.text).toBe("typed");
  const typed = Array.from({ length: MAX_ATTACHMENTS }, (_, index) => image(`t${String(index)}`));
  const crowded = restoredDraft(sent, { text: "typed since", images: typed });
  expect(crowded.content.text).toBe("sent\n\ntyped since");
  expect(crowded.content.images.map((item) => item.filename)).toEqual(["s1", "s2", ...typed.slice(0, MAX_ATTACHMENTS - 2).map((item) => item.filename)]);
  expect(crowded.dropped).toBe(2);
  expect(() => checkAttachments(crowded.content.images)).not.toThrow();
  const large = image("large", 4.5 * 1024 * 1024);
  const heavy = restoredDraft({ text: "", images: [large, large, large, large] }, { text: "", images: [large, image("small")] });
  expect(heavy.content.images.map((item) => item.filename)).toEqual(["large", "large", "large", "large", "small"]);
  expect(heavy.dropped).toBe(1);
  expect(() => checkAttachments(heavy.content.images)).not.toThrow();
  expect(droppedNotice(0)).toBe("");
  expect(droppedNotice(1)).toContain("1 image attached while it was sending didn’t fit and was removed");
  expect(droppedNotice(2)).toContain("2 images attached while it was sending didn’t fit and were removed");
});

test("after a reload a sent message is kept only while the daemon may still save it", () => {
  const request = (phase: WebRequestInfo["phase"], accepted?: boolean): WebRequestInfo => ({ id: "id", rid: "rid", operation: "message", label: "Send message", character: "nova", thread: "main", started_at: 0, expires_at: 1, phase, result_omitted: false, ...(accepted === undefined ? {} : { accepted }) });
  expect(sentFate(undefined)).toBe("unsent");
  expect(sentFate(request("running"))).toBe("waiting");
  expect(sentFate(request("running", true))).toBe("saved");
  for (const phase of ["uncertain", "failed", "cancelled", "superseded"] as const) {
    expect(sentFate(request(phase))).toBe("unsent");
    expect(sentFate(request(phase, true))).toBe("saved");
  }
  expect(sentFate(request("completed"))).toBe("saved");
  expect(conversationCharacter(JSON.stringify(["nova", "side"]))).toBe("nova");
  expect(conversationCharacter(JSON.stringify([null, null]))).toBeUndefined();
  expect(conversationCharacter("not json")).toBeUndefined();
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

const STREAMED_MARKDOWN = [
  "Intro paragraph\n\n## Heading\n\nSecond *paragraph* with `code`.\n\n- one\n- two\n\n  continued\n- three\n\n```ts\nconst a = 1;\n\n\nconst b = 2;\n```\n\n> quote\nlazy line\n\n> second quote\n\nLast line",
  "1. first\n\n2. second\n\n3. third\n\nafter",
  "- tight\n- list\n\n- now loose\n\nend",
  "para\n***x\n\npara\n---\n\npara\n===\n\nnext",
  "    indented\n\n    still code\n\nprose\n\n    more code",
  "intro\n\n  - item\n\n      not code\n\nend",
  "See [foo] here.\n\nMore text.\n\n[foo]: https://example.com\n\nThen more.\n\nAnd [foo] again.",
  "See [bar][] here.\n\nMore text.\n\n> [bar]: https://example.org/b\n\nTail",
  "<div>\nhtml block\n\n</div>\n\ntext after html",
  "Line one\r\n\r\nLine two\r\n\r\n- item\r\n- item\r\n\r\nend",
];

test("streamed markdown renders exactly what the whole text renders at every step", () => {
  const markup = (blocks: ReturnType<typeof markdownBlocks>["blocks"]) => renderToStaticMarkup(createElement("div", null, blocks));
  for (const text of STREAMED_MARKDOWN) {
    for (const size of [1, 2, 5, 13]) {
      let settled: SettledMarkdown | undefined;
      for (let end = size; end < text.length + size; end += size) {
        const shown = text.slice(0, end);
        const step = markdownBlocks(shown, settled);
        settled = step.settled;
        expect({ shown, html: markup(step.blocks) }).toEqual({ shown, html: markup(markdownBlocks(shown).blocks) });
      }
    }
  }
});

test("streamed markdown parses only what follows the blocks it has settled", () => {
  const first = markdownBlocks("one\n\ntwo\n\nthr");
  expect(first.settled.text).toBe("one\n\n");
  const next = markdownBlocks("one\n\ntwo\n\nthree", first.settled);
  expect(next.blocks[0]).toBe(first.blocks[0]);
  expect(next.blocks).toHaveLength(3);
  expect(renderToStaticMarkup(createElement("div", null, markdownBlocks("two", first.settled).blocks))).toBe("<div><p>two</p></div>");
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

test("workspace notes say what a delete or swipe did to the files", () => {
  expect(workspaceNote(undefined)).toBeUndefined();
  expect(workspaceNote({ restored: [], skipped: [] })).toBeUndefined();
  expect(workspaceNote({ restored: [], skipped: [], kept: "later_turns" })).toBe("Workspace files kept: later turns build on this one");
  expect(workspaceNote({ restored: ["a.md"], skipped: [] })).toBe("Restored 1 workspace file");
  expect(workspaceNote({ restored: ["a.md", "b.md"], skipped: ["c.md"] })).toBe("Restored 2 workspace files; 1 workspace file changed since and was left as is: c.md");
  expect(workspaceNote({ restored: [], skipped: ["a", "b", "c", "d"] })).toBe("4 workspace files changed since and were left as is: a, b, c, …");
});
