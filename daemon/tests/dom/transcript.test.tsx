import { afterEach, expect, test } from "bun:test";

import type { Message } from "../../src/protocol/Message.ts";
import type { SegmentSummary } from "../../src/protocol/SegmentSummary.ts";
import { useApp } from "./app.ts";
import { FakeSocket, HELLO, replace } from "./daemon.ts";
import { acting, button, click, mount } from "./dom.ts";

const app = useApp();
const present = (found: Element | null | undefined): boolean => found !== null && found !== undefined;

const settle = async (ms = 5) => { await acting(() => Bun.sleep(ms)); };
let revision = Date.now();
const AT = "2026-11-12T10:00:00.000Z";
const message = (id: string, role: "user" | "assistant" = "assistant", extra: Partial<Message> = {}): Message => ({ msg_id: id, role, content: `said ${id}`, content_blocks: [{ type: "text", text: `said ${id}` }], images: [], timestamp: AT, ...extra });
const talk = (count: number): Message[] => Array.from({ length: count }, (_, index) => message(`m_${String(index + 1)}`, index % 2 === 0 ? "user" : "assistant"));
const META = { model: "opus", tokens: { input: 1, output: 2, cache_read: 0, cache_write: 0 }, timing: { total_ms: 10, ttft_ms: 5 } };
const segment = (index: number, label: string | null = null): SegmentSummary => ({ index, first_message_at: AT, last_message_at: AT, compacted_at: AT, turn_count: 2, excluded: false, label, note: null, memory_before: null, memory_after: null });

afterEach(async () => {
  await acting(async () => {
    for (const stream of app.state().workspace.getSnapshot().streams) if (!stream.final) app.socket().receive({ type: "stream_end", metadata: META, rid: stream.rid, ...(stream.subagent === null ? {} : { subagent: stream.subagent }), content: "", is_final: true });
    for (const request of app.socket().sent) if (typeof request["rid"] === "string") app.socket().receive({ type: "request_finished", rid: request["rid"], outcome: "completed" });
    await Bun.sleep(5);
  });
  await history([]);
  app.state().workspace.closeSegment();
});

async function history(messages: Message[]): Promise<void> {
  revision += 1;
  await acting(() => { app.socket().receive({ type: "history", messages, config: {}, revision, selected_character: "ada", selected_thread: "story" }); });
}

const frame = async (sent: Record<string, unknown>) => { await acting(() => { app.socket().receive(sent); }); };

interface Page { messages: Message[]; segment: SegmentSummary; previous?: SegmentSummary | null | "fail"; next?: SegmentSummary | null; more?: boolean }

function pages(byBefore: Record<string, Page>, hold = false): { asked: unknown[]; release: () => void } {
  const asked: unknown[] = [];
  let waiting: (() => void) | undefined;
  app.answer((request) => {
    if (request["name"] !== "history_page") return undefined;
    const args = request["args"] as { before?: number };
    asked.push(args);
    const page = byBefore[String(args.before ?? "first")];
    if (page === undefined) return undefined;
    if (page.messages.length === 0 && page.more === undefined && page.previous === "fail") throw new Error("the archive is busy");
    const data = { messages: page.messages, cursor: 0, next_before: 7, has_more_before: page.more ?? false, total_turns: 9, segment: page.segment, previous_segment: page.previous === "fail" ? null : page.previous ?? null, next_segment: page.next ?? null };
    if (!hold || args.before === undefined) return data;
    waiting = () => { app.socket().receive({ type: "command_output", rid: request["rid"], name: "history_page", data }); app.socket().receive({ type: "request_finished", rid: request["rid"], outcome: "completed" }); };
    return undefined;
  });
  return { asked, release: () => { waiting?.(); } };
}

async function transcript(extra: { readOnly?: boolean } = {}) {
  const { Transcript } = await import("../../src/browser/chat/Transcript.tsx");
  const view = await mount(<Transcript character="ada" mobile={false} readOnly={extra.readOnly ?? false} />);
  await settle();
  const log = () => view.host.querySelector<HTMLElement>(".transcript");
  return {
    ...view,
    log,
    ids: () => [...view.host.querySelectorAll("article.message[data-msg-id]")].map((row) => row.getAttribute("data-msg-id")),
    last: () => [...view.host.querySelectorAll("article.message.last")].map((row) => row.getAttribute("data-msg-id")),
    regenerate: () => view.host.querySelector<HTMLButtonElement>("article.message.last [aria-label='Regenerate']"),
  };
}

function measure(node: HTMLElement | null, size: { height: number; client: number; top: number }) {
  if (node === null) throw new Error("no scroller");
  const scrolled: unknown[] = [];
  Object.defineProperty(node, "scrollHeight", { configurable: true, get: () => size.height });
  Object.defineProperty(node, "clientHeight", { configurable: true, get: () => size.client });
  Object.defineProperty(node, "scrollTop", { configurable: true, get: () => size.top, set: (value: number) => { size.top = value; } });
  Object.defineProperty(node, "scrollTo", { configurable: true, value: (options: unknown) => { scrolled.push(options); } });
  return {
    size, scrolled,
    scroll: async (top: number) => { size.top = top; await acting(() => { node.dispatchEvent(new Event("scroll", { bubbles: true })); }); await settle(); },
  };
}

test("an empty thread says so, and anything in it, a reply on its way included, takes the place of that", async () => {
  const empty = await transcript();
  expect([empty.host.querySelector(".empty-title")?.textContent, empty.host.querySelector(".empty-text")?.textContent, empty.log()?.getAttribute("aria-label"), empty.log()?.getAttribute("tabindex")]).toEqual(["ada", "No messages in this thread yet.", "Thread with ada", "-1"]);
  await history([message("m_1", "user")]);
  expect([present(empty.host.querySelector(".empty")), empty.ids()]).toEqual([false, ["m_1"]]);
  await history([]);
  const { conversation } = app.state();
  await acting(() => { void conversation.submit("message", { text: "hello" }).catch(() => undefined); });
  await settle();
  expect([present(empty.host.querySelector(".empty")), empty.host.querySelectorAll(".typing").length], "the reply being waited for").toEqual([false, 1]);
});

test("the newest reply is the last one, and the user's newest message is the one an edit-last opens", async () => {
  const view = await transcript();
  await history([message("m_1", "user"), message("m_2"), message("m_3", "user"), message("m_4")]);
  expect([view.ids(), view.last()]).toEqual([["m_1", "m_2", "m_3", "m_4"], ["m_4"]]);
  await acting(() => { dispatchEvent(new Event("shore:edit-last")); });
  expect(view.host.querySelector("article.message.active")?.getAttribute("data-msg-id")).toBe("m_3");
});

function heldTimers() {
  const real = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const held = new Map<number, () => void>();
  let next = -1;
  replace(app.restores, globalThis, "setTimeout", (callback: () => void, delay?: number, ...rest: unknown[]) => {
    if (delay !== undefined && delay !== 0) return real(callback, delay, ...rest);
    next -= 1;
    held.set(next, callback);
    return next;
  });
  replace(app.restores, globalThis, "clearTimeout", (id: number) => { if (!held.delete(id)) realClear(id); });
  return {
    held: () => held.size,
    run: async () => { const due = [...held.values()]; held.clear(); await acting(() => { for (const callback of due) callback(); }); },
  };
}

test("a long thread shows its newest rows first and fills in the rest a page at a time", async () => {
  await history(talk(60));
  const timers = heldTimers();
  const { Transcript } = await import("../../src/browser/chat/Transcript.tsx");
  const view = await mount(<Transcript character="ada" mobile={false} readOnly={false} />);
  const count = () => view.host.querySelectorAll("article.message[data-msg-id]").length;
  expect(count()).toBe(24);
  await history(talk(62));
  expect([count(), timers.held()], "a new message before the next page doesn't bring two pages").toEqual([24, 1]);
  await timers.run();
  expect(count()).toBe(56);
  await timers.run();
  expect([count(), timers.held()]).toEqual([62, 0]);
  await view.unmount();

  await history(talk(30));
  const short = await mount(<Transcript character="ada" mobile={false} readOnly={false} />);
  expect(short.host.querySelectorAll("article.message[data-msg-id]").length).toBe(24);
  await timers.run();
  await history(talk(61));
  expect([short.host.querySelectorAll("article.message[data-msg-id]").length, timers.held()], "a thread shown whole keeps every row as it grows").toEqual([61, 0]);
});

test("a regenerate waiting to start hides the replies it will replace, and a stream that replaces some hides those", async () => {
  const view = await transcript();
  await history([message("m_1", "user"), message("m_2"), message("m_3", "user"), message("m_4")]);
  const { conversation } = app.state();
  await acting(() => { void conversation.submit("regen", {}).catch(() => undefined); });
  await settle();
  expect(view.ids()).toEqual(["m_1", "m_2", "m_3"]);
  await frame({ type: "stream_start", rid: "r_regen", regen: true, replaces: ["m_2"] });
  expect(view.ids(), "the stream names what it replaces").toEqual(["m_1", "m_3"]);
});

test("a reply saved while its stream still runs is shown once, as the stream", async () => {
  const view = await transcript();
  await history([message("m_1", "user")]);
  await frame({ type: "stream_start", rid: "r_1", regen: false });
  await frame({ type: "stream_chunk", rid: "r_1", text: "part", content_type: "text" });
  expect([view.ids(), view.host.querySelectorAll(".message.streaming").length]).toEqual([["m_1"], 1]);
  await frame({ type: "tool_call", rid: "r_1", tool_id: "t", tool_name: "read", input: {} });
  await frame({ type: "new_message", revision: (revision += 1), character: "ada", thread: "story", ...message("m_2", "assistant", { content_blocks: [{ type: "text", text: "part" }, { type: "tool_use", id: "t", name: "read", input: {} }] }) });
  expect([view.ids(), view.host.querySelectorAll(".message.streaming").length], "the saved part shows inside the stream").toEqual([["m_1"], 1]);
});

test("the last reply can't be regenerated while a reply is still finishing, here or from another tab", async () => {
  const view = await transcript();
  await history([message("m_1", "user"), message("m_2")]);
  expect(view.regenerate()?.disabled).toBe(false);
  await frame({ type: "stream_start", rid: "r_elsewhere", regen: false });
  await frame({ type: "stream_chunk", rid: "r_elsewhere", text: "more", content_type: "text" });
  await frame({ type: "new_message", revision: (revision += 1), character: "ada", thread: "story", ...message("m_3") });
  expect([view.last(), view.regenerate()?.disabled], "a stream from another tab is still open").toEqual([["m_3"], true]);
  await frame({ type: "stream_end", metadata: META, rid: "r_elsewhere", content: "more", is_final: true, msg_id: "m_3" });
  expect(view.regenerate()?.disabled, "it ended").toBe(false);
  await frame({ type: "stream_start", rid: "r_helper", regen: false, subagent: "helper" });
  await frame({ type: "stream_chunk", rid: "r_helper", text: "x", content_type: "text", subagent: "helper" });
  expect(view.regenerate()?.disabled, "a sub-agent's stream doesn't hold the reply").toBe(false);

  const { conversation } = app.state();
  let rid = "";
  const since = app.socket().sent.length;
  await acting(() => { void conversation.submit("message", { text: "again" }).catch(() => undefined); });
  await settle();
  const asked = app.sent(since).find((request) => request["type"] === "message")?.["rid"];
  rid = typeof asked === "string" ? asked : "";
  await frame({ type: "stream_start", rid, regen: false });
  await frame({ type: "stream_end", metadata: META, rid, content: "done", is_final: true, msg_id: "m_4" });
  await frame({ type: "new_message", revision: (revision += 1), character: "ada", thread: "story", ...message("m_4") });
  expect([view.last(), view.regenerate()?.disabled], "this tab's request hasn't finished").toEqual([["m_4"], true]);
});

test("the thread follows new messages until the user scrolls up, and Latest brings it back", async () => {
  await history([message("m_1", "user")]);
  const view = await transcript();
  expect(present(view.host.querySelector(".jump")), "it starts at the newest message").toBe(false);
  const node = measure(view.log(), { height: 1000, client: 400, top: 0 });
  await history([message("m_1", "user"), message("m_2")]);
  expect(node.size.top).toBe(1000);
  await node.scroll(521);
  expect(present(view.host.querySelector(".jump")), "within 80 pixels of the bottom").toBe(false);
  await node.scroll(520);
  expect(view.host.querySelector(".jump")?.textContent).toBe("Latest");
  node.size.height = 1400;
  await history([message("m_1", "user"), message("m_2"), message("m_3", "user")]);
  expect(node.size.top, "it stays where the user scrolled").toBe(520);
  const { Icon } = await import("../../src/browser/ui/icons.tsx");
  const chevron = await mount(<Icon name="chevronDown" size={16} />);
  expect(view.host.querySelector(".jump svg")?.outerHTML).toBe(chevron.host.innerHTML);
  await chevron.unmount();
  await click(view.host.querySelector(".jump"));
  expect([node.scrolled, present(view.host.querySelector(".jump"))]).toEqual([[{ top: 1400, behavior: "smooth" }], false]);
  node.size.height = 1800;
  await history([message("m_1", "user"), message("m_2"), message("m_3", "user"), message("m_4")]);
  expect(node.size.top).toBe(1800);
});

test("an archived segment is shown read-only under a banner, with the way to the segments before and after it", async () => {
  pages({ first: { messages: [message("s_1", "user"), message("s_2")], segment: segment(3, "The lamp"), previous: segment(2), next: null } });
  const view = await transcript();
  await history([message("m_1", "user")]);
  await frame({ type: "stream_start", rid: "r_live", regen: false });
  await frame({ type: "stream_chunk", rid: "r_live", text: "live", content_type: "text" });
  await acting(async () => { await app.state().workspace.openSegment(3); });
  await settle();
  expect([view.host.querySelector(".segment-banner-name")?.textContent, view.log()?.getAttribute("aria-label"), view.ids(), view.host.querySelectorAll(".message.streaming").length]).toEqual(["Viewing Segment 3 · The lamp", "Segment 3 · The lamp with ada", ["s_1", "s_2"], 0]);
  expect([present(view.host.querySelector("article [aria-label='Edit']")), view.last()], "nothing in an archive can be changed").toEqual([false, []]);
  expect([...view.host.querySelectorAll(".segment-link-name")].map((link) => link.textContent)).toEqual(["Before this: Segment 2", "After this: the current context"]);
  await click(button(view.host, "Back to current"));
  expect([present(view.host.querySelector(".segment-banner")), view.ids()]).toEqual([false, ["m_1"]]);
});

test("the first segment starts the thread, and a segment with earlier pages loads them from a button or by scrolling to the top", async () => {
  pages({ first: { messages: [message("s_1", "user")], segment: segment(0), previous: null, next: segment(1) } });
  const start = await transcript();
  await acting(async () => { await app.state().workspace.openSegment(0); });
  await settle();
  expect([start.host.querySelector(".divider[role=separator]")?.textContent, [...start.host.querySelectorAll(".segment-link-name")].map((link) => link.textContent)]).toEqual(["Start of the thread", ["After this: Segment 1"]]);
  await start.unmount();
  app.state().workspace.closeSegment();

  const served = pages({ first: { messages: [message("s_3", "user"), message("s_4")], segment: segment(2), more: true }, 7: { messages: [message("s_1", "user"), message("s_2")], segment: segment(2) } }, true);
  const view = await transcript();
  await acting(async () => { await app.state().workspace.openSegment(2); });
  await settle();
  const node = measure(view.log(), { height: 1000, client: 400, top: 300 });
  await node.scroll(120);
  expect(served.asked, "not near enough the top").toEqual([{ segment: 2, turns: 32 }]);
  await node.scroll(119);
  expect([served.asked.at(-1), view.host.querySelector(".load-earlier [role=status]")?.getAttribute("aria-label")]).toEqual([{ segment: 2, before: 7, turns: 32 }, "Loading earlier messages"]);
  await node.scroll(10);
  expect(served.asked, "already loading").toHaveLength(2);
  node.size.height = 1600;
  await acting(() => { served.release(); });
  await settle();
  expect([view.ids(), node.size.top]).toEqual([["s_1", "s_2", "s_3", "s_4"], 719]);
  expect(present(view.host.querySelector(".load-earlier"))).toBe(false);
  await view.unmount();
  app.state().workspace.closeSegment();

  const more = pages({ first: { messages: [message("t_3", "user")], segment: segment(4), more: true }, 7: { messages: [message("t_2", "user")], segment: segment(4), more: true } });
  const again = await transcript();
  await acting(async () => { await app.state().workspace.openSegment(4); });
  await settle();
  measure(again.log(), { height: 1000, client: 400, top: 500 });
  await click(button(again.host, "Load earlier messages"));
  await settle();
  expect([more.asked.length, again.ids(), button(again.host, "Load earlier messages").disabled], "there is more to load, so the button is back").toEqual([2, ["t_2", "t_3"], false]);
});

test("Load earlier asks for the page before the oldest message shown", async () => {
  const served = pages({ first: { messages: [message("s_3", "user")], segment: segment(5), more: true }, 7: { messages: [message("s_1", "user")], segment: segment(5) } });
  const view = await transcript();
  await acting(async () => { await app.state().workspace.openSegment(5); });
  await settle();
  measure(view.log(), { height: 1000, client: 400, top: 500 });
  await click(button(view.host, "Load earlier messages"));
  await settle();
  expect([served.asked.at(-1), view.ids()]).toEqual([{ segment: 5, before: 7, turns: 32 }, ["s_1", "s_3"]]);
});

test("a segment that fits on its first page loads earlier pages from the top at once, without waiting for more rows", async () => {
  const timers = heldTimers();
  const served = pages({ first: { messages: Array.from({ length: 23 }, (_, index) => message(`f_${String(index)}`, index % 2 === 0 ? "user" : "assistant")), segment: segment(9), more: true } });
  await acting(async () => { await app.state().workspace.openSegment(9); });
  const view = await transcript();
  const node = measure(view.log(), { height: 1000, client: 400, top: 500 });
  await node.scroll(10);
  expect([view.ids().length, served.asked.at(-1), timers.held()]).toEqual([23, { segment: 9, before: 7, turns: 32 }, 0]);
});

test("once an earlier page is in place, later changes don't jump back to where loading began", async () => {
  const timers = heldTimers();
  pages({ first: { messages: [message("g_3", "user")], segment: segment(10), more: true }, 7: { messages: [message("g_1", "user")], segment: segment(10) } });
  await history([message("m_1", "user")]);
  const view = await transcript();
  await acting(async () => { await app.state().workspace.openSegment(10); });
  await settle();
  const node = measure(view.log(), { height: 1000, client: 400, top: 500 });
  await node.scroll(119);
  await settle();
  expect([view.ids(), node.size.top, timers.held()], "the clean-up is still to come").toEqual([["g_1", "g_3"], 119, 1]);
  await node.scroll(400);
  node.size.height = 1500;
  await click(button(view.host, "Back to current"));
  expect([view.ids(), node.size.top]).toEqual([["m_1"], 400]);
});

test("the live thread never loads a segment's earlier pages, however far up it scrolls", async () => {
  const served = pages({});
  await history(talk(4));
  const view = await transcript();
  const node = measure(view.log(), { height: 1000, client: 400, top: 500 });
  await node.scroll(0);
  expect(served.asked).toEqual([]);
});

test("a picture opens full size and closes again", async () => {
  const { display } = app.state();
  const shown = display.getSnapshot().values.images;
  display.change("images", "on");
  app.restores.push(() => { display.change("images", shown); });
  await history([message("m_1", "assistant", { content: "look", content_blocks: [{ type: "text", text: "look" }], images: [{ path: "/p.png", data: "iVBORw0KGgo=", caption: "a lamp" }] })]);
  const view = await transcript();
  await click(view.host.querySelector(".images button, .image-thumb, button.thumb"));
  expect(present(document.body.querySelector("dialog"))).toBe(true);
});

test("while a thread is opening the transcript says it is busy", async () => {
  const view = await transcript();
  const wrap = () => view.host.querySelector(".transcript-wrap");
  expect([wrap()?.getAttribute("data-opening"), wrap()?.getAttribute("aria-busy")]).toEqual(["false", "false"]);
  await acting(() => { void app.state().workspace.openThread("side").catch(() => undefined); });
  await settle();
  expect([wrap()?.getAttribute("data-opening"), wrap()?.getAttribute("aria-busy")]).toEqual(["true", "true"]);
});

test("the replies shown are the ones whose marks are asked for", async () => {
  await history([message("k_1", "user"), message("k_2"), message("k_3", "user"), message("k_4")]);
  const since = app.socket().sent.length;
  await transcript();
  await settle(20);
  expect(app.sent(since).filter((request) => request["name"] === "marks").map((request) => request["args"])).toEqual([{ refs: ["k_2", "k_4"] }]);
});

test("each reply carries the avatar of the character it is from", async () => {
  app.answer((request) => request["name"] === "list_characters" ? { characters: [{ name: "bo" }, { name: "ada", avatar: { mime_type: "image/png", data: "QUJD" } }] } : undefined);
  await acting(async () => { await app.state().workspace.refreshNavigation(); });
  await history([message("m_1", "user"), message("m_2")]);
  const view = await transcript();
  expect(view.host.querySelector("article.message.assistant img.avatar")?.getAttribute("src")).toBe("data:image/png;base64,QUJD");
});

test("a reply waited for in the live thread isn't shown in an archived segment", async () => {
  pages({ first: { messages: [message("s_1", "user")], segment: segment(6) } });
  const view = await transcript();
  await acting(() => { void app.state().conversation.submit("message", { text: "hello" }).catch(() => undefined); });
  await settle();
  expect(view.host.querySelectorAll(".typing").length).toBe(1);
  await acting(async () => { await app.state().workspace.openSegment(6); });
  await settle();
  expect(view.host.querySelectorAll(".typing").length).toBe(0);
});

test("after an earlier page fails to load, going back to the thread doesn't jump to where loading began", async () => {
  app.restores.push(() => { app.state().workspace.dismissError(); });
  pages({ first: { messages: [message("s_2", "user")], segment: segment(7), more: true }, 7: { messages: [], segment: segment(7), previous: "fail" } });
  await history([message("m_1", "user"), message("m_2")]);
  const view = await transcript();
  await acting(async () => { await app.state().workspace.openSegment(7); });
  await settle();
  const node = measure(view.log(), { height: 1000, client: 400, top: 300 });
  await node.scroll(119);
  await settle(20);
  expect(app.state().workspace.getSnapshot().error).toContain("the archive is busy");
  node.size.height = 1500;
  await click(button(view.host, "Back to current"));
  expect([view.ids(), node.size.top]).toEqual([["m_1", "m_2"], 119]);
});

test("a request in flight when the connection dropped is listed until dismissed, and waiting for the daemon shows a spinner", async () => {
  const { conversation, workspace } = app.state();
  await acting(() => { void conversation.submit("message", { text: "lost" }).catch(() => undefined); });
  await settle();
  const served = pages({ first: { messages: [message("s_3", "user")], segment: segment(8), more: true } });
  const view = await transcript();
  await history([]);
  await acting(async () => { await workspace.openSegment(8); });
  await settle();
  measure(view.log(), { height: 1000, client: 400, top: 500 });
  await acting(() => { app.socket().fire("close", { code: 1006, reason: "" }); });
  await settle();
  await click(button(view.host, "Load earlier messages"));
  await settle();
  expect([served.asked.length, present(view.host.querySelector(".load-earlier [role=status]")), workspace.getSnapshot().error], "no earlier page is asked for while the daemon is away").toEqual([1, false, ""]);
  await click(button(view.host, "Back to current"));
  expect(view.host.querySelector(".empty [role=status]")?.getAttribute("aria-label")).toBe("Loading conversation");
  await acting(async () => { await Bun.sleep(1100); });
  const socket = FakeSocket.opened.at(-1);
  await acting(() => { socket?.fire("open"); socket?.receive(HELLO); });
  await settle(20);
  const notice = view.host.querySelector(".notice-card");
  const { Icon } = await import("../../src/browser/ui/icons.tsx");
  const alert = await mount(<Icon name="alert" size={16} />);
  expect(notice?.querySelector("svg")?.outerHTML).toBe(alert.host.innerHTML);
  const listed = view.host.querySelectorAll(".notice-card").length;
  await click(button(view.host, "Dismiss"));
  expect([listed > 0, view.host.querySelectorAll(".notice-card").length]).toEqual([true, listed - 1]);
});

