import { expect, test } from "bun:test";

import { listThreads, type ThreadRegistry } from "../src/commands/threads.ts";
import type { ThreadRecord, ThreadsIndex } from "../src/engine/threads.ts";

const record = (id: string): ThreadRecord => ({ id, created_at: "2026-11-24T00:00:00Z", compaction: id === "story" });
const RECORDS = [record("story"), record("side"), record("notes")];

function registry(index?: Partial<ThreadsIndex>): ThreadRegistry {
  const known: ThreadsIndex | undefined = index === undefined ? undefined : { version: 1, home: "story", threads: RECORDS, ...index };
  return {
    listThreads: () => RECORDS,
    homeThread: () => "side",
    ...(known === undefined ? {} : { threads: () => known }),
  } as unknown as ThreadRegistry;
}

const listed = (from: ThreadRegistry, current = "notes"): ReturnType<typeof listThreads> => listThreads({ registry: from, character: "ada", current });
const shape = (listing: ReturnType<typeof listThreads>) => ({ ...listing, threads: listing.threads.map((thread) => [thread.id, thread.home, thread.current, thread.folder ?? null]) });

test("without a saved thread index the registry names home, and the threads come in its order with no folders", () => {
  expect(shape(listed(registry()))).toEqual({
    character: "ada", home: "side", current: "notes",
    threads: [["story", false, false, null], ["side", true, false, null], ["notes", false, true, null]],
  });
});

test("with a saved index its home is home, and its folders and manual order come with the threads", () => {
  const index = { order: ["notes", "side"], folders: [{ name: "Drafts", threads: ["side"] }, { name: "Busy", threads: [], by_activity: true as const }] };
  expect(shape(listed(registry(index)))).toEqual({
    character: "ada", home: "story", current: "notes",
    threads: [["story", true, false, null], ["notes", false, true, null], ["side", false, false, "Drafts"]],
    folders: [{ name: "Drafts" }, { name: "Busy", by_activity: true }],
    manual_order: true,
  });
});

test("an index with no folders and no order lists neither", () => {
  expect(Object.keys(listed(registry({ folders: [] })))).toEqual(["character", "threads", "home", "current"]);
  expect(listed(registry({ folders: [{ name: "Drafts", threads: ["side"] }] })).folders).toEqual([{ name: "Drafts" }]);
});

test("each thread carries its activity: turns and unread wherever activity was read, a thread missing from it at none, its last message and later mark when it has them, and the warm thread says so", () => {
  const activity = new Map([
    ["story", { turns: 3, user_turns: 2, unread: 1, last_active: "2026-11-25T00:00:00Z", later: "2026-11-26T00:00:00Z" }],
    ["side", { turns: 0, user_turns: 0, unread: 0 }],
  ]);
  const listing = listThreads({ registry: registry({}), character: "ada", current: "story", activity, warm: "side" });
  expect(listing.threads.map(({ id, turns, unread, last_active, later, warm }) => ({ id, turns, unread, last_active, later, warm }))).toEqual([
    { id: "story", turns: 3, unread: 1, last_active: "2026-11-25T00:00:00Z", later: "2026-11-26T00:00:00Z", warm: undefined },
    { id: "side", turns: 0, unread: 0, last_active: undefined, later: undefined, warm: true },
    { id: "notes", turns: 0, unread: 0, last_active: undefined, later: undefined, warm: undefined },
  ]);
  expect(Object.keys(listing.threads[1] ?? {})).not.toContain("last_active");
  expect(listed(registry({})).threads.map((thread) => [thread.turns, thread.unread]), "without activity there are no counts").toEqual([[undefined, undefined], [undefined, undefined], [undefined, undefined]]);
});

test("threads placed by hand carry their place, and threads sorted by activity carry none", () => {
  expect(listed(registry({ order: ["notes", "side"] })).threads.map((thread) => [thread.id, thread.position])).toEqual([["story", undefined], ["notes", 0], ["side", 1]]);
  expect(listed(registry({})).threads.map((thread) => Object.keys(thread).includes("position"))).toEqual([false, false, false]);
});

test("a current thread that no longer exists is shown as home", () => {
  expect(listed(registry({}), "gone").current).toBe("story");
  expect(listed(registry(), "gone").current).toBe("side");
});
