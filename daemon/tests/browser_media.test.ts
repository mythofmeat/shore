import { describe, expect, test } from "bun:test";

import { conversationImages, reconcileImages, retainLiveImages, type LiveImage } from "../src/browser/media.ts";
import { liveTurn } from "../src/browser/workspace.ts";
import type { ContentBlock } from "../src/protocol/ContentBlock.ts";
import type { ImageRef } from "../src/protocol/ImageRef.ts";
import type { Message } from "../src/protocol/Message.ts";

function message(msgId: string, blocks: ContentBlock[] = [], images: ImageRef[] = []): Message {
  return { msg_id: msgId, role: "assistant", content: "", images, content_blocks: blocks, timestamp: "2026-11-10T00:00:00Z" };
}

const picture = (data: string): ContentBlock => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
const result = (toolUseId: string, content: Extract<ContentBlock, { type: "tool_result" }>["content"], isError?: boolean): ContentBlock =>
  ({ type: "tool_result", tool_use_id: toolUseId, content, ...(isError === undefined ? {} : { is_error: isError }) });

describe("live pictures kept while a reply streams", () => {
  test("are the newest that fit the count and the size, each counting its text plus a fixed overhead", () => {
    const many = Array.from({ length: 129 }, (_, index): LiveImage => ({ path: `p${String(index)}` }));
    const counted = retainLiveImages(many);
    expect(counted.items).toHaveLength(128);
    expect(counted.items[0]?.path).toBe("p1");
    expect(counted.limited).toBe(true);
    expect(retainLiveImages(many.slice(1)).limited).toBe(false);

    const fill = (extra: number): LiveImage => ({ path: "p", manual: true, data: "d".repeat(16 * 1024 * 1024 - 256 - 1 + extra) });
    expect(retainLiveImages([fill(0)]).items).toHaveLength(1);
    expect(retainLiveImages([fill(1)]).items, "one character over, counting only text fields").toHaveLength(0);
    expect(retainLiveImages([{ path: "a", data: "b" }, fill(-2)]).items).toHaveLength(1);
  });
});

describe("the conversation's picture gallery", () => {
  test("lists attached pictures with their best caption, sent ones with their full size, then inline and live ones", () => {
    const messages = [
      message("m_1", [picture("inline-a"), { type: "text", text: "x" }, result("t_1", [picture("nested"), { type: "text", text: "y" }]), result("t_2", "text only")], [
        { path: "/data/media/ada/sent/abc.png", embed: "![[lamp.png]]", name: "lamp.png", data: "lamp-data" },
        { path: "", caption: "hidden" },
        { path: "C:\\pics\\cat.jpg" },
        { path: "/data/media/ada/sent/clip.mp4", embed: "![[clip.mp4]]", caption: "a clip" },
        { path: "/plain/dog.png", name: "dog" },
        { path: "/", data: "root" },
      ]),
      message("m_2", [picture("lamp-data"), picture("live-data")]),
    ];
    const stream = { ...liveTurn("s", "r_1", null), blocks: [picture("streaming")] };
    const saved = { ...liveTurn("old", "r_0", null), final: true, msgId: "m_2", blocks: [picture("saved-stream")] };
    const unsaved = { ...liveTurn("late", "r_2", null), final: true, msgId: "m_9", blocks: [picture("unsaved-stream")] };
    const live = [{ path: "/data/media/ada/sent/abc.png", data: "stored" }, { path: "/tmp/live.png", data: "live-data" }, { path: "/tmp/", caption: null }];
    const gallery = conversationImages(messages, [stream, saved, unsaved], live);
    expect(gallery.map((item) => [item.id, item.caption, item.data, item.full ?? null, item.video ?? false])).toEqual([
      ["message:m_1:image:0", "lamp.png", "lamp-data", "/api/pictures/abc.png", false],
      ["message:m_1:image:2", "cat.jpg", undefined, null, false],
      ["message:m_1:image:3", "a clip", undefined, "/api/pictures/clip.mp4", true],
      ["message:m_1:image:4", "dog", undefined, null, false],
      ["message:m_1:image:5", "Attached image", "root", null, false],
      ["message:m_1:block:0", "Inline image", "inline-a", null, false],
      ["message:m_1:block:2:0", "Inline image", "nested", null, false],
      ["stream:s:0", "Inline image", "streaming", null, false],
      ["stream:late:0", "Inline image", "unsaved-stream", null, false],
      ["live:/tmp/live.png", "live.png", "live-data", null, false],
      ["live:/tmp/", "Live image", undefined, null, false],
    ]);
    expect(gallery.some((item) => item.data === "saved-stream"), "a finished stream already saved shows as its message").toBe(false);
    expect(gallery.find((item) => item.id === "message:m_1:block:0")?.mime).toBe("image/png");
  });

  test("a block of a kind it does not know is an error, not a silent gap", () => {
    expect(() => conversationImages([message("m_1", [{ type: "document" } as unknown as ContentBlock])], [], [])).toThrow("Unsupported image block");
  });
});

describe("matching live pictures to the messages that saved them", () => {
  test("a picture stored with its message is gone from the live list, and a manual or untagged one stays as it is", () => {
    const stored = message("m_1", [result("t_1", [picture("pixels")])], [{ path: "/a.png" }]);
    expect(reconcileImages([{ path: "/a.png" }, { path: "/b.png", manual: true, toolId: "t_1" }, { path: "/c.png" }], [stored], [])).toEqual([
      { path: "/b.png", manual: true, toolId: "t_1" },
      { path: "/c.png" },
    ]);
  });

  test("a tool's picture is claimed by the new message holding its result, matched by its preview when it has one", () => {
    const image: LiveImage = { path: "/shot.png", toolId: "t_1", previewData: "pixels" };
    const owning = message("m_2", [{ type: "tool_use", id: "t_1", name: "screenshot", input: {} }, result("t_1", [picture("pixels")])]);
    expect(reconcileImages([image], [owning], [])).toEqual([{ ...image, messageId: "m_2" }]);
    const otherPixels = message("m_2", [result("t_1", [picture("different")])]);
    expect(reconcileImages([image], [otherPixels], []), "a result with other pixels is not its result").toEqual([image]);
    const anyPixels = { path: "/shot.png", toolId: "t_1" };
    expect(reconcileImages([anyPixels], [otherPixels], [])).toEqual([{ ...anyPixels, messageId: "m_2" }]);
    expect(reconcileImages([{ ...image, previewData: null }], [otherPixels], [])).toEqual([{ ...image, previewData: null, messageId: "m_2" }]);
    const failed = message("m_2", [result("t_1", "it broke", true)]);
    expect(reconcileImages([image], [failed], []), "a failed call owns its picture").toEqual([{ ...image, messageId: "m_2" }]);
    expect(reconcileImages([image], [message("m_2", [result("t_1", "text only")])], [])).toEqual([image]);
    const nested = message("m_3", [result("t_outer", [result("t_1", [picture("pixels")])])]);
    expect(reconcileImages([image], [nested], [])).toEqual([{ ...image, messageId: "m_3" }]);
    expect(reconcileImages([image], [owning], [owning]), "a message that already held it does not claim it again").toEqual([image]);
    expect(reconcileImages([image], [owning], [message("m_2", [])]), "a message that only now holds it does").toEqual([{ ...image, messageId: "m_2" }]);
    expect(reconcileImages([image], [owning], [message("m_7", [result("t_1", [picture("pixels")])])]), "another message holding it before does not count").toEqual([{ ...image, messageId: "m_2" }]);
    expect(reconcileImages([image], [message("m_4", [{ type: "text", text: "no results" }])], [])).toEqual([image]);
  });

  test("a claimed picture follows its message, and moves to the message that replaced it", () => {
    const image: LiveImage = { path: "/shot.png", toolId: "t_1", previewData: "pixels", messageId: "m_2" };
    const block = result("t_1", [picture("pixels")]);
    expect(reconcileImages([image], [message("m_2", [block])], [])).toEqual([image]);
    const old = message("m_2", [block]);
    const replaced = message("m_5", [block]);
    expect(reconcileImages([image], [replaced], [old])).toEqual([{ ...image, messageId: "m_5" }]);
    expect(reconcileImages([image], [replaced, message("m_2", [])], [old]), "its message is still there, without it").toEqual([]);
    expect(reconcileImages([image], [message("m_5", [result("t_1", [picture("other")])])], [old]), "the replacement holds something else").toEqual([]);
    expect(reconcileImages([image], [replaced], [old, replaced]), "only a message new since then can be the replacement").toEqual([]);
    expect(reconcileImages([image], [replaced], []), "with no earlier message to compare, it is gone").toEqual([]);
    expect(reconcileImages([image], [replaced], [message("m_2", [])]), "the earlier message never held it").toEqual([]);
  });
});
