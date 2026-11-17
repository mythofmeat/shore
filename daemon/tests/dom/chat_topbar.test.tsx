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
