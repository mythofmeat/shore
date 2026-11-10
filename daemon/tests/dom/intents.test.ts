import { expect, test } from "bun:test";

import { COMPACTION_VIEW_EVENT, CONVERSATION_DIALOG_EVENT, EFFORT_MENU_EVENT, FOLDER_DIALOG_EVENT, THREAD_DIALOG_EVENT, openCompactionView, openConversationDialog, openEffortMenu, openFolderDialog, openThreadDialog, requestConfigSearch, takeConfigSearch } from "../../src/browser/app/intents.ts";

test("dialogs and menus are asked for by events, and a configuration search is taken once", () => {
  const heard: [string, unknown][] = [];
  const names = [CONVERSATION_DIALOG_EVENT, EFFORT_MENU_EVENT, THREAD_DIALOG_EVENT, FOLDER_DIALOG_EVENT, COMPACTION_VIEW_EVENT];
  const listener = (event: Event) => { heard.push([event.type, (event as CustomEvent).detail]); };
  for (const name of names) addEventListener(name, listener);
  try {
    openConversationDialog("rename");
    openEffortMenu();
    openThreadDialog("fork", "story");
    openFolderDialog({ kind: "rename", folder: "work" });
    openCompactionView();
    expect(heard).toEqual([
      [CONVERSATION_DIALOG_EVENT, "rename"],
      [EFFORT_MENU_EVENT, null],
      [THREAD_DIALOG_EVENT, { kind: "fork", thread: "story" }],
      [FOLDER_DIALOG_EVENT, { kind: "rename", folder: "work" }],
      [COMPACTION_VIEW_EVENT, null],
    ]);
    requestConfigSearch("heartbeat");
    expect(takeConfigSearch()).toBe("heartbeat");
    expect(takeConfigSearch()).toBe("");
  } finally {
    for (const name of names) removeEventListener(name, listener);
  }
});
