import { useState, type DragEvent } from "react";
import type { ThreadView } from "../../protocol/ThreadView.ts";
import { openThreadDialog } from "../app/intents.ts";
import { holdThread, laterThread, markRead, makeHome, moveThreadTo } from "../chat/actions.ts";
import { IconButton, PointMenu, type MenuItem } from "../ui/controls.tsx";
import { Icon, type IconName } from "../ui/icons.tsx";
import { useRowMenu } from "./row_menu.ts";
import { rowTime, useNow } from "./row_time.ts";

export const THREAD_DRAG_TYPE = "application/x-shore-thread";
export const FOLDER_DRAG_TYPE = "application/x-shore-folder";

export const TOUCH_ONLY = typeof matchMedia === "function" && matchMedia("(hover: none)").matches;

export function holdItem(thread: ThreadView, ready: boolean): MenuItem[] {
  if (thread.on_hold === true) return [{ label: "Resume", icon: "play", onSelect: () => void holdThread(thread, false), disabled: !ready }];
  if (thread.home || thread.wakes === true) return [];
  return [{ label: "Put on hold", icon: "pause", onSelect: () => void holdThread(thread, true), disabled: !ready }];
}

export function laterItem(thread: ThreadView, ready: boolean): Exclude<MenuItem, "separator"> {
  const later = thread.later === undefined;
  return { label: later ? "Mark for later" : "Clear later mark", icon: "flag", onSelect: () => void laterThread(thread, later), disabled: !ready };
}

export function threadMenuItems(thread: ThreadView, ready: boolean, neighbours: ThreadNeighbours): MenuItem[] {
  const movable = !thread.home;
  return [
    { label: "Thread settings…", icon: "settings", onSelect: () => openThreadDialog("settings", thread.id), disabled: !ready },
    { label: "Fork…", icon: "branch", onSelect: () => openThreadDialog("fork", thread.id), disabled: !ready },
    { label: "Mark as read", icon: "check", onSelect: () => void markRead(thread), disabled: !ready || (thread.unread ?? 0) === 0 },
    laterItem(thread, ready),
    ...holdItem(thread, ready),
    ...(movable ? [
      { label: "Make home", icon: "home" as const, onSelect: () => void makeHome(thread), disabled: !ready },
      "separator" as const,
      ...(neighbours.byActivity ? [] : [
        { label: "Move up", icon: "chevronUp" as const, onSelect: () => void moveThreadTo(thread.id, neighbours.up === undefined ? {} : { before: neighbours.up }), disabled: !ready || neighbours.up === undefined },
        { label: "Move down", icon: "chevronDown" as const, onSelect: () => void moveThreadTo(thread.id, neighbours.down === undefined ? {} : { before: neighbours.down }), disabled: !ready || neighbours.atEnd },
      ]),
      { label: "Move to folder…", icon: "folder" as const, onSelect: () => openThreadDialog("move", thread.id), disabled: !ready },
    ] : []),
    "separator",
    { label: "Archive…", icon: "archive", onSelect: () => openThreadDialog("archive", thread.id), disabled: !ready || thread.home, danger: true },
  ];
}

export function place(event: DragEvent<HTMLDivElement>): "before" | "after" {
  const box = event.currentTarget.getBoundingClientRect();
  return event.clientY > box.top + box.height / 2 ? "after" : "before";
}

export interface ThreadNeighbours { up: string | undefined; down: string | undefined; atEnd: boolean; byActivity: boolean }

export function LaterCount({ count }: { count: number }) {
  return <span className="sidebar-later sidebar-later-count">
    <Icon name="flag" size={12} /><span aria-hidden="true">{String(count)}</span>
    <span className="sr-only">{count === 1 ? "(1 marked for later)" : `(${String(count)} marked for later)`}</span>
  </span>;
}

export function UnreadBadge({ count }: { count: number }) {
  return <span className="sidebar-unread">
    <span aria-hidden="true">{count > 99 ? "99+" : String(count)}</span>
    <span className="sr-only">{count === 1 ? "(1 unread message)" : `(${String(count)} unread messages)`}</span>
  </span>;
}

export function rowIcon(thread: ThreadView, character: string): { name: IconName; says: string } | undefined {
  if (thread.home) return { name: "home", says: "home" };
  if (thread.wakes === true) return { name: "clock", says: "where wakes are kept" };
  return thread.created_by === "character" ? { name: "spark", says: `started by ${character}` } : undefined;
}

export function ThreadRow({ thread, character, label, current, unread, drafted, replying, opening, ready, select, neighbours, drop }: {
  thread: ThreadView; character: string; label: string; current: boolean; unread: number; drafted: boolean; replying: boolean; opening: boolean; ready: boolean; select: () => void; neighbours: ThreadNeighbours;
  drop: (dragged: string, after: boolean) => void;
}) {
  const menu = useRowMenu();
  const [target, setTarget] = useState<"before" | "after" | null>(null);
  const movable = !thread.home;
  const icon = rowIcon(thread, character);
  const time = rowTime(thread.last_active, useNow());
  const open = () => { if (ready && !menu.swallowClick()) select(); };
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
      title={thread.purpose === undefined || thread.purpose === "" ? label : `${label}\n${thread.purpose}`}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } }}>
      <span className="sidebar-icon">{icon === undefined ? null : <><Icon name={icon.name} size={14} /><span className="sr-only">({icon.says})</span></>}</span>
      <span className="sidebar-name">{label}</span>
      {thread.later === undefined ? null : <span className="sidebar-later" title="Marked for later"><Icon name="flag" size={12} /><span className="sr-only">(marked for later)</span></span>}
      {thread.locked === true ? <span className="sidebar-locked" title="Locked: only you change its label, purpose and pins"><Icon name="lock" size={12} /><span className="sr-only">(locked)</span></span> : null}
      {drafted ? <span className="sidebar-draft" title="An unsent message in this tab"><Icon name="edit" size={12} /><span className="sr-only">(unsent message)</span></span> : null}
      {replying || opening ? <span className="sidebar-replying"><span className="spinner" aria-hidden="true" /><span className="sr-only">{opening ? "(opening)" : "(replying)"}</span></span> : null}
      {unread > 0 ? <UnreadBadge count={unread} /> : null}
      <span className="sidebar-time" title={time.title}>{time.text}</span>
    </div>
    <IconButton icon="more" size={16} className="thread-more" label={`Options for ${label}`} aria-haspopup="menu" aria-expanded={menu.at !== null} onClick={menu.openFrom} />
    {menu.at === null ? null : <PointMenu label={`Options for ${label}`} items={threadMenuItems(thread, ready, neighbours)} at={menu.at} close={menu.close} />}
  </div>;
}
