import type { Workspace } from "../workspace.ts";

export class ReadMarks {
  #sent = "";
  constructor(readonly workspace: Workspace, readonly focused: () => boolean) {}
  check = (): void => {
    const state = this.workspace.getSnapshot();
    if (state.status !== "ready") { this.#sent = ""; return; }
    if (state.character === null || state.thread === null || state.segmentView !== null || !this.focused()) return;
    if ((state.threads.find((thread) => thread.id === state.thread)?.unread ?? 0) === 0) return;
    const through = state.messages.at(-1)?.timestamp;
    if (through === undefined) return;
    const key = JSON.stringify([state.character, state.thread, through]);
    if (key === this.#sent) return;
    this.#sent = key;
    void this.workspace.actions.run("mark_thread_read", { name: state.thread, through }).catch(() => {});
  };
}
