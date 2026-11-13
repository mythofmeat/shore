import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { WebArchiveInfo } from "../protocol/WebArchiveInfo.ts";
import type { WebRequestInfo } from "../protocol/WebRequestInfo.ts";
import { shoreLog } from "../log.ts";
import { validWebArchiveInfo, validWebRequestInfo } from "./contracts.ts";

export interface WebRecoveryOptions {
  readonly cacheDir: string;
  readonly dataDir: string;
  readonly token: string;
}

export const sessionDigest = (token: string): string => createHash("sha256").update(token).digest("hex");

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory()) throw new Error("Browser recovery requires a private directory");
  chmodSync(path, 0o700);
}

interface Saved { id: string; expires_at: number }

function readSaved<T extends Saved>(text: string, valid: (value: unknown) => value is T, mark: Record<string, unknown>): { info: T; trimmed: boolean } | undefined {
  let saved: unknown;
  try { saved = JSON.parse(text); } catch { return undefined; }
  const usable = (value: unknown): value is T => valid(value) && /^[a-f0-9-]{36}$/.test(value.id) && Number.isSafeInteger(value.expires_at);
  if (usable(saved)) return { info: saved, trimmed: false };
  const withoutResult: Record<string, unknown> = { ...(saved as Record<string, unknown>), ...mark };
  delete withoutResult.result;
  return usable(withoutResult) ? { info: withoutResult, trimmed: true } : undefined;
}

export class WebRecovery {
  readonly #db: Database;
  readonly artifacts: string;

  constructor(options: WebRecoveryOptions, origin: string) {
    const parent = join(options.cacheDir, "web");
    privateDirectory(parent);
    const directory = join(parent, sessionDigest(realpathSync(options.dataDir)));
    privateDirectory(directory);
    const path = join(directory, "recovery.sqlite");
    const file = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      if (!fstatSync(file).isFile()) throw new Error("Browser recovery requires a regular database file");
      chmodSync(path, 0o600);
    } finally { closeSync(file); }
    this.#db = new Database(path);
    this.artifacts = join(directory, "artifacts");
    try {
      this.#db.run(`PRAGMA journal_mode = DELETE; PRAGMA synchronous = EXTRA; PRAGMA foreign_keys = ON; PRAGMA max_page_count = 16384;
        CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id = 1), fingerprint TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS archives (id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, info TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, info TEXT NOT NULL);`);
      const fingerprint = sessionDigest(JSON.stringify([1, origin, options.token]));
      this.#db.transaction(() => {
        const previous = this.#db.query<{ fingerprint: string }, []>("SELECT fingerprint FROM identity WHERE id = 1").get();
        if (previous?.fingerprint !== fingerprint) {
          this.#db.run("DELETE FROM archives; DELETE FROM sessions;");
          this.#db.query("INSERT OR REPLACE INTO identity VALUES (1, ?)").run(fingerprint);
        }
        this.#db.query("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
      })();
      rmSync(this.artifacts, { recursive: true, force: true });
      privateDirectory(this.artifacts);
    } catch (error) { this.#db.close(); throw error; }
  }

  sessions(): { id: string; expires_at: number }[] {
    return this.#db.query<{ id: string; expires_at: number }, []>("SELECT id, expires_at FROM sessions ORDER BY expires_at").all();
  }

  saveSession(id: string, expiresAt: number): void {
    this.#db.query("INSERT INTO sessions VALUES (?, ?)").run(id, expiresAt);
  }

  renewSession(id: string, expiresAt: number): void {
    this.#db.query("UPDATE sessions SET expires_at = ? WHERE id = ?").run(expiresAt, id);
  }

  revokeSession(id: string): void { this.#db.query("DELETE FROM sessions WHERE id = ?").run(id); }

  #saved<T extends Saved>(table: "archives" | "requests", valid: (value: unknown) => value is T, mark: Record<string, unknown>): { owner: string; info: T }[] {
    const kept: { owner: string; info: T }[] = [];
    let dropped = 0;
    let trimmed = 0;
    for (const row of this.#db.query<{ id: string; owner: string; info: string }, []>(`SELECT id, owner, info FROM ${table}`).all()) {
      const read = readSaved(row.info, valid, mark);
      if (read === undefined) {
        this.#db.query(`DELETE FROM ${table} WHERE id = ?`).run(row.id);
        dropped += 1;
        continue;
      }
      if (read.trimmed) trimmed += 1;
      kept.push({ owner: row.owner, info: read.info });
    }
    if (dropped + trimmed > 0) shoreLog.warn(`shore: saved web UI ${table} from an older daemon: ${String(trimmed)} kept without their result, ${String(dropped)} dropped as unreadable`);
    return kept;
  }

  archives(): { owner: string; info: WebArchiveInfo }[] {
    return this.#saved("archives", validWebArchiveInfo, {});
  }

  saveArchive(owner: string, info: WebArchiveInfo): void {
    this.#db.query("INSERT INTO archives VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET info = excluded.info").run(info.id, owner, JSON.stringify(info));
  }

  removeArchive(id: string): void { this.#db.query("DELETE FROM archives WHERE id = ?").run(id); }

  requests(): { owner: string; info: WebRequestInfo }[] {
    return this.#saved("requests", validWebRequestInfo, { result_omitted: true });
  }

  saveRequest(owner: string, info: WebRequestInfo): void {
    this.#db.query("INSERT INTO requests VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET info = excluded.info").run(info.id, owner, JSON.stringify(info));
  }

  removeRequest(id: string): void { this.#db.query("DELETE FROM requests WHERE id = ?").run(id); }

  close(): void { this.#db.close(); }
}
