import { expect, test } from "bun:test";

import type { Message } from "../../src/protocol/Message.ts";
import type { StreamMetadata } from "../../src/protocol/StreamMetadata.ts";
import type { ViewValues } from "../../src/browser/preferences.ts";
import { useApp } from "./app.ts";
import { acting, click, mount } from "./dom.ts";
import { INTERRUPTED_REPLY_NOTE } from "../../src/engine/interrupted_note.ts";

const app = useApp();

const AT = "2026-10-30T12:11:00.000Z";

function message(extra: Partial<Message>): Message {
  return { msg_id: "m1", role: "user", content: "", images: [], content_blocks: [], timestamp: AT, ...extra };
}

interface RowOptions { busy?: boolean; readOnly?: boolean; mobile?: boolean; lastUser?: boolean; display?: Partial<ViewValues>; metadata?: StreamMetadata }

async function rowElement(shown: Message, last: boolean, { busy = false, readOnly = false, mobile = false, lastUser, display = {}, metadata }: RowOptions) {
  const { MessageRow } = await import("../../src/browser/chat/Message.tsx");
  const { defaultViews } = await import("../../src/browser/preferences.ts");
  return <MessageRow message={shown} character="ada" avatar={null} last={last} {...(lastUser === undefined ? {} : { lastUser })} metadata={metadata} display={{ ...defaultViews(), ...display }} busy={busy} mobile={mobile} openImage={() => {}} readOnly={readOnly} />;
}

async function row(shown: Message, last = false, options: RowOptions = {}): Promise<HTMLElement> {
  return (await mount(await rowElement(shown, last, options))).host;
}

const clock = new Date(AT).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

test("a wake's opening note, and one from when Shore called it a heartbeat, are folded away under what they are and when, without the marker they start with", async () => {
  const wake = await row(message({ origin: "autonomous", content: '[wake]\n\n[Your trigger "show" fired.]' }));
  expect(wake.querySelector("details.system-note.wake-note summary")?.textContent).toBe(`Wake · ${clock}`);
  expect(wake.querySelector("details")?.textContent).toBe(`Wake · ${clock}[Your trigger "show" fired.]`);
  expect(wake.querySelector("article")).toBeNull();

  const beat = await row(message({ origin: "autonomous", content: "[heartbeat]\n\nNothing new." }));
  expect(beat.querySelector("details")?.textContent).toBe(`Wake · ${clock}Nothing new.`);
  const undated = await row(message({ origin: "autonomous", content: "[wake]\n\nNo clock.", timestamp: "never" }));
  expect(undated.querySelector("summary")?.textContent).toBe("Wake");
});

test("in the wakes thread a wake's opening note says which thread it ran in", async () => {
  const kept = await row(message({ origin: "autonomous", content: '[wake in "main"]\n\n[Your trigger "show" fired.]' }));
  expect(kept.querySelector("details.wake-note summary")?.textContent).toBe(`Wake in main · ${clock}`);
  expect(kept.querySelector("details")?.textContent).toBe(`Wake in main · ${clock}[Your trigger "show" fired.]`);
  const undated = await row(message({ origin: "autonomous", content: '[wake in "side.2"]\n\nNo clock.', timestamp: "never" }));
  expect(undated.querySelector("summary")?.textContent).toBe("Wake in side.2");
  const unnamed = await row(message({ origin: "autonomous", content: '[wake in ""]\n\nNo name.' }));
  expect(unnamed.querySelector("summary")?.textContent).toBe('[wake in ""]');
});

test("the line saying where a wake's working went is shown as it is, with nothing folded under it", async () => {
  const line = await row(message({ role: "system", origin: "autonomous", content: 'This wake\'s working is in "Wakes": 4 tool calls.' }));
  expect(line.querySelector("details")).toBeNull();
  expect(line.querySelector("div.system-note")?.textContent).toBe('This wake\'s working is in "Wakes": 4 tool calls.');
  expect(line.querySelector("article")).toBeNull();
});

test("any other note Shore left in a thread is folded under its first line, cut at eighty characters, unless that line is all of it", async () => {
  const stopped = await row(message({ role: "system", origin: "autonomous", content: "[wake] was the word.\nSecond line." }));
  expect(stopped.querySelector("summary")?.textContent).toBe("[wake] was the word.");
  expect(stopped.querySelector("details")?.textContent).toBe("[wake] was the word.[wake] was the word.\nSecond line.");
  const long = await row(message({ origin: "autonomous", content: `Told: ${"a".repeat(80)}` }));
  expect(long.querySelector("summary")?.textContent).toBe(`Told: ${"a".repeat(73)}…`);
  const exact = await row(message({ origin: "autonomous", content: "b".repeat(80) }));
  expect([exact.querySelector("details"), exact.querySelector("div.system-note")?.textContent]).toEqual([null, "b".repeat(80)]);
  const spaced = await row(message({ role: "system", origin: "autonomous", content: `  ${"c".repeat(78)}  ` }));
  expect(spaced.querySelector("details")).toBeNull();
});

test("a message the character sent on its own is marked unprompted, and what the user and Shore say is shown as theirs", async () => {
  const sent = await row(message({ role: "assistant", origin: "autonomous", content: "Part one.", content_blocks: [{ type: "text", text: "Part one." }] }));
  expect(sent.querySelector("article.message.assistant")?.getAttribute("aria-label")).toBe(`ada, ${clock}`);
  expect(sent.querySelector(".message-meta .tag")?.textContent).toBe("unprompted");
  expect(sent.querySelector(".message-name")?.textContent).toBe("ada");
  expect(sent.querySelector("details")).toBeNull();

  const reply = await row(message({ role: "assistant", content: "Hello.", content_blocks: [{ type: "text", text: "Hello." }] }), true);
  expect(reply.querySelector(".message-meta .tag")).toBeNull();
  expect(reply.querySelector("article")?.className).toBe("message assistant  last");
  expect([...reply.querySelectorAll(".message-actions button")].map((button) => button.getAttribute("aria-label"))).toEqual(["Copy", "Edit", "Regenerate", "Other ways to regenerate", "Delete"]);

  const asked = await row(message({ content: "And then?", content_blocks: [{ type: "text", text: "And then?" }] }));
  expect(asked.querySelector("article.message.user")?.getAttribute("aria-label")).toBe(`You, ${clock}`);
  expect(asked.querySelector(".message-name")?.textContent).toBe("You");
  expect(asked.querySelector(".message-body")?.textContent).toBe("And then?");
  expect([...asked.querySelectorAll(".message-actions button")].map((button) => button.getAttribute("aria-label"))).toEqual(["Copy", "Edit", "Delete"]);

  const system = await row(message({ role: "system", content: "Compacted." }));
  expect(system.querySelector("div.system-note")?.textContent).toBe("Compacted.");
  expect(system.querySelector("details")).toBeNull();
});

test("a note that a reply was cut short offers to continue it while it is the newest thing here, and continuing sends no new words", async () => {
  const note = message({ role: "system", content: INTERRUPTED_REPLY_NOTE });
  const offer = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("div.system-note button");
  expect([offer(await row(note)), offer(await row(note, true, { readOnly: true })), offer(await row(message({ role: "system", content: "Something else." }), true))]).toEqual([null, null, null]);
  expect(offer(await row(note, true, { busy: true }))?.disabled).toBe(true);
  const newest = await row(note, true);
  expect([newest.querySelector("div.system-note")?.textContent, offer(newest)?.disabled]).toEqual([`${INTERRUPTED_REPLY_NOTE}Continue the reply`, false]);
  const before = app.socket().sent.length;
  await click(offer(newest));
  expect(app.sent(before).find((request) => request["type"] === "message")).toMatchObject({ type: "message", text: "", images: [], stream: true });
});

const reply = () => message({ role: "assistant", content: "Hello.", content_blocks: [{ type: "text", text: "Hello." }], model: "claude-fixture" });
const asked = (msg_id = "m1") => message({ msg_id, content: "And then?", content_blocks: [{ type: "text", text: "And then?" }] });

test("a row says when it was sent unless timestamps are off, and with metadata on, the reply's numbers or else the model it came from", async () => {
  const stamped = await row(reply());
  expect([stamped.querySelector(".message-meta time")?.textContent, stamped.querySelector(".message-metadata")]).toEqual([clock, null]);
  expect((await row(reply(), false, { display: { timestamps: "off" } })).querySelector("time")).toBeNull();
  expect((await row({ ...reply(), timestamp: "never" })).querySelector("time")).toBeNull();
  expect((await row(reply(), false, { display: { metadata: "on" } })).querySelector(".message-metadata")?.textContent).toBe("claude-fixture");
  const numbers: StreamMetadata = { model: "claude-counted", tokens: { input: 1, output: 2, cache_read: 3, cache_write: 4 }, timing: { total_ms: 5, ttft_ms: 6 } };
  expect((await row(reply(), false, { display: { metadata: "on" }, metadata: numbers })).querySelector(".message-metadata")?.textContent).toBe("claude-counted · in: 1 · out: 2 · cache: 3 read / 4 write · 5 ms · first token: 6 ms");
  const { model: _model, ...unnamed } = reply();
  expect((await row(unnamed, false, { display: { metadata: "on" } })).querySelector(".message-metadata")).toBeNull();
});

test("on a phone a row's actions are in its menu, where Delete is marked as dangerous, and its avatar is smaller", async () => {
  const width = (host: HTMLElement) => host.querySelector<HTMLElement>(".avatar")?.style.width;
  const desk = await row(reply());
  expect([desk.querySelector(".message-actions") === null, desk.querySelector(".message-menu"), desk.querySelector(".avatar.user"), width(desk)]).toEqual([false, null, null, "36px"]);
  const deskUser = await row(asked());
  expect([deskUser.querySelector(".avatar.user") === null, width(deskUser)]).toEqual([false, "36px"]);
  const phone = await row(reply(), false, { mobile: true });
  expect([phone.querySelector(".message-actions"), phone.querySelector(".message-menu") === null, width(phone)]).toEqual([null, false, "32px"]);
  expect(width(await row(asked(), false, { mobile: true }))).toBe("32px");
  await click(phone.querySelector(".message-menu button"));
  expect([...phone.querySelectorAll("[role=menuitem]")].map((item) => [item.textContent, item.className])).toEqual([["Copy", ""], ["Edit", ""], ["Delete", "danger"]]);
});

test("Delete asks before it removes a message, and Copy puts the message's words on the clipboard", async () => {
  const written: string[] = [];
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { written.push(text); } } });
  try {
    const shown = await row(asked());
    await click(shown.querySelector("button[aria-label=Copy]"));
    expect(written).toEqual(["And then?"]);
    expect(shown.querySelector(".confirm-bar")).toBeNull();
    await click(shown.querySelector("button[aria-label=Delete]"));
    expect(shown.querySelector(".confirm-bar")?.textContent).toBe("Delete this message?CancelDelete");
    await click([...shown.querySelectorAll(".confirm-bar button")].find((button) => button.textContent === "Cancel"));
    expect(shown.querySelector(".confirm-bar")).toBeNull();
  } finally {
    if (original === undefined) Reflect.deleteProperty(navigator, "clipboard"); else Object.defineProperty(navigator, "clipboard", original);
  }
});

test("the shortcut to edit the last message opens only the user's last message, and not once that message is no longer the last", async () => {
  const editing = (host: HTMLElement) => host.querySelector("textarea[aria-label='Edit message']") !== null;
  const editLast = () => acting(() => { dispatchEvent(new Event("shore:edit-last")); });
  const latest = await mount(await rowElement(asked(), true, { lastUser: true }));
  const earlier = await row(asked("m0"));
  await editLast();
  expect([editing(latest.host), editing(earlier)]).toEqual([true, false]);
  const moved = await mount(await rowElement(asked("m2"), true, { lastUser: true }));
  await moved.update(await rowElement(asked("m2"), false, { lastUser: false }));
  await editLast();
  expect(editing(moved.host)).toBe(false);
});
