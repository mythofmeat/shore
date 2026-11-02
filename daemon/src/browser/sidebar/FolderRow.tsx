import { useState } from "react";
import { openFolderDialog } from "../app/intents.ts";
import { collapsedFolders, errorText, workspace } from "../app/state.ts";
import { IconButton, PointMenu, type MenuItem } from "../ui/controls.tsx";
import { Icon } from "../ui/icons.tsx";
import { toasts } from "../ui/toast.tsx";
import type { FolderSection } from "./order.ts";
import { useRowMenu } from "./row_menu.ts";
import { THREAD_DRAG_TYPE } from "./ThreadRow.tsx";

export function folderMenuItems(folder: FolderSection, ready: boolean, neighbours: { up: string | undefined; down: string | undefined; atEnd: boolean }): MenuItem[] {
  const change = (work: () => Promise<Parameters<typeof workspace.applyThreadListing>[0]>) => { void work().then((listing) => workspace.applyThreadListing(listing)).catch((error: unknown) => toasts.show(errorText(error), "error")); };
  return [
    { label: "Rename folder…", icon: "label", onSelect: () => openFolderDialog({ kind: "rename", folder: folder.name }), disabled: !ready },
    { label: "Sort by activity", icon: "refresh", ...(folder.byActivity ? { detail: "On" } : {}), onSelect: () => change(() => workspace.actions.run("thread_folder_sort", { name: folder.name, by_activity: !folder.byActivity })), disabled: !ready },
    "separator",
    { label: "Move folder up", icon: "chevronUp", onSelect: () => change(() => workspace.actions.run("thread_folder_move", { name: folder.name, ...(neighbours.up === undefined ? {} : { before: neighbours.up }) })), disabled: !ready || neighbours.up === undefined },
    { label: "Move folder down", icon: "chevronDown", onSelect: () => change(() => workspace.actions.run("thread_folder_move", { name: folder.name, ...(neighbours.down === undefined ? {} : { before: neighbours.down }) })), disabled: !ready || neighbours.atEnd },
    "separator",
    { label: "Delete folder…", icon: "trash", onSelect: () => openFolderDialog({ kind: "delete", folder: folder.name }), disabled: !ready, danger: true },
  ];
}

export function FolderRow({ character, folder, collapsed, unread, replying, ready, neighbours, drop }: {
  character: string; folder: FolderSection; collapsed: boolean; unread: number; replying: boolean; ready: boolean; neighbours: { up: string | undefined; down: string | undefined; atEnd: boolean }; drop: (dragged: string) => void;
}) {
  const menu = useRowMenu();
  const [target, setTarget] = useState(false);
  return <div className={`thread-row folder-row ${menu.at === null ? "" : "menu-open"} ${target ? "drop-into" : ""}`} {...menu.handlers}
    onDragOver={(event) => { if (!event.dataTransfer.types.includes(THREAD_DRAG_TYPE)) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; setTarget(true); }}
    onDragLeave={() => setTarget(false)}
    onDrop={(event) => {
      const dragged = event.dataTransfer.getData(THREAD_DRAG_TYPE);
      setTarget(false);
      if (dragged === "") return;
      event.preventDefault();
      event.stopPropagation();
      drop(dragged);
    }}>
    <button type="button" className="sidebar-item thread folder" aria-expanded={!collapsed} onClick={() => { if (!menu.swallowClick()) collapsedFolders.toggle(character, folder.name); }}>
      <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={14} /><span className="sidebar-name">{folder.name}</span>
      {collapsed && replying ? <span className="sidebar-replying"><span className="spinner" aria-hidden="true" /><span className="sr-only">(replying)</span></span> : null}
      {collapsed && unread > 0 ? <span className="sidebar-unread"><span aria-hidden="true">{unread > 99 ? "99+" : String(unread)}</span><span className="sr-only">{unread === 1 ? "(1 unread message)" : `(${String(unread)} unread messages)`}</span></span> : null}
    </button>
    <IconButton icon="more" size={16} className="thread-more" label={`Options for folder ${folder.name}`} aria-haspopup="menu" aria-expanded={menu.at !== null} onClick={menu.openFrom} />
    {menu.at === null ? null : <PointMenu label={`Options for folder ${folder.name}`} items={folderMenuItems(folder, ready, neighbours)} at={menu.at} close={menu.close} />}
  </div>;
}
