import { describe, expect, test } from "bun:test";

import type { OperationInput } from "../src/operations/types.ts";
import type { AttemptMarks } from "../src/protocol/AttemptMarks.ts";
import { replyKey, ReplyMarkStore, shownAttempt, wholeMark, type MarkRun } from "../src/browser/chat/reply_marks.ts";

const AT = "2026-11-12T10:00:00.000Z";
const liked = { kind: "like" as const, phrase: null, reason: null, tags: [], at: AT };

function attempt(position: number, shown: boolean, marks: AttemptMarks["marks"] = []): AttemptMarks {
  return { position, shown, attempt: `at_${String(position)}`, asked: "first", marks };
}

interface Call { name: string; input: unknown }

function daemon(answer: (name: string, input: Record<string, unknown>) => unknown = () => undefined) {
  const calls: Call[] = [];
  const run = (async (name: string, input: Record<string, unknown>) => {
    calls.push({ name, input });
    const given = answer(name, input);
    if (given instanceof Error) throw given;
    if (given !== undefined) return given;
    if (name === "marks") {
      const refs = (input["refs"] ?? []) as string[];
      return { tags: ["too long"], replies: refs.filter((ref) => ref !== "m_gone").map((ref) => ({ ref, attempts: [attempt(1, true)] })) };
    }
    return { ref: String(input["ref"]), position: Number(input["position"]), attempt: "at_new", phrase: input["phrase"] ?? null, changed: true, marks: [{ ...liked, kind: input["kind"] ?? "like", phrase: input["phrase"] ?? null }] };
  }) as MarkRun;
  return { calls, run };
}

const settled = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); await Bun.sleep(0); };

describe("a reply's key", () => {
  test("is its message and which of how many attempts is shown, so a swipe asks again", () => {
    expect(replyKey({ msg_id: "m_1" })).toBe("m_1#0/1");
    expect(replyKey({ msg_id: "m_1", alt_index: 2, alt_count: 3 })).toBe("m_1#2/3");
  });

  test("names the shown attempt and its whole-reply mark", () => {
    const phrase = { ...liked, phrase: "sea" };
    expect(shownAttempt([attempt(1, false), attempt(2, true)])?.position).toBe(2);
    expect(shownAttempt(undefined)).toBeUndefined();
    expect(wholeMark(attempt(1, true, [phrase, liked]))).toBe(liked);
    expect(wholeMark(attempt(1, true, [phrase]))).toBeUndefined();
    expect(wholeMark(undefined)).toBeUndefined();
  });
});

describe("the marks a transcript shows", () => {
  test("are asked for once per reply, in one batch, and kept until the thread changes", async () => {
    const link = daemon();
    const store = new ReplyMarkStore(link.run);
    let heard = 0;
    store.subscribe(() => { heard += 1; });
    store.want("ada/story", [{ msg_id: "m_1" }, { msg_id: "m_2" }, { msg_id: "m_gone" }]);
    store.want("ada/story", [{ msg_id: "m_1" }]);
    await settled();
    expect(link.calls).toEqual([{ name: "marks", input: { refs: ["m_1", "m_2", "m_gone"] } }]);
    expect(store.attempts({ msg_id: "m_1" })).toEqual([attempt(1, true)]);
    expect(store.attempts({ msg_id: "m_gone" }), "a reply the daemon didn't list has none").toEqual([]);
    expect(store.tags()).toEqual(["too long"]);
    expect(heard).toBe(1);
    expect(store.getSnapshot()).toBe(1);

    store.want("ada/story", [{ msg_id: "m_1" }, { msg_id: "m_1", alt_index: 1, alt_count: 2 }]);
    await settled();
    expect(link.calls.at(-1)).toEqual({ name: "marks", input: { refs: ["m_1"] } });
    store.want("ada/story", []);
    await settled();
    expect(link.calls).toHaveLength(2);

    store.edit({ ref: "m_1", position: 1, phrase: null, place: "row" });
    store.want("ada/other", [{ msg_id: "m_1" }]);
    expect(store.editing(), "leaving the thread closes an open editor").toBeNull();
    expect(store.attempts({ msg_id: "m_1" })).toBeUndefined();
    await settled();
    expect(link.calls.at(-1)).toEqual({ name: "marks", input: { refs: ["m_1"] } });
  });

  test("come in batches of 64", async () => {
    const link = daemon();
    const store = new ReplyMarkStore(link.run);
    store.want("ada/story", Array.from({ length: 65 }, (_, i) => ({ msg_id: `m_${String(i)}` })));
    await settled();
    expect(link.calls.map((call) => ((call.input as { refs: string[] }).refs).length)).toEqual([64, 1]);
    expect(store.attempts({ msg_id: "m_64" })).toEqual([attempt(1, true)]);
  });

  test("that fail to load are left unloaded without asking again, and a thread opened meanwhile still loads", async () => {
    let failing = true;
    const link = daemon((name) => name === "marks" && failing ? new Error("daemon down") : undefined);
    const store = new ReplyMarkStore(link.run);
    store.want("ada/story", [{ msg_id: "m_1" }]);
    await settled();
    expect(store.attempts({ msg_id: "m_1" })).toBeUndefined();
    store.want("ada/story", [{ msg_id: "m_1" }]);
    await settled();
    expect(link.calls).toHaveLength(1);
    failing = false;

    const scheduled: (() => void)[] = [];
    const held = new ReplyMarkStore(link.run, (work) => { scheduled.push(work); });
    held.want("ada/story", [{ msg_id: "m_1" }]);
    held.want("ada/other", [{ msg_id: "m_2" }]);
    expect(scheduled).toHaveLength(1);
    while (scheduled.length > 0) {
      scheduled.shift()?.();
      await settled();
    }
    expect(link.calls.slice(1).map((call) => call.input)).toEqual([{ refs: ["m_2"] }]);
    expect(held.attempts({ msg_id: "m_2" })).toEqual([attempt(1, true)]);
  });

  test("an answer for a thread that is no longer open is dropped", async () => {
    let answer = (): void => {};
    const link = daemon();
    const slow = (async (name: string, input: never) => {
      await new Promise<void>((resolve) => { answer = resolve; });
      return await link.run(name as "marks", input);
    }) as MarkRun;
    const store = new ReplyMarkStore(slow);
    store.want("ada/story", [{ msg_id: "m_1" }]);
    await settled();
    store.want("ada/other", []);
    answer();
    await settled();
    expect(store.attempts({ msg_id: "m_1" })).toBeUndefined();
    expect(store.getSnapshot()).toBe(0);
  });
});

describe("marking from the browser", () => {
  test("sends what was chosen and keeps the attempt's marks as the daemon returned them", async () => {
    const link = daemon();
    const store = new ReplyMarkStore(link.run);
    store.want("ada/story", [{ msg_id: "m_1", alt_index: 1, alt_count: 2 }]);
    await settled();
    const changed = await store.mark("ada/story", { msg_id: "m_1", alt_index: 1, alt_count: 2 }, 1, { kind: "dislike", phrase: "sea", reason: "flat", tags: ["too long"] });
    expect(link.calls.at(-1)).toEqual({ name: "mark", input: { ref: "m_1", position: 1, kind: "dislike", phrase: "sea", reason: "flat", tags: ["too long"] } });
    expect(changed.phrase).toBe("sea");
    expect(store.attempts({ msg_id: "m_1", alt_index: 1, alt_count: 2 })?.[0]?.marks.map((mark) => [mark.kind, mark.phrase])).toEqual([["dislike", "sea"]]);
    await store.mark("ada/story", { msg_id: "m_1", alt_index: 1, alt_count: 2 }, 1, { kind: "like" });
    expect(link.calls.at(-1)).toEqual({ name: "mark", input: { ref: "m_1", position: 1, kind: "like" } });

    await store.mark("ada/story", { msg_id: "m_unseen" }, 2, { kind: "like" });
    expect(store.attempts({ msg_id: "m_unseen" })).toEqual([{ position: 2, shown: true, attempt: "at_new", asked: null, marks: [liked] }]);
    await store.mark("ada/elsewhere", { msg_id: "m_other" }, 1, { kind: "like" });
    expect(store.attempts({ msg_id: "m_other" }), "a mark made for another thread isn't kept here").toBeUndefined();
  });

  test("removing a mark closes its editor and no other", async () => {
    const link = daemon((name) => name === "unmark" ? { ref: "m_1", position: 1, attempt: "at_1", phrase: null, changed: true, marks: [] } : undefined);
    const store = new ReplyMarkStore(link.run);
    store.want("ada/story", [{ msg_id: "m_1" }]);
    await settled();
    for (const open of [{ ref: "m_2", position: 1 }, { ref: "m_1", position: 2 }, { ref: "m_1", position: 1, phrase: "sea" }]) {
      store.edit({ phrase: null, place: "row", ...open });
      await store.unmark("ada/story", { msg_id: "m_1" }, 1, null);
      expect(store.editing(), JSON.stringify(open)).not.toBeNull();
    }
    store.edit({ ref: "m_1", position: 1, phrase: "sea", place: "dialog" });
    await store.unmark("ada/story", { msg_id: "m_1" }, 1, "sea");
    expect(link.calls.at(-1)).toEqual({ name: "unmark", input: { ref: "m_1", position: 1, phrase: "sea" } });
    expect(store.editing()).toBeNull();
    expect(store.attempts({ msg_id: "m_1" })?.[0]?.marks).toEqual([]);
  });

  test("the configured tags are asked for once when nothing has loaded them yet", async () => {
    const link = daemon((name) => name === "marks" ? { tags: ["cold"], replies: [] } : undefined);
    const store = new ReplyMarkStore(link.run);
    expect(await store.loadTags()).toEqual(["cold"]);
    expect(await store.loadTags()).toEqual(["cold"]);
    expect(link.calls).toEqual([{ name: "marks", input: {} satisfies OperationInput<"marks"> }]);
    expect(store.getSnapshot()).toBe(1);
  });
});
