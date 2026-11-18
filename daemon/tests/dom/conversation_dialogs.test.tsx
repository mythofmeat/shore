import { expect, spyOn, test } from "bun:test";

import { useApp } from "./app.ts";
import { button, click, mount, type } from "./dom.ts";

const app = useApp();
const settle = async () => { await Bun.sleep(10); };

test("compacting the context closes the dialog, then says how many turns were archived once the thread is back in step", async () => {
  const { ConversationDialogs } = await import("../../src/browser/chat/dialogs.tsx");
  const { toasts } = await import("../../src/browser/ui/toast.tsx");
  const shown = spyOn(toasts, "show");
  app.restores.push(() => { shown.mockRestore(); });
  app.answer((asked) => {
    if (asked["name"] === "compact") return { status: "rotated", character: "ada", compacted_turns: 3, retained_turns: 1, dry_run: false, memory_files_written: [] };
    if (asked["name"] === "switch_thread") return { character: "ada", thread: "story", changed: false };
    return undefined;
  });
  let closed = 0;
  const view = await mount(<ConversationDialogs dialog="compact" state={app.state().workspace.getSnapshot()} close={() => { closed += 1; }} />);
  await type(view.host.querySelector("input.input"), "1");
  const before = app.socket().sent.length;
  await click(button(view.host, "Compact"));
  expect(closed).toBe(1);
  await settle();
  const asked = app.sent(before).filter((request) => request["type"] === "command").map((request) => [request["name"], request["args"]]);
  expect(asked).toEqual([["compact", { keep_turns: 1 }], ["list_threads", {}], ["switch_thread", { name: "story", resync: true }]]);
  expect(shown.mock.calls.map(([text]) => text)).toEqual(["Archived 3 turns and kept the last 1."]);
});

test("a compaction that finishes after the user has moved on names the thread it compacted", async () => {
  const { ConversationDialogs } = await import("../../src/browser/chat/dialogs.tsx");
  const { toasts } = await import("../../src/browser/ui/toast.tsx");
  const shown = spyOn(toasts, "show");
  app.restores.push(() => { shown.mockRestore(); });
  app.answer((asked) => asked["name"] === "compact" ? { status: "rotated", character: "ada", compacted_turns: 2, retained_turns: 0, dry_run: false, memory_files_written: [] } : undefined);
  const live = app.state().workspace.getSnapshot();
  const elsewhere = {
    ...live, thread: "side",
    threads: [...live.threads, { id: "lamp", label: "By the lamp", created_at: "2026-11-02T00:00:00Z", compaction: true, home: false, current: false }, { id: "side", label: "Side", created_at: "2026-11-03T00:00:00Z", compaction: true, home: false, current: false }],
  };
  const view = await mount(<ConversationDialogs dialog="compact" state={elsewhere} close={() => {}} />);
  await click(button(view.host, "Compact"));
  await settle();
  expect(shown.mock.calls.map(([text]) => text)).toEqual(["“Side”: Archived 2 turns and kept the last 0."]);
});

test("adding a system message waits for some text, then sends it trimmed and closes", async () => {
  const { ConversationDialogs } = await import("../../src/browser/chat/dialogs.tsx");
  app.answer((asked) => asked["name"] === "inject_system" ? { injected: true } : undefined);
  let closed = 0;
  const view = await mount(<ConversationDialogs dialog="system" state={app.state().workspace.getSnapshot()} close={() => { closed += 1; }} />);
  const message = view.host.querySelector("textarea");
  expect([view.host.querySelector("h2")?.textContent, message?.getAttribute("rows"), button(view.host, "Add").disabled]).toEqual(["Add system message", "4", true]);
  await type(message, "   ");
  expect(button(view.host, "Add").disabled).toBe(true);
  await type(message, "  keep it brief  ");
  const before = app.socket().sent.length;
  await click(button(view.host, "Add"));
  await settle();
  expect(app.sent(before).filter((request) => request["name"] === "inject_system").map((request) => request["args"])).toEqual([{ text: "keep it brief" }]);
  expect(closed).toBe(1);
});
