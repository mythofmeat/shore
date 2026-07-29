/**
 * A real `ledger.db`, created by the daemon binary.
 *
 * The schema comes from the *daemon* rather than a copy kept here, because the
 * whole arrangement rests on Rust owning the schema and this side writing into
 * it. A test that made its own tables would prove nothing about the pair.
 */

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const DAEMON = `${ROOT}/target/debug/shore-daemon`;

/** Whether the daemon has been built. Suites skip themselves when it has not. */
export const haveDaemon = Bun.spawnSync(["test", "-x", DAEMON]).exitCode === 0;

export interface LedgerFixture {
  path: string;
  cleanup: () => void;
}

/** Boot the daemon just long enough for it to create `ledger.db`, then stop it. */
export function daemonMadeLedger(): LedgerFixture {
  const root = mkdtempSync(join(tmpdir(), "shore-ledger-"));
  const [CONFIG, DATA] = [`${root}/config`, `${root}/data`];
  Bun.spawnSync(["mkdir", "-p", `${CONFIG}/characters/probe/workspace`, DATA]);
  Bun.spawnSync(["sh", "-c", `printf '[daemon]\\naddr = "127.0.0.1:0"\\n' > ${CONFIG}/config.toml`]);

  const proc = Bun.spawn([DAEMON], {
    env: {
      ...process.env,
      SHORE_CONFIG_DIR: CONFIG,
      SHORE_DATA_DIR: DATA,
      SHORE_CACHE_DIR: `${root}/cache`,
      SHORE_RUNTIME_DIR: `${root}/run`,
      RUST_LOG: "error",
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  const path = `${DATA}/ledger.db`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const db = new Database(path, { readonly: true, create: false });
      const has = db.query("SELECT name FROM sqlite_master WHERE name = 'calls'").get();
      db.close();
      if (has) break;
    } catch {
      /* not created yet */
    }
    Bun.sleepSync(150);
  }
  proc.kill();
  return { path, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Every row in the ledger, oldest first. */
export function rowsIn(path: string): Array<Record<string, unknown>> {
  const db = new Database(path, { readonly: true });
  const rows = db.query("SELECT * FROM calls ORDER BY id ASC").all() as Array<
    Record<string, unknown>
  >;
  db.close();
  return rows;
}
