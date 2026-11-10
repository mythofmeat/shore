import { describe, expect, test } from "bun:test";

import type { BrowserConnection, BrowserRequest, ConnectionUpdate } from "../src/browser/connection.ts";
import { ConversationRequests } from "../src/browser/chat/requests.ts";
import { checkAttachments, conversationRequest, imageUpload, remainingMessageOptions, restoredDraft } from "../src/browser/request_forms.ts";
import type { ImageUpload } from "../src/protocol/ImageUpload.ts";
import type { RequestFinished } from "../src/protocol/RequestFinished.ts";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_FILENAME_BYTES, MAX_MIME_TYPE_BYTES, MAX_TOTAL_ATTACHMENT_BYTES } from "../src/swp/limits.ts";

function image(bytes: number, filename = "a.png"): ImageUpload {
  const encoded = "A".repeat(Math.ceil(bytes / 3) * 4);
  const padding = (3 - (bytes % 3)) % 3;
  return { filename, mime_type: "image/png", data: padding === 0 ? encoded : `${encoded.slice(0, -padding)}${"=".repeat(padding)}` };
}

describe("conversation requests", () => {
  test("are checked against the protocol before they go", () => {
    expect(conversationRequest("message", { text: "hi", stream: true, images: [] })).toEqual({ type: "message", text: "hi", stream: true, images: [] });
    expect(conversationRequest("regen", { stream: false, guidance: "shorter" })).toEqual({ type: "regen", stream: false, guidance: "shorter" });
    expect(() => conversationRequest("message", { text: 3, stream: true, images: [] })).toThrow("Check the conversation request fields before sending.");
    expect(() => conversationRequest("regen", { stream: "yes" })).toThrow("Check the conversation request fields before sending.");
  });

  test("keep the options a user changed for the next message, and always the stream switch", () => {
    expect(remainingMessageOptions({ stream: true, absence_seconds: 30, model: "opus" }, { stream: true, absence_seconds: 30, model: "sonnet" })).toEqual({ stream: true, model: "opus" });
    expect(imageUpload({ name: "cat.png", type: "image/png" }, "iVBOR")).toEqual({ filename: "cat.png", data: "iVBOR", mime_type: "image/png" });
  });
});

describe("attachments", () => {
  test("are refused past the count, the name and type length, the size of one, or the size of all", () => {
    expect(() => checkAttachments([image(10)])).not.toThrow();
    expect(() => checkAttachments(Array.from({ length: MAX_ATTACHMENTS + 1 }, () => image(1)))).toThrow(`Attach at most ${String(MAX_ATTACHMENTS)} images`);
    expect(() => checkAttachments(Array.from({ length: MAX_ATTACHMENTS }, () => image(1)))).not.toThrow();
    expect(() => checkAttachments([image(1, "a".repeat(MAX_FILENAME_BYTES + 1))])).toThrow("Image filename or media type is too long");
    expect(() => checkAttachments([image(1, "a".repeat(MAX_FILENAME_BYTES))]), "a name exactly at the limit").not.toThrow();
    expect(() => checkAttachments([{ ...image(1), mime_type: "x".repeat(MAX_MIME_TYPE_BYTES) }]), "a type exactly at the limit").not.toThrow();
    expect(() => checkAttachments([image(1, "é".repeat(MAX_FILENAME_BYTES / 2 + 1))])).toThrow("Image filename or media type is too long");
    expect(() => checkAttachments([{ ...image(1), mime_type: "x".repeat(MAX_MIME_TYPE_BYTES + 1) }])).toThrow("Image filename or media type is too long");
    expect(() => checkAttachments([{ filename: "a.png", data: "AAAA" }])).not.toThrow();
    expect(() => checkAttachments([image(MAX_ATTACHMENT_BYTES)])).not.toThrow();
    expect(() => checkAttachments([image(MAX_ATTACHMENT_BYTES + 1)])).toThrow("Choose images no larger than 5 MiB");
    expect(() => checkAttachments([image(MAX_ATTACHMENT_BYTES), image(MAX_ATTACHMENT_BYTES), image(MAX_ATTACHMENT_BYTES), image(MAX_ATTACHMENT_BYTES)])).not.toThrow();
    expect(() => checkAttachments([image(MAX_ATTACHMENT_BYTES), image(MAX_ATTACHMENT_BYTES), image(MAX_ATTACHMENT_BYTES), image(MAX_ATTACHMENT_BYTES), image(1)])).toThrow("Attachments exceed 20 MiB");
  });

  test("of a message put back join the draft's own, as many as fit, sent ones first", () => {
    const sent = { text: "sent words", images: [image(MAX_ATTACHMENT_BYTES, "s1"), image(MAX_ATTACHMENT_BYTES, "s2")] };
    const current = { text: "draft words", images: [image(MAX_ATTACHMENT_BYTES, "d1"), image(MAX_ATTACHMENT_BYTES, "d2"), image(1, "d3")], extra: 7 };
    const restored = restoredDraft(sent, current);
    expect(restored.content.text).toBe("sent words\n\ndraft words");
    expect(restored.content.images.map((item) => item.filename)).toEqual(["s1", "s2", "d1", "d2"]);
    expect(restored.dropped).toBe(1);
    expect(restored.content.extra).toBe(7);
    expect(restoredDraft({ text: "", images: [] }, { text: "draft", images: [] }).content.text).toBe("draft");
    expect(restoredDraft({ text: "sent", images: [] }, { text: "", images: [] }).content.text).toBe("sent");
    const many = Array.from({ length: MAX_ATTACHMENTS + 2 }, (_, index) => image(1, `i${String(index)}`));
    expect(restoredDraft({ text: "", images: many }, { text: "", images: [] }).dropped).toBe(2);
    expect(MAX_TOTAL_ATTACHMENT_BYTES).toBe(4 * MAX_ATTACHMENT_BYTES);
  });
});

function connection() {
  const selection: { character: string | null; thread: string | null } = { character: "ada", thread: "main" };
  const listeners = new Set<(update: ConnectionUpdate) => void>();
  const submitted: { request: BrowserRequest; rid: string }[] = [];
  const finishes = new Map<string, (result: RequestFinished) => void>();
  let cancels = 0;
  let next = 0;
  const fake = {
    selection,
    subscribe: (listener: (update: ConnectionUpdate) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    submit: (request: BrowserRequest, chosen?: string) => {
      const rid = chosen ?? `r_${String(next += 1)}`;
      submitted.push({ request, rid });
      const finished = new Promise<RequestFinished>((resolve) => { finishes.set(rid, resolve); });
      return { rid, finished };
    },
    cancel: () => { cancels += 1; },
  };
  const frame = (message: Record<string, unknown>) => { for (const listener of listeners) listener({ kind: "frame", message } as ConnectionUpdate); };
  const status = () => { for (const listener of listeners) listener({ kind: "status", status: "ready", detail: "" }); };
  const finish = async (rid: string, outcome: RequestFinished["outcome"] = "completed", error?: string) => {
    finishes.get(rid)?.({ rid, outcome, ...(error === undefined ? {} : { error: { code: "provider_error", message: error } }) });
    await Bun.sleep(0);
  };
  return { fake: fake as unknown as BrowserConnection, submitted, frame, status, finish, selection, cancels: () => cancels };
}

describe("a conversation's requests in flight", () => {
  test("are active from sending until they finish, in the conversation they were sent from", async () => {
    const link = connection();
    const requests = new ConversationRequests(link.fake);
    let heard = 0;
    const stop = requests.subscribe(() => { heard += 1; });
    const sending = requests.submit("message", { text: "hi", stream: true, images: [] }, { rid: "chosen" });
    expect(link.submitted).toEqual([{ request: { type: "message", text: "hi", stream: true, images: [] }, rid: "chosen" }]);
    expect([...requests.getSnapshot()]).toEqual(["chosen"]);
    link.selection.thread = "story";
    expect(requests.activeIn({ character: "ada", thread: "main" })).toBe(true);
    expect(requests.activeIn({ character: "ada", thread: "story" }), "scoped to where it was sent").toBe(false);
    expect(requests.awaitingStream()).toBe("chosen");
    await link.finish("chosen");
    expect(await sending).toEqual({ rid: "chosen", outcome: "completed" });
    expect(requests.getSnapshot().size).toBe(0);
    expect(requests.activeIn({ character: "ada", thread: "main" })).toBe(false);
    expect(heard).toBe(2);
    stop();
  });

  test("stop waiting for a stream once their own main reply starts streaming", () => {
    const link = connection();
    const requests = new ConversationRequests(link.fake);
    void requests.submit("message", { text: "hi", stream: true, images: [] });
    let heard = 0;
    const stop = requests.subscribe(() => { heard += 1; });
    link.frame({ type: "stream_chunk", rid: "r_1", subagent: "memory", text: "x" });
    link.frame({ type: "stream_chunk", rid: "someone-else", text: "x" });
    link.frame({ type: "stream_chunk", text: "no rid" });
    link.frame({ type: "phase", rid: "r_1", phase: "thinking" });
    expect(requests.awaitingStream({ character: "ada", thread: "main" })).toBe("r_1");
    expect(heard).toBe(0);
    link.frame({ type: "stream_start", rid: "r_1" });
    expect(requests.awaitingStream()).toBeUndefined();
    link.frame({ type: "stream_end", rid: "r_1" });
    expect(heard, "started once").toBe(1);
    for (const type of ["stream_chunk", "stream_end"]) {
      const other = connection();
      const tracked = new ConversationRequests(other.fake);
      void tracked.submit("message", { text: "hi", stream: true, images: [] });
      other.frame({ type, rid: "r_1", text: "x", content: "x" });
      expect(tracked.awaitingStream(), type).toBeUndefined();
    }
    stop();
  });

  test("tell their sender when the daemon accepts them, once", () => {
    const link = connection();
    const requests = new ConversationRequests(link.fake);
    let accepted = 0;
    void requests.submit("message", { text: "hi", stream: true, images: [] }, { accepted: () => { accepted += 1; } });
    link.frame({ type: "request_accepted", rid: "elsewhere" });
    link.frame({ type: "request_accepted", rid: "r_1" });
    link.frame({ type: "request_accepted", rid: "r_1" });
    expect(accepted).toBe(1);
    expect(requests.getSnapshot().has("r_1"), "accepted is not finished").toBe(true);
  });

  test("forget everything about a request once it finishes, so its id can be used again", async () => {
    const link = connection();
    const requests = new ConversationRequests(link.fake);
    let accepted = 0;
    const first = requests.submit("message", { text: "hi", stream: true, images: [] }, { rid: "again", accepted: () => { accepted += 1; } });
    link.frame({ type: "stream_start", rid: "again" });
    expect(requests.awaitingStream()).toBeUndefined();
    await link.finish("again", "failed");
    await first;
    link.frame({ type: "request_accepted", rid: "again" });
    expect(accepted, "a finished request is not accepted late").toBe(0);
    void requests.submit("message", { text: "hi", stream: true, images: [] }, { rid: "again" });
    expect(requests.awaitingStream(), "the new request has not started").toBe("again");
  });

  test("ignore the connection's own news, and stop telling a listener that left", async () => {
    const link = connection();
    const requests = new ConversationRequests(link.fake);
    let heard = 0;
    const stop = requests.subscribe(() => { heard += 1; });
    expect(() => { link.status(); }).not.toThrow();
    stop();
    const sending = requests.submit("message", { text: "hi", stream: true, images: [] });
    await link.finish("r_1");
    await sending;
    expect(heard).toBe(0);
  });

  test("regenerations are listed until they finish, and pending until their stream starts", async () => {
    const link = connection();
    const requests = new ConversationRequests(link.fake);
    const regenerating = requests.regenerate("  shorter please  ", false);
    expect(link.submitted.at(-1)?.request).toEqual({ type: "regen", stream: false, guidance: "shorter please" });
    expect(requests.regens()).toEqual(["r_1"]);
    expect(requests.pendingRegens({ character: "ada", thread: "main" })).toEqual(["r_1"]);
    expect(requests.regens({ character: "bo", thread: "main" })).toEqual([]);
    link.frame({ type: "stream_start", rid: "r_1" });
    expect(requests.pendingRegens()).toEqual([]);
    await link.finish("r_1");
    await regenerating;
    expect(requests.regens()).toEqual([]);
    void requests.regenerate("   ");
    expect(link.submitted.at(-1)?.request, "blank guidance is no guidance").toEqual({ type: "regen", stream: true });
  });

  test("a regeneration that does not complete says why", async () => {
    const outcomes: [RequestFinished["outcome"], string | undefined, string][] = [
      ["failed", "the provider is down", "the provider is down"],
      ["cancelled", undefined, "Regeneration stopped"],
      ["superseded", undefined, "Regeneration superseded"],
      ["failed", undefined, "Regeneration failed"],
    ];
    for (const [outcome, error, said] of outcomes) {
      const link = connection();
      const requests = new ConversationRequests(link.fake);
      const regenerating = requests.regenerate().then(() => "", (problem: unknown) => String(problem));
      await link.finish("r_1", outcome, error);
      expect(await regenerating).toBe(`Error: ${said}`);
    }
    const link = connection();
    new ConversationRequests(link.fake).cancel();
    expect(link.cancels()).toBe(1);
  });
});
