/**
 * The daemon, started for real.
 *
 * A real socket, real directories, a real instance registry file. Almost
 * nothing in `run.ts` is a computation, so what is asserted here is the *order*
 * — and every one of these is silent when it is wrong:
 *
 * - **The registry records the resolved port.** `--addr 127.0.0.1:0` asks the
 *   kernel to choose. A daemon that wrote back what it was asked for would put
 *   a literal `:0` in `instances.json` and send every discovery client to a
 *   port nobody opened.
 * - **The handshake answers from the character registry.** Wire it to the
 *   wrong thing and a client still connects, still gets a frame, and sees one
 *   character called `default`.
 * - **The handler starts before the server serves.** Reverse them and a client
 *   that hand-shakes fast enough is answered by nobody, forever.
 * - **A history change reaches connected clients.** The engine's listener is
 *   the server's broadcast. Miss it and the conversation still persists; it
 *   just stops appearing until something reconnects.
 * - **A refused bind opens nothing and registers nothing.** The remote-access
 *   policy is only worth anything if it runs before the socket does.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { connect, createServer, type Socket } from "node:net";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bounded, formatAddr, startDaemon, type RunningDaemon } from "../src/daemon/run.ts";
import { StartupError } from "../src/daemon/startup.ts";
import type { InstanceInfo } from "../src/instances.ts";
import type { SidecarProvider, SidecarRequest } from "../src/llm/types.ts";

/** Every daemon a test started, stopped after it whatever happened. */
const running: RunningDaemon[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) {
    daemon.stop();
    await daemon.done;
  }
});

interface Layout {
  root: string;
  configPath: string;
  instancesPath: string;
  env: NodeJS.ProcessEnv;
}

/**
 * A config directory with `characters/<name>/` on disk, and XDG pointed at it.
 *
 * The file is `shore.toml` rather than `config.toml` on purpose. `--config`
 * re-homes the config directory to the file's parent, so with the usual name
 * the path the daemon was *given* and the path it would *guess* are the same
 * string — and a runtime that guessed would pass unnoticed.
 */
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
    },
  };
}

async function start(
  place: Layout,
  extraArgv: readonly string[] = [],
  providers: Partial<Record<string, SidecarProvider>> = {},
): Promise<RunningDaemon> {
  const daemon = await startDaemon({
    argv: ["--config", place.configPath, "--addr", "127.0.0.1:0", ...extraArgv],
    env: place.env,
    providers,
    instancesPath: place.instancesPath,
  });
  running.push(daemon);
  return daemon;
}

/** A config naming a model this test can answer for. */
const MODEL_CONFIG =
  `[defaults]\nmodel = "anthropic:claude-opus-4-8"\n\n` +
  `[providers.anthropic]\napi_key_env = "SHORE_TEST_KEY"\n`;

/** One assistant turn, streamed. */
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

async function instances(place: Layout): Promise<InstanceInfo[]> {
  return JSON.parse(await readFile(place.instancesPath, "utf8")) as InstanceInfo[];
}

/** A connected client that buffers every frame the daemon sends it. */
class Client {
  readonly frames: Record<string, unknown>[] = [];
  #buffered = "";

  private constructor(readonly socket: Socket) {}

  static async open(port: number, selected: string | null): Promise<Client> {
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
        capabilities: [],
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

  /** The first frame of a type, waiting up to `timeoutMs` for one to arrive. */
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
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  close(): void {
    this.socket.destroy();
  }
}

describe("coming up", () => {
  test("the registry records the port the kernel chose, not the one asked for", async () => {
    const place = await layout();
    const daemon = await start(place);

    expect(daemon.port).toBeGreaterThan(0);

    const [entry, ...rest] = await instances(place);
    expect(rest).toEqual([]);
    expect(entry?.addr).toBe(`127.0.0.1:${daemon.port}`);
    expect(entry?.id).toBe(daemon.instanceId);
    expect(entry?.pid).toBe(process.pid);
    // Carried so a CLI can read the same ledger and the same config.toml
    // without being told where they are.
    expect(entry?.data_dir).toBe(daemon.runtime.config.dirs.data);
    expect(entry?.config_dir).toBe(join(place.root, "config"));
  });

  test("--instance-id pins the registered id", async () => {
    const place = await layout();
    const daemon = await start(place, ["--instance-id", "shore-mcp-test"]);

    expect(daemon.instanceId).toBe("shore-mcp-test");
    expect((await instances(place))[0]?.id).toBe("shore-mcp-test");
  });

  test("the runtime is pointed at the config file the daemon was started with", async () => {
    const place = await layout();
    const daemon = await start(place);

    // Every reload re-reads exactly this. A daemon that re-resolved XDG on
    // reload could read a different file than it started from.
    expect(daemon.runtime.configPath).toBe(place.configPath);
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
      // Not `["default"]`, which is what an unattached handshake answers.
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

      // Answered by the same provider the handshake uses. Give the command
      // path its own and this still replies — with an empty snapshot that
      // names nobody, and a client rendering the wrong window.
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

      // The whole wiring in one assertion: the router resolved the character,
      // the generation deps reached the provider table, and the frames came
      // back out over the broadcast this daemon built the runtime with.
      await client.awaitFrame("stream_start");
      const end = await client.awaitFrame("stream_end");
      expect(JSON.stringify(end)).toContain("hello back");
      // The stream frames go to the issuing session directly; `new_message` is
      // the *broadcast*, so this is the half that proves the runtime was built
      // with this server's event channel and not with nothing.
      expect(await client.awaitFrame("new_message")).toBeDefined();

      const engine = await daemon.runtime.registry.getOrCreate("ada");
      const messages = engine.historySnapshot({}).messages;
      expect(messages.map((m) => m.content)).toEqual(["hi", "hello back"]);
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

      // The engine's history listener is this server's broadcast. Unwired, the
      // message still persists and simply stops appearing.
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

describe("going down", () => {
  test("clients are told, and the instance is unregistered", async () => {
    const place = await layout();
    const daemon = await start(place);
    const client = await Client.open(daemon.port, "ada");
    try {
      await client.awaitFrame("hello");

      daemon.stop();
      await daemon.done;

      // Broadcast before the listener closes, so a client learns the daemon is
      // going away rather than seeing a bare EOF.
      await client.awaitFrame("shutdown");
      expect(await instances(place)).toEqual([]);
    } finally {
      client.close();
      running.length = 0;
    }
  });

  test("the stores are let go, so nothing outlives the process", async () => {
    const place = await layout();
    const daemon = await start(place);
    const store = daemon.runtime.callStore;
    expect(store).toBeDefined();

    daemon.stop();
    await daemon.done;
    running.length = 0;

    // A call store left open is a SQLite handle and an MCP registry left
    // connected is a child process; neither shows up as a failure, only as
    // something still holding a file or a pid after the daemon has "stopped".
    expect(() => store?.rotate(new Date(0), 1)).toThrow();
  });

  test("a shutdown step that overruns is abandoned rather than waited on", async () => {
    const warnings: string[] = [];
    const never = new Promise(() => {});

    await bounded(never, "wedged", { warn: (msg) => warnings.push(msg) }, 20);

    // The sequence is racing whatever is about to SIGKILL the process; the
    // next step is more likely to matter than this one is to finish.
    expect(warnings).toEqual(["Shutdown step timed out"]);
  });

  test("the port is free afterwards", async () => {
    const place = await layout();
    const daemon = await start(place);
    const port = daemon.port;
    daemon.stop();
    await daemon.done;
    running.length = 0;

    // Rebinding the same port is the only proof the listener really closed;
    // a daemon that left it open makes the next start fail.
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });
});

describe("refusing to start", () => {
  test("a non-loopback bind opens nothing and registers nothing", async () => {
    const place = await layout(`
[daemon]
addr = "0.0.0.0:0"
`);

    let caught: unknown;
    try {
      await startDaemon({
        argv: ["--config", place.configPath],
        env: place.env,
        providers: {},
        instancesPath: place.instancesPath,
      });
    } catch (e) {
      caught = e;
    }

    expect((caught as StartupError).kind).toBe("remote_access_policy");
    // The policy runs before the socket does, which is the whole point of it.
    expect(existsSync(place.instancesPath)).toBe(false);
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
      await new Promise<void>((resolve) => taken.close(() => resolve()));
    }

    expect((caught as StartupError).kind).toBe("server_run");
    expect((caught as StartupError).message).toContain(`127.0.0.1:${port}`);
    // Binding first is what keeps this cheap: no ledger, no MCP servers, and
    // nothing in the registry to clean up.
    expect(existsSync(place.instancesPath)).toBe(false);
  });
});

describe("formatAddr", () => {
  test("an IPv6 host is bracketed, so the string splits back on its last colon", () => {
    expect(formatAddr("127.0.0.1", 7320)).toBe("127.0.0.1:7320");
    expect(formatAddr("::1", 7320)).toBe("[::1]:7320");
  });
});
