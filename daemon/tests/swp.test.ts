import { describe, expect, test } from "bun:test";

import type { ClientMessage } from "../src/protocol/ClientMessage";
import { WireError, WireReader } from "../src/swp/framing";

type Read = { ok: ClientMessage } | { eof: true } | { err: string };

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  if (bytes.length > 0) yield bytes;
}

async function* byteAtATime(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  for (const b of bytes) yield new Uint8Array([b]);
}

async function readAll(source: AsyncIterable<Uint8Array>, maxMessageSize?: number): Promise<Read[]> {
  const reader = new WireReader(source, maxMessageSize);
  const out: Read[] = [];
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

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const CANCEL = '{"type":"cancel"}';

const CASES: { name: string; input: Uint8Array; reads: ("cancel" | "eof" | "err")[] }[] = [
  { name: "one frame", input: bytes(`${CANCEL}\n`), reads: ["cancel", "eof"] },
  { name: "two frames in one buffer", input: bytes(`${CANCEL}\n${CANCEL}\n`), reads: ["cancel", "cancel", "eof"] },
  { name: "clean eof, nothing buffered", input: bytes(""), reads: ["eof"] },
  { name: "an unterminated final frame is still parsed", input: bytes(CANCEL), reads: ["cancel", "eof"] },
  { name: "a crlf terminator", input: bytes(`${CANCEL}\r\n`), reads: ["cancel", "eof"] },
  { name: "surrounding spaces are trimmed", input: bytes(`   ${CANCEL}   \n`), reads: ["cancel", "eof"] },
  { name: "a bare newline is an error", input: bytes("\n"), reads: ["err"] },
  { name: "invalid utf-8 is an error", input: Uint8Array.from([0xff, 0xfe, 0x0a]), reads: ["err"] },
  { name: "json that is not a client message is an error", input: bytes('{"type":"nope"}\n'), reads: ["err"] },
  { name: "unknown fields are ignored", input: bytes('{"type":"cancel","extra":1}\n'), reads: ["cancel", "eof"] },
];

describe("framing", () => {
  for (const c of CASES) {
    test(c.name, async () => {
      const reads = await readAll(once(c.input));
      expect(reads.map((r) => ("ok" in r ? r.ok.type : "eof" in r ? "eof" : "err"))).toEqual(c.reads);
    });

    test(`${c.name}, one byte per chunk`, async () => {
      expect(await readAll(byteAtATime(c.input))).toEqual(await readAll(once(c.input)));
    });
  }

  test("a message frame keeps its fields and fills its defaults", async () => {
    expect(await readAll(once(bytes('{"type":"message","rid":"r1","text":"hi","stream":true}\n')))).toEqual([
      { ok: { type: "message", rid: "r1", text: "hi", stream: true, images: [], image_data: [] } as ClientMessage },
      { eof: true },
    ]);
  });

  test("a frame over the size limit is refused, terminated or not", async () => {
    const limit = 64;
    const over = "a".repeat(limit);
    expect(await readAll(once(bytes(`${over}\n`)), limit)).toEqual([{ err: "Message exceeds maximum size" }]);
    expect(await readAll(once(bytes(`${over}a`)), limit)).toEqual([{ err: "Message exceeds maximum size" }]);
    const atLimit = await readAll(once(bytes(`${"a".repeat(limit - 1)}\n`)), limit);
    expect(atLimit).toHaveLength(1);
    expect(atLimit[0]).not.toEqual({ err: "Message exceeds maximum size" });
  });
});
