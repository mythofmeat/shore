import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DAEMON_DIR = new URL("..", import.meta.url).pathname;
const TOKEN = "process-test-token";
const children: Bun.Subprocess<"ignore", "ignore", "pipe">[] = [];
const roots: string[] = [];

interface ProcessLayout {
  readonly configPath: string;
  readonly env: Record<string, string>;
  readonly instancesPath: string;
  readonly readyPath: string;
}

afterEach(async () => {
  for (const child of children) child.kill("SIGTERM");
  await Promise.allSettled(children.map(async (child) => await child.exited));
  children.length = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function processRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `shore-owner-process-${name}-`));
  roots.push(root);
  return root;
}

async function processLayout(
  root: string,
  name: string,
  dataDir: string,
): Promise<ProcessLayout> {
  const base = join(root, name);
  const configDir = join(base, "config");
  const runtimeDir = join(root, "runtime");
  await mkdir(configDir, { recursive: true });
  const configPath = join(configDir, "config.toml");
  await writeFile(configPath, "");
  return {
    configPath,
    instancesPath: join(runtimeDir, "instances.json"),
    readyPath: join(base, "ready"),
    env: {
      ...stringEnvironment(process.env),
      SHORE_CONFIG_DIR: configDir,
      SHORE_DATA_DIR: dataDir,
      SHORE_CACHE_DIR: join(base, "cache"),
      SHORE_RUNTIME_DIR: runtimeDir,
      SHORE_TEST_READY_FILE: join(base, "ready"),
      SHORE_TOKEN: TOKEN,
    },
  };
}

function stringEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function spawnDaemon(layout: ProcessLayout, instanceId: string) {
  const child = Bun.spawn(
    [
      "bun",
      "run",
      "tests/fixtures/owned_daemon.ts",
      "--config",
      layout.configPath,
      "--addr",
      "127.0.0.1:0",
      "--instance-id",
      instanceId,
    ],
    {
      cwd: DAEMON_DIR,
      env: layout.env,
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  children.push(child);
  return child;
}

async function instanceIds(path: string): Promise<string[]> {
  try {
    const entries = JSON.parse(await readFile(path, "utf8")) as Array<{ id: string }>;
    return entries.map((entry) => entry.id).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

async function waitForInstances(path: string, expected: readonly string[]): Promise<void> {
  const wanted = [...expected].sort();
  const deadline = Date.now() + 10_000;
  for (;;) {
    const actual = await instanceIds(path);
    if (JSON.stringify(actual) === JSON.stringify(wanted)) return;
    if (Date.now() >= deadline) {
      throw new Error(`expected instances ${JSON.stringify(wanted)}, saw ${JSON.stringify(actual)}`);
    }
    await Bun.sleep(20);
  }
}

async function waitUntilReady(layout: ProcessLayout, instanceId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      if ((await readFile(layout.readyPath, "utf8")).trim() === "ready") return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (Date.now() >= deadline) throw new Error(`${instanceId} did not become ready`);
    await Bun.sleep(20);
  }
}

async function exitWithin(
  child: Bun.Subprocess<"ignore", "ignore", "pipe">,
): Promise<number> {
  return await Promise.race([
    child.exited,
    Bun.sleep(10_000).then(() => {
      throw new Error("daemon did not exit within 10 seconds");
    }),
  ]);
}

describe("daemon processes owning data directories", () => {
  test("a second process cannot open the same data directory", async () => {
    const root = await processRoot("same");
    const dataDir = join(root, "shared-data");
    const firstLayout = await processLayout(root, "first", dataDir);
    const secondLayout = await processLayout(root, "second", dataDir);
    const first = spawnDaemon(firstLayout, "first-owner");
    await waitUntilReady(firstLayout, "first-owner");

    const second = spawnDaemon(secondLayout, "blocked-owner");
    expect(await exitWithin(second)).toBe(1);
    const error = await new Response(second.stderr).text();
    expect(error).toContain("already in use");
    expect(error).toContain("first-owner");
    expect(error).toContain("different SHORE_DATA_DIR");
    await waitForInstances(firstLayout.instancesPath, ["first-owner"]);

    first.kill("SIGTERM");
    expect(await exitWithin(first)).toBe(0);
    await waitForInstances(firstLayout.instancesPath, []);

    const replacement = spawnDaemon(secondLayout, "replacement-owner");
    await waitUntilReady(secondLayout, "replacement-owner");
    replacement.kill("SIGTERM");
    expect(await exitWithin(replacement)).toBe(0);
  });

  test("two processes with different data directories remain supported", async () => {
    const root = await processRoot("different");
    const firstLayout = await processLayout(root, "first", join(root, "first-data"));
    const secondLayout = await processLayout(root, "second", join(root, "second-data"));

    const first = spawnDaemon(firstLayout, "first-data-owner");
    const second = spawnDaemon(secondLayout, "second-data-owner");
    await waitForInstances(firstLayout.instancesPath, ["first-data-owner", "second-data-owner"]);
    await Promise.all([
      waitUntilReady(firstLayout, "first-data-owner"),
      waitUntilReady(secondLayout, "second-data-owner"),
    ]);

    first.kill("SIGTERM");
    second.kill("SIGTERM");
    expect(await Promise.all([exitWithin(first), exitWithin(second)])).toEqual([0, 0]);
  });

  test("an owner killed without cleanup is safely reclaimed", async () => {
    const root = await processRoot("stale");
    const dataDir = join(root, "shared-data");
    const crashedLayout = await processLayout(root, "crashed", dataDir);
    const replacementLayout = await processLayout(root, "replacement", dataDir);
    const crashed = spawnDaemon(crashedLayout, "crashed-owner");
    await waitUntilReady(crashedLayout, "crashed-owner");

    crashed.kill("SIGKILL");
    expect(await exitWithin(crashed)).not.toBe(0);

    const replacement = spawnDaemon(replacementLayout, "recovered-owner");
    await waitUntilReady(replacementLayout, "recovered-owner");
    replacement.kill("SIGTERM");
    expect(await exitWithin(replacement)).toBe(0);
  });
});
