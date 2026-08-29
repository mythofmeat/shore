import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import type { Message } from "../src/engine/types.ts";
import { Mem0IngestService } from "../src/memory/mem0_ingest_service.ts";
import { testTmp } from "./support/tmp.ts";

function message(role: "user" | "assistant", id: string, text: string, timestamp: string): Message {
  return {
    msg_id: id,
    role,
    content: text,
    images: [],
    content_blocks: [{ type: "text", text }],
    alternatives: [],
    timestamp,
  };
}

const MORNING = [
  message("user", "m1", "morning", "2026-01-01T10:00:00Z"),
  message("assistant", "m2", "morning to you", "2026-01-01T10:00:01Z"),
  message("user", "m3", "i bought a keychron", "2026-01-01T10:00:02Z"),
];

const EVENING = [
  message("user", "m4", "the switches are browns", "2026-01-02T20:00:00Z"),
  message("assistant", "m5", "tactile, good pick", "2026-01-02T20:00:01Z"),
];

interface Archived {
  messages: Message[];
  excluded?: boolean;
}

interface World {
  dir: string;
  dbPath: string;
}

async function world(segments: Archived[], active: Message[] = []): Promise<World> {
  const root = await mkdtemp(testTmp("shore-mem0-"));
  const dir = join(root, "ada");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "active.jsonl"),
    active.map((m) => JSON.stringify(m)).join("\n") + (active.length === 0 ? "" : "\n"),
  );

  const dbPath = join(root, HISTORY_DB_FILE);
  const store = HistoryStore.open(dbPath);
  segments.forEach((segment, idx) => {
    store.putSegment(
      "ada",
      idx,
      {
        file: HISTORY_DB_FILE,
        message_count: segment.messages.length,
        compacted_at: "2026-01-03T00:00:00Z",
        ...(segment.excluded === true ? { excluded: true } : {}),
      },
      segment.messages,
    );
  });
  store.close();
  return { dir, dbPath };
}

function recorder() {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    registry: {
      call: async (tool: string, args: unknown) => {
        calls.push({ tool, args: args as Record<string, unknown> });
        return "{}";
      },
    },
    sent: (at: number) =>
      (calls[at]?.args["messages"] as { role: string; content: string }[] | undefined) ?? [],
  };
}

function service(
  place: World,
  registry: { call: (tool: string, args: unknown) => Promise<unknown> } | undefined,
  options: { now?: () => number; idleDelayMs?: number; batchSize?: number; pollPauseMs?: number } = {},
): Mem0IngestService {
  const made = new Mem0IngestService({
    ...(registry === undefined ? {} : { mcpRegistry: registry }),
    now: options.now ?? (() => 1_000_000),
    idleDelayMs: options.idleDelayMs ?? 0,
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    pollPauseMs: options.pollPauseMs ?? 0,
  });
  made.register({
    character: "ada",
    characterDataDir: place.dir,
    historyDbPath: place.dbPath,
    server: "mem0",
  });
  return made;
}

describe("mem0 ingest service", () => {
  test("waits for the conversation to go idle", async () => {
    const place = await world([{ messages: MORNING }]);
    const { calls, registry } = recorder();
    let clock = 1_000;
    const made = service(place, registry, { now: () => clock, idleDelayMs: 30_000 });

    await made.runOnce();
    expect(calls).toHaveLength(0);

    clock += 30_000;
    await made.runOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tool).toBe("mcp__mem0__add");
    expect(calls[0]?.args["character"]).toBe("ada");
  });

  test("yields while a turn is in flight", async () => {
    const place = await world([{ messages: MORNING }]);
    const { calls, registry } = recorder();
    const made = service(place, registry);

    const endForeground = made.beginForeground();
    await made.runOnce();
    expect(calls).toHaveLength(0);

    endForeground();
    await made.runOnce();
    expect(calls).toHaveLength(1);
  });

  test("ingests the archive and never the live conversation", async () => {
    const place = await world([{ messages: MORNING }], [
      message("user", "live1", "still talking about this", "2026-01-04T09:00:00Z"),
      message("assistant", "live2", "and still replying", "2026-01-04T09:00:01Z"),
    ]);
    const { registry, sent } = recorder();
    const made = service(place, registry);

    await made.runOnce();
    const text = sent(0).map((m) => m.content).join(" ");
    expect(text).toContain("i bought a keychron");
    expect(text).not.toContain("still talking about this");
  });

  test("never ingests an excluded segment", async () => {
    const place = await world([
      { messages: MORNING, excluded: true },
      { messages: EVENING },
    ]);
    const { calls, registry, sent } = recorder();
    const made = service(place, registry);

    await made.runOnce();
    expect(calls).toHaveLength(1);
    const text = sent(0).map((m) => m.content).join(" ");
    expect(text).toContain("the switches are browns");
    expect(text).not.toContain("i bought a keychron");

    await made.runOnce();
    expect(calls).toHaveLength(1);
  });

  test("stamps the segment it came from", async () => {
    const place = await world([{ messages: MORNING }, { messages: EVENING }]);
    const { calls, registry } = recorder();
    const made = service(place, registry);

    await made.runOnce();
    await made.runOnce();
    expect(calls[0]?.args["metadata"]).toEqual({ ts: "2026-01-01T10:00:00Z", segment: 0 });
    expect(calls[1]?.args["metadata"]).toEqual({ ts: "2026-01-02T20:00:00Z", segment: 1 });
  });

  test("keeps a batch inside one segment", async () => {
    const place = await world([{ messages: MORNING }, { messages: EVENING }]);
    const { calls, registry, sent } = recorder();
    const made = service(place, registry, { batchSize: 8 });

    await made.runOnce();
    expect(sent(0)).toHaveLength(3);
    await made.runOnce();
    expect(sent(1)).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });

  test("advances a cursor on disk and does not resend", async () => {
    const place = await world([{ messages: MORNING }]);
    const { calls, registry } = recorder();
    const made = service(place, registry);

    await made.runOnce();
    expect(JSON.parse(await readFile(join(place.dir, "mem0_cursor.json"), "utf8"))).toEqual({
      segment: 0,
      ordinal: 2,
    });

    await made.runOnce();
    expect(calls).toHaveLength(1);
    expect(made.progress("ada")?.pending).toBe(false);
  });

  test("a restarted service picks up where the cursor left off", async () => {
    const place = await world([{ messages: MORNING }]);
    await writeFile(
      join(place.dir, "mem0_cursor.json"),
      JSON.stringify({ segment: 0, ordinal: 1 }),
    );
    const { registry, sent } = recorder();
    const made = service(place, registry);

    await made.runOnce();
    expect(sent(0)).toHaveLength(1);
    expect(sent(0)[0]?.content).toContain("i bought a keychron");
  });

  test("sends at most one batch per tick", async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      message(
        "user",
        `m${String(i)}`,
        `line ${String(i)}`,
        `2026-01-01T10:00:${String(i).padStart(2, "0")}Z`,
      ),
    );
    const place = await world([{ messages: many }]);
    const { calls, registry, sent } = recorder();
    const made = service(place, registry, { batchSize: 8 });

    await made.runOnce();
    expect(sent(0)).toHaveLength(8);
    await made.runOnce();
    expect(calls).toHaveLength(2);
  });

  test("backs off between polls once the archive is drained", async () => {
    const place = await world([{ messages: MORNING }]);
    const { calls, registry } = recorder();
    let clock = 1_000_000;
    const made = new Mem0IngestService({
      mcpRegistry: registry,
      now: () => clock,
      idleDelayMs: 0,
      pollPauseMs: 1_000,
      maxPollPauseMs: 4_000,
    });
    made.register({
      character: "ada",
      characterDataDir: place.dir,
      historyDbPath: place.dbPath,
      server: "mem0",
    });

    await made.runOnce();
    expect(calls).toHaveLength(1);

    clock += 1_000;
    await made.runOnce();
    expect(made.progress("ada")?.nextPollAt).toBe(clock + 2_000);

    clock += 1_000;
    await made.runOnce();
    expect(calls).toHaveLength(1);

    made.noteMutation("ada");
    expect(made.progress("ada")?.nextPollAt).toBe(0);
  });

  test("backs off after a failure and keeps the work pending", async () => {
    const place = await world([{ messages: MORNING }]);
    let clock = 1_000_000;
    let attempts = 0;
    const made = service(
      place,
      {
        call: async () => {
          attempts += 1;
          throw new Error("MCP server 'mem0' is unavailable");
        },
      },
      { now: () => clock },
    );

    await made.runOnce();
    expect(attempts).toBe(1);
    expect(made.progress("ada")).toMatchObject({
      failures: 1,
      pending: true,
      lastError: "MCP server 'mem0' is unavailable",
    });

    await made.runOnce();
    expect(attempts).toBe(1);

    clock += 60_000;
    await made.runOnce();
    expect(attempts).toBe(2);
  });

  test("stays inert until a registry is attached", async () => {
    const place = await world([{ messages: MORNING }]);
    const made = service(place, undefined);

    await made.runOnce();
    expect(made.progress("ada")?.cursor).toBeUndefined();

    const { calls, registry } = recorder();
    made.attachRegistry(registry);
    await made.runOnce();
    expect(calls).toHaveLength(1);
  });

  test("ingests nothing when the archive is empty", async () => {
    const place = await world([]);
    const { calls, registry } = recorder();
    const made = service(place, registry);

    await made.runOnce();
    expect(calls).toHaveLength(0);
    expect(made.progress("ada")?.cursor).toBeUndefined();
  });
});
