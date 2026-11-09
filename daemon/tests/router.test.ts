import { describe, expect, test } from "bun:test";

import { afterCommand, type DispatchContext } from "../src/handler/command_dispatch.ts";
import { CharacterConfigError } from "../src/characters.ts";
import { HeartbeatThreadError, ImagesUnsupportedError, NoModelError } from "../src/handler/setup.ts";
import { MessageHandler, withRid, type GenerationParams, type HandlerRegistry, type MessageHandlerDeps } from "../src/handler/router.ts";
import type { ErrorCode } from "../src/protocol/ErrorCode.ts";
import { REQUEST_LIFECYCLE_CAPABILITY, SessionRouter, type RequestMeta, type RoutedMessage } from "../src/swp/session.ts";
import type { ClientMessage } from "../src/protocol/ClientMessage.ts";
import type { Command } from "../src/protocol/Command.ts";
import { required } from "../src/util/required.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";

function registryOf(characters: readonly string[]): HandlerRegistry {
  return {
    resolveCharacter: (selected) => {
      if (selected === null) {
        const first = characters[0];
        return first === undefined
          ? { error: "no characters configured" }
          : { name: first };
      }
      return characters.includes(selected)
        ? { name: selected }
        : {
            error: `character ${JSON.stringify(selected)} not found (available: ${JSON.stringify(
              characters,
            )})`,
          };
    },
  };
}

function harness(
  characters: readonly string[],
  sessions: number,
  runGeneration?: (params: GenerationParams) => Promise<void>,
  dispatchCommand?: (
    cmd: Command,
    meta: RequestMeta,
    signal: AbortSignal,
  ) => Promise<ServerMessage>,
  commandOnlyReads?: (cmd: Command) => boolean,
) {
  const router = new SessionRouter();
  const frames = new Map<number, ServerMessage[]>();
  for (let id = 1; id <= sessions; id += 1) {
    registerTestSession(router, frames, id);
  }

  const started: GenerationParams[] = [];

  const handler = new MessageHandler({
    router,
    registry: registryOf(characters),
    notifier: { notify: () => {} },
    dispatchCommand:
      dispatchCommand ??
      (() =>
        Promise.resolve({ type: "command_output", name: "status", success: true, data: null })),
    runGeneration: (params) => {
      started.push(params);
      if (runGeneration !== undefined) return runGeneration(params);
      return new Promise<void>((resolve) => {
        params.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    log: { error: () => {} },
    ...(commandOnlyReads === undefined ? {} : { commandOnlyReads }),
  });

  return { handler, router, frames, started };
}

function registerTestSession(
  router: SessionRouter,
  frames: Map<number, ServerMessage[]>,
  id: number,
): void {
  const received: ServerMessage[] = [];
  frames.set(id, received);
  router.registerSession(
    {
      id,
      clientType: "test-client",
      clientName: `test-${id}`,
      capabilities: ["streaming"],
      character: null,
      thread: null,
    },
    (msg) => {
      received.push(msg);
      return Promise.resolve();
    },
  );
}

function meta(
  character: string | null,
  sessionId: number,
  rid: string | null,
  kind: RequestMeta["kind"],
): RequestMeta {
  return {
    session: {
      clientId: sessionId,
      sessionId,
      clientType: "test-client",
      clientName: `test-${sessionId}`,
      capabilities: ["streaming"],
      selectedCharacter: character,
      selectedThread: null,
    },
    rid,
    kind,
  };
}

const message = (rid: string | null, text: string, stream: boolean): ClientMessage => ({
  type: "message",
  rid,
  text,
  stream,
  images: [],
  image_data: [],
});

describe("archiving the thread a session is on", () => {
  test("a session that leaves for another thread while home loads stays where it went", async () => {
    const router = new SessionRouter();
    const frames = new Map<number, ServerMessage[]>();
    for (const id of [1, 2]) {
      registerTestSession(router, frames, id);
      router.setSelectedCharacter(id, "ada");
      router.setSelectedThread(id, "side");
    }
    const context = {
      character: "ada", sessionId: 1, rid: "archive", router,
      runtime: { homeThread: () => "main", warmThread: () => undefined, threadsChanged: () => {} },
      handshake: {
        history: () => {
          router.setSelectedThread(2, "other");
          return Promise.resolve({ messages: [], previousSegment: null, config: {}, selectedCharacter: "ada", selectedThread: "main", revision: 1 });
        },
      },
    } as unknown as DispatchContext;

    await afterCommand("archive_thread", { name: "side" }, {}, context);

    expect(router.threadFor(1)).toBe("main");
    expect(router.threadFor(2)).toBe("other");
    expect(frames.get(1)).toMatchObject([{ type: "history", selected_thread: "main", rid: "archive" }]);
    expect(frames.get(2)).toEqual([]);
  });
});

describe("routed messages", () => {

  test("a cancel ends the running generation with a cancelled stream_end", async () => {
    const h = harness(["Alice"], 1);

    await h.handler.handleRouted({
      kind: "engine",
      msg: message("r1", "hi", false),
      meta: meta("Alice", 1, "r1", "message"),
    });
    const launched = h.started.length === 1;

    await h.handler.handleRouted({
      kind: "engine",
      msg: { type: "cancel" },
      meta: meta("Alice", 1, null, "cancel"),
    });

    const received = h.frames.get(1) ?? [];
    expect(received.find((frame) => frame.type === "stream_end" && frame.rid === "r1")).toMatchObject({ finish_reason: "cancelled", is_final: true });
    expect(launched).toBe(true);
    expect(received.at(-1)).toMatchObject({ type: "stream_end", rid: "r1", finish_reason: "cancelled" });
    expect(h.started[0]?.signal.aborted).toBe(true);
  });

  test("disconnecting leaves every generation running", async () => {
    const finishes: Array<() => void> = [];
    const h = harness(["Alice", "Bob"], 2, () => new Promise<void>((resolve) => { finishes.push(resolve); }));

    for (const [id, character] of [[1, "Alice"], [2, "Bob"]] as const) {
      h.router.setSelectedCharacter(id, character);
      await h.handler.handleRouted({
        kind: "engine",
        msg: message("r1", "hi", false),
        meta: meta(character, id, "r1", "message"),
      });
    }
    const before = h.started.map((params) => !params.signal.aborted);

    for (const id of [1, 2]) {
      h.router.unregisterSession(id);
      await h.handler.handleRouted({ kind: "session_disconnected", sessionId: id });
    }

    expect(before).toEqual([true, true]);
    expect(h.started.map((params) => !params.signal.aborted)).toEqual([true, true]);
    expect([...(h.frames.get(1) ?? []), ...(h.frames.get(2) ?? [])]).toEqual([]);
    for (const finish of finishes) finish();
    await h.handler.drain();
    expect(h.handler.generationCount).toBe(0);
  });
});

describe("session state lifecycle", () => {

  test("an older generation settling cannot erase its replacement", async () => {
    const finishes: Array<() => void> = [];
    const h = harness(
      ["Alice"],
      1,
      () => new Promise<void>((resolve) => {
        finishes.push(resolve);
      }),
    );

    await h.handler.handleRouted({
      kind: "engine",
      msg: message("r1", "first", false),
      meta: meta("Alice", 1, "r1", "message"),
    });
    await h.handler.handleRouted({
      kind: "engine",
      msg: message("r2", "second", false),
      meta: meta("Alice", 1, "r2", "message"),
    });

    finishes[0]?.();
    await Promise.resolve();
    expect(h.handler.generationCount).toBe(1);

    finishes[1]?.();
    await h.handler.drain();
    expect(h.handler.generationCount).toBe(0);
  });
});

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

function deferred(): Deferred {
  let settle: () => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, resolve: settle, reject: fail };
}

const command = (name: string, rid: string | null = null): Command =>
  ({ type: "command", name, args: {}, rid }) as unknown as Command;

const commandOutput = (name: string): ServerMessage => ({
  type: "command_output",
  name,
  data: null,
});

function gatedDispatch() {
  const gates = new Map<string, Deferred>();
  const signals = new Map<string, AbortSignal>();
  const started: string[] = [];

  const gate = (name: string): Deferred => {
    const existing = gates.get(name);
    if (existing !== undefined) return existing;
    const fresh = deferred();
    gates.set(name, fresh);
    return fresh;
  };

  const dispatch = async (
    cmd: Command,
    _meta: RequestMeta,
    signal: AbortSignal,
  ): Promise<ServerMessage> => {
    started.push(cmd.name);
    signals.set(cmd.name, signal);
    await gate(cmd.name).promise;
    return commandOutput(cmd.name);
  };

  return { dispatch, gate, signals, started };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

const names = (frames: ServerMessage[]): string[] =>
  frames.map((f) => (f.type === "command_output" ? f.name : f.type));

describe("per-session routing queues", () => {
  test("a slow command on one session does not delay another session", async () => {
    const { dispatch, gate, started } = gatedDispatch();
    const { handler, frames } = harness(["ada"], 2, undefined, dispatch);

    handler.enqueueRouted({ kind: "command", cmd: command("slow"), meta: meta("ada", 1, null, "command") });
    handler.enqueueRouted({ kind: "command", cmd: command("fast"), meta: meta("ada", 2, null, "command") });
    gate("fast").resolve();
    await settle();

    expect(started).toEqual(["slow", "fast"]);
    expect(names(required(frames.get(2)))).toEqual(["fast"]);
    expect(names(required(frames.get(1)))).toEqual([]);

    gate("slow").resolve();
    await handler.drain();
    expect(names(required(frames.get(1)))).toEqual(["slow"]);
  });

  test("commands on one session reply in the order they were issued", async () => {
    const { dispatch, gate, started } = gatedDispatch();
    const { handler, frames } = harness(["ada"], 1, undefined, dispatch);

    for (const name of ["first", "second", "third"]) {
      handler.enqueueRouted({
        kind: "command",
        cmd: command(name),
        meta: meta("ada", 1, null, "command"),
      });
    }
    gate("third").resolve();
    gate("second").resolve();
    await settle();

    expect(started).toEqual(["first"]);

    gate("first").resolve();
    await handler.drain();
    expect(names(required(frames.get(1)))).toEqual(["first", "second", "third"]);
  });

  const browserTab = (): RequestMeta => {
    const base = meta("ada", 1, null, "command");
    return { ...base, session: { ...base.session, capabilities: ["streaming", REQUEST_LIFECYCLE_CAPABILITY] } };
  };
  const reads = (cmd: Command): boolean => cmd.name.startsWith("list_");

  test("in a browser tab a read overtakes a slow change, and a change of selection still waits its turn", async () => {
    const { dispatch, gate, started } = gatedDispatch();
    const { handler, frames } = harness(["ada"], 1, undefined, dispatch, reads);

    for (const name of ["thread_label", "list_threads", "switch_thread"]) {
      handler.enqueueRouted({ kind: "command", cmd: command(name), meta: browserTab() });
    }
    gate("list_threads").resolve();
    gate("switch_thread").resolve();
    await settle();

    expect(started).toEqual(["thread_label", "list_threads"]);
    expect(names(required(frames.get(1)))).toEqual(["list_threads"]);

    gate("thread_label").resolve();
    await handler.drain();
    expect(names(required(frames.get(1)))).toEqual(["list_threads", "thread_label", "switch_thread"]);
  });

  test("a client that matches replies by order keeps them in order, reads included", async () => {
    const { dispatch, gate, started } = gatedDispatch();
    const { handler } = harness(["ada"], 1, undefined, dispatch, reads);

    for (const name of ["thread_label", "list_threads"]) {
      handler.enqueueRouted({ kind: "command", cmd: command(name), meta: meta("ada", 1, null, "command") });
    }
    gate("list_threads").resolve();
    await settle();

    expect(started).toEqual(["thread_label"]);

    gate("thread_label").resolve();
    await handler.drain();
    expect(started).toEqual(["thread_label", "list_threads"]);
  });

  test("a model refresh over the network and a stopping compaction leave the tab free to switch threads", async () => {
    const { dispatch, gate, started } = gatedDispatch();
    const { handler, frames } = harness(["ada"], 1, undefined, dispatch, reads);

    for (const name of ["refresh_all_provider_models", "compact_cancel", "switch_thread"]) {
      handler.enqueueRouted({ kind: "command", cmd: command(name), meta: browserTab() });
    }
    gate("switch_thread").resolve();
    await settle();

    expect(started).toEqual(["refresh_all_provider_models", "compact_cancel", "switch_thread"]);
    expect(names(required(frames.get(1)))).toEqual(["switch_thread"]);

    gate("refresh_all_provider_models").resolve();
    gate("compact_cancel").resolve();
    await handler.drain();
  });

  test("stopping a reply in a browser tab leaves a compaction and its watcher running, and a client without request tracking can still stop one", async () => {
    const { dispatch, gate, signals } = gatedDispatch();
    const { handler } = harness(["ada"], 1, undefined, dispatch, reads);
    const stop: RoutedMessage = { kind: "engine", msg: { type: "cancel" }, meta: browserTab() };

    handler.enqueueRouted({ kind: "command", cmd: command("compact"), meta: browserTab() });
    handler.enqueueRouted({ kind: "command", cmd: command("compact_watch"), meta: browserTab() });
    await settle();
    handler.enqueueRouted(stop);
    await settle();
    expect(signals.get("compact")?.aborted).toBe(false);
    expect(signals.get("compact_watch")?.aborted).toBe(false);
    gate("compact").resolve();
    gate("compact_watch").resolve();
    await handler.drain();

    const old = gatedDispatch();
    const { handler: oldHandler } = harness(["ada"], 1, undefined, old.dispatch, reads);
    oldHandler.enqueueRouted({ kind: "command", cmd: command("compact"), meta: meta("ada", 1, null, "command") });
    await settle();
    oldHandler.enqueueRouted({ kind: "engine", msg: { type: "cancel" }, meta: meta("ada", 1, null, "command") });
    await settle();
    expect(old.signals.get("compact")?.aborted).toBe(true);
    old.gate("compact").resolve();
    await oldHandler.drain();
  });

  test("a compaction leaves the session free to switch threads while it runs", async () => {
    const { dispatch, gate, started } = gatedDispatch();
    const { handler, frames } = harness(["ada"], 1, undefined, dispatch);

    handler.enqueueRouted({ kind: "command", cmd: command("compact"), meta: meta("ada", 1, null, "command") });
    handler.enqueueRouted({ kind: "command", cmd: command("switch_thread"), meta: meta("ada", 1, null, "command") });
    gate("switch_thread").resolve();
    await settle();

    expect(started).toEqual(["compact", "switch_thread"]);
    expect(names(required(frames.get(1)))).toEqual(["switch_thread"]);

    gate("compact").resolve();
    await handler.drain();
    expect(names(required(frames.get(1)))).toEqual(["switch_thread", "compact"]);
  });
});

interface SessionSpec {
  readonly id: number;
  readonly character?: string | null;
  readonly thread?: string | null;
  readonly lifecycle?: boolean;
}

interface WorldOptions {
  readonly sessions: readonly SessionSpec[];
  readonly characters?: readonly string[];
  readonly runGeneration?: (params: GenerationParams) => Promise<void>;
  readonly dispatchCommand?: MessageHandlerDeps["dispatchCommand"];
  readonly commandChangesState?: (cmd: Command) => boolean;
  readonly compactions?: MessageHandlerDeps["compactions"];
  readonly now?: () => number;
}

function untilStopped(params: GenerationParams): Promise<void> {
  return new Promise<void>((resolve) => {
    params.signal.addEventListener("abort", () => { resolve(); }, { once: true });
  });
}

function world(options: WorldOptions) {
  const router = new SessionRouter();
  const frames = new Map<number, ServerMessage[]>();
  const reported: Array<readonly [number, ServerMessage]> = [];
  router.observeRequests((sessionId, msg) => { reported.push([sessionId, msg]); });
  const join = (spec: SessionSpec, send?: (msg: ServerMessage) => Promise<void>): void => {
    const received: ServerMessage[] = [];
    frames.set(spec.id, received);
    router.registerSession(
      {
        id: spec.id,
        clientType: "test-client",
        clientName: `test-${String(spec.id)}`,
        capabilities: spec.lifecycle === true ? ["streaming", REQUEST_LIFECYCLE_CAPABILITY] : ["streaming"],
        character: spec.character === undefined ? "ada" : spec.character,
        thread: spec.thread ?? null,
      },
      send ?? ((msg) => { received.push(msg); return Promise.resolve(); }),
    );
  };
  for (const spec of options.sessions) join(spec);
  const notified: string[] = [];
  const logged: string[] = [];
  const started: GenerationParams[] = [];
  const handler = new MessageHandler({
    router,
    registry: registryOf(options.characters ?? ["ada"]),
    notifier: { notify: (_event, title, body) => { notified.push(`${title}: ${body}`); } },
    dispatchCommand: options.dispatchCommand ?? ((cmd) => Promise.resolve(commandOutput(cmd.name))),
    runGeneration: (params) => {
      started.push(params);
      return (options.runGeneration ?? untilStopped)(params);
    },
    log: { error: (msg) => { logged.push(msg); } },
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.commandChangesState === undefined ? {} : { commandChangesState: options.commandChangesState }),
    ...(options.compactions === undefined ? {} : { compactions: options.compactions }),
  });
  const metaOf = (sessionId: number, rid: string | null, kind: RequestMeta["kind"] = "message"): RequestMeta => {
    const client = required(router.client(sessionId));
    return {
      session: {
        clientId: sessionId,
        sessionId,
        clientType: client.clientType,
        clientName: client.clientName,
        capabilities: client.capabilities,
        selectedCharacter: client.character,
        selectedThread: client.thread,
      },
      rid,
      kind,
    };
  };
  const say = (sessionId: number, rid: string | null, stream = true): Promise<void> =>
    handler.handleRouted({ kind: "engine", msg: message(rid, "hi", stream), meta: metaOf(sessionId, rid) });
  const stop = (sessionId: number, rid: string | null = null): Promise<void> =>
    handler.handleRouted({ kind: "engine", msg: { type: "cancel" }, meta: metaOf(sessionId, rid, "cancel") });
  return { router, handler, frames, reported, notified, logged, started, join, metaOf, say, stop };
}

const start = (rid: string | null, regen = false): ServerMessage => ({ type: "stream_start", rid, regen });
const chunk = (text: string, extra: { content_type?: string; subagent?: string; task_id?: string } = {}): ServerMessage =>
  ({ type: "stream_chunk", rid: "r1", text, content_type: "text", ...extra });
const end = (content: string, rid = "r1"): ServerMessage => ({
  type: "stream_end",
  rid,
  content,
  metadata: { tokens: { input: 3, output: 2, cache_read: 0, cache_write: 0 }, timing: { total_ms: 9, ttft_ms: 4 }, model: "m" },
  finish_reason: "end_turn",
  is_final: true,
});
const cancelledEnd = (rid?: string): ServerMessage => ({
  type: "stream_end",
  ...(rid === undefined ? {} : { rid }),
  content: "",
  metadata: { tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, timing: { total_ms: 0, ttft_ms: 0 }, model: "" },
  finish_reason: "cancelled",
  is_final: true,
});
const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 };
const timing = { total_ms: 1, time_to_first_token_ms: 1 };

describe("replies", () => {
  test("a failed reply tells everyone watching why, coded by the kind of failure, and its request finishes failed", async () => {
    const failures: Array<readonly [unknown, ErrorCode, string, number | undefined]> = [
      [new NoModelError("no model chosen"), "invalid_request", "no model chosen", undefined],
      [new ImagesUnsupportedError("chat.x", 2), "invalid_request", "chat.x does not accept images, so the 2 attachments were not sent. Switch to a vision-capable model and send again.", undefined],
      [new HeartbeatThreadError("ada", "beats"), "invalid_request", `"beats" is where ada's heartbeats run, so you can read it but not write there. Write to ada in another thread.`, undefined],
      [new CharacterConfigError("ada", new Error("bad toml")), "invalid_request", `invalid config for character "ada": bad toml`, undefined],
      [new DOMException("too slow", "TimeoutError"), "timeout", "too slow", undefined],
      [{ kind: "stream_errored", message: "cut off", usage, timing, timeout: true }, "timeout", "stream errored after partial usage: cut off", undefined],
      [{ kind: "stream_errored", message: "cut off", usage, timing }, "provider_error", "stream errored after partial usage: cut off", undefined],
      [{ kind: "http_status", status: 429, body: "slow down", retry_after_ms: 1500 }, "provider_error", "HTTP 429: slow down", 1500],
      [{ kind: "provider", message: "overloaded" }, "provider_error", "provider error: overloaded", undefined],
      [{ kind: "launch_failed", message: "no claude binary" }, "provider_error", "no claude binary", undefined],
      [new Error("boom"), "internal_error", "boom", undefined],
    ];
    for (const [error, code, text, retry] of failures) {
      const h = world({ sessions: [{ id: 1, lifecycle: true }, { id: 2 }], runGeneration: async () => { throw error; } });
      await h.say(1, "r1");
      await h.handler.drain();
      const failure = { code, message: text, ...(retry === undefined ? {} : { retry_after_ms: retry }) };
      expect(h.frames.get(1)).toEqual([{ type: "error", rid: "r1", ...failure }, { type: "request_finished", rid: "r1", outcome: "failed", error: failure }]);
      expect(h.frames.get(2)).toEqual([{ type: "error", rid: "r1", ...failure }]);
      expect(h.notified).toEqual([`Shore - ada: ${text}`]);
      expect(h.handler.generationCount).toBe(0);
    }
  });

  test("a reply sent without a request id fails without one and reports no request", async () => {
    const h = world({ sessions: [{ id: 1, lifecycle: true }], runGeneration: () => Promise.reject(new Error("boom")) });
    await h.say(1, null);
    await h.handler.drain();
    expect(h.frames.get(1)).toEqual([{ type: "error", code: "internal_error", message: "boom" }]);
    expect(h.reported).toEqual([]);
  });

  test("a reply that fails because it was stopped reports the stop, not an error", async () => {
    const h = world({
      sessions: [{ id: 1, lifecycle: true }],
      runGeneration: (params) => new Promise<void>((_resolve, reject) => {
        params.signal.addEventListener("abort", () => { reject(new DOMException("stopped", "AbortError")); }, { once: true });
      }),
    });
    await h.say(1, "r1");
    await h.stop(1);
    await h.handler.drain();
    expect(h.frames.get(1)).toEqual([cancelledEnd("r1"), { type: "request_finished", rid: "r1", outcome: "cancelled" }]);
    expect(h.notified).toEqual([]);
    expect(h.handler.generationCount).toBe(0);
  });

  test("a client that asked not to stream gets the reply when it ends while other viewers watch it stream", async () => {
    const script = [start("r1"), chunk("Hel"), chunk("lo"), end("Hello")];
    const h = world({ sessions: [{ id: 1 }, { id: 2 }], runGeneration: async (params) => { for (const frame of script) await params.send(frame); } });
    await h.say(1, "r1", false);
    await h.handler.drain();
    expect(h.frames.get(1)).toEqual([end("Hello")]);
    expect(h.frames.get(2)).toEqual(script);

    const regenerated = world({ sessions: [{ id: 1 }], runGeneration: async (params) => { await params.send(start("r1", true)); await params.send(chunk("x")); } });
    await regenerated.say(1, "r1", false);
    await regenerated.handler.drain();
    expect(regenerated.frames.get(1)).toEqual([start("r1", true)]);
  });

  test("a session that arrives mid-reply first sees what was said so far, and one that arrives after the end sees nothing", async () => {
    const parked = deferred();
    const more = deferred();
    const ended = deferred();
    const after = deferred();
    const tool: ServerMessage = { type: "tool_call", rid: "r1", tool_id: "t1", tool_name: "read", input: {} };
    const h = world({
      sessions: [{ id: 1 }, { id: 2, thread: "side" }, { id: 3, thread: "side" }],
      runGeneration: async (params) => {
        await params.send({ type: "phase", rid: "r1", phase: "thinking" });
        await params.send(start("r1"));
        await params.send(chunk("Hel"));
        await params.send({ type: "stream_chunk", rid: "r1", text: "lo", content_type: "text", subagent: null, task_id: null });
        await params.send(chunk("hmm", { content_type: "thinking" }));
        await params.send(tool);
        await params.send(roundEnd);
        await params.send(chunk("from a helper", { subagent: "memory" }));
        await params.send(chunk("from a task", { task_id: "t9" }));
        parked.resolve();
        await more.promise;
        await params.send(chunk("!"));
        await params.send(end("Hello!"));
        ended.resolve();
        await after.promise;
        await params.send(late);
      },
    });
    const roundEnd: ServerMessage = { type: "stream_end", rid: "r1", content: "Hello", metadata: { tokens: { input: 1, output: 1, cache_read: 0, cache_write: 0 }, timing: { total_ms: 1, ttft_ms: 1 }, model: "m" }, finish_reason: "tool_use", is_final: false };
    const late: ServerMessage = { type: "phase", rid: "r1", phase: "saving" };
    await h.say(1, "r1");
    await parked.promise;
    h.router.setSelectedThread(2, null);
    h.router.reportMove(2);
    await settle();
    expect(h.frames.get(2)).toEqual([start("r1"), chunk("Hello"), chunk("hmm", { content_type: "thinking" }), tool, roundEnd]);
    more.resolve();
    await ended.promise;
    await settle();
    expect(h.frames.get(2)?.slice(5)).toEqual([chunk("!"), end("Hello!")]);
    h.router.setSelectedThread(3, null);
    await h.handler.handleControl({ kind: "session_connected", sessionId: 3 });
    expect(h.frames.get(3)).toEqual([]);
    after.resolve();
    await h.handler.drain();
    expect(h.frames.get(2)?.at(-1)).toEqual(late);
    expect(h.frames.get(3)).toEqual([]);
  });

  test("a session only gets the reply again by joining: moving away and back quietly isn't enough", async () => {
    const next = deferred();
    const last = deferred();
    const h = world({
      sessions: [{ id: 1 }, { id: 2 }, { id: 3 }],
      runGeneration: async (params) => {
        await params.send(chunk("a"));
        await next.promise;
        await params.send(chunk("b"));
        await last.promise;
        await params.send(chunk("c"));
      },
    });
    await h.say(1, "r1");
    await settle();
    h.router.setSelectedThread(2, "side");
    h.router.setSelectedThread(3, "side");
    h.router.reportMove(3);
    next.resolve();
    await settle();
    h.router.setSelectedThread(2, null);
    h.router.setSelectedThread(3, null);
    last.resolve();
    await h.handler.drain();
    expect(h.frames.get(1)).toEqual([chunk("a"), chunk("b"), chunk("c")]);
    expect(h.frames.get(2)).toEqual([chunk("a")]);
    expect(h.frames.get(3)).toEqual([chunk("a")]);
  });

  test("a session that isn't connected any more joins nothing", async () => {
    const done = deferred();
    const h = world({ sessions: [{ id: 1 }], runGeneration: async (params) => { await params.send(chunk("a")); await done.promise; } });
    await h.say(1, "r1");
    await settle();
    await h.handler.handleControl({ kind: "session_connected", sessionId: 99 });
    done.resolve();
    await h.handler.drain();
    expect(h.logged).toEqual([]);
  });

  test("a reply waits for its issuer to take each frame", async () => {
    const taken = deferred();
    const progress: string[] = [];
    const h = world({ sessions: [], runGeneration: async (params) => { await params.send(chunk("a")); progress.push("sent"); } });
    h.join({ id: 1 }, async () => { await taken.promise; progress.push("taken"); });
    await h.say(1, "r1");
    await settle();
    expect(progress).toEqual([]);
    taken.resolve();
    await h.handler.drain();
    expect(progress).toEqual(["taken", "sent"]);
  });

  test("a stopped reply is gone at once, so stopping again sends nothing more", async () => {
    const winding = deferred();
    const h = world({ sessions: [{ id: 1 }], runGeneration: async () => { await winding.promise; } });
    await h.say(1, "r1");
    await h.stop(1);
    expect(h.handler.generationCount).toBe(0);
    await h.stop(1);
    winding.resolve();
    await h.handler.drain();
    expect(h.frames.get(1)).toEqual([cancelledEnd("r1")]);
  });

  test("a stop that arrives while a replaced reply is still ending leaves it replaced", async () => {
    const ending = deferred();
    const h = world({ sessions: [] });
    const received: ServerMessage[] = [];
    h.join({ id: 1, lifecycle: true }, async (msg) => {
      if (msg.type === "stream_end" && msg.rid === "r1") await ending.promise;
      received.push(msg);
    });
    await h.say(1, "r1");
    const replacing = h.say(1, "r2");
    await settle();
    await h.stop(1);
    ending.resolve();
    await replacing;
    await h.stop(1);
    await h.handler.drain();
    expect(received.filter((frame) => frame.type === "request_finished")).toEqual([
      { type: "request_finished", rid: "r1", outcome: "superseded" },
      { type: "request_finished", rid: "r2", outcome: "cancelled" },
    ]);
  });

  test("a viewer that switches character or thread, or disconnects, stops getting the reply", async () => {
    const next = deferred();
    const h = world({
      characters: ["ada", "bob"],
      sessions: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4, character: null }],
      runGeneration: async (params) => { await params.send(chunk("a")); await next.promise; await params.send(chunk("b")); },
    });
    await h.say(1, "r1");
    await settle();
    h.router.setSelectedCharacter(2, "bob");
    h.router.setSelectedThread(3, "side");
    h.router.unregisterSession(4);
    next.resolve();
    await h.handler.drain();
    expect(h.frames.get(1)).toEqual([chunk("a"), chunk("b")]);
    for (const id of [2, 3, 4]) expect(h.frames.get(id)).toEqual([chunk("a")]);
    expect(h.logged).toEqual([]);
  });

  test("a viewer whose connection fails is logged and the others still get the reply", async () => {
    const h = world({ sessions: [{ id: 1 }], runGeneration: async (params) => { await params.send(chunk("a")); } });
    h.join({ id: 2 }, () => Promise.reject(new Error("socket closed")));
    await h.say(1, "r1");
    await h.handler.drain();
    expect(h.frames.get(1)).toEqual([chunk("a")]);
    expect(h.logged).toEqual(["failed to deliver stream frame"]);
  });

  test("a new message replaces the reply still running: its stream ends as cancelled and its request as superseded", async () => {
    const h = world({ sessions: [{ id: 1, lifecycle: true }] });
    await h.say(1, "r1");
    await h.say(1, "r2");
    await settle();
    expect(h.started[0]?.signal.aborted).toBe(true);
    expect(h.handler.generationCount).toBe(1);
    await h.stop(1);
    await h.handler.drain();
    expect(h.frames.get(1)).toEqual([
      cancelledEnd("r1"),
      { type: "request_finished", rid: "r1", outcome: "superseded" },
      cancelledEnd("r2"),
      { type: "request_finished", rid: "r2", outcome: "cancelled" },
    ]);

    const unnamed = world({ sessions: [{ id: 1 }] });
    await unnamed.say(1, null);
    await unnamed.say(1, "r2");
    await settle();
    expect(unnamed.frames.get(1)).toEqual([]);
    await unnamed.stop(1);
    await unnamed.handler.drain();
  });

  test("stopping a reply ends its stream under its own id and the stop's, and reaches a stopper who isn't watching", async () => {
    const h = world({ sessions: [{ id: 1 }, { id: 2 }] });
    await h.say(1, "r1");
    await h.stop(2, "c2");
    await h.handler.drain();
    expect(h.frames.get(1)).toEqual([cancelledEnd("r1"), cancelledEnd("c2")]);
    expect(h.frames.get(2)).toEqual([cancelledEnd("r1"), cancelledEnd("c2")]);

    const unnamed = world({ sessions: [{ id: 1 }] });
    await unnamed.say(1, null);
    await unnamed.stop(1, "c1");
    await unnamed.handler.drain();
    expect(unnamed.frames.get(1)).toEqual([cancelledEnd("c1")]);

    const anonymous = world({ sessions: [{ id: 1 }] });
    await anonymous.say(1, null);
    await anonymous.stop(1);
    await anonymous.handler.drain();
    expect(anonymous.frames.get(1)).toEqual([cancelledEnd()]);

    const late = world({ sessions: [{ id: 1 }] });
    await late.say(1, "r1");
    late.join({ id: 2 });
    await late.stop(2);
    await late.handler.drain();
    expect(late.frames.get(1)).toEqual([cancelledEnd("r1")]);
    expect(late.frames.get(2)).toEqual([cancelledEnd("r1")]);

    const idle = world({ sessions: [{ id: 1 }] });
    await idle.stop(1, "c1");
    expect(idle.frames.get(1)).toEqual([]);
  });

  test("clients that track requests hear when one is accepted and when it finishes, and every request is reported", async () => {
    const h = world({
      sessions: [{ id: 1, lifecycle: true }, { id: 2, thread: "side" }],
      runGeneration: async (params) => { await params.accepted?.(); await params.send(end("done", params.rid ?? "")); },
    });
    await h.say(1, "r1");
    await h.say(2, "r2");
    await h.handler.drain();
    expect(h.frames.get(1)).toEqual([{ type: "request_accepted", rid: "r1" }, end("done", "r1"), { type: "request_finished", rid: "r1", outcome: "completed" }]);
    expect(h.frames.get(2)).toEqual([end("done", "r2")]);
    expect(h.reported).toEqual([
      [1, { type: "request_accepted", rid: "r1" }],
      [2, { type: "request_accepted", rid: "r2" }],
      [1, { type: "request_finished", rid: "r1", outcome: "completed" }],
      [2, { type: "request_finished", rid: "r2", outcome: "completed" }],
    ]);

    const gone = world({ sessions: [{ id: 1, lifecycle: true }], runGeneration: async (params) => { gone.router.unregisterSession(1); await params.accepted?.(); } });
    await gone.say(1, "r1");
    await gone.handler.drain();
    expect(gone.frames.get(1)).toEqual([]);
    expect(gone.reported.map(([, frame]) => frame.type)).toEqual(["request_accepted", "request_finished"]);

    const unnamed = world({ sessions: [{ id: 1, lifecycle: true }], runGeneration: async (params) => { await params.accepted?.(); } });
    await unnamed.say(1, null);
    await unnamed.handler.drain();
    expect(unnamed.frames.get(1)).toEqual([]);
    expect(unnamed.reported).toEqual([]);
  });

  test("once the daemon is shutting down a new message is refused as busy", async () => {
    const h = world({ sessions: [{ id: 1, lifecycle: true }] });
    h.handler.close();
    await h.say(1, "r1");
    const text = "The daemon is shutting down. Send this again once it has restarted.";
    expect(h.frames.get(1)).toEqual([
      { type: "error", rid: "r1", code: "busy", message: text },
      { type: "request_finished", rid: "r1", outcome: "failed", error: { code: "busy", message: text } },
    ]);
    expect(h.started).toEqual([]);
  });

  test("a message for a character that doesn't exist is refused and its request fails", async () => {
    const h = world({ sessions: [{ id: 1, lifecycle: true, character: "zed" }] });
    await h.say(1, "r1");
    const text = 'character "zed" not found (available: ["ada"])';
    expect(h.frames.get(1)).toEqual([
      { type: "error", rid: "r1", code: "invalid_request", message: text },
      { type: "request_finished", rid: "r1", outcome: "failed", error: { code: "invalid_request", message: text } },
    ]);
    expect(h.started).toEqual([]);
  });

  test("a hello or a command reaching the reply handler starts nothing", async () => {
    const h = world({ sessions: [{ id: 1 }] });
    await h.handler.handleEngine({ type: "hello", client_type: "tui", client_name: "t", capabilities: [] }, h.metaOf(1, null));
    await h.handler.handleEngine({ type: "command", name: "status", args: {}, rid: null } as unknown as ClientMessage, h.metaOf(1, null));
    expect(h.started).toEqual([]);
    expect(h.frames.get(1)).toEqual([]);
  });

  test("what is running is listed by character, thread and start time", async () => {
    const h = world({ characters: ["ada", "bob"], sessions: [{ id: 1, thread: "side" }, { id: 2, character: "bob" }], now: () => 1234 });
    await h.say(1, "r1");
    await h.say(2, "r2");
    expect(h.handler.activeGenerations()).toEqual([
      { character: "ada", thread: "side", startedAt: 1234 },
      { character: "bob", thread: null, startedAt: 1234 },
    ]);
    await h.stop(1);
    await h.stop(2);
    await h.handler.drain();
  });

  test("a frame that carries no request id is passed on as it is", () => {
    const history: ServerMessage = { type: "threads_changed", character: "ada", thread: "main" };
    expect(withRid(history, "r1")).toBe(history);
    const failure: ServerMessage = { type: "error", code: "internal_error", message: "x" };
    expect(withRid(failure, null)).toBe(failure);
    expect(withRid(failure, "r1")).toEqual({ ...failure, rid: "r1" });
  });
});

describe("compactions", () => {
  test("a compaction's progress reaches the sessions on that conversation and one that arrives during it, until the handler closes", async () => {
    let listener: ((character: string, thread: string, frame: ServerMessage) => void) | undefined;
    const progress: ServerMessage = { type: "phase", phase: "compacting" };
    const running = new Map<string, { thread: string; frame: ServerMessage }>([["ada", { thread: "side", frame: progress }]]);
    const h = world({
      sessions: [{ id: 1, thread: "side" }, { id: 2 }],
      compactions: {
        observe: (observer) => { listener = observer; return () => { listener = undefined; }; },
        running: (character) => running.get(character),
      },
    });
    listener?.("ada", "side", progress);
    await settle();
    expect(h.frames.get(1)).toEqual([progress]);
    expect(h.frames.get(2)).toEqual([]);

    h.join({ id: 3, thread: "side" });
    h.join({ id: 4 });
    await h.handler.handleControl({ kind: "session_connected", sessionId: 3 });
    await h.handler.handleControl({ kind: "session_connected", sessionId: 4 });
    expect(h.frames.get(3)).toEqual([progress]);
    expect(h.frames.get(4)).toEqual([]);

    h.handler.close();
    expect(listener).toBeUndefined();
    h.router.setSelectedThread(4, "side");
    h.router.reportMove(4);
    expect(h.frames.get(4)).toEqual([]);
  });
});

function stoppableDispatch() {
  const gated = gatedDispatch();
  const dispatch = async (cmd: Command, requestMeta: RequestMeta, signal: AbortSignal): Promise<ServerMessage> => {
    const stopped = new Promise<undefined>((resolve) => {
      signal.addEventListener("abort", () => { resolve(undefined); }, { once: true });
    });
    const result = await Promise.race([gated.dispatch(cmd, requestMeta, signal), stopped]);
    signal.throwIfAborted();
    return required(result);
  };
  return { ...gated, dispatch };
}

describe("commands", () => {
  test("a command that fails finishes its request failed, and one that throws is logged as failed", async () => {
    const failure: ServerMessage = { type: "error", rid: "c1", code: "invalid_request", message: "no such thread" };
    const h = world({
      sessions: [{ id: 1, lifecycle: true }],
      dispatchCommand: (cmd) => (cmd.name === "broken" ? Promise.reject(new Error("exploded")) : Promise.resolve(failure)),
    });
    await h.handler.handleRouted({ kind: "command", cmd: command("switch_thread", "c1"), meta: h.metaOf(1, "c1", "command") });
    h.handler.enqueueRouted({ kind: "command", cmd: command("broken", "c2"), meta: h.metaOf(1, "c2", "command") });
    await h.handler.drain();
    expect(h.frames.get(1)).toEqual([
      failure,
      { type: "request_finished", rid: "c1", outcome: "failed", error: failure },
      { type: "request_finished", rid: "c2", outcome: "failed", error: { code: "internal_error", message: "exploded" } },
    ]);
    expect(h.logged).toEqual(["error handling routed message"]);
    expect(h.reported.map(([, frame]) => frame.type)).toEqual(["error", "request_finished", "request_finished"]);
    expect(h.handler.queuedSessionCount).toBe(0);
    expect(h.handler.commandCount).toBe(0);
  });

  test("a command stopped while it waits its turn never starts", async () => {
    const { dispatch, gate, started } = stoppableDispatch();
    const h = world({ sessions: [{ id: 1 }], dispatchCommand: dispatch });
    h.handler.enqueueRouted({ kind: "command", cmd: command("slow"), meta: h.metaOf(1, null, "command") });
    h.handler.enqueueRouted({ kind: "command", cmd: command("waiting"), meta: h.metaOf(1, null, "command") });
    await settle();
    await h.stop(1);
    gate("slow").resolve();
    gate("waiting").resolve();
    await h.handler.drain();
    expect(started).toEqual(["slow"]);
    expect(h.handler.commandCount).toBe(0);
  });

  test("a command that leaves the session where it was doesn't replay the reply it is already watching", async () => {
    const done = deferred();
    const h = world({ sessions: [{ id: 1 }, { id: 2 }], runGeneration: async (params) => { await params.send(chunk("so far")); await done.promise; } });
    await h.say(1, "r1");
    await settle();
    await h.handler.handleRouted({ kind: "command", cmd: command("status"), meta: h.metaOf(2, null, "command") });
    expect(h.frames.get(2)).toEqual([chunk("so far"), commandOutput("status")]);
    done.resolve();
    await h.handler.drain();
  });

  test("a compaction command that moves the session doesn't join it to a reply, since it runs out of turn", async () => {
    const done = deferred();
    const h = world({
      sessions: [{ id: 1 }, { id: 2, thread: "side" }],
      runGeneration: async (params) => { await params.send(chunk("so far")); await done.promise; },
      dispatchCommand: (cmd) => {
        h.router.setSelectedThread(2, null);
        return Promise.resolve(commandOutput(cmd.name));
      },
    });
    await h.say(1, "r1");
    await settle();
    await h.handler.handleRouted({ kind: "command", cmd: command("compact"), meta: h.metaOf(2, null, "command") });
    expect(h.frames.get(2)).toEqual([commandOutput("compact")]);
    done.resolve();
    await h.handler.drain();
  });

  test("connections, disconnections and stops can be queued like anything else", async () => {
    let listener: ((character: string, thread: string, frame: ServerMessage) => void) | undefined;
    const progress: ServerMessage = { type: "phase", phase: "compacting" };
    const h = world({
      sessions: [{ id: 1, thread: "main" }],
      compactions: { observe: (observer) => { listener = observer; return () => { listener = undefined; }; }, running: () => ({ thread: "main", frame: progress }) },
    });
    expect(listener).toBeDefined();
    h.handler.enqueueRouted({ kind: "session_connected", sessionId: 1 });
    await h.say(1, "r1");
    h.handler.enqueueRouted({ kind: "engine", msg: { type: "cancel" }, meta: h.metaOf(1, null, "cancel") });
    h.handler.enqueueRouted({ kind: "session_disconnected", sessionId: 1 });
    await h.handler.drain();
    expect(h.frames.get(1)).toEqual([progress, cancelledEnd("r1")]);
  });

  test("a stopped command tells a client without request tracking that it was cancelled", async () => {
    for (const lifecycle of [false, true]) {
      const { dispatch, gate } = stoppableDispatch();
      const h = world({ sessions: [{ id: 1, lifecycle }], dispatchCommand: dispatch });
      h.handler.enqueueRouted({ kind: "command", cmd: command("slow", "c1"), meta: h.metaOf(1, "c1", "command") });
      await settle();
      await h.stop(1);
      gate("slow").resolve();
      await h.handler.drain();
      expect(h.frames.get(1)).toEqual(lifecycle
        ? [{ type: "request_finished", rid: "c1", outcome: "cancelled", error: { code: "internal_error", message: "User requested cancellation" } }]
        : [{ type: "error", rid: "c1", code: "invalid_request", message: "Command cancelled before completion" }]);
      expect(h.logged).toEqual([]);
    }
  });

  test("a command that moves the session to another thread joins it to the reply running there", async () => {
    const chunks = deferred();
    const h = world({
      sessions: [{ id: 1, thread: "side" }, { id: 2 }],
      runGeneration: async (params) => { await params.send(chunk("so far")); await chunks.promise; },
      dispatchCommand: (cmd) => {
        h.router.setSelectedThread(2, "side");
        return Promise.resolve(commandOutput(cmd.name));
      },
    });
    await h.say(1, "r1");
    await settle();
    await h.handler.handleRouted({ kind: "command", cmd: command("switch_thread"), meta: h.metaOf(2, null, "command") });
    expect(h.frames.get(2)).toEqual([commandOutput("switch_thread"), chunk("so far")]);
    chunks.resolve();
    await h.handler.drain();
  });

  test("disconnecting stops the session's read-only commands, lets its changes finish, and forgets it as a viewer", async () => {
    const { dispatch, gate, signals } = stoppableDispatch();
    const next = deferred();
    const h = world({
      sessions: [{ id: 1 }, { id: 2 }],
      dispatchCommand: dispatch,
      commandChangesState: (cmd) => !cmd.name.startsWith("list_"),
      runGeneration: async (params) => { await next.promise; await params.send(chunk("late")); },
    });
    await h.say(1, "r1");
    h.handler.enqueueRouted({ kind: "command", cmd: command("list_threads"), meta: h.metaOf(2, null, "command") });
    h.handler.enqueueRouted({ kind: "command", cmd: command("thread_label"), meta: h.metaOf(1, null, "command") });
    h.join({ id: 3 });
    h.handler.enqueueRouted({ kind: "command", cmd: command("list_providers"), meta: h.metaOf(3, null, "command") });
    await settle();
    expect(h.handler.queuedSessionCount).toBe(3);
    h.router.unregisterSession(2);
    await h.handler.handleRouted({ kind: "session_disconnected", sessionId: 2 });
    expect(signals.get("list_threads")?.aborted).toBe(true);
    expect(signals.get("list_providers")?.aborted).toBe(false);
    expect(h.handler.queuedSessionCount).toBe(2);
    next.resolve();
    gate("list_threads").resolve();
    gate("thread_label").resolve();
    gate("list_providers").resolve();
    await settle();
    expect(signals.get("thread_label")?.aborted).toBe(false);
    expect(h.frames.get(2)).toEqual([]);
    await h.stop(1);
    await h.handler.drain();
  });

  test("stopping cancels a change left behind by a client that has gone, on the same conversation only", async () => {
    const { dispatch, gate, signals } = stoppableDispatch();
    const h = world({ sessions: [{ id: 1 }, { id: 2 }, { id: 3, thread: "side" }], dispatchCommand: dispatch });
    h.handler.enqueueRouted({ kind: "command", cmd: command("thread_label"), meta: h.metaOf(2, null, "command") });
    h.handler.enqueueRouted({ kind: "command", cmd: command("thread_rename"), meta: h.metaOf(3, null, "command") });
    await settle();
    h.router.unregisterSession(2);
    h.router.unregisterSession(3);
    await h.stop(1);
    expect(signals.get("thread_label")?.aborted).toBe(true);
    expect(signals.get("thread_rename")?.aborted).toBe(false);
    gate("thread_label").resolve();
    gate("thread_rename").resolve();
    await h.handler.drain();
  });

  test("the handler runs whatever arrives on the route stream and then drains", async () => {
    const h = world({ sessions: [{ id: 1 }] });
    async function* routes(): AsyncIterable<RoutedMessage> {
      yield { kind: "command", cmd: command("status"), meta: h.metaOf(1, null, "command") };
      yield { kind: "command", cmd: command("tools"), meta: h.metaOf(1, null, "command") };
    }
    await h.handler.run(routes());
    expect(names(required(h.frames.get(1)))).toEqual(["status", "tools"]);
    expect(h.handler.queuedSessionCount).toBe(0);
  });
});
