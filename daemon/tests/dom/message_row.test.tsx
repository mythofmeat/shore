import { expect, test } from "bun:test";

import type { Message } from "../../src/protocol/Message.ts";
import { useApp } from "./app.ts";
import { mount } from "./dom.ts";

useApp();

const AT = "2026-10-30T12:11:00.000Z";

function message(extra: Partial<Message>): Message {
  return { msg_id: "m1", role: "user", content: "", images: [], content_blocks: [], timestamp: AT, ...extra };
}

async function row(shown: Message, last = false): Promise<HTMLElement> {
  const { MessageRow } = await import("../../src/browser/chat/Message.tsx");
  const { defaultViews } = await import("../../src/browser/preferences.ts");
  const view = await mount(<MessageRow message={shown} character="ada" avatar={null} last={last} metadata={undefined} display={defaultViews()} busy={false} mobile={false} openImage={() => {}} />);
  return view.host;
}

const clock = new Date(AT).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

test("a wake's opening note, and one from when Shore called it a heartbeat, are folded away under what they are and when, without the marker they start with", async () => {
  const wake = await row(message({ origin: "autonomous", content: '[wake]\n\n[Your trigger "show" fired.]' }));
  expect(wake.querySelector("details.system-note.heartbeat-note summary")?.textContent).toBe(`Wake · ${clock}`);
  expect(wake.querySelector("details")?.textContent).toBe(`Wake · ${clock}[Your trigger "show" fired.]`);
  expect(wake.querySelector("article")).toBeNull();

  const beat = await row(message({ origin: "autonomous", content: "[heartbeat]\n\nNothing new." }));
  expect(beat.querySelector("details")?.textContent).toBe(`Wake · ${clock}Nothing new.`);
  const undated = await row(message({ origin: "autonomous", content: "[wake]\n\nNo clock.", timestamp: "never" }));
  expect(undated.querySelector("summary")?.textContent).toBe("Wake");
});

test("any other note Shore left in a thread is folded under its first line, cut at eighty characters", async () => {
  const stopped = await row(message({ role: "system", origin: "autonomous", content: "[wake] was the word.\nSecond line." }));
  expect(stopped.querySelector("summary")?.textContent).toBe("[wake] was the word.");
  expect(stopped.querySelector("details")?.textContent).toBe("[wake] was the word.[wake] was the word.\nSecond line.");
  const long = await row(message({ origin: "autonomous", content: `Told: ${"a".repeat(80)}` }));
  expect(long.querySelector("summary")?.textContent).toBe(`Told: ${"a".repeat(73)}…`);
  const exact = await row(message({ origin: "autonomous", content: "b".repeat(80) }));
  expect(exact.querySelector("summary")?.textContent).toBe("b".repeat(80));
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
