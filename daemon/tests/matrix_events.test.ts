import { describe, expect, test } from "bun:test";

import { renderMarkdown } from "../src/connections/matrix/bot.ts";
import { normalizeEvent, sanitizeFilename, type RawEvent } from "../src/connections/matrix/events.ts";

const ROOM = "!room:example.com";
const SELF = "@shore:example.com";
const USER = "@human:example.com";

const normalize = (raw: RawEvent) => normalizeEvent(raw, ROOM, SELF);

describe("what the bridge listens to", () => {
  test("a text message becomes a prompt", () => {
    expect(
      normalize({
        type: "m.room.message",
        event_id: "$e1",
        sender: USER,
        content: { msgtype: "m.text", body: "hello there" },
      }),
    ).toEqual({
      kind: "message",
      roomId: ROOM,
      sender: USER,
      eventId: "$e1",
      text: "hello there",
    });
  });

  test("the bot's own messages are never fed back", () => {
    expect(
      normalize({
        type: "m.room.message",
        event_id: "$e1",
        sender: SELF,
        content: { msgtype: "m.text", body: "my own reply" },
      }),
    ).toBeUndefined();
  });

  test("an image carries its mxc url and its declared mime type, not a filename", () => {
    expect(
      normalize({
        type: "m.room.message",
        event_id: "$e2",
        sender: USER,
        content: {
          msgtype: "m.image",
          body: "screenshot",
          url: "mxc://example.com/abc123",
          info: { mimetype: "image/png", size: 4096 },
        },
      }),
    ).toEqual({
      kind: "image",
      roomId: ROOM,
      sender: USER,
      eventId: "$e2",
      url: "mxc://example.com/abc123",
      body: "screenshot",
      mimeType: "image/png",
    });
  });

  test("an image with no info still resolves, with no mime type", () => {
    expect(
      normalize({
        type: "m.room.message",
        event_id: "$e2",
        sender: USER,
        content: { msgtype: "m.image", body: "pic", url: "mxc://example.com/x" },
      }),
    ).toMatchObject({ kind: "image", mimeType: undefined });
  });

  test("an encrypted image with no plain url is skipped rather than half-forwarded", () => {
    expect(
      normalize({
        type: "m.room.message",
        event_id: "$e2",
        sender: USER,
        content: { msgtype: "m.image", body: "pic", file: { url: "mxc://example.com/x" } },
      }),
    ).toBeUndefined();
  });

  test("message types the bridge does not handle are ignored", () => {
    for (const msgtype of ["m.audio", "m.file", "m.video", "m.emote"]) {
      expect(
        normalize({
          type: "m.room.message",
          event_id: "$e3",
          sender: USER,
          content: { msgtype, body: "something" },
        }),
      ).toBeUndefined();
    }
  });
});

describe("edits", () => {
  test("an m.replace becomes an edit carrying the new body, not the * fallback", () => {
    expect(
      normalize({
        type: "m.room.message",
        event_id: "$e4",
        sender: USER,
        content: {
          msgtype: "m.text",
          body: "* the corrected text",
          "m.new_content": { msgtype: "m.text", body: "the corrected text" },
          "m.relates_to": { rel_type: "m.replace", event_id: "$original" },
        },
      }),
    ).toEqual({
      kind: "edit",
      roomId: ROOM,
      sender: USER,
      targetEventId: "$original",
      newText: "the corrected text",
    });
  });

  test("an edit whose replacement is not text is dropped, never sent as a prompt", () => {
    expect(
      normalize({
        type: "m.room.message",
        event_id: "$e4",
        sender: USER,
        content: {
          msgtype: "m.text",
          body: "* caption",
          "m.new_content": { msgtype: "m.image", body: "caption" },
          "m.relates_to": { rel_type: "m.replace", event_id: "$original" },
        },
      }),
    ).toBeUndefined();
  });

  test("a reply relation is not an edit — it is an ordinary message", () => {
    expect(
      normalize({
        type: "m.room.message",
        event_id: "$e5",
        sender: USER,
        content: {
          msgtype: "m.text",
          body: "answering you",
          "m.relates_to": { "m.in_reply_to": { event_id: "$original" } },
        },
      }),
    ).toMatchObject({ kind: "message", text: "answering you" });
  });
});

describe("redactions", () => {
  test("redacts at the top level, as room versions up to 10 send it", () => {
    expect(
      normalize({ type: "m.room.redaction", event_id: "$r1", sender: USER, redacts: "$gone" }),
    ).toEqual({ kind: "redaction", roomId: ROOM, sender: USER, redacts: "$gone" });
  });

  test("redacts inside content, as room version 11 sends it", () => {
    expect(
      normalize({
        type: "m.room.redaction",
        event_id: "$r1",
        sender: USER,
        content: { redacts: "$gone" },
      }),
    ).toEqual({ kind: "redaction", roomId: ROOM, sender: USER, redacts: "$gone" });
  });

  test("the bridge's own redactions are not looped back into a second delete", () => {
    expect(
      normalize({ type: "m.room.redaction", event_id: "$r1", sender: SELF, redacts: "$gone" }),
    ).toBeUndefined();
  });

  test("a redaction naming nothing is ignored", () => {
    expect(
      normalize({ type: "m.room.redaction", event_id: "$r1", sender: USER, content: {} }),
    ).toBeUndefined();
  });
});

describe("reactions", () => {
  test("a reaction carries its target and its key", () => {
    expect(
      normalize({
        type: "m.reaction",
        event_id: "$x1",
        sender: USER,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$reply", key: "🔁" } },
      }),
    ).toEqual({
      kind: "reaction",
      roomId: ROOM,
      sender: USER,
      targetEventId: "$reply",
      key: "🔁",
    });
  });

  test("a malformed reaction is ignored", () => {
    expect(
      normalize({ type: "m.reaction", event_id: "$x1", sender: USER, content: {} }),
    ).toBeUndefined();
  });
});

describe("filenames from remote input", () => {
  test("path separators and traversal are reduced to one component", () => {
    expect(sanitizeFilename("photo.png")).toBe("photo.png");
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("a\\b\\c.png")).toBe("c.png");
    expect(sanitizeFilename("")).toBe("image");
    expect(sanitizeFilename("..")).toBe("image");
    expect(sanitizeFilename("   ")).toBe("image");
  });
});

describe("markdown to a Matrix formatted body", () => {
  test("emphasis, code and code fences survive; html is escaped first", () => {
    expect(renderMarkdown("**bold**")).toBe("<strong>bold</strong>");
    expect(renderMarkdown("`code`")).toBe("<code>code</code>");
    expect(renderMarkdown("_quiet_")).toBe("<em>quiet</em>");
    expect(renderMarkdown("a\nb")).toBe("a<br/>b");
    expect(renderMarkdown("```\nx = 1\n```")).toBe("<pre><code>x = 1</code></pre>");
  });

  test("a raw tag from the model cannot inject markup", () => {
    expect(renderMarkdown('<img src=x onerror="alert(1)">')).not.toContain("<img");
    expect(renderMarkdown("<script>")).toBe("&lt;script&gt;");
  });
});
