import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  acquireDataDirectoryLease,
  DATA_DIRECTORY_LEASE_FILE,
  DataDirectoryOwned,
  type DataDirectoryOwner,
} from "../src/daemon/data_directory_lease.ts";

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
