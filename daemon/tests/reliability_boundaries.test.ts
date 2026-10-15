import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { testTmp } from "./support/tmp.ts";
import { writeState, readState } from "../src/storage/store.ts";
import { loadConfig } from "../src/config/loader.ts";
import { setTestEnv, restoreTestEnv } from "./support/env.ts";
import { reliabilityGeneration } from "./support/reliability_generation.ts";
import { eventMatchesSession } from "../src/swp/routing.ts";

test("a restored legacy file cannot overwrite authoritative database state", async () => {
  const root = await mkdtemp(testTmp("legacy-conflict-"));
  await mkdir(join(root, "ada"));
  writeState(root, "ada/state", "new DB content", "ada");
  await writeFile(join(root, "ada/state"), "old restored file");
  expect(readState(root, "ada/state")).toBe("new DB content");
  expect(readState(root, "ada/state")).toBe("new DB content");
});

test("invalid config reload does not adopt candidate environment values", async () => {
  const root = await mkdtemp(testTmp("dotenv-invalid-"));
  const path = join(root, "config.toml");
  setTestEnv("SHORE_RELIABILITY_ENV", "running");
  try {
    await writeFile(join(root, ".env"), "SHORE_RELIABILITY_ENV=candidate\n");
    await writeFile(path, "[invalid");
    expect(() => loadConfig(path)).toThrow();
    expect(process.env["SHORE_RELIABILITY_ENV"]).toBe("running");
  } finally { restoreTestEnv(); }
});

test("new messages from a side thread cannot enter the main thread's event stream", async () => {
  const h = await reliabilityGeneration({
    generate: async () => { throw new Error("stream only"); },
    async *stream() {
      yield { type: "done", content: "reply", finish_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        timing: { total_ms: 1, time_to_first_token_ms: 1 },
      };
    },
  }, "side");
  await h.run();
  const events = h.frames.filter((frame) => frame.type === "new_message");
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) {
    expect(eventMatchesSession(event, "ada", true, false, "main")).toBe(false);
    expect(eventMatchesSession(event, "ada", true, false, "side")).toBe(true);
  }
});
