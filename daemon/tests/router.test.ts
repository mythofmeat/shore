import { describe, expect, test } from "bun:test";

import fixture from "./handler_captures/router.json" with { type: "json" };
import { CharacterConfigError } from "../src/characters.ts";
import {
  MessageHandler,
  sanitiseRid,
  withRid,
  type GenerationParams,
  type HandlerRegistry,
} from "../src/handler/router.ts";
import { StreamLeases } from "../src/handler/lease.ts";
import { isControlRoutedMessage, SessionRouter, type RequestMeta } from "../src/swp/session.ts";
import { routeClientMessage } from "../src/swp/routing.ts";
import type { ClientMessage } from "../src/protocol/ClientMessage.ts";
import type { Command } from "../src/protocol/Command.ts";
import { required } from "../src/util/required.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { NoModelError } from "../src/handler/setup.ts";
import { NO_CHAT_MODELS_MESSAGE } from "../src/config/models.ts";

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
) {
  const router = new SessionRouter();
  const frames = new Map<number, ServerMessage[]>();
  for (let id = 1; id <= sessions; id += 1) {
    registerTestSession(router, frames, id);
  }

  const leases = new StreamLeases();
  const started: GenerationParams[] = [];
  const notifications: Array<{ title: string; body: string }> = [];
  const errors: Array<{ message: string; fields: Record<string, unknown> | undefined }> = [];

  const handler = new MessageHandler({
    router,
    leases,
    registry: registryOf(characters),
    notifier: { notify: (_e, title, body) => notifications.push({ title, body }) },
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
    log: { error: (message, fields) => errors.push({ message, fields }) },
  });

  return { handler, router, leases, frames, started, notifications, errors };
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

function stripAbsent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAbsent);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, stripAbsent(v)]),
  );
}

const caseByName = <T extends { name: string }>(group: readonly T[], name: string): T => {
  const found = group.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no fixture case named ${name}`);
  return found;
};

const routed = fixture.routed as unknown as Array<{
  name: string;
  note: string;
  input: unknown;
  output: Record<string, unknown>;
}>;

describe("routed messages", () => {
  test.each(["message", "regen"] as const)("wire cancellation acknowledges the active %s before retrying", async (kind) => {
    const h = harness(["Alice"], 1);
    const session = meta("Alice", 1, null, "cancel").session;
    const route = async (msg: ClientMessage) => {
      const outcome = routeClientMessage(msg, session, "Alice");
      if (outcome.action !== "route") throw new Error("expected routed request");
      if (isControlRoutedMessage(outcome.routed)) {
        await h.handler.handleControl(outcome.routed);
      } else {
        await h.handler.handleRouted(outcome.routed);
      }
    };

    await route(kind === "message"
      ? message("first-reply", "hi", true)
      : { type: "regen", rid: "first-reply", stream: true });
    await route({ type: "cancel" });
    expect(h.started[0]?.signal.aborted).toBe(true);
    expect(h.frames.get(1)?.at(-1)).toMatchObject({
      type: "stream_end", rid: "first-reply", finish_reason: "cancelled", is_final: true,
    });

    await route({ type: "regen", rid: "retried-reply", stream: true });
    expect(h.started[1]?.signal.aborted).toBe(false);
    await route({ type: "cancel" });
    expect(h.frames.get(1)?.at(-1)).toMatchObject({
      type: "stream_end", rid: "retried-reply", finish_reason: "cancelled", is_final: true,
    });
    await h.handler.drain();
    expect(h.handler.sessionStateCount).toBe(0);
  });

  test.each([null, "réq"])("cancellation preserves an absent or rejected generation rid: %p", async (rid) => {
    const h = harness(["Alice"], 1);
    await h.handler.handleRouted({
      kind: "engine", msg: message(rid, "hi", true), meta: meta("Alice", 1, rid, "message"),
    });
    await h.handler.handleControl({
      kind: "engine", msg: { type: "cancel" }, meta: meta("Alice", 1, null, "cancel"),
    });
    expect(h.frames.get(1)?.at(-1)).toMatchObject({ type: "stream_end", finish_reason: "cancelled" });
    expect(h.frames.get(1)?.at(-1)).not.toHaveProperty("rid");
    await h.handler.drain();
  });

  test("a cancel with nothing running sends no frame", async () => {
    const c = caseByName(routed, "a cancel with nothing running sends no frame");
    const h = harness(["Alice"], 1);

    await h.handler.handleRouted({
      kind: "engine",
      msg: { type: "cancel" },
      meta: meta("Alice", 1, null, "cancel"),
    });

    expect(stripAbsent({ frames: h.frames.get(1), generation_running: false })).toEqual(
      c.output as never,
    );
  });

  test("a cancel ends the running generation with a cancelled stream_end", async () => {
    const c = caseByName(
      routed,
      "a cancel ends the running generation with a cancelled stream_end",
    );
    const h = harness(["Alice"], 1);

    await h.handler.handleRouted({
      kind: "engine",
      msg: message("r1", "hi", false),
      meta: meta("Alice", 1, "r1", "message"),
    });
    const launched = h.started.length === 1;
    const leaseTaken = h.leases.spectator("Alice", 2, h.router) !== undefined;

    await h.handler.handleRouted({
      kind: "engine",
      msg: { type: "cancel" },
      meta: meta("Alice", 1, null, "cancel"),
    });

    const received = h.frames.get(1) ?? [];
    expect(received.find((frame) => frame.type === "stream_end" && frame.rid === "r1")).toMatchObject({ finish_reason: "cancelled", is_final: true });
    expect(
      stripAbsent({
        launched,
        lease_taken: leaseTaken,
        cancel_frame: received.at(-1),
        generation_running: false,
      }),
    ).toEqual(c.output as never);
  });

  test("a regen launches without taking the lease", async () => {
    const c = caseByName(routed, "a regen launches without taking the lease");
    const h = harness(["Alice"], 1);

    await h.handler.handleRouted({
      kind: "engine",
      msg: { type: "regen", rid: "r1", stream: true },
      meta: meta("Alice", 1, "r1", "regen"),
    });

    expect({
      generation_running: h.started.length === 1,
      lease_taken: h.leases.spectator("Alice", 2, h.router) !== undefined,
    }).toEqual(c.output as never);
  });

  test("an unknown character is an error frame and no launch", async () => {
    const c = caseByName(routed, "an unknown character is an error frame and no launch");
    const h = harness(["Alice"], 1);

    await h.handler.handleRouted({
      kind: "engine",
      msg: message("r1", "hi", false),
      meta: meta("Nobody", 1, "r1", "message"),
    });

    expect(
      stripAbsent({
        frames: h.frames.get(1),
        generation_running: h.started.length > 0,
      }),
    ).toEqual(c.output as never);
  });

  test("all clients disconnected cancels every session", async () => {
    const c = caseByName(routed, "all clients disconnected cancels every session");
    const h = harness(["Alice"], 2);

    for (const id of [1, 2]) {
      await h.handler.handleRouted({
        kind: "engine",
        msg: message("r1", "hi", false),
        meta: meta("Alice", id, "r1", "message"),
      });
    }
    const before = [h.started.length >= 1, h.started.length >= 2];

    await h.handler.handleRouted({ kind: "all_clients_disconnected" });

    expect(
      stripAbsent({
        running_before: before,
        running_after: [false, false],
        leases_after: h.leases.spectator("Alice", 99, h.router) === undefined ? 0 : 1,
        last_frame_1: (h.frames.get(1) ?? []).at(-1),
        last_frame_2: (h.frames.get(2) ?? []).at(-1),
      }),
    ).toEqual(c.output as never);
  });

  test("a second message supersedes the first on the same session", async () => {
    const c = caseByName(routed, "a second message supersedes the first on the same session");
    const h = harness(["Alice"], 1);

    await h.handler.handleRouted({
      kind: "engine",
      msg: message("r1", "first", false),
      meta: meta("Alice", 1, "r1", "message"),
    });
    const firstSignal = h.started[0];

    await h.handler.handleRouted({
      kind: "engine",
      msg: message("r2", "second", false),
      meta: meta("Alice", 1, "r2", "message"),
    });

    expect({ generation_running: h.started.length === 2 }).toEqual(c.output as never);
    expect(firstSignal).toBeDefined();
    expect((h.frames.get(1) ?? []).filter((f) => f.type === "stream_end")).toMatchObject([
      { rid: "r1", finish_reason: "cancelled", is_final: true },
    ]);
  });
  test("a hello on the engine path is ignored", async () => {
    const c = caseByName(routed, "a hello on the engine path is ignored");
    const h = harness(["Alice"], 1);

    await h.handler.handleRouted({
      kind: "engine",
      msg: {
        type: "hello",
        client_type: "test-client",
        client_name: "test",
        capabilities: [],
      },
      meta: meta("Alice", 1, "r1", "message"),
    });

    expect(
      stripAbsent({ frames: h.frames.get(1), generation_running: h.started.length > 0 }),
    ).toEqual(c.output as never);
  });

  test("a request from a vanished session launches nothing", async () => {
    const c = caseByName(routed, "a request from a vanished session launches nothing");
    const h = harness(["Alice"], 1);
    h.router.unregisterSession(1);

    await h.handler.handleRouted({
      kind: "engine",
      msg: message("r1", "hi", false),
      meta: meta("Alice", 1, "r1", "message"),
    });

    expect({ generation_running: h.started.length > 0 }).toEqual(c.output as never);
  });

  for (const name of [
    "an ascii rid reaches the generation",
    "a non-ascii rid is dropped before the generation sees it",
  ]) {
    test(name, async () => {
      const c = caseByName(routed, name) as unknown as {
        input: { rid: string };
        output: { first_frame_rid: string | null };
      };
      const h = harness(["Alice"], 1);

      await h.handler.handleRouted({
        kind: "engine",
        msg: message(c.input.rid, "hi", false),
        meta: meta("Alice", 1, c.input.rid, "message"),
      });

      expect(h.started[0]?.rid ?? null).toEqual(c.output.first_frame_rid);
    });
  }
});

describe("what a generation is handed", () => {
  test("regen guidance reaches the generation body", async () => {
    const h = harness(["Alice"], 1);

    await h.handler.handleRouted({
      kind: "engine",
      msg: {
        type: "regen",
        rid: "r-guided",
        stream: true,
        guidance: "consult memory",
      },
      meta: meta("Alice", 1, "r-guided", "regen"),
    });

    expect(h.started[0]?.body.guidance).toBe("consult memory");
    expect(h.started[0]?.body.text).toBe("");
  });

  test("the stream reaches the lease holder as well as the issuer", async () => {
    const h = harness(["Alice"], 2);

    await h.handler.handleRouted({
      kind: "engine",
      msg: message("r1", "hi", false),
      meta: meta("Alice", 2, "r1", "message"),
    });
    await h.handler.handleRouted({
      kind: "engine",
      msg: { type: "regen", rid: "r2", stream: true },
      meta: meta("Alice", 1, "r2", "regen"),
    });

    const regenParams = h.started.at(-1);
    expect(regenParams?.regen).toBe(true);
    await regenParams?.send({ type: "stream_chunk", text: "hello", content_type: "text" });

    const chunks = (id: number) =>
      (h.frames.get(id) ?? []).filter((f) => f.type === "stream_chunk");
    expect(chunks(1)).toHaveLength(1);
    expect(chunks(2)).toHaveLength(1);
  });

  test("cancelling and superseding both abort the generation's signal", async () => {
    const h = harness(["Alice"], 1);

    await h.handler.handleRouted({
      kind: "engine",
      msg: message("r1", "first", false),
      meta: meta("Alice", 1, "r1", "message"),
    });
    const first = h.started[0];
    expect(first?.signal.aborted).toBe(false);

    await h.handler.handleRouted({
      kind: "engine",
      msg: message("r2", "second", false),
      meta: meta("Alice", 1, "r2", "message"),
    });
    expect(first?.signal.aborted).toBe(true);

    const second = h.started[1];
    expect(second?.signal.aborted).toBe(false);
    await h.handler.handleRouted({
      kind: "engine",
      msg: { type: "cancel" },
      meta: meta("Alice", 1, null, "cancel"),
    });
    expect(second?.signal.aborted).toBe(true);
  });
});

describe("session state lifecycle", () => {
  test.each(["cancelled", "superseded"] as const)("%s requests finish only after the provider actually settles", async (outcome) => {
    const finishes: (() => void)[] = [];
    const h = harness(["Alice"], 1, () => new Promise<void>((resolve) => { finishes.push(resolve); }));
    h.router.setSelectedCharacter(1, "Alice");
    const request = (rid: string): RequestMeta => {
      const base = meta("Alice", 1, rid, "message");
      return { ...base, session: { ...base.session, capabilities: ["request-lifecycle"] } };
    };
    await h.handler.handleRouted({ kind: "engine", msg: message("first", "hello", true), meta: request("first") });
    if (outcome === "cancelled") await h.handler.cancelGeneration(1, null, "user cancelled");
    else await h.handler.handleRouted({ kind: "engine", msg: message("second", "again", true), meta: request("second") });
    expect(h.started[0]?.signal.aborted).toBe(true);
    expect(h.frames.get(1)?.map((frame) => frame.type)).toEqual(["stream_end"]);
    for (const finish of finishes) finish();
    await h.handler.drain();
    expect(h.frames.get(1)?.find((frame) => frame.type === "request_finished" && frame.rid === "first")).toMatchObject({ outcome });
    if (outcome === "superseded") expect(h.frames.get(1)?.find((frame) => frame.type === "request_finished" && frame.rid === "second")).toMatchObject({ outcome: "completed" });
  });

  test("a synchronous provider failure also finishes its request and releases session state", async () => {
    const h = harness(["Alice"], 1, () => { throw new Error("synchronous provider failure"); });
    const request = meta("Alice", 1, "failure", "message");
    await h.handler.handleRouted({ kind: "engine", msg: message("failure", "hello", true), meta: { ...request, session: { ...request.session, capabilities: ["request-lifecycle"] } } });
    await h.handler.drain();
    expect(h.frames.get(1)?.find((frame) => frame.type === "request_finished")).toMatchObject({ outcome: "failed", error: { message: "synchronous provider failure" } });
    expect(h.handler.sessionStateCount).toBe(0);
  });

  test("opted-in clients receive failure details after moving away from the request's thread", async () => {
    let fail = (_error: Error) => {};
    const h = harness(["Alice"], 1, () => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const request = meta("Alice", 1, "background", "message");
    h.router.setSelectedCharacter(1, "Alice");
    await h.handler.handleRouted({
      kind: "engine", msg: message("background", "hello", true),
      meta: { ...request, session: { ...request.session, capabilities: ["request-lifecycle"] } },
    });
    h.router.setSelectedThread(1, "other");
    fail(new Error("background request failed"));
    await h.handler.drain();
    expect(h.frames.get(1)).toEqual([
      { type: "request_finished", rid: "background", outcome: "failed", error: { code: "internal_error", message: "background request failed" } },
    ]);
  });

  test("a completed generation releases its session state", async () => {
    let finish: (() => void) | undefined;
    const h = harness(
      ["Alice"],
      1,
      () => new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );

    await h.handler.handleRouted({
      kind: "engine",
      msg: message("r1", "hi", false),
      meta: meta("Alice", 1, "r1", "message"),
    });
    expect(h.handler.sessionStateCount).toBe(1);

    finish?.();
    await h.handler.drain();
    expect(h.handler.sessionStateCount).toBe(0);
  });

  test("cancelling releases session state while the generation settles", async () => {
    let finish: (() => void) | undefined;
    const h = harness(
      ["Alice"],
      1,
      () => new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    await h.handler.handleRouted({
      kind: "engine",
      msg: message("r1", "hi", false),
      meta: meta("Alice", 1, "r1", "message"),
    });
    expect(h.handler.sessionStateCount).toBe(1);

    await h.handler.handleRouted({
      kind: "engine",
      msg: { type: "cancel" },
      meta: meta("Alice", 1, null, "cancel"),
    });
    expect(h.handler.sessionStateCount).toBe(0);
    finish?.();
    await h.handler.drain();
  });

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
    expect(h.handler.sessionStateCount).toBe(1);

    finishes[1]?.();
    await h.handler.drain();
    expect(h.handler.sessionStateCount).toBe(0);
  });

  test("repeated connect, generate, and disconnect cycles stay bounded", async () => {
    const h = harness(["Alice"], 0);

    for (let id = 1; id <= 100; id += 1) {
      registerTestSession(h.router, h.frames, id);
      await h.handler.handleRouted({
        kind: "engine",
        msg: message(`r${id}`, "hi", false),
        meta: meta("Alice", id, `r${id}`, "message"),
      });
      expect(h.handler.sessionStateCount).toBe(1);

      const { allGone } = h.router.unregisterSession(id);
      expect(allGone).toBe(true);
      await h.handler.handleRouted({ kind: "all_clients_disconnected" });
      await h.handler.drain();
      expect(h.handler.sessionStateCount).toBe(0);
    }
  });
});

describe("with_rid", () => {
  for (const c of fixture.with_rid as unknown as Array<{
    name: string;
    note: string;
    input: { before: ServerMessage; rid: string | null };
    output: unknown;
  }>) {
    test(c.name, () => {
      expect(stripAbsent(withRid(c.input.before, c.input.rid))).toEqual(c.output as never);
    });
  }
});

describe("the rid filter", () => {
  for (const c of fixture.rid_filter as unknown as Array<{
    name: string;
    note: string;
    input: string | null;
    output: string | null;
  }>) {
    test(c.name, () => {
      expect(sanitiseRid(c.input)).toEqual(c.output);
    });
  }
});

describe("the regen body", () => {
  for (const c of fixture.regen_body as unknown as Array<{
    name: string;
    note: string;
    input: { rid: string | null; stream: boolean };
    output: unknown;
  }>) {
    test(c.name, async () => {
      const h = harness(["Alice"], 1);
      await h.handler.handleRouted({
        kind: "engine",
        msg: { type: "regen", rid: c.input.rid, stream: c.input.stream },
        meta: meta("Alice", 1, c.input.rid, "regen"),
      });

      const body = h.started[0]?.body;
      expect({
        rid: body?.rid,
        text: body?.text,
        stream: body?.stream,
        images: body?.images,
      }).toEqual(c.output as never);
    });
  }
});

describe("a generation that throws", () => {
  async function failWith(error: unknown): Promise<ServerMessage | undefined> {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const h = harness(["Alice"], 1, () => Promise.reject(error));
    await h.handler.handleRouted({
      kind: "engine",
      msg: message(null, "hello", true),
      meta: meta("Alice", 1, null, "message"),
    });
    await h.handler.drain();
    return h.frames.get(1)?.find((f) => f.type === "error");
  }

  test("reports a missing model as invalid_request", async () => {
    const frame = await failWith(new NoModelError(NO_CHAT_MODELS_MESSAGE));
    expect(frame).toMatchObject({
      type: "error",
      code: "invalid_request",
      message: NO_CHAT_MODELS_MESSAGE,
    });
  });

  test("reports an invalid character overlay as invalid_request", async () => {
    const frame = await failWith(
      new CharacterConfigError(
        "Alice",
        new Error("unknown field `bogus`, expected `enabled` or `heartbeat`"),
      ),
    );
    expect(frame).toMatchObject({
      type: "error",
      code: "invalid_request",
      message:
        'invalid config for character "Alice": unknown field `bogus`, expected `enabled` or `heartbeat`',
    });
  });

  test("reports anything else as internal_error", async () => {
    const h = harness(["Alice"], 1, () => Promise.reject(new Error("provider hung up")));
    await h.handler.handleRouted({
      kind: "engine",
      msg: message(null, "hello", true),
      meta: meta("Alice", 1, null, "message"),
    });
    await h.handler.drain();
    const frame = h.frames.get(1)?.find((candidate) => candidate.type === "error");
    expect(frame).toMatchObject({
      type: "error",
      code: "internal_error",
      message: "provider hung up",
    });
    expect(h.errors).toContainEqual({
      message: "error processing engine message",
      fields: { error: "provider hung up" },
    });
  });

  test("reports provider HTTP failures with their retry delay", async () => {
    const frame = await failWith({
      kind: "http_status",
      status: 429,
      body: "rate limited",
      retry_after_ms: 12_000,
    });
    expect(frame).toMatchObject({
      type: "error",
      code: "provider_error",
      message: "HTTP 429: rate limited",
      retry_after_ms: 12_000,
    });
  });

  test("reports provider-shaped failures as provider errors", async () => {
    const frame = await failWith({ kind: "provider", message: "upstream rejected the request" });
    expect(frame).toMatchObject({
      type: "error",
      code: "provider_error",
      message: "provider error: upstream rejected the request",
    });
  });

  test("reports provider stream failures as provider errors", async () => {
    const frame = await failWith({
      kind: "stream_errored",
      message: "upstream overloaded",
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 },
      timing: { total_ms: 2_000, time_to_first_token_ms: 0 },
    });
    expect(frame).toMatchObject({
      type: "error",
      code: "provider_error",
      message: "stream errored after partial usage: upstream overloaded",
    });
  });

  test("reports provider timeouts as timeouts", async () => {
    const frame = await failWith(new DOMException("The operation timed out.", "TimeoutError"));
    expect(frame).toMatchObject({
      type: "error",
      code: "timeout",
      message: "The operation timed out.",
    });
  });

  test("keeps timeout classification after a stream failure is flattened", async () => {
    const frame = await failWith({
      kind: "stream_errored",
      message: "The operation timed out.",
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 },
      timing: { total_ms: 30_000, time_to_first_token_ms: 0 },
      timeout: true,
    });
    expect(frame).toMatchObject({
      type: "error",
      code: "timeout",
      message: "stream errored after partial usage: The operation timed out.",
    });
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

  test("a message on another session launches while a command is pending", async () => {
    const { dispatch, gate } = gatedDispatch();
    const { handler, started } = harness(["ada"], 2, async () => undefined, dispatch);

    handler.enqueueRouted({ kind: "command", cmd: command("slow"), meta: meta("ada", 1, null, "command") });
    handler.enqueueRouted({
      kind: "engine",
      msg: message(null, "hi", true),
      meta: meta("ada", 2, null, "message"),
    });
    await settle();

    expect(started).toHaveLength(1);
    expect(started[0]?.meta.session.sessionId).toBe(2);

    gate("slow").resolve();
    await handler.drain();
  });

  test("a message queued behind a command on the same session waits for it", async () => {
    const { dispatch, gate } = gatedDispatch();
    const { handler, started } = harness(["ada"], 1, async () => undefined, dispatch);

    handler.enqueueRouted({ kind: "command", cmd: command("slow"), meta: meta("ada", 1, null, "command") });
    handler.enqueueRouted({
      kind: "engine",
      msg: message(null, "hi", true),
      meta: meta("ada", 1, null, "message"),
    });
    await settle();
    expect(started).toHaveLength(0);

    gate("slow").resolve();
    await settle();
    expect(started).toHaveLength(1);
    await handler.drain();
  });

  test("a running generation does not block the next command on its session", async () => {
    const { dispatch, gate, started } = gatedDispatch();
    const generating = deferred();
    const { handler, frames } = harness(["ada"], 1, async () => await generating.promise, dispatch);

    handler.enqueueRouted({
      kind: "engine",
      msg: message(null, "hi", true),
      meta: meta("ada", 1, null, "message"),
    });
    handler.enqueueRouted({ kind: "command", cmd: command("after"), meta: meta("ada", 1, null, "command") });
    gate("after").resolve();
    await settle();

    expect(started).toEqual(["after"]);
    expect(names(required(frames.get(1)))).toEqual(["after"]);

    generating.resolve();
    await handler.drain();
  });

  test("a failing dispatch is logged and does not wedge the session queue", async () => {
    const { dispatch, gate, started } = gatedDispatch();
    const { handler, frames, errors } = harness(["ada"], 1, undefined, dispatch);

    handler.enqueueRouted({ kind: "command", cmd: command("boom"), meta: meta("ada", 1, null, "command") });
    handler.enqueueRouted({ kind: "command", cmd: command("after"), meta: meta("ada", 1, null, "command") });
    gate("boom").reject(new Error("dispatch exploded"));
    gate("after").resolve();
    await handler.drain();

    expect(started).toEqual(["boom", "after"]);
    expect(errors.map((e) => e.fields?.["error"])).toContain("dispatch exploded");
    expect(names(required(frames.get(1)))).toEqual(["after"]);
  });

  test("drain waits for queued work that has not started yet", async () => {
    const { dispatch, gate } = gatedDispatch();
    const { handler, frames } = harness(["ada"], 1, undefined, dispatch);

    handler.enqueueRouted({ kind: "command", cmd: command("first"), meta: meta("ada", 1, null, "command") });
    handler.enqueueRouted({ kind: "command", cmd: command("second"), meta: meta("ada", 1, null, "command") });

    let drained = false;
    const draining = handler.drain().then(() => {
      drained = true;
    });
    gate("first").resolve();
    await settle();
    expect(drained).toBe(false);

    gate("second").resolve();
    await draining;
    expect(names(required(frames.get(1)))).toEqual(["first", "second"]);
  });
});

test("cancel bypasses a blocked command, isolates its session and preserves its confirmed result", async () => {
  const { dispatch, gate, signals } = gatedDispatch();
  const { handler, frames } = harness(["ada"], 2, undefined, dispatch);
  const base = meta("ada", 1, "held-request", "command");
  const request = { ...base, session: { ...base.session, capabilities: ["request-lifecycle"] } };
  handler.enqueueRouted({ kind: "command", cmd: command("held"), meta: request });
  handler.enqueueRouted({ kind: "command", cmd: command("other"), meta: meta("ada", 2, null, "command") });
  try {
    await settle();
    handler.enqueueRouted({ kind: "engine", msg: { type: "cancel" }, meta: meta("ada", 1, null, "cancel") });
    await settle();
    expect(required(signals.get("held")).aborted).toBe(true);
    expect(required(signals.get("other")).aborted).toBe(false);
    gate("held").resolve();
    await settle();
    expect(names(required(frames.get(1)))).toEqual(["held", "request_finished"]);
    expect(frames.get(1)?.at(-1)).toMatchObject({ type: "request_finished", rid: "held-request", outcome: "completed" });
  } finally {
    gate("held").resolve(); gate("other").resolve(); await handler.drain();
  }
});

test.each([false, true])("cancel prevents queued mutations from starting and leaves later requests usable (started: %s)", async (started) => {
  const { dispatch, gate, started: calls } = gatedDispatch();
  const { handler, frames } = harness(["ada"], 1, undefined, dispatch);
  const request = (rid: string) => { const base = meta("ada", 1, rid, "command"); return { ...base, session: { ...base.session, capabilities: ["request-lifecycle"] } }; };
  handler.enqueueRouted({ kind: "command", cmd: command("first"), meta: request("first-rid") });
  handler.enqueueRouted({ kind: "command", cmd: command("queued"), meta: request("queued-rid") });
  if (started) await settle();
  handler.enqueueRouted({ kind: "engine", msg: { type: "cancel" }, meta: meta("ada", 1, null, "cancel") });
  gate("first").resolve(); gate("queued").resolve();
  await handler.drain();
  expect(calls).toEqual(started ? ["first"] : []);
  expect(frames.get(1)?.filter((frame) => frame.type === "request_finished")).toMatchObject([
    { rid: "first-rid", outcome: started ? "completed" : "cancelled" },
    { rid: "queued-rid", outcome: "cancelled" },
  ]);
  handler.enqueueRouted({ kind: "command", cmd: command("after"), meta: request("after-rid") });
  gate("after").resolve(); await handler.drain();
  expect(frames.get(1)?.at(-1)).toMatchObject({ type: "request_finished", rid: "after-rid", outcome: "completed" });
});

describe("a session that disconnects mid-command", () => {
  test("aborts the in-flight command and suppresses its reply", async () => {
    const { dispatch, gate, signals } = gatedDispatch();
    const { handler, router, frames } = harness(["ada"], 1, undefined, dispatch);

    handler.enqueueRouted({ kind: "command", cmd: command("slow"), meta: meta("ada", 1, null, "command") });
    await settle();
    expect(required(signals.get("slow")).aborted).toBe(false);

    router.unregisterSession(1);
    await handler.handleControl({ kind: "session_disconnected", sessionId: 1 });
    expect(required(signals.get("slow")).aborted).toBe(true);

    gate("slow").resolve();
    await handler.drain();
    expect(names(required(frames.get(1)))).toEqual([]);
  });

  test("drops a command still queued for the departed session", async () => {
    const { dispatch, gate, started } = gatedDispatch();
    const { handler, router } = harness(["ada"], 1, undefined, dispatch);

    handler.enqueueRouted({ kind: "command", cmd: command("slow"), meta: meta("ada", 1, null, "command") });
    handler.enqueueRouted({ kind: "command", cmd: command("never"), meta: meta("ada", 1, null, "command") });
    await settle();

    router.unregisterSession(1);
    await handler.handleControl({ kind: "session_disconnected", sessionId: 1 });
    gate("slow").resolve();
    await handler.drain();

    expect(started).toEqual(["slow"]);
  });
});

test("different threads can generate in one session without cancelling or mixing streams", async () => {
  const h = harness(["Alice"], 1);
  for (const thread of ["main", "scratch"]) {
    h.router.setSelectedCharacter(1, "Alice");
    h.router.setSelectedThread(1, thread);
    const request = meta("Alice", 1, thread, "message");
    await h.handler.handleRouted({
      kind: "engine", msg: message(thread, "hello", true),
      meta: { ...request, session: { ...request.session, selectedThread: thread } },
    });
  }
  const main = required(h.started[0]);
  const scratch = required(h.started[1]);
  expect(main.signal.aborted).toBe(false);
  await main.send({ type: "stream_chunk", text: "main", content_type: "text" });
  await scratch.send({ type: "stream_chunk", text: "scratch", content_type: "text" });
  expect(h.frames.get(1)).toEqual([{ type: "stream_chunk", text: "scratch", content_type: "text" }]);
  await h.handler.cancelGeneration(1, null, "user cancelled");
  expect(scratch.signal.aborted).toBe(true);
  expect(main.signal.aborted).toBe(false);
  expect(h.frames.get(1)?.at(-1)).toMatchObject({ type: "stream_end", rid: "scratch", finish_reason: "cancelled" });
  await h.handler.handleControl({ kind: "all_clients_disconnected" });
  await h.handler.drain();
  expect(main.signal.aborted).toBe(true);
  expect(h.frames.get(1)?.at(-1)).toMatchObject({ type: "stream_end", rid: "main", finish_reason: "cancelled" });
});

test("the shared engine handler preserves all conversation fields from its executable registrations", async () => {
  const h = harness(["Alice"], 1);
  const request: ClientMessage = { type: "message", rid: "all-fields", text: "hello", stream: false, images: ["original.png"], image_data: [{ filename: "upload.png", data: "YWJj", mime_type: "image/png" }], absence_seconds: 120 };
  await h.handler.handleEngine(request, meta("Alice", 1, "all-fields", "message"));
  expect(h.started[0]?.body).toEqual({ rid: "all-fields", text: "hello", stream: false, images: ["original.png"], image_data: [{ filename: "upload.png", data: "YWJj", mime_type: "image/png" }], absence_seconds: 120 });
  expect(h.started[0]?.regen).toBe(false);
  await h.handler.handleEngine({ type: "cancel" }, meta("Alice", 1, null, "cancel"));
  expect(h.started[0]?.signal.aborted).toBe(true);
  await h.handler.handleEngine({ type: "regen", rid: "regen-fields", stream: false, guidance: "new perspective" }, meta("Alice", 1, "regen-fields", "regen"));
  expect(h.started[1]?.body).toEqual({ rid: "regen-fields", text: "", stream: false, images: [], image_data: [], guidance: "new perspective" });
  expect(h.started[1]?.regen).toBe(true);
  await h.handler.handleEngine({ type: "cancel" }, meta("Alice", 1, null, "cancel"));
});

test("non-streaming requests wait for the completed response while spectators still receive progress", async () => {
  const h = harness(["Alice"], 2);
  h.leases.observe("Alice", 2, "message");
  await h.handler.handleEngine({ type: "regen", rid: "quiet", stream: false }, meta("Alice", 1, "quiet", "regen"));
  const generation = required(h.started[0]);
  const frames: ServerMessage[] = [
    { type: "stream_start", rid: "quiet", regen: true },
    { type: "stream_chunk", rid: "quiet", content_type: "thinking", text: "thinking" },
    { type: "stream_chunk", rid: "quiet", content_type: "text", text: "partial" },
    { type: "stream_end", rid: "quiet", content: "completed", is_final: true, metadata: { model: "fixture", tokens: { input: 1, output: 1, cache_read: 0, cache_write: 0 }, timing: { total_ms: 1, ttft_ms: 1 } } },
  ];
  for (const frame of frames) await generation.send(frame);
  expect(h.frames.get(1)).toEqual([required(frames[3])]);
  expect(h.frames.get(2)).toEqual(frames);
  await h.handler.handleEngine({ type: "cancel" }, meta("Alice", 1, null, "cancel"));
});


test("cancel reports each skipped command to clients without request lifecycle", async () => {
  const { dispatch, gate, started } = gatedDispatch();
  const { handler, frames } = harness(["ada"], 1, undefined, dispatch);
  handler.enqueueRouted({ kind: "command", cmd: command("queued"), meta: meta("ada", 1, "queued-rid", "command") });
  handler.enqueueRouted({ kind: "engine", msg: { type: "cancel" }, meta: meta("ada", 1, null, "cancel") });
  gate("queued").resolve(); await handler.drain();
  expect(started).toEqual([]);
  expect(frames.get(1)).toContainEqual({ type: "error", rid: "queued-rid", code: "invalid_request", message: "Command cancelled before completion" });
});
