import { expect, test } from "bun:test";

import type { ChromeSnapshot } from "../../src/browser/workspace.ts";
import type { ThreadContextUse } from "../../src/protocol/ThreadContextUse.ts";
import type { ThreadView } from "../../src/protocol/ThreadView.ts";
import { useApp } from "./app.ts";
import { acting, click, mount } from "./dom.ts";

const app = useApp();
const settle = async () => { await acting(() => Bun.sleep(5)); };

const USE: ThreadContextUse = { thread: "story", mode: "compaction", turns: 12, min_turns: 4, max_turns: 40, context_tokens: 81_400, max_context_tokens: 150_000, message_tokens: 52_300, trim_at: 108_000 };
const HOME: ThreadView = { id: "story", created_at: "2026-11-01T00:00:00Z", compaction: true, home: true, current: true };

async function chrome(over: Partial<ChromeSnapshot> = {}): Promise<ChromeSnapshot> {
  const { chromeOf } = await import("../../src/browser/chrome.ts");
  return { ...chromeOf(undefined, app.state().workspace.getSnapshot()), status: "ready", character: "ada", thread: "story", threads: [HOME], ...over };
}

test("token counts read as they are under a thousand and in thousands above", async () => {
  const { shortTokens } = await import("../../src/browser/chat/context_use.tsx");
  expect([0, 999, 1000, 1499, 1500, 81_400].map(shortTokens)).toEqual(["0", "999", "1k", "1k", "2k", "81k"]);
});

test("a compacting thread lists each limit it has, how full each is, and when they act", async () => {
  const { contextLimits, contextPercent, contextRule } = await import("../../src/browser/chat/context_use.tsx");
  expect([contextLimits(USE), contextPercent(USE), contextRule(USE)]).toEqual([[
    { name: "Turns", value: "12 of 40", fraction: 0.3 },
    { name: "Everything sent last time", value: "81k of 150k tokens", fraction: 81_400 / 150_000 },
    { name: "Messages", value: "52k of 108k tokens", fraction: 52_300 / 108_000 },
  ], 54, "Older turns are archived after the reply that reaches any of these. Not before 4 turns, unless the messages fill up."]);

  const { context_tokens: _unknown, ...unseen } = USE;
  expect([contextLimits(unseen)[1], contextPercent(unseen)]).toEqual([{ name: "Everything sent last time", value: "? of 150k tokens", fraction: undefined }, 48]);
  expect(contextLimits({ ...USE, max_turns: 0, max_context_tokens: 0 }).map((limit) => limit.name)).toEqual(["Messages"]);
  expect([contextRule({ ...USE, min_turns: 2 }), contextRule({ ...USE, min_turns: 1 })]).toEqual([
    "Older turns are archived after the reply that reaches any of these. Not before 2 turns, unless the messages fill up.",
    "Older turns are archived after the reply that reaches any of these.",
  ]);
});

test("the fullest limit counts in whole percents that stop at a hundred", async () => {
  const { contextPercent } = await import("../../src/browser/chat/context_use.tsx");
  expect([
    contextPercent({ ...USE, turns: 12, max_turns: 1 }),
    contextPercent({ ...USE, mode: "trim", message_tokens: 99_900, trim_at: 100_000 }),
    contextPercent({ ...USE, mode: "trim", message_tokens: 150, trim_at: 773_000 }),
  ]).toEqual([100, 99, 0]);
});

test("a thread that doesn't compact counts only its messages, and with compaction off there is nothing to count", async () => {
  const { contextLimits, contextPercent, contextRule } = await import("../../src/browser/chat/context_use.tsx");
  const trim = { ...USE, mode: "trim" as const };
  expect([contextLimits(trim), contextPercent(trim), contextRule(trim)]).toEqual([[{ name: "Messages", value: "52k of 108k tokens", fraction: 52_300 / 108_000 }], 48, "Older turns are archived only when the messages fill up."]);
  const off = { ...USE, mode: "off" as const };
  expect([contextLimits(off), contextPercent(off), contextRule(off)]).toEqual([[], undefined, "Compaction is off in the configuration, so older turns are never archived on their own."]);
});

test("the chip shows how full the open thread's context is and opens the details, asks again when the thread, its last message or the connection changes and after a reply, and hides another thread's answer", async () => {
  const { ContextChip } = await import("../../src/browser/chat/context_use.tsx");
  const { conversation } = app.state();
  let answering: ThreadContextUse = USE;
  app.answer((request) => request["name"] === "context_use" ? answering : undefined);
  let opened = 0;
  const open = () => { opened += 1; };
  const asked = (since: number) => app.sent(since).filter((request) => request["name"] === "context_use").length;
  let since = app.socket().sent.length;
  const view = await mount(<ContextChip state={await chrome()} open={open} />);
  await settle();
  const chip = () => view.host.querySelector<HTMLButtonElement>("button");
  const shown = () => [chip()?.textContent, chip()?.title, chip()?.querySelector<HTMLElement>(".budget-chip-bar span")?.style.width];
  expect([asked(since), ...shown()]).toEqual([1, "Context 54%", "54% of the way to archiving older turns", "54%"]);
  await click(chip());
  expect(opened).toBe(1);

  since = app.socket().sent.length;
  await view.update(<ContextChip state={await chrome({ threads: [{ ...HOME, last_active: "2026-11-27T10:00:00Z" }] })} open={open} />);
  await settle();
  await view.update(<ContextChip state={await chrome({ status: "reconnecting", threads: [{ ...HOME, last_active: "2026-11-27T10:00:00Z" }] })} open={open} />);
  await settle();
  expect(asked(since), "a new message asks again, and nothing is asked while away").toBe(1);

  answering = { ...USE, thread: "side", turns: 36 };
  since = app.socket().sent.length;
  await view.update(<ContextChip state={await chrome({ thread: "side" })} open={open} />);
  await settle();
  expect([asked(since), chip()?.textContent]).toEqual([1, "Context 90%"]);
  await view.update(<ContextChip state={await chrome()} open={open} />);
  expect(chip(), "the side thread's answer isn't shown for story").toBeNull();
  await settle();

  answering = { ...USE, turns: 32 };
  since = app.socket().sent.length;
  await acting(() => { void conversation.submit("message", { text: "hello", stream: true, images: [] }).catch(() => undefined); });
  await settle();
  expect(asked(since), "nothing is asked while a reply runs").toBe(0);
  const message = app.sent(since).find((request) => request["type"] === "message");
  await acting(() => { app.socket().receive({ type: "request_finished", rid: message?.["rid"], outcome: "completed" }); });
  await settle();
  expect([asked(since), chip()?.textContent]).toEqual([1, "Context 80%"]);

  answering = { ...USE, mode: "off" };
  await view.update(<ContextChip state={await chrome({ threads: [{ ...HOME, last_active: "2026-11-28T10:00:00Z" }] })} open={open} />);
  await settle();
  expect(chip(), "with compaction off there is no chip").toBeNull();
});

test("the details list each limit with its bar, leave the bar empty for a count not known yet, and say only the rule when compaction is off", async () => {
  const { ContextLimits } = await import("../../src/browser/chat/context_use.tsx");
  const { context_tokens: _unknown, ...unseen } = USE;
  let answering: ThreadContextUse = unseen;
  app.answer((request) => request["name"] === "context_use" ? answering : undefined);
  const view = await mount(<ContextLimits state={await chrome()} />);
  await settle();
  const rows = () => [...view.host.querySelectorAll(".context-limit")].map((row) => [row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent, row.querySelector<HTMLElement>(".budget-chip-bar span")?.style.width]);
  expect([view.host.querySelector("p")?.textContent, rows()]).toEqual(["Older turns are archived after the reply that reaches any of these. Not before 4 turns, unless the messages fill up.", [
    ["Turns", "12 of 40", "30%"],
    ["Everything sent last time", "? of 150k tokens", "0%"],
    ["Messages", "52k of 108k tokens", "48%"],
  ]]);

  answering = { ...USE, mode: "off" };
  await view.update(<ContextLimits state={await chrome({ threads: [{ ...HOME, last_active: "2026-11-28T10:00:00Z" }] })} />);
  await settle();
  expect([view.host.querySelector("p")?.textContent, view.host.querySelector("dl")]).toEqual(["Compaction is off in the configuration, so older turns are never archived on their own.", null]);
});
