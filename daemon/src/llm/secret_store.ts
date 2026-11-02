import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SECRET_STORE_FILE = "provider_secrets.json";

type Secrets = Record<string, Record<string, string>>;

export function secretStorePath(dataDir: string): string {
  return join(dataDir, SECRET_STORE_FILE);
}

export class SecretStore {
  readonly path: string;
  #secrets: Secrets = {};
  #mtime: number | undefined = Number.NaN;

  constructor(path: string) {
    this.path = path;
  }

  #load(): Secrets {
    let mtime: number | undefined;
    try {
      mtime = statSync(this.path).mtimeMs;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      mtime = undefined;
    }
    if (mtime === this.#mtime) return this.#secrets;
    this.#mtime = mtime;
    this.#secrets = mtime === undefined ? {} : parseSecrets(readFileSync(this.path, "utf8"), this.path);
    return this.#secrets;
  }

  #save(next: Secrets): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = join(dirname(this.path), `.${crypto.randomUUID()}.tmp`);
    try {
      writeFileSync(tmp, `${JSON.stringify({ version: 1, providers: next }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.path);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    this.#secrets = next;
    this.#mtime = statSync(this.path).mtimeMs;
  }

  get(provider: string, name: string): string | undefined {
    const value = this.#load()[provider]?.[name];
    return value === undefined || value.trim() === "" ? undefined : value;
  }

  has(provider: string, name: string): boolean {
    return this.get(provider, name) !== undefined;
  }

  any(): boolean {
    return Object.values(this.#load()).some((keys) => Object.keys(keys).length > 0);
  }

  set(provider: string, name: string, value: string): void {
    const current = this.#load();
    this.#save({ ...current, [provider]: { ...current[provider], [name]: value } });
  }

  remove(provider: string, name: string): void {
    const current = this.#load();
    if (current[provider]?.[name] === undefined) return;
    const { [name]: _gone, ...rest } = current[provider];
    const next = { ...current, [provider]: rest };
    if (Object.keys(rest).length === 0) delete next[provider];
    this.#save(next);
  }

  rename(provider: string, from: string, to: string): void {
    const value = this.#load()[provider]?.[from];
    if (value === undefined) return;
    const { [from]: _gone, ...rest } = this.#load()[provider] ?? {};
    this.#save({ ...this.#load(), [provider]: { ...rest, [to]: value } });
  }

  removeProvider(provider: string): number {
    const current = this.#load();
    const count = Object.keys(current[provider] ?? {}).length;
    if (count === 0) return 0;
    const { [provider]: _gone, ...rest } = current;
    this.#save(rest);
    return count;
  }
}

function parseSecrets(text: string, path: string): Secrets {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  const providers = (parsed as { providers?: unknown } | null)?.providers;
  if (typeof providers !== "object" || providers === null || Array.isArray(providers)) return {};
  const out: Secrets = {};
  for (const [provider, keys] of Object.entries(providers as Record<string, unknown>)) {
    if (typeof keys !== "object" || keys === null || Array.isArray(keys)) continue;
    out[provider] = Object.fromEntries(Object.entries(keys as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  }
  return out;
}

const stores = new Map<string, SecretStore>();
let current: SecretStore | undefined;

export function secretStoreFor(dataDir: string): SecretStore {
  const path = secretStorePath(dataDir);
  let store = stores.get(path);
  if (store === undefined) {
    store = new SecretStore(path);
    stores.set(path, store);
  }
  return store;
}

export function configureSecretStore(dataDir: string | undefined): void {
  current = dataDir === undefined ? undefined : secretStoreFor(dataDir);
}

export function storedSecret(provider: string, name: string): string | undefined {
  return current?.get(provider, name);
}
