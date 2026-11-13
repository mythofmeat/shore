import { useState, type DragEvent } from "react";
import type { ThreadView } from "../../protocol/ThreadView.ts";
import { openCompactionView, openThreadDialog } from "../app/intents.ts";
import { markRead, makeHome, moveThreadTo } from "../chat/actions.ts";
import { IconButton, PointMenu, type MenuItem } from "../ui/controls.tsx";
import { Icon } from "../ui/icons.tsx";
import { useRowMenu } from "./row_menu.ts";

export const THREAD_DRAG_TYPE = "application/x-shore-thread";

const TOUCH_ONLY = typeof matchMedia === "function" && matchMedia("(hover: none)").matches;

export function threadMenuItems(thread: ThreadView, ready: boolean, neighbours: ThreadNeighbours): MenuItem[] {
  const movable = !thread.home;
  return [
    { label: "Thread settings…", icon: "settings", onSelect: () => openThreadDialog("settings", thread.id), disabled: !ready },
    { label: "Fork…", icon: "branch", onSelect: () => openThreadDialog("fork", thread.id), disabled: !ready },
    { label: "Mark as read", icon: "check", onSelect: () => void markRead(thread), disabled: !ready || (thread.unread ?? 0) === 0 },
    ...(movable ? [
      { label: "Make home", icon: "home" as const, onSelect: () => void makeHome(thread), disabled: !ready },
      "separator" as const,
      { label: "Move up", icon: "chevronUp" as const, onSelect: () => void moveThreadTo(thread.id, neighbours.up === undefined ? {} : { before: neighbours.up }), disabled: !ready || neighbours.up === undefined || neighbours.byActivity },
      { label: "Move down", icon: "chevronDown" as const, onSelect: () => void moveThreadTo(thread.id, neighbours.down === undefined ? {} : { before: neighbours.down }), disabled: !ready || neighbours.atEnd || neighbours.byActivity },
      { label: "Move to folder…", icon: "folder" as const, onSelect: () => openThreadDialog("move", thread.id), disabled: !ready },
    ] : []),
    "separator",
    { label: "Archive…", icon: "archive", onSelect: () => openThreadDialog("archive", thread.id), disabled: !ready || thread.home, danger: true },
  ];
}

export interface ThreadNeighbours { up: string | undefined; down: string | undefined; atEnd: boolean; byActivity: boolean }

function UnreadBadge({ count }: { count: number }) {
  return <span className="sidebar-unread">
    <span aria-hidden="true">{count > 99 ? "99+" : String(count)}</span>
    <span className="sr-only">{count === 1 ? "(1 unread message)" : `(${String(count)} unread messages)`}</span>
  </span>;
}

export function ThreadRow({ thread, label, current, unread, replying, opening, compacting, ready, select, neighbours, drop }: {
  thread: ThreadView; label: string; current: boolean; unread: number; replying: boolean; opening: boolean; compacting: boolean; ready: boolean; select: () => void; neighbours: ThreadNeighbours;
  drop: (dragged: string, after: boolean) => void;
}) {
  const menu = useRowMenu();
  const [target, setTarget] = useState<"before" | "after" | null>(null);
  const movable = !thread.home;
  const open = () => { if (ready && !menu.swallowClick()) select(); };
  const place = (event: DragEvent<HTMLDivElement>): "before" | "after" => {
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientY > box.top + box.height / 2 ? "after" : "before";
  };
  return <div className={`thread-row ${menu.at === null ? "" : "menu-open"} ${target === null ? "" : `drop-${target}`}`} draggable={movable && ready && !TOUCH_ONLY} {...menu.handlers}
    onDragStart={(event) => { event.dataTransfer.setData(THREAD_DRAG_TYPE, thread.id); event.dataTransfer.effectAllowed = "move"; }}
    onDragOver={(event) => { if (!movable || !event.dataTransfer.types.includes(THREAD_DRAG_TYPE)) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; setTarget(place(event)); }}
    onDragLeave={() => setTarget(null)}
    onDrop={(event) => {
      const dragged = event.dataTransfer.getData(THREAD_DRAG_TYPE);
      setTarget(null);
      if (dragged === "" || !movable) return;
      event.preventDefault();
      event.stopPropagation();
      if (dragged !== thread.id) drop(dragged, place(event) === "after");
    }}>
    <div role="button" tabIndex={ready ? 0 : -1} className={`sidebar-item thread ${current ? "on" : ""} ${unread > 0 ? "unread" : ""}`} aria-current={current ? "page" : undefined} aria-busy={opening} aria-disabled={!ready} onClick={open}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } }}>
      <Icon name={thread.home ? "home" : "chat"} size={14} /><span className="sidebar-name">{label}</span>
      {thread.locked === true ? <span className="sidebar-locked" title="Locked: only you change its label, purpose and files"><Icon name="lock" size={12} /><span className="sr-only">(locked)</span></span> : null}
      {compacting ? <span className="sidebar-compacting" title="Compacting"><Icon name="compact" size={12} /><span className="sr-only">(compacting)</span></span> : null}
      {replying || opening ? <span className="sidebar-replying"><span className="spinner" aria-hidden="true" /><span className="sr-only">{opening ? "(opening)" : "(replying)"}</span></span> : null}
      {unread > 0 ? <UnreadBadge count={unread} /> : null}
    </div>
    <IconButton icon="more" size={16} className="thread-more" label={`Options for ${label}`} aria-haspopup="menu" aria-expanded={menu.at !== null} onClick={menu.openFrom} />
    {menu.at === null ? null : <PointMenu label={`Options for ${label}`} items={[...(compacting ? [{ label: "Show the compaction…", icon: "compact" as const, onSelect: openCompactionView }, "separator" as const] : []), ...threadMenuItems(thread, ready, neighbours)]} at={menu.at} close={menu.close} />}
  </div>;
}
