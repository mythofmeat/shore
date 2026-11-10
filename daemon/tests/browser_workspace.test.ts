import { describe, expect, test } from "bun:test";

import type { BrowserConnection, BrowserRequest, ConnectionStatus, ConnectionUpdate } from "../src/browser/connection.ts";
import { SEGMENT_PAGE_TURNS, Workspace, applyThreadUnread, inspectableRequest, mergeHistory, touchThread } from "../src/browser/workspace.ts";
import type { History } from "../src/protocol/History.ts";
import type { Message } from "../src/protocol/Message.ts";
import type { OperationDescriptor } from "../src/protocol/OperationDescriptor.ts";
import type { RequestFinished } from "../src/protocol/RequestFinished.ts";
import type { SegmentSummary } from "../src/protocol/SegmentSummary.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import type { ThreadListing } from "../src/protocol/ThreadListing.ts";
import type { ThreadView } from "../src/protocol/ThreadView.ts";

const message = (id: string, extra: Partial<Message> = {}): Message => ({ msg_id: id, role: "assistant", content: id, images: [], content_blocks: [], timestamp: "2026-11-10T00:00:00Z", ...extra });
const thread = (id: string, extra: Partial<ThreadView> = {}): ThreadView => ({ id, created_at: "2026-11-01T00:00:00Z", compaction: true, home: id === "main", current: id === "main", ...extra });
const segment = (index: number): SegmentSummary => ({ index, first_message_at: null, last_message_at: null, compacted_at: "2026-11-01T00:00:00Z", message_count: 2, excluded: false, label: null, note: null, memory_before: null, memory_after: null });
const listing = (threads: ThreadView[], extra: Partial<ThreadListing> = {}): ThreadListing => ({ character: "ada", threads, home: "main", current: "main", ...extra });
const page = (messages: Message[], index: number | null, extra: Record<string, unknown> = {}) => ({ messages, cursor: 0, next_before: 7, has_more_before: true, total_turns: 9, segment: index === null ? null : segment(index), previous_segment: index === null || index === 0 ? null : segment(index - 1), next_segment: index === null ? null : segment(index + 1), ...extra });
const history = (extra: Record<string, unknown> = {}): ServerMessage => ({ type: "history", messages: [], config: { model: "opus" }, revision: 1, selected_character: "ada", selected_thread: "main", ...extra });
const descriptor = (name: string, effects: OperationDescriptor["effects"]): OperationDescriptor => ({ name, label: name, category: "Conversation", scope: "selection", prerequisites: [], effects, confirmation: "none", fields: {}, input: {}, output: {} });
const MESSAGE: BrowserRequest = { type: "message", text: "hi", stream: true, images: [] };

type Handler = ((args: unknown) => unknown) | null;
interface Call { name: string; args: unknown; rid: string; reply: (data: unknown) => void; fail: (text: string) => void }

async function settle(): Promise<void> { await Bun.sleep(1); }

function rig(handlers: Record<string, Handler> = {}, schedule?: (callback: () => void) => void) {
  const listeners = new Set<(update: ConnectionUpdate) => void>();
  const calls: Call[] = [];
  let status: ConnectionStatus = "ready";
  let reconnects = 0;
  let next = 0;
  const emit = (update: ConnectionUpdate) => { for (const listener of listeners) listener(update); };
  const answers: Record<string, Handler> = {
    discover_operations: () => ({ operations: [], requests: [] }),
    list_characters: () => ({ characters: [{ name: "ada" }] }),
    list_threads: () => listing([thread("main")]),
    ...handlers,
  };
  const connection = {
    get status() { return status; },
    subscribe: (listener: (update: ConnectionUpdate) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reconnect: () => { reconnects += 1; },
    submit: (request: BrowserRequest) => {
      next += 1;
      const rid = `op_${String(next)}`;
      let finish: (result: RequestFinished) => void = () => {};
      const finished = new Promise<RequestFinished>((resolve) => { finish = resolve; });
      const name = request.type === "command" ? request.name : request.type;
      const call: Call = {
        name, args: request.type === "command" ? request.args : undefined, rid,
        reply: (data) => { emit({ kind: "frame", message: { type: "command_output", rid, name, data } as ServerMessage }); finish({ rid, outcome: "completed" }); },
        fail: (text) => { finish({ rid, outcome: "failed", error: { code: "internal_error", message: text } }); },
      };
      calls.push(call);
      const answer = answers[name];
      if (answer !== undefined && answer !== null) queueMicrotask(() => { try { call.reply(answer(call.args)); } catch (error) { call.fail((error as Error).message); } });
      return { rid, finished };
    },
  };
  const workspace = new Workspace(connection as unknown as BrowserConnection, schedule);
  let notified = 0;
  workspace.subscribe(() => { notified += 1; });
  return {
    workspace, calls, emit,
    frame: (frame: unknown) => { emit({ kind: "frame", message: frame as ServerMessage }); },
    setStatus: (value: ConnectionStatus, detail = "") => { status = value; emit({ kind: "status", status: value, detail }); },
    reconnects: () => reconnects,
    notified: () => notified,
    state: () => workspace.getSnapshot(),
    named: (name: string) => calls.filter((call) => call.name === name),
  };
}

async function opened(handlers: Record<string, Handler> = {}, schedule?: (callback: () => void) => void) {
  const link = rig(handlers, schedule);
  link.frame(history({ messages: [message("m_1"), message("m_2")] }));
  await settle();
  return link;
}

describe("pure helpers", () => {
  test("a command's secret argument is hidden before it is shown, and anything else is shown as it was sent", () => {
    for (const [name, key] of [["config", "value"], ["add_credential", "secret"], ["update_credential", "secret"], ["finish_sign_in", "code"]] as const) {
      const request = { type: "command", name, args: { [key]: "hunter2", other: 1 } } as BrowserRequest;
      expect(inspectableRequest(request), name).toEqual({ type: "command", name, args: { [key]: "<redacted>", other: 1 } } as BrowserRequest);
      expect(request).toEqual({ type: "command", name, args: { [key]: "hunter2", other: 1 } } as BrowserRequest);
    }
    const unset = { type: "command", name: "config", args: { key: "a" } } as BrowserRequest;
    expect(inspectableRequest(unset)).toEqual(unset);
    const inherited = { type: "command", name: "config", args: Object.create({ value: "inherited" }) as object } as BrowserRequest;
    expect(inspectableRequest(inherited)).toEqual({ type: "command", name: "config", args: {} } as BrowserRequest);
    const kept = [MESSAGE, { type: "command", name: "list_threads", args: { value: "x" } }, { type: "command", name: "config", args: null }, { type: "command", name: "config", args: ["value"] }, { type: "command", name: "config", args: "value" }] as BrowserRequest[];
    for (const request of kept) expect(inspectableRequest(request)).toBe(request);
  });

  test("a whole history replaces the messages, and a change adds to them after the message it follows", () => {
    const [a, b, c] = [message("a"), message("b"), message("c")];
    const delta = (after: string | null, messages: Message[]) => ({ messages, config: {}, revision: 2, delta: { base_revision: 1, after } }) as History;
    expect(mergeHistory([a], { messages: [b, c], config: {}, revision: 2 })).toEqual([b, c]);
    expect(mergeHistory([a], { messages: [b], config: {}, revision: 2, delta: null })).toEqual([b]);
    expect(mergeHistory([a, b], delta("a", [c]))).toEqual([a, c]);
    expect(mergeHistory([a, b], delta("b", [c]))).toEqual([a, b, c]);
    expect(mergeHistory([a, b], delta(null, [c]))).toEqual([c]);
    expect(mergeHistory([a, b], delta("gone", [c]))).toBeUndefined();
    const twice = message("a", { content: "again" });
    expect(mergeHistory([a, b, twice], delta("a", [c])), "the last copy of the message it follows").toEqual([a, b, twice, c]);
  });

  test("an added message keeps picture data the earlier messages already had for the same file", () => {
    const earlier = message("a", { images: [{ path: "/p.png", data: "pixels" }, { path: "/q.png", data: null }] });
    const later = message("b", { images: [{ path: "/p.png" }, { path: "/q.png" }, { path: "/r.png", data: "own" }] });
    expect(mergeHistory([earlier], { messages: [later], config: {}, revision: 2, delta: { base_revision: 1, after: "a" } })?.at(-1)?.images).toEqual([
      { path: "/p.png", data: "pixels" }, { path: "/q.png" }, { path: "/r.png", data: "own" },
    ]);
  });

  test("a new message marks its thread active at its own time, for the selected character only", () => {
    const threads = [thread("main"), thread("side")];
    const arrived = (extra: Record<string, unknown>) => ({ type: "new_message", revision: 2, character: "ada", thread: "side", msg_id: "m", role: "user", content: "", images: [], content_blocks: [], timestamp: "2026-11-10T05:00:00+01:00", ...extra }) as Extract<ServerMessage, { type: "new_message" }>;
    expect(touchThread(threads, "ada", arrived({}))).toEqual([thread("main"), thread("side", { last_active: "2026-11-10T04:00:00.000Z" })]);
    expect(touchThread(threads, "ada", arrived({ thread: null }))).toEqual([thread("main", { last_active: "2026-11-10T04:00:00.000Z" }), thread("side")]);
    expect(touchThread(threads, "bo", arrived({}))).toBe(threads);
    expect(touchThread(threads, "ada", arrived({ timestamp: "whenever" }))).toBe(threads);
  });

  test("an unread count lands on its thread, with its time when it has one", () => {
    const threads = [thread("main", { unread: 1, last_active: "a" }), thread("side")];
    expect(applyThreadUnread(threads, { character: "ada", thread: "main", unread: 3 })).toEqual([thread("main", { unread: 3, last_active: "a" }), thread("side")]);
    expect(applyThreadUnread(threads, { character: "ada", thread: "side", unread: 2, last_active: "b" })).toEqual([threads[0] as ThreadView, thread("side", { unread: 2, last_active: "b" })]);
  });
});

describe("the workspace", () => {
  test("starts empty, tells subscribers of every change until they leave, and keeps errors until dismissed", () => {
    const link = rig();
    expect(link.state()).toMatchObject({ characters: [], threads: [], messages: [], status: "idle", error: "", character: null, thread: null, segmentView: null, opening: null, spendingRequestsFinished: 0 });
    let heard = 0;
    const leave = link.workspace.subscribe(() => { heard += 1; });
    link.workspace.report(new Error("broke"));
    expect(link.state().error).toBe("broke");
    link.workspace.report("plain");
    expect(link.state().error).toBe("plain");
    leave();
    link.workspace.dismissError();
    expect(link.state().error).toBe("");
    expect(heard).toBe(2);
    expect(link.notified()).toBe(3);
  });

  test("once ready it loads the catalogues and the threads, and a status that is not ready drops live streams", async () => {
    const operations = [descriptor("compact", ["provider_call"])];
    const link = rig({ discover_operations: () => ({ operations, requests: [descriptor("message", [])] }), list_characters: () => ({ characters: [{ name: "ada" }, { name: "bo" }] }) });
    link.frame(history());
    link.setStatus("ready", "ok");
    await settle();
    expect(link.state()).toMatchObject({ status: "ready", detail: "ok", operations, requests: [descriptor("message", [])], characters: [{ name: "ada" }, { name: "bo" }], threads: [thread("main")] });
    link.frame({ type: "stream_chunk", rid: "r_x", text: "hi", content_type: "text" });
    expect(link.state().streams).toHaveLength(1);
    link.setStatus("ready");
    expect(link.state().streams).toHaveLength(1);
    link.setStatus("reconnecting", "lost");
    expect(link.state()).toMatchObject({ status: "reconnecting", detail: "lost", streams: [] });
  });

  test("signing out forgets everything the daemon had said", async () => {
    const link = await opened();
    link.workspace.report("old error");
    link.setStatus("signed_out");
    expect(link.state()).toMatchObject({
      error: "", messages: [], metadata: {}, config: {}, media: [], mediaLimited: false, activity: [], operations: [], requests: [], threads: [], characters: [], uncertain: [],
      previousSegment: null, segmentView: null, opening: null, folders: [], manualOrder: false, compaction: null, status: "signed_out",
    });
  });

  test("a catalogue or thread list that arrives after a newer request, or after the connection dropped, is not used, and its failure is reported only while connected", async () => {
    const link = rig({ discover_operations: null, list_characters: null, list_threads: null });
    link.frame(history());
    await settle();
    const stale = link.workspace.refreshNavigation();
    const fresh = link.workspace.refreshNavigation();
    await settle();
    const [oldCatalogue, newCatalogue] = link.named("discover_operations").slice(-2);
    const [oldCharacters, newCharacters] = link.named("list_characters").slice(-2);
    const listings = link.named("list_threads");
    newCatalogue?.reply({ operations: [descriptor("new", [])], requests: [] });
    newCharacters?.reply({ characters: [{ name: "new" }] });
    listings.at(-1)?.reply(listing([thread("new")]));
    await fresh;
    oldCatalogue?.reply({ operations: [descriptor("old", [])], requests: [] });
    oldCharacters?.reply({ characters: [{ name: "old" }] });
    listings.at(-2)?.reply(listing([thread("old")]));
    await stale;
    expect(link.state()).toMatchObject({ operations: [{ name: "new" }], characters: [{ name: "new" }], threads: [{ id: "new" }] });

    const failing = link.workspace.refreshNavigation();
    await settle();
    link.named("discover_operations").at(-1)?.fail("catalogue down");
    link.named("list_threads").at(-1)?.fail("threads down");
    link.named("list_characters").at(-1)?.reply({ characters: [] });
    await failing;
    expect(link.state().error).toMatch(/down$/);
    link.workspace.dismissError();

    const dropped = link.workspace.refreshNavigation();
    await settle();
    link.setStatus("reconnecting");
    link.named("discover_operations").at(-1)?.fail("catalogue down");
    link.named("list_threads").at(-1)?.fail("threads down");
    link.named("list_characters").at(-1)?.reply({ characters: [] });
    await dropped;
    expect(link.state().error).toBe("");
  });

  test("failures while not connected are not reported, even for the current request", async () => {
    const link = rig({ discover_operations: null, list_threads: null });
    link.frame(history());
    await settle();
    link.setStatus("error");
    const refreshing = link.workspace.refreshNavigation();
    await settle();
    link.named("discover_operations").at(-1)?.fail("catalogue down");
    link.named("list_threads").at(-1)?.fail("threads down");
    await refreshing;
    expect(link.state().error).toBe("");
  });

  test("with no character selected there are no threads to list", async () => {
    const link = rig();
    link.workspace.noteThreads([thread("main")]);
    link.workspace.applyThreadListing(listing([thread("main")], { folders: [{ name: "f" }], manual_order: true, compaction: { thread: "main", trigger: "idle", started_at: "x" } }));
    await link.workspace.refreshThreads();
    expect(link.named("list_threads")).toHaveLength(0);
    expect(link.state()).toMatchObject({ threads: [], folders: [], manualOrder: false, compaction: null });
  });

  test("a thread listing brings folders, manual order and a running compaction, and defaults each", () => {
    const link = rig();
    const compaction = { thread: "main", trigger: "idle", started_at: "x" } as const;
    link.workspace.applyThreadListing(listing([thread("main")], { folders: [{ name: "f" }], manual_order: true, compaction }));
    expect(link.state()).toMatchObject({ threads: [thread("main")], folders: [{ name: "f" }], manualOrder: true, compaction });
    link.workspace.applyThreadListing(listing([thread("main")], { manual_order: false }));
    expect(link.state()).toMatchObject({ folders: [], manualOrder: false, compaction: null });
  });

  test("unread counts that arrive while a listing is on its way are kept over the listing's older counts", async () => {
    const link = await opened({ list_threads: null });
    const refreshing = link.workspace.refreshThreads();
    link.frame({ type: "thread_unread", character: "ada", thread: "side", unread: 4 });
    link.frame({ type: "thread_unread", character: "bo", thread: "main", unread: 9 });
    link.named("list_threads").at(-1)?.reply(listing([thread("main", { unread: 1 }), thread("side", { unread: 0 })]));
    await refreshing;
    expect(link.state().threads).toEqual([thread("main", { unread: 1 }), thread("side", { unread: 4 })]);
    link.workspace.applyThreadListing(listing([thread("main"), thread("side", { unread: 0 })]));
    expect(link.state().threads, "a listing applied directly is newer than every count").toEqual([thread("main"), thread("side", { unread: 0 })]);
    expect(link.state().activity.filter((item) => item.type === "thread_unread")).toHaveLength(2);
  });

  test("a listing that was asked for before a direct one is dropped", async () => {
    const link = await opened({ list_threads: null });
    const refreshing = link.workspace.refreshThreads();
    link.workspace.applyThreadListing(listing([thread("direct")]));
    link.named("list_threads").at(-1)?.reply(listing([thread("late")]));
    await refreshing;
    expect(link.state().threads).toEqual([thread("direct")]);
  });

  test("threads can be noted as read, as home, or replaced", () => {
    const link = rig();
    link.workspace.noteThreads([thread("main", { unread: 2 }), thread("side", { unread: 3 })]);
    link.workspace.noteThreadRead("side");
    expect(link.state().threads).toEqual([thread("main", { unread: 2 }), thread("side", { unread: 0 })]);
    link.workspace.noteHomeThread("side");
    expect(link.state().threads.map((item) => item.home)).toEqual([false, true]);
  });

  test("opening a thread or character says where it is going until the conversation arrives", async () => {
    const link = await opened({ switch_thread: null, switch_character: null });
    const opening = link.workspace.openThread("side");
    expect(link.state().opening).toEqual({ character: "ada", thread: "side" });
    await settle();
    expect(link.named("switch_thread")[0]?.args).toEqual({ name: "side", resync: true });
    link.frame(history({ selected_thread: "side" }));
    expect(link.state().opening).toBeNull();
    link.named("switch_thread")[0]?.reply({ character: "ada", thread: "side", changed: true });
    await opening;
    expect(link.state().opening).toBeNull();

    const character = link.workspace.openCharacter("bo");
    expect(link.state().opening).toEqual({ character: "bo", thread: null });
    await settle();
    expect(link.named("switch_character")[0]?.args).toEqual({ name: "bo" });
    link.frame(history({ selected_character: "ada", selected_thread: "main" }));
    expect(link.state().opening, "still on the old character").toEqual({ character: "bo", thread: null });
    link.named("switch_character")[0]?.fail("no such character");
    expect(await character.then(() => "", (error: unknown) => (error as Error).message)).toBe("no such character");
    expect(link.state().opening).toBeNull();
  });

  test("an opening overtaken by another keeps the newer target", async () => {
    const link = await opened({ switch_thread: null });
    const first = link.workspace.openThread("one");
    const second = link.workspace.openThread("two");
    await settle();
    link.named("switch_thread")[0]?.reply({ character: "ada", thread: "one", changed: true });
    await first;
    expect(link.state().opening).toEqual({ character: "ada", thread: "two" });
    link.named("switch_thread")[1]?.reply({ character: "ada", thread: "two", changed: true });
    await second;
    expect(link.state().opening).toBeNull();
  });

  test("the active model is noted into the configuration, which is made an object if it was not one", () => {
    const link = rig();
    link.frame(history({ config: { model: "opus" } }));
    link.workspace.noteActiveModel("sonnet");
    expect(link.state().config).toEqual({ model: "opus", active_model: "sonnet" });
    for (const config of [null, "text"]) {
      const other = rig();
      other.frame(history({ config }));
      other.workspace.noteActiveModel(null);
      expect(other.state().config, String(config)).toEqual({ active_model: null });
    }
  });
});

const META = { model: "opus", tokens: { input: 1, output: 2, cache_read: 0, cache_write: 0 }, timing: { total_ms: 10, ttft_ms: 5 } };
const chunk = (rid: string | null, text: string, kind = "text", extra: Record<string, unknown> = {}) => ({ type: "stream_chunk", rid, text, content_type: kind, ...extra });
const ended = (rid: string | null, content: string, extra: Record<string, unknown> = {}) => ({ type: "stream_end", rid, content, metadata: META, is_final: true, ...extra });
const called = (rid: string | null, id: string, extra: Record<string, unknown> = {}) => ({ type: "tool_call", rid, tool_id: id, tool_name: "read", input: { path: id }, ...extra });
const answered = (rid: string | null, id: string, extra: Record<string, unknown> = {}) => ({ type: "tool_result", rid, tool_id: id, tool_name: "read", output: `out ${id}`, is_error: false, ...extra });

describe("a conversation's history", () => {
  test("that cannot be merged asks the connection for a fresh copy", async () => {
    const link = await opened();
    link.frame(history({ revision: 2, delta: { base_revision: 1, after: "nowhere" }, messages: [message("m_3")] }));
    expect(link.reconnects()).toBe(1);
    expect(link.state().messages.map((item) => item.msg_id)).toEqual(["m_1", "m_2"]);
  });

  test("keeps the configuration when a history for the same conversation carries an empty one", async () => {
    const link = await opened();
    link.frame(history({ revision: 2, config: {} }));
    expect(link.state().config).toEqual({ model: "opus" });
    link.frame(history({ revision: 3, config: [] }));
    expect(link.state().config).toEqual([]);
    link.frame(history({ revision: 4, config: { model: "sonnet" } }));
    expect(link.state().config).toEqual({ model: "sonnet" });
    link.frame(history({ revision: 5, config: null }));
    expect(link.state().config).toBeNull();
    link.frame(history({ revision: 6, config: {}, selected_thread: "side" }));
    expect(link.state().config, "a new conversation takes its configuration as it is").toEqual({});
  });

  test("for the same conversation keeps what is live in it, and for another drops it all", async () => {
    const link = await opened({ history_page: () => page([message("old")], 2) });
    link.frame(ended(null, "done", { msg_id: "m_2" }));
    link.frame(ended(null, "unsaved", { msg_id: "m_9", rid: "r_live" }));
    link.frame(chunk("r_open", "still going"));
    link.frame({ type: "send_image", rid: "r_live", path: "/live.png", data: "pixels" });
    link.frame({ type: "phase", phase: "thinking" });
    link.frame({ type: "usage_warning", message: "careful" });
    await link.workspace.openSegment(2);
    link.frame(history({ revision: 2, messages: [message("m_1"), message("m_2"), message("m_3")] }));
    expect(link.state().metadata).toEqual({ m_2: META });
    expect(link.state().streams.map((stream) => stream.rid)).toEqual(["r_live", "r_open"]);
    expect(link.state().media.map((image) => image.path)).toEqual(["/live.png"]);
    expect(link.state().segmentView?.segment.index).toBe(2);
    expect(link.state().activity.some((item) => item.type === "phase")).toBe(true);
    link.frame(history({ revision: 3, messages: [message("m_1")] }));
    expect(link.state().metadata, "metadata for messages that are gone is dropped").toEqual({});

    link.frame(history({ revision: 4, selected_thread: "side", messages: [message("s_1")], previous_segment: segment(5) }));
    expect(link.state()).toMatchObject({ thread: "side", messages: [message("s_1")], media: [], mediaLimited: false, metadata: {}, streams: [], segmentView: null, previousSegment: segment(5) });
    expect(link.state().activity.some((item) => item.type === "phase")).toBe(false);
    expect(link.state().activity.some((item) => item.type === "usage_warning")).toBe(true);
  });

  test("a change to the conversation keeps the earlier segment it knew, and a whole history replaces it", async () => {
    const link = await opened();
    link.frame(history({ revision: 2, previous_segment: segment(3) }));
    expect(link.state().previousSegment).toEqual(segment(3));
    link.frame(history({ revision: 3, delta: { base_revision: 2, after: null }, messages: [] }));
    expect(link.state().previousSegment).toEqual(segment(3));
    link.frame(history({ revision: 4 }));
    expect(link.state().previousSegment).toBeNull();
  });

  test("an earlier segment that moved refreshes the open segment's neighbours, and says so if it cannot", async () => {
    const link = await opened({ history_page: (args) => (args as { count?: number }).count === 0 ? page([], 2, { previous_segment: segment(0), next_segment: segment(9) }) : page([message("old")], 2) });
    link.frame(history({ revision: 2, previous_segment: segment(1) }));
    await link.workspace.openSegment(2);
    const asked = link.named("history_page").length;
    link.frame(history({ revision: 3, previous_segment: segment(1) }));
    await settle();
    expect(link.named("history_page")).toHaveLength(asked);
    link.frame(history({ revision: 4, previous_segment: segment(4) }));
    await settle();
    expect(link.named("history_page").at(-1)?.args).toEqual({ segment: 2, count: 0 });
    expect(link.state().segmentView).toMatchObject({ previous: segment(0), next: segment(9), messages: [message("old")] });

    const failing = await opened({ history_page: (args) => { if ((args as { count?: number }).count === 0) throw new Error("page gone"); return page([], 2); } });
    await failing.workspace.openSegment(2);
    failing.frame(history({ revision: 2, previous_segment: segment(4) }));
    await settle();
    expect(failing.state().error).toBe("page gone");
  });

  test("a refresh of the neighbours that finds the segment gone, or the view closed, changes nothing", async () => {
    const link = await opened({ history_page: (args) => (args as { count?: number }).count === 0 ? page([], null) : page([message("old")], 2) });
    await link.workspace.openSegment(2);
    const view = link.state().segmentView;
    link.frame(history({ revision: 2, previous_segment: segment(4) }));
    await settle();
    expect(link.state().segmentView).toBe(view);

    const held = await opened({ history_page: (args) => (args as { count?: number }).count === 0 ? null : page([message("old")], 2) });
    held.calls.length = 0;
    await held.workspace.openSegment(2);
    held.frame(history({ revision: 2, previous_segment: segment(4) }));
    await settle();
    held.workspace.closeSegment();
    held.named("history_page").at(-1)?.reply(page([], 2, { next_segment: segment(9) }));
    await settle();
    expect(held.state().segmentView).toBeNull();
  });

  test("moving to another thread lists that character's threads again, and another character reloads everything", async () => {
    const link = await opened();
    link.calls.length = 0;
    link.frame(history({ revision: 2, selected_thread: "side" }));
    await settle();
    expect(link.calls.map((call) => call.name)).toEqual(["list_threads"]);
    link.calls.length = 0;
    link.frame(history({ revision: 1, selected_character: "bo", selected_thread: null }));
    await settle();
    expect(link.calls.map((call) => call.name).sort()).toEqual(["discover_operations", "list_characters", "list_threads"]);
    link.calls.length = 0;
    link.setStatus("connecting");
    link.frame(history({ revision: 1, selected_character: "cy", selected_thread: null }));
    await settle();
    expect(link.calls, "while connecting the ready status reloads instead").toHaveLength(0);
  });

  test("an unread count that arrives while the listing is on its way survives a history for the same conversation", async () => {
    const link = await opened({ list_threads: null });
    const refreshing = link.workspace.refreshThreads();
    link.frame({ type: "thread_unread", character: "ada", thread: "side", unread: 4 });
    link.frame(history({ revision: 2 }));
    link.named("list_threads").at(-1)?.reply(listing([thread("main"), thread("side")]));
    await refreshing;
    expect(link.state().threads.find((item) => item.id === "side")?.unread).toBe(4);
  });

  test("opening a character is reached by its history, whichever thread it lands on", async () => {
    const link = await opened({ switch_character: null });
    const opening = link.workspace.openCharacter("bo");
    link.frame(history({ selected_character: "bo", selected_thread: "story" }));
    expect(link.state().opening).toBeNull();
    await settle();
    link.named("switch_character")[0]?.reply({ character: "bo", changed: true });
    await opening;
  });
});

describe("new messages", () => {
  test("are added once, with live picture data, and mark their thread active", async () => {
    const link = await opened();
    link.workspace.noteThreads([thread("main"), thread("side")]);
    link.frame({ type: "send_image", path: "/p.png", data: "pixels" });
    const before = link.notified();
    const arrived = { type: "new_message", revision: 2, character: "ada", thread: "main", msg_id: "m_3", role: "assistant", content: "x", images: [{ path: "/p.png" }], content_blocks: [], timestamp: "2026-11-10T01:00:00Z" };
    link.frame(arrived);
    expect(link.state().messages.at(-1)?.images).toEqual([{ path: "/p.png", data: "pixels" }]);
    expect(link.state().media).toEqual([]);
    expect(link.state().threads[0]?.last_active).toBe("2026-11-10T01:00:00.000Z");
    expect(link.notified()).toBe(before + 1);
    link.frame(arrived);
    expect(link.state().messages).toHaveLength(3);
    expect(link.notified()).toBe(before + 1);
  });
});

async function pending(link: ReturnType<typeof rig>, name: "run_tool" | "compact" | "compact_watch"): Promise<string> {
  const input = name === "run_tool" ? { tool: "read" } : {};
  void link.workspace.actions.run(name, input as never).catch(() => undefined);
  await settle();
  const rid = link.named(name).at(-1)?.rid;
  if (rid === undefined) throw new Error(`${name} was not sent`);
  return rid;
}

describe("live replies", () => {
  test("gather text and reasoning by request, sub-agent and task, in rounds that start over after a tool call", async () => {
    const link = await opened();
    for (const frame of [chunk("r_1", "Hel"), chunk("r_1", "lo"), chunk("r_1", "hmm", "thinking"), called("r_1", "t_1"), chunk("r_1", " again"), chunk("r_1", "sub", "text", { subagent: "memory", task_id: "k" })]) link.frame(frame);
    const [main, sub] = link.state().streams;
    expect(main).toEqual({
      key: JSON.stringify(["r_1", null, null]), rid: "r_1", subagent: null, text: "Hello again", reasoning: "hmm", tools: ["t_1"], round: { reasoning: "", text: " again", tools: [] },
      final: false, msgId: null, metadata: null, previewLimited: false, blocks: [{ type: "tool_use", id: "t_1", name: "read", input: { path: "t_1" } }],
    });
    expect(sub).toMatchObject({ key: JSON.stringify(["r_1", "memory", "k"]), rid: "r_1", subagent: "memory", text: "sub" });
    link.frame(chunk(null, "no request"));
    expect(link.state().streams.at(-1)).toMatchObject({ key: JSON.stringify([null, null, null]), rid: null });
    link.frame(chunk("r_1", "more thought", "thinking"));
    expect(link.state().streams.at(-1)?.round).toEqual({ reasoning: "more thought", text: " again", tools: [] });
  });

  test("a reply's end sets its text, id and metadata, and keeps its blocks unless the end brings its own", async () => {
    const link = await opened();
    link.frame(chunk("r_1", "partial"));
    link.frame(called("r_1", "t_1"));
    link.frame(ended("r_1", "first round", { msg_id: "m_9", is_final: false }));
    expect(link.state().streams.at(-1)).toMatchObject({ text: "first round", final: false, msgId: "m_9", metadata: META, blocks: [{ type: "tool_use", id: "t_1" }] });
    expect(link.state().metadata).toEqual({});
    link.frame(ended("r_1", "final text", { msg_id: "m_9", terminal_content_blocks: [{ type: "text", text: "x" }] }));
    const total = { model: "opus", tokens: { input: 2, output: 4, cache_read: 0, cache_write: 0 }, timing: { total_ms: 20, ttft_ms: 5 } };
    expect(link.state().streams.at(-1)).toMatchObject({ text: "final text", final: true, msgId: "m_9", metadata: total, blocks: [{ type: "text", text: "x" }] });
    expect(link.state().metadata).toEqual({ m_9: total });
    link.frame(ended("r_2", "no id", { msg_id: null }));
    link.frame(ended("r_3", "sub", { msg_id: "m_sub", subagent: "memory" }));
    expect(Object.keys(link.state().metadata)).toEqual(["m_9"]);
    link.frame({ type: "stream_start", rid: "r_1", regen: false });
    expect(link.state().streams.find((stream) => stream.rid === "r_1")?.final).toBe(false);
  });

  test("a regeneration says which messages it replaces", async () => {
    const link = await opened();
    link.frame({ type: "stream_start", rid: "r_1", regen: true, replaces: ["m_2"] });
    link.frame({ type: "stream_start", rid: "r_2", regen: true });
    link.frame({ type: "stream_start", rid: "r_3", regen: false, replaces: ["m_1"] });
    expect(link.state().streams.map((stream) => stream.replaces ?? "none")).toEqual([["m_2"], [], "none"]);
  });

  test("metadata is kept for the 256 newest saved replies, the latest copy of each last", async () => {
    const link = await opened();
    for (let index = 0; index < 257; index += 1) link.frame(ended(null, "x", { msg_id: `m_${String(index)}` }));
    const ids = Object.keys(link.state().metadata);
    expect(ids).toHaveLength(256);
    expect(ids[0]).toBe("m_1");
    link.frame(ended(null, "x", { msg_id: "m_1" }));
    expect(Object.keys(link.state().metadata).at(-1)).toBe("m_1");
    expect(Object.keys(link.state().metadata)).toHaveLength(256);
  });

  test("long text and many blocks are cut to their newest part and marked as cut", async () => {
    const link = await opened();
    const limit = 512 * 1024;
    link.frame(chunk("r_1", `${"a".repeat(limit)}bcdef`));
    expect(link.state().streams.at(-1)).toMatchObject({ previewLimited: true });
    expect(link.state().streams.at(-1)?.text).toBe(`${"a".repeat(limit - 5)}bcdef`);
    expect(link.state().streams.at(-1)?.round.text).toHaveLength(limit);
    link.frame(chunk("r_2", `${"a".repeat(limit)}z`, "thinking"));
    expect(link.state().streams.at(-1)).toMatchObject({ previewLimited: true });
    expect(link.state().streams.at(-1)?.reasoning.endsWith("z")).toBe(true);
    expect(link.state().streams.at(-1)?.round.reasoning).toHaveLength(limit);
    link.frame(chunk("r_3", "a".repeat(limit)));
    expect(link.state().streams.at(-1)?.previewLimited).toBe(false);
    for (let index = 0; index < 64; index += 1) link.frame(called("r_4", `t_${String(index)}`));
    expect(link.state().streams.at(-1)?.previewLimited).toBe(false);
    link.frame(called("r_4", "t_64"));
    expect(link.state().streams.at(-1)?.blocks).toHaveLength(64);
    expect(link.state().streams.at(-1)?.previewLimited).toBe(true);
    expect(link.state().streams.at(-1)?.blocks.at(-1)).toMatchObject({ id: "t_64" });
    link.frame(called("r_5", "huge", { input: { text: "x".repeat(limit) } }));
    expect(link.state().streams.at(-1)).toMatchObject({ blocks: [], previewLimited: true });
    link.frame(chunk("r_5", "fine"));
    expect(link.state().streams.at(-1)?.previewLimited, "once cut, a reply stays marked").toBe(true);
  });

  test("only the 32 most recent replies are kept", async () => {
    const link = await opened();
    for (let index = 0; index < 33; index += 1) link.frame(chunk(`r_${String(index)}`, "x"));
    expect(link.state().streams).toHaveLength(32);
    expect(link.state().streams[0]?.rid).toBe("r_1");
  });

  test("streamed text waits for the next frame to be shown, and anything else shows at once", async () => {
    const queued: (() => void)[] = [];
    const link = await opened({}, (callback) => { queued.push(callback); });
    const before = link.notified();
    link.frame(chunk("r_1", "a"));
    link.frame(chunk("r_1", "b"));
    expect(queued).toHaveLength(1);
    expect(link.notified()).toBe(before);
    expect(link.state().streams.at(-1)?.text).toBe("ab");
    queued.shift()?.();
    expect(link.notified()).toBe(before + 1);
    link.frame(chunk("r_1", "c"));
    link.frame(called("r_1", "t_1"));
    expect(link.notified(), "the call and its activity show at once").toBe(before + 3);
    queued.shift()?.();
    expect(link.notified(), "the frame finds nothing left to show").toBe(before + 3);
    link.frame(chunk("r_1", "d"));
    expect(queued).toHaveLength(1);
  });

  test("a tool run started by hand keeps its reply out of the conversation unless a sub-agent speaks, and ends it when done", async () => {
    const link = await opened({ run_tool: null });
    const rid = await pending(link, "run_tool");
    link.frame(chunk(rid, "tool talk"));
    expect(link.state().streams).toHaveLength(0);
    link.frame(chunk(rid, "agent talk", "text", { subagent: "memory" }));
    expect(link.state().streams.map((stream) => stream.subagent)).toEqual(["memory"]);
    link.frame(answered(rid, "t_1", { images: [{ path: "/shot.png", data: "S" }] }));
    expect(link.state().media).toEqual([{ path: "/shot.png", data: "S", manual: true, rid, subagent: null, task_id: null, toolId: "t_1", previewData: "S" }]);
    link.frame({ type: "send_image", rid, path: "/sent.png", data: "P" });
    expect(link.state().media.at(-1)).toMatchObject({ path: "/sent.png", manual: true });
    link.frame({ type: "request_finished", rid, outcome: "completed" });
    expect(link.state().streams).toHaveLength(0);
  });

  test("a compaction pass's frames are neither live replies nor activity", async () => {
    for (const name of ["compact", "compact_watch"] as const) {
      const link = await opened({ [name]: null });
      const rid = await pending(link, name);
      const before = link.state().activity.length;
      for (const frame of [chunk(rid, "summary"), called(rid, "t_1"), answered(rid, "t_1"), ended(rid, "done"), { type: "phase", rid, phase: "compacting" }]) link.frame(frame);
      expect(link.state().streams, name).toHaveLength(0);
      expect(link.state().activity, name).toHaveLength(before);
      link.frame({ type: "phase", rid: "r_other", phase: "x" });
      expect(link.state().activity, name).toHaveLength(before + 1);
    }
  });

  test("pictures from tool results join the live pictures, keeping what the same call had", async () => {
    const link = await opened();
    link.frame(answered("r_1", "t_1", { subagent: "memory", task_id: "k", images: [{ path: "/a.png", data: "A" }] }));
    expect(link.state().media).toEqual([{ path: "/a.png", data: "A", rid: "r_1", subagent: "memory", task_id: "k", toolId: "t_1", previewData: "A" }]);
    link.frame({ type: "new_message", revision: 2, character: "ada", thread: "main", msg_id: "m_3", role: "user", content: "", images: [], content_blocks: [{ type: "tool_result", tool_use_id: "t_1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A" } }] }], timestamp: "2026-11-10T01:00:00Z" });
    expect(link.state().media[0]?.messageId).toBe("m_3");
    link.frame(answered("r_1", "t_1", { subagent: "memory", task_id: "k", images: [{ path: "/a.png" }] }));
    expect(link.state().media).toEqual([{ path: "/a.png", data: "A", rid: "r_1", subagent: "memory", task_id: "k", toolId: "t_1", previewData: undefined, messageId: "m_3" }]);
    link.frame(answered("r_1", "t_2", { subagent: "memory", task_id: "k", images: [{ path: "/a.png" }] }));
    expect(link.state().media[0]?.messageId, "another call's picture is not that message's").toBeUndefined();
    link.frame(answered("r_2", "t_3", { images: [{ path: "/a.png" }] }));
    expect(link.state().media).toEqual([{ path: "/a.png", data: null, rid: "r_2", subagent: null, task_id: null, toolId: "t_3", previewData: undefined }]);
    link.frame(answered(null, "t_4", { images: [{ path: "/b.png", data: "B" }] }));
    link.frame(answered(null, "t_4", { images: [{ path: "/b.png" }] }));
    expect(link.state().media.at(-1)).toMatchObject({ path: "/b.png", data: "B", rid: null });
    expect(link.state().mediaLimited).toBe(false);
    for (let index = 0; index < 128; index += 1) link.frame(answered("r_3", `t_${String(index)}`, { images: [{ path: `/many/${String(index)}.png` }] }));
    expect(link.state().mediaLimited).toBe(true);
    link.frame(answered("r_3", "t_x", { images: [] }));
    expect(link.state().mediaLimited, "once pictures were dropped it stays said").toBe(true);
  });
});

describe("other frames", () => {
  test("a sent picture joins the live pictures, merged with what the same request sent before", async () => {
    const link = await opened();
    link.frame({ type: "send_image", rid: "r_1", path: "/a.png", data: "A", caption: "first" });
    link.frame({ type: "send_image", rid: "r_1", path: "/a.png", caption: "second" });
    const merged: unknown = link.state().media;
    expect(merged).toEqual([{ type: "send_image", rid: "r_1", path: "/a.png", data: "A", caption: "second" }]);
    link.frame({ type: "send_image", rid: "r_2", path: "/a.png" });
    const replaced: unknown = link.state().media;
    expect(replaced).toEqual([{ type: "send_image", rid: "r_2", path: "/a.png", data: null }]);
    link.frame({ type: "send_image", path: "/b.png", data: "B" });
    link.frame({ type: "send_image", rid: null, path: "/b.png" });
    expect(link.state().media.at(-1)).toMatchObject({ path: "/b.png", data: "B" });
    expect(link.state().activity.filter((item) => item.type === "send_image")).toHaveLength(5);
    for (let index = 0; index < 128; index += 1) link.frame({ type: "send_image", path: `/many/${String(index)}.png` });
    expect(link.state().mediaLimited).toBe(true);
    link.frame({ type: "send_image", path: "/one-more.png" });
    expect(link.state().mediaLimited).toBe(true);
  });

  test("an uncertain request is listed with its secrets hidden, and takes the pictures it brought unless added by hand", async () => {
    const link = await opened({ run_tool: null });
    const manual = await pending(link, "run_tool");
    link.frame({ type: "send_image", rid: "r_lost", path: "/lost.png", data: "L" });
    link.frame({ type: "send_image", rid: "r_kept", path: "/kept.png", data: "K" });
    link.frame({ type: "send_image", rid: manual, path: "/hand.png", data: "H" });
    const selection = { character: "ada", thread: "main", messageRevision: 1, snapshotRevision: 1 };
    link.emit({ kind: "uncertain", rid: "r_lost", request: { type: "command", name: "config", args: { value: "secret" } } as BrowserRequest, selection });
    link.emit({ kind: "uncertain", rid: manual, request: MESSAGE, selection });
    expect(link.state().uncertain).toEqual([
      { kind: "uncertain", rid: "r_lost", request: { type: "command", name: "config", args: { value: "<redacted>" } }, selection },
      { kind: "uncertain", rid: manual, request: MESSAGE, selection },
    ]);
    expect(link.state().media.map((image) => image.path)).toEqual(["/kept.png", "/hand.png"]);
    link.workspace.acknowledge("r_lost");
    expect(link.state().uncertain.map((item) => item.rid)).toEqual([manual]);
  });

  test("a finished request ends its live reply unless it completed, settles an uncertain one, and counts when it could have spent", async () => {
    const link = await opened({ list_threads: null, discover_operations: () => ({ operations: [descriptor("list_threads", ["read"]), descriptor("compact", ["provider_call"])], requests: [] }) });
    link.frame(chunk("r_1", "x"));
    link.frame({ type: "request_finished", rid: "r_1", outcome: "completed" });
    expect(link.state().streams).toHaveLength(1);
    link.frame({ type: "request_finished", rid: "r_1", outcome: "failed" });
    expect(link.state().streams).toHaveLength(0);
    expect(link.state().spendingRequestsFinished).toBe(2);
    const selection = { character: "ada", thread: "main", messageRevision: 1, snapshotRevision: 1 };
    for (const rid of ["r_2", "r_3", "r_4"]) link.emit({ kind: "uncertain", rid, request: MESSAGE, selection });
    link.frame({ type: "request_finished", rid: "r_2", outcome: "failed", error: { code: "internal_error", message: "boom" } });
    expect(link.state().error).toBe("boom");
    link.frame({ type: "request_finished", rid: "r_3", outcome: "failed" });
    expect(link.state().error).toBe("A request that was in flight when the connection dropped failed.");
    link.workspace.dismissError();
    link.frame({ type: "request_finished", rid: "r_4", outcome: "cancelled" });
    expect(link.state().error).toBe("");
    expect(link.state().uncertain).toEqual([]);
    link.frame({ type: "request_finished", rid: "r_5", outcome: "failed" });
    expect(link.state().error, "a request nobody was unsure of fails quietly here").toBe("");
    const listingRid = link.named("list_threads").at(-1)?.rid ?? "";
    const counted = link.state().spendingRequestsFinished;
    link.frame({ type: "request_finished", rid: listingRid, outcome: "completed" });
    expect(link.state().spendingRequestsFinished, "a read-only action spends nothing").toBe(counted);
    const compacting = await pending(link, "compact");
    link.frame({ type: "request_finished", rid: compacting, outcome: "completed" });
    expect(link.state().spendingRequestsFinished).toBe(counted + 1);
    expect(link.state().activity.filter((item) => item.type === "request_finished")).toHaveLength(8);
  });

  test("everything else the daemon says is kept as recent activity, the newest hundred, large ones previewed", async () => {
    const link = await opened();
    const start = link.state().activity.length;
    link.frame({ type: "error", message: "bad thing" });
    expect(link.state().error).toBe("bad thing");
    const kinds = ["command_output", "cache_warning", "provider_warning", "request_accepted", "provider_fallback_warning", "usage_warning", "plan_limit_warning", "config_warning", "shutdown", "phase"];
    for (const type of kinds) link.frame({ type, rid: "r_x" });
    link.emit({ kind: "future", message: { type: "from_the_future" } });
    link.frame(chunk("r_y", "x"));
    link.frame(called("r_y", "t_1"));
    link.frame(answered("r_y", "t_1"));
    link.frame(ended("r_y", "done"));
    link.frame({ type: "stream_start", rid: "r_z", regen: false });
    const recent = link.state().activity.slice(start);
    expect(recent.map((item) => item.type)).toEqual(["error", ...kinds, "Future event: from_the_future", "tool_call", "tool_result", "stream_end", "stream_start"]);
    expect(link.state().activity.map((item) => item.id)).toEqual(Array.from({ length: start + 16 }, (_, index) => index + 1));
    const before = link.notified();
    link.frame({ type: "ping" });
    expect(link.notified()).toBe(before);
    const big = { type: "command_output", rid: "r_big", name: "x", data: "y".repeat(70 * 1024) };
    link.frame(big);
    expect(link.state().activity.at(-1)).toMatchObject({ type: "command_output", previewLimited: true });
    expect(link.state().activity.at(-1)?.data).not.toBe(big);
    expect(link.state().activity.at(-2)?.previewLimited).toBe(false);
    for (let index = 0; index < 100; index += 1) link.frame({ type: "phase", phase: String(index) });
    expect(link.state().activity).toHaveLength(100);
    expect(link.state().activity[0]?.data).toEqual({ type: "phase", phase: "0" });
    expect(link.state().activity.at(-1)?.data).toEqual({ type: "phase", phase: "99" });
  });

  test("a change to the selected character's threads lists them again while connected", async () => {
    const link = await opened();
    link.calls.length = 0;
    link.frame({ type: "threads_changed", character: "bo" });
    link.frame({ type: "threads_changed", character: "ada" });
    await settle();
    expect(link.calls.map((call) => call.name)).toEqual(["list_threads"]);
    link.setStatus("reconnecting");
    link.calls.length = 0;
    link.frame({ type: "threads_changed", character: "ada" });
    await settle();
    expect(link.calls).toHaveLength(0);
    expect(link.state().activity.filter((item) => item.type === "threads_changed")).toHaveLength(3);
  });

  test("an unread count for the selected character lands on its thread", async () => {
    const link = await opened();
    link.workspace.noteThreads([thread("main"), thread("side")]);
    link.frame({ type: "thread_unread", character: "bo", thread: "side", unread: 9 });
    link.frame({ type: "thread_unread", character: "ada", thread: "side", unread: 2 });
    expect(link.state().threads.map((item) => item.unread ?? 0)).toEqual([0, 2]);
  });
});

describe("older segments", () => {
  test("a segment opens on its newest page, with its neighbours and the newest live message at the time", async () => {
    const link = await opened({ history_page: () => page([message("old")], 3) });
    await link.workspace.openSegment(3);
    expect(link.named("history_page")[0]?.args).toEqual({ segment: 3, turns: SEGMENT_PAGE_TURNS });
    expect(SEGMENT_PAGE_TURNS).toBe(32);
    expect(link.state().segmentView).toEqual({ segment: segment(3), previous: segment(2), next: segment(4), messages: [message("old")], before: 7, hasEarlier: true, seenLive: "m_2" });
    const empty = rig({ history_page: () => page([], 0, { has_more_before: false, next_before: 0 }) });
    await empty.workspace.openSegment(0);
    expect(empty.state().segmentView).toEqual({ segment: segment(0), previous: null, next: segment(1), messages: [], before: 0, hasEarlier: false, seenLive: null });
    const missing = rig({ history_page: () => page([], null) });
    await missing.workspace.openSegment(9);
    expect(missing.state().segmentView).toBeNull();
  });

  test("only the latest request to open or close a segment counts", async () => {
    const link = await opened({ history_page: null });
    const first = link.workspace.openSegment(1);
    const second = link.workspace.openSegment(2);
    await settle();
    link.named("history_page")[1]?.reply(page([], 2));
    await second;
    link.named("history_page")[0]?.reply(page([], 1));
    await first;
    expect(link.state().segmentView?.segment.index).toBe(2);
    const closing = link.workspace.openSegment(5);
    link.workspace.closeSegment();
    await settle();
    link.named("history_page")[2]?.reply(page([], 5));
    await closing;
    expect(link.state().segmentView).toBeNull();
  });

  test("older and newer move through the segments, and newer past the last closes the view", async () => {
    const link = await opened({ history_page: (args) => page([], (args as { segment: number }).segment, (args as { segment: number }).segment === 4 ? { next_segment: null } : {}) });
    await link.workspace.openOlder();
    expect(link.named("history_page")).toHaveLength(0);
    link.frame(history({ revision: 2, previous_segment: segment(3) }));
    await link.workspace.openOlder();
    expect(link.state().segmentView?.segment.index).toBe(3);
    await link.workspace.openOlder();
    expect(link.state().segmentView?.segment.index).toBe(2);
    await link.workspace.openNewer();
    await link.workspace.openNewer();
    expect(link.state().segmentView?.segment.index).toBe(4);
    await link.workspace.openNewer();
    expect(link.state().segmentView).toBeNull();
    const first = rig({ history_page: () => page([], 0) });
    await first.workspace.openSegment(0);
    await first.workspace.openOlder();
    expect(first.named("history_page"), "nothing is older than the first").toHaveLength(1);
  });

  test("closing tells subscribers only when a segment was open", async () => {
    const link = await opened({ history_page: () => page([], 2) });
    const before = link.notified();
    link.workspace.closeSegment();
    expect(link.notified()).toBe(before);
    await link.workspace.openSegment(2);
    const open = link.notified();
    link.workspace.closeSegment();
    expect(link.notified()).toBe(open + 1);
    expect(link.state().segmentView).toBeNull();
  });

  test("earlier pages load one at a time, before what is shown, without repeating a message", async () => {
    const link = await opened({ history_page: null });
    await link.workspace.loadEarlierInSegment();
    expect(link.named("history_page")).toHaveLength(0);
    const opening = link.workspace.openSegment(2);
    await settle();
    link.named("history_page")[0]?.reply(page([message("c"), message("d")], 2, { next_before: 7 }));
    await opening;
    const loading = link.workspace.loadEarlierInSegment();
    void link.workspace.loadEarlierInSegment();
    await settle();
    expect(link.named("history_page")).toHaveLength(2);
    expect(link.named("history_page")[1]?.args).toEqual({ segment: 2, before: 7, turns: SEGMENT_PAGE_TURNS });
    link.named("history_page")[1]?.reply(page([message("a"), message("b"), message("c")], 2, { next_before: 3, has_more_before: false }));
    await loading;
    expect(link.state().segmentView).toMatchObject({ messages: [message("a"), message("b"), message("c"), message("d")], before: 3, hasEarlier: false });
    await link.workspace.loadEarlierInSegment();
    expect(link.named("history_page"), "nothing earlier to load").toHaveLength(2);
  });

  test("an earlier page that fails can be asked for again, and one for a closed view is dropped", async () => {
    const link = await opened({ history_page: null });
    const opening = link.workspace.openSegment(2);
    await settle();
    link.named("history_page")[0]?.reply(page([message("c")], 2));
    await opening;
    const failing = link.workspace.loadEarlierInSegment();
    await settle();
    link.named("history_page")[1]?.fail("page lost");
    expect(await failing.then(() => "", (error: unknown) => (error as Error).message)).toBe("page lost");
    const again = link.workspace.loadEarlierInSegment();
    await settle();
    expect(link.named("history_page")).toHaveLength(3);
    link.workspace.closeSegment();
    link.named("history_page")[2]?.reply(page([message("a")], 2));
    await again;
    expect(link.state().segmentView).toBeNull();
    const reopened = link.workspace.openSegment(2);
    await settle();
    link.named("history_page")[3]?.reply(page([message("c")], 2));
    await reopened;
    const stale = link.workspace.loadEarlierInSegment();
    await settle();
    const reopenedAgain = link.workspace.openSegment(2);
    await settle();
    link.named("history_page")[5]?.reply(page([message("z")], 2));
    await reopenedAgain;
    link.named("history_page")[4]?.reply(page([message("a")], 2));
    await stale;
    expect(link.state().segmentView?.messages).toEqual([message("z")]);
  });
});

describe("work that outlives its conversation", () => {
  test("a segment page that arrives after the conversation changed or the user signed out is dropped", async () => {
    for (const leave of [(link: ReturnType<typeof rig>) => { link.frame(history({ revision: 2, selected_thread: "side" })); }, (link: ReturnType<typeof rig>) => { link.setStatus("signed_out"); }]) {
      const link = await opened({ history_page: null });
      const opening = link.workspace.openSegment(2);
      await settle();
      leave(link);
      link.named("history_page")[0]?.reply(page([message("old")], 2));
      await opening;
      expect(link.state().segmentView).toBeNull();
    }
  });

  test("catalogues and thread listings asked for before the connection dropped are not used", async () => {
    const link = await opened({ discover_operations: null, list_characters: null, list_threads: null });
    const refreshing = link.workspace.refreshNavigation();
    await settle();
    link.setStatus("reconnecting");
    link.named("discover_operations").at(-1)?.reply({ operations: [descriptor("stale", [])], requests: [] });
    link.named("list_characters").at(-1)?.reply({ characters: [{ name: "stale" }] });
    link.named("list_threads").at(-1)?.reply(listing([thread("stale")]));
    await refreshing;
    expect(link.state()).toMatchObject({ operations: [], characters: [], threads: [] });
  });
});
