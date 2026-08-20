import { describe, expect, test } from "bun:test";

import fixture from "./handler_fixtures/router.json" with { type: "json" };
import { CharacterConfigError } from "../src/characters.ts";
import {
  MessageHandler,
  sanitiseRid,
  withRid,
  type GenerationParams,
  type HandlerRegistry,
} from "../src/handler/router.ts";
import { StreamLeases } from "../src/handler/lease.ts";
import { SessionRouter, type RequestMeta } from "../src/swp/session.ts";
import type { ClientMessage } from "../src/protocol/ClientMessage.ts";
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
) {
  const router = new SessionRouter();
  const frames = new Map<number, ServerMessage[]>();
  for (let id = 1; id <= sessions; id += 1) {
    const received: ServerMessage[] = [];
    frames.set(id, received);
    router.registerSession(
      {
        id,
        clientType: "test-client",
        clientName: `test-${id}`,
        capabilities: ["streaming"],
        character: null,
      },
      (msg) => {
        received.push(msg);
        return Promise.resolve();
      },
    );
  }

  const leases = new StreamLeases();
  const started: GenerationParams[] = [];
  const notifications: Array<{ title: string; body: string }> = [];

  const handler = new MessageHandler({
    router,
    leases,
    registry: registryOf(characters),
    notifier: { notify: (_e, title, body) => notifications.push({ title, body }) },
    dispatchCommand: () =>
      Promise.resolve({ type: "command_output", name: "status", success: true, data: null }),
    runGeneration: (params) => {
      started.push(params);
      if (runGeneration !== undefined) return runGeneration(params);
      return new Promise<void>((resolve) => {
        params.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });

  return { handler, router, leases, frames, started, notifications };
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
  test("a cancel with nothing running sends no frame", async () => {
    const c = caseByName(routed, "a cancel with nothing running sends no frame");
    const h = harness(["Alice"], 1);

    await h.handler.handleRouted({
      kind: "engine",
      msg: { type: "cancel" },
      meta: meta("Alice", 1, "r1", "cancel"),
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
      meta: meta("Alice", 1, "r2", "cancel"),
    });

    const received = h.frames.get(1) ?? [];
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
    expect((h.frames.get(1) ?? []).filter((f) => f.type === "stream_end")).toHaveLength(0);
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
      meta: meta("Alice", 1, "r3", "cancel"),
    });
    expect(second?.signal.aborted).toBe(true);
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
    const frame = await failWith(new Error("provider hung up"));
    expect(frame).toMatchObject({
      type: "error",
      code: "internal_error",
      message: "provider hung up",
    });
  });
});
