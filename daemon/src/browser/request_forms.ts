import type { ClientMessage } from "../protocol/ClientMessage.ts";
import type { ImageUpload } from "../protocol/ImageUpload.ts";
import { validClientMessage } from "./validators.generated.js";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_TOTAL_ATTACHMENT_BYTES, MAX_FILENAME_BYTES, MAX_MIME_TYPE_BYTES } from "../swp/limits.ts";

export function conversationRequest<N extends "message" | "regen">(name: N, values: Record<string, unknown>): Extract<ClientMessage, { type: N }> {
  const request = { ...values, type: name };
  if (!validClientMessage(request) || request.type !== name) throw new Error("Check the conversation request fields before sending.");
  return request as Extract<ClientMessage, { type: N }>;
}

export function imageUpload(file: Pick<File, "name" | "type">, data: string): Required<ImageUpload> {
  return { filename: file.name, data, mime_type: file.type };
}

export function remainingMessageOptions(current: Record<string, unknown>, submitted: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(current).filter(([key, value]) => key === "stream" || value !== submitted[key]));
}

const attachmentBytes = (image: ImageUpload): number => image.data.length * 3 / 4 - (image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0);

export function fitAttachments(images: readonly ImageUpload[]): { kept: ImageUpload[]; dropped: number } {
  const kept: ImageUpload[] = [];
  let total = 0;
  for (const image of images) {
    const bytes = attachmentBytes(image);
    if (kept.length >= MAX_ATTACHMENTS || total + bytes > MAX_TOTAL_ATTACHMENT_BYTES) continue;
    kept.push(image);
    total += bytes;
  }
  return { kept, dropped: images.length - kept.length };
}

export function restoredDraft<T extends { text: string; images: ImageUpload[] }>(sent: { text: string; images: readonly ImageUpload[] }, current: T): { content: T; dropped: number } {
  const { kept, dropped } = fitAttachments([...sent.images, ...current.images]);
  return { content: { ...current, text: [sent.text, current.text].filter((part) => part !== "").join("\n\n"), images: kept }, dropped };
}

export function checkAttachments(images: readonly ImageUpload[]): void {
  if (images.length > MAX_ATTACHMENTS) throw new Error(`Attach at most ${MAX_ATTACHMENTS} images`);
  let total = 0;
  const encoder = new TextEncoder();
  for (const image of images) {
    if (encoder.encode(image.filename).length > MAX_FILENAME_BYTES || encoder.encode(image.mime_type ?? "").length > MAX_MIME_TYPE_BYTES) throw new Error("Image filename or media type is too long");
    const bytes = attachmentBytes(image);
    if (bytes > MAX_ATTACHMENT_BYTES) throw new Error(`Choose images no larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MiB`);
    total += bytes;
  }
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error(`Attachments exceed ${MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024} MiB`);
}
