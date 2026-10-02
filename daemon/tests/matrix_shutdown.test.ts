import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ACCESS_TOKEN_ENV } from "../src/connections/matrix/start.ts";
import {
  fakeHomeserver,
  healthyAnswer,
  type FakeHomeserver,
  type HomeserverAnswer,
  type HomeserverRequest,
} from "./support/matrix_homeserver.ts";
import { until } from "./support/until.ts";

const DAEMON_DIR = new URL("..", import.meta.url).pathname;
const START_MS = 30_000;
const STEP_MS = 10_000;
const startingThen = (steps: number): number => START_MS + steps * STEP_MS + 5_000;

type Child = Bun.Subprocess<"ignore", "ignore", "pipe">;

const children: Child[] = [];
const complaints = new Map<Child, string>();
const homeservers: FakeHomeserver[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  await Promise.allSettled(children.map(async (child) => await child.exited));
  children.length = 0;
  complaints.clear();
  for (const homeserver of homeservers.splice(0)) await homeserver.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function collectComplaints(child: Child): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of child.stderr) {
    const heard = (complaints.get(child) ?? "") + decoder.decode(chunk, { stream: true });
    complaints.set(child, heard.slice(-4000));
  }
}

async function homeserverAnswering(
  answer?: (request: HomeserverRequest) => HomeserverAnswer,
): Promise<FakeHomeserver> {
  const homeserver = await fakeHomeserver(answer);
  homeservers.push(homeserver);
  return homeserver;
}

function spawnFixture(
  script: string,
  argv: readonly string[],
  env: Record<string, string>,
): Child {
  const child = Bun.spawn(["bun", "run", script, ...argv], {
    cwd: DAEMON_DIR,
    env: { ...process.env, ...env },
    stdout: "ignore",
    stderr: "pipe",
  });
  children.push(child);
  void collectComplaints(child);
  return child;
}

async function daemonBridgedTo(homeserver: FakeHomeserver): Promise<Child> {
  const root = await mkdtemp(join(tmpdir(), "shore-matrix-shutdown-"));
  roots.push(root);
  const configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  const configPath = join(configDir, "config.toml");
  await writeFile(
    configPath,
    "[matrix]\nenabled = true\n" +
      `homeserver_url = "${homeserver.url}"\nuser_id = "@shore:example.com"\n`,
  );
  const readyPath = join(root, "ready");
  const daemon = spawnFixture(
    "tests/support/owned_daemon.ts",
    ["--config", configPath, "--addr", "127.0.0.1:0"],
    {
      SHORE_CONFIG_DIR: configDir,
      SHORE_DATA_DIR: join(root, "data"),
      SHORE_CACHE_DIR: join(root, "cache"),
      SHORE_RUNTIME_DIR: join(root, "runtime"),
      SHORE_TEST_READY_FILE: readyPath,
      SHORE_TOKEN: "matrix-shutdown-token",
      [ACCESS_TOKEN_ENV]: "matrix-shutdown-access-token",
    },
  );
  await until(
    () => existsSync(readyPath) && readFileSync(readyPath, "utf8").trim() === "ready",
    "the daemon coming up",
    START_MS,
  );
  return daemon;
}

async function expectCleanExit(child: Child): Promise<void> {
  const code = await Promise.race([
    child.exited,
    Bun.sleep(STEP_MS).then(() => {
      throw new Error(
        `the process was still running ${String(STEP_MS)}ms later: ${complaints.get(child) ?? ""}`,
      );
    }),
  ]);
  expect(code, complaints.get(child)).toBe(0);
}

const asked = (homeserver: FakeHomeserver, path: string): boolean =>
  homeserver.requests.some((request) => request.path.endsWith(path));

const unansweredCapabilities = (request: HomeserverRequest): HomeserverAnswer =>
  request.path.endsWith("/capabilities") ? "never" : healthyAnswer(request);

const failedSync = (request: HomeserverRequest): HomeserverAnswer =>
  request.path.includes("/pushrules")
    ? { status: 500, body: { errcode: "M_UNKNOWN", error: "Internal server error" } }
    : unansweredCapabilities(request);

describe("a Matrix bot whose capability fetch is still in flight", () => {
  test.each([
    ["stopped after it started", "starts", unansweredCapabilities],
    ["left after it failed to start", "fails", failedSync],
  ] as const)(
    "%s sends nothing more and leaves nothing behind to keep the process alive",
    async (_when, outcome, answer) => {
      const homeserver = await homeserverAnswering(answer);
      const bot = spawnFixture("tests/support/stopped_matrix_bot.ts", [outcome], {
        SHORE_TEST_HOMESERVER: homeserver.url,
      });
      await until(() => asked(homeserver, "/capabilities"), "the bot's capability fetch", START_MS);

      await expectCleanExit(bot);
      expect(homeserver.requests.filter((request) => request.path.includes("/send/"))).toEqual([]);
    },
    startingThen(1),
  );
});

describe("a daemon with a Matrix bridge exits on its own after SIGTERM", () => {
  test("while the bridge is syncing with a healthy homeserver", async () => {
    const homeserver = await homeserverAnswering();
    const daemon = await daemonBridgedTo(homeserver);
    await until(
      () => homeserver.requests.some((request) => request.query.has("since")),
      "the bridge's long-poll",
      STEP_MS,
    );

    daemon.kill("SIGTERM");
    await expectCleanExit(daemon);
  }, startingThen(2));

  test("while the homeserver is still not answering the bridge's first request", async () => {
    const homeserver = await homeserverAnswering(() => "never");
    const daemon = await daemonBridgedTo(homeserver);
    await until(() => homeserver.requests.length > 0, "the bridge's first request", STEP_MS);

    daemon.kill("SIGTERM");
    await expectCleanExit(daemon);
  }, startingThen(2));

  test("while the bridge is still waiting for its first sync", async () => {
    const homeserver = await homeserverAnswering((request) =>
      request.path.endsWith("/sync") ? "never" : healthyAnswer(request),
    );
    const daemon = await daemonBridgedTo(homeserver);
    await until(() => asked(homeserver, "/sync"), "the bridge's first sync", STEP_MS);

    daemon.kill("SIGTERM");
    await expectCleanExit(daemon);
  }, startingThen(2));

  test("after a bridge start failed with its capability fetch still unanswered", async () => {
    const homeserver = await homeserverAnswering(failedSync);
    const daemon = await daemonBridgedTo(homeserver);
    await until(
      () => asked(homeserver, "/pushrules/") && asked(homeserver, "/capabilities"),
      "the failed bridge start",
      STEP_MS,
    );

    daemon.kill("SIGTERM");
    await expectCleanExit(daemon);
  }, startingThen(2));
});
