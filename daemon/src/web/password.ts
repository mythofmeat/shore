import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const PASSWORD_FILE = "password";
export const PASSWORD_RULE = "Choose a password of at least 8 characters";
const SHORTEST = 8;
const HASHING = { algorithm: "argon2id", memoryCost: 19_456, timeCost: 2 } as const;

export function acceptablePassword(password: string): boolean {
  return Array.from(password).length >= SHORTEST;
}

export class PasswordFileError extends Error {
  override readonly name = "PasswordFileError";
}

export class PasswordStore {
  readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, PASSWORD_FILE);
  }

  #hash(): string | undefined {
    try { return readFileSync(this.path, "utf8").trim(); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  isSet(): boolean {
    return this.#hash() !== undefined;
  }

  async matches(password: string): Promise<boolean> {
    const hash = this.#hash();
    if (hash === undefined) return false;
    try { return await Bun.password.verify(password, hash); } catch {
      throw new PasswordFileError(`${this.path} doesn’t hold a password Shore set. Delete it, then choose the password again.`);
    }
  }

  async choose(password: string): Promise<boolean> {
    const written = await this.#written(password);
    try {
      linkSync(written, this.path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally {
      rmSync(written);
    }
  }

  async change(password: string): Promise<void> {
    const written = await this.#written(password);
    try { renameSync(written, this.path); } catch (error) {
      rmSync(written);
      throw error;
    }
  }

  async #written(password: string): Promise<string> {
    const hash = await Bun.password.hash(password, HASHING);
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = join(dirname(this.path), `.${crypto.randomUUID()}.tmp`);
    writeFileSync(temporary, `${hash}\n`, { mode: 0o600 });
    return temporary;
  }
}
