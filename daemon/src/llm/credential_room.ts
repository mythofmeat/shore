export interface UsageReading {
  percent_used: number;
  resets_at: string | null;
}

export interface UsageWindow {
  window: string;
  label: string;
  reading: UsageReading | null;
  cutoff: number;
  own: boolean;
  longest: boolean;
}

export type Room =
  | { state: "ok"; resetsAt: number | null; room: number; reason: string }
  | { state: "limited"; reason: string; availableAt: number | null; own: boolean }
  | { state: "unknown"; reason: string };

export type Standing = Room | { state: "out"; reason: string };

export function usedFraction(reading: UsageReading, now: number): number {
  if (reading.resets_at !== null && Date.parse(reading.resets_at) <= now) return 0;
  return Math.min(Math.max(reading.percent_used, 0), 1);
}

function percentText(fraction: number): string {
  return `${String(Math.round(fraction * 100))}%`;
}

function resetTime(reading: UsageReading): number | null {
  if (reading.resets_at === null) return null;
  const at = Date.parse(reading.resets_at);
  return Number.isFinite(at) ? at : null;
}

export function roomLeft(windows: readonly UsageWindow[], now: number, unread: string): Room {
  const read = windows.flatMap((window) => (window.reading === null ? [] : [{ ...window, reading: window.reading }]));
  if (read.length === 0) return { state: "unknown", reason: unread };
  const over = read.filter((window) => usedFraction(window.reading, now) >= window.cutoff);
  if (over.length > 0) {
    const resets = over.map((window) => resetTime(window.reading));
    return {
      state: "limited",
      reason: over.map((window) => `${window.label} ${percentText(usedFraction(window.reading, now))} ≥ ${percentText(window.cutoff)}`).join(", "),
      availableAt: resets.every((at) => at !== null) ? Math.max(...resets) : null,
      own: over.some((window) => window.own),
    };
  }
  const longest = read.find((window) => window.longest);
  const resets = longest === undefined ? null : resetTime(longest.reading);
  return {
    state: "ok",
    resetsAt: resets !== null && resets > now ? resets : null,
    room: Math.min(...read.map((window) => window.cutoff - usedFraction(window.reading, now))),
    reason: read.map((window) => `${window.label} ${percentText(usedFraction(window.reading, now))}`).join(" · "),
  };
}

const STATE_ORDER = { ok: 0, limited: 1, unknown: 2, out: 3 } as const;

function minute(at: number | null): number {
  return at === null ? Infinity : Math.floor(at / 60_000);
}

export function rankByRoom<T extends { name: string; standing: Standing }>(items: readonly T[], current: string | undefined): T[] {
  const isCurrent = (item: T): number => Number(item.name === current);
  const freeAt = (item: T): number => (item.standing.state === "limited" ? minute(item.standing.availableAt) : Infinity);
  return items
    .map((item, i) => ({ item, i }))
    .sort(({ item: a, i }, { item: b, i: j }) => {
      const byState = STATE_ORDER[a.standing.state] - STATE_ORDER[b.standing.state];
      if (byState !== 0) return byState;
      if (a.standing.state === "ok" && b.standing.state === "ok") {
        const ra = minute(a.standing.resetsAt);
        const rb = minute(b.standing.resetsAt);
        if (ra !== rb) return ra < rb ? -1 : 1;
        return isCurrent(b) - isCurrent(a) || b.standing.room - a.standing.room || i - j;
      }
      const fa = freeAt(a);
      const fb = freeAt(b);
      return fa === fb ? i - j : fa < fb ? -1 : 1;
    })
    .map(({ item }) => item);
}
