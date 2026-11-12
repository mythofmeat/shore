import { expect, spyOn, test } from "bun:test";

import type { MarkView } from "../../src/protocol/MarkView.ts";
import type { Message } from "../../src/protocol/Message.ts";
import { HOLD, useApp } from "./app.ts";
import { acting, button, click, mount, type } from "./dom.ts";

const app = useApp();
const AT = "2026-11-12T10:00:00.000Z";
const settle = async (): Promise<void> => { await acting(async () => { await Bun.sleep(10); }); };

function reply(extra: Partial<Message> = {}): Message {
  return { msg_id: "m_reply", role: "assistant", content: "The sea is wide.", content_blocks: [{ type: "text", text: "The sea is wide." }], images: [], timestamp: AT, ...extra };
}

interface Daemon { marks: Map<number, MarkView[]>; sent: [string, unknown][]; fail: boolean }

function daemon(start: Record<number, MarkView[]> = {}, positions = 1): Daemon {
  const state: Daemon = { marks: new Map(Object.entries(start).map(([position, marks]) => [Number(position), marks])), sent: [], fail: false };
  app.answer((asked) => {
    const name = String(asked["name"]);
    const args = (asked["args"] ?? {}) as Record<string, unknown>;
    if (!["marks", "mark", "unmark", "list_alternatives"].includes(name)) return undefined;
    state.sent.push([name, args]);
    if (state.fail && name !== "marks") throw new Error("the daemon said no");
    if (name === "list_alternatives") {
      return { ref: "m_reply", alt_index: positions - 1, position: positions, alt_count: positions, alternatives: Array.from({ length: positions }, (_, index) => ({ index, position: index + 1, active: index === positions - 1, content: `Try ${String(index + 1)}`, images: [], timestamp: AT })) };
    }
    if (name === "marks") {
      return { tags: ["too long", "repetitive"], replies: [{ ref: "m_reply", attempts: Array.from({ length: positions }, (_, index) => ({ position: index + 1, shown: index === positions - 1, attempt: `at_${String(index + 1)}`, asked: "first", marks: state.marks.get(index + 1) ?? [] })) }] };
    }
    const position = Number(args["position"]);
    const phrase = (args["phrase"] as string | undefined) ?? null;
    const kept = (state.marks.get(position) ?? []).filter((mark) => mark.phrase !== phrase);
    if (name === "mark") kept.push({ kind: args["kind"] as MarkView["kind"], phrase, reason: (args["reason"] as string | undefined)?.trim() || null, tags: (args["tags"] as string[] | undefined) ?? [], at: AT });
    state.marks.set(position, kept);
    return { ref: "m_reply", position, attempt: `at_${String(position)}`, phrase, changed: true, marks: kept };
  });
  return state;
}

async function row(message: Message, extra: { last?: boolean; mobile?: boolean; readOnly?: boolean } = {}) {
  const { MessageRow } = await import("../../src/browser/chat/Message.tsx");
  const { defaultViews } = await import("../../src/browser/preferences.ts");
  const state = app.state();
  state.replyMarks.want("", []);
  state.replyMarks.want("ada/story", [message]);
  await settle();
  return await mount(<MessageRow message={message} character="ada" avatar={null} last={extra.last ?? false} metadata={undefined} display={defaultViews()} busy={false} mobile={extra.mobile ?? false} openImage={() => {}} readOnly={extra.readOnly ?? false} />);
}

const pressed = (host: HTMLElement) => [...host.querySelectorAll(".reply-footer .mark-toggle")].map((toggle) => [toggle.getAttribute("aria-label"), toggle.getAttribute("aria-pressed")]);
const chips = (host: ParentNode) => [...host.querySelectorAll(".mark-chip")].map((chip) => [chip.className, chip.textContent]);
const editor = (host: ParentNode) => host.querySelector(".mark-editor");

function key(target: Element | null, name: string, ctrlKey = false): void {
  target?.dispatchEvent(new KeyboardEvent("keydown", { key: name, ctrlKey, bubbles: true, cancelable: true }));
}

test("a reply's like and dislike show its mark, liking it opens a place to say why, and the reason is kept with tags", async () => {
  const state = daemon();
  const view = await row(reply({ msg_id: "m_reply" }), { readOnly: true });
  expect(pressed(view.host)).toEqual([["Like", "false"], ["Dislike", "false"]]);
  expect(view.host.querySelector("article")?.getAttribute("data-msg-id")).toBe("m_reply");

  await click(button(view.host, "Like"));
  await settle();
  expect(state.sent.at(-1)).toEqual(["mark", { ref: "m_reply", position: 1, kind: "like" }]);
  expect(pressed(view.host)).toEqual([["Liked; remove the like", "true"], ["Dislike", "false"]]);
  expect(editor(view.host)?.getAttribute("aria-label")).toBe("Your mark on this response");
  expect([...view.host.querySelectorAll(".mark-editor [role=radio]")].map((radio) => [radio.textContent, radio.getAttribute("aria-checked")])).toEqual([["Like", "true"], ["Dislike", "false"]]);
  await click(button(view.host, "too long"));
  await click(button(view.host, "repetitive"));
  await click(button(view.host, "repetitive"));
  expect([...view.host.querySelectorAll(".mark-tag")].map((tag) => [tag.textContent, tag.getAttribute("aria-pressed")])).toEqual([["too long", "true"], ["repetitive", "false"]]);
  await type(view.host.querySelector(".mark-reason"), "warm but long");
  await click(button(view.host, "Save"));
  await settle();
  expect(state.sent.at(-1)).toEqual(["mark", { ref: "m_reply", position: 1, kind: "like", reason: "warm but long", tags: ["too long"] }]);
  expect(editor(view.host)).toBeNull();
  expect(chips(view.host)).toEqual([["mark-chip like whole", "Likedtoo long; warm but long"]]);

  await click(button(view.host, "Liked: too long; warm but long. Change"));
  expect(editor(view.host)).not.toBeNull();
  expect((view.host.querySelector(".mark-reason") as HTMLTextAreaElement).value).toBe("warm but long");
  await click(button(view.host, "Close"));
  expect(editor(view.host)).toBeNull();

  await click(button(view.host, "Liked; remove the like"));
  await settle();
  expect(state.sent.at(-1)).toEqual(["unmark", { ref: "m_reply", position: 1 }]);
  expect(chips(view.host)).toEqual([]);
  expect(pressed(view.host)).toEqual([["Like", "false"], ["Dislike", "false"]]);
});

test("the editor turns a dislike into a like, saves with Ctrl+Enter, closes with Escape, and removes a mark", async () => {
  const state = daemon();
  const view = await row(reply());
  await click(button(view.host, "Dislike"));
  await settle();
  expect(state.sent.at(-1)).toEqual(["mark", { ref: "m_reply", position: 1, kind: "dislike" }]);
  await click([...view.host.querySelectorAll(".mark-editor [role=radio]")][0]);
  await acting(() => { key(editor(view.host), "Enter", true); });
  await settle();
  expect(state.sent.at(-1)).toEqual(["mark", { ref: "m_reply", position: 1, kind: "like", reason: "", tags: [] }]);
  expect(editor(view.host)).toBeNull();

  await click(button(view.host, "Dislike"));
  await settle();
  await acting(() => { key(editor(view.host), "Enter"); });
  expect(editor(view.host), "Enter alone doesn't save").not.toBeNull();
  await acting(() => { key(editor(view.host), "Escape"); });
  expect(editor(view.host)).toBeNull();
  expect(state.sent.filter(([name]) => name === "mark")).toHaveLength(3);

  await click(button(view.host, "Disliked. Change"));
  await click(button(view.host, "Remove mark"));
  await settle();
  expect(state.sent.at(-1)).toEqual(["unmark", { ref: "m_reply", position: 1 }]);
  expect(editor(view.host)).toBeNull();
  expect(chips(view.host)).toEqual([]);
});

test("a mark on words is shown with them, opens their own editor, and is lit up where they are", async () => {
  daemon({ 1: [{ kind: "dislike", phrase: "sea **is**", reason: null, tags: ["repetitive"], at: AT }, { kind: "like", phrase: "nowhere", reason: null, tags: [], at: AT }] });
  const lit = new Map<string, { size: number; ranges: Range[] }>();
  class FakeHighlight { ranges: Range[]; size: number; constructor(...ranges: Range[]) { this.ranges = ranges; this.size = ranges.length; } }
  patch(globalThis, "Highlight", { writable: true, value: FakeHighlight });
  patch(globalThis, "CSS", { writable: true, value: { highlights: lit } });
  const view = await row(reply({ content: "The sea is wide.", content_blocks: [{ type: "text", text: "The sea **is** wide." }] }));
  expect(chips(view.host)).toEqual([["mark-chip dislike", "“sea **is**”repetitive"], ["mark-chip like", "“nowhere”"]]);
  expect(lit.get("shore-dislike")?.ranges.map((range) => range.toString())).toEqual(["sea is"]);
  expect(lit.get("shore-like")?.size, "words no longer in the text light nothing").toBe(0);
  await click(button(view.host, "Disliked “sea **is**”: repetitive. Change"));
  expect(editor(view.host)?.getAttribute("aria-label")).toBe("Your mark on “sea **is**”");
  expect(editor(view.host)?.querySelector(".mark-editor-what")?.textContent).toBe("“sea **is**”");
  expect(view.host.querySelector(".mark-editor .button.ghost")?.textContent).toBe("Remove mark");
  await view.unmount();
  expect(lit.get("shore-dislike")?.size).toBe(0);
});

test("a mark that fails is said so, and the toggles come back", async () => {
  const { toasts } = await import("../../src/browser/ui/toast.tsx");
  const shown = spyOn(toasts, "show");
  app.restores.push(() => { shown.mockRestore(); });
  const state = daemon();
  const view = await row(reply());
  state.fail = true;
  await click(button(view.host, "Like"));
  await settle();
  expect(shown.mock.calls.map(([text, tone]) => [text, tone])).toEqual([["the daemon said no", "error"]]);
  expect(editor(view.host)).toBeNull();
  expect((button(view.host, "Like")).disabled).toBe(false);
  state.fail = false;
  await click(button(view.host, "Like"));
  await settle();
  state.fail = true;
  await click(button(view.host, "Save"));
  await settle();
  expect(shown.mock.calls.at(-1)?.[0]).toBe("the daemon said no");
  expect(editor(view.host), "a failed save keeps the editor open").not.toBeNull();
  expect(button(view.host, "Save").disabled).toBe(false);
});

test("the newest reply offers another take and a reason besides the plain regenerate, in the toolbar and the phone menu", async () => {
  daemon();
  const { CONVERSATION_DIALOG_EVENT } = await import("../../src/browser/app/intents.ts");
  const opened: string[] = [];
  const listen = (event: Event) => { opened.push((event as CustomEvent<string>).detail); };
  addEventListener(CONVERSATION_DIALOG_EVENT, listen);
  app.restores.push(() => { removeEventListener(CONVERSATION_DIALOG_EVENT, listen); });
  const view = await row(reply(), { last: true });
  expect([...view.host.querySelectorAll(".message-actions > button, .message-actions > .menu > button")].map((item) => item.getAttribute("aria-label"))).toEqual(["Copy", "Edit", "Regenerate", "Other ways to regenerate", "Delete"]);
  await click(button(view.host, "Other ways to regenerate"));
  expect([...view.host.querySelectorAll("[role=menuitem]")].map((item) => item.textContent)).toEqual(["Another take", "Regenerate with a reason…"]);
  const before = app.socket().sent.length;
  await click([...view.host.querySelectorAll("[role=menuitem]")][0]);
  expect(app.sent(before).find((request) => request["type"] === "regen")).toMatchObject({ type: "regen", another_take: true });
  await click(button(view.host, "Other ways to regenerate"));
  await click([...view.host.querySelectorAll("[role=menuitem]")][1]);
  expect(opened).toEqual(["reason"]);

  const phone = await row(reply(), { last: true, mobile: true });
  await click(button(phone.host, "Message actions"));
  expect([...phone.host.querySelectorAll("[role=menuitem]")].map((item) => item.textContent)).toEqual(["Copy", "Edit", "Regenerate", "Another take", "Regenerate with a reason…", "Delete"]);
  const earlier = await row(reply(), { last: false });
  expect(earlier.host.querySelector("[aria-label='Other ways to regenerate']")).toBeNull();
});

test("each response in the list has its own marks and toggles, and its editor opens there", async () => {
  const state = daemon({ 1: [{ kind: "dislike", phrase: null, reason: "flat", tags: [], at: AT }] }, 2);
  const message = reply({ alt_index: 1, alt_count: 2, alternatives: [
    { content: "Try 1", images: [], content_blocks: [{ type: "text", text: "Try 1" }], timestamp: AT },
    { content: "Try 2", images: [], content_blocks: [{ type: "text", text: "Try 2" }], timestamp: AT },
  ] });
  const view = await row(message, { last: true });
  await click(button(view.host, "Response 2 of 2. Show all responses"));
  await settle();
  const list = () => document.body.querySelector(".alternatives");
  expect([...(list()?.querySelectorAll(".alternative") ?? [])].map((item) => [item.className, chips(item).map(([, text]) => text)])).toEqual([["alternative ", ["Dislikedflat"]], ["alternative on", []]]);
  expect(list()?.querySelector(".alternative-pick")?.getAttribute("aria-label")).toBe("Response 1. Show it");
  const first = list()?.querySelector(".alternative");
  if (!(first instanceof HTMLElement)) throw new Error("no first response");
  await click(button(first, "Like"));
  await settle();
  expect(state.sent.at(-1)).toEqual(["mark", { ref: "m_reply", position: 1, kind: "like" }]);
  expect(editor(first)).not.toBeNull();
  expect([...view.host.querySelectorAll(".mark-editor")].filter((open) => open.closest(".alternatives") === null), "the row behind the list doesn't open one too").toEqual([]);
  await click(button(first, "Close"));
  expect(editor(first)).toBeNull();
});

test("regenerating with a reason offers the tags, needs a tag or words, and sends both", async () => {
  daemon();
  const { ConversationDialogs } = await import("../../src/browser/chat/dialogs.tsx");
  let closed = 0;
  const view = await mount(<ConversationDialogs dialog="reason" state={app.state().workspace.getSnapshot()} close={() => { closed += 1; }} />);
  await settle();
  const go = () => button(view.host, "Regenerate");
  expect(go().disabled).toBe(true);
  await click(button(view.host, "too long"));
  expect(go().disabled).toBe(false);
  await click(button(view.host, "too long"));
  expect(go().disabled).toBe(true);
  await type(view.host.querySelector("textarea"), "  It missed the point.  ");
  expect(go().disabled).toBe(false);
  await click(button(view.host, "repetitive"));
  const before = app.socket().sent.length;
  await click(go());
  expect(closed).toBe(1);
  expect(app.sent(before).find((request) => request["type"] === "regen")).toMatchObject({ type: "regen", reason: "It missed the point.", tags: ["repetitive"] });
});

test("selected words in a reply can be liked or disliked as well as quoted, and then given a reason", async () => {
  const state = daemon();
  const { QuoteButton } = await import("../../src/browser/chat/QuoteButton.tsx");
  const host = document.createElement("div");
  host.innerHTML = `<article class="message assistant" data-role="assistant" data-msg-id="m_reply" data-alt-index="0" data-alt-count="1"><div class="message-body"><p class="prose">The sea is wide.</p></div></article>
    <article class="message user" data-role="user" data-msg-id="m_ask"><div class="message-body"><p class="prose">Tell me.</p></div></article>`;
  document.body.append(host);
  const view = await mount(<QuoteButton />);
  const choose = async (selector: string, from: number, to: number) => {
    const text = host.querySelector(selector)?.firstChild;
    if (text === null || text === undefined) throw new Error("no text");
    const range = document.createRange();
    range.setStart(text, from);
    range.setEnd(text, to);
    await acting(() => { getSelection()?.removeAllRanges(); getSelection()?.addRange(range); document.dispatchEvent(new Event("selectionchange")); });
  };
  await choose("[data-msg-id=m_ask] p", 0, 4);
  expect([...view.host.querySelectorAll("button")].map((item) => item.textContent)).toEqual(["Quote"]);
  expect(view.host.querySelector("[role=toolbar]")).toBeNull();
  await choose("[data-msg-id=m_reply] p", 4, 7);
  expect(view.host.querySelector("[role=toolbar]")?.getAttribute("aria-label")).toBe("Selected words");
  expect([...view.host.querySelectorAll("button")].map((item) => item.textContent)).toEqual(["Quote", "Like", "Dislike"]);
  await click(button(view.host, "Dislike"));
  await settle();
  expect(state.sent.at(-1)).toEqual(["mark", { ref: "m_reply", position: 1, kind: "dislike", phrase: "sea" }]);
  expect(app.state().replyMarks.editing()).toEqual({ ref: "m_reply", position: 1, phrase: "sea", place: "row" });
  expect(view.host.querySelector("[role=toolbar]")).toBeNull();
  host.remove();
});

test("the thread menu and the palette offer another take and a reason, and the transcript asks for its replies' marks", async () => {
  daemon();
  const turns = [
    { msg_id: "m_ask", role: "user", content: "Hi.", images: [], content_blocks: [{ type: "text", text: "Hi." }], timestamp: AT },
    reply({ msg_id: "m_reply" }),
  ];
  await acting(async () => {
    for (const request of app.socket().sent) if (request["type"] === "regen") app.socket().receive({ type: "request_finished", rid: request["rid"], outcome: "completed" });
    await Bun.sleep(5);
  });
  const before = app.socket().sent.length;
  await acting(async () => { app.socket().receive({ type: "history", messages: turns, config: {}, revision: 2, selected_character: "ada", selected_thread: "story" }); await Bun.sleep(5); });
  app.state().replyMarks.want("", []);
  const { Chat } = await import("../../src/browser/chat/Chat.tsx");
  const { Palette } = await import("../../src/browser/app/Palette.tsx");
  const { chromeOf } = await import("../../src/browser/chrome.ts");
  const chrome = chromeOf(undefined, app.state().workspace.getSnapshot());
  const view = await mount(<Chat state={chrome} sidebarOpen toggleSidebar={() => {}} mobile={false} />);
  await settle();
  expect(app.sent(before).filter((request) => request["name"] === "marks").map((request) => request["args"])).toEqual([{ refs: ["m_reply"] }]);
  expect(view.host.querySelector(".reply-footer .mark-toggle")).not.toBeNull();

  await click(button(view.host, "Thread options"));
  const items = () => [...view.host.querySelectorAll(".topbar [role=menuitem]")] as HTMLButtonElement[];
  expect(items().filter((item) => (item.textContent ?? "").includes("Another take") || (item.textContent ?? "").includes("with a reason")).map((item) => [item.textContent, item.disabled])).toEqual([["Another take", false], ["Regenerate with a reason…", false]]);
  const asked = app.socket().sent.length;
  await click(items().find((item) => item.textContent === "Another take"));
  const take = app.sent(asked).find((request) => request["type"] === "regen");
  expect(take).toMatchObject({ type: "regen", another_take: true });
  await acting(async () => { app.socket().receive({ type: "request_finished", rid: take?.["rid"], outcome: "completed" }); await Bun.sleep(5); });
  await click(button(view.host, "Thread options"));
  await click(items().find((item) => item.textContent === "Regenerate with a reason…"));
  expect(view.host.querySelector("dialog h2")?.textContent).toBe("Regenerate with a reason");
  await view.unmount();

  let closed = 0;
  const palette = await mount(<Palette state={chrome} close={() => { closed += 1; }} newThread={() => {}} newCharacter={() => {}} />);
  const offered = [...palette.host.querySelectorAll("[role=option]")].map((item) => item.textContent ?? "");
  expect(offered.filter((label) => label.startsWith("Another take") || label.startsWith("Regenerate with a reason"))).toHaveLength(2);
  const regens = app.socket().sent.length;
  await click([...palette.host.querySelectorAll("[role=option]")].find((item) => (item.textContent ?? "").startsWith("Another take")));
  expect(closed).toBe(1);
  expect(app.sent(regens).find((request) => request["type"] === "regen")).toMatchObject({ type: "regen", another_take: true });
});

function patch(target: object, name: string, value: PropertyDescriptor): void {
  const had = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, { configurable: true, ...value });
  app.restores.push(() => { if (had === undefined) Reflect.deleteProperty(target, name); else Object.defineProperty(target, name, had); });
}

const width = (root: ParentNode | null | undefined, selector: string) => root?.querySelector(selector)?.querySelector("svg")?.getAttribute("width");

test("toggles and chips are drawn at their sizes and say when a mark has no reason yet, and the toggles wait while a mark is saved", async () => {
  const state = daemon({ 1: [{ kind: "like", phrase: null, reason: null, tags: [], at: AT }, { kind: "dislike", phrase: "sea", reason: "flat", tags: [], at: AT }] });
  const view = await row(reply());
  expect([width(view.host, ".mark-toggle.like"), width(view.host, ".mark-toggle.dislike"), width(view.host, ".mark-chip")]).toEqual(["15", "15", "13"]);
  expect([...view.host.querySelectorAll(".mark-toggle")].map((toggle) => toggle.className)).toEqual(["icon-button mark-toggle like on", "icon-button mark-toggle dislike"]);
  expect([...view.host.querySelectorAll(".mark-chip")].map((chip) => chip.getAttribute("title"))).toEqual(["Add a reason", "flat"]);
  let answer = (): void => {};
  app.answer((asked) => {
    if (asked["name"] !== "mark") return undefined;
    const held = Promise.withResolvers<void>();
    answer = () => { held.resolve(); };
    void held.promise.then(() => { app.socket().receive({ type: "command_output", rid: asked["rid"], name: "mark", data: { ref: "m_reply", position: 1, attempt: "at_1", phrase: null, changed: true, marks: [] } }); app.socket().receive({ type: "request_finished", rid: asked["rid"], outcome: "completed" }); });
    return HOLD;
  });
  await click(button(view.host, "Dislike"));
  expect([...view.host.querySelectorAll(".mark-toggle")].map((toggle) => (toggle as HTMLButtonElement).disabled)).toEqual([true, true]);
  await acting(async () => { answer(); await Bun.sleep(10); });
  expect([...view.host.querySelectorAll(".mark-toggle")].map((toggle) => (toggle as HTMLButtonElement).disabled)).toEqual([false, false]);
  expect(state.sent).toHaveLength(1);
  const bare = await row(reply({ msg_id: "m_bare" }));
  expect(bare.host.querySelector(".mark-chips"), "no marks, no chips").toBeNull();
});

test("the editor takes the focus without scrolling, keeps its keys to itself, and shows it is saving", async () => {
  daemon();
  const focused: [string, FocusOptions | undefined][] = [];
  patch(HTMLElement.prototype, "focus", { writable: true, value: function (this: HTMLElement, options?: FocusOptions) { focused.push([this.className, options]); } });
  const view = await row(reply());
  await click(button(view.host, "Like"));
  await settle();
  expect(focused.filter(([name]) => name.includes("mark-reason"))).toEqual([["input textarea mark-reason", { preventScroll: true }]]);
  const area = view.host.querySelector(".mark-reason");
  expect([area?.getAttribute("rows"), width(view.host, ".mark-editor [role=radio]")]).toEqual(["2", "14"]);
  await click(button(view.host, "too long"));
  expect([...view.host.querySelectorAll(".mark-tag")].map((tag) => tag.className)).toEqual(["mark-tag on", "mark-tag "]);
  const keyed = (name: string, ctrlKey = false) => {
    const event = new KeyboardEvent("keydown", { key: name, ctrlKey, bubbles: true, cancelable: true });
    area?.dispatchEvent(event);
    return event;
  };
  app.answer((asked) => asked["name"] === "mark" ? HOLD : undefined);
  let saving: KeyboardEvent | undefined;
  await acting(() => { saving = keyed("Enter", true); });
  expect(saving?.defaultPrevented).toBe(true);
  expect([button(view.host, "Saving…").disabled, (area as HTMLTextAreaElement).disabled]).toEqual([true, true]);
  let escaping: KeyboardEvent | undefined;
  await acting(() => { escaping = keyed("Escape"); });
  expect(escaping?.defaultPrevented).toBe(true);
  expect(editor(view.host)).toBeNull();
});

test("words are lit only in the reply's own text, across paragraphs, from where they start, and nothing breaks without the highlight API or a body", async () => {
  daemon({ 1: [
    { kind: "like", phrase: null, reason: null, tags: [], at: AT },
    { kind: "dislike", phrase: "one. Start", reason: null, tags: [], at: AT },
    { kind: "like", phrase: "very wide", reason: null, tags: [], at: AT },
    { kind: "like", phrase: "Reasoning", reason: null, tags: [], at: AT },
    { kind: "like", phrase: "**", reason: null, tags: [], at: AT },
  ] });
  const message = reply({ content_blocks: [{ type: "thinking", thinking: "quiet" }, { type: "text", text: "End of one.\n\nStart of the **very** wide two." }] });
  const lit = new Map<string, { ranges: Range[] }>();
  class FakeHighlight { ranges: Range[]; constructor(...ranges: Range[]) { this.ranges = ranges; } }
  patch(globalThis, "CSS", { writable: true, value: { highlights: lit } });
  const bare = await row(message);
  expect(lit.size, "no Highlight, nothing lit and nothing thrown").toBe(0);
  await bare.unmount();
  Reflect.deleteProperty(globalThis, "CSS");
  patch(globalThis, "Highlight", { writable: true, value: FakeHighlight });
  patch(globalThis, "CSS", { writable: true, value: {} });
  const plain = await row(message);
  expect(lit.size, "no CSS.highlights, nothing lit and nothing thrown").toBe(0);
  await plain.unmount();
  patch(globalThis, "CSS", { writable: true, value: { highlights: lit } });
  const view = await row(message);
  expect(lit.get("shore-dislike")?.ranges.map((range) => range.toString())).toEqual(["one.Start"]);
  expect(lit.get("shore-like")?.ranges.map((range) => [range.toString(), range.startContainer.textContent])).toEqual([["very wide", "very"]]);
  await click(button(view.host, "Edit"));
  expect(view.host.querySelector(".edit-box"), "editing a lit reply doesn't break").not.toBeNull();
});

test("a reply's row carries which attempt it shows, a mark made before its marks load goes on the shown attempt, and only replies being read get marks", async () => {
  const state = daemon();
  const { MessageRow } = await import("../../src/browser/chat/Message.tsx");
  const { defaultViews } = await import("../../src/browser/preferences.ts");
  const shown = (message: Message) => mount(<MessageRow message={message} character="ada" avatar={null} last={false} metadata={undefined} display={defaultViews()} busy={false} mobile={false} openImage={() => {}} />);
  const plain = await shown(reply({ msg_id: "m_unloaded" }));
  expect([plain.host.querySelector("article")?.getAttribute("data-alt-index"), plain.host.querySelector("article")?.getAttribute("data-alt-count")]).toEqual(["0", "1"]);
  const second = await shown(reply({ msg_id: "m_second", alt_index: 1, alt_count: 2 }));
  await click(button(second.host, "Like"));
  await settle();
  expect(state.sent.at(-1)).toEqual(["mark", { ref: "m_second", position: 2, kind: "like" }]);
  const asked = await shown({ ...reply({ msg_id: "m_user" }), role: "user" });
  expect(asked.host.querySelector(".reply-footer")).toBeNull();
  await click(button(plain.host, "Edit"));
  expect(plain.host.querySelector(".reply-footer"), "editing hides the marks").toBeNull();
});

test("the list of responses tags only the one shown, and closing it closes any editor open in it", async () => {
  daemon({}, 2);
  const message = reply({ alt_index: 1, alt_count: 2, alternatives: [
    { content: "Try 1", images: [], content_blocks: [{ type: "text", text: "Try 1" }], timestamp: AT },
    { content: "Try 2", images: [], content_blocks: [{ type: "text", text: "Try 2" }], timestamp: AT },
  ] });
  const view = await row(message, { last: true });
  await click(button(view.host, "Response 2 of 2. Show all responses"));
  await settle();
  expect([...document.body.querySelectorAll(".alternative")].map((item) => item.querySelector(".tag")?.textContent ?? null)).toEqual([null, "shown"]);
  const first = document.body.querySelector(".alternative");
  if (!(first instanceof HTMLElement)) throw new Error("no first response");
  await click(button(first, "Like"));
  await settle();
  expect(app.state().replyMarks.editing()?.place).toBe("dialog");
  await click(button(document.body.querySelector("dialog") ?? document.body, "Close"));
  expect(document.body.querySelector(".alternatives")).toBeNull();
  expect(app.state().replyMarks.editing()).toBeNull();
});

test("the selection's buttons sit under it and stay on screen, the toolbar keeps its buttons in line, and marking happens on press", async () => {
  const state = daemon({}, 2);
  const { QuoteButton } = await import("../../src/browser/chat/QuoteButton.tsx");
  let rect = { left: 400, width: 100, top: 100, bottom: 120, right: 500, height: 20, x: 400, y: 100 };
  patch(Range.prototype, "getBoundingClientRect", { writable: true, value: () => rect });
  patch(HTMLElement.prototype, "offsetWidth", { get(this: HTMLElement) { return this.classList.contains("selection-actions") ? 200 : 0; } });
  app.state().replyMarks.want("", []);
  app.state().replyMarks.want("ada/story", [{ msg_id: "m_reply" }]);
  await settle();
  const host = document.createElement("div");
  host.innerHTML = `<article class="message assistant" data-role="assistant" data-msg-id="m_reply"><div class="message-body"><p class="prose">The sea is wide.</p></div></article>
    <article class="message assistant" data-role="assistant" data-msg-id="m_unknown"><div class="message-body"><p class="prose">Fog rolls.</p></div></article>
    <article class="message user" data-role="user" data-msg-id="m_ask"><div class="message-body"><p class="prose">Tell me.</p></div></article>`;
  document.body.append(host);
  const view = await mount(<QuoteButton />);
  const choose = async (selector: string, at: typeof rect) => {
    rect = at;
    const text = host.querySelector(selector)?.firstChild;
    if (text === null || text === undefined) throw new Error("no text");
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 3);
    await acting(() => { getSelection()?.removeAllRanges(); getSelection()?.addRange(range); document.dispatchEvent(new Event("selectionchange")); });
  };
  const middle = { ...rect };
  const right = { ...rect, left: 1000, width: 40 };
  const left = { ...rect, left: 0, width: 20 };
  const edge = innerWidth;
  const placed = () => view.host.querySelector<HTMLElement>(".quote-selection")?.style.left;
  await choose("[data-msg-id=m_ask] p", middle);
  expect(placed()).toBe("450px");
  await choose("[data-msg-id=m_ask] p", right);
  expect(placed()).toBe(`${String(edge - 56)}px`);
  await choose("[data-msg-id=m_reply] p", middle);
  expect(placed()).toBe("450px");
  expect(view.host.querySelector(".selection-actions button")?.getAttribute("style"), "the buttons inside sit in line").toBeNull();
  expect(width(view.host, ".selection-actions button:nth-child(2)")).toBe("14");
  await choose("[data-msg-id=m_reply] p", right);
  expect(placed()).toBe(`${String(edge - 108)}px`);
  await choose("[data-msg-id=m_reply] p", left);
  expect(placed()).toBe("108px");
  const press = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
  await acting(async () => { button(view.host, "Like").dispatchEvent(press); await Bun.sleep(10); });
  expect(press.defaultPrevented).toBe(true);
  expect(state.sent.at(-1)).toEqual(["mark", { ref: "m_reply", position: 2, kind: "like", phrase: "The" }]);
  await choose("[data-msg-id=m_unknown] p", middle);
  await click(button(view.host, "Dislike"));
  await settle();
  expect(state.sent.at(-1)).toEqual(["mark", { ref: "m_unknown", position: 1, kind: "dislike", phrase: "Fog" }]);
  host.remove();
});

test("the reason dialog and the editor load the tags when nothing has yet, show a single tag, and say tags can stand in for words", async () => {
  let tags = ["only"];
  app.answer((asked) => {
    if (asked["name"] === "marks") return { tags, replies: [] };
    if (asked["name"] === "mark") return { ref: "m_fresh", position: 1, attempt: "at_1", phrase: null, changed: true, marks: [{ kind: "like", phrase: null, reason: null, tags: [], at: AT }] };
    return undefined;
  });
  const { ConversationDialogs } = await import("../../src/browser/chat/dialogs.tsx");
  app.state().replyMarks.want("fresh", []);
  const dialog = await mount(<ConversationDialogs dialog="reason" state={app.state().workspace.getSnapshot()} close={() => {}} />);
  await settle();
  expect([...dialog.host.querySelectorAll(".mark-tag")].map((tag) => tag.textContent)).toEqual(["only"]);
  expect(dialog.host.querySelector(".field span .muted")?.textContent).toBe("(optional with a tag)");
  expect(dialog.host.querySelector("textarea")?.getAttribute("rows")).toBe("4");
  await click(button(dialog.host, "only"));
  expect(dialog.host.querySelector(".mark-tag")?.className).toBe("mark-tag on");
  await dialog.unmount();

  tags = [];
  app.state().replyMarks.want("fresher", []);
  const none = await mount(<ConversationDialogs dialog="reason" state={app.state().workspace.getSnapshot()} close={() => {}} />);
  await settle();
  expect([none.host.querySelector(".mark-tags"), none.host.querySelector(".field span .muted")]).toEqual([null, null]);
  await none.unmount();

  tags = ["only"];
  app.state().replyMarks.want("freshest", []);
  const { MessageRow } = await import("../../src/browser/chat/Message.tsx");
  const { defaultViews } = await import("../../src/browser/preferences.ts");
  const view = await mount(<MessageRow message={reply({ msg_id: "m_fresh" })} character="ada" avatar={null} last={false} metadata={undefined} display={defaultViews()} busy={false} mobile={false} openImage={() => {}} />);
  await click(button(view.host, "Like"));
  await settle();
  expect([...view.host.querySelectorAll(".mark-editor .mark-tag")].map((tag) => tag.textContent)).toEqual(["only"]);
});

test("the thread menu offers another take and a reason only when it can, and opens the reason dialog when asked", async () => {
  daemon();
  const turns = [{ msg_id: "m_ask", role: "user", content: "Hi.", images: [], content_blocks: [{ type: "text", text: "Hi." }], timestamp: AT }, reply()];
  await acting(async () => {
    for (const request of app.socket().sent) if (request["type"] === "regen") app.socket().receive({ type: "request_finished", rid: request["rid"], outcome: "completed" });
    app.socket().receive({ type: "history", messages: turns, config: {}, revision: 20, selected_character: "ada", selected_thread: "story" });
    await Bun.sleep(5);
  });
  const { Chat } = await import("../../src/browser/chat/Chat.tsx");
  const { chromeOf } = await import("../../src/browser/chrome.ts");
  const { openConversationDialog } = await import("../../src/browser/app/intents.ts");
  const chrome = chromeOf(undefined, app.state().workspace.getSnapshot());
  const takes = async (host: HTMLElement) => {
    await click(button(host, "Thread options"));
    const found = [...host.querySelectorAll(".topbar [role=menuitem]")].filter((item) => ["Another take", "Regenerate with a reason…"].includes(item.textContent ?? "")).map((item) => (item as HTMLButtonElement).disabled);
    await click(button(host, "Thread options"));
    return found;
  };
  const offline = await mount(<Chat state={{ ...chrome, status: "connecting" }} sidebarOpen toggleSidebar={() => {}} mobile={false} />);
  expect(await takes(offline.host)).toEqual([true, true]);
  await offline.unmount();
  const view = await mount(<Chat state={chrome} sidebarOpen toggleSidebar={() => {}} mobile={false} />);
  expect(await takes(view.host)).toEqual([false, false]);
  await acting(() => { openConversationDialog("nonsense"); });
  expect(view.host.querySelector("dialog")).toBeNull();
  await acting(() => { openConversationDialog("reason"); });
  expect(view.host.querySelector("dialog h2")?.textContent).toBe("Regenerate with a reason");
  await click(button(view.host.querySelector("dialog") ?? view.host, "Cancel"));
  await click(button(view.host, "Regenerate"));
  expect(await takes(view.host), "a regenerate in flight makes them wait").toEqual([true, true]);
});

test("in a heartbeat thread the palette offers neither another take nor a model, and taking another one returns to the chat", async () => {
  daemon();
  const { Palette } = await import("../../src/browser/app/Palette.tsx");
  const { chromeOf } = await import("../../src/browser/chrome.ts");
  const { navigate } = await import("../../src/browser/app/route.ts");
  const chrome = chromeOf(undefined, app.state().workspace.getSnapshot());
  const offered = async (state: typeof chrome) => {
    const palette = await mount(<Palette state={state} close={() => {}} newThread={() => {}} newCharacter={() => {}} />);
    const labels = [...palette.host.querySelectorAll("[role=option]")].map((item) => item.textContent ?? "");
    await palette.unmount();
    return [labels.some((label) => label.startsWith("Another take")), labels.some((label) => label.startsWith("Choose a model"))];
  };
  expect(await offered({ ...chrome, threads: chrome.threads.map((thread) => ({ ...thread, heartbeat: true })) })).toEqual([false, false]);
  expect(await offered(chrome)).toEqual([true, true]);
  navigate({ view: "settings", page: "models" });
  const palette = await mount(<Palette state={chrome} close={() => {}} newThread={() => {}} newCharacter={() => {}} />);
  await click([...palette.host.querySelectorAll("[role=option]")].find((item) => (item.textContent ?? "").startsWith("Another take")));
  expect(location.hash).toBe("");
});
