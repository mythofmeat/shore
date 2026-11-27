import { useSyncExternalStore } from "react";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const sameYear = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const otherYear = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" });
const full = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export interface RowTime { text: string; title: string }

export function rowTime(at: string | undefined, now: number): RowTime {
  if (at === undefined) return { text: "empty", title: "No messages yet" };
  const time = Date.parse(at);
  const ago = now - time;
  const title = `Last message ${full.format(time)}`;
  if (ago < MINUTE) return { text: "now", title };
  if (ago < HOUR) return { text: `${String(Math.floor(ago / MINUTE))}m`, title };
  if (ago < DAY) return { text: `${String(Math.floor(ago / HOUR))}h`, title };
  if (ago < WEEK) return { text: `${String(Math.floor(ago / DAY))}d`, title };
  if (ago < 5 * WEEK) return { text: `${String(Math.floor(ago / WEEK))}w`, title };
  return { text: (new Date(time).getFullYear() === new Date(now).getFullYear() ? sameYear : otherYear).format(time), title };
}

const watchers = new Set<() => void>();
let now = Date.now();
let ticking: ReturnType<typeof setInterval> | undefined;

function watch(listener: () => void): () => void {
  watchers.add(listener);
  now = Date.now();
  ticking ??= setInterval(() => {
    now = Date.now();
    for (const watcher of watchers) watcher();
  }, MINUTE / 2);
  return () => {
    watchers.delete(listener);
    if (watchers.size > 0) return;
    clearInterval(ticking);
    ticking = undefined;
  };
}

export function useNow(): number {
  return useSyncExternalStore(watch, () => now);
}
