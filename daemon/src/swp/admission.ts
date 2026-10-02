import type { ClientMessage } from "../protocol/ClientMessage";
import type { ImageUpload } from "../protocol/ImageUpload";
import { base64Rejection } from "../tools/images.ts";
import { base64Bytes } from "../util/base64.ts";

import { MAX_CAPABILITIES, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_TOTAL_ATTACHMENT_BYTES, MAX_TEXT_BYTES, MAX_CAPABILITY_BYTES, MAX_FILENAME_BYTES, MAX_MIME_TYPE_BYTES, MAX_IMAGE_PATH_BYTES } from "./limits.ts";
export { MAX_CAPABILITIES, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_TOTAL_ATTACHMENT_BYTES } from "./limits.ts";

export class AdmissionError extends Error {
  override readonly name = "AdmissionError";
}

export function sanitiseRid(rid: string | null | undefined): string | null {
  if (rid === undefined || rid === null) return null;
  for (const ch of rid) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x7f || code === 0) return null;
  }
  return rid;
}

export function admitCapabilities(value: unknown): string[] {
  const capabilities = stringArray(value, "capabilities", MAX_CAPABILITIES);
  for (const capability of capabilities) {
    byteLimit(capability, "capability", MAX_CAPABILITY_BYTES);
  }
  return capabilities;
}

export function admitClientMessage(value: unknown): ClientMessage {
  const raw = record(value, "request");
  switch (raw.type) {
    case "hello":
      return {
        type: "hello",
        client_type: stringField(raw, "client_type"),
        client_name: stringField(raw, "client_name"),
        capabilities: admitCapabilities(raw.capabilities),
        ...optionalString(raw, "character"),
        ...optionalString(raw, "thread"),
        ...optionalString(raw, "token"),
      };

    case "message": {
      const text = stringField(raw, "text");
      byteLimit(text, "message text", MAX_TEXT_BYTES);
      const images = stringArray(raw.images, "images", MAX_ATTACHMENTS);
      for (const image of images) byteLimit(image, "image path", MAX_IMAGE_PATH_BYTES);
      const imageData = uploadArray(raw.image_data);
      return {
        type: "message",
        ...optionalString(raw, "rid"),
        text,
        stream: booleanField(raw, "stream"),
        images,
        image_data: imageData,
        ...optionalFiniteNumber(raw, "absence_seconds"),
      };
    }

    case "regen": {
      const guidance = optionalStringValue(raw, "guidance");
      if (guidance !== undefined) byteLimit(guidance, "regeneration guidance", MAX_TEXT_BYTES);
      return {
        type: "regen",
        ...optionalString(raw, "rid"),
        stream: booleanField(raw, "stream"),
        ...(guidance === undefined ? {} : { guidance }),
      };
    }

    case "command":
      return {
        type: "command",
        ...optionalString(raw, "rid"),
        name: stringField(raw, "name"),
        args: raw.args === undefined ? null : raw.args,
      };

    case "cancel":
      return { type: "cancel" };

    default:
      throw new AdmissionError(`Unknown client message type ${JSON.stringify(raw.type)}`);
  }
}

function uploadArray(value: unknown): ImageUpload[] {
  if (!Array.isArray(value)) throw new AdmissionError('Request field "image_data" is not an array');
  if (value.length > MAX_ATTACHMENTS) {
    throw new AdmissionError(
      `Request has ${String(value.length)} attachments; the maximum is ${String(MAX_ATTACHMENTS)}`,
    );
  }

  let totalBytes = 0;
  return value.map((item, index) => {
    const upload = record(item, `attachment ${String(index + 1)}`);
    const filename = stringField(upload, "filename");
    byteLimit(filename, `attachment ${String(index + 1)} filename`, MAX_FILENAME_BYTES);
    if (filename.length === 0) {
      throw new AdmissionError(`Attachment ${String(index + 1)} has an empty filename`);
    }

    const data = stringField(upload, "data");
    const rejection = base64Rejection(data);
    if (rejection !== undefined) {
      throw new AdmissionError(`Attachment ${JSON.stringify(filename)} is not valid base64: ${rejection}`);
    }
    const bytes = base64Bytes(data);
    if (bytes > MAX_ATTACHMENT_BYTES) {
      throw new AdmissionError(
        `Attachment ${JSON.stringify(filename)} is ${String(bytes)} bytes; the maximum is ${String(MAX_ATTACHMENT_BYTES)}`,
      );
    }
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new AdmissionError(
        `Attachments total ${String(totalBytes)} bytes; the maximum is ${String(MAX_TOTAL_ATTACHMENT_BYTES)}`,
      );
    }

    const mimeType = optionalStringValue(upload, "mime_type");
    if (mimeType !== undefined) {
      byteLimit(mimeType, `attachment ${JSON.stringify(filename)} MIME type`, MAX_MIME_TYPE_BYTES);
    }
    return {
      filename,
      data,
      ...(mimeType === undefined ? {} : { mime_type: mimeType }),
    };
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AdmissionError(`${capitalize(label)} is not an object`);
  }
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, field: string, maximum: number): string[] {
  if (!Array.isArray(value)) {
    throw new AdmissionError(`Request field ${JSON.stringify(field)} is not an array`);
  }
  if (value.length > maximum) {
    throw new AdmissionError(
      `Request field ${JSON.stringify(field)} has ${String(value.length)} elements; the maximum is ${String(maximum)}`,
    );
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new AdmissionError(
        `Request field ${JSON.stringify(field)} element ${String(index + 1)} is not a string`,
      );
    }
    return item;
  });
}

function stringField(raw: Record<string, unknown>, field: string): string {
  const value = raw[field];
  if (typeof value !== "string") {
    throw new AdmissionError(`Request field ${JSON.stringify(field)} is not a string`);
  }
  return value;
}

function booleanField(raw: Record<string, unknown>, field: string): boolean {
  const value = raw[field];
  if (typeof value !== "boolean") {
    throw new AdmissionError(`Request field ${JSON.stringify(field)} is not a boolean`);
  }
  return value;
}

function optionalString(
  raw: Record<string, unknown>,
  field: string,
): Record<string, string> {
  const value = optionalStringValue(raw, field);
  return value === undefined ? {} : { [field]: value };
}

function optionalStringValue(
  raw: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = raw[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new AdmissionError(`Request field ${JSON.stringify(field)} is not a string`);
  }
  return value;
}

function optionalFiniteNumber(
  raw: Record<string, unknown>,
  field: string,
): Record<string, number> {
  const value = raw[field];
  if (value === undefined || value === null) return {};
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new AdmissionError(
      `Request field ${JSON.stringify(field)} is not a non-negative finite number`,
    );
  }
  return { [field]: value };
}

function byteLimit(value: string, label: string, maximum: number): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maximum) {
    throw new AdmissionError(
      `${capitalize(label)} is ${String(bytes)} bytes; the maximum is ${String(maximum)}`,
    );
  }
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
