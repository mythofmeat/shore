import { shoreLog } from "../../src/log.ts";

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIRECTORY_LEASE_FILE } from "../../src/daemon/data_directory_lease.ts";
import { startDaemon } from "../../src/daemon/run.ts";
import { StartupError } from "../../src/daemon/startup.ts";

try {
  if (process.env["SHORE_TEST_REUSED_PID_LEASE"] === "1") {
    const dataDir = process.env["SHORE_DATA_DIR"];
    if (dataDir === undefined) throw new Error("SHORE_DATA_DIR is required");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, DATA_DIRECTORY_LEASE_FILE),
      JSON.stringify({
        version: 1,
        lease_id: "previous-container",
        instance_id: "previous-container",
        pid: process.pid,
        started_at: new Date(performance.timeOrigin - 60_000).toISOString(),
        data_dir: dataDir,
      }),
      { flag: "wx" },
    );
  }
  const daemon = await startDaemon({
    argv: process.argv.slice(2),
    providers: {},
  });
  const stop = () => daemon.stop();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const readyPath = process.env["SHORE_TEST_READY_FILE"];
  if (readyPath === undefined) throw new Error("SHORE_TEST_READY_FILE is required");
  await Bun.write(readyPath, "ready\n");
  try {
    await daemon.done;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
} catch (e) {
  shoreLog.error(e instanceof StartupError ? e.message : String(e));
  process.exitCode = 1;
}
