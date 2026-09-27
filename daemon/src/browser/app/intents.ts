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
