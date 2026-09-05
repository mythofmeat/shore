import {
  HistoryStore,
  characterOfArchiveKey,
  type MemoryPath,
} from "../engine/history_store.ts";
import type { Message } from "../engine/types.ts";
import { processingUnitId, versionOf } from "../engine/versions.ts";

export const COVERAGE_LEASE_MS = 30 * 60_000;

export interface CoverageClaim {
  claim: string;
  unit: string;
  claimed: string[];
  covered: string[];
  versions: number;
  unversioned: number;
}

export function newCoverageClaim(): string {
  return `cl_${crypto.randomUUID()}`;
}

export function versionsIn(messages: readonly Message[]): string[] {
  const seen = new Set<string>();
  const versions: string[] = [];
  for (const message of messages) {
    const version = versionOf(message);
    if (version === undefined || seen.has(version)) continue;
    seen.add(version);
    versions.push(version);
  }
  return versions;
}

export function unversionedCount(messages: readonly Message[]): number {
  return messages.filter((message) => versionOf(message) === undefined).length;
}

export interface CoverageStore {
  claimMemoryCoverage(
    character: string,
    path: MemoryPath,
    versions: readonly string[],
    claim: string,
    unit: string,
    nowMs: number,
    leaseMs: number,
    stamp?: string,
  ): string[];
  coveredMemoryVersions(
    character: string,
    path: MemoryPath,
    versions: readonly string[],
  ): Set<string>;
  commitMemoryCoverage(
    character: string,
    path: MemoryPath,
    claim: string,
    stamp?: string,
  ): number;
  releaseMemoryCoverage(character: string, path: MemoryPath, claim: string): number;
}

export function claimUncovered(
  store: CoverageStore,
  character: string,
  path: MemoryPath,
  messages: readonly Message[],
  options: { claim?: string; nowMs?: number; leaseMs?: number } = {},
): CoverageClaim {
  const versions = versionsIn(messages);
  const covered = store.coveredMemoryVersions(character, path, versions);
  const pending = versions.filter((version) => !covered.has(version));
  const claim = options.claim ?? newCoverageClaim();
  const unit = processingUnitId(pending);
  const claimed = store.claimMemoryCoverage(
    character,
    path,
    pending,
    claim,
    unit,
    options.nowMs ?? Date.now(),
    options.leaseMs ?? COVERAGE_LEASE_MS,
  );
  return {
    claim,
    unit,
    claimed,
    covered: versions.filter((version) => covered.has(version)),
    versions: versions.length,
    unversioned: unversionedCount(messages),
  };
}

export function coverageIsRedundant(claim: CoverageClaim): boolean {
  return claim.unversioned === 0 && claim.covered.length === claim.versions;
}

export function withCoverageStore<T>(dbPath: string, read: (store: HistoryStore) => T): T {
  const store = HistoryStore.open(dbPath);
  try {
    return read(store);
  } finally {
    store.close();
  }
}

export function characterOf(archiveKey: string): string {
  return characterOfArchiveKey(archiveKey);
}
