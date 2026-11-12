import type { Message } from "../../protocol/Message.ts";
import type { WorkspaceRewind } from "../../protocol/WorkspaceRewind.ts";
import { workspaceNote } from "./workspace_note.ts";
import type { ThreadView } from "../../protocol/ThreadView.ts";
import { toasts } from "../ui/toast.tsx";
import { conversation, errorText, streamReplies, workspace } from "../app/state.ts";
import { moveInThreads } from "../sidebar/order.ts";
import { swipeState } from "./transcript.ts";

export async function swipe(message: Message, direction: "prev" | "next", last: boolean): Promise<void> {
  const state = swipeState(message);
  if (direction === "prev" && !state.canPrevious) return;
  if (direction === "next" && state.atLast) {
    if (last) await conversation.regenerate({}, streamReplies());
    return;
  }
  showWorkspaceNote((await workspace.actions.run("alt", { ref: message.msg_id, direction })).workspace);
}

export function showWorkspaceNote(rewind: WorkspaceRewind | undefined): void {
  const note = workspaceNote(rewind);
  if (note !== undefined) toasts.show(note);
}

export async function makeHome(thread: Pick<ThreadView, "id" | "label">): Promise<void> {
  try {
    workspace.noteHomeThread(thread.id);
    await workspace.actions.run("thread_home", { name: thread.id });
    await workspace.refreshThreads();
    toasts.show(`“${thread.label ?? thread.id}” is now the home thread`);
  } catch (error) {
    await workspace.refreshThreads();
    toasts.show(errorText(error), "error");
  }
}

export async function markRead(thread: Pick<ThreadView, "id">): Promise<void> {
  try {
    workspace.noteThreadRead(thread.id);
    await workspace.actions.run("mark_thread_read", { name: thread.id });
  } catch (error) {
    await workspace.refreshThreads();
    toasts.show(errorText(error), "error");
  }
}

export async function moveThreadTo(id: string, move: { folder?: string; before?: string }): Promise<void> {
  const state = workspace.getSnapshot();
  workspace.noteThreads(moveInThreads(state.threads, state.folders, id, move));
  try {
    workspace.applyThreadListing(await workspace.actions.run("thread_move", { name: id, ...move }));
  } catch (error) {
    await workspace.refreshThreads();
    toasts.show(errorText(error), "error");
  }
}
