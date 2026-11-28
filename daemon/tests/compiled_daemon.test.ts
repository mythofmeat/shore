import { beforeAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startMockAnthropic } from "../src/testing/mock_anthropic.ts";
import { testTmp } from "./support/tmp.ts";
import { until } from "./support/until.ts";
import { PROMPT_LIST_TOML } from "./support/prompt_list.ts";
import { signedInCli } from "./support/signed_in.ts";

const DAEMON_DIR = join(import.meta.dir, "..");

let bin = "";

beforeAll(async () => {
  bin = testTmp("compiled-daemon-bin");
  await mkdir(bin, { recursive: true });
  for (const argv of [
    [process.execPath, "build", "src/daemon/main.ts", "--compile", "--outfile", join(bin, "shore-daemon")],
    [process.execPath, "run", "scripts/build_claude.ts", bin],
  ]) {
    const build = Bun.spawn(argv, { cwd: DAEMON_DIR, stdin: "ignore", stdout: "ignore", stderr: "inherit" });
    const code = await build.exited;
    if (code !== 0) throw new Error(`${argv.join(" ")} exited with ${code}`);
  }
}, 120_000);

test("a compiled daemon started away from daemon/ answers through the Claude Code built beside it", async () => {
  const root = testTmp("compiled-daemon-run");
  const dirs = {
    config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"),
    runtime: join(root, "runtime"), workspace: join(root, "workspace"), claude: join(root, "claude"),
    home: join(root, "home"), cwd: join(root, "elsewhere"),
  };
  await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })));
  await mkdir(join(dirs.workspace, "ada"));
  await mkdir(join(dirs.config, "characters", "ada"), { recursive: true });
  await writeFile(join(dirs.workspace, "ada", "SOUL.md"), "You are Ada. Reply briefly.\n");
  await writeFile(join(dirs.claude, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: "test-access", expiresAt: Date.now() + 3_600_000, scopes: ["user:inference"], subscriptionType: "pro" },
  }));
  const mock = await startMockAnthropic({ fallback: { text: "answered by the bundled Claude Code" } });
  await writeFile(join(dirs.config, "config.toml"), [
    "[providers.subscription]", 'sdk = "claude_agent"', `base_url = ${JSON.stringify(mock.url)}`,
    "[chat]", 'model = "subscription:claude-sonnet-4-6"',
    "[tools]", 'enabled = ["bash"]', "", PROMPT_LIST_TOML,
  ].join("\n"));

  const daemon = Bun.spawn([join(bin, "shore-daemon")], {
    cwd: dirs.cwd,
    env: {
      PATH: process.env["PATH"] ?? "", HOME: dirs.home, TZ: "UTC",
      SHORE_CONFIG_DIR: dirs.config, SHORE_DATA_DIR: dirs.data, SHORE_CACHE_DIR: dirs.cache,
      SHORE_RUNTIME_DIR: dirs.runtime, SHORE_WORKSPACE_DIR: dirs.workspace,
      SHORE_WEB_ADDR: "127.0.0.1:0", CLAUDE_CONFIG_DIR: dirs.claude,
    },
    stdin: "ignore", stdout: "ignore", stderr: "pipe",
  });
  let log = "";
  const decoder = new TextDecoder();
  const logged = (async () => {
    for await (const chunk of daemon.stderr) log += decoder.decode(chunk, { stream: true });
  })();
  try {
    await until(() => /Listening origin=\S+ address=http:\/\/\S+:\d+/.test(log), "the compiled daemon listening", 30_000);
    const address = /Listening origin=\S+ address=(http:\/\/\S+:\d+)/.exec(log)?.[1] ?? "";
    const answer = await fetch(`${address}/api/op/message?character=ada`, {
      method: "POST", body: JSON.stringify({ text: "hello there", stream: true }),
      headers: { authorization: `Bearer ${await signedInCli(address)}`, accept: "application/x-ndjson", "content-type": "application/json" },
    });
    const frames = (await answer.text()).split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
    const rid = frames.find((frame) => frame["type"] === "request_finished")?.["rid"];

    expect(frames.find((frame) => frame["type"] === "request_finished")).toMatchObject({ outcome: "completed" });
    expect(frames.filter((frame) => frame["type"] === "error")).toEqual([]);
    const reply = frames.filter((frame) => frame["type"] === "stream_end" && frame["rid"] === rid).map((frame) => frame["content"]);
    expect(reply).toEqual(["answered by the bundled Claude Code"]);
    expect(mock.requests).toHaveLength(1);
  } catch (error) {
    throw new Error(`${String(error)}\n--- shore-daemon log ---\n${log}`, { cause: error });
  } finally {
    daemon.kill("SIGTERM");
    await daemon.exited;
    await logged;
    await mock.stop();
  }
}, 90_000);
