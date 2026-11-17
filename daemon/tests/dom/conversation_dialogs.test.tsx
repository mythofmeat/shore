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
