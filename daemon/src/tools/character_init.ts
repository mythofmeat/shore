import { join } from "node:path";

import type { LoadedConfig } from "../config/loader.ts";
import type { Logger } from "../swp/connection.ts";
import { characterToolsFor, characterWorkspace } from "./character_workspace.ts";

const INIT_SCRIPT = ".init.sh";
const INIT_LOG = ".init.log";
const RUN_INIT = 'exec >"$1" 2>&1 </dev/null; exec bash --noprofile --norc "$2"';

export function startCharacterInits(config: LoadedConfig, characters: readonly string[], log?: Logger): void {
  const characterByUser = new Map<string, string>();
  for (const character of characters) {
    const { user } = characterToolsFor(config, character);
    if (user !== undefined && !characterByUser.has(user)) characterByUser.set(user, character);
  }
  for (const [user, character] of characterByUser) {
    startInit(config, character, log).catch((error: unknown) => {
      log?.warn?.("Could not start a character's init script", { user, error: String(error) });
    });
  }
}

async function startInit(config: LoadedConfig, character: string, log: Logger | undefined): Promise<void> {
  const workspace = characterWorkspace(config, character);
  const user = await workspace.user();
  if (user?.home === undefined) return;
  const script = join(user.home, INIT_SCRIPT);
  const [present] = await workspace.call("exists", { paths: [script] });
  if (present !== true) return;
  const output = join(user.home, INIT_LOG);
  const child = await workspace.detach("bash", ["--noprofile", "--norc", "-c", RUN_INIT, "init", output, script], {
    cwd: user.home,
    env: { BASH_ENV: undefined, PWD: user.home, SHORE_WORKSPACE_DIR: workspace.dir },
  });
  const fields = { user: user.spec, script, output };
  child.once("spawn", () => log?.info?.("Started a character's init script", fields));
  child.once("error", (error) => log?.warn?.("Could not start a character's init script", { ...fields, error: String(error) }));
  child.once("exit", (code, signal) => {
    if (code !== 0) log?.warn?.("A character's init script failed", { ...fields, ...(signal === null ? { exit_code: code } : { signal }) });
  });
}
