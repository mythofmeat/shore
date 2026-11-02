import { describe, expect, test } from "bun:test";

import { afterCommand, type DispatchContext } from "../src/handler/command_dispatch.ts";
import { MessageHandler, type GenerationParams, type HandlerRegistry } from "../src/handler/router.ts";
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
