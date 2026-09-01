type Release = () => void;

interface Waiter {
  readonly exclusive: boolean;
  readonly resolve: (release: Release) => void;
}

export class SnapshotGate {
  #readers = 0;
  #writer = false;
  readonly #waiters: Waiter[] = [];

  async withActivity<T>(run: () => Promise<T>): Promise<T> {
    const release = await this.#acquire(false);
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

  #acquire(exclusive: boolean): Promise<Release> {
    return new Promise((resolve) => {
      this.#waiters.push({ exclusive, resolve });
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
      const reader = this.#waiters.shift();
      if (reader === undefined) break;
      this.#readers += 1;
      reader.resolve(() => {
        this.#readers -= 1;
        this.#drain();
      });
    }
  }
}
