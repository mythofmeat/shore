import { HistoryMediaDelivery } from "./history_media.ts";
import type { ClientMessage } from "../protocol/ClientMessage";
import type { ImageUpload } from "../protocol/ImageUpload";
import type { ServerMessage } from "../protocol/ServerMessage";

export const MAX_WIRE_MESSAGE_SIZE = 128 * 1024 * 1024;
export const MAX_PRE_AUTH_WIRE_MESSAGE_SIZE = 64 * 1024;

const NEWLINE = 0x0a;

const WIRE_TRIM_RE = /^\p{White_Space}+|\p{White_Space}+$/gu;

export function rustTrim(value: string): string {
  return value.replace(WIRE_TRIM_RE, "");
}

export class WireError extends Error {
  override readonly name = "WireError";
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

export interface ByteSink {
  write(bytes: Uint8Array): Promise<void> | void;
}

const mediaDeliveries = new WeakMap<ByteSink, HistoryMediaDelivery>();

export async function writeMessage(sink: ByteSink, msg: ServerMessage): Promise<void> {
  let delivery = mediaDeliveries.get(sink);
  if (delivery === undefined) {
    delivery = new HistoryMediaDelivery();
    mediaDeliveries.set(sink, delivery);
  }
  await sink.write(encoder.encode(`${JSON.stringify(delivery.prepare(msg))}\n`));
}

export class WireReader {
  readonly #chunks: AsyncIterator<Uint8Array>;
  #pending: Uint8Array = new Uint8Array(0);
  #offset = 0;
  #exhausted = false;
  #maxMessageSize: number;

  constructor(source: AsyncIterable<Uint8Array>, maxMessageSize = MAX_WIRE_MESSAGE_SIZE) {
    this.#chunks = source[Symbol.asyncIterator]();
    this.#maxMessageSize = maxMessageSize;
  }

  setMaxMessageSize(maxMessageSize: number): void {
    this.#maxMessageSize = maxMessageSize;
  }

  async #fill(): Promise<Uint8Array> {
    while (this.#offset >= this.#pending.length) {
      if (this.#exhausted) return new Uint8Array(0);
      const next = await this.#chunks.next();
      if (next.done === true) {
        this.#exhausted = true;
        return new Uint8Array(0);
      }
      this.#pending = next.value;
      this.#offset = 0;
    }
    return this.#pending.subarray(this.#offset);
  }

  async readMessage(): Promise<ClientMessage | null> {
    const parts: Uint8Array[] = [];
    let length = 0;

    for (;;) {
      const buf = await this.#fill();
      if (buf.length === 0) {
        if (length === 0) return null;
        break;
      }

      const newline = buf.indexOf(NEWLINE);
      const consume = newline === -1 ? buf.length : newline + 1;

      if (length + consume > this.#maxMessageSize) {
        throw new WireError("Message exceeds maximum size");
      }

      parts.push(buf.subarray(0, consume));
      length += consume;
      this.#offset += consume;

      if (newline !== -1) break;
    }

    const bytes = concat(parts, length);
    let line: string;
    try {
      line = decoder.decode(bytes);
    } catch (cause) {
      throw new WireError("Frame is not valid UTF-8", { cause });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rustTrim(line));
    } catch (cause) {
      throw new WireError(`Frame is not valid JSON: ${String(cause)}`, { cause });
    }
    return decodeClientMessage(parsed);
  }
}

function decodeClientMessage(value: unknown): ClientMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WireError("Frame is not a JSON object");
  }
  const raw = value as Record<string, unknown>;

  const str = (key: string, required: boolean): string | undefined => {
    const v = raw[key];
    if (v === undefined || v === null) {
      if (required) throw new WireError(`Frame is missing required field ${JSON.stringify(key)}`);
      return undefined;
    }
    if (typeof v !== "string") {
      throw new WireError(`Frame field ${JSON.stringify(key)} is not a string`);
    }
    return v;
  };
  const bool = (key: string): boolean => {
    const fieldValue = raw[key];
    if (fieldValue === undefined || fieldValue === null) return false;
    if (typeof fieldValue !== "boolean") {
      throw new WireError(`Frame field ${JSON.stringify(key)} is not a boolean`);
    }
    return fieldValue;
  };
  const arr = (key: string): unknown[] => {
    const fieldValue = raw[key];
    if (fieldValue === undefined || fieldValue === null) return [];
    if (!Array.isArray(fieldValue)) {
      throw new WireError(`Frame field ${JSON.stringify(key)} is not an array`);
    }
    return fieldValue;
  };
  const strArr = (key: string): string[] =>
    arr(key).map((element, index) => {
      if (typeof element !== "string") {
        throw new WireError(
          `Frame field ${JSON.stringify(key)} element ${String(index + 1)} is not a string`,
        );
      }
      return element;
    });
  const uploads = (): ImageUpload[] =>
    arr("image_data").map((element, index) => {
      if (typeof element !== "object" || element === null || Array.isArray(element)) {
        throw new WireError(`Frame attachment ${String(index + 1)} is not an object`);
      }
      const upload = element as Record<string, unknown>;
      const filename = upload.filename;
      const data = upload.data;
      const mimeType = upload.mime_type;
      if (typeof filename !== "string") {
        throw new WireError(`Frame attachment ${String(index + 1)} filename is not a string`);
      }
      if (typeof data !== "string") {
        throw new WireError(`Frame attachment ${String(index + 1)} data is not a string`);
      }
      if (mimeType !== undefined && mimeType !== null && typeof mimeType !== "string") {
        throw new WireError(`Frame attachment ${String(index + 1)} mime_type is not a string`);
      }
      return {
        filename,
        data,
        ...(typeof mimeType === "string" ? { mime_type: mimeType } : {}),
      };
    });
  const opt = <T,>(key: string, v: T | undefined): Record<string, T> =>
    v === undefined ? {} : ({ [key]: v });

  switch (raw.type) {
    case "hello":
      return {
        type: "hello",
        client_type: str("client_type", true) as string,
        client_name: str("client_name", true) as string,
        capabilities: strArr("capabilities"),
        ...opt("character", str("character", false)),
        ...opt("thread", str("thread", false)),
        ...opt("token", str("token", false)),
      };
    case "message":
      return {
        type: "message",
        ...opt("rid", str("rid", false)),
        text: str("text", true) as string,
        stream: bool("stream"),
        images: strArr("images"),
        image_data: uploads(),
        ...opt("absence_seconds", numberOrUndefined(raw.absence_seconds, "absence_seconds")),
      };
    case "regen":
      return {
        type: "regen",
        ...opt("rid", str("rid", false)),
        stream: bool("stream"),
        ...opt("guidance", str("guidance", false)),
      };
    case "command":
      return {
        type: "command",
        ...opt("rid", str("rid", false)),
        name: str("name", true) as string,
        args: raw.args === undefined ? null : raw.args,
      };
    case "cancel":
      return { type: "cancel" };
    default:
      throw new WireError(`Unknown client message type ${JSON.stringify(raw.type)}`);
  }
}

function numberOrUndefined(v: unknown, key: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number") throw new WireError(`Frame field ${JSON.stringify(key)} is not a number`);
  return v;
}

function concat(parts: readonly Uint8Array[], length: number): Uint8Array {
  if (parts.length === 1) return parts[0] as Uint8Array;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
