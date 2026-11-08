import { required } from "./util/required.ts";

type Release = () => void;

function abandoned(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new Error("stopped waiting for the snapshot gate");
}

interface Waiter {
  readonly exclusive: boolean;
  readonly resolve: (release: Release) => void;
}

export class SnapshotGate {
  #readers = 0;
  #writer = false;
  readonly #waiters: Waiter[] = [];

  async withActivity<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.#acquire(false, signal);
    try {
      return await run();
    } finally {
      release();
    }
  }

  async withSnapshot<T>(run: () => Promise<T>): Promise<T> {
    const release = await this.#acquire(true);
    try {
      return await run();
    } finally {
      release();
    }
  }

  #acquire(exclusive: boolean, signal?: AbortSignal): Promise<Release> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(abandoned(signal));
        return;
      }
      const abandon = () => {
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        reject(abandoned(signal));
      };
      const waiter: Waiter = {
        exclusive,
        resolve: (release) => {
          signal?.removeEventListener("abort", abandon);
          resolve(release);
        },
      };
      signal?.addEventListener("abort", abandon);
      this.#waiters.push(waiter);
      this.#drain();
    });
  }

  #drain(): void {
    if (this.#writer || this.#waiters.length === 0) return;
    const first = this.#waiters[0];
    if (first?.exclusive === true) {
      if (this.#readers !== 0) return;
      this.#waiters.shift();
      this.#writer = true;
      first.resolve(() => {
        this.#writer = false;
        this.#drain();
      });
      return;
    }
    while (this.#waiters[0]?.exclusive === false) {
      const reader = required(this.#waiters.shift());
      this.#readers += 1;
      reader.resolve(() => {
        this.#readers -= 1;
        this.#drain();
      });
    }
  }
}
