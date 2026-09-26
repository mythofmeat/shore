import type { Message } from "../../protocol/Message.ts";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { toasts } from "../ui/toast.tsx";
import { conversation, errorText, streamReplies, workspace } from "../app/state.ts";
import { swipeState } from "./transcript.ts";

export async function swipe(message: Message, direction: "prev" | "next", last: boolean): Promise<void> {
  const state = swipeState(message);
  if (direction === "prev" && !state.canPrevious) return;
  if (direction === "next" && state.atLast) {
    if (last) await conversation.regenerate(undefined, streamReplies());
    return;
  }
  await workspace.actions.run("alt", { ref: message.msg_id, direction });
}

export async function makeHome(state: WorkspaceSnapshot): Promise<void> {
  try {
    await workspace.actions.run("thread_home", { name: state.thread ?? "" });
    await workspace.refreshNavigation();
    toasts.show("This is now the home conversation");
  } catch (error) { toasts.show(errorText(error), "error"); }
}
