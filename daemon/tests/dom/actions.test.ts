import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";

import type { Message } from "../../src/protocol/Message.ts";
import { catalogue, connect, LISTING, type FakeSocket } from "./daemon.ts";
import { useDom } from "./dom.ts";

useDom("http://shore.test:7340/workspace/ada/story");

const lasting: (() => void)[] = [];
let socket: FakeSocket;
let answer: (request: Record<string, unknown>) => unknown = catalogue;

beforeAll(async () => {
  Object.assign(globalThis, { SHORE_WEB_CONTRACT: "c1", SHORE_WEB_PROTOCOL: 2 });
  const state = await import("../../src/browser/app/state.ts");
  socket = await connect(state.workspace.connection, lasting, (request) => answer(request));
});

afterAll(async () => {
  const state = await import("../../src/browser/app/state.ts");
  state.workspace.connection.stop();
  for (const restore of lasting.splice(0).reverse()) restore();
  for (const key of ["SHORE_WEB_CONTRACT", "SHORE_WEB_PROTOCOL"]) Reflect.deleteProperty(globalThis, key);
});

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  answer = catalogue;
  localStorage.clear();
});

async function load() {
  const [state, actions, { toasts }] = await Promise.all([import("../../src/browser/app/state.ts"), import("../../src/browser/chat/actions.ts"), import("../../src/browser/ui/toast.tsx")]);
  const shown = spyOn(toasts, "show");
  restores.push(() => { shown.mockRestore(); });
  return { state, actions, toasts: () => shown.mock.calls.map(([text, tone]) => [text, tone ?? "info"]) };
}

const message = (alt: number, count: number): Message => ({ msg_id: "m_1", role: "assistant", content: "x", images: [], content_blocks: [], timestamp: "2026-11-10T00:00:00Z", alt_index: alt, alt_count: count });
const sentSince = (before: number) => socket.sent.slice(before);
const choice = { ref: "m_1", alt_index: 1, position: 2, alt_count: 2, content: "y" };

describe("swiping between a reply's versions", () => {
  test("moves to the version asked for and says what happened to the workspace", async () => {
    const { actions, toasts } = await load();
    answer = (request) => request["name"] === "alt" ? { ...choice, workspace: { restored: ["notes.md"], skipped: [] } } : catalogue(request);
    const before = socket.sent.length;
    await actions.swipe(message(0, 2), "next", true);
    expect(sentSince(before)).toMatchObject([{ type: "command", name: "alt", args: { ref: "m_1", direction: "next" } }]);
    expect(toasts()).toEqual([["Restored 1 workspace file", "info"]]);
    answer = (request) => request["name"] === "alt" ? choice : catalogue(request);
    await actions.swipe(message(1, 2), "prev", false);
    expect(sentSince(before).at(-1)).toMatchObject({ name: "alt", args: { direction: "prev" } });
    expect(toasts()).toHaveLength(1);
  });

  test("goes nowhere before the first version or past the last of an older reply", async () => {
    const { actions } = await load();
    const before = socket.sent.length;
    await actions.swipe(message(0, 2), "prev", true);
    await actions.swipe(message(1, 2), "next", false);
    expect(sentSince(before)).toEqual([]);
  });

  test("past the last version of the newest reply asks for a new one, streamed unless streaming is off", async () => {
    const { actions, state } = await load();
    for (const [stored, stream] of [[null, true], ["false", false]] as const) {
      if (stored !== null) localStorage.setItem(state.STREAM_KEY, stored);
      const before = socket.sent.length;
      const swiping = actions.swipe(message(1, 2), "next", true);
      await Bun.sleep(1);
      const regen = sentSince(before).find((request) => request["type"] === "regen");
      expect(regen).toMatchObject({ type: "regen", stream });
      socket.receive({ type: "request_finished", rid: regen?.["rid"], outcome: "completed" });
      await swiping;
    }
  });

  test("a note about the workspace shows only when there is one", async () => {
    const { actions, toasts } = await load();
    actions.showWorkspaceNote(undefined);
    actions.showWorkspaceNote({ restored: [], skipped: [] });
    expect(toasts()).toEqual([]);
    actions.showWorkspaceNote({ restored: [], skipped: [], kept: "later_turns" });
    expect(toasts()).toEqual([["Workspace files kept: later turns build on this one", "info"]]);
  });
});

describe("thread actions", () => {
  const story = { id: "story", label: "The story", created_at: "2026-11-01T00:00:00Z", compaction: true, home: true, current: true, unread: 2 };
  const side = { id: "side", created_at: "2026-11-01T00:00:00Z", compaction: true, home: false, current: false, unread: 3 };
  const threads = [story, side];

  test("making a thread home shows it at once, asks the daemon, relists, and says so by its label or id", async () => {
    const { actions, state, toasts } = await load();
    state.workspace.noteThreads(threads);
    const relisted = { ...LISTING, threads: threads.map((thread) => ({ ...thread, home: thread.id === "side" })), home: "side" };
    answer = (request) => request["name"] === "thread_home" ? relisted : request["name"] === "list_threads" ? relisted : catalogue(request);
    const before = socket.sent.length;
    const making = actions.makeHome(side);
    expect(state.workspace.getSnapshot().threads.map((thread) => thread.home)).toEqual([false, true]);
    await making;
    expect(sentSince(before).map((request) => request["name"])).toEqual(["thread_home", "list_threads"]);
    expect(sentSince(before)[0]).toMatchObject({ args: { name: "side" } });
    await actions.makeHome(story);
    expect(toasts()).toEqual([["“side” is now the home thread", "info"], ["“The story” is now the home thread", "info"]]);
  });

  test("a thread that cannot be made home is relisted and the reason shown", async () => {
    const { actions, toasts } = await load();
    answer = (request) => { if (request["name"] === "thread_home") throw new Error("no such thread"); return catalogue(request); };
    const before = socket.sent.length;
    await actions.makeHome({ id: "gone" });
    expect(sentSince(before).map((request) => request["name"])).toEqual(["thread_home", "list_threads"]);
    expect(toasts()).toEqual([["no such thread", "error"]]);
  });

  test("marking a thread read clears its count at once, and relists with the reason when it fails", async () => {
    const { actions, state, toasts } = await load();
    state.workspace.noteThreads(threads);
    answer = (request) => request["name"] === "mark_thread_read" ? { character: "ada", thread: "side", unread: 0 } : catalogue(request);
    const before = socket.sent.length;
    const marking = actions.markRead({ id: "side" });
    expect(state.workspace.getSnapshot().threads.map((thread) => thread.unread)).toEqual([2, 0]);
    await marking;
    expect(sentSince(before)).toMatchObject([{ name: "mark_thread_read", args: { name: "side" } }]);
    expect(toasts()).toEqual([]);
    answer = (request) => { if (request["name"] === "mark_thread_read") throw new Error("read failed"); return catalogue(request); };
    const failed = socket.sent.length;
    await actions.markRead({ id: "side" });
    expect(sentSince(failed).map((request) => request["name"])).toEqual(["mark_thread_read", "list_threads"]);
    expect(toasts()).toEqual([["read failed", "error"]]);
  });

  test("moving a thread shows the move at once and then the daemon's listing, or relists with the reason", async () => {
    const { actions, state, toasts } = await load();
    state.workspace.applyThreadListing({ ...LISTING, threads, folders: [{ name: "work" }] });
    const moved = { ...LISTING, threads: [{ ...side, folder: "work" }, story], folders: [{ name: "work" }], manual_order: true };
    answer = (request) => request["name"] === "thread_move" ? moved : catalogue(request);
    const before = socket.sent.length;
    const moving = actions.moveThreadTo("side", { folder: "work" });
    expect(state.workspace.getSnapshot().threads.find((thread) => thread.id === "side")?.folder).toBe("work");
    await moving;
    expect(sentSince(before)).toMatchObject([{ name: "thread_move", args: { name: "side", folder: "work" } }]);
    expect(state.workspace.getSnapshot()).toMatchObject({ manualOrder: true, threads: moved.threads });
    answer = (request) => { if (request["name"] === "thread_move") throw new Error("move failed"); return catalogue(request); };
    const failed = socket.sent.length;
    await actions.moveThreadTo("story", { before: "side" });
    expect(sentSince(failed).map((request) => request["name"])).toEqual(["thread_move", "list_threads"]);
    expect(sentSince(failed)[0]).toMatchObject({ args: { name: "story", before: "side" } });
    expect(toasts()).toEqual([["move failed", "error"]]);
  });
});
