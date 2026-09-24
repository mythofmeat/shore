import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { admitClientMessage } from "../src/swp/admission.ts";
import { WireReader } from "../src/swp/framing.ts";
import { recordedValue } from "./support/rerecord.ts";
import {
  CLIENT_FIXTURES,
  MESSAGE_OBJECT_FIXTURE,
  SERVER_FIXTURES,
  STREAM_METADATA_FIXTURE,
  WIRE_FIXTURES_CAPTURE,
} from "./support/wire_fixtures.ts";

const shared = {
  server: SERVER_FIXTURES,
  client: CLIENT_FIXTURES,
  message_object: MESSAGE_OBJECT_FIXTURE,
  stream_metadata: STREAM_METADATA_FIXTURE,
};

async function throughTheWire(message: unknown): Promise<unknown> {
  async function* line(): AsyncIterable<Uint8Array> {
    yield new TextEncoder().encode(`${JSON.stringify(message)}\n`);
  }
  return admitClientMessage(await new WireReader(line()).readMessage());
}

const recorded = JSON.parse(
  readFileSync(join(import.meta.dir, "..", WIRE_FIXTURES_CAPTURE), "utf8"),
) as unknown;

describe("the wire fixtures the Rust client is tested against", () => {
  test("are the daemon's own typed messages, recorded for the client", () => {
    for (const [section, value] of Object.entries(shared)) recordedValue(WIRE_FIXTURES_CAPTURE, [section], value);
    expect(recorded).toEqual(JSON.parse(JSON.stringify(shared)) as unknown);
  });

  for (const [name, message] of Object.entries(CLIENT_FIXTURES)) {
    test(`the daemon reads and admits the client's ${name}`, async () => {
      expect(await throughTheWire(message)).toMatchObject({ type: message.type });
    });
  }
});
