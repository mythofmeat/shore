import { describe, expect, test, afterEach, jest, spyOn } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { acquireDataDirectoryLease, DATA_DIRECTORY_LEASE_FILE, DATA_DIRECTORY_LOCK_FILE, DataDirectoryOwned, type DataDirectoryLease, type DataDirectoryOwner } from "../src/daemon/data_directory_lease.ts";
import { handlesUnder } from "./support/handles.ts";

const STARTED_AT = "2026-08-28T12:00:00+10:00";
const DEAD_PID = 0x7fff_fffe;

async function rootFor(name: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), `shore-data-lease-${name}-`));
}

function owner(over: Partial<DataDirectoryOwner> = {}): DataDirectoryOwner {
  return {
    version: 1,
    lease_id: "old-lease",
    instance_id: "old-daemon",
    pid: DEAD_PID,
    started_at: STARTED_AT,
    data_dir: "/old/data",
    ...over,
  };
}

describe("data-directory ownership", () => {
  test("is exclusive and identifies the live owner", async () => {
    const root = await rootFor("exclusive");
    try {
      const lease = acquireDataDirectoryLease(join(root, "data"), {
        instanceId: "daemon-a",
        startedAt: STARTED_AT,
      });

      let caught: unknown;
      try {
        acquireDataDirectoryLease(join(root, "data"), {
          instanceId: "daemon-b",
          startedAt: STARTED_AT,
        });
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(DataDirectoryOwned);
      expect((caught as Error).message).toContain("daemon-a");
      expect((caught as Error).message).toContain(`PID ${process.pid}`);
      expect((caught as Error).message).toContain("different SHORE_DATA_DIR");
      expect(lease.release()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the lifetime lock wins even when the owner record claims a dead process", async () => {
    const root = await rootFor("lifetime-lock");
    try {
      const data = join(root, "data");
      const lease = acquireDataDirectoryLease(data, {
        instanceId: "live-daemon",
        startedAt: STARTED_AT,
      });
      writeFileSync(lease.path, JSON.stringify(owner({ instance_id: "misleading-dead-owner" })));

      expect(() =>
        acquireDataDirectoryLease(data, {
          instanceId: "blocked",
          startedAt: STARTED_AT,
        })
      ).toThrow(DataDirectoryOwned);
      expect(lease.release()).toBe(false);

      const replacement = acquireDataDirectoryLease(data, {
        instanceId: "after-release",
        startedAt: STARTED_AT,
      });
      expect(replacement.owner.instance_id).toBe("after-release");
      replacement.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("canonical paths make symlink aliases share one owner", async () => {
    const root = await rootFor("alias");
    try {
      const data = join(root, "data");
      const alias = join(root, "alias");
      mkdirSync(data);
      symlinkSync(data, alias, "dir");
      const lease = acquireDataDirectoryLease(data, {
        instanceId: "canonical",
        startedAt: STARTED_AT,
      });

      expect(() =>
        acquireDataDirectoryLease(alias, {
          instanceId: "alias",
          startedAt: STARTED_AT,
        })
      ).toThrow(DataDirectoryOwned);
      expect(() =>
        acquireDataDirectoryLease(relative(process.cwd(), data), {
          instanceId: "relative",
          startedAt: STARTED_AT,
        })
      ).toThrow(DataDirectoryOwned);
      expect(lease.dataDir).toBe(data);
      lease.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a dead process owner is reclaimed", async () => {
    const root = await rootFor("dead");
    try {
      const data = join(root, "data");
      mkdirSync(data);
      const path = join(data, DATA_DIRECTORY_LEASE_FILE);
      writeFileSync(path, JSON.stringify(owner()));

      const lease = acquireDataDirectoryLease(data, {
        instanceId: "replacement",
        startedAt: STARTED_AT,
      });

      expect(lease.owner.instance_id).toBe("replacement");
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
        instance_id: "replacement",
        pid: process.pid,
      });
      lease.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an abandoned current-format record with a reused PID is reclaimed", async () => {
    const root = await rootFor("reused-pid");
    try {
      const data = join(root, "data");
      mkdirSync(data);
      const path = join(data, DATA_DIRECTORY_LEASE_FILE);
      writeFileSync(
        path,
        JSON.stringify(
          owner({ version: 2, pid: process.pid, process_start_id: "previous-process" }),
        ),
      );

      const lease = acquireDataDirectoryLease(data, {
        instanceId: "replacement",
        startedAt: STARTED_AT,
      });

      expect(lease.owner.instance_id).toBe("replacement");
      expect(lease.owner.process_start_id).not.toBe("previous-process");
      lease.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a legacy record from a previous process with the reused current PID is reclaimed", async () => {
    const root = await rootFor("legacy-reused-pid");
    try {
      const data = join(root, "data");
      mkdirSync(data);
      const path = join(data, DATA_DIRECTORY_LEASE_FILE);
      writeFileSync(
        path,
        JSON.stringify(
          owner({
            pid: process.pid,
            started_at: new Date(performance.timeOrigin - 60_000).toISOString(),
          }),
        ),
      );

      const lease = acquireDataDirectoryLease(data, {
        instanceId: "replacement",
        startedAt: new Date().toISOString(),
      });

      expect(lease.owner.instance_id).toBe("replacement");
      expect(lease.owner.process_start_id).toBeDefined();
      lease.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a legacy record created by the current process remains owned", async () => {
    const root = await rootFor("legacy-current-pid");
    try {
      const data = join(root, "data");
      mkdirSync(data);
      writeFileSync(
        join(data, DATA_DIRECTORY_LEASE_FILE),
        JSON.stringify(owner({ pid: process.pid, started_at: new Date().toISOString() })),
      );

      expect(() =>
        acquireDataDirectoryLease(data, {
          instanceId: "blocked",
          startedAt: new Date().toISOString(),
        })
      ).toThrow(DataDirectoryOwned);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an incomplete recent record is not stolen, but an abandoned one is recovered", async () => {
    const root = await rootFor("incomplete");
    try {
      const data = join(root, "data");
      mkdirSync(data);
      const path = join(data, DATA_DIRECTORY_LEASE_FILE);
      writeFileSync(path, "{");

      expect(() =>
        acquireDataDirectoryLease(data, {
          instanceId: "too-soon",
          startedAt: STARTED_AT,
        })
      ).toThrow(/cannot be verified/);

      const old = Date.now() / 1000 - 60;
      utimesSync(path, old, old);
      const lease = acquireDataDirectoryLease(data, {
        instanceId: "after-grace",
        startedAt: STARTED_AT,
      });
      expect(lease.owner.instance_id).toBe("after-grace");
      lease.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("release removes only the exact ownership record it acquired", async () => {
    const root = await rootFor("replacement");
    try {
      const data = join(root, "data");
      const lease = acquireDataDirectoryLease(data, {
        instanceId: "original",
        startedAt: STARTED_AT,
      });
      unlinkSync(lease.path);
      writeFileSync(
        lease.path,
        JSON.stringify(owner({ lease_id: "replacement", pid: process.pid })),
      );

      expect(lease.release()).toBe(false);
      expect(existsSync(lease.path)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the record is owner-only and clean release is idempotent", async () => {
    const root = await rootFor("mode");
    try {
      const lease = acquireDataDirectoryLease(join(root, "data"), {
        instanceId: "secure",
        startedAt: STARTED_AT,
      });
      expect(statSync(lease.path).mode & 0o777).toBe(0o600);

      expect(lease.release()).toBe(true);
      expect(lease.release()).toBe(true);
      expect(existsSync(lease.path)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("data-directory ownership edges", () => {
  const take = (data: string, instanceId: string): DataDirectoryLease => acquireDataDirectoryLease(data, { instanceId, startedAt: STARTED_AT });
  const failureOf = (attempt: () => unknown): unknown => {
    try {
      attempt();
    } catch (e) {
      return e;
    }
    throw new Error("the attempt succeeded");
  };
  async function inData(name: string, body: (data: string, leasePath: string) => void | Promise<void>): Promise<void> {
    const root = await rootFor(name);
    try {
      const data = join(root, "data");
      mkdirSync(data);
      await body(data, join(realpathSync.native(data), DATA_DIRECTORY_LEASE_FILE));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  test("the record is two-space JSON with a newline, and taking it leaves no acquisition lock or handle behind", async () => {
    await inData("format", (data) => {
      const before = handlesUnder(data);
      const lease = take(data, "formatted");
      expect(readFileSync(lease.path, "utf8")).toBe(`${JSON.stringify(lease.owner, null, 2)}\n`);
      expect(existsSync(`${lease.path}.acquire`)).toBe(false);
      lease.release();
      expect([before, handlesUnder(data)]).toEqual([0, 0]);
    });
  });

  test("a refused daemon leaves no handle open once the owner lets go", async () => {
    await inData("refused-handles", (data) => {
      const before = handlesUnder(data);
      const lease = take(data, "holder");
      expect(failureOf(() => take(data, "refused"))).toBeInstanceOf(DataDirectoryOwned);
      expect(failureOf(() => take(data, "refused again"))).toBeInstanceOf(DataDirectoryOwned);
      lease.release();
      expect([before, handlesUnder(data)]).toEqual([0, 0]);
    });
  });

  test("a lifetime lock that can't be opened is an error, not an owner", async () => {
    await inData("lock-directory", (data) => {
      mkdirSync(join(data, DATA_DIRECTORY_LOCK_FILE));
      expect(failureOf(() => take(data, "blocked"))).toMatchObject({ code: "SQLITE_CANTOPEN" });
    });
  });

  test("a stale acquisition lock that can't be cleared is reported, and frees the data directory again", async () => {
    await inData("stuck-acquire", (data, leasePath) => {
      mkdirSync(`${leasePath}.acquire`);
      const old = Date.now() / 1000 - 60;
      utimesSync(`${leasePath}.acquire`, old, old);
      expect(failureOf(() => take(data, "blocked"))).toMatchObject({ code: "ERR_FS_EISDIR" });
      rmdirSync(`${leasePath}.acquire`);
      take(data, "after").release();
    });
  });

  test("a record path that never resolves is tried eight times, then reported", async () => {
    await inData("dangling", (data, leasePath) => {
      symlinkSync(join(data, "nowhere"), leasePath);
      const opened = spyOn(fs, "openSync");
      let failure: unknown;
      let attempts: number;
      try {
        failure = failureOf(() => take(data, "blocked"));
        attempts = opened.mock.calls.filter(([path, flags]) => path === leasePath && flags === "wx").length;
      } finally {
        opened.mockRestore();
      }
      expect(failure).toMatchObject({ message: `could not acquire Shore data-directory ownership at ${leasePath}` });
      expect(attempts).toBe(8);
    });
  });

  test("a record that can't be created or flushed is reported, leaves nothing behind, and frees the data directory", async () => {
    await inData("unwritable", (data, leasePath) => {
      const refusal = Object.assign(new Error("permission denied"), { code: "EACCES" });
      const realOpen = fs.openSync;
      const open = spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, ...rest: [fs.OpenMode, fs.Mode]) => {
        if (path === leasePath) throw refusal;
        return realOpen(path, ...rest);
      }) as typeof fs.openSync);
      try {
        expect(failureOf(() => take(data, "blocked"))).toBe(refusal);
      } finally {
        open.mockRestore();
      }
      const full = Object.assign(new Error("no space left"), { code: "ENOSPC" });
      const flush = spyOn(fs, "fsyncSync").mockImplementation(() => {
        throw full;
      });
      try {
        expect(failureOf(() => take(data, "blocked"))).toBe(full);
      } finally {
        flush.mockRestore();
      }
      expect(existsSync(leasePath)).toBe(false);
      take(data, "after").release();
    });
  });

  test.skipIf(process.getuid?.() === 0)("a record that can't be read is reported rather than taken over", async () => {
    await inData("unreadable", (data, leasePath) => {
      writeFileSync(leasePath, JSON.stringify(owner()));
      chmodSync(leasePath, 0o000);
      try {
        expect(failureOf(() => take(data, "blocked"))).toMatchObject({ code: "EACCES" });
      } finally {
        chmodSync(leasePath, 0o600);
      }
    });
  });

  test("a record that doesn't parse is taken over only once it is more than ten seconds old", async () => {
    await inData("grace", (data, leasePath) => {
      const now = 1_800_000_000_000;
      jest.useFakeTimers();
      try {
        jest.setSystemTime(now);
        writeFileSync(leasePath, "{");
        utimesSync(leasePath, (now - 10_000) / 1000, (now - 10_000) / 1000);
        expect(failureOf(() => take(data, "too-soon"))).toBeInstanceOf(DataDirectoryOwned);
        utimesSync(leasePath, (now - 10_001) / 1000, (now - 10_001) / 1000);
        take(data, "after-grace").release();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  test("a current-format record is taken over once its lifetime lock is free, even naming this live process", async () => {
    await inData("current-format", (data) => {
      const first = take(data, "first");
      const record = readFileSync(first.path, "utf8");
      first.release();
      writeFileSync(first.path, record);
      const second = take(data, "second");
      expect(second.owner.instance_id).toBe("second");
      second.release();
    });
  });

  test("a legacy record that carries a process start is judged by it, and one naming another live process stays owned", async () => {
    await inData("legacy-start", (data, leasePath) => {
      const probe = take(data, "probe");
      const ours = probe.owner.process_start_id;
      probe.release();
      writeFileSync(leasePath, JSON.stringify(owner({ pid: process.pid, ...(ours === undefined ? {} : { process_start_id: ours }) })));
      expect(failureOf(() => take(data, "blocked"))).toBeInstanceOf(DataDirectoryOwned);
      writeFileSync(leasePath, JSON.stringify(owner({ pid: process.pid, process_start_id: "an-earlier-run" })));
      take(data, "after-restart").release();
      writeFileSync(leasePath, JSON.stringify(owner({ pid: process.ppid, started_at: new Date(performance.timeOrigin - 60_000).toISOString() })));
      expect(failureOf(() => take(data, "blocked"))).toBeInstanceOf(DataDirectoryOwned);
    });
  });

  test("only a complete, well-formed record names its owner", async () => {
    await inData("parse", (data) => {
      const lease = take(data, "holder");
      const named = (record: unknown): DataDirectoryOwner | undefined => {
        writeFileSync(lease.path, typeof record === "string" ? record : JSON.stringify(record));
        const failure = failureOf(() => take(data, "second"));
        if (!(failure instanceof DataDirectoryOwned)) throw failure;
        return failure.owner;
      };
      const valid: DataDirectoryOwner = { version: 1, lease_id: "l", instance_id: "i", pid: 1, started_at: STARTED_AT, data_dir: "/d" };
      expect(named(valid)).toStrictEqual(valid);
      const current: DataDirectoryOwner = { ...valid, version: 2, process_start_id: "s" };
      expect(named(current)).toStrictEqual(current);
      for (const broken of [
        "{", "null", "5",
        { ...valid, version: 3 },
        { ...valid, lease_id: 7 }, { ...valid, lease_id: "" },
        { ...valid, instance_id: 7 }, { ...valid, instance_id: "" },
        { ...valid, pid: "1" }, { ...valid, pid: 1.5 }, { ...valid, pid: 0 }, { ...valid, pid: -1 },
        { ...valid, process_start_id: 7 }, { ...valid, process_start_id: "" },
        { ...valid, version: 2 },
        { ...valid, started_at: 7 }, { ...valid, data_dir: 7 },
      ]) {
        expect(named(broken), JSON.stringify(broken)).toBeUndefined();
      }
      writeFileSync(lease.path, `${JSON.stringify(lease.owner, null, 2)}\n`);
      expect(lease.release()).toBe(true);
    });
  });

  describe("a release racing another daemon", () => {
    function racing(lease: DataDirectoryLease, before: () => void): { restore: () => void } {
      const realStat = fs.statSync;
      let calls = 0;
      const stat = spyOn(fs, "statSync").mockImplementation(((path: fs.PathLike, options?: fs.StatOptions) => {
        if (path === lease.path && ++calls === 2) before();
        return realStat(path, options);
      }) as typeof fs.statSync);
      return { restore: () => stat.mockRestore() };
    }

    test("leaves a record swapped in just before removal", async () => {
      await inData("swapped", (data) => {
        const lease = take(data, "mine");
        const theirs = JSON.stringify(owner({ lease_id: "theirs" }));
        const race = racing(lease, () => {
          writeFileSync(`${lease.path}.new`, theirs);
          renameSync(`${lease.path}.new`, lease.path);
        });
        try {
          expect(lease.release()).toBe(false);
        } finally {
          race.restore();
        }
        expect(readFileSync(lease.path, "utf8")).toBe(theirs);
      });
    });

    test("doesn't count a record that vanished just before removal as removed", async () => {
      await inData("vanished", (data) => {
        const lease = take(data, "mine");
        const race = racing(lease, () => {
          unlinkSync(lease.path);
        });
        try {
          expect(lease.release()).toBe(false);
        } finally {
          race.restore();
        }
      });
    });

    test("reports a record it can no longer look at, and still frees the data directory", async () => {
      await inData("unstatable", (data) => {
        const lease = take(data, "mine");
        const refusal = Object.assign(new Error("permission denied"), { code: "EACCES" });
        const race = racing(lease, () => {
          throw refusal;
        });
        try {
          expect(failureOf(() => lease.release())).toBe(refusal);
        } finally {
          race.restore();
        }
        take(data, "after").release();
      });
    });
  });
});

const DAEMON_DIR = new URL("..", import.meta.url).pathname;
const TOKEN = "process-test-token";
const START_MS = 30_000;
const STEP_MS = 10_000;
const startsAndSteps = (starts: number, steps: number): number => starts * START_MS + steps * STEP_MS + 5_000;
const children: Bun.Subprocess<"ignore", "ignore", "pipe">[] = [];

interface ProcessLayout {
  readonly configPath: string;
  readonly env: Record<string, string>;
  readonly instancesPath: string;
  readonly readyPath: string;
}

afterEach(async () => {
  for (const child of children) child.kill("SIGTERM");
  await Promise.allSettled(children.map(async (child) => await child.exited));
  children.length = 0;
});

async function processRoot(name: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), `shore-owner-process-${name}-`));
}

async function processLayout(
  root: string,
  name: string,
  dataDir: string,
): Promise<ProcessLayout> {
  const base = join(root, name);
  const configDir = join(base, "config");
  const runtimeDir = join(root, "runtime");
  await mkdir(configDir, { recursive: true });
  const configPath = join(configDir, "config.toml");
  await writeFile(configPath, "");
  return {
    configPath,
    instancesPath: join(runtimeDir, "instances.json"),
    readyPath: join(base, "ready"),
    env: {
      ...stringEnvironment(process.env),
      SHORE_CONFIG_DIR: configDir,
      SHORE_DATA_DIR: dataDir,
      SHORE_CACHE_DIR: join(base, "cache"),
      SHORE_RUNTIME_DIR: runtimeDir,
      SHORE_TEST_READY_FILE: join(base, "ready"),
      SHORE_TOKEN: TOKEN,
    },
  };
}

function stringEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function spawnDaemon(layout: ProcessLayout, instanceId: string) {
  const child = Bun.spawn(
    [
      "bun",
      "run",
      "tests/support/owned_daemon.ts",
      "--config",
      layout.configPath,
      "--addr",
      "127.0.0.1:0",
      "--instance-id",
      instanceId,
    ],
    {
      cwd: DAEMON_DIR,
      env: layout.env,
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  children.push(child);
  return child;
}

async function instanceIds(path: string): Promise<string[]> {
  try {
    const entries = JSON.parse(await readFile(path, "utf8")) as Array<{ id: string }>;
    return entries.map((entry) => entry.id).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

async function waitForInstances(path: string, expected: readonly string[], withinMs: number): Promise<void> {
  const wanted = [...expected].sort();
  const deadline = Date.now() + withinMs;
  for (;;) {
    const actual = await instanceIds(path);
    if (JSON.stringify(actual) === JSON.stringify(wanted)) return;
    if (Date.now() >= deadline) {
      throw new Error(`expected instances ${JSON.stringify(wanted)}, saw ${JSON.stringify(actual)}`);
    }
    await Bun.sleep(20);
  }
}

async function waitUntilReady(layout: ProcessLayout, instanceId: string): Promise<void> {
  const deadline = Date.now() + START_MS;
  for (;;) {
    try {
      if ((await readFile(layout.readyPath, "utf8")).trim() === "ready") return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (Date.now() >= deadline) throw new Error(`${instanceId} did not become ready within ${String(START_MS)}ms`);
    await Bun.sleep(20);
  }
}

async function exitWithin(
  child: Bun.Subprocess<"ignore", "ignore", "pipe">,
  withinMs: number = STEP_MS,
): Promise<number> {
  return await Promise.race([
    child.exited,
    Bun.sleep(withinMs).then(() => {
      throw new Error(`daemon did not exit within ${String(withinMs)}ms`);
    }),
  ]);
}

describe("daemon processes owning data directories", () => {

  test("a second process cannot open the same data directory", async () => {
    const root = await processRoot("same");
    const dataDir = join(root, "shared-data");
    const firstLayout = await processLayout(root, "first", dataDir);
    const secondLayout = await processLayout(root, "second", dataDir);
    const first = spawnDaemon(firstLayout, "first-owner");
    await waitUntilReady(firstLayout, "first-owner");

    const second = spawnDaemon(secondLayout, "blocked-owner");
    expect(await exitWithin(second, START_MS)).toBe(1);
    const error = await new Response(second.stderr).text();
    expect(error).toContain("already in use");
    expect(error).toContain("first-owner");
    expect(error).toContain("different SHORE_DATA_DIR");
    await waitForInstances(firstLayout.instancesPath, ["first-owner"], STEP_MS);

    first.kill("SIGTERM");
    expect(await exitWithin(first)).toBe(0);
    await waitForInstances(firstLayout.instancesPath, [], STEP_MS);

    const replacement = spawnDaemon(secondLayout, "replacement-owner");
    await waitUntilReady(secondLayout, "replacement-owner");
    replacement.kill("SIGTERM");
    expect(await exitWithin(replacement)).toBe(0);
  }, startsAndSteps(3, 4));

  test("an owner killed without cleanup is safely reclaimed", async () => {
    const root = await processRoot("stale");
    const dataDir = join(root, "shared-data");
    const crashedLayout = await processLayout(root, "crashed", dataDir);
    const replacementLayout = await processLayout(root, "replacement", dataDir);
    const crashed = spawnDaemon(crashedLayout, "crashed-owner");
    await waitUntilReady(crashedLayout, "crashed-owner");

    crashed.kill("SIGKILL");
    expect(await exitWithin(crashed)).not.toBe(0);

    const replacement = spawnDaemon(replacementLayout, "recovered-owner");
    await waitUntilReady(replacementLayout, "recovered-owner");
    replacement.kill("SIGTERM");
    expect(await exitWithin(replacement)).toBe(0);
  }, startsAndSteps(2, 2));
});
