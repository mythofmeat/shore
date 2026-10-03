import type { ThreadView } from "../../protocol/ThreadView.ts";

export function sortThreads(threads: readonly ThreadView[]): ThreadView[] {
  return [...threads].sort((a, b) => Number(b.home) - Number(a.home) || (b.last_active ?? b.created_at).localeCompare(a.last_active ?? a.created_at));
}
