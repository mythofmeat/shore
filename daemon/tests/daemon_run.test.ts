import { required } from "../src/util/required.ts";

import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import { connect, createServer, type Socket } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exitIfStillRunning, startDaemon, type RunningDaemon } from "../src/daemon/run.ts";
import { StartupError } from "../src/daemon/startup.ts";
import { DATA_DIRECTORY_LEASE_FILE } from "../src/daemon/data_directory_lease.ts";
import type { InstanceInfo } from "../src/daemon/instances.ts";
import type { SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import { threadActivityNow } from "../src/engine/threads.ts";
import { loadCompactionCheckpoint, saveCompactionCheckpoint } from "../src/memory/compaction/checkpoint.ts";
import { shoreLog } from "../src/log.ts";
import { CharacterWorkspace } from "../src/tools/character_workspace.ts";
import { compactionFixture } from "./support/memory_fixture.ts";
import { until } from "./support/until.ts";

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
  `[providers.anthropic]\napi_key_env = "SHORE_TEST_KEY"\n`;

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
  #buffered = "";

  private constructor(readonly socket: Socket) {}

  static async open(port: number, selected: string | null, capabilities: string[] = []): Promise<Client> {
    const socket = connect({ host: "127.0.0.1", port, noDelay: true });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const client = new Client(socket);
    socket.on("data", (chunk: Buffer) => client.#consume(chunk.toString("utf8")));
    socket.write(
      `${JSON.stringify({
        type: "hello",
        client_type: "tui",
        client_name: "test",
        capabilities,
        token: TEST_TOKEN,
        ...(selected === null ? {} : { character: selected }),
      })}\n`,
    );
    return client;
  }

  #consume(text: string): void {
    this.#buffered += text;
    for (;;) {
      const at = this.#buffered.indexOf("\n");
      if (at === -1) return;
      const line = this.#buffered.slice(0, at);
      this.#buffered = this.#buffered.slice(at + 1);
      if (line.trim() !== "") this.frames.push(JSON.parse(line) as Record<string, unknown>);
    }
  }

  send(message: unknown): void {
    this.socket.write(`${JSON.stringify(message)}\n`);
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
    this.socket.destroy();
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
    const archiver = await Client.open(daemon.port, "ada");
    const viewer = await Client.open(daemon.port, "ada", ["request-lifecycle"]);
    const atHome = await Client.open(daemon.port, "ada");
    const elsewhere = await Client.open(daemon.port, "ada");
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

  test("stops paying to keep the archived thread warm, and leaves another thread's cache slot alone", async () => {
    const place = await layout(MODEL_CONFIG);
    const daemon = await start(place, [], { anthropic: scriptedProvider("hello back") });
    const client = await Client.open(daemon.port, "ada", ["request-lifecycle"]);
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
      await finishTurn(client, "over here");
      await until(() => keepalive.warmThread("ada") === "side", "the side thread to get the cache slot");
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
  test("the handshake names the characters actually on disk", async () => {
    const place = await layout("", ["ada", "nova"]);
    const daemon = await start(place);
    const client = await Client.open(daemon.port, null);
    try {
      const hello = await client.awaitFrame("hello");
      const names = (hello["characters"] as { name: string }[]).map((c) => c.name);
      expect(names.sort()).toEqual(["ada", "nova"]);
    } finally {
      client.close();
    }
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
    const client = await Client.open(daemon.port, "ada");
    try {
      await client.awaitFrame("hello");
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
    const client = await Client.open(daemon.port, "ada");
    try {
      await client.awaitFrame("hello");
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
    const client = await Client.open(daemon.port, "ada");
    try {
      await client.awaitFrame("hello");
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
    const client = await Client.open(daemon.port, "ada");
    try {
      await client.awaitFrame("hello");
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
    const client = await Client.open(daemon.port, "ada");
    try {
      await client.awaitFrame("hello");
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
    const client = await Client.open(daemon.port, "ada");
    try {
      await client.awaitFrame("hello");

      await writeFile(place.configPath, "[tools]\nmax_result_chars = ");
      await client.awaitFrame("config_warning");

      expect(daemon.runtime.registry.globalConfig().app.tools.max_result_chars).toBe(4242);
    } finally {
      client.close();
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
  test("clients are told, and the instance is unregistered", async () => {
    const place = await layout();
    const daemon = await start(place);
    const client = await Client.open(daemon.port, "ada");
    try {
      await client.awaitFrame("hello");

      daemon.stop();
      await daemon.done;

      await client.awaitFrame("shutdown");
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
    const client = await Client.open(daemon.port, "ada");
    try {
      await client.awaitFrame("hello");
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
    const client = await Client.open(daemon.port, "ada");
    try {
      await client.awaitFrame("hello");
      client.send({ type: "message", text: "hi", stream: true, images: [] });
      await client.awaitFrame("stream_start");
      const began = Date.now();
      await daemon.shutdown();
      expect(Date.now() - began).toBeGreaterThanOrEqual(900);
      await client.awaitFrame("shutdown");
      release();
    } finally {
      client.close();
    }
  });

  test("a compaction a shutdown paused carries on from its checkpoint when the daemon starts again", async () => {
    const place = await layout(`${MODEL_CONFIG}[tools]\nenabled = ["bash"]\n`);
    const compactions: string[] = [];
    const chat = scriptedProvider("noted");
    const stalled = {
      async *stream(req: SidecarRequest, signal?: AbortSignal) {
        if (req.context?.call_type !== "compaction") { yield* chat.stream(req, signal); return; }
        compactions.push("stalled");
        yield { type: "start", model: req.model };
        await new Promise<void>((resolve) => { if (signal?.aborted === true) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
        throw new Error("stopped");
      },
    } as unknown as SidecarProvider;
    const memory = compactionFixture();
    const finishing = {
      async *stream(req: SidecarRequest, signal?: AbortSignal) {
        if (req.context?.call_type !== "compaction") { yield* chat.stream(req, signal); return; }
        compactions.push("resumed");
        yield* memory(req, signal);
      },
    } as unknown as SidecarProvider;

    const first = await start(place, [], { anthropic: stalled });
    const client = await Client.open(first.port, "ada");
    await client.awaitFrame("hello");
    for (const text of ["one", "two", "three"]) {
      client.frames.length = 0;
      client.send({ type: "message", text, stream: true, images: [] });
      await client.awaitFrame("new_message");
      await client.awaitFrame("stream_end");
    }
    client.send({ type: "command", name: "compact", args: { keep_turns: 1 } });
    for (let i = 0; compactions.length === 0; i += 1) {
      if (i > 500) throw new Error("the compaction never reached the provider");
      await Bun.sleep(10);
    }
    client.close();
    await first.shutdown();
    await first.done;
    running.length = 0;

    const second = await start(place, [], { anthropic: finishing });
    const watcher = await Client.open(second.port, "ada");
    try {
      await watcher.awaitFrame("hello");
      for (let i = 0; ; i += 1) {
        watcher.frames.length = 0;
        watcher.send({ type: "command", name: "compact_watch", args: {} });
        const output = await watcher.awaitFrame("command_output");
        const pass = (output["data"] as { pass: { report: { status: string } | null } | null }).pass;
        if (pass?.report?.status === "compacted") break;
        if (i > 200) throw new Error(`the paused compaction never finished: ${JSON.stringify(output)}`);
        await Bun.sleep(25);
      }
      expect([...new Set(compactions)]).toEqual(["stalled", "resumed"]);
    } finally {
      watcher.close();
    }
  });

  test("web UI settings a browser saved are there when the daemon starts again", async () => {
    const place = await layout('[daemon.web]\nenabled = true\nbind_addr = "127.0.0.1:0"\n');
    const page = async (daemon: RunningDaemon, save?: Record<string, string>) => {
      const origin = required(daemon.web).origin;
      const post = async (path: string, body: unknown, cookie = "") => await fetch(`${origin}${path}`, { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
      const cookie = (await post("/api/login", { token: TEST_TOKEN })).headers.get("set-cookie")?.split(";", 1)[0] ?? "";
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
    const port = daemon.port;
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

describe("coming back up", () => {
  const IDLE_CONFIG = `${MODEL_CONFIG}[tools]\nenabled = ["bash"]\n[triggers]\nenabled = true\n[compaction]\nidle_after = "1s"\nmin_turns = 2\nkeep_recent_turns = 0\n`;
  const PAST_IDLE_MS = 1_100;

  function compacting(onPass: (signal?: AbortSignal) => Promise<void> = () => Promise.resolve()): SidecarProvider {
    const chat = scriptedProvider("noted");
    const memory = compactionFixture();
    return {
      async *stream(req: SidecarRequest, signal?: AbortSignal) {
        if (req.context?.call_type !== "compaction") { yield* chat.stream(req, signal); return; }
        await onPass(signal);
        yield* memory(req, signal);
      },
    } as unknown as SidecarProvider;
  }

  function stalling(reached: () => void): SidecarProvider {
    return compacting(async (signal) => {
      reached();
      await new Promise<void>((resolve) => { if (signal?.aborted === true) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
      throw new Error("stopped");
    });
  }

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

  async function shutDown(daemon: RunningDaemon): Promise<void> {
    await daemon.shutdown();
    await daemon.done;
    running.length = 0;
  }

  test("a conversation left idle compacts once the daemon is back, without anyone saying anything", async () => {
    const place = await layout(IDLE_CONFIG);
    const provider = compacting();
    const first = await start(place, [], { anthropic: provider });
    const client = await Client.open(first.port, "ada");
    await client.awaitFrame("hello");
    await talk(client, ["one", "two", "three"]);
    client.close();
    const data = first.runtime.config.dirs.data;
    await shutDown(first);
    await Bun.sleep(PAST_IDLE_MS);

    await start(place, [], { anthropic: provider });

    await until(() => threadActivityNow(data, "ada", "main").turns === 0, "the idle conversation compacting");
  });

  test("a daemon that died compacting waits out the idle time before trying again", async () => {
    const place = await layout(IDLE_CONFIG);
    let stalled = false;
    const first = await start(place, [], { anthropic: stalling(() => { stalled = true; }) });
    const client = await Client.open(first.port, "ada");
    await client.awaitFrame("hello");
    await talk(client, ["one", "two", "three"]);
    client.send({ type: "command", name: "compact", args: { keep_turns: 0 } });
    await until(() => stalled, "the compaction reaching the provider");
    client.close();
    const data = first.runtime.config.dirs.data;
    await shutDown(first);
    const checkpoint = required(await loadCompactionCheckpoint(data, "ada", "main"));
    checkpoint.state = "running";
    delete checkpoint.resumeOnStart;
    await saveCompactionCheckpoint(data, checkpoint, "main");
    await Bun.sleep(PAST_IDLE_MS);

    let passes = 0;
    const second = await start(place, [], { anthropic: compacting(() => { passes += 1; return Promise.resolve(); }) });
    await second.settled;
    await Bun.sleep(PAST_IDLE_MS);
    expect(passes).toBe(0);

    await second.runtime.autonomy.tick();
    expect(passes).toBeGreaterThan(0);
    expect(threadActivityNow(data, "ada", "main").turns).toBe(0);
  });

  test("a side thread's compaction resumed at startup finishes first, then the idle home thread compacts", async () => {
    const place = await layout(IDLE_CONFIG);
    let stalled = false;
    const first = await start(place, [], { anthropic: stalling(() => { stalled = true; }) });
    const client = await Client.open(first.port, "ada");
    await client.awaitFrame("hello");
    await talk(client, ["one", "two", "three"]);
    await command(client, "create_thread", { name: "side" });
    await command(client, "switch_thread", { name: "side" });
    await talk(client, ["four", "five", "six"]);
    client.send({ type: "command", name: "compact", args: { keep_turns: 0 } });
    await until(() => stalled, "the side thread's compaction reaching the provider");
    client.close();
    const data = first.runtime.config.dirs.data;
    await shutDown(first);
    await Bun.sleep(PAST_IDLE_MS);

    const resuming = Promise.withResolvers<void>();
    let passes = 0;
    const second = await start(place, [], { anthropic: compacting(async () => { passes += 1; await resuming.promise; }) });
    await until(() => passes > 0, "the side thread's compaction resuming");
    await second.runtime.autonomy.tick();
    expect(passes).toBe(1);
    expect(threadActivityNow(data, "ada", "main").turns).toBe(3);

    resuming.resolve();
    await second.settled;
    await until(() => threadActivityNow(data, "ada", "side").turns === 0, "the side thread compacting");
    await until(() => threadActivityNow(data, "ada", "main").turns === 0, "the idle home thread compacting");
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
