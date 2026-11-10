import { describe, expect, test } from "bun:test";

import { SyncState } from "../src/browser/sync.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";

const history = (revision: number, extra: Record<string, unknown> = {}) => ({ type: "history", messages: [], config: {}, revision, selected_character: "ada", selected_thread: "main", ...extra }) as ServerMessage;
const delta = (revision: number, base: number, extra: Record<string, unknown> = {}) => history(revision, { delta: { base_revision: base, after: null }, ...extra });
const arrived = (revision: number, extra: Record<string, unknown> = {}) => ({ type: "new_message", revision, character: "ada", thread: "main", msg_id: "m", role: "user", content: "", images: [], content_blocks: [], timestamp: "2026-11-10T00:00:00Z", ...extra }) as ServerMessage;

describe("keeping a browser's conversation in step with the daemon", () => {
  test("starts from the conversation and revision it is given, and hands out copies of where it is", () => {
    const fresh = new SyncState();
    expect(fresh.snapshot).toEqual({ character: null, thread: null, messageRevision: 0, snapshotRevision: 0 });
    const state = new SyncState(4, "ada", "main");
    const snapshot = state.snapshot;
    Object.assign(snapshot, { messageRevision: 99 });
    expect(state.snapshot).toEqual({ character: "ada", thread: "main", messageRevision: 4, snapshotRevision: 4 });
    expect(state.latestRevision).toBe(4);
    expect(state.observe(arrived(7))).toBe("deliver");
    expect(state.latestRevision).toBe(7);
    expect(state.observe(delta(9, 4))).toBe("deliver");
    expect(state.latestRevision).toBe(9);
  });

  test("a whole conversation is taken unless it is older than the one shown", () => {
    const state = new SyncState(5, "ada", "main");
    expect(state.observe(history(4))).toBe("drop_stale");
    expect(state.observe(history(5))).toBe("deliver");
    expect(state.observe(history(6))).toBe("deliver");
    expect(state.snapshot).toEqual({ character: "ada", thread: "main", messageRevision: 5, snapshotRevision: 6 });
    expect(state.observe(history(2, { selected_thread: null })), "no thread named is the one shown").toBe("drop_stale");
  });

  test("a whole conversation for another character or thread starts over from its revision", () => {
    const state = new SyncState(5, "ada", "main");
    expect(state.observe(history(2, { selected_character: "bo" }))).toBe("deliver");
    expect(state.snapshot).toEqual({ character: "bo", thread: "main", messageRevision: 2, snapshotRevision: 2 });
    expect(state.observe(history(1, { selected_character: "bo", selected_thread: "side" }))).toBe("deliver");
    expect(state.snapshot).toEqual({ character: "bo", thread: "side", messageRevision: 1, snapshotRevision: 1 });
    expect(state.observe(history(1, { selected_character: null, selected_thread: null }))).toBe("deliver");
    expect(state.snapshot).toEqual({ character: null, thread: null, messageRevision: 1, snapshotRevision: 1 });
  });

  test("a change is taken only for the conversation shown, newer than it, and built on the revision shown", () => {
    const state = new SyncState(5, "ada", null);
    expect(state.observe(delta(6, 5, { selected_character: "bo" }))).toBe("drop_stale");
    expect(state.observe(delta(6, 5, { selected_thread: "side" }))).toBe("drop_stale");
    expect(state.observe(delta(5, 5))).toBe("drop_stale");
    expect(state.observe(delta(7, 6))).toBe("resync");
    expect(state.observe(delta(6, 5))).toBe("deliver");
    expect(state.observe(delta(7, 6, { selected_thread: null }))).toBe("deliver");
    expect(state.snapshot).toEqual({ character: "ada", thread: null, messageRevision: 5, snapshotRevision: 7 });
  });

  test("a new message is taken only for the conversation shown and only once", () => {
    const state = new SyncState(5, "ada", "side");
    expect(state.observe(arrived(6, { character: "bo", thread: "side" }))).toBe("drop_stale");
    expect(state.observe(arrived(6, { character: null, thread: "side" }))).toBe("drop_stale");
    expect(state.observe(arrived(6, { thread: "main" }))).toBe("drop_stale");
    expect(state.observe(arrived(6, { thread: null }))).toBe("drop_stale");
    expect(state.observe(arrived(5, { thread: "side" }))).toBe("drop_stale");
    expect(state.observe(arrived(6, { thread: "side" }))).toBe("deliver");
    expect(state.snapshot).toEqual({ character: "ada", thread: "side", messageRevision: 6, snapshotRevision: 5 });
    const main = new SyncState(1, null, null);
    expect(main.observe(arrived(2, { character: undefined, thread: undefined }))).toBe("deliver");
    expect(main.observe(arrived(3, { character: null, thread: "main" }))).toBe("deliver");
  });

  test("every other frame is passed on", () => {
    const state = new SyncState(5, "ada", "main");
    for (const type of ["hello", "shutdown", "ping", "command_output", "error", "stream_start", "stream_chunk", "stream_end", "phase", "tool_call", "tool_result", "send_image", "cache_warning", "provider_warning", "provider_fallback_warning", "threads_changed", "thread_unread", "usage_warning", "plan_limit_warning", "config_warning", "request_accepted", "request_finished"]) {
      expect(state.observe({ type } as ServerMessage), type).toBe("deliver");
    }
    expect(state.snapshot).toEqual({ character: "ada", thread: "main", messageRevision: 5, snapshotRevision: 5 });
  });
});
