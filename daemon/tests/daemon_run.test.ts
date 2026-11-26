import { required } from "../src/util/required.ts";

import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import { createServer } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { exitIfStillRunning, startDaemon, type DaemonOptions, type RunningDaemon } from "../src/daemon/run.ts";
import { StartupError } from "../src/daemon/startup.ts";
import { Database } from "bun:sqlite";
import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import { buildMessageHandlerDeps } from "../src/handler/deps.ts";
import type { MessageHandlerDeps } from "../src/handler/router.ts";
import { DEFAULT_HANDSHAKE, type Logger } from "../src/swp/handshake.ts";
import { SessionRouter } from "../src/swp/session.ts";
import type { LocalPeer } from "../src/swp/server.ts";
import { decodeClientMessage } from "../src/swp/framing.ts";
import { DATA_DIRECTORY_LEASE_FILE } from "../src/daemon/data_directory_lease.ts";
import type { InstanceInfo } from "../src/daemon/instances.ts";
import type { SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import { threadActivityNow } from "../src/engine/threads.ts";
import { shoreLog } from "../src/log.ts";
import { CharacterWorkspace } from "../src/tools/character_workspace.ts";
import { decodeState, STATE_FILENAME } from "../src/autonomy/state_file.ts";
import { characterDataDir } from "../src/config/dirs.ts";
import { readCharacterState } from "../src/storage/store.ts";
import * as matrixModule from "../src/connections/matrix/supervise.ts";
import * as runtimeModule from "../src/runtime.ts";
import * as turnModule from "../src/handler/turn.ts";
import { loadForCharacter } from "../src/config/preferences.ts";
import { threadChatModel } from "../src/engine/threads.ts";
import { outcomeOf } from "./support/outcome.ts";
import { handlesUnder } from "./support/handles.ts";
import { until, untilAsync } from "./support/until.ts";
import { BrowserSocket } from "./support/browser.ts";
import { PROMPT_LIST_TOML } from "./support/prompt_list.ts";

const running: RunningDaemon[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) {
    daemon.stop();
    await daemon.done;
  }
});

const TEST_TOKEN = "test-token";

interface Layout {
  root: string;
  configPath: string;
  instancesPath: string;
  env: NodeJS.ProcessEnv;
}

async function layout(config = "", characters: readonly string[] = ["ada"]): Promise<Layout> {
  const root = await mkdtemp(join(tmpdir(), "shore-daemon-"));
  const configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  const configPath = join(configDir, "shore.toml");
  await writeFile(configPath, config);
  for (const name of characters) {
    const workspace = join(configDir, "characters", name, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "SOUL.md"), `# ${name}\n`);
  }
  return {
    root,
    configPath,
    instancesPath: join(root, "instances.json"),
    env: {
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_RUNTIME_DIR: join(root, "runtime"),
      HOME: root,
      SHORE_TEST_KEY: "sk-test",
      SHORE_TOKEN: TEST_TOKEN,
    },
  };
}

async function start(
  place: Layout,
  extraArgv: readonly string[] = [],
  providers: Partial<Record<string, SidecarProvider>> = {},
  watchConfig = true,
): Promise<RunningDaemon> {
  const daemon = await startDaemon({
    argv: ["--config", place.configPath, "--addr", "127.0.0.1:0", ...extraArgv],
    env: place.env,
    providers,
    instancesPath: place.instancesPath,
    watchConfig,
  });
  running.push(daemon);
  return daemon;
}

const MODEL_CONFIG =
  "[chat]\nmodel = \"anthropic:claude-opus-4-8\"\n" +
  `[providers.anthropic]\napi_key_env = "SHORE_TEST_KEY"\n` + PROMPT_LIST_TOML;

function scriptedProvider(text: string): SidecarProvider {
  return {
    async *stream(req: SidecarRequest) {
      yield { type: "start", model: req.model };
      yield { type: "text", text };
      yield {
        type: "done",
        content: text,
        finish_reason: "end_turn",
        usage: {
          input_tokens: 4,
          output_tokens: 2,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
        timing: { total_ms: 1, time_to_first_token_ms: 1 },
      };
    },
    generate: () => {
      throw new Error("this test never calls generate");
    },
  } as unknown as SidecarProvider;
}

function heldProvider(
  held: Promise<void>,
  text: string,
  onSettled: () => void,
): SidecarProvider {
  return {
    async *stream(req: SidecarRequest) {
      try {
        yield { type: "start", model: req.model };
        await held;
        yield { type: "text", text };
        yield {
          type: "done",
          content: text,
          finish_reason: "end_turn",
          usage: {
            input_tokens: 4,
            output_tokens: 2,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
          },
          timing: { total_ms: 1, time_to_first_token_ms: 1 },
        };
      } finally {
        onSettled();
      }
    },
    generate: () => {
      throw new Error("this test never calls generate");
    },
  } as unknown as SidecarProvider;
}

async function instances(place: Layout): Promise<InstanceInfo[]> {
  return JSON.parse(await readFile(place.instancesPath, "utf8")) as InstanceInfo[];
}

class Client {
  readonly frames: Record<string, unknown>[] = [];

  private constructor(readonly peer: LocalPeer) {}

  static async open(daemon: RunningDaemon, selected: string | null, capabilities: string[] = []): Promise<Client> {
    const peer = await daemon.server.attachLocal({ clientType: "tui", clientName: "test", capabilities, character: selected });
    const client = new Client(peer);
    void (async () => { for await (const frame of peer.events()) client.frames.push(frame); })();
    return client;
  }

  send(message: unknown): void {
    void this.peer.send(decodeClientMessage(message));
  }

  async awaitFrame(type: string, timeoutMs = 5_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.frames.find((frame) => frame["type"] === type);
      if (found !== undefined) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `no ${type} frame within ${timeoutMs}ms; saw ${JSON.stringify(
            this.frames.map((f) => f["type"]),
          )}`,
        );
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  }

  close(): void {
    void this.peer.detach();
  }
}

describe("archiving a conversation", () => {
  async function runCommand(client: Client, name: string, args: unknown): Promise<Record<string, unknown>> {
    client.frames.length = 0;
    client.send({ type: "command", name, args });
    return await client.awaitFrame("command_output");
  }

  async function finishTurn(client: Client, text: string): Promise<void> {
    client.frames.length = 0;
    client.send({ type: "message", rid: text, text, stream: true, images: [] });
    await client.awaitFrame("request_finished");
  }

  const homeArrival = (client: Client): Record<string, unknown> | undefined =>
    client.frames.find((frame) => frame["type"] === "history" && frame["selected_thread"] === "main");

  const heard = (client: Client, content: string): boolean =>
    client.frames.some((frame) => frame["type"] === "new_message" && frame["content"] === content);

  test("moves everyone viewing it home, where they see the reply running and their next message lands in sight", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const place = await layout(MODEL_CONFIG);
    const daemon = await start(place, [], { anthropic: heldProvider(held, "hello back", () => {}) });
    const archiver = await Client.open(daemon, "ada");
    const viewer = await Client.open(daemon, "ada", ["request-lifecycle"]);
    const atHome = await Client.open(daemon, "ada");
    const elsewhere = await Client.open(daemon, "ada");
    const clients = [archiver, viewer, atHome, elsewhere];
    try {
      for (const client of clients) await client.awaitFrame("history");
      await runCommand(archiver, "create_thread", { name: "side" });
      await runCommand(archiver, "create_thread", { name: "other" });
      await runCommand(archiver, "switch_thread", { name: "side" });
      await runCommand(viewer, "switch_thread", { name: "side" });
      await runCommand(elsewhere, "switch_thread", { name: "other" });
      atHome.send({ type: "message", text: "hi", stream: true, images: [] });
      await atHome.awaitFrame("stream_start");
      for (const client of clients) client.frames.length = 0;

      archiver.send({ type: "command", rid: "archive", name: "archive_thread", args: { name: "side" } });

      const reply = await archiver.awaitFrame("command_output");
      expect((reply["data"] as { current: string })["current"]).toBe("main");
      for (const client of clients) expect(await client.awaitFrame("threads_changed")).toMatchObject({ character: "ada", thread: "side" });
      for (const moved of [archiver, viewer]) {
        await until(() => homeArrival(moved) !== undefined, "a viewer of the archived thread being told it moved home");
        const arrival = required(homeArrival(moved));
        expect((arrival["messages"] as { content: string }[]).map((message) => message.content)).toEqual(["hi"]);
        expect(await moved.awaitFrame("stream_start")).toBeDefined();
      }
      expect(homeArrival(archiver)?.["rid"]).toBe("archive");
      expect(homeArrival(viewer)?.["rid"]).toBeUndefined();
      expect(elsewhere.frames.filter((frame) => frame["type"] === "history")).toEqual([]);

      release();
      await until(() => heard(viewer, "hello back"), "the moved viewer hearing the reply");

      await finishTurn(viewer, "typed after archiving");
      expect(heard(viewer, "typed after archiving")).toBe(true);
      await until(() => heard(archiver, "typed after archiving"), "the other moved viewer seeing that message");
      const home = await daemon.runtime.registry.getOrCreate("ada");
      expect(home.historySnapshot({}).messages.map((message) => message.content)).toEqual(["hi", "hello back", "typed after archiving", "hello back"]);
      expect(await runCommand(elsewhere, "list_threads", {})).toMatchObject({ data: { current: "other" } });
      expect(daemon.runtime.registry.listThreads("ada").map((thread) => thread.id).sort()).toEqual(["main", "other"]);
    } finally {
      release();
      for (const client of clients) client.close();
    }
  });

  test("a running daemon labels the segment a compaction makes", async () => {
    const place = await layout(MODEL_CONFIG);
    const daemon = await start(place, [], { anthropic: scriptedProvider("Lamp talk") });
    const client = await Client.open(daemon, "ada", ["request-lifecycle"]);
    try {
      await client.awaitFrame("history");
      await finishTurn(client, "hi");
      await runCommand(client, "compact", { keep_turns: 0 });
      const label = async (): Promise<unknown> => {
        const listed = await runCommand(client, "segments", {}) as { data?: { segments?: { label: string | null }[] } };
        return listed.data?.segments?.[0]?.label;
      };
      await untilAsync(async () => await label() === "Lamp talk", "the new segment to be labelled");
    } finally {
      client.close();
    }
  });

  test("stops paying to keep the archived thread warm, and leaves another thread's cache slot alone", async () => {
    const place = await layout(MODEL_CONFIG);
    const daemon = await start(place, [], { anthropic: scriptedProvider("hello back") });
    const client = await Client.open(daemon, "ada", ["request-lifecycle"]);
    const { keepalive } = daemon.runtime;
    try {
      await client.awaitFrame("history");
      await runCommand(client, "set_model_setting", { key: "cache_keepalive", value: "55m" });
      await finishTurn(client, "hi");
      expect(keepalive.warmThread("ada")).toBe("main");
      expect(keepalive.nextPingAt("ada")).toBeDefined();

      await runCommand(client, "create_thread", { name: "unwatched" });
      await runCommand(client, "archive_thread", { name: "unwatched" });
      expect(keepalive.warmThread("ada")).toBe("main");
      expect(keepalive.nextPingAt("ada")).toBeDefined();

      await runCommand(client, "create_thread", { name: "side" });
      await runCommand(client, "switch_thread", { name: "side" });
      await until(() => keepalive.warmThread("ada") === "side", "the side thread to get the cache slot");
      await finishTurn(client, "over here");
      expect(keepalive.warmThread("ada")).toBe("side");
      expect(keepalive.nextPingAt("ada")).toBeDefined();

      await runCommand(client, "archive_thread", { name: "side" });
      await until(() => keepalive.warmThread("ada") === "main", "home to get the cache slot back");
      expect(keepalive.nextPingAt("ada")).toBeUndefined();

      await runCommand(client, "create_thread", { name: "brief" });
      await runCommand(client, "switch_thread", { name: "brief" });
      await runCommand(client, "archive_thread", { name: "brief" });
      await Bun.sleep(400);
      await until(() => keepalive.warmThread("ada") === "main", "home to keep the slot after a thread archived before its rebuild ran");
    } finally {
      client.close();
    }
  });
});

describe("what a client gets", () => {
  test("hello names the characters actually on disk, the one it would serve, and the daemon's version, but only to someone signed in", async () => {
    const place = await layout("", ["ada", "nova"]);
    const daemon = await start(place);
    const origin = required(daemon.web).origin;
    const asked = await fetch(`${origin}/api/hello?character=nova`, { headers: { authorization: `Bearer ${TEST_TOKEN}` } });
    const hello = await asked.json() as { characters: { name: string }[]; selected_character?: string; selected_thread?: string; server_version: string };
    expect(hello.characters.map((c) => c.name).sort()).toEqual(["ada", "nova"]);
    expect([hello.selected_character, hello.selected_thread, hello.server_version]).toEqual(["nova", "main", asked.headers.get("shore-version") ?? ""]);
    const none = await (await fetch(`${origin}/api/hello?character=nobody`, { headers: { authorization: `Bearer ${TEST_TOKEN}` } })).json() as Record<string, unknown>;
    expect(["selected_character" in none, "selected_thread" in none]).toEqual([false, false]);
    const stranger = await fetch(`${origin}/api/hello`, { headers: { authorization: "Bearer guess" } });
    expect(stranger.status).toBe(401);
    expect(stranger.headers.get("shore-version")).toBe(hello.server_version);
  });

  test("a character's pictures that an older daemon left open to everyone are the daemon's alone once it has started", async () => {
    const place = await layout("", ["ada"]);
    const folder = join(place.env.XDG_CACHE_HOME ?? "", "shore", "characters", "ada");
    await mkdir(join(folder, "images"), { recursive: true });
    await chmod(folder, 0o755);

    await start(place);

    expect((await stat(folder)).mode & 0o777).toBe(0o700);
  });

  test("a command is answered, so the handler was draining before the accept", async () => {
    const place = await layout("", ["ada", "nova"]);
    const daemon = await start(place);
    const client = await Client.open(daemon, "ada");
    try {
      client.send({ type: "command", name: "list_characters" });

      const output = await client.awaitFrame("command_output");
      expect(JSON.stringify(output)).toContain("nova");
    } finally {
      client.close();
    }
  });

  test("switching character answers with that character's conversation", async () => {
    const place = await layout("", ["ada", "nova"]);
    const daemon = await start(place);
    const client = await Client.open(daemon, "ada");
    try {
      expect((await client.awaitFrame("history"))["selected_character"]).toBe("ada");
      client.frames.length = 0;

      client.send({ type: "command", name: "switch_character", args: { name: "nova" } });

      const history = await client.awaitFrame("history");
      expect(history["selected_character"]).toBe("nova");
    } finally {
      client.close();
    }
  });

  test("a turn streams to the client and lands in the conversation", async () => {
    const place = await layout(MODEL_CONFIG);
    const daemon = await start(place, [], { anthropic: scriptedProvider("hello back") });
    const client = await Client.open(daemon, "ada");
    try {
      client.frames.length = 0;

      client.send({ type: "message", text: "hi", stream: true, images: [] });

      await client.awaitFrame("stream_start");
      const end = await client.awaitFrame("stream_end");
      expect(JSON.stringify(end)).toContain("hello back");
      expect(await client.awaitFrame("new_message")).toBeDefined();

      const engine = await daemon.runtime.registry.getOrCreate("ada");
      const messages = engine.historySnapshot({}).messages;
      expect(messages.map((m) => m.content)).toEqual(["hi", "hello back"]);
    } finally {
      client.close();
    }
  });

  test("a chat turn is recorded in the call store", async () => {
    const place = await layout(MODEL_CONFIG);
    const daemon = await start(place, [], { anthropic: scriptedProvider("hello back") });
    const client = await Client.open(daemon, "ada");
    try {
      client.send({ type: "message", text: "hi", stream: true, images: [] });
      await client.awaitFrame("stream_end");

      const store = daemon.runtime.callStore;
      expect(store).toBeDefined();
      expect(required(store).callCount()).toBe(1);
      expect(required(required(store).queryCalls({ limit: 1 })[0]).character).toBe("ada");
    } finally {
      client.close();
    }
  });

  test("a conversation change is pushed to everyone connected", async () => {
    const place = await layout();
    const daemon = await start(place);
    const client = await Client.open(daemon, "ada");
    try {
      expect((await client.awaitFrame("history"))["messages"]).toEqual([]);
      client.frames.length = 0;

      const engine = await daemon.runtime.registry.getOrCreate("ada");
      await engine.appendMessage({
        msg_id: "m_test",
        role: "user",
        content: "hello",
        images: [],
        content_blocks: [],
        timestamp: new Date().toISOString(),
      });

      const history = await client.awaitFrame("history");
      expect((history["messages"] as { content: string }[]).at(-1)?.content).toBe("hello");
    } finally {
      client.close();
    }
  });
});

describe("hot reload", () => {
  async function untilAdopted(check: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("the config was never adopted");
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
  }

  test("a config that will not parse changes nothing", async () => {
    const place = await layout();
    const daemon = await start(place);
    await writeFile(place.configPath, `[tools]\nmax_result_chars = 4242\n`);
    await untilAdopted(
      () => daemon.runtime.registry.globalConfig().app.tools.max_result_chars === 4242,
    );
    const client = await Client.open(daemon, "ada");
    try {

      await writeFile(place.configPath, "[tools]\nmax_result_chars = ");
      await client.awaitFrame("config_warning");

      expect(daemon.runtime.registry.globalConfig().app.tools.max_result_chars).toBe(4242);
    } finally {
      client.close();
    }
  });

  test("a reload that changes a startup-owned section says a restart is needed, and one that changes nothing of that kind doesn't", async () => {
    const place = await layout();
    const info = spyOn(shoreLog, "info");
    const warn = spyOn(shoreLog, "warn");
    const reloads = () => info.mock.calls.filter(([line]) => String(line).startsWith("shore: config hot reload applied")).length;
    const restarts = () => warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("startup-owned changes"));
    try {
      await start(place);
      await writeFile(place.configPath, "[tools]\nmax_result_chars = 4242\n");
      await until(() => reloads() === 1, "a reload of a setting that applies at once");
      expect(restarts()).toEqual([]);
      await writeFile(place.configPath, '[tools]\nmax_result_chars = 4242\n[daemon]\nshutdown_grace = "1m"\n');
      await until(() => reloads() === 2, "a reload of a startup-owned setting");
      expect(restarts()).toEqual(["shore: config hot reload saw startup-owned changes ([daemon]); restart the daemon to apply them"]);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  test("a character's pictures are opened to the user its tools run as, and closed again, without a restart", async () => {
    const place = await layout("", ["ada"]);
    const folder = join(place.env.XDG_CACHE_HOME ?? "", "shore", "characters", "ada");
    const pictures = join(folder, "images");
    await mkdir(pictures, { recursive: true });
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    const call = Object.getOwnPropertyDescriptor(CharacterWorkspace.prototype, "call")?.value as typeof CharacterWorkspace.prototype.call;
    const asked: string[] = [];
    const reach = spyOn(CharacterWorkspace.prototype, "call").mockImplementation(function (this: CharacterWorkspace, op, args, signal) {
      if (op !== "exists") return call.call(this, op, args, signal);
      asked.push(JSON.stringify(args));
      return Promise.resolve([true]);
    } as typeof CharacterWorkspace.prototype.call);
    const info = spyOn(shoreLog, "info");
    const reloads = () => info.mock.calls.filter(([line]) => String(line).startsWith("shore: config hot reload applied")).length;
    try {
      await start(place);
      expect((await stat(folder)).mode & 0o777).toBe(0o700);

      await writeFile(place.configPath, `[tools]\nuser = "${String(uid)}:${String(gid)}"\n`);
      await until(() => reloads() === 1, "the reload giving ada's tools a user");
      expect([(await stat(folder)).mode & 0o777, (await stat(folder)).gid]).toEqual([0o710, gid]);

      await writeFile(place.configPath, "");
      await until(() => reloads() === 2, "the reload taking it away");
      expect((await stat(folder)).mode & 0o777).toBe(0o700);
      expect(asked).toEqual([JSON.stringify({ paths: [pictures] })]);
    } finally {
      info.mockRestore();
      reach.mockRestore();
    }
  });
});

describe("going down", () => {
  test("a client following events is told, and the instance is unregistered", async () => {
    const place = await layout();
    const daemon = await start(place);
    const client = await Client.open(daemon, "ada");
    try {
      const events = await fetch(`${required(daemon.web).origin}/api/events?character=ada`, { headers: { authorization: `Bearer ${TEST_TOKEN}` } });
      expect(events.headers.get("content-type")).toBe("application/x-ndjson");
      const reader = required(events.body).pipeThrough(new TextDecoderStream()).getReader();
      let text = "";
      const told = () => text.split("\n").filter((line) => line !== "").map((line) => (JSON.parse(line) as Record<string, unknown>)["type"]);
      daemon.server.broadcast({ type: "cache_warning", message: "cold", expected_tokens: 1 });
      while (!told().includes("cache_warning")) text += (await reader.read()).value ?? "";
      daemon.stop();
      await daemon.done;
      for (let next = await reader.read(); !next.done; next = await reader.read()) text += next.value;
      expect(told()).toEqual(["ping", "cache_warning", "shutdown"]);
      expect(await instances(place)).toEqual([]);
      expect(
        existsSync(join(daemon.runtime.config.dirs.data, DATA_DIRECTORY_LEASE_FILE)),
      ).toBe(false);
    } finally {
      client.close();
      running.length = 0;
    }
  });

  test("the exit timer waits its full delay, then says why and exits with success", () => {
    jest.useFakeTimers();
    const exit = spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const warnings: string[] = [];
    try {
      exitIfStillRunning({ info: () => {}, warn: (msg) => warnings.push(msg), error: () => {} }, 1000);
      jest.advanceTimersByTime(999);
      expect(exit).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(exit).toHaveBeenCalledWith(0);
      expect(warnings).toEqual(["Still running after shutting down; exiting anyway"]);
    } finally {
      exit.mockRestore();
      jest.useRealTimers();
    }
  });

  test("a process still held open after shutting down exits anyway and says so, and one with nothing open does not wait", async () => {
    const after = async (held: boolean): Promise<{ code: number; stderr: string; ms: number }> => {
      const started = Date.now();
      const child = Bun.spawn([process.execPath, "-e", [
        `import { exitIfStillRunning } from ${JSON.stringify(join(import.meta.dir, "../src/daemon/run.ts"))};`,
        held ? "setInterval(() => {}, 1000);" : "",
        `exitIfStillRunning({ warn: (msg) => console.error(msg) }, ${held ? "100" : "60_000"});`,
      ].join("\n")], { cwd: join(import.meta.dir, ".."), stdin: "ignore", stdout: "ignore", stderr: "pipe" });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      return { code, stderr, ms: Date.now() - started };
    };

    const [held, idle] = await Promise.all([after(true), after(false)]);

    expect(held).toMatchObject({ code: 0, stderr: "Still running after shutting down; exiting anyway\n" });
    expect(idle).toMatchObject({ code: 0, stderr: "" });
    expect(idle.ms).toBeLessThan(30_000);
  });

  test("a turn still in flight is waited for, not abandoned mid-flight", async () => {
    const place = await layout(MODEL_CONFIG);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const daemon = await start(place, [], {
      anthropic: heldProvider(held, "late", () => {
        settled = true;
      }),
    });
    const client = await Client.open(daemon, "ada");
    try {
      client.send({ type: "message", text: "hi", stream: true, images: [] });
      await client.awaitFrame("stream_start");
      expect(settled, "the turn is parked mid-stream before the daemon stops").toBe(false);

      daemon.stop();
      setTimeout(release, 100);
      await daemon.done;
      running.length = 0;

      expect(settled).toBe(true);
    } finally {
      client.close();
    }
  });

  test("a shutdown stops anyway once the grace period runs out", async () => {
    const place = await layout(`${MODEL_CONFIG}[daemon]\nshutdown_grace = "1s"\n`);
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const daemon = await start(place, [], { anthropic: heldProvider(held, "too late", () => {}) });
    const client = await Client.open(daemon, "ada");
    try {
      const events = await fetch(`${required(daemon.web).origin}/api/events?character=ada`, { headers: { authorization: `Bearer ${TEST_TOKEN}` } });
      client.send({ type: "message", text: "hi", stream: true, images: [] });
      await client.awaitFrame("stream_start");
      const began = Date.now();
      await daemon.shutdown();
      expect(Date.now() - began).toBeGreaterThanOrEqual(900);
      expect((await events.text()).trim().split("\n").at(-1)).toBe('{"type":"shutdown"}');
      release();
    } finally {
      client.close();
    }
  });

  test("web UI settings a browser saved are there when the daemon starts again", async () => {
    const place = await layout('[daemon.web]\nenabled = true\nbind_addr = "127.0.0.1:0"\n');
    const page = async (daemon: RunningDaemon, save?: Record<string, string>) => {
      const origin = required(daemon.web).origin;
      const post = async (path: string, body: unknown, cookie = "") => await fetch(`${origin}${path}`, { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
      const { code } = await (await fetch(`${origin}/api/login-code`, { method: "POST", headers: { authorization: `Bearer ${TEST_TOKEN}` } })).json() as { code: string };
      const cookie = (await post("/api/login", { token: code })).headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      if (save !== undefined) expect((await post("/api/preferences", { values: save }, cookie)).status).toBe(200);
      return await (await post("/api/preferences/list", {}, cookie)).json();
    };
    const first = await start(place);
    expect(await page(first, { "shore.theme": "fog" })).toEqual({ values: { "shore.theme": "fog" } });
    first.stop();
    await first.done;
    running.length = 0;
    expect(await page(await start(place))).toEqual({ values: { "shore.theme": "fog" } });
  });

  test("the port is free afterwards", async () => {
    const place = await layout();
    const daemon = await start(place);
    const port = required(daemon.web).port;
    daemon.stop();
    await daemon.done;
    running.length = 0;

    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => {
      probe.close(() => resolve());
    });
  });
});

const IDLE_CONFIG = `${MODEL_CONFIG}[tools]\nenabled = ["bash"]\n[triggers]\nenabled = true\n[compaction]\nidle_after = "1s"\nmin_turns = 2\nkeep_recent_turns = 0\n`;
const PAST_IDLE_MS = 1_100;

async function talk(client: Client, texts: readonly string[]): Promise<void> {
  for (const text of texts) {
    client.frames.length = 0;
    client.send({ type: "message", text, stream: true, images: [] });
    await client.awaitFrame("new_message");
    await client.awaitFrame("stream_end");
  }
}

async function command(client: Client, name: string, args: unknown): Promise<void> {
  client.frames.length = 0;
  client.send({ type: "command", name, args });
  await client.awaitFrame("command_output");
}

describe("a daemon that stays up", () => {
  const session = { sessionId: 1, clientId: 1, clientType: "test", clientName: "test", capabilities: [], selectedCharacter: "ada", selectedThread: "main" };
  const handlerFor = (daemon: RunningDaemon, log?: MessageHandlerDeps["log"]): MessageHandlerDeps => buildMessageHandlerDeps({
    runtime: daemon.runtime, providers: daemon.runtime.providers, autonomy: new TurnAutonomyBridge(daemon.runtime.autonomy), diagnostics: new Diagnostics(),
    router: new SessionRouter(), handshake: DEFAULT_HANDSHAKE, emitEvent: () => {}, ...(log === undefined ? {} : { log }),
  });

  test("a conversation left idle after a command and its last reply compacts without a restart, and the chat log index takes in what was archived", async () => {
    const place = await layout(IDLE_CONFIG);
    const daemon = await start(place, [], { anthropic: scriptedProvider("noted") });
    const client = await Client.open(daemon, "ada");
    await command(client, "list_threads", {});
    await talk(client, ["the lamp is lit", "two", "three"]);
    client.close();
    await Bun.sleep(PAST_IDLE_MS);

    await daemon.runtime.autonomy.runDue();

    await until(() => threadActivityNow(daemon.runtime.config.dirs.data, "ada", "main").turns === 0, "the idle conversation compacting");
    const index = daemon.runtime.historyIndex;
    await untilAsync(async () => {
      await index.runOnce();
      const db = new Database(required(index.progress("ada")).indexPath, { readonly: true });
      try {
        return (db.query("SELECT count(*) AS n FROM messages WHERE text = 'the lamp is lit'").get() as { n: number }).n === 1;
      } finally {
        db.close();
      }
    }, "the archived turns being indexed");
  });

  test("a command waits for a snapshot being taken, one cancelled before its turn isn't run, and the handler logs where it is told to", async () => {
    const daemon = await start(await layout(MODEL_CONFIG), [], { anthropic: scriptedProvider("noted") });
    const handler = handlerFor(daemon);
    const threads = (signal: AbortSignal) => handler.dispatchCommand({ name: "list_threads", args: {} }, { session, rid: "threads", kind: "command" }, signal);

    const taking = Promise.withResolvers<void>();
    const taken = Promise.withResolvers<void>();
    const snapshot = daemon.runtime.snapshotGate.withSnapshot(async () => {
      taking.resolve();
      await taken.promise;
    });
    await taking.promise;
    const answered = threads(new AbortController().signal).then((frame) => frame.type);
    expect(await Promise.race([answered, Bun.sleep(200).then(() => "waiting")])).toBe("waiting");
    taken.resolve();
    await snapshot;
    expect(await answered).toBe("command_output");

    expect(await outcomeOf(threads(AbortSignal.abort()))).toThrow("The operation was aborted.");

    const log = { error: () => {} };
    expect(handlerFor(daemon, log).log).toBe(log);
    expect("log" in handler).toBe(false);
  });
});

describe("coming back up", () => {
  async function shutDown(daemon: RunningDaemon): Promise<void> {
    await daemon.shutdown();
    await daemon.done;
    running.length = 0;
  }

  test("a conversation left idle compacts once the daemon is back, without anyone saying anything", async () => {
    const place = await layout(IDLE_CONFIG);
    const provider = scriptedProvider("noted");
    const first = await start(place, [], { anthropic: provider });
    const client = await Client.open(first, "ada");
    await talk(client, ["one", "two", "three"]);
    client.close();
    const data = first.runtime.config.dirs.data;
    await shutDown(first);
    await Bun.sleep(PAST_IDLE_MS);

    await start(place, [], { anthropic: provider });

    await until(() => threadActivityNow(data, "ada", "main").turns === 0, "the idle conversation compacting");
  });
});

describe("refusing to start", () => {
  test("a live daemon already owning the data directory is named", async () => {
    const place = await layout();
    const daemon = await start(place, ["--instance-id", "existing-owner"]);

    let caught: unknown;
    try {
      await startDaemon({
        argv: [
          "--config",
          place.configPath,
          "--addr",
          "127.0.0.1:0",
          "--instance-id",
          "blocked-owner",
        ],
        env: place.env,
        providers: {},
        instancesPath: place.instancesPath,
      });
    } catch (e) {
      caught = e;
    }

    expect((caught as StartupError).kind).toBe("own_data_directory");
    expect((caught as StartupError).message).toContain("existing-owner");
    expect((caught as StartupError).message).toContain(`PID ${process.pid}`);
    expect((await instances(place)).map((entry) => entry.id)).toEqual([daemon.instanceId]);
  });

  test("a port already in use fails as itself, before the stores are opened", async () => {
    const place = await layout();
    const taken = createServer();
    await new Promise<void>((resolve, reject) => {
      taken.once("error", reject);
      taken.listen(0, "127.0.0.1", resolve);
    });
    const address = taken.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    let caught: unknown;
    try {
      await startDaemon({
        argv: ["--config", place.configPath, "--addr", `127.0.0.1:${port}`],
        env: place.env,
        providers: {},
        instancesPath: place.instancesPath,
      });
    } catch (e) {
      caught = e;
    } finally {
      await new Promise<void>((resolve) => {
        taken.close(() => resolve());
      });
    }

    expect((caught as StartupError).kind).toBe("server_run");
    expect((caught as StartupError).message).toContain(`127.0.0.1:${port}`);
    expect(existsSync(place.instancesPath)).toBe(false);
  });
});

function recorder(): { log: Logger; lines: string[]; fields: Map<string, Record<string, unknown> | undefined> } {
  const lines: string[] = [];
  const fields = new Map<string, Record<string, unknown> | undefined>();
  const noted = (line: string, given?: Record<string, unknown>): void => {
    lines.push(line);
    fields.set(line, given);
  };
  return { lines, fields, log: { info: (msg, given) => { noted(msg, given); }, warn: (msg, given) => { noted(`warn: ${msg}`, given); }, error: (msg, given) => { noted(`error: ${msg}`, given); } } };
}

async function listening(port = 0): Promise<{ port: number; close: () => Promise<void> }> {
  const held = createServer();
  await new Promise<void>((resolve, reject) => {
    held.once("error", reject);
    held.listen(port, "127.0.0.1", resolve);
  });
  const address = held.address();
  return {
    port: typeof address === "object" && address !== null ? address.port : 0,
    close: async () => { await new Promise<void>((resolve) => { held.close(() => resolve()); }); },
  };
}

function listeningPorts(): Set<number> {
  const ours = new Set(readdirSync("/proc/self/fd").flatMap((descriptor) => {
    try {
      const inode = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/self/fd/${descriptor}`))?.[1];
      return inode === undefined ? [] : [inode];
    } catch {
      return [];
    }
  }));
  const ports = new Set<number>();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    for (const line of readFileSync(table, "utf8").split("\n").slice(1)) {
      const [, local, , state, , , , , , inode] = line.trim().split(/\s+/);
      if (state === "0A" && inode !== undefined && ours.has(inode)) ports.add(Number.parseInt(local?.split(":").at(-1) ?? "", 16));
    }
  }
  return ports;
}

function openedSince(before: ReadonlySet<number>): number[] {
  return [...listeningPorts()].filter((port) => !before.has(port));
}

async function refused(options: DaemonOptions): Promise<StartupError> {
  try {
    running.push(await startDaemon(options));
  } catch (e) {
    return e as StartupError;
  }
  throw new Error("the daemon started");
}

describe("what a daemon tells its log", () => {
  test("each part logs to it as the daemon comes up and as it goes down, and nothing that didn't happen is reported", async () => {
    const place = await layout('[matrix]\nenabled = true\nhomeserver_url = "http://127.0.0.1:9"\nuser_id = "@ada:example"\nroom_id = "!room:example"\n');
    const { log, lines } = recorder();
    const daemon = await startDaemon({ argv: ["--config", place.configPath, "--addr", "127.0.0.1:0"], env: place.env, providers: {}, instancesPath: place.instancesPath, log });
    running.push(daemon);
    await until(() => lines.some((line) => line.startsWith("warn: Matrix bridge")), "the matrix bridge reporting it can't connect");
    expect(["Listening", "message handler started", "Config hot reload watcher started", "Auto-discovery loop started"].filter((line) => !lines.includes(line))).toEqual([]);
    await daemon.shutdown();
    await daemon.done;
    expect(["Config hot reload watcher stopped", "Auto-discovery loop stopped", "Unregistered daemon instance", "Daemon shut down cleanly"].filter((line) => !lines.includes(line))).toEqual([]);
    expect(lines.filter((line) => /Wrote a new client token|Created default config|Could not release|Waiting for running work/.test(line))).toEqual([]);
  });

  test("a daemon that has to write its own config and client token says it did", async () => {
    const root = await mkdtemp(join(tmpdir(), "shore-daemon-"));
    const env = { XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_RUNTIME_DIR: join(root, "runtime"), HOME: root };
    const { log, lines } = recorder();
    const daemon = await startDaemon({ argv: ["--addr", "127.0.0.1:0"], env, providers: {}, instancesPath: join(root, "instances.json"), log, autoDiscovery: false });
    running.push(daemon);
    expect(["Created default config.toml", "Wrote a new client token"].filter((line) => !lines.includes(line))).toEqual([]);
  });

  test("a shutdown waiting on a turn says so, and status says when it asked to stop and when it stops waiting", async () => {
    const place = await layout(`${MODEL_CONFIG}[daemon]\nshutdown_grace = "30s"\n`);
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const { log, lines } = recorder();
    const daemon = await startDaemon({
      argv: ["--config", place.configPath, "--addr", "127.0.0.1:0"], env: place.env,
      providers: { anthropic: heldProvider(held, "late", () => {}) }, instancesPath: place.instancesPath, log,
    });
    running.push(daemon);
    const client = await Client.open(daemon, "ada");
    try {
      client.send({ type: "message", text: "hi", stream: true, images: [] });
      await client.awaitFrame("stream_start");
      const asked = Date.now();
      const stopping = daemon.shutdown();
      await until(() => lines.includes("Waiting for running work to finish before stopping"), "the shutdown saying what it waits for");
      client.frames.length = 0;
      client.send({ type: "message", text: "one more", stream: true, images: [] });
      expect((await client.awaitFrame("error"))["code"]).toBe("busy");
      client.send({ type: "command", name: "status", args: {} });
      const status = await client.awaitFrame("command_output");
      const window = (status["data"] as { running: { shutdown: { requested_at: string; deadline: string } } }).running.shutdown;
      expect(Date.parse(window.deadline) - Date.parse(window.requested_at)).toBe(30_000);
      expect(Math.abs(Date.parse(window.requested_at) - asked)).toBeLessThan(5_000);
      release();
      await stopping;
      await daemon.done;
    } finally {
      client.close();
    }
  });
});

describe("a daemon going down", () => {
  test("saves what its characters' wakes keep, closes its stores, leaves no file of its own open, and lets go of its data directory", async () => {
    const place = await layout(MODEL_CONFIG);
    const daemon = await start(place, [], { anthropic: scriptedProvider("hello") });
    const client = await Client.open(daemon, "ada");
    try {
      await talk(client, ["hi"]);
      expect((await client.awaitFrame("thread_unread"))["character"]).toBe("ada");
    } finally {
      client.close();
    }
    const data = daemon.runtime.config.dirs.data;
    daemon.stop();
    await daemon.done;
    running.length = 0;
    expect(() => daemon.runtime.callStore?.callCount()).toThrow();
    expect(handlesUnder(place.root)).toBe(0);
    expect(decodeState(readCharacterState(characterDataDir(data, "ada"), STATE_FILENAME) ?? "")?.lastUserAt).toBeNumber();
    expect((await start(place)).web?.port).toBeGreaterThan(0);
  });
});

describe("a daemon coming up", () => {
  test("makes a character by command that it can talk to at once, without waiting for the config watcher", async () => {
    const place = await layout(MODEL_CONFIG);
    const daemon = await start(place, [], {}, false);
    const client = await Client.open(daemon, "ada");
    try {
      await client.awaitFrame("history");
      client.send({ type: "command", rid: "make", name: "create_character", args: { name: "bo" } });
      const made = await client.awaitFrame("command_output");
      const configDir = dirname(place.configPath);
      expect(made["data"]).toEqual({ character: "bo", config_dir: join(configDir, "characters", "bo"), workspace_dir: join(configDir, "characters", "bo", "workspace") });
      expect(daemon.runtime.registry.availableCharacters()).toEqual(["ada", "bo"]);
    } finally {
      client.close();
    }
  });

  test("makes the workspace folder SHORE_WORKSPACE_DIR names, with the folders above it", async () => {
    const place = await layout("", []);
    const workspace = join(place.root, "deep", "nested", "workspace");
    const { log, lines } = recorder();
    const daemon = await startDaemon({
      argv: ["--config", place.configPath, "--addr", "127.0.0.1:0"], env: { ...place.env, SHORE_WORKSPACE_DIR: workspace },
      providers: {}, instancesPath: place.instancesPath, autoDiscovery: false, log,
    });
    running.push(daemon);
    expect(existsSync(workspace)).toBe(true);
    expect(lines).not.toContain("Auto-discovery loop started");
  });
});

describe("a daemon that fails to start", () => {
  test("on a port already in use leaves its data directory free for the next start", async () => {
    const place = await layout();
    const taken = await listening();
    try {
      expect((await refused({ argv: ["--config", place.configPath, "--addr", `127.0.0.1:${taken.port}`], env: place.env, providers: {}, instancesPath: place.instancesPath })).kind).toBe("server_run");
    } finally {
      await taken.close();
    }
    expect((await start(place)).web?.port).toBeGreaterThan(0);
  });

  test("because the port its config names is taken gives up its data directory and opens no other", async () => {
    const taken = await listening();
    const place = await layout(`[daemon.web]\nenabled = true\nbind_addr = "127.0.0.1:${taken.port}"\n`);
    const before = listeningPorts();
    try {
      const failure = await refused({ argv: ["--config", place.configPath], env: place.env, providers: {}, instancesPath: place.instancesPath });
      expect([failure.kind, failure.message]).toEqual(["server_run", expect.stringContaining(`Failed to start shore-daemon on 127.0.0.1:${String(taken.port)}`) as string]);
      expect(openedSince(before)).toEqual([]);
    } finally {
      await taken.close();
    }
    await writeFile(place.configPath, `[daemon.web]\nenabled = true\nbind_addr = "127.0.0.1:0"\n`);
    expect((await start(place)).web).toBeDefined();
  });

  test("because it can't record itself as running gives up both of its ports and its data directory", async () => {
    const place = await layout(`[daemon.web]\nenabled = true\nbind_addr = "127.0.0.1:0"\n`);
    await writeFile(join(place.root, "a-file"), "");
    const before = listeningPorts();
    const failure = await refused({ argv: ["--config", place.configPath, "--addr", "127.0.0.1:0"], env: place.env, providers: {}, instancesPath: join(place.root, "a-file", "instances.json") });
    expect(failure.kind).toBe("register_instance");
    expect(openedSince(before)).toEqual([]);
    expect((await start(place)).web?.port).toBeGreaterThan(0);
  });
});

describe("a daemon's teardown", () => {
  test("going down also stops its browser transport, its clocks and its matrix bridge", async () => {
    const place = await layout(`[daemon.web]\nenabled = true\nbind_addr = "127.0.0.1:0"\n`);
    let webPort: number | undefined;
    const realClocks = runtimeModule.startRuntimeClocks;
    const realBridge = matrixModule.superviseMatrixBridge;
    const stopped: string[] = [];
    const clocks = spyOn(runtimeModule, "startRuntimeClocks").mockImplementation((runtime, intervals) => {
      const started = realClocks(runtime, intervals);
      return { stop: async () => { stopped.push("clocks"); await started.stop(); } };
    });
    const bridge = spyOn(matrixModule, "superviseMatrixBridge").mockImplementation((options) => {
      const started = realBridge(options);
      return { done: started.done, stop: async () => { stopped.push("matrix bridge"); await started.stop(); } };
    });
    try {
      const daemon = await start(place);
      webPort = daemon.web?.port;
      expect(listeningPorts().has(webPort ?? 0)).toBe(true);
      daemon.stop();
      await daemon.done;
      running.length = 0;
    } finally {
      clocks.mockRestore();
      bridge.mockRestore();
    }
    expect([stopped, listeningPorts().has(webPort ?? 0)]).toEqual([["matrix bridge", "clocks"], false]);
  });

  test("a failure late in startup takes down everything started before it, and frees its ports and data directory", async () => {
    const place = await layout(`[daemon.web]\nenabled = true\nbind_addr = "127.0.0.1:0"\n`);
    const before = listeningPorts();
    const { log, lines } = recorder();
    const bridge = spyOn(matrixModule, "superviseMatrixBridge").mockImplementation(() => {
      throw new Error("no bridge today");
    });
    let failure: StartupError | undefined;
    try {
      failure = await refused({ argv: ["--config", place.configPath, "--addr", "127.0.0.1:0"], env: place.env, providers: {}, instancesPath: place.instancesPath, log });
    } finally {
      bridge.mockRestore();
    }
    expect([failure.kind, failure.message]).toEqual(["server_run", expect.stringContaining("no bridge today") as string]);
    expect(openedSince(before)).toEqual([]);
    expect(await instances(place)).toEqual([]);
    expect(["Auto-discovery loop stopped", "Config hot reload watcher stopped", "Unregistered daemon instance"].filter((line) => !lines.includes(line))).toEqual([]);
    expect((await start(place)).web?.port).toBeGreaterThan(0);
  });

  test("a matrix bridge supervisor that fails is logged instead of left to crash the daemon", async () => {
    const place = await layout();
    const { log, lines } = recorder();
    const bridge = spyOn(matrixModule, "superviseMatrixBridge").mockImplementation(() => ({ done: Promise.reject(new Error("bridge broke")), stop: async () => {} }));
    try {
      running.push(await startDaemon({ argv: ["--config", place.configPath, "--addr", "127.0.0.1:0"], env: place.env, providers: {}, instancesPath: place.instancesPath, log, autoDiscovery: false }));
      await until(() => lines.includes("warn: Matrix bridge supervisor stopped"), "the supervisor's failure being logged");
    } finally {
      bridge.mockRestore();
    }
  });
});

describe("settling after startup", () => {
  async function settling(stopFirst: boolean): Promise<number> {
    const place = await layout();
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const seeding = spyOn(turnModule, "ensureAndBackfillAutonomy").mockImplementation(async () => { await held; });
    try {
      const daemon = await start(place);
      const looks = spyOn(daemon.runtime.autonomy, "tick");
      if (stopFirst) daemon.stop();
      release();
      await daemon.settled;
      return looks.mock.calls.length;
    } finally {
      seeding.mockRestore();
    }
  }

  test("a daemon looks for work once its startup has settled", async () => {
    expect(await settling(false)).toBe(1);
  });

  test("a daemon stopped before its startup has settled doesn't look for work afterwards", async () => {
    expect(await settling(true)).toBe(0);
  });
});

describe("a daemon coming up with characters", () => {
  test("starts each character's init script as its tools' user, and says when it can't", async () => {
    const place = await layout('[tools]\nuser = "nobody"\n');
    const { log, lines } = recorder();
    running.push(await startDaemon({ argv: ["--config", place.configPath, "--addr", "127.0.0.1:0"], env: place.env, providers: {}, instancesPath: place.instancesPath, log, autoDiscovery: false }));
    await until(() => lines.includes("warn: Could not start a character's init script"), "the init script failing to start");
  });

  test("registers every character's wake runner, and says so, before their activity has been read from history", async () => {
    const place = await layout("", ["ada", "bo"]);
    const { log, fields } = recorder();
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const seeding = spyOn(turnModule, "ensureAndBackfillAutonomy").mockImplementation(async () => { await held; });
    try {
      const daemon = await startDaemon({ argv: ["--config", place.configPath, "--addr", "127.0.0.1:0"], env: place.env, providers: {}, instancesPath: place.instancesPath, log, autoDiscovery: false });
      running.push(daemon);
      expect([daemon.runtime.autonomy.status("ada")?.character, daemon.runtime.autonomy.status("bo")?.character]).toEqual(["ada", "bo"]);
      expect(fields.get("Autonomy started for known characters")).toEqual({ characters: "ada, bo" });
    } finally {
      release();
      seeding.mockRestore();
    }
  });

  test("hands a home thread's pinned model to the character", async () => {
    const place = await layout(MODEL_CONFIG);
    const first = await start(place);
    await first.runtime.registry.setThreadModel("ada", "main", "anthropic:claude-opus-4-8");
    first.stop();
    await first.done;
    running.length = 0;
    const data = (await start(place)).runtime.config.dirs.data;
    expect(await threadChatModel(data, "ada", "main")).toBeUndefined();
    expect(loadForCharacter(data, "ada")[1].selected).toEqual({ provider: "anthropic", modelId: "claude-opus-4-8" });
  });
});

describe("the web UI while a long reply runs", () => {
  test("a browser that opens the thread mid-reply, or switches into it, gets everything said so far and stays connected", async () => {
    const place = await layout(`${MODEL_CONFIG}[daemon.web]\nenabled = true\nbind_addr = "127.0.0.1:0"\n`);
    let parked = (): void => {};
    const reachedPark = new Promise<void>((resolve) => { parked = resolve; });
    let release = (): void => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const rounds = 150;
    const provider = {
      async *stream(req: SidecarRequest) {
        yield { type: "start", model: req.model };
        for (let i = 0; i < rounds; i += 1) {
          yield { type: "thinking", text: `t${String(i)} ` };
          yield { type: "text", text: `x${String(i)} ` };
        }
        parked();
        await held;
        yield { type: "done", content: "done", finish_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 }, timing: { total_ms: 1, time_to_first_token_ms: 1 } };
      },
      generate: () => { throw new Error("this test never calls generate"); },
    } as unknown as SidecarProvider;
    const daemon = await start(place, [], { anthropic: provider });
    const origin = required(daemon.web).origin;
    const { code } = await (await fetch(`${origin}/api/login-code`, { method: "POST", headers: { authorization: `Bearer ${TEST_TOKEN}` } })).json() as { code: string };
    const cookie = (await fetch(`${origin}/api/login`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: code }) }))
      .headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const client = await Client.open(daemon, "ada", ["request-lifecycle"]);
    const browsers: BrowserSocket[] = [];
    try {
      await client.awaitFrame("history");
      client.send({ type: "command", rid: "side", name: "create_thread", args: { name: "side" } });
      await client.awaitFrame("command_output");
      client.send({ type: "message", rid: "long", text: "play", stream: true, images: [] });
      await reachedPark;
      const said = (browser: BrowserSocket, kind: string): string => browser.messages
        .flatMap((frame) => frame.type === "stream_chunk" && frame.content_type === kind ? [frame.text] : []).join("");
      const expected = (prefix: string): string => Array.from({ length: rounds }, (_, i) => `${prefix}${String(i)} `).join("");

      const opener = new BrowserSocket(origin, cookie);
      browsers.push(opener);
      await opener.attach("ada", "main");
      const mover = new BrowserSocket(origin, cookie);
      browsers.push(mover);
      await mover.attach("ada", "side");
      mover.send({ type: "command", rid: "move", name: "switch_thread", args: { name: "main" } });
      for (const browser of browsers) {
        await until(() => said(browser, "text") === expected("x"), `a browser to hear the reply so far; closed: ${browser.closeDetail}`);
        expect(said(browser, "thinking")).toBe(expected("t"));
      }

      release();
      for (const browser of browsers) {
        const end = await browser.frame("stream_end", "long");
        expect(end.type === "stream_end" && end.is_final).toBe(true);
        expect(browser.socket.readyState).toBe(WebSocket.OPEN);
      }
    } finally {
      release();
      client.close();
      for (const browser of browsers) await browser.close();
    }
  });
});
