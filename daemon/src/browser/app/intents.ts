let configQuery = "";

export function requestConfigSearch(query: string): void { configQuery = query; }

export function takeConfigSearch(): string {
  const query = configQuery;
  configQuery = "";
  return query;
}

export const CONVERSATION_DIALOG_EVENT = "shore:conversation-dialog";

export function openConversationDialog(name: string): void {
  dispatchEvent(new CustomEvent(CONVERSATION_DIALOG_EVENT, { detail: name }));
}

export const EFFORT_MENU_EVENT = "shore:effort-menu";

export function openEffortMenu(): void {
  dispatchEvent(new CustomEvent(EFFORT_MENU_EVENT));
}

export const THREAD_DIALOG_EVENT = "shore:thread-dialog";

export type ThreadDialogKind = "settings" | "fork" | "archive";

export interface ThreadDialogRequest { kind: ThreadDialogKind; thread: string }

export function openThreadDialog(kind: ThreadDialogKind, thread: string): void {
  dispatchEvent(new CustomEvent<ThreadDialogRequest>(THREAD_DIALOG_EVENT, { detail: { kind, thread } }));
}
