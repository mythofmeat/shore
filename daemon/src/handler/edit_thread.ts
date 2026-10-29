import type { CharacterRegistry } from "../characters.ts";
import { threadRecord, type ThreadRecord } from "../engine/threads.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import type { EditThreadRequest } from "../tools/edit_thread.ts";

export interface ThreadEditor {
  registry: Pick<CharacterRegistry, "editThreadAsCharacter">;
  emitEvent?: ((message: ServerMessage) => void) | undefined;
}

export async function editCharacterThread(
  editor: ThreadEditor,
  character: string,
  request: EditThreadRequest,
): Promise<ThreadRecord | undefined> {
  const { name, ...edit } = request;
  const index = await editor.registry.editThreadAsCharacter(character, name, edit);
  editor.emitEvent?.({ type: "threads_changed", character, thread: name });
  return threadRecord(index, name);
}
