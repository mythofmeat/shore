export class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>();

  get heldKeys(): number {
    return this.#tails.size;
  }

  async withKey<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const result = previous.then(run, run);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, settled);
    void settled.then(() => {
      if (this.#tails.get(key) === settled) this.#tails.delete(key);
    });
    return await result;
  }
}
