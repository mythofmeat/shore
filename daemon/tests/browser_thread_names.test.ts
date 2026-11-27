import { expect, test } from "bun:test";
import { namedThread, threadIdFor } from "../src/browser/sidebar/thread_names.ts";
import { isValidThreadId } from "../src/engine/threads.ts";

test("a thread's id is made from its name, and the name is kept as its label when the two differ", () => {
  expect([
    namedThread("My new thread", []),
    namedThread("lighthouse", []),
    namedThread(" Lighthouse ", []),
    namedThread("  Café  talk! ", []),
    namedThread("v1.2 notes", []),
    namedThread("_drafts", []),
    namedThread("notes...", []),
  ]).toEqual([
    { id: "my-new-thread", label: "My new thread" },
    { id: "lighthouse" },
    { id: "lighthouse", label: "Lighthouse" },
    { id: "cafe-talk", label: "Café  talk!" },
    { id: "v1.2-notes", label: "v1.2 notes" },
    { id: "drafts", label: "_drafts" },
    { id: "notes", label: "notes..." },
  ]);
});

test("a name with nothing an id can keep becomes thread", () => {
  expect([threadIdFor("灯台", []), threadIdFor("...", []), threadIdFor("", [])]).toEqual(["thread", "thread", "thread"]);
});

test("an id already taken gets the next free number, and every id fits in 64 characters", () => {
  expect([threadIdFor("Notes", ["notes"]), threadIdFor("Notes", ["notes", "notes-2"]), threadIdFor("灯台", ["thread"])]).toEqual(["notes-2", "notes-3", "thread-2"]);
  const long = "a".repeat(70);
  expect(threadIdFor(long, [])).toBe("a".repeat(64));
  const numbered = threadIdFor(long, ["a".repeat(64)]);
  expect(numbered).toBe(`${"a".repeat(62)}-2`);
  expect([threadIdFor(`${"b".repeat(63)} c`, []), threadIdFor(`${"b".repeat(63)}-c`, [])]).toEqual(["b".repeat(63), "b".repeat(63)]);
  for (const id of [numbered, threadIdFor("My new thread", []), threadIdFor("  Café  talk! ", []), threadIdFor("_drafts", [])]) expect(isValidThreadId(id), id).toBe(true);
});
