import { expect, test } from "bun:test";
import { BrowserConnection, type ConnectionUpdate } from "../src/browser/connection.ts";
import { Workspace, type LiveTurn } from "../src/browser/workspace.ts";
import { conversationImages, imageFilename, MAX_LIVE_IMAGES, mediaSource } from "../src/browser/media.ts";
import { WEB_CONTRACT, WEB_PROTOCOL } from "../src/web/contract.ts";
import type { Message } from "../src/protocol/Message.ts";
import type { ContentBlock } from "../src/protocol/ContentBlock.ts";

const png = "iVBORw0K";
const message = (id: string): Message => ({ msg_id: id, role: "assistant", content: "", images: [], content_blocks: [], timestamp: "" });
const block: ContentBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: png + "bmVzdGVk" } };
class Connection extends BrowserConnection {
  listeners = new Set<(update: ConnectionUpdate) => void>();
  override subscribe(listener: (update: ConnectionUpdate) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  emit(update: ConnectionUpdate) { for (const listener of this.listeners) listener(update); }
}
function fixture() {
  const connection = new Connection({ origin: "http://localhost", contract: WEB_CONTRACT, protocol: WEB_PROTOCOL });
  const workspace = new Workspace(connection);
  const history = (messages: Message[], character = "nova", thread = "main") => connection.emit({ kind: "frame", message: { type: "history", selected_character: character, selected_thread: thread, config: {}, revision: 1, messages } });
  const image = (path: string, data: string | null = png, rid?: string) => connection.emit({ kind: "frame", message: { type: "send_image", path, caption: path, data, ...(rid === undefined ? {} : { rid }) } });
  history([]);
  return { connection, workspace, history, image };
}

test("image sources allow raster data only and download names cannot escape their filename", () => {
  expect(mediaSource(png)).toBe(`data:image/png;base64,${png}`);
  expect(mediaSource("/9j/AA==")).toBe("data:image/jpeg;base64,/9j/AA==");
  expect(mediaSource("R0lGODAA")).toContain("image/gif");
  expect(mediaSource("UklGR123")).toContain("image/webp");
  for (const data of [null, undefined, "", "<script>", "https://host/image.png"]) expect(mediaSource(data)).toBeUndefined();
  for (const mime of ["image/svg+xml", "text/html", "image/png;url=evil"]) expect(mediaSource(png, mime)).toBeUndefined();
  expect(imageFilename("../private\\secret\u0000.svg", `data:image/png;base64,${png}`)).toBe(".._private_secret_.svg.png");
  expect(imageFilename("photo.jpg", "data:image/jpeg;base64,/9j/")).toBe("photo.jpg");
  expect(imageFilename("", "data:image/webp;base64,UklGR")).toBe("shore-image.webp");
  expect(imageFilename("a".repeat(1000), `data:image/png;base64,${png}`).length).toBe(184);
});

test("gallery includes attachment captions, nested tool images and live media without repeating reconciled sources", () => {
  const stored = { ...message("one"), images: [{ path: "C:\\pictures\\first.png", data: png }, { path: "missing.png", caption: "Unavailable picture" }], content_blocks: [{ type: "tool_result" as const, tool_use_id: "tool", content: [block] }] };
  const stream: LiveTurn = { key: "live", rid: "live", subagent: "worker", text: "", reasoning: "", blocks: [block], final: false, msgId: null, metadata: null };
  const entries = conversationImages([stored], [stream, { ...stream, key: "finished", final: true, msgId: "one" }], [{ path: "C:\\pictures\\first.png", data: png }, { path: "live.png", caption: "Tool picture", data: png }]);
  expect(entries.map((item) => item.caption)).toEqual(["first.png", "Unavailable picture", "Inline image", "Inline image", "Tool picture"]);
  expect(entries[1]?.data).toBeUndefined();
  expect(new Set(entries.map((item) => item.id)).size).toBe(entries.length);
  expect(entries[2]?.mime).toBe("image/png");
});

test("live image bytes move into history, survive byte-free reconciliation and do not reappear after deletion", () => {
  const { workspace, connection, history, image } = fixture();
  image("live.png"); image("live.png", null);
  expect(workspace.getSnapshot().media).toHaveLength(1);
  expect(workspace.getSnapshot().media[0]?.data).toBe(png);
  const stored = { ...message("result"), images: [{ path: "live.png" }] };
  connection.emit({ kind: "frame", message: { ...stored, type: "new_message", revision: 1 } });
  expect(workspace.getSnapshot().messages[0]?.images[0]?.data).toBe(png);
  expect(workspace.getSnapshot().media).toHaveLength(0);
  history([stored]);
  expect(workspace.getSnapshot().messages[0]?.images[0]?.data).toBe(png);
  history([]);
  expect(conversationImages(workspace.getSnapshot().messages, [], workspace.getSnapshot().media)).toHaveLength(0);
  image("other.png"); history([{ ...message("another"), images: [{ path: "other.png" }] }]);
  expect(workspace.getSnapshot().messages[0]?.images[0]?.data).toBe(png);
  expect(workspace.getSnapshot().media).toHaveLength(0);
});

test("tool result images recover missing media events and equivalent inline copies keep named captions", () => {
  const { connection, workspace, image } = fixture();
  connection.emit({ kind: "frame", message: { type: "tool_result", rid: "run", tool_id: "read", tool_name: "read", output: "Read picture", images: [{ path: "picture.png", caption: "Tool picture", data: png }], is_error: false } });
  expect(workspace.getSnapshot().media[0]?.data).toBe(png);
  image("original.png", png + "b3JpZw==", "run");
  connection.emit({ kind: "frame", message: { type: "tool_result", rid: "run", tool_id: "read", tool_name: "read", output: "Read scaled picture", images: [{ path: "original.png", data: png }], is_error: false } });
  expect(workspace.getSnapshot().media.find((item) => item.path === "original.png")?.data).toBe(png + "b3JpZw==");
  const stored = { ...message("picture"), images: [{ path: "first.png", caption: "First copy", data: png }, { path: "second.png", caption: "Second copy", data: png }], content_blocks: [{ type: "image" as const, source: { type: "base64" as const, media_type: "image/png", data: png } }] };
  expect(conversationImages([stored], [], []).map((item) => item.caption)).toEqual(["First copy", "Second copy"]);
});

test("tool images follow their canonical message through edits, deletion and reused tool IDs", () => {
  const { connection, workspace, image, history } = fixture();
  const stored = (id: string, data = png): Message => ({ ...message(id), content_blocks: [{ type: "tool_result", tool_use_id: "read", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }] }] });
  history([stored("old")]);
  const emit = (rid: string) => {
    image("picture.png", png + "b3JpZw==", rid);
    connection.emit({ kind: "frame", message: { type: "tool_result", rid, tool_id: "read", tool_name: "read", output: "Read picture", images: [{ path: "picture.png", data: png }], is_error: false } });
  };
  emit("first");
  history([stored("old")]);
  expect(workspace.getSnapshot().media[0]?.messageId).toBeUndefined();
  connection.emit({ kind: "frame", message: { ...stored("new"), type: "new_message", revision: 2 } });
  expect(workspace.getSnapshot().media[0]?.messageId).toBe("new");
  history([stored("old"), stored("new")]);
  expect(workspace.getSnapshot().media[0]?.data).toBe(png + "b3JpZw==");
  history([stored("old"), stored("new", png + "YWx0")]);
  expect(workspace.getSnapshot().media).toHaveLength(0);
  emit("second");
  history([stored("old"), stored("new", png + "YWx0"), stored("second")]);
  expect(workspace.getSnapshot().media[0]?.messageId).toBe("second");
  history([stored("old")]);
  expect(workspace.getSnapshot().media).toHaveLength(0);
  emit("third");
  history([stored("old"), stored("third")]);
  emit("fourth");
  expect(workspace.getSnapshot().media[0]?.messageId).toBeUndefined();
  history([stored("old"), stored("third"), stored("fourth")]);
  expect(workspace.getSnapshot().media[0]?.messageId).toBe("fourth");
});

test("live image retention is bounded and conversation changes and sign-out clear private bytes", () => {
  const { connection, workspace, image, history } = fixture();
  for (let index = 0; index <= MAX_LIVE_IMAGES; index++) image(`image-${String(index)}.png`);
  expect(workspace.getSnapshot().media).toHaveLength(MAX_LIVE_IMAGES);
  expect(workspace.getSnapshot().media[0]?.path).toBe("image-1.png");
  history([{ ...message("other"), images: [{ path: `image-${String(MAX_LIVE_IMAGES)}.png` }] }], "other");
  expect(workspace.getSnapshot().media).toHaveLength(0);
  expect(workspace.getSnapshot().messages[0]?.images[0]?.data).toBeUndefined();
  image("thread.png"); history([], "other", "branch");
  expect(workspace.getSnapshot().media).toHaveLength(0);
  image("private.png"); connection.emit({ kind: "status", status: "signed_out", detail: "" });
  expect(workspace.getSnapshot().media).toHaveLength(0);
  expect(workspace.getSnapshot().messages).toHaveLength(0);
});
