import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { WebArchiveInfo } from "../protocol/WebArchiveInfo.ts";
import { validWebArchiveInfo } from "./contracts.ts";

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

export class WebRecovery {
  readonly #db: Database;
  readonly artifacts: string;

  constructor(options: WebRecoveryOptions, origin: string) {
    const parent = join(options.cacheDir, "web");
    privateDirectory(parent);
    const directory = join(parent, sessionDigest(realpathSync(options.dataDir)));
    privateDirectory(directory);
    const path = join(directory, "recovery.sqlite");
    const file = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      if (!fstatSync(file).isFile()) throw new Error("Browser recovery requires a regular database file");
      chmodSync(path, 0o600);
    } finally { closeSync(file); }
    this.#db = new Database(path, { strict: true });
    this.artifacts = join(directory, "artifacts");
    try {
      this.#db.run(`PRAGMA journal_mode = DELETE; PRAGMA synchronous = EXTRA; PRAGMA foreign_keys = ON; PRAGMA max_page_count = 16384;
        CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id = 1), fingerprint TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS archives (id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, info TEXT NOT NULL);`);
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

  revokeSession(id: string): void { this.#db.query("DELETE FROM sessions WHERE id = ?").run(id); }

  archives(): { owner: string; info: WebArchiveInfo }[] {
    return this.#db.query<{ owner: string; info: string }, []>("SELECT owner, info FROM archives").all().map((row) => {
      const info: unknown = JSON.parse(row.info);
      if (!validWebArchiveInfo(info) || !/^[a-f0-9-]{36}$/.test(info.id) || !Number.isSafeInteger(info.expires_at)) throw new Error("Invalid saved browser archive outcome");
      return { owner: row.owner, info };
    });
  }

  saveArchive(owner: string, info: WebArchiveInfo): void {
    this.#db.query("INSERT INTO archives VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET info = excluded.info").run(info.id, owner, JSON.stringify(info));
  }

  removeArchive(id: string): void { this.#db.query("DELETE FROM archives WHERE id = ?").run(id); }

  close(): void { this.#db.close(); }
}
