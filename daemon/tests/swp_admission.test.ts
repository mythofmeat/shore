import { describe, expect, test } from "bun:test";

import {
  AdmissionError,
  admitCapabilities,
  admitClientMessage,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_CAPABILITIES,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from "../src/swp/admission.ts";
import { WireError, WireReader } from "../src/swp/framing.ts";

const upload = (filename: string, data: string) => ({ filename, data, mime_type: "image/png" });

const message = <T,>(imageData: T[] = []) => ({
  type: "message" as const,
  text: "hello",
  stream: true,
  images: [],
  image_data: imageData,
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
  });

  test("caps attachment and capability counts", () => {
    expect(() =>
      admitClientMessage(
        message(Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => upload(`${String(i)}.png`, ""))),
      ),
    ).toThrow(/maximum/);
    expect(() =>
      admitCapabilities(Array.from({ length: MAX_CAPABILITIES + 1 }, () => "streaming")),
    ).toThrow(/maximum/);
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
  async function decode(value: unknown) {
    const line = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
    async function* source() {
      yield line;
    }
    return await new WireReader(source()).readMessage();
  }

  for (const [label, value] of [
    ["non-array images", { ...message(), images: "shot.png" }],
    ["non-string image path", { ...message(), images: [42] }],
    ["non-boolean stream flag", { ...message(), stream: "yes" }],
    ["non-object upload", message(["base64"])],
    ["missing upload data", message([{ filename: "shot.png" }])],
    ["non-string MIME type", message([{ filename: "shot.png", data: "AAAA", mime_type: 42 }])],
    ["non-string capability", { type: "hello", client_type: "tui", client_name: "t", capabilities: [42] }],
  ] as const) {
    test(`rejects ${label}`, async () => {
      expect(decode(value)).rejects.toBeInstanceOf(WireError);
    });
  }
});
