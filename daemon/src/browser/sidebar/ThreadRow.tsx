import { useRef, useState, type MouseEvent, type PointerEvent } from "react";
import type { ThreadView } from "../../protocol/ThreadView.ts";
import { openThreadDialog } from "../app/intents.ts";
import { markRead, makeHome } from "../chat/actions.ts";
import { IconButton, PointMenu, type MenuItem } from "../ui/controls.tsx";
import { Icon } from "../ui/icons.tsx";

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;

export function threadMenuItems(thread: ThreadView, ready: boolean): MenuItem[] {
  return [
    { label: "Thread settings…", icon: "settings", onSelect: () => openThreadDialog("settings", thread.id), disabled: !ready },
    { label: "Fork…", icon: "branch", onSelect: () => openThreadDialog("fork", thread.id), disabled: !ready },
    { label: "Mark as read", icon: "check", onSelect: () => void markRead(thread), disabled: !ready || (thread.unread ?? 0) === 0 },
    ...(thread.home || thread.heartbeat === true ? [] : [{ label: "Make home", icon: "home" as const, onSelect: () => void makeHome(thread), disabled: !ready }]),
    "separator",
    { label: "Archive…", icon: "archive", onSelect: () => openThreadDialog("archive", thread.id), disabled: !ready || thread.home, danger: true },
  ];
}

function UnreadBadge({ count }: { count: number }) {
  return <span className="sidebar-unread">
    <span aria-hidden="true">{count > 99 ? "99+" : String(count)}</span>
    <span className="sr-only">{count === 1 ? "(1 unread message)" : `(${String(count)} unread messages)`}</span>
  </span>;
}

export function ThreadRow({ thread, label, current, unread, replying, opening, ready, select }: {
  thread: ThreadView; label: string; current: boolean; unread: number; replying: boolean; opening: boolean; ready: boolean; select: () => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const pressed = useRef(false);
  const release = () => { if (press.current !== null) clearTimeout(press.current.timer); press.current = null; };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch") return;
    const { clientX: x, clientY: y } = event;
    pressed.current = false;
    release();
    press.current = { x, y, timer: setTimeout(() => { pressed.current = true; press.current = null; setMenu({ x, y }); }, LONG_PRESS_MS) };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (press.current !== null && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > LONG_PRESS_SLOP) release();
  };
  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    release();
    const box = event.currentTarget.getBoundingClientRect();
    setMenu(event.clientX === 0 && event.clientY === 0 ? { x: box.left + 24, y: box.bottom } : { x: event.clientX, y: event.clientY });
  };
  const onMore = (event: MouseEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    setMenu({ x: box.left, y: box.bottom + 4 });
  };
  return <div className={`thread-row ${menu === null ? "" : "menu-open"}`} onContextMenu={onContextMenu} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={release} onPointerCancel={release}>
    <button type="button" className={`sidebar-item thread ${current ? "on" : ""} ${unread > 0 ? "unread" : ""}`} aria-current={current ? "page" : undefined} aria-busy={opening} disabled={!ready} onClick={() => { if (pressed.current) { pressed.current = false; return; } select(); }}>
      <Icon name={thread.home ? "home" : thread.heartbeat === true ? "heartbeat" : "chat"} size={14} /><span className="sidebar-name">{label}</span>
      {thread.locked === true ? <span className="sidebar-locked" title="Locked: only you change its label, purpose and files"><Icon name="lock" size={12} /><span className="sr-only">(locked)</span></span> : null}
      {replying || opening ? <span className="sidebar-replying"><span className="spinner" aria-hidden="true" /><span className="sr-only">{opening ? "(opening)" : "(replying)"}</span></span> : null}
      {unread > 0 ? <UnreadBadge count={unread} /> : null}
    </button>
    <IconButton icon="more" size={16} className="thread-more" label={`Options for ${label}`} aria-haspopup="menu" aria-expanded={menu !== null} onClick={onMore} />
    {menu === null ? null : <PointMenu label={`Options for ${label}`} items={threadMenuItems(thread, ready)} at={menu} close={() => setMenu(null)} />}
  </div>;
}
