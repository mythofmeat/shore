import type { HeartbeatView } from "../autonomy/service.ts";
import { rfc3339 } from "../commands/status.ts";
import type { GenerationView } from "../handler/router.ts";
import { runningPasses } from "../memory/compaction/activity.ts";
import type { RunningStatusReport } from "../protocol/RunningStatusReport.ts";
import type { RunningWork } from "../protocol/RunningWork.ts";
import type { RunningWorkKind } from "../protocol/RunningWorkKind.ts";

export interface ShutdownWindowState {
  readonly requestedAt: number;
  readonly deadline: number;
}

export interface RunningSources {
  readonly dataDir: string;
  readonly generations: () => readonly GenerationView[];
  readonly heartbeats: () => readonly HeartbeatView[];
  readonly shutdown: () => ShutdownWindowState | undefined;
  readonly now?: () => number;
}

export function runningReport(sources: RunningSources): RunningStatusReport {
  const now = (sources.now ?? Date.now)();
  const item = (kind: RunningWorkKind, character: string, thread: string | null, startedAt: number) => ({
    startedAt,
    report: {
      kind,
      character,
      thread,
      started_at: rfc3339(startedAt),
      running_secs: Math.max(0, Math.trunc((now - startedAt) / 1000)),
    } satisfies RunningWork,
  });
  const work = [
    ...sources.generations().map((g) => item("message", g.character, g.thread, g.startedAt)),
    ...sources.heartbeats().map((h) => item("heartbeat", h.character, null, h.startedAt)),
    ...runningPasses(sources.dataDir).map((p) => item("compaction", p.character, p.thread, p.startedAt)),
  ]
    .toSorted((a, b) => a.startedAt - b.startedAt)
    .map(({ report }) => report);
  const window = sources.shutdown();
  return {
    work,
    shutdown: window === undefined
      ? null
      : { requested_at: rfc3339(window.requestedAt), deadline: rfc3339(window.deadline) },
  };
}

export function describeWork(work: readonly RunningWork[]): string {
  return work.map((item) => `${item.kind} for ${item.character} (${item.running_secs}s)`).join(", ");
}
