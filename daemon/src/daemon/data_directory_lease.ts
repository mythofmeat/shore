import { Database } from "bun:sqlite";
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
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { pidState, takeLock } from "./instances.ts";

export const DATA_DIRECTORY_LEASE_FILE = ".shore-daemon-owner.json";
export const DATA_DIRECTORY_LOCK_FILE = ".shore-daemon-lock.sqlite";

const UNREADABLE_LEASE_GRACE_MS = 10_000;
const MAX_ACQUIRE_ATTEMPTS = 8;

export interface DataDirectoryOwner {
  readonly version: 1 | 2;
  readonly lease_id: string;
  readonly instance_id: string;
  readonly pid: number;
  readonly process_start_id?: string;
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
  const releaseProcessLock = takeDataDirectoryProcessLock(
    join(canonicalDataDir, DATA_DIRECTORY_LOCK_FILE),
  );
  if (releaseProcessLock === undefined) {
    const snapshot = readSnapshot(path);
    const existing = snapshot === undefined ? undefined : parseOwner(snapshot.text);
    throw new DataDirectoryOwned(canonicalDataDir, path, existing);
  }
  const owner: DataDirectoryOwner = {
    version: 2,
    lease_id: randomUUID(),
    instance_id: identity.instanceId,
    pid: process.pid,
    process_start_id: currentProcessStartId(),
    started_at: identity.startedAt,
    data_dir: canonicalDataDir,
  };
  const serialized = `${JSON.stringify(owner, null, 2)}\n`;
  let releaseAcquisition: () => void;
  try {
    releaseAcquisition = takeLock(`${path}.acquire`, 15_000);
  } catch (e) {
    releaseProcessLock();
    throw e;
  }
  let handedOff = false;

  try {
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      try {
        createLeaseFile(path, serialized);
        const lease = leaseFor(path, canonicalDataDir, owner, releaseProcessLock);
        handedOff = true;
        return lease;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }

      const snapshot = readSnapshot(path);
      if (snapshot === undefined) continue;
      const existing = parseOwner(snapshot.text);
      const reclaimable = existing === undefined
        ? Date.now() - snapshot.mtimeMs > UNREADABLE_LEASE_GRACE_MS
        : existing.version === 2 || ownerIsDead(existing);
      if (!reclaimable) throw new DataDirectoryOwned(canonicalDataDir, path, existing);
      removeSnapshot(path, snapshot);
    }

    throw new Error(`could not acquire Shore data-directory ownership at ${path}`);
  } finally {
    releaseAcquisition();
    if (!handedOff) releaseProcessLock();
  }
}

function takeDataDirectoryProcessLock(path: string): (() => void) | undefined {
  let db: Database | undefined;
  try {
    db = new Database(path, { create: true, readwrite: true });
    db.run("BEGIN EXCLUSIVE;");
  } catch (e) {
    db?.close();
    const code = (e as { readonly code?: unknown }).code;
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return undefined;
    throw e;
  }

  return () => {
    db.close();
  };
}

function ownerIsDead(owner: DataDirectoryOwner): boolean {
  const state = pidState(owner.pid);
  if (state !== "alive") return state === "dead";
  const observedStartId = processStartId(owner.pid);
  if (owner.process_start_id !== undefined && observedStartId !== undefined) return owner.process_start_id !== observedStartId;
  if (owner.process_start_id !== undefined || owner.pid !== process.pid) return false;
  const recordedStart = Date.parse(owner.started_at);
  return Number.isFinite(recordedStart) && recordedStart < performance.timeOrigin;
}

const FALLBACK_CURRENT_PROCESS_START_ID = `runtime:${process.pid}:${performance.timeOrigin}`;

function currentProcessStartId(): string {
  return processStartId(process.pid) ?? FALLBACK_CURRENT_PROCESS_START_ID;
}

function processStartId(pid: number): string | undefined {
  const linux = linuxProcessStartId(pid);
  if (linux !== undefined) return linux;
  return pid === process.pid ? FALLBACK_CURRENT_PROCESS_START_ID : undefined;
}

function linuxProcessStartId(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (bootId === "" || commandEnd < 0) return undefined;
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    const startTicks = fields[19];
    if (startTicks === undefined || !/^\d+$/.test(startTicks)) return undefined;
    return `linux:${bootId}:${startTicks}`;
  } catch {
    return undefined;
  }
}

function createLeaseFile(path: string, content: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    rmSync(path, { force: true });
    throw e;
  }
}

function leaseFor(
  path: string,
  dataDir: string,
  owner: DataDirectoryOwner,
  releaseProcessLock: () => void,
): DataDirectoryLease {
  let released = false;
  let releaseResult = true;
  return {
    dataDir,
    path,
    owner,
    release: () => {
      if (released) return releaseResult;
      try {
        const snapshot = readSnapshot(path);
        if (snapshot === undefined) return releaseResult;
        const current = parseOwner(snapshot.text);
        if (current?.lease_id !== owner.lease_id) {
          releaseResult = false;
          return releaseResult;
        }
        if (!removeSnapshot(path, snapshot)) releaseResult = false;
        return releaseResult;
      } finally {
        released = true;
        releaseProcessLock();
      }
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

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseOwner(text: string): DataDirectoryOwner | undefined {
  const value = parsedJson(text);
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    (record["version"] !== 1 && record["version"] !== 2) ||
    typeof record["lease_id"] !== "string" ||
    record["lease_id"] === "" ||
    typeof record["instance_id"] !== "string" ||
    record["instance_id"] === "" ||
    typeof record["pid"] !== "number" ||
    !Number.isInteger(record["pid"]) ||
    record["pid"] <= 0 ||
    (record["process_start_id"] !== undefined &&
      (typeof record["process_start_id"] !== "string" || record["process_start_id"] === "")) ||
    (record["version"] === 2 && record["process_start_id"] === undefined) ||
    typeof record["started_at"] !== "string" ||
    typeof record["data_dir"] !== "string"
  ) {
    return undefined;
  }
  return {
    version: record["version"],
    lease_id: record["lease_id"],
    instance_id: record["instance_id"],
    pid: record["pid"],
    ...(record["process_start_id"] === undefined
      ? {}
      : { process_start_id: record["process_start_id"] }),
    started_at: record["started_at"],
    data_dir: record["data_dir"],
  };
}
