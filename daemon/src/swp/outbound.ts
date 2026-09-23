import type { ServerMessage } from "../protocol/ServerMessage.ts";

const encoded = new WeakMap<ServerMessage, { text: string; bytes: number }>();

export function encodeServerMessage(message: ServerMessage): { text: string; bytes: number } {
  let result = encoded.get(message);
  if (result === undefined) {
    const text = JSON.stringify(message);
    result = { text, bytes: Buffer.byteLength(text) };
    encoded.set(message, result);
  }
  return result;
}

export interface QueueLimits {
  messages: number;
  bytes: number;
  largeHistory?: boolean;
  coalesceStreams?: boolean;
}

export class OutboundQueue {
  readonly #items: { message: ServerMessage; bytes: number; large: boolean }[] = [];
  #bytes = 0;
  #large = 0;
  constructor(readonly limits?: QueueLimits) {}
  get length(): number { return this.#items.length; }

  push(message: ServerMessage): boolean {
    const limits = this.limits;
    const last = this.#items.at(-1);
    if (limits?.coalesceStreams === true && last?.message.type === "stream_chunk" && message.type === "stream_chunk" &&
      last.message.rid === message.rid && last.message.content_type === message.content_type &&
      last.message.subagent === message.subagent && last.message.task_id === message.task_id) {
      const merged = { ...last.message, text: last.message.text + message.text };
      const bytes = last.bytes + Buffer.byteLength(JSON.stringify(message.text)) - 2;
      if (this.#bytes - last.bytes + bytes > limits.bytes) return false;
      this.#bytes += bytes - last.bytes;
      last.message = merged; last.bytes = bytes;
      return true;
    }
    const size = limits === undefined || limits.bytes === Infinity ? 0 : encodeServerMessage(message).bytes;
    const large = limits?.largeHistory === true && message.type === "history" && size > limits.bytes;
    const bytes = large ? 0 : size;
    if (limits !== undefined && (this.length >= limits.messages || this.#bytes + bytes > limits.bytes || (large && this.#large > 0))) return false;
    this.#items.push({ message, bytes, large });
    this.#bytes += bytes;
    if (large) this.#large += 1;
    return true;
  }

  shift(): ServerMessage | undefined {
    const next = this.#items.shift();
    if (next === undefined) return undefined;
    this.#bytes -= next.bytes;
    if (next.large) this.#large -= 1;
    return next.message;
  }

  clear(): void { this.#items.length = 0; this.#bytes = 0; this.#large = 0; }
}
