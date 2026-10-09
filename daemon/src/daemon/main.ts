import { WORKSPACE_HELPER_FLAG } from "../tools/workspace_helper_flag.ts";

if (process.argv[2] === WORKSPACE_HELPER_FLAG) {
  // eslint-disable-next-line no-console
  console.log = console.info = console.error;
  const { serveWorkspaceHelper } = await import("../tools/workspace_helper_server.ts");
  await serveWorkspaceHelper();
} else {
  const { main } = await import("./run.ts");
  await main();
}
