import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decodeEvent,
  encodeEvent,
  HEARTBEAT_LOG_CAPACITY,
  HeartbeatLog,
  type HeartbeatEvent,
  type HeartbeatEventKind,
} from "../src/autonomy/heartbeat_log.ts";

interface Fixture {
  capacity: number;
  display_names: string[];
  lines: string[];
}

const fixture = (await Bun.file(
  new URL("./autonomy_captures/heartbeat_log.json", import.meta.url),
).json()) as Fixture;

function stamp(i: number): string {
  return `2026-04-30T00:00:${String(i % 60).padStart(2, "0")}+00:00`;
}

async function inTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "shore-hblog-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the wire format", () => {
  test("the capacity matches", () => {
    expect(HEARTBEAT_LOG_CAPACITY).toBe(fixture.capacity);
  });

  test("every kind of entry round-trips byte for byte", () => {
    expect(fixture.lines.length).toBe(fixture.display_names.length);
    expect(fixture.lines.length).toBeGreaterThan(9);

    for (const [i, line] of fixture.lines.entries()) {
      const decoded = decodeEvent(line);
      expect(decoded, `line ${i} must parse: ${line}`).toBeDefined();
      expect(decoded?.kind, `line ${i} kind`).toBe(fixture.display_names[i] as HeartbeatEventKind);
      expect(encodeEvent(decoded as HeartbeatEvent), `line ${i} re-encodes`).toBe(line);
    }
  });

  test("a kind this side does not know is dropped, not guessed at", () => {
    const line = JSON.stringify({
      timestamp: stamp(0),
      kind: "invented_later",
      detail: "x",
    });
    expect(decodeEvent(line)).toBeUndefined();
  });

  test("malformed lines are dropped rather than thrown on", () => {
    expect(decodeEvent("not json")).toBeUndefined();
    expect(decodeEvent("null")).toBeUndefined();
    expect(decodeEvent("[]")).toBeUndefined();
    expect(decodeEvent(JSON.stringify({ kind: "wake", detail: "x" })), "no timestamp").toBeUndefined();
    expect(decodeEvent(JSON.stringify({ timestamp: stamp(0), kind: "wake" })), "no detail")
      .toBeUndefined();
  });

  test("a whole file replays into the same lines", () => {
    const log = new HeartbeatLog();
    for (const line of fixture.lines) {
      const event = decodeEvent(line);
      expect(event).toBeDefined();
      if (event !== undefined) log.push(event.kind, event.detail, event.timestamp);
    }
    expect(log.encode()).toBe(fixture.lines.map((l) => `${l}\n`).join(""));
  });
});

describe("the ring", () => {
  test("pushing past capacity drops the oldest", () => {
    const log = new HeartbeatLog();
    for (let i = 0; i < HEARTBEAT_LOG_CAPACITY + 5; i += 1) {
      log.push("tick_fired", `e${i}`, stamp(i));
    }

    const events = log.recent(Number.MAX_SAFE_INTEGER);
    expect(events.length).toBe(HEARTBEAT_LOG_CAPACITY);
    expect(events[0]?.detail, "the first five are gone").toBe("e5");
    expect(events[HEARTBEAT_LOG_CAPACITY - 1]?.detail).toBe(`e${HEARTBEAT_LOG_CAPACITY + 4}`);
  });

  test("recent takes the newest and still reads oldest first", () => {
    const log = new HeartbeatLog();
    for (let i = 0; i < 10; i += 1) log.push("tick_fired", `e${i}`, stamp(i));

    const lastThree = log.recent(3);
    expect(lastThree.map((e) => e.detail)).toEqual(["e7", "e8", "e9"]);
    expect(log.recent(100).length, "a limit past the end is not an error").toBe(10);
  });
});

describe("persistence", () => {
  test("push marks dirty but does not touch disk", async () => {
    await inTempDir(async (dir) => {
      const path = join(dir, "heartbeat.jsonl");
      const log = new HeartbeatLog(path);
      log.push("tick_fired", "test", stamp(0));

      expect(log.isDirty).toBe(true);
      expect(await Bun.file(path).exists()).toBe(false);
    });
  });

  test("flush writes JSONL and clears dirty", async () => {
    await inTempDir(async (dir) => {
      const path = join(dir, "heartbeat.jsonl");
      const log = new HeartbeatLog(path);
      log.push("tick_fired", "first", stamp(0));
      log.push("message_sent", "second", stamp(1));
      await log.flushIfDirty();

      expect(log.isDirty).toBe(false);
      const lines = (await Bun.file(path).text()).trimEnd().split("\n");
      expect(lines.length).toBe(2);
      expect(lines[0]).toContain("tick_fired");
      expect(lines[1]).toContain("message_sent");
    });
  });

  test("flush is a no-op when nothing changed", async () => {
    await inTempDir(async (dir) => {
      const path = join(dir, "heartbeat.jsonl");
      await new HeartbeatLog(path).flushIfDirty();
      expect(await Bun.file(path).exists()).toBe(false);
    });
  });

  test("an in-memory log clears its dirty bit without a file", async () => {
    const log = new HeartbeatLog();
    log.push("wake", "hello", stamp(0));
    expect(log.isDirty).toBe(true);
    await log.flushIfDirty();
    expect(log.isDirty).toBe(false);
  });

  test("a failed flush leaves the log dirty so the next one retries", async () => {
    await inTempDir(async (dir) => {
      const blocker = join(dir, "blocker");
      await Bun.write(blocker, "not a directory");

      const log = new HeartbeatLog(join(blocker, "heartbeat.jsonl"));
      log.push("wake", "kept", stamp(0));
      await log.flushIfDirty();

      expect(log.isDirty, "the events must survive to be retried").toBe(true);
      expect(log.recent(10).length).toBe(1);
    });
  });

  test("load round-trips, and comes back clean", async () => {
    await inTempDir(async (dir) => {
      const path = join(dir, "heartbeat.jsonl");
      const written = new HeartbeatLog(path);
      written.push("tick_fired", "a", stamp(0));
      written.push("message_skipped", "b", stamp(1));
      await written.flushIfDirty();

      const loaded = await HeartbeatLog.load(path);
      expect(loaded.isDirty, "it already matches disk").toBe(false);
      expect(loaded.recent(10).map((e) => e.detail)).toEqual(["a", "b"]);
    });
  });

  test("load skips malformed lines", async () => {
    await inTempDir(async (dir) => {
      const path = join(dir, "heartbeat.jsonl");
      const good = fixture.lines[0] ?? "";
      await Bun.write(path, `${good}\nnot json\n\n${good}\n`);

      const loaded = await HeartbeatLog.load(path);
      expect(loaded.recent(10).length).toBe(2);
    });
  });

  test("load caps at capacity", async () => {
    await inTempDir(async (dir) => {
      const path = join(dir, "heartbeat.jsonl");
      const line = fixture.lines[0] ?? "";
      await Bun.write(path, Array.from({ length: HEARTBEAT_LOG_CAPACITY + 50 }, () => line).join("\n"));

      const loaded = await HeartbeatLog.load(path);
      expect(loaded.recent(Number.MAX_SAFE_INTEGER).length).toBe(HEARTBEAT_LOG_CAPACITY);
    });
  });

  test("a missing file loads as an empty log, not an error", async () => {
    await inTempDir(async (dir) => {
      const log = await HeartbeatLog.load(join(dir, "nothing-here.jsonl"));
      expect(log.recent(10)).toEqual([]);
      expect(log.isDirty).toBe(false);
    });
  });

  test("flush truncates when the ring is smaller than the file", async () => {
    await inTempDir(async (dir) => {
      const path = join(dir, "heartbeat.jsonl");
      const first = new HeartbeatLog(path);
      for (let i = 0; i < 5; i += 1) first.push("tick_fired", `e${i}`, stamp(i));
      await first.flushIfDirty();
      expect((await Bun.file(path).text()).trimEnd().split("\n").length).toBe(5);

      const second = new HeartbeatLog(path);
      second.push("wake", "fresh", stamp(9));
      await second.flushIfDirty();

      const lines = (await Bun.file(path).text()).trimEnd().split("\n");
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("wake");
    });
  });
});
