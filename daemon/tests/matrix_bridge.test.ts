import { afterEach, describe, expect, test } from "bun:test";

import type { ClientMessage } from "../src/protocol/ClientMessage";
import type { NewMessage } from "../src/protocol/NewMessage";
import type { ServerMessage } from "../src/protocol/ServerMessage";

import { Server } from "../src/swp/server.ts";
import { Bridge, type BridgeBot } from "../src/connections/matrix/bridge.ts";
import { EventMap } from "../src/connections/matrix/event_map.ts";
import type { MatrixEvent } from "../src/connections/matrix/events.ts";
import { ViewPrefs } from "../src/connections/matrix/prefs.ts";
import { RoomBindings } from "../src/connections/matrix/rooms.ts";
import type { MediaDownloadResult } from "../src/connections/matrix/bot.ts";

const ROOM = "!room:example.com";
const OTHER_ROOM = "!other:example.com";
const USER = "@human:example.com";

type Sent =
  | { kind: "text"; roomId: string; body: string }
  | { kind: "notice"; roomId: string; body: string }
  | { kind: "edit"; roomId: string; eventId: string; body: string }
  | { kind: "typing"; roomId: string; typing: boolean }
  | { kind: "image"; roomId: string; path: string; caption: string | undefined }
  | { kind: "redact"; roomId: string; eventId: string };

class FakeBot implements BridgeBot {
  readonly sent: Sent[] = [];
  readonly media = new Map<string, MediaDownloadResult>();
  readonly #queue: MatrixEvent[] = [];
  #wake: (() => void) | null = null;
  #closed = false;
  #nextEvent = 1;

  push(event: MatrixEvent): void {
    this.#queue.push(event);
    this.#wake?.();
  }

  close(): void {
    this.#closed = true;
    this.#wake?.();
  }

  async *events(): AsyncGenerator<MatrixEvent> {
    for (;;) {
      const next = this.#queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = null;
    }
  }

  #mint(): string {
    const id = `$sent${this.#nextEvent}`;
    this.#nextEvent += 1;
    return id;
  }

  sendText(roomId: string, body: string): Promise<string | undefined> {
    this.sent.push({ kind: "text", roomId, body });
    return Promise.resolve(this.#mint());
  }

  sendNotice(roomId: string, body: string): Promise<string | undefined> {
    this.sent.push({ kind: "notice", roomId, body });
    return Promise.resolve(this.#mint());
  }

  editText(roomId: string, eventId: string, body: string): Promise<boolean> {
    this.sent.push({ kind: "edit", roomId, eventId, body });
    return Promise.resolve(true);
  }

  redact(roomId: string, eventId: string): Promise<void> {
    this.sent.push({ kind: "redact", roomId, eventId });
    return Promise.resolve();
  }

  setTyping(roomId: string, typing: boolean): Promise<void> {
    this.sent.push({ kind: "typing", roomId, typing });
    return Promise.resolve();
  }

  sendImage(roomId: string, path: string, caption?: string): Promise<string | undefined> {
    this.sent.push({ kind: "image", roomId, path, caption });
    return Promise.resolve(this.#mint());
  }

  downloadMedia(url: string): Promise<MediaDownloadResult> {
    return Promise.resolve(this.media.get(url) ?? { ok: false, reason: "failed" });
  }

  notices(): string[] {
    return this.sent.filter((s) => s.kind === "notice").map((s) => s.body);
  }

  texts(): string[] {
    return this.sent.filter((s) => s.kind === "text").map((s) => s.body);
  }
}

interface Delivered {
  readonly character: string | null;
  readonly msg: ClientMessage;
}

interface BridgeHarness {
  bot: FakeBot;
  rooms: RoomBindings;
  events: EventMap;
  received: ClientMessage[];
  delivered: Delivered[];
  sessions: Map<string, number>;
  reply(msg: ServerMessage, character?: string): Promise<void>;
  broadcast(msg: ServerMessage): void;
  settle(): Promise<void>;
  stop(): Promise<void>;
}

const harnesses: BridgeHarness[] = [];

afterEach(async () => {
  for (const activeHarness of harnesses.splice(0)) await activeHarness.stop();
});

async function harness(
  options: {
    mirrorAll?: boolean;
    initialRoomId?: string;
    characters?: string[];
    bindings?: [roomId: string, character: string][];
  } = {},
): Promise<BridgeHarness> {
  const names = options.characters ?? ["ada", "bee"];
  const server = new Server({
    addr: "127.0.0.1:0",
    serverName: "shore-test",
    authenticate: () => true,
    handshake: {
      hello: () => Promise.resolve({ characters: names.map((name) => ({ name })) }),
      history: (selected) =>
        Promise.resolve({
          messages: [],
          previousSegment: null,
          config: {},
          selectedCharacter: selected,
          selectedThread: null,
          revision: 1,
        }),
    },
  });

  await server.bind();
  const running = server.serve();

  const received: ClientMessage[] = [];
  const delivered: Delivered[] = [];
  const sessions = new Map<string, number>();

  const routing = (async () => {
    for await (const routed of server.routes()) {
      if (routed.kind !== "command" && routed.kind !== "engine") continue;
      const msg = routed.kind === "command" ? ({ type: "command", ...routed.cmd } as ClientMessage) : routed.msg;
      received.push(msg);
      delivered.push({ character: routed.meta.session.selectedCharacter, msg });
    }
  })();

  const bot = new FakeBot();
  const rooms = new RoomBindings();
  for (const [roomId, character] of options.bindings ?? []) rooms.bind(roomId, character);
  const events = new EventMap();

  const bridge = new Bridge({
    bot,
    attach: async (character) => {
      const peer = await server.attachLocal({
        clientType: "bridge",
        clientName: `shore-matrix/${character}`,
        capabilities: ["streaming"],
        character,
      });
      sessions.set(character, peer.session.sessionId);
      return peer;
    },
    roster: async () => (await server.characters()).map((c) => c.name),
    rooms,
    events,
    prefs: new ViewPrefs(),
    mirrorAll: options.mirrorAll ?? true,
    ...(options.initialRoomId === undefined ? {} : { initialRoomId: options.initialRoomId }),
  });
  const pump = bridge.run();

  const settle = async () => {
    for (let i = 0; i < 8; i += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
    }
  };
  await settle();

  const built: BridgeHarness = {
    bot,
    rooms,
    events,
    received,
    delivered,
    sessions,
    reply: async (msg, character) => {
      const sessionId = sessions.get(character ?? (names[0] ?? ""));
      if (sessionId === undefined) throw new Error(`no session for ${character}`);
      await server.sessionRouter.sendToSession(sessionId, msg);
      await settle();
    },
    broadcast: (msg) => server.broadcast(msg),
    settle,
    stop: async () => {
      bot.close();
      await pump;
      server.stop();
      await Promise.allSettled([running, routing]);
    },
  };
  harnesses.push(built);
  return built;
}

function assistant(overrides: Partial<NewMessage> = {}): ServerMessage {
  const message: NewMessage = {
    revision: 2,
    character: "ada",
    msg_id: "m_reply",
    role: "assistant",
    content: "the reply",
    images: [],
    content_blocks: [],
    timestamp: "2026-08-08T00:00:00Z",
    origin: "assistant_reply",
  };
  return { type: "new_message", ...message, ...overrides };
}

describe("an unbound room", () => {
  test("says so instead of sending anything to the daemon", async () => {
    const h = await harness();
    h.bot.push({ kind: "message", roomId: ROOM, sender: USER, eventId: "$e1", text: "hello" });
    await h.settle();

    expect(h.bot.notices().join("\n")).toContain("not bound");
    expect(h.received.some((m) => m.type === "message")).toBe(false);
  });

  test("!bind lists the daemon's characters and then binds one", async () => {
    const h = await harness();
    h.bot.push({ kind: "message", roomId: ROOM, sender: USER, eventId: "$e1", text: "!bind" });
    await h.settle();
    expect(h.bot.notices().join("\n")).toContain("`ada`");
    expect(h.bot.notices().join("\n")).toContain("`bee`");

    h.bot.push({ kind: "message", roomId: ROOM, sender: USER, eventId: "$e2", text: "!bind nobody" });
    await h.settle();
    expect(h.bot.notices().at(-1)).toContain("No such character");

    h.bot.push({ kind: "message", roomId: ROOM, sender: USER, eventId: "$e3", text: "!bind ada" });
    await h.settle();
    expect(h.rooms.characterForRoom(ROOM)).toBe("ada");
  });
});

describe("the room named in config.toml", () => {
  test("binds itself when the daemon has exactly one character", async () => {
    const h = await harness({ initialRoomId: ROOM, characters: ["ada"] });
    expect(h.rooms.characterForRoom(ROOM)).toBe("ada");
    expect(h.bot.notices().at(-1)).toContain("bound to **ada**");
  });

  test("asks rather than guessing when there is more than one character", async () => {
    const h = await harness({ initialRoomId: ROOM });
    expect(h.rooms.characterForRoom(ROOM)).toBeUndefined();
    expect(h.bot.notices().at(-1)).toContain("!bind");
  });

  test("a binding that survived a restart is left alone", async () => {
    const h = await harness({
      initialRoomId: ROOM,
      characters: ["ada"],
      bindings: [[ROOM, "bee"]],
    });
    expect(h.rooms.characterForRoom(ROOM)).toBe("bee");
    expect(h.bot.notices()).toEqual([]);
  });
});

describe("a bound room forwards prompts", () => {
  test("a plain message reaches the daemon as a streaming message", async () => {
    const h = await harness({ bindings: [[ROOM, "ada"]] });
    h.bot.push({ kind: "message", roomId: ROOM, sender: USER, eventId: "$e1", text: "hello there" });
    await h.settle();

    const sent = h.received.find((m) => m.type === "message");
    expect(sent).toMatchObject({ type: "message", text: "hello there", stream: true });
  });

  test("a room bound to another character needs no switch, it has its own session", async () => {
    const h = await harness({ bindings: [[OTHER_ROOM, "bee"]] });
    h.bot.push({ kind: "message", roomId: OTHER_ROOM, sender: USER, eventId: "$e1", text: "hi bee" });
    await h.settle();

    expect(h.received.map((m) => m.type)).toEqual(["message"]);
    expect(h.delivered.at(-1)).toMatchObject({ character: "bee", msg: { text: "hi bee" } });
  });

  test("each bound room keeps its own session for the whole conversation", async () => {
    const h = await harness({ bindings: [[ROOM, "ada"], [OTHER_ROOM, "bee"]] });
    h.bot.push({ kind: "message", roomId: ROOM, sender: USER, eventId: "$a1", text: "one" });
    await h.settle();
    h.bot.push({ kind: "message", roomId: OTHER_ROOM, sender: USER, eventId: "$b1", text: "two" });
    await h.settle();
    h.bot.push({ kind: "message", roomId: ROOM, sender: USER, eventId: "$a2", text: "three" });
    await h.settle();

    expect(h.delivered.map((d) => d.character)).toEqual(["ada", "bee", "ada"]);
    expect(h.sessions.get("ada")).not.toBe(h.sessions.get("bee"));
  });

  test("an image travels as base64 with its declared mime type and no filename in the body", async () => {
    const h = await harness({ bindings: [[ROOM, "ada"]] });
    h.bot.media.set("mxc://example.com/pic", {
      ok: true,
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    h.bot.push({
      kind: "image",
      roomId: ROOM,
      sender: USER,
      eventId: "$e1",
      url: "mxc://example.com/pic",
      body: "shot.png",
      mimeType: "image/png",
    });
    await h.settle();

    const sent = h.received.find((m) => m.type === "message");
    expect(sent).toMatchObject({
      type: "message",
      text: "",
      image_data: [{ filename: "shot.png", data: "AQIDBA==", mime_type: "image/png" }],
    });
  });

  for (const [reason, notice] of [
    ["too_large", "5 MiB attachment limit"],
    ["timed_out", "timed out"],
    ["failed", "could not be downloaded"],
  ] as const) {
    test(`an image download rejected as ${reason} produces a useful notice`, async () => {
      const h = await harness({ bindings: [[ROOM, "ada"]] });
      h.bot.media.set("mxc://example.com/pic", { ok: false, reason });
      h.bot.push({
        kind: "image",
        roomId: ROOM,
        sender: USER,
        eventId: "$e1",
        url: "mxc://example.com/pic",
        body: "shot.png",
        mimeType: "image/png",
      });
      await h.settle();

      expect(h.bot.notices().at(-1)).toContain(notice);
      expect(h.received.some((message) => message.type === "message")).toBe(false);
    });
  }
});

describe("replies coming back", () => {
  test("an assistant reply lands in the bound room and is remembered", async () => {
    const h = await harness({ bindings: [[ROOM, "ada"]] });
    h.broadcast(assistant());
    await h.settle();

    expect(h.bot.texts()).toEqual(["the reply"]);
    expect(h.events.byMsgId("m_reply")?.roomId).toBe(ROOM);
  });

  test("a reply for an unbound character goes nowhere rather than to the wrong room", async () => {
    const h = await harness({ bindings: [[ROOM, "ada"]] });
    h.broadcast(assistant({ character: "bee", msg_id: "m_bee" }));
    await h.settle();

    expect(h.bot.texts()).toEqual([]);
  });

  test("a regenerated reply edits the previous message in place", async () => {
    const h = await harness({ bindings: [[ROOM, "ada"]] });
    h.broadcast(assistant());
    await h.settle();

    h.broadcast(assistant({ msg_id: "m_regen", content: "a better reply", alt_count: 2 }));
    await h.settle();

    const edits = h.bot.sent.filter((s) => s.kind === "edit");
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ roomId: ROOM, body: "a better reply" });
    expect(h.bot.texts()).toEqual(["the reply"]);
  });

  test("streaming turns the typing indicator on and off in the room being answered", async () => {
    const h = await harness({ bindings: [[ROOM, "ada"]] });
    h.bot.push({ kind: "message", roomId: ROOM, sender: USER, eventId: "$e1", text: "hello" });
    await h.settle();

    h.broadcast({ type: "stream_start", regen: false });
    await h.settle();
    h.broadcast({
      type: "stream_end",
      content: "the reply",
      is_final: true,
      metadata: {
        tokens: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
        timing: { total_ms: 1, ttft_ms: 1 },
        model: "test",
      },
    });
    await h.settle();

    expect(h.bot.sent.filter((s) => s.kind === "typing")).toEqual([
      { kind: "typing", roomId: ROOM, typing: true },
      { kind: "typing", roomId: ROOM, typing: false },
    ]);
  });

  test("thinking is attached only when the room asked for it", async () => {
    const h = await harness({ bindings: [[ROOM, "ada"]] });
    const withThinking = assistant({
      content_blocks: [
        { type: "thinking", thinking: "let me consider" },
        { type: "text", text: "the reply" },
      ],
    });

    h.broadcast(withThinking);
    await h.settle();
    expect(h.bot.texts().at(-1)).toBe("the reply");

    h.bot.push({ kind: "message", roomId: ROOM, sender: USER, eventId: "$v", text: "!view thinking on" });
    await h.settle();
    h.broadcast(assistant({ ...withThinking, msg_id: "m2" }));
    await h.settle();
    expect(h.bot.texts().at(-1)).toBe("> let me consider\n\nthe reply");
  });
});

describe("mirroring other clients", () => {
  test("a prompt from the CLI is blockquoted into the character's room", async () => {
    const h = await harness({ bindings: [[ROOM, "ada"]] });
    h.broadcast(
      assistant({ msg_id: "m_user", role: "user", origin: "user_input", content: "from the cli" }),
    );
    await h.settle();

    expect(h.bot.notices().at(-1)).toBe("> \u{1F464} from the cli");
    expect(h.events.byMsgId("m_user")?.origin).toBe("mirrored_user");
  });

  test("with mirror_all off, another client's prompt stays out of the room", async () => {
    const h = await harness({ mirrorAll: false, bindings: [[ROOM, "ada"]] });
    h.broadcast(
      assistant({ msg_id: "m_user", role: "user", origin: "user_input", content: "from the cli" }),
    );
    await h.settle();

    expect(h.bot.notices()).toEqual([]);
  });

  test("the bridge's own prompt is not mirrored back, but is mapped to its Matrix event", async () => {
    const h = await harness({ bindings: [[ROOM, "ada"]] });
    h.bot.push({ kind: "message", roomId: ROOM, sender: USER, eventId: "$mine", text: "hello there" });
    await h.settle();

    h.broadcast(
      assistant({ msg_id: "m_mine", role: "user", origin: "user_input", content: "hello there" }),
    );
    await h.settle();

    expect(h.bot.notices()).toEqual([]);
    expect(h.events.byMsgId("m_mine")).toMatchObject({ eventId: "$mine", origin: "matrix_user" });
  });
});

describe("Matrix-native interactions", () => {
  test("an edit becomes an edit command against the mapped message", async () => {
    const h = await harness({ bindings: [[ROOM, "ada"]] });
    h.broadcast(assistant());
    await h.settle();
    const eventId = h.events.byMsgId("m_reply")?.eventId as string;

    h.bot.push({
      kind: "edit",
      roomId: ROOM,
      sender: USER,
      targetEventId: eventId,
      newText: "corrected",
    });
    await h.settle();

    expect(h.received.at(-1)).toMatchObject({
      type: "command",
      name: "edit",
      args: { ref: "m_reply", content: "corrected" },
    });
  });

  test("an edit to an unmapped event says so and sends nothing", async () => {
    const h = await harness({ bindings: [[ROOM, "ada"]] });
    h.bot.push({
      kind: "edit",
      roomId: ROOM,
      sender: USER,
      targetEventId: "$unknown",
      newText: "corrected",
    });
    await h.settle();

    expect(h.bot.notices().at(-1)).toContain("no longer tracked");
    expect(h.received.some((m) => m.type === "command")).toBe(false);
  });

  test("a redaction becomes a delete command and forgets the mapping", async () => {
    const h = await harness({ bindings: [[ROOM, "ada"]] });
    h.broadcast(assistant());
    await h.settle();
    const eventId = h.events.byMsgId("m_reply")?.eventId as string;

    h.bot.push({ kind: "redaction", roomId: ROOM, sender: USER, redacts: eventId });
    await h.settle();

    expect(h.received.at(-1)).toMatchObject({
      type: "command",
      name: "delete",
      args: { refs: ["m_reply"] },
    });
    expect(h.events.byEventId(eventId)).toBeUndefined();
  });

  test("🔁 on the latest reply regenerates; on an older one it refuses", async () => {
    const h = await harness({ bindings: [[ROOM, "ada"]] });
    h.broadcast(assistant({ msg_id: "m1" }));
    await h.settle();
    const older = h.events.byMsgId("m1")?.eventId as string;
    h.broadcast(assistant({ msg_id: "m2" }));
    await h.settle();
    const latest = h.events.byMsgId("m2")?.eventId as string;

    h.bot.push({ kind: "reaction", roomId: ROOM, sender: USER, targetEventId: older, key: "🔁" });
    await h.settle();
    expect(h.bot.notices().at(-1)).toContain("most recent reply");
    expect(h.received.some((m) => m.type === "regen")).toBe(false);

    h.bot.push({ kind: "reaction", roomId: ROOM, sender: USER, targetEventId: latest, key: "🔁" });
    await h.settle();
    expect(h.received.at(-1)).toMatchObject({ type: "regen", stream: true });
  });

  test("🗑 deletes daemon-side and redacts the Matrix copy", async () => {
    const h = await harness({ bindings: [[ROOM, "ada"]] });
    h.broadcast(assistant());
    await h.settle();
    const eventId = h.events.byMsgId("m_reply")?.eventId as string;

    h.bot.push({ kind: "reaction", roomId: ROOM, sender: USER, targetEventId: eventId, key: "🗑" });
    await h.settle();

    expect(h.received.at(-1)).toMatchObject({ name: "delete", args: { refs: ["m_reply"] } });
    expect(h.bot.sent.filter((s) => s.kind === "redact")).toHaveLength(1);
  });

  test("◀ and ▶ walk the alternates", async () => {
    const h = await harness({ bindings: [[ROOM, "ada"]] });
    h.broadcast(assistant());
    await h.settle();
    const eventId = h.events.byMsgId("m_reply")?.eventId as string;

    h.bot.push({ kind: "reaction", roomId: ROOM, sender: USER, targetEventId: eventId, key: "◀️" });
    await h.settle();
    expect(h.received.at(-1)).toMatchObject({
      name: "alt",
      args: { ref: "m_reply", direction: "prev" },
    });

    h.bot.push({ kind: "reaction", roomId: ROOM, sender: USER, targetEventId: eventId, key: "▶️" });
    await h.settle();
    expect(h.received.at(-1)).toMatchObject({ args: { direction: "next" } });
  });

  test("an unmapped reaction is ignored entirely", async () => {
    const h = await harness({ bindings: [[ROOM, "ada"]] });
    h.bot.push({ kind: "reaction", roomId: ROOM, sender: USER, targetEventId: "$nope", key: "👍" });
    await h.settle();
    expect(h.received.some((m) => m.type === "command")).toBe(false);
  });
});

describe("two rooms generating at once", () => {
  test("typing, errors, warnings and replies each stay in the room that asked", async () => {
    const h = await harness({ bindings: [[ROOM, "ada"], [OTHER_ROOM, "bee"]] });

    h.bot.push({ kind: "message", roomId: ROOM, sender: USER, eventId: "$a1", text: "ada first" });
    await h.settle();
    h.bot.push({ kind: "message", roomId: OTHER_ROOM, sender: USER, eventId: "$b1", text: "bee next" });
    await h.settle();

    await h.reply({ type: "stream_start", regen: false }, "ada");
    await h.reply({ type: "stream_start", regen: false }, "bee");
    expect(h.bot.sent.filter((sent) => sent.kind === "typing")).toEqual([
      { kind: "typing", roomId: ROOM, typing: true },
      { kind: "typing", roomId: OTHER_ROOM, typing: true },
    ]);

    await h.reply({ type: "error", code: "provider_error", message: "ada broke" }, "ada");
    await h.reply(
      {
        type: "usage_warning",
        budget: "daily",
        message: "80% of daily budget",
        current_cost: 8,
        cost_limit: 10,
        percent_used: 0.8,
        crossed_warn_at: [0.8],
        period: "day",
        period_start: "2026-08-08T00:00:00Z",
        reset_at: "2026-08-09T00:00:00Z",
        reset_at_display: "2026-08-09 12:00 AM",
      },
      "bee",
    );
    expect(h.bot.sent.filter((sent) => sent.kind === "notice")).toEqual([
      { kind: "notice", roomId: ROOM, body: "provider_error: ada broke" },
      {
        kind: "notice",
        roomId: OTHER_ROOM,
        body: "⚠️ 80% of daily budget — $8.00 of $10.00 (80%) this day",
      },
    ]);

    h.broadcast(assistant({ character: "bee", msg_id: "m_bee", content: "bee replies" }));
    await h.settle();
    h.broadcast(assistant({ msg_id: "m_ada", content: "ada replies" }));
    await h.settle();
    expect(h.bot.sent.filter((sent) => sent.kind === "text")).toEqual([
      { kind: "text", roomId: OTHER_ROOM, body: "bee replies" },
      { kind: "text", roomId: ROOM, body: "ada replies" },
    ]);
  });

  test("a cancel reaches only the session of the room it was typed in", async () => {
    const h = await harness({ bindings: [[ROOM, "ada"], [OTHER_ROOM, "bee"]] });

    h.bot.push({ kind: "message", roomId: ROOM, sender: USER, eventId: "$a1", text: "ada first" });
    await h.settle();
    h.bot.push({ kind: "message", roomId: OTHER_ROOM, sender: USER, eventId: "$b1", text: "bee next" });
    await h.settle();
    h.bot.push({ kind: "message", roomId: ROOM, sender: USER, eventId: "$a2", text: "!cancel" });
    await h.settle();

    expect(h.delivered.at(-1)).toMatchObject({ character: "ada", msg: { type: "cancel" } });
  });
});

describe("command output", () => {
  test("a bang command's output is rendered back into the room that asked", async () => {
    const h = await harness({ bindings: [[ROOM, "ada"]] });
    h.bot.push({ kind: "message", roomId: ROOM, sender: USER, eventId: "$e1", text: "!status" });
    await h.settle();

    const sent = h.received.find((m) => m.type === "command" && m.name === "status");
    expect(sent).toBeDefined();

    await h.reply({
      type: "command_output",
      rid: (sent as { rid?: string }).rid ?? null,
      name: "status",
      data: { character: "ada", turn_count: 3 },
    });

    expect(h.bot.notices().at(-1)).toContain("**ada** — status");
    expect(h.bot.notices().at(-1)).toContain("turns: 3");
  });

  test("a daemon error for a silent command surfaces as a warning, not a JSON dump", async () => {
    const h = await harness({ bindings: [[ROOM, "ada"]] });
    h.broadcast(assistant());
    await h.settle();
    const eventId = h.events.byMsgId("m_reply")?.eventId as string;

    h.bot.push({ kind: "redaction", roomId: ROOM, sender: USER, redacts: eventId });
    await h.settle();
    const sent = h.received.at(-1) as { rid?: string };

    await h.reply({
      type: "error",
      rid: sent.rid ?? null,
      code: "not_found",
      message: "Message not found: m_reply",
    });

    expect(h.bot.notices().at(-1)).toBe("⚠️ Message not found: m_reply");
  });
});
