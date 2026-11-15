import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { WakeLog } from "../src/autonomy/wake_log.ts";
import { shoreLog } from "../src/log.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { closeStorageConnections, databasePath } from "../src/storage/store.ts";
import { testTmp } from "./support/tmp.ts";

afterEach(closeStorageConnections);

const WHEN = "2026-11-01T00:00:00.000Z";

test("a wake log whose stored events can't be read says so and answers with the newest hundred it still holds", async () => {
  const data = join(await mkdtemp(testTmp("shore-wake-log-")), "data");
  initializeDatabase(data);
  const log = await WakeLog.load(join(data, "ada", "wakes.jsonl"));
  for (let n = 1; n <= 101; n += 1) log.push("message_sent", `event ${String(n)}`, WHEN);
  expect(log.recent(200).map((event) => event.detail)).toEqual(Array.from({ length: 101 }, (_, index) => `event ${String(index + 1)}`));

  closeStorageConnections();
  const db = new Database(databasePath(data));
  db.run("ALTER TABLE events RENAME COLUMN content TO content_elsewhere");
  db.close();
  const said = spyOn(shoreLog, "error").mockImplementation(() => {});
  try {
    expect(log.recent(200).map((event) => event.detail)).toEqual(Array.from({ length: 100 }, (_, index) => `event ${String(index + 2)}`));
    expect(said.mock.calls.map((call) => String(call[0]).split(":").slice(0, 2).join(":"))).toEqual(["shore: failed to read retained wake events"]);
  } finally {
    said.mockRestore();
  }
});
