import { expect, spyOn, test } from "bun:test";

import { useApp } from "./app.ts";
import { button, click, mount, type } from "./dom.ts";

const app = useApp();
const settle = async () => { await Bun.sleep(10); };

test("clearing the context says how many turns went into the segment, once the thread is back in step", async () => {
  const { ConversationDialogs } = await import("../../src/browser/chat/dialogs.tsx");
  const { toasts } = await import("../../src/browser/ui/toast.tsx");
  const shown = spyOn(toasts, "show");
  app.restores.push(() => { shown.mockRestore(); });
  const segment = { index: 4, first_message_at: null, last_message_at: null, compacted_at: "2026-11-12T00:00:00Z", turn_count: 3, excluded: true, label: null, note: "before the trip", memory_before: null, memory_after: null };
  app.answer((asked) => {
    if (asked["name"] === "clear") return { status: "clear", character: "ada", thread: "story", segment };
    if (asked["name"] === "switch_thread") return { character: "ada", thread: "story", changed: false };
    return undefined;
  });
  let closed = 0;
  const view = await mount(<ConversationDialogs dialog="clear" state={app.state().workspace.getSnapshot()} close={() => { closed += 1; }} />);
  await type(view.host.querySelector("input.input"), "before the trip");
  await click(view.host.querySelector("input[type='checkbox']"));
  const before = app.socket().sent.length;
  await click(button(view.host, "Clear"));
  await settle();
  const asked = app.sent(before).filter((request) => request["type"] === "command").map((request) => [request["name"], request["args"]]);
  expect(asked).toEqual([["clear", { note: "before the trip", exclude: true }], ["list_threads", {}], ["switch_thread", { name: "story", resync: true }]]);
  expect(shown.mock.calls.map(([text]) => text)).toEqual(["Cleared 3 turns from the active context"]);
  expect(closed).toBe(1);
});
