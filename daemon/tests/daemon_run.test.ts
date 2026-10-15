import { required } from "../src/util/required.ts";

import { afterEach, describe, expect, test } from "bun:test";
import { connect, createServer, type Socket } from "node:net";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type RunningDaemon } from "../src/daemon/run.ts";
import { StartupError } from "../src/daemon/startup.ts";
import { DATA_DIRECTORY_LEASE_FILE } from "../src/daemon/data_directory_lease.ts";
import type { InstanceInfo } from "../src/daemon/instances.ts";
import type { SidecarProvider, SidecarRequest } from "../src/llm/types.ts";

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
