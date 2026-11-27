import { expect, test } from "bun:test";

import type { ChromeSnapshot } from "../../src/browser/workspace.ts";
import type { ThreadContextUse } from "../../src/protocol/ThreadContextUse.ts";
import type { ThreadView } from "../../src/protocol/ThreadView.ts";
import { useApp } from "./app.ts";
import { acting, mount } from "./dom.ts";

const app = useApp();
const settle = async () => { await acting(() => Bun.sleep(5)); };

const USE: ThreadContextUse = { thread: "story", mode: "compaction", turns: 12, min_turns: 4, max_turns: 40, context_tokens: 81_400, max_context_tokens: 150_000, message_tokens: 52_300, trim_at: 108_000 };

test("token counts read as they are under a thousand and in thousands above", async () => {
  const { shortTokens } = await import("../../src/browser/chat/context_use.tsx");
  expect([0, 999, 1000, 1499, 1500, 81_400].map(shortTokens)).toEqual(["0", "999", "1k", "1k", "2k", "81k"]);
});

test("the line names each limit that applies to the thread, and its tooltip says when each one acts", async () => {
  const { contextLine } = await import("../../src/browser/chat/context_use.tsx");
  expect(contextLine(USE)).toEqual({
    text: "Next compaction: 12 of 40 turns · 81k of 150k tokens · 52k of 108k tokens of messages",
    title: "Compacts after a reply once it reaches 40 turns (12 now), or a request's whole input reaches 150000 tokens (81400 last time), or its messages reach 108000 tokens (52300 now), and not before 4 turns.",
  });
  const { context_tokens: _unknown, ...unseen } = USE;
  expect(contextLine(unseen)).toEqual({
    text: "Next compaction: 12 of 40 turns · ? of 150k tokens · 52k of 108k tokens of messages",
    title: "Compacts after a reply once it reaches 40 turns (12 now), or a request's whole input reaches 150000 tokens (not known until the next reply), or its messages reach 108000 tokens (52300 now), and not before 4 turns.",
  });
  expect(contextLine({ ...USE, max_turns: 0, max_context_tokens: 0 })).toEqual({
    text: "Next compaction: 52k of 108k tokens of messages",
    title: "Compacts after a reply once its messages reach 108000 tokens (52300 now), and not before 4 turns.",
  });
  expect(contextLine({ ...USE, max_turns: 1, max_context_tokens: 1 }).text).toBe("Next compaction: 12 of 1 turns · 81k of 1 tokens · 52k of 108k tokens of messages");
  expect(contextLine({ ...USE, max_turns: 1, max_context_tokens: 1 }).title).toBe("Compacts after a reply once it reaches 1 turns (12 now), or a request's whole input reaches 1 tokens (81400 last time), or its messages reach 108000 tokens (52300 now), and not before 4 turns.");
  expect(contextLine({ ...USE, mode: "trim" })).toEqual({ text: "Next trim: 52k of 108k tokens of messages", title: "Older turns are archived once the messages reach 108000 tokens; they are 52300 now." });
  expect(contextLine({ ...USE, mode: "off" })).toEqual({ text: "Compaction is off", title: "Compaction is off in the configuration, so this thread is never compacted." });
});

test("the line shows the open thread's use, asks again when the thread, its last message or the connection changes and after a reply, and hides another thread's answer", async () => {
  const { ContextUse } = await import("../../src/browser/chat/context_use.tsx");
  const { chromeOf } = await import("../../src/browser/chrome.ts");
  const { conversation } = app.state();
  let answering: ThreadContextUse = USE;
  app.answer((request) => request["name"] === "context_use" ? answering : undefined);
  const HOME: ThreadView = { id: "story", created_at: "2026-11-01T00:00:00Z", compaction: true, home: true, current: true };
  const chrome = (over: Partial<ChromeSnapshot> = {}): ChromeSnapshot => ({ ...chromeOf(undefined, app.state().workspace.getSnapshot()), status: "ready", character: "ada", thread: "story", threads: [HOME], ...over });
  const asked = (since: number) => app.sent(since).filter((request) => request["name"] === "context_use").length;
  let since = app.socket().sent.length;
  const view = await mount(<ContextUse state={chrome()} />);
  await settle();
  const line = () => view.host.querySelector(".context-use");
  expect([asked(since), line()?.textContent, line()?.getAttribute("title")?.startsWith("Compacts after a reply")]).toEqual([1, "Next compaction: 12 of 40 turns · 81k of 150k tokens · 52k of 108k tokens of messages", true]);

  since = app.socket().sent.length;
  await view.update(<ContextUse state={chrome({ threads: [{ ...HOME, last_active: "2026-11-27T10:00:00Z" }] })} />);
  await settle();
  await view.update(<ContextUse state={chrome({ status: "reconnecting", threads: [{ ...HOME, last_active: "2026-11-27T10:00:00Z" }] })} />);
  await settle();
  expect(asked(since), "a new message asks again, and nothing is asked while away").toBe(1);

  answering = { ...USE, thread: "side" };
  since = app.socket().sent.length;
  await view.update(<ContextUse state={chrome({ thread: "side", threads: [HOME] })} />);
  await settle();
  expect([asked(since), line()?.textContent]).toEqual([1, "Next compaction: 12 of 40 turns · 81k of 150k tokens · 52k of 108k tokens of messages"]);
  await view.update(<ContextUse state={chrome({ thread: "story", threads: [HOME] })} />);
  expect(line(), "the side thread's answer isn't shown for story").toBeNull();
  await settle();

  answering = { ...USE, turns: 13 };
  since = app.socket().sent.length;
  await acting(() => { void conversation.submit("message", { text: "hello", stream: true, images: [] }).catch(() => undefined); });
  await settle();
  expect(asked(since), "nothing is asked while a reply runs").toBe(0);
  const message = app.sent(since).find((request) => request["type"] === "message");
  await acting(() => { app.socket().receive({ type: "request_finished", rid: message?.["rid"], outcome: "completed" }); });
  await settle();
  expect([asked(since), line()?.textContent]).toEqual([1, "Next compaction: 13 of 40 turns · 81k of 150k tokens · 52k of 108k tokens of messages"]);
});
