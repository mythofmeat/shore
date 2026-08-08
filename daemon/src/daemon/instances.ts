import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { runtimeDir } from "../config/dirs.ts";

export interface InstanceInfo {
  id: string;
  pid: number;
  addr: string;
  started_at: string;
  data_dir?: string;
  config_dir?: string;
}

const STALE_LOCK_MS = 10_000;

const LOCK_TIMEOUT_MS = 5_000;

const LOCK_RETRY_MS = 20;

function defaultInstancesPath(env?: NodeJS.ProcessEnv): string {
  return join(runtimeDir(env), "instances.json");
}

export type PreservedBackup =
  | { written: true; path: string }
  | { written: false; path: string; cause: unknown };

export class CorruptInstances extends Error {
  constructor(
    readonly path: string,
    readonly backup: PreservedBackup,
    cause: unknown,
  ) {
    super(
      `corrupt registry JSON in ${path}: ${String(cause)}. ` +
        (backup.written
          ? `Preserved backup at ${backup.path}`
          : `The original bytes could NOT be preserved at ${backup.path}: ${String(backup.cause)}`),
    );
    this.name = "CorruptInstances";
  }
}

export class Instances {
  readonly path: string;

  constructor(path: string = defaultInstancesPath()) {
    this.path = path;
  }

  register(info: InstanceInfo): void {
    this.#withLock((entries) => {
      const kept = entries.filter((e) => e.id !== info.id);
      kept.push(info);
      return { entries: kept, value: undefined, changed: true };
    });
  }

  unregister(id: string): void {
    this.#withLock((entries) => {
      const kept = entries.filter((e) => e.id !== id);
      return { entries: kept, value: undefined, changed: kept.length !== entries.length };
    });
  }

  list(): InstanceInfo[] {
    return this.#withLock((entries) => ({ entries, value: [...entries], changed: false }));
  }

  get lockPath(): string {
    return this.path.replace(/\.[^./]*$/, "") + ".lock";
  }

  #withLock<T>(
    f: (entries: InstanceInfo[]) => { entries: InstanceInfo[]; value: T; changed: boolean },
  ): T {
    mkdirSync(dirname(this.path), { recursive: true });
    const release = takeLock(this.lockPath);
    try {
      const read = this.#read();
      const live = read.filter((entry) => !shouldPrune(pidState(entry.pid)));
      const pruned = live.length !== read.length;

      const { entries, value, changed } = f(live);
      if (pruned || changed) this.#write(entries);
      return value;
    } finally {
      release();
    }
  }

  #read(): InstanceInfo[] {
    let content: string;
    try {
      content = readFileSync(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    if (content.trim() === "") return [];

    try {
      return JSON.parse(content) as InstanceInfo[];
    } catch (cause) {
      throw new CorruptInstances(this.path, this.#preserve(content), cause);
    }
  }

  #write(entries: readonly InstanceInfo[]): void {
    const json = JSON.stringify(entries, null, 2);
    const tmp = join(dirname(this.path), `${basename(this.path)}.tmp`);
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, json);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
  }

  #preserve(content: string): PreservedBackup {
    const path = this.#corruptBackupPath();
    try {
      writeFileSync(path, content);
      return { written: true, path };
    } catch (cause) {
      return { written: false, path, cause };
    }
  }

  #corruptBackupPath(): string {
    const name = basename(this.path);
    const dot = name.lastIndexOf(".");
    const stem = dot <= 0 ? name : name.slice(0, dot);
    const ext = dot <= 0 ? "json" : name.slice(dot + 1);
    return join(dirname(this.path), `${stem}.corrupt-${Date.now()}.${ext}`);
  }
}

export function shouldPrune(state: ReturnType<typeof pidState>): boolean {
  return state === "dead";
}

export function takeLock(path: string, timeoutMs: number = LOCK_TIMEOUT_MS): () => void {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      closeSync(openSync(path, "wx"));
      return () => {
        try {
          rmSync(path, { force: true });
        } catch {
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }

    if (lockAgeMs(path) > STALE_LOCK_MS) {
      rmSync(path, { force: true });
      continue;
    }

    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for the instance registry lock at ${path}`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
  }
}

function lockAgeMs(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export function pidState(
  pid: number,
  probe: (pid: number) => void = (p) => void process.kill(p, 0),
): "alive" | "dead" | "unknown" {
  if (!Number.isInteger(pid) || pid <= 0) return "dead";
  try {
    probe(pid);
    return "alive";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}
