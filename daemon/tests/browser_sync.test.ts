import { describe, expect, test } from "bun:test";
import capture from "./browser_captures/sync_sequences.json" with { type: "json" };
import { SyncState } from "../src/browser/sync.ts";
import { parseServerFrame } from "../src/browser/wire.ts";
import { recordedValue, recording } from "./support/rerecord.ts";

const CAPTURE = "tests/browser_captures/sync_sequences.json";

describe("shared Rust and browser synchronization sequences", () => {
  for (const [index, sequence] of capture.sequences.entries()) test(sequence.name, () => {
    const sync = new SyncState(sequence.initial.revision, sequence.initial.character, sequence.initial.thread);
    for (const [step, recorded] of sequence.steps.entries()) {
      const frame = parseServerFrame(JSON.stringify(recorded.event));
      if (frame.kind === "invalid") throw new Error(`${sequence.name} step ${String(step)}: ${frame.reason}`);
      const decision = frame.kind === "future" ? "deliver" : sync.observe(frame.message);
      const observed = { event: recorded.event, decision, latest_revision: sync.latestRevision, character: sync.snapshot.character, thread: sync.snapshot.thread };
      recordedValue(CAPTURE, ["sequences", index, "steps", step], observed);
      if (!recording) expect<unknown>(recorded, `${sequence.name} step ${String(step)}`).toEqual(observed);
    }
  });
});
