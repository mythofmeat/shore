import type { CharacterRegistry } from "../characters.ts";
import { threadDataDir } from "../config/dirs.ts";
import { withConversation } from "../engine/lifecycle.ts";
import type { Message } from "../engine/types.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import type { StartThreadRequest } from "../tools/start_thread.ts";
import { emitNewMessageEvent } from "./persistence.ts";

export interface ThreadStarter {
  registry: CharacterRegistry;
  dataDir: string;
  emitEvent?: ((message: ServerMessage) => void) | undefined;
}

export async function startCharacterThread(starter: ThreadStarter, character: string, request: StartThreadRequest): Promise<void> {
  const { registry, emitEvent } = starter;
  await registry.createThread(character, request.name, {
    label: request.label,
    compaction: true,
    created_by: "character",
    ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
    ...(request.files === undefined ? {} : { files: request.files }),
  });
  if (request.opening !== undefined) {
    const opening = request.opening;
    const engine = await registry.getOrCreate(character, request.name);
    const message: Message = {
      msg_id: `m_${crypto.randomUUID()}`,
      role: "assistant",
      content: opening,
      images: [],
      content_blocks: [{ type: "text", text: opening }],
      alternatives: [],
      timestamp: new Date().toISOString(),
    };
    await withConversation(threadDataDir(starter.dataDir, character, request.name), "update", async () => {
      await engine.appendMessage(message);
    });
    if (emitEvent !== undefined) {
      emitNewMessageEvent(emitEvent, character, "assistant_reply", engine.currentRevision(), message, request.name);
    }
  }
  emitEvent?.({ type: "threads_changed", character, thread: request.name });
}
