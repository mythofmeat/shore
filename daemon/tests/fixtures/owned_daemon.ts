import { shoreLog } from "../../src/log.ts";

import { startDaemon } from "../../src/daemon/run.ts";
import { StartupError } from "../../src/daemon/startup.ts";

try {
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
