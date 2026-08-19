import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ClientMessage } from "../src/protocol/ClientMessage";
import type { ServerMessage } from "../src/protocol/ServerMessage";
import {
  MAX_CONSECUTIVE_LAGS,
  PING_INTERVAL_MS,
  SWP_V1,
  performHandshake,
  type HandshakeProvider,
} from "../src/swp/connection";
import { BROADCAST_CAPACITY } from "../src/swp/broadcast";
import { MAX_WIRE_MESSAGE_SIZE, WireError, WireReader, writeMessage } from "../src/swp/framing";
import {
  eventMatchesSession,
  msgTypeName,
  resolveHandshakeCharacter,
  routeClientMessage,
} from "../src/swp/routing";
import { SessionRouter, type SessionMeta } from "../src/swp/session";

const OPEN = (): boolean => true;

interface Fixture {
  readonly constants: Record<string, number>;
  readonly framing: readonly FramingCase[];
  readonly write_message: readonly { name: string; message: ServerMessage; line: string }[];
  readonly resolve_handshake_character: readonly {
    character_names: string[];
    requested: string | null;
    resolved: string | null;
  }[];
  readonly event_matches_session: readonly {
    name: string;
    registered: boolean;
    unregistered: boolean;
  }[];
  readonly msg_type_name: readonly {
    variant: string;
    type_name: string;
    handshake_error_message: string;
  }[];
  readonly route_client_message: readonly RoutingCase[];
  readonly handshake: readonly HandshakeCase[];
}

interface FramingCase {
  readonly name: string;
  readonly input_b64?: string;
  readonly input_repeat?: { byte: number; count: number; trailing_newline: boolean };
  readonly results: readonly ({ ok: ClientMessage } | { eof: true } | { err: string })[];
}

interface RoutingCase {
  readonly name: string;
  readonly live_character: string | null;
  readonly routed: Record<string, unknown> | null;
  readonly written: string;
}

interface HandshakeCase {
  readonly name: string;
  readonly characters: string[];
  readonly client_hello_line: string | null;
  readonly server_frames: readonly ServerMessage[];
  readonly result: Record<string, unknown>;
  readonly registered_clients: readonly Record<string, unknown>[];
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, "swp_fixtures", "swp.json"), "utf8"),
) as Fixture;

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  if (bytes.length > 0) yield bytes;
}

async function* byteAtATime(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  for (const b of bytes) yield new Uint8Array([b]);
}

function inputBytes(c: FramingCase): Uint8Array {
  if (c.input_b64 !== undefined) return Uint8Array.from(Buffer.from(c.input_b64, "base64"));
  const spec = c.input_repeat;
  if (spec === undefined) throw new Error(`case ${c.name} has no input`);
  const out = new Uint8Array(spec.count + (spec.trailing_newline ? 1 : 0));
  out.fill(spec.byte, 0, spec.count);
  if (spec.trailing_newline) out[spec.count] = 0x0a;
  return out;
}

function withSkippedDefaults(msg: ClientMessage): ClientMessage {
  return msg.type === "message" ? { image_data: [], ...msg } : msg;
}

async function driveFraming(
  source: AsyncIterable<Uint8Array>,
): Promise<({ ok: ClientMessage } | { eof: true } | { err: string })[]> {
  const reader = new WireReader(source);
  const out: ({ ok: ClientMessage } | { eof: true } | { err: string })[] = [];
  for (;;) {
    try {
      const msg = await reader.readMessage();
      if (msg === null) {
        out.push({ eof: true });
        return out;
      }
      out.push({ ok: msg });
    } catch (e) {
      out.push({ err: e instanceof WireError ? e.message : String(e) });
      return out;
    }
    if (out.length > 16) return out;
  }
}

describe("constants match the Rust", () => {
  test("every transport constant", () => {
    expect(SWP_V1).toBe(fixture.constants.swp_v1 as number);
    expect(MAX_WIRE_MESSAGE_SIZE).toBe(fixture.constants.max_wire_message_size as number);
    expect(PING_INTERVAL_MS).toBe((fixture.constants.ping_interval_secs as number) * 1000);
    expect(MAX_CONSECUTIVE_LAGS).toBe(fixture.constants.max_consecutive_lags as number);
    expect(BROADCAST_CAPACITY).toBe(fixture.constants.broadcast_capacity as number);
  });
});

describe("framing", () => {
  for (const c of fixture.framing) {
    test(c.name, async () => {
      const actual = await driveFraming(once(inputBytes(c)));
      expect(actual.length).toBe(c.results.length);

      for (const [i, expected] of c.results.entries()) {
        const got = actual[i];
        if ("ok" in expected) {
          expect(got).toEqual({ ok: withSkippedDefaults(expected.ok) });
        } else if ("eof" in expected) {
          expect(got).toEqual({ eof: true });
        } else {
          expect(got).toHaveProperty("err");
          const SIZE = "Message exceeds maximum size";
          expect((got as { err: string }).err === SIZE).toBe(expected.err === SIZE);
        }
      }
    });
  }

  for (const c of fixture.framing.filter((x) => x.input_b64 !== undefined)) {
    test(`${c.name} — one byte per chunk`, async () => {
      const actual = await driveFraming(byteAtATime(inputBytes(c)));
      const whole = await driveFraming(once(inputBytes(c)));
      expect(actual).toEqual(whole);
    });
  }
});

describe("a message from an older client", () => {
  async function decode(line: string) {
    const bytes = new TextEncoder().encode(line);
    return await driveFraming(once(bytes));
  }

  test("a per-message overrides field is ignored, not rejected", async () => {
    const [first] = await decode(
      JSON.stringify({
        type: "message",
        rid: "r1",
        text: "hello",
        stream: true,
        images: [],
        overrides: { temperature: 0.9, top_p: 0.4, thinking_budget: 2048 },
      }) + "\n",
    );

    expect(first).toEqual({
      ok: {
        type: "message",
        rid: "r1",
        text: "hello",
        stream: true,
        images: [],
        image_data: [],
      },
    });
  });

  test("any other unknown field is ignored too", async () => {
    const [first] = await decode(
      JSON.stringify({
        type: "message",
        text: "hello",
        stream: false,
        images: [],
        invented_by_a_newer_client: { anything: true },
      }) + "\n",
    );

    expect(first).toEqual({
      ok: { type: "message", text: "hello", stream: false, images: [], image_data: [] },
    });
  });
});

const FLOAT_NOTATION_DIVERGES = new Set(["usage_warning"]);

describe("write_message", () => {
  for (const c of fixture.write_message) {
    test(c.name, async () => {
      const chunks: Uint8Array[] = [];
      await writeMessage({ write: (b) => void chunks.push(b) }, c.message);
      const line = Buffer.concat(chunks).toString("utf8");

      expect(JSON.parse(line)).toEqual(JSON.parse(c.line));
      expect(Object.keys(JSON.parse(line))).toEqual(Object.keys(JSON.parse(c.line)));

      if (FLOAT_NOTATION_DIVERGES.has(c.name)) {
        expect(line).not.toBe(c.line);
        expect(c.line).toContain('"current_cost":8.0');
        expect(line).toContain('"current_cost":8');
      } else {
        expect(line).toBe(c.line);
      }
    });
  }
});

describe("resolve_handshake_character", () => {
  for (const c of fixture.resolve_handshake_character) {
    test(`requested ${JSON.stringify(c.requested)} against [${c.character_names.join(", ")}]`, () => {
      const characters = c.character_names.map((name) => ({ name }));
      expect(resolveHandshakeCharacter(c.requested, characters)).toBe(c.resolved);
    });
  }

  const two = [{ name: "ada" }, { name: "bea" }];

  test("a refused request lands on the character the daemon is already serving", () => {
    expect(resolveHandshakeCharacter("ghost", two, "bea")).toBe("bea");
  });

  test("a request that can be honoured still wins over what is held", () => {
    expect(resolveHandshakeCharacter("ada", two, "bea")).toBe("ada");
  });

  test("no request at all inherits the held character rather than going ambiguous", () => {
    expect(resolveHandshakeCharacter(null, two, "bea")).toBe("bea");
    expect(resolveHandshakeCharacter(null, two, null)).toBeNull();
  });

  test("a held character that no longer exists is not offered", () => {
    expect(resolveHandshakeCharacter(null, two, "gone")).toBeNull();
    expect(resolveHandshakeCharacter("ghost", two, "gone")).toBeNull();
  });
});

describe("event_matches_session", () => {
  const byName = new Map(fixture.write_message.map((w) => [w.name, w.message]));
  for (const c of fixture.event_matches_session) {
    test(c.name, () => {
      const msg = byName.get(c.name);
      expect(msg).toBeDefined();
      const wire = msg as ServerMessage;
      const character =
        wire.type === "history"
          ? (wire.selected_character ?? null)
          : wire.type === "new_message"
            ? (wire.character ?? null)
            : "selected";
      expect(eventMatchesSession(wire, character, true)).toBe(c.registered);
      const unregistered =
        wire.type === "history" || wire.type === "new_message" ? false : c.unregistered;
      expect(eventMatchesSession(wire, character, false)).toBe(unregistered);
    });
  }

  test("conversation events only reach the selected character", () => {
    const history = {
      type: "history",
      messages: [],
      active_start: 0,
      config: {},
      selected_character: "poppy",
      revision: 1,
    } as ServerMessage;
    const message = {
      type: "new_message",
      character: "poppy",
      revision: 1,
    } as ServerMessage;

    expect(eventMatchesSession(history, "poppy", true)).toBe(true);
    expect(eventMatchesSession(history, "Yuna", true)).toBe(false);
    expect(eventMatchesSession(message, "poppy", true)).toBe(true);
    expect(eventMatchesSession(message, "Yuna", true)).toBe(false);
    expect(eventMatchesSession(message, null, true)).toBe(false);
  });

  test("subagent status only reaches the character that owns the task", () => {
    const status = {
      type: "subagent_status",
      task_id: "sa_1",
      character: "poppy",
      name: "research",
      query: "q",
      status: "running",
    } as ServerMessage;

    expect(eventMatchesSession(status, "poppy", true)).toBe(true);
    expect(eventMatchesSession(status, "Yuna", true)).toBe(false);
    expect(eventMatchesSession(status, null, true)).toBe(false);
    expect(eventMatchesSession(status, "poppy", false)).toBe(false);
  });

  test("an all-characters subscriber gets conversation events for every character", () => {
    const message = {
      type: "new_message",
      character: "poppy",
      revision: 1,
    } as ServerMessage;

    expect(eventMatchesSession(message, null, true, true)).toBe(true);
    expect(eventMatchesSession(message, "Yuna", true, true)).toBe(true);
    expect(eventMatchesSession(message, null, false, true)).toBe(false);
  });
});

describe("msg_type_name", () => {
  for (const c of fixture.msg_type_name) {
    test(c.variant, () => {
      const msg = { type: c.variant } as ClientMessage;
      expect(msgTypeName(msg)).toBe(c.type_name);
      expect(`Expected hello, got ${JSON.stringify(msgTypeName(msg))}`).toBe(
        c.handshake_error_message,
      );
    });
  }
});

const CAPTURED_SESSION: SessionMeta = {
  clientId: 1,
  sessionId: 1,
  clientType: "tui",
  clientName: "t",
  capabilities: ["images"],
  selectedCharacter: "captured-at-handshake",
};

describe("route_client_message", () => {
  const framingByName = new Map(fixture.framing.map((f) => [f.name, f]));
  void framingByName;

  for (const c of fixture.route_client_message) {
    test(c.name, async () => {
      const routed = c.routed;
      const msg: ClientMessage =
        routed === null
          ? ({ type: "hello", client_type: "tui", client_name: "t", capabilities: [] } as ClientMessage)
          : routed.kind === "command"
            ? ({ type: "command", ...(routed.cmd as object) } as ClientMessage)
            : (routed.msg as ClientMessage);

      const outcome = routeClientMessage(msg, CAPTURED_SESSION, c.live_character);

      if (routed === null) {
        expect(outcome.action).toBe("reply");
        const chunks: Uint8Array[] = [];
        await writeMessage(
          { write: (b) => void chunks.push(b) },
          (outcome as { action: "reply"; reply: ServerMessage }).reply,
        );
        expect(Buffer.concat(chunks).toString("utf8")).toBe(c.written);
        return;
      }

      expect(outcome.action).toBe("route");
      expect(c.written).toBe("");
      const got = (outcome as { action: "route"; routed: Record<string, unknown> }).routed;
      expect(got.kind).toBe(routed.kind as string);

      const meta = got.meta as {
        rid: string | null;
        kind: string;
        session: { selectedCharacter: string | null; capabilities: readonly string[] };
      };
      const expectedMeta = routed.meta as {
        rid: string | null;
        kind: string;
        session: { selected_character: string | null; capabilities: string[] };
      };

      expect(meta.rid).toBe(expectedMeta.rid);
      expect(meta.kind).toBe(expectedMeta.kind);
      expect(meta.session.selectedCharacter).toBe(expectedMeta.session.selected_character);
      expect([...meta.session.capabilities]).toEqual(expectedMeta.session.capabilities);
    });
  }
});

describe("handshake", () => {
  for (const c of fixture.handshake) {
    test(c.name, async () => {
      const overrides = c.name === "history overrides the resolved character";
      const provider: HandshakeProvider = {
        hello: () => Promise.resolve({ characters: c.characters.map((name) => ({ name })) }),
        history: overrides
          ? () =>
              Promise.resolve({
                messages: [],
                activeStart: 0,
                config: {},
                selectedCharacter: "forced-by-history",
                revision: 1,
              })
          : (selected) =>
          Promise.resolve({
            messages: [
              {
                msg_id: "m1",
                role: "assistant",
                content: `history for ${selected === null ? "None" : `Some(${JSON.stringify(selected)})`}`,
                images: [],
                content_blocks: [],
                timestamp: "2026-01-01T00:00:00Z",
              },
            ] as never,
            activeStart: 0,
            config: { defaults: true },
            selectedCharacter: selected,
            revision: 42,
          }),
      };

      const line = c.client_hello_line;
      const input = line === null ? new Uint8Array(0) : new TextEncoder().encode(`${line}\n`);
      const written: Uint8Array[] = [];
      const router = new SessionRouter();

      let error: unknown = null;
      let session: SessionMeta | null = null;
      try {
        session = await performHandshake(
          new WireReader(once(input)),
          { write: (b) => void written.push(b) },
          {
            clientId: 1,
            serverName: "shore-test",
            router,
            events: null as never,
            handshake: provider,
            authenticate: OPEN,
            route: async () => {},
            shutdown: new Promise<void>(() => {}),
          },
        );
      } catch (e) {
        error = e;
      }

      const frames = Buffer.concat(written)
        .toString("utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as ServerMessage);
      expect(frames).toEqual(c.server_frames as ServerMessage[]);

      if ("err" in c.result) {
        expect(error).not.toBeNull();
        expect(session).toBeNull();
        expect(router.sessions()).toEqual([]);
      } else {
        expect(error).toBeNull();
        expect(session?.selectedCharacter ?? null).toBe(
          (c.result.selected_character ?? null) as string | null,
        );
        expect(session?.clientType).toBe(c.result.client_type as string);
        expect(session?.clientName).toBe(c.result.client_name as string);
        expect(router.sessions()).toEqual([[1, (c.result.selected_character ?? null) as string | null]]);
      }
    });
  }
});
