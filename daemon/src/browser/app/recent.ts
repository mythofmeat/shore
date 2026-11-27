import type { ThreadView } from "../../protocol/ThreadView.ts";
import type { CharacterThreadsView } from "../sidebar/order.ts";

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

export interface SwitcherThread { character: string; thread: ThreadView }

export function switcherThreads(groups: readonly CharacterThreadsView[], here: { character: string | null; thread: string | null }, previous: Visit | undefined): SwitcherThread[] {
  const others = groups.flatMap(({ character, threads }) => threads.filter((thread) => character !== here.character || thread.id !== here.thread).map((thread) => ({ character, thread })))
    .sort((a, b) => Number(a.thread.archived !== undefined) - Number(b.thread.archived !== undefined) || recency(b.thread).localeCompare(recency(a.thread)));
  const back = others.find((each) => each.character === previous?.character && each.thread.id === previous.thread);
  return back === undefined ? others : [back, ...others.filter((each) => each !== back)];
}
