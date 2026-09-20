import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startDaemon } from "../../src/daemon/run.ts";

const root = process.argv[2];
if (root === undefined) throw new Error("Missing restart fixture directory");
const daemon = await startDaemon({
  argv: ["--config", join(root, "shore.toml"), "--addr", "127.0.0.1:0"],
  env: { SHORE_CONFIG_DIR: join(root, "config"), SHORE_DATA_DIR: join(root, "data"), SHORE_CACHE_DIR: join(root, "cache"), SHORE_RUNTIME_DIR: join(root, "runtime"), SHORE_TOKEN: "restart-fixture-token" },
  providers: {}, instancesPath: join(root, "instances.json"), watchConfig: false, autoDiscovery: false,
});
if (process.argv[3] === "hold-import") {
  const send = daemon.server.sessionRouter.sendToSession.bind(daemon.server.sessionRouter);
  daemon.server.sessionRouter.sendToSession = async (session, message) => {
    if (message.type === "command_output" && message.name === "import_character") {
      await writeFile(join(root, "import-committed"), JSON.stringify(message));
      await new Promise<void>(() => {});
    }
    await send(session, message);
  };
}
process.once("SIGTERM", () => daemon.stop());
if (daemon.web === undefined) throw new Error("Missing restart web listener");
console.log(`SHORE_RESTART_READY ${daemon.web.origin}`);
await daemon.done;
