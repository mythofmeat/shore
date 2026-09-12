import { describe, expect, test } from "bun:test";
import sequences from "../../fixtures/protocol/sync.json" with { type: "json" };
import { SyncState } from "../src/browser/sync.ts";
import { parseServerFrame } from "../src/browser/wire.ts";

describe("shared Rust and browser synchronization sequences", () => {
  for (const sequence of sequences) test(sequence.name, () => {
    const sync = new SyncState(sequence.initial.revision, sequence.initial.character, sequence.initial.thread);
    for (const [index, step] of sequence.steps.entries()) {
      const frame = parseServerFrame(JSON.stringify(step.event));
      if (frame.kind === "invalid") throw new Error(`${sequence.name} step ${String(index)}: ${frame.reason}`);
      const decision = frame.kind === "future" ? "deliver" : sync.observe(frame.message);
      expect<string>(decision).toBe(step.decision);
      expect(sync.latestRevision).toBe(step.latest_revision);
      expect(sync.snapshot.character).toBe(step.character);
      expect(sync.snapshot.thread).toBe(step.thread);
    }
  });
});
