import { expect, test } from "bun:test";

import { CallStore, ZERO_USAGE } from "../src/call_store.ts";
import { transcript } from "../src/commands/call_log.ts";

function stored(rounds: number): CallStore {
  const store = CallStore.openInMemory();
  for (let iteration = 0; iteration < rounds; iteration += 1) {
    store.recordTranscript({ ts: new Date(Date.UTC(2026, 10, 17, 12, iteration)), source: "wake", character: "ada", call_type: "wake_tool_loop", iteration, usage: ZERO_USAGE, entry_json: "{}" });
  }
  store.recordTranscript({ ts: new Date(Date.UTC(2026, 10, 17, 13)), source: "wake", character: "bo", call_type: "wake", iteration: 0, usage: ZERO_USAGE, entry_json: "{}" });
  return store;
}

test("with call logging off the wake transcript says so and lists nothing", () => {
  expect(transcript({ characterName: "ada", callStore: undefined }, {})).toEqual({ enabled: false, source: "wake", entries: [] });
});

test("the wake transcript lists the character's newest twenty rounds oldest first, or as many as asked for", () => {
  const callStore = stored(25);
  const listed = transcript({ characterName: "ada", callStore }, {});
  expect([listed.enabled, listed.source, listed.character]).toEqual([true, "wake", "ada"]);
  expect(listed.entries.map((row) => row.iteration)).toEqual(Array.from({ length: 20 }, (_unused, n) => n + 5));
  expect(transcript({ characterName: "ada", callStore }, { source: "wake", count: 3 }).entries.map((row) => row.iteration)).toEqual([22, 23, 24]);
});
