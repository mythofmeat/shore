import { expect, spyOn, test } from "bun:test";

import type { ThreadView } from "../../src/protocol/ThreadView.ts";
import type { ChromeSnapshot } from "../../src/browser/workspace.ts";
import { useApp } from "./app.ts";
import { acting, button, click, mount } from "./dom.ts";

const app = useApp();

const settle = async () => { await acting(() => Bun.sleep(5)); };

const HOME: ThreadView = { id: "story", label: "Our story", created_at: "2026-11-01T00:00:00Z", compaction: true, home: true, current: true };
const SIDE: ThreadView = { id: "side", label: "By the lamp", created_at: "2026-11-02T00:00:00Z", compaction: true, home: false, current: false };
const PICTURE = { mime_type: "image/png", data: "YWRh" };

async function chrome(over: Partial<ChromeSnapshot> = {}): Promise<ChromeSnapshot> {
  const { chromeOf } = await import("../../src/browser/chrome.ts");
  return {
    ...chromeOf(undefined, app.state().workspace.getSnapshot()),
    status: "ready", character: "ada", thread: "story", threads: [HOME, SIDE], opening: null,
    characters: [{ name: "bo", avatar: { mime_type: "image/png", data: "Ym8=" } }, { name: "ada", avatar: PICTURE }],
    ...over,
  };
}

async function chat(state: ChromeSnapshot, mobile = false) {
  const { Chat } = await import("../../src/browser/chat/Chat.tsx");
  const element = (next: ChromeSnapshot) => <Chat state={next} sidebarOpen toggleSidebar={() => {}} mobile={mobile} />;
  const view = await mount(element(state));
  await settle();
  const thread = () => view.host.querySelector<HTMLButtonElement>(".topbar-thread");
  return {
    ...view,
    rerender: async (next: ChromeSnapshot) => { await view.update(element(next)); await settle(); },
    name: () => view.host.querySelector(".topbar-name")?.textContent,
    thread: () => {
      const shown = thread();
      return shown === null ? null : [shown.textContent, shown.getAttribute("aria-label"), shown.disabled];
    },
    menu: async () => {
      await click(button(view.host, "Thread options"));
      const items = [...view.host.querySelectorAll<HTMLButtonElement>(".topbar [role=menuitem]")];
      const shown = items.map((item) => [item.textContent, item.disabled, item.classList.contains("danger")]);
      await click(button(view.host, "Thread options"));
      return shown;
    },
  };
}

test("the topbar shows the character's own picture and the open thread's label, the thread a switch is opening, and no thread while a character opens", async () => {
  const view = await chat(await chrome());
  const avatar = view.host.querySelector<HTMLImageElement>(".topbar img.avatar");
  expect([avatar?.getAttribute("src"), avatar?.style.width]).toEqual(["data:image/png;base64,YWRh", "30px"]);
  expect([view.name(), view.thread()]).toEqual(["ada", ["Our story", "Our story. Thread settings", false]]);

  await view.rerender(await chrome({ opening: { character: "ada", thread: "side" } }));
  expect(view.thread()).toEqual(["By the lamp", "By the lamp. Thread settings", true]);

  await view.rerender(await chrome({ opening: { character: "bo", thread: null } }));
  expect([view.name(), view.thread()]).toEqual(["bo", null]);

  await view.rerender(await chrome({ thread: "gone" }));
  expect(view.thread()).toEqual(["gone", "gone. Thread settings", false]);

  await view.rerender(await chrome({ thread: null }));
  expect(view.thread()).toBeNull();

  await view.rerender(await chrome({ status: "reconnecting" }));
  expect(view.thread()).toEqual(["Our story", "Our story. Thread settings", true]);
});

test("the thread menu offers another take and a reason once connected, with a turn to redo and no reply running, and another take asks for one", async () => {
  const regen = (shown: unknown[][]) => shown.filter(([label]) => label === "Another take" || label === "Regenerate with a reason…").map(([, disabled]) => disabled);
  const said = (id: string, role: string, revision: number) => ({ type: "history", messages: [{ msg_id: id, role, content: "hi", content_blocks: [], timestamp: "2026-11-27T10:00:00.000Z", images: [] }], config: {}, revision, selected_character: "ada", selected_thread: "story" });
  const view = await chat(await chrome());
  await acting(() => { app.socket().receive(said("m_note", "system", 50)); });
  expect(regen(await view.menu()), "a note from Shore is no turn to redo").toEqual([true, true]);
  await acting(() => { app.socket().receive(said("m_reply", "assistant", 51)); });
  expect(regen(await view.menu())).toEqual([false, false]);
  await view.rerender(await chrome({ status: "reconnecting" }));
  expect(regen(await view.menu())).toEqual([true, true]);
  await view.rerender(await chrome());
  const since = app.socket().sent.length;
  await click(button(view.host, "Thread options"));
  await click([...view.host.querySelectorAll<HTMLButtonElement>(".topbar [role=menuitem]")].find((item) => item.textContent === "Another take"));
  await settle();
  expect(app.sent(since).filter((request) => request["type"] === "regen").map((request) => request["another_take"])).toEqual([true]);
  expect(regen(await view.menu()), "not while a reply is running").toEqual([true, true]);
});

test("an archived thread opens to read, with a notice that unarchives it, a note where the message box was, and a menu that unarchives it instead of offering to redo or move it", async () => {
  const archived: ThreadView = { ...SIDE, archived: "2026-11-27T10:00:00Z" };
  const view = await chat(await chrome({ thread: "side", threads: [HOME, archived] }));
  const notice = () => view.host.querySelector(".banner[role=status]");
  expect([notice()?.textContent, view.host.querySelector(".composer-note")?.textContent, view.host.querySelector("textarea, .cm-editor")]).toEqual([
    "Archived. ada doesn't see this thread, and nothing more can be written here until it is unarchived.Unarchive",
    "This thread is archived, to read. Unarchive it to write to ada here.",
    null,
  ]);
  const labels = (await view.menu()).map(([label, disabled, danger]) => [label, disabled, danger]);
  expect(labels.filter(([label]) => ["Another take", "Regenerate with a reason…", "Make home", "Archive…", "Unarchive"].includes(String(label)))).toEqual([["Unarchive", false, false]]);
  const since = app.socket().sent.length;
  await click(button(view.host, "Unarchive"));
  await click(button(view.host, "Thread options"));
  await click([...view.host.querySelectorAll<HTMLButtonElement>(".topbar [role=menuitem]")].find((item) => item.textContent === "Unarchive"));
  await settle();
  expect(app.sent(since).filter((request) => request["name"] === "unarchive_thread").map((request) => request["args"])).toEqual([{ name: "side" }, { name: "side" }]);
  await view.rerender(await chrome({ thread: "side", threads: [HOME, archived], status: "reconnecting" }));
  expect([button(view.host, "Unarchive").disabled, (await view.menu()).find(([label]) => label === "Unarchive")?.[1]]).toEqual([true, true]);
  await view.rerender(await chrome({ thread: "side" }));
  expect([notice(), view.host.querySelector(".composer-note")]).toEqual([null, null]);
});

test("the thread menu marks the open thread for later or clears its mark, and offers neither for a thread not in the list", async () => {
  const later = (shown: unknown[][]) => shown.filter(([label]) => String(label).includes("later")).map(([label, disabled]) => [label, disabled]);
  const view = await chat(await chrome({ thread: "side" }));
  expect(later(await view.menu())).toEqual([["Mark for later", false]]);
  await view.rerender(await chrome({ thread: "side", threads: [HOME, { ...SIDE, later: "2026-11-27T10:00:00Z" }], status: "reconnecting" }));
  expect(later(await view.menu())).toEqual([["Clear later mark", true]]);
  await view.rerender(await chrome({ thread: "gone" }));
  expect(later(await view.menu())).toEqual([]);
});

test("the thread menu waits for the connection, and the home thread can't be archived", async () => {
  const pick = (shown: unknown[][]) => shown.filter(([label]) => ["Thread settings…", "Compact context…", "Fork…", "Archive…"].includes(String(label)));
  const view = await chat(await chrome({ thread: "side" }));
  expect(pick(await view.menu())).toEqual([["Thread settings…", false, false], ["Compact context…", false, false], ["Fork…", false, false], ["Archive…", false, true]]);
  await view.rerender(await chrome());
  expect(pick(await view.menu()).at(-1)).toEqual(["Archive…", true, true]);
  await view.rerender(await chrome({ thread: "side", status: "reconnecting" }));
  expect(pick(await view.menu())).toEqual([["Thread settings…", true, false], ["Compact context…", true, false], ["Fork…", true, false], ["Archive…", true, true]]);
});

test("a dialog asked for from elsewhere opens over the chat, closes when the thread or character changes, and a chat that is gone stops listening", async () => {
  const { openConversationDialog, CONVERSATION_DIALOG_EVENT } = await import("../../src/browser/app/intents.ts");
  const title = () => document.body.querySelector("dialog h2")?.textContent;
  const added = spyOn(window, "addEventListener");
  const removed = spyOn(window, "removeEventListener");
  app.restores.push(() => { added.mockRestore(); removed.mockRestore(); });
  const view = await chat(await chrome());
  await acting(() => { openConversationDialog("system"); });
  expect(title()).toBe("Add system message");
  await view.rerender(await chrome({ thread: "side" }));
  expect(title()).toBeUndefined();
  await acting(() => { openConversationDialog("compact"); });
  expect(title()).toBe("Compact context");
  await view.rerender(await chrome({ character: "bo", thread: "side" }));
  expect(title()).toBeUndefined();

  await view.unmount();
  const listening = (calls: readonly (readonly unknown[])[]) => calls.filter(([type]) => type === CONVERSATION_DIALOG_EVENT).map(([, listener]) => listener);
  expect(listening(added.mock.calls)).not.toEqual([]);
  expect(listening(added.mock.calls).filter((listener) => !listening(removed.mock.calls).includes(listener))).toEqual([]);
});

test("on a phone the topbar leaves the usage chip out", async () => {
  const { display } = app.state();
  display.change("usage", "always");
  app.restores.push(() => { display.change("usage", "off"); });
  const asked = async (mobile: boolean) => {
    const since = app.socket().sent.length;
    const view = await chat(await chrome(), mobile);
    await view.unmount();
    return app.sent(since).filter((request) => request["name"] === "usage").map((request) => request["args"]);
  };
  expect(await asked(false)).toEqual([{ budget: true }]);
  expect(await asked(true)).toEqual([]);
});
