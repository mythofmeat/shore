import { isTerminalMatrixError } from "./bot.ts";
import { attemptMatrixBridge, type BridgeHandle, type StartOptions } from "./start.ts";

export const RETRY_BASE_MS = 30_000;

export const RETRY_CAP_MS = 300_000;

export const STABLE_MS = 300_000;

export interface RetryTuning {
  readonly baseMs?: number;
  readonly capMs?: number;
  readonly stableMs?: number;
  readonly now?: () => number;
}

export interface SupervisorOptions extends StartOptions {
  readonly retry?: RetryTuning;
}

export interface SupervisedBridge {
  readonly done: Promise<void>;
  stop(): Promise<void>;
}

export function retryDelay(attempt: number, baseMs = RETRY_BASE_MS, capMs = RETRY_CAP_MS): number {
  return Math.min(capMs, baseMs * 2 ** attempt);
}

export function superviseMatrixBridge(options: SupervisorOptions): SupervisedBridge {
  const baseMs = options.retry?.baseMs ?? RETRY_BASE_MS;
  const capMs = options.retry?.capMs ?? RETRY_CAP_MS;
  const stableMs = options.retry?.stableMs ?? STABLE_MS;
  const now = options.retry?.now ?? Date.now;

  let stopped = false;
  let current: BridgeHandle | undefined;
  let wake: (() => void) | undefined;
  let attempt = 0;

  const pause = async (): Promise<void> => {
    const delayMs = retryDelay(attempt, baseMs, capMs);
    attempt += 1;
    options.log?.warn?.("Matrix bridge will retry", { in_ms: delayMs });
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      };
      timer = setTimeout(finish, delayMs);
      wake = finish;
    });
  };

  const giveUp = (error: unknown): void => {
    options.log?.warn?.("Matrix bridge disabled until the daemon restarts", {
      error: String(error),
    });
  };

  const done = (async () => {
    for (;;) {
      if (stopped) return;

      const outcome = await attemptMatrixBridge(options);
      if (outcome.kind === "off") return;
      if (outcome.kind === "failed") {
        if (isTerminalMatrixError(outcome.error)) return giveUp(outcome.error);
        if (stopped) return;
        await pause();
        continue;
      }

      current = outcome.handle;
      const startedAt = now();
      const fault = await Promise.race([
        outcome.handle.done.then(() => undefined),
        outcome.handle.faulted,
      ]);
      await outcome.handle.stop();
      current = undefined;

      if (stopped || fault === undefined) return;
      if (isTerminalMatrixError(fault)) return giveUp(fault);
      if (now() - startedAt >= stableMs) attempt = 0;
      await pause();
    }
  })();

  return {
    done,
    stop: async () => {
      stopped = true;
      wake?.();
      await current?.stop();
      await done;
    },
  };
}
