/**
 * Which daemons are running, and where to reach them.
 *
 * Ported from `crates/daemon/src/swp_server/registry.rs`. Named for what it
 * holds rather than where the Rust filed it — this is daemon discovery, not
 * part of the SWP protocol, and "registry" is already three other things here.
 *
 * One JSON file at `$SHORE_RUNTIME_DIR/instances.json`, written by a daemon at
 * startup and shutdown, and read by every CLI that needs to find one. The
 * entries carry the resolved data and config directories so a client can read
 * the same ledger and the same `config.toml` without being told where they are.
 *
 * # Dead entries prune themselves
 *
 * A daemon that is killed never unregisters, so every operation — including
 * `list` — first drops entries whose PID is gone. That is why a read can write:
 * the alternative is a registry that fills with corpses and a client that
 * dials one.
 *
 * The liveness probe is signal 0, which asks the kernel about a PID without
 * sending anything. It has three answers, not two: alive, dead, and *unknown*
 * — a PID owned by another user answers `EPERM`, which means it exists. Only a
 * definite `ESRCH` prunes.
 *
 * # The lock is not the Rust's lock
 *
 * The Rust holds `flock` on a stable sidecar file for the whole
 * read-modify-write. There is no portable `flock` here, so this uses the other
 * classic: an exclusively-created lock file, whose *existence* is the lock.
 *
 * The two differ in exactly one way and it is the one that matters. `flock` is
 * released by the kernel when the process dies; a lock file is not, so a daemon
 * killed mid-write would wedge every later reader forever. {@link STALE_LOCK_MS}
 * is the answer: a lock older than that is assumed abandoned and broken. It is
 * generous, because breaking a lock someone still holds is the failure this is
 * trying to prevent, and a write here takes microseconds.
 */

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

import { runtimeDir } from "./config/dirs.ts";

/** One daemon instance, exactly as it appears in the file. */
export interface InstanceInfo {
  id: string;
  pid: number;
  addr: string;
  started_at: string;
  /** Resolved data directory, so CLI commands can find the ledger. */
  data_dir?: string;
  /** Resolved config directory, so clients read the same `config.toml`. */
  config_dir?: string;
}

/** How long a lock file may exist before it is treated as abandoned. */
export const STALE_LOCK_MS = 10_000;

/** How long to wait for a held lock before giving up. */
export const LOCK_TIMEOUT_MS = 5_000;

/** How long to sleep between attempts to take the lock. */
const LOCK_RETRY_MS = 20;

/** The default file: `$SHORE_RUNTIME_DIR/instances.json`. */
export function defaultInstancesPath(env?: NodeJS.ProcessEnv): string {
  return join(runtimeDir(env), "instances.json");
}

/**
 * Corrupt JSON in the registry, with the backup that was kept.
 *
 * A hard failure rather than "start from empty", and deliberately: the file
 * names running processes, and silently discarding it makes every other daemon
 * on the machine unreachable with no record of why. The content is preserved
 * first so the state that caused it survives the report.
 */
export class CorruptInstances extends Error {
  constructor(
    readonly path: string,
    readonly backup: string,
    cause: unknown,
  ) {
    super(`corrupt registry JSON in ${path}: ${String(cause)}. Preserved backup at ${backup}`);
    this.name = "CorruptInstances";
  }
}

/** The registry file at a known path. */
export class Instances {
  readonly path: string;

  constructor(path: string = defaultInstancesPath()) {
    this.path = path;
  }

  /** Add an instance, replacing any earlier entry with the same id. */
  register(info: InstanceInfo): void {
    this.#withLock((entries) => {
      const kept = entries.filter((e) => e.id !== info.id);
      kept.push(info);
      // Always dirty: a re-registration with identical fields still has to
      // reach disk, because the previous entry may have been pruned as dead
      // and this is the same daemon coming back.
      return { entries: kept, value: undefined, changed: true };
    });
  }

  /** Drop an instance by id. */
  unregister(id: string): void {
    this.#withLock((entries) => {
      const kept = entries.filter((e) => e.id !== id);
      return { entries: kept, value: undefined, changed: kept.length !== entries.length };
    });
  }

  /** Every live instance. Prunes dead ones on the way past. */
  list(): InstanceInfo[] {
    return this.#withLock((entries) => ({ entries, value: [...entries], changed: false }));
  }

  /** The sidecar lock, beside the file. `.json` → `.lock`, as the Rust's. */
  get lockPath(): string {
    return this.path.replace(/\.[^./]*$/, "") + ".lock";
  }

  /**
   * Read, prune, modify, write — with nobody else in the middle.
   *
   * The prune runs before `f` and its result is OR-ed into whether anything
   * changed, so a `list` that found a corpse still writes the file it cleaned.
   */
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
    // An empty file is a registry nobody has written to yet, not a corrupt one
    // — a crash between `open` and `write` leaves exactly this.
    if (content.trim() === "") return [];

    try {
      return JSON.parse(content) as InstanceInfo[];
    } catch (cause) {
      throw new CorruptInstances(this.path, this.#preserve(content), cause);
    }
  }

  /**
   * Write via a sibling temp file and a rename.
   *
   * Beside the target rather than in a temp directory, because `rename` is only
   * atomic within one filesystem. `fsync` before the rename so a machine that
   * loses power finds either the old file or the new one, never a renamed
   * length of zeroes.
   */
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

  /** Keep the unparseable content, and answer where it went. */
  #preserve(content: string): string {
    const backup = this.#corruptBackupPath();
    try {
      writeFileSync(backup, content);
    } catch {
      // The report is worth more than the backup. A directory that will not
      // take the copy is the same directory the registry is in, so the caller
      // is about to hear about it anyway.
    }
    return backup;
  }

  #corruptBackupPath(): string {
    const name = basename(this.path);
    const dot = name.lastIndexOf(".");
    const stem = dot <= 0 ? name : name.slice(0, dot);
    const ext = dot <= 0 ? "json" : name.slice(dot + 1);
    return join(dirname(this.path), `${stem}.corrupt-${Date.now()}.${ext}`);
  }
}

/**
 * Whether an entry with this liveness goes.
 *
 * A named decision rather than a comparison in the filter, because the answer
 * is three-way and only one of the three prunes. `unknown` — a probe that
 * failed for its own reasons — leaves the entry alone: deleting a daemon
 * because the kernel would not answer a question about it is the failure this
 * whole probe exists to avoid.
 */
export function shouldPrune(state: ReturnType<typeof pidState>): boolean {
  return state === "dead";
}

/**
 * Take the lock, and answer with how to release it.
 *
 * `wx` fails if the file exists, which is the whole mechanism: creation is
 * atomic, so exactly one caller can succeed. Waiting is a sleep-and-retry loop
 * because there is nothing to block on — and a lock whose file is older than
 * {@link STALE_LOCK_MS} is broken rather than waited on, since its holder is
 * the one thing that cannot tell us it died.
 */
export function takeLock(path: string, timeoutMs: number = LOCK_TIMEOUT_MS): () => void {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      closeSync(openSync(path, "wx"));
      return () => {
        try {
          rmSync(path, { force: true });
        } catch {
          // Someone broke it as stale and took it themselves. Removing theirs
          // would be worse than leaving this.
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

/** How long the lock file has existed. Absent means it just went away. */
function lockAgeMs(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Whether a PID names a live process.
 *
 * Signal 0 checks existence and permission without delivering anything.
 * `EPERM` is a *live* process owned by someone else, so only `ESRCH` counts as
 * dead — anything else is unknown and is left alone, because pruning on a
 * probe that failed for its own reasons deletes a running daemon.
 */
export function pidState(
  pid: number,
  /**
   * The probe. A parameter because the third branch is otherwise unreachable
   * from a test — signal 0 on a real PID only ever answers `ESRCH` or `EPERM`
   * — and what it decides is whether an unrecognised failure deletes a running
   * daemon from the registry.
   */
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
