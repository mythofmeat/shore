import { expect, test } from "bun:test";
import { BrowserConnection, type ConnectionUpdate } from "../src/browser/connection.ts";
import { Workspace } from "../src/browser/workspace.ts";
import { MAX_ACTIVITY_CHARS, MAX_LIVE_BLOCK_CHARS, MAX_LIVE_BLOCKS, MAX_LIVE_MEDIA_CHARS, MAX_LIVE_TEXT, recentText } from "../src/browser/live_limits.ts";
import { WEB_CONTRACT, WEB_PROTOCOL } from "../src/web/contract.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";

class Connection extends BrowserConnection {
  listeners = new Set<(update: ConnectionUpdate) => void>();
  override subscribe(listener: (update: ConnectionUpdate) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  emit(update: ConnectionUpdate) { for (const listener of this.listeners) listener(update); }
}
function fixture() {
  const connection = new Connection({ origin: "http://localhost", contract: WEB_CONTRACT, protocol: WEB_PROTOCOL });
  const workspace = new Workspace(connection);
  const frame = (message: ServerMessage) => connection.emit({ kind: "frame", message });
  frame({ type: "history", config: {}, revision: 1, selected_character: "nova", selected_thread: "main", messages: [] });
  return { connection, workspace, frame };
}

test("connection replacement retires main and subagent previews without discarding conversation history", () => {
  const { connection, workspace, frame } = fixture();
  const history = { type: "history", config: {}, revision: 2, selected_character: "nova", selected_thread: "main", messages: [
    { msg_id: "saved", role: "user", content: "Saved question", content_blocks: [], images: [], timestamp: "" },
  ] } satisfies ServerMessage;
  frame(history);
  frame({ type: "stream_start", rid: "main", regen: false });
  frame({ type: "stream_start", rid: "main", subagent: "worker", task_id: "task", regen: false });
  frame({ ...history, revision: 3 });
  expect(workspace.getSnapshot().streams).toHaveLength(2);
  connection.emit({ kind: "status", status: "reconnecting", detail: "Connection interrupted" });
  expect(workspace.getSnapshot().streams).toEqual([]);
  expect(workspace.getSnapshot().messages).toEqual(history.messages);
  frame({ ...history, revision: 3 });
  expect(workspace.getSnapshot().streams).toEqual([]);
  frame({ type: "stream_start", rid: "fresh", regen: false });
  expect(workspace.getSnapshot().streams).toHaveLength(1);
});

test("live text and reasoning retain bounded recent content without splitting a character; canonical results stay complete", () => {
  const { workspace, frame } = fixture();
  const long = "x".repeat(MAX_LIVE_TEXT) + "😀TAIL";
  for (const content_type of ["text", "thinking"] as const) {
    frame({ type: "stream_chunk", rid: "live", content_type, text: long });
    frame({ type: "stream_chunk", rid: "live", content_type, text: "LATEST" });
  }
  const stream = workspace.getSnapshot().streams[0];
  expect(stream?.text.length).toBeLessThanOrEqual(MAX_LIVE_TEXT);
  expect(stream?.reasoning.length).toBeLessThanOrEqual(MAX_LIVE_TEXT);
  expect(stream?.text).toEndWith("😀TAILLATEST");
  expect(stream?.reasoning).toEndWith("😀TAILLATEST");
  expect(stream?.round.text.length).toBeLessThanOrEqual(MAX_LIVE_TEXT);
  expect(stream?.round.reasoning.length).toBeLessThanOrEqual(MAX_LIVE_TEXT);
  expect(stream?.round.text).toEndWith("😀TAILLATEST");
  expect(stream?.round.reasoning).toEndWith("😀TAILLATEST");
  expect(stream?.previewLimited).toBe(true);
  expect(recentText("😀tail", 5)).toBe("tail");
  frame({ type: "stream_end", metadata: { model: "fixture", tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, timing: { total_ms: 0, ttft_ms: 0 } }, rid: "live", content: long, is_final: true, msg_id: "answer" });
  expect(workspace.getSnapshot().streams[0]?.text.length).toBeLessThanOrEqual(MAX_LIVE_TEXT);
  frame({ type: "new_message", revision: 2, msg_id: "answer", role: "assistant", content: long, content_blocks: [{ type: "text", text: long }], images: [], timestamp: "" });
  expect(workspace.getSnapshot().messages[0]?.content).toBe(long);
  expect(workspace.getSnapshot().messages[0]?.content_blocks).toEqual([{ type: "text", text: long }]);
});

test("tool previews have aggregate size and entry bounds and preserve recent progress", () => {
  const { workspace, frame } = fixture();
  for (let index = 0; index < MAX_LIVE_BLOCKS + 5; index++) frame({ type: "tool_result", rid: "run", tool_id: String(index), tool_name: "read", output: "a".repeat(16000), is_error: false });
  frame({ type: "tool_call", rid: "run", tool_id: "huge", tool_name: "read", input: { text: "a".repeat(MAX_LIVE_BLOCK_CHARS + 1) } });
  frame({ type: "tool_result", rid: "run", tool_id: "latest", tool_name: "read", output: "LATEST", is_error: false });
  const stream = workspace.getSnapshot().streams[0];
  expect(stream?.blocks.length).toBeLessThanOrEqual(MAX_LIVE_BLOCKS);
  expect(stream?.blocks.reduce((total, block) => total + JSON.stringify(block).length, 0)).toBeLessThanOrEqual(MAX_LIVE_BLOCK_CHARS);
  expect(stream?.blocks.at(-1)).toMatchObject({ content: "LATEST" });
  expect(stream?.previewLimited).toBe(true);
  frame({ type: "stream_end", metadata: { model: "fixture", tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, timing: { total_ms: 0, ttft_ms: 0 } }, rid: "run", content: "", is_final: true, terminal_content_blocks: [{ type: "text", text: "z".repeat(MAX_LIVE_BLOCK_CHARS + 1) }] });
  expect(workspace.getSnapshot().streams[0]?.blocks).toEqual([]);
});

test("large activity keeps request and subagent scope with an explicit bounded inspection preview", () => {
  const { connection, workspace, frame } = fixture();
  frame({ type: "tool_result", rid: "run", subagent: "worker", task_id: "task", tool_id: "read", tool_name: "read", output: "a".repeat(MAX_ACTIVITY_CHARS * 2) + "TAIL", is_error: false });
  const entry = workspace.getSnapshot().activity.at(-1);
  expect(entry?.data).toMatchObject({ rid: "run", subagent: "worker", task_id: "task", previewLimited: true });
  expect(JSON.stringify(entry?.data).length).toBeLessThan(MAX_ACTIVITY_CHARS + 1024);
  expect(JSON.stringify(entry?.data)).toContain("TAIL");
  for (let index = 0; index < 105; index++) connection.emit({ kind: "future", message: { type: "future", index, text: "x".repeat(MAX_ACTIVITY_CHARS * 2) } });
  expect(workspace.getSnapshot().activity).toHaveLength(100);
  expect(workspace.getSnapshot().activity.every((item) => JSON.stringify(item.data).length < MAX_ACTIVITY_CHARS + 1024)).toBe(true);
});

test("live originals obey an aggregate memory budget, retain newer images, and reset the notice at conversation and sign-in boundaries", () => {
  const { connection, workspace, frame } = fixture();
  const data = "iVBOR" + "A".repeat(1024 * 1024);
  for (let index = 0; index < 20; index++) frame({ type: "send_image", rid: "run", path: `image-${String(index)}.png`, data });
  const snapshot = workspace.getSnapshot();
  expect(snapshot.media.length).toBeLessThan(20);
  expect(snapshot.media.reduce((total, image) => total + Object.values(image).reduce<number>((sum, value) => sum + (typeof value === "string" ? value.length : 0), 0), 0)).toBeLessThanOrEqual(MAX_LIVE_MEDIA_CHARS);
  expect(snapshot.media.at(-1)?.path).toBe("image-19.png");
  expect(snapshot.media.at(-1)?.data).toBe(data);
  expect(snapshot.mediaLimited).toBe(true);
  frame({ type: "history", config: {}, revision: 2, selected_character: "nova", selected_thread: "other", messages: [] });
  expect(workspace.getSnapshot().mediaLimited).toBe(false);
  frame({ type: "tool_result", rid: "next", tool_id: "read", tool_name: "read", output: "large", is_error: false, images: [{ path: "huge.png", data: "A".repeat(MAX_LIVE_MEDIA_CHARS + 1) }] });
  expect(workspace.getSnapshot().media).toEqual([]);
  expect(workspace.getSnapshot().mediaLimited).toBe(true);
  connection.emit({ kind: "status", status: "signed_out", detail: "" });
  expect(workspace.getSnapshot().mediaLimited).toBe(false);
  expect(workspace.getSnapshot().activity).toEqual([]);
});
