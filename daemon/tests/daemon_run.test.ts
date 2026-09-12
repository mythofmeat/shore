import { writeDurable } from "../src/storage/files.ts";
import { required } from "../src/util/required.ts";

import { afterEach, describe, expect, test } from "bun:test";
import { connect, createServer, type Socket } from "node:net";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultToolsConfig } from "../src/config/app.ts";
import {
  bounded,
  describeRejection,
  formatAddr,
  startDaemon,
  type RunningDaemon,
} from "../src/daemon/run.ts";
import { ACCESS_TOKEN_ENV } from "../src/connections/matrix/start.ts";
import { StartupError } from "../src/daemon/startup.ts";
import { DATA_DIRECTORY_LEASE_FILE } from "../src/daemon/data_directory_lease.ts";
import type { InstanceInfo } from "../src/daemon/instances.ts";
import type { SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import { BrowserSocket } from "./support/browser.ts";
import { browserConnection } from "./support/browser_connection.ts";
import { OperationClient } from "../src/browser/operations.ts";

const running: RunningDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) {
    daemon.stop();
    await daemon.done;
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
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
  roots.push(root);
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

async function until(holds: () => boolean, complaint: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error(complaint);
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

async function instances(place: Layout): Promise<InstanceInfo[]> {
  return JSON.parse(await readFile(place.instancesPath, "utf8")) as InstanceInfo[];
}

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

    expect(daemon.runtime.configPath).toBe(place.configPath);
  });

  test("autonomy is running for every character on disk before anyone speaks", async () => {
    const place = await layout("", ["ada", "bo"]);
    const daemon = await start(place);

    expect(daemon.runtime.autonomy.status("ada")).toBeDefined();
    expect(daemon.runtime.autonomy.status("bo")).toBeDefined();
  });

  test("a wake that came due while the daemon was down is held off, not fired at once", async () => {
    const place = await layout();
    const charData = join(place.root, "data", "shore", "ada");
    await mkdir(charData, { recursive: true });
    const overdue = Date.now() - 45 * 60_000;
    writeDurable(join(charData, "autonomy_state.json"), JSON.stringify({
        version: 4,
        ticks_without_user: 0,
        next_wake_at: new Date(overdue).toISOString().replace(/\.\d{3}Z$/, "+00:00"),
        last_user_at: new Date(overdue - 3_600_000).toISOString().replace(/\.\d{3}Z$/, "+00:00"),
        covered_turn_count: 0,
        keepalive_model: null,
        keepalive_interval_ms: null,
        keepalive_last_warm_at: null,
        keepalive_last_active_at: null,
      }));

    const startedAt = Date.now();
    const daemon = await start(place);
    const state = daemon.runtime.autonomy.status("ada");

    expect(state).toBeDefined();
    expect(state?.next_wake_at).toBeGreaterThanOrEqual(
      startedAt + (state?.min_interval_ms ?? 0),
    );
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

describe("registered operation socket flows", () => {
  test("an empty installation validates creation before writing and selects the new character", async () => {
    const place = await layout("", []);
    const daemon = await start(place);
    const client = await Client.open(daemon.port, null);
    const workspace = join(place.root, "config", "characters", "nova", "workspace");
    try {
      await client.awaitFrame("hello");
      client.send({ type: "command", rid: "bad-create", name: "create_character", args: { name: "nova", unexpected: true } });
      expect(await client.awaitFrame("error")).toMatchObject({ rid: "bad-create", code: "invalid_request" });
      expect(existsSync(workspace)).toBe(false);
      client.frames.length = 0;
      client.send({ type: "command", rid: "create", name: "create_character", args: { name: "nova" } });
      expect(await client.awaitFrame("command_output")).toMatchObject({
        rid: "create", name: "create_character", data: {
          character: "nova", workspace_dir: workspace,
          config_dir: join(place.root, "config", "characters", "nova"),
          created_files: ["SOUL.md", "USER.md", "AGENTS.md", "TOOLS.md"],
        },
      });
      expect(await readFile(join(workspace, "SOUL.md"), "utf8")).toBe("You are nova.\n");
      expect(await readFile(join(workspace, "USER.md"), "utf8")).toBe("");
      expect(await readFile(join(workspace, "AGENTS.md"), "utf8")).not.toBe("");
      expect(await readFile(join(workspace, "TOOLS.md"), "utf8")).toBe("");
      client.frames.length = 0;
      client.send({ type: "command", rid: "select", name: "switch_character", args: { name: "nova" } });
      expect(await client.awaitFrame("command_output")).toMatchObject({
        rid: "select", name: "switch_character", data: { character: "nova", selected_character: "nova", changed: true, active_model: null },
      });
      expect(await client.awaitFrame("history")).toMatchObject({ rid: "select", messages: [] });
    } finally {
      client.close();
    }
  });

  test("a fork validates advanced options and selecting it exposes the actual copied turns", async () => {
    const place = await layout();
    const daemon = await start(place);
    const engine = await daemon.runtime.registry.getOrCreate("ada");
    for (const [index, content] of ["first", "first answer", "second", "second answer"].entries()) {
      await engine.appendMessage({
        msg_id: `source_${index}`, role: index % 2 === 0 ? "user" : "assistant", content,
        images: [], content_blocks: [{ type: "text", text: content }], timestamp: new Date().toISOString(),
      });
    }
    const client = await Client.open(daemon.port, "ada");
    try {
      await client.awaitFrame("history");
      client.frames.length = 0;
      client.send({ type: "command", rid: "bad-fork", name: "fork_thread", args: { name: "branch", from: "main", turns: "1" } });
      expect(await client.awaitFrame("error")).toMatchObject({ rid: "bad-fork", code: "invalid_request" });
      expect(daemon.runtime.registry.listThreads("ada").map((thread) => thread.id)).toEqual(["main"]);
      client.frames.length = 0;
      client.send({ type: "command", rid: "fork", name: "fork_thread", args: { name: "branch", from: "main", turns: 1 } });
      expect(await client.awaitFrame("command_output")).toMatchObject({
        rid: "fork", name: "fork_thread", data: {
          character: "ada", current: "main", home: "main",
          fork: { thread: "branch", source: "main", messages: 2, turns: 1, scope: "last_turns", requested_turns: 1 },
        },
      });
      expect(engine.historySnapshot({}).messages.map((message) => message.content)).toEqual(["first", "first answer", "second", "second answer"]);
      client.frames.length = 0;
      client.send({ type: "command", rid: "select-fork", name: "switch_thread", args: { name: "branch", resync: true } });
      expect(await client.awaitFrame("command_output")).toMatchObject({
        rid: "select-fork", name: "switch_thread", data: { thread: "branch", selected_thread: "branch", changed: true },
      });
      expect(await client.awaitFrame("history")).toMatchObject({
        rid: "select-fork", messages: [{ content: "second" }, { content: "second answer" }],
      });
    } finally {
      client.close();
    }
  });
});

describe("optional browser transport", () => {
  test("typed browser actions discover an empty installation and edit, page, select alternatives and delete persisted conversation", async () => {
    const place = await layout(`${MODEL_CONFIG}\n[daemon.web]\nenabled = true\nbind_addr = "127.0.0.1:0"\n`, []);
    let generations = 0;
    const provider: SidecarProvider = {
      async *stream(request, signal) {
        generations += 1;
        yield* scriptedProvider(`answer ${String(generations)}`).stream(request, signal);
      },
      generate() { throw new Error("Unexpected non-streaming call"); },
    };
    const daemon = await start(place, [], { anthropic: provider }, false);
    const b = browserConnection(required(daemon.web).origin, { character: null, thread: null });
    const actions = new OperationClient(b.client);
    try {
      await b.client.signIn(TEST_TOKEN);
      await until(() => b.client.status === "ready", "Empty browser did not connect");
      const empty = await actions.run("discover_operations", {});
      expect(empty.operations.find((operation) => operation.name === "create_character")?.available).toBe(true);
      expect(empty.operations.find((operation) => operation.name === "edit")?.available).toBe(false);
      await actions.run("create_character", { name: "nova" });
      await actions.run("switch_character", { name: "nova" });
      const available = await actions.run("discover_operations", {});
      expect(available.operations.find((operation) => operation.name === "edit")?.available).toBe(true);
      expect((await b.client.submit({ type: "message", text: "original question", stream: true, images: [], image_data: [] }).finished).outcome).toBe("completed");
      expect((await b.client.submit({ type: "regen", stream: true, guidance: "Another answer" }).finished).outcome).toBe("completed");
      expect((await actions.run("list_alternatives", {})).alternatives.map((alternative) => alternative.content)).toEqual(["answer 1", "answer 2"]);
      expect(await actions.run("alt", { index: 0, position: 2, direction: "last" })).toMatchObject({ position: 1, content: "answer 1" });
      expect(await actions.run("edit", { ref: "1", content: "edited question" })).toMatchObject({ edited: true });
      expect(await actions.run("get", { ref: "-1", role: "user" })).toMatchObject({ content: "edited question" });
      await actions.run("inject_system", { text: "Keep the context" });
      const page = await actions.run("log", { count: 1 });
      expect(page.messages.map((message) => message.content)).toEqual(["Keep the context"]);
      expect(page.has_more_before).toBe(true);
      expect((await actions.run("history_page", { before: page.next_before, count: 1 })).messages.map((message) => message.content)).toEqual(["answer 1"]);
      expect(actions.run("edit", { ref: "missing-message", content: "rejected" })).rejects.toThrow("message not found");
      const removed = await actions.run("delete", { refs: ["1", "last"] });
      expect(removed.deleted).toHaveLength(2);
      const browserHistory = await actions.run("log", {});
      expect(browserHistory.messages.map((message) => message.content)).toEqual(["answer 1"]);
      const tcp = await Client.open(daemon.port, "nova");
      try {
        await tcp.awaitFrame("history"); tcp.frames.length = 0;
        tcp.send({ type: "command", rid: "tcp-log", name: "log", args: {} });
        const result = await tcp.awaitFrame("command_output");
        expect<unknown>(result["data"]).toEqual(browserHistory);
      } finally { tcp.close(); }
      expect((await daemon.runtime.registry.getOrCreate("nova", "main")).historySnapshot({}).messages.map((message) => message.content)).toEqual(["answer 1"]);
    } finally { b.client.stop(); }
  });

  test("a browser can reopen persisted history containing structured tool results and inline images", async () => {
    const place = await layout(`${MODEL_CONFIG}\n[daemon.web]\nenabled = true\nbind_addr = "127.0.0.1:0"\n`);
    const daemon = await start(place, [], {}, false);
    const engine = await daemon.runtime.registry.getOrCreate("ada", "main");
    const base = { images: [], timestamp: "2026-09-12T00:00:00Z" };
    await engine.appendMessage({ ...base, msg_id: "tool-start", role: "assistant", content: "", content_blocks: [{ type: "tool_use", id: "read-image", name: "read_image", input: { path: "example.png" } }] });
    await engine.appendMessage({ ...base, msg_id: "tool-image", role: "user", content: "", content_blocks: [{ type: "tool_result", tool_use_id: "read-image", content: [{ type: "text", text: "image result" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGMUqdjCwMDAxMDAwMDAAAAOigFED/mW/QAAAABJRU5ErkJggg==" } }] }] });
    await engine.appendMessage({ ...base, msg_id: "tool-answer", role: "assistant", content: "I can see the image", content_blocks: [{ type: "text", text: "I can see the image" }] });
    const b = browserConnection(required(daemon.web).origin);
    try {
      await b.client.signIn(TEST_TOKEN);
      await until(() => b.client.status === "ready" || b.client.status === "error", "Browser did not receive persisted history");
      expect(b.client.status).toBe("ready");
      const history = b.updates.find((update) => update.kind === "frame" && update.message.type === "history");
      if (history?.kind !== "frame" || history.message.type !== "history") throw new Error("Missing image history");
      expect(history.message.messages[0]?.content_blocks).toMatchObject([
        { type: "tool_use", id: "read-image" },
        { type: "tool_result", content: [{ type: "text", text: "image result" }, { type: "image", source: { media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGMUqdjCwMDAxMDAwMDAAAAOigFED/mW/QAAAABJRU5ErkJggg==" } }] },
        { type: "text", text: "I can see the image" },
      ]);
    } finally { b.client.stop(); }
  });

  test("the browser connection restores its selected conversation after a daemon restart and sign-in", async () => {
    const place = await layout(`${MODEL_CONFIG}\n[daemon.web]\nenabled = true\nbind_addr = "127.0.0.1:0"\n`);
    const daemon = await start(place, [], { anthropic: scriptedProvider("persisted answer") }, false);
    const web = required(daemon.web);
    const b = browserConnection(web.origin);
    try {
      await b.client.signIn(TEST_TOKEN); await until(() => b.client.status === "ready", "Browser did not connect");
      expect((await b.client.submit({ type: "command", name: "create_thread", args: { name: "side" } }).finished).outcome).toBe("completed");
      expect((await b.client.submit({ type: "command", name: "switch_thread", args: { name: "side", resync: true } }).finished).outcome).toBe("completed");
      expect((await b.client.submit({ type: "message", text: "persisted question", stream: true, images: [], image_data: [] }).finished).outcome).toBe("completed");
      daemon.stop(); await daemon.done;
      await writeFile(place.configPath, `${MODEL_CONFIG}\n[daemon.web]\nenabled = true\nbind_addr = "127.0.0.1:${new URL(web.origin).port}"\n`);
      const restarted = await start(place, [], { anthropic: scriptedProvider("should not be called") }, false);
      expect(required(restarted.web).origin).toBe(web.origin);
      await until(() => b.client.status === "signed_out", "Restarted daemon must require a new browser session");
      b.updates.length = 0;
      await b.client.signIn(TEST_TOKEN); await until(() => b.client.status === "ready", "Browser did not reconnect");
      expect(b.client.selection).toMatchObject({ character: "ada", thread: "side" });
      const history = b.updates.find((update) => update.kind === "frame" && update.message.type === "history");
      if (history?.kind !== "frame" || history.message.type !== "history") throw new Error("Missing restored history");
      expect(history.message.messages.map((message) => message.content)).toEqual(["persisted question", "persisted answer"]);
      expect((await restarted.runtime.registry.getOrCreate("ada", "side")).historySnapshot({}).messages.map((message) => message.content)).toEqual(["persisted question", "persisted answer"]);
      expect(b.client.pendingCount).toBe(0);
    } finally { b.client.stop(); }
  });

  test("a browser learns that an earlier thread's request finished without receiving its stream in the selected thread", async () => {
    const place = await layout(`${MODEL_CONFIG}\n[daemon.web]\nenabled = true\nbind_addr = "127.0.0.1:0"\n`);
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const daemon = await start(place, [], { anthropic: heldProvider(held, "main answer", () => {}) }, false);
    const web = required(daemon.web);
    const login = await fetch(`${web.origin}/api/login`, { method: "POST", headers: { origin: web.origin, "content-type": "application/json" }, body: JSON.stringify({ token: TEST_TOKEN }) });
    const browser = new BrowserSocket(web.origin, required(login.headers.get("set-cookie")?.split(";", 1)[0]));
    try {
      await browser.attach();
      browser.send({ type: "command", rid: "create-side", name: "create_thread", args: { name: "side" } });
      await browser.frame("request_finished", "create-side");
      browser.send({ type: "message", rid: "main-turn", text: "question on main", stream: true });
      await browser.frame("stream_start", "main-turn");
      browser.send({ type: "command", rid: "select-side", name: "switch_thread", args: { name: "side", resync: true } });
      expect(await browser.frame("history", "select-side")).toMatchObject({ selected_thread: "side", messages: [] });
      await browser.frame("request_finished", "select-side");
      release();
      expect(await browser.frame("request_finished", "main-turn")).toMatchObject({ outcome: "completed" });
      expect(browser.messages.some((frame) => frame.type === "stream_end" && frame.rid === "main-turn")).toBe(false);
      expect((await daemon.runtime.registry.getOrCreate("ada", "main")).historySnapshot({}).messages.map((message) => message.content)).toEqual(["question on main", "main answer"]);
    } finally { release(); await browser.close(); }
  });

  test("disabled serving creates no web listener and TCP commands still work", async () => {
    const place = await layout();
    const daemon = await start(place);
    expect(daemon.web).toBeUndefined();
    const client = await Client.open(daemon.port, "ada");
    try {
      await client.awaitFrame("hello");
      client.send({ type: "command", rid: "still-tcp", name: "list_characters", args: {} });
      expect(await client.awaitFrame("command_output")).toMatchObject({ rid: "still-tcp", data: { characters: [{ name: "ada" }] } });
    } finally { client.close(); }
  });

  test("an authenticated browser creates a character, forks its thread and observes the same persisted history as TCP", async () => {
    const place = await layout(`${MODEL_CONFIG}\n[daemon.web]\nenabled = true\nbind_addr = "127.0.0.1:0"\n`, []);
    const daemon = await start(place, [], { anthropic: scriptedProvider("browser answer") }, false);
    const web = required(daemon.web);
    const response = await fetch(`${web.origin}/api/login`, {
      method: "POST", headers: { origin: web.origin, "content-type": "application/json" }, body: JSON.stringify({ token: TEST_TOKEN }),
    });
    expect(response.status).toBe(200);
    const cookie = required(response.headers.get("set-cookie")?.split(";", 1)[0]);
    const browser = new BrowserSocket(web.origin, cookie);
    try {
      await browser.attach();
      browser.send({ type: "command", rid: "create", name: "create_character", args: { name: "nova" } });
      expect(await browser.frame("command_output", "create")).toMatchObject({ data: { character: "nova", created_files: ["SOUL.md", "USER.md", "AGENTS.md", "TOOLS.md"] } });
      expect(daemon.runtime.historyIndex.registeredCharacters()).toContain("nova");
      expect(daemon.runtime.workspaceIndex.registeredCharacters()).toContain("nova");
      expect(daemon.runtime.autonomy.status("nova")).toBeDefined();
      expect(await readFile(join(place.root, "config", "characters", "nova", "workspace", "SOUL.md"), "utf8")).toBe("You are nova.\n");
      browser.send({ type: "command", rid: "select", name: "switch_character", args: { name: "nova" } });
      expect(await browser.frame("command_output", "select")).toMatchObject({ data: { selected_character: "nova" } });
      await browser.frame("history", "select");
      browser.send({ type: "message", rid: "turn", text: "browser question", stream: true, images: [] });
      expect(await browser.frame("stream_end", "turn")).toMatchObject({ content: "browser answer", is_final: true });
      browser.send({ type: "command", rid: "fork", name: "fork_thread", args: { name: "branch", from: "main", turns: 1 } });
      expect(await browser.frame("command_output", "fork")).toMatchObject({ data: { fork: { thread: "branch", source: "main", messages: 2, turns: 1, scope: "last_turns", requested_turns: 1 } } });
      browser.send({ type: "command", rid: "select-fork", name: "switch_thread", args: { name: "branch", resync: true } });
      const webHistory = await browser.frame("history", "select-fork");
      expect(webHistory).toMatchObject({ selected_character: "nova", selected_thread: "branch", messages: [{ content: "browser question" }, { content: "browser answer" }] });
      const tcp = await Client.open(daemon.port, "nova");
      try {
        await tcp.awaitFrame("history"); tcp.frames.length = 0;
        tcp.send({ type: "command", rid: "tcp-select", name: "switch_thread", args: { name: "branch", resync: true } });
        const tcpHistory = await tcp.awaitFrame("history");
        if (webHistory.type !== "history") throw new Error("Expected browser history");
        expect(tcpHistory["messages"]).toEqual(webHistory.messages);
        expect((await daemon.runtime.registry.getOrCreate("nova", "branch")).historySnapshot({}).messages.map((message) => message.content)).toEqual(["browser question", "browser answer"]);
      } finally { tcp.close(); }
    } finally { await browser.close(); }
  });

  test("a failed web bind releases the TCP listener and data-directory lease before opening stores", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => { occupied.listen(0, "127.0.0.1", resolve); });
    const address = occupied.address();
    if (address === null || typeof address === "string") throw new Error("Expected address");
    const place = await layout(`[daemon.web]\nenabled = true\nbind_addr = "127.0.0.1:${String(address.port)}"\n`);
    try {
      expect(start(place)).rejects.toThrow("Failed to start browser transport");
      await until(() => !existsSync(join(place.root, "data", "shore", DATA_DIRECTORY_LEASE_FILE)), "lease was not released");
      expect(existsSync(place.instancesPath)).toBe(false);
      expect(existsSync(join(place.root, "data", "shore", "shore.db"))).toBe(false);
    } finally { await new Promise<void>((resolve) => { occupied.close(() => resolve()); }); }
  });

  test("runtime initialization failure closes the already-bound web listener and unregisters the instance", async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => { probe.listen(0, "127.0.0.1", resolve); });
    const address = probe.address();
    if (address === null || typeof address === "string") throw new Error("Expected address");
    await new Promise<void>((resolve) => { probe.close(() => resolve()); });
    const place = await layout(`[daemon.web]\nenabled = true\nbind_addr = "127.0.0.1:${String(address.port)}"\n`);
    await mkdir(join(place.root, "cache"));
    await writeFile(join(place.root, "cache", "shore"), "blocks the runtime cache directory");
    let failure: unknown;
    try { await start(place); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(StartupError);
    expect(String(failure)).toContain("Failed to initialize shore-daemon");
    expect(existsSync(join(place.root, "data", "shore", DATA_DIRECTORY_LEASE_FILE))).toBe(false);
    expect(await instances(place)).toEqual([]);
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(address.port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => { probe.close(() => resolve()); });
  });

  test("browser cancellation settles its original request and permits another turn while the provider is held", async () => {
    const place = await layout(`${MODEL_CONFIG}\n[daemon.web]\nenabled = true\nbind_addr = "127.0.0.1:0"\n`);
    let stopped = 0;
    const provider: SidecarProvider = {
      async *stream(req, signal) {
        yield { type: "start", model: req.model };
        try {
          await new Promise<void>((resolve) => {
            if (signal?.aborted) resolve();
            else signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        } finally { stopped += 1; }
      },
      generate() { throw new Error("Unexpected non-streaming call"); },
    };
    const daemon = await start(place, [], { anthropic: provider }, false);
    const web = required(daemon.web);
    const login = await fetch(`${web.origin}/api/login`, { method: "POST", headers: { origin: web.origin, "content-type": "application/json" }, body: JSON.stringify({ token: TEST_TOKEN }) });
    const browser = new BrowserSocket(web.origin, required(login.headers.get("set-cookie")?.split(";", 1)[0]));
    try {
      await browser.attach();
      for (let i = 0; i < 33; i += 1) {
        const rid = `held-${String(i)}`;
        browser.send({ type: "message", rid, text: "hold this turn", stream: true });
        await browser.frame("stream_start", rid);
        browser.send({ type: "cancel" });
        expect(await browser.frame("stream_end", rid)).toMatchObject({ finish_reason: "cancelled", is_final: true });
        await until(() => stopped > i, "Provider was not cancelled");
        expect(await browser.frame("request_finished", rid)).toMatchObject({ outcome: "cancelled" });
      }
      browser.send({ type: "command", rid: "still-live", name: "list_threads", args: {} });
      expect(await browser.frame("command_output", "still-live")).toMatchObject({ name: "list_threads" });
    } finally { await browser.close(); }
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

  test("an edit to config.toml is adopted without a restart", async () => {
    const place = await layout();
    const daemon = await start(place);
    expect(daemon.runtime.registry.globalConfig().app.tools.max_result_chars).toBe(
      defaultToolsConfig().max_result_chars,
    );

    await writeFile(place.configPath, `[tools]\nmax_result_chars = 4242\n`);

    await untilAdopted(
      () => daemon.runtime.registry.globalConfig().app.tools.max_result_chars === 4242,
    );
    expect(daemon.runtime.registry.globalConfig().app.tools.max_result_chars).toBe(4242);
  });

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

  test("a broken per-character overlay keeps the running config", async () => {
    const place = await layout();
    const daemon = await start(place);
    await writeFile(place.configPath, `[tools]\nmax_result_chars = 4242\n`);
    await untilAdopted(
      () => daemon.runtime.registry.globalConfig().app.tools.max_result_chars === 4242,
    );

    const client = await Client.open(daemon.port, "ada");
    try {
      await client.awaitFrame("hello");

      await writeFile(
        join(place.root, "config", "characters", "ada", "config.toml"),
        "[behavior]\nnot_a_field = ",
      );
      await writeFile(place.configPath, `[tools]\nmax_result_chars = 9999\n`);
      await client.awaitFrame("config_warning");

      expect(daemon.runtime.registry.globalConfig().app.tools.max_result_chars).toBe(4242);
    } finally {
      client.close();
    }
  });

  test("a character appearing on disk is picked up", async () => {
    const place = await layout();
    const daemon = await start(place);
    expect(daemon.runtime.registry.availableCharacters()).toEqual(["ada"]);

    const staged = join(place.root, "staged", "workspace");
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, "SOUL.md"), "# nova\n");
    await rename(join(place.root, "staged"), join(place.root, "config", "characters", "nova"));

    await untilAdopted(() => daemon.runtime.registry.availableCharacters().length === 2);
    expect(daemon.runtime.registry.availableCharacters()).toEqual(["ada", "nova"]);
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

  test("the stores are let go, so nothing outlives the process", async () => {
    const place = await layout();
    const daemon = await start(place);
    const store = daemon.runtime.callStore;
    expect(store).toBeDefined();

    daemon.stop();
    await daemon.done;
    running.length = 0;

    expect(() => store?.rotate(new Date(0), 1)).toThrow();
  });

  test("a shutdown step that overruns is abandoned rather than waited on", async () => {
    const warnings: string[] = [];
    const never = new Promise(() => {});

    await bounded(never, "wedged", { warn: (msg) => warnings.push(msg) }, 20);

    expect(warnings).toEqual(["Shutdown step timed out"]);
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

  test("the clocks stop with the daemon, so no keepalive ticks after the exit", async () => {
    const place = await layout();
    const daemon = await startDaemon({
      argv: ["--config", place.configPath, "--addr", "127.0.0.1:0"],
      env: place.env,
      providers: {},
      instancesPath: place.instancesPath,
      clockIntervals: { keepaliveMs: 5 },
    });
    running.push(daemon);

    let ticks = 0;
    daemon.runtime.keepalive.tick = async () => {
      ticks += 1;
    };
    await until(() => ticks > 0, "the keepalive clock never ticked");

    daemon.stop();
    await daemon.done;
    running.length = 0;

    const atExit = ticks;
    await new Promise((resolve) => {
      setTimeout(resolve, 60);
    });
    expect(ticks).toBe(atExit);
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

  test("a non-loopback bind is now ordinary, because the token is the boundary", async () => {
    const place = await layout(`
[daemon]
listen_addr = "0.0.0.0:0"
`);

    const daemon = await startDaemon({
      argv: ["--config", place.configPath],
      env: place.env,
      providers: {},
      instancesPath: place.instancesPath,
    });
    running.push(daemon);

    expect(daemon.port).toBeGreaterThan(0);
    expect(existsSync(place.instancesPath)).toBe(true);
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

describe("formatAddr", () => {
  test("an IPv6 host is bracketed, so the string splits back on its last colon", () => {
    expect(formatAddr("127.0.0.1", 7320)).toBe("127.0.0.1:7320");
    expect(formatAddr("::1", 7320)).toBe("[::1]:7320");
  });
});

describe("a Matrix homeserver that never answers", () => {
  test("does not keep the daemon from accepting clients", async () => {
    const stalled: Socket[] = [];
    const blackHole = createServer((socket) => stalled.push(socket));
    await new Promise<void>((resolve) => {
      blackHole.listen(0, "127.0.0.1", resolve);
    });
    const address = blackHole.address();
    if (address === null || typeof address === "string") {
      throw new Error(`expected a TCP address, got ${JSON.stringify(address)}`);
    }

    const place = await layout(
      "[matrix]\nenabled = true\n" +
        `homeserver_url = "http://127.0.0.1:${address.port}"\nuser_id = "@shore:example.com"\n`,
    );
    place.env[ACCESS_TOKEN_ENV] = "not-a-real-token";

    try {
      const daemon = await start(place);
      const client = await Client.open(daemon.port, null);
      try {
        expect(await client.awaitFrame("hello")).toHaveProperty("type", "hello");
      } finally {
        client.close();
      }
    } finally {
      for (const socket of stalled) socket.destroy();
      await new Promise<void>((resolve) => {
        blackHole.close(() => resolve());
      });
    }
  });
});

describe("describeRejection", () => {
  test("an Error is described by its stack, not its message", () => {
    const err = new Error("boom from tick");
    const described = describeRejection(err);
    expect(described).toContain("boom from tick");
    expect(described).toContain("daemon_run.test.ts");
  });

  test("a stackless Error still names itself", () => {
    const err = new Error("no stack here");
    delete (err as { stack?: string }).stack;
    expect(describeRejection(err)).toBe("Error: no stack here");
  });

  test("a thrown non-Error is stringified", () => {
    expect(describeRejection("just a string")).toBe("just a string");
    expect(describeRejection(undefined)).toBe("undefined");
  });
});
