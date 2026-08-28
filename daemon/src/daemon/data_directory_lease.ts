import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import { pidState, takeLock } from "./instances.ts";

export const DATA_DIRECTORY_LEASE_FILE = ".shore-daemon-owner.json";

const UNREADABLE_LEASE_GRACE_MS = 10_000;
const MAX_ACQUIRE_ATTEMPTS = 8;

export interface DataDirectoryOwner {
  readonly version: 1;
  readonly lease_id: string;
  readonly instance_id: string;
  readonly pid: number;
  readonly started_at: string;
  readonly data_dir: string;
}

interface LeaseSnapshot {
  readonly text: string;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
}

export class DataDirectoryOwned extends Error {
  constructor(
    readonly dataDir: string,
    readonly leasePath: string,
    readonly owner: DataDirectoryOwner | undefined,
  ) {
    const detail = owner === undefined
      ? `the ownership record at ${leasePath} cannot be verified`
      : `Shore daemon instance ${owner.instance_id} (PID ${owner.pid}, started ${owner.started_at}) owns it`;
    super(
      `Shore data directory ${dataDir} is already in use: ${detail}. ` +
        `Stop the owning daemon or configure this daemon with a different SHORE_DATA_DIR.`,
    );
    this.name = "DataDirectoryOwned";
  }
}

export interface DataDirectoryLease {
  readonly dataDir: string;
  readonly path: string;
  readonly owner: DataDirectoryOwner;
  release(): boolean;
}

export function acquireDataDirectoryLease(
  dataDir: string,
  identity: { readonly instanceId: string; readonly startedAt: string },
): DataDirectoryLease {
  mkdirSync(dataDir, { recursive: true });
  const canonicalDataDir = realpathSync.native(dataDir);
  const path = join(canonicalDataDir, DATA_DIRECTORY_LEASE_FILE);
  const owner: DataDirectoryOwner = {
    version: 1,
    lease_id: randomUUID(),
    instance_id: identity.instanceId,
    pid: process.pid,
    started_at: identity.startedAt,
    data_dir: canonicalDataDir,
  };
  const serialized = `${JSON.stringify(owner, null, 2)}\n`;
  const releaseAcquisition = takeLock(`${path}.acquire`, 15_000);

  try {
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      try {
        createLeaseFile(path, serialized);
        return leaseFor(path, canonicalDataDir, owner);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }

      const snapshot = readSnapshot(path);
      if (snapshot === undefined) continue;
      const existing = parseOwner(snapshot.text);
      const reclaimable = existing === undefined
        ? Date.now() - snapshot.mtimeMs > UNREADABLE_LEASE_GRACE_MS
        : pidState(existing.pid) === "dead";
      if (!reclaimable) throw new DataDirectoryOwned(canonicalDataDir, path, existing);
      removeSnapshot(path, snapshot);
    }

    throw new Error(`could not acquire Shore data-directory ownership at ${path}`);
  } finally {
    releaseAcquisition();
  }
}

function createLeaseFile(path: string, content: string): void {
  const fd = openSync(path, "wx", 0o600);
  let failure: unknown;
  try {
    const bytes = Buffer.from(content);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error(`could not write Shore data-directory ownership at ${path}`);
      offset += written;
    }
    fsyncSync(fd);
  } catch (e) {
    failure = e;
  }
  try {
    closeSync(fd);
  } catch (e) {
    if (failure === undefined) failure = e;
  }
  if (failure !== undefined) {
    try {
      unlinkSync(path);
    } catch {
    }
    throw failure;
  }
}

function leaseFor(
  path: string,
  dataDir: string,
  owner: DataDirectoryOwner,
): DataDirectoryLease {
  let released = false;
  return {
    dataDir,
    path,
    owner,
    release: () => {
      if (released) return true;
      const snapshot = readSnapshot(path);
      if (snapshot === undefined) {
        released = true;
        return true;
      }
      const current = parseOwner(snapshot.text);
      if (current?.lease_id !== owner.lease_id) return false;
      if (!removeSnapshot(path, snapshot)) return false;
      released = true;
      return true;
    },
  };
}

function readSnapshot(path: string): LeaseSnapshot | undefined {
  try {
    const stat = statSync(path);
    return {
      text: readFileSync(path, "utf8"),
      dev: stat.dev,
      ino: stat.ino,
      mtimeMs: stat.mtimeMs,
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

function removeSnapshot(path: string, expected: LeaseSnapshot): boolean {
  try {
    const current = statSync(path);
    if (current.dev !== expected.dev || current.ino !== expected.ino) return false;
    unlinkSync(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

function parseOwner(text: string): DataDirectoryOwner | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record["version"] !== 1 ||
    typeof record["lease_id"] !== "string" ||
    record["lease_id"] === "" ||
    typeof record["instance_id"] !== "string" ||
    record["instance_id"] === "" ||
    typeof record["pid"] !== "number" ||
    !Number.isInteger(record["pid"]) ||
    record["pid"] <= 0 ||
    typeof record["started_at"] !== "string" ||
    typeof record["data_dir"] !== "string"
  ) {
    return undefined;
  }
  return {
    version: 1,
    lease_id: record["lease_id"],
    instance_id: record["instance_id"],
    pid: record["pid"],
    started_at: record["started_at"],
    data_dir: record["data_dir"],
  };
}
