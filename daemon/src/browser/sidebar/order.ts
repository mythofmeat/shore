import type { ThreadView } from "../../protocol/ThreadView.ts";

function rank(thread: ThreadView): number {
  return thread.home ? 2 : thread.heartbeat === true ? 1 : 0;
}

export function sortThreads(threads: readonly ThreadView[]): ThreadView[] {
  return [...threads].sort((a, b) => rank(b) - rank(a) || (b.last_active ?? b.created_at).localeCompare(a.last_active ?? a.created_at));
}
