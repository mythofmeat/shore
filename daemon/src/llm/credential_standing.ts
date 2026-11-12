import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { CredentialStanding } from "../protocol/CredentialStanding.ts";
import { makeProviderCacheFolderSync, providerCacheDir } from "../storage/provider_cache.ts";
import type { CredentialFailureKind } from "./credentials.ts";
import { shoreLog } from "../log.ts";

export interface StandingRecord {
  standing: CredentialStanding;
  detail: string | null;
  checked_at: string;
}

let cacheDir: string | undefined;
const loaded = new Map<string, Map<string, StandingRecord>>();

export function configureCredentialStanding(dir: string | undefined): void {
  cacheDir = dir;
  loaded.clear();
}

function standingPath(dir: string, provider: string): string {
  return join(providerCacheDir(dir, provider), "credentials.json");
}

function recordsFor(provider: string): Map<string, StandingRecord> {
  const known = loaded.get(provider);
  if (known !== undefined) return known;
  const records = new Map<string, StandingRecord>();
  if (cacheDir !== undefined) {
    try {
      const parsed = JSON.parse(readFileSync(standingPath(cacheDir, provider), "utf8")) as { credentials?: Record<string, StandingRecord> };
      for (const [name, record] of Object.entries(parsed.credentials ?? {})) records.set(name, record);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") shoreLog.warn(`shore: could not read credential standings for ${provider}: ${String(e)}`);
    }
  }
  loaded.set(provider, records);
  return records;
}

function persist(provider: string, records: Map<string, StandingRecord>): void {
  if (cacheDir === undefined) return;
  const path = standingPath(cacheDir, provider);
  const tmp = join(dirname(path), `.${crypto.randomUUID()}.tmp`);
  try {
    makeProviderCacheFolderSync(path);
    writeFileSync(tmp, `${JSON.stringify({ version: 1, credentials: Object.fromEntries(records) }, null, 2)}\n`);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    shoreLog.warn(`shore: could not save credential standings for ${provider}: ${String(e)}`);
  }
}

export function credentialStanding(provider: string, name: string): StandingRecord | undefined {
  return recordsFor(provider).get(name);
}

export function noteCredentialStanding(provider: string, name: string, standing: CredentialStanding, detail: string | null, now: number = Date.now()): void {
  const records = recordsFor(provider);
  const previous = records.get(name);
  const record = { standing, detail, checked_at: new Date(now).toISOString() };
  records.set(name, record);
  const stale = previous === undefined || Date.parse(previous.checked_at) < now - 60 * 60 * 1000;
  if (previous?.standing !== standing || previous.detail !== detail || stale) persist(provider, records);
}

export function forgetCredentialStanding(provider: string, name: string, renamedTo?: string): void {
  const records = recordsFor(provider);
  const record = records.get(name);
  if (record === undefined) return;
  records.delete(name);
  if (renamedTo !== undefined) records.set(renamedTo, record);
  persist(provider, records);
}

export function standingForFailure(kind: CredentialFailureKind): CredentialStanding | undefined {
  switch (kind) {
    case "invalid_key":
      return "invalid";
    case "quota_exhausted":
    case "budget_exhausted":
      return "over_quota";
    default:
      return undefined;
  }
}
