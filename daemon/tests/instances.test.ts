import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CorruptInstances,
  Instances,
  pidState,
  shouldPrune,
  takeLock,
  type InstanceInfo,
} from "../src/daemon/instances.ts";

async function registryIn(prefix: string): Promise<{ root: string; instances: Instances }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return { root, instances: new Instances(join(root, "shore", "instances.json")) };
}

function sample(id: string, over: Partial<InstanceInfo> = {}): InstanceInfo {
  return {
    id,
    pid: process.pid,
    addr: `127.0.0.1:${7320 + id.length}`,
    started_at: "2026-01-01T00:00:00+00:00",
    ...over,
  };
}

const DEAD_PID = 0x7fff_fffe;

describe("registering and listing", () => {
  test("an entry survives the round trip whole", async () => {
    const { root, instances } = await registryIn("shore-instances-round-");
    try {
      const info = sample("test-1", { data_dir: "/d", config_dir: "/c" });
      instances.register(info);

      expect(instances.list()).toEqual([info]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("re-registering the same id replaces rather than duplicates", async () => {
    const { root, instances } = await registryIn("shore-instances-replace-");
    try {
      instances.register(sample("test-4"));
      instances.register(sample("test-4", { addr: "127.0.0.1:9999" }));

      const entries = instances.list();
      expect(entries.length).toBe(1);
      expect(entries[0]?.addr).toBe("127.0.0.1:9999");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("unregistering leaves the others alone", async () => {
    const { root, instances } = await registryIn("shore-instances-unreg-");
    try {
      instances.register(sample("daemon-a"));
      instances.register(sample("daemon-b"));
      instances.unregister("daemon-a");

      expect(instances.list().map((e) => e.id)).toEqual(["daemon-b"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("no file yet is an empty list, not a failure", async () => {
    const { root, instances } = await registryIn("shore-instances-absent-");
    try {
      expect(instances.list()).toEqual([]);
      expect(existsSync(instances.path)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an empty file is an unwritten registry, not a corrupt one", async () => {
    const { root, instances } = await registryIn("shore-instances-empty-");
    try {
      mkdirSync(join(root, "shore"), { recursive: true });
      writeFileSync(instances.path, "   \n");

      expect(instances.list()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("pruning the dead", () => {
  test("listing drops an entry whose process is gone", async () => {
    const { root, instances } = await registryIn("shore-instances-prune-");
    try {
      instances.register(sample("ghost", { pid: DEAD_PID }));
      instances.register(sample("live"));

      expect(instances.list().map((e) => e.id)).toEqual(["live"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the prune reaches disk, so a read is not repeated every time", async () => {
    const { root, instances } = await registryIn("shore-instances-prunedisk-");
    try {
      instances.register(sample("ghost", { pid: DEAD_PID }));
      instances.list();

      expect(JSON.parse(readFileSync(instances.path, "utf8"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a live process owned by someone else counts as alive", () => {
    expect(pidState(1)).toBe("alive");
    expect(pidState(process.pid)).toBe("alive");
    expect(pidState(DEAD_PID)).toBe("dead");
  });

  test("a PID that cannot name a process is dead rather than unknown", () => {
    expect(pidState(0)).toBe("dead");
    expect(pidState(-1)).toBe("dead");
  });

  test("a probe that fails for its own reasons is unknown, not dead", () => {
    const failWith = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };

    expect(pidState(1234, failWith("EINVAL"))).toBe("unknown");
    expect(pidState(1234, failWith("ESRCH"))).toBe("dead");
    expect(pidState(1234, failWith("EPERM"))).toBe("alive");
  });

  test("only a definite dead prunes", () => {
    expect(shouldPrune("dead")).toBe(true);
    expect(shouldPrune("alive")).toBe(false);
    expect(shouldPrune("unknown")).toBe(false);
  });
});

describe("corrupt JSON", () => {
  test("is raised, and the content is kept beside the file", async () => {
    const { root, instances } = await registryIn("shore-instances-corrupt-");
    try {
      const corrupt = "{ definitely not valid json";
      mkdirSync(join(root, "shore"), { recursive: true });
      writeFileSync(instances.path, corrupt);

      expect(() => instances.register(sample("daemon-corrupt"))).toThrow(/corrupt/);

      const backups = readdirSync(join(root, "shore")).filter((n) =>
        n.startsWith("instances.corrupt-"),
      );
      expect(backups.length).toBe(1);
      expect(readFileSync(join(root, "shore", backups[0] as string), "utf8")).toBe(corrupt);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("says the backup failed rather than naming a file that was never written", () => {
    const failed = new CorruptInstances(
      "/srv/instances.json",
      {
        written: false,
        path: "/srv/instances.corrupt-1.json",
        cause: new Error("EROFS: read-only file system"),
      },
      new SyntaxError("Unexpected token"),
    );

    expect(failed.message).toContain("corrupt registry JSON in /srv/instances.json");
    expect(failed.message).toContain("could NOT be preserved");
    expect(failed.message).toContain("EROFS");
    expect(failed.message).not.toContain("Preserved backup at");
  });

  test("names the backup when it was written", () => {
    const ok = new CorruptInstances(
      "/srv/instances.json",
      { written: true, path: "/srv/instances.corrupt-1.json" },
      new SyntaxError("Unexpected token"),
    );

    expect(ok.message).toContain("Preserved backup at /srv/instances.corrupt-1.json");
  });

  test("does not overwrite the file it could not read", async () => {
    const { root, instances } = await registryIn("shore-instances-nooverwrite-");
    try {
      const corrupt = "{ definitely not valid json";
      mkdirSync(join(root, "shore"), { recursive: true });
      writeFileSync(instances.path, corrupt);

      expect(() => instances.register(sample("x"))).toThrow();
      expect(readFileSync(instances.path, "utf8")).toBe(corrupt);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the lock", () => {
  test("is released after every operation", async () => {
    const { root, instances } = await registryIn("shore-instances-lock-");
    try {
      instances.register(sample("a"));
      instances.list();
      instances.unregister("a");

      expect(existsSync(instances.lockPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("is released even when the operation throws", async () => {
    const { root, instances } = await registryIn("shore-instances-lockthrow-");
    try {
      mkdirSync(join(root, "shore"), { recursive: true });
      writeFileSync(instances.path, "{ not json");

      expect(() => instances.list()).toThrow();
      expect(existsSync(instances.lockPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an abandoned lock is broken rather than waited on forever", async () => {
    const { root, instances } = await registryIn("shore-instances-stale-");
    try {
      mkdirSync(join(root, "shore"), { recursive: true });
      writeFileSync(instances.lockPath, "");
      const old = Date.now() / 1000 - 3600;
      const { utimesSync } = await import("node:fs");
      utimesSync(instances.lockPath, old, old);

      instances.register(sample("after-stale"));
      expect(instances.list().map((e) => e.id)).toEqual(["after-stale"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("is exclusive: a second holder waits, and gets it once the first lets go", async () => {
    const { root, instances } = await registryIn("shore-instances-exclusive-");
    try {
      mkdirSync(join(root, "shore"), { recursive: true });
      const release = takeLock(instances.lockPath);

      expect(() => takeLock(instances.lockPath, 50)).toThrow(/timed out/);

      release();
      takeLock(instances.lockPath, 50)();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("sits beside the registry, named for it", async () => {
    const { root, instances } = await registryIn("shore-instances-lockname-");
    try {
      expect(instances.lockPath).toBe(join(root, "shore", "instances.lock"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the write", () => {
  test("goes through a sibling temp file and leaves none behind", async () => {
    const { root, instances } = await registryIn("shore-instances-atomic-");
    try {
      instances.register(sample("a"));

      expect(readdirSync(join(root, "shore")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("omits the optional directories rather than writing nulls", async () => {
    const { root, instances } = await registryIn("shore-instances-omit-");
    try {
      instances.register(sample("a"));

      const text = readFileSync(instances.path, "utf8");
      expect(text).not.toContain("data_dir");
      expect(text).not.toContain("null");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
