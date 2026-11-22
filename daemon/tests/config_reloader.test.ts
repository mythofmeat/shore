import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig } from "../src/config/loader.ts";
import { configReloader, type ConfigReloadAssembly } from "../src/handler/deps.ts";
import { shoreLog } from "../src/log.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { restoreTestEnv, unsetTestEnv } from "./support/env.ts";
import { testTmp } from "./support/tmp.ts";

const PROBE = "SHORE_RELOADER_PROBE";

afterEach(() => { restoreTestEnv(); });

async function daemonConfig(): Promise<{ configDir: string; configPath: string; reload: () => Promise<void>; emitted: ServerMessage[] }> {
  const root = await mkdtemp(testTmp("shore-reloader-"));
  const configDir = join(root, "config");
  const configPath = join(configDir, "config.toml");
  await mkdir(join(configDir, "characters", "ada"), { recursive: true });
  await writeFile(configPath, "");
  const env = { SHORE_CONFIG_DIR: configDir, SHORE_DATA_DIR: join(root, "data"), SHORE_CACHE_DIR: join(root, "cache"), SHORE_RUNTIME_DIR: join(root, "run") };
  const running = loadConfig(configPath, { env, onWarn: () => {} });
  const emitted: ServerMessage[] = [];
  const assembly = { env, runtime: { configPath, registry: { globalConfig: () => running } }, emitEvent: (message: ServerMessage) => emitted.push(message) } as unknown as ConfigReloadAssembly;
  return { configDir, configPath, reload: async () => { await configReloader(assembly)(["changed"]); }, emitted };
}

test("a config that won't load keeps the running one, warns once, and goes no further", async () => {
  const warned = spyOn(shoreLog, "warn").mockImplementation(() => {});
  try {
    const { configPath, reload, emitted } = await daemonConfig();
    await writeFile(configPath, "[tools\n");
    await reload();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: "config_warning", path: configPath });
    expect(emitted[0]).not.toHaveProperty("character");
    expect(warned.mock.calls.map(([line]) => String(line).split(" — ")[0])).toEqual(["shore: config hot reload failed, keeping the running config"]);
  } finally {
    warned.mockRestore();
  }
});

test("a character overlay that won't load keeps the running config, names the character, and takes in no new .env either", async () => {
  unsetTestEnv(PROBE);
  const warned = spyOn(shoreLog, "warn").mockImplementation(() => {});
  try {
    const { configDir, reload, emitted } = await daemonConfig();
    await writeFile(join(configDir, ".env"), `${PROBE}=from-dotenv\n`);
    await writeFile(join(configDir, "characters", "ada", "config.toml"), "[chat\n");
    await reload();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: "config_warning", path: join(configDir, "characters", "ada", "config.toml"), character: "ada" });
    expect(process.env[PROBE]).toBeUndefined();
    expect(warned.mock.calls.map(([line]) => String(line).split(" — ")[0])).toEqual(["shore: config hot reload failed on ada's overlay, keeping the running config"]);
  } finally {
    warned.mockRestore();
  }
});
