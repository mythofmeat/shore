import { CharacterWorkspace } from "../tools/character_workspace.ts";

class MarkdownStoreError extends Error {
  readonly kind = "io";

  constructor(detail: string) {
    super(`io: ${detail}`);
    this.name = "MarkdownStoreError";
  }
}

export class MarkdownMemoryStore {
  readonly #baseDir: string;

  private constructor(baseDir: string) {
    this.#baseDir = baseDir;
  }

  static async open(baseDir: string, workspace: CharacterWorkspace = new CharacterWorkspace(baseDir)): Promise<MarkdownMemoryStore> {
    try {
      await workspace.call("mkdir", { path: baseDir });
      return new MarkdownMemoryStore(await workspace.call("realpath", { path: baseDir }));
    } catch (e) {
      throw new MarkdownStoreError((e as Error).message);
    }
  }

  get baseDir(): string {
    return this.#baseDir;
  }
}
