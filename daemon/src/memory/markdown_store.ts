import { mkdir, realpath, stat } from "node:fs/promises";

class MarkdownStoreError extends Error {
  readonly kind = "io";

  constructor(detail: string) {
    super(`io: ${detail}`);
    this.name = "MarkdownStoreError";
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export class MarkdownMemoryStore {
  readonly #baseDir: string;

  private constructor(baseDir: string) {
    this.#baseDir = baseDir;
  }

  static async open(baseDir: string): Promise<MarkdownMemoryStore> {
    try {
      if (!(await exists(baseDir))) await mkdir(baseDir, { recursive: true });
      return new MarkdownMemoryStore(await realpath(baseDir));
    } catch (e) {
      throw new MarkdownStoreError((e as Error).message);
    }
  }

  get baseDir(): string {
    return this.#baseDir;
  }
}
