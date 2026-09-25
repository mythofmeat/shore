import type { WorkspaceSnapshot } from "../workspace.ts";
import { toasts } from "../ui/toast.tsx";
import { errorText, workspace } from "../app/state.ts";

export async function makeHome(state: WorkspaceSnapshot): Promise<void> {
  try {
    await workspace.actions.run("thread_home", { name: state.thread ?? "" });
    await workspace.refreshNavigation();
    toasts.show("This is now the home conversation");
  } catch (error) { toasts.show(errorText(error), "error"); }
}
