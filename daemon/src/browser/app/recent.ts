import type { ThreadView } from "../../protocol/ThreadView.ts";

export interface Visit { character: string; thread: string }

let last: Visit | undefined;
let before: Visit | undefined;

const at = (visit: Visit | undefined, character: string | null, thread: string | null): boolean => visit?.character === character && visit.thread === thread;

export function noteVisit(character: string, thread: string): void {
  if (at(last, character, thread)) return;
  before = last;
  last = { character, thread };
}

export function previousVisit(character: string | null, thread: string | null): Visit | undefined {
  return at(last, character, thread) ? before : last;
}

function recency(thread: ThreadView): string {
  return thread.last_active ?? thread.created_at;
}

export function switcherThreads(threads: readonly ThreadView[], current: string | null, previous: string | undefined): ThreadView[] {
  const others = threads.filter((thread) => thread.id !== current).sort((a, b) =>
    Number(a.archived !== undefined) - Number(b.archived !== undefined) || recency(b).localeCompare(recency(a)));
  const back = others.find((thread) => thread.id === previous);
  return back === undefined ? others : [back, ...others.filter((thread) => thread !== back)];
}
