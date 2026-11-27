import { expect, test } from "bun:test";

import type { ThreadView } from "../src/protocol/ThreadView.ts";

type Recent = typeof import("../src/browser/app/recent.ts");
let copies = 0;
async function fresh(): Promise<Recent> {
  copies += 1;
  return await import(`../src/browser/app/recent.ts?copy=${String(copies)}`) as Recent;
}

const thread = (id: string, overrides: Partial<ThreadView> = {}): ThreadView => ({ id, created_at: "2026-11-01T00:00:00Z", compaction: true, home: false, current: false, ...overrides });

test("the visit before this one is the last other thread opened, on any character, and staying put changes nothing", async () => {
  const { noteVisit, previousVisit } = await fresh();
  expect(previousVisit("ada", "main")).toBeUndefined();
  noteVisit("ada", "main");
  expect(previousVisit("ada", "main"), "the open thread is no visit before itself").toBeUndefined();
  expect(previousVisit("ada", "side")).toEqual({ character: "ada", thread: "main" });
  expect(previousVisit("bo", "main")).toEqual({ character: "ada", thread: "main" });
  noteVisit("ada", "side");
  expect(previousVisit("ada", "side")).toEqual({ character: "ada", thread: "main" });
  noteVisit("ada", "side");
  expect(previousVisit("ada", "side"), "seeing the same thread again is no new visit").toEqual({ character: "ada", thread: "main" });
  noteVisit("bo", "side");
  expect([previousVisit("bo", "side"), previousVisit("ada", "elsewhere"), previousVisit(null, null)]).toEqual([
    { character: "ada", thread: "side" }, { character: "bo", thread: "side" }, { character: "bo", thread: "side" },
  ]);
});

test("the switcher's threads are the visit before first, then newest first with archived ones last, never the open one", async () => {
  const { switcherThreads } = await fresh();
  const threads = [
    thread("shelved", { archived: "2026-11-10T00:00:00Z", last_active: "2026-11-19T00:00:00Z" }),
    thread("open", { last_active: "2026-11-20T00:00:00Z" }),
    thread("old", { last_active: "2026-11-02T00:00:00Z" }),
    thread("new", { last_active: "2026-11-09T00:00:00Z" }),
    thread("never"),
    thread("dusty", { archived: "2026-11-10T00:00:00Z", last_active: "2026-11-01T12:00:00Z" }),
  ];
  const ids = (from: readonly ThreadView[]) => from.map((each) => each.id);
  expect(ids(switcherThreads(threads, "open", undefined))).toEqual(["new", "old", "never", "shelved", "dusty"]);
  expect(ids(switcherThreads([...threads].reverse(), "open", undefined))).toEqual(["new", "old", "never", "shelved", "dusty"]);
  expect(ids(switcherThreads(threads, "open", "old"))).toEqual(["old", "new", "never", "shelved", "dusty"]);
  expect(ids(switcherThreads(threads, "open", "dusty"))).toEqual(["dusty", "new", "old", "never", "shelved"]);
  expect(ids(switcherThreads(threads, "open", "gone"))).toEqual(["new", "old", "never", "shelved", "dusty"]);
  expect(ids(switcherThreads(threads, null, "open"))[0]).toBe("open");
});
