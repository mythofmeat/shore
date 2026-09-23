import { expect, test } from "bun:test";
import { checkAttachments, conversationRequest, imageUpload, remainingMessageOptions } from "../src/browser/request_forms.ts";
import { coreRequests, requestCatalogue } from "../src/operations/requests.ts";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_TOTAL_ATTACHMENT_BYTES } from "../src/swp/limits.ts";

const upload = (size: number) => ({ filename: "image.png", data: Buffer.alloc(size).toString("base64"), mime_type: "image/png" });

test("conversation payloads use canonical validation and registry execution preserves every field", () => {
  const message = conversationRequest("message", { text: "hello", stream: false, images: ["/host/photo.png"], image_data: [upload(3)], absence_seconds: 120 });
  expect(coreRequests.message.invoke({ ...message, rid: "message-1" })).toEqual({ kind: "generation", regen: false, body: { rid: "message-1", text: "hello", stream: false, images: ["/host/photo.png"], image_data: [upload(3)], absence_seconds: 120 } });
  expect(coreRequests.regen.invoke(conversationRequest("regen", { stream: false, guidance: "take another approach" }))).toEqual({ kind: "generation", regen: true, body: { rid: null, stream: false, text: "", images: [], image_data: [], guidance: "take another approach" } });
  expect(coreRequests.regen.invoke({ type: "regen", stream: true })).toEqual({ kind: "generation", regen: true, body: { rid: null, stream: true, text: "", images: [], image_data: [] } });
  expect(coreRequests.cancel.invoke({ type: "cancel" })).toEqual({ kind: "cancel" });
  expect(() => coreRequests.cancel.invoke(message)).toThrow("Wrong request handler");
  for (const absence_seconds of [-1, 1.2, Number.NaN, Infinity, "120"]) expect(() => conversationRequest("message", { text: "hello", stream: true, images: [], absence_seconds })).toThrow("Check the conversation request fields");
  expect(() => conversationRequest("regen", { stream: "false" })).toThrow("Check the conversation request fields");
  expect(requestCatalogue(false).filter((request) => request.available).map((request) => request.name)).toEqual(["cancel"]);
});

test("image picker limits match admission, including decoded bytes, count and UTF-8 names", () => {
  expect(() => checkAttachments([upload(MAX_ATTACHMENT_BYTES)])).not.toThrow();
  expect(() => checkAttachments([upload(MAX_ATTACHMENT_BYTES + 1)])).toThrow("5 MiB");
  expect(() => checkAttachments(Array.from({ length: MAX_ATTACHMENTS }, () => upload(1)))).not.toThrow();
  expect(() => checkAttachments(Array.from({ length: MAX_ATTACHMENTS + 1 }, () => upload(1)))).toThrow("at most 16");
  const maximum = Array.from({ length: MAX_TOTAL_ATTACHMENT_BYTES / MAX_ATTACHMENT_BYTES }, () => upload(MAX_ATTACHMENT_BYTES));
  expect(() => checkAttachments(maximum)).not.toThrow();
  expect(() => checkAttachments([...maximum, upload(1)])).toThrow("20 MiB");
  expect(() => checkAttachments([{ ...upload(1), filename: "é".repeat(128) }])).toThrow("too long");
  expect(() => checkAttachments([{ ...upload(1), mime_type: "x".repeat(256) }])).toThrow("too long");
});


test("completed sends clear each unchanged one-shot option and preserve concurrent edits and streaming preference", () => {
  const images = ["original.png"];
  const submitted = { stream: true, images, absence_seconds: 60 };
  expect(remainingMessageOptions(submitted, submitted)).toEqual({ stream: true });
  expect(remainingMessageOptions({ ...submitted, stream: false }, submitted)).toEqual({ stream: false });
  expect(remainingMessageOptions({ ...submitted, absence_seconds: 120 }, submitted)).toEqual({ stream: true, absence_seconds: 120 });
  expect(remainingMessageOptions({ ...submitted, images: ["next.png"] }, submitted)).toEqual({ stream: true, images: ["next.png"] });
  expect(remainingMessageOptions({}, submitted)).toEqual({});
  expect(imageUpload({ name: "photo.png", type: "image/png" }, "YWJj")).toEqual({ filename: "photo.png", mime_type: "image/png", data: "YWJj" });
});
