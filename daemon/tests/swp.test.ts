import { describe, expect, test, afterEach } from "bun:test";
import { type ClientMessage } from "../src/protocol/ClientMessage";
import { decodeClientMessage, rustTrim, WireError } from "../src/swp/framing";
import { type ServerMessage } from "../src/protocol/ServerMessage";
import { type RoutedMessage } from "../src/swp/session";
import { Server } from "../src/swp/server.ts";
import { eventMatchesSession } from "../src/swp/routing.ts";
import { MAX_MARK_TAGS } from "../src/swp/limits.ts";
import { MAX_TOTAL_ATTACHMENT_BYTES, AdmissionError, admitCapabilities, admitClientMessage, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_CAPABILITIES } from "../src/swp/admission.ts";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(characters: string[] = ["ada", "bee"]) {
  const server = new Server({
    handshake: {
      hello: () => Promise.resolve({ characters: characters.map((name) => ({ name })) }),
      select: (character) => Promise.resolve({ character, thread: null }),
      history: (selected) =>
        Promise.resolve({
          messages: [],
          previousSegment: null,
          config: { active_model: "test:model" },
          selectedCharacter: selected,
          selectedThread: null,
          revision: 3,
        }),
    },
  });

  const routed: RoutedMessage[] = [];
  const routing = (async () => {
    for await (const message of server.routes()) if (message.kind !== "session_connected") routed.push(message);
  })();

  cleanups.push(async () => {
    server.stop();
    await routing;
  });

  return { server, routed };
}

describe("what the peer sends", () => {

  test("a connector cannot bypass aggregate attachment admission", async () => {
    const { server, routed } = await fixture();
    const peer = await server.attachLocal({ clientType: "bridge", clientName: "shore-matrix" });
    const events = peer.events();
    await events.next();
    const data = Buffer.alloc(MAX_TOTAL_ATTACHMENT_BYTES / 4).toString("base64");

    await peer.send({
      type: "message",
      text: "",
      stream: true,
      images: [],
      image_data: Array.from({ length: 5 }, (_, i) => ({
        filename: `${String(i)}.png`,
        data,
      })),
    });

    const rejection = await events.next();
    if (rejection.done || rejection.value.type !== "error") throw new Error("expected an error frame");
    expect(rejection.value).toMatchObject({ type: "error", code: "invalid_request" });
    expect(rejection.value.message).toContain("total");
    expect(routed).toHaveLength(0);
  });
});

const upload = (filename: string, data: string) => ({ filename, data, mime_type: "image/png" });

const message = <T,>(imageData: T[] = []) => ({
  type: "message" as const,
  text: "hello",
  stream: true,
  images: [],
  image_data: imageData,
});

describe("what a client may send", () => {
  const over = (limit: number) => "é".repeat(Math.floor(limit / 2) + 1);
  const at = (limit: number) => "x".repeat(limit);
  const hello = (capability: string) => ({ type: "hello", client_type: "tui", client_name: "t", capabilities: [capability] });
  const regen = (reason: string) => ({ type: "regen", stream: true, reason });
  const oldRegen = (guidance: string) => ({ type: "regen", stream: true, guidance });
  const tagged = (tag: string) => ({ type: "regen", stream: true, tags: [tag] });
  const withText = (text: string) => ({ ...message(), text });
  const withImage = (path: string) => ({ ...message(), images: [path] });
  const withFile = (filename: string) => message([upload(filename, "AQIDBA==")]);
  const withMime = (mime_type: string) => message([{ ...upload("a.png", "AQIDBA=="), mime_type }]);

  test.each([
    ["message text", withText, 1024 * 1024],
    ["image path", withImage, 4096],
    ["capability", hello, 128],
    ["regeneration reason", regen, 1024 * 1024],
    ["regeneration guidance from an older client", oldRegen, 1024 * 1024],
    ["regeneration tag", tagged, 256],
    ["attachment filename", withFile, 255],
    ["attachment mime type", withMime, 255],
  ] as const)("%s is held to its byte limit, counted in bytes", (_name, build, limit) => {
    expect(() => admitClientMessage(build(at(limit)))).not.toThrow();
    expect(() => admitClientMessage(build(over(limit)))).toThrow(AdmissionError);
  });

  test("a message type the daemon does not know is refused", () => {
    expect(() => admitClientMessage({ type: "shell", command: "rm -rf /" })).toThrow("Unknown client message type");
  });

  test("optional fields stay absent rather than arriving as something else", () => {
    expect(admitClientMessage({ type: "regen", stream: false })).toEqual({ type: "regen", stream: false });
    expect(admitClientMessage({ type: "regen", stream: false, reason: "shorter", tags: ["too long"], another_take: false })).toEqual({ type: "regen", stream: false, reason: "shorter", tags: ["too long"], another_take: false });
    expect(admitClientMessage({ type: "regen", stream: false, guidance: "shorter" }), "an older client's guidance is the reason").toEqual({ type: "regen", stream: false, reason: "shorter" });
    expect(admitClientMessage({ type: "command", name: "status" })).toEqual({ type: "command", name: "status", args: null });
    expect(admitClientMessage({ type: "command", name: "log", args: { turns: 2 } })).toEqual({ type: "command", name: "log", args: { turns: 2 } });
  });
});

describe("which events a session receives", () => {
  const history = (character: string, thread: string | null) => ({ type: "history", selected_character: character, selected_thread: thread, messages: [], revision: 1 }) as unknown as ServerMessage;
  const newMessage = (character: string, thread?: string) => ({ type: "new_message", character, ...(thread === undefined ? {} : { thread }), message: {} }) as unknown as ServerMessage;
  const status = { type: "command_output", name: "status", success: true, data: null } as unknown as ServerMessage;

  test("a conversation reaches only the sessions viewing that character and thread", () => {
    expect(eventMatchesSession(history("ada", "main"), "ada", true, false, "main")).toBe(true);
    expect(eventMatchesSession(history("ada", "main"), "bea", true, false, "main")).toBe(false);
    expect(eventMatchesSession(history("ada", "side"), "ada", true, false, "main")).toBe(false);
    expect(eventMatchesSession(history("ada", null), "ada", true, false, "main")).toBe(true);
    expect(eventMatchesSession(history("ada", "side"), "ada", true, false, null)).toBe(true);
    expect(eventMatchesSession(newMessage("ada"), "ada", true, false, "main")).toBe(true);
    expect(eventMatchesSession(newMessage("ada"), "ada", true, false, "side")).toBe(false);
    expect(eventMatchesSession(newMessage("ada", "side"), "ada", true, false, "side")).toBe(true);
    expect(eventMatchesSession(newMessage("bea", "main"), "ada", true, false, "main")).toBe(false);
  });

  test("a thread's unread count reaches every registered session, whatever character or thread it is on", () => {
    const unread = (character: string) => ({ type: "thread_unread", character, thread: "side", unread: 1 }) as unknown as ServerMessage;
    expect(eventMatchesSession(unread("ada"), "ada", true, false, "main")).toBe(true);
    expect(eventMatchesSession(unread("bea"), "ada", true, false, "main")).toBe(true);
    expect(eventMatchesSession(unread("bea"), null, true)).toBe(true);
    expect(eventMatchesSession(unread("bea"), "ada", false)).toBe(false);
  });

  test("an unregistered or characterless session hears only what everyone hears", () => {
    expect(eventMatchesSession({ type: "ping" }, null, false)).toBe(true);
    expect(eventMatchesSession(newMessage("ada"), "ada", false)).toBe(false);
    expect(eventMatchesSession(newMessage("ada"), null, true)).toBe(false);
    expect(eventMatchesSession(status, null, true)).toBe(false);
    expect(eventMatchesSession(status, "ada", true)).toBe(true);
    expect(eventMatchesSession(newMessage("bea"), null, true, true)).toBe(true);
    expect(eventMatchesSession({ type: "request_finished", rid: "r", outcome: "completed" } as unknown as ServerMessage, "ada", true, true)).toBe(false);
  });
});

describe("client request admission", () => {
  test("accepts and preserves a well-formed attachment", () => {
    expect(admitClientMessage(message([upload("shot.png", "AQIDBA==")]))).toEqual(
      message([upload("shot.png", "AQIDBA==")]),
    );
  });

  test("checks attachment objects even when a connector constructed the typed value", () => {
    expect(() => admitClientMessage(message([null]))).toThrow(AdmissionError);
    expect(() => admitClientMessage(message([{ filename: "x.png", data: 42 }]))).toThrow(
      /data.*is not a string/,
    );
    expect(() => admitClientMessage(message([upload("x.png", "not base64")]))).toThrow(
      /not valid base64/,
    );
    expect(() => admitClientMessage({ ...message(), image_data: "x.png" })).toThrow(AdmissionError);
    expect(() => admitClientMessage(message([upload("", "AQIDBA==")]))).toThrow(/empty filename/);
    expect(() => admitClientMessage(message([upload("x", "AQIDBA==")]))).not.toThrow();
  });

  test("a refused attachment is named by its place in the list, counting from one", () => {
    const fine = upload("a.png", "AQIDBA==");
    expect(() => admitClientMessage(message([fine, null]))).toThrow("Attachment 2 is not an object");
    expect(() => admitClientMessage(message([fine, upload("é".repeat(128), "AQIDBA==")]))).toThrow(/^Attachment 2 filename /);
    expect(() => admitClientMessage(message([fine, fine, upload("", "AQIDBA==")]))).toThrow("Attachment 3 has an empty filename");
  });

  test("caps attachment and capability counts", () => {
    expect(() =>
      admitClientMessage(message(Array.from({ length: MAX_ATTACHMENTS }, (_, i) => upload(`${String(i)}.png`, "")))),
    ).not.toThrow();
    expect(() =>
      admitClientMessage(
        message(Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => upload(`${String(i)}.png`, ""))),
      ),
    ).toThrow(/maximum/);
    expect(() =>
      admitCapabilities(Array.from({ length: MAX_CAPABILITIES + 1 }, () => "streaming")),
    ).toThrow(/maximum/);
    expect(() => admitClientMessage({ type: "regen", stream: true, tags: Array.from({ length: MAX_MARK_TAGS }, (_, i) => String(i)) })).not.toThrow();
    expect(() => admitClientMessage({ type: "regen", stream: true, tags: Array.from({ length: MAX_MARK_TAGS + 1 }, (_, i) => String(i)) })).toThrow(/maximum/);
  });

  test("caps each decoded attachment rather than trusting base64 length vaguely", () => {
    const exact = Buffer.alloc(MAX_ATTACHMENT_BYTES).toString("base64");
    const over = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64");

    expect(() => admitClientMessage(message([upload("exact.png", exact)]))).not.toThrow();
    expect(() => admitClientMessage(message([upload("over.png", over)]))).toThrow(
      new RegExp(`maximum is ${String(MAX_ATTACHMENT_BYTES)}`),
    );
  });

  test("caps aggregate decoded bytes across otherwise valid attachments", () => {
    const eachBytes = MAX_TOTAL_ATTACHMENT_BYTES / 4;
    const data = Buffer.alloc(eachBytes).toString("base64");
    const four = Array.from({ length: 4 }, (_, i) => upload(`${String(i)}.png`, data));

    expect(() => admitClientMessage(message(four))).not.toThrow();
    expect(() => admitClientMessage(message([...four, upload("extra.png", "AAAA")]))).toThrow(
      /Attachments total/,
    );
  });
});

describe("wire array decoding", () => {
  const decode = (value: unknown): ClientMessage => decodeClientMessage(value);

  for (const [label, value] of [
    ["non-array images", { ...message(), images: "shot.png" }],
    ["non-string image path", { ...message(), images: [42] }],
    ["non-boolean stream flag", { ...message(), stream: "yes" }],
    ["non-object upload", message(["base64"])],
    ["missing upload data", message([{ filename: "shot.png" }])],
    ["non-string MIME type", message([{ filename: "shot.png", data: "AAAA", mime_type: 42 }])],
    ["non-string capability", { type: "hello", client_type: "tui", client_name: "t", capabilities: [42] }],
    ["non-string regeneration tag", { type: "regen", stream: true, tags: [42] }],
    ["non-boolean another take", { type: "regen", stream: true, another_take: "yes" }],
  ] as const) {
    test(`rejects ${label}`, () => {
      expect(() => decode(value)).toThrow(WireError);
    });
  }

  test("a regeneration keeps what it was given and nothing it wasn't, and an older client's guidance is its reason", () => {
    expect(decode({ type: "regen", stream: true })).toEqual({ type: "regen", stream: true });
    expect(decode({ type: "regen", stream: true, another_take: true, reason: "shorter", tags: ["too long"] }))
      .toEqual({ type: "regen", stream: true, another_take: true, reason: "shorter", tags: ["too long"] });
    expect(decode({ type: "regen", stream: false, guidance: "warmer" })).toEqual({ type: "regen", stream: false, reason: "warmer" });
  });

  test("a message keeps its fields and fills its defaults, and fields the daemon doesn't know are ignored", () => {
    expect(decode({ type: "message", rid: "r1", text: "hi", stream: true })).toEqual({ type: "message", rid: "r1", text: "hi", stream: true, images: [], image_data: [] });
    expect(decode({ type: "cancel", extra: 1 })).toEqual({ type: "cancel" });
    expect(decode({ type: "command", rid: "r2", name: "status" })).toEqual({ type: "command", rid: "r2", name: "status", args: null });
  });

  test("anything but an object naming a known message type is refused, and says why", () => {
    expect(() => decode([])).toThrow("Frame is not a JSON object");
    expect(() => decode(null)).toThrow("Frame is not a JSON object");
    expect(() => decode({ type: "nope" })).toThrow('Unknown client message type "nope"');
    expect(() => decode({ type: "message", stream: true })).toThrow('Frame is missing required field "text"');
    expect(() => decode({ type: "message", text: 1, stream: true })).toThrow('Frame field "text" is not a string');
    expect(() => decode({ type: "message", text: "", stream: true, absence_seconds: "1" })).toThrow('Frame field "absence_seconds" is not a number');
  });

  test("text around a frame is trimmed the way the Rust client trims it", () => {
    expect(rustTrim("\u00A0 {\"type\":\"cancel\"}\r\n")).toBe('{"type":"cancel"}');
    expect(rustTrim("a b")).toBe("a b");
  });
});
