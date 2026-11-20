import { deleteDurable, readDurable, threadFile, writeDurable } from "../storage/files.ts";
import { INTERRUPTED_REPLY_NOTE } from "./interrupted_note.ts";
import type { Message } from "./types.ts";

const INSTANCE = crypto.randomUUID();

const markerOf = (data: string, character: string, thread: string) => threadFile(data, character, thread, "reply_running.json");

export function markReplyRunning(data: string, character: string, thread: string): () => void {
  const marker = markerOf(data, character, thread);
  writeDurable(marker, JSON.stringify({ instance: INSTANCE }));
  return () => { deleteDurable(marker); };
}

export function replyWasInterrupted(data: string, character: string, thread: string): boolean {
  const marker = markerOf(data, character, thread);
  let instance: unknown;
  try {
    instance = (JSON.parse(readDurable(marker)) as { instance?: unknown }).instance;
  } catch {
    return false;
  }
  if (instance === INSTANCE) return false;
  deleteDurable(marker);
  return true;
}

export function interruptedReplyNote(timestamp: string): Message {
  return {
    msg_id: `m_${crypto.randomUUID()}`,
    role: "system",
    content: INTERRUPTED_REPLY_NOTE,
    images: [],
    content_blocks: [{ type: "text", text: INTERRUPTED_REPLY_NOTE }],
    timestamp,
  };
}
