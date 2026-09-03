import { describe, expect, test } from "bun:test";

import { admitClientMessage } from "../src/swp/admission.ts";
import { WireReader } from "../src/swp/framing.ts";

const HELLO = {
  type: "hello",
  client_type: "cli",
  client_name: "shore-cli",
  capabilities: ["streaming"],
  character: "ada",
  thread: "eval",
  token: "t",
};

async function throughFraming(raw: unknown): Promise<Record<string, unknown>> {
  const line = new TextEncoder().encode(`${JSON.stringify(raw)}\n`);
  const source = (async function* () {
    yield line;
  })();
  const decoded = await new WireReader(source).readMessage();
  return decoded as unknown as Record<string, unknown>;
}

describe("a hello asking for a thread", () => {
  test("survives the framing decoder", async () => {
    const framed = await throughFraming(HELLO);
    expect(framed["thread"]).toBe("eval");
    expect(framed["character"]).toBe("ada");
  });

  test("survives admission", () => {
    const admitted = admitClientMessage(HELLO) as unknown as Record<string, unknown>;
    expect(admitted["thread"]).toBe("eval");
  });

  test("survives both decoders in the order the daemon runs them", async () => {
    const framed = await throughFraming(HELLO);
    const admitted = admitClientMessage(framed) as unknown as Record<string, unknown>;
    expect(admitted["thread"]).toBe("eval");
  });

  test("a hello with no thread carries no thread key, rather than a null one", async () => {
    const { thread: _dropped, ...withoutThread } = HELLO;
    const framed = await throughFraming(withoutThread);
    const admitted = admitClientMessage(framed) as unknown as Record<string, unknown>;

    expect("thread" in framed).toBe(false);
    expect("thread" in admitted).toBe(false);
  });

  test("a non-string thread is refused by both decoders", async () => {
    const bad = { ...HELLO, thread: 42 };
    expect(throughFraming(bad)).rejects.toThrow(/thread/);
    expect(() => admitClientMessage(bad)).toThrow(/thread/);
  });

  test("a null thread reads as absent, the way an older client sends it", async () => {
    const framed = await throughFraming({ ...HELLO, thread: null });
    expect("thread" in framed).toBe(false);
  });
});
